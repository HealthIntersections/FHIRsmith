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

// Canonical URL prefix for VSAC value sets, so operators can enter a bare OID.
const VSAC_VALUESET_URL_PREFIX = 'http://cts.nlm.nih.gov/fhir/ValueSet/';

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

    this.dbPath = path.join(this.cacheFolder, 'vsac-valuesets.db');
    this.database = new ValueSetDatabase(this.dbPath);
    this.valueSetMap = new Map();
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
    // initialize() is re-entered by lookups while the first call is still syncing; only
    // the first call checks for (and resumes) an incomplete sync
    const firstCall = !this._startupChecked;
    this._startupChecked = true;
    this.stats.addTask('VSAC Sync', `${this.refreshIntervalHours} hours`);

    // Create database if it doesn't exist
    if (!(await this.database.exists())) {
      await this.database.create();
    } else {
      // Schema migrations are applied lazily by the database layer on first
      // connection. Just load existing data.
      await this._reloadMap();
    }
    const incomplete = firstCall ? await this._incompleteSyncReason() : null;
    if (this.SYNC_AT_START_UP || this.valueSetMap.size == 0 || incomplete) {
      if (incomplete) {
        console.log(`VSAC: ${incomplete} - resuming the sync now`);
      }
      try {
        await this.refreshValueSets();
      } catch (error) {
        // already recorded by refreshValueSets; the timer below retries it
        this.log.error(error, 'Error during VSAC sync at startup:');
      }
    }
    // Start periodic refresh
    this._startRefreshTimer();
    this.initialized = true;
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
   * Start the periodic refresh timer
   * @private
   */
  _startRefreshTimer() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    const intervalMs = this.refreshIntervalHours * 60 * 60 * 1000;
    this.refreshTimer = setInterval(async () => {
      try {
        await this.refreshValueSets();
      } catch (error) {
        debugLog(error);
        this.log.error(error, 'Error during scheduled refresh:');
      }
    }, intervalMs);
  }

  /**
   * Stop the refresh timer (for cleanup)
   */
  stopRefreshTimer() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
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
            if (!this.valueSetMap.has(vs.url+"|"+vs.version)) {
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

      // Reload map with fresh data
      await this._reloadMap();

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
      throw error;
    } finally {
      this.isRefreshing = false;
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
      const key = valueSet.url+"|"+valueSet.version;
      const existing = this.valueSetMap.get(key);
      const newHash = this._hashValueSet(valueSet);

      if (existing) {
        // We've seen this url|version before. Decide whether the content
        // has actually changed by comparing hashes.
        //
        // Note: _reloadMap() mutates the in-memory jsonObj (strips inc.version
        // from compose.include/exclude), so we cannot reliably recompute a
        // hash from existing.jsonObj — it would not match the hash of the
        // original unmutated JSON we stored. For rows predating this feature
        // (content_hash NULL), we defer update detection until the next cycle:
        // the upsert below runs only when hashes differ, so on the *next*
        // sync after migration we'll have a proper baseline.
        if (existing.contentHash && existing.contentHash === newHash) {
          // No change - just touch last_seen
          await this.database.seeValueSet(valueSet);
        } else if (!existing.contentHash) {
          // Legacy row without a stored hash - backfill the hash silently
          // without emitting a spurious 'updated' event. We do a lightweight
          // touch + hash update rather than a full upsert+event.
          await this.database.seeValueSet(valueSet);
          await this.database.setContentHash(valueSet.id, newHash);
        } else {
          // Content has changed - treat as update
          await this.database.upsertValueSet(valueSet, newHash);
          await this.database.recordEvent('updated', valueSet.url, valueSet.version);
          updatedCount++;
        }
      } else {
        await this.database.upsertValueSet(valueSet, newHash);
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
   * Reload the in-memory map from database (thread-safe)
   * @returns {Promise<void>}
   * @private
   */
  async _reloadMap() {
    const newMap = await this.database.loadAllValueSets(this.sourcePackage());
    for (const vs of newMap.values()) {
      if (vs.jsonObj.compose) {
        for (const inc of vs.jsonObj.compose.include || []) {
          if (inc.version) {
            delete inc.version;
          }
        }for (const inc of vs.jsonObj.compose.exclude || []) {
          if (inc.version) {
            delete inc.version;
          }
        }
      }
    }
    // the value sets are served in this provider's id space
    for (const vs of new Set(newMap.values())) {
      applyIdPrefix(vs, this.spaceId);
    }
    // Atomic replacement of the map
    this.valueSetMap = newMap;
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

    // Try exact match first: url|version
    let key = `${url}|${version}`;
    if (this.valueSetMap.has(key)) {
      return await this.checkFullVS(this.valueSetMap.get(key));
    }

    // If version is semver, try url|major.minor
    try {
      if (VersionUtilities.isSemVer(version)) {
        const majorMinor = VersionUtilities.getMajMin(version);
        if (majorMinor) {
          key = `${url}|${majorMinor}`;
          if (this.valueSetMap.has(key)) {
            return await this.checkFullVS(this.valueSetMap.get(key));
          }
        }
      }
    } catch (error) {
      // Ignore version parsing errors
    }

    // Finally try just the URL - only when no version was asked for (see VERSION_FALLBACK_TO_LATEST)
    if ((!version || VSACValueSetProvider.VERSION_FALLBACK_TO_LATEST) && this.valueSetMap.has(url)) {
      return await this.checkFullVS(this.valueSetMap.get(url));
    }

    return null;
  }

  async fetchValueSetById(id) {
    // the map is keyed by the value set's own id (and its url); the value set itself
    // carries the prefixed id, which is how a url key that happens to match is excluded
    const vs = this.valueSetMap.get(stripIdPrefix(id, this.spaceId));
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

    if (searchParams.length === 0) {
      return [];
    }

    return await this.database.search(this.spaceId, this.valueSetMap, searchParams, elements);
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
            ? new Date(this.lastRefresh.getTime() + (this.refreshIntervalHours * 60 * 60 * 1000))
            : null
      }
    };
  }

  /**
   * Get the number of value sets loaded into memory
   * @returns {number} Number of unique value sets in map
   */
  getMapSize() {
    const uniqueUrls = new Set();
    for (const [key, valueSet] of this.valueSetMap.entries()) {
      if (!key.includes('|')) { // Only count base URL keys
        uniqueUrls.add(valueSet.url);
      }
    }
    return uniqueUrls.size;
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
    return await this.database.listAllValueSets();
  }

  async close() {
    await this.database.close();
  }

  prefixIds() {
    this.#applyIdPrefix();
  }

  // the map is replaced every time it's reloaded from the database (see _reloadMap), and that
  // can happen before or after the spaceId is assigned - so both prefix whatever is there
  #applyIdPrefix() {
    for (const vs of new Set(this.valueSetMap.values())) {
      applyIdPrefix(vs, this.spaceId);
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
    // this.database.addToMap(this.valueSetMap, vsNew.id, vsNew.url, vsNew.version, vsNew);
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
    return !!this.resyncPassword;
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
   * upsert, and reload the in-memory map.
   * @param {string} url - the ValueSet canonical url
   * @returns {Promise<number>} number of versions fetched
   */
  async resyncValueSet(url) {
    const tracking = { totalFetched: 0, totalNew: 0, totalUpdated: 0, count: 0, newCount: 0 };
    await this.processContentAndHistory(url, tracking, 1);
    await this._reloadMap();
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