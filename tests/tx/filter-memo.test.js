/**
 * What providers remember on the filters of value sets held beyond one request
 * (tx/library/filter-memo.js): a package's within a budget of concepts, least recently used
 * first; a client cache's counted as concepts the cache holds, under its limits
 */
const { LibraryFilterMemos, FILTER_ANALYSIS, SNOMED_FILTER_ANALYSIS, markFilters, recall, remember, memoSize, filterMemoSize } =
  require('../../tx/library/filter-memo');
const { ResourceCache } = require('../../tx/operation-context');

function valueSet(n = 1) {
  const filters = Array.from({ length: n }, (_, i) => ({ property: 'concept', op: 'is-a', value: 'c' + i }));
  return { jsonObj: { resourceType: 'ValueSet', url: 'http://example.org/vs' + Math.random(), compose: { include: [{ system: 'http://x', filter: filters }] } },
    url: 'u', version: '1', conceptCount: () => 0 };
}
const filterOf = (vs, i = 0) => vs.jsonObj.compose.include[0].filter[i];
const list = (n) => Array.from({ length: n }, (_, i) => i);

describe('library filter memos', () => {
  test('kept within the budget, least recently used first; a result bigger than the budget is not kept', () => {
    const memos = new LibraryFilterMemos(10);
    const vs = valueSet(3);
    markFilters(vs, memos);
    const [a, b, c] = [0, 1, 2].map(i => filterOf(vs, i));
    expect(remember(a, FILTER_ANALYSIS, 'v1', list(4))).toBe(true);
    expect(remember(b, FILTER_ANALYSIS, 'v1', list(4))).toBe(true);
    expect(recall(a, FILTER_ANALYSIS, 'v1')).toHaveLength(4); // a is now the most recently used
    expect(remember(c, FILTER_ANALYSIS, 'v1', list(4))).toBe(true); // b goes
    expect(recall(b, FILTER_ANALYSIS, 'v1')).toBeUndefined();
    expect(recall(a, FILTER_ANALYSIS, 'v1')).toHaveLength(4);
    expect(memos.size).toBe(2);
    expect(memos.total).toBe(8);
    expect(remember(a, FILTER_ANALYSIS, 'v2', list(11))).toBe(false);
    expect(recall(a, FILTER_ANALYSIS, 'v2')).toBeUndefined();
  });

  test('one for each version; remembered again for the same version replaces it', () => {
    const memos = new LibraryFilterMemos(100);
    const vs = valueSet();
    markFilters(vs, memos);
    const fc = filterOf(vs);
    remember(fc, SNOMED_FILTER_ANALYSIS, 'v1', { descendants: list(3), members: list(2), eclAst: {} });
    remember(fc, SNOMED_FILTER_ANALYSIS, 'v2', { descendants: list(5) });
    remember(fc, SNOMED_FILTER_ANALYSIS, 'v2', { descendants: list(6) });
    expect(memos.size).toBe(2);
    expect(memos.total).toBe(11);
    expect(filterMemoSize(vs)).toEqual({ count: 2, concepts: 11 });
  });

  test('clear lets them all go, from the filters too', () => {
    const memos = new LibraryFilterMemos(100);
    const vs = valueSet(2);
    markFilters(vs, memos);
    remember(filterOf(vs, 0), FILTER_ANALYSIS, 'v1', list(3));
    remember(filterOf(vs, 1), FILTER_ANALYSIS, 'v1', list(3));
    expect(memos.clear()).toBe(2);
    expect(memos.total).toBe(0);
    expect(filterMemoSize(vs)).toEqual({ count: 0, concepts: 0 });
  });

  test('a filter with no keeper (a value set for one request) remembers as before', () => {
    const fc = filterOf(valueSet());
    expect(remember(fc, FILTER_ANALYSIS, 'v1', list(3))).toBe(true);
    expect(recall(fc, FILTER_ANALYSIS, 'v1')).toHaveLength(3);
    expect(remember(null, FILTER_ANALYSIS, 'v1', list(3))).toBe(false);
    expect(recall(null, FILTER_ANALYSIS, 'v1')).toBeUndefined();
  });

  test('memoSize', () => {
    expect(memoSize([1, 2])).toBe(2);
    expect(memoSize(new Set([1]))).toBe(1);
    expect(memoSize(new Uint32Array(5))).toBe(5);
    expect(memoSize({ descendants: [1, 2], members: new Set([3]), eclAst: { a: 1 } })).toBe(3);
    expect(memoSize(null)).toBe(0);
  });
});

describe('client cache filter memos', () => {
  test('count as concepts the cache holds, and go with it', () => {
    const cache = new ResourceCache(null);
    const vs = valueSet();
    cache.set('c1', [vs]);
    expect(remember(filterOf(vs), FILTER_ANALYSIS, 'v1', list(7))).toBe(true);
    expect(cache.conceptCountFor('c1')).toBe(7);
    expect(cache.conceptCount()).toBe(7);
    cache.clear('c1');
    expect(cache.conceptCount()).toBe(0);
  });

  test('a result that would take the cache over its limit is not kept, and the cache is', () => {
    const cache = new ResourceCache(null);
    cache.setLimits(10, 100);
    const vs = valueSet();
    cache.add('c1', [vs]);
    expect(remember(filterOf(vs), FILTER_ANALYSIS, 'v1', list(8))).toBe(true);
    expect(remember(filterOf(vs), FILTER_ANALYSIS, 'v2', list(8))).toBe(false);
    expect(recall(filterOf(vs), FILTER_ANALYSIS, 'v2')).toBeUndefined();
    expect(cache.has('c1')).toBe(true);
    expect(cache.conceptCountFor('c1')).toBe(8);
  });

  test('they count towards the total: the least recently used caches are dropped to make room', () => {
    const cache = new ResourceCache(null);
    cache.setLimits(100, 10);
    const old = valueSet();
    cache.set('old', [old]);
    remember(filterOf(old), FILTER_ANALYSIS, 'v1', list(6));
    const vs = valueSet();
    cache.set('new', [vs]);
    expect(remember(filterOf(vs), FILTER_ANALYSIS, 'v1', list(6))).toBe(true);
    expect(cache.has('old')).toBe(false);
    expect(cache.conceptCount()).toBe(6);
  });

  test('replacing a resource takes its results with it', () => {
    const cache = new ResourceCache(null);
    const vs = valueSet();
    cache.add('c1', [vs]);
    remember(filterOf(vs), FILTER_ANALYSIS, 'v1', list(5));
    const again = { ...valueSet(), jsonObj: { ...valueSet().jsonObj, url: vs.jsonObj.url } };
    again.url = vs.url;
    again.version = vs.version;
    cache.add('c1', [again]);
    expect(cache.conceptCountFor('c1')).toBe(0);
    // the old resource is no longer in the cache: what is remembered on it isn't counted
    expect(remember(filterOf(vs), FILTER_ANALYSIS, 'v2', list(5))).toBe(false);
  });
});
