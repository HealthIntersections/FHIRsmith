/**
 * The shared SQLite resource cache across processes: what cluster mode relies on.
 * Two real processes open the same file; a cache started in one is used and ended
 * in the other, and survives a process restart.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const CHILD = path.join(__dirname, '..', 'utils', 'resource-cache-child.js');

function startProcess(file) {
  const child = fork(CHILD, [file], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let seq = 0;
  const waiting = new Map();
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  child.on('message', (m) => {
    if (m.ready) {
      readyResolve(m.ready);
      return;
    }
    const w = waiting.get(m.seq);
    waiting.delete(m.seq);
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
  const stop = () => new Promise(resolve => {
    child.once('exit', resolve);
    child.kill();
  });
  return { ready, call, stop, pid: child.pid };
}

const cs = (url, version, codes) => ({
  resourceType: 'CodeSystem', url, version, status: 'active', content: 'complete',
  concept: codes.map(code => ({ code, display: code.toUpperCase() }))
});

describe('shared SQLite resource cache across processes', () => {
  let dir;
  let file;
  const running = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-cache-mp-'));
    file = path.join(dir, 'resource-cache.db');
  });

  afterEach(async () => {
    while (running.length) {
      await running.pop().stop();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const spawn = async () => {
    const p = startProcess(file);
    running.push(p);
    await p.ready;
    return p;
  };

  test('A starts a cache and adds resources, B reads them, B ends it, A sees the tombstone', async () => {
    const a = await spawn();
    const b = await spawn();
    expect(a.pid).not.toBe(b.pid);

    const id = await a.call('start', { resources: [cs('http://example.org/one', '1', ['a', 'b'])] });
    await a.call('add', { id, resources: [cs('http://example.org/two', '2', ['x', 'y', 'z'])] });

    expect(await b.call('has', { id })).toBe(true);
    expect(await b.call('get', { id })).toEqual([
      { cls: 'CodeSystem', url: 'http://example.org/one', version: '1', fhirVersion: 'R4', concepts: 2 },
      { cls: 'CodeSystem', url: 'http://example.org/two', version: '2', fhirVersion: 'R4', concepts: 3 }
    ]);

    // B adds too, and A sees it
    await b.call('add', { id, resources: [cs('http://example.org/three', '3', ['q'])] });
    expect((await a.call('get', { id })).map(r => r.url)).toEqual(
      ['http://example.org/one', 'http://example.org/two', 'http://example.org/three']);

    await b.call('end', { id });
    expect(await a.call('has', { id })).toBe(false);
    expect(await a.call('get', { id })).toEqual([]);
    const d = await a.call('describe', { id });
    expect(d.messageId).toBe('CACHE_ID_CLOSED');
    expect(d.params[0]).toBe(id);
  });

  test('the idle sweep run by either process is seen by both, and running it twice is harmless', async () => {
    const a = await spawn();
    const b = await spawn();
    const id = await a.call('start', { resources: [cs('http://example.org/one', '1', ['a'])] });
    // prune with a negative max age: everything counts as idle
    await b.call('prune', { maxAge: -1000 });
    await a.call('prune', { maxAge: -1000 });
    expect(await a.call('has', { id })).toBe(false);
    expect((await a.call('describe', { id })).messageId).toBe('CACHE_ID_EXPIRED');
    expect((await b.call('describe', { id })).messageId).toBe('CACHE_ID_EXPIRED');
  });

  test('a cache survives a process restart', async () => {
    const a = await spawn();
    const id = await a.call('start', { resources: [cs('http://example.org/one', '1', ['a', 'b'])], sealed: true });
    await running.pop().stop();

    const again = await spawn();
    expect(await again.call('has', { id })).toBe(true);
    expect((await again.call('get', { id })).map(r => r.url)).toEqual(['http://example.org/one']);
  });

  test('many writes from two processes at once all land', async () => {
    const a = await spawn();
    const b = await spawn();
    const id = await a.call('start', {});
    const writes = [];
    for (let i = 0; i < 50; i++) {
      writes.push(a.call('add', { id, resources: [cs(`http://example.org/a${i}`, '1', ['c'])] }));
      writes.push(b.call('add', { id, resources: [cs(`http://example.org/b${i}`, '1', ['c'])] }));
    }
    await Promise.all(writes);
    expect(await a.call('get', { id })).toHaveLength(100);
  });
});
