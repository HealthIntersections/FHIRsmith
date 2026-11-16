// library/block-monitor.js
// Notices when the event loop is held - a stretch of synchronous work during which this
// process can't answer anything - for 2 seconds or more, logs it with the requests that were
// in flight when it began, and counts it for the daily report.
//
// A timer ticks every TICK_MS; when a tick comes BLOCK_MS or more late, the loop was held for
// that long. Nothing new is accepted while the loop is held, so the request that held it is
// one of those in flight when the block began - the log names them all, since which one did
// the work can't be told from here. A request that does blocking work usually sends its response
// at the end of it, before the tick runs, so a finished request is kept until the next tick;
// those that finished during the block are named first, as "finished as it ended" - most
// likely the one that held it.
//
// Each block is counted (ServerStats.countEvent) as one of BANDS, with its length as the time,
// so the counts are persisted, merged from a cluster's workers, and in countsSince() for the
// (server) module - which is how the daily report gets them (blockSummary).
//
// The stall watchdog (library/stall-watchdog.js) is for the long ones: past
// logging.stallReportSeconds it takes the stack from a worker thread while the block is going on.

const TICK_MS = 100;
const BLOCK_MS = 2000;
// the counter operations, longest first: a block is counted in the first band it reaches
const BANDS = [
  {min: 10000, operation: 'event loop blocked 10s+'},
  {min: 5000, operation: 'event loop blocked 5-10s'},
  {min: 2000, operation: 'event loop blocked 2-5s'}
];
// the most requests named in one log line
const MAX_NAMED = 10;

class BlockMonitor {

  /**
   * @param deps - {log, stats, now} - stats: the ServerStats (countEvent); now: a clock, for tests
   */
  constructor(deps = {}) {
    this.log = deps.log || console;
    this.stats = deps.stats || null;
    this.now = deps.now || Date.now;
    this.inFlight = new Set();
    this.timer = null;
    this.lastTick = null;
  }

  start() {
    if (this.timer) {
      return;
    }
    this.lastTick = this.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Express middleware: keeps track of the requests in flight. First in the chain, so a
   * request is known from the moment it arrives.
   */
  middleware() {
    return (req, res, next) => {
      const entry = {method: req.method, url: req.originalUrl || req.url, start: this.now(), end: null};
      this.inFlight.add(entry);
      // kept until the next tick (see the top of the file)
      const done = () => {
        if (entry.end === null) {
          entry.end = this.now();
        }
      };
      res.once('finish', done);
      res.once('close', done);
      next();
    };
  }

  tick() {
    const now = this.now();
    const late = now - this.lastTick - TICK_MS;
    if (late >= BLOCK_MS) {
      this.blocked(now - late, late);
    }
    for (const entry of this.inFlight) {
      if (entry.end !== null) {
        this.inFlight.delete(entry);
      }
    }
    this.lastTick = now;
  }

  /**
   * A block of ms, which began at began: log it with the requests in flight then, and count it.
   */
  blocked(began, ms) {
    // in flight when it began: arrived before, and not finished before. Those that finished
    // during it first, then the oldest
    const suspects = [...this.inFlight].filter(e => e.start <= began && (e.end === null || e.end >= began))
      .sort((a, b) => (a.end === null) - (b.end === null) || a.start - b.start);
    this.log.warn(describeBlock(ms, began, suspects));
    const band = BANDS.find(b => ms >= b.min);
    if (this.stats && typeof this.stats.countEvent === 'function') {
      this.stats.countEvent(band.operation, ms);
    }
  }
}

/** "Event loop blocked for 12.3s; in flight when it began: GET /xig?... (for 0.2s), ..." */
function describeBlock(ms, began, suspects) {
  const named = suspects.slice(0, MAX_NAMED)
    .map(e => `${e.method} ${String(e.url).substring(0, 300)} (${e.end !== null ? 'finished as it ended' : `for ${((began - e.start) / 1000).toFixed(1)}s`})`);
  if (suspects.length > MAX_NAMED) {
    named.push(`and ${suspects.length - MAX_NAMED} more`);
  }
  const what = named.length > 0 ? `in flight when it began: ${named.join(', ')}` : 'no request was in flight when it began';
  return `Event loop blocked for ${(ms / 1000).toFixed(1)}s; ${what}`;
}

/**
 * The blocks in the (server) module's countsSince() result, as the daily report puts them:
 * {over2, over5, over10} - each count includes the longer blocks
 */
function blockSummary(counts) {
  const ops = (counts && counts.operations) || {};
  const n = (band) => ops[band.operation] || 0;
  const over10 = n(BANDS[0]);
  const over5 = over10 + n(BANDS[1]);
  const over2 = over5 + n(BANDS[2]);
  return {over2, over5, over10};
}

module.exports = BlockMonitor;
module.exports.BANDS = BANDS;
module.exports.BLOCK_MS = BLOCK_MS;
module.exports.TICK_MS = TICK_MS;
module.exports.describeBlock = describeBlock;
module.exports.blockSummary = blockSummary;
