const fs = require('fs');
const os = require('os');
const path = require('path');
const { readCgroupMemoryLimit } = require('../../library/cgroup-memory');

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
