const fs = require('fs');
const os = require('os');
const path = require('path');
const { VSACValueSetProvider } = require('../../tx/vs/vs-vsac');
const { ValueSetDatabase } = require('../../tx/vs/vs-database');

/**
 * At startup, the first scheduled VSAC sync is due an interval after the last sync that
 * worked (as recorded in vsac_runs), not an interval after the start: otherwise each restart
 * puts the sync off, and a server restarted more often than once a day never syncs.
 * The cache is a real sqlite database in a temp folder; nothing is fetched from VSAC.
 */

const HOUR = 3600 * 1000;

function provider(dbPath) {
  const p = Object.create(VSACValueSetProvider.prototype);
  p.database = new ValueSetDatabase(dbPath);
  p.initialized = false;
  p.isRefreshing = false;
  p.lastRefresh = null;
  p.refreshIntervalHours = 24;
  p.stats = { addTask() {}, task() {}, taskDone() {}, taskError() {} };
  // the cache has value sets, so initialize() only syncs when the last sync didn't finish
  p._recount = async () => { p.database.vsCount = 1; };
  p._startRefreshTimer = jest.fn();
  p.refreshValueSets = jest.fn(async () => { throw new Error('VSAC is not reachable'); });
  return p;
}

describe('VSAC refresh timer after a restart', () => {
  let dir;
  let p;
  let log;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsac-restart-'));
    p = provider(path.join(dir, 'vsac.db'));
    await p.database.create();
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await p.database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // records a sync, and sets the clock to `ago` after it finished; returns when it finished (ms)
  async function syncedAgo(status, ago) {
    const id = await p.database.startRun();
    if (status === 'ok') {
      await p.database.finishRun(id, 1, 0);
    } else {
      await p.database.failRun(id, 'failed');
    }
    const finished = (await p.database.getLastRun()).finished_at * 1000;
    jest.spyOn(Date, 'now').mockReturnValue(finished + ago);
    return finished;
  }

  const delay = () => p._startRefreshTimer.mock.calls[0][0];

  test('the last sync 2 hours ago: the next is due in 22 hours', async () => {
    const finished = await syncedAgo('ok', 2 * HOUR);
    await p.initialize();
    expect(p.refreshValueSets).not.toHaveBeenCalled();
    expect(delay()).toBe(22 * HOUR);
    expect(p.lastRefresh.getTime()).toBe(finished);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^VSAC: next sync due at .* \(the last sync finished at /));
  });

  test('the last sync 30 hours ago: the next is due now', async () => {
    await syncedAgo('ok', 30 * HOUR);
    await p.initialize();
    expect(p.refreshValueSets).not.toHaveBeenCalled();
    expect(delay()).toBe(0);
  });

  test('no sync recorded: the whole interval', async () => {
    await p.initialize();
    expect(p.refreshValueSets).not.toHaveBeenCalled();
    expect(delay()).toBe(24 * HOUR);
    expect(p.lastRefresh).toBeNull();
  });

  test('the last sync failed: it is tried again at startup, and again soon after that fails', async () => {
    await syncedAgo('ok', 30 * HOUR);
    await syncedAgo('error', 2 * HOUR);
    await p.initialize();
    expect(p.refreshValueSets).toHaveBeenCalledTimes(1);
    expect(delay()).toBe(p._retryDelayMs(1));
  });
});
