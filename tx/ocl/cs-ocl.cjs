const fs = require('fs/promises');
const { AbstractCodeSystemProvider } = require('../cs/cs-provider-api');
const { CodeSystemProvider, CodeSystemFactoryProvider, CodeSystemContentMode, FilterExecutionContext } = require('../cs/cs-api');
const { BaseCSServices } = require('../cs/cs-base');
const { CodeSystem } = require('../library/codesystem');
const { SearchFilterText } = require('../library/designations');
const { PAGE_SIZE, CONCEPT_PAGE_SIZE, COLD_CACHE_FRESHNESS_MS, OCL_CODESYSTEM_MARKER_EXTENSION } = require('./shared/constants');
const { createOclHttpClient } = require('./http/client');
const { fetchAllPages, extractItemsAndNext } = require('./http/pagination');
const { OclReferenceResolver, isOrgOwned } = require('./resolve/reference-resolver');
const { CACHE_CS_DIR, CACHE_VS_DIR, getCacheFilePath } = require('./cache/cache-paths');
const { ensureCacheDirectories, getColdCacheAgeMs, formatCacheAgeMinutes } = require('./cache/cache-utils');
const { computeCodeSystemFingerprint } = require('./fingerprint/fingerprint');
const { OCLBackgroundJobQueue } = require('./jobs/background-queue');
const { OCLConceptFilterContext } = require('./model/concept-filter-context');
const { toConceptContext } = require('./mappers/concept-mapper');
const { patchSearchWorkerForOCLCodeFiltering, patchProviderForOCLFactorySync } = require('./shared/patches');
const regexUtilities = require("../../library/regex-utilities");
const Logger = require('../../library/logger');
const oclLog = Logger.getInstance().child({ module: 'ocl' });

patchSearchWorkerForOCLCodeFiltering();

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

class OCLCodeSystemProvider extends AbstractCodeSystemProvider {
  constructor(config = {}) {
    super();
    const options = typeof config === 'string' ? { baseUrl: config } : (config || {});

    this.org = options.org || null;
    const http = createOclHttpClient(options);
    this.baseUrl = http.baseUrl;
    this.httpClient = http.client;

    // Resolves each source's DEFAULT version (latest release, else HEAD) so both
    // get registered. Disabled without a token, in which case discovery stays
    // HEAD-only exactly as before.
    this.referenceResolver = new OclReferenceResolver({
      httpClient: this.httpClient,
      token: options.token || null
    });
    this._defaultVersionByCanonical = new Map();
    this._headMetaByCanonical = new Map();

    this._codeSystemsByCanonical = new Map();
    this._idToCodeSystem = new Map();
    this.sourceMetaByUrl = new Map();
    this._sourceStateByCanonical = new Map();
    this._usedIds = new Set();
    this._refreshPromise = null;
    this._pendingChanges = null;
    this._initialized = false;
    this._initializePromise = null;
    this._organizationIdsCache = null;
    this._organizationIdsFetchPromise = null;
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
        const sources = await this.#fetchSourcesForDiscovery();
        oclLog.info(`Fetched ${sources.length} sources`);

        const snapshot = this.#buildSourceSnapshot(sources);
        await this.#augmentSnapshotWithDefaultVersions(snapshot);
        this.#applySnapshot(snapshot);

        oclLog.info(`Loaded ${this._codeSystemsByCanonical.size} code systems`);
        this._initialized = true;
      } catch (error) {
        oclLog.error(`Initialization failed: ${error.message}`);
        if (error.response) {
          oclLog.error(`HTTP ${error.response.status}: ${error.response.statusText}`);
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

  assignIds(ids) {
    this._usedIds.clear();
    for (const cs of this._idToCodeSystem.values()) {
      if (!cs.id || ids.has(`CodeSystem/${cs.id}`)) {
        cs.id = String(ids.size);
        cs.jsonObj.id = cs.id;
      }
      ids.add(`CodeSystem/${cs.id}`);
      this._usedIds.add(cs.id);
      this._idToCodeSystem.set(cs.id, cs);
    }
  }

  // eslint-disable-next-line no-unused-vars
  async listCodeSystems(_fhirVersion, _context) {
    await this.initialize();
    return Array.from(this._codeSystemsByCanonical.values());
  }

  // eslint-disable-next-line no-unused-vars
  async loadCodeSystems(fhirVersion, context) {
    return await this.listCodeSystems(fhirVersion, context);
  }

  // Called once per minute by provider.updateCodeSystemList().
  // That caller is currently sync, so we stage async fetches and return the latest ready diff.
  // eslint-disable-next-line no-unused-vars
  getCodeSystemChanges(_fhirVersion, _context) {
    if (!this._initialized) {
      return this.#emptyChanges();
    }

    this.#scheduleRefresh();
    if (!this._pendingChanges) {
      return this.#emptyChanges();
    }

    const out = this._pendingChanges;
    this._pendingChanges = null;
    return out;
  }

  async close() {
  }

  getSourceMetas() {
    // Default metas first: registerProvider's unversioned key is first-wins, so
    // the release (when one exists) becomes what a versionless request gets,
    // matching OCL's own resolution. HEAD variants stay reachable via |HEAD.
    return [
      ...this.sourceMetaByUrl.values(),
      ...this._headMetaByCanonical.values()
    ];
  }

  /**
   * Resolve each source's DEFAULT version via one chunked $resolveReference
   * batch: OCL answers with the latest release, or HEAD when none is released.
   * For sources whose default is a release, the snapshot entry becomes the
   * release (CodeSystem resource, meta, versioned concepts URL) and the HEAD
   * variant is kept as an extra meta, so BOTH versions get factories.
   *
   * Only canonicals that are new or whose listing checksum changed are
   * re-resolved, so a steady-state refresh costs no extra requests. A no-op
   * without a token: discovery stays HEAD-only exactly as before.
   */
  async #augmentSnapshotWithDefaultVersions(snapshot) {
    if (!this.referenceResolver.isEnabled()) {
      return;
    }

    const previousSnapshot = this._sourceStateByCanonical;
    const toResolve = [];
    for (const [canonicalUrl, entry] of snapshot.entries()) {
      entry.baseChecksum = entry.checksum;
      const previous = previousSnapshot.get(canonicalUrl);
      const previousBase = previous?.baseChecksum ?? previous?.checksum ?? null;
      if (!this._defaultVersionByCanonical.has(canonicalUrl) || previousBase !== entry.baseChecksum) {
        toResolve.push(canonicalUrl);
      }
    }

    if (toResolve.length > 0) {
      const results = await this.referenceResolver.resolveReferences(toResolve, { bypassCache: true });
      if (Array.isArray(results)) {
        toResolve.forEach((canonicalUrl, i) => {
          const r = results[i];
          if (r?.resolved && r.result?.version) {
            this._defaultVersionByCanonical.set(canonicalUrl, r.result.version);
          } else {
            this._defaultVersionByCanonical.delete(canonicalUrl);
          }
        });
      } else {
        // Resolver unavailable: keep whatever defaults we knew; new canonicals
        // stay HEAD-only until a later cycle succeeds.
        oclLog.warn('Default-version resolution unavailable; keeping previous defaults');
      }
    }

    let releaseCount = 0;
    for (const [canonicalUrl, entry] of snapshot.entries()) {
      const defaultVersion = this._defaultVersionByCanonical.get(canonicalUrl);
      const headVersion = entry.meta?.version || null;
      if (!defaultVersion || defaultVersion === headVersion) {
        continue;
      }
      const conceptsUrl = entry.meta?.conceptsUrl;
      if (!conceptsUrl || !conceptsUrl.endsWith('concepts/')) {
        continue;
      }

      const baseRepo = conceptsUrl.slice(0, -'concepts/'.length);
      const releaseJson = structuredClone(entry.cs.jsonObj);
      releaseJson.version = defaultVersion;
      const releaseCs = new CodeSystem(releaseJson, 'R5', true);
      const releaseMeta = {
        ...entry.meta,
        version: defaultVersion,
        conceptsUrl: `${baseRepo}${encodeURIComponent(defaultVersion)}/concepts/`,
        codeSystem: releaseCs
      };

      entry.headMeta = entry.meta;
      entry.meta = releaseMeta;
      entry.cs = releaseCs;
      // A release being published or deleted must surface as "changed".
      entry.checksum = `${entry.baseChecksum}|default=${defaultVersion}`;
      releaseCount++;
    }

    if (releaseCount > 0) {
      oclLog.info(`${releaseCount} code system(s) defaulting to a released version (HEAD kept as |HEAD)`);
    }
  }

  #scheduleRefresh() {
    if (this._refreshPromise) {
      return;
    }

    this._refreshPromise = (async () => {
      try {
        const sources = await this.#fetchSourcesForDiscovery();
        const nextSnapshot = this.#buildSourceSnapshot(sources);
        await this.#augmentSnapshotWithDefaultVersions(nextSnapshot);
        const changes = this.#diffSnapshots(this._sourceStateByCanonical, nextSnapshot);
        this.#applySnapshot(nextSnapshot);
        // Create factories for versions that appeared: the default (release) meta
        // first so it claims the unversioned keys, then the HEAD variant. Covers
        // both newly discovered sources and a release published on a known one.
        for (const cs of [...(changes.added || []), ...(changes.changed || [])]) {
          const entry = nextSnapshot.get(cs.url);
          for (const meta of [entry?.meta, entry?.headMeta]) {
            if (!meta) {
              continue;
            }
            if (OCLSourceCodeSystemFactory.hasExactFactory(meta.canonicalUrl, meta.version || null)) {
              continue;
            }
            const factory = OCLSourceCodeSystemFactory.createForDiscoveredSource(this.httpClient, meta);
            if (factory) {
              oclLog.info(`Factory created for ${meta.canonicalUrl}|${meta.version || ''}`);
            }
          }
        }
        this._pendingChanges = changes;
      } catch (error) {
        oclLog.error(`Incremental source refresh failed: ${error.message}`);
        this._pendingChanges = this.#emptyChanges();
      } finally {
        this._refreshPromise = null;
      }
    })();
  }

  #emptyChanges() {
    return { added: [], changed: [], deleted: [] };
  }

  #buildSourceSnapshot(sources) {
    const snapshot = new Map();
    for (const source of sources || []) {
      const cs = this.#toCodeSystem(source);
      if (!cs) {
        continue;
      }

      const canonicalUrl = cs.url;
      const meta = this.#buildSourceMeta(source, cs);
      const checksum = this.#sourceChecksum(source);
      snapshot.set(canonicalUrl, { cs, meta, checksum });
    }
    return snapshot;
  }

  async #fetchSourcesForDiscovery() {
    // Prefer the global listing: one paginated crawl instead of one listing per
    // org (N+1 requests). Org-only policy: user-owned sources are experimental by
    // convention and not visible to the terminology service, so filter them out.
    try {
      const all = await this.#fetchAllPages('/sources/');
      if (Array.isArray(all) && all.length > 0) {
        const seen = new Set();
        const orgOwned = [];
        for (const source of all) {
          if (!source || typeof source !== 'object' || !isOrgOwned(source)) {
            continue;
          }
          const key = this.#sourceIdentity(source);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          orgOwned.push(source);
        }
        if (orgOwned.length > 0) {
          return orgOwned;
        }
      }
    } catch (error) {
      oclLog.warn(`Global /sources/ listing failed (${error.message}); falling back to per-org discovery`);
    }

    const organizations = await this.#fetchOrganizationIds();
    if (organizations.length === 0) {
      return [];
    }

    const allSources = [];
    const seen = new Set();

    for (const orgId of organizations) {
      const endpoint = `/orgs/${encodeURIComponent(orgId)}/sources/`;
      const sources = await this.#fetchAllPages(endpoint);
      for (const source of sources) {
        if (!source || typeof source !== 'object') {
          continue;
        }
        const key = this.#sourceIdentity(source);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        allSources.push(source);
      }
    }

    return allSources;
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

  #sourceIdentity(source) {
    if (!source || typeof source !== 'object') {
      return '__invalid__';
    }

    const owner = source.owner || '';
    const canonical = normalizeCanonicalSystem(source.canonical_url || source.canonicalUrl || '');
    const shortCode = source.short_code || source.shortCode || source.id || source.mnemonic || source.name || '';
    return `${owner}|${canonical}|${shortCode}`;
  }

  #applySnapshot(snapshot) {
    const previousSnapshot = this._sourceStateByCanonical;
    this._codeSystemsByCanonical.clear();
    this._idToCodeSystem.clear();
    this.sourceMetaByUrl.clear();
    this._headMetaByCanonical.clear();
    this._usedIds.clear();

    for (const [canonicalUrl, entry] of snapshot.entries()) {
      const cs = entry.cs;
      const meta = entry.meta;
      const previousEntry = previousSnapshot.get(canonicalUrl);

      // Preserve complete-content marker if checksum did not change.
      if (previousEntry && previousEntry.checksum === entry.checksum && previousEntry.cs?.jsonObj?.content === CodeSystemContentMode.Complete) {
        cs.jsonObj.content = CodeSystemContentMode.Complete;

        // Preserve materialized concepts across metadata refreshes.
        if (Array.isArray(previousEntry.cs?.jsonObj?.concept)) {
          cs.jsonObj.concept = previousEntry.cs.jsonObj.concept.map(concept => ({ ...concept }));
        }
      }

      // If a factory already has warm/cold concepts for this system, project them to the new snapshot resource.
      OCLSourceCodeSystemFactory.syncCodeSystemResource(canonicalUrl, cs.version || null, cs);

      this.#trackCodeSystemId(cs);
      this._codeSystemsByCanonical.set(canonicalUrl, cs);
      this._idToCodeSystem.set(cs.id, cs);
      this.sourceMetaByUrl.set(canonicalUrl, meta);
      if (entry.headMeta) {
        this._headMetaByCanonical.set(canonicalUrl, entry.headMeta);
      }
    }

    this._sourceStateByCanonical = snapshot;
  }

  #diffSnapshots(previousSnapshot, nextSnapshot) {
    const added = [];
    const changed = [];
    const deleted = [];

    for (const [canonicalUrl, nextEntry] of nextSnapshot.entries()) {
      const previousEntry = previousSnapshot.get(canonicalUrl);
      if (!previousEntry) {
        added.push(nextEntry.cs);
        continue;
      }

      // Keep stable ids across revisions so clients don't observe resource id churn.
      nextEntry.cs.id = previousEntry.cs.id;
      nextEntry.cs.jsonObj.id = previousEntry.cs.id;

      const previousChecksum = previousEntry.checksum || null;
      const nextChecksum = nextEntry.checksum || null;
      const checksumChanged = previousChecksum !== nextChecksum;
      const versionChanged = (previousEntry.cs.version || null) !== (nextEntry.cs.version || null);
      if (checksumChanged || versionChanged) {
        if (checksumChanged) {
          oclLog.info(`CodeSystem checksum changed: ${canonicalUrl} (${previousChecksum} -> ${nextChecksum})`);
        }
        changed.push(nextEntry.cs);
      }
    }

    for (const [canonicalUrl, previousEntry] of previousSnapshot.entries()) {
      if (!nextSnapshot.has(canonicalUrl)) {
        deleted.push(previousEntry.cs);
      }
    }

    return { added, changed, deleted };
  }

  #trackCodeSystemId(cs) {
    if (!cs) {
      return;
    }

    if (!cs.id || this._usedIds.has(cs.id)) {
      const raw = cs.id || cs.name || cs.url || 'ocl-cs';
      const base = this.spaceId ? `${this.spaceId}-${raw}` : String(raw);
      let candidate = base;
      let index = 1;
      while (this._usedIds.has(candidate)) {
        candidate = `${base}-${index}`;
        index += 1;
      }
      cs.id = candidate;
      cs.jsonObj.id = candidate;
    }

    this._usedIds.add(cs.id);
  }

  #toCodeSystem(source) {
    if (!source || typeof source !== 'object') {
      return null;
    }

    const canonicalUrl = normalizeCanonicalSystem(source.canonical_url || source.canonicalUrl || source.url);
    if (!canonicalUrl) {
      return null;
    }

    const id = source.id || source.mnemonic;
    if (!id) {
      return null;
    }

    const lastUpdated = this.#toIsoDate(source.updated_at || source.updatedAt || source.updated_on || source.updatedOn);

    const json = {
      resourceType: 'CodeSystem',
      id,
      url: canonicalUrl,
      version: source.version || null,
      name: source.name || source.mnemonic || id,
      title: source.full_name || source.fullName || source.name || source.mnemonic || id,
      status: 'active',
      experimental: source.experimental === true,
      description: source.description || null,
      publisher: source.owner || null,
      caseSensitive: source.case_sensitive != null ? source.case_sensitive : (source.caseSensitive != null ? source.caseSensitive : true),
      language: source.default_locale || source.defaultLocale || null,
      filter: [
        {
          code: 'code',
          description: 'Match concept code',
          operator: ['=', 'in', 'regex'],
          value: 'code'
        },
        {
          code: 'display',
          description: 'Match concept display text',
          operator: ['=', 'in', 'regex'],
          value: 'string'
        },
        {
          code: 'definition',
          description: 'Match concept definition text',
          operator: ['=', 'in', 'regex'],
          value: 'string'
        },
        {
          code: 'inactive',
          description: 'Match inactive (retired) status',
          operator: ['=', 'in'],
          value: 'boolean'
        }
      ],
      property: [
        {
          code: 'code',
          uri: 'http://hl7.org/fhir/concept-properties#code',
          description: 'Concept code',
          type: 'code'
        },
        {
          code: 'display',
          description: 'Concept display text',
          type: 'string'
        },
        {
          code: 'definition',
          description: 'Concept definition text',
          type: 'string'
        },
        {
          code: 'inactive',
          uri: 'http://hl7.org/fhir/concept-properties#status',
          description: 'Whether concept is inactive (retired)',
          type: 'boolean'
        }
      ],
      extension: [
        {
          url: OCL_CODESYSTEM_MARKER_EXTENSION,
          valueBoolean: true
        }
      ],
      content: 'not-present'
    };

    if (lastUpdated) {
      json.meta = { lastUpdated };
    }

    return new CodeSystem(json, 'R5', true);
  }

  #buildSourceMeta(source, cs) {
    if (!source || !cs) {
      return null;
    }

    const owner = source.owner || null;
    const shortCode = source.short_code || source.shortCode || source.mnemonic || source.id || null;
    const canonicalUrl = cs.url;
    if (!canonicalUrl) {
      return;
    }

    const conceptsUrl = this.#normalizePath(source.concepts_url || source.conceptsUrl || this.#buildConceptsPath(source));
    const meta = {
      id: source.id || shortCode,
      shortCode,
      owner,
      name: source.name || shortCode || cs.id,
      description: source.description || null,
      canonicalUrl,
      version: source.version || null,
      conceptsUrl,
      checksum: this.#sourceChecksum(source),
      codeSystem: cs
    };

    return meta;
  }

  #sourceChecksum(source) {
    // NOTE: OCL checksums are NOT reliable for cache invalidation decisions.
    // They do not update when concepts are added or modified.
    // This checksum is logged for debugging purposes only.
    // Cache decisions are based on custom fingerprints computed from concept content.
    
    if (!source || typeof source !== 'object') {
      return null;
    }

    const checksums = source.checksums || {};
    const standard = checksums.standard || null;
    const smart = checksums.smart || null;
    if (standard) {
      return String(standard);
    }
    if (smart) {
      return String(smart);
    }

    if (source.checksum) {
      return String(source.checksum);
    }

    const updated = source.updated_at || source.updatedAt || source.updated_on || source.updatedOn || null;
    const version = source.version || null;
    if (updated || version) {
      return `${updated || ''}|${version || ''}`;
    }

    return null;
  }

  #buildConceptsPath(source) {
    if (!source || typeof source !== 'object') {
      return null;
    }
    const owner = source.owner || null;
    const sourceId = source.short_code || source.shortCode || source.id || source.mnemonic || null;
    if (!owner || !sourceId) {
      const sourceUrl = source.url;
      if (!sourceUrl || typeof sourceUrl !== 'string') {
        return null;
      }
      const trimmed = sourceUrl.endsWith('/') ? sourceUrl : `${sourceUrl}/`;
      return `${trimmed}concepts/`;
    }
    return `/orgs/${encodeURIComponent(owner)}/sources/${encodeURIComponent(sourceId)}/concepts/`;
  }

  #normalizePath(pathValue) {
    // Não normaliza nem remove barras, retorna exatamente o valor fornecido pelo autor
    if (!pathValue) {
      return null;
    }
    if (typeof pathValue !== 'string') {
      return null;
    }
    return pathValue;
  }

  async #fetchAllPages(path) {
    try {
      const result = await fetchAllPages(this.httpClient, path, {
        pageSize: PAGE_SIZE,
        baseUrl: this.baseUrl,
        logger: oclLog,
        loggerPrefix: ''
      });
      // Extra check: payload must be object or array
      if (!result || (typeof result !== 'object' && !Array.isArray(result))) {
        throw new Error('[OCL] Invalid response format: expected object or array');
      }
      return result;
    } catch (error) {
      if (error.response) {
        oclLog.error(`HTTP ${error.response.status}: ${error.response.statusText}`);
        oclLog.error(`Response: ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  #extractItemsAndNext(payload) {
    return extractItemsAndNext(payload, this.baseUrl);
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
}

class OCLSourceCodeSystemProvider extends BaseCSServices {
  constructor(opContext, supplements, client, meta, sharedCaches = null) {
    super(opContext, supplements);
    this.httpClient = client;
    this.meta = meta;
    this.conceptCache = sharedCaches?.conceptCache || new Map();
    this.pageCache = sharedCaches?.pageCache || new Map();
    this.pendingConceptRequests = sharedCaches?.pendingConceptRequests || new Map();
    this.pendingPageRequests = sharedCaches?.pendingPageRequests || new Map();
    this.scheduleBackgroundLoad = typeof sharedCaches?.scheduleBackgroundLoad === 'function'
      ? sharedCaches.scheduleBackgroundLoad
      : null;
    this.isSystemComplete = typeof sharedCaches?.isSystemComplete === 'function'
      ? sharedCaches.isSystemComplete
      : (() => false);
    this.getTotalConceptCount = typeof sharedCaches?.getTotalConceptCount === 'function'
      ? sharedCaches.getTotalConceptCount
      : (() => -1);
  }

  system() {
    return this.meta.canonicalUrl;
  }

  version() {
    return this.meta.version || null;
  }

  description() {
    return this.meta.description || null;
  }

  name() {
    return this.meta.name || this.meta.shortCode || this.meta.id || this.system();
  }

  contentMode() {
    if (this.isSystemComplete()) {
      return CodeSystemContentMode.Complete;
    }

    // OCL CodeSystems are lazily materialized. Even when metadata is still
    // warming up, concepts remain fetchable through the source concepts URL.
    // Report at least fragment support so $expand does not fail early with
    // "has no content" before lazy retrieval/hydration can run.
    const hasRealCodeSystemResource = this.meta?.codeSystem instanceof CodeSystem;
    if (hasRealCodeSystemResource && (this.meta?.conceptsUrl || this.conceptCache.size > 0 || this.pageCache.size > 0)) {
      return CodeSystemContentMode.Fragment;
    }

    return CodeSystemContentMode.NotPresent;
  }

  totalCount() {
    return this.getTotalConceptCount();
  }

  propertyDefinitions() {
    return this.meta?.codeSystem?.jsonObj?.property || null;
  }

  async code(code) {
    const ctxt = await this.#ensureContext(code);
    return ctxt ? ctxt.code : null;
  }

  async display(code) {
    const ctxt = await this.#ensureContext(code);
    if (!ctxt) {
      return null;
    }
    if (ctxt.display && this.opContext.langs.isEnglishOrNothing()) {
      return ctxt.display;
    }
    const supp = this._displayFromSupplements(ctxt.code);
    return supp || ctxt.display || null;
  }

  async definition(code) {
    const ctxt = await this.#ensureContext(code);
    return ctxt ? ctxt.definition : null;
  }

  async isAbstract(code) {
    await this.#ensureContext(code);
    return false;
  }

  async isInactive(code) {
    const ctxt = await this.#ensureContext(code);
    return ctxt ? ctxt.retired === true : false;
  }

  async isDeprecated(code) {
    await this.#ensureContext(code);
    return false;
  }

  async getStatus(code) {
    const ctxt = await this.#ensureContext(code);
    if (!ctxt) {
      return null;
    }
    return ctxt.retired === true ? 'inactive' : 'active';
  }

  async designations(code, displays) {
    const ctxt = await this.#ensureContext(code);
    if (ctxt && ctxt.display) {
      const hasConceptDesignations = Array.isArray(ctxt.designation) && ctxt.designation.length > 0;
      if (hasConceptDesignations) {
        let hasNoLanguageEntry = false;
        for (const d of ctxt.designation) {
          if (!d || !d.value) {
            continue;
          }
          displays.addDesignation(true, 'active', d.language || '', CodeSystem.makeUseForDisplay(), d.value);
          if (!d.language) {
            hasNoLanguageEntry = true;
          }
        }
        // Guarantee a language-neutral fallback so preferredDesignation() always returns
        // a display value when the requested language has no matching designation.
        // This implements the FHIR graceful-fallback rule for displayLanguage.
        if (!hasNoLanguageEntry) {
          displays.addDesignation(true, 'active', '', CodeSystem.makeUseForDisplay(), ctxt.display);
        }
      } else {
        // No structured designations available. Use the source's configured language
        // rather than hard-coding 'en' to avoid mislabeling non-English displays as English.
        const defaultLang = this.meta?.codeSystem?.jsonObj?.language || '';
        displays.addDesignation(true, 'active', defaultLang, CodeSystem.makeUseForDisplay(), ctxt.display);
        // Also provide a no-language fallback for graceful language resolution.
        if (defaultLang) {
          displays.addDesignation(true, 'active', '', CodeSystem.makeUseForDisplay(), ctxt.display);
        }
      }
      this._listSupplementDesignations(ctxt.code, displays);
    }
  }

  async extendLookup(ctxt, props, params) {
    const context = await this.#ensureContext(ctxt);
    const extras = context && context.extras;
    if (!extras || typeof extras !== 'object') {
      return;
    }
    for (const [key, value] of Object.entries(extras)) {
      if (!key || value === null || value === undefined) {
        continue;
      }
      if (!this._hasProp(props, key, true)) {
        continue;
      }
      const part = [{ name: 'code', valueCode: key }];
      if (typeof value === 'boolean') {
        part.push({ name: 'value', valueBoolean: value });
      } else if (typeof value === 'number' && Number.isInteger(value)) {
        part.push({ name: 'value', valueInteger: value });
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        part.push({ name: 'value', valueDecimal: value });
      } else if (typeof value === 'string') {
        part.push({ name: 'value', valueString: value });
      } else {
        // Extras may hold arbitrary JSON (arrays, objects); serialize rather than drop data.
        part.push({ name: 'value', valueString: JSON.stringify(value) });
      }
      params.push({ name: 'property', part });
    }
  }

  async locate(code) {
    if (!code || typeof code !== 'string') {
      return { context: null, message: 'Empty code' };
    }

    if (this.conceptCache.has(code)) {
      return { context: this.conceptCache.get(code), message: null };
    }

    // OCL concept IDs may differ in case from the FHIR code (e.g. "y" vs "Y").
    // Try a case-insensitive cache lookup before hitting the network.
    const codeLower = code.toLowerCase();
    for (const [key, value] of this.conceptCache.entries()) {
      if (key.toLowerCase() === codeLower) {
        // Cache under the requested case as well so future lookups are O(1).
        this.conceptCache.set(code, value);
        return { context: value, message: null };
      }
    }

    if (this.scheduleBackgroundLoad) {
      this.scheduleBackgroundLoad('lookup-miss');
    }

    const concept = await this.#fetchConcept(code);
    if (!concept) {
      return { context: null, message: undefined };
    }

    this.conceptCache.set(code, concept);
    return { context: concept, message: null };
  }

  async iterator(code) {
    await this.#ensureContext(code);
    if (code) {
      return null;
    }
    return {
      page: 1,
      index: 0,
      items: [],
      total: -1,
      done: false
    };
  }

  async iteratorAll() {
    return this.iterator(null);
  }

  async getPrepContext(iterate) {
    return new FilterExecutionContext(iterate);
  }

  async doesFilter(prop, op, value) {
    if (!prop || !op || value == null) {
      return false;
    }

    const normalizedProp = String(prop).trim().toLowerCase();
    const normalizedOp = String(op).trim().toLowerCase();
    const supportedOps = ['=', 'in', 'regex'];
    if (!supportedOps.includes(normalizedOp)) {
      return false;
    }

    if (['concept', 'code', 'display', 'definition', 'inactive'].includes(normalizedProp)) {
      return true;
    }

    const defs = this.propertyDefinitions() || [];
    return defs.some(def => def && def.code === normalizedProp);
  }

  async searchFilter(filterContext, filter, sort) {
    const matcher = this.#toSearchFilterText(filter);
    const results = new OCLConceptFilterContext();
    const concepts = await this.#allConceptContexts();

    for (const concept of concepts) {
      const text = this.#conceptSearchText(concept);
      const match = matcher.passes(text, true);
      if (!match || match.passes !== true) {
        continue;
      }

      results.add(concept, this.#searchRating(concept, matcher, match.rating));
    }

    if (sort === true) {
      results.sort();
    }

    if (!Array.isArray(filterContext.filters)) {
      filterContext.filters = [];
    }
    filterContext.filters.push(results);
    return filterContext;
  }

  async filter(filterContext, prop, op, value) {
    const normalizedProp = String(prop || '').trim().toLowerCase();
    const normalizedOp = String(op || '').trim().toLowerCase();

    if (!await this.doesFilter(normalizedProp, normalizedOp, value)) {
      throw new Error(`Filter ${prop} ${op} is not supported by OCL provider`);
    }

    const set = new OCLConceptFilterContext();
    const concepts = await this.#allConceptContexts();
    const matcher = this.#buildPropertyMatcher(normalizedProp, normalizedOp, value);

    for (const concept of concepts) {
      if (matcher(concept)) {
        set.add(concept, 0);
      }
    }

    if (!Array.isArray(filterContext.filters)) {
      filterContext.filters = [];
    }
    filterContext.filters.push(set);
    return set;
  }

  async executeFilters(filterContext) {
    return Array.isArray(filterContext?.filters) ? filterContext.filters : [];
  }

  // eslint-disable-next-line no-unused-vars
  async filterSize(filterContext, set) {
    return set ? set.size() : 0;
  }

  // eslint-disable-next-line no-unused-vars
  async filterMore(filterContext, set) {
    return !!set && set.hasMore();
  }

  // eslint-disable-next-line no-unused-vars
  async filterConcept(filterContext, set) {
    if (!set) {
      return null;
    }
    return set.next();
  }

  // eslint-disable-next-line no-unused-vars
  async filterLocate(filterContext, set, code) {
    if (!set) {
      return `Code '${code}' not found: no filter results`;
    }
    const concept = set.findConceptByCode(code);
    if (concept) {
      return concept;
    }
    return null;
  }

  // eslint-disable-next-line no-unused-vars
  async filterCheck(filterContext, set, concept) {
    if (!set || !concept) {
      return false;
    }
    return set.containsConcept(concept);
  }

  async filterFinish(filterContext) {
    if (!Array.isArray(filterContext?.filters)) {
      return;
    }
    for (const set of filterContext.filters) {
      if (set && typeof set.reset === 'function') {
        set.reset();
      }
    }
    filterContext.filters.length = 0;
  }

  async nextContext(iteratorContext) {
    if (!iteratorContext || iteratorContext.done) {
      return null;
    }

    if (iteratorContext.index >= iteratorContext.items.length) {
      const pageItems = await this.#fetchConceptPage(iteratorContext.page);
      iteratorContext.page += 1;
      iteratorContext.index = 0;
      iteratorContext.items = pageItems;

      if (!pageItems || pageItems.length === 0) {
        iteratorContext.done = true;
        return null;
      }
    }

    const concept = iteratorContext.items[iteratorContext.index];
    iteratorContext.index += 1;
    return concept;
  }

  async #ensureContext(code) {
    if (!code) {
      return null;
    }

    // Some call paths pass a pending locate() Promise (or its wrapper result)
    // instead of a raw code/context; normalize both shapes here.
    if (code && typeof code === 'object' && typeof code.then === 'function') {
      code = await code;
    }

    if (code && typeof code === 'object' && Object.prototype.hasOwnProperty.call(code, 'context')) {
      if (!code.context) {
        throw new Error(code.message || 'Unknown code');
      }
      code = code.context;
    }

    if (typeof code === 'string') {
      const result = await this.locate(code);
      if (!result.context) {
        throw new Error(result.message || `Unknown code ${code}`);
      }
      return result.context;
    }
    if (code && typeof code === 'object' && code.code) {
      return code;
    }
    throw new Error(`Unknown Type at #ensureContext: ${typeof code}`);
  }

  async #fetchConceptPage(page) {
    if (!this.meta.conceptsUrl) {
      return [];
    }
    const cacheKey = `${this.meta.conceptsUrl}|p=${page}|l=${CONCEPT_PAGE_SIZE}|verbose=1`;
    if (this.pageCache.has(cacheKey)) {
      const cached = this.pageCache.get(cacheKey);
      return Array.isArray(cached)
        ? cached
        : Array.isArray(cached?.concepts)
          ? cached.concepts
          : [];
    }
    if (this.pendingPageRequests.has(cacheKey)) {
      const pendingResult = await this.pendingPageRequests.get(cacheKey);
      return Array.isArray(pendingResult)
        ? pendingResult
        : Array.isArray(pendingResult?.concepts)
          ? pendingResult.concepts
          : [];
    }

    if (this.scheduleBackgroundLoad) {
      this.scheduleBackgroundLoad('page-miss');
    }

    const pending = (async () => {
      let response;
      try {
        response = await this.httpClient.get(this.meta.conceptsUrl, { params: { page, limit: CONCEPT_PAGE_SIZE, verbose: true } });
      } catch (error) {
        // Some OCL instances return 404 for sources without concept listing endpoints.
        // Treat this as an empty page so terminology operations degrade gracefully.
        if (error && error.response && error.response.status === 404) {
          this.pageCache.set(cacheKey, []);
          return [];
        }
        throw error;
      }
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

      const mapped = items.map(item => this.#toConceptContext(item)).filter(Boolean);
      this.pageCache.set(cacheKey, mapped);
      for (const concept of mapped) {
        if (concept && concept.code) {
          this.conceptCache.set(concept.code, concept);
        }
      }
      return mapped;
    })();

    this.pendingPageRequests.set(cacheKey, pending);
    try {
      return await pending;
    } finally {
      this.pendingPageRequests.delete(cacheKey);
    }
  }

  async #fetchConcept(code) {
    if (!this.meta.conceptsUrl) {
      return null;
    }
    if (this.conceptCache.has(code)) {
      return this.conceptCache.get(code);
    }
    const pendingKey = `${this.meta.conceptsUrl}|c=${code}`;
    if (this.pendingConceptRequests.has(pendingKey)) {
      return this.pendingConceptRequests.get(pendingKey);
    }

    if (this.scheduleBackgroundLoad) {
      this.scheduleBackgroundLoad('concept-miss');
    }

    const pending = (async () => {
      const concept = await this.#fetchConceptByCode(code);
      if (concept) {
        return concept;
      }
      // OCL concept IDs may differ in case from the FHIR code (e.g. "y" vs "Y").
      // Try common case alternatives before giving up.
      const lower = code.toLowerCase();
      const upper = code.toUpperCase();
      for (const alt of [lower, upper]) {
        if (alt !== code) {
          const altConcept = await this.#fetchConceptByCode(alt);
          if (altConcept) {
            // Cache under the originally requested code so future lookups hit directly.
            this.conceptCache.set(code, altConcept);
            return altConcept;
          }
        }
      }
      return null;
    })();

    this.pendingConceptRequests.set(pendingKey, pending);
    try {
      return await pending;
    } finally {
      this.pendingConceptRequests.delete(pendingKey);
    }
  }

  async #fetchConceptByCode(code) {
    const url = this.#buildConceptUrl(code);
    let response;
    try {
      response = await this.httpClient.get(url, { params: { verbose: true } });
    } catch (error) {
      if (error && error.response && error.response.status === 404) {
        return null;
      }
      throw error;
    }
    const concept = this.#toConceptContext(response.data);
    if (concept && concept.code) {
      this.conceptCache.set(concept.code, concept);
    }
    return concept;
  }

  async #allConceptContexts() {
    const concepts = new Map();

    for (const concept of this.conceptCache.values()) {
      if (concept && concept.code) {
        concepts.set(concept.code, concept);
      }
    }

    // Ensure search can operate even when content is not fully warm-loaded.
    const iter = await this.iterator(null);
    let concept = await this.nextContext(iter);
    while (concept) {
      if (concept.code && !concepts.has(concept.code)) {
        concepts.set(concept.code, concept);
      }
      concept = await this.nextContext(iter);
    }

    return Array.from(concepts.values());
  }

  #toSearchFilterText(filter) {
    if (filter instanceof SearchFilterText) {
      return filter;
    }
    if (typeof filter === 'string') {
      return new SearchFilterText(filter);
    }
    if (filter && typeof filter.filter === 'string') {
      return new SearchFilterText(filter.filter);
    }
    return new SearchFilterText('');
  }

  #conceptSearchText(concept) {
    if (!concept || typeof concept !== 'object') {
      return '';
    }

    const values = [concept.code, concept.display, concept.definition];
    if (Array.isArray(concept.designations)) {
      for (const designation of concept.designations) {
        if (designation && designation.value) {
          values.push(designation.value);
        }
      }
    }

    return values.filter(Boolean).join(' ');
  }

  #searchRating(concept, matcher, baseRating) {
    let rating = Number.isFinite(baseRating) ? baseRating : 0;
    const term = matcher?.filter || '';
    if (!term) {
      return rating;
    }

    const code = String(concept?.code || '').toLowerCase();
    const display = String(concept?.display || '').toLowerCase();
    const definition = String(concept?.definition || '').toLowerCase();

    if (code === term || display === term) {
      rating += 100;
    } else if (code.startsWith(term) || display.startsWith(term)) {
      rating += 50;
    } else if (definition.includes(term)) {
      rating += 10;
    }

    return rating;
  }

  #buildPropertyMatcher(prop, op, value) {
    if (op === 'regex') {
      const regex = regexUtilities.compile(String(value), 'i');
      return concept => {
        const candidate = this.#valueForFilter(concept, prop);
        if (candidate == null) {
          return false;
        }
        return regex.test(String(candidate));
      };
    }

    if (op === 'in') {
      const tokens = String(value)
        .split(',')
        .map(token => token.trim().toLowerCase())
        .filter(Boolean);
      return concept => {
        const candidate = this.#valueForFilter(concept, prop);
        if (candidate == null) {
          return false;
        }
        return tokens.includes(String(candidate).toLowerCase());
      };
    }

    if (prop === 'inactive') {
      const expected = this.#toBoolean(value);
      return concept => {
        const candidate = this.#toBoolean(this.#valueForFilter(concept, prop));
        return candidate === expected;
      };
    }

    const expected = String(value).toLowerCase();
    return concept => {
      const candidate = this.#valueForFilter(concept, prop);
      if (candidate == null) {
        return false;
      }
      return String(candidate).toLowerCase() === expected;
    };
  }

  #valueForFilter(concept, prop) {
    if (!concept || typeof concept !== 'object') {
      return null;
    }

    switch (prop) {
      case 'concept':
      case 'code':
        return concept.code || null;
      case 'display':
        return concept.display || null;
      case 'definition':
        return concept.definition || null;
      case 'inactive':
        return concept.retired === true;
      default:
        return concept[prop] ?? null;
    }
  }

  #toBoolean(value) {
    if (typeof value === 'boolean') {
      return value;
    }

    const text = String(value || '').trim().toLowerCase();
    return text === 'true' || text === '1' || text === 'yes';
  }

  #buildConceptUrl(code) {
    const base = this.meta.conceptsUrl.endsWith('/') ? this.meta.conceptsUrl : `${this.meta.conceptsUrl}/`;
    return `${base}${encodeURIComponent(code)}/`;
  }

  #toConceptContext(concept) {
    return toConceptContext(concept);
  }
}

class OCLSourceCodeSystemFactory extends CodeSystemFactoryProvider {
  static factoriesByKey = new Map();
  static #sharedI18n = null;

  static createForDiscoveredSource(httpClient, meta) {
    if (!OCLSourceCodeSystemFactory.#sharedI18n) {
      return null;
    }
    return new OCLSourceCodeSystemFactory(OCLSourceCodeSystemFactory.#sharedI18n, httpClient, meta);
  }

  static #normalizeSystem(system) {
    return normalizeCanonicalSystem(system);
  }

  static hasFactory(system, version = null) {
    return !!OCLSourceCodeSystemFactory.#findFactory(system, version);
  }

  static hasExactFactory(system, version = null) {
    const normalizedSystem = OCLSourceCodeSystemFactory.#normalizeSystem(system);
    if (!normalizedSystem) {
      return false;
    }

    const exactKey = `${normalizedSystem}|${version || ''}`;
    return OCLSourceCodeSystemFactory.factoriesByKey.has(exactKey);
  }

  static #findFactory(system, version = null) {
    const normalizedSystem = OCLSourceCodeSystemFactory.#normalizeSystem(system);
    if (!normalizedSystem) {
      return null;
    }

    const exactKey = `${normalizedSystem}|${version || ''}`;
    const exact = OCLSourceCodeSystemFactory.factoriesByKey.get(exactKey);
    if (exact) {
      return exact;
    }

    // When caller version does not match the registered one (or is absent),
    // still reuse the factory for the same canonical system.
    for (const [key, factory] of OCLSourceCodeSystemFactory.factoriesByKey.entries()) {
      if (!factory) {
        continue;
      }

      const separatorIndex = key.lastIndexOf('|');
      if (separatorIndex < 0) {
        continue;
      }

      const keySystem = OCLSourceCodeSystemFactory.#normalizeSystem(key.substring(0, separatorIndex));
      if (keySystem === normalizedSystem) {
        return factory;
      }
    }

    return null;
  }

  static syncCodeSystemResource(system, version = null, codeSystem = null) {
    const normalizedSystem = OCLSourceCodeSystemFactory.#normalizeSystem(system);
    if (!normalizedSystem) {
      return;
    }

    const factory = OCLSourceCodeSystemFactory.#findFactory(normalizedSystem, version);
    if (!factory) {
      return;
    }

    factory.#applyConceptsToCodeSystemResource(codeSystem || factory.meta?.codeSystem || null);
  }

  constructor(i18n, client, meta) {
    super(i18n);
    if (!OCLSourceCodeSystemFactory.#sharedI18n) {
      OCLSourceCodeSystemFactory.#sharedI18n = i18n;
    }
    this.httpClient = client;
    this.meta = meta;
    this.sharedConceptCache = new Map();
    this.sharedPageCache = new Map();
    this.sharedPendingConceptRequests = new Map();
    this.sharedPendingPageRequests = new Map();
    this.isComplete = meta?.codeSystem?.jsonObj?.content === CodeSystemContentMode.Complete;
    this.loadedConceptCount = -1;
    this.loadedChecksum = meta?.checksum || null;
    this.customFingerprint = null;
    this.backgroundLoadProgress = { processed: 0, total: null };
    this.materializedConceptList = null;
    this.materializedConceptCount = -1;
    OCLSourceCodeSystemFactory.factoriesByKey.set(this.#resourceKey(), this);

    const unversionedKey = `${this.system()}|`;
    if (!OCLSourceCodeSystemFactory.factoriesByKey.has(unversionedKey)) {
      OCLSourceCodeSystemFactory.factoriesByKey.set(unversionedKey, this);
    }
    
    // Load cold cache at construction
    this.#loadColdCache();
  }

  async #loadColdCache() {
    const canonicalUrl = this.system();
    const version = this.version();
    const cacheFilePath = getCacheFilePath(CACHE_CS_DIR, canonicalUrl, version);

    try {
      const data = await fs.readFile(cacheFilePath, 'utf-8');
      const cached = JSON.parse(data);

      if (!cached || !cached.concepts || !Array.isArray(cached.concepts)) {
        return;
      }

      // Restore concepts to cache
      for (const concept of cached.concepts) {
        if (concept && concept.code) {
          this.sharedConceptCache.set(concept.code, concept);
        }
      }

      this.loadedConceptCount = cached.concepts.length;
      this.customFingerprint = cached.fingerprint || null;
      this.isComplete = true;

      if (this.meta?.codeSystem?.jsonObj) {
        this.meta.codeSystem.jsonObj.content = CodeSystemContentMode.Complete;
      }

      this.#applyConceptsToCodeSystemResource(this.meta?.codeSystem || null);

    } catch (error) {
      if (error.code !== 'ENOENT') {
        oclLog.error(`Failed to load cold cache for CodeSystem ${canonicalUrl}: ${error.message}`);
      }
    }
  }

  async #saveColdCache(concepts) {
    const canonicalUrl = this.system();
    const version = this.version();
    const cacheFilePath = getCacheFilePath(CACHE_CS_DIR, canonicalUrl, version);

    try {
      await ensureCacheDirectories(CACHE_CS_DIR, CACHE_VS_DIR);

      const fingerprint = computeCodeSystemFingerprint(concepts);
      const cacheData = {
        canonicalUrl,
        version,
        fingerprint,
        timestamp: new Date().toISOString(),
        conceptCount: concepts.length,
        concepts
      };

      await fs.writeFile(cacheFilePath, JSON.stringify(cacheData, null, 2), 'utf-8');
      
      return fingerprint;
    } catch (error) {
      oclLog.error(`Failed to save cold cache for CodeSystem ${canonicalUrl}: ${error.message}`);
      return null;
    }
  }

  static scheduleBackgroundLoadByKey(system, version = null, reason = 'valueset-expansion') {
    const normalizedSystem = OCLSourceCodeSystemFactory.#normalizeSystem(system);
    const key = `${normalizedSystem}|${version || ''}`;
    const factory = OCLSourceCodeSystemFactory.#findFactory(normalizedSystem, version);
    if (!factory) {
      return false;
    }
    factory.scheduleBackgroundLoad(reason);
    return true;
  }

  static checksumForResource(system, version = null) {
    const normalizedSystem = OCLSourceCodeSystemFactory.#normalizeSystem(system);
    const factory = OCLSourceCodeSystemFactory.#findFactory(normalizedSystem, version);
    if (!factory) {
      return null;
    }
    return factory.currentChecksum();
  }

  static loadProgress() {
    let total = 0;
    let loaded = 0;

    for (const factory of OCLSourceCodeSystemFactory.factoriesByKey.values()) {
      total += 1;
      if (factory && factory.isCompleteNow()) {
        loaded += 1;
      }
    }

    const percentage = total > 0 ? (loaded / total) * 100 : 0;
    return { loaded, total, percentage };
  }

  defaultVersion() {
    return this.meta.version || null;
  }

  build(opContext, supplements) {
    this.#syncWarmStateWithChecksum();
    this.#applyConceptsToCodeSystemResource(this.meta?.codeSystem || null);
    this.recordUse();
    return new OCLSourceCodeSystemProvider(opContext, supplements, this.httpClient, this.meta, {
      conceptCache: this.sharedConceptCache,
      pageCache: this.sharedPageCache,
      pendingConceptRequests: this.sharedPendingConceptRequests,
      pendingPageRequests: this.sharedPendingPageRequests,
      scheduleBackgroundLoad: reason => this.scheduleBackgroundLoad(reason),
      isSystemComplete: () => this.isComplete,
      getTotalConceptCount: () => this.loadedConceptCount
    });
  }

  scheduleBackgroundLoad(reason = 'request') {
    this.#syncWarmStateWithChecksum();
    const cacheFilePath = getCacheFilePath(CACHE_CS_DIR, this.system(), this.version());
    const cacheAgeMs = getColdCacheAgeMs(cacheFilePath);

    // If warm state is complete but cold cache is stale, force a refresh run.
    // This keeps warm data available while ensuring stale cold-cache files are replaced.
    if (this.isComplete) {
      if (cacheAgeMs == null || cacheAgeMs < COLD_CACHE_FRESHNESS_MS) {
        return;
      }

      this.isComplete = false;
      if (this.meta?.codeSystem?.jsonObj?.content === CodeSystemContentMode.Complete) {
        this.meta.codeSystem.jsonObj.content = CodeSystemContentMode.Fragment;
      }
    }

    if (cacheAgeMs != null && cacheAgeMs < COLD_CACHE_FRESHNESS_MS) {
      return;
    }

    const key = this.#resourceKey();
    const jobKey = `cs:${key}`;

    if (OCLBackgroundJobQueue.isQueuedOrRunning(jobKey)) {
      return;
    }

    let queuedJobSize = null;
    OCLBackgroundJobQueue.enqueue(
      jobKey,
      'CodeSystem load',
      async () => {
        await this.#runBackgroundLoad(key, queuedJobSize);
      },
      {
        jobId: this.system(),
        getProgress: () => this.#backgroundLoadProgressSnapshot(),
        resolveJobSize: async () => {
          queuedJobSize = await this.#fetchConceptCountFromHeaders();
          return queuedJobSize;
        }
      }
    );
  }

  async #runBackgroundLoad(key, knownConceptCount = null) {
    try {
      this.backgroundLoadProgress = { processed: 0, total: null };
      const resolvedTotal = Number.isFinite(knownConceptCount) && knownConceptCount >= 0
        ? knownConceptCount
        : await this.#fetchConceptCountFromHeaders();
      this.backgroundLoadProgress.total = resolvedTotal;
      const count = await this.#loadAllConceptPages();
      this.loadedConceptCount = count;
      this.isComplete = true;
      this.loadedChecksum = this.meta?.checksum || null;
      this.backgroundLoadProgress = {
        processed: count,
        total: count > 0 ? count : this.backgroundLoadProgress.total
      };

      if (this.meta?.codeSystem?.jsonObj) {
        this.meta.codeSystem.jsonObj.content = CodeSystemContentMode.Complete;
      }

      this.#applyConceptsToCodeSystemResource(this.meta?.codeSystem || null);

      // Compute custom fingerprint and compare with cold cache
      const allConcepts = Array.from(this.sharedConceptCache.values());
      const newFingerprint = computeCodeSystemFingerprint(allConcepts);
      
      if (!this.customFingerprint || newFingerprint !== this.customFingerprint) {
        // Save to cold cache
        const savedFingerprint = await this.#saveColdCache(allConcepts);
        if (savedFingerprint) {
          this.customFingerprint = savedFingerprint;
        }
      }

      oclLog.info(`CodeSystem loaded: ${this.system()} (${count} concepts)`);
    } catch (error) {
      oclLog.error(`CodeSystem background load failed: ${key}: ${error.message}`);
    }
  }

  async #loadAllConceptPages() {
    if (!this.meta?.conceptsUrl) {
      this.loadedConceptCount = 0;
      this.backgroundLoadProgress = { processed: 0, total: 0 };
      return 0;
    }

    let page = 1;
    let total = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const pageData = await this.#fetchAndCacheConceptPage(page);
      const concepts = Array.isArray(pageData?.concepts) ? pageData.concepts : [];
      if (concepts.length === 0) {
        break;
      }
      total += concepts.length;
      this.backgroundLoadProgress.processed = total;
      if (concepts.length < CONCEPT_PAGE_SIZE) {
        break;
      }
      page += 1;
    }

    return total;
  }

  async #fetchAndCacheConceptPage(page) {
    const cacheKey = `${this.meta.conceptsUrl}|p=${page}|l=${CONCEPT_PAGE_SIZE}|verbose=1`;
    if (this.sharedPageCache.has(cacheKey)) {
      const cached = this.sharedPageCache.get(cacheKey);
      const concepts = Array.isArray(cached)
        ? cached
        : Array.isArray(cached?.concepts)
          ? cached.concepts
          : [];
      const reportedTotal = this.#extractTotalFromPayload(cached?.payload || null);
      return { concepts, reportedTotal };
    }

    if (this.sharedPendingPageRequests.has(cacheKey)) {
      return await this.sharedPendingPageRequests.get(cacheKey);
    }

    const pending = (async () => {
      let response;
      try {
        response = await this.httpClient.get(this.meta.conceptsUrl, { params: { page, limit: CONCEPT_PAGE_SIZE, verbose: true } });
      } catch (error) {
        if (error && error.response && error.response.status === 404) {
          this.sharedPageCache.set(cacheKey, []);
          return [];
        }
        throw error;
      }

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

      const mapped = items
        .map(item => this.#toConceptContext(item))
        .filter(Boolean);

      this.sharedPageCache.set(cacheKey, { concepts: mapped, payload });
      for (const concept of mapped) {
        if (concept && concept.code) {
          this.sharedConceptCache.set(concept.code, concept);
        }
      }
      return {
        concepts: mapped,
        reportedTotal: this.#extractTotalFromPayload(payload)
      };
    })();

    this.sharedPendingPageRequests.set(cacheKey, pending);
    try {
      return await pending;
    } finally {
      this.sharedPendingPageRequests.delete(cacheKey);
    }
  }

  #syncWarmStateWithChecksum() {
    const checksum = this.meta?.checksum || null;
    if (this.loadedChecksum == null) {
      this.loadedChecksum = checksum;
      return;
    }

    if (checksum !== this.loadedChecksum) {
      this.isComplete = false;
      this.loadedConceptCount = -1;
      this.backgroundLoadProgress = { processed: 0, total: null };
      this.sharedConceptCache.clear();
      this.sharedPageCache.clear();
      this.loadedChecksum = checksum;
      this.materializedConceptList = null;
      this.materializedConceptCount = -1;
      if (this.meta?.codeSystem?.jsonObj) {
        this.meta.codeSystem.jsonObj.content = CodeSystemContentMode.NotPresent;
        delete this.meta.codeSystem.jsonObj.concept;
      }
      oclLog.info(`CodeSystem checksum changed, invalidated warm cache: ${this.#resourceKey()}`);
    }
  }

  #applyConceptsToCodeSystemResource(codeSystem) {
    if (!codeSystem || typeof codeSystem !== 'object' || !codeSystem.jsonObj) {
      return;
    }

    if (this.isComplete !== true) {
      delete codeSystem.jsonObj.concept;
      return;
    }

    const concepts = Array.from(this.sharedConceptCache.values())
      .filter(concept => concept && concept.code);

    if (!Array.isArray(this.materializedConceptList) || this.materializedConceptCount !== concepts.length) {
      this.materializedConceptList = concepts
        .sort((a, b) => String(a.code).localeCompare(String(b.code)))
        .map(concept => {
          const fhirConcept = { code: concept.code };

          if (concept.display) {
            fhirConcept.display = concept.display;
          }

          if (concept.definition) {
            fhirConcept.definition = concept.definition;
          }

          if (Array.isArray(concept.designations) && concept.designations.length > 0) {
            const designations = concept.designations
              .filter(d => d && d.value)
              .map(d => ({
                language: d.language || undefined,
                value: d.value
              }));

            if (designations.length > 0) {
              fhirConcept.designation = designations;
            }
          }

          return fhirConcept;
        });
      this.materializedConceptCount = concepts.length;
    }

    codeSystem.jsonObj.concept = this.materializedConceptList;
    codeSystem.jsonObj.content = CodeSystemContentMode.Complete;
  }

  #backgroundLoadProgressSnapshot() {
    const processed = this.backgroundLoadProgress?.processed;
    const total = this.backgroundLoadProgress?.total;
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

  async #fetchConceptCountFromHeaders() {
    if (!this.meta?.conceptsUrl) {
      return null;
    }

    try {
      const response = await this.httpClient.get(this.meta.conceptsUrl, {
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

  #resourceKey() {
    // Plain `system|version`, matching how hasExactFactory/#findFactory build
    // their lookup keys. This used to be a SHA-256 of the same string, which
    // meant exact-version lookups could NEVER match a registered factory (plain
    // string vs hash) — only the unversioned `system|` alias ever worked. The
    // key is only used for in-memory maps, job keys and logs, so hashing bought
    // nothing and broke version-aware matching.
    const normalizedSystem = OCLSourceCodeSystemFactory.#normalizeSystem(this.system());
    return `${normalizedSystem}|${this.version() || ''}`;
  }

  currentChecksum() {
    this.#syncWarmStateWithChecksum();
    return this.meta?.checksum || this.loadedChecksum || null;
  }

  isCompleteNow() {
    this.#syncWarmStateWithChecksum();
    return this.isComplete === true;
  }

  #toConceptContext(concept) {
    return toConceptContext(concept);
  }

  system() {
    return normalizeCanonicalSystem(this.meta.canonicalUrl);
  }

  name() {
    return this.meta.name || this.meta.shortCode || this.meta.id || this.system();
  }

  version() {
    return this.meta.version || null;
  }

  id() {
    return this.meta.id || this.meta.shortCode || this.system();
  }

  iteratable() {
    return true;
  }
}

patchProviderForOCLFactorySync(() => OCLSourceCodeSystemFactory.factoriesByKey);

module.exports = {
  OCLCodeSystemProvider,
  OCLSourceCodeSystemProvider,
  OCLSourceCodeSystemFactory,
  OCLBackgroundJobQueue
};