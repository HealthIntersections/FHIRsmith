const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseCpuList, readTopology, readCpuQuota, cpuInputs, defaultWorkers, describeDecision, RULES } = require('../../library/worker-count');
const { loadSettings } = require('../../cluster');

let root;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-count-'));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// a fake /sys/devices/system/cpu and /proc/self/status: `siblings` per CPU (null: no file)
function sysfs(name, { allowed, siblings, file = 'core_cpus_list', online }) {
  const dir = path.join(root, name);
  const sysCpu = path.join(dir, 'cpu');
  fs.mkdirSync(sysCpu, { recursive: true });
  siblings.forEach((s, cpu) => {
    const topo = path.join(sysCpu, 'cpu' + cpu, 'topology');
    fs.mkdirSync(topo, { recursive: true });
    if (s !== null) {
      fs.writeFileSync(path.join(topo, file), s + '\n');
    }
  });
  if (online) {
    fs.writeFileSync(path.join(sysCpu, 'online'), online + '\n');
  }
  const procStatus = path.join(dir, 'status');
  fs.writeFileSync(procStatus, allowed ? `Name:\tnode\nCpus_allowed:\tff\nCpus_allowed_list:\t${allowed}\nVoluntary:\t1\n` : 'Name:\tnode\n');
  return { sysCpu, procStatus };
}

// 8 CPUs on 4 cores, SMT siblings n and n+4 (as Linux numbers them on most x86)
const smt8 = Array.from({ length: 8 }, (_, c) => `${c % 4},${(c % 4) + 4}`);

describe('the CPU topology', () => {
  test('CPU lists', () => {
    expect(parseCpuList('0-3,8,10-11\n')).toEqual([0, 1, 2, 3, 8, 10, 11]);
    expect(parseCpuList('5')).toEqual([5]);
    expect(parseCpuList('')).toEqual([]);
  });

  test('SMT on: 8 CPUs, 4 physical cores', () => {
    expect(readTopology(sysfs('smt', { allowed: '0-7', siblings: smt8 }))).toEqual({ cpus: 8, cores: 4 });
  });

  test('SMT off: each CPU its own core', () => {
    expect(readTopology(sysfs('nosmt', { allowed: '0-7', siblings: ['0', '1', '2', '3', '4', '5', '6', '7'] }))).toEqual({ cpus: 8, cores: 8 });
  });

  test('older kernels: thread_siblings_list', () => {
    expect(readTopology(sysfs('old', { allowed: '0-7', siblings: smt8, file: 'thread_siblings_list' }))).toEqual({ cpus: 8, cores: 4 });
  });

  test('an affinity subset: only the CPUs this process may run on', () => {
    // taskset -c 0,4,1: two threads of core 0, one of core 1
    expect(readTopology(sysfs('subset', { allowed: '0-1,4', siblings: smt8 }))).toEqual({ cpus: 3, cores: 2 });
    // one thread of each of 4 cores
    expect(readTopology(sysfs('subset4', { allowed: '0-3', siblings: smt8 }))).toEqual({ cpus: 4, cores: 4 });
  });

  test('no affinity list: the online CPUs', () => {
    expect(readTopology(sysfs('online', { siblings: smt8, online: '0-7' }))).toEqual({ cpus: 8, cores: 4 });
  });

  test('missing sysfs: null, and the cores are the vCPUs', () => {
    const missing = { sysCpu: path.join(root, 'none'), procStatus: path.join(root, 'none', 'status') };
    expect(readTopology(missing)).toBeNull();
    // a CPU in the mask with no topology file (an odd hypervisor)
    expect(readTopology(sysfs('partial', { allowed: '0-3', siblings: ['0', '1', null, '3'] }))).toBeNull();
    expect(cpuInputs({ vcpu: 6, sysfs: missing, quota: null })).toEqual({ vcpu: 6, cores: 6, coresFrom: 'vCPU (no topology)', smt: 1, quota: null });
  });
});

describe('the cgroup v2 CPU quota', () => {
  function cgroup(name, files) {
    const dir = path.join(root, name);
    for (const [p, text] of Object.entries(files)) {
      fs.mkdirSync(path.join(dir, 'fs', p), { recursive: true });
      fs.writeFileSync(path.join(dir, 'fs', p, 'cpu.max'), text);
    }
    const procFile = path.join(dir, 'cgroup');
    fs.writeFileSync(procFile, '0::/system.slice/fhirsmith.service\n');
    return { procFile, cgroupRoot: path.join(dir, 'fs') };
  }

  test('none, a quota on the unit, the smallest on the way up', () => {
    expect(readCpuQuota(cgroup('q0', { 'system.slice/fhirsmith.service': 'max 100000\n' }))).toBeNull();
    expect(readCpuQuota(cgroup('q1', { 'system.slice/fhirsmith.service': '250000 100000\n' }))).toBe(2.5);
    expect(readCpuQuota(cgroup('q2', { 'system.slice/fhirsmith.service': '400000 100000\n', 'system.slice': '150000 100000\n' }))).toBe(1.5);
    expect(readCpuQuota({ procFile: path.join(root, 'nope'), cgroupRoot: path.join(root, 'nope') })).toBeNull();
  });

  test('caps the cores at ceil(quota)', () => {
    const topology = { cpus: 8, cores: 4 };
    expect(cpuInputs({ vcpu: 8, topology, quota: 2.5 }).cores).toBe(3);
    expect(cpuInputs({ vcpu: 8, topology, quota: 0.5 }).cores).toBe(1);
    expect(cpuInputs({ vcpu: 8, topology, quota: 6 }).cores).toBe(4);
    // classic on 8 vCPU / 4 cores with a 2.5 CPU quota: min(3, 5)
    expect(defaultWorkers({ vcpu: 8, topology, quota: 2.5, rule: 'classic' }).workers).toBe(3);
  });
});

describe('the rules', () => {
  const v2 = ({ cores, vcpu }) => ({ workers: Math.min(cores - 1, Math.round(0.6 * vcpu) + 1), formula: `min(${cores}−1, round(0.6×${vcpu})+1)` });
  beforeAll(() => {
    RULES['test-v2'] = v2;
  });
  afterAll(() => {
    delete RULES['test-v2'];
  });
  const at = (vcpu, cores, rule = 'classic') => defaultWorkers({ vcpu, topology: { cpus: vcpu, cores }, quota: null, rule }).workers;

  test('classic: min(physical cores, round(0.6 × vCPU))', () => {
    // 4 vCPU (SMT off) / 8 vCPU with SMT (4 cores) / 8 cores no SMT / 16 vCPU with SMT
    expect([at(4, 4), at(8, 4), at(8, 8), at(16, 8)]).toEqual([2, 4, 5, 8]);
    expect(at(4, 2)).toBe(2);
    expect(at(1, 1)).toBe(1);
  });

  test('an engine\'s own rule, by name; at least 1', () => {
    expect([at(4, 4, 'test-v2'), at(8, 4, 'test-v2'), at(8, 8, 'test-v2'), at(16, 8, 'test-v2')]).toEqual([3, 3, 6, 7]);
    // 1 core: cores − 1 = 0, but at least one worker
    expect(at(2, 1, 'test-v2')).toBe(1);
    expect(() => defaultWorkers({ vcpu: 4, rule: 'nonesuch' })).toThrow(/workerRule 'nonesuch' is not one of classic/);
  });

  test('server.cluster.cores overrides the detected cores', () => {
    const d = defaultWorkers({ vcpu: 16, topology: { cpus: 16, cores: 8 }, quota: null, cores: 3, rule: 'classic' });
    expect([d.workers, d.inputs.coresFrom]).toEqual([3, 'server.cluster.cores']);
  });

  test('the log line', () => {
    const d = defaultWorkers({ vcpu: 8, topology: { cpus: 8, cores: 4 }, quota: null, rule: 'classic' });
    expect(describeDecision(d, 4, 'memory fits 11', false)).toBe('workers 4: 4 physical cores (8 vCPU, SMT 2), quota none, memory fits 11 → classic rule min(4, round(0.6×8))');
    expect(describeDecision(d, 2, 'memory fits 2', false)).toBe('workers 2: 4 physical cores (8 vCPU, SMT 2), quota none, memory fits 2 → classic rule min(4, round(0.6×8)) = 4, lowered to fit memory');
    expect(describeDecision(d, 6, 'memory fits 11', true)).toBe('workers 6: 4 physical cores (8 vCPU, SMT 2), quota none, memory fits 11 → given (server.cluster.workers; classic rule would give 4)');
    const q = defaultWorkers({ vcpu: 8, topology: { cpus: 8, cores: 4 }, quota: 2.5, cores: 6, rule: 'classic' });
    expect(describeDecision(q, 3, 'memory not measured', false)).toBe('workers 3: 3 cores from server.cluster.cores (8 vCPU), quota 2.5 CPU, memory not measured → classic rule min(3, round(0.6×8))');
  });
});

describe('in the launcher\'s settings', () => {
  const tx = { tx: { enabled: true } };
  const workers = (s) => s.procs.filter(p => p.role === 'tx-worker').length;
  const cpu = { vcpu: 8, topology: { cpus: 8, cores: 4 }, quota: null };

  test('not given: by the rule; given (config, flag, environment): that, always', () => {
    const classic = (cluster = {}) => ({ server: { cluster: { workerRule: 'classic', ...cluster } }, modules: tx });
    expect(workers(loadSettings([], {}, classic(), cpu))).toBe(4);
    expect(workers(loadSettings([], {}, classic({ cores: 2 }), cpu))).toBe(2);
    expect(workers(loadSettings([], {}, classic({ workers: 7, cores: 2 }), cpu))).toBe(7);
    expect(workers(loadSettings(['--workers=1'], {}, classic(), cpu))).toBe(1);
    expect(workers(loadSettings([], { FHIRSMITH_WORKERS: '3' }, classic(), cpu))).toBe(3);
    const s = loadSettings([], {}, classic(), cpu);
    expect([s.workersDefault, s.workerDecision.rule, s.workerDecision.workers]).toEqual([true, 'classic', 4]);
    expect(() => loadSettings([], {}, { server: { cluster: { workerRule: 'x' } }, modules: tx }, cpu)).toThrow(/not one of/);
  });
});
