//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// Contained resources: each one a resource refers to ('#id') is indexed with its own type's
// search parameters, under its own key, so chains reach into it; nothing else finds it.

const request = require('supertest');
const { engines, makeApp, body, invariants, snapshot, FHIR_JSON } = require('./helpers');

const gp = (family, extra = {}) => ({ resourceType: 'Practitioner', id: 'gp', name: [{ family }], ...extra });

describe.each(engines())('contained resources (%s)', (engine) => {
  let t;

  const send = (method, url, resource) => request(t.app)[method](url).set('Content-Type', FHIR_JSON).send(body(resource));
  const post = async (resource) => {
    const r = await send('post', `/r4/${resource.resourceType}`, resource);
    if (r.status !== 201) {
      throw new Error(`create failed: ${r.status} ${JSON.stringify(r.body)}`);
    }
    return r.body.id;
  };
  const found = async (url) => {
    const r = await request(t.app).get(url);
    expect(r.status).toBe(200);
    return (r.body.entry || []).filter(e => e.search.mode === 'match').map(e => e.resource.id).sort();
  };
  const containedRows = () => t.ep.db.read(q => q.all('SELECT ResourceKey, LocalId FROM Contained ORDER BY LocalId'));

  beforeEach(async () => {
    t = await makeApp(engine);
  });
  afterEach(async () => {
    expect(await invariants(t.ep)).toEqual([]);
    await t.close();
  });

  test('a chain reaches into a contained resource, with its own search parameters', async () => {
    const id = await post({ resourceType: 'Patient', name: [{ family: 'Smith' }], contained: [gp('Platypus')],
      generalPractitioner: [{ reference: '#gp' }] });
    await post({ resourceType: 'Patient', name: [{ family: 'Jones' }], contained: [gp('Echidna')], generalPractitioner: [{ reference: '#gp' }] });
    expect(await found('/r4/Patient?general-practitioner.name=platypus')).toEqual([id]);
    expect(await found('/r4/Patient?general-practitioner:Practitioner.family=Platypus')).toEqual([id]);
    expect(await found('/r4/Patient?general-practitioner:Organization.name=platypus')).toEqual([]);
    expect(await found('/r4/Patient?general-practitioner.name=wombat')).toEqual([]);
  });

  test('contained resources are not found by searching their type, and _include leaves them out', async () => {
    const real = await post(gp('Platypus', { id: undefined }));
    const id = await post({ resourceType: 'Patient', contained: [gp('Platypus')], generalPractitioner: [{ reference: '#gp' }, { reference: `Practitioner/${real}` }] });
    expect(await found('/r4/Practitioner?name=platypus')).toEqual([real]);
    expect(await found('/r4/Practitioner')).toEqual([real]);
    const r = await request(t.app).get(`/r4/Patient?_id=${id}&_include=Patient:general-practitioner`);
    expect(r.body.entry.map(e => `${e.search.mode}:${e.resource.resourceType}/${e.resource.id}`).sort())
      .toEqual([`include:Practitioner/${real}`, `match:Patient/${id}`]);
  });

  test('a contained resource that is not referred to is not indexed', async () => {
    await post({ resourceType: 'Patient', contained: [gp('Platypus')] });
    expect(await containedRows()).toEqual([]);
  });

  test('a contained resource\'s references to its siblings, and to real resources, are indexed too', async () => {
    const org = await post({ resourceType: 'Organization', name: 'Acme' });
    // an Observation about a contained patient, whose GP is contained alongside it
    const id = await post({ resourceType: 'Observation', status: 'final', code: { text: 'x' },
      contained: [
        { resourceType: 'Patient', id: 'p', name: [{ family: 'Smith' }], generalPractitioner: [{ reference: '#gp' }],
          managingOrganization: { reference: `Organization/${org}` } },
        gp('Platypus')
      ],
      subject: { reference: '#p' } });
    expect(await found('/r4/Observation?subject:Patient.general-practitioner.name=platypus')).toEqual([id]);
    expect(await found('/r4/Observation?subject:Patient.organization.name=acme')).toEqual([id]);
    expect(await found('/r4/Observation?subject:Patient.organization.name=other')).toEqual([]);
    expect(await found(`/r4/Observation?subject:Patient.organization=Organization/${org}`)).toEqual([id]);
    // parameters that use resolve() (Observation.patient: subject.where(resolve() is Patient))
    // follow the reference into the contained resource too
    expect(await found('/r4/Observation?patient.name=smith')).toEqual([id]);
    expect(await found('/r4/Observation?patient.general-practitioner.name=platypus')).toEqual([id]);
    expect(await found('/r4/Observation?patient.name=jones')).toEqual([]);
    // each contained resource once, however often it is referred to
    expect((await containedRows()).map(c => c.LocalId)).toEqual(['gp', 'p']);
  });

  test('"#" is the container itself', async () => {
    const id = await post({ resourceType: 'Observation', status: 'final', code: { text: 'x' },
      contained: [{ resourceType: 'Patient', id: 'p', link: [{ other: { reference: '#' }, type: 'seealso' }] }],
      subject: { reference: '#p' } });
    const rows = await t.ep.db.read(q => q.all(`SELECT r.TargetKey, r.TargetType, r.TargetId FROM IndexReferences r
      JOIN Ids i ON i.ResourceKey = r.TargetKey WHERE r.ResourceKey < 0`));
    expect(rows.map(r => `${r.TargetType}/${r.TargetId}`)).toEqual([`Observation/${id}`]);
  });

  test('a reference to a contained resource that isn\'t there is an error, and nothing is written', async () => {
    const before = await snapshot(t.ep);
    const r = await send('post', '/r4/Patient', { resourceType: 'Patient', contained: [gp('Platypus')], generalPractitioner: [{ reference: '#nobody' }] });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toMatch(/#nobody/);
    expect(await snapshot(t.ep)).toEqual(before);
  });

  test('an update replaces the contained resources, and a delete removes them', async () => {
    const id = await post({ resourceType: 'Patient', contained: [gp('Platypus')], generalPractitioner: [{ reference: '#gp' }] });
    expect(await found('/r4/Patient?general-practitioner.name=platypus')).toEqual([id]);
    let r = await send('put', `/r4/Patient/${id}`, { resourceType: 'Patient', id, contained: [gp('Echidna')], generalPractitioner: [{ reference: '#gp' }] });
    expect(r.status).toBe(200);
    expect(await found('/r4/Patient?general-practitioner.name=platypus')).toEqual([]);
    expect(await found('/r4/Patient?general-practitioner.name=echidna')).toEqual([id]);
    expect(await containedRows()).toHaveLength(1);
    r = await send('put', `/r4/Patient/${id}`, { resourceType: 'Patient', id });
    expect(r.status).toBe(200);
    expect(await containedRows()).toEqual([]);
    expect(await found('/r4/Patient?general-practitioner.name=echidna')).toEqual([]);

    const id2 = await post({ resourceType: 'Patient', contained: [gp('Wombat')], generalPractitioner: [{ reference: '#gp' }] });
    r = await request(t.app).delete(`/r4/Patient/${id2}`);
    expect(r.status).toBeLessThan(300);
    expect(await containedRows()).toEqual([]);
    const left = await t.ep.db.read(q => q.get('SELECT COUNT(*) AS N FROM IndexStrings WHERE ResourceKey < 0'));
    expect(Number(left.N)).toBe(0);
  });

  test('in a transaction: contained resources alongside references to entries', async () => {
    const tx = {
      resourceType: 'Bundle', type: 'transaction', entry: [
        { fullUrl: 'urn:uuid:11111111-1111-1111-1111-111111111111', resource: { resourceType: 'Organization', name: 'Acme' },
          request: { method: 'POST', url: 'Organization' } },
        { fullUrl: 'urn:uuid:22222222-2222-2222-2222-222222222222', request: { method: 'POST', url: 'Observation' },
          resource: { resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: '#p' },
            contained: [{ resourceType: 'Patient', id: 'p', managingOrganization: { reference: 'urn:uuid:11111111-1111-1111-1111-111111111111' } }] } }
      ]
    };
    const r = await send('post', '/r4', tx);
    expect(r.status).toBe(200);
    const obs = r.body.entry[1].response.location.split('/')[1];
    expect(await found('/r4/Observation?subject:Patient.organization.name=acme')).toEqual([obs]);
    // the contained patient's reference was rewritten to the new organization
    const o = await request(t.app).get(`/r4/Observation/${obs}`);
    expect(o.body.contained[0].managingOrganization.reference).toMatch(/^Organization\/[^/]+$/);

    // and a dangling contained reference rolls the whole transaction back
    const before = await snapshot(t.ep);
    const bad = JSON.parse(JSON.stringify(tx));
    bad.entry[1].resource.subject.reference = '#q';
    const b = await send('post', '/r4', bad);
    expect(b.status).toBe(422);
    expect(await snapshot(t.ep)).toEqual(before);
  });

  test('reindexing is lenient about what is already stored, and puts the contained resources back', async () => {
    const id = await post({ resourceType: 'Patient', contained: [gp('Platypus')], generalPractitioner: [{ reference: '#gp' }] });
    // something stored before references to contained resources were checked
    const bad = await post({ resourceType: 'Patient', name: [{ family: 'Bad' }] });
    await t.ep.db.write(async (q) => {
      const v = await q.get('SELECT i.MostRecent FROM Ids i WHERE i.Id = ?', [bad]);
      const res = { resourceType: 'Patient', id: bad, name: [{ family: 'Bad' }], generalPractitioner: [{ reference: '#nobody' }] };
      await q.run('UPDATE Versions SET Compressed = 0, Content = ? WHERE VersionKey = ?', [Buffer.from(JSON.stringify(res)), v.MostRecent]);
      await q.exec('DELETE FROM Contained');
      await q.exec('DELETE FROM IndexReferences');
      await q.exec('DELETE FROM IndexStrings WHERE ResourceKey < 0');
      await q.run("INSERT INTO Config (Name, Value) VALUES ('reindexAll', '1')");
    });
    t.ep.reindexAll = true;
    while (await t.ep.reindexBatch() > 0) {
      // the next batch
    }
    expect(await found('/r4/Patient?general-practitioner.name=platypus')).toEqual([id]);
    expect(await containedRows()).toHaveLength(1);
  });

  describe('_contained and _containedType', () => {
    const ids = {};
    const bundle = async (url) => {
      const r = await request(t.app).get(url);
      expect(r.status).toBe(200);
      return r.body;
    };
    const entries = (b) => (b.entry || []).filter(e => e.search.mode !== 'outcome')
      .map(e => `${e.search.mode} ${e.fullUrl.replace('http://test.example/r4/', '')}`).sort();

    beforeEach(async () => {
      ids.real = await post(gp('Platypus', { id: undefined }));
      ids.p1 = await post({ resourceType: 'Patient', name: [{ family: 'One' }],
        contained: [gp('Platypus'), { resourceType: 'Practitioner', id: 'gp2', name: [{ family: 'Platypus' }, { family: 'Wombat' }] }],
        generalPractitioner: [{ reference: '#gp' }, { reference: '#gp2' }] });
      ids.p2 = await post({ resourceType: 'Patient', name: [{ family: 'Two' }], contained: [gp('Echidna')], generalPractitioner: [{ reference: '#gp' }] });
    });

    test('false (the default) finds only resources of their own', async () => {
      expect(entries(await bundle('/r4/Practitioner?name=platypus'))).toEqual([`match Practitioner/${ids.real}`]);
      expect(entries(await bundle('/r4/Practitioner?name=platypus&_contained=false'))).toEqual([`match Practitioner/${ids.real}`]);
    });

    test('true finds contained resources, and returns their containers, once each', async () => {
      const b = await bundle('/r4/Practitioner?name=platypus&_contained=true');
      expect(entries(b)).toEqual([`match Patient/${ids.p1}`]);
      expect(b.total).toBe(1);
      expect(entries(await bundle('/r4/Practitioner?_contained=true'))).toEqual([`match Patient/${ids.p1}`, `match Patient/${ids.p2}`]);
      expect((await bundle('/r4/Practitioner?name=platypus&_contained=true&_summary=count')).total).toBe(1);
      expect((await bundle('/r4/Practitioner?_contained=true&_summary=count')).total).toBe(2);
    });

    test('both finds either', async () => {
      expect(entries(await bundle('/r4/Practitioner?name=platypus&_contained=both')))
        .toEqual([`match Patient/${ids.p1}`, `match Practitioner/${ids.real}`]);
    });

    test('_containedType=contained returns the contained resources themselves', async () => {
      const b = await bundle('/r4/Practitioner?name=platypus&_contained=true&_containedType=contained');
      expect(entries(b)).toEqual([`match Patient/${ids.p1}#gp`, `match Patient/${ids.p1}#gp2`]);
      expect(b.total).toBe(2);
      expect(b.entry.every(e => e.resource.resourceType === 'Practitioner')).toBe(true);
      expect(b.entry.find(e => e.resource.id === 'gp2').resource.name).toHaveLength(2);
      expect(entries(await bundle('/r4/Practitioner?name=platypus&_contained=both&_containedType=contained')))
        .toEqual([`match Patient/${ids.p1}#gp`, `match Patient/${ids.p1}#gp2`, `match Practitioner/${ids.real}`]);
      expect((await bundle('/r4/Practitioner?_contained=true&_containedType=contained&_summary=count')).total).toBe(3);
    });

    test('_id is the local id, and _lastUpdated the container\'s', async () => {
      expect(entries(await bundle('/r4/Practitioner?_id=gp&_contained=true&_containedType=contained')))
        .toEqual([`match Patient/${ids.p1}#gp`, `match Patient/${ids.p2}#gp`]);
      expect(entries(await bundle('/r4/Practitioner?_id:not=gp&_contained=true&_containedType=contained'))).toEqual([`match Patient/${ids.p1}#gp2`]);
      expect(entries(await bundle(`/r4/Practitioner?_id=${ids.real}&_contained=both`))).toEqual([`match Practitioner/${ids.real}`]);
      expect((await bundle('/r4/Practitioner?_lastUpdated=gt2020-01-01&_contained=true&_containedType=contained&_summary=count')).total).toBe(3);
      expect((await bundle('/r4/Practitioner?_lastUpdated=lt2020-01-01&_contained=true&_summary=count')).total).toBe(0);
    });

    test('sorting, and paging through contained resources', async () => {
      const b = await bundle('/r4/Practitioner?_contained=both&_containedType=contained&_sort=-family,_id&_count=2');
      const url = (e) => e.fullUrl.replace('http://test.example/r4/', '');
      const seen = b.entry.filter(e => e.search.mode === 'match').map(url);
      let next = b.link.find(l => l.relation === 'next');
      while (next) {
        const nb = await bundle(next.url.replace('http://test.example', ''));
        seen.push(...nb.entry.filter(e => e.search.mode === 'match').map(url));
        next = nb.link.find(l => l.relation === 'next');
      }
      // gp2 is Platypus and Wombat: it sorts by the highest, Wombat; the two other Platypuses tie
      expect(seen).toHaveLength(4);
      expect(seen[0]).toBe(`Patient/${ids.p1}#gp2`);
      expect(seen.slice(1, 3).sort()).toEqual([`Patient/${ids.p1}#gp`, `Practitioner/${ids.real}`].sort());
      expect(seen[3]).toBe(`Patient/${ids.p2}#gp`);
    });

    test('_include and _revinclude work from contained matches', async () => {
      const b = await bundle('/r4/Practitioner?name=echidna&_contained=true&_containedType=contained&_revinclude=Patient:general-practitioner');
      expect(entries(b)).toEqual([`include Patient/${ids.p2}`, `match Patient/${ids.p2}#gp`]);
    });

    test('a compartment search goes by the container', async () => {
      const pat = await post({ resourceType: 'Patient', name: [{ family: 'Three' }] });
      const list = await post({ resourceType: 'List', status: 'current', mode: 'working', subject: { reference: `Patient/${pat}` },
        contained: [{ resourceType: 'Observation', id: 'o', status: 'final', code: { text: 'x' } }], entry: [{ item: { reference: '#o' } }] });
      expect(entries(await bundle(`/r4/Patient/${pat}/Observation?_contained=true`))).toEqual([`match List/${list}`]);
      expect(entries(await bundle(`/r4/Patient/${pat}/Observation?_contained=true&_containedType=contained`))).toEqual([`match List/${list}#o`]);
      expect(entries(await bundle(`/r4/Patient/${ids.p1}/Observation?_contained=true`))).toEqual([]);
    });

    test('bad values are errors', async () => {
      expect((await request(t.app).get('/r4/Practitioner?_contained=maybe')).status).toBe(400);
      expect((await request(t.app).get('/r4/Practitioner?_contained=true&_containedType=either')).status).toBe(400);
    });
  });
});
