/**
 * The expansion cache and the response limit (x-too-costly-threshold).
 *
 * A request's x-too-costly-threshold header lowers the most codes its response may hold. The same
 * value set and parameters under a lower limit can be a different answer: a 422 where the higher
 * limit returned every code, or a page without a total. So the limit is part of the cache key, and
 * an expansion cached under one limit never answers a request under another.
 */
const request = require('supertest');
const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');
const { ExpansionCache } = require('../../tx/operation-context');

const CS_URL = 'http://example.org/fhir/CodeSystem/cache-threshold';
const N = 60;
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  concept: Array.from({ length: N }, (_, i) => ({ code: 'c' + String(i).padStart(2, '0'), display: 'Code ' + i }))
};
let n = 0;
function valueSet() {
  n++;
  return { resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/cache-threshold-' + n, version: '1.0.0', status: 'active',
    compose: { include: [{ system: CS_URL }] } };
}
function expand(app, vs, { count, threshold } = {}) {
  const parameter = [{ name: 'tx-resource', resource: CS }, { name: 'valueSet', resource: vs }];
  if (count !== undefined) parameter.push({ name: 'count', valueInteger: count });
  let req = request(app).post('/tx/r5/ValueSet/$expand').set('Content-Type', 'application/json');
  if (threshold !== undefined) req = req.set('x-too-costly-threshold', String(threshold));
  return req.send({ resourceType: 'Parameters', parameter });
}

describe('ExpansionCache.computeKey: the response limit', () => {
  test('the same value set and parameters under different limits have different keys', () => {
    const c = new ExpansionCache(null);
    const vs = valueSet();
    expect(c.computeKey(vs, null, [], 50)).not.toBe(c.computeKey(vs, null, [], 10000));
    expect(c.computeKey(vs, null, [], 50)).toBe(c.computeKey(vs, null, [], 50));
  });
});

describe('$expand from the expansion cache: an answer cached under one limit is not reused under a lower one', () => {
  let app;
  let cache;
  beforeAll(async () => {
    app = await getTestApp();
    // every expansion is cached, however fast (as the test runner's cached pass does): these
    // ones take a few ms, under ExpansionCache.MIN_CACHE_TIME_MS
    cache = getTxModule().endpoints[0].expansionCache;
    cache.forceCaching = true;
  }, 60000);
  afterAll(async () => {
    cache.forceCaching = false;
    await shutdownTestApp();
  });

  test('unpaged: 200 with every code under the default limit, then 422 under a limit below the size', async () => {
    const vs = valueSet();
    const first = await expand(app, vs);
    expect(first.status).toBe(200);
    expect(first.body.expansion.contains).toHaveLength(N);

    const lower = await expand(app, vs, { threshold: 50 });
    expect(lower.status).toBe(422);
    expect(lower.body.issue[0].code).toBe('too-costly');

    // and the first answer is still cached for the default limit
    const again = await expand(app, vs);
    expect(again.status).toBe(200);
    expect(again.body.expansion.identifier).toBe(first.body.expansion.identifier);
  });

  test('a page: the total under the default limit, none under a limit below the size', async () => {
    const vs = valueSet();
    const first = await expand(app, vs, { count: 10 });
    expect(first.status).toBe(200);
    expect(first.body.expansion.total).toBe(N);

    const lower = await expand(app, vs, { count: 10, threshold: 50 });
    expect(lower.status).toBe(200);
    expect(lower.body.expansion.contains).toHaveLength(10);
    expect(lower.body.expansion.total).toBeUndefined();
  });

  test('the same limit is still answered from the cache', async () => {
    const vs = valueSet();
    const first = await expand(app, vs, { count: 10, threshold: 50 });
    const second = await expand(app, vs, { count: 10, threshold: 50 });
    expect(second.status).toBe(200);
    expect(second.body.expansion.identifier).toBe(first.body.expansion.identifier);
  });
});
