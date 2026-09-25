const assert = require("assert");
const inspector = require("inspector");
const crypto = require("crypto");
const {Languages} = require("../library/languages");
const {Issue} = require("./library/operation-outcome");
const Logger = require("../library/logger");
const { readCgroupMemoryLimit } = require('../library/cgroup-memory');

/**
 * Check if running under a debugger
 * @returns {boolean}
 */
function isDebugging() {
  // Check if inspector is connected
  if (inspector.url() !== undefined) {
    return true;
  }
  // Also check for debug flags in case inspector not yet attached
  return process.execArgv.some(arg =>
      arg.includes('--inspect') || arg.includes('--debug')
  );
}

function debugLog(error, message) {
  if (isDebugging()) {
    console.log(error, message);
  }
}

/**
 * Render a duration for a human reading an error message: coarse enough to read
 * at a glance, precise enough to compare against a configured timeout.
 * @param {number} ms - duration in milliseconds
 * @returns {string} e.g. "45 seconds", "31 minutes", "2 hours 5 minutes"
 */
function formatDuration(ms) {
  if (ms === null || ms === undefined || !isFinite(ms) || ms < 0) {
    return 'an unknown time';
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) {
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  const h = `${hours} hour${hours === 1 ? '' : 's'}`;
  return rem === 0 ? h : `${h} ${rem} minute${rem === 1 ? '' : 's'}`;
}


class TimeTracker {
  constructor() {
    this.startTime = performance.now();
    this.steps = [];
  }

  step(note) {
    const elapsed = Math.round(performance.now() - this.startTime);
    this.steps.push(`${elapsed}ms ${note}`);
  }

  log() {
    return this.steps.join('\n');
  }

  link() {
    const newTracker = new TimeTracker();
    newTracker.startTime = this.startTime;
    newTracker.steps = [...this.steps];
    return newTracker;
  }
}


/**
 * Thread-safe resource cache for tx-resource parameters
 * Stores resources by cache-id for reuse across requests
 */
class ResourceCache {
  logCacheOps = false;

  constructor(stats, maxTombstones = 1000) {
    this.stats = stats;
    this.cache = new Map();
    this.locks = new Map(); // For thread-safety with async operations
    this.log = Logger.getInstance().child({module: 'tx-cache'});
    // Running total of concepts across every resource in every entry, maintained
    // incrementally on each mutation so cache sizing/limits are O(1) to consult.
    // Each entry also carries its own `concepts` subtotal so removal/replacement
    // can adjust the total without rescanning.
    this.totalConcepts = 0;
    // High-water marks (never decremented) - the most caches and the most concepts
    // this cache has held at once, for capacity reporting.
    this.maxConcepts = 0;
    this.maxSizeValue = 0;
    // Tombstones: why a cache-id that this server *did* issue is no longer here.
    // Without these, an unknown cache-id is indistinguishable from one that was
    // never issued, and the client can't tell "your build released it early" from
    // "it sat idle too long" from "you're talking to the wrong server/instance" -
    // which is exactly the ambiguity that makes cache-id-unknown reports (see
    // issue #279) unfalsifiable. Bounded and insertion-ordered: oldest evicted
    // first, so this can never grow without limit on a long-running server.
    this.tombstones = new Map(); // cacheId -> { reason, at, createdAt, lastUsed, idleMs, maxAgeMs }
    this.maxTombstones = maxTombstones;
    // The idle timeout this cache is pruned against, in ms. The cache doesn't
    // enforce it (prune() is told the maxAge by its caller), it just reports it,
    // so a client polling $cache-control?mode=check can work out how often it needs
    // to poll instead of guessing. Null = not advertised.
    this.idleTimeoutMs = null;
    // This server instance's code (modules.tx.instanceCode), prefixed onto every
    // cache-id it issues as "<code>.<uuid>". A proxy in front of several instances
    // routes on the prefix to get a cached request back to the one instance that
    // holds the cache (see nginx.md). Null = unprefixed ids (a single server).
    this.instanceCode = null;
  }

  /**
   * Set the instance code that is prefixed onto the cache-ids this cache issues.
   * 1-16 letters and digits: the code is followed by a '.', a proxy has to be able
   * to match it with a simple pattern, and the whole id must stay a valid FHIR id. Empty/null/undefined means no prefix.
   *
   * @param {string|null|undefined} code
   * @throws {Error} if the code is not letters and digits
   */
  setInstanceCode(code) {
    this.instanceCode = ResourceCache.checkInstanceCode(code);
  }

  /**
   * Validate an instance code from config.
   * @param {string|null|undefined} code
   * @returns {string|null} the code, or null for none (empty/null/undefined)
   * @throws {Error} if the code is not letters and digits
   */
  static checkInstanceCode(code) {
    if (code === undefined || code === null || code === '') {
      return null;
    }
    // At most 16 characters: the cache-id goes back to the client as a FHIR id
    // (valueId), which is capped at 64 - and "<code>." plus a 36-character UUID
    // has to fit.
    if (typeof code !== 'string' || !/^[A-Za-z0-9]{1,16}$/.test(code)) {
      throw new Error(`tx instanceCode '${code}' is not valid: it must be 1-16 letters and digits`);
    }
    return code;
  }

  /**
   * Mint a new cache-id: a UUID, prefixed with "<instanceCode>." when this server
   * has an instance code. Minting only - the caller creates the entry with set().
   * @returns {string}
   */
  newCacheId() {
    const uuid = crypto.randomUUID();
    return this.instanceCode ? `${this.instanceCode}.${uuid}` : uuid;
  }

  /**
   * The instance code in a cache-id, or null if it has none. Ids this server mints
   * are either a bare UUID (no '.') or "<code>.<uuid>".
   * @param {string} cacheId
   * @returns {string|null}
   */
  static issuerOf(cacheId) {
    const dot = typeof cacheId === 'string' ? cacheId.indexOf('.') : -1;
    return dot > 0 ? cacheId.substring(0, dot) : null;
  }

  /**
   * Tell the cache what idle timeout it is being pruned against, so it can report
   * it to clients. Purely informational - pruning is driven by prune()'s argument.
   * @param {number} ms
   */
  setIdleTimeout(ms) {
    this.idleTimeoutMs = ms;
  }

  /**
   * Record why a cache-id stopped existing, so a later request carrying that id
   * can be told what actually happened to it rather than a list of maybes.
   *
   * @param {string} cacheId - The cache identifier
   * @param {Object} entry - The entry being removed (for its timings)
   * @param {'closed'|'expired'|'cleared'} reason - How it went away:
   *   `closed` = the client released it with $cache-control?mode=end;
   *   `expired` = it went unused for longer than the idle timeout;
   *   `cleared` = the server dropped every cache at once.
   * @param {Object} [extra] - Reason-specific detail (e.g. idleMs, maxAgeMs)
   */
  _recordTombstone(cacheId, entry, reason, extra = {}) {
    // Re-inserting moves it to the end of the insertion order, so an id that
    // died twice (created, expired, re-issued, closed) reports its latest fate.
    this.tombstones.delete(cacheId);
    this.tombstones.set(cacheId, {
      reason,
      at: Date.now(),
      createdAt: entry ? entry.createdAt : null,
      lastUsed: entry ? entry.lastUsed : null,
      ...extra
    });
    while (this.tombstones.size > this.maxTombstones) {
      // Map iterates in insertion order, so the first key is the oldest record.
      this.tombstones.delete(this.tombstones.keys().next().value);
    }
  }

  /**
   * What happened to a cache-id that isn't in the cache. Null means this server
   * has no record of ever issuing it: either it never did, or the id was issued
   * by a different server/instance/endpoint, or this process has restarted since.
   *
   * @param {string} cacheId - The cache identifier
   * @returns {Object|null} the tombstone record, or null
   */
  tombstone(cacheId) {
    return this.tombstones.get(cacheId) || null;
  }

  /**
   * The message to report for a cache-id that isn't here: which of the three
   * fates it met, with the numbers that make it checkable - or, when there's no
   * record of it and its prefix names another instance, that it was routed here
   * by mistake. Both throw sites
   * (worker.setupAdditionalResources and batchValidate.frontLoadBatch) use this
   * so they can never drift apart.
   *
   * @param {string} cacheId - The cache identifier
   * @returns {{messageId: string, params: Array}} message id and its parameters,
   *   which always start with the cache-id itself.
   */
  describeMissing(cacheId) {
    const t = this.tombstone(cacheId);
    if (!t) {
      // No record of it here. If its prefix names a different instance, say so:
      // that's a routing problem (proxy misconfigured, or the owning instance is
      // down and the request fell through to a backup), not a lifecycle one.
      const issuer = ResourceCache.issuerOf(cacheId);
      if (issuer && issuer !== this.instanceCode) {
        return this.instanceCode
          ? { messageId: 'CACHE_ID_OTHER_INSTANCE', params: [cacheId, issuer, this.instanceCode] }
          : { messageId: 'CACHE_ID_OTHER_INSTANCE_UNNAMED', params: [cacheId, issuer] };
      }
      return { messageId: 'CACHE_ID_UNKNOWN', params: [cacheId] };
    }
    const ago = formatDuration(Date.now() - t.at);
    switch (t.reason) {
      case 'closed':
        return { messageId: 'CACHE_ID_CLOSED', params: [cacheId, ago, formatDuration(t.at - t.createdAt)] };
      case 'expired':
        return {
          messageId: 'CACHE_ID_EXPIRED',
          params: [cacheId, formatDuration(t.idleMs), formatDuration(t.maxAgeMs), ago]
        };
      default:
        return { messageId: 'CACHE_ID_CLEARED', params: [cacheId, ago] };
    }
  }

  /**
   * Number of dead cache-ids this cache still remembers the fate of.
   * @returns {number}
   */
  tombstoneCount() {
    return this.tombstones.size;
  }

  /**
   * Report on a cache-id without touching it. Deliberately read-only, and
   * deliberately separate from touch(): a client asking "is my cache still alive?"
   * wants to know how idle it had become, and reading after a refresh would always
   * answer zero. Callers that are keeping the cache alive read the status first,
   * then touch.
   *
   * @param {string} cacheId - The cache identifier
   * @returns {Object} `{exists: false}` for a cache-id that isn't here, otherwise
   *   `{exists: true, sealed, resources, concepts, idleMs, ageMs, timeoutMs}`.
   */
  status(cacheId) {
    const entry = this.cache.get(cacheId);
    if (!entry) {
      return { exists: false };
    }
    const now = Date.now();
    return {
      exists: true,
      sealed: !!entry.sealed,
      resources: entry.resources.length,
      concepts: entry.concepts || 0,
      idleMs: now - entry.lastUsed,
      ageMs: entry.createdAt ? now - entry.createdAt : null,
      timeoutMs: this.idleTimeoutMs
    };
  }

  /**
   * Reset a cache's idle clock without reading or changing its contents - the
   * keepalive behind $cache-control?mode=check. A client whose traffic is absorbed
   * by its own local cache can otherwise let a cache it is still relying on go idle
   * past the timeout, and only find out when it finally needs the server again.
   *
   * @param {string} cacheId - The cache identifier
   * @returns {boolean} true if the cache existed and was refreshed
   */
  touch(cacheId) {
    const entry = this.cache.get(cacheId);
    if (!entry) {
      return false;
    }
    entry.lastUsed = Date.now();
    if (this.logCacheOps) {
      this.log.info(`cache-id '${cacheId}': touched (idle clock reset)`);
    }
    return true;
  }

  /**
   * Update the high-water marks after a mutation that may have grown the cache.
   */
  _trackMax() {
    if (this.totalConcepts > this.maxConcepts) {
      this.maxConcepts = this.totalConcepts;
    }
    if (this.cache.size > this.maxSizeValue) {
      this.maxSizeValue = this.cache.size;
    }
  }

  /**
   * Concept count of a single cached resource, or 0 if it doesn't expose one.
   * @param {Object} resource
   * @returns {number}
   */
  _conceptsOf(resource) {
    return resource && typeof resource.conceptCount === 'function' ? resource.conceptCount() : 0;
  }

  /**
   * Get resources for a cache-id
   * @param {string} cacheId - The cache identifier
   * @returns {Array} Array of resources, or empty array if not found
   */
  get(cacheId) {
    const entry = this.cache.get(cacheId);
    if (entry) {
      entry.lastUsed = Date.now();
      if (this.logCacheOps) {
        this.log.info(`cache-id '${cacheId}': hit, returning ${entry.resources.length} resource(s): ${entry.resources.map(r => this._resourceKey(r)).join(', ')}`);
      }
      return [...entry.resources]; // Return a copy
    }
    if (this.logCacheOps) {
      this.log.info(`cache-id '${cacheId}': miss (no entry)`);
    }
    return [];
  }

  /**
   * Check if a cache-id exists
   * @param {string} cacheId - The cache identifier
   * @returns {boolean}
   */
  has(cacheId) {
    return this.cache.has(cacheId);
  }

  /**
   * Whether a cache is sealed. A sealed cache holds only the resources it was
   * created with (at $cache-control?mode=start) and does not grow as further
   * resources are seen on subsequent operations. An unsealed cache accumulates
   * every resource it sees. Unknown/absent cache-ids report false.
   * @param {string} cacheId - The cache identifier
   * @returns {boolean}
   */
  isSealed(cacheId) {
    const entry = this.cache.get(cacheId);
    return entry ? !!entry.sealed : false;
  }

  /**
   * Add resources to a cache-id (merges with existing)
   * @param {string} cacheId - The cache identifier
   * @param {Array} resources - Resources to add
   */
  add(cacheId, resources) {
    if (!resources || resources.length === 0) return;

    // These resources are being retained under a cache-id (they persist across
    // the batch), so mark them cached: their filter elements survive, and a
    // provider may memoise resolved filter analysis on them (see filter()/fc).
    // Inline tx-resources that never enter this pool stay unmarked.
    for (const resource of resources) {
      if (resource) {
        // non-enumerable: internal marker only, must never serialise into a
        // response or be copied by structuredClone/spread when a VS is cloned.
        Object.defineProperty(resource, 'isCached', { value: true, enumerable: false, configurable: true, writable: true });
      }
    }

    const entry = this.cache.get(cacheId) || { resources: [], createdAt: Date.now(), lastUsed: Date.now(), concepts: 0 };

    // Merge resources, avoiding duplicates by url+version. Keep the entry's concept
    // subtotal and the cache-wide total in step with each insertion/replacement.
    for (const resource of resources) {
      const key = this._resourceKey(resource);
      const newConcepts = this._conceptsOf(resource);
      const existingIndex = entry.resources.findIndex(r => this._resourceKey(r) === key);
      if (existingIndex >= 0) {
        // Replace existing: adjust by the difference
        const delta = newConcepts - this._conceptsOf(entry.resources[existingIndex]);
        entry.resources[existingIndex] = resource;
        entry.concepts += delta;
        this.totalConcepts += delta;
        if (this.logCacheOps) {
          this.log.info(`cache-id '${cacheId}': replaced ${key}`);
        }
      } else {
        entry.resources.push(resource);
        entry.concepts += newConcepts;
        this.totalConcepts += newConcepts;
        if (this.logCacheOps) {
          this.log.info(`cache-id '${cacheId}': added ${key}`);
        }
      }
    }

    entry.lastUsed = Date.now();
    this.cache.set(cacheId, entry);
    this._trackMax();
  }

  /**
   * Set resources for a cache-id (replaces existing)
   * @param {string} cacheId - The cache identifier
   * @param {Array} resources - Resources to set
   * @param {boolean} [sealed=false] - If true, the cache is fixed at these
   *   resources and will not grow when further resources are seen later.
   */
  set(cacheId, resources, sealed = false) {
    if (this.logCacheOps) {
      this.log.info(`cache-id '${cacheId}': set (replace all, sealed=${!!sealed}) with ${resources.length} resource(s): ${resources.map(r => this._resourceKey(r)).join(', ')}`);
    }
    // Retained under a cache-id - mark cached so providers may memoise resolved
    // filter analysis on their filter elements (see filter()/fc).
    for (const resource of resources) {
      if (resource) {
        // non-enumerable: internal marker only, must never serialise into a
        // response or be copied by structuredClone/spread when a VS is cloned.
        Object.defineProperty(resource, 'isCached', { value: true, enumerable: false, configurable: true, writable: true });
      }
    }
    // Drop the old entry's contribution, then count the replacement.
    const existing = this.cache.get(cacheId);
    if (existing) {
      this.totalConcepts -= existing.concepts || 0;
    }
    let concepts = 0;
    for (const resource of resources) {
      concepts += this._conceptsOf(resource);
    }
    this.totalConcepts += concepts;
    this.cache.set(cacheId, {
      resources: [...resources],
      createdAt: existing ? existing.createdAt : Date.now(),
      lastUsed: Date.now(),
      concepts,
      sealed: !!sealed
    });
    // This id is alive again, so any record of its previous death is now wrong.
    this.tombstones.delete(cacheId);
    this._trackMax();
  }

  /**
   * Clear a specific cache-id. This is the client-initiated release path
   * ($cache-control?mode=end), so a cache that existed is tombstoned as `closed`:
   * a later request still carrying the id gets told the client let it go, rather
   * than being sent looking for an expiry that never happened.
   *
   * @param {string} cacheId - The cache identifier
   */
  clear(cacheId) {
    const entry = this.cache.get(cacheId);
    if (entry) {
      this.totalConcepts -= entry.concepts || 0;
      this._recordTombstone(cacheId, entry, 'closed');
      if (this.logCacheOps) {
        this.log.info(`cache-id '${cacheId}': closed by client after ${formatDuration(Date.now() - entry.createdAt)} (held ${entry.resources.length} resource(s))`);
      }
    }
    this.cache.delete(cacheId);
  }

  /**
   * Clear all cached entries
   */
  clearAll() {
    for (const [cacheId, entry] of this.cache.entries()) {
      this._recordTombstone(cacheId, entry, 'cleared');
    }
    this.cache.clear();
    this.totalConcepts = 0;
  }

  /**
   * Remove entries older than maxAge milliseconds
   * @param {number} maxAge - Maximum age in milliseconds
   */
  prune(maxAge = 3600000) { // Default 1 hour
    if (this.stats) {
      this.stats.task("Client Cache", `Pruning (${this.cache.size} entries)`);
    }
    let i = 0;
    const now = Date.now();
    for (const [cacheId, entry] of this.cache.entries()) {
      const idleMs = now - entry.lastUsed;
      if (idleMs > maxAge) {
        i++;
        this.totalConcepts -= entry.concepts || 0;
        // Record the *measured* idle time, not the configured timeout: the sweep
        // runs periodically, so a cache can sit dead for up to one sweep interval
        // past the timeout, and only the measured figure lets a client line the
        // expiry up against its own request log.
        this._recordTombstone(cacheId, entry, 'expired', { idleMs, maxAgeMs: maxAge });
        if (this.logCacheOps) {
          this.log.info(`cache-id '${cacheId}': expired after ${formatDuration(idleMs)} idle (timeout ${formatDuration(maxAge)})`);
        }
        this.cache.delete(cacheId);
      }
    }
    if (this.stats) {
      this.stats.taskDone("Client Cache", `Pruned ${i} of ${this.cache.size} entries`);
    }
  }

  /**
   * Get the number of cached entries
   * @returns {number}
   */
  size() {
    return this.cache.size;
  }

  /**
   * Total number of concepts held across every entry in the cache. Maintained
   * incrementally, so this is O(1).
   * @returns {number}
   */
  conceptCount() {
    return this.totalConcepts;
  }

  /**
   * Highest number of concepts this cache has held at once (high-water mark).
   * @returns {number}
   */
  maxConceptCount() {
    return this.maxConcepts;
  }

  /**
   * Highest number of caches (cache-ids) this cache has held at once.
   * @returns {number}
   */
  maxSize() {
    return this.maxSizeValue;
  }

  /**
   * Number of concepts held under a single cache-id (0 if unknown).
   * @param {string} cacheId
   * @returns {number}
   */
  conceptCountFor(cacheId) {
    const entry = this.cache.get(cacheId);
    return entry ? (entry.concepts || 0) : 0;
  }

  /**
   * Generate a key for a resource based on url and version
   * @param {Object} resource - The resource
   * @returns {string}
   */
  _resourceKey(resource) {
    const url = resource.url || resource.id || '';
    const version = resource.version || '';
    const type = resource.resourceType || '';
    return `${type}|${url}|${version}`;
  }
}

/**
 * Cache for expanded ValueSets
 * Stores expansions keyed by hash of (valueSet, params, additionalResources)
 * Only caches expansions that took longer than the minimum cache time
 */
class ExpansionCache {
  /**
   * Minimum time (ms) an expansion must take before we cache it
   */
  static MIN_CACHE_TIME_MS = 250;

  /**
   * Default maximum number of cached entries
   */
  static DEFAULT_MAX_SIZE = 1000;

  /**
   * @param {number} maxSize - Maximum number of entries to keep (default 1000)
   * @param {number} memoryThresholdMB - Heap usage in MB that triggers dropping oldest half (0 = disabled)
   */
  constructor(stats, maxSize = ExpansionCache.DEFAULT_MAX_SIZE, memoryThresholdMB = 0) {
    this.stats = stats;
    this.cache = new Map();
    this.maxSize = maxSize;
    this.memoryThresholdBytes = memoryThresholdMB * 1024 * 1024;
    // When true, every expansion is cached regardless of how long it took
    // (bypasses MIN_CACHE_TIME_MS). Used by the test runner to force the cache
    // path so cache correctness (e.g. language in the key) is exercised.
    this.forceCaching = false;
  }

  /**
   * Compute a hash key for an expansion request.
   * This must hash the actual content of resources, not just their identity,
   * because clients can submit variations on the same ValueSet/CodeSystem.
   *
   * @param {Object|ValueSet} valueSet - The ValueSet to expand (wrapper or JSON)
   * @param {Object} params - Parameters resource (tx-resource and valueSet params excluded)
   * @param {Array} additionalResources - Additional resources in scope (CodeSystem/ValueSet wrappers)
   * @returns {string} Hash key
   */
  computeKey(valueSet, params, additionalResources) {
    const keyParts = [];

    // ValueSet content - always hash the full JSON content
    // The ValueSet might be a wrapper class or raw JSON
    const vsJson = valueSet.jsonObj || valueSet;
    keyParts.push(`vs:${JSON.stringify(vsJson)}`);

    // Parameters - filter out tx-resource and valueSet params, sort for consistency
    if (params) {
      keyParts.push(`params:`+params.hashSource());
    }

    // Additional resources - hash the full content of each resource
    // Resources are now CodeSystem/ValueSet wrappers, not raw JSON
    if (additionalResources && additionalResources.length > 0) {
      const resourceHashes = additionalResources
          .map(r => {
            // Get the JSON object from wrapper or use directly
            const json = r.jsonObj || r;
            // Create a content hash for this resource
            return crypto.createHash('sha256')
                .update(JSON.stringify(json))
                .digest('hex')
                .substring(0, 16); // Use first 16 chars for brevity
          })
          .sort();
      keyParts.push(`additional:${resourceHashes.join(',')}`);
    }

    // Create SHA256 hash of the combined key
    const keyString = keyParts.join('||');
    return crypto.createHash('sha256').update(keyString).digest('hex');
  }


  /**
   * Get a cached expansion
   * @param {string} key - Hash key from computeKey()
   * @returns {Object|null} Cached expanded ValueSet or null
   */
  get(key) {
    const entry = this.cache.get(key);
    if (entry) {
      entry.lastUsed = Date.now();
      entry.hitCount++;
      return entry.expansion;
    }
    return null;
  }

  /**
   * Check if a cached expansion exists
   * @param {string} key - Hash key
   * @returns {boolean}
   */
  has(key) {
    return this.cache.has(key);
  }

  /**
   * Store an expansion in the cache (only if duration exceeds minimum)
   * @param {string} key - Hash key from computeKey()
   * @param {Object} expansion - The expanded ValueSet
   * @param {number} durationMs - How long the expansion took
   * @returns {boolean} True if cached, false if duration too short
   */
  set(key, expansion, durationMs) {
    // Only cache if expansion took significant time, unless forceCaching is on
    // (in which case everything is cached regardless of duration).
    if (!this.forceCaching && durationMs < ExpansionCache.MIN_CACHE_TIME_MS) {
      return false;
    }

    // Enforce max size before adding - evict oldest (by lastUsed) if needed
    if (this.cache.size >= this.maxSize) {
      this.evictOldest(1);
    }

    this.cache.set(key, {
      expansion: expansion,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      durationMs: durationMs,
      hitCount: 0
    });
    return true;
  }

  /**
   * Evict the N oldest entries by lastUsed time
   * @param {number} count - Number of entries to evict
   * @returns {number} Number of entries actually evicted
   */
  evictOldest(count) {
    if (this.cache.size === 0 || count <= 0) return 0;

    // Get entries sorted by lastUsed (oldest first)
    const entries = Array.from(this.cache.entries())
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    const toEvict = Math.min(count, entries.length);
    for (let i = 0; i < toEvict; i++) {
      this.cache.delete(entries[i][0]);
    }
    return toEvict;
  }

  /**
   * Drop the oldest half of entries (by lastUsed)
   * Called when memory pressure is detected
   * @returns {number} Number of entries evicted
   */
  evictOldestHalf() {
    const halfSize = Math.floor(this.cache.size / 2);
    return this.evictOldest(halfSize);
  }

  /**
   * Check memory usage and evict oldest half if over threshold
   * @returns {boolean} True if eviction was triggered
   */
  checkMemoryPressure() {
    if (this.stats) {
      this.stats.task('Expansion Cache', 'Checking Memory Pressure');
    }
    if (this.memoryThresholdBytes <= 0) return false;

    const heapUsed = process.memoryUsage().heapUsed;
    if (heapUsed > this.memoryThresholdBytes) {
      const i = this.evictOldestHalf();
      if (this.stats) {
        this.stats.taskDone('Expansion Cache', `Checked Memory Pressure: evicted half (${i} entries)`);
      }
      return true;
    }
    if (this.stats) {
      this.stats.taskDone('Expansion Cache', `Checked Memory Pressure - OK (${this.cache.size} entries)`);
    }
    return false;
  }

  /**
   * Clear a specific entry
   * @param {string} key - Hash key
   */
  clear(key) {
    this.cache.delete(key);
  }

  /**
   * Clear all cached entries
   */
  clearAll() {
    this.cache.clear();
  }

  /**
   * Get cache statistics.
   * NB: named getStats(), not stats() — the `stats` field (the ServerStats
   * passed to the constructor) would shadow a method called `stats`, making it
   * unreachable.
   * @returns {Object} Stats object
   */
  getStats() {
    let totalHits = 0;
    for (const entry of this.cache.values()) {
      totalHits += entry.hitCount;
    }
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      memoryThresholdMB: this.memoryThresholdBytes > 0 ? this.memoryThresholdBytes / (1024 * 1024) : 0,
      totalHits
    };
  }

  size() {
    return this.cache.size;
  }
}


/**
 * Read the cgroup memory limit once at startup.
 * Returns the byte limit, or 0 if unavailable (disables the check).
 */
function readMemoryLimit() {
  return readCgroupMemoryLimit().limit;
}

const MEMORY_LIMIT = readMemoryLimit();
const MEMORY_FRACTION = 0.98;
const MEMORY_THRESHOLD = MEMORY_LIMIT > 0 ? MEMORY_LIMIT * MEMORY_FRACTION : 0; // MEMORY_FRACTION of cgroup limit
const CHECK_FREQUENCY = 100;
// How long an operation may compute without yielding the event loop (ms).
// Node runs all JS on one thread: while a long operation executes, no other
// request is serviced - awaiting in-memory promises does not help, because
// resolved promises only bounce through the microtask queue, which runs before
// I/O. checkAndYield() awaits a real setImmediate every YIELD_INTERVAL ms of
// compute, so pending I/O (new connections, /metadata, timers) runs between
// slices and one heavy $expand can no longer time out every other client.
const YIELD_INTERVAL = 25;
const { setImmediate: yieldToEventLoop } = require('timers/promises');

class OperationContext {
  // Shared counter across all instances — only check RSS every CHECK_FREQUENCY calls
  static _checkCounter = 0;

  constructor(langs, i18n = null, id = null, timeLimit = 30, resourceCache = null, expansionCache = null) {
    this.i18n = i18n;
    this.langs = this._ensureLanguages(langs);
    this.id = id || this._generateId();
    this.startTime = performance.now();
    this.contexts = [];
    this.timeLimit = timeLimit * 1000; // Convert to milliseconds
    this.timeTracker = new TimeTracker();
    this.logEntries = [];
    this.resourceCache = resourceCache;
    this.expansionCache = expansionCache;
    // Server-issued cache-id carried on the request (X-Cache-Id header). Set once
    // per request from the header so every worker can consult it uniformly via
    // setupAdditionalResources, regardless of how that worker assembles its
    // Parameters (buildParameters, raw req.body, query/form). An explicit
    // cache-id *parameter* still takes precedence over this.
    this.cacheId = null;
    this.debugging = isDebugging();
    // Providers opened during this operation that need their underlying
    // resources (sqlite connections, etc.) released when the operation ends.
    // Shared by reference with copy()'d contexts so a sub-operation's
    // providers are cleaned up by the parent request's closeProviders().
    this._openProviders = [];
    // Compute-time accounting for the deadline and for yielding. One object,
    // shared by reference with copy()'d contexts, so an operation and its
    // sub-operations (e.g. batch entries) draw down a single budget:
    //  - compute:    ms of compute consumed in completed slices
    //  - sliceStart: when the current compute slice began
    //  - lastYield:  when we last gave the event loop a turn
    //  - clientGone: set when the client disconnects before the response is sent
    // The deadline is measured in COMPUTE time, not wall-clock: once operations
    // time-share the event loop, wall-clock deadlines make concurrency itself
    // cause aborts (N ops each take N x as long), which turns client retries
    // into a failure amplifier. An operation that waited is not too costly;
    // one that consumed its compute budget is.
    this._clock = {
      compute: 0,
      sliceStart: this.startTime,
      lastYield: this.startTime,
      clientGone: false
    };

    this.timeTracker.step('tx-op');
  }

  _ensureLanguages(param) {
    assert(typeof param === 'string' || param instanceof Languages, 'Parameter must be string or Languages object');
    return typeof param === 'string' ? Languages.fromAcceptLanguage(param, this.i18n.languageDefinitions, false) : param;
  }

  _generateId() {
    return 'op_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
  }

  /**
   * Create a copy of this operation context
   * @returns {OperationContext}
   */
  copy() {
    const newContext = new OperationContext(
        this.langs, this.i18n, this.id, this.timeLimit / 1000,
        this.resourceCache, this.expansionCache
    );
    newContext.contexts = [...this.contexts];
    newContext.startTime = this.startTime;
    newContext.timeTracker = this.timeTracker.link();
    newContext.logEntries = [...this.logEntries];
    newContext.debugging = this.debugging;
    newContext.cacheId = this.cacheId;
    newContext.usageTracker = this.usageTracker;
    // Share the same provider-cleanup list so providers opened by the copy
    // are released when the parent operation ends.
    newContext._openProviders = this._openProviders;
    // Share the compute clock: sub-operations spend the parent's budget.
    newContext._clock = this._clock;
    return newContext;
  }

  /**
   * Check if operation has exceeded time limit, or is pushing is over the memory limit
   * Skipped when running under debugger
   *
   * note: if the server pushes over the memory limit for the process, the process is terminated.
   * the memory check here is intended to prevent process termination on the grounds that some
   * big operation is pushing the limit. It might not be the big operation that is terminated first,
   * but eventually it'll get terminated.
   *
   * this is called a *lot* so it's important to be efficient. Only check every CHECK_FREQUENCY
   * times means that there could be a small overrun, but it's called often enough that the
   * overrun won't be that signiifcant
   *
   * @param {string} place - Location identifier for debugging
   * @returns {boolean} true if operation should be terminated
   */
  deadCheck(place = 'unknown') {
    if (this.debugging) {
      return false;
    }

    OperationContext._checkCounter++;
    if (OperationContext._checkCounter < CHECK_FREQUENCY) {
      return false;
    }
    OperationContext._checkCounter = 0;

    // Time check - against compute time consumed, not wall clock (see _clock in
    // the constructor). For operations that never yield the two are identical,
    // so this changes nothing for paths that don't use checkAndYield().
    const elapsed = this.computeElapsed();
    if (elapsed > this.timeLimit) {
      const timeInSeconds = Math.round(this.timeLimit / 1000);
      this.log(`Operation took too long @ ${place} (${this.constructor.name})`);
      const error = new Issue("error", "too-costly", null, null,
          `Operation exceeded time limit of ${timeInSeconds} seconds at ${place}`, "too-costly", 422);
      error.diagnostics = this.diagnostics();
      throw error;
    }

    // Memory check (piggyback on same sample)
    if (MEMORY_THRESHOLD > 0) {
      const rss = process.memoryUsage.rss();
      if (rss > MEMORY_THRESHOLD) {
        const usedGB = (rss / 1024 / 1024 / 1024).toFixed(1);
        const limitGB = (MEMORY_LIMIT / 1024 / 1024 / 1024).toFixed(1);
        this.log(`Memory Limit: ${usedGB} GB of ${limitGB} GB limit @ ${place}`);
        const error = new Issue("error", "too-costly", null, null,
            `Operation aborted: server memory usage (${usedGB} GB) exceeds safe threshold (${MEMORY_FRACTION * 100}% of ${limitGB} GB limit) at ${place}`, "too-costly", 422);
        error.diagnostics = this.diagnostics();
        throw error;
      }
    }

    return false;
  }

  /**
   * Compute time this operation has consumed (ms): completed slices plus the
   * slice currently executing. Equals wall-clock elapsed for operations that
   * never yield.
   * @returns {number}
   */
  computeElapsed() {
    return this._clock.compute + (performance.now() - this._clock.sliceStart);
  }

  /**
   * Mark that the client for this operation disconnected before the response
   * was sent. The operation is aborted at its next yield point - there is no
   * one left to send the result to. (Wired up by the request middleware from
   * the response 'close' event.)
   */
  markClientGone() {
    this._clock.clientGone = true;
  }

  /**
   * deadCheck plus cooperative yielding: call this (awaited) from long-running
   * loops in async code. Runs the normal deadCheck, and after every
   * YIELD_INTERVAL ms of continuous compute awaits a real setImmediate so the
   * event loop can service pending I/O - other requests keep getting answered
   * while this operation works. On resuming from a yield, aborts if the client
   * has disconnected in the meantime.
   *
   * Sync call sites keep using deadCheck(); the async loops that surround them
   * yield on their behalf, which caps unbroken compute at one loop iteration.
   *
   * @param {string} place - Location identifier for debugging
   */
  async checkAndYield(place = 'unknown') {
    this.deadCheck(place);
    if (this.debugging) {
      return;
    }
    const now = performance.now();
    if (now - this._clock.lastYield >= YIELD_INTERVAL) {
      // Close off this compute slice before suspending, so time spent waiting
      // for our next turn is not charged against the deadline.
      this._clock.compute += now - this._clock.sliceStart;
      await yieldToEventLoop();
      const resumed = performance.now();
      this._clock.sliceStart = resumed;
      this._clock.lastYield = resumed;
      if (this._clock.clientGone) {
        this.log(`Operation abandoned @ ${place}: client disconnected`);
        const error = new Issue("error", "too-costly", null, null,
            `Operation abandoned at ${place}: the client disconnected before the response was ready`, "too-costly", 422);
        error.abandoned = true;
        error.diagnostics = this.diagnostics();
        throw error;
      }
    }
  }

  /**
   * Await something this operation does not itself compute - typically a
   * shared structure another request is building - without charging the wait
   * to the compute deadline. The current compute slice is closed before
   * waiting and a new one opened after; aborts if the client disconnected
   * meanwhile.
   *
   * @param {Promise} promise
   * @param {string} place - Location identifier for debugging
   * @returns {Promise<*>} what the promise resolves to
   */
  async waitFor(promise, place = 'unknown') {
    const now = performance.now();
    this._clock.compute += now - this._clock.sliceStart;
    let result;
    try {
      result = await promise;
    } finally {
      const resumed = performance.now();
      this._clock.sliceStart = resumed;
      this._clock.lastYield = resumed;
    }
    if (this._clock.clientGone) {
      this.log(`Operation abandoned @ ${place}: client disconnected`);
      const error = new Issue("error", "too-costly", null, null,
          `Operation abandoned at ${place}: the client disconnected before the response was ready`, "too-costly", 422);
      error.abandoned = true;
      error.diagnostics = this.diagnostics();
      throw error;
    }
    return result;
  }

  unSeeAll() {
    this.contexts = [];
  }

  /**
   * Track a context URL and detect circular references
   * @param {string} vurl - Value set URL to track
   */
  seeContext(vurl) {
    if (this.contexts.includes(vurl)) {
      const contextList = '[' + this.contexts.join(', ') + ']';
      throw new Issue("error", "processing", null, 'VALUESET_CIRCULAR_REFERENCE', this.i18n.formatMessage(this.langs, 'VALUESET_CIRCULAR_REFERENCE', [vurl, contextList]), "vs-invalid").handleAsOO(400);
    }
    this.contexts.push(vurl);
  }

  /**
   * Clear all tracked contexts
   */
  clearContexts() {
    this.contexts = [];
  }

  /**
   * Add a log entry with timestamp
   * @param {string} note - Log message
   */
  log(note) {
    const elapsed = Math.round(performance.now() - this.startTime);
    const logEntry = `${elapsed}ms ${note}`;
    this.logEntries.push(logEntry);
    this.timeTracker.step(note);
  }

  /**
   * Add a note specific to a value set
   * @param {Object} vs - Value set object (should have vurl property)
   * @param {string} note - Note to add
   */
  addNote(vs, note) {
    const vurl = vs && vs.vurl ? vs.vurl : 'unknown-valueset';
    const elapsed = Math.round(performance.now() - this.startTime);
    const logEntry = `${elapsed}ms ${vurl}: ${note}`;
    this.logEntries.push(logEntry);
    this.timeTracker.step(`${vurl}: ${note}`);
  }

  /**
   * Get diagnostic information including timing and logs
   * @returns {string}
   */
  diagnostics() {
    return this.timeTracker.log();
  }

  /**
   * Execute and time an async operation, logging if it exceeds threshold
   * @param {string} name - Operation name for logging
   * @param {Function} fn - Async function to execute
   * @param {number} warnThreshold - Log warning if operation exceeds this ms (default 50)
   * @returns {*} Result of the function
   */
  async timed(name, fn, warnThreshold = 50) {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      const duration = performance.now() - start;
      if (duration > warnThreshold) {
        this.log(`SLOW: ${name} took ${Math.round(duration)}ms`);
      }
    }
  }

  /**
   * Get elapsed time since operation started
   * @returns {number} Elapsed time in milliseconds
   */
  elapsed() {
    return performance.now() - this.startTime;
  }

  /**
   * Get the request ID
   * @returns {string}
   */
  get reqId() {
    return this.id;
  }

  /**
   * Register a code-system provider whose resources (typically a sqlite
   * connection opened by factory.build()) should be released when the
   * operation ends. Providers without a close() method are ignored.
   * @param {Object} provider - The provider returned from factory.build()
   */
  registerProvider(provider) {
    if (provider && typeof provider.close === 'function') {
      this._openProviders.push(provider);
    }
  }

  /**
   * Close every provider registered during this operation. Safe to call
   * multiple times — the list is cleared after the first call. Errors
   * from individual close() calls are swallowed so one bad provider can't
   * prevent the others from releasing their resources.
   */
  async closeProviders() {
    if (!this._openProviders || this._openProviders.length === 0) return;
    const providers = this._openProviders;
    this._openProviders = [];
    for (const p of providers) {
      try {
        await p.close();
      } catch (_e) {
        // Swallow — provider cleanup is best-effort.
      }
    }
  }

  /**
   * @type {Languages} languages specified in request
   */
  langs;
}

/**
 * Version rule modes for expansion parameters
 */
const ExpansionParamsVersionRuleMode = {
  DEFAULT: 0,
  CHECK: 1,
  OVERRIDE: 2
};

module.exports = {
  OperationContext,
  ExpansionParamsVersionRuleMode,
  TimeTracker,
  ResourceCache,
  ExpansionCache,
  isDebugging,
  debugLog,
  formatDuration
};