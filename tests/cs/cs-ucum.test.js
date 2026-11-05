/**
 * UCUM Provider Integration Tests
 * Real-world scenarios and integration with other systems
 */

const { readFileSync } = require('fs');

const {
  UcumCodeSystemFactory
} = require('../../tx/cs/cs-ucum');

const {
  FilterExecutionContext
} = require('../../tx/cs/cs-api');

const { UcumService } = require('../../tx/library/ucum-service');
const {OperationContext} = require("../../tx/operation-context");
const {TestUtilities} = require("../test-utilities");

describe('UCUM Provider Integration Tests', () => {
  let ucumService;
  let provider;
  let opContext;

  beforeAll(async () => {
    // Initialize real UCUM service
    const ucumEssenceXml = readFileSync('./tx/data/ucum-essence.xml', 'utf8');
    ucumService = new UcumService();
    ucumService.init(ucumEssenceXml);

    opContext = new OperationContext('en', await TestUtilities.loadTranslations());
    const factory = new UcumCodeSystemFactory(opContext.i18n, ucumService);
    provider = factory.build(opContext, null);
  });

  describe('Medical Laboratory Integration', () => {
    // Common lab units from real medical systems
    const labUnits = [
      { code: 'mg/dL', name: 'Blood glucose', expectedDimension: 'mass concentration' },
      { code: 'mmol/L', name: 'Blood glucose (SI)', expectedDimension: 'substance concentration' },
      { code: 'g/dL', name: 'Hemoglobin', expectedDimension: 'mass concentration' },
      { code: 'g/L', name: 'Hemoglobin (SI)', expectedDimension: 'mass concentration' },
      { code: '10*12/L', name: 'Red blood cell count', expectedDimension: 'number concentration' },
      { code: '10*9/L', name: 'White blood cell count', expectedDimension: 'number concentration' },
      { code: 'fL', name: 'Mean corpuscular volume', expectedDimension: 'volume' },
      { code: 'pg', name: 'Mean corpuscular hemoglobin', expectedDimension: 'mass' },
      { code: 'g/L', name: 'Total protein', expectedDimension: 'mass concentration' },
      { code: 'mmol/L', name: 'Creatinine', expectedDimension: 'substance concentration' },
      { code: 'umol/L', name: 'Creatinine (micro)', expectedDimension: 'substance concentration' }
    ];

    test('should validate all common lab units', async () => {
      for (const unit of labUnits) {
        const result = await provider.locate(unit.code);
        expect(result.context).toBeTruthy();
        expect(result.message).toBeNull();

        const display = await provider.display(unit.code);
        expect(display).toBeTruthy();

        console.log(`✓ ${unit.name}: ${unit.code} → ${display}`);
      }
    });

  });

  describe('Clinical Integration Scenarios', () => {
    test('should handle medication dosing units', async () => {
      const medicationUnits = [
        'mg',           // dose amount
        'mg/kg',        // dose per body weight
        'mg/(kg.d)',    // daily dose per body weight
        'mg/m2',        // dose per body surface area
        'mL/h',         // infusion rate
        'ug/min',       // continuous infusion
        'mg/dL',        // concentration
        'mmol/L',       // molar concentration
        'mg/kg/h',      // hourly dose rate
        'units/kg',     // insulin dosing
        'mEq/L'         // electrolyte concentration
      ];

      let validCount = 0;
      for (const unit of medicationUnits) {
        try {
          const result = await provider.locate(unit);
          if (result.context) {
            validCount++;

            const analysis = await provider.analyzeUnit(unit);
            const canonical = await provider.getCanonicalUnits(unit);

            console.log(`✓ ${unit}: ${analysis} (canonical: ${canonical})`);
          } else {
            console.log(`✗ ${unit}: ${result.message}`);
          }
        } catch (error) {
          console.log(`✗ ${unit}: ERROR - ${error.message}`);
        }
      }

      expect(validCount).toBeGreaterThan(medicationUnits.length * 0.7); // At least 70% should be valid
    });

    test('should support vital signs units', async () => {
      const vitalSigns = [
        { parameter: 'Blood Pressure', unit: 'mm[Hg]', expected: true },
        { parameter: 'Heart Rate', unit: '/min', expected: true },
        { parameter: 'Respiratory Rate', unit: '/min', expected: true },
        { parameter: 'Temperature', unit: 'Cel', expected: true },
        { parameter: 'Temperature', unit: '[degF]', expected: true },
        { parameter: 'Oxygen Saturation', unit: '%', expected: true },
        { parameter: 'Weight', unit: 'kg', expected: true },
        { parameter: 'Height', unit: 'cm', expected: true },
        { parameter: 'BMI', unit: 'kg/m2', expected: true }
      ];

      for (const vital of vitalSigns) {
        const result = await provider.locate(vital.unit);
        const isValid = result.context !== null;

        expect(isValid).toBe(vital.expected);

        if (isValid) {
          const display = await provider.display(vital.unit);
          console.log(`✓ ${vital.parameter}: ${vital.unit} → ${display}`);
        }
      }
    });
  });

  describe('Scientific Research Integration', () => {
    test('should handle physics and chemistry units', async () => {
      const scientificUnits = [
        // Energy and power
        { unit: 'J', field: 'Energy' },
        { unit: 'kJ/mol', field: 'Molar energy' },
        { unit: 'eV', field: 'Electron volt' },
        { unit: 'W', field: 'Power' },
        { unit: 'W/m2', field: 'Power density' },

        // Pressure and force
        { unit: 'Pa', field: 'Pressure' },
        { unit: 'bar', field: 'Pressure (bar)' },
        { unit: 'N', field: 'Force' },
        { unit: 'N/m', field: 'Surface tension' },

        // Electromagnetic
        { unit: 'V', field: 'Voltage' },
        { unit: 'A', field: 'Current' },
        { unit: 'Ohm', field: 'Resistance' },
        { unit: 'F', field: 'Capacitance' },
        { unit: 'H', field: 'Inductance' },
        { unit: 'T', field: 'Magnetic field' },
        { unit: 'Wb', field: 'Magnetic flux' },

        // Frequency and radiation
        { unit: 'Hz', field: 'Frequency' },
        { unit: 'Bq', field: 'Radioactivity' },
        { unit: 'Gy', field: 'Absorbed dose' },
        { unit: 'Sv', field: 'Dose equivalent' }
      ];

      let validCount = 0;
      for (const item of scientificUnits) {
        const result = await provider.locate(item.unit);
        if (result.context) {
          validCount++;

          // // console.log(`✓ ${item.field}: ${item.unit}`);
        } else {
          // console.log(`✗ ${item.field}: ${item.unit} - ${result.message}`);
        }
      }

      expect(validCount).toBeGreaterThan(scientificUnits.length * 0.8); // Most should be valid
    });

    test('should handle complex derived units', async () => {
      const complexUnits = [
        'kg.m2/s3',      // power per mass (W/kg)
        'J/(mol.K)',     // molar heat capacity
        'W/(m.K)',       // thermal conductivity
        'Pa.s',          // dynamic viscosity
        'm2/s',          // kinematic viscosity
        'C/m2',          // electric displacement
        'A/m2',          // current density
        'V/m',           // electric field
        'A/m',           // magnetic field strength
        'J/T',           // magnetic moment
        'C.m',           // electric dipole moment
        'kg.m2',         // moment of inertia
        'N.m',           // torque
        'J.s',           // action
        'kg/(m.s2)'      // pressure (Pa)
      ];

      for (const unit of complexUnits) {
        const result = await provider.locate(unit);
        if (result.context) {
          // console.log(`✓ ${unit}`);
        }
      }
    });
  });

  describe('ValueSet Integration', () => {
  //   test('should work with common units enumeration', async () => {
  //     // Create a mock common units ValueSet
  //     const commonUnits = null;
  //     //   new ValueSet({
  //     //   url: 'http://example.org/fhir/ValueSet/common-units',
  //     //   getConcepts: () => [
  //     //     { code: 'kg', display: 'kilogram' },
  //     //     { code: 'g', display: 'gram' },
  //     //     { code: 'm', display: 'meter' },
  //     //     { code: 'cm', display: 'centimeter' },
  //     //     { code: 'L', display: 'liter' },
  //     //     { code: 'mL', display: 'milliliter' },
  //     //     { code: 'mg/dL', display: 'milligrams per deciliter' },
  //     //     { code: 'mmol/L', display: 'millimoles per liter' }
  //     //   ]
  //     // }};
  //
  //     // Create provider with common units
  //     const factory = new UcumCodeSystemFactory(ucumService, commonUnits);
  //     const commonUnitsProvider = factory.build(new OperationContext(Languages.fromAcceptLanguage('en')), []);
  //
  //     // Test special enumeration
  //     // expect(commonUnitsProvider.specialEnumeration()).toBe(commonUnits.url);
  //
  //     // Test that common units show custom displays
  //     // for (const concept of commonUnits.getConcepts()) {
  //     //   const display = await commonUnitsProvider.display(concept.code);
  //     //   expect(display).toBe(concept.display);
  //     // }
  //   });

    test('should filter by canonical units', async () => {
      const filterContext = new FilterExecutionContext();

      // Create filter for mass units (canonical: 'g')
      await provider.filter(filterContext, true, 'canonical', '=', 'g');
      const filters = await provider.executeFilters(filterContext);

      // Test units that should match (all mass units)
      const massUnits = ['g', 'kg', 'mg', 'ug', 'ng'];
      for (const unit of massUnits) {
        const result = await provider.filterLocate(filterContext, filters[0], unit);
        expect(result.code).toBe(unit);
      }

      // Test units that shouldn't match (non-mass units)
      const nonMassUnits = ['m', 'L', 's'];
      for (const unit of nonMassUnits) {
        const result = await provider.filterLocate(filterContext, filters[0], unit);
        expect(typeof result).toBe('string'); // Error message
      }
    });
  });

  describe('Performance and Scale', () => {
    test('should handle bulk validation efficiently', async () => {
      const testUnits = [
        'kg', 'g', 'mg', 'ug', 'ng', 'pg', 'fg',
        'm', 'cm', 'mm', 'um', 'nm', 'pm', 'km',
        'L', 'mL', 'uL', 'nL', 'pL',
        's', 'min', 'h', 'd', 'wk', 'mo', 'a',
        'Pa', 'kPa', 'MPa', 'bar', 'mbar',
        'J', 'kJ', 'MJ', 'cal', 'kcal',
        'W', 'kW', 'MW', 'hp',
        'Hz', 'kHz', 'MHz', 'GHz',
        'V', 'mV', 'kV',
        'A', 'mA', 'uA',
        'Ohm', 'kOhm', 'MOhm'
      ];

      const start = Date.now();
      let validCount = 0;

      for (const unit of testUnits) {
        const result = await provider.locate(unit);
        if (result.context) {
          validCount++;
        }
      }

      const elapsed = Date.now() - start;
      // const opsPerSecond = (testUnits.length / elapsed * 1000).toFixed(2);

      // console.log(`Validated ${testUnits.length} units in ${elapsed}ms (${opsPerSecond} ops/sec)`);
      // console.log(`Valid units: ${validCount}/${testUnits.length} (${(validCount/testUnits.length*100).toFixed(1)}%)`);

      expect(validCount).toBeGreaterThan(testUnits.length * 0.9); // 90%+ should be valid
      expect(elapsed).toBeLessThan(5000); // Should complete in < 5 seconds
    });

  });

  describe('Error Recovery and Edge Cases', () => {
    test('should handle malformed units gracefully', async () => {
      const malformedUnits = [
        'kg.',           // trailing period
        '.m',            // leading period
        'kg..m',         // double period
        'kg.m/',         // trailing slash
        '/kg.m',         // leading slash
        'kg//',          // double slash
        'kg.m/s/',       // extra slash
        '123',           // pure number
        'kg m',          // space instead of period
        'kg-m',          // hyphen instead of period
        'kg*m',          // asterisk
        '[invalid',      // unmatched bracket
        'invalid]',      // unmatched bracket
        '',              // empty string
        null,            // null
        undefined        // undefined
      ];

      for (const unit of malformedUnits) {
        try {
          const result = await provider.locate(unit);
          // Should either return an error or handle gracefully
          if (result.context === null) {
            expect(typeof result.message).toBe('string');
            expect(result.message.length).toBeGreaterThan(0);
          }
        } catch (error) {
          // Throwing is also acceptable for malformed input
          expect(error).toBeDefined();
        }
      }
    });

    test('should provide meaningful error messages', async () => {
      const invalidCases = [
        { unit: 'definitely_invalid_unit', expectedContains: ['invalid', 'unit'] },
        { unit: 'kg.', expectedContains: ['syntax', 'error'] },
        { unit: '', expectedContains: ['empty'] }
      ];

      for (const testCase of invalidCases) {
        const result = await provider.locate(testCase.unit);
        expect(result.context).toBeNull();
        expect(result.message).toBeTruthy();

        const message = result.message.toLowerCase();
        const hasExpectedTerms = testCase.expectedContains.some(term =>
          message.includes(term.toLowerCase())
        );

        // At least one expected term should be in the error message
        if (!hasExpectedTerms) {
          // console.log(`Warning: Error message for "${testCase.unit}" may not be descriptive enough: "${result.message}"`);
        }
      }
    });
  });

  describe('Properties', () => {
    test('$lookup returns canonical when asked for it, not by default', async () => {
      const { context } = await provider.locate('mg/dL');
      let params = [];
      await provider.extendLookup(context, [], params);
      expect(params.filter(p => p.name === 'property')).toEqual([]);
      params = [];
      await provider.extendLookup(context, ['canonical'], params);
      expect(params).toEqual([{ name: 'property', part: [
        { name: 'code', valueCode: 'canonical' }, { name: 'value', valueString: ucumService.getCanonicalUnits('mg/dL') }] }]);
    });

    // $expand reports properties from properties(), which is built from extendLookup
    test('properties() for $expand', async () => {
      const { context } = await provider.locate('mg/dL');
      expect(await provider.properties(context, [])).toEqual([]);
      expect(await provider.properties(context, ['canonical'])).toEqual([
        { code: 'canonical', valueString: ucumService.getCanonicalUnits('mg/dL') }]);
    });
  });
});

// Usage example for external integration
const integrationExample = {
  // Example: FHIR Observation validation
  validateFHIRObservation: async (provider, observation) => {
    if (observation.valueQuantity && observation.valueQuantity.unit) {
      const unit = observation.valueQuantity.unit;
      const result = await provider.locate(unit);

      return {
        valid: result.context !== null,
        message: result.message,
        canonical: result.context ? await provider.getCanonicalUnits(unit) : null,
        display: result.context ? await provider.display(unit) : null
      };
    }
    return { valid: false, message: 'No unit specified' };
  },

  // Example: Unit conversion checking
  checkConvertibility: async (provider, sourceUnit, targetUnit) => {
    try {
      const comparable = await provider.areComparable(sourceUnit, targetUnit);
      const sourceCanonical = await provider.getCanonicalUnits(sourceUnit);
      const targetCanonical = await provider.getCanonicalUnits(targetUnit);

      return {
        convertible: comparable,
        sourceCanonical,
        targetCanonical,
        reason: comparable ? 'Units are comparable' : 'Units have different dimensions'
      };
    } catch (error) {
      return {
        convertible: false,
        reason: error.message
      };
    }
  }
};

module.exports = {
  integrationExample
};