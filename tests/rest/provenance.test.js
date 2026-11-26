//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// The X-Provenance header (rest/interactions/provenance.js): the Provenance is stored, with
// its targets the versions the write made, in the write's own transaction.

const request = require('supertest');
const { engines, makeApp, FHIR_JSON } = require('./helpers');

const PRV = { resourceType: 'Provenance', recorded: '2026-11-26T10:00:00Z', agent: [{ who: { display: 'Dr Smith' } }],
  target: [{ reference: 'Patient/whatever' }], signature: [{ type: [{ system: 'urn:iso-astm:E1762-95:2013', code: '1.2.840.10065.1.12.1.1' }], when: '2026-11-26T10:00:00Z', who: { display: 'x' } }] };
const PAT = { resourceType: 'Patient', name: [{ family: 'Chalmers' }] };

describe.each(engines())('X-Provenance (%s)', (engine) => {
  let t;
  beforeEach(async () => {
    t = await makeApp(engine);
  });
  afterEach(async () => {
    await t.close();
  });

  const provenances = async () => {
    const r = await request(t.app).get('/r4/Provenance').set('Accept', FHIR_JSON);
    expect(r.status).toBe(200);
    return (r.body.entry || []).map(e => e.resource);
  };
  const post = (url, body, prv = PRV) => request(t.app).post(url).set('Content-Type', FHIR_JSON).set('X-Provenance', typeof prv === 'string' ? prv : JSON.stringify(prv)).send(JSON.stringify(body));
  const put = (url, body, prv = PRV) => request(t.app).put(url).set('Content-Type', FHIR_JSON).set('X-Provenance', JSON.stringify(prv)).send(JSON.stringify(body));

  test('create and update: one each, pointing at the version written', async () => {
    const c = await post('/r4/Patient', PAT);
    expect(c.status).toBe(201);
    const id = c.body.id;
    let list = await provenances();
    expect(list).toHaveLength(1);
    expect(list[0].target).toEqual([{ reference: `Patient/${id}/_history/1` }]);
    // the header's target and signature are dropped; the rest is kept
    expect(list[0].signature).toBeUndefined();
    expect(list[0].agent).toEqual(PRV.agent);
    expect(list[0].recorded).toBe(PRV.recorded);
    const u = await put(`/r4/Patient/${id}`, { ...PAT, id, active: true });
    expect(u.status).toBe(200);
    list = await provenances();
    expect(list.map(p => p.target[0].reference).sort()).toEqual([`Patient/${id}/_history/1`, `Patient/${id}/_history/2`]);
    // and Provenance's own search parameters find it
    const s = await request(t.app).get(`/r4/Provenance?target=Patient/${id}`).set('Accept', FHIR_JSON);
    expect(s.body.entry.length).toBeGreaterThanOrEqual(1);
  });

  test('recorded is the time of the write when the header has none; UTF-8 in the header', async () => {
    const before = Date.now();
    const c = await post('/r4/Patient', PAT, { resourceType: 'Provenance', agent: [{ who: { display: 'Dr Müller' } }] });
    expect(c.status).toBe(201);
    const [p] = await provenances();
    expect(Date.parse(p.recorded)).toBeGreaterThanOrEqual(before - 1000);
    expect(p.agent[0].who.display).toBe('Dr Müller');
  });

  test('patch', async () => {
    const c = await request(t.app).post('/r4/Patient').set('Content-Type', FHIR_JSON).send(JSON.stringify(PAT));
    const id = c.body.id;
    const p = await request(t.app).patch(`/r4/Patient/${id}`).set('Content-Type', 'application/json-patch+json')
      .set('X-Provenance', JSON.stringify(PRV)).send(JSON.stringify([{ op: 'add', path: '/active', value: true }]));
    expect(p.status).toBe(200);
    const list = await provenances();
    expect(list.map(x => x.target)).toEqual([[{ reference: `Patient/${id}/_history/2` }]]);
  });

  test('a transaction: one, for everything it wrote', async () => {
    const tx = { resourceType: 'Bundle', type: 'transaction', entry: [
      { fullUrl: 'urn:uuid:11111111-1111-1111-1111-111111111111', resource: PAT, request: { method: 'POST', url: 'Patient' } },
      { resource: { resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: 'urn:uuid:11111111-1111-1111-1111-111111111111' } },
        request: { method: 'POST', url: 'Observation' } },
      { request: { method: 'GET', url: 'Patient' } }
    ] };
    const r = await post('/r4', tx);
    expect(r.status).toBe(200);
    const list = await provenances();
    expect(list).toHaveLength(1);
    const locations = r.body.entry.slice(0, 2).map(e => e.response.location);
    expect(list[0].target.map(x => x.reference).sort()).toEqual(locations.sort());
  });

  test('a batch: one for each write', async () => {
    const batch = { resourceType: 'Bundle', type: 'batch', entry: [
      { resource: PAT, request: { method: 'POST', url: 'Patient' } },
      { resource: PAT, request: { method: 'POST', url: 'Patient' } },
      { request: { method: 'GET', url: 'Patient' } }
    ] };
    const r = await post('/r4', batch);
    expect(r.status).toBe(200);
    expect((await provenances()).map(p => p.target.length)).toEqual([1, 1]);
  });

  test('a conditional create that finds the resource writes no Provenance', async () => {
    const pat = { ...PAT, identifier: [{ system: 'urn:x', value: '1' }] };
    expect((await post('/r4/Patient', pat)).status).toBe(201);
    const again = await request(t.app).post('/r4/Patient').set('Content-Type', FHIR_JSON).set('If-None-Exist', 'identifier=urn:x|1')
      .set('X-Provenance', JSON.stringify(PRV)).send(JSON.stringify(pat));
    expect(again.status).toBe(200);
    expect(await provenances()).toHaveLength(1);
  });

  test('refused: not JSON, not a Provenance, duplicates, or on a read', async () => {
    for (const [prv, text] of [['{"resourceType":', /not valid JSON/], [{ resourceType: 'Patient' }, /must be a Provenance/],
      ['{"resourceType":"Provenance","recorded":"2026-01-01","recorded":"2026-01-02"}', /'recorded'/]]) {
      const r = await post('/r4/Patient', PAT, prv);
      expect(r.status).toBe(400);
      expect(r.body.issue[0].details.text).toMatch(text);
    }
    const read = await request(t.app).get('/r4/Patient').set('Accept', FHIR_JSON).set('X-Provenance', JSON.stringify(PRV));
    expect(read.status).toBe(400);
    expect(read.body.issue[0].details.text).toMatch(/only be used on a create, update, patch, batch or transaction/);
    // nothing was written
    const all = await request(t.app).get('/r4/Patient').set('Accept', FHIR_JSON);
    expect(all.body.entry || []).toHaveLength(0);
    expect(await provenances()).toHaveLength(0);
  });

  test('a Provenance that can\'t be stored fails the write', async () => {
    const r = await post('/r4/Patient', PAT, { ...PRV, agent: [{ who: { reference: 'Practitioner/nowhere' } }] });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const all = await request(t.app).get('/r4/Patient').set('Accept', FHIR_JSON);
    expect(all.body.entry || []).toHaveLength(0);
    expect(await provenances()).toHaveLength(0);
  });
});
