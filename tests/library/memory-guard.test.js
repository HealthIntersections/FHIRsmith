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
});
