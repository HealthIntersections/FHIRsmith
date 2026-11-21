/**
 * CodeSystem/$batch-validate-code
 *
 * On the CodeSystem route `url` names the code system (as it does for
 * CodeSystem/$validate-code): a top-level url is shared by every entry, and an
 * entry carrying a url is still a CodeSystem validation, not a ValueSet one.
 * (The tx-ecosystem cs-batch-validate tests cover the full responses.)
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

const CS_URL = 'http://example.org/fhir/CodeSystem/batch-cs';
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  concept: [{ code: 'a', display: 'Alpha' }, { code: 'b', display: 'Beta' }]
};

function entry(parameter) {
  return { name: 'validation', resource: { resourceType: 'Parameters', parameter } };
}

function param(r, name) {
  return (r.resource.parameter || []).find(p => p.name === name);
}

describe('CodeSystem/$batch-validate-code', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  async function batch(parameter) {
    const res = await request(app).post('/tx/r5/CodeSystem/$batch-validate-code')
      .set('Content-Type', 'application/json')
      .send({ resourceType: 'Parameters', parameter });
    expect(res.status).toBe(200);
    return res.body.parameter;
  }

  test('a top-level url is the code system for every entry', async () => {
    const rs = await batch([
      { name: 'tx-resource', resource: CS },
      { name: 'url', valueUri: CS_URL },
      entry([{ name: 'code', valueCode: 'a' }]),
      entry([{ name: 'code', valueCode: 'zz' }]),
      entry([{ name: 'code', valueCode: 'b' }, { name: 'display', valueString: 'Beta' }])
    ]);
    expect(rs.length).toBe(3);
    expect(rs.map(r => r.resource.resourceType)).toEqual(['Parameters', 'Parameters', 'Parameters']);
    expect(rs.map(r => param(r, 'result').valueBoolean)).toEqual([true, false, true]);
    expect(param(rs[0], 'system').valueUri).toBe(CS_URL);
  });

  test('an entry with its own url is validated against that code system, not as a value set', async () => {
    const rs = await batch([
      { name: 'tx-resource', resource: CS },
      entry([{ name: 'url', valueUri: CS_URL }, { name: 'code', valueCode: 'b' }])
    ]);
    expect(rs.length).toBe(1);
    expect(param(rs[0], 'result').valueBoolean).toBe(true);
    expect(param(rs[0], 'system').valueUri).toBe(CS_URL);
  });

  test('entries with no url are validated against the system their coding names', async () => {
    const rs = await batch([
      { name: 'tx-resource', resource: CS },
      entry([{ name: 'coding', valueCoding: { system: CS_URL, code: 'a' } }]),
      entry([{ name: 'coding', valueCoding: { system: CS_URL, code: 'q' } }])
    ]);
    expect(rs.map(r => param(r, 'result').valueBoolean)).toEqual([true, false]);
  });
});
