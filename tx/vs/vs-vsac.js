const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { AbstractValueSetProvider } = require('./vs-api');
const { ValueSetDatabase } = require('./vs-database');
const { VersionUtilities } = require('../../library/version-utilities');
const folders = require('../../library/folder-setup');
const {debugLog} = require("../operation-context");
const { applyIdPrefix, stripIdPrefix } = require("../library/resource-ids");

// Persisted watermark for the phase-1b _lastUpdated scan.
const VSAC_LAST_UPDATED_KEY = 'vsac_last_updated_date';
// Phase-2 work list of the sync in progress, and how far through it the sync has got.
// Both are cleared when a run completes; if they are still there, the last run was
// interrupted (server stopped) or failed, and the next run picks up what it didn't finish.
const VSAC_PENDING_QUEUE_KEY = 'vsac_pending_queue';
const VSAC_PENDING_PROGRESS_KEY = 'vsac_pending_progress';

// The longest delay a Node timer accepts; a longer one fires after 1 ms.
const MAX_TIMER_MS = 2 ** 31 - 1;

// A follower (cluster.md) compares its generation with the database's at most this often,
// when a request uses the value sets
const GENERATION_CHECK_MS = 1000;

// Canonical URL prefix for VSAC value sets, so operators can enter a bare OID.
const VSAC_VALUESET_URL_PREFIX = 'http://cts.nlm.nih.gov/fhir/ValueSet/';

// Default size of the cache of recently used value sets (see RecentValueSets)
const DEFAULT_VALUESET_CACHE_MB = 64;

/**
 * The value sets most recently read from the database, parsed and prepared, by row id, with
 * the least recently used dropped first once the stored JSON they were read from adds up to
 * more than maxBytes.
 *
 * Reading a value set means parsing its JSON every time: 15ms for a list of 33,000 codes, and
 * $batch-validate-code reads it once per entry. Most use is of a few value sets over and over,
 * so the ones in use are kept. The sync drops a row from here when it writes it, so what is
 * kept is never older than the database (each keeps the contentHash it was read with).
 *
 * What is kept is shared between requests (as the map was): it must not be changed.
 */
class RecentValueSets {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.entries = new Map(); // id -> { vs, bytes }, least recently used first
    this.bytes = 0;
    // changes whenever the sync drops anything (delete, deleteUrl, clear), so a read that started
    // before is not kept (see _readValueSet). Keeping a value set or dropping one to make room
    // doesn't change it: reads of other value sets under way at the same time are still kept.
    this.generation = 0;
  }

  get size() {
    return this.entries.size;
  }

  /** The value set for a row id, which is now the most recently used; undefined if it isn't kept */
  get(id) {
    const entry = this.entries.get(id);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.vs;
  }

  /** The value set for a row id, without making it any more recently used */
  peek(id) {
    const entry = this.entries.get(id);
    return entry ? entry.vs : undefined;
  }

  set(id, vs, bytes) {
    this._drop(id);
    if (!(bytes >= 0) || bytes > this.maxBytes) {
      return;
    }
    this.entries.set(id, { vs, bytes });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes) {
      this._drop(this.entries.keys().next().value);
    }
  }

  delete(id) {
    this.generation++;
    this._drop(id);
  }

  deleteUrl(url) {
    this.generation++;
    for (const [id, entry] of this.entries) {
      if (entry.vs.url === url) {
        this._drop(id);
      }
    }
  }

  clear() {
    this.generation++;
    this.entries.clear();
    this.bytes = 0;
  }

  /** Removes a row without changing the generation: what the sync drops goes through delete */
  _drop(id) {
    const entry = this.entries.get(id);
    if (entry) {
      this.entries.delete(id);
      this.bytes -= entry.bytes;
    }
  }
}

/**
 * VSAC (Value Set Authority Center) ValueSet provider
 * Fetches and caches ValueSets from the NLM VSAC FHIR server
 */
class VSACValueSetProvider extends AbstractValueSetProvider {
  SYNC_AT_START_UP = false;

  // A value set asked for at a version VSAC doesn't have is not found, as for value sets from
  // packages (#94). It used to be answered from the latest version: set this to true to go back
  // to that
  static VERSION_FALLBACK_TO_LATEST = false;

  /**
   * @param {Object} config - Configuration object
   * @param {string} config.apiKey - API key for VSAC authentication
   * @param {string} config.cacheFolder - Local folder for cached database
   * @param {number} [config.refreshIntervalHours=24] - Hours between refresh scans
   * @param {string} [config.baseUrl='https://cts.nlm.nih.gov/fhir'] - Base URL for VSAC FHIR server
   * @param {number} [config.timeoutMs=120000] - HTTP request timeout in milliseconds
   * @param {string} [config.resyncPassword] - If set, enables the operator "resync a ValueSet"
   *   form on the /info page, gated by this password. If unset, the form is not offered.
   * @param {number} [config.valueSetCacheMB=64] - Size (of their stored JSON) of the recently used
   *   value sets kept parsed (see RecentValueSets); 0 for none. This is measured in stored JSON,
   *   not memory: parsed, they take several times this much heap, and in cluster mode each
   *   worker has its own
   * @param {string} [config.cluster] - set by --role (library/role.js), else absent: 'leader'
   *   (the master) syncs, and bumps the database's generation after each sync; 'follower' (a
   *   tx-worker) never syncs, and catches up when the generation moves (catchUp)
   */
  constructor(config, stats) {
    super();
    this.stats = stats;

    if (!config.apiKey) {
      throw new Error('VSAC API key is required');
    }

    this.apiKey = config.apiKey;
    // Optional operator password for the on-demand resync form (see info()).
    this.resyncPassword = config.resyncPassword || null;
    this.cacheFolder = folders.ensureFolder("terminology-cache", "vsac");
    // https: every request carries the API key. (VSAC redirects http to https, but only after
    // the key has been sent in the clear)
    this.baseUrl = (config.baseUrl || 'https://cts.nlm.nih.gov/fhir').replace(/\/+$/, '');
    if (this.baseUrl.startsWith('http://')) {
      console.warn(`VSAC: baseUrl ${this.baseUrl} is http, so the API key is sent unencrypted - use https`);
    }
    this.refreshIntervalHours = config.refreshIntervalHours || 24;
    this.valueSetCacheMB = config.valueSetCacheMB ?? DEFAULT_VALUESET_CACHE_MB;

    this.dbPath = path.join(this.cacheFolder, 'vsac-valuesets.db');
    this.cluster = config.cluster || null;
    this.database = new ValueSetDatabase(this.dbPath, { shared: !!this.cluster });
    // The value sets aren't held in memory: each one is read from the database when it is
    // asked for (see fetchValueSet), apart from the recently used ones (see RecentValueSets).
    // This is the count of urls as of the last recount
    this.urlCount = 0;
    // a follower: the generation it last caught up with (null: not yet - the master hasn't
    // made the database), and when it last compared
    this.loadedGeneration = null;
    this.generationCheckedAt = 0;
    this.catchingUp = null;
    this.initialized = false;
    this.refreshTimer = null;
    this.isRefreshing = false;
    this.lastRefresh = null;

    // HTTP client with authentication - manually create Basic auth header
    const authString = Buffer.from(`apikey:${this.apiKey}`).toString('base64');
    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      timeout: config.timeoutMs || 120000,
      headers: {
        'Accept': 'application/fhir+json',
        'User-Agent': 'FHIR-ValueSet-Provider/1.0',
        'Authorization': `Basic ${authString}`
      }
    });
  }

  code() {
    return "vsac";
  }

  // the recently used value sets were read from this database: another one starts with none
  get database() {
    return this._database;
  }

  set database(database) {
    this._database = database;
    if (this._recent) {
      this._recent.clear();
    }
  }

  /**
   * The recently used value sets (made when first needed)
   * @returns {RecentValueSets}
   * @private
   */
  _recentValueSets() {
    if (!this._recent) {
      this._recent = new RecentValueSets((this.valueSetCacheMB ?? DEFAULT_VALUESET_CACHE_MB) * 1024 * 1024);
    }
    return this._recent;
  }

  sourcePackage() {
    return "vsac";
  }

  /**
   * Initialize the provider - setup database and start refresh cycle
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) {
      return;
    }
    if (this.cluster === 'follower') {
      // the master creates the database and syncs; this process only reads
      if (await this.database.exists()) {
        await this._followDatabase();
      }
      this.initialized = true;
      return;
    }
    // initialize() is re-entered by lookups while the first call is still syncing; only
    // the first call checks for (and resumes) an incomplete sync
    const firstCall = !this._startupChecked;
    this._startupChecked = true;
    this.stats.addTask('VSAC Sync', `${this.refreshIntervalHours} hours`);

    // Create database if it doesn't exist
    if (!(await this.database.exists())) {
      await this.database.create();
    }
    // Schema migrations are applied lazily by the database layer on first
    // connection. Count what is there (none, for a new database), so a
    // database with no value sets is synced now rather than at the first timer
    await this._recount();
    const incomplete = firstCall ? await this._incompleteSyncReason() : null;
    let failed = false;
    let synced = false;
    if (this.SYNC_AT_START_UP || this.database.vsCount == 0 || incomplete) {
      if (incomplete) {
        console.log(`VSAC: ${incomplete} - resuming the sync now`);
      }
      synced = true;
      try {
        await this.refreshValueSets();
      } catch (error) {
        // already recorded by refreshValueSets; the timer below retries it soon
        console.error(`VSAC: sync at startup failed: ${error.message}`);
        failed = true;
        this._failedSyncs = 1;
      }
    }
    // Start periodic refresh; after a failed sync, the next try comes after a short wait,
    // and without a sync now, the next is due an interval after the last one (not after now)
    let next;
    if (failed) {
      next = { delayMs: this._retryDelayMs(1), why: 'retrying the failed sync' };
    } else if (synced) {
      next = { delayMs: this._refreshIntervalMs(), why: 'synced at startup' };
    } else {
      next = await this._firstRefreshDelay();
    }
    console.log(`VSAC: next sync due at ${new Date(Date.now() + next.delayMs).toISOString()} (${next.why})`);
    this._startRefreshTimer(next.delayMs);
    this.initialized = true;
  }

  /**
   * The wait before the first scheduled sync when initialize() didn't sync: the refresh
   * interval after the last sync, as recorded in vsac_runs, rather than after this start (a
   * server restarted more often than the interval would otherwise never sync). The whole
   * interval when no sync is recorded, or the last one didn't work. Sets lastRefresh to the
   * recorded time, so getStatistics() reports when the next sync is due
   * @returns {Promise<{delayMs: number, why: string}>}
   * @private
   */
  async _firstRefreshDelay() {
    const intervalMs = this._refreshIntervalMs();
    const lastRun = await this.database.getLastRun();
    if (!lastRun || lastRun.status !== 'ok' || !lastRun.finished_at) {
      return { delayMs: intervalMs, why: 'no completed sync recorded' };
    }
    // finished_at is in seconds (strftime('%s'))
    const finished = lastRun.finished_at * 1000;
    this.lastRefresh = new Date(finished);
    return {
      delayMs: Math.max(0, finished + intervalMs - Date.now()),
      why: `the last sync finished at ${this.lastRefresh.toISOString()}`
    };
  }

  /**
   * Whether the last sync didn't finish: it was cut short when the server stopped (its
   * run is still marked 'running', or its work list is still saved), or it failed.
   * Runs left marked 'running' are closed off as interrupted.
   * @returns {Promise<string|null>} why a sync is needed now, or null if the last one completed
   * @private
   */
  async _incompleteSyncReason() {
    const lastRun = await this.database.getLastRun();
    const interrupted = await this.database.markInterruptedRuns();
    if (interrupted > 0) {
      return 'the last sync was interrupted';
    }
    if ((await this.database.getSetting(VSAC_PENDING_QUEUE_KEY)) != null) {
      return 'the last sync did not finish';
    }
    if (lastRun && lastRun.status === 'error') {
      return 'the last sync failed';
    }
    return null;
  }

  /**
   * The URLs an interrupted or failed run didn't get through: the in-flight URL and
   * everything after it, plus first-pass failures it hadn't retried yet.
   * @returns {Promise<string[]>}
   * @private
   */
  async _loadPendingQueue() {
    try {
      const queue = JSON.parse(await this.database.getSetting(VSAC_PENDING_QUEUE_KEY) || '[]');
      const progress = JSON.parse(await this.database.getSetting(VSAC_PENDING_PROGRESS_KEY) || '{}');
      if (!Array.isArray(queue)) {
        return [];
      }
      const requeue = Array.isArray(progress.requeue) ? progress.requeue : [];
      return [...requeue.slice(progress.requeueDone || 0), ...queue.slice(progress.done || 0)];
    } catch (error) {
      debugLog(error);
      return [];
    }
  }

  /**
   * Save the phase-2 work list, so a restart can pick up where this run stops
   * @private
   */
  async _savePendingQueue(queue) {
    await this.database.setSetting(VSAC_PENDING_QUEUE_KEY, JSON.stringify(queue));
    await this._savePendingProgress({ done: 0, requeue: [], requeueDone: 0 });
  }

  /**
   * @param {{done: number, requeue: string[], requeueDone: number}} progress - first-pass
   *   URLs processed, the URLs that failed and are waiting for a retry, and retries done
   * @private
   */
  async _savePendingProgress(progress) {
    await this.database.setSetting(VSAC_PENDING_PROGRESS_KEY, JSON.stringify(progress));
  }

  /**
   * @private
   */
  async _clearPendingQueue() {
    await this.database.deleteSetting(VSAC_PENDING_QUEUE_KEY);
    await this.database.deleteSetting(VSAC_PENDING_PROGRESS_KEY);
  }

  /**
   * Waits before trying a failed sync again: 1, 5 and then every 30 minutes (never longer
   * than the refresh interval). A failure at startup is often passing (the network is not
   * up yet, or a connection attempt timed out while the server was busy loading), so it
   * should not wait a whole day.
   */
  static RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 30 * 60 * 1000];

  /**
   * @param {number} failures - failed syncs in a row (1 or more)
   * @returns {number} milliseconds to wait before the next try
   * @private
   */
  _retryDelayMs(failures) {
    const delays = VSACValueSetProvider.RETRY_DELAYS_MS;
    const delay = delays[Math.min(failures, delays.length) - 1];
    return Math.min(delay, this._refreshIntervalMs());
  }

  /**
   * Start the refresh timer. Each sync sets the timer for the next one, whether it worked
   * or not: the refresh interval after a sync that worked, a shorter wait after one that
   * failed (see RETRY_DELAYS_MS).
   * @param {number} [delayMs] - wait before the next sync (default: the refresh interval)
   * @private
   */
  _startRefreshTimer(delayMs = undefined) {
    this._stopped = false;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    const intervalMs = this._refreshIntervalMs();
    this.refreshTimer = setTimeout(async () => {
      let next = intervalMs;
      try {
        await this.refreshValueSets();
        this._failedSyncs = 0;
      } catch (error) {
        debugLog(error);
        this._failedSyncs = (this._failedSyncs || 0) + 1;
        next = this._retryDelayMs(this._failedSyncs);
        console.error(`VSAC: scheduled sync failed (next try in ${Math.round(next / 60000)} min): ${error.message}`);
      } finally {
        if (!this._stopped) {
          this._startRefreshTimer(next);
        }
      }
    }, delayMs ?? intervalMs);
  }

  /**
   * The refresh interval in ms. Node runs a timer whose delay is above 2^31-1 ms (about 596 hours)
   * or not a positive number after 1 ms instead, so the refresh would run back to back: such a
   * setting is clamped (or, when it isn't a positive number, replaced by the 24 hour default).
   * @private
   */
  _refreshIntervalMs() {
    const hours = Number(this.refreshIntervalHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      console.warn(`VSAC: refreshIntervalHours ${this.refreshIntervalHours} is not a positive number; using 24`);
      return 24 * 60 * 60 * 1000;
    }
    const ms = hours * 60 * 60 * 1000;
    if (ms > MAX_TIMER_MS) {
      console.warn(`VSAC: refreshIntervalHours ${hours} is longer than a timer can wait; using ${Math.floor(MAX_TIMER_MS / 3600000)} hours`);
      return MAX_TIMER_MS;
    }
    return ms;
  }

  /**
   * Stop the refresh timer (for cleanup)
   */
  stopRefreshTimer() {
    this._stopped = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Perform a full refresh of ValueSets from the server
   * @returns {Promise<void>}
   */
  async refreshValueSets() {
    this.stats.task('VSAC Sync', 'running');
    if (this.isRefreshing) {
      console.log('Refresh already in progress, skipping');
      return;
    }
    this.queue = [];
    this._pendingLastUpdated = null;

    this.isRefreshing = true;
    const runId = await this.database.startRun();

    try {
      // phase 1: list all value sets
      console.log('Starting VSAC ValueSet refresh...');

      // This lists all the currently valid value sets by URL, but not the older versions
      let url = '/ValueSet?_offset=0&_count=1000&_elements=id,url,version,status';
      const known = await this.database.listVersionKeys();

      let total = undefined;
      let count = 0;
      let ncount = 0;

      while (url) {
        console.log(`Sync: ${count} of ${total} - ${ncount} new`);
        this.stats.task('VSAC Sync', `Sync: ${count} of ${total} - ${ncount} new`);

        const bundle = await this._fetchBundle(url);

        if (!total) {
          total = bundle.total;
        }
        for (let be of bundle.entry || []) {
          let vs = be.resource;
          if (vs) {
            count++;
            // if we've seen this value set before, then we've got nothing new here.
            if (!known.has(vs.url+"|"+vs.version)) {
              this.queue.push(vs.url);
              ncount++;
            }
          }
        }
        // Find next link
        url = this._getNextUrl(bundle);

        // Safety check against infinite loops
        if (count > total) {
          console.log(`Reached total count (${total}), stopping`);
          break;
        }
      }

      this.lastRefresh = new Date();
      console.log(`VSAC refresh phase 1 done. Total: ${count} with ${ncount} new items`);
      this.stats.task('VSAC Sync', `VSAC refresh phase 1 done. Total: ${count} with ${ncount} new items`);

      // phase 1b: query for recently updated value sets via _lastUpdated
      let lastUpdatedCount = await this._scanLastUpdated();
      console.log(`VSAC refresh phase 1b done. ${lastUpdatedCount} additional items from _lastUpdated`);
      this.stats.task('VSAC Sync', `Phase 1b: ${lastUpdatedCount} from _lastUpdated`);

      // Pick up what an interrupted or failed run didn't finish. Phase 1 only queues a
      // URL whose current version is missing, so a URL that was part way through its
      // versions would otherwise be missed. The leftovers go first, and the deduplicated
      // queue is saved so that a restart can carry on from here.
      const leftover = await this._loadPendingQueue();
      if (leftover.length > 0) {
        console.log(`VSAC: resuming ${leftover.length} value set(s) left over from the last sync`);
        this.stats.task('VSAC Sync', `Resuming ${leftover.length} left over from the last sync`);
      }
      this.queue = [...new Set([...leftover, ...this.queue])];
      await this._savePendingQueue(this.queue);

      let tracking = { totalFetched: 0, totalNew: 0, totalUpdated: 0, count: 0, newCount : 0 };
      // URLs that fail even after a requeue are permanently dropped this run; we
      // hold the watermark back when this is non-zero so they get re-scanned.
      let permanentFailures = 0;
      // phase 2: query for history & content
      this.requeue = [];
      const progress = { done: 0, requeue: this.requeue, requeueDone: 0 };
      for (let q of this.queue) {
        this.stats.task('VSAC History for '+q, `running (${tracking.totalFetched} fetched, ${tracking.totalNew} new, ${tracking.totalUpdated} updated)`);
        try {
          await this.processContentAndHistory(q, tracking, this.queue.length);
        } catch (error) {
          this.requeue.push(q)
          debugLog(error);
          this.stats.task('VSAC Sync', error.message);
        }
        tracking.count++;
        progress.done++;
        await this._savePendingProgress(progress);
      }
      console.log("Requeue");
      for (let q of this.requeue) {
        this.stats.task('VSAC History for '+q, `running (${tracking.totalFetched} fetched, ${tracking.totalNew} new, ${tracking.totalUpdated} updated)`);
        try {
          await this.processContentAndHistory(q, tracking, this.requeue.length);
        } catch (error) {
          permanentFailures++;
          debugLog(error);
          this.stats.task('VSAC Sync', error.message);
        }
        tracking.count++;
        progress.requeueDone++;
        await this._savePendingProgress(progress);
      }

      // the followers catch up when they see the generation move
      if (this.cluster) {
        await this.database.bumpGeneration();
      }
      // Recount, with the fresh data
      await this._recount();

      // Commit the _lastUpdated watermark only now that phase 2 has durably
      // written everything. Hold it back if any URL was permanently dropped, so
      // those URLs are re-scanned next run (never advance past un-applied
      // changes). If the run threw or the process restarted before this point,
      // the watermark is left untouched and the window is re-scanned.
      if (this._pendingLastUpdated && permanentFailures === 0) {
        await this.database.setSetting(VSAC_LAST_UPDATED_KEY, this._pendingLastUpdated);
      } else if (permanentFailures > 0) {
        const holdMsg = `Holding _lastUpdated watermark: ${permanentFailures} URL(s) failed after retry; will re-scan next run`;
        console.log(holdMsg);
        this.stats.task('VSAC Sync', holdMsg);
      }
      // the work list is done (URLs that failed twice are re-found through the held watermark)
      await this._clearPendingQueue();

      let msg = `VSAC refresh completed. Total: ${tracking.totalFetched} ValueSets, New: ${tracking.totalNew}, Updated: ${tracking.totalUpdated}`;
      this.stats.taskDone('VSAC Sync', msg);
      console.log(msg);

      await this.database.finishRun(runId, tracking.totalFetched, tracking.totalNew, tracking.totalUpdated);
    } catch (error) {
      debugLog(error, 'Error during VSAC refresh:');
      this.stats.taskError('VSAC Sync', `Error (${error.message})`);
      await this.database.failRun(runId, error.message);
      if (this.cluster) {
        // what the run wrote before it failed is in the database
        await this.database.bumpGeneration();
      }
      throw error;
    } finally {
      this.isRefreshing = false;
      // each row written was dropped as it was written; start again anyway after a full sync
      this._recentValueSets().clear();
    }
  }

  /**
   * Compute a SHA-256 hash of the ValueSet content for change detection.
   * @param {Object} vs - The ValueSet resource (plain JSON object)
   * @returns {string} hex-encoded SHA-256
   * @private
   */
  _hashValueSet(vs) {
    return crypto.createHash('sha256').update(JSON.stringify(vs)).digest('hex');
  }

  /**
   * Insert multiple ValueSets in a batch operation.
   * For each value set: if url|version is already known, compare content hashes.
   *   - hash unchanged  -> touch last_seen only (seeValueSet)
   *   - hash changed    -> upsert and record an 'updated' event
   *   - not seen before -> upsert and record a 'new' event
   * @param {Array<Object>} valueSets - Array of ValueSet resources
   * @returns {Promise<{newCount: number, updatedCount: number}>}
   */
  async batchUpsertValueSets(valueSets) {
    if (valueSets.length === 0) {
      return { newCount: 0, updatedCount: 0 };
    }

    let newCount = 0;
    let updatedCount = 0;

    // Process sequentially to avoid database locking
    for (const valueSet of valueSets) {
      const existing = valueSet.version ? await this.database.getVersion(valueSet.url, valueSet.version) : undefined;
      const newHash = this._hashValueSet(valueSet);

      if (existing) {
        // We've seen this url|version before. Decide whether the content
        // has actually changed by comparing hashes.
        //
        // Note: the value sets served are altered after they are read (_prepare
        // strips inc.version from compose.include/exclude), so the hash is
        // the one stored with the original unmutated JSON. For rows predating this feature
        // (content_hash NULL), we defer update detection until the next cycle:
        // the upsert below runs only when hashes differ, so on the *next*
        // sync after migration we'll have a proper baseline.
        if (existing.content_hash && existing.content_hash === newHash) {
          // No change - just touch last_seen
          await this.database.seeValueSet(valueSet);
        } else if (!existing.content_hash) {
          // Legacy row without a stored hash - backfill the hash silently
          // without emitting a spurious 'updated' event. We do a lightweight
          // touch + hash update rather than a full upsert+event.
          await this.database.seeValueSet(valueSet);
          await this.database.setContentHash(valueSet.id, newHash);
          this._recentValueSets().delete(existing.id);
        } else {
          // Content has changed - treat as update
          await this.database.upsertValueSet(valueSet, newHash);
          this._recentValueSets().delete(existing.id);
          this._recentValueSets().delete(valueSet.id);
          await this.database.recordEvent('updated', valueSet.url, valueSet.version);
          updatedCount++;
        }
      } else {
        await this.database.upsertValueSet(valueSet, newHash);
        this._recentValueSets().delete(valueSet.id);
        await this.database.recordEvent('new', valueSet.url, valueSet.version);
        newCount++;
      }
    }
    return { newCount, updatedCount };
  }

  /**
   * Fetch a FHIR Bundle from the server
   * @param {string} url - Relative URL to fetch
   * @returns {Promise<Object>} FHIR Bundle
   * @private
   */
  async _fetchBundle(url) {
    try {
      const response = await this.httpClient.get(url);

      if (response.data && response.data.resourceType === 'Bundle') {
        return response.data;
      } else {
        throw new Error('VSAC Response is not a FHIR Bundle');
      }
    } catch (error) {
      if (error.response) {
        throw new Error(`HTTP ${error.response.status}: ${error.response.statusText}`);
      } else if (error.request) {
        throw new Error('Network error: No response received');
      } else {
        throw new Error(`Request error: ${error.message}`);
      }
    }
  }

  /**
   * Fetch a FHIR Bundle from the server
   * @param {string} url - Relative URL to fetch
   * @returns {Promise<Object>} FHIR Bundle
   * @private
   */
  async _fetchValueSet(id) {
    try {
      const response = await this.httpClient.get("/ValueSet/"+id);

      if (response.data && response.data.resourceType === 'ValueSet') {
        return response.data;
      } else {
        throw new Error('VSAC Response is not a FHIR ValueSet');
      }
    } catch (error) {
      if (error.response) {
        throw new Error(`HTTP ${error.response.status}: ${error.response.statusText}`);
      } else if (error.request) {
        throw new Error('Network error: No response received');
      } else {
        throw new Error(`Request error: ${error.message}`);
      }
    }
  }

  /**
   * Extract the next URL from a FHIR Bundle's link array
   * @param {Object} bundle - FHIR Bundle
   * @returns {string|null} Next URL or null if no more pages
   * @private
   */
  _getNextUrl(bundle) {
    if (!bundle.link || !Array.isArray(bundle.link)) {
      return null;
    }

    const nextLink = bundle.link.find(link => link.relation === 'next');
    if (!nextLink || !nextLink.url) {
      return null;
    }

    // Followed only on the VSAC server itself, as a path under baseUrl: the request carries the
    // API key, so a next link must not be able to send it anywhere else. The scheme is ignored -
    // VSAC's links can say http - and the request goes out on baseUrl's
    let next;
    let base;
    try {
      base = new URL(this.baseUrl);
      next = new URL(nextLink.url, this.baseUrl + '/');
    } catch (e) {
      console.warn(`VSAC: ignoring next link ${String(nextLink.url).substring(0, 200)}: ${e.message}`);
      return null;
    }
    const basePath = base.pathname.replace(/\/+$/, '');
    if (next.host !== base.host || !(next.pathname === basePath || next.pathname.startsWith(basePath + '/'))) {
      console.warn(`VSAC: ignoring next link ${String(nextLink.url).substring(0, 200)}: it is not on ${this.baseUrl}`);
      return null;
    }
    return next.pathname.substring(basePath.length) + next.search;
  }

  /**
   * Refresh the counts from the database (the value sets themselves are read on demand)
   * @returns {Promise<void>}
   * @private
   */
  async _recount() {
    const counts = await this.database.countValueSets();
    this.urlCount = counts.urls;
  }

  /**
   * Read a value set from the database and make it ready to serve: the compose doesn't pin
   * code system versions, and the id is in this provider's id space
   * @param {string} id - the value set's own id
   * @returns {Promise<ValueSet|null>}
   * @private
   */
  async _loadValueSet(id) {
    const vs = await this.database.loadValueSet(id, this.sourcePackage());
    if (vs) {
      this._prepare(vs);
    }
    return vs;
  }

  /**
   * A value set by row id, from the recently used ones if it is there, or else read (and kept)
   * @param {string} id - the value set's own id
   * @returns {Promise<ValueSet|null>} shared with other requests: not to be changed
   * @private
   */
  async _readValueSet(id) {
    const recent = this._recentValueSets();
    let vs = recent.get(id);
    if (vs) {
      return vs;
    }
    // if the sync drops anything while this is read, what is read may be older than the database
    const generation = recent.generation;
    vs = await this._loadValueSet(id);
    if (vs && recent.generation === generation) {
      recent.set(id, vs, vs.storedLength);
    }
    return vs;
  }

  _prepare(vs) {
    if (vs.jsonObj.compose) {
      for (const inc of vs.jsonObj.compose.include || []) {
        if (inc.version) {
          delete inc.version;
        }
      }
      for (const inc of vs.jsonObj.compose.exclude || []) {
        if (inc.version) {
          delete inc.version;
        }
      }
    }
    // the value sets are served in this provider's id space
    applyIdPrefix(vs, this.spaceId);
  }

  /**
   * A follower (cluster.md): bring what this process holds up to date with the database, and
   * remember the generation it is now at. Only the recently used value sets are held, so they
   * are dropped (they may be older than the database now), and the urls recounted. The
   * generation is read first: a sync that finishes meanwhile makes the next check catch up
   * again, never the reverse.
   * @returns {Promise<void>}
   * @private
   */
  async _followDatabase() {
    const generation = await this.database.getGeneration();
    this._recentValueSets().clear();
    await this._recount();
    this.loadedGeneration = generation;
  }

  /**
   * A follower: pick up what the master's sync wrote. At most every GENERATION_CHECK_MS,
   * read the database's generation; if it isn't the one this process last caught up with,
   * catch up (_followDatabase). Runs in the background (requests meanwhile use what they
   * have) and never rejects. Returns the promise of the check, for tests.
   * @returns {Promise<void>}
   */
  catchUp() {
    const now = Date.now();
    if (this.catchingUp || now - this.generationCheckedAt < GENERATION_CHECK_MS) {
      return this.catchingUp || Promise.resolve();
    }
    this.generationCheckedAt = now;
    this.catchingUp = (async () => {
      // not before the master has made it: opening it would create an empty file
      if (this.loadedGeneration === null && !(await this.database.exists())) {
        return;
      }
      const generation = await this.database.getGeneration();
      if (generation !== this.loadedGeneration) {
        console.log(`VSAC: the database is at generation ${generation}, this process at ${this.loadedGeneration}; catching up`);
        await this._followDatabase();
      }
    })().catch((error) => {
      debugLog(error, 'VSAC: catching up with the database failed');
    }).finally(() => {
      this.catchingUp = null;
    });
    return this.catchingUp;
  }

  /**
   * A follower whose master hasn't made the database yet has no value sets; reading would
   * open the file, and so create an empty one. Starts a catch-up check either way.
   * @returns {boolean} true if there is nothing to read yet
   * @private
   */
  _followerHasNoDatabase() {
    if (this.cluster !== 'follower') {
      return false;
    }
    void this.catchUp();
    return this.loadedGeneration === null;
  }

  /**
   * Fetches a value set by URL and version
   * @param {string} url - The canonical URL of the value set
   * @param {string} version - The version of the value set
   * @returns {Promise<Object>} The requested value set
   */
  async fetchValueSet(url, version) {
    await this.initialize();
    this._validateFetchParams(url, version);
    if (this._followerHasNoDatabase()) {
      return null;
    }

    // which row the url (and version) refers to is worked out the way it always was, from a
    // map keyed like the one loadAllValueSets builds - but of just this url's ids and versions
    let rows = await this.database.listVersions(url);
    while (rows.length > 0) {
      const versions = new Map();
      for (const row of rows) {
        this.database.addToMap(versions, row.id, row.url, row.version, row);
      }
      const row = this._findVersion(versions, url, version);
      if (!row) {
        return null;
      }
      const vs = await this._readValueSet(row.id);
      if (vs) {
        return await this.checkFullVS(vs);
      }
      // it was rejected (and logged): as when it couldn't be loaded into the map, it's as if it isn't there
      rows = rows.filter(r => r !== row);
    }
    return null;
  }

  _findVersion(versions, url, version) {
    // Try exact match first: url|version
    let key = `${url}|${version}`;
    if (versions.has(key)) {
      return versions.get(key);
    }

    // If version is semver, try url|major.minor
    try {
      if (VersionUtilities.isSemVer(version)) {
        const majorMinor = VersionUtilities.getMajMin(version);
        if (majorMinor) {
          key = `${url}|${majorMinor}`;
          if (versions.has(key)) {
            return versions.get(key);
          }
        }
      }
    } catch (error) {
      // Ignore version parsing errors
    }

    // Finally try just the URL - only when no version was asked for (see VERSION_FALLBACK_TO_LATEST)
    if ((!version || VSACValueSetProvider.VERSION_FALLBACK_TO_LATEST) && versions.has(url)) {
      return versions.get(url);
    }

    return null;
  }

  async fetchValueSetById(id) {
    if (this._followerHasNoDatabase()) {
      return null;
    }
    const ownId = stripIdPrefix(id, this.spaceId);
    const vs = ownId ? await this._readValueSet(ownId) : null;
    return vs && vs.id === id ? await this.checkFullVS(vs) : null;
  }
  /**
   * Searches for value sets based on criteria
   * @param {Array<{name: string, value: string}>} searchParams - Search criteria
   * @returns {Promise<Array<Object>>} List of matching value sets
   */
  async searchValueSets(searchParams, elements) {
    await this.initialize();
    this._validateSearchParams(searchParams);
    if (this._followerHasNoDatabase()) {
      return [];
    }

    if (searchParams.length === 0) {
      return [];
    }

    if (elements && elements.length > 0 && elements.every(e => ValueSetDatabase.INDEXED_COLUMNS.includes(e))) {
      // built from the indexed columns, without reading the value sets
      return await this.database.search(this.spaceId, null, searchParams, elements);
    }
    // The matches carry what a search is sorted by; each value set is only read if it is on the
    // page that is returned (see SearchWorker.loadPage)
    return (await this.database.searchRows(searchParams)).map(row => this._searchMatch(row));
  }

  _searchMatch(row) {
    const match = { resourceType: 'ValueSet', id: this.spaceId ? `${this.spaceId}-${row.id}` : row.id };
    for (const name of ['url', 'version', 'date', 'name']) {
      if (row[name] != null) {
        match[name] = row[name];
      }
    }
    // the value set as search would have returned it; null if it is rejected when it is read.
    // A search can match thousands, so what it reads is not kept, and doesn't push out what is
    Object.defineProperty(match, 'load', {
      value: async () => {
        const vs = this._recentValueSets().peek(row.id) || await this._loadValueSet(row.id);
        return vs ? vs.jsonObj : null;
      }
    });
    return match;
  }

  /**
   * Get statistics about the cached ValueSets
   * @returns {Promise<Object>} Statistics object including refresh info
   */
  async getStatistics() {
    await this.initialize();

    const dbStats = await this.database.getStatistics();

    return {
      ...dbStats,
      refreshInfo: {
        lastRefresh: this.lastRefresh,
        isRefreshing: this.isRefreshing,
        refreshIntervalHours: this.refreshIntervalHours,
        nextRefresh: this.refreshTimer && this.lastRefresh
            ? new Date(this.lastRefresh.getTime() + this._refreshIntervalMs())
            : null
      }
    };
  }

  /**
   * Get the number of value sets available (as of the last refresh)
   * @returns {number} Number of unique value set urls
   */
  getMapSize() {
    return this.urlCount;
  }

  /**
   * Force a refresh (useful for testing or manual updates)
   * @returns {Promise<void>}
   */
  async forceRefresh() {
    await this.refreshValueSets();
  }

  /**
   * Check if the provider is currently refreshing
   * @returns {boolean} True if refresh is in progress
   */
  isCurrentlyRefreshing() {
    return this.isRefreshing;
  }

  /**
   * Get the last refresh timestamp
   * @returns {Date|null} Last refresh date or null if never refreshed
   */
  getLastRefreshTime() {
    return this.lastRefresh;
  }

  count() {
    return this.database.vsCount;
  }

  async listAllValueSets() {
    if (this._followerHasNoDatabase()) {
      return [];
    }
    return await this.database.listAllValueSets();
  }

  async scanAllValueSets(fn) {
    if (this._followerHasNoDatabase()) {
      return;
    }
    // the latest version of each url, once (read in batches)
    const versions = new Map();
    for (const row of await this.database.listVersions(null)) {
      let map = versions.get(row.url);
      if (!map) {
        map = new Map();
        versions.set(row.url, map);
      }
      this.database.addToMap(map, row.id, row.url, row.version, row);
    }
    const urls = [...versions.keys()].sort();
    for (let i = 0; i < urls.length; i += 500) {
      const batch = urls.slice(i, i + 500).map(url => ({ url, row: this._findVersion(versions.get(url), url) }));
      const valueSets = await this.database.loadValueSets(batch.map(b => b.row.id), this.sourcePackage());
      for (const b of batch) {
        let vs = valueSets.get(b.row.id);
        if (vs) {
          this._prepare(vs);
        } else {
          vs = await this.fetchValueSet(b.url); // the latest was rejected
        }
        if (vs) {
          await fn(vs);
        }
      }
    }
  }

  async close() {
    this._recentValueSets().clear();
    await this.database.close();
  }

  prefixIds() {
    // nothing is held in memory: each value set gets its prefix as it is read (see _prepare).
    // Anything read before the spaceId was assigned has the wrong id, so start again
    if (this._recent) {
      this._recent.clear();
    }
  }

  // when we get a valueset from vsac via search, the compose is not
  // populated. We don't load all the composes. Instead, when value sets
  // are fetched, we check to see if we've got the compose, and if we
  // haven't, then we fetch it and store it
  async checkFullVS(vs) {
    // if (!vs) {
    //   return null;
    // }
    // if (vs.jsonObj?.compose) {
    //   return vs;
    // }
    // console.log('get a full copy for the ValueSet '+vs.url+'|'+vs.version);
    // let vsNew = await this._fetchValueSet(vs.id);
    // await this.database.upsertValueSet(vsNew);
    // return new ValueSet(vsNew);
    return vs;
  }

  async processContentAndHistory(q, tracking, length) {
    let url = `/ValueSet?url=${q}`;
    const bundle = await this._fetchBundle(url);

    let vcount = 0;
    let perRun = { newCount: 0, updatedCount: 0 };
    if (bundle.entry && bundle.entry.length > 0) {
      // Extract ValueSets from bundle entries
      const valueSets = bundle.entry
          .filter(entry => entry.resource && entry.resource.resourceType === 'ValueSet')
          .map(entry => entry.resource);
      if (valueSets.length > 0) {
        perRun = await this.batchUpsertValueSets(valueSets);
        tracking.totalNew += perRun.newCount;
        tracking.totalUpdated += perRun.updatedCount;
        tracking.totalFetched += valueSets.length;
        vcount = valueSets.length;
      }
    }
    let logMsg = `VSAC (${tracking.count} of ${length}) ${q}: ${vcount} versions (${perRun.newCount} new, ${perRun.updatedCount} updated)`;
    console.log(logMsg);
    this.stats.task('VSAC Sync', logMsg);
  }

  /**
   * Scan VSAC for recently updated value sets using the _lastUpdated parameter.
   * Uses a stored date from the previous run; if none exists, defaults to 4 days ago.
   * Adds any found URLs to this.queue and stores the server's response date for next time.
   * @returns {Promise<number>} Number of value set URLs added to the queue
   * @private
   */
  async _scanLastUpdated() {
    let sinceDate = await this.database.getSetting(VSAC_LAST_UPDATED_KEY);
    if (!sinceDate) {
      // No stored date — default to 10 days ago
      const d = new Date();
      d.setDate(d.getDate() - 10);
      sinceDate = d.toISOString();
    }

    let url = `/res/ValueSet/?_lastUpdated=ge${sinceDate}&_offset=0&_count=100&_elements=id,url,version,status`;
    let count = 0;
    let serverDate = null;

    while (url) {
      console.log(`_lastUpdated scan: ${count} found so far`);
      this.stats.task('VSAC Sync', `_lastUpdated scan: ${count} found`);

      const bundle = await this._fetchBundle(url);

      // Capture the server's lastUpdated from the first page
      if (!serverDate && bundle.meta && bundle.meta.lastUpdated) {
        serverDate = bundle.meta.lastUpdated;
      }

      for (let be of bundle.entry || []) {
        let vs = be.resource;
        if (vs && vs.url) {
          this.queue.push(vs.url);
          count++;
        }
      }

      url = this._getNextUrl(bundle);
    }

    // Capture the server's date but do NOT commit the watermark here. It must
    // only advance once phase 2 has durably upserted the queued URLs; committing
    // it now (before phase 2) means a phase-2 failure or a process restart would
    // move the watermark past URLs that were never written, stranding them
    // permanently. refreshValueSets() commits this._pendingLastUpdated after
    // phase 2 completes with no dropped URLs.
    this._pendingLastUpdated = serverDate;

    return count;
  }

  name() {
    return "VSAC";
  }

  infoName() {
    return "history";
  }

  /**
   * Whether the on-demand resync form is enabled (a resyncPassword is configured).
   */
  _resyncEnabled() {
    // a follower doesn't write: the info pages are routed to the master
    return !!this.resyncPassword && this.cluster !== 'follower';
  }

  /**
   * Timing-safe comparison of a provided password against the configured one.
   * @private
   */
  _passwordMatches(provided) {
    if (!this.resyncPassword) {
      return false;
    }
    const a = Buffer.from(String(provided == null ? '' : provided));
    const b = Buffer.from(String(this.resyncPassword));
    if (a.length !== b.length) {
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Immediately resync a single ValueSet URL (all versions): fetch from VSAC,
   * upsert, and recount.
   * @param {string} url - the ValueSet canonical url
   * @returns {Promise<number>} number of versions fetched
   */
  async resyncValueSet(url) {
    const tracking = { totalFetched: 0, totalNew: 0, totalUpdated: 0, count: 0, newCount: 0 };
    await this.processContentAndHistory(url, tracking, 1);
    if (this.cluster) {
      await this.database.bumpGeneration();
    }
    // the rows written were dropped as they were written; an operator asking expects none kept
    this._recentValueSets().deleteUrl(url);
    await this._recount();
    return tracking.totalFetched;
  }

  /**
   * Handle a POST from the resync form. Validates the password (timing-safe) and,
   * if a full sync isn't already running, resyncs the requested URL. Returns an
   * HTML notice. Never echoes or logs the password.
   * @private
   */
  async _handleResyncRequest(req) {
    const escape = require('escape-html');
    if (!this._resyncEnabled()) {
      return '';
    }
    const body = req.body || {};
    const url = this._expandOidOrUrl(body.url);

    if (!this._passwordMatches(body.password)) {
      // Small delay to blunt brute-forcing; reveal nothing else.
      await new Promise(r => setTimeout(r, 1000));
      return '<p style="color:#a00"><strong>Incorrect password &mdash; no action taken.</strong></p>';
    }
    if (!url) {
      return '<p style="color:#a00">Enter a ValueSet URL to resync.</p>';
    }
    if (this.isRefreshing) {
      return '<p style="color:#a60">A full sync is currently running; please retry in a few minutes.</p>';
    }
    try {
      const n = await this.resyncValueSet(url);
      console.log(`Manual resync of ${url}: ${n} version(s)`);
      this.stats.task('VSAC Sync', `Manual resync of ${url}: ${n} version(s)`);
      return `<p style="color:#070"><strong>Resynced ${escape(url)}: ${n} version(s).</strong></p>`;
    } catch (error) {
      debugLog(error);
      return `<p style="color:#a00">Resync of ${escape(url)} failed: ${escape(error.message)}</p>`;
    }
  }

  /**
   * Accept either a full canonical URL or a bare VSAC OID. A dotted-decimal OID
   * (optionally with a urn:oid: prefix) is expanded to the VSAC ValueSet URL.
   * @private
   */
  _expandOidOrUrl(input) {
    let s = (input == null ? '' : String(input)).trim();
    if (s.toLowerCase().startsWith('urn:oid:')) {
      s = s.substring('urn:oid:'.length);
    }
    if (/^[0-9]+(\.[0-9]+)+$/.test(s)) {
      return VSAC_VALUESET_URL_PREFIX + s;
    }
    return s;
  }

  /**
   * The resync form HTML, or '' when the feature is disabled (no password set).
   * @private
   */
  _resyncFormHtml() {
    if (!this._resyncEnabled()) {
      return '';
    }
    return `<form method="post" autocomplete="off" style="margin:0 0 1em 0; padding:0.75em; border:1px solid #ccc; background:#f7f7f7">
  <strong>Resync a ValueSet</strong>
  <div style="margin-top:0.5em">
    <label>ValueSet URL or OID: <input type="text" name="url" size="70" autocomplete="off"></label>
  </div>
  <div style="margin-top:0.5em">
    <label>Password: <input type="password" name="password" autocomplete="off"></label>
    <button type="submit">Resync</button>
  </div>
</form>`;
  }

  async info(req) {
    const escape = require('escape-html');

    // Operator action: resync a specific ValueSet (POST from the form below).
    let resyncNotice = '';
    if (req && req.method === 'POST') {
      resyncNotice = await this._handleResyncRequest(req);
    }

    const db = await this.database._getReadConnection();

    const rows = await new Promise((resolve, reject) => {
      db.all(
          `SELECT 'event' AS kind,
                  url,
                  version,
             timestamp AS ts,
             event_type,
             NULL AS status,
             NULL AS error_message,
             NULL AS finished_at,
             NULL AS total_fetched,
             NULL AS total_new,
             NULL AS total_updated
           FROM vsac_events
           UNION ALL
          SELECT 'run' AS kind,
                 NULL,
                 NULL,
                 started_at AS ts,
                 NULL AS event_type,
                 status,
                 error_message,
                 finished_at,
                 total_fetched,
                 total_new,
                 total_updated
          FROM vsac_runs
          ORDER BY ts DESC
            LIMIT 200`,
          [],
          (err, rows) => err ? reject(err) : resolve(rows)
      );
    });

    // ISO date (YYYY-MM-DD UTC) for grouping
    const dayKey = ts => ts
        ? new Date(ts * 1000).toISOString().substring(0, 10)
        : '';
    // Human-friendly day heading e.g. "Tuesday, 14 April 2026"
    const dayLabel = ts => ts
        ? new Date(ts * 1000).toLocaleDateString('en-GB', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
          timeZone: 'UTC'
        })
        : '—';
    // HH:MM:SS UTC within a day
    const timeOnly = ts => ts
        ? new Date(ts * 1000).toISOString().substring(11, 19) + ' UTC'
        : '—';
    // Full timestamp (used in "Running..." detail where context is needed)
    const fmtFull = ts => ts
        ? new Date(ts * 1000).toISOString().replace('T', ' ').substring(0, 19) + ' UTC'
        : '—';

    let html = '';
    html += this._resyncFormHtml();
    html += resyncNotice;
    html += '<h3>VSAC Sync History</h3>';
    html += '<table class="grid">';
    html += '<thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead>';
    html += '<tbody>';

    let currentDay = null;
    for (const row of rows) {
      const rowDay = dayKey(row.ts);
      if (rowDay !== currentDay) {
        currentDay = rowDay;
        html += `<tr style="background:#d8d8d8">`;
        html += `<td colspan="3"><strong>${escape(dayLabel(row.ts))}</strong></td>`;
        html += `</tr>`;
      }

      if (row.kind === 'run') {
        const duration = row.finished_at ? `${row.finished_at - row.ts}s` : 'in progress';
        let detail, colour;
        if (row.status === 'ok') {
          const updated = row.total_updated != null ? `, ${row.total_updated} updated` : '';
          detail = `${row.total_fetched} fetched, ${row.total_new} new${updated}, ${duration}`;
          colour = 'green';
        } else if (row.status === 'error') {
          detail = `Failed: ${escape(row.error_message || '')} (${duration})`;
          colour = 'maroon';
        } else {
          detail = `Running... (started ${fmtFull(row.ts)})`;
          colour = '#a16600';
        }
        html += `<tr style="background:#f0f0f0">`;
        html += `<td>${escape(timeOnly(row.ts))}</td>`;
        html += `<td><strong style="color:${colour}">Sync run</strong></td>`;
        html += `<td>${detail}</td>`;
        html += `</tr>`;
      } else {
        // Event row: 'new', 'updated', or 'deleted'
        let label, colour;
        switch (row.event_type) {
          case 'new':
            label = 'New';
            colour = 'green';
            break;
          case 'updated':
            label = 'Updated';
            colour = 'blue';
            break;
          case 'deleted':
            label = 'Deleted';
            colour = 'red';
            break;
          default:
            label = escape(row.event_type || 'Event');
            colour = 'black';
        }
        html += `<tr>`;
        html += `<td>${escape(timeOnly(row.ts))}</td>`;
        html += `<td><span style="color:${colour}">${label}</span></td>`;
        html += `<td>${escape(this.urlTail(row.url) || '')} v <a href="../ValueSet/${escape(this.spaceId ? this.spaceId + '-' : '')}${escape(this.urlTail(row.url) || '')}-${escape(row.version || '')}">${escape(row.version || '')}</a></td>`;
        html += `</tr>`;
      }
    }

    html += '</tbody></table>';
    return html;
  }

  id() {
    return "vsac";
  }

  urlTail(url) {
    return url ? url.substring(url.lastIndexOf('/') + 1) : '';
  }
}

// Usage examples:
module.exports = {
  VSACValueSetProvider
};