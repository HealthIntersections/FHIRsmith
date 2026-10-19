const express = require('express');
const request = require('supertest');

const IpsModule = require('../../ips/ips');
const { validateDocument } = require('../../ips/ips');
const { parseSearch, indexDocument, listQueryToSearch, resolveParam } = require('../../ips/search');
const { STEPS, CHECK_EXTENSION } = require('../../ips/pipeline');
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
    processing: { enabled: false }, ipsPackage: false, ...config
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
    expect(page.text).toContain('submitted');
    expect(page.text).not.toContain('Process again');
    const term = await html('/ips/demo/Bundle/1?view=terminology');
    expect(term.text).toContain('<b>Terminology</b>');
    expect(term.text).toContain('<code>AllergyIntolerance.code</code>');
    expect(term.text).not.toContain('<code>Composition.type</code>');
    expect(term.text).toContain('>Allergies and Intolerances</th>');
    expect(term.text).toContain('<a href="https://browser.ihtsdotools.org/" title="http://snomed.info/sct">SNOMED CT</a>');
    expect(term.text).not.toContain('CodeSystem?url=');
    const json = await html('/ips/demo/Bundle/1?view=json');
    expect(json.text).toContain('&quot;resourceType&quot;: &quot;Bundle&quot;');
    expect((await html('/ips/demo/Bundle/9')).status).toBe(404);
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
    mod.steps = [{ name: 'test', run: async (row, project) => {
      seen.push([row.id, project.code]);
      if (row.id === 2) {
        throw new Error('boom');
      }
      return 'looked at it';
    } }];
    expect(mod.store.statusCounts()).toEqual({ submitted: 2 });
    expect(await mod.processQueue()).toBe(2);
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
    expect(page.text).toContain('<b>Validation</b>');
    expect(page.text).toContain('with validator 6.5.0');
    expect(page.text).toContain('<b>1 error, 1 warning, 1 note</b>');
    expect(page.text).toContain('Constraint failed: dom-6');
    expect(page.text).toContain('<code>Bundle.entry[1].resource</code>');
    expect(page.text).toContain('<code>Bundle.entry[0].resource.type</code><br/><code>Line 12, Col 3</code>');
    expect(page.text).toContain('Unknown code');
    expect(page.text).toContain('All OK &lt;b&gt;');
    expect(page.text).toContain('>error</span>');
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
    expect(page.text).toContain('no validation result');
    // the reason is for managers, not the public
    expect(page.text).toContain('processing failed.');
    expect(page.text).not.toContain('The validator is not configured');
    const { agent } = await loginAs(app, 'admin', 'admin-secret');
    const mine = await agent.get('/ips/demo/Bundle/1?view=validation').set('Accept', 'text/html');
    expect(mine.text).toContain('processing failed: validation: The validator is not configured');
    expect(mine.text).toContain('Status: <span class="ips-badge" style="background-color: #c82333">error</span> validation: The validator is not configured');
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
  const VS = 'http://hl7.org/fhir/uv/ips/ValueSet/';
  // the bindings the IPS would give, without the package
  const fakeBindings = {
    loaded: true,
    table: {
      'Composition.identifier': [],
      'AllergyIntolerance.code': [{ valueSet: VS + 'allergy-intolerance-uv-ips', strength: 'preferred' }],
      'Observation.code': [{ valueSet: VS + 'results-laboratory-observations-uv-ips', strength: 'preferred' }, { valueSet: VS + 'vital-signs', strength: 'required' }],
      'Observation.valueCodeableConcept': [{ pattern: [{ system: 'http://loinc.org', code: 'LA1' }], profile: 'http://example.org/p' }]
    },
    seen: [],
    bindingsFor(element, context) { this.seen.push([element, context]); return this.table[element] || []; },
    valueSet(url) { return url === VS + 'allergy-intolerance-uv-ips' ? { resourceType: 'ValueSet', url, compose: { include: [{ valueSet: [VS + 'inner'] }] } } : null; },
    referencedValueSets(url) { return url === VS + 'allergy-intolerance-uv-ips' ? [{ resourceType: 'ValueSet', url: VS + 'inner' }] : []; }
  };
  beforeEach(async () => {
    ({ app, mod } = await makeApp({ txServer: '/tx/r4' }));
    calls = [];
    // a terminology server: 91936005 (penicillin allergy) is in the allergy value set, a
    // code of 'boom' breaks the server, 'odd' gets an answer with no result
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
      const result = vs === VS + 'allergy-intolerance-uv-ips' && coding.code === '91936005';
      res.send(JSON.stringify({ resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: result }, { name: 'message', valueString: result ? 'ok' : 'nope' }] }));
    });
    mod.ipsBindings = fakeBindings;
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

  // an Observation with the given code, in the medication section (the second section)
  const withObservation = (code, extra = {}) => {
    const d = ips();
    d.entry[0].resource.section[1].entry = [{ reference: 'urn:uuid:obs-1' }];
    d.entry.push({ fullUrl: 'urn:uuid:obs-1', resource: { resourceType: 'Observation', id: 'obs-1', status: 'final', code: { coding: [{ system: 'http://loinc.org', code }] }, ...extra } });
    return d;
  };

  test('checks each bound concept and writes the verdict into the analysed copy, leaving the master alone', async () => {
    await post(app, 'demo', withObservation('odd'));
    expect(await mod.processQueue()).toBe(1);
    const row = mod.store.read(1);
    expect(row.status).toBe('processed');
    expect(row.status_message).toBe('terminology: 1 in, 0 not in, 1 unknown');
    expect(checks(row.bundle)).toEqual({});
    expect(checks(row.analysed)).toEqual({
      'entry[3].resource.code': 'in',
      'entry[4].resource.code': 'unknown'
    });
    // the section's code went with the question
    expect(mod.ipsBindings.seen).toEqual(expect.arrayContaining([
      ['AllergyIntolerance.code', { sectionCode: 'http://loinc.org|48765-2' }],
      ['Observation.code', { sectionCode: 'http://loinc.org|10160-0' }]
    ]));
    const allergy = row.analysed.entry[3].resource.code.extension.find(e => e.url === CHECK_EXTENSION).extension;
    expect(allergy).toEqual(expect.arrayContaining([
      { url: 'result', valueCode: 'in' },
      { url: 'valueSet', valueCanonical: VS + 'allergy-intolerance-uv-ips' },
      { url: 'coding', valueCoding: { system: 'http://snomed.info/sct', code: '91936005', display: 'Allergy to penicillin' } }
    ]));
    // the value set and what it includes went with the request
    const c = calls.find(x => x.vs === VS + 'allergy-intolerance-uv-ips');
    expect(c.txResources).toEqual([VS + 'inner']);
    expect(c.coding).toEqual({ system: 'http://snomed.info/sct', code: '91936005', display: 'Allergy to penicillin' });
    // the ones with no definition went by url
    expect(calls.find(x => x.vs === VS + 'vital-signs')).toBeDefined();
    // the JSON view is still the master
    const json = await request(app).get('/ips/demo/Bundle/1');
    expect(JSON.stringify(json.body)).not.toContain(CHECK_EXTENSION);
  });

  test('a cross when no coding is in any candidate, and a question mark when the server fails', async () => {
    // an observation with a text-only value: two candidate value sets for the code, both false
    const d = withObservation('1234-5', { valueCodeableConcept: { text: 'just text' } });
    d.entry[3].resource.code = { coding: [{ system: 'http://snomed.info/sct', code: '12345' }, { system: 'http://snomed.info/sct', code: 'boom' }] };
    await post(app, 'demo', d);
    await mod.processQueue();
    const row = mod.store.read(1);
    expect(checks(row.analysed)).toEqual({ 'entry[3].resource.code': 'unknown', 'entry[4].resource.code': 'not-in', 'entry[4].resource.valueCodeableConcept': 'not-in' });
    const msg = (res) => res.extension.find(e => e.url === CHECK_EXTENSION).extension.find(e => e.url === 'message').valueString;
    expect(msg(row.analysed.entry[4].resource.valueCodeableConcept)).toBe('The concept has no codings');
    expect(msg(row.analysed.entry[3].resource.code)).toMatch(/Could not be determined.*kaboom/);
    expect(msg(row.analysed.entry[4].resource.code)).toBe('No coding is in http://hl7.org/fhir/uv/ips/ValueSet/results-laboratory-observations-uv-ips or http://hl7.org/fhir/uv/ips/ValueSet/vital-signs');
    expect(calls.filter(c => c.coding.code === '1234-5')).toHaveLength(2);
    expect(row.status_message).toBe('terminology: 0 in, 2 not in, 1 unknown');
  });

  test('a fixed code is a value set of one, answered without the server', async () => {
    await post(app, 'demo', withObservation('1234-5', { valueCodeableConcept: { coding: [{ system: 'http://loinc.org', code: 'LA1', display: 'yes' }] } }));
    await mod.processQueue();
    const row = mod.store.read(1);
    expect(checks(row.analysed)['entry[4].resource.valueCodeableConcept']).toBe('in');
    const ext = row.analysed.entry[4].resource.valueCodeableConcept.extension[0].extension;
    expect(ext).toEqual(expect.arrayContaining([{ url: 'pattern', valueCoding: { system: 'http://loinc.org', code: 'LA1' } }, { url: 'coding', valueCoding: { system: 'http://loinc.org', code: 'LA1', display: 'yes' } }]));
    expect(calls.filter(c => c.coding.code === 'LA1')).toHaveLength(0);
    const page = await request(app).get('/ips/demo/Bundle/1?view=terminology').set('Accept', 'text/html');
    expect(page.text).toContain('<span class="ips-small">fixed LA1</span>');
    expect(page.text).toContain('Fixed code: http://loinc.org|LA1');
  });

  test('the questions asked for one document are bounded, and identical concepts are asked once', async () => {
    const pipeline = require('../../ips/pipeline');
    const d = ips();
    // twenty allergies with the same (cached) code and twenty with their own
    for (let i = 0; i < 40; i++) {
      d.entry[0].resource.section[0].entry.push({ reference: `urn:uuid:a${i}` });
      d.entry.push({ fullUrl: `urn:uuid:a${i}`, resource: { resourceType: 'AllergyIntolerance', id: `a${i}`, patient: { reference: 'urn:uuid:pat-1' }, code: { coding: [{ system: 'http://snomed.info/sct', code: i < 20 ? 'same' : `c${i}` }] } } });
    }
    await post(app, 'demo', d);
    await mod.processQueue();
    const row = mod.store.read(1);
    // 1 (the fixture's allergy) + 1 (same) + 20 distinct = 22 questions, not 41
    expect(calls).toHaveLength(22);
    expect(row.status_message).toBe('terminology: 1 in, 40 not in, 0 unknown');
    expect(pipeline.MAX_CHECKS_PER_DOCUMENT).toBeGreaterThan(22);
  });

  test('the answer cache is bounded', async () => {
    const { checkConcept, MAX_CACHED_ANSWERS } = require('../../ips/pipeline');
    mod.txCache = new Map();
    for (let i = 0; i < MAX_CACHED_ANSWERS; i++) {
      mod.txCache.set(`k${i}`, { result: false });
    }
    await checkConcept(mod, { coding: [{ system: 'http://snomed.info/sct', code: 'new' }] }, [{ valueSet: VS + 'allergy-intolerance-uv-ips' }]);
    expect(mod.txCache.size).toBe(MAX_CACHED_ANSWERS);
    expect(mod.txCache.has('k0')).toBe(false);
    expect(mod.txCache.has(`${VS}allergy-intolerance-uv-ips|http://snomed.info/sct||new`)).toBe(true);
    // over budget: unknown, without a question
    const n = calls.length;
    const out = await checkConcept(mod, { coding: [{ system: 'http://snomed.info/sct', code: 'another' }] }, [{ valueSet: VS + 'allergy-intolerance-uv-ips' }], { left: 0 });
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
    await mod.processQueue();
    const page = await request(app).get('/ips/demo/Bundle/1?view=terminology').set('Accept', 'text/html');
    expect(page.text).toContain('<span class="ips-check ips-check-in" title="http://snomed.info/sct|91936005 is in http://hl7.org/fhir/uv/ips/ValueSet/allergy-intolerance-uv-ips\nValue set: http://hl7.org/fhir/uv/ips/ValueSet/allergy-intolerance-uv-ips">&#10003;</span> <span class="ips-small">allergy-intolerance-uv-ips</span>');
    expect(page.text).toContain('ips-check-unknown" title="Could not be determined');
    expect(page.text).toContain('ips-check-unknown" title="Could not be determined - http://loinc.org|odd in http://hl7.org/fhir/uv/ips/ValueSet/results-laboratory-observations-uv-ips: The terminology server gave no result');
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

  test('without a terminology server or the IPS package the step fails', async () => {
    mod.ipsBindings = null;
    await post(app, 'demo', ips());
    await mod.processQueue();
    expect(mod.store.read(1).status_message).toBe('terminology: The IPS package has not been loaded');
    const other = await makeApp();
    other.mod.ipsBindings = fakeBindings;
    other.mod.steps = STEPS.filter(s => s.name === 'terminology');
    other.mod.store.createProject('demo', 'Demo', null);
    await post(other.app, 'demo', ips());
    await other.mod.processQueue();
    expect(other.mod.store.read(1).status_message).toBe('terminology: No terminology server is configured (modules.ips.txServer)');
    other.mod.shutdown();
  });

  test('a path that nothing answers at is reported, once, and as unknown', async () => {
    const { app: app2, mod: mod2 } = await makeApp({ txServer: '/nowhere/r4' });
    const logged = [];
    mod2.log = { info() {}, warn() {}, error: (m) => logged.push(m), debug() {} };
    mod2.ipsBindings = fakeBindings;
    mod2.steps = STEPS.filter(s => s.name === 'terminology');
    mod2.store.createProject('demo', 'Demo', null);
    await post(app2, 'demo', ips());
    await post(app2, 'demo', ips());
    await mod2.processQueue();
    expect(logged.filter(m => /nothing answers at the terminology server \/nowhere\/r4/.test(m))).toHaveLength(1);
    const row = mod2.store.read(1);
    expect(row.status_message).toBe('terminology: 0 in, 0 not in, 1 unknown');
    expect(JSON.stringify(row.analysed)).toContain('The terminology server is not configured correctly');
    expect(JSON.stringify(row.analysed)).not.toContain('/nowhere/r4');
    mod2.shutdown();
  });

  test('the queue waits while the IPS package is loading', async () => {
    await post(app, 'demo', ips());
    let release;
    mod.bindingsLoading = new Promise(r => { release = r; });
    expect(await mod.processQueue()).toBe(0);
    release();
    mod.bindingsLoading = null;
    expect(await mod.processQueue()).toBe(1);
  });
});
