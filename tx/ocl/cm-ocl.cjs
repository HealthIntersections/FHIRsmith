const { AbstractConceptMapProvider } = require('../cm/cm-api');
const { ConceptMap } = require('../library/conceptmap');
const { PAGE_SIZE } = require('./shared/constants');
const { createOclHttpClient } = require('./http/client');
const { fetchAllPages, extractItemsAndNext } = require('./http/pagination');
const { OclReferenceResolver, isOclRepoPath } = require('./resolve/reference-resolver');
const Logger = require('../../library/logger');
const oclCmLog = Logger.getInstance().child({ module: 'ocl-cm' });

const DEFAULT_MAX_SEARCH_PAGES = 10;

class OCLConceptMapProvider extends AbstractConceptMapProvider {
  constructor(config = {}) {
    super();
    const options = typeof config === 'string' ? { baseUrl: config } : (config || {});

    this.org = options.org || null;
    this.maxSearchPages = options.maxSearchPages || DEFAULT_MAX_SEARCH_PAGES;
    const http = createOclHttpClient(options);
    this.baseUrl = http.baseUrl;
    this.httpClient = http.client;

    this.conceptMapMap = new Map();
    this._idMap = new Map();
    this._sourceCandidatesCache = new Map();
    this._sourceUrlsByCanonical = new Map();
    this._canonicalBySourceUrl = new Map();

    // Asks OCL which repo holds a canonical instead of guessing via text search.
    // Disabled unless a token is configured, in which case #candidateSourceUrls
    // keeps using its existing search.
    this.referenceResolver = new OclReferenceResolver({
      httpClient: this.httpClient,
      token: options.token || null
    });
  }

  assignIds(ids) {
    if (!this.spaceId) {
      return;
    }

    const unique = new Set(this.conceptMapMap.values());
    this._idMap.clear();

    for (const cm of unique) {
      if (!cm.id.startsWith(`${this.spaceId}-`)) {
        const nextId = `${this.spaceId}-${cm.id}`;
        cm.id = nextId;
        cm.jsonObj.id = nextId;
      }
      this._idMap.set(cm.id, cm);
      ids.add(`ConceptMap/${cm.id}`);
    }
  }

  async fetchConceptMap(url, version) {
    this._validateFetchParams(url, version);

    const crypto = require('crypto');
    const base = `${url}|${version || ''}`;
    const hash = crypto.createHash('sha256').update(base).digest('hex');
    const direct = this.conceptMapMap.get(hash);
    if (direct) {
      return direct;
    }

    const mappingId = this.#extractMappingId(url);
    if (mappingId) {
      return await this.fetchConceptMapById(mappingId);
    }

    try {
      const mappings = await this.#searchMappings({ from_source_url: url }, this.maxSearchPages);
      for (const mapping of mappings) {
        const cm = this.#toConceptMap(mapping);
        if (cm) {
          this.#indexConceptMap(cm);
          if (cm.url === url && (!version || cm.version === version)) {
            return cm;
          }
        }
      }
    } catch (_err) {
      // OCL API unreachable or returned error — treat as not found
    }

    return null;
  }

  async fetchConceptMapById(id) {
    if (this._idMap.has(id)) {
      return this._idMap.get(id);
    }

    let rawId = id;
    if (this.spaceId && id.startsWith(`${this.spaceId}-`)) {
      rawId = id.substring(this.spaceId.length + 1);
    }

    if (this._idMap.has(rawId)) {
      return this._idMap.get(rawId);
    }

    try {
      const response = await this.httpClient.get(`/mappings/${encodeURIComponent(rawId)}/`);
      const cm = this.#toConceptMap(response.data);
      if (!cm) {
        return null;
      }
      this.#indexConceptMap(cm);
      return cm;
    } catch (_err) {
      return null;
    }
  }

  async searchConceptMaps(searchParams, _elements) {
    this._validateSearchParams(searchParams);

    // Keep the canonical exactly as supplied. Lower-casing it was harmless while
    // every consumer compared through #norm() (which lower-cases anyway), but
    // $resolveReference matches the canonical exactly, and OCL has no
    // .../fhir/codesystem/x -- only .../fhir/CodeSystem/X.
    const params = Object.fromEntries(
      searchParams.map(({ name, value }) => [name, String(value)])
    );
    const sourceSystem = params['source-system'] || params.source || null;
    const targetSystem = params['target-system'] || params.target || null;

    // Without a source or target filter the search would have to fetch every
    // mapping in the organisation — too expensive.  Return empty so the
    // Package providers can still answer generic ConceptMap listings.
    if (!sourceSystem && !targetSystem) {
      return [];
    }

    try {
      const allMappings = await this.#collectMappingsForSearch(sourceSystem, targetSystem);
      return this.#aggregateMappingsToConceptMaps(allMappings);
    } catch (_err) {
      return [];
    }
  }

  async #collectMappingsForSearch(sourceSystem, targetSystem) {
    const systemUrl = sourceSystem || targetSystem;
    const candidates = await this.#candidateSourceUrls(systemUrl);
    const sourcePaths = candidates.filter(isOclRepoPath);

    if (sourcePaths.length === 0) {
      return [];
    }

    const allMappings = [];
    for (const sourcePath of sourcePaths) {
      const normalizedPath = this.#normalizeSourcePath(sourcePath);
      try {
        // Ask the source for its mappings directly. Walking concepts and asking
        // each one costs a request per concept and, worse, only ever sees the
        // first maxSearchPages of them -- for LOINC that is 1000 of 184683
        // concepts (0.5%), so any mapping past that point was silently invisible.
        // Verified live: both paths return the identical mapping set.
        const mappings = await this.#fetchAllPages(
          `${normalizedPath}mappings/`, { limit: PAGE_SIZE }, this.maxSearchPages
        );
        allMappings.push(...mappings);
      } catch (_err) {
        // source exposes no mappings endpoint or is inaccessible — skip
        continue;
      }
    }

    const sourceUrlsToResolve = new Set();
    for (const m of allMappings) {
      const from = m?.from_source_url || m?.fromSourceUrl;
      const to = m?.to_source_url || m?.toSourceUrl;
      if (from) sourceUrlsToResolve.add(from);
      if (to) sourceUrlsToResolve.add(to);
    }
    await this.#ensureCanonicalForSourceUrls(sourceUrlsToResolve);

    return allMappings;
  }

  #aggregateMappingsToConceptMaps(mappings) {
    const groups = new Map();

    for (const mapping of mappings) {
      const fromSource = mapping.from_source_url || mapping.fromSourceUrl || null;
      const toSource = mapping.to_source_url || mapping.toSourceUrl || null;
      const sourceCode = mapping.from_concept_code || mapping.fromConceptCode;
      const targetCode = mapping.to_concept_code || mapping.toConceptCode;

      if (!fromSource || !toSource || !sourceCode || !targetCode) {
        continue;
      }

      const sourceCanonical = this.#canonicalForSourceUrl(fromSource) || fromSource;
      const targetCanonical = this.#canonicalForSourceUrl(toSource) || toSource;
      const groupKey = `${this.#norm(sourceCanonical)}|${this.#norm(targetCanonical)}`;

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          sourceCanonical, targetCanonical, elements: new Map(), lastUpdated: null
        });
      }

      const group = groups.get(groupKey);
      const ts = this.#toIsoDate(
        mapping.updated_on || mapping.updatedOn || mapping.updated_at || mapping.updatedAt
      );
      if (ts && (!group.lastUpdated || ts > group.lastUpdated)) {
        group.lastUpdated = ts;
      }

      if (!group.elements.has(sourceCode)) {
        group.elements.set(sourceCode, {
          code: sourceCode,
          display: mapping.from_concept_name_resolved || mapping.fromConceptNameResolved
                || mapping.from_concept_name || mapping.fromConceptName || null,
          targets: []
        });
      }

      group.elements.get(sourceCode).targets.push({
        code: targetCode,
        display: mapping.to_concept_name_resolved || mapping.toConceptNameResolved
              || mapping.to_concept_name || mapping.toConceptName || null,
        relationship: this.#toRelationship(mapping.map_type || mapping.mapType),
        comment: mapping.comment || null
      });
    }

    const results = [];
    for (const [, group] of groups) {
      const sourceId = this.#lastSegment(group.sourceCanonical);
      const targetId = this.#lastSegment(group.targetCanonical);
      const id = `${sourceId}-to-${targetId}`;

      const elements = [];
      for (const [, el] of group.elements) {
        elements.push({ code: el.code, display: el.display, target: el.targets });
      }

      const json = {
        resourceType: 'ConceptMap',
        id,
        url: `${this.baseUrl}/ConceptMap/${id}`,
        name: id,
        title: `${sourceId} to ${targetId}`,
        status: 'active',
        sourceScopeUri: group.sourceCanonical,
        targetScopeUri: group.targetCanonical,
        group: [{
          source: group.sourceCanonical,
          target: group.targetCanonical,
          element: elements
        }]
      };
      if (group.lastUpdated) {
        json.meta = { lastUpdated: group.lastUpdated };
      }

      const cm = new ConceptMap(json, 'R5');
      this.#indexConceptMap(cm);
      results.push(cm);
    }
    return results;
  }

  #lastSegment(canonical) {
    const raw = String(canonical || '').trim().replace(/\/+$/, '');
    const slash = raw.lastIndexOf('/');
    return slash >= 0 && slash < raw.length - 1 ? raw.substring(slash + 1) : raw;
  }

  async findConceptMapForTranslation(opContext, conceptMaps, sourceSystem, sourceScope, targetScope, targetSystem, sourceCode = null) {
    try {
      await this.#doFindConceptMapForTranslation(opContext, conceptMaps, sourceSystem, sourceScope, targetScope, targetSystem, sourceCode);
    } catch (_err) {
      // OCL API errors must not break $translate for other providers
    }
  }

  async #doFindConceptMapForTranslation(opContext, conceptMaps, sourceSystem, sourceScope, targetScope, targetSystem, sourceCode) {
    const sourceCandidates = await this.#candidateSourceUrls(sourceSystem);
    const targetCandidates = await this.#candidateSourceUrls(targetSystem);

    const mappings = [];
    const sourcePaths = sourceCandidates.filter(isOclRepoPath);

    if (sourceCode && sourcePaths.length > 0) {
      for (const sourcePath of sourcePaths) {
        const conceptPath = `${this.#normalizeSourcePath(sourcePath)}concepts/${encodeURIComponent(sourceCode)}/mappings/`;
        try {
          const found = await this.#fetchAllPages(conceptPath, { limit: PAGE_SIZE }, Math.min(2, this.maxSearchPages));
          mappings.push(...found);
        } catch (_err) {
          // concept not found or mappings endpoint unavailable
        }
      }
    }

    const searchKeys = new Set();
    const searches = [];

    if (sourceCandidates.length === 0 && targetCandidates.length === 0) {
      searches.push({});
    } else if (targetCandidates.length === 0) {
      for (const src of sourceCandidates) {
        const key = `from:${src}`;
        if (!searchKeys.has(key)) {
          searchKeys.add(key);
          searches.push({ from_source_url: src });
        }
      }
    } else if (sourceCandidates.length === 0) {
      for (const tgt of targetCandidates) {
        const key = `to:${tgt}`;
        if (!searchKeys.has(key)) {
          searchKeys.add(key);
          searches.push({ to_source_url: tgt });
        }
      }
    } else {
      for (const src of sourceCandidates) {
        for (const tgt of targetCandidates) {
          const key = `from:${src}|to:${tgt}`;
          if (!searchKeys.has(key)) {
            searchKeys.add(key);
            searches.push({ from_source_url: src, to_source_url: tgt });
          }
        }
      }
    }

    if (mappings.length === 0) {
      for (const search of searches) {
        const found = await this.#searchMappings(search, Math.min(2, this.maxSearchPages));
        mappings.push(...found);
      }
    }

    const sourceUrlsToResolve = new Set();
    for (const mapping of mappings) {
      const fromSource = mapping?.from_source_url || mapping?.fromSourceUrl;
      const toSource = mapping?.to_source_url || mapping?.toSourceUrl;
      if (fromSource) {
        sourceUrlsToResolve.add(fromSource);
      }
      if (toSource) {
        sourceUrlsToResolve.add(toSource);
      }
    }
    await this.#ensureCanonicalForSourceUrls(sourceUrlsToResolve);

    const seen = new Set(conceptMaps.map(cm => cm.id || cm.url));
    for (const mapping of mappings) {
      const cm = this.#toConceptMap(mapping);
      if (!cm) {
        continue;
      }
      this.#indexConceptMap(cm);

      const key = cm.id || cm.url;
      if (seen.has(key)) {
        continue;
      }

      if (this.#matchesTranslationRequest(cm, sourceSystem, sourceScope, targetScope, targetSystem, sourceCandidates, targetCandidates)) {
        conceptMaps.push(cm);
        seen.add(key);
      }
    }
  }

  cmCount() {
    return new Set(this.conceptMapMap.values()).size;
  }

  async close() {
  }

  #indexConceptMap(cm) {
    this.conceptMapMap.set(cm.url, cm);
    if (cm.version) {
      this.conceptMapMap.set(`${cm.url}|${cm.version}`, cm);
    }
    this.conceptMapMap.set(cm.id, cm);
    this._idMap.set(cm.id, cm);
  }

  #toConceptMap(mapping) {
    if (!mapping || typeof mapping !== 'object') {
      return null;
    }

    const id = mapping.id;
    if (!id) {
      return null;
    }

    const url = mapping.url || `${this.baseUrl}/mappings/${id}`;
    const source = mapping.from_source_url || mapping.fromSourceUrl || mapping.from_concept_url || mapping.fromConceptUrl || null;
    const target = mapping.to_source_url || mapping.toSourceUrl || mapping.to_concept_url || mapping.toConceptUrl || null;
    const sourceCode = mapping.from_concept_code || mapping.fromConceptCode;
    const targetCode = mapping.to_concept_code || mapping.toConceptCode;

    if (!source || !target || !sourceCode || !targetCode) {
      return null;
    }

    const sourceDisplay = mapping.from_concept_name_resolved || mapping.fromConceptNameResolved || mapping.from_concept_name || mapping.fromConceptName || null;
    const targetDisplay = mapping.to_concept_name_resolved || mapping.toConceptNameResolved || mapping.to_concept_name || mapping.toConceptName || null;
    const sourceCanonical = this.#canonicalForSourceUrl(source) || source;
    const targetCanonical = this.#canonicalForSourceUrl(target) || target;

    const relationship = this.#toRelationship(mapping.map_type || mapping.mapType);
    const lastUpdated = this.#toIsoDate(mapping.updated_on || mapping.updatedOn || mapping.updated_at || mapping.updatedAt);

    const json = {
      resourceType: 'ConceptMap',
      id,
      url,
      version: mapping.version || null,
      name: `mapping-${id}`,
      title: mapping.name || `Mapping ${id}`,
      status: 'active',
      sourceScopeUri: mapping.from_collection_url || mapping.fromCollectionUrl || source,
      targetScopeUri: mapping.to_collection_url || mapping.toCollectionUrl || target,
      group: [
        {
          source: sourceCanonical,
          target: targetCanonical,
          element: [
            {
              code: sourceCode,
              display: sourceDisplay,
              target: [
                {
                  code: targetCode,
                  display: targetDisplay,
                  relationship,
                  comment: mapping.comment || null
                }
              ]
            }
          ]
        }
      ]
    };

    if (lastUpdated) {
      json.meta = { lastUpdated };
    }

    return new ConceptMap(json, 'R5');
  }

  #toRelationship(mapType) {
    switch ((mapType || '').toUpperCase()) {
      case 'SAME-AS':
        return 'equivalent';
      case 'NARROWER-THAN':
        return 'narrower-than';
      case 'BROADER-THAN':
        return 'broader-than';
      case 'NOT-EQUIVALENT':
        return 'not-related-to';
      default:
        return 'related-to';
    }
  }

  async #searchMappings(params = {}, maxPages = this.maxSearchPages) {
    const endpoint = this.org ? `/orgs/${encodeURIComponent(this.org)}/mappings/` : '/mappings/';
    return await this.#fetchAllPages(endpoint, params, maxPages);
  }

  async #fetchAllPages(path, params = {}, maxPages = this.maxSearchPages) {
    return await fetchAllPages(this.httpClient, path, {
      params,
      pageSize: PAGE_SIZE,
      maxPages,
      baseUrl: this.baseUrl
    });
  }

  #extractItemsAndNext(payload) {
    return extractItemsAndNext(payload, this.baseUrl);
  }

  #extractMappingId(url) {
    if (!url) {
      return null;
    }
    const match = url.match(/\/mappings\/([^/]+)\/?$/i);
    return match ? match[1] : null;
  }

  async #candidateSourceUrls(systemUrl) {
    if (!systemUrl) {
      return [];
    }

    const cacheKey = this.#norm(systemUrl);
    if (this._sourceCandidatesCache.has(cacheKey)) {
      return this._sourceCandidatesCache.get(cacheKey);
    }

    const result = new Set();
    result.add(systemUrl);

    const canonicalKey = cacheKey;
    const byCanonical = this._sourceUrlsByCanonical.get(canonicalKey);
    if (byCanonical) {
      for (const item of byCanonical) {
        result.add(item);
      }
    }

    // Ask OCL which repo holds this canonical. An authoritative answer makes the
    // heuristic text search below unnecessary; without one we fall back to it.
    const resolved = await this.#resolveViaReferenceResolver(systemUrl);
    if (resolved) {
      result.add(resolved);
    } else {
      const discovered = await this.#resolveSourceCandidatesFromOcl(systemUrl);
      for (const item of discovered) {
        result.add(item);
      }
    }

    const out = Array.from(result);
    this._sourceCandidatesCache.set(cacheKey, out);
    return out;
  }

  /**
   * Resolve a canonical to its OCL repo via $resolveReference.
   * Returns null when the resolver is disabled (no token), the endpoint is
   * unavailable, or OCL cannot resolve the canonical -- in every case the caller
   * falls back to the existing search.
   */
  async #resolveViaReferenceResolver(systemUrl) {
    // Say why once, rather than per lookup: for a tokenless deployment this is the
    // expected steady state, not an error.
    if (!this.referenceResolver.isEnabled()) {
      if (!this._resolverDisabledLogged) {
        this._resolverDisabledLogged = true;
        oclCmLog.info(
          `$resolveReference not in use (${this.referenceResolver.disabledReason}); using source search`
        );
      }
      return null;
    }

    let resolved;
    try {
      resolved = await this.referenceResolver.resolve(systemUrl);
    } catch (error) {
      oclCmLog.warn(`$resolveReference lookup failed for ${systemUrl}: ${error.message}`);
      return null;
    }

    if (!resolved?.resolved || !resolved.repoUrl) {
      oclCmLog.info(`$resolveReference did not resolve ${systemUrl}; falling back to source search`);
      return null;
    }

    // Logged on success too: resolver and search return the same thing, so without
    // this there is no way -- from outside or from the logs -- to tell which path ran.
    oclCmLog.info(`$resolveReference resolved ${systemUrl} -> ${resolved.repoUrl}`);

    // Keep the canonical<->repo caches coherent with the search path's bookkeeping.
    // Index under what was asked, but record OCL's own canonical_url as the repo's
    // canonical: echoing the request back would store whatever spelling the caller
    // used rather than the repo's actual identity.
    const canonicalKey = this.#norm(systemUrl);
    if (!this._sourceUrlsByCanonical.has(canonicalKey)) {
      this._sourceUrlsByCanonical.set(canonicalKey, new Set());
    }
    this._sourceUrlsByCanonical.get(canonicalKey).add(resolved.repoUrl);
    this._canonicalBySourceUrl.set(this.#norm(resolved.repoUrl), resolved.canonical || systemUrl);

    return resolved.repoUrl;
  }

  async #resolveSourceCandidatesFromOcl(systemUrl) {
    const endpoint = this.org ? `/orgs/${encodeURIComponent(this.org)}/sources/` : '/sources/';
    const query = this.#queryTokenFromSystem(systemUrl);
    if (!query) {
      return [];
    }

    const sources = await this.#fetchAllPages(endpoint, { q: query, limit: PAGE_SIZE }, 2);
    const targetNorm = this.#norm(systemUrl);
    const candidates = new Set();

    for (const source of sources) {
      const canonical = source?.canonical_url || source?.canonicalUrl || null;
      const sourceUrl = source?.url || source?.uri || null;
      if (!sourceUrl) {
        continue;
      }

      if (canonical) {
        const canonicalKey = this.#norm(canonical);
        if (!this._sourceUrlsByCanonical.has(canonicalKey)) {
          this._sourceUrlsByCanonical.set(canonicalKey, new Set());
        }
        this._sourceUrlsByCanonical.get(canonicalKey).add(sourceUrl);
        this._canonicalBySourceUrl.set(this.#norm(sourceUrl), canonical);

        if (canonicalKey === targetNorm) {
          candidates.add(sourceUrl);
        }
      }

      if (this.#norm(sourceUrl) === targetNorm) {
        candidates.add(sourceUrl);
      }
    }

    return Array.from(candidates);
  }

  async #ensureCanonicalForSourceUrls(sourceUrls) {
    // Deduplicate the repo paths that still need a canonical.
    const pending = [];
    const seen = new Set();
    for (const sourceUrl of sourceUrls || []) {
      const sourceKey = this.#norm(sourceUrl);
      if (!sourceKey || this._canonicalBySourceUrl.has(sourceKey) || seen.has(sourceKey)) {
        continue;
      }
      const sourcePath = String(sourceUrl || '').trim();
      if (!isOclRepoPath(sourcePath)) {
        continue;
      }
      seen.add(sourceKey);
      pending.push(sourcePath);
    }

    if (pending.length === 0) {
      return;
    }

    // One $resolveReference batch instead of one GET per source: the result
    // carries the repo's canonical_url. Anything the batch cannot resolve falls
    // through to the per-source GETs below, so behaviour without a token (or on
    // failure) is unchanged.
    if (this.referenceResolver.isEnabled()) {
      try {
        const results = await this.referenceResolver.resolveReferences(pending);
        if (Array.isArray(results)) {
          for (let i = 0; i < pending.length; i++) {
            const r = results[i];
            if (!r?.resolved || !r.canonical) {
              continue;
            }
            const resolvedSourceUrl = r.repoUrl || pending[i];
            this.#recordCanonicalForSource(pending[i], resolvedSourceUrl, r.canonical);
          }
        }
      } catch (error) {
        oclCmLog.warn(`$resolveReference batch for source canonicals failed: ${error.message}`);
      }
    }

    for (const sourcePath of pending) {
      if (this._canonicalBySourceUrl.has(this.#norm(sourcePath))) {
        continue;
      }
      try {
        const response = await this.httpClient.get(sourcePath);
        const source = response.data || {};
        const canonical = source.canonical_url || source.canonicalUrl;
        const resolvedSourceUrl = source.url || source.uri || sourcePath;
        if (!canonical) {
          continue;
        }
        this.#recordCanonicalForSource(sourcePath, resolvedSourceUrl, canonical);
      } catch (e) {
        // Ignore source lookup failures and continue resolving remaining sources.
        continue;
      }
    }
  }

  #recordCanonicalForSource(requestedPath, resolvedSourceUrl, canonical) {
    const canonicalKey = this.#norm(canonical);
    if (!this._sourceUrlsByCanonical.has(canonicalKey)) {
      this._sourceUrlsByCanonical.set(canonicalKey, new Set());
    }
    this._sourceUrlsByCanonical.get(canonicalKey).add(resolvedSourceUrl);
    this._canonicalBySourceUrl.set(this.#norm(resolvedSourceUrl), canonical);
    // Also index under the exact path we were asked about, so the "already
    // resolved" checks hit even when OCL's repo url differs in shape.
    this._canonicalBySourceUrl.set(this.#norm(requestedPath), canonical);
  }

  #queryTokenFromSystem(systemUrl) {
    const raw = String(systemUrl || '').trim().replace(/\/+$/, '');
    if (!raw) {
      return null;
    }
    const slash = raw.lastIndexOf('/');
    if (slash >= 0 && slash < raw.length - 1) {
      return raw.substring(slash + 1);
    }
    return raw;
  }

  #normalizeSourcePath(sourcePath) {
    const path = String(sourcePath || '').trim();
    return path.endsWith('/') ? path : `${path}/`;
  }

  #canonicalForSourceUrl(sourceUrl) {
    return this._canonicalBySourceUrl.get(this.#norm(sourceUrl)) || null;
  }

  #matchesTranslationRequest(cm, sourceSystem, sourceScope, targetScope, targetSystem, sourceCandidates, targetCandidates) {
    if (cm.providesTranslation(sourceSystem, sourceScope, targetScope, targetSystem)) {
      return true;
    }

    const group = cm.jsonObj?.group?.[0] || {};
    const groupSource = this.#norm(group.source);
    const groupTarget = this.#norm(group.target);

    const sourceOk = !sourceSystem || sourceCandidates.some(s => this.#norm(s) === groupSource);
    const targetOk = !targetSystem || targetCandidates.some(s => this.#norm(s) === groupTarget);
    return sourceOk && targetOk;
  }

  #norm(url) {
    return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
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

module.exports = {
  OCLConceptMapProvider
};