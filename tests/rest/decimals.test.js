//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// Decimals keep their precision (library/fhir-json.js): what goes in as 1.50 comes out as
// 1.50, in JSON and XML, through every way a resource is written and read. And JSON with a
// property more than once in an object is refused.

const request = require('supertest');
const { engines, makeApp, FHIR_JSON } = require('./helpers');

const OBS = '{"resourceType":"Observation","status":"final","code":{"text":"weight"},' +
  '"valueQuantity":{"value":70.50,"unit":"kg","system":"http://unitsofmeasure.org","code":"kg"},' +
  '"component":[{"code":{"text":"x"},"valueQuantity":{"value":1.0}},{"code":{"text":"y"},"valueQuantity":{"value":1E+3}}]}';

describe.each(engines())('decimals keep their precision (%s)', (engine) => {
  let t;
  beforeEach(async () => {
    t = await makeApp(engine);
  });
  afterEach(async () => {
    await t.close();
  });

  const raw = (req) => req.buffer(true).parse((res, cb) => {
    let s = '';
    res.on('data', d => {
      s += d;
    });
    res.on('end', () => cb(null, s));
  });

  test('create, read, vread, search, history; JSON and XML', async () => {
    const c = await raw(request(t.app).post('/r4/Observation').set('Content-Type', FHIR_JSON).send(OBS));
    expect(c.status).toBe(201);
    expect(c.body).toContain('"value":70.50');
    const id = JSON.parse(c.body).id;
    for (const url of [`/r4/Observation/${id}`, `/r4/Observation/${id}/_history/1`, '/r4/Observation?code:text=weight', `/r4/Observation/${id}/_history`,
      `/r4/Observation?_id=${id}&_summary=data`]) {
      const r = await raw(request(t.app).get(url).set('Accept', FHIR_JSON));
      expect(r.status).toBe(200);
      expect(r.body).toContain('"value":70.50');
      expect(r.body).toContain('"value":1.0}');
      expect(r.body).toContain('"value":1E+3}');
    }
    const x = await raw(request(t.app).get(`/r4/Observation/${id}`).set('Accept', 'application/fhir+xml'));
    expect(x.body).toContain('<value value="70.50"/>');
    expect(x.body).toContain('<value value="1.0"/>');
  });

  test('XML in, and updates', async () => {
    const xml = '<Observation xmlns="http://hl7.org/fhir"><status value="final"/><code><text value="t"/></code>' +
      '<valueQuantity><value value="37.0"/><unit value="Cel"/></valueQuantity></Observation>';
    const c = await raw(request(t.app).post('/r4/Observation').set('Content-Type', 'application/fhir+xml').set('Accept', FHIR_JSON).send(xml));
    expect(c.status).toBe(201);
    expect(c.body).toContain('"value":37.0');
    const id = JSON.parse(c.body).id;
    const u = await raw(request(t.app).put(`/r4/Observation/${id}`).set('Content-Type', FHIR_JSON)
      .send(OBS.replace('"resourceType":"Observation"', `"resourceType":"Observation","id":"${id}"`).replace('70.50', '71.250')));
    expect(u.status).toBe(200);
    expect((await raw(request(t.app).get(`/r4/Observation/${id}`))).body).toContain('"value":71.250');
  });

  test('patches: what they add keeps its precision, and the rest is untouched', async () => {
    const id = JSON.parse((await raw(request(t.app).post('/r4/Observation').set('Content-Type', FHIR_JSON).send(OBS))).body).id;
    const jp = await raw(request(t.app).patch(`/r4/Observation/${id}`).set('Content-Type', 'application/json-patch+json')
      .send('[{"op":"replace","path":"/component/0/valueQuantity/value","value":2.00}]'));
    expect(jp.status).toBe(200);
    expect(jp.body).toContain('"value":2.00}');
    expect(jp.body).toContain('"value":70.50');
    const fp = await raw(request(t.app).patch(`/r4/Observation/${id}`).set('Content-Type', FHIR_JSON)
      .send('{"resourceType":"Parameters","parameter":[{"name":"operation","part":[{"name":"type","valueCode":"add"},' +
        '{"name":"path","valueString":"Observation.component[1].valueQuantity"},{"name":"name","valueString":"value"},{"name":"value","valueDecimal":3.10}]}]}'));
    expect(fp.status).toBe(422);
    const fp2 = await raw(request(t.app).patch(`/r4/Observation/${id}`).set('Content-Type', FHIR_JSON)
      .send('{"resourceType":"Parameters","parameter":[{"name":"operation","part":[{"name":"type","valueCode":"replace"},' +
        '{"name":"path","valueString":"Observation.component[1].valueQuantity.value"},{"name":"value","valueDecimal":3.10}]}]}'));
    expect(fp2.status).toBe(200);
    expect(fp2.body).toContain('"value":3.10}');
    expect(fp2.body).toContain('"value":2.00}');
    expect(fp2.body).toContain('"value":70.50');
  });

  test('application/json too', async () => {
    const c = await raw(request(t.app).post('/r4/Observation').set('Content-Type', 'application/json').send(OBS));
    expect(c.status).toBe(201);
    expect(c.body).toContain('"value":70.50');
  });

  test('a property more than once in an object is refused, however the body comes', async () => {
    const dup = OBS.replace('"status":"final"', '"status":"final","status":"preliminary"');
    for (const ct of [FHIR_JSON, 'application/json']) {
      const r = await request(t.app).post('/r4/Observation').set('Content-Type', ct).send(dup);
      expect(r.status).toBe(400);
      const issue = r.body.issue[0];
      expect(issue.details.text).toBe("The JSON property 'status' is a duplicate, so the content can't be accepted");
      expect(issue.expression).toEqual(['Observation']);
      expect(issue.extension.find(e => e.url.endsWith('message-id')).valueString).toBe('DUPLICATE_JSON_PROPERTY_REJECTED');
      expect(issue.extension.find(e => e.url.endsWith('issue-line')).valueInteger).toBe(1);
    }
    // in the request's language
    const de = await request(t.app).post('/r4/Observation').set('Content-Type', FHIR_JSON).set('Accept-Language', 'de').send(dup);
    expect(de.body.issue[0].details.text).toBe("Die JSON-Eigenschaft 'status' ist ein Duplikat, daher kann der Inhalt nicht akzeptiert werden");
    const id = JSON.parse((await raw(request(t.app).post('/r4/Observation').set('Content-Type', FHIR_JSON).send(OBS))).body).id;
    const put = await request(t.app).put(`/r4/Observation/${id}`).set('Content-Type', FHIR_JSON)
      .send(OBS.replace('"resourceType":"Observation"', `"resourceType":"Observation","id":"${id}"`).replace('"value":1.0}', '"value":1.0,"value":2}'));
    expect(put.status).toBe(400);
    expect(put.body.issue[0].details.text).toMatch(/'value'/);
    expect(put.body.issue[0].expression).toEqual(['Observation.component[0].valueQuantity']);
    const tx = await request(t.app).post('/r4').set('Content-Type', FHIR_JSON)
      .send(`{"resourceType":"Bundle","type":"transaction","entry":[{"resource":${dup},"request":{"method":"POST","url":"Observation"}}]}`);
    expect(tx.status).toBe(400);
    expect(tx.body.issue[0].expression).toEqual(['Bundle.entry[0].resource']);
    // the same name in different objects is fine
    expect((await request(t.app).post('/r4/Observation').set('Content-Type', FHIR_JSON).send(OBS)).status).toBe(201);
  });

  test('in a transaction', async () => {
    const bundle = `{"resourceType":"Bundle","type":"transaction","entry":[{"resource":${OBS},"request":{"method":"POST","url":"Observation"}}]}`;
    const r = await raw(request(t.app).post('/r4').set('Content-Type', FHIR_JSON).set('Prefer', 'return=representation').send(bundle));
    expect(r.status).toBe(200);
    const loc = JSON.parse(r.body).entry[0].response.location;
    const read = await raw(request(t.app).get('/r4/' + loc.split('/_history')[0]));
    expect(read.body).toContain('"value":70.50');
  });
});
