const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const folders = require('./library/folder-setup');

/**
 * Persistent storage for the server's request statistics (issue #255).
 *
 * The in-memory counters in ServerStats reset every time the server restarts,
 * which makes them useless for anything but "what has happened since the last
 * deploy". This class writes them to a SQLite database that outlives restarts
 * and upgrades.
 *
 * One row per (module, endpoint, operation) per collection interval, holding
 * both numbers:
 *
 *  - the *delta*: what happened in that interval. This is what you graph -
 *    plot count_delta against time and you have requests per interval without
 *    any differencing at the query end.
 *  - the *total*: the all-time cumulative count, carried across restarts by
 *    reloading it at startup. This is what you quote as "how much has this
 *    endpoint ever been asked to do", and it means a restart shows up as a
 *    flat spot in the graph rather than a cliff back to zero.
 *
 * Rows are only written for keys that saw traffic in the interval, so idle
 * endpoints cost nothing. Nothing is pruned: at 10 minute intervals a
 * continuously busy (endpoint, operation) pair produces ~52,000 rows a year,
 * which SQLite does not notice.
 *
 * better-sqlite3 (rather than sqlite3) on purpose: the writes are synchronous,
 * so the final flush in ServerStats.finishStats() lands on disk before
 * server.js calls process.exit(). A handful of inserts every ten minutes is
 * well under a millisecond, so this does not put the event loop at risk.
 */
class StatsDatabase {

  constructor(config, log) {
    this.log = log || console;
    this.config = config || {};
    this.db = null;
    this.path = StatsDatabase.resolvePath(this.config);
  }

  /**
   * Where the database lives: config.database if given (relative paths resolve
   * under the data folder's databases directory), otherwise stats.db there.
   */
  static resolvePath(config) {
    const configured = config && config.database;
    if (!configured) {
      return path.join(folders.databasesDir(), 'stats.db');
    }
    return path.isAbsolute(configured) ? configured : path.join(folders.databasesDir(), configured);
  }

  /**
   * Open the database, creating the file and the schema if they aren't there.
   */
  open() {
    fs.mkdirSync(path.dirname(this.path), {recursive: true});
    this.db = new Database(this.path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS request_counts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time INTEGER NOT NULL,
        interval_ms INTEGER NOT NULL,
        module TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        operation TEXT NOT NULL,
        count_delta INTEGER NOT NULL,
        count_total INTEGER NOT NULL,
        time_delta INTEGER NOT NULL,
        time_total INTEGER NOT NULL
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_request_counts_time ON request_counts(time)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_request_counts_key ON request_counts(module, endpoint, operation, id)`);

    // One row per run of the server: when it started serving, and the last
    // time it was known to be alive. See ServerStats.overallUptime().
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS server_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        version TEXT
      )
    `);
    // version was added after the table first shipped
    if (!this.db.prepare(`PRAGMA table_info(server_runs)`).all().some(c => c.name === 'version')) {
      this.db.exec(`ALTER TABLE server_runs ADD COLUMN version TEXT`);
    }
    this.touchRunStatement = this.db.prepare(`UPDATE server_runs SET last_seen = ? WHERE id = ?`);

    this.insertStatement = this.db.prepare(`
      INSERT INTO request_counts
        (time, interval_ms, module, endpoint, operation, count_delta, count_total, time_delta, time_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertAll = this.db.transaction((time, intervalMs, rows) => {
      for (const row of rows) {
        this.insertStatement.run(time, intervalMs, row.module, row.endpoint, row.operation,
          row.countDelta, row.countTotal, row.timeDelta, row.timeTotal);
      }
    });
    return this;
  }

  /**
   * The most recent cumulative total for each key, so counting resumes where
   * the last run left off instead of starting again from zero.
   */
  loadTotals() {
    if (!this.db) {
      return [];
    }
    return this.db.prepare(`
      SELECT module, endpoint, operation, count_total AS countTotal, time_total AS timeTotal
      FROM request_counts
      WHERE id IN (SELECT MAX(id) FROM request_counts GROUP BY module, endpoint, operation)
    `).all();
  }

  /**
   * Record that a new run of the server has started serving, and return its
   * row id for touchRun().
   */
  startRun(now, version = null) {
    if (!this.db) {
      return null;
    }
    return this.db.prepare(`INSERT INTO server_runs (started, last_seen, version) VALUES (?, ?, ?)`).run(now, now, version).lastInsertRowid;
  }

  /**
   * The runs that were alive at any point since `since`, oldest first, plus
   * the last run that ended before then (so a caller can tell whether the
   * first run in the period was an upgrade). Each is {id, started, lastSeen,
   * version}.
   */
  loadRuns(since) {
    if (!this.db) {
      return [];
    }
    const before = this.db.prepare(`
      SELECT id, started, last_seen AS lastSeen, version FROM server_runs
      WHERE last_seen < ? ORDER BY last_seen DESC LIMIT 1
    `).get(since);
    const during = this.db.prepare(`
      SELECT id, started, last_seen AS lastSeen, version FROM server_runs
      WHERE last_seen >= ? ORDER BY started
    `).all(since);
    return before ? [before, ...during] : during;
  }

  /**
   * The server is still alive: move the run's last_seen forward.
   */
  touchRun(runId, now) {
    if (this.db && runId != null) {
      this.touchRunStatement.run(now, runId);
    }
  }

  /**
   * How long the server has been running over all the runs recorded before
   * this one: the earliest start, and the total time between each run's start
   * and the last time it was seen alive. {firstStart: null, runningMs: 0} if
   * there are no earlier runs.
   */
  loadRunHistory(excludeRunId) {
    if (!this.db) {
      return {firstStart: null, runningMs: 0};
    }
    const row = this.db.prepare(`
      SELECT MIN(started) AS firstStart, COALESCE(SUM(last_seen - started), 0) AS runningMs
      FROM server_runs
      WHERE id IS NOT ?
    `).get(excludeRunId == null ? -1 : excludeRunId);
    return {firstStart: row.firstStart, runningMs: row.runningMs};
  }

  /**
   * The requests counted against a module in (since, now], by endpoint and
   * operation: [{endpoint, operation, count}]. A row is attributed to the
   * time it was written, so the edges of the period are as fine as the
   * collection interval (and ServerStats.flushNow() sharpens the near edge).
   */
  countsSince(since, now, module) {
    if (!this.db) {
      return [];
    }
    return this.db.prepare(`
      SELECT endpoint, operation, SUM(count_delta) AS count
      FROM request_counts
      WHERE module = ? AND time > ? AND time <= ?
      GROUP BY endpoint, operation
    `).all(module, since, now);
  }

  /**
   * Write one interval's worth of rows. All or nothing - if the transaction
   * fails the caller keeps its deltas and tries again next interval.
   */
  write(time, intervalMs, rows) {
    if (this.db && rows && rows.length > 0) {
      this.insertAll(time, intervalMs, rows);
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = StatsDatabase;
