//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const request = require('supertest');
const { engines, makeApp, body, FHIR_JSON } = require('./helpers');

const patient = (extra = {}) => ({ resourceType: 'Patient', name: [{ family: 'Chalmers', given: ['Peter'] }], gender: 'male', birthDate: '1974-12-25', ...extra });

describe.each(engines())('rest interactions (%s)', (engine) => {
  let t;
  beforeEach(async () => {
    t = await makeApp(engine);
  });
  afterEach(async () => {
    await t.close();
  });

  const post = (path, resource, headers = {}) => request(t.app).post(path).set({ 'Content-Type': FHIR_JSON, ...headers }).send(body(resource));
  const put = (path, resource, headers = {}) => request(t.app).put(path).set({ 'Content-Type': FHIR_JSON, ...headers }).send(body(resource));

  test('create and read', async () => {
    const c = await post('/r4/Patient', patient({ id: 'ignored' }));
    expect(c.status).toBe(201);
    expect(c.headers.location).toMatch(/\/r4\/Patient\/[^/]+\/_history\/1$/);
    expect(c.headers.etag).toBe('W/"1"');
    const id = c.body.id;
    expect(id).not.toBe('ignored');
    expect(c.body.meta.versionId).toBe('1');
    const r = await request(t.app).get(`/r4/Patient/${id}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/fhir\+json/);
    expect(r.body.name[0].family).toBe('Chalmers');
    expect(r.headers['last-modified']).toBeDefined();
  });

  test('server-assigned ids are the resource key, unless a client already took it', async () => {
    const p = await put('/r4/Patient/2', patient({ id: '2' }));
    expect(p.status).toBe(201);
    const c = await post('/r4/Patient', patient());
    expect(c.status).toBe(201);
    // key 2 is the client's: a UUID instead
    expect(c.body.id === '2').toBe(false);
  });

  test('read of something unknown, and of something deleted', async () => {
    expect((await request(t.app).get('/r4/Patient/nope')).status).toBe(404);
    expect((await request(t.app).get('/r4/Nothing/1')).status).toBe(404);
    const c = await post('/r4/Patient', patient());
    const d = await request(t.app).delete(`/r4/Patient/${c.body.id}`);
    expect(d.status).toBe(200);
    expect((await request(t.app).get(`/r4/Patient/${c.body.id}`)).status).toBe(410);
    // deleting again is fine
    expect((await request(t.app).delete(`/r4/Patient/${c.body.id}`)).status).toBe(200);
    // and it can be created again by PUT
    const again = await put(`/r4/Patient/${c.body.id}`, patient({ id: c.body.id }));
    expect(again.status).toBe(201);
    expect(again.body.meta.versionId).toBe('3');
  });

  test('If-None-Match gives 304', async () => {
    const c = await post('/r4/Patient', patient());
    const r = await request(t.app).get(`/r4/Patient/${c.body.id}`).set('If-None-Match', 'W/"1"');
    expect(r.status).toBe(304);
  });

  test('update, version checks, vread and history', async () => {
    const c = await post('/r4/Patient', patient());
    const id = c.body.id;
    const u = await put(`/r4/Patient/${id}`, patient({ id, active: true }), { 'If-Match': 'W/"1"' });
    expect(u.status).toBe(200);
    expect(u.body.meta.versionId).toBe('2');
    const stale = await put(`/r4/Patient/${id}`, patient({ id }), { 'If-Match': 'W/"1"' });
    expect(stale.status).toBe(412);
    expect(stale.body.resourceType).toBe('OperationOutcome');
    const v1 = await request(t.app).get(`/r4/Patient/${id}/_history/1`);
    expect(v1.status).toBe(200);
    expect(v1.body.active).toBeUndefined();
    expect((await request(t.app).get(`/r4/Patient/${id}/_history/9`)).status).toBe(404);
    const h = await request(t.app).get(`/r4/Patient/${id}/_history`);
    expect(h.body.type).toBe('history');
    expect(h.body.total).toBe(2);
    expect(h.body.entry.map(e => e.request.method)).toEqual(['PUT', 'POST']);
  });

  test('update checks the id', async () => {
    const c = await post('/r4/Patient', patient());
    expect((await put(`/r4/Patient/${c.body.id}`, patient({ id: 'other' }))).status).toBe(400);
    expect((await put(`/r4/Patient/${c.body.id}`, patient())).status).toBe(400);
    expect((await put(`/r4/Patient/${c.body.id}`, { resourceType: 'Observation', id: c.body.id })).status).toBe(400);
  });

  test('Prefer: return=minimal and OperationOutcome', async () => {
    const m = await post('/r4/Patient', patient(), { Prefer: 'return=minimal' });
    expect(m.status).toBe(201);
    expect(m.text).toBe('');
    const o = await post('/r4/Patient', patient(), { Prefer: 'return=OperationOutcome' });
    expect(o.body.resourceType).toBe('OperationOutcome');
  });

  test('JSON Patch', async () => {
    const c = await post('/r4/Patient', patient());
    const p = await request(t.app).patch(`/r4/Patient/${c.body.id}`).set('Content-Type', 'application/json-patch+json')
      .send(JSON.stringify([{ op: 'replace', path: '/gender', value: 'female' }, { op: 'add', path: '/name/0/given/-', value: 'James' }]));
    expect(p.status).toBe(200);
    expect(p.body.gender).toBe('female');
    expect(p.body.name[0].given).toEqual(['Peter', 'James']);
    expect(p.body.meta.versionId).toBe('2');
    const bad = await request(t.app).patch(`/r4/Patient/${c.body.id}`).set('Content-Type', 'application/json-patch+json')
      .send(JSON.stringify([{ op: 'test', path: '/gender', value: 'male' }]));
    expect(bad.status).toBe(422);
    const id = await request(t.app).patch(`/r4/Patient/${c.body.id}`).set('Content-Type', 'application/json-patch+json')
      .send(JSON.stringify([{ op: 'replace', path: '/id', value: 'x' }]));
    expect(id.status).toBe(422);
  });

  test('FHIRPath Patch: JSON and XML, in a transaction, and errors', async () => {
    const c = await post('/r4/Patient', patient());
    const op = (type, path, more = []) => ({ name: 'operation', part: [{ name: 'type', valueCode: type }, { name: 'path', valueString: path }, ...more] });
    const fp = { resourceType: 'Parameters', parameter: [
      op('replace', 'Patient.gender', [{ name: 'value', valueCode: 'female' }]),
      op('insert', 'Patient.name[0].given', [{ name: 'value', valueString: 'James' }, { name: 'index', valueInteger: 1 }]),
      op('add', 'Patient', [{ name: 'name', valueString: 'contact' }, { name: 'value', part: [{ name: 'gender', valueCode: 'male' }] }])
    ] };
    const p = await request(t.app).patch(`/r4/Patient/${c.body.id}`).set('Content-Type', FHIR_JSON).send(body(fp));
    expect(p.status).toBe(200);
    expect(p.body.gender).toBe('female');
    expect(p.body.name[0].given).toEqual(['Peter', 'James']);
    expect(p.body.contact).toEqual([{ gender: 'male' }]);
    expect(p.body.meta.versionId).toBe('2');

    const xml = '<Parameters xmlns="http://hl7.org/fhir"><parameter><name value="operation"/>' +
      '<part><name value="type"/><valueCode value="delete"/></part><part><name value="path"/><valueString value="Patient.contact"/></part>' +
      '</parameter></Parameters>';
    const x = await request(t.app).patch(`/r4/Patient/${c.body.id}`).set('Content-Type', 'application/fhir+xml').set('Accept', FHIR_JSON).send(xml);
    expect(x.status).toBe(200);
    expect(x.body.contact).toBeUndefined();
    expect(x.body.meta.versionId).toBe('3');

    const missing = await request(t.app).patch(`/r4/Patient/${c.body.id}`).set('Content-Type', FHIR_JSON)
      .send(body({ resourceType: 'Parameters', parameter: [op('replace', 'Patient.deceased', [{ name: 'value', valueBoolean: true }])] }));
    expect(missing.status).toBe(422);
    expect(missing.body.issue[0].diagnostics).toMatch(/No content found at Patient.deceased when replacing/);
    const id = await request(t.app).patch(`/r4/Patient/${c.body.id}`).set('Content-Type', FHIR_JSON)
      .send(body({ resourceType: 'Parameters', parameter: [op('replace', 'Patient.id', [{ name: 'value', valueId: 'other' }])] }));
    expect(id.status).toBe(422);
    const notPatch = await request(t.app).patch(`/r4/Patient/${c.body.id}`).set('Content-Type', FHIR_JSON).send(body(patient()));
    expect(notPatch.status).toBe(400);

    // in a transaction, the Parameters is the entry's resource, and its references are rewritten
    const tx = await post('/r4', { resourceType: 'Bundle', type: 'transaction', entry: [
      { fullUrl: 'urn:uuid:7c1d2bd5-4a6c-4b2e-9d3a-0d6a2b1f8e01', resource: { resourceType: 'Organization', name: 'Acme' }, request: { method: 'POST', url: 'Organization' } },
      { resource: { resourceType: 'Parameters', parameter: [op('add', 'Patient', [{ name: 'name', valueString: 'managingOrganization' },
        { name: 'value', valueReference: { reference: 'urn:uuid:7c1d2bd5-4a6c-4b2e-9d3a-0d6a2b1f8e01' } }])] },
      request: { method: 'PATCH', url: `Patient/${c.body.id}` } }
    ] });
    expect(tx.status).toBe(200);
    const after = await request(t.app).get(`/r4/Patient/${c.body.id}`);
    expect(after.body.managingOrganization.reference).toMatch(/^Organization\/[^/]+$/);
    expect(after.body.meta.versionId).toBe('4');

    const caps = await request(t.app).get('/r4/metadata');
    expect(caps.body.patchFormat).toEqual(['application/json-patch+json', 'application/fhir+json', 'application/fhir+xml']);
  });

  test('references must resolve', async () => {
    const bad = await post('/r4/Observation', { resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: 'Patient/missing' } });
    expect(bad.status).toBe(422);
    expect(bad.body.issue[0].diagnostics).toMatch(/Patient\/missing/);
    const c = await post('/r4/Patient', patient());
    const good = await post('/r4/Observation', { resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: `Patient/${c.body.id}` } });
    expect(good.status).toBe(201);
    // an absolute reference to this endpoint is local too
    const abs = await post('/r4/Observation', { resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: 'http://test.example/r4/Patient/missing' } });
    expect(abs.status).toBe(422);
    // one elsewhere isn't checked
    const other = await post('/r4/Observation', { resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: 'http://elsewhere.org/fhir/Patient/1' } });
    expect(other.status).toBe(201);
    // deleting something referred to is allowed
    expect((await request(t.app).delete(`/r4/Patient/${c.body.id}`)).status).toBe(200);
  });

  test('conditional create, update and delete', async () => {
    const ident = { identifier: [{ system: 'urn:oid:1.2.3', value: 'abc' }] };
    const a = await post('/r4/Patient', patient(ident), { 'If-None-Exist': 'identifier=urn:oid:1.2.3|abc' });
    expect(a.status).toBe(201);
    const b = await post('/r4/Patient', patient(ident), { 'If-None-Exist': 'identifier=urn:oid:1.2.3|abc' });
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    const u = await put('/r4/Patient?identifier=urn:oid:1.2.3|abc', patient({ ...ident, active: true }));
    expect(u.status).toBe(200);
    expect(u.body.id).toBe(a.body.id);
    const n = await put('/r4/Patient?identifier=urn:oid:1.2.3|new', patient({ identifier: [{ system: 'urn:oid:1.2.3', value: 'new' }] }));
    expect(n.status).toBe(201);
    await post('/r4/Patient', patient({ identifier: [{ system: 'urn:oid:1.2.3', value: 'new' }] }));
    const many = await put('/r4/Patient?identifier=urn:oid:1.2.3|new', patient());
    expect(many.status).toBe(412);
    const d = await request(t.app).delete('/r4/Patient?identifier=urn:oid:1.2.3|abc');
    expect(d.status).toBe(200);
    expect((await request(t.app).get(`/r4/Patient/${a.body.id}`)).status).toBe(410);
    expect((await request(t.app).delete('/r4/Patient?identifier=urn:oid:1.2.3|new')).status).toBe(412);
    expect((await request(t.app).delete('/r4/Patient')).status).toBe(400);
  });

  test('capabilities', async () => {
    const r = await request(t.app).get('/r4/metadata');
    expect(r.status).toBe(200);
    expect(r.body.resourceType).toBe('CapabilityStatement');
    expect(r.body.fhirVersion).toBe('4.0.1');
    const p = r.body.rest[0].resource.find(x => x.type === 'Patient');
    expect(p.searchParam.some(s => s.name === 'birthdate')).toBe(true);
    expect(p.operation.some(o => o.name === 'everything')).toBe(true);
  });

  test('formats (XML: xml.test.js)', async () => {
    expect((await request(t.app).get('/r4/metadata?_format=turtle')).status).toBe(406);
    const x = await request(t.app).post('/r4/Patient').set('Content-Type', 'text/plain').send('Patient');
    expect(x.status).toBe(415);
    const bad = await request(t.app).post('/r4/Patient').set('Content-Type', FHIR_JSON).send('{ not json');
    expect(bad.status).toBe(400);
  });

  test('unknown interactions', async () => {
    expect((await request(t.app).post('/r4/Patient/1/_history')).status).toBe(405);
    expect((await request(t.app).get('/r4/Patient/1/$nonsense')).status).toBe(501);
  });

  test('$meta, $meta-add, $meta-delete', async () => {
    const c = await post('/r4/Patient', patient({ meta: { tag: [{ system: 'urn:t', code: 'one' }] } }));
    const id = c.body.id;
    const add = await post(`/r4/Patient/${id}/$meta-add`, { resourceType: 'Parameters', parameter: [{ name: 'meta', valueMeta: { tag: [{ system: 'urn:t', code: 'two' }], profile: ['http://x/p'] } }] });
    expect(add.status).toBe(200);
    expect(add.body.parameter[0].valueMeta.tag.map(x => x.code)).toEqual(['one', 'two']);
    // no new version
    expect((await request(t.app).get(`/r4/Patient/${id}`)).body.meta.versionId).toBe('1');
    expect((await request(t.app).get('/r4/Patient?_tag=urn:t|two')).body.total).toBe(1);
    expect((await request(t.app).get('/r4/Patient?_profile=http://x/p')).body.total).toBe(1);
    const del = await post(`/r4/Patient/${id}/$meta-delete`, { resourceType: 'Parameters', parameter: [{ name: 'meta', valueMeta: { tag: [{ system: 'urn:t', code: 'one' }] } }] });
    expect(del.body.parameter[0].valueMeta.tag.map(x => x.code)).toEqual(['two']);
    const m = await request(t.app).get(`/r4/Patient/${id}/$meta`);
    expect(m.body.parameter[0].valueMeta.tag.map(x => x.code)).toEqual(['two']);
    const sys = await request(t.app).get('/r4/$meta');
    expect(sys.body.parameter[0].valueMeta.profile).toEqual(['http://x/p']);
  });

  test('$everything', async () => {
    const c = await post('/r4/Patient', patient());
    const pr = await post('/r4/Practitioner', { resourceType: 'Practitioner', name: [{ family: 'Doc' }] });
    await post('/r4/Observation', { resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: `Patient/${c.body.id}` }, performer: [{ reference: `Practitioner/${pr.body.id}` }] });
    const other = await post('/r4/Patient', patient());
    await post('/r4/Observation', { resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: `Patient/${other.body.id}` } });
    const e = await request(t.app).get(`/r4/Patient/${c.body.id}/$everything`);
    expect(e.status).toBe(200);
    const types = e.body.entry.map(x => x.resource.resourceType).sort();
    expect(types).toEqual(['Observation', 'Patient', 'Practitioner']);
    expect((await request(t.app).get('/r4/Patient/nope/$everything')).status).toBe(404);
  });

  test('history of a type and of the endpoint, paged', async () => {
    for (let i = 0; i < 5; i++) {
      await post('/r4/Patient', patient());
    }
    await post('/r4/Practitioner', { resourceType: 'Practitioner' });
    const h = await request(t.app).get('/r4/Patient/_history?_count=3');
    expect(h.body.entry.length).toBe(3);
    const next = h.body.link.find(l => l.relation === 'next');
    expect(next).toBeDefined();
    const h2 = await request(t.app).get(next.url.replace(/^https?:\/\/[^/]+/, ''));
    expect(h2.body.entry.length).toBe(2);
    expect(h2.body.link.find(l => l.relation === 'next')).toBeUndefined();
    const all = await request(t.app).get('/r4/_history');
    expect(all.body.entry.length).toBe(6);
    const since = await request(t.app).get('/r4/_history?_since=2999-01-01');
    expect(since.body.entry.length).toBe(0);
  });

  test('types that are switched off, and interactions that aren\'t allowed', async () => {
    await t.close();
    t = await makeApp(engine, { types: { Patient: { interactions: ['read', 'search-type', 'create'] }, Group: { versionAware: true } } });
    const c = await post('/r4/Patient', patient());
    expect(c.status).toBe(201);
    expect((await request(t.app).delete(`/r4/Patient/${c.body.id}`)).status).toBe(405);
    const g = await post('/r4/Group', { resourceType: 'Group', type: 'person', actual: true });
    expect((await put(`/r4/Group/${g.body.id}`, { resourceType: 'Group', id: g.body.id, type: 'person', actual: false })).status).toBe(412);
    expect((await put(`/r4/Group/${g.body.id}`, { resourceType: 'Group', id: g.body.id, type: 'person', actual: false }, { 'If-Match': 'W/"1"' })).status).toBe(200);
  });

  test('no create by PUT when switched off', async () => {
    await t.close();
    t = await makeApp(engine, { settings: { createOnUpdate: false } });
    expect((await put('/r4/Patient/abc', patient({ id: 'abc' }))).status).toBe(405);
  });

  test('access', async () => {
    await t.close();
    const reader = { id: 2, login: 'reader', has: (m, role) => m === 'rest' && role === 'read' };
    let who = null;
    t = await makeApp(engine, { principal: async () => who });
    expect((await request(t.app).get('/r4/Patient')).status).toBe(401);
    who = reader;
    expect((await request(t.app).get('/r4/Patient')).status).toBe(200);
    expect((await post('/r4/Patient', patient())).status).toBe(403);
    await t.close();
    who = null;
    t = await makeApp(engine, { principal: async () => who, settings: { anonymous: 'read' } });
    expect((await request(t.app).get('/r4/Patient')).status).toBe(200);
    expect((await post('/r4/Patient', patient())).status).toBe(401);
  });

  test('AuditEvents', async () => {
    await t.close();
    t = await makeApp(engine, { settings: { audit: 'all' } });
    const c = await post('/r4/Patient', patient());
    await request(t.app).get(`/r4/Patient/${c.body.id}`);
    await request(t.app).get('/r4/Patient/nope');
    await t.ep.flushAudits();
    const a = await request(t.app).get('/r4/AuditEvent?_count=50');
    expect(a.body.total).toBe(3);
    const subtypes = a.body.entry.map(e => e.resource.subtype[0].code).sort();
    expect(subtypes).toEqual(['create', 'read', 'read']);
    expect(a.body.entry.some(e => e.resource.outcome === '4')).toBe(true);
  });

  test('the subscription queue gets every write', async () => {
    const c = await post('/r4/Patient', patient());
    await put(`/r4/Patient/${c.body.id}`, patient({ id: c.body.id }));
    await request(t.app).delete(`/r4/Patient/${c.body.id}`);
    const rows = await t.ep.db.read(q => q.all('SELECT Operation, PreviousVersionKey FROM SubscriptionQueue ORDER BY QueueKey'));
    expect(rows.map(r => Number(r.Operation))).toEqual([1, 2, 3]);
    expect(rows[0].PreviousVersionKey).toBeNull();
    expect(rows[1].PreviousVersionKey).not.toBeNull();
  });
});
