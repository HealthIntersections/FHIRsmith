/**
 * ResourceCache unit tests
 *
 * ResourceCache backs the cache-id protocol: resources sent under a cache-id on one
 * request must be retrievable on later requests with the same cache-id, and kept
 * isolated between different cache-ids.
 */

const { ResourceCache, formatDuration } = require('../../tx/operation-context');

const CS = (url, version) => ({ resourceType: 'CodeSystem', url, version });
const VS = (url, version) => ({ resourceType: 'ValueSet', url, version });

// A resource that reports a concept count, like the real wrapper classes do.
const sized = (resource, n) => ({ ...resource, conceptCount: () => n });

describe('ResourceCache', () => {
  let cache;

  beforeEach(() => {
    cache = new ResourceCache(null);
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
      cache.cache.get('old').lastUsed = Date.now() - 10000;
      cache.add('fresh', [CS('http://fresh', '1')]);

      cache.prune(5000); // maxAge 5s

      expect(cache.has('old')).toBe(false);
      expect(cache.has('fresh')).toBe(true);
    });

    test('get() refreshes lastUsed so an active entry is not pruned', () => {
      cache.add('c1', [CS('http://a', '1')]);
      cache.cache.get('c1').lastUsed = Date.now() - 10000;
      cache.get('c1'); // touch -> refreshes lastUsed
      cache.prune(5000);
      expect(cache.has('c1')).toBe(true);
    });
  });

  // A cache-id that isn't here has three possible fates, and telling them apart is
  // the whole point: "you closed it yourself" and "it sat idle for 31 minutes" send
  // an investigator to completely different places (see issue #279).
  describe('tombstones (why a cache-id is gone)', () => {
    test('an id that was never issued has no tombstone and reports CACHE_ID_UNKNOWN', () => {
      const d = cache.describeMissing('never-seen');
      expect(cache.tombstone('never-seen')).toBeNull();
      expect(d.messageId).toBe('CACHE_ID_UNKNOWN');
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
      cache.cache.get('c1').lastUsed = Date.now() - 10 * 60 * 1000; // idle 10 min
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
      cache.cache.get('c1').lastUsed = Date.now() - 10000;
      cache.prune(5000);
      expect(cache.tombstone('c1').reason).toBe('expired');

      cache.set('c1', [CS('http://a', '1')]);
      cache.clear('c1');
      expect(cache.tombstone('c1').reason).toBe('closed');
    });

    test('tombstones are bounded: the oldest are evicted, never unbounded growth', () => {
      const small = new ResourceCache(null, 3);
      for (const id of ['a', 'b', 'c', 'd', 'e']) {
        small.set(id, [CS('http://' + id, '1')]);
        small.clear(id);
      }
      expect(small.tombstoneCount()).toBe(3);
      expect(small.tombstone('a')).toBeNull();      // evicted
      expect(small.tombstone('b')).toBeNull();      // evicted
      expect(small.tombstone('e')).not.toBeNull();  // newest kept
      // An evicted tombstone degrades to "never issued" rather than lying.
      expect(small.describeMissing('a').messageId).toBe('CACHE_ID_UNKNOWN');
    });

    test('closing an id the server never had leaves no tombstone', () => {
      cache.clear('not-mine');
      expect(cache.tombstone('not-mine')).toBeNull();
      expect(cache.describeMissing('not-mine').messageId).toBe('CACHE_ID_UNKNOWN');
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

    test('an id from another instance is reported as misrouted, naming both instances', () => {
      cache.setInstanceCode('tx1');
      const d = cache.describeMissing('tx2.abc');
      expect(d.messageId).toBe('CACHE_ID_OTHER_INSTANCE');
      expect(d.params).toEqual(['tx2.abc', 'tx2', 'tx1']);
    });

    test('a server with no code reports a prefixed id as issued elsewhere', () => {
      const d = cache.describeMissing('tx2.abc');
      expect(d.messageId).toBe('CACHE_ID_OTHER_INSTANCE_UNNAMED');
      expect(d.params).toEqual(['tx2.abc', 'tx2']);
    });

    test('an unrecorded id with our own prefix is plain unknown (e.g. issued before a restart)', () => {
      cache.setInstanceCode('tx1');
      expect(cache.describeMissing('tx1.abc').messageId).toBe('CACHE_ID_UNKNOWN');
    });

    test('an unprefixed id on a named server is plain unknown', () => {
      cache.setInstanceCode('tx1');
      expect(cache.describeMissing('abc').messageId).toBe('CACHE_ID_UNKNOWN');
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
      cache.cache.get('c1').lastUsed = Date.now() - 90 * 1000;

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
      cache.cache.get('c1').lastUsed = Date.now() - 10000;

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
      cache.cache.get('old').lastUsed = Date.now() - 10000;
      cache.add('fresh', [sized(CS('http://fresh', '1'), 4)]);
      cache.prune(5000);
      expect(cache.conceptCount()).toBe(4);
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
});
