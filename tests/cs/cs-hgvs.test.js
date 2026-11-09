const { HGVSServices, HGVSServicesFactory, HGVSCode } = require('../../tx/cs/cs-hgvs');
const { OperationContext } = require('../../tx/operation-context');
const {Designations} = require("../../tx/library/designations");
const {TestUtilities} = require("../test-utilities");

describe('HGVS Provider', () => {
  let factory;
  let provider;
  let opContext;

  // Test data - known HGVS examples
  const testData = {
    // These are example HGVS codes that should be valid if the service is working
    potentiallyValidCodes: [
      'NM_000518.5:c.1521_1523del',
      'NC_000023.11:g.32867861G>A',
      'NP_000509.1:p.Phe508del'
    ],
    // These should definitely be invalid
    invalidCodes: [
      'invalid_hgvs_code',
      'not.a.real:code',
      '12345',
      ''
    ],
    expectedVersion: '2.0',
    expectedSystem: 'http://varnomen.hgvs.org'
  };

  beforeAll(async () => {
    // Create factory and provider
    opContext = new OperationContext('en', await TestUtilities.loadTranslations());
    factory = new HGVSServicesFactory(opContext.i18n);
    provider = await factory.build(opContext, []);
  });

  describe('Factory and Basic Setup', () => {
    test('should create factory and provider', () => {
      expect(factory).toBeDefined();
      expect(provider).toBeDefined();
      expect(provider).toBeInstanceOf(HGVSServices);
    });

    test('should check service status', () => {
      const status = HGVSServicesFactory.checkService();
      expect(status).toContain('OK');
      expect(status).toContain('External validation service');
    });

    test('should have correct system URI', () => {
      expect(provider.system()).toBe(testData.expectedSystem);
    });

    test('should have correct description', () => {
      expect(provider.description()).toBe('HGVS validator');
    });

    test('should return correct version', async () => {
      const version = await provider.version();
      expect(version).toBe(testData.expectedVersion);
    });

    test('should return zero total count', async () => {
      const count = await provider.totalCount();
      expect(count).toBe(0);
    });

    test('should default to latest', () => {
      expect(provider.defaultToLatest()).toBe(true);
    });

  });

  describe('Code Validation (External Service)', () => {
    // These tests depend on external service availability
    test('should handle empty code', async () => {
      const result = await provider.locate('');
      expect(result.context).toBeNull();
      expect(result.message).toContain('Empty code');
    });

    test('should attempt to validate HGVS codes', async () => {
      // Test with a potentially valid code
      const testCode = testData.potentiallyValidCodes[0];

      try {
        const result = await provider.locate(testCode);

        // The result could be either valid or invalid depending on service availability
        if (result.context) {
          expect(result.context).toBeInstanceOf(HGVSCode);
          expect(result.context.code).toBe(testCode);
          expect(result.message).toBeNull();
        } else {
          expect(result.message).toBeDefined();
        }
      } catch (error) {
        // This is acceptable - external service might not be available during testing
        expect(error.message).toContain('Error validating HGVS code');
      }
    }, 10000); // 10 second timeout for network requests

    test('should handle obviously invalid codes', async () => {
      const invalidCode = testData.invalidCodes[1]; // 'not.a.real:code'

      let result;
      try {
        result = await provider.locate(invalidCode);
      } catch (error) {
        // Still acceptable - service might be down
        expect(error.message).toContain('Error validating HGVS code');
        return;
      }

      // Should return null context for invalid codes
      expect(result.context).toBeNull();
      expect(result.message).toBeDefined();
    }, 10000);

    test('should handle network timeouts gracefully', async () => {
      // This test might timeout, which is expected behavior
      const testCode = testData.potentiallyValidCodes[1];

      try {
        await provider.locate(testCode);
        // If we get here, the service responded
      } catch (error) {
        // Should handle timeout/network errors gracefully
        expect(error.message).toMatch(/Error validating HGVS code|timeout|network/i);
      }
    }, 10000);
  });

  describe('Code Operations', () => {
    test('should return code for valid context', async () => {
      const testCode = 'NM_000518.5:c.1521_1523del';
      const context = new HGVSCode(testCode);

      const code = await provider.code(context);
      expect(code).toBe(testCode);
    });

    test('should return null for invalid context', async () => {
      const code = await provider.code('invalid');
      expect(code).toBeNull();
    });

    test('should return display same as code', async () => {
      const testCode = 'NM_000518.5:c.1521_1523del';
      const context = new HGVSCode(testCode);

      const display = await provider.display(context);
      expect(display).toBe(testCode);
    });

    test('should return empty definition', async () => {
      const context = new HGVSCode('test');
      const definition = await provider.definition(context);
      expect(definition).toBe('');
    });

    test('should return false for abstract/inactive', async () => {
      const context = new HGVSCode('test');

      expect(await provider.isAbstract(context)).toBe(false);
      expect(await provider.isInactive(context)).toBe(false);
      expect(await provider.isDeprecated(context)).toBe(false);
    });
  });

  describe('Designations', () => {
    test('should return designations for valid context', async () => {
      const testCode = 'NM_000518.5:c.1521_1523del';
      const context = new HGVSCode(testCode);
      const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
      await provider.designations(context, designations);

      expect(designations.count).toBeGreaterThan(0);

      const firstDesignation = designations.designations[0];
      expect(firstDesignation.value).toBe(testCode);
    });

    test('should return empty array for null context', async () => {
      const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
      await provider.designations(null, designations);

      expect(designations.count).toBe(0);
    });
  });

  describe('Extended Lookup', () => {
    test('should handle extend lookup without errors', async () => {
      const testCode = 'NM_000518.5:c.1521_1523del';
      const params = { parameter: [] };

      // Should not throw error, but also shouldn't add any properties
      await provider.extendLookup(testCode, [], params);

      // HGVS doesn't add any extended properties
      expect(params.parameter.length).toBe(0);
    });
  });

  describe('Unsupported Hierarchy Operations', () => {
    test('should return null for locateIsA', async () => {
      const result = await provider.locateIsA('child', 'parent');
      expect(result).toBeNull();
    });

    test('should handle subsumption test', async () => {
      await expect(
        provider.subsumesTest('codeA', 'codeB')
      ).rejects.toThrow('Subsumption is not supported for HGVS');
    });
  });

  describe('Iterator Support', () => {
    test('should return empty iterator', async () => {
      const iterator = await provider.iterator(null);
      expect(iterator).toBeDefined();
      expect(iterator.total).toBe(0);
      expect(iterator.more()).toBe(false);
    });

    test('should return null from nextContext', async () => {
      const iterator = await provider.iterator(null);
      const context = await provider.nextContext(iterator);
      expect(context).toBeNull();
    });
  });

  describe('Filter Operations - All Unsupported', () => {
    test('should not support any filters', async () => {
      expect(await provider.doesFilter('any', 'equal', 'value')).toBe(false);
    });

    test('should throw errors for filter operations', async () => {
      await expect(provider.getPrepContext(true)).rejects.toThrow('not supported for HGVS');
      await expect(provider.searchFilter(null, 'filter', false)).rejects.toThrow('Text Search is not supported');
      await expect(provider.filter(null, 'prop', 'equal', 'value')).rejects.toThrow('not supported for HGVS');
      await expect(provider.prepare(null)).rejects.toThrow('not supported for HGVS');
      await expect(provider.executeFilters(null)).rejects.toThrow('not supported for HGVS');
      await expect(provider.filterSize(null, null)).rejects.toThrow('not supported for HGVS');
      await expect(provider.filterMore(null, null)).rejects.toThrow('not supported for HGVS');
      await expect(provider.filterConcept(null, null)).rejects.toThrow('not supported for HGVS');
      await expect(provider.filterLocate(null, null, 'code')).rejects.toThrow('not supported for HGVS');
      await expect(provider.filterCheck(null, null, null)).rejects.toThrow('not supported for HGVS');
      await expect(provider.filterFinish(null)).rejects.toThrow('not supported for HGVS');
    });

    test('should return false for filtersNotClosed', async () => {
      const result = await provider.filtersNotClosed(null);
      expect(result).toBe(false);
    });
  });

  describe('Other Operations', () => {
    test('should handle CDS info without errors', async () => {
      // Should not throw
      await provider.getCDSInfo(null, null, 'baseURL', 'code', 'display');
    });

    test('should handle define features without errors', async () => {
      const features = [];
      // Should not throw
      await provider.defineFeatures(features);
      expect(features.length).toBe(0);
    });
  });

  describe('Error Handling', () => {
    test('should handle null/undefined codes properly', async () => {
      const result = await provider.locate(null);
      expect(result.context).toBeNull();
    });
  });

  describe('Factory Operations', () => {
    test('should track factory usage', () => {
      const useCount = factory.useCount();
      expect(useCount).toBeGreaterThan(0);
    });

    test('should return correct default version', () => {
      expect(factory.defaultVersion()).toBe(testData.expectedVersion);
    });
  });

  describe('Integration Tests', () => {
    test('should handle complete workflow for potentially valid code', async () => {
      const testCode = testData.potentiallyValidCodes[0];

      // 1. Locate the code
      let locateResult;
      try {
        locateResult = await provider.locate(testCode);
      } catch (error) {
        // acceptable - the external service might not be available during testing
        expect(error.message).toContain('Error validating HGVS code');
        return;
      }

      // the service may reject the code; the rest of the workflow needs one it accepts
      if (locateResult.context) {
        // 2. Get code and display
        const code = await provider.code(locateResult.context);
        const display = await provider.display(locateResult.context);

        expect(code).toBe(testCode);
        expect(display).toBe(testCode);

        // 3. Get designations
        const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
        await provider.designations(locateResult.context, designations);
        expect(designations.count).toBeGreaterThan(0);
      }
    }, 10000);
  });

  describe('Edge Cases', () => {
    test('should handle very long codes', async () => {
      const longCode = 'NM_' + '0'.repeat(100) + ':c.1521_1523del';

      try {
        const result = await provider.locate(longCode);
        // Should either validate or reject, but not crash
        expect(result).toBeDefined();
        expect(result).toHaveProperty('context');
        expect(result).toHaveProperty('message');
      } catch (error) {
        // Network errors are acceptable
        expect(error.message).toContain('Error validating HGVS code');
      }
    }, 10000);

    test('should handle special characters in codes', async () => {
      const specialCode = 'NM_000518.5:c.1521_1523del(;)';

      try {
        const result = await provider.locate(specialCode);
        expect(result).toBeDefined();
      } catch (error) {
        // Should handle URL encoding issues gracefully
        expect(error.message).toContain('Error validating HGVS code');
      }
    }, 10000);
  });
});