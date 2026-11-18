/**
 * The JSON of a large resource, with the JSON of its arrays kept in the XML cache for next time
 * (tx/json-serialise.js)
 */

const { resourceToJson } = require('../../tx/json-serialise');
const { XmlFragmentCache } = require('../../tx/xml/xml-fragment-cache');

const resource = () => ({
  resourceType: 'CodeSystem', id: 'cs', url: 'http://example.org/cs', missing: undefined,
  concept: Array.from({ length: 20 }, (_, i) => ({ code: 'c' + i, display: 'Concept ' + i })),
  expansion: { total: 2, contains: [{ code: 'a' }, { code: 'b' }] },
  meta: { tag: [{ code: 't' }] },
  count: 0, flag: false, nothing: null
});

describe('resourceToJson', () => {
  test('without a cache, it is JSON.stringify', () => {
    const r = resource();
    expect(resourceToJson(r, null)).toBe(JSON.stringify(r));
  });

  test('with a cache, the text is the same as JSON.stringify gives, key order included', () => {
    const r = resource();
    const cache = new XmlFragmentCache({ budgetBytes: 1e6, minMs: 0 });
    expect(resourceToJson(r, cache)).toBe(JSON.stringify(r));
    expect(resourceToJson(r, cache)).toBe(JSON.stringify(r));
    expect(resourceToJson(r, cache)).toBe(JSON.stringify(r));
  });

  test('an array expensive twice is kept, and served from the cache after that', () => {
    const r = resource();
    const cache = new XmlFragmentCache({ budgetBytes: 1e6, minMs: 0 });
    resourceToJson(r, cache);
    expect(cache.get(r.concept, 'json')).toBeNull();
    resourceToJson(r, cache);
    expect(cache.get(r.concept, 'json')).toBe(JSON.stringify(r.concept));
    expect(cache.get(r.expansion.contains, 'json')).toBe(JSON.stringify(r.expansion.contains));
    // what's kept is what's sent
    cache.put(r.concept, 'json', '["kept"]');
    expect(resourceToJson(r, cache)).toContain('"concept":["kept"]');
  });

  test('a cheap array is not kept', () => {
    const r = resource();
    const cache = new XmlFragmentCache({ budgetBytes: 1e6, minMs: 1e9 });
    resourceToJson(r, cache);
    resourceToJson(r, cache);
    expect(cache.size).toBe(0);
  });

  test('the JSON and the XML of the same array are kept apart', () => {
    const r = resource();
    const cache = new XmlFragmentCache({ budgetBytes: 1e6, minMs: 0 });
    cache.put(r.concept, 'concept|0', '<concept/>');
    resourceToJson(r, cache);
    resourceToJson(r, cache);
    expect(cache.get(r.concept, 'concept|0')).toBe('<concept/>');
    expect(cache.get(r.concept, 'json')).toBe(JSON.stringify(r.concept));
  });

  test('something with toJSON is left to JSON.stringify', () => {
    const r = { resourceType: 'X', toJSON: () => ({ replaced: true }) };
    const cache = new XmlFragmentCache({ budgetBytes: 1e6, minMs: 0 });
    expect(resourceToJson(r, cache)).toBe('{"replaced":true}');
  });
});
