/**
 * The check applied to whatever a code system provider adds to a $lookup
 * response in extendLookup().
 */
const { checkAddedParameters } = require('../../tx/library/parameter-check');

const SOURCE = 'http://example.org/CodeSystem/test';

function check(params, fromIndex = 0) {
  return () => checkAddedParameters(params, fromIndex, SOURCE);
}

describe('lookup parameter checking', () => {

  describe('values a provider may add', () => {
    test.each([
      ['valueString', 'a string'],
      ['valueCode', 'active'],
      ['valueBoolean', true],
      ['valueBoolean', false],
      ['valueInteger', 42],
      ['valueInteger', 0],
      ['valueDecimal', 1.5],
      ['valueDateTime', '2026-08-26T10:00:00Z'],
      ['valueUri', 'http://example.org'],
      ['valueCanonical', 'http://example.org/vs|1.0.0']
    ])('accepts %s', (key, value) => {
      expect(check([{ name: 'property', part: [{ name: 'code', valueCode: 'x' }, { name: 'value', [key]: value }] }])).not.toThrow();
    });

    test('accepts valueCoding, the one complex type', () => {
      expect(check([{
        name: 'property',
        part: [
          { name: 'code', valueCode: 'parent' },
          { name: 'value', valueCoding: { system: 'http://snomed.info/sct', code: '73211009', display: 'Diabetes' } }
        ]
      }])).not.toThrow();
    });

    test('accepts the designation shape the worker itself builds', () => {
      expect(check([{
        name: 'designation',
        part: [
          { name: 'language', valueCode: 'en' },
          { name: 'use', valueCoding: { system: 'http://snomed.info/sct', code: '900000000000013009' } },
          { name: 'value', valueString: 'Diabetes mellitus' }
        ]
      }])).not.toThrow();
    });
  });

  describe('values it may not', () => {
    // this is the case that prompted the check: a remote API hands back
    // arbitrary JSON and it lands in a FHIR primitive
    test('rejects an object where a string belongs', () => {
      expect(check([{ name: 'property', part: [{ name: 'value', valueString: { nested: 'thing' } }] }]))
        .toThrow(/valueString must be a string, not a object/);
    });

    test('rejects an array where a string belongs', () => {
      expect(check([{ name: 'property', part: [{ name: 'value', valueString: ['a', 'b'] }] }]))
        .toThrow(/valueString must be a string, not an array/);
    });

    test('rejects null', () => {
      expect(check([{ name: 'property', part: [{ name: 'value', valueString: null }] }]))
        .toThrow(/valueString must be a string, not null/);
    });

    test('rejects a number where a string belongs', () => {
      expect(check([{ name: 'property', part: [{ name: 'value', valueCode: 7 }] }]))
        .toThrow(/valueCode must be a string/);
    });

    test('rejects a string where a number belongs', () => {
      expect(check([{ name: 'property', part: [{ name: 'value', valueInteger: '42' }] }]))
        .toThrow(/valueInteger must be an integer/);
    });

    test('rejects a non-integer for an integer', () => {
      expect(check([{ name: 'property', part: [{ name: 'value', valueInteger: 1.5 }] }]))
        .toThrow(/valueInteger must be an integer/);
    });

    test('rejects NaN and Infinity for a decimal', () => {
      expect(check([{ name: 'property', part: [{ name: 'value', valueDecimal: NaN }] }])).toThrow(/finite/);
      expect(check([{ name: 'property', part: [{ name: 'value', valueDecimal: Infinity }] }])).toThrow(/finite/);
    });

    test('rejects a structure inside a valueCoding', () => {
      expect(check([{ name: 'property', part: [{ name: 'value', valueCoding: { code: { deep: 1 } } }] }]))
        .toThrow(/valueCoding.code must be a primitive/);
    });

    test('rejects a valueCoding that is not an object', () => {
      expect(check([{ name: 'property', part: [{ name: 'value', valueCoding: 'sct' }] }]))
        .toThrow(/valueCoding must be an object/);
    });

    test('rejects a value type that has no place in a lookup', () => {
      expect(check([{ name: 'property', part: [{ name: 'value', valueMeta: { versionId: '1' } }] }]))
        .toThrow(/valueMeta is not a value type/);
    });

    test('rejects two values on one parameter', () => {
      expect(check([{ name: 'property', valueString: 'a', valueCode: 'b' }]))
        .toThrow(/may carry one value, not 2/);
    });

    test('rejects a parameter with no name', () => {
      expect(check([{ valueString: 'a' }])).toThrow(/must have a name/);
    });

    test('rejects a parameter that is not an object', () => {
      expect(check(['just a string'])).toThrow(/must be an object/);
    });

    test('rejects a part that is not an array', () => {
      expect(check([{ name: 'property', part: { name: 'code' } }])).toThrow(/part must be an array/);
    });
  });

  describe('scope', () => {
    test('only checks what the provider added', () => {
      const params = [
        // the worker's own parameters, already built and trusted
        { name: 'name', valueString: 'Test' },
        { name: 'suspicious', valueString: { not: 'checked' } }
      ];
      expect(check(params, 2)).not.toThrow();

      params.push({ name: 'property', part: [{ name: 'value', valueString: { bad: true } }] });
      expect(check(params, 2)).toThrow(/valueString must be a string/);
    });

    test('names the code system, so the log points at the culprit', () => {
      expect(check([{ name: 'property', valueString: 7 }]))
        .toThrow(new RegExp(SOURCE.replace(/[/.]/g, '\\$&')));
    });

    test('is happy with an empty list', () => {
      expect(check([], 0)).not.toThrow();
      expect(check([{ name: 'x', valueString: 'y' }], 1)).not.toThrow();
    });
  });
});
