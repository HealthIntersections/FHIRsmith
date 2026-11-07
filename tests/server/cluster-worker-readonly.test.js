/**
 * A tx-worker (server.js --role=tx-worker) starts and answers against VSAC, LOINC and RxNorm
 * databases it can only read. The master starts first on the same data directory and sets
 * them up (VSAC schema, LOINC and RxNorm indexes), and stops; the databases are then made a
 * read-only copy: rollback-journal mode, the files and their folder read-only (no journal or
 * WAL can be made). The rest of the data directory (the package caches) stays as it was.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { spawn } = require('child_process');
const { request, param } = require('../utils/cluster-harness');
const { ValueSetDatabase } = require('../../tx/vs/vs-database');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 20180;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const exec = (dbPath, sql) => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(dbPath);
  db.exec(sql, err => db.close(() => err ? reject(err) : resolve()));
});
const all = (dbPath, sql) => new Promise((resolve, reject) => {
  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
  db.all(sql, [], (err, rows) => db.close(() => err ? reject(err) : resolve(rows)));
});
const VS_URL = 'http://cts.nlm.nih.gov/fhir/ValueSet/worker-readonly';

describe('a tx-worker on read-only databases', () => {
  let dir;
  let proc = null;
  const readOnly = [];

  // node server.js with these flags, on the data directory; resolves once it answers /health
  async function start(args) {
    const log = path.join(dir, `${args[0].slice(7)}.log`);
    const out = fs.openSync(log, 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), ...args, `--port=${PORT}`], {
      cwd: ROOT, env: { ...process.env, FHIRSMITH_DATA_DIR: dir }, stdio: ['ignore', out, out]
    });
    fs.closeSync(out); // the child has its own copy
    proc = { child, log, exited: new Promise(resolve => child.once('exit', resolve)) };
    const t0 = Date.now();
    while (!(await request(PORT, 'GET', '/health').then(r => r.status === 200, () => false))) {
      if (Date.now() - t0 > 120000 || child.exitCode !== null) {
        throw new Error(`${args[0]} did not start:\n${fs.readFileSync(log, 'utf8').slice(-4000)}`);
      }
      await sleep(250);
    }
    return proc;
  }
  async function stop(signal = 'SIGTERM') {
    if (proc && proc.child.exitCode === null && proc.child.signalCode === null) {
      proc.child.kill(signal);
      const timer = setTimeout(() => proc.child.kill('SIGKILL'), 20000);
      await proc.exited;
      clearTimeout(timer);
    }
    proc = null;
  }

  afterAll(async () => {
    await stop('SIGKILL');
    for (const d of readOnly) {
      fs.chmodSync(d, 0o755);
    }
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('starts, and serves VSAC, LOINC and RxNorm', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-ro-'));
    const cache = path.join(dir, 'terminology-cache');
    const vsacDir = path.join(cache, 'vsac');
    const ro = path.join(cache, 'ro');
    fs.mkdirSync(vsacDir, { recursive: true });
    fs.mkdirSync(ro);
    // the R4 core package, if a test run has already downloaded it, saves fetching it again
    const core = path.join(ROOT, 'data', 'terminology-cache', 'hl7.fhir.r4.core#4.0.1', 'package');
    if (fs.existsSync(core)) {
      fs.cpSync(core, path.join(cache, 'hl7.fhir.r4.core#4.0.1', 'package'), { recursive: true });
    }

    // a VSAC database with one value set (what an earlier sync left), LOINC without the
    // indexes its load makes, RxNorm with none
    const vsac = path.join(vsacDir, 'vsac-valuesets.db');
    const vs = { resourceType: 'ValueSet', id: 'worker-readonly', url: VS_URL, version: '1', status: 'active', title: 'Read-only',
      compose: { include: [{ system: 'http://loinc.org', concept: [{ code: '1-8' }] }] } };
    const database = new ValueSetDatabase(vsac);
    await database.create();
    await database.upsertValueSet(vs, crypto.createHash('sha256').update(JSON.stringify(vs)).digest('hex'));
    await database.close();
    const loinc = path.join(ro, 'loinc.db');
    fs.copyFileSync(path.join(ROOT, 'data', 'loinc-testing.db'), loinc);
    await exec(loinc, 'PRAGMA journal_mode = DELETE; DROP INDEX IF EXISTS idx_properties_codekey;');
    const loincCode = (await all(loinc, "SELECT Code FROM Codes WHERE Code LIKE '%-%' ORDER BY CodeKey LIMIT 1"))[0].Code;
    const rxnorm = path.join(ro, 'rxnorm.db');
    await exec(rxnorm, `
      CREATE TABLE RXNCONSO (RXCUI TEXT, RXAUI TEXT, SAB TEXT, TTY TEXT, CODE TEXT, STR TEXT, SUPPRESS TEXT);
      CREATE TABLE RXNREL (RXCUI1 TEXT, RXAUI1 TEXT, REL TEXT, RXCUI2 TEXT, RXAUI2 TEXT, RELA TEXT, SAB TEXT);
      CREATE TABLE RXNSTY (RXCUI TEXT, TUI TEXT);
      CREATE TABLE RXNSTEMS (stem TEXT, CUI TEXT);
      CREATE TABLE RXNVer (version TEXT);
      CREATE TABLE RXNATOMARCHIVE (RXAUI TEXT PRIMARY KEY, STR TEXT, RXCUI TEXT, SAB TEXT, TTY TEXT);
      INSERT INTO RXNVer VALUES ('TEST');
      INSERT INTO RXNCONSO VALUES ('1', 'A1', 'RXNORM', 'IN', '1', 'one', 'N');
    `);

    fs.writeFileSync(path.join(dir, 'library.yml'), 'base:\n  url: https://storage.googleapis.com/tx-fhir-org\n\nsources:\n' +
      '  - internal:vsac=vsac\n  - loinc:ro/loinc.db\n  - rxnorm:ro/rxnorm.db\n');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      hostName: 'worker-readonly-test',
      logging: { console: false },
      server: { port: PORT },
      modules: {
        tx: {
          enabled: true, instanceCode: 'm0', librarySource: path.join(dir, 'library.yml'),
          endpoints: [{ path: '/r4', fhirVersion: '4.0', context: null }],
          // never contacted: the value set is already there, and a worker doesn't sync
          vsacCfg: { apiKey: 'test', baseUrl: 'https://127.0.0.1:9/fhir', refreshIntervalHours: 24 }
        }
      }
    }));

    // the master sets them up, and the package caches, before it answers
    await start(['--role=master', '--instance-code=m0']);
    await stop();
    const names = async (file) => (await all(file, "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")).map(r => r.name);
    expect(await names(loinc)).toContain('idx_properties_codekey');
    expect((await names(rxnorm)).length).toBeGreaterThan(0);
    expect((await all(vsac, 'PRAGMA table_info(vsac_events)')).length).toBeGreaterThan(0);

    // a read-only copy (of every VSAC database: an engine may keep its own beside the classic one)
    const vsacFiles = fs.readdirSync(vsacDir).filter(n => n.endsWith('.db')).map(n => path.join(vsacDir, n));
    for (const file of [...vsacFiles, loinc, rxnorm]) {
      await exec(file, 'PRAGMA journal_mode = DELETE');
      fs.chmodSync(file, 0o444);
    }
    for (const d of [vsacDir, ro]) {
      fs.chmodSync(d, 0o555);
      readOnly.push(d);
    }

    const worker = await start(['--role=tx-worker', '--instance-code=tx1']);
    const lookup = (system, code) => request(PORT, 'GET', `/r4/CodeSystem/$lookup?system=${encodeURIComponent(system)}&code=${encodeURIComponent(code)}`);
    const l = await lookup('http://loinc.org', loincCode);
    expect(l.status).toBe(200);
    expect(param(l.json, 'display')).toBeDefined();
    const r = await lookup('http://www.nlm.nih.gov/research/umls/rxnorm', '1');
    expect(r.status).toBe(200);
    expect(param(r.json, 'display').valueString).toBe('one');
    const v = await request(PORT, 'GET', `/r4/ValueSet?url=${encodeURIComponent(VS_URL)}`);
    expect(v.status).toBe(200);
    expect((v.json.entry || []).map(e => e.resource.title)).toEqual(['Read-only']);

    const log = fs.readFileSync(worker.log, 'utf8') + fs.readFileSync(path.join(dir, 'logs', 'server.log'), 'utf8');
    expect(log).not.toMatch(/SQLITE_(READONLY|CANTOPEN)|not migrated yet|is read-only; lookups/);
  }, 300000);
});
