//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Transactions, rule by rule (FHIR http.html, "transaction"), on both engines. Every test
 * that expects a failure also checks that the database is exactly as it was (every table's
 * row count) and still consistent (helpers.invariants); every success is checked for
 * consistency too.
 */

const request = require('supertest');
const { engines, makeApp, body, snapshot, invariants, FHIR_JSON } = require('./helpers');

let seq = 0;
const u = (p = 'x') => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;
const urn = () => `urn:uuid:${require('crypto').randomUUID()}`;

describe.each(engines())('transaction rules (%s)', (engine) => {
  let t;
  beforeAll(async () => {
    t = await makeApp(engine);
  });
  afterAll(async () => {
    await t.close();
  });

  const tx = (entry, headers = {}) => request(t.app).post('/r4').set({ 'Content-Type': FHIR_JSON, ...headers })
    .send(body({ resourceType: 'Bundle', type: 'transaction', entry }));
  const create = async (resource) => {
    const r = await request(t.app).post(`/r4/${resource.resourceType}`).set('Content-Type', FHIR_JSON).send(body(resource));
    expect(r.status).toBe(201);
    return r.body;
  };
  const read = async (ref) => (await request(t.app).get(`/r4/${ref}`)).body;
  const status = async (ref) => (await request(t.app).get(`/r4/${ref}`)).status;
  const search = async (q) => (await request(t.app).get(`/r4/${q}`)).body;
  const ok = async (entry, headers) => {
    const r = await tx(entry, headers);
    if (r.status !== 200) {
      throw new Error(`transaction failed: ${r.status} ${JSON.stringify(r.body)}`);
    }
    expect(await invariants(t.ep)).toEqual([]);
    return r.body;
  };
  /** A transaction that must fail with status, leaving everything as it was */
  const fails = async (entry, status, message) => {
    const before = await snapshot(t.ep);
    const r = await tx(entry);
    expect({ status: r.status, body: r.body }).toMatchObject({ status, body: { resourceType: 'OperationOutcome' } });
    if (message) {
      expect(r.body.issue[0].diagnostics).toMatch(message);
    }
    expect(await snapshot(t.ep)).toEqual(before);
    expect(await invariants(t.ep)).toEqual([]);
    return r.body;
  };
  const loc = (e) => e.response.location.split('/_history/')[0];
  const patient = (family, extra = {}) => ({ resourceType: 'Patient', name: [{ family }], ...extra });
  const obs = (subject, extra = {}) => ({ resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: subject }, ...extra });
  const POST = (resource, fullUrl, extra = {}) => ({ ...(fullUrl ? { fullUrl } : {}), resource, request: { method: 'POST', url: resource.resourceType, ...extra } });
  const PUT = (resource, url, fullUrl, extra = {}) => ({ ...(fullUrl ? { fullUrl } : {}), resource, request: { method: 'PUT', url: url || `${resource.resourceType}/${resource.id}`, ...extra } });
  const DELETE = (url) => ({ request: { method: 'DELETE', url } });
  const GET = (url) => ({ request: { method: 'GET', url } });
  const PATCH = (url, ops, extra = {}) => ({ resource: { resourceType: 'Binary', contentType: 'application/json-patch+json', data: Buffer.from(JSON.stringify(ops)).toString('base64') }, request: { method: 'PATCH', url, ...extra } });

  describe('outcome and response', () => {
    test('an empty transaction is not an error', async () => {
      const b = await ok([]);
      expect(b.type).toBe('transaction-response');
      expect(b.entry).toEqual([]);
      const r = await request(t.app).post('/r4').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Bundle', type: 'transaction' }));
      expect(r.status).toBe(200);
    });

    test('one response entry per request entry, in the request\'s order, whatever order they ran in', async () => {
      const old = await create(patient(u('old')));
      const f = u('ord');
      const b = await ok([
        GET(`Patient?family=${f}`),
        PUT(patient(f, { id: u('p') })),
        POST(patient(f)),
        DELETE(`Patient/${old.id}`)
      ]);
      expect(b.entry.map(e => e.response.status)).toEqual(['200 OK', '201 Created', '201 Created', '200 OK']);
      // the GET ran last: it sees both writes
      expect(b.entry[0].resource.total).toBe(2);
      expect(b.entry[1].response.location).toMatch(/^Patient\/[^/]+\/_history\/1$/);
      expect(b.entry[1].response.etag).toBe('W/"1"');
      expect(b.entry[2].response.lastModified).toBeDefined();
      expect(await status(`Patient/${old.id}`)).toBe(410);
    });

    test('deletes run before creates: a create can\'t see what is deleted', async () => {
      const f = u('dc');
      const old = await create(patient(f));
      const b = await ok([GET(`Patient?family=${f}`), POST(patient(f)), DELETE(`Patient/${old.id}`)]);
      expect(b.entry[0].resource.total).toBe(1);
      expect(b.entry[0].resource.entry[0].resource.id).not.toBe(old.id);
    });

    test('Prefer: return=minimal leaves out the resources; representation includes them', async () => {
      const m = await ok([POST(patient(u()))], { Prefer: 'return=minimal' });
      expect(m.entry[0].resource).toBeUndefined();
      expect(m.entry[0].response.location).toBeDefined();
      const r = await ok([POST(patient(u()))], { Prefer: 'return=representation' });
      expect(r.entry[0].resource.resourceType).toBe('Patient');
      expect(r.entry[0].resource.meta.versionId).toBe('1');
      expect(r.entry[0].fullUrl).toMatch(/\/r4\/Patient\//);
    });

    test('a failure returns an OperationOutcome naming the entry, and nothing is written', async () => {
      const b = await fails([POST(patient(u())), POST(patient(u())), PUT(patient(u(), { id: 'a' }), 'Patient/b')], 400, /Entry 2/);
      expect(b.issue[0].diagnostics).toMatch(/Patient\/b|id/);
    });

    test('the results don\'t depend on the order of the entries', async () => {
      const run = async (order) => {
        const tag = u('o');
        const pu = urn();
        const entries = [
          POST(patient(tag), pu),
          POST(obs(pu, { code: { text: tag } })),
          POST({ resourceType: 'Encounter', status: 'finished', class: { code: 'AMB' }, subject: { reference: pu } }),
          PUT(patient(tag, { id: tag }))
        ];
        const b = await ok(order.map(i => entries[i]));
        const p = loc(b.entry[order.indexOf(0)]);
        const o = await search(`Observation?code:text=${tag}&_include=Observation:subject`);
        return { total: o.total, subjectIsPatient: o.entry[0].resource.subject.reference === p, statuses: order.map((_, i) => b.entry[order.indexOf(i)].response.status) };
      };
      const a = await run([0, 1, 2, 3]);
      const b = await run([3, 2, 1, 0]);
      const c = await run([1, 3, 0, 2]);
      expect(a).toEqual(b);
      expect(a).toEqual(c);
      expect(a.subjectIsPatient).toBe(true);
    });
  });

  describe('references inside the Bundle', () => {
    test('a urn:uuid fullUrl: references to it become the new resource, before or after it', async () => {
      const pu = urn();
      const b = await ok([POST(obs(pu)), POST(patient(u()), pu), POST(obs(pu))]);
      const pid = loc(b.entry[1]);
      for (const i of [0, 2]) {
        expect((await read(loc(b.entry[i]))).subject.reference).toBe(pid);
      }
      // indexed as the local reference: searches and chains find it
      expect((await search(`Observation?subject=${pid}`)).total).toBe(2);
      const fam = (await read(pid)).name[0].family;
      expect((await search(`Observation?subject.family=${fam}`)).total).toBe(2);
    });

    test('circular references between new resources', async () => {
      const a = urn();
      const c = urn();
      const b = await ok([
        POST({ resourceType: 'Patient', link: [{ type: 'seealso', other: { reference: c } }] }, a),
        POST({ resourceType: 'Patient', link: [{ type: 'seealso', other: { reference: a } }] }, c)
      ]);
      const pa = await read(loc(b.entry[0]));
      const pc = await read(loc(b.entry[1]));
      expect(pa.link[0].other.reference).toBe(`Patient/${pc.id}`);
      expect(pc.link[0].other.reference).toBe(`Patient/${pa.id}`);
    });

    test('references anywhere: nested, in arrays, in extensions, in contained resources, and uris', async () => {
      const pu = urn();
      const b = await ok([
        POST(patient(u()), pu),
        POST({ resourceType: 'List', status: 'current', mode: 'working', entry: [{ item: { reference: pu, display: 'x' } }],
          extension: [{ url: 'http://example.org/ext', valueReference: { reference: pu } }, { url: 'http://example.org/uri', valueUri: pu }],
          contained: [{ resourceType: 'Observation', id: 'c1', status: 'final', code: { text: 'x' }, subject: { reference: pu } }],
          note: [{ text: `about ${pu}` }] })
      ]);
      const pid = loc(b.entry[0]);
      const l = await read(loc(b.entry[1]));
      expect(l.entry[0].item.reference).toBe(pid);
      expect(l.extension[0].valueReference.reference).toBe(pid);
      expect(l.extension[1].valueUri).toBe(pid);
      expect(l.contained[0].subject.reference).toBe(pid);
      // a string that only contains the fullUrl is left alone
      expect(l.note[0].text).toBe(`about ${pu}`);
      expect((await search(`List?item=${pid}`)).total).toBe(1);
    });

    test('narrative: <a href> and <img src> are rewritten, and nothing else', async () => {
      const pu = urn();
      const div = `<div xmlns="http://www.w3.org/1999/xhtml"><p>See <a href="${pu}">the patient</a>, <a href="${pu}#n">a part</a> ` +
        `<img src="${pu}" alt="${pu}"/> and the text ${pu}, <span title="${pu}">here</span></p></div>`;
      const b = await ok([POST(patient(u()), pu), POST(obs(pu, { text: { status: 'generated', div } }))]);
      const pid = loc(b.entry[0]);
      const d = (await read(loc(b.entry[1]))).text.div;
      expect(d).toContain(`<a href="${pid}">`);
      expect(d).toContain(`<a href="${pid}#n">`);
      expect(d).toContain(`<img src="${pid}" alt="${pu}"/>`);
      expect(d).toContain(`the text ${pu},`);
      expect(d).toContain(`<span title="${pu}">`);
    });

    test('a urn:uuid reference to nothing in the Bundle fails', async () => {
      await fails([POST(patient(u())), POST(obs(urn()))], 400, /not the fullUrl/);
      await fails([POST(obs('urn:oid:1.2.3.4'))], 400, /not the fullUrl/);
    });

    test('an absolute fullUrl on a POST: references to it become the new resource', async () => {
      const fu = `http://elsewhere.org/fhir/Patient/${u()}`;
      const b = await ok([POST(patient(u()), fu), POST(obs(fu))]);
      expect((await read(loc(b.entry[1]))).subject.reference).toBe(loc(b.entry[0]));
    });

    test('a PUT\'s fullUrl, absolute or urn:uuid: references to it become the resource', async () => {
      const id1 = u('a');
      const id2 = u('b');
      const fu1 = `http://elsewhere.org/fhir/Patient/${id1}`;
      const fu2 = urn();
      const b = await ok([PUT(patient(u(), { id: id1 }), null, fu1), PUT(patient(u(), { id: id2 }), null, fu2), POST(obs(fu1)), POST(obs(fu2))]);
      expect((await read(loc(b.entry[2]))).subject.reference).toBe(`Patient/${id1}`);
      expect((await read(loc(b.entry[3]))).subject.reference).toBe(`Patient/${id2}`);
    });

    test('references to this server\'s own address are local', async () => {
      const id = u('own');
      const b = await ok([PUT(patient(u(), { id })), POST(obs(`http://test.example/r4/Patient/${id}`))]);
      expect((await search(`Observation?subject=Patient/${id}`)).total).toBe(1);
      expect(b.entry[1].response.status).toBe('201 Created');
    });

    test('references to resources outside the Bundle are left as they are, and must exist', async () => {
      const p = await create(patient(u()));
      const b = await ok([POST(obs(`Patient/${p.id}`))]);
      expect((await read(loc(b.entry[0]))).subject.reference).toBe(`Patient/${p.id}`);
      await fails([POST(patient(u())), POST(obs('Patient/does-not-exist'))], 422, /Patient\/does-not-exist/);
    });

    test('a reference to something the transaction deletes fails', async () => {
      const p = await create(patient(u()));
      await fails([DELETE(`Patient/${p.id}`), POST(obs(`Patient/${p.id}`))], 422);
      expect(await status(`Patient/${p.id}`)).toBe(200);
    });

    test('a reference to something a PUT in the transaction creates', async () => {
      const id = u('new');
      await ok([POST(obs(`Patient/${id}`)), PUT(patient(u(), { id }))]);
      expect((await search(`Observation?subject=Patient/${id}`)).total).toBe(1);
    });

    test('conditional references: exactly one match', async () => {
      const ident = u('mrn');
      const p = await create(patient(u(), { identifier: [{ system: 'urn:mrn', value: ident }] }));
      const cref = `Patient?identifier=urn:mrn|${ident}`;
      const b = await ok([POST(obs(cref)), POST(obs(cref))]);
      expect((await read(loc(b.entry[0]))).subject.reference).toBe(`Patient/${p.id}`);
      expect((await read(loc(b.entry[1]))).subject.reference).toBe(`Patient/${p.id}`);
      await fails([POST(obs(`Patient?identifier=urn:mrn|${u('none')}`))], 412, /matches nothing/);
      const two = u('two');
      await create(patient(u(), { identifier: [{ system: 'urn:mrn', value: two }] }));
      await create(patient(u(), { identifier: [{ system: 'urn:mrn', value: two }] }));
      await fails([POST(obs(`Patient?identifier=urn:mrn|${two}`))], 412, /more than one/);
      await fails([POST(obs('Patient?nonsense=1'))], 400);
    });

    test('version-specific references: to a version that exists, or not', async () => {
      const p = await create(patient(u()));
      await ok([POST(obs(`Patient/${p.id}/_history/1`))]);
      await fails([POST(obs(`Patient/${p.id}/_history/2`))], 422, /_history\/2/);
    });

    test('resolve-as-version-specific: the version the transaction writes', async () => {
      const ext = [{ url: 'http://hl7.org/fhir/StructureDefinition/resolve-as-version-specific', valueBoolean: true }];
      const pu = urn();
      const existing = await create(patient(u()));
      const b = await ok([
        POST(patient(u()), pu),
        POST(obs(pu, { subject: { reference: pu, extension: ext }, focus: [{ reference: `Patient/${existing.id}`, extension: ext }] })),
        PUT(patient(u(), { id: existing.id }))
      ]);
      const o = await read(loc(b.entry[1]));
      expect(o.subject.reference).toBe(`${loc(b.entry[0])}/_history/1`);
      expect(o.subject.extension).toBeUndefined();
      // the PUT made version 2 of the existing patient
      expect(o.focus[0].reference).toBe(`Patient/${existing.id}/_history/2`);
      const other = await create(patient(u()));
      await fails([POST(obs(`Patient/${other.id}`, { subject: { reference: `Patient/${other.id}`, extension: ext } }))], 400, /no entry/);
    });
  });

  describe('conditional interactions', () => {
    test('conditional create: a match is used, and references to its fullUrl point at it', async () => {
      const ident = u('cc');
      const p = await create(patient(u(), { identifier: [{ system: 'urn:cc', value: ident }] }));
      const pu = urn();
      const b = await ok([POST(patient(u(), { identifier: [{ system: 'urn:cc', value: ident }] }), pu, { ifNoneExist: `identifier=urn:cc|${ident}` }), POST(obs(pu))]);
      expect(b.entry[0].response.status).toBe('200 OK');
      expect(loc(b.entry[0])).toBe(`Patient/${p.id}`);
      expect((await read(loc(b.entry[1]))).subject.reference).toBe(`Patient/${p.id}`);
      expect((await search(`Patient?identifier=urn:cc|${ident}`)).total).toBe(1);
    });

    test('conditional create: no match creates; more than one fails; the same criteria twice fails', async () => {
      const ident = u('cc');
      const b = await ok([POST(patient(u(), { identifier: [{ system: 'urn:cc', value: ident }] }), null, { ifNoneExist: `identifier=urn:cc|${ident}` })]);
      expect(b.entry[0].response.status).toBe('201 Created');
      await create(patient(u(), { identifier: [{ system: 'urn:cc', value: ident }] }));
      await fails([POST(patient(u()), null, { ifNoneExist: `identifier=urn:cc|${ident}` })], 412);
      const n = u('dup');
      await fails([POST(patient(u()), null, { ifNoneExist: `identifier=urn:cc|${n}` }), POST(patient(u()), null, { ifNoneExist: `identifier=urn:cc|${n}` })], 400, /same criteria/);
    });

    test('conditional update: a match, no match (with and without an id), more than one, the wrong id', async () => {
      const ident = u('cu');
      const p = await create(patient(u(), { identifier: [{ system: 'urn:cu', value: ident }] }));
      const b = await ok([PUT(patient('Updated', { identifier: [{ system: 'urn:cu', value: ident }] }), `Patient?identifier=urn:cu|${ident}`)]);
      expect(loc(b.entry[0])).toBe(`Patient/${p.id}`);
      expect((await read(`Patient/${p.id}`)).name[0].family).toBe('Updated');
      const n = u('cn');
      const c = await ok([PUT(patient(u(), { identifier: [{ system: 'urn:cu', value: n }] }), `Patient?identifier=urn:cu|${n}`)]);
      expect(c.entry[0].response.status).toBe('201 Created');
      const id = u('given');
      const d = await ok([PUT(patient(u(), { id, identifier: [{ system: 'urn:cu', value: u() }] }), `Patient?identifier=urn:cu|${u('none')}`)]);
      expect(loc(d.entry[0])).toBe(`Patient/${id}`);
      await create(patient(u(), { identifier: [{ system: 'urn:cu', value: ident }] }));
      await fails([PUT(patient(u()), `Patient?identifier=urn:cu|${ident}`)], 412);
      const one = u('one');
      await create(patient(u(), { identifier: [{ system: 'urn:cu', value: one }] }));
      await fails([PUT(patient(u(), { id: 'wrong-id' }), `Patient?identifier=urn:cu|${one}`)], 400, /id/);
    });

    test('conditional delete: one, none, more than one', async () => {
      const ident = u('cd');
      const p = await create(patient(u(), { identifier: [{ system: 'urn:cd', value: ident }] }));
      await ok([DELETE(`Patient?identifier=urn:cd|${ident}`)]);
      expect(await status(`Patient/${p.id}`)).toBe(410);
      await ok([DELETE(`Patient?identifier=urn:cd|${u('none')}`)]);
      const two = u('two');
      await create(patient(u(), { identifier: [{ system: 'urn:cd', value: two }] }));
      await create(patient(u(), { identifier: [{ system: 'urn:cd', value: two }] }));
      await fails([DELETE(`Patient?identifier=urn:cd|${two}`)], 412);
    });

    test('conditional patch: one, none, more than one', async () => {
      const ident = u('cp');
      const p = await create(patient(u(), { identifier: [{ system: 'urn:cp', value: ident }] }));
      await ok([PATCH(`Patient?identifier=urn:cp|${ident}`, [{ op: 'add', path: '/active', value: true }])]);
      expect((await read(`Patient/${p.id}`)).active).toBe(true);
      await fails([PATCH(`Patient?identifier=urn:cp|${u('none')}`, [{ op: 'add', path: '/active', value: true }])], 404);
      const two = u('two');
      await create(patient(u(), { identifier: [{ system: 'urn:cp', value: two }] }));
      await create(patient(u(), { identifier: [{ system: 'urn:cp', value: two }] }));
      await fails([PATCH(`Patient?identifier=urn:cp|${two}`, [{ op: 'add', path: '/active', value: true }])], 412);
    });
  });

  describe('a resource is changed by one entry only', () => {
    let x;
    beforeEach(async () => {
      x = await create(patient(u(), { identifier: [{ system: 'urn:ov', value: u('ov') }] }));
    });
    const crit = () => `Patient?identifier=urn:ov|${x.identifier[0].value}`;
    const pt = () => patient(u(), { id: x.id, identifier: x.identifier });

    test('DELETE and PUT', () => fails([DELETE(`Patient/${x.id}`), PUT(pt())], 400, /both change Patient\//));
    test('PUT twice', () => fails([PUT(pt()), PUT(pt())], 400, /both change/));
    test('PATCH and PUT', () => fails([PATCH(`Patient/${x.id}`, [{ op: 'add', path: '/active', value: true }]), PUT(pt())], 400, /both change/));
    test('DELETE twice', () => fails([DELETE(`Patient/${x.id}`), DELETE(`Patient/${x.id}`)], 400, /both change/));
    test('a conditional update that resolves to a PUT\'s resource', () => fails([PUT(pt(), crit()), PUT(pt())], 400, /both change/));
    test('a conditional delete that resolves to a PATCH\'s resource', () => fails([DELETE(crit()), PATCH(`Patient/${x.id}`, [{ op: 'add', path: '/active', value: true }])], 400, /both change/));
    test('a conditional patch and a DELETE', () => fails([PATCH(crit(), [{ op: 'add', path: '/active', value: true }]), DELETE(`Patient/${x.id}`)], 400, /both change/));
    test('the same fullUrl twice', async () => {
      const f = urn();
      await fails([POST(patient(u()), f), POST(patient(u()), f)], 400, /fullUrl/);
    });
    test('reading it as well is fine', async () => {
      const b = await ok([GET(`Patient/${x.id}`), PUT(pt())]);
      expect(b.entry[0].resource.meta.versionId).toBe('2');
    });
    test('a conditional create that finds it, and a PUT of it, is fine', async () => {
      await ok([POST(patient(u()), null, { ifNoneExist: crit().split('?')[1] }), PUT(pt())]);
    });
  });

  describe('failures roll everything back', () => {
    test.each([
      ['an unknown type', () => [POST(patient(u())), { resource: { resourceType: 'Nonsense' }, request: { method: 'POST', url: 'Nonsense' } }], 404],
      ['a resource that isn\'t the URL\'s type', () => [POST(patient(u())), { resource: patient(u()), request: { method: 'POST', url: 'Observation' } }], 400],
      ['a PUT whose id isn\'t the URL\'s', () => [POST(patient(u())), PUT(patient(u(), { id: 'a1' }), 'Patient/b1')], 400],
      ['a POST with no resource', () => [POST(patient(u())), { request: { method: 'POST', url: 'Patient' } }], 400],
      ['an entry with no request', () => [POST(patient(u())), { resource: patient(u()) }], 400],
      ['a method that isn\'t one', () => [POST(patient(u())), { resource: patient(u()), request: { method: 'FETCH', url: 'Patient' } }], 405],
      ['a nested transaction', () => [POST(patient(u())), { resource: { resourceType: 'Bundle', type: 'transaction' }, request: { method: 'POST', url: '' } }], 400],
      ['an operation', () => [POST(patient(u())), { resource: { resourceType: 'Parameters' }, request: { method: 'POST', url: 'Patient/$meta' } }], 400],
      ['a GET that finds nothing', () => [POST(patient(u())), GET('Patient/no-such-patient')], 404],
      ['a bad search in a GET', () => [POST(patient(u())), GET('Patient?birthdate=notadate')], 400],
      ['an invalid id', () => [POST(patient(u())), PUT(patient(u(), { id: 'bad id!' }), 'Patient/bad id!')], 400],
      ['a patch that fails its test', () => [POST(patient(u())), PATCH('Patient/{existing}', [{ op: 'test', path: '/gender', value: 'other' }])], 422],
      ['a patch that isn\'t a JSON Patch', () => [POST(patient(u())), { resource: { resourceType: 'Binary', data: Buffer.from('nonsense').toString('base64') }, request: { method: 'PATCH', url: 'Patient/{existing}' } }], 400],
      ['an If-Match that is stale', () => [POST(patient(u())), PUT(patient(u(), { id: '{existing}' }), null, null, { ifMatch: 'W/"7"' })], 412],
      ['the last of many entries', () => [...Array.from({ length: 20 }, () => POST(patient(u()))), POST(obs('Patient/nobody'))], 422]
    ])('%s', async (name, make, expected) => {
      const existing = await create(patient(u(), { gender: 'male' }));
      const entries = JSON.parse(JSON.stringify(make()).split('{existing}').join(existing.id));
      await fails(entries, expected);
    });

    test('a failure partway leaves no reservation, version, index row, AuditEvent or queue row', async () => {
      await t.close();
      t = await makeApp(engine, { settings: { audit: 'writes' } });
      const pu = urn();
      await fails([POST(patient(u()), pu), POST(obs(pu)), PUT(patient(u(), { id: u('n') })), POST(obs('Patient/nobody'))], 422);
      await t.close();
      t = await makeApp(engine);
    });
  });

  describe('everything else an entry can do', () => {
    test('If-Match on an entry', async () => {
      const p = await create(patient(u()));
      const b = await ok([PUT(patient(u(), { id: p.id }), null, null, { ifMatch: 'W/"1"' })]);
      expect(b.entry[0].response.etag).toBe('W/"2"');
    });

    test('a PATCH in a Binary', async () => {
      const p = await create(patient(u()));
      const b = await ok([PATCH(`Patient/${p.id}`, [{ op: 'add', path: '/gender', value: 'female' }])]);
      expect(b.entry[0].response.status).toBe('200 OK');
      expect((await read(`Patient/${p.id}`)).gender).toBe('female');
    });

    test('deleting something that isn\'t there is fine', async () => {
      const b = await ok([DELETE(`Patient/${u('never')}`)]);
      expect(b.entry[0].response.status).toBe('200 OK');
    });

    test('a POST\'s id is the server\'s, whatever the resource says', async () => {
      const b = await ok([POST(patient(u(), { id: 'client-id' }))]);
      expect(loc(b.entry[0])).not.toBe('Patient/client-id');
    });

    test('versions and history', async () => {
      const p = await create(patient(u()));
      await ok([PUT(patient(u(), { id: p.id }))]);
      await ok([PATCH(`Patient/${p.id}`, [{ op: 'add', path: '/active', value: true }])]);
      await ok([DELETE(`Patient/${p.id}`)]);
      await ok([PUT(patient(u(), { id: p.id }))]);
      const h = await search(`Patient/${p.id}/_history`);
      expect(h.total).toBe(5);
      expect(h.entry.map(e => e.request.method)).toEqual(['POST', 'DELETE', 'PUT', 'PUT', 'POST']);
    });

    test('URLs in requests can be absolute, at this server', async () => {
      const id = u('abs');
      const b = await ok([PUT(patient(u(), { id }), `http://test.example/r4/Patient/${id}`)]);
      expect(loc(b.entry[0])).toBe(`Patient/${id}`);
    });

    test('a large transaction: 300 entries referring to each other', async () => {
      const entries = [];
      for (let i = 0; i < 100; i++) {
        const pu = urn();
        entries.push(POST(patient(u('big')), pu), POST(obs(pu)), POST(obs(pu)));
      }
      const b = await ok(entries);
      expect(b.entry.length).toBe(300);
      const pid = loc(b.entry[297]);
      expect((await search(`Observation?subject=${pid}`)).total).toBe(2);
    });
  });

  describe('limits and access', () => {
    test('the size limit', async () => {
      await t.close();
      t = await makeApp(engine, { settings: { transactionMaxEntries: 3 } });
      await ok([POST(patient(u())), POST(patient(u())), POST(patient(u()))]);
      await fails([POST(patient(u())), POST(patient(u())), POST(patient(u())), POST(patient(u()))], 400, /limited to 3/);
      await t.close();
      t = await makeApp(engine);
    });

    test('an entry the user may not do fails the transaction', async () => {
      await t.close();
      const reader = { id: 2, login: 'reader', has: (m, role) => role === 'read' };
      t = await makeApp(engine, { principal: async () => reader });
      // reads only: fine
      expect((await tx([GET('Patient?_count=1')])).status).toBe(200);
      const before = await snapshot(t.ep);
      expect((await tx([POST(patient(u()))])).status).toBe(403);
      expect(await snapshot(t.ep)).toEqual(before);
      await t.close();
      t = await makeApp(engine);
    });

    test('a version-aware type needs If-Match in a transaction too', async () => {
      await t.close();
      t = await makeApp(engine, { types: { Group: { versionAware: true } } });
      const g = await create({ resourceType: 'Group', type: 'person', actual: true });
      await fails([PUT({ resourceType: 'Group', id: g.id, type: 'person', actual: false })], 412);
      await ok([PUT({ resourceType: 'Group', id: g.id, type: 'person', actual: false }, null, null, { ifMatch: 'W/"1"' })]);
      await t.close();
      t = await makeApp(engine);
    });
  });

  describe('retries and concurrency', () => {
    test('a transaction run again after a busy or deadlock error does everything once', async () => {
      const store = t.ep.store;
      const original = store.writeVersion.bind(store);
      let calls = 0;
      store.writeVersion = async (q, w) => {
        calls++;
        if (calls === 3) {
          const e = new Error('simulated deadlock');
          e.retryable = true;
          throw e;
        }
        return original(q, w);
      };
      try {
        const tag = u('retry');
        const pu = urn();
        const b = await ok([POST(patient(tag), pu), POST(obs(pu)), POST(obs(pu)), PUT(patient(tag, { id: tag }))]);
        expect(calls).toBeGreaterThan(4);
        expect((await search(`Patient?family=${tag}`)).total).toBe(2);
        expect((await search(`Observation?subject=${loc(b.entry[0])}`)).total).toBe(2);
      } finally {
        store.writeVersion = original;
      }
    });

    test('concurrent transactions with the same conditional create make one resource', async () => {
      const ident = u('race');
      const results = await Promise.all(Array.from({ length: 5 }, () => tx([
        POST(patient(u(), { identifier: [{ system: 'urn:race', value: ident }] }), null, { ifNoneExist: `identifier=urn:race|${ident}` })
      ])));
      expect(results.map(r => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(results.filter(r => r.body.entry[0].response.status === '201 Created').length).toBe(1);
      expect((await search(`Patient?identifier=urn:race|${ident}`)).total).toBe(1);
      expect(await invariants(t.ep)).toEqual([]);
    });

    test('concurrent transactions changing the same resources in opposite orders all succeed', async () => {
      const a = await create(patient(u()));
      const b = await create(patient(u()));
      const runs = 8;
      const results = await Promise.all(Array.from({ length: runs }, (_, i) => tx(i % 2
        ? [PUT(patient(`r${i}`, { id: a.id })), PUT(patient(`r${i}`, { id: b.id }))]
        : [PUT(patient(`r${i}`, { id: b.id })), PUT(patient(`r${i}`, { id: a.id }))])));
      expect(results.map(r => r.status)).toEqual(Array(runs).fill(200));
      // both resources got every version, and the last transaction wrote both
      const ha = await search(`Patient/${a.id}/_history?_count=50`);
      const hb = await search(`Patient/${b.id}/_history?_count=50`);
      expect(ha.total).toBe(runs + 1);
      expect(hb.total).toBe(runs + 1);
      expect((await read(`Patient/${a.id}`)).name[0].family).toBe((await read(`Patient/${b.id}`)).name[0].family);
      expect(await invariants(t.ep)).toEqual([]);
    });

    test('a transaction racing ordinary updates of the same resource', async () => {
      const p = await create(patient(u()));
      const work = [];
      for (let i = 0; i < 6; i++) {
        work.push(tx([PUT(patient(`t${i}`, { id: p.id })), POST(obs(`Patient/${p.id}`))]));
        work.push(request(t.app).put(`/r4/Patient/${p.id}`).set('Content-Type', FHIR_JSON).send(body(patient(`u${i}`, { id: p.id }))));
      }
      const results = await Promise.all(work);
      expect(results.every(r => r.status === 200)).toBe(true);
      expect((await search(`Patient/${p.id}/_history?_count=50`)).total).toBe(13);
      expect(await invariants(t.ep)).toEqual([]);
    });
  });

  describe('a storm', () => {
    test('20 transactions at once, each making linked resources, updating a shared one, and racing a conditional create', async () => {
      const shared = await create(patient(u('shared')));
      const ident = u('storm');
      const tags = [];
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => {
        const tag = u(`s${i}`);
        tags.push(tag);
        const pu = urn();
        const cu = urn();
        return tx([
          POST(patient(tag), pu),
          POST(obs(pu, { code: { text: tag } })),
          POST(obs(`Patient/${shared.id}`, { code: { text: tag } })),
          POST(patient(u(), { identifier: [{ system: 'urn:storm', value: ident }] }), cu, { ifNoneExist: `identifier=urn:storm|${ident}` }),
          POST(obs(cu, { code: { text: tag } })),
          PUT(patient(tag, { id: shared.id })),
          GET(`Patient?family=${tag}`)
        ]);
      }));
      expect(results.map(r => r.status)).toEqual(Array(20).fill(200));
      for (const r of results) {
        // each transaction's read saw its own writes: the new patient, and the shared one it renamed
        expect(r.body.entry[6].resource.total).toBe(2);
      }
      expect((await search(`Patient?identifier=urn:storm|${ident}`)).total).toBe(1);
      const theOne = (await search(`Patient?identifier=urn:storm|${ident}`)).entry[0].resource.id;
      expect((await search(`Observation?subject=Patient/${theOne}&_summary=count`)).total).toBe(20);
      expect((await search(`Observation?subject=Patient/${shared.id}&_summary=count`)).total).toBe(20);
      expect((await search(`Patient/${shared.id}/_history?_count=50`)).total).toBe(21);
      for (const tag of tags) {
        expect((await search(`Observation?code:text=${tag}&_summary=count`)).total).toBe(3);
      }
      expect(await invariants(t.ep)).toEqual([]);
    });
  });

  describe('batches', () => {
    test('an entry can\'t refer to another by its fullUrl', async () => {
      const pu = urn();
      const r = await request(t.app).post('/r4').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Bundle', type: 'batch', entry: [
        POST(patient(u()), pu), POST(obs(pu))
      ] }));
      expect(r.status).toBe(200);
      expect(r.body.entry.map(e => e.response.status.split(' ')[0])).toEqual(['201', '400']);
      expect(await invariants(t.ep)).toEqual([]);
    });
  });
});
