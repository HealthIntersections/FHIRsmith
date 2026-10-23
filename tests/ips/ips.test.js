const express = require('express');
const request = require('supertest');

const IpsModule = require('../../ips/ips');
const { validateDocument } = require('../../ips/ips');
const { parseSearch, indexDocument, listQueryToSearch, resolveParam } = require('../../ips/search');
const { STEPS, CHECK_EXTENSION, TRANSLATION_EXTENSION } = require('../../ips/pipeline');
const { fakeService } = require('./fake-ai');
const render = require('../../ips/render');
const profiles = require('../../ips/profiles');
const htmlServer = require('../../library/html-server');

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
htmlServer.useLog(quietLog);

function makeStats() {
  return {
    counts: {},
    countRequest(name) { this.counts[name] = (this.counts[name] || 0) + 1; },
    addTask() {}, task() {}, taskDone() {}, taskError() {}
  };
}

/** A small but well-formed IPS document. */
function ips(overrides = {}) {
  const { patient = {}, composition = {}, ...bundle } = overrides;
  return {
    resourceType: 'Bundle',
    type: 'document',
    identifier: { system: 'urn:oid:2.16.840.1.113883.19.5', value: 'doc-1' },
    timestamp: '2026-03-01T10:00:00Z',
    entry: [
      {
        fullUrl: 'urn:uuid:comp-1',
        resource: {
          resourceType: 'Composition',
          id: 'comp-1',
          status: 'final',
          type: { coding: [{ system: 'http://loinc.org', code: '60591-5', display: 'Patient summary Document' }] },
          subject: { reference: 'urn:uuid:pat-1' },
          date: '2026-03-01T09:30:00Z',
          author: [{ reference: 'urn:uuid:pract-1' }],
          title: 'Patient Summary as of 1 March 2026',
          text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml"><p>Summary for <b>Jane Smith</b></p></div>' },
          section: [
            {
              title: 'Allergies and Intolerances',
              code: { coding: [{ system: 'http://loinc.org', code: '48765-2' }] },
              text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml"><table><tr><td>Penicillin</td></tr></table></div>' },
              entry: [{ reference: 'urn:uuid:allergy-1' }]
            },
            {
              title: 'Medication Summary',
              code: { coding: [{ system: 'http://loinc.org', code: '10160-0' }] },
              text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml"><p>No known medications</p></div>' }
            }
          ],
          ...composition
        }
      },
      {
        fullUrl: 'urn:uuid:pat-1',
        resource: {
          resourceType: 'Patient',
          id: 'pat-1',
          identifier: [{ system: 'urn:oid:1.2.36.146.595.217.0.1', value: 'MRN-12345' }],
          active: true,
          name: [{ use: 'official', family: 'Smith', given: ['Jane', 'Alexandra'] }, { use: 'nickname', given: ['Janie'] }],
          telecom: [{ system: 'phone', value: '+61 3 9999 0000' }, { system: 'email', value: 'jane@example.org' }],
          gender: 'female',
          birthDate: '1970-05-06',
          address: [{ line: ['1 Collins St'], city: 'Melbourne', state: 'VIC', postalCode: '3000', country: 'AU' }],
          ...patient
        }
      },
      { fullUrl: 'urn:uuid:pract-1', resource: { resourceType: 'Practitioner', id: 'pract-1', name: [{ family: 'Jones' }] } },
      { fullUrl: 'urn:uuid:allergy-1', resource: { resourceType: 'AllergyIntolerance', id: 'allergy-1', patient: { reference: 'urn:uuid:pat-1' }, code: { coding: [{ system: 'http://snomed.info/sct', code: '91936005', display: 'Allergy to penicillin' }], text: 'Penicillin' } } }
    ],
    ...bundle
  };
}

// mirrors the body parsers server.js puts in front of every module
async function makeApp(config = {}) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.raw({ type: 'application/fhir+json', limit: '50mb' }));
  app.use(express.raw({ type: 'application/fhir+xml', limit: '50mb' }));
  app.use(express.json({ limit: '50mb' }));
  const mod = new IpsModule(makeStats(), quietLog);
  await mod.initialize({
    database: ':memory:', rateLimit: { max: 0 }, adminPassword: 'admin-secret', cookieSecure: false,
    processing: { enabled: false }, ...config
  }, app);
  app.use('/ips', mod.router);
  return { app, mod };
}

function post(app, code, body, headers = {}) {
  let r = request(app).post(`/ips/${code}/Bundle`).set('Content-Type', 'application/fhir+json');
  for (const [k, v] of Object.entries(headers)) {
    r = r.set(k, v);
  }
  return r.send(typeof body === 'string' ? body : JSON.stringify(body));
}

const csrfOf = async (agent) => {
  const page = await agent.get('/ips/login');
  return page.text.match(/name="_csrf" value="([^"]+)"/)[1];
};
const form = async (agent, url, data = {}, headers = {}) => {
  const _csrf = await csrfOf(agent);
  return agent.post(url).type('form').set(headers).send({ ...data, _csrf });
};
const loginAs = async (app, login, password) => {
  const agent = request.agent(app);
  const res = await form(agent, '/ips/login', { login, password });
  return { agent, res };
};

describe('validateDocument', () => {
  test('accepts a well-formed document', () => {
    expect(validateDocument(ips())).toEqual([]);
  });

  test('rejects things that are not document bundles', () => {
    expect(validateDocument([])).toHaveLength(1);
    expect(validateDocument({ resourceType: 'Patient' })[0]).toMatch(/Bundle, not Patient/);
    expect(validateDocument(ips({ type: 'collection' }))[0]).toMatch(/type 'document'/);
    expect(validateDocument(ips({ entry: [] }))).toEqual(['The Bundle has no entries']);
  });

  test('requires a Composition first, with a Patient subject in the bundle', () => {
    const b = ips();
    b.entry.reverse();
    expect(validateDocument(b)[0]).toMatch(/first entry must be a Composition, not a AllergyIntolerance/);
    const noPatient = ips();
    noPatient.entry = noPatient.entry.filter(e => e.resource.resourceType !== 'Patient');
    expect(validateDocument(noPatient)).toEqual(["The Composition's subject must be a Patient in the bundle"]);
  });

  test('rejects active content in any narrative', () => {
    const b = ips();
    b.entry[1].resource.text = { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></div>' };
    expect(validateDocument(b)[0]).toMatch(/active content/);
    const c = ips();
    c.entry[0].resource.section[0].text.div = '<div><img src="x" onerror="alert(1)"/></div>';
    expect(validateDocument(c)[0]).toMatch(/active content/);
  });
});

describe('indexing', () => {
  test('indexes the bundle, the composition and the patient', () => {
    const rows = indexDocument(ips());
    const of = (res, param) => rows.filter(r => r.res === res && r.param === param);
    expect(of('Bundle', 'identifier')).toMatchObject([{ sys: 'urn:oid:2.16.840.1.113883.19.5', code: 'doc-1' }]);
    expect(of('Bundle', 'composition').map(r => r.ref).sort()).toEqual(['Composition/comp-1', 'urn:uuid:comp-1']);
    expect(of('Composition', 'type')).toMatchObject([{ sys: 'http://loinc.org', code: '60591-5' }]);
    expect(of('Composition', 'date')[0].lo).toBe(Date.parse('2026-03-01T09:30:00Z'));
    expect(of('Composition', 'patient')).toMatchObject([{ ref: 'urn:uuid:pat-1' }]);
    expect(of('Composition', 'section').map(r => r.code).sort()).toEqual(['10160-0', '48765-2']);
    expect(of('Patient', 'name').map(r => r.str).sort()).toEqual(['Alexandra', 'Jane', 'Janie', 'Smith']);
    expect(of('Patient', 'family').map(r => r.str)).toEqual(['Smith']);
    expect(of('Patient', 'gender')).toMatchObject([{ code: 'female' }]);
    expect(of('Patient', 'birthdate')[0]).toMatchObject({ lo: Date.UTC(1970, 4, 6), hi: Date.UTC(1970, 4, 7) });
    expect(of('Patient', 'identifier')).toMatchObject([{ sys: 'urn:oid:1.2.36.146.595.217.0.1', code: 'MRN-12345' }]);
    expect(of('Patient', 'email')).toMatchObject([{ sys: 'email', code: 'jane@example.org' }]);
    expect(of('Patient', 'address-city').map(r => r.str)).toEqual(['Melbourne']);
    expect(of('Patient', 'active')).toMatchObject([{ code: 'true' }]);
  });

  test('finds the patient by Type/id references too, and falls back to the first Patient', () => {
    const b = ips({ composition: { subject: { reference: 'Patient/pat-1' } } });
    expect(indexDocument(b).some(r => r.res === 'Patient' && r.param === 'family')).toBe(true);
    const c = ips({ composition: { subject: { reference: 'Patient/nobody' } } });
    expect(indexDocument(c).some(r => r.res === 'Patient' && r.param === 'family')).toBe(true);
  });
});

describe('parseSearch', () => {
  test('resolves chains', () => {
    expect(resolveParam('identifier')).toMatchObject({ res: 'Bundle', param: 'identifier' });
    expect(resolveParam('composition.date')).toMatchObject({ res: 'Composition', param: 'date' });
    expect(resolveParam('composition.patient.name')).toMatchObject({ res: 'Patient', param: 'name' });
    expect(resolveParam('composition.subject.birthdate')).toMatchObject({ res: 'Patient', param: 'birthdate' });
    expect(resolveParam('composition.patient:Patient.gender')).toMatchObject({ res: 'Patient', param: 'gender' });
    expect(resolveParam('composition.author.name')).toBeNull();
    expect(resolveParam('patient.name')).toBeNull();
    expect(resolveParam('composition.nope')).toBeNull();
  });

  test('reports unknown parameters and bad values', () => {
    const s = parseSearch({ 'composition.patient.name': 'x', foo: 'y', 'composition.date': 'yesterday', 'processing-status': 'lost' });
    expect(s.unknown).toEqual(['foo']);
    expect(s.errors).toHaveLength(2);
    expect(s.where).toHaveLength(1);
  });

  test('handles modifiers, lists and sorting', () => {
    const s = parseSearch({ 'composition.patient.gender:not': 'male', 'composition.patient.identifier': 'urn:a|1,|2', 'composition.title:missing': 'true', _sort: '-composition.date,_id', _count: '10', _offset: '20' });
    expect(s.where[0]).toMatch(/^NOT EXISTS/);
    expect(s.where[1]).toContain('(i.sys = ? AND i.code = ?) OR (i.sys IS NULL AND i.code = ?)');
    expect(s.where[2]).toMatch(/^NOT EXISTS/);
    expect(s.orderBy).toMatch(/MIN\(i.lo\).*DESC, d.id ASC, d.id DESC/);
    expect(s.orderArgs).toEqual(['Composition', 'date']);
    expect(s.count).toBe(10);
    expect(s.offset).toBe(20);
  });

  test('the web filter becomes a FHIR search', () => {
    expect(listQueryToSearch({ name: ' smith ', gender: 'female', date: '2026-03-01', identifier: '123', status: 'submitted', _count: '20' })).toEqual({
      'composition.patient.name:contains': 'smith', 'composition.patient.gender': 'female', 'composition.date': '2026-03-01',
      'processing-status': 'submitted', _count: '20'
    });
  });
});

describe('the FHIR API', () => {
  let app;
  let mod;
  beforeEach(async () => {
    ({ app, mod } = await makeApp());
    mod.store.createProject('demo', 'Demo Project', 'For testing');
  });
  afterEach(() => mod.shutdown());

  test('unknown projects are 404', async () => {
    expect((await post(app, 'nope', ips())).status).toBe(404);
    expect((await request(app).get('/ips/nope')).status).toBe(404);
    expect((await request(app).get('/ips/nope').set('Accept', 'text/html')).status).toBe(404);
    expect((await request(app).get('/ips/admin').set('Accept', 'text/html')).status).toBe(404);
  });

  test('stores a document with a serial id and lastUpdated, and returns it', async () => {
    const res = await post(app, 'demo', ips());
    expect(res.status).toBe(201);
    expect(res.headers.location).toMatch(/\/ips\/demo\/Bundle\/1$/);
    expect(res.body.resourceType).toBe('Bundle');
    expect(res.body.id).toBe('1');
    expect(Object.keys(res.body).slice(0, 3)).toEqual(['resourceType', 'id', 'meta']);
    expect(res.body.meta.lastUpdated).toBeDefined();
    expect(res.body.entry).toHaveLength(4);
    const second = await post(app, 'demo', ips());
    expect(second.body.id).toBe('2');

    const read = await request(app).get('/ips/demo/Bundle/1');
    expect(read.status).toBe(200);
    expect(read.headers['content-type']).toMatch(/application\/fhir\+json/);
    expect(read.body.id).toBe('1');
    expect(read.body.entry[1].resource.name[0].family).toBe('Smith');
    expect((await request(app).get('/ips/demo/Bundle/99')).status).toBe(404);
    expect((await request(app).get('/ips/demo/Bundle/abc')).status).toBe(404);
  });

  test('ids are one serial across projects, and a document is only in its own project', async () => {
    mod.store.createProject('other', 'Other', null);
    await post(app, 'demo', ips());
    const res = await post(app, 'other', ips());
    expect(res.body.id).toBe('2');
    expect((await request(app).get('/ips/demo/Bundle/2')).status).toBe(404);
    expect((await request(app).get('/ips/other/Bundle/2')).status).toBe(200);
  });

  test('honours Prefer: return', async () => {
    const minimal = await post(app, 'demo', ips(), { Prefer: 'return=minimal' });
    expect(minimal.status).toBe(201);
    expect(minimal.text).toBe('');
    const oo = await post(app, 'demo', ips(), { Prefer: 'return=OperationOutcome' });
    expect(oo.body.resourceType).toBe('OperationOutcome');
  });

  test('rejects bad submissions', async () => {
    expect((await post(app, 'demo', '{not json')).status).toBe(400);
    const r = await post(app, 'demo', { resourceType: 'Patient' });
    expect(r.status).toBe(400);
    expect(r.body.issue[0].details.text).toMatch(/Bundle, not Patient/);
    expect((await request(app).post('/ips/demo/Bundle').set('Content-Type', 'text/plain').send('x')).status).toBe(415);
    const big = await makeApp({ maxSize: 500 });
    big.mod.store.createProject('demo', 'Demo', null);
    expect((await post(big.app, 'demo', ips())).status).toBe(413);
    big.mod.shutdown();
  });

  test('also accepts application/json', async () => {
    const res = await request(app).post('/ips/demo/Bundle').set('Content-Type', 'application/json').send(ips());
    expect(res.status).toBe(201);
  });

  test('requires the project token when one is set', async () => {
    mod.store.setProjectToken(1, 'secret-token');
    expect((await post(app, 'demo', ips())).status).toBe(401);
    expect((await post(app, 'demo', ips(), { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post(app, 'demo', ips(), { Authorization: 'Bearer secret-token' })).status).toBe(201);
    expect((await post(app, 'demo', ips(), { Authorization: 'secret-token' })).status).toBe(201);
    const cs = await request(app).get('/ips/demo/metadata');
    expect(cs.body.rest[0].documentation).toMatch(/requires/);
  });

  test('searches, with chained parameters', async () => {
    await post(app, 'demo', ips());
    await post(app, 'demo', ips({ patient: { name: [{ family: 'Nguyen', given: ['Minh'] }], gender: 'male', birthDate: '1985-12-24', identifier: [{ value: 'X-77' }] }, composition: { date: '2025-11-30', title: 'Older summary' } }));
    const search = async (q) => {
      const res = await request(app).get('/ips/demo/Bundle').query(q);
      expect(res.status).toBe(200);
      return res.body;
    };
    expect((await search({})).total).toBe(2);
    expect((await search({ 'composition.patient.name': 'ngu' })).entry.map(e => e.resource.id)).toEqual(['2']);
    expect((await search({ 'composition.patient.name': 'minh' })).total).toBe(1);
    expect((await search({ 'composition.patient.name:exact': 'minh' })).total).toBe(0);
    expect((await search({ 'composition.patient.family': 'Smith', 'composition.patient.given': 'alex' })).total).toBe(1);
    expect((await search({ 'composition.patient.gender': 'male' })).total).toBe(1);
    expect((await search({ 'composition.patient.gender:not': 'male' })).total).toBe(1);
    expect((await search({ 'composition.patient.birthdate': 'lt1980' })).entry[0].resource.id).toBe('1');
    expect((await search({ 'composition.patient.birthdate': 'ge1980-01-01' })).entry[0].resource.id).toBe('2');
    expect((await search({ 'composition.patient.identifier': 'MRN-12345' })).total).toBe(1);
    expect((await search({ 'composition.patient.identifier': 'urn:oid:1.2.36.146.595.217.0.1|MRN-12345' })).total).toBe(1);
    expect((await search({ 'composition.patient.identifier': 'urn:oid:other|MRN-12345' })).total).toBe(0);
    expect((await search({ 'composition.subject.identifier': '|X-77' })).total).toBe(1);
    expect((await search({ 'composition.date': '2026-03-01' })).total).toBe(1);
    expect((await search({ 'composition.date': '2026' })).total).toBe(1);
    expect((await search({ 'composition.date': 'le2025-12-31' })).total).toBe(1);
    expect((await search({ 'composition.title': 'older' })).total).toBe(1);
    expect((await search({ 'composition.type': 'http://loinc.org|60591-5' })).total).toBe(2);
    expect((await search({ 'composition.section': '48765-2' })).total).toBe(2);
    expect((await search({ 'composition.patient': 'urn:uuid:pat-1' })).total).toBe(2);
    expect((await search({ 'composition.patient': 'Patient/pat-1' })).total).toBe(0);
    expect((await search({ composition: 'Composition/comp-1' })).total).toBe(2);
    expect((await search({ composition: 'comp-1' })).total).toBe(2);
    expect((await search({ identifier: 'doc-1' })).total).toBe(2);
    expect((await search({ type: 'document' })).total).toBe(2);
    expect((await search({ _id: '2' })).total).toBe(1);
    expect((await search({ 'processing-status': 'submitted' })).total).toBe(2);
    expect((await search({ 'processing-status': 'processed' })).total).toBe(0);
    expect((await search({ 'composition.patient.name': 'ngu,smi' })).total).toBe(2);
    expect((await search({ 'composition.patient.address-city': 'melb' })).total).toBe(2);
    expect((await search({ 'composition.patient.email:missing': 'true' })).total).toBe(0);
    expect((await search({ _sort: 'composition.patient.birthdate' })).entry.map(e => e.resource.id)).toEqual(['1', '2']);
    expect((await search({ _sort: '-composition.patient.name' })).entry.map(e => e.resource.id)).toEqual(['2', '1']);
    expect((await search({ _sort: 'composition.date' })).entry.map(e => e.resource.id)).toEqual(['2', '1']);
    const count = await search({ _summary: 'count' });
    expect(count.total).toBe(2);
    expect(count.entry).toBeUndefined();
    const paged = await search({ _count: '1', _sort: '_id' });
    expect(paged.entry.map(e => e.resource.id)).toEqual(['1']);
    expect(paged.link.find(l => l.relation === 'next').url).toContain('_offset=1');
    expect(paged.entry[0].fullUrl).toMatch(/\/ips\/demo\/Bundle\/1$/);
  });

  test('unknown parameters are ignored with a warning, or refused when handling is strict', async () => {
    await post(app, 'demo', ips());
    const lenient = await request(app).get('/ips/demo/Bundle').query({ foo: 'bar' });
    expect(lenient.body.total).toBe(1);
    expect(lenient.body.entry.find(e => e.search.mode === 'outcome').resource.issue[0].details.text).toMatch(/foo/);
    const strict = await request(app).get('/ips/demo/Bundle').query({ foo: 'bar' }).set('Prefer', 'handling=strict');
    expect(strict.status).toBe(400);
    expect((await request(app).get('/ips/demo/Bundle').query({ 'composition.date': 'tomorrow' })).status).toBe(400);
  });

  test('metadata describes the project', async () => {
    const res = await request(app).get('/ips/demo/metadata');
    expect(res.status).toBe(200);
    expect(res.body.resourceType).toBe('CapabilityStatement');
    expect(res.body.fhirVersion).toBe('4.0.1');
    expect(res.body.implementation.url).toMatch(/\/ips\/demo$/);
    const names = res.body.rest[0].resource[0].searchParam.map(p => p.name);
    expect(names).toEqual(expect.arrayContaining(['_id', 'composition', 'composition.date', 'composition.patient.name']));
  });

  test('counts requests', async () => {
    await post(app, 'demo', ips());
    await request(app).get('/ips/demo/Bundle/1');
    expect(mod.stats.counts).toMatchObject({ create: 1, read: 1 });
  });
});

describe('the web pages', () => {
  let app;
  let mod;
  beforeEach(async () => {
    ({ app, mod } = await makeApp());
    mod.store.createProject('demo', 'Demo Project', 'For <testing>');
    await post(app, 'demo', ips());
    await post(app, 'demo', ips({ patient: { name: [{ family: 'Nguyen', given: ['Minh'] }], gender: 'male', birthDate: '1985-12-24', identifier: [{ value: 'X-77' }] }, composition: { date: '2025-11-30', title: 'Older summary' } }));
  });
  afterEach(() => mod.shutdown());

  const html = (url) => request(app).get(url).set('Accept', 'text/html');

  test('the root lists the projects', async () => {
    const res = await html('/ips');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Demo Project');
    expect(res.text).toContain('For &lt;testing&gt;');
    expect(res.text).toContain('href="/ips/login"');
  });

  test('the project page lists and filters documents', async () => {
    const all = await html('/ips/demo');
    expect(all.status).toBe(200);
    // the nav bar links to the project
    expect(all.text).toContain('<a href="/ips" style="color: gold">IPS</a> &nbsp;|&nbsp; <a href="/ips/demo" style="color: gold">Demo Project</a>');
    expect((await html('/ips')).text).not.toContain('style="color: gold">Demo Project');
    expect(all.text).toContain('2 documents');
    expect(all.text).toContain('Jane Alexandra Smith');
    expect(all.text).toContain('Minh Nguyen');
    expect(all.text).not.toContain('delete');
    // the banner, the actions, the search box and the documentation at the foot
    expect(all.text).toContain('<div class="ips-banner"><div class="ips-project-name"><b>Demo Project</b></div>');
    expect(all.text).toContain('<a class="btn btn-primary" href="/ips/demo/submit">Submit a document</a>');
    expect(all.text).not.toContain('/ips/demo/settings');
    expect(all.text).toContain('<form method="get" action="/ips/demo" class="ips-filter ips-search mb-3">');
    expect(all.text).toContain('<a href="/ips/demo/metadata">CapabilityStatement</a>');
    expect(all.text).toContain('<code>POST /ips/demo/Bundle</code></td><td>submit a document; the response');
    expect(all.text.indexOf('<h4>Documentation</h4>')).toBeGreaterThan(all.text.indexOf('Minh Nguyen'));
    mod.store.setProjectToken(1, 'secret-token');
    expect((await html('/ips/demo')).text).toContain('submit a document (this project requires a token: <code>Authorization: Bearer {token}</code>)');
    mod.store.setProjectToken(1, null);
    const { agent } = await loginAs(app, 'admin', 'admin-secret');
    expect((await agent.get('/ips/demo').set('Accept', 'text/html')).text).toContain('<a class="btn btn-default" href="/ips/demo/settings">Settings</a>');
    expect((await html('/ips/demo?name=ngu')).text).toContain('1-1 of 1 document');
    expect((await html('/ips/demo?gender=female')).text).toContain('1-1 of 1 document');
    expect((await html('/ips/demo?date=2026-03-01')).text).toContain('1-1 of 1 document');
    expect((await html('/ips/demo?identifier=MRN')).text).toContain('1-1 of 1 document');
    // '2' is in the second document's id, and in the first patient's MRN
    expect((await html('/ips/demo?identifier=2')).text).toContain('1-2 of 2 documents');
    expect((await html('/ips/demo?identifier=1')).text).toContain('1-1 of 1 document');
    expect((await html('/ips/demo?identifier=345')).text).toContain('1-1 of 1 document');
    expect((await html('/ips/demo?identifier=X-7&gender=male')).text).toContain('1-1 of 1 document');
    expect((await html('/ips/demo?status=processed')).text).toContain('0-0 of 0 documents');
    expect((await html('/ips/demo?composition.title=older')).text).toContain('1-1 of 1 document');
    // a bad value shows everything, with the problem
    const bad = await html('/ips/demo?date=soon');
    expect(bad.text).toContain('2 documents');
    expect(bad.text).toContain('not a valid date');
    // GET Bundle with Accept: text/html is the same page
    expect((await html('/ips/demo/Bundle?name=ngu')).text).toContain('1-1 of 1 document');
  });

  test('a document is shown as its assembled narrative, or as JSON', async () => {
    const page = await html('/ips/demo/Bundle/1');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Summary for <b>Jane Smith</b>');
    expect(page.text).toContain('Allergies and Intolerances');
    expect(page.text).toContain('<td>Penicillin</td>');
    expect(page.text).toContain('No known medications');
    expect(page.text).toContain('<span class="ips-step ips-step-waiting" title="validation - waiting">');
    expect(page.text).toContain('<li class="active"><a href="/ips/demo/Bundle/1?view=narrative">Narrative</a></li>');
    expect(page.text).toContain('<a href="/ips/demo/Bundle/1?download=1">Download</a>');
    expect(page.text).not.toContain('Process again');
    const term = await html('/ips/demo/Bundle/1?view=terminology');
    expect(term.text).toContain('<li class="active"><a href="/ips/demo/Bundle/1?view=terminology">Terminology</a></li>');
    expect(term.text).toContain('<code>AllergyIntolerance.code</code>');
    expect(term.text).not.toContain('<code>Composition.type</code>');
    expect(term.text).toContain('>Allergies and Intolerances</th>');
    expect(term.text).toContain('<a href="https://browser.ihtsdotools.org/" title="http://snomed.info/sct">SNOMED CT</a>');
    expect(term.text).not.toContain('CodeSystem?url=');
    const json = await html('/ips/demo/Bundle/1?view=json');
    expect(json.text).toContain('<pre class="ips-json">{\n  &quot;resourceType&quot;: &quot;Bundle&quot;');
    expect((await html('/ips/demo/Bundle/9')).status).toBe(404);
    const dl = await request(app).get('/ips/demo/Bundle/1?download=1').set('Accept', 'text/html');
    expect(dl.headers['content-type']).toMatch(/fhir\+json/);
    expect(dl.headers['content-disposition']).toBe('attachment; filename="ips-demo-1.json"');
    expect(dl.body.resourceType).toBe('Bundle');
    const fhir = await request(app).get('/ips/demo/Bundle/1?_format=json').set('Accept', 'text/html');
    expect(fhir.headers['content-type']).toMatch(/fhir\+json/);
  });

  test('documents can be submitted through the form', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/ips/demo/submit');
    expect(page.status).toBe(200);
    expect(page.text).toContain('name="bundle"');
    expect(page.text).not.toContain('name="token"');
    // no login: no CSRF token, and no session started for the visitor
    expect(page.text).not.toContain('name="_csrf"');
    expect(page.headers['set-cookie']).toBeUndefined();
    const res = await agent.post('/ips/demo/submit').type('form').send({ bundle: JSON.stringify(ips()) });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/ips/demo/Bundle/3');
    expect(mod.store.read(3).source).toBe('form');
    const bad = await agent.post('/ips/demo/submit').type('form').send({ bundle: '{"resourceType": "Patient"}' });
    expect(bad.status).toBe(400);
    expect(bad.text).toContain('Bundle, not Patient');
    expect(bad.text).toContain('&quot;resourceType&quot;: &quot;Patient&quot;');
    // but never from another site
    const foreign = await agent.post('/ips/demo/submit').type('form').set('Origin', 'https://evil.example.org').send({ bundle: JSON.stringify(ips()) });
    expect(foreign.status).toBe(403);
  });

  test('the form needs the token when the project has one', async () => {
    mod.store.setProjectToken(1, 'tok');
    const page = await html('/ips/demo/submit');
    expect(page.text).toContain('name="token"');
    const agent = request.agent(app);
    expect((await agent.post('/ips/demo/submit').type('form').send({ bundle: JSON.stringify(ips()) })).status).toBe(401);
    expect((await agent.post('/ips/demo/submit').type('form').send({ bundle: JSON.stringify(ips()), token: 'wrong' })).status).toBe(401);
    expect((await agent.post('/ips/demo/submit').type('form').send({ bundle: JSON.stringify(ips()), token: 'tok' })).status).toBe(302);
  });
});

describe('logins, administration and management', () => {
  let app;
  let mod;
  beforeEach(async () => {
    ({ app, mod } = await makeApp());
  });
  afterEach(() => mod.shutdown());

  test('the administrator logs in with the configured login', async () => {
    expect((await loginAs(app, 'admin', 'wrong')).res.status).toBe(401);
    expect((await loginAs(app, 'root', 'admin-secret')).res.status).toBe(401);
    const { agent, res } = await loginAs(app, 'admin', 'admin-secret');
    expect(res.status).toBe(302);
    const page = await agent.get('/ips');
    expect(page.text).toContain('Logged in as <b>Administrator</b>');
    expect(page.text).toContain('/ips/admin/projects');
    await form(agent, '/ips/logout');
    expect((await agent.get('/ips/admin/projects')).status).toBe(302);
  });

  test('the administrator\'s login name is configurable, and without a password there is none', async () => {
    const other = await makeApp({ adminUsername: 'boss' });
    expect((await loginAs(other.app, 'admin', 'admin-secret')).res.status).toBe(401);
    expect((await loginAs(other.app, 'boss', 'admin-secret')).res.status).toBe(302);
    other.mod.shutdown();
    const none = await makeApp({ adminPassword: undefined });
    expect((await loginAs(none.app, 'admin', '')).res.status).toBe(401);
    none.mod.shutdown();
  });

  test('the administrator creates projects and users, and assigns managers', async () => {
    const { agent } = await loginAs(app, 'admin', 'admin-secret');
    expect((await form(agent, '/ips/admin/users', { login: 'mgr', name: 'Manager', password: 'password1' })).status).toBe(302);
    expect((await form(agent, '/ips/admin/users', { login: 'short', name: 'Short', password: 'x' })).status).toBe(400);
    expect((await form(agent, '/ips/admin/users', { login: 'admin', name: 'Impostor', password: 'password1' })).status).toBe(400);
    expect((await form(agent, '/ips/admin/users', { login: 'mgr', name: 'Again', password: 'password1' })).status).toBe(409);
    const userId = mod.store.userByLogin('mgr').id;

    expect((await form(agent, '/ips/admin/projects', { code: 'Bad Code', name: 'X' })).status).toBe(400);
    expect((await form(agent, '/ips/admin/projects', { code: 'login', name: 'X' })).status).toBe(400);
    expect((await form(agent, '/ips/admin/projects', { code: 'demo', name: '' })).status).toBe(400);
    expect((await form(agent, '/ips/admin/projects', { code: 'demo', name: 'Demo', description: 'd', manager: String(userId) })).status).toBe(302);
    expect((await form(agent, '/ips/admin/projects', { code: 'demo', name: 'Demo 2' })).status).toBe(409);
    const projects = mod.store.projects();
    expect(projects).toHaveLength(1);
    expect(projects[0].managers.map(m => m.login)).toEqual(['mgr']);
    const page = await agent.get('/ips/admin/projects');
    expect(page.text).toContain('value="' + userId + '" checked');

    // take the manager off, then put them back
    expect((await form(agent, `/ips/admin/projects/${projects[0].id}`, { name: 'Demo Renamed', description: '' })).status).toBe(302);
    expect(mod.store.projects()[0].managers).toEqual([]);
    expect(mod.store.projects()[0].name).toBe('Demo Renamed');
    await form(agent, `/ips/admin/projects/${projects[0].id}`, { name: 'Demo', manager: [String(userId)] });
    expect(mod.store.projects()[0].managers).toHaveLength(1);
    expect((await agent.get('/ips/admin/users')).text).toContain('<code>demo</code>');
  });

  test('ordinary users cannot administer', async () => {
    mod.store.createUser('u', 'User', require('bcrypt').hashSync('password1', 4));
    const { agent, res } = await loginAs(app, 'u', 'password1');
    expect(res.status).toBe(302);
    expect((await agent.get('/ips/admin/projects')).status).toBe(403);
    expect((await agent.get('/ips/admin/users')).status).toBe(403);
    expect((await form(agent, '/ips/admin/projects', { code: 'x1', name: 'X' })).status).toBe(403);
  });

  test('managers set the token and delete documents; others cannot', async () => {
    const bcrypt = require('bcrypt');
    const pid = mod.store.createProject('demo', 'Demo', null);
    mod.store.createProject('other', 'Other', null);
    const uid = mod.store.createUser('mgr', 'Manager', bcrypt.hashSync('password1', 4));
    mod.store.createUser('bystander', 'Bystander', bcrypt.hashSync('password1', 4));
    mod.store.setProjectManagers(pid, [uid]);
    await post(app, 'demo', ips());
    await post(app, 'demo', ips());

    expect((await request(app).get('/ips/demo/settings')).status).toBe(302);
    const by = (await loginAs(app, 'bystander', 'password1')).agent;
    expect((await by.get('/ips/demo/settings')).status).toBe(403);
    expect((await form(by, '/ips/demo/Bundle/1/delete')).status).toBe(403);
    expect((await by.get('/ips/demo').set('Accept', 'text/html')).text).not.toContain('/delete"');

    const mgr = (await loginAs(app, 'mgr', 'password1')).agent;
    expect((await mgr.get('/ips/other/settings')).status).toBe(403);
    const settings = await mgr.get('/ips/demo/settings');
    expect(settings.status).toBe(200);
    expect(settings.text).toContain('submissions are open');
    expect((await form(mgr, '/ips/demo/settings', { token: 'has space' })).status).toBe(400);
    expect((await form(mgr, '/ips/demo/settings', { token: 'my-token' })).status).toBe(200);
    expect(mod.store.projectByCode('demo').token).toBe('my-token');
    expect((await post(app, 'demo', ips())).status).toBe(401);
    await form(mgr, '/ips/demo/settings', { token: '', generate: '1' });
    expect(mod.store.projectByCode('demo').token).toMatch(/^[0-9a-f-]{36}$/);
    await form(mgr, '/ips/demo/settings', { token: '' });
    expect(mod.store.projectByCode('demo').token).toBeNull();

    const list = await mgr.get('/ips/demo').set('Accept', 'text/html');
    expect(list.text).toContain('/ips/demo/Bundle/1/delete');
    expect(list.text).toContain('/ips/demo/settings');
    const del = await form(mgr, '/ips/demo/Bundle/1/delete');
    expect(del.status).toBe(302);
    expect((await request(app).get('/ips/demo/Bundle/1')).status).toBe(404);
    expect((await form(mgr, '/ips/demo/Bundle/1/delete')).status).toBe(404);
    expect((await request(app).get('/ips/demo/Bundle')).body.total).toBe(1);

    // the administrator manages every project
    const admin = (await loginAs(app, 'admin', 'admin-secret')).agent;
    expect((await admin.get('/ips/demo/settings')).status).toBe(200);
    expect((await form(admin, '/ips/demo/Bundle/2/delete')).status).toBe(302);
    expect(mod.store.count()).toBe(0);
  });

  test('deleting a project deletes its documents; deleting a user drops them as a manager', async () => {
    const pid = mod.store.createProject('demo', 'Demo', null);
    const uid = mod.store.createUser('mgr', 'Manager', 'x');
    mod.store.setProjectManagers(pid, [uid]);
    await post(app, 'demo', ips());
    const { agent } = await loginAs(app, 'admin', 'admin-secret');
    await form(agent, `/ips/admin/users/${uid}/delete`);
    expect(mod.store.projects()[0].managers).toEqual([]);
    await form(agent, `/ips/admin/projects/${pid}/delete`);
    expect(mod.store.projects()).toEqual([]);
    expect(mod.store.count()).toBe(0);
    expect(mod.store.db.prepare('SELECT COUNT(*) AS n FROM ips_index').get().n).toBe(0);
  });

  test('form posts need a CSRF token once logged in', async () => {
    const { agent } = await loginAs(app, 'admin', 'admin-secret');
    const res = await agent.post('/ips/admin/projects').type('form').send({ code: 'demo', name: 'Demo' });
    expect(res.status).toBe(403);
    expect(res.text).toContain('did not come from this site');
  });
});

describe('the terminology server', () => {
  test('a path on this server is dispatched in-process', async () => {
    const { app, mod } = await makeApp({ txServer: '/tx/r4' });
    app.get('/tx/r4/CodeSystem', (req, res) => res.json({ resourceType: 'Bundle', total: 1, url: req.query.url }));
    app.post('/tx/r4/CodeSystem/\\$validate-code', (req, res) => {
      res.type('application/fhir+json').send(JSON.stringify({ resourceType: 'Parameters', echo: JSON.parse(req.body.toString()) }));
    });
    expect(mod.tx.internal).toBe(true);
    expect(mod.tx.codeSystemLink('http://hl7.org/fhir/x')).toBe('/tx/r4/CodeSystem?url=http%3A%2F%2Fhl7.org%2Ffhir%2Fx');
    const r = await mod.tx.get('/CodeSystem', { url: 'http://hl7.org/fhir/x' });
    expect(r.status).toBe(200);
    expect(r.resource).toMatchObject({ total: 1, url: 'http://hl7.org/fhir/x' });
    const v = await mod.tx.post('/CodeSystem/$validate-code', { resourceType: 'Parameters', parameter: [] });
    expect(v.resource.echo).toEqual({ resourceType: 'Parameters', parameter: [] });
    expect((await mod.tx.get('/Nowhere')).status).toBe(404);
    // and the page links code systems there
    mod.store.createProject('demo', 'Demo', null);
    const d = ips();
    d.entry[3].resource.code.coding.push({ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'PCPR' });
    await post(app, 'demo', d);
    const page = await request(app).get('/ips/demo/Bundle/1?view=terminology').set('Accept', 'text/html');
    expect(page.text).toContain('href="/tx/r4/CodeSystem?url=http%3A%2F%2Fterminology.hl7.org');
    expect(page.text).toContain('<a href="https://browser.ihtsdotools.org/" title="http://snomed.info/sct">SNOMED CT</a>');
    mod.shutdown();
  });

  test('an external server is used by URL, and other values are refused', async () => {
    const { mod } = await makeApp({ txServer: 'https://tx.fhir.org/r4/' });
    expect(mod.tx.internal).toBe(false);
    expect(mod.tx.url).toBe('https://tx.fhir.org/r4');
    expect(mod.tx.codeSystemLink('http://hl7.org/fhir/x')).toBe('https://tx.fhir.org/r4/CodeSystem?url=http%3A%2F%2Fhl7.org%2Ffhir%2Fx');
    mod.shutdown();
    await expect(makeApp({ txServer: 'tx.fhir.org' })).rejects.toThrow(/http\(s\) URL or a path/);
    const bare = new IpsModule(makeStats(), quietLog);
    await expect(bare.initialize({ database: ':memory:', txServer: '/tx/r4', processing: { enabled: false } })).rejects.toThrow(/needs the Express app/);
    bare.shutdown();
  });
});

describe('hardening', () => {
  let app;
  let mod;
  beforeEach(async () => {
    ({ app, mod } = await makeApp());
    mod.store.createProject('demo', 'Demo', null);
  });
  afterEach(() => mod.shutdown());

  test('narratives are emitted as parsed, so one cannot run into the next', async () => {
    const d = ips();
    d.entry[0].resource.text.div = '<div xmlns="http://www.w3.org/1999/xhtml"><p>hello</p><a href="';
    d.entry[0].resource.section[0].text.div = '" onmouseover="alert(1)">hover me</a>';
    expect((await post(app, 'demo', d)).status).toBe(201);
    const page = await request(app).get('/ips/demo/Bundle/1').set('Accept', 'text/html');
    expect(page.text).not.toContain('onmouseover="alert(1)">');
    expect(page.text).toContain('<p>hello</p></div></div>');
    expect(page.text).toContain('&gt;hover me');
  });

  test('a search page is cut by its byte budget, and paging follows on', async () => {
    const { MAX_PAGE_BYTES } = require('../../ips/store');
    for (let i = 0; i < 3; i++) {
      await post(app, 'demo', ips());
    }
    // pretend each document is 60% of the budget
    mod.store.db.prepare('UPDATE documents SET size = ?').run(Math.ceil(MAX_PAGE_BYTES * 0.6));
    const first = (await request(app).get('/ips/demo/Bundle').query({ _count: '10', _sort: '_id' })).body;
    expect(first.total).toBe(3);
    expect(first.entry.map(e => e.resource.id)).toEqual(['1']);
    const next = first.link.find(l => l.relation === 'next').url;
    expect(next).toContain('_offset=1');
    const second = (await request(app).get(new URL(next).pathname + new URL(next).search)).body;
    expect(second.entry.map(e => e.resource.id)).toEqual(['2']);
  });

  test('index rows per parameter and sort keys are capped', async () => {
    const { MAX_VALUES_PER_PARAM } = require('../../ips/search');
    const d = ips();
    d.entry[1].resource.identifier = Array.from({ length: MAX_VALUES_PER_PARAM + 50 }, (_, i) => ({ value: `id-${i}` }));
    await post(app, 'demo', d);
    expect(mod.store.db.prepare("SELECT COUNT(*) AS n FROM ips_index WHERE res = 'Patient' AND param = 'identifier'").get().n).toBe(MAX_VALUES_PER_PARAM);
    expect((await request(app).get('/ips/demo/Bundle').query({ _sort: '_id,_id,_id,_id,_id,_id,_id,_id' })).status).toBe(200);
    expect((await request(app).get('/ips/demo/Bundle').query({ _sort: '_id,composition.date,composition.title,composition.patient.name,composition.patient.gender,identifier' })).status).toBe(400);
  });

  test('internal errors say nothing about the inside', async () => {
    mod.store.search = () => { throw new Error('SQLITE_FULL: database or disk is full at /var/secret'); };
    const api = await request(app).get('/ips/demo/Bundle');
    expect(api.status).toBe(500);
    expect(api.text).not.toContain('secret');
    expect(api.body.issue[0].details.text).toBe('Internal error');
    const page = await request(app).get('/ips/demo').set('Accept', 'text/html');
    expect(page.status).toBe(500);
    expect(page.text).not.toContain('secret');
  });

  test('an unknown login takes a password comparison too, and control characters stay out of the log', async () => {
    const logged = [];
    mod.log = { info: (m) => logged.push(m), warn() {}, error() {}, debug() {} };
    const spy = jest.spyOn(require('bcrypt'), 'compare');
    try {
      expect((await loginAs(app, 'nobody\u0007x', 'password1')).res.status).toBe(401);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(logged.some(m => m.includes("failed login for 'nobody?x'"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('verdicts in a submitted document are not shown as analysis', async () => {
    const d = ips();
    d.entry[3].resource.code.extension = [{ url: CHECK_EXTENSION, extension: [{ url: 'result', valueCode: 'in' }, { url: 'valueSet', valueCanonical: 'http://x' }] }];
    await post(app, 'demo', d);
    const page = await request(app).get('/ips/demo/Bundle/1?view=terminology').set('Accept', 'text/html');
    expect(page.text).not.toContain('ips-check-in" title=');
    expect(page.text).not.toContain('name="problems"');
  });
});

describe('the processing queue', () => {
  let app;
  let mod;
  beforeEach(async () => {
    ({ app, mod } = await makeApp());
    mod.store.createProject('demo', 'Demo', null);
  });
  afterEach(() => mod.shutdown());

  test('documents start submitted and are processed in turn', async () => {
    await post(app, 'demo', ips());
    await post(app, 'demo', ips());
    const seen = [];
    const logged = [];
    mod.log = { info: (m) => logged.push(m), warn() {}, error: (m) => logged.push('ERROR ' + m), debug() {} };
    mod.steps = [{ name: 'test', run: async (row, project) => {
      seen.push([row.id, project.code]);
      if (row.id === 2) {
        throw new Error('boom');
      }
      return 'looked at it';
    } }];
    expect(mod.store.statusCounts()).toEqual({ submitted: 2 });
    expect(await mod.processQueue()).toBe(2);
    // each step's start and end is logged
    expect(logged.filter(m => /: test /.test(m))).toEqual([
      "IPS module: document 1 ('demo'): test starting",
      expect.stringMatching(/^IPS module: document 1: test done in \d+ ms - looked at it$/),
      "IPS module: document 2 ('demo'): test starting",
      expect.stringMatching(/^ERROR IPS module: document 2: test failed after \d+ ms: boom$/)
    ]);
    expect(seen).toEqual([[1, 'demo'], [2, 'demo']]);
    expect(mod.store.read(1)).toMatchObject({ status: 'processed', status_message: 'looked at it' });
    expect(mod.store.read(2)).toMatchObject({ status: 'error', status_message: 'test: boom' });
    expect(mod.store.statusCounts('x')).toEqual({});
    expect((await request(app).get('/ips/demo/Bundle').query({ 'processing-status': 'error' })).body.total).toBe(1);
    expect(await mod.processQueue()).toBe(0);
    // with nothing to do a document is processed straight away
    mod.steps = [];
    await post(app, 'demo', ips());
    await mod.processQueue();
    expect(mod.store.read(3)).toMatchObject({ status: 'processed', status_message: null });
  });

  test('a manager can queue a document again', async () => {
    mod.steps = [];
    await post(app, 'demo', ips());
    await mod.processQueue();
    expect(mod.store.read(1).status).toBe('processed');
    const { agent } = await loginAs(app, 'admin', 'admin-secret');
    const page = await agent.get('/ips/demo/Bundle/1').set('Accept', 'text/html');
    expect(page.text).toContain('Process again');
    expect((await form(agent, '/ips/demo/Bundle/1/requeue')).status).toBe(302);
    expect(mod.store.read(1).status).toBe('submitted');
    expect((await form(agent, '/ips/demo/Bundle/7/requeue')).status).toBe(404);
  });

  test('the queue waits while the validator is starting', async () => {
    mod.steps = [];
    await post(app, 'demo', ips());
    let release;
    mod.validatorStarting = new Promise(r => { release = r; });
    expect(await mod.processQueue()).toBe(0);
    expect(mod.store.read(1).status).toBe('submitted');
    release();
    mod.validatorStarting = null;
    expect(await mod.processQueue()).toBe(1);
  });

  test('documents left processing at shutdown are queued again at startup', async () => {
    await post(app, 'demo', ips());
    mod.store.claimNext();
    expect(mod.store.read(1).status).toBe('processing');
    expect(mod.store.resetProcessing()).toBe(1);
    expect(mod.store.read(1).status).toBe('submitted');
  });
});

describe('the validation step', () => {
  let app;
  let mod;
  const outcome = {
    resourceType: 'OperationOutcome',
    issue: [
      { severity: 'error', code: 'invariant', details: { text: 'Constraint failed: dom-6' }, expression: ['Bundle.entry[1].resource'] },
      { severity: 'warning', code: 'code-invalid', diagnostics: 'Unknown code', location: ['Bundle.entry[0].resource.type', 'Line 12, Col 3'] },
      { severity: 'information', code: 'informational', details: { text: 'All OK <b>' } }
    ]
  };
  beforeEach(async () => {
    ({ app, mod } = await makeApp());
    mod.store.createProject('demo', 'Demo', null);
    mod.steps = STEPS.filter(s => s.name === 'validation');
  });
  afterEach(() => mod.shutdown());

  const fakeValidator = (running = true) => ({
    calls: [],
    isRunning: () => running,
    jarVersion: () => '6.5.0',
    async validate(resource, options) {
      this.calls.push({ resource: JSON.parse(resource), options });
      return outcome;
    },
    async stop() {}
  });

  test('validates against the IPS profile and keeps the outcome', async () => {
    mod.validator = fakeValidator();
    await post(app, 'demo', ips());
    expect(await mod.processQueue()).toBe(1);
    expect(mod.validator.calls).toHaveLength(1);
    expect(mod.validator.calls[0].resource.id).toBe('1');
    expect(mod.validator.calls[0].options).toEqual({ profiles: ['http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips'], checkIpsCodes: true, timeout: 120000 });
    expect(mod.store.read(1)).toMatchObject({ status: 'processed', status_message: 'validation: 1 error, 1 warning, 1 note' });
    const r = mod.store.readResult(1, 'validation');
    expect(r.result).toMatchObject({ profiles: ['http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips'], validatorVersion: '6.5.0', counts: { error: 1, warning: 1, information: 1, fatal: 0 } });
    expect(r.result.outcome).toEqual(outcome);
    expect(mod.store.resultSteps(1)).toEqual(['validation']);
    expect(mod.store.readResult(1, 'piqi')).toBeNull();

    // the page
    const page = await request(app).get('/ips/demo/Bundle/1?view=validation').set('Accept', 'text/html');
    expect(page.text).toContain('<li class="active"><a href="/ips/demo/Bundle/1?view=validation">Validation</a></li>');
    expect(page.text).toContain('<span class="ips-step ips-step-done" title="validation - done: validation: 1 error, 1 warning, 1 note">');
    expect(page.text).toContain('with validator 6.5.0');
    expect(page.text).toContain('<b>1 error, 1 warning, 1 note</b>');
    expect(page.text).toContain('Constraint failed: dom-6');
    expect(page.text).toContain('<button type="button" class="btn btn-default ips-btn ips-oo-toggle">Show the OperationOutcome</button></summary><pre class="ips-json">{\n  &quot;resourceType&quot;: &quot;OperationOutcome&quot;');
    // the severity colours the code; paths can break at the dots
    expect(page.text).toContain('<span class="ips-badge" style="background-color: #c82333" title="error">invariant</span></td><td class="ips-path"><code>Bundle.<wbr/>entry[1].<wbr/>resource</code></td>');
    // slashes and hyphens break too
    expect(render.renderValidation({ status: 'processed', results: { validation: { made: 'now', result: { status: 'done', counts: {}, outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', expression: ['Bundle.entry[0].resource/*Composition/ab-cd*/.identifier'] }] } } } } }))
      .toContain('<code>Bundle.<wbr/>entry[0].<wbr/>resource/<wbr/>*Composition/<wbr/>ab-<wbr/>cd*/<wbr/>.<wbr/>identifier</code>');
    expect(page.text).toContain('<span class="ips-badge" style="background-color: #d39e00" title="warning">code-invalid</span></td><td class="ips-path"><code>Bundle.<wbr/>entry[0].<wbr/>resource.<wbr/>type</code><br/><code>Line 12, Col 3</code>');
    expect(page.text).toContain('<span class="ips-badge" style="background-color: #17a2b8" title="information">informational</span>');
    expect(page.text).toContain('Unknown code');
    expect(page.text).toContain('All OK &lt;b&gt;');
    expect(page.text).toContain('name="level"');

    // hiding the lesser issues
    const warnings = await request(app).get('/ips/demo/Bundle/1?view=validation&level=warning').set('Accept', 'text/html');
    expect(warnings.text).toContain('Constraint failed: dom-6');
    expect(warnings.text).toContain('Unknown code');
    // hidden from the table (the raw OperationOutcome at the bottom still has it)
    expect(warnings.text).not.toContain('<td>All OK &lt;b&gt;</td>');
    expect(warnings.text).toContain('Showing 2 of 3 issues (warnings and above)');
    expect(warnings.text).toContain('<option value="warning" selected>');
    const errors = await request(app).get('/ips/demo/Bundle/1?view=validation&level=error').set('Accept', 'text/html');
    expect(errors.text).toContain('Constraint failed: dom-6');
    expect(errors.text).not.toContain('<td>Unknown code</td>');
    expect(errors.text).toContain('Showing 1 of 3 issues (errors and above)');
    // the summary line still counts everything
    expect(errors.text).toContain('<b>1 error, 1 warning, 1 note</b>');
    // an unknown level shows everything
    expect((await request(app).get('/ips/demo/Bundle/1?view=validation&level=bogus').set('Accept', 'text/html')).text).toContain('<td>All OK &lt;b&gt;</td>');

    // re-running replaces the result
    mod.store.requeue(1, 1);
    await mod.processQueue();
    expect(mod.validator.calls).toHaveLength(2);
    expect(mod.store.resultSteps(1)).toEqual(['validation']);
    // deleting the document deletes the result
    mod.store.delete(1, 1);
    expect(mod.store.db.prepare('SELECT COUNT(*) AS n FROM document_results').get().n).toBe(0);
  });

  test('configured profiles are used instead', async () => {
    mod.config.validator = { profiles: ['http://example.org/p'], checkIpsCodes: false };
    mod.validator = fakeValidator();
    await post(app, 'demo', ips());
    await mod.processQueue();
    expect(mod.validator.calls[0].options).toEqual({ profiles: ['http://example.org/p'], checkIpsCodes: false, timeout: 120000 });
  });

  test('without a validator the document fails processing, and the page says so', async () => {
    await post(app, 'demo', ips());
    const waiting = await request(app).get('/ips/demo/Bundle/1?view=validation').set('Accept', 'text/html');
    expect(waiting.text).toContain('waiting in the queue');
    await mod.processQueue();
    expect(mod.store.read(1)).toMatchObject({ status: 'error', status_message: 'validation: The validator is not configured (modules.ips.validator)' });
    const page = await request(app).get('/ips/demo/Bundle/1?view=validation').set('Accept', 'text/html');
    // the reason is for managers, not the public
    expect(page.text).toContain("The validation step failed (the reason is shown to the project's managers).");
    expect(page.text).not.toContain('The validator is not configured');
    const { agent } = await loginAs(app, 'admin', 'admin-secret');
    const mine = await agent.get('/ips/demo/Bundle/1?view=validation').set('Accept', 'text/html');
    expect(mine.text).toContain('The validation step failed: The validator is not configured (modules.ips.validator).');
    expect(mine.text).toContain('<span class="ips-step ips-step-failed" title="validation - failed: The validator is not configured (modules.ips.validator)">');
    expect(page.text).toContain('<span class="ips-step ips-step-failed" title="validation - failed">');
    expect(mine.text).toContain('>Process again</button>');
    mod.validator = fakeValidator(false);
    mod.store.requeue(1, 1);
    await mod.processQueue();
    expect(mod.store.read(1).status_message).toBe('validation: The validator is not running');
  });
});

describe('the terminology step', () => {
  let app;
  let mod;
  let calls;
  const VS = 'http://healthintersections.com.au/fhirsmith/ValueSet/';
  const FALLBACK = VS + 'ips-international-codes';
  const SCT = 'http://snomed.info/sct';
  beforeEach(async () => {
    ({ app, mod } = await makeApp({ txServer: '/tx/r4' }));
    calls = [];
    app.get('/tx/r4/metadata', (req, res) => res.type('application/fhir+json').send(JSON.stringify({ resourceType: 'CapabilityStatement' })));
    // a terminology server: 91936005 (penicillin allergy) is in the allergy value set, LOINC
    // codes starting 1234 are observation codes, 'intl' is in the fallback (as is any LOINC
    // code), no-known-immunizations is a vaccine code; a code of 'boom' breaks the server,
    // 'odd' gets an answer with no result. In an HL7 code system, every code but 'bad' exists
    app.post('/tx/r4/ValueSet/\\$validate-code', (req, res) => {
      const p = JSON.parse(req.body.toString());
      const coding = p.parameter.find(x => x.name === 'coding').valueCoding;
      const vs = p.parameter.find(x => x.name === 'valueSet')?.resource?.url || p.parameter.find(x => x.name === 'url')?.valueUri;
      calls.push({ vs, coding, txResources: p.parameter.filter(x => x.name === 'tx-resource').map(x => x.resource.url) });
      res.type('application/fhir+json');
      if (coding.code === 'boom') {
        return res.status(500).send(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception', details: { text: 'kaboom' } }] }));
      }
      if (coding.code === 'odd') {
        return res.send(JSON.stringify({ resourceType: 'Parameters', parameter: [] }));
      }
      const result = (vs === VS + 'ips-allergy-code' && coding.code === '91936005') ||
        (vs === VS + 'ips-observation-code' && coding.system === 'http://loinc.org' && coding.code.startsWith('1234')) ||
        (vs === VS + 'ips-vaccine' && coding.code === 'no-known-immunizations') ||
        (vs === VS + 'ips-condition-severity' && coding.code === '6736007') ||
        (vs === FALLBACK && (coding.system === 'http://loinc.org' || coding.code === 'intl' || coding.code === '91936005'));
      res.send(JSON.stringify({ resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: result }, { name: 'message', valueString: result ? 'ok' : 'nope' }, ...(coding.code === 'intl' ? [{ name: 'inactive', valueBoolean: true }] : [])] }));
    });
    app.post('/tx/r4/CodeSystem/\\$validate-code', (req, res) => {
      const p = JSON.parse(req.body.toString());
      const system = p.parameter.find(x => x.name === 'url').valueUri;
      const code = p.parameter.find(x => x.name === 'code').valueCode;
      calls.push({ system, code });
      res.type('application/fhir+json');
      res.send(JSON.stringify({ resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: code !== 'bad' }] }));
    });
    // translation: a LOINC answer 'LA-mod' translates to SNOMED 6736007 (two maps say so, one
    // of them narrower); 'intl' has no translation; 'boom' and 'tboom' break the server
    app.post('/tx/r4/ConceptMap/\\$translate', (req, res) => {
      const p = JSON.parse(req.body.toString());
      const cc = p.parameter.find(x => x.name === 'sourceCodeableConcept').valueCodeableConcept;
      const target = p.parameter.find(x => x.name === 'targetScope').valueUri;
      calls.push({ translate: cc, target, txResources: p.parameter.filter(x => x.name === 'tx-resource').map(x => x.resource.url) });
      res.type('application/fhir+json');
      if (cc.coding.some(c => c.code === 'boom' || c.code === 'tboom')) {
        return res.status(500).send(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception', details: { text: 'kaboom' } }] }));
      }
      if (cc.coding.some(c => c.code === 'LA-mod')) {
        return res.send(JSON.stringify({ resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: true },
          { name: 'match', part: [{ name: 'relationship', valueCode: 'equivalent' }, { name: 'concept', valueCoding: { system: SCT, code: '6736007', display: 'Moderate' } }, { name: 'originMap', valueCanonical: 'http://example.org/ConceptMap/loinc-sct' }] },
          { name: 'match', part: [{ name: 'equivalence', valueCode: 'wider' }, { name: 'concept', valueCoding: { system: SCT, code: '6736007' } }, { name: 'source', valueUri: 'http://example.org/ConceptMap/other' }] },
          { name: 'match', part: [{ name: 'relationship', valueCode: 'source-is-narrower-than-target' }, { name: 'concept', valueCoding: { system: SCT, code: '272141005', display: 'Severities' } }] }] }));
      }
      res.send(JSON.stringify({ resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: false }, { name: 'message', valueString: 'No ConceptMap is available' }] }));
    });
    mod.steps = STEPS.filter(s => s.name === 'terminology');
    mod.store.createProject('demo', 'Demo', null);
  });
  afterEach(() => mod.shutdown());

  const checks = (bundle) => {
    const out = {};
    const walk = (node, path) => {
      if (Array.isArray(node)) {
        node.forEach((n, i) => walk(n, `${path}[${i}]`));
      } else if (node && typeof node === 'object') {
        const ext = (node.extension || []).find(e => e.url === CHECK_EXTENSION);
        if (ext) {
          out[path] = ext.extension.find(e => e.url === 'result').valueCode;
        }
        for (const [k, v] of Object.entries(node)) {
          if (k !== 'extension') {
            walk(v, path ? `${path}.${k}` : k);
          }
        }
      }
    };
    walk(bundle, '');
    return out;
  };
  const extOf = (concept) => concept.extension.find(e => e.url === CHECK_EXTENSION).extension;
  const msg = (concept) => extOf(concept).find(e => e.url === 'message').valueString;

  // an Observation with the given code, in the medication section (the second section)
  const withObservation = (code, extra = {}, system = 'http://loinc.org') => {
    const d = ips();
    d.entry[0].resource.section[1].entry = [{ reference: 'urn:uuid:obs-1' }];
    d.entry.push({ fullUrl: 'urn:uuid:obs-1', resource: { resourceType: 'Observation', id: 'obs-1', status: 'final', code: { coding: [{ system, code }] }, ...extra } });
    return d;
  };

  test('the value sets are read at startup', () => {
    expect(mod.valueSets.loaded).toBe(true);
    expect(mod.valueSets.valueSetFor('AllergyIntolerance.code')).toBe(VS + 'ips-allergy-code');
  });

  test('checks each concept against its element\'s value set and writes the verdict into the analysed copy, leaving the master alone', async () => {
    await post(app, 'demo', withObservation('odd'));
    expect(await mod.processQueue()).toBe(1);
    const row = mod.store.read(1);
    expect(row.status).toBe('processed');
    expect(row.status_message).toBe('terminology: 1 in, 0 international only, 0 not in, 1 unknown');
    expect(checks(row.bundle)).toEqual({});
    expect(checks(row.analysed)).toEqual({
      'entry[3].resource.code': 'in',
      'entry[4].resource.code': 'unknown'
    });
    expect(extOf(row.analysed.entry[3].resource.code)).toEqual([
      { url: 'result', valueCode: 'in' },
      { url: 'valueSet', valueCanonical: VS + 'ips-allergy-code' },
      { url: 'coding', valueCoding: { system: SCT, code: '91936005', display: 'Allergy to penicillin' } },
      { url: 'message', valueString: `${SCT}|91936005 is in ${VS}ips-allergy-code` }
    ]);
    // the value set went with the request, and the coding as it is
    const c = calls.find(x => x.vs === VS + 'ips-allergy-code');
    expect(c.txResources).toEqual([]);
    expect(c.coding).toEqual({ system: SCT, code: '91936005', display: 'Allergy to penicillin' });
    // the server could not say for 'odd', against the element's value set or the fallback
    expect(calls.filter(x => x.coding?.code === 'odd').map(x => x.vs)).toEqual([VS + 'ips-observation-code', FALLBACK]);
    expect(msg(row.analysed.entry[4].resource.code)).toBe(`Could not be determined - http://loinc.org|odd in ${VS}ips-observation-code: The terminology server gave no result; http://loinc.org|odd in ${FALLBACK}: The terminology server gave no result`);
    // the JSON view is still the master
    const json = await request(app).get('/ips/demo/Bundle/1');
    expect(JSON.stringify(json.body)).not.toContain(CHECK_EXTENSION);
  });

  test('a coding that misses the element\'s value set but is international is marked so', async () => {
    const d = withObservation('intl', {}, SCT);
    await post(app, 'demo', d);
    await mod.processQueue();
    const row = mod.store.read(1);
    expect(checks(row.analysed)['entry[4].resource.code']).toBe('international');
    expect(extOf(row.analysed.entry[4].resource.code)).toEqual([
      { url: 'result', valueCode: 'international' },
      { url: 'valueSet', valueCanonical: FALLBACK },
      { url: 'coding', valueCoding: { system: SCT, code: 'intl' } },
      { url: 'message', valueString: `${SCT}|intl is in ${FALLBACK}, but not in ${VS}ips-observation-code (the code is inactive)` }
    ]);
    expect(row.status_message).toBe('terminology: 1 in, 1 international only, 0 not in, 0 unknown');
    const page = await request(app).get('/ips/demo/Bundle/1?view=terminology').set('Accept', 'text/html');
    expect(page.text).toContain(`<span class="ips-check ips-check-international" title="${SCT}|intl is in ${FALLBACK}, but not in ${VS}ips-observation-code (the code is inactive)\nValue set: ${FALLBACK}">&#9888;</span> <span class="ips-small">ips-international-codes</span>`);
  });

  test('an element with no value set of its own takes any international code, including an HL7 one', async () => {
    const d = withObservation('1234-5', {
      method: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationMethod', code: 'M' }] },
      // a code that no HL7 code system has, and a local one
      dataAbsentReason: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/x', code: 'bad' }, { system: 'http://example.org/local', code: 'zz' }] }
    });
    await post(app, 'demo', d);
    await mod.processQueue();
    const row = mod.store.read(1);
    expect(checks(row.analysed)).toEqual({
      'entry[3].resource.code': 'in',
      'entry[4].resource.code': 'in',
      'entry[4].resource.method': 'in',
      'entry[4].resource.dataAbsentReason': 'not-in'
    });
    expect(extOf(row.analysed.entry[4].resource.method)).toEqual([
      { url: 'result', valueCode: 'in' },
      { url: 'system', valueUri: 'http://terminology.hl7.org/CodeSystem/v3-ObservationMethod' },
      { url: 'coding', valueCoding: { system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationMethod', code: 'M' } },
      { url: 'message', valueString: 'http://terminology.hl7.org/CodeSystem/v3-ObservationMethod|M is a code in an HL7 terminology' }
    ]);
    // the HL7 codes were asked of their code systems, the local one of the fallback value set
    expect(calls.filter(c => c.system)).toEqual([{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationMethod', code: 'M' }, { system: 'http://terminology.hl7.org/CodeSystem/x', code: 'bad' }]);
    expect(calls.find(c => c.coding?.code === 'zz').vs).toBe(FALLBACK);
    expect(msg(row.analysed.entry[4].resource.dataAbsentReason)).toBe('No coding is in an international terminology (SNOMED CT International, LOINC, or an HL7 terminology)');
    expect(row.status_message).toBe('terminology: 3 in, 0 international only, 1 not in, 0 unknown');
    const page = await request(app).get('/ips/demo/Bundle/1?view=terminology').set('Accept', 'text/html');
    expect(page.text).toContain('>&#10003;</span> <span class="ips-small">v3-ObservationMethod</span>');
  });

  test('the resources a value set draws on go with the question', async () => {
    const d = ips();
    d.entry[0].resource.section.push({ title: 'Immunizations', code: { coding: [{ system: 'http://loinc.org', code: '11369-6' }] }, text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml"><p>None</p></div>' }, entry: [{ reference: 'urn:uuid:imm-1' }] });
    d.entry.push({ fullUrl: 'urn:uuid:imm-1', resource: { resourceType: 'Immunization', id: 'imm-1', status: 'completed', patient: { reference: 'urn:uuid:pat-1' }, vaccineCode: { coding: [{ system: 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips', code: 'no-known-immunizations' }] } } });
    await post(app, 'demo', d);
    await mod.processQueue();
    expect(checks(mod.store.read(1).analysed)['entry[4].resource.vaccineCode']).toBe('in');
    const c = calls.find(x => x.vs === VS + 'ips-vaccine');
    expect(c.txResources).toEqual(['http://hl7.org/fhir/uv/ips/ValueSet/absent-or-unknown-immunizations-uv-ips', 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips']);
  });

  test('a cross when no coding is anywhere, and a question mark when the server fails', async () => {
    // an observation with a text-only value, and a code the server breaks on
    const d = withObservation('1234-5', { valueCodeableConcept: { text: 'just text' } });
    d.entry[3].resource.code = { coding: [{ system: SCT, code: '12345' }, { system: SCT, code: 'boom' }] };
    await post(app, 'demo', d);
    await mod.processQueue();
    const row = mod.store.read(1);
    expect(checks(row.analysed)).toEqual({ 'entry[3].resource.code': 'unknown', 'entry[4].resource.code': 'in', 'entry[4].resource.valueCodeableConcept': 'not-in' });
    expect(msg(row.analysed.entry[4].resource.valueCodeableConcept)).toBe('The concept has no codings');
    expect(msg(row.analysed.entry[3].resource.code)).toMatch(/Could not be determined.*kaboom/);
    // 12345 was asked of the allergy value set and the fallback, boom of both too
    expect(calls.filter(c => c.coding?.code === '12345').map(c => c.vs)).toEqual([VS + 'ips-allergy-code', FALLBACK]);
    expect(calls.filter(c => c.coding?.code === 'boom')).toHaveLength(2);
    expect(row.status_message).toBe('terminology: 1 in, 0 international only, 1 not in, 1 unknown');
    // and a plain miss
    d.entry[3].resource.code = { coding: [{ system: SCT, code: '12345' }] };
    await post(app, 'demo', d);
    await mod.processQueue();
    const miss = mod.store.read(2);
    expect(checks(miss.analysed)['entry[3].resource.code']).toBe('not-in');
    expect(msg(miss.analysed.entry[3].resource.code)).toBe(`No coding is in ${VS}ips-allergy-code, and none is in an international terminology (SNOMED CT International, LOINC, or an HL7 terminology)`);
    expect(extOf(miss.analysed.entry[3].resource.code).find(e => e.url === 'valueSet')).toEqual({ url: 'valueSet', valueCanonical: VS + 'ips-allergy-code' });
  });

  test('the questions asked for one document are bounded, and identical concepts are asked once', async () => {
    const pipeline = require('../../ips/pipeline');
    const d = ips();
    // twenty allergies with the same (cached) code and twenty with their own
    for (let i = 0; i < 40; i++) {
      d.entry[0].resource.section[0].entry.push({ reference: `urn:uuid:a${i}` });
      d.entry.push({ fullUrl: `urn:uuid:a${i}`, resource: { resourceType: 'AllergyIntolerance', id: `a${i}`, patient: { reference: 'urn:uuid:pat-1' }, code: { coding: [{ system: SCT, code: i < 20 ? 'same' : `c${i}` }] } } });
    }
    await post(app, 'demo', d);
    await mod.processQueue();
    const row = mod.store.read(1);
    // 1 (the fixture's allergy) + 2 (same: the value set, then the fallback) + 20 x 2 = 43 questions, not 81
    expect(calls).toHaveLength(43);
    expect(row.status_message).toBe('terminology: 1 in, 0 international only, 40 not in, 0 unknown');
    expect(pipeline.MAX_CHECKS_PER_DOCUMENT).toBeGreaterThan(43);
  });

  test('the answer cache is bounded', async () => {
    const { checkConcept, MAX_CACHED_ANSWERS } = require('../../ips/pipeline');
    mod.txCache = new Map();
    for (let i = 0; i < MAX_CACHED_ANSWERS; i++) {
      mod.txCache.set(`k${i}`, { result: false });
    }
    await checkConcept(mod, { coding: [{ system: SCT, code: 'new' }] }, VS + 'ips-allergy-code');
    expect(mod.txCache.size).toBe(MAX_CACHED_ANSWERS);
    expect(mod.txCache.has('k0')).toBe(false);
    expect(mod.txCache.has(`${VS}ips-allergy-code|${SCT}||new`)).toBe(true);
    expect(mod.txCache.has(`${FALLBACK}|${SCT}||new`)).toBe(true);
    // over budget: unknown, without a question
    const n = calls.length;
    const out = await checkConcept(mod, { coding: [{ system: SCT, code: 'another' }] }, VS + 'ips-allergy-code', { left: 0 });
    expect(out.result).toBe('unknown');
    expect(out.message).toMatch(/more codes than are checked/);
    expect(calls).toHaveLength(n);
  });

  test('answers are cached across documents, and a resubmitted analysed copy is checked afresh', async () => {
    await post(app, 'demo', ips());
    await mod.processQueue();
    const n = calls.length;
    await post(app, 'demo', ips());
    await mod.processQueue();
    expect(calls.length).toBe(n);
    // resubmit the analysed copy: its old extensions are stripped, not trusted
    const analysed = mod.store.read(1).analysed;
    analysed.entry[3].resource.code.extension[0].extension[0].valueCode = 'not-in';
    await post(app, 'demo', analysed);
    await mod.processQueue();
    expect(checks(mod.store.read(3).analysed)['entry[3].resource.code']).toBe('in');
    expect(mod.store.read(3).analysed.entry[3].resource.code.extension).toHaveLength(1);
  });

  test('the terminology view shows the verdicts', async () => {
    await post(app, 'demo', withObservation('odd'));
    const before = await request(app).get('/ips/demo/Bundle/1?view=terminology').set('Accept', 'text/html');
    expect(before.text).not.toContain('ips-check-in" title=');
    expect(before.text).toContain('until the document has been processed');
    expect((await request(app).get('/ips/demo/Bundle/1?view=translation').set('Accept', 'text/html')).text).toContain('There is no translation record for this document - the document is waiting in the queue');
    await mod.processQueue();
    const page = await request(app).get('/ips/demo/Bundle/1?view=terminology').set('Accept', 'text/html');
    expect(page.text).toContain(`<span class="ips-check ips-check-in" title="${SCT}|91936005 is in ${VS}ips-allergy-code\nValue set: ${VS}ips-allergy-code">&#10003;</span> <span class="ips-small">ips-allergy-code</span>`);
    expect(page.text).toContain(`ips-check-unknown" title="Could not be determined - http://loinc.org|odd in ${VS}ips-observation-code: The terminology server gave no result; http://loinc.org|odd in ${FALLBACK}: The terminology server gave no result\nValue set: ${VS}ips-observation-code">?</span> <span class="ips-small">ips-observation-code</span>`);
    expect(page.text).not.toContain('until the document has been processed');
    // the terminology view's concept rows are unchanged by the extensions
    expect((page.text.match(/class="btn btn-default ips-copy"/g) || []).length).toBe((before.text.match(/class="btn btn-default ips-copy"/g) || []).length);
    // only the problems: the allergy (in) goes, the observation (unknown) stays, with its section
    expect(before.text).not.toContain('name="problems"');
    expect(page.text).toContain('name="problems" value="1" onchange');
    const problems = await request(app).get('/ips/demo/Bundle/1?view=terminology&problems=1').set('Accept', 'text/html');
    expect(problems.text).toContain('name="problems" value="1" checked');
    expect(problems.text).toContain('Showing 1 of 2 concepts');
    expect(problems.text).not.toContain('<code>AllergyIntolerance.code</code>');
    expect(problems.text).not.toContain('>Allergies and Intolerances</th>');
    expect(problems.text).toContain('<code>Observation.code</code>');
    expect(problems.text).toContain('>Medication Summary</th>');
    expect(problems.text).not.toContain('class="ips-section">Composition</th>');
  });

  // a Condition in the medication section (the second section), with a severity
  const withCondition = (severity) => {
    const d = ips();
    d.entry[0].resource.section[1].entry = [{ reference: 'urn:uuid:cond-1' }];
    d.entry.push({ fullUrl: 'urn:uuid:cond-1', resource: { resourceType: 'Condition', id: 'cond-1', subject: { reference: 'urn:uuid:pat-1' }, code: { coding: [{ system: SCT, code: 'intl' }] }, severity } });
    return d;
  };

  test('the translate step adds the translations of concepts that fail the check, before validation, and the check then passes', async () => {
    mod.steps = STEPS.filter(s => s.name === 'translate' || s.name === 'terminology');
    expect(STEPS.map(s => s.name)).toEqual(['translate', 'narrative', 'validation', 'terminology', 'profiles', 'ai']);
    await post(app, 'demo', withCondition({ coding: [{ system: 'http://loinc.org', code: 'LA-mod', display: 'Moderate' }] }));
    await mod.processQueue();
    const row = mod.store.read(1);
    expect(row.status).toBe('processed');
    expect(row.status_message).toBe('translate: 1 of 2 concepts translated (2 codings added); terminology: 2 in, 1 international only, 0 not in, 0 unknown');
    // the master is untouched; the analysed copy has the new codings, each saying where it came from
    expect(row.bundle.entry[4].resource.severity.coding).toHaveLength(1);
    const sev = row.analysed.entry[4].resource.severity;
    expect(sev.coding).toEqual([
      { system: 'http://loinc.org', code: 'LA-mod', display: 'Moderate' },
      { system: SCT, code: '6736007', display: 'Moderate', extension: [{ url: TRANSLATION_EXTENSION, extension: [{ url: 'server', valueUri: '/tx/r4' }, { url: 'conceptMap', valueCanonical: 'http://example.org/ConceptMap/loinc-sct' }, { url: 'relationship', valueCode: 'equivalent' }] }] },
      { system: SCT, code: '272141005', display: 'Severities', extension: [{ url: TRANSLATION_EXTENSION, extension: [{ url: 'server', valueUri: '/tx/r4' }, { url: 'relationship', valueCode: 'source-is-narrower-than-target' }] }] }
    ]);
    // the check after translation finds the translated coding
    expect(checks(row.analysed)['entry[4].resource.severity']).toBe('in');
    expect(extOf(sev).find(e => e.url === 'coding').valueCoding).toMatchObject({ system: SCT, code: '6736007' });
    // what was sent: the concept as submitted, the element's value set as the target, the value set as tx-resource
    const t = calls.filter(c => c.translate);
    expect(t.map(x => x.target)).toEqual([VS + 'ips-condition-code', VS + 'ips-condition-severity']);
    expect(t[1].translate).toEqual({ coding: [{ system: 'http://loinc.org', code: 'LA-mod', display: 'Moderate' }] });
    expect(t[1].txResources).toEqual([VS + 'ips-condition-severity']);
    // the condition's code was international only: tried, not translated; the allergy was in: not tried
    expect(t[0].translate).toEqual({ coding: [{ system: SCT, code: 'intl' }] });
    expect(calls.filter(c => c.translate && c.translate.coding[0].code === '91936005')).toHaveLength(0);
    // the page shows the translated codings
    const page = await request(app).get('/ips/demo/Bundle/1?view=terminology').set('Accept', 'text/html');
    expect(page.text).toContain('>6736007</a></code> "Moderate" <span class="ips-translated" title="translated by /tx/r4 with http://example.org/ConceptMap/loinc-sct (equivalent)">translated, equivalent</span>');
    expect(page.text).toContain('>272141005</a></code> "Severities" <span class="ips-translated" title="translated by /tx/r4 (source-is-narrower-than-target)">translated, source-is-narrower-than-target</span>');
    // the step's record, and the translation view
    const rec = mod.store.readResult(1, 'translate').result;
    expect(rec).toMatchObject({ status: 'done', server: '/tx/r4', counts: { tried: 2, translated: 1, codings: 2, failed: 0 } });
    expect(rec.entries.map(e => [e.path, e.outcome, e.target.split('/').pop(), e.ownValueSet])).toEqual([
      ['AllergyIntolerance.code', 'not-needed', 'ips-allergy-code', true],
      ['Condition.code', 'no-translation', 'ips-condition-code', true],
      ['Condition.severity', 'translated', 'ips-condition-severity', true]
    ]);
    expect(rec.entries[1]).toMatchObject({ check: { result: 'international' }, message: 'No ConceptMap is available', added: [] });
    expect(rec.entries[2].added).toEqual([
      { coding: { system: SCT, code: '6736007', display: 'Moderate' }, relationship: 'equivalent', conceptMap: 'http://example.org/ConceptMap/loinc-sct' },
      { coding: { system: SCT, code: '6736007' }, relationship: 'wider', conceptMap: 'http://example.org/ConceptMap/other', present: true },
      { coding: { system: SCT, code: '272141005', display: 'Severities' }, relationship: 'source-is-narrower-than-target', conceptMap: null }
    ]);
    const view = await request(app).get('/ips/demo/Bundle/1?view=translation').set('Accept', 'text/html');
    expect(view.text).toContain('<li class="active"><a href="/ips/demo/Bundle/1?view=translation">Translation</a></li>');
    expect(view.text).toContain('<b>1 of 2 concepts translated (2 codings added)</b>');
    expect(view.text).toContain('<td><code>Condition.severity</code></td><td><ul><li><code>LOINC|LA-mod</code> "Moderate"</li></ul></td><td><span title="http://healthintersections.com.au/fhirsmith/ValueSet/ips-condition-severity">ips-condition-severity</span></td><td><span class="ips-badge" style="background-color: #1e7e34">Translated</span></td><td>2 codings added<ul><li><code>SNOMED CT|6736007</code> "Moderate" <i>equivalent</i> from <code>http://example.org/ConceptMap/loinc-sct</code></li><li><code>SNOMED CT|6736007</code> <i>wider</i> from <code>http://example.org/ConceptMap/other</code> (already in the concept)</li><li><code>SNOMED CT|272141005</code> "Severities" <i>source-is-narrower-than-target</i></li></ul></td></tr>');
    expect(view.text).toContain('<span class="ips-badge" style="background-color: #6c757d">Not needed</span></td><td>http://snomed.info/sct|91936005 is in http://healthintersections.com.au/fhirsmith/ValueSet/ips-allergy-code</td>');
    expect(view.text).toContain('<span class="ips-badge" style="background-color: #c82333">No translation</span></td><td>No ConceptMap is available</td>');
    // the translations are cached: the same document again asks nothing
    const n = calls.length;
    await post(app, 'demo', withCondition({ coding: [{ system: 'http://loinc.org', code: 'LA-mod', display: 'Moderate' }] }));
    await mod.processQueue();
    expect(calls.length).toBe(n);
    expect(mod.store.read(2).analysed.entry[4].resource.severity.coding).toHaveLength(3);
  });

  test('a concept with no value set of its own is translated into the fallback, a failed translation is logged, and a resubmitted copy is cleaned', async () => {
    mod.steps = STEPS.filter(s => s.name === 'translate' || s.name === 'terminology');
    const logged = [];
    mod.log = { info() {}, warn: (m) => logged.push(m), error() {}, debug() {} };
    const d = withCondition({ coding: [{ system: 'http://loinc.org', code: 'boom' }] });
    d.entry[4].resource.stage = [{ type: { coding: [{ system: 'http://example.org/local', code: 'zz' }] } }];
    await post(app, 'demo', d);
    await mod.processQueue();
    const row = mod.store.read(1);
    expect(row.status).toBe('processed');
    // boom: the check could not say (unknown), so it was not translated; zz: not in, translated into the fallback (nothing came back)
    expect(row.status_message).toBe('translate: 0 of 2 concepts translated (0 codings added); terminology: 1 in, 1 international only, 1 not in, 1 unknown');
    expect(calls.filter(c => c.translate).map(c => [c.translate.coding[0].code, c.target])).toEqual([['intl', VS + 'ips-condition-code'], ['zz', FALLBACK]]);
    expect(logged).toEqual([]);
    const entries = mod.store.readResult(1, 'translate').result.entries;
    expect(entries.map(e => [e.path, e.outcome])).toEqual([['AllergyIntolerance.code', 'not-needed'], ['Condition.code', 'no-translation'], ['Condition.severity', 'not-checked'], ['Condition.stage[0].type', 'no-translation']]);
    expect(entries[3]).toMatchObject({ ownValueSet: false, target: FALLBACK });
    const view = await request(app).get('/ips/demo/Bundle/1?view=translation').set('Accept', 'text/html');
    expect(view.text).toContain('>ips-international-codes</span> <small>(fallback)</small></td>');
    expect(view.text).toContain('<span class="ips-badge" style="background-color: #fd7e14">Not checked</span></td><td>Could not be determined - ');
    // a server failure on the translation itself: logged, and the document still processed
    await post(app, 'demo', withCondition({ coding: [{ system: 'http://loinc.org', code: 'tboom' }] }));
    await mod.processQueue();
    const row2 = mod.store.read(2);
    expect(row2.status).toBe('processed');
    expect(row2.status_message).toMatch(/^translate: 0 of 2 concepts translated \(0 codings added\), 1 not translated \(see the log\); terminology/);
    expect(logged).toEqual(['IPS module: document 2: Condition.severity could not be translated: kaboom']);
    expect(mod.store.readResult(2, 'translate').result.entries[2]).toMatchObject({ outcome: 'failed', message: 'kaboom' });
    expect((await request(app).get('/ips/demo/Bundle/2?view=translation').set('Accept', 'text/html')).text).toContain('<span class="ips-badge" style="background-color: #c82333">Failed</span></td><td>kaboom</td>');
    const { translateConcept } = require('../../ips/pipeline');
    expect(await translateConcept(mod.tx, mod.valueSets, { coding: [{ system: 'http://loinc.org', code: 'tboom' }] }, VS + 'ips-condition-severity')).toEqual({ matches: [], message: 'kaboom', failed: true });
    // resubmitting an analysed copy: the translation extensions go, the codings stay
    const analysed = mod.store.read(1).analysed;
    analysed.entry[4].resource.stage[0].type.coding.push({ system: SCT, code: '91936005', extension: [{ url: TRANSLATION_EXTENSION, extension: [{ url: 'server', valueUri: 'http://elsewhere' }] }] });
    await post(app, 'demo', analysed);
    await mod.processQueue();
    const row3 = mod.store.read(3);
    expect(row3.analysed.entry[4].resource.stage[0].type.coding[1]).toEqual({ system: SCT, code: '91936005' });
  });

  test('the narrative step generates the narrative into the analysed copy, looking up displays, and the page shows it', async () => {
    app.get('/tx/r4/CodeSystem/\\$lookup', (req, res) => {
      calls.push({ lookup: `${req.query.system}|${req.query.code}` });
      res.type('application/fhir+json');
      if (req.query.code === '91936005') {
        return res.send(JSON.stringify({ resourceType: 'Parameters', parameter: [{ name: 'name', valueString: 'SNOMED CT' }, { name: 'display', valueString: 'Allergy to penicillin (looked up)' }] }));
      }
      res.status(404).send(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found' }] }));
    });
    mod.steps = STEPS.filter(s => s.name === 'narrative');
    const d = ips();
    delete d.entry[3].resource.code.text;
    delete d.entry[3].resource.code.coding[0].display;
    await post(app, 'demo', d);
    const waiting = await request(app).get('/ips/demo/Bundle/1?view=generated').set('Accept', 'text/html');
    expect(waiting.text).toContain('no generated narrative for this document - the document is waiting in the queue');
    await mod.processQueue();
    const row = mod.store.read(1);
    expect(row.status).toBe('processed');
    expect(row.status_message).toBe('narrative: 2 sections (1 display lookup)');
    // the allergy's code was looked up (the Composition's type has a display; the section codes are not shown)
    expect(calls.map(c => c.lookup).filter(Boolean)).toEqual(['http://snomed.info/sct|91936005']);
    const r = mod.store.readResult(1, 'narrative').result;
    expect(r.status).toBe('done');
    expect(r.html).toContain('<h1>Patient Summary as of 1 March 2026</h1><p class="ips-patient"><b>Jane Alexandra Smith</b>, female, DoB: 06-May 70, ( 1.2.36.146.595.217.0.1: MRN-12345 )</p>');
    expect(r.html).toContain('<h2>Allergies and Intolerances</h2><table class="ips-section"><thead><tr><th>Allergy / intolerance</th></tr></thead><tbody><tr><td>Allergy to penicillin (looked up)</td></tr></tbody></table>');
    expect(r.html).toContain('<h2>Medication Summary</h2><p class="ips-as-submitted"><i>Narrative as submitted</i></p><p>No known medications</p>');
    expect(r.sections.map(s => s.title)).toEqual(['Allergies and Intolerances', 'Medication Summary']);
    // written into the analysed copy, not the master
    expect(row.bundle.entry[0].resource.text.div).toContain('Summary for <b>Jane Smith</b>');
    expect(row.analysed.entry[0].resource.text).toEqual({ status: 'generated', div: expect.stringContaining('<p class="ips-patient"><b>Jane Alexandra Smith</b>') });
    expect(row.analysed.entry[0].resource.text.div).not.toContain('<h1>');
    expect(row.analysed.entry[0].resource.section[0].text.div).toBe('<div xmlns="http://www.w3.org/1999/xhtml"><table class="ips-section"><thead><tr><th>Allergy / intolerance</th></tr></thead><tbody><tr><td>Allergy to penicillin (looked up)</td></tr></tbody></table></div>');
    expect(row.analysed.entry[0].resource.section[1].text.div).toBe('<div xmlns="http://www.w3.org/1999/xhtml"><p class="ips-as-submitted"><i>Narrative as submitted</i></p><p>No known medications</p></div>');
    // the page
    const page = await request(app).get('/ips/demo/Bundle/1?view=generated').set('Accept', 'text/html');
    expect(page.text).toContain('<li class="active"><a href="/ips/demo/Bundle/1?view=generated">Generated Narrative</a></li>');
    expect(page.text).toContain('with 1 display lookup</p><div class="ips-narrative ips-generated"><div xmlns="http://www.w3.org/1999/xhtml"><h1>Patient Summary as of 1 March 2026</h1>');
    // the Narrative tab is still the submitted narrative
    expect((await request(app).get('/ips/demo/Bundle/1').set('Accept', 'text/html')).text).toContain('Summary for <b>Jane Smith</b>');
    // the same document again: the lookups are remembered
    const n = calls.length;
    await post(app, 'demo', d);
    await mod.processQueue();
    expect(calls.length).toBe(n);
    expect(mod.store.read(2).status_message).toBe('narrative: 2 sections');
  });

  test('without a terminology server or the value sets the step fails', async () => {
    mod.valueSets = null;
    await post(app, 'demo', ips());
    await mod.processQueue();
    expect(mod.store.read(1).status_message).toBe('terminology: The value sets have not been loaded');
    const other = await makeApp();
    other.mod.steps = STEPS.filter(s => s.name === 'terminology');
    other.mod.store.createProject('demo', 'Demo', null);
    await post(other.app, 'demo', ips());
    await other.mod.processQueue();
    expect(other.mod.store.read(1).status_message).toBe('terminology: No terminology server is configured (modules.ips.txServer)');
    other.mod.shutdown();
  });

  test('a path that nothing answers at is waited for, then reported, once, and as unknown', async () => {
    const { app: app2, mod: mod2 } = await makeApp({ txServer: '/nowhere/r4' });
    const warned = [];
    const logged = [];
    mod2.log = { info() {}, warn: (m) => warned.push(m), error: (m) => logged.push(m), debug() {} };
    mod2.steps = STEPS.filter(s => s.name === 'terminology');
    mod2.store.createProject('demo', 'Demo', null);
    await post(app2, 'demo', ips());
    await post(app2, 'demo', ips());
    // just started: the tx module may still be loading, so the documents wait
    expect(await mod2.processQueue()).toBe(0);
    expect(warned.filter(m => /nothing answers at the terminology server \/nowhere\/r4/.test(m))).toHaveLength(1);
    // past the grace period, they are processed without it
    mod2.startedAt -= 10 * 60 * 1000;
    mod2.txCheckedAt = 0;
    expect(await mod2.processQueue()).toBe(2);
    mod2.txCheckedAt = 0;
    await mod2.processQueue();
    expect(warned.filter(m => /nothing answers at the terminology server/.test(m))).toHaveLength(1);
    expect(logged.filter(m => /still nothing at the terminology server \/nowhere\/r4/.test(m))).toHaveLength(1);
    const row = mod2.store.read(1);
    expect(row.status_message).toBe('terminology: 0 in, 0 international only, 0 not in, 1 unknown');
    expect(JSON.stringify(row.analysed)).toContain('The terminology server is not configured correctly');
    expect(JSON.stringify(row.analysed)).not.toContain('/nowhere/r4');
    mod2.shutdown();
  });
});

describe('the AI assessment step', () => {
  let svc;
  let app;
  let mod;
  beforeAll(async () => { svc = await fakeService(); });
  afterAll(() => svc.server.close());
  beforeEach(async () => {
    svc.calls.length = 0;
    ({ app, mod } = await makeApp({ sessionSecret: 'the-secret', ai: { provider: 'openai', baseUrl: svc.url + '/v1', model: 'server-model', apiKey: 'server-key', dailyCap: 2, prices: { 'server-model': { input: 2, output: 10 } } } }));
    mod.steps = STEPS.filter(s => s.name === 'ai');
    mod.store.createProject('demo', 'Demo', null);
  });
  afterEach(() => mod.shutdown());

  const aiView = (id = 1) => request(app).get(`/ips/demo/Bundle/${id}?view=ai`).set('Accept', 'text/html').then(r => r.text);

  test('is off unless the project turns it on, and then uses the server account up to the daily cap', async () => {
    await post(app, 'demo', ips());
    expect(await aiView()).toContain('There is no AI assessment for this document - the document is waiting in the queue');
    await mod.processQueue();
    expect(mod.store.read(1).status_message).toBe('ai: not enabled for this project');
    expect(await aiView()).toContain('The document was not assessed: not enabled for this project.');
    expect(svc.calls).toHaveLength(0);
    // the submit page says nothing about AI
    expect((await request(app).get('/ips/demo/submit')).text).not.toContain('external AI service');
    // on
    mod.store.setProjectAi(1, { enabled: true });
    expect((await request(app).get('/ips/demo/submit')).text).toContain('Documents submitted to this project are sent to an external AI service');
    await post(app, 'demo', ips());
    await mod.processQueue();
    const row = mod.store.read(2);
    expect(row.status).toBe('processed');
    expect(row.status_message).toBe('ai: grade A, 0 findings (server-model-2026)');
    expect(svc.calls).toHaveLength(1);
    expect(svc.calls[0].auth).toBe('Bearer server-key');
    expect(svc.calls[0].body.messages[0].content).toContain('International Patient Summary');
    // the document went without its narratives
    const sent = svc.calls[0].body.messages[1].content;
    expect(sent).toContain('"resourceType":"Bundle"');
    expect(sent).not.toContain('Summary for <b>Jane Smith</b>');
    expect(svc.calls[0].body.messages[0].content).toContain('narratives have been removed');
    const r = mod.store.readResult(2, 'ai').result;
    expect(r).toMatchObject({ status: 'done', provider: 'openai', model: 'server-model-2026', account: 'server', usage: { input: 100, output: 20 }, assessment: { grade: 'A', consistency: [], missing: [], terminology: [] } });
    // 100 tokens at $2/M + 20 at $10/M (the price list matches the model's prefix)
    expect(r.cost).toBeCloseTo(0.0004, 8);
    expect(r.bytesSent).toBeGreaterThan(1000);
    const page = await aiView(2);
    expect(page).toContain('<li class="active"><a href="/ips/demo/Bundle/2?view=ai">AI Assessment</a></li>');
    expect(page).toContain("by server-model-2026 (openai, the server's account), without the narrative");
    expect(page).toContain('100 tokens in, 20 out ($0.0004)');
    expect(page).toContain('<span class="ips-badge ips-grade" style="background-color: #1e7e34">Grade A</span> Consistent (');
    expect(page).toContain('<h4>Consistency and integrity</h4><p><i>No findings</i></p>');
    expect(page).toContain("Show the model's answer</button>");
    // the cap: two a day
    await post(app, 'demo', ips());
    await mod.processQueue();
    expect(mod.store.read(3).status_message).toMatch(/^ai: grade A/);
    await post(app, 'demo', ips());
    await mod.processQueue();
    expect(mod.store.read(4).status_message).toBe("ai: the project's daily cap of 2 assessments is spent");
    expect(svc.calls).toHaveLength(2);
    // the project's own cap, and the narrative as submitted
    mod.store.setProjectAi(1, { enabled: true, dailyCap: 3, sendNarrative: true });
    await post(app, 'demo', ips());
    await mod.processQueue();
    expect(mod.store.read(5).status_message).toMatch(/^ai: grade A/);
    expect(mod.store.aiCallsSince(1, 0)).toBe(3);
    // the usage, on the settings page
    expect(mod.store.aiUsage(1, 0)).toEqual({ calls: 3, input: 300, output: 60, cost: expect.closeTo(0.0012, 8), costed: 3 });
    const { agent } = await loginAs(app, 'admin', 'admin-secret');
    const settings = await agent.get('/ips/demo/settings').set('Accept', 'text/html');
    expect(settings.text).toContain('<tr><td>Today</td><td>3</td><td>300</td><td>60</td><td>$0.0012</td></tr>');
    expect(settings.text).toContain('<tr><td>All time</td><td>3</td><td>300</td><td>60</td><td>$0.0012</td></tr>');
    const withNarrative = svc.calls[2].body;
    expect(withNarrative.messages[1].content).toContain('Summary for <b>Jane Smith</b>');
    expect(withNarrative.messages[0].content).toContain('what does the narrative say that the structured data does not back up');
    expect(await aiView(5)).toContain(', with the narrative as submitted');
  });

  test('copes with answers that are not quite JSON, and with a service that fails', async () => {
    mod.store.setProjectAi(1, { enabled: true, dailyCap: 10 });
    mod.config.ai.model = 'prose';
    await post(app, 'demo', ips());
    await mod.processQueue();
    expect(mod.store.read(1).status_message).toBe('ai: grade C, 3 findings (prose-2026)');
    const page = await aiView(1);
    expect(page).toContain('style="background-color: #d39e00">Grade C</span> Some issues</p>');
    expect(page).toContain('<tr><td><span class="ips-badge" style="background-color: #c82333">high</span></td><td>x</td><td>y</td></tr>');
    expect(page).toContain('<h4>Missing</h4><ul><li>z</li></ul>');
    expect(page).toContain('<td><span class="ips-badge" style="background-color: #d39e00">medium</span></td><td>t</td><td><code>http://snomed.info/sct|1</code></td></tr>');
    mod.config.ai.model = 'bad-json';
    await post(app, 'demo', ips());
    await mod.processQueue();
    expect(mod.store.read(2).status_message).toBe('ai: bad-json-2026 answered, but not with the expected JSON - the answer was cut off at 16384 tokens (modules.ips.ai.maxTokens) (see the AI view)');
    expect(await aiView(2)).toContain('<p><b>The model did not answer with the expected JSON.</b> Its answer was cut off at the limit of 16,384 tokens - raise <code>modules.ips.ai.maxTokens</code>. Its answer:</p><pre class="ips-json">Sure! Here you go: {&quot;grade&quot;');
    // a failure: the step fails, the document is in error, and the cap still counts the call
    mod.config.ai.model = 'boom';
    await post(app, 'demo', ips());
    await mod.processQueue();
    expect(mod.store.read(3)).toMatchObject({ status: 'error', status_message: 'ai: The AI service (openai, boom) answered HTTP 500: kaboom' });
    expect(mod.store.aiCallsSince(1, 0)).toBe(3);
    // a failed call has no usage; a service that says what it cost is believed
    expect(mod.store.aiUsage(1, 0)).toMatchObject({ calls: 3, costed: 0, cost: 0 });
    mod.config.ai.model = 'router';
    await post(app, 'demo', ips());
    await mod.processQueue();
    expect(mod.store.readResult(4, 'ai').result.cost).toBe(0.0042);
    expect(mod.store.aiUsage(1, 0)).toMatchObject({ calls: 4, costed: 1, cost: 0.0042 });
    const { agent: mgr } = await loginAs(app, 'admin', 'admin-secret');
    expect((await mgr.get('/ips/demo/settings').set('Accept', 'text/html')).text).toContain('<td>$0.0042 <small>(3 calls with no known cost)</small></td>');
    expect(await aiView(3)).toContain("The ai step failed (the reason is shown to the project's managers).");
    const { agent } = await loginAs(app, 'admin', 'admin-secret');
    expect((await agent.get('/ips/demo/Bundle/3?view=ai').set('Accept', 'text/html')).text).toContain('The ai step failed: The AI service (openai, boom) answered HTTP 500: kaboom.');
    // too big to send
    mod.config.ai.model = 'ok';
    mod.config.ai.maxBytes = 100;
    await post(app, 'demo', ips());
    await mod.processQueue();
    expect(mod.store.read(5).status_message).toMatch(/^ai: the document is too big to send \(\d+ bytes; the limit is 100\)$/);
    // no account anywhere
    delete mod.config.ai;
    await post(app, 'demo', ips());
    await mod.processQueue();
    expect(mod.store.read(6).status_message).toBe('ai: no AI account: the project has none and the server has no default (modules.ips.ai)');
  });

  test('a project keeps its own account, through the settings page, with the key encrypted', async () => {
    const { agent } = await loginAs(app, 'admin', 'admin-secret');
    const page = await agent.get('/ips/demo/settings').set('Accept', 'text/html');
    expect(page.text).toContain('<h3>AI assessment</h3>');
    expect(page.text).toContain('This server has a default account (server-model)');
    expect(page.text).toContain('Currently: <b>off</b>, using the server\'s default account</p>');
    // bad input
    expect((await form(agent, '/ips/demo/settings', { form: 'ai', enabled: '1', provider: 'anthropic', model: 'claude', apiKey: 'sk-own', dailyCap: 'lots' })).status).toBe(400);
    expect((await form(agent, '/ips/demo/settings', { form: 'ai', enabled: '1', provider: 'anthropic', model: 'claude', apiKey: 'sk-own', baseUrl: 'nope' })).status).toBe(400);
    expect((await form(agent, '/ips/demo/settings', { form: 'ai', enabled: '1', provider: 'anthropic', model: '', apiKey: 'sk-own' })).status).toBe(400);
    // the account
    const saved = await form(agent, '/ips/demo/settings', { form: 'ai', enabled: '1', provider: 'anthropic', baseUrl: svc.url, model: 'claude', apiKey: 'sk-own', dailyCap: '5', narrative: 'send' });
    expect(saved.status).toBe(200);
    expect(saved.text).toContain('The AI assessment settings have been saved');
    expect(saved.text).toContain("Currently: <b>on</b>, with the project's own account (Anthropic (Messages API), model <code>claude</code>)");
    expect(saved.text).toContain('leave blank to keep the current key');
    const stored = mod.store.projectAi(mod.store.projectById(1));
    expect(stored).toMatchObject({ enabled: true, provider: 'anthropic', model: 'claude', dailyCap: 5, sendNarrative: true });
    expect(saved.text).toContain('<option value="send" selected>');
    expect(stored.keyEnc.startsWith('v1:')).toBe(true);
    expect(JSON.stringify(mod.store.projectById(1))).not.toContain('sk-own');
    expect(mod.aiAccountFor(mod.store.projectById(1))).toEqual({ account: { provider: 'anthropic', baseUrl: svc.url, model: 'claude', apiKey: 'sk-own' }, source: 'project' });
    await post(app, 'demo', ips());
    await mod.processQueue();
    expect(mod.store.read(1).status_message).toBe('ai: grade A, 0 findings (claude)');
    expect(svc.calls[0]).toMatchObject({ shape: 'anthropic', key: 'sk-own' });
    expect(await aiView(1)).toContain("by claude (anthropic, the project's account)");
    // a save with no key keeps the key; forgetting it goes back to the server's
    await form(agent, '/ips/demo/settings', { form: 'ai', enabled: '1', provider: 'anthropic', baseUrl: svc.url, model: 'claude', apiKey: '', dailyCap: '' });
    expect(mod.store.projectAi(mod.store.projectById(1)).keyEnc).toBe(stored.keyEnc);
    expect(mod.store.projectAi(mod.store.projectById(1)).dailyCap).toBeUndefined();
    await form(agent, '/ips/demo/settings', { form: 'ai', enabled: '1', provider: 'anthropic', model: 'claude', clearKey: '1' });
    expect(mod.store.projectAi(mod.store.projectById(1)).keyEnc).toBeNull();
    expect(mod.aiAccountFor(mod.store.projectById(1)).source).toBe('server');
    // a key the server can't read any more: the server's default, with a warning
    mod.store.setProjectAi(1, { enabled: true, provider: 'openai', model: 'm', keyEnc: 'v1:AAAA:AAAA:AAAA' });
    const logged = [];
    mod.log = { info() {}, warn: (m) => logged.push(m), error() {}, debug() {} };
    expect(mod.aiAccountFor(mod.store.projectById(1)).source).toBe('server');
    expect(logged[0]).toMatch(/AI key for 'demo' cannot be read/);
    // without a secret, keys can't be kept
    mod.aiSecret = null;
    expect((await form(agent, '/ips/demo/settings', { form: 'ai', enabled: '1', provider: 'openai', model: 'm', apiKey: 'sk-x' })).status).toBe(400);
    const noSecret = await agent.get('/ips/demo/settings').set('Accept', 'text/html');
    expect(noSecret.text).toContain('This server cannot keep a key for the project');
  });
});

describe('sharing as SHL / VHL', () => {
  let app;
  let mod;
  let calls;
  const jose = require('jose');
  beforeEach(async () => {
    ({ app, mod } = await makeApp({ shl: { server: '/shl', password: 'shl-secret', days: 7, viewer: 'https://viewer.example.org/#' } }));
    calls = [];
    // a fake shl module on this app
    const entries = new Map();
    app.use('/shl', express.json({ limit: '5mb' }));
    app.post('/shl/create', (req, res) => {
      calls.push({ create: req.body, host: req.get('host') });
      if (req.body.password !== 'shl-secret') {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const uuid = `u${entries.size + 1}`;
      entries.set(uuid, { pword: 'p' + uuid, vhl: req.body.vhl, files: [] });
      res.status(201).json({ uuid, pword: 'p' + uuid, link: `https://${req.get('host')}/shl/access/${uuid}` });
    });
    app.post('/shl/upload', (req, res) => {
      calls.push({ upload: req.body });
      const e = entries.get(req.body.uuid);
      if (!e || e.pword !== req.body.pword) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      e.files = req.body.files;
      res.json({ msg: 'ok' });
    });
    app.post('/shl/sign', (req, res) => {
      calls.push({ sign: req.body });
      const label = JSON.parse(Buffer.from(req.body.url.replace(/^shlink:\/\//, ''), 'base64url').toString('utf8')).label;
      if (label.includes('boom')) {
        return res.status(500).json({ error: 'no certificate' });
      }
      res.json({ signature: 'SIGNED(' + req.body.url.length + ')' });
    });
    mod.shlEntries = entries;
    mod.store.createProject('demo', 'Demo', null);
  });
  afterEach(() => mod.shutdown());

  test('shares a document as an SHL: encrypted on the SHL server, the key in the link, the QR of the viewer link', async () => {
    await post(app, 'demo', ips());
    const page = await request(app).get('/ips/demo/Bundle/1').set('Accept', 'text/html');
    expect(page.text).toContain('<input type="hidden" name="kind" value="shl"/><button type="submit" class="btn btn-default" title="A SMART Health Link to this document, as a QR code">Share as SHL</button>');
    expect(page.text).toContain('Share as VHL</button>');
    expect(page.text).toContain('id="ips-share"');
    const r = await request(app).post('/ips/demo/Bundle/1/share').set('Origin', 'http://example.org').set('Host', 'example.org').set('Accept', 'application/json').type('form').send({ kind: 'shl' });
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('shl');
    expect(r.body.link).toBe('https://example.org/shl/access/u1');
    expect(r.body.qr).toMatch(/^<svg /);
    expect(r.body.bytes).toBeGreaterThan(1000);
    expect(r.body.text.startsWith('https://viewer.example.org/#shlink:/')).toBe(true);
    // the shlink payload: the manifest link, the key, the label
    const payload = JSON.parse(Buffer.from(r.body.text.substring(r.body.text.indexOf('shlink:/') + 8), 'base64url').toString('utf8'));
    expect(payload).toEqual({ url: 'https://example.org/shl/access/u1', flag: 'U', key: expect.any(String), label: 'Patient Health Document for Jane Alexandra Smith' });
    // what the server stored decrypts with that key to the document
    expect(calls[0]).toEqual({ create: { password: 'shl-secret', days: 7, vhl: false }, host: 'example.org' });
    const stored = mod.shlEntries.get('u1').files;
    expect(stored).toEqual([{ cnt: expect.any(String), type: 'application/fhir+json' }]);
    const jwe = Buffer.from(stored[0].cnt, 'base64').toString('utf8');
    const { plaintext, protectedHeader } = await jose.compactDecrypt(jwe, Buffer.from(payload.key, 'base64url'));
    expect(protectedHeader).toEqual({ alg: 'dir', enc: 'A256GCM', cty: 'application/fhir+json' });
    expect(JSON.parse(Buffer.from(plaintext).toString('utf8'))).toEqual(mod.store.read(1).bundle);
    expect(calls.some(c => c.sign)).toBe(false);
    // the expiry: the configured days
    expect(new Date(r.body.expires).getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    // without scripts: a page
    const html = await request(app).post('/ips/demo/Bundle/1/share').set('Origin', 'http://example.org').set('Host', 'example.org').set('Accept', 'text/html').type('form').send({ kind: 'shl' });
    expect(html.status).toBe(200);
    expect(html.text).toContain('<h3>Document 1 as an SHL</h3><div class="ips-share-code"><svg ');
    expect(html.text).toContain('<textarea class="ips-share-text" readonly rows="3">https://viewer.example.org/#shlink:/');
  });

  test('shares a document as a VHL: the link signed by the SHL server, the QR of HC1:', async () => {
    await post(app, 'demo', ips());
    const r = await request(app).post('/ips/demo/Bundle/1/share').set('Origin', 'http://example.org').set('Host', 'example.org').set('Accept', 'application/json').type('form').send({ kind: 'vhl' });
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe('vhl');
    expect(calls[0].create).toEqual({ password: 'shl-secret', days: 7, vhl: true });
    const sign = calls.find(c => c.sign).sign;
    expect(sign.url.startsWith('shlink://')).toBe(true);
    expect(r.body.text).toBe(`HC1:SIGNED(${sign.url.length})`);
    expect(r.body.qr).toMatch(/^<svg /);
    const html = await request(app).post('/ips/demo/Bundle/1/share').set('Origin', 'http://example.org').set('Host', 'example.org').set('Accept', 'text/html').type('form').send({ kind: 'vhl' });
    expect(html.text).toContain('<h3>Document 1 as a VHL</h3>');
    expect(html.text).toContain('A Verifiable Health Link, signed as the GDHCN does it');
  });

  test('reports failures, and refuses cross-site posts and unknown documents', async () => {
    await post(app, 'demo', ips());
    mod.shl.password = 'wrong';
    const r = await request(app).post('/ips/demo/Bundle/1/share').set('Origin', 'http://example.org').set('Host', 'example.org').set('Accept', 'application/json').type('form').send({ kind: 'shl' });
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: 'The SHL server answered HTTP 401 to /create' });
    mod.shl.password = 'shl-secret';
    // a signing failure
    const d = ips({ patient: { name: [{ family: 'boom' }] } });
    await post(app, 'demo', d);
    const v = await request(app).post('/ips/demo/Bundle/2/share').set('Origin', 'http://example.org').set('Host', 'example.org').set('Accept', 'application/json').type('form').send({ kind: 'vhl' });
    expect(v.status).toBe(502);
    expect(v.body.error).toBe('The SHL server answered HTTP 500 to /sign');
    expect((await request(app).post('/ips/demo/Bundle/9/share').set('Origin', 'http://example.org').set('Host', 'example.org').set('Accept', 'application/json').type('form').send({ kind: 'shl' })).status).toBe(404);
    expect((await request(app).post('/ips/demo/Bundle/1/share').set('Origin', 'http://evil.example').set('Host', 'example.org').set('Accept', 'application/json').type('form').send({ kind: 'shl' })).status).toBe(403);
    // not configured: no buttons, and the post is refused
    const other = await makeApp();
    other.mod.store.createProject('demo', 'Demo', null);
    await post(other.app, 'demo', ips());
    expect((await request(other.app).get('/ips/demo/Bundle/1').set('Accept', 'text/html')).text).not.toContain('Share as SHL');
    expect((await request(other.app).post('/ips/demo/Bundle/1/share').set('Origin', 'http://example.org').set('Host', 'example.org').set('Accept', 'application/json').type('form').send({ kind: 'shl' })).status).toBe(404);
    other.mod.shutdown();
  });

  test('the client checks its configuration', () => {
    const { ShlClient } = require('../../ips/share');
    expect(() => new ShlClient({ password: 'x' })).toThrow(/server is required/);
    expect(() => new ShlClient({ server: '/shl' })).toThrow(/password is required/);
    expect(() => new ShlClient({ server: 'ftp://x', password: 'x' })).toThrow(/http\(s\) URL or a path/);
    expect(() => new ShlClient({ server: '/shl', password: 'x' })).toThrow(/needs the app/);
    const c = new ShlClient({ server: 'https://x.org/shl/', password: 'x' });
    expect(c.url).toBe('https://x.org/shl');
    expect(c.internal).toBe(false);
    expect(c.days).toBe(100);
  });
});

describe('the editor', () => {
  let app;
  let mod;
  const minimal = () => ({
    patient: { family: 'Doe', given: 'Jo', gender: 'male', birthDate: '1980-01-01' }, document: { author: 'Dr A' },
    sections: { problems: { mode: 'data', rows: [{ code: { system: 'http://snomed.info/sct', code: '38341003', display: 'Hypertension' }, clinicalStatus: 'active' }] }, allergies: { mode: 'empty', emptyReason: 'nilknown' }, medications: { mode: 'narrative', narrative: 'none' } }
  });
  beforeEach(async () => {
    ({ app, mod } = await makeApp({ txServer: '/tx/r4' }));
    // a terminology server that is there, and expands with a filter
    app.get('/tx/r4/metadata', (req, res) => res.type('application/fhir+json').send(JSON.stringify({ resourceType: 'CapabilityStatement' })));
    app.post('/tx/r4/ValueSet/\\$expand', (req, res) => {
      const p = JSON.parse(req.body.toString());
      const filter = p.parameter.find(x => x.name === 'filter')?.valueString || '';
      const vs = p.parameter.find(x => x.name === 'valueSet')?.resource?.url;
      res.type('application/fhir+json');
      if (filter === 'boom') {
        return res.status(500).send(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception', details: { text: 'kaboom' } }] }));
      }
      if (filter === 'zzzz') {
        return res.send(JSON.stringify({ resourceType: 'ValueSet', url: vs, expansion: { total: 0 } }));
      }
      res.send(JSON.stringify({ resourceType: 'ValueSet', url: vs, expansion: { contains: [{ system: 'http://snomed.info/sct', code: '38341003', display: `Hypertension (${filter})` }, { system: 'http://snomed.info/sct', code: '1' }] } }));
    });
    mod.store.createProject('demo', 'Demo', null);
  });
  afterEach(() => mod.shutdown());

  const compose = (body, accept = 'application/json') => request(app).post('/ips/demo/compose').set('Origin', 'http://example.org').set('Host', 'example.org').set('Accept', accept).send(body);

  test('the page carries the schema and the script, and the project links to it', async () => {
    const page = await request(app).get('/ips/demo/compose').set('Accept', 'text/html');
    expect(page.status).toBe(200);
    expect(page.text).toContain('<h3>Compose a document</h3>');
    expect(page.text).toContain('<div id="ips-editor"></div>');
    expect(page.text).toContain('<script src="/ips/editor.js"></script>');
    expect(page.text).toContain('"urls":{"compose":"/ips/demo/compose","lookup":"/ips/demo/lookup","back":"/ips/demo"}');
    expect(page.text).toContain('"key":"problems"');
    expect(page.text).toContain('"needsToken":false');
    expect(page.text).toContain('"model":null');
    expect((await request(app).get('/ips/demo').set('Accept', 'text/html')).text).toContain('<a class="btn btn-default" href="/ips/demo/compose">Compose a document</a>');
    const script = await request(app).get('/ips/editor.js');
    expect(script.status).toBe(200);
    expect(script.text).toContain('window.IPS_EDITOR');
    // without a terminology server: no lookups
    const other = await makeApp();
    other.mod.store.createProject('demo', 'Demo', null);
    expect((await request(other.app).get('/ips/demo/compose').set('Accept', 'text/html')).text).toContain('"lookup":null');
    expect((await request(other.app).get('/ips/demo/lookup?vs=ips-condition-code&q=hyp')).status).toBe(503);
    other.mod.shutdown();
  });

  test('looks codes up in our value sets', async () => {
    const r = await request(app).get('/ips/demo/lookup?vs=ips-condition-code&q=hyper');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ matches: [{ system: 'http://snomed.info/sct', code: '38341003', display: 'Hypertension (hyper)' }, { system: 'http://snomed.info/sct', code: '1', display: '1' }] });
    expect((await request(app).get('/ips/demo/lookup?vs=ips-condition-code&q=h')).body).toEqual({ matches: [] });
    expect((await request(app).get('/ips/demo/lookup?vs=nonsense&q=hyper')).status).toBe(400);
    // nothing at the path: the page says so, and lookups answer 503 with the reason
    const { app: app2, mod: mod2 } = await makeApp({ txServer: '/nowhere/r4' });
    try {
      mod2.store.createProject('demo', 'Demo', null);
      const none = await request(app2).get('/ips/demo/lookup?vs=ips-condition-code&q=hyper');
      expect(none.status).toBe(503);
      expect(none.body.error).toBe('Nothing answers at the terminology server /nowhere/r4 on this server yet (modules.ips.txServer)');
      // and when it arrives (the tx module loads after this one), lookups work
      app2.get('/nowhere/r4/metadata', (req, res) => res.type('application/fhir+json').send(JSON.stringify({ resourceType: 'CapabilityStatement' })));
      app2.post('/nowhere/r4/ValueSet/\\$expand', (req, res) => res.type('application/fhir+json').send(JSON.stringify({ resourceType: 'ValueSet', expansion: { contains: [{ system: 'http://snomed.info/sct', code: '1', display: 'One' }] } })));
      mod2.txCheckedAt = 0;
      const later = await request(app2).get('/ips/demo/lookup?vs=ips-condition-code&q=hyper');
      expect(later.status).toBe(200);
      expect(later.body.matches).toEqual([{ system: 'http://snomed.info/sct', code: '1', display: 'One' }]);
    } finally {
      mod2.shutdown();
    }
    expect((await request(app).get('/ips/demo/lookup?vs=../x&q=hyper')).status).toBe(400);
    // nothing matches: an empty expansion, not a failure
    const nothing = await request(app).get('/ips/demo/lookup?vs=ips-condition-code&q=zzzz');
    expect(nothing.status).toBe(200);
    expect(nothing.body).toEqual({ matches: [] });
    const boom = await request(app).get('/ips/demo/lookup?vs=ips-condition-code&q=boom');
    expect(boom.status).toBe(502);
    expect(boom.body.error).toBe('The terminology server could not look that up (HTTP 500: kaboom)');
  });

  test('submits a composed document into the project, or hands it back', async () => {
    const r = await compose({ action: 'submit', model: minimal() });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: 1, url: '/ips/demo/Bundle/1' });
    const row = mod.store.read(1);
    expect(row.source).toBe('editor');
    expect(row.patient_name).toBe('Jo Doe');
    expect(row.bundle.entry[0].resource.section).toHaveLength(3);
    expect(mod.store.statusCounts()).toEqual({ submitted: 1 });
    // download: the document, not stored
    const d = await compose({ action: 'download', model: minimal() }, 'application/fhir+json');
    expect(d.status).toBe(200);
    expect(d.headers['content-disposition']).toBe('attachment; filename="ips.json"');
    expect(d.body.resourceType).toBe('Bundle');
    expect(mod.store.statusCounts()).toEqual({ submitted: 1 });
    // problems come back as a list
    const bad = await compose({ action: 'submit', model: { patient: {}, document: {}, sections: {} } });
    expect(bad.status).toBe(400);
    expect(bad.body.problems).toContain('The patient needs a family name');
    expect((await compose({ action: 'submit' })).body.problems).toEqual(['The model must be an object']);
    // the token, when the project has one
    mod.store.setProjectToken(1, 'tok');
    expect((await compose({ action: 'submit', model: minimal() })).status).toBe(401);
    expect((await compose({ action: 'submit', model: minimal(), token: 'tok' })).status).toBe(201);
    expect((await compose({ action: 'download', model: minimal() }, 'application/fhir+json')).status).toBe(200);
    expect((await request(app).get('/ips/demo/compose').set('Accept', 'text/html')).text).toContain('"needsToken":true');
    // cross-site: refused
    expect((await request(app).post('/ips/demo/compose').set('Origin', 'http://evil.example').set('Host', 'example.org').send({ action: 'submit', model: minimal() })).status).toBe(403);
  });

  test('edits an existing document: the page starts from it', async () => {
    await compose({ action: 'submit', model: minimal() });
    const doc = await request(app).get('/ips/demo/Bundle/1').set('Accept', 'text/html');
    expect(doc.text).toContain('<a class="btn btn-default" href="/ips/demo/compose?from=1" title="Open this document in the editor; submitting makes a new document">Edit</a>');
    const page = await request(app).get('/ips/demo/compose?from=1').set('Accept', 'text/html');
    expect(page.status).toBe(200);
    expect(page.text).toContain('<h3>Edit document 1</h3>');
    expect(page.text).toContain('"model":{"patient":{"family":"Doe","given":"Jo","gender":"male","birthDate":"1980-01-01"}');
    expect(page.text).toContain('"medications":{"mode":"narrative","narrative":"none"}');
    expect((await request(app).get('/ips/demo/compose?from=9').set('Accept', 'text/html')).status).toBe(404);
    expect((await request(app).get('/ips/demo/compose?from=x').set('Accept', 'text/html')).status).toBe(200);
  });
});

describe('clinical profiles', () => {
  let app;
  let mod;
  const L = 'http://loinc.org';
  const S = 'http://snomed.info/sct';
  const rule = `Bundle.section('${L}', '11450-4', 1, '*').entry('${S}', '38341003').exists()`;
  beforeEach(async () => {
    ({ app, mod } = await makeApp({ txServer: '/tx/r4' }));
    app.get('/tx/r4/metadata', (req, res) => res.type('application/fhir+json').send(JSON.stringify({ resourceType: 'CapabilityStatement' })));
    app.post('/tx/r4/ValueSet/\\$expand', (req, res) => {
      const p = JSON.parse(req.body.toString());
      const vs = p.parameter.find(x => x.name === 'valueSet').resource;
      const filter = p.parameter.find(x => x.name === 'filter').valueString;
      res.type('application/fhir+json').send(JSON.stringify({ resourceType: 'ValueSet', expansion: { contains: [{ system: vs.compose.include[0].system, code: '123', display: `Thing (${filter})` }] } }));
    });
  });
  afterEach(() => mod.shutdown());

  // the administrator, and the token the editor sends
  const asAdmin = async () => {
    const { agent } = await loginAs(app, 'admin', 'admin-secret');
    const page = await agent.get('/ips/StructureDefinition/new').set('Accept', 'text/html');
    expect(page.status).toBe(200);
    const csrf = JSON.parse(/window\.IPS_PROFILE = (.*?);<\/script>/.exec(page.text)[1]).csrf;
    const send = (url, body) => agent.post(url).set('Origin', 'http://example.org').set('Host', 'example.org').set('Accept', 'application/json').send({ ...body, _csrf: csrf });
    return { agent, send };
  };

  test('the administrator makes, edits, downloads, uploads and deletes them; everyone can read them', async () => {
    const { agent, send } = await asAdmin();
    const made = await send('/ips/StructureDefinition', { title: 'Cardiology referral', constraints: [{ human: 'A problem list with hypertension', expression: rule }, { human: 'At least two sections', expression: 'Bundle.entry.count() >= 2' },
      { human: 'Hypertension is active', expression: `Bundle.resources('${S}', '38341003', 'Condition').all(clinicalStatus.coding.code = 'active')` }] });
    expect(made.status).toBe(201);
    expect(made.body.url).toMatch(/^\/ips\/StructureDefinition\/profile-[a-f0-9]{12}$/);
    const id = made.body.id;
    // as FHIR, to anyone
    const sd = (await request(app).get(`/ips/StructureDefinition/${id}`).set('Host', 'example.org')).body;
    expect(sd).toMatchObject({ resourceType: 'StructureDefinition', id, url: `http://example.org/ips/StructureDefinition/${id}`, name: 'CardiologyReferral', title: 'Cardiology referral' });
    expect(sd.differential.element[0].constraint.map(c => [c.key, c.severity, c.human])).toEqual([['cp-1', 'error', 'A problem list with hypertension'], ['cp-2', 'error', 'At least two sections'], ['cp-3', 'error', 'Hypertension is active']]);
    const list = (await request(app).get('/ips/StructureDefinition')).body;
    expect(list).toMatchObject({ resourceType: 'Bundle', type: 'searchset', total: 1 });
    const dl = await request(app).get(`/ips/StructureDefinition/${id}?download=1`);
    expect(dl.headers['content-disposition']).toBe('attachment; filename="CardiologyReferral.json"');
    // the pages: the rule as words for a shaped one, the expression for the other; no editing for a visitor
    const page = await request(app).get(`/ips/StructureDefinition/${id}`).set('Accept', 'text/html');
    expect(page.text).toContain('Section <b>Problem List</b> <span class="ips-small">(LOINC 11450-4)</span> <span class="ips-pf-card-text">[1..*]</span>, with an entry <b>SNOMED CT 38341003</b>');
    expect(page.text).toContain('<code>Bundle.entry.count() &gt;= 2</code>');
    expect(page.text).toContain('<b>Condition</b> resources with the code <b>SNOMED CT 38341003</b>: <code>.all(clinicalStatus.coding.code = &#39;active&#39;)</code>');
    // in three parts, in order
    const parts = ['Required sections and entries', 'Rules about resources', 'Other rules'].map(t => page.text.indexOf(`<h4>${t}</h4>`));
    expect(parts.every(i => i > 0) && parts[0] < parts[1] && parts[1] < parts[2]).toBe(true);
    expect(page.text).not.toContain('/edit');
    expect(page.text).not.toContain('cp-1');
    const home = await request(app).get('/ips').set('Accept', 'text/html');
    expect(home.text).toContain('<a href="/ips/StructureDefinition">Clinical profiles</a>');
    const listPage = await request(app).get('/ips/StructureDefinition').set('Accept', 'text/html');
    expect(listPage.text).toContain('Cardiology referral');
    expect(listPage.text).not.toContain('New profile');
    // the administrator's editor gets the shapes
    const editor = await agent.get(`/ips/StructureDefinition/${id}/edit`).set('Accept', 'text/html');
    const cfg = JSON.parse(/window\.IPS_PROFILE = (.*?);<\/script>/.exec(editor.text)[1]);
    expect(cfg.profile.constraints[0]).toMatchObject({ key: 'cp-1', shape: { section: { system: L, code: '11450-4', min: 1, max: '*' }, entry: { system: S, code: '38341003', min: null, max: null } } });
    expect(cfg.profile.constraints[1].shape).toBeNull();
    expect(cfg.profile.constraints[1].rshape).toBeNull();
    expect(cfg.profile.constraints[2].rshape).toEqual({ type: 'Condition', system: S, code: '38341003', rest: ".all(clinicalStatus.coding.code = 'active')" });
    expect(cfg.parts.map(p => p[0])).toEqual(['section', 'resource', 'other']);
    expect(cfg.resourceTypes).toContain('Condition');
    expect(cfg.sections[0]).toEqual({ code: '11450-4', title: 'Problem List' });
    expect(cfg.urls).toEqual({ save: `/ips/StructureDefinition/${id}`, lookup: '/ips/lookup', lookupVs: '/ips/lookup-vs', back: `/ips/StructureDefinition/${id}` });
    // an edit keeps the url and the kept keys
    const saved = await send(`/ips/StructureDefinition/${id}`, { title: 'Cardiology referral v2', constraints: [{ key: 'cp-2', human: 'At least two sections', expression: 'Bundle.entry.count() >= 2' }, { human: 'Medications', expression: `Bundle.section('${L}', '10160-0', 1, 1).exists()` }] });
    expect(saved.status).toBe(200);
    const after = mod.store.profile(id.substring(8));
    expect(after.url).toBe(sd.url);
    expect(after.name).toBe('CardiologyReferralV2');
    expect(after.differential.element[0].constraint.map(c => c.key)).toEqual(['cp-2', 'cp-4']);
    // problems come back, and nothing changes
    const bad = await send(`/ips/StructureDefinition/${id}`, { title: '', constraints: [{ human: 'x', expression: 'Bundle.(' }] });
    expect(bad.status).toBe(422);
    expect(bad.body.problems[0]).toBe('The profile needs a title');
    expect(mod.store.profile(id.substring(8)).title).toBe('Cardiology referral v2');
    // an upload makes a new one, with its own id and url
    const up = await send('/ips/StructureDefinition', { upload: dl.body });
    expect(up.status).toBe(201);
    expect(up.body.id).not.toBe(id);
    const copy = (await request(app).get(`/ips/StructureDefinition/${up.body.id}`).set('Host', 'example.org')).body;
    expect(copy.url).toBe(`http://example.org/ips/StructureDefinition/${up.body.id}`);
    expect(copy.differential.element[0].constraint.map(c => [c.key, c.human])).toEqual([['cp-1', 'A problem list with hypertension'], ['cp-2', 'At least two sections'], ['cp-3', 'Hypertension is active']]);
    const rejected = await send('/ips/StructureDefinition', { upload: { ...dl.body, snapshot: { element: [] } } });
    expect(rejected.status).toBe(422);
    expect(rejected.body.problems[0]).toMatch(/snapshot/);
    expect((await send(`/ips/StructureDefinition/${id}`, { upload: dl.body })).status).toBe(400);
    // delete
    const del = await form(agent, `/ips/StructureDefinition/${id}/delete`);
    expect(del.status).toBe(302);
    expect((await request(app).get(`/ips/StructureDefinition/${id}`)).status).toBe(404);
    expect((await request(app).get('/ips/StructureDefinition/profile-nothere')).status).toBe(404);
  });

  test('profiles stored on Composition are moved onto Bundle when the module starts', async () => {
    const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ips-pf-'));
    const db = require('path').join(dir, 'ips.db');
    const first = await makeApp({ database: db });
    const old = profiles.build({ id: 'abcdef012345', url: 'http://x/sd', title: 'Old', constraints: [{ key: 'cp-1', human: 'Problems', expression: `Composition.section('${L}', '11450-4').exists()` }] });
    old.type = 'Composition';
    old.baseDefinition = 'http://hl7.org/fhir/StructureDefinition/Composition';
    first.mod.store.saveProfile('abcdef012345', old);
    first.mod.shutdown();
    const second = await makeApp({ database: db });
    try {
      const sd = second.mod.store.profile('abcdef012345');
      expect(sd.type).toBe('Bundle');
      expect(sd.differential.element[0].constraint[0].expression).toBe(`Bundle.section('${L}', '11450-4').exists()`);
    } finally {
      second.mod.shutdown();
      require('fs').rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the browser scripts come from memory, with an ETag', async () => {
    for (const name of ['editor.js', 'profile-editor.js']) {
      const r = await request(app).get(`/ips/${name}`);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/^application\/javascript/);
      expect(r.headers['cache-control']).toBe('public, max-age=3600');
      expect(r.text).toBe(require('fs').readFileSync(require('path').join(__dirname, '../../ips', name), 'utf8'));
      const again = await request(app).get(`/ips/${name}`).set('If-None-Match', r.headers.etag);
      expect(again.status).toBe(304);
    }
  });

  test('only the administrator changes them, or looks codes up', async () => {
    expect((await request(app).post('/ips/StructureDefinition').send({ title: 'x', constraints: [] })).status).toBe(403);
    const visitor = request.agent(app);
    expect((await visitor.get('/ips/StructureDefinition/new')).status).toBe(302);
    expect((await visitor.get('/ips/lookup?system=http://snomed.info/sct&q=asth')).status).toBe(401);
    mod.store.createUser('jo', 'Jo', await require('bcrypt').hash('jo-secret', 4));
    const { agent } = await loginAs(app, 'jo', 'jo-secret');
    expect((await agent.get('/ips/StructureDefinition/new')).status).toBe(403);
    expect((await agent.get('/ips/lookup?system=http://snomed.info/sct&q=asth')).status).toBe(403);
  });

  test('the administrator finds value sets: ours first, then the terminology server\'s', async () => {
    const searches = [];
    app.get('/tx/r4/ValueSet', (req, res) => {
      searches.push(req.query);
      const all = [{ url: 'http://hl7.org/fhir/uv/ips/ValueSet/problems-uv-ips', version: '1.1.0', title: 'Problems - IPS' }, { url: 'http://x.org/vs/conditions', title: 'Some conditions' }];
      const hits = req.query.url ? all.filter(v => v.url === req.query.url) : all.filter(v => v.title.toLowerCase().includes(req.query.title));
      res.type('application/fhir+json').send(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', entry: hits.map(v => ({ resource: { resourceType: 'ValueSet', ...v } })) }));
    });
    const { agent } = await asAdmin();
    const ours = 'http://healthintersections.com.au/fhirsmith/ValueSet/ips-condition-code';
    const found = (await agent.get('/ips/lookup-vs?q=Condition')).body.matches;
    expect(found.find(v => v.url === ours)).toMatchObject({ own: true });
    // ours come first
    expect(found.findIndex(v => !v.own)).toBeGreaterThan(found.findIndex(v => v.url === ours));
    expect(found).toContainEqual({ url: 'http://x.org/vs/conditions', version: null, title: 'Some conditions', own: false });
    expect(searches[0]).toMatchObject({ title: 'condition', _elements: 'url,version,title,name', _count: '20' });
    // by canonical: ours is found without asking; another is asked for by url
    expect((await agent.get(`/ips/lookup-vs?url=${encodeURIComponent(ours)}`)).body.matches).toHaveLength(1);
    expect(searches).toHaveLength(1);
    const ips = (await agent.get(`/ips/lookup-vs?url=${encodeURIComponent('http://hl7.org/fhir/uv/ips/ValueSet/problems-uv-ips|1.1.0')}`)).body.matches;
    expect(ips).toEqual([{ url: 'http://hl7.org/fhir/uv/ips/ValueSet/problems-uv-ips', version: '1.1.0', title: 'Problems - IPS', own: false }]);
    expect(searches[1]).toMatchObject({ url: 'http://hl7.org/fhir/uv/ips/ValueSet/problems-uv-ips' });
    expect((await agent.get('/ips/lookup-vs?url=http://nowhere.org/vs')).body.matches).toEqual([]);
    expect((await agent.get('/ips/lookup-vs?q=a')).body.matches).toEqual([]);
    expect((await request(app).get('/ips/lookup-vs?q=Condition')).status).toBe(401);
    // a profile's value set rules, as the page shows them
    const { send } = await asAdmin();
    const made = await send('/ips/StructureDefinition', { title: 'By value set', constraints: [
      { human: 'Problems are coded', expression: `Bundle.section('${L}', '11450-4').entryIn('${ours}', 1, '*').exists()` },
      { human: 'Some IPS problem', expression: "Bundle.resourcesIn('http://hl7.org/fhir/uv/ips/ValueSet/problems-uv-ips', 'Condition').exists()" }] });
    expect(made.status).toBe(201);
    const page = await request(app).get(made.body.url).set('Accept', 'text/html');
    expect(page.text).toContain(`with entries in the value set <b>Conditions (IPS international exchange)</b> <span class="ips-small">(${ours})</span>`);
    expect(page.text).toContain('<b>Condition</b> resources with a code in the value set <b>http://hl7.org/fhir/uv/ips/ValueSet/problems-uv-ips</b>: <code>.exists()</code>');
    const editor = await agent.get(`${made.body.url}/edit`).set('Accept', 'text/html');
    const cfg = JSON.parse(/window\.IPS_PROFILE = (.*?);<\/script>/.exec(editor.text)[1]);
    expect(cfg.urls.lookupVs).toBe('/ips/lookup-vs');
    expect(cfg.profile.constraints[0].shape.entry).toEqual({ valueSet: ours, min: 1, max: '*' });
    expect(cfg.profile.constraints[1].rshape).toEqual({ type: 'Condition', valueSet: 'http://hl7.org/fhir/uv/ips/ValueSet/problems-uv-ips', rest: '.exists()' });
  });

  test('the administrator looks codes up in any code system', async () => {
    const { agent } = await asAdmin();
    const r = await agent.get('/ips/lookup?system=http://snomed.info/sct&q=asth');
    expect(r.body).toEqual({ matches: [{ system: 'http://snomed.info/sct', code: '123', display: 'Thing (asth)' }] });
    expect((await agent.get('/ips/lookup?system=not a uri&q=asth')).status).toBe(400);
    // 'lookup' is not a project
    expect(mod.store.projectByCode('lookup')).toBeFalsy();
  });
});

describe('the profiles step', () => {
  let app;
  let mod;
  const L = 'http://loinc.org';
  const VS = 'http://example.org/ValueSet/allergies';
  const add = (id, title, constraints) => {
    const sd = profiles.build({ id, url: `http://example.org/ips/StructureDefinition/profile-${id}`, title, constraints: constraints.map((c, i) => ({ key: `cp-${i + 1}`, ...c })) });
    mod.store.saveProfile(id, sd);
  };
  beforeEach(async () => {
    ({ app, mod } = await makeApp({ txServer: '/tx/r4' }));
    app.get('/tx/r4/metadata', (req, res) => res.type('application/fhir+json').send(JSON.stringify({ resourceType: 'CapabilityStatement' })));
    // membership: every coded allergy is in the allergies value set; other value sets are unknown
    app.post('/tx/r4/ValueSet/\\$validate-code', (req, res) => {
      const p = JSON.parse(req.body.toString());
      const url = p.parameter.find(x => x.name === 'url')?.valueUri;
      res.type('application/fhir+json');
      if (url !== VS) {
        return res.status(404).send(JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found', details: { text: `Unknown value set ${url}` } }] }));
      }
      res.send(JSON.stringify({ resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: true }] }));
    });
    mod.steps = STEPS.filter(s => s.name === 'profiles');
    mod.store.createProject('demo', 'Demo', null);
  });
  afterEach(() => mod.shutdown());

  test('checks the document against each profile, and the view shows it', async () => {
    add('aaaaaaaaaaa1', 'Allergies only', [
      { human: 'An allergies section', expression: `Bundle.section('${L}', '48765-2', 1, 1).exists()` },
      { human: 'Coded allergies', expression: `Bundle.section('${L}', '48765-2').entryIn('${VS}', 1, '*').exists()` }]);
    add('aaaaaaaaaaa2', 'Full summary', [
      { human: 'An allergies section', expression: `Bundle.section('${L}', '48765-2').exists()` },
      { human: 'A problem list', expression: `Bundle.section('${L}', '11450-4').exists()` },
      { human: 'At least five sections', expression: 'Bundle.section.count() >= 5' }]);
    add('aaaaaaaaaaa3', 'Problems by value set', [
      { human: 'Some known problem', expression: "Bundle.resourcesIn('http://example.org/ValueSet/unknown').exists()" }]);
    add('aaaaaaaaaaa4', 'Broken', [{ human: 'Not evaluable', expression: "Bundle.resourcesIn('nope').exists()" }]);
    await post(app, 'demo', ips());
    expect(await mod.processQueue()).toBe(1);
    const row = mod.store.read(1);
    expect(row.status).toBe('processed');
    expect(row.status_message).toBe('profiles: 1 conform, 1 do not, 2 could not be fully checked');
    const r = mod.store.readResult(1, 'profiles').result;
    const byTitle = Object.fromEntries(r.profiles.map(p => [p.title, p]));
    expect(byTitle['Allergies only']).toMatchObject({ id: 'profile-aaaaaaaaaaa1', outcome: 'conforms', constraints: 2, failed: [] });
    expect(byTitle['Full summary']).toMatchObject({ outcome: 'fails', failed: [{ key: 'cp-2', human: 'A problem list', reason: 'failed' }, { key: 'cp-3', human: 'At least five sections', reason: 'failed' }] });
    expect(byTitle['Problems by value set'].outcome).toBe('unknown');
    expect(byTitle['Problems by value set'].failed[0]).toMatchObject({ reason: 'unresolved', message: expect.stringContaining('Unknown value set http://example.org/ValueSet/unknown') });
    expect(byTitle.Broken.failed[0]).toMatchObject({ reason: 'error', message: expect.stringMatching(/must be a canonical URL/) });
    expect(r.unresolved).toEqual([{ valueSet: 'http://example.org/ValueSet/unknown', message: 'Unknown value set http://example.org/ValueSet/unknown' }]);
    // the view
    const page = await request(app).get('/ips/demo/Bundle/1?view=profiles').set('Accept', 'text/html');
    expect(page.text).toContain('<li class="active"><a href="/ips/demo/Bundle/1?view=profiles">Clinical Profiles</a></li>');
    expect(page.text).toContain('<a href="/ips/StructureDefinition/profile-aaaaaaaaaaa1">Allergies only</a></td><td><span class="ips-badge" style="background: #1e7e34">Conforms</span></td><td><span class="ips-small">(none)</span>');
    expect(page.text).toContain('Does not conform</span></td><td><ul style="margin: 0; padding-left: 18px"><li>A problem list</li><li>At least five sections</li></ul>');
    expect(page.text).toContain('<li>Some known problem <span class="ips-small">(could not be checked: a value set the terminology server could not answer for)</span></li>');
    // the reason is for managers
    expect(page.text).not.toContain('Unknown value set');
  });

  test('no profiles, and a document not yet checked', async () => {
    await post(app, 'demo', ips());
    const waiting = await request(app).get('/ips/demo/Bundle/1?view=profiles').set('Accept', 'text/html');
    expect(waiting.text).toContain('The document has not been checked against the clinical profiles - the document is waiting in the queue.');
    await mod.processQueue();
    expect(mod.store.read(1).status_message).toBe('profiles: none defined');
    const page = await request(app).get('/ips/demo/Bundle/1?view=profiles').set('Accept', 'text/html');
    expect(page.text).toContain('There were no <a href="/ips/StructureDefinition">clinical profiles</a> to check the document against when it was processed.');
  });

  test('runs after the terminology step and before the AI step', () => {
    expect(STEPS.map(s => s.name)).toEqual(['translate', 'narrative', 'validation', 'terminology', 'profiles', 'ai']);
  });
});
