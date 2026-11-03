/**
 * The primary's side of the group memory guard (library/cluster-memory.js): it measures the
 * service, tells the workers, and recycles the largest worker when the service stays over
 * the reject threshold - one at a time, never while one is starting, backing off.
 */
const EventEmitter = require('events');
const { ClusterMemory } = require('../../library/cluster-memory');

const GB = 1024 * 1024 * 1024;

function fakeWorker(pid) {
  const w = new EventEmitter();
  w.process = { pid, kill: jest.fn() };
  w.sent = [];
  w.send = (m) => w.sent.push(m);
  w.isConnected = () => true;
  w.isDead = () => false;
  w.report = (rss) => w.emit('message', { fhirsmith: 'memory-rss', rss });
  return w;
}

describe('ClusterMemory', () => {
  let now;
  let logs;
  let cm;
  const make = (memory = {}) => {
    cm = new ClusterMemory({
      memory: { limit: 10 * GB, measure: 'processes', recycleAfterSeconds: 60, drainSeconds: 30, ...memory },
      log: (m) => logs.push(m), now: () => now, ownRss: () => 0.1 * GB
    });
    return cm;
  };
  const workers = (...rss) => rss.map((r, i) => {
    const w = fakeWorker(1000 + i);
    cm.add(w);
    cm.listening(w);
    w.report(r * GB);
    return w;
  });
  const drained = (ws) => ws.filter(w => w.sent.some(m => m.fhirsmith === 'drain'));

  beforeEach(() => {
    now = 1000000;
    logs = [];
  });
  afterEach(() => {
    for (const e of cm.workers.values()) {
      clearTimeout(e.killTimer);
    }
  });

  test('tells every worker each one\'s RSS and the total', () => {
    make();
    const ws = workers(1, 2, 3);
    cm.tick();
    const msg = ws[0].sent.find(m => m.fhirsmith === 'memory');
    expect(msg.total).toBeCloseTo(6.1 * GB);
    expect(msg.workers).toEqual([[1000, 1 * GB], [1001, 2 * GB], [1002, 3 * GB]]);
    expect(ws[2].sent.find(m => m.fhirsmith === 'memory')).toEqual(msg);
  });

  test('over the reject threshold for recycleAfterSeconds: the largest worker is drained', () => {
    make();
    const ws = workers(2, 5, 2); // 9.1 GB > 8.5
    cm.tick();
    expect(drained(ws)).toHaveLength(0);
    now += 59 * 1000;
    cm.tick();
    expect(drained(ws)).toHaveLength(0);
    now += 1000;
    cm.tick();
    expect(drained(ws)).toEqual([ws[1]]);
    expect(ws[1].sent.find(m => m.fhirsmith === 'drain')).toEqual({ fhirsmith: 'drain', deadlineMs: 30000 });
    expect(ws[1].recycled).toBe(true);
    expect(logs.some(l => /recycling the largest worker, pid 1001/.test(l))).toBe(true);
  });

  test('back under before the time: nothing is recycled', () => {
    make();
    const ws = workers(2, 5, 2);
    cm.tick();
    now += 30 * 1000;
    ws[1].report(3 * GB);
    cm.tick();
    now += 60 * 1000;
    cm.tick();
    expect(drained(ws)).toHaveLength(0);
  });

  test('one at a time, not while a worker is starting, and each further one waits twice as long', () => {
    make();
    const ws = workers(2, 5, 2);
    cm.tick();
    now += 60 * 1000;
    cm.tick();
    expect(drained(ws)).toEqual([ws[1]]);
    // still draining: nothing else
    now += 60 * 1000;
    cm.tick();
    expect(drained(ws)).toHaveLength(1);
    // it exits and its replacement starts; still over (the others grew)
    cm.remove(ws[1]);
    const fresh = fakeWorker(2000);
    cm.add(fresh);
    fresh.report(1 * GB);
    ws[0].report(4 * GB);
    ws[2].report(4 * GB);
    now += 120 * 1000;
    cm.tick();
    expect(drained([...ws, fresh])).toHaveLength(1); // the new one isn't listening yet
    cm.listening(fresh);
    cm.tick(); // the wait is now 120 s from the last recycle, which was > 120 s ago
    expect(drained([...ws, fresh])).toHaveLength(2);
    // the third would wait 240 s
    cm.remove(ws[0]);
    const fresh2 = fakeWorker(2001);
    cm.add(fresh2);
    cm.listening(fresh2);
    fresh2.report(1 * GB);
    ws[2].report(8 * GB);
    now += 200 * 1000;
    cm.tick();
    expect(drained([ws[2]])).toHaveLength(0);
    now += 40 * 1000;
    cm.tick();
    expect(drained([ws[2]])).toHaveLength(1);
  });

  test('a drained worker that does not exit is killed after its deadline', () => {
    jest.useFakeTimers();
    try {
      make({ drainSeconds: 2 });
      const ws = workers(2, 5, 2);
      cm.tick();
      now += 60 * 1000;
      cm.tick();
      jest.advanceTimersByTime(11 * 1000);
      expect(ws[1].process.kill).not.toHaveBeenCalled();
      jest.advanceTimersByTime(2 * 1000);
      expect(ws[1].process.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      jest.useRealTimers();
    }
  });

  test('recycleAfterSeconds 0 turns recycling off', () => {
    make({ recycleAfterSeconds: 0 });
    const ws = workers(2, 5, 2);
    cm.tick();
    now += 3600 * 1000;
    cm.tick();
    expect(drained(ws)).toHaveLength(0);
  });
});
