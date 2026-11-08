/**
 * library/cluster-events.js: what the launcher saw reaches the master's statistics database,
 * and the daily report's cluster paragraph. tests/server/cluster-launcher.test.js has the
 * launcher's side with real processes.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const ServerStats = require('../../stats');
const DailyReport = require('../../library/daily-report');
const { PendingClusterEvents, connectClusterEvents, validRow, CLUSTER_EVENTS, KINDS } = require('../../library/cluster-events');

const HOUR = 60 * 60 * 1000;

describe('the launcher\'s pending events', () => {
  test('events one by one; what it answered itself, counted by kind and process', () => {
    let t = 1000;
    const pending = new PendingClusterEvents(() => t);
    pending.event(KINDS.exited, 'worker b', { detail: 'SIGKILL' });
    t = 2000;
    pending.count(KINDS.busy);
    pending.count(KINDS.busy);
    pending.count(KINDS.timeout, 'worker b');
    t = 3000;
    pending.count(KINDS.busy);
    expect(pending.size).toBe(3);
    expect(pending.take()).toEqual([
      { time: 1000, kind: 'exited', process: 'worker b', detail: 'SIGKILL', count: 1, ms: 0 },
      { time: 3000, kind: 'refused-busy', process: null, detail: null, count: 3, ms: 0 },
      { time: 2000, kind: 'upstream-timeout', process: 'worker b', detail: null, count: 1, ms: 0 }
    ]);
    expect(pending.size).toBe(0);
  });

  test('a lot that could not be delivered is put back, and added to what came since', () => {
    let t = 1000;
    const pending = new PendingClusterEvents(() => t);
    pending.event(KINDS.recycled, 'worker b', { detail: 'memory' });
    pending.count(KINDS.busy);
    const lot = pending.take();
    t = 2000;
    pending.event(KINDS.ready, 'worker b', { ms: 500 });
    pending.count(KINDS.busy);
    pending.add(lot);
    const rows = pending.take();
    expect(rows.map(r => r.kind)).toEqual(['recycled', 'ready', 'refused-busy']);
    expect(rows[2]).toMatchObject({ count: 2, time: 2000 });
  });

  test('the master takes only well-formed rows', () => {
    expect(validRow({ time: 1, kind: 'exited', process: 'master', detail: 'SIGKILL', count: 1 }))
      .toEqual({ time: 1, kind: 'exited', process: 'master', detail: 'SIGKILL', count: 1, ms: 0 });
    expect(validRow({ time: 1, kind: 'something', count: 1 })).toBeNull();
    expect(validRow({ time: 1, kind: 'exited', count: 0 })).toBeNull();
    expect(validRow({ time: 'x', kind: 'exited', count: 1 })).toBeNull();
    expect(validRow({ time: 1, kind: 'recycled', count: 1, detail: 'x'.repeat(2000) }).detail.length).toBe(500);
  });
});

describe('what the launcher saw, in the master\'s statistics and daily report', () => {
  let dir;
  let stats;
  const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhirsmith-cluster-events-'));
    stats = new ServerStats({ database: path.join(dir, 'stats.db') }, log);
  });
  afterEach(() => {
    stats.finishStats();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const report = (cluster, s = stats) => new DailyReport({}, {
    log, stats: s, version: '0.17.1', serverId: 'tx.test.org', cluster, modules: {},
    stateFile: path.join(dir, 'daily-report.json')
  });

  test('the master writes what the launcher sends; a worker and a plain server don\'t listen', () => {
    const channel = new EventEmitter();
    channel.send = () => true;
    const disconnect = connectClusterEvents(stats, channel, { role: 'master' });
    channel.emit('message', { type: CLUSTER_EVENTS, rows: [
      { time: 1000, kind: 'exited', process: 'worker b', detail: 'SIGKILL', count: 1, ms: 0 },
      { time: 1000, kind: 'nonsense', count: 1 }
    ] });
    expect(stats.clusterEventsSince(0, 2000)).toEqual([
      { time: 1000, kind: 'exited', process: 'worker b', detail: 'SIGKILL', count: 1, ms: 0 }
    ]);
    expect(stats.clusterEventsSince(1000, 2000)).toEqual([]);
    disconnect();
    expect(channel.listenerCount('message')).toBe(0);
    expect(connectClusterEvents(stats, channel, { role: 'tx-worker' })).toBeInstanceOf(Function);
    expect(channel.listenerCount('message')).toBe(0);
    expect(connectClusterEvents(stats, {}, { role: 'master' })).toBeInstanceOf(Function);
  });

  test('the cluster paragraph: launcher starts, each process, and the launcher\'s own answers', async () => {
    const now = Date.now();
    const since = now - 24 * HOUR;
    const at = since + HOUR;
    stats.recordClusterEvents([
      { time: since - HOUR, kind: 'exited', process: 'worker c', detail: '1', count: 1 },
      { time: at, kind: 'launcher-started', process: null, count: 1 },
      { time: at + 1, kind: 'exited', process: 'worker b', detail: 'SIGKILL', count: 1 },
      { time: at + 2, kind: 'ready', process: 'worker b', count: 1, ms: 3 * 60000 },
      { time: at + 3, kind: 'exited', process: 'worker b', detail: 'SIGKILL', count: 1 },
      { time: at + 4, kind: 'exited', process: 'master', detail: '1', count: 1 },
      { time: at + 5, kind: 'recycled', process: 'worker d', detail: 'its memory (4.0 GB) has been over the threshold for 30 s with no request at work', count: 1 },
      { time: at + 6, kind: 'ready', process: 'worker d', count: 1, ms: 2 * 60000 },
      { time: at + 7, kind: 'upstream-timeout', process: 'worker b', count: 4 },
      { time: at + 8, kind: 'lost-to-restart', process: 'worker b', count: 2 },
      { time: at + 9, kind: 'refused-busy', process: null, count: 10 },
      { time: at + 9, kind: 'refused-not-ready', process: null, count: 1 },
      { time: at + 9, kind: 'write-timeout', process: null, count: 3 }
    ]);
    const text = report(true).clusterParagraph(since, now);
    expect(text).toMatch(/^The launcher started once \(\d{4}-\d\d-\d\d \d\d:\d\d\)\. The launcher refused 11 requests itself \(503\): 10 because no process was free in time, 1 because no process was ready\. It closed 3 connections whose client took none of a response in time \(writeTimeoutSeconds\)\.\n\n/);
    const lines = text.split('\n').filter(l => l.startsWith('- '));
    expect(lines).toEqual([
      '- master: exited once (exit code 1)',
      '- worker b: exited twice (2 × SIGKILL); was unavailable for 3m in all; did not begin 4 responses in time (504); was restarting when 2 requests came for a cache-id it had issued',
      '- worker d: was recycled once (the last because its memory (4.0 GB) has been over the threshold for 30 s with no request at work); was unavailable for 2m in all'
    ]);
    // and in the report, after the stability paragraph
    stats.markStarted('0.17.1');
    const built = await report(true).build(since, now);
    expect(built.indexOf('## Cluster')).toBeGreaterThan(built.indexOf('## Stability'));
  });

  test('a quiet cluster says so; a single server has no cluster paragraph', () => {
    expect(report(true).clusterParagraph(0, Date.now())).toBe('No process exited or was recycled. The launcher refused no requests itself.');
    expect(report(false).clusterParagraph(0, Date.now())).toBeNull();
    const none = new ServerStats({ enabled: false }, log);
    try {
      expect(report(true, none).clusterParagraph(0, Date.now()))
        .toBe('No record of the launcher\'s events is available (the statistics database is not in use).');
    } finally {
      none.finishStats();
    }
  });
});
