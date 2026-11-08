/**
 * The cluster's state now, for the master's status table (/ and /dashboard) and
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
 */
const v8 = require('v8');
const escape = require('escape-html');

// a process's own figures, to the launcher; the launcher's snapshot, to the master
const STATUS = 'fhirsmith:status';
const CLUSTER_STATUS = 'fhirsmith:cluster-status';
// how often each process sends its figures, and the launcher sends the master its snapshot
// (server.cluster.statusSeconds)
const STATUS_INTERVAL_MS = 15000;
// figures this many intervals old are shown with their age, and left out of the totals
const STALE_INTERVALS = 3;

const MB = (b) => `${Math.round(b / 2 ** 20).toLocaleString('en-US')} MB`;
const GB = (b) => `${(b / 2 ** 30).toFixed(1)} GB`;
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
  if (ms === null || ms === undefined) return 'never';
  return ms < 1000 ? 'just now' : `${Math.round(ms / 1000)} s ago`;
}

function duration(ms) {
  if (ms === null) return '-';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

const dash = (v, f = String) => (v === null || v === undefined ? '-' : f(v));

/**
 * The master's status table under the launcher: the cluster's totals first, then a row for
 * each process. Every figure says what it covers.
 * @param {Object} snapshot - from buildSnapshot
 * @param {Object} opts
 * @param {number} [opts.now]
 * @param {Object} opts.requests - the request count row (server.js requestCounts)
 * @param {string} opts.uptime - the master's uptime text
 * @param {string} [opts.system] - the host's memory cell, as before
 * @param {boolean} [opts.compact] - the dashboard: no cache row
 * @param {function(number): string} [opts.pctColor] - a cell's background for a percentage
 * @returns {string} HTML
 */
function renderClusterTable(snapshot, { now = Date.now(), requests, uptime, system = '', compact = false, pctColor = () => 'transparent' }) {
  const m = snapshot.memory;
  const age = ago(now - snapshot.sampledAt);
  // on a phone the totals' cells stack, one under another, rather than run past the page
  let html = '<style>@media (max-width:600px){table.cluster-status,table.cluster-status tbody,table.cluster-status tr,' +
    'table.cluster-status td,table.cluster-status caption{display:block;width:auto}}</style>';
  html += '<table class="grid cluster-status">';
  html += `<caption style="caption-side:top">Cluster: every process together, as of ${escape(age)} (each reports every ${Math.round(snapshot.intervalMs / 1000)} s)</caption>`;
  html += '<tr>';
  html += `<td><strong>Uptime (master):</strong> ${escape(uptime)}</td>`;
  html += `<td><strong>Request Count (every process):</strong> ${requests.count} (${escape(requests.detail)})</td>`;
  // (the dashboard has no average: its third cell is `system`, the disk)
  html += requests.avg !== undefined ? `<td><strong>Avg Requests/min (every process):</strong> ${requests.avg}</td>` : system;
  html += '</tr><tr>';
  const thresholds = `refused above ${GB(m.rejectAt)} (${Math.round(m.rejectFraction * 100)}%), aborted above ${GB(m.abortAt)} (${Math.round(m.abortFraction * 100)}%)`;
  if (m.cgroup) {
    const pct = (m.cgroup.anon * 100) / m.limit;
    html += `<td style="background-color:${pctColor(pct)}"><strong>Memory (cgroup, private):</strong> ${GB(m.cgroup.anon)} of ${GB(m.limit)} (${pct.toFixed(0)}%); ` +
      `new requests ${thresholds}</td>`;
    html += `<td><strong>Page cache (cgroup, shared, counted once):</strong> ${m.cgroup.file === null ? 'not known' : GB(m.cgroup.file)}; ` +
      'the terminology files, mapped or read, that the kernel charges to this cgroup (a page goes to the cgroup that first read it, so ' +
      'pages still cached from before a restart are not here); it takes them back as it needs to</td>';
  } else {
    html += `<td><strong>Memory (sum of the processes' private):</strong> ${m.processAnon === null ? 'not known' : GB(m.processAnon)}; ` +
      `each process's memory guard measures itself against ${GB(m.limit)} (${escape(m.limitSource || '')}): ${thresholds}</td>`;
    html += '<td><strong>Page cache (shared):</strong> not known without a cgroup of the service\'s own</td>';
  }
  const refusing = snapshot.refusing.length ? `refusing: ${snapshot.refusing.map(escape).join(', ')}` : 'none refusing';
  html += requests.avg !== undefined ? system || '<td></td>' : `<td><strong>In flight (every process):</strong> ${dash(snapshot.inFlight, n)} requests; ${refusing}</td>`;
  html += '</tr>';
  if (!compact) {
    const c = snapshot.caches;
    html += '<tr>';
    html += `<td><strong>Expansion Cache (each process its own):</strong> ${dash(c.expansionItems, n)} items in all</td>`;
    html += c.scope === 'shared'
      ? `<td><strong>Client Cache (shared store, counted once):</strong> ${dash(c.clientCaches, n)} caches / ${dash(c.clientConcepts, n)} concepts</td>`
      : `<td><strong>Client Cache (summed over the processes):</strong> ${dash(c.clientCaches, n)} caches / ${dash(c.clientConcepts, n)} concepts</td>`;
    html += `<td><strong>In flight (every process):</strong> ${dash(snapshot.inFlight, n)} requests; ${refusing}</td>`;
    html += '</tr>';
  }
  if (snapshot.missing.length) {
    html += `<tr><td colspan="3"><strong>Not shown:</strong> ${snapshot.missing.map(escape).join('; ')}</td></tr>`;
  }
  html += '</table>';
  return html + renderProcessTable(snapshot, compact);
}

/** A row for each process, and the launcher. */
function renderProcessTable(snapshot, compact = false) {
  const cols = ['Process', 'Status', 'Uptime', 'Restarts', 'Requests', 'Private (anon)', 'Mapped file', 'Heap',
    ...(compact ? [] : ['Client caches']), 'In flight', 'Refusing', 'Figures'];
  // a phone scrolls the table, not the page; the note above it stays in view
  let html = '<div class="cluster-processes"><p style="margin:10px 0 4px">Each process: memory from /proc (a mapped page shared by several counts in each); ' +
    'the launcher\'s requests are those it passed on</p><div style="max-width:100%;overflow-x:auto"><table class="grid">';
  html += '<tr>' + cols.map(c => `<th>${c}</th>`).join('') + '</tr>';
  const heap = p => p.heapUsed === null ? '-' : `${MB(p.heapUsed)}${p.heapLimit ? ` of ${MB(p.heapLimit)}` : ''}`;
  for (const p of snapshot.processes) {
    const cells = [escape(p.label), escape(p.status), duration(p.uptimeMs), n(p.restarts), dash(p.requests, n),
      dash(p.anon, MB), dash(p.file, MB), heap(p),
      ...(compact ? [] : [p.clientCaches === null ? '-' : `${n(p.clientCaches)} / ${n(p.clientConcepts)} concepts`]),
      dash(p.inFlight, n), p.refusing === null ? '-' : p.refusing ? '<strong>yes</strong>' : 'no',
      p.figuresAgeMs === null ? 'none yet' : `${ago(p.figuresAgeMs)}${p.fresh ? '' : ' (stale)'}`];
    html += '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
  }
  const l = snapshot.launcher;
  const cells = [l.label, l.status, duration(l.uptimeMs), '-', dash(l.requests, n), dash(l.anon, MB), dash(l.file, MB), heap(l),
    ...(compact ? [] : ['-']), '-', '-', ago(0)];
  html += '<tr>' + cells.map(c => `<td>${c}</td>`).join('') + '</tr>';
  return html + '</table></div></div>';
}

module.exports = { ownFigures, connectStatus, buildSnapshot, renderClusterTable, STATUS, CLUSTER_STATUS, STATUS_INTERVAL_MS, STALE_INTERVALS };
