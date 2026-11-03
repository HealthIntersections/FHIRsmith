//
// Cluster mode, in the primary (cluster.js): the memory of the whole service.
//
// Every worker reports its RSS every second (library/memory-guard.js). Once a second
// the primary measures the group - the cgroup's private memory where the service has a
// cgroup of its own with a limit, else the sum of the workers' RSS and its own - and
// sends every worker the table of RSS per worker and the total. The workers use it to
// refuse new requests when the group is over the reject threshold, and to decide which of
// them aborts operations when it is over the abort threshold (memory-guard.js).
//
// If the group stays over the reject threshold (recycleAfterSeconds, default 60), no
// request is being served anywhere and aborting has not brought it back, so the primary
// recycles the largest worker: it asks it to drain - stop taking connections (the
// primary then gives them to the others), finish the requests it has (up to
// drainSeconds, default 30), and exit - and cluster.js starts it again. One worker at a
// time; while the group stays over, each further recycle waits twice as long as the one
// before (up to 15 minutes), so a service whose workers are simply too big for the limit
// doesn't restart them in a loop.
//

const memoryGuard = require('./memory-guard');
const { readCgroupAnon } = require('./cgroup-memory');

const DEFAULT_RECYCLE_AFTER_MS = 60 * 1000;
const DEFAULT_DRAIN_MS = 30 * 1000;
const MAX_RECYCLE_WAIT_MS = 15 * 60 * 1000;
// a drained worker that hasn't exited this long after its deadline is killed
const DRAIN_KILL_GRACE_MS = 10 * 1000;

function gb(bytes) {
  return (bytes / 1024 / 1024 / 1024).toFixed(2);
}

class ClusterMemory {
  /**
   * @param {Object} opts
   * @param {Object} [opts.memory] - config.server.memory
   * @param {Function} opts.log - (message) => void
   * @param {Function} [opts.now] - clock (tests)
   * @param {Function} [opts.ownRss] - this process's RSS (tests)
   * @param {Function} [opts.readGroup] - the cgroup measure (tests)
   */
  constructor(opts = {}) {
    const memory = opts.memory || {};
    const r = memoryGuard.resolveLimit(memory);
    this.limit = r.limit;
    this.source = r.source;
    this.measure = r.measure;
    this.cgroup = r.cgroup;
    const frac = (v, d) => (typeof v === 'number' && v > 0 && v <= 1 ? v : d);
    this.rejectAt = this.limit * frac(memory.rejectFraction, 0.85);
    this.abortAt = this.limit * frac(memory.abortFraction, 0.92);
    this.recycleAfterMs = memory.recycleAfterSeconds === 0 ? 0
      : (memory.recycleAfterSeconds > 0 ? memory.recycleAfterSeconds * 1000 : DEFAULT_RECYCLE_AFTER_MS);
    this.drainMs = memory.drainSeconds > 0 ? memory.drainSeconds * 1000 : DEFAULT_DRAIN_MS;
    this.log = opts.log || (() => {});
    this.now = opts.now || Date.now;
    this.ownRss = opts.ownRss || (() => process.memoryUsage.rss());
    this.readGroup = opts.readGroup || (() => readCgroupAnon(this.cgroup));
    this.workers = new Map(); // pid -> { worker, rss, listening, draining }
    this.overSince = 0;
    this.recycles = 0;        // recycles in the current spell over the threshold
    this.lastTotal = 0;
    this.timer = null;
  }

  describe() {
    return `memory: limit ${gb(this.limit)} GB for the service (from ${this.source}), measured as ` +
      (this.measure === 'cgroup' ? `the cgroup's private memory (${this.cgroup.dir})` : 'the sum of the processes\' RSS') +
      `; refuse above ${gb(this.rejectAt)} GB, abort in the largest worker above ${gb(this.abortAt)} GB` +
      (this.recycleAfterMs ? `, recycle the largest after ${this.recycleAfterMs / 1000} s over ${gb(this.rejectAt)} GB` : ', no recycling');
  }

  start(interval = 1000) {
    this.timer = setInterval(() => this.tick(), interval);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** A worker has been forked: listen for its reports. */
  add(worker) {
    const entry = { worker, rss: 0, listening: false, draining: false, killTimer: null };
    this.workers.set(worker.process.pid, entry);
    worker.on('message', (msg) => {
      if (msg && msg.fhirsmith === 'memory-rss' && typeof msg.rss === 'number') {
        entry.rss = msg.rss;
      }
    });
  }

  listening(worker) {
    const e = this.workers.get(worker.process.pid);
    if (e) {
      e.listening = true;
    }
  }

  remove(worker) {
    const e = this.workers.get(worker.process.pid);
    if (e && e.killTimer) {
      clearTimeout(e.killTimer);
    }
    this.workers.delete(worker.process.pid);
  }

  /** The group's private memory now. */
  total() {
    if (this.measure === 'cgroup') {
      const v = this.readGroup();
      if (v > 0) {
        return v;
      }
    }
    let sum = this.ownRss();
    for (const e of this.workers.values()) {
      sum += e.rss;
    }
    return sum;
  }

  /** Once a second: measure, tell the workers, and recycle if the group stays over. */
  tick() {
    const total = this.total();
    this.lastTotal = total;
    const table = [...this.workers].map(([pid, e]) => [pid, e.rss]);
    for (const e of this.workers.values()) {
      try {
        if (e.worker.isConnected()) {
          e.worker.send({ fhirsmith: 'memory', total, workers: table });
        }
      } catch {
        // gone: its exit is handled elsewhere
      }
    }
    this.checkRecycle(total);
  }

  /**
   * @returns {Object|null} the worker asked to drain, if one was
   */
  checkRecycle(total) {
    const now = this.now();
    if (total <= this.rejectAt) {
      if (this.overSince) {
        this.log(`memory: the service is back under ${gb(this.rejectAt)} GB (${gb(total)} GB)`);
      }
      this.overSince = 0;
      this.recycles = 0;
      return null;
    }
    if (!this.overSince) {
      this.overSince = now;
      this.log(`memory: the service is over ${gb(this.rejectAt)} GB (${gb(total)} GB of ${gb(this.limit)} GB); workers refuse new requests`);
    }
    if (!this.recycleAfterMs) {
      return null;
    }
    const entries = [...this.workers.values()];
    // one at a time, and not while a worker is starting (it isn't serving yet)
    if (entries.some(e => e.draining || !e.listening) || entries.length < 2) {
      return null;
    }
    const wait = Math.min(this.recycleAfterMs * 2 ** this.recycles, MAX_RECYCLE_WAIT_MS);
    if (now - this.overSince < wait) {
      return null;
    }
    const largest = entries.reduce((a, b) => (b.rss > a.rss ? b : a));
    this.recycles++;
    this.overSince = now; // the next one, if needed, waits from here
    this.drain(largest, total, wait);
    return largest.worker;
  }

  drain(entry, total, waited) {
    entry.draining = true;
    const pid = entry.worker.process.pid;
    this.log(`memory: the service has been over ${gb(this.rejectAt)} GB for ${Math.round(waited / 1000)} s ` +
      `(${gb(total)} GB of ${gb(this.limit)} GB); recycling the largest worker, pid ${pid} (${gb(entry.rss)} GB): ` +
      `it takes no new connections and has ${this.drainMs / 1000} s to finish its requests`);
    entry.worker.recycled = true;
    try {
      entry.worker.send({ fhirsmith: 'drain', deadlineMs: this.drainMs });
    } catch {
      // already going
    }
    entry.killTimer = setTimeout(() => {
      if (!entry.worker.isDead()) {
        this.log(`memory: worker pid ${pid} did not exit after draining; killing it`);
        try {
          entry.worker.process.kill('SIGKILL');
        } catch {
          // gone
        }
      }
    }, this.drainMs + DRAIN_KILL_GRACE_MS);
    if (entry.killTimer.unref) {
      entry.killTimer.unref();
    }
  }
}

module.exports = { ClusterMemory };
