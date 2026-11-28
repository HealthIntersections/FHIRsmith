//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// The tester module's npm registry runs (/tester?kind=npm): the form, the queue, each check as
// a test with the requests it was based on, the token (sent only to the registry), the report
// and its upload, and the SSRF rules - against this server's packages module, run locally.

const http = require('http');
const express = require('express');
const request = require('supertest');
const { ADMIN_PASSWORD, setupAuth, mountAuth, makeUser, login, csrfOf } = require('../helpers/auth');
const TesterModule = require('../../tester/tester');
const TestingModule = require('../../testing/testing');
const htmlServer = require('../../library/html-server');
const { CHECKS } = require('../../tester/npm/checks');
const { PKG, startLocalRegistry } = require('../packages/npm-registry-fixtures');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
htmlServer.useLog(quiet);

const TOKEN = 'npm-registry-token-for-the-run';

function makeStats() {
  return { countRequest() {}, addTask() {}, taskDone() {}, taskError() {} };
}

describe('the tester module: npm registries', () => {
  let registry;
  let app;
  let server;
  let tester;
  let testing;

  beforeAll(async () => {
    registry = await startLocalRegistry();
    app = express();
    setupAuth();
    await makeUser('admin', ADMIN_PASSWORD, { admin: true });
    await makeUser('carol', 'carol-password-long-enough');
    await makeUser('dave', 'dave-password-long-enough');
    mountAuth(app);
    app.use(express.raw({ type: 'application/fhir+json', limit: '5mb' }));
    testing = new TestingModule(makeStats(), quiet);
    await testing.initialize({ database: ':memory:', rateLimit: { max: 0 } });
    app.use('/testing', testing.router);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    tester = new TesterModule(makeStats(), quiet);
    await tester.initialize({ database: ':memory:', allowPrivateAddresses: true, reportServer: `http://127.0.0.1:${server.address().port}/testing`,
      npm: { control: false } }, { queueMs: 60 * 60 * 1000, autoStart: false });
    app.use('/tester', tester.router);
  }, 60000);

  afterAll(async () => {
    await tester.shutdown();
    await testing.shutdown();
    await new Promise(resolve => server.close(resolve));
    await registry.close();
  });

  async function as(name, password) {
    const { agent } = await login(app, name, password);
    const csrf = await csrfOf(agent, '/tester');
    return { agent, csrf };
  }

  async function finish() {
    for (let i = 0; i < 100 && (tester.current || tester.store.nextQueued()); i++) {
      if (tester.current) {
        await tester.current.done;
      } else {
        tester.next();
      }
    }
  }

  test('the form for a registry: the registry, a package and version, and a token', async () => {
    const { agent } = await as('carol', 'carol-password-long-enough');
    const page = await agent.get('/tester?kind=npm&server=https%3A%2F%2Fregistry.example.org&package=a.b&version=1.2.3');
    expect(page.status).toBe(200);
    expect(page.text).toContain('npm registry protocol');
    expect(page.text).toContain('name="kind" value="npm"');
    expect(page.text).toContain('value="https://registry.example.org"');
    expect(page.text).toContain('name="package"');
    expect(page.text).toContain('value="a.b"');
    expect(page.text).toContain('value="1.2.3"');
    expect(page.text).toContain('Run the checks');
    // the FHIR form has no package
    const fhir = await agent.get('/tester');
    expect(fhir.text).toContain('name="kind" value="fhir"');
    expect(fhir.text).not.toContain('name="package"');
    expect(fhir.text).toContain('href="/tester?kind=npm"');
  });

  test('the package and version are needed, and must look like them', async () => {
    const { agent, csrf } = await as('carol', 'carol-password-long-enough');
    for (const [fields, why] of [[{ package: '', version: '1.0.0' }, 'name of a package'], [{ package: PKG, version: '' }, 'version of the package'],
      [{ package: 'no spaces allowed', version: '1.0.0' }, 'name of a package'], [{ package: PKG, version: '1.0.0<script>' }, 'version of the package']]) {
      const r = await agent.post('/tester/run').type('form').send({ kind: 'npm', server: registry.base, ...fields, _csrf: csrf });
      expect(r.status).toBe(400);
      expect(r.text).toContain(why);
    }
    expect(tester.store.count()).toBe(0);
  });

  test('a run: queued, every check is a test that passes, with its requests; a report, sent; the token sent only to the registry, then gone', async () => {
    const { agent, csrf } = await as('carol', 'carol-password-long-enough');
    const tokens = [];
    const original = registry.module.router.handle.bind(registry.module.router);
    registry.module.router.handle = (req, res, next) => {
      tokens.push(req.headers.authorization || null);
      return original(req, res, next);
    };
    let id;
    try {
      const r = await agent.post('/tester/run').type('form').send({ kind: 'npm', server: registry.base + '/', package: PKG, version: '1.0.0', token: TOKEN, _csrf: csrf });
      expect(r.status).toBe(303);
      id = r.headers.location.split('/').pop();
      const queued = tester.store.get(id);
      expect(queued).toMatchObject({ Status: 'queued', Kind: 'npm', Package: PKG, Version: '1.0.0', Server: registry.base });
      await finish();
    } finally {
      registry.module.router.handle = original;
    }
    expect(tokens.length).toBeGreaterThan(5);
    expect(tokens.every(t => t === `Bearer ${TOKEN}`)).toBe(true);
    const run = tester.store.get(id);
    expect(run.Status).toBe('completed');
    expect(run.Fail + run.Error).toBe(0);
    expect(run.Pass).toBe(CHECKS.length);
    expect(tester.store.db.prepare('SELECT Token FROM Runs WHERE Id = ?').get(id).Token).toBeNull();

    // the run's page: a group per step, the package, and no token
    const page = await request(app).get(`/tester/runs/${id}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('npm registry');
    expect(page.text).toContain(`${PKG}#1.0.0`);
    expect(page.text).toContain('1. Search: GET /-/v1/search?text={name}');
    expect(page.text).toContain('4. Tarball');
    expect(page.text).not.toContain(TOKEN);
    // a check's page: the requests it was based on
    const results = tester.store.results(id);
    const sums = results.find(x => x.Name === 'matches the checksums in the package document');
    const detail = tester.store.result(id, sums.Seq);
    const urls = detail.Exchanges.map(x => x.request.url);
    expect(urls).toHaveLength(2);
    expect(urls).toContain(`${registry.base}/${PKG}`);
    expect(urls.some(u => /\.tgz$|\/1\.0\.0$/.test(u))).toBe(true);
    const testPage = await request(app).get(`/tester/runs/${id}/tests/${sums.Seq}`);
    expect(testPage.status).toBe(200);
    expect(testPage.text).toContain('Requests and responses');
    expect(testPage.text).toMatch(/bytes of application\/(octet-stream|gzip|x-gzip|tar\+gzip)[^:]*: not shown/);
    expect(testPage.text).toContain('&quot;dist-tags&quot;');
    expect(testPage.text).not.toContain(TOKEN);
    // the list
    const list = await request(app).get('/tester');
    expect(list.text).toContain(registry.base);
    expect(list.text).toContain('npm registry');

    // the report, and its upload
    const report = JSON.parse((await request(app).get(`/tester/runs/${id}/report`)).text);
    expect(report).toMatchObject({ resourceType: 'TestReport', name: 'FHIRsmith npm registry tests', result: 'pass' });
    expect(report.testScript).toMatch(/\/tester\/npm\|/);
    expect(report.participant[1]).toMatchObject({ type: 'server', uri: registry.base, display: `npm registry, tested with ${PKG}#1.0.0` });
    expect(report.test).toHaveLength(CHECKS.length);
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    expect(run.UploadError).toBeNull();
    expect(run.Uploaded).toMatch(/\/testing\/TestReport\//);
  }, 60000);

  test('a version the registry hasn\'t got: the checks about it fail, and say why', async () => {
    const { agent, csrf } = await as('dave', 'dave-password-long-enough');
    const r = await agent.post('/tester/run').type('form').send({ kind: 'npm', server: registry.base, package: PKG, version: '0.5.0', _csrf: csrf });
    const id = r.headers.location.split('/').pop();
    await finish();
    const run = tester.store.get(id);
    expect(run.Status).toBe('completed');
    expect(run.Fail).toBeGreaterThan(0);
    const names = tester.store.results(id).find(x => x.Name.startsWith('names the package'));
    expect(names).toMatchObject({ Outcome: 'fail', Message: 'version 0.5.0 is not in the document' });
    expect(tester.store.result(id, names.Seq).Exchanges[0].request.url).toBe(`${registry.base}/${PKG}`);
    expect(JSON.parse(run.Report).result).toBe('fail');
  }, 60000);

  test('the registry\'s address must be public, unless allowPrivateAddresses', async () => {
    tester.allowPrivate = false;
    try {
      const { agent, csrf } = await as('dave', 'dave-password-long-enough');
      const r = await agent.post('/tester/run').type('form').send({ kind: 'npm', server: registry.base, package: PKG, version: '1.0.0', _csrf: csrf });
      expect(r.status).toBe(400);
      expect(r.text).toContain('isn&#39;t a public one');
    } finally {
      tester.allowPrivate = true;
    }
  });

  test('a response bigger than maxDownloadMB isn\'t read', async () => {
    const saved = tester.npm;
    tester.npm = { ...saved, maxDownloadMB: 0.0001 };
    try {
      const { agent, csrf } = await as('dave', 'dave-password-long-enough');
      const r = await agent.post('/tester/run').type('form').send({ kind: 'npm', server: registry.base, package: PKG, version: '1.0.0', _csrf: csrf });
      const id = r.headers.location.split('/').pop();
      await finish();
      const first = tester.store.results(id)[0];
      expect(first.Outcome).toBe('fail');
      expect(first.Message).toBe('the request failed: the response is too large');
    } finally {
      tester.npm = saved;
    }
  }, 60000);

  test('the npm checks turned off: no form, and a run is refused', async () => {
    const saved = tester.npm;
    tester.npm = { ...saved, enabled: false };
    try {
      const { agent, csrf } = await as('dave', 'dave-password-long-enough');
      const page = await agent.get('/tester?kind=npm');
      expect(page.text).not.toContain('name="package"');
      expect(page.text).not.toContain('kind=npm');
      const r = await agent.post('/tester/run').type('form').send({ kind: 'npm', server: registry.base, package: PKG, version: '1.0.0', _csrf: csrf });
      expect(r.status).toBe(404);
    } finally {
      tester.npm = saved;
    }
  });

  test('the control: what the npm registry itself makes of the checks is shown on the npm pages', () => {
    const { controlSummary } = require('../../tester/render');
    const control = { registry: 'https://registry.npmjs.org', package: 'fhirpath', version: '3.15.0' };
    expect(controlSummary(null, null)).toBe('');
    expect(controlSummary(control, null)).toContain('hasn\'t finished yet');
    const report = { passed: 20, failed: 1, finished: '2026-11-28T00:00:00Z', steps: [{ title: '1. Search', checks: [{ status: 'fail', title: 'from skips results', message: 'it didn\'t' }] }] };
    const html = controlSummary(control, report);
    expect(html).toContain('1 of 21 failed');
    expect(html).toContain('from skips results');
    expect(controlSummary(control, { ...report, failed: 0, passed: 21 })).toContain('all 21 passed');
  });
});
