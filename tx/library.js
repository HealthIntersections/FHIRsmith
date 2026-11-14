const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const yaml = require('yaml'); // npm install yaml
const { PackageManager, PackageContentLoader } = require('../library/package-manager');
const { FolderContentLoader, FileContentLoader } = require('../library/folder-content-loader');
const { CodeSystem } = require("./library/codesystem");
const { assertNoActiveContent } = require('../library/narrative-check');
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
const {SnomedFileReader} = require("./sct/structures");
const {SnomedLoadConfig} = require("./sct/load-config");
const {CPTServicesFactory} = require("./cs/cs-cpt");
const {OMOPServicesFactory} = require("./cs/cs-omop");
const {ICD11ServicesFactory} = require("./cs/cs-icd11");
const {PackageValueSetProvider} = require("./vs/vs-package");
const {PackageConceptMapProvider} = require("./cm/cm-package");
const {IETFLanguageCodeFactory} = require("./cs/cs-lang");
const {LanguageDefinitions} = require("../library/languages");
const {VersionUtilities} = require("../library/version-utilities");
const {ListCodeSystemProvider} = require("./cs/cs-provider-list");
const { Provider, CodeSystemMap } = require("./provider");
const {I18nSupport} = require("../library/i18nsupport");
const folders = require('../library/folder-setup');
const memoryGuard = require('../library/memory-guard');
const {VSACValueSetProvider} = require("./vs/vs-vsac");
const { OCLCodeSystemProvider, OCLSourceCodeSystemFactory } = require('./ocl/cs-ocl');
const { OCLValueSetProvider } = require('./ocl/vs-ocl');
const { OCLConceptMapProvider } = require('./ocl/cm-ocl');
const {UriServicesFactory} = require("./cs/cs-uri");
const {debugLog} = require("./operation-context");
const { checkIdPrefix } = require("./library/resource-ids");

// folder:/file: sources keep their SQLite caches in <terminology-cache>/folder-source-<hash>
const LOCAL_SOURCE_CACHE_PREFIX = 'folder-source-';
// how long an unused folder-source-* cache is kept, in case another Library is using it
const LOCAL_SOURCE_CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
// an unused .db or .cache file or package folder changed more recently than this isn't pruned
// (see pruneUnusedCaches)
const PRUNE_MIN_AGE = 24 * 60 * 60 * 1000;

/**
 * The bytes in the files under a folder
 * @param {string} dir
 * @returns {Promise<number>}
 */
async function folderSize(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await folderSize(p);
    } else if (entry.isFile()) {
      total += (await fs.stat(p)).size;
    }
  }
  return total;
}

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

  /**
   * {Map<Object, string>} the id prefix the library YAML gives for the source a provider was
   * loaded from (npm:hl7.terminology=tho), by provider
   */
  #sourcePrefixes = new Map();

  /**
   * {Set<string>} every id prefix the library YAML gives - autonumbered prefixes skip them
   */
  #givenPrefixes = new Set();

  /**
   * {Set<string>} the folder-source-* cache folders this load used - the rest are pruned
   * once they're stale (see #pruneLocalSourceCaches)
   */
  #localSourceCaches = new Set();

  /**
   * {Set<string>} the names of the files in the cache folder that this load used (see
   * getOrDownloadFile) - with pruneTerminologyCache, the other .db and .cache files there are
   * deleted once the library has loaded (see pruneTerminologyCache)
   */
  #usedCacheFiles = new Set();

  /**
   * {boolean} once the library and the endpoints' core packages are loaded, delete the .db and
   * .cache files and the package folders in the cache folder that weren't used (the tx module's
   * pruneTerminologyCache setting; see pruneUnusedCaches). Off by default: the cache folder is
   * shared by everything that runs from the same data directory - a development server and the
   * tests, say - and what one doesn't use, another may
   */
  pruneTerminologyCacheFiles = false;

  baseUrl = null;
  cacheFolder = null;
  startTime = Date.now();
  startMemory = process.memoryUsage();
  lastTime = null;
  totalDownloaded = 0;
  vsacCfg = undefined;
  /**
   * {string|null} with several processes on one data directory (cluster.md), a name every
   * process in the cluster shares (the master's role): the folder-source-* caches are the
   * master's, named folder-source-<tag>-<hash>. The master builds each in a temporary sibling
   * and renames it into place, so a worker never sees one half built; a worker
   * (packageCachesReadOnly) only reads them, waiting for the master as for package caches,
   * and never prunes
   */
  localSourceTag = null;

  /**
   * {boolean} a tx-worker (cluster.md): the package value set and concept map caches are the
   * master's. This process opens them read-only, waits for the master to have finished one,
   * and never builds, rebuilds or migrates one
   */
  packageCachesReadOnly = false;

  /**
   * {boolean} a tx-worker (cluster.md): the cached IANA media types registry is the master's.
   * This process reads it and never downloads or writes it
   */
  mimeTypesReadOnly = false;

  /**
   * {boolean} a tx-worker (cluster.md): the LOINC, RxNorm, NDC, UNII, CPT and OMOP databases
   * are the master's, which sets them up (LOINC's journal mode, the LOINC and RxNorm indexes)
   * before the workers start. This process opens them read-only
   */
  terminologyDatabasesReadOnly = false;

  /**
   * {SyndicationStore|null} where the content this library loads is recorded for the
   * syndication feed, when the server has one (see tx/syndication)
   */
  syndication = null;

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

  /**
   * @param {string} configFile - the library yml
   * @param {object} vsacCfg
   * @param {object} log
   * @param {object} stats
   * @param {object} [snomedCfg] - the tx module's "snomed" block: how SNOMED CT cache files are
   *   loaded (see tx/sct/load-config.js)
   */
  constructor(configFile, vsacCfg, log, stats, snomedCfg = undefined) {
    this.configFile = configFile;
    this.vsacCfg = vsacCfg;
    this.log = log;
    this.stats = stats;
    this.snomedLoad = new SnomedLoadConfig(snomedCfg, (msg) => (this.log ? this.log.warn(msg) : console.warn(msg)));

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

    this.#checkSourcePrefixes(config.sources);

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
    this.snomedLoad.checkUnused();
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

    if (!this.packageCachesReadOnly) {
      // the master, or no role: a worker leaves the master's caches alone
      await this.#pruneLocalSourceCaches();
    }

    this.log.info(`Loading Time: ${(totalTime / 1000).toLocaleString()}s`);
    this.log.info(`Memory Used: ${(memoryIncrease.rss / 1024 / 1024).toFixed(2)} MB`);

    this.assignIds();
  }

  /**
   * Parse a source entry from the library YAML: type[!]:details[=prefix]
   *
   * @param {string} source
   * @returns {{type: string, details: string, isDefault: boolean, prefix: string|null}}
   */
  #parseSource(source) {
    const colonIndex = source.indexOf(':');
    if (colonIndex === -1) {
      throw new Error(`Invalid source format: ${source}`);
    }

    let type = source.substring(0, colonIndex);
    let details = source.substring(colonIndex + 1);

    // Handle special markers (like ! for default)
    let isDefault = false;
    if (type.endsWith('!')) {
      type = type.slice(0, -1);
      isDefault = true;
    }

    // the id prefix for the resources the source provides: everything after the last '='
    let prefix = null;
    const eqIndex = details.lastIndexOf('=');
    if (eqIndex > -1) {
      prefix = details.substring(eqIndex + 1);
      details = details.substring(0, eqIndex);
      const problem = checkIdPrefix(prefix);
      if (problem) {
        throw new Error(`Invalid source '${source}': ${problem}`);
      }
    }
    return { type, details, isDefault, prefix };
  }

  /**
   * Check the id prefixes the library YAML gives before anything is loaded - each id space
   * must belong to one source
   *
   * @param {string[]} sources
   */
  #checkSourcePrefixes(sources) {
    const seen = new Map();
    for (const source of sources) {
      const { prefix } = this.#parseSource(source);
      if (prefix) {
        if (seen.has(prefix)) {
          throw new Error(`The id prefix '${prefix}' is given for both '${seen.get(prefix)}' and '${source}'`);
        }
        seen.set(prefix, source);
      }
    }
  }

  async processSource(source, packageManager, mode) {
    const { type, details, isDefault, prefix } = this.#parseSource(source);

    // the providers this source adds, so they can be given its id prefix
    const csCount = this.codeSystemProviders.length;
    const vsCount = this.valueSetProviders.length;
    const cmCount = this.conceptMapProviders.length;

    await this.#loadSource(type, details, isDefault, mode, packageManager);

    if (prefix) {
      this.#givenPrefixes.add(prefix);
      for (const provider of [...this.codeSystemProviders.slice(csCount),
        ...this.valueSetProviders.slice(vsCount), ...this.conceptMapProviders.slice(cmCount)]) {
        this.#sourcePrefixes.set(provider, prefix);
      }
    }
  }

  async #loadSource(type, details, isDefault, mode, packageManager) {
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
        const mime = new MimeTypeServicesFactory(this.i18n, this.cacheFolder, this.log, { readOnly: this.mimeTypesReadOnly });
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

    const loinc = new LoincServicesFactory(this.i18n, loincFN, { readOnly: this.terminologyDatabasesReadOnly });
    await loinc.load();
    this.registerProvider(loincFN, loinc, isDefault);
    this.#syndicateBinary('loinc', loincFN, loinc);
  }

  async loadRxnorm(details, isDefault, mode) {
    const rxNormFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const rxn = new RxNormServicesFactory(this.i18n, rxNormFN, { readOnly: this.terminologyDatabasesReadOnly });
    await rxn.load();
    this.registerProvider(rxNormFN, rxn, isDefault);
    this.#syndicateBinary('rxnorm', rxNormFN, rxn);
  }

  async loadNdc(details, isDefault, mode) {
    const ndcFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const ndc = new NdcServicesFactory(this.i18n, ndcFN, { readOnly: this.terminologyDatabasesReadOnly });
    await ndc.load();
    this.registerProvider(ndcFN, ndc, isDefault);
    this.#syndicateBinary('ndc', ndcFN, ndc);
  }

  async loadUnii(details, isDefault, mode) {
    const uniFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const unii = new UniiServicesFactory(this.i18n, uniFN, { readOnly: this.terminologyDatabasesReadOnly });
    await unii.load();
    this.registerProvider(uniFN, unii, isDefault);
    this.#syndicateBinary('unii', uniFN, unii);
  }

  async loadSnomed(details, isDefault, mode) {
    const sctFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const loadMode = this.snomedLoad.modeFor(sctFN, SnomedFileReader.versionUri(sctFN));
    const sct = new SnomedServicesFactory(this.i18n, sctFN, loadMode, this.log);
    await sct.load();
    if (loadMode !== 'read') {
      // if it could not be mapped, mapFile has already said why, through this.log
      this.log.info(`SNOMED CT ${path.basename(sctFN)}: load ${loadMode}, ` +
        (sct.mapped ? 'memory-mapped' : 'not mapped, read into memory'));
    }
    if (sct.mapped && !memoryGuard._state.excludeFileBacked) {
      memoryGuard.measureExcludingFileBacked();
      this.log.info(`SNOMED CT cache files are memory-mapped. ${memoryGuard.describe()}`);
    }
    this.registerProvider(sctFN, sct, isDefault);
    this.#syndicateBinary('snomed', sctFN, sct);
  }

  async loadCpt(details, isDefault, mode) {
    const cptFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const cpt = new CPTServicesFactory(this.i18n, cptFN, { readOnly: this.terminologyDatabasesReadOnly });
    await cpt.load();
    this.registerProvider(cptFN, cpt, isDefault);
    // the store syndicates the public fragment only, never the full (licensed) database
    this.#syndicateBinary('cpt', cptFN, cpt);
  }

  async loadOmop(details, isDefault, mode) {
    const omopFN = await this.getOrDownloadFile(details);
    if (mode === "fetch" || mode === "npm") {
      return;
    }
    const omop = new OMOPServicesFactory(this.i18n, omopFN, { readOnly: this.terminologyDatabasesReadOnly });
    await omop.load();
    this.registerProvider(omopFN, omop, isDefault);
    this.#syndicateBinary('omop', omopFN, omop);
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
    // one file, so one syndication entry - identified by the MMS, if the file has it
    let main = null;
    for (const sys of await ICD11ServicesFactory.listSystems(icdFN)) {
      const factory = new ICD11ServicesFactory(this.i18n, icdFN, sys.code);
      await factory.load();
      this.registerProvider(icdFN, factory, isDefault);
      if (!main || sys.code === 'mms') {
        main = factory;
      }
    }
    if (main) {
      this.#syndicateBinary('icd11', icdFN, main);
    }
  }

  /**
   * Records a binary source file (SNOMED cache, LOINC database etc) in the syndication store,
   * if there is one. The store works in the background, and decides itself whether the file
   * is one it syndicates; nothing it does can stop the library loading.
   * @private
   */
  #syndicateBinary(sourceType, filePath, factory) {
    if (!this.syndication) {
      return;
    }
    try {
      let name = null;
      try {
        name = factory.name();
      } catch (e) {
        // not every factory has a name
      }
      void this.syndication.inductBinary({
        sourceType, filePath, baseUrl: this.baseUrl, system: factory.system(), version: factory.version(), name
      });
    } catch (error) {
      this.log.warn(`Syndication: unable to record ${filePath}: ${error.message}`);
    }
  }

  /**
   * Records a package in the syndication store, if there is one.
   * @param {PackageContentLoader} contentLoader - the loaded package
   * @param {Object} source - {requestedVersion} for an npm: source, {url} for a url: source,
   *   {fhirVersion} (major.minor) for an endpoint's core package
   */
  syndicatePackage(contentLoader, source = {}) {
    if (!this.syndication || !contentLoader || !contentLoader.package) {
      return;
    }
    const pkg = contentLoader.package;
    void this.syndication.inductPackage({
      id: contentLoader.id(),
      version: contentLoader.version(),
      canonical: pkg.canonical,
      title: pkg.title,
      description: pkg.description,
      url: source.url,
      fhirVersion: source.fhirVersion,
      requestedVersion: source.requestedVersion
    });
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
    await this.#loadPackageFromPath(packagePath, mode, csOnly, { requestedVersion: version });
  }

  async loadUrl(packageManager, url, isDefault, mode, csOnly) {
    const packagePath = await packageManager.fetchUrl(url);
    await this.#loadPackageFromPath(packagePath, mode, csOnly, { url });
  }

  /**
   * Shared loader for npm- and url-sourced packages. Given a fetched package
   * path, loads its CodeSystems (and, unless csOnly, its ValueSets and
   * ConceptMaps) into this library. Factored out of loadNpm/loadUrl so the two
   * cannot drift apart (a past divergence here used Map-style .set() on the
   * array-backed codeSystems list, breaking url sources).
   * @private
   */
  async #loadPackageFromPath(packagePath, mode, csOnly, source) {
    if (mode === "fetch" || mode === "cs") {
      return;
    }
    const fullPackagePath = path.join(this.cacheFolder, packagePath);
    const contentLoader = new PackageContentLoader(fullPackagePath);
    await contentLoader.initialize();
    this.syndicatePackage(contentLoader, source);

    this.packageSources.push(contentLoader.id()+"#"+contentLoader.version());

    let cp = new ListCodeSystemProvider();
    const resources = await contentLoader.getResourcesByType("CodeSystem");
    let csc = 0;
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
      vs = new PackageValueSetProvider(contentLoader, { readOnly: this.packageCachesReadOnly });
      await vs.initialize();
      this.valueSetProviders.push(vs);
      const cm = new PackageConceptMapProvider(contentLoader, { readOnly: this.packageCachesReadOnly });
      await cm.initialize();
      this.conceptMapProviders.push(cm);
    }

    this.#logPackage(contentLoader.id(), contentLoader.version(), csc, vs ? vs.vsCount() : 0);
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
    const cacheSubdir = await this.#prepareLocalSourceCache(folderPath, dir => new FolderContentLoader(folderPath, dir));
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
    const cacheSubdir = await this.#prepareLocalSourceCache(filePath, dir => new FileContentLoader(filePath, dir));
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
   *
   * In a cluster (localSourceTag set) every process uses the master's folder:
   * - a worker (packageCachesReadOnly) touches nothing; its providers open the caches
   *   read-only, waiting for the master to have built them
   * - the master builds the caches in a temporary sibling, then renames it into place, so a
   *   running worker never finds the folder half built
   *
   * @param {string} sourcePath
   * @param {function(string): FolderContentLoader} makeLoader - a loader with its caches in a folder
   * @returns {Promise<string>} the cache folder
   * @private
   */
  async #prepareLocalSourceCache(sourcePath, makeLoader) {
    const hash = crypto.createHash('sha1').update(sourcePath).digest('hex').substring(0, 16);
    const name = LOCAL_SOURCE_CACHE_PREFIX + (this.localSourceTag ? this.localSourceTag + '-' : '') + hash;
    const cacheSubdir = path.join(this.cacheFolder, name);
    this.#localSourceCaches.add(name);
    if (this.packageCachesReadOnly) {
      return cacheSubdir;
    }
    if (!this.localSourceTag) {
      await fs.rm(cacheSubdir, { recursive: true, force: true });
      await fs.mkdir(cacheSubdir, { recursive: true });
      return cacheSubdir;
    }
    const building = `${cacheSubdir}.building-${process.pid}`;
    const old = `${cacheSubdir}.old-${process.pid}`;
    await fs.rm(building, { recursive: true, force: true });
    await fs.rm(old, { recursive: true, force: true });
    await fs.mkdir(building, { recursive: true });
    const loader = makeLoader(building);
    await loader.initialize();
    const vs = new PackageValueSetProvider(loader);
    await vs.initialize();
    await vs.close();
    const cm = new PackageConceptMapProvider(loader);
    await cm.initialize();
    // a directory can't be renamed over a non-empty one: move the old one aside first. A
    // worker that looks in between finds no folder, and waits for it
    try {
      await fs.rename(cacheSubdir, old);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }
    await fs.rename(building, cacheSubdir);
    await fs.rm(old, { recursive: true, force: true });
    return cacheSubdir;
  }

  /**
   * Removes the folder-source-* caches left by sources that are no longer loaded (the
   * name is a hash of the source path, so a moved or temporary folder leaves one behind).
   *
   * The cache folder can be shared by more than one Library at a time (a server and the
   * tests, run from the same checkout), so a cache this load didn't use may be another
   * one's. Every load rebuilds its caches, so a live one is always recent - only those
   * untouched for LOCAL_SOURCE_CACHE_MAX_AGE are removed.
   * @private
   */
  async #pruneLocalSourceCaches() {
    let entries;
    try {
      entries = await fs.readdir(this.cacheFolder, { withFileTypes: true });
    } catch (e) {
      return;
    }
    const cutoff = Date.now() - LOCAL_SOURCE_CACHE_MAX_AGE;
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(LOCAL_SOURCE_CACHE_PREFIX) || this.#localSourceCaches.has(entry.name)) {
        continue;
      }
      const dir = path.join(this.cacheFolder, entry.name);
      try {
        const stat = await fs.stat(dir);
        if (stat.mtimeMs < cutoff) {
          await fs.rm(dir, { recursive: true, force: true });
          count++;
        }
      } catch (e) {
        this.log.warn(`Unable to remove stale local source cache ${dir}: ${e.message}`);
      }
    }
    if (count > 0) {
      this.log.info(`Removed ${count} stale local source cache folder${count === 1 ? '' : 's'}`);
    }
  }

  /**
   * With pruneTerminologyCacheFiles, and in a process that owns the caches (not a tx-worker):
   * delete what's in the cache folder that wasn't used - the .db and .cache files
   * (pruneTerminologyCache) and the package folders (prunePackages). Call it once everything is
   * loaded: the library (load) and every endpoint's core packages (cloneWithFhirVersion)
   * @returns {Promise<{files: string[], packages: string[]}>} what was deleted
   */
  async pruneUnusedCaches() {
    if (!this.pruneTerminologyCacheFiles || this.packageCachesReadOnly) {
      return { files: [], packages: [] };
    }
    return { files: await this.pruneTerminologyCache(), packages: await this.prunePackages() };
  }

  /**
   * Deletes the package folders (id#version) in the cache folder that the package manager
   * hasn't returned this run (see PackageManager.usedPackages): packages no longer in the
   * library, older versions of ones that are, the core packages of FHIR versions no endpoint
   * has any more, and what failed or interrupted downloads left behind. Their value set and
   * concept map caches are in them, so go with them. A folder changed in the last
   * PRUNE_MIN_AGE is kept.
   * @returns {Promise<string[]>} the names of the folders deleted
   */
  async prunePackages() {
    let entries;
    try {
      entries = await fs.readdir(this.cacheFolder, { withFileTypes: true });
    } catch (e) {
      return [];
    }
    const used = this.packageManager.usedPackages;
    const cutoff = Date.now() - PRUNE_MIN_AGE;
    const deleted = [];
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.includes('#') || used.has(entry.name)) {
        continue;
      }
      const dir = path.join(this.cacheFolder, entry.name);
      try {
        const stat = await fs.stat(dir);
        if (stat.mtimeMs >= cutoff) {
          this.log.info(`Not deleting unused package ${entry.name} yet: it changed in the last day`);
          continue;
        }
        const size = await folderSize(dir);
        await fs.rm(dir, { recursive: true, force: true });
        deleted.push(entry.name);
        bytes += size;
        this.log.info(`Deleted unused package ${entry.name} (${(size / 1024 / 1024).toFixed(1)} MB) from the terminology cache`);
      } catch (e) {
        this.log.warn(`Unable to delete unused package ${dir}: ${e.message}`);
      }
    }
    if (deleted.length > 0) {
      this.log.info(`Deleted ${deleted.length} unused package${deleted.length === 1 ? '' : 's'} from the terminology cache, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
    }
    return deleted;
  }

  /**
   * Deletes the .db and .cache files directly in the cache folder (terminology-cache) that this
   * load didn't use: the downloaded databases and SNOMED CT caches of sources that are no longer
   * in the library, and the fallback of an "a|b" source whose first file is there. Their SQLite
   * side files (-wal, -shm, -journal) go with them. Package folders, and the other folders and
   * files there, are left alone.
   *
   * A file changed in the last PRUNE_MIN_AGE is kept: it may be being copied in, or built,
   * for a library that doesn't name it yet.
   *
   * See pruneUnusedCaches, which calls it
   * @returns {Promise<string[]>} the names of the files deleted
   */
  async pruneTerminologyCache() {
    let entries;
    try {
      entries = await fs.readdir(this.cacheFolder, { withFileTypes: true });
    } catch (e) {
      return [];
    }
    const cutoff = Date.now() - PRUNE_MIN_AGE;
    const deleted = [];
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(db|cache)$/i.test(entry.name) || this.#usedCacheFiles.has(entry.name)) {
        continue;
      }
      const file = path.join(this.cacheFolder, entry.name);
      try {
        const stat = await fs.stat(file);
        if (stat.mtimeMs >= cutoff) {
          this.log.info(`Not deleting unused ${entry.name} yet: it changed in the last day`);
          continue;
        }
        await fs.rm(file, { force: true });
        for (const suffix of ['-wal', '-shm', '-journal']) {
          await fs.rm(file + suffix, { force: true });
        }
        deleted.push(entry.name);
        bytes += stat.size;
        this.log.info(`Deleted unused ${entry.name} (${(stat.size / 1024 / 1024).toFixed(1)} MB) from the terminology cache`);
      } catch (e) {
        this.log.warn(`Unable to delete unused ${file}: ${e.message}`);
      }
    }
    if (deleted.length > 0) {
      this.log.info(`Deleted ${deleted.length} unused file${deleted.length === 1 ? '' : 's'} from the terminology cache, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
    }
    return deleted;
  }

  /**
   * Shared loader for folder- and file-sourced content: registers the loader's
   * CodeSystems, ValueSets and ConceptMaps with this library.
   * @private
   */
  async #loadLocalSource(contentLoader) {
    await contentLoader.initialize();
    if (this.syndication) {
      // each resource is an entry in its own right (those without a version are skipped)
      for (const entry of contentLoader.index.files) {
        if (this.#isIgnored(entry.url, entry.version)) {
          continue;
        }
        let title = null;
        let description = null;
        try {
          const json = JSON.parse(await fs.readFile(path.join(contentLoader.sourceFolder, entry.filename), 'utf8'));
          title = json.title || json.name || null;
          description = typeof json.description === 'string' ? json.description : null;
        } catch (e) {
          // initialize() already read it; if it can't now, the store will say so
        }
        void this.syndication.inductResource({
          filePath: path.join(contentLoader.sourceFolder, entry.filename),
          resourceType: entry.resourceType, url: entry.url, version: entry.version, title, description
        });
      }
    }

    this.packageSources.push(contentLoader.id() + "#" + contentLoader.version());

    const cp = new ListCodeSystemProvider();
    const csEntries = await contentLoader.getResourcesByType("CodeSystem");
    let csc = 0;
    for (const entry of csEntries) {
      let cs;
      try {
        const json = await contentLoader.loadFile(entry, contentLoader.fhirVersion());
        // narrative is shown as-is in a page, so it must not carry script (see narrative-check.js)
        assertNoActiveContent(json);
        cs = new CodeSystem(json);
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

    const vs = new PackageValueSetProvider(contentLoader, { readOnly: this.packageCachesReadOnly });
    await vs.initialize();
    this.valueSetProviders.push(vs);
    const cm = new PackageConceptMapProvider(contentLoader, { readOnly: this.packageCachesReadOnly });
    await cm.initialize();
    this.conceptMapProviders.push(cm);

    this.#logPackage(contentLoader.id(), contentLoader.version(), csc, vs.vsCount());
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
        this.#usedCacheFiles.add(path.basename(firstPath));
        return firstPath;
      }
    }
    const filePath = path.join(this.cacheFolder, fileName);
    this.#usedCacheFiles.add(path.basename(filePath));

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
    provider.codeSystems = new CodeSystemMap();
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
      const contentLoader = await provider.loadNpm(this.packageManager, this.cacheFolder, packageId, false, "npm",
        { readOnly: this.packageCachesReadOnly });
      // the core packages are the only version specific content in the syndication store
      this.syndicatePackage(contentLoader, { fhirVersion: VersionUtilities.getMajMin(String(fhirVersion)) });
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
    await provider.applyTHOPrecedence();

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
   * Every loaded resource is served in the id space of the provider that loaded it: its id is
   * the provider's spaceId, '-', and the id it had in its source (see
   * tx/library/resource-ids.js). The spaceId is the prefix the library YAML gives for the
   * provider's source, or, if it gives none, a number - the next one, counting providers of
   * the same kind, that the YAML doesn't use as a prefix. Numbers depend on the order of the
   * sources, so a source whose ids should stay the same when the YAML changes needs a prefix.
   *
   * (Code system factories don't have ids - they are not available directly.)
   */
  assignIds() {
    for (const providers of [this.codeSystemProviders, this.valueSetProviders, this.conceptMapProviders]) {
      let n = 0;
      for (const provider of providers) {
        let spaceId = this.#sourcePrefixes.get(provider);
        if (!spaceId) {
          do {
            n++;
          } while (this.#givenPrefixes.has(String(n)));
          spaceId = String(n);
        }
        provider.assignIds(spaceId);
      }
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