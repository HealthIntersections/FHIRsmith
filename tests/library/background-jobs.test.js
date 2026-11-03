/**
 * The background-jobs lock: with several processes on one data directory, exactly
 * one runs the timed jobs, and another takes over when it stops.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BackgroundJobs } = require('../../library/background-jobs');

describe('background jobs lock', () => {
  let dir;
  let file;
  const made = [];
  const make = (opts = {}) => {
    const b = new BackgroundJobs().configure({ enabled: true, path: file, ...opts });
    made.push(b);
    return b;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'background-jobs-'));
    file = path.join(dir, 'background-jobs.lock');
  });
  afterEach(() => {
    while (made.length) {
      made.pop().close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('without a lock (one process) every job runs', () => {
    const b = new BackgroundJobs().configure({ enabled: false });
    expect(b.isLeader()).toBe(true);
    expect(b.holder()).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  test('exactly one of several processes runs the jobs, and keeps running them', () => {
    const a = make();
    const b = make();
    const c = make();
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
    expect(c.isLeader()).toBe(false);
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
    expect(a.holder().me).toBe(true);
    expect(b.holder().me).toBe(false);
    expect(b.holder().pid).toBe(process.pid);
  });

  test('when the holder shuts down, the next process to ask takes over at once', () => {
    const a = make();
    const b = make();
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
    a.close();
    expect(b.isLeader()).toBe(true);
  });

  test('a holder that stops renewing (crashed or hung) is taken over after staleMs, not before', () => {
    const a = make({ staleMs: 60000 });
    const b = make({ staleMs: 60000 });
    expect(a.isLeader()).toBe(true);
    const lock = a.db;
    lock.prepare('UPDATE holder SET renewed = ?').run(Date.now() - 30000);
    expect(b.isLeader()).toBe(false);
    lock.prepare('UPDATE holder SET renewed = ?').run(Date.now() - 61000);
    expect(b.isLeader()).toBe(true);
    // and the old holder learns it has lost it
    expect(a.isLeader()).toBe(false);
  });

  test('if the lock cannot be read, the job is not run (never two at once)', () => {
    const a = make();
    a.q.get = { get: () => { throw new Error('disk I/O error'); } };
    expect(a.isLeader()).toBe(false);
  });
});
