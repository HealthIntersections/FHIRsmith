/**
 * ResourceCache unit tests
 *
 * ResourceCache backs the cache-id protocol: resources sent under a cache-id on one
 * request must be retrievable on later requests with the same cache-id, and kept
 * isolated between different cache-ids.
 *
 * Every test here runs against both stores - the in-process memory store and the
 * shared SQLite store (server.cluster.sharedCache) - because they are one interface with
 * one set of semantics. The two differ only where a shared store must: an id with no
 * record is CACHE_ID_UNKNOWN_SHARED whatever its prefix, only the shared store has a
 * size cap, and only the memory store has the concept limits (cacheMaxConcepts,
 * cacheMaxTotalConcepts).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ResourceCache, formatDuration } = require('../../tx/operation-context');
const { SqliteResourceCache } = require('../../tx/resource-cache-sqlite');

const CS = (url, version) => ({ resourceType: 'CodeSystem', url, version });
const VS = (url, version) => ({ resourceType: 'ValueSet', url, version });

// A resource that reports a concept count, like the real wrapper classes do.
const sized = (resource, n) => ({ ...resource, conceptCount: () => n });

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-cache-test-'));
let fileNo = 0;
const opened = [];
afterAll(() => {
  for (const c of opened) {
    c.close();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// How each store is made, and how a test makes an entry look idle
const STORES = [
  {
    name: 'memory',
    unknownId: 'CACHE_ID_UNKNOWN',
    misrouted: (named) => (named ? 'CACHE_ID_OTHER_INSTANCE' : 'CACHE_ID_OTHER_INSTANCE_UNNAMED'),
    make: (opts = {}) => new ResourceCache(null, opts.maxTombstones || 1000),
    setLastUsed: (cache, id, when) => { cache.cache.get(id).lastUsed = when; }
  },
  {
    name: 'sqlite',
    // caches survive a restart here, so the message doesn't offer one as the reason
    unknownId: 'CACHE_ID_UNKNOWN_SHARED',
    // every process sees every cache, so a prefix naming another process says nothing
    misrouted: () => 'CACHE_ID_UNKNOWN_SHARED',
    make: (opts = {}) => {
      const c = new SqliteResourceCache(null, {
        path: path.join(tmpDir, `cache-${++fileNo}.db`),
        scope: '/r4',
        touchIntervalMs: 0,
        ...opts
      });
      opened.push(c);
      return c;
    },
    setLastUsed: (cache, id, when) => {
      cache.db.prepare('UPDATE sessions SET last_used = ? WHERE scope = ? AND cache_id = ?').run(when, cache.scope, id);
    }
  }
];

describe.each(STORES)('ResourceCache ($name store)', (store) => {
  let cache;
  const setLastUsed = (id, when) => store.setLastUsed(cache, id, when);

  beforeEach(() => {
    cache = store.make();
  });

  describe('get / has on empty cache', () => {
    test('get returns empty array for unknown cache-id', () => {
      expect(cache.get('nope')).toEqual([]);
    });
    test('has is false for unknown cache-id', () => {
      expect(cache.has('nope')).toBe(false);
    });
  });

  describe('add', () => {
    test('stores resources under a cache-id and reports has()', () => {
      cache.add('c1', [CS('http://cs', '1.0.0')]);
      expect(cache.has('c1')).toBe(true);
      expect(cache.get('c1')).toHaveLength(1);
    });

    test('merges across multiple add() calls under the same cache-id', () => {
      cache.add('c1', [CS('http://cs', '1.0.0')]);
      cache.add('c1', [VS('http://vs', '1.0.0')]);
      const got = cache.get('c1');
      expect(got).toHaveLength(2);
      expect(got.map(r => r.resourceType).sort()).toEqual(['CodeSystem', 'ValueSet']);
    });

    test('replaces an existing resource with the same url+version+type', () => {
      cache.add('c1', [CS('http://cs', '1.0.0')]);
      const updated = { ...CS('http://cs', '1.0.0'), title: 'updated' };
      cache.add('c1', [updated]);
      const got = cache.get('c1');
      expect(got).toHaveLength(1);
      expect(got[0].title).toBe('updated');
    });

    test('keeps resources with the same url but different versions as distinct', () => {
      cache.add('c1', [CS('http://cs', '1.0.0')]);
      cache.add('c1', [CS('http://cs', '2.0.0')]);
      expect(cache.get('c1')).toHaveLength(2);
    });

    test('treats a CodeSystem and ValueSet at the same url as distinct', () => {
      cache.add('c1', [CS('http://same', '1.0.0')]);
      cache.add('c1', [VS('http://same', '1.0.0')]);
      expect(cache.get('c1')).toHaveLength(2);
    });

    test('ignores empty / null resource lists', () => {
      cache.add('c1', []);
      cache.add('c1', null);
      expect(cache.has('c1')).toBe(false);
    });
  });

  describe('isolation between cache-ids', () => {
    test('resources under one cache-id are not visible under another', () => {
      cache.add('c1', [CS('http://cs', '1.0.0')]);
      expect(cache.get('c2')).toEqual([]);
      expect(cache.has('c2')).toBe(false);
    });

    test('two cache-ids hold independent contents', () => {
      cache.add('c1', [CS('http://a', '1')]);
      cache.add('c2', [CS('http://b', '1')]);
      expect(cache.get('c1').map(r => r.url)).toEqual(['http://a']);
      expect(cache.get('c2').map(r => r.url)).toEqual(['http://b']);
    });
  });

  describe('get returns a copy', () => {
    test('mutating the returned array does not affect the cache', () => {
      cache.add('c1', [CS('http://cs', '1.0.0')]);
      const got = cache.get('c1');
      got.push(VS('http://injected', '1'));
      expect(cache.get('c1')).toHaveLength(1);
    });
  });

  describe('set (replace all)', () => {
    test('replaces the entire contents for a cache-id', () => {
      cache.add('c1', [CS('http://cs', '1.0.0'), VS('http://vs', '1.0.0')]);
      cache.set('c1', [CS('http://only', '1.0.0')]);
      const got = cache.get('c1');
      expect(got).toHaveLength(1);
      expect(got[0].url).toBe('http://only');
    });
  });

  describe('clear / clearAll / size', () => {
    test('clear removes a single cache-id', () => {
      cache.add('c1', [CS('http://a', '1')]);
      cache.add('c2', [CS('http://b', '1')]);
      cache.clear('c1');
      expect(cache.has('c1')).toBe(false);
      expect(cache.has('c2')).toBe(true);
      expect(cache.size()).toBe(1);
    });

    test('clearAll empties the cache', () => {
      cache.add('c1', [CS('http://a', '1')]);
      cache.add('c2', [CS('http://b', '1')]);
      cache.clearAll();
      expect(cache.size()).toBe(0);
    });
  });

  describe('prune', () => {
    test('removes entries older than maxAge but keeps fresh ones', () => {
      cache.add('old', [CS('http://old', '1')]);
      // Force the entry to look stale.
      setLastUsed('old', Date.now() - 10000);
      cache.add('fresh', [CS('http://fresh', '1')]);

      cache.prune(5000); // maxAge 5s

      expect(cache.has('old')).toBe(false);
      expect(cache.has('fresh')).toBe(true);
    });

    test('get() refreshes lastUsed so an active entry is not pruned', () => {
      cache.add('c1', [CS('http://a', '1')]);
      setLastUsed('c1', Date.now() - 10000);
      cache.get('c1'); // touch -> refreshes lastUsed
      cache.prune(5000);
      expect(cache.has('c1')).toBe(true);
    });
  });

  // A cache-id that isn't here has three possible fates, and telling them apart is
  // the whole point: "you closed it yourself" and "it sat idle for 31 minutes" send
  // an investigator to completely different places (see issue #279).
  describe('tombstones (why a cache-id is gone)', () => {
    test('an id that was never issued has no tombstone and reports CACHE_ID_UNKNOWN (memory) or CACHE_ID_UNKNOWN_SHARED', () => {
      const d = cache.describeMissing('never-seen');
      expect(cache.tombstone('never-seen')).toBeNull();
      expect(d.messageId).toBe(store.unknownId);
      expect(d.params).toEqual(['never-seen']);
    });

    test('clear() records the client close, and describeMissing says so', () => {
      cache.set('c1', [CS('http://a', '1')]);
      cache.clear('c1');

      expect(cache.tombstone('c1').reason).toBe('closed');
      const d = cache.describeMissing('c1');
      expect(d.messageId).toBe('CACHE_ID_CLOSED');
      expect(d.params[0]).toBe('c1');
      expect(d.params).toHaveLength(3); // id, how long ago, how long it was open
    });

    test('prune() records the expiry with the measured idle time, not the timeout', () => {
      cache.add('c1', [CS('http://a', '1')]);
      setLastUsed('c1', Date.now() - 10 * 60 * 1000); // idle 10 min
      cache.prune(5 * 60 * 1000); // timeout 5 min - the sweep is late, as it is in production

      const t = cache.tombstone('c1');
      expect(t.reason).toBe('expired');
      expect(t.maxAgeMs).toBe(5 * 60 * 1000);
      expect(t.idleMs).toBeGreaterThanOrEqual(10 * 60 * 1000);

      const d = cache.describeMissing('c1');
      expect(d.messageId).toBe('CACHE_ID_EXPIRED');
      expect(d.params[1]).toBe('10 minutes');  // idle
      expect(d.params[2]).toBe('5 minutes');   // configured timeout
    });

    test('clearAll() records a server-wide clear', () => {
      cache.add('c1', [CS('http://a', '1')]);
      cache.clearAll();
      expect(cache.tombstone('c1').reason).toBe('cleared');
      expect(cache.describeMissing('c1').messageId).toBe('CACHE_ID_CLEARED');
    });

    test('an entry still in the cache has no tombstone', () => {
      cache.add('c1', [CS('http://a', '1')]);
      expect(cache.tombstone('c1')).toBeNull();
    });

    test('re-issuing an id clears its tombstone - the id is alive again', () => {
      cache.set('c1', [CS('http://a', '1')]);
      cache.clear('c1');
      expect(cache.tombstone('c1')).not.toBeNull();

      cache.set('c1', [CS('http://b', '1')]);
      expect(cache.tombstone('c1')).toBeNull();
      expect(cache.has('c1')).toBe(true);
    });

    test('the latest fate wins when an id dies twice', () => {
      cache.set('c1', [CS('http://a', '1')]);
      setLastUsed('c1', Date.now() - 10000);
      cache.prune(5000);
      expect(cache.tombstone('c1').reason).toBe('expired');

      cache.set('c1', [CS('http://a', '1')]);
      cache.clear('c1');
      expect(cache.tombstone('c1').reason).toBe('closed');
    });

    test('tombstones are bounded: the oldest are evicted, never unbounded growth', () => {
      const small = store.make({ maxTombstones: 3 });
      for (const id of ['a', 'b', 'c', 'd', 'e']) {
        small.set(id, [CS('http://' + id, '1')]);
        small.clear(id);
      }
      expect(small.tombstoneCount()).toBe(3);
      expect(small.tombstone('a')).toBeNull();      // evicted
      expect(small.tombstone('b')).toBeNull();      // evicted
      expect(small.tombstone('e')).not.toBeNull();  // newest kept
      // An evicted tombstone degrades to "never issued" rather than lying.
      expect(small.describeMissing('a').messageId).toBe(store.unknownId);
    });

    test('closing an id the server never had leaves no tombstone', () => {
      cache.clear('not-mine');
      expect(cache.tombstone('not-mine')).toBeNull();
      expect(cache.describeMissing('not-mine').messageId).toBe(store.unknownId);
    });
  });

  // With several instances behind one proxy, each prefixes its cache-ids with its
  // instance code so the proxy can route on it (see nginx.md).
  describe('instance code (cache-id prefix)', () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    test('no instance code: ids are bare UUIDs', () => {
      expect(cache.newCacheId()).toMatch(UUID);
    });

    test('with an instance code: ids are "<code>.<uuid>"', () => {
      cache.setInstanceCode('tx1');
      const id = cache.newCacheId();
      expect(id.startsWith('tx1.')).toBe(true);
      expect(id.substring(4)).toMatch(UUID);
      expect(ResourceCache.issuerOf(id)).toBe('tx1');
    });

    test('empty, null and undefined all mean no prefix', () => {
      for (const v of ['', null, undefined]) {
        cache.setInstanceCode('tx1');
        cache.setInstanceCode(v);
        expect(cache.instanceCode).toBeNull();
        expect(cache.newCacheId()).toMatch(UUID);
      }
    });

    test('codes that a proxy could not match cleanly are rejected', () => {
      for (const bad of ['tx.1', 'tx-1', 'tx 1', 'tx/1', 'a'.repeat(17), 42, {}]) {
        expect(() => cache.setInstanceCode(bad)).toThrow(/letters and digits/);
      }
    });

    test('the longest allowed code still yields a valid FHIR id (<= 64 chars)', () => {
      cache.setInstanceCode('a'.repeat(16));
      expect(cache.newCacheId()).toMatch(/^[A-Za-z0-9\-.]{1,64}$/);
    });

    test('issuerOf: bare UUIDs and other unprefixed ids have no issuer', () => {
      expect(ResourceCache.issuerOf('4f0c2d1e-0000-4000-8000-000000000000')).toBeNull();
      expect(ResourceCache.issuerOf('.leading-dot')).toBeNull();
      expect(ResourceCache.issuerOf(undefined)).toBeNull();
    });

    test('an id from another instance is reported as misrouted, naming both instances (memory store)', () => {
      cache.setInstanceCode('tx1');
      const d = cache.describeMissing('tx2.abc');
      expect(d.messageId).toBe(store.misrouted(true));
      if (store.name === 'memory') {
        expect(d.params).toEqual(['tx2.abc', 'tx2', 'tx1']);
      }
    });

    test('a server with no code reports a prefixed id as issued elsewhere (memory store)', () => {
      const d = cache.describeMissing('tx2.abc');
      expect(d.messageId).toBe(store.misrouted(false));
      if (store.name === 'memory') {
        expect(d.params).toEqual(['tx2.abc', 'tx2']);
      }
    });

    test('an unrecorded id with our own prefix is plain unknown (e.g. issued before a restart)', () => {
      cache.setInstanceCode('tx1');
      expect(cache.describeMissing('tx1.abc').messageId).toBe(store.unknownId);
    });

    test('an unprefixed id on a named server is plain unknown', () => {
      cache.setInstanceCode('tx1');
      expect(cache.describeMissing('abc').messageId).toBe(store.unknownId);
    });

    test('a tombstone wins over the prefix check', () => {
      cache.setInstanceCode('tx1');
      const id = cache.newCacheId();
      cache.set(id, []);
      cache.clear(id);
      expect(cache.describeMissing(id).messageId).toBe('CACHE_ID_CLOSED');
    });
  });

  // status()/touch() back $cache-control?mode=check: a client that hasn't needed the
  // server for a while asks whether its cache is still there, and the asking keeps it
  // there. They are separate calls on purpose - see the comments on status().
  describe('status / touch (mode=check)', () => {
    test('status reports a live cache without touching it', () => {
      cache.set('c1', [CS('http://a', '1'), VS('http://b', '1')], true);
      setLastUsed('c1', Date.now() - 90 * 1000);

      const s = cache.status('c1');
      expect(s.exists).toBe(true);
      expect(s.sealed).toBe(true);
      expect(s.resources).toBe(2);
      expect(s.idleMs).toBeGreaterThanOrEqual(90 * 1000);

      // reading must not have reset the idle clock - otherwise the answer is always 0
      expect(cache.status('c1').idleMs).toBeGreaterThanOrEqual(90 * 1000);
    });

    test('status of an unknown cache-id just says so', () => {
      expect(cache.status('nope')).toEqual({ exists: false });
    });

    test('touch resets the idle clock and saves the cache from the next prune', () => {
      cache.add('c1', [CS('http://a', '1')]);
      setLastUsed('c1', Date.now() - 10000);

      expect(cache.touch('c1')).toBe(true);
      expect(cache.status('c1').idleMs).toBeLessThan(1000);

      cache.prune(5000); // would have evicted it before the touch
      expect(cache.has('c1')).toBe(true);
    });

    test('touching an unknown cache-id reports false and creates nothing', () => {
      expect(cache.touch('nope')).toBe(false);
      expect(cache.has('nope')).toBe(false);
    });

    test('the idle timeout is reported when the server has advertised one', () => {
      cache.set('c1', [CS('http://a', '1')]);
      expect(cache.status('c1').timeoutMs).toBeNull();

      cache.setIdleTimeout(30 * 60 * 1000);
      expect(cache.status('c1').timeoutMs).toBe(30 * 60 * 1000);
    });
  });

  describe('formatDuration', () => {
    test('reads naturally across the ranges an idle timeout spans', () => {
      expect(formatDuration(0)).toBe('0 seconds');
      expect(formatDuration(1000)).toBe('1 second');
      expect(formatDuration(45000)).toBe('45 seconds');
      expect(formatDuration(31 * 60 * 1000)).toBe('31 minutes');
      expect(formatDuration(60 * 1000)).toBe('60 seconds');
      expect(formatDuration(125 * 60 * 1000)).toBe('2 hours 5 minutes');
      expect(formatDuration(120 * 60 * 1000)).toBe('2 hours');
      expect(formatDuration(null)).toBe('an unknown time');
    });
  });

  describe('running concept count', () => {
    test('starts at zero', () => {
      expect(cache.conceptCount()).toBe(0);
    });

    test('add accumulates the total and per-cache subtotal', () => {
      cache.add('c1', [sized(CS('http://a', '1'), 10), sized(VS('http://b', '1'), 3)]);
      expect(cache.conceptCount()).toBe(13);
      expect(cache.conceptCountFor('c1')).toBe(13);
    });

    test('resources with no conceptCount() count as zero', () => {
      cache.add('c1', [CS('http://a', '1')]); // plain object, no conceptCount
      expect(cache.conceptCount()).toBe(0);
    });

    test('replacing a resource adjusts by the difference', () => {
      cache.add('c1', [sized(CS('http://a', '1'), 10)]);
      expect(cache.conceptCount()).toBe(10);
      cache.add('c1', [sized(CS('http://a', '1'), 4)]); // same key, fewer concepts
      expect(cache.conceptCount()).toBe(4);
      expect(cache.conceptCountFor('c1')).toBe(4);
    });

    test('totals are kept separate per cache-id', () => {
      cache.add('c1', [sized(CS('http://a', '1'), 10)]);
      cache.add('c2', [sized(CS('http://b', '1'), 5)]);
      expect(cache.conceptCount()).toBe(15);
      expect(cache.conceptCountFor('c1')).toBe(10);
      expect(cache.conceptCountFor('c2')).toBe(5);
    });

    test('set replaces the entry contribution', () => {
      cache.add('c1', [sized(CS('http://a', '1'), 10), sized(VS('http://b', '1'), 5)]);
      expect(cache.conceptCount()).toBe(15);
      cache.set('c1', [sized(CS('http://c', '1'), 2)]);
      expect(cache.conceptCount()).toBe(2);
      expect(cache.conceptCountFor('c1')).toBe(2);
    });

    test('clear subtracts the cleared entry', () => {
      cache.add('c1', [sized(CS('http://a', '1'), 10)]);
      cache.add('c2', [sized(CS('http://b', '1'), 5)]);
      cache.clear('c1');
      expect(cache.conceptCount()).toBe(5);
      expect(cache.conceptCountFor('c1')).toBe(0);
    });

    test('clearAll resets the total to zero', () => {
      cache.add('c1', [sized(CS('http://a', '1'), 10)]);
      cache.add('c2', [sized(CS('http://b', '1'), 5)]);
      cache.clearAll();
      expect(cache.conceptCount()).toBe(0);
    });

    test('prune subtracts evicted entries', () => {
      cache.add('old', [sized(CS('http://old', '1'), 7)]);
      setLastUsed('old', Date.now() - 10000);
      cache.add('fresh', [sized(CS('http://fresh', '1'), 4)]);
      cache.prune(5000);
      expect(cache.conceptCount()).toBe(4);
    });
  });

  // the concept limits are the memory store's: the shared store does not apply them
  (store.name === 'memory' ? describe : describe.skip)('limits', () => {
    test('a request that would take a cache past its limit drops the cache: 404 cache-id-unknown, saying why', () => {
      cache.setLimits(10, 100);
      cache.add('c1', [sized(CS('http://a', '1'), 8)]);
      cache.add('c1', [sized(CS('http://a', '1'), 10)]); // a replacement counts the difference
      expect(cache.conceptCount()).toBe(10);
      expect(() => cache.add('c1', [sized(CS('http://b', '1'), 1)])).toThrow(expect.objectContaining({
        statusCode: 404, cause: 'not-found', issueCode: 'cache-id-unknown', msgId: 'CACHE_ID_DISCARDED_TOO_BIG', msgParams: ['c1', 10],
        message: expect.stringMatching(/cache 'c1' grew too large: .* over 10 concepts, .* dropped the cache\. This operation has not been performed\. Start a new cache/)
      }));
      expect(cache.has('c1')).toBe(false);
      expect(cache.conceptCount()).toBe(0);
      expect(cache.describeMissing('c1')).toEqual({ messageId: 'CACHE_ID_DISCARDED', params: ['c1', expect.any(String), 10] });
    });

    test('a new cache too big to start is refused (nothing to discard)', () => {
      cache.setLimits(10, 100);
      expect(() => cache.set('c2', [sized(CS('http://b', '1'), 11)])).toThrow(expect.objectContaining({ statusCode: 422, issueCode: 'too-costly' }));
      expect(cache.has('c2')).toBe(false);
      expect(cache.conceptCount()).toBe(0);
    });

    test('a resource sent twice in one request is counted once', () => {
      cache.setLimits(10, 100);
      cache.add('c1', [sized(CS('http://a', '1'), 6), sized(CS('http://a', '1'), 6)]);
      expect(cache.get('c1')).toHaveLength(1);
      expect(cache.conceptCountFor('c1')).toBe(6);
      expect(cache.conceptCount()).toBe(6);
    });

    test('over the total, the least recently used caches are dropped and say so', () => {
      cache.setLimits(10, 20);
      cache.set('old', [sized(CS('http://a', '1'), 10)]);
      cache.set('used', [sized(CS('http://a', '1'), 10)]);
      cache.cache.get('old').lastUsed = Date.now() - 2000;
      cache.cache.get('used').lastUsed = Date.now() - 3000;
      cache.get('used'); // now the most recently used of the two
      cache.set('new', [sized(CS('http://a', '1'), 5)]);
      expect(cache.has('old')).toBe(false);
      expect(cache.has('used')).toBe(true);
      expect(cache.has('new')).toBe(true);
      expect(cache.conceptCount()).toBe(15);
      expect(cache.describeMissing('old').messageId).toBe('CACHE_ID_EVICTED');
    });

    test('the defaults apply until limits are set; Infinity = no limit', () => {
      expect(new ResourceCache(null).maxConceptsPerCache).toBe(ResourceCache.MAX_CONCEPTS_PER_CACHE);
      expect(new ResourceCache(null).maxTotalConcepts).toBe(ResourceCache.MAX_TOTAL_CONCEPTS);
      cache.setLimits(Infinity, Infinity);
      cache.set('c1', [sized(CS('http://a', '1'), ResourceCache.MAX_TOTAL_CONCEPTS + 1)]);
      cache.set('c2', [sized(CS('http://a', '1'), 1)]);
      expect(cache.conceptCount()).toBe(ResourceCache.MAX_TOTAL_CONCEPTS + 2);
    });
  });

  describe('high-water marks (max)', () => {
    test('track the most caches and concepts ever held', () => {
      cache.add('c1', [sized(CS('http://a', '1'), 10)]);
      cache.add('c2', [sized(CS('http://b', '1'), 5)]);
      expect(cache.maxSize()).toBe(2);
      expect(cache.maxConceptCount()).toBe(15);
    });

    test('max is not reduced when entries are cleared', () => {
      cache.add('c1', [sized(CS('http://a', '1'), 10)]);
      cache.add('c2', [sized(CS('http://b', '1'), 5)]);
      cache.clear('c1');
      cache.clear('c2');
      expect(cache.size()).toBe(0);
      expect(cache.conceptCount()).toBe(0);
      // high-water marks persist
      expect(cache.maxSize()).toBe(2);
      expect(cache.maxConceptCount()).toBe(15);
    });

    test('max grows but never shrinks across set/prune', () => {
      cache.set('c1', [sized(CS('http://a', '1'), 20)]);
      expect(cache.maxConceptCount()).toBe(20);
      cache.set('c1', [sized(CS('http://a', '1'), 3)]); // shrink live count
      expect(cache.conceptCount()).toBe(3);
      expect(cache.maxConceptCount()).toBe(20);
    });
  });

  describe('sealed and unsealed', () => {
    test('set() records whether the cache is sealed; add() keeps an unsealed cache unsealed', () => {
      cache.set('open', [CS('http://a', '1')], false);
      cache.set('shut', [CS('http://a', '1')], true);
      expect(cache.isSealed('open')).toBe(false);
      expect(cache.isSealed('shut')).toBe(true);
      expect(cache.isSealed('nope')).toBe(false);
      cache.add('open', [VS('http://v', '1')]);
      expect(cache.isSealed('open')).toBe(false);
      expect(cache.get('open').map(r => r.url)).toEqual(['http://a', 'http://v']);
    });

    test('an empty cache made by set() exists', () => {
      cache.set('empty', [], true);
      expect(cache.has('empty')).toBe(true);
      expect(cache.get('empty')).toEqual([]);
      expect(cache.status('empty').resources).toBe(0);
    });

    test('order is kept, and a replacement keeps its place', () => {
      cache.add('c1', [CS('http://a', '1'), CS('http://b', '1'), CS('http://c', '1')]);
      cache.add('c1', [{ ...CS('http://b', '1'), title: 'new b' }, CS('http://d', '1')]);
      const got = cache.get('c1');
      expect(got.map(r => r.url)).toEqual(['http://a', 'http://b', 'http://c', 'http://d']);
      expect(got[1].title).toBe('new b');
    });
  });

  describe('resources are marked as cached', () => {
    test('get() returns resources with a non-enumerable isCached marker', () => {
      cache.add('c1', [CS('http://a', '1')]);
      const [r] = cache.get('c1');
      expect(r.isCached).toBe(true);
      expect(Object.keys(r)).not.toContain('isCached');
      expect(JSON.stringify(r)).not.toContain('isCached');
    });
  });

  // A cap on the total size of what the cache holds: when a write takes it over, whole
  // caches are dropped, least recently used first, and remembered as `evicted`.
  // only the shared store has a cap: the memory store is as it was
  (store.name === 'sqlite' ? describe : describe.skip)('size cap (maxBytes)', () => {
    const big = (url, n) => ({ ...CS(url, '1'), description: 'x'.repeat(n) });

    test('drops the least recently used caches, never the one being written', () => {
      cache = store.make({ maxBytes: 2500 });
      cache.set('a', [big('http://a', 1000)]);
      cache.set('b', [big('http://b', 1000)]);
      setLastUsed('a', Date.now() - 60000);
      setLastUsed('b', Date.now() - 30000);
      cache.set('c', [big('http://c', 1000)]); // over the cap: 'a' is the oldest
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(true);
      expect(cache.has('c')).toBe(true);
      expect(cache.byteCount()).toBeLessThanOrEqual(2500);

      const t = cache.tombstone('a');
      expect(t.reason).toBe('evicted');
      expect(t.maxBytes).toBe(2500);
      expect(t.idleMs).toBeGreaterThanOrEqual(60000);
      const d = cache.describeMissing('a');
      expect(d.messageId).toBe('CACHE_ID_EVICTED_SIZE');
      expect(d.params[0]).toBe('a');
      expect(d.params[2]).toBe('2 KB');
      expect(d.params[3]).toBe('60 seconds');
    });

    test('growing a cache with add() can evict others too', () => {
      cache = store.make({ maxBytes: 2500 });
      cache.set('a', [big('http://a', 1000)]);
      setLastUsed('a', Date.now() - 60000);
      cache.set('b', [big('http://b', 1000)]);
      cache.add('b', [big('http://b2', 1000)]);
      expect(cache.has('a')).toBe(false);
      expect(cache.tombstone('a').reason).toBe('evicted');
      expect(cache.get('b')).toHaveLength(2);
    });

    test('a single cache bigger than the cap is kept (there is nothing else to drop)', () => {
      cache = store.make({ maxBytes: 500 });
      cache.set('a', [big('http://a', 1000)]);
      expect(cache.has('a')).toBe(true);
    });

    test('no cap, nothing is dropped', () => {
      for (let i = 0; i < 20; i++) {
        cache.set('c' + i, [big('http://c' + i, 1000)]);
      }
      expect(cache.size()).toBe(20);
    });
  });
});

// Behaviour that only the shared SQLite store has.
describe('SqliteResourceCache', () => {
  const { CodeSystem } = require('../../tx/library/codesystem');
  const ValueSet = require('../../tx/library/valueset');
  const make = (opts = {}) => {
    const c = new SqliteResourceCache(null, { path: path.join(tmpDir, `only-${++fileNo}.db`), scope: '/r4', ...opts });
    opened.push(c);
    return c;
  };
  const lastUsedOf = (c, id) => c.db.prepare('SELECT last_used FROM sessions WHERE scope = ? AND cache_id = ?').get(c.scope, id).last_used;

  test('wrappers come back as wrappers, with the FHIR version they arrived in', () => {
    const c = make();
    const cs = new CodeSystem({
      resourceType: 'CodeSystem', url: 'http://example.org/cs', version: '1', status: 'active', content: 'complete',
      concept: [{ code: 'a', display: 'A' }, { code: 'b', display: 'B', concept: [{ code: 'b1' }] }]
    }, 'R4');
    const vs = new ValueSet({
      resourceType: 'ValueSet', url: 'http://example.org/vs', status: 'active',
      compose: { include: [{ system: 'http://example.org/cs', filter: [{ property: 'concept', op: 'is-a', value: 'b' }] }] }
    }, 'R3');
    c.set('c1', [cs, vs]);
    const [cs2, vs2] = c.get('c1');
    expect(cs2).toBeInstanceOf(CodeSystem);
    expect(vs2).toBeInstanceOf(ValueSet);
    expect(cs2.fhirVersion).toBe('R4');
    expect(vs2.fhirVersion).toBe('R3');
    expect(cs2.jsonObj).toEqual(cs.jsonObj);
    expect(vs2.jsonObj).toEqual(vs.jsonObj);
    expect(cs2.conceptCount()).toBe(3);
    expect(c.conceptCountFor('c1')).toBe(3);
    expect(cs2.isCached).toBe(true);
    // a fresh object every time: nothing is shared between requests
    expect(c.get('c1')[0]).not.toBe(cs2);
  });

  describe('a request only loads the resources it uses', () => {
    const { ConceptMap } = require('../../tx/library/conceptmap');
    const { ExpansionCache } = require('../../tx/operation-context');
    const mkCs = (url, version, extra = {}) => new CodeSystem({
      resourceType: 'CodeSystem', url, version, status: 'active', content: 'complete',
      concept: [{ code: 'a', display: 'A' }], ...extra
    }, 'R4');
    const countLoads = (c) => {
      const orig = c.q.content;
      const counter = { n: 0 };
      c.q.content = { get: (...args) => { counter.n++; return orig.get(...args); } };
      return counter;
    };

    test('looking through the cache by url, version and type loads nothing', () => {
      const c = make();
      c.set('c1', [mkCs('http://x/a', '1'), mkCs('http://x/b', '2'), mkCs('http://x/sup', '1', { content: 'supplement', supplements: 'http://x/a' })]);
      const loads = countLoads(c);
      const got = c.get('c1');
      expect(got.map(r => r.url)).toEqual(['http://x/a', 'http://x/b', 'http://x/sup']);
      expect(got.map(r => r.version)).toEqual(['1', '2', '1']);
      expect(got.map(r => r.vurl)).toEqual(['http://x/a|1', 'http://x/b|2', 'http://x/sup|1']);
      expect(got.every(r => r.resourceType === 'CodeSystem' && r instanceof CodeSystem)).toBe(true);
      expect(got.some(r => r instanceof ConceptMap)).toBe(false);
      expect(got.map(r => r.supplementsUrl)).toEqual([undefined, undefined, 'http://x/a']);
      expect(got[2].isGlobalSupplement()).toBe(false);
      expect(got.every(r => r.isCached === true)).toBe(true);
      expect(loads.n).toBe(0);

      // using one loads that one only, once
      expect(got[1].content).toBe('complete');
      expect(got[1].jsonObj.concept[0].code).toBe('a');
      expect(got[1].conceptCount()).toBe(1);
      expect(loads.n).toBe(1);
    });

    test('a loaded stand-in behaves like the wrapper it stands for', () => {
      const c = make();
      const original = mkCs('http://x/a', '1');
      c.set('c1', [original]);
      const [r] = c.get('c1');
      expect(r.jsonObj).toEqual(original.jsonObj);
      expect(r.fhirVersion).toBe('R4');
      expect(r.versionAlgorithm()).toEqual(original.versionAlgorithm());
      expect(JSON.parse(JSON.stringify(r)).jsonObj).toEqual(original.jsonObj);
      r.sourcePackage = 'p';
      expect(r.sourcePackage).toBe('p');
    });

    test('the expansion cache key is the same as for the resources built eagerly', () => {
      const c = make();
      const resources = [mkCs('http://x/a', '1'), new ValueSet({ resourceType: 'ValueSet', url: 'http://x/vs', status: 'active',
        compose: { include: [{ system: 'http://x/a' }] } }, 'R4')];
      c.set('c1', resources);
      const ec = new ExpansionCache(null);
      const vs = { resourceType: 'ValueSet', url: 'http://x/vs' };
      const loads = countLoads(c);
      const lazyKey = ec.computeKey(vs, null, c.get('c1'));
      expect(loads.n).toBe(0);
      const eager = c.q.resources.all('/r4', 'c1').map(row => c._build(row));
      expect(ec.computeKey(vs, null, eager)).toBe(lazyKey);
      expect(ec.computeKey(vs, null, resources)).toBe(lazyKey);
    });

    test('the stored hash pre-fills each resource\'s expansion-key hash (P6): same keys, no hashing', () => {
      const crypto = require('crypto');
      const { CanonicalResource } = require('../../tx/library/canonical-resource');
      const c = make();
      const resources = [
        mkCs('http://x/a', '1'),
        mkCs('http://x/sup', '1', { content: 'supplement', supplements: 'http://x/a' }),
        new ValueSet({ resourceType: 'ValueSet', url: 'http://x/vs', status: 'active',
          compose: { include: [{ system: 'http://x/a', filter: [{ property: 'concept', op: 'is-a', value: 'a' }] }] } }, 'R3'),
        new ConceptMap({ resourceType: 'ConceptMap', url: 'http://x/cm', status: 'active',
          group: [{ source: 'http://x/a', target: 'http://x/b', element: [{ code: 'a', target: [{ code: 'b', relationship: 'equivalent' }] }] }] }),
        { resourceType: 'NamingSystem', url: 'http://x/ns', name: 'plain' }
      ];
      // the keys the memory store's resources (the ones the client sent) make
      const vs = new ValueSet({ resourceType: 'ValueSet', url: 'http://x/expand-me', status: 'active', compose: { include: [{ system: 'http://x/a' }] } });
      const ec = new ExpansionCache(null);
      const params = { hashSource: () => 'p' };
      const memoryKey = ec.computeKey(vs, params, resources);
      c.set('c1', resources);

      // stand-ins: the hash comes from the row - nothing is loaded and nothing hashed
      // but the key itself and the plain resource
      const lazy = c.get('c1');
      const loads = countLoads(c);
      const createHash = jest.spyOn(crypto, 'createHash');
      let lazyKey;
      try {
        lazyKey = ec.computeKey(vs, params, lazy);
        expect(createHash).toHaveBeenCalledTimes(2);
      } finally {
        createHash.mockRestore();
      }
      expect(loads.n).toBe(0);
      expect(lazyKey).toBe(memoryKey);

      // loaded: each wrapper was given the row's hash when it was built
      for (const r of lazy.slice(0, 4)) {
        void r.jsonObj;
      }
      expect(loads.n).toBe(4);
      for (const [i, r] of lazy.entries()) {
        const expected = CanonicalResource.computeExpansionKeyHash(resources[i].jsonObj || resources[i]);
        if (typeof r.expansionKeyHash === 'function') {
          expect(r.expansionKeyHash()).toBe(expected);
        }
      }
      const spy = jest.spyOn(crypto, 'createHash');
      try {
        expect(ec.computeKey(vs, params, lazy)).toBe(memoryKey);
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
      // and built eagerly from the rows
      const eager = c.q.resources.all('/r4', 'c1').map(row => c._build(row));
      expect(ec.computeKey(vs, params, eager)).toBe(memoryKey);
    });

    test.each(['add', 'set'])('%s replacing a lazy resource cannot change the content behind its expansion key', async (method) => {
      const { ExpandWorker } = require('../../tx/workers/expand');
      const c = make();
      const original = mkCs('http://x/a', '1');
      const replacement = mkCs('http://x/a', '1', { concept: [{ code: 'b' }] });
      c.set('c1', [original]);
      const ec = new ExpansionCache(null);
      ec.forceCaching = true;
      const vs = { resourceType: 'ValueSet', compose: { include: [{ system: 'http://x/a' }] } };
      const resources = c.get('c1');
      const oldKey = ec.computeKey(vs, null, resources);
      // Run the real cache lookup/compute/store path, with the replacement between
      // computeKey and the first use of the lazy resource's JSON.
      const worker = {
        deadCheck() {}, log: { debug() {} }, opContext: { expansionCache: ec },
        additionalResources: resources,
        async performExpansion() {
          c[method]('c1', [replacement]);
          return { expansion: { contains: this.additionalResources[0].jsonObj.concept } };
        }
      };
      await expect(ExpandWorker.prototype.doExpand.call(worker, vs, null))
        .rejects.toMatchObject({ statusCode: 409, cause: 'conflict', msgId: 'CACHE_ID_CHANGED_DURING_REQUEST' });
      expect(ec.get(oldKey)).toBeNull();
      expect(resources[0].expansionKeyHash()).toBe(original.expansionKeyHash());

      // Retrying from a fresh index succeeds and caches only under the new key.
      worker.additionalResources = c.get('c1');
      const newKey = ec.computeKey(vs, null, worker.additionalResources);
      expect(newKey).not.toBe(oldKey);
      const result = await ExpandWorker.prototype.doExpand.call(worker, vs, null);
      expect(result.expansion.contains).toEqual([{ code: 'b' }]);
      expect(ec.get(newKey)).toEqual(result);
      expect(ec.get(oldKey)).toBeNull();
    });

    test('a loaded resource keeps its snapshot, and an unchanged lazy resource still loads after a write', () => {
      const c = make();
      const original = mkCs('http://x/a', '1');
      c.set('c1', [original]);
      const [loaded] = c.get('c1');
      expect(loaded.jsonObj).toEqual(original.jsonObj);
      const [lazy] = c.get('c1');
      c.add('c1', [mkCs('http://x/b', '1')]);
      expect(lazy.jsonObj).toEqual(original.jsonObj);
      c.add('c1', [mkCs('http://x/a', '1', { concept: [{ code: 'b' }] })]);
      expect(loaded.jsonObj).toEqual(original.jsonObj);
      expect(loaded.expansionKeyHash()).toBe(original.expansionKeyHash());
    });

    test('a resource that has gone by the time it is used fails like a dead cache-id', () => {
      const c = make();
      c.set('c1', [mkCs('http://x/a', '1')]);
      const [r] = c.get('c1');
      c.clear('c1');
      let err = null;
      try {
        void r.jsonObj;
      } catch (e) {
        err = e;
      }
      expect(err).not.toBeNull();
      expect(err.statusCode).toBe(404);
      expect(err.issueCode).toBe('cache-id-unknown');
      expect(err.message).toMatch(/was closed while this request was using it/);
    });
  });

  test('endpoints share the file but not caches', () => {
    const file = path.join(tmpDir, `scopes-${++fileNo}.db`);
    const r4 = new SqliteResourceCache(null, { path: file, scope: '/r4' });
    const r5 = new SqliteResourceCache(null, { path: file, scope: '/r5' });
    opened.push(r4, r5);
    r4.set('c1', [CS('http://a', '1')]);
    expect(r4.has('c1')).toBe(true);
    expect(r5.has('c1')).toBe(false);
    expect(r5.get('c1')).toEqual([]);
    r4.clear('c1');
    expect(r5.tombstone('c1')).toBeNull();
  });

  test('last_used is refreshed at most once per touch interval', () => {
    const c = make({ touchIntervalMs: 30000 });
    c.set('c1', [CS('http://a', '1')]);
    const t0 = Date.now() - 10000;
    c.db.prepare('UPDATE sessions SET last_used = ?').run(t0);
    c.get('c1');
    expect(lastUsedOf(c, 'c1')).toBe(t0); // 10 s ago: within the interval, not written
    c.add('c1', [CS('http://a', '1')]);   // same content again: no write either
    expect(lastUsedOf(c, 'c1')).toBe(t0);

    const t1 = Date.now() - 31000;
    c.db.prepare('UPDATE sessions SET last_used = ?').run(t1);
    c.get('c1');
    expect(lastUsedOf(c, 'c1')).toBeGreaterThan(Date.now() - 2000); // past the interval: refreshed
  });

  test('an explicit touch (mode=check) is not throttled', () => {
    const c = make({ touchIntervalMs: 30000 });
    c.set('c1', [CS('http://a', '1')]);
    c.db.prepare('UPDATE sessions SET last_used = ?').run(Date.now() - 10000);
    expect(c.touch('c1')).toBe(true);
    expect(c.status('c1').idleMs).toBeLessThan(1000);
  });

  test('a failed last_used refresh is ignored', () => {
    const c = make({ touchIntervalMs: 0 });
    c.set('c1', [CS('http://a', '1')]);
    const orig = c.q.touch;
    c.q.touch = { run: () => { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); } };
    try {
      expect(c.get('c1')).toHaveLength(1);
      expect(c.touch('c1')).toBe(true);
    } finally {
      c.q.touch = orig;
    }
  });

  test('a failed write of uploaded resources is retried once, then answered 503 - never dropped silently', () => {
    const c = make();
    c.set('c1', [CS('http://a', '1')]);
    const orig = c.q.upsertResource;
    let calls = 0;
    c.q.upsertResource = { run: () => { calls++; throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); } };
    let err = null;
    try {
      c.add('c1', [CS('http://b', '1')]);
    } catch (e) {
      err = e;
    } finally {
      c.q.upsertResource = orig;
    }
    expect(calls).toBe(2);
    expect(err).not.toBeNull();
    expect(err.statusCode).toBe(503);
    expect(err.msgId).toBe('CACHE_WRITE_FAILED');
    // the failed transaction changed nothing
    expect(c.get('c1').map(r => r.url)).toEqual(['http://a']);
  });

  test('one failure then success: the retry saves the resources', () => {
    const c = make();
    c.set('c1', []);
    const orig = c.q.upsertResource;
    let calls = 0;
    c.q.upsertResource = { run: (row) => { if (++calls === 1) { throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }); } return orig.run(row); } };
    try {
      c.add('c1', [CS('http://b', '1')]);
    } finally {
      c.q.upsertResource = orig;
    }
    expect(c.get('c1').map(r => r.url)).toEqual(['http://b']);
  });

  test('add() does not bring back a cache that has been closed', () => {
    const c = make();
    c.set('c1', [CS('http://a', '1')]);
    c.clear('c1');
    c.add('c1', [CS('http://b', '1')]);
    expect(c.has('c1')).toBe(false);
    expect(c.tombstone('c1').reason).toBe('closed');
  });

  test('the size cap covers every endpoint in the file', () => {
    const file = path.join(tmpDir, `cap-${++fileNo}.db`);
    const r4 = new SqliteResourceCache(null, { path: file, scope: '/r4', maxBytes: 2500 });
    const r5 = new SqliteResourceCache(null, { path: file, scope: '/r5', maxBytes: 2500 });
    opened.push(r4, r5);
    r4.set('a', [{ ...CS('http://a', '1'), description: 'x'.repeat(1000) }]);
    r4.db.prepare('UPDATE sessions SET last_used = ?').run(Date.now() - 60000);
    r5.set('b', [{ ...CS('http://b', '1'), description: 'x'.repeat(1000) }]);
    r5.set('c', [{ ...CS('http://c', '1'), description: 'x'.repeat(1000) }]);
    expect(r4.has('a')).toBe(false);
    expect(r4.tombstone('a').reason).toBe('evicted');
    expect(r5.has('b')).toBe(true);
  });

  test('a cache survives a restart (closing and reopening the file)', () => {
    const file = path.join(tmpDir, `restart-${++fileNo}.db`);
    const before = new SqliteResourceCache(null, { path: file, scope: '/r4' });
    before.set('c1', [CS('http://a', '1')], true);
    before.set('c2', []);
    before.clear('c2');
    before.close();

    const after = new SqliteResourceCache(null, { path: file, scope: '/r4' });
    opened.push(after);
    expect(after.has('c1')).toBe(true);
    expect(after.isSealed('c1')).toBe(true);
    expect(after.get('c1').map(r => r.url)).toEqual(['http://a']);
    expect(after.describeMissing('c2').messageId).toBe('CACHE_ID_CLOSED');
  });

  test('a file from a different schema version is refused, not misread', () => {
    const file = path.join(tmpDir, `schema-${++fileNo}.db`);
    const c = new SqliteResourceCache(null, { path: file, scope: '/r4' });
    c.db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema'").run();
    c.close();
    expect(() => new SqliteResourceCache(null, { path: file, scope: '/r4' })).toThrow(/schema version 999/);
  });
});
