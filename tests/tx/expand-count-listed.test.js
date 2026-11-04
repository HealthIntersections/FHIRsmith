/**
 * $expand of a value set that lists its codes (as VSAC value sets do), against the
 * limit on expansion size:
 *  - count=0 asks only for the total: the listed codes are counted, not built, and a
 *    value set bigger than the limit is not refused
 *  - a full expansion that is bigger than the limit is refused before any code is built
 * Runs against the committed SNOMED test subset (see expand-snomed-whole.test.js).
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const TXModule = require('../../tx/tx');
const folders = require('../../library/folder-setup');
const { ValueSetExpander } = require('../../tx/workers/expand');

const SNOMED_URI = 'http://snomed.info/sct';

jest.setTimeout(60000);

function expandRequest(app, valueSet, params = [], headers = {}) {
  let req = request(app)
    .post('/tx/r5/ValueSet/$expand')
    .set('Accept', 'application/json')
    .set('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) {
    req = req.set(k, v);
  }
  return req.send({
    resourceType: 'Parameters',
    parameter: [{ name: 'valueSet', resource: valueSet }, ...params]
  });
}

function listed(...includes) {
  return {
    resourceType: 'ValueSet',
    url: 'http://example.org/fhir/ValueSet/listed',
    status: 'active',
    compose: {
      include: includes.map(codes => ({ system: SNOMED_URI, concept: codes.map(code => ({ code })) }))
    }
  };
}

const LIMIT = { 'x-too-costly-threshold': '50' };

describe('$expand of a value set that lists its codes, against the limit', () => {
  let app;
  let txModule;
  let codes; // 60 real codes from the test subset

  beforeAll(async () => {
    const committed = path.resolve(__dirname, '../../tx/data/snomed-testing.cache');
    const target = path.join(folders.subDir('terminology-cache'), 'snomed-testing.cache');
    if (!fs.existsSync(target)) {
      fs.copyFileSync(committed, target);
    }
    app = express();
    app.use(express.json());
    txModule = new TXModule();
    await txModule.initialize({
      librarySource: path.join(__dirname, 'fixtures', 'test-library-snomed.yaml'),
      endpoints: [{ path: '/tx/r5', fhirVersion: '5.0', context: null }]
    }, app);

    const all = await expandRequest(app, { resourceType: 'ValueSet', status: 'active', compose: { include: [{ system: SNOMED_URI }] } },
      [{ name: 'count', valueInteger: 60 }]);
    codes = all.body.expansion.contains.map(c => c.code);
    expect(codes).toHaveLength(60);
  }, 60000);

  afterAll(async () => {
    if (txModule) {
      await txModule.shutdown();
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('count=0 over the limit reports the total, and builds no codes', async () => {
    const built = jest.spyOn(ValueSetExpander.prototype, 'includeCode');
    const response = await expandRequest(app, listed(codes), [{ name: 'count', valueInteger: 0 }], LIMIT);
    expect(response.status).toBe(200);
    expect(response.body.expansion.total).toBe(60);
    expect(response.body.expansion.contains).toBeUndefined();
    expect(built).not.toHaveBeenCalled();
    const used = response.body.expansion.parameter.filter(p => p.name === 'used-codesystem');
    expect(used.length).toBe(1);
  });

  test('count=0 counts each code once, across includes, and skips unknown codes', async () => {
    const vs = listed([...codes.slice(0, 40), codes[0], '999999999999'], codes.slice(30, 60));
    const countOnly = await expandRequest(app, vs, [{ name: 'count', valueInteger: 0 }], LIMIT);
    expect(countOnly.status).toBe(200);
    expect(countOnly.body.expansion.total).toBe(60);

    // the same total as a full expansion (no limit)
    const full = await expandRequest(app, vs);
    expect(full.status).toBe(200);
    expect(full.body.expansion.contains).toHaveLength(60);
    expect(full.body.expansion.total).toBe(60);
  });

  test('count=0 under the limit is the same total as before', async () => {
    const response = await expandRequest(app, listed(codes.slice(0, 20)), [{ name: 'count', valueInteger: 0 }], LIMIT);
    expect(response.status).toBe(200);
    expect(response.body.expansion.total).toBe(20);
  });

  test('count=0 with a text filter still counts the matches', async () => {
    const full = await expandRequest(app, listed(codes), [{ name: 'filter', valueString: 'disorder' }]);
    const countOnly = await expandRequest(app, listed(codes), [{ name: 'filter', valueString: 'disorder' }, { name: 'count', valueInteger: 0 }]);
    expect(countOnly.status).toBe(200);
    expect(countOnly.body.expansion.total).toBe(full.body.expansion.contains ? full.body.expansion.contains.length : 0);
  });

  test('a full expansion over the limit is refused before any code is built', async () => {
    const built = jest.spyOn(ValueSetExpander.prototype, 'includeCode');
    const response = await expandRequest(app, listed(codes), [], LIMIT);
    expect(response.status).toBe(422);
    expect(response.body.issue[0].code).toBe('too-costly');
    expect(built).not.toHaveBeenCalled();
  });

  test('a page that fits in the limit is still served', async () => {
    const response = await expandRequest(app, listed(codes), [{ name: 'count', valueInteger: 10 }, { name: 'offset', valueInteger: 5 }], LIMIT);
    expect(response.status).toBe(200);
    expect(response.body.expansion.contains).toHaveLength(10);
    expect(response.body.expansion.contains[0].code).toBe(codes[5]);
  });

  test('the refusal names the value set: by url, else id, else it is the one in the request (K11)', async () => {
    const named = await expandRequest(app, listed(codes), [], LIMIT);
    expect(named.body.issue[0].details.text).toContain("'http://example.org/fhir/ValueSet/listed'");
    const noUrl = { ...listed(codes) };
    delete noUrl.url;
    const inline = await expandRequest(app, noUrl, [], LIMIT);
    expect(inline.status).toBe(422);
    expect(inline.body.issue[0].details.text).toContain('The expansion of the value set in the request has too many codes');
    expect(inline.body.issue[0].extension[0].valueString).toBe('VALUESET_TOO_COSTLY');
    expect(inline.body.issue[0].details.text).not.toMatch(/undefined|\?\?/);
    const withId = await expandRequest(app, { ...noUrl, id: 'my-vs' }, [], LIMIT);
    expect(withId.body.issue[0].details.text).toContain("'my-vs'");
  });

  test('a list over the limit made smaller by duplicates is not refused', async () => {
    const response = await expandRequest(app, listed([...codes.slice(0, 40), ...codes.slice(0, 40)]), [], LIMIT);
    expect(response.status).toBe(200);
    expect(response.body.expansion.contains).toHaveLength(40);
  });
});
