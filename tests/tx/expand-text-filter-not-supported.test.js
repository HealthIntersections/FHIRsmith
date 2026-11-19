/**
 * $expand with a text filter on a code system whose provider has no text search (currencies, for
 * one): the request asks for something this code system doesn't have. That is the client's
 * problem (422, not-supported), as it is for a property filter the provider doesn't have - it
 * was a plain Error, which is answered as HTTP 500.
 */

const path = require('path');
const { LanguageDefinitions } = require('../../library/languages');
const { I18nSupport } = require('../../library/i18nsupport');
const { OperationContext } = require('../../tx/operation-context');
const { Iso4217FactoryProvider } = require('../../tx/cs/cs-currency');
const { ValueSetExpander, ExpandWorker } = require('../../tx/workers/expand');
const { TxParameters } = require('../../tx/params');
const { SearchFilterText } = require('../../tx/library/designations');
const { Issue } = require('../../tx/library/operation-outcome');
const ValueSet = require('../../tx/library/valueset');

const SYSTEM = 'urn:iso:std:iso:4217';

const VS = { resourceType: 'ValueSet', url: 'http://example.org/vs', version: '1', status: 'active', compose: { include: [{ system: SYSTEM }] } };

let ld, i18n, fac;

beforeAll(async () => {
  ld = await LanguageDefinitions.fromFiles(path.join(__dirname, '../../tx/data'));
  i18n = new I18nSupport(path.join(__dirname, '../../translations'), ld);
  await i18n.load();
  fac = new Iso4217FactoryProvider(i18n);
  await fac.load();
});

async function expand(parameter) {
  const provider = {
    getCodeSystemProvider: async (oc, url) => url === SYSTEM ? fac.build(oc, []) : null,
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

describe('$expand with a text filter on a provider that has no text search', () => {
  test('the provider says not-supported with status 422', async () => {
    const cs = fac.build(new OperationContext('en-US', i18n), []);
    const error = await cs.searchFilter(await cs.getPrepContext(true), 'dollar', true).catch(e => e);
    expect(error).toBeInstanceOf(Issue);
    expect(error).toMatchObject({ level: 'error', cause: 'not-supported', statusCode: 422, message: 'Text Search is not supported' });
  });

  test('the expansion fails with that, not with a server error', async () => {
    const error = await expand([{ name: 'filter', valueString: 'dollar' }, { name: 'count', valueInteger: 2 }]).catch(e => e);
    expect(error).toBeInstanceOf(Issue);
    expect(error).toMatchObject({ cause: 'not-supported', statusCode: 422, message: 'Text Search is not supported' });
  });

  test('without a filter the code system expands', async () => {
    expect(await expand([{ name: 'count', valueInteger: 2 }])).toHaveLength(2);
  });
});
