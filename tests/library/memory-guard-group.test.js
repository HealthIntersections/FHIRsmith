/**
 * The memory guard with a role (master, tx-worker): the measure is the cgroup's private
 * memory (memory.stat anon), and over the abort threshold every process aborts its operations.
 * A fake cgroup directory stands in for /sys/fs/cgroup/<service>.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const memoryGuard = require('../../library/memory-guard');

const GB = 1024 * 1024 * 1024;

describe('memory-guard, a group of processes in one cgroup', () => {
  let dir;
  let rssSpy;
  let other;

  const writeCgroup = (anon, pids) => {
    fs.writeFileSync(path.join(dir, 'memory.stat'), `file 123\nanon ${anon}\nshmem 0\n`);
    fs.writeFileSync(path.join(dir, 'cgroup.procs'), pids.join('\n') + '\n');
  };
  const configure = () => memoryGuard.configure({ limit: 10 * GB, rejectFraction: 0.8, abortFraction: 0.9, group: true, cgroup: { dir, version: 2 } });

  beforeAll(async () => {
    // another process in the "cgroup", with an RSS of a few tens of MB
    other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await new Promise(resolve => setTimeout(resolve, 300));
  });
  afterAll(async () => {
    await new Promise(resolve => {
      other.once('exit', resolve);
      other.kill();
    });
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgroup-'));
    rssSpy = jest.spyOn(process.memoryUsage, 'rss');
  });
  afterEach(() => {
    rssSpy.mockRestore();
    memoryGuard.configure();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('refuses on the group measure, though this process is small', () => {
    rssSpy.mockReturnValue(1024 * 1024);
    writeCgroup(Math.round(8.5 * GB), [process.pid]);
    configure();
    expect(memoryGuard.describe()).toMatch(/for the whole cgroup/);
    expect(memoryGuard.shouldReject()).toBe(true);
    writeCgroup(1 * GB, [process.pid]);
    memoryGuard._state.sampleTime = 0;
    expect(memoryGuard.shouldReject()).toBe(false);
  });

  test('over the abort threshold, a small process aborts its operations though a larger one is idle', () => {
    // the failure this guards against: a large idle master, and a worker's runaway $expand
    // taking the group over. The worker must abort, or the kernel's OOM killer acts
    const realRead = fs.readFileSync;
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => {
      if (file === `/proc/${other.pid}/status`) return `VmRSS:\t${6 * 1024 * 1024} kB\nRssFile:\t0 kB\n`;
      return realRead(file, ...rest);
    });
    try {
      writeCgroup(Math.round(9.5 * GB), [process.pid, other.pid]);
      configure();
      rssSpy.mockReturnValue(3 * GB);
      expect(memoryGuard.overAbortThreshold('test')).toBeGreaterThan(9 * GB);
      // under the threshold, nothing aborts
      writeCgroup(Math.round(8.5 * GB), [process.pid, other.pid]);
      memoryGuard._state.sampleTime = 0;
      expect(memoryGuard.overAbortThreshold('test')).toBe(0);
    } finally {
      readSpy.mockRestore();
    }
  });

  test('without a cgroup of its own, each process measures its own RSS', () => {
    memoryGuard.configure({ limit: 10 * GB, rejectFraction: 0.8, group: true, cgroup: null });
    expect(memoryGuard._state.group).toBeNull();
    expect(memoryGuard.describe()).toMatch(/measured as this process's RSS/);
    rssSpy.mockReturnValue(1024 * 1024);
    expect(memoryGuard.shouldReject()).toBe(false);
  });

  test('no role: no group, and the describe text is as it was', () => {
    memoryGuard.configure({ limit: 10 * GB });
    expect(memoryGuard._state.group).toBeNull();
    expect(memoryGuard.describe()).toMatch(/^Memory limit: 10.0 GB \(from configured\); new requests/);
  });
});
