/**
 * library/cluster-status.js: the processes' figures over IPC, the launcher's merged snapshot,
 * and the master's status table.
 */
const { EventEmitter } = require('events');
const { connectStatus, buildSnapshot, renderClusterTable, STATUS, CLUSTER_STATUS } = require('../../library/cluster-status');

const GiB = 2 ** 30;
const MiB = 2 ** 20;
const now = 1800000000000;
const guard = { limit: 12 * GiB, source: '/sys/fs/cgroup/system.slice/fhirsmith.service/memory.max',
  rejectFraction: 0.85, abortFraction: 0.92, rejectAt: 0.85 * 12 * GiB, abortAt: 0.92 * 12 * GiB, group: { dir: 'x', version: 2 } };
const figures = (time, values = {}) => ({ time, requests: 10, heapUsed: 300 * MiB, heapLimit: 4096 * MiB,
  clientCaches: 2, clientConcepts: 1000, expansionItems: 40, inFlight: 1, refusing: false, ...values });
const procs = () => [
  { code: 'm0', role: 'master', status: 'ready', restarts: 0, startedAt: now - 3600000,
    figures: figures(now - 4000, { clientCaches: 5, clientConcepts: 5000 }), memory: { anon: 3 * GiB, file: 2 * GiB } },
  { code: 'tx1', role: 'tx-worker', status: 'ready', restarts: 1, startedAt: now - 600000,
    figures: figures(now - 9000, { refusing: true, inFlight: 4 }), memory: { anon: 2 * GiB, file: 2 * GiB } },
  { code: 'tx2', role: 'tx-worker', status: 'ready', restarts: 0, startedAt: now - 3500000,
    figures: figures(now - 12000), memory: { anon: 2.5 * GiB, file: 1.5 * GiB } }
];
const launcher = { startedAt: now - 3700000, requests: 1234, memory: { anon: 80 * MiB, file: 40 * MiB }, heapUsed: 20 * MiB, heapLimit: 4096 * MiB };
const snapshot = (extra = {}) => buildSnapshot({ now, intervalMs: 15000, procs: procs(), launcher, guard,
  cgroup: { anon: 7.6 * GiB, file: 3.1 * GiB }, ...extra });

describe('the launcher\'s snapshot', () => {
  test('sums each process\'s own caches, and keeps the cgroup\'s memory and the guard\'s thresholds', () => {
    const s = snapshot();
    expect(s.memory).toMatchObject({ cgroup: { anon: 7.6 * GiB, file: 3.1 * GiB }, limit: 12 * GiB,
      rejectAt: guard.rejectAt, abortAt: guard.abortAt, group: true });
    // the processes' private memory, and the launcher's, summed: not what the guard measures
    expect(s.memory.processAnon).toBe(7.5 * GiB + 80 * MiB);
    expect(s.caches).toEqual({ scope: 'summed', clientCaches: 9, clientConcepts: 7000, expansionItems: 120 });
    expect(s.inFlight).toBe(6);
    expect(s.refusing).toEqual(['tx1']);
    expect(s.processes.map(p => [p.label, p.uptimeMs, p.figuresAgeMs, p.restarts])).toEqual([
      ['Master m0', 3600000, 4000, 0], ['Worker tx1', 600000, 9000, 1], ['Worker tx2', 3500000, 12000, 0]]);
    expect(s.launcher).toMatchObject({ label: 'Launcher', requests: 1234, anon: 80 * MiB, uptimeMs: 3700000 });
    expect(s.missing).toEqual([]);
  });

  test('with the shared cache, the client caches are read once (the master\'s figure), not summed', () => {
    const s = snapshot({ sharedCache: true });
    expect(s.caches).toEqual({ scope: 'shared', from: 'm0', clientCaches: 5, clientConcepts: 5000, expansionItems: 120 });
    // the master not reporting: another process's count of the same store
    const p = procs();
    p[0].figures = null;
    expect(buildSnapshot({ now, intervalMs: 15000, procs: p, launcher, guard, cgroup: null, sharedCache: true }).caches)
      .toMatchObject({ scope: 'shared', from: 'tx1', clientCaches: 2 });
  });

  test('stale figures are shown with their age but left out of the totals, and say so', () => {
    const p = procs();
    p[2].figures.time = now - 46000; // more than three 15 s intervals
    const s = buildSnapshot({ now, intervalMs: 15000, procs: p, launcher, guard, cgroup: { anon: GiB, file: GiB } });
    expect(s.processes[2]).toMatchObject({ fresh: false, figuresAgeMs: 46000, clientCaches: 2 });
    expect(s.caches.clientCaches).toBe(7);
    expect(s.missing).toEqual(['1 running process(es) have sent no figures in the last 45 s: the totals leave them out']);
  });

  test('nothing invented where /proc or the cgroup can\'t be read', () => {
    const p = procs().map(x => ({ ...x, memory: null }));
    p[1] = { ...p[1], startedAt: 0, figures: null, status: 'restarting' };
    const s = buildSnapshot({ now, intervalMs: 15000, procs: p, launcher: { startedAt: now - 1000, requests: 0, memory: null },
      guard: { ...guard, group: null, source: 'os.totalmem()' }, cgroup: null, procAvailable: false });
    expect(s.memory.cgroup).toBeNull();
    expect(s.memory.processAnon).toBeNull();
    expect(s.processes[1]).toMatchObject({ uptimeMs: null, anon: null, requests: null, figuresAgeMs: null });
    expect(s.missing).toEqual([
      'per-process memory: /proc is not available here (Linux only)',
      expect.stringMatching(/^the cgroup's memory: there is no cgroup with a memory limit of the service's own/)
    ]);
  });
});

describe('the status table', () => {
  const requests = { count: 5000, detail: 'master: 1000, workers: 4000, static: 12', avg: '83.3' };
  const render = (s, extra = {}) => renderClusterTable(s, { now: now + 2000, requests, uptime: '1h 0m 0s', ...extra });

  test('totals first, each labelled with its scope and the data\'s age; then a row per process and the launcher', () => {
    const html = render(snapshot());
    expect(html).toContain('Cluster: every process together, as of 2 s ago (each reports every 15 s)');
    expect(html).toContain('<strong>Memory (cgroup, private):</strong> 7.6 GB of 12.0 GB (63%); new requests refused above 10.2 GB (85%), aborted above 11.0 GB (92%)');
    expect(html).toContain('<strong>Page cache (cgroup, shared, counted once):</strong> 3.1 GB');
    expect(html).toContain('<strong>Expansion Cache (each process its own):</strong> 120 items in all');
    expect(html).toContain('<strong>Client Cache (summed over the processes):</strong> 9 caches / 7,000 concepts');
    expect(html).toContain('<strong>In flight (every process):</strong> 6 requests; refusing: tx1');
    expect(html).toContain('<strong>Request Count (every process):</strong> 5000 (master: 1000, workers: 4000, static: 12)');
    expect(html.indexOf('Memory (cgroup, private)')).toBeLessThan(html.indexOf('<th>Process</th>'));
    const rows = [...html.matchAll(/<tr><td>([^<]+)<\/td><td>([^<]+)<\/td>/g)].map(m => [m[1], m[2]]);
    expect(rows).toEqual([['Master m0', 'ready'], ['Worker tx1', 'ready'], ['Worker tx2', 'ready'], ['Launcher', 'running']]);
    expect(html).toContain('<td>Worker tx1</td><td>ready</td><td>10m 0s</td><td>1</td><td>10</td><td>2,048 MB</td><td>2,048 MB</td><td>300 MB of 4,096 MB</td>' +
      '<td>2 / 1,000 concepts</td><td>4</td><td><strong>yes</strong></td><td>9 s ago</td>');
    expect(html).not.toContain('Not shown');
  });

  test('the shared store is counted once, and what is missing is said', () => {
    const html = render(buildSnapshot({ now, intervalMs: 15000, procs: procs(), launcher, sharedCache: true,
      guard: { ...guard, group: null, source: 'os.totalmem()' }, cgroup: null }));
    expect(html).toContain('<strong>Client Cache (shared store, counted once):</strong> 5 caches / 5,000 concepts');
    expect(html).toContain('<strong>Memory (sum of the processes\' private):</strong> 7.6 GB; each process\'s memory guard measures itself against 12.0 GB (os.totalmem())');
    expect(html).toContain('<strong>Page cache (shared):</strong> not known without a cgroup of the service\'s own');
    expect(html).toMatch(/<strong>Not shown:<\/strong> the cgroup&#39;s memory: there is no cgroup/);
  });

  test('the dashboard\'s compact form leaves out the cache row and column', () => {
    const html = render(snapshot(), { compact: true, system: '<td>Disk</td>', requests: { ...requests, avg: undefined } });
    expect(html).not.toContain('Client Cache');
    // no empty cell: the disk in the first row, in flight in the second
    expect(html).not.toContain('<td></td>');
    expect(html).toMatch(/5000 \(master: 1000, workers: 4000, static: 12\)<\/td><td>Disk<\/td><\/tr>/);
    expect(html).toContain('<strong>In flight (every process):</strong> 6 requests; refusing: tx1</td></tr>');
    expect(html).not.toContain('<th>Client caches</th>');
    expect(html).toContain('<td>Disk</td>');
  });

  test('labels are escaped', () => {
    const p = procs();
    p[0].status = '<b>';
    expect(render(buildSnapshot({ now, intervalMs: 15000, procs: p, launcher, guard, cgroup: null }))).toContain('&lt;b&gt;');
  });
});

describe('the IPC channel', () => {
  test('a process sends its figures at once and every interval; the master keeps the launcher\'s snapshot', () => {
    jest.useFakeTimers();
    try {
      const channel = new EventEmitter();
      channel.connected = true;
      channel.send = jest.fn((message, done) => done());
      const stats = {};
      let n = 0;
      const close = connectStatus(stats, channel, { role: 'master', intervalMs: 15000, figures: () => ({ n: ++n }) });
      expect(channel.send.mock.calls.map(c => c[0])).toEqual([{ type: STATUS, figures: { n: 1 } }]);
      jest.advanceTimersByTime(30000);
      expect(channel.send).toHaveBeenCalledTimes(3);
      channel.emit('message', { type: CLUSTER_STATUS, snapshot: { sampledAt: now } });
      expect(stats.clusterStatus).toEqual({ sampledAt: now });
      // the launcher gone: the master's own figures again
      channel.emit('disconnect');
      expect(stats.clusterStatus).toBeNull();
      close();
      jest.advanceTimersByTime(30000);
      expect(channel.send).toHaveBeenCalledTimes(3);
      expect(channel.listenerCount('message')).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('one send at a time; a worker ignores snapshots; figures that throw are skipped; no channel, nothing', () => {
    jest.useFakeTimers();
    try {
      const channel = new EventEmitter();
      channel.send = jest.fn(() => {});
      const stats = {};
      let fail = false;
      const close = connectStatus(stats, channel, { role: 'tx-worker', intervalMs: 1000, figures: () => {
        if (fail) throw new Error('no');
        return {};
      } });
      jest.advanceTimersByTime(5000);
      expect(channel.send).toHaveBeenCalledTimes(1); // the first never completed
      channel.emit('message', { type: CLUSTER_STATUS, snapshot: {} });
      expect(stats.clusterStatus).toBeUndefined();
      close();
      fail = true;
      const other = new EventEmitter();
      other.send = jest.fn((m, done) => done());
      connectStatus({}, other, { figures: () => { throw new Error('no'); } })();
      expect(other.send).not.toHaveBeenCalled();
      expect(() => connectStatus({}, new EventEmitter())()).not.toThrow();
    } finally {
      jest.useRealTimers();
    }
  });
});
