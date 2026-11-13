const { OperationContext } = require('../../tx/operation-context');
const { AreaCodeFactoryProvider } = require('../../tx/cs/cs-areacode');
const { Languages } = require('../../library/languages');
const {TestUtilities} = require("../test-utilities");

describe('AreaCodeServices', () => {
  let factory;
  let provider;
  let opContext;

  beforeEach(async () => {
    opContext = new OperationContext('en', await TestUtilities.loadTranslations());
    factory = new AreaCodeFactoryProvider(opContext.i18n);
    await factory.load();
    provider = factory.build(opContext,[]);
  });

  describe('Basic Functionality', () => {
    test('should return correct system URI', () => {
      expect(provider.system()).toBe('http://unstats.un.org/unsd/methods/m49/m49.htm');
    });

    test('should return correct description', () => {
      expect(provider.description()).toBe('International area/region Codes');
    });

    test('should return total count greater than 0', () => {
      expect(provider.totalCount()).toBeGreaterThan(0);
      expect(provider.totalCount()).toBeGreaterThan(200); // Should have many countries + regions
    });

    test('should not have parents', () => {
      expect(provider.hasParents()).toBe(false);
    });
  });

  describe('Code Lookup', () => {
    test('should locate valid country codes', async () => {
      const result = await provider.locate('840'); // USA
      expect(result.context).toBeTruthy();
      expect(result.message).toBeNull();
      expect((await provider.code(result.context))).toBe('840');
    });

    test('should locate valid region codes', async () => {
      const result = await provider.locate('150'); // Europe
      expect(result.context).toBeTruthy();
      expect(result.message).toBeNull();
      expect((await provider.code(result.context))).toBe('150');
    });

    test('should return error for invalid codes', async () => {
      const result = await provider.locate('999');
      expect(result.context).toBeNull();
      expect(result.message).toBeUndefined();
    });

    test('should return correct displays', async () => {
      const usaResult = await provider.locate('840');
      const display = await provider.display(usaResult.context);
      expect(display).toBe('United States of America (USA)');

      const europeResult = await provider.locate('150');
      const europeDisplay = await provider.display(europeResult.context);
      expect(europeDisplay).toBe('Europe');
    });

    test('should return empty definition', async () => {
      const result = await provider.locate('840');
      const definition = await provider.definition(result.context);
      expect(definition).toBe(null);
    });

    test('should return false for abstract, inactive, deprecated', async () => {
      const result = await provider.locate('840');
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

      for (let i = 0; i < 10 && i < iterator.total; i++) {
        const concept = await provider.nextContext(iterator);
        expect(concept).toBeTruthy();
        concepts.push(concept);
      }

      expect(concepts.length).toBe(Math.min(10, iterator.total));
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

  describe('Filter Support',  () => {
    test('should support class/type equals filters', async () => {
      expect(await provider.doesFilter('class', '=', 'country')).toBe(true);
      expect(await provider.doesFilter('type', '=', 'region')).toBe(true);
    });

    test('should not support other filters', async () => {
      expect(await provider.doesFilter('display', '=', 'test')).toBe(false);
      expect(await provider.doesFilter('class', 'contains', 'country')).toBe(false);
      expect(await provider.doesFilter('class', 'in', 'country,region')).toBe(false);
    });

  });

  describe('Filter by Country', () => {
    let countryFilter;
    let ctxt;

    beforeEach(async () => {
      ctxt = await provider.getPrepContext(false);
      await provider.filter(ctxt, true, 'class', '=', 'country');
      const filters = await provider.executeFilters(ctxt);
      countryFilter = filters[0];
    });

    test('should create country filter', () => {
      expect(countryFilter).toBeTruthy();
      expect(countryFilter.list).toBeTruthy();
      expect(countryFilter.cursor).toBe(-1);
    });

    test('should return correct filter size for countries', async () => {
      const size = await provider.filterSize(ctxt, countryFilter);
      expect(size).toBeGreaterThan(190); // Should have many countries
      expect(size).toBeLessThan(300); // But not too many
    });

    test('should iterate through countries only', async () => {
      const countries = [];
      countryFilter.cursor = -1; // Reset cursor

      // Get first 10 countries
      for (let i = 0; i < 10; i++) {
        if (await provider.filterMore(ctxt, countryFilter)) {
          const concept = await provider.filterConcept(ctxt, countryFilter);
          expect(concept).toBeTruthy();
          expect(concept.class_).toBe('country');
          countries.push(concept);
        }
      }

      expect(countries.length).toBe(10);
    });

    test('should locate specific country in filter', async () => {
      const result = await provider.filterLocate(ctxt, countryFilter, '840'); // USA
      expect(result).toBeTruthy();
      expect(typeof result).not.toBe('string'); // Should not be error message
      expect(result.code).toBe('840');
      expect(result.class_).toBe('country');
    });

    test('should not locate region in country filter', async () => {
      const result = await provider.filterLocate(ctxt, countryFilter, '150'); // Europe
      expect(result).toBeNull();
    });

    test('should check if concept is in country filter', async () => {
      // Find a country concept
      countryFilter.cursor = -1;
      await provider.filterMore(ctxt, countryFilter);
      const countryConcept = await provider.filterConcept(ctxt, countryFilter);

      const isInFilter = await provider.filterCheck(ctxt, countryFilter, countryConcept);
      expect(isInFilter).toBe(true);
    });
  });

  describe('Filter by Region', () => {
    let regionFilter;
    let ctxt;

    beforeEach(async () => {
      ctxt = await provider.getPrepContext(false);
      await provider.filter(ctxt, true, 'type', '=', 'region');
      const filters = await provider.executeFilters(ctxt);
      regionFilter = filters[0];
    });

    test('should create region filter', () => {
      expect(regionFilter).toBeTruthy();
      expect(regionFilter.list).toBeTruthy();
      expect(regionFilter.cursor).toBe(-1);
    });

    test('should return correct filter size for regions', async () => {
      const size = await provider.filterSize(ctxt, regionFilter);
      expect(size).toBeGreaterThan(20); // Should have geographic regions
      expect(size).toBeLessThan(50); // But not too many
    });

    test('should iterate through regions only', async () => {
      const regions = [];
      regionFilter.cursor = -1; // Reset cursor

      // Get all regions
      while (await provider.filterMore(ctxt, regionFilter)) {
        const concept = await provider.filterConcept(ctxt, regionFilter);
        expect(concept).toBeTruthy();
        expect(concept.class_).toBe('region');
        regions.push(concept);
      }

      expect(regions.length).toBeGreaterThan(20);

      // Check for known regions
      const codes = regions.map(r => r.code);
      expect(codes).toContain('150'); // Europe
      expect(codes).toContain('002'); // Africa
      expect(codes).toContain('019'); // Americas
      expect(codes).toContain('142'); // Asia
      expect(codes).toContain('009'); // Oceania
    });

    test('should locate specific region in filter', async () => {
      const result = await provider.filterLocate(ctxt, regionFilter, '150'); // Europe
      expect(result).toBeTruthy();
      expect(typeof result).not.toBe('string'); // Should not be error message
      expect(result.code).toBe('150');
      expect(result.class_).toBe('region');
    });

    test('should not locate country in region filter', async () => {
      const result = await provider.filterLocate(ctxt, regionFilter, '840'); // USA
      expect(result).toBeNull();
    });
  });

  describe('Filter Error Cases', () => {
    test('should throw error for unsupported property', async () => {
      await expect(
        provider.filter(await provider.getPrepContext(false), true, 'display', '=', 'test')
      ).rejects.toMatchObject({ message: expect.stringContaining('not supported'), msgId: 'FILTER_NOT_UNDERSTOOD', statusCode: 422 });
    });

    test('should throw error for unsupported operator', async () => {
      await expect(
        provider.filter(await provider.getPrepContext(false), true, 'class', 'contains', 'country')
      ).rejects.toThrow('not supported');
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
      await provider.filter(ctxt, true, 'class', '=', 'country');
      const results = await provider.executeFilters(ctxt);
      const countryFilter = results[0];

      expect(results).toBeTruthy();
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(1);
      expect(results[0]).toBe(countryFilter);
    });

    test('should return empty array for null filter', async () => {
      const results = await provider.executeFilters(await provider.getPrepContext(false));
      expect(results).toEqual([]);
    });

    test('should indicate filters are closed', async () => {
      expect(await provider.filtersNotClosed(await provider.getPrepContext(false))).toBe(false);
    });
  });

  describe('Subsumption', () => {
    test('should not support subsumption', async () => {
      expect(await provider.subsumesTest('840', '150')).toBe('not-subsumed');
      expect(await provider.subsumesTest('150', '840')).toBe('not-subsumed');
    });

    test('should return error for locateIsA', async () => {
      const result = await provider.locateIsA('840', '150');
      expect(result.context).toBeNull();
      expect(result.message).toContain('does not have parents');
    });
  });

  describe('Factory Functionality', () => {
    test('should track usage count', () => {
      const factory = new AreaCodeFactoryProvider(opContext.i18n);
      expect(factory.useCount()).toBe(0);

      factory.build(new OperationContext(Languages.fromAcceptLanguage('en')), null, []);
      expect(factory.useCount()).toBe(1);

      factory.build(new OperationContext(Languages.fromAcceptLanguage('en')), null, []);
      expect(factory.useCount()).toBe(2);
    });

    test('should return null for default version', () => {
      expect(factory.defaultVersion()).toBeNull();
    });

    test('should build working providers', () => {
      const provider1 = factory.build(new OperationContext(Languages.fromAcceptLanguage('en')), null, []);
      const provider2 = factory.build(new OperationContext(Languages.fromAcceptLanguage('en')), null, []);

      expect(provider1).toBeTruthy();
      expect(provider2).toBeTruthy();
      expect(provider1.totalCount()).toBe(provider2.totalCount());
    });
  });

  describe('Specific Country/Region Tests', () => {
    test('should find major countries', async () => {
      const testCodes = [
        ['840', 'United States of America (USA)'],
        ['124', 'Canada (CAN)'],
        ['276', 'Germany (DEU)'],
        ['392', 'Japan (JPN)'],
        ['156', 'China (CHN)'],
        ['076', 'Brazil (BRA)']
      ];

      for (const [code, expectedDisplay] of testCodes) {
        const result = await provider.locate(code);
        expect(result.context).toBeTruthy();

        const display = await provider.display(result.context);
        expect(display).toBe(expectedDisplay);
        expect(result.context.class_).toBe('country');
      }
    });

    test('should find major regions', async () => {
      const testCodes = [
        ['001', 'World'],
        ['002', 'Africa'],
        ['019', 'Americas'],
        ['142', 'Asia'],
        ['150', 'Europe'],
        ['009', 'Oceania']
      ];

      for (const [code, expectedDisplay] of testCodes) {
        const result = await provider.locate(code);
        expect(result.context).toBeTruthy();

        const display = await provider.display(result.context);
        expect(display).toBe(expectedDisplay);
        expect(result.context.class_).toBe('region');
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