/**
 * The text index of a supplement in use (tx/library/supplement-text-index.js): a text filter is
 * answered from it, with the same matches as SearchFilterText.passes on each display and
 * designation in the search language, without stemming the supplement again for each search
 */

const { SupplementTextIndex } = require('../../tx/library/supplement-text-index');
const { SearchFilterText } = require('../../tx/library/designations');
const { CodeSystemProvider } = require('../../tx/cs/cs-api');
const { Language } = require('../../library/languages');

function supplement(concepts, language = 'uz') {
  return { jsonObj: { language }, getAllConcepts: () => concepts };
}

// SearchFilterText.passes on every text (in the text's language), in concept order
function byScan(supp, filter, searchLang, defLang = 'en') {
  const codes = new Set();
  const suppLang = supp.jsonObj.language || defLang;
  for (const concept of supp.getAllConcepts()) {
    if (concept.display && CodeSystemProvider.inSearchLanguage(suppLang, searchLang) && filter.passes(concept.display, false, suppLang)) {
      codes.add(concept.code);
      continue;
    }
    for (const d of concept.designation || []) {
      if (d.value && CodeSystemProvider.inSearchLanguage(d.language, searchLang, suppLang) && filter.passes(d.value, false, d.language || suppLang)) {
        codes.add(concept.code);
        break;
      }
    }
  }
  return codes;
}

const CONCEPTS = [
  { code: '101736-7', display: 'Kaltsiy gidrofosfat kristallari 24 soatlik siydikda',
    designation: [{ language: 'en', value: 'Calcium hydrogen phosphate dihydrate crystals [Energy Difference] in 24 hour Urine' }] },
  { code: '2000-8', display: 'Kaltsiy qon zardobida',
    designation: [{ language: 'en-US', value: 'Calcium [Moles/volume] in Serum or Plasma' }, { value: 'Kaltsiy' }] },
  { code: '2823-3', display: 'Kaliy qon zardobida',
    designation: [{ language: 'EN', value: 'Potassium [Moles/volume] in Serum or Plasma' }] },
  { code: '14637-3', designation: [{ language: 'en', value: 'Calcium excretion' }, { language: 'en', value: 'in Urine' }] },
  { code: '9999-9', display: 'Hech narsa' }
];

describe('SupplementTextIndex', () => {
  test('the languages a supplement has text in, at the language subtag', () => {
    const index = SupplementTextIndex.of(supplement(CONCEPTS), 'en');
    expect([...index.languages()].sort()).toEqual(['en', 'uz']);
    expect(index.hasText('en-GB')).toBe(true);
    expect(index.hasText(new Language('UZ'))).toBe(true);
    expect(index.hasText('de')).toBe(false);
  });

  test.each([
    ['calcium urine', 'en'], ['calcium', 'en'], ['calc', 'en'], ['potassium serum', 'en'], ['kaltsiy', 'uz'],
    ['kaltsiy siydik', 'uz'], ['calcium', 'uz'], ['nothing here', 'en'], ['24 hour', 'en'], ['moles', 'en-US']
  ])('"%s" in %s: the same codes, in the same order, as passes on every text', async (text, lang) => {
    const supp = supplement(CONCEPTS);
    const filter = new SearchFilterText(text);
    const searchLang = new Language(lang);
    const indexed = await SupplementTextIndex.of(supp, 'en').search(filter, searchLang);
    expect([...indexed]).toEqual([...byScan(supp, filter, searchLang)]);
  });

  test('every word of the filter has to be in one text, not spread over two', async () => {
    // 14637-3 has "Calcium excretion" and "in Urine" as two designations
    const codes = await SupplementTextIndex.of(supplement(CONCEPTS), 'en').search(new SearchFilterText('calcium urine'), new Language('en'));
    expect(codes.has('14637-3')).toBe(false);
    expect(codes.has('101736-7')).toBe(true);
  });

  test('a supplement that does not say its language is in the code system\'s', async () => {
    const supp = supplement([{ code: 'a', display: 'Calcium in urine' }], null);
    const index = SupplementTextIndex.of(supp, 'en');
    expect([...await index.search(new SearchFilterText('calcium'), new Language('en'))]).toEqual(['a']);
  });

  test('the index is built once per supplement', async () => {
    const concepts = [{ code: 'a', display: 'Calcium' }];
    let reads = 0;
    const supp = { jsonObj: { language: 'en' }, codeMap: new Map(concepts.map(c => [c.code, c])), getAllConcepts: () => { reads++; return concepts; } };
    const index = SupplementTextIndex.of(supp, 'en');
    expect(SupplementTextIndex.of(supp, 'en')).toBe(index);
    await index.search(new SearchFilterText('calcium'), new Language('en'));
    await index.search(new SearchFilterText('potassium'), new Language('en'));
    expect(reads).toBe(2); // once for the languages, once for the stems
  });

  test('building the index of a large supplement lets other work run', async () => {
    const concepts = Array.from({ length: 60000 }, (_, i) => ({
      code: 'c' + i, display: `Kaltsiy ${i}`, designation: [{ language: 'en', value: `Calcium hydrogen phosphate crystals ${i} in 24 hour urine` }]
    }));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    let codes;
    try {
      codes = await SupplementTextIndex.of(supplement(concepts), 'en').search(new SearchFilterText('calcium urine 59999'), new Language('en'));
    } finally {
      clearInterval(timer);
    }
    expect([...codes]).toEqual(['c59999']);
    expect(ticks).toBeGreaterThan(0);
  });
});

describe('CodeSystemProvider.inSearchLanguage', () => {
  test('compares the language subtag, without regard to case', () => {
    expect(CodeSystemProvider.inSearchLanguage('de-AT', new Language('de'))).toBe(true);
    expect(CodeSystemProvider.inSearchLanguage('EN', new Language('en-GB'))).toBe(true);
    expect(CodeSystemProvider.inSearchLanguage(new Language('fr-CA'), new Language('fr'))).toBe(true);
    expect(CodeSystemProvider.inSearchLanguage('de', new Language('en'))).toBe(false);
  });

  test('text that does not say is in the fallback language', () => {
    expect(CodeSystemProvider.inSearchLanguage(null, new Language('en'))).toBe(true);
    expect(CodeSystemProvider.inSearchLanguage('', new Language('uz'), 'uz')).toBe(true);
    expect(CodeSystemProvider.inSearchLanguage(undefined, new Language('en'), 'uz')).toBe(false);
  });
});

describe('CodeSystemProvider._supplementSearchCodes', () => {
  const { OperationContext } = require('../../tx/operation-context');
  const { CodeSystem } = require('../../tx/library/codesystem');
  const { TestUtilities } = require('../test-utilities');
  let i18n;
  beforeAll(async () => {
    i18n = await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions());
  });

  // a provider whose own displays are known (as LOINC's and SNOMED CT's are: _rootDisplay)
  class Provider extends CodeSystemProvider {
    constructor(supplements, displays) {
      super(new OperationContext('en', i18n), supplements);
      this.displays = displays;
    }

    async _rootDisplay(code) {
      return this.displays[code] || null;
    }
  }

  const pack = (concepts) => new CodeSystem({
    resourceType: 'CodeSystem', url: 'http://example.org/pack', version: '1', status: 'active',
    content: 'supplement', supplements: 'http://example.org/cs', language: 'uz', concept: concepts
  });

  test('a text that only repeats the code\'s own display is left out; one that says more is not', async () => {
    const provider = new Provider([pack([
      { code: 'a', display: 'Kaltsiy', designation: [{ language: 'en', value: 'Calcium in urine' }] },
      { code: 'b', display: 'Kaltsiy qonda', designation: [{ language: 'en', value: 'Calcium in blood (serum)' }] },
      { code: 'c', display: 'Kaltsiy', designation: [{ language: 'en', value: '  calcium   IN urine ' }, { language: 'en', value: 'Urine calcium excretion' }] }
    ])], { a: 'Calcium in urine', b: 'Calcium in blood', c: 'Calcium in urine' });
    const sources = new Map();
    const codes = await provider._supplementSearchCodes(new SearchFilterText('calcium'), new Language('en'), sources);
    // a: only a copy; b: more than the display; c: a copy (but for case and spaces) and another text
    expect([...codes]).toEqual(['b', 'c']);
    expect(sources.get('b')).toBe('http://example.org/pack|1');
  });

  test('a provider that doesn\'t give its displays leaves nothing out', async () => {
    const provider = new Provider([pack([{ code: 'a', designation: [{ language: 'en', value: 'Calcium in urine' }] }])], {});
    expect([...await provider._supplementSearchCodes(new SearchFilterText('calcium'), new Language('en'))]).toEqual(['a']);
  });
});
