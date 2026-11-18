/**
 * Lookup Worker Integration Tests
 * 
 * Tests CodeSystem $lookup operation
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

describe('Lookup Worker', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  describe('GET /tx/r5/CodeSystem/$lookup', () => {
    test('should lookup code with system and code parameters', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$lookup')
        .query({ 
          system: 'http://hl7.org/fhir/administrative-gender',
          code: 'male'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('Parameters');
      
      const params = response.body.parameter;
      expect(params).toBeDefined();
      
      // Check required parameters
      const nameParam = params.find(p => p.name === 'name');
      expect(nameParam).toBeDefined();
      expect(nameParam.valueString).toBeDefined();
      
      const displayParam = params.find(p => p.name === 'display');
      expect(displayParam).toBeDefined();
      expect(displayParam.valueString).toBe('Male');
    });

    test('should include version when available', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$lookup')
        .query({ 
          system: 'http://hl7.org/fhir/administrative-gender',
          code: 'female'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      
      const params = response.body.parameter;
      const versionParam = params.find(p => p.name === 'version');
      // Version may or may not be present depending on CodeSystem
      if (versionParam) {
        expect(versionParam.valueString).toBeDefined();
      }
    });

    test('should return 400 when system is missing', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$lookup')
        .query({ code: 'male' })
        .set('Accept', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].code).toBe('invalid');
    });

    test('should return 400 when code is missing', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$lookup')
        .query({ system: 'http://hl7.org/fhir/administrative-gender' })
        .set('Accept', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body.resourceType).toBe('OperationOutcome');
    });

    test('should return 404 when code not found', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$lookup')
        .query({ 
          system: 'http://hl7.org/fhir/administrative-gender',
          code: 'nonexistent-code'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(404);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].code).toBe('not-found');
    });

    test('should return 422 when system not found', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$lookup')
        .query({ 
          system: 'http://nonexistent.org/codesystem',
          code: 'test'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(422);
      expect(response.body.resourceType).toBe('OperationOutcome');
    });

    test('should filter properties when property parameter is provided', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$lookup')
        .query({ 
          system: 'http://hl7.org/fhir/administrative-gender',
          code: 'male',
          property: 'inactive'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      
      const params = response.body.parameter;
      
      // Should have inactive property
      const inactiveProps = params.filter(p => 
        p.name === 'property' && 
        p.part?.find(pp => pp.name === 'code' && pp.valueCode === 'inactive')
      );
      expect(inactiveProps.length).toBe(1);
      
      // Should NOT have definition (not requested)
      const definitionParam = params.find(p => p.name === 'definition');
      expect(definitionParam).toBeUndefined();
    });
  });

  describe('POST /tx/r5/CodeSystem/$lookup with Parameters resource', () => {
    test('should lookup using coding parameter', async () => {
      const response = await request(app)
        .post('/tx/r5/CodeSystem/$lookup')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'coding',
              valueCoding: {
                system: 'http://hl7.org/fhir/administrative-gender',
                code: 'female'
              }
            }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('Parameters');
      
      const displayParam = response.body.parameter.find(p => p.name === 'display');
      expect(displayParam).toBeDefined();
      expect(displayParam.valueString).toBe('Female');
    });

    test('should lookup using system and code parameters in Parameters', async () => {
      const response = await request(app)
        .post('/tx/r5/CodeSystem/$lookup')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
            { name: 'code', valueCode: 'other' }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('Parameters');
      
      const displayParam = response.body.parameter.find(p => p.name === 'display');
      expect(displayParam).toBeDefined();
      expect(displayParam.valueString).toBe('Other');
    });

    test('should accept wrong parameter types with lenient parsing', async () => {
      // Using valueString instead of valueUri for system - should still work
      const response = await request(app)
        .post('/tx/r5/CodeSystem/$lookup')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'system', valueString: 'http://hl7.org/fhir/administrative-gender' },
            { name: 'code', valueString: 'unknown' }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('Parameters');
    });

    test('should support repeating property parameter', async () => {
      const response = await request(app)
        .post('/tx/r5/CodeSystem/$lookup')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
            { name: 'code', valueCode: 'male' },
            { name: 'property', valueCode: 'inactive' },
            { name: 'property', valueCode: 'abstract' }
          ]
        });

      expect(response.status).toBe(200);
    });
  });

  describe('GET /tx/r5/CodeSystem/:id/$lookup', () => {
    test('should lookup by instance id', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/core-administrative-gender/$lookup')
        .query({ code: 'male' })
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('Parameters');
      
      const displayParam = response.body.parameter.find(p => p.name === 'display');
      expect(displayParam.valueString).toBe('Male');
    });

    test('should return 404 for non-existent CodeSystem id', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/nonexistent-id/$lookup')
        .query({ code: 'test' })
        .set('Accept', 'application/json');

      expect(response.status).toBe(404);
      expect(response.body.resourceType).toBe('OperationOutcome');
    });

    test('should return 400 when code is missing for instance lookup', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/core-administrative-gender/$lookup')
        .set('Accept', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body.resourceType).toBe('OperationOutcome');
    });
  });

  describe('POST /tx/r5/CodeSystem/:id/$lookup', () => {
    test('should lookup by instance id with POST', async () => {
      const response = await request(app)
        .post('/tx/r5/CodeSystem/core-administrative-gender/$lookup')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'code', valueCode: 'female' }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('Parameters');
    });
  });

  describe('Property filtering', () => {
    test('should return all default properties when no property param', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$lookup')
        .query({ 
          system: 'http://hl7.org/fhir/administrative-gender',
          code: 'male'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      
      const params = response.body.parameter;
      
      // Should have name (required)
      expect(params.find(p => p.name === 'name')).toBeDefined();
      
      // Should have display (required)
      expect(params.find(p => p.name === 'display')).toBeDefined();
      
      // Should have inactive property by default
      const props = params.filter(p => p.name === 'property');
      const inactiveProp = props.find(p => 
        p.part?.find(pp => pp.name === 'code' && pp.valueCode === 'inactive')
      );
      expect(inactiveProp).toBeDefined();
    });

    test('should support wildcard property', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$lookup')
        .query({ 
          system: 'http://hl7.org/fhir/administrative-gender',
          code: 'male',
          property: '*'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      // Should include all available properties
    });
  });
});
