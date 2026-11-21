const { ExpansionCache, ExpansionCacheBudget, countExpansionCodes } = require('../../tx/operation-context');

/**
 * ExpansionCache caches an expansion only when it took at least
 * MIN_CACHE_TIME_MS — unless forceCaching is enabled, in which case every
 * expansion is cached regardless of duration. The test runner uses
 * forceCaching to run the whole suite a third time with the cache fully active.
 */

describe('ExpansionCache duration threshold', () => {
  test('does not cache fast expansions by default', () => {
    const c = new ExpansionCache(null);
    expect(c.set('k', { v: 1 }, 10)).toBe(false);
    expect(c.get('k')).toBeFalsy();
  });

  test('caches slow expansions by default', () => {
    const c = new ExpansionCache(null);
    expect(c.set('k', { v: 1 }, ExpansionCache.MIN_CACHE_TIME_MS)).toBe(true);
    expect(c.get('k')).toEqual({ v: 1 });
  });
});

describe('ExpansionCache forceCaching', () => {
  test('defaults to off', () => {
    expect(new ExpansionCache(null).forceCaching).toBe(false);
  });

  test('caches fast (even zero-duration) expansions when on', () => {
    const c = new ExpansionCache(null);
    c.forceCaching = true;
    expect(c.set('k', { v: 1 }, 0)).toBe(true);
    expect(c.get('k')).toEqual({ v: 1 });
  });

  test('still caches slow expansions when on', () => {
    const c = new ExpansionCache(null);
    c.forceCaching = true;
    expect(c.set('k', { v: 2 }, 9999)).toBe(true);
    expect(c.get('k')).toEqual({ v: 2 });
  });

  test('clearAll empties the cache (used to reset between passes)', () => {
    const c = new ExpansionCache(null);
    c.forceCaching = true;
    c.set('k', { v: 1 }, 0);
    expect(c.size()).toBeGreaterThan(0);
    c.clearAll();
    expect(c.size()).toBe(0);
    expect(c.get('k')).toBeFalsy();
  });
});

describe('ExpansionCache.forceSet removed', () => {
  test('the dead forceSet method no longer exists', () => {
    expect(new ExpansionCache(null).forceSet).toBeUndefined();
  });
});

describe('ExpansionCache.getStats (not shadowed by the stats field)', () => {
  test('the stats field holds the ServerStats arg, not a method', () => {
    const serverStats = { task() {}, taskDone() {} };
    const c = new ExpansionCache(serverStats);
    expect(c.stats).toBe(serverStats);   // field, not a function
    expect(typeof c.getStats).toBe('function');
  });

  test('getStats reports size, maxSize and hit counts', () => {
    const c = new ExpansionCache(null, 50);
    c.forceCaching = true;
    c.set('a', { v: 1 }, 0);
    c.set('b', { v: 2 }, 0);
    c.get('a');           // 1 hit
    c.get('a');           // 2 hits
    c.get('b');           // 1 hit
    const s = c.getStats();
    expect(s.size).toBe(2);
    expect(s.maxSize).toBe(50);
    expect(s.totalHits).toBe(3);
  });
});

describe('ExpansionCache: a budget of codes, shared between caches (K6)', () => {
  const exp = (n) => ({ resourceType: 'ValueSet', expansion: { contains: Array.from({ length: n }, (_, i) => ({ code: 'c' + i })) } });
  const cache = (budget, size = 1000) => {
    const c = new ExpansionCache(null, size, 0, budget);
    c.forceCaching = true;
    return c;
  };

  test('codes are counted at all levels of a hierarchical expansion', () => {
    expect(countExpansionCodes({ expansion: { contains: [{ code: 'a', contains: [{ code: 'b' }, { code: 'c', contains: [{ code: 'd' }] }] }] } })).toBe(4);
    expect(countExpansionCodes({ jsonObj: exp(3) })).toBe(3);
    expect(countExpansionCodes({ expansion: {} })).toBe(0);
  });

  test('the default budget is a quarter of the heap limit at 1 KB a code', () => {
    const limit = require('v8').getHeapStatistics().heap_size_limit;
    expect(new ExpansionCacheBudget().maxCodes).toBe(Math.floor(limit / 4 / 1024));
    expect(new ExpansionCacheBudget(500).maxCodes).toBe(500);
  });

  test('going over the budget drops the least recently used entries', () => {
    const c = cache(new ExpansionCacheBudget(100));
    c.set('a', exp(40), 0);
    c.set('b', exp(40), 0);
    c.get('a'); // b is now the least recently used
    c.set('c', exp(40), 0);
    expect(c.has('a')).toBe(true);
    expect(c.has('b')).toBe(false);
    expect(c.has('c')).toBe(true);
    expect(c.budget.total).toBe(80);
  });

  test('one budget covers several caches: an insert in one can drop entries in another', () => {
    const budget = new ExpansionCacheBudget(100);
    const r5 = cache(budget);
    const r4 = cache(budget);
    r5.set('a', exp(60), 0);
    r4.set('b', exp(60), 0);
    expect(r5.has('a')).toBe(false);
    expect(r4.has('b')).toBe(true);
    expect(budget.total).toBe(60);
  });

  test('an expansion bigger than the whole budget is not cached', () => {
    const c = cache(new ExpansionCacheBudget(100));
    c.set('a', exp(50), 0);
    expect(c.set('big', exp(101), 0)).toBe(false);
    expect(c.has('a')).toBe(true);
  });

  test('replacing, clearing and the entry limit keep the total right', () => {
    const budget = new ExpansionCacheBudget(1000);
    const c = cache(budget, 2);
    c.set('a', exp(10), 0);
    c.set('a', exp(20), 0);
    expect(budget.total).toBe(20);
    c.set('b', exp(30), 0);
    c.set('c', exp(40), 0); // over the entry limit: a goes
    expect(c.has('a')).toBe(false);
    expect(budget.total).toBe(70);
    c.clear('b');
    expect(budget.total).toBe(40);
    c.clearAll();
    expect(budget.total).toBe(0);
    expect(c.size()).toBe(0);
  });

  test('the half eviction under memory pressure takes the least recently used half', () => {
    const c = cache(new ExpansionCacheBudget(1000));
    for (const k of ['a', 'b', 'c', 'd']) {
      c.set(k, exp(1), 0);
    }
    c.get('a');
    c.get('b');
    expect(c.evictOldestHalf()).toBe(2);
    expect([...c.cache.keys()]).toEqual(['a', 'b']);
    expect(c.budget.total).toBe(2);
  });
});
