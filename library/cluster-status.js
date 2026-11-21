/**
 * The cluster's state now, for the master's status panel (/ and /dashboard) and
 * /dashboard/status.json (cluster.md, "Status").
 *
 * Under the launcher (cluster.js), every process sends a few figures of its own over its IPC
 * channel every statusSeconds (15): its JS heap, its client caches and their concepts, its
 * expansion cache, the requests it has in flight and whether its memory guard is refusing.
 * The launcher adds what only it can read: each process's private memory and mapped file
 * pages (/proc/<pid>/status), its status and restarts, and the cgroup's private memory and
 * page cache (memory.stat), against the limit the memory guard uses. It merges them into one
 * snapshot (buildSnapshot) and passes it to the master, as it passes on the request counts
 * (library/cluster-counts.js). Each figure carries its scope, and its age.
 *
 * A worker's own page shows its own figures; a process without the launcher (no role, or roles
 * started by hand behind nginx) has no IPC channel, and shows only its own.
 *
 * clusterSummary and processSummary shape the status line at the top of the page
 * (tx/html/status-line.liquid): requests, uptime, heap and any problems. clusterView,
 * processView and storageView shape the rest, under "More" (tx/html/status-panel.liquid):
 * a header, tiles, the memory meter, a row per process and footnotes.
 */
const v8 = require('v8');

// a process's own figures, to the launcher; the launcher's snapshot, to the master
const STATUS = 'fhirsmith:status';
const CLUSTER_STATUS = 'fhirsmith:cluster-status';
// how often each process sends its figures, and the launcher sends the master its snapshot
// (server.cluster.statusSeconds)
const STATUS_INTERVAL_MS = 15000;
// figures this many intervals old are shown with their age, and left out of the totals
const STALE_INTERVALS = 3;

const n = (v) => Number(v).toLocaleString('en-US');

/**
 * This process's figures, as it sends them to the launcher.
 * @param {Object} stats - the ServerStats
 * @param {Object} own - { inFlight(), refusing() }, from server.js
 */
function ownFigures(stats, own = {}) {
  const heap = process.memoryUsage();
  return {
    time: Date.now(),
    requests: stats.requestCount,
    heapUsed: heap.heapUsed,
    heapLimit: v8.getHeapStatistics().heap_size_limit,
    clientCaches: stats.clientCaches(),
    clientConcepts: stats.clientConcepts(),
    expansionItems: stats.expansionItems(),
    inFlight: own.inFlight ? own.inFlight() : null,
    refusing: own.refusing ? own.refusing() : null
  };
}

/**
 * Attach a process with a role to the launcher's IPC channel: it sends its own figures every
 * intervalMs, and the master keeps the snapshot the launcher sends back (stats.clusterStatus).
 * A process started without the launcher has no channel, and this does nothing.
 * @param {Object} stats - the ServerStats
 * @param {Object} [channel] - process, or a stand-in (tests)
 * @param {Object} [options] - role, intervalMs, figures() (what to send)
 * @returns {Function} disconnect
 */
function connectStatus(stats, channel = process, { role = null, intervalMs = STATUS_INTERVAL_MS, figures } = {}) {
  if (typeof channel.send !== 'function') {
    return () => {};
  }
  let sending = false;
  const send = () => {
    // a figure that can't be sent is simply replaced by the next
    if (sending || channel.connected === false) return;
    let message;
    try {
      message = { type: STATUS, figures: figures() };
    } catch {
      return; // statistics must never stop the server
    }
    sending = true;
    try {
      channel.send(message, () => { sending = false; });
    } catch {
      sending = false;
    }
  };
  const timer = setInterval(send, intervalMs > 0 ? intervalMs : STATUS_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  send();
  const receive = message => {
    if (role === 'master' && message && message.type === CLUSTER_STATUS && message.snapshot) {
      stats.clusterStatus = message.snapshot;
    }
  };
  // a master that has lost the launcher shows its own figures again
  const disconnected = () => { stats.clusterStatus = null; };
  channel.on('message', receive);
  channel.on('disconnect', disconnected);
  return () => {
    clearInterval(timer);
    channel.removeListener('message', receive);
    channel.removeListener('disconnect', disconnected);
  };
}

/**
 * The launcher's snapshot of the cluster: what each process last sent, with what the launcher
 * read itself. Totals are of the processes whose figures are fresh (STALE_INTERVALS); a
 * figure that couldn't be read is null, and `missing` says what isn't known and why.
 * @param {Object} input
 * @param {number} input.now
 * @param {number} input.intervalMs - statusSeconds, in ms
 * @param {Object[]} input.procs - code, role, status, restarts, startedAt (0: not running),
 *   figures (what it last sent, or null), memory ({anon, file} from /proc, or null)
 * @param {Object} input.launcher - startedAt, requests (proxied), memory ({anon, file}|null)
 * @param {Object} input.guard - the memory guard's limit and thresholds (thresholds() in
 *   library/memory-guard.js): limit, source, rejectFraction, abortFraction, rejectAt, abortAt,
 *   and group (whether it measures the cgroup)
 * @param {Object|null} input.cgroup - {anon, file} from memory.stat; null: not measured
 * @param {boolean} [input.sharedCache] - server.cluster.sharedCache: the client caches are one
 *   store, and the count is read once from it (the master's figure) rather than summed
 * @param {boolean} [input.procAvailable] - whether /proc could be read at all
 */
function buildSnapshot({ now, intervalMs, procs, launcher, guard, cgroup, sharedCache = false, procAvailable = true }) {
  const missing = [];
  const staleMs = STALE_INTERVALS * intervalMs;
  const processes = procs.map(p => {
    const f = p.figures;
    const age = f && Number.isFinite(f.time) ? Math.max(0, now - f.time) : null;
    const fresh = f && age !== null && age <= staleMs;
    return {
      code: p.code, role: p.role,
      label: `${p.role === 'master' ? 'Master' : 'Worker'} ${p.code}`,
      status: p.status, restarts: p.restarts || 0,
      uptimeMs: p.startedAt ? now - p.startedAt : null,
      anon: p.memory ? p.memory.anon : null,
      file: p.memory ? p.memory.file : null,
      figuresAgeMs: age, fresh: Boolean(fresh),
      requests: f ? f.requests ?? null : null,
      heapUsed: f ? f.heapUsed ?? null : null,
      heapLimit: f ? f.heapLimit ?? null : null,
      clientCaches: f ? f.clientCaches ?? null : null,
      clientConcepts: f ? f.clientConcepts ?? null : null,
      expansionItems: f ? f.expansionItems ?? null : null,
      inFlight: f ? f.inFlight ?? null : null,
      refusing: f ? f.refusing ?? null : null
    };
  });
  const fresh = processes.filter(p => p.fresh);
  const sum = (list, field) => list.some(p => Number.isFinite(p[field]))
    ? list.reduce((a, p) => a + (Number.isFinite(p[field]) ? p[field] : 0), 0) : null;
  const running = processes.filter(p => p.uptimeMs !== null);
  if (fresh.length < running.length) {
    missing.push(`${running.length - fresh.length} running process(es) have sent no figures in the last ${Math.round(staleMs / 1000)} s: the totals leave them out`);
  }
  if (!procAvailable) {
    missing.push('per-process memory: /proc is not available here (Linux only)');
  }
  if (!cgroup) {
    missing.push(guard.group
      ? 'the cgroup\'s memory: memory.stat could not be read'
      : 'the cgroup\'s memory: there is no cgroup with a memory limit of the service\'s own (MemoryMax on the unit, or a container limit), so the memory guard measures each process alone, and the page cache is not known');
  }
  // client caches: one store with sharedCache (any process's count is the whole), else each its own
  let caches;
  if (sharedCache) {
    const from = fresh.find(p => p.role === 'master' && Number.isFinite(p.clientCaches)) || fresh.find(p => Number.isFinite(p.clientCaches));
    caches = { scope: 'shared', from: from ? from.code : null,
      clientCaches: from ? from.clientCaches : null, clientConcepts: from ? from.clientConcepts : null };
  } else {
    caches = { scope: 'summed', clientCaches: sum(fresh, 'clientCaches'), clientConcepts: sum(fresh, 'clientConcepts') };
  }
  const memoryOfProcs = processes.filter(p => Number.isFinite(p.anon));
  return {
    sampledAt: now,
    intervalMs,
    memory: {
      // what the memory guard measures, with a role: the cgroup's private memory
      cgroup: cgroup ? { anon: cgroup.anon, file: cgroup.file } : null,
      processAnon: memoryOfProcs.length ? memoryOfProcs.reduce((a, p) => a + p.anon, 0) + (launcher.memory ? launcher.memory.anon : 0) : null,
      limit: guard.limit, limitSource: guard.source,
      rejectAt: guard.rejectAt, abortAt: guard.abortAt,
      rejectFraction: guard.rejectFraction, abortFraction: guard.abortFraction,
      group: Boolean(guard.group)
    },
    caches: { ...caches, expansionItems: sum(fresh, 'expansionItems') },
    inFlight: sum(fresh, 'inFlight'),
    refusing: fresh.filter(p => p.refusing === true).map(p => p.code),
    processes,
    launcher: {
      label: 'Launcher', status: 'running',
      uptimeMs: launcher.startedAt ? now - launcher.startedAt : null,
      requests: launcher.requests ?? null,
      anon: launcher.memory ? launcher.memory.anon : null,
      file: launcher.memory ? launcher.memory.file : null,
      heapUsed: launcher.heapUsed ?? null, heapLimit: launcher.heapLimit ?? null
    },
    missing
  };
}

function ago(ms) {
  if (ms === null || ms === undefined) return '—';
  return ms < 1000 ? 'now' : `${Math.round(ms / 1000)} s`;
}

function duration(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

// "—" where a figure doesn't apply or isn't known
const dash = (v, f = String) => (v === null || v === undefined ? '—' : f(v));
const mb = (b) => Math.round(b / 2 ** 20).toLocaleString('en-US');
const gb = (b) => (b / 2 ** 30).toFixed(1);
// a rate: whole numbers from 100 up, one decimal below
const rate = (v) => (v >= 100 ? n(Math.round(v)) : n(Number(v.toFixed(1))));
const pct = (part, whole) => (whole > 0 ? Math.max(0, Math.min(100, (part * 100) / whole)) : 0);

// The graph lines' colours, in their order (tx/html/cluster-metrics-script.liquid): told apart
// by lightness, and every other segment of the memory meter is also striped
const PALETTE = ['#08306b', '#5b9bd5', '#d98c00', '#6a3d9a', '#9e9e9e', '#8a5a00', '#b4a7d6', '#404040'];
const SYMBOLS = ['●', '■', '▲', '◆', '★', '✕', '✚', '▢'];
// the launcher, and the rest of a cgroup the processes don't account for: light, hatched
const NEUTRAL = '#d9d9d9';
const swatch = (i) => ({ color: PALETTE[i % PALETTE.length], symbol: SYMBOLS[i % SYMBOLS.length], striped: i % 2 === 1 });

function pill(status, refusing) {
  const pills = [{ text: status, quiet: status === 'ready' || status === 'running' }];
  if (refusing) pills.push({ text: 'refusing', quiet: false });
  return pills;
}

/**
 * The memory meter: what the memory guard measures against its limit, in a segment per process,
 * with ticks at the refuse and abort thresholds.
 * @param {Object} m - used, limit, rejectAt, abortAt, rejectFraction, abortFraction, scope (the
 *   bar's label), segments ({label, bytes, swatch}), notes
 */
function meter({ used, limit, rejectAt, abortAt, rejectFraction, abortFraction, scope, segments, notes = [] }) {
  if (!(limit > 0) || used === null || used === undefined) {
    return { scope, unknown: true, notes };
  }
  const shown = segments.filter(s => s.bytes > 0);
  const accounted = shown.reduce((a, s) => a + s.bytes, 0);
  // what the processes' own figures don't account for (the measure is the cgroup's, or newer)
  if (used - accounted > limit / 200) {
    shown.push({ label: 'other', bytes: used - accounted, swatch: { color: NEUTRAL, striped: true } });
  }
  const scale = Math.max(used, accounted) > 0 ? used / Math.max(used, accounted) : 1;
  return {
    scope,
    value: `${gb(used)} GB of ${gb(limit)} GB (${Math.round(pct(used, limit))}%)`,
    segments: shown.map(s => ({ label: s.label, width: pct(s.bytes * scale, limit).toFixed(2), ...s.swatch,
      title: `${s.label}: ${mb(s.bytes)} MB` })),
    // at: the tick, from the left; right: where its label ends, from the right
    ticks: [
      { label: `refuse ${Math.round(rejectFraction * 100)}% · ${gb(rejectAt)} GB`, at: pct(rejectAt, limit).toFixed(2), right: (100 - pct(rejectAt, limit)).toFixed(2) },
      { label: `abort ${Math.round(abortFraction * 100)}% · ${gb(abortAt)} GB`, at: pct(abortAt, limit).toFixed(2), right: (100 - pct(abortAt, limit)).toFixed(2) }
    ],
    notes
  };
}

// the table's columns; the heap's limit goes in its header when every process has the same
const tableColumns = (heapLimit) => [
  { label: 'Process' }, { label: 'Status' }, { label: 'Uptime', num: true }, { label: 'Restarts', num: true },
  { label: 'Requests', num: true }, { label: 'Private MB', num: true }, { label: 'Mapped MB', num: true },
  { label: heapLimit ? `Heap MB of ${mb(heapLimit)}` : 'Heap MB used / limit', num: true },
  { label: 'Caches', num: true }, { label: 'Concepts', num: true }, { label: 'In flight', num: true }, { label: 'Age', num: true }
];

/**
 * The master's status panel under the launcher (tx/html/status-panel.liquid): a header, the
 * cluster's tiles, the memory meter, a row per process, and footnotes. Requests are those each
 * process served (its own count since it started), and the tile is their sum.
 * @param {Object} snapshot - from buildSnapshot
 * @param {Object} opts - now, uptime (the master's, text), uptimeSub, host ({used, total} bytes)
 */
function clusterView(snapshot, { now = Date.now(), uptime = '—', uptimeSub = null, host = null } = {}) {
  const m = snapshot.memory;
  const procs = snapshot.processes;
  const fresh = procs.filter(p => p.fresh);
  const requests = fresh.reduce((a, p) => a + (p.requests || 0), 0);
  const longest = Math.max(0, ...procs.map(p => p.uptimeMs || 0));
  const restarts = procs.reduce((a, p) => a + p.restarts, 0);
  const c = snapshot.caches;
  const tiles = [
    { label: 'Requests', value: n(requests), sub: longest > 60000 ? `${rate(requests / (longest / 60000))} /min avg` : null },
    { label: 'Client caches', value: dash(c.clientCaches, n), sub: c.clientConcepts === null ? null
      : `${n(c.clientConcepts)} concepts${c.scope === 'shared' ? ' · shared' : ''}` },
    { label: 'Expansion cache', value: dash(c.expansionItems, n), unit: 'items' },
    { label: 'In flight', value: dash(snapshot.inFlight, n), sub: snapshot.refusing.length ? `refusing: ${snapshot.refusing.join(', ')}` : 'none refusing' },
    { label: 'Restarts', value: n(restarts), sub: 'since launch' },
    { label: 'Uptime', value: uptime, sub: uptimeSub }
  ];
  const segments = procs.map((p, i) => ({ label: p.label, bytes: p.anon || 0, swatch: swatch(i) }));
  segments.push({ label: 'Launcher', bytes: snapshot.launcher.anon || 0, swatch: { color: NEUTRAL, striped: false } });
  const notes = host ? [`Host: ${gb(host.used)} of ${gb(host.total)} GB in use`] : [];
  const memory = m.cgroup
    ? meter({ ...m, used: m.cgroup.anon, scope: 'cgroup private', segments, notes })
    : meter({ ...m, used: m.processAnon, scope: 'processes\' private, summed', segments, notes });
  const limits = new Set([...procs, snapshot.launcher].map(p => p.heapLimit).filter(Number.isFinite));
  const heapLimit = limits.size === 1 ? [...limits][0] : null;
  const heap = (p) => (p.heapUsed === null ? '—' : heapLimit ? mb(p.heapUsed) : `${mb(p.heapUsed)} / ${mb(p.heapLimit)}`);
  const rows = procs.map((p, i) => ({
    swatch: swatch(i),
    cells: [{ text: p.label }, { pills: pill(p.fresh || p.figuresAgeMs === null ? p.status : 'stale', p.refusing === true) },
      { text: duration(p.uptimeMs), num: true }, { text: n(p.restarts), num: true }, { text: dash(p.requests, n), num: true },
      { text: dash(p.anon, mb), num: true }, { text: dash(p.file, mb), num: true },
      { text: heap(p), num: true },
      { text: dash(p.clientCaches, n), num: true }, { text: dash(p.clientConcepts, n), num: true },
      { text: dash(p.inFlight, n), num: true }, { text: ago(p.figuresAgeMs), num: true }]
  }));
  const l = snapshot.launcher;
  rows.push({ swatch: { color: NEUTRAL, symbol: '' }, cells: [{ text: 'Launcher' }, { pills: pill('running') },
    { text: duration(l.uptimeMs), num: true }, { text: '—', num: true }, { text: '—', num: true },
    { text: dash(l.anon, mb), num: true }, { text: dash(l.file, mb), num: true },
    { text: heap(l), num: true },
    { text: '—', num: true }, { text: '—', num: true }, { text: '—', num: true }, { text: 'now', num: true }] });
  const footnotes = [
    'Mapped: terminology files a process has mapped; shared pages count in each process and are not in the memory above.',
    ...snapshot.missing.map(text => `Not shown: ${text}.`)
  ];
  return {
    heading: 'Cluster', meta: [`${procs.length} processes`, `updated ${ago(now - snapshot.sampledAt) === 'now' ? 'just now' : ago(now - snapshot.sampledAt) + ' ago'}`],
    tiles, memory, table: { columns: tableColumns(heapLimit), rows }, footnotes
  };
}

/**
 * The status panel of one process: a server with no role, a worker's own page, or a master
 * before the launcher's first snapshot. Tiles and the meter, no per-process table.
 * @param {Object} own - figures (ownFigures), uptime (text), uptimeSub, static (count), avgPerMin,
 *   guard ({measure, limit, rejectAt, abortAt, rejectFraction, abortFraction, group, fileBacked}),
 *   anon (this process's RssAnon, or null), host
 * @param {Object} opts - heading, meta
 */
function processView(own, { heading = 'Server', meta = ['this process'] } = {}) {
  const f = own.figures;
  const g = own.guard;
  const tiles = [
    { label: 'Requests', value: n(f.requests), sub: [Number.isFinite(own.avgPerMin) ? `${rate(own.avgPerMin)} /min avg` : null,
      own.static ? `${n(own.static)} static` : null].filter(Boolean).join(' · ') || null },
    { label: 'Client caches', value: n(f.clientCaches), sub: `${n(f.clientConcepts)} concepts` },
    { label: 'Expansion cache', value: n(f.expansionItems), unit: 'items' },
    { label: 'In flight', value: dash(f.inFlight, n), sub: f.refusing ? 'refusing' : 'not refusing' },
    { label: 'Heap', value: mb(f.heapUsed), unit: 'MB', sub: `of ${mb(f.heapLimit)} MB` },
    { label: 'Uptime', value: own.uptime, sub: own.uptimeSub }
  ];
  const scope = g.group ? 'cgroup private, every process' : g.fileBacked ? 'this process, RSS less mapped files' : 'this process, RSS';
  const segments = [{ label: 'this process', bytes: g.group ? own.anon || 0 : g.measure, swatch: swatch(0) }];
  const notes = own.host ? [`Host: ${gb(own.host.used)} of ${gb(own.host.total)} GB in use`] : [];
  return {
    heading, meta, tiles,
    memory: meter({ ...g, used: g.measure, scope, segments, notes }),
    table: null, footnotes: []
  };
}

/**
 * The storage tiles below the graphs: closure tables, logs and disk, where there are any.
 * @param {Object} s - heading, closure (closureStats() or null), logs ({files, bytes, kept}
 *   or null), disk ({free, total} bytes, or null)
 */
function storageView({ heading = 'Storage', closure = null, logs = null, disk = null }) {
  const tiles = [];
  if (closure) {
    tiles.push({ label: 'Closure tables', value: n(closure.tables) });
    tiles.push({ label: 'Closure entries', value: n(closure.entries) });
    tiles.push({ label: 'Closure concepts', value: n(closure.concepts) });
    const small = closure.bytes !== null && closure.bytes < 2 ** 20;
    tiles.push({ label: 'Closure database', value: closure.bytes === null ? 'in memory' : small ? n(Math.ceil(closure.bytes / 1024)) : mb(closure.bytes),
      unit: closure.bytes === null ? null : small ? 'KB' : 'MB', sub: closure.retentionDays ? `kept ${closure.retentionDays} days unused` : null });
  }
  if (logs) {
    tiles.push({ label: 'Logs', value: mb(logs.bytes), unit: 'MB', sub: `${n(logs.files)} files · ${logs.kept} kept` });
  }
  if (disk) {
    tiles.push({ label: 'Disk free', value: gb(disk.free), unit: 'GB', sub: `of ${gb(disk.total)} GB` });
  }
  // as many columns as tiles, up to six: the row is never short
  return { heading, meta: [], tiles, columns: Math.min(6, Math.max(1, tiles.length)), memory: null, table: null, footnotes: [] };
}

// the memory guard's measure at this share of its refusal threshold or more is shown as a problem
const NEAR_REFUSING = 0.9;
// and less free disk than this share of it
const DISK_LOW = 0.1;

/**
 * The problems the status line lists, each a sentence; none when all is well.
 * @param {Object} p - refusing (labels), measure, rejectAt (the memory guard's), down
 *   ({label, status}: processes not running), stale ({label, ageMs}), restarts ({label, count}),
 *   disk ({free, total}|null), failedTasks ({name, state, date}, stats.failedTasks()), other
 *   (sentences of their own, such as npm audit's), now
 */
function problems({ refusing = [], measure = null, rejectAt = null, down = [], stale = [], restarts = [], disk = null, failedTasks = [], other = [], now = Date.now() }) {
  const list = [];
  const memory = Number.isFinite(measure) && rejectAt > 0 ? `${gb(measure)} GB, threshold ${gb(rejectAt)} GB` : null;
  if (refusing.length) {
    list.push(`Refusing requests: ${refusing.join(', ')}${memory ? ` (memory ${memory})` : ''}`);
  } else if (memory && measure >= NEAR_REFUSING * rejectAt) {
    list.push(`Memory near the refusal threshold: ${memory}`);
  }
  for (const p of down) list.push(`${p.label}: ${p.status}`);
  for (const p of stale) list.push(`${p.label}: no figures for ${Math.round(p.ageMs / 1000)} s`);
  for (const p of restarts) list.push(`${p.label} restarted ${n(p.count)} ${p.count === 1 ? 'time' : 'times'} since launch`);
  if (disk && disk.total > 0 && disk.free < DISK_LOW * disk.total) {
    list.push(`Disk low: ${gb(disk.free)} GB free of ${gb(disk.total)} GB`);
  }
  for (const t of failedTasks) list.push(`${t.name} failed${Number.isFinite(t.date) ? ` ${duration(now - t.date)} ago` : ''}: ${t.state}`);
  return list.concat(other);
}

/**
 * The status line at the top of / and /dashboard (tx/html/status-line.liquid) on the master
 * under the launcher: the cluster's requests, the master's uptime, the heap of every process
 * summed, and the problems. The rest is in clusterView, under "More".
 * @param {Object} snapshot - from buildSnapshot
 * @param {Object} opts - uptime, uptimeSub, disk, failedTasks, other, now
 */
function clusterSummary(snapshot, { uptime = '—', uptimeSub = null, disk = null, failedTasks = [], other = [], now = Date.now() } = {}) {
  const m = snapshot.memory;
  const procs = snapshot.processes;
  const fresh = procs.filter(p => p.fresh);
  const requests = fresh.reduce((a, p) => a + (p.requests || 0), 0);
  const longest = Math.max(0, ...procs.map(p => p.uptimeMs || 0));
  const heaps = [...fresh, snapshot.launcher].filter(p => Number.isFinite(p.heapUsed));
  const label = (code) => (procs.find(p => p.code === code) || { label: code }).label;
  return {
    items: [
      { label: 'Requests', value: n(requests), sub: longest > 60000 ? `${rate(requests / (longest / 60000))} /min` : null },
      { label: 'Uptime', value: uptime, sub: uptimeSub },
      { label: 'Heap', value: heaps.length ? mb(heaps.reduce((a, p) => a + p.heapUsed, 0)) : '—', unit: 'MB',
        sub: `${heaps.length} ${heaps.length === 1 ? 'process' : 'processes'}` }
    ],
    problems: problems({
      refusing: snapshot.refusing.map(label),
      measure: m.cgroup ? m.cgroup.anon : m.processAnon, rejectAt: m.rejectAt,
      down: procs.filter(p => p.status !== 'ready' && p.status !== 'running').map(p => ({ label: p.label, status: p.status })),
      stale: procs.filter(p => !p.fresh && p.figuresAgeMs !== null && p.uptimeMs !== null).map(p => ({ label: p.label, ageMs: p.figuresAgeMs })),
      restarts: procs.filter(p => p.restarts > 0).map(p => ({ label: p.label, count: p.restarts })),
      disk, failedTasks, other, now
    })
  };
}

/**
 * The status line of one process (processView's figures): its requests, uptime and heap, and
 * the problems.
 * @param {Object} own - as for processView, with disk, failedTasks and other
 */
function processSummary(own, { now = Date.now() } = {}) {
  const f = own.figures;
  const g = own.guard;
  return {
    items: [
      { label: 'Requests', value: n(f.requests), sub: Number.isFinite(own.avgPerMin) ? `${rate(own.avgPerMin)} /min` : null },
      { label: 'Uptime', value: own.uptime, sub: own.uptimeSub },
      { label: 'Heap', value: mb(f.heapUsed), unit: 'MB', sub: `of ${mb(f.heapLimit)}` }
    ],
    problems: problems({ refusing: f.refusing ? ['this process'] : [], measure: g.measure, rejectAt: g.rejectAt,
      disk: own.disk || null, failedTasks: own.failedTasks || [], other: own.other || [], now })
  };
}

module.exports = { ownFigures, connectStatus, buildSnapshot, clusterView, processView, storageView, problems, clusterSummary, processSummary, PALETTE, STATUS, CLUSTER_STATUS, STATUS_INTERVAL_MS, STALE_INTERVALS };
