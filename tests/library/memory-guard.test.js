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

  (process.platform === 'linux' ? test : test.skip)('with mapped files, file-backed pages are not counted', () => {
    const fs = require('fs');
    const realRead = fs.readFileSync;
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) =>
      file === '/proc/self/status' ? `VmRSS:\t1 kB\nRssFile:\t${4 * 1024 * 1024} kB\n` : realRead(file, ...rest));
    try {
      setRss(9 * GB); // 4 GB of it file-backed
      expect(memoryGuard.shouldReject()).toBe(true);
      memoryGuard.measureExcludingFileBacked();
      expect(memoryGuard.shouldReject()).toBe(false);
      expect(memoryGuard.overAbortThreshold('test')).toBe(0);
    } finally {
      memoryGuard._state.excludeFileBacked = false;
      readSpy.mockRestore();
    }
  });

  (process.platform === 'linux' ? test : test.skip)('with mapped files, the in-operation check reads RssFile at most once per window, and RSS every time', () => {
    const fs = require('fs');
    const realRead = fs.readFileSync;
    let reads = 0;
    let rssFileKb = 2 * 1024 * 1024;
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => {
      if (file !== '/proc/self/status') {
        return realRead(file, ...rest);
      }
      reads++;
      return `VmRSS:\t1 kB\nRssFile:\t${rssFileKb} kB\n`;
    });
    let now = 1000000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      memoryGuard.measureExcludingFileBacked();
      setRss(10.5 * GB);
      expect(memoryGuard.overAbortThreshold('test')).toBe(0); // 8.5 GB counts
      expect(reads).toBe(1);
      // many checks inside the window: one read, while a rise in RSS is still seen at once
      for (let i = 0; i < 1000; i++) {
        now += 0.1;
        expect(memoryGuard.overAbortThreshold('test')).toBe(0);
      }
      rssSpy.mockReturnValue(11.5 * GB);
      expect(memoryGuard.overAbortThreshold('test')).toBe(9.5 * GB);
      expect(reads).toBe(1);
      expect(rssSpy.mock.calls.length).toBeGreaterThanOrEqual(1002);
      // once the window has passed, RssFile is read again
      rssFileKb = 3 * 1024 * 1024;
      now += 200;
      expect(memoryGuard.overAbortThreshold('test')).toBe(0); // 8.5 GB counts
      expect(reads).toBe(2);
    } finally {
      nowSpy.mockRestore();
      memoryGuard._state.excludeFileBacked = false;
      readSpy.mockRestore();
    }
  });
});
