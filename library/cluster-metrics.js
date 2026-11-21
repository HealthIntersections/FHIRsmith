/**
 * The launcher's small, in-memory view of each server's existing graph samples.
 * No request counters are collected by the proxy and no averages are combined.
 * Histories live until the launcher stops, so a child restart leaves a visible
 * gap instead of erasing the worker's earlier samples. The one figure the launcher
 * adds is the memory graph's Total: the cgroup's private memory (or, without a cgroup
 * of the service's own, the processes' summed), read when the master's sample arrives.
 */
const METRIC = 'fhirsmith:metric';
const SNAPSHOT = 'fhirsmith:metrics';
const HISTORY_MS = 24 * 60 * 60 * 1000;
const MAX_POINTS = 1440;
const FIELDS = ['mem', 'anon', 'rpm', 'tat', 'block', 'blockMax', 'clientConcepts', 'refused', 'intervalStart', 'ext', 'extTat'];

class ClusterMetrics {
  /**
   * @param {Object[]} procs - code, role, servesTx
   * @param {Object} [options] - rejectAt (the memory guard's refusal threshold, bytes), group
   *   (whether the guard measures the cgroup, which the Total then is), sharedCache
   */
  constructor(procs, { rejectAt = null, group = false, sharedCache = false } = {}) {
    this.rejectAt = rejectAt;
    this.group = group;
    this.sharedCache = sharedCache;
    this.total = [];
    this.series = new Map(procs.map(p => [p.code, {
      id: p.code, label: `${p.role === 'master' ? 'Master' : 'Worker'} ${p.code}`,
      role: p.role, servesTx: p.servesTx, status: 'starting', restarts: 0,
      startedAt: null, intervalMs: null, history: []
    }]));
  }

  /** The memory graph's Total at a time (null: not known, a gap). */
  recordTotal(time, anon, now = Date.now()) {
    const last = this.total[this.total.length - 1];
    if (!Number.isFinite(time) || (last && time <= last.time)) {
      return;
    }
    this.total.push({ time, anon: Number.isFinite(anon) ? anon : null });
    this.prune(this, now, 'total');
  }

  prune(series, now, field = 'history') {
    const cutoff = now - HISTORY_MS;
    series[field] = series[field].filter(point => point.time > cutoff).slice(-MAX_POINTS);
  }

  state(code, status, now = Date.now()) {
    const series = this.series.get(code);
    if (!series) return;
    if (status === 'restarting' && series.status !== 'restarting') {
      series.restarts++;
      if (series.history.length) {
        // Chart.js must not connect the last sample to the replacement process.
        series.history.push({ time: now, ...Object.fromEntries(FIELDS.map(field => [field, null])) });
      }
    }
    series.status = status;
    this.prune(series, now);
  }

  record(code, message, now = Date.now()) {
    const series = this.series.get(code);
    const point = message && message.point;
    if (!series || !point || !Number.isFinite(point.time) ||
        !Number.isFinite(message.startedAt) || !Number.isFinite(message.intervalMs) || message.intervalMs <= 0) {
      return false;
    }
    // Reject malformed or out-of-order samples; a delayed old child is also
    // rejected by the launcher before it reaches this store.
    const last = series.history[series.history.length - 1];
    if (point.time < now - HISTORY_MS || point.time > now + 60000 || (last && point.time <= last.time)) {
      return false;
    }
    const clean = { time: point.time };
    for (const field of FIELDS) {
      clean[field] = Number.isFinite(point[field]) ? point[field] : null;
    }
    series.startedAt = message.startedAt;
    series.intervalMs = message.intervalMs;
    if (last && point.time - last.time > 1.5 * message.intervalMs && FIELDS.some(field => last[field] !== null)) {
      series.history.push({ time: last.time + message.intervalMs, ...Object.fromEntries(FIELDS.map(field => [field, null])) });
    }
    series.history.push(clean);
    this.prune(series, now);
    return true;
  }

  snapshot(now = Date.now()) {
    this.prune(this, now, 'total');
    return {
      cluster: true, sampledAt: now, sharedCache: this.sharedCache,
      total: { group: this.group, rejectAt: this.rejectAt, history: this.total.map(point => ({ ...point })) },
      series: [...this.series.values()].map(series => {
        this.prune(series, now);
        const last = series.history[series.history.length - 1];
        const stale = series.status === 'ready' && (!last || now - last.time > Math.max(60000, 2 * series.intervalMs));
        return { ...series, status: stale ? 'no recent sample' : series.status,
          history: series.history.map(point => ({ ...point })) };
      })
    };
  }
}

/** Attach only to a launcher-created IPC channel; standalone servers stay local. */
function connectMetrics(stats, channel = process) {
  if (typeof channel.send !== 'function') return () => {};
  let sending = false;
  const publish = point => {
    // Statistics must never block request work or build an IPC backlog.
    if (channel.connected === false || sending) return;
    sending = true;
    try {
      channel.send({ type: METRIC, point, startedAt: stats.startTime, intervalMs: stats.intervalMs }, () => {
        sending = false;
      });
    } catch {
      sending = false;
    }
  };
  const receive = message => {
    if (message && message.type === SNAPSHOT && Array.isArray(message.series)) {
      stats.clusterMetrics = { cluster: true, sampledAt: message.sampledAt, sharedCache: message.sharedCache === true,
        total: message.total || null, series: message.series };
      stats.clusterMetricsUnavailable = false;
    }
  };
  const disconnected = () => { stats.clusterMetricsUnavailable = true; };
  stats.onMetric = publish;
  channel.on('message', receive);
  channel.on('disconnect', disconnected);
  return () => {
    if (stats.onMetric === publish) stats.onMetric = null;
    channel.removeListener('message', receive);
    channel.removeListener('disconnect', disconnected);
  };
}

/**
 * Serialize only graph data, safely inside an inline script in either page. Without the
 * launcher's snapshot (no role, a worker's own page, a master before its first), this process's
 * own samples as one series, with its memory guard's refusal threshold (guard: rejectAt, group:
 * whether the guard measures the cgroup) and no Total.
 */
function graphData(stats, label = 'Server', now = Date.now(), guard = {}) {
  return JSON.stringify(graphSeries(stats, label, now, guard)).replace(/</g, '\\u003c');
}

/**
 * The graphs' data (as graphData, not serialized): the launcher's snapshot, or this process's
 * own samples as one series
 */
function graphSeries(stats, label = 'Server', now = Date.now(), guard = {}) {
  const data = stats.clusterMetrics || {
    cluster: false, sampledAt: now,
    total: Number.isFinite(guard.rejectAt) && guard.rejectAt > 0
      ? { group: Boolean(guard.group), rejectAt: guard.rejectAt, history: [], local: true } : null,
    series: [{ id: 'local', label, status: 'ready', restarts: 0, startedAt: stats.startTime,
      intervalMs: stats.intervalMs, history: stats.history }]
  };
  const series = data.series.map(item => {
    const last = item.history[item.history.length - 1];
    const stale = item.status === 'ready' && (!last || now - last.time > Math.max(60000, 2 * item.intervalMs));
    return { ...item, status: data.cluster && stats.clusterMetricsUnavailable ? 'unavailable' : stale ? 'no recent sample' : item.status };
  });
  return { ...data, series };
}

/**
 * The external requests (those that had to ask another server: ServerStats.countExternalRequest)
 * in the graphs' samples - every process's, on the master under the launcher: {count, average
 * (ms), hours (how far back the samples go)}, or null if there were none
 */
function externalSummary(stats, now = Date.now()) {
  let count = 0;
  let time = 0;
  let earliest = now;
  for (const series of graphSeries(stats, 'external', now).series || []) {
    for (const point of series.history || []) {
      const from = Number.isFinite(point.intervalStart) ? point.intervalStart : point.time;
      if (Number.isFinite(from)) {
        earliest = Math.min(earliest, from);
      }
      if (point.ext > 0 && Number.isFinite(point.extTat)) {
        count += point.ext;
        time += point.ext * point.extTat;
      }
    }
  }
  return count > 0 ? { count, average: time / count, hours: (now - earliest) / 3600000 } : null;
}

module.exports = { ClusterMetrics, connectMetrics, graphData, graphSeries, externalSummary, METRIC, SNAPSHOT, HISTORY_MS, MAX_POINTS };
