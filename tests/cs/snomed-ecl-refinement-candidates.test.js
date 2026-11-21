/**
 * ECL refinements look only at the concepts that can match (_refinementCandidates, found
 * from the attribute values' inbound relationships), and gather only the relationship
 * records the refinement looks at (_refinementNeeds). Both are shortcuts: every result
 * here must be the same as testing every concept of the base set with everything gathered.
 *
 * Also: running out of time while evaluating an expression is too-costly, not UNSUPPORTED_ECL,
 * and a long evaluation lets the event loop run other work.
 */

const { SnomedServicesFactory } = require('../../tx/cs/cs-snomed');
const { join } = require('node:path');
const { OperationContext } = require('../../tx/operation-context');
const { Issue } = require('../../tx/library/operation-outcome');
const { TestUtilities } = require('../test-utilities');
const { ECLLexer, ECLParser } = require('../../tx/sct/ecl');

const EXPRESSIONS = [
  '< 64572001 : 363698007 = << 39607008',
  '< 64572001 : << 363698007 = << 39607008',
  '< 64572001 : (363698007 OR 116676008) = << 39607008',
  '< 64572001 : * = << 39607008',
  '< 64572001 : { << 363698007 = << 39607008 }',
  '< 64572001 : { 363698007 = << 39607008 }',
  '< 64572001 : (363698007 = << 39607008 OR 116676008 = << 39607008)',
  '< 64572001 : 363698007 = << 10200004',
  '< 64572001 : 363698007 = 10200004',
  '< 64572001 : 363698007',
  '(< 64572001 : 363698007 = 10200004 OR 404684003)',
  '< 64572001 : 116676008 = << 442021009',
  '< 64572001 : 363698007 = << 39607008, 116676008 = << 442021009',
  '< 64572001 : 363698007 = << 39607008 AND 116676008 = << 442021009',
  '< 64572001 : 363698007 = << 39607008 OR 116676008 = << 442021009',
  '< 64572001 : (363698007 = << 39607008 AND 116676008 = << 442021009) OR 363698007 = << 10200004',
  '< 64572001 : { 363698007 = << 10200004 }',
  '< 64572001 : { 363698007 = << 39607008 } AND { 363698007 = << 10200004 }',
  '< 64572001 : { 363698007 = << 39607008 } OR { 363698007 = << 10200004 }',
  '< 64572001 : { 363698007 = << 39607008 OR 363698007 = << 10200004 }',
  '< 64572001 : 363698007 = << 39607008, 116676008 = * OR 363698007 = << 10200004',
  '< 64572001 : [0..0] 363698007 = << 39607008',
  '< 64572001 : [0..1] 363698007 = << 39607008',
  '< 64572001 : [1..1] 363698007 = << 39607008',
  '< 64572001 : [2..*] 363698007 = << 39607008',
  '< 64572001 : [0..0] { 363698007 = << 39607008 }',
  '< 64572001 : [1..*] { 363698007 = << 39607008 }',
  '< 64572001 : 363698007 != << 39607008',
  '< 64572001 : [0..0] 363698007 != << 39607008',
  '* : [1..1] 116676008 = *',
  '* : [1..*] 116676008 = *',
  '* : [2..*] 116676008 = *',
  '* : [1..1] 116676008 = 442021009',
  '* : [1..*] 116676008 = 442021009',
  '* : [2..*] 116676008 = 442021009',
  '* : 363698007 = << 39607008',
  '< 763158003 : 762949000 != 126081001',
  '* : 762949000 != 126081001',
  '< 763158003 : 127489000 = 126081001',
  '< 763158003 : 127489000 = 126081001, 762949000 = *',
  '< 763158003 : [0..0] 762949000 != < 105590001',
  '< 105590001 : R 127489000 = 776168003',
  '< 105590001 : R * = 329238006',
  '< 105590001 : R 762949000 = *',
  '< 105590001 : [0..*] R 127489000 = 776168003',
  '<< 105590001 : R 363698007 = *',
  '< 763158003 : 1142139005 = #1',
  '< 763158003 : 1142139005 = #1 AND 1142135004 = #4000',
  '< 763158003 : 1142139005 = #1, 127489000 = *',
  '< 763158003 : * = #4000',
  '< 64572001 : 47429007 = (< 64572001 : 116676008 = *)',
];

describe('ECL refinement shortcuts', () => {
  let sct;
  let opContext;

  beforeAll(async () => {
    opContext = new OperationContext('en', await TestUtilities.loadTranslations());
    const factory = new SnomedServicesFactory(opContext.i18n, join(__dirname, '../../tx/data/snomed-testing.cache'));
    await factory.load();
    sct = factory.snomedServices;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function evaluate(ecl) {
    try {
      const ctx = await sct.filterECL(ecl, true, opContext);
      return (ctx.descendants || []).map(i => sct.concepts.getConceptId(i).toString()).sort();
    } catch (e) {
      return 'error: ' + e.message;
    }
  }

  // every concept of the base set tested, with every relationship record gathered
  async function evaluateTheLongWay(ecl) {
    const candidates = jest.spyOn(sct, '_refinementCandidates').mockResolvedValue(null);
    const needs = jest.spyOn(sct, '_refinementNeeds').mockReturnValue(null);
    try {
      return await evaluate(ecl);
    } finally {
      candidates.mockRestore();
      needs.mockRestore();
    }
  }

  test.each(EXPRESSIONS)('%s', async (ecl) => {
    const expected = await evaluateTheLongWay(ecl);
    expect(await evaluate(ecl)).toEqual(expected);
  });

  test('the corpus is not trivially empty', async () => {
    let nonEmpty = 0;
    for (const e of EXPRESSIONS) {
      const r = await evaluateTheLongWay(e);
      if (Array.isArray(r) && r.length > 0) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThan(20);
  });

  test('only the candidates are tested', async () => {
    const tested = jest.spyOn(sct, '_refinementMatches');
    const result = await evaluate('* : 363698007 = << 39607008');
    expect(result.length).toBeGreaterThan(0);
    // the whole edition is the base set; only concepts with a finding site in the lung are tested
    expect(tested.mock.calls.length).toBeLessThan(result.length * 3);
    expect(tested.mock.calls.length).toBeGreaterThanOrEqual(result.length);
  });

  test('no inbound relationships are gathered for a refinement without R', async () => {
    const getInbounds = jest.spyOn(sct.concepts, 'getInbounds');
    await evaluate('< 64572001 : [0..0] 363698007 = << 39607008');
    expect(getInbounds).not.toHaveBeenCalled();
  });

  test('a cardinality that allows none is not pruned', async () => {
    expect(await sct._refinementCandidates(
      new ECLParser(new ECLLexer('< 64572001 : [0..1] 363698007 = << 39607008').tokenize()).parse().refinement, 1000, opContext)).toBeNull();
  });

  test('evaluation gives the event loop a chance to run', async () => {
    const yields = jest.spyOn(opContext, 'checkAndYield');
    await evaluate('* : 363698007 = *');
    expect(yields).toHaveBeenCalled();
  });

  test('a long evaluation lets other work run before it finishes', async () => {
    // with the yield interval at 0, every check point really yields
    const interval = jest.spyOn(opContext, 'checkAndYield').mockImplementation(() => new Promise(resolve => setImmediate(resolve)));
    let ranMeanwhile = false;
    setImmediate(() => { ranMeanwhile = true; });
    const evaluation = evaluate('* : 363698007 = *');
    let finishedFirst = false;
    evaluation.then(() => { finishedFirst = !ranMeanwhile; });
    await evaluation;
    interval.mockRestore();
    expect(finishedFirst).toBe(false);
  });

  test('running out of time is too-costly, not UNSUPPORTED_ECL', async () => {
    jest.spyOn(opContext, 'deadCheck').mockImplementation((place) => {
      if (place === 'ecl:refined') {
        throw new Issue('error', 'too-costly', null, 'CODESYSTEM_TOO_COSTLY_TIME', 'took too long', 'too-costly', 422);
      }
      return false;
    });
    let error = null;
    try {
      await sct.filterECL('< 64572001 : 363698007 = << 39607008', true, opContext);
    } catch (e) {
      error = e;
    }
    expect(error).not.toBeNull();
    expect(error.cause).toBe('too-costly');
    expect(error.msgId).toBe('CODESYSTEM_TOO_COSTLY_TIME');
  });
});

describe('ECL OR chains', () => {
  let sct;
  let opContext;

  beforeAll(async () => {
    opContext = new OperationContext('en', await TestUtilities.loadTranslations());
    const factory = new SnomedServicesFactory(opContext.i18n, join(__dirname, '../../tx/data/snomed-testing.cache'));
    await factory.load();
    sct = factory.snomedServices;
  });

  const codes = async (ecl) => ((await sct.filterECL(ecl, true, opContext)).descendants || [])
    .map(i => sct.concepts.getConceptId(i).toString());

  test.each([
    '<< 64572001 OR << 10200004 OR << 39607008',
    '(<< 64572001 OR << 10200004) OR (<< 39607008 OR 404684003)',
    '<< 10200004 OR << 64572001 OR << 10200004',
    '<< 10200004 OR (<< 64572001 AND << 404684003) OR 39607008',
    '<< 10200004 OR (<< 64572001 MINUS << 40733004) OR 39607008',
  ])('%s is gathered in one pass, same result and order', async (ecl) => {
    // pairwise: what _eclUnion gives, operand by operand from the left
    const pairwise = jest.spyOn(sct, '_evalDisjunction').mockImplementation(async function (node, ctx) {
      return this._eclUnion(await this._evalECLNode(node.left, ctx), await this._evalECLNode(node.right, ctx), ctx);
    });
    const expected = await codes(ecl);
    pairwise.mockRestore();
    expect(expected.length).toBeGreaterThan(0);
    expect(await codes(ecl)).toEqual(expected);
  });

  test('a wildcard anywhere makes the whole OR a wildcard', async () => {
    expect((await sct.filterECL('<< 10200004 OR * OR << 64572001', false, opContext)).eclWildcard).toBe(true);
  });

  test('an unknown concept after a wildcard is still reported', async () => {
    await expect(sct.filterECL('* OR 999999999999', true, opContext)).rejects.toThrow();
  });
});
