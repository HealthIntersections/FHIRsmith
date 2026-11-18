/**
 * ECL description term filters and the text index
 *
 * A {{ term = "..." }} filter used to read and split every description of every concept in the
 * set it filters: for << 138875005 on the International Edition that is 380k concepts, about 2
 * seconds of synchronous work on tx.fhir.org (2026-11-16). With the edition's text index (which
 * the cache carries), the filter only looks at the concepts the index says could match
 * (SnomedServices._eclTermCandidates). The index only narrows: what matches is still decided
 * description by description, so the results have to be exactly the same either way.
 *
 * Also here: a default language that isn't a language byte is treated as English, rather than
 * having the text filter search a language no description is in.
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

  const codes = async (ecl) => ((await snomedServices.filterECL(ecl, true, opContext)).descendants || [])
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

  const codesOfAll = async (ecls) => {
    const all = [];
    for (const ecl of ecls) {
      all.push(await codes(ecl));
    }
    return all;
  };

  test('the same concepts, in the same order, with the index as without', async () => {
    const index = snomedServices._textIndex;
    expect(index).toBeTruthy();
    snomedServices._textIndex = null;
    let before;
    try {
      before = await codesOfAll(ECLS);
    } finally {
      snomedServices._textIndex = index;
    }
    // the filters that ought to find something do, so the comparison means something
    expect(before[0].length).toBeGreaterThan(0);
    expect(before[4].length).toBeGreaterThan(before[0].length);

    const after = await codesOfAll(ECLS);
    ECLS.forEach((ecl, i) => {
      expect({ ecl, codes: after[i] }).toEqual({ ecl, codes: before[i] });
    });
  });

  test('the index narrows a match term, and leaves alone what it cannot narrow', async () => {
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

  test('a default language that is not a language byte is English', () => {
    expect(new SnomedServices({ ...factory._sharedData, defaultLanguage: 51756144 }).defaultLanguage).toBe(1);
    expect(new SnomedServices({ ...factory._sharedData, defaultLanguage: 44264 }).defaultLanguage).toBe(1);
    expect(new SnomedServices({ ...factory._sharedData, defaultLanguage: 3 }).defaultLanguage).toBe(3);
  });
});
