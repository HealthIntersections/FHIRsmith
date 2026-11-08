/**
 * library/cluster-status.js: the processes' figures over IPC, the launcher's merged snapshot,
 * and the master's status table.
 */
const { EventEmitter } = require('events');
const { connectStatus, buildSnapshot, clusterView, processView, storageView, PALETTE, STATUS, CLUSTER_STATUS } = require('../../library/cluster-status');

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

describe('the status panel', () => {
  const path = require('path');
  const { Liquid } = require('liquidjs');
  const liquid = new Liquid({ root: path.join(__dirname, '../../tx/html'), extname: '.liquid' });
  const host = { used: 30 * GiB, total: 64 * GiB };
  const view = (s = snapshot()) => clusterView(s, { now: now + 2000, uptime: '1h 0m 0s', uptimeSub: '99.5% overall', host });
  const cellsOf = (v, row) => v.table.rows[row].cells.map(c => c.pills ? c.pills.map(p => p.text).join('+') : c.text);

  test('a header, then tiles: requests are the sum of what each process served', () => {
    const v = view();
    expect([v.heading, ...v.meta]).toEqual(['Cluster', '3 processes', 'updated 2 s ago']);
    expect(v.tiles.map(t => [t.label, t.value, t.unit || null, t.sub])).toEqual([
      ['Requests', '30', null, '0.5 /min avg'],
      ['Client caches', '9', null, '7,000 concepts'],
      ['Expansion cache', '120', 'items', undefined],
      ['In flight', '6', null, 'refusing: tx1'],
      ['Restarts', '1', null, 'since launch'],
      ['Uptime', '1h 0m 0s', null, '99.5% overall']
    ]);
    // the rows' requests add up to the tile
    expect(v.table.rows.slice(0, 3).map(r => Number(r.cells[4].text))).toEqual([10, 10, 10]);
  });

  test('the meter: the cgroup\'s private memory, a segment per process, ticks at the thresholds', () => {
    const m = view().memory;
    expect(m.scope).toBe('cgroup private');
    expect(m.value).toBe('7.6 GB of 12.0 GB (63%)');
    expect(m.segments.map(s => [s.label, s.color])).toEqual([['Master m0', PALETTE[0]], ['Worker tx1', PALETTE[1]],
      ['Worker tx2', PALETTE[2]], ['Launcher', '#d9d9d9']]);
    expect(m.segments.map(s => s.striped)).toEqual([false, true, false, false]);
    expect(m.ticks).toEqual([{ label: 'refuse 85% · 10.2 GB', at: '85.00', right: '15.00' }, { label: 'abort 92% · 11.0 GB', at: '92.00', right: '8.00' }]);
    expect(m.notes).toEqual(['Host: 30.0 of 64.0 GB in use']);
    // what the processes don't account for is its own, hatched segment
    const more = view(buildSnapshot({ now, intervalMs: 15000, procs: procs(), launcher, guard, cgroup: { anon: 9 * GiB, file: 0 } })).memory;
    expect(more.segments.at(-1)).toMatchObject({ label: 'other', striped: true });
    // nothing to measure: said so, no bar
    expect(view(buildSnapshot({ now, intervalMs: 15000, procs: procs().map(p => ({ ...p, memory: null })),
      launcher: { ...launcher, memory: null }, guard, cgroup: null })).memory).toMatchObject({ unknown: true });
  });

  test('a row per process and the launcher, with one unit a column and "—" where nothing applies', () => {
    const v = view();
    // every process has the same heap limit: it goes in the header
    expect(v.table.columns.map(c => c.label)).toEqual(['Process', 'Status', 'Uptime', 'Restarts', 'Requests', 'Private MB',
      'Mapped MB', 'Heap MB of 4,096', 'Caches', 'Concepts', 'In flight', 'Age']);
    expect(cellsOf(v, 1)).toEqual(['Worker tx1', 'ready+refusing', '10m 0s', '1', '10', '2,048', '2,048', '300', '2', '1,000', '4', '9 s']);
    expect(cellsOf(v, 3)).toEqual(['Launcher', 'running', '1h 1m', '—', '—', '80', '40', '20', '—', '—', '—', 'now']);
    expect(v.table.rows.every(r => r.cells.length === v.table.columns.length)).toBe(true);
    // limits that differ: in each cell
    const p = procs();
    p[1].figures.heapLimit = 2048 * MiB;
    const mixed = view(buildSnapshot({ now, intervalMs: 15000, procs: p, launcher, guard, cgroup: null }));
    expect(mixed.table.columns[7].label).toBe('Heap MB used / limit');
    expect(cellsOf(mixed, 1)[7]).toBe('300 / 2,048');
    expect(v.footnotes).toEqual(['Mapped: terminology files a process has mapped; shared pages count in each process and are not in the memory above.']);
  });

  test('stale figures, the shared store and what is missing', () => {
    const p = procs();
    p[2].figures.time = now - 46000;
    const v = view(buildSnapshot({ now, intervalMs: 15000, procs: p, launcher, sharedCache: true,
      guard: { ...guard, group: null, source: 'os.totalmem()' }, cgroup: null }));
    expect(cellsOf(v, 2)[1]).toBe('stale');
    expect(v.tiles[1]).toMatchObject({ value: '5', sub: '5,000 concepts · shared' });
    expect(v.memory.scope).toBe('processes\' private, summed');
    expect(v.footnotes.slice(1)).toEqual([
      'Not shown: 1 running process(es) have sent no figures in the last 45 s: the totals leave them out.',
      expect.stringMatching(/^Not shown: the cgroup's memory: there is no cgroup/)
    ]);
  });

  test('one process: a server with no role, or a worker measured as the cgroup', () => {
    const own = { figures: figures(now), uptime: '5m 0s', uptimeSub: null, static: 3, avgPerMin: 2.04,
      anon: 2 * GiB, host,
      guard: { measure: 3 * GiB, limit: 12 * GiB, rejectAt: guard.rejectAt, abortAt: guard.abortAt, rejectFraction: 0.85, abortFraction: 0.92, group: false } };
    const single = processView(own);
    expect([single.heading, ...single.meta]).toEqual(['Server', 'this process']);
    expect(single.tiles.map(t => t.label)).toEqual(['Requests', 'Client caches', 'Expansion cache', 'In flight', 'Heap', 'Uptime']);
    expect(single.tiles[0].sub).toBe('2 /min avg · 3 static');
    expect(single.tiles[1].sub).toBe('1,000 concepts');
    expect(single.memory).toMatchObject({ scope: 'this process, RSS', value: '3.0 GB of 12.0 GB (25%)' });
    expect(single.table).toBeNull();
    const worker = processView({ ...own, guard: { ...own.guard, group: true, measure: 7 * GiB } },
      { heading: 'Worker tx1', meta: ['this process only'] });
    expect(worker.memory.scope).toBe('cgroup private, every process');
    expect(worker.memory.segments.map(s => s.label)).toEqual(['this process', 'other']);
  });

  test('storage tiles: only what there is', () => {
    expect(storageView({ disk: { free: 15 * GiB, total: 900 * GiB } }).tiles).toEqual([
      { label: 'Disk free', value: '15.0', unit: 'GB', sub: 'of 900.0 GB' }]);
    const tiles = storageView({ closure: { tables: 2, entries: 10, concepts: 30, bytes: null, retentionDays: 7 },
      logs: { files: 2, bytes: 5 * MiB, kept: 14 }, disk: { free: GiB, total: 2 * GiB } });
    expect(tiles.tiles.map(t => [t.label, t.value])).toEqual([['Closure tables', '2'], ['Closure entries', '10'], ['Closure concepts', '30'],
      ['Closure database', 'in memory'], ['Logs', '5'], ['Disk free', '1.0']]);
    expect(tiles.tiles.map(t => t.sub)).toEqual([undefined, undefined, undefined, 'kept 7 days unused', '2 files · 14 kept', 'of 2.0 GB']);
    // as many columns as tiles: six fill the grid, and two fill the width
    expect(tiles.columns).toBe(6);
    expect(storageView({ logs: { files: 1, bytes: 0, kept: 14 }, disk: { free: 1, total: 2 } }).columns).toBe(2);
    expect(storageView({ closure: { tables: 0, entries: 0, concepts: 0, bytes: 40960 } }).tiles[3]).toMatchObject({ value: '40', unit: 'KB' });
  });

  test('the template: tiles, meter, an aligned table, everything escaped; the palette is the graphs\'', async () => {
    const p = procs();
    p[0].status = '<b>';
    const html = await liquid.renderFile('status-panel', { view: view(buildSnapshot({ now, intervalMs: 15000, procs: p, launcher, guard,
      cgroup: { anon: 7.6 * GiB, file: GiB } })) });
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
    expect(html.match(/class="fs-status-tile"/g)).toHaveLength(6);
    expect(html.match(/class="fs-status-seg/g)).toHaveLength(4);
    expect(html.match(/class="fs-status-tick"/g)).toHaveLength(2);
    // each label ends at its own tick, on one line
    expect(html).toContain('<span class="fs-status-tick-1" style="right:15.00%">refuse 85% · 10.2 GB</span>');
    expect(html).toContain('<span class="fs-status-tick-2" style="right:8.00%">abort 92% · 11.0 GB</span>');
    expect(html).toContain('<th class="fs-num">Private MB</th>');
    expect(html).toMatch(/<td class="fs-num">2,048<\/td>/);
    expect(html).toContain('<th class="fs-num">Heap MB of 4,096</th>');
    expect(html).not.toMatch(/<td[^>]*><\/td>/);
    // every style is the panel's own: each selector, inside a media query or not, starts .fs-status
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '');
    const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(m => m[1].split(',')).map(x => x.trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(20);
    expect(selectors.filter(x => !x.startsWith('.fs-status'))).toEqual([]);
    const script = require('fs').readFileSync(path.join(__dirname, '../../tx/html/cluster-metrics-script.liquid'), 'utf8');
    expect([...script.matchAll(/color:'(#[0-9a-f]{6})', dash/g)].map(m => m[1]).slice(0, 8)).toEqual(PALETTE);
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
