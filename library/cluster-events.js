/**
 * What the launcher (cluster.js) saw, for the master's daily report (cluster.md, "The daily
 * report").
 *
 * Only the launcher knows when a process exited, was recycled or came back, and what it
 * refused or abandoned itself. It keeps those as rows: an event (a process exited, was
 * recycled, was ready again after a time unavailable; the launcher started) is a row of its
 * own; what the launcher answered itself (503, 504, 502, a cache-id lost to a restart, a
 * client that took none of a response) is counted, one row per kind and process per lot. It
 * passes them to the master over its IPC channel, once the master is ready, as it passes the
 * workers' request counts, and the master writes them to its statistics database
 * (ServerStats.recordClusterEvents), where the daily report reads them.
 *
 * A row is {time, kind, process, detail, count, ms}:
 *  - time: when it happened (a counted row: the last time in the lot)
 *  - kind: one of KINDS
 *  - process: the process's name ('master', 'worker b'), or null for the launcher itself
 *  - detail: the exit code or signal, or why a process was recycled; otherwise null
 *  - count: 1 for an event; how many for a counted row
 *  - ms: for 'ready', how long the process had been unavailable; otherwise 0
 */
const CLUSTER_EVENTS = 'fhirsmith:cluster-events';

const KINDS = {
  // events
  launcherStarted: 'launcher-started',
  exited: 'exited',
  recycled: 'recycled',
  ready: 'ready',
  // counted: what the launcher answered itself
  busy: 'refused-busy',
  stopping: 'refused-stopping',
  notReady: 'refused-not-ready',
  lostToRestart: 'lost-to-restart',
  timeout: 'upstream-timeout',
  failed: 'upstream-failed',
  writeTimeout: 'write-timeout'
};
const KNOWN = new Set(Object.values(KINDS));
// kept one by one; the rest are counted
const EVENT_KINDS = new Set([KINDS.launcherStarted, KINDS.exited, KINDS.recycled, KINDS.ready]);
// events kept while the master can't take them (it is down, or not ready yet); the oldest go
// first. Counted rows are one per kind and process, so they don't grow
const MAX_PENDING = 5000;
const MAX_DETAIL = 500;

/**
 * A row as the master takes it, or null if it isn't one.
 */
function validRow(row) {
  if (!row || !KNOWN.has(row.kind) || !Number.isFinite(row.time) || !Number.isInteger(row.count) || row.count <= 0) {
    return null;
  }
  const text = (v) => (typeof v === 'string' && v ? v.slice(0, MAX_DETAIL) : null);
  return {
    time: Math.round(row.time),
    kind: row.kind,
    process: text(row.process),
    detail: text(row.detail),
    count: row.count,
    ms: Number.isFinite(row.ms) && row.ms > 0 ? Math.round(row.ms) : 0
  };
}

/**
 * The launcher's side: what hasn't reached the master yet. Shaped like PendingCounts
 * (library/cluster-counts.js), so the launcher delivers both the same way.
 */
class PendingClusterEvents {
  constructor(now = Date.now) {
    this.now = now;
    this.events = [];
    this.counted = new Map();
  }

  /** Something that happened once: a process exited, was recycled, was ready again. */
  event(kind, process = null, { detail = null, ms = 0 } = {}) {
    this.events.push({ time: this.now(), kind, process, detail: detail == null ? null : String(detail), count: 1, ms });
    if (this.events.length > MAX_PENDING) {
      this.events.splice(0, this.events.length - MAX_PENDING);
    }
  }

  /** Something the launcher answered itself: counted, not kept one by one. */
  count(kind, process = null) {
    const key = `${kind}\u001f${process || ''}`;
    let row = this.counted.get(key);
    if (!row) {
      row = { time: 0, kind, process, detail: null, count: 0, ms: 0 };
      this.counted.set(key, row);
    }
    row.count++;
    row.time = this.now();
  }

  /** Put back a lot that couldn't be delivered. */
  add(rows) {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!EVENT_KINDS.has(row.kind)) {
        const key = `${row.kind}\u001f${row.process || ''}`;
        const sum = this.counted.get(key);
        if (sum) {
          sum.count += row.count;
          sum.time = Math.max(sum.time, row.time);
        } else {
          this.counted.set(key, { ...row });
        }
      } else {
        this.events.push(row);
      }
    }
    this.events.sort((a, b) => a.time - b.time);
    if (this.events.length > MAX_PENDING) {
      this.events.splice(0, this.events.length - MAX_PENDING);
    }
  }

  /** Everything pending, now no longer pending (add it back if it can't be delivered). */
  take() {
    const rows = [...this.events, ...this.counted.values()];
    this.events = [];
    this.counted.clear();
    return rows;
  }

  get size() {
    return this.events.length + this.counted.size;
  }
}

/**
 * The master's side: take what the launcher sends, into the statistics database. A process
 * without the launcher, or that isn't the master, does nothing.
 * @param {Object} stats - the ServerStats
 * @param {Object} [channel] - process, or a stand-in (tests)
 * @param {Object} [options]
 * @param {string} [options.role]
 * @returns {Function} disconnect
 */
function connectClusterEvents(stats, channel = process, { role = null } = {}) {
  if (role !== 'master' || typeof channel.send !== 'function') {
    return () => {};
  }
  const receive = message => {
    if (message && message.type === CLUSTER_EVENTS) {
      stats.recordClusterEvents(message.rows);
    }
  };
  channel.on('message', receive);
  return () => channel.removeListener('message', receive);
}

module.exports = { CLUSTER_EVENTS, KINDS, EVENT_KINDS, PendingClusterEvents, connectClusterEvents, validRow };
