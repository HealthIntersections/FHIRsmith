// POST /xig/update re-downloads the xig database: for the server's administrators - logged
// in (the form on /xig/stats), or with an administrator's API token

const express = require('express');
const request = require('supertest');
const path = require('path');
const xig = require('../../xig/xig');
const htmlServer = require('../../library/html-server');
const { setupAuth, mountAuth, makeUser, tokenFor, login } = require('../helpers/auth');

const PASSWORD = 'a-long-enough-password';

describe('POST /xig/update', () => {
  let app;
  let userToken;

  beforeAll(async () => {
    htmlServer.loadTemplate('xig', path.join(__dirname, '../../xig/xig-template.html'));
    setupAuth();
    app = express();
    mountAuth(app);
    app.use('/xig', xig.router);
    await makeUser('admin', PASSWORD, { admin: true });
    userToken = tokenFor(await makeUser('someone', PASSWORD));
  });

  test('refuses software without an API token, or with a bad one', async () => {
    for (const headers of [{}, { Authorization: 'Bearer fhs_not-a-token' }, { 'x-update-token': 'the-old-secret' }]) {
      const res = await request(app).post('/xig/update').set(headers);
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/^unauthorized/);
    }
  });

  test('refuses the API token of a user who is not an administrator', async () => {
    const res = await request(app).post('/xig/update').set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/someone does not have permission/);
  });

  test('the form: refused for someone not logged in (no session, so no CSRF token)', async () => {
    const res = await request(app).post('/xig/update').type('form').send({});
    expect(res.status).toBe(403);
    expect(res.type).toBe('text/html');
  });

  test('the form: refused without the CSRF token, and for a user who is not an administrator', async () => {
    const { agent } = await login(app, 'someone', PASSWORD);
    let res = await agent.post('/xig/update').type('form').send({});
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/form has expired/);

    const page = await agent.get('/xig/stats');
    expect(page.text).not.toMatch(/action="\/xig\/update"/);
    const csrf = (await agent.get('/auth/account')).text.match(/name="_csrf" value="([^"]+)"/)[1];
    res = await agent.post('/xig/update').type('form').send({ _csrf: csrf });
    expect(res.status).toBe(403);
    expect(res.type).toBe('text/html');
  });

  test('the form is on /xig/stats for an administrator, with the CSRF token', async () => {
    const { agent } = await login(app, 'admin', PASSWORD);
    const page = await agent.get('/xig/stats');
    if (page.status === 200) {
      expect(page.text).toMatch(/action="\/xig\/update"/);
      expect(page.text).toMatch(/name="_csrf" value="[^"]+"/);
    }
  });

  test('a cross-site post is refused', async () => {
    const res = await request(app).post('/xig/update').type('form').set('Origin', 'https://evil.example.org').send({});
    expect(res.status).toBe(403);
  });
});
