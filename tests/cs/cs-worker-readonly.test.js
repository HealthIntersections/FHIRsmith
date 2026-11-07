/**
 * In a tx-worker (cluster.md) the LOINC and RxNorm databases are the master's: the worker
 * opens them read-only ({readOnly: true}, set from the role by tx.js and the library) and
 * leaves the journal mode and the indexes to the master. Without the option (the master, or
 * no role) loading sets them up as before.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { LoincServicesFactory } = require('../../tx/cs/cs-loinc');
const { RxNormServicesFactory } = require('../../tx/cs/cs-rxnorm');
const { RxNormModule } = require('../../tx/importers/import-rxnorm.module');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');

const LOINC_SOURCE = path.resolve(__dirname, '../../data/loinc-testing.db');
const LOINC_INDEXES = ['idx_descriptions_codekey_typkey', 'idx_relationships_sourcekey', 'idx_properties_codekey'];

function exec(dbPath, sql) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.exec(sql, err => db.close(() => err ? reject(err) : resolve()));
  });
}
function all(dbPath, sql) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    db.all(sql, [], (err, rows) => db.close(() => err ? reject(err) : resolve(rows)));
  });
}
const indexes = async (dbPath) => (await all(dbPath, "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")).map(r => r.name);
const journalMode = async (dbPath) => (await all(dbPath, 'PRAGMA journal_mode'))[0].journal_mode;
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tryWrite = (db) => new Promise(resolve => db.run('CREATE TABLE write_test (x)', err => resolve(err ? err.code : null)));

/** A copy of the LOINC test database in rollback-journal mode, with or without the load indexes. */
async function loincCopy(dir, withIndexes) {
  const dbPath = path.join(dir, 'loinc.db');
  fs.copyFileSync(LOINC_SOURCE, dbPath);
  await exec(dbPath, 'PRAGMA journal_mode = DELETE;' + (withIndexes ? '' : LOINC_INDEXES.map(i => `DROP INDEX IF EXISTS ${i};`).join('')));
  return dbPath;
}

/** A small RxNorm database (the tables load() reads), with or without the load indexes. */
async function rxnormDb(dir, withIndexes) {
  const dbPath = path.join(dir, 'rxnorm.db');
  await exec(dbPath, `
    CREATE TABLE RXNCONSO (RXCUI TEXT, RXAUI TEXT, SAB TEXT, TTY TEXT, CODE TEXT, STR TEXT, SUPPRESS TEXT);
    CREATE TABLE RXNREL (RXCUI1 TEXT, RXAUI1 TEXT, REL TEXT, RXCUI2 TEXT, RXAUI2 TEXT, RELA TEXT, SAB TEXT);
    CREATE TABLE RXNSTY (RXCUI TEXT, TUI TEXT);
    CREATE TABLE RXNSTEMS (stem TEXT, CUI TEXT);
    CREATE TABLE RXNVer (version TEXT);
    CREATE TABLE RXNATOMARCHIVE (RXAUI TEXT PRIMARY KEY, STR TEXT, RXCUI TEXT, SAB TEXT, TTY TEXT);
    INSERT INTO RXNVer VALUES ('TEST');
    INSERT INTO RXNCONSO VALUES ('1', 'A1', 'RXNORM', 'IN', '1', 'one', 'N');
  `);
  if (withIndexes) {
    await new RxNormModule().createIndexes(dbPath);
  }
  return dbPath;
}

describe('LOINC and RxNorm databases in a tx-worker', () => {
  let dir;
  let opContext;

  beforeAll(async () => {
    expect(fs.existsSync(LOINC_SOURCE)).toBe(true);
    opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-readonly-'));
  });
  afterEach(() => {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('LOINC: the worker writes nothing and its connection rejects writes; the master sets the file up', async () => {
    const dbPath = await loincCopy(dir, false);
    const before = sha(dbPath);
    const worker = new LoincServicesFactory(opContext.i18n, dbPath, { readOnly: true });
    await worker.load();
    const provider = await worker.build(opContext, []);
    try {
      expect(await tryWrite(provider.db)).toBe('SQLITE_READONLY');
    } finally {
      provider.close();
    }
    expect(sha(dbPath)).toBe(before);
    expect(await indexes(dbPath)).toEqual(expect.not.arrayContaining(LOINC_INDEXES));
    expect(await journalMode(dbPath)).toBe('delete');

    await new LoincServicesFactory(opContext.i18n, dbPath).load();
    expect(await indexes(dbPath)).toEqual(expect.arrayContaining(LOINC_INDEXES));
    expect(await journalMode(dbPath)).toBe('wal');
  });

  test('RxNorm: the worker writes nothing and its connection rejects writes; the master makes the indexes', async () => {
    const dbPath = await rxnormDb(dir, false);
    const before = sha(dbPath);
    const worker = new RxNormServicesFactory(opContext.i18n, dbPath, { readOnly: true });
    await worker.load();
    const provider = await worker.build(opContext, []);
    try {
      expect(await tryWrite(provider.db)).toBe('SQLITE_READONLY');
    } finally {
      provider.close();
    }
    expect(sha(dbPath)).toBe(before);
    expect(await indexes(dbPath)).toEqual([]);

    await new RxNormServicesFactory(opContext.i18n, dbPath).load();
    expect((await indexes(dbPath)).length).toBeGreaterThan(0);
  });

  test('a worker loads a read-only LOINC copy without the indexes (the master hasn\'t made them)', async () => {
    const dbPath = await loincCopy(dir, false);
    fs.chmodSync(dbPath, 0o444);
    fs.chmodSync(dir, 0o555);
    const loinc = new LoincServicesFactory(opContext.i18n, dbPath, { readOnly: true });
    await loinc.load();
    expect(loinc.version()).toBeTruthy();
  });

  test('a worker loads read-only copies (file and folder) that the master has set up', async () => {
    const loincPath = await loincCopy(dir, true);
    const rxPath = await rxnormDb(dir, true);
    const code = (await all(loincPath, 'SELECT Code FROM Codes ORDER BY CodeKey LIMIT 1'))[0].Code;
    for (const f of fs.readdirSync(dir)) {
      fs.chmodSync(path.join(dir, f), 0o444);
    }
    fs.chmodSync(dir, 0o555); // no journal can be created either

    const loinc = new LoincServicesFactory(opContext.i18n, loincPath, { readOnly: true });
    await loinc.load();
    const lp = await loinc.build(opContext, []);
    try {
      expect((await lp.locate(code)).context).toBeTruthy();
    } finally {
      lp.close();
    }

    const rx = new RxNormServicesFactory(opContext.i18n, rxPath, { readOnly: true });
    await rx.load();
    const rp = await rx.build(opContext, []);
    try {
      expect((await rp.locate('1')).context).toBeTruthy();
    } finally {
      rp.close();
    }
  });
});
