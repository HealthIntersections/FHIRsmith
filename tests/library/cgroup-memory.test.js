const fs = require('fs');
const os = require('os');
const path = require('path');
const { readCgroupMemoryLimit, readCgroupStat, readCgroupAnon, readProcessMemory } = require('../../library/cgroup-memory');

const FIXTURES = path.join(__dirname, 'fixtures', 'cluster-status');

describe('readCgroupMemoryLimit', () => {
  let dir;
  let procFile;
  let cgroupRoot;

  const write = (rel, content) => {
    const file = path.join(cgroupRoot, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgroup-test-'));
    procFile = path.join(dir, 'proc-cgroup');
    cgroupRoot = path.join(dir, 'sys');
    fs.mkdirSync(cgroupRoot);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const read = () => readCgroupMemoryLimit({ procFile, cgroupRoot });

  test('systemd service under cgroup v2: root has no memory.max, unit does', () => {
    fs.writeFileSync(procFile, '0::/system.slice/fhirsmith.service\n');
    write('system.slice/fhirsmith.service/memory.max', '32212254720\n');
    write('system.slice/memory.max', 'max\n');
    const r = read();
    expect(r.limit).toBe(32212254720);
    expect(r.source).toBe(path.join(cgroupRoot, 'system.slice/fhirsmith.service/memory.max'));
  });

  test('takes the smallest limit on the way up to the root', () => {
    fs.writeFileSync(procFile, '0::/system.slice/fhirsmith.service\n');
    write('system.slice/fhirsmith.service/memory.max', 'max\n');
    write('system.slice/memory.max', '1000000\n');
    expect(read().limit).toBe(1000000);
  });

  test('namespaced container: cgroup is "/" and the limit is at the mount root', () => {
    fs.writeFileSync(procFile, '0::/\n');
    write('memory.max', '8589934592\n');
    expect(read().limit).toBe(8589934592);
  });

  test('unlimited everywhere gives 0', () => {
    fs.writeFileSync(procFile, '0::/user.slice/session-1.scope\n');
    write('user.slice/session-1.scope/memory.max', 'max\n');
    expect(read()).toEqual({ limit: 0, source: null });
  });

  test('cgroup v1 memory controller', () => {
    fs.writeFileSync(procFile, '5:cpu,cpuacct:/system.slice/x.service\n4:memory:/system.slice/x.service\n');
    write('memory/system.slice/x.service/memory.limit_in_bytes', '2147483648\n');
    write('memory/memory.limit_in_bytes', '9223372036854771712\n');
    expect(read().limit).toBe(2147483648);
  });

  test('no proc file and nothing mounted gives 0', () => {
    expect(read()).toEqual({ limit: 0, source: null });
  });
});

describe('readCgroupStat and readProcessMemory (fixtures from a Linux host)', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgroup-stat-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cgroupWith = (fixture) => {
    if (fixture) {
      fs.copyFileSync(path.join(FIXTURES, fixture), path.join(dir, 'memory.stat'));
    }
    return { dir, version: fixture === 'memory.stat.v1' ? 1 : 2 };
  };

  test('cgroup v2: anon and file from memory.stat', () => {
    const cg = cgroupWith('memory.stat.v2');
    expect(readCgroupStat(cg)).toEqual({ anon: 8053063680, file: 3221225472 });
    expect(readCgroupAnon(cg)).toBe(8053063680);
  });

  test('cgroup v1: total_rss and total_cache (the hierarchy\'s), not the cgroup\'s own rss and cache', () => {
    const cg = cgroupWith('memory.stat.v1');
    expect(readCgroupStat(cg)).toEqual({ anon: 6442450944, file: 3221225472 });
  });

  test('cgroup v1 without the totals: rss and cache', () => {
    fs.writeFileSync(path.join(dir, 'memory.stat'), 'cache 100\nrss 200\nmapped_file 50\n');
    expect(readCgroupStat({ dir, version: 1 })).toEqual({ anon: 200, file: 100 });
  });

  test('no memory.stat, or no anon in it: null (readCgroupAnon 0)', () => {
    expect(readCgroupStat(cgroupWith(null))).toBeNull();
    expect(readCgroupAnon(cgroupWith(null))).toBe(0);
    fs.writeFileSync(path.join(dir, 'memory.stat'), 'file 100\n');
    expect(readCgroupStat({ dir, version: 2 })).toBeNull();
    fs.writeFileSync(path.join(dir, 'memory.stat'), 'anon 100\n');
    expect(readCgroupStat({ dir, version: 2 })).toEqual({ anon: 100, file: null });
  });

  test('/proc/<pid>/status: RssAnon and RssFile, in bytes', () => {
    fs.mkdirSync(path.join(dir, '4242'));
    fs.copyFileSync(path.join(FIXTURES, 'proc-status'), path.join(dir, '4242', 'status'));
    expect(readProcessMemory(4242, dir)).toEqual({ anon: 2621440 * 1024, file: 2539940 * 1024 });
    // gone, or not Linux
    expect(readProcessMemory(4243, dir)).toBeNull();
    fs.writeFileSync(path.join(dir, '4242', 'status'), 'Name:\tnode\nVmRSS:\t100 kB\n');
    expect(readProcessMemory(4242, dir)).toBeNull();
  });

  test('this process, on Linux', () => {
    const own = readProcessMemory('self');
    if (process.platform === 'linux') {
      expect(own.anon).toBeGreaterThan(0);
      expect(own.file).toBeGreaterThanOrEqual(0);
    } else {
      expect(own).toBeNull();
    }
  });
});
