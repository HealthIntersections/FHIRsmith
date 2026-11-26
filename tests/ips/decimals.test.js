//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// Decimals in IPS documents keep their precision (library/fhir-json.js): 70.50 is stored,
// returned, searched, copied, shown and composed as 70.50.

const express = require('express');
const request = require('supertest');
const IpsModule = require('../../ips/ips');
const { Presenter } = require('../../ips/presenter');
const fhirJson = require('../../library/fhir-json');
const { setupAuth, mountAuth } = require('../helpers/auth');

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const stats = { counts: {}, countRequest() {}, addTask() {}, task() {}, taskDone() {}, taskError() {} };

const DOC = `{"resourceType":"Bundle","type":"document","identifier":{"system":"urn:oid:2.16.840.1.113883.19.5","value":"doc-dec"},
"timestamp":"2026-03-01T10:00:00Z","entry":[
{"fullUrl":"urn:uuid:comp-1","resource":{"resourceType":"Composition","id":"comp-1","status":"final",
 "type":{"coding":[{"system":"http://loinc.org","code":"60591-5"}]},"subject":{"reference":"urn:uuid:pat-1"},"date":"2026-03-01T09:30:00Z",
 "author":[{"reference":"urn:uuid:pract-1"}],"title":"Summary",
 "text":{"status":"generated","div":"<div xmlns=\\"http://www.w3.org/1999/xhtml\\"><p>Summary</p></div>"},
 "section":[{"title":"Vital Signs","code":{"coding":[{"system":"http://loinc.org","code":"8716-3"}]},
  "text":{"status":"generated","div":"<div xmlns=\\"http://www.w3.org/1999/xhtml\\"><p>Weight</p></div>"},"entry":[{"reference":"urn:uuid:obs-1"}]}]}},
{"fullUrl":"urn:uuid:pat-1","resource":{"resourceType":"Patient","id":"pat-1","name":[{"family":"Smith","given":["Jane"]}],"gender":"female","birthDate":"1970-05-06"}},
{"fullUrl":"urn:uuid:pract-1","resource":{"resourceType":"Practitioner","id":"pract-1","name":[{"family":"Jones"}]}},
{"fullUrl":"urn:uuid:obs-1","resource":{"resourceType":"Observation","id":"obs-1","status":"final","code":{"coding":[{"system":"http://loinc.org","code":"29463-7"}]},
 "subject":{"reference":"urn:uuid:pat-1"},"effectiveDateTime":"2026-02-01","valueQuantity":{"value":70.50,"unit":"kg","system":"http://unitsofmeasure.org","code":"kg"}}}]}`;

async function makeApp() {
  const app = express();
  app.use(express.raw({ type: 'application/fhir+json', limit: '50mb' }));
  // (as server.js: though the ips module reads its own bodies there)
  app.use(express.json({ limit: '50mb', verify: (req, res, buf) => {
    req.rawBody = buf;
  } }));
  setupAuth();
  mountAuth(app);
  const mod = new IpsModule(stats, quietLog);
  await mod.initialize({ database: ':memory:', rateLimit: { max: 0 }, cookieSecure: false, processing: { enabled: false } }, app);
  app.use('/ips', mod.router);
  mod.store.createProject('demo', 'Demo', null);
  return { app, mod };
}

describe('IPS: decimals keep their precision', () => {
  let app;
  let mod;
  beforeEach(async () => {
    ({ app, mod } = await makeApp());
  });
  afterEach(() => {
    mod.shutdown();
  });

  test('received, stored, read, searched, and in $document', async () => {
    const r = await request(app).post('/ips/demo/Bundle').set('Content-Type', 'application/fhir+json').send(DOC);
    expect(r.status).toBe(201);
    const read = await request(app).get('/ips/demo/Bundle/1?_format=json');
    expect(read.text).toMatch(/"value": ?70.50/);
    const search = await request(app).get('/ips/demo/Bundle?_format=json');
    expect(search.text).toMatch(/"value": ?70.50/);
    const doc = await request(app).get('/ips/demo/Bundle/1/$document');
    expect(doc.status).toBe(200);
    expect(doc.text).toMatch(/"value": ?70.50/);
    // the copy the pipeline works on
    const row = mod.store.read(1, mod.store.projectByCode('demo').id);
    expect(fhirJson.stringify(row.bundle)).toContain('"value":70.50');
  });

  test('a document with a property more than once in an object is refused (parsing would lose one)', async () => {
    const dup = DOC.replace('"gender":"female"', '"gender":"female","gender":"male"');
    const r = await request(app).post('/ips/demo/Bundle').set('Content-Type', 'application/fhir+json').send(dup);
    expect(r.status).toBe(400);
    expect(r.body.resourceType).toBe('OperationOutcome');
    expect(r.body.issue[0].details.text).toBe("The JSON property 'gender' is a duplicate, so the content can't be accepted");
    expect(r.body.issue[0].expression).toEqual(['Bundle.entry[1].resource']);
    expect(r.body.issue[0].extension.find(e => e.url.endsWith('message-id')).valueString).toBe('DUPLICATE_JSON_PROPERTY_REJECTED');
    const json = await request(app).post('/ips/demo/Bundle').set('Content-Type', 'application/json').send(dup);
    expect(json.status).toBe(400);
    expect(mod.store.read(1, mod.store.projectByCode('demo').id)).toBeFalsy();
  });

  test('the narrative shows the value as written', async () => {
    const bundle = fhirJson.parse(DOC);
    const out = await new Presenter().render(bundle);
    expect(JSON.stringify(out)).toContain('70.50');
  });
});
