// A code system held on another server in the ecosystem (tx/cs/cs-virtual.js), talked to through
// the ecosystem resolver (tx/ecosystem-resolver.js)

const nock = require('nock');
const { EcosystemResolver } = require('../../tx/ecosystem-resolver');
const { VirtualCodeSystemProvider } = require('../../tx/cs/cs-virtual');
const { OperationContext } = require('../../tx/operation-context');
const { Designations, DesignationUse } = require('../../tx/library/designations');
const { TestUtilities } = require('../test-utilities');

const REG = 'https://reg.example';
const SERVER = 'https://other.example/fhir';
const SCT = 'http://snomed.info/sct';
const EDITION = 'http://snomed.info/sct/11000279109';

describe('VirtualCodeSystemProvider', () => {
  let opContext;
  let languages;
  beforeAll(async () => {
    nock.disableNetConnect();
    languages = await TestUtilities.loadLanguageDefinitions();
    opContext = new OperationContext('en', await TestUtilities.loadTranslations(languages));
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
});
