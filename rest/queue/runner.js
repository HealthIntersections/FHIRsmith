//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The queue runner: the work an endpoint does in the background, from its database. Each
 * task runs every so often and never overlaps itself; a task that claims work from a queue
 * table (async requests, later subscriptions) does one piece at a time.
 *
 * One process runs it: the jobs process under the cluster (`--role=jobs`, library/role.js),
 * or the only process without one. Nothing in a task depends on which process that is: what
 * it works on is all in the database.
 *
 * @module rest/queue/runner
 */

class QueueRunner {
  /**
   * @param {string} name - for the log (the endpoint's path)
   * @param {Object} log - info, warn, error
   */
  constructor(name, log) {
    this.name = name;
    this.log = log;
    this.tasks = [];
    this.started = false;
  }

  /**
   * A task, run every `ms` once started; a run that is still going when the next is due is
   * left to finish (the next waits for the one after)
   * @param {number} ms
   * @param {string} name - for the log
   * @param {function(): Promise<*>} fn
   */
  every(ms, name, fn) {
    // (and what the status page shows of it: describe())
    const task = { ms, name, fn, timer: null, running: null, runs: 0, failures: 0, startedAt: null, finishedAt: null, lastMs: null,
      lastError: null, lastErrorAt: null, failing: false };
    this.tasks.push(task);
    if (this.started) {
      this.schedule(task);
    }
    return this;
  }

  schedule(task) {
    task.timer = setInterval(() => {
      this.run(task);
    }, task.ms);
    task.timer.unref();
  }

  /** Run a task now (unless it is running): what its timer does */
  run(task) {
    if (task.running) {
      return task.running;
    }
    const started = Date.now();
    task.startedAt = started;
    task.running = Promise.resolve()
      .then(() => task.fn())
      .then(() => {
        task.failing = false;
      }, (e) => {
        task.failures++;
        task.failing = true;
        task.lastError = String(e.message || e);
        task.lastErrorAt = Date.now();
        this.log.error(`Rest ${this.name}: ${task.name} failed: ${e.message}`);
      })
      .finally(() => {
        task.runs++;
        task.finishedAt = Date.now();
        task.lastMs = task.finishedAt - started;
        task.running = null;
      });
    return task.running;
  }

  /** Run the named task now, and wait for it (tests; the admin pages) */
  async runNow(name) {
    const task = this.tasks.find(t => t.name === name);
    if (!task) {
      throw new Error(`No queue task '${name}'`);
    }
    if (task.running) {
      await task.running;
    }
    return this.run(task);
  }

  /**
   * The tasks, for the status page: [{name, everyMs, runs, failures, running (since, or null),
   * lastAt (when the last run finished), lastMs, failing (the last run failed), lastError,
   * lastErrorAt}]
   */
  describe() {
    return this.tasks.map(t => ({
      name: t.name, everyMs: t.ms, runs: t.runs, failures: t.failures, running: t.running ? t.startedAt : null,
      lastAt: t.finishedAt, lastMs: t.lastMs, failing: t.failing, lastError: t.lastError, lastErrorAt: t.lastErrorAt
    }));
  }

  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    for (const t of this.tasks) {
      this.schedule(t);
    }
  }

  /** Stop the timers, and wait for the tasks that are running */
  async stop() {
    this.started = false;
    for (const t of this.tasks) {
      clearInterval(t.timer);
      t.timer = null;
    }
    await Promise.all(this.tasks.map(t => t.running).filter(Boolean));
  }
}

module.exports = { QueueRunner };
