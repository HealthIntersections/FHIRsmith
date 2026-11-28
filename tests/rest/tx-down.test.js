//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// :below and :above with a terminology server that isn't working (a txServer that points
// where there's no terminology server): refused (501), not answered from what the database has

const request = require('supertest');
const { engines, makeApp, body, FHIR_JSON } = require('./helpers');

describe.each(engines())('rest: :below and :above when the terminology server isn\'t working (%s)', (engine) => {
  let t;

  beforeAll(async () => {
    t = await makeApp(engine, { settings: { txServer: '/no-terminology-server-here' } });
    await request(t.app).post('/r4/Observation').set('Content-Type', FHIR_JSON)
      .send(body({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://hl7.org/fhir/fhir-types', code: 'DomainResource' }] } }));
  }, 60000);

  afterAll(async () => {
    await t.close();
  });

  test('a search with :below or :above is refused (501), and says why', async () => {
    for (const m of ['below', 'above']) {
      const r = await request(t.app).get(`/r4/Observation?code:${m}=${encodeURIComponent('http://hl7.org/fhir/fhir-types|DomainResource')}`);
      expect(r.status).toBe(501);
      expect(JSON.stringify(r.body)).toContain('txServer /no-terminology-server-here');
      expect(JSON.stringify(r.body)).toContain('isn\'t working');
    }
  });

  test('other searches are unaffected', async () => {
    const r = await request(t.app).get(`/r4/Observation?code=${encodeURIComponent('http://hl7.org/fhir/fhir-types|DomainResource')}`);
    expect(r.status).toBe(200);
    expect(r.body.total === undefined || r.body.total === 1).toBe(true);
  });
});
