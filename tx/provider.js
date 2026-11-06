const { chooseImplicitValueSetFactory } = require('./library/implicit-valuesets');
const { CodeSystem } = require("./library/codesystem");
const { assertNoActiveContent } = require('../library/narrative-check');
const {VersionUtilities} = require("../library/version-utilities");
const { FhirCodeSystemProvider} = require("./cs/cs-cs");
const {OperationContext} = require("./operation-context");
const {TerminologyError} = require("./library/errors");
const {validateParameter, validateOptionalParameter, validateArrayParameter} = require("../library/utilities");
const path = require("path");
const {PackageContentLoader} = require("../library/package-manager");
const {PackageValueSetProvider} = require("./vs/vs-package");
const ValueSet = require("./library/valueset");
const {PackageConceptMapProvider} = require("./cm/cm-package");
const { applyIdPrefix, CORE_PREFIX } = require("./library/resource-ids");
const { CodeSystemFactoryProvider } = require("./cs/cs-api");

/**
 * The code system providers resolveCode() has built, per operation: opContext ->
 * Map(factory -> Promise of the provider). A page asks resolveCode about every code it
 * shows, and for a database-backed code system each build opens a connection that stays
 * open until the request ends, so one is built per code system and version, and reused.
 * Keyed weakly, so the entry goes when the operation does.
 */
const resolveCodeProviders = new WeakMap();

/**
 * How many codes resolveCodes() locates at once. Enough to keep a database-backed code
 * system busy without queueing a whole page's worth of queries at the same time.
 */
const RESOLVE_CODES_CONCURRENCY = 8;

/**
 * fn over items, at most `limit` at a time, with the results in the order of the items.
 */
async function mapConcurrently(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * This class holds what information is in context
 *
 * It is prepared for each operation, and carries 4 sets of information:
 *
 * - The special code system classes supported natively by the system
 * - A list of all the code system resources in scope
 * - a list of value set providers that can provide value set instances
 * - a list of concept map providers that can provide concept map instances
 *
 */
/**
 * The provider's CodeSystem map (keys url and url|version), with an index of the CodeSystems it
 * holds by the url they supplement, so that loadSupplements() looks only at those instead of
 * every loaded CodeSystem on every code-system lookup.
 *
 * The index is part of the map, not a cache: set, delete and clear are the only ways to change a
 * Map, and each updates the index in the same call. Provider.addCodeSystem and deleteCodeSystem
 * are the only callers that change this map.
 *
 * supplementsOf(url) gives every value whose CodeSystem.isSupplementFor(url, version) can be
 * true, in the map's own order, and possibly some for which it is false; loadSupplements still
 * asks isSupplementFor of each. isSupplementFor is true only when `supplements` equals url or
 * starts with url + '|', and then the part of `supplements` before any '|' is the part of url
 * before any '|': that is the index key.
 */
class CodeSystemMap extends Map {
  constructor(entries) {
    super();
    this.supplementIndex = new Map(); // key used by supplementsOf -> Set of map keys
    this.indexedUnder = new Map();    // map key -> its key in supplementIndex
    this.position = new Map();        // map key -> insertion number, to keep the map's order
    this.nextPosition = 0;
    if (entries) {
      for (const [k, v] of entries) this.set(k, v);
    }
  }

  /** the index key for a url, or for a CodeSystem's supplements value: the part before any '|' */
  static indexKey(url) {
    return String(url).split('|')[0];
  }

  set(k, v) {
    if (!super.has(k)) {
      this.position.set(k, this.nextPosition++); // a Map keeps a replaced key where it was
    }
    this.#unindex(k);
    super.set(k, v);
    const supplements = v && v.jsonObj ? v.jsonObj.supplements : null;
    if (supplements) {
      const u = CodeSystemMap.indexKey(supplements);
      let keys = this.supplementIndex.get(u);
      if (!keys) this.supplementIndex.set(u, keys = new Set());
      keys.add(k);
      this.indexedUnder.set(k, u);
    }
    return this;
  }

  delete(k) {
    this.#unindex(k);
    this.position.delete(k);
    return super.delete(k);
  }

  clear() {
    this.supplementIndex.clear();
    this.indexedUnder.clear();
    this.position.clear();
    super.clear();
  }

  // removes k from the index under the key it was indexed under when it was set
  #unindex(k) {
    const u = this.indexedUnder.get(k);
    if (u === undefined) return;
    this.indexedUnder.delete(k);
    const keys = this.supplementIndex.get(u);
    keys.delete(k);
    if (keys.size === 0) this.supplementIndex.delete(u);
  }

  /** the values that may supplement url (any version), in the order values() gives them */
  supplementsOf(url) {
    const keys = this.supplementIndex.get(CodeSystemMap.indexKey(url));
    if (!keys) return [];
    return [...keys].sort((a, b) => this.position.get(a) - this.position.get(b)).map(k => super.get(k));
  }
}

class Provider {
  i18n;
  fhirVersion;
  context;

  /**
   * {Map<String, CodeSystemFactoryProvider>} A list of code system factories that contains all the preloaded native code systems
   */
  codeSystemFactories;

  /**
   * {Map<String, CodeSystem>} A list of preloaded FHIR code systems
   */
  codeSystems;

  /**
   * {List<AbstractCodeSystemProvider>} code system providers, for maintaing the code system list
   */
  codeSystemProviders

  /**
   * {List<AbstractValueSetProvider>} A list of value set providers that know how to provide value sets by request
   */
  valueSetProviders;
  /**
   * {List<AbstractConceptMapProvider>} A list of value set providers that know how to provide value sets by request
   */
  conceptMapProviders;

  packageSources;
  externalSources;

  baseUrl = null;
  path;
  cacheFolder = null;
  startTime = Date.now();
  startMemory = process.memoryUsage();
  lastTime = null;
  requestCount = 0;
  totalDownloaded = 0;

  /**
   * get a code system provider for a known code system
   *
   * @param {OperationContext} opContext - The code system resource
   * @param {String} system - The URL - might include a |version
   * @param {String} version - The version, if seperate from the system
   * @param {String[]} supplements - Applicable supplements
   * @returns {CodeSystemProvider} Provider instance
   */
  async getCodeSystemProvider(opContext, system, version, supplements) {
    validateParameter(opContext, "opContext", OperationContext);
    validateParameter(system, "system", String);
    validateArrayParameter(supplements, "supplements", CodeSystem);
    validateOptionalParameter(version, "version", String);

    if (system.includes("|")) {
      const url = system.substring(0, system.indexOf("|"));
      const v = system.substring(system.indexOf("|")+1);
      if (version == null || v === version) {
        version = v;
      } else {
        throw new TerminologyError(`Version inconsistent in ${system}: ${v} vs ${version}`);
      }
      system = url;
    } else if (!version) {
      version = null;
    }
    const vurl = system+(version ? "|"+version : "");
    const vurlMM = VersionUtilities.isSemVer(version) ? system+"|"+VersionUtilities.getMajMin(version) : null;
    let factory = this.codeSystemFactories.get(vurl);
    if (factory == null && vurlMM) {
      factory = this.codeSystemFactories.get(vurlMM);
    }
    if (factory != null) {
      return factory.build(opContext, supplements);
    }
    let cs = this.codeSystems.get(vurl);
    if (cs == null && vurlMM) {
      cs = this.codeSystems.get(vurlMM);
    }
    if (cs != null) {
      return this.createCodeSystemProvider(opContext, cs, supplements);
    }
    return null;
  }

  loadSupplements(url, version, statedSupplements) {
    let supplements = new Map();
    for (let csp of this.codeSystemFactories.values()) {
      csp.listSupplements(supplements, url, version, statedSupplements);
    }
    // the index gives the same candidates in the same order as values(), less the ones that
    // can't be supplements of url (see CodeSystemMap)
    const candidates = this.codeSystems instanceof CodeSystemMap ? this.codeSystems.supplementsOf(url) : this.codeSystems.values();
    for (let cs of candidates) {
      if (cs.isSupplementFor(url, version)) {
        if (cs.isGlobalSupplement() || this.isStatedSupplement(cs, statedSupplements)) {
          supplements.set(cs.vurl, cs);
        }
      }
    }
    return [...supplements.values()];
  }

  isStatedSupplement(cs, statedSupplements) {
    if (statedSupplements == null) {
      return false;
    }
    for (let suppU of statedSupplements) {
      if (suppU === cs.url) {
        return true;
      }
      if (suppU.startsWith(cs.url+"|")) {
        let suppV = suppU.substring(suppU.indexOf('|') + 1);
        return VersionUtilities.versionMatchesByAlgorithm(suppV, cs.version, VersionUtilities.guessVersionAlgorithmFromVersion(cs.version));
      }
    }
    return false;
  }
  /**
   * Create a code system provider from a CodeSystem resource
   * @param {OperationContext} opContext - The code system resource
   * @param {CodeSystem} codeSystem - The code system resource
   * @param {CodeSystem[]} supplements - The code system resource
   * @returns {CodeSystemProvider} Provider instance
   */
  async createCodeSystemProvider(opContext, codeSystem, supplements) {
    validateParameter(opContext, "opContext", OperationContext);
    validateParameter(codeSystem, "codeSystem", CodeSystem);
    validateArrayParameter(supplements, "supplements", CodeSystem);
    return FhirCodeSystemProvider.create(opContext, codeSystem, supplements);
  }


  /**
   * Load the FHIR core package for this endpoint. Its resources are served in the 'core' id
   * space (CodeSystem/core-v3-MaritalStatus): the core packages for different FHIR versions
   * share ids, and so does other content (hl7.terminology), so no endpoint can serve them on
   * their own ids (see tx/library/resource-ids.js)
   *
   * @returns {Promise<PackageContentLoader|undefined>} the loaded package (mode "npm")
   */
  async loadNpm(packageManager, cacheFolder,  details, isDefault, mode) {
    // Parse packageId and version from details (e.g., "hl7.terminology.r4#6.0.2")
    let packageId = details;
    let version = null;
    if (details.includes('#')) {
      const parts = details.split('#');
      packageId = parts[0];
      version = parts[1];
    }
    const packagePath = await packageManager.fetch(packageId, version);
    if (mode === "fetch" || mode === "cs") {
      return;
    }
    const fullPackagePath = path.join(cacheFolder, packagePath);
    const contentLoader = new PackageContentLoader(fullPackagePath);
    await contentLoader.initialize();

    const resources = await contentLoader.getResourcesByType("CodeSystem");
    let i = 0;
    // the index has the urls as they are in the package; the version is taken out of the url
    // when the code system is loaded (see normalizeVersionedCanonicals in package-manager.js)
    for (const resource of resources) {
      let cs;
      try {
        const json = await contentLoader.loadFile(resource, contentLoader.fhirVersion());
        // narrative is shown as-is in a page, so it must not carry script (see narrative-check.js)
        assertNoActiveContent(json);
        cs = new CodeSystem(json);
      } catch (e) {
        // one unacceptable resource (e.g. contained resources the server doesn't support)
        // must not stop the rest of the package loading
        require('../library/logger').getInstance().child({ module: 'tx' })
          .warn(`Package ${contentLoader.pid()}: skipping CodeSystem ${resource.id || resource.filename || ''}: ${e.message}`);
        continue;
      }
      cs.sourcePackage = contentLoader.pid();
      if (typeof resource.url === 'string' && resource.url.includes('|')) {
        cs.urlHadVersion = true; // see addCodeSystem
      }
      // these objects belong to this endpoint, so they can be given ids here
      i++;
      if (!cs.id) {
        cs.id = String(i);
      }
      applyIdPrefix(cs, CORE_PREFIX);
      this.addCodeSystem(cs);
    }
    const vs = new PackageValueSetProvider(contentLoader);
    await vs.initialize();
    vs.assignIds(CORE_PREFIX);
    this.valueSetProviders.push(vs);
    const cm = new PackageConceptMapProvider(contentLoader);
    await cm.initialize();
    cm.assignIds(CORE_PREFIX);
    this.conceptMapProviders.push(cm);
    return contentLoader;
  }

  getCodeSystemById(opContext, id) {

    // Search through codeSystems map for matching id
    for (const cs of this.codeSystems.values()) {
      if (opContext) opContext.deadCheck('getCodeSystemById');
      if (cs.jsonObj.id === id) {
        return cs;
      }
    }
    return undefined;
  }

  getCodeSystemFactoryById(opContext, id) {
    // Search through codeSystems map for matching id
    for (const cs of this.codeSystemFactories.values()) {
      if (cs.id() == id) {
        return cs;
      }
    }
    return undefined;
  }

  async getValueSetById(opContext, id) {
    for (const vp of this.valueSetProviders) {
      if (opContext) opContext.deadCheck('getValueSetById');
      let vs = await vp.fetchValueSetById(id);
      if (vs) {
        return vs;
      }
    }
    return null;
  }

  async findValueSet(opContext, url, version, systemVersionFor = null) {
    for (const vp of this.valueSetProviders) {
      if (opContext) opContext.deadCheck('findValueSet');
      let vs = await vp.fetchValueSet(url, version);
      if (vs) {
        return vs;
      }
    }
    let vs1 = await this.findKnownValueSet(url, version, systemVersionFor);
    return vs1;
  }

  async getConceptMapById(opContext, id) {
    for (const cmp of this.conceptMapProviders) {
      if (opContext) opContext.deadCheck('getConceptMapById');
      let cm = await cmp.fetchConceptMapById(id);
      if (cm) {
        return cm;
      }
    }
    return null;
  }

  async findConceptMap(opContext, url, version) {
    for (const cmp of this.conceptMapProviders) {
      if (opContext) opContext.deadCheck('findConceptMap');
      let cm = await cmp.fetchConceptMap(url, version);
      if (cm) {
        return cm;
      }
    }

    // Ask each code system version once: an implicit map can belong to one version
    // only (a SNOMED CT edition's maps are named by its edition URI)
    let uris = new Set();
    for (let csp of this.codeSystemFactories.values()) {
      const key = csp.system() + '|' + csp.version();
      if (!uris.has(key)) {
        uris.add(key);
        let cm = await csp.findImplicitConceptMap(url, version);
        if (cm) {
          return cm;
        }
      }
    }
  }

  listValueSetSourceCodes() {
    let result = [];
    for (let vsp of this.valueSetProviders) {
      result.push(vsp.sourcePackage());
    }
    result.sort((a, b) => {a.localeCompare(b)});
    return result;
  }

  async listCodeSystemVersions(url) {
    let result = new Set();
    for (let cs of this.codeSystems.values()) {
      if (cs.url == url && cs.version) {
        result.add(cs.version);
      }
    }
    for (let cp of this.codeSystemFactories.values()) {
      if (cp.system() == url) {
        result.add(cp.version());
      }
    }
    return result;
  }

  async findKnownValueSet(url, version, systemVersionFor = null) {
    // A code system with several versions loaded (SNOMED CT editions) says which form of
    // implicit value set url is: the generic form comes from the version the request asks
    // for (systemVersionFor, from system-version and the like) or else the default version
    // (the one registered under the bare system), the edition form from the latest version
    // of that edition, and the version form from that version alone - not from whichever
    // version happens to be asked first.
    const chosen = chooseImplicitValueSetFactory(this.codeSystemFactories.values(), system => this.codeSystemFactories.get(system), url, systemVersionFor);
    if (chosen) {
      const vs = await chosen.buildKnownValueSet(url, version);
      return vs != null ? new ValueSet(vs) : null;
    }
    for (let csp of this.codeSystemFactories.values()) {
      let vs = await csp.buildKnownValueSet(url, version);
      if (vs != null) {
        return new ValueSet(vs);
      }
    }
    return null;
  }



  async findConceptMapForTranslation(opContext, conceptMaps, sourceSystem, sourceVersion, sourceScope, targetScope, targetSystem, sourceCode = null) {
    for (let cmp of this.conceptMapProviders) {
      await cmp.findConceptMapForTranslation(opContext, conceptMaps, sourceSystem, sourceScope, targetScope, targetSystem, sourceCode);
    }
    if (sourceSystem && targetSystem) {
      // Each code system is asked once - except the source system itself, where every
      // version (every SNOMED edition, say) is asked, since whether a map exists and what
      // it says can depend on which version the source coding is in. The factory decides
      // from sourceVersion whether it is the one being asked about.
      // The same goes for the target system: a map from another system into one SNOMED
      // edition (LOINC codes to the concepts that carry them, say) belongs to that edition.
      const targetBase = targetSystem.split('|')[0];
      let uris = new Set();
      let asked = new Set(); // a factory is registered under several keys (system, system|version...)
      // A source version that names a version without a date (a SNOMED CT edition URI, say)
      // matches every version of it the server holds; it means the one it resolves to, as it
      // does everywhere else - asking each would give the same translation once per release
      const chosen = sourceVersion ? this.codeSystemFactories.get(sourceSystem + '|' + sourceVersion) : null;
      for (let csp of this.codeSystemFactories.values()) {
        if (asked.has(csp)) {
          continue;
        }
        if (chosen && csp !== chosen && csp.system() === sourceSystem) {
          continue;
        }
        if (csp.system() === sourceSystem || csp.system() === targetBase || !uris.has(csp.system())) {
          uris.add(csp.system());
          asked.add(csp);
          await csp.findImplicitConceptMaps(conceptMaps, sourceSystem, sourceVersion, targetSystem, sourceCode);
        }
      }
    }
  }

  getFhirVersion() {
    switch (this.fhirVersion) {
      case 5: return "R5";
      case 4: return "R4";
      case 3: return "R3";
      default: return "R5";
    }
  }

  async listAllValueSets() {
    let result = [];
    for (let vsp of this.valueSetProviders) {
      result.push(... await vsp.listAllValueSets());
    }
    return result;

  }

  async resolveURL(opContext, system, version) {
    validateParameter(opContext, "opContext", OperationContext);
    validateParameter(system, "system", String);
    validateOptionalParameter(version, "version", String);

    if (system.includes("|")) {
      const url = system.substring(0, system.indexOf("|"));
      const v = system.substring(system.indexOf("|")+1);
      if (version == null || v === version) {
        version = v;
      } else {
        throw new TerminologyError(`Version inconsistent in ${system}: ${v} vs ${version}`);
      }
      system = url;
    } else if (!version) {
      version = null;
    }
    const vurl = system+(version ? "|"+version : "");
    const vurlMM = VersionUtilities.isSemVer(version) ? system+"|"+VersionUtilities.getMajMin(version) : null;
    let factory = this.codeSystemFactories.get(vurl);
    if (factory == null && vurlMM) {
      factory = this.codeSystemFactories.get(vurlMM);
    }
    if (factory != null) {
      let vdesc = version == null ? "" : factory.describeVersion(version);
      return {
        link: this.path+"/CodeSystem/x-"+factory.id(),
        description: factory.nameBase()+' '+vdesc
      };
    }
    let cs = this.codeSystems.get(vurl);
    if (cs == null && vurlMM) {
      cs = this.codeSystems.get(vurlMM);
    }
    if (cs != null) {
      return {
        link: this.path+"/CodeSystem/"+cs.id,
        description: (cs.title ? cs.title : cs.name)+(version ? " v"+version : "")
      };
    }

    let vs = await this.findValueSet(opContext, system, version);
    if (vs) {
      return {
        link: this.path+"/ValueSet/"+vs.id,
        description: (vs.title ? vs.title : vs.name)+(version ? " v"+version : vs.version ?  " v"+vs.version : "")
      };
    }
    let cm = await this.findConceptMap(opContext, system, version);
    if (cm) {
      return {
        link: this.path+"/ConceptMap/"+cm.id,
        description: (cm.title ? cm.title : cm.name)+(version ? " v"+version : "")
      };
    }
    return null;
  }

  async resolveCode(opContext, system, version, code) {
    validateParameter(code, "code", String);
    return (await this.resolveCodes(opContext, system, version, [code]))[0];
  }

  /**
   * resolveCode() for many codes of one code system: where each code lives (a link) and
   * its display, or null, in the order of the codes.
   *
   * The code system is found and its provider built once for all of them, and the codes
   * are located RESOLVE_CODES_CONCURRENCY at a time rather than one after another.
   *
   * @param {OperationContext} opContext
   * @param {string} system
   * @param {string|null} version
   * @param {string[]} codes
   * @returns {Promise<Array<{link: string, description: string}|null>>}
   */
  async resolveCodes(opContext, system, version, codes) {
    validateParameter(opContext, "opContext", OperationContext);
    validateParameter(system, "system", String);
    validateOptionalParameter(version, "version", String);
    validateArrayParameter(codes, "codes", String);
    if (codes.length === 0) {
      return [];
    }

    if (system.includes("|")) {
      const url = system.substring(0, system.indexOf("|"));
      const v = system.substring(system.indexOf("|")+1);
      if (version == null || v === version) {
        version = v;
      } else {
        throw new TerminologyError(`Version inconsistent in ${system}: ${v} vs ${version}`);
      }
      system = url;
    } else if (!version) {
      version = null;
    }
    const vurl = system+(version ? "|"+version : "");
    const vurlMM = VersionUtilities.isSemVer(version) ? system+"|"+VersionUtilities.getMajMin(version) : null;
    let factory = this.codeSystemFactories.get(vurl);
    if (factory == null && vurlMM) {
      factory = this.codeSystemFactories.get(vurlMM);
    }
    // A code system from a factory gives a code a link only if the factory is iteratable
    // (US states) or has a codeLink() of its own. For the rest (RxNorm, LOINC, SNOMED CT,
    // ...) what locate() finds would be thrown away, so they are not built or asked.
    // That matters: RxNorm looks for a code it does not have in its archive table, which
    // takes 36 ms a code, and 4,529 of Medication Brand Name's codes are not current.
    const linksCodes = factory != null
      && (factory.iteratable() || factory.codeLink !== CodeSystemFactoryProvider.prototype.codeLink);
    const csp = linksCodes ? await this.resolveCodeProvider(opContext, factory) : null;
    let cs = this.codeSystems.get(vurl);
    if (cs == null && vurlMM) {
      cs = this.codeSystems.get(vurlMM);
    }

    return mapConcurrently(codes, RESOLVE_CODES_CONCURRENCY, async (code) => {
      if (csp) {
        const located = await csp.locate(code);
        const c = located ? located.context : null;
        if (c) {
          if (factory.iteratable()) {
            return {
              link: this.path + "/CodeSystem/x-" + factory.id(),
              description: await csp.display(c)
            }
          } else {
             const link = factory.codeLink(c);
             if (link) {
               return {
                 link: link,
                 description: await csp.display(c)
               }
             }
          }
        }
      }
      if (cs != null) {
        const c = cs.codeMap.get(code);
        if (c) {
          return {
            link: this.path + "/CodeSystem/" + cs.id + '#' + code,
            description: c.display
          };
        }
      }
      return null;
    });
  }

  /**
   * The provider resolveCode() uses for a code system factory in this operation: built
   * the first time it is asked for, registered for closing when the operation ends, and
   * reused after that. The promise is kept, so calls that overlap share one build.
   *
   * @param {OperationContext} opContext
   * @param {CodeSystemFactoryProvider} factory
   * @returns {Promise<CodeSystemProvider|null>}
   */
  resolveCodeProvider(opContext, factory) {
    let built = resolveCodeProviders.get(opContext);
    if (!built) {
      built = new Map();
      resolveCodeProviders.set(opContext, built);
    }
    let csp = built.get(factory);
    if (!csp) {
      csp = (async () => {
        const p = await factory.build(opContext, []);
        opContext.registerProvider(p);
        return p;
      })();
      // A failed build is not kept, so the next call tries again.
      csp.catch(() => built.delete(factory));
      built.set(factory, csp);
    }
    return csp;
  }

  /**
   * A checker for codes in one code system, so that a page can ask about many codes
   * without paying to build the code system each time.
   *
   * This is for deciding whether to offer a link. A property value that came back from
   * $lookup as a code is, by the definition of CodeSystem.property.type, a concept in the
   * same code system - but a provider can declare a property that way and then put
   * something else in it (ICD-11's classKind is chapter|block|window|category, none of
   * which is an ICD-11 concept), and a link to a code that is not there is worse than no
   * link. So the codes are checked, once each, against the code system itself.
   *
   * @param {OperationContext} opContext
   * @param {string} system
   * @param {string|null} version
   * @returns {Promise<function(string): Promise<string|null>>|null} a function returning
   *   the code's display (possibly empty) if it exists and null if it does not, or null
   *   when this server does not have that code system at all
   */
  async codeChecker(opContext, system, version) {
    validateParameter(opContext, "opContext", OperationContext);
    if (!system) {
      return null;
    }
    if (system.includes("|")) {
      version = version || system.substring(system.indexOf("|") + 1);
      system = system.substring(0, system.indexOf("|"));
    }
    const vurl = system + (version ? "|" + version : "");
    const vurlMM = VersionUtilities.isSemVer(version) ? system + "|" + VersionUtilities.getMajMin(version) : null;

    let factory = this.codeSystemFactories.get(vurl);
    if (factory == null && vurlMM) {
      factory = this.codeSystemFactories.get(vurlMM);
    }
    if (factory != null) {
      const csp = await factory.build(opContext, []);
      if (csp) {
        opContext.registerProvider(csp);
        return async (code) => {
          const located = await csp.locate(code);
          return located && located.context ? (await csp.display(located.context)) || '' : null;
        };
      }
    }

    let cs = this.codeSystems.get(vurl);
    if (cs == null && vurlMM) {
      cs = this.codeSystems.get(vurlMM);
    }
    if (cs != null) {
      return async (code) => {
        const c = cs.codeMap.get(code);
        return c ? (c.display || '') : null;
      };
    }
    return null;
  }

  /**
   * A link to $lookup for a code on this server.
   *
   * resolveCode() answers "where does this code live" - a code system page, or the
   * publisher's own browser - which is the right answer in prose. In an expansion the
   * question is different: the reader has a list of codes in front of them and wants to
   * know what one of them actually is, which is what $lookup answers, here, in the
   * version the expansion used.
   *
   * @param {string} system
   * @param {string|null} version - may also be carried on system as system|version
   * @param {string} code
   * @returns {string|null} the URL, or null if there is not enough to build one
   */
  lookupLink(system, version, code) {
    if (!system || !code) {
      return null;
    }
    if (system.includes("|")) {
      version = version || system.substring(system.indexOf("|") + 1);
      system = system.substring(0, system.indexOf("|"));
    }
    return this.path + "/CodeSystem/$lookup?system=" + encodeURIComponent(system)
      + (version ? "&version=" + encodeURIComponent(version) : "")
      + "&code=" + encodeURIComponent(code);
  }

  async hasCsVersion(system, version) {
    for (let cs of this.codeSystems.values()) {
      if (cs.url == system && cs.version == version) {
        return true;
      }
    }
    for (let cp of this.codeSystemFactories.values()) {
      if (cp.system() == system && cp.version() == version) {
        return true;
      }
    }
    return false;
  }

  async updateCodeSystemList() {
    for (let csp of this.codeSystemProviders) {
      let changes = await csp.getCodeSystemChanges(this.fhirVersion, this.context);
      if (changes) {
        for (let cs of changes.added || []) {
          this.addCodeSystem(cs);
        }
        for (let cs of changes.changed || []) {
          this.addCodeSystem(cs);
        }
        for (let cs of changes.deleted || []) {
          this.deleteCodeSystem(cs);
        }
      }
    }
  }

  /**
   * True if the source package id (e.g. "hl7.terminology.r4#6.0.2") is a
   * terminology.hl7.org (THO/UTG) package.
   */
  static #isTHOPackage(pid) {
    return pid != null && pid.startsWith("hl7.terminology");
  }

  /**
   * Add a code system to the ones this endpoint knows, by url and by url|version.
   *
   * THO precedence, as in CanonicalResourceManager.see() in the Java core: content that
   * moved from the FHIR core packages to terminology.hl7.org has been QA'd there since, and
   * its versions went backwards (coverage-selfpay is 4.0.1 in hl7.fhir.r4.core but 1.0.1 in
   * hl7.terminology), so version precedence can't decide between them. Instead, a code system
   * from an hl7.terminology package is always the default for its url - what a reference with
   * no version gets - whatever versions the FHIR core packages have.
   *
   * The core versions stay available by url|version, where THO doesn't provide that version
   * itself: a reference that names its version (url|5.0.0) means the core one, and there's
   * nothing else it can mean. They are never the default while THO provides the url (see also
   * deleteCodeSystem).
   */
  addCodeSystem(cs) {
    if (Provider.#isTHOPackage(cs.sourcePackage)) {
      // THO's code system takes over the default from a core one; the core versions stay
      const t = this.codeSystems.get(cs.url);
      if (t && t.url === cs.url && VersionUtilities.isCorePackage(t.sourcePackage)) {
        this.codeSystems.delete(cs.url);
      }
    }
    const existing = this.codeSystems.get(cs.url);
    // a core-package resource never displaces a THO one as the default
    const yieldsToTHO = existing && Provider.#isTHOPackage(existing.sourcePackage)
      && VersionUtilities.isCorePackage(cs.sourcePackage);
    if (!existing || (!yieldsToTHO && cs.isMoreRecent(existing))) {
      this.codeSystems.set(cs.url, cs);
    }
    if (cs.version) {
      // a versioned entry only yields to THO when THO itself provides that exact version
      const vExisting = this.codeSystems.get(cs.vurl);
      const vYieldsToTHO = vExisting && Provider.#isTHOPackage(vExisting.sourcePackage)
        && VersionUtilities.isCorePackage(cs.sourcePackage);
      if (!vYieldsToTHO) {
        this.codeSystems.set(cs.vurl, cs);
      }
    }
  }

  /**
   * THO precedence for value sets and concept maps, as for code systems (see addCodeSystem):
   * once the library's providers have been added after this endpoint's core package, the core
   * package's value sets and concept maps whose urls an hl7.terminology package also provides
   * are only available to a reference that names their version (and THO doesn't provide that
   * version itself). They are never what a reference with no version gets, and they aren't
   * read by id, found by search, or used for translation unless asked for.
   */
  applyTHOPrecedence() {
    const thoValueSets = new Map();
    for (const vp of this.valueSetProviders) {
      if (vp instanceof PackageValueSetProvider && Provider.#isTHOPackage(vp.sourcePackage())) {
        for (const vs of vp.valueSetMap.values()) {
          Provider.#addVersion(thoValueSets, vs);
        }
      }
    }
    const thoConceptMaps = new Map();
    for (const cmp of this.conceptMapProviders) {
      if (cmp instanceof PackageConceptMapProvider && Provider.#isTHOPackage(cmp.sourcePackage())) {
        for (const cm of cmp.conceptMapMap.values()) {
          Provider.#addVersion(thoConceptMaps, cm);
        }
      }
    }
    for (const vp of this.valueSetProviders) {
      if (vp instanceof PackageValueSetProvider && VersionUtilities.isCorePackage(vp.sourcePackage())) {
        vp.keepPinnedOnly(thoValueSets);
      }
    }
    for (const cmp of this.conceptMapProviders) {
      if (cmp instanceof PackageConceptMapProvider && VersionUtilities.isCorePackage(cmp.sourcePackage())) {
        cmp.keepPinnedOnly(thoConceptMaps);
      }
    }
  }

  static #addVersion(map, resource) {
    if (!resource || !resource.url) {
      return;
    }
    if (!map.has(resource.url)) {
      map.set(resource.url, new Set());
    }
    if (resource.version) {
      map.get(resource.url).add(resource.version);
    }
  }

  deleteCodeSystem(cs) {
    this.codeSystems.delete(cs.vurl);
    this.codeSystems.delete(cs.url);
    // If other versions of the SAME url survive, re-point the unversioned [url]
    // entry at the most-recent surviving version. Otherwise leave it deleted.
    // THO precedence (see addCodeSystem): while a THO version survives, a core one
    // can't become the default, however recent its (reset) version looks
    const survivors = [...new Set(this.codeSystems.values())].filter(t => t.url === cs.url);
    const tho = survivors.filter(t => Provider.#isTHOPackage(t.sourcePackage));
    let existing = null;
    for (let t of (tho.length > 0 ? tho : survivors)) {
      if (!existing || t.isMoreRecent(existing)) {
        existing = t;
      }
    }
    if (existing) {
      this.codeSystems.set(existing.url, existing);
    }
  }

}

module.exports = { CodeSystemMap, Provider };
