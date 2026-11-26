//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// The tx module's XML by the model-driven converter (library/fhir-xml.js, modules.tx.xmlConverter):
// what it writes is what the JSON says, it reads XML request bodies, and comparing it with the
// tx/xml classes finds nothing different in real responses.

const http = require('http');
const path = require('path');
const express = require('express');
const request = require('supertest');
const TXModule = require('../../tx/tx');
const fhirXml = require('../../library/fhir-xml');

const LIBRARY = path.join(__dirname, 'fixtures', 'test-library.yaml');
const XML = 'application/fhir+xml';

// the response as text, whatever its type
const text = (r) => r.buffer(true).parse((res, cb) => {
  let d = '';
  res.setEncoding('utf8');
  res.on('data', c => {
    d += c;
  });
  res.on('end', () => cb(null, d));
});

async function start(xmlConverter) {
  const app = express();
  app.use(express.raw({ type: ['application/fhir+xml', 'application/xml'], limit: '10mb' }));
  app.use(express.json({ type: ['application/json', 'application/fhir+json'], limit: '10mb' }));
  const tx = new TXModule();
  await tx.initialize({ librarySource: LIBRARY, xmlConverter, endpoints: [
    { path: '/tx/r4', fhirVersion: '4.0', context: null }, { path: '/tx/r5', fhirVersion: '5.0', context: null }] }, app);
  // one server, on one port, for all the requests (the CapabilityStatement says where it is)
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const stop = async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
    await tx.shutdown();
  };
  return { app: server, tx, stop };
}

// the requests, as JSON and as XML: the XML read back is the JSON
const REQUESTS = [
  ['GET', 'metadata'],
  ['GET', 'metadata?mode=terminology'],
  ['GET', 'CodeSystem/core-administrative-gender'],
  ['GET', 'ValueSet/$expand?url=http://hl7.org/fhir/ValueSet/administrative-gender'],
  ['GET', 'CodeSystem/$lookup?system=http://hl7.org/fhir/administrative-gender&code=male'],
  ['GET', 'CodeSystem/$validate-code?url=http://hl7.org/fhir/administrative-gender&code=nonsense'],
  ['GET', 'CodeSystem?url=http://hl7.org/fhir/administrative-gender'],
  ['GET', 'CodeSystem/no-such-thing']
];

describe('the tx module, with the model-driven XML converter', () => {
  let t;

  beforeAll(async () => {
    t = await start('model');
  }, 240000);

  afterAll(async () => {
    await t.stop();
  });

  test('each endpoint has the model for its FHIR version', () => {
    expect(t.tx.xmlModels.get('4.0').raw.version).toBe('4.0.1');
    expect(t.tx.xmlModels.get('5.0').raw.version).toBe('5.0.0');
  });

  test.each(['r4', 'r5'])('what the XML says is what the JSON says (%s)', async (v) => {
    const model = t.tx.xmlModels.get(v === 'r4' ? '4.0' : '5.0');
    for (const [, url] of REQUESTS) {
      const j = await request(t.app).get(`/tx/${v}/${url}`).set('Accept', 'application/fhir+json');
      const x = await text(request(t.app).get(`/tx/${v}/${url}`).set('Accept', XML));
      expect([url, x.status]).toEqual([url, j.status]);
      expect([url, x.headers['content-type']]).toEqual([url, expect.stringMatching(/xml/)]);
      const fromXml = fhirXml.fromXml(x.body, model);
      // (the bits that change from one request to the next)
      const strip = (r) => JSON.parse(JSON.stringify(r, (k, val) => (['date', 'timestamp', 'id', 'lastUpdated', 'identifier'].includes(k) && typeof val === 'string' ? undefined : val)));
      expect([url, strip(fromXml)]).toEqual([url, strip(j.body)]);
    }
  });

  test('a request body in XML', async () => {
    const model = t.tx.xmlModels.get('5.0');
    const params = { resourceType: 'Parameters', parameter: [{ name: 'url', valueUri: 'http://hl7.org/fhir/administrative-gender' },
      { name: 'code', valueCode: 'female' }, { name: 'display', valueString: 'Female & more\nlines' }] };
    const viaXml = await request(t.app).post('/tx/r5/CodeSystem/$validate-code').set('Content-Type', XML).set('Accept', 'application/fhir+json')
      .send(fhirXml.toXml(params, model));
    const viaJson = await request(t.app).post('/tx/r5/CodeSystem/$validate-code').set('Content-Type', 'application/fhir+json').send(params);
    expect(viaXml.status).toBe(200);
    expect(viaXml.body).toEqual(viaJson.body);
    // XML that isn't FHIR: 400
    const bad = await request(t.app).post('/tx/r5/CodeSystem/$validate-code').set('Content-Type', XML).send('<Parameters xmlns="http://hl7.org/fhir"><nonsense/></Parameters>');
    expect(bad.status).toBe(400);
  });
});

describe('the tx module, comparing the converter with the tx/xml classes', () => {
  let t;
  let warnings;

  beforeAll(async () => {
    t = await start('compare');
    warnings = [];
    const warn = t.tx.log.warn.bind(t.tx.log);
    t.tx.log.warn = (m, ...rest) => {
      if (String(m).startsWith('XML compare')) {
        warnings.push(m);
      }
      return warn(m, ...rest);
    };
  }, 240000);

  afterAll(async () => {
    await t.stop();
  });

  test('they agree on real responses and requests (the classes\' XML is what is sent)', async () => {
    for (const v of ['r4', 'r5']) {
      for (const [, url] of REQUESTS) {
        const x = await text(request(t.app).get(`/tx/${v}/${url}`).set('Accept', XML));
        expect(x.status).toBeLessThan(500);
      }
      const model = t.tx.xmlModels.get(v === 'r4' ? '4.0' : '5.0');
      await request(t.app).post(`/tx/${v}/CodeSystem/$validate-code`).set('Content-Type', XML)
        .send(fhirXml.toXml({ resourceType: 'Parameters', parameter: [{ name: 'url', valueUri: 'http://hl7.org/fhir/administrative-gender' }, { name: 'code', valueCode: 'male' }] }, model));
    }
    // the comparisons run after the responses
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(warnings).toEqual([]);
  });

  test('a difference is reported', async () => {
    const model = t.tx.xmlModels.get('5.0');
    // the classes write a contained resource wrongly no more; make them differ on purpose
    const original = t.tx.convertResourceToXml.bind(t.tx);
    t.tx.convertResourceToXml = (r) => original({ ...r, name: 'Changed' });
    try {
      await text(request(t.app).get('/tx/r5/CodeSystem/core-administrative-gender').set('Accept', XML));
      await new Promise(resolve => setTimeout(resolve, 200));
    } finally {
      t.tx.convertResourceToXml = original;
    }
    expect(warnings.join('\n')).toMatch(/XML compare: .*CodeSystem.*differ: CodeSystem\.name/);
    expect(model).toBeTruthy();
  });
});

describe('the tx module, by default', () => {
  test('the model-driven converter, with a model for each version', async () => {
    const t = await start(undefined);
    try {
      expect(t.tx.xmlConverter).toBe('model');
      expect([...t.tx.xmlModels.keys()].sort()).toEqual(['4.0', '5.0']);
    } finally {
      await t.stop();
    }
  }, 240000);
  test('legacy: the tx/xml classes, and no models', async () => {
    const t = await start('legacy');
    try {
      expect(t.tx.xmlConverter).toBe('legacy');
      expect([...t.tx.xmlModels.keys()]).toEqual([]);
    } finally {
      await t.stop();
    }
  }, 240000);

  test('a bad setting stops it', async () => {
    await expect(start('fast')).rejects.toThrow(/xmlConverter must be one of legacy, model, compare/);
  });
});
