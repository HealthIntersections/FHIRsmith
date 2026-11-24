//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The MySQL implementation of the rest module's database interface (database/index.js),
 * through `mysql2` with a connection pool.
 *
 * Transactions run at READ COMMITTED, to avoid the gap locks REPEATABLE READ takes on index
 * ranges, which cause deadlocks between concurrent writers. A deadlock (1213) or lock wait
 * timeout (1205) runs the whole transaction again, as does an error marked retryable.
 *
 * @module rest/database/mysql
 */

const mysql = require('mysql2/promise');

const WRITE_RETRIES = 4;
const ER_LOCK_DEADLOCK = 1213;
const ER_LOCK_WAIT_TIMEOUT = 1205;
const ER_DUP_ENTRY = 1062;

class MysqlQuery {
  constructor(conn, dialect) {
    this.conn = conn;
    this.dialect = dialect;
    this.inTransaction = false;
    this.locks = [];
  }

  /**
   * Take a named lock (GET_LOCK) for the rest of the transaction: released after the commit
   * or rollback. For conditional creates, where two requests could both find nothing.
   * @param {string} name
   */
  async lock(name) {
    const [rows] = await this.conn.query('SELECT GET_LOCK(?, 30) AS got', [name]);
    if (!rows[0] || Number(rows[0].got) !== 1) {
      const e = new Error(`Unable to get the lock ${name}`);
      e.busy = true;
      throw e;
    }
    this.locks.push(name);
  }

  async releaseLocks() {
    for (const name of this.locks.splice(0)) {
      try {
        await this.conn.query('SELECT RELEASE_LOCK(?)', [name]);
      } catch (ignore) {
        // the connection may be gone, and the lock with it
      }
    }
  }

  async all(sql, params = []) {
    try {
      const [rows] = await this.conn.query(sql, params);
      return rows;
    } catch (err) {
      throw wrapError(err, sql);
    }
  }

  async get(sql, params = []) {
    const rows = await this.all(sql, params);
    return rows[0];
  }

  async run(sql, params = []) {
    try {
      const [res] = await this.conn.query(sql, params);
      return { changes: res.affectedRows, lastId: res.insertId };
    } catch (err) {
      throw wrapError(err, sql);
    }
  }

  async exec(sql) {
    try {
      await this.conn.query(sql);
    } catch (err) {
      throw wrapError(err, sql);
    }
  }
}

function wrapError(err, sql) {
  if (err && err.errno === ER_DUP_ENTRY) {
    err.unique = true;
  }
  if (err && (err.errno === ER_LOCK_DEADLOCK || err.errno === ER_LOCK_WAIT_TIMEOUT)) {
    err.busy = true;
  }
  if (err && sql && !err.sql) {
    err.sql = sql;
  }
  return err;
}

const DIALECT = {
  name: 'mysql',
  insertIgnore: (table, cols) => `INSERT IGNORE INTO ${table} (${cols.join(', ')}) VALUES `,
  concat: (a, b) => `CONCAT(${a}, ${b})`,
  // locks the rows a write reads, so concurrent writers to one resource queue rather than retry
  forUpdate: ' FOR UPDATE',
  maxParams: 60000
};

class MysqlDatabase {
  /**
   * @param {Object} cfg - host, port, database, user, password, connections
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.dialect = DIALECT;
    this.pool = null;
  }

  async open() {
    this.pool = mysql.createPool({
      host: this.cfg.host || 'localhost',
      port: this.cfg.port || 3306,
      user: this.cfg.user,
      password: this.cfg.password,
      database: this.cfg.database,
      connectionLimit: this.cfg.connections || 10,
      charset: 'utf8mb4',
      supportBigNumbers: true,
      bigNumberStrings: false,
      decimalNumbers: true,
      multipleStatements: false,
      timezone: 'Z'
    });
    // fail now, not on the first request, if the server can't be reached
    const conn = await this.pool.getConnection();
    conn.release();
  }

  async read(fn) {
    const conn = await this.pool.getConnection();
    try {
      return await fn(new MysqlQuery(conn, DIALECT));
    } finally {
      conn.release();
    }
  }

  async write(fn) {
    let attempt = 0;
    for (;;) {
      attempt++;
      const conn = await this.pool.getConnection();
      const q = new MysqlQuery(conn, DIALECT);
      try {
        await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await conn.beginTransaction();
        q.inTransaction = true;
        const result = await fn(q);
        await conn.commit();
        return result;
      } catch (err) {
        try {
          await conn.rollback();
        } catch (ignore) {
          // the connection may be gone
        }
        const e = wrapError(err);
        if ((e.busy || e.retryable) && attempt < WRITE_RETRIES) {
          await delay(attempt * 50 + Math.floor(Math.random() * 50));
          continue;
        }
        throw e;
      } finally {
        q.inTransaction = false;
        await q.releaseLocks();
        conn.release();
      }
    }
  }

  /**
   * Run fn holding the schema lock (a named lock, since MySQL's DDL isn't transactional),
   * with a connection outside any transaction.
   */
  async withSchemaLock(fn) {
    const conn = await this.pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT GET_LOCK(?, 120) AS got', ['fhirsmith_rest_schema']);
      if (!rows[0] || rows[0].got !== 1) {
        throw new Error('Unable to get the schema lock on the database within 2 minutes');
      }
      try {
        return await fn(new MysqlQuery(conn, DIALECT));
      } finally {
        await conn.query('SELECT RELEASE_LOCK(?)', ['fhirsmith_rest_schema']);
      }
    } finally {
      conn.release();
    }
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { MysqlDatabase };
