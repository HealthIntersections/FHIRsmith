// Login for expensive operations (auth.loginForExpensive): who must log in, how they are told,
// the page that explains it, and the count of refusals for the daily report

const express = require('express');
const request = require('supertest');
const { auth, setupAuth, mountAuth, makeUser, tokenFor, login } = require('../helpers/auth');

const PASSWORD = 'a-long-enough-password';

function appWith(handler) {
  const app = express();
  app.set('trust proxy', 'loopback');
  mountAuth(app);
  app.get('/expensive', handler);
  return app;
}

describe('login for expensive operations', () => {
  afterAll(() => auth.shutdown());

  test('off unless configured: no one must log in', async () => {
    setupAuth();
    const app = appWith(async (req, res) => res.json({ mustLogIn: await auth.mustLogIn(req) }));
    expect((await request(app).get('/expensive')).body.mustLogIn).toBe(false);
  });

  describe('on', () => {
    let app;
    let token;
    beforeAll(async () => {
      setupAuth({ loginForExpensive: true, anonymousMaxRows: 500 });
      await makeUser('someone', PASSWORD);
      token = tokenFor(await makeUser('software', PASSWORD));
      app = appWith(async (req, res) => {
        if (await auth.mustLogIn(req)) {
          return auth.refuseAnonymous(req, res, req.query.kind || 'search-page', { as: req.query.as || 'html', back: '/first', hint: req.query.hint });
        }
        res.json({ ok: true });
      });
    });

    test('someone not logged in is told to log in, with a page that says why', async () => {
      const res = await request(app).get('/expensive?_offset=20');
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      expect(res.headers['x-robots-tag']).toBe('noindex');
      expect(res.text).toContain('To see search results past the first page, please log in');
      expect(res.text).toContain('href="/auth/login?return=%2Fexpensive%3F_offset%3D20"');
      expect(res.text).toContain('href="/first"');
      expect(res.text).toContain('href="/auth/why-login"');
    });

    test('the number of rows is the configured one', async () => {
      const res = await request(app).get('/expensive?kind=expansion-rows');
      expect(res.text).toContain('more than 500 rows of a value set expansion');
    });

    test('a token, or a session, is logged in: any account, no role needed', async () => {
      expect((await request(app).get('/expensive').set('Authorization', `Bearer ${token}`)).body).toEqual({ ok: true });
      const { agent } = await login(app, 'someone', PASSWORD);
      expect((await agent.get('/expensive')).body).toEqual({ ok: true });
      expect((await request(app).get('/expensive').set('Authorization', 'Bearer fhs_not-a-token')).status).toBe(401);
    });

    test('software is told in what it reads: an OperationOutcome, in XML or JSON, or JSON', async () => {
      const xml = await request(app).get('/expensive?kind=xml&as=fhir-xml&hint=The%20same%20in%20JSON%20needs%20none');
      expect(xml.status).toBe(401);
      expect(xml.headers['content-type']).toContain('application/fhir+xml');
      expect(xml.text).toContain('<OperationOutcome xmlns="http://hl7.org/fhir"><issue><severity value="error"/><code value="login"/>');
      expect(xml.text).toContain('an answer in XML from the terminology API');
      expect(xml.text).toContain('/auth/why-login. The same in JSON needs none');
      const json = await request(app).get('/expensive?kind=xml&as=fhir-json');
      expect(JSON.parse(json.text).issue[0].code).toBe('login');
      const plain = await request(app).get('/expensive?kind=xig-page&as=json');
      expect(plain.body.error).toBe('login-required');
      expect(plain.body.message).toContain('a filtered XIG list past its first page');
    });

    test('/auth/why-login says what needs a login, and how software logs in', async () => {
      const res = await request(app).get('/auth/why-login');
      expect(res.status).toBe(200);
      expect(res.text).toContain('These need you to be logged in');
      expect(res.text).toContain('Every code of a large code system or value set (Show all)');
      expect(res.text).toContain('More than 500 rows of a value set expansion');
      expect(res.text).toContain('Authorization: Bearer {token}');
      expect(res.text).toContain('fhir-settings.json');
    });

    test('refusals are counted for the daily report, by kind and address, each day once', async () => {
      setupAuth({ loginForExpensive: true });
      const counting = appWith(async (req, res) => auth.refuseAnonymous(req, res, req.query.kind));
      await request(counting).get('/expensive?kind=xml').set('X-Forwarded-For', '10.0.0.1');
      await request(counting).get('/expensive?kind=xml').set('X-Forwarded-For', '10.0.0.2');
      await request(counting).get('/expensive?kind=xml').set('X-Forwarded-For', '10.0.0.2');
      await request(counting).get('/expensive?kind=show-all').set('X-Forwarded-For', '10.0.0.1');
      const today = Date.parse(new Date().toISOString().substring(0, 10));
      const report = auth.dailyReport({ since: today, now: today + 24 * 60 * 60 * 1000 });
      expect(report).toBe('4 requests told to log in: 1 for every code of a large code system or value set (Show all) (from 1 address); ' +
        '3 for an answer in XML from the terminology API (from 2 addresses).');
      // the next day's report doesn't count them again
      expect(auth.dailyReport({ since: today + 24 * 60 * 60 * 1000, now: today + 2 * 24 * 60 * 60 * 1000 })).toBe('No requests were told to log in.');
    });
  });
});
