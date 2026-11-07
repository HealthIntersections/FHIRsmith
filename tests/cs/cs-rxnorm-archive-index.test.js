/**
 * RXNATOMARCHIVE(RXCUI, SAB) index.
 *
 * locate() looks a code RxNorm doesn't have up in RXNATOMARCHIVE. Without an index on
 * RXCUI that is a scan of the whole table (~372k rows, 40-50 ms) for every unknown code.
 * The importer now makes the index, and loading a database imported before it did adds
 * it - unless the database can't be written, in which case it is used as it is.
 *
 * These build a small database with just the tables load() reads, so they run without
 * the RxNorm import the main cs-rxnorm suite depends on.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { RxNormServicesFactory } = require('../../tx/cs/cs-rxnorm');
const { RxNormModule } = require('../../tx/importers/import-rxnorm.module');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');

const INDEX = 'idx_rxnatomarchive_rxcui_sab';

function exec(dbPath, sql) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    db.exec(sql, err => db.close(() => err ? reject(err) : resolve()));
  });
}

function all(dbPath, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    db.all(sql, params, (err, rows) => db.close(() => err ? reject(err) : resolve(rows)));
  });
}

async function hasIndex(dbPath) {
  const rows = await all(dbPath, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", [INDEX]);
  return rows.length === 1;
}

/** An RxNorm database as an older import left it: the tables, but no archive index. */
async function makeOldDb(dbPath) {
  await exec(dbPath, `
    CREATE TABLE RXNCONSO (RXCUI TEXT, RXAUI TEXT, SAB TEXT, TTY TEXT, CODE TEXT, STR TEXT, SUPPRESS TEXT);
    CREATE TABLE RXNREL (RXCUI1 TEXT, RXAUI1 TEXT, REL TEXT, RXCUI2 TEXT, RXAUI2 TEXT, RELA TEXT, SAB TEXT);
    CREATE TABLE RXNSTY (RXCUI TEXT, TUI TEXT);
    CREATE TABLE RXNSTEMS (stem TEXT, CUI TEXT);
    CREATE TABLE RXNVer (version TEXT);
    CREATE TABLE RXNATOMARCHIVE (RXAUI TEXT PRIMARY KEY, STR TEXT, RXCUI TEXT, SAB TEXT, TTY TEXT);
    INSERT INTO RXNVer VALUES ('TEST');
    INSERT INTO RXNCONSO VALUES ('1', 'A1', 'RXNORM', 'IN', '1', 'one', 'N');
    INSERT INTO RXNATOMARCHIVE VALUES ('A9', 'nine (archived)', '9', 'RXNORM', 'IN');
  `);
}

describe('RXNATOMARCHIVE index', () => {
  let dir;
  let i18n;

  beforeAll(async () => {
    i18n = await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions());
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rxnorm-archive-index-'));
  });

  afterEach(() => {
    for (const f of fs.readdirSync(dir)) {
      fs.chmodSync(path.join(dir, f), 0o644);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the importer makes it', async () => {
    const dbPath = path.join(dir, 'rx.db');
    await makeOldDb(dbPath);
    await new RxNormModule().createIndexes(dbPath);
    expect(await hasIndex(dbPath)).toBe(true);
  });

  test('loading a database imported without it adds it, and archive lookups use it', async () => {
    const dbPath = path.join(dir, 'rx.db');
    await makeOldDb(dbPath);
    expect(await hasIndex(dbPath)).toBe(false);

    await new RxNormServicesFactory(i18n, dbPath).load();

    expect(await hasIndex(dbPath)).toBe(true);
    const plan = await all(dbPath, 'EXPLAIN QUERY PLAN SELECT STR, TTY FROM RXNATOMARCHIVE WHERE RXCUI = ? AND SAB = ?', ['9', 'RXNORM']);
    expect(plan.map(r => r.detail).join(' ')).toContain(INDEX);
  });

  test('a read-only database without it still loads, and archive lookups still work', async () => {
    const dbPath = path.join(dir, 'rx.db');
    await makeOldDb(dbPath);
    fs.chmodSync(dbPath, 0o444);
    fs.chmodSync(dir, 0o555); // no journal can be created either
    try {
      const factory = new RxNormServicesFactory(i18n, dbPath);
      await factory.load();
      expect(await hasIndex(dbPath)).toBe(false);

      const provider = await factory.build(new OperationContext('en', i18n), []);
      try {
        const archived = await provider.locate('9');
        expect(archived.context).not.toBeNull();
        expect(archived.context.archived).toBe(true);
        const unknown = await provider.locate('12345');
        expect(unknown.context).toBeNull();
      } finally {
        provider.close();
      }
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });
});
