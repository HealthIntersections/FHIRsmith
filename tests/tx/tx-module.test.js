/**
 * TX Module Integration Tests
 * 
 * Tests basic TX module functionality, metadata, and error handling
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp, getTxModule } = require('./setup');

describe('TX Module', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  describe('Initialization', () => {
    test('should initialize successfully', () => {
      const txModule = getTxModule();
      expect(txModule).toBeDefined();
      expect(txModule.endpoints.length).toBe(1);
      expect(txModule.endpoints[0].path).toBe('/tx/r5');
      expect(txModule.endpoints[0].fhirVersion).toBe('5.0');
    });

    test('should have languages loaded', () => {
      const txModule = getTxModule();
      expect(txModule.languages).toBeDefined();
    });

    test('should have i18n loaded', () => {
      const txModule = getTxModule();
      expect(txModule.i18n).toBeDefined();
    });
  });

  describe('GET /tx/r5/metadata', () => {
    test('should return CapabilityStatement', async () => {
      const response = await request(app)
        .get('/tx/r5/metadata')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('CapabilityStatement');
      expect(response.body.fhirVersion).toBe('5.0.0');
      expect(response.body.status).toBe('active');
      expect(response.body.kind).toBe('instance');
    });

    test('url and implementation.url reflect the client host + endpoint path', async () => {
      const response = await request(app)
        .get('/tx/r5/metadata')
        .set('Host', 'tx.example.org')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      // Must echo the host the client used, not a hardcoded value
      expect(response.body.implementation.url).toBe('http://tx.example.org/tx/r5');
      expect(response.body.url).toBe('http://tx.example.org/tx/r5/CapabilityStatement/tx');
    });

    test('should list supported resource types', async () => {
      const response = await request(app)
        .get('/tx/r5/metadata')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      
      const rest = response.body.rest[0];
      expect(rest.mode).toBe('server');
      
      const resourceTypes = rest.resource.map(r => r.type);
      expect(resourceTypes).toContain('CodeSystem');
      expect(resourceTypes).toContain('ValueSet');
      expect(resourceTypes).toContain('ConceptMap');
    });

    test('should list supported operations', async () => {
      const response = await request(app)
        .get('/tx/r5/metadata')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      
      const rest = response.body.rest[0];
      const codeSystem = rest.resource.find(r => r.type === 'CodeSystem');
      
      expect(codeSystem.operation).toBeDefined();
      const opNames = codeSystem.operation.map(o => o.name);
      expect(opNames).toContain('lookup');
      expect(opNames).toContain('validate-code');
      expect(opNames).toContain('subsumes');
    });

    test('advertises the $cache-control operation at the system level', async () => {
      const response = await request(app)
        .get('/tx/r5/metadata')
        .set('Accept', 'application/json');
      expect(response.status).toBe(200);

      const rest = response.body.rest[0];
      const systemOps = (rest.operation || []).map(o => o.name);
      expect(systemOps).toContain('cache-control');
      const cc = rest.operation.find(o => o.name === 'cache-control');
      expect(cc.definition).toBe('http://hl7.org/fhir/tools/OperationDefinition/cache-control');
    });

    test('does NOT advertise cache-id as an expansion parameter (old implicit protocol retired)', async () => {
      const response = await request(app)
        .get('/tx/r5/metadata')
        .query({ mode: 'terminology' })
        .set('Accept', 'application/json');
      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('TerminologyCapabilities');

      const expansionParams = ((response.body.expansion || {}).parameter || []).map(p => p.name);
      expect(expansionParams).not.toContain('cache-id');
      // tx-resource is still supported and still advertised
      expect(expansionParams).toContain('tx-resource');
    });

    test('advertises the $expand parameters the server actually reads', async () => {
      const response = await request(app)
        .get('/tx/r5/metadata')
        .query({ mode: 'terminology' })
        .set('Accept', 'application/json');
      expect(response.status).toBe(200);

      const expansionParams = ((response.body.expansion || {}).parameter || []).map(p => p.name);
      for (const name of ['url', 'valueSet', 'valueSetVersion', 'filter', 'designation', 'useSupplement',
        'default-valueset-version', 'check-valueset-version', 'force-valueset-version']) {
        expect(expansionParams).toContain(name);
      }
      // no duplicates
      expect(new Set(expansionParams).size).toBe(expansionParams.length);
    });
  });

  describe('GET /tx/r5/', () => {
    test('should return informational OperationOutcome', async () => {
      const response = await request(app)
        .get('/tx/r5/')
        .set('Accept', 'application/json');

      expect(response.status).toBe(200);
      expect(response.body.resourceType).toBe('OperationOutcome');
      expect(response.body.issue[0].severity).toBe('information');
      expect(response.body.issue[0].diagnostics).toContain('FHIR v5');
    });
  });

  describe('CORS', () => {
    test('should include CORS headers', async () => {
      const response = await request(app)
        .get('/tx/r5/metadata')
        .set('Accept', 'application/json');

      expect(response.headers['access-control-allow-origin']).toBe('*');
    });

    test('should handle OPTIONS request', async () => {
      const response = await request(app)
        .options('/tx/r5/metadata');

      expect(response.status).toBeLessThan(300);
    });

    // Regression: CORS must come from a single layer. If a module also sets
    // its own Access-Control-* headers, they appear twice with conflicting
    // values and browsers reject the request as a CORS failure.
    test('should not emit duplicate CORS headers', (done) => {
      const http = require('http');
      const server = app.listen(0, () => {
        const { port } = server.address();
        http.get({ port, path: '/tx/r5/metadata', headers: { Accept: 'application/json' } }, (res) => {
          res.resume();
          const names = res.rawHeaders.filter((_, i) => i % 2 === 0).map((h) => h.toLowerCase());
          const count = (name) => names.filter((h) => h === name).length;
          try {
            expect(count('access-control-allow-origin')).toBe(1);
            expect(count('access-control-allow-headers')).toBeLessThanOrEqual(1);
            expect(count('access-control-allow-methods')).toBeLessThanOrEqual(1);
            server.close(() => done());
          } catch (err) {
            server.close(() => done(err));
          }
        });
      });
    });
  });

  describe('Request ID', () => {
    test('should include X-Request-Id in all responses', async () => {
      const response = await request(app)
        .get('/tx/r5/metadata')
        .set('Accept', 'application/json');

      expect(response.headers['x-request-id']).toBeDefined();
      expect(response.headers['x-request-id']).toMatch(/^tx-\d+$/);
    });

    test('should generate unique request IDs', async () => {
      const response1 = await request(app)
        .get('/tx/r5/metadata')
        .set('Accept', 'application/json');

      const response2 = await request(app)
        .get('/tx/r5/metadata')
        .set('Accept', 'application/json');

      expect(response1.headers['x-request-id']).not.toBe(response2.headers['x-request-id']);
    });
  });

  describe('Unknown resources/operations', () => {
    test('should return 404 for unknown resource type path', async () => {
      const response = await request(app)
        .get('/tx/r5/UnknownResource')
        .set('Accept', 'application/json');

      expect(response.status).toBe(404);
    });

    test('should return 404 for unknown operation', async () => {
      const response = await request(app)
        .get('/tx/r5/CodeSystem/$unknown-operation')
        .set('Accept', 'application/json');

      expect(response.status).toBe(404);
      expect(response.body.resourceType).toBe('OperationOutcome');
    });
  });
});
