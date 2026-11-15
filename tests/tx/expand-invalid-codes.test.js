/**
 * A value set whose include lists a code that isn't in the code system: by default the code is
 * left out, and the expansion says so with an expansion-issue (a contained OperationOutcome with
 * a warning); with modules.tx.errorsForInvalidCodes, the value set can't be expanded (422).
 * The same for an include filter that selects by concept (is-a etc.) on a code that isn't there.
 * The tx-ecosystem tests simple-expand-enum-invalid and simple-expand-isa-invalid accept either;
 * this covers both here.
 */

const path = require('path');
const { LanguageDefinitions } = require('../../library/languages');
const { I18nSupport } = require('../../library/i18nsupport');
const { OperationContext } = require('../../tx/operation-context');
const { FhirCodeSystemFactory } = require('../../tx/cs/cs-cs');
const { CodeSystem } = require('../../tx/library/codesystem');
const { ValueSetExpander, ExpandWorker } = require('../../tx/workers/expand');
const { TxParameters } = require('../../tx/params');
const { SearchFilterText } = require('../../tx/library/designations');
const ValueSet = require('../../tx/library/valueset');

const SYSTEM = 'http://example.org/cs';

function codeSystem(content = 'complete') {
  return {
    resourceType: 'CodeSystem', url: SYSTEM, version: '1', status: 'active', content,
    concept: [{ code: 'a', display: 'A' }, { code: 'b', display: 'B' }]
  };
}

function valueSet(codes) {
  return {
    resourceType: 'ValueSet', url: 'http://example.org/vs', version: '1', status: 'active',
    compose: { include: [{ system: SYSTEM, concept: codes.map(code => ({ code })) }] }
  };
}

let ld, i18n;

beforeAll(async () => {
  ld = await LanguageDefinitions.fromFiles(path.join(__dirname, '../../tx/data'));
  i18n = new I18nSupport(path.join(__dirname, '../../translations'), ld);
  await i18n.load();
});

async function expand(vs, errorsForInvalidCodes, content = 'complete') {
  const fac = new FhirCodeSystemFactory(i18n);
  const csJson = codeSystem(content);
  const provider = {
    getCodeSystemProvider: async (oc, url) => url === SYSTEM ? fac.build(oc, [], new CodeSystem(csJson)) : null,
    createCodeSystemProvider: async (oc, cs, s) => fac.build(oc, s, new CodeSystem(cs.jsonObj || cs)),
    findValueSet: async () => null,
    loadSupplements: () => [],
    listVersions: () => [],
    listCodeSystemVersions: async () => [],
    getFhirVersion: () => '5.0.0'
  };
  const log = { info() {}, debug() {}, warn() {}, error() {} };
  const worker = new ExpandWorker(new OperationContext('en-US', i18n), log, provider, ld, i18n);
  worker.additionalResources = [];
  worker.errorsForInvalidCodes = errorsForInvalidCodes;
  const params = new TxParameters(ld, i18n, false);
  const res = await new ValueSetExpander(worker, params).expand(new ValueSet(vs), new SearchFilterText(params.filter));
  return res.jsonObj || res;
}

describe('$expand: a listed code that is not in the code system', () => {
  test('by default, it is left out, with an expansion-issue warning', async () => {
    const vs = await expand(valueSet(['a', 'xxxx']), false);
    expect(vs.expansion.contains.map(c => c.code)).toEqual(['a']);
    expect(vs.expansion.extension).toEqual([{
      url: 'http://hl7.org/fhir/StructureDefinition/expansion-issue', valueReference: { reference: '#oo1' }
    }]);
    expect(vs.contained).toHaveLength(1);
    const oo = vs.contained[0];
    expect(oo.id).toBe('oo1');
    expect(oo.issue).toHaveLength(1);
    expect(oo.issue[0].severity).toBe('warning');
    expect(oo.issue[0].code).toBe('code-invalid');
    expect(oo.issue[0].details.coding[0].code).toBe('invalid-code');
    expect(oo.issue[0].details.text).toContain("'xxxx'");
    expect(oo.issue[0].extension[0].valueString).toBe('VALUESET_EXPANSION_INCLUDE_UNKNOWN_CODE');
  });

  test('several invalid codes are reported in one OperationOutcome, once each', async () => {
    const vs = await expand(valueSet(['xxxx', 'a', 'yyyy', 'xxxx']), false);
    expect(vs.expansion.contains.map(c => c.code)).toEqual(['a']);
    expect(vs.contained).toHaveLength(1);
    expect(vs.contained[0].issue.map(i => i.details.text.match(/'(\w+)'/)[1])).toEqual(['xxxx', 'yyyy']);
  });

  test('with errorsForInvalidCodes, the value set cannot be expanded (422)', async () => {
    await expect(expand(valueSet(['a', 'xxxx']), true)).rejects.toMatchObject({
      statusCode: 422, level: 'error', cause: 'code-invalid', msgId: 'VALUESET_EXPANSION_INCLUDE_UNKNOWN_CODE_ERROR'
    });
  });

  test('with errorsForInvalidCodes, a code missing from a fragment is still only a warning', async () => {
    const vs = await expand(valueSet(['a', 'xxxx']), true, 'fragment');
    expect(vs.expansion.contains.map(c => c.code)).toEqual(['a']);
    expect(vs.contained[0].issue[0].severity).toBe('warning');
  });

  test('an is-a filter on an unknown code: the include adds nothing, with an expansion-issue warning', async () => {
    const vs = valueSet(['a']);
    vs.compose.include.push({ system: SYSTEM, filter: [{ property: 'concept', op: 'is-a', value: 'xxxx' }] });
    const res = await expand(vs, false);
    expect(res.expansion.contains.map(c => c.code)).toEqual(['a']);
    expect(res.expansion.extension[0].valueReference.reference).toBe('#oo1');
    const issue = res.contained[0].issue[0];
    expect(issue.severity).toBe('warning');
    expect(issue.extension[0].valueString).toBe('VALUESET_EXPANSION_FILTER_UNKNOWN_CODE');
    expect(issue.details.text).toContain("'concept is-a xxxx'");
  });

  test('an is-a filter on an unknown code, with errorsForInvalidCodes: 422', async () => {
    const vs = valueSet(['a']);
    vs.compose.include.push({ system: SYSTEM, filter: [{ property: 'concept', op: 'is-a', value: 'xxxx' }] });
    await expect(expand(vs, true)).rejects.toMatchObject({
      statusCode: 422, msgId: 'VALUESET_EXPANSION_FILTER_UNKNOWN_CODE_ERROR'
    });
  });

  test('an is-a filter on a known code is not reported', async () => {
    const vs = valueSet(['a']);
    vs.compose.include.push({ system: SYSTEM, filter: [{ property: 'concept', op: 'is-a', value: 'b' }] });
    for (const flag of [false, true]) {
      const res = await expand(vs, flag);
      expect(res.expansion.contains.map(c => c.code)).toEqual(['a', 'b']);
      expect(res.contained).toBeUndefined();
    }
  });

  test('a value set with only valid codes gets no expansion-issue either way', async () => {
    for (const flag of [false, true]) {
      const vs = await expand(valueSet(['a', 'b']), flag);
      expect(vs.contained).toBeUndefined();
      expect(vs.expansion.extension).toBeUndefined();
    }
  });
});
