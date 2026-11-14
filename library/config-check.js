/**
 * Checks a FHIRsmith configuration without starting anything: `node server.js --check` (or
 * -t, as nginx has it), and `node cluster.js --check`. Synchronous, and with no side effects:
 * no folder is made, nothing is logged to the log files, no database is opened, nothing is
 * fetched.
 *
 * What is checked:
 *  - config.json reads (JSON with comments: library/config-reader.js)
 *  - every setting is one FHIRsmith knows: an unknown one is a warning (a typo is otherwise
 *    silently ignored). Keys starting with "_" or "x-" are taken to be parked on purpose
 *  - settings that have been replaced are errors, naming the replacement
 *  - types, ranges and allowed values (ports, sizes, cron schedules, enums)
 *  - settings the server sets itself (e.g. modules.tx.clusterRole) are not in the file
 *  - for enabled modules: files the configuration names exist (the tx library yml, the SHL
 *    certificates, the publisher's GitHub App key), and the library yml parses and its
 *    sources are well formed, with unique id prefixes
 *  - the data folder exists and is writable (or can be made), and so is its logs folder
 *  - the environment: the Node.js version, and the native SQLite modules load
 *
 * Disabled modules are checked only for being an object: their settings aren't read.
 *
 * @module library/config-check
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------------------------
// the report

class Report {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.notes = [];
  }

  error(where, message) {
    this.errors.push({ where, message });
  }

  warn(where, message) {
    this.warnings.push({ where, message });
  }

  note(where, message) {
    this.notes.push({ where, message });
  }

  get ok() {
    return this.errors.length === 0;
  }

  /**
   * nginx -t style: one line a problem, then a verdict
   * @param {string} configPath
   * @returns {string}
   */
  format(configPath) {
    const line = (level, e) => `fhirsmith: [${level}] ${e.where ? e.where + ': ' : ''}${e.message}`;
    const lines = [
      ...this.notes.map(e => line('info', e)),
      ...this.warnings.map(e => line('warn', e)),
      ...this.errors.map(e => line('error', e))
    ];
    const counts = `${this.errors.length} error${this.errors.length === 1 ? '' : 's'}, ` +
      `${this.warnings.length} warning${this.warnings.length === 1 ? '' : 's'}`;
    lines.push(this.ok
      ? `fhirsmith: the configuration file ${configPath} test is successful (${counts})`
      : `fhirsmith: the configuration file ${configPath} test failed (${counts})`);
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------------------------
// the specification of the settings. Each setting is one of these; every one may be absent,
// and null (the default) unless it says required

const bool = (o = {}) => ({ t: 'bool', ...o });
const num = (o = {}) => ({ t: 'num', ...o }); // min, max, above (exclusive), int
const int = (o = {}) => ({ t: 'num', int: true, ...o });
const count = (o = {}) => int({ min: 0, ...o }); // 0 is usually "no limit"
const positive = (o = {}) => num({ above: 0, ...o });
const port = (o = {}) => int({ min: 1, max: 65535, ...o });
const str = (o = {}) => ({ t: 'str', ...o }); // values, pattern, nonEmpty
const url = (o = {}) => str({ pattern: /^https?:\/\/\S+$/, patternText: 'an http(s) URL', ...o });
const cron = (o = {}) => ({ t: 'cron', ...o });
const arr = (of, o = {}) => ({ t: 'arr', of, ...o });
const obj = (keys, o = {}) => ({ t: 'obj', keys, ...o }); // open: any other key is fine
const map = (of, o = {}) => ({ t: 'map', of, ...o }); // an object whose keys are names chosen by the user
const any = (o = {}) => ({ t: 'any', ...o });
const either = (...specs) => ({ t: 'either', specs });
const retired = (message) => ({ t: 'retired', message });
const internal = () => ({ t: 'internal' }); // set by the server itself
const custom = (check) => ({ t: 'custom', check }); // (value, where, report) => void

const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'verbose'];

const validatorSpec = obj({
  enabled: bool(),
  version: str({ nonEmpty: true }),
  txServer: str(),
  txLog: str(),
  port: port(),
  packages: arr(str({ nonEmpty: true })),
  timeout: positive(),
  autoLoadPackages: bool(),
  profiles: arr(str({ nonEmpty: true })),
  jar: str()
});

const rateLimitWindow = obj({ windowMinutes: positive(), max: count() });

const SERVER = obj({
  port: port(),
  cors: any(), // handed to the cors package as is
  maxBodyMB: positive(),
  webBase: str(),
  trustProxy: any(), // Express's "trust proxy": true, a number, an address list...
  memory: obj({
    rejectFraction: num({ above: 0, max: 1 }),
    abortFraction: num({ above: 0, max: 1 }),
    trimAllocator: bool(),
    group: internal()
  }),
  // cluster.md, "Configuration" and "Options"
  cluster: obj({
    workers: count(),
    cores: int({ min: 1 }),
    workerRule: str({ nonEmpty: true }),
    memoryHeadroomGB: num({ min: 0 }),
    masterServesTx: bool(),
    internalPort: port(),
    bindAddress: str({ nonEmpty: true }),
    drainSeconds: num({ min: 0 }),
    maxOutstanding: count(),
    queueSeconds: num({ min: 0 }),
    ownerQueueSeconds: num({ min: 0 }),
    cooldownSeconds: num({ min: 0 }),
    upstreamTimeoutSeconds: num({ min: 0 }),
    writeTimeoutSeconds: num({ min: 0 }),
    maxStartFailures: count(),
    recycleSeconds: num({ min: 0 }),
    fastLaneExtra: count(),
    normalMinSlots: count(),
    fastLaneMaxBytes: count(),
    statusSeconds: positive(),
    sharedCache: bool(),
    sharedCacheMaxMB: num({ min: 0 }),
    cacheAffinity: bool(),
    sharedClosure: bool()
  })
});

const TOP = obj({
  hostName: str(),
  sponsorMessage: str(),
  server: SERVER,
  stats: obj({ enabled: bool(), database: str({ nonEmpty: true }), intervalMinutes: positive(), sampleSeconds: positive() }),
  npmAudit: obj({ enabled: bool(), intervalHours: positive(), url: url(), latestUrl: url(), timeout: positive() }),
  email: obj({
    host: str({ nonEmpty: true, required: true }),
    port: port(),
    secure: bool(),
    user: str(),
    password: str(),
    from: str({ nonEmpty: true })
  }),
  dailyReport: obj({ enabled: bool(), to: either(str({ nonEmpty: true }), arr(str({ nonEmpty: true }))) }),
  accessibility: obj({ checkPanel: bool() }),
  logging: obj({
    level: str({ values: LOG_LEVELS }),
    console: bool(),
    consoleErrors: bool(),
    maxFiles: count(),
    maxSize: either(count(), str({ pattern: /^\d+\s*[kmg]?b?$/i, patternText: 'a size such as "50m"' })),
    flushInterval: positive(),
    flushSize: int({ min: 1 }),
    logDir: str({ nonEmpty: true }),
    stallReportSeconds: num({ min: 0 })
  }),
  modules: any() // checked module by module, below
});

const MODULES = {
  shl: obj({
    enabled: bool(),
    database: str({ nonEmpty: true }),
    password: str({ nonEmpty: true }),
    // relative to the data folder's shl directory
    certificates: obj({ certFile: str({ nonEmpty: true }), keyFile: str({ nonEmpty: true }), kid: str() }),
    vhl: obj({ issuer: str() }),
    cleanup: obj({ schedule: cron() }),
    validator: validatorSpec
  }),
  vcl: obj({ enabled: bool() }),
  xig: obj({ enabled: bool(), autoUpdate: bool(), updateToken: str({ nonEmpty: true }) }),
  packages: obj({
    enabled: bool(),
    database: str({ nonEmpty: true, required: true }),
    mirrorPath: str(),
    bucketPath: str(),
    masterUrl: str({ nonEmpty: true }),
    crawlToken: str({ nonEmpty: true }),
    localFeedDirs: arr(str({ nonEmpty: true })),
    allowPrivateAddresses: bool(),
    crawler: obj({
      enabled: bool(),
      schedule: cron(),
      maxDownloadMB: positive(),
      maxUnpackedMB: positive(),
      maxFileMB: positive(),
      maxFiles: int({ min: 1 }),
      maxFeedMB: positive(),
      maxRequestSeconds: positive(),
      signatures: str({ values: ['ignore', 'check', 'require'] })
    }),
    npmSigning: obj({ enabled: bool(), keyFile: str({ nonEmpty: true }) }),
    feedCheck: obj({ enabled: bool(), maxItems: int({ min: 1 }), maxTotalMB: positive(), keepMinutes: positive() }),
    npmCheck: obj({
      enabled: bool(),
      maxConcurrentRuns: int({ min: 1 }),
      runsPerWindow: count(),
      requestTimeout: positive(),
      maxDownloadMB: positive(),
      control: either(bool(), obj({ registry: url(), package: str({ nonEmpty: true }), version: str({ nonEmpty: true }) }))
    })
  }),
  registry: obj({
    enabled: bool(),
    masterUrl: url(),
    releasesUrl: url(),
    crawlInterval: positive(),
    timeout: positive(),
    userAgent: str(),
    apiKeys: map(str()),
    oauth: map(obj({ tokenEndpoint: url({ required: true }), clientId: str({ required: true }), clientSecret: str({ required: true }), scope: str() })),
    maxResponseMB: positive(),
    maxRequestSeconds: positive(),
    uptimeWindowDays: positive(),
    uptimeRetentionDays: positive(),
    allowPrivateAddresses: bool(),
    security: obj({
      apiToken: str({ nonEmpty: true }),
      users: obj({
        database: str({ nonEmpty: true }),
        adminUsername: str({ nonEmpty: true }),
        adminPassword: str({ nonEmpty: true }),
        sessionSecret: str({ nonEmpty: true }),
        cookieSecure: bool(),
        loginAttemptsPerWindow: count()
      }),
      oidc: obj({
        issuer: url({ required: true }),
        audience: str({ required: true }),
        requiredScope: str(),
        jwksUri: url(),
        algorithms: arr(str({ nonEmpty: true }))
      }),
      failedAuthPerWindow: count()
    })
  }),
  publisher: obj({
    enabled: bool(),
    database: str({ nonEmpty: true, required: true }),
    sessionSecret: str({ nonEmpty: true }),
    adminPassword: str({ nonEmpty: true }),
    cookieSecure: bool(),
    loginAttemptsPerWindow: count(),
    taskActionsPerMinute: count(),
    taskReadsPerMinute: count(),
    workspaceRoot: str({ nonEmpty: true, required: true }),
    igPublisherTimeoutMinutes: positive(),
    pollInterval: positive(),
    'large-file-archive': str({ nonEmpty: true }),
    'ig-registry-url': str({ nonEmpty: true }),
    'github-app': obj({
      'app-id': either(str({ nonEmpty: true }), int({ min: 1 })),
      'private-key': str({ nonEmpty: true, file: 'as given' }),
      installations: map(int({ min: 1 }))
    })
  }),
  npmprojector: obj({
    enabled: bool(),
    fhirVersion: str({ values: ['r4', 'r5', 'stu3', 'dstu2'] }),
    basePath: str({ pattern: /^\//, patternText: 'a path starting with /' }),
    npmPath: str({ nonEmpty: true }),
    resourceTypes: arr(str({ nonEmpty: true })),
    resourceFolders: arr(str({ nonEmpty: true })),
    searchParametersPath: str(),
    searchParametersFolder: str(),
    debounceMs: count()
  }),
  token: obj({
    enabled: bool(),
    database: str({ nonEmpty: true, required: true }),
    sessionSecret: str({ nonEmpty: true }),
    csrfSecret: str({ nonEmpty: true }),
    cookieSecure: bool(),
    oauth: map(obj({}, { open: true })),
    apiKeys: obj({ defaultAllowedRequests: count(), maxKeysPerUser: count(), keyExpiration: any() }),
    rateLimit: obj({ windowMs: positive(), max: count() })
  }),
  tx: obj({
    enabled: bool(),
    librarySource: str({ nonEmpty: true, required: true }),
    publishLibrarySource: bool(),
    snomed: obj({ load: str({ values: ['read', 'mmap'] }), prewarm: arr(str({ nonEmpty: true })), read: arr(str({ nonEmpty: true })) }),
    cacheTimeout: positive(),
    cacheMaxConcepts: count(),
    cacheMaxTotalConcepts: count(),
    usageTrackerMaxCodes: count(),
    usageTrackerMaxCodeLength: count(),
    languageTagCacheSize: count(),
    instanceCode: str({ pattern: /^[A-Za-z0-9]{1,16}$/, patternText: '1-16 letters and digits' }),
    syndication: obj({ enabled: bool() }),
    closure: obj({
      enabled: bool(),
      database: str({ nonEmpty: true }),
      requireUuidNames: bool(),
      maxTables: count(),
      maxConceptsPerTable: count(),
      maxConceptsPerRequest: count(),
      maxEntriesPerTable: count(),
      maxEntriesPerRequest: count(),
      maxConfigSize: count(),
      maxQueue: count(),
      lockTimeout: num({ min: 0 }),
      retentionDays: positive()
    }),
    expansionCacheSize: count(),
    expansionCacheMemoryThreshold: num({ min: 0 }),
    expansionCacheMaxCodes: count(),
    xmlCacheMB: num({ min: 0 }),
    // the expansion limits: checked together below (TXModule.expansionLimits)
    internalLimit: int({ min: 1 }),
    externalLimit: int({ min: 1 }),
    walkLimit: int({ min: 1 }),
    operationTimeLimit: positive(),
    slowRequestSeconds: num({ min: 0 }),
    consoleErrors: bool(),
    telnetErrors: bool(),
    pruneTerminologyCache: bool(),
    endpoints: arr(obj({
      path: str({ required: true, pattern: /^\/\S*$/, patternText: 'a path starting with /' }),
      fhirVersion: either(str({ required: true, nonEmpty: true }), num()),
      context: any()
    }), { required: true }),
    ecosystem: custom(checkEcosystem),
    vsacCfg: obj({
      apiKey: str({ nonEmpty: true, required: true }),
      baseUrl: url(),
      refreshIntervalHours: positive(),
      timeoutMs: positive(),
      resyncPassword: str({ nonEmpty: true }),
      valueSetCacheMB: num({ min: 0 }),
      cluster: internal() // leader or follower, from the role
    }),
    // what the server says about itself (metadata, TerminologyCapabilities)
    baseUrl: str(),
    host: str(),
    softwareName: str(),
    name: str(),
    title: str(),
    description: str(),
    contact: any(),
    contactUrl: str(),
    releaseDate: str(),
    ecosystemResolution: retired('replaced by modules.tx.ecosystem (see tx/README.md)'),
    ecosystemExcludedServers: retired('replaced by modules.tx.ecosystem.excludedServers (see tx/README.md)'),
    // set from server.cluster when the server runs with a role (library/role.js)
    clusterRole: internal(),
    sharedCache: internal(),
    sharedCacheMaxBytes: internal(),
    sharedClosure: internal()
  }),
  folder: obj({
    enabled: bool(),
    folders: arr(obj({ name: str({ nonEmpty: true }), folder: str({ nonEmpty: true, required: true }), url: str({ required: true }), enabled: bool() }))
  }),
  'ext-tracker': obj({ enabled: bool(), database: str({ nonEmpty: true }), url: str({ nonEmpty: true }), token: str() }),
  testing: obj({
    enabled: bool(),
    database: str({ nonEmpty: true }),
    token: str({ nonEmpty: true }),
    tokenHeader: str({ nonEmpty: true }),
    adminToken: str({ nonEmpty: true }),
    adminPassword: str({ nonEmpty: true }),
    sessionSecret: str({ nonEmpty: true }),
    cookieSecure: bool(),
    maxSize: int({ min: 1 }),
    rateLimit: rateLimitWindow,
    retentionDays: positive()
  }),
  ips: obj({
    enabled: bool(),
    database: str({ nonEmpty: true }),
    adminUsername: str({ nonEmpty: true }),
    adminPassword: str({ nonEmpty: true }),
    sessionSecret: str({ nonEmpty: true }),
    cookieSecure: bool(),
    loginAttemptsPerWindow: count(),
    maxSize: int({ min: 1 }),
    rateLimit: obj({ windowMinutes: positive(), max: count(), lookupMax: count() }),
    processing: obj({ enabled: bool(), intervalSeconds: positive() }),
    txServer: str({ nonEmpty: true }),
    ai: obj({
      provider: str({ values: ['openai', 'anthropic'] }),
      model: str({ nonEmpty: true }),
      apiKey: str({ nonEmpty: true }),
      baseUrl: url(),
      dailyCap: count(),
      maxBytes: int({ min: 1 }),
      maxTokens: int({ min: 1 }),
      timeout: positive(),
      sendNarrative: bool(),
      prices: map(obj({ input: num({ min: 0 }), output: num({ min: 0 }) }))
    }),
    aiKeySecret: str({ nonEmpty: true }),
    shl: obj({ server: str({ nonEmpty: true }), password: str(), days: positive(), viewer: str() }),
    validator: validatorSpec
  })
};

// ---------------------------------------------------------------------------------------------
// checking a value against its specification

function describe(value) {
  const s = JSON.stringify(value);
  return s === undefined ? String(value) : s.length > 60 ? s.substring(0, 57) + '...' : s;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const parked = (key) => key.startsWith('_') || key.startsWith('x-');

/**
 * Whether a value fits a specification, as a reason why not (or null). For the specs that
 * aren't containers; containers are walked by check()
 */
function mismatch(value, spec) {
  switch (spec.t) {
    case 'bool':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'num': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return spec.int ? 'must be a whole number' : 'must be a number';
      }
      if (spec.int && !Number.isInteger(value)) {
        return 'must be a whole number';
      }
      if (spec.min !== undefined && value < spec.min) {
        return `must be at least ${spec.min}`;
      }
      if (spec.above !== undefined && value <= spec.above) {
        return `must be more than ${spec.above}`;
      }
      if (spec.max !== undefined && value > spec.max) {
        return `must be at most ${spec.max}`;
      }
      return null;
    }
    case 'str':
      if (typeof value !== 'string') {
        return 'must be a string';
      }
      if (spec.nonEmpty && !value.trim()) {
        return 'must not be empty';
      }
      if (spec.values && !spec.values.includes(value)) {
        return `must be one of ${spec.values.map(v => JSON.stringify(v)).join(', ')}`;
      }
      if (spec.pattern && !spec.pattern.test(value)) {
        return `must be ${spec.patternText}`;
      }
      return null;
    case 'cron': {
      if (typeof value !== 'string' || !value.trim()) {
        return 'must be a cron schedule, e.g. "0 * * * *"';
      }
      let valid = true;
      try {
        valid = require('node-cron').validate(value);
      } catch {
        // node-cron not installed: the environment check reports that
      }
      return valid ? null : 'is not a valid cron schedule (minute hour day-of-month month day-of-week)';
    }
    default:
      return null;
  }
}

/**
 * @param {*} value
 * @param {Object} spec
 * @param {string} where - the setting's path, e.g. modules.tx.cacheTimeout
 * @param {Report} report
 */
function check(value, spec, where, report) {
  if (value === undefined || value === null) {
    if (spec.required) {
      report.error(where, 'is required');
    }
    return;
  }
  switch (spec.t) {
    case 'any':
      return;
    case 'internal':
      report.error(where, 'is set by the server itself, and can\'t be set in config.json');
      return;
    case 'retired':
      report.error(where, spec.message);
      return;
    case 'custom':
      spec.check(value, where, report);
      return;
    case 'either': {
      if (spec.specs.some(s => fits(value, s))) {
        // check the one it fits, for the details of containers
        check(value, spec.specs.find(s => fits(value, s)), where, report);
      } else {
        report.error(where, `${spec.specs.map(s => mismatch(value, s) || 'must be ' + kindName(s)).join(', or ')}, not ${describe(value)}`);
      }
      return;
    }
    case 'arr':
      if (!Array.isArray(value)) {
        report.error(where, `must be a list, not ${describe(value)}`);
        return;
      }
      value.forEach((item, i) => check(item, spec.of, `${where}[${i}]`, report));
      return;
    case 'map':
      if (!isObject(value)) {
        report.error(where, `must be an object, not ${describe(value)}`);
        return;
      }
      for (const [k, v] of Object.entries(value)) {
        check(v, spec.of, `${where}.${k}`, report);
      }
      return;
    case 'obj':
      if (!isObject(value)) {
        report.error(where, `must be an object, not ${describe(value)}`);
        return;
      }
      for (const [k, s] of Object.entries(spec.keys)) {
        check(value[k], s, `${where}.${k}`, report);
      }
      if (!spec.open) {
        for (const k of Object.keys(value)) {
          if (!(k in spec.keys) && !parked(k)) {
            report.warn(`${where}.${k}`, unknownSetting(k, Object.keys(spec.keys)));
          }
        }
      }
      return;
    default: {
      const why = mismatch(value, spec);
      if (why) {
        report.error(where, `${why}, not ${describe(value)}`);
      }
    }
  }
}

function fits(value, spec) {
  if (spec.t === 'obj' || spec.t === 'map') {
    return isObject(value);
  }
  if (spec.t === 'arr') {
    return Array.isArray(value);
  }
  return mismatch(value, spec) === null;
}

function kindName(spec) {
  return { obj: 'an object', map: 'an object', arr: 'a list' }[spec.t] || 'something else';
}

function checkEcosystem(value, where, report) {
  try {
    // as the tx module checks it at startup
    require('../tx/ecosystem-resolver').EcosystemResolver.checkConfig(value);
  } catch (error) {
    report.error(where, error.message.replace(/^modules\.tx\.ecosystem:\s*/, ''));
  }
  if (isObject(value)) {
    const known = ['use', 'registry', 'allowPrivateAddresses', 'excludedServers', 'excludedPatterns', 'apiKeys', 'oauth'];
    for (const k of Object.keys(value)) {
      if (!known.includes(k) && !parked(k)) {
        report.warn(`${where}.${k}`, unknownSetting(k, known));
      }
    }
  }
}

/** Levenshtein distance, case-insensitive */
function distance(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

function unknownSetting(key, known) {
  const close = known
    .filter(k => k !== key)
    .map(k => ({ k, d: distance(key, k) }))
    .filter(x => x.d <= Math.max(1, Math.floor(key.length / 4)))
    .sort((x, y) => x.d - y.d)[0];
  return close
    ? `is not a setting FHIRsmith knows: did you mean ${close.k}? It is ignored`
    : 'is not a setting FHIRsmith knows: it is ignored';
}

// ---------------------------------------------------------------------------------------------
// beyond the shape: the files the configuration names, the folders the server writes to

/** The data folder, as library/folder-setup.js finds it - without making it */
function dataDir(env) {
  return path.resolve(env.FHIRSMITH_DATA_DIR || path.join(ROOT, '..', 'data'));
}

/** The nearest folder that exists at or above p */
function existingAncestor(p) {
  let dir = p;
  while (!fs.existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) {
      return null;
    }
    dir = up;
  }
  return dir;
}

function checkWritableFolder(dir, where, report, what) {
  if (fs.existsSync(dir)) {
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch (error) {
      report.error(where, `${what} ${dir} can't be read: ${error.message}`);
      return;
    }
    if (!stat.isDirectory()) {
      report.error(where, `${what} ${dir} is not a folder`);
      return;
    }
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      report.error(where, `${what} ${dir} is not writable by this user`);
    }
    return;
  }
  const parent = existingAncestor(dir);
  try {
    fs.accessSync(parent, fs.constants.W_OK);
    report.note(where, `${what} ${dir} doesn't exist yet: the server will make it`);
  } catch {
    report.error(where, `${what} ${dir} doesn't exist, and can't be made (${parent} is not writable by this user)`);
  }
}

function checkFile(file, where, report, what) {
  if (!fs.existsSync(file)) {
    report.error(where, `${what} ${file} doesn't exist`);
    return false;
  }
  try {
    fs.accessSync(file, fs.constants.R_OK);
  } catch {
    report.error(where, `${what} ${file} is not readable by this user`);
    return false;
  }
  return true;
}

const SOURCE_TYPES = ['internal', 'ucum', 'loinc', 'rxnorm', 'ndc', 'unii', 'snomed', 'cpt', 'omop', 'icd11',
  'npm', 'npm/cs', 'url', 'url/cs', 'ocl', 'folder', 'file'];

/**
 * The tx library yml: it parses, has a base url, and its sources are type[!]:details[=prefix]
 * with a known type and a valid, unique prefix (as Library.load checks them, before it loads
 * anything); folder: and file: sources exist
 */
function checkLibrary(file, where, report) {
  let library;
  try {
    library = require('yaml').parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    report.error(where, `the library ${file} can't be read: ${error.message}`);
    return;
  }
  if (!isObject(library)) {
    report.error(where, `the library ${file} is not a YAML map (base:, sources:)`);
    return;
  }
  if (!isObject(library.base) || typeof library.base.url !== 'string' || !library.base.url) {
    report.error(where, `the library ${file} has no base: url: (where the databases are downloaded from)`);
  }
  if (!Array.isArray(library.sources) || library.sources.length === 0) {
    report.error(where, `the library ${file} has no sources:`);
    return;
  }
  const { checkIdPrefix } = require('../tx/library/resource-ids');
  const prefixes = new Map();
  for (const source of library.sources) {
    const here = `${where} (${path.basename(file)}: ${typeof source === 'string' ? source : describe(source)})`;
    if (typeof source !== 'string') {
      report.error(here, 'a source must be a string, type:details');
      continue;
    }
    const colon = source.indexOf(':');
    if (colon < 0) {
      report.error(here, 'a source is type:details (e.g. npm:hl7.terminology=tho)');
      continue;
    }
    const type = source.substring(0, colon).replace(/!$/, '');
    let details = source.substring(colon + 1);
    if (!SOURCE_TYPES.includes(type)) {
      report.error(here, `'${type}' is not a source type (${SOURCE_TYPES.join(', ')})`);
      continue;
    }
    const eq = details.lastIndexOf('=');
    if (eq > -1) {
      const prefix = details.substring(eq + 1);
      details = details.substring(0, eq);
      const problem = checkIdPrefix(prefix);
      if (problem) {
        report.error(here, problem);
      } else if (prefixes.has(prefix)) {
        report.error(here, `the id prefix '${prefix}' is also given for '${prefixes.get(prefix)}'`);
      } else {
        prefixes.set(prefix, source);
      }
    }
    if ((type === 'folder' || type === 'file') && details.trim()) {
      // Library resolves these against the project root
      const local = path.isAbsolute(details.trim()) ? details.trim() : path.resolve(ROOT, details.trim());
      if (!fs.existsSync(local)) {
        report.error(here, `${local} doesn't exist`);
      }
    }
  }
}

/** Checks for the enabled modules beyond the shape of their settings */
const MODULE_CHECKS = {
  tx(cfg, where, report, data) {
    if (typeof cfg.librarySource === 'string' && cfg.librarySource) {
      // read by fs, so relative to the folder the server is started in
      const file = path.resolve(cfg.librarySource);
      if (checkFile(file, `${where}.librarySource`, report, 'the library')) {
        checkLibrary(file, `${where}.librarySource`, report);
      }
    }
    if (Array.isArray(cfg.endpoints)) {
      const seen = new Set();
      for (const e of cfg.endpoints) {
        const p = e && typeof e.path === 'string' ? e.path.replace(/\/+$/, '') : null;
        if (p && seen.has(p)) {
          report.error(`${where}.endpoints`, `the path ${e.path} is given twice`);
        }
        seen.add(p);
      }
      if (cfg.endpoints.length === 0) {
        report.warn(`${where}.endpoints`, 'is empty: the tx module serves nothing');
      }
    }
    // as TXModule.expansionLimits has them: external <= internal <= walk
    const lim = (n) => (Number.isInteger(cfg[n]) && cfg[n] > 0 ? cfg[n] : null);
    const internalLimit = lim('internalLimit') ?? 100000;
    const externalLimit = lim('externalLimit') ?? Math.min(10000, internalLimit);
    const walkLimit = lim('walkLimit') ?? internalLimit * 10;
    if (externalLimit > internalLimit) {
      report.error(`${where}.externalLimit`, `is ${externalLimit}, more than internalLimit (${internalLimit}): an expansion can't return more codes than it builds`);
    }
    if (internalLimit > walkLimit) {
      report.error(`${where}.walkLimit`, `is ${walkLimit}, less than internalLimit (${internalLimit})`);
    }
    checkWritableFolder(path.join(data, 'terminology-cache'), where, report, 'the terminology cache');
  },
  shl(cfg, where, report, data) {
    for (const name of ['certFile', 'keyFile']) {
      const f = cfg.certificates && cfg.certificates[name];
      if (typeof f === 'string' && f) {
        checkFile(path.join(data, 'shl', f), `${where}.certificates.${name}`, report, 'the file');
      }
    }
  },
  publisher(cfg, where, report) {
    const key = cfg['github-app'] && cfg['github-app']['private-key'];
    if (typeof key === 'string' && key) {
      checkFile(path.resolve(key), `${where}.github-app.private-key`, report, 'the GitHub App key');
    }
    if (typeof cfg.sessionSecret !== 'string' || !cfg.sessionSecret) {
      report.warn(`${where}.sessionSecret`, 'is not set: a random one is made at startup, and logins don\'t survive a restart');
    }
  },
  folder(cfg, where, report) {
    (Array.isArray(cfg.folders) ? cfg.folders : []).forEach((f, i) => {
      if (f && f.enabled !== false && typeof f.folder === 'string' && f.folder && !fs.existsSync(path.resolve(f.folder))) {
        report.warn(`${where}.folders[${i}].folder`, `${path.resolve(f.folder)} doesn't exist`);
      }
    });
  }
};

// ---------------------------------------------------------------------------------------------
// the environment

function checkEnvironment(report) {
  const want = (() => {
    try {
      return require('../package.json').engines.node;
    } catch {
      return null;
    }
  })();
  const m = want && /^>=\s*(\d+)/.exec(want);
  const major = Number(process.versions.node.split('.')[0]);
  if (m && major < Number(m[1])) {
    report.error('environment', `Node.js ${process.version} is too old: FHIRsmith needs ${want}`);
  }
  for (const mod of ['better-sqlite3', 'sqlite3']) {
    try {
      require(mod);
    } catch (error) {
      report.error('environment', `the native module ${mod} doesn't load (${error.code || error.message}): run npm install (or npm rebuild) with this Node.js`);
    }
  }
  try {
    const { readCgroupMemoryLimit } = require('./cgroup-memory');
    const { limit, source } = readCgroupMemoryLimit() || {};
    if (limit > 0 && Number.isFinite(limit)) {
      report.note('environment', `memory limit: ${(limit / 2 ** 30).toFixed(1)} GB (${source})`);
    }
  } catch {
    // no cgroups here: the memory guard uses the machine's RAM
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Check a parsed configuration.
 * @param {Object} config - config.json, as read
 * @param {{dataDir?: string, environment?: boolean}} [options]
 * @returns {Report}
 */
function checkParsedConfig(config, options = {}) {
  const report = new Report();
  if (!isObject(config)) {
    report.error('', 'the configuration must be a JSON object');
    return report;
  }
  check(config, TOP, '', report);
  // check() names top-level settings ".server": tidy those
  for (const list of [report.errors, report.warnings, report.notes]) {
    for (const e of list) {
      e.where = e.where.replace(/^\./, '');
    }
  }
  const data = options.dataDir || dataDir(process.env);
  const modules = config.modules;
  if (modules !== undefined && !isObject(modules)) {
    report.error('modules', `must be an object, not ${describe(modules)}`);
  } else if (modules) {
    const enabled = [];
    for (const [name, cfg] of Object.entries(modules)) {
      const where = `modules.${name}`;
      if (parked(name)) {
        continue;
      }
      if (!MODULES[name]) {
        report.warn(where, unknownSetting(name, Object.keys(MODULES)).replace('a setting', 'a module') +
          ` (the modules: ${Object.keys(MODULES).join(', ')})`);
        continue;
      }
      if (!isObject(cfg)) {
        report.error(where, `must be an object, not ${describe(cfg)}`);
        continue;
      }
      if (cfg.enabled !== undefined && typeof cfg.enabled !== 'boolean') {
        report.error(`${where}.enabled`, `must be true or false, not ${describe(cfg.enabled)}`);
      }
      if (cfg.enabled !== true) {
        continue;
      }
      enabled.push(name);
      check(cfg, MODULES[name], where, report);
      if (MODULE_CHECKS[name]) {
        MODULE_CHECKS[name](cfg, where, report, data);
      }
    }
    report.note('modules', enabled.length ? `enabled: ${enabled.join(', ')}` : 'none enabled');
  }
  if (isObject(config.dailyReport) && config.dailyReport.enabled && !isObject(config.email)) {
    report.warn('dailyReport', 'is enabled, but there is no "email" block: nothing will be sent');
  }
  const mem = config.server && config.server.memory;
  if (isObject(mem) && typeof mem.rejectFraction === 'number' && typeof mem.abortFraction === 'number' && mem.abortFraction < mem.rejectFraction) {
    report.warn('server.memory', 'abortFraction is below rejectFraction: operations are aborted before new requests are refused');
  }

  checkWritableFolder(data, 'data folder', report, 'the data folder');
  const logDir = config.logging && typeof config.logging.logDir === 'string' ? path.resolve(config.logging.logDir) : path.join(data, 'logs');
  checkWritableFolder(logDir, 'logging', report, 'the log folder');
  if (options.environment !== false) {
    checkEnvironment(report);
  }
  return report;
}

/**
 * Read and check the configuration file in the data folder.
 * @param {{env?: Object, configPath?: string, environment?: boolean}} [options]
 * @returns {{report: Report, configPath: string, config: Object|null}}
 */
function checkConfigFile(options = {}) {
  const env = options.env || process.env;
  const data = dataDir(env);
  const configPath = options.configPath || path.join(data, 'config.json');
  let config = null;
  try {
    config = require('./config-reader').readConfig(configPath);
  } catch (error) {
    const report = new Report();
    report.error(configPath, error.code === 'ENOENT' ? 'doesn\'t exist' : error.message);
    return { report, configPath, config };
  }
  return { report: checkParsedConfig(config, { dataDir: data, environment: options.environment }), configPath, config };
}

/**
 * The check, for the command line: prints the report, and returns the exit code (0: the
 * configuration is good, 1: it isn't).
 *
 * server.js --check: config.json, and, with --role (or FHIRSMITH_ROLE), what the role makes of
 * it. cluster.js --check: config.json, the launcher's settings (with its flags), and the
 * configuration as the master and each worker will have it.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @param {Object} [env] - process.env
 * @param {{cluster?: boolean, loadSettings?: Function, out?: function(string)}} [options]
 * @returns {number}
 */
function runCheck(argv, env = process.env, options = {}) {
  const out = options.out || ((text) => process.stdout.write(text + '\n'));
  const { report, configPath, config } = checkConfigFile({ env });
  if (config && isObject(config)) {
    const { parseRole, applyRole } = require('./role');
    if (options.cluster) {
      try {
        // cluster.js passes its own: it is still loading when it calls this
        const loadSettings = options.loadSettings || require('../cluster').loadSettings;
        const settings = loadSettings(argv, env, structuredClone(config));
        const workers = settings.procs.filter(p => p.role === 'tx-worker');
        report.note('cluster', `the launcher listens on port ${settings.port}; the master on ${settings.procs[0].host}:${settings.procs[0].port}` +
          (workers.length ? `, ${workers.length} tx-worker${workers.length === 1 ? '' : 's'} on ${workers[0].port}-${workers[workers.length - 1].port}` : ', no tx-workers') +
          (settings.workersDefault ? ` (the ${settings.workerDecision.rule} rule: ${settings.workerDecision.formula}; fewer if memory is short once they load)` : ''));
        for (const p of settings.procs) {
          try {
            applyRole(structuredClone(config), { role: p.role, instanceCode: p.code });
          } catch (error) {
            report.error(`cluster (${p.name})`, error.message);
          }
        }
      } catch (error) {
        report.error('cluster', error.message);
      }
    } else {
      try {
        const role = parseRole(argv, env);
        if (role) {
          applyRole(structuredClone(config), role);
          report.note('role', `${role.role}${role.instanceCode ? ' (instance code ' + role.instanceCode + ')' : ''}`);
        }
      } catch (error) {
        report.error('role', error.message);
      }
    }
  }
  out(report.format(configPath));
  return report.ok ? 0 : 1;
}

/** Whether the command line asks for a check */
function wantsCheck(argv) {
  return argv.includes('--check') || argv.includes('-t');
}

module.exports = { checkParsedConfig, checkConfigFile, runCheck, wantsCheck, dataDir, Report, MODULES };
