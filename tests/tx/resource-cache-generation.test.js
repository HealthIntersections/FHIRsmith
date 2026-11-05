const fs = require('fs');
const os = require('os');
const path = require('path');
const { SqliteResourceCache } = require('../../tx/resource-cache-sqlite');
const { CodeSystem } = require('../../tx/library/codesystem');
const { newCacheGeneration } = require('../../library/cache-generation');

describe('shared client cache lifecycle', () => {
  let dir;
  let opened;
  const resource = () => new CodeSystem({ resourceType:'CodeSystem', url:'http://example.org/lifecycle',
    status:'active', content:'complete', concept:[{ code:'a', display:'A' }] }, 'R4');
  const open = (generation, scope = '/r4') => {
    const cache = new SqliteResourceCache(null, { path:path.join(dir, 'cache.db'), scope, generation });
    cache.setInstanceCode('abcdefghijklmnop');
    opened.push(cache);
    return cache;
  };
  const start = cache => {
    const id = cache.newCacheId();
    cache.set(id, [resource()]);
    return id;
  };
  function expectGone(fn) {
    let error;
    try { fn(); } catch (e) { error = e; }
    expect(error).toMatchObject({ statusCode:404, issueCode:'cache-id-unknown' });
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-generation-'));
    opened = [];
  });
  afterEach(() => {
    for (const cache of opened) cache.close();
    fs.rmSync(dir, { recursive:true, force:true });
  });

  test('child restarts join the same generation; a full restart invalidates every endpoint', () => {
    const generation = newCacheGeneration();
    const master = open(generation);
    const worker = open(null);
    const r5 = open(generation, '/r5');
    const id = start(worker);
    const id5 = start(r5);
    expect(master.has(id)).toBe(true);
    worker.close();
    expect(open(null).has(id)).toBe(true);
    // The launcher gives a replacement master the same boot token.
    expect(open(generation).has(id)).toBe(true);
    const freshMaster = open(newCacheGeneration());
    expect(freshMaster.has(id)).toBe(false);
    expect(r5.has(id5)).toBe(false);
    expect(freshMaster.size()).toBe(0);
  });

  test('a surviving manual worker joins the new master generation for fresh sessions', () => {
    open(newCacheGeneration());
    const worker = open(null);
    const old = start(worker);
    const master = open(newCacheGeneration());
    expect(worker.has(old)).toBe(false);
    const fresh = start(worker);
    expect(master.has(fresh)).toBe(true);
    expect(master.get(fresh)[0].jsonObj.concept[0].code).toBe('a');
    expect(worker.instanceCode).toHaveLength(16);
    expect(fresh).toMatch(/^abcdefghijklmnop\.[A-Za-z0-9.-]+$/);
    expect(fresh.length).toBeLessThanOrEqual(64);
    expect(fresh).not.toBe(old);
  });

  test.each(['add', 'set'])('a request that passed has() cannot %s its old ID after rotation', method => {
    open(newCacheGeneration());
    const worker = open(null);
    const id = start(worker);
    expect(worker.has(id)).toBe(true);
    open(newCacheGeneration());
    expectGone(() => worker[method](id, [resource()]));
    expect(worker.has(id)).toBe(false);
    expect(worker.size()).toBe(0);
  });

  test.each(['add', 'set'])('%s checks again inside the write transaction after request preparation', method => {
    open(newCacheGeneration());
    const worker = open(null);
    const id = start(worker);
    const write = worker._write.bind(worker);
    worker._write = (what, fn) => {
      open(newCacheGeneration()); // another master commits before the old request gets its write lock
      return write(what, fn);
    };
    const changed = resource();
    changed.jsonObj.concept.push({ code:'b' });
    expectGone(() => worker[method](id, [changed]));
    expect(worker.size()).toBe(0);
  });

  test('a stale index and a request that passed has() cannot load old content', () => {
    open(newCacheGeneration());
    const worker = open(null);
    const id = start(worker);
    const [lazy] = worker.get(id);
    expect(lazy.url).toBe('http://example.org/lifecycle');
    expect(worker.has(id)).toBe(true);
    open(newCacheGeneration());
    expectGone(() => worker.get(id));
    expectGone(() => lazy.jsonObj);
  });

  test('an ID minted before rotation cannot create a session afterward', () => {
    const master = open(newCacheGeneration());
    const id = master.newCacheId();
    open(newCacheGeneration());
    expectGone(() => master.set(id, []));
    expect(master.size()).toBe(0);
  });

  test('workers require the master to initialize the lifecycle', () => {
    expect(() => open(null)).toThrow(/master/i);
  });
});
