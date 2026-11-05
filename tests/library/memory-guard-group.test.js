/**
 * The memory guard with a role (master, tx-worker): the measure is the cgroup's private
 * memory (memory.stat anon), and only the largest process in the cgroup aborts.
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

  test('over the abort threshold, only the largest process aborts', () => {
    writeCgroup(Math.round(9.5 * GB), [process.pid, other.pid]);
    configure();
    // smaller than the other process: its operations carry on
    rssSpy.mockReturnValue(1024 * 1024);
    expect(memoryGuard.overAbortThreshold('test')).toBe(0);
    // the largest: it aborts (the answer is kept for 100 ms)
    rssSpy.mockReturnValue(5 * GB);
    return new Promise(resolve => setTimeout(resolve, 150)).then(() => {
      expect(memoryGuard.overAbortThreshold('test')).toBeGreaterThan(9 * GB);
    });
  });

  test('without a cgroup of its own, each process measures its own RSS', () => {
    memoryGuard.configure({ limit: 10 * GB, rejectFraction: 0.8, group: true, cgroup: null });
    expect(memoryGuard._state.group).toBeNull();
    expect(memoryGuard.describe()).toMatch(/measured as this process's RSS/);
    rssSpy.mockReturnValue(1024 * 1024);
    expect(memoryGuard.shouldReject()).toBe(false);
  });

  (process.platform === 'linux' ? test : test.skip)('with mapped files, only the process with the largest private RSS aborts', () => {
    const realRead = fs.readFileSync;
    let ownFileGB = 4;
    let otherRssGB = 12;
    let otherFileGB = 11;
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...rest) => {
      if (file === '/proc/self/status') return `RssFile:\t${ownFileGB * 1024 * 1024} kB\n`;
      if (file === `/proc/${other.pid}/status`) {
        return `VmRSS:\t${otherRssGB * 1024 * 1024} kB\nRssFile:\t${otherFileGB * 1024 * 1024} kB\n`;
      }
      return realRead(file, ...rest);
    });
    let now = Date.now() + 1000;
    const timeSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      writeCgroup(9.5 * GB, [process.pid, other.pid]);
      configure();
      memoryGuard.measureExcludingFileBacked();
      rssSpy.mockReturnValue(6 * GB); // 2 GB private versus the other's 1 GB.
      expect(memoryGuard.shouldReject()).toBe(true); // The group remains over its threshold.
      expect(memoryGuard.overAbortThreshold('test')).toBe(9.5 * GB);

      now += 1000;
      ownFileGB = 10;
      otherRssGB = 6;
      otherFileGB = 3;
      rssSpy.mockReturnValue(11 * GB); // 1 GB private versus the other's 3 GB.
      expect(memoryGuard.overAbortThreshold('test')).toBe(0);
    } finally {
      memoryGuard._state.excludeFileBacked = false;
      timeSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  test('no role: no group, and the describe text is as it was', () => {
    memoryGuard.configure({ limit: 10 * GB });
    expect(memoryGuard._state.group).toBeNull();
    expect(memoryGuard.describe()).toMatch(/^Memory limit: 10.0 GB \(from configured\); new requests/);
  });
});
