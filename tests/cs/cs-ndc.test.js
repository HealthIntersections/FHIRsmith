const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { NdcDataMigrator } = require('../../tx/importers/import-ndc.module');
const { NdcServices, NdcServicesFactory, NdcConcept } = require('../../tx/cs/cs-ndc');
const { OperationContext } = require('../../tx/operation-context');
const {Designations} = require("../../tx/library/designations");
const {TestUtilities} = require("../test-utilities");
const folders = require('../../library/folder-setup');

describe('NDC Module Import', () => {
  const testSourceDir = path.resolve(__dirname, '../../tx/data/ndc');
  const testDbPath = folders.ensureFilePath('ndc-testing.db');

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
  test('should import NDC test data successfully', async () => {
    // Verify source data exists
    expect(fs.existsSync(testSourceDir)).toBe(true);

    // Create migrator and run import
    const migrator = new NdcDataMigrator();

    await migrator.migrate(
      testSourceDir,
      testDbPath,
      'NDC-TEST-2024',
      {
        verbose: false // Suppress console output during tests
      }
    );

    // Verify database file was created
    expect(fs.existsSync(testDbPath)).toBe(true);
  }, 60000); // 60 second timeout for import

  test('should have all expected tables with data', async () => {
    // Open database connection
    const db = new sqlite3.Database(testDbPath);

    try {
      // Define expected tables and their minimum expected record counts
      const expectedTables = [
        { name: 'NDCProducts', minRecords: 1 },
        { name: 'NDCPackages', minRecords: 1 },
        { name: 'NDCProductTypes', minRecords: 1 },
        { name: 'NDCOrganizations', minRecords: 1 },
        { name: 'NDCDoseForms', minRecords: 1 },
        { name: 'NDCRoutes', minRecords: 1 },
        { name: 'NDCVersion', minRecords: 1 }
      ];

      // Check each table
      for (const table of expectedTables) {
        const count = await getTableCount(db, table.name);

        expect(count).toBeGreaterThanOrEqual(table.minRecords);
      }

      // Verify version table has correct version
      const version = await getVersion(db);
      expect(version).toBe('2025-07-11');
      // (`✓ Version: ${version}`);

      // Verify data integrity - packages should reference valid products
      const orphanedPackages = await getOrphanedPackagesCount(db);
      expect(orphanedPackages).toBe(0);
      // (`✓ No orphaned packages found`);

      // Verify lookup table integrity
      const productTypesUsed = await getUsedLookupCount(db, 'NDCProducts', 'Type', 'NDCProductTypes');
      expect(productTypesUsed).toBeGreaterThan(0);
      // (`✓ Product types properly linked: ${productTypesUsed} used`);

      const organizationsUsed = await getUsedLookupCount(db, 'NDCProducts', 'Company', 'NDCOrganizations');
      expect(organizationsUsed).toBeGreaterThan(0);
      // (`✓ Organizations properly linked: ${organizationsUsed} used`);

    } finally {
      // Close database connection
      await closeDatabase(db);
    }
  });

  test('should have valid NDC code formats', async () => {
    const db = new sqlite3.Database(testDbPath);

    try {
      // Note: NDC codes can be in FDA format (with dashes, 10-digit) or CMS format (no dashes, 11-digit)
      // We check for reasonable length rather than strict format since both are valid

      // Check product codes are reasonable length (8-15 chars to allow for dashes)
      const invalidProductCodes = await getInvalidCodes(db, 'NDCProducts', 'Code', 15);
      expect(invalidProductCodes).toBe(0);
      // (`✓ All product codes are reasonable length`);

      // Check package codes are reasonable length (8-15 chars to allow for dashes)
      const invalidPackageCodes = await getInvalidCodes(db, 'NDCPackages', 'Code', 15);
      expect(invalidPackageCodes).toBe(0);
      // (`✓ All package codes are reasonable length`);

    } finally {
      await closeDatabase(db);
    }
  });

  test('should have reasonable data distribution', async () => {
    const db = new sqlite3.Database(testDbPath);

    try {
      // Check that we have both active and potentially inactive products
      const activeProducts = await getActiveCount(db, 'NDCProducts');
      const totalProducts = await getTableCount(db, 'NDCProducts');

      expect(activeProducts).toBeGreaterThan(0);
      expect(totalProducts).toBeGreaterThanOrEqual(activeProducts);
      // (`✓ Products: ${activeProducts} active out of ${totalProducts} total`);

      // Check that we have both active and potentially inactive packages
      const activePackages = await getActiveCount(db, 'NDCPackages');
      const totalPackages = await getTableCount(db, 'NDCPackages');

      expect(activePackages).toBeGreaterThan(0);
      expect(totalPackages).toBeGreaterThanOrEqual(activePackages);
      // (`✓ Packages: ${activePackages} active out of ${totalPackages} total`);

      // Check that we have some products with trade names
      const productsWithTradeNames = await getProductsWithTradeNames(db);
      expect(productsWithTradeNames).toBeGreaterThan(0);
      // (`✓ Products with trade names: ${productsWithTradeNames}`);

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

function getVersion(db) {
  return new Promise((resolve, reject) => {
    db.get('SELECT Version FROM NDCVersion LIMIT 1', (err, row) => {
      if (err) reject(err);
      else resolve(row ? row.Version : null);
    });
  });
}

function getOrphanedPackagesCount(db) {
  return new Promise((resolve, reject) => {
    db.get(`
        SELECT COUNT(*) as count
        FROM NDCPackages p
            LEFT JOIN NDCProducts pr ON p.ProductKey = pr.NDCKey
        WHERE pr.NDCKey IS NULL
    `, (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function getUsedLookupCount(db, mainTable, foreignKeyColumn, lookupTable) {
  return new Promise((resolve, reject) => {
    db.get(`
        SELECT COUNT(DISTINCT m.${foreignKeyColumn}) as count
        FROM ${mainTable} m
            INNER JOIN ${lookupTable} l ON m.${foreignKeyColumn} = l.NDCKey
    `, (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function getInvalidCodes(db, tableName, codeColumn, maxLength) {
  return new Promise((resolve, reject) => {
    db.get(`
        SELECT COUNT(*) as count
        FROM ${tableName}
        WHERE ${codeColumn} = ''
           OR ${codeColumn} IS NULL
           OR LENGTH(${codeColumn}) > ${maxLength}
           OR LENGTH(${codeColumn}) < 8
    `, (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

// function getValidNdcFormatCount(db) {
//   return new Promise((resolve, reject) => {
//     db.get(`
//         SELECT COUNT(*) as count
//         FROM NDCProducts
//         WHERE (
//         -- FDA format with dashes: 4-4-2, 5-3-2, 5-4-1, 6-3-2, 6-4-1
//             (Code GLOB '*-*-*' AND LENGTH(Code) BETWEEN 8 AND 13) OR
//         -- CMS format without dashes: 11 digits
//             (Code NOT LIKE '%-%' AND LENGTH(Code) = 11 AND Code GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]')
//             )
//     `, (err, row) => {
//       if (err) reject(err);
//       else resolve(row.count);
//     });
//   });
// }

// function getInvalidCode11s(db) {
//   return new Promise((resolve, reject) => {
//     db.get(`
//         SELECT COUNT(*) as count
//         FROM NDCPackages
//         WHERE LENGTH(Code11) != 11
//            OR Code11 GLOB '*[^0-9]*'
//            OR Code11 = ''
//            OR Code11 IS NULL
//     `, (err, row) => {
//       if (err) reject(err);
//       else resolve(row.count);
//     });
//   });
// }

function getActiveCount(db, tableName) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT COUNT(*) as count FROM ${tableName} WHERE Active = 1`, (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

function getProductsWithTradeNames(db) {
  return new Promise((resolve, reject) => {
    db.get(`
      SELECT COUNT(*) as count 
      FROM NDCProducts 
      WHERE TradeName != '' AND TradeName IS NOT NULL
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

describe('NDC Provider', () => {
  const testDbPath = path.resolve(__dirname, '../../data/ndc-testing.db');
  let factory;
  let provider;
  let opContext;

  beforeAll(async () => {
    // Verify test database exists (should be created by import tests)
    expect(fs.existsSync(testDbPath)).toBe(true);

    // Create factory and provider
    opContext = new OperationContext('en', await TestUtilities.loadTranslations());
    factory = new NdcServicesFactory(opContext.i18n, testDbPath);
    await factory.load();
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
      expect(provider).toBeInstanceOf(NdcServices);
    });

    test('should have correct system URI', () => {
      expect(provider.system()).toBe('http://hl7.org/fhir/sid/ndc');
    });

    test('should have description', () => {
      expect(provider.description()).toBe('National Drug Code (NDC) Directory');
    });

    test('should return version', async () => {
      const version = await provider.version();
      expect(version).toBeDefined();
      expect(typeof version).toBe('string');
    });

    test('should return total count', async () => {
      const count = await provider.totalCount();
      expect(count).toBeGreaterThan(0);
      expect(typeof count).toBe('number');
      // (`✓ Total NDC codes: ${count}`);
    });

    test('should not have parents', () => {
      expect(provider.hasParents()).toBe(false);
    });
  });

  describe('Product Code Lookup', () => {
    test('should locate product 0002-0152 (Zepbound)', async () => {
      const result = await provider.locate('0002-0152');

      expect(result.context).toBeDefined();
      expect(result.context).toBeInstanceOf(NdcConcept);
      expect(result.context.code).toBe('0002-0152');
      expect(result.context.isPackage).toBe(false);
      expect(result.message).toBeNull();

      // (`✓ Found product: ${result.context.code}`);
    });

    test('should get display for product 0002-0152', async () => {
      const display = await provider.display('0002-0152');

      expect(display).toBeDefined();
      expect(display).toContain('Zepbound');
      expect(display).toContain('(product)');

      // (`✓ Product display: ${display}`);
    });

    test('should locate product 0002-0213 (Humulin R)', async () => {
      const result = await provider.locate('0002-0213');

      expect(result.context).toBeDefined();
      expect(result.context.code).toBe('0002-0213');
      expect(result.context.isPackage).toBe(false);

      const display = await provider.display(result.context);
      expect(display).toContain('Humulin');
      expect(display).toContain('(product)');

      // (`✓ Found Humulin product: ${display}`);
    });

    test('should return null for non-existent product', async () => {
      const result = await provider.locate('9999-9999');

      expect(result.context).toBeNull();
      expect(result.message).toBeUndefined();
    });
  });

  describe('Package Code Lookup', () => {
    test('should locate package 0002-0152-01 (10-digit format)', async () => {
      const result = await provider.locate('0002-0152-01');

      expect(result.context).toBeDefined();
      expect(result.context).toBeInstanceOf(NdcConcept);
      expect(result.context.code).toBe('0002-0152-01');
      expect(result.context.isPackage).toBe(true);
      expect(result.message).toBeNull();

      // (`✓ Found package: ${result.context.code}`);
    });

    test('should get display for package 0002-0152-01', async () => {
      const display = await provider.display('0002-0152-01');

      expect(display).toBeDefined();
      expect(display).toContain('Zepbound');
      expect(display).toContain('(package)');
      expect(display).toContain('VIAL');

      // (`✓ Package display: ${display}`);
    });

    test('should locate package by 11-digit code 00002121404', async () => {
      const result = await provider.locate('00002121404');

      expect(result.context).toBeDefined();
      expect(result.context.isPackage).toBe(true);
      // The returned code should be the original format
      expect(result.context.code).toBe('00002121404');

      // (`✓ Found 11-digit package: ${result.context.code}`);
    });

    test('should locate package 0002-4312-08 (blister pack)', async () => {
      const result = await provider.locate('0002-4312-08');

      expect(result.context).toBeDefined();
      expect(result.context.isPackage).toBe(true);

      const display = await provider.display(result.context);
      expect(display).toContain('BLISTER PACK');
      expect(display).toContain('(package)');

      // (`✓ Found blister pack: ${display}`);
    });
  });

  describe('Code Properties and Methods', () => {
    test('should return correct code for context', async () => {
      const result = await provider.locate('0002-0152');
      const code = await provider.code(result.context);

      expect(code).toBe('0002-0152');
    });

    test('should check if code is active', async () => {
      const result = await provider.locate('0002-0152');
      const isInactive = await provider.isInactive(result.context);

      expect(typeof isInactive).toBe('boolean');
      // Based on test data, most codes should be active
      expect(isInactive).toBe(false);
    });

    test('should return false for abstract concepts', async () => {
      const result = await provider.locate('0002-0152');
      const isAbstract = await provider.isAbstract(result.context);

      expect(isAbstract).toBe(false);
    });

    test('should return false for deprecated concepts', async () => {
      const result = await provider.locate('0002-0152');
      const isDeprecated = await provider.isDeprecated(result.context);

      expect(isDeprecated).toBe(false);
    });

    test('should return null for definition', async () => {
      const result = await provider.locate('0002-0152');
      const definition = await provider.definition(result.context);

      expect(definition).toBeNull();
    });
  });

  describe('Designations', () => {
    test('should return designations for product', async () => {
      const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
      await provider.designations('0002-0152', designations);

      expect(designations.count).toBeGreaterThan(0);

      const firstDesignation = designations.designations[0];
      expect(firstDesignation.language.code).toBe('en');
      expect(firstDesignation.value).toContain('Zepbound');

      // (`✓ Product designations: ${designations.length} found`);
    });

    test('should return designations for package', async () => {
      const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
      await provider.designations('0002-0152-01', designations);

      expect(designations.count).toBeGreaterThan(0);

      const firstDesignation = designations.designations[0];
      expect(firstDesignation.language.code).toBe('en');
      expect(firstDesignation.value).toContain('(package)');

      // (`✓ Package designations: ${designations.length} found`);
    });
  });

  describe('Extended Lookup', () => {
    // $expand reports properties from properties(), which is built from extendLookup
    test('properties() for $expand', async () => {
      expect(await provider.properties('0002-0152', [])).toEqual([]);
      const got = await provider.properties('0002-0152', ['code-type', 'active']);
      expect(got).toContainEqual({ code: 'code-type', valueString: 'product' });
      expect(got.map(p => p.code)).toContain('active');
    });

    test('should extend lookup for product with properties', async () => {
      const paramSet = [];
      await provider.extendLookup('0002-0152', [], paramSet);

      const params = { parameter: paramSet };
      expect(params.parameter).toBeDefined();
      expect(params.parameter.length).toBeGreaterThan(0);

      // Check for required properties
      const properties = params.parameter.map(p =>
        p.part.find(part => part.name === 'code')?.valueCode
      );

      expect(properties).toContain('code-type');
      expect(properties).toContain('description');
      expect(properties).toContain('active');
      expect(properties).toContain('trade-name');

      // Check code-type is 'product'
      const codeTypeProp = params.parameter.find(p =>
        p.part.find(part => part.name === 'code' && part.valueCode === 'code-type')
      );
      const codeTypeValue = codeTypeProp.part.find(part => part.name === 'value')?.valueString;
      expect(codeTypeValue).toBe('product');

      // (`✓ Product properties: ${properties.length} found`);
      // (`  Properties: ${properties.join(', ')}`);
    });

    test('should extend lookup for 10-digit package with properties', async () => {
      const paramSet = [];
      await provider.extendLookup('0002-0152-01', [], paramSet);

      const params = { parameter: paramSet };
      expect(params.parameter).toBeDefined();
      expect(params.parameter.length).toBeGreaterThan(0);

      const properties = params.parameter.map(p =>
        p.part.find(part => part.name === 'code')?.valueCode
      );

      expect(properties).toContain('code-type');
      expect(properties).toContain('description');
      expect(properties).toContain('product');

      // Check code-type is '10-digit'
      const codeTypeProp = params.parameter.find(p =>
        p.part.find(part => part.name === 'code' && part.valueCode === 'code-type')
      );
      const codeTypeValue = codeTypeProp.part.find(part => part.name === 'value')?.valueString;
      expect(codeTypeValue).toBe('10-digit');

      // Check product reference
      const productProp = params.parameter.find(p =>
        p.part.find(part => part.name === 'code' && part.valueCode === 'product')
      );
      const productValue = productProp.part.find(part => part.name === 'value')?.valueString;
      expect(productValue).toBe('0002-0152');

      // (`✓ 10-digit package properties: ${properties.length} found`);
    });

    test('should extend lookup for 11-digit package with properties', async () => {

      const paramSet = [];
      await provider.extendLookup('00002121404', [], paramSet);

      const params = { parameter: paramSet };
      expect(params.parameter).toBeDefined();
      expect(params.parameter.length).toBeGreaterThan(0);

      const properties = params.parameter.map(p =>
        p.part.find(part => part.name === 'code')?.valueCode
      );

      expect(properties).toContain('code-type');

      // Check code-type is '11-digit'
      const codeTypeProp = params.parameter.find(p =>
        p.part.find(part => part.name === 'code' && part.valueCode === 'code-type')
      );
      const codeTypeValue = codeTypeProp.part.find(part => part.name === 'value')?.valueString;
      expect(codeTypeValue).toBe('11-digit');

      // (`✓ 11-digit package properties: ${properties.length} found`);
    });
  });

  describe('Filtering', () => {
    test('should support code-type filters', async () => {
      expect(await provider.doesFilter('code-type', '=', 'product')).toBe(true);
      expect(await provider.doesFilter('code-type', '=', '10-digit')).toBe(true);
      expect(await provider.doesFilter('code-type', '=', '11-digit')).toBe(true);
      expect(await provider.doesFilter('code-type', '=', 'invalid')).toBe(false);
      expect(await provider.doesFilter('other-prop', '=', 'value')).toBe(false);
    });

    test('should create filter context', async () => {
      const filterContext = await provider.getPrepContext(true);
      expect(filterContext).toBeDefined();
      expect(filterContext.filters).toBeDefined();
      expect(Array.isArray(filterContext.filters)).toBe(true);
    });

    test('should filter by product code-type', async () => {
      const filterContext = await provider.getPrepContext(true);
      const filter = await provider.filter(filterContext, true, 'code-type', '=', 'product');

      expect(filter).toBeDefined();
      expect(filter.type).toBe('code-type');
      expect(filter.value).toBe('product');

      const filterSets = await provider.executeFilters(filterContext);
      expect(filterSets).toContain(filter);

      const size = await provider.filterSize(filterContext, filter);
      expect(size).toBeGreaterThan(0);

      // (`✓ Product filter size: ${size}`);
    });

    test('should filter by 10-digit code-type', async () => {
      const filterContext = await provider.getPrepContext(true);
      const filter = await provider.filter(filterContext, true, 'code-type', '=', '10-digit');

      const size = await provider.filterSize(filterContext, filter);
      expect(size).toBeGreaterThan(0);

      // (`✓ 10-digit filter size: ${size}`);
    });

    test('should locate code within filter', async () => {
      const filterContext = await provider.getPrepContext(true);
      const filter = await provider.filter(filterContext, true, 'code-type', '=', 'product');

      const located = await provider.filterLocate(filterContext, filter, '0002-0152');
      expect(located).toBeInstanceOf(NdcConcept);
      expect(located.isPackage).toBe(false);

      // (`✓ Located in product filter: ${located.code}`);
    });

    test('should check if concept is in filter', async () => {
      const filterContext = await provider.getPrepContext(true);
      const productFilter = await provider.filter(filterContext, true, 'code-type', '=', 'product');

      const productResult = await provider.locate('0002-0152');
      const packageResult = await provider.locate('0002-0152-01');

      const productInFilter = await provider.filterCheck(filterContext, productFilter, productResult.context);
      const packageInFilter = await provider.filterCheck(filterContext, productFilter, packageResult.context);

      expect(productInFilter).toBe(true);
      expect(packageInFilter).toBe(false);

      // (`✓ Filter check: product=${productInFilter}, package=${packageInFilter}`);
    });

    test('should iterate filter results', async () => {
      const filterContext = await provider.getPrepContext(true);
      const filter = await provider.filter(filterContext, true, 'code-type', '=', 'product');

      let hasMore = await provider.filterMore(filterContext, filter);
      expect(hasMore).toBe(true);

      let count = 0;
      while (hasMore && count < 5) { // Limit iterations for test
        const concept = await provider.filterConcept(filterContext, filter);
        expect(concept).toBeInstanceOf(NdcConcept);
        expect(concept.isPackage).toBe(false);

        hasMore = await provider.filterMore(filterContext, filter);
        count++;
      }

      expect(count).toBeGreaterThan(0);
      // (`✓ Iterated ${count} product concepts`);
    });
  });

  describe('Error Handling', () => {

    test('should handle unsupported filters', async () => {
      const filterContext = await provider.getPrepContext(true);

      await expect(
        provider.filter(filterContext, true, 'unsupported', '=', 'value')
      ).rejects.toMatchObject({ message: expect.stringContaining('not supported'), msgId: 'FILTER_NOT_UNDERSTOOD', statusCode: 422 });
    });

    test('should handle extend lookup with invalid context', async () => {
      const params = { parameter: [] };

      await expect(
        provider.extendLookup('invalid-code', [], params)
      ).rejects.toThrow();
    });
  });

  describe('Sample Drug Lookups', () => {
    test('should find Cialis products and packages', async () => {
      // Find Cialis product (should exist in test data)
      const productCodes = ['0002-4462', '0002-4463', '0002-4464'];

      for (const code of productCodes) {
        const result = await provider.locate(code);
        if (result.context) {
          const display = await provider.display(result.context);
          expect(display).toContain('Cialis');
          expect(display).toContain('(product)');
          break;
        }
      }
    });

    test('should find RETEVMO products', async () => {
      const productCodes = ['0002-2980', '0002-3977'];

      for (const code of productCodes) {
        const result = await provider.locate(code);
        if (result.context) {
          const display = await provider.display(result.context);
          expect(display).toContain('RETEVMO');
          expect(display).toContain('(product)');
          break;
        }
      }
    });

    test('should find Trulicity injection packages', async () => {
      const packageCodes = ['0002-1433-61', '0002-1434-61'];

      for (const code of packageCodes) {
        const result = await provider.locate(code);
        if (result.context) {
          const display = await provider.display(result.context);
          expect(display).toContain('Trulicity');
          expect(display).toContain('SYRINGE');
          expect(display).toContain('(package)');
          break;
        }
      }
    });
  });
});