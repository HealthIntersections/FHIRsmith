//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// What a write can't put in the database: narrative that isn't safe to show (store.js), and a
// JSON Patch that makes a resource far bigger than the patch (rest/library/json-patch.js)

const request = require('supertest');
const { engines, makeApp, body, FHIR_JSON } = require('./helpers');

const div = (inner) => `<div xmlns="http://www.w3.org/1999/xhtml">${inner}</div>`;
const patient = (narrative) => ({ resourceType: 'Patient', text: { status: 'generated', div: div(narrative) }, name: [{ family: 'Chalmers' }] });
const JSON_PATCH = 'application/json-patch+json';

describe.each(engines())('narrative and patch safety (%s)', (engine) => {
  let t;
  beforeEach(async () => {
    t = await makeApp(engine, { maxBody: 200000 });
  });
  afterEach(async () => {
    await t.close();
  });

  const post = (path, resource) => request(t.app).post(path).set('Content-Type', FHIR_JSON).send(body(resource));
  const put = (path, resource) => request(t.app).put(path).set('Content-Type', FHIR_JSON).send(body(resource));
  const patch = (path, ops) => request(t.app).patch(path).set('Content-Type', JSON_PATCH).send(JSON.stringify(ops));
  const issue = (r) => r.body.issue[0].diagnostics;

  test('narrative that is fine is stored', async () => {
    const r = await post('/r4/Patient', patient('<p><b>Peter</b> <img src="pic.png"/> <img src="data:image/png;base64,AA"/> <a href="https://example.org">x</a></p>'));
    expect(r.status).toBe(201);
  });

  test.each([
    ['a script', '<script>alert(1)</script>', /<script> element/],
    ['an event attribute', '<p onmouseover="alert(1)">x</p>', /event handler attribute/],
    ['an image from elsewhere', '<img src="https://tracker.example.org/p.gif"/>', /image from elsewhere/],
    ['an iframe', '<iframe src="https://example.org"></iframe>', /<iframe> element/],
    ['a form', '<form action="https://example.org"><input name="pw"/></form>', /<form> element/],
    ['an external stylesheet', '<link rel="stylesheet" href="https://example.org/x.css"/>', /<link> element/],
    ['an external url() in a style', '<p style="background: url(https://example.org/t.gif)">x</p>', /URL from elsewhere/],
    ['<plaintext>', '<plaintext>x', /<plaintext> element/]
  ])('a create with %s is refused', async (_, narrative, why) => {
    const r = await post('/r4/Patient', patient(narrative));
    expect(r.status).toBe(422);
    expect(issue(r)).toMatch(why);
    expect(issue(r)).toMatch(/^The resource can't be stored: Patient\.text: /);
  });

  test('every narrative is checked: an update, a contained resource, a Composition section, a transaction', async () => {
    const bad = div('<img src="//example.org/p.gif"/>');
    const c = await post('/r4/Patient', patient('ok'));
    expect(c.status).toBe(201);
    expect((await put(`/r4/Patient/${c.body.id}`, { ...patient('ok'), id: c.body.id, contained: [{ resourceType: 'Organization', id: 'o', text: { status: 'generated', div: bad } }] })).status).toBe(422);
    // (a narrative that isn't a resource's text: a Composition's section, here contained)
    const comp = await post('/r4/Patient', { ...patient('ok'), contained: [{
      resourceType: 'Composition', id: 'c', status: 'final', type: { text: 'x' }, date: '2026-01-01', author: [{ display: 'x' }], title: 'x',
      section: [{ title: 'a', text: { status: 'generated', div: bad } }]
    }] });
    expect(comp.status).toBe(422);
    expect(issue(comp)).toMatch(/Patient\.contained\[0\]\.section\[0\]\.text: /);
    const tx = await post('/r4', { resourceType: 'Bundle', type: 'transaction', entry: [{ resource: patient('<script>x</script>'), request: { method: 'POST', url: 'Patient' } }] });
    expect(tx.status).toBe(422);
    // nothing was stored
    expect((await request(t.app).get(`/r4/Patient/${c.body.id}`)).body.meta.versionId).toBe('1');
  });

  test('a patch that adds unsafe narrative is refused', async () => {
    const c = await post('/r4/Patient', patient('ok'));
    const r = await patch(`/r4/Patient/${c.body.id}`, [{ op: 'replace', path: '/text/div', value: div('<img src="https://example.org/p.gif"/>') }]);
    expect(r.status).toBe(422);
  });

  test('the web page draws narrative in a box it can\'t escape', async () => {
    const c = await post('/r4/Patient', patient('<p style="position: fixed; top: 0">x</p>'));
    expect(c.status).toBe(201);
    const page = await request(t.app).get(`/r4/Patient/${c.body.id}`).set('Accept', 'text/html');
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/<div class="narrative" style="contain: paint; overflow: auto; position: relative"><div xmlns/);
  });

  test('JSON Patch: copying the whole document is refused', async () => {
    const c = await post('/r4/Patient', patient('ok'));
    const r = await patch(`/r4/Patient/${c.body.id}`, [{ op: 'copy', from: '', path: '/x' }]);
    expect(r.status).toBe(422);
    expect(issue(r)).toMatch(/the whole document can't be copied/);
  });

  test('JSON Patch: copies can\'t make it bigger than the biggest body', async () => {
    const c = await post('/r4/Patient', patient('ok'));
    const ops = [{ op: 'add', path: '/name/0/given', value: ['x'.repeat(1000)] }];
    for (let i = 0; i < 30; i++) {
      ops.push({ op: 'copy', from: '/name/0', path: '/name/-' }, { op: 'copy', from: '/name', path: `/contact` });
    }
    const t0 = Date.now();
    const r = await patch(`/r4/Patient/${c.body.id}`, ops);
    expect(r.status).toBe(422);
    expect(issue(r)).toMatch(/bigger than this server takes/);
    expect(Date.now() - t0).toBeLessThan(5000);
    // a modest copy is fine
    const ok = await patch(`/r4/Patient/${c.body.id}`, [{ op: 'copy', from: '/name/0', path: '/name/-' }]);
    expect(ok.status).toBe(200);
    expect(ok.body.name.length).toBe(2);
  });
});
