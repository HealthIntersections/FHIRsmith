//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The SQLite implementation of the rest module's database interface (database/index.js).
 *
 * It uses the async `sqlite3` driver, not `better-sqlite3`: a synchronous driver blocks the
 * process for the length of every query, and a slow search would stop every other request
 * on the process.
 *
 * - WAL mode, so readers don't block the writer, with a busy timeout.
 * - One writer at a time across all processes: within a process, writes queue for the one
 *   write connection; across processes, BEGIN IMMEDIATE takes the write lock at the start of
 *   the transaction (a transaction that starts as a reader and upgrades fails with
 *   SQLITE_BUSY under load instead of waiting).
 * - Reads come from a small pool, and a connection never runs two queries at once (see
 *   library/sqlite-pool.js for why).
 *
 * @module rest/database/sqlite
 */

const sqlite3 = require('sqlite3');

const READERS = 4;
const BUSY_TIMEOUT_MS = 30000;
const WRITE_RETRIES = 5;

function openConnection(file, mode) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, mode, (err) => err ? reject(err) : resolve(db));
  });
}

/**
 * One connection, as the database interface's query object: all, get, run, exec.
 */
class SqliteQuery {
  constructor(db, dialect) {
    this.db = db;
    this.dialect = dialect;
    this.inTransaction = false;
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => err ? reject(wrapError(err, sql)) : resolve(rows));
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => err ? reject(wrapError(err, sql)) : resolve(row));
    });
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) {
          reject(wrapError(err, sql));
        } else {
          resolve({ changes: this.changes, lastId: this.lastID });
        }
      });
    });
  }

  /** A named lock: nothing to do, since a SQLite write transaction holds the database's write lock */
  async lock() {}

  exec(sql) {
    return new Promise((resolve, reject) => {
      this.db.exec(sql, (err) => err ? reject(wrapError(err, sql)) : resolve());
    });
  }
}

function wrapError(err, sql) {
  if (err && /UNIQUE constraint failed|PRIMARY KEY must be unique/i.test(err.message)) {
    err.unique = true;
  }
  if (err && (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED')) {
    err.busy = true;
  }
  if (err && sql && !err.sql) {
    err.sql = sql;
  }
  return err;
}

const DIALECT = {
  name: 'sqlite',
  insertIgnore: (table, cols) => `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES `,
  concat: (a, b) => `(${a} || ${b})`,
  // a write transaction already holds the database's write lock
  forUpdate: '',
  // the most ? in one statement (SQLITE_MAX_VARIABLE_NUMBER is 32766 in current builds)
  maxParams: 30000
};

class SqliteDatabase {
  /**
   * @param {string} file - the database file
   */
  constructor(file) {
    this.file = file;
    this.dialect = DIALECT;
    this.readers = [];
    this.free = [];
    this.waiting = [];
    this.writer = null;
    this.writeQueue = Promise.resolve();
  }

  async open() {
    const w = await openConnection(this.file, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
    w.configure('busyTimeout', BUSY_TIMEOUT_MS);
    this.writer = new SqliteQuery(w, DIALECT);
    await this.writer.exec('PRAGMA journal_mode = WAL');
    await this.writer.exec('PRAGMA synchronous = NORMAL');
    for (let i = 0; i < READERS; i++) {
      // read-write connections that only read: a read-only one may not see a schema change
      // another connection makes (library/sqlite-pool.js)
      const r = await openConnection(this.file, sqlite3.OPEN_READWRITE);
      r.configure('busyTimeout', BUSY_TIMEOUT_MS);
      const q = new SqliteQuery(r, DIALECT);
      this.readers.push(q);
      this.free.push(q);
    }
  }

  acquire() {
    if (this.free.length > 0) {
      return Promise.resolve(this.free.pop());
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release(q) {
    const next = this.waiting.shift();
    if (next) {
      next(q);
    } else {
      this.free.push(q);
    }
  }

  /**
   * Run fn with a connection for reading.
   * @param {function(SqliteQuery): Promise<*>} fn
   */
  async read(fn) {
    const q = await this.acquire();
    try {
      return await fn(q);
    } finally {
      this.release(q);
    }
  }

  /**
   * Run fn in a write transaction: committed if it returns, rolled back if it throws, and run
   * again if the database is busy or fn throws an error marked retryable.
   * @param {function(SqliteQuery): Promise<*>} fn
   */
  write(fn) {
    const run = async () => {
      let attempt = 0;
      for (;;) {
        attempt++;
        const q = this.writer;
        try {
          await q.exec('BEGIN IMMEDIATE');
        } catch (err) {
          if (err.busy && attempt < WRITE_RETRIES) {
            await delay(attempt * 50);
            continue;
          }
          throw err;
        }
        q.inTransaction = true;
        try {
          const result = await fn(q);
          await q.exec('COMMIT');
          return result;
        } catch (err) {
          try {
            await q.exec('ROLLBACK');
          } catch (ignore) {
            // the transaction may already be gone
          }
          if ((err.busy || err.retryable) && attempt < WRITE_RETRIES) {
            await delay(attempt * 50);
            continue;
          }
          throw err;
        } finally {
          q.inTransaction = false;
        }
      }
    };
    // one transaction at a time on the write connection
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Give the space of what was deleted back to the file system (after a reset: rest/maintenance.js),
   * on the write connection, outside any transaction
   */
  vacuum() {
    const run = () => this.writer.exec('VACUUM');
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Run fn holding the schema lock: for SQLite, a write transaction (DDL is transactional).
   */
  async withSchemaLock(fn) {
    return this.write(fn);
  }

  async close() {
    const all = [this.writer, ...this.readers].filter(q => q);
    await Promise.all(all.map(q => new Promise((resolve) => q.db.close(() => resolve()))));
    this.readers = [];
    this.free = [];
    this.writer = null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { SqliteDatabase };
