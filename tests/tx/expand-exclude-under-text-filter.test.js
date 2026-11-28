/**
 * $expand with a text filter and a compose.exclude that lists codes: a listed code is left out
 * whatever the filter text. It was only left out when the code itself began with the filter
 * text, so a code the filter found by its display came back although the value set excludes it.
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

const SYSTEM = 'urn:iso:std:iso:4217';

let ld, i18n, factory;

beforeAll(async () => {
  ld = await LanguageDefinitions.fromFiles(path.join(__dirname, '../../tx/data'));
  i18n = new I18nSupport(path.join(__dirname, '../../translations'), ld);
  await i18n.load();
  factory = new Iso4217FactoryProvider(i18n);
  await factory.load();
});

async function expand(exclude, parameter) {
  const provider = {
    getCodeSystemProvider: async (oc, url) => url === SYSTEM ? factory.build(oc, []) : null,
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
  const compose = { include: [{ system: SYSTEM }] };
  if (exclude) compose.exclude = [{ system: SYSTEM, concept: exclude.map(code => ({ code })) }];
  const vs = { resourceType: 'ValueSet', url: 'http://example.org/vs', version: '1', status: 'active', compose };
  const res = await new ValueSetExpander(worker, params).expand(new ValueSet(vs), new SearchFilterText(params.filter));
  return ((res.jsonObj || res).expansion.contains || []).map(c => c.code);
}

const filter = (text) => [{ name: 'filter', valueString: text }];

describe('$expand: listed excludes under a text filter', () => {
  test('a code the filter finds by its display is left out', async () => {
    const all = await expand(null, filter('dollar'));
    expect(all).toContain('USD');
    const found = await expand(['USD'], filter('dollar'));
    expect(found).not.toContain('USD');
    expect(found).toEqual(all.filter(code => code !== 'USD'));
  });

  test('a code the filter finds by the code is left out', async () => {
    const all = await expand(null, filter('US'));
    expect(all).toContain('USD');
    const found = await expand(['USD'], filter('US'));
    expect(found).toEqual(all.filter(code => code !== 'USD'));
  });

  test('without a filter the listed code is left out as before', async () => {
    expect(await expand(['USD'], [])).not.toContain('USD');
  });
});
