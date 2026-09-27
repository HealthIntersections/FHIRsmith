//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * SQLite storage for received TestReports.
 *
 * Each report is kept whole, as the JSON that was stored (with the server's id and
 * meta.lastUpdated), alongside the columns the searches use. Reports are never edited
 * once received, so there is no versioning. The submitter's IP address is recorded for
 * tracing abuse, and is never returned by anything in this module.
 *
 * @module testing/store
 */

const Database = require('better-sqlite3');
const { dateRange } = require('./search');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS reports (
    id           TEXT PRIMARY KEY,
    received     TEXT NOT NULL,      -- meta.lastUpdated
    received_ms  INTEGER NOT NULL,
    ip           TEXT,               -- never shared
    name         TEXT NOT NULL,
    name_lc      TEXT NOT NULL,
    status       TEXT NOT NULL,
    result       TEXT NOT NULL,
    score        REAL,
    tester       TEXT NOT NULL,
    tester_lc    TEXT NOT NULL,
    test_script  TEXT,
    issued       TEXT NOT NULL,
    issued_lo    INTEGER NOT NULL,
    issued_hi    INTEGER NOT NULL,
    size         INTEGER NOT NULL,
    run_ms       INTEGER,            -- how long the run took, when the report says
    test_count   INTEGER,            -- how many entries in TestReport.test
    json         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS participants (
    report_id    TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    type         TEXT,
    uri          TEXT NOT NULL,
    version      TEXT,
    display      TEXT
  );

  -- people who can maintain the named links and delete reports. The administrator is not
  -- in here: their password is in the configuration
  CREATE TABLE IF NOT EXISTS users (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    login               TEXT UNIQUE NOT NULL,
    name                TEXT NOT NULL,
    password_hash       TEXT NOT NULL,
    can_edit_links      INTEGER NOT NULL DEFAULT 0,
    can_delete_reports  INTEGER NOT NULL DEFAULT 0,
    created             TEXT NOT NULL
  );

  -- names (and links) shown in place of known canonical URLs
  CREATE TABLE IF NOT EXISTS links (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical   TEXT UNIQUE NOT NULL,   -- without any |version
    name        TEXT NOT NULL,
    link        TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_reports_received ON reports(received_ms);
  CREATE INDEX IF NOT EXISTS idx_reports_name ON reports(name_lc);
  CREATE INDEX IF NOT EXISTS idx_reports_tester ON reports(tester_lc);
  CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
  CREATE INDEX IF NOT EXISTS idx_reports_result ON reports(result);
  CREATE INDEX IF NOT EXISTS idx_reports_score ON reports(score);
  CREATE INDEX IF NOT EXISTS idx_reports_script ON reports(test_script);
  CREATE INDEX IF NOT EXISTS idx_reports_issued ON reports(issued_lo, issued_hi);
  CREATE INDEX IF NOT EXISTS idx_participants_report ON participants(report_id);
  CREATE INDEX IF NOT EXISTS idx_participants_uri ON participants(uri);
`;

/**
 * TestReport.testScript is a canonical in R5 and a Reference in R4; either way we want
 * the URL.
 */
function testScriptOf(report) {
  const ts = report.testScript;
  if (typeof ts === 'string') {
    return ts;
  }
  if (ts && typeof ts === 'object') {
    if (typeof ts.reference === 'string') {
      return ts.reference;
    }
    if (ts.identifier && typeof ts.identifier.value === 'string') {
      return ts.identifier.value;
    }
  }
  return null;
}

function str(v) {
  return typeof v === 'string' ? v : null;
}

/**
 * How long the run took, in milliseconds, if the report says: from the earliest
 * period.start to the latest period.end across its tests. null if no test has a period
 * with both ends.
 */
function runLengthOf(report) {
  let lo = null;
  let hi = null;
  for (const t of Array.isArray(report.test) ? report.test : []) {
    const p = t && typeof t === 'object' ? t.period : null;
    if (!p || typeof p !== 'object') {
      continue;
    }
    const s = typeof p.start === 'string' ? Date.parse(p.start) : NaN;
    const e = typeof p.end === 'string' ? Date.parse(p.end) : NaN;
    if (!Number.isNaN(s) && (lo === null || s < lo)) {
      lo = s;
    }
    if (!Number.isNaN(e) && (hi === null || e > hi)) {
      hi = e;
    }
  }
  return lo !== null && hi !== null && hi >= lo ? hi - lo : null;
}

/** How many tests the report has (entries in TestReport.test). */
function testCountOf(report) {
  return Array.isArray(report.test) ? report.test.length : 0;
}

/** A canonical URL without its |version. */
function unversioned(url) {
  return typeof url === 'string' && url.includes('|') ? url.substring(0, url.indexOf('|')) : url;
}

class TestReportStore {
  /**
   * @param {string} dbPath - file name, or ':memory:'
   */
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.migrate();
    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO reports (id, received, received_ms, ip, name, name_lc, status, result, score,
          tester, tester_lc, test_script, issued, issued_lo, issued_hi, size, run_ms, test_count, json)
        VALUES (@id, @received, @received_ms, @ip, @name, @name_lc, @status, @result, @score,
          @tester, @tester_lc, @test_script, @issued, @issued_lo, @issued_hi, @size, @run_ms, @test_count, @json)`),
      insertParticipant: this.db.prepare(
        'INSERT INTO participants (report_id, seq, type, uri, version, display) VALUES (?, ?, ?, ?, ?, ?)'),
      read: this.db.prepare('SELECT json FROM reports WHERE id = ?'),
      delete: this.db.prepare('DELETE FROM reports WHERE id = ?'),
      purge: this.db.prepare('DELETE FROM reports WHERE received_ms < ?'),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM reports')
    };
  }

  /** Bring a database made by an earlier version of the module up to date. */
  migrate() {
    const has = (table, col) => this.db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
    if (!has('participants', 'version')) {
      this.db.exec('ALTER TABLE participants ADD COLUMN version TEXT');
    }
    // columns worked out from the report: add them, and fill them in for the reports
    // already there
    const derived = [['run_ms', runLengthOf], ['test_count', testCountOf]];
    for (const [col, fn] of derived) {
      if (!has('reports', col)) {
        this.db.exec(`ALTER TABLE reports ADD COLUMN ${col} INTEGER`);
        const update = this.db.prepare(`UPDATE reports SET ${col} = ? WHERE id = ?`);
        this.db.transaction(() => {
          for (const row of this.db.prepare('SELECT id, json FROM reports').all()) {
            const v = fn(JSON.parse(row.json));
            if (v !== null) {
              update.run(v, row.id);
            }
          }
        })();
      }
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Store a report that has already been validated and given its id and meta.lastUpdated.
   *
   * @param {Object} report
   * @param {{ip?: string, receivedMs: number}} info
   */
  insert(report, info) {
    const json = JSON.stringify(report);
    const issued = dateRange(report.issued);
    const row = {
      id: report.id,
      received: report.meta.lastUpdated,
      received_ms: info.receivedMs,
      ip: info.ip || null,
      name: report.name,
      name_lc: report.name.toLowerCase(),
      status: report.status,
      result: report.result,
      score: typeof report.score === 'number' && Number.isFinite(report.score) ? report.score : null,
      tester: report.tester,
      tester_lc: report.tester.toLowerCase(),
      test_script: testScriptOf(report),
      issued: report.issued,
      issued_lo: issued.lo,
      issued_hi: issued.hi,
      size: Buffer.byteLength(json, 'utf8'),
      run_ms: runLengthOf(report),
      test_count: testCountOf(report),
      json
    };
    this.db.transaction(() => {
      this.stmts.insert.run(row);
      report.participant.forEach((p, i) => {
        this.stmts.insertParticipant.run(report.id, i, str(p.type), p.uri, str(p.version), str(p.display));
      });
    })();
  }

  /** @returns {Object|null} the stored report */
  read(id) {
    const row = this.stmts.read.get(id);
    return row ? JSON.parse(row.json) : null;
  }

  /** @returns {boolean} whether there was such a report */
  delete(id) {
    return this.stmts.delete.run(id).changes > 0;
  }

  /** Delete reports received before the given time. @returns {number} how many */
  purgeBefore(ms) {
    return this.stmts.purge.run(ms).changes;
  }

  count() {
    return this.stmts.count.get().n;
  }

  /**
   * Run a parsed search (see search.js).
   *
   * @param {Object} search - from parseSearch
   * @param {{withJson?: boolean}} options - include the stored JSON (FHIR API), or just
   *   the columns the HTML list needs
   * @returns {{total: number, rows: Object[]}}
   */
  search(search, options = {}) {
    const where = search.where.length > 0 ? 'WHERE ' + search.where.join(' AND ') : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM reports r ${where}`).get(...search.args).n;
    if (search.summaryCount || search.count === 0) {
      return { total, rows: [] };
    }
    const cols = options.withJson
      ? 'r.id, r.json'
      : 'r.id, r.received, r.name, r.status, r.result, r.score, r.tester, r.test_script, r.issued, r.run_ms, r.test_count';
    const rows = this.db.prepare(
      `SELECT ${cols} FROM reports r ${where} ORDER BY ${search.orderBy} LIMIT ? OFFSET ?`
    ).all(...search.args, search.count, search.offset);
    if (!options.withJson && rows.length > 0) {
      const byId = new Map(rows.map(r => [r.id, r]));
      for (const r of rows) {
        r.participants = [];
      }
      const ph = rows.map(() => '?').join(',');
      const parts = this.db.prepare(
        `SELECT report_id, type, uri, version, display FROM participants WHERE report_id IN (${ph}) ORDER BY report_id, seq`
      ).all(...rows.map(r => r.id));
      for (const p of parts) {
        byId.get(p.report_id).participants.push(p);
      }
    }
    return { total, rows };
  }

  /** Whether any report has a participant of this type. */
  hasParticipantType(type) {
    return !!this.db.prepare('SELECT 1 FROM participants WHERE type = ? LIMIT 1').get(type);
  }

  // ---- named links ----

  /** @returns {Array<{id, canonical, name, link}>} sorted by name */
  links() {
    return this.db.prepare('SELECT id, canonical, name, link FROM links ORDER BY name COLLATE NOCASE, canonical').all();
  }

  /** Add a link, or replace the one for the same canonical. */
  saveLink(canonical, name, link) {
    this.db.prepare(`INSERT INTO links (canonical, name, link) VALUES (?, ?, ?)
      ON CONFLICT(canonical) DO UPDATE SET name = excluded.name, link = excluded.link`)
      .run(unversioned(canonical), name, link || null);
  }

  updateLink(id, canonical, name, link) {
    return this.db.prepare('UPDATE links SET canonical = ?, name = ?, link = ? WHERE id = ?')
      .run(unversioned(canonical), name, link || null, id).changes > 0;
  }

  deleteLink(id) {
    return this.db.prepare('DELETE FROM links WHERE id = ?').run(id).changes > 0;
  }

  // ---- users ----

  /** @returns {Array} users, without their password hashes */
  users() {
    return this.db.prepare('SELECT id, login, name, can_edit_links, can_delete_reports, created FROM users ORDER BY login').all();
  }

  /** @returns {Object|null} the user, including the password hash */
  userByLogin(login) {
    return this.db.prepare('SELECT * FROM users WHERE login = ?').get(login) || null;
  }

  userById(id) {
    return this.db.prepare('SELECT id, login, name, can_edit_links, can_delete_reports FROM users WHERE id = ?').get(id) || null;
  }

  createUser(login, name, passwordHash, rights) {
    this.db.prepare(`INSERT INTO users (login, name, password_hash, can_edit_links, can_delete_reports, created)
      VALUES (?, ?, ?, ?, ?, ?)`).run(login, name, passwordHash, rights.editLinks ? 1 : 0, rights.deleteReports ? 1 : 0,
      new Date().toISOString());
  }

  updateUser(id, name, rights, passwordHash) {
    const n = this.db.prepare('UPDATE users SET name = ?, can_edit_links = ?, can_delete_reports = ? WHERE id = ?')
      .run(name, rights.editLinks ? 1 : 0, rights.deleteReports ? 1 : 0, id).changes;
    if (n > 0 && passwordHash) {
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
    }
    return n > 0;
  }

  deleteUser(id) {
    return this.db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
  }

  /** The distinct values in a column, for filter drop-downs. */
  distinct(column) {
    if (!['status', 'result'].includes(column)) {
      throw new Error('Not a filterable column: ' + column);
    }
    return this.db.prepare(`SELECT DISTINCT ${column} AS v FROM reports ORDER BY ${column}`).all().map(r => r.v);
  }

  /**
   * How many reports each tester has sent, with how they came out, and when the latest
   * was received. Most reports first.
   *
   * @returns {Array<{tester: string, reports: number, pass: number, fail: number, other: number,
   *   latest: string}>}
   */
  testerCounts() {
    return this.db.prepare(`
      SELECT tester, COUNT(*) AS reports,
        SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) AS pass,
        SUM(CASE WHEN result = 'fail' THEN 1 ELSE 0 END) AS fail,
        SUM(CASE WHEN result NOT IN ('pass', 'fail') THEN 1 ELSE 0 END) AS other,
        MAX(received) AS latest
      FROM reports GROUP BY tester ORDER BY reports DESC, tester_lc`).all();
  }

  /**
   * The latest report for each test script against each participant (or tester): the
   * one with the latest issued date, then the latest received. Test engines are not
   * participants in this sense - the columns are the things that were tested.
   *
   * @param {'participant'|'tester'} by
   * @returns {Array<{test_script: string|null, col: string, id: string, name: string,
   *   result: string, score: number|null, issued: string, runs: number}>}
   */
  summary(by) {
    const source = by === 'tester'
      ? 'SELECT r.*, r.tester AS col FROM reports r'
      : `SELECT r.*, p.uri AS col FROM reports r
           JOIN (SELECT DISTINCT report_id, uri FROM participants
                 WHERE type IS NULL OR type <> 'test-engine') p ON p.report_id = r.id`;
    return this.db.prepare(`
      SELECT test_script, col, id, name, result, score, issued, runs FROM (
        SELECT s.*,
          COUNT(*) OVER (PARTITION BY s.test_script, s.col) AS runs,
          ROW_NUMBER() OVER (PARTITION BY s.test_script, s.col
                             ORDER BY s.issued_lo DESC, s.received_ms DESC) AS rn
        FROM (${source}) s
      ) WHERE rn = 1
      ORDER BY test_script, col`).all();
  }
}

module.exports = { TestReportStore, testScriptOf, runLengthOf, testCountOf, unversioned };
