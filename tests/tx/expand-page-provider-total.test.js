/**
 * $expand, paged (count and offset): once the page is full, the rest of the walk only counts codes,
 * for the total, which is reported only for an expansion within the response limit. When the
 * value set is one selection whose size the provider vouches for - as count=0 already trusts it:
 * one include, of a whole code system or of one filter set, nothing excluded, imported or skipped
 * - that size is the total, and the walk stops as soon as the page is full. The responses are the
 * same: the total within the limit, none at or over it.
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');

const CS_URL = 'http://example.org/fhir/CodeSystem/page-provider-total';
const N = 120;
const codes = Array.from({ length: N }, (_, i) => 'p' + String(i).padStart(3, '0'));
// a hierarchy: every tenth code has the nine after it as children
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  property: [{ code: 'grade', type: 'code' }],
  concept: codes.filter((_, i) => i % 10 === 0).map((code, r) => ({
    code, display: 'Display ' + code, property: [{ code: 'grade', valueCode: 'g0' }],
    concept: codes.slice(r * 10 + 1, r * 10 + 10).map((child, j) => ({ code: child, display: 'Display ' + child, property: [{ code: 'grade', valueCode: 'g' + (1 + (j % 2)) }] }))
  }))
};
const G1 = CS.concept.flatMap(c => c.concept).filter(c => c.property[0].valueCode === 'g1').length;
let n = 0;
function valueSet(compose) {
  n++;
  return { resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/page-provider-total-' + n, version: '1.0.0', status: 'active', compose };
}
function expand(app, vs, { offset, count, threshold, extra = [] } = {}) {
  const parameter = [{ name: 'tx-resource', resource: CS }, { name: 'valueSet', resource: vs }, ...extra];
  if (offset !== undefined) parameter.push({ name: 'offset', valueInteger: offset });
  if (count !== undefined) parameter.push({ name: 'count', valueInteger: count });
  const req = request(app).post('/tx/r5/ValueSet/$expand').set('Content-Type', 'application/json');
  if (threshold !== undefined) {
    req.set('x-too-costly-threshold', String(threshold));
  }
  return req.send({ resourceType: 'Parameters', parameter });
}
// (the whole expansion is a hierarchy: a page is a slice of it in order)
const flat = (list) => (list || []).flatMap(c => [c.code, ...flat(c.contains)]);
const codesOf = (res) => flat(res.body.expansion.contains);

describe('$expand, paged: the total from the provider', () => {
  let app;
  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);
  afterAll(async () => {
    await shutdownTestApp();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const whole = () => valueSet({ include: [{ system: CS_URL }] });
  const filtered = () => valueSet({ include: [{ system: CS_URL, filter: [{ property: 'grade', op: '=', value: 'g1' }] }] });

  // the size of each, and the limits under, at and over it
  for (const [name, make, size, walkedVia] of [['a whole code system', whole, N, 'nextContext'], ['one filter', filtered, G1, 'filterConcept']]) {
    describe(name, () => {
      test('the page is that slice of the whole expansion, and the walk stops once it is full', async () => {
        const vs = make();
        const all = await expand(app, vs, { threshold: 1000 });
        expect(all.status).toBe(200);
        expect(all.body.expansion.total).toBe(size);
        const walk = jest.spyOn(FhirCodeSystemProvider.prototype, walkedVia);
        const res = await expand(app, vs, { offset: 10, count: 10, threshold: 1000 });
        expect(res.status).toBe(200);
        expect(codesOf(res)).toEqual(codesOf(all).slice(10, 20));
        expect(res.body.expansion.total).toBe(size);
        // the codes up to the end of the page, and not the rest
        expect(walk.mock.calls.length).toBeLessThan(size);
      });

      for (const [where, limit, total] of [['under the limit: the total', size + 1, size], ['at the limit: no total', size, undefined], ['over the limit: no total', size - 1, undefined]]) {
        test(`${where}`, async () => {
          const vs = make();
          const res = await expand(app, vs, { offset: 0, count: 10, threshold: limit });
          expect(res.status).toBe(200);
          expect(res.body.expansion.contains).toHaveLength(10);
          expect(res.body.expansion.total).toBe(total);
        });
      }

      test('a page past the end: the codes there are, and the total', async () => {
        const vs = make();
        const res = await expand(app, vs, { offset: size - 3, count: 10, threshold: 1000 });
        expect(res.status).toBe(200);
        expect(res.body.expansion.contains).toHaveLength(3);
        expect(res.body.expansion.total).toBe(size);
      });
    });
  }

  test('a filter the provider says is not closed: its size is not taken, and the walk counts', async () => {
    jest.spyOn(FhirCodeSystemProvider.prototype, 'filtersNotClosed').mockResolvedValue(true);
    const size = jest.spyOn(FhirCodeSystemProvider.prototype, 'filterSize');
    const vs = filtered();
    const res = await expand(app, vs, { offset: 0, count: 10, threshold: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.expansion.total).toBe(G1);
    expect(size).not.toHaveBeenCalled();
    const over = await expand(app, vs, { offset: 0, count: 10, threshold: G1 - 1 });
    expect(over.body.expansion.total).toBeUndefined();
  });

  test('not taken where the walk would count differently: two includes, an exclude, activeOnly, excludeNotForUI', async () => {
    const all = jest.spyOn(FhirCodeSystemProvider.prototype, 'countAllCodes');
    const size = jest.spyOn(FhirCodeSystemProvider.prototype, 'filterSize');
    for (const [vs, extra] of [
      [valueSet({ include: [{ system: CS_URL }, { system: CS_URL, concept: [{ code: 'p001' }] }] }), []],
      [valueSet({ include: [{ system: CS_URL, filter: [{ property: 'grade', op: '=', value: 'g1' }] }, { system: CS_URL, concept: [{ code: 'p000' }] }] }), []],
      [valueSet({ include: [{ system: CS_URL }], exclude: [{ system: CS_URL, concept: [{ code: 'p001' }] }] }), []],
      [whole(), [{ name: 'activeOnly', valueBoolean: true }]],
      [whole(), [{ name: 'excludeNotForUI', valueBoolean: true }]]
    ]) {
      const res = await expand(app, vs, { offset: 0, count: 10, threshold: 1000, extra });
      expect(res.status).toBe(200);
    }
    expect(all).not.toHaveBeenCalled();
    expect(size).not.toHaveBeenCalled();
  });
});
