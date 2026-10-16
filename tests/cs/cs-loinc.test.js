const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { LoincDataMigrator } = require('../../tx/importers/import-loinc.module');
const { LoincServices, LoincServicesFactory, LoincProviderContext } = require('../../tx/cs/cs-loinc');
const { OperationContext } = require('../../tx/operation-context');
const {validateParameter} = require("../../library/utilities");
const {Designations, SearchFilterText} = require("../../tx/library/designations");
const {TestUtilities} = require("../test-utilities");
const folders = require('../../library/folder-setup');

describe('LOINC Module Import', () => {
  const testSourceDir = path.resolve(__dirname, '../../tx/data/loinc');
  const testDbPath = folders.ensureFilePath('loinc-testing.db');

  beforeAll(() => {
    // Ensure data directory exists
    const dataDir = path.dirname(testDbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Clean up any existing test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  afterAll(() => {
    // Clean up test database after tests
    // if (fs.existsSync(testDbPath)) {
    //   fs.unlinkSync(testDbPath);
    // }
  });

  test('should import LOINC test data successfully', async () => {
    // Verify source data exists
    expect(fs.existsSync(testSourceDir)).toBe(true);
    
    // Verify required LOINC files exist
    const requiredFiles = [
      'LoincTable/Loinc.csv',
      'AccessoryFiles/PartFile/Part.csv'
    ];
    
    for (const file of requiredFiles) {
      const filePath = path.join(testSourceDir, file);
      expect(fs.existsSync(filePath)).toBe(true);
    }

    // Create migrator and run import
    const migrator = new LoincDataMigrator();

    await migrator.migrate(
      testSourceDir,
      testDbPath,
      '2.80-test',
      {
        verbose: false, // Suppress console output during tests
        mainOnly: false // Include language variants
      }
    );

    // Verify database file was created
    expect(fs.existsSync(testDbPath)).toBe(true);
  }, 120000); // 120 second timeout for import

  test('should have all expected tables with data', async () => {
    // Open database connection
    const db = new sqlite3.Database(testDbPath);

    try {
      // Define expected tables and their minimum expected record counts
      const expectedTables = [
        { name: 'Config', minRecords: 2 }, // Should have at least version and system ID
        { name: 'Types', minRecords: 3 }, // Code, Part, AnswerList, Answer
        { name: 'Languages', minRecords: 1 }, // At least English
        { name: 'StatusCodes', minRecords: 5 }, // ACTIVE, DEPRECATED, etc.
        { name: 'RelationshipTypes', minRecords: 10 }, // Many relationship types
        { name: 'DescriptionTypes', minRecords: 3 }, // LONG_COMMON_NAME, SHORTNAME, etc.
        { name: 'PropertyTypes', minRecords: 5 }, // CLASSTYPE, ORDER_OBS, etc.
        { name: 'Codes', minRecords: 1 }, // Main codes, parts, answers
        { name: 'Relationships', minRecords: 1 }, // Part links, hierarchies
        { name: 'PropertyValues', minRecords: 1 }, // Property value lookups
        { name: 'Properties', minRecords: 1 }, // Code properties
        { name: 'Descriptions', minRecords: 1 }, // Code descriptions
        { name: 'Closure', minRecords: 1 } // Hierarchical relationships
      ];

      // Check each table
      for (const table of expectedTables) {
        const count = await getTableCount(db, table.name);

//        console.log(`✓ ${table.name}: ${count} records`);
        expect(count).toBeGreaterThanOrEqual(table.minRecords);
      }

      // Verify TextIndex virtual table exists and has data
      const textIndexCount = await getTableCount(db, 'TextIndex');
      expect(textIndexCount).toBeGreaterThan(0);
      // console.log(`✓ TextIndex: ${textIndexCount} records`);

      // Verify config table has correct entries
      const version = await getConfigValue(db, 2);
      expect(version).toBe('2.80-test');
      // console.log(`✓ Version: ${version}`);

      const systemId = await getConfigValue(db, 1);
      expect(systemId).toBeTruthy();
      // console.log(`✓ System ID: ${systemId}`);

    } finally {
      // Close database connection
      await closeDatabase(db);
    }
  });

  test('should have valid LOINC data structure', async () => {
    const db = new sqlite3.Database(testDbPath);

    try {
      // Verify we have main LOINC codes (Type = 1)
      const mainCodes = await getCodesByType(db, 1);
      expect(mainCodes).toBeGreaterThan(0);
      //console.log(`✓ Main LOINC codes: ${mainCodes}`);

      // Verify we have parts (Type = 2)
      const parts = await getCodesByType(db, 2);
      expect(parts).toBeGreaterThan(0);
      // console.log(`✓ LOINC parts: ${parts}`);

      // Verify codes have valid LOINC code format
      const invalidCodes = await getInvalidLoincCodes(db);
      expect(invalidCodes).toBe(0);
      // console.log(`✓ All codes have valid LOINC format`);

      // Verify relationships exist
      const relationshipCount = await getTableCount(db, 'Relationships');
      expect(relationshipCount).toBeGreaterThan(0);
      // console.log(`✓ Relationships: ${relationshipCount}`);

      // Verify descriptions exist for main codes
      const descriptionsCount = await getDescriptionsForMainCodes(db);
      expect(descriptionsCount).toBeGreaterThan(0);
      // console.log(`✓ Descriptions for main codes: ${descriptionsCount}`);

    } finally {
      await closeDatabase(db);
    }
  });

  test('should have language variants if available', async () => {
    const db = new sqlite3.Database(testDbPath);

    try {
      // Check if we have multiple languages
      const languageCount = await getTableCount(db, 'Languages');
      // console.log(`✓ Languages available: ${languageCount}`);

      // If we have language variants, there should be descriptions in multiple languages
      if (languageCount > 1) {
        const multiLangDescriptions = await getMultiLanguageDescriptions(db);
        expect(multiLangDescriptions).toBeGreaterThan(0);
        // console.log(`✓ Multi-language descriptions: ${multiLangDescriptions}`);
      } else {
        // console.log(`✓ Only English language found (expected for subset)`);
      }

    } finally {
      await closeDatabase(db);
    }
  });

  test('should have proper referential integrity', async () => {
    const db = new sqlite3.Database(testDbPath);

    try {
      // Verify relationships reference valid codes
      const orphanedRelationships = await getOrphanedRelationships(db);
      expect(orphanedRelationships).toBe(0);
      // console.log(`✓ No orphaned relationships found`);

      // Verify descriptions reference valid codes
      const orphanedDescriptions = await getOrphanedDescriptions(db);
      expect(orphanedDescriptions).toBe(0);
      // console.log(`✓ No orphaned descriptions found`);

      // Verify properties reference valid codes
      const orphanedProperties = await getOrphanedProperties(db);
      expect(orphanedProperties).toBe(0);
      // console.log(`✓ No orphaned properties found`);

      // Verify closure table references valid codes
      const orphanedClosure = await getOrphanedClosure(db);
      expect(orphanedClosure).toBe(0);
      // console.log(`✓ No orphaned closure entries found`);

    } finally {
      await closeDatabase(db);
    }
  });

  test('should have reasonable data distribution', async () => {
    const db = new sqlite3.Database(testDbPath);

    try {
      // Check that we have active codes
      const activeCodes = await getActiveCodesCount(db);
      expect(activeCodes).toBeGreaterThan(0);
      // console.log(`✓ Active codes: ${activeCodes}`);

      // Check that main codes have properties
      const codesWithProperties = await getCodesWithProperties(db);
      expect(codesWithProperties).toBeGreaterThan(0);
      // console.log(`✓ Codes with properties: ${codesWithProperties}`);

      // Check that we have various description types
      const descriptionTypes = await getUsedDescriptionTypes(db);
      expect(descriptionTypes).toBeGreaterThan(0);
      // console.log(`✓ Description types in use: ${descriptionTypes}`);

      // Check that we have various property types
      const propertyTypes = await getUsedPropertyTypes(db);
      expect(propertyTypes).toBeGreaterThan(0);
      // console.log(`✓ Property types in use: ${propertyTypes}`);

    } finally {
      await closeDatabase(db);
    }
  });
});

// Helper functions for database queries
function getTableCount(db, tableName) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT COUNT(*) as count FROM ${tableName}`, (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function getConfigValue(db, configKey) {
  return new Promise((resolve, reject) => {
    db.get('SELECT Value FROM Config WHERE ConfigKey = ?', [configKey], (err, row) => {
      if (err) reject(err);
      else resolve(row ? row.Value : null);
    });
  });
}

function getCodesByType(db, type) {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM Codes WHERE Type = ?', [type], (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function getInvalidLoincCodes(db) {
  return new Promise((resolve, reject) => {
    // LOINC codes should be in format like "1000-9" or "LP1234-5"
    db.get(`
      SELECT COUNT(*) as count
      FROM Codes 
      WHERE Type = 1 
        AND (
          Code = '' 
          OR Code IS NULL 
          OR LENGTH(Code) < 5 
          OR LENGTH(Code) > 15
          OR Code NOT GLOB '*-*'
        )
    `, (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function getDescriptionsForMainCodes(db) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT COUNT(DISTINCT d.CodeKey) as count
      FROM Descriptions d
      INNER JOIN Codes c ON d.CodeKey = c.CodeKey
      WHERE c.Type = 1
    `, (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function getMultiLanguageDescriptions(db) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT COUNT(*) as count
      FROM Descriptions d
      INNER JOIN Languages l ON d.LanguageKey = l.LanguageKey
      WHERE l.Code != 'en-US'
    `, (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function getOrphanedRelationships(db) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT COUNT(*) as count
      FROM Relationships r
      LEFT JOIN Codes cs ON r.SourceKey = cs.CodeKey
      LEFT JOIN Codes ct ON r.TargetKey = ct.CodeKey
      WHERE cs.CodeKey IS NULL OR ct.CodeKey IS NULL
    `, (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function getOrphanedDescriptions(db) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT COUNT(*) as count
      FROM Descriptions d
      LEFT JOIN Codes c ON d.CodeKey = c.CodeKey
      WHERE c.CodeKey IS NULL
    `, (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function getOrphanedProperties(db) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT COUNT(*) as count
      FROM Properties p
      LEFT JOIN Codes c ON p.CodeKey = c.CodeKey
      WHERE c.CodeKey IS NULL
    `, (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function getOrphanedClosure(db) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT COUNT(*) as count
      FROM Closure cl
      LEFT JOIN Codes ca ON cl.AncestorKey = ca.CodeKey
      LEFT JOIN Codes cd ON cl.DescendentKey = cd.CodeKey
      WHERE ca.CodeKey IS NULL OR cd.CodeKey IS NULL
    `, (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function getActiveCodesCount(db) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT COUNT(*) as count
      FROM Codes c
      INNER JOIN StatusCodes s ON c.StatusKey = s.StatusKey
      WHERE s.Description = 'ACTIVE'
    `, (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function getCodesWithProperties(db) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT COUNT(DISTINCT p.CodeKey) as count
      FROM Properties p
      INNER JOIN Codes c ON p.CodeKey = c.CodeKey
      WHERE c.Type = 1
    `, (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function getUsedDescriptionTypes(db) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT COUNT(DISTINCT DescriptionTypeKey) as count
      FROM Descriptions
    `, (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function getUsedPropertyTypes(db) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT COUNT(DISTINCT PropertyTypeKey) as count
      FROM Properties
    `, (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function closeDatabase(db) {
  return new Promise((resolve) => {
    db.close((err) => {
      if (err) console.warn('Error closing database:', err);
      resolve();
    });
  });
}

// Load expected results from JSON template
const expectedResults = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../data/loinc-test-expectations.json'),
  'utf8'
));

describe('LOINC Provider', () => {
  const testDbPath = path.resolve(__dirname, '../../data/loinc-testing.db');
  let factory;
  let provider;
  let opContext;

  beforeAll(async () => {
    // Verify test database exists (should be created by import tests)
    expect(fs.existsSync(testDbPath)).toBe(true);

    // Create factory and provider
    opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    factory = new LoincServicesFactory(opContext.i18n, testDbPath);
    provider = await factory.build(opContext, []);
  });

  afterAll(() => {
    if (provider) {
      provider.close();
    }
  });

  describe('Factory and Basic Setup', () => {
    test('should create factory and provider', () => {
      expect(factory).toBeDefined();
      expect(provider).toBeDefined();
      expect(provider).toBeInstanceOf(LoincServices);
    });

    test('should have correct system URI', () => {
      expect(provider.system()).toBe('http://loinc.org');
    });

    test('should have description', () => {
      expect(provider.description()).toBe('LOINC');
    });

    test('should return version', async () => {
      const version = await provider.version();
      expect(version).toBeDefined();
      expect(typeof version).toBe('string');
      expect(version).toBe('2.80-test');
    });

    test('should return total count', async () => {
      const count = await provider.totalCount();
      expect(count).toBeGreaterThan(0);
      expect(typeof count).toBe('number');
      // console.log(`✓ Total LOINC codes: ${count}`);
    });

    test('should have parents', () => {
      expect(provider.hasParents()).toBe(true);
    });

    test('should have English displays', () => {
      expect(provider.hasAnyDisplays('en')).toBe(true);
    });
  });

  describe('Code Lookup', () => {
    test('should locate known LOINC codes', async () => {
      const testCodes = expectedResults.basic.knownCodes;

      for (const code of testCodes) {
        const result = await provider.locate(code);
        expect(result.context).toBeDefined();
        expect(result.context).toBeInstanceOf(LoincProviderContext);
        expect(result.context.code).toBe(code);
        expect(result.message).toBeNull();

        // console.log(`✓ Found code: ${code} - ${result.context.desc}`);
      }
    });

    test('should return null for non-existent code', async () => {
      const result = await provider.locate('99999-999');
      expect(result.context).toBeNull();
      expect(result.message).toBeUndefined();
    });

    test('should get display for codes', async () => {
      const testCodes = expectedResults.basic.knownCodes;

      for (const code of testCodes) {
        const display = await provider.display(code);
        expect(display).toBeDefined();
        expect(typeof display).toBe('string');
        expect(display.length).toBeGreaterThan(0);

        // console.log(`✓ Display for ${code}: ${display}`);
      }
    });

    test('should not throw when display lookup runs with non-English context', async () => {
      const ptContext = new OperationContext('pt-BR', opContext.i18n);
      const ptProvider = await factory.build(ptContext, []);

      try {
        const testCode = expectedResults.basic.knownCodes[0];
        await expect(ptProvider.display(testCode)).resolves.toBeDefined();
      } finally {
        ptProvider.close();
      }
    });

    test('should return correct code for context', async () => {
      const testCode = expectedResults.basic.knownCodes[0];
      const result = await provider.locate(testCode);
      const code = await provider.code(result.context);
      expect(code).toBe(testCode);
    });
  });

  describe('Code Properties and Methods', () => {
    test('should return false for abstract concepts', async () => {
      const testCode = expectedResults.basic.knownCodes[0];
      const result = await provider.locate(testCode);
      const isAbstract = await provider.isAbstract(result.context);
      expect(isAbstract).toBe(false);
    });

    test('should return false for inactive concepts', async () => {
      const testCode = expectedResults.basic.knownCodes[0];
      const result = await provider.locate(testCode);
      const isInactive = await provider.isInactive(result.context);
      expect(isInactive).toBe(false);
    });

    test('should return null for definition', async () => {
      const testCode = expectedResults.basic.knownCodes[0];
      const result = await provider.locate(testCode);
      const definition = await provider.definition(result.context);
      expect(definition).toBeNull();
    });
  });

  describe('Designations', () => {
    test('should return designations for codes', async () => {
      const testCode = expectedResults.basic.knownCodes[0];
      const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
      await provider.designations(testCode, designations);

      expect(designations.count).toBeGreaterThan(0);

      const firstDesignation = designations.designations[0];
      expect(firstDesignation.language).toBeDefined();
      expect(firstDesignation.value).toBeDefined();

      // console.log(`✓ Code ${testCode} designations: ${designations.length} found`);
    });
  });

  describe('Filter Support', () => {
    test('should support all expected filter types', async () => {
      const filterTests = expectedResults.filters;

      for (const [filterType, testCases] of Object.entries(filterTests)) {
        for (const testCase of testCases) {
          validateParameter(filterType, "filterType", String);
          const supports = await provider.doesFilter(
            testCase.property,
            testCase.operator,
            testCase.value
          );
          // console.log(`Supports filter?: ${testCase.property} ${testCase.operator} ${testCase.value}`);
          expect(supports).toBe(true);
          // console.log(`✓ Supports filter: ${testCase.property} ${testCase.operator} ${testCase.value}`);
        }
      }
    });

    test('should reject unsupported filters', async () => {
      expect(await provider.doesFilter('unsupported', '=', 'value')).toBe(false);
      expect(await provider.doesFilter('COMPONENT', 'unsupported-op', 'value')).toBe(false);
    });
  });

  describe('LIST Filters', () => {
    test('should filter by LIST property', async () => {
      const testCases = expectedResults.filters.LIST;

      for (const testCase of testCases) {
        const filterContext = await provider.getPrepContext(true);
        await provider.filter(
          filterContext,
          true,
          testCase.property,
          testCase.operator,
          testCase.value
        );
        const filters = await provider.executeFilters(filterContext);
        const filter = filters[0];

        expect(filter).toBeDefined();

        const size = await provider.filterSize(filterContext, filter);
        expect(size).toBeGreaterThanOrEqual(0);

        // Check expected codes if provided
        if (testCase.expectedCodes) {
          const foundCodes = [];
          while (await provider.filterMore(filterContext, filter)) {
            const concept = await provider.filterConcept(filterContext, filter);
            foundCodes.push(concept.code);
          }
          // console.log('found codes: '+foundCodes);

          expect(size).toBe(testCase.expectedCodes.length);

          expect(foundCodes.sort()).toEqual(testCase.expectedCodes.sort());
        }

        // console.log(`✓ LIST filter "${testCase.value}": ${size} results`);
      }
    });
  });

  describe('Relationship Filters', () => {
    test('should filter by relationship properties', async () => {
      const testCases = expectedResults.filters.relationships;

      for (const testCase of testCases) {
        const filterContext = await provider.getPrepContext(true);
        await provider.filter(
          filterContext,
          true,
          testCase.property,
          testCase.operator,
          testCase.value
        );
        const filters = await provider.executeFilters(filterContext);
        const filter = filters[0];

        expect(filter).toBeDefined();
        const size = await provider.filterSize(filterContext, filter);
        const foundCodes = [];
        while (await provider.filterMore(filterContext, filter)) {
          const concept = await provider.filterConcept(filterContext, filter);
          foundCodes.push(concept.code);
        }
        // console.log(`found codes for ${testCase.property} ${testCase.operator} ${testCase.value}: `+foundCodes);


        expect(size).toBeGreaterThanOrEqual(0);

        // Check expected codes if provided
        if (testCase.expectedCodes) {
          expect(size).toBe(testCase.expectedCodes.length);
        }

        // console.log(`✓ ${testCase.property} filter "${testCase.value}": ${size} results`);
      }
    });
  });

  describe('Property Filters', () => {
    test('should filter by concept properties', async () => {
      const testCases = expectedResults.filters.properties;

      for (const testCase of testCases) {
        const filterContext = await provider.getPrepContext(true);
        await provider.filter(
          filterContext,
          true,
          testCase.property,
          testCase.operator,
          testCase.value
        );
        const filters = await provider.executeFilters(filterContext);
        const filter = filters[0];

        expect(filter).toBeDefined();

        const size = await provider.filterSize(filterContext, filter);
        const foundCodes = [];
        while (await provider.filterMore(filterContext, filter)) {
          const concept = await provider.filterConcept(filterContext, filter);
          foundCodes.push(concept.code);
        }
        // console.log(`found codes for ${testCase.property} ${testCase.operator} ${testCase.value}: `+foundCodes);

        expect(size).toBeGreaterThanOrEqual(0);

        // Check expected codes if provided
        if (testCase.expectedCodes) {
          expect(size).toBe(testCase.expectedCodes.length);
        }

        // console.log(`✓ ${testCase.property} filter "${testCase.value}": ${size} results`);
      }
    });

    test('should handle CLASSTYPE numeric values', async () => {
      const classTypeTests = expectedResults.filters.classType;

      for (const testCase of classTypeTests) {
        const filterContext = await provider.getPrepContext(true);
        await provider.filter(
          filterContext,
          true,
          'CLASSTYPE',
          '=',
          testCase.value
        );

        const filters = await provider.executeFilters(filterContext);
        const filter = filters[0];

        const size = await provider.filterSize(filterContext, filter);
        expect(size).toBeGreaterThanOrEqual(0);

        // console.log(`✓ CLASSTYPE filter "${testCase.value}" (${testCase.description}): ${size} results`);
      }
    });
  });

  describe('Hierarchy Filters', () => {
    test('should filter by concept hierarchy', async () => {
      const testCases = expectedResults.filters.hierarchy;

      for (const testCase of testCases) {
        const filterContext = await provider.getPrepContext(true);
        await provider.filter(
          filterContext,
          true,
          'concept',
          testCase.operator,
          testCase.value
        );

        const filters = await provider.executeFilters(filterContext);
        const filter = filters[0];

        expect(filter).toBeDefined();

        const size = await provider.filterSize(filterContext, filter);
        expect(size).toBeGreaterThanOrEqual(0);

        // console.log(`✓ Hierarchy filter "concept ${testCase.operator} ${testCase.value}": ${size} results`);
      }
    });
  });

  describe('Status and Copyright Filters', () => {
    test('should filter by status', async () => {
      const testCases = expectedResults.filters.status;

      for (const testCase of testCases) {
        const filterContext = await provider.getPrepContext(true);
        await provider.filter(
          filterContext,
          true,
          'STATUS',
          '=',
          testCase.value
        );
        const filters = await provider.executeFilters(filterContext);
        const filter = filters[0];

        const size = await provider.filterSize(filterContext, filter);
        expect(size).toBeGreaterThanOrEqual(0);

        // console.log(`✓ STATUS filter "${testCase.value}": ${size} results`);
      }
    });

    test('should filter by copyright', async () => {
      const testCases = expectedResults.filters.copyright;

      for (const testCase of testCases) {
        const filterContext = await provider.getPrepContext(true);
        await provider.filter(
          filterContext,
          true,
          'copyright',
          '=',
          testCase.value
        );
        const filters = await provider.executeFilters(filterContext);
        const filter = filters[0];

        const size = await provider.filterSize(filterContext, filter);
        expect(size).toBeGreaterThanOrEqual(0);

        // console.log(`✓ Copyright filter "${testCase.value}": ${size} results`);
      }
    });

    test('should support text filtering', async () => {
      const filterContext = await provider.getPrepContext(true);
      await provider.searchFilter(filterContext, new SearchFilterText('Bilirubin'), true);
      const filters = await provider.executeFilters(filterContext);
      const filter = filters[0];
      const size = await provider.filterSize(filterContext, filter);
      expect(size).toBeGreaterThanOrEqual(0);
    });

    test('lists text filter matches in description order, sorted or not', async () => {
      for (const sort of [false, true]) {
        const filterContext = await provider.getPrepContext(true);
        await provider.searchFilter(filterContext, new SearchFilterText('serum'), sort);
        const filters = await provider.executeFilters(filterContext);
        const displays = [];
        while (await provider.filterMore(filterContext, filters[0])) {
          displays.push(await provider.display(await provider.filterConcept(filterContext, filters[0])));
        }
        expect(displays.length).toBeGreaterThan(1);
        expect(displays).toEqual([...displays].sort());
      }
    });
  });

  describe('Filter Operations', () => {
    // is-a includes the concept itself; descendent-of does not
    test.each([
      ['concept', 'is-a', true],
      ['concept', 'descendent-of', false],
      ['code', 'is-a', true],
      ['code', 'descendent-of', false]
    ])('%s %s LP7786-9 includes LP7786-9 itself: %s', async (property, operator, includesSelf) => {
      const codes = [];
      const filterContext = await provider.getPrepContext(true);
      await provider.filter(filterContext, true, property, operator, 'LP7786-9');
      const filters = await provider.executeFilters(filterContext);
      while (await provider.filterMore(filterContext, filters[0])) {
        codes.push(await provider.code(await provider.filterConcept(filterContext, filters[0])));
      }
      expect(codes.length).toBeGreaterThan(1);
      expect(codes.includes('LP7786-9')).toBe(includesSelf);
      expect(codes.filter(code => code !== 'LP7786-9')).toEqual(
        // the same descendants either way
        await descendantsOf('LP7786-9'));

      const self = await provider.locate('LP7786-9');
      expect(!!(await provider.filterCheck(filterContext, filters[0], self.context))).toBe(includesSelf);
    });

    async function descendantsOf(code) {
      const codes = [];
      const filterContext = await provider.getPrepContext(true);
      await provider.filter(filterContext, true, 'concept', 'descendent-of', code);
      const filters = await provider.executeFilters(filterContext);
      while (await provider.filterMore(filterContext, filters[0])) {
        codes.push(await provider.code(await provider.filterConcept(filterContext, filters[0])));
      }
      return codes;
    }

    test('should locate codes within filters', async () => {
      const testCase = expectedResults.filters.relationships[0]; // Use first relationship filter
      const filterContext = await provider.getPrepContext(false);
      await provider.filter(
        filterContext,
        true,
        testCase.property,
        testCase.operator,
        testCase.value
      );

      const filters = await provider.executeFilters(filterContext);
      const filter = filters[0];

      if (testCase.expectedCodes && testCase.expectedCodes.length > 0) {
        const codeToFind = testCase.expectedCodes[0];
        const located = await provider.filterLocate(filterContext, filter, codeToFind);
        expect(located).toBeInstanceOf(LoincProviderContext);
        expect(located.code).toBe(codeToFind);

      //   console.log(`✓ Located code ${codeToFind} in filter`);
      }
    });

    test('should check if concepts are in filters', async () => {
      const testCase = expectedResults.filters.relationships[0];
      const filterContext = await provider.getPrepContext(true);
      await provider.filter(
        filterContext,
        true,
        testCase.property,
        testCase.operator,
        testCase.value
      );
      const filters = await provider.executeFilters(filterContext);
      const filter = filters[0];

      if (testCase.expectedCodes && testCase.expectedCodes.length > 0) {
        const testCode = testCase.expectedCodes[0];
        const concept = await provider.locate(testCode);

        const inFilter = await provider.filterCheck(filterContext, filter, concept.context);
        expect(inFilter).toBe(true);

        //console.log(`✓ Concept ${testCode} is in filter`);
      }
    });

    test('should iterate through filter results', async () => {
      const testCase = expectedResults.filters.properties[0]; // Use first property filter
      const filterContext = await provider.getPrepContext(true);
      await provider.filter(
        filterContext,
        true,
        testCase.property,
        testCase.operator,
        testCase.value
      );

      const filters = await provider.executeFilters(filterContext);
      const filter = filters[0];

      let count = 0;
      const maxIterations = 10; // Limit for test performance

      while (await provider.filterMore(filterContext, filter) && count < maxIterations) {
        const concept = await provider.filterConcept(filterContext, filter);
        expect(concept).toBeInstanceOf(LoincProviderContext);
        expect(concept.code).toBeDefined();
        count++;
      }

      expect(count).toBeGreaterThan(0);
      console.log(`✓ Iterated ${count} concepts from filter`);
    });
  });

  describe('Extended Lookup', () => {
    test('should extend lookup with properties and relationships', async () => {
      const testCode = expectedResults.basic.knownCodes[0];
      const paramSet = [];

      await provider.extendLookup(testCode, [], paramSet);

      const params = { parameter: paramSet };

      expect(params.parameter).toBeDefined();
      expect(params.parameter.length).toBeGreaterThan(0);

      // Check for expected parameter types
      const paramTypes = params.parameter.map(p => p.name);
      expect(paramTypes).toContain('property');

      // console.log(`✓ Extended lookup for ${testCode}: ${params.parameter.length} parameters`);

      // Log some example properties
      const properties = params.parameter.filter(p => p.name === 'property').slice(0, 5);
      properties.forEach(prop => {
        const code = prop.part.find(part => part.name === 'code')?.valueCode;
        const value = prop.part.find(part => part.name === 'value')?.valueString;
        console.log(`  Property: ${code} = ${value}`);
      });
    });
  });

  describe('Iterator Support', () => {
    test('should iterate all codes', async () => {
      const iterator = await provider.iterator(null);
      expect(iterator).toBeDefined();

      let count = 0;
      const maxIterations = 10; // Limit for test performance

      while (count < maxIterations) {
        const context = await provider.nextContext(iterator);
        if (!context) break;

        expect(context).toBeInstanceOf(LoincProviderContext);
        expect(context.code).toBeDefined();
        count++;
      }

      expect(count).toBeGreaterThan(0);
      // console.log(`✓ Iterated ${count} codes via iterator`);
    });
  });

  describe('Error Handling', () => {
    test('should handle unsupported filters', async () => {
      const filterContext = await provider.getPrepContext(true);

      await expect(
        provider.filter(filterContext, true, 'unsupported', '=', 'value')
      ).rejects.toThrow('not supported');
    });

    test('should handle extend lookup with invalid context', async () => {
      const params = { parameter: [] };

      await expect(
        provider.extendLookup('invalid-code', [], params)
      ).rejects.toThrow();
    });
  });
});