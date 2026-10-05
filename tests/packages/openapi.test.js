// Keeps packages/openapi.yaml honest against the router it describes: every route is either
// documented or explicitly excluded, the documented parameter rules are the ones the server
// enforces, and the spec is served.

// None of these tests touch the package database.
jest.mock('sqlite3', () => ({ verbose: () => ({}) }));

const express = require('express');
const request = require('supertest');
const PackagesModule = require('../../packages/packages');
const openapi = require('../../packages/openapi');
const packageJson = require('../../package.json');

// Routes the spec deliberately does not describe, with the reason.
const EXCLUDED = {
  'GET /': 'browser home page; its JSON form is the same search as /catalog',
  'GET /{page}.html': 'HTML pages',
  'GET /search': 'placeholder page, not implemented',
  'GET /log': 'operational: crawler log',
  'GET /stats': 'operational: server statistics',
  'GET /status': 'operational: module status',
  'POST /crawl': 'administrative',
  'GET /openapi': 'the description itself',
  'GET /openapi.json': 'the description itself',
  'GET /openapi.yaml': 'the description itself',
  'ALL {*splat}': 'catch-all 404'
};

const {
  operations, parametersOf, describeSpecBasics, describeRouterAgreement
} = require('../utils/openapi-helpers');

function makeModule() {
  const module = new PackagesModule({ countRequest() {} });
  module.config = { database: 'test.db', mirrorPath: '/nonexistent', crawler: { enabled: false } };
  return module;
}

function makeApp(module) {
  const app = express();
  app.use('/packages', module.router);
  return app;
}

// Checks that the documented parameters are exactly the ones the server validates, with the
// same length limits, patterns and defaults.
function expectParametersMatch(spec, operationId, location, rules) {
  const params = parametersOf(spec, operationId, location);
  expect(params.map(p => p.name).sort()).toEqual(Object.keys(rules).sort());
  for (const p of params) {
    const rule = rules[p.name];
    expect({ name: p.name, maxLength: p.schema.maxLength })
      .toEqual({ name: p.name, maxLength: rule.maxLength });
    expect({ name: p.name, pattern: new RegExp(p.schema.pattern).source })
      .toEqual({ name: p.name, pattern: rule.pattern.source });
    if (rule.default !== undefined) {
      expect({ name: p.name, default: p.schema.default }).toEqual({ name: p.name, default: rule.default });
    }
  }
}

describe('package server OpenAPI description', () => {
  const spec = openapi.getSpec();

  describe('the document', () => {
    describeSpecBasics(spec, packageJson);
  });

  describe('agreement with the router', () => {
    const module = makeModule();

    describeRouterAgreement(spec, module.router, EXCLUDED);

    test('search parameters match the server validation rules', () => {
      expectParametersMatch(spec, 'searchCatalog', 'query', PackagesModule.QUERY_PARAMS.search);
      expectParametersMatch(spec, 'searchV1', 'query', PackagesModule.QUERY_PARAMS.v1Search);
    });

    test('updates parameters match the server validation rules', () => {
      expectParametersMatch(spec, 'listUpdates', 'query', PackagesModule.QUERY_PARAMS.updates);
    });

    test('broken-dependency parameters match the server validation rules', () => {
      expectParametersMatch(spec, 'listBrokenDependencies', 'query', PackagesModule.QUERY_PARAMS.broken);
    });

    test('download path parameters match the server validation rules', () => {
      expectParametersMatch(spec, 'downloadPackage', 'path', PackagesModule.PATH_PARAMS);
    });
  });

  describe('serving', () => {
    const app = makeApp(makeModule());

    test('GET /packages/openapi.json returns the description', async () => {
      const res = await request(app).get('/packages/openapi.json');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.openapi).toBe(spec.openapi);
      expect(Object.keys(res.body.paths)).toEqual(Object.keys(spec.paths));
    });

    test('GET /packages/openapi.yaml returns the YAML source', async () => {
      const res = await request(app).get('/packages/openapi.yaml');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/yaml/);
      expect(res.text).toContain('openapi: 3.1');
    });

    test('GET /packages/openapi returns JSON to a non-browser client', async () => {
      const res = await request(app).get('/packages/openapi').set('Accept', 'application/json');
      expect(res.status).toBe(200);
      expect(res.body.info.title).toBe(spec.info.title);
    });

    test('the HTML reference lists every operation', () => {
      const html = openapi.renderHtml();
      for (const { op } of Object.values(operations(spec))) {
        expect(html).toContain(`id="${op.operationId}"`);
      }
    });

    test('callers cannot modify the cached description', () => {
      openapi.getSpec().info.title = 'changed';
      expect(openapi.getSpec().info.title).toBe(spec.info.title);
    });
  });

  // Regression: /:id is registered before these routes and used to return without
  // calling next(), so they never responded.
  describe('routes registered after /:id', () => {
    const app = makeApp(makeModule());

    test('GET /packages/status responds', async () => {
      const res = await request(app).get('/packages/status').timeout(5000);
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('/nonexistent');
    });

    test('GET /packages/search responds', async () => {
      const res = await request(app).get('/packages/search').set('Accept', 'application/json').timeout(5000);
      expect(res.status).toBe(200);
    });
  });
});

describe('discovery', () => {
  const app = makeApp(makeModule());

  test('responses carry a Link header pointing at the description', async () => {
    const res = await request(app).get('/packages/openapi.json');
    expect(res.headers.link).toContain('</packages/openapi.json>; rel="service-desc"');
    expect(res.headers.link).toContain('</packages/openapi>; rel="service-doc"');
  });

  test('the packages page template links to the API reference and the description', () => {
    const template = require('fs').readFileSync(require('path').join(__dirname, '../../packages/packages-template.html'), 'utf8');
    expect(template).toContain('href="/packages/openapi"');
    expect(template).toContain('rel="service-desc"');
  });
});

describe('page footer version', () => {
  test('[%ver%] is the FHIRsmith version, whatever the caller passes', () => {
    const htmlServer = require('../../library/html-server');
    htmlServer.loadTemplate('ver-test', require('path').join(__dirname, '../../packages/packages-template.html'));
    const html = htmlServer.renderPage('ver-test', 'Test', '<p>x</p>', { version: '4.0.1' });
    expect(html).toContain(`FHIRsmith</a> ${packageJson.version}`);
    expect(html).not.toContain('FHIRsmith</a> 4.0.1');
  });
});
