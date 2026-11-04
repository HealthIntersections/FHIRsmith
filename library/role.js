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
const FLAGS = ['role', 'instance-code', 'port'];

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
  tx.clusterRole = role.role;
  // the options in server.cluster (cluster.md, "Options"). Every process reads the same
  // config.json, so they all agree; without a role these are never looked at
  const options = (config.server && config.server.cluster) || {};
  for (const name of ['sharedCache', 'cacheAffinity']) {
    if (options[name] !== undefined && typeof options[name] !== 'boolean') {
      throw new Error(`server.cluster.${name} must be true or false`);
    }
  }
  if (options.sharedCache === true) {
    tx.sharedCache = true;
    const mb = options.sharedCacheMaxMB === undefined ? 0 : Number(options.sharedCacheMaxMB);
    if (!Number.isFinite(mb) || mb < 0) {
      throw new Error('server.cluster.sharedCacheMaxMB must be a number of megabytes (0: no cap)');
    }
    tx.sharedCacheMaxBytes = Math.round(mb * 1024 * 1024);
  }
  if (tx.vsacCfg) {
    tx.vsacCfg = { ...tx.vsacCfg, cluster: role.role === 'master' ? 'leader' : 'follower' };
  }
  config.server = config.server || {};
  // the memory limit is the whole group's (master and workers in one cgroup)
  config.server.memory = { ...(config.server.memory || {}), group: true };
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

module.exports = { parseRole, applyRole, describeRole, ROLES };
