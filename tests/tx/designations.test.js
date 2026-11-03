const path = require('path');

const {
  Designation,
  Designations,
  DesignationUse,
  SearchFilterText,
  DisplayCheckingStyle,
  DisplayDifference
} = require('../../tx/library/designations');
const { LanguageDefinitions, Languages, Language } = require('../../library/languages');

describe('Designations', () => {
  let languageDefinitions;
  let designations;

  beforeAll(async () => {
    // Load real language registry
    const langDataPath = path.join(__dirname, '../../tx/data');
    languageDefinitions = await LanguageDefinitions.fromFiles(langDataPath);
  });

  beforeEach(() => {
    designations = new Designations(languageDefinitions);
  });

  describe('Basic functionality', () => {
    test('should create empty designations', () => {
      expect(designations.count).toBe(0);
      expect(designations.baseLang).toBeNull();
      expect(designations.designations).toEqual([]);
    });

    test('should clear designations', () => {
      designations.addDesignation(true, 'inactive', 'en', null, 'Test');
      designations.baseLang = languageDefinitions.parse('en-US');

      designations.clear();

      expect(designations.count).toBe(0);
      expect(designations.baseLang).toBeNull();
    });

    test('should handle baseLang property', () => {
      const lang = languageDefinitions.parse('en-US');
      designations.baseLang = lang;
      expect(designations.baseLang).toBe(lang);
      expect(designations.langCode).toBe('en-US');
    });
  });

  describe('Adding designations', () => {
    test('should add basic designation', () => {
      designations.addDesignation(false, 'active', 'en', null, 'English display');
      const result = designations.designations[0];
        expect(designations.count).toBe(1);
      expect(result.display).toBe('English display');
      expect(result.language.code).toBe('en');
      expect(result.status).toBe('active');
      expect(result.use).toBeNull();
    });

    test('should add display designation with use coding', () => {
      const result = designations.addDesignation(true, 'inactive', 'en-US', null, 'Display text');

      expect(result.use.system).toBe(DesignationUse.DISPLAY.system);
      expect(result.use.code).toBe(DesignationUse.DISPLAY.code);
    });

    test('should add designations from array', () => {
      const displays = ['Display 1', 'Display 2', 'Display 3'];
      designations.addDesignationsFromArray('active', false, 'fr', null, displays);

      expect(designations.count).toBe(3);
      expect(designations.designations[0].display).toBe('Display 1');
      expect(designations.designations[1].display).toBe('Display 2');
      expect(designations.designations[2].display).toBe('Display 3');
      expect(designations.designations[0].language.code).toBe('fr');
    });

    test('should add designation with primitive value and extensions', () => {
      const value = 'Test value';
      const extensions = [
        { url: 'http://example.com/ext1', valueString: 'ext1' },
        { url: 'http://example.com/ext2', valueString: 'ext2' }
      ];

      const result = designations.addDesignation(true, 'inactive', 'de', null, value, extensions);

      expect(result.value).toBe(value);
      expect(result.extensions).toHaveLength(2);
      expect(result.extensions[0].url).toBe('http://example.com/ext1');
    });

    test('should add designation from FHIR concept', () => {
      const fhirConcept = {
        language: 'es',
        use: { system: 'http://snomed.info/sct', code: 'preferred' },
        value: 'Spanish term',
        extension : [{ url : 'http://hl7.org/fhir/StructureDefinition/coding-sctdescid', valueId: '12345' }] };

      designations.addDesignationFromConcept(fhirConcept);
      const result = designations.designations[0];

      expect(result.language.code).toBe('es');
      expect(result.use.system).toBe('http://snomed.info/sct');
      expect(result.display).toBe('Spanish term');
      expect(result.extensions).toHaveLength(1);
    });
  });

  describe('Language matching logic', () => {
    beforeEach(() => {
      // Set up test designations with various languages
      designations.addDesignation(true, 'inactive', 'en', null, 'Base English');
      designations.addDesignation(false, 'active', 'en-US', DesignationUse.PREFERRED, 'US English Display');
      designations.addDesignation(false, 'inactive', 'en-GB', null, 'British English');
      designations.addDesignation(false, 'inactive', 'fr', null, 'French');
      designations.addDesignation(false, 'inactive', 'de-DE', null, 'German');
      designations.baseLang = languageDefinitions.parse('en');
    });

    test('should find preferred designation without language list', () => {
      const preferred = designations.preferredDesignation();
      expect(preferred.display).toBe('US English Display');
      expect(designations.isDisplay(preferred)).toBe(true);
    });

    test('should find preferred designation with language preference', () => {
      const langList = Languages.fromAcceptLanguage('en-US,en;q=0.9');
      const preferred = designations.preferredDesignation(langList);

      // Should prefer base designation over display for same language
      expect(preferred.display).toBe('US English Display');
    });

    test('should find preferred display designation when no base available', () => {
      // Remove base designation
      designations.designations = designations.designations.filter(d => !d.base);

      const langList = Languages.fromAcceptLanguage('en-US,en;q=0.9');
      const preferred = designations.preferredDesignation(langList);

      expect(preferred.display).toBe('US English Display');
      expect(preferred.use.code).toBe(DesignationUse.PREFERRED.code);
    });

    test('should handle complex language fallback', () => {
      const langList = Languages.fromAcceptLanguage('de-AT,de;q=0.9,en;q=0.8');
      const preferred = designations.preferredDesignation(langList);

      // Should find German since de-AT falls back to de
      expect(preferred.display).toBe('German');
    });

    test('should handle wildcard language', () => {
      const langList = new Languages();
      const wildcard = new Language('*');
      wildcard.quality = 1.0;
      langList.add(wildcard);

      const preferred = designations.preferredDesignation(langList);
      expect(preferred).not.toBeNull();
    });

    test('should respect quality values', () => {
      const langList = Languages.fromAcceptLanguage('fr;q=0.1,en;q=0.9');
      designations.designations[0].status = 'active';
      const preferred = designations.preferredDesignation(langList);

      // Should prefer English due to higher quality
      expect(preferred.display).toBe('Base English');
    });
  });

  describe('Display checking', () => {
    beforeEach(() => {
      designations.addDesignation(true, 'inactive', 'en', null, 'Exact Match');
      designations.addDesignation(false, 'inactive', 'en', null, 'Case Different');
      designations.addDesignation(false, 'inactive', 'en', null, 'Extra   Whitespace');
      designations.addDesignation(false, 'inactive', 'en', null, 'Inactive Display');
    });

    test('should find exact match', () => {
      const langList = Languages.fromAcceptLanguage('en');
      const result = designations.hasDisplay(langList, null, 'Exact Match', false, DisplayCheckingStyle.EXACT);

      expect(result.found).toBe(true);
      expect(result.difference).toBe(DisplayDifference.None);
    });

    test('should find case insensitive match', () => {
      const langList = Languages.fromAcceptLanguage('en');
      const result = designations.hasDisplay(langList, null, 'case different', false, DisplayCheckingStyle.CASE_INSENSITIVE);

      expect(result.found).toBe(true);
    });

    test('should detect case difference', () => {
      const langList = Languages.fromAcceptLanguage('en');
      const result = designations.hasDisplay(langList, null, 'case different', false, DisplayCheckingStyle.EXACT);

      expect(result.found).toBe(false);
      expect(result.difference).toBe(DisplayDifference.Case);
    });

    test('should find normalized match', () => {
      const langList = Languages.fromAcceptLanguage('en');
      const result = designations.hasDisplay(langList, null, 'Extra Whitespace', false, DisplayCheckingStyle.NORMALISED);

      expect(result.found).toBe(true);
    });

    test('should detect normalized difference', () => {
      const langList = Languages.fromAcceptLanguage('en');
      const result = designations.hasDisplay(langList, null, 'Extra Whitespace', false, DisplayCheckingStyle.EXACT);

      expect(result.found).toBe(false);
      expect(result.difference).toBe(DisplayDifference.Normalized);
    });

    test('should respect active flag', () => {
      const langList = Languages.fromAcceptLanguage('en');
      const result = designations.hasDisplay(langList, null, 'Inactive Display', true, DisplayCheckingStyle.EXACT);

      expect(result.found).toBe(false);
    });

    test('should ignore active flag when false', () => {
      const langList = Languages.fromAcceptLanguage('en');
      const result = designations.hasDisplay(langList, null, 'Inactive Display', false, DisplayCheckingStyle.EXACT);

      expect(result.found).toBe(true);
    });
  });

  describe('Display counting and presentation', () => {
    beforeEach(() => {
      designations.addDesignation(true, 'inactive', 'en', null, 'English base');
      designations.addDesignation(false, 'active', 'en-US', null, 'US English display');
      designations.addDesignation(false, 'inactive', 'fr', null, 'French term');
      designations.addDesignation(false, 'inactive', 'de-DE', null, 'German term');
    });

    test('should count displays correctly', () => {
      const langList = Languages.fromAcceptLanguage('en-US,en;q=0.9');
      const count = designations.displayCount(langList, null, false);

      expect(count).toBe(2); // en and en-US should match
    });

    test('should count display-only designations', () => {
      const langList = Languages.fromAcceptLanguage('en-US,en;q=0.9');
      const count = designations.displayCount(langList, null, true);

      expect(count).toBe(2); // base + display designation both count
    });

    test('should present designations with language codes', () => {
      const langList = Languages.fromAcceptLanguage('en,fr;q=0.8');
      const presentation = designations.present(langList, null, false);

      expect(presentation).toContain("'English base' (en)");
      expect(presentation).toContain("'French term' (fr)");
      expect(presentation).toContain(' or ');
    });

    test('should fall back to all designations when no language match', () => {
      const langList = Languages.fromAcceptLanguage('zh');
      const presentation = designations.present(langList, null, false);

      // Should include all designations since no Chinese match
      expect(presentation).toContain("'English base'");
      expect(presentation).toContain("'French term'");
      expect(presentation).toContain("'German term'");
    });
  });

  describe('Complex language preference scenarios', () => {
    beforeEach(() => {
      // Create complex scenario with multiple language variants
      designations.addDesignation(true, 'inactive', 'en', null, 'Base English');
      designations.addDesignation(false, 'active', 'en', null, 'English Display');
      designations.addDesignation(true, 'inactive', 'en-US', null, 'Base US English');
      designations.addDesignation(false, 'active', 'en-US', DesignationUse.PREFERRED, 'US English Display');
      designations.addDesignation(false, 'inactive', 'en-GB', null, 'British English');
      designations.addDesignation(false, 'inactive', 'fr-CA', null, 'Canadian French');
      designations.addDesignation(false, 'inactive', 'fr', null, 'French');
    });

    test('should prefer base over display for exact match', () => {
      const langList = Languages.fromAcceptLanguage('en-US');
      designations.designations[0].status = 'active';
      designations.designations[2].status = 'active';
      const preferred = designations.preferredDesignation(langList);

      expect(preferred.display).toBe('Base US English');
      expect(designations.isDisplay(preferred)).toBe(true);
    });

    test('should fall back to language-region match', () => {
      const langList = Languages.fromAcceptLanguage('en-AU'); // Australian English not in designations
      designations.designations[0].status = 'active';
      const preferred = designations.preferredDesignation(langList);

      // Should fall back to base English
      expect(preferred.display).toBe('Base English');
    });

    test('should handle multiple language preferences in order', () => {
      const langList = Languages.fromAcceptLanguage('de,fr;q=0.8,en;q=0.6');
      const preferred = designations.preferredDesignation(langList);

      // Should pick French since German not available
      expect(preferred.display).toBe('French');
    });

    test('should handle complex regional fallback', () => {
      const langList = Languages.fromAcceptLanguage('fr-FR,fr;q=0.9');
      const preferred = designations.preferredDesignation(langList);

      // Should find French designation
      expect(preferred.display).toBe('Canadian French');
    });
  });

  describe('SearchFilterText integration', () => {
    let searchFilter;

    beforeEach(() => {
      designations.addDesignation(true, 'inactive', 'en', null, 'Blood pressure measurement');
      designations.addDesignation(false, 'inactive', 'en', null, 'Systolic pressure reading');
      designations.addDesignation(false, 'inactive', 'fr', null, 'Mesure de pression artérielle');
      designations.addDesignation(false, 'inactive', 'de', null, 'Blutdruckmessung');

      searchFilter = new SearchFilterText('pressure');
    });

    test('should filter designations by text', () => {
      const passes = searchFilter.passesDesignations(designations);
      expect(passes).toBe(true);
    });

    test('should not match when filter does not apply', () => {
      const noMatchFilter = new SearchFilterText('temperature');
      const passes = noMatchFilter.passesDesignations(designations);
      expect(passes).toBe(false);
    });

    test('should handle empty filter', () => {
      const emptyFilter = new SearchFilterText('');
      expect(emptyFilter.isNull).toBe(true);

      const passes = emptyFilter.passesDesignations(designations);
      expect(passes).toBe(true);
    });

    test('empty filter passes() matches every value (was broken by this.null typo)', () => {
      const emptyFilter = new SearchFilterText('');
      expect(emptyFilter.passes('anything at all')).toBe(true);
      expect(emptyFilter.passes('')).toBe(true);
      expect(emptyFilter.passes('Blood pressure measurement', true)).toEqual({ passes: true, rating: 0 });
    });

    test('should return rating for matches', () => {
      const result = searchFilter.passes('Blood pressure measurement', true);
      expect(result.passes).toBe(true);
      expect(result.rating).toBeGreaterThan(0);
    });

    test('should match stems correctly', () => {
      const stems = ['pressure', 'blood', 'measure'];
      const score = searchFilter.matches(stems);
      expect(score).toBeGreaterThan(0);
    });
  });

  describe('Edge cases and error handling', () => {
    test('should handle null language definitions gracefully', () => {
      const result = designations.addDesignation(true, 'inactive', 'invalid-lang', null, 'Test');
      expect(result.language).toBeNull();
    });

    test('should handle empty language list', () => {
      designations.addDesignation(true, 'inactive', 'en', null, 'Test');
      const preferred = designations.preferredDesignation(new Languages());

      expect(preferred.display).toBe('Test');
    });

    test('should handle missing value in designation', () => {
      const designation = new Designation();
      designation.value = null;

      expect(designation.display).toBe('');
      expect(designation.present()).toContain('""');
    });

    test('should handle complex use coding in present()', () => {
      const designation = new Designation();
      designation.value = 'Test';
      designation.language = languageDefinitions.parse('en-US');
      designation.use = { system: 'http://example.com', code: 'test-use', display: 'Test Use' };

      const presentation = designation.present();
      expect(presentation).toContain('"Test"');
      expect(presentation).toContain('(en-US/Test Use)');
    });
  });

  describe('Display difference detection', () => {
    beforeEach(() => {
      designations.addDesignation(true, 'inactive', 'en', null, 'Exact Term');
      designations.addDesignation(false, 'inactive', 'en', null, 'Case Term');
      designations.addDesignation(false, 'inactive', 'en', null, 'Spaced   Term');
    });

    test('should detect no difference for exact match', () => {
      const langList = Languages.fromAcceptLanguage('en');
      const result = designations.hasDisplay(langList, null, 'Exact Term', false, DisplayCheckingStyle.EXACT);

      expect(result.found).toBe(true);
      expect(result.difference).toBe(DisplayDifference.None);
    });

    test('should detect case difference', () => {
      const langList = Languages.fromAcceptLanguage('en');
      const result = designations.hasDisplay(langList, null, 'case term', false, DisplayCheckingStyle.EXACT);

      expect(result.found).toBe(false);
      expect(result.difference).toBe(DisplayDifference.Case);
    });

    test('should detect whitespace normalization difference', () => {
      const langList = Languages.fromAcceptLanguage('en');
      const result = designations.hasDisplay(langList, null, 'Spaced Term', false, DisplayCheckingStyle.CASE_INSENSITIVE);

      expect(result.found).toBe(false);
      expect(result.difference).toBe(DisplayDifference.Normalized);
    });

    test('should find match with normalized mode', () => {
      const langList = Languages.fromAcceptLanguage('en');
      const result = designations.hasDisplay(langList, null, 'Spaced Term', false, DisplayCheckingStyle.NORMALISED);

      expect(result.found).toBe(true);
    });
  });

  describe('Multi-language scenarios', () => {
    beforeEach(() => {
      // Complex multi-language setup
      designations.baseLang = languageDefinitions.parse('en');

      designations.addDesignation(true, 'inactive', 'en', null, 'English term');
      designations.addDesignation(false, 'active', 'en-US', null, 'American term');
      designations.addDesignation(false, 'active', 'en-GB', null, 'British term');
      designations.addDesignation(false, 'inactive', 'fr', null, 'Terme français');
      designations.addDesignation(false, 'inactive', 'fr-CA', null, 'Terme canadien');
      designations.addDesignation(false, 'inactive', 'de', null, 'Deutscher Begriff');
      designations.addDesignation(false, 'inactive', 'es-ES', null, 'Término español');
    });

    test('should handle multiple language preferences', () => {
      const langList = Languages.fromAcceptLanguage('de,fr;q=0.8,en;q=0.6');
      const preferred = designations.preferredDesignation(langList);

      expect(preferred.display).toBe('Deutscher Begriff');
    });

    test('should fall back through language hierarchy', () => {
      const langList = Languages.fromAcceptLanguage('es-MX,es;q=0.9,en;q=0.7');
      const preferred = designations.preferredDesignation(langList);

      // Should find Spanish designation (es-ES matches es preference)
      expect(preferred.display).toBe('Término español');
    });

    test('should include designations based on language match', () => {
      const langList = Languages.fromAcceptLanguage('fr-FR,fr;q=0.9');
      const frenchDesignation = designations.designations.find(d => d.language.code === 'fr');

      const included = designations.include(frenchDesignation, langList, null);
      expect(included).toBe(true);
    });

    test('should exclude designations that do not match language', () => {
      const langList = Languages.fromAcceptLanguage('zh');
      const englishDesignation = designations.designations.find(d => d.language.code === 'en');

      const included = designations.include(englishDesignation, langList, null);
      expect(included).toBe(false);
    });
  });

  describe('defLang parameter handling', () => {
    beforeEach(() => {
      designations.addDesignation(true, 'inactive', 'en', null, 'English');
      designations.addDesignation(false, 'inactive', 'en-US', null, 'US English');
      designations.addDesignation(false, 'inactive', 'fr', null, 'French');
    });

    test('should prioritize defLang matches', () => {
      const langList = Languages.fromAcceptLanguage('fr,en;q=0.8');
      const defLang = languageDefinitions.parse('en-US');

      // Even though French has higher priority, en-US should match defLang
      const result = designations.hasDisplay(langList, defLang, 'US English', false, DisplayCheckingStyle.EXACT);
      expect(result.found).toBe(true);
    });

    test('should use defLang in language matching', () => {
      const langList = Languages.fromAcceptLanguage('de'); // German not in designations
      const defLang = languageDefinitions.parse('en');

      const count = designations.displayCount(langList, defLang, false);
      expect(count).toBeGreaterThan(0); // Should find English matches due to defLang
    });
  });

  describe('Utility methods', () => {
    beforeEach(() => {
      designations.addDesignation(true, 'inactive', 'en', null, 'First');
      designations.addDesignation(false, 'inactive', 'fr', null, 'Second');
      designations.addDesignation(false, 'inactive', 'de', null, 'Third');
    });

    test('should generate summary', () => {
      const summary = designations.summary();

      expect(summary).toContain('"First"');
      expect(summary).toContain('"Second"');
      expect(summary).toContain('"Third"');
    });

    test('should present self with source info', () => {
      designations.baseLang = languageDefinitions.parse('en-US');
      designations.source = { constructor: { name: 'TestProvider' } };

      const presentation = designations.presentSelf();

      expect(presentation).toBe('Lang: en-US; source: TestProvider');
    });

    test('should handle missing baseLang in presentSelf', () => {
      const presentation = designations.presentSelf();
      expect(presentation).toBe('Lang: ??');
    });

    test('should return preferred display text', () => {
      const langList = Languages.fromAcceptLanguage('fr,en;q=0.8');
      const display = designations.preferredDisplay(langList, null);

      expect(display).toBe('Second'); // French designation
    });

    test('should return empty string when no preferred designation', () => {
      const emptyDesignations = new Designations(languageDefinitions);
      const display = emptyDesignations.preferredDisplay(Languages.fromAcceptLanguage('en'), null);

      expect(display).toBe('');
    });
  });

  describe('Integration with real language data', () => {
    test('should work with actual IETF language codes', () => {
      // Test with some real IETF language codes
      designations.addDesignation(true, 'inactive', 'zh-Hans-CN', null, 'Simplified Chinese');
      designations.addDesignation(false, 'inactive', 'zh-Hant-TW', null, 'Traditional Chinese');
      designations.addDesignation(false, 'inactive', 'pt-BR', null, 'Brazilian Portuguese');
      designations.addDesignation(false, 'inactive', 'pt', null, 'Portuguese');

      const langList = Languages.fromAcceptLanguage('zh-Hans,zh;q=0.9,pt-PT;q=0.8');
      const preferred = designations.preferredDesignation(langList);

      expect(preferred.display).toBe('Simplified Chinese');
    });

    test('should handle script and region fallbacks', () => {
      designations.addDesignation(true, 'inactive', 'sr-Cyrl', null, 'Serbian Cyrillic');
      designations.addDesignation(false, 'inactive', 'sr-Latn', null, 'Serbian Latin');
      designations.addDesignation(false, 'inactive', 'sr', null, 'Serbian');

      const langList = Languages.fromAcceptLanguage('sr-Cyrl-RS');
      const preferred = designations.preferredDesignation(langList);

      expect(preferred.display).toBe('Serbian Cyrillic');
    });
  });

  describe('SearchFilterText standalone', () => {
    test('should create and process filter correctly', () => {
      const filter = new SearchFilterText('blood pressure measurement');

      expect(filter.isNull).toBe(false);
      expect(filter.stems.length).toBeGreaterThan(0);
    });

    test('should handle empty filter', () => {
      const filter = new SearchFilterText('');
      expect(filter.isNull).toBe(true);
    });

    test('should filter text correctly', () => {
      const filter = new SearchFilterText('cardiac');

      expect(filter.passes('cardiac output')).toBe(true);
      expect(filter.passes('blood pressure')).toBe(false);
    });

    test('should handle special characters in filter', () => {
      const filter = new SearchFilterText('heart-rate monitoring');

      expect(filter.passes('heart rate monitoring device')).toBe(true);
      expect(filter.passes('cardiac rhythm')).toBe(false);
    });

    test('passesAll needs every word of the filter, passes only one', () => {
      const filter = new SearchFilterText('serum glucose');

      expect(filter.passes('Cholesterol in Serum')).toBe(true);
      expect(filter.passesAll('Cholesterol in Serum')).toBe(false);
      expect(filter.passesAll('Glucose [Mass/volume] in Serum or Plasma')).toBe(true);
      expect(filter.passesAll('Glucoses, serum')).toBe(true); // stemmed, in any order
      expect(new SearchFilterText('').passesAll('anything')).toBe(true);
    });

    test('should calculate match scores', () => {
      const filter = new SearchFilterText('blood pressure');
      const stems = ['blood', 'pressure', 'measurement'];

      const score = filter.matches(stems);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(100);
    });
  });

  describe('Error scenarios', () => {
    test('should handle malformed language codes gracefully', () => {
      // This should not throw, just return null language
      const result = designations.addDesignation(true, 'inactive', 'nnot-a-valid-lang-code-at-all', null, 'Test');
      expect(result.language).toBeNull();
    });

    test('should handle missing designations in SearchFilterText', () => {
      const filter = new SearchFilterText('test');
      const result = filter.passesDesignations(null);
      expect(result).toBe(false);
    });

    test('should handle designations without values', () => {
      const designation = new Designation();
      designation.value = null;
      designations.designations.push(designation);

      const filter = new SearchFilterText('anything');
      const result = filter.passesDesignations(designations);
      expect(result).toBe(false);
    });
  });

  describe('Parameter validation', () => {
    test('should validate addDesignation parameters', () => {
      expect(() => designations.addDesignation(true, 'inactive')).toThrow('display must be provided');
      expect(() => designations.addDesignation(true, 'inactive', 'en')).toThrow('display must be provided');

      expect(() => designations.addDesignation(false, true, 'en', null, 'test')).toThrow('status must be a string');
      expect(() => designations.addDesignation('not-bool', 'active', 'en', null, 'test')).toThrow('isDisplay must be a boolean');
      expect(() => designations.addDesignation(true, 'inactive', 123, null, 'test')).toThrow('lang must be a string');
      expect(() => designations.addDesignation(true, 'inactive', 'en',null,  123)).toThrow('display must be a string');
    });

    test('should validate addDesignationWithValue parameters', () => {
      const validValue = 'test';

      expect(() => designations.addDesignation(true, 'inactive', 'en')).toThrow('display must be provided');

      expect(() => designations.addDesignation(true, 'inactive', 'en', null, {})).toThrow('display must be a string, but got Object');
      expect(() => designations.addDesignation(true, 'inactive', 'en', null, validValue, 'not-array')).toThrow('extensions must be an array');
    });

    test('should validate hasDisplay parameters', () => {
      const langList = Languages.fromAcceptLanguage('en');

      expect(() => designations.hasDisplay()).toThrow('value must be provided');
      expect(() => designations.hasDisplay(langList, null, 'test')).toThrow('active must be provided');
      expect(() => designations.hasDisplay(langList, null, 'test', true)).toThrow('mode must be provided');

      expect(() => designations.hasDisplay('not-languages', null, 'test', true, DisplayCheckingStyle.EXACT))
        .toThrow('langList must be a valid Languages');
      expect(() => designations.hasDisplay(langList, 'not-language', 'test', true, DisplayCheckingStyle.EXACT))
        .toThrow('defLang must be a valid Language');
      expect(() => designations.hasDisplay(langList, null, 123, true, DisplayCheckingStyle.EXACT))
        .toThrow('value must be a string');
      expect(() => designations.hasDisplay(langList, null, 'test', 'not-bool', DisplayCheckingStyle.EXACT))
        .toThrow('active must be a boolean');
      expect(() => designations.hasDisplay(langList, null, 'test', true, 123))
        .toThrow('mode must be a string');
    });

    test('should validate displayCount parameters', () => {
      expect(() => designations.displayCount()).toThrow('displayOnly must be provided');
      expect(() => designations.displayCount(new Languages(), null, 'not-bool')).toThrow('displayOnly must be a boolean');
    });

    test('should validate present parameters', () => {
      expect(() => designations.present()).toThrow('displayOnly must be provided');
      expect(() => designations.present(new Languages(), null, 'not-bool')).toThrow('displayOnly must be a boolean');
    });

    test('should validate include parameters', () => {
      const designation = new Designation();

      expect(() => designations.include()).toThrow('cd must be provided');
      expect(() => designations.include('not-designation')).toThrow('cd must be a valid Designation');

      // Valid call should not throw
      expect(() => designations.include(designation, new Languages(), null)).not.toThrow();
    });

    test('should validate SearchFilterText constructor', () => {
      expect(() => new SearchFilterText(123)).toThrow('filter must be a string');

      // Valid construction should not throw
      expect(() => new SearchFilterText('test')).not.toThrow();
    });

    test('should validate SearchFilterText.passes parameters', () => {
      const filter = new SearchFilterText('test');

      expect(() => filter.passes()).toThrow('value must be provided');
      expect(() => filter.passes(123)).toThrow('value must be a string');
      expect(() => filter.passes('test', 'not-bool')).toThrow('returnRating must be a boolean');
    });

    test('should validate SearchFilterText.matches parameters', () => {
      const filter = new SearchFilterText('test');

      expect(() => filter.matches('not-array')).toThrow('stems must be a valid Array');

      // Valid calls should not throw
      expect(() => filter.matches(null)).not.toThrow();
      expect(() => filter.matches(['stem1', 'stem2'])).not.toThrow();
    });

    test('should validate addDesignationFromConcept parameters', () => {
      expect(() => designations.addDesignationFromConcept('not-object')).toThrow('concept must be a valid Object, but got String');
    });

  });
});