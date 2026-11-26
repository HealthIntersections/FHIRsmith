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
 * - tx-worker: the modules in server.cluster.workerModules - the tx module by default, and
 *   the rest module if it is listed (["tx", "rest"]). No background jobs, no statistics
 *   database, no $closure or syndication store (those requests go to the master), the VSAC
 *   provider only reads what the master's sync wrote, and the rest module's endpoints wait
 *   for the master's schema migrations and leave its jobs to the master.
 * - jobs: the rest module only, for its background jobs and queues (rest/queue/runner.js):
 *   search cleanup, the closure, package loads, value set membership, reindexing, and async
 *   requests. The launcher starts one when the rest module is enabled, unless
 *   server.cluster.jobsProcess is false (then the master runs them). It gets no requests
 *   from the launcher; a terminology server that is a path on this server is reached through
 *   the launcher's port (FHIRSMITH_FRONT_DOOR), since it doesn't run the tx module.
 *
 * @module library/role
 */

const ROLES = ['master', 'tx-worker', 'jobs'];

// the environment variable the launcher gives the jobs process: the URL of its own port
const FRONT_DOOR_ENV = 'FHIRSMITH_FRONT_DOOR';

/**
 * Whether the cluster has a jobs process (--role=jobs): when the rest module is enabled,
 * unless server.cluster.jobsProcess is false.
 * @param {Object} config
 */
function jobsProcess(config) {
  const rest = config.modules && config.modules.rest;
  const option = config.server && config.server.cluster && config.server.cluster.jobsProcess;
  if (option !== undefined && option !== null && typeof option !== 'boolean') {
    throw new Error('server.cluster.jobsProcess must be true or false');
  }
  return Boolean(rest && rest.enabled) && option !== false;
}

/**
 * Whether this process runs the rest module's jobs and queues: with no role, yes; the jobs
 * process, yes; the master, when there is no jobs process; a tx-worker, never.
 * @param {Object|null} role - from parseRole
 * @param {Object} config
 */
function runsRestJobs(role, config) {
  if (!role) {
    return true;
  }
  if (role.role === 'jobs') {
    return true;
  }
  return role.role === 'master' && !jobsProcess(config);
}

/** What to call a process with this role, in titles */
function roleLabel(role) {
  return role.role === 'master' ? 'Master' : role.role === 'jobs' ? 'Jobs' : 'Worker';
}

// the modules a worker can run (server.cluster.workerModules): those whose state is all in
// files or databases every process can share. The tx module is always one of them
const WORKER_MODULES = ['tx', 'rest'];
const DEFAULT_WORKER_MODULES = ['tx'];

/**
 * The modules a worker runs: server.cluster.workerModules, checked.
 * @param {Object} config
 * @returns {string[]}
 */
function workerModules(config) {
  const list = config.server && config.server.cluster && config.server.cluster.workerModules;
  if (list === undefined || list === null) {
    return DEFAULT_WORKER_MODULES;
  }
  if (!Array.isArray(list) || list.some(m => typeof m !== 'string')) {
    throw new Error('server.cluster.workerModules must be a list of module names, e.g. ["tx", "rest"]');
  }
  for (const m of list) {
    if (!WORKER_MODULES.includes(m)) {
      throw new Error(`server.cluster.workerModules: a worker can't run the ${m} module (only ${WORKER_MODULES.join(' and ')})`);
    }
  }
  return list.includes('tx') ? list : ['tx', ...list];
}

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

// the IPC message a process started by the launcher sends from its listen callback: the
// launcher marks it ready on this, from this child, rather than on whoever answers its port
const READY = 'fhirsmith:ready';

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

// stats.sampleSeconds with a role, when not given: the graphs' sample interval, at most this,
// so a short session on a cluster can be read (cluster.md, "Graphs"). The counters are still
// written every stats.intervalMinutes
const ROLE_SAMPLE_SECONDS = 60;

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
      throw new Error('--instance-code and --port are only used with --role (master, tx-worker or jobs)');
    }
    return null;
  }
  if (!ROLES.includes(role)) {
    throw new Error(`Unknown role '${role}': use master, tx-worker or jobs`);
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
  if (role.role !== 'master' && !role.instanceCode) {
    // the config's code is the master's: every process needs its own
    throw new Error(`A ${role.role === 'jobs' ? 'jobs process' : role.role} needs its own instance code: --instance-code or FHIRSMITH_INSTANCE_CODE`);
  }
  if (role.role === 'jobs' && !(config.modules.rest && config.modules.rest.enabled)) {
    throw new Error('--role=jobs runs the rest module\'s jobs: the rest module must be enabled in config.json');
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
  const stats = config.stats || {};
  if (stats.sampleSeconds === undefined) {
    const interval = stats.intervalMinutes > 0 ? stats.intervalMinutes * 60 : 600;
    config.stats = { ...stats, sampleSeconds: Math.min(ROLE_SAMPLE_SECONDS, interval) };
  }
  const keep = role.role === 'jobs' ? ['rest'] : workerModules(config);
  if (role.role === 'tx-worker' || role.role === 'jobs') {
    for (const [name, mod] of Object.entries(config.modules)) {
      if (!keep.includes(name) && mod) {
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
  if (role.role === 'jobs') {
    return `Role: jobs (instance code ${code}): the rest module's background jobs and queues, no requests`;
  }
  return role.role === 'master'
    ? `Role: master (instance code ${code}): all modules, background jobs${jobsProcess(config) ? ' (but the rest module\'s, in the jobs process)' : ''}, $closure`
    : `Role: tx-worker (instance code ${code}): the ${workerModules(config).join(' and ')} module${workerModules(config).length > 1 ? 's' : ''} only, no background jobs`;
}

module.exports = { parseRole, applyRole, describeRole, workerModules, jobsProcess, runsRestJobs, roleLabel, FRONT_DOOR_ENV, WORKER_MODULES, checkInstanceCode, bindAddress, connectAddress, DEFAULT_BIND_ADDRESS,
  DEFAULT_SHARED_CACHE_MAX_MB, ROLE_TRIM_ALLOCATOR, ROLE_SAMPLE_SECONDS, READY, ROLES };
