// library/sqlite-pool.js
//
// Several read-only connections to one SQLite file, used as one.
//
// A sqlite3 connection runs one query at a time: get(), all() and each() take the connection's
// mutex for the whole query (node-sqlite3 src/statement.cc, Work_Get / Work_All), however many
// libuv threads there are. A query waiting for it waits ON a libuv thread, so a module with one
// connection runs its queries one after another, and a queue of slow ones also holds threads
// that the rest of the server needs (file reads, gzip, every other database). On npm.fhir.org
// (2026-11-16) a crawler's deep-offset XIG list pages queued behind one another on xig.js's one
// connection: a page that takes 50ms took 2-3 s.
//
// The pool keeps `size` connections open and gives each query to the connection with the fewest
// queries in hand. For reading: there is no telling which connection a query runs on, so nothing
// that needs one connection (a transaction, a temporary table, a PRAGMA meant to stay set) goes
// through it; `configure` is run on every connection as it opens, for the PRAGMAs that should.
// The connections are opened read-only unless `mode` says otherwise: a database another
// connection is writing to (WAL) is better read through read-write connections that only read,
// as a read-only one may not see a schema change the writer makes (tx/vs/vs-database.js).
//
// get(sql, [params], callback) and all(sql, [params], callback) are as sqlite3.Database's, and
// close(callback) closes every connection, so a pool goes where a read-only Database went.

const sqlite3 = require('sqlite3');

const DEFAULT_SIZE = 4;

class SqlitePool {

  /**
   * Open a pool. Resolves once every connection is open; rejects (closing those that did open)
   * if any can't be.
   *
   * @param {string} path - the database file
   * @param {object} [options]
   * @param {number} [options.size] - how many connections (default 4)
   * @param {number} [options.mode] - sqlite3 open flags (default sqlite3.OPEN_READONLY)
   * @param {function(sqlite3.Database): Promise<void>|void} [options.configure] - run on each
   *   connection once it is open (PRAGMAs and the like)
   * @returns {Promise<SqlitePool>}
   */
  static async open(path, options = {}) {
    const size = Number.isInteger(options.size) && options.size > 0 ? options.size : DEFAULT_SIZE;
    const opened = await Promise.allSettled(Array.from({ length: size }, () => openOne(path, options.mode ?? sqlite3.OPEN_READONLY, options.configure)));
    const connections = opened.filter(r => r.status === 'fulfilled').map(r => r.value);
    const failed = opened.find(r => r.status === 'rejected');
    if (failed) {
      await Promise.all(connections.map(db => new Promise(resolve => db.close(() => resolve()))));
      throw failed.reason;
    }
    return new SqlitePool(connections);
  }

  /**
   * @param {sqlite3.Database[]} connections - open connections (SqlitePool.open makes them)
   */
  constructor(connections) {
    if (!connections || connections.length === 0) {
      throw new Error('A pool needs at least one connection');
    }
    this.connections = connections.map(db => ({ db, pending: 0 }));
    this.closed = false;
  }

  /** How many connections */
  get size() {
    return this.connections.length;
  }

  /** How many queries are in hand, across the connections */
  get pending() {
    return this.connections.reduce((n, c) => n + c.pending, 0);
  }

  get(sql, params, callback) {
    return this.#run('get', sql, params, callback);
  }

  all(sql, params, callback) {
    return this.#run('all', sql, params, callback);
  }

  /**
   * Close every connection. callback(err): the first error any of them gave, or null
   */
  close(callback) {
    this.closed = true;
    let left = this.connections.length;
    let first = null;
    for (const c of this.connections) {
      c.db.close((err) => {
        first = first || err || null;
        if (--left === 0 && callback) {
          callback(first);
        }
      });
    }
  }

  // the least busy connection; the first of them, when it's a tie
  #pick() {
    let best = this.connections[0];
    for (const c of this.connections) {
      if (c.pending < best.pending) {
        best = c;
      }
    }
    return best;
  }

  #run(method, sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    if (this.closed) {
      const err = new Error('SQLITE_MISUSE: Database is closed');
      err.code = 'SQLITE_MISUSE';
      if (callback) {
        process.nextTick(() => callback(err));
      }
      return this;
    }
    const c = this.#pick();
    c.pending++;
    c.db[method](sql, params ?? [], function (err, result) {
      c.pending--;
      if (callback) {
        callback.call(this, err, result);
      }
    });
    return this;
  }
}

function openOne(path, mode, configure) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, mode, (err) => {
      if (err) {
        reject(err);
        return;
      }
      Promise.resolve(configure ? configure(db) : undefined).then(() => resolve(db), (e) => {
        db.close(() => reject(e));
      });
    });
  });
}

module.exports = { SqlitePool, DEFAULT_SIZE };
