//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const request = require('supertest');
const { engines, makeApp, body, FHIR_JSON } = require('./helpers');
const { migrate, waitForSchema, SCHEMA_VERSION } = require('../../rest/database/schema');

describe.each(engines())('rest batch, transaction and concurrency (%s)', (engine) => {
  let t;
  beforeEach(async () => {
    t = await makeApp(engine);
  });
  afterEach(async () => {
    await t.close();
  });

  const postBundle = (b) => request(t.app).post('/r4').set('Content-Type', FHIR_JSON).send(body(b));
  const count = async (type) => (await request(t.app).get(`/r4/${type}?_summary=count`)).body.total;

  test('a transaction with urn:uuid references, conditional references and every method', async () => {
    const existing = (await request(t.app).post('/r4/Organization').set('Content-Type', FHIR_JSON)
      .send(body({ resourceType: 'Organization', identifier: [{ system: 'urn:org', value: 'o1' }], name: 'Org' }))).body.id;
    const toDelete = (await request(t.app).post('/r4/Practitioner').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Practitioner' }))).body.id;
    const r = await postBundle({ resourceType: 'Bundle', type: 'transaction', entry: [
      { fullUrl: 'urn:uuid:obs', resource: { resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: 'urn:uuid:pat' } },
        request: { method: 'POST', url: 'Observation' } },
      { fullUrl: 'urn:uuid:pat', resource: { resourceType: 'Patient', managingOrganization: { reference: 'Organization?identifier=urn:org|o1' },
        text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml"><a href="urn:uuid:obs">obs</a></div>' } },
        request: { method: 'POST', url: 'Patient' } },
      { request: { method: 'DELETE', url: `Practitioner/${toDelete}` } },
      { resource: { resourceType: 'Patient', id: 'fixed', name: [{ family: 'Fixed' }] }, request: { method: 'PUT', url: 'Patient/fixed' } },
      { request: { method: 'GET', url: 'Patient?family=fixed' } }
    ] });
    expect(r.status).toBe(200);
    expect(r.body.type).toBe('transaction-response');
    const res = r.body.entry.map(e => e.response.status);
    expect(res).toEqual(['201 Created', '201 Created', '200 OK', '201 Created', '200 OK']);
    const obsLoc = r.body.entry[0].response.location;
    const patLoc = r.body.entry[1].response.location;
    const obs = (await request(t.app).get('/r4/' + obsLoc.split('/_history')[0])).body;
    const pat = (await request(t.app).get('/r4/' + patLoc.split('/_history')[0])).body;
    expect(obs.subject.reference).toBe(`Patient/${pat.id}`);
    expect(pat.managingOrganization.reference).toBe(`Organization/${existing}`);
    expect(pat.text.div).toContain(`Observation/${obs.id}`);
    // the search ran after the writes
    expect(r.body.entry[4].resource.total).toBe(1);
    expect((await request(t.app).get(`/r4/Practitioner/${toDelete}`)).status).toBe(410);
    // and the references were indexed
    expect((await request(t.app).get(`/r4/Observation?subject=Patient/${pat.id}`)).body.total).toBe(1);
  });

  test('a transaction that fails rolls everything back', async () => {
    const before = await count('Patient');
    const r = await postBundle({ resourceType: 'Bundle', type: 'transaction', entry: [
      { fullUrl: 'urn:uuid:a', resource: { resourceType: 'Patient' }, request: { method: 'POST', url: 'Patient' } },
      { resource: { resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: 'Patient/missing' } }, request: { method: 'POST', url: 'Observation' } }
    ] });
    expect(r.status).toBe(422);
    expect(await count('Patient')).toBe(before);
    expect(await count('Observation')).toBe(0);
    const bad = await postBundle({ resourceType: 'Bundle', type: 'transaction', entry: [
      { resource: { resourceType: 'Patient' }, request: { method: 'POST', url: 'Patient' } },
      { resource: { resourceType: 'Patient', id: 'x' }, request: { method: 'PUT', url: 'Patient/y' } }
    ] });
    expect(bad.status).toBe(400);
    expect(bad.body.issue[0].diagnostics).toMatch(/Entry 1/);
    expect(await count('Patient')).toBe(before);
    const cond = await postBundle({ resourceType: 'Bundle', type: 'transaction', entry: [
      { resource: { resourceType: 'Patient', managingOrganization: { reference: 'Organization?name=nothing' } }, request: { method: 'POST', url: 'Patient' } }
    ] });
    expect(cond.status).toBe(412);
  });

  test('conditional create inside a transaction', async () => {
    const b = { resourceType: 'Bundle', type: 'transaction', entry: [
      { fullUrl: 'urn:uuid:p', resource: { resourceType: 'Patient', identifier: [{ system: 'urn:x', value: '1' }] },
        request: { method: 'POST', url: 'Patient', ifNoneExist: 'identifier=urn:x|1' } },
      { resource: { resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: 'urn:uuid:p' } }, request: { method: 'POST', url: 'Observation' } }
    ] };
    const first = await postBundle(b);
    expect(first.status).toBe(200);
    const second = await postBundle(b);
    expect(second.status).toBe(200);
    expect(second.body.entry[0].response.status).toBe('200 OK');
    expect(await count('Patient')).toBe(1);
    expect(await count('Observation')).toBe(2);
  });

  test('a batch: each entry on its own', async () => {
    const r = await postBundle({ resourceType: 'Bundle', type: 'batch', entry: [
      { resource: { resourceType: 'Patient' }, request: { method: 'POST', url: 'Patient' } },
      { request: { method: 'GET', url: 'Patient/missing' } },
      { resource: { resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: 'Patient/missing' } }, request: { method: 'POST', url: 'Observation' } },
      { request: { method: 'GET', url: 'metadata' } }
    ] });
    expect(r.status).toBe(200);
    expect(r.body.type).toBe('batch-response');
    expect(r.body.entry.map(e => e.response.status.split(' ')[0])).toEqual(['201', '404', '422', '200']);
    expect(r.body.entry[1].response.outcome.resourceType).toBe('OperationOutcome');
    expect(await count('Patient')).toBe(1);
  });

  test('not a batch or transaction', async () => {
    expect((await postBundle({ resourceType: 'Bundle', type: 'collection' })).status).toBe(400);
    expect((await postBundle({ resourceType: 'Patient' })).status).toBe(400);
  });

  test('concurrent updates to one resource all get their own version', async () => {
    const id = (await request(t.app).post('/r4/Patient').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Patient' }))).body.id;
    const n = 10;
    const results = await Promise.all(Array.from({ length: n }, (_, i) => request(t.app).put(`/r4/Patient/${id}`).set('Content-Type', FHIR_JSON)
      .send(body({ resourceType: 'Patient', id, name: [{ family: 'F' + i }] }))));
    expect(results.every(r => r.status === 200)).toBe(true);
    const versions = results.map(r => Number(r.body.meta.versionId)).sort((a, b) => a - b);
    expect(versions).toEqual(Array.from({ length: n }, (_, i) => i + 2));
    const h = await request(t.app).get(`/r4/Patient/${id}/_history?_count=50`);
    expect(h.body.total).toBe(n + 1);
  });

  test('concurrent conditional creates make one resource', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => request(t.app).post('/r4/Patient').set('Content-Type', FHIR_JSON)
      .set('If-None-Exist', 'identifier=urn:race|1').send(body({ resourceType: 'Patient', identifier: [{ system: 'urn:race', value: '1' }] }))));
    expect(results.filter(r => r.status === 201).length).toBe(1);
    expect(results.filter(r => r.status === 200).length).toBe(5);
    expect(await count('Patient')).toBe(1);
  });

  test('concurrent If-Match updates: one wins, the rest get 412', async () => {
    const id = (await request(t.app).post('/r4/Patient').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Patient' }))).body.id;
    const results = await Promise.all(Array.from({ length: 5 }, () => request(t.app).put(`/r4/Patient/${id}`).set('Content-Type', FHIR_JSON)
      .set('If-Match', 'W/"1"').send(body({ resourceType: 'Patient', id }))));
    expect(results.filter(r => r.status === 200).length).toBe(1);
    expect(results.filter(r => r.status === 412).length).toBe(4);
  });

  test('the schema: migrating again changes nothing; a worker waits for it; a newer one is refused', async () => {
    await migrate(t.ep.db, () => {});
    await expect(waitForSchema(t.ep.db)).resolves.toBeUndefined();
    const v = await t.ep.db.read(q => q.get('SELECT Value FROM Config WHERE Name = ?', ['schemaVersion']));
    expect(Number(v.Value)).toBe(SCHEMA_VERSION);
    await t.ep.db.write(q => q.run('UPDATE Config SET Value = ? WHERE Name = ?', [String(SCHEMA_VERSION + 1), 'schemaVersion']));
    await expect(migrate(t.ep.db, () => {})).rejects.toThrow(/newer/);
    await t.ep.db.write(q => q.run('UPDATE Config SET Value = ? WHERE Name = ?', [String(SCHEMA_VERSION), 'schemaVersion']));
  });

  test('settings: a change in the database reaches the endpoint', async () => {
    const { set } = require('../../rest/endpoint/settings');
    await set(t.ep.db, { name: 'Renamed' });
    t.ep.lastGenerationCheck = 0;
    const r = await request(t.app).get('/r4/metadata');
    expect(r.body.title).toBe('Renamed');
  });

  test('a custom search parameter is used, and what is already there is reindexed', async () => {
    await t.close();
    t = await makeApp(engine, { settings: { customSearchParameters: true } });
    const mmn = (v) => ({ resourceType: 'Patient', extension: [{ url: 'http://example.org/mmn', valueString: v }] });
    const before = (await request(t.app).post('/r4/Patient').set('Content-Type', FHIR_JSON).send(body(mmn('Jones')))).body.id;
    const sp = await request(t.app).post('/r4/SearchParameter').set('Content-Type', FHIR_JSON).send(body({
      resourceType: 'SearchParameter', url: 'http://example.org/SearchParameter/mmn', name: 'mmn', status: 'active', description: 'x',
      code: 'mothers-maiden-name', base: ['Patient'], type: 'string', expression: "Patient.extension('http://example.org/mmn').value"
    }));
    expect(sp.status).toBe(201);
    t.ep.lastGenerationCheck = 0;
    await t.ep.refresh();
    expect(t.ep.definitions.param('Patient', 'mothers-maiden-name')).not.toBeNull();
    while (await t.ep.reindexBatch() > 0) {
      // the next batch
    }
    const after = (await request(t.app).post('/r4/Patient').set('Content-Type', FHIR_JSON).send(body(mmn('Jonas')))).body.id;
    t.ep.lastGenerationCheck = 0;
    const r = await request(t.app).get('/r4/Patient?mothers-maiden-name=jon');
    expect(r.body.entry.map(e => e.resource.id).sort()).toEqual([before, after].sort());
    expect(r.body.entry.some(e => e.search.mode === 'outcome')).toBe(false);
  });
});
