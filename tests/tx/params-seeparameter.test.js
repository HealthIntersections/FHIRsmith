const { TxParameters } = require('../../tx/params');
const { TestUtilities } = require('../test-utilities');
let langDefs, i18n;
beforeAll(async () => {
  langDefs = await TestUtilities.loadLanguageDefinitions();
  i18n = await TestUtilities.loadTranslations(langDefs);
});
const mk = () => new TxParameters(langDefs, i18n);
const read = (p, parameter) => { p.readParams({resourceType:'Parameters', parameter}); return p; };

test('GET-style string booleans now work', () => {
  const p = read(mk(), [{name:'abstract', valueString:'false'}, {name:'inferSystem', valueString:'true'},
    {name:'versionsMatch', valueString:'true'}, {name:'valueset-membership-only', valueString:'true'},
    {name:'lenient-display-validation', valueString:'true'}]);
  expect(p.abstractOk).toBe(false);
  expect(p.inferSystem).toBe(true);
  expect(p.versionsMatch).toBe(true);
  expect(p.membershipOnly).toBe(true);
  expect(p.displayWarning).toBe(true);
});

test('boolean forms still work, abstract stays tri-state', () => {
  const p = read(mk(), [{name:'abstract', valueBoolean:true}, {name:'count', valueString:'25'}, {name:'filter', valueString:'abc'}]);
  expect(p.abstractOk).toBe(true);
  expect(p.count).toBe(25);
  expect(p.filter).toBe('abc');
  expect(mk().abstractOk).toBe(true); // default when not supplied
});

test('extension params (overwrite=false) do not clobber request params', () => {
  const p = read(mk(), [{name:'activeOnly', valueString:'true'}, {name:'displayLanguage', valueString:'de'}]);
  p.seeParameter('activeOnly', {url:'value', valueBoolean:false}, false);
  p.seeParameter('displayLanguage', {url:'value', valueCode:'fr'}, false);
  expect(p.activeOnly).toBe(true);
  expect(p.DisplayLanguages.asString(false)).toContain('de');
});

test('extension params still apply when the request did not set them', () => {
  const p = read(mk(), [{name:'url', valueUri:'http://x'}]);
  p.seeParameter('activeOnly', {url:'value', valueBoolean:true}, false);
  p.seeParameter('excludeNotForUI', {url:'value', valueString:'true'}, false);
  p.seeParameter('property', {url:'value', valueString:'definition'}, false);
  p.seeParameter('designation', {url:'value', valueString:'en'}, false);
  expect(p.activeOnly).toBe(true);
  expect(p.excludeNotForUI).toBe(true);
  expect(p.properties).toEqual(['definition']);
  expect(p.designations).toEqual(['en']);
});

test('exclude-system still throws, profile still recurses', () => {
  expect(() => read(mk(), [{name:'exclude-system', valueString:'x'}])).toThrow();
  const p = read(mk(), [{name:'profile', resource:{resourceType:'Parameters', parameter:[{name:'activeOnly', valueBoolean:true}]}}]);
  expect(p.activeOnly).toBe(true);
});

test('version rules accumulate from both routes', () => {
  const p = read(mk(), [{name:'system-version', valueString:'http://loinc.org|2.77'}]);
  p.seeParameter('force-system-version', {url:'value', valueString:'http://snomed.info/sct|1'}, false);
  expect(p.versionRules.length).toBe(2);
});

test('R6 ValueSet.compose.property contributes properties', () => {
  const p = read(mk(), [{name:'url', valueUri:'http://x'}]);
  p.seeCompose({property: ['definition', 'status'], include: []});
  expect(p.properties).toEqual(['definition', 'status']);
});

test('compose.property merges with request properties without duplicating', () => {
  const p = read(mk(), [{name:'property', valueString:'definition'}]);
  p.seeCompose({property: ['definition', 'usage-count']});
  expect(p.properties).toEqual(['definition', 'usage-count']);
});

test('seeCompose tolerates absent/odd compose', () => {
  const p = mk();
  expect(() => { p.seeCompose(undefined); p.seeCompose({}); p.seeCompose({property: 'nope'}); }).not.toThrow();
  expect(p.properties).toEqual([]);
});

test('showsDisplayOnly: no designations asked for, and English or no languages', () => {
  const { Languages } = require('../../library/languages');
  const en = Languages.fromAcceptLanguage('en-US', langDefs);
  const de = Languages.fromAcceptLanguage('de', langDefs);
  expect(mk().showsDisplayOnly(null)).toBe(true);
  expect(mk().showsDisplayOnly(en)).toBe(true);
  expect(mk().showsDisplayOnly(de)).toBe(false);
  expect(read(mk(), [{name:'includeDesignations', valueBoolean:true}]).showsDisplayOnly(en)).toBe(false);
  expect(read(mk(), [{name:'designation', valueString:'en'}]).showsDisplayOnly(en)).toBe(false);
  expect(read(mk(), [{name:'displayLanguage', valueCode:'en'}]).showsDisplayOnly(en)).toBe(false);
});
