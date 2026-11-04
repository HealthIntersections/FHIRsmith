//
// SqliteResourceCache - the $cache-control resource cache kept in one SQLite file
// that every server process on the machine shares.
//
// Used when server.cluster.sharedCache is on (cluster.md, "Options"): the master and the
// tx-workers then keep their $cache-control caches here instead of in their own memory, so
// any process can answer any cache-id, and caches survive a process restart. The memory
// store (ResourceCache) is the default. This class is the same interface with the same
// semantics, over a file:
//
//  - Nothing about a cache's contents is held in memory between requests. Each use
//    reads the rows; there is no per-process copy that could go stale when another
//    process changes the cache.
//  - A request only pays for the resources it uses. get() reads the list of what the
//    cache holds (type, url, version - not the content) and returns a stand-in for
//    each CodeSystem / ValueSet / ConceptMap that answers those from the list; the
//    first time a request touches anything else on one, its JSON is read and the
//    real wrapper built (see lazyResource). Most requests look up a handful of
//    resources by url in a cache of tens or hundreds.
//  - Every write is one short BEGIN IMMEDIATE transaction; WAL mode lets readers
//    carry on while one process writes; busy_timeout makes a writer wait for another
//    rather than fail.
//  - last_used is refreshed at most every touchIntervalMs (default 30 s) per cache,
//    not on every read, so steady use of a cache is reads only.
//  - The idle sweep (prune) and the size cap (maxBytes) move the caches they drop to
//    tombstones in the same transaction, so whichever process asks about a dead
//    cache-id later is told what happened to it. Any process may sweep; a sweep that
//    finds nothing to do (because another process just did it) does nothing.
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

const SCHEMA_VERSION = 2;
const DEFAULT_TOUCH_INTERVAL_MS = 30 * 1000;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * Render a byte count for a human: "512 KB", "3.4 MB", "2 GB".
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !isFinite(bytes) || bytes < 0) {
    return 'an unknown size';
  }
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, '')} GB`;
}

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
        supplements   TEXT,
        global_supplement INTEGER,
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
 * Content hash of a resource's JSON, as the expansion cache key uses it
 * (CanonicalResource.computeExpansionKeyHash: the first 16 hex characters of a SHA-256
 * of JSON.stringify(jsonObj)). Stored with the row, and handed to each wrapper built from
 * it (setExpansionKeyHash), so a cached resource is never serialised again to be hashed
 * and its expansion keys are the ones the memory store would make.
 * @param {string} json
 * @returns {string}
 */
function contentHash(json) {
  return crypto.createHash('sha256').update(json).digest('hex').substring(0, 16);
}

// Read from the index row, without building the resource: what callers check while
// looking through the cache for the one they want (see TerminologyWorker
// findInAdditionalResources, listVersions, loadSupplements; ExpansionCache.computeKey)
const INDEX_PROPERTIES = new Set(['url', 'version', 'vurl', 'versionedUrl', 'resourceType', 'fhirType',
  'supplementsUrl', 'isCached', 'isGlobalSupplement', 'expansionKeyHash']);

/**
 * A stand-in for a cached CodeSystem / ValueSet / ConceptMap that is only built
 * when it is used. It is an instance of the wrapper class (instanceof works), and
 * answers url, version, resourceType and the like from the index row. Touching
 * anything else - jsonObj, a method, any other property - loads the JSON and builds
 * the real wrapper, once; from then on everything goes to that wrapper, and methods
 * run on it directly (bound), so a resource that is used costs the same as one
 * built eagerly, and one that isn't costs nothing.
 *
 * @param {Function} Cls - the wrapper class
 * @param {Object} row - index row: key, resource_type, url, version, supplements, global_supplement, hash
 * @param {Function} load - () => the real wrapper (reads the JSON)
 */
function lazyResource(Cls, row, load) {
  let real = null;
  const bound = new Map();
  const target = Object.create(Cls.prototype);
  const url = row.url === null ? undefined : row.url;
  const version = row.version === null ? undefined : row.version;
  const index = {
    url,
    version,
    vurl: version ? url + '|' + version : url,
    versionedUrl: version ? url + '|' + version : url,
    resourceType: row.resource_type,
    fhirType: row.resource_type,
    supplementsUrl: row.supplements === null ? undefined : row.supplements,
    isCached: true,
    // the expansion cache key's hash of this resource (see contentHash): known from the row
    expansionKeyHash: () => row.hash,
    // CodeSystem.isGlobalSupplement(), worked out when it was stored (null: not known)
    isGlobalSupplement: row.global_supplement === null || row.global_supplement === undefined
      ? undefined : () => row.global_supplement === 1
  };
  const materialise = () => {
    if (!real) {
      real = load();
    }
    return real;
  };
  return new Proxy(target, {
    get(t, prop) {
      if (!real && INDEX_PROPERTIES.has(prop) && index[prop] !== undefined) {
        return index[prop];
      }
      if (!real && INDEX_PROPERTIES.has(prop) && prop !== 'isGlobalSupplement') {
        return undefined;
      }
      const r = materialise();
      const v = Reflect.get(r, prop, r);
      if (typeof v === 'function' && prop !== 'constructor') {
        let b = bound.get(prop);
        if (!b || b.fn !== v) {
          b = { fn: v, bound: v.bind(r) };
          bound.set(prop, b);
        }
        return b.bound;
      }
      return v;
    },
    set(t, prop, value) {
      return Reflect.set(materialise(), prop, value);
    },
    has(t, prop) {
      return Reflect.has(materialise(), prop);
    },
    deleteProperty(t, prop) {
      return Reflect.deleteProperty(materialise(), prop);
    },
    defineProperty(t, prop, desc) {
      return Reflect.defineProperty(materialise(), prop, desc);
    },
    ownKeys() {
      return Reflect.ownKeys(materialise());
    },
    getOwnPropertyDescriptor(t, prop) {
      const d = Reflect.getOwnPropertyDescriptor(materialise(), prop);
      if (d) {
        d.configurable = true; // a proxy may not report a non-configurable property its target lacks
      }
      return d;
    }
  });
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
   * @param {number} [options.maxBytes=0] - size cap for the whole file, 0 = none
   * @param {number} [options.touchIntervalMs=30000] - least time between last_used refreshes
   * @param {number} [options.busyTimeoutMs=5000]
   */
  constructor(stats, options = {}) {
    super(stats, options.maxTombstones || 1000);
    this.maxBytes = options.maxBytes > 0 ? options.maxBytes : 0;
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
      // the index: everything but the content (and the content only of what isn't a wrapper)
      index: db.prepare(`SELECT key, resource_type, url, version, supplements, global_supplement, fhir_version, kind, hash,
          CASE WHEN kind = 'wrapper' THEN NULL ELSE json END AS json
        FROM resources WHERE scope = ? AND cache_id = ? ORDER BY id`),
      content: db.prepare('SELECT json, fhir_version, hash FROM resources WHERE scope = ? AND cache_id = ? AND key = ?'),
      resourceHash: db.prepare('SELECT hash, concepts FROM resources WHERE scope = ? AND cache_id = ? AND key = ?'),
      touch: db.prepare('UPDATE sessions SET last_used = ? WHERE scope = ? AND cache_id = ? AND last_used < ?'),
      insertSession: db.prepare('INSERT INTO sessions (scope, cache_id, created_at, last_used, sealed) VALUES (?, ?, ?, ?, ?)'),
      upsertResource: db.prepare(`
        INSERT INTO resources (scope, cache_id, key, resource_type, url, version, supplements, global_supplement, fhir_version, kind, hash, json, bytes, concepts)
        VALUES (@scope, @cacheId, @key, @resourceType, @url, @version, @supplements, @globalSupplement, @fhirVersion, @kind, @hash, @json, @bytes, @concepts)
        ON CONFLICT (scope, cache_id, key) DO UPDATE SET
          resource_type = excluded.resource_type, url = excluded.url, version = excluded.version, supplements = excluded.supplements,
          global_supplement = excluded.global_supplement,
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
      fileBytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM sessions'),
      lru: db.prepare('SELECT * FROM sessions WHERE NOT (scope = ? AND cache_id = ?) ORDER BY last_used, created_at LIMIT 16')
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
   * The resources held under a cache-id: a fresh set of objects every call, nothing
   * shared with other requests. Wrappers are stand-ins that are only built when the
   * request uses them (see lazyResource). The session row and the index are read in
   * one read transaction. Later lazy reads check the indexed content hash: if another
   * process replaced a resource meanwhile, this request fails so the client can retry
   * from a fresh index, rather than mixing an old expansion key with new content.
   */
  get(cacheId) {
    let session = null;
    let rows = [];
    this.db.transaction(() => {
      session = this.q.session.get(this.scope, cacheId);
      if (session) {
        rows = this.q.index.all(this.scope, cacheId);
      }
    }).deferred();
    if (!session) {
      if (this.logCacheOps) {
        this.log.info(`cache-id '${cacheId}': miss (no entry)`);
      }
      return [];
    }
    this._maybeTouch(cacheId, session.last_used);
    const result = rows.map(r => this._hydrate({ ...r, cacheId }));
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
    if (row.kind === 'wrapper' && row.json === null) {
      const Cls = wrapperClass(row.resource_type);
      if (Cls) {
        const cacheId = row.cacheId;
        return lazyResource(Cls, row, () => this._loadWrapper(Cls, cacheId, row));
      }
    }
    return this._build(row);
  }

  /**
   * Build the real wrapper behind a stand-in. If the resource is no longer there
   * (the client ended the cache, or it expired or was evicted, while this request
   * was using it), the request fails the way a request on a dead cache-id does.
   */
  _loadWrapper(Cls, cacheId, row) {
    const c = this.q.content.get(this.scope, cacheId, row.key);
    if (!c) {
      const t = this.tombstone(cacheId);
      throw new Issue('error', 'not-found', null, 'CACHE_ID_GONE_DURING_REQUEST',
        `The cache '${cacheId}' ${t ? 'was ' + t.reason : 'went away'} while this request was using it, so ${row.key.replace(/\|/g, ' ')} is no longer available`,
        'cache-id-unknown', 404);
    }
    if (c.hash !== row.hash || c.fhir_version !== row.fhir_version) {
      throw new Issue('error', 'conflict', null, 'CACHE_ID_CHANGED_DURING_REQUEST',
        `The cache '${cacheId}' changed while this request was using it. Retry the request`,
        null, 409);
    }
    return this._build({ kind: 'wrapper', resource_type: row.resource_type, fhir_version: c.fhir_version, json: c.json, hash: c.hash });
  }

  _build(row) {
    const json = JSON.parse(row.json);
    let resource = json;
    if (row.kind === 'wrapper') {
      const Cls = wrapperClass(row.resource_type);
      if (Cls) {
        resource = new Cls(json, 'R5');
        resource.fhirVersion = row.fhir_version || 'R5';
        if (row.hash && typeof resource.setExpansionKeyHash === 'function') {
          // the hash of the JSON this was stored as, which is what the memory store's
          // resource (the one the client sent) hashes to
          resource.setExpansionKeyHash(row.hash);
        }
      }
    }
    markCached(resource);
    return resource;
  }

  /**
   * As for the memory store, except:
   * - an id with no record at all is CACHE_ID_UNKNOWN_SHARED, whatever its prefix. The
   *   memory store's messages offer a restart, or a request routed to the wrong instance,
   *   as explanations; here every process sees every cache, and caches survive a restart,
   *   so neither applies.
   * - an id dropped by the size cap (maxBytes) is CACHE_ID_EVICTED.
   */
  describeMissing(cacheId) {
    const t = this.tombstone(cacheId);
    if (!t) {
      return { messageId: 'CACHE_ID_UNKNOWN_SHARED', params: [cacheId] };
    }
    if (t.reason === 'evicted') {
      return {
        messageId: 'CACHE_ID_EVICTED',
        params: [cacheId, formatDuration(Date.now() - t.at), formatBytes(t.maxBytes), formatDuration(t.idleMs)]
      };
    }
    return super.describeMissing(cacheId);
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
   * Bytes held across the whole file (every endpoint): that is what maxBytes caps.
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
      url: resource.url ?? null,
      version: resource.version ?? null,
      supplements: isWrapper && typeof resource.jsonObj.supplements === 'string' ? resource.jsonObj.supplements : null,
      globalSupplement: isWrapper && typeof resource.isGlobalSupplement === 'function' ? this._globalSupplement(resource) : null,
      fhirVersion: isWrapper ? (resource.fhirVersion || 'R5') : null,
      kind: isWrapper ? 'wrapper' : 'plain',
      hash: contentHash(json),
      json,
      bytes: Buffer.byteLength(json),
      concepts: this._conceptsOf(resource)
    };
  }

  _globalSupplement(resource) {
    try {
      return resource.isGlobalSupplement() ? 1 : 0;
    } catch (e) {
      return null; // not known: the stand-in loads the resource to ask it
    }
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
      this._enforceMaxBytesTx(cacheId, now);
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
      this._enforceMaxBytesTx(cacheId, now);
    });
    this._trackMax();
  }

  /** Move a session to the tombstones (inside a write transaction). */
  _bury(session, reason, now, extra = {}) {
    this.q.insertTombstone.run(session.scope, session.cache_id, reason, now, session.created_at, session.last_used,
      extra.idleMs ?? null, extra.maxAgeMs ?? null, extra.maxBytes ?? null);
    this.q.deleteResources.run(session.scope, session.cache_id);
    this.q.deleteSession.run(session.scope, session.cache_id);
    this.q.trimTombstones.run(session.scope, session.scope, this.maxTombstones);
  }

  /**
   * The size cap covers the whole file (all endpoints): drop the least recently
   * used caches until the file is under it. Never the cache being written.
   */
  _enforceMaxBytesTx(keepId, now) {
    if (!this.maxBytes) {
      return;
    }
    let total = this.q.fileBytes.get().bytes;
    while (total > this.maxBytes) {
      const victims = this.q.lru.all(this.scope, keepId);
      if (victims.length === 0) {
        return;
      }
      for (const v of victims) {
        if (total <= this.maxBytes) {
          break;
        }
        const idleMs = now - v.last_used;
        this._bury(v, 'evicted', now, { idleMs, maxBytes: this.maxBytes });
        total -= v.bytes;
        this.log.info(`cache-id '${v.cache_id}': evicted (cache over its ${formatBytes(this.maxBytes)} cap; idle ${formatDuration(idleMs)})`);
      }
    }
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

module.exports = { SqliteResourceCache, contentHash, formatBytes };
