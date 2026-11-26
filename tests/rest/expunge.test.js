//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// $expunge (rest/operations/expunge.js): versions removed for good, at each level; the database
// left consistent (helpers.invariants), and the manage role needed.

const request = require('supertest');
const { engines, makeApp, invariants, FHIR_JSON } = require('./helpers');

const params = (o) => JSON.stringify({ resourceType: 'Parameters', parameter: Object.entries(o).map(([name, v]) => (typeof v === 'boolean' ? { name, valueBoolean: v } : { name, valueInteger: v })) });

describe.each(engines())('$expunge (%s)', (engine) => {
  let t;
  beforeEach(async () => {
    t = await makeApp(engine);
  });
  afterEach(async () => {
    expect(await invariants(t.ep)).toEqual([]);
    await t.close();
  });

  const put = (type, id, r) => request(t.app).put(`/r4/${type}/${id}`).set('Content-Type', FHIR_JSON).send(JSON.stringify({ ...r, resourceType: type, id }));
  const expunge = (path, o) => {
    const r = request(t.app).post(`/r4/${path ? path + '/' : ''}$expunge`).set('Accept', FHIR_JSON);
    return o ? r.set('Content-Type', FHIR_JSON).send(params(o)) : r.send();
  };
  const count = (res) => res.body.parameter.find(p => p.name === 'count').valueInteger;
  const history = async (type, id) => (await request(t.app).get(`/r4/${type}/${id}/_history`).set('Accept', FHIR_JSON)).body.entry.map(e => e.resource.meta.versionId);

  test('a version: gone; the others, and the current one, stay; the next update carries on numbering', async () => {
    for (const g of ['one', 'two', 'three']) {
      await put('Patient', 'p1', { name: [{ given: [g] }] });
    }
    const r = await expunge('Patient/p1/_history/2');
    expect(r.status).toBe(200);
    expect(count(r)).toBe(1);
    expect(await history('Patient', 'p1')).toEqual(['3', '1']);
    expect((await request(t.app).get('/r4/Patient/p1/_history/2')).status).toBe(404);
    expect((await request(t.app).get('/r4/Patient/p1/_history/1')).status).toBe(200);
    // the current version can't be
    const cur = await expunge('Patient/p1/_history/3');
    expect(cur.status).toBe(409);
    expect((await expunge('Patient/p1/_history/9')).status).toBe(404);
    await put('Patient', 'p1', { name: [{ given: ['four'] }] });
    expect(await history('Patient', 'p1')).toEqual(['4', '3', '1']);
    expect((await request(t.app).get('/r4/Patient/p1')).body.meta.versionId).toBe('4');
  });

  test('a resource: its previous versions; a deleted one, whole, and its id is free', async () => {
    for (const g of ['a', 'b', 'c']) {
      await put('Patient', 'p2', { name: [{ given: [g] }] });
    }
    expect((await expunge('Patient/p2')).status).toBe(400);
    expect(count(await expunge('Patient/p2', { expungePreviousVersions: true }))).toBe(2);
    expect(await history('Patient', 'p2')).toEqual(['3']);
    // not deleted: expungeDeletedResources leaves it
    expect(count(await expunge('Patient/p2', { expungeDeletedResources: true }))).toBe(0);
    await put('Observation', 'o1', { status: 'final', code: { text: 'x' }, subject: { reference: 'Patient/p2' } });
    expect((await request(t.app).delete('/r4/Patient/p2')).status).toBe(200);
    expect(count(await expunge('Patient/p2', { expungeDeletedResources: true }))).toBe(2);
    expect((await request(t.app).get('/r4/Patient/p2')).status).toBe(404);
    expect((await request(t.app).get('/r4/Patient/p2/_history')).status).toBe(404);
    expect((await expunge('Patient/p2', { expungeDeletedResources: true })).status).toBe(404);
    // made again: version 1, and the reference to it is keyed to it again
    expect((await put('Patient', 'p2', { name: [{ given: ['new'] }] })).status).toBe(201);
    expect((await request(t.app).get('/r4/Patient/p2')).body.meta.versionId).toBe('1');
    const s = await request(t.app).get('/r4/Observation?subject:Patient.name=new').set('Accept', FHIR_JSON);
    expect(s.body.total).toBe(1);
  });

  test('a type, and the endpoint: by the rules; limit; expungeEverything', async () => {
    for (const id of ['a', 'b']) {
      await put('Patient', id, { active: true });
      await put('Patient', id, { active: false });
    }
    await put('Organization', 'org', { name: 'x' });
    await put('Organization', 'org', { name: 'y' });
    await request(t.app).delete('/r4/Patient/b');
    // the type: previous versions of a, and b (deleted) whole
    const typeLevel = await expunge('Patient', { expungePreviousVersions: true, expungeDeletedResources: true });
    expect(count(typeLevel)).toBe(1 + 3);
    expect(await history('Organization', 'org')).toEqual(['2', '1']);
    // limit: at most that many
    await put('Organization', 'org', { name: 'z' });
    expect(count(await expunge('', { expungePreviousVersions: true, limit: 1 }))).toBe(1);
    expect(await history('Organization', 'org')).toEqual(['3', '2']);
    expect(count(await expunge('', { expungePreviousVersions: true }))).toBe(1);
    // everything: the endpoint only
    expect((await expunge('Patient', { expungeEverything: true })).status).toBe(400);
    const all = await expunge('', { expungeEverything: true });
    expect(count(all)).toBe(2);
    expect((await request(t.app).get('/r4/Patient').set('Accept', FHIR_JSON)).body.total).toBe(0);
    expect((await request(t.app).get('/r4/Organization/org')).status).toBe(404);
  });

  test('the manage role; POST; known parameters', async () => {
    await put('Patient', 'p3', { active: true });
    const writer = await makeApp(engine, { dir: t.dir, keep: true, master: false, jobs: false,
      principal: async () => ({ id: 7, login: 'writer', has: (m, r) => m === 'rest' && r === 'write' }) });
    try {
      const r = await request(writer.app).post('/r4/Patient/p3/$expunge').set('Content-Type', FHIR_JSON).send(params({ expungePreviousVersions: true }));
      expect(r.status).toBe(403);
    } finally {
      await writer.stop();
    }
    expect((await request(t.app).get('/r4/Patient/p3/$expunge')).status).toBe(405);
    expect((await expunge('Patient/p3', { expungeOdd: true })).status).toBe(400);
    expect((await expunge('Patient/p3', { limit: 0 })).status).toBe(400);
  });
});
