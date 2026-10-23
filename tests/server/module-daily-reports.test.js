// The paragraphs each module contributes to the daily report (library/daily-report.js),
// and the request counting over a period they're built on (ServerStats.countsSince).

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');

const ServerStats = require('../../stats');
const { ServerRegistries, ServerRegistry, ServerInformation, ServerVersionInformation } = require('../../registry/model');
const RegistryModule = require('../../registry/registry');
const { UptimeHistory } = require('../../registry/uptime');
const TXModule = require('../../tx/tx');
const PackagesModule = require('../../packages/packages');
const SHLModule = require('../../shl/shl');
const PublisherModule = require('../../publisher/publisher');
const TestingModule = require('../../testing/testing');
const { TestReportStore: TestingStore } = require('../../testing/store');
const IpsModule = require('../../ips/ips');
const { IpsStore } = require('../../ips/store');

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 22, 13, 0, 0);
const SINCE = NOW - 24 * HOUR;

describe('request counts over a period', () => {
  let dir;
  let stats;
  const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhirsmith-counts-'));
    stats = new ServerStats({ database: path.join(dir, 'stats.db') }, log);
  });

  afterEach(() => {
    stats.finishStats();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('persisted intervals in the period, plus what has not been flushed yet', () => {
    const tx = stats.forModule('tx');
    tx.countRequest('$expand', 1, '/tx/r4');
    tx.countRequest('$expand', 1, '/tx/r4');
    stats.flushCounters(SINCE - HOUR, 600000);  // before the period: not counted
    tx.countRequest('$expand', 1, '/tx/r5');
    tx.countRequest('$validate', 1, '/tx/r4');
    stats.flushCounters(SINCE + HOUR, 600000);  // in the period
    tx.countRequest('$lookup', 1, '/tx/r4');     // not yet flushed: still counted
    stats.forModule('ips').countRequest('read', 1);

    const counts = tx.countsSince(SINCE, NOW);
    expect(counts.total).toBe(3);
    expect(counts.operations).toEqual({ '$expand': 1, '$validate': 1, '$lookup': 1 });
    expect(counts.endpoints['/tx/r5']).toEqual({ '$expand': 1 });
    expect(counts.persisted).toBe(true);
    expect(stats.forModule('ips').countsSince(SINCE, NOW).total).toBe(1);
  });

  test('flushNow writes the pending counts against now, so nothing is counted twice', () => {
    const tx = stats.forModule('tx');
    tx.countRequest('$expand', 1, '/tx/r4');
    stats.flushNow(NOW);
    expect(tx.countsSince(SINCE, NOW).total).toBe(1);
    // the next period starts where this one ended
    expect(tx.countsSince(NOW, NOW + HOUR).total).toBe(0);
  });

  test('without the database the counts are the unflushed ones, marked as partial', () => {
    const memory = new ServerStats({ enabled: false }, log);
    try {
      memory.forModule('tx').countRequest('$expand', 1, '/tx/r4');
      const counts = memory.forModule('tx').countsSince(SINCE, NOW);
      expect(counts.total).toBe(1);
      expect(counts.persisted).toBe(false);
    } finally {
      memory.finishStats();
    }
  });
});

// a ModuleStats stand-in with fixed counts
function statsWith(operations, endpoints = {}) {
  const total = Object.values(operations).reduce((a, b) => a + b, 0);
  return { countsSince: () => ({ total, operations, endpoints, persisted: true }) };
}

// an in-memory sqlite3 (async API) database with the given schema and rows
function asyncDb(statements) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => {
      if (err) {
        return reject(err);
      }
      db.serialize(() => {
        for (const sql of statements) {
          db.run(sql);
        }
        db.run('SELECT 1', (e) => e ? reject(e) : resolve(db));
      });
    });
  });
}

const utc = ms => new Date(ms).toISOString().replace('T', ' ').substring(0, 19);

describe('module paragraphs', () => {

  test('terminology server: each operation, busiest first, then the pages', () => {
    const tx = Object.create(TXModule.prototype);
    tx.stats = statsWith({ '$validate': 1200, '$expand': 3400, 'home': 20, '$lookup': 5, 'metadata': 30 },
      { '/tx/r4': {}, '/tx/r5': {} });
    expect(tx.dailyReport({ since: SINCE, now: NOW }))
      .toBe('4,655 requests were served over 2 endpoints: $expand 3,400, $validate 1,200, $lookup 5, metadata 30, home 20.');

    tx.stats = statsWith({});
    expect(tx.dailyReport({ since: SINCE, now: NOW })).toBe('No requests were served.');
  });

  test('registry: client requests, servers registered, and those that never answered', () => {
    const data = new ServerRegistries();
    const registry = new ServerRegistry();
    const server = (code, ...urls) => {
      const s = new ServerInformation();
      s.code = code;
      s.name = code;
      for (const url of urls) {
        const v = new ServerVersionInformation();
        v.address = url;
        s.versions.push(v);
      }
      registry.servers.push(s);
    };
    server('up', 'http://up.example.org/r4', 'http://up.example.org/r5');
    server('flaky', 'http://flaky.example.org/r4');
    server('down', 'http://down.example.org/r4', 'http://down.example.org/r5');
    server('before', 'http://before.example.org/r4');  // not scanned in the period at all
    data.registries.push(registry);

    const uptime = new UptimeHistory();
    for (let i = 1; i <= 4; i++) {
      const t = SINCE + i * 5 * HOUR;
      uptime.record('http://up.example.org/r4', true, t);
      uptime.record('http://up.example.org/r5', true, t);
      uptime.record('http://flaky.example.org/r4', i === 2, t);
      uptime.record('http://down.example.org/r4', false, t);
      uptime.record('http://down.example.org/r5', false, t);
    }
    uptime.record('http://down.example.org/r4', true, SINCE - HOUR);  // was fine yesterday
    uptime.record('http://before.example.org/r4', false, SINCE - HOUR);

    const module = new RegistryModule({});
    module.api = { getData: () => data };
    module.crawler = { uptime };
    module.stats = statsWith({ resolve: 150, home: 12, software: 3 });

    const text = module.dailyReport({ since: SINCE, now: NOW });
    expect(text).toContain('The API answered 150 client requests (165 requests in all, including the web pages).');
    expect(text).toContain('4 servers are registered, with 6 endpoints.');
    expect(text).toContain('This server did not answer any scan during the period: down.');

    module.crawler = null;
    expect(module.dailyReport({ since: SINCE, now: NOW })).toContain('availability is unknown');
    module.api = { getData: () => null };
    expect(module.dailyReport({ since: SINCE, now: NOW })).toContain('not available');
  });

  test('packages: downloads served and new versions found', async () => {
    const module = Object.create(PackagesModule.prototype);
    module.stats = statsWith({ download: 42, version: 100, page: 7 });
    module.db = await asyncDb([
      'CREATE TABLE PackageVersions (Id TEXT, Version TEXT, Indexed DATETIME)',
      `INSERT INTO PackageVersions VALUES ('hl7.fhir.us.core', '7.0.0', '${utc(SINCE + HOUR)}')`,
      `INSERT INTO PackageVersions VALUES ('hl7.fhir.us.core', '7.0.1', '${utc(SINCE + 2 * HOUR)}')`,
      `INSERT INTO PackageVersions VALUES ('hl7.fhir.uv.ips', '2.0.0', '${utc(SINCE + 3 * HOUR)}')`,
      `INSERT INTO PackageVersions VALUES ('old', '1.0.0', '${utc(SINCE - HOUR)}')`
    ]);
    try {
      expect(await module.dailyReport({ since: SINCE, now: NOW }))
        .toBe('42 packages were served (149 requests in all). 3 new package versions were found, of 2 packages.');
    } finally {
      module.db.close();
    }
  });

  test('shl: QR codes created in either form, accesses, and the documents behind them', async () => {
    const module = Object.create(SHLModule.prototype);
    module.db = await asyncDb([
      'CREATE TABLE SHL (uuid TEXT PRIMARY KEY, vhl BOOLEAN, created_at DATETIME)',
      'CREATE TABLE SHLFiles (id TEXT, shl_uuid TEXT)',
      'CREATE TABLE SHLViews (id INTEGER PRIMARY KEY, shl_uuid TEXT, created_at DATETIME)',
      `INSERT INTO SHL VALUES ('a', 0, '${utc(SINCE + HOUR)}'), ('b', 1, '${utc(SINCE + 2 * HOUR)}'), ('c', 1, '${utc(SINCE + 3 * HOUR)}'), ('old', 0, '${utc(SINCE - HOUR)}')`,
      `INSERT INTO SHLFiles VALUES ('f1', 'a'), ('f2', 'a'), ('f3', 'b'), ('f4', 'old')`,
      `INSERT INTO SHLViews (shl_uuid, created_at) VALUES ('a', '${utc(SINCE + 4 * HOUR)}'), ('old', '${utc(SINCE + 5 * HOUR)}'), ('old', '${utc(SINCE - HOUR)}')`
    ]);
    try {
      expect(await module.dailyReport({ since: SINCE, now: NOW }))
        .toBe('3 QR codes were served (1 SMART Health Link, 2 Verifiable Health Links), and links were accessed 2 times. 4 documents are stored to serve 3 QR codes.');
    } finally {
      module.db.close();
    }
    module.db = null;
    expect(await module.dailyReport({ since: SINCE, now: NOW })).toBe('The database is not open.');
  });

  test('publisher: runs started and finished', async () => {
    const module = Object.create(PublisherModule.prototype);
    module.db = await asyncDb([
      "CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT, building_at DATETIME, completed_at DATETIME, failed_at DATETIME)",
      `INSERT INTO tasks (status, building_at, completed_at) VALUES ('complete', '${utc(SINCE + HOUR)}', '${utc(SINCE + 2 * HOUR)}')`,
      `INSERT INTO tasks (status, building_at, failed_at) VALUES ('failed', '${utc(SINCE + 3 * HOUR)}', '${utc(SINCE + 4 * HOUR)}')`,
      `INSERT INTO tasks (status, building_at) VALUES ('building', '${utc(NOW - HOUR)}')`,
      `INSERT INTO tasks (status) VALUES ('waiting for approval')`,
      `INSERT INTO tasks (status, building_at, completed_at) VALUES ('complete', '${utc(SINCE - 2 * HOUR)}', '${utc(SINCE - HOUR)}')`
    ]);
    try {
      expect(await module.dailyReport({ since: SINCE, now: NOW }))
        .toBe('3 publication runs were started, and 1 finished successfully (1 failed). 1 task is queued or waiting for approval.');
    } finally {
      module.db.close();
    }
  });

  test('testing: pages, reports received, reports held', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhirsmith-testing-'));
    const store = new TestingStore(path.join(dir, 'testing.db'));
    try {
      const report = (id, receivedMs) => store.insert({
        id, meta: { lastUpdated: new Date(receivedMs).toISOString() }, name: 'r', status: 'completed', result: 'pass',
        testScript: { reference: 'TestScript/x' }, issued: '2026-10-22', tester: 't', participant: [], test: []
      }, { receivedMs });
      report('r1', SINCE - HOUR);
      report('r2', SINCE + HOUR);
      report('r3', NOW);
      const module = Object.create(TestingModule.prototype);
      module.stats = statsWith({ list: 10, read: 5 });
      module.store = store;
      expect(module.dailyReport({ since: SINCE, now: NOW })).toBe('15 pages were served. 2 test reports were received; 3 reports are held.');
      module.store = null;
      expect(module.dailyReport({ since: SINCE, now: NOW })).toContain('not open');
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ips: pages, documents received, documents stored', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhirsmith-ips-'));
    const store = new IpsStore(path.join(dir, 'ips.db'));
    try {
      const projectId = store.createProject('p', 'Project');
      const bundle = () => ({ resourceType: 'Bundle', type: 'document', entry: [{ resource: { resourceType: 'Composition', title: 'IPS' } }] });
      store.insert(projectId, bundle(), { source: 'api', receivedMs: SINCE - HOUR });
      store.insert(projectId, bundle(), { source: 'api', receivedMs: SINCE + HOUR });
      const module = Object.create(IpsModule.prototype);
      module.stats = statsWith({ read: 1 });
      module.store = store;
      expect(module.dailyReport({ since: SINCE, now: NOW })).toBe('1 page was served. 1 IPS document was received; 2 documents are stored.');
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
