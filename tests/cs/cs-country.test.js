const { CountryCodeFactoryProvider } = require('../../tx/cs/cs-country');
const { OperationContext } = require('../../tx/operation-context');
const {TestUtilities} = require("../test-utilities");

describe('CountryCodeServices', () => {
  let factory;
  let provider;
  let opContext;

  beforeEach(async () => {
    opContext = new OperationContext('en', await TestUtilities.loadTranslations());
    factory = new CountryCodeFactoryProvider(opContext.i18n);
    await factory.load();
    provider = factory.build(opContext, []);
  });

  describe('Basic Functionality', () => {
    test('should return correct system URI', () => {
      expect(provider.system()).toBe('urn:iso:std:iso:3166');
    });

    test('should return correct version', () => {
      expect(provider.version()).toBe('2018');
    });

    test('should return correct description', () => {
      expect(provider.description()).toBe('ISO Country Codes');
    });

    test('should return total count greater than 0', () => {
      expect(provider.totalCount()).toBeGreaterThan(0);
      expect(provider.totalCount()).toBeGreaterThan(500); // Should have many codes in different formats
    });

    test('should not have parents', () => {
      expect(provider.hasParents()).toBe(false);
    });
  });

  describe('Code Lookup - Multiple Formats', () => {
    test('should locate 2-letter country codes', async () => {
      const testCodes = [
        ['US', 'United States of America'],
        ['CA', 'Canada'],
        ['GB', 'United Kingdom of Great Britain and Northern Ireland'],
        ['DE', 'Germany'],
        ['JP', 'Japan'],
        ['AU', 'Australia']
      ];

      for (const [code, expectedDisplay] of testCodes) {
        const result = await provider.locate(code);
        expect(result.context).toBeTruthy();
        expect(result.message).toBeNull();
        expect(await provider.code(result.context)).toBe(code);

        const display = await provider.display(result.context);
        expect(display).toBe(expectedDisplay);
      }
    });

    test('should locate 3-letter country codes', async () => {
      const testCodes = [
        ['USA', 'United States of America'],
        ['CAN', 'Canada'],
        ['GBR', 'United Kingdom'],
        ['DEU', 'Germany'],
        ['JPN', 'Japan'],
        ['AUS', 'Australia']
      ];

      for (const [code, expectedDisplay] of testCodes) {
        const result = await provider.locate(code);
        expect(result.context).toBeTruthy();
        expect(result.message).toBeNull();
        expect(await provider.code(result.context)).toBe(code);

        const display = await provider.display(result.context);
        expect(display).toBe(expectedDisplay);
      }
    });

    test('should locate numeric country codes', async () => {
      const testCodes = [
        ['840', 'United States of America'],
        ['124', 'Canada'],
        ['826', 'United Kingdom'],
        ['276', 'Germany'],
        ['392', 'Japan'],
        ['036', 'Australia']
      ];

      for (const [code, expectedDisplay] of testCodes) {
        const result = await provider.locate(code);
        expect(result.context).toBeTruthy();
        expect(result.message).toBeNull();
        expect(await provider.code(result.context)).toBe(code);

        const display = await provider.display(result.context);
        expect(display).toBe(expectedDisplay);
      }
    });

    test('should return error for invalid codes', async () => {
      const invalidCodes = ['XX-XX', 'ZZZ', '999'];

      for (const code of invalidCodes) {
        const result = await provider.locate(code);
        expect(result.context).toBeNull();
        expect(result.message).toBeUndefined();
      }
    });

    test('should return empty definition', async () => {
      const result = await provider.locate('US');
      const definition = await provider.definition(result.context);
      expect(definition).toBe(null);
    });

    test('should return false for abstract, inactive, deprecated', async () => {
      const result = await provider.locate('US');
      expect(await provider.isAbstract(result.context)).toBe(false);
      expect(await provider.isInactive(result.context)).toBe(false);
      expect(await provider.isDeprecated(result.context)).toBe(false);
    });
  });

  describe('Iterator Functionality', () => {
    test('should create iterator for all concepts', async () => {
      const iterator = await provider.iterator(null);
      expect(iterator).toBeTruthy();
      expect(iterator.index).toBe(0);
      expect(iterator.total).toBe(provider.totalCount());
    });

    test('should iterate through concepts', async () => {
      const iterator = await provider.iterator(null);
      const concepts = [];

      for (let i = 0; i < 20 && i < iterator.total; i++) {
        const concept = await provider.nextContext(iterator);
        expect(concept).toBeTruthy();
        concepts.push(concept);
      }

      expect(concepts.length).toBe(Math.min(20, iterator.total));
      // Should have different codes
      const codes = concepts.map(c => provider.code(c));
      expect(new Set(codes).size).toBe(codes.length);
    });

    test('should return null when iterator exhausted', async () => {
      const iterator = { index: provider.totalCount(), total: provider.totalCount() };
      const concept = await provider.nextContext(iterator);
      expect(concept).toBeNull();
    });
  });

  describe('Filter Support', () => {
    test('should support code regex filters', async () => {
      expect(await provider.doesFilter('code', 'regex', 'US.*')).toBe(true);
    });

    test('should not support other filters', async () => {
      expect(await provider.doesFilter('display', 'regex', 'test')).toBe(false);
      expect(await provider.doesFilter('code', 'equals', 'US')).toBe(false);
      expect(await provider.doesFilter('code', 'contains', 'US')).toBe(false);
    });

  });

  describe('Regex Filtering', () => {
    test('should filter by 2-letter code pattern', async () => {
      const ctxt = await provider.getPrepContext(false);
      await provider.filter(ctxt, true, 'code', 'regex', 'U[S|A]');
      const filters = await provider.executeFilters(ctxt);
      expect(filters[0]).toBeTruthy();
      expect(filters[0].list).toBeTruthy();
      expect(filters[0].cursor).toBe(-1);

      const size = await provider.filterSize(ctxt, filters[0]);
      expect(size).toBeGreaterThan(0);

      // Check that results match pattern
      const results = [];
      filters[0].cursor = -1;
      while (await provider.filterMore(ctxt, filters[0])) {
        const concept = await provider.filterConcept(ctxt, filters[0]);
        results.push(concept);
      }

      // Should find US and UA
      const codes = results.map(c => c.code);
      expect(codes).toContain('US');
      expect(codes).toContain('UA'); // If UK exists in dataset
    });

    test('should filter by 3-letter code pattern', async () => {
      const ctxt = await provider.getPrepContext(false);
      await provider.filter(ctxt, true, 'code', 'regex', 'US.*');
      const filters = await provider.executeFilters(ctxt);
      const filter = filters[0];

      const results = [];
      filter.cursor = -1;
      while (await provider.filterMore(ctxt, filter)) {
        const concept = await provider.filterConcept(ctxt, filter);
        results.push(concept);
      }

      // Should find USA, possibly others starting with US
      const codes = results.map(c => c.code);
      expect(codes).toContain('USA');

      // All results should start with 'US'
      for (const code of codes) {
        expect(code).toMatch(/^US/);
      }
    });

    test('should filter by numeric code pattern', async () => {
      const ctxt = await provider.getPrepContext(false);
      await provider.filter(ctxt, true, 'code', 'regex', '8[0-9]{2}');
      const filters = await provider.executeFilters(ctxt);
      const filter = filters[0];

      const results = [];
      filter.cursor = -1;
      while (await provider.filterMore(ctxt, filter)) {
        const concept = await provider.filterConcept(ctxt, filter);
        results.push(concept);
      }

      expect(results.length).toBeGreaterThan(0);

      // All results should be 3-digit numbers starting with 8
      const codes = results.map(c => c.code);
      for (const code of codes) {
        expect(code).toMatch(/^8\d{2}$/);
      }

      // Should include 840 (USA)
      expect(codes).toContain('840');
    });

    test('should filter by exact match pattern', async () => {
      const ctxt = await provider.getPrepContext(false);
      await provider.filter(ctxt, true, 'code', 'regex', 'US');
      const filters = await provider.executeFilters(ctxt);
      const filter = filters[0];

      const results = [];
      filter.cursor = -1;
      while (await provider.filterMore(ctxt, filter)) {
        const concept = await provider.filterConcept(ctxt, filter);
        results.push(concept);
      }

      // Should find exactly 'US'
      expect(results.length).toBe(1);
      expect(results[0].code).toBe('US');
    });

    test('a pattern with alternation matches whole codes only', async () => {
      // '^' + 'US|CA' + '$' would be "starts with US or ends with CA", taking in USA
      const ctxt = await provider.getPrepContext(false);
      await provider.filter(ctxt, true, 'code', 'regex', 'US|CA');
      const filters = await provider.executeFilters(ctxt);
      const filter = filters[0];

      const results = [];
      filter.cursor = -1;
      while (await provider.filterMore(ctxt, filter)) {
        const concept = await provider.filterConcept(ctxt, filter);
        results.push(concept.code);
      }

      expect(results.sort()).toEqual(['CA', 'US']);
    });

    test('should filter all 2-letter codes', async () => {
      const ctxt = await provider.getPrepContext(false);
      await provider.filter(ctxt, true, 'code', 'regex', '[A-Z]{2}');
      const filters = await provider.executeFilters(ctxt);
      const filter = filters[0];

      const size = await provider.filterSize(ctxt, filter);
      expect(size).toBeGreaterThan(100); // Should have many 2-letter codes

      // Sample some results
      const results = [];
      filter.cursor = -1;
      for (let i = 0; i < 10 && await provider.filterMore(ctxt, filter); i++) {
        const concept = await provider.filterConcept(ctxt, filter);
        results.push(concept);
      }

      // All should be exactly 2 uppercase letters
      for (const concept of results) {
        expect(concept.code).toMatch(/^[A-Z]{2}$/);
      }
    });

    test('should filter all 3-letter codes', async () => {
      const ctxt = await provider.getPrepContext(false);
      await provider.filter(ctxt, true, 'code', 'regex', '[A-Z]{3}');
      const filters = await provider.executeFilters(ctxt);
      const filter = filters[0];

      const size = await provider.filterSize(ctxt, filter);
      expect(size).toBeGreaterThan(100); // Should have many 3-letter codes

      // Sample some results
      const results = [];
      filter.cursor = -1;
      for (let i = 0; i < 10 && await provider.filterMore(ctxt, filter); i++) {
        const concept = await provider.filterConcept(ctxt, filter);
        results.push(concept);
      }

      // All should be exactly 3 uppercase letters
      for (const concept of results) {
        expect(concept.code).toMatch(/^[A-Z]{3}$/);
      }
    });

    test('should filter all numeric codes', async () => {
      const ctxt = await provider.getPrepContext(false);
      await provider.filter(ctxt, true, 'code', 'regex', '\\d{3}');
      const filters = await provider.executeFilters(ctxt);
      const filter = filters[0];

      const size = await provider.filterSize(ctxt, filter);
      expect(size).toBeGreaterThan(100); // Should have many numeric codes

      // Sample some results
      const results = [];
      filter.cursor = -1;
      for (let i = 0; i < 10 && await provider.filterMore(ctxt, filter); i++) {
        const concept = await provider.filterConcept(ctxt, filter);
        results.push(concept);
      }

      // All should be exactly 3 digits
      for (const concept of results) {
        expect(concept.code).toMatch(/^\d{3}$/);
      }
    });

    test('should handle empty filter results', async () => {
      const ctxt = await provider.getPrepContext(false);
      await provider.filter(ctxt, true, 'code', 'regex', 'ZZZZZ');
      const filters = await provider.executeFilters(ctxt);
      const filter = filters[0];

      const size = await provider.filterSize(ctxt, filter);
      expect(size).toBe(0);

      expect(await provider.filterMore(ctxt, filter)).toBe(false);
    });

    test('should locate specific code in filter', async () => {
      const ctxt = await provider.getPrepContext(false);
      await provider.filter(ctxt, true, 'code', 'regex', 'US.*');
      const filters = await provider.executeFilters(ctxt);
      const filter = filters[0];

      const result = await provider.filterLocate(ctxt, filter, 'USA');
      expect(result).toBeTruthy();
      expect(typeof result).not.toBe('string'); // Should not be error message
      expect(result.code).toBe('USA');
    });

    test('should not locate code not in filter', async () => {
      const ctxt = await provider.getPrepContext(false);
      await provider.filter(ctxt, true, 'code', 'regex', 'US.*');
      const filters = await provider.executeFilters(ctxt);
      const filter = filters[0];

      const result = await provider.filterLocate(ctxt, filter, 'CAN');
      expect(result).toBeNull();
    });

    test('should check if concept is in filter', async () => {
      const ctxt = await provider.getPrepContext(false);
      await provider.filter(ctxt, true, 'code', 'regex', 'US.*');
      const filters = await provider.executeFilters(ctxt);
      const filter = filters[0];

      // Find a concept in the filter
      filter.cursor = -1;
      await provider.filterMore(ctxt, filter);
      const concept = await provider.filterConcept(ctxt, filter);

      const isInFilter = await provider.filterCheck(ctxt, filter, concept);
      expect(isInFilter).toBe(true);
    });
  });

  describe('Filter Error Cases', () => {
    test('should throw error for unsupported property', async () => {
      await expect(
        provider.filter(await provider.getPrepContext(false), true, 'display', 'regex', 'test')
      ).rejects.toMatchObject({ message: expect.stringContaining('not supported'), msgId: 'FILTER_NOT_UNDERSTOOD', statusCode: 422 });
    });

    test('should throw error for unsupported operator', async () => {
      await expect(
        provider.filter(await provider.getPrepContext(false), true, 'code', 'equals', 'US')
      ).rejects.toThrow('not supported');
    });

    test('should throw error for invalid regex', async () => {
      await expect(
        provider.filter(await provider.getPrepContext(false), true, 'code', 'regex', '[invalid')
      ).rejects.toMatchObject({ message: expect.stringContaining('Invalid regex pattern'), cause: 'invalid', statusCode: 400 });
    });

    test('should throw error for search filter', async () => {
      await expect(
        provider.searchFilter(await provider.getPrepContext(false), 'test', false)
      ).rejects.toThrow('Text Search is not supported');
    });

  });

  describe('Execute Filters', () => {
    test('should execute single filter', async () => {
      const ctxt = await provider.getPrepContext(false);
      await provider.filter(ctxt, true, 'code', 'regex', 'US.*');
      const results = await provider.executeFilters(ctxt);

      expect(results).toBeTruthy();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(1);
    });

    test('should indicate filters are closed', async () => {
      expect(await provider.filtersNotClosed(await provider.getPrepContext(false))).toBe(false);
    });
  });

  describe('Subsumption', () => {
    test('should not support subsumption', async () => {
      expect(await provider.subsumesTest('US', 'USA')).toBe('not-subsumed');
      expect(await provider.subsumesTest('USA', 'US')).toBe('not-subsumed');
    });

    test('should return error for locateIsA', async () => {
      const result = await provider.locateIsA('US', 'USA');
      expect(result.context).toBeNull();
      expect(result.message).toContain('does not have parents');
    });
  });

  describe('Factory Functionality', () => {
    test('should track usage count', () => {
      const factory = new CountryCodeFactoryProvider(opContext.i18n);
      expect(factory.useCount()).toBe(0);

      factory.build(opContext, []);
      expect(factory.useCount()).toBe(1);

      factory.build(opContext, []);
      expect(factory.useCount()).toBe(2);
    });

    test('should return correct default version', () => {
      expect(factory.defaultVersion()).toBe('2018');
    });

    test('should build working providers', () => {
      const provider1 = factory.build(opContext, []);
      const provider2 = factory.build(opContext, []);

      expect(provider1).toBeTruthy();
      expect(provider2).toBeTruthy();
      expect(provider1.totalCount()).toBe(provider2.totalCount());
    });

  });

  describe('Data Validation', () => {
    test('should have multiple formats for same countries', async () => {
      // Test that USA appears in multiple formats
      const us2 = await provider.locate('US');
      const us3 = await provider.locate('USA');
      const usNum = await provider.locate('840');

      expect(us2.context).toBeTruthy();
      expect(us3.context).toBeTruthy();
      expect(usNum.context).toBeTruthy();

      // All should refer to United States
      const display2 = await provider.display(us2.context);
      const display3 = await provider.display(us3.context);
      const displayNum = await provider.display(usNum.context);

      expect(display2).toContain('United States');
      expect(display3).toContain('United States');
      expect(displayNum).toContain('United States');
    });

    test('should have comprehensive country coverage', async () => {
      // Test major countries exist in all formats
      const majorCountries = [
        { two: 'CA', three: 'CAN', num: '124', name: 'Canada' },
        { two: 'GB', three: 'GBR', num: '826', name: 'United Kingdom' },
        { two: 'DE', three: 'DEU', num: '276', name: 'Germany' },
        { two: 'JP', three: 'JPN', num: '392', name: 'Japan' }
      ];

      for (const country of majorCountries) {
        const result2 = await provider.locate(country.two);
        const result3 = await provider.locate(country.three);
        const resultNum = await provider.locate(country.num);

        expect(result2.context).toBeTruthy();
        expect(result3.context).toBeTruthy();
        expect(resultNum.context).toBeTruthy();

        const display2 = await provider.display(result2.context);
        const display3 = await provider.display(result3.context);
        const displayNum = await provider.display(resultNum.context);

        expect(display2).toContain(country.name);
        expect(display3).toContain(country.name);
        expect(displayNum).toContain(country.name);
      }
    });
  });

  describe('Filter Cleanup', () => {
    test('should not throw on filter finish', () => {
      expect(() => {
        provider.filterFinish(null);
      }).not.toThrow();
    });
  });
});