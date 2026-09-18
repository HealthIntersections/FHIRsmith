/**
 * $cache-control routing smoke tests
 *
 * At this stage the operation is scaffolding only: start/end parse the request but
 * do nothing yet. These tests just confirm the route is wired up and dispatches on
 * the `mode` query parameter. Behavioural tests come with the implementation.
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

const BASE = '/tx/r5/$cache-control';

describe('$cache-control routing (scaffolding)', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  // An empty Parameters body stands in for "no front-loaded resources". A real
  // client always sets a Content-Type on a POST; the endpoint's media-type gate
  // rejects a truly bodyless POST with 415 (see note - bodyless POST is a separate
  // decision).
  const emptyBody = { resourceType: 'Parameters', parameter: [] };

  test('POST mode=start resolves and returns a Parameters', async () => {
    const res = await request(app)
      .post(BASE)
      .query({ mode: 'start' })
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(emptyBody);
    expect(res.status).toBe(200);
    expect(res.body.resourceType).toBe('Parameters');
  });

  test('mode=start with no instance code configured issues a bare UUID', async () => {
    const res = await request(app)
      .post(BASE)
      .query({ mode: 'start' })
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(emptyBody);
    const p = (res.body.parameter || []).find(x => x.name === 'cache-id');
    expect(p.valueId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test('GET mode=start resolves (browsable, like the other operations)', async () => {
    const res = await request(app)
      .get(BASE)
      .query({ mode: 'start' })
      .set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.resourceType).toBe('Parameters');
  });

  test('POST mode=end resolves and returns a Parameters', async () => {
    const res = await request(app)
      .post(BASE)
      .query({ mode: 'end' })
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .set('x-cache-id', 'some-cache-id')
      .send(emptyBody);
    expect(res.status).toBe(200);
    expect(res.body.resourceType).toBe('Parameters');
  });

  test('missing mode is a 400 OperationOutcome', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(emptyBody);
    expect(res.status).toBe(400);
    expect(res.body.resourceType).toBe('OperationOutcome');
  });

  test('unknown mode is a 400 OperationOutcome', async () => {
    const res = await request(app)
      .post(BASE)
      .query({ mode: 'bogus' })
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(emptyBody);
    expect(res.status).toBe(400);
    expect(res.body.resourceType).toBe('OperationOutcome');
  });

  test('mode supplied as a Parameters body parameter is accepted as a fallback', async () => {
    const res = await request(app)
      .post(BASE)
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({ resourceType: 'Parameters', parameter: [{ name: 'mode', valueCode: 'start' }] });
    expect(res.status).toBe(200);
    expect(res.body.resourceType).toBe('Parameters');
  });

  // ---- behaviour ----

  function cacheIdFrom(body) {
    const p = (body.parameter || []).find(x => x.name === 'cache-id');
    return p ? p.valueId : undefined;
  }

  function paramValue(body, name) {
    const p = (body.parameter || []).find(x => x.name === name);
    if (!p) return undefined;
    return p.valueBoolean !== undefined ? p.valueBoolean
      : p.valueUnsignedInt !== undefined ? p.valueUnsignedInt
      : p.valueId !== undefined ? p.valueId
      : p.resource;
  }

  // ---- mode=check ----
  //
  // check is both a probe and a keepalive: a client whose own local cache has been
  // absorbing its terminology work can go quiet for longer than the server's idle
  // timeout while still depending on its cache, so asking "is it still there?" is
  // itself use, and resets the idle clock.
  describe('mode=check', () => {
    async function startCheckCache() {
      const started = await request(app)
        .post(BASE)
        .query({ mode: 'start' })
        .set('Content-Type', 'application/json')
        .send({ resourceType: 'Parameters', parameter: [] });
      return cacheIdFrom(started.body);
    }

    function check(cacheId) {
      return request(app)
        .get(BASE)
        .query({ mode: 'check' })
        .set('Accept', 'application/json')
        .set('x-cache-id', cacheId);
    }

    test('reports a live cache as valid, with its stats', async () => {
      const cacheId = await startCheckCache();

      const res = await request(app)
        .post(BASE)
        .query({ mode: 'check' })
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [] });

      expect(res.status).toBe(200);
      expect(res.body.resourceType).toBe('Parameters');
      expect(paramValue(res.body, 'cache-id')).toBe(cacheId);
      expect(paramValue(res.body, 'valid')).toBe(true);
      expect(paramValue(res.body, 'sealed')).toBe(false); // server default, transitional
      expect(paramValue(res.body, 'resource-count')).toBe(0);
      expect(typeof paramValue(res.body, 'idle')).toBe('number');
      // the server advertises its timeout so a client can size its own polling to
      // this server instead of guessing
      expect(paramValue(res.body, 'timeout')).toBeGreaterThan(0);
    });

    test('GET works too, so a cache can be checked from a browser', async () => {
      const cacheId = await startCheckCache();
      const res = await check(cacheId);

      expect(res.status).toBe(200);
      expect(paramValue(res.body, 'valid')).toBe(true);
    });

    /**
     * End to end proof that a check both reports the idle time it found AND resets
     * it: let a cache go idle, check it (which must report the idle time, so status
     * is read before the touch), then check again immediately (which must report
     * zero, so the first check did touch it). If check didn't keep the cache alive,
     * the second call would report the same idle time as the first.
     */
    test('a check reports the idle time it found, and resets it', async () => {
      const cacheId = await startCheckCache();
      await new Promise(resolve => setTimeout(resolve, 1200));

      const first = await check(cacheId);
      expect(paramValue(first.body, 'idle')).toBeGreaterThanOrEqual(1);

      const second = await check(cacheId);
      expect(paramValue(second.body, 'idle')).toBe(0);
    });

    /**
     * The reason a check is not a 404: a heartbeat has to be able to tell "the
     * server is up and says my cache is gone" from "I could not reach the server",
     * and those call for opposite responses.
     */
    test('an unknown cache-id is 200 + valid=false, not 404', async () => {
      const res = await check('never-issued-this-id');

      expect(res.status).toBe(200);
      expect(paramValue(res.body, 'valid')).toBe(false);
      expect(paramValue(res.body, 'cache-id')).toBe('never-issued-this-id');
    });

    test('the outcome parameter carries the coded reason', async () => {
      const cacheId = await startCheckCache();
      await request(app)
        .post(BASE)
        .query({ mode: 'end' })
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [] });

      const res = await check(cacheId);

      expect(res.status).toBe(200);
      expect(paramValue(res.body, 'valid')).toBe(false);

      const outcome = paramValue(res.body, 'outcome');
      expect(outcome.resourceType).toBe('OperationOutcome');
      const coding = ((outcome.issue[0] || {}).details || {}).coding || [];
      expect(coding.some(c => c.code === 'cache-id-unknown')).toBe(true);
      // and it says which of the three fates it met, not a list of maybes
      expect(outcome.issue[0].details.text).toMatch(/closed/i);
    });

    test('a missing cache-id header is a client error', async () => {
      const res = await request(app)
        .post(BASE)
        .query({ mode: 'check' })
        .set('Content-Type', 'application/json')
        .send({ resourceType: 'Parameters', parameter: [] });

      expect(res.status).toBe(400);
      expect(res.body.resourceType).toBe('OperationOutcome');
    });
  });

  test('start returns a server-issued cache-id', async () => {
    const res = await request(app)
      .post(BASE)
      .query({ mode: 'start' })
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send(emptyBody);
    expect(res.status).toBe(200);
    const id = cacheIdFrom(res.body);
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-f-]{36}$/i); // UUID shape
  });

  test('each start mints a distinct cache-id', async () => {
    const a = await request(app).post(BASE).query({ mode: 'start' })
      .set('Content-Type', 'application/json').send(emptyBody);
    const b = await request(app).post(BASE).query({ mode: 'start' })
      .set('Content-Type', 'application/json').send(emptyBody);
    expect(cacheIdFrom(a.body)).not.toBe(cacheIdFrom(b.body));
  });

  test('start front-loads supplied resources into the cache, retrievable by url', async () => {
    const colorsCS = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/cc-test/colors',
      version: '1.0.0',
      status: 'active',
      content: 'complete',
      concept: [{ code: 'red', display: 'Red' }]
    };
    const colorsVS = {
      resourceType: 'ValueSet',
      url: 'http://example.org/cc-test/colors-vs',
      version: '1.0.0',
      status: 'active',
      compose: { include: [{ system: colorsCS.url }] }
    };

    // Front-load CS + VS via start.
    const started = await request(app)
      .post(BASE)
      .query({ mode: 'start' })
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: 'tx-resource', resource: colorsCS },
          { name: 'valueSet', resource: colorsVS }
        ]
      });
    const cacheId = cacheIdFrom(started.body);
    expect(cacheId).toBeDefined();

    // The front-loaded ValueSet should now resolve by url under that cache-id.
    // (validate still reads cache-id from the parameter in this step; the header
    // read path is a later change.)
    const validated = await request(app)
      .post('/tx/r5/ValueSet/$validate-code')
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [
          { name: 'cache-id', valueId: cacheId },
          { name: 'url', valueString: colorsVS.url },
          { name: 'coding', valueCoding: { system: colorsCS.url, code: 'red' } }
        ]
      });
    expect(validated.status).toBe(200);
    const result = (validated.body.parameter || []).find(x => x.name === 'result');
    expect(result && result.valueBoolean).toBe(true);
  });

  test('end with the cache-id header releases the cache', async () => {
    const started = await request(app).post(BASE).query({ mode: 'start' })
      .set('Content-Type', 'application/json').send(emptyBody);
    const cacheId = cacheIdFrom(started.body);

    const ended = await request(app)
      .post(BASE)
      .query({ mode: 'end' })
      .set('Content-Type', 'application/json')
      .set('x-cache-id', cacheId)
      .send(emptyBody);
    expect(ended.status).toBe(200);
    expect(ended.body.resourceType).toBe('Parameters');
  });

  test('end without the cache-id header is a 400', async () => {
    const res = await request(app)
      .post(BASE)
      .query({ mode: 'end' })
      .set('Content-Type', 'application/json')
      .send(emptyBody);
    expect(res.status).toBe(400);
    expect(res.body.resourceType).toBe('OperationOutcome');
  });

  test('end of an unknown cache-id is a tolerant no-op (200)', async () => {
    const res = await request(app)
      .post(BASE)
      .query({ mode: 'end' })
      .set('Content-Type', 'application/json')
      .set('x-cache-id', 'never-issued-this-id')
      .send(emptyBody);
    expect(res.status).toBe(200);
  });

  // ---- header-driven cache use across operations (regression) ----
  //
  // The cache-id travels as the X-Cache-Id header. Only the operations whose
  // Parameters are assembled through buildParameters() used to honour it; the
  // ones that read req.body / the query string directly (expand, related,
  // batch-validate) or that handed setupAdditionalResources a raw req.body
  // (lookup) silently ignored a front-loaded cache and failed to resolve
  // by-reference resources. The middleware now lifts the header onto the
  // operation context and setupAdditionalResources falls back to it, so every
  // operation honours a front-loaded cache from the header alone (no inline
  // tx-resource, no cache-id parameter).
  describe('front-loaded cache is honoured from the header alone', () => {
    const colorsCS = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/hdr-test/colors',
      version: '1.0.0',
      status: 'active',
      content: 'complete',
      concept: [{ code: 'red', display: 'Red' }, { code: 'green', display: 'Green' }]
    };
    const colorsVS = {
      resourceType: 'ValueSet',
      url: 'http://example.org/hdr-test/colors-vs',
      version: '1.0.0',
      status: 'active',
      compose: { include: [{ system: colorsCS.url }] }
    };

    async function startCache() {
      const started = await request(app)
        .post(BASE)
        .query({ mode: 'start' })
        .set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'tx-resource', resource: colorsCS },
            { name: 'valueSet', resource: colorsVS }
          ]
        });
      return cacheIdFrom(started.body);
    }

    test('$expand resolves the front-loaded ValueSet by url via the header', async () => {
      const cacheId = await startCache();
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [{ name: 'url', valueUri: colorsVS.url }] });
      expect(res.status).toBe(200);
      expect(res.body.resourceType).toBe('ValueSet');
      const codes = ((res.body.expansion || {}).contains || []).map(c => c.code).sort();
      expect(codes).toEqual(['green', 'red']);
    });

    test('$lookup resolves the front-loaded CodeSystem via the header', async () => {
      const cacheId = await startCache();
      const res = await request(app)
        .post('/tx/r5/CodeSystem/$lookup')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'system', valueUri: colorsCS.url },
            { name: 'code', valueCode: 'green' }
          ]
        });
      expect(res.status).toBe(200);
      const display = (res.body.parameter || []).find(x => x.name === 'display');
      expect(display && display.valueString).toBe('Green');
    });

    test('$validate-code resolves the front-loaded ValueSet by url via the header', async () => {
      const cacheId = await startCache();
      const res = await request(app)
        .post('/tx/r5/ValueSet/$validate-code')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'url', valueString: colorsVS.url },
            { name: 'coding', valueCoding: { system: colorsCS.url, code: 'red' } }
          ]
        });
      expect(res.status).toBe(200);
      const result = (res.body.parameter || []).find(x => x.name === 'result');
      expect(result && result.valueBoolean).toBe(true);
    });

    test('an unknown cache-id in the header is a coded 404 on $expand', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', 'never-issued-this-id')
        .send({ resourceType: 'Parameters', parameter: [{ name: 'url', valueUri: colorsVS.url }] });
      expect(res.status).toBe(404);
      expect(res.body.resourceType).toBe('OperationOutcome');
      const coding = (((res.body.issue || [])[0] || {}).details || {}).coding || [];
      expect(coding.some(c => c.code === 'cache-id-unknown')).toBe(true);
      // An id this server never issued must say exactly that, and must not offer
      // expiry as a possibility - that sends people hunting a timeout that never ran.
      const text = (((res.body.issue || [])[0] || {}).details || {}).text || '';
      expect(text).toMatch(/never issued by this server/i);
      expect(text).not.toMatch(/expired/i);
    });

    // A cache-id whose prefix names another instance got here through a routing
    // mistake (or a proxy falling back to a backup): same coding, but the message
    // must name the instance that issued it.
    test('a cache-id prefixed with another instance code is reported as misrouted', async () => {
      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', 'tx9.never-issued-this-id')
        .send({ resourceType: 'Parameters', parameter: [{ name: 'url', valueUri: colorsVS.url }] });
      expect(res.status).toBe(404);
      const issue = (res.body.issue || [])[0] || {};
      const coding = (issue.details || {}).coding || [];
      expect(coding.some(c => c.code === 'cache-id-unknown')).toBe(true);
      expect((issue.details || {}).text || '').toMatch(/issued by the server instance 'tx9'/);
    });

    // The three ways a cache-id can be missing are indistinguishable to a client
    // unless the server says which one happened. A cache the client closed itself
    // is the one that matters most: it reads like an expiry, but the fix is in the
    // client's lifecycle, not the server's timeout.
    test('a cache the client closed reports the close, not an expiry', async () => {
      const cacheId = await startCache();
      const ended = await request(app)
        .post(BASE)
        .query({ mode: 'end' })
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [] });
      expect(ended.status).toBe(200);

      const res = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [{ name: 'url', valueUri: colorsVS.url }] });

      expect(res.status).toBe(404);
      // Same coding as any other missing cache - clients switch on this, and the
      // action is the same. Only the diagnostics differ.
      const coding = (((res.body.issue || [])[0] || {}).details || {}).coding || [];
      expect(coding.some(c => c.code === 'cache-id-unknown')).toBe(true);

      const text = (((res.body.issue || [])[0] || {}).details || {}).text || '';
      expect(text).toMatch(/closed/i);
      expect(text).toMatch(/mode=end/);
      expect(text).not.toMatch(/never issued/i);
      expect(text).not.toMatch(/expired/i);
    });

    test('a batch against a closed cache reports the close too', async () => {
      const cacheId = await startCache();
      await request(app)
        .post(BASE)
        .query({ mode: 'end' })
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [] });

      const res = await request(app)
        .post('/tx/r5/ValueSet/$batch-validate-code')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({
          resourceType: 'Parameters',
          parameter: [{
            name: 'validation',
            resource: {
              resourceType: 'Parameters',
              parameter: [
                { name: 'url', valueString: colorsVS.url },
                { name: 'coding', valueCoding: { system: colorsCS.url, code: 'red' } }
              ]
            }
          }]
        });

      expect(res.status).toBe(404);
      const text = (((res.body.issue || [])[0] || {}).details || {}).text || '';
      expect(text).toMatch(/closed/i);
    });
  });

  // ---- sealed vs unsealed caches ----
  //
  // `sealed` (start parameter) governs whether the cache may grow after creation.
  // Sealed: only the front-loaded resources are ever in the cache; resources sent
  // on a later request are used for that request but not retained. Unsealed: the
  // cache accumulates resources it sees, so a resource sent once resolves by
  // reference thereafter.
  //
  // NOTE: the server default is currently unsealed (transitional), which differs
  // from the protocol default of sealed=true; that flips once all clients send an
  // explicit `sealed`.
  describe('sealed vs unsealed caches', () => {
    const csA = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/seal-test/csA',
      version: '1.0.0', status: 'active', content: 'complete',
      concept: [{ code: 'a1', display: 'A One' }]
    };
    const vsA = {
      resourceType: 'ValueSet',
      url: 'http://example.org/seal-test/vsA',
      version: '1.0.0', status: 'active',
      compose: { include: [{ system: csA.url }] }
    };
    // A second VS not front-loaded; used to probe whether the cache grew.
    const csB = {
      resourceType: 'CodeSystem',
      url: 'http://example.org/seal-test/csB',
      version: '1.0.0', status: 'active', content: 'complete',
      concept: [{ code: 'b1', display: 'B One' }]
    };
    const vsB = {
      resourceType: 'ValueSet',
      url: 'http://example.org/seal-test/vsB',
      version: '1.0.0', status: 'active',
      compose: { include: [{ system: csB.url }] }
    };

    async function start(sealed) {
      const params = [
        { name: 'tx-resource', resource: csA },
        { name: 'valueSet', resource: vsA }
      ];
      if (sealed !== undefined) params.push({ name: 'sealed', valueBoolean: sealed });
      const started = await request(app)
        .post(BASE).query({ mode: 'start' })
        .set('Content-Type', 'application/json')
        .send({ resourceType: 'Parameters', parameter: params });
      return started.body;
    }

    test('start echoes the sealed flag it applied', async () => {
      const body = await start(true);
      const p = (body.parameter || []).find(x => x.name === 'sealed');
      expect(p && p.valueBoolean).toBe(true);
    });

    test('default (no sealed param) is unsealed on this server (transitional)', async () => {
      const body = await start(undefined);
      const p = (body.parameter || []).find(x => x.name === 'sealed');
      expect(p && p.valueBoolean).toBe(false);
    });

    test('a sealed cache does not retain a resource sent on a later request', async () => {
      const cacheId = cacheIdFrom(await start(true));

      // Send vsB/csB inline on a validate call (works for this call)...
      const first = await request(app)
        .post('/tx/r5/ValueSet/$validate-code')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [
          { name: 'valueSet', resource: vsB },
          { name: 'tx-resource', resource: csB },
          { name: 'coding', valueCoding: { system: csB.url, code: 'b1' } }
        ] });
      expect(first.status).toBe(200);

      // ...but the sealed cache must not have kept vsB: a by-reference call now 404s.
      const second = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [{ name: 'url', valueUri: vsB.url }] });
      expect(second.status).not.toBe(200);
    });

    test('an unsealed cache retains a resource sent on a later request', async () => {
      const cacheId = cacheIdFrom(await start(false));

      const first = await request(app)
        .post('/tx/r5/ValueSet/$validate-code')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [
          { name: 'valueSet', resource: vsB },
          { name: 'tx-resource', resource: csB },
          { name: 'coding', valueCoding: { system: csB.url, code: 'b1' } }
        ] });
      expect(first.status).toBe(200);

      // The unsealed cache kept vsB: it now resolves by reference.
      const second = await request(app)
        .post('/tx/r5/ValueSet/$expand')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [{ name: 'url', valueUri: vsB.url }] });
      expect(second.status).toBe(200);
      const codes = ((second.body.expansion || {}).contains || []).map(c => c.code);
      expect(codes).toContain('b1');
    });
  });

  // ---- batch front-loading (two-pass) ----
  //
  // A batch against an unsealed cache front-loads every resource it supplies
  // (tx-resource + primary valueSet/codeSystem) into the cache before any entry is
  // evaluated. So the batch is order-independent (an entry may reference by url a
  // resource a later entry supplies) and a failing entry does not withhold what it
  // carried. A sealed cache does not grow, so there is no cross-entry sharing.
  describe('batch front-loading (two-pass)', () => {
    const BATCH = '/tx/r5/ValueSet/$batch-validate-code';

    const entry = (parameter) => ({
      name: 'validation',
      resource: { resourceType: 'Parameters', parameter }
    });
    const results = (body) => (body.parameter || []).filter(x => x.name === 'validation');

    async function startCache(sealed) {
      const parameter = [];
      if (sealed !== undefined) parameter.push({ name: 'sealed', valueBoolean: sealed });
      const started = await request(app).post(BASE).query({ mode: 'start' })
        .set('Content-Type', 'application/json')
        .send({ resourceType: 'Parameters', parameter });
      return cacheIdFrom(started.body);
    }

    const mkCS = (tag) => ({
      resourceType: 'CodeSystem', url: `http://example.org/batch/${tag}-cs`,
      version: '1.0.0', status: 'active', content: 'complete',
      concept: [{ code: `${tag}1`, display: `${tag} one` }]
    });
    const mkVS = (tag, cs) => ({
      resourceType: 'ValueSet', url: `http://example.org/batch/${tag}-vs`,
      version: '1.0.0', status: 'active',
      compose: { include: [{ system: cs.url }] }
    });

    test('an entry resolves a url supplied only by a LATER entry (unsealed)', async () => {
      const cacheId = await startCache(false);
      const cs = mkCS('fwd'); const vs = mkVS('fwd', cs);
      const res = await request(app).post(BATCH)
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [
          // entry 0: references vs by url only (forward reference)
          entry([
            { name: 'url', valueString: vs.url },
            { name: 'coding', valueCoding: { system: cs.url, code: 'fwd1' } }
          ]),
          // entry 1: supplies vs + cs inline, AFTER the entry that references them
          entry([
            { name: 'tx-resource', resource: cs },
            { name: 'valueSet', resource: vs },
            { name: 'coding', valueCoding: { system: cs.url, code: 'fwd1' } }
          ])
        ] });
      expect(res.status).toBe(200);
      const rs = results(res.body);
      expect(rs.length).toBe(2);
      // the forward-referencing entry validated true because pass 1 pooled the
      // resources from the later entry before any entry ran.
      const r0 = (rs[0].resource.parameter || []).find(x => x.name === 'result');
      expect(r0 && r0.valueBoolean).toBe(true);
    });

    test('resources are front-loaded even when the carrying entry fails, and persist (unsealed)', async () => {
      const cacheId = await startCache(false);
      const cs = mkCS('fail'); const vs = mkVS('fail', cs);
      const batch = await request(app).post(BATCH)
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [
          // this entry supplies vs+cs but validates a code that isn't in the system
          entry([
            { name: 'tx-resource', resource: cs },
            { name: 'valueSet', resource: vs },
            { name: 'coding', valueCoding: { system: cs.url, code: 'NOPE' } }
          ])
        ] });
      expect(batch.status).toBe(200);

      // Despite that entry not validating cleanly, vs was populated: a separate
      // by-reference $expand on the same cache now resolves it.
      const exp = await request(app).post('/tx/r5/ValueSet/$expand')
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [{ name: 'url', valueUri: vs.url }] });
      expect(exp.status).toBe(200);
      const codes = ((exp.body.expansion || {}).contains || []).map(c => c.code);
      expect(codes).toContain('fail1');
    });

    test('a sealed batch does NOT share resources across entries', async () => {
      const cacheId = await startCache(true);
      const cs = mkCS('seal'); const vs = mkVS('seal', cs);
      const res = await request(app).post(BATCH)
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [
          // entry 0 references vs by url only
          entry([
            { name: 'url', valueString: vs.url },
            { name: 'coding', valueCoding: { system: cs.url, code: 'seal1' } }
          ]),
          // entry 1 supplies vs - but a sealed cache does not share it to entry 0
          entry([
            { name: 'tx-resource', resource: cs },
            { name: 'valueSet', resource: vs },
            { name: 'coding', valueCoding: { system: cs.url, code: 'seal1' } }
          ])
        ] });
      expect(res.status).toBe(200);
      const rs = results(res.body);
      // entry 0 could not resolve vs (no cross-entry sharing when sealed):
      // either an OperationOutcome or result=false, but not a clean true.
      const r0res = rs[0].resource;
      const r0 = (r0res.parameter || []).find(x => x.name === 'result');
      const unresolved = r0res.resourceType === 'OperationOutcome' || (r0 && r0.valueBoolean === false);
      expect(unresolved).toBe(true);
      // entry 1, which carried the resource itself, still validates true.
      const r1 = (rs[1].resource.parameter || []).find(x => x.name === 'result');
      expect(r1 && r1.valueBoolean).toBe(true);
    });

    test('an unknown cache-id fails the whole batch with a coded 404', async () => {
      const cs = mkCS('unk'); const vs = mkVS('unk', cs);
      const res = await request(app).post(BATCH)
        .set('Content-Type', 'application/json')
        .set('x-cache-id', 'never-issued-this-id')
        .send({ resourceType: 'Parameters', parameter: [
          entry([
            { name: 'valueSet', resource: vs },
            { name: 'coding', valueCoding: { system: cs.url, code: 'unk1' } }
          ])
        ] });
      expect(res.status).toBe(404);
      expect(res.body.resourceType).toBe('OperationOutcome');
      const coding = (((res.body.issue || [])[0] || {}).details || {}).coding || [];
      expect(coding.some(c => c.code === 'cache-id-unknown')).toBe(true);
    });

    // CodeSystem batch: same front-loading, but the primary being validated is a
    // code system (system+code), not a value set.
    test('a CodeSystem batch front-loads and resolves a system supplied by a later entry (unsealed)', async () => {
      const CS_BATCH = '/tx/r5/CodeSystem/$batch-validate-code';
      const cacheId = await startCache(false);
      const cs = mkCS('csbatch');
      const res = await request(app).post(CS_BATCH)
        .set('Content-Type', 'application/json')
        .set('x-cache-id', cacheId)
        .send({ resourceType: 'Parameters', parameter: [
          // entry 0: validates a code against cs by system url only (forward ref)
          entry([
            { name: 'system', valueUri: cs.url },
            { name: 'code', valueCode: 'csbatch1' }
          ]),
          // entry 1: supplies cs inline, AFTER the entry that references it
          entry([
            { name: 'tx-resource', resource: cs },
            { name: 'system', valueUri: cs.url },
            { name: 'code', valueCode: 'csbatch1' }
          ])
        ] });
      expect(res.status).toBe(200);
      const rs = results(res.body);
      expect(rs.length).toBe(2);
      const r0 = (rs[0].resource.parameter || []).find(x => x.name === 'result');
      expect(r0 && r0.valueBoolean).toBe(true);
    });
  });
});
