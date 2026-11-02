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
 * @module library/memory-guard
 */

const fs = require('fs');
const os = require('os');
const { readCgroupMemoryLimit } = require('./cgroup-memory');

const DEFAULT_REJECT_FRACTION = 0.85;
const DEFAULT_ABORT_FRACTION = 0.92;
// RSS is cheap to read, but the gate runs on every request; a sample this old is fine
const SAMPLE_MS = 250;

const state = {
  limit: 0,
  source: null,
  rejectFraction: DEFAULT_REJECT_FRACTION,
  abortFraction: DEFAULT_ABORT_FRACTION,
  rejectAt: 0,
  abortAt: 0,
  sampleTime: 0,
  sampleRss: 0,
  // set by measureExcludingFileBacked()
  excludeFileBacked: false
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
  if (!limit) {
    const cg = readCgroupMemoryLimit();
    limit = cg.limit;
    source = cg.source;
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

function rssFileBytes() {
  try {
    const m = /^RssFile:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/self/status', 'utf8'));
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function rss(fresh = false) {
  const now = Date.now();
  if (fresh || now - state.sampleTime > SAMPLE_MS) {
    state.sampleRss = process.memoryUsage.rss() - (state.excludeFileBacked ? rssFileBytes() : 0);
    state.sampleTime = now;
  }
  return state.sampleRss;
}

/** True if new requests should be refused (uses a sample at most SAMPLE_MS old). */
function shouldReject() {
  return state.rejectAt > 0 && rss() > state.rejectAt;
}

let aborts = 0;
let lastAbortLog = 0;
let abortLog = null;

/**
 * Current RSS in bytes if running operations should be aborted, else 0. Always a fresh read.
 * A trip is written to the server log (at most once a minute, with a running count) - the
 * caller's own message only goes to the aborted operation's diagnostics.
 * @param {string} [place] - where the check was made, for the log
 */
function overAbortThreshold(place = 'unknown') {
  if (state.abortAt <= 0) {
    return 0;
  }
  const r = rss(true);
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
  return `Memory limit: ${gb(state.limit)} GB (from ${state.source}); ` +
    (state.excludeFileBacked ? 'measured as RSS less file-backed pages; ' : '') +
    `new requests refused above ${gb(state.rejectAt)} GB (${Math.round(state.rejectFraction * 100)}%), ` +
    `operations aborted above ${gb(state.abortAt)} GB (${Math.round(state.abortFraction * 100)}%)`;
}

/**
 * Express middleware: 503 + Retry-After while RSS is over the reject threshold. Install it
 * before the body parsers so a refused request costs nothing.
 * @param {object} [opts] - { log, exempt: [path prefixes never refused], retryAfter (seconds) }
 */
function middleware(opts = {}) {
  const exempt = opts.exempt || [];
  const retryAfter = String(opts.retryAfter || 30);
  const log = opts.log;
  let refused = 0;
  let lastLog = 0;
  return (req, res, next) => {
    if (!shouldReject() || exempt.some(p => req.path === p || req.path.startsWith(p + '/'))) {
      return next();
    }
    refused++;
    const now = Date.now();
    if (log && now - lastLog > 60000) {
      log.warn(`Memory high: ${gb(state.sampleRss)} GB of ${gb(state.limit)} GB - refusing new requests with 503 (${refused} refused so far)`);
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

module.exports = { configure, measureExcludingFileBacked, shouldReject, overAbortThreshold, describe, middleware, gb, _state: state };
