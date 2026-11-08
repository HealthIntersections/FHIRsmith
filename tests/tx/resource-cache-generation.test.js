/**
 * The shared store's lifecycle (tx/resource-cache-sqlite.js, cluster.md "Options"): caches
 * are not carried over a server restart. Each time the master starts it begins a new
 * generation and every live cache, in every endpoint, becomes a "lost to a server restart"
 * tombstone; a tx-worker joins the current generation, so one restarting while the master
 * carries on keeps every cache.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SqliteResourceCache } = require('../../tx/resource-cache-sqlite');
const { CodeSystem } = require('../../tx/library/codesystem');
const { newCacheGeneration, TOKEN } = require('../../library/cache-generation');

describe('shared client cache lifecycle', () => {
  let dir;
  let opened;
  const resource = () => new CodeSystem({ resourceType:'CodeSystem', url:'http://example.org/lifecycle',
    status:'active', content:'complete', concept:[{ code:'a', display:'A' }] }, 'R4');
  const open = (generation, scope = '/r4', options = {}) => {
    const cache = new SqliteResourceCache(null, { path:path.join(dir, 'cache.db'), scope, generation, ...options });
    cache.setInstanceCode('abcdefghijklmnop');
    opened.push(cache);
    return cache;
  };
  const start = cache => cache.start([resource()]);
  function expectGone(fn, msgId = 'CACHE_ID_LOST_TO_RESTART') {
    let error;
    try { fn(); } catch (e) { error = e; }
    expect(error).toMatchObject({ statusCode:404, issueCode:'cache-id-unknown', msgId });
    if (msgId === 'CACHE_ID_LOST_TO_RESTART') {
      // Messages.properties' text
      expect(error.message).toMatch(/^The cache '.+' was lost to a server restart (\d+ seconds?|an unknown time) ago\. Caches are not carried over a restart/);
    }
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-generation-'));
    opened = [];
  });
  afterEach(() => {
    for (const cache of opened) cache.close();
    fs.rmSync(dir, { recursive:true, force:true });
  });

  test('a worker restart keeps every cache; a master start makes them all "lost to a server restart"', () => {
    const generation = newCacheGeneration();
    const master = open(generation);
    const r5 = open(generation, '/r5'); // the same master's other endpoint: nothing is lost
    const worker = open(null);
    const id = start(worker);
    const id5 = start(r5);
    expect(master.has(id)).toBe(true);
    expect(master.lostToRestart).toBe(0);

    worker.close();
    const restartedWorker = open(null);
    expect(restartedWorker.has(id)).toBe(true);
    expect(restartedWorker.get(id)[0].jsonObj.concept[0].code).toBe('a');

    // the master starts again (under the launcher or by hand): a new generation
    const newMaster = open(newCacheGeneration());
    expect(newMaster.lostToRestart).toBe(2);
    const newR5 = open(null, '/r5');
    expect(newMaster.has(id)).toBe(false);
    expect(newR5.has(id5)).toBe(false);
    expect(newMaster.size()).toBe(0);
    expect(newMaster.tombstone(id)).toMatchObject({ reason:'restart' });
    expect(newMaster.describeMissing(id).messageId).toBe('CACHE_ID_LOST_TO_RESTART');
    expect(newR5.describeMissing(id5).messageId).toBe('CACHE_ID_LOST_TO_RESTART');
    expect(restartedWorker.describeMissing(id).messageId).toBe('CACHE_ID_LOST_TO_RESTART');
  });

  test('an id from an earlier generation is lost to a restart even once its tombstone is gone', () => {
    open(newCacheGeneration(), '/r4', { maxTombstones:1 });
    const worker = open(null, '/r4', { maxTombstones:1 });
    const first = start(worker);
    const second = start(worker);
    const master = open(newCacheGeneration(), '/r4', { maxTombstones:1 });
    // only one tombstone is kept, but the generation is remembered
    expect(master.tombstoneCount()).toBe(1);
    for (const id of [first, second]) {
      expect(master.describeMissing(id).messageId).toBe('CACHE_ID_LOST_TO_RESTART');
    }
  });

  test('an id never issued is reported as never issued, not as lost to a restart', () => {
    const master = open(newCacheGeneration());
    const worker = open(null);
    const current = master.q.generation.get().value;
    const invented = [
      `abcdefghijklmnop.${current}.${newCacheGeneration()}`, // this generation, never issued
      `abcdefghijklmnop.${newCacheGeneration()}.${newCacheGeneration()}`, // no such generation
      'tx1.00000000-0000-4000-8000-000000000000',
      'nonsense'
    ];
    for (const id of invented) {
      expect(worker.describeMissing(id).messageId).toBe('CACHE_ID_UNKNOWN_SHARED');
    }
  });

  test('a surviving worker issues fresh caches in the new master\'s generation', () => {
    open(newCacheGeneration());
    const worker = open(null);
    const old = start(worker);
    const master = open(newCacheGeneration());
    expect(worker.has(old)).toBe(false);
    const fresh = start(worker);
    expect(master.has(fresh)).toBe(true);
    expect(master.get(fresh)[0].jsonObj.concept[0].code).toBe('a');
    expect(worker.instanceCode).toHaveLength(16);
    const parts = fresh.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('abcdefghijklmnop');
    expect(parts[1]).toBe(master.q.generation.get().value);
    expect(fresh).toHaveLength(62);
    expect(fresh).not.toBe(old);
  });

  test('generation tokens are 22 id characters with no \'.\' anywhere', () => {
    for (let i = 0; i < 2000; i++) {
      const token = newCacheGeneration();
      expect(token).toMatch(TOKEN);
      expect(token).not.toContain('.');
    }
    expect(() => open('has.a.dot.in.it.1234567')).toThrow(/generation/);
  });

  test.each(['add', 'set'])('a request that passed has() cannot %s its old ID after the master restarts', method => {
    open(newCacheGeneration());
    const worker = open(null);
    const id = start(worker);
    expect(worker.has(id)).toBe(true);
    open(newCacheGeneration());
    expectGone(() => worker[method](id, [resource()]));
    expect(worker.has(id)).toBe(false);
    expect(worker.size()).toBe(0);
  });

  test.each(['add', 'set'])('%s checks again inside the write transaction', method => {
    open(newCacheGeneration());
    const worker = open(null);
    const id = start(worker);
    const write = worker._write.bind(worker);
    worker._write = (what, fn) => {
      open(newCacheGeneration()); // the master starts before the old request gets its write lock
      return write(what, fn);
    };
    const changed = resource();
    changed.jsonObj.concept.push({ code:'b' });
    expectGone(() => worker[method](id, [changed]));
    expect(worker.size()).toBe(0);
  });

  test('$cache-control?mode=start never answers with an id the master\'s start has already retired', () => {
    open(newCacheGeneration());
    const worker = open(null);
    const write = worker._write.bind(worker);
    let master = null;
    worker._write = (what, fn) => {
      // the master starts after the request was prepared, before it gets its write lock
      master = master || open(newCacheGeneration());
      return write(what, fn);
    };
    const id = start(worker);
    expect(id.split('.')[1]).toBe(master.q.generation.get().value);
    expect(worker.has(id)).toBe(true);
    expect(master.get(id)).toHaveLength(1);
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

  test('an ID minted before the master restarted cannot create a cache afterwards', () => {
    const master = open(newCacheGeneration());
    const id = master.newCacheId();
    open(newCacheGeneration());
    expectGone(() => master.set(id, []));
    expect(master.size()).toBe(0);
  });

  test('workers require the master to start the lifecycle', () => {
    expect(() => open(null)).toThrow(/master/i);
  });
});
