/**
 * The request body size limit (server.maxBodyMB):
 *  - the setting, read by maxBodyBytes (default 50 MB)
 *  - a tx endpoint answers a body over it with a 413 OperationOutcome (too-costly),
 *    not Express's HTML error page; a body under it works as before
 * The app is set up the way server.js sets up its body parsers.
 */

const express = require('express');
const path = require('path');
const request = require('supertest');
const TXModule = require('../../tx/tx');
const { maxBodyBytes, DEFAULT_MAX_BODY_MB } = require('../../library/body-limit');

const LIBRARY = path.join(__dirname, 'fixtures', 'test-library.yaml');
const R5 = '/tx/r5';
const SYS = 'http://hl7.org/fhir/test/CodeSystem/simple';

const SIMPLE = {
  resourceType: 'CodeSystem', id: 'simple', url: SYS, version: '0.1.0', name: 'Simple', status: 'active',
  caseSensitive: true, content: 'complete',
  concept: [{ code: 'code1', display: 'Display 1' }, { code: 'code2', display: 'Display 2' }]
};

// an $expand of the codes of SIMPLE, with a comment of padding bytes to make the body bigger
function expandBody(padding) {
  return JSON.stringify({
    resourceType: 'Parameters',
    parameter: [
      { name: 'valueSet', resource: {
        resourceType: 'ValueSet', status: 'active', description: 'x'.repeat(padding),
        compose: { include: [{ system: SYS }] } } },
      { name: 'tx-resource', resource: SIMPLE }
    ]
  });
}

describe('maxBodyBytes (server.maxBodyMB)', () => {
  test('defaults to 50 MB', () => {
    expect(DEFAULT_MAX_BODY_MB).toBe(50);
    expect(maxBodyBytes(undefined)).toBe(50 * 1024 * 1024);
    expect(maxBodyBytes({})).toBe(50 * 1024 * 1024);
    expect(maxBodyBytes({ maxBodyMB: null })).toBe(50 * 1024 * 1024);
  });

  test('honours the setting', () => {
    expect(maxBodyBytes({ maxBodyMB: 2 })).toBe(2 * 1024 * 1024);
    expect(maxBodyBytes({ maxBodyMB: 200 })).toBe(200 * 1024 * 1024);
    expect(maxBodyBytes({ maxBodyMB: 0.5 })).toBe(512 * 1024);
    expect(maxBodyBytes({ maxBodyMB: '10' })).toBe(10 * 1024 * 1024);
  });

  test('a value that is not a positive number is the default, not no limit', () => {
    for (const v of [0, -1, 'lots', NaN]) {
      expect(maxBodyBytes({ maxBodyMB: v })).toBe(50 * 1024 * 1024);
    }
  });
});

describe('a body over the limit, on a tx endpoint', () => {
  const LIMIT = maxBodyBytes({ maxBodyMB: 0.0625 }); // 64 KB
  let app, txModule;

  beforeAll(async () => {
    app = express();
    app.use(express.raw({ type: 'application/fhir+json', limit: LIMIT }));
    app.use(express.raw({ type: 'application/fhir+xml', limit: LIMIT }));
    app.use(express.json({ limit: LIMIT }));
    txModule = new TXModule();
    await txModule.initialize({ librarySource: LIBRARY, endpoints: [{ path: R5, fhirVersion: '5.0', context: null }] }, app);
    // a route of another module, after the tx endpoints, which keeps Express's own handling
    app.post('/other', (req, res) => res.json({ ok: true }));
  }, 240000);

  afterAll(async () => {
    if (txModule) {
      await txModule.shutdown();
    }
  });

  const post = (url, body, type = 'application/fhir+json', accept = 'application/fhir+json') =>
    request(app).post(url).set('Content-Type', type).set('Accept', accept).send(body);

  test('a body under the limit works', async () => {
    const body = expandBody(LIMIT - 2000);
    expect(Buffer.byteLength(body)).toBeLessThan(LIMIT);
    const res = await post(`${R5}/ValueSet/$expand`, body);
    expect(res.status).toBe(200);
    expect(res.body.expansion.contains.map(c => c.code)).toEqual(['code1', 'code2']);
  });

  test('a fhir+json body over the limit gets a 413 OperationOutcome, too-costly', async () => {
    const res = await post(`${R5}/ValueSet/$expand`, expandBody(LIMIT + 1000));
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.resourceType).toBe('OperationOutcome');
    expect(res.body.issue[0].code).toBe('too-costly');
    expect(res.body.issue[0].details.text).toContain(String(LIMIT));
  });

  test('so does an application/json body (the json parser), in XML when XML is asked for', async () => {
    const res = await post(`${R5}/ValueSet/$expand`, expandBody(LIMIT + 1000), 'application/json', 'application/fhir+xml');
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.text).toContain('<OperationOutcome');
    expect(res.text).toContain('too-costly');
  });

  test('a form post over the tx module\'s own form limit (Express\'s 100 KB) gets one too', async () => {
    const res = await post(`${R5}/CodeSystem/$lookup`, 'system=' + SYS + '&code=code1&display=' + 'x'.repeat(150 * 1024),
      'application/x-www-form-urlencoded');
    expect(res.status).toBe(413);
    expect(res.body.resourceType).toBe('OperationOutcome');
    expect(res.body.issue[0].code).toBe('too-costly');
  });

  test('other modules keep their own handling', async () => {
    const res = await post('/other', expandBody(LIMIT + 1000), 'application/json', 'application/json');
    expect(res.status).toBe(413);
    expect(res.text).not.toContain('OperationOutcome');
  });
});
