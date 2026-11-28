// An Accept-Language (or Content-Language) header with an entry that isn't a tag FHIRsmith can
// read: the entry is left out, and the request goes ahead. displayLanguage is still refused.
// A header carries language ranges (RFC 4647), and a server may ignore the ones it can't use
// (RFC 9110 12.5.4); one bad entry used to fail the whole request with a 400.

const { TxParameters } = require('../../tx/params');
const { Languages } = require('../../library/languages');
const { Issue } = require('../../tx/library/operation-outcome');
const { TestUtilities } = require('../test-utilities');

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

const codes = (languages) => languages.languages.filter(l => !l.implicit).map(l => l.code);

describe('Languages.fromAcceptLanguage with skipUnreadable', () => {
  test('without it, an entry that can\'t be read throws, as before', () => {
    expect(() => Languages.fromAcceptLanguage('en-US,xx-QQ', langDefs)).toThrow(/xx/);
  });

  test('an unregistered language is left out, and the rest kept in order', () => {
    const l = Languages.fromAcceptLanguage('fr-CA,xx-QQ;q=0.9,en;q=0.5', langDefs, false, true);
    expect(codes(l)).toEqual(['fr-CA', 'en']);
    expect(l.skipped).toEqual(['xx-QQ']);
  });

  test('a tag the grammar doesn\'t allow is left out too', () => {
    // repeated singleton, repeated variant, a wildcard inside a tag, a singleton with nothing after it
    const l = Languages.fromAcceptLanguage('en-a-bbb-a-ccc,de-1901-1901,en-*,en-a,de', langDefs, false, true);
    expect(codes(l)).toEqual(['de']);
    expect(l.skipped).toEqual(['en-a-bbb-a-ccc', 'de-1901-1901', 'en-*', 'en-a']);
  });

  test('the wildcard on its own is kept', () => {
    const l = Languages.fromAcceptLanguage('xx-QQ,*;q=0.1', langDefs, false, true);
    expect(codes(l)).toEqual(['*']);
  });

  test('a header none of whose entries can be read is as if there were none', () => {
    const none = Languages.fromAcceptLanguage('', langDefs, false, true);
    const bad = Languages.fromAcceptLanguage('xx-QQ,en-a', langDefs, true, true);
    expect(codes(bad)).toEqual(codes(none));
    expect(bad.skipped).toEqual(['xx-QQ', 'en-a']);
  });
});

describe('TxParameters: Accept-Language and Content-Language', () => {
  for (const header of ['__Accept-Language', '__Content-Language']) {
    test(`${header}: an entry that can't be read is left out, and the request goes ahead`, () => {
      const p = paramsWith([{ name: header, valueCode: 'en-US,en-a-bbb-a-ccc;q=0.5' }]);
      expect(codes(p.HTTPLanguages)).toEqual(['en-US']);
      expect(p.hasHTTPLanguages).toBe(true);
    });

    test(`${header}: nothing that can be read is no languages stated`, () => {
      const p = paramsWith([{ name: header, valueCode: 'xx-QQ' }]);
      expect(p.hasHTTPLanguages).toBe(false);
    });
  }

  test('the same language from a header with a bad entry gives the same cache key as without it', () => {
    const clean = paramsWith([{ name: '__Accept-Language', valueCode: 'fr' }]);
    const withBad = paramsWith([{ name: '__Accept-Language', valueCode: 'fr,xx-QQ;q=0.5' }]);
    expect(withBad.hashSource()).toBe(clean.hashSource());
  });

  test('displayLanguage that can\'t be read is still refused', () => {
    for (const v of ['xx-QQ', 'en-a-bbb-a-ccc', 'en-US,xx-QQ']) {
      let thrown = null;
      try {
        paramsWith([{ name: 'displayLanguage', valueCode: v }]);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Issue);
      expect(thrown.message).toMatch(/Invalid displayLanguage/);
    }
  });
});
