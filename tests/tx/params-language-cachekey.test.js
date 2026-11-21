const { TxParameters } = require('../../tx/params');
const { TestUtilities } = require('../test-utilities');

/**
 * Language must enter the expansion cache key. hasHTTPLanguages/
 * hasDisplayLanguages used to read Languages.source (a field that never
 * existed), so they were always falsy and the language-folding blocks in
 * hashSource() were dead — a cached expansion could be served in the wrong
 * language. These tests confirm the flags are set when a language is supplied
 * and that the language now changes hashSource().
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

describe('TxParameters — language enters the cache key', () => {
  test('no language: flags false and hash stable', () => {
    const a = paramsWith();
    const b = paramsWith();
    expect(a.hasHTTPLanguages).toBe(false);
    expect(a.hasDisplayLanguages).toBe(false);
    expect(a.hashSource()).toBe(b.hashSource());
  });

  test('Accept-Language sets hasHTTPLanguages', () => {
    const p = paramsWith([{ name: '__Accept-Language', valueCode: 'fr' }]);
    expect(p.hasHTTPLanguages).toBe(true);
  });

  test('displayLanguage sets hasDisplayLanguages', () => {
    const p = paramsWith([{ name: 'displayLanguage', valueCode: 'de' }]);
    expect(p.hasDisplayLanguages).toBe(true);
  });

  test('different Accept-Language values produce different hashes', () => {
    const fr = paramsWith([{ name: '__Accept-Language', valueCode: 'fr' }]);
    const de = paramsWith([{ name: '__Accept-Language', valueCode: 'de' }]);
    expect(fr.hashSource()).not.toBe(de.hashSource());
  });

  test('a requested language differs from no language in the hash', () => {
    const none = paramsWith();
    const fr = paramsWith([{ name: '__Accept-Language', valueCode: 'fr' }]);
    expect(fr.hashSource()).not.toBe(none.hashSource());
  });

  test('different displayLanguage values produce different hashes', () => {
    const de = paramsWith([{ name: 'displayLanguage', valueCode: 'de' }]);
    const es = paramsWith([{ name: 'displayLanguage', valueCode: 'es' }]);
    expect(de.hashSource()).not.toBe(es.hashSource());
  });

  test('the same requested language hashes identically (cacheable)', () => {
    const a = paramsWith([{ name: '__Accept-Language', valueCode: 'fr' }]);
    const b = paramsWith([{ name: '__Accept-Language', valueCode: 'fr' }]);
    expect(a.hashSource()).toBe(b.hashSource());
  });
});
