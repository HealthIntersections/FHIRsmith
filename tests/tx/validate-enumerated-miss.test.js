/**
 * A code that is not in an enumerated include costs one lookup of the code, not one per listed code.
 *
 * Before checking whether a listed concept is the same concept written in another form (ICD-11's
 * short code and entity id), the checker located the code once per listed concept, though the
 * answer (does the code have another form at all?) does not depend on the listed concept. A miss
 * against a 33,000-code VSAC list never finished. It is now asked once per include.
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');

const CS_URL = 'http://example.org/fhir/CodeSystem/enumerated-miss-cs';
const VS_URL = 'http://example.org/fhir/ValueSet/enumerated-miss-vs';
const N = 300;
const codes = Array.from({ length: N }, (_, i) => 'c' + i);
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  concept: [...codes, 'unlisted'].map(code => ({ code, display: 'Display ' + code }))
};
const VS = {
  resourceType: 'ValueSet', url: VS_URL, version: '1.0.0', status: 'active',
  compose: { include: [{ system: CS_URL, concept: codes.map(code => ({ code })) }] }
};

async function validate(app, code) {
  return request(app).post('/tx/r5/ValueSet/$validate-code')
    .set('Content-Type', 'application/json')
    .send({ resourceType: 'Parameters', parameter: [
      { name: 'tx-resource', resource: CS },
      { name: 'valueSet', resource: VS },
      { name: 'coding', valueCoding: { system: CS_URL, code } }
    ] });
}

const resultOf = (res) => res.body.parameter.find(p => p.name === 'result').valueBoolean;

describe('$validate-code: a miss against an enumerated include', () => {
  let app;
  beforeAll(async () => { app = await getTestApp(); }, 60000);
  afterAll(async () => { await shutdownTestApp(); });

  test.each([
    ['in the code system but not listed', 'unlisted'],
    ['not in the code system', 'no-such-code']
  ])('a code %s is located a handful of times, not once per listed code', async (_label, code) => {
    const spy = jest.spyOn(FhirCodeSystemProvider.prototype, 'locate');
    try {
      const res = await validate(app, code);
      expect(res.status).toBe(200);
      expect(resultOf(res)).toBe(false);
      const lookupsOfCode = spy.mock.calls.filter(c => c[0] === code).length;
      expect(lookupsOfCode).toBeLessThan(10);
    } finally {
      spy.mockRestore();
    }
  });

  test('a listed code still validates', async () => {
    const res = await validate(app, 'c150');
    expect(res.status).toBe(200);
    expect(resultOf(res)).toBe(true);
  });
});
