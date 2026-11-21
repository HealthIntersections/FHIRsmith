const { TxParameters } = require('../../tx/params');
const { TestUtilities } = require('../test-utilities');

/**
 * useSupplement changes the expansion result (and a bad supplement must produce
 * an error), so it must be part of the expansion cache key. It was previously
 * absent from hashSource(), so supplement-none/good/bad requests collided in the
 * cache — the forced-caching test pass surfaced this when a bad-supplement
 * request returned a cached 200 instead of a 4xx.
 */

let langDefs, i18n;

beforeAll(async () => {
  langDefs = await TestUtilities.loadLanguageDefinitions();
  i18n = await TestUtilities.loadTranslations(langDefs);
});

function paramsWith(extra = []) {
  const p = new TxParameters(langDefs, i18n);
  p.readParams({
    resourceType: 'Parameters',
    parameter: [{ name: 'url', valueUri: 'http://example.org/vs' }, ...extra]
  });
  return p;
}

describe('TxParameters — useSupplement enters the cache key', () => {
  test('no supplement: hash stable', () => {
    expect(paramsWith().hashSource()).toBe(paramsWith().hashSource());
  });

  test('a supplement differs from no supplement', () => {
    const none = paramsWith();
    const withSup = paramsWith([{ name: 'useSupplement', valueCanonical: 'http://example.org/supp' }]);
    expect(withSup.hashSource()).not.toBe(none.hashSource());
  });

  test('different supplements produce different hashes', () => {
    const a = paramsWith([{ name: 'useSupplement', valueCanonical: 'http://example.org/supp-a' }]);
    const b = paramsWith([{ name: 'useSupplement', valueCanonical: 'http://example.org/supp-b' }]);
    expect(a.hashSource()).not.toBe(b.hashSource());
  });

  test('the same supplement hashes identically (cacheable)', () => {
    const a = paramsWith([{ name: 'useSupplement', valueCanonical: 'http://example.org/supp' }]);
    const b = paramsWith([{ name: 'useSupplement', valueCanonical: 'http://example.org/supp' }]);
    expect(a.hashSource()).toBe(b.hashSource());
  });

  test('supplement set is order-independent', () => {
    const ab = paramsWith([
      { name: 'useSupplement', valueCanonical: 'http://example.org/a' },
      { name: 'useSupplement', valueCanonical: 'http://example.org/b' }
    ]);
    const ba = paramsWith([
      { name: 'useSupplement', valueCanonical: 'http://example.org/b' },
      { name: 'useSupplement', valueCanonical: 'http://example.org/a' }
    ]);
    expect(ab.hashSource()).toBe(ba.hashSource());
  });
});
