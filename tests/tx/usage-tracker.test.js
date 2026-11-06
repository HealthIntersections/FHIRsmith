/**
 * The usage tracker counts how often codes are seen (for the usage-count expansion property).
 * It is never emptied, so it must not keep made-up codes: validating unique 40 KB codes grew it
 * by 10 MB a second.
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const ConceptUsageTracker = require('../../tx/usage-tracker');

const CS_URL = 'http://example.org/fhir/CodeSystem/usage-tracker-cs';
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  concept: [{ code: 'known', display: 'Known' }]
};

describe('ConceptUsageTracker', () => {
  test('counts the codes it sees', () => {
    const t = new ConceptUsageTracker();
    t.seeConcept('http://a', 'x');
    t.seeConcept('http://a', 'x');
    expect(t.usages('http://a').get('x').count).toBe(2);
  });

  test('stops adding codes at its limits, but still counts the ones it has', () => {
    const t = new ConceptUsageTracker();
    t.seeConcept('http://a', 'x'.repeat(ConceptUsageTracker.MAX_CODE_LENGTH + 1));
    expect(t.usages('http://a')).toBeNull();
    t.seeConcept('http://a', 'x');
    t.codes = ConceptUsageTracker.MAX_CODES;
    t.seeConcept('http://a', 'y');
    t.seeConcept('http://b', 'y');
    t.seeConcept('http://a', 'x');
    expect(t.usages('http://a').has('y')).toBe(false);
    expect(t.usages('http://b')).toBeNull();
    expect(t.usages('http://a').get('x').count).toBe(2);
  });
});

describe('$validate-code records only valid codes', () => {
  let app;
  beforeAll(async () => { app = await getTestApp(); }, 60000);
  afterAll(async () => { await shutdownTestApp(); });

  test.each([['known', 1], ['made-up', 0]])('code %s', async (code, seen) => {
    const spy = jest.spyOn(ConceptUsageTracker.prototype, 'seeConcept');
    try {
      const res = await request(app).post('/tx/r5/CodeSystem/$validate-code')
        .set('Content-Type', 'application/json')
        .send({ resourceType: 'Parameters', parameter: [
          { name: 'tx-resource', resource: CS },
          { name: 'coding', valueCoding: { system: CS_URL, code } }
        ] });
      expect(res.status).toBe(200);
      expect(spy.mock.calls.filter(c => c[1] === code)).toHaveLength(seen);
    } finally {
      spy.mockRestore();
    }
  });
});
