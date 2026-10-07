const { TxParameters } = require('../../tx/params');
const { TestUtilities } = require('../test-utilities');

/**
 * Result-affecting expansion parameters that were previously omitted from the
 * cache key (hashSource), so a cached expansion could be served for a request
 * with a different text filter, abstract setting, etc. These confirm each now
 * changes the key, and that the same value keeps it stable (still cacheable).
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

const base = () => paramsWith().hashSource();

describe('TxParameters — text filter enters the cache key', () => {
  test('a filter differs from no filter', () => {
    expect(paramsWith([{ name: 'filter', valueString: 'heart' }]).hashSource()).not.toBe(base());
  });

  test('different filters produce different keys', () => {
    const a = paramsWith([{ name: 'filter', valueString: 'heart' }]).hashSource();
    const b = paramsWith([{ name: 'filter', valueString: 'lung' }]).hashSource();
    expect(a).not.toBe(b);
  });

  test('the same filter is stable (still cacheable)', () => {
    const a = paramsWith([{ name: 'filter', valueString: 'heart' }]).hashSource();
    const b = paramsWith([{ name: 'filter', valueString: 'heart' }]).hashSource();
    expect(a).toBe(b);
  });

  test('filter delimiters do not collide (free text is escaped)', () => {
    const a = paramsWith([{ name: 'filter', valueString: 'a|b' }]).hashSource();
    const b = paramsWith([{ name: 'filter', valueString: 'a' }, { name: 'sort', valueString: 'b' }]).hashSource();
    expect(a).not.toBe(b);
  });
});

describe('TxParameters — other result-affecting params enter the cache key', () => {
  test('abstract changes the key (default is abstractOk=true, so test false)', () => {
    expect(paramsWith([{ name: 'abstract', valueBoolean: false }]).hashSource()).not.toBe(base());
  });

  test('diagnostics changes the key', () => {
    expect(paramsWith([{ name: 'diagnostics', valueBoolean: true }]).hashSource()).not.toBe(base());
  });

  test('a plain request (none of these) has a stable key', () => {
    expect(base()).toBe(base());
  });
});
