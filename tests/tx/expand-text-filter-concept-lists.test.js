/**
 * $expand with a text filter on the code systems whose concepts are a list in memory - currencies,
 * countries, UN M49 area codes, US states. They had no text search (a text filter was an error);
 * they now match and rank as any other code system does (CodeSystemProvider._searchConceptList):
 * the words of the names in the search language, and the codes by a left match.
 */

const path = require('path');
const { LanguageDefinitions } = require('../../library/languages');
const { I18nSupport } = require('../../library/i18nsupport');
const { OperationContext } = require('../../tx/operation-context');
const { ValueSetExpander, ExpandWorker } = require('../../tx/workers/expand');
const { TxParameters } = require('../../tx/params');
const { SearchFilterText } = require('../../tx/library/designations');
const ValueSet = require('../../tx/library/valueset');
const { Iso4217FactoryProvider } = require('../../tx/cs/cs-currency');
const { CountryCodeFactoryProvider } = require('../../tx/cs/cs-country');
const { AreaCodeFactoryProvider } = require('../../tx/cs/cs-areacode');
const { USStateFactoryProvider } = require('../../tx/cs/cs-usstates');

const SYSTEMS = {
  currency: [Iso4217FactoryProvider, 'urn:iso:std:iso:4217'],
  country: [CountryCodeFactoryProvider, 'urn:iso:std:iso:3166'],
  areacode: [AreaCodeFactoryProvider, 'http://unstats.un.org/unsd/methods/m49/m49.htm'],
  usstates: [USStateFactoryProvider, 'https://www.usps.com/']
};

let ld, i18n;
const factories = {};

beforeAll(async () => {
  ld = await LanguageDefinitions.fromFiles(path.join(__dirname, '../../tx/data'));
  i18n = new I18nSupport(path.join(__dirname, '../../translations'), ld);
  await i18n.load();
  for (const [name, [Factory]] of Object.entries(SYSTEMS)) {
    factories[name] = new Factory(i18n);
    await factories[name].load();
  }
});

async function expand(name, parameter) {
  const [, system] = SYSTEMS[name];
  const fac = factories[name];
  const provider = {
    getCodeSystemProvider: async (oc, url) => url === system ? fac.build(oc, []) : null,
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
  const vs = { resourceType: 'ValueSet', url: 'http://example.org/vs', version: '1', status: 'active', compose: { include: [{ system }] } };
  const res = await new ValueSetExpander(worker, params).expand(new ValueSet(vs), new SearchFilterText(params.filter));
  return (res.jsonObj || res).expansion;
}

const filter = (text) => ({ name: 'filter', valueString: text });
const codes = (expansion) => (expansion.contains || []).map(c => c.code);

describe('$expand text filters on in-memory code systems', () => {
  test('currencies: the names', async () => {
    const found = codes(await expand('currency', [filter('dollar')]));
    expect(found).toEqual(expect.arrayContaining(['USD', 'AUD', 'CAD', 'NZD']));
    expect(found).not.toContain('EUR');
  });

  test('currencies: count=0 gives the number that match', async () => {
    const all = await expand('currency', [filter('dollar')]);
    const count = await expand('currency', [filter('dollar'), { name: 'count', valueInteger: 0 }]);
    expect(count.total).toBe(all.contains.length);
  });

  test('countries: English names, and the codes by a left match', async () => {
    expect(codes(await expand('country', [filter('new zealand')]))).toEqual(expect.arrayContaining(['NZ', 'NZL', '554']));
    expect(codes(await expand('country', [filter('AU')]))).toEqual(expect.arrayContaining(['AU', 'AUS', 'AUT']));
  });

  test('countries: the French names, for a French request only', async () => {
    const french = await expand('country', [filter('allemagne'), { name: 'displayLanguage', valueCode: 'fr' }]);
    expect(codes(french)).toEqual(expect.arrayContaining(['DE', 'DEU', '276']));
    expect(french.contains.find(c => c.code === 'DE').display).toMatch(/^Allemagne/);
    expect(codes(await expand('country', [filter('allemagne')]))).toEqual([]);
  });

  test('countries: the placeholder display of the user-assigned codes is not searched', async () => {
    expect(codes(await expand('country', [filter('user')]))).toEqual([]);
  });

  test('area codes', async () => {
    expect(codes(await expand('areacode', [filter('eastern')]))).toEqual(expect.arrayContaining(['014', '030', '151']));
  });

  test('US states (which had no filters at all)', async () => {
    expect(codes(await expand('usstates', [filter('carolina')])).sort()).toEqual(['NC', 'SC']);
    expect(codes(await expand('usstates', [filter('new')])).sort()).toEqual(['NH', 'NJ', 'NM', 'NY']);
  });

  test('without a filter, nothing changes', async () => {
    expect((await expand('usstates', [{ name: 'count', valueInteger: 3 }])).contains).toHaveLength(3);
    expect((await expand('currency', [{ name: 'count', valueInteger: 0 }])).total).toBe(factories.currency.codes.length);
  });
});
