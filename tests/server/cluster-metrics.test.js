const { EventEmitter } = require('events');
const { ClusterMetrics, connectMetrics, graphData, METRIC, SNAPSHOT, HISTORY_MS, MAX_POINTS } = require('../../library/cluster-metrics');

const procs = [{ code:'m0', role:'master', servesTx:false }, { code:'tx1', role:'tx-worker', servesTx:true }];
const now = 1800000000000;
const sample = (time, values = {}) => ({ startedAt:now - 10000, intervalMs:1000,
  point:{ time, mem:1048576, rpm:12, tat:3, block:2, blockMax:20, clientConcepts:9, ...values } });

describe('cluster graph history', () => {
  test('keeps samples separate, preserves numeric values and inserts restart and missing-sample gaps', () => {
    const store = new ClusterMetrics(procs);
    expect(store.snapshot(now).series.map(s => s.status)).toEqual(['starting', 'starting']);
    store.record('m0', sample(now, { mem:-1024 }), now);
    store.record('tx1', sample(now + 100, { rpm:99 }), now + 100);
    store.state('m0', 'ready', now);
    store.state('tx1', 'ready', now + 100);
    store.record('m0', sample(now + 4000), now + 4000);
    store.state('tx1', 'restarting', now + 200);
    store.state('tx1', 'restarting', now + 210);
    store.record('tx1', sample(now + 5000), now + 5000);
    const [master, worker] = store.snapshot(now + 5000).series;
    expect(master.label).toBe('Master m0');
    expect(master.history.map(p => p.time)).toEqual([now, now + 1000, now + 4000]);
    expect(master.history.map(p => p.mem)).toEqual([-1024, null, 1048576]);
    expect(worker.label).toBe('Worker tx1');
    expect(worker.history.map(p => p.rpm)).toEqual([99, null, 12]);
    expect(worker.restarts).toBe(1);
    expect(store.record('tx1', sample(now + 100), now + 5000)).toBe(false);
  });

  test('bounds history by both age and count and does not expose mutable internal rows', () => {
    const store = new ClusterMetrics(procs);
    for (let i = 0; i < MAX_POINTS + 7; i++) store.record('m0', sample(now + i), now + i);
    const before = store.snapshot(now + MAX_POINTS);
    expect(before.series[0].history).toHaveLength(MAX_POINTS);
    before.series[0].history[0].rpm = 9000;
    expect(store.snapshot(now + MAX_POINTS).series[0].history[0].rpm).toBe(12);
    expect(store.snapshot(now + MAX_POINTS + HISTORY_MS).series[0].history).toHaveLength(6);
    expect(store.record('bad-code', sample(now), now)).toBe(false);
    expect(store.record('tx1', sample(now, { time:Infinity }), now)).toBe(false);
    expect(store.record('tx1', { ...sample(now), intervalMs:0 }, now)).toBe(false);
  });

  test('retains refusal counts and actual sample boundaries across worker and restart gaps', () => {
    const store = new ClusterMetrics(procs);
    store.record('m0', sample(now, { refused:7, intervalStart:now - 2500 }), now);
    store.record('tx1', sample(now + 100, { refused:11, intervalStart:now - 900 }), now + 100);
    store.state('m0', 'restarting', now + 200);
    const [master, worker] = store.snapshot(now + 200).series;
    expect(master.history.map(p => p.refused)).toEqual([7, null]);
    expect(master.history.map(p => p.intervalStart)).toEqual([now - 2500, null]);
    expect(worker.history[0]).toMatchObject({ refused:11, intervalStart:now - 900 });
  });

  test('marks no recent sample and disconnected data without inventing zeroes', () => {
    const store = new ClusterMetrics(procs);
    store.record('m0', sample(now), now);
    store.state('m0', 'ready', now);
    store.state('tx1', 'ready', now);
    const snapshot = store.snapshot(now + 60001);
    expect(snapshot.series.map(s => s.status)).toEqual(['no recent sample', 'no recent sample']);
    expect(snapshot.series[1].history).toEqual([]);
    const data = JSON.parse(graphData({ clusterMetrics:snapshot, clusterMetricsUnavailable:true }, '', now));
    expect(data.series.map(s => s.status)).toEqual(['unavailable', 'unavailable']);
  });

  test('a standalone graph contains its local history and serializes safely in a script', () => {
    const data = graphData({ startTime:now - 10000, intervalMs:1000, history:[sample(now).point] }, '</script>', now);
    expect(data).not.toContain('</script>');
    expect(JSON.parse(data)).toMatchObject({ cluster:false, series:[{ label:'</script>', status:'ready' }] });
    expect(JSON.parse(data).series[0].history).toEqual([sample(now).point]);
    const worker = JSON.parse(graphData({ clusterMetricsUnavailable:true, startTime:now - 10000,
      intervalMs:1000, history:[sample(now).point] }, 'Worker tx1', now));
    expect(worker.series[0].status).toBe('ready'); // local samples remain usable without IPC
  });
});

describe('child metrics IPC', () => {
  test('bounds pending sends, handles errors/disconnect, and removes listeners on shutdown', () => {
    const channel = new EventEmitter();
    channel.connected = true;
    const pending = [];
    channel.send = jest.fn((message, callback) => { pending.push(callback); return false; });
    const stats = { startTime:now - 10000, intervalMs:1000 };
    const close = connectMetrics(stats, channel);
    stats.onMetric(sample(now).point);
    stats.onMetric(sample(now + 1000).point);
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0][0]).toMatchObject({ type:METRIC, startedAt:stats.startTime, point:sample(now).point });
    pending.shift()(new Error('channel closed'));
    channel.send.mockImplementationOnce(() => { throw new Error('channel closed'); });
    expect(() => stats.onMetric(sample(now + 2000).point)).not.toThrow();
    channel.connected = false;
    channel.emit('disconnect');
    expect(stats.clusterMetricsUnavailable).toBe(true);
    stats.onMetric(sample(now + 3000).point);
    expect(channel.send).toHaveBeenCalledTimes(2);
    channel.emit('message', { type:SNAPSHOT, sampledAt:now, series:[] });
    expect(stats.clusterMetricsUnavailable).toBe(false);
    expect(stats.clusterMetrics).toEqual({ cluster:true, sampledAt:now, series:[] });
    close();
    expect(stats.onMetric).toBeNull();
    expect(channel.listenerCount('message')).toBe(0);
    expect(channel.listenerCount('disconnect')).toBe(0);
  });

  test('manual roles without IPC keep their local statistics', () => {
    const stats = {};
    expect(() => connectMetrics(stats, new EventEmitter())()).not.toThrow();
    expect(stats.onMetric).toBeUndefined();
  });
});
