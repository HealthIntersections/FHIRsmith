/**
 * ECL description term filters and the text index
 *
 * A {{ term = "..." }} filter used to read and split every description of every concept in the
 * set it filters: for << 138875005 on the International Edition that is 380k concepts, about 2
 * seconds of synchronous work on tx.fhir.org (2026-11-16). Once the edition's text index is
 * built, the filter only looks at the concepts the index says could match
 * (SnomedServices._eclTermCandidates). The index only narrows: what matches is still decided
 * description by description, so the results have to be exactly the same either way.
 *
 * Also here: a cache whose default language isn't a language byte (the Pascal importer's
 * caches) is treated as English, rather than having the text filter search a language no
 * description is in.
 */

const { SnomedServicesFactory, SnomedServices } = require('../../tx/cs/cs-snomed');
const {join} = require("node:path");
const {OperationContext} = require("../../tx/operation-context");
const {TestUtilities} = require("../test-utilities");

describe('ECL term filters with the text index', () => {
  let factory;
  let snomedServices;
  let opContext;

  beforeAll(async () => {
    opContext = new OperationContext('en', await TestUtilities.loadTranslations());
    factory = new SnomedServicesFactory(opContext.i18n, join(__dirname, '../../tx/data/snomed-testing.cache'));
    await factory.load();
    snomedServices = factory.snomedServices;
  });

  const codes = (ecl) => (snomedServices.filterECL(ecl, true, opContext).descendants || [])
    .map(i => snomedServices.concepts.getConceptId(i).toString());

  const ECLS = [
    '<< 138875005 {{ term = "liver" }}',
    '<< 138875005 {{ term = "liv" }}',
    '<< 138875005 {{ term = "lung struct" }}',
    '<< 138875005 {{ term = "LIVER" }}',
    '<< 138875005 {{ term = ("liver" "lung") }}',
    '<< 138875005 {{ term = "disease", type = syn }}',
    '<< 138875005 {{ term = "liver" }} {{ term = "struct" }}',
    '<< 138875005 {{ term = "liver", term = "struct" }}',
    '<< 138875005 {{ term != "liver" }}',
    '<< 138875005 {{ term = wild:"*structure" }}',
    '<< 138875005 {{ term = "a" }}',
    '<< 138875005 {{ term = "x-ray" }}',
    '<< 138875005 {{ term = "liver", active = true }}',
    '<< 138875005 {{ term = "nosuchwordanywhere" }}',
    '* {{ term = "liver" }}'
  ];

  test('the same concepts, in the same order, with the index as without', async () => {
    expect(snomedServices._textIndex).toBeFalsy();
    const before = ECLS.map(codes);
    // the filters that ought to find something do, so the comparison means something
    expect(before[0].length).toBeGreaterThan(0);
    expect(before[4].length).toBeGreaterThan(before[0].length);

    await snomedServices.getTextIndex(opContext);
    expect(snomedServices._textIndex).toBeTruthy();
    const after = ECLS.map(codes);
    ECLS.forEach((ecl, i) => {
      expect({ ecl, codes: after[i] }).toEqual({ ecl, codes: before[i] });
    });
  });

  test('the index narrows a match term, and leaves alone what it cannot narrow', async () => {
    await snomedServices.getTextIndex(opContext);
    const prepared = (ecl) => {
      // the block's filters, as _applyDescriptionFilter prepares them (term filters only matter)
      const { ECLLexer, ECLParser } = require('../../tx/sct/ecl');
      const ast = new ECLParser(new ECLLexer(ecl).tokenize()).parse();
      return ast.filters[0].filters.map(f => ({ ...f, field: f.field.toLowerCase() }));
    };
    const liver = snomedServices._eclTermCandidates(prepared('<< 138875005 {{ term = "liver" }}'), opContext);
    expect(liver).toBeInstanceOf(Set);
    expect(liver.size).toBeLessThan(snomedServices.concepts.count());
    expect(snomedServices._eclTermCandidates(prepared('<< 138875005 {{ term = "nosuchwordanywhere" }}'), opContext).size).toBe(0);
    // not narrowed: wild:, !=, a one-letter word, a word that isn't plain letters and digits
    expect(snomedServices._eclTermCandidates(prepared('<< 138875005 {{ term = wild:"liver*" }}'), opContext)).toBeNull();
    expect(snomedServices._eclTermCandidates(prepared('<< 138875005 {{ term != "liver" }}'), opContext)).toBeNull();
    expect(snomedServices._eclTermCandidates(prepared('<< 138875005 {{ term = "a" }}'), opContext)).toBeNull();
    expect(snomedServices._eclTermCandidates(prepared('<< 138875005 {{ term = "x-ray" }}'), opContext)).toBeNull();
    // one alternative that can't be narrowed: nor can the filter
    expect(snomedServices._eclTermCandidates(prepared('<< 138875005 {{ term = ("liver" "a") }}'), opContext)).toBeNull();
  });

  test('which expressions have a term filter', () => {
    expect(snomedServices.eclHasTermFilter('<< 138875005 {{ term = "liver" }}')).toBe(true);
    expect(snomedServices.eclHasTermFilter('<< 138875005 {{ D term != "liver" }}')).toBe(true);
    expect(snomedServices.eclHasTermFilter('<< 138875005 {{ TERM = "liver" }}')).toBe(true);
    expect(snomedServices.eclHasTermFilter('<< 138875005')).toBe(false);
    expect(snomedServices.eclHasTermFilter('<< 138875005 {{ C active = true }}')).toBe(false);
  });

  test('a default language that is not a language byte is English', () => {
    expect(new SnomedServices({ ...factory._sharedData, defaultLanguage: 51756144 }).defaultLanguage).toBe(1);
    expect(new SnomedServices({ ...factory._sharedData, defaultLanguage: 44264 }).defaultLanguage).toBe(1);
    expect(new SnomedServices({ ...factory._sharedData, defaultLanguage: 3 }).defaultLanguage).toBe(3);
  });
});
