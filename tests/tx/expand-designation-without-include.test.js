/**
 * $expand with a designation parameter and no includeDesignations: the request names the
 * designations it wants, so they are listed. They were only listed with includeDesignations=true,
 * so designation= alone gave none. An explicit includeDesignations=false still lists none.
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

const SYSTEM = 'urn:test:cs';

const CS = {
  resourceType: 'CodeSystem', url: SYSTEM, version: '1', status: 'active', content: 'complete',
  concept: [{
    code: 'a', display: 'Alpha',
    designation: [{ language: 'de', value: 'Ah' }, { language: 'fr', value: 'Ahh' }]
  }]
};

const VS = { resourceType: 'ValueSet', url: 'urn:test:vs', version: '1', status: 'active',
  compose: { include: [{ system: SYSTEM }] } };

let ld, i18n;

beforeAll(async () => {
  ld = await LanguageDefinitions.fromFiles(path.join(__dirname, '../../tx/data'));
  i18n = new I18nSupport(path.join(__dirname, '../../translations'), ld);
  await i18n.load();
});

async function designations(parameter) {
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
  const res = await new ValueSetExpander(worker, params).expand(new ValueSet(VS), new SearchFilterText(''));
  const contains = (res.jsonObj || res).expansion.contains;
  expect(contains.map(c => c.code)).toEqual(['a']);
  return (contains[0].designation || []).map(d => [d.language, d.value]);
}

const designationDe = { name: 'designation', valueString: 'urn:ietf:bcp:47|de' };

describe('$expand: designation without includeDesignations', () => {
  test('designation alone lists the designations it names', async () => {
    expect(await designations([designationDe])).toEqual([['de', 'Ah']]);
  });

  test('designation with includeDesignations=true gives the same', async () => {
    expect(await designations([designationDe, { name: 'includeDesignations', valueBoolean: true }]))
      .toEqual([['de', 'Ah']]);
  });

  test('an explicit includeDesignations=false still lists none', async () => {
    expect(await designations([designationDe, { name: 'includeDesignations', valueBoolean: false }]))
      .toEqual([]);
  });

  test('neither parameter lists none, as before', async () => {
    expect(await designations([])).toEqual([]);
  });
});
