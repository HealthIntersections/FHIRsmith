// Keeps testing/openapi.yaml and the generated openapi-schemas.json honest against the
// module: the routes, the search parameters, the generated schemas being up to date, the
// TestReport schema requiring what validateReport() requires - and real responses
// validating against the schemas.

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const Ajv2020 = require('ajv/dist/2020');

const TestingModule = require('../../testing/testing');
const { validateReport } = require('../../testing/testing');
const { PARAMS, CONTROL } = require('../../testing/search');
const openapi = require('../../testing/openapi');
const config = require('../../testing/openapi-schemas.config');
const { generateSchemas } = require('../../library/fhir-openapi-schema');
const { packageDir } = require('../../utilities/generate-openapi-schemas');
const htmlServer = require('../../library/html-server');
const packageJson = require('../../package.json');
const { parametersOf, describeSpecBasics } = require('../utils/openapi-helpers');

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
htmlServer.useLog(quietLog);

// Routes the spec deliberately does not describe, with the reason.
const EXCLUDED = {
  'GET /': 'the list page (HTML)',
  'GET /summary': 'the summary page (HTML)',
  'DELETE /TestReport/{id}': 'administrative (admin token)',
  'POST /TestReport/{id}/delete': 'administrative (web form)',
  'GET /login': 'login page', 'POST /login': 'login page', 'POST /logout': 'login page',
  'GET /admin/links': 'administration', 'POST /admin/links': 'administration',
  'POST /admin/links/{id}': 'administration', 'POST /admin/links/{id}/delete': 'administration',
  'GET /admin/users': 'administration', 'POST /admin/users': 'administration',
  'POST /admin/users/{id}': 'administration', 'POST /admin/users/{id}/delete': 'administration',
  'GET /openapi': 'the description itself',
  'GET /openapi.json': 'the description itself',
  'GET /openapi.yaml': 'the description itself'
};

function makeStats() {
  return { countRequest() {}, addTask() {}, task() {}, taskDone() {}, taskError() {} };
}

async function makeApp() {
  const app = express();
  app.use(express.raw({ type: 'application/fhir+json', limit: '50mb' }));
  app.use(express.json({ limit: '50mb' }));
  const mod = new TestingModule(makeStats(), quietLog);
  await mod.initialize({ database: ':memory:', rateLimit: { max: 0 } });
  app.use('/testing', mod.router);
  return { app, mod };
}

function report(overrides = {}) {
  return {
    resourceType: 'TestReport',
    name: 'tx-ecosystem',
    status: 'completed',
    testScript: 'http://hl7.org/fhir/uv/tx-ecosystem/TestScript/tx-tests',
    result: 'pass',
    score: 100,
    tester: 'TxTester 1.0',
    issued: '2026-09-20T10:00:00Z',
    participant: [{ type: 'server', uri: 'http://tx.fhir.org/r4' }],
    ...overrides
  };
}

const spec = openapi.getSpec();

// A validator for the spec's component schemas
function validator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addSchema({ $id: 'spec', components: spec.components }, 'spec');
  return (name, value) => {
    const validate = ajv.getSchema(`spec#/components/schemas/${name}`);
    const ok = validate(value);
    return ok ? [] : validate.errors.map(e => `${e.instancePath} ${e.message} ${JSON.stringify(e.params)}`);
  };
}

describe('testing OpenAPI description', () => {
  let app;
  let mod;

  beforeAll(async () => {
    ({ app, mod } = await makeApp());
  });

  afterAll(() => mod.shutdown());

  describe('the document', () => {
    describeSpecBasics(spec, packageJson);
  });

  describe('agreement with the module', () => {
    test('routes', async () => {
      // the router only exists once initialized
      const { mod: m } = await makeApp();
      const routes = require('../utils/openapi-helpers').routerRoutes(m.router);
      const documented = new Set(require('../utils/openapi-helpers').specRoutes(spec));
      expect(routes.filter(r => !documented.has(r) && !EXCLUDED[r])).toEqual([]);
      expect([...documented].filter(r => !routes.includes(r))).toEqual([]);
      await m.shutdown();
    });

    test('search parameters are the ones search.js understands', () => {
      expect(parametersOf(spec, 'searchTestReports', 'query').map(p => p.name).sort())
        .toEqual([...Object.keys(PARAMS), ...CONTROL].sort());
    });

    test('the TestReport schema requires everything validateReport requires', () => {
      const schemas = spec.components.schemas;
      for (const name of ['name', 'status', 'result', 'tester', 'issued', 'participant']) {
        const r = report();
        delete r[name];
        expect({ name, rejected: validateReport(r).length > 0 }).toEqual({ name, rejected: true });
        expect(schemas.TestReport.required).toContain(name);
      }
      expect(validateReport(report({ participant: [] }))).not.toEqual([]);
      expect(schemas.TestReport.properties.participant.minItems).toBe(1);
      expect(validateReport(report({ participant: [{ type: 'server' }] }))).not.toEqual([]);
      expect(schemas.TestReport_Participant.required).toContain('uri');
    });

    test('contained resources are prohibited by both', () => {
      expect(validateReport(report({ contained: [{ resourceType: 'Patient' }] })))
        .toEqual(['TestReport.contained is not allowed: reports may not contain resources']);
      expect(spec.components.schemas.TestReport.properties).not.toHaveProperty('contained');
      expect(spec.components.schemas.TestReport.additionalProperties).toBe(false);
    });
  });

  describe('the generated schemas', () => {
    const dir = packageDir(config.package);
    const havePackage = fs.existsSync(dir);

    (havePackage ? test : test.skip)(`are up to date with openapi-schemas.config.js (needs ${config.package})`, () => {
      const generated = generateSchemas(config, dir);
      const checkedIn = JSON.parse(fs.readFileSync(path.join(__dirname, '../../testing/openapi-schemas.json'), 'utf8'));
      // if this fails: node utilities/generate-openapi-schemas.js testing
      expect(checkedIn).toEqual(generated);
    });

    test('every pattern is a valid unicode regular expression', () => {
      const bad = [];
      const walk = (o, at) => {
        if (o && typeof o === 'object') {
          for (const [k, v] of Object.entries(o)) {
            if (k === 'pattern' && typeof v === 'string') {
              try {
                new RegExp(v, 'u');
              } catch (e) {
                bad.push(`${at}: ${e.message}`);
              }
            } else {
              walk(v, `${at}.${k}`);
            }
          }
        }
      };
      walk(spec.components.schemas, 'schemas');
      expect(bad).toEqual([]);
    });
  });

  describe('validation against the schemas', () => {
    const check = validator();

    test('a complete R5 report is valid', () => {
      expect(check('TestReport', report())).toEqual([]);
    });

    test('an R4 report (testScript as a Reference) is valid', () => {
      expect(check('TestReport', report({ testScript: { reference: 'TestScript/tx-tests' } }))).toEqual([]);
    });

    test('extensions on primitives (_name) are allowed', () => {
      const r = report({
        _name: { extension: [{ url: 'http://example.org/ext', valueString: 'x' }] },
        participant: [{ type: 'server', uri: 'http://tx.fhir.org/r4', _uri: { id: 'p1' } }],
        extension: [{ url: 'http://example.org/ext2', valueBoolean: true }]
      });
      expect(check('TestReport', r)).toEqual([]);
    });

    test('contained resources, unknown properties and bad codes are not', () => {
      expect(check('TestReport', report({ contained: [{ resourceType: 'Patient' }] }))).not.toEqual([]);
      expect(check('TestReport', report({ colour: 'blue' }))).not.toEqual([]);
      expect(check('TestReport', report({ result: 'mostly' }))).not.toEqual([]);
      expect(check('TestReport', report({ participant: [] }))).not.toEqual([]);
    });

    test('an extension must have a url', () => {
      expect(check('TestReport', report({ extension: [{ valueString: 'x' }] }))).not.toEqual([]);
    });

    test('what the server returns validates', async () => {
      const created = await request(app).post('/testing/TestReport')
        .set('Content-Type', 'application/fhir+json').send(JSON.stringify(report()));
      expect(created.status).toBe(201);
      const stored = JSON.parse(created.text);
      expect(check('TestReport', stored)).toEqual([]);

      const read = await request(app).get(`/testing/TestReport/${stored.id}`).set('Accept', 'application/fhir+json');
      expect(check('TestReport', JSON.parse(read.text))).toEqual([]);

      const search = await request(app).get('/testing/TestReport?name=tx&bogus=1').set('Accept', 'application/fhir+json');
      const bundle = JSON.parse(search.text);
      expect(bundle.entry.some(e => e.search.mode === 'outcome')).toBe(true);
      expect(check('TestReportSearchBundle', bundle)).toEqual([]);

      const rejected = await request(app).post('/testing/TestReport')
        .set('Content-Type', 'application/fhir+json').send(JSON.stringify(report({ contained: [] })));
      expect(rejected.status).toBe(400);
      expect(check('OperationOutcome', JSON.parse(rejected.text))).toEqual([]);
    });

    // FHIRsmith's own tx test report, when there is one (it's git-ignored). tx/tests/test-runner.js
    // writes participant.version, test.result and test.period, which are not R5 TestReport
    // elements - an open question (extensions, or allow them?). Anything else wrong fails.
    const txReport = path.join(__dirname, '../../test-cases-report.json');
    const KNOWN = /^\/(participant\/\d+ .*"version"|test\/\d+ .*"(result|period)")/;
    (fs.existsSync(txReport) ? test : test.skip)('the tx test run report is valid, apart from the known extra elements', () => {
      const errors = check('TestReport', JSON.parse(fs.readFileSync(txReport, 'utf8')));
      expect(errors.filter(e => !KNOWN.test(e)).slice(0, 10)).toEqual([]);
    });
  });

  describe('serving and discovery links', () => {
    test('GET /testing/openapi.json returns the description, with the generated schemas', async () => {
      const res = await request(app).get('/testing/openapi.json');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.paths)).toEqual(Object.keys(spec.paths));
      expect(res.body.components.schemas).toHaveProperty('TestReport');
      expect(res.headers.link).toContain('</testing/openapi.json>; rel="service-desc"');
    });

    test('GET /testing/openapi.yaml and /testing/openapi', async () => {
      expect((await request(app).get('/testing/openapi.yaml')).headers['content-type']).toMatch(/application\/yaml/);
      expect((await request(app).get('/testing/openapi').set('Accept', 'application/json')).body.info.title).toBe(spec.info.title);
      const html = await request(app).get('/testing/openapi').set('Accept', 'text/html');
      expect(html.text).toContain('id="createTestReport"');
      expect(html.text).toContain('schema-TestReport');
    });

    test('the page template links to the API reference and the description', () => {
      const template = fs.readFileSync(path.join(__dirname, '../../testing/testing-template.html'), 'utf8');
      expect(template).toContain('href="/testing/openapi"');
      expect(template).toContain('rel="service-desc"');
    });
  });
});
