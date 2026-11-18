/**
 * library/cluster-counts.js: a tx-worker's request counts reach the master's statistics over
 * the launcher's IPC channels, each request once. The channels here are stand-ins for the
 * child's `process` and the launcher's child handle; tests/server/cluster-integration.test.js
 * runs the real thing.
 */
const { EventEmitter } = require('events');
const ServerStats = require('../../stats');
const { connectCounts, PendingCounts, COUNTS } = require('../../library/cluster-counts');

// a child's end of the IPC channel: what it sends goes to `onSend`
function channel(onSend) {
  const c = new EventEmitter();
  c.connected = true;
  c.send = jest.fn((message, callback) => {
    const error = onSend(message);
    setImmediate(() => callback(error || null));
    return true;
  });
  return c;
}

describe('worker request counts reach the master', () => {
  const log = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  let running;
  const newStats = (config = { enabled: false }) => {
    const stats = new ServerStats(config, log);
    running.push(stats);
    return stats;
  };
  beforeEach(() => { running = []; });
  afterEach(() => {
    for (const stats of running) stats.finishStats();
  });

  test('through the launcher, summed, to the master; nothing counted twice', async () => {
    const master = newStats();
    const masterChannel = channel(() => null);
    const toMaster = connectCounts(master, masterChannel, { role: 'master' });
    const pending = new PendingCounts();
    // the launcher: what workers send is pending until delivered to the master
    const relay = (message) => {
      expect(message.type).toBe(COUNTS);
      pending.add(message.rows);
      masterChannel.emit('message', { type: COUNTS, rows: pending.take() });
    };
    const workers = [newStats(), newStats()];
    const links = workers.map(w => connectCounts(w, channel(relay), { role: 'tx-worker', intervalMs: 3600000 }));

    workers[0].forModule('tx').countRequest('$expand', 10, '/r4');
    workers[0].forModule('tx').countRequest('$expand', 20, '/r4');
    workers[1].forModule('tx').countRequest('$expand', 5, '/r4');
    workers[1].forModule('tx').countRequest('$lookup', 1, '/r4');
    master.forModule('tx').countRequest('$expand', 1, '/r4');

    await Promise.all(links.map(l => l.flush()));
    // flushing again sends nothing more
    await Promise.all(links.map(l => l.flush()));
    expect(master.forModule('tx').countsSince(0, Date.now())).toMatchObject({
      total: 5, operations: { '$expand': 4, '$lookup': 1 }
    });
    for (const l of [...links, toMaster]) l();
  });

  test('a lot that cannot be sent is kept, and goes with the next', async () => {
    const worker = newStats();
    let fail = true;
    const received = [];
    const link = connectCounts(worker, channel(message => {
      if (fail) return new Error('channel closed');
      received.push(...message.rows);
      return null;
    }), { role: 'tx-worker', intervalMs: 3600000 });
    worker.forModule('tx').countRequest('$expand', 10, '/r4');
    await link.flush();
    expect(received).toEqual([]);
    fail = false;
    worker.forModule('tx').countRequest('$expand', 10, '/r4');
    await link.flush();
    expect(received).toEqual([{ module: 'tx', endpoint: '/r4', operation: '$expand', count: 2, time: 20 }]);
    link();
  });

  test('a worker sends on its interval; a master ignores counts unless it is the master', async () => {
    jest.useFakeTimers();
    try {
      const worker = newStats();
      const sent = [];
      const link = connectCounts(worker, channel(message => { sent.push(message); }), { role: 'tx-worker', intervalMs: 1000 });
      worker.forModule('tx').countRequest('$expand', 3, '/r4');
      jest.advanceTimersByTime(1000);
      expect(sent).toHaveLength(1);
      link();

      const notMaster = newStats();
      const c = channel(() => null);
      const off = connectCounts(notMaster, c, { role: 'tx-worker' });
      c.emit('message', { type: COUNTS, rows: [{ module: 'tx', endpoint: '/r4', operation: '$expand', count: 9, time: 1 }] });
      expect(notMaster.forModule('tx').countsSince(0, Date.now()).total).toBe(0);
      off();
    } finally {
      jest.useRealTimers();
    }
  });

  test('without the launcher (no IPC channel) nothing is attached', async () => {
    const stats = newStats();
    const link = connectCounts(stats, {}, { role: 'tx-worker' });
    stats.forModule('tx').countRequest('$expand', 3, '/r4');
    await link.flush();
    link();
    expect(stats.forModule('tx').countsSince(0, Date.now()).total).toBe(1);
  });
});
