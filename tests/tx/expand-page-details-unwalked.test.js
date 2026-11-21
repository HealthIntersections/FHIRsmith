/**
 * $expand: on an expansion that doesn't walk to its page - one with an exclude, or a text filter
 * - every included code is still added, but only the page's codes have their details read
 * (displays and designations, definition, properties). The responses are the same.
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');

const CS_URL = 'http://example.org/fhir/CodeSystem/page-details-unwalked';
const N = 120;
const codes = Array.from({ length: N }, (_, i) => 'u' + String(i).padStart(3, '0'));
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  property: [{ code: 'grade', type: 'code' }],
  concept: codes.map((code, i) => ({
    code, display: 'Display ' + code, definition: 'Definition ' + code,
    designation: [{ language: 'de', value: 'Anzeige ' + code }],
    property: [{ code: 'grade', valueCode: 'g' + (i % 3) }]
  }))
};
let n = 0;
function valueSet(compose) {
  n++;
  return { resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/page-details-unwalked-' + n, version: '1.0.0', status: 'active', compose };
}
function expand(app, vs, { offset, count, extra = [] } = {}) {
  const parameter = [{ name: 'tx-resource', resource: CS }, { name: 'valueSet', resource: vs }, ...extra];
  if (offset !== undefined) parameter.push({ name: 'offset', valueInteger: offset });
  if (count !== undefined) parameter.push({ name: 'count', valueInteger: count });
  return request(app).post('/tx/r5/ValueSet/$expand').set('Content-Type', 'application/json').send({ resourceType: 'Parameters', parameter });
}
const strip = (exp) => ({ ...exp, timestamp: undefined, identifier: undefined, parameter: (exp.parameter || []).filter(p => !['offset', 'count'].includes(p.name)) });

describe('$expand with an exclude or a text filter: only the page is built in full', () => {
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
  const extra = [{ name: 'includeDesignations', valueBoolean: true }, { name: 'property', valueString: 'grade' }, { name: 'includeDefinition', valueBoolean: true }];

  const cases = {
    'a whole-system include with an exclude': valueSet({ include: [{ system: CS_URL }], exclude: [{ system: CS_URL, concept: [{ code: 'u005' }, { code: 'u050' }] }] }),
    'a property filter with an exclude': valueSet({ include: [{ system: CS_URL, filter: [{ property: 'grade', op: '=', value: 'g1' }] }],
      exclude: [{ system: CS_URL, concept: [{ code: 'u004' }] }] }),
    'listed codes with an exclude': valueSet({ include: [{ system: CS_URL, concept: codes.slice(0, 80).map(code => ({ code })) }],
      exclude: [{ system: CS_URL, concept: [{ code: 'u010' }] }] })
  };
  for (const [name, vs] of Object.entries(cases)) {
    test(`${name}: each page is that slice of the whole expansion, with the same details, and only its codes are read`, async () => {
      const whole = await expand(app, vs, { extra });
      expect(whole.status).toBe(200);
      const all = whole.body.expansion.contains;
      for (const [offset, count] of [[0, 10], [20, 10], [all.length - 5, 10]]) {
        const spy = jest.spyOn(FhirCodeSystemProvider.prototype, 'designations');
        const res = await expand(app, vs, { offset, count, extra });
        expect(res.status).toBe(200);
        expect(res.body.expansion.contains).toEqual(all.slice(offset, offset + count));
        expect(res.body.expansion.total).toBe(whole.body.expansion.total);
        expect(strip(res.body.expansion).property).toEqual(strip(whole.body.expansion).property);
        // the page's codes, and an excluded code met while filling it (read before it is refused)
        expect(spy.mock.calls.length).toBeGreaterThanOrEqual(Math.min(count, all.length - offset));
        expect(spy.mock.calls.length).toBeLessThanOrEqual(Math.min(count, all.length - offset) + 1);
        spy.mockRestore();
      }
    });
  }

  test('a text filter: the page is the same slice, and the codes before it are not read', async () => {
    const vs = valueSet({ include: [{ system: CS_URL }] });
    const filter = { name: 'filter', valueString: 'Display' };
    const whole = await expand(app, vs, { extra: [...extra, filter] });
    const spy = jest.spyOn(FhirCodeSystemProvider.prototype, 'designations');
    const res = await expand(app, vs, { offset: 30, count: 10, extra: [...extra, filter] });
    expect(res.status).toBe(200);
    expect(res.body.expansion.contains).toEqual(whole.body.expansion.contains.slice(30, 40));
    expect(spy.mock.calls.length).toBeLessThan(40);
  });
});
