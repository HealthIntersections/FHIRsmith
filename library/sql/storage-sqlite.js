//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Writes the rows of a view to a table in a SQLite database (better-sqlite3). The table is named
 * after the view (or options.table), so views run here need a name; it has a ViewRowKey integer
 * primary key, then any fixed columns, then a column per view column.
 *
 * Column types follow the Java runner: dates, strings, times and binaries are TEXT, decimals REAL,
 * integers and booleans INTEGER (booleans as 0/1). A column with no declared type has no type in
 * SQLite either, and takes each value as it comes. Collection and complex values, which SQLite
 * cannot hold as such, are stored as JSON text; an empty collection is NULL.
 *
 * Fixed columns are columns the view doesn't define, with a value the caller sets for each run
 * (storage.fixedValues) - which project and document the rows came from, say. Their names must
 * not be names a view can use: start them with an underscore.
 *
 * By default the table is created, and the rows of one run are written in one transaction
 * (unless the caller already has one open), committed by finish - or rolled back when the run
 * failed. With create: false the rows go into a table that already exists; with transaction:
 * false the caller looks after transactions.
 *
 * See storage-json.js for the storage interface.
 */

const { ColumnKind } = require('./model');
const { defaultResourceKey } = require('./keys');
const { jsonValue } = require('./storage-json');

class SqliteStorage {
  /**
   * @param {Object} db - a better-sqlite3 Database
   * @param {Object} [options]
   * @param {function} [options.keyFor] - (resource, root) => key, for getResourceKey()/getReferenceKey()
   * @param {string} [options.table] - the table name, instead of the view's name
   * @param {Array<{name: string, type?: string}>} [options.fixedColumns] - columns with values set per run (fixedValues)
   * @param {boolean} [options.create=true] - create the table; false to add rows to one that exists
   * @param {boolean} [options.replace] - drop the table first if it already exists (when creating)
   * @param {boolean} [options.transaction=true] - write each run in a transaction of its own
   */
  constructor(db, options = {}) {
    this.db = db;
    this.keyFor = options.keyFor || defaultResourceKey;
    this.table = options.table || null;
    this.fixedColumns = options.fixedColumns || [];
    this.fixedValues = {};
    this.create = options.create !== false;
    this.replace = !!options.replace;
    this.transaction = options.transaction !== false;
    this.needsName = !this.table;
  }

  createStore(name, columns) {
    const table = this.table || name;
    if (this.create) {
      if (this.replace) {
        this.db.exec(`DROP TABLE IF EXISTS ${quote(table)}`);
      }
      this.db.exec(SqliteStorage.createTableSql(table, columns, this.fixedColumns));
    }
    const names = [...this.fixedColumns.map(c => c.name), ...columns.map(c => c.name)];
    const insert = this.db.prepare(`INSERT INTO ${quote(table)} (${names.map(quote).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`);
    const ownTransaction = this.transaction && !this.db.inTransaction;
    if (ownTransaction) {
      this.db.exec('BEGIN');
    }
    return { name: table, columns, insert, ownTransaction };
  }

  /**
   * The CREATE TABLE statement for a view's columns. ViewRowKey is assigned by SQLite (rowid),
   * so rows can be added to the table by more than one run.
   */
  static createTableSql(table, columns, fixedColumns = []) {
    const defs = ['ViewRowKey INTEGER PRIMARY KEY'];
    for (const c of fixedColumns) {
      defs.push(c.type ? `${quote(c.name)} ${c.type}` : quote(c.name));
    }
    for (const c of columns) {
      const type = sqliteType(c);
      defs.push(type ? `${quote(c.name)} ${type} NULL` : `${quote(c.name)} NULL`);
    }
    return `CREATE TABLE ${quote(table)} (${defs.join(', ')})`;
  }

  addRow(store, cells) {
    const params = this.fixedColumns.map(c => this.fixedValues[c.name] ?? null);
    for (const cell of cells) {
      params.push(sqliteValue(cell));
    }
    store.insert.run(params);
  }

  finish(store, ok = true) {
    if (store.ownTransaction && this.db.inTransaction) {
      this.db.exec(ok ? 'COMMIT' : 'ROLLBACK');
    }
  }

  getKeyForSourceResource(resource, root) {
    return this.keyFor(resource, root);
  }

  getKeyForTargetResource(resource, root) {
    return this.keyFor(resource, root);
  }
}

function sqliteType(column) {
  if (column.collection) {
    return 'TEXT';
  }
  switch (column.kind) {
    case ColumnKind.DateTime:
    case ColumnKind.String:
    case ColumnKind.Time:
    case ColumnKind.Binary:
    case ColumnKind.Complex:
      return 'TEXT';
    case ColumnKind.Decimal:
      return 'REAL';
    case ColumnKind.Integer:
    case ColumnKind.Boolean:
      return 'INTEGER';
    default:
      return null;
  }
}

function sqliteValue(cell) {
  if (cell.values.length === 0) {
    return null;
  }
  if (cell.column.collection || cell.values.length > 1) {
    return JSON.stringify(cell.values.map(jsonValue));
  }
  const v = cell.values[0];
  switch (v.kind) {
    case ColumnKind.Boolean:
      return v.value ? 1 : 0;
    case ColumnKind.Integer:
    case ColumnKind.Decimal:
      return v.value;
    case ColumnKind.Complex:
      return JSON.stringify(v.value);
    default:
      return String(v.value);
  }
}

function quote(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

module.exports = { SqliteStorage, quoteIdentifier: quote };
