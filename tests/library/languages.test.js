const {
  Language,
  Languages,
  LanguageDefinitions,
  LanguagePartType
} = require('../../library/languages');

const fs = require('fs');
const path = require('path');
const {TestUtilities} = require("../test-utilities");

describe('Language Class', () => {
  beforeEach(async () => {
    this.languageDefinitions = await TestUtilities.loadLanguageDefinitions();
  });

  describe('Construction and Defaults', () => {
    test('should default to nothing when no code provided', () => {
      const lang = new Language();
      expect(lang.language).toBe("");
      expect(lang.region).toBe("");
    });

    test('should create from xml:lang attribute', () => {
      const lang = Language.fromXmlLang('fr-CA');
      expect(lang.language).toBe('fr');
      expect(lang.region).toBe('CA');
    });

    test('should default to en-US for empty xml:lang', () => {
      const lang = Language.fromXmlLang('');
      expect(lang.language).toBe('en');
      expect(lang.region).toBe('US');
    });

    test('should create from system default', () => {
      const lang = Language.fromSystemDefault();
      expect(lang.language).toBeTruthy();
      expect(lang.code).toBeTruthy();
    });
  });

  describe('Language Code Parsing', () => {
    test('should parse simple language code', () => {
      const lang = new Language('en');
      expect(lang.language).toBe('en');
      expect(lang.region).toBe('');
      expect(lang.script).toBe('');
    });

    test('should parse language-region code', () => {
      const lang = new Language('en-US');
      expect(lang.language).toBe('en');
      expect(lang.region).toBe('US');
    });

    test('should parse language-script-region code', () => {
      const lang = new Language('zh-Hans-CN');
      expect(lang.language).toBe('zh');
      expect(lang.script).toBe('Hans');
      expect(lang.region).toBe('CN');
    });

    test('should parse complex language code with variant', () => {
      const lang = new Language('en-US-variant');
      expect(lang.language).toBe('en');
      expect(lang.region).toBe('US');
      expect(lang.variant).toBe('variant');
    });

    test('should parse language with extended language', () => {
      const lang = new Language('zh-cmn-Hans-CN');
      expect(lang.language).toBe('zh');
      expect(lang.extLang).toContain('cmn');
      expect(lang.script).toBe('Hans');
      expect(lang.region).toBe('CN');
    });

    test('should parse private use tags', () => {
      const lang = new Language('en-US-x-private');
      expect(lang.language).toBe('en');
      expect(lang.region).toBe('US');
      expect(lang.privateUse).toContain('private');
    });

    test('should handle numeric region codes', () => {
      const lang = new Language('es-419');
      expect(lang.language).toBe('es');
      expect(lang.region).toBe('419');
    });

    test('should normalize case correctly', () => {
      const lang = new Language('EN-us');
      expect(lang.language).toBe('EN'); // Keep original case for language
      expect(lang.region).toBe('US'); // Uppercase for region
    });
  });

  describe('Language Matching', () => {
    test('should match identical languages', () => {
      const lang1 = new Language('en-US');
      const lang2 = new Language('en-US');
      expect(lang1.matches(lang2)).toBe(true);
    });

    test('should match at language level only', () => {
      const lang1 = new Language('en-US');
      const lang2 = new Language('en-GB');
      expect(lang1.matches(lang2, LanguagePartType.LANGUAGE)).toBe(true);
      expect(lang1.matches(lang2, LanguagePartType.REGION)).toBe(false);
    });

    test('should match with script consideration', () => {
      const lang1 = new Language('zh-Hans');
      const lang2 = new Language('zh-Hans');
      expect(lang1.matches(lang2, LanguagePartType.SCRIPT)).toBe(true);

      const lang3 = new Language('zh-Hant');
      expect(lang1.matches(lang3, LanguagePartType.SCRIPT)).toBe(false);
    });

    test('should handle simple matching', () => {
      const lang1 = new Language('en-US');
      const lang2 = new Language('en-US');
      expect(lang1.matchesSimple(lang2)).toBe(true);

      const lang3 = new Language('en-GB');
      expect(lang1.matchesSimple(lang3)).toBe(false);
    });

    test('should return false when matching with null', () => {
      const lang = new Language('en-US');
      expect(lang.matches(null)).toBe(false);
      expect(lang.matchesSimple(null)).toBe(false);
    });
  });

  describe('Language Properties', () => {
    test('should identify lang-region tags', () => {
      const lang1 = new Language('en-US');
      expect(lang1.isLangRegion()).toBe(true);

      const lang2 = new Language('zh-Hans-CN');
      expect(lang2.isLangRegion()).toBe(false); // Has script

      const lang3 = new Language('en');
      expect(lang3.isLangRegion()).toBe(false); // No region
    });

    test('should convert to string correctly', () => {
      const lang1 = new Language('en-US');
      expect(lang1.toString()).toBe('en-US');

      const lang2 = new Language('zh-cmn-Hans-CN');
      expect(lang2.toString()).toBe('zh-cmn-Hans-CN');

      const lang3 = new Language('en-US-x-private');
      expect(lang3.toString()).toBe('en-US-x-private');
    });

    test('should handle quality values', () => {
      const lang = new Language('en-US');
      lang.quality = 0.8;
      expect(lang.quality).toBe(0.8);
    });
  });
});

describe('Languages Class', () => {
  describe('Accept-Language Header Parsing', () => {
    test('should parse simple Accept-Language header', () => {
      const languages = Languages.fromAcceptLanguage('en-US,en;q=0.9', this.languageDefinitions);
      expect(languages.length).toBe(2);
      expect(languages.get(0).code).toBe('en-US');
      expect(languages.get(0).quality).toBe(1.0);
      expect(languages.get(1).code).toBe('en');
      expect(languages.get(1).quality).toBe(0.9);
    });

    test('should parse complex Accept-Language header', () => {
      const languages = Languages.fromAcceptLanguage('fr-CA,fr;q=0.9,en-US;q=0.8,en;q=0.7', this.languageDefinitions);
      expect(languages.length).toBe(4);
      expect(languages.get(0).code).toBe('fr-CA');
      expect(languages.get(1).code).toBe('fr');
      expect(languages.get(2).code).toBe('en-US');
      expect(languages.get(3).code).toBe('en');
    });

    test('should sort by quality values', () => {
      const languages = Languages.fromAcceptLanguage('en;q=0.5,fr;q=0.9,es;q=0.7', this.languageDefinitions);
      expect(languages.get(0).code).toBe('fr'); // q=0.9
      expect(languages.get(1).code).toBe('es'); // q=0.7
      expect(languages.get(2).code).toBe('en'); // q=0.5
    });

    test('should not add en-US if English already present', () => {
      const languages = Languages.fromAcceptLanguage('en-GB,fr-CA', this.languageDefinitions);
      const enLanguages = Array.from(languages).filter(l => l.language === 'en');
      expect(enLanguages.length).toBe(1);
      expect(enLanguages[0].code).toBe('en-GB');
    });

    test('should handle empty Accept-Language header', () => {
      const languages = Languages.fromAcceptLanguage('', this.languageDefinitions);
      expect(languages.length).toBe(1);
      expect(languages.get(0).language).toBe('en');
    });

    test('should handle malformed quality values', () => {
      const languages = Languages.fromAcceptLanguage('en;q=invalid,fr;q=0.8', this.languageDefinitions);
      expect(languages.get(0).quality).toBe(1.0); // en gets default quality
      expect(languages.get(1).quality).toBe(0.8); // fr comes first due to valid q
    });
  });

  describe('Language Iteration and Access', () => {
    test('should be iteratable', () => {
      const languages = Languages.fromAcceptLanguage('en-US,fr-CA', this.languageDefinitions);
      const codes = [];
      for (const lang of languages) {
        codes.push(lang.code);
      }
      expect(codes).toEqual(['en-US', 'fr-CA']);
    });

    test('should provide array-like access', () => {
      const languages = Languages.fromAcceptLanguage('en-US,fr-CA', this.languageDefinitions);
      expect(languages.get(0).code).toBe('en-US');
      expect(languages.get(1).code).toBe('fr-CA');
      expect(languages.length).toBe(2);
    });

    test('should get primary language', () => {
      const languages = Languages.fromAcceptLanguage('fr-CA,en-US', this.languageDefinitions);
      expect(languages.getPrimary().code).toBe('fr-CA');
    });

    test('should return en-US as primary for empty languages', () => {
      const languages = new Languages(this.languageDefinitions);
      expect(languages.getPrimary().language).toBe('en');
    });
  });

  describe('Language Matching', () => {
    test('should find best match', () => {
      const languages = Languages.fromAcceptLanguage('en-US,fr-CA,es-ES', this.languageDefinitions);
      const target = new Language('fr-CA');
      const match = languages.findBestMatch(target);
      expect(match.code).toBe('fr-CA');
    });

    test('should find partial match at language level', () => {
      const languages = Languages.fromAcceptLanguage('en-US,fr-CA', this.languageDefinitions);
      const target = new Language('en-GB');
      const match = languages.findBestMatch(target, LanguagePartType.LANGUAGE);
      expect(match.code).toBe('en-US');
    });

    test('should return null if no match found', () => {
      const languages = Languages.fromAcceptLanguage('en-US,fr-CA', this.languageDefinitions);
      const target = new Language('zh-CN');
      const match = languages.findBestMatch(target);
      expect(match).toBeNull();
    });

    test('should check if any language matches', () => {
      const languages = Languages.fromAcceptLanguage('en-US,fr-CA', this.languageDefinitions);
      const target1 = new Language('en-GB');
      const target2 = new Language('zh-CN');
      
      expect(languages.matches(target1, LanguagePartType.LANGUAGE)).toBe(true);
      expect(languages.matches(target2, LanguagePartType.LANGUAGE)).toBe(false);
    });
  });
});

describe('LanguageDefinitions Class', () => {
  let definitions;

  beforeAll(async () => {
    // Try to load real IETF data, fall back to mock if not available
    const realDataPath = path.join(__dirname, '../../tx/data');

    if (fs.existsSync(realDataPath)) {
      definitions = await LanguageDefinitions.fromFiles(realDataPath);
    } else {
      throw new Error('Real data file not found');
    }
  });

  describe('Loading and Validation', () => {
    test('should validate source content', () => {
      expect(LanguageDefinitions.checkSource('%%')).toBe('Ok');
      expect(LanguageDefinitions.checkSource('invalid')).toBe('Invalid');
    });

    test('should load real IETF data and have common languages', () => {
      // Test that common languages are loaded
      expect(definitions.languages.has('en')).toBe(true);
      expect(definitions.languages.has('fr')).toBe(true);
      expect(definitions.languages.has('es')).toBe(true);
      expect(definitions.languages.has('de')).toBe(true);
      expect(definitions.languages.has('zh')).toBe(true);
      
      // Test that common regions are loaded
      expect(definitions.regions.has('US')).toBe(true);
      expect(definitions.regions.has('CA')).toBe(true);
      expect(definitions.regions.has('GB')).toBe(true);
      
      // Test that common scripts are loaded
      expect(definitions.scripts.has('Latn')).toBe(true);
    });

    test('should handle duplicate codes', () => {
      const duplicateContent = `%%
Type: language
Subtag: en
Description: English
%%
Type: language
Subtag: en
Description: English Again
%%`;
      
      expect(() => {
        LanguageDefinitions.fromContent(duplicateContent);
      }).toThrow('Duplicate language code: en');
    });

    test('should handle unknown types gracefully', () => {
      const unknownContent = `%%
Type: unknown
Subtag: test
Description: Test
%%`;
      
      expect(() => {
        LanguageDefinitions.fromContent(unknownContent);
      }).toThrow('Unknown type: unknown');
    });
  });

  describe('Language Parsing and Validation', () => {
    test('the cache of parsed tags is capped, dropping the least recently used', () => {
      const en = definitions.parse('en');
      for (let i = 0; i < LanguageDefinitions.MAX_PARSED + 10; i++) {
        definitions.parse('en-x-' + i);
        definitions.parse('en'); // kept, being used
      }
      expect(definitions.parsed.size).toBe(LanguageDefinitions.MAX_PARSED);
      expect(definitions.parse('en')).toBe(en);
      expect(definitions.parsed.has(':en-x-0')).toBe(false);
      expect(definitions.parse('en-x-0').privateUse).toEqual(['0']);
    });

    test('should parse valid language codes', () => {
      const lang = definitions.parse('en-US');
      expect(lang).not.toBeNull();
      expect(lang.language).toBe('en');
      expect(lang.region).toBe('US');
    });

    test('should handle wildcard language', () => {
      const lang = definitions.parse('*');
      expect(lang).not.toBeNull();
      expect(lang.language).toBe('*');
    });

    test('should return null for invalid language codes', () => {
      let lang = definitions.parse('invalid-US');
      expect(lang).toBeNull();
      const msg = {};
      lang = definitions.parse('en-us', msg);
      expect(lang).toBeNull();
      expect(msg.message).toBe("The region 'us' in the code 'en-us' is not valid");
    });

    test('should parse basic language codes', () => {
      const msg = {};
      const lang = definitions.parse('en', msg);
      expect(lang).not.toBeNull();
      expect(lang.language).toBe('en');
      expect(msg.message).toBeUndefined();
    });

    test('should parse wildcard', () => {
      const lang = definitions.parse('*', {});
      expect(lang).not.toBeNull();
      expect(lang.language).toBe('*');
    });

    test('should parse language + region', () => {
      const lang = definitions.parse('en-US', {});
      expect(lang).not.toBeNull();
      expect(lang.language).toBe('en');
      expect(lang.region).toBe('US');
    });

    test('should parse language + script', () => {
      const lang = definitions.parse('zh-Hans', {});
      expect(lang).not.toBeNull();
      expect(lang.language).toBe('zh');
      expect(lang.script).toBe('Hans');
    });

    test('should parse language + script + region', () => {
      const lang = definitions.parse('zh-Hans-CN', {});
      expect(lang).not.toBeNull();
      expect(lang.language).toBe('zh');
      expect(lang.script).toBe('Hans');
      expect(lang.region).toBe('CN');
    });

    test('should parse language + region + variant', () => {
      const lang = definitions.parse('sl-IT-nedis', {});
      expect(lang).not.toBeNull();
      expect(lang.language).toBe('sl');
      expect(lang.region).toBe('IT');
      expect(lang.variant).toBe('nedis');
    });

    test('should parse private use extensions', () => {
      const lang = definitions.parse('en-US-x-twain', {});
      expect(lang).not.toBeNull();
      expect(lang.language).toBe('en');
      expect(lang.region).toBe('US');
    });

    test('should return null for empty code', () => {
      const msg = {};
      const lang = definitions.parse('', msg);
      expect(lang).toBeNull();
    });

    test('should return null for invalid language code', () => {
      const msg = {};
      const lang = definitions.parse('xx', msg);
      expect(lang).toBeNull();
      expect(msg.message).toContain('not valid');
    });

    test('should return null for unrecognised trailing parts', () => {
      const msg = {};
      const lang = definitions.parse('en-ZZ-ZZ', msg);
      expect(lang).toBeNull();
      expect(msg.message).toContain('Unable to recognise');
    });

    test('should cache parsed results', () => {
      const a = definitions.parse('en', {});
      const b = definitions.parse('en', {});
      expect(a).toBe(b);
    });

    test('should cache parsed languages', () => {
      const lang1 = definitions.parse('en-US');
      const lang2 = definitions.parse('en-US');
      expect(lang1).toBe(lang2); // Same reference due to caching
    });

    test('should handle empty language code', () => {
      const lang = definitions.parse('');
      expect(lang).toBeNull();
    });

    test('should parse complex language codes with real data', () => {
      // Test some real complex language codes that should exist in IETF data
      const complexCodes = ['zh-Hans-CN', 'sr-Latn-RS', 'ca-valencia'];
      
      complexCodes.forEach(code => {
        const lang = definitions.parse(code);
        expect(lang).toBeTruthy();
        expect(lang.language).toBeTruthy();
      });
    });
  });

  describe('Display Name Retrieval', () => {

    test('should get display names for languages', () => {
      expect(definitions.getDisplayForLang('en')).toBe('English');
      expect(definitions.getDisplayForLang('fr')).toBe('French');
      expect(definitions.getDisplayForLang('unknown')).toBe('unknown');
    });

    test('should get display names for regions', () => {
      expect(definitions.getDisplayForRegion('US')).toBe('United States');
      expect(definitions.getDisplayForRegion('CA')).toBe('Canada');
      expect(definitions.getDisplayForRegion('unknown')).toBe('unknown');
    });

    test('should get display names for scripts', () => {
      expect(definitions.getDisplayForScript('Latn')).toBe('Latin');
      expect(definitions.getDisplayForScript('Hans')).toBe('Han (Simplified variant)');
      expect(definitions.getDisplayForScript('unknown')).toBe('unknown');
    });
  });

  describe('Language Presentation', () => {

    test('should present simple language', () => {
      const lang = new Language('en');
      const presentation = definitions.present(lang);
      expect(presentation).toBe('English');
    });

    test('should present language with region', () => {
      const lang = new Language('en-US');
      const presentation = definitions.present(lang);
      expect(presentation).toBe('English (United States)');
    });

    test('should present language with script and region', () => {
      const lang = new Language('zh-Hans-CN');
      const presentation = definitions.present(lang);
      expect(presentation).toContain('Script=Han (Simplified variant)');
      expect(presentation).toContain('Region=China');
    });

    test('should use template for presentation', () => {
      const lang = new Language('en-US');
      const template = '{{lang}} ({{region}})';
      const presentation = definitions.present(lang, 0, template);
      expect(presentation).toBe('English (United States)');
    });

    test('should handle null language', () => {
      const presentation = definitions.present(null);
      expect(presentation).toBe('');
    });

    test('should get display count', () => {
      const lang = new Language('en');
      const count = definitions.displayCount(lang);
      expect(count).toBe(1);
    });
  });


  describe('Extended Language Support', () => {
    test('should load extended languages', () => {
      expect(definitions.extLanguages.has('cmn')).toBe(true);
      const extLang = definitions.extLanguages.get('cmn');
      expect(extLang.displays[0]).toBe('Mandarin Chinese');
    });

    test('should load variants', () => {
      expect(definitions.variants.has('valencia')).toBe(true);
      const variant = definitions.variants.get('valencia');
      expect(variant.displays[0]).toBe('Valencian');
    });
  });
});

describe('Language System Integration Tests', () => {
  let definitions;

  beforeAll(async () => {
    // Try to load real IETF data, fall back to mock if not available
    const realDataPath = path.join(__dirname, '../../tx/data');

    if (fs.existsSync(realDataPath)) {
      definitions = await LanguageDefinitions.fromFiles(realDataPath);
    } else {
      throw new Error('Real data file not found');
    }
  });

  test('should work together for Accept-Language processing', () => {
    const languages = Languages.fromAcceptLanguage('es-MX;q=0.9,en-US;q=0.8,fr-CA;q=0.7', this.languageDefinitions);
    
    // Test that all languages are parsed correctly
    expect(languages.length).toBe(3);
    
    // Test presentation with definitions
    for (const lang of languages) {
      const validatedLang = definitions.parse(lang.code);
      expect(validatedLang).not.toBeNull();
      
      const presentation = definitions.present(validatedLang);
      expect(presentation).toBeTruthy();
    }
  });

  test('should handle language fallback chains', () => {
    const languages = Languages.fromAcceptLanguage('en-CA,en-US,en', this.languageDefinitions);
    const target = new Language('en-GB');
    
    // Should match en-CA first at language level
    const match = languages.findBestMatch(target, LanguagePartType.LANGUAGE);
    expect(match.code).toBe('en-CA');
  });

  test('should validate and present complex language tags', () => {
    const complexLanguages = Languages.fromAcceptLanguage('es-MX,fr-CA', this.languageDefinitions);
    
    for (const lang of complexLanguages) {
      const validated = definitions.parse(lang.code);
      expect(validated).not.toBeNull();
      expect(validated.isLangRegion()).toBe(true);
      
      const presentation = definitions.present(validated);
      expect(presentation).toMatch(/\(/);
    }
  });

  test('should handle edge cases gracefully', () => {
    // Empty Accept-Language
    const emptyLangs = Languages.fromAcceptLanguage('', this.languageDefinitions);
    expect(emptyLangs.length).toBeGreaterThan(0);
    
    // Invalid language in Accept-Language
    const invalidLangs = Languages.fromAcceptLanguage('invalid-XX,en-US', null);
    expect(invalidLangs.length).toBe(2); // Still processes valid ones
    
    // Malformed header
    const malformedLangs = Languages.fromAcceptLanguage('en-US;;;q=0.8,fr', this.languageDefinitions);
    expect(malformedLangs.length).toBeGreaterThan(0);
  });
});

describe('Language Matching for Display', () => {
  describe('Language.matchesForDisplay method', () => {
    test('should match identical languages', () => {
      const lang1 = new Language('en');
      const lang2 = new Language('en');
      expect(lang1.matchesForDisplay(lang2)).toBe(true);
    });

    test('should match when this language has more details', () => {
      const specific = new Language('en-AU');
      const general = new Language('en');
      expect(specific.matchesForDisplay(general)).toBe(true);
    });

    test('should not match when target is more specific', () => {
      const general = new Language('en');
      const specific = new Language('en-AU');
      expect(general.matchesForDisplay(specific)).toBe(false);
    });

    test('should handle blank language with English fallback', () => {
      const blank = new Language('');
      const english = new Language('en');
      expect(blank.matchesForDisplay(english)).toBe(true); // blank matches when other is en
      expect(english.matchesForDisplay(blank)).toBe(true);  // en matches when other is blank
    });

    test('should match English variants correctly', () => {
      const enUS = new Language('en-US');
      const en = new Language('en');
      const enGB = new Language('en-GB');

      expect(enUS.matchesForDisplay(en)).toBe(true);   // en-US matches en
      expect(enUS.matchesForDisplay(enGB)).toBe(false); // en-US doesn't match en-GB
      expect(en.matchesForDisplay(enUS)).toBe(false);   // en doesn't match en-US (not more specific)
    });

    test('should handle script differences', () => {
      const zhHans = new Language('zh-Hans');
      const zh = new Language('zh');
      const zhHant = new Language('zh-Hant');

      expect(zhHans.matchesForDisplay(zh)).toBe(true);    // zh-Hans matches zh
      expect(zhHans.matchesForDisplay(zhHant)).toBe(false); // zh-Hans doesn't match zh-Hant
    });

    test('should work with string input', () => {
      const lang = new Language('fr-CA');
      expect(lang.matchesForDisplay('fr')).toBe(true);
      expect(lang.matchesForDisplay('en')).toBe(false);
    });
  });
});
