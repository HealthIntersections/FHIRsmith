/**
 * $batch-validate-code gives the event loop a turn between entries.
 *
 * Validating one entry never yields by itself, so a 1,000-entry batch from an IG build used to
 * hold the event loop for its whole duration (~1 s on production hardware), and every other
 * request arriving meanwhile waited for it (a single lookup typically waited 0.4-0.9 s).
 * processBatch now calls checkAndYield before each entry; checkAndYield only actually yields
 * after YIELD_INTERVAL ms of compute, so small batches are unaffected.
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const { OperationContext } = require('../../tx/operation-context');

const CS_URL = 'http://example.org/fhir/CodeSystem/batch-yield-cs';
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  concept: [{ code: 'a', display: 'Alpha' }, { code: 'b', display: 'Beta' }]
};
const entry = (code) => ({ name: 'validation', resource: { resourceType: 'Parameters', parameter: [{ name: 'code', valueCode: code }] } });

describe('$batch-validate-code yields between entries', () => {
  let app;
  beforeAll(async () => { app = await getTestApp(); }, 60000);
  afterAll(async () => { await shutdownTestApp(); });

  test('checkAndYield is called once per entry and the results are unchanged', async () => {
    const spy = jest.spyOn(OperationContext.prototype, 'checkAndYield');
    try {
      const codes = ['a', 'zz', 'b', 'a', 'b'];
      const res = await request(app).post('/tx/r5/CodeSystem/$batch-validate-code')
        .set('Content-Type', 'application/json')
        .send({ resourceType: 'Parameters', parameter: [{ name: 'tx-resource', resource: CS }, { name: 'url', valueUri: CS_URL }, ...codes.map(entry)] });
      expect(res.status).toBe(200);
      const calls = spy.mock.calls.filter((c) => c[0] === 'batch-validate').length;
      expect(calls).toBe(codes.length);
      const results = res.body.parameter.map((r) => r.resource.parameter.find((p) => p.name === 'result').valueBoolean);
      expect(results).toEqual([true, false, true, true, true]);
    } finally {
      spy.mockRestore();
    }
  });
});
