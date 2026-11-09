/**
 * $expand: a page past the response limit (count and offset).
 *
 * The response limit (the external limit, or x-too-costly-threshold) caps how many codes are
 * built and returned. A paged request walks to its page keeping only the keys of the codes before
 * it (ValueSetExpander #beforePage), so the page can start past that limit; how far it may walk is
 * the walk limit (modules.tx.walkLimit, by default 10 x the internal limit). Each page must be the
 * same codes, in the same order, as that slice of the whole expansion.
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const TXModule = require('../../tx/tx');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');

const CS_URL = 'http://example.org/fhir/CodeSystem/deep-paging';
const N = 300;
const codes = Array.from({ length: N }, (_, i) => 'c' + String(i).padStart(3, '0'));
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  property: [{ code: 'grade', type: 'code' }],
  concept: codes.map((code, i) => ({
    code, display: 'Display ' + code,
    designation: [{ language: 'de', value: 'Anzeige ' + code }],
    property: [{ code: 'grade', valueCode: 'g' + (i % 3) }]
  }))
};
const IMPORTED_URL = 'http://example.org/fhir/ValueSet/deep-paging-imported';
const IMPORTED = {
  resourceType: 'ValueSet', url: IMPORTED_URL, version: '1.0.0', status: 'active',
  compose: { include: [{ system: CS_URL }] }
};

let vsCounter = 0;
function valueSet(compose) {
  vsCounter++;
  return { resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/deep-paging-' + vsCounter, version: '1.0.0', status: 'active', compose };
}
const inList = (from, to) => codes.slice(from, to).join(',');

/** POST $expand; threshold: x-too-costly-threshold (the response limit) */
function expand(app, vs, { offset, count, threshold, extra = [] } = {}) {
  const parameter = [{ name: 'tx-resource', resource: CS }, { name: 'tx-resource', resource: IMPORTED }, { name: 'valueSet', resource: vs }, ...extra];
  if (offset !== undefined) parameter.push({ name: 'offset', valueInteger: offset });
  if (count !== undefined) parameter.push({ name: 'count', valueInteger: count });
  const req = request(app).post('/tx/r5/ValueSet/$expand').set('Content-Type', 'application/json');
  if (threshold !== undefined) {
    req.set('x-too-costly-threshold', String(threshold));
  }
  return req.send({ resourceType: 'Parameters', parameter });
}
const codesOf = (res) => (res.body.expansion.contains || []).map(c => c.code);

describe('$expand: paging past the response limit', () => {
  let app;
  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);
  afterAll(async () => {
    jest.restoreAllMocks();
    await shutdownTestApp();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // the whole expansion, with no limit in the way, and then its pages under a response limit of 50
  async function pagesMatch(vs, { pageSize = 20, threshold = 50 } = {}) {
    const whole = await expand(app, vs);
    expect(whole.status).toBe(200);
    const all = codesOf(whole);
    expect(all.length).toBeGreaterThan(threshold);
    const paged = [];
    for (let offset = 0; offset < all.length + pageSize; offset += pageSize) {
      const res = await expand(app, vs, { offset, count: pageSize, threshold });
      expect(res.status).toBe(200);
      const page = codesOf(res);
      expect(page).toEqual(all.slice(offset, offset + pageSize));
      paged.push(...page);
    }
    expect(paged).toEqual(all);
    return all;
  }

  test('a filter: every page, past the limit too, is that slice of the whole expansion', async () => {
    const all = await pagesMatch(valueSet({ include: [{ system: CS_URL, filter: [{ property: 'grade', op: '=', value: 'g1' }] }] }));
    expect(all.length).toBe(N / 3);
  });

  test('the whole code system', async () => {
    expect((await pagesMatch(valueSet({ include: [{ system: CS_URL }] }))).length).toBe(N);
  });

  test('listed codes', async () => {
    const concept = codes.slice(0, 200).reverse().map(code => ({ code }));
    expect(await pagesMatch(valueSet({ include: [{ system: CS_URL, concept }] }))).toEqual(codes.slice(0, 200).reverse());
  });

  test('overlapping includes: a code before the page is not on it again, and nothing is missed', async () => {
    const vs = valueSet({ include: [
      { system: CS_URL, filter: [{ property: 'concept', op: 'in', value: inList(0, 120) }] },
      { system: CS_URL, filter: [{ property: 'concept', op: 'in', value: inList(60, 200) }] },
      { system: CS_URL, concept: codes.slice(100, 260).map(code => ({ code })) }
    ] });
    expect((await pagesMatch(vs)).length).toBe(260);
  });

  test('an imported value set', async () => {
    expect((await pagesMatch(valueSet({ include: [{ valueSet: [IMPORTED_URL] }] }))).length).toBe(N);
  });

  test('only the codes on the page have their details read', async () => {
    const spy = jest.spyOn(FhirCodeSystemProvider.prototype, 'designations');
    const res = await expand(app, valueSet({ include: [{ system: CS_URL }] }), { offset: 200, count: 10, threshold: 50 });
    expect(res.status).toBe(200);
    expect(codesOf(res)).toEqual(codes.slice(200, 210));
    expect(spy.mock.calls.length).toBe(10);
  });

  test('the total: reported when the whole expansion is within the response limit, as unpaged; not otherwise', async () => {
    const vs = valueSet({ include: [
      { system: CS_URL, filter: [{ property: 'concept', op: 'in', value: inList(0, 120) }] },
      { system: CS_URL, filter: [{ property: 'concept', op: 'in', value: inList(60, 200) }] }
    ] });
    const within = await expand(app, vs, { offset: 20, count: 10 });
    expect(within.status).toBe(200);
    expect(codesOf(within)).toEqual(codes.slice(20, 30));
    expect(within.body.expansion.total).toBe(200);
    const past = await expand(app, vs, { offset: 100, count: 10, threshold: 50 });
    expect(past.status).toBe(200);
    expect(codesOf(past)).toEqual(codes.slice(100, 110));
    expect(past.body.expansion.total).toBeUndefined();
  });

  test('the first page: only its codes are built, and the rest are only counted for the total', async () => {
    const spy = jest.spyOn(FhirCodeSystemProvider.prototype, 'designations');
    const vs = valueSet({ include: [{ system: CS_URL }] });
    const res = await expand(app, vs, { count: 10 });
    expect(res.status).toBe(200);
    expect(codesOf(res)).toEqual(codes.slice(0, 10));
    expect(res.body.expansion.total).toBe(N);
    expect(spy.mock.calls.length).toBe(10);
    // past the response limit: the page, and no total, as before
    const past = await expand(app, vs, { offset: 0, count: 10, threshold: 50 });
    expect(past.status).toBe(200);
    expect(codesOf(past)).toEqual(codes.slice(0, 10));
    expect(past.body.expansion.total).toBeUndefined();
  });

  test('a page is never more than the response limit, and an unpaged expansion over it is refused as before', async () => {
    const vs = valueSet({ include: [{ system: CS_URL }] });
    for (const res of [await expand(app, vs, { offset: 100, count: 60, threshold: 50 }), await expand(app, vs, { threshold: 50 })]) {
      expect(res.status).toBe(422);
      expect(res.body.issue[0].details.coding[0].code).toBe('too-costly');
    }
  });

  test('with an exclusion, as before: the page must fit the response limit', async () => {
    const vs = valueSet({ include: [{ system: CS_URL }], exclude: [{ system: CS_URL, concept: [{ code: 'c000' }] }] });
    expect((await expand(app, vs, { offset: 100, count: 20, threshold: 50 })).status).toBe(422);
    const res = await expand(app, vs, { offset: 20, count: 20, threshold: 50 });
    expect(res.status).toBe(200);
    expect(codesOf(res)).toEqual(codes.slice(21, 41));
  });

  test('with a text filter, as before: it is matched against designations, so the page must fit the response limit', async () => {
    const vs = valueSet({ include: [{ system: CS_URL }] });
    const filter = { name: 'filter', valueString: 'Display' };
    expect((await expand(app, vs, { offset: 100, count: 20, threshold: 50, extra: [filter] })).status).toBe(422);
    const res = await expand(app, vs, { offset: 20, count: 20, threshold: 50, extra: [filter] });
    expect(res.status).toBe(200);
    expect(codesOf(res)).toEqual(codes.slice(20, 40));
  });

  test('offset + count past the walk limit is refused, naming it; a smaller value set just has an empty page', async () => {
    jest.spyOn(TXModule.prototype, 'walkLimit').mockReturnValue(100);
    const vs = valueSet({ include: [{ system: CS_URL }] });
    const ok = await expand(app, vs, { offset: 80, count: 20, threshold: 50 });
    expect(ok.status).toBe(200);
    expect(codesOf(ok)).toEqual(codes.slice(80, 100));

    const refused = await expand(app, vs, { offset: 90, count: 20, threshold: 50 });
    expect(refused.status).toBe(422);
    const issue = refused.body.issue[0];
    expect(issue.code).toBe('too-costly');
    expect(issue.details.coding[0].code).toBe('too-costly');
    expect(issue.details.text).toBe(`The value set '${vs.url}|1.0.0' can't be paged to offset 90 with count 20: the server walks at most 100 codes to reach a page`);
    expect(issue.extension.find(e => e.url.endsWith('operationoutcome-message-id')).valueString).toBe('VALUESET_TOO_COSTLY_PAGE');

    const small = valueSet({ include: [{ system: CS_URL, filter: [{ property: 'concept', op: 'in', value: inList(0, 30) }] }] });
    const empty = await expand(app, small, { offset: 500, count: 20, threshold: 50 });
    expect(empty.status).toBe(200);
    expect(codesOf(empty)).toEqual([]);
  });
});

describe('$expand: a code system that caps how many of its codes are listed (expandLimitation, e.g. CPT)', () => {
  const CAP = 100;
  let app;
  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);
  afterAll(async () => {
    jest.restoreAllMocks();
    await shutdownTestApp();
  });
  beforeEach(() => {
    jest.spyOn(FhirCodeSystemProvider.prototype, 'expandLimitation').mockImplementation(function () {
      return this.system() === CS_URL ? CAP : 0;
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const vs = () => valueSet({ include: [{ system: CS_URL }] });
  const issueExt = (res) => (res.body.expansion.extension || []).filter(e => e.url === 'http://hl7.org/fhir/StructureDefinition/expansion-issue');

  function expectIssue(res) {
    const ext = issueExt(res);
    expect(ext).toEqual([{ url: 'http://hl7.org/fhir/StructureDefinition/expansion-issue', valueReference: { reference: '#oo1' } }]);
    const oo = (res.body.contained || []).find(r => r.id === 'oo1');
    expect(oo.resourceType).toBe('OperationOutcome');
    expect(oo.issue).toEqual([{
      severity: 'warning', code: 'business-rule',
      details: {
        coding: [{ system: 'http://hl7.org/fhir/tools/CodeSystem/tx-issue-type', code: 'business-rule' }],
        text: `Only ${CAP} codes from the code system '${CS_URL}' can be listed in an expansion (by agreement with its publisher), so this expansion doesn't list all the codes asked for`
      },
      extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/operationoutcome-message-id', valueString: 'VALUESET_EXPANSION_CODESYSTEM_LIMITED' }]
    }]);
  }
  function expectNoIssue(res) {
    expect(issueExt(res)).toEqual([]);
    expect(res.body.contained).toBeUndefined();
  }

  test('a page within the cap: its codes, and the total is all the codes; nothing to explain', async () => {
    const res = await expand(app, vs(), { count: 20 });
    expect(res.status).toBe(200);
    expect(codesOf(res)).toEqual(codes.slice(0, 20));
    expect(res.body.expansion.total).toBe(N);
    expectNoIssue(res);
  });

  test('a page that ends at the cap is full: nothing to explain', async () => {
    const res = await expand(app, vs(), { offset: CAP - 20, count: 20 });
    expect(res.status).toBe(200);
    expect(codesOf(res)).toEqual(codes.slice(CAP - 20, CAP));
    expect(res.body.expansion.total).toBe(N);
    expectNoIssue(res);
  });

  test('a page that goes past the cap stops at it, and says why', async () => {
    const res = await expand(app, vs(), { count: CAP + 50 });
    expect(res.status).toBe(200);
    expect(codesOf(res)).toEqual(codes.slice(0, CAP));
    expect(res.body.expansion.total).toBe(N);
    expectIssue(res);

    const across = await expand(app, vs(), { offset: CAP - 10, count: 20 });
    expect(codesOf(across)).toEqual(codes.slice(CAP - 10, CAP));
    expect(across.body.expansion.total).toBe(N);
    expectIssue(across);
  });

  test('a page past the cap is empty, and says why', async () => {
    const res = await expand(app, vs(), { offset: CAP + 100, count: 10 });
    expect(res.status).toBe(200);
    expect(codesOf(res)).toEqual([]);
    expect(res.body.expansion.total).toBe(N);
    expectIssue(res);
  });

  test('unpaged: the codes up to the cap, and why', async () => {
    const res = await expand(app, vs());
    expect(res.status).toBe(200);
    expect(codesOf(res)).toEqual(codes.slice(0, CAP));
    expect(res.body.expansion.total).toBe(N);
    expectIssue(res);
  });

  test('count=0: just the total', async () => {
    const res = await expand(app, vs(), { count: 0 });
    expect(res.status).toBe(200);
    expect(codesOf(res)).toEqual([]);
    expect(res.body.expansion.total).toBe(N);
    expectNoIssue(res);
  });
});

describe('the walk limit', () => {
  const tx = (config) => {
    const m = Object.create(TXModule.prototype);
    m.config = config;
    return m;
  };
  const req = (ua = 'test') => ({ headers: { 'user-agent': ua }, header: () => ua });
  test('configured, else 10 x the internal limit, for every client', () => {
    expect(tx({}).walkLimit(req())).toBe(1000000);
    expect(tx({ internalLimit: 20000 }).walkLimit(req())).toBe(200000);
    expect(tx({ walkLimit: 500000 }).walkLimit(req())).toBe(500000);
    expect(tx({ walkLimit: 500000 }).walkLimit(req('Tools/Java'))).toBe(500000);
    expect(() => tx({ walkLimit: 'x' }).walkLimit(req())).toThrow(/walkLimit must be a whole number/);
  });
});
