// Keeps registry/openapi.yaml honest against the router it describes, and covers the
// Discovery API and the resolve changes that came with it.

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const RegistryModule = require('../../registry/registry');
const RegistryCrawler = require('../../registry/crawler');
const RegistryAPI = require('../../registry/api');
const openapi = require('../../registry/openapi');
const packageJson = require('../../package.json');
const { parametersOf, operations, describeSpecBasics, describeRouterAgreement } = require('../utils/openapi-helpers');

// Routes the spec deliberately does not describe, with the reason.
const EXCLUDED = {
  'GET /log': 'operational: crawler log',
  'GET /software': 'operational: software versions of the registered servers (HTML page)',
  'GET /openapi': 'the description itself',
  'GET /openapi.json': 'the description itself',
  'GET /openapi.yaml': 'the description itself'
};

function makeModule() {
  const module = new RegistryModule({ countRequest() {} });
  module.crawler = new RegistryCrawler();
  module.crawler.loadData(JSON.parse(fs.readFileSync(path.join(__dirname, 'test-data.json'), 'utf8')));
  module.api = new RegistryAPI(module.crawler);
  module.setupRoutes();
  return module;
}

function makeApp(module) {
  const app = express();
  app.use('/tx-reg', module.router);
  return app;
}

const urls = list => (list || []).map(e => e.url);

describe('registry OpenAPI description', () => {
  const spec = openapi.getSpec();
  const module = makeModule();
  const app = makeApp(module);

  describe('the document', () => {
    describeSpecBasics(spec, packageJson);
  });

  describe('agreement with the router', () => {
    describeRouterAgreement(spec, module.router, EXCLUDED);

    test('discovery parameters are the ones the handler reads', () => {
      expect(parametersOf(spec, 'discover', 'query').map(p => p.name).sort())
        .toEqual([...RegistryModule.DISCOVERY_PARAMS].sort());
    });

    test('resolve parameters are the ones the handler reads', () => {
      expect(parametersOf(spec, 'resolve', 'query').map(p => p.name).sort())
        .toEqual([...RegistryModule.RESOLVE_PARAMS].sort());
    });
  });

  describe('serving and discovery links', () => {
    test('GET /tx-reg/openapi.json returns the description', async () => {
      const res = await request(app).get('/tx-reg/openapi.json');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.paths)).toEqual(Object.keys(spec.paths));
    });

    test('GET /tx-reg/openapi.yaml returns the YAML source', async () => {
      const res = await request(app).get('/tx-reg/openapi.yaml');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/yaml/);
    });

    test('GET /tx-reg/openapi returns JSON to a non-browser client', async () => {
      const res = await request(app).get('/tx-reg/openapi').set('Accept', 'application/json');
      expect(res.body.info.title).toBe(spec.info.title);
    });

    test('the HTML reference lists every operation', () => {
      const html = openapi.renderHtml();
      for (const { op } of Object.values(operations(spec))) {
        expect(html).toContain(`id="${op.operationId}"`);
      }
    });

    test('responses carry a Link header pointing at the description', async () => {
      const res = await request(app).get('/tx-reg/openapi.json');
      expect(res.headers.link).toContain('</tx-reg/openapi.json>; rel="service-desc"');
    });

    test('the registry page template links to the API reference and the description', () => {
      const template = fs.readFileSync(path.join(__dirname, '../../registry/registry-template.html'), 'utf8');
      expect(template).toContain('href="/tx-reg/openapi"');
      expect(template).toContain('rel="service-desc"');
    });
  });
});

describe('registry Discovery API', () => {
  const app = makeApp(makeModule());
  const discover = query => request(app).get('/tx-reg/').query(query).set('Accept', 'application/json');

  test('lists every endpoint, in the shape the ecosystem IG describes', async () => {
    const res = await discover({});
    expect(res.status).toBe(200);
    expect(res.body['master-url']).toBe('https://fhir.github.io/ig-registry/tx-servers.json');
    expect(res.body).toHaveProperty('last-update');
    expect(res.body.results.length).toBe(12);
    const tx = res.body.results.find(r => r.url === 'http://tx.fhir.org/r4');
    expect(tx).toMatchObject({
      'server-name': 'tx.fhir.org',
      'server-code': 'tx.fhir.org',
      fhirVersion: '4.0.1',
      open: true,
      security: 'open'
    });
    expect(typeof tx.systems).toBe('number');
    expect(Array.isArray(tx.authoritative)).toBe(true);
    expect(tx).not.toHaveProperty('candidate');
  });

  test('filters by server and FHIR version', async () => {
    expect(urls((await discover({ server: 'tx.fhir.org' })).body.results).sort())
      .toEqual(['http://tx.fhir.org/r3', 'http://tx.fhir.org/r4', 'http://tx.fhir.org/r5']);
    expect(urls((await discover({ server: 'tx.fhir.org', fhirVersion: 'R5' })).body.results))
      .toEqual(['http://tx.fhir.org/r5']);
  });

  test('filters by registry', async () => {
    const all = (await discover({})).body.results;
    const code = all[0]['registry-code'];
    const filtered = (await discover({ registry: code })).body.results;
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every(r => r['registry-code'] === code)).toBe(true);
    expect((await discover({ registry: 'no-such-registry' })).body.results).toEqual([]);
  });

  test('with url, lists only endpoints that host it, authoritative first, others marked as candidates', async () => {
    const res = await discover({ url: 'http://snomed.info/sct|http://snomed.info/sct/32506021000036107', fhirVersion: 'R4' });
    const results = res.body.results;
    expect(results[0].url).toBe('https://tx.ontoserver.csiro.au/fhir');
    expect(results[0]).not.toHaveProperty('candidate');
    const tx = results.find(r => r.url === 'http://tx.fhir.org/r4');
    expect(tx.candidate).toEqual(['http://snomed.info/sct|http://snomed.info/sct/32506021000036107']);
  });

  test('authoritativeOnly keeps only the authoritative endpoints', async () => {
    const res = await discover({ url: 'http://snomed.info/sct|http://snomed.info/sct/32506021000036107', fhirVersion: 'R4', authoritativeOnly: 'true' });
    expect(urls(res.body.results)).toEqual(['https://tx.ontoserver.csiro.au/fhir']);
  });

  test('a malformed url is a 400', async () => {
    const res = await discover({ url: 'not a url' });
    expect(res.status).toBe(400);
  });

  test('a browser still gets the HTML page', async () => {
    const res = await request(app).get('/tx-reg/').set('Accept', 'text/html');
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });
});

describe('registry resolve', () => {
  const module = makeModule();
  const api = module.api;

  test('entries carry fhirVersion and the security flags', () => {
    const { result } = api.resolveCodeSystem('R4', 'http://loinc.org', false);
    const all = [...(result.authoritative || []), ...(result.candidates || [])];
    expect(all.length).toBeGreaterThan(0);
    for (const entry of all) {
      expect(entry.fhirVersion).toMatch(/^4\.0/);
      if (entry.security === 'open') {
        expect(entry.open).toBe(true);
      } else if (entry.security === 'api-key') {
        expect(entry.token).toBe(true);
      }
    }
  });

  test.each([
    ['R4', '4.0'], ['r4', '4.0'], ['R4B', '4.3'], ['R2B', '1.4'], ['R5', '5.0'], ['R6', '6.0'], ['4.0.1', '4.0.1']
  ])('FHIR version %s selects %s', (given, expected) => {
    expect(api._normalizeFhirVersion(given)).toBe(expected);
  });

  test('a SNOMED CT edition is hosted by a server that hosts a version of it', () => {
    // the Canadian server lists only full versions (.../20611000087101/version/...)
    const { result } = api.resolveCodeSystem('R4', 'http://snomed.info/sct|http://snomed.info/sct/20611000087101', false);
    expect(urls(result.authoritative)).toContain('https://terminologystandardsservice.ca/tx/fhir');
  });

  test('a SNOMED CT edition does not match a different edition with the same prefix', () => {
    // .../sct/1 must not match .../sct/11000146104/version/...
    const { result } = api.resolveCodeSystem('R4', 'http://snomed.info/sct|http://snomed.info/sct/1', false);
    expect(result.authoritative).toBeUndefined();
    expect(result.candidates).toBeUndefined();
  });
});
