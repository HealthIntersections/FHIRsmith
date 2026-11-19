/**
 * $expand with sort=prop:<name>: a code in the expansion only has a property array when one of
 * the properties asked for has a value for it. Sorting by a property must cope with codes that
 * have none - it failed with "cc.property is not iterable" (HTTP 500). Codes without the
 * property sort last.
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

const CS = {
  resourceType: 'CodeSystem', url: SYSTEM, version: '1', status: 'active', content: 'complete',
  property: [{ code: 'rank', type: 'string' }],
  concept: [
    { code: 'a', display: 'A', property: [{ code: 'rank', valueString: '3' }] },
    { code: 'b', display: 'B' },
    { code: 'c', display: 'C', property: [{ code: 'rank', valueString: '1' }] },
    { code: 'd', display: 'D', property: [{ code: 'rank', valueString: '2' }] }
  ]
};

const VS = { resourceType: 'ValueSet', url: 'http://example.org/vs', version: '1', status: 'active', compose: { include: [{ system: SYSTEM }] } };

let ld, i18n;

beforeAll(async () => {
  ld = await LanguageDefinitions.fromFiles(path.join(__dirname, '../../tx/data'));
  i18n = new I18nSupport(path.join(__dirname, '../../translations'), ld);
  await i18n.load();
});

async function expand(parameter) {
  const fac = new FhirCodeSystemFactory(i18n);
  const provider = {
    getCodeSystemProvider: async (oc, url) => url === SYSTEM ? fac.build(oc, [], new CodeSystem(CS)) : null,
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
  const params = new TxParameters(ld, i18n, false);
  params.readParams({ resourceType: 'Parameters', parameter });
  const res = await new ValueSetExpander(worker, params).expand(new ValueSet(VS), new SearchFilterText(params.filter));
  return (res.jsonObj || res).expansion.contains.map(c => c.code);
}

describe('$expand sort=prop:<name>', () => {
  test('the property was not asked for, so no code has a property array: the order is left alone', async () => {
    expect(await expand([{ name: 'sort', valueString: 'prop:rank' }])).toEqual(['a', 'b', 'c', 'd']);
    expect(await expand([{ name: 'sort', valueString: '-prop:rank' }])).toEqual(['a', 'b', 'c', 'd']);
  });

  test('one code has no value for the property: it sorts last', async () => {
    const property = { name: 'property', valueString: 'rank' };
    expect(await expand([property, { name: 'sort', valueString: 'prop:rank' }])).toEqual(['c', 'd', 'a', 'b']);
  });

  test('sorting by another property than the ones asked for leaves the order alone', async () => {
    const property = { name: 'property', valueString: 'rank' };
    expect(await expand([property, { name: 'sort', valueString: 'prop:other' }])).toEqual(['a', 'b', 'c', 'd']);
  });
});
