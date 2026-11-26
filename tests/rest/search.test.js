//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const request = require('supertest');
const { engines, makeApp, body, FHIR_JSON } = require('./helpers');

describe.each(engines())('rest search (%s)', (engine) => {
  let t;
  const ids = {};

  const post = async (resource) => {
    const r = await request(t.app).post(`/r4/${resource.resourceType}`).set('Content-Type', FHIR_JSON).send(body(resource));
    if (r.status !== 201) {
      throw new Error(`create failed: ${r.status} ${JSON.stringify(r.body)}`);
    }
    return r.body.id;
  };
  const search = async (url, status = 200) => {
    const r = await request(t.app).get(url);
    if (r.status !== status) {
      throw new Error(`${url}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    return r.body;
  };
  const found = (b) => (b.entry || []).filter(e => e.search.mode === 'match').map(e => e.resource.id).sort();

  beforeAll(async () => {
    t = await makeApp(engine);
    ids.org = await post({ resourceType: 'Organization', name: 'Acme Hospital', identifier: [{ system: 'urn:org', value: 'acme' }] });
    ids.prac = await post({ resourceType: 'Practitioner', name: [{ family: 'Who', given: ['John'] }] });
    ids.p1 = await post({ resourceType: 'Patient', name: [{ family: 'Müller', given: ['Anna'] }], gender: 'female', birthDate: '1980-05-17',
      identifier: [{ system: 'urn:mrn', value: '111', type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] } }],
      managingOrganization: { reference: `Organization/${ids.org}` }, generalPractitioner: [{ reference: `Practitioner/${ids.prac}` }],
      address: [{ city: 'Melbourne', postalCode: '3000' }], telecom: [{ system: 'email', value: 'anna@example.org' }], active: true,
      meta: { tag: [{ system: 'urn:tags', code: 'vip' }], security: [{ system: 'urn:sec', code: 'R' }] } });
    ids.p2 = await post({ resourceType: 'Patient', name: [{ family: 'Mueller', given: ['Bob'] }], gender: 'male', birthDate: '1980',
      identifier: [{ system: 'urn:mrn', value: '222' }], managingOrganization: { reference: `Organization/${ids.org}` }, active: false });
    ids.p3 = await post({ resourceType: 'Patient', name: [{ family: 'Smith', given: ['Carol'] }], gender: 'female', birthDate: '1999-12-31T23:30:00+10:00',
      identifier: [{ system: 'urn:mrn', value: '333' }] });
    const obs = (patient, code, value, unit, when, extra = {}) => ({
      resourceType: 'Observation', status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code, display: 'Thing ' + code }], text: 'Test ' + code },
      subject: { reference: `Patient/${patient}` }, effectiveDateTime: when,
      valueQuantity: { value, system: 'http://unitsofmeasure.org', code: unit, unit }, ...extra
    });
    ids.o1 = await post(obs(ids.p1, '2339-0', 5.4, 'mmol/L', '2020-01-02T10:00:00Z', { performer: [{ reference: `Practitioner/${ids.prac}` }] }));
    ids.o2 = await post(obs(ids.p1, '2339-0', 7.1, 'mmol/L', '2020-03-15'));
    ids.o3 = await post(obs(ids.p2, '8480-6', 120, 'mm[Hg]', '2021-06-01T00:00:00Z'));
    ids.o4 = await post(obs(ids.p3, '29463-7', 72000, 'g', '2021-06-02'));
    ids.bp = await post({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] },
      subject: { reference: `Patient/${ids.p2}` }, effectivePeriod: { start: '2021-01-01', end: '2021-01-31' },
      component: [
        { code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] }, valueQuantity: { value: 140, system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } },
        { code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] }, valueQuantity: { value: 90, system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } }
      ] });
    ids.list = await post({ resourceType: 'List', status: 'current', mode: 'working', entry: [{ item: { reference: `Patient/${ids.p1}` } }, { item: { reference: `Patient/${ids.p3}` } }] });
  });
  afterAll(async () => {
    await t.close();
  });

  test('string: starts with, accents and case, :exact, :contains', async () => {
    expect(found(await search('/r4/Patient?family=mul'))).toEqual([ids.p1]);
    expect(found(await search('/r4/Patient?family=MUELL'))).toEqual([ids.p2]);
    expect(found(await search('/r4/Patient?name=anna'))).toEqual([ids.p1]);
    expect(found(await search('/r4/Patient?family:exact=Müller'))).toEqual([ids.p1]);
    expect(found(await search('/r4/Patient?family:exact=müller'))).toEqual([]);
    expect(found(await search('/r4/Patient?family:contains=ue'))).toEqual([ids.p2]);
    expect(found(await search('/r4/Patient?address-city=melb'))).toEqual([ids.p1]);
    expect(found(await search('/r4/Patient?family=smith,mueller'))).toEqual([ids.p2, ids.p3].sort());
    expect(found(await search('/r4/Patient?family=m&given=bob'))).toEqual([ids.p2]);
    expect(found(await search('/r4/Patient?family:missing=true'))).toEqual([]);
  });

  test('token', async () => {
    expect(found(await search('/r4/Patient?gender=female'))).toEqual([ids.p1, ids.p3].sort());
    expect(found(await search('/r4/Patient?gender=http://hl7.org/fhir/administrative-gender|male'))).toEqual([ids.p2]);
    expect(found(await search('/r4/Patient?identifier=urn:mrn|222'))).toEqual([ids.p2]);
    expect(found(await search('/r4/Patient?identifier=222'))).toEqual([ids.p2]);
    expect(found(await search('/r4/Patient?identifier=urn:other|222'))).toEqual([]);
    expect(found(await search('/r4/Patient?identifier=urn:mrn|'))).toEqual([ids.p1, ids.p2, ids.p3].sort());
    expect(found(await search('/r4/Patient?gender:not=female'))).toEqual([ids.p2]);
    expect(found(await search('/r4/Patient?active=true'))).toEqual([ids.p1]);
    expect(found(await search('/r4/Patient?email=anna@example.org'))).toEqual([ids.p1]);
    expect(found(await search('/r4/Observation?code:text=test 2339'))).toEqual([ids.o1, ids.o2].sort());
    expect(found(await search('/r4/Patient?identifier:of-type=http://terminology.hl7.org/CodeSystem/v2-0203|MR|111'))).toEqual([ids.p1]);
    expect(found(await search('/r4/Observation?code=http://loinc.org|2339-0,http://loinc.org|8480-6'))).toEqual([ids.o1, ids.o2, ids.o3].sort());
  });

  test('date', async () => {
    expect(found(await search('/r4/Patient?birthdate=1980'))).toEqual([ids.p1, ids.p2].sort());
    expect(found(await search('/r4/Patient?birthdate=1980-05'))).toEqual([ids.p1]);
    // 1980 (the whole year) is not within May
    expect(found(await search('/r4/Patient?birthdate=gt1980-05-01'))).toEqual([ids.p1, ids.p2, ids.p3].sort());
    expect(found(await search('/r4/Patient?birthdate=ge1990'))).toEqual([ids.p3]);
    expect(found(await search('/r4/Patient?birthdate=lt1980-01-02'))).toEqual([ids.p2]);
    expect(found(await search('/r4/Patient?birthdate=sa1980-12-31'))).toEqual([ids.p3]);
    expect(found(await search('/r4/Patient?birthdate=eb1980-01-01'))).toEqual([]);
    expect(found(await search('/r4/Patient?birthdate=ne1980'))).toEqual([ids.p3]);
    // 23:30 at +10:00 on the 31st is 13:30 UTC
    expect(found(await search('/r4/Patient?birthdate=1999-12-31T13:30:00Z'))).toEqual([ids.p3]);
    expect(found(await search('/r4/Observation?date=2020'))).toEqual([ids.o1, ids.o2].sort());
    expect(found(await search('/r4/Observation?date=ge2020-03-01&date=lt2021'))).toEqual([ids.o2]);
    expect(found(await search('/r4/Observation?date=2021-01-15'))).toEqual([]);
    // ap widens by 10% of the distance from now (at least a day): the January 2021 period,
    // but not January 2020
    const ap = found(await search('/r4/Observation?date=ap2021-01-15'));
    expect(ap).toContain(ids.bp);
    expect(ap).not.toContain(ids.o1);
    expect(found(await search('/r4/Observation?date=ge2021-01-15&date=le2021-01-15'))).toEqual([ids.bp]);
    await search('/r4/Patient?birthdate=notadate', 400);
  });

  test('quantity and number', async () => {
    expect(found(await search('/r4/Observation?value-quantity=5.4|http://unitsofmeasure.org|mmol/L'))).toEqual([ids.o1]);
    expect(found(await search('/r4/Observation?value-quantity=gt6|http://unitsofmeasure.org|mmol/L'))).toEqual([ids.o2]);
    expect(found(await search('/r4/Observation?value-quantity=5.4'))).toEqual([ids.o1]);
    expect(found(await search('/r4/Observation?value-quantity=5.40'))).toEqual([ids.o1]);
    expect(found(await search('/r4/Observation?value-quantity=5'))).toEqual([ids.o1]);
    // canonical: 72000 g is 72 kg
    expect(found(await search('/r4/Observation?value-quantity=72|http://unitsofmeasure.org|kg'))).toEqual([ids.o4]);
    expect(found(await search('/r4/Observation?value-quantity=gt5000|http://unitsofmeasure.org|umol/L'))).toEqual([ids.o1, ids.o2].sort());
    expect(found(await search('/r4/Observation?value-quantity=ap120||mm[Hg]'))).toEqual([ids.o3]);
  });

  test('reference', async () => {
    expect(found(await search(`/r4/Observation?subject=Patient/${ids.p1}`))).toEqual([ids.o1, ids.o2].sort());
    expect(found(await search(`/r4/Observation?subject=${ids.p1}`))).toEqual([ids.o1, ids.o2].sort());
    expect(found(await search(`/r4/Observation?subject:Patient=${ids.p1}`))).toEqual([ids.o1, ids.o2].sort());
    expect(found(await search(`/r4/Observation?patient=http://test.example/r4/Patient/${ids.p1}`))).toEqual([ids.o1, ids.o2].sort());
    expect(found(await search(`/r4/Observation?subject:Group=${ids.p1}`))).toEqual([]);
    expect(found(await search('/r4/Patient?organization:missing=true'))).toEqual([ids.p3]);
  });

  test('chains and _has', async () => {
    expect(found(await search('/r4/Observation?subject.family=smith'))).toEqual([ids.o4]);
    expect(found(await search('/r4/Observation?subject:Patient.organization.name=acme'))).toEqual([ids.o1, ids.o2, ids.o3, ids.bp].sort());
    expect(found(await search('/r4/Observation?patient.organization.identifier=urn:org|acme'))).toEqual([ids.o1, ids.o2, ids.o3, ids.bp].sort());
    expect(found(await search('/r4/Patient?_has:Observation:patient:code=2339-0'))).toEqual([ids.p1]);
    expect(found(await search('/r4/Patient?_has:Observation:patient:_has:List:item:_id=nope'))).toEqual([]);
    expect(found(await search(`/r4/Organization?_has:Patient:organization:_has:Observation:patient:code=8480-6`))).toEqual([ids.org]);
  });

  test('composite', async () => {
    expect(found(await search('/r4/Observation?code-value-quantity=http://loinc.org|2339-0$gt7'))).toEqual([ids.o2]);
    expect(found(await search('/r4/Observation?component-code-value-quantity=http://loinc.org|8480-6$140'))).toEqual([ids.bp]);
    // the values of different components don't combine
    expect(found(await search('/r4/Observation?component-code-value-quantity=http://loinc.org|8480-6$90'))).toEqual([]);
  });

  test('_id, _lastUpdated, _tag, _security, _list, _type', async () => {
    expect(found(await search(`/r4/Patient?_id=${ids.p1},${ids.p3}`))).toEqual([ids.p1, ids.p3].sort());
    expect(found(await search('/r4/Patient?_lastUpdated=gt2000-01-01')).length).toBe(3);
    expect(found(await search('/r4/Patient?_lastUpdated=lt2000-01-01'))).toEqual([]);
    expect(found(await search('/r4/Patient?_tag=urn:tags|vip'))).toEqual([ids.p1]);
    expect(found(await search('/r4/Patient?_tag:not=urn:tags|vip'))).toEqual([ids.p2, ids.p3].sort());
    expect(found(await search('/r4/Patient?_security=urn:sec|R'))).toEqual([ids.p1]);
    expect(found(await search(`/r4/Patient?_list=${ids.list}`))).toEqual([ids.p1, ids.p3].sort());
    const both = await search('/r4?_type=Patient,Organization&_count=50');
    expect(both.total).toBe(4);
  });

  test('_filter', async () => {
    const f = (x) => search('/r4/Patient?_filter=' + encodeURIComponent(x)).then(found);
    expect(await f('family eq "mueller"')).toEqual([ids.p2]);
    expect(await f('family co "ll" and gender eq female')).toEqual([ids.p1]);
    expect(await f('family sw smi or given eq bob')).toEqual([ids.p2, ids.p3].sort());
    expect(await f('not (gender eq female)')).toEqual([ids.p2]);
    expect(await f('birthdate ge 1990-01-01')).toEqual([ids.p3]);
    expect(await f('organization.name sw acme and (birthdate lt 1980-03-01)')).toEqual([ids.p2]);
    expect(await f('identifier eq urn:mrn|333')).toEqual([ids.p3]);
    expect(await f('family pr false')).toEqual([]);
    await search('/r4/Patient?_filter=' + encodeURIComponent('family eq'), 400);
    await search('/r4/Patient?_filter=' + encodeURIComponent('family zz x'), 400);
    await search('/r4/Patient?_filter=' + encodeURIComponent('name[family eq x] eq y'), 400);
    expect(found(await search('/r4/Observation?_filter=' + encodeURIComponent('value-quantity gt 100||mm[Hg]')))).toEqual([ids.o3]);
  });

  test('sorting and paging', async () => {
    const asc = await search('/r4/Patient?_sort=family');
    expect(asc.entry.map(e => e.resource.name[0].family)).toEqual(['Mueller', 'Müller', 'Smith']);
    const desc = await search('/r4/Patient?_sort=-birthdate');
    expect(desc.entry[0].resource.id).toBe(ids.p3);
    const pg = await search('/r4/Patient?_sort=family&_count=2');
    expect(pg.total).toBe(3);
    expect(pg.entry.length).toBe(2);
    const next = pg.link.find(l => l.relation === 'next').url.replace(/^https?:\/\/[^/]+/, '');
    const p2 = await search(next);
    expect(p2.entry.map(e => e.resource.name[0].family)).toEqual(['Smith']);
    expect(p2.link.find(l => l.relation === 'previous')).toBeDefined();
    expect(p2.link.find(l => l.relation === 'next')).toBeUndefined();
    // a search's pages are its user's only
    const other = await makeApp(engine, { dir: t.dir, keep: true, master: false, principal: async () => ({ id: 99, login: 'other', has: () => true }) });
    try {
      const r = await request(other.app).get(next);
      expect(r.status).toBe(404);
      // but another process can serve the page to the same user
      const same = await makeApp(engine, { dir: t.dir, keep: true, master: false });
      try {
        const r2 = await request(same.app).get(next);
        expect(r2.status).toBe(200);
        expect(r2.body.entry.map(e => e.resource.name[0].family)).toEqual(['Smith']);
      } finally {
        await same.stop();
      }
    } finally {
      await other.stop();
    }
    const none = await search('/r4/Patient?_total=none&_count=1');
    expect(none.total).toBeUndefined();
    const count = await search('/r4/Patient?_summary=count');
    expect(count.total).toBe(3);
    expect(count.entry).toBeUndefined();
  });

  test('includes', async () => {
    const inc = await search(`/r4/Observation?_id=${ids.o1}&_include=Observation:subject&_include=Observation:performer`);
    const included = inc.entry.filter(e => e.search.mode === 'include').map(e => e.resource.resourceType).sort();
    expect(included).toEqual(['Patient', 'Practitioner']);
    const it = await search(`/r4/Observation?_id=${ids.o1}&_include=Observation:subject&_include:iterate=Patient:organization`);
    expect(it.entry.filter(e => e.search.mode === 'include').map(e => e.resource.resourceType).sort()).toEqual(['Organization', 'Patient']);
    const rev = await search(`/r4/Patient?_id=${ids.p1}&_revinclude=Observation:subject`);
    expect(rev.entry.filter(e => e.search.mode === 'include').map(e => e.resource.id).sort()).toEqual([ids.o1, ids.o2].sort());
  });

  test('_summary and _elements', async () => {
    const s = await search(`/r4/Patient?_id=${ids.p1}&_elements=gender`);
    const r = s.entry[0].resource;
    expect(r.gender).toBe('female');
    expect(r.name).toBeUndefined();
    expect(r.meta.tag.some(x => x.code === 'SUBSETTED')).toBe(true);
    const sum = await search(`/r4/Patient?_id=${ids.p1}&_summary=true`);
    expect(sum.entry[0].resource.name).toBeDefined();
    const read = await request(t.app).get(`/r4/Patient/${ids.p1}?_elements=birthDate`);
    expect(read.body.birthDate).toBe('1980-05-17');
    expect(read.body.gender).toBeUndefined();
  });

  test('compartments', async () => {
    expect(found(await search(`/r4/Patient/${ids.p1}/Observation`))).toEqual([ids.o1, ids.o2].sort());
    expect(found(await search(`/r4/Patient/${ids.p2}/Observation?code=8480-6`))).toEqual([ids.o3]);
    await search(`/r4/Patient/${ids.p1}/Organization`, 400);
  });

  test('unknown parameters are ignored, or refused with handling=strict', async () => {
    const b = await search('/r4/Patient?nonsense=1&family=smith');
    expect(found(b)).toEqual([ids.p3]);
    expect(b.link[0].url).not.toMatch(/nonsense/);
    expect(b.entry.some(e => e.search.mode === 'outcome')).toBe(true);
    const r = await request(t.app).get('/r4/Patient?nonsense=1').set('Prefer', 'handling=strict');
    expect(r.status).toBe(400);
  });

  test('POST _search', async () => {
    const r = await request(t.app).post('/r4/Patient/_search').set('Content-Type', 'application/x-www-form-urlencoded').send('family=smith');
    expect(r.status).toBe(200);
    expect(found(r.body)).toEqual([ids.p3]);
  });

  test('_filter: a filter in brackets on a path step applies to the same target', async () => {
    const fam = 'Brack' + Date.now().toString(36);
    const org = await post({ resourceType: 'Organization', name: 'Bracket Clinic' });
    const smithOff = await post({ resourceType: 'Practitioner', name: [{ family: fam }], active: false });
    const jonesOn = await post({ resourceType: 'Practitioner', name: [{ family: 'Other' + fam }], active: true });
    const smithOn = await post({ resourceType: 'Practitioner', name: [{ family: fam }], active: true });
    const obs = (performers, extra = {}) => post({ resourceType: 'Observation', status: 'final', code: { text: fam },
      performer: performers.map(p => ({ reference: p })), ...extra });
    // two performers who meet the conditions only between them
    const between = await obs([`Practitioner/${smithOff}`, `Practitioner/${jonesOn}`]);
    // one performer who meets both
    const one = await obs([`Practitioner/${smithOn}`]);
    const f = (x) => search('/r4/Observation?_filter=' + encodeURIComponent(x)).then(found);
    expect(await f(`performer.family eq ${fam} and performer.active eq true`)).toEqual([between, one].sort());
    expect(await f(`performer[family eq ${fam}].active eq true`)).toEqual([one]);
    expect(await f(`performer[family eq ${fam} and active eq false].family eq ${fam}`)).toEqual([between]);
    expect(await f(`performer[family eq ${fam}].active eq true or code eq nothing`)).toEqual([one]);
    expect(await f(`not (performer[family eq ${fam}].active eq true) and performer.family eq ${fam}`)).toEqual([between]);
    // nested: a bracket in a later step
    const pid = await post({ resourceType: 'Patient', name: [{ family: fam }], managingOrganization: { reference: `Organization/${org}` } });
    const sub = await obs([], { subject: { reference: `Patient/${pid}` } });
    expect(await f(`subject[family eq ${fam}].organization[name sw bracket].name sw bracket`)).toEqual([sub]);
    expect(await f(`subject[family eq nobody].organization.name sw bracket`)).toEqual([]);
    // what isn't a path with a filter
    await search('/r4/Observation?_filter=' + encodeURIComponent(`performer[family eq ${fam}] pr true`), 400);
    await search('/r4/Observation?_filter=' + encodeURIComponent('status[x eq y].z eq 1'), 400);
    await search('/r4/Observation?_filter=' + encodeURIComponent('performer[family eq x.active eq true'), 400);
    await search('/r4/Observation?_filter=' + encodeURIComponent('performer[].active eq true'), 400);
    await search('/r4/Observation?_filter=' + encodeURIComponent('performer[nonsense eq 1].active eq true'), 400);
    await search('/r4/Observation?_filter=' + encodeURIComponent('subject[organization[name eq a].organization[name eq b].name eq c].family eq d'), 400);
  });

  test('_filter values are literal: backslashes, commas and dollars in them are just characters', async () => {
    // the value has two backslashes in a row, a comma and a dollar: a\\b,c$d
    const value = 'a' + '\\'.repeat(2) + 'b,c$d';
    const id = await post({ resourceType: 'Practitioner', identifier: [{ system: 'urn:odd', value }] });
    const f = (x) => search('/r4/Practitioner?_filter=' + encodeURIComponent(x)).then(found);
    // in a _filter string a backslash escapes the next character, so each is written twice
    const quoted = (v) => '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    expect(await f(`identifier eq ${quoted('urn:odd|' + value)}`)).toEqual([id]);
    expect(await f(`identifier eq ${quoted('urn:odd|a\\b,c$d')}`)).toEqual([]);
    expect(await f(`identifier eq ${quoted('urn:odd|ab,c$d')}`)).toEqual([]);
    // and as an ordinary parameter, with \ , $ | escaped as the specification says
    const escaped = value.replace(/([\\,$|])/g, '\\$1');
    expect(found(await search('/r4/Practitioner?identifier=' + encodeURIComponent('urn:odd|' + escaped)))).toEqual([id]);
  });

  test('a deleted resource is not found', async () => {
    const id = await post({ resourceType: 'Patient', name: [{ family: 'Gone' }] });
    expect(found(await search('/r4/Patient?family=gone'))).toEqual([id]);
    await request(t.app).delete(`/r4/Patient/${id}`);
    expect(found(await search('/r4/Patient?family=gone'))).toEqual([]);
  });
});
