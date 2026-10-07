const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const yaml = require('yaml'); // npm install yaml
const { PackageManager, PackageContentLoader } = require('../library/package-manager');
const { FolderContentLoader, FileContentLoader } = require('../library/folder-content-loader');
const { CodeSystem } = require("./library/codesystem");
const {CountryCodeFactoryProvider} = require("./cs/cs-country");
const {Iso4217FactoryProvider} = require("./cs/cs-currency");
const {AreaCodeFactoryProvider} = require("./cs/cs-areacode");
const {MimeTypeServicesFactory} = require("./cs/cs-mimetypes");
const {USStateFactoryProvider} = require("./cs/cs-usstates");
const {HGVSServicesFactory} = require("./cs/cs-hgvs");
const {UcumCodeSystemFactory} = require("./cs/cs-ucum");
const {UcumService} = require("./library/ucum-service");
const {readFileSync} = require("fs");
const https = require('https');
const http = require('http');
const {LoincServicesFactory} = require("./cs/cs-loinc");
const {RxNormServicesFactory} = require("./cs/cs-rxnorm");
const {NdcServicesFactory} = require("./cs/cs-ndc");
const {UniiServicesFactory} = require("./cs/cs-unii");
const {SnomedServicesFactory} = require("./cs/cs-snomed");
const {CPTServicesFactory} = require("./cs/cs-cpt");
const {OMOPServicesFactory} = require("./cs/cs-omop");
const {ICD11ServicesFactory} = require("./cs/cs-icd11");
const {PackageValueSetProvider} = require("./vs/vs-package");
const {PackageConceptMapProvider} = require("./cm/cm-package");
const {IETFLanguageCodeFactory} = require("./cs/cs-lang");
const {LanguageDefinitions} = require("../library/languages");
const {VersionUtilities} = require("../library/version-utilities");
const {ListCodeSystemProvider} = require("./cs/cs-provider-list");
const { Provider } = require("./provider");
const {I18nSupport} = require("../library/i18nsupport");
const folders = require('../library/folder-setup');
const {VSACValueSetProvider} = require("./vs/vs-vsac");
const { OCLCodeSystemProvider, OCLSourceCodeSystemFactory } = require('./ocl/cs-ocl');
const { OCLValueSetProvider } = require('./ocl/vs-ocl');
const { OCLConceptMapProvider } = require('./ocl/cm-ocl');
const {UriServicesFactory} = require("./cs/cs-uri");
const {debugLog} = require("./operation-context");

/**
 * This class holds all the loaded content ready for processing
 *
 * At the start of every service call, this is turned into a
 * provider structure that holds what's actually in context,
 * based on the stated FHIR version, and the other (optional) context information
 *
 */
class Library {
  /**
   * {Map<String, CodeSystemFactoryProvider>} A list of code system factories that contains all the preloaded native code systems
   */
  codeSystemFactories;

  /**
   * {Lisr<AbstractCodeSystemProvider>} A list of preloaded FHIR code systems
   */
  codeSystemProviders;

  /**
   * {List<AbstractValueSetProvider>} A list of value set providers that know how to provide value sets by request
   */
  valueSetProviders;

  /**
   * {List<AbstractConceptMapProvider>} A list of value set providers that know how to provide value sets by request
   */
  conceptMapProviders;

  packageSources = [];
  externalSources = [];

  baseUrl = null;
  cacheFolder = null;
  startTime = Date.now();
  startMemory = process.memoryUsage();
  lastTime = null;
  totalDownloaded = 0;
  vsacCfg = undefined;

  registerProvider(source, factory, isDefault = false) {
    this.#logSystem(factory.system(), factory.version(), source);
    if (isDefault || !this.codeSystemFactories.has(factory.system())) {
      this.codeSystemFactories.set(factory.system(), factory);
    }
    const ver = factory.version() ?? "";
    this.codeSystemFactories.set(factory.system()+"|"+ver, factory);
    const verMin = factory.getPartialVersion();
    if (verMin) {
      this.codeSystemFactories.set(factory.system()+"|"+verMin, factory);
    }
  }

  constructor(configFile, vsacCfg, log, stats) {
    this.configFile = configFile;
    this.vsacCfg = vsacCfg;
    this.log = log;
    this.stats = stats;

    // Only synchronous initialization here
    this.codeSystemFactories = new Map();
    this.codeSystemProviders = [];
    this.valueSetProviders = [];
    this.conceptMapProviders = [];
    this.oclProviderSets = new Map();
    this.oclConfig = {};
    this.ignored = new Set();

    // Create package manager for FHIR packages
    const packageServers = ['https://packages2.fhir.org/packages'];
    this.cacheFolder = folders.subDir('terminology-cache');  // <-- CHANGE
    this.packageManager = new PackageManager(packageServers, this.cacheFolder);
  }

  #logSystemHeader() {
    let time = "Time".padEnd(6);
    // let memory = " MB".padEnd(6);
    let system = "System".padEnd(50);
    let version = "Version".padEnd(62);
    let source = "Source"
    this.log.info(`${time}${system}${version}${source}`);
    this.lastTime = Date.now();
    // this.lastMemory = process.memoryUsage();
  }

  #logSystem(url, ver, source) {
    //const mem = process.memoryUsage();
    let time = Math.floor(Date.now() - this.lastTime).toString().padStart(5)+" ";
    let system = url.padEnd(50);
    let version = (ver == null ? "" : ver).padEnd(62);
    this.log.info(`${time}${system}${version}${source}`);
    this.lastTime = Date.now();
  }

  #logPackagesHeader() {
    let time = "Time".padEnd(6);
    //let memory = " MB".padEnd(6);
    let id = "ID".padEnd(20);
    let ver = "Version".padEnd(20);
    let cs = "CS".padEnd(6);
    let vs = "VS".padEnd(6);
    this.log.info(`${time}${id}${ver}${cs}${vs}`);
    this.lastTime = Date.now();
  }

  #logPackage(idp, verp, csp, vsp) {
    let time = Math.floor(Date.now() - this.lastTime).toString().padStart(5)+" ";
    let id = idp.padEnd(20);
    let ver = verp.padEnd(20);
    let cs = csp.toString().padEnd(6);
    let vs = vsp.toString().padEnd(6);
    this.log.info(`${time}${id}${ver}${cs}${vs}`);
    this.lastTime = Date.now();
  }

  async load() {
    this.startTime = Date.now();
    this.languageDefinitions = await LanguageDefinitions.fromFiles(path.join(__dirname, '../tx/data'));
    this.i18n = new I18nSupport(path.join(__dirname, '../translations'), this.languageDefinitions);
    await this.i18n.load();

    // Read and parse YAML configuration
    const yamlPath = this.configFile ? this.configFile :  path.join(__dirname, '..', 'tx', 'tx.fhir.org.yml');
    const yamlContent = await fs.readFile(yamlPath, 'utf8');
    const config = yaml.parse(yamlContent);
    this.baseUrl = config.base.url;
    this.oclConfig = config.ocl && typeof config.ocl === 'object' ? config.ocl : {};
    this.ignored = new Set(Array.isArray(config.ignored) ? config.ignored : []);

    this.log.info('Fetching Data from '+this.baseUrl);

    for (const source of config.sources) {
      try {
        await this.processSource(source, this.packageManager, "fetch");
      } catch (error) {
        console.error(`Failed to fetch source '${source}': ${error.message}`);
        throw error;
      }
    }

    this.log.info("Downloaded "+((this.totalDownloaded + this.packageManager.totalDownloaded)/ 1024)+" kB");

    this.log.info('Loading Code Systems');
    this.#logSystemHeader();

    for (const source of config.sources) {
      try {
        await this.processSource(source, this.packageManager, "cs");
      } catch (error) {
        debugLog(error);
        console.error(`Failed to load code systems from '${source}': ${error.message}`);
        throw error;
      }
    }
    this.log.info('Loading Packages');
    this.#logPackagesHeader();

    for (const source of config.sources) {
      try {
        await this.processSource(source, this.packageManager, "npm");
      } catch (error) {
        debugLog(error);
        console.error(`Failed to load package '${source}': ${error.message}`);
        throw error;
      }
    }

    const endMemory = process.memoryUsage();
    const totalTime = Date.now() - this.startTime;

    const memoryIncrease = {
      rss: endMemory.rss - this.startMemory.rss,
      heapUsed: endMemory.heapUsed - this.startMemory.heapUsed,
      heapTotal: endMemory.heapTotal - this.startMemory.heapTotal,
      external: endMemory.external - this.startMemory.external
    };

    this.log.info(`Loading Time: ${(totalTime / 1000).toLocaleString()}s`);
    this.log.info(`Memory Used: ${(memoryIncrease.rss / 1024 / 1024).toFixed(2)} MB`);

    this.assignIds();
  }

  async processSource(source, packageManager, mode) {
    // Parse the source string
    const colonIndex = source.indexOf(':');
    if (colonIndex === -1) {
      throw new Error(`Invalid source format: ${source}`);
    }

    let type = source.substring(0, colonIndex);
    const details = source.substring(colonIndex + 1);

    // Handle special markers (like ! for default)
    let isDefault = false;
    if (type.endsWith('!')) {
      type = type.slice(0, -1);
      isDefault = true;
    }

    // Switch statement for different source types
    switch (type) {
      case 'internal':
        await this.loadInternal(details, isDefault, mode);
        break;

      case 'ucum':
        await this.loadUcum(details, isDefault, mode);
        break;

      case 'loinc':
        await this.loadLoinc(details, isDefault, mode);
        break;

      case 'rxnorm':
        await this.loadRxnorm(details, isDefault, mode);
        break;

      case 'ndc':
        await this.loadNdc(details, isDefault, mode);
        break;

      case 'unii':
        await this.loadUnii(details, isDefault, mode);
        break;

      case 'snomed':
        await this.loadSnomed(details, isDefault, mode);
        break;

      case 'cpt':
        await this.loadCpt(details, isDefault, mode);
        break;

      case 'omop':
        await this.loadOmop(details, isDefault, mode);
        break;

      case 'icd11':
        await this.loadIcd11(details, isDefault, mode);
        break;

      case 'npm':
        await this.loadNpm(packageManager, details, isDefault, mode, false);
        break;

      case 'npm/cs':
        await this.loadNpm(packageManager, details, isDefault, mode, true);
        break;

      case 'url':
        await this.loadUrl(packageManager, details, isDefault, mode, false);
        break;

      case 'url/cs':
        await this.loadUrl(packageManager, details, isDefault, mode, true);
        break;

      case 'ocl':
        await this.loadOcl(details, isDefault, mode);
        break;

      case 'folder':
        await this.loadFolder(details, isDefault, mode);
        break;

      case 'file':
        await this.loadFile(details, isDefault, mode);
        break;

      default:
        throw new Error(`Unknown source type: ${type}`);
    }
  }

  parseOclConfig(details) {
    const text = String(details || '').trim();
    if (!text) {
      throw new Error('OCL source requires details, e.g. ocl:https://ocl.example.org');
    }

    const parts = text.split('|').map(p => p.trim()).filter(Boolean);
    const baseUrl = this.resolveOclConfigValue(parts[0]);
    if (!baseUrl) {
      throw new Error('OCL source requires a base URL');
    }

    const config = { baseUrl };
    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const eq = part.indexOf('=');
      if (eq === -1) {
        continue;
      }
      const key = part.substring(0, eq).trim().toLowerCase();
      const value = this.resolveOclConfigValue(part.substring(eq + 1).trim());
      if (!value) {
        continue;
      }
      if (key === 'org') {
        config.org = value;
      } else if (key === 'token') {
        config.token = value;
      } else if (key === 'timeout') {
        const timeout = Number(value);
        if (Number.isFinite(timeout) && timeout > 0) {
          config.timeout = timeout;
        }
      }
    }

    return config;
  }

  resolveOclConfigValue(value) {
    const text = String(value || '').trim();
    if (!text) {
      return text;
    }

    if (this.oclConfig && Object.hasOwn(this.oclConfig, text)) {
      const resolved = this.oclConfig[text];
      if (typeof resolved === 'string') {
        return resolved.trim();
      }
    }

    return text;
  }

  async loadOcl(details, isDefault, mode) {
    const config = this.parseOclConfig(details);
    const cacheKey = `${config.baseUrl}|${config.org || ''}`;

    let providerSet = this.oclProviderSets.get(cacheKey);
    if (!providerSet) {
      const codeSystemProvider = new OCLCodeSystemProvider(config);
      const valueSetProvider = new OCLValueSetProvider(config);
      const conceptMapProvider = new OCLConceptMapProvider(config);
      this.externalSources.push(codeSystemProvider);
      this.externalSources.push(valueSetProvider);
      this.externalSources.push(conceptMapProvider);
      providerSet = {
        config,
        codeSystemProvider,
        valueSetProvider,
        conceptMapProvider,
        csRegistered: false,
        factoriesRegistered: false,
        vsRegistered: false,
        cmRegistered: false
      };
      this.oclProviderSets.set(cacheKey, providerSet);
    }

    if (mode === 'fetch') {
      return;
    }

    if (mode === 'cs') {
      if (!providerSet.csRegistered) {
        this.codeSystemProviders.push(providerSet.codeSystemProvider);
        providerSet.csRegistered = true;
      }

      if (!providerSet.factoriesRegistered) {
        await providerSet.codeSystemProvider.listCodeSystems('5.0', null);
        const metas = providerSet.codeSystemProvider.getSourceMetas();
        for (const meta of metas) {
          const factory = new OCLSourceCodeSystemFactory(this.i18n, providerSet.codeSystemProvider.httpClient, meta);
          this.registerProvider(`ocl:${config.baseUrl}`, factory, isDefault);
        }
        providerSet.factoriesRegistered = true;
      }
      return;
    }

    if (mode === 'npm') {
      if (!providerSet.vsRegistered) {
        this.valueSetProviders.push(providerSet.valueSetProvider);
        providerSet.vsRegistered = true;
      }
      if (!providerSet.cmRegistered) {
        this.conceptMapProviders.push(providerSet.conceptMapProvider);
        providerSet.cmRegistered = true;
      }
    }
  }

  async loadInternal(details, isDefault, mode) {
    if (isDefault) {
      throw new Error("Default is not supported for internal code system providers");
    }
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    switch (details) {
      case "country" : {
        const cc = new CountryCodeFactoryProvider(this.i18n);
        await cc.load();
        this.registerProvider('internal', cc);
        break;
      }
      case "lang" : {
        const langs = new IETFLanguageCodeFactory(this.i18n);
        await langs.load();
        this.registerProvider('internal', langs);
        break;
      }
      case "currency" : {
        const curr = new Iso4217FactoryProvider(this.i18n);
        await curr.load();
        this.registerProvider('internal', curr);
        break;
      }
      case "areacode" : {
        const ac = new AreaCodeFactoryProvider(this.i18n);
        await ac.load();
        this.registerProvider('internal', ac);
        break;
      }
      case "mimetypes" : {
        const mime = new MimeTypeServicesFactory(this.i18n, this.cacheFolder, this.log);
        await mime.load();
        this.registerProvider('internal', mime);
        break;
      }
      case "usstates" : {
        const uss = new USStateFactoryProvider(this.i18n);
        await uss.load();
        this.registerProvider('internal', uss);
        break;
      }
      case "hgvs" : {
        const hgvs = new HGVSServicesFactory(this.i18n);
        await hgvs.load();
        this.registerProvider('internal', hgvs);
        break;
      }
      case "urls" : {
        const urls = new UriServicesFactory(this.i18n);
        await urls.load();
        this.registerProvider('internal', urls);
        break;
      }
      case "vsac" : {
        if (!this.vsacCfg || !this.vsacCfg.apiKey) {
          throw new Error("Unable to load VSAC provider unless vsacCfg is provided in the configuration");
        }
        let vsac = new VSACValueSetProvider(this.vsacCfg, this.stats);
        // Intentionally not awaited: initialize() might run a full VSAC sync on first load,
        // which can take minutes - we don't want to block startup. But attach a handler
        // so a failed background sync surfaces as a log error rather than an unhandled
        // promise rejection.
        vsac.initialize().catch((err) => this.log.error(`VSAC initialization failed: ${err.message}`));
        this.valueSetProviders.push(vsac);
        this.externalSources.push(vsac);
        //const mem = process.memoryUsage();
        let time = Math.floor(Date.now() - this.lastTime).toString().padStart(5)+" ";
        let system = "vsac".padEnd(50);
        let version = "n/a".padEnd(62);
        this.log.info(`${time}${system}${version}${vsac.baseUrl}`);
        this.lastTime = Date.now();
        break;
      }
      default:
        throw new Error("Unknown Internal Provider "+details);
    }
  }

  async loadUcum(details, isDefault, mode) {
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const source = path.join(__dirname, '..', details);

    const ucumEssenceXml = readFileSync(source, 'utf8');
    const ucumService = new UcumService();
    await ucumService.init(ucumEssenceXml);

    const ucum = new UcumCodeSystemFactory(this.i18n, ucumService);
    await ucum.load();
    this.registerProvider(source, ucum, isDefault);
  }

  async loadLoinc(details, isDefault, mode) {
    const loincFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }

    const loinc = new LoincServicesFactory(this.i18n, loincFN);
    await loinc.load();
    this.registerProvider(loincFN, loinc, isDefault);
  }

  async loadRxnorm(details, isDefault, mode) {
    const rxNormFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const rxn = new RxNormServicesFactory(this.i18n, rxNormFN);
    await rxn.load();
    this.registerProvider(rxNormFN, rxn, isDefault);
  }

  async loadNdc(details, isDefault, mode) {
    const ndcFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const ndc = new NdcServicesFactory(this.i18n, ndcFN);
    await ndc.load();
    this.registerProvider(ndcFN, ndc, isDefault);
  }

  async loadUnii(details, isDefault, mode) {
    const uniFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const unii = new UniiServicesFactory(this.i18n, uniFN);
    await unii.load();
    this.registerProvider(uniFN, unii, isDefault);
  }

  async loadSnomed(details, isDefault, mode) {
    const sctFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const sct = new SnomedServicesFactory(this.i18n, sctFN);
    await sct.load();
    this.registerProvider(sctFN, sct, isDefault);
  }

  async loadCpt(details, isDefault, mode) {
    const cptFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const cpt = new CPTServicesFactory(this.i18n, cptFN);
    await cpt.load();
    this.registerProvider(cptFN, cpt, isDefault);
  }

  async loadOmop(details, isDefault, mode) {
    const omopFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const omop = new OMOPServicesFactory(this.i18n, omopFN);
    await omop.load();
    this.registerProvider(omopFN, omop, isDefault);
  }

  /**
   * ICD-11 is three code systems in one database - the MMS and ICF linearizations and the
   * Foundation - so one source line registers a factory per system that the database
   * actually contains. registerProvider is keyed on system(), so they cannot share one.
   */
  async loadIcd11(details, isDefault, mode) {
    const icdFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    for (const sys of await ICD11ServicesFactory.listSystems(icdFN)) {
      const factory = new ICD11ServicesFactory(this.i18n, icdFN, sys.code);
      await factory.load();
      this.registerProvider(icdFN, factory, isDefault);
    }
  }

  /**
   * Returns true if the given url/version should be excluded from npm/url package loading.
   * Matches against the ignored list using either plain url or url#version.
   */
  #isIgnored(url, version) {
    if (this.ignored.size === 0) return false;
    if (this.ignored.has(url)) return true;
    if (version && this.ignored.has(`${url}#${version}`)) return true;
    return false;
  }

  async loadNpm(packageManager, details, isDefault, mode, csOnly) {
    // Parse packageId and version from details (e.g., "hl7.terminology.r4#6.0.2")
    let packageId = details;
    let version = null;
    if (details.includes('#')) {
      const parts = details.split('#');
      packageId = parts[0];
      version = parts[1];
    }
    const packagePath = await packageManager.fetch(packageId, version);
    await this.#loadPackageFromPath(packagePath, mode, csOnly);
  }

  async loadUrl(packageManager, url, isDefault, mode, csOnly) {
    const packagePath = await packageManager.fetchUrl(url);
    await this.#loadPackageFromPath(packagePath, mode, csOnly);
  }

  /**
   * Shared loader for npm- and url-sourced packages. Given a fetched package
   * path, loads its CodeSystems (and, unless csOnly, its ValueSets and
   * ConceptMaps) into this library. Factored out of loadNpm/loadUrl so the two
   * cannot drift apart (a past divergence here used Map-style .set() on the
   * array-backed codeSystems list, breaking url sources).
   * @private
   */
  async #loadPackageFromPath(packagePath, mode, csOnly) {
    if (mode === "fetch" || mode === "cs") {
      return;
    }
    const fullPackagePath = path.join(this.cacheFolder, packagePath);
    const contentLoader = new PackageContentLoader(fullPackagePath);
    await contentLoader.initialize();

    this.packageSources.push(contentLoader.id()+"#"+contentLoader.version());

    let cp = new ListCodeSystemProvider();
    const resources = await contentLoader.getResourcesByType("CodeSystem");
    let csc = 0;
    for (const resource of resources) {
      let cs;
      try {
        cs = new CodeSystem(await contentLoader.loadFile(resource, contentLoader.fhirVersion()));
      } catch (e) {
        // one unacceptable resource (e.g. contained resources the server doesn't support)
        // must not stop the rest of the package loading
        this.log.warn(`Package ${contentLoader.pid()}: skipping CodeSystem ${resource.id || resource.filename || ''}: ${e.message}`);
        continue;
      }
      if (this.#isIgnored(cs.url, cs.version)) {
        this.log.info(`Ignoring CodeSystem ${cs.url}${cs.version ? '#' + cs.version : ''} (excluded by config)`);
        continue;
      }
      cs.sourcePackage = contentLoader.pid();
      cp.codeSystems.push(cs);
      csc++;
    }
    this.codeSystemProviders.push(cp);
    let vs = null;
    if (!csOnly) {
      vs = new PackageValueSetProvider(contentLoader);
      await vs.initialize();
      this.valueSetProviders.push(vs);
      const cm = new PackageConceptMapProvider(contentLoader);
      await cm.initialize();
      this.conceptMapProviders.push(cm);
    }

    this.#logPackage(contentLoader.id(), contentLoader.version(), csc, vs ? vs.valueSetMap.size : 0);
  }

  /**
   * Loads CodeSystem / ValueSet / ConceptMap resources from any *.json file in a folder.
   * The folder is scanned (top level only); each JSON file is read and routed to the
   * appropriate provider based on its resourceType. Files that fail to parse or whose
   * resourceType isn't one of the three terminology types are silently skipped.
   *
   * Relative paths are resolved against the project root (same convention as loadUcum etc.).
   *
   * @param {string} details - The folder to scan
   * @param {boolean} isDefault - Unused; folder sources don't register factories
   * @param {string} mode - One of "fetch", "cs", "npm"
   */
  // eslint-disable-next-line no-unused-vars
  async loadFolder(details, isDefault, mode) {
    if (mode === "fetch" || mode === "cs") {
      return;
    }

    const folderPath = this.#resolveLocalSourcePath(details);
    const cacheSubdir = await this.#prepareLocalSourceCache(folderPath);
    await this.#loadLocalSource(new FolderContentLoader(folderPath, cacheSubdir));
  }

  /**
   * Loads a single nominated JSON file holding a CodeSystem, ValueSet or ConceptMap
   * (source syntax: `file:<path>`). The resource is routed to the appropriate provider
   * based on its resourceType.
   *
   * Unlike a folder source, the file must exist and must be one of the three terminology
   * resource types - anything else is an error, since the config named it explicitly.
   *
   * Relative paths are resolved against the project root (same convention as loadUcum etc.).
   *
   * @param {string} details - The file to load
   * @param {boolean} isDefault - Unused; file sources don't register factories
   * @param {string} mode - One of "fetch", "cs", "npm"
   */
  // eslint-disable-next-line no-unused-vars
  async loadFile(details, isDefault, mode) {
    if (mode === "fetch" || mode === "cs") {
      return;
    }

    const filePath = this.#resolveLocalSourcePath(details);
    const cacheSubdir = await this.#prepareLocalSourceCache(filePath);
    await this.#loadLocalSource(new FileContentLoader(filePath, cacheSubdir));
  }

  /**
   * Relative paths in folder:/file: sources are resolved against the project root.
   * @private
   */
  #resolveLocalSourcePath(details) {
    const text = String(details || '').trim();
    if (!text) {
      throw new Error('A local source requires a path, e.g. file:tx/data/my-valueset.json');
    }
    return path.isAbsolute(text) ? text : path.resolve(path.join(__dirname, '..', text));
  }

  /**
   * Parks the Package*Provider SQLite caches under the terminology cache rather
   * than polluting the user's source folder, and wipes between runs so edits to
   * the source are reliably picked up.
   * @private
   */
  async #prepareLocalSourceCache(sourcePath) {
    const hash = crypto.createHash('sha1').update(sourcePath).digest('hex').substring(0, 16);
    const cacheSubdir = path.join(this.cacheFolder, 'folder-source-' + hash);
    await fs.rm(cacheSubdir, { recursive: true, force: true });
    await fs.mkdir(cacheSubdir, { recursive: true });
    return cacheSubdir;
  }

  /**
   * Shared loader for folder- and file-sourced content: registers the loader's
   * CodeSystems, ValueSets and ConceptMaps with this library.
   * @private
   */
  async #loadLocalSource(contentLoader) {
    await contentLoader.initialize();

    this.packageSources.push(contentLoader.id() + "#" + contentLoader.version());

    const cp = new ListCodeSystemProvider();
    const csEntries = await contentLoader.getResourcesByType("CodeSystem");
    let csc = 0;
    for (const entry of csEntries) {
      let cs;
      try {
        cs = new CodeSystem(await contentLoader.loadFile(entry, contentLoader.fhirVersion()));
      } catch (e) {
        // one unacceptable resource must not stop the rest of the package loading
        this.log.warn(`Package ${contentLoader.pid()}: skipping CodeSystem ${entry.id || entry.filename || ''}: ${e.message}`);
        continue;
      }
      if (this.#isIgnored(cs.url, cs.version)) {
        this.log.info(`Ignoring CodeSystem ${cs.url}${cs.version ? '#' + cs.version : ''} (excluded by config)`);
        continue;
      }
      cs.sourcePackage = contentLoader.pid();
      cp.codeSystems.push(cs);
      csc++;
    }
    this.codeSystemProviders.push(cp);

    const vs = new PackageValueSetProvider(contentLoader);
    await vs.initialize();
    this.valueSetProviders.push(vs);
    const cm = new PackageConceptMapProvider(contentLoader);
    await cm.initialize();
    this.conceptMapProviders.push(cm);

    this.#logPackage(contentLoader.id(), contentLoader.version(), csc, vs.valueSetMap.size);
  }

  /**
   * Gets a file from local folder or downloads it from URL
   * @param {string} fileName - Name of the file
   * @returns {Promise<string>} Full path to the file
   * @throws {Error} If file cannot be downloaded or accessed
   */
  async getOrDownloadFile(fileName) {
    // Ensure folder exists
    await this.ensureFolderExists(this.cacheFolder);

    if (fileName.includes("|")) {
      // in this case, we split it into two. if the first file exists, we go with that. Otherwise
      // fallback to the second.
      let firstName = fileName.substring(0, fileName.indexOf("|"));
      fileName = fileName.substring(fileName.indexOf("|")+1);

      const firstPath = path.join(this.cacheFolder, firstName);
      if (await this.fileExists(firstPath)) {
        return firstPath;
      }
    }
    const filePath = path.join(this.cacheFolder, fileName);

    // Check if file already exists
    if (await this.fileExists(filePath)) {
      return filePath;
    }

    // File doesn't exist, download it
    this.log.info(`Downloading: ${fileName}`);

    const downloadUrl = this.baseUrl.endsWith('/') ? this.baseUrl + fileName : this.baseUrl + '/' + fileName;

    try {
      await this.downloadFile(downloadUrl, filePath);
      return filePath;
    } catch (error) {
      throw new Error(`Failed to download file ${fileName} from ${downloadUrl}: ${error.message}`);
    }
  }

  /**
   * Check if a file exists
   * @param {string} filePath - Path to check
   * @returns {Promise<boolean>} True if file exists
   */
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensure a folder exists, create it if it doesn't
   * @param {string} folderPath - Path to folder
   */
  async ensureFolderExists(folderPath) {
    try {
      await fs.mkdir(folderPath, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new Error(`Failed to create folder ${folderPath}: ${error.message}`);
      }
    }
  }

  /**
   * Download a file from URL to local path
   * @param {string} url - URL to download from
   * @param {string} filePath - Local path to save file
   * @returns {Promise<void>}
   */
  async downloadFile(url, filePath) {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https:') ? https : http;

      const request = protocol.get(url, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return this.downloadFile(response.headers.location, filePath)
            .then(resolve)
            .catch(reject);
        }

        // Check for successful response
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
          return;
        }

        // Create write stream
        const fileStream = require('fs').createWriteStream(filePath);

        // Handle stream errors
        fileStream.on('error', (error) => {
          reject(new Error(`Failed to write file: ${error.message}`));
        });

        // Handle download completion
        fileStream.on('finish', () => {
          fileStream.close();
          const statsFs = require('fs').statSync(filePath);
          this.totalDownloaded = this.totalDownloaded + statsFs.size;
          resolve();
        });

        // Pipe response to file
        response.pipe(fileStream);

      }).on('error', (error) => {
        reject(new Error(`Download request failed: ${error.message}`));
      });

      // Set timeout for request
      request.setTimeout(30000, () => {
        request.destroy();
        reject(new Error('Download timeout (30 seconds)'));
      });
    });
  }

  /**
   * Creates a provider for the specified version , and context.
   *
   * @param {string} fhirVersion - FHIR version (e.g., '4.0.1', '5.0.0')
   * @param {string} context - other information from the client that sets the context
   * @returns {Promise<Provider>} New provider instance with FHIR packages loaded
   */
  async cloneWithFhirVersion(fhirVersion, context, path) {
    // Create new provider instance
    const provider = new Provider();
    provider.i18n = this.i18n;
    provider.codeSystemFactories = new Map(this.codeSystemFactories); // all of them
    provider.codeSystems = new Map();
    provider.valueSetProviders = [];
    provider.conceptMapProviders = [];
    provider.path = path;
    if (VersionUtilities.isR5Ver(fhirVersion)) {
      provider.fhirVersion = 5;
    } else if (VersionUtilities.isR4Ver(fhirVersion)) {
      provider.fhirVersion = 4;
    } else if (VersionUtilities.isR3Ver(fhirVersion)) {
      provider.fhirVersion = 3;
    } else {
      provider.fhirVersion = 6;
    }



    // Load FHIR core packages first
    const fhirPackages = this.#getFhirPackagesForVersion(fhirVersion);

    this.log.info(`Loading FHIR ${fhirVersion} packages`);
    this.#logPackagesHeader();

    // Load FHIR packages - these will be added to valueSetProviders first
    for (const packageId of fhirPackages) {
      await provider.loadNpm(this.packageManager, this.cacheFolder, packageId, false, "npm", false);
    }


    provider.codeSystemProviders = this.codeSystemProviders;
    provider.context = context;
    for (const cp of this.codeSystemProviders) {
      const csList = await cp.listCodeSystems(fhirVersion, context);
      for (const cs of csList) {
        provider.addCodeSystem(cs);
      }
    }
    // Don't clone valueSetProviders yet - we'll build it with correct order

    // Copy other properties
    provider.baseUrl = this.baseUrl;
    provider.cacheFolder = this.cacheFolder;
    provider.startTime = this.startTime;
    provider.startMemory = this.startMemory;
    provider.lastTime = this.lastTime;
    provider.lastMemory = this.lastMemory;
    provider.totalDownloaded = this.totalDownloaded;
    provider.packageSources = this.packageSources;
    provider.externalSources = this.externalSources;


    // Now add the existing value set providers after the FHIR core packages
    provider.valueSetProviders.push(...this.valueSetProviders);
    provider.conceptMapProviders.push(...this.conceptMapProviders);

    // bind UCUM common value set
    let ucum = provider.codeSystemFactories.get("http://unitsofmeasure.org");
    let vs = await provider.findValueSet(null, "http://hl7.org/fhir/ValueSet/ucum-common", null);
    if (ucum && vs) {
      ucum.processCommonUnits(vs);
    }
    return provider;
  }

  /**
   * Gets the list of FHIR packages for a specific version
   * @param {string} fhirVersion - FHIR version
   * @returns {string} Package Id
   * @private
   */
  #getFhirPackagesForVersion(ver) {
    if (VersionUtilities.isR3Ver(ver)) {
      return ["hl7.fhir.r3.core"];
    }
    if (VersionUtilities.isR4Ver(ver) ||VersionUtilities.isR4BVer(ver)) {
      return ["hl7.fhir.r4.core"];
    }
    if (VersionUtilities.isR5Ver(ver)) {
      return ["hl7.fhir.r5.core"];
    }
    throw new Error(`Unsupported FHIR version: ${ver}. Supported versions: R3, R4, R5`);
  }

  /**
   * all the loaded resources must have unique IDs for the get operation
   * they must be assigned by the library on loading. providers can either assign
   * ids from the global space at start up, or, if they can provide new resources
   * later in an ongoing fashion, allocate them in their own space
   */
  assignIds() {
    let ids = new Set();
    // these don't have ids - not available directly for (const cs of this.codeSystemFactories) { .. }
    let i = 0;
    for (const cp of this.codeSystemProviders) {
      cp.spaceId = String(++i);
      cp.assignIds(ids);
    }
    i = 0;
    for (const vp of this.valueSetProviders) {
      vp.spaceId = String(++i);
      vp.assignIds(ids);
    }
    i = 0;
    for (const cmp of this.conceptMapProviders) {
      cmp.spaceId = String(++i);
      cmp.assignIds(ids);
    }

  }

  async close() {
    for (let csp of this.codeSystemProviders) {
      csp.close();
    }
    for (let csp of this.codeSystemFactories.values()) {
      csp.close();
    }
    for (let vsp of this.valueSetProviders) {
      vsp.close();
    }
    for (let cmp of this.conceptMapProviders) {
      cmp.close();
    }
  }

}

module.exports = { Library };