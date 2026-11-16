// library/sqlite-pool.js
//
// Several connections to one SQLite file, used as one, each running one query at a time.
//
// Why one at a time. A sqlite3 connection runs one query at a time whatever is asked of it: get()
// and all() take the connection's mutex for the whole query (node-sqlite3 src/statement.cc,
// Work_Get / Work_All), on a libuv thread. Worse, Database#get and #all finalize their statement
// afterwards ON THE MAIN THREAD (lib/sqlite3.js: statement.get(...).finalize(); Statement::Finalize_
// calls sqlite3_finalize, which takes the same mutex). So when a quick query finishes while a slow
// one has started on the same connection, the event loop waits for the slow one to end. On
// npm.fhir.org (2026-11-16) a crawler paging deep into the XIG's list (offset 225000: 2 s of
// sorting) held the whole server for 2-6 s at a time, over and over, while every other XIG
// request finalized on the same connection. And a query waiting for the mutex waits ON a libuv
// thread, so a queue of them also holds the threads the rest of the server needs.
//
// So the pool never gives a connection a query while it is still running one (or finalizing it):
// a query waits here, in a queue, for the first connection that is free. Several connections, so
// a slow query only holds up the others when every connection is busy - and then they wait
// without holding the event loop or a thread.
//
// For reading: there is no telling which connection a query runs on, so nothing that needs one
// connection (a transaction, a temporary table, a PRAGMA meant to stay set) goes through it;
// `configure` is run on every connection as it opens, for the PRAGMAs that should. The
// connections are opened read-only unless `mode` says otherwise: a database another connection is
// writing to (WAL) is better read through read-write connections that only read, as a read-only
// one may not see a schema change the writer makes (tx/vs/vs-database.js).
//
// get(sql, [params], callback) and all(sql, [params], callback) are as sqlite3.Database's, and
// close(callback) closes every connection, so a pool goes where a Database that is only read went.

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
    this.connections = connections.map(db => ({ db, busy: false }));
    this.queue = []; // queries waiting for a connection: {method, sql, params, callback}
    this.closed = false;
  }

  /** How many connections */
  get size() {
    return this.connections.length;
  }

  /** How many queries are in hand: running, and waiting for a connection */
  get pending() {
    return this.queue.length + this.connections.filter(c => c.busy).length;
  }

  get(sql, params, callback) {
    return this.#enqueue('get', sql, params, callback);
  }

  all(sql, params, callback) {
    return this.#enqueue('all', sql, params, callback);
  }

  /**
   * Close every connection, once the queries running on them are done; queries still waiting
   * for one fail. callback(err): the first error any connection gave on closing, or null
   */
  close(callback) {
    this.closed = true;
    for (const q of this.queue.splice(0)) {
      fail(q.callback);
    }
    let left = this.connections.length;
    let first = null;
    for (const c of this.connections) {
      // sqlite3 runs the close after what the connection already has in hand
      c.db.close((err) => {
        first = first || err || null;
        if (--left === 0 && callback) {
          callback(first);
        }
      });
    }
  }

  #enqueue(method, sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    if (this.closed) {
      fail(callback);
      return this;
    }
    this.queue.push({ method, sql, params: params ?? [], callback });
    this.#dispatch();
    return this;
  }

  // give waiting queries to free connections
  #dispatch() {
    for (const c of this.connections) {
      if (this.queue.length === 0) {
        return;
      }
      if (!c.busy && !this.closed) {
        this.#start(c, this.queue.shift());
      }
    }
  }

  // A statement of its own, finalized before the connection is given another: Database#get and
  // #all finalize theirs some time after their callback, on this thread, and a finalize that
  // comes once the next query has the connection waits, holding the event loop, for that query
  // to end. The answer is passed on once the statement is finalized.
  #start(c, q) {
    c.busy = true;
    let error = null;
    let result;
    const done = () => {
      c.busy = false;
      if (q.callback) {
        q.callback(error, result);
      }
      this.#dispatch();
    };
    const statement = c.db.prepare(q.sql, (err) => {
      if (err) {
        // not prepared: sqlite3 has finalized it already, and calls nothing else
        error = err;
        done();
      }
    });
    // positional parameters as arguments; named ones ({$id: 1}) as the one object
    const args = Array.isArray(q.params) ? q.params : [q.params];
    statement[q.method](...args, (err, value) => {
      error = error || err;
      result = value;
    });
    statement.finalize(() => done());
  }
}

function fail(callback) {
  if (callback) {
    const err = new Error('SQLITE_MISUSE: Database is closed');
    err.code = 'SQLITE_MISUSE';
    process.nextTick(() => callback(err));
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
