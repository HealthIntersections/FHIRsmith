/**
 * data/loinc-testing.db: the LOINC test subset (tx/data/loinc), imported. cs-loinc.test.js
 * imports it afresh; the suites that need a LOINC database copy it. Suites can run at the same
 * time (jest workers, or two jest runs), so:
 *
 *  - the import is written to a file of its own next to it and renamed into place: a suite
 *    copying it gets the previous database or the new one, never a half-written file;
 *  - it is left in rollback-journal mode, all in the one file, and no suite opens it with
 *    sqlite (a provider sets WAL and makes indexes as it loads): each works on a copy.
 *
 * A suite that runs before any import imports it the same way.
 */
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const LOINC_TESTING_DB = path.resolve(__dirname, '../data/loinc-testing.db');
const SOURCE = path.resolve(__dirname, '../tx/data/loinc');

function exec(file, sql) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file);
    db.exec(sql, (err) => db.close(() => err ? reject(err) : resolve()));
  });
}

/**
 * Imports the test subset into a file next to target, then renames it onto target.
 * @param {string} [target]
 * @returns {Promise<string>} target
 */
async function importLoincTestingDb(target = LOINC_TESTING_DB) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    const { LoincDataMigrator } = require('../tx/importers/import-loinc.module');
    await new LoincDataMigrator().migrate(SOURCE, tmp, '2.80-test', { verbose: false, mainOnly: false });
    await exec(tmp, 'PRAGMA journal_mode = DELETE');
    // what an older run left, when the file was opened in place (WAL), would not be this file's
    for (const f of [target + '-wal', target + '-shm', target + '-journal']) {
      fs.rmSync(f, { force: true });
    }
    fs.renameSync(tmp, target);
  } finally {
    for (const f of [tmp, tmp + '-wal', tmp + '-shm', tmp + '-journal']) {
      fs.rmSync(f, { force: true });
    }
  }
  return target;
}

/** data/loinc-testing.db, imported first if no suite has */
async function loincTestingDb() {
  if (!fs.existsSync(LOINC_TESTING_DB)) {
    await importLoincTestingDb();
  }
  return LOINC_TESTING_DB;
}

/**
 * A copy of data/loinc-testing.db (imported first if no suite has), to open, change or delete.
 * @param {string} dir - where the copy goes
 * @param {string} [name]
 * @returns {Promise<string>} the copy's path
 */
async function loincTestingDbCopy(dir, name = 'loinc.db') {
  const dest = path.join(dir, name);
  fs.copyFileSync(await loincTestingDb(), dest);
  return dest;
}

module.exports = { LOINC_TESTING_DB, importLoincTestingDb, loincTestingDb, loincTestingDbCopy };
