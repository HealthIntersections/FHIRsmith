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
    memoryGuard.middleware({ gcInterval: 1000 })({ path: '/r4/x' }, fakeRes(), next);
    expect(next).toHaveBeenCalled();
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
