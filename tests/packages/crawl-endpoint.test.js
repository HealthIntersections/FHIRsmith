// POST /packages/crawl: for a user with the packages "crawl" role (an API token, from a scheduled
// job), as Authorization: Bearer, or the x-crawl-token header that used to carry the shared token

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const PackagesModule = require('../../packages/packages');
const { setupAuth, makeUser, tokenFor } = require('../helpers/auth');

describe('POST /packages/crawl', () => {
  let tmp;
  let module;
  let app;
  let crawler;
  let other;
  let runs;
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-endpoint-'));
    setupAuth();
    crawler = tokenFor(await makeUser('cron-job', null, { roles: [['packages', 'crawl']] }));
    other = tokenFor(await makeUser('someone', null));
    module = new PackagesModule({ countRequest() {} });
    await module.initialize({
      database: path.join(tmp, 'packages.db'),
      mirrorPath: path.join(tmp, 'mirror'),
      masterUrl: 'http://127.0.0.1:1/unused',
      crawler: { enabled: false },
      npmSigning: { enabled: false },
      crawlToken: 'the-old-shared-token'
    });
    runs = 0;
    module.runCrawler = async () => { runs++; };
    app = express();
    app.use('/packages', module.router);
  });
  afterAll(async () => {
    await module.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a crawler\'s token starts a crawl, as Bearer or in x-crawl-token', async () => {
    expect((await request(app).post('/packages/crawl').set('Authorization', `Bearer ${crawler}`)).status).toBe(200);
    expect((await request(app).post('/packages/crawl').set('x-crawl-token', crawler)).status).toBe(200);
    expect(runs).toBe(2);
  });

  test('nobody else: not the old shared token, not a user without the role', async () => {
    expect((await request(app).post('/packages/crawl')).status).toBe(401);
    expect((await request(app).post('/packages/crawl').set('x-crawl-token', 'the-old-shared-token')).status).toBe(401);
    const r = await request(app).post('/packages/crawl').set('Authorization', `Bearer ${other}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/^forbidden/);
    expect(runs).toBe(2);
  });
});
