const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
let app;
beforeAll(async () => { app = await getTestApp(); }, 60000);
afterAll(async () => { await shutdownTestApp(); });
test('dbg', async () => {
  const response = await request(app).post('/tx/r5/ConceptMap/core-example/$translate')
    .set('Accept', 'application/json').set('Content-Type', 'application/json')
    .send({ resourceType: 'Parameters', parameter: [
      { name: 'system', valueUri: 'http://example.org/source' }, { name: 'sourceCode', valueCode: 'source-code' } ] });
  console.log(response.status, JSON.stringify(response.body, null, 1));
});
