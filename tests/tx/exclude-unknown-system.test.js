/**
 * $validate-code against a value set whose exclude names a code system, or a version of one,
 * that the server doesn't have: whether the code is excluded can't be said. That's a problem
 * with the request, so a 422 that says what's missing - it was a 500, "No Match for ..."
 * (tx.hl7.cz, given the tx-ecosystem's ecosystem-sct-split value set, which excludes from the
 * Estonian edition it doesn't hold)
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

const SYS = 'http://example.org/fhir/CodeSystem/exclude-unknown';
const CS = {
  resourceType: 'CodeSystem', url: SYS, version: '1.0.0', status: 'active', content: 'complete',
  concept: [{ code: 'a', display: 'A' }, { code: 'b', display: 'B' }]
};

describe('an exclude from a code system the server doesn\'t have', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  const validate = (exclude) => request(app)
    .post('/tx/r5/ValueSet/$validate-code')
    .set('Content-Type', 'application/json')
    .send({ resourceType: 'Parameters', parameter: [
      { name: 'valueSet', resource: { resourceType: 'ValueSet', status: 'active',
        compose: { include: [{ system: SYS }], exclude: [exclude] } } },
      { name: 'coding', valueCoding: { system: SYS, code: 'a' } },
      { name: 'tx-resource', resource: CS }
    ] });

  const issue = (body) => body.issue && body.issue[0];

  test('a version it doesn\'t have: 422, naming the version and the ones it has', async () => {
    const res = await validate({ system: SYS, version: '9.9.9', concept: [{ code: 'b' }] });
    expect(res.status).toBe(422);
    expect(issue(res.body).code).toBe('not-found');
    expect(issue(res.body).details.text).toMatch(/CodeSystem 'http:\/\/example.org\/fhir\/CodeSystem\/exclude-unknown' version '9.9.9' could not be found.*1\.0\.0/);
  });

  test('a code system it doesn\'t have at all: 422', async () => {
    const res = await validate({ system: 'http://example.org/fhir/CodeSystem/not-here', concept: [{ code: 'b' }] });
    expect(res.status).toBe(422);
    expect(issue(res.body).code).toBe('not-found');
    expect(issue(res.body).details.text).toMatch(/not-here' could not be found/);
  });

  test('an exclude it does have still works', async () => {
    const res = await validate({ system: SYS, concept: [{ code: 'a' }] });
    expect(res.status).toBe(200);
    expect(res.body.parameter.find(p => p.name === 'result').valueBoolean).toBe(false);
  });
});
