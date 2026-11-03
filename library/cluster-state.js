//
// State that the server processes on one data directory share: login sessions,
// session-signing secrets and rate-limit counters.
//
// With one server process (the default) none of this is used: each module keeps its
// logins and rate-limit counts in memory as before, and a module without a
// configured sessionSecret makes up a random one at start-up. A single process can
// opt in with "server": {"sharedState": true}: logins then survive a restart, and a
// generated secret is kept in the data directory.
//
// With several (cluster mode, or separately started processes with the
// background-jobs lock turned on - see library/background-jobs.js) any process may
// get any request, so a login made on one has to be found by the next, a cookie
// signed by one has to verify on another, and a rate limit has to count the
// requests that all of them saw. All three live in one SQLite file in the data
// directory, cluster-state.db:
//
//   secrets      name -> a random secret, made by whichever process asks first
//                (INSERT OR IGNORE inside BEGIN IMMEDIATE, then read back: every
//                process gets the same one). Used only when the module has no
//                sessionSecret configured.
//   sessions_<m> express-session sessions, one table per module (library/sqlite-session-store)
//   rate_limits  one row per limiter and client key: hits in the current window and
//                when the window ends. Each increment is one BEGIN IMMEDIATE
//                transaction, so two processes never both count from the same value.
//   leases       named locks held across processes for work that awaits (withLease):
//                $closure's per-table lock, the FHIR validator download. A lease is a
//                row with an expiry that the holder renews while it works, so one left
//                by a process that died lapses on its own.
//
// As with the other shared files: WAL (readers don't wait for the writer),
// busy_timeout (a writer waits for another rather than failing), and the file must be
// on a local disk, never a network filesystem.
//

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BUSY_TIMEOUT_MS = 5000;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

let db = null;
let dbFile = null;
let override = null; // tests: force shared on or off
let optedIn = false;  // server.sharedState

/**
 * Is state kept in cluster-state.db? True when several processes may share this data
 * directory - cluster mode, or the background-jobs lock turned on for separately started
 * processes - and when a single server asks for it (server.sharedState).
 * @returns {boolean}
 */
function isShared() {
  if (override !== null) {
    return override;
  }
  return optedIn || require('./background-jobs').enabled;
}

/**
 * Called by server.js with the server settings.
 * @param {{sharedState?: boolean}} [opts] - server.sharedState: keep logins, generated
 *   session secrets and rate-limit counts in cluster-state.db even with one process
 */
function configure(opts = {}) {
  optedIn = opts.sharedState === true;
}

function file() {
  return dbFile || require('./folder-setup').filePath('cluster-state.db');
}

function open() {
  if (db) {
    return db;
  }
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const Database = require('better-sqlite3');
  const d = new Database(f, { timeout: BUSY_TIMEOUT_MS });
  d.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  d.pragma('journal_mode = WAL');
  d.pragma('synchronous = NORMAL');
  d.transaction(() => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, reset_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS rate_limits_reset ON rate_limits (reset_at);
      CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, holder TEXT NOT NULL, pid INTEGER, expires INTEGER NOT NULL);
    `);
  }).immediate();
  db = d;
  return db;
}

/**
 * The secret a module signs its session cookies with. The configured one if there is
 * one. Otherwise, with one process, a random one (logins then end when the server
 * restarts, as they always have); with several, one random secret kept in
 * cluster-state.db, so a cookie signed by one process verifies on all of them (and
 * logins survive a restart).
 * @param {string} name - the module (publisher, ips, testing, token, registry)
 * @param {string} [configured] - the module's sessionSecret setting
 * @returns {string}
 */
function sessionSecret(name, configured) {
  if (configured) {
    return configured;
  }
  if (!isShared()) {
    return crypto.randomBytes(64).toString('hex');
  }
  checkName(name);
  const d = open();
  return d.transaction(() => {
    d.prepare('INSERT OR IGNORE INTO secrets (name, value, created) VALUES (?, ?, ?)')
      .run('session:' + name, crypto.randomBytes(64).toString('hex'), Date.now());
    return d.prepare('SELECT value FROM secrets WHERE name = ?').get('session:' + name).value;
  }).immediate();
}

/**
 * The express-session store for a module: undefined with one process (express-session
 * then keeps sessions in memory, as before), else a SqliteSessionStore over its own
 * table in cluster-state.db.
 * @param {string} name - the module
 * @returns {import('express-session').Store|undefined}
 */
function sessionStore(name) {
  if (!isShared()) {
    return undefined;
  }
  checkName(name);
  const { SqliteSessionStore, betterSqlite } = require('./sqlite-session-store');
  return new SqliteSessionStore({ db: betterSqlite(open()), table: 'sessions_' + name.replace(/-/g, '_') });
}

/**
 * An express-rate-limit store that counts in cluster-state.db, so that a limit holds for
 * all the processes together rather than for each of them.
 */
class SharedRateLimitStore {
  constructor(name) {
    checkName(name);
    this.prefix = name + ':';
    this.windowMs = 60 * 1000;
    this.localKeys = false;
  }

  init(options) {
    this.windowMs = options.windowMs;
    const d = open();
    this.q = {
      get: d.prepare('SELECT hits, reset_at FROM rate_limits WHERE key = ?'),
      put: d.prepare(`INSERT INTO rate_limits (key, hits, reset_at) VALUES (?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET hits = excluded.hits, reset_at = excluded.reset_at`),
      dec: d.prepare('UPDATE rate_limits SET hits = max(hits - 1, 0) WHERE key = ? AND reset_at > ?'),
      del: d.prepare('DELETE FROM rate_limits WHERE key = ?'),
      delAll: d.prepare("DELETE FROM rate_limits WHERE key >= ? AND key < ?"),
      sweep: d.prepare('DELETE FROM rate_limits WHERE reset_at <= ?')
    };
    this.incTx = d.transaction((key) => {
      const k = this.prefix + key;
      const now = Date.now();
      const row = this.q.get.get(k);
      let hits = 1;
      let resetAt = now + this.windowMs;
      if (row && row.reset_at > now) {
        hits = row.hits + 1;
        resetAt = row.reset_at;
      }
      this.q.put.run(k, hits, resetAt);
      return { totalHits: hits, resetTime: new Date(resetAt) };
    });
  }

  async get(key) {
    const row = this.q.get.get(this.prefix + key);
    if (!row || row.reset_at <= Date.now()) {
      return undefined;
    }
    return { totalHits: row.hits, resetTime: new Date(row.reset_at) };
  }

  async increment(key) {
    return this.incTx.immediate(key);
  }

  async decrement(key) {
    this.q.dec.run(this.prefix + key, Date.now());
  }

  async resetKey(key) {
    this.q.del.run(this.prefix + key);
  }

  async resetAll() {
    // every key of this limiter: [prefix, prefix + U+FFFF)
    this.q.delAll.run(this.prefix, this.prefix + '￿');
  }

  /** Delete the counts whose window has ended (any process may; it is idempotent). */
  sweep() {
    if (this.q) {
      this.q.sweep.run(Date.now());
    }
  }
}

const stores = new Set();
let sweepTimer = null;

/**
 * Options for express-rate-limit: the given ones, plus, when several processes share
 * the data directory, a store in cluster-state.db named after the limiter.
 * @param {string} name - unique per limiter, e.g. 'publisher-login'
 * @param {Object} options - the express-rate-limit options
 * @returns {Object}
 */
function rateLimitOptions(name, options) {
  if (!isShared()) {
    return options;
  }
  const store = new SharedRateLimitStore(name);
  stores.add(store);
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      for (const s of stores) {
        try {
          s.sweep();
        } catch (e) {
          // a busy database: next time
        }
      }
    }, 10 * 60 * 1000);
    if (sweepTimer.unref) {
      sweepTimer.unref();
    }
  }
  return { ...options, store };
}

const DEFAULT_LEASE_TTL_MS = 30 * 1000;

/**
 * Run fn holding the named lease: no other process (or other call in this one) holds
 * the same lease until fn settles. Waiting polls (5 ms, backing off to 100 ms); a lease
 * whose holder stopped renewing it (the process died) lapses after ttlMs. fn may await
 * as long as it likes: the lease is renewed every ttlMs / 3 while it runs.
 *
 * @param {string} name
 * @param {Function} fn - async () => result
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs] - longest to wait; 0/absent = no limit. On timeout
 *   the error has .leaseTimeout = true
 * @param {number} [opts.ttlMs=30000]
 * @param {Function} [opts.waitFor] - (promise) => promise, wraps each wait (so a caller
 *   can stop waiting, e.g. when its client has gone)
 * @returns {Promise<*>} what fn returns
 */
async function withLease(name, fn, opts = {}) {
  const d = open();
  const ttl = opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_LEASE_TTL_MS;
  const holder = `${process.pid}:${crypto.randomUUID()}`;
  const take = d.transaction(() => {
    const now = Date.now();
    const row = d.prepare('SELECT holder, expires FROM leases WHERE name = ?').get(name);
    if (row && row.expires > now) {
      return false;
    }
    d.prepare(`INSERT INTO leases (name, holder, pid, expires) VALUES (?, ?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, pid = excluded.pid, expires = excluded.expires`)
      .run(name, holder, process.pid, now + ttl);
    return true;
  });
  const started = Date.now();
  let pause = 5;
  while (!take.immediate()) {
    if (opts.timeoutMs && Date.now() - started >= opts.timeoutMs) {
      const error = new Error(`timed out waiting for '${name}'`);
      error.leaseTimeout = true;
      throw error;
    }
    const sleep = new Promise(resolve => setTimeout(resolve, pause));
    await (opts.waitFor ? opts.waitFor(sleep) : sleep);
    pause = Math.min(pause * 2, 100);
  }
  const renew = setInterval(() => {
    try {
      d.prepare('UPDATE leases SET expires = ? WHERE name = ? AND holder = ?').run(Date.now() + ttl, name, holder);
    } catch (e) {
      // busy: the next renewal is well inside the ttl
    }
  }, Math.max(100, Math.floor(ttl / 3)));
  if (renew.unref) {
    renew.unref();
  }
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    try {
      d.prepare('DELETE FROM leases WHERE name = ? AND holder = ?').run(name, holder);
    } catch (e) {
      // it lapses on its own after ttl
    }
  }
}

/**
 * Start a FHIR validator service (fhir-validator-wrapper) for a module. With one process,
 * just validator.start(settings). With several, each runs its own validator, so: the
 * first worker uses the configured port and every other one a free port the system
 * gives it (two validators can't share a port); each writes its own tx log; and the jar
 * is downloaded or updated by one process at a time, under a lease, since the download
 * writes the jar in place.
 * @param {Object} validator - a FhirValidator
 * @param {Object} settings - what validator.start takes
 * @param {Object} [log]
 * @returns {Promise<void>}
 */
async function startValidator(validator, settings, log) {
  if (!isShared()) {
    return validator.start(settings);
  }
  // a cluster worker other than the first; one process (server.sharedState, or separately
  // started processes) keeps the configured port
  const slot = Number(process.env.FHIRSMITH_CLUSTER_WORKER) || 0;
  const s = { ...settings };
  if (slot > 1) {
    s.port = await freePort();
    if (s.txLog) {
      s.txLog = s.txLog.replace(/(\.[^./\\]*)?$/, `-${slot}$1`);
    }
  }
  if (s.autoDownload !== false) {
    await withLease('validator-jar', () => validator.ensureValidator({ skipUpdateCheck: !!s.skipUpdateCheck }), { ttlMs: 60 * 1000 });
    s.autoDownload = false;
  }
  if (log && s.port !== settings.port) {
    log.info(`FHIR validator for this worker on port ${s.port} (the configured port ${settings.port} is the first worker's)`);
  }
  return validator.start(s);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function checkName(name) {
  if (!NAME.test(name)) {
    throw new Error('Invalid cluster state name: ' + name);
  }
}

/** Close the database (tests, shutdown). */
function close() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  stores.clear();
  if (db) {
    try {
      db.close();
    } catch (e) {
      // best effort
    }
    db = null;
  }
}

/**
 * For tests: use this file, and force sharing on or off (null: decide as the server does).
 * @param {{file?: string, shared?: boolean|null}} opts
 */
function _configure(opts = {}) {
  close();
  dbFile = opts.file || null;
  override = opts.shared === undefined ? null : opts.shared;
  optedIn = false;
}

module.exports = { isShared, configure, sessionSecret, sessionStore, rateLimitOptions, SharedRateLimitStore, withLease, startValidator, close, _configure };
