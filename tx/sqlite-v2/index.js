'use strict';
// sqlite-v2 terminology files: provider registration entry point.
//
// A library source line `snomed-v2:<file>`, `loinc-v2:<file>` or `rxnorm-v2:<file>` loads one file
// (Library.loadSqliteV2). Without such a line nothing here, nor roaring, is loaded.

const Database = require('better-sqlite3');
const { SqliteV2Factory } = require('./provider');
const { SnomedV2Factory } = require('./snomed');
const { checkFormat } = require('./store');

/** a factory for the file, chosen by the grammar it says its codes have */
async function loadSqliteV2Factory(i18n, file, opts = {}) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  let grammar;
  try {
    checkFormat(db, file);
    grammar = JSON.parse(db.prepare("SELECT value FROM main.meta WHERE key = 'behaviour.grammar'").pluck().get() || 'null');
  } finally {
    db.close();
  }
  // behaviour.grammar 'snomed': SNOMED CT expressions and ECL (snomed.js)
  const factory = grammar === 'snomed' ? new SnomedV2Factory(i18n, file, opts) : new SqliteV2Factory(i18n, file, opts);
  await factory.load();
  return factory;
}

module.exports = { loadSqliteV2Factory };
