const { TxParameters } = require('../../tx/params');
const { TestUtilities } = require('../test-utilities');

/**
 * no-cache=true must bust the expansion cache. The cache key (hashSource) reads
 * FUid; the no-cache handler previously wrote `this.uid` (a write-only stray
 * property), so FUid stayed '' and the key was unchanged. These tests confirm
 * no-cache now changes FUid and therefore the hash.
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

describe('TxParameters no-cache cache busting', () => {
  test('without no-cache, FUid is empty and the hash is stable across identical inputs', () => {
    const a = paramsWith();
    const b = paramsWith();
    expect(a.FUid).toBe('');
    expect(a.hashSource()).toBe(b.hashSource());
  });

  test('no-cache=true (string form) sets FUid to a random UUID', () => {
    const p = paramsWith([{ name: 'no-cache', valueString: 'true' }]);
    expect(p.FUid).not.toBe('');
    expect(p.FUid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('no-cache=true (boolean form) also busts the cache', () => {
    const cacheable = paramsWith();
    const p = paramsWith([{ name: 'no-cache', valueBoolean: true }]);
    expect(p.FUid).not.toBe('');
    expect(p.hashSource()).not.toBe(cacheable.hashSource());
  });

  test('no-cache=false (boolean form) does not bust the cache', () => {
    const plain = paramsWith();
    const p = paramsWith([{ name: 'no-cache', valueBoolean: false }]);
    expect(p.FUid).toBe('');
    expect(p.hashSource()).toBe(plain.hashSource());
  });

  test('no-cache=true changes the hash relative to a cacheable request', () => {
    const cacheable = paramsWith();
    const noCache = paramsWith([{ name: 'no-cache', valueString: 'true' }]);
    expect(noCache.hashSource()).not.toBe(cacheable.hashSource());
  });

  test('two no-cache=true requests hash differently (so each bypasses the cache)', () => {
    const a = paramsWith([{ name: 'no-cache', valueString: 'true' }]);
    const b = paramsWith([{ name: 'no-cache', valueString: 'true' }]);
    expect(a.hashSource()).not.toBe(b.hashSource());
  });

  test('no-cache=false does not bust the cache', () => {
    const plain = paramsWith();
    const noCacheFalse = paramsWith([{ name: 'no-cache', valueString: 'false' }]);
    expect(noCacheFalse.FUid).toBe('');
    expect(noCacheFalse.hashSource()).toBe(plain.hashSource());
  });
});
