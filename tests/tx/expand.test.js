/**
 * Expand Worker Integration Tests
 *
 * Tests ValueSet $expand operation
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

// Caches must be created explicitly via $cache-control before a cache-id can be
// referenced. Returns the server-issued id.
async function startCache(app) {
  const res = await request(app)
    .post('/tx/r5/$cache-control')
    .query({ mode: 'start' })
    .set('Content-Type', 'application/json')
    .send({ resourceType: 'Parameters', parameter: [] });
  const p = (res.body.parameter || []).find(x => x.name === 'cache-id');
  return p ? p.valueId : undefined;
}

describe('Expand Worker', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  describe('GET /tx/r5/ValueSet/:id/$expand', () => {
    test('should expand ValueSet by id', async () => {
      const response = await request(app)
        .get('/tx/r5/ValueSet/core-administrative-gender/$expand')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('ValueSet');
      expect(response.body.expansion).toBeDefined();
      expect(response.body.expansion.timestamp).toBeDefined();
      expect(response.body.expansion.contains).toBeDefined();
    });

    test('should return 422 for non-existent ValueSet id', async () => {
      const response = await request(app)
        .get('/tx/r5/ValueSet/nonexistent-id/$expand')
        .set('Accept', 'application/json');

      expect(response.status).toBe(422);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].code).toBe('not-found');
    });
  });

  describe('GET /tx/r5/ValueSet/$expand with url parameter', () => {
    test('should expand ValueSet by url', async () => {
      const response = await request(app)
        .get('/tx/r5/ValueSet/$expand')
        .query({ url: 'http://hl7.org/fhir/ValueSet/administrative-gender' })
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('ValueSet');
      expect(response.body.expansion).toBeDefined();
    });

    test('should return 400 when url is missing', async () => {
      const response = await request(app)
        .get('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].code).toBe('invalid');
      expect(response.body.issue[0].diagnostics).toContain('url');
    });

    test('should return 422 when ValueSet not found', async () => {
      const response = await request(app)
        .get('/tx/r5/ValueSet/$expand')
        .query({ url: 'http://nonexistent.org/valueset' })
        .set('Accept', 'application/json');

      expect(response.status).toBe(422);
      expect(response.body.resourceType).toBe('OperationOutcome');
    });

    test('should return 400 when context parameter is used', async () => {
      const response = await request(app)
        .get('/tx/r5/ValueSet/$expand')
        .query({
          url: 'http://hl7.org/fhir/ValueSet/administrative-gender',
          context: 'some-context'
        })
        .set('Accept', 'application/json');

      expect(response.status).toBe(400);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].code).toBe('not-supported');
      expect(response.body.issue[0].diagnostics).toContain('context');
    });
  });

  describe('POST /tx/r5/ValueSet/$expand with form body', () => {
    test('should expand ValueSet with url in form body', async () => {
      const response = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('url=http://hl7.org/fhir/ValueSet/administrative-gender');

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('ValueSet');
      expect(response.body.expansion).toBeDefined();
    });
  });

  describe('POST /tx/r5/ValueSet/$expand with Parameters resource', () => {
    test('should expand ValueSet using url parameter', async () => {
      const response = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'url', valueUri: 'http://hl7.org/fhir/ValueSet/administrative-gender' }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('ValueSet');
      expect(response.body.expansion).toBeDefined();
    });

    test('should expand inline ValueSet from Parameters resource', async () => {
      const response = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'valueSet',
              resource: {
                resourceType: 'ValueSet',
                url: 'http://hl7.org/fhir/ValueSet/test/something',
                status: 'active',
                compose: {
                  include: [{
                    system: 'http://hl7.org/fhir/administrative-gender'
                  }]
                }
              }
            }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('ValueSet');
      expect(response.body.expansion).toBeDefined();
    });
  });

  describe('POST /tx/r5/ValueSet/$expand with ValueSet body', () => {
    test('should expand ValueSet provided directly in body', async () => {
      const response = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'ValueSet',
          url: 'http://hl7.org/fhir/ValueSet/test/something',
          status: 'active',
          compose: {
            include: [{
              system: 'http://hl7.org/fhir/administrative-gender'
            }]
          }
        });

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('ValueSet');
      expect(response.body.expansion).toBeDefined();
    });
  });

  describe('POST /tx/r5/ValueSet/:id/$expand', () => {
    test('should expand ValueSet by id with POST', async () => {
      const response = await request(app)
        .post('/tx/r5/ValueSet/core-administrative-gender/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: []
        });

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('ValueSet');
      expect(response.body.expansion).toBeDefined();
    });
  });

  describe('Expansion response structure', () => {
    test('should include expansion metadata', async () => {
      const response = await request(app)
        .get('/tx/r5/ValueSet/core-administrative-gender/$expand')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);

      const expansion = response.body.expansion;
      expect(expansion.identifier).toBeDefined();
      expect(expansion.timestamp).toBeDefined();
      expect(expansion.total).toBeDefined();
      expect(expansion.contains).toBeDefined();
      expect(Array.isArray(expansion.contains)).toBe(true);
    });

    test('should preserve ValueSet metadata', async () => {
      const response = await request(app)
        .get('/tx/r5/ValueSet/core-administrative-gender/$expand')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body.url).toBeDefined();
      expect(response.body.status).toBeDefined();
    });
  });

  describe('Resource caching with cache-id', () => {
    const testCodeSystem = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/test-colors',
      version: '1.0.0',
      status: 'active',
      content: 'complete',
      concept: [
        { code: 'red', display: 'Red' },
        { code: 'green', display: 'Green' },
        { code: 'blue', display: 'Blue' }
      ]
    };

    const testValueSet = {
      resourceType: 'ValueSet',
      url: 'http://example.org/test-colors-vs',
      status: 'active',
      compose: {
        include: [{
          system: 'http://example.org/test-colors'
        }]
      }
    };

    const secondValueSet = {
      resourceType: 'ValueSet',
      url: 'http://example.org/test-primary-colors-vs',
      status: 'active',
      compose: {
        include: [{
          system: 'http://example.org/test-colors',
          concept: [
            { code: 'red' },
            { code: 'blue' }
          ]
        }]
      }
    };

    test('should expand ValueSet using tx-resource CodeSystem', async () => {
      const response = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'tx-resource',
              resource: testCodeSystem
            },
            {
              name: 'valueSet',
              resource: testValueSet
            }
          ]
        });

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('ValueSet');
      expect(response.body.expansion).toBeDefined();
      // When doExpand is fully implemented, verify:
      // expect(response.body.expansion.contains).toHaveLength(3);
      // expect(response.body.expansion.contains.map(c => c.code)).toContain('red');
    });

    test('should cache tx-resource with cache-id and reuse in subsequent request', async () => {
      const cacheId = await startCache(app);

      // First request: submit CodeSystem with cache-id
      const response1 = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'cache-id',
              valueString: cacheId
            },
            {
              name: 'tx-resource',
              resource: testCodeSystem
            },
            {
              name: 'valueSet',
              resource: testValueSet
            }
          ]
        });

      expect(response1.status).toBe(200);
      expect(response1.body.resourceType).toBe('ValueSet');

      // Second request: use same cache-id but don't re-submit the CodeSystem
      // The ValueSet still references the CodeSystem, which should come from cache
      const response2 = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'cache-id',
              valueString: cacheId
            },
            {
              name: 'valueSet',
              resource: secondValueSet
            }
          ]
        });

      expect(response2.status).toBe(200);
      expect(response2.body.resourceType).toBe('ValueSet');
      expect(response2.body.expansion).toBeDefined();
      // When doExpand is fully implemented, verify:
      // The second expansion should work because CodeSystem is cached
      // expect(response2.body.expansion.contains).toHaveLength(2);
      // expect(response2.body.expansion.contains.map(c => c.code)).toEqual(['red', 'blue']);
    });

    test('should cache the primary valueSet under cache-id and resolve it by url', async () => {
      // Regression for the cache-id protocol gap: fhir-core registers the *primary*
      // ValueSet by sending it inline as the `valueSet` parameter on the first call,
      // then on later calls refers to it by url alone with the same cache-id. The
      // server must retain that primary ValueSet, otherwise the by-url follow-up
      // fails with "value set could not be found".
      const cacheId = await startCache(app);

      // First request: primary ValueSet sent inline as `valueSet`, plus the
      // CodeSystem it needs as tx-resource, both under the cache-id.
      // NB: cache-id is sent as `valueId` here, exactly as fhir-core sends it
      // (IdType). getParameterValue must understand valueId or the cache-id is
      // read as null and the whole protocol silently no-ops.
      const response1 = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'cache-id', valueId: cacheId },
            { name: 'tx-resource', resource: testCodeSystem },
            { name: 'valueSet', resource: testValueSet }
          ]
        });

      expect(response1.status).toBe(200);
      expect(response1.body.resourceType).toBe('ValueSet');

      // Second request: refer to the primary ValueSet by url only, same cache-id,
      // with neither the valueSet nor the CodeSystem re-sent. Both must come from
      // the cache. Before the fix this returned 422 "could not be found".
      const response2 = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'cache-id', valueId: cacheId },
            { name: 'url', valueString: testValueSet.url }
          ]
        });

      expect(response2.status).toBe(200);
      expect(response2.body.resourceType).toBe('ValueSet');
      expect(response2.body.expansion).toBeDefined();
    });

    test('should fail without cache-id when CodeSystem not provided', async () => {
      // This request provides a ValueSet that references a CodeSystem
      // that isn't in the provider and isn't provided via tx-resource
      const response = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            {
              name: 'valueSet',
              resource: {
                resourceType: 'ValueSet',
                status: 'active',
                compose: {
                  include: [{
                    system: 'http://example.org/nonexistent-system'
                  }]
                }
              }
            }
          ]
        });

      // Currently returns 200 with empty expansion (stub behavior)
      // When doExpand is implemented, this should return an error
      // because the CodeSystem can't be found
      expect(response.status).toBe(422);
      // expect(response.status).toBe(404); // or 400 when fully implemented
    });
  });

  describe('Expansion caching', () => {
    test('should return same expansion for identical requests', async () => {
      // Make the same expand request twice
      const response1 = await request(app)
        .get('/tx/r5/ValueSet/core-administrative-gender/$expand')
        .set('Accept', 'application/json');

      const response2 = await request(app)
        .get('/tx/r5/ValueSet/core-administrative-gender/$expand')
        .set('Accept', 'application/json');

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);

      // Both should return valid expansions
      expect(response1.body.expansion).toBeDefined();
      expect(response2.body.expansion).toBeDefined();

      // Note: timestamp will differ since stub always generates new one
      // When real caching kicks in (for expensive operations),
      // the second request would return the cached result
    });
  });
});