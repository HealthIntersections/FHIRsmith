// library/sqlite-session-store.js
// An express-session store kept in a table of an already-open sqlite3 database.
//
// This replaces connect-sqlite3, which depends on sqlite3 ^5 and so brought a second, old
// copy of sqlite3 (and with it node-gyp 8 and tar 6) into every npm install of FHIRsmith.
// Our package.json "overrides" hid that from npm audit in the repo, but npm ignores
// overrides for anyone installing the published package.
//
// The table layout is the one connect-sqlite3 used - (sid PRIMARY KEY, expired, sess),
// with expired in epoch ms and sess as JSON - so sessions in an existing database carry over.

const session = require('express-session');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

class SqliteSessionStore extends session.Store {
  /**
   * @param {object} options
   * @param {object} options.db - an open sqlite3 Database; the caller owns it and closes it
   * @param {string} [options.table='sessions']
   * @param {number} [options.cleanupIntervalMs=one day] - how often expired sessions are deleted
   */
  constructor(options = {}) {
    super();
    if (!options.db) {
      throw new Error('SqliteSessionStore needs an open sqlite3 database');
    }
    const table = options.table || 'sessions';
    if (!TABLE_NAME.test(table)) {
      throw new Error('Invalid session table name: ' + table);
    }
    this.db = options.db;
    this.table = table;
    this.timer = null;
    this.ready = this.run(`CREATE TABLE IF NOT EXISTS ${table} (sid PRIMARY KEY, expired, sess)`)
      .then(() => this.cleanup());
    this.ready.catch(() => { /* reported by the first operation that waits on it */ });
    const interval = options.cleanupIntervalMs > 0 ? options.cleanupIntervalMs : ONE_DAY_MS;
    this.timer = setInterval(() => void this.cleanup().catch(() => {}), interval);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this);
        }
      });
    });
  }

  query(method, sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db[method](sql, params, (err, result) => err ? reject(err) : resolve(result));
    });
  }

  // adapt a promise to express-session's callback style
  done(promise, cb) {
    promise.then(result => cb && cb(null, result), err => cb && cb(err));
  }

  cleanup() {
    return this.run(`DELETE FROM ${this.table} WHERE expired < ?`, [Date.now()]);
  }

  static expiry(sess) {
    if (sess && sess.cookie) {
      if (sess.cookie.expires) {
        const t = new Date(sess.cookie.expires).getTime();
        if (!isNaN(t)) {
          return t;
        }
      }
      if (sess.cookie.maxAge) {
        return Date.now() + sess.cookie.maxAge;
      }
    }
    return Date.now() + ONE_DAY_MS;
  }

  get(sid, cb) {
    this.done(this.ready
      .then(() => this.query('get', `SELECT sess FROM ${this.table} WHERE sid = ? AND expired >= ?`, [sid, Date.now()]))
      .then(row => row ? JSON.parse(row.sess) : null), cb);
  }

  set(sid, sess, cb) {
    this.done(this.ready
      .then(() => this.run(`INSERT OR REPLACE INTO ${this.table} (sid, expired, sess) VALUES (?, ?, ?)`,
        [sid, SqliteSessionStore.expiry(sess), JSON.stringify(sess)]))
      .then(() => undefined), cb);
  }

  touch(sid, sess, cb) {
    this.done(this.ready
      .then(() => this.run(`UPDATE ${this.table} SET expired = ? WHERE sid = ? AND expired >= ?`,
        [SqliteSessionStore.expiry(sess), sid, Date.now()]))
      .then(() => undefined), cb);
  }

  destroy(sid, cb) {
    this.done(this.ready
      .then(() => this.run(`DELETE FROM ${this.table} WHERE sid = ?`, [sid]))
      .then(() => undefined), cb);
  }

  length(cb) {
    this.done(this.ready
      .then(() => this.query('get', `SELECT COUNT(*) AS count FROM ${this.table} WHERE expired >= ?`, [Date.now()]))
      .then(row => row.count), cb);
  }

  clear(cb) {
    this.done(this.ready.then(() => this.run(`DELETE FROM ${this.table}`)).then(() => undefined), cb);
  }

  /** Stop the cleanup timer. The database itself belongs to the caller. */
  close() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = { SqliteSessionStore };
