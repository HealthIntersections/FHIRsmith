// The VSAC refresh timer: Node fires a timer whose delay is above 2^31-1 ms (about 596 hours) after
// 1 ms instead, so a long refreshIntervalHours used to run the refresh back to back

const { VSACValueSetProvider } = require('../../tx/vs/vs-vsac');

function provider(refreshIntervalHours) {
  const p = Object.create(VSACValueSetProvider.prototype);
  p.refreshIntervalHours = refreshIntervalHours;
  p.refreshTimer = null;
  return p;
}

describe('VSAC refresh interval', () => {
  let warn;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  test('an ordinary interval is used as given', () => {
    expect(provider(24)._refreshIntervalMs()).toBe(24 * 3600 * 1000);
    expect(provider(0.5)._refreshIntervalMs()).toBe(1800 * 1000);
    expect(warn).not.toHaveBeenCalled();
  });

  test('an interval longer than a timer can wait is clamped, not turned into 1 ms', () => {
    expect(provider(100000)._refreshIntervalMs()).toBe(2 ** 31 - 1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('a value that is not a positive number falls back to 24 hours', () => {
    for (const h of [-1, 'abc', NaN, Infinity]) {
      expect(provider(h)._refreshIntervalMs()).toBe(24 * 3600 * 1000);
    }
  });

  test('the timer is started with the clamped delay', () => {
    const spy = jest.spyOn(global, 'setTimeout');
    const p = provider(100000);
    try {
      p._startRefreshTimer();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toBe(2 ** 31 - 1);
    } finally {
      clearTimeout(p.refreshTimer);
      spy.mockRestore();
    }
  });
});
