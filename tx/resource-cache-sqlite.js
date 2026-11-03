//
// SqliteResourceCache - the $cache-control resource cache kept in one SQLite file
// that every server process on the machine shares.
//
// Why: in cluster mode several processes listen on one port and any of them may
// receive any request, so a cache started on one process must be usable from all of
// them. The memory store (ResourceCache) can't do that. This class is the same
// interface with the same semantics, over a file:
//
//  - Nothing about a cache's contents is held in memory between requests. Each use
//    reads the rows and rebuilds the resources; there is no per-process copy that
//    could go stale when another process changes the cache.
//  - Every write is one short BEGIN IMMEDIATE transaction; WAL mode lets readers
//    carry on while one process writes; busy_timeout makes a writer wait for another
//    rather than fail.
//  - last_used is refreshed at most every touchIntervalMs (default 30 s) per cache,
//    not on every read, so steady use of a cache is reads only.
//  - The idle sweep (prune) moves the caches it drops to tombstones in the same
//    transaction, so whichever process asks about a dead cache-id later is told what
//    happened to it. Any process may sweep; a sweep that finds nothing to do
//    (because another process just did it) does nothing.
//
// The file must be on a local disk. SQLite's locking is not reliable on network
// filesystems (NFS, SMB, most container volume drivers backed by them), and a
// broken lock there corrupts the file.
//

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { ResourceCache, formatDuration } = require('./operation-context');
const { Issue } = require('./library/operation-outcome');

const SCHEMA_VERSION = 1;
const DEFAULT_TOUCH_INTERVAL_MS = 30 * 1000;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

// One connection per file per process, shared by the endpoints (each has its own scope)
const connections = new Map(); // absolute path -> { db, refs }

function openDatabase(file, busyTimeoutMs) {
  const abs = path.resolve(file);
  const existing = connections.get(abs);
  if (existing) {
    existing.refs++;
    return existing.db;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const db = new Database(abs);
  // busy_timeout first: switching to WAL and creating the tables need locks that
  // another process starting at the same moment may hold
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  db.pragma('journal_mode = WAL');
  // NORMAL is safe with WAL (no corruption); a power cut can lose the last
  // transactions, which for a cache of client resources is acceptable
  db.pragma('synchronous = NORMAL');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS sessions (
        scope       TEXT NOT NULL,
        cache_id    TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        last_used   INTEGER NOT NULL,
        sealed      INTEGER NOT NULL DEFAULT 0,
        concepts    INTEGER NOT NULL DEFAULT 0,
        resources   INTEGER NOT NULL DEFAULT 0,
        bytes       INTEGER NOT NULL DEFAULT 0,
        version     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope, cache_id)
      );
      CREATE INDEX IF NOT EXISTS sessions_last_used ON sessions (last_used);
      CREATE TABLE IF NOT EXISTS resources (
        id            INTEGER PRIMARY KEY,
        scope         TEXT NOT NULL,
        cache_id      TEXT NOT NULL,
        key           TEXT NOT NULL,
        resource_type TEXT,
        url           TEXT,
        version       TEXT,
        fhir_version  TEXT,
        kind          TEXT NOT NULL,
        hash          TEXT NOT NULL,
        json          TEXT NOT NULL,
        bytes         INTEGER NOT NULL,
        concepts      INTEGER NOT NULL DEFAULT 0,
        UNIQUE (scope, cache_id, key)
      );
      CREATE TABLE IF NOT EXISTS tombstones (
        scope       TEXT NOT NULL,
        cache_id    TEXT NOT NULL,
        reason      TEXT NOT NULL,
        at          INTEGER NOT NULL,
        created_at  INTEGER,
        last_used   INTEGER,
        idle_ms     INTEGER,
        max_age_ms  INTEGER,
        max_bytes   INTEGER,
        PRIMARY KEY (scope, cache_id)
      );
    `);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
    if (!row) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
    } else if (row.value !== String(SCHEMA_VERSION)) {
      throw new Error(`Resource cache ${abs} has schema version ${row.value}; this server uses ${SCHEMA_VERSION}. Delete the file (it only holds client caches) and restart`);
    }
  }).immediate();
  connections.set(abs, { db, refs: 1 });
  return db;
}

function releaseDatabase(file) {
  const abs = path.resolve(file);
  const c = connections.get(abs);
  if (!c) {
    return;
  }
  c.refs--;
  if (c.refs <= 0) {
    connections.delete(abs);
    try {
      c.db.close();
    } catch (e) {
      // closing is best effort
    }
  }
}

// The wrapper classes are loaded on first use: they pull in a good deal of the server
let wrappers = null;
function wrapperClass(resourceType) {
  if (!wrappers) {
    wrappers = {
      CodeSystem: require('./library/codesystem').CodeSystem,
      ValueSet: require('./library/valueset'),
      ConceptMap: require('./library/conceptmap').ConceptMap
    };
  }
  return wrappers[resourceType] || null;
}

/**
 * Content hash of a resource's JSON, as the expansion cache computes it (first 16
 * hex characters of a SHA-256), so the two can share it.
 * @param {string} json
 * @returns {string}
 */
function contentHash(json) {
  return crypto.createHash('sha256').update(json).digest('hex').substring(0, 16);
}

function markCached(resource) {
  if (resource && typeof resource === 'object') {
    // the same non-enumerable marker the memory store sets (see ResourceCache.add)
    Object.defineProperty(resource, 'isCached', { value: true, enumerable: false, configurable: true, writable: true });
  }
}

class SqliteResourceCache extends ResourceCache {
  /**
   * @param {Object} stats - server stats (may be null)
   * @param {Object} options
   * @param {string} options.path - the SQLite file (local disk only)
   * @param {string} [options.scope=''] - which endpoint's caches these are; endpoints
   *   share the file but not caches
   * @param {number} [options.maxTombstones=1000]
   * @param {number} [options.touchIntervalMs=30000] - least time between last_used refreshes
   * @param {number} [options.busyTimeoutMs=5000]
   */
  constructor(stats, options = {}) {
    super(stats, options.maxTombstones || 1000);
    if (!options.path) {
      throw new Error('SqliteResourceCache needs a path');
    }
    this.path = path.resolve(options.path);
    this.scope = options.scope || '';
    this.touchIntervalMs = options.touchIntervalMs >= 0 ? options.touchIntervalMs : DEFAULT_TOUCH_INTERVAL_MS;
    this.db = openDatabase(this.path, options.busyTimeoutMs || DEFAULT_BUSY_TIMEOUT_MS);
    this.closed = false;
    this._prepare();
  }

  _prepare() {
    const db = this.db;
    this.q = {
      session: db.prepare('SELECT * FROM sessions WHERE scope = ? AND cache_id = ?'),
      sessionExists: db.prepare('SELECT 1 FROM sessions WHERE scope = ? AND cache_id = ?'),
      sealed: db.prepare('SELECT sealed FROM sessions WHERE scope = ? AND cache_id = ?'),
      resources: db.prepare('SELECT key, resource_type, fhir_version, kind, hash, json FROM resources WHERE scope = ? AND cache_id = ? ORDER BY id'),
      resourceHash: db.prepare('SELECT hash, concepts FROM resources WHERE scope = ? AND cache_id = ? AND key = ?'),
      touch: db.prepare('UPDATE sessions SET last_used = ? WHERE scope = ? AND cache_id = ? AND last_used < ?'),
      insertSession: db.prepare('INSERT INTO sessions (scope, cache_id, created_at, last_used, sealed) VALUES (?, ?, ?, ?, ?)'),
      upsertResource: db.prepare(`
        INSERT INTO resources (scope, cache_id, key, resource_type, url, version, fhir_version, kind, hash, json, bytes, concepts)
        VALUES (@scope, @cacheId, @key, @resourceType, @url, @version, @fhirVersion, @kind, @hash, @json, @bytes, @concepts)
        ON CONFLICT (scope, cache_id, key) DO UPDATE SET
          resource_type = excluded.resource_type, url = excluded.url, version = excluded.version,
          fhir_version = excluded.fhir_version, kind = excluded.kind, hash = excluded.hash,
          json = excluded.json, bytes = excluded.bytes, concepts = excluded.concepts`),
      totals: db.prepare(`
        UPDATE sessions SET
          concepts = (SELECT COALESCE(SUM(concepts), 0) FROM resources r WHERE r.scope = sessions.scope AND r.cache_id = sessions.cache_id),
          bytes = (SELECT COALESCE(SUM(bytes), 0) FROM resources r WHERE r.scope = sessions.scope AND r.cache_id = sessions.cache_id),
          resources = (SELECT COUNT(*) FROM resources r WHERE r.scope = sessions.scope AND r.cache_id = sessions.cache_id),
          last_used = ?, version = version + 1
        WHERE scope = ? AND cache_id = ?`),
      deleteResources: db.prepare('DELETE FROM resources WHERE scope = ? AND cache_id = ?'),
      deleteSession: db.prepare('DELETE FROM sessions WHERE scope = ? AND cache_id = ?'),
      tombstone: db.prepare('SELECT * FROM tombstones WHERE scope = ? AND cache_id = ?'),
      insertTombstone: db.prepare(`
        INSERT OR REPLACE INTO tombstones (scope, cache_id, reason, at, created_at, last_used, idle_ms, max_age_ms, max_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      deleteTombstone: db.prepare('DELETE FROM tombstones WHERE scope = ? AND cache_id = ?'),
      trimTombstones: db.prepare(`
        DELETE FROM tombstones WHERE scope = ? AND rowid NOT IN
          (SELECT rowid FROM tombstones WHERE scope = ? ORDER BY rowid DESC LIMIT ?)`),
      tombstoneCount: db.prepare('SELECT COUNT(*) AS n FROM tombstones WHERE scope = ?'),
      expired: db.prepare('SELECT * FROM sessions WHERE scope = ? AND last_used < ?'),
      allSessions: db.prepare('SELECT * FROM sessions WHERE scope = ?'),
      scopeTotals: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(concepts), 0) AS concepts, COALESCE(SUM(bytes), 0) AS bytes FROM sessions WHERE scope = ?'),
      fileBytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM sessions')
    };
  }

  // ---------- reads ----------

  status(cacheId) {
    const s = this.q.session.get(this.scope, cacheId);
    if (!s) {
      return { exists: false };
    }
    const now = Date.now();
    return {
      exists: true,
      sealed: !!s.sealed,
      resources: s.resources,
      concepts: s.concepts || 0,
      idleMs: Math.max(0, now - s.last_used),
      ageMs: s.created_at ? now - s.created_at : null,
      timeoutMs: this.idleTimeoutMs
    };
  }

  has(cacheId) {
    return !!this.q.sessionExists.get(this.scope, cacheId);
  }

  isSealed(cacheId) {
    const s = this.q.sealed.get(this.scope, cacheId);
    return s ? !!s.sealed : false;
  }

  /**
   * The resources held under a cache-id, rebuilt from the file (a fresh set of
   * objects every call: nothing is shared with other requests). The session row
   * and its resources are read in one read transaction, so a concurrent write by
   * another process is seen entirely or not at all.
   */
  get(cacheId) {
    let session = null;
    let rows = [];
    this.db.transaction(() => {
      session = this.q.session.get(this.scope, cacheId);
      if (session) {
        rows = this.q.resources.all(this.scope, cacheId);
      }
    }).deferred();
    if (!session) {
      if (this.logCacheOps) {
        this.log.info(`cache-id '${cacheId}': miss (no entry)`);
      }
      return [];
    }
    this._maybeTouch(cacheId, session.last_used);
    const result = rows.map(r => this._hydrate(r));
    if (this.logCacheOps) {
      this.log.info(`cache-id '${cacheId}': hit, returning ${result.length} resource(s): ${rows.map(r => r.key).join(', ')}`);
    }
    return result;
  }

  /**
   * Rebuild one stored resource. Wrappers (CodeSystem / ValueSet / ConceptMap) are
   * stored in their internal R5 form, so they are rebuilt as R5 and then given back
   * the FHIR version they arrived in.
   */
  _hydrate(row) {
    const json = JSON.parse(row.json);
    let resource = json;
    if (row.kind === 'wrapper') {
      const Cls = wrapperClass(row.resource_type);
      if (Cls) {
        resource = new Cls(json, 'R5');
        resource.fhirVersion = row.fhir_version || 'R5';
      }
    }
    markCached(resource);
    return resource;
  }

  tombstone(cacheId) {
    const t = this.q.tombstone.get(this.scope, cacheId);
    if (!t) {
      return null;
    }
    return {
      reason: t.reason,
      at: t.at,
      createdAt: t.created_at,
      lastUsed: t.last_used,
      idleMs: t.idle_ms,
      maxAgeMs: t.max_age_ms,
      maxBytes: t.max_bytes
    };
  }

  tombstoneCount() {
    return this.q.tombstoneCount.get(this.scope).n;
  }

  size() {
    return this.q.scopeTotals.get(this.scope).n;
  }

  conceptCount() {
    return this.q.scopeTotals.get(this.scope).concepts;
  }

  conceptCountFor(cacheId) {
    const s = this.q.session.get(this.scope, cacheId);
    return s ? (s.concepts || 0) : 0;
  }

  /**
   * Bytes held across the whole file (every endpoint).
   */
  byteCount() {
    return this.q.fileBytes.get().bytes;
  }

  // High-water marks are this process's view (what it saw after its own writes)
  _trackMax() {
    try {
      const t = this.q.scopeTotals.get(this.scope);
      if (t.concepts > this.maxConcepts) {
        this.maxConcepts = t.concepts;
      }
      if (t.n > this.maxSizeValue) {
        this.maxSizeValue = t.n;
      }
    } catch (e) {
      // statistics only
    }
  }

  // ---------- writes ----------

  /**
   * Run a write transaction (BEGIN IMMEDIATE). If it fails it is tried once more;
   * if that fails too, the request gets a 503 (the tx router adds Retry-After), so
   * the client knows to retry rather than carrying on without its resources.
   */
  _write(what, fn) {
    const tx = this.db.transaction(fn);
    try {
      return tx.immediate();
    } catch (first) {
      this.log.warn(`resource cache: ${what} failed (${first.code || first.message}); retrying once`);
      try {
        return tx.immediate();
      } catch (second) {
        this.log.error(`resource cache: ${what} failed twice: ${second.message}`);
        throw new Issue('error', 'transient', null, 'CACHE_WRITE_FAILED',
          `The server could not save to its resource cache just now (${what}: ${second.code || second.message}). Nothing was changed; try the request again`,
          null, 503);
      }
    }
  }

  /**
   * Refresh last_used, at most once per touchIntervalMs: a cache in steady use
   * then costs reads, not a write per request. A failed refresh is ignored - the
   * worst it can do is let a cache look idle up to one interval sooner.
   */
  _maybeTouch(cacheId, lastUsed) {
    const now = Date.now();
    if (now - lastUsed < this.touchIntervalMs) {
      return;
    }
    try {
      this.db.transaction(() => {
        this.q.touch.run(now, this.scope, cacheId, now - this.touchIntervalMs);
      }).immediate();
    } catch (e) {
      // ignored, see above
    }
  }

  touch(cacheId) {
    if (!this.has(cacheId)) {
      return false;
    }
    try {
      // an explicit keepalive ($cache-control?mode=check) is not throttled
      const now = Date.now();
      this.db.transaction(() => {
        this.q.touch.run(now, this.scope, cacheId, now);
      }).immediate();
    } catch (e) {
      // a failed refresh is ignored: the cache is still there
    }
    if (this.logCacheOps) {
      this.log.info(`cache-id '${cacheId}': touched (idle clock reset)`);
    }
    return true;
  }

  /**
   * The row to store for a resource. Wrappers are stored as their (R5) jsonObj plus
   * the FHIR version they came in as; anything else is stored as itself.
   */
  _row(cacheId, resource) {
    const isWrapper = resource && typeof resource.jsonObj === 'object' && resource.jsonObj !== null
      && !!wrapperClass(resource.resourceType);
    const json = JSON.stringify(isWrapper ? resource.jsonObj : resource);
    return {
      scope: this.scope,
      cacheId,
      key: this._resourceKey(resource),
      resourceType: resource.resourceType || null,
      url: resource.url || null,
      version: resource.version || null,
      fhirVersion: isWrapper ? (resource.fhirVersion || 'R5') : null,
      kind: isWrapper ? 'wrapper' : 'plain',
      hash: contentHash(json),
      json,
      bytes: Buffer.byteLength(json),
      concepts: this._conceptsOf(resource)
    };
  }

  add(cacheId, resources) {
    if (!resources || resources.length === 0) return;
    resources = resources.filter(r => !!r);
    for (const resource of resources) {
      markCached(resource);
    }
    // the last copy of a key wins, as it would in the memory store
    const byKey = new Map();
    for (const resource of resources) {
      const row = this._row(cacheId, resource);
      byKey.delete(row.key);
      byKey.set(row.key, row);
    }
    const rows = [...byKey.values()];

    // Most requests re-send resources the cache already has, unchanged. Check
    // that with reads first, so they don't take the write lock at all.
    const session = this.q.session.get(this.scope, cacheId);
    if (session) {
      const changed = rows.some(r => {
        const existing = this.q.resourceHash.get(this.scope, cacheId, r.key);
        return !existing || existing.hash !== r.hash || existing.concepts !== r.concepts;
      });
      if (!changed) {
        this._maybeTouch(cacheId, session.last_used);
        return;
      }
    }

    this._write('add', () => {
      const now = Date.now();
      if (!this.q.sessionExists.get(this.scope, cacheId)) {
        if (this.q.tombstone.get(this.scope, cacheId)) {
          // Ended or expired (by another process) between the caller's check and
          // now: don't bring it back from the dead.
          this.log.info(`cache-id '${cacheId}': not adding ${rows.length} resource(s), the cache is gone`);
          return;
        }
        this.q.insertSession.run(this.scope, cacheId, now, now, 0);
      }
      for (const row of rows) {
        this.q.upsertResource.run(row);
        if (this.logCacheOps) {
          this.log.info(`cache-id '${cacheId}': stored ${row.key}`);
        }
      }
      this.q.totals.run(now, this.scope, cacheId);
    });
    this._trackMax();
  }

  set(cacheId, resources, sealed = false) {
    resources = (resources || []).filter(r => !!r);
    if (this.logCacheOps) {
      this.log.info(`cache-id '${cacheId}': set (replace all, sealed=${!!sealed}) with ${resources.length} resource(s): ${resources.map(r => this._resourceKey(r)).join(', ')}`);
    }
    for (const resource of resources) {
      markCached(resource);
    }
    const rows = resources.map(r => this._row(cacheId, r));
    this._write('start', () => {
      const now = Date.now();
      const existing = this.q.session.get(this.scope, cacheId);
      this.q.deleteResources.run(this.scope, cacheId);
      this.q.deleteSession.run(this.scope, cacheId);
      this.q.insertSession.run(this.scope, cacheId, existing ? existing.created_at : now, now, sealed ? 1 : 0);
      for (const row of rows) {
        this.q.upsertResource.run(row);
      }
      this.q.totals.run(now, this.scope, cacheId);
      // alive again, so any record of an earlier death is now wrong
      this.q.deleteTombstone.run(this.scope, cacheId);
    });
    this._trackMax();
  }

  /** Move a session to the tombstones (inside a write transaction). */
  _bury(session, reason, now, extra = {}) {
    this.q.insertTombstone.run(session.scope, session.cache_id, reason, now, session.created_at, session.last_used,
      extra.idleMs ?? null, extra.maxAgeMs ?? null, null);
    this.q.deleteResources.run(session.scope, session.cache_id);
    this.q.deleteSession.run(session.scope, session.cache_id);
    this.q.trimTombstones.run(session.scope, session.scope, this.maxTombstones);
  }

  clear(cacheId) {
    this._write('end', () => {
      const s = this.q.session.get(this.scope, cacheId);
      if (s) {
        this._bury(s, 'closed', Date.now());
        if (this.logCacheOps) {
          this.log.info(`cache-id '${cacheId}': closed by client after ${formatDuration(Date.now() - s.created_at)} (held ${s.resources} resource(s))`);
        }
      }
    });
  }

  clearAll() {
    this._write('clear all', () => {
      const now = Date.now();
      for (const s of this.q.allSessions.all(this.scope)) {
        this._bury(s, 'cleared', now);
      }
    });
  }

  /**
   * The idle sweep. One transaction: every session idle for longer than maxAge is
   * tombstoned and deleted. Idempotent, so it doesn't matter which process runs
   * it, or how many do.
   */
  prune(maxAge = 3600000) {
    if (this.stats) {
      this.stats.task('Client Cache', 'Pruning');
    }
    let n = 0;
    try {
      this.db.transaction(() => {
        const now = Date.now();
        for (const s of this.q.expired.all(this.scope, now - maxAge)) {
          const idleMs = now - s.last_used;
          this._bury(s, 'expired', now, { idleMs, maxAgeMs: maxAge });
          n++;
          if (this.logCacheOps) {
            this.log.info(`cache-id '${s.cache_id}': expired after ${formatDuration(idleMs)} idle (timeout ${formatDuration(maxAge)})`);
          }
        }
      }).immediate();
    } catch (e) {
      // the next sweep will pick them up
      this.log.error(`resource cache: idle sweep failed: ${e.message}`);
    }
    if (this.stats) {
      this.stats.taskDone('Client Cache', `Pruned ${n} of ${n + this.size()} entries`);
    }
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      releaseDatabase(this.path);
    }
  }
}

module.exports = { SqliteResourceCache, contentHash };
