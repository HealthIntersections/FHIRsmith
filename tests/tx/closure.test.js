/**
 * $closure routing, and FHIR errors for requests no route matches (issue #100)
 *
 * $closure is defined on ConceptMap but declared system=true, type=false, so it
 * lives at [base]/$closure. The shared test app doesn't turn closure on, so here it
 * must answer with a not-supported OperationOutcome, not an Express HTML page. The
 * operation itself is tested in closure-enabled.test.js.
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

const BASE = '/tx/r5';

const closureBody = {
  resourceType: 'Parameters',
  parameter: [{ name: 'name', valueString: 'test-closure' }]
};

function firstIssue(res) {
  return ((res.body || {}).issue || [])[0] || {};
}

function txIssueTypes(res) {
  return ((firstIssue(res).details || {}).coding || []).map(c => c.code);
}

describe('$closure and unmatched routes (#100)', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  describe('[base]/$closure', () => {
    test('POST is routed and answers not-supported as an OperationOutcome', async () => {
      const res = await request(app)
        .post(`${BASE}/$closure`)
        .set('Content-Type', 'application/fhir+json')
        .set('Accept', 'application/fhir+json')
        .send(closureBody);
      expect(res.status).toBe(501);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(firstIssue(res).code).toBe('not-supported');
      expect(txIssueTypes(res)).toContain('not-supported');
    });

    test('GET is routed too', async () => {
      const res = await request(app)
        .get(`${BASE}/$closure`)
        .query({ name: 'test-closure' })
        .set('Accept', 'application/fhir+json');
      expect(res.status).toBe(501);
      expect(res.body.resourceType).toBe('OperationOutcome');
    });

    test('is not a ConceptMap type-level operation', async () => {
      const res = await request(app)
        .post(`${BASE}/ConceptMap/$closure`)
        .set('Content-Type', 'application/fhir+json')
        .set('Accept', 'application/fhir+json')
        .send(closureBody);
      expect(res.status).toBe(404);
      expect(res.body.resourceType).toBe('OperationOutcome');
    });

    test('when not turned on, it is not advertised anywhere', async () => {
      const res = await request(app)
        .get(`${BASE}/metadata`)
        .set('Accept', 'application/fhir+json');
      expect(res.status).toBe(200);
      const rest = res.body.rest[0];
      expect((rest.operation || []).map(o => o.name)).not.toContain('closure');
      for (const r of rest.resource || []) {
        expect((r.operation || []).map(o => o.name)).not.toContain('closure');
      }
    });
  });

  describe('requests no route matches', () => {
    test('an unknown system operation is a 404 OperationOutcome, not HTML', async () => {
      const res = await request(app)
        .post(`${BASE}/$no-such-operation`)
        .set('Content-Type', 'application/fhir+json')
        .set('Accept', 'application/fhir+json')
        .send({ resourceType: 'Parameters', parameter: [] });
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).not.toMatch(/html/);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(firstIssue(res).code).toBe('not-found');
      expect(txIssueTypes(res)).toContain('not-found');
      expect(firstIssue(res).details.text).toMatch(/Unknown operation/);
    });

    test('an unknown path is a 404 OperationOutcome', async () => {
      const res = await request(app)
        .get(`${BASE}/Patient/123/whatever`)
        .set('Accept', 'application/fhir+json');
      expect(res.status).toBe(404);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(firstIssue(res).details.text).toMatch(/Unknown path/);
    });

    test('an unknown operation at resource-type level is a 404, not a 405', async () => {
      const res = await request(app)
        .delete(`${BASE}/CodeSystem/$no-such-operation`)
        .set('Accept', 'application/fhir+json');
      expect(res.status).toBe(404);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(firstIssue(res).details.text).toMatch(/Unknown operation/);
    });

    test('a write to a resource is still a 405 OperationOutcome', async () => {
      const res = await request(app)
        .delete(`${BASE}/CodeSystem/some-id`)
        .set('Accept', 'application/fhir+json');
      expect(res.status).toBe(405);
      expect(res.body.resourceType).toBe('OperationOutcome');
    });
  });
});
