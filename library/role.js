/**
 * Process roles, for running one master and several terminology workers on one data
 * directory (see cluster.md).
 *
 *   node server.js                                   no role: everything exactly as before
 *   node server.js --role=master --instance-code=m0 --port=3001
 *   node server.js --role=tx-worker --instance-code=tx1 --port=3002
 *
 * The role also comes from FHIRSMITH_ROLE and the instance code from FHIRSMITH_INSTANCE_CODE
 * (flags win). With no role, nothing here changes the configuration: server.js only calls
 * applyRole when parseRole returns a role.
 *
 * - master: every configured module, every background job, $closure and the syndication
 *   feed. The VSAC provider syncs and, after each sync, bumps a generation counter that the
 *   workers watch.
 * - tx-worker: the tx module only. No background jobs, no statistics database, no $closure
 *   or syndication store (those requests go to the master), and the VSAC provider only
 *   reads what the master's sync wrote.
 *
 * @module library/role
 */

const ROLES = ['master', 'tx-worker'];

/**
 * An instance code goes in front of every cache-id the process issues, and a front door
 * routes on it (nginx.md's map on "^tx1\."). It has to be 1-16 letters and digits: the
 * longest cache-id, "<code>.<generation>.<random>" (two 22-character tokens) or
 * "<code>.<start>.<uuid>", is then 62 characters, inside a FHIR id's 64. The tx module
 * checks the same (ResourceCache.checkInstanceCode); this fails before anything starts.
 * @param {string} code
 * @param {string} where - what to call it in the error
 */
function checkInstanceCode(code, where = 'instance code') {
  if (typeof code !== 'string' || !/^[A-Za-z0-9]{1,16}$/.test(code)) {
    throw new Error(`The ${where} '${code}' is not valid: it must be 1-16 letters and digits`);
  }
  return code;
}
const FLAGS = ['role', 'instance-code', 'port'];

// The address a process with a role listens on (server.cluster.bindAddress): loopback, since
// only the front door (cluster.js, or nginx on the same host) should reach the master and
// the workers. "0.0.0.0" or "::" for every interface; a specific address for one
const DEFAULT_BIND_ADDRESS = '127.0.0.1';

// server.cluster.sharedCacheMaxMB: the most client resource JSON the shared cache file holds,
// all endpoints together, in MB. The largest IG Publisher cache session in our corpus of
// builds against tx.fhir.org (2,817 sessions) held 3.5 MB (p99 2.8 MB, median 55 KB), so 256
// is about 70x the largest: the room cacheMaxTotalConcepts gives one endpoint (about 40x the
// largest session's concepts), for two busy endpoints. 0: no cap
const DEFAULT_SHARED_CACHE_MAX_MB = 256;

// server.memory.trimAllocator with a role: on, unless the config says false. N+1 processes
// share one limit, and malloc_trim gives back what loading the library leaves resident
// (0.6-0.7 GB a process) and what a burst leaves (cluster.md, "Memory"). With no role the
// memory guard's own default (off) applies
const ROLE_TRIM_ALLOCATOR = true;

/**
 * The address a process with a role listens on; with no role (null), none: every interface,
 * as before.
 * @param {Object} config - config.json
 */
function bindAddress(config) {
  return (config.server && config.server.cluster && config.server.cluster.bindAddress) ?? DEFAULT_BIND_ADDRESS;
}

/**
 * The address to reach a process listening on `bind` at: loopback for every interface.
 * @param {string} bind
 */
function connectAddress(bind) {
  return bind === '0.0.0.0' ? '127.0.0.1' : bind === '::' ? '::1' : bind;
}

/**
 * The role this process was started with, or null for none.
 * @param {string[]} argv - process.argv.slice(2)
 * @param {Object} env - process.env
 * @returns {{role: string, instanceCode: string|null, port: number|null}|null}
 */
function parseRole(argv = [], env = {}) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (m && FLAGS.includes(m[1])) {
      flags[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
    }
  }
  const role = flags.role || env.FHIRSMITH_ROLE || null;
  if (!role) {
    if (flags['instance-code'] !== undefined || flags.port !== undefined) {
      throw new Error('--instance-code and --port are only used with --role (master or tx-worker)');
    }
    return null;
  }
  if (!ROLES.includes(role)) {
    throw new Error(`Unknown role '${role}': use master or tx-worker`);
  }
  let port = null;
  if (flags.port !== undefined) {
    port = Number(flags.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`--port '${flags.port}' is not a port number`);
    }
  }
  return { role, instanceCode: flags['instance-code'] || env.FHIRSMITH_INSTANCE_CODE || null, port };
}

/**
 * Change the configuration (in place) for the role.
 * @param {Object} config - the parsed config.json
 * @param {{role: string, instanceCode: string|null}} role - from parseRole
 * @returns {Object} config
 */
function applyRole(config, role) {
  const tx = config.modules && config.modules.tx;
  if (!tx || !tx.enabled) {
    throw new Error(`--role=${role.role} needs the tx module enabled in config.json`);
  }
  if (role.role === 'tx-worker' && !role.instanceCode) {
    // the config's code is the master's: every process needs its own
    throw new Error('A tx-worker needs its own instance code: --instance-code or FHIRSMITH_INSTANCE_CODE');
  }
  tx.instanceCode = role.instanceCode || tx.instanceCode;
  if (!tx.instanceCode) {
    throw new Error('The master needs an instance code: --instance-code, FHIRSMITH_INSTANCE_CODE or modules.tx.instanceCode');
  }
  checkInstanceCode(tx.instanceCode);
  tx.clusterRole = role.role;
  // the options in server.cluster (cluster.md, "Options"). Every process reads the same
  // config.json, so they all agree; without a role these are never looked at
  const options = (config.server && config.server.cluster) || {};
  for (const name of ['sharedCache', 'cacheAffinity', 'sharedClosure']) {
    if (options[name] !== undefined && typeof options[name] !== 'boolean') {
      throw new Error(`server.cluster.${name} must be true or false`);
    }
  }
  if (options.bindAddress != null && (typeof options.bindAddress !== 'string' || !options.bindAddress)) {
    throw new Error('server.cluster.bindAddress must be an address to listen on, e.g. "127.0.0.1" (the default) or "0.0.0.0"');
  }
  if (options.sharedCache === true) {
    tx.sharedCache = true;
    const mb = Number(options.sharedCacheMaxMB ?? DEFAULT_SHARED_CACHE_MAX_MB);
    if (!Number.isFinite(mb) || mb < 0) {
      throw new Error('server.cluster.sharedCacheMaxMB must be a number of megabytes (0: no cap)');
    }
    tx.sharedCacheMaxBytes = Math.round(mb * 1024 * 1024);
  }
  if (options.sharedClosure === true) {
    tx.sharedClosure = true;
  }
  if (tx.vsacCfg) {
    tx.vsacCfg = { ...tx.vsacCfg, cluster: role.role === 'master' ? 'leader' : 'follower' };
  }
  config.server = config.server || {};
  // the memory limit is the whole group's (master and workers in one cgroup)
  const memory = config.server.memory || {};
  config.server.memory = { ...memory, group: true, trimAllocator: memory.trimAllocator ?? ROLE_TRIM_ALLOCATOR };
  if (role.role === 'tx-worker') {
    for (const [name, mod] of Object.entries(config.modules)) {
      if (name !== 'tx' && mod) {
        mod.enabled = false;
      }
    }
    // the master keeps the statistics database, runs the npm audit and sends the report
    config.stats = { ...(config.stats || {}), enabled: false };
    config.npmAudit = { ...(config.npmAudit || {}), enabled: false };
    config.dailyReport = { ...(config.dailyReport || {}), enabled: false };
  }
  return config;
}

function describeRole(role, config) {
  const code = config.modules.tx.instanceCode;
  return role.role === 'master'
    ? `Role: master (instance code ${code}): all modules, background jobs, $closure`
    : `Role: tx-worker (instance code ${code}): the tx module only, no background jobs`;
}

module.exports = { parseRole, applyRole, describeRole, checkInstanceCode, bindAddress, connectAddress, DEFAULT_BIND_ADDRESS,
  DEFAULT_SHARED_CACHE_MAX_MB, ROLE_TRIM_ALLOCATOR, ROLES };
