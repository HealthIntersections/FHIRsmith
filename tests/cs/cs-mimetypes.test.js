const { OperationContext } = require('../../tx/operation-context');
const { MimeTypeServices, MimeTypeServicesFactory, MimeTypeConcept } = require('../../tx/cs/cs-mimetypes');
const { Languages } = require('../../library/languages');
const { CodeSystem } = require('../../tx/library/codesystem');
const {Designations} = require("../../tx/library/designations");
const {TestUtilities} = require("../test-utilities");

describe('MimeTypeServices', () => {
  let factory;
  let provider;
  let opContext;

  beforeEach(async () => {
    opContext = new OperationContext('en', await TestUtilities.loadTranslations());
    factory = new MimeTypeServicesFactory(opContext.i18n);
    provider = factory.build(opContext, []);
  });

  describe('Basic Functionality', () => {
    test('should return correct system URI', () => {
      expect(provider.system()).toBe('urn:ietf:bcp:13');
    });

    test('should return correct description', () => {
      expect(provider.description()).toBe('Mime Types');
    });

    test('should return -1 for total count (unbounded)', () => {
      expect(provider.totalCount()).toBe(-1);
    });

    test('should not have parents', () => {
      expect(provider.hasParents()).toBe(false);
    });

    test('should return empty version', () => {
      expect(provider.version()).toBeNull();
    });

    test('should not have displays by default', () => {
      const languages = Languages.fromAcceptLanguage('en');
      expect(provider.hasAnyDisplays(languages)).toBe(false);
    });
  });

  describe('MIME Type Validation', () => {
    test('should validate common MIME types', async () => {
      const validMimeTypes = [
        'text/plain',
        'text/html',
        'application/json',
        'application/pdf',
        'image/jpeg',
        'image/png',
        'video/mp4',
        'audio/mpeg',
        'multipart/form-data',
        'application/x-www-form-urlencoded',
        'application/octet-stream'
      ];

      for (const mimeType of validMimeTypes) {
        const result = await provider.locate(mimeType);
        expect(result.context).toBeTruthy();
        expect(result.message).toBeNull();
        expect(result.context.code).toBe(mimeType);
      }
    });

    test('should validate MIME types with parameters', async () => {
      const mimeTypesWithParams = [
        'text/html; charset=utf-8',
        'text/plain; charset=iso-8859-1',
        'multipart/form-data; boundary=something',
        'application/json; charset=utf-8'
      ];

      for (const mimeType of mimeTypesWithParams) {
        const result = await provider.locate(mimeType);
        expect(result.context).toBeTruthy();
        expect(result.message).toBeNull();
        expect(result.context.code).toBe(mimeType);
      }
    });

    test('should reject invalid MIME types', async () => {
      const invalidMimeTypes = [
        'text',           // Missing subtype
        'text/',          // Empty subtype
        '/plain',         // Empty type
        'not-a-mime-type', // No slash
        'text//',         // Double slash
        'text/plain/',    // Trailing slash
        '//',             // Just slashes
        'text plain'      // Space instead of slash
      ];

      for (const invalidType of invalidMimeTypes) {
        const result = await provider.locate(invalidType);
        expect(result.context).toBeNull();
        expect(result.message).toBeUndefined();
      }

      const result = await provider.locate('');
      expect(result.context).toBeNull();
      expect(result.message).toContain('Empty code');
    });

    test('should handle whitespace in MIME types', async () => {
      const mimeTypesWithWhitespace = [
        '  text/plain  ',
        '\ttext/html\t',
        '\ntext/css\n',
        ' application/json '
      ];

      for (const mimeType of mimeTypesWithWhitespace) {
        const result = await provider.locate(mimeType);
        expect(result.context).toBeTruthy();
        expect(result.message).toBeNull();
      }
    });
  });

  describe('Code Lookup', () => {
    test('should return correct code for valid MIME types', async () => {
      const testMimeType = 'application/json';
      const result = await provider.locate(testMimeType);
      const code = await provider.code(result.context);
      expect(code).toBe(testMimeType);
    });

    test('should return null for invalid MIME types', async () => {
      await expect(provider.code('invalid-mime-type')).rejects.toThrow("Invalid MIME type 'invalid-mime-type'");
    });

    test('should return correct display (trimmed code)', async () => {
      const testMimeType = '  text/plain  ';
      const result = await provider.locate(testMimeType);
      const display = await provider.display(result.context);
      expect(display).toBe('text/plain');
    });

    test('should throw error for invalid MIME types', async () => {
      await expect(provider.display('invalid')).rejects.toThrow("Invalid MIME type 'invalid'");
    });

    test('should return null definition', async () => {
      const result = await provider.locate('text/plain');
      const definition = await provider.definition(result.context);
      expect(definition).toBeNull();
    });

    test('should return false for abstract, inactive, deprecated', async () => {
      const result = await provider.locate('text/plain');
      expect(await provider.isAbstract(result.context)).toBe(false);
      expect(await provider.isInactive(result.context)).toBe(false);
      expect(await provider.isDeprecated(result.context)).toBe(false);
    });

    test('should return designations with display', async () => {
      const result = await provider.locate('text/plain');
      const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
      await provider.designations(result.context, designations);
      expect(designations).toBeTruthy();

      expect(designations.count).toBeGreaterThan(0);

      const displayDesignation = designations.designations.find(d => d.value === 'text/plain');
      expect(displayDesignation).toBeTruthy();
      expect(displayDesignation.language.code).toBe('en');
    });
  });

  describe('Iterator Functionality - Not Supported', () => {
    test('should create empty iterator', async () => {
      const iterator = await provider.iterator(null);
      expect(iterator).toBe(null);
    });

  });

  describe('Subsumption - Not Supported', () => {
    test('should not support subsumption', async () => {
      expect(await provider.subsumesTest('text/plain', 'text/html')).toBe('not-subsumed');
      expect(await provider.subsumesTest('application/json', 'application/xml')).toBe('not-subsumed');
    });

    test('should return error for locateIsA', async () => {
      const result = await provider.locateIsA('text/plain+fml', 'text/plain');
      expect(result.context).toBeNull();
      expect(result.message).toContain('not supported');
    });
  });

  describe('Factory Functionality', () => {
    test('should track usage count', () => {
      const factory = new MimeTypeServicesFactory(opContext.i18n);
      expect(factory.useCount()).toBe(0);

      factory.build(opContext, []);
      expect(factory.useCount()).toBe(1);

      factory.build(opContext, []);
      expect(factory.useCount()).toBe(2);
    });

    test('should return empty string for default version', () => {
      expect(factory.defaultVersion()).toBeNull();
    });

    test('should build working providers', () => {
      const provider1 = factory.build(opContext, []);
      const provider2 = factory.build(opContext, []);

      expect(provider1).toBeTruthy();
      expect(provider2).toBeTruthy();
      expect(provider1.totalCount()).toBe(provider2.totalCount());
    });

    test('should increment uses on recordUse', () => {
      const factory = new MimeTypeServicesFactory(opContext.i18n);
      expect(factory.useCount()).toBe(0);

      factory.recordUse();
      expect(factory.useCount()).toBe(1);

      factory.recordUse();
      expect(factory.useCount()).toBe(2);
    });
  });

  describe('Specific MIME Type Categories', () => {
    test('should handle text types', async () => {
      const textTypes = [
        'text/plain',
        'text/html',
        'text/css',
        'text/javascript',
        'text/csv',
        'text/xml'
      ];

      for (const mimeType of textTypes) {
        const result = await provider.locate(mimeType);
        expect(result.context).toBeTruthy();
        expect(result.context.mimeType.type).toBe('text');
      }
    });

    test('should handle application types', async () => {
      const applicationTypes = [
        'application/json',
        'application/xml',
        'application/pdf',
        'application/zip',
        'application/octet-stream',
        'application/x-www-form-urlencoded'
      ];

      for (const mimeType of applicationTypes) {
        const result = await provider.locate(mimeType);
        expect(result.context).toBeTruthy();
        expect(result.context.mimeType.type).toBe('application');
      }
    });

    test('should handle image types', async () => {
      const imageTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/svg+xml',
        'image/webp',
        'image/bmp'
      ];

      for (const mimeType of imageTypes) {
        const result = await provider.locate(mimeType);
        expect(result.context).toBeTruthy();
        expect(result.context.mimeType.type).toBe('image');
      }
    });

    test('should handle video types', async () => {
      const videoTypes = [
        'video/mp4',
        'video/avi',
        'video/quicktime',
        'video/x-msvideo'
      ];

      for (const mimeType of videoTypes) {
        const result = await provider.locate(mimeType);
        expect(result.context).toBeTruthy();
        expect(result.context.mimeType.type).toBe('video');
      }
    });

    test('should handle audio types', async () => {
      const audioTypes = [
        'audio/mpeg',
        'audio/wav',
        'audio/ogg',
        'audio/mp3'
      ];

      for (const mimeType of audioTypes) {
        const result = await provider.locate(mimeType);
        expect(result.context).toBeTruthy();
        expect(result.context.mimeType.type).toBe('audio');
      }
    });

    test('should handle multipart types', async () => {
      const multipartTypes = [
        'multipart/form-data',
        'multipart/mixed',
        'multipart/alternative'
      ];

      for (const mimeType of multipartTypes) {
        const result = await provider.locate(mimeType);
        expect(result.context).toBeTruthy();
        expect(result.context.mimeType.type).toBe('multipart');
      }
    });
  });

  describe('MIME Type Concept', () => {
    test('should parse valid MIME types correctly', () => {
      const concept = new MimeTypeConcept('text/plain');
      expect(concept.isValid()).toBe(true);
      expect(concept.mimeType.type).toBe('text');
      expect(concept.mimeType.subtype).toBe('plain');
    });

    test('should handle MIME types with parameters', () => {
      const concept = new MimeTypeConcept('text/html; charset=utf-8');
      expect(concept.isValid()).toBe(true);
      expect(concept.mimeType.type).toBe('text');
      expect(concept.mimeType.subtype).toBe('html');
    });

    test('should reject invalid MIME types', () => {
      const invalidConcept = new MimeTypeConcept('invalid');
      expect(invalidConcept.isValid()).toBe(false);
    });
  });

  describe('Error Handling', () => {
    test('should refuse a filter it does not support: 422 not-supported', async () => {
      await expect(provider.filter(await provider.getPrepContext(false), true, 'subtype', '=', 'plain'))
        .rejects.toMatchObject({ cause: 'not-supported', message: 'The filter "subtype = plain" is not understood or supported', msgId: 'FILTER_NOT_UNDERSTOOD', statusCode: 422 });
      await expect(provider.filter(await provider.getPrepContext(false), true, 'base', 'is-a', 'text'))
        .rejects.toMatchObject({ cause: 'not-supported', message: 'The filter "base is-a text" is not understood or supported', msgId: 'FILTER_NOT_UNDERSTOOD', statusCode: 422 });
    });

    test('should handle null operation context', () => {
      expect(() => provider._ensureOpContext(null)).toThrow();
    });

    test('should handle invalid operation context', () => {
      expect(() => provider._ensureOpContext({})).toThrow();
    });

    test('should return null for null code input', async () => {
      const result = await provider.locate(null);
      expect(result.context).toBeNull();
    });

    test('should handle empty code input', async () => {
      const result = await provider.locate('');
      expect(result.context).toBeNull();
      expect(result.message).toBe('Empty code');
    });
  });

  describe('Edge Cases', () => {
    test('should handle repeated lookups correctly', async () => {
      for (let i = 0; i < 5; i++) {
        const result = await provider.locate('application/json');
        expect(result.context).toBeTruthy();
        expect(result.message).toBeNull();

        const display = await provider.display(result.context);
        expect(display).toBe('application/json');
      }
    });

    test('should handle context passing through ensureContext', async () => {
      const result = await provider.locate('text/plain');
      const concept = result.context;

      // Pass concept through ensureContext
      const code1 = await provider.code(concept);
      const display1 = await provider.display(concept);

      expect(code1).toBe('text/plain');
      expect(display1).toBe('text/plain');
    });

    test('should handle string codes through ensureContext', async () => {
      const code = await provider.code('application/pdf');
      const display = await provider.display('application/pdf');

      expect(code).toBe('application/pdf');
      expect(display).toBe('application/pdf');
    });

    test('should handle case sensitivity', async () => {
      // MIME types are case-insensitive for type/subtype but case-sensitive for parameters
      const result1 = await provider.locate('TEXT/PLAIN');
      expect(result1.context).toBeTruthy();

      const result2 = await provider.locate('text/plain');
      expect(result2.context).toBeTruthy();
    });
  });

  describe('Supplement Support', () => {
    test('should work with supplements for display', async () => {
      const supplementData = {
        "resourceType": "CodeSystem",
        "url": "http://example.org/mime-supplement",
        "name": "MimeTypeSupplement",
        "language": "en",
        "status": "active",
        "content": "supplement",
        "supplements": "urn:ietf:bcp:13",
        "concept": [{
          "code": "application/json",
          "display": "JSON Application Data",
          "designation": [{
            "language": "fr",
            "value": "Données JSON"
          }]
        }]
      };

      const supplement = new CodeSystem(supplementData);
      const providerWithSupplement = new MimeTypeServices(new OperationContext(Languages.fromAcceptLanguage('en')), [supplement]);

      const display = await providerWithSupplement.display('application/json');
      expect(display).toBe('JSON Application Data');

      const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
      await providerWithSupplement.designations('application/json', designations);
      expect(designations.count).toBeGreaterThan(1);

      const frenchDesignation = designations.designations.find(d => d.language.code === 'fr');
      expect(frenchDesignation.value).toBe('Données JSON');
    });

    test('should detect displays when supplements are present', () => {
      const supplementData = {
        "resourceType": "CodeSystem",
        "url": "http://example.org/mime-supplement",
        "name": "MimeTypeSupplement",
        "language": "en",
        "status": "active",
        "content": "supplement",
        "supplements": "urn:ietf:bcp:13",
        "concept": [{
          "code": "text/plain",
          "display": "Plain Text"
        }]
      };

      const supplement = new CodeSystem(supplementData);
      const providerWithSupplement = new MimeTypeServices(new OperationContext(new Languages()), [supplement]);

      const languages = Languages.fromAcceptLanguage('en');
      expect(providerWithSupplement.hasAnyDisplays(languages)).toBe(true);
    });
  });

});