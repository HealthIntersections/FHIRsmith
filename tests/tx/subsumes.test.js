/**
 * Subsumes Worker Integration Tests
 *
 * Tests CodeSystem $subsumes operation
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

describe('Subsumes Worker', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  describe('GET /tx/r5/CodeSystem/$subsumes', () => {
    test('should return equivalent for same code', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$subsumes')
        .query({
          system: 'http://hl7.org/fhir/administrative-gender',
          codeA: 'male',
          codeB: 'male'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('Parameters');

      const outcomeParam = response.body.parameter.find(p => p.name === 'outcome');
      expect(outcomeParam).toBeDefined();
      expect(outcomeParam.valueCode).toBe('equivalent');
    });

    test('should return 400 when system is missing', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$subsumes')
        .query({
          codeA: 'male',
          codeB: 'female'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].code).toBe('invalid');
      expect(response.body.issue[0].details.coding[0].code).toBe('invalid-data');
      expect(response.body.issue[0].extension[0].valueString).toBe('SUBSUMPTION_NO_SYSTEM');
      expect(response.body.issue[0].details.text).toContain('system');
    });

    test('should return 400 when the codings have no system', async () => {
      const response = await request(app)
        .post('/tx/r5/CodeSystem/$subsumes')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'codingA', valueCoding: { code: 'male' } },
            { name: 'codingB', valueCoding: { code: 'female' } }
          ]
        });

      expect(response.status).toBe(400);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].code).toBe('invalid');
      expect(response.body.issue[0].details.coding[0].code).toBe('invalid-data');
      expect(response.body.issue[0].extension[0].valueString).toBe('SUBSUMPTION_NO_SYSTEM');
      expect(response.body.issue[0].expression).toEqual(['codingA']);
    });

    test('should return 400 when only codingB has no system', async () => {
      const response = await request(app)
        .post('/tx/r5/CodeSystem/$subsumes')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'codingA', valueCoding: { system: 'http://hl7.org/fhir/administrative-gender', code: 'male' } },
            { name: 'codingB', valueCoding: { code: 'female' } }
          ]
        });

      expect(response.status).toBe(400);
      expect(response.body.issue[0].code).toBe('invalid');
      expect(response.body.issue[0].expression).toEqual(['codingB']);
    });

    test('should return 400 when codeA is missing', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$subsumes')
        .query({
          system: 'http://hl7.org/fhir/administrative-gender',
          codeB: 'male'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body.resourceType).toBe('OperationOutcome');
    });

    test('should return 400 when codeB is missing', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$subsumes')
        .query({
          system: 'http://hl7.org/fhir/administrative-gender',
          codeA: 'male'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body.resourceType).toBe('OperationOutcome');
    });

    test('should return 422 when system not found', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$subsumes')
        .query({
          system: 'http://nonexistent.org/codesystem',
          codeA: 'a',
          codeB: 'b'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(422);
      expect(response.body.resourceType).toBe('OperationOutcome');
    });

    test('should return 404 when codeA is invalid', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$subsumes')
        .query({
          system: 'http://hl7.org/fhir/administrative-gender',
          codeA: 'nonexistent-code',
          codeB: 'male'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(404);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].code).toBe('code-invalid');
      expect(response.body.issue[0].details.text).toContain('nonexistent-code');
      expect(response.body.issue[0].details.coding).toEqual([{
        system: 'http://hl7.org/fhir/tools/CodeSystem/tx-issue-type', code: 'invalid-code'
      }]);
      expect(response.body.issue[0].extension).toEqual([{
        url: 'http://hl7.org/fhir/StructureDefinition/operationoutcome-message-id',
        valueString: 'Unknown_Code_in_Version'
      }]);
      expect(response.body.issue[0].expression).toEqual(['codeA']);
    });

    test('should return 404 when codeB is invalid', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$subsumes')
        .query({
          system: 'http://hl7.org/fhir/administrative-gender',
          codeA: 'male',
          codeB: 'nonexistent-code'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(404);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].code).toBe('code-invalid');
      expect(response.body.issue[0].details.text).toContain('nonexistent-code');
      expect(response.body.issue[0].details.coding).toEqual([{
        system: 'http://hl7.org/fhir/tools/CodeSystem/tx-issue-type', code: 'invalid-code'
      }]);
      expect(response.body.issue[0].extension).toEqual([{
        url: 'http://hl7.org/fhir/StructureDefinition/operationoutcome-message-id',
        valueString: 'Unknown_Code_in_Version'
      }]);
      expect(response.body.issue[0].expression).toEqual(['codeB']);
    });
  });

  describe('POST /tx/r5/CodeSystem/$subsumes with Parameters resource', () => {
    test('should check subsumption using codingA and codingB', async () => {
      const response = await request(app)
        .post('/tx/r5/CodeSystem/$subsumes')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'codingA',
              valueCoding: {
                system: 'http://hl7.org/fhir/administrative-gender',
                code: 'male'
              }
            },
            {
              name: 'codingB',
              valueCoding: {
                system: 'http://hl7.org/fhir/administrative-gender',
                code: 'female'
              }
            }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('Parameters');

      const outcomeParam = response.body.parameter.find(p => p.name === 'outcome');
      expect(outcomeParam).toBeDefined();
    });

    test('should check subsumption using codeA, codeB, system in Parameters', async () => {
      const response = await request(app)
        .post('/tx/r5/CodeSystem/$subsumes')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
            { name: 'codeA', valueCode: 'male' },
            { name: 'codeB', valueCode: 'female' }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('Parameters');
    });

    test('should return 400 when codingA and codingB have different systems', async () => {
      const response = await request(app)
        .post('/tx/r5/CodeSystem/$subsumes')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'codingA',
              valueCoding: {
                system: 'http://hl7.org/fhir/administrative-gender',
                code: 'male'
              }
            },
            {
              name: 'codingB',
              valueCoding: {
                system: 'http://hl7.org/fhir/publication-status',
                code: 'active'
              }
            }
          ]
        });

      expect(response.status).toBe(400);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].extension[0].valueString).toBe('SUBSUMPTION_SYSTEM_MISMATCH');
      expect(response.body.issue[0].details.text).toContain('same code system');
    });
  });

  describe('GET /tx/r5/CodeSystem/:id/$subsumes', () => {
    test('should check subsumption by instance id', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/administrative-gender/$subsumes')
        .query({
          codeA: 'male',
          codeB: 'female'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('Parameters');

      const outcomeParam = response.body.parameter.find(p => p.name === 'outcome');
      expect(outcomeParam).toBeDefined();
    });

    test('should return 404 for non-existent CodeSystem id', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/nonexistent-id/$subsumes')
        .query({
          codeA: 'a',
          codeB: 'b'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(404);
      expect(response.body.resourceType).toBe('OperationOutcome');
    });

    test('should return 400 when codes are missing for instance subsumes', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/administrative-gender/$subsumes')
        .set('Accept', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body.resourceType).toBe('OperationOutcome');
    });
  });

  describe('POST /tx/r5/CodeSystem/:id/$subsumes', () => {
    test('should check subsumption by instance id with POST', async () => {
      const response = await request(app)
        .post('/tx/r5/CodeSystem/administrative-gender/$subsumes')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'codeA', valueCode: 'male' },
            { name: 'codeB', valueCode: 'female' }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('Parameters');
    });
  });

  describe('Response structure', () => {
    test('should return not-subsumed for different non-hierarchical codes', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$subsumes')
        .query({
          system: 'http://hl7.org/fhir/administrative-gender',
          codeA: 'male',
          codeB: 'female'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);

      const outcomeParam = response.body.parameter.find(p => p.name === 'outcome');
      // administrative-gender has no hierarchy, so different codes are not-subsumed
      expect(outcomeParam.valueCode).toBe('not-subsumed');
    });

    test('should return valid outcome values', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$subsumes')
        .query({
          system: 'http://hl7.org/fhir/administrative-gender',
          codeA: 'male',
          codeB: 'female'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);

      const outcomeParam = response.body.parameter.find(p => p.name === 'outcome');
      expect(outcomeParam.valueCode).toMatch(/^(equivalent|subsumes|subsumed-by|not-subsumed)$/);
    });
  });
});