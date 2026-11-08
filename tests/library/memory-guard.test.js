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

  test('observes only actual refusals, excluding admitted and exempt requests', () => {
    const onReject = jest.fn();
    const next = jest.fn();
    const mw = memoryGuard.middleware({ onReject, exempt:['/dashboard'], heapUsed:() => 0 });
    setRss(7 * GB);
    mw({ path:'/r4/x' }, fakeRes(), next);
    setRss(8.5 * GB);
    mw({ path:'/dashboard' }, fakeRes(), next);
    const refused = fakeRes();
    mw({ path:'/r4/x' }, refused, next);
    setRss(7 * GB);
    mw({ path:'/r4/x' }, fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(3);
    expect(refused.statusCode).toBe(503);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  test('a broken observer cannot prevent the guard from refusing a request', () => {
    setRss(8.5 * GB);
    const res = fakeRes();
    const mw = memoryGuard.middleware({ heapUsed:() => 0, onReject:() => { throw new Error('metrics failed'); } });
    expect(() => mw({ path:'/r4/x' }, res, () => {})).not.toThrow();
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('30');
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
    const onReject = jest.fn();
    memoryGuard.middleware({ gcInterval: 1000, heapUsed: () => 2 * GB, onReject })({ path: '/r4/x' }, fakeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
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
    expect(log.info.mock.calls.some(c => /forced GC.* while refusing/.test(c[0]))).toBe(false);
  });

  test('a forced GC that leaves memory over the threshold backs off, up to the maximum', () => {
    const log = { info: jest.fn(), warn: jest.fn() };
    let now = 1000000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      setRss(8.5 * GB); // and it stays there: the GCs free nothing
      const mw = memoryGuard.middleware({ log, gcInterval: 1000, gcMaxInterval: 4000, heapUsed: () => 2 * GB });
      const gcs = () => log.info.mock.calls.filter(c => /forced GC.* while refusing/.test(c[0])).length;
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

  test('while refusing, malloc_trim gets back the C allocator\'s free memory, even with too small a JS heap for a GC', () => {
    memoryGuard.configure({ limit: 10 * GB, rejectFraction: 0.8, abortFraction: 0.9, trimAllocator: true });
    // a worker after an aborted batch: 8.5 GB, of which the JS heap is 0.2 GB and most of the
    // rest closed SQLite connections' memory, free in malloc's arenas
    const log = { info: jest.fn(), warn: jest.fn() };
    setRss(8.5 * GB);
    const trim = jest.fn(() => { rssSpy.mockReturnValue(4 * GB); return true; });
    const next = jest.fn();
    memoryGuard.middleware({ log, gcInterval: 1000, heapUsed: () => 0.2 * GB, trim })({ path: '/r4/x' }, fakeRes(), next);
    expect(trim).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalled();
    expect(log.info.mock.calls.some(c => /^Memory: malloc_trim while refusing - 8\.5 GB -> 4\.0 GB$/.test(c[0]))).toBe(true);
  });

  test('trimAllocator: off unless given (a server with no role), on with true', () => {
    for (const [opts, on] of [[{}, false], [{ trimAllocator: null }, false], [{ trimAllocator: false }, false], [{ trimAllocator: true }, true]]) {
      memoryGuard.configure({ limit: 10 * GB, rejectFraction: 0.8, abortFraction: 0.9, ...opts });
      expect(memoryGuard._state.trimAllocator).toBe(on);
      expect(memoryGuard.describe()).toMatch(on ? /forced GC (and malloc_trim|\(malloc_trim not available here\))$/ : /forced GC \(no malloc_trim: trimAllocator is off\)$/);
    }
    // off: a refusal doesn't trim
    memoryGuard.configure({ limit: 10 * GB, rejectFraction: 0.8, abortFraction: 0.9 });
    setRss(8.5 * GB);
    const trim = jest.fn(() => true);
    memoryGuard.middleware({ gcInterval: 1000, heapUsed: () => 0.2 * GB, trim })({ path: '/r4/x' }, fakeRes(), () => {});
    expect(trim).not.toHaveBeenCalled();
  });

  test('trimAllocator false: no malloc_trim; nor where it is not available (null)', () => {
    memoryGuard.configure({ limit: 10 * GB, rejectFraction: 0.8, abortFraction: 0.9, trimAllocator: false });
    setRss(8.5 * GB);
    const trim = jest.fn(() => true);
    const res = fakeRes();
    memoryGuard.middleware({ gcInterval: 1000, heapUsed: () => 0.2 * GB, trim })({ path: '/r4/x' }, res, () => {});
    expect(trim).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    memoryGuard.configure({ limit: 10 * GB, rejectFraction: 0.8, abortFraction: 0.9, trimAllocator: true });
    setRss(8.5 * GB);
    const log = { info: jest.fn(), warn: jest.fn() };
    memoryGuard.middleware({ log, gcInterval: 1000, heapUsed: () => 0.2 * GB, trim: () => null })({ path: '/r4/x' }, fakeRes(), () => {});
    expect(log.info.mock.calls.some(c => /while refusing -/.test(c[0]))).toBe(false);
  });

  test('a look that gets back a good part of the excess keeps the wait; one that gets back little doubles it', () => {
    memoryGuard.configure({ limit: 10 * GB, rejectFraction: 0.8, abortFraction: 0.9, trimAllocator: true });
    const log = { info: jest.fn(), warn: jest.fn() };
    let now = 1000000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      // the connections close over a few seconds: each trim gets back a part
      let rss = 9.9 * GB;
      rssSpy.mockImplementation(() => rss);
      const trim = jest.fn(() => { rss -= 0.5 * GB; return true; });
      // (the trim alone between the looks is the next test's)
      const mw = memoryGuard.middleware({ log, gcInterval: 1000, gcMaxInterval: 8000, heapUsed: () => 0.1 * GB, trim, trimInterval: 100000 });
      const at = (t) => { now = 1000000 + t; memoryGuard._state.sampleTime = 0; mw({ path: '/r4/x' }, fakeRes(), () => {}); };
      at(0);     // 9.9 -> 9.4, a quarter of the excess: next in 1 s
      at(1000);  // 9.4 -> 8.9
      expect(trim).toHaveBeenCalledTimes(2);
      trim.mockImplementation(() => true); // now nothing more
      at(2000);  // 8.9 -> 8.9: next in 2 s
      at(3000);
      expect(trim).toHaveBeenCalledTimes(3);
      at(4000);
      expect(trim).toHaveBeenCalledTimes(4);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('between the looks, malloc_trim alone before refusing, once a second, with no back-off', () => {
    memoryGuard.configure({ limit: 10 * GB, rejectFraction: 0.8, abortFraction: 0.9, trimAllocator: true });
    // a burst has backed the looks off; it ends, and what it used is free but resident
    const log = { info: jest.fn(), warn: jest.fn() };
    let now = 1000000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let rss = 8.5 * GB;
      rssSpy.mockImplementation(() => rss);
      const trim = jest.fn(() => true);
      const mw = memoryGuard.middleware({ log, gcInterval: 1000, gcMaxInterval: 60000, heapUsed: () => 0.1 * GB, trim });
      const at = (t) => { now = 1000000 + t; memoryGuard._state.sampleTime = 0; const next = jest.fn(); mw({ path: '/r4/x' }, fakeRes(), next); return next; };
      at(0);                    // a look: nothing back, next look in 2 s
      at(500);                  // too soon for anything
      expect(trim).toHaveBeenCalledTimes(1);
      at(1000);                 // a trim alone
      expect(trim).toHaveBeenCalledTimes(2);
      rss = 8.04 * GB;          // the burst's memory is freed, resident
      trim.mockImplementation(() => { rss = 7.5 * GB; return true; });
      expect(at(1500)).not.toHaveBeenCalled(); // under a second since the last trim: refused
      expect(at(2100)).toHaveBeenCalled();     // the look (GC wait 2 s) trims: through
      expect(log.info.mock.calls.some(c => /while refusing - 8\.0 GB -> 7\.5 GB$/.test(c[0]))).toBe(true);
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

  (process.platform === 'linux' ? test : test.skip)('with mapped files, the in-operation check reads RssFile at most once per window, and RSS every 10 ms', () => {
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
      // many checks inside the window: one read, while a rise in RSS is seen within 10 ms
      for (let i = 0; i < 1000; i++) {
        now += 0.1;
        expect(memoryGuard.overAbortThreshold('test')).toBe(0);
      }
      rssSpy.mockReturnValue(11.5 * GB);
      now += 10.5;
      expect(memoryGuard.overAbortThreshold('test')).toBe(9.5 * GB);
      expect(reads).toBe(1);
      expect(rssSpy.mock.calls.length).toBeGreaterThanOrEqual(10);
      expect(rssSpy.mock.calls.length).toBeLessThanOrEqual(12);
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

  test('many checks inside 10 ms read RSS once; a dropped sample is measured again at once', () => {
    let now = 1000000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      setRss(9.5 * GB);
      rssSpy.mockClear();
      for (let i = 0; i < 100; i++) {
        now += 0.09;
        expect(memoryGuard.overAbortThreshold('test')).toBe(9.5 * GB);
      }
      expect(rssSpy).toHaveBeenCalledTimes(1);
      // a fall inside the 10 ms is not seen yet...
      rssSpy.mockReturnValue(7 * GB);
      expect(memoryGuard.overAbortThreshold('test')).toBe(9.5 * GB);
      expect(rssSpy).toHaveBeenCalledTimes(1);
      // ...but configure drops the sample, and the next check reads afresh
      memoryGuard.configure({ limit: 10 * GB, rejectFraction: 0.8, abortFraction: 0.9 });
      expect(memoryGuard.overAbortThreshold('test')).toBe(0);
      expect(rssSpy).toHaveBeenCalledTimes(2);
      // as do measureExcludingFileBacked and any other drop of the sample
      rssSpy.mockReturnValue(9.5 * GB);
      memoryGuard.measureExcludingFileBacked();
      memoryGuard._state.excludeFileBacked = false;
      expect(memoryGuard.overAbortThreshold('test')).toBe(9.5 * GB);
      expect(rssSpy).toHaveBeenCalledTimes(3);
      rssSpy.mockReturnValue(7 * GB);
      memoryGuard._state.sampleTime = 0;
      expect(memoryGuard.overAbortThreshold('test')).toBe(0);
      expect(rssSpy).toHaveBeenCalledTimes(4);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
