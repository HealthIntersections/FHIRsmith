const fs = require('fs');
const path = require('path');

const {CodeSystem} = require('../../tx/library/codesystem');
const {FhirCodeSystemFactory, FhirCodeSystemProvider, FhirCodeSystemProviderContext} = require('../../tx/cs/cs-cs');
const {Languages, Language} = require('../../library/languages');
const {OperationContext} = require("../../tx/operation-context");
const {Designations, SearchFilterText} = require("../../tx/library/designations");
const {TestUtilities} = require("../test-utilities");

describe('FHIR CodeSystem Provider', () => {
  let factory;
  let simpleCS, deCS, extensionsCS, supplementCS;
  let opContext;

  beforeEach(async () => {
    // Initialize factory
    factory = new FhirCodeSystemFactory(await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));

    // Load test CodeSystems
    const simpleData = JSON.parse(fs.readFileSync(path.join(__dirname, '../../tx/data/cs-simple.json'), 'utf8'));
    const deData = JSON.parse(fs.readFileSync(path.join(__dirname, '../../tx/data/cs-de.json'), 'utf8'));
    const extensionsData = JSON.parse(fs.readFileSync(path.join(__dirname, '../../tx/data/cs-extensions.json'), 'utf8'));
    const supplementData = JSON.parse(fs.readFileSync(path.join(__dirname, '../../tx/data/cs-supplement.json'), 'utf8'));

    simpleCS = new CodeSystem(simpleData);
    deCS = new CodeSystem(deData);
    extensionsCS = new CodeSystem(extensionsData);
    supplementCS = new CodeSystem(supplementData);
    opContext = new OperationContext('en-US', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
  });

  describe('Factory', () => {
    test('should have correct default version', () => {
      expect(factory.defaultVersion()).toBe('unknown');
    });

    test('should increment use count', async () => {
      const initialCount = factory.useCount();
      factory.build(opContext, [], simpleCS);
      expect(factory.useCount()).toBe(initialCount + 1);
    });

    test('should validate CodeSystem parameter', () => {
      expect(() => {
        factory.build(opContext, [], null);
      }).toThrow('codeSystem parameter is required and must be a CodeSystem object');

      expect(() => {
        factory.build(opContext, [], {resourceType: 'ValueSet'});
      }).toThrow('codeSystem must be a FHIR CodeSystem resource');
    });

    test('should validate supplements parameter', () => {
      expect(() => {
        factory.build(opContext, 'not-an-array', simpleCS);
      }).toThrow('supplements must be an array');

      expect(() => {
        factory.build(opContext, [{resourceType: 'ValueSet'}], simpleCS);
      }).toThrow('Supplement 0 must be a FHIR CodeSystem resource');
    });

    test('should build provider with supplements', async () => {
      const provider = factory.build(opContext, [supplementCS], extensionsCS);
      expect(provider).toBeInstanceOf(FhirCodeSystemProvider);
      expect(provider.supplements).toHaveLength(1);
    });
  });

  describe('Metadata Methods', () => {
    let simpleProvider, deProvider, extensionsProvider;

    beforeEach(async () => {
      simpleProvider = factory.build(opContext, [], simpleCS);
      deProvider = factory.build(new OperationContext('de-DE', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions())), [], deCS);
      extensionsProvider = factory.build(opContext, [supplementCS], extensionsCS);
    });

    describe('name()', () => {
      test('should return name for simple CodeSystem', () => {
        expect(simpleProvider.name()).toBe('SimpleTestCodeSystem');
      });

    });

    describe('system()', () => {
      test('should return correct system URI', () => {
        expect(simpleProvider.system()).toBe('http://hl7.org/fhir/test/CodeSystem/simple');
        expect(deProvider.system()).toBe('http://hl7.org/fhir/test/CodeSystem/de-multi');
        expect(extensionsProvider.system()).toBe('http://hl7.org/fhir/test/CodeSystem/extensions');
      });
    });

    describe('version()', () => {
      test('should return version when present', () => {
        expect(simpleProvider.version()).toBe('0.1.0');
      });

      test('should return null when version is missing', () => {
        expect(deProvider.version()).toBeNull();
      });
    });

    describe('defLang()', () => {
      test('should return English for English CodeSystem', () => {
        expect(simpleProvider.defLang()).toBe('en');
      });

      test('should return German for German CodeSystem', () => {
        expect(deProvider.defLang()).toBe('de');
      });

      test('should default to en when no language specified', async () => {
        const noLangData = {...simpleCS.jsonObj};
        delete noLangData.language;
        const noLangCS = new CodeSystem(noLangData);
        const noLangProvider = factory.build(opContext, [], noLangCS);
        expect(noLangProvider.defLang()).toBe('en');
      });
    });

    describe('contentMode()', () => {
      test('should return complete for complete CodeSystem', () => {
        expect(simpleProvider.contentMode()).toBe('complete');
      });

      test('should return supplement for supplement CodeSystem', async () => {
        const supplementProvider = factory.build(opContext, [], supplementCS);
        expect(supplementProvider.contentMode()).toBe('supplement');
      });
    });

    describe('description()', () => {
      test('should return title when description missing', () => {
        expect(simpleProvider.description()).toBe('Simple Test Code System');
        expect(deProvider.description()).toBe('Testcodesystem mit mehreren Sprachen');
      });
    });

    describe('sourcePackage()', () => {
      test('should return null for FHIR CodeSystems', () => {
        expect(simpleProvider.sourcePackage()).toBeNull();
      });
    });

    describe('totalCount()', () => {
      test('should return correct concept count', () => {
        expect(simpleProvider.totalCount()).toBe(7);
        expect(deProvider.totalCount()).toBe(7);
        expect(extensionsProvider.totalCount()).toBe(6);
      });
    });

    describe('propertyDefinitions()', () => {
      test('should return null when no properties defined', () => {
        expect(deProvider.propertyDefinitions()).toBeNull();
      });

      test('should return property definitions when present', () => {
        const simpleProps = simpleProvider.propertyDefinitions();
        expect(simpleProps).toBeInstanceOf(Array);
        expect(simpleProps).toHaveLength(3);

        const propCodes = simpleProps.map(p => p.code);
        expect(propCodes).toContain('prop');
        expect(propCodes).toContain('status');
        expect(propCodes).toContain('notSelectable');
      });

      test('should return property definitions for extensions CodeSystem', () => {
        const extensionsProps = extensionsProvider.propertyDefinitions();
        expect(extensionsProps).toBeInstanceOf(Array);
        expect(extensionsProps).toHaveLength(2);

        const propCodes = extensionsProps.map(p => p.code);
        expect(propCodes).toContain('prop');
        expect(propCodes).toContain('alternateCode');
      });
    });

    describe('hasAnyDisplays()', () => {
      test('should return true for English when language is English', () => {
        const langs = Languages.fromAcceptLanguage('en-US', opContext.i18n.languageDefinitions);
        expect(simpleProvider.hasAnyDisplays(langs)).toBe(true);
      });

      test('should return true for German when CodeSystem has German displays', () => {
        const langs = Languages.fromAcceptLanguage('de', opContext.i18n.languageDefinitions);
        expect(deProvider.hasAnyDisplays(langs)).toBe(true);
      });

      test('should return true for Swiss German when CodeSystem has Swiss German displays', () => {
        const langs = Languages.fromAcceptLanguage('de-CH', opContext.i18n.languageDefinitions);
        expect(deProvider.hasAnyDisplays(langs)).toBe(true);
      });

      test('should return false for German German when CodeSystem has only German displays', () => {
        const langs = Languages.fromAcceptLanguage('de-DE', opContext.i18n.languageDefinitions);
        expect(deProvider.hasAnyDisplays(langs)).toBe(false);
      });

      test('should return true when CodeSystem has designations in requested language', () => {
        const langs = Languages.fromAcceptLanguage('es', opContext.i18n.languageDefinitions);
        expect(deProvider.hasAnyDisplays(langs)).toBe(true);
      });

      test('should return false when no matching language found', () => {
        const langs = Languages.fromAcceptLanguage('zh-CN', opContext.i18n.languageDefinitions);
        expect(simpleProvider.hasAnyDisplays(langs)).toBe(false);
      });

      test('should return true when supplements have matching displays', () => {
        const langs = Languages.fromAcceptLanguage('nl', opContext.i18n.languageDefinitions);
        expect(extensionsProvider.hasAnyDisplays(langs)).toBe(true);
      });
    });

    describe('hasParents()', () => {
      test('should return true for CodeSystem with hierarchy', () => {
        expect(simpleProvider.hasParents()).toBe(true);
        expect(deProvider.hasParents()).toBe(true);
      });

      test('should return false for CodeSystem without hierarchy', () => {
        expect(extensionsProvider.hasParents()).toBe(false);
      });
    });

    describe('versionIsMoreDetailed()', () => {
      test('should return false for null/empty versions', () => {
        expect(simpleProvider.versionIsMoreDetailed(null, '1.0')).toBe(false);
        expect(simpleProvider.versionIsMoreDetailed('1.0', null)).toBe(false);
      });
    });

    describe('status()', () => {
      test('should return status information when present', () => {
        const status = simpleProvider.status();
        expect(status).toBeDefined();
        expect(status.status).toBe('active');
        expect(status.experimental).toBe(false);
      });

      test('should return null when status missing', async () => {
        // Create a CodeSystem without status
        const noStatusData = {...simpleCS.jsonObj};
        delete noStatusData.status;
        const noStatusCS = new CodeSystem(noStatusData);
        const noStatusProvider = factory.build(opContext, [], noStatusCS);
        expect(noStatusProvider.status()).toBeDefined()
      });

      test('should handle experimental flag', () => {
        const status = deProvider.status();
        expect(status).toBeDefined();
        expect(status.status).toBe('active');
        expect(status.experimental).toBe(false);
      });
    });
  });

  describe('Core Concept Methods',  () => {
    let simpleProvider;

    beforeEach(async () => {
      simpleProvider = factory.build(opContext, [], simpleCS);
    });

    describe('locate()', () => {
      test('should locate existing code', async () => {
        const result = await simpleProvider.locate('code1');
        expect(result.context).toBeDefined();
        expect(result.context).toBeInstanceOf(FhirCodeSystemProviderContext);
        expect(result.context.code).toBe('code1');
        expect(result.message).toBeNull();
      });

      test('should locate nested code', async () => {
        const result = await simpleProvider.locate('code2a');
        expect(result.context).toBeDefined();
        expect(result.context.code).toBe('code2a');
        expect(result.message).toBeNull();
      });

      test('should return null for non-existent code', async () => {
        const result = await simpleProvider.locate('nonexistent');
        expect(result.context).toBeNull();
        expect(result.message).toBeUndefined();
      });

      test('should handle empty code', async () => {
        const result = await simpleProvider.locate('');
        expect(result.context).toBeNull();
        expect(result.message).toContain('Empty or invalid code');
      });

      test('should handle null code', async () => {
        const result = await simpleProvider.locate(null);
        expect(result.context).toBeNull();
        expect(result.message).toContain('Empty or invalid code');
      });
    });

    describe('code()', () => {
      test('should return code from string input', async () => {
        const code = await simpleProvider.code('code1');
        expect(code).toBe('code1');
      });

      test('should return code from context input', async () => {
        const locateResult = await simpleProvider.locate('code2');
        const code = await simpleProvider.code(locateResult.context);
        expect(code).toBe('code2');
      });

      test('should return null for non-existent code', async () => {
        await expect(simpleProvider.code('nonexistent'))
          .rejects.toThrow('not found');
      });

      test('should throw error for invalid context type', async () => {
        await expect(simpleProvider.code({invalid: 'object'}))
          .rejects.toThrow('Unknown Type at #ensureContext');
      });
    });
  });

  describe('status()',  () => {
    let simpleProvider, deProvider;

    beforeEach(async () => {
      simpleProvider = factory.build(opContext, [], simpleCS);
      deProvider = factory.build(opContext, [], deCS);
    });

    test('should return status information when present', () => {
      const status = simpleProvider.status();
      expect(status).toBeDefined();
      expect(status.status).toBe('active');
      expect(status.experimental).toBe(false);
    });

    test('should return null when status missing', async () => {
      // Create a CodeSystem without status
      const noStatusData = {...simpleCS.jsonObj};
      delete noStatusData.status;
      const noStatusCS = new CodeSystem(noStatusData);
      const noStatusProvider = factory.build(opContext, [], noStatusCS);
      expect(noStatusProvider.status()).toBeDefined();
      expect(noStatusProvider.status().status).toBeUndefined();
    });

    test('should handle experimental flag', () => {
      const status = deProvider.status();
      expect(status).toBeDefined();
      expect(status.status).toBe('active');
      expect(status.experimental).toBe(false);
    });
  });

  describe('Core Concept Methods', () => {
    let simpleProvider;

    beforeEach(async () => {
      simpleProvider = factory.build(opContext, [], simpleCS);
    });

    describe('locate()', () => {
      test('should locate existing code', async () => {
        const result = await simpleProvider.locate('code1');
        expect(result.context).toBeDefined();
        expect(result.context).toBeInstanceOf(FhirCodeSystemProviderContext);
        expect(result.context.code).toBe('code1');
        expect(result.message).toBeNull();
      });

      test('should locate nested code', async () => {
        const result = await simpleProvider.locate('code2a');
        expect(result.context).toBeDefined();
        expect(result.context.code).toBe('code2a');
        expect(result.message).toBeNull();
      });

      test('should return null for non-existent code', async () => {
        const result = await simpleProvider.locate('nonexistent');
        expect(result.context).toBeNull();
        expect(result.message).toBeUndefined();
      });

      test('should handle empty code', async () => {
        const result = await simpleProvider.locate('');
        expect(result.context).toBeNull();
        expect(result.message).toContain('Empty or invalid code');
      });

      test('should handle null code', async () => {
        const result = await simpleProvider.locate(null);
        expect(result.context).toBeNull();
        expect(result.message).toContain('Empty or invalid code');
      });
    });

    describe('code()', () => {
      test('should return code from string input', async () => {
        const code = await simpleProvider.code('code1');
        expect(code).toBe('code1');
      });

      test('should return code from context input', async () => {
        const locateResult = await simpleProvider.locate('code2');
        const code = await simpleProvider.code(locateResult.context);
        expect(code).toBe('code2');
      });

      test('should return null for non-existent code', async () => {
        await expect(simpleProvider.code('nonexistent'))
          .rejects.toThrow('not found');
      });

      test('should throw error for invalid context type', async () => {
        await expect(simpleProvider.code({invalid: 'object'}))
          .rejects.toThrow('Unknown Type at #ensureContext');
      });
    });
  });

  describe('Language and Display Features', () => {
    let deProvider;

    beforeEach(() => {
      deProvider = factory.build(new OperationContext('de-DE', opContext.i18n), [], deCS);
    });

    test('should correctly parse German language', () => {
      const lang = deCS.langCode();
      expect(lang).toBeInstanceOf(Language);
      expect(lang.language).toBe('de');
    });

    test('should detect hierarchy in nested concepts', () => {
      expect(deProvider.hasParents()).toBe(true);

      const children = deCS.getChildren('code2');
      expect(children).toContain('code2a');
      expect(children).toContain('code2b');

      const grandchildren = deCS.getChildren('code2a');
      expect(grandchildren).toContain('code2aI');
      expect(grandchildren).toContain('code2aII');
    });

    test('should handle multilingual designations correctly', () => {
      const langs = Languages.fromAcceptLanguage('es,en;q=0.8', opContext.i18n.languageDefinitions);
      expect(deProvider.hasAnyDisplays(langs)).toBe(true);
    });
  });

  describe('Supplement Integration', () => {
    let extensionsProvider;

    beforeEach(async () => {
      extensionsProvider = factory.build(opContext, [supplementCS], extensionsCS);
    });

    test('should include supplement in provider', () => {
      expect(extensionsProvider.supplements).toHaveLength(1);
      expect(extensionsProvider.supplements[0]).toBe(supplementCS);
    });

    test('should detect supplement displays', () => {
      const langs = Languages.fromAcceptLanguage('nl', opContext.i18n.languageDefinitions);
      expect(extensionsProvider.hasAnyDisplays(langs)).toBe(true);
    });

    test('should handle supplement URL matching', () => {
      expect(extensionsProvider.hasSupplement('http://hl7.org/fhir/test/CodeSystem/supplement')).toBe(true);
      expect(extensionsProvider.hasSupplement('http://example.com/unknown')).toBe(false);
    });

    test('should list supplements correctly', () => {
      const supplements = extensionsProvider.listSupplements();
      expect(supplements).toHaveLength(1);
      expect(supplements[0]).toBe('http://hl7.org/fhir/test/CodeSystem/supplement|0.1.1');
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid CodeSystem gracefully', () => {
      const invalidData = {
        resourceType: 'CodeSystem'
        // Missing required fields
      };

      expect(() => {
        new CodeSystem(invalidData);
      }).toThrow('Invalid CodeSystem');
    });

    test('should validate concept structure', () => {
      const invalidConcepts = {
        resourceType: 'CodeSystem',
        url: 'http://example.com/test',
        name: 'Test',
        status: 'active',
        content: 'complete',
        concept: [
          {
            // Missing required code field
            display: 'Test Display'
          }
        ]
      };

      expect(() => {
        new CodeSystem(invalidConcepts);
      }).toThrow('code is required');
    });
  });

  describe('CodeSystem Class Extensions', () => {
    test('should correctly implement language() method', () => {
      const lang = simpleCS.langCode();
      expect(lang).toBeInstanceOf(Language);
      expect(lang.language).toBe('en');
    });

    test('should correctly implement content method', () => {
      expect(simpleCS.content).toBe('complete');
      expect(supplementCS.content).toBe('supplement');
    });

    test('should correctly implement hasHierarchy() method', () => {
      expect(simpleCS.hasHierarchy()).toBe(true);
      expect(extensionsCS.hasHierarchy()).toBe(false);
    });

    test('should handle missing language gracefully', () => {
      const noLangData = {...simpleCS.jsonObj};
      delete noLangData.language;
      const noLangCS = new CodeSystem(noLangData);
      expect(noLangCS.langCode()).toBeNull();
    });
  });

  describe('Real World Scenarios', () => {

    test('should handle complex multilingual CodeSystem', () => {
      const provider = factory.build(new OperationContext('en-US,de;q=0.8,es;q=0.6', opContext.i18n), [], deCS);

      const langs = Languages.fromAcceptLanguage('en-US,de;q=0.8,es;q=0.6', opContext.i18n.languageDefinitions);
      expect(provider.hasAnyDisplays(langs)).toBe(true);
      expect(provider.hasParents()).toBe(true);
      expect(provider.totalCount()).toBe(7);
    });

    test('should handle extension-based CodeSystem with supplements', async () => {
      const provider = factory.build(opContext, [supplementCS], extensionsCS);

      expect(provider.system()).toBe('http://hl7.org/fhir/test/CodeSystem/extensions');
      expect(provider.supplements).toHaveLength(1);

      const props = provider.propertyDefinitions();
      expect(props).toHaveLength(2);

      const nlLangs = Languages.fromAcceptLanguage('nl', opContext.i18n.languageDefinitions);
      expect(provider.hasAnyDisplays(nlLangs)).toBe(true);
    });
  });

  describe('functional tests', () => {
    let simpleProvider;

    beforeEach(async () => {
      let languageDefinitions = await TestUtilities.loadLanguageDefinitions();
      let i18n = await TestUtilities.loadTranslations(languageDefinitions);
      simpleProvider = factory.build(new OperationContext('en-US', i18n), [], simpleCS);
    });

    describe('display()', () => {

      test('should return display for code', async () => {
        const display = await simpleProvider.display('code1');
        expect(display).toBe('Display 1');
      });

      test('should return display for context', async () => {
        const locateResult = await simpleProvider.locate('code2');
        const display = await simpleProvider.display(locateResult.context);
        expect(display).toBe('Display 2');
      });

      test('should throw error for non-existent code', async () => {
        await expect(simpleProvider.display('nonexistent'))
          .rejects.toThrow('not found');
      });

      test('should handle language-specific displays', async () => {
        const deProvider = factory.build(new OperationContext('de-DE', opContext.i18n), [], deCS);
        const display = await deProvider.display('code1');
        expect(display).toBe('Anzeige 1');
      });

      test('should handle designation-based displays', async () => {
        const deProvider = factory.build(new OperationContext('es', opContext.i18n), [], deCS);
        const display = await deProvider.display('code2');
        expect(display).toBe('Mostrar 2');
      });
    });

    describe('definition()', () => {
      test('should return definition when present', async () => {
        const definition = await simpleProvider.definition('code1');
        expect(definition).toBe('My first code');
      });

      test('should return null for code without definition', async () => {
        // Test with code that might not have definition
        const definition = await simpleProvider.definition('code1');
        expect(typeof definition).toBe('string'); // Should have definition
      });
    });

    describe('isAbstract()', () => {
      test('should return false for concrete concepts', async () => {
        const isAbstract = await simpleProvider.isAbstract('code1');
        expect(isAbstract).toBe(false);
      });

      test('should return true for abstract concepts', async () => {
        // code2 has notSelectable=true property
        const isAbstract = await simpleProvider.isAbstract('code2');
        expect(isAbstract).toBe(true);
      });
    });

    describe('isInactive()', () => {
      test('should return false for active concepts', async () => {
        const isInactive = await simpleProvider.isInactive('code1');
        expect(isInactive).toBe(false);
      });
    });

    describe('isDeprecated()', () => {
      test('should return false for active concepts', async () => {
        const isDeprecated = await simpleProvider.isDeprecated('code1');
        expect(isDeprecated).toBe(false);
      });

      test('should return true for retired concepts', async () => {
        // code2 has status=retired property
        const isDeprecated = await simpleProvider.isDeprecated('code2');
        expect(isDeprecated).toBe(true);
      });
    });

    describe('getStatus()', () => {
      test('should return null for concepts without status', async () => {
        const status = await simpleProvider.getStatus('code1');
        expect(status).toBeNull();
      });

      test('should return status when present', async () => {
        // code2 has status=retired property
        const status = await simpleProvider.getStatus('code2');
        expect(status).toBe('retired');
      });
    });

    describe('itemWeight()', () => {
      test('should return null for concepts without itemWeight', async () => {
        const weight = await simpleProvider.itemWeight('code1');
        expect(weight).toBeNull();
      });

      test('should return itemWeight from supplement', async () => {
        const extensionsProvider = factory.build(opContext, [supplementCS], extensionsCS);
        const weight = await extensionsProvider.itemWeight('code1');
        expect(weight).toBe(1.2);
      });
    });

    describe('designations()', () => {
      test('should return designations for code with display', async () => {
        const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
        await simpleProvider.designations('code1', designations);

        expect(designations).toBeDefined();
        expect(designations.count).toBeGreaterThan(0);

        // Should have at least the main display
        const displayDesignation = designations.designations.find(d => d.value === 'Display 1');
        expect(displayDesignation).toBeDefined();
      });

      test('should return designations from concept designations', async () => {
        const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
        await simpleProvider.designations('code1', designations);

        expect(designations).toBeDefined();

        // Should include the olde-english designation
        const oldeEnglish = designations.designations.find(d => d.value === 'mine own first code');
        expect(oldeEnglish).toBeDefined();
      });

      test('should include supplement designations', async () => {
        const extensionsProvider = factory.build(opContext, [supplementCS], extensionsCS);
        const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
        await extensionsProvider.designations('code1', designations);

        expect(designations).toBeDefined();

        // Should include Dutch designation from supplement
        const dutchDesignation = designations.designations.find(d => d.value === 'ectenoot');
        expect(dutchDesignation).toBeDefined();
        expect(dutchDesignation.language.code).toBe('nl');
      });

      test('should return null for non-existent code', async () => {
        await expect(simpleProvider.designations('nonexistent'))
          .rejects.toThrow('not found');
      });
    });

    describe('extensions()', () => {
      test('should return null for concepts without extensions', async () => {
        const extensions = await simpleProvider.extensions('code1');
        expect(extensions).toBeNull();
      });

      test('should return extensions when present', async () => {
        const extensionsProvider = factory.build(opContext, [], extensionsCS);
        const extensions = await extensionsProvider.extensions('code1');
        expect(extensions).toBeDefined();
        expect(Array.isArray(extensions)).toBe(true);

        // Should have the conceptOrder extension
        const orderExt = extensions.find(ext =>
          ext.url === 'http://hl7.org/fhir/StructureDefinition/codesystem-conceptOrder'
        );
        expect(orderExt).toBeDefined();
        expect(orderExt.valueInteger).toBe(6);
      });

      test('should include supplement extensions', async () => {
        const extensionsProvider = factory.build(opContext, [supplementCS], extensionsCS);
        const extensions = await extensionsProvider.extensions('code1');
        expect(extensions).toBeDefined();

        // Should include itemWeight extension from supplement
        const itemWeightExt = extensions.find(ext =>
          ext.url === 'http://hl7.org/fhir/StructureDefinition/itemWeight'
        );
        expect(itemWeightExt).toBeDefined();
        expect(itemWeightExt.valueDecimal).toBe(1.2);
      });
    });

    describe('properties()', () => {
      test('should return null for concepts without properties', async () => {
        const properties = await simpleProvider.properties('code3');
        expect(properties).toBeDefined();
        expect(Array.isArray(properties)).toBe(true);

        // Should have at least the 'prop' property
        const propProperty = properties.find(p => p.code === 'prop');
        expect(propProperty).toBeDefined();
      });

      test('should return properties when present', async () => {
        const properties = await simpleProvider.properties('code1');
        expect(properties).toBeDefined();
        expect(Array.isArray(properties)).toBe(true);

        // Should have the 'prop' property with value 'old'
        const propProperty = properties.find(p => p.code === 'prop');
        expect(propProperty).toBeDefined();
        expect(propProperty.valueCode).toBe('old');
      });

      test('should return multiple properties', async () => {
        const properties = await simpleProvider.properties('code2');
        expect(properties).toBeDefined();
        expect(Array.isArray(properties)).toBe(true);
        expect(properties.length).toBeGreaterThan(1);

        // Should have prop, notSelectable, and status properties
        const propCodes = properties.map(p => p.code);
        expect(propCodes).toContain('prop');
        expect(propCodes).toContain('notSelectable');
        expect(propCodes).toContain('status');
      });

      test('should include supplement properties', async () => {
        const extensionsProvider = factory.build(opContext, [supplementCS], extensionsCS);
        const properties = await extensionsProvider.properties('code1');

        // Extensions CS code1 should have properties, but supplements don't add properties in our test data
        // This test mainly ensures the method doesn't break with supplements
        expect(properties).toBeDefined();
      });
    });

    describe('parent()', () => {
      test('should return null for root concepts', async () => {
        const parent = await simpleProvider.parent('code1');
        expect(parent).toBeNull();
      });

      test('should return parent for child concepts', async () => {
        const parent = await simpleProvider.parent('code2a');
        expect(parent).toBe('code2');
      });

      test('should return parent for grandchild concepts', async () => {
        const parent = await simpleProvider.parent('code2aI');
        expect(parent).toBe('code2a');
      });

      test('should return null for non-existent code', async () => {
        await expect(simpleProvider.parent('nonexistent'))
          .rejects.toThrow('not found');
      });
    });

    describe('sameConcept()', () => {
      test('should return true for same code', async () => {
        const same = await simpleProvider.sameConcept('code1', 'code1');
        expect(same).toBe(true);
      });

      test('should return false for different codes', async () => {
        const same = await simpleProvider.sameConcept('code1', 'code2');
        expect(same).toBe(false);
      });

      test('should work with context objects', async () => {
        const locateResult1 = await simpleProvider.locate('code1');
        const locateResult2 = await simpleProvider.locate('code1');
        const same = await simpleProvider.sameConcept(locateResult1.context, locateResult2.context);
        expect(same).toBe(true);
      });

      test('should return false for non-existent codes', async () => {
        await expect(simpleProvider.sameConcept('nonexistent', 'code1'))
          .rejects.toThrow('not found');
      });
    });

    describe('locateIsA()', () => {
      test('should find child in parent relationship', async () => {
        const result = await simpleProvider.locateIsA('code2a', 'code2');
        expect(result.context).toBeDefined();
        expect(result.context.code).toBe('code2a');
        expect(result.message).toBeNull();
      });

      test('should find grandchild in grandparent relationship', async () => {
        const result = await simpleProvider.locateIsA('code2aI', 'code2');
        expect(result.context).toBeDefined();
        expect(result.context.code).toBe('code2aI');
        expect(result.message).toBeNull();
      });

      test('should return null for non-descendant relationship', async () => {
        const result = await simpleProvider.locateIsA('code1', 'code2');
        expect(result.context).toBeNull();
        expect(result.message).toContain('not a descendant');
      });

      test('should handle same code when allowed', async () => {
        const result = await simpleProvider.locateIsA('code2', 'code2', false);
        expect(result.context).toBeDefined();
        expect(result.context.code).toBe('code2');
      });

      test('should reject same code when disallowed', async () => {
        const result = await simpleProvider.locateIsA('code2', 'code2', true);
        expect(result.context).toBeNull();
        expect(result.message).toContain('cannot be the same');
      });

      test('should return error message for CodeSystem without hierarchy', async () => {
        const extensionsProvider = factory.build(opContext, [], extensionsCS);
        const result = await extensionsProvider.locateIsA('code1', 'code2');
        expect(result.context).toBeNull();
        expect(result.message).toContain('does not have parents');
      });
    });

    describe('subsumesTest()', () => {
      test('should return equivalent for same code', async () => {
        const result = await simpleProvider.subsumesTest('code1', 'code1');
        expect(result).toBe('equivalent');
      });

      test('should return subsumes for parent-child relationship', async () => {
        const result = await simpleProvider.subsumesTest('code2', 'code2a');
        expect(result).toBe('subsumes');
      });

      test('should return subsumed-by for child-parent relationship', async () => {
        const result = await simpleProvider.subsumesTest('code2a', 'code2');
        expect(result).toBe('subsumed-by');
      });

      test('should return subsumes for grandparent-grandchild relationship', async () => {
        const result = await simpleProvider.subsumesTest('code2', 'code2aI');
        expect(result).toBe('subsumes');
      });

      test('should return not-subsumed for unrelated codes', async () => {
        const result = await simpleProvider.subsumesTest('code1', 'code3');
        expect(result).toBe('not-subsumed');
      });

      test('should return not-subsumed for CodeSystem without hierarchy', async () => {
        const extensionsProvider = factory.build(opContext, [], extensionsCS);
        const result = await extensionsProvider.subsumesTest('code1', 'code2');
        expect(result).toBe('not-subsumed');
      });

      test('should throw error for non-existent codes', async () => {
        await expect(simpleProvider.subsumesTest('nonexistent', 'code1'))
          .rejects.toThrow('Unknown Code');
      });
    });

    describe('iterator()', () => {
      test('should create iterator for all root concepts when context is null', async () => {
        const iterator = await simpleProvider.iterator(null);
        expect(iterator).toBeDefined();
        expect(iterator.type).toBe('all');
        expect(iterator.codes).toBeDefined();
        expect(Array.isArray(iterator.codes)).toBe(true);
        expect(iterator.codes.length).toBe(3); // All concepts in simple CS
        expect(iterator.current).toBe(0);
        expect(iterator.total).toBe(3);
      });

      test('should create iterator for children when context is provided', async () => {
        const iterator = await simpleProvider.iterator('code2');
        expect(iterator).toBeDefined();
        expect(iterator.type).toBe('children');
        expect(iterator.parentCode).toBe('code2');
        expect(iterator.codes).toBeDefined();
        expect(Array.isArray(iterator.codes)).toBe(true);
        expect(iterator.codes.length).toBe(2); // code2a and code2b
        expect(iterator.codes).toContain('code2a');
        expect(iterator.codes).toContain('code2b');
        expect(iterator.current).toBe(0);
        expect(iterator.total).toBe(2);
      });

      test('should create empty iterator for leaf concepts', async () => {
        const iterator = await simpleProvider.iterator('code1');
        expect(iterator).toBeDefined();
        expect(iterator.type).toBe('children');
        expect(iterator.parentCode).toBe('code1');
        expect(iterator.codes).toBeDefined();
        expect(Array.isArray(iterator.codes)).toBe(true);
        expect(iterator.codes.length).toBe(0); // code1 has no children
        expect(iterator.current).toBe(0);
        expect(iterator.total).toBe(0);
      });

      test('should return null for non-existent code', async () => {
        await expect(simpleProvider.iterator('nonexistent'))
          .rejects.toThrow('not found');
      });

      test('should work with context object', async () => {
        const locateResult = await simpleProvider.locate('code2');
        const iterator = await simpleProvider.iterator(locateResult.context);
        expect(iterator).toBeDefined();
        expect(iterator.type).toBe('children');
        expect(iterator.parentCode).toBe('code2');
        expect(iterator.codes.length).toBe(2);
      });
    });

    describe('nextContext()', () => {
      test('should iterate through all root concepts', async () => {
        const iterator = await simpleProvider.iterator(null);
        const contexts = [];

        let context = await simpleProvider.nextContext(iterator);
        while (context) {
          contexts.push(context);
          context = await simpleProvider.nextContext(iterator);
        }

        expect(contexts.length).toBe(3); // All concepts
        expect(contexts[0]).toBeInstanceOf(FhirCodeSystemProviderContext);

        // Check we got all the expected codes
        const codes = contexts.map(c => c.code);
        expect(codes).toContain('code1');
        expect(codes).toContain('code2');
        expect(codes).toContain('code3');
      });

      test('should iterate through children', async () => {
        const iterator = await simpleProvider.iterator('code2');
        const contexts = [];

        let context = await simpleProvider.nextContext(iterator);
        while (context) {
          contexts.push(context);
          context = await simpleProvider.nextContext(iterator);
        }

        expect(contexts.length).toBe(2); // code2a and code2b
        const codes = contexts.map(c => c.code);
        expect(codes).toContain('code2a');
        expect(codes).toContain('code2b');
      });

      test('should return null for empty iterator', async () => {
        const iterator = await simpleProvider.iterator('code1');
        const context = await simpleProvider.nextContext(iterator);
        expect(context).toBeNull();
      });

      test('should return null when iterator is exhausted', async () => {
        const iterator = await simpleProvider.iterator('code2');

        // Get first context
        const context1 = await simpleProvider.nextContext(iterator);
        expect(context1).toBeDefined();

        // Get second context
        const context2 = await simpleProvider.nextContext(iterator);
        expect(context2).toBeDefined();

        // Third call should return null
        const context3 = await simpleProvider.nextContext(iterator);
        expect(context3).toBeNull();
      });

      test('should return null for invalid iterator', async () => {
        const context = await simpleProvider.nextContext(null);
        expect(context).toBeNull();
      });

      test('should handle iterator state correctly', async () => {
        const iterator = await simpleProvider.iterator('code2');
        expect(iterator.current).toBe(0);

        await simpleProvider.nextContext(iterator);
        expect(iterator.current).toBe(1);

        await simpleProvider.nextContext(iterator);
        expect(iterator.current).toBe(2);

        // Should be exhausted now
        const context = await simpleProvider.nextContext(iterator);
        expect(context).toBeNull();
        expect(iterator.current).toBe(2); // Should stay at end
      });
    });

    describe('iterator()', () => {
      test('should create iterator for all root concepts when context is null', async () => {
        const iterator = await simpleProvider.iterator(null);
        expect(iterator).toBeDefined();
        expect(iterator.type).toBe('all');
        expect(iterator.codes).toBeDefined();
        expect(Array.isArray(iterator.codes)).toBe(true);
        expect(iterator.codes.length).toBe(3); // All concepts in simple CS
        expect(iterator.current).toBe(0);
        expect(iterator.total).toBe(3);
      });

      test('should create iterator for all concepts', async () => {
        const iterator = await simpleProvider.iteratorAll();
        expect(iterator).toBeDefined();
        expect(iterator.type).toBe('all');
        expect(iterator.codes).toBeDefined();
        expect(Array.isArray(iterator.codes)).toBe(true);
        expect(iterator.codes.length).toBe(7); // All concepts in simple CS
        expect(iterator.current).toBe(0);
        expect(iterator.total).toBe(7);
      });

      test('should create iterator for children when context is provided', async () => {
        const iterator = await simpleProvider.iterator('code2');
        expect(iterator).toBeDefined();
        expect(iterator.type).toBe('children');
        expect(iterator.parentCode).toBe('code2');
        expect(iterator.codes).toBeDefined();
        expect(Array.isArray(iterator.codes)).toBe(true);
        expect(iterator.codes.length).toBe(2); // code2a and code2b
        expect(iterator.codes).toContain('code2a');
        expect(iterator.codes).toContain('code2b');
        expect(iterator.current).toBe(0);
        expect(iterator.total).toBe(2);
      });

      test('should create empty iterator for leaf concepts', async () => {
        const iterator = await simpleProvider.iterator('code1');
        expect(iterator).toBeDefined();
        expect(iterator.type).toBe('children');
        expect(iterator.parentCode).toBe('code1');
        expect(iterator.codes).toBeDefined();
        expect(Array.isArray(iterator.codes)).toBe(true);
        expect(iterator.codes.length).toBe(0); // code1 has no children
        expect(iterator.current).toBe(0);
        expect(iterator.total).toBe(0);
      });

      test('should return null for non-existent code', async () => {
        await expect(simpleProvider.iterator('nonexistent'))
          .rejects.toThrow('not found');
      });

      test('should work with context object', async () => {
        const locateResult = await simpleProvider.locate('code2');
        const iterator = await simpleProvider.iterator(locateResult.context);
        expect(iterator).toBeDefined();
        expect(iterator.type).toBe('children');
        expect(iterator.parentCode).toBe('code2');
        expect(iterator.codes.length).toBe(2);
      });
    });

    describe('nextContext()', () => {
      test('should iterate through all root concepts', async () => {
        const iterator = await simpleProvider.iterator(null);
        const contexts = [];

        let context = await simpleProvider.nextContext(iterator);
        while (context) {
          contexts.push(context);
          context = await simpleProvider.nextContext(iterator);
        }

        expect(contexts.length).toBe(3); // All concepts
        expect(contexts[0]).toBeInstanceOf(FhirCodeSystemProviderContext);

        // Check we got all the expected codes
        const codes = contexts.map(c => c.code);
        expect(codes).toContain('code1');
        expect(codes).toContain('code2');
        expect(codes).toContain('code3');
      });

      test('should iterate through all concepts', async () => {
        const iterator = await simpleProvider.iteratorAll();
        const contexts = [];

        let context = await simpleProvider.nextContext(iterator);
        while (context) {
          contexts.push(context);
          context = await simpleProvider.nextContext(iterator);
        }

        expect(contexts.length).toBe(7); // All concepts
        expect(contexts[0]).toBeInstanceOf(FhirCodeSystemProviderContext);

        // Check we got all the expected codes
        const codes = contexts.map(c => c.code);
        expect(codes).toContain('code1');
        expect(codes).toContain('code2');
        expect(codes).toContain('code2a');
        expect(codes).toContain('code2aI');
        expect(codes).toContain('code2aII');
        expect(codes).toContain('code2b');
        expect(codes).toContain('code3');
      });

      test('should iterate through children', async () => {
        const iterator = await simpleProvider.iterator('code2');
        const contexts = [];

        let context = await simpleProvider.nextContext(iterator);
        while (context) {
          contexts.push(context);
          context = await simpleProvider.nextContext(iterator);
        }

        expect(contexts.length).toBe(2); // code2a and code2b
        const codes = contexts.map(c => c.code);
        expect(codes).toContain('code2a');
        expect(codes).toContain('code2b');
      });

      test('should return null for empty iterator', async () => {
        const iterator = await simpleProvider.iterator('code1');
        const context = await simpleProvider.nextContext(iterator);
        expect(context).toBeNull();
      });

      test('should return null when iterator is exhausted', async () => {
        const iterator = await simpleProvider.iterator('code2');

        // Get first context
        const context1 = await simpleProvider.nextContext(iterator);
        expect(context1).toBeDefined();

        // Get second context
        const context2 = await simpleProvider.nextContext(iterator);
        expect(context2).toBeDefined();

        // Third call should return null
        const context3 = await simpleProvider.nextContext(iterator);
        expect(context3).toBeNull();
      });

      test('should return null for invalid iterator', async () => {
        const context = await simpleProvider.nextContext(null);
        expect(context).toBeNull();
      });

      test('should handle iterator state correctly', async () => {
        const iterator = await simpleProvider.iterator('code2');
        expect(iterator.current).toBe(0);

        await simpleProvider.nextContext(iterator);
        expect(iterator.current).toBe(1);

        await simpleProvider.nextContext(iterator);
        expect(iterator.current).toBe(2);

        // Should be exhausted now
        const context = await simpleProvider.nextContext(iterator);
        expect(context).toBeNull();
        expect(iterator.current).toBe(2); // Should stay at end
      });
    });

    describe('extendLookup()', () => {
      test('should extend lookup with basic properties', async () => {
        const locateResult = await simpleProvider.locate('code1');
        const paramSet = [];

        await simpleProvider.extendLookup(locateResult.context, [], paramSet);

        // Find property parameter
        const propertyParam = paramSet.find(p => p.name === 'property');
        expect(propertyParam).toBeDefined();
        expect(propertyParam.part).toBeDefined();

      });

      test('should include properties when requested', async () => {
        const locateResult = await simpleProvider.locate('code1');
        const paramSet = [];

        await simpleProvider.extendLookup(locateResult.context, ['property'], paramSet);

        // Find property parameters
        const properties = paramSet.filter(p => p.name === 'property');
        expect(properties.length).toBeGreaterThan(0);

        // Should have the 'prop' property
        const propProperty = properties.find(p => {
          const codePart = p.part?.find(part => part.name === 'code');
          return codePart?.valueCode === 'prop';
        });
        expect(propProperty).toBeDefined();
        const valuePart = propProperty.part?.find(part => part.name === 'value');
        expect(valuePart?.valueCode).toBe('old');
      });

      test('should include parent when requested', async () => {
        const locateResult = await simpleProvider.locate('code2a');
        const paramSet = [];

        await simpleProvider.extendLookup(locateResult.context, ['parent'], paramSet);

        // Find property parameters
        const properties = paramSet.filter(p => p.name === 'property');

        // Find parent property
        const parentProperty = properties.find(p => {
          const codePart = p.part?.find(part => part.name === 'code');
          return codePart?.valueCode === 'parent';
        });
        expect(parentProperty).toBeDefined();

        const valuePart = parentProperty.part?.find(part => part.name === 'value');
        expect(valuePart?.valueCode).toBe('code2');

        const descPart = parentProperty.part?.find(part => part.name === 'description');
        expect(descPart?.valueString).toBe('Display 2');
      });

      test('should include children when requested', async () => {
        const locateResult = await simpleProvider.locate('code2');
        const paramSet = [];

        await simpleProvider.extendLookup(locateResult.context, ['child'], paramSet);

        // Find property parameters
        const properties = paramSet.filter(p => p.name === 'property');

        // Find child properties
        const childProperties = properties.filter(p => {
          const codePart = p.part?.find(part => part.name === 'code');
          return codePart?.valueCode === 'child';
        });
        expect(childProperties.length).toBe(2);

        const childCodes = childProperties.map(p => {
          const valuePart = p.part?.find(part => part.name === 'value');
          return valuePart?.valueCode;
        });
        expect(childCodes).toContain('code2a');
        expect(childCodes).toContain('code2b');
      });

      test('should handle wildcard properties', async () => {
        const locateResult = await simpleProvider.locate('code2');
        const paramSet = [];

        await simpleProvider.extendLookup(locateResult.context, ['*'], paramSet);

        const properties = paramSet.filter(p => p.name === 'property');
        expect(properties.length).toBeGreaterThan(0);

        // Should have parent, children, and regular properties
        const parentProp = properties.find(p => {
          const codePart = p.part?.find(part => part.name === 'code');
          return codePart?.valueCode === 'parent';
        });
        expect(parentProp).toBeUndefined(); // code2 is root, no parent

        const childProps = properties.filter(p => {
          const codePart = p.part?.find(part => part.name === 'code');
          return codePart?.valueCode === 'child';
        });
        expect(childProps.length).toBe(2);
      });

      test('should handle specific property requests', async () => {
        const locateResult = await simpleProvider.locate('code2a');
        const paramSet = [];

        await simpleProvider.extendLookup(locateResult.context, ['parent'], paramSet);

        const properties = paramSet.filter(p => p.name === 'property');

        // Should have parent but not children (not requested)
        const parentProp = properties.find(p => {
          const codePart = p.part?.find(part => part.name === 'code');
          return codePart?.valueCode === 'parent';
        });
        expect(parentProp).toBeDefined();

        const childProps = properties.filter(p => {
          const codePart = p.part?.find(part => part.name === 'code');
          return codePart?.valueCode === 'child';
        });
        expect(childProps.length).toBe(0);
      });

      test('should handle invalid context gracefully', async () => {
        const paramSet = [];

        await simpleProvider.extendLookup(null, [], paramSet);

        // Should not crash, params should remain empty or minimal
        expect(paramSet).toBeDefined();
      });
    });

    describe('Filter Implementation', () => {
      let simpleProvider, deProvider, extensionsProvider;
      let filterContext;

      beforeEach(async () => {
        simpleProvider = factory.build(opContext, [], simpleCS);
        deProvider = factory.build(opContext, [], deCS);
        extensionsProvider = factory.build(opContext, [supplementCS], extensionsCS);
        filterContext = {filters: []};
      });

      describe('Filter Infrastructure', () => {
        test('should create filter preparation context', async () => {
          const prepContext = await simpleProvider.getPrepContext(true);
          expect(prepContext).toBeDefined();
          expect(prepContext.filters).toBeDefined();
        });

        test('should report filters as closed', async () => {
          const notClosed = await simpleProvider.filtersNotClosed(filterContext);
          expect(notClosed).toBe(false);
        });

        test('should check filter support correctly', async () => {
          // Hierarchy filters
          expect(await simpleProvider.doesFilter('concept', 'is-a', 'code1')).toBe(true);
          expect(await simpleProvider.doesFilter('code', 'descendent-of', 'code2')).toBe(true);
          expect(await simpleProvider.doesFilter('concept', 'is-not-a', 'code1')).toBe(true);
          expect(await simpleProvider.doesFilter('concept', 'child-of', 'code2')).toBe(true);
          expect(await simpleProvider.doesFilter('code', 'in', 'code1,code2')).toBe(true);
          expect(await simpleProvider.doesFilter('code', '=', 'code1')).toBe(true);
          expect(await simpleProvider.doesFilter('code', 'regex', 'code.*')).toBe(true);

          // Child existence
          expect(await simpleProvider.doesFilter('child', 'exists', 'true')).toBe(true);

          // Property filters
          expect(await simpleProvider.doesFilter('prop', '=', 'old')).toBe(true);
          expect(await simpleProvider.doesFilter('status', 'in', 'active,retired')).toBe(true);

          // Known properties
          expect(await simpleProvider.doesFilter('notSelectable', '=', 'true')).toBe(true);

          // Unsupported filters
          expect(await simpleProvider.doesFilter('unknown', '=', 'value')).toBe(false);
          expect(await simpleProvider.doesFilter('code', 'unsupported-op', 'value')).toBe(false);
        });
      });

      describe('Search Filter', () => {
        test('should find concepts by exact code match', async () => {
          const results = await simpleProvider.searchFilter(filterContext, new SearchFilterText('code1'), true);
          expect(results.size()).toBeGreaterThan(0);

          const concept = results.findConceptByCode('code1');
          expect(concept).toBeDefined();
          expect(concept.code).toBe('code1');
        });

        test('should find concepts by display text match', async () => {
          const results = await simpleProvider.searchFilter(filterContext, new SearchFilterText('Display 1'), true);
          expect(results.size()).toBeGreaterThan(0);

          const concept = results.findConceptByCode('code1');
          expect(concept).toBeDefined();
        });

        test('should find concepts by partial match', async () => {
          const results = await simpleProvider.searchFilter(filterContext, new SearchFilterText('Display'), true);
          expect(results.size()).toBeGreaterThan(1); // Should find multiple concepts
        });

        test('should find concepts by definition match', async () => {
          const results = await simpleProvider.searchFilter(filterContext, new SearchFilterText('first'), true);
          expect(results.size()).toBeGreaterThan(0);
        });

        test('should return empty results for non-matching search', async () => {
          const results = await simpleProvider.searchFilter(filterContext, new SearchFilterText('nonexistent'), true);
          expect(results.size()).toBe(0);
        });

        test('should sort results by relevance when requested', async () => {
          const results = await simpleProvider.searchFilter(filterContext, new SearchFilterText('code'), true);
          expect(results.size()).toBeGreaterThan(1);

          // Results should be sorted by rating (exact matches first)
          let lastRating = 100;
          results.concepts.forEach(item => {
            expect(item.rating).toBeLessThanOrEqual(lastRating);
            lastRating = item.rating;
          });
        });

        describe('across accents and words', () => {
          let ptProvider;

          beforeEach(() => {
            ptProvider = factory.build(opContext, [], new CodeSystem({
              resourceType: 'CodeSystem',
              url: 'http://example.org/icd-10-cm-pt',
              status: 'active',
              content: 'complete',
              language: 'pt',
              concept: [
                {code: 'A00', display: 'Cólera'},
                {code: 'E119', display: 'Diabetes mellitus tipo 2 sem complicações'},
                {code: 'E11', display: 'Diabetes mellitus tipo 2'},
                {code: 'I21', display: 'Enfarte agudo do miocárdio', designation: [{language: 'en', value: 'Acute myocardial infarction'}]},
                {code: 'E10', display: 'Diabetes mellitus tipo 1'}
              ]
            }));
          });

          const codes = (results) => results.concepts.map(item => item.concept.code);

          test('should match whatever the accents and case', async () => {
            expect(codes(await ptProvider.searchFilter(filterContext, new SearchFilterText('colera'), true))).toEqual(['A00']);
            expect(codes(await ptProvider.searchFilter(filterContext, new SearchFilterText('MIOCÁRDIO'), true))).toEqual(['I21']);
          });

          test('should ignore accents only on Latin, Greek and Cyrillic letters', async () => {
            const provider = factory.build(opContext, [], new CodeSystem({
              resourceType: 'CodeSystem',
              url: 'http://example.org/scripts',
              status: 'active',
              content: 'complete',
              concept: [
                {code: 'heart', display: 'Καρδιά'},
                {code: 'tree', display: 'Ёлка'},
                {code: 'cancer', display: 'がん'},
                {code: 'kan', display: 'かん'},
                {code: 'book', display: 'किताब'}
              ]
            }));
            const search = async (text) => codes(await provider.searchFilter(filterContext, new SearchFilterText(text), true));
            expect(await search('καρδια')).toEqual(['heart']);
            expect(await search('елка')).toEqual(['tree']);
            expect(await search('がん')).toEqual(['cancer']);
            expect(await search('かん')).toEqual(['kan']);
            expect(await search('कतब')).toEqual([]);
          });

          test('should match a search whose words start words of the display, in any order', async () => {
            expect(codes(await ptProvider.searchFilter(filterContext, new SearchFilterText('diabetes tipo 2'), true))).toEqual(['E11', 'E119']);
            expect(codes(await ptProvider.searchFilter(filterContext, new SearchFilterText('enfarte miocardio'), true))).toEqual(['I21']);
            expect(codes(await ptProvider.searchFilter(filterContext, new SearchFilterText('tipo 2 diab'), true))).toEqual(['E11', 'E119']);
          });

          test('should match a search whose words all start words of one designation', async () => {
            expect(codes(await ptProvider.searchFilter(filterContext, new SearchFilterText('myocardial acute'), true))).toEqual(['I21']);
            expect(codes(await ptProvider.searchFilter(filterContext, new SearchFilterText('acute miocardio'), true))).toEqual([]);
          });

          test('should not match a word that is only inside another word', async () => {
            expect(codes(await ptProvider.searchFilter(filterContext, new SearchFilterText('diabetes ellitus'), true))).toEqual([]);
          });

          test('should rate a match of the words of a shorter display higher', async () => {
            const results = await ptProvider.searchFilter(filterContext, new SearchFilterText('diabetes 2'), true);
            expect(codes(results)).toEqual(['E11', 'E119']);
          });

          test('should rate a match of the whole search above a match of its words', async () => {
            const results = await ptProvider.searchFilter(filterContext, new SearchFilterText('tipo 2'), true);
            const words = await ptProvider.searchFilter(filterContext, new SearchFilterText('2 tipo'), true);
            expect(Math.min(...results.concepts.map(item => item.rating))).toBeGreaterThan(Math.max(...words.concepts.map(item => item.rating)));
          });

          test('should rate a match of the words the same whatever separates them in the search', async () => {
            const rating = async (search) => (await ptProvider.searchFilter(filterContext, new SearchFilterText(search), true))
              .concepts.find(item => item.concept.code === 'E11').rating;
            const spaced = await rating('2   ,   tipo   ...   diabetes');
            expect(spaced).toBe(await rating('2 tipo diabetes'));
            expect(spaced).toBeLessThan(30);
          });
        });
      });

      describe('Concept/Code Filters', () => {
        test('should filter by is-a relationship', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'concept', 'is-a', 'code2');
          expect(results.size()).toBe(5); // code2a + children, code2b

          expect(results.findConceptByCode('code2a')).toBeDefined();
          expect(results.findConceptByCode('code2b')).toBeDefined();
          expect(results.findConceptByCode('code1')).toBeNull(); // Not a descendant
        });

        test('should filter by descendent-of relationship', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'code', 'descendent-of', 'code2');
          expect(results.size()).toBe(4); // code2a, code2aI, code2aII, code2b (not code2 itself)

          expect(results.findConceptByCode('code2')).toBeNull(); // Root not included
          expect(results.findConceptByCode('code2a')).toBeDefined();
          expect(results.findConceptByCode('code2aI')).toBeDefined();
          expect(results.findConceptByCode('code2aII')).toBeDefined();
          expect(results.findConceptByCode('code2b')).toBeDefined();
        });

        test('should filter by is-not-a relationship', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'concept', 'is-not-a', 'code2');
          expect(results.size()).toBe(2); // code1 and code3 (not descendants of code2)

          expect(results.findConceptByCode('code1')).toBeDefined();
          expect(results.findConceptByCode('code3')).toBeDefined();
          expect(results.findConceptByCode('code2')).toBeNull();
          expect(results.findConceptByCode('code2a')).toBeNull();
        });

        test('should filter by in relationship', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'code', 'in', 'code1,code3');
          expect(results.size()).toBe(2);

          expect(results.findConceptByCode('code1')).toBeDefined();
          expect(results.findConceptByCode('code3')).toBeDefined();
          expect(results.findConceptByCode('code2')).toBeNull();
        });

        test('should filter by exact match', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'code', '=', 'code1');
          expect(results.size()).toBe(1);

          expect(results.findConceptByCode('code1')).toBeDefined();
          expect(results.findConceptByCode('code2')).toBeNull();
        });

        test('should filter by regex pattern', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'code', 'regex', 'code2.*');
          expect(results.size()).toBeGreaterThan(1); // Should match code2, code2a, code2b, etc.

          expect(results.findConceptByCode('code2')).toBeDefined();
          expect(results.findConceptByCode('code2a')).toBeDefined();
          expect(results.findConceptByCode('code1')).toBeNull();
        });

        test('should handle invalid regex gracefully', async () => {
          await expect(
            simpleProvider.filter(filterContext, true, 'code', 'regex', '[invalid')
          ).rejects.toThrow('The regex \'[invalid\' is not valid: error parsing regexp: missing closing ]: `[invalid$`');
        });
      });

      describe('Child Existence Filter', () => {
        test('should find concepts with children', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'child', 'exists', 'true');
          expect(results.size()).toBe(2); // code2 and code2a have children

          expect(results.findConceptByCode('code2')).toBeDefined();
          expect(results.findConceptByCode('code2a')).toBeDefined();
          expect(results.findConceptByCode('code1')).toBeNull(); // No children
        });

        test('should find concepts without children (leaf nodes)', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'child', 'exists', 'false');
          expect(results.size()).toBe(5); // code1, code2aI, code2aII, code2b, code3

          expect(results.findConceptByCode('code1')).toBeDefined();
          expect(results.findConceptByCode('code2aI')).toBeDefined();
          expect(results.findConceptByCode('code2aII')).toBeDefined();
          expect(results.findConceptByCode('code2b')).toBeDefined();
          expect(results.findConceptByCode('code3')).toBeDefined();
          expect(results.findConceptByCode('code2')).toBeNull(); // Has children
        });
      });

      describe('Property-Based Filters', () => {
        test('should filter by property equality', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'prop', '=', 'old');
          expect(results.size()).toBeGreaterThan(0);

          // code1 has prop=old
          expect(results.findConceptByCode('code1')).toBeDefined();
        });

        test('should filter by property in values', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'prop', 'in', 'old,new');
          expect(results.size()).toBeGreaterThan(0);

          // Should find concepts with either old or new values
          expect(results.findConceptByCode('code1')).toBeDefined(); // prop=old
        });

        test('should filter by property not in values', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'prop', 'not-in', 'retired');
          expect(results.size()).toBeGreaterThan(0);

          // Should exclude concepts with retired status
          expect(results.findConceptByCode('code1')).toBeDefined(); // Not retired
        });

        test('should filter by property regex', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'prop', 'regex', 'ol.*');
          expect(results.size()).toBeGreaterThan(0);

          // Should match "old" values
          expect(results.findConceptByCode('code1')).toBeDefined();
        });
      });

      describe('Known Property Filters', () => {
        test('should filter by notSelectable property', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'notSelectable', '=', 'true');
          expect(results.size()).toBe(1);

          // code2 has notSelectable=true
          expect(results.findConceptByCode('code2')).toBeDefined();
        });

        test('should filter by status property', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'status', '=', 'retired');
          expect(results.size()).toBe(1);

          // code2 has status=retired
          expect(results.findConceptByCode('code2')).toBeDefined();
        });

        test('should filter by status in values', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'status', 'in', 'active,retired');
          expect(results.size()).toBeGreaterThan(0);
        });
      });

      describe('Filter Iteration', () => {
        test('should iterate through filter results', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'code', 'in', 'code1,code2,code3');
          expect(results.size()).toBe(3);

          results.reset();
          const concepts = [];
          while (await simpleProvider.filterMore(filterContext, results)) {
            const context = await simpleProvider.filterConcept(filterContext, results);
            concepts.push(context);
          }

          expect(concepts.length).toBe(3);
          expect(concepts.every(c => c instanceof FhirCodeSystemProviderContext)).toBe(true);
        });

        test('should locate specific code in filter results', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'code', 'in', 'code1,code2');

          const located = await simpleProvider.filterLocate(filterContext, results, 'code1');
          expect(located).toBeInstanceOf(FhirCodeSystemProviderContext);
          expect(located.code).toBe('code1');

          const notFound = await simpleProvider.filterLocate(filterContext, results, 'code3');
          expect(notFound).toBeNull();
        });

        test('should check if concept is in filter results', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'code', 'in', 'code1,code2');

          const concept1 = new FhirCodeSystemProviderContext('code1', simpleCS.getConceptByCode('code1'));
          const concept3 = new FhirCodeSystemProviderContext('code3', simpleCS.getConceptByCode('code3'));

          const check1 = await simpleProvider.filterCheck(filterContext, results, concept1);
          expect(check1).toBe(true);

          const check3 = await simpleProvider.filterCheck(filterContext, results, concept3);
          expect(typeof check3).toBe('string'); // Error message
        });

        test('should get filter size correctly', async () => {
          const results = await simpleProvider.filter(filterContext, true, 'code', 'in', 'code1,code2,code3');

          const size = await simpleProvider.filterSize(filterContext, results);
          expect(size).toBe(3);

          const emptySize = await simpleProvider.filterSize(filterContext, null);
          expect(emptySize).toBe(0);
        });

        test('should execute and finish filters properly', async () => {
          filterContext.filters = [];
          await simpleProvider.filter(filterContext, true, 'code', '=', 'code1');

          const executed = await simpleProvider.executeFilters(filterContext);
          expect(Array.isArray(executed)).toBe(true);
          expect(executed.length).toBe(1);

          await simpleProvider.filterFinish(filterContext);
          expect(filterContext.filters.length).toBe(0);
        });
      });

      describe('Error Handling', () => {
        test('should handle null filter context gracefully', async () => {
          const size = await simpleProvider.filterSize(null, null);
          expect(size).toBe(0);

          const hasMore = await simpleProvider.filterMore(null, null);
          expect(hasMore).toBe(false);

          const concept = await simpleProvider.filterConcept(null, null);
          expect(concept).toBeNull();
        });

      });

      describe('Complex Filter Scenarios', () => {
        test('should work with German CodeSystem', async () => {
          const results = await deProvider.searchFilter(filterContext, new SearchFilterText('Anzeige'), true);
          expect(results.size()).toBeGreaterThan(0);
        });

        test('should work with Extensions CodeSystem', async () => {
          const results = await extensionsProvider.filter(filterContext, true, 'code', 'regex', 'code[1-3]');
          expect(results.size()).toBe(3);
        });

        test('should handle multiple filters in sequence', async () => {
          // First filter: get all concepts with children
          const withChildren = await simpleProvider.filter(filterContext, true, 'child', 'exists', 'true');
          expect(withChildren.size()).toBe(2);

          // Second filter: get concepts with specific property
          const withProperty = await simpleProvider.filter(filterContext, true, 'prop', '=', 'new');
          expect(withProperty.size()).toBeGreaterThan(0);

          // Both filters should be in context
          expect(filterContext.filters.length).toBe(2);
        });
      });
    });
  });
});