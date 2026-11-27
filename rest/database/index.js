//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The rest module's database interface. Everything else in the module talks to the
 * database through this, the same way for SQLite and MySQL:
 *
 *   await db.read(async (q) => { ... })    a connection for reading
 *   await db.write(async (q) => { ... })   a transaction: committed if the function returns,
 *                                          rolled back if it throws, and run again on a
 *                                          deadlock, a busy database, or an error marked
 *                                          `retryable`
 *   q.all(sql, params) / q.get(sql, params) / q.run(sql, params) -> { changes, lastId }
 *
 * SQL uses `?` placeholders, and is the same for both engines except where it goes through
 * q.dialect (insertIgnore, concat). Errors from a unique index violation have `unique` set.
 *
 * @module rest/database
 */

const path = require('path');
const fs = require('fs');
const { SqliteDatabase } = require('./sqlite');
const { MysqlDatabase } = require('./mysql');
const { migrate, waitForSchema, SCHEMA_VERSION } = require('./schema');

/**
 * The MySQL password: from the environment variable passwordEnv names, or the file
 * passwordFile names. Never from config.json itself.
 * @param {Object} cfg - the endpoint's database configuration
 */
function mysqlPassword(cfg) {
  if (cfg.passwordEnv) {
    const v = process.env[cfg.passwordEnv];
    if (v === undefined) {
      throw new Error(`The database password environment variable ${cfg.passwordEnv} is not set`);
    }
    return v;
  }
  if (cfg.passwordFile) {
    return fs.readFileSync(cfg.passwordFile, 'utf8').replace(/\r?\n$/, '');
  }
  if (cfg.password !== undefined) {
    throw new Error('Database passwords don\'t go in config.json: use passwordEnv or passwordFile');
  }
  return undefined;
}

/**
 * Open an endpoint's database.
 * @param {Object} cfg - { type: 'sqlite', file } or { type: 'mysql', host, port, database, user, passwordEnv | passwordFile, connections }
 * @param {Object} options
 * @param {string} options.databasesDir - where a relative SQLite file goes
 * @param {boolean} [options.master] - bring the schema up to date (else wait for it)
 * @param {number} [options.schemaWaitMs] - how long to wait for it (not the master)
 * @param {function(string)} [options.log]
 */
async function openDatabase(cfg, options = {}) {
  if (!cfg || !cfg.type) {
    throw new Error('An endpoint needs a database: { "type": "sqlite", "file": ... } or { "type": "mysql", ... }');
  }
  let db;
  if (cfg.type === 'sqlite') {
    if (!cfg.file) {
      throw new Error('A sqlite database needs a file');
    }
    const file = path.isAbsolute(cfg.file) ? cfg.file : path.join(options.databasesDir || '.', cfg.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new SqliteDatabase(file);
  } else if (cfg.type === 'mysql') {
    if (!cfg.database || !cfg.user) {
      throw new Error('A mysql database needs a database and a user');
    }
    db = new MysqlDatabase({ ...cfg, password: mysqlPassword(cfg) });
  } else {
    throw new Error(`Unknown database type '${cfg.type}': use sqlite or mysql`);
  }
  await db.open();
  try {
    if (options.master !== false) {
      await migrate(db, options.log);
    } else {
      await waitForSchema(db, options.schemaWaitMs);
    }
  } catch (err) {
    await db.close();
    throw err;
  }
  return db;
}

module.exports = { openDatabase, SCHEMA_VERSION };
