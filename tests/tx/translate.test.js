/**
 * Translate Worker Integration Tests
 *
 * Tests ConceptMap $translate operation
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

describe('Translate Worker', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  describe('GET /tx/r5/ConceptMap/$translate', () => {
    // This used ConceptMap/example2, whose sourceScopeUri names http://example.org/fhir/example1
    // - an invented example identifier that is not a ValueSet anywhere. ConceptMap.sourceScope
    // limits the map to codes that are members of that value set, so a scope that cannot be
    // resolved cannot be evaluated, and the operation fails rather than guessing. sc-flag-status
    // is used instead: its scope resolves, so the map can actually be applied and the test
    // asserts a translation rather than merely a response.
    test('should translate code with url, system, and sourceCode parameters', async () => {
      const response = await request(app)
        .get('/tx/r5/ConceptMap/$translate')
        .query({
          url: 'http://hl7.org/fhir/ConceptMap/sc-flag-status',
          sourceSystem: 'http://hl7.org/fhir/flag-status',
          sourceCode: 'active'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('Parameters');

      const resultParam = response.body.parameter.find(p => p.name === 'result');
      expect(resultParam).toBeDefined();
      expect(resultParam.valueBoolean).toBe(true);

      const match = response.body.parameter.find(p => p.name === 'match');
      expect(match).toBeDefined();
      const concept = match.part.find(p => p.name === 'concept');
      expect(concept.valueCoding.code).toBe('active');
    });

    test('should return 400 when sourceCode provided without system', async () => {
      const response = await request(app)
        .get('/tx/r5/ConceptMap/$translate')
        .query({
          url: 'http://hl7.org/fhir/ConceptMap/example',
          sourceCode: 'source-code'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].code).toBe('invalid');
      expect(response.body.issue[0].details.text).toContain('system parameter is required');
    });

    test('should return 400 when no source code/coding provided', async () => {
      const response = await request(app)
        .get('/tx/r5/ConceptMap/$translate')
        .query({
          url: 'http://hl7.org/fhir/ConceptMap/example'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].code).toBe('invalid');
    });

    test('should return 404 when ConceptMap not found', async () => {
      const response = await request(app)
        .get('/tx/r5/ConceptMap/$translate')
        .query({
          url: 'http://nonexistent.org/ConceptMap/test',
          sourceSystem: 'http://example.org/source',
          sourceCode: 'test'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(404);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].code).toBe('not-found');
    });

    test('should not return 404 when no suitable ConceptMap found for source/target', async () => {
      const response = await request(app)
        .get('/tx/r5/ConceptMap/$translate')
        .query({
          sourceSystem: 'http://nonexistent.org/source',
          sourceCode: 'test',
          targetSystem: 'http://nonexistent.org/target'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('Parameters');
    });

    test('should support version parameter for ConceptMap', async () => {
      const response = await request(app)
        .get('/tx/r5/ConceptMap/$translate')
        .query({
          url: 'http://hl7.org/fhir/ConceptMap/example',
          conceptMapVersion: '1.0.0',
          sourceSystem: 'http://example.org/source',
          sourceCode: 'source-code'
        })
        .set('Accept', 'application/json');

      // Should either succeed or return not-found for version
      expect([200, 404]).toContain(response.status);
      expect(response.body.resourceType).toMatch(/^(Parameters|OperationOutcome)$/);
    });

    test('should support targetSystem parameter', async () => {
      const response = await request(app)
        .get('/tx/r5/ConceptMap/$translate')
        .query({
          url: 'http://hl7.org/fhir/ConceptMap/example',
          sourceSystem: 'http://example.org/source',
          sourceCode: 'source-code',
          targetSystem: 'http://example.org/target'
        })
        .set('Accept', 'application/json');

      expect([200, 404]).toContain(response.status);
    });

    test('should support sourceScope parameter', async () => {
      const response = await request(app)
        .get('/tx/r5/ConceptMap/$translate')
        .query({
          sourceSystem: 'http://example.org/source',
          sourceCode: 'source-code',
          sourceScope: 'http://example.org/ValueSet/source-vs'
        })
        .set('Accept', 'application/json');

      expect([200, 404]).toContain(response.status);
    });

    test('should support targetScope parameter', async () => {
      const response = await request(app)
        .get('/tx/r5/ConceptMap/$translate')
        .query({
          sourceSystem: 'http://example.org/source',
          sourceCode: 'source-code',
          targetScope: 'http://example.org/ValueSet/target-vs'
        })
        .set('Accept', 'application/json');

      expect([200, 404]).toContain(response.status);
    });
  });

  describe('POST /tx/r5/ConceptMap/$translate with Parameters resource', () => {
    test('should translate using sourceCoding parameter', async () => {
      const response = await request(app)
        .post('/tx/r5/ConceptMap/$translate')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'url',
              valueUri: 'http://hl7.org/fhir/ConceptMap/example'
            },
            {
              name: 'sourceCoding',
              valueCoding: {
                system: 'http://example.org/source',
                code: 'source-code'
              }
            }
          ]
        });

      expect([200, 404]).toContain(response.status);
      expect(response.body.resourceType).toMatch(/^(Parameters|OperationOutcome)$/);
    });

    test('should translate using sourceCodeableConcept parameter', async () => {
      const response = await request(app)
        .post('/tx/r5/ConceptMap/$translate')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'url',
              valueUri: 'http://hl7.org/fhir/ConceptMap/example'
            },
            {
              name: 'sourceCodeableConcept',
              valueCodeableConcept: {
                coding: [
                  {
                    system: 'http://example.org/source',
                    code: 'source-code',
                    display: 'Source Code'
                  }
                ]
              }
            }
          ]
        });

      expect([200, 404]).toContain(response.status);
    });

    test('should return 400 for sourceCodeableConcept without codings', async () => {
      const response = await request(app)
        .post('/tx/r5/ConceptMap/$translate')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'url',
              valueUri: 'http://hl7.org/fhir/ConceptMap/example'
            },
            {
              name: 'sourceCodeableConcept',
              valueCodeableConcept: {
                text: 'Just text, no coding'
              }
            }
          ]
        });

      expect(response.status).toBe(400);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].details.text).toContain('coding');
    });

    test('should translate using sourceCode and system in Parameters', async () => {
      const response = await request(app)
        .post('/tx/r5/ConceptMap/$translate')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'url', valueUri: 'http://hl7.org/fhir/ConceptMap/example' },
            { name: 'sourceSystem', valueUri: 'http://example.org/source' },
            { name: 'sourceCode', valueCode: 'source-code' }
          ]
        });

      expect([200, 404]).toContain(response.status);
    });

    test('should accept wrong parameter types with lenient parsing', async () => {
      // Using valueString instead of valueUri for system - should still work
      const response = await request(app)
        .post('/tx/r5/ConceptMap/$translate')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'url', valueString: 'http://hl7.org/fhir/ConceptMap/example' },
            { name: 'sourceSystem', valueString: 'http://example.org/source' },
            { name: 'sourceCode', valueString: 'source-code' }
          ]
        });

      expect([200, 404]).toContain(response.status);
    });

    test('should support dependency parameter', async () => {
      const response = await request(app)
        .post('/tx/r5/ConceptMap/$translate')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'url', valueUri: 'http://hl7.org/fhir/ConceptMap/example' },
            {
              name: 'sourceCoding',
              valueCoding: {
                system: 'http://example.org/source',
                code: 'source-code'
              }
            },
            {
              name: 'dependency',
              part: [
                { name: 'attribute', valueUri: 'http://example.org/attribute' },
                {
                  name: 'value',
                  valueCoding: {
                    system: 'http://example.org/dep-system',
                    code: 'dep-code'
                  }
                }
              ]
            }
          ]
        });

      expect([200, 404]).toContain(response.status);
    });
  });

  describe('GET /tx/r5/ConceptMap/:id/$translate', () => {
    test('should translate by instance id', async () => {
      const response = await request(app)
        .get('/tx/r5/ConceptMap/example2/$translate')
        .query({
          system: 'http://example.org/source',
          sourceCode: 'source-code'
        })
        .set('Accept', 'application/json');

      expect([200, 404]).toContain(response.status);
    });

    test('should return 404 for non-existent ConceptMap id', async () => {
      const response = await request(app)
        .get('/tx/r5/ConceptMap/nonexistent-id/$translate')
        .query({
          system: 'http://example.org/source',
          sourceCode: 'test'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(404);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].details.text).toContain('nonexistent-id');
    });

    test('should return 400 when source code/coding is missing for instance translate', async () => {
      const response = await request(app)
        .get('/tx/r5/ConceptMap/example2/$translate')
        .set('Accept', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body.resourceType).toBe('OperationOutcome');
    });

    test('should translate by instance id with sourceCoding', async () => {
      const response = await request(app)
        .post('/tx/r5/ConceptMap/example/$translate')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'sourceCoding',
              valueCoding: {
                system: 'http://example.org/source',
                code: 'source-code'
              }
            }
          ]
        });

      expect([200, 404]).toContain(response.status);
    });
  });

  describe('POST /tx/r5/ConceptMap/:id/$translate', () => {
    test('should translate by instance id with POST', async () => {
      const response = await request(app)
        .post('/tx/r5/ConceptMap/example/$translate')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'system', valueUri: 'http://example.org/source' },
            { name: 'sourceCode', valueCode: 'source-code' }
          ]
        });

      expect([200, 404]).toContain(response.status);
    });
  });

  describe('Response structure', () => {
    test('should return result parameter as boolean', async () => {
      const response = await request(app)
        .get('/tx/r5/ConceptMap/$translate')
        .query({
          url: 'http://hl7.org/fhir/ConceptMap/example',
          system: 'http://example.org/source',
          sourceCode: 'source-code'
        })
        .set('Accept', 'application/json');

      if (response.status === 200) {
        const resultParam = response.body.parameter.find(p => p.name === 'result');
        expect(resultParam).toBeDefined();
        expect(typeof resultParam.valueBoolean).toBe('boolean');
      }
    });

    test('should return message when no translation found', async () => {
      const response = await request(app)
        .get('/tx/r5/ConceptMap/$translate')
        .query({
          url: 'http://hl7.org/fhir/ConceptMap/example',
          system: 'http://example.org/source',
          sourceCode: 'unmapped-code'
        })
        .set('Accept', 'application/json');

      if (response.status === 200) {
        const resultParam = response.body.parameter.find(p => p.name === 'result');
        if (resultParam && resultParam.valueBoolean === false) {
          const messageParam = response.body.parameter.find(p => p.name === 'message');
          expect(messageParam).toBeDefined();
          expect(messageParam.valueString).toBeDefined();
        }
      }
    });

    test('should return match parameters when translation found', async () => {
      const response = await request(app)
        .get('/tx/r5/ConceptMap/$translate')
        .query({
          url: 'http://hl7.org/fhir/ConceptMap/example',
          system: 'http://example.org/source',
          sourceCode: 'source-code'
        })
        .set('Accept', 'application/json');

      if (response.status === 200) {
        const resultParam = response.body.parameter.find(p => p.name === 'result');
        if (resultParam && resultParam.valueBoolean === true) {
          const matchParams = response.body.parameter.filter(p => p.name === 'match');
          expect(matchParams.length).toBeGreaterThan(0);

          // Each match should have relationship and concept parts
          for (const match of matchParams) {
            expect(match.part).toBeDefined();
            expect(Array.isArray(match.part)).toBe(true);

            const relationshipPart = match.part.find(p => p.name === 'relationship');
            expect(relationshipPart).toBeDefined();
            expect(relationshipPart.valueCode).toMatch(
              /^(related-to|equivalent|source-is-narrower-than-target|source-is-broader-than-target|not-related-to)$/
            );

            const conceptPart = match.part.find(p => p.name === 'concept');
            if (conceptPart) {
              expect(conceptPart.valueCoding).toBeDefined();
              expect(conceptPart.valueCoding.system).toBeDefined();
              expect(conceptPart.valueCoding.code).toBeDefined();
            }
          }
        }
      }
    });

    test('should include source in match when available', async () => {
      const response = await request(app)
        .get('/tx/r5/ConceptMap/$translate')
        .query({
          url: 'http://hl7.org/fhir/ConceptMap/example',
          system: 'http://example.org/source',
          sourceCode: 'source-code'
        })
        .set('Accept', 'application/json');

      if (response.status === 200) {
        const matchParams = response.body.parameter.filter(p => p.name === 'match');
        for (const match of matchParams) {
          const sourcePart = match.part?.find(p => p.name === 'source');
          // source is optional but if present should be a canonical URI
          if (sourcePart) {
            expect(sourcePart.valueUri || sourcePart.valueCanonical).toBeDefined();
          }
        }
      }
    });
  });

  describe('Edge cases', () => {
    test('should handle empty coding in sourceCodeableConcept', async () => {
      const response = await request(app)
        .post('/tx/r5/ConceptMap/$translate')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'url',
              valueUri: 'http://hl7.org/fhir/ConceptMap/example'
            },
            {
              name: 'sourceCodeableConcept',
              valueCodeableConcept: {
                coding: []
              }
            }
          ]
        });

      expect(response.status).toBe(400);
      expect(response.body.resourceType).toBe('OperationOutcome');
    });

    test('should handle sourceCoding without code', async () => {
      const response = await request(app)
        .post('/tx/r5/ConceptMap/$translate')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'url',
              valueUri: 'http://hl7.org/fhir/ConceptMap/example'
            },
            {
              name: 'sourceCoding',
              valueCoding: {
                system: 'http://example.org/source'
                // no code
              }
            }
          ]
        });

      // Should either handle gracefully or return 400
      expect([200, 400, 404]).toContain(response.status);
    });

    test('should handle multiple dependency parameters', async () => {
      const response = await request(app)
        .post('/tx/r5/ConceptMap/$translate')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'url', valueUri: 'http://hl7.org/fhir/ConceptMap/example' },
            {
              name: 'sourceCoding',
              valueCoding: {
                system: 'http://example.org/source',
                code: 'source-code'
              }
            },
            {
              name: 'dependency',
              part: [
                { name: 'attribute', valueUri: 'http://example.org/attr1' },
                { name: 'value', valueCoding: { system: 'http://example.org/s1', code: 'c1' } }
              ]
            },
            {
              name: 'dependency',
              part: [
                { name: 'attribute', valueUri: 'http://example.org/attr2' },
                { name: 'value', valueCoding: { system: 'http://example.org/s2', code: 'c2' } }
              ]
            }
          ]
        });

      expect([200, 404]).toContain(response.status);
    });

    test('should handle version in sourceCoding', async () => {
      const response = await request(app)
        .post('/tx/r5/ConceptMap/$translate')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'url',
              valueUri: 'http://hl7.org/fhir/ConceptMap/example'
            },
            {
              name: 'sourceCoding',
              valueCoding: {
                system: 'http://example.org/source',
                version: '1.0.0',
                code: 'source-code'
              }
            }
          ]
        });

      expect([200, 404]).toContain(response.status);
    });
  });
});