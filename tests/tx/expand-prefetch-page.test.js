/**
 * $expand of listed codes: what the worker asks prefetchCodes(codes, withDesignations) for.
 *
 * A provider may read the listed codes together before they are located, designations too when
 * asked. On a paged request, codes outside the page are only counted, so their designations
 * aren't wanted - but when the page holds the whole list (the usual count=1000 on a smaller
 * value set), every code is built, and the designations are wanted for all of them.
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');

const CS_URL = 'http://example.org/fhir/CodeSystem/prefetch-page';
const codes = Array.from({ length: 40 }, (_, i) => 'p' + String(i).padStart(2, '0'));
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  concept: codes.map(code => ({ code, display: 'Display ' + code, designation: [{ language: 'de', value: 'Anzeige ' + code }] }))
};
let n = 0;
function valueSet(include) {
  n++;
  return { resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/prefetch-page-' + n, version: '1.0.0', status: 'active', compose: { include } };
}
const listed = (from, to) => ({ system: CS_URL, concept: codes.slice(from, to).map(code => ({ code })) });

function expand(app, vs, { offset, count, extra = [] } = {}) {
  const parameter = [{ name: 'tx-resource', resource: CS }, { name: 'valueSet', resource: vs }, ...extra];
  if (offset !== undefined) parameter.push({ name: 'offset', valueInteger: offset });
  if (count !== undefined) parameter.push({ name: 'count', valueInteger: count });
  return request(app).post('/tx/r5/ValueSet/$expand').set('Content-Type', 'application/json').send({ resourceType: 'Parameters', parameter });
}

describe('$expand: prefetchCodes is asked for designations exactly when every listed code will be built', () => {
  let app;
  let spy;
  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);
  afterAll(async () => {
    await shutdownTestApp();
  });
  beforeEach(() => {
    spy = jest.spyOn(FhirCodeSystemProvider.prototype, 'prefetchCodes');
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  const asked = () => spy.mock.calls.map(([list, withDesignations]) => [list.length, withDesignations]);

  test('not paged: designations for the whole list', async () => {
    const res = await expand(app, valueSet([listed(0, 30)]));
    expect(res.status).toBe(200);
    expect(asked()).toEqual([[30, true]]);
  });

  test('a page that holds the whole list: designations for all of it, and every code is built in full', async () => {
    const res = await expand(app, valueSet([listed(0, 30)]), { offset: 0, count: 1000 });
    expect(res.status).toBe(200);
    expect(asked()).toEqual([[30, true]]);
    expect(res.body.expansion.contains.map(c => c.code)).toEqual(codes.slice(0, 30));
    expect(res.body.expansion.contains.every(c => c.display === 'Display ' + c.code)).toBe(true);
  });

  test('a page that holds only part of the list: no designations (most codes are only counted)', async () => {
    const res = await expand(app, valueSet([listed(0, 30)]), { offset: 5, count: 10 });
    expect(res.status).toBe(200);
    expect(asked()).toEqual([[30, false]]);
    expect(res.body.expansion.contains.map(c => c.code)).toEqual(codes.slice(5, 15));
    expect(res.body.expansion.contains.every(c => c.display === 'Display ' + c.code)).toBe(true);
  });

  test('several includes: each list is judged by where it falls against the page', async () => {
    // [0,10) is before the page, [10,20) is inside it, [20,40) runs past its end
    const res = await expand(app, valueSet([listed(0, 10), listed(10, 20), listed(20, 40)]), { offset: 10, count: 15 });
    expect(res.status).toBe(200);
    expect(asked()).toEqual([[10, false], [10, true], [20, false]]);
    expect(res.body.expansion.contains.map(c => c.code)).toEqual(codes.slice(10, 25));
  });

  test('the same responses either way: a page holding the list matches the unpaged expansion', async () => {
    const vs = valueSet([listed(0, 30)]);
    const extra = [{ name: 'includeDesignations', valueBoolean: true }];
    const whole = await expand(app, vs, { extra });
    const page = await expand(app, vs, { offset: 0, count: 1000, extra });
    expect(page.body.expansion.contains).toEqual(whole.body.expansion.contains);
    expect(page.body.expansion.total).toBe(whole.body.expansion.total);
  });
});
