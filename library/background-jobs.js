//
// Which process runs the background jobs.
//
// A background job is work the server does on a timer rather than for a request,
// and that writes state other processes share: the VSAC refresh, the package
// crawler, the XIG download, the registry crawl, the publisher's task queue, the
// daily report, retention purges. With one server process they simply run. With
// several processes on one data directory (cluster mode, see cluster.js) each of
// them would run every job, so they would download, crawl and write the same files
// and databases at the same time, and send the daily report N times.
//
// So when more than one process may share the data directory, exactly one of them
// runs the jobs: whichever holds the lock. Every job asks backgroundJobs.isLeader()
// each time its timer fires (not once at start-up), so when the holder stops - it
// exits, crashes, or hangs - another process takes over at its next tick.
//
// The lock is a small SQLite file in the data directory (background-jobs.lock): a
// single row naming the holder, which the holder renews every minute. Another
// process may take the row over only when it hasn't been renewed for staleMs (3
// minutes by default). Taking it over is one BEGIN IMMEDIATE transaction, so two
// processes can never both win. Like the resource cache, the file must be on a
// local disk.
//
// With no lock configured (a single server process, the default) isLeader() is
// always true and nothing is written.
//

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_STALE_MS = 3 * 60 * 1000;
const LOCK_NAME = 'background-jobs';

class BackgroundJobs {
  constructor() {
    this.enabled = false;
    this.db = null;
    this.file = null;
    this.staleMs = DEFAULT_STALE_MS;
    this.id = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
    this.leading = false;
    this.renewTimer = null;
    this.log = null;
  }

  /**
   * Turn the lock on (or leave it off).
   * @param {Object} options
   * @param {boolean} options.enabled - true when several processes may share the data directory
   * @param {string} [options.path] - the lock file (default <data>/background-jobs.lock)
   * @param {number} [options.staleMs] - how long the holder may go without renewing before another process may take over
   * @param {Object} [options.log] - logger
   */
  configure(options = {}) {
    this.close();
    this.enabled = !!options.enabled;
    this.log = options.log || null;
    if (!this.enabled) {
      return this;
    }
    this.staleMs = options.staleMs > 0 ? options.staleMs : DEFAULT_STALE_MS;
    this.file = options.path || require('./folder-setup').filePath('background-jobs.lock');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const Database = require('better-sqlite3');
    this.db = new Database(this.file);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS holder (
        name TEXT PRIMARY KEY, holder TEXT NOT NULL, pid INTEGER, host TEXT,
        since INTEGER NOT NULL, renewed INTEGER NOT NULL)`);
    }).immediate();
    this.q = {
      get: this.db.prepare('SELECT * FROM holder WHERE name = ?'),
      put: this.db.prepare(`INSERT INTO holder (name, holder, pid, host, since, renewed) VALUES (@name, @holder, @pid, @host, @since, @renewed)
        ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, pid = excluded.pid, host = excluded.host,
          since = excluded.since, renewed = excluded.renewed`),
      release: this.db.prepare('DELETE FROM holder WHERE name = ? AND holder = ?')
    };
    return this;
  }

  /**
   * Should this process run the background jobs right now? Always true without a
   * lock. With one: true if this process holds the lock, or has just taken it over
   * because its holder stopped renewing it.
   * @returns {boolean}
   */
  isLeader() {
    if (!this.enabled) {
      return true;
    }
    let leading = false;
    try {
      leading = this._acquire(Date.now());
    } catch (e) {
      // can't tell: don't risk two processes running the jobs
      this._info(`background jobs: could not check the lock (${e.message}); not running them this time`);
      leading = false;
    }
    this._setLeading(leading);
    return leading;
  }

  _acquire(now) {
    // the common case for a process that isn't the holder: a read, no write lock
    const seen = this.q.get.get(LOCK_NAME);
    if (seen && seen.holder !== this.id && seen.renewed >= now - this.staleMs) {
      return false;
    }
    return this.db.transaction(() => {
      const row = this.q.get.get(LOCK_NAME);
      const mine = row && row.holder === this.id;
      if (row && !mine && row.renewed >= now - this.staleMs) {
        return false;
      }
      if (row && !mine) {
        this._info(`background jobs: taking over from ${row.host} pid ${row.pid}, which last renewed the lock ${Math.round((now - row.renewed) / 1000)} s ago`);
      }
      this.q.put.run({
        name: LOCK_NAME, holder: this.id, pid: process.pid, host: os.hostname(),
        since: mine ? row.since : now, renewed: now
      });
      return true;
    }).immediate();
  }

  _setLeading(leading) {
    if (leading && !this.leading) {
      this._info(`background jobs: this process (pid ${process.pid}) runs them`);
      // renew well inside staleMs, so a busy but healthy holder keeps the lock
      this.renewTimer = setInterval(() => {
        try {
          this._setLeading(this._acquire(Date.now()));
        } catch (e) {
          this._info(`background jobs: could not renew the lock: ${e.message}`);
        }
      }, Math.max(1000, Math.floor(this.staleMs / 3)));
      if (this.renewTimer.unref) {
        this.renewTimer.unref();
      }
    } else if (!leading && this.leading) {
      this._info(`background jobs: another process has taken them over`);
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    this.leading = leading;
  }

  /**
   * Who holds the lock (for status pages and logs). Null without a lock.
   * @returns {{holder: string, pid: number, host: string, since: number, renewed: number, me: boolean}|null}
   */
  holder() {
    if (!this.enabled) {
      return null;
    }
    const row = this.q.get.get(LOCK_NAME);
    return row ? { holder: row.holder, pid: row.pid, host: row.host, since: row.since, renewed: row.renewed, me: row.holder === this.id } : null;
  }

  _info(msg) {
    if (this.log) {
      this.log.info(msg);
    }
  }

  /**
   * Give the lock up (on shutdown), so another process can take over at once
   * rather than after staleMs.
   */
  close() {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    if (this.db) {
      try {
        if (this.leading) {
          this.q.release.run(LOCK_NAME, this.id);
        }
        this.db.close();
      } catch (e) {
        // best effort
      }
      this.db = null;
    }
    this.leading = false;
    this.enabled = false;
  }
}

// one per process
const backgroundJobs = new BackgroundJobs();
module.exports = backgroundJobs;
module.exports.BackgroundJobs = BackgroundJobs;
