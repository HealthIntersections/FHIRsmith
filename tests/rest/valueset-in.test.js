//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// :in and :not-in, end to end: the tx module, in the same app, is the endpoint's terminology
// server, and expands the value sets.

const path = require('path');
const request = require('supertest');
const TXModule = require('../../tx/tx');
const { engines, makeApp, body, FHIR_JSON } = require('./helpers');

const LIBRARY = path.join(__dirname, '..', 'tx', 'fixtures', 'test-library.yaml');
const TYPES = 'http://hl7.org/fhir/fhir-types';
const GENDER_VS = 'http://hl7.org/fhir/ValueSet/administrative-gender';
const TYPES_VS = 'http://hl7.org/fhir/ValueSet/resource-types';

describe.each(engines())(':in and :not-in (%s)', (engine) => {
  let t;
  let tx;
  const ids = {};

  const post = async (resource) => {
    const r = await request(t.app).post(`/r4/${resource.resourceType}`).set('Content-Type', FHIR_JSON).send(body(resource));
    expect(r.status).toBe(201);
    return r.body.id;
  };
  const search = (url) => request(t.app).get(url);
  const found = async (url) => {
    const r = await search(url);
    expect(r.status).toBe(200);
    return (r.body.entry || []).filter(e => e.search.mode === 'match').map(e => e.resource.id).sort();
  };
  const of = (...names) => names.map(n => ids[n]).sort();
  const enc = encodeURIComponent;

  beforeAll(async () => {
    t = await makeApp(engine, {
      settings: { txServer: '/tx/r5' },
      before: async (app) => {
        tx = new TXModule();
        await tx.initialize({ librarySource: LIBRARY, endpoints: [{ path: '/tx/r5', fhirVersion: '5.0', context: null }] }, app);
      }
    });
    ids.female = await post({ resourceType: 'Patient', gender: 'female' });
    ids.male = await post({ resourceType: 'Patient', gender: 'male' });
    ids.none = await post({ resourceType: 'Patient' });
    // a Coding with its system: the value set's codes match by system and code
    ids.patientType = await post({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: TYPES, code: 'Patient' }] } });
    // Resource is abstract: not in the value set's expansion
    ids.resourceType = await post({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: TYPES, code: 'Resource' }] } });
    ids.otherSystem = await post({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://example.org/other', code: 'Patient' }] } });
  }, 240000);

  afterAll(async () => {
    await t.close();
    await tx.shutdown();
  });

  test(':in on a Coding: the codes in the expansion, in their systems', async () => {
    expect(await found(`/r4/Observation?code:in=${enc(TYPES_VS)}`)).toEqual(of('patientType'));
  });

  test(':not-in on a Coding', async () => {
    expect(await found(`/r4/Observation?code:not-in=${enc(TYPES_VS)}`)).toEqual(of('resourceType', 'otherSystem'));
  });

  test(':in on a code element (no system in the resource)', async () => {
    expect(await found(`/r4/Patient?gender:in=${enc(GENDER_VS)}`)).toEqual(of('female', 'male'));
  });

  test(':not-in on a code element includes what has no value', async () => {
    expect(await found(`/r4/Patient?gender:not-in=${enc(GENDER_VS)}`)).toEqual(of('none'));
  });

  test('in _filter: in and ni', async () => {
    expect(await found('/r4/Patient?_filter=' + enc(`gender in "${GENDER_VS}"`))).toEqual(of('female', 'male'));
    expect(await found('/r4/Observation?_filter=' + enc(`code ni "${TYPES_VS}"`))).toEqual(of('resourceType', 'otherSystem'));
  });

  test('a value set the server can\'t expand is an error', async () => {
    const r = await search(`/r4/Patient?gender:in=${enc('http://example.org/no-such-valueset')}`);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/couldn't be expanded/);
  });
});

describe.each(engines())('value sets registered for searching (%s)', (engine) => {
  let t;
  let tx;
  const ids = {};
  const reader = { id: 2, login: 'reader', name: 'Reader', isAdmin: false, has: (m, role) => m === 'rest' && role === 'read' };
  const admin = { id: 1, login: 'admin', name: 'Admin', isAdmin: true, has: () => true };
  const enc = encodeURIComponent;

  const post = async (resource) => {
    const r = await request(t.app).post(`/r4/${resource.resourceType}`).set('Content-Type', FHIR_JSON).send(body(resource));
    expect(r.status).toBe(201);
    return r.body.id;
  };
  const obs = (system, code) => post({ resourceType: 'Observation', status: 'final', code: { coding: [{ system, code }] } });
  const searchFor = async (url, status = 200) => {
    const r = await request(t.app).get(url);
    expect(r.status).toBe(status);
    return r.body;
  };
  const found = async (url) => ((await searchFor(url)).entry || []).filter(e => e.search.mode === 'match').map(e => e.resource.id).sort();
  const warningsOf = (b) => (b.entry || []).filter(e => e.search.mode === 'outcome').flatMap(e => e.resource.issue.map(i => i.diagnostics));
  const of = (...names) => names.map(n => ids[n]).sort();
  const page = (url, who = 'admin') => request(t.app).get(url).set('Accept', 'text/html').set('X-Test-User', who);
  const form = (fields, who = 'admin') => request(t.app).post('/r4/_admin/valuesets').set('X-Test-User', who).type('form').send(fields);
  const update = async () => {
    while (await t.ep.terminology.updateValueSets(t.ep) > 0) {
      // the next batch
    }
  };
  const registered = () => t.ep.db.read(q => q.all('SELECT ValueSetKey, Url, Version, Systems, Status FROM ValueSets ORDER BY Url'));

  beforeAll(async () => {
    t = await makeApp(engine, {
      // resource-types has more codes than this
      settings: { txServer: '/tx/r5', maxValueSetExpansion: 20 },
      principal: async (req) => (req.get('X-Test-User') === 'reader' ? reader : admin),
      before: async (app) => {
        tx = new TXModule();
        await tx.initialize({ librarySource: LIBRARY, endpoints: [{ path: '/tx/r5', fhirVersion: '5.0', context: null }] }, app);
      }
    });
    ids.Patient = await obs(TYPES, 'Patient');
    ids.Encounter = await obs(TYPES, 'Encounter');
    ids.other = await obs('http://example.org/other', 'Patient');
    ids.female = await post({ resourceType: 'Patient', gender: 'female' });
    ids.nogender = await post({ resourceType: 'Patient' });
  }, 240000);

  afterAll(async () => {
    await t.close();
    await tx.shutdown();
  });

  test('a value set too big to expand can\'t be searched, and the error says how to have it registered', async () => {
    const b = await searchFor(`/r4/Observation?code:in=${enc(TYPES_VS)}`, 400);
    expect(b.issue[0].code).toBe('too-costly');
    expect(b.issue[0].diagnostics).toMatch(/has \d+ codes, more than 20 \(maxValueSetExpansion\)/);
    expect(b.issue[0].diagnostics).toMatch(/An administrator can register it for searching \(\/r4\/_admin\/valuesets\)/);
  });

  test('the page: only for the manage role, linked from the endpoint\'s home page', async () => {
    expect((await page('/r4/_admin/valuesets', 'reader')).status).toBe(403);
    expect((await form({ action: 'register', url: TYPES_VS }, 'reader')).status).toBe(403);
    expect((await page('/r4', 'reader')).text).not.toContain('_admin/valuesets');
    expect((await page('/r4')).text).toContain('<a href="/r4/_admin/valuesets">Value sets for searching</a>');
    const h = await page('/r4/_admin/valuesets');
    expect(h.status).toBe(200);
    expect(h.text).toContain('No value sets are registered.');
    // finding the versions the terminology server has
    const v = await page(`/r4/_admin/valuesets?url=${enc(TYPES_VS)}`);
    expect(v.text).toContain('name="version" value="5.0.0"');
  });

  test('registered: searched by membership, worked out in the background', async () => {
    const r = await form({ action: 'register', url: TYPES_VS, version: '5.0.0' });
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe('/r4/_admin/valuesets');
    // not worked out yet: nothing found, and the search says why
    const before = await searchFor(`/r4/Observation?code:in=${enc(TYPES_VS)}`);
    expect(before.entry.filter(e => e.search.mode === 'match')).toEqual([]);
    expect(warningsOf(before).join()).toMatch(/still being prepared for searching/);

    const asked = [];
    const validate = t.ep.terminology.validateBatch.bind(t.ep.terminology);
    t.ep.terminology.validateBatch = (u, v, c) => { asked.push(...c.map(x => x.system)); return validate(u, v, c); };
    try {
      await update();
    } finally {
      t.ep.terminology.validateBatch = validate;
    }
    // the value set draws only on fhir-types: the other system's code isn't asked about
    const [vs] = await registered();
    expect(JSON.parse(vs.Systems)).toEqual([TYPES]);
    expect(Number(vs.Status)).toBe(1);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every(s => s === TYPES)).toBe(true);

    const after = await searchFor(`/r4/Observation?code:in=${enc(TYPES_VS)}`);
    expect(warningsOf(after)).toEqual([]);
    expect(await found(`/r4/Observation?code:in=${enc(TYPES_VS)}`)).toEqual(of('Patient', 'Encounter'));
    expect(await found(`/r4/Observation?code:not-in=${enc(TYPES_VS)}`)).toEqual(of('other'));
    // the version asked for is ignored
    expect(await found(`/r4/Observation?code:in=${enc(TYPES_VS + '|4.0.1')}`)).toEqual(of('Patient', 'Encounter'));
    expect(await found('/r4/Observation?_filter=' + enc(`code in "${TYPES_VS}"`))).toEqual(of('Patient', 'Encounter'));
    const p = await page('/r4/_admin/valuesets');
    expect(p.text).toContain('ready');
    expect(p.text).toContain('5.0.0');
  });

  test('a code indexed later is worked out at the next round', async () => {
    ids.Practitioner = await obs(TYPES, 'Practitioner');
    expect(await found(`/r4/Observation?code:in=${enc(TYPES_VS)}`)).toEqual(of('Patient', 'Encounter'));
    await update();
    expect(await found(`/r4/Observation?code:in=${enc(TYPES_VS)}`)).toEqual(of('Patient', 'Encounter', 'Practitioner'));
  });

  test('worked out again, and removed', async () => {
    const [vs] = await registered();
    expect((await form({ action: 'rebuild', key: String(vs.ValueSetKey) })).status).toBe(303);
    expect(Number((await registered())[0].Status)).toBe(0);
    expect(await found(`/r4/Observation?code:in=${enc(TYPES_VS)}`)).toEqual([]);
    await update();
    expect(await found(`/r4/Observation?code:in=${enc(TYPES_VS)}`)).toEqual(of('Patient', 'Encounter', 'Practitioner'));
    expect((await form({ action: 'remove', key: String(vs.ValueSetKey) })).status).toBe(303);
    expect(await registered()).toEqual([]);
    const n = await t.ep.db.read(q => q.get('SELECT COUNT(*) AS N FROM ValueSetMembers'));
    expect(Number(n.N)).toBe(0);
    await searchFor(`/r4/Observation?code:in=${enc(TYPES_VS)}`, 400);
  });

  test('a code element, against a registered value set that can be expanded, matches by expansion', async () => {
    expect((await form({ action: 'register', url: GENDER_VS })).status).toBe(303);
    await update();
    expect(await found(`/r4/Patient?gender:in=${enc(GENDER_VS)}`)).toEqual(of('female'));
    expect(await found(`/r4/Patient?gender:not-in=${enc(GENDER_VS)}`)).toEqual(of('nogender'));
  });

  test('bad posts are refused', async () => {
    expect((await form({ action: 'register', url: '' })).status).toBe(400);
    expect((await form({ action: 'register', url: 'has spaces' })).status).toBe(400);
    expect((await form({ action: 'explode' })).status).toBe(400);
    expect((await form({ action: 'remove', key: 'x' })).status).toBe(400);
  });
});

describe(':in on a value set that isn\'t closed', () => {
  let t;
  const UNCLOSED_VS = 'http://example.org/ValueSet/open';

  beforeAll(async () => {
    t = await makeApp('sqlite', {
      settings: { txServer: '/stubtx' },
      before: async (app) => {
        // a terminology server that says the expansion isn't closed
        app.get('/stubtx/ValueSet/$expand', (req, res) => {
          res.json({ resourceType: 'ValueSet', url: req.query.url, status: 'active', expansion: {
            extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed', valueBoolean: true },
              { url: 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed-reason', valueString: 'grammar-based' }],
            timestamp: '2026-01-01T00:00:00Z', contains: [{ system: 'urn:ietf:bcp:47', code: 'en' }] } });
        });
      }
    });
  });

  afterAll(async () => {
    await t.close();
  });

  test('can\'t be searched by expanding it', async () => {
    const r = await request(t.app).get(`/r4/Patient?language:in=${encodeURIComponent(UNCLOSED_VS)}`);
    expect(r.status).toBe(400);
    expect(r.body.issue[0].code).toBe('too-costly');
    expect(r.body.issue[0].diagnostics).toMatch(/isn't closed \(its codes can't all be listed: grammar-based\)/);
  });
});
