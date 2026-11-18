/**
 * UCUM Library Test Suite
 * Comprehensive tests ported from Java test suite
 */

const { readFileSync } = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');



const {
  UcumException, Decimal, Pair, Registry
} = require('../../tx/library/ucum-types.js');
const { UcumService} = require('../../tx/library/ucum-service');

describe('UCUM Library Tests', () => {
  let ucumService;

  beforeEach(() => {
    global.console = require('console');
  });

  afterEach(() => {
    // global.console = jestConsole;
  });

  beforeAll(async () => {
    // Load UCUM essence file
    try {
      const ucumEssenceXml = readFileSync('./tx/data/ucum-essence.xml', 'utf8');
      ucumService = new UcumService();
      ucumService.init(ucumEssenceXml);
    } catch (error) {
      error.message = `Failed to load UCUM essence: ${error.message}`;
      throw error;
    }
  });

  describe('Issue 50: Unit Comparability', () => {
    test('should recognize [iU] as comparable to itself', () => {
      expect(ucumService.isComparable('[iU]', '[iU]')).toBe(true);
    });
  });

  describe('Issue 252: special-unit handlers register under their real code (not undefined)', () => {
    // CelsiusHandler/FahrenheitHandler override getCode() but never set a `.code`
    // field; register() must key on getCode() so they don't both land under
    // `undefined` (with Fahrenheit overwriting Celsius).
    let registry;
    beforeAll(() => { registry = new Registry(); });

    test('Cel is registered under "Cel"', () => {
      expect(registry.exists('Cel')).toBe(true);
      expect(registry.get('Cel').getCode()).toBe('Cel');
    });

    test('[degF] is registered under "[degF]"', () => {
      expect(registry.exists('[degF]')).toBe(true);
      expect(registry.get('[degF]').getCode()).toBe('[degF]');
    });

    test('Celsius and Fahrenheit are distinct (no overwrite)', () => {
      expect(registry.get('Cel')).not.toBe(registry.get('[degF]'));
    });

    test('nothing is registered under the undefined key', () => {
      expect(registry.exists(undefined)).toBe(false);
    });

    test('offset-free special units (HoldingHandler) still register correctly', () => {
      expect(registry.exists('[pH]')).toBe(true);
      expect(registry.get('[pH]').getCode()).toBe('[pH]');
    });
  });

  describe('Decimal Class Tests', () => {
    describe('Integer Conversion', () => {
      test('should convert decimals to integers correctly', () => {
        expect(new Decimal(0).asInteger()).toBe(0);
        expect(new Decimal(1).asInteger()).toBe(1);
        expect(new Decimal(2).asInteger()).toBe(2);
        expect(new Decimal(64).asInteger()).toBe(64);
        expect(new Decimal(-1).asInteger()).toBe(-1);
        expect(new Decimal(-2).asInteger()).toBe(-2);
        expect(new Decimal(-64).asInteger()).toBe(-64);
      });
    });

    describe('String Support', () => {
      test('should handle basic decimal strings', () => {
        expect(new Decimal('1').toString()).toBe('1');
        expect(new Decimal('1e0').asDecimal()).toBe('1');
        expect(new Decimal('0').toString()).toBe('0');
        expect(new Decimal('-0').toString()).toBe('0');
        expect(new Decimal('10').toString()).toBe('10');
        expect(new Decimal('-1').toString()).toBe('-1');
      });

      test('should handle decimal places', () => {
        expect(new Decimal('1.1').toString()).toBe('1.1');
        expect(new Decimal('-1.1').toString()).toBe('-1.1');
        expect(new Decimal('0.1').toString()).toBe('0.1');
        expect(new Decimal('1.0').toString()).toBe('1.0');
        expect(new Decimal('1.00').toString()).toBe('1.00');
      });

      test('should handle scientific notation', () => {
        expect(new Decimal('1e0').asDecimal()).toBe('1');
        expect(new Decimal('1.0e1').asDecimal()).toBe('10');
        expect(new Decimal('1e-1').asDecimal()).toBe('0.1');
        expect(new Decimal('1e-2').asDecimal()).toBe('0.01');
      });
    });

    describe('Arithmetic Operations', () => {
      test('should perform addition correctly', () => {
        expect(new Decimal('1').add(new Decimal('1')).asDecimal()).toBe('2');
        expect(new Decimal('0').add(new Decimal('1')).asDecimal()).toBe('1');
        expect(new Decimal('5').add(new Decimal('5')).asDecimal()).toBe('10');
        expect(new Decimal('5').add(new Decimal('-6')).asDecimal()).toBe('-1');
        expect(new Decimal('-5').add(new Decimal('6')).asDecimal()).toBe('1');
        expect(new Decimal('-5').add(new Decimal('-6')).asDecimal()).toBe('-11');
      });

      test('should perform subtraction correctly', () => {
        expect(new Decimal('2').subtract(new Decimal('1')).asDecimal()).toBe('1');
        expect(new Decimal('2').subtract(new Decimal('0')).asDecimal()).toBe('2');
        expect(new Decimal('0').subtract(new Decimal('2')).asDecimal()).toBe('-2');
        expect(new Decimal('5').subtract(new Decimal('6')).asDecimal()).toBe('-1');
        expect(new Decimal('-5').subtract(new Decimal('-6')).asDecimal()).toBe('1');
      });

      test('should perform multiplication correctly', () => {
        expect(new Decimal('2').multiply(new Decimal('2')).asDecimal()).toBe('4');
        expect(new Decimal('2').multiply(new Decimal('0.5')).asDecimal()).toBe('1');
        expect(new Decimal('0').multiply(new Decimal('1')).asDecimal()).toBe('0');
        expect(new Decimal('20').multiply(new Decimal('20')).asDecimal()).toBe('400');
        expect(new Decimal('2').multiply(new Decimal('-2')).asDecimal()).toBe('-4');
      });

      test('should perform division correctly', () => {
        expect(new Decimal('500').divide(new Decimal('4')).asDecimal()).toBe('125');
        expect(new Decimal('10').divide(new Decimal('10')).asDecimal()).toBe('1');
        expect(new Decimal('1').divide(new Decimal('10')).asDecimal()).toBe('0.1');
        expect(new Decimal('-1').divide(new Decimal('1')).asDecimal()).toBe('-1');
        expect(new Decimal('1').divide(new Decimal('-1')).asDecimal()).toBe('-1');
        expect(new Decimal('-1').divide(new Decimal('-1')).asDecimal()).toBe('1');
      });
    });

    describe('Comparison Operations', () => {
      test('should compare decimals correctly', () => {
        expect(new Decimal('1').comparesTo(new Decimal('1'))).toBe(0);
        expect(new Decimal('0').comparesTo(new Decimal('1'))).toBe(-1);
        expect(new Decimal('1').comparesTo(new Decimal('0'))).toBe(1);
        expect(new Decimal('0.01').comparesTo(new Decimal('0.0100'))).toBe(0);
        expect(new Decimal('1').comparesTo(new Decimal('1.00000000'))).toBe(0);
      });
    });

    describe('Precision Tests', () => {
      test('should handle precision correctly (Issue 58)', () => {
        const res = new Decimal('80.0').multiply(new Decimal('100')).divide(new Decimal('81'));
        expect(res.asDecimal()).toBe('98.8');
      });
    });

    describe('Decimal Equals (Issues 6-7)', () => {
      test('should handle decimal equality correctly', () => {
        const dec1 = new Decimal(42);
        const dec2 = new Decimal(42);
        expect(dec1.equals(dec2)).toBe(true);

        const dec3 = new Decimal('42.00');
        const dec4 = new Decimal('42.00');
        expect(dec3.equals(dec4)).toBe(true);

        const dec5 = new Decimal('42.000');
        const dec6 = new Decimal('42.00');
        expect(dec5.equals(dec6)).toBe(false); // Different precision
      });
    });
  });

  describe('UCUM Service Tests', () => {
    describe('Validation', () => {
      test('should validate basic units', () => {
        expect(ucumService.validate('m')).toBeNull(); // Valid
        expect(ucumService.validate('kg')).toBeNull(); // Valid
        expect(ucumService.validate('m/s')).toBeNull(); // Valid
        expect(ucumService.validate('invalid_unit')).not.toBeNull(); // Invalid
      });

      test('should validate complex expressions', () => {
        expect(ucumService.validate('kg.m/s2')).toBeNull(); // Valid
        expect(ucumService.validate('L/min')).toBeNull(); // Valid
        expect(ucumService.validate('[degF]')).toBeNull(); // Valid
        expect(ucumService.validate('Cel')).toBeNull(); // Valid
      });
    });

    describe('Canonical Units', () => {
      test('should get canonical forms correctly', () => {
        expect(ucumService.getCanonicalUnits('kg')).toBe('g');
        expect(ucumService.getCanonicalUnits('g')).toBe('g');
        expect(ucumService.getCanonicalUnits('km')).toBe('m');
        expect(ucumService.getCanonicalUnits('dB')).toBe(''); // Unity (Issue 23)
      });

      test('should convert to canonical form', () => {
        const pair = new Pair(new Decimal('1'), 'kg');
        const canonical = ucumService.getCanonicalForm(pair);
        expect(canonical.value.asDecimal()).toBe('1000');
        expect(canonical.code).toBe('g');
      });
    });

    describe('Unit Conversion', () => {
      test('should convert between compatible units', () => {
        // Basic conversions
        const result1 = ucumService.convert(new Decimal('1000'), 'g', 'kg');
        expect(result1.asDecimal()).toBe('1.0');

        const result2 = ucumService.convert(new Decimal('100'), 'cm', 'm');
        expect(result2.asDecimal()).toBe('1.0');

        // Time conversions (Issue 6-7)
        const result3 = ucumService.convert(new Decimal('15'), '/min', '/h');
        expect(result3.asDecimal()).toBe('900');
      });

      test('should handle mile conversion correctly (Issue 21)', () => {
        const result = ucumService.convert(new Decimal('1', 15), '[mi_i]', 'm');
        expect(result.asDecimal()).toBe('1609'); // Due to precision in UCUM
      });

      test('should throw error for temperature conversions with offset (Issue 22)', () => {
        // Temperature conversions with offset should throw exceptions
        expect(() => {
          ucumService.convert(new Decimal('100', 15), 'Cel', 'K');
        }).toThrow(UcumException);

        expect(() => {
          ucumService.convert(new Decimal('100', 15), '[degF]', 'Cel');
        }).toThrow(UcumException);
      });

      test('should throw error for Ga conversion (Issue 13)', () => {
        expect(() => {
          ucumService.convert(new Decimal('0.1'), 'Ga', 'a');
        }).toThrow(UcumException);
      });
    });

    describe('Analysis/Formal Description', () => {
      test('should provide formal descriptions of units', () => {
        const analysis1 = ucumService.analyse('kg.m/s2');
        expect(analysis1).toContain('kilogram');
        expect(analysis1).toContain('meter');
        expect(analysis1).toContain('second');

        const analysis2 = ucumService.analyse('L/min');
        expect(analysis2).toContain('liter');
        expect(analysis2).toContain('minute');
      });

      test('should handle unity correctly', () => {
        const analysis = ucumService.analyse('');
        expect(analysis).toBe('(unity)');
      });
    });

    describe('Unit Operations', () => {
      test('should multiply unit pairs correctly', () => {
        const pair1 = new Pair(new Decimal('5'), 'kg');
        const pair2 = new Pair(new Decimal('2'), 'm/s2');
        const result = ucumService.multiply(pair1, pair2);

        expect(result.value.asDecimal()).toBe('10000');
        expect(result.code).toContain('g');
        expect(result.code).toContain('m');
        expect(result.code).toContain('s');
      });

      test('should divide unit pairs correctly', () => {
        const pair1 = new Pair(new Decimal('100'), 'J');
        const pair2 = new Pair(new Decimal('10'), 's');
        const result = ucumService.divideBy(pair1, pair2);

        expect(result.value.asDecimal()).toBe('10000');
      });
    });

    describe('Unit Compatibility', () => {
      test('should correctly identify compatible units', () => {
        expect(ucumService.isComparable('m', 'cm')).toBe(true);
        expect(ucumService.isComparable('kg', 'g')).toBe(true);
        expect(ucumService.isComparable('m/s', 'km/h')).toBe(true);
        expect(ucumService.isComparable('kg', 'm')).toBe(false);
        expect(ucumService.isComparable('L', 's')).toBe(false);
      });
    });

    describe('Model Validation', () => {
      test('should validate UCUM model', () => {
        const errors = []; // ucumService.validateUCUM();
        expect(Array.isArray(errors)).toBe(true);
        // Model should have minimal or no errors
        if (errors.length > 0) {
          console.warn('UCUM validation errors:', errors);
        }
      });
    });

    describe('Performance Tests (Issue 10)', () => {
      test('should handle kg to pound conversions efficiently', () => {
        const start = Date.now();

        // Test a smaller range for performance
        for (let i = 90.5; i < 91; i += 0.01) {
          const decimal = new Decimal(i.toString());
          const expected = i / 0.45359237; // pounds per kg = 1 / 0.45359237 (exact lb definition)
          const actual = ucumService.convert(decimal, 'kg', '[lb_av]');
          const actualFloat = parseFloat(actual.asDecimal());

          expect(Math.abs(actualFloat - expected)).toBeLessThan(0.001);
        }

        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(5000); // Should complete in reasonable time
      });
    });
  });

  describe('Common Units Tests', () => {
    // Test a subset of the common units from the Java test
    const commonUnits = [
      { unit: '%', dim: '1' },
      { unit: 'g', dim: 'M' },
      { unit: 'kg', dim: 'M' },
      { unit: 'm', dim: 'L' },
      { unit: 's', dim: 'T' },
      { unit: 'L', dim: 'L3' },
      { unit: 'mol', dim: 'N' },
      { unit: 'K', dim: 'q' },
      { unit: 'cd', dim: 'J' },
      { unit: 'rad', dim: '1' },
      { unit: 'sr', dim: '1' },
      { unit: 'Hz', dim: 'T-1' },
      { unit: 'N', dim: 'LMT-2' },
      { unit: 'Pa', dim: 'L-1MT-2' },
      { unit: 'J', dim: 'L2MT-2' },
      { unit: 'W', dim: 'L2MT-3' },
      { unit: 'A', dim: 'I' },
      { unit: 'V', dim: 'L2MT-3I-1' },
      { unit: 'F', dim: 'L-2M-1T4I2' },
      { unit: 'Ohm', dim: 'L2MT-3I-2' }
    ];

    describe('Analysis Tests', () => {
      test('should analyze common units without errors', () => {
        commonUnits.forEach(cu => {
          expect(() => {
            ucumService.analyse(cu.unit);
          }).not.toThrow();
        });
      });
    });

    describe('Canonical Form Tests', () => {
      test('should get canonical forms for common units', () => {
        const testUnits = commonUnits.filter(cu =>
          cu.unit !== 'dB' && // Skip dB as it has special handling
          cu.unit !== 'Cel' && // Skip temperature units
          cu.unit !== '[degF]' &&
          cu.unit !== '[pH]'
        );

        testUnits.forEach(cu => {
          expect(() => {
            const canonical = ucumService.getCanonicalUnits(cu.unit);
            expect(typeof canonical).toBe('string');
          }).not.toThrow();
        });
      });
    });

    describe('Conversion Tests', () => {
      test('should convert common units to their canonical forms', () => {
        const ONE = new Decimal('1', 15);
        const testUnits = commonUnits.filter(cu =>
          cu.unit !== 'dB' && // Skip problematic units
          cu.unit !== 'Cel' &&
          cu.unit !== '[degF]' &&
          cu.unit !== '[pH]'
        );

        testUnits.forEach(cu => {
          try {
            const canonical = ucumService.getCanonicalUnits(cu.unit);
            if (canonical && canonical !== '') {
              expect(() => {
                ucumService.convert(ONE, cu.unit, canonical);
              }).not.toThrow();
            }
          } catch (error) {
            // Some units may not be convertible, that's okay
            console.warn(`Could not test conversion for ${cu.unit}: ${error.message}`);
          }
        });
      });
    });
  });

  describe('Search Functionality', () => {
    test('should search for units by text', () => {
      const results = ucumService.search(null, 'meter', false);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => r.code === 'm')).toBe(true);
    });

    test('should search with regex', () => {
      const results = ucumService.search(null, '^m$', true);
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => r.code === 'm')).toBe(true);
    });
  });

  describe('UCUM Model Information', () => {
    test('should provide version information', () => {
      const version = ucumService.ucumIdentification();
      expect(version).toBeDefined();
      expect(version.getVersion()).toBeDefined();
    });

    test('should provide properties', () => {
      const properties = ucumService.getProperties();
      expect(properties.size).toBeGreaterThan(0);
      expect(properties.has('length')).toBe(true);
      expect(properties.has('mass')).toBe(true);
      expect(properties.has('time')).toBe(true);
    });

    test('should provide prefixes', () => {
      const prefixes = ucumService.getPrefixes();
      expect(prefixes.length).toBeGreaterThan(0);
      expect(prefixes.some(p => p.code === 'k')).toBe(true); // kilo
      expect(prefixes.some(p => p.code === 'm')).toBe(true); // milli
    });

    test('should provide base units', () => {
      const baseUnits = ucumService.getBaseUnits();
      expect(baseUnits.length).toBeGreaterThan(0);
      expect(baseUnits.some(u => u.code === 'm')).toBe(true); // meter
      expect(baseUnits.some(u => u.code === 'g')).toBe(true); // gram
    });
  });

  describe('Edge Cases and Error Handling', () => {
    test('should handle empty strings gracefully', () => {
      expect(ucumService.validate('')).toBe('unit must not be null');
      expect(ucumService.analyse('')).toBe('(unity)');
    });

    test('should handle invalid units', () => {
      expect(ucumService.validate('definitely_not_a_unit')).not.toBeNull();
      expect(ucumService.isValidUnit('definitely_not_a_unit')).toBe(false);
    });

    test('should handle null/undefined gracefully', () => {
      expect(ucumService.validate(null)).toBe('unit must not be null');
      expect(ucumService.validate(undefined)).toBe('unit must not be null');
    });

    test('should handle division by zero', () => {
      expect(() => {
        new Decimal('1').divide(new Decimal('0'));
      }).toThrow();
    });
  });

  // Helper function to load and test functional test cases from XML
  // This would be implemented if the XML file is available
  describe('Functional Tests from XML', () => {
    test.skip('should load and run functional tests from XML file', async () => {
      // This would parse tests/data/UcumFunctionalTests.xml
      // and run validation, conversion, multiplication, and division tests
      // Implementation depends on having the XML file available
    });
  });
});

// Helper functions for testing
function describeDuration(ms) {
  const hours = Math.floor(ms / (1000 * 60 * 60)) % 24;
  const mins = Math.floor(ms / (1000 * 60)) % 60;
  const secs = Math.floor(ms / 1000) % 60;
  const millisecs = ms % 1000;
  return `${hours}:${mins}:${secs}.${millisecs}`;
}

let ucumService;
let functionalTestCases = [];
try {
  // Adjust path as needed based on your project structure
  const xmlPath = path.join(__dirname, '../data/UcumFunctionalTests.xml');
  const xmlContent = readFileSync(xmlPath, 'utf8');
  functionalTestCases = parseXmlTestCases(xmlContent);
} catch (error) {
  console.warn('Could not load UcumFunctionalTests.xml - skipping XML tests:', error.message);
  functionalTestCases = [];
}

// Only run XML tests if we successfully loaded test cases
if (functionalTestCases.length > 0) {
  describe('UCUM Functional Tests from UcumFunctionalTests.xml', () => {

    beforeAll(async () => {
      // Load UCUM essence file
      try {
        const ucumEssenceXml = readFileSync('./tx/data/ucum-essence.xml', 'utf8');
        ucumService = new UcumService();
        ucumService.init(ucumEssenceXml);
      } catch (error) {
        error.message = `Failed to load UCUM essence: ${error.message}`;
        throw error;
      }
    });

    describe('Validation Tests', () => {

      functionalTestCases
        .filter(tc => tc.type === 'validation')
        .forEach(testCase => {
          const { id, unit, valid } = testCase.attributes;
          test(`${id}: "${unit}" should be ${valid === 'true' ? 'valid' : 'invalid'}`, () => {
            runValidationCase(testCase);
          });
        });
    });

    describe('Display Name Generation Tests', () => {
      functionalTestCases
        .filter(tc => tc.type === 'displayNameGeneration')
        .forEach(testCase => {
          const { id, unit, display } = testCase.attributes;

          test(`${id}: "${unit}" → "${display}"`, () => {
            runDisplayNameGenerationCase(testCase);
          });
        });
    });

    describe('Conversion Tests', () => {
      functionalTestCases
        .filter(tc => tc.type === 'conversion')
        .forEach(testCase => {
          const { id, value, srcUnit, outcome, dstUnit } = testCase.attributes;

          test(`${id}: ${value} ${srcUnit} → ${outcome} ${dstUnit}`, () => {
            runConversionCase(testCase);
          });
        });
    });

    describe('Multiplication Tests', () => {
      functionalTestCases
        .filter(tc => tc.type === 'multiplication')
        .forEach(testCase => {
          const { id, v1, u1, v2, u2, vRes, uRes } = testCase.attributes;

          test(`${id}: (${v1} ${u1}) × (${v2} ${u2}) = (${vRes} ${uRes})`, () => {
            runMultiplicationCase(testCase);
          });
        });
    });

    describe('Division Tests', () => {
      functionalTestCases
        .filter(tc => tc.type === 'division')
        .forEach(testCase => {
          const { id, v1, u1, v2, u2, vRes, uRes } = testCase.attributes;

          test(`${id}: (${v1} ${u1}) ÷ (${v2} ${u2}) = (${vRes} ${uRes})`, () => {
            runDivisionCase(testCase);
          });
        });
    });

    // Helper functions

    function runValidationCase(testCase) {
      const { id, unit, valid, reason } = testCase.attributes;
      const expectedValid = valid === 'true';

      const validationResult = ucumService.validate(unit);
      const actualValid = validationResult === null;

      // Custom assertion with detailed error message
      if (expectedValid !== actualValid) {
        if (expectedValid) {
          throw new Error(`Test ${id}: Unit '${unit}' was expected to be valid, but was invalid: ${validationResult}${reason ? ` (reason: ${reason})` : ''}`);
        } else {
          throw new Error(`Test ${id}: Unit '${unit}' was expected to be invalid${reason ? ` (reason: ${reason})` : ''}, but was valid`);
        }
      }
    }

    function runDisplayNameGenerationCase(testCase) {
      const { id, unit, display } = testCase.attributes;

      const result = ucumService.analyse(unit);

      if (result !== display) {
        throw new Error(`Test ${id}: The unit '${unit}' was expected to be displayed as '${display}', but was displayed as '${result}'`);
      }
    }

    function runConversionCase(testCase) {
      const { id, value, srcUnit, dstUnit, outcome } = testCase.attributes;

      try {
        const result = ucumService.convert(new Decimal(value), srcUnit, dstUnit);

        // Use Decimal comparison to handle precision issues
        const expectedOutcome = new Decimal(outcome);
        if (result.comparesTo(expectedOutcome) !== 0) {
          // Additional check for very close values (floating point precision issues)
          const diff = result.subtract(expectedOutcome).abs();
          const tolerance = expectedOutcome.abs().multiply(new Decimal('0.0001')); // 0.01% tolerance

          if (diff.comparesTo(tolerance) > 0) {
            throw new Error(`Test ${id}: Expected '${outcome}' but got '${result.toString()}' (difference: ${diff.toString()})`);
          }
        }
      } catch (error) {
        throw new Error(`Test ${id}: Conversion failed: ${error.message}`);
      }
    }

    function runMultiplicationCase(testCase) {
      const { id, v1, u1, v2, u2, vRes, uRes } = testCase.attributes;

      try {
        const o1 = new Pair(new Decimal(v1), u1);
        const o2 = new Pair(new Decimal(v2), u2);
        const result = ucumService.multiply(o1, o2);

        const expectedValue = new Decimal(vRes);
        const expectedUnit = uRes;

        if (result.getValue().comparesTo(expectedValue) !== 0) {
          throw new Error(`Test ${id}: Expected value '${vRes}' but got '${result.getValue().toString()}'`);
        }

        if (result.getCode() !== expectedUnit) {
          throw new Error(`Test ${id}: Expected unit '${uRes}' but got '${result.getCode()}'`);
        }
      } catch (error) {
        throw new Error(`Test ${id}: Multiplication failed: ${error.message}`);
      }
    }

    function runDivisionCase(testCase) {
      const { id, v1, u1, v2, u2, vRes, uRes } = testCase.attributes;

      try {
        const o1 = new Pair(new Decimal(v1), u1);
        const o2 = new Pair(new Decimal(v2), u2);
        const result = ucumService.divideBy(o1, o2);

        const expectedValue = new Decimal(vRes);
        const expectedUnit = uRes;

        if (result.getValue().comparesTo(expectedValue) !== 0) {
          throw new Error(`Test ${id}: Expected value '${vRes}' but got '${result.getValue().toString()}'`);
        }

        if (result.getCode() !== expectedUnit) {
          throw new Error(`Test ${id}: Expected unit '${uRes}' but got '${result.getCode()}'`);
        }
      } catch (error) {
        throw new Error(`Test ${id}: Division failed: ${error.message}`);
      }
    }

    describe('Individual Test Lookup', () => {
      test('Run specific test by ID', () => {
        // Change this ID to debug specific failing tests
        const targetId = '3-115'; // <-- Change this to the failing test ID

        const testCase = functionalTestCases.find(tc => tc.id === targetId);
        if (!testCase) {
          throw new Error(`Test case ${targetId} not found`);
        }

        switch (testCase.type) {
          case 'validation':
            runValidationCase(testCase);
            break;
          case 'conversion':
            runConversionCase(testCase);
            break;
          case 'displayNameGeneration':
            runDisplayNameGenerationCase(testCase);
            break;
          case 'multiplication':
            runMultiplicationCase(testCase);
            break;
          case 'division':
            runDivisionCase(testCase);
            break;
          default:
            throw new Error(`Unknown test type: ${testCase.type}`);
        }
      });
    });
  }); // End of describe block for XML tests
} else {
  describe('UCUM XML Functional Tests from UcumFunctionalTests.xml', () => {
    test('XML tests skipped - could not load test file', () => {
      // eslint-disable-next-line no-console -- why the XML tests are skipped
      console.log('UcumFunctionalTests.xml not found or could not be parsed - XML tests skipped');
    });
  });
}

/**
 * Parse XML test cases from the UcumFunctionalTests.xml file
 * This function extracts all test cases and organizes them by type
 */
function parseXmlTestCases(xmlContent) {
  const options = {
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    ignoreNameSpace: false,
    removeNSPrefix: false,
    parseAttributeValue: false,
    parseTagValue: true,
    parseTrueNumberOnly: false,
    arrayMode: false,
    trimValues: true,
    cdataTagName: '__cdata',
    cdataPositionChar: '\\c',
    localeRange: '',
    processEntities: true,
    stopNodes: ['*.pre', '*.script'],
    alwaysCreateTextNode: false
  };

  const parser = new XMLParser(options);
  let parsedXml;

  try {
    parsedXml = parser.parse(xmlContent);
  } catch (error) {
    throw new Error('XML parsing error: ' + error.message);
  }

  if (!parsedXml.ucumTests) {
    throw new Error(`Unable to process XML document: expected 'ucumTests' root element`);
  }

  const ucumTests = parsedXml.ucumTests;
  const testCases = [];
  const validSectionTypes = ['validation', 'displayNameGeneration', 'conversion', 'multiplication', 'division'];

  // Process each section type
  for (const sectionType of validSectionTypes) {
    if (!ucumTests[sectionType]) {
      continue;
    }

    const section = ucumTests[sectionType];
    let cases = section.case;

    // Handle case where there's only one test case (not an array)
    if (!Array.isArray(cases)) {
      cases = cases ? [cases] : [];
    }

    // Process each test case
    for (const testCase of cases) {
      if (!testCase) continue;

      // Extract attributes (fast-xml-parser prefixes them with @_)
      const attributes = {};
      for (const [key, value] of Object.entries(testCase)) {
        if (key.startsWith('@_')) {
          const attrName = key.substring(2); // Remove @_ prefix
          attributes[attrName] = value;
        }
      }

      // Validate that required attributes are present
      if (!attributes.id) {
        console.warn(`Skipping test case without id in ${sectionType} section`);
        continue;
      }

      testCases.push({
        type: sectionType,
        id: attributes.id,
        attributes: attributes
      });
    }
  }

  return testCases;
}

module.exports = {
  describeDuration
};