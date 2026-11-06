/**
 * Process memory guard - the one place that decides how close to its memory limit the
 * server is, so the request gate (503) and the in-operation check (deadCheck, 422) agree.
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
 * While refusing, the guard looks now and then for memory it can get back: a forced GC (the JS
 * heap), then malloc_trim (memory the C allocator holds free - closed SQLite connections, above
 * all; library/native-memory.js). "trimAllocator": false leaves out the second.
 *
 * A master and its tx-workers (--role, cluster.md) share one cgroup, and the kernel's limit is
 * on all of them together, so with a role (config.server.memory.group) the measure is the
 * group's: the cgroup's private memory (memory.stat anon), read by each process itself. Every
 * process refuses new requests above rejectFraction; above abortFraction every process aborts
 * the operations it has running. Not only the largest: a process's size doesn't say whether it
 * is busy, and a large idle one (the master, say) would leave a worker's runaway $expand to the
 * kernel's OOM killer. This needs a cgroup with a limit of its own (MemoryMax on the unit or
 * scope, a container limit); without one each process measures its own RSS, as one does.
 *
 * @module library/memory-guard
 */

const fs = require('fs');
const os = require('os');
const v8 = require('v8');
const vm = require('vm');
const path = require('path');
const { readCgroupMemoryLimit, ownCgroupDir, readCgroupAnon, readCgroupProcessRss } = require('./cgroup-memory');
const { trimNativeMemory, canTrimNativeMemory } = require('./native-memory');

const DEFAULT_REJECT_FRACTION = 0.85;
const DEFAULT_ABORT_FRACTION = 0.92;
// RSS is cheap to read, but the gate runs on every request; a sample this old is fine
const SAMPLE_MS = 250;
// While refusing, look for memory to get back (a forced GC, then malloc_trim) at most this
// often. Refusing requests removes the allocation activity that would otherwise trigger a GC,
// and nothing returns the C allocator's free memory by itself, so without this RSS might never
// fall back below the threshold and the server would stay shut.
const GC_INTERVAL_MS = 5000;
// A look that gets back less than a tenth of the excess doubles the wait before the next, up
// to this: when most of RSS is in use (the SNOMED and LOINC cache buffers), they free little,
// and every full GC stops the process. One that gets back more keeps the wait: closing
// thousands of SQLite connections takes seconds, and the next look gets back the rest
const GC_MAX_INTERVAL_MS = 60000;
// Between those looks, malloc_trim alone, before a request is refused, at most this often and
// with no back-off: memory used in a burst is freed when the burst ends, and the C allocator
// keeps it resident until asked, so a quiet server could sit just over the threshold and
// refuse everything until the next look, up to GC_MAX_INTERVAL_MS away. With nothing to give
// back, a trim takes milliseconds
const TRIM_INTERVAL_MS = 1000;
// the group measure reads a file: the in-operation check (about ten a request) reuses one
// at most this old
const GROUP_SAMPLE_MS = 100;
// RssFile (/proc/self/status) is read at most this often. The in-operation check runs many
// times a request, and a read of /proc/self/status costs twice what the RSS itself does;
// between reads, a fresh RSS less the last RssFile is a close enough estimate
const FILE_SAMPLE_MS = 200;
// the in-operation check reuses a measure at most this old. It runs about ten times a request,
// and RSS moves little in 10 ms
const ABORT_SAMPLE_MS = 10;

const state = {
  limit: 0,
  source: null,
  rejectFraction: DEFAULT_REJECT_FRACTION,
  abortFraction: DEFAULT_ABORT_FRACTION,
  rejectAt: 0,
  abortAt: 0,
  trimAllocator: true,
  sampleTime: 0,
  sampleRss: 0,
  // a role (master, tx-worker): the cgroup measured, from ownCgroupDir; else null
  group: null,
  groupWanted: false,
  // set by measureExcludingFileBacked()
  excludeFileBacked: false,
  fileTime: 0,
  fileRss: 0 // the last RssFile read (see fileBackedRss)
};

function fraction(v, dflt) {
  return (typeof v === 'number' && v > 0 && v <= 1) ? v : dflt;
}

/**
 * (Re)initialise. Called once at startup from server.js with config.server.memory; the module
 * also self-initialises with defaults so code that loads without server.js (tests, tools) works.
 * @param {object} [opts] - { rejectFraction, abortFraction, limit (bytes, for tests) }
 */
function configure(opts = {}) {
  let limit = opts.limit;
  let source = limit ? 'configured' : null;
  let cg = null;
  if (!limit) {
    cg = readCgroupMemoryLimit();
    limit = cg.limit;
    source = cg.source;
  }
  state.group = null;
  state.groupWanted = !!opts.group;
  if (opts.group) {
    // only a cgroup that is the group's own, with the limit on it
    const own = opts.cgroup !== undefined ? opts.cgroup : ownCgroupDir();
    const limitFile = opts.cgroup !== undefined ? null : (cg || readCgroupMemoryLimit()).source;
    if (own && (opts.cgroup !== undefined || (limitFile && path.dirname(limitFile) === own.dir)) && readCgroupAnon(own) > 0) {
      state.group = own;
    }
  }
  if (!limit) {
    limit = os.totalmem();
    source = 'os.totalmem()';
  }
  state.limit = limit;
  state.source = source;
  state.rejectFraction = fraction(opts.rejectFraction, DEFAULT_REJECT_FRACTION);
  state.abortFraction = fraction(opts.abortFraction, DEFAULT_ABORT_FRACTION);
  state.rejectAt = limit * state.rejectFraction;
  state.abortAt = limit * state.abortFraction;
  state.trimAllocator = opts.trimAllocator !== false;
  state.sampleTime = 0;
}

/**
 * Measure RSS less its file-backed pages (Linux only). With SNOMED CT cache files memory-mapped
 * ("snomed": {"load": "mmap"} in config.json) RSS includes every mapped page that has been read, which the kernel drops
 * and re-reads as it needs to - counting them would refuse requests on a server that is fine.
 */
function measureExcludingFileBacked() {
  state.excludeFileBacked = process.platform === 'linux';
  state.sampleTime = 0;
}

/**
 * RssFile as last read, read again if that was FILE_SAMPLE_MS ago or more, or if the sample
 * has been dropped (sampleTime 0: configure, measureExcludingFileBacked, a test).
 */
function fileBackedRss() {
  const now = Date.now();
  if (state.sampleTime === 0 || now - state.fileTime >= FILE_SAMPLE_MS) {
    state.fileRss = rssFileBytes();
    state.fileTime = now;
  }
  return state.fileRss;
}

function rssFileBytes() {
  try {
    const m = /^RssFile:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/self/status', 'utf8'));
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

/** This process's RSS, less reclaimable file-backed pages when using mapped files. */
function ownRss() {
  return process.memoryUsage.rss() - (state.excludeFileBacked ? fileBackedRss() : 0);
}

function rss(fresh = false) {
  const now = Date.now();
  if (fresh || now - state.sampleTime > SAMPLE_MS) {
    state.sampleRss = (state.group && readCgroupAnon(state.group)) || ownRss();
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
 * ABORT_SAMPLE_MS old (GROUP_SAMPLE_MS for a group; file-backed pages are read at most
 * FILE_SAMPLE_MS ago), or fresh
 * if the sample was dropped (configure, measureExcludingFileBacked).
 * A trip is written to the server log (at most once a minute, with a running count) - the
 * caller's own message only goes to the aborted operation's diagnostics.
 * @param {string} [place] - where the check was made, for the log
 */
function overAbortThreshold(place = 'unknown') {
  if (state.abortAt <= 0) {
    return 0;
  }
  const r = rss(Date.now() - state.sampleTime > (state.group ? GROUP_SAMPLE_MS : ABORT_SAMPLE_MS));
  if (r <= state.abortAt) {
    return 0;
  }
  aborts++;
  const now = Date.now();
  if (now - lastAbortLog > 60000) {
    lastAbortLog = now;
    try {
      if (!abortLog) {
        abortLog = require('./logger').getInstance().child({ module: 'memory' });
      }
      abortLog.warn(`Memory critical: ${gb(r)} GB of ${gb(state.limit)} GB - aborting running operations (at ${place}; ${aborts} aborted so far)`);
    } catch {
      // logging must never stop the abort
    }
  }
  return r;
}

function gb(bytes) {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

function describe() {
  const group = !state.groupWanted ? '' : state.group
    ? `, for the whole cgroup ${state.group.dir} (its private memory)`
    : ', measured as this process\'s RSS (no cgroup limit of the service\'s own to measure as a group)';
  return `Memory limit: ${gb(state.limit)} GB (from ${state.source})${group}; ` +
    (state.excludeFileBacked && !state.group ? 'measured as RSS less file-backed pages; ' : '') +
    `new requests refused above ${gb(state.rejectAt)} GB (${Math.round(state.rejectFraction * 100)}%), ` +
    `operations aborted above ${gb(state.abortAt)} GB (${Math.round(state.abortFraction * 100)}%); ` +
    `while refusing, a forced GC` + (!state.trimAllocator ? ' (trimAllocator false: no malloc_trim)'
      : canTrimNativeMemory() ? ' and malloc_trim' : ' (malloc_trim not available here)');
}

/**
 * Express middleware: 503 + Retry-After while RSS is over the reject threshold. Install it
 * before the body parsers so a refused request costs nothing. While refusing, it looks for
 * memory to get back now and then and re-measures - every gcInterval ms, backing off to
 * gcMaxInterval while the looks get back little: a forced GC (not while the JS heap is too
 * small for one to help), then malloc_trim (unless trimAllocator is false); and between those,
 * malloc_trim alone at most every trimInterval ms, before refusing a request. It logs when
 * refusing starts (then once a minute, with how long and how many) and when it stops.
 * @param {object} [opts] - { log, exempt: [path prefixes never refused], retryAfter (seconds),
 *   gcInterval (ms), gcMaxInterval (ms), heapUsed (function returning bytes, for tests),
 *   trim (function, for tests: as trimNativeMemory), trimInterval (ms), onReject (optional observation callback,
 *   called only when sending a 503) }
 */
function middleware(opts = {}) {
  const exempt = opts.exempt || [];
  const retryAfter = String(opts.retryAfter || 30);
  const log = opts.log;
  const gcInterval = opts.gcInterval || GC_INTERVAL_MS;
  const gcMaxInterval = Math.max(opts.gcMaxInterval || GC_MAX_INTERVAL_MS, gcInterval);
  const heapUsed = opts.heapUsed || (() => process.memoryUsage().heapUsed);
  const trim = opts.trim || trimNativeMemory;
  const trimInterval = opts.trimInterval || TRIM_INTERVAL_MS;
  let gcWait = gcInterval; // the current wait between forced GCs (backs off, see below)
  let refusingSince = 0; // when the current spell of refusing began (0 = not refusing)
  let refused = 0;       // refused in the current spell
  let lastLog = 0;
  let lastGc = 0;
  let lastTrim = 0;

  const secs = (ms) => Math.round(ms / 1000);

  return (req, res, next) => {
    if (exempt.some(p => req.path === p || req.path.startsWith(p + '/'))) {
      return next();
    }
    let over = shouldReject();
    const now = Date.now();

    // Refusing starves the GC of the allocation that would normally trigger it, so while
    // refusing, force a full collection now and then. Only when it could help: a GC frees heap
    // and nothing else, so if the whole JS heap is smaller than the amount over the threshold,
    // collecting can't get the server back under it. Then malloc_trim: the C allocator keeps
    // what is freed outside the JS heap (closed SQLite connections) resident until asked.
    // Re-measure; a look that got back little doubles the wait before the next
    if (over && now - lastGc >= gcWait) {
      lastGc = now;
      const before = state.sampleRss;
      const excess = before - state.rejectAt;
      const heap = heapUsed();
      const gc = getGc();
      // a group: every process refusing does this, so each need only free its share
      const share = state.group ? Math.max(1, readCgroupProcessRss(state.group).size) : 1;
      const done = [];
      if (heap < excess / share) {
        if (log) {
          log.info(`Memory: no forced GC - the JS heap (${gb(heap)} GB) is less than the ${gb(excess)} GB over the threshold`);
        }
      } else if (gc) {
        try {
          gc();
          done.push('forced GC');
        } catch {
          // ignore
        }
      }
      if (state.trimAllocator && trim() !== null) {
        done.push('malloc_trim');
        lastTrim = now;
      }
      if (done.length) {
        const after = rss(true);
        over = after > state.rejectAt;
        gcWait = !over ? gcInterval : before - after >= excess / 10 ? gcWait : Math.min(gcWait * 2, gcMaxInterval);
        if (log) {
          log.info(`Memory: ${done.join(' and ')} while refusing - ${gb(before)} GB -> ${gb(after)} GB` +
            (over ? `; next in ${secs(gcWait)}s` : ''));
        }
      } else {
        gcWait = Math.min(gcWait * 2, gcMaxInterval);
      }
    } else if (over && state.trimAllocator && now - lastTrim >= trimInterval) {
      lastTrim = now;
      const before = state.sampleRss;
      if (trim() !== null) {
        const after = rss(true);
        over = after > state.rejectAt;
        if (log && (!over || before - after >= 0.1 * 2 ** 30)) {
          log.info(`Memory: malloc_trim before refusing - ${gb(before)} GB -> ${gb(after)} GB`);
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
    try {
      opts.onReject?.();
    } catch {
      // Observability must never change whether this request is refused.
    }
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

module.exports = { DEFAULT_REJECT_FRACTION, configure, measureExcludingFileBacked, shouldReject, overAbortThreshold, describe, middleware, gb, getGc, _state: state };
