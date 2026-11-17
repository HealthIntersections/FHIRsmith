//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Runs a report's SQL statements, and reads its table, for one project.
 *
 * Each report table holds the rows of every project; a statement is written without saying
 * which project it is for. So before the statements run, each report table gets a TEMP VIEW of
 * the same name holding only the project's rows - SQLite finds a TEMP name before a main one -
 * and the statements see only the project's data, joins between reports included.
 *
 * better-sqlite3 runs a statement synchronously, to the end, and cannot interrupt it: a
 * statement that takes a minute holds the server for a minute. A worker thread doesn't help -
 * terminating one waits for the native call to return, which a runaway statement never does. So
 * the statements run here, in a child process, on a read-only connection of its own, and the
 * caller kills the process when it takes too long (reports.js). Only statements that read are
 * run (a statement better-sqlite3 says is a reader: a SELECT), and only so many rows are kept.
 *
 * When the reports database is in memory (the tests), there is no file for another process to
 * open: runRequest() is called on the module's own connection, and the views are dropped afterwards.
 *
 * @module ips/reports-query
 */

function quote(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * @param {Object} db - a better-sqlite3 Database (read-only in a worker)
 * @param {Object} req
 * @param {number} req.projectId
 * @param {string[]} req.tables - the report tables that exist (all of them get the project's view)
 * @param {Array<{name: string, sql: string}>} [req.statements]
 * @param {number} req.maxRows - the most rows kept from a statement (more is reported as more: true)
 * @param {{table: string, limit: number}} [req.raw] - read this table's rows (and count them)
 * @returns {{statements: Array, raw: Object|null}}
 */
function runRequest(db, req) {
  const project = Number(req.projectId);
  if (!Number.isInteger(project)) {
    throw new Error('No project');
  }
  const created = [];
  try {
    for (const t of req.tables) {
      db.exec(`CREATE TEMP VIEW ${quote(t)} AS SELECT * FROM main.${quote(t)} WHERE _project = ${project}`);
      created.push(t);
    }
    const out = { statements: [], raw: null };
    for (const s of req.statements || []) {
      out.statements.push({ name: s.name, ...runStatement(db, s.sql, req.maxRows) });
    }
    if (req.raw) {
      const t = quote(req.raw.table);
      const total = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      const result = runStatement(db, `SELECT * FROM ${t} ORDER BY _document, ViewRowKey`, req.raw.limit);
      out.raw = { total, ...result };
    }
    return out;
  } finally {
    for (const t of created) {
      db.exec(`DROP VIEW IF EXISTS temp.${quote(t)}`);
    }
  }
}

function runStatement(db, sql, maxRows) {
  try {
    const stmt = db.prepare(sql);
    if (!stmt.reader) {
      return { error: 'Only statements that read (SELECT) can be run' };
    }
    stmt.raw(true);
    const columns = stmt.columns().map(c => c.name);
    const rows = [];
    let more = false;
    for (const row of stmt.iterate()) {
      if (rows.length >= maxRows) {
        more = true;
        break;
      }
      rows.push(row.map(cellValue));
    }
    return { columns, rows, more };
  } catch (e) {
    return { error: e.message };
  }
}

// what can go back across the thread boundary and into a page: buffers as text, bigints as numbers
function cellValue(v) {
  if (Buffer.isBuffer(v)) {
    return v.toString('utf8');
  }
  if (typeof v === 'bigint') {
    return Number(v);
  }
  return v;
}

// run as a child process (reports.js): one request, then exit
if (require.main === module && process.argv[2] === '--reports-query' && process.send) {
  process.once('message', ({ dbPath, request }) => {
    let reply;
    let db = null;
    try {
      const Database = require('better-sqlite3');
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      reply = { ok: true, result: runRequest(db, request) };
    } catch (e) {
      reply = { ok: false, error: e.message };
    } finally {
      if (db) {
        db.close();
      }
    }
    process.send(reply, () => process.exit(0));
  });
}

module.exports = { runRequest, quote };
