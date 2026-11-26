//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// A JSON body with a property more than once in an object is refused (400) on a tx endpoint,
// as application/fhir+json and application/json: parsing would keep only the last. The app is
// set up the way server.js sets up its body parsers.

const express = require('express');
const path = require('path');
const request = require('supertest');
const TXModule = require('../../tx/tx');

const LIBRARY = path.join(__dirname, 'fixtures', 'test-library.yaml');
const R5 = '/tx/r5';
const SYS = 'http://hl7.org/fhir/test/CodeSystem/simple';

const BODY = JSON.stringify({
  resourceType: 'Parameters',
  parameter: [
    { name: 'valueSet', resource: { resourceType: 'ValueSet', status: 'active', compose: { include: [{ system: SYS }] } } },
    { name: 'tx-resource', resource: {
      resourceType: 'CodeSystem', id: 'simple', url: SYS, version: '0.1.0', name: 'Simple', status: 'active',
      caseSensitive: true, content: 'complete',
      concept: [{ code: 'code1', display: 'Display 1' }, { code: 'code2', display: 'Display 2' }] } }
  ]
});
const DUPLICATED = BODY.replace('"status":"active",', '"status":"active","status":"draft",');

describe('duplicate properties, on a tx endpoint', () => {
  let app, txModule;

  beforeAll(async () => {
    app = express();
    app.use(express.raw({ type: 'application/fhir+json' }));
    app.use(express.raw({ type: 'application/fhir+xml' }));
    app.use(express.json({ verify: (req, res, buf) => {
      req.rawBody = buf;
    } }));
    txModule = new TXModule();
    await txModule.initialize({ librarySource: LIBRARY, endpoints: [{ path: R5, fhirVersion: '5.0', context: null }] }, app);
  }, 240000);

  afterAll(async () => {
    if (txModule) {
      await txModule.shutdown();
    }
  });

  const post = (body, type, lang) => {
    const r = request(app).post(`${R5}/ValueSet/$expand`).set('Content-Type', type).set('Accept', 'application/fhir+json');
    return (lang ? r.set('Accept-Language', lang) : r).send(body);
  };

  test('without them, as before', async () => {
    for (const type of ['application/fhir+json', 'application/json']) {
      const res = await post(BODY, type);
      expect(res.status).toBe(200);
      expect(res.body.expansion.contains.map(c => c.code)).toEqual(['code1', 'code2']);
    }
  });

  test('with them, refused', async () => {
    for (const type of ['application/fhir+json', 'application/json']) {
      const res = await post(DUPLICATED, type);
      expect(res.status).toBe(400);
      expect(res.body.resourceType).toBe('OperationOutcome');
      const issue = res.body.issue[0];
      expect(issue.details.text).toBe("The JSON property 'status' is a duplicate, so the content can't be accepted");
      expect(issue.expression).toEqual(['Parameters.parameter[0].resource']);
      expect(issue.extension.find(e => e.url.endsWith('message-id')).valueString).toBe('DUPLICATE_JSON_PROPERTY_REJECTED');
    }
  });

  test('in the request\'s language', async () => {
    const res = await post(DUPLICATED, 'application/fhir+json', 'ja');
    expect(res.status).toBe(400);
    expect(res.body.issue[0].details.text).toBe("JSONプロパティ 'status' が重複しているため、内容を受け付けることができません");
  });
});
