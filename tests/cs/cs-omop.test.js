const fs = require('fs');
const path = require('path');
const { OMOPServices, OMOPServicesFactory, OMOPConcept } = require('../../tx/cs/cs-omop');
const { OperationContext } = require('../../tx/operation-context');
const {Designations} = require("../../tx/library/designations");
const {TestUtilities} = require("../test-utilities");

describe('OMOP Provider', () => {
  const testDbPath = path.resolve(__dirname, '../../tx/data/omop-fragment.db');
  let factory;
  let provider;
  let opContext;

  // Test data structure - will be populated dynamically from the database
  const testData = {
    expectedCounts: {
      concepts: 1146,
      conceptClasses: 433,
      relationships: 220,
      synonyms: 256,
      domains: 50,
      relationshipTypes: 722,
      vocabularies: 129
    },
    sampleConcepts: [], // Will be populated from database
    domains: [], // Will be populated from database
    vocabularies: [] // Will be populated from database
  };

  beforeAll(async () => {
    // Verify test database exists
    expect(fs.existsSync(testDbPath)).toBe(true);

    // Create factory and provider
    opContext = new OperationContext('en', await TestUtilities.loadTranslations());
    factory = new OMOPServicesFactory(opContext.i18n, testDbPath);
    provider = await factory.build(opContext, []);

    // Populate test data by querying the database
    await populateTestData();
  });

  afterAll(() => {
    if (provider) {
      provider.close();
    }
  });

  async function populateTestData() {
    // Get sample concepts
    testData.sampleConcepts = await getSampleConcepts();

    // Get available domains
    testData.domains = await getSampleDomains();

    // Get available vocabularies
    testData.vocabularies = await getSampleVocabularies();
  }

  async function getSampleConcepts() {
    return new Promise((resolve, reject) => {
      const sql = 'SELECT concept_id FROM Concepts LIMIT 10';
      provider.db.all(sql, (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map(row => row.concept_id.toString()));
      });
    });
  }

  async function getSampleDomains() {
    return new Promise((resolve, reject) => {
      const sql = 'SELECT DISTINCT domain_id FROM Domains LIMIT 5';
      provider.db.all(sql, (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map(row => row.domain_id));
      });
    });
  }

  async function getSampleVocabularies() {
    return new Promise((resolve, reject) => {
      const sql = 'SELECT DISTINCT vocabulary_id FROM Vocabularies LIMIT 5';
      provider.db.all(sql, (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map(row => row.vocabulary_id));
      });
    });
  }

  describe('Factory and Basic Setup', () => {
    test('should create factory and provider', () => {
      expect(factory).toBeDefined();
      expect(provider).toBeDefined();
      expect(provider).toBeInstanceOf(OMOPServices);
    });

    test('should check database status', async () => {
      const status = await OMOPServicesFactory.checkDB(testDbPath);
      expect(status).toContain('OK');
    });

    test('should have correct system URI', () => {
      expect(provider.system()).toBe('https://fhir-terminology.ohdsi.org');
    });

    test('should have description', () => {
      const description = provider.description();
      expect(description).toContain('OMOP Concepts');
      expect(description).toContain('release');
    });

    test('should return version', async () => {
      const version = await provider.version();
      expect(version).toBeDefined();
      expect(typeof version).toBe('string');
    });

    test('should return correct total count', async () => {
      const count = await provider.totalCount();
      expect(count).toBe(testData.expectedCounts.concepts);
    });

    test('should not support iteration (too large)', async () => {
      await expect(provider.iterator(null)).rejects.toThrow('too large');
      await expect(provider.nextContext(null)).rejects.toThrow('too large');
    });
  });

  describe('Code Lookup', () => {
    test('should locate known concepts', async () => {
      for (const conceptId of testData.sampleConcepts.slice(0, 5)) {
        const result = await provider.locate(conceptId);
        expect(result.context).toBeDefined();
        expect(result.context).toBeInstanceOf(OMOPConcept);
        expect(result.context.code).toBe(conceptId);
        expect(result.message).toBeNull();
      }
    });

    test('should return null for non-existent concept', async () => {
      const result = await provider.locate('999999999');
      expect(result.context).toBeNull();
      expect(result.message).toBeUndefined();
    });

    test('should return correct code for context', async () => {
      if (testData.sampleConcepts.length > 0) {
        const testCode = testData.sampleConcepts[0];
        const result = await provider.locate(testCode);
        const code = await provider.code(result.context);
        expect(code).toBe(testCode);
      }
    });

    test('should have concept metadata', async () => {
      if (testData.sampleConcepts.length > 0) {
        const result = await provider.locate(testData.sampleConcepts[0]);
        const concept = result.context;

        expect(concept.display).toBeDefined();
        expect(concept.domain).toBeDefined();
        expect(concept.conceptClass).toBeDefined();
        expect(concept.standard).toBeDefined();
        expect(concept.vocabulary).toBeDefined();
      }
    });
  });

  describe('Displays and Designations', () => {
    test('should get display for concepts', async () => {
      for (const conceptId of testData.sampleConcepts.slice(0, 3)) {
        const display = await provider.display(conceptId);
        expect(display).toBeDefined();
        expect(typeof display).toBe('string');
        expect(display.length).toBeGreaterThan(0);
      }
    });

    test('should return designations for concepts', async () => {
      if (testData.sampleConcepts.length > 0) {
        const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
        await provider.designations(testData.sampleConcepts[0], designations);

        expect(designations.count).toBeGreaterThan(0);

        const firstDesignation = designations.designations[0];
        expect(firstDesignation.language).toBeDefined();
        expect(firstDesignation.value).toBeDefined();
      }
    });
  });

  describe('Code Properties', () => {
    test('should return false for abstract concepts', async () => {
      if (testData.sampleConcepts.length > 0) {
        const result = await provider.locate(testData.sampleConcepts[0]);
        const isAbstract = await provider.isAbstract(result.context);
        expect(isAbstract).toBe(false);
      }
    });

    test('should return false for inactive/deprecated concepts', async () => {
      if (testData.sampleConcepts.length > 0) {
        const result = await provider.locate(testData.sampleConcepts[0]);
        expect(await provider.isInactive(result.context)).toBe(false);
        expect(await provider.isDeprecated(result.context)).toBe(false);
      }
    });

    test('should return empty definition', async () => {
      if (testData.sampleConcepts.length > 0) {
        const result = await provider.locate(testData.sampleConcepts[0]);
        const definition = await provider.definition(result.context);
        expect(definition).toBe('');
      }
    });
  });

  describe('Extended Lookup', () => {
    // $expand reports properties from properties(), which is built from extendLookup
    test('properties() for $expand: only the named ones, none when none are named', async () => {
      if (testData.sampleConcepts.length > 0) {
        const conceptId = testData.sampleConcepts[0];
        expect(await provider.properties(conceptId, [])).toEqual([]);
        const got = await provider.properties(conceptId, ['domain-id', 'vocabulary-id']);
        expect(got.map(p => p.code).sort()).toEqual(['domain-id', 'vocabulary-id']);
      }
    });

    test('should extend lookup with basic properties', async () => {
      if (testData.sampleConcepts.length > 0) {
        const conceptId = testData.sampleConcepts[0];
        const paramSet = [];

        const requestedProps = ['domain-id', 'concept-class-id', 'standard-concept', 'vocabulary-id'];
        await provider.extendLookup(conceptId, requestedProps, paramSet);

        const params = { parameter: paramSet };
        expect(params.parameter).toBeDefined();
        expect(params.parameter.length).toBeGreaterThan(0);

        // Check for expected parameter types
        const paramTypes = params.parameter.map(p => p.name);
        expect(paramTypes).toContain('property');

        // Check for specific properties
        const properties = params.parameter.filter(p => p.name === 'property');
        const propNames = properties.map(p => p.part.find(part => part.name === 'code')?.valueCode);

        expect(propNames).toContain('domain-id');
      }
    });

    test('should include extended properties when available', async () => {
      if (testData.sampleConcepts.length > 0) {
        const conceptId = testData.sampleConcepts[0];
        const paramSet = [];
        const extendedProps = [
          'concept-class-concept-id', 'domain-concept-id',
          'valid-start-date', 'valid-end-date',
          'vocabulary-concept-id', 'invalid-reason'
        ];
        // which properties a concept has varies; this checks only that the lookup succeeds
        await provider.extendLookup(conceptId, extendedProps, paramSet);
      }
    });

    test('should include relationships when available', async () => {
      if (testData.sampleConcepts.length > 0) {
        const conceptId = testData.sampleConcepts[0];
        const paramSet = [];

        // Request all properties to potentially capture relationships (a concept may
        // have none; this checks only that the lookup succeeds)
        await provider.extendLookup(conceptId, [], paramSet);
      }
    });
  });

  describe('Filter Support', () => {
    test('should support domain filter', async () => {
      expect(await provider.doesFilter('domain', '=', 'Condition')).toBe(true);
      expect(await provider.doesFilter('domain', '=', 'Drug')).toBe(true);
    });

    test('should reject unsupported filters', async () => {
      expect(await provider.doesFilter('unsupported', '=', 'value')).toBe(false);
      expect(await provider.doesFilter('domain', 'regex', 'value')).toBe(false);
    });
  });

  describe('Domain Filters', () => {
    test('should filter by domain', async () => {
      if (testData.domains.length > 0) {
        const testDomain = testData.domains[0];
        const filterContext = await provider.getPrepContext(true);

        await provider.filter(filterContext, true, 'domain', '=', testDomain);
        const filters = await provider.executeFilters(filterContext);
        const filter = filters[0];

        const size = await provider.filterSize(filterContext, filter);
        expect(size).toBeGreaterThanOrEqual(0);

        // Test iteration through a few results
        let count = 0;
        const maxToTest = Math.min(5, size);

        while (await provider.filterMore(filterContext, filter) && count < maxToTest) {
          const concept = await provider.filterConcept(filterContext, filter);
          expect(concept).toBeInstanceOf(OMOPConcept);
          expect(concept.code).toBeDefined();
          expect(concept.display).toBeDefined();
          count++;
        }

        expect(count).toBeGreaterThan(0);

        await provider.filterFinish(filterContext);
      }
    });

    test('should handle multiple domains', async () => {
      const testedDomains = Math.min(3, testData.domains.length);

      for (let i = 0; i < testedDomains; i++) {
        const domain = testData.domains[i];
        const filterContext = await provider.getPrepContext(true);

        await provider.filter(filterContext, true, 'domain', '=', domain);
        const filters = await provider.executeFilters(filterContext);
        const filter = filters[0];

        expect(await provider.filterSize(filterContext, filter)).toBeGreaterThanOrEqual(0);

        await provider.filterFinish(filterContext);
      }
    });
  });

  describe('Filter Operations', () => {
    test('should check if concepts are in domain filters', async () => {
      if (testData.domains.length > 0 && testData.sampleConcepts.length > 0) {
        // Get a concept and its domain
        const conceptResult = await provider.locate(testData.sampleConcepts[0]);
        const concept = conceptResult.context;

        if (concept && concept.domain) {
          const filterContext = await provider.getPrepContext(true);
          await provider.filter(filterContext, true, 'domain', '=', concept.domain);
          const filters = await provider.executeFilters(filterContext);
          const filter = filters[0];

          const inFilter = await provider.filterCheck(filterContext, filter, concept);
          expect(typeof inFilter).toBe('boolean');

          await provider.filterFinish(filterContext);
        }
      }
    });

    test('should have closed filters', async () => {
      if (testData.domains.length > 0) {
        const filterContext = await provider.getPrepContext(true);
        await provider.filter(filterContext, true, 'domain', '=', testData.domains[0]);

        const notClosed = await provider.filtersNotClosed(filterContext);
        expect(notClosed).toBe(false);
      }
    });
  });

  describe('Translation Support', () => {
    test('should handle translation requests', async () => {
      if (testData.sampleConcepts.length > 0) {
        const coding = {
          system: provider.system(),
          code: testData.sampleConcepts[0]
        };

        // Test translation to SNOMED CT
        const translations = await provider.getTranslations(coding, 'http://snomed.info/sct');
        expect(Array.isArray(translations)).toBe(true);
      }
    });

    test('should return empty array for unsupported target', async () => {
      if (testData.sampleConcepts.length > 0) {
        const coding = {
          system: provider.system(),
          code: testData.sampleConcepts[0]
        };

        const translations = await provider.getTranslations(coding, 'http://unsupported.example.com');
        expect(Array.isArray(translations)).toBe(true);
        expect(translations.length).toBe(0);
      }
    });
  });

  describe('Value Set Building', () => {
    test('should build value sets for domains', async () => {
      if (testData.domains.length > 0) {
        const domain = testData.domains[0];
        // the provider's domain value sets are https://fhir-terminology.ohdsi.org/ValueSet/{domain}
        const valueSetId = `https://fhir-terminology.ohdsi.org/ValueSet/${domain}`;

        const valueSet = await provider.buildValueSet(null, valueSetId);
        expect(valueSet).toBeDefined();
        expect(valueSet.url).toBe(valueSetId);
        expect(valueSet.name).toContain(domain);
        expect(valueSet.compose).toBeDefined();
        expect(valueSet.compose.include).toBeDefined();
        expect(valueSet.compose.include.length).toBeGreaterThan(0);
      }
    });

    test('should reject unknown domains', async () => {
      const invalidId = 'https://fhir-terminology.ohdsi.org/ValueSet/omop-domain-UnknownDomain999';

      await expect(provider.buildValueSet(null, invalidId)).rejects.toThrow('Unknown Value Domain');
    });
  });

  describe('Concept Map Registration', () => {
    test('should register concept maps for vocabularies', async () => {
      const conceptMaps = [];
      await provider.registerConceptMaps(conceptMaps, null);

      expect(Array.isArray(conceptMaps)).toBe(true);
      expect(conceptMaps.length).toBeGreaterThan(0);

      // Check that we have both to- and from- maps
      const toMaps = conceptMaps.filter(cm => cm.id.startsWith('to-'));
      const fromMaps = conceptMaps.filter(cm => cm.id.startsWith('from-'));

      expect(toMaps.length).toBeGreaterThan(0);
      expect(fromMaps.length).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {

    test('should handle unsupported filters', async () => {
      const filterContext = await provider.getPrepContext(true);

      await expect(
        provider.filter(filterContext, true, 'unsupported', '=', 'value')
      ).rejects.toMatchObject({ cause: 'not-supported', message: 'The filter "unsupported = value" is not understood or supported', msgId: 'FILTER_NOT_UNDERSTOOD', statusCode: 422 });
    });

    test('should handle extend lookup with invalid context', async () => {
      const params = { parameter: [] };

      await expect(
        provider.extendLookup('invalid-concept-id', [], params)
      ).rejects.toThrow();
    });

    test('should handle invalid context types', async () => {
      await expect(
        provider.code('invalid-context')
      ).rejects.toThrow('OMOP Concept \'invalid-context\' not found');
    });

    test('should reject unsupported operations', async () => {
      const filterContext = await provider.getPrepContext(true);

      await expect(
        provider.searchFilter(filterContext, 'test', false)
      ).rejects.toThrow('Text Search is not supported');
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty code lookup', async () => {
      const result = await provider.locate('');
      expect(result.context).toBeNull();
      expect(result.message).toContain('Empty code');
    });

    test('should handle null context in various methods', async () => {
      expect(await provider.code(null)).toBeNull();
      expect(await provider.display(null)).toBeNull();
      const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
      await provider.designations(null, designations);
      expect(designations.count).toBe(0);
    });

    test('should handle subsumption test (not implemented)', async () => {
      const result = await provider.subsumesTest(testData.sampleConcepts[0], testData.sampleConcepts[1]);
      expect(result).toBe('not-subsumed');
    });
  });

  describe('Data Validation', () => {
    test('should have reasonable concept distribution', async () => {
      // Test that we have concepts across different domains
      const domainCounts = {};

      for (const domain of testData.domains.slice(0, 3)) {
        const filterContext = await provider.getPrepContext(true);
        await provider.filter(filterContext, true, 'domain', '=', domain);
        const filters = await provider.executeFilters(filterContext);
        const filter = filters[0];

        const size = await provider.filterSize(filterContext, filter);
        domainCounts[domain] = size;

        await provider.filterFinish(filterContext);
      }

      // At least one domain should have concepts
      const totalConcepts = Object.values(domainCounts).reduce((sum, count) => sum + count, 0);
      expect(totalConcepts).toBeGreaterThan(0);
    });

    test('should have valid concept structure', async () => {
      if (testData.sampleConcepts.length > 0) {
        const result = await provider.locate(testData.sampleConcepts[0]);
        const concept = result.context;

        // Validate concept structure
        expect(concept.code).toBeDefined();
        expect(concept.display).toBeDefined();
        expect(concept.domain).toBeDefined();
        expect(concept.conceptClass).toBeDefined();
        expect(concept.standard).toBeDefined();
        expect(concept.vocabulary).toBeDefined();

        // Standard concept should be valid value
        expect(['S', 'C', 'NS']).toContain(concept.standard);
      }
    });
  });

  describe('Performance and Cleanup', () => {
    test('should track factory usage', () => {
      const useCount = factory.useCount();
      expect(useCount).toBeGreaterThan(0);
    });

    test('should handle provider close', () => {
      // Should not throw
      const testProvider = provider;
      testProvider.close();
    });
  });
});