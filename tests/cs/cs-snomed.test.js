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
const {Designations, SearchFilterText} = require("../../tx/library/designations");
const {TestUtilities} = require("../test-utilities");
const { Languages } = require('../../library/languages');
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
  });

  test('should be able to find concepts by ID', () => {
    // Try to find the SNOMED CT root concept (138875005)
    const rootConceptId = BigInt('138875005');
    const result = structures.concepts.findConcept(rootConceptId);

    // a subset dataset may not carry the root concept
    if (result.found) {
      const concept = structures.concepts.getConcept(result.index);
      expect(concept.identity).toBe(rootConceptId);
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
          const parsed = expressionServices.parseExpression(conceptId);
          expect(parsed.concepts).toHaveLength(1);
          expect(parsed.concepts[0].code).toBe(conceptId);
          break; // Exit after first successful test
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
        }
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

        // concepts absent from the loaded dataset are skipped
        if (parentResult.context && childResult.context) {
          // Test subsumption
          const subsumptionResult = await provider.subsumesTest(test.parent, test.child);

          // Should be either 'subsumes' or 'equivalent' (if they're the same)
          expect(['subsumes', 'equivalent']).toContain(subsumptionResult);

          // Test locateIsA
          const locateIsAResult = await provider.locateIsA(test.child, test.parent, false);
          expect(locateIsAResult.context).toBeDefined();
          expect(locateIsAResult.message).toBeNull();
        }
      }
    });

    test('should find concept parents and children', async () => {
      const testConcepts = ['64572001', '128045006', '86299006']; // Disease, Cellulitis, Tetralogy of Fallot

      for (const code of testConcepts) {
        const result = await provider.locate(code);

        if (result.context && !result.context.isComplex()) {
          const reference = result.context.getReference();

          const children = provider.sct.getConceptChildren(reference);

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
        const result = await provider.locate(test.expression);

        if (test.expectedValid) {
          expect(result.context).toBeDefined();
          expect(result.context.isComplex()).toBe(true);
          expect(result.message).toBeNull();

          // Get display for complex expression
          const display = await provider.display(result.context);
          expect(display).toBeDefined();
          expect(display.length).toBeGreaterThan(0);
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
          operator: '=',
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
        const supports = await provider.doesFilter(test.property, test.operator, test.value);
        expect(supports).toBe(true);

        const filterContext = await provider.getPrepContext(true);
        await provider.filter(filterContext, true, test.property, test.operator, test.value);

        const filters = await provider.executeFilters(filterContext);
        const filter = filters[0];

        const size = await provider.filterSize(filterContext, filter);
        expect(size).toBeGreaterThan(0);

        // Test iteration
        let count = 0;
        const maxCheck = Math.min(5, size); // Check first 5 results

        while (await provider.filterMore(filterContext, filter) && count < maxCheck) {
          const concept = await provider.filterConcept(filterContext, filter);
          expect(concept.constructor.name).toBe('SnomedExpressionContext');
          expect(concept.getCode()).toBeDefined();
          count++;
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

      const missing = [];
      for (const test of searchTests) {
        const filterContext = await provider.getPrepContext(true);
        const searchResult = await provider.searchFilter(filterContext, new SearchFilterText(test.term), null);

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

        // Expected codes must be found if they exist in the dataset and are active
        // (text search excludes inactive concepts)
        for (const expectedCode of test.expectedCodes) {
          const codeExists = await provider.locate(expectedCode);
          if (codeExists.context && !(await provider.isInactive(codeExists.context)) && !foundCodes.includes(expectedCode)) {
            missing.push(`${test.term}: ${expectedCode}`);
          }
        }
      }
      expect(missing).toEqual([]);
    });
  });

  describe('Iterator Validation', () => {
    test('should iterate through root concepts', async () => {
      const iterator = await provider.iterator(null);

      expect(iterator).toBeDefined();
      expect(iterator.keys).toBeDefined();
      expect(iterator.total).toBeGreaterThan(0);

      // Test iterating through first few roots
      let count = 0;
      const maxIterations = Math.min(3, iterator.total);

      while (count < maxIterations) {
        const context = await provider.nextContext(iterator);
        if (!context) break;

        expect(context.constructor.name).toBe('SnomedExpressionContext');
        expect(context.getReference()).toBeDefined();

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

        // Iterate through first few children
        let count = 0;
        const maxIterations = Math.min(5, iterator.total);

        while (count < maxIterations) {
          const context = await provider.nextContext(iterator);
          if (!context) break;

          expect(context.constructor.name).toBe('SnomedExpressionContext');

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

// Inactive relationship rows are imported but ignored altogether (agreed with the SNOMED
// leads, Nov 2026). The test edition's TEST1000003 relationship file carries two inactive
// rows on 50325005 |Alcoholic fatty liver|: a finding site of 64033007 |Kidney structure|
// (group 1) and an is-a to 51292008 |Hepatorenal syndrome|. Neither may be visible.
describe('SNOMED CT inactive relationships are ignored', () => {
  const FATTY_LIVER = '50325005';
  const KIDNEY = '64033007';
  const HEPATORENAL = '51292008';
  const FINDING_SITE = '363698007';
  let factory;
  let provider;

  beforeAll(async () => {
    const cacheFilePath = globalCacheFilePath || findAvailableCacheFile();
    const opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    factory = new SnomedServicesFactory(opContext.i18n, cacheFilePath);
    provider = await factory.build(opContext, []);
  });

  afterAll(() => {
    if (provider) {
      provider.sct.close();
    }
  });

  const ref = (code) => {
    const r = provider.sct.concepts.findConcept(BigInt(code));
    expect(r.found).toBe(true);
    return r.index;
  };

  async function filterCodes(prop, op, value) {
    const fc = await provider.getPrepContext(true);
    await provider.filter(fc, true, prop, op, value);
    const [set] = await provider.executeFilters(fc);
    const codes = [];
    while (await provider.filterMore(fc, set)) {
      codes.push(await provider.code(await provider.filterConcept(fc, set)));
    }
    return codes;
  }

  async function filterHas(prop, op, value, code) {
    const fc = await provider.getPrepContext(false);
    await provider.filter(fc, false, prop, op, value);
    const [set] = await provider.executeFilters(fc);
    const located = await provider.filterLocate(fc, set, code);
    const { context } = await provider.locate(code);
    const checked = await provider.filterCheck(fc, set, context);
    return { located: located !== null && typeof located !== 'string', checked };
  }

  async function lookupProps(code, props) {
    const params = [];
    await provider.extendLookup(code, props, params);
    return params.filter(p => p.name === 'property').map(p => p.part.find(x => x.name === 'code').valueCode + '=' + p.part.find(x => x.name === 'value').valueCode);
  }

  test('the test edition carries the inactive rows (otherwise rebuild the cache from tx/data/snomed)', () => {
    const sct = provider.sct;
    // the raw outbound list: getConceptRelationships() leaves inactive rows out
    const outbounds = sct.concepts.getConcept(ref(FATTY_LIVER)).outbounds;
    const rels = sct.refs.getReferences(outbounds).map(i => sct.relationships.getRelationship(i));
    const inactive = rels.filter(r => !r.active).map(r => sct.getConceptId(r.relType) + '=' + sct.getConceptId(r.target)).sort();
    expect(inactive).toEqual([FINDING_SITE + '=' + KIDNEY, '116680003=' + HEPATORENAL].sort());
    expect(sct.getConceptRelationships(ref(FATTY_LIVER)).every(i => sct.relationships.isActive(i))).toBe(true);
  });

  test('a property filter does not match an inactive relationship (expand)', async () => {
    const codes = await filterCodes(FINDING_SITE, '=', KIDNEY);
    expect(codes).not.toContain(FATTY_LIVER);
    expect(codes).toHaveLength(9);
  });

  test('a property filter does not match an inactive relationship (validate)', async () => {
    expect(await filterHas(FINDING_SITE, '=', KIDNEY, FATTY_LIVER)).toEqual({ located: false, checked: false });
    expect(await filterHas(FINDING_SITE, '=', '10200004', FATTY_LIVER)).toEqual({ located: true, checked: true });
  });

  test('$lookup lists neither the inactive finding site nor the inactive parent', async () => {
    const props = await lookupProps(FATTY_LIVER, [FINDING_SITE, 'parent']);
    expect(props.sort()).toEqual([FINDING_SITE + '=10200004', 'parent=197321007', 'parent=41309000']);
  });

  test('$lookup does not list a child through an inactive is-a', async () => {
    const props = await lookupProps(HEPATORENAL, ['child']);
    expect(props).not.toContain('child=' + FATTY_LIVER);
    expect(props).toHaveLength(4);
  });

  test('is-a, ECL and subsumption ignore an inactive is-a', async () => {
    expect(await filterCodes('concept', 'is-a', HEPATORENAL)).not.toContain(FATTY_LIVER);
    expect(await filterCodes('constraint', '=', '<< ' + HEPATORENAL)).not.toContain(FATTY_LIVER);
    expect(await provider.subsumesTest(HEPATORENAL, FATTY_LIVER)).toBe('not-subsumed');
    expect((await provider.locateIsA(FATTY_LIVER, HEPATORENAL)).context).toBeFalsy();
  });

  test('an ECL refinement does not match an inactive relationship', async () => {
    const codes = await filterCodes('constraint', '=', '< 404684003 : ' + FINDING_SITE + ' = ' + KIDNEY);
    expect(codes).not.toContain(FATTY_LIVER);
    expect(codes).toHaveLength(9);
  });
});

// concept in A,B,C means any of the listed concepts (S3). Plain concepts were pushed into
// set.members as bare concept indexes while everything reading set.members expects member
// records ({ref}), so each came out as 4294967295 and $validate-code never matched.
// "code" is accepted as the same property as "concept": value sets in production use it.
describe.each(['concept', 'code'])('SNOMED CT %s in filter', (prop) => {
  let factory;
  let provider;

  beforeAll(async () => {
    const cacheFilePath = globalCacheFilePath || findAvailableCacheFile();
    const opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    factory = new SnomedServicesFactory(opContext.i18n, cacheFilePath);
    provider = await factory.build(opContext, []);
  });

  afterAll(() => {
    if (provider) {
      provider.sct.close();
    }
  });

  async function inCodes(value) {
    const fc = await provider.getPrepContext(true);
    expect(await provider.doesFilter(prop, 'in', value)).toBe(true);
    await provider.filter(fc, true, prop, 'in', value);
    const [set] = await provider.executeFilters(fc);
    const codes = [];
    while (await provider.filterMore(fc, set)) {
      codes.push(await provider.code(await provider.filterConcept(fc, set)));
    }
    return codes;
  }

  async function inHas(value, code) {
    const fc = await provider.getPrepContext(false);
    await provider.filter(fc, false, prop, 'in', value);
    const [set] = await provider.executeFilters(fc);
    const located = await provider.filterLocate(fc, set, code);
    const { context } = await provider.locate(code);
    return { located: located !== null && typeof located !== 'string', checked: await provider.filterCheck(fc, set, context) };
  }

  test('expands to every listed concept', async () => {
    expect(await inCodes('10200004,50325005,51292008')).toEqual(['10200004', '50325005', '51292008']);
  });

  test('ignores spaces, and lists a concept named twice once', async () => {
    expect(await inCodes('50325005, 51292008,50325005')).toEqual(['50325005', '51292008']);
  });

  test('a listed concept is in the set, an unlisted one is not', async () => {
    expect(await inHas('10200004,50325005,51292008', '51292008')).toEqual({ located: true, checked: true });
    expect(await inHas('10200004,50325005,51292008', '64033007')).toEqual({ located: false, checked: false });
  });

  test('a listed reference set stands for its members, alongside plain concepts', async () => {
    const refset = await inCodes('723264001'); // Lateralizable body structure reference set
    expect(refset.length).toBeGreaterThan(0);
    expect(refset).toContain('64033007');
    const mixed = await inCodes('723264001,51292008');
    expect(mixed).toEqual([...refset, '51292008']);
    expect(await inHas('723264001,51292008', '64033007')).toEqual({ located: true, checked: true });
  });
});

// "code" is the same filter property as "concept" for the other concept operations too
describe('SNOMED CT code filter property', () => {
  let factory;
  let provider;

  beforeAll(async () => {
    const cacheFilePath = globalCacheFilePath || findAvailableCacheFile();
    const opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    factory = new SnomedServicesFactory(opContext.i18n, cacheFilePath);
    provider = await factory.build(opContext, []);
  });

  afterAll(() => {
    if (provider) {
      provider.sct.close();
    }
  });

  async function codes(prop, op, value) {
    const fc = await provider.getPrepContext(true);
    await provider.filter(fc, true, prop, op, value);
    const [set] = await provider.executeFilters(fc);
    const out = [];
    while (await provider.filterMore(fc, set)) {
      out.push(await provider.code(await provider.filterConcept(fc, set)));
    }
    return out.sort();
  }

  test.each(['=', 'is-a', 'descendent-of', 'child-of', 'generalizes'])('code %s gives the same result as concept %s', async (op) => {
    expect(await provider.doesFilter('code', op, '51292008')).toBe(true);
    const viaCode = await codes('code', op, '51292008');
    expect(viaCode.length).toBeGreaterThan(0);
    expect(viaCode).toEqual(await codes('concept', op, '51292008'));
  });
});

// The R5 hierarchy filters descendent-leaf (S4) and is-not-a (S5); both used to fail with
// "Unsupported filter operation". 16763008 |Hemorrhage of liver| has 12 descendants, 8 of
// them leaves; 78171005 |Traumatic hemorrhage of liver| is one of them, with 3 descendants.
describe('SNOMED CT descendent-leaf and is-not-a filters', () => {
  let factory;
  let provider;

  beforeAll(async () => {
    const cacheFilePath = globalCacheFilePath || findAvailableCacheFile();
    const opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    factory = new SnomedServicesFactory(opContext.i18n, cacheFilePath);
    provider = await factory.build(opContext, []);
  });

  afterAll(() => {
    if (provider) {
      provider.sct.close();
    }
  });

  // the codes passing every filter: the first is iterated, the rest checked
  async function codes(...filters) {
    const fc = await provider.getPrepContext(true);
    for (const [op, value] of filters) {
      expect(await provider.doesFilter('concept', op, value)).toBe(true);
      await provider.filter(fc, true, 'concept', op, value);
    }
    const [first, ...rest] = await provider.executeFilters(fc);
    const out = [];
    while (await provider.filterMore(fc, first)) {
      const c = await provider.filterConcept(fc, first);
      let ok = true;
      for (const r of rest) {
        ok = ok && await provider.filterCheck(fc, r, c);
      }
      if (ok) {
        out.push(await provider.code(c));
      }
    }
    return out.sort();
  }

  async function located(op, value, code) {
    const fc = await provider.getPrepContext(false);
    await provider.filter(fc, false, 'concept', op, value);
    const [set] = await provider.executeFilters(fc);
    const r = await provider.filterLocate(fc, set, code);
    return r !== null && typeof r !== 'string';
  }

  test('descendent-leaf takes only the descendants with no children', async () => {
    expect(await codes(['descendent-leaf', '16763008'])).toEqual(['111371005', '197342009', '197364000', '206242003',
      '21580006', '262798009', '405559000', '735677007']);
    expect(await located('descendent-leaf', '16763008', '206242003')).toBe(true);
    expect(await located('descendent-leaf', '16763008', '78171005')).toBe(false); // has children
    expect(await located('descendent-leaf', '16763008', '16763008')).toBe(false); // the concept itself
  });

  test('descendent-leaf of a leaf is empty', async () => {
    expect(await codes(['descendent-leaf', '206242003'])).toEqual([]);
  });

  test('is-not-a takes out the concept and its descendants', async () => {
    expect(await codes(['is-a', '16763008'], ['is-not-a', '78171005'])).toEqual(['111371005', '16763008', '197342009',
      '197364000', '262796008', '262797004', '262798009', '405559000', '735677007']);
    expect(await located('is-not-a', '78171005', '78171005')).toBe(false);
    expect(await located('is-not-a', '78171005', '206242003')).toBe(false);
    expect(await located('is-not-a', '78171005', '16763008')).toBe(true);
  });

  test('is-not-a is the complement of is-a', async () => {
    const isA = await codes(['is-a', '78171005']);
    const notA = await codes(['is-not-a', '78171005']);
    expect(isA.length + notA.length).toBe(provider.sct.concepts.count());
    expect(notA.filter(c => isA.includes(c))).toEqual([]);
  });
});

// display regex (S6): a concept matches when it has an active description (FSN or synonym,
// not a text definition), in one language, whose whole term matches the pattern,
// case-sensitively. The language is the first one the request named that the edition has,
// else the edition's default. The test edition is English, plus Dutch descriptions for a few
// hematoma concepts in its TEST1000003 extension (with a Dutch language reference set). Iterating it scans the description table (yielding as it goes), and a cached value
// set's filter keeps the result, as for ECL.
describe('SNOMED CT display regex filter', () => {
  const HEMATOMA = ['206242003', '21580006', '262796008', '262797004', '262798009', '35566002', '405559000', '431674004'];
  let factory;
  let provider;
  let langDefs;

  beforeAll(async () => {
    const cacheFilePath = globalCacheFilePath || findAvailableCacheFile();
    langDefs = await TestUtilities.loadLanguageDefinitions();
    const opContext = new OperationContext('en', await TestUtilities.loadTranslations(langDefs));
    factory = new SnomedServicesFactory(opContext.i18n, cacheFilePath);
    provider = await factory.build(opContext, []);
  });

  afterAll(() => {
    if (provider) {
      provider.sct.close();
    }
  });

  const langs = (code) => code ? Languages.fromAcceptLanguage(code, langDefs, true) : null;

  async function regexCodes(pattern, { lang = null, fc = null, prop = 'display', op = 'regex' } = {}) {
    const prep = await provider.getPrepContext(true, langs(lang));
    await provider.filter(prep, true, prop, op, pattern, fc);
    const [set] = await provider.executeFilters(prep);
    const out = [];
    while (await provider.filterMore(prep, set)) {
      out.push(await provider.code(await provider.filterConcept(prep, set)));
    }
    return { codes: out.sort(), set };
  }

  async function regexHas(pattern, code) {
    const prep = await provider.getPrepContext(false, null);
    await provider.filter(prep, false, 'display', 'regex', pattern);
    const [set] = await provider.executeFilters(prep);
    const located = await provider.filterLocate(prep, set, code);
    const { context } = await provider.locate(code);
    return { located: located !== null && typeof located !== 'string', checked: await provider.filterCheck(prep, set, context) };
  }

  test('is supported, but not for a pattern that does not compile', async () => {
    expect(await provider.doesFilter('display', 'regex', '.*[Hh]ematoma.*')).toBe(true);
    expect(await provider.doesFilter('display', 'regex', '(unclosed')).toBe(false);
  });

  test('matches every concept with a matching active description', async () => {
    expect((await regexCodes('.*[Hh]ematoma.*')).codes).toEqual(HEMATOMA);
  });

  test('matches the whole term, case-sensitively', async () => {
    // only 35566002 has a description that ends in "Hematoma" with a capital H
    expect((await regexCodes('.*Hematoma')).codes).toEqual(['35566002']);
    expect((await regexCodes('Hematoma')).codes).toEqual(['35566002']);
    expect((await regexCodes('hematoma')).codes).toEqual([]);
    expect((await regexCodes('(?i)hematoma')).codes).toEqual(['35566002']);
  });

  test('matches synonyms, not only the preferred term', async () => {
    // "Haematoma" is a synonym of 35566002 (GB spelling); its preferred term is "Hematoma"
    const sct = provider.sct;
    const r = sct.concepts.findConcept(35566002n);
    expect(sct.getDisplayName(r.index)).toBe('Hematoma');
    expect((await regexCodes('Haematoma')).codes).toEqual(['35566002']);
  });

  test('ignores inactive descriptions', async () => {
    // 35566002 has the inactive synonyms "Hematoma, NOS" and "Haematoma, NOS"
    expect((await regexCodes('H(a)?ematoma, NOS')).codes).toEqual([]);
  });

  test('validates one concept by its own descriptions', async () => {
    expect(await regexHas('.*[Hh]ematoma.*', '262798009')).toEqual({ located: true, checked: true });
    expect(await regexHas('.*[Hh]ematoma.*', '16763008')).toEqual({ located: false, checked: false });
  });

  test('a language the edition does not have falls back to the default', async () => {
    expect((await regexCodes('.*[Hh]ematoma.*', { lang: 'de' })).codes).toEqual(HEMATOMA);
    expect((await regexCodes('.*[Hh]ematoma.*', { lang: 'en-US' })).codes).toEqual(HEMATOMA);
  });

  test('a language the edition has: only its descriptions are searched', async () => {
    const DUTCH = ['262796008', '262797004', '262798009', '35566002'];
    expect((await regexCodes('.*hematoom.*', { lang: 'nl' })).codes).toEqual(DUTCH);
    expect((await regexCodes('.*hematoom.*', { lang: 'nl-BE' })).codes).toEqual(DUTCH);
    expect((await regexCodes('.*[Hh]ematoma.*', { lang: 'nl' })).codes).toEqual([]);
    expect((await regexCodes('.*hematoom.*')).codes).toEqual([]); // English by default
    // an acceptable (not preferred) Dutch synonym counts too
    expect((await regexCodes('bloeduitstorting', { lang: 'nl' })).codes).toEqual(['35566002']);
    // the first requested language the edition has wins
    expect((await regexCodes('.*hematoom.*', { lang: 'de, nl;q=0.8, en;q=0.5' })).codes).toEqual(DUTCH);
    const ecl = await regexCodes('* {{ D term = wild:"*hematoom*", language = nl }}', { prop: 'constraint', op: '=' });
    expect(ecl.codes).toEqual(DUTCH);
  });

  test('a text definition is not a display', async () => {
    // 35566002 |Hematoma| has no definition in the test edition; use one that does
    const sct = provider.sct;
    const definitionKind = sct.concepts.findConcept(900000000000550004n).index;
    let defined = null;
    for (let i = 0; i < sct.concepts.count() && !defined; i++) {
      const ref = sct.concepts.getConceptByCount(i).index;
      const c = sct.concepts.getConcept(ref);
      for (const di of (c.descriptions ? sct.refs.getReferences(c.descriptions) : [])) {
        const d = sct.descriptions.getDescription(di);
        if (d.active && d.kind === definitionKind) {
          defined = { code: String(sct.getConceptId(ref)), term: sct.strings.getEntry(d.iDesc) };
          break;
        }
      }
    }
    expect(defined).not.toBeNull();
    const escaped = defined.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect((await regexCodes(escaped)).codes).not.toContain(defined.code);
  });

  test('a cached value set filter keeps the scan result', async () => {
    const fc = {};
    const first = await regexCodes('.*[Hh]ematoma.*', { fc });
    expect(first.codes).toEqual(HEMATOMA);
    const prep = await provider.getPrepContext(true, null);
    await provider.filter(prep, true, 'display', 'regex', '.*[Hh]ematoma.*', fc);
    const [set] = await provider.executeFilters(prep);
    expect(set.populationDone).toBe(true); // no scan needed
    expect((await regexCodes('.*[Hh]ematoma.*', { fc })).codes).toEqual(HEMATOMA);
  });

  test('gives the same concepts as the equivalent ECL description filter', async () => {
    const ecl = await regexCodes('* {{ D term = wild:"*hematoma*", language = en }}', { prop: 'constraint', op: '=' });
    expect(ecl.codes).toEqual(HEMATOMA);
  });
});

// Concrete values (S8). The test edition's International subset has integer-valued drug
// strengths and counts; its TEST1000003 extension adds three test data attributes with
// string, boolean and decimal values on 329238006, 776168003 and 1204474000.
describe('SNOMED CT concrete values', () => {
  const NICKNAME = '1000701000003104';
  const FISH = '1000711000003102';
  const POTENCY = '1000721000003107';
  let factory;
  let provider;

  beforeAll(async () => {
    const cacheFilePath = globalCacheFilePath || findAvailableCacheFile();
    const opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    factory = new SnomedServicesFactory(opContext.i18n, cacheFilePath);
    provider = await factory.build(opContext, []);
  });

  afterAll(() => {
    if (provider) {
      provider.sct.close();
    }
  });

  async function ecl(expression) {
    const fc = await provider.getPrepContext(true);
    await provider.filter(fc, true, 'constraint', '=', expression);
    const [set] = await provider.executeFilters(fc);
    const out = [];
    while (await provider.filterMore(fc, set)) {
      out.push(await provider.code(await provider.filterConcept(fc, set)));
    }
    return out.sort();
  }

  async function lookupValues(code, props) {
    const params = [];
    await provider.extendLookup(code, props, params);
    const out = {};
    for (const p of params.filter(p => p.name === 'property')) {
      const value = p.part.find(x => x.name === 'value');
      const key = Object.keys(value).find(k => k !== 'name');
      out[p.part.find(x => x.name === 'code').valueCode] = { [key]: value[key] };
    }
    return out;
  }

  test('$lookup returns concrete values, typed by the MRCM range or else by how they are written', async () => {
    expect(await lookupValues('329238006', ['1142135004', '1142136003', '1142139005', NICKNAME, FISH, POTENCY])).toEqual({
      '1142135004': { valueDecimal: 4000 },  // dec() in the MRCM, though written #4000
      '1142136003': { valueDecimal: 1 },
      '1142139005': { valueInteger: 1 },     // int() in the MRCM
      [NICKNAME]: { valueString: 'Sunshine in a capsule' },
      [FISH]: { valueBoolean: true },
      [POTENCY]: { valueDecimal: 2.5 }       // no MRCM rule: #2.5 is written as a decimal
    });
    expect(await lookupValues('1204474000', [FISH, POTENCY])).toEqual({ [FISH]: { valueBoolean: false }, [POTENCY]: { valueDecimal: 0.75 } });
  });

  test('$lookup only returns the concrete values asked for, when properties are named', async () => {
    expect(Object.keys(await lookupValues('329238006', [FISH]))).toEqual([FISH]);
  });

  test('ECL compares decimals by value, and decimal literals against integer values', async () => {
    expect(await ecl(`< 763158003 : ${POTENCY} >= #0.75`)).toEqual(['1204474000', '329238006']);
    expect(await ecl(`< 763158003 : ${POTENCY} = #2.50`)).toEqual(['329238006']);
    expect(await ecl(`< 763158003 : ${POTENCY} < #1.0`)).toEqual(['1204474000']);
    expect(await ecl('< 763158003 : 1142138002 > #599.5')).toEqual(['1204474000']);
  });

  test('ECL string concrete values: =, !=, a set, wild and match', async () => {
    expect(await ecl(`< 763158003 : ${NICKNAME} = "Barium milkshake"`)).toEqual(['1204474000']);
    expect(await ecl(`< 763158003 : ${NICKNAME} != "Barium milkshake"`)).toEqual(['329238006']);
    expect(await ecl(`< 763158003 : ${NICKNAME} = ("Barium milkshake" "Sunshine in a capsule")`)).toEqual(['1204474000', '329238006']);
    expect(await ecl(`< 763158003 : ${NICKNAME} = wild:"*capsule"`)).toEqual(['329238006']);
    expect(await ecl(`< 763158003 : ${NICKNAME} = match:"barium"`)).toEqual(['1204474000']);
  });

  test('ECL boolean concrete values', async () => {
    expect(await ecl(`< 763158003 : ${FISH} = true`)).toEqual(['329238006', '776168003']);
    expect(await ecl(`< 763158003 : ${FISH} = false`)).toEqual(['1204474000']);
    expect(await ecl(`< 763158003 : ${FISH} != true`)).toEqual(['1204474000']);
  });

  test('a value of the wrong type never matches', async () => {
    expect(await ecl('< 763158003 : 1142135004 = "4000"')).toEqual([]);
    expect(await ecl(`< 763158003 : ${FISH} = #1`)).toEqual([]);
    expect(await ecl(`< 763158003 : ${NICKNAME} = true`)).toEqual([]);
  });

  test('concrete values in the same group', async () => {
    expect(await ecl('< 763158003 : { 1142135004 = #4000, 1142136003 = #1 }')).toEqual(['329238006']);
    expect(await ecl('< 763158003 : { 1142135004 = #4000, 1142136003 = #2 }')).toEqual([]);
  });
});

// Map reference sets have members (S9). The importer used to skip any reference set file
// whose header mentioned "map" (every map refset: mapTarget, mapGroup, ...), so ECL ^ and
// ?fhir_vs=refset/ found nothing in them. The test edition's TEST1000003 extension has a
// simple map (1000891000003103, two members) and an extended map (1000901000003102: three
// active rows for two concepts, plus an inactive row for 405559000).
describe('SNOMED CT map reference sets', () => {
  const SIMPLE = '1000891000003103';
  const EXTENDED = '1000901000003102';
  let factory;
  let provider;

  beforeAll(async () => {
    const cacheFilePath = globalCacheFilePath || findAvailableCacheFile();
    const opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    factory = new SnomedServicesFactory(opContext.i18n, cacheFilePath);
    provider = await factory.build(opContext, []);
  });

  afterAll(() => {
    if (provider) {
      provider.sct.close();
    }
  });

  async function codes(prop, op, value) {
    const fc = await provider.getPrepContext(true);
    await provider.filter(fc, true, prop, op, value);
    const [set] = await provider.executeFilters(fc);
    const out = [];
    while (await provider.filterMore(fc, set)) {
      out.push(await provider.code(await provider.filterConcept(fc, set)));
    }
    return out.sort();
  }

  async function located(prop, op, value, code) {
    const fc = await provider.getPrepContext(false);
    await provider.filter(fc, false, prop, op, value);
    const [set] = await provider.executeFilters(fc);
    const r = await provider.filterLocate(fc, set, code);
    return r !== null && typeof r !== 'string';
  }

  test('a simple map reference set has its members', async () => {
    expect(await codes('constraint', '=', `^ ${SIMPLE}`)).toEqual(['16763008', '262796008']);
    expect(await codes('concept', 'in', SIMPLE)).toEqual(['16763008', '262796008']);
  });

  test('an extended map: each member concept once, inactive rows left out', async () => {
    expect(await codes('constraint', '=', `^ ${EXTENDED}`)).toEqual(['262797004', '262798009']);
    expect(await codes('concept', 'in', EXTENDED)).toEqual(['262797004', '262798009']);
    expect(await located('constraint', '=', `^ ${EXTENDED}`, '262797004')).toBe(true);
    expect(await located('constraint', '=', `^ ${EXTENDED}`, '405559000')).toBe(false); // inactive row
    expect(await located('concept', 'in', EXTENDED, '262798009')).toBe(true);
  });

  test('member filters can select on the map fields', async () => {
    expect(await codes('constraint', '=', `^ ${EXTENDED} {{ M mapTarget = "Y92.9" }}`)).toEqual(['262797004']);
    expect(await codes('constraint', '=', `^ ${SIMPLE} {{ M mapTarget = "K76.89" }}`)).toEqual(['16763008']);
  });
});

// Implicit value set urls (S10): the ecl/ form, and the edition and version forms, which
// used to compare against an undefined edition and so never matched.
describe('SNOMED CT implicit value set urls', () => {
  let factory;
  let provider;
  const HEMORRHAGE = ['111371005', '16763008', '197342009', '197364000', '206242003', '21580006', '262796008',
    '262797004', '262798009', '405559000', '431674004', '735677007', '78171005'];
  const VERSION = 'http://snomed.info/xsct/31000003106/version/20250909';

  beforeAll(async () => {
    const cacheFilePath = globalCacheFilePath || findAvailableCacheFile();
    const opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    factory = new SnomedServicesFactory(opContext.i18n, cacheFilePath);
    provider = await factory.build(opContext, []);
  });

  afterAll(() => {
    if (provider) {
      provider.sct.close();
    }
  });

  // the concepts the value set's (single) include selects
  async function members(vs) {
    const include = vs.compose.include[0];
    const fc = await provider.getPrepContext(true);
    for (const f of include.filter) {
      await provider.filter(fc, true, f.property, f.op, f.value);
    }
    const [set] = await provider.executeFilters(fc);
    const out = [];
    while (await provider.filterMore(fc, set)) {
      out.push(await provider.code(await provider.filterConcept(fc, set)));
    }
    return out.sort();
  }

  test('the three forms are told apart, for the sct and xsct bases', () => {
    expect(factory.implicitValueSetForm('http://snomed.info/sct?fhir_vs=isa/16763008').form).toBe('generic');
    expect(factory.implicitValueSetForm('http://snomed.info/sct/31000003106?fhir_vs=isa/16763008').form).toBe('edition');
    expect(factory.implicitValueSetForm('http://snomed.info/xsct/31000003106?fhir_vs').form).toBe('edition');
    expect(factory.implicitValueSetForm('http://snomed.info/sct/31000003106/version/20250909?fhir_vs').form).toBe('version');
    expect(factory.implicitValueSetForm(`${VERSION}?fhir_vs=refset/723264001`).form).toBe('version');
    expect(factory.implicitValueSetForm('http://snomed.info/sct/731000124108?fhir_vs')).toBeNull();
    expect(factory.implicitValueSetForm('http://snomed.info/sct/31000003106/version/20240101?fhir_vs')).toBeNull();
    expect(factory.implicitValueSetForm('http://snomed.info/sct?fhir_vsx')).toBeNull();
  });

  test('ecl/ takes a URL-encoded expression, or one already decoded', async () => {
    for (const url of ['http://snomed.info/sct?fhir_vs=ecl/%3C%3C%2016763008', 'http://snomed.info/sct?fhir_vs=ecl/<< 16763008']) {
      const vs = await factory.buildKnownValueSet(url, null);
      expect(vs.url).toBe(url);
      expect(vs.compose.include[0].filter).toEqual([{ property: 'constraint', op: '=', value: '<< 16763008' }]);
      expect(await members(vs)).toEqual(HEMORRHAGE);
    }
    expect(await factory.buildKnownValueSet('http://snomed.info/sct?fhir_vs=ecl/', null)).toBeNull();
  });

  test('the edition and version forms pin the include to this version; the generic form does not', async () => {
    const generic = await factory.buildKnownValueSet('http://snomed.info/sct?fhir_vs=isa/16763008', null);
    expect(generic.compose.include[0].version).toBeUndefined();
    for (const url of ['http://snomed.info/sct/31000003106?fhir_vs=isa/16763008', 'http://snomed.info/sct/31000003106/version/20250909?fhir_vs=isa/16763008']) {
      const vs = await factory.buildKnownValueSet(url, null);
      expect(vs.compose.include[0].version).toBe(VERSION);
      expect(await members(vs)).toEqual(HEMORRHAGE);
    }
    // an implicit value set's edition and version are in its url; it has no version of its own
    expect(generic.version).toBeUndefined();
  });
});

// $lookup property=* (S12): every property the SNOMED CT on FHIR page defines - including
// moduleId (as the page names it), sufficientlyDefined and semanticTag - except the normal
// forms, which are computed and have to be asked for by name.
describe('SNOMED CT $lookup properties', () => {
  let factory;
  let provider;

  beforeAll(async () => {
    const cacheFilePath = globalCacheFilePath || findAvailableCacheFile();
    const opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    factory = new SnomedServicesFactory(opContext.i18n, cacheFilePath);
    provider = await factory.build(opContext, []);
  });

  afterAll(() => {
    if (provider) {
      provider.sct.close();
    }
  });

  async function props(code, asked) {
    const params = [];
    const { context } = await provider.locate(code);
    await provider.extendLookup(context, asked, params);
    const out = {};
    for (const p of params.filter(p => p.name === 'property')) {
      const value = p.part.find(x => x.name === 'value');
      (out[p.part.find(x => x.name === 'code').valueCode] = out[p.part.find(x => x.name === 'code').valueCode] || [])
        .push(value[Object.keys(value).find(k => k !== 'name')]);
    }
    return out;
  }

  test('* adds sufficientlyDefined and semanticTag to the default properties, but not the normal forms', async () => {
    const all = await props('367430006', ['*']);
    const def = await props('367430006', null);
    expect(all.sufficientlyDefined).toEqual([true]);
    expect(all.semanticTag).toEqual(['procedure']);
    expect(all.normalForm).toBeUndefined();
    expect(all.normalFormTerse).toBeUndefined();
    const rest = { ...all };
    delete rest.sufficientlyDefined;
    delete rest.semanticTag;
    expect(rest).toEqual(def);
    expect(def.sufficientlyDefined).toBeUndefined();
  });

  test('the module is moduleId, and asking for "module" still works', async () => {
    expect((await props('367430006', null)).moduleId).toEqual(['900000000000207008']);
    expect(await props('367430006', ['module'])).toEqual({ moduleId: ['900000000000207008'] });
    expect((await props('367430006', null)).module).toBeUndefined();
  });

  test('sufficientlyDefined is false for a primitive concept', async () => {
    const sct = provider.sct;
    let primitive = null;
    for (let i = 0; i < sct.concepts.count() && !primitive; i++) {
      const ref = sct.concepts.getConceptByCount(i).index;
      if (sct.isActive(ref) && sct.isPrimitive(ref)) {
        primitive = String(sct.getConceptId(ref));
      }
    }
    expect((await props(primitive, ['sufficientlyDefined'])).sufficientlyDefined).toEqual([false]);
  });

  test('the normal forms, when asked for by name, for a concept and an expression', async () => {
    expect(await props('367430006', ['normalFormTerse'])).toEqual({
      normalFormTerse: ['387713003:{260686004=257903006,405813007=(118632007:{272741003=182353008})}']
    });
    expect((await props('367430006', ['normalForm'])).normalForm).toEqual([
      '387713003|Surgical procedure|:{260686004|Method|=257903006|Repair - action|,405813007|Procedure site - Direct|=(118632007|Structure of tendon within hand|:{272741003|Laterality|=182353008|Side|})}']);
    const expr = await props('367430006:{405813007=(85562004:272741003=24028007)}', ['normalFormTerse']);
    expect(expr.normalFormTerse).toEqual(['387713003:{260686004=257903006,405813007=(118632007:{272741003=182353008})},{405813007=(85562004:{272741003=24028007})}']);
  });

  // $expand reports properties from properties(), which is built from extendLookup
  test('properties() for $expand: only the named ones, none when none are named', async () => {
    const { context } = await provider.locate('367430006');
    expect(await provider.properties(context, [])).toEqual([]);
    const got = await provider.properties(context, ['moduleId', 'sufficientlyDefined', '260686004']);
    expect(got).toEqual([
      { code: 'moduleId', valueCode: '900000000000207008' },
      { code: 'sufficientlyDefined', valueBoolean: true },
      { code: '260686004', valueCode: '257903006' }
    ]);
    // the same values $lookup returns, without the lookup-only parts (description, code-display)
    const lookup = await props('367430006', ['moduleId', 'sufficientlyDefined', '260686004']);
    expect(got.map(p => p.code).sort()).toEqual(Object.keys(lookup).sort());
  });
});
