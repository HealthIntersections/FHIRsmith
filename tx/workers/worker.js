const { TerminologyError} = require('../library/errors');
const { CodeSystem } = require('../library/codesystem');
const ValueSet = require('../library/valueset');
const {VersionUtilities} = require("../../library/version-utilities");
const {getValuePrimitive} = require("../../library/utilities");
const {Issue} = require("../library/operation-outcome");
const {Languages} = require("../../library/languages");
const {ConceptMap} = require("../library/conceptmap");
const {Renderer} = require("../library/renderer");

// The cache-id travels as an HTTP header (not an operation parameter) so proxies /
// load-balancers can act on it and the server can reject it before parsing the body.
// Defined here (the base worker) so both the worker and cache-control share one
// source of truth without a circular require. Express lower-cases header names.
const CACHE_ID_HEADER = 'x-cache-id';

/**
 * Custom error for terminology setup issues
 */
class TerminologySetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TerminologySetupError';
  }
}

/**
 * Abstract base class for terminology operations
 */
class TerminologyWorker {
  usedSources = [];
  additionalResources = []; // Resources provided via tx-resource parameter or cache
  foundParameters = [];
  renderer;

  // ValueSetChecker reads both of these off whatever worker it is given, so they belong to
  // every worker that can construct one - not just the validate and expand workers that
  // happen to have declared them first. A worker without them fails inside the checker with
  // "Cannot read properties of undefined (reading 'size')", a long way from the cause.
  // ValidateWorker and ExpandWorker redeclare them; a subclass field initialiser overrides
  // the base one, so their behaviour is unchanged.
  requiredSupplements = new Set();
  usedSupplements = new Set();

  /**
   * @param {OperationContext} opContext - Operation context
   * @param {Logger} log - Provider for code systems and resources
   * @param {Provider} provider - Provider for code systems and resources
   * @param {LanguageDefinitions} languages - Language definitions
   * @param {I18nSupport} i18n - Internationalization support
   */
  constructor(opContext, log, provider, languages, i18n) {
    this.opContext = opContext;
    this.log = log;
    this.provider = provider;
    this.languages = languages;
    this.i18n = i18n;
    this.noCacheThisOne = false;
    this.params = null; // Will be set by subclasses
    this.renderer = new Renderer(i18n, languages, provider);
  }

  /**
   * Abstract method to get operation name
   * @returns {string} Operation name
   */
  opName() {
    return '??';
  }

  /**
   * Abstract method to get value set handle
   * @returns {ValueSet} Value set being processed
   */
  vsHandle() {
    throw new Error('vsHandle() must be implemented by subclass');
  }

  /**
   * Check if operation should be terminated due to time/cost limits
   * @param {string} place - Location identifier for debugging
   */
  deadCheck(place = 'unknown') {
    this.opContext.deadCheck(place);
  }

  /**
   * deadCheck plus a cooperative event-loop yield (see OperationContext.checkAndYield).
   * Use this (awaited) from long-running loops in async code.
   * @param {string} place - Location identifier for debugging
   */
  async checkAndYield(place = 'unknown') {
    await this.opContext.checkAndYield(place);
  }

  /**
   * Add cost diagnostics to an error
   * @param {TooCostlyError} e - The error to enhance
   * @returns {TooCostlyError} Enhanced error
   */
  costDiags(e) {
    e.diagnostics = this.opContext.diagnostics();
    return e;
  }

  /**
   * Find a resource in additional resources by URL and version
   * @param {string} url - Resource URL
   * @param {string} version - Resource version (optional)
   * @param {string} resourceType - Expected resource type
   * @param {boolean} error - Whether to throw error if type mismatch
   * @returns {CodeSystem|ValueSet|null} Found resource or null
   */
  findInAdditionalResources(url, version = '', resourceType, error = true) {
    if (!this.additionalResources || this.additionalResources.length === 0) {
      return null;
    }

    const matches = [];

    for (const resource of this.additionalResources) {
      this.deadCheck('findInAdditionalResources');

      if (url && ((resource.url === url) || (resource.vurl === url)) &&
        (!version || VersionUtilities.versionMatchesByAlgorithm(version, resource.version, resource.versionAlgorithm()))) {

        if (resource.resourceType !== resourceType) {
          if (error) {
            throw new Error(`Attempt to reference ${url} as a ${resourceType} when it's a ${resource.resourceType}`);
          } else {
            return null;
          }
        }
        matches.push(resource);
      }
    }

    if (matches.length === 0) {
      return null;
    } else {
      // Find the latest version
      let latest = 0;
      for (let i = 1; i < matches.length; i++) {
        if (VersionUtilities.isSemVer(matches[latest].version) && VersionUtilities.isSemVer(matches[i].version) &&  VersionUtilities.isThisOrLater(matches[latest].version, matches[i].version)) {
          latest = i;
        }
      }
      const found = matches[latest];
      // enable for logging
      // if (this.additionalResourcesCacheId && this.log) {
      //   this.log.info(`cache-id '${this.additionalResourcesCacheId}': using cached ${found.resourceType} ${found.url}${found.version ? '|' + found.version : ''} for lookup of ${url}${version ? '|' + version : ''}`);
      // }
      return found;
    }
  }

  /**
   * Find and load a code system provider
   * @param {string} url - Code system URL
   * @param {string} version - Code system version (optional)
   * @param {TxParameters} params - Operation parameters
   * @param {Array<string>} kinds - Allowed content modes
   * @param {OperationOutcome} op - Op for errors
   * * @param {boolean} nullOk - Whether null result is acceptable
   * @param {Set<string>} statedSupplements - Supplements invoked in context
   * @returns {CodeSystemProvider|null} Code system provider or null
   */
  async findCodeSystem(url, version = '', params, kinds = ['complete'], op, nullOk = false, checkVer = false, noVParams = false, statedSupplements = null) {
    if (!url) {
      return null;
    }

    if (!noVParams) {
      version = this.determineVersionBase(url, version, params);
    }
    let codeSystemResource = null;
    let provider = null;
    const supplements = this.loadSupplements(url, version, statedSupplements);

    // First check additional resources
    codeSystemResource = this.findInAdditionalResources(url, version, 'CodeSystem', !nullOk);

    if (codeSystemResource) {
      if (codeSystemResource.content === 'complete') {
        // Create provider from complete code system
        provider = await this.provider.createCodeSystemProvider(this.opContext, codeSystemResource, supplements);
      }
    }

    // If no provider from additional resources, try main provider
    if (!provider) {
      provider = await this.provider.getCodeSystemProvider(this.opContext, url, version, supplements);
    }

    // If still no provider but we have a code system with allowed content mode
    if (!provider && codeSystemResource && kinds.includes(codeSystemResource.content)) {
      provider = await this.provider.createCodeSystemProvider(this.opContext, codeSystemResource, supplements);
    }

    if (!provider && !nullOk) {
      if (!version) {
        throw new Issue("error", "not-found", null, "UNKNOWN_CODESYSTEM_EXP", this.i18n.translate("UNKNOWN_CODESYSTEM_EXP", params.FHTTPLanguages, [url]), "not-found", 422);
      } else {
        const versions = await this.listVersions(url);
        if (versions.length === 0) {
          throw new Issue("error", "not-found", null, "UNKNOWN_CODESYSTEM_VERSION_EXP_NONE", this.i18n.translate("UNKNOWN_CODESYSTEM_VERSION_EXP_NONE", params.FHTTPLanguages, [url, version]), "not-found", 422);
        } else {
          throw new Issue("error", "not-found", null, "UNKNOWN_CODESYSTEM_VERSION_EXP", this.i18n.translate("UNKNOWN_CODESYSTEM_VERSION_EXP", params.FHTTPLanguages, [url, version, this.presentVersionList(versions)]), "not-found", 422);
        }
      }
    }
    if (provider) {
      if (checkVer) {
        this.checkVersion(url, provider.version(), params, provider.versionAlgorithm(), op);
      }
      // Track for lifecycle cleanup at end of request. Providers built from
      // a factory open a fresh sqlite connection that needs releasing;
      // resource-built providers and others without close() are no-ops.
      this.opContext.registerProvider(provider);
    }

    return provider;
  }

  /**
   * List available versions for a code system
   * @param {string} url - Code system URL
   * @returns {Array<string>} Available versions
   */
  async listVersions(url) {
    const versions = new Set();

    // Check additional resources
    if (this.additionalResources) {
      for (const resource of this.additionalResources) {
        this.deadCheck('listVersions-additional');
        if (resource.url === url && resource.version) {
          versions.add(resource.version);
        }
      }
    }

    // Check main provider
    const providerVersions = await this.provider.listCodeSystemVersions(url);
    for (const version of providerVersions) {
      this.deadCheck('listVersions-provider');
      versions.add(version);
    }

    return Array.from(versions).sort();
  }

  async listDisplaysFromCodeSystem(displays, cs, c) {
    // list all known language displays
    await cs.designations(c, displays);
    displays.source = cs;
  }

  listDisplaysFromConcept(displays, c) {
    // list all known provided displays
    // todo: supplements
    for (let ccd of c.designations || []) {
      displays.addDesignationFromConcept(ccd);
    }
  }

  listDisplaysFromIncludeConcept(displays, c, vs) {
    if (c.display) {
      displays.baseLang = this.languages.parse(vs.language);
      displays.addDesignation(true, "active", '', '', c.display.trim());
    }
    for (let cd of c.designations || []) {
      // see https://chat.fhir.org/#narrow/stream/179202-terminology/topic/ValueSet.20designations.20and.20languages
      displays.addDesignationFromConcept(cd);
    }
  }

  /**
   * Load supplements for a code system
   * @param {string} url - Code system URL
   * @param {string} version - Code system version
   * @param {Set<string>} statedSupplements - Supplements invoked in context
   * @returns {Array<CodeSystem>} Supplement code systems
   */
  loadSupplements(url, version = '', statedSupplements) {
    const supplements = [];

    supplements.push(...this.provider.loadSupplements(url, version, statedSupplements));
    // todo: look in provider for supplements

    if (!this.additionalResources) {
      return supplements;
    }

    for (const resource of this.additionalResources) {
      this.deadCheck('loadSupplements');
      if (resource.resourceType === 'CodeSystem' && resource instanceof CodeSystem) {
        const cs = resource;
        // Check if this code system supplements the target URL
        const supplementsUrl = cs.jsonObj.supplements;

        if (!supplementsUrl) {
          continue;
        }

        // we consider either language packs or specified supplements
        if (!(cs.isLangPack() || (statedSupplements && (statedSupplements.has(cs.url) || statedSupplements.has(cs.vurl))))) {
          continue;
        }
        if (this.hasSupplement(cs, supplements)) {
          continue;
        }
        // Handle exact URL match (no version specified in supplements field)
        if (supplementsUrl === url) {
          supplements.push(cs);
          continue;
        }

        // Handle versioned URL (format: url|version)
        if (supplementsUrl.startsWith(`${url}|`)) {
          if (!version) {
            // No version specified in search, include all supplements for this URL
            supplements.push(cs);
          } else {
            // Version specified, check if it matches the tail of supplements URL
            const supplementsVersion = supplementsUrl.substring(`${url}|`.length);
            if (supplementsVersion === version || VersionUtilities.versionMatches(supplementsVersion, version)) {
              supplements.push(cs);
            }
          }
        }
      }
    }

    return supplements;
  }

  /**
   * Check supplements for a code system provider
   * @param {CodeSystemProvider} cs - Code system provider
   * @param {Object} src - Source element (for extensions)
   */
  checkSupplements(cs, src, requiredSupplements, usedSupplements = null, reportedSupplements = null) {
    // Check for required supplements in extensions
    if (src && src.extension) {
      const supplementExtensions = src.extension.filter(x => x.url == 'http://hl7.org/fhir/StructureDefinition/valueset-supplement');
      for (const ext of supplementExtensions) {
        const supplementUrl = ext.valueString || ext.valueUri;
        if (supplementUrl && !cs.hasSupplement(this.opContext, supplementUrl)) {
          throw new TerminologyError(`ValueSet depends on supplement '${supplementUrl}' on ${cs.system} that is not known`);
        }
      }
    }

    if (reportedSupplements) {
      for (let s of cs.listSupplements(true)) {
        reportedSupplements.add(s);
      }
    }
    // Note required supplements that are satisfied - and might be version independent
    if (usedSupplements) {
      for (const s of requiredSupplements) {
        if (cs.hasSupplement(s)) {
          usedSupplements.add(s);
        }
      }
    }
  }

  /**
   * Find a ValueSet by URL and optional version
   * @param {string} url - ValueSet URL (may include |version)
   * @param {string} version - ValueSet version (optional, overrides URL version)
   * @returns {ValueSet|null} Found ValueSet or null
   */
  async findValueSet(url, version, source = '') {
    if (!url) {
      return null;
    }
    if (url.startsWith("#")) {
      if (source) {
        if (source.jsonObj) {
          source = source.jsonObj;
        }
        for (const contained of source.contained || []) {
          if (contained.id === url.substring(1)) {
            const ret = this.wrapRawResource(contained);
            ret.isContained = true;
            return ret;
          }
        }
      }
      return null;
    }

    // Parse URL|version format
    let effectiveUrl = url;
    let effectiveVersion = version;

    if (!effectiveVersion && url.includes('|')) {
      const parts = url.split('|');
      effectiveUrl = parts[0];
      effectiveVersion = parts[1];
    }

    // First check additional resources
    const fromAdditional = this.findInAdditionalResources(effectiveUrl, effectiveVersion, 'ValueSet', false);
    if (fromAdditional) {
      return fromAdditional;
    }

    // Then try the provider
    if (this.provider && this.provider.findValueSet) {
      const vs = await this.provider.findValueSet(this.opContext, effectiveUrl, effectiveVersion);
      if (vs) {
        return vs;
      }
    }

    return null;
  }

  /**
   * Apply version pinning rules from parameters
   * @param {string} url - ValueSet URL
   * @returns {string} Potentially versioned URL
   */
  pinValueSet(url) {
    if (!url || !this.params) {
      return url;
    }

    let baseUrl = url.includes("|") ? url.substring(0, url.indexOf("|")) : url;
    let version = url.includes("|") ? url.substring(url.indexOf("|") + 1) : null;
    version = this.determineVersionBase(url, version, this.params);
    return version ? baseUrl+"|"+version : url;
  }

  /**
   * Build a canonical URL from system and version
   * @param {string} system - System URL
   * @param {string} version - Version (optional)
   * @returns {string} Canonical URL (system|version or just system)
   */
  canonical(system, version = '') {
    if (!system) return '';
    if (!version) return system;
    return `${system}|${version}`;
  }

  /**
   * Parse a canonical URL into system and version parts
   * @param {string} canonical - Canonical URL (may include |version)
   * @returns {{system: string, version: string}}
   */
  parseCanonical(canonical) {
    if (!canonical) {
      return { system: '', version: '' };
    }

    const pipeIndex = canonical.indexOf('|');
    if (pipeIndex < 0) {
      return { system: canonical, version: '' };
    }

    return {
      system: canonical.substring(0, pipeIndex),
      version: canonical.substring(pipeIndex + 1)
    };
  }

  /**
   * Process a ValueSet, recording context and extracting embedded expansion parameters
   * @param {Object} vs - ValueSet resource (raw JSON)
   * @param {TxParameters} params - the parameters to add what the ValueSet declares to.
   *   Note: this is the caller's parameters, not this.params - the worker's own
   *   params is null when expanding an imported ValueSet
   */
  seeValueSet(vs, params) {
    // Build canonical URL from url and version
    const vurl = vs.url ? (vs.url + (vs.version ? '|' + vs.version : '')) : null;
    if (vurl) {
      this.opContext.seeContext(vurl);
    }
    // Check for expansion parameter extensions on compose
    if (vs.jsonObj.compose && vs.jsonObj.compose.extension) {
      for (const ext of vs.jsonObj.compose.extension) {
        if (ext.url === 'http://hl7.org/fhir/StructureDefinition/valueset-expansion-parameter' ||
          ext.url === 'http://hl7.org/fhir/tools/StructureDefinition/valueset-expansion-parameter') {
          // Get name and value from nested extensions
          const nameExt = ext.extension?.find(e => e.url === 'name');
          const valueExt = ext.extension?.find(e => e.url === 'value');

          if (nameExt && valueExt) {
            const name = nameExt.valueString || nameExt.valueCode;
            if (name) {
              params.seeParameter(name, valueExt, false);
            }
          }
        }
      }
    }
    // R6's ValueSet.compose.property
    params.seeCompose(vs.jsonObj.compose);
    if (!params.FHTTPLanguages && vs.jsonObj.language) {
      params.HTTPLanguages = Languages.fromAcceptLanguage(vs.jsonObj.language, this.languages, !this.isValidating());
    }
  }

  isValidating() {
    return false;
  }

  // ========== Parameter Handling ==========

  /**
   * Build a Parameters resource from the request
   * Handles GET query params, POST form body, and POST Parameters resource
   * @param {express.Request} req
   * @returns {Object} Parameters resource
   */
  buildParameters(req) {
    let params;

    // If POST with Parameters resource, use directly
    if (req.method === 'POST' && req.body && req.body.resourceType === 'Parameters') {
      params = req.body;
    } else if (req.method === 'POST' && req.body && req.body.resourceType) {
      let langs = this.languages.parse(req.headers['accept-language']);
      throw new Issue('error', 'invalid', null, 'Wrong_type_for_resource_expected', this.i18n.translate('Wrong_type_for_resource_expected', langs, ["Parameters", req.body.resourceType])).handleAsOO(400);
    } else {
      // Convert query params or form body to Parameters
      const source = req.method === 'POST' ? {...req.query, ...req.body} : req.query;
      params = {
        resourceType: 'Parameters',
        parameter: []
      };

      for (const [name, value] of Object.entries(source)) {
        if (value === undefined || value === null) continue;

        if (Array.isArray(value)) {
          // Repeating parameter
          for (const v of value) {
            params.parameter.push({name, valueString: String(v)});
          }
        } else if (typeof value === 'object') {
          // Could be a resource or complex type - check resourceType
          if (value.resourceType) {
            params.parameter.push({name, resource: value});
          } else {
            // Assume it's a complex type like Coding or CodeableConcept
            params.parameter.push(this.buildComplexParameter(name, value));
          }
        } else if (value == 'true') {
          params.parameter.push({name, valueBoolean: true});
        } else if (value == 'false') {
          params.parameter.push({name, valueBoolean: false});
        } else {
          params.parameter.push({name, valueString: String(value)});
        }
      }
    }

    this.applyCacheIdHeader(req, params);
    return params;
  }

  /**
   * Normalise the cache-id from the `${CACHE_ID_HEADER}` header into a `cache-id`
   * parameter, so all downstream code can read the cache-id the same way whether
   * the client sent it as a header (the going-forward mechanism) or, for now, still
   * as a parameter. If a cache-id parameter is already present it is left as-is, so
   * an explicit parameter wins and there's no surprising override.
   * @param {express.Request} req
   * @param {Object} params - Parameters resource (mutated in place)
   */
  applyCacheIdHeader(req, params) {
    const headerVal = req && req.headers ? req.headers[CACHE_ID_HEADER] : null;
    if (!headerVal) {
      return;
    }
    if (!params.parameter) {
      params.parameter = [];
    }
    if (params.parameter.some(p => p.name === 'cache-id')) {
      return;
    }
    params.parameter.push({ name: 'cache-id', valueId: String(headerVal) });
  }

  /**
   * Build a parameter for complex types
   */
  buildComplexParameter(name, value) {
    // Detect type based on structure
    if (value.system !== undefined || value.code !== undefined || value.display !== undefined) {
      return {name, valueCoding: value};
    }
    if (value.coding !== undefined || value.text !== undefined) {
      return {name, valueCodeableConcept: value};
    }
    // Fallback - stringify
    return {name, valueString: JSON.stringify(value)};
  }


  addHttpParams(req, params) {
    if (req.headers && req.headers['accept-language']) {
      params.parameter.push({name: '__Accept-Language', valueCode: req.headers['accept-language']});
    }
    if (req.headers && req.headers['content-language']) {
      params.parameter.push({name: '__Content-Language', valueCode: req.headers['content-language']});
    }
  }

  // ========== Additional Resources Handling ==========

  /**
   * Collect the resources supplied inline in a Parameters resource: the
   * `tx-resource` parameters, and the primary `valueSet`/`codeSystem` parameters.
   *
   * The primary resource is collected separately because the cache-id protocol
   * needs it retained too: fhir-core sends the main ValueSet as `valueSet` (not
   * `tx-resource`), so if it isn't cached, a later by-reference call can't resolve
   * it ("value set ... could not be found"). A primary resource is only usable by
   * reference if it has a url to key on, so url-less ones are skipped.
   *
   * @param {Object} params - Parameters resource
   * @returns {{txResources: Array, primaryResources: Array}} wrapped resources
   */
  collectSuppliedResources(params) {
    const txResources = [];
    const primaryResources = [];
    if (!params || !params.parameter) {
      return { txResources, primaryResources };
    }
    for (const param of params.parameter) {
      this.deadCheck('collectSuppliedResources');
      if (param.name === 'tx-resource' && param.resource) {
        const res = this.wrapRawResource(param.resource);
        if (res) {
          txResources.push(res);
        }
      } else if ((param.name === 'valueSet' || param.name === 'codeSystem') && param.resource && param.resource.url) {
        const res = this.wrapRawResource(param.resource);
        if (res) {
          primaryResources.push(res);
        }
      }
    }
    return { txResources, primaryResources };
  }

  /**
   * Set up additional resources from tx-resource parameters and cache
   * @param {Object} params - Parameters resource
   */
  setupAdditionalResources(params) {
    if (!params || !params.parameter) return;

    // Collect the resources supplied inline on this request (tx-resource plus the
    // primary valueSet/codeSystem). See collectSuppliedResources for why the
    // primary resource is included.
    const { txResources, primaryResources } = this.collectSuppliedResources(params);

    // Check for cache-id. An explicit cache-id *parameter* wins; otherwise fall
    // back to the cache-id the middleware lifted off the X-Cache-Id header onto
    // the operation context. This fallback is what makes the header work on the
    // op paths that don't route their Parameters through buildParameters
    // (expand, related, batch-validate) or that hand setupAdditionalResources a
    // raw req.body (lookup) - previously those silently ignored a front-loaded
    // cache and failed to resolve by-reference resources.
    const cacheIdParam = this.findParameter(params, 'cache-id');
    const cacheId = (cacheIdParam ? this.getParameterValue(cacheIdParam) : null)
      || (this.opContext ? this.opContext.cacheId : null)
      || null;

    if (cacheId && this.opContext.resourceCache) {
      // The cache must already exist: caches are created explicitly via
      // $cache-control?mode=start, which is the only thing that mints a cache-id.
      // A cache-id the server doesn't know is an unambiguous, server-authoritative
      // error condition - report it with a specific coded issue rather than silently
      // auto-creating a fresh cache and then failing obscurely later when a
      // by-reference resource can't be found. The cache keeps a tombstone for every
      // id it has retired, so describeMissing() names which fate this id met
      // (never issued here / closed by the client / idle-expired) instead of
      // offering the client a list of possibilities to guess between.
      if (!this.opContext.resourceCache.has(cacheId)) {
        // A comma in the cache-id means the request carried multiple X-Cache-Id
        // headers (Node joins duplicate headers with ", "): server-minted ids are
        // single uuids. This happens when a client attaches a new cache-id header
        // without clearing the old one (e.g. IG publisher builds where a second
        // client context wrapped the same HTTP client) - report that specifically,
        // because the generic "unknown cache" message sends people looking for an
        // expiry problem that isn't there.
        if (cacheId.includes(',')) {
          throw new Issue('error', 'invalid', null, 'CACHE_ID_DUPLICATE',
            `The request carried multiple ${CACHE_ID_HEADER} headers (combined value '${cacheId}'). ` +
            'This is a client error: each request must carry exactly one cache-id. It usually means the client ' +
            'started a second cache on a connection that already had one, without removing the first header.',
            'cache-id-duplicate', 400);
        }
        // The issue *code* stays cache-id-unknown for every fate: clients switch on
        // the coding, and all three mean the same thing to them (this cache is gone,
        // don't retry). Only the human-readable diagnostics differ.
        const { messageId, params } = this.opContext.resourceCache.describeMissing(cacheId);
        throw new Issue('error', 'not-found', null, messageId,
          this.i18n.translate(messageId, this.opContext.langs, params),
          'cache-id-unknown', 404);
      }

      // The cache exists. If it is unsealed, merge any resources supplied on this
      // request into it (incremental population). If it is sealed, the cache is
      // fixed at what it was created with: resources supplied now are still used
      // for this request (via additionalResources below) but are NOT added to the
      // shared cache, so a sealed cache never grows.
      if (!this.opContext.resourceCache.isSealed(cacheId)) {
        const toCache = txResources.concat(primaryResources);
        if (toCache.length > 0) {
          this.opContext.resourceCache.add(cacheId, toCache);
        }
        this.additionalResources = this.opContext.resourceCache.get(cacheId);
      } else {
        // Sealed: expose the cache contents plus this request's own inline
        // resources (used for this call only), without mutating the cache.
        this.additionalResources = this.opContext.resourceCache.get(cacheId)
          .concat(txResources, primaryResources);
      }
      this.additionalResourcesCacheId = cacheId;
    } else {
      // No cache-id, just use the tx-resources directly
      this.additionalResources = txResources;
    }
  }

  /**
   * Wrap a raw resource in its appropriate class wrapper
   * @param {Object} resource - Raw resource object
   * @returns {CodeSystem|ValueSet|null} Wrapped resource or null
   */
  wrapRawResource(resource) {
    if (resource.resourceType === 'CodeSystem') {
      return new CodeSystem(resource, this.provider.getFhirVersion());
    }
    if (resource.resourceType === 'ValueSet') {
      return new ValueSet(resource, this.provider.getFhirVersion());
    }
    if (resource.resourceType === 'ConceptMap') {
      return new ConceptMap(resource, this.provider.getFhirVersion());
    }
    return null;
  }

  // ========== Parameters Handling ==========

  /**
   * Convert query parameters to a Parameters resource
   * @param {Object} query - Query parameters
   * @returns {Object} Parameters resource
   */
  queryToParameters(query) {
    const params = {
      resourceType: 'Parameters',
      parameter: []
    };

    if (!query) return params;

    for (const [name, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        // Repeating parameter
        for (const v of value) {
          params.parameter.push({ name, valueString: v });
        }
      } else {
        params.parameter.push({ name, valueString: value });
      }
    }

    return params;
  }

  /**
   * Convert form body to a Parameters resource, merging with query params
   * @param {Object} body - Form body
   * @param {Object} query - Query parameters
   * @returns {Object} Parameters resource
   */
  formToParameters(body, query) {
    const params = {
      resourceType: 'Parameters',
      parameter: []
    };

    // Add query params first
    if (query) {
      for (const [name, value] of Object.entries(query)) {
        if (Array.isArray(value)) {
          for (const v of value) {
            params.parameter.push({ name, valueString: v });
          }
        } else {
          params.parameter.push({ name, valueString: value });
        }
      }
    }

    // Add/override with body params
    if (body) {
      for (const [name, value] of Object.entries(body)) {
        if (Array.isArray(value)) {
          for (const v of value) {
            params.parameter.push({ name, valueString: v });
          }
        } else {
          params.parameter.push({ name, valueString: value });
        }
      }
    }

    return params;
  }

  /**
   * Find a parameter in a Parameters resource
   * @param {Object} params - Parameters resource
   * @param {string} name - Parameter name
   * @returns {Object|null} Parameter object or null
   */
  findParameter(params, name) {
    if (!params || !params.parameter) return null;
    return params.parameter.find(p => p.name === name) || null;
  }

  /**
   * Get the value from a parameter (handles various value types)
   * @param {Object} param - Parameter object
   * @returns {*} Parameter value
   */
  getParameterValue(param) {
    if (!param) return null;

    // Check for resource
    if (param.resource) return param.resource;

    // Check for various value types
    const valueTypes = [
      'valueString', 'valueCode', 'valueUri', 'valueCanonical', 'valueUrl',
      'valueBoolean', 'valueInteger', 'valueDecimal', 'valueId',
      'valueDateTime', 'valueDate', 'valueTime',
      'valueCoding', 'valueCodeableConcept',
      'valueIdentifier', 'valueQuantity'
    ];

    for (const vt of valueTypes) {
      if (param[vt] !== undefined) {
        return param[vt];
      }
    }

    return null;
  }

  /**
   * Get a string parameter value
   * @param {Object} params - Parameters resource
   * @param {string} name - Parameter name
   * @returns {string|null} Parameter value or null
   */
  getStringParam(params, name) {
    const p = this.findParameter(params, name);
    if (!p) return null;
    return getValuePrimitive(p);
  }

  /**
   * Get a resource parameter value
   * @param {Object} params - Parameters resource
   * @param {string} name - Parameter name
   * @returns {Object|null} Resource or null
   */
  getResourceParam(params, name) {
    const p = this.findParameter(params, name);
    return p?.resource || null;
  }

  /**
   * Get a Coding parameter value
   * @param {Object} params - Parameters resource
   * @param {string} name - Parameter name
   * @returns {Object|null} Coding or null
   */
  getCodingParam(params, name) {
    const p = this.findParameter(params, name);
    return p?.valueCoding || null;
  }

  /**
   * Get a CodeableConcept parameter value
   * @param {Object} params - Parameters resource
   * @param {string} name - Parameter name
   * @returns {Object|null} CodeableConcept or null
   */
  getCodeableConceptParam(params, name) {
    const p = this.findParameter(params, name);
    return p?.valueCodeableConcept || null;
  }

  /**
   * Render a coded value as string for debugging/logging
   * @param {string|Object} system - System URI or coding object
   * @param {string} version - Version (optional)
   * @param {string} code - Code (optional)
   * @param {string} display - Display (optional)
   * @returns {string} Rendered string
   */
  displayCoded(system, version = '', code = '', display = '') {
    if (typeof system === 'object') {
      // Handle coding or codeable concept objects
      if (system.system !== undefined) {
        // Coding object
        return this.renderer.displayCoded(system.system, system.version, system.code, system.display);
      } else if (system.codings) {
        // Codeable concept object
        const rendered = system.codings.map(c => this.displayCoded(c)).join(', ');
        return `[${rendered}]`;
      }
    }

    let result = system;
    if (version) {
      result += `|${version}`;
    }
    if (code) {
      result += `#${code}`;
    }
    if (display) {
      result += ` ("${display}")`;
    }

    return result;
  }
  determineVersionBase(url, version, params) {
    if (params === null) {
      return version;
    }
    let result = version;
    let list = params.rulesForSystem(url);
    let b = false;
    for (let t of list) {
      if (t.mode === 'override') {
        if (!b) {
          result = t.version;
          this.foundParameters.push(t.asParam());
          b = true;
        } else if (result !== t.version) {
          throw new Issue("error", "exception", null, 'SYSTEM_VERSION_MULTIPLE_OVERRIDE', this.FI18n.translate('SYSTEM_VERSION_MULTIPLE_OVERRIDE', params.FHTTPLanguages, [url, result, t.version]), 'version-error');
        }
      }
    }
    if (!result) {
      b = false;
      for (let t of list) {
        if (t.mode === 'default') {
          if (!b) {
            result = t.version;
            this.foundParameters.push(t.asParam());
            b = true;
          } else if (version !== t.version) {
            throw new Issue("error", "exception", null, 'SYSTEM_VERSION_MULTIPLE_DEFAULT', this.FI18n.translate('SYSTEM_VERSION_MULTIPLE_DEFAULT', params.FHTTPLanguages, [url, result, t.version]), 'version-error');
          }
        }
      }
    }
    for (let t of list) {
      if (t.mode === 'check') {
        if (!result) {
          result = t.version;
          this.foundParameters.push(t.asParam());
        }
        // if we decide to allow check to guide the selection.
        // waiting for discussion
        //else if (TFHIRVersions.isSubset(result, t.version)) {
        //  result = t.version;
        //}
      }
    }
    return result;
  }

  checkVersion(url, version, params, versionAlgorithm, op) {
    if (params) {
      let list = params.rulesForSystem(url);
      for (let t of list) {
        if (t.mode === 'check') {
          if (!VersionUtilities.versionMatchesByAlgorithm(t.version, version, versionAlgorithm)) {
            let issue = new Issue("error", "exception", null, 'VALUESET_VERSION_CHECK', this.i18n.translate('VALUESET_VERSION_CHECK', params.FHTTPLanguages, [url, version, t.version]), 'version-error', 400);
            if (op) {
              op.addIssue(issue);
            } else {
              throw issue;
            }
          }
        }
      }
    }
  }

  makeVurl(resource) {
    let result = resource.vurl;
    if (!result && resource.url) {
      if (resource.version) {
        result =  resource.url+"|"+resource.version;
      } else {
        result =  resource.url;
      }
    }
    return result;
  }

  seeSourceVS(vs, url) {
    let s = url;
    if (vs) {
      if (vs.jsonObj) vs = vs.jsonObj;
      s = vs.name || vs.title || vs.id || vs.url;
    }
    if (!this.usedSources.find(u => u == s)) {
      this.usedSources.push(s);
    }
  }

  seeSourceProvider(cs, url) {
    let s = url;
    if (cs) {
      if (cs instanceof CodeSystem) {
        cs = cs.jsonObj;
        s = cs.name || cs.title || cs.id || cs.url;
      } else {
        s = cs.name() || cs.system();
      }
    }
    if (!this.usedSources.find(u => u == s)) {
      this.usedSources.push(s);
    }
  }

  presentVersionList(items) {
    if (items.length === 0) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} or ${items[1]}`;

    const lastItem = items.pop();
    return `${items.join(', ')} and ${lastItem}`;
  }

  checkNoLockedDate(url, compose) {
    if (compose.lockedDate) {
      throw new Issue("error", "business-rule", null, null, `Cannot process ValueSet ${url} due to the presence of a lockedDate on the compose`);
    }
    return true;
  }

  hasSupplement(cs, supplements) {
    for (let t of supplements) {
      if (t.vurl == cs.vurl) {
        return true;
      }
    }
    return false;
  }
}


/**
 * Choose the message id to use when reporting an unknown code, based on the
 * code system and whether a version is known. SNOMED CT gets its own message
 * because the edition is named in the message (see SCTVersion below)
 * @param {string} url - code system url
 * @param {string} version - code system version (may be null)
 * @returns {string} message id
 */
function Unknown_Code_in_VersionSCT(url, version) {
  if (url === 'http://snomed.info/sct') {
    return 'Unknown_Code_in_Version_SCT';
  } else if (version) {
    return 'Unknown_Code_in_Version';
  } else {
    return 'Unknown_Code_in';
  }
}

/**
 * Human readable name for the SNOMED CT edition in a SNOMED CT version URI.
 * Returns '' for anything that isn't a versioned SNOMED CT reference
 * @param {string} url - code system url
 * @param {string} ver - code system version
 * @returns {string} edition name, or ''
 */
function SCTVersion(url, ver) {
  if (url !== 'http://snomed.info/sct' || !ver) {
    return '';
  } else {
    let result = 'unknown';
    let s = ver.split('/');
    if (s.length >= 5) {
      if (s[4] === '900000000000207008') result = 'International Edition';
      else if (s[4] === '449081005') result = 'International Spanish Edition';
      else if (s[4] === '11000221109') result = 'Argentinian Edition';
      else if (s[4] === '32506021000036107') result = 'Australian Edition (with drug extension)';
      else if (s[4] === '11000234105') result = 'Austrian Edition';
      else if (s[4] === '11000172109') result = 'Belgian Edition';
      else if (s[4] === '20621000087109') result = 'Canadian English Edition';
      else if (s[4] === '20611000087101') result = 'Canadian Canadian French Edition';
      else if (s[4] === '11000279109') result = 'Czech Edition';
      else if (s[4] === '554471000005108') result = 'Danish Edition';
      else if (s[4] === '11000181102') result = 'Estonian Edition';
      else if (s[4] === '11000229106') result = 'Finnish Edition';
      else if (s[4] === '11000274103') result = 'German Edition';
      else if (s[4] === '1121000189102') result = 'Indian Edition';
      else if (s[4] === '827022005') result = 'IPS Terminology';
      else if (s[4] === '11000220105') result = 'Irish Edition';
      else if (s[4] === '11000146104') result = 'Netherlands Edition';
      else if (s[4] === '21000210109') result = 'New Zealand Edition';
      else if (s[4] === '51000202101') result = 'Norwegian Edition';
      else if (s[4] === '11000267109') result = 'Republic of Korea Edition (South Korea)';
      else if (s[4] === '900000001000122104') result = 'Spanish National Edition';
      else if (s[4] === '45991000052106') result = 'Swedish Edition';
      else if (s[4] === '2011000195101') result = 'Swiss Edition';
      else if (s[4] === '83821000000107') result = 'UK Edition';
      else if (s[4] === '999000021000000109') result = 'UK Clinical Edition';
      else if (s[4] === '5631000179106') result = 'Uruguay Edition';
      else if (s[4] === '21000325107') result = 'Chilean Edition';
      else if (s[4] === '731000124108') result = 'US Edition';
      else if (s[4] === '5991000124107') result = 'US Edition (with ICD-10-CM maps)';
    }
    return result;
  }
}

module.exports = {
  TerminologyWorker,
  TerminologySetupError,
  CACHE_ID_HEADER,
  Unknown_Code_in_VersionSCT,
  SCTVersion
};