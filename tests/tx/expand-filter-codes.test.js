/**
 * A text filter matches codes as well as names: a code matches when it starts with the filter as
 * given - a straight left match, without regard to case, but not split into words, stemmed or
 * folded (tx/library/text-match.js). Both ways a code system's codes reach the filter: a value set
 * that includes the whole code system (the provider's searchFilter) and one that lists the codes
 * (the expander checks each listed code).
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

const SYSTEM = 'http://example.org/cs-codes';

const CS = {
  resourceType: 'CodeSystem', url: SYSTEM, version: '1', status: 'active', content: 'complete',
  concept: [
    { code: 'BP-01', display: 'Blood pressure' },
    { code: 'BP-02', display: 'Pulse' },
    { code: 'HR-01', display: 'Heart rate' },
    { code: 'fracture', display: 'Broken bone' }
  ]
};

const ALL = { resourceType: 'ValueSet', url: 'http://example.org/vs-all', version: '1', status: 'active',
  compose: { include: [{ system: SYSTEM }] } };
const LISTED = { resourceType: 'ValueSet', url: 'http://example.org/vs-listed', version: '1', status: 'active',
  compose: { include: [{ system: SYSTEM, concept: CS.concept.map(c => ({ code: c.code })) }] } };

let ld, i18n;

beforeAll(async () => {
  ld = await LanguageDefinitions.fromFiles(path.join(__dirname, '../../tx/data'));
  i18n = new I18nSupport(path.join(__dirname, '../../translations'), ld);
  await i18n.load();
});

async function expand(vs, text) {
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
  const res = await new ValueSetExpander(worker, params).expand(new ValueSet(vs), new SearchFilterText(text));
  const json = res.jsonObj || res;
  return (json.expansion.contains || []).map(c => c.code).sort();
}

describe.each([['the whole code system', ALL], ['a list of its codes', LISTED]])('text filter on codes: %s', (name, vs) => {
  test('a code that starts with the filter', async () => {
    expect(await expand(vs, 'BP-0')).toEqual(['BP-01', 'BP-02']);
    expect(await expand(vs, 'HR-01')).toEqual(['HR-01']);
  });

  test('without regard to case', async () => {
    expect(await expand(vs, 'bp-0')).toEqual(['BP-01', 'BP-02']);
    expect(await expand(vs, 'hR-01')).toEqual(['HR-01']);
  });

  test('a straight left match: not words, and not inside the code', async () => {
    expect(await expand(vs, 'bp 01')).toEqual([]);
    expect(await expand(vs, '01')).toEqual([]);
  });

  test('not stemmed: a code is not a word', async () => {
    expect(await expand(vs, 'fractures')).toEqual([]);
    expect(await expand(vs, 'fract')).toEqual(['fracture']);
  });

  test('names still match by their words', async () => {
    expect(await expand(vs, 'pressure')).toEqual(['BP-01']);
  });
});
