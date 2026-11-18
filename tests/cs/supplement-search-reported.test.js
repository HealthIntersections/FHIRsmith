/**
 * A supplement in use that gives a text filter some of its codes is noted on the filter context
 * (usedSupplements), for the expansion to report as used (used-supplement): it decided what the
 * expansion has, whatever language the displays are shown in. Here with SNOMED CT's test edition
 * and a global language pack with English designations, as the Uzbek LOINC pack has
 */

const path = require('path');
const fs = require('fs');
const { SnomedServicesFactory } = require('../../tx/cs/cs-snomed');
const { CodeSystem } = require('../../tx/library/codesystem');
const { OperationContext } = require('../../tx/operation-context');
const { LanguageDefinitions, Languages } = require('../../library/languages');
const { I18nSupport } = require('../../library/i18nsupport');
const { SearchFilterText } = require('../../tx/library/designations');
const folders = require('../../library/folder-setup');

const testCachePath = folders.ensureFilePath('snomed-testing.cache');
const committedCachePath = path.resolve(__dirname, '../../tx/data/snomed-testing.cache');
// (the scratch copy only if it's in the current cache format: one from an older version's run isn't)
const { SnomedFileReader } = require('../../tx/sct/structures');
const cacheFile = fs.existsSync(testCachePath) && SnomedFileReader.isCurrent(testCachePath) ? testCachePath
  : (fs.existsSync(committedCachePath) ? committedCachePath : null);

const CONCEPT = '11687002'; // in the test edition, found by a search for "diabetes"

function pack(designation) {
  return new CodeSystem({
    resourceType: 'CodeSystem', url: 'http://example.org/fhir/CodeSystem/sct-pack-uz', version: '1.0.0', status: 'active',
    content: 'supplement', supplements: 'http://snomed.info/sct', language: 'uz',
    extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/codesystem-supplement-type', valueCode: 'lang-pack' },
      { url: 'http://hl7.org/fhir/StructureDefinition/codesystem-supplement-global', valueBoolean: true }],
    concept: [{ code: CONCEPT, display: 'Qandli diabet', designation: [{ language: 'en', value: designation }] }]
  });
}

(cacheFile ? describe : describe.skip)('a supplement that gives a text filter codes is noted as used', () => {
  let factory;
  let i18n;

  beforeAll(async () => {
    const langDefs = await LanguageDefinitions.fromFiles(path.resolve(__dirname, '../../tx/data'));
    i18n = new I18nSupport(path.resolve(__dirname, '../../translations'), langDefs);
    await i18n.load();
    factory = new SnomedServicesFactory(i18n, cacheFile);
    await factory.load();
  }, 60000);

  async function search(text, supplement) {
    const opContext = new OperationContext(new Languages(), i18n);
    const cs = await factory.build(opContext, [supplement]);
    const prep = await cs.getPrepContext(true, null);
    const filter = await cs.searchFilter(prep, new SearchFilterText(text), true);
    return { prep, codes: filter.matches.map(m => m.term.toString()) };
  }

  test('a code only the supplement matches: the supplement is noted', async () => {
    const { prep, codes } = await search('zzyzx widget', pack('Zzyzx widget condition'));
    expect(codes).toContain(CONCEPT);
    expect([...(prep.usedSupplements || [])]).toEqual(['http://example.org/fhir/CodeSystem/sct-pack-uz|1.0.0']);
  });

  test('nothing the edition does not match itself: not noted', async () => {
    const { prep, codes } = await search('diabetes', pack('Diabetes'));
    expect(codes).toContain(CONCEPT);
    expect([...(prep.usedSupplements || [])]).toEqual([]);
  });

  test('no match at all: not noted', async () => {
    const { prep } = await search('qwertyuiop', pack('Zzyzx widget condition'));
    expect([...(prep.usedSupplements || [])]).toEqual([]);
  });
});
