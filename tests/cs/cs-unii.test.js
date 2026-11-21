const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { Languages } = require('../../library/languages');
const { UniiServicesFactory, UniiConcept } = require('../../tx/cs/cs-unii');
const { UniiDataMigrator } = require('../../tx/importers/import-unii.module');
const {OperationContext} = require("../../tx/operation-context");
const {Designations} = require("../../tx/library/designations");
const {TestUtilities} = require("../test-utilities");

describe('UniiDataMigrator', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const sourceFile = path.join(repoRoot, 'tests', 'data', 'unii-source-testing.txt');
  const destFile = path.join(repoRoot, 'data', 'unii-testing.db');

  test('should create database file', async () => {
    // Check that source file exists
    expect(fs.existsSync(sourceFile)).toBe(true);

    // Clean up any existing database file
    if (fs.existsSync(destFile)) {
      fs.unlinkSync(destFile);
    }

    // Run migration
    await new UniiDataMigrator().migrate(sourceFile, destFile, '20250702', false);

    expect(fs.existsSync(destFile)).toBe(true);
    const db = new sqlite3.Database(destFile);

    try {
      const count = await new Promise((resolve, reject) => {
        db.get('SELECT COUNT(*) as count FROM Unii', (err, row) => {
          if (err) reject(err);
          else resolve(row.count);
        });
      });

      expect(count).toBeGreaterThan(0);
    } finally {
      await new Promise((resolve) => {
        db.close(() => resolve());
      });
    }
  }, 3000000);

});

describe('UniiServices', () => {
  let factory;
  let provider;
  let opContext;

  beforeEach(async () => {
    opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    factory = new UniiServicesFactory(opContext.i18n, './data/unii-testing.db');
    await factory.load();
    provider = factory.build(opContext, []);
  });

  afterEach(() => {
    if (provider) {
      provider.close();
    }
  });

  describe('Basic Functionality', () => {
    test('should return correct system URI', () => {
      expect(provider.system()).toBe('http://fdasis.nlm.nih.gov');
    });

    test('should return correct description', () => {
      expect(provider.description()).toBe('UNII Codes');
    });

    test('should return -1 for total count (database-driven)', () => {
      expect(provider.totalCount()).toBe(-1);
    });

    test('should not have parents', () => {
      expect(provider.hasParents()).toBe(false);
    });

    test('should return version from database', async () => {
      const version = await provider.version();
      expect(version).toBeDefined();
      expect(typeof version).toBe('string');
    });
  });

  describe('Code Lookup', () => {
    test('should locate valid UNII codes', async () => {
      const testCodes = [
        '2T8Q726O95', // LAMIVUDINE
        'O414PZ4LPZ', // SALICYLIC ACID
        'A00HE5JO7O', // VIBOZILIMOD POTASSIUM
        '0GYJ8CJ1DE', // VIBOZILIMOD
        '52V6AS6U0A'  // AMLENETUG
      ];

      for (const code of testCodes) {
        const result = await provider.locate(code);
        expect(result.context).toBeTruthy();
        expect(result.message).toBeUndefined();
        expect(result.context).toBeInstanceOf(UniiConcept);
        expect(result.context.code).toBe(code);
      }
    });

    test('should return error for invalid codes', async () => {
      const result = await provider.locate('INVALID123');
      expect(result.context).toBeNull();
      expect(result.message).toContain('not found');
    });

    test('should return error for empty codes', async () => {
      const result = await provider.locate('');
      expect(result.context).toBeNull();
      expect(result.message).toBe('Empty code');
    });

    test('should return correct displays for known codes', async () => {
      const testCases = [
        ['2T8Q726O95', 'LAMIVUDINE'],
        ['O414PZ4LPZ', 'SALICYLIC ACID'],
        ['A00HE5JO7O', 'VIBOZILIMOD POTASSIUM'],
        ['0GYJ8CJ1DE', 'VIBOZILIMOD'],
        ['52V6AS6U0A', 'AMLENETUG']
      ];

      for (const [code, expectedDisplay] of testCases) {
        const result = await provider.locate(code);
        const display = await provider.display(result.context);
        expect(display).toBe(expectedDisplay);
      }
    });

    test('should return trimmed displays', async () => {
      const result = await provider.locate('2T8Q726O95');
      const display = await provider.display(result.context);
      expect(display).not.toMatch(/^\s|\s$/); // No leading/trailing whitespace
    });

    test('should return null definition', async () => {
      const result = await provider.locate('2T8Q726O95');
      const definition = await provider.definition(result.context);
      expect(definition).toBeNull();
    });

    test('should return false for abstract, inactive, deprecated', async () => {
      const result = await provider.locate('2T8Q726O95');
      expect(await provider.isAbstract(result.context)).toBe(false);
      expect(await provider.isInactive(result.context)).toBe(false);
      expect(await provider.isDeprecated(result.context)).toBe(false);
    });

    test('should return code through code method', async () => {
      const testCodes = ['2T8Q726O95', 'O414PZ4LPZ', 'A00HE5JO7O'];

      for (const testCode of testCodes) {
        const result = await provider.locate(testCode);
        const code = await provider.code(result.context);
        expect(code).toBe(testCode);
      }
    });
  });

  describe('Designations and Additional Descriptions', () => {
    test('should return designations with main display and others', async () => {
      const result = await provider.locate('2T8Q726O95'); // LAMIVUDINE
      const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
      await provider.designations(result.context, designations);

      expect(designations).toBeTruthy();
      expect(designations.count).toBeGreaterThan(1); // Should have main display + others

      // Should have main display designation
      const mainDesignation = designations.designations.find(d => d.value === 'LAMIVUDINE');
      expect(mainDesignation).toBeTruthy();
      expect(mainDesignation.language.code).toBe('en');

      // Should have other descriptions from UniiDesc table
      const hasOtherDesignations = designations.designations.some(d =>
        d.value.includes('3TC') ||
        d.value.includes('EPIVIR') ||
        d.value.includes('COMBIVIR')
      );
      expect(hasOtherDesignations).toBe(true);
    });

    test('should include others array in concept', async () => {
      const result = await provider.locate('2T8Q726O95'); // LAMIVUDINE
      const concept = result.context;

      expect(concept.others).toBeDefined();
      expect(Array.isArray(concept.others)).toBe(true);
      expect(concept.others.length).toBeGreaterThan(0);

      // Should contain some known descriptions from the sample data
      const othersString = concept.others.join(' ');
      expect(othersString).toMatch(/3TC|EPIVIR|COMBIVIR|LAMIVUDINE \[/);
    });

    test('should handle concepts with fewer descriptions', async () => {
      const result = await provider.locate('US4RZW252L'); // LAMIVUDINE, CIS-(+/-)-
      const concept = result.context;

      expect(concept.others).toBeDefined();
      expect(Array.isArray(concept.others)).toBe(true);
      // This one should have fewer descriptions than the main LAMIVUDINE entry
    });

    test('should not duplicate descriptions in others array', async () => {
      const result = await provider.locate('2T8Q726O95'); // LAMIVUDINE
      const concept = result.context;

      // Check for duplicates in others array
      const uniqueOthers = [...new Set(concept.others)];
      expect(concept.others.length).toBe(uniqueOthers.length);
    });
  });

  describe('Iterator Functionality', () => {
    test('should return basic iterator info', async () => {
      const iterator = await provider.iterator(null);
      expect(iterator).toBeNull();
    });

    test('should return null iterator for specific concept', async () => {
      const result = await provider.locate('2T8Q726O95');
      const iterator = await provider.iterator(result.context);
      expect(iterator).toBeNull();
    });

    test('should throw error on nextContext', async () => {
      const iterator = await provider.iterator(null);
      const next = await  provider.nextContext(iterator);
      expect(next).toBeNull();
    });
  });

  describe('Context Handling', () => {
    test('should handle string codes through ensureContext', async () => {
      const code = await provider.code('2T8Q726O95');
      const display = await provider.display('2T8Q726O95');

      expect(code).toBe('2T8Q726O95');
      expect(display).toBe('LAMIVUDINE');
    });

    test('should handle UniiConcept objects through ensureContext', async () => {
      const result = await provider.locate('O414PZ4LPZ');
      const concept = result.context;

      const code = await provider.code(concept);
      const display = await provider.display(concept);

      expect(code).toBe('O414PZ4LPZ');
      expect(display).toBe('SALICYLIC ACID');
    });

    test('should handle null codes', async () => {
      const code = await provider.code(null);
      const display = await provider.display(null);

      expect(code).toBeNull();
      expect(display).toBeNull();
    });

    test('should throw error for unknown context types', async () => {
      await expect(
        provider.code(123)  // number, not string
      ).rejects.toThrow('Unknown Type at #ensureContext: number');
    });

    test('should throw error for invalid string codes', async () => {
      await expect(
        provider.code('INVALID123')
      ).rejects.toThrow('not found');
    });
  });

  describe('Factory Functionality', () => {
    test('should track usage count', () => {
      const factory = new UniiServicesFactory(opContext.i18n, './data/unii-testing.db');
      expect(factory.useCount()).toBe(0);

      const provider1 = factory.build(opContext, []);
      expect(factory.useCount()).toBe(1);

      const provider2 = factory.build(opContext, []);
      expect(factory.useCount()).toBe(2);

      provider1.close();
      provider2.close();
    });

    test('should return unknown for default version', () => {
      const factory = new UniiServicesFactory(opContext.i18n, './data/unii-testing.db');
      expect(factory.defaultVersion()).toBe('unknown');
    });

    test('should build working providers', () => {
      const factory = new UniiServicesFactory(opContext.i18n, './data/unii-testing.db');
      const provider1 = factory.build(opContext, []);
      const provider2 = factory.build(opContext, []);

      expect(provider1).toBeTruthy();
      expect(provider2).toBeTruthy();
      expect(provider1.system()).toBe(provider2.system());

      provider1.close();
      provider2.close();
    });

    test('should increment uses on recordUse', () => {
      const factory = new UniiServicesFactory(opContext.i18n, './data/unii-testing.db');
      expect(factory.useCount()).toBe(0);

      factory.recordUse();
      expect(factory.useCount()).toBe(1);

      factory.recordUse();
      expect(factory.useCount()).toBe(2);
    });
  });

  describe('Specific UNII Categories', () => {
    test('should find pharmaceutical compounds', async () => {
      const pharmaceuticals = [
        ['2T8Q726O95', 'LAMIVUDINE'],
        ['US4RZW252L', 'LAMIVUDINE, CIS-(+/-)- '],
        ['A00HE5JO7O', 'VIBOZILIMOD POTASSIUM'],
        ['0GYJ8CJ1DE', 'VIBOZILIMOD']
      ];

      for (const [code, expectedDisplay] of pharmaceuticals) {
        const result = await provider.locate(code);
        expect(result.context).toBeTruthy();

        const display = await provider.display(result.context);
        expect(display.trim()).toBe(expectedDisplay.trim());
      }
    });

    test('should find chemical compounds', async () => {
      const result = await provider.locate('O414PZ4LPZ'); // SALICYLIC ACID
      expect(result.context).toBeTruthy();

      const display = await provider.display(result.context);
      expect(display).toBe('SALICYLIC ACID');

      const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
      await provider.designations(result.context, designations);
      const designationValues = designations.designations.map(d => d.value);
      expect(designationValues).toContain('2-HYDROXYBENZOIC ACID [FHFI]');
    });

    test('should find biological products', async () => {
      const result = await provider.locate('52V6AS6U0A'); // AMLENETUG
      expect(result.context).toBeTruthy();

      const display = await provider.display(result.context);
      expect(display).toBe('AMLENETUG');

      const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
      await provider.designations(result.context, designations);

      const designationValues = designations.designations.map(d => d.value);
      const hasMonoclonalAntibody = designationValues.some(v =>
        v.includes('MONOCLONAL ANTIBODY') || v.includes('IMMUNOGLOBULIN')
      );
      expect(hasMonoclonalAntibody).toBe(true);
    });
  });

  describe('Error Handling', () => {
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

    test('should handle case sensitivity appropriately', async () => {
      // Test lowercase version of a known code
      const result = await provider.locate('2t8q726o95');
      expect(result.context).toBeNull();
      expect(result.message).toContain('not found');
    });
  });

  describe('Edge Cases', () => {

    test('should handle concepts with empty displays', async () => {
      // Some UNII codes might have empty display names
      const result = await provider.locate('M3CPC50MZS'); // Empty display in sample data
      if (result.context) {
        const display = await provider.display(result.context);
        expect(typeof display).toBe('string');
      }
    });

    test('should handle repeated lookups correctly', async () => {
      for (let i = 0; i < 3; i++) {
        const result = await provider.locate('2T8Q726O95');
        expect(result.context).toBeTruthy();
        expect(result.message).toBeUndefined();

        const display = await provider.display(result.context);
        expect(display).toBe('LAMIVUDINE');
      }
    });

    test('should handle concepts with no additional descriptions', async () => {
      // Test a concept that might have no UniiDesc entries
      const result = await provider.locate('US4RZW252L');
      if (result.context) {
        expect(result.context.others).toBeDefined();
        expect(Array.isArray(result.context.others)).toBe(true);
      }
    });

    test('should properly close database connections', () => {
      const provider1 = factory.build(opContext, []);
      const provider2 = factory.build(opContext, []);

      expect(() => {
        provider1.close();
        provider2.close();
      }).not.toThrow();

      // Should handle double close gracefully
      expect(() => {
        provider1.close();
      }).not.toThrow();
    });
  });

  describe('Language Support', () => {
    test('should support English displays', async () => {
      const result = await provider.locate('2T8Q726O95');
      const display = await provider.display(result.context);
      expect(display).toBe('LAMIVUDINE');
    });

    test('should handle hasAnyDisplays for English', () => {
      const languages = Languages.fromAcceptLanguage('en');
      expect(provider.hasAnyDisplays(languages)).toBe(true);
    });

    test('should return English designations', async () => {
      const result = await provider.locate('2T8Q726O95');
      const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
      await provider.designations(result.context, designations);

      designations.designations.forEach(designation => {
        expect(designation.language.code).toBe('en');
      });
    });
  });

  describe('Database Schema Validation', () => {
    test('should handle all expected UNII types from sample data', async () => {
      const result = await provider.locate('O414PZ4LPZ'); // SALICYLIC ACID
      const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
      await provider.designations(result.context, designations);

      // Should have different types of descriptions (cn, cd, bn, of)
      expect(designations.count).toBeGreaterThan(5);

      const values = designations.designations.map(d => d.value);
      expect(values).toContain('SALICYLIC ACID');
      expect(values.some(v => v.includes('EP IMPURITY'))).toBe(true);
      expect(values.some(v => v.includes('VANDF'))).toBe(true);
    });

    test('should properly handle preferred terms (of type)', async () => {
      // The 'of' type should be the preferred term/main display
      const testCodes = ['2T8Q726O95', 'O414PZ4LPZ', 'A00HE5JO7O'];

      for (const code of testCodes) {
        const result = await provider.locate(code);
        expect(result.context.display).toBeTruthy();
        expect(result.context.display.trim().length).toBeGreaterThan(0);
      }
    });
  });
});