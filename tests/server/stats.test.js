const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ServerStats = require('../../stats');

describe('server statistics', () => {
  let dir;
  let dbPath;
  let log;
  let running;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhirsmith-stats-'));
    dbPath = path.join(dir, 'stats.db');
    log = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
    running = [];
  });

  afterEach(() => {
    // every ServerStats holds an interval timer, so they all have to be closed
    // or jest won't exit
    for (const stats of running) {
      stats.finishStats();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function newStats(config) {
    const stats = new ServerStats({ database: dbPath, ...config }, log);
    running.push(stats);
    return stats;
  }

  function readRows() {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.prepare('SELECT * FROM request_counts ORDER BY id').all();
    } finally {
      db.close();
    }
  }

  test('counts are attributed by module, endpoint and operation', () => {
    const stats = newStats();
    const tx = stats.forModule('tx');
    const token = stats.forModule('token');

    for (let i = 0; i < 5; i++) {
      tx.countRequest('$expand', 10, '/tx/r4');
    }
    tx.countRequest('$expand', 30, '/tx/r5');
    tx.countRequest('$validate', 7, '/tx/r4');
    token.countRequest('login', 3);
    stats.countRequest('dashboard', 1);

    expect(stats.flushCounters(1000, 600000)).toBe(5);
    const rows = readRows();

    const r4expand = rows.find(r => r.endpoint === '/tx/r4' && r.operation === '$expand');
    expect(r4expand.module).toBe('tx');
    expect(r4expand.count_delta).toBe(5);
    expect(r4expand.time_delta).toBe(50);
    expect(rows.find(r => r.endpoint === '/tx/r5' && r.operation === '$expand').count_delta).toBe(1);
    expect(rows.find(r => r.operation === '$validate').endpoint).toBe('/tx/r4');

    // modules with a single endpoint don't carry one
    expect(rows.find(r => r.module === 'token').endpoint).toBe('');
    // and anything counted on the server itself is attributed to the server
    expect(rows.find(r => r.operation === 'dashboard').module).toBe('(server)');

    // the server-wide counters still see every request
    expect(stats.requestCount).toBe(9);
    expect(rows.every(r => r.interval_ms === 600000)).toBe(true);
  });

  test('only keys with traffic in the interval are written', () => {
    const stats = newStats();
    const tx = stats.forModule('tx');
    tx.countRequest('$expand', 10, '/tx/r4');
    tx.countRequest('$lookup', 2, '/tx/r4');
    expect(stats.flushCounters(1000, 600000)).toBe(2);

    tx.countRequest('$expand', 4, '/tx/r4');
    expect(stats.flushCounters(2000, 600000)).toBe(1);
    expect(stats.flushCounters(3000, 600000)).toBe(0);

    expect(readRows().length).toBe(3);
  });

  test('totals survive a restart, deltas do not', () => {
    const first = newStats();
    first.forModule('tx').countRequest('$expand', 10, '/tx/r4');
    first.flushCounters(1000, 600000);
    first.finishStats();

    const second = newStats();
    second.forModule('tx').countRequest('$expand', 5, '/tx/r4');
    second.flushCounters(2000, 600000);

    const last = readRows().pop();
    expect(last.count_delta).toBe(1);
    expect(last.count_total).toBe(2);
    expect(last.time_delta).toBe(5);
    expect(last.time_total).toBe(15);
  });

  test('the last partial interval is written on shutdown', () => {
    const stats = newStats();
    stats.markStarted();
    stats.forModule('tx').countRequest('$expand', 10, '/tx/r4');
    stats.finishStats();

    const rows = readRows().filter(r => r.operation === '$expand');
    expect(rows.length).toBe(1);
    expect(rows[0].count_total).toBe(1);
  });

  test('statistics never take the server down', () => {
    // a database that cannot be opened is logged and then ignored. A plain
    // file where a directory should be is a portable way to make that happen
    const blocker = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blocker, 'x');
    const stats = newStats({ database: path.join(blocker, 'stats.db') });
    stats.forModule('tx').countRequest('$expand', 10, '/tx/r4');

    expect(stats.db).toBeNull();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Unable to open the statistics database'));
    expect(stats.requestCount).toBe(1);
    expect(stats.flushCounters(1000, 600000)).toBe(0);
  });

  test('statistics can be turned off', () => {
    const stats = newStats({ enabled: false });
    stats.forModule('tx').countRequest('$expand', 10, '/tx/r4');

    expect(stats.db).toBeNull();
    expect(fs.existsSync(dbPath)).toBe(false);
    // still counted in memory, for the status page
    expect(stats.requestCount).toBe(1);
    expect(stats.counterFor('tx', '/tx/r4', '$expand').countTotal).toBe(1);
  });

  test('a module view cannot be told apart from the stats themselves', () => {
    const stats = newStats();
    const tx = stats.forModule('tx');

    tx.addTask('Client Cache', '5 min');
    tx.task('Client Cache', 'working');
    expect(stats.taskDetails()).toContain('Client Cache');

    const cachingModule = { expansionItemCount: () => 3 };
    tx.cachingModules.push(cachingModule);
    expect(stats.expansionItems()).toBe(3);
  });

  test('closureStats comes from the module that keeps closure tables, or is null', () => {
    const stats = newStats();
    expect(stats.closureStats()).toBeNull();
    stats.cachingModules.push({ closureStats: () => null }); // closure turned off
    expect(stats.closureStats()).toBeNull();
    const figures = { tables: 2, concepts: 5, entries: 4, bytes: 4096, retentionDays: null };
    stats.cachingModules.push({ closureStats: () => figures });
    expect(stats.closureStats()).toBe(figures);
  });
});
