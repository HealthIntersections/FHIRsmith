const fs = require('fs/promises');
const crypto = require('crypto');
const path = require('path');
const { AbstractValueSetProvider } = require('../vs/vs-api');
const { VersionUtilities } = require('../../library/version-utilities');
const ValueSet = require('../library/valueset');
const { SearchFilterText } = require('../library/designations');
const { TxParameters } = require('../params');
const { OCLSourceCodeSystemFactory, OCLBackgroundJobQueue } = require('./cs-ocl');
const { PAGE_SIZE, CONCEPT_PAGE_SIZE, FILTERED_CONCEPT_PAGE_SIZE, COLD_CACHE_FRESHNESS_MS } = require('./shared/constants');
const { createOclHttpClient } = require('./http/client');
const { CACHE_VS_DIR, getCacheFilePath } = require('./cache/cache-paths');
const { ensureCacheDirectories, getColdCacheAgeMs, formatCacheAgeMinutes } = require('./cache/cache-utils');
const { computeValueSetExpansionFingerprint } = require('./fingerprint/fingerprint');
const { ensureTxParametersHashIncludesFilter, patchValueSetExpandWholeSystemForOcl } = require('./shared/patches');
const Logger = require('../../library/logger');
const oclVsLog = Logger.getInstance().child({ module: 'ocl-vs' });


ensureTxParametersHashIncludesFilter(TxParameters);
//patchValueSetExpandWholeSystemForOcl();

function normalizeCanonicalSystem(system) {
  if (typeof system !== 'string') {
    return system;
  }

  let trimmed = system.trim();
  if (!trimmed) {
    return trimmed;
  }

  return trimmed;
}

class OCLValueSetProvider extends AbstractValueSetProvider {
  
  constructor(config = {}) {
    super();
    const options = typeof config === 'string' ? { baseUrl: config } : (config || {});

    this.org = options.org || null;
    const http = createOclHttpClient(options);
    this.baseUrl = http.baseUrl;
    this.httpClient = http.client;

    this.valueSetMap = new Map();
    this._idMap = new Map();
    this.collectionMeta = new Map();
    this.sourceCanonicalCache = new Map();
    this.collectionConceptPageCache = new Map();
    this.pendingCollectionConceptPageRequests = new Map();
    this.collectionSourcesCache = new Map();
    this.pendingCollectionSourcesRequests = new Map();
    this.pendingSourceCanonicalRequests = new Map();
    this.collectionByCanonicalCache = new Map();
    this.pendingCollectionByCanonicalRequests = new Map();
    this._organizationIdsCache = null;
    this._organizationIdsFetchPromise = null;
    this._negativeUrlCache = new Set();
    this._composePromises = new Map();
    this.backgroundExpansionCache = new Map();
    this.backgroundExpansionProgress = new Map();
    this.valueSetFingerprints = new Map();
    this._initialized = false;
    this._initializePromise = null;
    this.sourcePackageCode = this.org
      ? `ocl:${this.baseUrl}|org=${this.org}`
      : `ocl:${this.baseUrl}`;
  }

  async #loadColdCacheForValueSets() {
    try {
      const files = await fs.readdir(CACHE_VS_DIR);
      let loadedCount = 0;

      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue;
        }

        try {
          const filePath = path.join(CACHE_VS_DIR, file);
          const data = await fs.readFile(filePath, 'utf-8');
          const cached = JSON.parse(data);

          if (!cached || !cached.canonicalUrl) {
            continue;
          }

          // Support both old (expansion-based) and new (compose-based) cache formats
          const compose = cached.compose || this.#composeFromExpansion(cached.expansion);
          if (!compose || !Array.isArray(compose.include) || compose.include.length === 0) {
            continue;
          }

          const paramsKey = cached.paramsKey || 'default';
          const cacheKey = this.#expansionCacheKey(
            { url: cached.canonicalUrl, version: cached.version || null },
            paramsKey
          );
          const createdAt = cached.timestamp ? new Date(cached.timestamp).getTime() : null;
          this.backgroundExpansionCache.set(cacheKey, {
            compose,
            metadataSignature: cached.metadataSignature || null,
            dependencyChecksums: cached.dependencyChecksums || {},
            createdAt: Number.isFinite(createdAt) ? createdAt : null
          });
          const valueSetObj = new ValueSet({
            resourceType: 'ValueSet',
            url: cached.canonicalUrl,
            version: cached.version || null,
            compose,
            id: cached.canonicalUrl
          }, 'R5');
          this.#applyCachedCompose(valueSetObj, paramsKey);
          this.#prefixId(valueSetObj);
          // Indexa o ValueSet restaurado para torná-lo disponível via fetchValueSet
          this.valueSetMap.set(valueSetObj.url, valueSetObj);
          if (valueSetObj.version) {
            this.valueSetMap.set(`${valueSetObj.url}|${valueSetObj.version}`, valueSetObj);
          }
          this.valueSetMap.set(valueSetObj.id, valueSetObj);
          this._idMap.set(valueSetObj.id, valueSetObj);
          this.valueSetFingerprints.set(cacheKey, cached.fingerprint || null);
          loadedCount++;
        } catch (error) {
          oclVsLog.error(`Failed to load cold cache file ${file}: ${error.message}`);
        }
      }

      if (loadedCount > 0) {
        oclVsLog.info(`Loaded ${loadedCount} ValueSet expansions from cold cache`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        oclVsLog.error(`Failed to load cold cache: ${error.message}`);
      }
    }
  }

  async #saveColdCacheForValueSet(vs, compose, metadataSignature, dependencyChecksums, paramsKey = 'default') {
    const canonicalUrl = vs?.url;
    const version = vs?.version || null;
    if (!canonicalUrl || !compose) {
      return null;
    }

    const cacheFilePath = getCacheFilePath(CACHE_VS_DIR, canonicalUrl, version, paramsKey);

    try {
      await ensureCacheDirectories(CACHE_VS_DIR);

      const conceptCount = Array.isArray(compose.include)
        ? compose.include.reduce((sum, inc) => sum + (Array.isArray(inc.concept) ? inc.concept.length : 0), 0)
        : 0;
      const fingerprint = computeValueSetExpansionFingerprint(compose);
      const cacheData = {
        canonicalUrl,
        version,
        paramsKey,
        fingerprint,
        timestamp: new Date().toISOString(),
        conceptCount,
        compose,
        metadataSignature,
        dependencyChecksums
      };

      await fs.writeFile(cacheFilePath, JSON.stringify(cacheData, null, 2), 'utf-8');
      oclVsLog.info(`Saved ValueSet compose to cold cache: ${canonicalUrl} (${conceptCount} concepts, fingerprint=${fingerprint?.substring(0, 8)})`);

      return fingerprint;
    } catch (error) {
      oclVsLog.error(`Failed to save cold cache for ValueSet ${canonicalUrl}: ${error.message}`);
      return null;
    }
  }

  sourcePackage() {
    return this.sourcePackageCode;
  }

  async initialize() {
    if (this._initialized) {
      return;
    }

    if (this._initializePromise) {
      await this._initializePromise;
      return;
    }

    this._initializePromise = (async () => {
      try {
        // Load cold cache first
        await this.#loadColdCacheForValueSets();

        const collections = await this.#fetchCollectionsForDiscovery();
        oclVsLog.info(`Fetched ${collections.length} collections`);

        for (const collection of collections) {
          const valueSet = this.#toValueSet(collection);
          if (!valueSet) {
            continue;
          }
          this.#indexValueSet(valueSet);
        }

        oclVsLog.info(`Loaded ${this.valueSetMap.size} value sets`);
        this._initialized = true;
      } catch (error) {
        oclVsLog.error(`Initialization failed: ${error.message}`);
        if (error.response) {
          oclVsLog.error(`HTTP ${error.response.status}: ${error.response.statusText}`);
        }
        throw error;
      }
    })();

    try {
      await this._initializePromise;
    } finally {
      this._initializePromise = null;
    }
  }

  prefixIds() {
    if (!this.spaceId) {
      return;
    }

    const unique = new Set(this.valueSetMap.values());
    this._idMap.clear();

    for (const vs of unique) {
      this.#prefixId(vs);
      this._idMap.set(vs.id, vs);
    }
  }

  // value sets are served in this provider's id space - including the ones that arrive
  // after the spaceId is assigned
  #prefixId(vs) {
    if (this.spaceId && vs.id && !vs.id.startsWith(`${this.spaceId}-`)) {
      const nextId = `${this.spaceId}-${vs.id}`;
      vs.id = nextId;
      vs.jsonObj.id = nextId;
    }
  }

  async fetchValueSet(url, version) {
    this._validateFetchParams(url, version);

    // Fast path: skip URLs already known to not be in OCL
    if (this._negativeUrlCache.has(url)) {
      return null;
    }

    let key = `${url}|${version}`;
    if (this.valueSetMap.has(key)) {
      const vs = this.valueSetMap.get(key);
      await this.#ensureComposeIncludes(vs);
      this.#scheduleBackgroundExpansion(vs, { reason: 'fetch-valueset', userRequested: true });
      return vs;
    }

    if (version && VersionUtilities.isSemVer(version)) {
      const majorMinor = VersionUtilities.getMajMin(version);
      if (majorMinor) {
        key = `${url}|${majorMinor}`;
        if (this.valueSetMap.has(key)) {
          const vs = this.valueSetMap.get(key);
          await this.#ensureComposeIncludes(vs);
          this.#scheduleBackgroundExpansion(vs, { reason: 'fetch-valueset-mm' });
          return vs;
        }
      }
    }

    if (this.valueSetMap.has(url)) {
      const vs = this.valueSetMap.get(url);
      await this.#ensureComposeIncludes(vs);
      this.#scheduleBackgroundExpansion(vs, { reason: 'fetch-valueset-url' });
      return vs;
    }

    const resolved = await this.#resolveValueSetByCanonical(url, version);
    if (resolved) {
      await this.#ensureComposeIncludes(resolved);
      this.#scheduleBackgroundExpansion(resolved, { reason: 'fetch-valueset-resolved' });
      return resolved;
    }

    await this.initialize();

    key = `${url}|${version}`;
    if (this.valueSetMap.has(key)) {
      const vs = this.valueSetMap.get(key);
      await this.#ensureComposeIncludes(vs);
      this.#scheduleBackgroundExpansion(vs, { reason: 'fetch-valueset-init' });
      return vs;
    }

    if (version && VersionUtilities.isSemVer(version)) {
      const majorMinor = VersionUtilities.getMajMin(version);
      if (majorMinor) {
        key = `${url}|${majorMinor}`;
        if (this.valueSetMap.has(key)) {
          const vs = this.valueSetMap.get(key);
          await this.#ensureComposeIncludes(vs);
          this.#scheduleBackgroundExpansion(vs, { reason: 'fetch-valueset-init-mm' });
          return vs;
        }
      }
    }

    if (this.valueSetMap.has(url)) {
      const vs = this.valueSetMap.get(url);
      await this.#ensureComposeIncludes(vs);
      this.#scheduleBackgroundExpansion(vs, { reason: 'fetch-valueset-init-url' });
      return vs;
    }

    // Remember that this URL is not in OCL to skip future lookups
    this._negativeUrlCache.add(url);
    return null;
  }

  async fetchValueSetById(id) {
    const local = this.#getLocalValueSetById(id);
    if (local) {
      await this.#ensureComposeIncludes(local);
      this.#scheduleBackgroundExpansion(local, { reason: 'fetch-valueset-by-id' });
      return local;
    }

    await this.initialize();

    const vs = this.#getLocalValueSetById(id);
    await this.#ensureComposeIncludes(vs);
    this.#scheduleBackgroundExpansion(vs, { reason: 'fetch-valueset-by-id-init' });
    return vs;
  }

  #clearInlineExpansion(vs) {
    if (!vs || !vs.jsonObj || !vs.jsonObj.expansion) {
      return;
    }
    delete vs.jsonObj.expansion;
  }

  #getLocalValueSetById(id) {
    // _idMap is keyed by the ids the value sets are served with - prefixed, once the
    // spaceId is assigned
    return this._idMap.get(id) || null;
  }

  // eslint-disable-next-line no-unused-vars
  async searchValueSets(searchParams, _elements) {
    await this.initialize();
    this._validateSearchParams(searchParams);

    const params = Object.fromEntries(searchParams.map(({ name, value }) => [name, String(value).toLowerCase()]));
    const values = Array.from(new Set(this.valueSetMap.values()));

    if (Object.keys(params).length === 0) {
      return values;
    }

    return values.filter(vs => this.#matches(vs.jsonObj, params));
  }

  vsCount() {
    return new Set(this.valueSetMap.values()).size;
  }

  async listAllValueSets() {
    await this.initialize();
    const urls = new Set();
    for (const vs of this.valueSetMap.values()) {
      if (vs && vs.url) {
        urls.add(vs.url);
      }
    }
    return Array.from(urls);
  }

  async close() {
  }

  #indexValueSet(vs) {
    this.#prefixId(vs);
    const existing = this.valueSetMap.get(vs.url) || null;

    // When fresh discovery metadata replaces a cold-cached entry, carry over
    // the enumerated compose so the expand engine doesn't fall back to
    // "include whole CodeSystem".  The background expansion will eventually
    // refresh it with up-to-date collection contents.
    if (existing && existing !== vs
      && Array.isArray(existing.jsonObj?.compose?.include)
      && existing.jsonObj.compose.include.some(inc => Array.isArray(inc.concept) && inc.concept.length > 0)
      && (!vs.jsonObj.compose || !Array.isArray(vs.jsonObj.compose.include) || vs.jsonObj.compose.include.length === 0)
    ) {
      vs.jsonObj.compose = existing.jsonObj.compose;
    }

    this.valueSetMap.set(vs.url, vs);
    if (vs.version) {
      this.valueSetMap.set(`${vs.url}|${vs.version}`, vs);
    }
    this.valueSetMap.set(vs.id, vs);
    this._idMap.set(vs.id, vs);
  }

  #toValueSet(collection) {
    if (!collection || typeof collection !== 'object') {
      return null;
    }

    const canonicalUrl = collection.canonical_url || collection.canonicalUrl || collection.url;
    const id = collection.id;
    if (!canonicalUrl || !id) {
      return null;
    }

    const preferredSource = normalizeCanonicalSystem(collection.preferred_source || collection.preferredSource || null);
    const json = {
      resourceType: 'ValueSet',
      id,
      url: canonicalUrl,
      version: collection.version || null,
      name: collection.name || id,
      title: collection.full_name || collection.fullName || collection.name || id,
      status: 'active',
      experimental: collection.experimental === true,
      immutable: collection.immutable === true,
      description: collection.description || null,
      publisher: collection.publisher || collection.owner || null,
      language: collection.default_locale || collection.defaultLocale || null
    };

    const lastUpdated = this.#toIsoDate(collection.updated_on || collection.updatedOn || collection.updated_at || collection.updatedAt);
    if (lastUpdated) {
      json.meta = { lastUpdated };
    }

    // if (preferredSource) {
    //   json.compose = {
    //     include: [{ system: preferredSource }]
    //   };
    // }

    const conceptsUrl = this.#normalizePath(
      collection.concepts_url || collection.conceptsUrl || this.#buildCollectionConceptsPath(collection)
    );
    const expansionUrl = this.#normalizePath(
      collection.expansion_url || collection.expansionUrl || this.#buildCollectionExpansionPath(collection)
    );

    const meta = {
      collectionId: collection.id || collection.short_code || collection.shortCode || null,
      conceptsUrl,
      expansionUrl,
      preferredSource,
      owner: collection.owner || null,
      ownerType: collection.owner_type || collection.ownerType || null
    };

    this.#storeCollectionMeta(id, canonicalUrl, meta);

    const valueSet = new ValueSet(json, 'R5');
    this.#attachOclHelpers(valueSet, meta);
    return valueSet;
  }

  #attachOclHelpers(valueSet, meta) {
    if (!valueSet || !meta) {
      return;
    }

    valueSet.oclMeta = meta;
    valueSet.oclFetchConcepts = async ({ count, offset, activeOnly, filter, languageCodes }) => {
      return this.#fetchCollectionConcepts(meta, {
        count,
        offset,
        activeOnly,
        filter: typeof filter === 'string' ? filter : null,
        languageCodes: Array.isArray(languageCodes) ? languageCodes : [],
        fallbackSystem: meta.preferredSource || valueSet.url
      });
    };
  }

  #storeCollectionMeta(id, url, meta) {
    if (!meta || (!meta.conceptsUrl && !meta.expansionUrl)) {
      return;
    }
    if (id) {
      this.collectionMeta.set(id, meta);
    }
    if (url) {
      this.collectionMeta.set(url, meta);
    }
  }

  #normalizePath(pathValue) {
    if (!pathValue) {
      return null;
    }
    if (typeof pathValue !== 'string') {
      return null;
    }
    if (pathValue.startsWith('http://') || pathValue.startsWith('https://')) {
      return pathValue;
    }
    // Remove extra slashes and normalize full URL
    let base = this.baseUrl.replace(/\/+$/, '');
    let path = pathValue.replace(/^\/+/, '');
    let url = `${base}/${path}`;
    // Remove all duplicate slashes except after protocol
    url = url.replace(/([^:])\/+/g, '$1/');
    // Remove trailing slashes
    url = url.replace(/\/+$/, '');
    return url;
  }

  #buildCollectionConceptsPath(collection) {
    if (!collection || typeof collection !== 'object') {
      return null;
    }
    const owner = collection.owner || null;
    const ownerType = collection.owner_type || collection.ownerType || null;
    const id = collection.id || collection.short_code || collection.shortCode || null;
    if (!owner || !id || ownerType !== 'Organization') {
      return null;
    }
    return `/orgs/${encodeURIComponent(owner)}/collections/${encodeURIComponent(id)}/concepts/`;
  }

  #buildCollectionExpansionPath(collection) {
    if (!collection || typeof collection !== 'object') {
      return null;
    }
    const owner = collection.owner || null;
    const ownerType = collection.owner_type || collection.ownerType || null;
    const id = collection.id || collection.short_code || collection.shortCode || null;
    if (!owner || !id || ownerType !== 'Organization') {
      return null;
    }
    return `/orgs/${encodeURIComponent(owner)}/collections/${encodeURIComponent(id)}/HEAD/expansions/autoexpand-HEAD/`;
  }

  #getCollectionMeta(vs) {
    if (!vs) {
      return null;
    }
    return this.collectionMeta.get(vs.id) || this.collectionMeta.get(vs.url) || null;
  }

  async #ensureComposeIncludes(vs) {
    if (!vs || !vs.jsonObj) {
      return;
    }

    const meta = this.#getCollectionMeta(vs);

    const composeKey = vs.id || vs.url;
    if (this._composePromises.has(composeKey)) {
      await this._composePromises.get(composeKey);
      return;
    }

    const promise = (async () => {
      const existingInclude = Array.isArray(vs?.jsonObj?.compose?.include)
        ? vs.jsonObj.compose.include
        : [];

      // If the compose already has enumerated concepts (from background expansion),
      // it is the authoritative representation of the collection contents — don't
      // overwrite it with system-only entries that would cause the expand engine
      // to include ALL concepts from the CodeSystem.
      const hasEnumeratedConcepts = existingInclude.some(
        inc => Array.isArray(inc.concept) && inc.concept.length > 0
      );
      if (hasEnumeratedConcepts) {
        return;
      }

      // Always normalize existing compose entries first because discovery metadata
      // can carry non-canonical preferred_source values.
      const include = this.#normalizeComposeIncludes(existingInclude);

      // Reconcile with collection-resolved sources whenever available so $expand
      // and direct CodeSystem lookups share the same canonical registry keys.
      if (meta && (meta.conceptsUrl || meta.expansionUrl)) {
        const sources = await this.#fetchCollectionSources(meta);
        if (Array.isArray(sources) && sources.length > 0) {
          include.push(...this.#normalizeComposeIncludes(sources));
        }
      }

      // Preferred source is a fallback only when no resolvable include was found.
      if (include.length === 0 && meta?.preferredSource) {
        include.push(...this.#normalizeComposeIncludes([{ system: meta.preferredSource }]));
      }

      const deduped = this.#dedupeComposeIncludes(include);
      if (deduped.length > 0) {
        vs.jsonObj.compose = { include: deduped };
      }
    })();

    this._composePromises.set(composeKey, promise);
    try {
      await promise;
    } finally {
      this._composePromises.delete(composeKey);
    }
  }

  #normalizeComposeIncludes(includeEntries) {
    if (!Array.isArray(includeEntries) || includeEntries.length === 0) {
      return [];
    }

    const normalized = [];
    for (const entry of includeEntries) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }

      const system = normalizeCanonicalSystem(entry.system);
      if (!system) {
        continue;
      }

      let version = entry.version || null;
      const hasAnyFactory = OCLSourceCodeSystemFactory.hasFactory(system, null);
      const hasExactFactory = OCLSourceCodeSystemFactory.hasExactFactory(system, version);

      // If include.version does not match the registered OCL factory key,
      // omit it so Provider lookup can reuse the already loaded canonical factory.
      if (version && hasAnyFactory && !hasExactFactory) {
        version = null;
      }

      normalized.push({
        system,
        version: version || undefined
      });
    }

    return normalized;
  }

  #dedupeComposeIncludes(includeEntries) {
    const deduped = [];
    const seen = new Set();

    for (const include of includeEntries || []) {
      const system = normalizeCanonicalSystem(include?.system);
      if (!system) {
        continue;
      }

      const version = include?.version || '';
      const key = `${system}|${version}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduped.push({
        system,
        version: version || undefined
      });
    }

    return deduped;
  }

  async #fetchCollectionSources(meta) {
    const sourcesCacheKey = `${meta.owner || ''}|${meta.collectionId || ''}|${meta.conceptsUrl || ''}|${meta.expansionUrl || ''}`;
    if (this.collectionSourcesCache.has(sourcesCacheKey)) {
      return this.collectionSourcesCache.get(sourcesCacheKey);
    }
    if (this.pendingCollectionSourcesRequests.has(sourcesCacheKey)) {
      return this.pendingCollectionSourcesRequests.get(sourcesCacheKey);
    }

    const pending = (async () => {
    const sources = [];
    const seen = new Set();

    if (meta.expansionUrl) {
      try {
        const response = await this.httpClient.get(meta.expansionUrl);
        const resolved = Array.isArray(response.data?.resolved_source_versions)
          ? response.data.resolved_source_versions
          : [];

        for (const entry of resolved) {
          const system = entry.canonical_url || entry.canonicalUrl || null;
          const owner = entry.owner || meta.owner || null;
          const shortCode = entry.short_code || entry.shortCode || entry.id || null;
          const version = entry.version || null;

          const systemUrl = normalizeCanonicalSystem(system || (owner && shortCode ? await this.#getSourceCanonicalUrl(owner, shortCode) : null));
          if (systemUrl && !seen.has(systemUrl)) {
            seen.add(systemUrl);
            sources.push({ system: systemUrl, version });
          }
        }
      } catch (error) {
        // fall through to concepts listing
      }
    }

    if (sources.length > 0) {
      return sources;
    }

    if (!meta.conceptsUrl) {
      return sources;
    }

    const sourceKeys = await this.#fetchCollectionSourceKeys(meta.conceptsUrl, meta.owner || null);
    for (const { owner, source } of sourceKeys) {
      const systemUrl = normalizeCanonicalSystem(await this.#getSourceCanonicalUrl(owner, source));
      if (systemUrl && !seen.has(systemUrl)) {
        seen.add(systemUrl);
        sources.push({ system: systemUrl });
      }
    }

    if (sources.length === 0 && meta.preferredSource) {
      const preferredSource = normalizeCanonicalSystem(meta.preferredSource);
      if (preferredSource) {
        sources.push({ system: preferredSource });
      }
    }

      this.collectionSourcesCache.set(sourcesCacheKey, sources);
      return sources;
    })();

    this.pendingCollectionSourcesRequests.set(sourcesCacheKey, pending);
    try {
      return await pending;
    } finally {
      this.pendingCollectionSourcesRequests.delete(sourcesCacheKey);
    }
  }

  async #fetchCollectionConcepts(meta, options) {
    if (!meta || !meta.conceptsUrl) {
      return { contains: [], total: 0 };
    }

    const count = Number.isInteger(options?.count) ? options.count : CONCEPT_PAGE_SIZE;
    const offset = Number.isInteger(options?.offset) ? options.offset : 0;
    const activeOnly = options?.activeOnly === true;
    const filter = this.#normalizeFilter(options?.filter);
    const filterMatcher = filter ? new SearchFilterText(filter) : null;
    const remoteQuery = this.#buildRemoteQuery(filter);
    const fallbackSystem = options?.fallbackSystem || null;
    const preferredLanguageCodes = this.#normalizeLanguageCodes(options?.languageCodes);
    const effectiveLanguageCodes = preferredLanguageCodes.length > 0 ? preferredLanguageCodes : ['en'];

    if (count <= 0) {
      return { contains: [], total: 0 };
    }

    const hasFilter = !!filter;
    const limit = hasFilter
      ? Math.min(FILTERED_CONCEPT_PAGE_SIZE, CONCEPT_PAGE_SIZE)
      : CONCEPT_PAGE_SIZE;
    let page = Math.floor(Math.max(0, offset) / limit) + 1;
    let skip = Math.max(0, offset) % limit;
    let remaining = count;
    const contains = [];
    let reportedTotal = null;

    while (remaining > 0) {
      const pageData = await this.#fetchConceptPage(meta.conceptsUrl, page, limit, remoteQuery);
      const pageItems = Array.isArray(pageData?.items) ? pageData.items : [];
      if (
        reportedTotal == null &&
        typeof pageData?.reportedTotal === 'number' &&
        Number.isFinite(pageData.reportedTotal) &&
        pageData.reportedTotal >= 0
      ) {
        reportedTotal = pageData.reportedTotal;
      }

      if (!pageItems || pageItems.length === 0) {
        break;
      }

      const slice = pageItems.slice(skip);
      skip = 0;

      for (const concept of slice) {
        if (remaining <= 0) {
          break;
        }
        if (activeOnly && concept.retired === true) {
          continue;
        }

        const localizedNames = this.#extractLocalizedNames(concept, effectiveLanguageCodes);
        const localizedDefinitions = this.#extractLocalizedDefinitions(concept, effectiveLanguageCodes);

        const display = localizedNames.display || concept.display_name || concept.display || concept.name || null;
        const definition = localizedDefinitions.definition || concept.definition || concept.description || concept.concept_class || null;
        const code = concept.code || concept.id || null;
        const searchableText = [
          code,
          display,
          definition,
          ...localizedNames.designation.map(d => d.value),
          ...localizedDefinitions.definitions.map(d => d.value)
        ].filter(Boolean).join(' ');
        if (!this.#conceptMatchesFilter(searchableText, code, display, definition, filter, filterMatcher)) {
          continue;
        }

        if (!code) {
          continue;
        }

        const owner = concept.owner || meta.owner || null;
        const source = concept.source || null;
        const conceptCanonical = concept.source_canonical_url || concept.sourceCanonicalUrl || null;
        const system = conceptCanonical || (owner && source
          ? await this.#getSourceCanonicalUrl(owner, source)
          : fallbackSystem);

        contains.push({
          system: system || fallbackSystem,
          code,
          display,
          definition: definition || undefined,
          designation: localizedNames.designation,
          definitions: localizedDefinitions.definitions,
          inactive: concept.retired === true ? true : undefined
        });
        remaining -= 1;
      }

      if (pageItems.length < limit) {
        break;
      }

      page += 1;
    }

    return { contains, total: contains.length, reportedTotal };
  }

  async #resolveValueSetByCanonical(url, version) {
    const canonicalUrl = typeof url === 'string' ? url.trim() : '';
    if (!canonicalUrl) {
      return null;
    }

    const collection = await this.#findCollectionByCanonical(canonicalUrl, version);
    if (!collection) {
      return null;
    }

    const valueSet = this.#toValueSet(collection);
    if (!valueSet) {
      return null;
    }

    this.#indexValueSet(valueSet);
    return valueSet;
  }

  #valueSetBaseKey(vs) {
    if (!vs || !vs.url) {
      return null;
    }
    return `${vs.url}|${vs.version || ''}`;
  }

  #expansionParamsKey(params) {
    if (!params || typeof params !== 'object') {
      return 'default';
    }

    try {
      const normalized = Object.keys(params)
        .sort()
        .reduce((acc, key) => {
          if (key === 'tx-resource' || key === 'valueSet') {
            return acc;
          }
          acc[key] = params[key];
          return acc;
        }, {});

      const json = JSON.stringify(normalized);
      if (!json || json === '{}') {
        return 'default';
      }
      return crypto.createHash('sha256').update(json).digest('hex').substring(0, 16);
    } catch (error) {
      return 'default';
    }
  }

  #composeFromExpansion(expansion) {
    if (!expansion || !Array.isArray(expansion.contains)) {
      return null;
    }
    const systemConcepts = new Map();
    for (const entry of expansion.contains) {
      if (!entry.system || !entry.code) continue;
      if (!systemConcepts.has(entry.system)) {
        systemConcepts.set(entry.system, []);
      }
      systemConcepts.get(entry.system).push({ code: entry.code });
    }
    if (systemConcepts.size === 0) {
      return null;
    }
    return { include: Array.from(systemConcepts.entries()).map(([system, concepts]) => ({ system, concept: concepts })) };
  }

  #expansionCacheKey(vs, paramsKey) {
    const base = this.#valueSetBaseKey(vs);
    if (!base) {
      return null;
    }
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(`${base}|${paramsKey || 'default'}`).digest('hex');
    return hash;
  }

  #invalidateExpansionCache(vs) {
    const base = this.#valueSetBaseKey(vs);
    if (!base) {
      return;
    }

    for (const key of this.backgroundExpansionCache.keys()) {
      if (key.startsWith(`${base}|`)) {
        this.backgroundExpansionCache.delete(key);
      }
    }
  }

  #applyCachedCompose(vs, paramsKey) {
    if (!vs || !vs.jsonObj) {
      return;
    }

    const cacheKey = this.#expansionCacheKey(vs, paramsKey);
    if (!cacheKey) {
      return;
    }

    const cached = this.backgroundExpansionCache.get(cacheKey);
    if (!cached || !cached.compose) {
      return;
    }

    if (!this.#isCachedExpansionValid(vs, cached)) {
      this.backgroundExpansionCache.delete(cacheKey);
      return;
    }

    if (vs.jsonObj.compose && Array.isArray(vs.jsonObj.compose.include) && vs.jsonObj.compose.include.length > 0) {
      return;
    }

    vs.jsonObj.compose = structuredClone(cached.compose);
  }

  #scheduleBackgroundExpansion(vs, options = {}) {
    if (!vs || !vs.jsonObj) {
      return;
    }

    const paramsKey = this.#expansionParamsKey(options.params || null);
    const cacheKey = this.#expansionCacheKey(vs, paramsKey);
    if (!cacheKey) {
      return;
    }

    let cached = this.backgroundExpansionCache.get(cacheKey);
    let invalidated = false;
    if (cached && !this.#isCachedExpansionValid(vs, cached)) {
      this.backgroundExpansionCache.delete(cacheKey);
      cached = null;
      invalidated = true;
    }

    // Already have a cached compose ready
    if (cached && cached.compose) {
      return;
    }

    // Skip freshness check when cache was just invalidated (VS metadata changed
    // on the server) — the cold cache file is stale even if recently written.
    if (!invalidated) {
      const cacheFilePath = getCacheFilePath(CACHE_VS_DIR, vs.url, vs.version || null, paramsKey);
      const cacheAgeFromFileMs = getColdCacheAgeMs(cacheFilePath);
      const persistedCache = this.backgroundExpansionCache.get(cacheKey);
      const cacheAgeFromMetadataMs = Number.isFinite(persistedCache?.createdAt)
        ? Math.max(0, Date.now() - persistedCache.createdAt)
        : null;

      // Treat cache as fresh when either file mtime or persisted timestamp is recent.
      const freshnessCandidates = [cacheAgeFromFileMs, cacheAgeFromMetadataMs].filter(age => age != null);
      const freshestCacheAgeMs = freshnessCandidates.length > 0 ? Math.min(...freshnessCandidates) : null;
      if (freshestCacheAgeMs != null && freshestCacheAgeMs <= COLD_CACHE_FRESHNESS_MS) {
        return;
      }
    }

    const jobKey = `vs:${cacheKey}`;
    if (OCLBackgroundJobQueue.isQueuedOrRunning(jobKey)) {
      return;
    }

    let queuedJobSize = null;
    OCLBackgroundJobQueue.enqueue(
      jobKey,
      'ValueSet expansion',
      async () => {
        await this.#runBackgroundExpansion(vs, cacheKey, paramsKey, queuedJobSize);
      },
      {
        jobId: vs.url || cacheKey,
        getProgress: () => this.#backgroundExpansionProgressSnapshot(cacheKey),
        resolveJobSize: async () => {
          const meta = this.#getCollectionMeta(vs);
          queuedJobSize = await this.#fetchConceptCountFromHeaders(meta?.conceptsUrl || null);
          return queuedJobSize;
        },
        userRequested: !!options.userRequested
      }
    );
  }

  async #runBackgroundExpansion(vs, cacheKey, paramsKey = 'default', knownConceptCount = null) {
    const progressState = { processed: 0, total: null };
    this.backgroundExpansionProgress.set(cacheKey, progressState);
    try {
      await this.#ensureComposeIncludes(vs);

      const meta = this.#getCollectionMeta(vs);
      const resolvedTotal = Number.isFinite(knownConceptCount) && knownConceptCount >= 0
        ? knownConceptCount
        : await this.#fetchConceptCountFromHeaders(meta?.conceptsUrl || null);
      progressState.total = resolvedTotal;
      const sources = meta ? await this.#fetchCollectionSources(meta) : [];
      for (const source of sources || []) {
        OCLSourceCodeSystemFactory.scheduleBackgroundLoadByKey(
          source.system,
          source.version || null,
          'valueset-expansion'
        );
      }

      const compose = await this.#buildBackgroundCompose(vs, progressState);
      if (!compose) {
        return;
      }

      const conceptCount = Array.isArray(compose.include)
        ? compose.include.reduce((sum, inc) => sum + (Array.isArray(inc.concept) ? inc.concept.length : 0), 0)
        : 0;
      progressState.processed = conceptCount || progressState.processed;
      if (typeof progressState.total !== 'number' || !Number.isFinite(progressState.total) || progressState.total <= 0) {
        progressState.total = conceptCount || 0;
      }

      const metadataSignature = this.#valueSetMetadataSignature(vs);
      const dependencyChecksums = this.#valueSetDependencyChecksums(vs);

      // Compute fingerprint and compare with cold cache
      const newFingerprint = computeValueSetExpansionFingerprint(compose);
      const oldFingerprint = this.valueSetFingerprints.get(cacheKey);

      if (!oldFingerprint || newFingerprint !== oldFingerprint) {
        const savedFingerprint = await this.#saveColdCacheForValueSet(vs, compose, metadataSignature, dependencyChecksums, paramsKey);
        if (savedFingerprint) {
          this.valueSetFingerprints.set(cacheKey, savedFingerprint);
        }
      }

      this.backgroundExpansionCache.set(cacheKey, {
        compose,
        metadataSignature,
        dependencyChecksums,
        createdAt: Date.now()
      });

      // Apply compose to the ValueSet so the expand engine can use it
      vs.jsonObj.compose = structuredClone(compose);
      // Ensure no stale inline expansion
      delete vs.jsonObj.expansion;

      oclVsLog.info(`compose cached: ${vs.url} (${conceptCount} concepts)`);
    } catch (error) {
      oclVsLog.error(`ValueSet background expansion failed: ${cacheKey}: ${error.message}`);
    } finally {
      this.backgroundExpansionProgress.delete(cacheKey);
    }
  }

  async #buildBackgroundCompose(vs, progressState = null) {
    const meta = this.#getCollectionMeta(vs);
    if (!meta || !meta.conceptsUrl) {
      return null;
    }

    let offset = 0;
    const systemConcepts = new Map();
    let totalCount = 0;
    while (true) {
      const batch = await this.#fetchCollectionConcepts(meta, {
        count: CONCEPT_PAGE_SIZE,
        offset,
        activeOnly: false,
        filter: null,
        languageCodes: []
      });
      const entries = Array.isArray(batch?.contains) ? batch.contains : [];
      if (entries.length === 0) {
        break;
      }
      for (const entry of entries) {
        if (!entry?.system || !entry?.code) {
          continue;
        }
        if (!systemConcepts.has(entry.system)) {
          systemConcepts.set(entry.system, []);
        }
        const concept = { code: entry.code };
        if (Array.isArray(entry.designation) && entry.designation.length > 0) {
          concept.designation = entry.designation;
        }
        systemConcepts.get(entry.system).push(concept);
        totalCount++;
      }
      if (progressState) {
        progressState.processed = totalCount;
      }
      if (entries.length < CONCEPT_PAGE_SIZE) {
        break;
      }
      offset += entries.length;
    }

    if (systemConcepts.size === 0) {
      return null;
    }

    return {
      include: Array.from(systemConcepts.entries()).map(([system, concepts]) => ({
        system,
        concept: concepts
      }))
    };
  }

  async #findCollectionByCanonical(canonicalUrl, version) {
    const lookupKey = `${this.org || '*'}|${canonicalUrl}|${version || ''}`;
    if (this.collectionByCanonicalCache.has(lookupKey)) {
      return this.collectionByCanonicalCache.get(lookupKey);
    }
    if (this.pendingCollectionByCanonicalRequests.has(lookupKey)) {
      return this.pendingCollectionByCanonicalRequests.get(lookupKey);
    }

    const token = this.#canonicalToken(canonicalUrl);
    if (!token) {
      return null;
    }

    const pending = (async () => {
      const organizations = await this.#fetchOrganizationIds();
      const endpoints = organizations.length > 0
        ? organizations.map(orgId => `/orgs/${encodeURIComponent(orgId)}/collections/`)
        : ['/collections/'];

      const exactMatches = [];
      for (const endpoint of endpoints) {
        const response = await this.httpClient.get(endpoint, {
          params: {
            q: token,
            page: 1,
            limit: PAGE_SIZE
          }
        });

        const payload = response.data;
        const items = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.results)
            ? payload.results
            : Array.isArray(payload?.items)
              ? payload.items
              : Array.isArray(payload?.data)
                ? payload.data
                : [];

        for (const item of items) {
          const itemCanonical = item?.canonical_url || item?.canonicalUrl || item?.url || null;
          if (itemCanonical === canonicalUrl) {
            exactMatches.push(item);
          }
        }
      }

      let match = null;
      if (exactMatches.length > 0) {
        if (!version) {
          match = exactMatches[0];
        } else {
          const exactVersion = exactMatches.find(item => (item.version || null) === version);
          if (exactVersion) {
            match = exactVersion;
          } else if (VersionUtilities.isSemVer(version)) {
            const majorMinor = VersionUtilities.getMajMin(version);
            if (majorMinor) {
              const majorMinorMatch = exactMatches.find(item => (item.version || null) === majorMinor);
              if (majorMinorMatch) {
                match = majorMinorMatch;
              }
            }
          }
        }
      }

      this.collectionByCanonicalCache.set(lookupKey, match);
      return match;
    })();

    this.pendingCollectionByCanonicalRequests.set(lookupKey, pending);
    try {
      return await pending;
    } finally {
      this.pendingCollectionByCanonicalRequests.delete(lookupKey);
    }
  }

  #valueSetMetadataSignature(vs) {
    const meta = this.#getCollectionMeta(vs);
    const payload = {
      url: vs?.url || null,
      version: vs?.version || null,
      lastUpdated: vs?.jsonObj?.meta?.lastUpdated || null,
      collectionId: meta?.collectionId || null,
      conceptsUrl: meta?.conceptsUrl || null,
      expansionUrl: meta?.expansionUrl || null,
      preferredSource: meta?.preferredSource || null
    };
    return JSON.stringify(payload);
  }

  #valueSetDependencyChecksums(vs) {
    const include = Array.isArray(vs?.jsonObj?.compose?.include) ? vs.jsonObj.compose.include : [];
    const checksums = {};
    for (const item of include) {
      const system = normalizeCanonicalSystem(item?.system || null);
      if (!system) {
        continue;
      }
      const version = item?.version || null;
      const key = `${system}|${version || ''}`;
      checksums[key] = OCLSourceCodeSystemFactory.checksumForResource(system, version);
    }
    return checksums;
  }

  #isCachedExpansionValid(vs, cached) {
    if (!cached || typeof cached !== 'object') {
      return false;
    }

    if (cached.metadataSignature !== this.#valueSetMetadataSignature(vs)) {
      return false;
    }

    const currentDeps = this.#valueSetDependencyChecksums(vs);
    const cachedDeps = cached.dependencyChecksums || {};
    const currentKeys = Object.keys(currentDeps).sort();
    const cachedKeys = Object.keys(cachedDeps).sort();

    if (currentKeys.length !== cachedKeys.length) {
      return false;
    }

    for (let i = 0; i < currentKeys.length; i++) {
      if (currentKeys[i] !== cachedKeys[i]) {
        return false;
      }
      if ((currentDeps[currentKeys[i]] || null) !== (cachedDeps[cachedKeys[i]] || null)) {
        return false;
      }
    }

    return true;
  }

  async #fetchCollectionsForDiscovery() {
    const organizations = await this.#fetchOrganizationIds();
    if (organizations.length === 0) {
      // Fallback for OCL instances that expose global listing but not org listing.
      return await this.#fetchAllPages('/collections/');
    }

    const allCollections = [];
    const seen = new Set();

    for (const orgId of organizations) {
      const endpoint = `/orgs/${encodeURIComponent(orgId)}/collections/`;
      const collections = await this.#fetchAllPages(endpoint);
      for (const collection of collections) {
        if (!collection || typeof collection !== 'object') {
          continue;
        }
        const key = this.#collectionIdentity(collection);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        allCollections.push(collection);
      }
    }

    return allCollections;
  }

  async #fetchOrganizationIds() {
    // Return cached result if available
    if (this._organizationIdsCache) {
      return this._organizationIdsCache;
    }

    // Deduplicate concurrent requests
    if (this._organizationIdsFetchPromise) {
      return this._organizationIdsFetchPromise;
    }

    this._organizationIdsFetchPromise = (async () => {
      const endpoint = '/orgs/';
      oclVsLog.info(`Loading organizations from: ${this.baseUrl}${endpoint}`);
      const orgs = await this.#fetchAllPages(endpoint);

      const ids = [];
      const seen = new Set();
      for (const org of orgs || []) {
        if (!org || typeof org !== 'object') {
          continue;
        }

        const id = org.id || org.mnemonic || org.short_code || org.shortCode || org.name || null;
        if (!id) {
          continue;
        }

        const normalized = String(id).trim();
        if (!normalized || seen.has(normalized)) {
          continue;
        }

        seen.add(normalized);
        ids.push(normalized);
      }

      if (ids.length === 0 && this.org) {
        ids.push(this.org);
      }

      this._organizationIdsCache = ids;
      return ids;
    })();

    try {
      return await this._organizationIdsFetchPromise;
    } finally {
      this._organizationIdsFetchPromise = null;
    }
  }

  #collectionIdentity(collection) {
    if (!collection || typeof collection !== 'object') {
      return '__invalid__';
    }

    const owner = collection.owner || '';
    const canonical = collection.canonical_url || collection.canonicalUrl || '';
    const id = collection.id || collection.short_code || collection.shortCode || collection.name || '';
    return `${owner}|${canonical}|${id}`;
  }

  #canonicalToken(canonicalUrl) {
    if (!canonicalUrl || typeof canonicalUrl !== 'string') {
      return null;
    }

    const trimmed = canonicalUrl.trim();
    if (!trimmed) {
      return null;
    }

    const parts = trimmed.replace(/\/+$/, '').split('/').filter(Boolean);
    if (parts.length === 0) {
      return null;
    }

    return parts[parts.length - 1];
  }

  async #fetchConceptPage(conceptsUrl, page, limit, filter = null) {
    try {
      const cacheKey = `${conceptsUrl}|p=${page}|l=${limit}|q=${filter || ''}|verbose=1`;
      if (this.collectionConceptPageCache.has(cacheKey)) {
        const cached = this.collectionConceptPageCache.get(cacheKey);
        const items = Array.isArray(cached)
          ? cached
          : Array.isArray(cached?.items)
            ? cached.items
            : [];
        return {
          items,
          reportedTotal: this.#extractTotalFromPayload(cached?.payload || null)
        };
      }
      if (this.pendingCollectionConceptPageRequests.has(cacheKey)) {
        return this.pendingCollectionConceptPageRequests.get(cacheKey);
      }

      const pending = (async () => {
      const params = { page, limit, verbose: true };
      if (filter) {
        params.q = filter;
      }
      const response = await this.httpClient.get(conceptsUrl, { params });
      const payload = response.data;
      const items = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.results)
          ? payload.results
          : Array.isArray(payload?.items)
            ? payload.items
            : Array.isArray(payload?.data)
              ? payload.data
              : [];

          this.collectionConceptPageCache.set(cacheKey, { items, payload });
          return {
            items,
            reportedTotal: this.#extractTotalFromPayload(payload)
          };
      })();

      this.pendingCollectionConceptPageRequests.set(cacheKey, pending);
      try {
        return await pending;
      } finally {
        this.pendingCollectionConceptPageRequests.delete(cacheKey);
      }
    } catch (error) {
      oclVsLog.error(`#fetchConceptPage ERROR: ${error.message}`);
      throw error;
    }
  }

  #buildRemoteQuery(filter) {
    if (!filter || typeof filter !== 'string') {
      return null;
    }

    const tokens = filter
      .split(/\s+or\s+|\||&|\s+/i)
      .map(t => t.trim())
      .filter(Boolean)
      .map(t => (t.startsWith('-') || t.startsWith('!')) ? t.substring(1) : t)
      .map(t => t.replace(/[%*?]/g, ''))
      .map(t => t.replace(/[^\p{L}\p{N}]+/gu, ''))
      .filter(t => t.length >= 3);

    if (tokens.length === 0) {
      return null;
    }

    tokens.sort((a, b) => b.length - a.length);
    return tokens[0];
  }

  #normalizeLanguageCodes(languageCodes) {
    if (!Array.isArray(languageCodes)) {
      return [];
    }

    const normalized = [];
    for (const code of languageCodes) {
      if (!code || typeof code !== 'string') {
        continue;
      }
      normalized.push(code.toLowerCase());
    }
    return normalized;
  }

  #backgroundExpansionProgressSnapshot(cacheKey) {
    const progress = this.backgroundExpansionProgress.get(cacheKey);
    if (!progress) {
      return null;
    }

    const processed = progress.processed;
    const total = progress.total;
    if (
      typeof processed === 'number' &&
      Number.isFinite(processed) &&
      typeof total === 'number' &&
      Number.isFinite(total) &&
      total > 0
    ) {
      return { processed, total };
    }

    return null;
  }

  #extractTotalFromPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }

    const candidates = [
      payload.total,
      payload.total_count,
      payload.totalCount,
      payload.num_found,
      payload.numFound,
      payload.count
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) {
        return candidate;
      }
    }

    return null;
  }

  async #fetchConceptCountFromHeaders(conceptsUrl) {
    if (!conceptsUrl) {
      return null;
    }

    try {
      const response = await this.httpClient.get(conceptsUrl, {
        params: {
          limit: 1
        }
      });
      return this.#extractNumFoundFromHeaders(response?.headers);
    } catch (error) {
      return null;
    }
  }

  #extractNumFoundFromHeaders(headers) {
    if (!headers || typeof headers !== 'object') {
      return null;
    }

    const raw = headers.num_found ?? headers['num-found'] ?? headers.Num_Found ?? null;
    const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return null;
    }
    return parsed;
  }

  #languageRank(languageCode, preferredLanguageCodes) {
    if (!languageCode) {
      return 1000;
    }

    const normalized = String(languageCode).toLowerCase();
    for (let i = 0; i < preferredLanguageCodes.length; i++) {
      const preferred = preferredLanguageCodes[i];
      if (normalized === preferred || normalized.startsWith(`${preferred}-`) || preferred.startsWith(`${normalized}-`)) {
        return i;
      }
    }

    if (normalized === 'en' || normalized.startsWith('en-')) {
      return preferredLanguageCodes.length;
    }

    return preferredLanguageCodes.length + 1;
  }

  #extractLocalizedNames(concept, preferredLanguageCodes) {
    const names = Array.isArray(concept?.names) ? concept.names : [];
    const unique = new Map();

    for (const item of names) {
      const value = item?.name;
      if (!value || typeof value !== 'string') {
        continue;
      }

      const language = typeof item?.locale === 'string' && item.locale.trim() ? item.locale.trim().toLowerCase() : null;
      const key = `${language || ''}|${value}`;
      if (unique.has(key)) {
        continue;
      }

      unique.set(key, {
        language: language || undefined,
        value,
        localePreferred: item?.locale_preferred === true,
        nameType: item?.name_type || ''
      });
    }

    const designation = Array.from(unique.values())
      .sort((a, b) => {
        const rankDiff = this.#languageRank(a.language, preferredLanguageCodes) - this.#languageRank(b.language, preferredLanguageCodes);
        if (rankDiff !== 0) {
          return rankDiff;
        }
        if (a.localePreferred !== b.localePreferred) {
          return a.localePreferred ? -1 : 1;
        }
        const aFs = /fully\s*-?\s*specified/i.test(a.nameType);
        const bFs = /fully\s*-?\s*specified/i.test(b.nameType);
        if (aFs !== bFs) {
          return aFs ? -1 : 1;
        }
        return a.value.localeCompare(b.value);
      })
      .map(({ language, value }) => ({
        language,
        value
      }));

    return {
      display: designation.length > 0 ? designation[0].value : null,
      designation
    };
  }

  #extractLocalizedDefinitions(concept, preferredLanguageCodes) {
    const descriptions = Array.isArray(concept?.descriptions) ? concept.descriptions : [];
    const unique = new Map();

    for (const item of descriptions) {
      const value = item?.description;
      if (!value || typeof value !== 'string') {
        continue;
      }

      const language = typeof item?.locale === 'string' && item.locale.trim() ? item.locale.trim().toLowerCase() : null;
      const key = `${language || ''}|${value}`;
      if (unique.has(key)) {
        continue;
      }

      unique.set(key, {
        language: language || undefined,
        value,
        localePreferred: item?.locale_preferred === true,
        descriptionType: item?.description_type || ''
      });
    }

    const definitions = Array.from(unique.values())
      .sort((a, b) => {
        const rankDiff = this.#languageRank(a.language, preferredLanguageCodes) - this.#languageRank(b.language, preferredLanguageCodes);
        if (rankDiff !== 0) {
          return rankDiff;
        }
        if (a.localePreferred !== b.localePreferred) {
          return a.localePreferred ? -1 : 1;
        }
        const aDef = /definition/i.test(a.descriptionType);
        const bDef = /definition/i.test(b.descriptionType);
        if (aDef !== bDef) {
          return aDef ? -1 : 1;
        }
        return a.value.localeCompare(b.value);
      })
      .map(({ language, value }) => ({
        language,
        value
      }));

    return {
      definition: definitions.length > 0 ? definitions[0].value : null,
      definitions
    };
  }

  async #fetchCollectionSourceKeys(conceptsUrl, defaultOwner) {
    const keys = new Map();
    let page = 1;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await this.httpClient.get(conceptsUrl, { params: { page, limit: CONCEPT_PAGE_SIZE } });
      const payload = response.data;

      let items = [];
      if (Array.isArray(payload)) {
        items = payload;
      } else if (payload && typeof payload === 'object') {
        items = Array.isArray(payload.results)
          ? payload.results
          : Array.isArray(payload.items)
            ? payload.items
            : Array.isArray(payload.data)
              ? payload.data
              : [];
      }

      if (!items || items.length === 0) {
        break;
      }

      for (const concept of items) {
        const owner = concept.owner || defaultOwner || null;
        const source = concept.source || null;
        if (owner && source) {
          keys.set(`${owner}|${source}`, { owner, source });
        }
      }

      if (items.length < CONCEPT_PAGE_SIZE) {
        break;
      }

      page += 1;
    }

    return Array.from(keys.values());
  }

  async #getSourceCanonicalUrl(owner, source) {
    const key = `${owner}|${source}`;
    if (this.sourceCanonicalCache.has(key)) {
      return this.sourceCanonicalCache.get(key);
    }
    if (this.pendingSourceCanonicalRequests.has(key)) {
      return this.pendingSourceCanonicalRequests.get(key);
    }

    const path = `/orgs/${encodeURIComponent(owner)}/sources/${encodeURIComponent(source)}/`;
    const pending = (async () => {
      try {
        const response = await this.httpClient.get(path);
        const data = response.data || {};
        const canonicalUrl = data.canonical_url || data.canonicalUrl || data.url || source;
        this.sourceCanonicalCache.set(key, canonicalUrl);
        return canonicalUrl;
      } catch (error) {
        this.sourceCanonicalCache.set(key, source);
        return source;
      }
    })();

    this.pendingSourceCanonicalRequests.set(key, pending);
    try {
      return await pending;
    } finally {
      this.pendingSourceCanonicalRequests.delete(key);
    }
  }

  #matches(json, params) {
    for (const [name, value] of Object.entries(params)) {
      if (!value) {
        continue;
      }

      switch (name) {
        case 'url':
          if ((json.url || '').toLowerCase() !== value) {
            return false;
          }
          break;
        case 'system':
          if (!json.compose?.include?.some(i => (i.system || '').toLowerCase().includes(value))) {
            return false;
          }
          break;
        case 'identifier': {
          const identifiers = Array.isArray(json.identifier) ? json.identifier : (json.identifier ? [json.identifier] : []);
          const match = identifiers.some(i => (i.system || '').toLowerCase().includes(value) || (i.value || '').toLowerCase().includes(value));
          if (!match) {
            return false;
          }
          break;
        }
        default: {
          const field = json[name];
          if (field == null || !String(field).toLowerCase().includes(value)) {
            return false;
          }
          break;
        }
      }
    }
    return true;
  }

  async #fetchAllPages(path) {
    const results = [];
    let page = 1;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await this.httpClient.get(path, { params: { page, limit: PAGE_SIZE } });
      const payload = response.data;

      let items = [];
      if (Array.isArray(payload)) {
        items = payload;
      } else if (payload && typeof payload === 'object') {
        items = Array.isArray(payload.results)
          ? payload.results
          : Array.isArray(payload.items)
            ? payload.items
            : Array.isArray(payload.data)
              ? payload.data
              : [];
      }

      if (!items || items.length === 0) {
        break;
      }

      results.push(...items);

      if (items.length < PAGE_SIZE) {
        break;
      }

      page += 1;
    }

    return results;
  }

  #toIsoDate(value) {
    if (!value) {
      return null;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return date.toISOString();
  }

  #normalizeFilter(filter) {
    if (typeof filter !== 'string') {
      return null;
    }
    const normalized = filter.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  #conceptMatchesFilter(searchableText, code, display, definition, filter, filterMatcher) {
    if (!filter) {
      return true;
    }

    const codeText = code ? String(code).toLowerCase() : '';
    const displayText = display ? String(display).toLowerCase() : '';
    const definitionText = definition ? String(definition).toLowerCase() : '';

    // FHIR allows terminology-server-defined behavior; guarantee baseline contains matching.
    if (codeText.includes(filter) || displayText.includes(filter) || definitionText.includes(filter)) {
      return true;
    }

    // Preserve token/prefix behavior already provided by SearchFilterText.
    return !!(filterMatcher && filterMatcher.passes(searchableText));
  }
}

module.exports = {
  OCLValueSetProvider
};