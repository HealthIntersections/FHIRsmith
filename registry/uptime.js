// registry/uptime.js
// Uptime history for the registered servers: one record per endpoint per scan, saying
// whether the endpoint answered. The registry's own scan is the probe - nothing else is
// pinged - so a scan that didn't happen (the registry was down, or the master list could
// not be read) is not held against any server.

const DAY = 24 * 60 * 60 * 1000;

class UptimeHistory {
  /**
   * @param {object} [options]
   * @param {number} [options.retentionDays] how long records are kept (default 90)
   * @param {number} [options.windowDays] the period uptime is reported over (default 30)
   */
  constructor(options = {}) {
    this.retentionMs = (options.retentionDays || 90) * DAY;
    this.windowMs = (options.windowDays || 30) * DAY;
    this.records = new Map(); // address -> [[timeMs, ok(1|0)], ...] in time order
  }

  /**
   * Record the outcome of one probe of an endpoint
   * @param {string} address the endpoint URL
   * @param {boolean} ok whether the scan of it succeeded
   * @param {number} [time] when the scan ran (ms)
   */
  record(address, ok, time = Date.now()) {
    if (!address) {
      return;
    }
    let list = this.records.get(address);
    if (!list) {
      list = [];
      this.records.set(address, list);
    }
    list.push([time, ok ? 1 : 0]);
    this.prune(address, time);
  }

  prune(address, now = Date.now()) {
    const list = this.records.get(address);
    if (!list) {
      return;
    }
    const cutoff = now - this.retentionMs;
    let drop = 0;
    while (drop < list.length && list[drop][0] < cutoff) {
      drop++;
    }
    if (drop > 0) {
      list.splice(0, drop);
    }
  }

  /**
   * Uptime over the reporting window for a set of endpoints, as the fraction of their
   * probes that succeeded: a server with two endpoints of which one is down for a scan
   * is half down for that scan.
   * @param {string|string[]} addresses one endpoint, or the endpoints of one server
   * @param {number} [now]
   * @param {number} [from] the start of the period; the reporting window by default
   * @returns {{percent: number, probes: number, failures: number, since: number}|null}
   *   null when there have been no probes in the window
   */
  uptime(addresses, now = Date.now(), from = now - this.windowMs) {
    const list = Array.isArray(addresses) ? addresses : [addresses];
    let probes = 0;
    let failures = 0;
    let since = Infinity;
    for (const address of list) {
      for (const [time, ok] of this.records.get(address) || []) {
        if (time < from || time > now) {
          continue;
        }
        probes++;
        if (!ok) {
          failures++;
        }
        if (time < since) {
          since = time;
        }
      }
    }
    if (probes === 0) {
      return null;
    }
    return { percent: 100 * (probes - failures) / probes, probes, failures, since };
  }

  /**
   * Forget what is past retention. Only age decides: an endpoint missing from one crawl (a
   * sub-registry that failed to fetch, a crawl cut short at shutdown) keeps its history,
   * and one that has really gone ages out with its last probes
   * @param {Iterable<string>} [addresses] the endpoints of the last crawl (no longer used:
   *   a crawl can miss endpoints that still exist)
   */
  retain(addresses, now = Date.now()) {
    for (const address of [...this.records.keys()]) {
      this.prune(address, now);
      if (this.records.get(address).length === 0) {
        this.records.delete(address);
      }
    }
  }

  toJSON() {
    const endpoints = {};
    for (const [address, list] of this.records) {
      if (list.length > 0) {
        endpoints[address] = list.map(([t, ok]) => [t, ok]);
      }
    }
    return { version: '1', endpoints };
  }

  static fromJSON(json, options) {
    const history = new UptimeHistory(options);
    if (!json || json.version !== '1' || typeof json.endpoints !== 'object') {
      return history;
    }
    for (const [address, list] of Object.entries(json.endpoints || {})) {
      if (!Array.isArray(list)) {
        continue;
      }
      const clean = list
        .filter(r => Array.isArray(r) && Number.isFinite(r[0]))
        .map(r => [r[0], r[1] ? 1 : 0])
        .sort((a, b) => a[0] - b[0]);
      if (clean.length > 0) {
        history.records.set(address, clean);
      }
    }
    return history;
  }
}

/**
 * Format an uptime for display: 100%, 99.9%, 97%, ... - the precision that is honest
 * for the number of probes behind it
 */
function formatUptime(u) {
  if (!u) {
    return '';
  }
  if (u.failures === 0) {
    return '100%';
  }
  if (u.percent >= 99) {
    return `${(Math.floor(u.percent * 10) / 10).toFixed(1)}%`;
  }
  return `${Math.floor(u.percent)}%`;
}

module.exports = { UptimeHistory, formatUptime };
