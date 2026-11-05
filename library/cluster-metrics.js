/**
 * The launcher's small, in-memory view of each server's existing graph samples.
 * No request counters are collected by the proxy and no averages are combined.
 * Histories live until the launcher stops, so a child restart leaves a visible
 * gap instead of erasing the worker's earlier samples.
 */
const METRIC = 'fhirsmith:metric';
const SNAPSHOT = 'fhirsmith:metrics';
const HISTORY_MS = 24 * 60 * 60 * 1000;
const MAX_POINTS = 1440;
const FIELDS = ['mem', 'rpm', 'tat', 'block', 'blockMax', 'clientConcepts'];

class ClusterMetrics {
  constructor(procs) {
    this.series = new Map(procs.map(p => [p.code, {
      id: p.code, label: `${p.role === 'master' ? 'Master' : 'Worker'} ${p.code}`,
      role: p.role, servesTx: p.servesTx, status: 'starting', restarts: 0,
      startedAt: null, intervalMs: null, history: []
    }]));
  }

  prune(series, now) {
    const cutoff = now - HISTORY_MS;
    series.history = series.history.filter(point => point.time > cutoff).slice(-MAX_POINTS);
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
    return {
      cluster: true, sampledAt: now,
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
      stats.clusterMetrics = { cluster: true, sampledAt: message.sampledAt, series: message.series };
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

/** Serialize only graph data, safely inside an inline script in either page. */
function graphData(stats, label = 'Server', now = Date.now()) {
  const data = stats.clusterMetrics || {
    cluster: false, sampledAt: now,
    series: [{ id: 'local', label, status: 'ready', restarts: 0, startedAt: stats.startTime,
      intervalMs: stats.intervalMs, history: stats.history }]
  };
  const series = data.series.map(item => {
    const last = item.history[item.history.length - 1];
    const stale = item.status === 'ready' && (!last || now - last.time > Math.max(60000, 2 * item.intervalMs));
    return { ...item, status: data.cluster && stats.clusterMetricsUnavailable ? 'unavailable' : stale ? 'no recent sample' : item.status };
  });
  return JSON.stringify({ ...data, series }).replace(/</g, '\\u003c');
}

module.exports = { ClusterMetrics, connectMetrics, graphData, METRIC, SNAPSHOT, HISTORY_MS, MAX_POINTS };
