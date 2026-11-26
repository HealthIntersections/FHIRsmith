// Starting a crawl: for the server's administrators, logged in - "Start a crawl" on /packages/log,
// a form post to /packages/crawl (same origin, the session, its CSRF token). No API tokens, no role,
// and not the old shared token (modules.packages.crawlToken)

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const PackagesModule = require('../../packages/packages');
const { ADMIN_PASSWORD, setupAuth, mountAuth, makeUser, tokenFor, login } = require('../helpers/auth');

describe('starting a crawl', () => {
  let tmp;
  let module;
  let app;
  let admin;
  let someone;
  let adminToken;
  let runs;
  let finish;
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-endpoint-'));
    setupAuth();
    const adminId = await makeUser('admin', ADMIN_PASSWORD, { admin: true });
    await makeUser('someone', 'someone-password');
    adminToken = tokenFor(adminId);
    module = new PackagesModule({ countRequest() {}, addTask() {} });
    await module.initialize({
      database: path.join(tmp, 'packages.db'),
      mirrorPath: path.join(tmp, 'mirror'),
      masterUrl: 'http://127.0.0.1:1/unused',
      crawler: { enabled: false },
      npmSigning: { enabled: false },
      crawlToken: 'the-old-shared-token'
    });
    runs = 0;
    // a crawl that runs until the test says it's done
    module.runCrawler = () => {
      runs++;
      module.crawlerRunning = true;
      return new Promise(resolve => {
        finish = () => { module.crawlerRunning = false; resolve(); };
      });
    };
    app = express();
    mountAuth(app);
    app.use('/packages', module.router);
    admin = (await login(app, 'admin', ADMIN_PASSWORD)).agent;
    someone = (await login(app, 'someone', 'someone-password')).agent;
  });
  afterAll(async () => {
    await module.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const html = agent => agent.get('/packages/log').set('Accept', 'text/html');
  // the CSRF token of the agent's session, from the log page's form
  const csrfOf = async agent => ((await html(agent)).text.match(/name="_csrf" value="([^"]+)"/) || [])[1];

  test('the log page offers an administrator "Start a crawl", and nobody else', async () => {
    const page = await html(admin);
    expect(page.status).toBe(200);
    expect(page.text).toContain('action="/packages/crawl"');
    expect(page.text).toMatch(/name="_csrf" value="[^"]+"/);
    for (const agent of [someone, request.agent(app)]) {
      const r = await html(agent);
      expect(r.status).toBe(200);
      expect(r.text).not.toContain('action="/packages/crawl"');
      expect(r.text).toContain('log in');
    }
  });

  test('an administrator starts a crawl, which runs in the background; not a second while it runs', async () => {
    const _csrf = await csrfOf(admin);
    const r = await admin.post('/packages/crawl').type('form').send({ _csrf });
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe('/packages/log?started');
    expect(runs).toBe(1);
    const page = await admin.get('/packages/log?started').set('Accept', 'text/html');
    expect(page.text).toContain('Crawl started');
    expect(page.text).toContain('Crawler is currently running');
    expect(page.text).not.toContain('action="/packages/crawl"');

    const again = await admin.post('/packages/crawl').type('form').send({ _csrf });
    expect(again.status).toBe(303);
    expect(again.headers.location).toBe('/packages/log');
    expect(runs).toBe(1);
    finish();
  });

  test('not without the CSRF token, nor from another site', async () => {
    const _csrf = await csrfOf(admin);
    expect((await admin.post('/packages/crawl').type('form').send({})).status).toBe(403);
    expect((await admin.post('/packages/crawl').set('Origin', 'https://evil.example').type('form').send({ _csrf })).status).toBe(403);
    expect(runs).toBe(1);
  });

  test('nobody else: not a user who isn\'t an administrator, not an API token, not the old shared token', async () => {
    // a user who isn't an administrator, logged in: the page has no form, but they post anyway
    const page = await someone.get('/auth/login');
    const _csrf = (page.text.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    expect(_csrf).toBeTruthy();
    expect((await someone.post('/packages/crawl').type('form').send({ _csrf })).status).toBe(403);
    // no login (no session, so no CSRF token to match): refused
    expect((await request(app).post('/packages/crawl')).status).toBe(403);
    expect((await request(app).post('/packages/crawl').set('Authorization', `Bearer ${adminToken}`)).status).toBe(403);
    expect((await request(app).post('/packages/crawl').set('x-crawl-token', 'the-old-shared-token')).status).toBe(403);
    expect(runs).toBe(1);
  });
});
