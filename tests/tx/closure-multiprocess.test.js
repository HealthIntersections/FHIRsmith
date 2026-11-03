/**
 * $closure tables used by two processes at once, as cluster-mode workers use them. Each
 * call reads the table, yields, and writes the next version; the per-table lock has to
 * hold across processes, or one process's write is lost under the other's.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const CHILD = path.join(__dirname, '..', 'utils', 'closure-child.js');

describe('closure tables across processes', () => {
  let dir;
  const children = [];

  const spawn = (crossProcess) => {
    const child = fork(CHILD, [dir, crossProcess ? '1' : '0'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    children.push(child);
    let seq = 0;
    const waiting = new Map();
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    child.on('message', (m) => {
      if (m.ready) {
        readyResolve();
        return;
      }
      const w = waiting.get(m.seq);
      if (m.error) {
        w.reject(new Error(m.error));
      } else {
        w.resolve(m.result);
      }
    });
    const call = (op, args = {}) => new Promise((resolve, reject) => {
      const s = ++seq;
      waiting.set(s, { resolve, reject });
      child.send({ seq: s, op, ...args });
    });
    return ready.then(() => ({ call }));
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-mp-'));
  });
  afterEach(async () => {
    for (const c of children.splice(0)) {
      if (c.exitCode === null && c.signalCode === null) {
        await new Promise(resolve => {
          c.once('exit', resolve);
          c.kill();
        });
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('with the cross-process lock, no add is lost', async () => {
    const [a, b] = await Promise.all([spawn(true), spawn(true)]);
    await a.call('create', { name: 't1' });
    await Promise.all([a.call('adds', { name: 't1', times: 10, ms: 10 }), b.call('adds', { name: 't1', times: 10, ms: 10 })]);
    expect(await a.call('version', { name: 't1' })).toEqual({ version: 20, concepts: 20 });
  });

  test('without it (one process per database, as before), adds from two processes are lost', async () => {
    const [a, b] = await Promise.all([spawn(false), spawn(false)]);
    await a.call('create', { name: 't1' });
    // two processes both read version n, and both write n + 1: the second write fails on the
    // unique (table, version)... or overwrites; either way the version count falls short
    const results = await Promise.allSettled([a.call('adds', { name: 't1', times: 10, ms: 10 }), b.call('adds', { name: 't1', times: 10, ms: 10 })]);
    const v = await a.call('version', { name: 't1' });
    expect(results.some(r => r.status === 'rejected') || v.version < 20).toBe(true);
  });

  test('the table limit holds when two processes create tables at once', async () => {
    const [a, b] = await Promise.all([spawn(true), spawn(true)]);
    const made = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).call('create', { name: `t${i}`, max: 5 })));
    expect(made.filter(Boolean)).toHaveLength(5);
  });
});
