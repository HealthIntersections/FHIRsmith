/**
 * How many tx-workers the launcher starts when server.cluster.workers is not given
 * (cluster.md, "How many workers").
 *
 * The inputs: the vCPUs this process may use (os.availableParallelism()), the physical cores
 * among them (Linux sysfs topology; elsewhere taken to be the vCPUs), and a cgroup v2 cpu.max
 * quota, which caps the cores. A rule turns them into a number; the launcher then lowers it if
 * the processes won't fit in memory. The rule is the engine's: 'classic' here, and an engine
 * whose processes use the CPU differently registers its own (registerWorkerRule) and makes it
 * the default, or server.cluster.workerRule names one.
 *
 * @module library/worker-count
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * A CPU list as the kernel writes it ("0-3,8,10-11") to the CPU numbers.
 * @param {string} text
 * @returns {number[]}
 */
function parseCpuList(text) {
  const cpus = [];
  for (const part of String(text).trim().split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) {
      continue;
    }
    const lo = Number(m[1]);
    const hi = m[2] !== undefined ? Number(m[2]) : lo;
    for (let c = lo; c <= hi; c++) {
      cpus.push(c);
    }
  }
  return cpus;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The physical cores among the CPUs this process may run on (its affinity mask), from
 * /sys/devices/system/cpu/cpuN/topology/core_cpus_list (thread_siblings_list on older kernels).
 * @param {Object} [opts] - for tests: other locations
 * @param {string} [opts.sysCpu='/sys/devices/system/cpu']
 * @param {string} [opts.procStatus='/proc/self/status']
 * @returns {{cpus: number, cores: number}|null} null where the topology can't be read
 */
function readTopology(opts = {}) {
  const sysCpu = opts.sysCpu || '/sys/devices/system/cpu';
  const status = readText(opts.procStatus || '/proc/self/status');
  const m = status && /^Cpus_allowed_list:\s*(\S+)/m.exec(status);
  const allowed = m ? m[1] : readText(path.join(sysCpu, 'online'));
  const cpus = allowed ? parseCpuList(allowed) : [];
  if (!cpus.length) {
    return null;
  }
  const cores = new Set();
  for (const cpu of cpus) {
    const dir = path.join(sysCpu, 'cpu' + cpu, 'topology');
    const siblings = readText(path.join(dir, 'core_cpus_list')) ?? readText(path.join(dir, 'thread_siblings_list'));
    if (siblings === null) {
      return null;
    }
    cores.add(parseCpuList(siblings).join(','));
  }
  return { cpus: cpus.length, cores: cores.size };
}

/**
 * A cgroup v2 cpu.max quota on this process's cgroup or one enclosing it, in CPUs (the smallest).
 * @param {Object} [opts]
 * @param {string} [opts.procFile='/proc/self/cgroup']
 * @param {string} [opts.cgroupRoot='/sys/fs/cgroup']
 * @returns {number|null} null: none
 */
function readCpuQuota(opts = {}) {
  const cgroupRoot = opts.cgroupRoot || '/sys/fs/cgroup';
  const proc = readText(opts.procFile || '/proc/self/cgroup') || '';
  const line = proc.split('\n').find(l => l.startsWith('0::'));
  let p = path.posix.normalize(line ? line.slice(3).trim() || '/' : '/');
  let quota = null;
  for (;;) {
    const raw = readText(path.join(cgroupRoot, p, 'cpu.max'));
    const m = raw && /^(\d+)\s+(\d+)/.exec(raw.trim());
    if (m && Number(m[2]) > 0) {
      const q = Number(m[1]) / Number(m[2]);
      if (quota === null || q < quota) {
        quota = q;
      }
    }
    if (p === '/' || p === '.') {
      break;
    }
    p = path.posix.dirname(p);
  }
  return quota;
}

/**
 * The inputs to a rule.
 * @param {Object} [opts]
 * @param {number} [opts.vcpu] - default os.availableParallelism()
 * @param {number} [opts.cores] - server.cluster.cores: overrides the detected physical cores
 * @param {Object} [opts.topology], [opts.quota] - for tests (see readTopology, readCpuQuota)
 * @returns {{vcpu: number, cores: number, coresFrom: string, smt: number, quota: number|null}}
 */
function cpuInputs(opts = {}) {
  const vcpu = Math.max(1, Math.floor(opts.vcpu ?? (os.availableParallelism ? os.availableParallelism() : os.cpus().length)));
  const topo = opts.topology !== undefined ? opts.topology : readTopology(opts.sysfs);
  const quota = opts.quota !== undefined ? opts.quota : readCpuQuota(opts.cgroup);
  let cores;
  let coresFrom;
  if (opts.cores !== undefined && opts.cores !== null) {
    cores = Math.max(1, Math.floor(Number(opts.cores)));
    coresFrom = 'server.cluster.cores';
  } else if (topo) {
    cores = topo.cores;
    coresFrom = 'physical';
  } else {
    cores = vcpu;
    coresFrom = 'vCPU (no topology)';
  }
  const smt = topo && topo.cores ? Math.round(topo.cpus / topo.cores) : 1;
  if (quota !== null) {
    cores = Math.max(1, Math.min(cores, Math.ceil(quota)));
  }
  return { vcpu, cores, coresFrom, smt, quota };
}

// the rules: (inputs) => { workers, formula }. Measured in cluster.md, "How many workers"
const RULES = {
  classic: ({ cores, vcpu }) => ({
    workers: Math.min(cores, Math.round(0.6 * vcpu)),
    formula: `min(${cores}, round(0.6×${vcpu}))`
  })
};
let defaultRule = 'classic';

/**
 * Add a rule; with makeDefault, it is used when server.cluster.workerRule doesn't name one.
 * @param {string} name
 * @param {function({vcpu: number, cores: number}): {workers: number, formula: string}} rule
 * @param {boolean} [makeDefault]
 */
function registerWorkerRule(name, rule, makeDefault = false) {
  RULES[name] = rule;
  if (makeDefault) {
    defaultRule = name;
  }
}

/**
 * The default number of workers, before the memory check.
 * @param {Object} [opts] - cpuInputs' options, and rule (a name)
 * @returns {{workers: number, rule: string, formula: string, inputs: Object}}
 */
function defaultWorkers(opts = {}) {
  const rule = opts.rule || defaultRule;
  if (!RULES[rule]) {
    throw new Error(`server.cluster.workerRule '${rule}' is not one of ${Object.keys(RULES).join(', ')}`);
  }
  const inputs = cpuInputs(opts);
  const { workers, formula } = RULES[rule](inputs);
  return { workers: Math.max(1, workers), rule, formula, inputs };
}

/**
 * The inputs and the decision, in one line for the launcher's log.
 * @param {{workers: number, rule: string, formula: string, inputs: Object}} d - from defaultWorkers
 * @param {number} workers - what starts
 * @param {string} memory - e.g. 'memory fits 11'
 * @param {boolean} given - server.cluster.workers was given
 */
function describeDecision(d, workers, memory, given) {
  const i = d.inputs;
  const cores = i.coresFrom === 'physical' ? `${i.cores} physical cores (${i.vcpu} vCPU, SMT ${i.smt})`
    : `${i.cores} cores from ${i.coresFrom} (${i.vcpu} vCPU)`;
  const quota = i.quota === null ? 'none' : `${+i.quota.toFixed(2)} CPU`;
  const why = given ? `given (server.cluster.workers; ${d.rule} rule would give ${d.workers})`
    : `${d.rule} rule ${d.formula}` + (workers < d.workers ? ` = ${d.workers}, lowered to fit memory` : '');
  return `workers ${workers}: ${cores}, quota ${quota}, ${memory} → ${why}`;
}

module.exports = { parseCpuList, readTopology, readCpuQuota, cpuInputs, defaultWorkers, registerWorkerRule, describeDecision, RULES };
