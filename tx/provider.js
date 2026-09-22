const { CodeSystem } = require("./library/codesystem");
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
    for (let cs of this.codeSystems.values()) {
      if (cs.isSupplementFor(url, version)) {
        if (cs.isLangPack() || this.isStatedSupplement(cs, statedSupplements)) {
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
    return new FhirCodeSystemProvider(opContext, codeSystem, supplements);
  }


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
    for (const resource of resources) {
      const cs = new CodeSystem(await contentLoader.loadFile(resource, contentLoader.fhirVersion()));
      cs.sourcePackage = contentLoader.pid();
      this.addCodeSystem(cs);
    }
    const vs = new PackageValueSetProvider(contentLoader);
    await vs.initialize();
    this.valueSetProviders.push(vs);
    const cm = new PackageConceptMapProvider(contentLoader);
    await cm.initialize();
    this.conceptMapProviders.push(cm);
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

  async findValueSet(opContext, url, version) {
    for (const vp of this.valueSetProviders) {
      if (opContext) opContext.deadCheck('findValueSet');
      let vs = await vp.fetchValueSet(url, version);
      if (vs) {
        return vs;
      }
    }
    let vs1 = await this.findKnownValueSet(url, version);
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

    let uris = new Set();
    for (let csp of this.codeSystemFactories.values()) {
      if (!uris.has(csp.system())) {
        uris.add(csp.system());
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

  async findKnownValueSet(url, version) {
    for (let csp of this.codeSystemFactories.values()) {
      let vs = await csp.buildKnownValueSet(url, version);
      if (vs != null) {
        return new ValueSet(vs);
      }
    }
    return null;
  }



  async findConceptMapForTranslation(opContext, conceptMaps, sourceSystem, sourceScope, targetScope, targetSystem, sourceCode = null) {
    for (let cmp of this.conceptMapProviders) {
      await cmp.findConceptMapForTranslation(opContext, conceptMaps, sourceSystem, sourceScope, targetScope, targetSystem, sourceCode);
    }
    if (sourceSystem && targetSystem) {
      let uris = new Set();
      for (let csp of this.codeSystemFactories.values()) {
        if (!uris.has(csp.system())) {
          uris.add(csp.system());
          await csp.findImplicitConceptMaps(conceptMaps, sourceSystem, targetSystem);
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
    validateParameter(opContext, "opContext", OperationContext);
    validateParameter(system, "system", String);
    validateOptionalParameter(version, "version", String);
    validateParameter(code, "code", String);

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
      const csp = await factory.build(opContext, []);
      opContext.registerProvider(csp);
      const c = csp ? csp.locate(code) : null;
      if (c) {
        if (factory.iteratable()) {
          return {
            link: this.path + "/CodeSystem/x-" + factory.id(),
            description: csp.display(c)
          }
        } else {
           const link = factory.codeLink(c);
           if (link) {
             return {
               link: link,
               description: csp.display(c)
             }
           }
        }
      }
    }
    let cs = this.codeSystems.get(vurl);
    if (cs == null && vurlMM) {
      cs = this.codeSystems.get(vurlMM);
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

  addCodeSystem(cs) {
    // Special case, mirroring CanonicalResourceManager.see() in the Java core:
    // when content moved from the FHIR core packages to terminology.hl7.org,
    // the versions went backwards (e.g. coverage-selfpay is 4.0.1 in
    // hl7.fhir.r4.core (2019) but 1.0.1 in hl7.terminology (2024)), so plain
    // version precedence would leave the stale core copy as the default. A
    // resource from an hl7.terminology package displaces any same-URL
    // resource that came from a FHIR core package, regardless of version.
    if (Provider.#isTHOPackage(cs.sourcePackage)) {
      for (const [key, t] of [...this.codeSystems]) {
        // only the bare-url (default) entry is displaced; explicitly versioned
        // entries (key = url|version) stay addressable, because the core packages
        // carry historical versions (e.g. the normalized R4 v2 tables 0006/0360/0391
        // at 2.1/2.3.1/2.4/2.6/2.7) that hl7.terminology does not publish at all
        if (key === t.url && t.url === cs.url && VersionUtilities.isCorePackage(t.sourcePackage)) {
          this.codeSystems.delete(key);
        }
      }
    }
    const existing = this.codeSystems.get(cs.url);
    // the reverse guard: a core-package resource never displaces a THO one
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

  deleteCodeSystem(cs) {
    this.codeSystems.delete(cs.vurl);
    this.codeSystems.delete(cs.url);
    // If other versions of the SAME url survive, re-point the unversioned [url]
    // entry at the most-recent surviving version. Otherwise leave it deleted.
    let existing = null;
    for (let t of this.codeSystems.values()) {
      if (t.url === cs.url && (!existing || t.isMoreRecent(existing))) {
        existing = t;
      }
    }
    if (existing) {
      this.codeSystems.set(existing.url, existing);
    }
  }

}

module.exports = { Provider };
