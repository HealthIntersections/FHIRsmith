// A code system held on another server in the ecosystem (tx/cs/cs-virtual.js), talked to through
// the ecosystem resolver (tx/ecosystem-resolver.js)

const nock = require('nock');
const { EcosystemResolver } = require('../../tx/ecosystem-resolver');
const { VirtualCodeSystemProvider } = require('../../tx/cs/cs-virtual');
const { OperationContext } = require('../../tx/operation-context');
const { Designations, DesignationUse } = require('../../tx/library/designations');
const { TestUtilities } = require('../test-utilities');
const { ValidateWorker } = require('../../tx/workers/validate');
const { TxParameters } = require('../../tx/params');
const { Provider } = require('../../tx/provider');

const REG = 'https://reg.example';
const SERVER = 'https://other.example/fhir';
const SCT = 'http://snomed.info/sct';
const EDITION = 'http://snomed.info/sct/11000279109';

describe('VirtualCodeSystemProvider', () => {
  let opContext;
  let languages;
  let i18n;
  beforeAll(async () => {
    nock.disableNetConnect();
    languages = await TestUtilities.loadLanguageDefinitions();
    i18n = await TestUtilities.loadTranslations(languages);
    opContext = new OperationContext('en', i18n);
  });
  afterEach(() => nock.cleanAll());
  afterAll(() => nock.enableNetConnect());

  function provider() {
    const resolver = new EcosystemResolver({ use: true, registry: `${REG}/tx-reg` });
    nock(REG).get('/tx-reg').query(true).reply(200, { results: [] });
    return new VirtualCodeSystemProvider(opContext, null, SERVER, SCT, EDITION, resolver);
  }

  // asking for properties gets only those: without designation, the synonyms never come back,
  // and a display that is a synonym is wrongly rejected
  test('a concept\'s designations are asked for, and any but the fully specified name is a valid display', async () => {
    const p = provider();
    nock('https://other.example').get('/fhir/CodeSystem/$lookup')
      .query(q => q.code === '22298006' && [].concat(q.property).includes('designation'))
      .reply(200, { resourceType: 'Parameters', parameter: [
        { name: 'display', valueString: 'Myocardial infarction' },
        { name: 'designation', part: [{ name: 'language', valueCode: 'en' },
          { name: 'use', valueCoding: { system: SCT, code: '900000000000003001', display: 'Fully specified name' } },
          { name: 'value', valueString: 'Myocardial infarction (disorder)' }] },
        { name: 'designation', part: [{ name: 'language', valueCode: 'en' },
          { name: 'use', valueCoding: { system: SCT, code: '900000000000013009', display: 'Synonym' } },
          { name: 'value', valueString: 'Heart attack' }] },
        { name: 'property', part: [{ name: 'code', valueCode: 'inactive' }, { name: 'value', valueBoolean: false }] }
      ] });
    const loc = await p.locate('22298006');
    expect(loc.context.display).toBe('Myocardial infarction');
    const displays = new Designations(languages);
    await p.designations(loc.context, displays);
    const valid = displays.designations.filter(d => d.use && d.use.code === DesignationUse.DISPLAY.code).map(d => d.value);
    expect(valid).toEqual(expect.arrayContaining(['Myocardial infarction', 'Heart attack']));
    expect(valid).not.toContain('Myocardial infarction (disorder)');
    expect(nock.isDone()).toBe(true);
    // what isn't marked a display when it's added isn't one (this is asked for when a display is
    // wrong, to list the valid ones)
    expect(p.isDisplay(displays.designations.find(d => d.value === 'Myocardial infarction (disorder)'))).toBe(false);
  });

  function lookup(code, display) {
    return nock('https://other.example').get('/fhir/CodeSystem/$lookup').query(q => q.code === code)
      .reply(200, { resourceType: 'Parameters', parameter: [
        { name: 'display', valueString: display },
        { name: 'designation', part: [{ name: 'language', valueCode: 'en' },
          { name: 'use', valueCoding: { system: SCT, code: '900000000000013009', display: 'Synonym' } },
          { name: 'value', valueString: display }] },
        { name: 'property', part: [{ name: 'code', valueCode: 'inactive' }, { name: 'value', valueBoolean: false }] }
      ] });
  }

  // CodeSystem/$validate-code (no value set): the code system's implicit value set is made from
  // what the provider says about the code system, including valueSet(), which isn't known here
  test('a code is validated against the code system, with no value set', async () => {
    const p = provider();
    lookup('46635009', 'Type 1 diabetes mellitus');
    // the code system isn't held here: the provider finds it in the ecosystem
    const txProvider = { loadSupplements: () => [], getCodeSystemProvider: async () => p, getCodeSystem: () => null };
    const worker = new ValidateWorker(opContext, { debug() {}, info() {}, warn() {}, error() {} }, txProvider, languages, i18n);
    const params = new TxParameters(languages, i18n);
    const result = await worker.doValidationCS({ coding: [{ system: SCT, code: '46635009' }] }, p, params, { issuePath: 'Coding', mode: 'coding' });
    expect(result.resourceType).toBe('Parameters');
    expect(result.parameter.find(x => x.name === 'result').valueBoolean).toBe(true);
    expect(result.parameter.find(x => x.name === 'display').valueString).toBe('Type 1 diabetes mellitus');
  });

  function virtualProvider(resolver) {
    const provider = Object.create(Provider.prototype);
    provider.ecosystem = resolver;
    provider.fhirVersion = 5;
    return provider;
  }

  // a candidate is only used if it has the content of the code system (complete or fragment)
  test('a candidate that doesn\'t have the content is passed over for the next', async () => {
    const resolver = new EcosystemResolver({ use: true, registry: `${REG}/tx-reg` });
    nock(REG).get('/tx-reg').query(true).reply(200, { results: [] });
    nock(REG).get('/tx-reg/resolve').query(true).reply(200, { candidates: [{ url: 'https://empty.example/fhir', open: true }, { url: SERVER, open: true }] });
    nock('https://empty.example').get('/fhir/metadata').query(true).reply(200, { resourceType: 'TerminologyCapabilities', codeSystem: [] });
    nock('https://empty.example').get('/fhir/CodeSystem').query(true).reply(200, { resourceType: 'Bundle', entry: [
      { resource: { resourceType: 'CodeSystem', url: 'http://example.org/cs', version: '1', content: 'not-present', count: 45210 } }] });
    nock('https://other.example').get('/fhir/metadata').query(true).reply(200, { resourceType: 'TerminologyCapabilities', codeSystem: [
      { uri: 'http://example.org/cs', version: [{ code: '1' }], content: 'complete' }] });
    const cs = await virtualProvider(resolver).findInEcosystem(new OperationContext('en', i18n), 'http://example.org/cs', null, null);
    expect(cs).toBeInstanceOf(VirtualCodeSystemProvider);
    expect(cs.server).toBe(SERVER);
    expect(cs.version()).toBe('1');
    expect(nock.isDone()).toBe(true);
  });

  // a server that holds the concepts in its own tables, and says not-present, is used if it's
  // registered as authoritative for the code system
  test('an authoritative server is used whatever it says about the content', async () => {
    const resolver = new EcosystemResolver({ use: true, registry: `${REG}/tx-reg` });
    nock(REG).get('/tx-reg').query(true).reply(200, { results: [] });
    nock(REG).get('/tx-reg/resolve').query(true).reply(200, { authoritative: [{ url: SERVER, open: true }] });
    nock('https://other.example').get('/fhir/metadata').query(true).reply(200, { resourceType: 'TerminologyCapabilities', codeSystem: [
      { uri: 'http://example.org/cs', version: [{ code: '1' }], content: 'not-present' }] });
    const cs = await virtualProvider(resolver).findInEcosystem(new OperationContext('en', i18n), 'http://example.org/cs', null, null);
    expect(cs).toBeInstanceOf(VirtualCodeSystemProvider);
    expect(cs.server).toBe(SERVER);
    expect(cs.version()).toBe('1');
    expect(nock.isDone()).toBe(true);
  });
});
