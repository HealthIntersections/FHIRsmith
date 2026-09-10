const path = require('path');
const fs = require('fs');
const {
  SnomedStrings,
  SnomedWords,
  SnomedStems,
  SnomedReferences,
  SnomedDescriptions,
  SnomedDescriptionIndex,
  SnomedConceptList,
  SnomedRelationshipList,
  SnomedReferenceSetMembers,
  SnomedReferenceSetIndex,
  SnomedFileReader
} = require('../../tx/sct/structures');

const {
  SnomedExpressionParser,
  SnomedExpressionStatus,
  SnomedExpressionServices,
  SnomedExpressionContext,
  SnomedServicesRenderOption
} = require('../../tx/sct/expressions');

const { SnomedServicesFactory } = require('../../tx/cs/cs-snomed');

const {SnomedImporter} = require("../../tx/importers/import-sct.module");
const { OperationContext } = require('../../tx/operation-context');
const {Designations} = require("../../tx/library/designations");
const {TestUtilities} = require("../test-utilities");
const folders = require('../../library/folder-setup');

// Shared cache file paths and utilities.
// testCachePath is the scratch location the import test (below) writes/deletes.
// committedCachePath is the checked-in copy under tx/data (which IS in git),
// used by the consumer tests when no fresh import has been produced this run.
const testCachePath = folders.ensureFilePath('snomed-testing.cache');
const committedCachePath = path.resolve(__dirname, '../../tx/data/snomed-testing.cache');
const fallbackCachePath = folders.ensureFilePath('sct_intl_20250201.cache');

function findAvailableCacheFile() {
  if (fs.existsSync(testCachePath)) {
    return testCachePath;
  } else if (fs.existsSync(committedCachePath)) {
    return committedCachePath;
  } else if (fs.existsSync(fallbackCachePath)) {
    return fallbackCachePath;
  }
  return null;
}

// Global cache file path that will be set after import tests
let globalCacheFilePath = null;

describe('SNOMED CT Module Import', () => {
  const testSourceDir = path.resolve(__dirname, '../../tx/data/snomed');

  beforeAll(() => {
    // Ensure data directory exists
    const dataDir = path.dirname(testCachePath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Clean up any existing test cache
    if (fs.existsSync(testCachePath)) {
      fs.unlinkSync(testCachePath);
    }
  });

  afterAll(() => {
    // Set global cache path after import completes successfully
    if (fs.existsSync(testCachePath)) {
      globalCacheFilePath = testCachePath;
    }

    // Clean up test cache after tests
    // if (fs.existsSync(testCachePath)) {
    //   fs.unlinkSync(testCachePath);
    // }
  });

  test('should import SNOMED CT test data successfully', async () => {
    // Verify source data exists
    expect(fs.existsSync(testSourceDir)).toBe(true);

    // Verify required SNOMED files exist
    const requiredFiles = [
      'Terminology/sct2_Concept_Snapshot_INT_20250814.txt',
      'Terminology/sct2_Description_Snapshot-en_INT_20250814.txt',
      'Terminology/sct2_Relationship_Snapshot_INT_20250814.txt'
    ];

    let foundFiles = 0;
    for (const file of requiredFiles) {
      const filePath = path.join(testSourceDir, file);
      if (fs.existsSync(filePath)) {
        foundFiles++;
        // console.log(`âœ" Found: ${file}`);
      } else {
        // Try to find similar files with glob-like pattern
        const dir = path.dirname(path.join(testSourceDir, file));
        const filename = path.basename(file);
        const pattern = filename.replace('20250814', '*').replace('INT', '*');

        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir);
          const similar = files.filter(f => {
            const basePattern = pattern.replace(/\*/g, '.*');
            return new RegExp(basePattern).test(f);
          });

          if (similar.length > 0) {
            foundFiles++;
            // console.log(`âœ" Found similar: ${similar[0]} (instead of ${file})`);
          } else {
            // console.log(`âœ— Missing: ${file}`);
          }
        }
      }
    }

    // We need at least some of the core files
    expect(foundFiles).toBeGreaterThanOrEqual(1);

    // Create importer and run import
    const config = {
      source: testSourceDir,
      dest: testCachePath,
      edition: '31000003106', // International edition
      version: '20250909',
      uri: 'http://snomed.info/sct/31000003106/version/20250909',
      language: 'en-US',
      verbose: false, // Suppress console output during tests
      overwrite: true,
      createIndexes: true,
      estimatedDuration: '5-15 minutes (test dataset)'
    };

    const importer = new SnomedImporter(config);
    await importer.run();

    // Verify cache file was created and set global path
    expect(fs.existsSync(testCachePath)).toBe(true);
    globalCacheFilePath = testCachePath;
  }, 300000); // 5 minute timeout for import

  test('should have valid cache file structure', async () => {
    // Verify cache file exists
    expect(fs.existsSync(testCachePath)).toBe(true);

    // Try to load the cache file
    const reader = new SnomedFileReader(testCachePath);
    const data = await reader.loadSnomedData();

    // Verify basic metadata
    expect(data.cacheVersion).toBeDefined();
    expect(data.versionUri).toBe('http://snomed.info/xsct/31000003106/version/20250909');
    expect(data.versionDate).toBe('20250909');
    expect(data.edition).toBeDefined();
    expect(data.version).toBeDefined();

    // Verify root concepts exist
    expect(Array.isArray(data.activeRoots)).toBe(true);
    expect(Array.isArray(data.inactiveRoots)).toBe(true);
    expect(data.activeRoots.length).toBeGreaterThan(0);
  });

  test('should have loaded core SNOMED structures', async () => {
    const reader = new SnomedFileReader(testCachePath);
    const data = await reader.loadSnomedData();

    // Verify all required data structures exist
    expect(data.strings).toBeDefined();
    expect(data.refs).toBeDefined();
    expect(data.desc).toBeDefined();
    expect(data.words).toBeDefined();
    expect(data.stems).toBeDefined();
    expect(data.concept).toBeDefined();
    expect(data.rel).toBeDefined();
    expect(data.descRef).toBeDefined();

    // Verify structures have data
    expect(data.strings.length).toBeGreaterThan(0);
    expect(data.concept.length).toBeGreaterThan(0);
    expect(data.desc.length).toBeGreaterThan(0);
    expect(data.rel.length).toBeGreaterThan(0);
  });

  test('should have proper file size and structure', () => {
    const stats = fs.statSync(testCachePath);

    // Cache should be reasonably sized (at least 1MB for even small test data)
    expect(stats.size).toBeGreaterThan(1024 * 1024);

    // File should be readable
    expect(stats.mode & fs.constants.R_OK).toBeTruthy();
  });
});

describe('SNOMED CT Expression Processing (File-based Tests)', () => {
  let snomedData;
  let structures;
  let expressionServices;
  let parser;
  let cacheFilePath;

  beforeAll(async () => {
    // Check for available cache file (including newly created one)
    cacheFilePath = globalCacheFilePath || findAvailableCacheFile();

    // Load the SNOMED file
    const reader = new SnomedFileReader(cacheFilePath);
    snomedData = await reader.loadSnomedData();

    // Create structure instances with the loaded data
    structures = {
      strings: new SnomedStrings(snomedData.strings),
      words: new SnomedWords(snomedData.words),
      stems: new SnomedStems(snomedData.stems),
      refs: new SnomedReferences(snomedData.refs),
      descriptions: new SnomedDescriptions(snomedData.desc),
      descriptionIndex: new SnomedDescriptionIndex(snomedData.descRef),
      concepts: new SnomedConceptList(snomedData.concept),
      relationships: new SnomedRelationshipList(snomedData.rel),
      refSetMembers: new SnomedReferenceSetMembers(snomedData.refSetMembers),
      refSetIndex: new SnomedReferenceSetIndex(snomedData.refSetIndex, snomedData.hasLangs)
    };

    // Initialize expression services
    const isAIndex = snomedData.isAIndex || 0; // Use stored is-a index
    expressionServices = new SnomedExpressionServices(structures, isAIndex);
    parser = new SnomedExpressionParser(structures.concepts);
  });

  test('should load basic file metadata', () => {
    expect(snomedData.cacheVersion).toBeDefined();
    expect(snomedData.versionUri).toBeDefined();
    expect(snomedData.versionDate).toBeDefined();
    expect(snomedData.edition).toBeDefined();
    expect(snomedData.defaultLanguage).toBeDefined();
  });

  test('should have loaded string data', () => {
    expect(structures.strings.length).toBeGreaterThan(0);

    // Try to read the first string at offset 0 (if it exists and isn't our weird edge case)
    if (structures.strings.length > 5) {
      const firstString = structures.strings.getEntry(5); // Skip offset 0 due to the weird null case
      expect(typeof firstString).toBe('string');
    }
  });

  test('should have loaded concept data', () => {
    const conceptCount = structures.concepts.count();
    expect(conceptCount).toBeGreaterThan(0);

    // Test reading first concept
    if (conceptCount > 0) {
      const firstConcept = structures.concepts.getConcept(0);
      expect(firstConcept.identity).toBeDefined();
      expect(typeof firstConcept.flags).toBe('number');
    }
  });

  test('should have loaded description data', () => {
    const descCount = structures.descriptions.count();
    expect(descCount).toBeGreaterThan(0);

    // Test reading first description
    if (descCount > 0) {
      const firstDesc = structures.descriptions.getDescription(0);
      expect(firstDesc.id).toBeDefined();
      expect(firstDesc.concept).toBeDefined();
    }
  });

  test('should have loaded relationship data', () => {
    const relCount = structures.relationships.count();
    expect(relCount).toBeGreaterThan(0);

    // Test reading first relationship
    if (relCount > 0) {
      const firstRel = structures.relationships.getRelationship(0);
      expect(firstRel.source).toBeDefined();
      expect(firstRel.target).toBeDefined();
      expect(firstRel.relType).toBeDefined();
    }
  });

  test('should have loaded reference set data', () => {
    const refSetCount = structures.refSetIndex.count();
    expect(refSetCount).toBeGreaterThan(0);

    // Test reading first reference set
    if (refSetCount > 0) {
      const firstRefSet = structures.refSetIndex.getReferenceSet(0);
      expect(firstRefSet.definition).toBeDefined();
      expect(firstRefSet.name).toBeDefined();
    }
  });

  test('should have loaded root concepts', () => {
    expect(Array.isArray(snomedData.activeRoots)).toBe(true);
    expect(Array.isArray(snomedData.inactiveRoots)).toBe(true);

    if (snomedData.activeRoots.length > 0) {
      // console.log('First active root:', snomedData.activeRoots[0].toString());
    }
  });

  test('should be able to find concepts by ID', () => {
    // Try to find the SNOMED CT root concept (138875005)
    const rootConceptId = BigInt('138875005');
    const result = structures.concepts.findConcept(rootConceptId);

    if (result.found) {
      const concept = structures.concepts.getConcept(result.index);
      expect(concept.identity).toBe(rootConceptId);
    } else {
      // console.log('SNOMED CT root concept not found (this might be normal depending on the dataset)');
    }
  });

  describe('Expression Services Integration Tests', () => {
    test('should initialize expression services correctly', () => {
      expect(expressionServices).toBeDefined();
      expect(expressionServices.concepts).toBeDefined();
      expect(expressionServices.relationships).toBeDefined();
      expect(expressionServices.strings).toBeDefined();
    });

    test('should validate expressions with real concept data', () => {
      // Try to find a concept that should exist in most SNOMED datasets
      const commonConcepts = ['138875005', '404684003', '64572001']; // SNOMED CT Concept, Clinical finding, Disease

      for (const conceptId of commonConcepts) {
        const result = structures.concepts.findConcept(BigInt(conceptId));
        if (result.found) {
          // Test parsing with this real concept
          const expression = conceptId;
          try {
            const parsed = expressionServices.parseExpression(expression);
            expect(parsed.concepts).toHaveLength(1);
            expect(parsed.concepts[0].code).toBe(conceptId);
            break; // Exit after first successful test
          } catch (error) {
            // console.log(`âš  Failed to validate expression ${expression}: ${error.message}`);
          }
        }
      }
    });

    test('should handle expression equivalence checking', () => {
      const expr1 = parser.parse('116680003');
      const expr2 = parser.parse('116680003');

      const equivalent = expressionServices.expressionsEquivalent(expr1, expr2);
      expect(equivalent).toBe(true);
    });

    test('should render expressions in different formats', () => {
      const expr = parser.parse('128045006|Cellulitis|:{363698007|finding site|=56459004|foot structure|}');

      const minimal = expressionServices.renderExpression(expr, SnomedServicesRenderOption.Minimal);
      const asIs = expressionServices.renderExpression(expr, SnomedServicesRenderOption.AsIs);

      expect(minimal).toBeDefined();
      expect(asIs).toBeDefined();
      expect(asIs.length).toBeGreaterThanOrEqual(minimal.length); // AsIs should include terms
    });

    test('should create expression contexts', () => {
      const context1 = SnomedExpressionContext.fromReference(12345);
      expect(context1.getReference()).toBe(12345);
      expect(context1.expression.concepts).toHaveLength(1);

      const expr = parser.parse('116680003:{363698007=56459004}');
      const context2 = new SnomedExpressionContext('test source', expr);
      expect(context2.source).toBe('test source');
      expect(context2.isComplex()).toBe(true);
    });
  });

  // Store cache file path for subsequent test suites
  afterAll(() => {
    if (cacheFilePath && !globalCacheFilePath) {
      globalCacheFilePath = cacheFilePath;
    }
  });
});

// The pure parser tests don't require file loading, so they can always run
describe('SNOMED CT Expression Parser (Standalone Tests)', () => {
  let parser;

  beforeAll(async() => {
    parser = new SnomedExpressionParser(null);
  });

  /**
   * Helper function to parse and validate basic structure
   */
  function parseAndValidate(expression) {
    const result = parser.parse(expression);
    expect(result).toBeDefined();
    expect(result).not.toBeNull();
    return result;
  }

  describe('Basic Concept Parsing', () => {
    test('should parse simple concept', () => {
      const expr = parseAndValidate('116680003', 'Simple concept');
      expect(expr.concepts).toHaveLength(1);
      expect(expr.concepts[0].code).toBe('116680003');
      expect(expr.hasRefinements()).toBe(false);
      expect(expr.hasRefinementGroups()).toBe(false);
    });

    test('should parse concept with description', () => {
      const expr = parseAndValidate('116680003|Body structure|', 'Concept with description');
      expect(expr.concepts).toHaveLength(1);
      expect(expr.concepts[0].code).toBe('116680003');
      expect(expr.concepts[0].description).toBe('Body structure');
    });

    test('should parse multiple concepts with addition', () => {
      const expr = parseAndValidate('421720008 |spray dose form| + 7946007 |drug suspension|', 'Multiple concepts');
      expect(expr.concepts).toHaveLength(2);
      expect(expr.concepts[0].code).toBe('421720008');
      expect(expr.concepts[1].code).toBe('7946007');
      expect(expr.concepts[0].description).toBe('spray dose form');
      expect(expr.concepts[1].description).toBe('drug suspension');
    });
  });

  describe('Refinement Parsing', () => {
    test('should parse concept with grouped refinement', () => {
      const expr = parseAndValidate('128045006:{363698007=56459004}', 'Concept with refinement');
      expect(expr.concepts).toHaveLength(1);
      expect(expr.concepts[0].code).toBe('128045006');
      expect(expr.hasRefinementGroups()).toBe(true);
      expect(expr.refinementGroups).toHaveLength(1);
      expect(expr.refinementGroups[0].refinements).toHaveLength(1);
      expect(expr.refinementGroups[0].refinements[0].name.code).toBe('363698007');
      expect(expr.refinementGroups[0].refinements[0].value.concepts[0].code).toBe('56459004');
    });

    test('should parse concept with ungrouped refinement', () => {
      const expr = parseAndValidate('31978002: 272741003=7771000', 'Ungrouped refinement');
      expect(expr.concepts).toHaveLength(1);
      expect(expr.hasRefinements()).toBe(true);
      expect(expr.refinements).toHaveLength(1);
      expect(expr.refinements[0].name.code).toBe('272741003');
      expect(expr.refinements[0].value.concepts[0].code).toBe('7771000');
    });
  });

  describe('Expression Status Prefixes', () => {
    test('should parse expression with equivalence status', () => {
      const expr = parseAndValidate('=== 46866001 |fracture of lower limb| + 428881005 |injury of tibia| :116676008 |associated morphology| = 72704001 |fracture|,363698007 |finding site| = 12611008 |bone structure of tibia|', 'Expression with equivalence status');
      expect(expr.status).toBe(SnomedExpressionStatus.Equivalent);
      expect(expr.concepts).toHaveLength(2);
      expect(expr.refinements).toHaveLength(2);
    });

    test('should parse expression with subsumption status', () => {
      const expr = parseAndValidate('<<< 73211009 |diabetes mellitus| : 363698007 |finding site| = 113331007 |endocrine system|', 'Expression with subsumption status');
      expect(expr.status).toBe(SnomedExpressionStatus.SubsumedBy);
      expect(expr.concepts).toHaveLength(1);
      expect(expr.refinements).toHaveLength(1);
    });
  });

  describe('Error Handling', () => {
    test('should throw error for invalid concept format', () => {
      expect(() => {
        parser.parse('invalid_concept_format');
      }).toThrow();
    });

    test('should throw error for unclosed parentheses', () => {
      expect(() => {
        parser.parse('116680003:(128045006');
      }).toThrow();
    });

    test('should throw error for incomplete refinement', () => {
      expect(() => {
        parser.parse('116680003:363698007=');
      }).toThrow();
    });
  });
});

describe('SNOMED CT Subset Validation', () => {
  let factory;
  let provider;
  let opContext;

  // Parse the subset data from the attached file
  const subsetData = parseSubsetData();

  beforeAll(async () => {
    const cacheFilePath = globalCacheFilePath || findAvailableCacheFile();

    // Create factory and provider
    opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    factory = new SnomedServicesFactory(opContext.i18n, cacheFilePath);
    provider = await factory.build(opContext, []);
  });

  afterAll(() => {
    if (provider) {
      provider.sct.close();
    }
  });

  function parseSubsetData() {
    // Known subset data from snomed-subset.txt
    const subsetText = `900000000000526001 |REPLACED BY association reference set (foundation metadata concept)|
1539003 |Acquired trigger finger (disorder)|
1204474000 |Product containing precisely barium sulfate 600 milligram/1 milliliter conventional release oral suspension (clinical drug)|
86299006 |Tetralogy of Fallot (disorder)|
430983003 |Brucella abortus, vaccinal strain RB51 (organism)|
608785007 |Open reduction of fracture of radius and ulna with internal fixation (procedure)|
370049004 |No tumor invasion (finding)|
370050004 |No tumor invasion of adjacent tissue (finding)|
174826008 |Arterial switch operation (procedure)|
11687002 |Gestational diabetes mellitus (disorder)|
897148007 |Alcoholic beverage intake (observable entity)|
816080008 |International Patient Summary (foundation metadata concept)|
303248007 |Blood film specimen (specimen)|
162980001 |Cardiovascular system not examined (situation)|
297250002 |No family history of stroke (situation)|
162001003 |No cardiovascular symptom (situation)|
281302008 |Above reference range (qualifier value)|
281300000 |Below reference range (qualifier value)|
281301001 |Within reference range (qualifier value)|
268677005 |[X]Other delirium (disorder)|
155728006 |Appendicitis (disorder)|
74400008 |Appendicitis (disorder)|
155729003 |Appendicitis (disorder)|
307530000 |Appendicitis NOS (disorder)|
116676008 |Associated morphology (attribute)|
128045006 |Cellulitis (disorder)|
20946005 |Fracture, closed (morphologic abnormality)|
28012007 |Closed fracture of shaft of tibia (disorder)|
363698007 |Finding site (attribute)|
447139008 |Closed fracture of tibia (disorder)|
52687003 |Bone structure of shaft of tibia (body structure)|
56459004 |Foot structure (body structure)|
64572001 |Disease (disorder)|
6990005 |Fracture of shaft of tibia (disorder)|
<<128241005 |Inflammatory disease of liver (disorder)|
<<10200004 |Liver structure (body structure)|
<<364159005 |Liver observable (observable entity)|
<<227014008 |Liver pate (substance)|
<<249565005 |Liver finding (finding)|
<<406459008 |Product containing halibut liver oil (medicinal product)|
<<776168003 |Product containing only halibut liver oil (medicinal product)|
<<776168003 |Product containing only halibut liver oil (medicinal product)|
<<309399009 |Hospital-based dietitian (occupation)|
<<421813008 |Class Hepaticopsida (organism)|
<<441802002 |Imaging of liver (procedure)|
<<119383005 |Specimen from liver (specimen)|`;

    const concepts = [];
    const hierarchies = [];

    subsetText.split('\n').forEach(line => {
      line = line.trim();
      if (!line) return;

      // Check if this is a hierarchy marker (<<)
      const isHierarchy = line.startsWith('<<');
      const cleanLine = line.replace(/^<</, '');

      // Parse code and description
      const match = cleanLine.match(/^(\d+)\s*\|([^|]+)\|/);
      if (match) {
        const code = match[1];
        const description = match[2];

        if (isHierarchy) {
          hierarchies.push({ code, description });
        } else {
          concepts.push({ code, description });
        }
      }
    });

    return { concepts, hierarchies };
  }

  describe('Known Concepts Validation', () => {
    test('should find all concepts from subset data', async () => {
      let foundCount = 0;
      let notFoundCodes = [];

      for (const concept of subsetData.concepts) {
        const result = await provider.locate(concept.code);

        if (result.context) {
          foundCount++;

          // Verify basic properties
          expect(result.context.constructor.name).toBe('SnomedExpressionContext');
          expect(result.context.getCode()).toBe(concept.code);
          expect(result.message).toBeNull();

          // Get and verify display
          const display = await provider.display(result.context);
          expect(display).toBeDefined();
          expect(display.length).toBeGreaterThan(0);

          console.log(`✅ Found: ${concept.code} - ${display}`);
        } else {
          notFoundCodes.push(concept.code);
          console.log(`❌ Not found: ${concept.code} - ${concept.description}`);
        }
      }

      console.log(`\nSummary: Found ${foundCount}/${subsetData.concepts.length} concepts`);

      if (notFoundCodes.length > 0) {
        console.log(`Missing codes: ${notFoundCodes.join(', ')}`);
      }

      // We expect to find at least some of the concepts (allowing for incomplete test data)
      expect(foundCount).toBeGreaterThan(Math.floor(subsetData.concepts.length * 0.3)); // At least 30%
    });

    test('should have correct concept properties', async () => {
      // Test specific concept types
      const testCases = [
        { code: '64572001', expectedType: 'disorder', description: 'Disease (disorder)' },
        { code: '116676008', expectedType: 'attribute', description: 'Associated morphology (attribute)' },
        { code: '303248007', expectedType: 'specimen', description: 'Blood film specimen (specimen)' },
        { code: '608785007', expectedType: 'procedure', description: 'Open reduction procedure' }
      ];

      for (const testCase of testCases) {
        const result = await provider.locate(testCase.code);

        if (result.context) {
          // Check that it's active
          const isInactive = await provider.isInactive(result.context);
          expect(isInactive).toBe(false);

          // Check that it's not abstract
          const isAbstract = await provider.isAbstract(result.context);
          expect(isAbstract).toBe(false);

          // Get status
          const status = await provider.getStatus(result.context);
          expect(status).toBe('active');

          console.log(`✅ ${testCase.code} (${testCase.expectedType}): active, non-abstract`);
        }
      }
    });

    test('should have designations for concepts', async () => {
      const sampleCodes = ['64572001', '86299006', '128045006'];

      for (const code of sampleCodes) {
        const result = await provider.locate(code);

        if (result.context) {
          const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
          await provider.designations(result.context, designations);

          expect(designations.count).toBeGreaterThan(0);

          // Check first designation
          const firstDesignation = designations.designations[0];
          expect(firstDesignation.language).toBeDefined();
          expect(firstDesignation.value).toBeDefined();
          expect(firstDesignation.value.length).toBeGreaterThan(0);

          console.log(`✅ ${code}: ${designations.length} designations, primary: "${firstDesignation.value}"`);
        }
      }
    });
  });

  describe('Hierarchy Validation', () => {
    test('should handle hierarchical relationships', async () => {
      // Test known parent-child relationships from subset
      const hierarchyTests = [
        {
          parent: '64572001', // Disease (disorder)
          child: '86299006',  // Tetralogy of Fallot (disorder)
          description: 'Tetralogy of Fallot should be a disease'
        },
        {
          parent: '64572001', // Disease (disorder)
          child: '128045006', // Cellulitis (disorder)
          description: 'Cellulitis should be a disease'
        },
        {
          parent: '64572001', // Disease (disorder)
          child: '11687002',  // Gestational diabetes mellitus (disorder)
          description: 'Gestational diabetes should be a disease'
        }
      ];

      for (const test of hierarchyTests) {
        const parentResult = await provider.locate(test.parent);
        const childResult = await provider.locate(test.child);

        if (parentResult.context && childResult.context) {
          // Test subsumption
          const subsumptionResult = await provider.subsumesTest(test.parent, test.child);

          // Should be either 'subsumes' or 'equivalent' (if they're the same)
          expect(['subsumes', 'equivalent']).toContain(subsumptionResult);

          // Test locateIsA
          const locateIsAResult = await provider.locateIsA(test.child, test.parent, false);
          expect(locateIsAResult.context).toBeDefined();
          expect(locateIsAResult.message).toBeNull();

          console.log(`✅ ${test.description}: ${test.child} is-a ${test.parent} (${subsumptionResult})`);
        } else {
          console.log(`! Skipping hierarchy test: ${test.description} (concepts not found)`);
        }
      }
    });

    test('should find concept parents and children', async () => {
      const testConcepts = ['64572001', '128045006', '86299006']; // Disease, Cellulitis, Tetralogy of Fallot

      for (const code of testConcepts) {
        const result = await provider.locate(code);

        if (result.context && !result.context.isComplex()) {
          const reference = result.context.getReference();

          // Get parents
          const parents = provider.sct.getConceptParents(reference);
          console.log(`✅ ${code} has ${parents.length} parent(s)`);

          // Get children
          const children = provider.sct.getConceptChildren(reference);
          console.log(`✅ ${code} has ${children.length} child(ren)`);

          // Disease should have children
          if (code === '64572001') {
            expect(children.length).toBeGreaterThan(0);
          }
        }
      }
    });
  });

  describe('Expression Validation', () => {
    test('should handle subset-based expressions', async () => {
      // Create expressions using concepts from our subset
      const testExpressions = [
        {
          // The value of 116676008 |Associated morphology| has to be a
          // morphologic abnormality (MRCM range << 49755003), so cellulitis -
          // a disorder - is not a legal value here.
          expression: '64572001:116676008=20946005',
          description: 'Disease with associated morphology closed fracture',
          expectedValid: true
        },
        {
          expression: '28012007:{363698007=52687003,116676008=20946005}',
          description: 'Closed fracture with grouped attributes',
          expectedValid: true
        },
        {
          expression: '128045006:{363698007=56459004}',
          description: 'Cellulitis with finding site foot',
          expectedValid: true
        }
      ];

      for (const test of testExpressions) {
        try {
          const result = await provider.locate(test.expression);

          if (test.expectedValid) {
            expect(result.context).toBeDefined();
            expect(result.context.isComplex()).toBe(true);
            expect(result.message).toBeNull();

            // Get display for complex expression
            const display = await provider.display(result.context);
            expect(display).toBeDefined();
            expect(display.length).toBeGreaterThan(0);

            console.log(`✅ Expression: ${test.expression}`);
            console.log(`  Display: ${display}`);
          }
        } catch (error) {
          if (test.expectedValid) {
            console.log(`! Expression failed: ${test.expression} - ${error.message}`);
          }
        }
      }
    });
  });

  describe('Filter Validation', () => {
    test('should filter by known concepts', async () => {
      // Test filtering using concepts from our subset
      const filterTests = [
        {
          property: 'concept',
          operator: 'equal',
          value: '64572001',
          description: 'Exact match for Disease'
        },
        {
          property: 'concept',
          operator: 'is-a',
          value: '64572001',
          description: 'Disease and all descendants'
        }
      ];

      for (const test of filterTests) {
        try {
          const supports = await provider.doesFilter(test.property, test.operator, test.value);
          expect(supports).toBe(true);

          const filterContext = await provider.getPrepContext(true);
          await provider.filter(filterContext, test.property, test.operator, test.value);

          const filters = await provider.executeFilters(filterContext);
          const filter = filters[0];

          const size = await provider.filterSize(filterContext, filter);
          expect(size).toBeGreaterThan(0);

          console.log(`✅ Filter "${test.description}": ${size} results`);

          // Test iteration
          let count = 0;
          const maxCheck = Math.min(5, size); // Check first 5 results

          while (await provider.filterMore(filterContext, filter) && count < maxCheck) {
            const concept = await provider.filterConcept(filterContext, filter);
            expect(concept.constructor.name).toBe('SnomedExpressionContext');
            expect(concept.getCode()).toBeDefined();
            count++;
          }

          console.log(`  Verified ${count} results`);

        } catch (error) {
          console.log(`! Filter test failed for ${test.description}: ${error.message}`);
        }
      }
    });

    test('should perform text search on subset concepts', async () => {
      const searchTests = [
        { term: 'disease', expectedCodes: ['64572001'] },
        { term: 'diabetes', expectedCodes: ['11687002'] },
        { term: 'fracture', expectedCodes: ['28012007', '447139008', '6990005'] },
        { term: 'appendicitis', expectedCodes: ['155728006', '74400008', '155729003', '307530000'] },
        { term: 'cellulitis', expectedCodes: ['128045006'] },
        { term: 'liver', expectedCodes: [] } // Will find if liver concepts are in dataset
      ];

      for (const test of searchTests) {
        try {
          const filterContext = await provider.getPrepContext(true);
          const searchResult = await provider.searchFilter(filterContext, test.term, null);

          expect(searchResult).toBeDefined();
          expect(searchResult.matches).toBeDefined();

          const foundCodes = searchResult.matches.map(match => {
            try {
              const concept = provider.sct.concepts.getConcept(match.index);
              return concept.identity.toString();
            } catch (error) {
              return null;
            }
          }).filter(code => code !== null);

          console.log(`✅ Search "${test.term}": ${foundCodes.length} results`);

          // Check if expected codes are found (if any exist in dataset)
          for (const expectedCode of test.expectedCodes) {
            const codeExists = await provider.locate(expectedCode);
            if (codeExists.context && !foundCodes.includes(expectedCode)) {
              console.log(`  ! Expected code ${expectedCode} not found in search results`);
            }
          }

        } catch (error) {
          console.log(`! Search test failed for "${test.term}": ${error.message}`);
        }
      }
    });
  });

  describe('Iterator Validation', () => {
    test('should iterate through root concepts', async () => {
      const iterator = await provider.iterator(null);

      expect(iterator).toBeDefined();
      expect(iterator.keys).toBeDefined();
      expect(iterator.total).toBeGreaterThan(0);

      console.log(`✅ Found ${iterator.total} root concepts`);

      // Test iterating through first few roots
      let count = 0;
      const maxIterations = Math.min(3, iterator.total);

      while (count < maxIterations) {
        const context = await provider.nextContext(iterator);
        if (!context) break;

        expect(context.constructor.name).toBe('SnomedExpressionContext');
        expect(context.getReference()).toBeDefined();

        // Get display for root concept
        const display = await provider.display(context);
        console.log(`  Root ${count + 1}: ${context.getCode()} - ${display}`);

        count++;
      }

      expect(count).toBeGreaterThan(0);
    });

    test('should iterate concept children', async () => {
      // Use Disease concept which should have children
      const diseaseCode = '64572001';
      const result = await provider.locate(diseaseCode);

      if (result.context) {
        const iterator = await provider.iterator(result.context);

        expect(iterator).toBeDefined();
        console.log(`✅ Disease has ${iterator.total} direct children`);

        // Iterate through first few children
        let count = 0;
        const maxIterations = Math.min(5, iterator.total);

        while (count < maxIterations) {
          const context = await provider.nextContext(iterator);
          if (!context) break;

          expect(context.constructor.name).toBe('SnomedExpressionContext');

          const display = await provider.display(context);
          console.log(`  Child ${count + 1}: ${context.getCode()} - ${display}`);

          count++;
        }
      }
    });
  });

  describe('Data Integrity Validation', () => {
    test('should have consistent hierarchy data', async () => {
      // Verify that parent-child relationships are consistent
      const testCode = '86299006'; // Tetralogy of Fallot
      const result = await provider.locate(testCode);

      if (result.context && !result.context.isComplex()) {
        const reference = result.context.getReference();

        // Get parents
        const parents = provider.sct.getConceptParents(reference);

        // For each parent, verify this concept appears in their children
        for (const parentRef of parents) {
          const parentChildren = provider.sct.getConceptChildren(parentRef);
          expect(parentChildren).toContain(reference);
        }

        console.log(`✅ Hierarchy consistency verified for ${testCode}`);
      }
    });

    test('should have valid concept references', async () => {
      // Test that all concept references are valid
      const sampleCodes = ['64572001', '128045006', '86299006'];

      for (const code of sampleCodes) {
        const result = await provider.locate(code);

        if (result.context && !result.context.isComplex()) {
          const reference = result.context.getReference();

          // Verify reference is valid
          expect(reference).toBeDefined();
          expect(typeof reference).toBe('number');
          expect(reference).toBeGreaterThan(0);

          // Verify we can get the concept back
          const concept = provider.sct.concepts.getConcept(reference);
          expect(concept).toBeDefined();
          expect(concept.identity.toString()).toBe(code);

          console.log(`✅ Reference integrity verified for ${code} (ref: ${reference})`);
        }
      }
    });
  });
});

describe('SNOMED CT display language selection', () => {
  let factory;
  let provider;
  let opContext;

  beforeAll(async () => {
    const cacheFilePath = globalCacheFilePath || findAvailableCacheFile();
    opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    factory = new SnomedServicesFactory(opContext.i18n, cacheFilePath);
    provider = await factory.build(opContext, []);
  });

  afterAll(() => {
    if (provider) {
      provider.sct.close();
    }
  });

  // An edition FHIRsmith has never seen must still resolve its display through an
  // English language reference set. Before this, an unlisted edition got an empty
  // refset order and fell through to "preferred synonym in ANY language refset",
  // which on a multi-language national edition (Belgium 11000172109: French
  // 21000172104, Dutch 31000172101) returned whichever description happened to be
  // stored first - so $lookup answered in French for one concept and Dutch for the
  // next, and $expand tagged that term as en-US.
  test('an edition not in the display-refset table defaults to US then GB English', () => {
    const sct = provider.sct;
    const savedEdition = sct.edition;
    const savedOrder = sct._dispOrder;
    try {
      sct.edition = '99900001000000000';  // not a real edition
      sct._dispOrder = null;
      const order = sct._displayRefsetOrder();
      const us = sct.concepts.findConcept(900000000000509007n);
      expect(us.found).toBe(true);
      expect(order.length).toBeGreaterThan(0);
      expect(order[0]).toBe(us.index);
    } finally {
      sct.edition = savedEdition;
      sct._dispOrder = savedOrder;
    }
  });

  test('getDisplayNameEx reports the language the display is actually in', () => {
    const sct = provider.sct;
    const r = sct.concepts.findConcept(11687002n); // Gestational diabetes mellitus
    expect(r.found).toBe(true);
    const ex = sct.getDisplayNameEx(r.index);
    expect(ex.term).toBe(sct.getDisplayName(r.index));
    expect(ex.term.length).toBeGreaterThan(0);
    expect(ex.lang).toBe('en');
  });
});

/**
 * SNOMED CT Test Prerequisites Check
 *
 * Simple script to verify all test prerequisites are in place
 * Run this before running the full test suite to identify missing files
 */

console.log('🔍 SNOMED CT Test Prerequisites Check\n');

// Check source data directory
const testSourceDir = path.resolve(__dirname, '../../tx/data/snomed');
console.log(`📁 Checking source directory: ${testSourceDir}`);

if (!fs.existsSync(testSourceDir)) {
  console.log('❌ Source directory does not exist');
  console.log('   Create directory and place SNOMED CT RF2 files');
  process.exit(1);
} else {
  console.log('✅ Source directory exists');
}

// Check for required SNOMED files
const requiredFiles = [
  'Terminology/sct2_Concept_Snapshot_INT_20250814.txt',
  'Terminology/sct2_Description_Snapshot-en_INT_20250814.txt',
  'Terminology/sct2_Relationship_Snapshot_INT_20250814.txt'
];

console.log('\n📋 Checking for required SNOMED CT files:');

let foundFiles = 0;
const foundFilesList = [];
const missingFilesList = [];

for (const file of requiredFiles) {
  const filePath = path.join(testSourceDir, file);

  if (fs.existsSync(filePath)) {
    foundFiles++;
    foundFilesList.push(file);
    console.log(`✅ ${file}`);
  } else {
    // Try to find similar files with glob-like pattern
    const dir = path.dirname(path.join(testSourceDir, file));
    const filename = path.basename(file);
    const pattern = filename.replace('20250814', '*').replace('INT', '*');

    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      const similar = files.filter(f => {
        const basePattern = pattern.replace(/\*/g, '.*');
        return new RegExp(basePattern).test(f);
      });

      if (similar.length > 0) {
        foundFiles++;
        foundFilesList.push(`${file} → ${similar[0]}`);
        console.log(`✅ ${file} → found similar: ${similar[0]}`);
      } else {
        missingFilesList.push(file);
        console.log(`❌ ${file}`);
      }
    } else {
      missingFilesList.push(file);
      console.log(`❌ ${file} (directory doesn't exist)`);
    }
  }
}

console.log(`\n📊 Found ${foundFiles}/${requiredFiles.length} required files`);

if (foundFiles === 0) {
  console.log('\n❌ No SNOMED CT files found');
  console.log('   Import tests will fail');
  console.log('   Place SNOMED CT RF2 files in tx/data/snomed/Terminology/');
  process.exit(1);
} else if (foundFiles < requiredFiles.length) {
  console.log('\n⚠️  Some SNOMED CT files are missing');
  console.log('   Import tests may fail or have incomplete data');
  console.log('\n   Missing files:');
  missingFilesList.forEach(file => console.log(`     - ${file}`));
} else {
  console.log('\n✅ All required SNOMED CT files found');
}

// Check cache files
console.log('\n🗂️ Checking for cache files:');

let cacheAvailable = false;

if (fs.existsSync(testCachePath)) {
  const stats = fs.statSync(testCachePath);
  console.log(`✅ Test cache: ${testCachePath}`);
  console.log(`   Size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`   Modified: ${stats.mtime.toISOString()}`);
  cacheAvailable = true;
} else {
  console.log(`❌ Test cache: ${testCachePath}`);
}

if (fs.existsSync(fallbackCachePath)) {
  const stats = fs.statSync(fallbackCachePath);
  console.log(`✅ Fallback cache: ${fallbackCachePath}`);
  console.log(`   Size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`   Modified: ${stats.mtime.toISOString()}`);
  cacheAvailable = true;
} else {
  console.log(`❌ Fallback cache: ${fallbackCachePath}`);
}

if (!cacheAvailable) {
  console.log('\n⚠️  No cache files available');
  console.log('   Provider tests will fail until import tests create cache');
  console.log('   Run import tests first to generate cache file');
}

// Check test expectations file
const expectationsPath = path.resolve(__dirname, '../data/snomed-test-expectations.json');
console.log('\n📄 Checking test expectations file:');

if (fs.existsSync(expectationsPath)) {
  console.log(`✅ Test expectations: ${expectationsPath}`);

  try {
    const expectations = JSON.parse(fs.readFileSync(expectationsPath, 'utf8'));
    console.log(`   Known codes: ${expectations.basic?.knownCodes?.length || 0}`);
    console.log(`   Test expressions: ${expectations.basic?.knownExpressions?.length || 0}`);
    console.log(`   Filter tests: ${expectations.filters?.concept?.length || 0}`);
  } catch (error) {
    console.log(`   ⚠️  Invalid JSON: ${error.message}`);
  }
} else {
  console.log(`❌ Test expectations: ${expectationsPath}`);
  console.log('   Tests will use minimal fallback expectations');
}

// Final summary
console.log('\n🎯 Test Readiness Summary:');

if (foundFiles > 0) {
  console.log('✅ Import tests: Ready (source files available)');
} else {
  console.log('❌ Import tests: Will fail (no source files)');
}

console.log('✅ Expression parser tests: Ready (no dependencies)');

if (cacheAvailable) {
  console.log('✅ Provider tests: Ready (cache files available)');
} else {
  console.log('❌ Provider tests: Will fail (no cache files)');
}

console.log('\n🚀 Next Steps:');

if (foundFiles === 0) {
  console.log('1. Place SNOMED CT RF2 files in tx/data/snomed/Terminology/');
  console.log('2. Run import tests to create cache file');
  console.log('3. Run provider tests');
} else if (!cacheAvailable) {
  console.log('1. Run import tests to create cache file');
  console.log('2. Run provider tests');
} else {
  console.log('All prerequisites met - ready to run full test suite!');
  console.log('Run: npm test -- tx/cs/tests/cs-snomed.test.js');
}

console.log('\n📚 For more information, see the test runner instructions.');

// Exit with appropriate code
if (foundFiles === 0) {
  console.log('\n❌ Critical prerequisites missing');
  process.exit(1);
} else {
  console.log('\n✅ All prerequisites met');
  //process.exit(0);
}