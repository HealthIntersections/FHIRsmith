//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// :below and :above on references: hierarchies (Organization.partOf, Encounter.partOf), and
// canonical versions.

const request = require('supertest');
const { engines, makeApp, body, invariants, FHIR_JSON } = require('./helpers');

describe.each(engines())(':below and :above on references (%s)', (engine) => {
  let t;
  const ids = {};

  const send = async (method, url, resource) => {
    const r = await request(t.app)[method](url).set('Content-Type', FHIR_JSON).send(body(resource));
    expect(r.status).toBeLessThan(300);
    return r.body.id;
  };
  const post = (resource) => send('post', `/r4/${resource.resourceType}`, resource);
  const org = (name, parent) => ({ resourceType: 'Organization', name, ...(parent ? { partOf: { reference: `Organization/${ids[parent]}` } } : {}) });
  const found = async (url, status = 200) => {
    const r = await request(t.app).get(url);
    expect(r.status).toBe(status);
    return status === 200 ? r.body.entry.filter(e => e.search.mode === 'match').map(e => e.resource.id).sort() : r.body;
  };
  const of = (...names) => names.map(n => ids[n]).sort();

  beforeAll(async () => {
    t = await makeApp(engine);
    // A > B > C; D on its own; E and F part of each other
    ids.A = await post(org('A'));
    ids.B = await post(org('B', 'A'));
    ids.C = await post(org('C', 'B'));
    ids.D = await post(org('D'));
    ids.E = await post(org('E'));
    ids.F = await post(org('F', 'E'));
    await send('put', `/r4/Organization/${ids.E}`, { ...org('E', 'F'), id: ids.E });
    for (const o of ['A', 'B', 'C', 'D', 'E']) {
      ids['p' + o] = await post({ resourceType: 'Patient', name: [{ family: o }], managingOrganization: { reference: `Organization/${ids[o]}` } });
    }
    // encounters: e1 > e2 > e3
    ids.e1 = await post({ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' } });
    ids.e2 = await post({ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, partOf: { reference: `Encounter/${ids.e1}` } });
    ids.e3 = await post({ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, partOf: { reference: `Encounter/${ids.e2}` } });
    for (const e of ['e1', 'e2', 'e3']) {
      ids['o' + e] = await post({ resourceType: 'Observation', status: 'final', code: { text: 'x' }, encounter: { reference: `Encounter/${ids[e]}` },
        performer: [{ reference: `Organization/${ids.C}` }] });
    }
  });

  afterAll(async () => {
    await t.close();
  });

  test(':below: the resource named and everything part of it', async () => {
    expect(await found(`/r4/Patient?organization:below=${ids.A}`)).toEqual(of('pA', 'pB', 'pC'));
    expect(await found(`/r4/Patient?organization:below=Organization/${ids.B}`)).toEqual(of('pB', 'pC'));
    expect(await found(`/r4/Patient?organization:below=${ids.C}`)).toEqual(of('pC'));
    expect(await found(`/r4/Patient?organization:below=${ids.D}`)).toEqual(of('pD'));
    // the hierarchy's own parameter: organizations whose parent is in A's tree
    expect(await found(`/r4/Organization?partof:below=${ids.A}`)).toEqual(of('B', 'C'));
  });

  test(':above: the resource named and everything it is part of', async () => {
    expect(await found(`/r4/Patient?organization:above=${ids.C}`)).toEqual(of('pA', 'pB', 'pC'));
    expect(await found(`/r4/Patient?organization:above=${ids.B}`)).toEqual(of('pA', 'pB'));
    expect(await found(`/r4/Patient?organization:above=${ids.A}`)).toEqual(of('pA'));
  });

  test('another hierarchy, and a parameter with several target types', async () => {
    expect(await found(`/r4/Observation?encounter:below=${ids.e1}`)).toEqual(of('oe1', 'oe2', 'oe3'));
    expect(await found(`/r4/Observation?encounter:above=${ids.e2}`)).toEqual(of('oe1', 'oe2'));
    // performer can be many types: the hierarchy is the Organization's
    expect(await found(`/r4/Observation?performer:below=Organization/${ids.A}`)).toEqual(of('oe1', 'oe2', 'oe3'));
    expect(await found(`/r4/Observation?performer:below=Organization/${ids.D}`)).toEqual([]);
    expect(await found('/r4/Observation?_filter=' + encodeURIComponent(`encounter.part-of eq Encounter/${ids.e1}`))).toEqual(of('oe2'));
  });

  test('a cycle ends', async () => {
    expect(await found(`/r4/Patient?organization:below=${ids.E}`)).toEqual(of('pE'));
    expect(await found(`/r4/Patient?organization:above=${ids.F}`)).toEqual(of('pE'));
    expect(await found(`/r4/Organization?partof:below=${ids.E}`)).toEqual(of('E', 'F'));
  });

  test('a target type with no hierarchy is an error', async () => {
    const b = await found('/r4/Patient?general-practitioner:below=Practitioner/x', 400);
    expect(b.issue[0].diagnostics).toMatch(/needs a hierarchy in Practitioner/);
    await found(`/r4/Patient?organization:below=Organization/${ids.A}/_history/1`, 400);
  });

  test('the hierarchy follows changes', async () => {
    // C moves under D
    await send('put', `/r4/Organization/${ids.C}`, { ...org('C', 'D'), id: ids.C });
    expect(await found(`/r4/Patient?organization:below=${ids.A}`)).toEqual(of('pA', 'pB'));
    expect(await found(`/r4/Patient?organization:below=${ids.D}`)).toEqual(of('pC', 'pD'));
    expect(await found(`/r4/Patient?organization:above=${ids.C}`)).toEqual(of('pC', 'pD'));
    // B deleted: what's under it is no longer under A
    await send('put', `/r4/Organization/${ids.C}`, { ...org('C', 'B'), id: ids.C });
    await request(t.app).delete(`/r4/Patient/${ids.pB}`);
    const del = await request(t.app).delete(`/r4/Organization/${ids.B}`);
    expect(del.status).toBeLessThan(300);
    expect(await found(`/r4/Patient?organization:below=${ids.A}`)).toEqual(of('pA'));
    expect(await invariants(t.ep)).toEqual([]);
  });

  test('canonical references: :below and :above are about the version', async () => {
    const URL = 'http://example.org/SearchParameter/base';
    const sp = (name, version) => ({ resourceType: 'SearchParameter', url: `http://example.org/SearchParameter/${name}`, name, status: 'active',
      description: name, code: name, base: ['Patient'], type: 'string', expression: 'Patient.name',
      derivedFrom: version === null ? URL : `${URL}|${version}` });
    ids.v12 = await post(sp('v12', '1.2'));
    ids.v123 = await post(sp('v123', '1.2.3'));
    ids.v13 = await post(sp('v13', '1.3'));
    ids.v20 = await post(sp('v20', '2.0'));
    ids.none = await post(sp('none', null));
    const q = (s) => `/r4/SearchParameter?${s}`;
    const enc = encodeURIComponent;
    expect(await found(q(`derived-from=${enc(URL)}`))).toEqual(of('v12', 'v123', 'v13', 'v20', 'none'));
    expect(await found(q(`derived-from:below=${enc(URL)}`))).toEqual(of('v12', 'v123', 'v13', 'v20', 'none'));
    expect(await found(q(`derived-from=${enc(URL + '|1.2')}`))).toEqual(of('v12'));
    expect(await found(q(`derived-from:below=${enc(URL + '|1.2')}`))).toEqual(of('v12', 'v123'));
    expect(await found(q(`derived-from:below=${enc(URL + '|1')}`))).toEqual(of('v12', 'v123', 'v13'));
    expect(await found(q(`derived-from:above=${enc(URL + '|1.2.3')}`))).toEqual(of('v12', 'v123', 'none'));
    expect(await found(q(`derived-from:above=${enc(URL + '|2.0')}`))).toEqual(of('v20', 'none'));
  });
});
