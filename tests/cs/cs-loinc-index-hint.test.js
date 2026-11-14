/**
 * LOINC: a database imported before the importer made idx_codes_description gets one warning at
 * load, with the sqlite3 command that adds the index; one that has it gets none.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { LoincDataMigrator } = require('../../tx/importers/import-loinc.module');
const { LoincServicesFactory } = require('../../tx/cs/cs-loinc');
const Logger = require('../../library/logger');
const { TestUtilities } = require('../test-utilities');

const INDEX_SQL = 'CREATE INDEX IF NOT EXISTS idx_codes_description ON Codes(Description COLLATE NOCASE)';

function exec(file, sql) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file);
    db.exec(sql, (err) => db.close(() => err ? reject(err) : resolve()));
  });
}

describe('LOINC factory: the idx_codes_description hint', () => {
  let dir;
  let withIndex;
  let withoutIndex;
  let warnings;
  let i18n;

  beforeAll(async () => {
    i18n = await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions());
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loinc-index-hint-'));
    // the importer's tables, empty, with no indexes (the importer makes those last): as a
    // database imported before it made this one. Enough for the factory to load
    withoutIndex = path.join(dir, 'without index.db');
    const db = new sqlite3.Database(withoutIndex);
    // (what migrate() sets up before it creates the tables)
    const migrator = Object.assign(new LoincDataMigrator(),
      { statii: new Map(), langs: new Map(), rels: new Map(), dTypes: new Map(), props: new Map() });
    await migrator.createTables(db, '2.80-test', false);
    await new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
    await exec(withoutIndex, 'PRAGMA journal_mode = DELETE');
    withIndex = path.join(dir, 'with-index.db');
    fs.copyFileSync(withoutIndex, withIndex);
    await exec(withIndex, INDEX_SQL);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    warnings = [];
    jest.spyOn(Logger.getInstance(), 'child').mockReturnValue({ warn: (m) => warnings.push(m) });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const load = async (file, options) => {
    const factory = new LoincServicesFactory(i18n, file, options);
    await factory.load();
    return factory;
  };

  test('without the index: one warning, with the command, however often the file is loaded', async () => {
    await load(withoutIndex);
    await load(withoutIndex);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('has no index on Codes.Description');
    // the path quoted for the shell (it has a space)
    expect(warnings[0]).toContain(`sqlite3 '${withoutIndex}' "${INDEX_SQL}"`);
  });

  test('with the index: nothing said', async () => {
    await load(withIndex);
    expect(warnings).toEqual([]);
  });

  test('a tx-worker (read-only) says nothing: the master opens the same file', async () => {
    const copy = path.join(dir, 'worker.db');
    fs.copyFileSync(withoutIndex, copy);
    await load(copy, { readOnly: true });
    expect(warnings).toEqual([]);
  });

  test('the warning\'s command adds the index, after which nothing is said', async () => {
    const copy = path.join(dir, 'fixed.db');
    fs.copyFileSync(withoutIndex, copy);
    await load(copy);
    expect(warnings.length).toBe(1);
    const sql = warnings[0].match(/sqlite3 \S+ "(.*)"$/)[1];
    await exec(copy, sql);
    // under another name, as the once-per-file memory would hide it
    const again = path.join(dir, 'fixed-again.db');
    fs.copyFileSync(copy, again);
    warnings = [];
    await load(again);
    expect(warnings).toEqual([]);
  });
});
