//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const request = require('supertest');
const { makeApp, body, FHIR_JSON } = require('./helpers');
const { wantsHtml, describeFor, displayOf } = require('../../rest/web');

const HTML = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

describe('rest web pages', () => {
  let t;
  let pid;
  beforeAll(async () => {
    t = await makeApp('sqlite', { settings: { name: 'Web Test', description: 'Pages over the API' } });
    pid = (await request(t.app).post('/r4/Patient').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Patient',
      identifier: [{ system: 'urn:mrn', value: '42' }], name: [{ family: 'Smith', given: ['Jo'] }],
      text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml"><p>Jo <b>Smith</b></p></div>' } }))).body.id;
    await request(t.app).post('/r4/Observation').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Observation', status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '1-8', display: 'Thing' }] }, subject: { reference: `Patient/${pid}` } }));
  });
  afterAll(async () => {
    await t.close();
  });

  const page = async (url, status = 200) => {
    const r = await request(t.app).get(url).set(HTML);
    expect(r.status).toBe(status);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    return r.text;
  };

  test('the endpoint: what it is, its types with counts, and the CapabilityStatement', async () => {
    const h = await page('/r4');
    expect(h).toContain('Web Test');
    expect(h).toContain('Pages over the API');
    expect(h).toMatch(/<a href="\/r4\/Patient">Patient<\/a><\/td><td style="text-align: right">1</);
    expect(h).toContain('Capability Statement');
    expect(h).toContain('REST server Definition');
    expect(h).toContain('<a href="/r4/Group">Group</a>');
  });

  test('a type: a search form from its search parameters', async () => {
    const h = await page('/r4/Patient');
    expect(h).toContain('1 Patient resource.');
    expect(h).toContain('name="birthdate"');
    expect(h).toContain('name="_lastUpdated"');
    // the description for Patient, from a parameter the core shares across types
    expect(h).toContain('The patient&#39;s date of birth');
    expect(h).toContain('<option value="-family">');
  });

  test('search results and history', async () => {
    const s = await page('/r4/Patient?family=smi');
    expect(s).toContain('1 found.');
    expect(s).toContain(`<a href="/r4/Patient/${pid}">Patient/${pid}</a>`);
    expect(s).toContain('Jo Smith');
    const latest = await page('/r4/Patient?_sort=-_lastUpdated');
    expect(latest).toContain('1 found.');
    const inc = await page('/r4/Observation?_include=Observation:subject');
    expect(inc).toContain('included');
    const h = await page('/r4/_history');
    expect(h).toContain('(created)');
  });

  test('a resource: what identifies it, its narrative, its JSON', async () => {
    const h = await page(`/r4/Patient/${pid}`);
    expect(h).toContain('urn:mrn|42');
    expect(h).toContain('<p>Jo <b>Smith</b></p>');
    expect(h).toContain('Show JSON');
    await page('/r4/Patient/nope', 404);
  });

  test('a narrative with active content is not shown', async () => {
    const id = (await request(t.app).post('/r4/Patient').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Patient',
      text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml"><p onclick="x()">x</p></div>' } }))).body.id;
    const h = await page(`/r4/Patient/${id}`);
    expect(h).toContain('This narrative is not shown');
    expect(h).not.toContain('onclick="x()"');
  });

  test('the API is unchanged for anything that isn\'t a browser', async () => {
    const r = await request(t.app).get('/r4/Patient').set('Accept', 'application/fhir+json');
    expect(r.headers['content-type']).toMatch(/fhir\+json/);
    const j = await request(t.app).get(`/r4/Patient/${pid}?_format=json`).set(HTML);
    expect(j.body.resourceType).toBe('Patient');
  });

  test('access: a page needs what the API needs', async () => {
    const other = await makeApp('sqlite', { principal: async () => null });
    try {
      const r = await request(other.app).get('/r4').set(HTML);
      expect(r.status).toBe(401);
      expect(r.text).toContain('Log in');
    } finally {
      await other.close();
    }
  });

  test('helpers', () => {
    expect(wantsHtml({ method: 'GET', query: {}, get: () => 'text/html' })).toBe(true);
    expect(wantsHtml({ method: 'GET', query: {}, get: () => 'application/json, */*' })).toBe(false);
    expect(wantsHtml({ method: 'POST', query: {}, get: () => 'text/html' })).toBe(false);
    expect(wantsHtml({ method: 'GET', query: { _format: 'html' }, get: () => '' })).toBe(true);
    expect(describeFor('Multiple Resources: \n\n* [Patient](patient.html): The patient\'s x\n* [Person](person.html): y', 'Person')).toBe('y');
    expect(describeFor('One thing\nmore', 'Patient')).toBe('One thing');
    expect(displayOf({ code: { coding: [{ display: 'D' }] } })).toBe('D');
  });
});
