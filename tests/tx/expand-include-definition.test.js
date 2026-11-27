/**
 * $expand: without includeDefinition, the expansion leaves out the value set's definition -
 * its compose, description, purpose, contacts, copyright, publisher, extensions, narrative and
 * contained resources. With it, they're kept.
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

const CS_URL = 'http://example.org/fhir/CodeSystem/include-definition';
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  concept: [{ code: 'a', display: 'A' }, { code: 'b', display: 'B' }]
};
const VS = {
  resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/include-definition', version: '1.0.0', status: 'active',
  publisher: 'Example', description: 'A description', purpose: 'A purpose', copyright: 'A copyright',
  contact: [{ name: 'A contact', telecom: [{ system: 'email', value: 'a@example.org' }] }],
  compose: { include: [{ system: CS_URL }] }
};
const DEFINITION = ['publisher', 'description', 'purpose', 'copyright', 'contact', 'compose'];

function expand(app, includeDefinition) {
  const parameter = [{ name: 'tx-resource', resource: CS }, { name: 'valueSet', resource: VS }];
  if (includeDefinition !== undefined) parameter.push({ name: 'includeDefinition', valueBoolean: includeDefinition });
  return request(app).post('/tx/r5/ValueSet/$expand').set('Content-Type', 'application/json').send({ resourceType: 'Parameters', parameter });
}

describe('$expand and includeDefinition', () => {
  let app;
  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);
  afterAll(async () => {
    await shutdownTestApp();
  });

  test('without it, the definition (contacts included) is left out', async () => {
    for (const flag of [undefined, false]) {
      const res = await expand(app, flag);
      expect(res.status).toBe(200);
      expect(res.body.expansion.contains.map(c => c.code).sort()).toEqual(['a', 'b']);
      for (const name of DEFINITION) expect(res.body[name]).toBeUndefined();
      expect(res.body.contactList).toBeUndefined();
    }
  });

  test('with it, the definition is kept', async () => {
    const res = await expand(app, true);
    expect(res.status).toBe(200);
    for (const name of DEFINITION) expect(res.body[name]).toEqual(VS[name]);
  });
});
