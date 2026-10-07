/**
 * Read Worker Integration Tests
 * 
 * Tests GET /tx/r5/CodeSystem/{id} and GET /tx/r5/ValueSet/{id}
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

describe('Read Worker', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000); // Allow 60s for initialization

  afterAll(async () => {
    await shutdownTestApp();
  });

  describe('GET /tx/r5/CodeSystem/:id', () => {
    test('should return CodeSystem by id', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/core-administrative-gender')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('CodeSystem');
      expect(response.body.id).toBe('core-administrative-gender');
      expect(response.body.url).toBe('http://hl7.org/fhir/administrative-gender');
    });

    test('should return 404 for the id the CodeSystem has in its package', async () => {
      // core resources are only served in the 'core' id space - hl7.terminology can have
      // the same ids
      const response = await request(app)
        .get('/tx/r5/CodeSystem/administrative-gender')
        .set('Accept', 'application/json');

      expect(response.status).toBe(404);
    });

    test('should return 404 for non-existent CodeSystem', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/non-existent-id')
        .set('Accept', 'application/json');

      expect(response.status).toBe(404);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].code).toBe('not-found');
    });

    test('should include X-Request-Id header', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/core-administrative-gender')
        .set('Accept', 'application/json');

      expect(response.headers['x-request-id']).toBeDefined();
      expect(response.headers['x-request-id']).toMatch(/^tx-\d+$/);
    });
  });

  describe('GET /tx/r5/ValueSet/:id', () => {
    test('should return ValueSet by id', async () => {
      const response = await request(app)
        .get('/tx/r5/ValueSet/core-administrative-gender')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('ValueSet');
      expect(response.body.id).toBe('core-administrative-gender');
    });

    test('should return 404 for non-existent ValueSet', async () => {
      const response = await request(app)
        .get('/tx/r5/ValueSet/non-existent-id')
        .set('Accept', 'application/json');

      expect(response.status).toBe(404);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].code).toBe('not-found');
    });
  });

  describe('Unsupported methods', () => {
    test('should return 405 for PUT', async () => {
      const response = await request(app)
        .put('/tx/r5/CodeSystem/core-administrative-gender')
        .set('Accept', 'application/json')
        .send({});

      expect(response.status).toBe(405);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].code).toBe('not-supported');
    });

    test('should return 405 for DELETE', async () => {
      const response = await request(app)
        .delete('/tx/r5/CodeSystem/core-administrative-gender')
        .set('Accept', 'application/json');

      expect(response.status).toBe(405);
    });
  });
});
