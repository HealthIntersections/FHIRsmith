/**
 * Comprehensive Jest Test Suite for ECL Validator
 *
 * Tests based on:
 * - Official ECL specification examples
 * - SNOMED CT Browser examples
 * - Australian Digital Health examples
 * - IHTSDO query service examples
 * - Real-world clinical use cases
 *
 * Note that these sensible ECL examples were then twisted into weird non-sensical expressions to use the
 * test SCT set. Don't think they're going to make much sense
 */

const { SnomedServicesFactory } = require('../../tx/cs/cs-snomed');
const {ECLTokenType, ECLLexer, ECLValidator, ECLNodeType} = require("../../tx/sct/ecl");
const {join} = require("node:path");
const {OperationContext} = require("../../tx/operation-context");
const {TestUtilities} = require("../test-utilities");

describe('ECL Validator Test Suite', () => {
  let eclValidator;
  let snomedServices;
  let opContext;

  beforeAll(async () => {
    // Load test SNOMED data
    opContext = new OperationContext('en', await TestUtilities.loadTranslations());
    const factory = new SnomedServicesFactory(opContext.i18n, join(__dirname, '../../tx/data/snomed-testing.cache'));
    await factory.load();
    snomedServices = factory.snomedServices;
    eclValidator = new ECLValidator(snomedServices);
  });

  describe('ECL 2.x member filters ({{ M ... }})', () => {
    // The test edition has two REPLACED BY (900000000000526001) members:
    // 307530000 -> 74400008, module 900000000000207008, effectiveTime 20240601, and
    // 1000381000003107 -> 4896000, module 31000003106, effectiveTime 20250909.
    const expandCodes = async (ecl) => {
      const ctx = await snomedServices.filterECL(ecl, true, opContext);
      return (ctx.descendants || []).map(i => snomedServices.concepts.getConceptId(i).toString());
    };
    const errorFor = async (ecl) => {
      try {
        await snomedServices.filterECL(ecl, true, opContext);
      } catch (e) {
        return e;
      }
      return null;
    };

    test.each([
      ['^ 900000000000526001 {{ M effectiveTime >= "20240101" }}', ['1000381000003107', '307530000']],
      ['^ 900000000000526001 {{ M effectiveTime >= "20250101" }}', ['1000381000003107']],
      ['^ 900000000000526001 {{ M effectiveTime = "20240601" }}', ['307530000']],
      ['^ 900000000000526001 {{ M effectiveTime != "20240601" }}', ['1000381000003107']],
      ['^ 900000000000526001 {{ M effectiveTime < "20240601" }}', []],
      ['^ 900000000000526001 {{ M effectiveTime <= "20240601" }}', ['307530000']],
      ['^ 900000000000526001 {{ M effectiveTime = ("20230101" "20240601") }}', ['307530000']],
      ['^ 900000000000526001 {{ M active = true }}', ['1000381000003107', '307530000']],
      ['^ 900000000000526001 {{ M active = 0 }}', []],
      ['^ 900000000000526001 {{ M active != false }}', ['1000381000003107', '307530000']],
      ['^ 900000000000526001 {{ M moduleId = 900000000000207008 }}', ['307530000']],
      ['^ 900000000000526001 {{ M moduleId != 900000000000207008 }}', ['1000381000003107']],
      ['^ 900000000000526001 {{ M targetComponentId = 74400008 }}', ['307530000']],
      ['^ 900000000000526001 {{ M targetComponentId = << 64572001 }}', ['1000381000003107', '307530000']],
      ['^ 900000000000526001 {{ M targetComponentId != 74400008 }}', ['1000381000003107']],
      ['^ 900000000000526001 {{ M targetComponentId = * }}', ['1000381000003107', '307530000']],
      ['^ 900000000000526001 {{ M active = true, effectiveTime >= "20240101" }} {{ M targetComponentId = 74400008 }}', ['307530000']],
      ['^ 900000000000526001 {{ M active = true, effectiveTime >= "20250101" }}', ['1000381000003107']],
      ['^ (900000000000526001 OR 64572001) {{ M effectiveTime >= "20240101" }}', ['1000381000003107', '307530000']],
    ])('%s', async (ecl, expected) => {
      expect((await expandCodes(ecl)).sort()).toEqual(expected);
    });

    test('a member filter must directly follow a memberOf constraint (syntax error)', async () => {
      const e = await errorFor('( ^ 900000000000526001 OR ^ 900000000000526001 ) {{ M effectiveTime >= "20250101" }}');
      expect(e).not.toBeNull();
      expect(e.message).toContain('may only follow a memberOf');
      expect(e.msgId).toBe('INVALID_ECL');
    });

    test('an unknown reference set field is rejected', async () => {
      const e = await errorFor('^ 900000000000526001 {{ M mapTarget = "x" }}');
      expect(e).not.toBeNull();
      expect(e.message).toContain('no field named mapTarget');
    });

    test('a malformed effectiveTime value is a syntax error', async () => {
      const e = await errorFor('^ 900000000000526001 {{ M effectiveTime >= "2025-01-01" }}');
      expect(e).not.toBeNull();
      expect(e.msgId).toBe('INVALID_ECL');
    });

    test('a malformed history supplement is a syntax error', async () => {
      expect((await errorFor('< 64572001 {{ + FOO }}')).msgId).toBe('INVALID_ECL');
      expect((await errorFor('< 64572001 {{ + HISTORY-MIN (*) }}')).msgId).toBe('INVALID_ECL');
    });
  });

  describe('ECL 2.x syntax that used to be reported as invalid', () => {
    const codes = async (ecl) => ((await snomedServices.filterECL(ecl, true, opContext)).descendants || [])
      .map(i => snomedServices.concepts.getConceptId(i).toString()).sort();
    const count = async (ecl) => (await codes(ecl)).length;
    const errorFor = async (ecl) => {
      try {
        await snomedServices.filterECL(ecl, true, opContext);
      } catch (e) {
        return e;
      }
      return null;
    };

    test('a hierarchy operator on a bracketed set applies to every member', async () => {
      const disease = await count('< 64572001');
      const liver = await count('< 10200004');
      expect(await count('< (64572001 OR 10200004)')).toBe(await count('< 64572001 OR < 10200004'));
      expect(await count('< (64572001 OR 10200004)')).toBeGreaterThan(Math.max(disease, liver));
      expect(await count('<< (64572001 OR 10200004)')).toBe((await count('< (64572001 OR 10200004)')) + 2);
      expect(await codes('>> (39607008)')).toEqual(await codes('>> 39607008'));
      expect(await codes('<! (64572001 OR 10200004)')).toEqual(await codes('<! 64572001 OR <! 10200004'));
    });

    test('a hierarchy operator on the wildcard', async () => {
      const all = await count('*');
      expect(await count('<< *')).toBe(all);
      expect(await count('>> *')).toBe(all);
      expect(await count('< *')).toBe(all - await count('!!> *'));
      expect(await count('> *')).toBeGreaterThan(0);
      expect(await count('> *')).toBeLessThan(all);
    });

    test('a hierarchy operator on a member-of', async () => {
      expect(await codes('<< ^ 900000000000526001')).toEqual(await codes('^ 900000000000526001'));
      expect(await count('< ^ 900000000000526001')).toBe(0);
      expect(await codes('< (^ 900000000000526001 OR 64572001)')).toEqual(await codes('< 64572001'));
    });

    test('comments are whitespace', async () => {
      expect(await count('/* lead */ < 64572001 /* mid */ AND /* mid */ < 64572001 /* trail */')).toBe(await count('< 64572001'));
      expect((await errorFor('< 64572001 /* unterminated')).msgId).toBe('INVALID_ECL');
    });

    test('top of set', async () => {
      expect(await codes('!!> (<< 64572001)')).toEqual(['64572001']);
      expect(await codes('!!> (< 64572001)')).toEqual(await codes('<! 64572001'));
      expect(await codes('!!> (<< 39607008 OR << 10200004)')).toEqual(['10200004', '39607008']);
    });

    test('bottom of set', async () => {
      const leaves = await codes('!!< (<< 64572001)');
      expect(leaves.length).toBeGreaterThan(0);
      expect(leaves).not.toContain('64572001');
      expect(await codes('!!< (<< 39607008)')).toEqual((await codes('<< 39607008')).filter(c => c !== '39607008'));
    });

    test('attribute names may be expressions', async () => {
      const plain = await codes('< 64572001 : 363698007 = << 39607008');
      expect(plain.length).toBeGreaterThan(0);
      expect(await codes('< 64572001 : << 363698007 = << 39607008')).toEqual(plain);
      expect(await codes('< 64572001 : (363698007 OR 116676008) = << 39607008')).toEqual(plain);
      expect(await codes('< 64572001 : << 762705008 |Concept model object attribute| = << 39607008')).toEqual(plain);
      expect(await codes('< 64572001 : * = << 39607008')).toEqual(plain);
      expect(await codes('< 64572001 : { << 363698007 = << 39607008 }')).toEqual(await codes('< 64572001 : { 363698007 = << 39607008 }'));
      expect(await count('< 64572001 : ^ 900000000000526001 = << 39607008')).toBe(0);
    });

    test('dotted attribute names may be expressions', async () => {
      const plain = await codes('< 64572001 . 363698007');
      expect(plain.length).toBeGreaterThan(0);
      expect(await codes('< 64572001 . << 363698007')).toEqual(plain);
      expect((await codes('< 64572001 . (363698007 OR 116676008)')).length).toBeGreaterThan(plain.length);
    });

    test('a bracketed attribute name is told apart from a bracketed sub refinement', async () => {
      const a = await count('< 64572001 : (363698007 OR 116676008) = << 39607008');
      const b = await count('< 64572001 : (363698007 = << 39607008 OR 116676008 = << 39607008)');
      expect(a).toBe(b);
    });

    test.each([
      '* : 1142139005 = #1',
      '* : 1142139005 != #-1.5',
      '* : 1142139005 = "x"',
      '* : 1142139005 != ("x" "y")',
      '* : 1142139005 = match:"x"',
      '* : 1142139005 = wild:"x*"',
      '* : 1142139005 = true',
      '* : 1142139005 != false',
      '* : 1142139005 >= #5',
    ])('concrete value %s parses and is evaluated', async (ecl) => {
      expect(await errorFor(ecl)).toBeNull();
    });

    test.each([
      '("ICD10#A01.1")',
      '< SCTID#64572001',
      '< ICD10#A01.1 |Typhoid|',
    ])('alternate identifier %s with an unknown scheme is invalid', async (ecl) => {
      const e = await errorFor(ecl);
      expect(e).not.toBeNull();
      expect(e.msgId).toBe('INVALID_ECL');
      expect(e.message).toContain('scheme');
    });

    test.each([
      '^ [referencedComponentId] 900000000000526001',
      '^ [targetComponentId] 900000000000526001 |REPLACED BY association reference set|',
      '^ [referencedComponentId, targetComponentId] (900000000000526001)',
    ])('reference set field selection %s parses and is reported as unsupported', async (ecl) => {
      const e = await errorFor(ecl);
      expect(e).not.toBeNull();
      expect(e.msgId).toBe('UNSUPPORTED_ECL');
      expect(e.message).toContain('field selection');
    });

    test('member-of on a reference set of descriptions is unsupported, not empty', async () => {
      const e = await errorFor('^ 900000000000509007 |US English|');
      expect(e).not.toBeNull();
      expect(e.msgId).toBe('UNSUPPORTED_ECL');
      expect(e.message).toContain('descriptions, not concepts');
    });

    test('a malformed reference set field selection is invalid', async () => {
      expect((await errorFor('^ [] 900000000000526001')).msgId).toBe('INVALID_ECL');
      expect((await errorFor('^ [123] 900000000000526001')).msgId).toBe('INVALID_ECL');
      expect((await errorFor('^ [targetComponentId 900000000000526001')).msgId).toBe('INVALID_ECL');
    });

    test('a non-numeric or unknown concept id is still invalid', async () => {
      expect((await errorFor('<< abc')).msgId).toBe('INVALID_ECL');
      expect((await errorFor('<< 123')).msgId).toBe('INVALID_ECL');
      expect((await errorFor('<< 999999999999')).msgId).toBe('INVALID_ECL');
      expect((await errorFor('< 64572001 : 999999999999 = *')).msgId).toBe('INVALID_ECL');
    });
  });

  describe('ECL 2.x description filters ({{ D ... }})', () => {
    const codes = async (ecl) => ((await snomedServices.filterECL(ecl, true, opContext)).descendants || [])
      .map(i => snomedServices.concepts.getConceptId(i).toString()).sort();
    const count = async (ecl) => (await codes(ecl)).length;

    test('term match: every search word is a prefix of a word in the description', async () => {
      const liver = await count('<< 10200004 {{ D term = "liver" }}');
      expect(liver).toBeGreaterThan(0);
      expect(liver).toBeLessThan(await count('<< 10200004'));
      expect(await count('<< 10200004 {{ D term = "liv" }}')).toBe(liver);
      expect(await count('<< 10200004 {{ D term = "LIVER" }}')).toBe(liver);
      expect(await count('<< 10200004 {{ D term = "lobe liv" }}')).toBe(await count('<< 10200004 {{ D term = "liver lobe" }}'));
      expect(await count('<< 10200004 {{ D term = "lobe liv" }}')).toBeLessThan(liver);
      expect(await codes('<< 10200004 {{ D term = "lobe liv" }}')).toEqual(await codes('<< 10200004 {{ D term = "liver" }} {{ D term = "lobe" }}'));
      expect(await count('<< 10200004 {{ D term = match:"liver" }}')).toBe(liver);
    });

    test('term sets and wild terms', async () => {
      const caudate = await count('<< 10200004 {{ D term = "caudate" }}');
      const quadrate = await count('<< 10200004 {{ D term = "quadrate" }}');
      expect(await count('<< 10200004 {{ D term = ("caudate" "quadrate") }}')).toBeGreaterThanOrEqual(Math.max(caudate, quadrate));
      expect(await count('<< 10200004 {{ D term = ("caudate" "quadrate") }}')).toBeLessThanOrEqual(caudate + quadrate);
      expect(await count('<< 10200004 {{ D term = wild:"*lobe*" }}')).toBeGreaterThanOrEqual(await count('<< 10200004 {{ D term = "lobe" }}'));
      expect(await count('<< 10200004 {{ D term = wild:"Liver structure" }}')).toBe(1);
      expect(await count('<< 10200004 {{ D term = wild:"liver" }}')).toBe(1);
    });

    test('!= keeps concepts with a description that does not match', async () => {
      // "Liver structure" has the synonym "Liver" and the FSN, both matching
      expect(await codes('<< 10200004 {{ D term != "liver" }}')).not.toContain('10200004');
      expect(await count('<< 10200004 {{ D term != "liver" }}')).toBeGreaterThan(0);
    });

    test('type and typeId', async () => {
      const all = await count('<< 10200004');
      expect(await count('<< 10200004 {{ D type = fsn }}')).toBe(all);
      expect(await count('<< 10200004 {{ D typeId = 900000000000003001 }}')).toBe(all);
      expect(await count('<< 10200004 {{ D typeId = << 900000000000446008 }}')).toBe(all);
      expect(await count('<< 10200004 {{ D type = (syn fsn) }}')).toBe(all);
      expect(await count('<< 10200004 {{ D type = def }}')).toBe(0);
      expect(await count('* {{ D type = def }}')).toBeGreaterThan(0);
      // the FSN carries the semantic tag, synonyms do not
      expect(await count('<< 10200004 {{ D type = fsn, term = "body structure" }}')).toBe(all);
      expect(await count('<< 10200004 {{ D type = syn, term = "body structure" }}')).toBe(0);
    });

    test('language', async () => {
      const all = await count('<< 10200004');
      expect(await count('<< 10200004 {{ D language = en }}')).toBe(all);
      expect(await count('<< 10200004 {{ D language = (en fr) }}')).toBe(all);
      expect(await count('<< 10200004 {{ D language = fr }}')).toBe(0);
      expect(await count('<< 10200004 {{ D language != en }}')).toBe(0);
    });

    test('active: only active descriptions are considered unless asked', async () => {
      // "Liver structure" has the inactive synonym "Liver, NOS"
      expect(await codes('<< 10200004 {{ D term = "nos" }}')).not.toContain('10200004');
      expect(await codes('<< 10200004 {{ D term = "nos", active = false }}')).toContain('10200004');
      expect(await count('<< 10200004 {{ D active = true }}')).toBe(await count('<< 10200004'));
    });

    test('dialect and dialectId with acceptability', async () => {
      // the committed jest cache carries the US English language refset only
      const all = await count('<< 10200004');
      expect(await count('<< 10200004 {{ D dialect = en-us }}')).toBe(all);
      expect(await count('<< 10200004 {{ D dialectId = 900000000000509007 }}')).toBe(all);
      expect(await count('<< 10200004 {{ D dialect = en-us (prefer) }}')).toBe(all);
      expect(await count('<< 10200004 {{ D dialect = (en-us (prefer) en-gb (accept)) }}')).toBe(all);
      const acceptableOnly = await count('<< 10200004 {{ D dialectId = 900000000000509007 (acceptable) }}');
      expect(acceptableOnly).toBeLessThan(all);
      expect(await count('<< 10200004 {{ D dialectId = (900000000000509007 (acceptable)) }}')).toBe(acceptableOnly);
      expect(await count('<< 10200004 {{ D dialect = fr-ca }}')).toBe(0);
      const liver = await count('<< 10200004 {{ D term = "liver" }}');
      expect(await count('<< 10200004 {{ D dialect = en-us (prefer), term = "liver" }}')).toBeLessThanOrEqual(liver);
      await expect(snomedServices.filterECL('<< 10200004 {{ D dialect = xx-yy }}', true, opContext)).rejects.toThrow('Unknown dialect alias');
    });

    test('moduleId, effectiveTime and id', async () => {
      const all = await count('<< 10200004');
      expect((await count('<< 10200004 {{ D moduleId = 900000000000207008 }}')) + await count('<< 10200004 {{ D moduleId != 900000000000207008 }}')).toBeGreaterThanOrEqual(all);
      const since = await count('<< 10200004 {{ D effectiveTime >= "20200101" }}');
      expect(since).toBeGreaterThan(0);
      expect(since).toBeLessThan(all);
      const r = snomedServices.concepts.findConcept('10200004');
      const descId = snomedServices.descriptions.getDescription(snomedServices.refs.getReferences(snomedServices.concepts.getConcept(r.index).descriptions)[0]).id;
      expect(await codes(`<< 10200004 {{ D id = ${descId} }}`)).toEqual(['10200004']);
      expect(await count('<< 10200004 {{ D id = 123456789 }}')).toBe(0);
    });

    test('description filters combine with concept filters and refinements', async () => {
      const lobe = await count('<< 10200004 {{ D term = "lobe" }}');
      expect(await count('<< 10200004 {{ C definitionStatus = primitive }} {{ D term = "lobe" }}')).toBeLessThanOrEqual(lobe);
      expect(await count('< 64572001 : 363698007 = (<< 10200004 {{ D term = "lobe" }})')).toBeLessThanOrEqual(await count('< 64572001 : 363698007 = << 10200004'));
    });

    test('an unknown description filter field is a syntax error', async () => {
      await expect(snomedServices.filterECL('< 64572001 {{ D foo = 1 }}', true, opContext)).rejects.toThrow('Unknown description filter field');
    });

    // ECL 2.2 makes the D optional: {{ term = ... }} is a description filter (S7)
    test('the D is optional', async () => {
      for (const body of ['term = "lobe liv"', 'term = wild:"*lobe*"', 'typeId = 900000000000003001 |Fully specified name|, term = "body structure"',
        'language = en', 'term = ("caudate" "quadrate")', 'active = true']) {
        const withD = await codes(`<< 10200004 {{ D ${body} }}`);
        expect(withD.length).toBeGreaterThan(0);
        expect(await codes(`<< 10200004 {{ ${body} }}`)).toEqual(withD);
        expect(await codes(`<< 10200004 {{ d ${body} }}`)).toEqual(withD);
      }
      expect(await codes('<< 10200004 {{ term = "liver" }} {{ term = "lobe" }}')).toEqual(await codes('<< 10200004 {{ D term = "liver" }} {{ D term = "lobe" }}'));
      // an unknown field is still an error, and so is anything that is not a field name
      await expect(snomedServices.filterECL('< 64572001 {{ foo = 1 }}', true, opContext)).rejects.toThrow('Unknown description filter field');
      await expect(snomedServices.filterECL('< 64572001 {{ 123 }}', true, opContext)).rejects.toThrow('Expected M, D, C, + or a description filter after {{');
    });
  });

  describe('ECL != and reversed (R) attributes', () => {
    const codes = async (ecl) => ((await snomedServices.filterECL(ecl, true, opContext)).descendants || [])
      .map(i => snomedServices.concepts.getConceptId(i).toString()).sort();
    const count = async (ecl) => (await codes(ecl)).length;

    test('!= matches concepts with an attribute value outside the set', async () => {
      // the medicinal products: precise active ingredient is halibut liver oil or barium sulfate
      expect(await codes('< 763158003 : 762949000 != 126081001')).toEqual(['1204474000']);
      expect(await codes('* : 762949000 != 126081001')).toEqual(['1204474000']);
      // products with no precise active ingredient do not match
      expect(await count('< 763158003 : 127489000 != 126081001')).toBe(0);
      // [0..0] != : every value is in the set (or there is no attribute)
      expect(await count('< 763158003 : [0..0] 762949000 != < 105590001')).toBe(await count('< 763158003'));
      expect(await codes('< 763158003 : [0..0] 762949000 != 396014007')).not.toContain('329238006');
      expect(await codes('< 763158003 : [0..0] 762949000 != 396014007')).toContain('1204474000');
    });

    test('R yields the values of an attribute on the given concepts', async () => {
      expect(await codes('< 105590001 : R 127489000 = 776168003')).toEqual(['126081001']);
      expect(await codes('< 105590001 : R * = 329238006')).toEqual(['126081001']);
      expect(await codes('< 105590001 : R 762949000 = *')).toEqual(['126081001', '396014007']);
      expect(await codes('< 105590001 : R 762949000 = < 763158003')).toEqual(['126081001', '396014007']);
      expect(await count('< 105590001 : [0..*] R 127489000 = 776168003')).toBe(await count('< 105590001'));
      expect(await count('<< 105590001 : R 363698007 = *')).toBe(0);
    });

    test('a comma is a conjunction at the expression level', async () => {
      expect(await codes('138875005 , 138875005')).toEqual(['138875005']);
      expect(await count('138875005 , 10200004')).toBe(0);
      expect(await codes('< 64572001 , < 64572001 , 64572001')).toEqual([]);
      await expect(snomedServices.filterECL('< 64572001 , < 10200004 OR < 39607008', true, opContext)).rejects.toThrow('cannot be mixed');
    });

    test('an attribute without a comparison is a syntax error', async () => {
      for (const ecl of ['< 64572001 : 363698007', '(< 64572001 : 363698007 = 10200004 OR 404684003)']) {
        let e = null;
        try { await snomedServices.filterECL(ecl, true, opContext); } catch (x) { e = x; }
        expect(e).not.toBeNull();
        expect(e.msgId).toBe('INVALID_ECL');
        expect(e.message).toContain('comparison operator');
      }
    });
  });

  describe('ECL history supplements and concrete values (test edition cache)', () => {
    const codes = async (ecl) => ((await snomedServices.filterECL(ecl, true, opContext)).descendants || [])
      .map(i => snomedServices.concepts.getConceptId(i).toString()).sort();

    test('history supplements add the inactive concepts associated with the result', async () => {
      expect(await codes('<< 74400008 {{ + HISTORY }}')).toEqual(['307530000', '74400008']);
      expect(await codes('<< 74400008 {{ + HISTORY-MAX }}')).toEqual(['307530000', '74400008']);
      expect(await codes('<< 74400008 {{ + HISTORY-MOD }}')).toEqual(['307530000', '74400008']);
      expect(await codes('<< 74400008 {{ + HISTORY-MIN }}')).toEqual(['74400008']); // no SAME AS refset in the edition
      expect(await codes('<< 4896000 {{ + HISTORY (900000000000526001) }}')).toEqual((await codes('<< 4896000')).concat(['1000381000003107']).sort());
      expect(await codes('<< 4896000 {{ + HISTORY (*) }}')).toEqual(await codes('<< 4896000 {{ + HISTORY }}'));
      expect(await codes('(74400008 OR 4896000) {{ + HISTORY }}')).toEqual(['1000381000003107', '307530000', '4896000', '74400008']);
      expect((await codes('< 64572001 {{ + HISTORY }}')).length).toBe((await codes('< 64572001')).length + 2);
    });

    test('concrete values: numeric comparisons', async () => {
      expect(await codes('< 763158003 : 1142139005 = #1')).toEqual(['1204474000', '329238006', '776168003', '779430005']);
      expect(await codes('< 763158003 : 1142139005 = #1.0')).toEqual(await codes('< 763158003 : 1142139005 = #1'));
      expect(await codes('< 763158003 : 1142135004 = #4000')).toEqual(['329238006']);
      expect(await codes('< 763158003 : 1142139005 != #1')).toEqual([]);
      expect(await codes('< 763158003 : 1142138002 < #1000')).toEqual(['1204474000']);
      expect(await codes('< 763158003 : 1142135004 <= #4000')).toEqual(['329238006']);
      expect(await codes('< 763158003 : 1142135004 > #1000')).toEqual(['329238006']);
      expect(await codes('< 763158003 : 1142138002 >= #600')).toEqual(['1204474000']);
      expect(await codes('< 763158003 : 1142139005 = #-1')).toEqual([]);
      expect(await codes('< 763158003 : [0..0] 1142139005 = #1')).toEqual(['406459008', '769034009']);
      expect(await codes('< 763158003 : { 1142135004 = #4000 }')).toEqual(['329238006']);
      expect(await codes('< 763158003 : * = #4000')).toEqual(['329238006']);
      expect(await codes('< 763158003 : 1142139005 = #1 AND 1142135004 = #4000')).toEqual(['329238006']);
    });

    test('concrete values: a value of another kind never matches', async () => {
      expect(await codes('< 763158003 : 1142139005 = "x"')).toEqual([]);
      expect(await codes('< 763158003 : 1142139005 != "x"')).toEqual([]);
      expect(await codes('< 763158003 : 1142139005 = true')).toEqual([]);
    });

    test('alternate identifiers resolve through the identifier scheme alias', async () => {
      expect(await codes('LOINC#14394-1')).toEqual(['63241010000109']);
      expect(await codes('"LOINC#14394-1"')).toEqual(['63241010000109']);
      expect(await codes('loinc#14394-1 |Urea nitrogen|')).toEqual(['63241010000109']);
      expect(await codes('>> LOINC#14394-1')).toEqual(await codes('>> 63241010000109'));
      expect(await codes('(LOINC#14394-1 OR LOINC#2067-7)')).toEqual(['57371010000105', '63241010000109']);
      let e = null;
      try { await snomedServices.filterECL('LOINC#99999-9', true, opContext); } catch (x) { e = x; }
      expect(e.msgId).toBe('INVALID_ECL');
      expect(e.message).toContain('No concept has the alternate identifier');
    });
  });

  describe('ECL refinement conjunction and disjunction', () => {
    const count = async (ecl) => ((await snomedServices.filterECL(ecl, true, opContext)).descendants || []).length;

    test('AND, "," and OR between attributes', async () => {
      const site = await count('< 64572001 : 363698007 = << 39607008');
      const morph = await count('< 64572001 : 116676008 = << 442021009');
      const both = await count('< 64572001 : 363698007 = << 39607008, 116676008 = << 442021009');
      expect(await count('< 64572001 : 363698007 = << 39607008 AND 116676008 = << 442021009')).toBe(both);
      expect(await count('< 64572001 : 363698007 = << 39607008 OR 116676008 = << 442021009')).toBe(site + morph - both);
    });

    test('bracketed sub refinements', async () => {
      const liver = await count('< 64572001 : 363698007 = << 10200004');
      expect(await count('< 64572001 : (363698007 = << 39607008 AND 116676008 = << 442021009) OR 363698007 = << 10200004'))
        .toBeGreaterThanOrEqual(liver);
    });

    test('AND / OR between and within attribute groups', async () => {
      const lung = await count('< 64572001 : { 363698007 = << 39607008 }');
      const liver = await count('< 64572001 : { 363698007 = << 10200004 }');
      const both = await count('< 64572001 : { 363698007 = << 39607008 } AND { 363698007 = << 10200004 }');
      expect(lung).toBeGreaterThan(0);
      expect(liver).toBeGreaterThan(0);
      expect(await count('< 64572001 : { 363698007 = << 39607008 } OR { 363698007 = << 10200004 }')).toBe(lung + liver - both);
      expect(await count('< 64572001 : { 363698007 = << 39607008 OR 363698007 = << 10200004 }')).toBe(lung + liver - both);
    });

    test('AND and OR may not be mixed without brackets', async () => {
      await expect(snomedServices.filterECL('< 64572001 : 363698007 = << 39607008, 116676008 = * OR 363698007 = << 10200004', true, opContext))
        .rejects.toThrow('cannot be mixed');
    });
  });

  describe('ECL 2.x concept filters ({{ C ... }})', () => {
    const count = async (ecl) => ((await snomedServices.filterECL(ecl, true, opContext)).descendants || []).length;

    test('active partitions the result', async () => {
      const all = await count('*');
      expect((await count('* {{ C active = true }}')) + await count('* {{ C active = false }}')).toBe(all);
      expect(await count('* {{ C active = false }}')).toBeGreaterThan(0);
      expect(await count('< 64572001 {{ C active = false }}')).toBe(0);
    });

    test('definitionStatus and definitionStatusId agree and partition the result', async () => {
      const all = await count('< 64572001');
      const prim = await count('< 64572001 {{ C definitionStatus = primitive }}');
      const def = await count('< 64572001 {{ C definitionStatus = defined }}');
      expect(prim + def).toBe(all);
      expect(all).toBeGreaterThan(0);
      expect(await count('< 64572001 {{ C definitionStatus = (primitive defined) }}')).toBe(all);
      expect(await count('< 64572001 {{ C definitionStatusId = 900000000000074008 }}')).toBe(prim);
      expect(await count('< 64572001 {{ C definitionStatusId != 900000000000074008 }}')).toBe(def);
    });

    test('moduleId with a concept, a reference set and an expression', async () => {
      // the test edition's modules have no is-a relationships to 900000000000443000 |Module|,
      // so the expression is one the core module is in itself
      const all = await count('< 64572001');
      const core = await count('< 64572001 {{ C moduleId = 900000000000207008 }}');
      expect(core).toBeGreaterThan(0);
      expect(await count('< 64572001 {{ C moduleId != 900000000000207008 }}')).toBe(all - core);
      expect(await count('< 64572001 {{ C moduleId = (900000000000207008 900000000000012004) }}')).toBe(core);
      expect(await count('< 64572001 {{ C moduleId = << 900000000000207008 }}')).toBe(core);
      expect(await count('< 64572001 {{ C moduleId = * }}')).toBe(all);
    });

    test('effectiveTime partitions the result', async () => {
      const all = await count('< 64572001');
      const since = await count('< 64572001 {{ C effectiveTime >= "20200101" }}');
      expect(since).toBeGreaterThan(0);
      expect(since).toBeLessThan(all);
      expect(await count('< 64572001 {{ C effectiveTime < "20200101" }}')).toBe(all - since);
    });

    test('several filters AND together', async () => {
      const def = await count('< 64572001 {{ C definitionStatus = defined }}');
      const both = await count('< 64572001 {{ C effectiveTime >= "20200101", definitionStatus = defined }} {{ C active = true }}');
      expect(both).toBeGreaterThan(0);
      expect(both).toBeLessThan(def);
    });

    test('a concept filter after a member filter', async () => {
      expect(await count('^ 900000000000526001 {{ M effectiveTime >= "20240101" }} {{ C active = false }}')).toBe(2);
      expect(await count('^ 900000000000526001 {{ M effectiveTime >= "20240101" }} {{ C active = true }}')).toBe(0);
    });

    test('an unknown concept filter field is a syntax error', async () => {
      await expect(snomedServices.filterECL('< 64572001 {{ C foo = 1 }}', true, opContext)).rejects.toThrow('Unknown concept filter field');
    });
  });

  describe('ECL cardinality counts per-group occurrences (SNOMED CLG ruling)', () => {
    const expandCodes = async (ecl) => {
      const ctx = await snomedServices.filterECL(ecl, true, opContext);
      return new Set((ctx.descendants || []).map(i => snomedServices.concepts.getConceptId(i).toString()));
    };

    // 192008 states Associated morphology 442021009 in TWO different role groups.
    // ECL cardinality counts occurrences per role group (confirmed by the SNOMED
    // Computable Languages Group), so that is TWO matching attributes: it must
    // satisfy [2..*] and [1..*], and must NOT satisfy [1..1]. (Previously we
    // counted distinct values and asserted the opposite — issue #230 bug 3.)
    test('a morphology stated in two role groups satisfies [2..*]/[1..*], not [1..1]', async () => {
      const one = await expandCodes('* : [1..1] 116676008 = *');
      const atLeastOne = await expandCodes('* : [1..*] 116676008 = *');
      const two = await expandCodes('* : [2..*] 116676008 = *');
      expect(one.has('192008')).toBe(false);
      expect(atLeastOne.has('192008')).toBe(true);
      expect(two.has('192008')).toBe(true);
    });

    test('[1..1] and [2..*] partition [1..*] (occurrence counting is consistent)', async () => {
      const one = await expandCodes('* : [1..1] 116676008 = *');
      const two = await expandCodes('* : [2..*] 116676008 = *');
      const atLeastOne = await expandCodes('* : [1..*] 116676008 = *');
      expect(one.size + two.size).toBe(atLeastOne.size);
      for (const c of one) {
        expect(two.has(c)).toBe(false);
      }
    });

    // Value-constrained form, matching the external case
    // `< 64572001 : [1..1] 363698007 = << 10200004` (573, not 653). 192008 states
    // Associated morphology 442021009 in two role groups = two occurrences, so it
    // satisfies [2..*] (not [1..1]) for that specific value.
    test('value-constrained [1..1] excludes a concept stating one value in two groups', async () => {
      const one = await expandCodes('* : [1..1] 116676008 = 442021009');
      const atLeastOne = await expandCodes('* : [1..*] 116676008 = 442021009');
      const two = await expandCodes('* : [2..*] 116676008 = 442021009');
      expect(one.has('192008')).toBe(false);
      expect(atLeastOne.has('192008')).toBe(true);
      expect(two.has('192008')).toBe(true);
    });
  });

  describe('ECL memberOf (issue #230 bugs 1 & 2)', () => {
    const expand = async (ecl) => {
      const ctx = await snomedServices.filterECL(ecl, true, opContext);
      return ctx.descendants || [];
    };
    const codesOf = async (ecl) => (await expand(ecl)).map(i => snomedServices.concepts.getConceptId(i).toString());

    // ^<concept that is not a reference set> yields an EMPTY result (a non-refset
    // concept simply has no members) rather than an error. Aligns with Snowstorm
    // and the HL7 tx-ecosystem test suite (PR #49); previously a bare non-refset
    // operand was rejected with "is not a reference set".
    test('bare ^<non-reference-set> yields an empty result (not an error)', async () => {
      let ctx;
      ctx = await snomedServices.filterECL('^404684003', true, opContext);
      expect(ctx.descendants || []).toHaveLength(0);
    });

    // Bug 1: returns the refset's referenced-component concepts, including
    // concepts that are themselves inactive (active refers to the membership row,
    // not the referenced concept). 900000000000526001 (an association refset)
    // has one member: the inactive concept 307530000.
    test('memberOf returns referenced concepts, including inactive ones', async () => {
      const codes = await codesOf('^900000000000526001');
      expect(codes).toContain('307530000');
      const idx = (await expand('^900000000000526001')).find(
        i => snomedServices.concepts.getConceptId(i).toString() === '307530000');
      expect(snomedServices.isActive(idx)).toBe(false); // inactive concept, still returned
    });

    // Bug 1: never fabricate the 0xFFFFFFFF (4294967295) sentinel, and never
    // return the operand concept itself.
    test('memberOf never emits the sentinel or the operand itself', async () => {
      const codes = await codesOf('^900000000000526001');
      expect(codes).not.toContain('4294967295');
      expect(codes).not.toContain('900000000000526001');
    });

    // Bug 2: a wrapped/computed operand must be evaluated, not rejected as
    // "non-concept-reference refset is not yet supported".
    test('wrapped memberOf operands are evaluated, not rejected as unsupported', async () => {
      await expect(snomedServices.filterECL('^(<<192008)', true, opContext)).resolves.not.toThrow();
      await expect(snomedServices.filterECL('^(404684003)', true, opContext)).resolves.not.toThrow();
      // computed operand is lenient: non-refset concepts in the set are skipped
      expect(Array.isArray(await codesOf('^(404684003)'))).toBe(true);
    });
  });

  describe('ECL Lexer Tests', () => {

    test('should tokenize simple concept reference', async () => {
      const lexer = new ECLLexer('404684003 |Clinical finding|');
      const tokens = lexer.tokenize();

      expect(tokens).toHaveLength(3); // SCTID, TERM, PIPE, EOF
      expect(tokens[0]).toMatchObject({
        type: ECLTokenType.SCTID,
        value: '404684003'
      });
      expect(tokens[1]).toMatchObject({
        type: ECLTokenType.TERM,
        value: 'Clinical finding'
      });
    });

    test('should tokenize constraint operators', async () => {
      const operators = [
        { input: '<', expected: ECLTokenType.DESCENDANT_OF },
        { input: '<!', expected: ECLTokenType.CHILD_OF },
        { input: '<<', expected: ECLTokenType.DESCENDANT_OR_SELF_OF },
        { input: '<<!', expected: ECLTokenType.CHILD_OR_SELF_OF },
        { input: '>', expected: ECLTokenType.ANCESTOR_OF },
        { input: '>>', expected: ECLTokenType.ANCESTOR_OR_SELF_OF },
        { input: '>!', expected: ECLTokenType.PARENT_OF },
        { input: '>>!', expected: ECLTokenType.PARENT_OR_SELF_OF }
      ];

      operators.forEach(({ input, expected }) => {
        const lexer = new ECLLexer(input);
        const tokens = lexer.tokenize();
        expect(tokens[0].type).toBe(expected);
        expect(tokens[0].value).toBe(input);
      });
    });

    test('should tokenize boolean operators and keywords', async () => {
      const lexer = new ECLLexer('AND OR MINUS R');
      const tokens = lexer.tokenize();

      expect(tokens[0].type).toBe(ECLTokenType.AND);
      expect(tokens[1].type).toBe(ECLTokenType.OR);
      expect(tokens[2].type).toBe(ECLTokenType.MINUS);
      expect(tokens[3].type).toBe(ECLTokenType.REVERSE);
    });

    test('should tokenize special characters and punctuation', async () => {
      const lexer = new ECLLexer('(){}[],:=!=<><=>=^*.');
      const tokens = lexer.tokenize();

      const expectedTypes = [
        ECLTokenType.LPAREN,
        ECLTokenType.RPAREN,
        ECLTokenType.LBRACE,
        ECLTokenType.RBRACE,
        ECLTokenType.LBRACKET,
        ECLTokenType.RBRACKET,
        ECLTokenType.COMMA,
        ECLTokenType.COLON,
        ECLTokenType.EQUALS,
        ECLTokenType.NOT_EQUALS,
        ECLTokenType.DESCENDANT_OF,
        ECLTokenType.ANCESTOR_OF,
        ECLTokenType.LTE,
        ECLTokenType.GTE,
        ECLTokenType.MEMBER_OF,
        ECLTokenType.WILDCARD,
        ECLTokenType.DOT,
        ECLTokenType.EOF
      ];

      tokens.forEach((token, index) => {
        if (index < expectedTypes.length - 1) { // Exclude EOF from detailed check
          expect(token.type).toBe(expectedTypes[index]);
        }
      });

      expect(tokens[tokens.length - 1].type).toBe(ECLTokenType.EOF);
    });

    test('should handle numeric literals correctly', async () => {
      const lexer = new ECLLexer('123 -456 78.9 -12.34');
      const tokens = lexer.tokenize();

      // With Option 1: all positive digit sequences are treated as SCTIDs
      expect(tokens[0]).toMatchObject({
        type: ECLTokenType.SCTID,
        value: '123'
      });
      // Negative numbers still use the number parsing logic
      expect(tokens[1]).toMatchObject({
        type: ECLTokenType.INTEGER,
        value: '-456'
      });
      // Decimal sequences parsed as SCTID (will be validated semantically)
      expect(tokens[2]).toMatchObject({
        type: ECLTokenType.DECIMAL,
        value: '78.9'
      });
      // Negative decimal
      expect(tokens[3]).toMatchObject({
        type: ECLTokenType.DECIMAL,
        value: '-12.34'
      });
    });

    test('should handle string literals with escaping', async () => {
      const lexer = new ECLLexer('"simple string" "string with \\"quotes\\"" \'single quotes\'');
      const tokens = lexer.tokenize();

      expect(tokens[0]).toMatchObject({
        type: ECLTokenType.STRING,
        value: 'simple string'
      });
      expect(tokens[1]).toMatchObject({
        type: ECLTokenType.STRING,
        value: 'string with "quotes"'
      });
      expect(tokens[2]).toMatchObject({
        type: ECLTokenType.STRING,
        value: 'single quotes'
      });
    });

    test('should handle whitespace correctly', async () => {
      const lexer = new ECLLexer('  \t\n<< \r\n 404684003  \t');
      const tokens = lexer.tokenize();

      expect(tokens).toHaveLength(3); // <<, SCTID, EOF (whitespace ignored)
      expect(tokens[0].type).toBe(ECLTokenType.DESCENDANT_OR_SELF_OF);
      expect(tokens[1].type).toBe(ECLTokenType.SCTID);
    });

    test('should throw error on invalid characters', async () => {
      const lexer = new ECLLexer('404684003 @ invalid');
      expect(() => lexer.tokenize()).toThrow('Unexpected character');
    });

    test('should throw error on unterminated string', async () => {
      const lexer = new ECLLexer('"unterminated string');
      expect(() => lexer.tokenize()).toThrow('Unterminated string');
    });

    test('should throw error on unterminated term', async () => {
      const lexer = new ECLLexer('|unterminated term');
      expect(() => lexer.tokenize()).toThrow('Unterminated term');
    });
  });

  describe('ECL Parser Tests', () => {

    test('should parse simple concept reference', async () => {
      const result = eclValidator.parse('404684003 |Clinical finding|');

      expect(result.success).toBe(true);
      expect(result.ast.type).toBe(ECLNodeType.SUB_EXPRESSION_CONSTRAINT);
      expect(result.ast.focus.type).toBe(ECLNodeType.CONCEPT_REFERENCE);
      expect(result.ast.focus.conceptId).toBe('404684003');
      expect(result.ast.focus.term).toBe('Clinical finding');
    });

    test('should parse wildcard', async () => {
      const result = eclValidator.parse('*');

      expect(result.success).toBe(true);
      expect(result.ast.focus.type).toBe(ECLNodeType.WILDCARD);
    });

    test('should parse constraint operators', async () => {
      const testCases = [
        {
          input: '< 404684003 |Clinical finding|',
          operator: ECLTokenType.DESCENDANT_OF
        },
        {
          input: '<< 404684003 |Clinical finding|',
          operator: ECLTokenType.DESCENDANT_OR_SELF_OF
        },
        {
          input: '<! 404684003 |Clinical finding|',
          operator: ECLTokenType.CHILD_OF
        },
        {
          input: '<<! 404684003 |Clinical finding|',
          operator: ECLTokenType.CHILD_OR_SELF_OF
        }
      ];

      testCases.forEach(({ input, operator }) => {
        const result = eclValidator.parse(input);
        expect(result.success).toBe(true);
        expect(result.ast.operator).toBe(operator);
        expect(result.ast.focus.conceptId).toBe('404684003');
      });
    });

    test('should parse compound expressions with boolean operators', async () => {
      const testCases = [
        {
          input: '404684003 |Clinical finding| AND 11687002 |Gestational diabetes mellitus|',
          operator: ECLNodeType.CONJUNCTION
        },
        {
          input: '404684003 |Clinical finding| OR 11687002 |Gestational diabetes mellitus|',
          operator: ECLNodeType.DISJUNCTION
        },
        {
          input: '404684003 |Clinical finding| MINUS 11687002 |Gestational diabetes mellitus|',
          operator: ECLNodeType.EXCLUSION
        }
      ];

      testCases.forEach(({ input, operator }) => {
        const result = eclValidator.parse(input);
        expect(result.success).toBe(true);
        expect(result.ast.type).toBe(ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT);
        expect(result.ast.operator).toBe(operator);
      });
    });

    test('should parse refinement expressions', async () => {
      const result = eclValidator.parse(
        '<< 404684003 |Clinical finding|: 363698007 |Finding site| = << 39057004 |Pulmonary valve structure|'
      );

      expect(result.success).toBe(true);
      expect(result.ast.type).toBe(ECLNodeType.REFINED_EXPRESSION_CONSTRAINT);
      expect(result.ast.base.operator).toBe(ECLTokenType.DESCENDANT_OR_SELF_OF);
      expect(result.ast.refinement.type).toBe(ECLNodeType.ATTRIBUTE);
    });

    test('should parse attribute groups', async () => {
      const result = eclValidator.parse(
        '<< 404684003 |Clinical finding|: {363698007 |Finding site| = << 39057004 |Pulmonary valve structure|, 116676008 |Associated morphology| = << 415582006 |Stenosis|}'
      );

      expect(result.success).toBe(true);
      expect(result.ast.refinement.type).toBe(ECLNodeType.ATTRIBUTE_GROUP);
      expect(result.ast.refinement.attributes).toHaveLength(2);
    });

    test('should parse cardinality constraints', async () => {
      const result = eclValidator.parse(
        '<< 404684003 |Clinical finding|: [1..3] 363698007 |Finding site| = << 39057004 |Pulmonary valve structure|'
      );

      expect(result.success).toBe(true);
      expect(result.ast.refinement.cardinality.min).toBe(1);
      expect(result.ast.refinement.cardinality.max).toBe(3);
    });

    test('should parse dotted expressions', async () => {
      const result = eclValidator.parse(
        '<< 404684003 |Clinical finding|.363698007 |Finding site|'
      );

      expect(result.success).toBe(true);
      expect(result.ast.type).toBe(ECLNodeType.DOTTED_EXPRESSION_CONSTRAINT);
      expect(result.ast.attributes).toHaveLength(1);
    });

    test('should parse member of expressions', async () => {
      const result = eclValidator.parse(
        '^ 192008 |Congenital syphilitic hepatomegaly|'
      );

      expect(result.success).toBe(true);
      expect(result.ast.focus.type).toBe(ECLNodeType.MEMBER_OF);
    });

    test('should parse parenthesized expressions', async () => {
      const result = eclValidator.parse(
        '(<< 404684003 |Clinical finding| AND << 11687002 |Gestational diabetes mellitus|)'
      );

      expect(result.success).toBe(true);
      expect(result.ast.type).toBe(ECLNodeType.SUB_EXPRESSION_CONSTRAINT);
    });

    test('should handle parser errors gracefully', async () => {
      const invalidExpressions = [
        '< <',  // Invalid syntax
        '404684003 |',  // Unterminated term
        ': 363698007',  // Missing base expression
        '404684003 AND',  // Incomplete boolean expression
        '{363698007 =',  // Incomplete attribute group
      ];

      invalidExpressions.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('error');
      });
    });
  });

  describe('Official ECL Specification Examples', () => {

    test('Simple Expression Constraints', async () => {
      const examples = [
        '404684003 |Clinical finding|',
        '*',
        '< 404684003 |Clinical finding|',
        '<< 11687002 |Gestational diabetes mellitus|',
        '<! 404684003 |Clinical finding|',
        '<<!11687002 |Gestational diabetes mellitus|',
        '> 371067004 |Hepatopulmonary syndrome|',
        '>> 371067004 |Hepatopulmonary syndrome|',
        '>! 371067004 |Hepatopulmonary syndrome|',
        '>>! 371067004 |Hepatopulmonary syndrome|',
        '^ 192008 |Congenital syphilitic hepatomegaly|'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(true);
      });
    });

    test('Compound Expression Constraints', async () => {
      const examples = [
        '<< 362965005 |Disorder of body system| AND << 302292003 |Finding of trunk structure|',
        '<< 362965005 |Disorder of body system| OR << 302292003 |Finding of trunk structure|',
        '<< 362965005 |Disorder of body system| MINUS << 302292003 |Finding of trunk structure|',
        '<< 404684003 |Clinical finding| AND ^ 192008 |Congenital syphilitic hepatomegaly|'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(true);
      });
    });

    test('Refined Expression Constraints', async () => {
      const examples = [
        '<< 404684003 |Clinical finding|: 363698007 |Finding site| = << 39057004 |Pulmonary valve structure|',
        '<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = << 415582006 |Stenosis|',
        '<< 404684003 |Clinical finding|: 363698007 |Finding site| = << 39057004 |Pulmonary valve structure|, 116676008 |Associated morphology| = << 415582006 |Stenosis|',
        '<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = (<< 19921004 |Crushing injury| OR << 50960005 |Hemorrhage|)',
        '<< 404684003 |Clinical finding|: 47429007 |Associated with| = (<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = << 55641003 |Infarct|)'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(true);
      });
    });

    test('Attribute Groups', async () => {
      const examples = [
        '<< 404684003 |Clinical finding|: {363698007 |Finding site| = << 39057004 |Pulmonary valve structure|, 116676008 |Associated morphology| = << 415582006 |Stenosis|}',
        '<< 404684003 |Clinical finding|: {363698007 |Finding site| = << 39057004 |Pulmonary valve structure|, 116676008 |Associated morphology| = << 415582006 |Stenosis|}, {363698007 |Finding site| = << 73829009 |Right atrial structure|, 116676008 |Associated morphology| = << 56246009 |Hypertrophy|}'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(true);
      });
    });

    test('Cardinality Constraints', async () => {
      const examples = [
        '<< 373873005 |Pharmaceutical / biologic product|: [1..3] 127489000 |Has active ingredient| = << 105590001 |Substance|',
        '<< 373873005 |Pharmaceutical / biologic product|: [1..*] 127489000 |Has active ingredient| = << 105590001 |Substance|',
        '<< 373873005 |Pharmaceutical / biologic product|: [0..1] 127489000 |Has active ingredient| = << 105590001 |Substance|'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(true);
      });
    });

    test('Dotted Expression Constraints', async () => {
      const examples = [
        '<< 72704001 |Fracture|.363698007 |Finding site|',
        '<< 404684003 |Clinical finding|.363698007 |Finding site|.272741003 |Laterality|'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(true);
      });
    });

    test('Numeric Value Constraints', async () => {
      const examples = [
        '<< 406459008 |Halibut liver oil product|: 411116001 |Has manufactured dose form| = << 420692007 |Conventional release oral capsule|, {732943007 |Has basis of strength substance| = (776168003 |Product containing only halibut liver oil (medicinal product)|: 732943007 |Has basis of strength substance| >= #500, 767525000 |Unit| = 258684004 |mg|)}'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('Real-world Clinical Examples', () => {

    test('Clinical Finding Hierarchy Examples', async () => {
      const examples = [
        // Basic clinical findings
        '<< 404684003 |Clinical finding|',
        '<< 243796009 |Situation with explicit context|',
        '<< 272379006 |Event|',

        // Specific conditions
        '<< 11687002 |Gestational diabetes mellitus|',
        '<< 72704001 |Fracture|',
        '<< 362965005 |Disorder of body system|',

        // Complex conditions with refinements
        '<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = << 72704001 |Fracture|',
        '<< 404684003 |Clinical finding|: 363698007 |Finding site| = << 23416004 |Bone structure of ulna|'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(true);
      });
    });

    test('Pharmaceutical Product Examples', async () => {
      const examples = [
        '<< 373873005 |Pharmaceutical / biologic product|',
        '<< 373873005 |Pharmaceutical / biologic product|: 127489000 |Has active ingredient| = << 406459008 |Halibut liver oil product|',
        '<< 373873005 |Pharmaceutical / biologic product|: [1..3] 127489000 |Has active ingredient| = << 105590001 |Substance|'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(true);
      });
    });

    test('Complex Boolean Combinations', async () => {
      const examples = [
        // Lung disorders with edema
        '<< 362965005 |Disorder of body system| AND << 302292003 |Finding of trunk structure|',

        // Findings with Acute inflammation or hemorrhage morphology
        '<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = (<< 4532008 |Acute inflammation| OR << 50960005 |Hemorrhage|)',

        // Lung disorders excluding those in cardiology refset
        '<< 362965005 |Disorder of body system| MINUS ^ 192008 |Congenital syphilitic hepatomegaly|',

        // Complex nested expressions
        '(<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = << 4532008 |Acute inflammation|) AND (<< 404684003 |Clinical finding|: 363698007 |Finding site| = << 23416004 |Bone structure of ulna|)'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(true);
      });
    });

    test('Reference Set Examples', async () => {
      const examples = [
        '^ 192008 |Congenital syphilitic hepatomegaly|',
        '^ 900000000000509007 |United States of America English language reference set|',
        '^(<< 900000000000526001 |REPLACED BY association reference set|)'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(true);
      });
    });
  });

  describe('Edge Cases and Error Handling', () => {

    test('should handle empty input', async () => {
      const result = eclValidator.parse('');
      expect(result.success).toBe(false);
    });

    test('should handle whitespace-only input', async () => {
      const result = eclValidator.parse('   \t\n   ');
      expect(result.success).toBe(false);
    });

    test('should handle malformed expressions', async () => {
      const malformedExpressions = [
        '< <',
        '404684003 |',
        ': 363698007',
        '404684003 AND',
        '{363698007 =',
        '404684003 |Clinical finding| :',
        '<< AND >>',
        '^ ^ 192008',
        '404684003 |Clinical finding| |'
      ];

      malformedExpressions.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      });
    });

    test('should handle nested parentheses correctly', async () => {
      const examples = [
        '(404684003 |Clinical finding|)',
        '((404684003 |Clinical finding|))',
        '(<< 404684003 |Clinical finding| AND (<< 11687002 |Gestational diabetes mellitus| OR << 72704001 |Fracture|))'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(true);
      });
    });

    test('should handle complex cardinality expressions', async () => {
      const examples = [
        '[*] 127489000 |Has active ingredient|',
        '[0..*] 127489000 |Has active ingredient|',
        '[1..1] 127489000 |Has active ingredient|',
        '[5..10] 127489000 |Has active ingredient|'
      ];

      examples.forEach(cardinalityExpr => {
        const fullExpr = `<< 373873005 |Pharmaceutical / biologic product|: ${cardinalityExpr} = << 105590001 |Substance|`;
        const result = eclValidator.parse(fullExpr);
        expect(result.success).toBe(true);
      });
    });

    test('should handle reverse flag correctly', async () => {
      const examples = [
        '<< 404684003 |Clinical finding|: R 363698007 |Finding site| = << 39057004 |Pulmonary valve structure|'
      ];

      examples.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(true);
        expect(result.ast.refinement.reverse).toBe(true);
      });
    });
  });

  describe('Semantic Validation Tests', () => {

    test('should validate concept existence for valid concepts', async () => {
      // These tests will depend on what concepts are in the test cache
      const potentiallyValidConcepts = [
        '404684003 |Clinical finding|',
        '138875005 |SNOMED CT Concept|',
        '11687002 |Gestational diabetes mellitus|'
      ];

      potentiallyValidConcepts.forEach(expr => {
        const result = eclValidator.parse(expr);
        // We expect parsing to succeed, semantic validation may or may not
        expect(result.success || result.errors.some(e => e.includes('not found'))).toBe(true);
      });
    });

    test('should reject invalid concept IDs', async () => {
      const invalidConcepts = [
        'abc123 |Invalid concept|',
        '99999999999999999 |Non-existent concept|',
        '0 |Zero concept|'
      ];

      invalidConcepts.forEach(expr => {
        const result = eclValidator.parse(expr);
        if (result.success) {
          // If parsing succeeds, semantic validation should catch it
          expect(result.errors.length).toBeGreaterThan(0);
        }
      });
    });

    test('should validate syntax without semantic checks', async () => {
      const result = eclValidator.validateSyntax('<< 999999999 |Non-existent concept|');
      expect(result.success).toBe(true); // Syntax is valid
    });
  });

  describe('Performance Tests', () => {

    test('should parse simple expressions quickly', async () => {
      const start = Date.now();

      for (let i = 0; i < 1000; i++) {
        eclValidator.parse('<< 404684003 |Clinical finding|');
      }

      const duration = Date.now() - start;
      expect(duration).toBeLessThan(1000); // Should complete 1000 parses in under 1 second
    });

    test('should parse complex expressions in reasonable time', async () => {
      const complexExpression = `
        (<< 404684003 |Clinical finding|: 
          {363698007 |Finding site| = << 39057004 |Pulmonary valve structure|, 
           116676008 |Associated morphology| = << 415582006 |Stenosis|}, 
          {363698007 |Finding site| = << 73829009 |Right atrial structure|, 
           116676008 |Associated morphology| = << 56246009 |Hypertrophy|}) 
        AND 
        (<< 373873005 |Pharmaceutical / biologic product|: 
          [1..3] 127489000 |Has active ingredient| = << 105590001 |Substance|)
      `;

      const start = Date.now();
      const result = eclValidator.parse(complexExpression);
      const duration = Date.now() - start;

      expect(result.success).toBe(true);
      expect(duration).toBeLessThan(100); // Should parse complex expression in under 100ms
    });
  });

  describe('Integration Tests with SNOMED Services', () => {

    test('should integrate with SNOMED filter operations', async () => {
      // Test basic concept lookup
      if (snomedServices.conceptExists('404684003')) {
        const result = await eclValidator.evaluate('404684003 |Clinical finding|');
        expect(result.total).toBeGreaterThan(0);
        expect(result.results).toHaveLength(1);
        expect(result.results[0].conceptId).toBe('404684003');
      }
    });

    test('should handle hierarchy operations if concepts exist', async () => {
      // Test descendant operations
      try {
        const result = await eclValidator.evaluate('<< 138875005 |SNOMED CT Concept|');
        expect(result.total).toBeGreaterThan(0);
      } catch (error) {
        // Concept might not exist in test data
        expect(error.message).toContain('not found');
      }
    });

    test('should handle wildcard evaluation with limits', async () => {
      const result = await eclValidator.evaluate('*');
      expect(result.total).toBeGreaterThan(0);
      expect(result.results.length).toBeLessThanOrEqual(1000); // Should be limited
    });
  });

  describe('Advanced ECL Features', () => {

    test('should handle nested expressions correctly', async () => {
      const nestedExpressions = [
        '<< 404684003 |Clinical finding|: 47429007 |Associated with| = (<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = << 55641003 |Infarct|)',
        '^(<< 192008 |Congenital syphilitic hepatomegaly|)',
        '(<< 404684003 |Clinical finding| AND << 11687002 |Gestational diabetes mellitus|) OR (<< 72704001 |Fracture| AND << 23416004 |Bone structure of ulna|)'
      ];

      nestedExpressions.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(true);
      });
    });

    test('mixed AND/OR/MINUS without parentheses is rejected (ECL 6.4)', async () => {
      // Conjunction, disjunction and exclusion operators cannot be mixed within a
      // single ungrouped compound expression; round brackets are mandatory to
      // disambiguate (ECL spec section 6.4). Aligns with the HL7 tx-ecosystem
      // test suite (PR #49); previously these parsed successfully.
      const expressions = [
        '<< 404684003 |Clinical finding| AND << 11687002 |Gestational diabetes mellitus| OR << 72704001 |Fracture|',
        '<< 404684003 |Clinical finding| OR << 11687002 |Gestational diabetes mellitus| AND << 72704001 |Fracture|',
        '<< 404684003 |Clinical finding| MINUS << 11687002 |Gestational diabetes mellitus| AND << 72704001 |Fracture|'
      ];

      expressions.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(false);
      });
    });

    test('should handle attribute constraints with comparison operators', async () => {
      const expressions = [
        '<< 404684003 |Clinical finding|: 363698007 |Finding site| != << 39057004 |Pulmonary valve structure|',
        '<< 406459008 |Halibut liver oil product|: 732943007 |Has basis of strength substance| >= #500',
        '<< 406459008 |Halibut liver oil product|: 732943007 |Has basis of strength substance| <= #1000',
        '<< 406459008 |Halibut liver oil product|: 732943007 |Has basis of strength substance| > #250',
        '<< 406459008 |Halibut liver oil product|: 732943007 |Has basis of strength substance| < #1500'
      ];

      expressions.forEach(expr => {
        const result = eclValidator.parse(expr);
        expect(result.success).toBe(true);
      });
    });
  });
  describe('ECL Term Validation', () => {
    test('should accept valid concept with correct term', async () => {
      // You'll need to fill in a real concept ID and its actual term from your SNOMED data
      const result = eclValidator.parse('11687002 |Gestational diabetes mellitus|');

      expect(result.success).toBe(true);
      expect(result.ast.type).toBe(ECLNodeType.SUB_EXPRESSION_CONSTRAINT);
      expect(result.ast.focus.conceptId).toBe('11687002');
      expect(result.ast.focus.term).toBe('Gestational diabetes mellitus');
    });

    test('should reject valid concept with incorrect term', async () => {
      // Same concept ID but with wrong term
      const result = eclValidator.parse('11687002 |Wrong term here|');

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Term "Wrong term here" does not match any active description for concept 11687002');
    });

    test('should accept concept without term', async () => {
      // Just the concept ID without term should still work
      const result = eclValidator.parse('11687002');

      expect(result.success).toBe(true);
      expect(result.ast.focus.conceptId).toBe('11687002');
      expect(result.ast.focus.term).toBeNull();
    });

    test('should handle term validation in compound expressions', async () => {
      // Test term validation works in more complex expressions
      const result = eclValidator.parse('<< 11687002 |Gestational diabetes mellitus| AND << 404684003 |Wrong clinical finding term|');

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('does not match any active description');
    });

    test('should handle term validation in refinements', async () => {
      // Test term validation in attribute contexts
      const result = eclValidator.parse('<< 404684003 |Clinical finding|: 116676008 |Wrong morphology term| = 72704001 |Fracture|');

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('does not match any active description');
    });

    test('should provide helpful error message with expected term', async () => {
      const result = eclValidator.parse('11687002 |Completely wrong term|');

      expect(result.success).toBe(false);
      expect(result.errors[0]).toMatch(/Expected term like ".*"/);
    });
  });

  describe('ECL Semantic Validation (Separate)', () => {

    describe('Parse vs Semantic Validation Separation', () => {
      test('parse() should succeed even with semantic errors', async () => {
        // This has semantic errors but should parse fine
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 11687002 | Gestational diabetes mellitus | = 72704001 |Fracture|');

        expect(parseResult.success).toBe(true);
        expect(parseResult.ast).toBeDefined();
        expect(parseResult.errors).toHaveLength(0);
      });

      test('validateSemantics() should catch semantic errors', async () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 11687002 | Gestational diabetes mellitus | = 72704001 |Fracture|');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(false);
        expect(semanticResult.errors).toHaveLength(1);
        expect(semanticResult.errors[0]).toContain('is not a valid relationship type');
      });

      test('parseAndValidateSemantics() should do both in one call', async () => {
        const result = eclValidator.parseAndValidateSemantics('<< 404684003 |Clinical finding|: 11687002 | Gestational diabetes mellitus | = 72704001 |Fracture|');

        expect(result.success).toBe(false);
        expect(result.ast).toBeDefined(); // Parse succeeded
        expect(result.errors).toHaveLength(1); // But semantic validation failed
        expect(result.errors[0]).toContain('is not a valid relationship type');
      });
    });

    describe('Relationship Type Validation', () => {
      test('should accept valid relationship types', async () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = 72704001 |Fracture|');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(true);
        expect(semanticResult.errors).toHaveLength(0);
      });

      test('should reject invalid relationship types', async () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 11687002 | Gestational diabetes mellitus | = 72704001 |Fracture|');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(false);
        expect(semanticResult.errors[0]).toContain('is not a valid relationship type');
        expect(semanticResult.errors[0]).toContain('Concept model attribute');
      });
    });

    describe('Domain Validation', () => {
      test('should accept appropriate attribute domains', async () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = 49755003 |Morphologically abnormal structure|');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(true);
      });

      test('should reject inappropriate attribute domains', async () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 260686004 |Method| = 129433002 |Inspection|');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(false);
        expect(semanticResult.errors[0]).toContain('is not typically used with concepts outside of');
        expect(semanticResult.errors[0]).toContain('Procedure');
      });

      test('should accept procedure attributes with procedures', async () => {
        const parseResult = eclValidator.parse('<< 71388002 |Procedure|: 260686004 |Method| = 129428001 |Inspection|');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(true);
      });
    });

    describe('Range Validation', () => {
      test('should accept valid attribute ranges', async () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = 49755003 |Morphologically abnormal structure|');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(true);
      });

      test('should reject invalid attribute ranges', async () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = 71388002 |Procedure|');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(false);
        expect(semanticResult.errors[0]).toContain('is not a valid concept for attribute');
      });
    });

    describe('Workflow Examples', () => {
      test('syntax error stops at parse', async () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding: missing pipe');

        expect(parseResult.success).toBe(false);
        expect(parseResult.ast).toBeNull();
        // No point in semantic validation if parse failed
      });

      test('parse success, semantic validation optional', async () => {
        const expression = '<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = 72704001 |Fracture|';

        // Parse first
        const parseResult = eclValidator.parse(expression);
        expect(parseResult.success).toBe(true);

        // Use the AST for evaluation without semantic validation
        // (this would work in the ECL evaluator)

        // Only validate semantics if needed
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);
        expect(semanticResult.success).toBe(true);
      });

      test('can continue with warnings on semantic issues', async () => {
        const expression = '<< 404684003 |Clinical finding|: 260686004 |Method| = 129433002 |Inspection|';

        const parseResult = eclValidator.parse(expression);
        expect(parseResult.success).toBe(true);

        const semanticResult = eclValidator.validateSemantics(parseResult.ast);
        expect(semanticResult.success).toBe(false);

        // Application could choose to:
        // 1. Treat as error and reject
        // 2. Treat as warning and continue
        // 3. Ask user for confirmation
        expect(semanticResult.errors.length).toBeGreaterThan(0);
        // Still have valid AST to work with: parseResult.ast
      });

      test('validateSemantics can be called multiple times', async () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = 72704001 |Fracture|');

        // Could validate with different rule sets
        const strictResult = eclValidator.validateSemantics(parseResult.ast);
        expect(strictResult.success).toBe(true);

        // Or validate again after AST modifications
        const revalidateResult = eclValidator.validateSemantics(parseResult.ast);
        expect(revalidateResult.success).toBe(true);
      });
    });

    describe('Edge Cases', () => {
      test('should skip semantic validation for wildcards', async () => {
        const parseResult = eclValidator.parse('<< 404684003 |Clinical finding|: * = *');
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(true);
      });

      test('should handle complex expressions', async () => {
        const parseResult = eclValidator.parse(`
        (<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = 72704001 |Fracture|) 
        AND 
        (<< 71388002 |Procedure|: 260686004 |Method| = 129433002 |Inspection|)
      `);
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(true);
      });

      test('should collect multiple semantic errors', async () => {
        const parseResult = eclValidator.parse(`
        << 404684003 |Clinical finding|: {
          11687002 | Gestational diabetes mellitus | = 72704001 |Fracture|,
          260686004 |Method| = 129433002 |Inspection|
        }
      `);
        const semanticResult = eclValidator.validateSemantics(parseResult.ast);

        expect(semanticResult.success).toBe(false);
        expect(semanticResult.errors.length).toBeGreaterThan(1);
      });
    });
  });
});