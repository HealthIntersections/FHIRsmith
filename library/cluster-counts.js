/**
 * The tx-workers' request counts, for the master's statistics (cluster.md, "Statistics").
 *
 * A tx-worker has no statistics database and sends no daily report (library/role.js). Under
 * the launcher (cluster.js), each worker sends the requests it counted since the last time
 * (module, endpoint, operation, count, time) over its IPC channel, every minute and when it
 * stops. The launcher sums what it has not yet delivered and passes it on to the master,
 * which adds it to its own counters (ServerStats.mergeCounts). The master's statistics
 * database, and the daily report built from it, then count every process, each request once:
 * a worker's counts are taken when sent, and only the master writes them.
 *
 * Without the launcher (processes started by hand behind nginx) there is no IPC channel, and
 * a worker's requests are not in the master's statistics.
 */
const COUNTS = 'fhirsmith:counts';
// how often a worker sends its request counts
const COUNTS_INTERVAL_MS = 60 * 1000;
// how long a stopping worker waits for its last counts to be sent
const COUNTS_FLUSH_MS = 2000;

/**
 * Attach a process with a role to the launcher's IPC channel. A process started without the
 * launcher has none, and this does nothing.
 * @param {Object} stats - the ServerStats
 * @param {Object} [channel] - process, or a stand-in (tests)
 * @param {Object} [options]
 * @param {string} [options.role] - 'master' takes the workers' counts; 'tx-worker' sends its own
 * @param {number} [options.intervalMs]
 * @returns {Function} disconnect; its flush() sends a worker's last counts (on shutdown)
 */
function connectCounts(stats, channel = process, { role = null, intervalMs = COUNTS_INTERVAL_MS } = {}) {
  if (typeof channel.send !== 'function') {
    const none = () => {};
    none.flush = async () => {};
    return none;
  }
  // A worker's counts are taken only when sent, one lot at a time; a lot that can't be sent
  // is put back, to go with the next
  let inFlight = null;
  const send = () => {
    if (inFlight) return inFlight;
    if (role !== 'tx-worker' || channel.connected === false) return Promise.resolve();
    const rows = stats.takeCounts();
    if (rows.length === 0) return Promise.resolve();
    inFlight = new Promise(resolve => {
      const done = error => {
        if (error) stats.restoreCounts(rows);
        inFlight = null;
        resolve();
      };
      try {
        channel.send({ type: COUNTS, rows }, done);
      } catch (error) {
        done(error);
      }
    });
    return inFlight;
  };
  const timer = role === 'tx-worker' ? setInterval(send, intervalMs) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();

  const receive = message => {
    if (role === 'master' && message && message.type === COUNTS) {
      stats.mergeCounts(message.rows);
    }
  };
  channel.on('message', receive);

  const disconnect = () => {
    if (timer) clearInterval(timer);
    channel.removeListener('message', receive);
  };
  disconnect.flush = async () => {
    let wait;
    const timeout = new Promise(resolve => { wait = setTimeout(resolve, COUNTS_FLUSH_MS); });
    try {
      // the lot in flight, then whatever was counted since
      await Promise.race([(async () => { await inFlight; await send(); })(), timeout]);
    } finally {
      clearTimeout(wait);
    }
  };
  return disconnect;
}

/**
 * The launcher's side: what the workers sent and the master hasn't had yet, summed by
 * (module, endpoint, operation).
 */
class PendingCounts {
  constructor() {
    this.rows = new Map();
  }

  add(rows) {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || !Number.isInteger(row.count) || row.count <= 0 || !Number.isFinite(row.time)) continue;
      const key = `${row.module}\u001f${row.endpoint}\u001f${row.operation}`;
      const sum = this.rows.get(key);
      if (sum) {
        sum.count += row.count;
        sum.time += row.time;
      } else {
        this.rows.set(key, { module: row.module, endpoint: row.endpoint, operation: row.operation, count: row.count, time: row.time });
      }
    }
  }

  /** Everything pending, now no longer pending (add it back if it can't be delivered). */
  take() {
    const rows = [...this.rows.values()];
    this.rows.clear();
    return rows;
  }

  get size() {
    return this.rows.size;
  }
}

module.exports = { connectCounts, PendingCounts, COUNTS, COUNTS_INTERVAL_MS };
