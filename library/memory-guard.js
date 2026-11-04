/**
 * Process memory guard - the one place that decides how close to its memory limit the
 * server is, so the request gate (503) and the in-operation check (deadCheck, 422) agree.
 *
 * One process (server.js): what follows, measured against the process's RSS.
 *
 * Cluster mode (cluster.js, more than one worker): the limit is the whole service's,
 * and so is the measure - the workers share one cgroup, and one worker staying under a
 * per-worker share does nothing for the group when another is far over it. The measure:
 *  - "cgroup": the private memory (memory.stat anon; v1 total_rss) of the cgroup the
 *    service runs in, read by each worker directly. Used on Linux when the service's
 *    own cgroup has a memory limit (MemoryMax on the unit or scope, a container limit).
 *  - "processes": the sum of every worker's RSS, which the primary collects over IPC
 *    and sends back to each worker every second (library/cluster-memory.js). Used
 *    everywhere else (macOS, Windows, a Linux service with no cgroup limit of its own).
 * server.memory.measure ("cgroup" | "processes") forces one. The limit: server.memory.limit
 * if set (for the group), else the cgroup limit, else the machine's RAM.
 *  - rejectFraction: every worker refuses new requests while the group is over it.
 *  - abortFraction: when the group is over it, running operations are aborted only in a
 *    worker that is the largest (by RSS), or holds more than 1.5 times its fair share
 *    (abortAt / workers). The others carry on: aborting their work frees little, and a
 *    single heavy worker would otherwise abort everyone's operations. If the group stays
 *    over, the primary drains and restarts the largest worker (cluster.js).
 *
 * The limit is the cgroup limit the kernel will enforce (MemoryMax on the systemd unit, or
 * the container limit); with none, the machine's total RAM. Two thresholds, as fractions of
 * the limit, both measured against process RSS:
 *
 *  - rejectFraction: new requests get 503 + Retry-After before any work (or body parsing)
 *    is done. Shedding load early is what gives in-flight work and the GC room to recover.
 *  - abortFraction:  operations already running are aborted at their next deadCheck (422
 *    too-costly). Higher than rejectFraction, so the gate acts first.
 *
 * Both are configurable in config.server.memory: { "rejectFraction": 0.85, "abortFraction": 0.92 }
 *
 * @module library/memory-guard
 */

const os = require('os');
const path = require('path');
const v8 = require('v8');
const vm = require('vm');
const { readCgroupMemoryLimit, ownCgroupDir, readCgroupAnon } = require('./cgroup-memory');

const DEFAULT_REJECT_FRACTION = 0.85;
const DEFAULT_ABORT_FRACTION = 0.92;
// RSS is cheap to read, but the gate runs on every request; a sample this old is fine
const SAMPLE_MS = 250;
// While refusing, force a full GC at most this often. Refusing requests removes the
// allocation activity that would otherwise trigger one, so without this RSS might never
// fall back below the threshold and the server would stay shut.
const GC_INTERVAL_MS = 5000;
// A forced GC that leaves the server still over the threshold doubles the wait before the
// next, up to this: when most of RSS is outside the JS heap (the SNOMED and LOINC cache
// buffers), collecting frees little, and every full GC stops the process
const GC_MAX_INTERVAL_MS = 60000;

// Cluster mode: a worker aborts operations only if it is the largest, or holds more than
// this many times its share of the abort threshold
const HEAVY_SHARE = 1.5;
// how often a worker tells the primary its RSS (and the primary tells the workers the group's)
const REPORT_MS = 1000;
// the group measure is read at most this often by the in-operation check
const GROUP_SAMPLE_MS = 100;
// one process: the in-operation check reuses a measure at most this old. It runs about ten
// times a request, and RSS moves little in 10 ms
const ABORT_SAMPLE_MS = 10;

const state = {
  limit: 0,
  source: null,
  rejectFraction: DEFAULT_REJECT_FRACTION,
  abortFraction: DEFAULT_ABORT_FRACTION,
  rejectAt: 0,
  abortAt: 0,
  sampleTime: 0,
  sampleRss: 0, // the last measure: this process's RSS, or in cluster mode the group's
  // cluster mode (null: one process)
  group: null
};

/**
 * The limit to work against: the configured one, else the cgroup's, else the machine's RAM,
 * and how the group is measured in cluster mode (see the header). Shared with the primary
 * (library/cluster-memory.js), so both sides agree.
 * @param {object} opts - config.server.memory
 * @returns {{limit: number, source: string, measure: string, cgroup: Object|null}}
 */
function resolveLimit(opts = {}) {
  let limit = opts.limit;
  let source = limit ? 'configured' : null;
  const cg = readCgroupMemoryLimit(opts.cgroupOptions);
  if (!limit) {
    limit = cg.limit;
    source = cg.source;
  }
  if (!limit) {
    limit = os.totalmem();
    source = 'os.totalmem()';
  }
  // cgroup measure only for a cgroup that is the service's own: one with a limit set on it
  const own = ownCgroupDir(opts.cgroupOptions);
  const ownLimited = own && cg.source && path.dirname(cg.source) === own.dir;
  let measure = opts.measure === 'cgroup' || opts.measure === 'processes' ? opts.measure : null;
  if (!measure) {
    measure = ownLimited && readCgroupAnon(own) > 0 ? 'cgroup' : 'processes';
  }
  if (measure === 'cgroup' && !own) {
    measure = 'processes';
  }
  return { limit, source, measure, cgroup: measure === 'cgroup' ? own : null };
}

function fraction(v, dflt) {
  return (typeof v === 'number' && v > 0 && v <= 1) ? v : dflt;
}

/**
 * (Re)initialise. Called once at startup from server.js with config.server.memory; the module
 * also self-initialises with defaults so code that loads without server.js (tests, tools) works.
 * @param {object} [opts] - { rejectFraction, abortFraction, limit (bytes, for tests) }
 */
function configure(opts = {}) {
  stopGroup();
  const { limit, source, measure, cgroup } = resolveLimit(opts);
  state.limit = limit;
  state.source = source;
  state.rejectFraction = fraction(opts.rejectFraction, DEFAULT_REJECT_FRACTION);
  state.abortFraction = fraction(opts.abortFraction, DEFAULT_ABORT_FRACTION);
  state.rejectAt = limit * state.rejectFraction;
  state.abortAt = limit * state.abortFraction;
  state.sampleTime = 0;
  // cluster mode: a worker of a cluster of more than one, or as a test asks
  const size = opts.group ? opts.group.size : (clusterWorker() ? Number(process.env.FHIRSMITH_CLUSTER_SIZE) || 0 : 0);
  if (size > 1) {
    startGroup({ size, measure, cgroup, report: opts.group ? opts.group.report : undefined });
  }
}

function clusterWorker() {
  return typeof process.send === 'function' && require('cluster').isWorker;
}

/**
 * Cluster mode, in a worker: report this process's RSS to the primary every second, and
 * take what the primary says about the group (every worker's RSS; in the "processes"
 * measure, the group's total).
 */
function startGroup({ size, measure, cgroup, report }) {
  const g = {
    size, measure, cgroup,
    workers: new Map(), // pid -> rss, as the primary last reported
    total: 0,           // the primary's measure of the group ("processes")
    totalSelf: 0,       // what that total counted for this process
    spared: 0,
    lastSpareLog: 0,
    drainHandler: null,
    report: report || ((msg) => {
      if (process.connected) {
        process.send(msg);
      }
    })
  };
  state.group = g;
  const send = () => {
    try {
      g.report({ fhirsmith: 'memory-rss', rss: ownRss() });
    } catch {
      // the primary has gone; it will take this worker with it
    }
  };
  if (!g.listener) {
    g.listener = (msg) => handleMessage(msg);
    process.on('message', g.listener);
  }
  send();
  g.timer = setInterval(send, REPORT_MS);
  if (g.timer.unref) {
    g.timer.unref();
  }
}

function stopGroup() {
  const g = state.group;
  if (g) {
    clearInterval(g.timer);
    if (g.listener) {
      process.removeListener('message', g.listener);
    }
    state.group = null;
  }
}

/**
 * A message from the primary (cluster.js): {fhirsmith: 'memory', total, workers: [[pid, rss]...]},
 * or {fhirsmith: 'drain', deadlineMs}. Exported for tests.
 */
function handleMessage(msg) {
  const g = state.group;
  if (!g || !msg || typeof msg !== 'object') {
    return;
  }
  if (msg.fhirsmith === 'memory') {
    g.workers = new Map(msg.workers || []);
    g.total = msg.total || 0;
    g.totalSelf = g.workers.get(process.pid) || 0;
    state.sampleTime = 0; // measure again with this
  } else if (msg.fhirsmith === 'drain' && g.drainHandler) {
    g.drainHandler(msg.deadlineMs);
  }
}

/**
 * Cluster mode: what to do when the primary asks this worker to drain (stop taking
 * connections, finish what it has, exit) so that it can be restarted. server.js sets it.
 * @param {Function} fn - (deadlineMs) => void
 */
function onDrain(fn) {
  if (state.group) {
    state.group.drainHandler = fn;
  }
}

/** The group's private memory, now (cluster mode). */
function groupMeasure() {
  const g = state.group;
  if (g.measure === 'cgroup') {
    const v = readCgroupAnon(g.cgroup);
    if (v > 0) {
      return v;
    }
  }
  // the primary's total, with this process's part brought up to date
  const own = ownRss();
  return g.total > 0 ? Math.max(own, g.total - g.totalSelf + own) : own;
}

/**
 * Cluster mode: should this worker abort its operations when the group is over the abort
 * threshold? Yes if it is the largest worker (by RSS; the primary's last report for the
 * others, its own now), or holds more than HEAVY_SHARE times its share of the threshold.
 * @param {number} own - this process's RSS
 * @param {Map<number, number>} workers - pid -> RSS of the workers (may include this one)
 * @param {number} size - how many workers
 * @param {number} abortAt - the group's abort threshold
 * @param {number} [pid] - this process (ties go to the lower pid)
 * @returns {boolean}
 */
function abortsHere(own, workers, size, abortAt, pid = process.pid) {
  if (own > HEAVY_SHARE * abortAt / size) {
    return true;
  }
  for (const [p, rss] of workers) {
    if (p !== pid && (rss > own || (rss === own && p < pid))) {
      return false;
    }
  }
  return true;
}

/** This process's memory, as the guard counts it (in cluster mode, its part of the group). */
function ownRss() {
  return process.memoryUsage.rss();
}

/**
 * The measure the thresholds apply to: this process's RSS, or in cluster mode the group's
 * private memory. A sample at most SAMPLE_MS old unless fresh.
 */
function rss(fresh = false) {
  const now = Date.now();
  if (fresh || now - state.sampleTime > SAMPLE_MS) {
    state.sampleRss = state.group ? groupMeasure() : ownRss();
    state.sampleTime = now;
  }
  return state.sampleRss;
}

/** True if new requests should be refused (uses a sample at most SAMPLE_MS old). */
function shouldReject() {
  return state.rejectAt > 0 && rss() > state.rejectAt;
}

let gcFn;

/**
 * global.gc if node was started with --expose-gc, which is how it should be started (the
 * Dockerfile and npm start do; add it to the node command of a systemd unit). Otherwise
 * expose it at runtime: the flag can be set late, and a fresh context then has gc - this
 * works, but Node does not promise it will keep working. null if neither works.
 */
function getGc() {
  if (gcFn !== undefined) {
    return gcFn;
  }
  gcFn = null;
  if (typeof global.gc === 'function') {
    gcFn = global.gc;
  } else {
    try {
      v8.setFlagsFromString('--expose-gc');
      const fn = vm.runInNewContext('gc');
      if (typeof fn === 'function') {
        gcFn = fn;
      }
    } catch {
      // no gc available - the guard still works, it just recovers more slowly
    }
  }
  return gcFn;
}

let aborts = 0;
let lastAbortLog = 0;
let abortLog = null;

/**
 * Current RSS in bytes if running operations should be aborted, else 0. A measure at most
 * ABORT_SAMPLE_MS old (in cluster mode, the group's measure at most GROUP_SAMPLE_MS old), or
 * fresh if the sample was dropped (configure, a report from the primary).
 * A trip is written to the server log (at most once a minute, with a running count) - the
 * caller's own message only goes to the aborted operation's diagnostics.
 * @param {string} [place] - where the check was made, for the log
 */
function overAbortThreshold(place = 'unknown') {
  if (state.abortAt <= 0) {
    return 0;
  }
  const g = state.group;
  // not a new measure on every check: the group measure reads a file (or adds up reports),
  // and even RSS alone costs a few us, about ten times a request
  const r = rss(Date.now() - state.sampleTime > (g ? GROUP_SAMPLE_MS : ABORT_SAMPLE_MS));
  if (r <= state.abortAt) {
    return 0;
  }
  if (g) {
    const own = ownRss();
    if (!abortsHere(own, g.workers, g.size, state.abortAt)) {
      g.spared++;
      const now = Date.now();
      if (now - g.lastSpareLog > 60000) {
        g.lastSpareLog = now;
        let largest = 0;
        for (const v of g.workers.values()) {
          largest = Math.max(largest, v);
        }
        logWarn(`Memory critical: the service is at ${gb(r)} GB of ${gb(state.limit)} GB, but this worker ` +
          `(${gb(own)} GB) is not the largest (${gb(largest)} GB): its operations carry on (${g.spared} checks so far)`);
      }
      return 0;
    }
  }
  aborts++;
  const now = Date.now();
  if (now - lastAbortLog > 60000) {
    lastAbortLog = now;
    try {
      if (!abortLog) {
        abortLog = require('./logger').getInstance().child({ module: 'memory' });
      }
      abortLog.warn(`Memory critical: ${gb(r)} GB of ${gb(state.limit)} GB` +
        (g ? ` for the service (this worker ${gb(ownRss())} GB, the largest)` : '') +
        ` - aborting running operations (at ${place}; ${aborts} aborted so far)`);
    } catch {
      // logging must never stop the abort
    }
  }
  return r;
}

function logWarn(msg) {
  try {
    if (!abortLog) {
      abortLog = require('./logger').getInstance().child({ module: 'memory' });
    }
    abortLog.warn(msg);
  } catch {
    // logging must never get in the way
  }
}

function gb(bytes) {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

function describe() {
  const g = state.group;
  return `Memory limit: ${gb(state.limit)} GB (from ${state.source})` +
    (g ? ` for the whole service of ${g.size} workers, measured as ${g.measure === 'cgroup' ? 'the cgroup\'s private memory' : 'the sum of the workers\' RSS'}` : '') + '; ' +
    `new requests refused above ${gb(state.rejectAt)} GB (${Math.round(state.rejectFraction * 100)}%), ` +
    `operations aborted above ${gb(state.abortAt)} GB (${Math.round(state.abortFraction * 100)}%)`;
}

/**
 * Express middleware: 503 + Retry-After while RSS is over the reject threshold. Install it
 * before the body parsers so a refused request costs nothing. While refusing, it forces a full
 * GC now and then and re-measures - every gcInterval ms, backing off to gcMaxInterval while
 * the GCs don't bring it back under, and not at all while the JS heap is too small for one to
 * help. It logs when refusing starts (then once a minute, with how long and how many) and
 * when it stops.
 * @param {object} [opts] - { log, exempt: [path prefixes never refused], retryAfter (seconds),
 *   gcInterval (ms), gcMaxInterval (ms), heapUsed (function returning bytes, for tests) }
 */
function middleware(opts = {}) {
  const exempt = opts.exempt || [];
  const retryAfter = String(opts.retryAfter || 30);
  const log = opts.log;
  const gcInterval = opts.gcInterval || GC_INTERVAL_MS;
  const gcMaxInterval = Math.max(opts.gcMaxInterval || GC_MAX_INTERVAL_MS, gcInterval);
  const heapUsed = opts.heapUsed || (() => process.memoryUsage().heapUsed);
  let gcWait = gcInterval; // the current wait between forced GCs (backs off, see below)
  let refusingSince = 0; // when the current spell of refusing began (0 = not refusing)
  let refused = 0;       // refused in the current spell
  let lastLog = 0;
  let lastGc = 0;

  const secs = (ms) => Math.round(ms / 1000);

  return (req, res, next) => {
    if (exempt.some(p => req.path === p || req.path.startsWith(p + '/'))) {
      return next();
    }
    let over = shouldReject();
    const now = Date.now();

    // Refusing starves the GC of the allocation that would normally trigger it, so while
    // refusing, force a full collection now and then and re-measure. Only when it could help:
    // a GC frees heap and nothing else, so if the whole JS heap is smaller than the amount
    // over the threshold, collecting can't get the server back under it. And a GC that
    // leaves the server still over doubles the wait before the next one
    if (over && now - lastGc >= gcWait) {
      lastGc = now;
      const before = state.sampleRss;
      const heap = heapUsed();
      const gc = getGc();
      // in cluster mode every worker refusing does this, so each need only free its share
      const share = state.group ? state.group.size : 1;
      if (heap < (before - state.rejectAt) / share) {
        gcWait = Math.min(gcWait * 2, gcMaxInterval);
        if (log) {
          log.info(`Memory: no forced GC - the JS heap (${gb(heap)} GB) is less than ${share > 1 ? 'its share of ' : ''}the ${gb(before - state.rejectAt)} GB over the threshold; next look in ${secs(gcWait)}s`);
        }
      } else if (gc) {
        try {
          gc();
        } catch {
          // ignore
        }
        const after = rss(true);
        over = after > state.rejectAt;
        gcWait = over ? Math.min(gcWait * 2, gcMaxInterval) : gcInterval;
        if (log) {
          log.info(`Memory: forced GC while refusing - ${gb(before)} GB -> ${gb(after)} GB` +
            (over ? `; next in ${secs(gcWait)}s` : ''));
        }
      }
    }

    if (!over) {
      gcWait = gcInterval;
      if (refusingSince) {
        if (log) {
          log.warn(`Memory recovered: ${gb(state.sampleRss)} GB of ${gb(state.limit)} GB - accepting requests again after ${secs(now - refusingSince)}s (${refused} refused)`);
        }
        refusingSince = 0;
        refused = 0;
      }
      return next();
    }

    if (!refusingSince) {
      refusingSince = now;
      lastLog = 0;
    }
    refused++;
    if (log && now - lastLog > 60000) {
      log.warn(`Memory high: ${gb(state.sampleRss)} GB of ${gb(state.limit)} GB - refusing new requests with 503 for ${secs(now - refusingSince)}s (${refused} refused)`);
      lastLog = now;
    }
    const text = `Server is under memory pressure (${gb(state.sampleRss)} GB of ${gb(state.limit)} GB); try again shortly`;
    res.status(503);
    res.setHeader('Retry-After', retryAfter);
    res.setHeader('Connection', 'close');
    res.setHeader('Content-Type', 'application/fhir+json');
    res.end(JSON.stringify({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'transient', details: { text }, diagnostics: text }]
    }));
  };
}

configure();

module.exports = {
  configure, shouldReject, overAbortThreshold, describe, middleware, gb, getGc, onDrain,
  resolveLimit, abortsHere, handleMessage, HEAVY_SHARE, REPORT_MS, _state: state
};
