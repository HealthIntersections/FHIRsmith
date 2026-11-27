//
// The status of a concept in a CodeSystem resource - isInactive, isDeprecated, getStatus - and
// the filters on the built-in properties (status, inactive, deprecated, notSelectable) that use
// them. The same rules as core's CodeSystemUtilities / KnownProperties: keep the two in step
//

const { CodeSystem } = require('../../tx/library/codesystem');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');
const { FilterExecutionContext } = require('../../tx/cs/cs-api');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');

const SS = 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status';
const CP = 'http://hl7.org/fhir/concept-properties#';

function codeSystem(property, concepts) {
  return {
    resourceType: 'CodeSystem',
    url: 'http://example.org/fhir/CodeSystem/status-test',
    version: '0.1.0',
    status: 'active',
    content: 'complete',
    property,
    concept: concepts
  };
}

const CONCEPTS = [
  { code: 'plain' },
  { code: 'active', property: [{ code: 'status', valueCode: 'active' }] },
  // the order of the properties makes no difference
  { code: 'active-then-inactive', property: [{ code: 'status', valueCode: 'active' }, { code: 'inactive', valueBoolean: true }] },
  { code: 'not-inactive-but-retired', property: [{ code: 'inactive', valueBoolean: false }, { code: 'status', valueCode: 'retired' }] },
  { code: 'retired', property: [{ code: 'status', valueCode: 'retired' }] },
  { code: 'past-deprecation', property: [{ code: 'deprecationDate', valueDateTime: '2001-01-01' }] },
  { code: 'future-deprecation', property: [{ code: 'deprecationDate', valueDateTime: '2999-01-01' }, { code: 'status', valueCode: 'deprecated' }] },
  { code: 'deprecated-flag', property: [{ code: 'deprecated', valueBoolean: true }] },
  { code: 'ss-deprecated', extension: [{ url: SS, valueCode: 'deprecated' }] },
  { code: 'ss-withdrawn', extension: [{ url: SS, valueCode: 'withdrawn' }] },
  { code: 'ss-trial-use', extension: [{ url: SS, valueCode: 'trial-use' }] },
  { code: 'ss-no-value', extension: [{ url: SS }] },
  { code: 'inactive-and-deprecated', property: [{ code: 'deprecationDate', valueDateTime: '2001-01-01' }, { code: 'inactive', valueBoolean: true }] }
];

describe('concept status in a CodeSystem resource', () => {
  let opContext;

  beforeEach(async () => {
    opContext = new OperationContext('en-US',
      await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
  });

  const providerFor = (json) => new FhirCodeSystemProvider(opContext, new CodeSystem(json), []);

  async function codes(provider, fn) {
    const result = [];
    for (const c of CONCEPTS) {
      if (await provider[fn](c.code)) {
        result.push(c.code);
      }
    }
    return result.sort();
  }

  async function filterCodes(provider, prop, op, value) {
    const set = await provider.filter(new FilterExecutionContext(), true, prop, op, value);
    return set.concepts.map(c => c.concept.code).sort();
  }

  test('isInactive', async () => {
    const provider = providerFor(codeSystem(undefined, CONCEPTS));
    expect(await codes(provider, 'isInactive')).toEqual(
      ['active-then-inactive', 'inactive-and-deprecated', 'not-inactive-but-retired', 'retired', 'ss-withdrawn'].sort());
  });

  test('isDeprecated: status, a passed deprecationDate, the legacy flag, standards-status - not retired', async () => {
    const provider = providerFor(codeSystem(undefined, CONCEPTS));
    expect(await codes(provider, 'isDeprecated')).toEqual(
      ['deprecated-flag', 'future-deprecation', 'inactive-and-deprecated', 'past-deprecation', 'ss-deprecated'].sort());
  });

  test('getStatus', async () => {
    const provider = providerFor(codeSystem(undefined, CONCEPTS));
    const status = {};
    for (const c of CONCEPTS) {
      status[c.code] = await provider.getStatus(c.code);
    }
    expect(status).toEqual({
      'plain': null,
      'active': 'active',
      'active-then-inactive': 'active',
      'not-inactive-but-retired': 'retired',
      'retired': 'retired',
      'past-deprecation': 'deprecated',
      'future-deprecation': 'deprecated',
      'deprecated-flag': 'deprecated',
      'ss-deprecated': 'deprecated',
      'ss-withdrawn': 'withdrawn',
      'ss-trial-use': 'trial-use',
      'ss-no-value': null,
      'inactive-and-deprecated': 'inactive'
    });
  });

  test('the deprecated and status filters agree', async () => {
    const provider = providerFor(codeSystem(undefined, CONCEPTS));
    expect(await filterCodes(provider, 'deprecated', '=', 'true')).toEqual(await codes(provider, 'isDeprecated'));
    expect(await filterCodes(provider, 'inactive', '=', 'true')).toEqual(await codes(provider, 'isInactive'));
    expect(await filterCodes(provider, 'status', '=', 'deprecated')).toEqual(
      ['deprecated-flag', 'future-deprecation', 'past-deprecation', 'ss-deprecated'].sort());
  });

  test('regex on the built-in properties', async () => {
    const provider = providerFor(codeSystem(undefined, CONCEPTS));
    expect(await filterCodes(provider, 'status', 'regex', 'ret.*')).toEqual(['not-inactive-but-retired', 'retired']);
    expect(await filterCodes(provider, 'status', 'regex', 'trial')).toEqual([]); // the whole value has to match
  });

  test('in / not-in with no value', async () => {
    const provider = providerFor(codeSystem(undefined, CONCEPTS));
    expect(await filterCodes(provider, 'status', 'in', undefined)).toEqual([]);
    expect((await filterCodes(provider, 'status', 'not-in', undefined)).length).toBe(CONCEPTS.length);
  });

  test('the status property under a code of the code system\'s own, declared with the standard uri', async () => {
    const provider = providerFor(codeSystem([{ code: 'conceptStatus', uri: CP + 'status', type: 'code' }], [
      { code: 'a', property: [{ code: 'conceptStatus', valueCode: 'retired' }] },
      { code: 'b' }
    ]));
    expect(await provider.getStatus('a')).toBe('retired');
    expect(await provider.isInactive('a')).toBe(true);
    expect(await filterCodes(provider, 'status', '=', 'retired')).toEqual(['a']);
  });

  test('status declared as a property of the code system\'s own is not the standard one', async () => {
    const provider = providerFor(codeSystem([{ code: 'status', uri: 'http://example.org/my-status', type: 'code' }], [
      { code: 'a', property: [{ code: 'status', valueCode: 'retired' }] }
    ]));
    expect(await provider.getStatus('a')).toBeNull();
    expect(await provider.isInactive('a')).toBe(false);
    // a filter on status is a filter on the code system's own property
    expect(await filterCodes(provider, 'status', '=', 'retired')).toEqual(['a']);
  });
});
