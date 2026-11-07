/**
 * cache-id protocol integration tests (HTTP, end-to-end)
 *
 * The cache-id protocol lets a client send a CodeSystem/ValueSet once under a
 * `cache-id`, then refer to it by url on later requests with the same cache-id.
 * This is in routine use by every fhir-core consumer, so it must be exercised hard.
 *
 * Background on the two bugs these tests guard:
 *   1. fhir-core sends cache-id as an IdType -> {"name":"cache-id","valueId":"..."}.
 *      If the server can't read valueId, cacheId is null and the whole protocol
 *      silently no-ops, so every by-reference call fails "could not be found".
 *   2. The server must cache the primary `valueSet` parameter (not only
 *      `tx-resource`), or the by-reference follow-up can't resolve the main VS.
 *
 * These run over real HTTP against the test app (R5 core auto-loaded).
 */

const request = require('supertest');
const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');

const VALIDATE = '/tx/r5/ValueSet/$validate-code';
const EXPAND = '/tx/r5/ValueSet/$expand';

// Self-contained fixtures so we don't depend on what's in the core package.
const colorsCS = {
  resourceType: 'CodeSystem',
  url: 'http://example.org/cache-id-test/colors',
  version: '1.0.0',
  status: 'active',
  content: 'complete',
  concept: [
    { code: 'red', display: 'Red' },
    { code: 'green', display: 'Green' },
    { code: 'blue', display: 'Blue' }
  ]
};

const colorsVS = {
  resourceType: 'ValueSet',
  url: 'http://example.org/cache-id-test/colors-vs',
  version: '1.0.0',
  status: 'active',
  compose: { include: [{ system: colorsCS.url }] }
};

// Send cache-id either as valueId (fhir-core's real format) or valueString.
function cacheIdParam(value, as) {
  return as === 'valueString'
    ? { name: 'cache-id', valueString: value }
    : { name: 'cache-id', valueId: value };
}

function post(app, url, parameter) {
  return request(app)
    .post(url)
    .set('Accept', 'application/json')
    .set('Content-Type', 'application/json')
    .send({ resourceType: 'Parameters', parameter });
}

// Create a real cache via $cache-control and return its server-issued id. Caches
// must now exist before they can be referenced; this is how a client gets one.
async function startCache(app, parameter = []) {
  const res = await request(app)
    .post('/tx/r5/$cache-control')
    .query({ mode: 'start' })
    .set('Accept', 'application/json')
    .set('Content-Type', 'application/json')
    .send({ resourceType: 'Parameters', parameter });
  const p = (res.body.parameter || []).find(x => x.name === 'cache-id');
  return p ? p.valueId : undefined;
}

// Pull the boolean `result` out of a $validate-code Parameters response.
function resultOf(body) {
  if (!body || body.resourceType !== 'Parameters') return undefined;
  const p = (body.parameter || []).find(x => x.name === 'result');
  return p ? p.valueBoolean : undefined;
}

// True if the response is the coded "unknown cache" error.
function isUnknownCacheError(res) {
  if (res.body.resourceType !== 'OperationOutcome') return false;
  return (res.body.issue || []).some(i =>
    (i.details && (i.details.coding || []).some(c => c.code === 'cache-id-unknown')));
}

describe('cache-id protocol (integration)', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  // The headline regression: cache-id as valueId, register inline then validate by url.
  describe.each([
    ['valueId (fhir-core wire format)', 'valueId'],
    ['valueString', 'valueString'],
  ])('$validate-code round trip with cache-id as %s', (_label, as) => {
    test('register CS+VS under cache-id, then validate a valid code by url', async () => {
      const cid = await startCache(app);

      // 1st call: send CS (tx-resource) and the primary VS (inline) under cache-id.
      const r1 = await post(app, VALIDATE, [
        cacheIdParam(cid, as),
        { name: 'tx-resource', resource: colorsCS },
        { name: 'valueSet', resource: colorsVS },
        { name: 'coding', valueCoding: { system: colorsCS.url, code: 'red' } }
      ]);
      expect(r1.status).toBe(200);
      expect(resultOf(r1.body)).toBe(true);

      // 2nd call: refer to the VS by url only, same cache-id, nothing re-sent.
      const r2 = await post(app, VALIDATE, [
        cacheIdParam(cid, as),
        { name: 'url', valueString: colorsVS.url },
        { name: 'coding', valueCoding: { system: colorsCS.url, code: 'red' } }
      ]);
      expect(r2.status).toBe(200);
      expect(resultOf(r2.body)).toBe(true);
    });

    test('by-reference validation of an invalid code returns result=false (really validating)', async () => {
      const cid = await startCache(app);
      await post(app, VALIDATE, [
        cacheIdParam(cid, as),
        { name: 'tx-resource', resource: colorsCS },
        { name: 'valueSet', resource: colorsVS },
        { name: 'coding', valueCoding: { system: colorsCS.url, code: 'red' } }
      ]);

      const r2 = await post(app, VALIDATE, [
        cacheIdParam(cid, as),
        { name: 'url', valueString: colorsVS.url },
        { name: 'coding', valueCoding: { system: colorsCS.url, code: 'magenta' } }
      ]);
      expect(r2.status).toBe(200);
      expect(resultOf(r2.body)).toBe(false);
    });
  });

  describe('unknown cache-id is a specific, coded, server-authoritative error', () => {
    test('a started cache resolves by url; a never-issued cache-id is the coded unknown-cache error', async () => {
      const cid = await startCache(app);
      // Register under the started cache.
      const reg = await post(app, VALIDATE, [
        cacheIdParam(cid, 'valueId'),
        { name: 'tx-resource', resource: colorsCS },
        { name: 'valueSet', resource: colorsVS },
        { name: 'coding', valueCoding: { system: colorsCS.url, code: 'green' } }
      ]);
      expect(resultOf(reg.body)).toBe(true);

      // Same cache-id, by url -> resolves from cache.
      const same = await post(app, VALIDATE, [
        cacheIdParam(cid, 'valueId'),
        { name: 'url', valueString: colorsVS.url },
        { name: 'coding', valueCoding: { system: colorsCS.url, code: 'green' } }
      ]);
      expect(resultOf(same.body)).toBe(true);

      // A cache-id the server never issued -> coded unknown-cache error, NOT a
      // silent success and NOT an obscure "value set not found".
      const other = await post(app, VALIDATE, [
        { name: 'cache-id', valueId: 'never-issued-this-cache' },
        { name: 'url', valueString: colorsVS.url },
        { name: 'coding', valueCoding: { system: colorsCS.url, code: 'green' } }
      ]);
      expect(other.status).toBe(404);
      expect(isUnknownCacheError(other)).toBe(true);
    });

    test('unknown cache-id supplied via the x-cache-id header is also the coded error', async () => {
      const res = await request(app)
        .post(VALIDATE)
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', 'never-issued-this-cache')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'url', valueString: colorsVS.url },
            { name: 'coding', valueCoding: { system: colorsCS.url, code: 'green' } }
          ]
        });
      expect(res.status).toBe(404);
      expect(isUnknownCacheError(res)).toBe(true);
    });

    test('$expand with an unknown cache-id is the coded error too', async () => {
      const res = await post(app, EXPAND, [
        { name: 'cache-id', valueId: 'never-issued-this-cache' },
        { name: 'url', valueString: colorsVS.url }
      ]);
      expect(res.status).toBe(404);
      expect(isUnknownCacheError(res)).toBe(true);
    });

    test('CodeSystem/$validate-code with an unknown cache-id is answered (it used to never respond)', async () => {
      const res = await request(app).post('/tx/r5/CodeSystem/$validate-code').timeout(10000)
        .set('Content-Type', 'application/json')
        .send({ resourceType: 'Parameters', parameter: [
          { name: 'cache-id', valueId: 'never-issued-this-cache' },
          { name: 'coding', valueCoding: { system: 'http://hl7.org/fhir/administrative-gender', code: 'male' } }
        ] });
      expect(res.status).toBe(404);
      expect(isUnknownCacheError(res)).toBe(true);
    });

    test('a request that would take a cache past cacheMaxConcepts discards it, saying the cache is why', async () => {
      const cache = getTxModule().endpoints.find(e => e.path === '/tx/r5').resourceCache;
      const saved = [cache.maxConceptsPerCache, cache.maxTotalConcepts];
      try {
        const cid = await startCache(app);
        cache.setLimits(2, Infinity); // colorsCS has 3 concepts
        const over = await post(app, VALIDATE, [
          cacheIdParam(cid, 'valueId'),
          { name: 'tx-resource', resource: colorsCS },
          { name: 'valueSet', resource: colorsVS },
          { name: 'coding', valueCoding: { system: colorsCS.url, code: 'red' } }
        ]);
        expect(over.status).toBe(422);
        const issue = over.body.issue[0];
        expect(issue.code).toBe('too-costly');
        expect(issue.details.coding).toEqual([{ system: 'http://hl7.org/fhir/tools/CodeSystem/tx-issue-type', code: 'too-costly' }]);
        expect(issue.extension[0].valueString).toBe('CACHE_ID_DISCARDED_TOO_BIG');
        expect(issue.details.text).toBe(`The cache for cache-id '${cid}' would exceed 2 concepts (cacheMaxConcepts), so it has been discarded. ` +
          'This is about the cache, not this request. Start a new cache-id and send the resources again');

        const after = await post(app, VALIDATE, [
          cacheIdParam(cid, 'valueId'),
          { name: 'url', valueString: colorsVS.url },
          { name: 'coding', valueCoding: { system: colorsCS.url, code: 'red' } }
        ]);
        expect(after.status).toBe(404);
        expect(isUnknownCacheError(after)).toBe(true);
        expect(after.body.issue[0].extension[0].valueString).toBe('CACHE_ID_DISCARDED');
        expect(after.body.issue[0].details.text).toMatch(/was discarded .* ago, because a request would have taken it over 2 concepts/);
      } finally {
        cache.setLimits(...saved);
      }
    });

    test('by url with no cache-id and a VS not in the library fails (not a silent pass)', async () => {
      const r = await post(app, VALIDATE, [
        { name: 'url', valueString: colorsVS.url },
        { name: 'coding', valueCoding: { system: colorsCS.url, code: 'red' } }
      ]);
      expect(resultOf(r.body)).not.toBe(true);
    });
  });

  describe('cache-id carried as the x-cache-id header (going-forward transport)', () => {
    test('full round trip with the cache-id only ever sent as a header', async () => {
      const cid = await startCache(app);

      const reg = await request(app)
        .post(VALIDATE)
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cid)
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'tx-resource', resource: colorsCS },
            { name: 'valueSet', resource: colorsVS },
            { name: 'coding', valueCoding: { system: colorsCS.url, code: 'red' } }
          ]
        });
      expect(reg.status).toBe(200);
      expect(resultOf(reg.body)).toBe(true);

      const byUrl = await request(app)
        .post(VALIDATE)
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cid)
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'url', valueString: colorsVS.url },
            { name: 'coding', valueCoding: { system: colorsCS.url, code: 'red' } }
          ]
        });
      expect(byUrl.status).toBe(200);
      expect(resultOf(byUrl.body)).toBe(true);
    });
  });

  describe('cached tx-resource CodeSystem is reused by a later inline ValueSet', () => {
    test('CS sent once under cache-id; a second VS using it validates without re-sending the CS', async () => {
      const cid = await startCache(app);

      // 1st call registers the CS (and a first VS) under the cache-id.
      const r1 = await post(app, VALIDATE, [
        cacheIdParam(cid, 'valueId'),
        { name: 'tx-resource', resource: colorsCS },
        { name: 'valueSet', resource: colorsVS },
        { name: 'coding', valueCoding: { system: colorsCS.url, code: 'blue' } }
      ]);
      expect(resultOf(r1.body)).toBe(true);

      // 2nd call: a DIFFERENT inline VS over the same CS, CS not re-sent.
      const secondVS = {
        resourceType: 'ValueSet',
        url: 'http://example.org/cache-id-test/colors-vs-2',
        version: '1.0.0',
        status: 'active',
        compose: { include: [{ system: colorsCS.url, concept: [{ code: 'blue' }] }] }
      };
      const r2 = await post(app, VALIDATE, [
        cacheIdParam(cid, 'valueId'),
        { name: 'valueSet', resource: secondVS },
        { name: 'coding', valueCoding: { system: colorsCS.url, code: 'blue' } }
      ]);
      expect(r2.status).toBe(200);
      expect(resultOf(r2.body)).toBe(true);
    });
  });

  describe('$expand cache-id round trip', () => {
    test('register VS+CS via cache-id (valueId), then expand by url', async () => {
      const cid = await startCache(app);

      const r1 = await post(app, EXPAND, [
        cacheIdParam(cid, 'valueId'),
        { name: 'tx-resource', resource: colorsCS },
        { name: 'valueSet', resource: colorsVS }
      ]);
      expect(r1.status).toBe(200);
      expect(r1.body.resourceType).toBe('ValueSet');

      const r2 = await post(app, EXPAND, [
        cacheIdParam(cid, 'valueId'),
        { name: 'url', valueString: colorsVS.url }
      ]);
      expect(r2.status).toBe(200);
      expect(r2.body.resourceType).toBe('ValueSet');
      expect(r2.body.expansion).toBeDefined();
      const codes = (r2.body.expansion.contains || []).map(c => c.code).sort();
      expect(codes).toEqual(['blue', 'green', 'red']);
    });
  });
});
