//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// The queue runner (rest/queue/runner.js) and who runs it: one process, the jobs process
// under the cluster or the only process without it.

const { QueueRunner } = require('../../rest/queue/runner');
const { engines, makeApp } = require('./helpers');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

describe('QueueRunner', () => {
  test('a task never overlaps itself, and stop waits for what is running', async () => {
    const runner = new QueueRunner('/x', quiet);
    let running = 0;
    let most = 0;
    let runs = 0;
    let release;
    runner.every(5, 'slow', async () => {
      running++;
      runs++;
      most = Math.max(most, running);
      await new Promise(r => {
        release = r;
      });
      running--;
    });
    runner.start();
    await new Promise(r => setTimeout(r, 60));
    expect(most).toBe(1);
    expect(runs).toBe(1);
    const stopped = runner.stop();
    let done = false;
    stopped.then(() => {
      done = true;
    });
    await new Promise(r => setTimeout(r, 10));
    expect(done).toBe(false);
    release();
    await stopped;
    expect(running).toBe(0);
  });

  test('what the status page shows of a task: runs, time taken, failures, and whether the last run failed', async () => {
    const runner = new QueueRunner('/x', quiet);
    let fail = true;
    runner.every(1000, 'job', async () => {
      await new Promise(r => setTimeout(r, 20));
      if (fail) {
        throw new Error('no');
      }
    });
    expect(runner.describe()[0]).toMatchObject({ name: 'job', everyMs: 1000, runs: 0, failures: 0, running: null, lastAt: null, failing: false });
    const p = runner.runNow('job');
    expect(runner.describe()[0].running).toEqual(expect.any(Number));
    await p;
    expect(runner.describe()[0]).toMatchObject({ runs: 1, failures: 1, failing: true, lastError: 'no', running: null });
    expect(runner.describe()[0].lastMs).toBeGreaterThanOrEqual(15);
    fail = false;
    await runner.runNow('job');
    // the failure is still counted, but the task isn't failing now
    expect(runner.describe()[0]).toMatchObject({ runs: 2, failures: 1, failing: false, lastError: 'no' });
  });

  test('a failure is logged, and the task runs again', async () => {
    const errors = [];
    const runner = new QueueRunner('/x', { ...quiet, error: (m) => errors.push(m) });
    let n = 0;
    runner.every(1000, 'flaky', async () => {
      n++;
      if (n === 1) {
        throw new Error('boom');
      }
    });
    await runner.runNow('flaky');
    await runner.runNow('flaky');
    expect(n).toBe(2);
    expect(errors).toEqual(['Rest /x: flaky failed: boom']);
    await expect(runner.runNow('nothing')).rejects.toThrow(/No queue task/);
  });
});

describe.each(engines())('who runs the jobs (%s)', (engine) => {
  test('the master, without the cluster; not a master that leaves them to the jobs process; the jobs process', async () => {
    const one = await makeApp(engine, { keep: true });
    try {
      expect(one.ep.runner).not.toBeNull();
      expect(one.ep.runner.tasks.map(t => t.name)).toEqual(['search cleanup', 'closure update', 'package loads', 'value set membership', 'reindexing',
        'async requests', 'async tidy', 'queue status']);
      // what the status page shows of them (not the measuring itself)
      await one.ep.runner.runNow('queue status');
      const status = one.ep.jobStatus();
      expect(status.path).toBe('/r4');
      expect(status.tasks.map(t => t.name)).not.toContain('queue status');
      expect(status.queues.async).toEqual({ queued: 0, running: 0, failed: 0, oldestWaitingMs: null, waited: null, took: null });
      expect(status.queues.reindex).toEqual({ active: false });
      expect(one.mod.jobStatus()).toEqual([status]);
      const master = await makeApp(engine, { dir: one.dir, keep: true, jobs: false });
      try {
        expect(master.ep.runner).toBeNull();
        expect(master.ep.jobStatus()).toBeNull();
        expect(master.mod.jobStatus()).toBeNull();
      } finally {
        await master.stop();
      }
      const jobs = await makeApp(engine, { dir: one.dir, keep: true, master: false, jobs: true, localBase: 'http://127.0.0.1:20000' });
      try {
        expect(jobs.ep.runner).not.toBeNull();
        // a terminology server on this server is reached through the front door
        expect(jobs.ep.terminologyServer('/tx/r5')).toBe('http://127.0.0.1:20000/tx/r5');
        expect(jobs.ep.terminologyServer('https://tx.fhir.org/r4')).toBe('https://tx.fhir.org/r4');
        expect(one.ep.terminologyServer('/tx/r5')).toBe('/tx/r5');
        // and it does the work: the reindexing task runs
        await jobs.ep.runner.runNow('reindexing');
      } finally {
        await jobs.stop();
      }
    } finally {
      await one.close();
      if (engine === 'sqlite') {
        require('fs').rmSync(one.dir, { recursive: true, force: true });
      }
    }
  });
});
