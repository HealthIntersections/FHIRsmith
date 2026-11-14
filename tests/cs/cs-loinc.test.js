const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { LoincDataMigrator, normaliseExternalSystem } = require('../../tx/importers/import-loinc.module');
const { LoincServices, LoincServicesFactory, LoincProviderContext } = require('../../tx/cs/cs-loinc');
const { OperationContext } = require('../../tx/operation-context');
const {validateParameter} = require("../../library/utilities");
const {Designations, SearchFilterText} = require("../../tx/library/designations");
const {TestUtilities} = require("../test-utilities");
const {CodeSystem} = require('../../tx/library/codesystem');
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
  });

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
        { name: 'Closure', minRecords: 1 }, // Hierarchical relationships
        { name: 'ExternalCodes', minRecords: 1 }, // codes in other systems that LOINC maps to
        { name: 'ExternalMappings', minRecords: 1 }
      ];

      // Check each table
      for (const table of expectedTables) {
        const count = await getTableCount(db, table.name);

        expect(count).toBeGreaterThanOrEqual(table.minRecords);
      }

      // Verify TextIndex virtual table exists and has data
      const textIndexCount = await getTableCount(db, 'TextIndex');
      expect(textIndexCount).toBeGreaterThan(0);

      // Verify config table has correct entries
      const version = await getConfigValue(db, 2);
      expect(version).toBe('2.80-test');

      const systemId = await getConfigValue(db, 1);
      expect(systemId).toBeTruthy();

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

      // Verify we have parts (Type = 2)
      const parts = await getCodesByType(db, 2);
      expect(parts).toBeGreaterThan(0);

      // Verify codes have valid LOINC code format
      const invalidCodes = await getInvalidLoincCodes(db);
      expect(invalidCodes).toBe(0);

      // Verify relationships exist
      const relationshipCount = await getTableCount(db, 'Relationships');
      expect(relationshipCount).toBeGreaterThan(0);

      // Verify descriptions exist for main codes
      const descriptionsCount = await getDescriptionsForMainCodes(db);
      expect(descriptionsCount).toBeGreaterThan(0);

    } finally {
      await closeDatabase(db);
    }
  });

  test('should have language variants if available', async () => {
    const db = new sqlite3.Database(testDbPath);

    try {
      // Check if we have multiple languages
      const languageCount = await getTableCount(db, 'Languages');

      // If we have language variants, there should be descriptions in multiple languages
      if (languageCount > 1) {
        const multiLangDescriptions = await getMultiLanguageDescriptions(db);
        expect(multiLangDescriptions).toBeGreaterThan(0);
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

      // Verify descriptions reference valid codes
      const orphanedDescriptions = await getOrphanedDescriptions(db);
      expect(orphanedDescriptions).toBe(0);

      // Verify properties reference valid codes
      const orphanedProperties = await getOrphanedProperties(db);
      expect(orphanedProperties).toBe(0);

      // Verify closure table references valid codes
      const orphanedClosure = await getOrphanedClosure(db);
      expect(orphanedClosure).toBe(0);

    } finally {
      await closeDatabase(db);
    }
  });

  test('should read a hierarchy record whose text has a line break', async () => {
    // tx/data/loinc's hierarchy has a CODE_TEXT with a line break in it, as LOINC 2.83 does.
    // Read line by line, the second half looked like a second root, and the import failed
    // on a duplicate Config key
    const db = new sqlite3.Database(testDbPath);
    try {
      const parents = await new Promise((resolve, reject) => {
        db.all(`SELECT p.Code FROM Relationships r
                JOIN Codes c ON c.CodeKey = r.SourceKey
                JOIN Codes p ON p.CodeKey = r.TargetKey
                JOIN RelationshipTypes t ON t.RelationshipTypeKey = r.RelationshipTypeKey
                WHERE c.Code = '107188-5' AND t.Description = 'parent'`, (err, rows) => err ? reject(err) : resolve(rows));
      });
      expect(parents.map(r => r.Code)).toEqual(['LP442038-8']);
      expect(await getTableCountWhere(db, 'Config', 'ConfigKey = 3')).toBe(1);
    } finally {
      await closeDatabase(db);
    }
  });

  test('should have external code mappings', async () => {
    const db = new sqlite3.Database(testDbPath);

    const mapsFor = (code) => new Promise((resolve, reject) => {
      db.all(`SELECT e.System, e.Version, e.Code, e.Display, m.Equivalence
              FROM ExternalMappings m
              JOIN Codes c ON c.CodeKey = m.CodeKey
              JOIN ExternalCodes e ON e.ExternalCodeKey = m.ExternalCodeKey
              WHERE c.Code = ? ORDER BY e.System, e.Code`, [code], (err, rows) => err ? reject(err) : resolve(rows));
    });

    try {
      // PartRelatedCodeMapping: the file's own equivalence is kept
      const creatinine = await mapsFor('LP14355-9');
      expect(creatinine).toContainEqual({
        System: 'http://snomed.info/sct', Version: 'http://snomed.info/sct/900000000000207008/version/20260101',
        Code: '15373003', Display: 'Creatinine (substance)', Equivalence: 'narrower'
      });
      const bacteria = await mapsFor('LP14082-9');
      expect(bacteria).toContainEqual({
        System: 'https://www.ncbi.nlm.nih.gov/taxonomy', Version: null, Code: '2', Display: 'Bacteria', Equivalence: 'equivalent'
      });

      // IEEE: code is the CF_CODE10, display the REFID; the IEEE 'broader' (LOINC is broader) becomes 'narrower'
      const potassium = await mapsFor('6298-4');
      expect(potassium).toEqual([{
        System: 'urn:iso:std:iso:11073:10101', Version: null, Code: '160016', Display: 'MDC_CONC_K_GEN', Equivalence: 'narrower'
      }]);

      // AnswerList ExtCode*: always equivalent
      const answer = await mapsFor('LA6576-8');
      expect(answer).toEqual([{
        System: 'http://snomed.info/sct', Version: 'http://snomed.info/sct/900000000000207008/version/20240701',
        Code: '10828004', Display: expect.anything(), Equivalence: 'equivalent'
      }]);

      // LOINC's names for some systems become their FHIR URIs
      expect(normaliseExternalSystem('CMS/HCPCS')).toBe('http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets');
      expect(normaliseExternalSystem('https://www.cdc.gov/phin')).toBe('urn:oid:2.16.840.1.113883.6.238');
      expect(normaliseExternalSystem('CMS LCDS')).toBe('CMS LCDS');
      expect(normaliseExternalSystem('http://snomed.info/sct')).toBe('http://snomed.info/sct');

      // the same target is stored once, however many codes map to it
      const mdcTargets = await getTableCountWhere(db, 'ExternalCodes', `System = 'urn:iso:std:iso:11073:10101' AND Code = '160016'`);
      expect(mdcTargets).toBe(1);

      // RadLex is not imported yet; every mapping points at real rows
      expect(await getTableCountWhere(db, 'ExternalCodes', `System = 'http://www.radlex.org'`)).toBe(0);
      expect(await getTableCountWhere(db, 'ExternalMappings',
        'CodeKey NOT IN (SELECT CodeKey FROM Codes) OR ExternalCodeKey NOT IN (SELECT ExternalCodeKey FROM ExternalCodes)')).toBe(0);
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

      // Check that main codes have properties
      const codesWithProperties = await getCodesWithProperties(db);
      expect(codesWithProperties).toBeGreaterThan(0);

      // Check that we have various description types
      const descriptionTypes = await getUsedDescriptionTypes(db);
      expect(descriptionTypes).toBeGreaterThan(0);

      // Check that we have various property types
      const propertyTypes = await getUsedPropertyTypes(db);
      expect(propertyTypes).toBeGreaterThan(0);

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

function getTableCountWhere(db, tableName, where) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT COUNT(*) as count FROM ${tableName} WHERE ${where}`, (err, row) => {
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
          expect(supports).toBe(true);
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

          expect(size).toBe(testCase.expectedCodes.length);

          expect(foundCodes.sort()).toEqual(testCase.expectedCodes.sort());
        }
      }
    });
  });

  describe('Checking codes without reading the filter ($validate-code: getPrepContext(false))', () => {
    // a filter that is only asked whether a code is in it doesn't read its codes: each check is
    // one query (lsql). It must give the same answer as the codes the filter lists
    const one = sql => new Promise((resolve, reject) => provider.db.get(sql, (err, row) => err ? reject(err) : resolve(row)));

    async function listed(property, operator, value) {
      const prep = await provider.getPrepContext(true);
      await provider.filter(prep, true, property, operator, value);
      const set = (await provider.executeFilters(prep))[0];
      const codes = new Set();
      while (await provider.filterMore(prep, set)) {
        codes.add((await provider.filterConcept(prep, set)).code);
      }
      return codes;
    }

    async function checked(filters) {
      const prep = await provider.getPrepContext(false);
      for (const [property, operator, value] of filters) {
        await provider.filter(prep, false, property, operator, value);
      }
      const sets = await provider.executeFilters(prep);
      const codes = new Set();
      for (const code of provider.codes.keys()) {
        let loc = await provider.filterLocate(prep, sets[0], code);
        expect(typeof loc).not.toBe('string');
        for (let i = 1; loc && i < sets.length; i++) {
          if (!(await provider.filterCheck(prep, sets[i], loc))) {
            loc = null;
          }
        }
        if (loc) {
          codes.add(code);
        }
      }
      return codes;
    }

    async function filters() {
      const top = await one(`SELECT c.Code FROM Codes c WHERE c.CodeKey =
        (SELECT AncestorKey FROM Closure GROUP BY AncestorKey ORDER BY COUNT(*) DESC LIMIT 1)`);
      const component = await one(`SELECT Description FROM Codes WHERE Code = 'LP14082-9'`);
      const two = [...provider.codes.keys()].filter(c => /^\d+-\d$/.test(c)).slice(0, 2);
      const list = [
        ['concept', 'is-a', top.Code], ['concept', 'descendent-of', top.Code], ['code', 'is-a', top.Code],
        ['ancestor', '=', top.Code], ['ancestor', 'in', top.Code + ',' + two[0]],
        ['concept', '=', two[0]], ['concept', 'in', two.join(',')], ['code', '=', two[1]],
        ['COMPONENT', '=', component.Description], ['COMPONENT', 'in', 'LP14082-9,LP7255-5'],
        ['COMPONENT', 'exists', 'true'], ['COMPONENT', 'exists', 'false'],
        ['UNITSREQUIRED', 'exists', 'true'], ['UNITSREQUIRED', 'exists', 'false'],
        ['ORDER_OBS', 'regex', 'Obs.*'], ['COMPONENT', 'regex', '.*[Gg]lucose.*'],
        ['ORDER_OBS', 'regex', 'no value is this'], ['COMPONENT', 'regex', 'no value is this'],
        ['SCALE_TYP', '=', 'Doc'], ['SCALE_TYP', '=', 'doc'], ['SCALE_TYP', '=', 'no part is called this'],
        ['CLASS', 'regex', 'CHE.*'], ['CLASS', 'regex', 'no value is this'],
        ['$text', '<', 'glucose'], ['$text', '>', 'glucose']
      ];
      for (const group of ['LIST', 'answerList', 'relationships', 'properties', 'classType', 'status', 'copyright']) {
        for (const t of expectedResults.filters[group]) {
          list.push([t.property, t.operator, t.value]);
        }
      }
      return list;
    }

    test('each filter: the codes checked are the codes listed', async () => {
      for (const [property, operator, value] of await filters()) {
        const want = await listed(property, operator, value);
        const got = await checked([[property, operator, value]]);
        expect([property, operator, value, [...got].sort()]).toEqual([property, operator, value, [...want].sort()]);
      }
    });

    test('several filters: a code is in all of them', async () => {
      const component = ['COMPONENT', '=', 'LP14082-9'];
      const units = ['UNITSREQUIRED', '=', 'Y'];
      const a = await listed(...component);
      const b = await listed(...units);
      const got = await checked([component, units]);
      expect([...got].sort()).toEqual([...a].filter(c => b.has(c)).sort());
      expect(got.size).toBeGreaterThan(0);
    });

    test('a regex that matches no value is an empty filter, not an error', async () => {
      expect((await listed('ORDER_OBS', 'regex', 'no value is this')).size).toBe(0);
    });

    test('a part given by name: the codes related to the parts with that name, in any case', async () => {
      const db = new sqlite3.Database(testDbPath, sqlite3.OPEN_READONLY);
      const want = await new Promise((resolve, reject) => db.all(`SELECT c.Code FROM Relationships r, RelationshipTypes t, Codes c, Codes p
          WHERE t.Description = 'SCALE_TYP' AND r.RelationshipTypeKey = t.RelationshipTypeKey
            AND r.SourceKey = c.CodeKey AND r.TargetKey = p.CodeKey AND p.Description = 'Doc'`,
      (err, rows) => { db.close(); return err ? reject(err) : resolve(rows.map(r => r.Code).sort()); }));
      expect(want.length).toBeGreaterThan(0);
      for (const name of ['Doc', 'DOC']) {
        expect([name, [...await listed('SCALE_TYP', '=', name)].sort()]).toEqual([name, want]);
        expect([name, [...await checked([['SCALE_TYP', '=', name]])].sort()]).toEqual([name, want]);
      }
      expect((await checked([['SCALE_TYP', '=', 'no part is called this']])).size).toBe(0);
    });

    test('a part name and a regex are looked up once per factory, not on each request', async () => {
      // SCALE_TYP = Doc names a part: finding it reads every code where Codes.Description has no
      // index (as in databases imported before idx_codes_description). CLASS regex reads every
      // CLASS part. One provider per request, as the server does
      const f = new LoincServicesFactory(opContext.i18n, testDbPath);
      const statements = [];
      async function validate(property, operator, value, code) {
        const p = await f.build(opContext, []);
        for (const method of ['all', 'get', 'each']) {
          const original = p.db[method];
          p.db[method] = function (sql, ...args) {
            statements.push(sql);
            return original.call(p.db, sql, ...args);
          };
        }
        try {
          const prep = await p.getPrepContext(false);
          await p.filter(prep, false, property, operator, value);
          const set = (await p.executeFilters(prep))[0];
          return await p.filterLocate(prep, set, code);
        } finally {
          p.close();
        }
      }
      const byName = sql => /Description = /.test(sql);
      const classScan = sql => /SELECT CodeKey as Key, Description FROM Codes/.test(sql);
      for (const name of ['Doc', 'DOC', 'doc']) {
        expect(await validate('SCALE_TYP', '=', name, '15507-7')).not.toBeNull();
        expect(await validate('CLASS', 'regex', 'CHE.*', '12814-0')).not.toBeNull();
      }
      // (before: 3 and 3, one per request; Doc, DOC and doc are one name, as NOCASE compares)
      expect([statements.filter(byName).length, statements.filter(classScan).length]).toEqual([1, 1]);
    });

    test('a filter prepared for checking codes cannot list them', async () => {
      const prep = await provider.getPrepContext(false);
      await provider.filter(prep, false, 'STATUS', '=', 'ACTIVE');
      const set = (await provider.executeFilters(prep))[0];
      await expect(provider.filterMore(prep, set)).rejects.toThrow(/prepared for checking codes/);
    });
  });

  describe('Answer list Filters (answer-list and answers-for, UP-645)', () => {
    test('should declare answer-list and answers-for', async () => {
      expect(await provider.doesFilter('answer-list', '=', 'LA9040-2')).toBe(true);
      expect(await provider.doesFilter('answers-for', '=', 'LL6136-7')).toBe(true);
    });

    test('should filter by answer-list and answers-for', async () => {
      for (const testCase of expectedResults.filters.answerList) {
        const filterContext = await provider.getPrepContext(true);
        await provider.filter(filterContext, true, testCase.property, testCase.operator, testCase.value);
        const filters = await provider.executeFilters(filterContext);
        const filter = filters[0];
        expect(filter).toBeDefined();

        const foundCodes = [];
        while (await provider.filterMore(filterContext, filter)) {
          const concept = await provider.filterConcept(filterContext, filter);
          foundCodes.push(concept.code);
        }
        expect(foundCodes.sort()).toEqual([...testCase.expectedCodes].sort());
        expect(await provider.filterSize(filterContext, filter)).toBe(testCase.expectedCodes.length);
      }
    });

    test('answers-for membership holds when the answers are not in key order', async () => {
      // the query gives a list's answers in the list's order, not key order, and in LOINC that
      // is often not ascending (an answer several lists share has the key of the list that first
      // had it). Membership used to binary-search them: on LOINC 2.83 it missed 7,135 answers of
      // 2,367 lists. The test data's lists share no answers, so the rows are reversed here
      const db = provider.db;
      const all = db.all;
      db.all = function (sql, ...args) {
        const callback = args.pop();
        return all.call(db, sql, ...args, (err, rows) => callback(err, rows ? [...rows].reverse() : rows));
      };
      try {
        const testCase = expectedResults.filters.answerList.find(t => t.property === 'answers-for');
        expect(testCase.expectedCodes.length).toBeGreaterThan(2);
        const filterContext = await provider.getPrepContext(false);
        await provider.filter(filterContext, false, testCase.property, testCase.operator, testCase.value);
        const filter = (await provider.executeFilters(filterContext))[0];
        for (const code of testCase.expectedCodes) {
          const located = await provider.filterLocate(filterContext, filter, code);
          expect([code, located === null ? 'null' : typeof located]).toEqual([code, 'object']);
          expect(await provider.filterCheck(filterContext, filter, located)).toBe(true);
        }
      } finally {
        db.all = all;
      }
    });

    test('answer-list membership is checked by filterLocate/filterCheck', async () => {
      const filterContext = await provider.getPrepContext(false);
      await provider.filter(filterContext, false, 'answer-list', '=', 'LA9040-2');
      const filters = await provider.executeFilters(filterContext);
      const located = await provider.filterLocate(filterContext, filters[0], 'LL6136-7');
      expect(typeof located).not.toBe('string');
      expect(await provider.filterCheck(filterContext, filters[0], located)).toBe(true);
      expect(await provider.filterLocate(filterContext, filters[0], 'LL360-9')).toBeNull();
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


        expect(size).toBeGreaterThanOrEqual(0);

        // Check expected codes if provided
        if (testCase.expectedCodes) {
          expect(size).toBe(testCase.expectedCodes.length);
        }
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

        expect(size).toBeGreaterThanOrEqual(0);

        // Check expected codes if provided
        if (testCase.expectedCodes) {
          expect(size).toBe(testCase.expectedCodes.length);
        }
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

    // LOINC's own text search needs every word (no display in the test data has "serum
    // glucose"); a supplement's designations must match the same way, not on any one word
    test('a supplement\'s designations match a text filter only when they have every word', async () => {
      const supplement = new CodeSystem({
        resourceType: 'CodeSystem', url: 'http://example.org/loinc-supplement', version: '1', status: 'active',
        content: 'supplement', supplements: 'http://loinc.org', language: 'en',
        concept: [
          { code: '101448-9', designation: [{ language: 'en', value: 'Serum antibody screen' }] },
          { code: '104597-0', display: 'Blood glucose by meter' },
          { code: '102820-8', designation: [{ language: 'en', value: 'Glucose level in serum' }] }
        ]
      });
      const supplemented = await factory.build(opContext, [supplement]);
      try {
        const filterContext = await supplemented.getPrepContext(true);
        await supplemented.searchFilter(filterContext, new SearchFilterText('serum glucose'), false);
        const filters = await supplemented.executeFilters(filterContext);
        const codes = [];
        while (await supplemented.filterMore(filterContext, filters[0])) {
          codes.push(await supplemented.code(await supplemented.filterConcept(filterContext, filters[0])));
        }
        expect(codes).toEqual(['102820-8']);
      } finally {
        supplemented.close();
      }
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

    async function filterCodes(property, operator, value) {
      const codes = [];
      const filterContext = await provider.getPrepContext(true);
      await provider.filter(filterContext, true, property, operator, value);
      const filters = await provider.executeFilters(filterContext);
      while (await provider.filterMore(filterContext, filters[0])) {
        codes.push(await provider.code(await provider.filterConcept(filterContext, filters[0])));
      }
      return codes;
    }

    // LOINC's own name for the hierarchy filter, used by its implicit value sets
    // (http://loinc.org/vs/[partcode]): ancestor = X is the codes X subsumes, not X itself
    test('ancestor = a part is descendent-of the part', async () => {
      expect(await provider.doesFilter('ancestor', '=', 'LP7786-9')).toBe(true);
      const codes = await filterCodes('ancestor', '=', 'LP7786-9');
      expect(codes.length).toBeGreaterThan(1);
      expect(codes).not.toContain('LP7786-9');
      expect(codes).toEqual(await descendantsOf('LP7786-9'));
    });

    test('ancestor in two parts is the union of their descendants', async () => {
      expect(await provider.doesFilter('ancestor', 'in', 'LP7786-9,LP14082-9')).toBe(true);
      const a = await descendantsOf('LP7786-9');
      const b = await descendantsOf('LP14082-9');
      expect(b.length).toBeGreaterThan(0);
      const codes = await filterCodes('ancestor', 'in', 'LP7786-9, LP14082-9');
      expect(new Set(codes)).toEqual(new Set([...a, ...b]));
      expect(codes.length).toBe(new Set(codes).size);
    });

    test('the implicit value set for a part expands to its descendants', async () => {
      const vs = await factory.buildKnownValueSet('http://loinc.org/vs/LP7786-9', null);
      expect(vs.compose.include[0].filter).toEqual([{ property: 'ancestor', op: '=', value: 'LP7786-9' }]);
      const f = vs.compose.include[0].filter[0];
      expect(await provider.doesFilter(f.property, f.op, f.value)).toBe(true);
    });

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
    });
  });

  describe('Extended Lookup', () => {
    // $expand reports properties from properties(), which is built from extendLookup
    test('properties() for $expand: only the named ones, none when none are named', async () => {
      expect(await provider.properties('100007-4', [])).toEqual([]);
      const got = await provider.properties('100007-4', ['COMPONENT', 'SCALE_TYP']);
      expect(got.sort((a, b) => a.code.localeCompare(b.code))).toEqual([
        { code: 'COMPONENT', valueCode: 'LP430726-2' },
        { code: 'SCALE_TYP', valueCode: 'LP7751-3' }
      ]);
      // Coding-valued (a mapping), without the equivalence subproperty
      expect(await provider.properties('LP14355-9', ['sct'])).toEqual([
        { code: 'sct', valueCoding: { system: 'http://snomed.info/sct', version: 'http://snomed.info/sct/900000000000207008/version/20260101', code: '15373003', display: 'Creatinine (substance)' } }
      ]);
    });

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
    });

    test('should return the lookup properties in the same order every time', async () => {
      // the property queries run in parallel; the order must not depend on which finishes first
      const order = async () => {
        const params = [];
        await provider.extendLookup('100865-5', [], params);
        return params.map(p => p.part.find(x => x.name === 'code').valueCode).join(',');
      };
      const orders = new Set();
      for (let i = 0; i < 30; i++) {
        orders.add(await order());
      }
      expect([...orders]).toHaveLength(1);
      const codes = [...orders][0].split(',');
      // relationships, then concept properties, then status, then related names
      expect(codes.indexOf('COMPONENT')).toBeLessThan(codes.indexOf('CLASSTYPE'));
      expect(codes.indexOf('CLASSTYPE')).toBeLessThan(codes.indexOf('STATUS'));
      expect(codes.indexOf('STATUS')).toBeLessThan(codes.indexOf('RELATEDNAMES2'));
    });
  });

  describe('External Mappings', () => {
    const mappingProps = (params) => params
      .filter(p => p.name === 'property')
      .map(p => ({
        code: p.part.find(x => x.name === 'code').valueCode,
        value: p.part.find(x => x.name === 'value').valueCoding,
        equivalence: p.part.find(x => x.name === 'subproperty')?.part.find(x => x.name === 'value').valueCode
      }))
      .filter(p => p.value);

    test('lookup returns a part\'s mappings, named for the map, by default', async () => {
      const params = [];
      await provider.extendLookup('LP14355-9', [], params);
      expect(mappingProps(params)).toEqual([
        { code: 'ncbi', value: { system: 'http://pubchem.ncbi.nlm.nih.gov', code: '588', display: 'Creatinine' }, equivalence: 'equivalent' },
        { code: 'sct', value: { system: 'http://snomed.info/sct', version: 'http://snomed.info/sct/900000000000207008/version/20260101', code: '15373003', display: 'Creatinine (substance)' }, equivalence: 'narrower' },
        { code: 'chebi', value: { system: 'https://www.ebi.ac.uk/chebi', code: 'CHEBI:16737', display: 'creatinine' }, equivalence: 'equivalent' }
      ]);
    });

    test('lookup returns only the mappings asked for', async () => {
      const params = [];
      await provider.extendLookup('LP14355-9', ['sct'], params);
      expect(mappingProps(params).map(p => p.code)).toEqual(['sct']);
    });

    test('lookup returns IEEE and answer list mappings', async () => {
      let params = [];
      await provider.extendLookup('6298-4', ['mdc'], params);
      expect(mappingProps(params)).toEqual([
        { code: 'mdc', value: { system: 'urn:iso:std:iso:11073:10101', code: '160016', display: 'MDC_CONC_K_GEN' }, equivalence: 'narrower' }
      ]);
      params = [];
      await provider.extendLookup('LA6576-8', ['sct'], params);
      expect(mappingProps(params).map(p => p.value.code)).toEqual(['10828004']);
    });

    // LP14355-9 Creatinine is listed under LP31398-8 Renal function on two paths in
    // ComponentHierarchyBySystem. It has that parent once, and is that part's child once
    test('a part listed twice under the same parent has it as parent once', async () => {
      const params = [];
      await provider.extendLookup('LP14355-9', ['parent'], params);
      const parents = params.filter(p => p.name === 'property' && p.part[0].valueCode === 'parent')
        .map(p => p.part[1].valueCode);
      expect(parents).toEqual(['LP31398-8']);

      const rows = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(testDbPath, sqlite3.OPEN_READONLY);
        db.all(`SELECT COUNT(*) AS n FROM Relationships r, RelationshipTypes t, Codes s, Codes p
                WHERE r.RelationshipTypeKey = t.RelationshipTypeKey AND t.Description = 'parent'
                  AND r.SourceKey = s.CodeKey AND s.Code = 'LP14355-9'
                  AND r.TargetKey = p.CodeKey AND p.Code = 'LP31398-8'`, (err, result) => {
          db.close();
          if (err) reject(err); else resolve(result);
        });
      });
      expect(rows[0].n).toBe(1);

      const parent = await provider.locate('LP31398-8');
      const iter = await provider.iterator(parent.context);
      const children = [];
      for (let c = await provider.nextContext(iter); c; c = await provider.nextContext(iter)) {
        children.push(c.code);
      }
      expect(children.filter(c => c === 'LP14355-9')).toEqual(['LP14355-9']);
    });

    // The LinguisticVariant files' axis columns translate the term's Parts. Some languages
    // (ko-KR, most of fr-CA) have nothing else, so they are loaded as PartName designations on
    // the Parts, and every language that has a variant file is then available
    test('every linguistic variant language is loaded', async () => {
      const dir = path.resolve(__dirname, '../../tx/data/loinc/AccessoryFiles/LinguisticVariants');
      const fileLangs = fs.readdirSync(dir)
        .map(f => f.match(/^([a-z]{2})([A-Z]{2})\d+LinguisticVariant\.csv$/))
        .filter(m => m)
        .map(m => m[1] + '-' + m[2])
        .sort();
      expect(fileLangs).toContain('ko-KR');
      const rows = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(testDbPath, sqlite3.OPEN_READONLY);
        db.all(`SELECT DISTINCT Languages.Code AS Lang FROM Descriptions, Languages
                WHERE Descriptions.LanguageKey = Languages.LanguageKey`, (err, result) => {
          db.close();
          if (err) reject(err); else resolve(result);
        });
      });
      const loaded = rows.map(r => r.Lang);
      expect(fileLangs.filter(l => !loaded.includes(l))).toEqual([]);
    });

    test('a Part has the translations of its axis as PartName designations', async () => {
      // LP7753-9 Qn is the SCALE_TYP of 11702-8 (zh-CN 定量型) and of 10391-1 (ko-KR 정량)
      const designations = new Designations(opContext.i18n.languageDefinitions);
      await provider.designations('LP7753-9', designations);
      const partNames = designations.designations
        .filter(d => d.use && d.use.code === 'PartName')
        .map(d => d.language.code + ' ' + d.value);
      expect(partNames).toEqual(expect.arrayContaining(['zh-CN 定量型', 'ko-KR 정량']));
      // and the display is not changed
      expect(await provider.display('LP7753-9')).toBe('Qn');
    });

    test('an implicit map is offered for a code it has a mapping for', async () => {
      let maps = [];
      await factory.findImplicitConceptMaps(maps, 'http://loinc.org', null, 'http://snomed.info/sct', 'LP14355-9');
      expect(maps.map(m => m.url)).toEqual(['http://loinc.org/cm/sct']);

      // the other way, the code is the SNOMED CT concept
      maps = [];
      await factory.findImplicitConceptMaps(maps, 'http://snomed.info/sct', null, 'http://loinc.org', '15373003');
      expect(maps.map(m => m.url)).toEqual(['http://loinc.org/cm/sct']);

      // no mapping for this code, or no map for this system
      maps = [];
      await factory.findImplicitConceptMaps(maps, 'http://loinc.org', null, 'http://snomed.info/sct', '6298-4');
      await factory.findImplicitConceptMaps(maps, 'http://loinc.org', null, 'http://hl7.org/fhir/sid/icd-10', 'LP14355-9');
      expect(maps).toEqual([]);

      expect((await factory.findImplicitConceptMap('http://loinc.org/cm/mdc')).url).toBe('http://loinc.org/cm/mdc');
      expect(await factory.findImplicitConceptMap('http://loinc.org/cm/unknown')).toBeNull();
    });

    test('translations go both ways, with the relationship from the code translated', async () => {
      const map = await factory.findImplicitConceptMap('http://loinc.org/cm/sct');
      const forward = await provider.getTranslations(map, { system: 'http://loinc.org', code: 'LP14355-9' }, 'http://snomed.info/sct', false);
      expect(forward.map(t => [t.system, t.code, t.relationship])).toEqual([['http://snomed.info/sct', '15373003', 'source-is-broader-than-target']]);

      const back = await provider.getTranslations(map, { system: 'http://snomed.info/sct', code: '15373003' }, 'http://loinc.org', false);
      expect(back.map(t => [t.system, t.code, t.display, t.relationship])).toEqual([['http://loinc.org', 'LP14355-9', 'Creatinine', 'source-is-narrower-than-target']]);

      // a code with nothing in this map
      expect(await provider.getTranslations(map, { system: 'http://loinc.org', code: '6298-4' }, 'http://snomed.info/sct', false)).toEqual([]);
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
    });
  });

  describe('Exists Filters', () => {
    // the test database has 483 codes: 322 LOINC terms (all with a CLASSTYPE), of which 24
    // have a METHOD_TYP; the rest are Parts, AnswerLists and Answers
    async function run(filters) {
      const filterContext = await provider.getPrepContext(true);
      let first = true;
      for (const [property, operator, value] of filters) {
        await provider.filter(filterContext, first, property, operator, value);
        first = false;
      }
      const sets = await provider.executeFilters(filterContext);
      const codes = [];
      while (await provider.filterMore(filterContext, sets[0])) {
        const c = await provider.filterConcept(filterContext, sets[0]);
        let ok = true;
        for (let i = 1; i < sets.length; i++) {
          ok = ok && await provider.filterCheck(filterContext, sets[i], c);
        }
        if (ok) {
          codes.push(c.code);
        }
      }
      return { filterContext, sets, codes };
    }

    test.each([
      ['METHOD_TYP', 'true', 24],
      ['METHOD_TYP', 'false', 459],
      ['CLASSTYPE', 'true', 322],
      ['CLASSTYPE', 'false', 161]
    ])('%s exists %s: %i codes', async (property, value, count) => {
      const { codes } = await run([[property, 'exists', value]]);
      expect(codes.length).toBe(count);
    });

    test('exists true and exists false partition the code system', async () => {
      const yes = (await run([['METHOD_TYP', 'exists', 'true']])).codes;
      const no = (await run([['METHOD_TYP', 'exists', 'false']])).codes;
      expect(yes.filter(c => no.includes(c))).toEqual([]);
      expect(yes.length + no.length).toBe(483);
    });

    test('LOINC terms without a method', async () => {
      const { filterContext, sets, codes } = await run([['METHOD_TYP', 'exists', 'false'], ['CLASSTYPE', 'exists', 'true']]);
      expect(codes.length).toBe(298);
      expect(codes).toContain('100007-4');
      expect(codes).not.toContain('100865-5'); // has a method
      expect(codes).not.toContain('LP190769-2'); // a Part

      // the two filters come back as one set, their intersection - so its size is the
      // include's size (count=0 is answered without walking it)
      expect(sets.length).toBe(1);
      expect(await provider.filterSize(filterContext, sets[0])).toBe(298);

      // membership checks agree with the expansion
      expect(await provider.filterLocate(filterContext, sets[0], '100007-4')).toBeTruthy();
      expect(await provider.filterLocate(filterContext, sets[0], '100865-5')).toBeNull();
      expect(await provider.filterLocate(filterContext, sets[0], 'LP190769-2')).toBeNull();
    });

    test('exists only takes true or false', async () => {
      expect(await provider.doesFilter('METHOD_TYP', 'exists', 'true')).toBe(true);
      expect(await provider.doesFilter('METHOD_TYP', 'exists', 'false')).toBe(true);
      expect(await provider.doesFilter('CLASSTYPE', 'exists', 'false')).toBe(true);
      expect(await provider.doesFilter('METHOD_TYP', 'exists', 'LP6286-5')).toBe(false);
      expect(await provider.doesFilter('CLASSTYPE', 'exists', 'True')).toBe(false);
      const filterContext = await provider.getPrepContext(true);
      await expect(provider.filter(filterContext, true, 'METHOD_TYP', 'exists', 'False'))
        .rejects.toThrow('not supported');
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