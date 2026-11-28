//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// The /tester module: the pages, the queue (one run at a time, one per person), the token
// (used, never shown, gone when the run ends), the report and its upload, and the addresses
// it will test.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const request = require('supertest');
const { ADMIN_PASSWORD, setupAuth, mountAuth, makeUser, login, csrfOf, auth } = require('../helpers/auth');
const { makeApp: makeRest } = require('../rest/helpers');
const TesterModule = require('../../tester/tester');
const TestingModule = require('../../testing/testing');
const { XmlModel } = require('../../library/fhir-model');
const htmlServer = require('../../library/html-server');
const { count } = require('../../tester/suite');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
htmlServer.useLog(quiet);

const DEFINITIONS = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/rest/r4-definitions.json'), 'utf8'));
const TOKEN = 's3cret-bearer-token-for-the-run';

function makeStats() {
  return { countRequest() {}, addTask() {}, taskDone() {}, taskError() {} };
}

describe('the tester module', () => {
  let rest;
  let restBase;
  let app;
  let server;
  let tester;
  let testing;
  let dir;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tester-'));
    // the server under test: writes need the token
    rest = await makeRest('sqlite', {
      principal: async (req) => (req.headers.authorization === `Bearer ${TOKEN}` ? { id: 1, login: 'client', isAdmin: true, has: () => true, scopes: () => [''] }
        : { id: 2, login: 'reader', isAdmin: false, has: (m, role) => role === 'read', scopes: () => [''] })
    });
    restBase = `http://127.0.0.1:${rest.app.address().port}/r4`;
    // the tester, and a /testing module to send reports to, on one app
    app = express();
    setupAuth();
    await makeUser('admin', ADMIN_PASSWORD, { admin: true });
    await makeUser('alice', 'alice-password-long-enough');
    await makeUser('bob', 'bob-password-long-enough');
    mountAuth(app);
    app.use(express.raw({ type: 'application/fhir+json', limit: '5mb' }));
    testing = new TestingModule(makeStats(), quiet);
    await testing.initialize({ database: ':memory:', rateLimit: { max: 0 } });
    app.use('/testing', testing.router);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.TESTER_TEST_TOKEN = 'repository-token';
    tester = new TesterModule(makeStats(), quiet);
    await tester.initialize({ database: path.join(dir, 'tester.db'), allowPrivateAddresses: true,
      reportServer: `http://127.0.0.1:${server.address().port}/testing`, reportTokenEnv: 'TESTER_TEST_TOKEN' },
    { xmlModel: async () => new XmlModel(DEFINITIONS.xml), queueMs: 60 * 60 * 1000, autoStart: false });
    app.use('/tester', tester.router);
  }, 60000);

  afterAll(async () => {
    await tester.shutdown();
    await testing.shutdown();
    await new Promise(resolve => server.close(resolve));
    await rest.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Log in, and the CSRF token for the tester's forms */
  async function as(name, password) {
    const { agent } = await login(app, name, password);
    const csrf = await csrfOf(agent, '/tester');
    return { agent, csrf };
  }

  /** Wait for the run under way to finish */
  async function finish() {
    for (let i = 0; i < 100 && (tester.current || tester.store.nextQueued()); i++) {
      if (tester.current) {
        await tester.current.done;
      } else {
        tester.next();
      }
    }
  }

  test('someone not logged in sees the runs, and is asked to log in to run the tests', async () => {
    const page = await request(app).get('/tester');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Log in</a> to run the tests');
    expect(page.text).not.toContain('name="server"');
    expect(page.text).toContain(`There are ${count()} tests`);
    const post = await request(app).post('/tester/run').type('form').send({ server: restBase });
    expect(post.status).toBe(403);
  });

  test('addresses: http(s), no credentials, no query', async () => {
    const { agent, csrf } = await as('alice', 'alice-password-long-enough');
    for (const [server, why] of [['not a url', 'a URL'], ['ftp://example.org/fhir', 'http: or https:'],
      ['https://u:p@example.org/fhir', 'user name or password'], ['https://example.org/fhir?x=1', 'no query']]) {
      const r = await agent.post('/tester/run').type('form').send({ server, _csrf: csrf });
      expect(r.status).toBe(400);
      expect(r.text).toContain(why);
    }
    expect(tester.store.count()).toBe(0);
  });

  test('a private address is refused, unless allowed', async () => {
    tester.allowPrivate = false;
    try {
      expect(await tester.checkServer('http://127.0.0.1:8080/fhir')).toMatch(/isn't a public one/);
      expect(await tester.checkServer('http://10.1.2.3/fhir')).toMatch(/isn't a public one/);
      expect(await tester.checkServer('http://[::1]/fhir')).toMatch(/isn't a public one/);
      expect(await tester.checkServer('http://localhost/fhir')).toMatch(/isn't a public one/);
      expect(await tester.checkServer('https://no-such-host.invalid/fhir')).toMatch(/can't be found/);
    } finally {
      tester.allowPrivate = true;
    }
  });

  test('a run: queued, run with the token, every test passes, the report is sent, and the token is gone', async () => {
    const { agent, csrf } = await as('alice', 'alice-password-long-enough');
    const r = await agent.post('/tester/run').type('form').send({ server: restBase + '/', token: TOKEN, _csrf: csrf });
    expect(r.status).toBe(303);
    const id = r.headers.location.split('/').pop();
    expect(tester.store.get(id).Status).toBe('queued');
    // one per person
    const again = await agent.post('/tester/run').type('form').send({ server: restBase, _csrf: csrf });
    expect(again.status).toBe(409);
    const waiting = await request(app).get(`/tester/runs/${id}`);
    expect(waiting.text).toContain('queued');
    expect(waiting.text).toContain('http-equiv="refresh"');
    await finish();
    const run = tester.store.get(id);
    expect(run.Status).toBe('completed');
    expect(run.Server).toBe(restBase);
    expect(run.FhirVersion).toBe('4.0.1');
    expect(run.Fail + run.Error).toBe(0);
    expect(run.Pass).toBeGreaterThan(50);
    // gone from the database
    expect(tester.store.db.prepare('SELECT Token FROM Runs WHERE Id = ?').get(id).Token).toBeNull();
    // the page shows the results, and never the token
    const page = await request(app).get(`/tester/runs/${id}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Create, read, update, delete');
    expect(page.text).toContain('TestReport (JSON)');
    expect(page.text).not.toContain(TOKEN);
    expect(page.text).not.toContain('http-equiv="refresh"');
    // each test's page: what it made to test with (setup), and the requests and responses
    const vread = tester.store.results(id).find(x => x.Name === 'vread: a version, as it was');
    expect(vread.Outcome).toBe('pass');
    expect(page.text).toContain(`/tester/runs/${id}/tests/${vread.Seq}`);
    const detail = tester.store.result(id, vread.Seq);
    expect(detail.Resources).toHaveLength(1);
    expect(detail.Resources[0].type).toBe('Patient');
    expect(detail.Exchanges.map(x => `${x.phase} ${x.request.method}`)).toEqual(['setup POST', 'setup PUT', 'test GET', 'test GET']);
    const testPage = await request(app).get(`/tester/runs/${id}/tests/${vread.Seq}`);
    expect(testPage.status).toBe(200);
    expect(testPage.text).toContain('What the test made to test with');
    expect(testPage.text).toContain(`Patient/${detail.Resources[0].id}`);
    expect(testPage.text).toContain('<i>(setup)</i>');
    expect(testPage.text).toContain('Bearer (the run&#39;s token)');
    expect(testPage.text).not.toContain(TOKEN);
    expect((await request(app).get(`/tester/runs/${id}/tests/9999`)).status).toBe(404);
    expect((await request(app).get(`/tester/runs/${id}/tests/x`)).status).toBe(404);
    const list = await request(app).get('/tester');
    expect(list.text).toContain(restBase);
    expect(list.text).toContain('alice');
    // the report
    const rep = await request(app).get(`/tester/runs/${id}/report`);
    expect(rep.status).toBe(200);
    const report = JSON.parse(rep.text);
    expect(report.resourceType).toBe('TestReport');
    expect(report.result).toBe('pass');
    expect(report.participant[1]).toMatchObject({ type: 'server', uri: restBase, version: '4.0.1' });
    expect(report.test).toHaveLength(count());
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    // sent to the repository
    expect(run.UploadError).toBeNull();
    expect(run.Uploaded).toMatch(/\/testing\/TestReport\//);
    expect(testing.store.count()).toBe(1);
  }, 120000);

  test('without the token the server refuses the writes (it lets anyone read): the tests fail, and say so', async () => {
    const { agent, csrf } = await as('bob', 'bob-password-long-enough');
    const r = await agent.post('/tester/run').type('form').send({ server: restBase, _csrf: csrf });
    const id = r.headers.location.split('/').pop();
    await finish();
    const run = tester.store.get(id);
    expect(run.Status).toBe('completed');
    expect(run.Fail).toBeGreaterThan(0);
    const results = tester.store.results(id);
    const listed = results.find(x => x.Name === 'create: 201, Location, and the resource as stored');
    expect(listed.Outcome).toBe('fail');
    expect(listed.Message).toMatch(/answered 403/);
    // what happened is kept
    const create = tester.store.result(id, listed.Seq);
    expect(create.Exchanges[0].request.method).toBe('POST');
    expect(create.Exchanges[0].response.status).toBe(403);
    const page = await request(app).get(`/tester/runs/${id}/tests/${listed.Seq}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Requests and responses');
    expect(page.text).toContain('403');
    expect(JSON.parse(run.Report).result).toBe('fail');
  }, 120000);

  test('cancelling: a queued run at once; only who asked for it, or an administrator', async () => {
    const alice = await as('alice', 'alice-password-long-enough');
    const r = await alice.agent.post('/tester/run').type('form').send({ server: restBase, _csrf: alice.csrf });
    const id = r.headers.location.split('/').pop();
    const bob = await as('bob', 'bob-password-long-enough');
    const page = await bob.agent.get(`/tester/runs/${id}`);
    expect(page.text).not.toContain('Cancel the run');
    expect((await bob.agent.post(`/tester/runs/${id}/cancel`).type('form').send({ _csrf: bob.csrf })).status).toBe(403);
    expect((await alice.agent.get(`/tester/runs/${id}`)).text).toContain('Cancel the run');
    expect((await alice.agent.post(`/tester/runs/${id}/cancel`).type('form').send({ _csrf: alice.csrf })).status).toBe(303);
    const run = tester.store.get(id);
    expect(run.Status).toBe('cancelled');
    expect(tester.store.db.prepare('SELECT Token FROM Runs WHERE Id = ?').get(id).Token).toBeNull();
    expect(tester.next()).toBeNull();
  });

  test('cancelling a run under way: it stops, and cleans up', async () => {
    const admin = await as('admin', ADMIN_PASSWORD);
    const bob = await as('bob', 'bob-password-long-enough');
    const r = await bob.agent.post('/tester/run').type('form').send({ server: restBase, token: TOKEN, _csrf: bob.csrf });
    const id = r.headers.location.split('/').pop();
    const done = tester.next();
    // (one at a time)
    expect(tester.next()).toBeNull();
    // cancelled as soon as the first test is done (a fixed wait can be long enough, on a fast
    // machine, for the whole run to finish first)
    for (let i = 0; i < 400 && !tester.store.results(id).length; i++) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(tester.store.results(id).length).toBeGreaterThan(0);
    expect((await admin.agent.post(`/tester/runs/${id}/cancel`).type('form').send({ _csrf: admin.csrf })).status).toBe(303);
    await done;
    const run = tester.store.get(id);
    expect(run.Status).toBe('cancelled');
    expect(run.Message).toBe('The run was cancelled');
    expect(run.Skip).toBeGreaterThan(0);
    const cleanup = JSON.parse(run.Cleanup);
    expect(cleanup.left).toEqual([]);
    expect(cleanup.deleted).toBe(cleanup.created);
    // a cancelled run's report isn't sent
    expect(run.Uploaded).toBeNull();
  }, 120000);

  test('a server that isn\'t a FHIR server: the run ends with why', async () => {
    const { agent, csrf } = await as('alice', 'alice-password-long-enough');
    const r = await agent.post('/tester/run').type('form').send({ server: `http://127.0.0.1:${server.address().port}/nothing`, _csrf: csrf });
    const id = r.headers.location.split('/').pop();
    await finish();
    const run = tester.store.get(id);
    expect(run.Status).toBe('error');
    expect(run.Message).toMatch(/didn't return a CapabilityStatement \(the answer was 404/);
  });

  test('a run under way when the server stopped is marked interrupted, without its token', async () => {
    tester.store.queue({ id: 'lost-run', server: restBase, token: 'x', userId: 99, userName: 'carol' });
    tester.store.started('lost-run');
    expect(tester.store.interrupted()).toBe(1);
    const run = tester.store.get('lost-run');
    expect(run.Status).toBe('interrupted');
    expect(tester.store.db.prepare('SELECT Token FROM Runs WHERE Id = ?').get('lost-run').Token).toBeNull();
  });

  test('old runs are deleted', () => {
    const before = tester.store.count();
    tester.store.db.prepare('UPDATE Runs SET Finished = 1000 WHERE Id = ?').run('lost-run');
    tester.purge();
    expect(tester.store.count()).toBe(before - 1);
    expect(tester.store.get('lost-run')).toBeNull();
  });

  test('no token in the database for any run that is over', () => {
    expect(tester.store.db.prepare("SELECT COUNT(*) AS N FROM Runs WHERE Token IS NOT NULL AND Status NOT IN ('queued', 'running')").get().N).toBe(0);
    expect(auth.store).toBeTruthy();
  });
});
