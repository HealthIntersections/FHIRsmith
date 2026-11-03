const memoryGuard = require('../../library/memory-guard');

const GB = 1024 * 1024 * 1024;

function fakeRes() {
  const res = { headers: {}, statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (b) => { res.body = b; };
  return res;
}

describe('memory-guard', () => {
  let rssSpy;

  const setRss = (bytes) => {
    rssSpy.mockReturnValue(bytes);
    memoryGuard._state.sampleTime = 0; // drop the cached sample
  };

  beforeEach(() => {
    rssSpy = jest.spyOn(process.memoryUsage, 'rss');
    memoryGuard.configure({ limit: 10 * GB, rejectFraction: 0.8, abortFraction: 0.9 });
  });

  afterEach(() => {
    rssSpy.mockRestore();
    memoryGuard.configure();
  });

  test('defaults: 85% reject, 92% abort, limit falls back to machine RAM', () => {
    memoryGuard.configure();
    const s = memoryGuard._state;
    expect(s.limit).toBeGreaterThan(0);
    expect(s.rejectFraction).toBe(0.85);
    expect(s.abortFraction).toBe(0.92);
  });

  test('invalid fractions are ignored', () => {
    memoryGuard.configure({ limit: 10 * GB, rejectFraction: 5, abortFraction: 'x' });
    expect(memoryGuard._state.rejectFraction).toBe(0.85);
    expect(memoryGuard._state.abortFraction).toBe(0.92);
  });

  test('below the reject threshold: request passes', () => {
    setRss(7 * GB);
    const next = jest.fn();
    memoryGuard.middleware()({ path: '/r4/ValueSet/$expand' }, fakeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('above the reject threshold: 503 with Retry-After and an OperationOutcome', () => {
    setRss(8.5 * GB);
    const next = jest.fn();
    const res = fakeRes();
    memoryGuard.middleware({ retryAfter: 20 })({ path: '/r4/ValueSet/$expand' }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('20');
    const oo = JSON.parse(res.body);
    expect(oo.resourceType).toBe('OperationOutcome');
    expect(oo.issue[0].code).toBe('transient');
  });

  test('exempt paths are never refused', () => {
    setRss(9.5 * GB);
    const next = jest.fn();
    const mw = memoryGuard.middleware({ exempt: ['/dashboard'] });
    mw({ path: '/dashboard' }, fakeRes(), next);
    mw({ path: '/dashboardx' }, fakeRes(), () => { throw new Error('should be refused'); });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('abort threshold is separate from, and above, the reject threshold', () => {
    setRss(8.5 * GB);
    expect(memoryGuard.shouldReject()).toBe(true);
    expect(memoryGuard.overAbortThreshold('test')).toBe(0);
    setRss(9.5 * GB);
    expect(memoryGuard.overAbortThreshold('test')).toBe(9.5 * GB);
  });

  test('a gc function is available even without --expose-gc', () => {
    expect(typeof memoryGuard.getGc()).toBe('function');
  });

  test('while refusing, a forced GC that brings memory down lets the request through', () => {
    setRss(8.5 * GB);
    const gc = memoryGuard.getGc();
    expect(gc).toBeTruthy();
    // first request: over threshold, GC runs at once; pretend it freed enough
    rssSpy.mockImplementation(() => 7 * GB);
    memoryGuard._state.sampleRss = 8.5 * GB;
    memoryGuard._state.sampleTime = Date.now(); // the cached sample says "over"
    const next = jest.fn();
    memoryGuard.middleware({ gcInterval: 1000, heapUsed: () => 2 * GB })({ path: '/r4/x' }, fakeRes(), next);
    expect(next).toHaveBeenCalled();
  });

  test('no forced GC when the JS heap is smaller than the amount over the threshold', () => {
    // 8.5 GB of RSS against an 8 GB threshold, but only 0.2 GB of it is JS heap: collecting
    // can't get under the threshold, so don't stop the process to try
    const log = { info: jest.fn(), warn: jest.fn() };
    setRss(8.5 * GB);
    const res = fakeRes();
    memoryGuard.middleware({ log, gcInterval: 1000, heapUsed: () => 0.2 * GB })({ path: '/r4/x' }, res, () => {});
    expect(res.statusCode).toBe(503);
    expect(log.info.mock.calls.some(c => /no forced GC - the JS heap/.test(c[0]))).toBe(true);
    expect(log.info.mock.calls.some(c => /forced GC while refusing/.test(c[0]))).toBe(false);
  });

  test('a forced GC that leaves memory over the threshold backs off, up to the maximum', () => {
    const log = { info: jest.fn(), warn: jest.fn() };
    let now = 1000000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      setRss(8.5 * GB); // and it stays there: the GCs free nothing
      const mw = memoryGuard.middleware({ log, gcInterval: 1000, gcMaxInterval: 4000, heapUsed: () => 2 * GB });
      const gcs = () => log.info.mock.calls.filter(c => /forced GC while refusing/.test(c[0])).length;
      const at = (t) => { now = 1000000 + t; memoryGuard._state.sampleTime = 0; mw({ path: '/r4/x' }, fakeRes(), () => {}); };
      at(0);      // GC, still over: next in 2s
      expect(gcs()).toBe(1);
      at(1500);   // too soon
      expect(gcs()).toBe(1);
      at(2000);   // GC: next in 4s
      at(5000);   // too soon
      expect(gcs()).toBe(2);
      at(6000);   // GC: next in 4s, the maximum
      at(10000);  // GC
      expect(gcs()).toBe(4);
      // recovering resets the wait: the next spell of refusing starts at gcInterval again
      setRss(7 * GB);
      at(10500);
      setRss(8.5 * GB);
      at(11000);  // 1s after the last GC: allowed again
      expect(gcs()).toBe(5);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('logs when refusing starts and when it stops', () => {
    const log = { info: jest.fn(), warn: jest.fn() };
    const mw = memoryGuard.middleware({ log, gcInterval: 60000 });
    setRss(8.5 * GB);
    mw({ path: '/r4/x' }, fakeRes(), () => {});
    expect(log.warn.mock.calls.some(c => /refusing new requests/.test(c[0]))).toBe(true);
    setRss(7 * GB);
    mw({ path: '/r4/x' }, fakeRes(), () => {});
    expect(log.warn.mock.calls.some(c => /accepting requests again after \d+s \(1 refused\)/.test(c[0]))).toBe(true);
  });
});

// Cluster mode: the limit and the measure are the whole service's (several workers)
describe('memory-guard for a cluster of workers', () => {
  let rssSpy;
  const reports = [];
  const PID = process.pid;

  const setOwn = (bytes) => {
    rssSpy.mockReturnValue(bytes);
    memoryGuard._state.sampleTime = 0;
  };
  // what the primary says every second: each worker's RSS, and their total
  const primarySays = (table) => {
    const total = table.reduce((t, [, r]) => t + r, 0);
    memoryGuard.handleMessage({ fhirsmith: 'memory', total, workers: table });
  };

  beforeEach(() => {
    reports.length = 0;
    rssSpy = jest.spyOn(process.memoryUsage, 'rss');
    // 3 workers, a 10 GB limit for the group: refuse above 8.5, abort above 9.2
    memoryGuard.configure({ limit: 10 * GB, measure: 'processes', group: { size: 3, report: (m) => reports.push(m) } });
  });
  afterEach(() => {
    rssSpy.mockRestore();
    memoryGuard.configure();
  });

  test('reports its RSS to the primary', () => {
    expect(reports[0]).toEqual({ fhirsmith: 'memory-rss', rss: expect.any(Number) });
    expect(memoryGuard.describe()).toMatch(/for the whole service of 3 workers, measured as the sum of the workers' RSS/);
  });

  test('every worker refuses when the group is over, though none is over a third', () => {
    setOwn(2 * GB);
    primarySays([[PID, 2 * GB], [PID + 1, 3.4 * GB], [PID + 2, 3.3 * GB]]); // 8.7 GB
    expect(memoryGuard.shouldReject()).toBe(true);
    primarySays([[PID, 2 * GB], [PID + 1, 3 * GB], [PID + 2, 3 * GB]]);     // 8 GB
    expect(memoryGuard.shouldReject()).toBe(false);
  });

  test('its own part of the total is brought up to date between reports', () => {
    primarySays([[PID, 2 * GB], [PID + 1, 3 * GB], [PID + 2, 3 * GB]]);     // 8 GB as reported
    setOwn(2.6 * GB);                                                         // since then: +0.6
    expect(memoryGuard.shouldReject()).toBe(true);
  });

  test('over the abort threshold, only the largest worker aborts', () => {
    // the group is at 9.5 GB; this worker is 5 GB of it, the largest
    setOwn(5 * GB);
    primarySays([[PID, 5 * GB], [PID + 1, 2.3 * GB], [PID + 2, 2.2 * GB]]);
    expect(memoryGuard.overAbortThreshold('test')).toBe(9.5 * GB);
    // the same group, but this worker is a small one: it carries on
    setOwn(2.2 * GB);
    primarySays([[PID, 2.2 * GB], [PID + 1, 5 * GB], [PID + 2, 2.3 * GB]]);
    expect(memoryGuard.overAbortThreshold('test')).toBe(0);
    // and under the threshold nobody aborts, largest or not
    setOwn(5 * GB);
    primarySays([[PID, 5 * GB], [PID + 1, 2 * GB], [PID + 2, 2 * GB]]);
    expect(memoryGuard.overAbortThreshold('test')).toBe(0);
  });
});

describe('who aborts (abortsHere)', () => {
  const GB2 = GB;
  const at = 9.2 * GB2; // abort threshold of a 10 GB group
  const w = (...pairs) => new Map(pairs);

  test('the largest worker does, the others don\'t', () => {
    const table = w([1, 5 * GB2], [2, 2.3 * GB2], [3, 2.2 * GB2]);
    expect(memoryGuard.abortsHere(5 * GB2, table, 3, at, 1)).toBe(true);
    expect(memoryGuard.abortsHere(2.3 * GB2, table, 3, at, 2)).toBe(false);
    expect(memoryGuard.abortsHere(2.2 * GB2, table, 3, at, 3)).toBe(false);
  });

  test('a worker well over its share aborts even if another is larger', () => {
    // share of the threshold: 9.2 / 3 = 3.07 GB; 1.5 times that: 4.6 GB
    const table = w([1, 4.7 * GB2], [2, 4.8 * GB2], [3, 0.3 * GB2]);
    expect(memoryGuard.abortsHere(4.7 * GB2, table, 3, at, 1)).toBe(true);
    expect(memoryGuard.abortsHere(4.8 * GB2, table, 3, at, 2)).toBe(true);
    expect(memoryGuard.abortsHere(0.3 * GB2, table, 3, at, 3)).toBe(false);
  });

  test('a tie goes to one worker (the lower pid), and a worker the primary has not reported yet counts as alone', () => {
    const table = w([1, 3 * GB2], [2, 3 * GB2]);
    expect(memoryGuard.abortsHere(3 * GB2, table, 3, at, 1)).toBe(true);
    expect(memoryGuard.abortsHere(3 * GB2, table, 3, at, 2)).toBe(false);
    expect(memoryGuard.abortsHere(1 * GB2, new Map(), 3, at, 9)).toBe(true);
  });
});

describe('how the group is measured (resolveLimit)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  let dir;
  let cgroupOptions;
  const write = (rel, content) => {
    const file = path.join(dir, 'sys', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-measure-'));
    cgroupOptions = { procFile: path.join(dir, 'proc'), cgroupRoot: path.join(dir, 'sys') };
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('cgroup v2 with a limit on the service itself: its private memory (anon)', () => {
    fs.writeFileSync(cgroupOptions.procFile, '0::/system.slice/fhirsmith.service\n');
    write('system.slice/fhirsmith.service/memory.max', String(16 * GB));
    write('system.slice/fhirsmith.service/memory.stat', `anon ${3 * GB}\nfile ${9 * GB}\n`);
    const r = memoryGuard.resolveLimit({ cgroupOptions });
    expect(r).toMatchObject({ limit: 16 * GB, measure: 'cgroup' });
    expect(require('../../library/cgroup-memory').readCgroupAnon(r.cgroup)).toBe(3 * GB); // not the page cache
  });

  test('cgroup v1: total_rss of the service\'s memory cgroup', () => {
    fs.writeFileSync(cgroupOptions.procFile, '5:memory:/fhirsmith\n');
    write('memory/fhirsmith/memory.limit_in_bytes', String(8 * GB));
    write('memory/fhirsmith/memory.stat', `cache 100\nrss ${1 * GB}\ntotal_rss ${2 * GB}\n`);
    const r = memoryGuard.resolveLimit({ cgroupOptions });
    expect(r.measure).toBe('cgroup');
    expect(require('../../library/cgroup-memory').readCgroupAnon(r.cgroup)).toBe(2 * GB);
  });

  test('a limit only on an enclosing slice: the cgroup may hold other things, so the processes are added up', () => {
    fs.writeFileSync(cgroupOptions.procFile, '0::/user.slice/session.scope\n');
    write('user.slice/memory.max', String(16 * GB));
    write('user.slice/session.scope/memory.max', 'max');
    write('user.slice/session.scope/memory.stat', `anon ${3 * GB}\n`);
    expect(memoryGuard.resolveLimit({ cgroupOptions })).toMatchObject({ limit: 16 * GB, measure: 'processes' });
  });

  test('no cgroup (macOS, Windows): the processes, against the configured limit or the machine', () => {
    cgroupOptions.procFile = path.join(dir, 'missing');
    expect(memoryGuard.resolveLimit({ cgroupOptions })).toMatchObject({ limit: os.totalmem(), measure: 'processes' });
    expect(memoryGuard.resolveLimit({ cgroupOptions, limit: 4 * GB })).toMatchObject({ limit: 4 * GB, source: 'configured' });
  });

  test('a configured limit wins over the cgroup\'s, and measure can be forced', () => {
    fs.writeFileSync(cgroupOptions.procFile, '0::/svc\n');
    write('svc/memory.max', String(16 * GB));
    write('svc/memory.stat', `anon ${1 * GB}\n`);
    expect(memoryGuard.resolveLimit({ cgroupOptions, limit: 6 * GB })).toMatchObject({ limit: 6 * GB, measure: 'cgroup' });
    expect(memoryGuard.resolveLimit({ cgroupOptions, measure: 'processes' }).measure).toBe('processes');
  });
});
