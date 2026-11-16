// The description language bytes in SNOMED CT caches (tx/sct/languages.js), and which caches
// the server asks to be imported again (staleCacheReasons)

const { LANGUAGE_CODES, languageByte, languageCode, languageBytesFor } = require('../../tx/sct/languages');
const { staleCacheReasons } = require('../../tx/sct/structures');

describe('SNOMED CT description language bytes', () => {
  test('1-9 keep the meanings earlier importers and the original server gave them', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(languageCode)).toEqual(['en', 'fr', 'nl', 'es', 'sv', 'da', 'de', 'it', 'cs']);
  });

  test('every ISO 639-1 language has its own byte, and they fit in one', () => {
    const codes = Object.values(LANGUAGE_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBeGreaterThanOrEqual(183);
    expect(Math.max(...Object.keys(LANGUAGE_CODES).map(Number))).toBeLessThanOrEqual(255);
    for (const code of ['no', 'fi', 'et', 'ko', 'pt', 'pl', 'lt', 'zh', 'ja']) {
      expect(languageByte(code)).toBeGreaterThan(9);
      expect(languageCode(languageByte(code))).toBe(code);
    }
  });

  test('a BCP 47 tag is read by its language', () => {
    expect(languageByte('en-US')).toBe(1);
    expect(languageByte('de-CH')).toBe(7);
    expect(languageByte('NL')).toBe(3);
    expect(languageByte('xx')).toBeNull();
    expect(languageByte('')).toBeNull();
    expect(languageCode(0)).toBeNull();
  });

  test('Norwegian is found under either code', () => {
    expect(languageBytesFor('nb')).toEqual([languageByte('nb'), languageByte('no')]);
    expect(languageBytesFor('nb-NO')).toEqual([languageByte('nb'), languageByte('no')]);
    expect(languageBytesFor('no')).toEqual([languageByte('no'), languageByte('nb')]);
    expect(languageBytesFor('fr')).toEqual([2]);
    expect(languageBytesFor('xx')).toEqual([]);
  });
});

describe('SNOMED CT caches to import again', () => {
  test('format 20 is current', () => {
    expect(staleCacheReasons('20')).toEqual([]);
  });

  test('an older format says why', () => {
    const reasons = staleCacheReasons('19');
    expect(reasons.length).toBe(3);
    expect(reasons.join(' ')).toMatch(/a day early/);
    expect(reasons.join(' ')).toMatch(/labelled English/);
    expect(reasons.join(' ')).not.toMatch(/concrete values/);
  });

  test('before 19, no concrete values either', () => {
    expect(staleCacheReasons('17').join(' ')).toMatch(/concrete values/);
    expect(staleCacheReasons('16').length).toBe(4);
  });
});

describe('the importer', () => {
  const { SnomedImporter } = require('../../tx/importers/import-sct.module');
  const terminal = require('../../tx/importers/terminal');

  test('records each description language as its own byte, and anything else as English, saying so once', () => {
    const importer = Object.create(SnomedImporter.prototype);
    const warn = jest.spyOn(terminal, 'warn').mockImplementation(() => {});
    try {
      expect(importer.mapLanguageCode('en')).toBe(1);
      expect(importer.mapLanguageCode('no')).toBe(languageByte('no'));
      expect(importer.mapLanguageCode('fi')).toBe(languageByte('fi'));
      expect(importer.mapLanguageCode('xyz')).toBe(1);
      expect(importer.mapLanguageCode('xyz')).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
