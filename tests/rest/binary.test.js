//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// Binary as content (rest/binary.js): the bytes in, and back out; a Content-Type that is a FHIR
// format is a Binary resource, as the Pascal server took it.

const request = require('supertest');
const { engines, makeApp, FHIR_JSON } = require('./helpers');
const { fhirFormatOf } = require('../../rest/binary');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0xff, 0x00, 0x7f]);

// supertest: the response body as bytes, whatever its type
const bytes = (req) => req.buffer(true).parse((res, cb) => {
  const chunks = [];
  res.on('data', c => chunks.push(Buffer.from(c)));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

describe('which content types are FHIR formats (as the Pascal server had it)', () => {
  test('JSON and XML types, and anything named json or xml; not ndjson, text, html, images', () => {
    for (const t of ['application/fhir+json', 'application/json', 'application/json; charset=utf-8', 'text/json', 'application/vnd.example+json']) {
      expect(fhirFormatOf(t)).toBe('json');
    }
    for (const t of ['application/fhir+xml', 'application/xml', 'text/xml', 'image/svg+xml', 'application/xhtml+xml']) {
      expect(fhirFormatOf(t)).toBe('xml');
    }
    for (const t of ['image/png', 'application/pdf', 'text/plain', 'text/html', 'application/fhir+ndjson', 'application/octet-stream', '', undefined]) {
      expect(fhirFormatOf(t)).toBeNull();
    }
  });
});

describe.each(engines())('Binary as content (%s)', (engine) => {
  let t;
  beforeEach(async () => {
    t = await makeApp(engine);
  });
  afterEach(async () => {
    await t.close();
  });

  test('POST the bytes: a Binary with that contentType; read gives the bytes back, with it', async () => {
    const c = await request(t.app).post('/r4/Binary').set('Content-Type', 'image/png').set('Accept', FHIR_JSON).send(PNG);
    expect(c.status).toBe(201);
    expect(c.body.resourceType).toBe('Binary');
    expect(c.body.contentType).toBe('image/png');
    expect(Buffer.from(c.body.data, 'base64').equals(PNG)).toBe(true);
    const id = c.body.id;
    const r = await bytes(request(t.app).get(`/r4/Binary/${id}`));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers.etag).toBe('W/"1"');
    expect(r.headers['content-security-policy']).toBe('sandbox');
    expect(r.body.equals(PNG)).toBe(true);
    // and a browser gets the content too, not a page
    const html = await bytes(request(t.app).get(`/r4/Binary/${id}`).set('Accept', 'text/html,application/xhtml+xml,*/*'));
    expect(html.headers['content-type']).toBe('image/png');
    expect((await bytes(request(t.app).get(`/r4/Binary/${id}/_history/1`))).body.equals(PNG)).toBe(true);
    // HEAD: the headers only
    const head = await request(t.app).head(`/r4/Binary/${id}`);
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(PNG.length));
  });

  test('a FHIR format asked for: the Binary resource', async () => {
    const id = (await request(t.app).post('/r4/Binary').set('Content-Type', 'application/pdf').set('Accept', FHIR_JSON).send(Buffer.from('%PDF-1.4 x'))).body.id;
    const json = await request(t.app).get(`/r4/Binary/${id}`).set('Accept', FHIR_JSON);
    expect(json.headers['content-type']).toMatch(/fhir\+json/);
    expect(json.body.contentType).toBe('application/pdf');
    const viaFormat = await request(t.app).get(`/r4/Binary/${id}?_format=json`);
    expect(viaFormat.body.resourceType).toBe('Binary');
    const xml = await request(t.app).get(`/r4/Binary/${id}`).set('Accept', 'application/fhir+xml');
    expect(xml.text).toContain('<contentType value="application/pdf"/>');
    // searches and history are always resources
    const s = await request(t.app).get('/r4/Binary').set('Accept', FHIR_JSON);
    expect(s.body.entry[0].resource.contentType).toBe('application/pdf');
  });

  test('PUT the bytes, with X-Security-Context; text/plain is content', async () => {
    const u = await request(t.app).put('/r4/Binary/note').set('Content-Type', 'text/plain; charset=utf-8').set('X-Security-Context', 'Patient/123')
      .set('Accept', FHIR_JSON).send('hello there');
    expect(u.status).toBe(201);
    expect(u.body.id).toBe('note');
    expect(u.body.contentType).toBe('text/plain; charset=utf-8');
    expect(u.body.securityContext).toEqual({ reference: 'Patient/123' });
    const r = await request(t.app).get('/r4/Binary/note');
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(r.text).toBe('hello there');
    const u2 = await request(t.app).put('/r4/Binary/note').set('Content-Type', 'text/plain').send('changed');
    expect(u2.status).toBe(200);
    expect((await request(t.app).get('/r4/Binary/note')).text).toBe('changed');
    expect((await request(t.app).get('/r4/Binary/note/_history/1')).text).toBe('hello there');
  });

  test('a FHIR format as Content-Type is the Binary resource; its content, if JSON, is read back as it is', async () => {
    const doc = { resourceType: 'Patient', name: [{ family: 'Inside' }] };
    const res = { resourceType: 'Binary', contentType: 'application/fhir+json', data: Buffer.from(JSON.stringify(doc)).toString('base64') };
    const c = await request(t.app).post('/r4/Binary').set('Content-Type', FHIR_JSON).send(JSON.stringify(res));
    expect(c.status).toBe(201);
    const id = c.body.id;
    // the content is a FHIR format: it's what a read gives, whatever the Accept (as the Pascal server did)
    for (const accept of [FHIR_JSON, 'application/fhir+xml', '*/*']) {
      const r = await request(t.app).get(`/r4/Binary/${id}`).set('Accept', accept);
      expect(r.headers['content-type']).toBe('application/fhir+json');
      expect(JSON.parse(r.text)).toEqual(doc);
    }
    // a JSON type of another name is still read as a FHIR resource
    const other = await request(t.app).post('/r4/Binary').set('Content-Type', 'application/vnd.example+json').send(JSON.stringify({ resourceType: 'Binary', contentType: 'image/gif' }));
    expect(other.status).toBe(201);
    // and something that isn't a Binary resource is refused, as for any type
    const bad = await request(t.app).post('/r4/Binary').set('Content-Type', 'application/json').send(JSON.stringify({ hello: 'world' }));
    expect(bad.status).toBe(400);
  });

  test('no Content-Type: refused; an empty body is a Binary with no data', async () => {
    const none = await request(t.app).post('/r4/Binary').set('Content-Type', '').send(PNG);
    expect(none.status).toBe(400);
    const empty = await request(t.app).post('/r4/Binary').set('Content-Type', 'application/octet-stream').set('Accept', FHIR_JSON).send(Buffer.alloc(0));
    expect(empty.status).toBe(201);
    expect(empty.body.data).toBeUndefined();
    const r = await bytes(request(t.app).get(`/r4/Binary/${empty.body.id}`));
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(0);
  });

  test('other types are unchanged: a PNG posted to Patient is refused', async () => {
    const r = await request(t.app).post('/r4/Patient').set('Content-Type', 'image/png').send(PNG);
    expect(r.status).toBe(415);
  });
});
