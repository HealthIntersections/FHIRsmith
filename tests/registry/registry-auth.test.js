// Securing the registry API: the configured API token, users with their own tokens (and
// the pages that manage them), and OIDC JWTs

const http = require('http');
const express = require('express');
const request = require('supertest');
const jose = require('jose');
const RegistryModule = require('../../registry/registry');
const { AuthStore, makeToken, TOKEN_PREFIX } = require('../../registry/auth-store');
const { RegistryAuth, presentedToken, looksLikeJwt } = require('../../registry/auth');

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };

async function makeApp(security) {
  const app = express();
  app.set('trust proxy', 'loopback');
  const mod = new RegistryModule({ countRequest() {}, addTask() {}, task() {}, taskDone() {}, taskError() {} });
  mod.logger = quiet;
  await mod.initialize({ crawlInterval: 0, releasesUrl: '', security });
  app.use('/tx-reg', mod.router);
  return { app, mod };
}

const USERS = { database: ':memory:', adminPassword: 'admin-secret', cookieSecure: false, sessionSecret: 's' };

const csrfOf = async (agent, page = '/tx-reg/login') => {
  const res = await agent.get(page);
  return res.text.match(/name="_csrf" value="([^"]+)"/)[1];
};
const form = async (agent, url, data = {}, page) => {
  const _csrf = await csrfOf(agent, page);
  return agent.post(url).type('form').send({ ...data, _csrf });
};
const loginAs = async (app, login, password) => {
  const agent = request.agent(app);
  const res = await form(agent, '/tx-reg/login', { login, password });
  return { agent, res };
};

describe('an open registry', () => {
  let app, mod;
  beforeAll(async () => ({ app, mod } = await makeApp(undefined)));
  afterAll(() => mod.shutdown());

  test('answers the API without a token, and has no login page', async () => {
    expect((await request(app).get('/tx-reg/').set('Accept', 'application/json')).status).toBe(200);
    expect((await request(app).get('/tx-reg/login')).status).toBe(404);
    expect(mod.auth.enabled).toBe(false);
  });
});

describe('a single API token', () => {
  let app, mod;
  beforeAll(async () => ({ app, mod } = await makeApp({ apiToken: 'open-sesame' })));
  afterAll(() => mod.shutdown());

  test('the JSON API needs the token', async () => {
    const res = await request(app).get('/tx-reg/resolve?fhirVersion=R4&url=http://loinc.org').set('Accept', 'application/json');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
    expect(res.body.error).toBe('unauthorized');
    expect(res.body.message).toMatch(/requires a token/);
  });

  test('a wrong token is refused, and says so differently', async () => {
    const res = await request(app).get('/tx-reg/').set('Accept', 'application/json').set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/not valid/);
  });

  test('the token works as Bearer, Api-Key and X-API-Key', async () => {
    for (const [name, value] of [['Authorization', 'Bearer open-sesame'], ['Api-Key', 'open-sesame'], ['X-API-Key', 'open-sesame']]) {
      const res = await request(app).get('/tx-reg/').set('Accept', 'application/json').set(name, value);
      expect(res.status).toBe(200);
    }
  });

  test('the HTML pages and the API description stay open', async () => {
    expect((await request(app).get('/tx-reg/').set('Accept', 'text/html')).status).toBe(200);
    expect((await request(app).get('/tx-reg/software').set('Accept', 'text/html')).status).toBe(200);
    expect((await request(app).get('/tx-reg/openapi.json')).status).toBe(200);
  });
});

describe('failed authentications are limited', () => {
  let app, mod;
  beforeAll(async () => ({ app, mod } = await makeApp({ apiToken: 'open-sesame', failedAuthPerWindow: 3 })));
  afterAll(() => mod.shutdown());

  test('after too many 401s from an address, 429; good requests are never counted', async () => {
    const good = () => request(app).get('/tx-reg/').set('Accept', 'application/json').set('Authorization', 'Bearer open-sesame');
    const bad = () => request(app).get('/tx-reg/').set('Accept', 'application/json').set('Authorization', 'Bearer nope');
    for (let i = 0; i < 10; i++) {
      expect((await good()).status).toBe(200);
    }
    // a bad query on /resolve is a 400, not a failed authentication
    expect((await request(app).get('/tx-reg/resolve').set('Accept', 'application/json').set('Authorization', 'Bearer open-sesame')).status).toBe(400);
    for (let i = 0; i < 3; i++) {
      expect((await bad()).status).toBe(401);
    }
    const limited = await bad();
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('too-many-requests');
    // the rest of the window is closed to the address's bad tokens - but a good one still
    // works (the token is checked first), and the pages stay open
    expect((await bad()).status).toBe(429);
    expect((await good()).status).toBe(200);
    expect((await request(app).get('/tx-reg/').set('Accept', 'text/html')).status).toBe(200);
  });

  test('an open registry is not limited, and 0 turns it off', async () => {
    const open = await makeApp(undefined);
    const off = await makeApp({ apiToken: 'open-sesame', failedAuthPerWindow: 0 });
    try {
      for (let i = 0; i < 8; i++) {
        expect((await request(open.app).get('/tx-reg/').set('Accept', 'application/json')).status).toBe(200);
        expect((await request(off.app).get('/tx-reg/').set('Accept', 'application/json').set('Authorization', 'Bearer nope')).status).toBe(401);
      }
    } finally {
      open.mod.shutdown();
      off.mod.shutdown();
    }
  });
});

describe('users and their tokens', () => {
  let app, mod;
  beforeAll(async () => ({ app, mod } = await makeApp({ users: USERS })));
  afterAll(() => mod.shutdown());

  test('the API is closed, and the navbar offers a login', async () => {
    expect((await request(app).get('/tx-reg/').set('Accept', 'application/json')).status).toBe(401);
    const page = await request(app).get('/tx-reg/software').set('Accept', 'text/html');
    expect(page.text).toContain('href="/tx-reg/login"');
  });

  test('a wrong password is refused', async () => {
    const { res } = await loginAs(app, 'admin', 'wrong');
    expect(res.status).toBe(401);
    expect(res.text).toContain('Unknown username or wrong password');
  });

  test('cross-site form posts are refused', async () => {
    const agent = request.agent(app);
    const _csrf = await csrfOf(agent);
    const res = await agent.post('/tx-reg/login').type('form').set('Origin', 'https://evil.example').send({ login: 'admin', password: 'admin-secret', _csrf });
    expect(res.status).toBe(403);
  });

  test('the administrator creates a user, issues a token, and the token works', async () => {
    const { agent, res } = await loginAs(app, 'admin', 'admin-secret');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/tx-reg/admin/users');

    let r = await form(agent, '/tx-reg/admin/users', { login: 'acme-pipeline', name: 'ACME build pipeline', notes: 'CI' }, '/tx-reg/admin/users');
    expect(r.status).toBe(302);
    const userUrl = r.headers.location;
    expect(userUrl).toMatch(/^\/tx-reg\/admin\/users\/\d+$/);

    r = await form(agent, `${userUrl}/tokens`, { label: 'first', expires: '' }, userUrl);
    expect(r.status).toBe(302);
    const page = await agent.get(userUrl);
    const token = page.text.match(/<b>New token:<\/b> <code[^>]*>([^<]+)<\/code>/)[1];
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    // shown once
    expect((await agent.get(userUrl)).text).not.toContain('New token:');

    const api = await request(app).get('/tx-reg/').set('Accept', 'application/json').set('Authorization', `Bearer ${token}`);
    expect(api.status).toBe(200);
    const bad = await request(app).get('/tx-reg/').set('Accept', 'application/json').set('Authorization', `Bearer ${token}x`);
    expect(bad.status).toBe(401);

    // usage is counted against the token
    const users = await agent.get('/tx-reg/admin/users');
    expect(users.text).toMatch(/acme-pipeline<\/a><\/td><td>ACME build pipeline<\/td><td>yes<\/td><td><\/td><td>1 active<\/td><td>1<\/td>/);

    // disabling the user stops the token
    r = await form(agent, userUrl, { name: 'ACME build pipeline', notes: 'CI' }, userUrl); // enabled unchecked
    expect(r.status).toBe(200);
    expect((await request(app).get('/tx-reg/').set('Accept', 'application/json').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    r = await form(agent, userUrl, { name: 'ACME build pipeline', notes: 'CI', enabled: '1' }, userUrl);
    expect((await request(app).get('/tx-reg/').set('Accept', 'application/json').set('Api-Key', token)).status).toBe(200);

    // revoking it too
    const tid = (await agent.get(userUrl)).text.match(/tokens\/(\d+)\/revoke/)[1];
    r = await form(agent, `${userUrl}/tokens/${tid}/revoke`, {}, userUrl);
    expect(r.status).toBe(302);
    expect((await request(app).get('/tx-reg/').set('Accept', 'application/json').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await agent.get(userUrl)).text).toContain('>revoked<');
  });

  test('a user with a password manages its own tokens, and nothing else', async () => {
    const { agent: admin } = await loginAs(app, 'admin', 'admin-secret');
    let r = await form(admin, '/tx-reg/admin/users', { login: 'self-serve', password: 'password-1' }, '/tx-reg/admin/users');
    expect(r.status).toBe(302);

    const { agent, res } = await loginAs(app, 'self-serve', 'password-1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/tx-reg/account');
    expect((await agent.get('/tx-reg/admin/users')).status).toBe(403);

    r = await form(agent, '/tx-reg/account/tokens', { label: 'mine' }, '/tx-reg/account');
    expect(r.status).toBe(302);
    const page = await agent.get('/tx-reg/account');
    const token = page.text.match(/<b>New token:<\/b> <code[^>]*>([^<]+)<\/code>/)[1];
    expect((await request(app).get('/tx-reg/').set('Accept', 'application/json').set('Authorization', `Bearer ${token}`)).status).toBe(200);

    // can't revoke another user's token through its own page
    const victimId = await mod.auth.store.createUser({ login: 'victim' });
    const victim = mod.auth.store.issueToken(victimId, {});
    r = await form(agent, `/tx-reg/account/tokens/${victim.id}/revoke`, {}, '/tx-reg/account');
    expect(r.status).toBe(302);
    expect(mod.auth.store.authenticateToken(victim.token)).toBeTruthy();

    r = await form(agent, '/tx-reg/account/password', { current: 'wrong', password: 'password-2' }, '/tx-reg/account');
    expect(r.status).toBe(400);
    // a second session for the same user, from before the change
    const { agent: other } = await loginAs(app, 'self-serve', 'password-1');
    expect((await other.get('/tx-reg/account')).status).toBe(200);
    r = await form(agent, '/tx-reg/account/password', { current: 'password-1', password: 'password-2' }, '/tx-reg/account');
    expect(r.status).toBe(200);
    // the session that changed it goes on; the other has ended
    expect((await agent.get('/tx-reg/account')).status).toBe(200);
    expect((await other.get('/tx-reg/account')).status).toBe(302);
    expect((await loginAs(app, 'self-serve', 'password-2')).res.status).toBe(302);
    expect((await loginAs(app, 'self-serve', 'password-1')).res.status).toBe(401);

    // a user without a password cannot log in at all
    await form(admin, '/tx-reg/admin/users', { login: 'no-password' }, '/tx-reg/admin/users');
    expect((await loginAs(app, 'no-password', '')).res.status).toBe(401);
  });

  test('the main pages know who is logged in', async () => {
    const { agent } = await loginAs(app, 'admin', 'admin-secret');
    for (const path of ['/tx-reg/', '/tx-reg/software', '/tx-reg/log', '/tx-reg/resolve']) {
      const page = await agent.get(path).set('Accept', 'text/html');
      expect(page.text).toContain('href="/tx-reg/admin/users"');
      expect(page.text).not.toContain('href="/tx-reg/login"');
    }
  });

  test('reading documents gives a visitor no session', async () => {
    mod.auth.store.createDocument({ name: 'open-doc', type: 'md', public: true, content: '# Open\n' }, 'test');
    for (const path of ['/tx-reg/docs', '/tx-reg/docs/open-doc', '/tx-reg/docs/open-doc/history']) {
      const r = await request(app).get(path).set('Accept', 'text/html');
      expect(r.status).toBe(200);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
  });

  test('a resolve page that fails to render is an error, not the JSON', async () => {
    const real = mod.buildResolveResultContent;
    mod.buildResolveResultContent = () => { throw new Error('boom'); };
    try {
      const r = await request(app).get('/tx-reg/resolve?fhirVersion=R4&url=http://loinc.org').set('Accept', 'text/html');
      expect(r.status).toBe(500);
      expect(r.headers['content-type']).toMatch(/text\/html/);
      expect(r.text).not.toMatch(/"authoritative"|"candidates"/);
    } finally {
      mod.buildResolveResultContent = real;
    }
  });

  test('bad logins are rejected at creation', async () => {
    const { agent } = await loginAs(app, 'admin', 'admin-secret');
    for (const login of ['a', 'has space', 'admin', '<script>']) {
      const r = await form(agent, '/tx-reg/admin/users', { login }, '/tx-reg/admin/users');
      expect(r.status).toBe(400);
    }
    const r = await form(agent, '/tx-reg/admin/users', { login: 'short-pw', password: 'short' }, '/tx-reg/admin/users');
    expect(r.status).toBe(400);
  });
});

describe('sessions are kept in the auth database', () => {
  test('a login survives a restart', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txreg-'));
    const users = { ...USERS, database: path.join(dir, 'auth.db') };
    const first = await makeApp({ users });
    const { agent, res } = await loginAs(first.app, 'admin', 'admin-secret');
    expect((await agent.get('/tx-reg/admin/users')).status).toBe(200);
    const sid = res.headers['set-cookie'].map(c => c.split(';')[0]).find(c => c.startsWith('txreg.sid='));
    expect(sid).toBeTruthy();
    first.mod.shutdown();
    // the same cookie, against a new module on the same database
    const second = await makeApp({ users });
    try {
      expect((await request(second.app).get('/tx-reg/admin/users').set('Cookie', sid)).status).toBe(200);
    } finally {
      second.mod.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('OIDC', () => {
  let app, mod, server, jwksUri, privateKey, otherKey;
  const ISSUER = 'https://idp.example.org/tenant';
  const AUDIENCE = 'api://tx-registry';

  beforeAll(async () => {
    const pair = await jose.generateKeyPair('RS256');
    privateKey = pair.privateKey;
    otherKey = (await jose.generateKeyPair('RS256')).privateKey;
    const jwk = await jose.exportJWK(pair.publicKey);
    jwk.kid = 'k1';
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    jwksUri = `http://127.0.0.1:${server.address().port}/keys`;
    ({ app, mod } = await makeApp({ oidc: { issuer: ISSUER, audience: AUDIENCE, jwksUri, requiredScope: 'registry.read' }, users: USERS }));
  });
  afterAll(async () => {
    await mod.shutdown();
    server.close();
  });

  const jwt = (claims = {}, key = privateKey, header = { alg: 'RS256', kid: 'k1' }) =>
    new jose.SignJWT({ scp: 'registry.read other', azp: 'client-42', ...claims })
      .setProtectedHeader(header).setIssuer(claims.iss || ISSUER).setAudience(claims.aud || AUDIENCE)
      .setSubject('sub-1').setIssuedAt().setExpirationTime('5m').sign(key);

  const call = token => request(app).get('/tx-reg/').set('Accept', 'application/json').set('Authorization', `Bearer ${token}`);

  test('a token from the issuer, for this audience, with the scope, is accepted', async () => {
    expect((await call(await jwt())).status).toBe(200);
    // and counted by client id
    const { agent } = await loginAs(app, 'admin', 'admin-secret');
    expect((await agent.get('/tx-reg/admin/users')).text).toMatch(/<td>client-42<\/td><td>oidc<\/td><td>1<\/td>/);
  });

  test('the scope can be in roles too', async () => {
    expect((await call(await jwt({ scp: undefined, roles: ['registry.read'] }))).status).toBe(200);
  });

  test('wrong issuer, audience, scope, key or expired are refused', async () => {
    expect((await call(await jwt({ iss: 'https://other.example.org' }))).status).toBe(401);
    expect((await call(await jwt({ aud: 'api://something-else' }))).status).toBe(401);
    expect((await call(await jwt({ scp: 'registry.write' }))).status).toBe(401);
    expect((await call(await jwt({}, otherKey))).status).toBe(401);
    const expired = await new jose.SignJWT({ scp: 'registry.read' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt(Math.floor(Date.now() / 1000) - 7200).setExpirationTime(Math.floor(Date.now() / 1000) - 3600).sign(privateKey);
    expect((await call(expired)).status).toBe(401);
    // a token that never expires is refused too
    const forever = await new jose.SignJWT({ scp: 'registry.read' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().sign(privateKey);
    expect((await call(forever)).status).toBe(401);
  });

  test('an unsigned token is refused', async () => {
    const unsigned = new jose.UnsecuredJWT({ scp: 'registry.read' }).setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('5m').encode();
    expect((await call(unsigned)).status).toBe(401);
  });

  test('configuration is checked', () => {
    expect(() => new RegistryAuth({ oidc: { issuer: 'http://insecure', audience: 'x' } }, { logger: quiet }).setupOidc()).toThrow(/https/);
    expect(() => new RegistryAuth({ oidc: { issuer: 'https://idp', audience: 'x', jwksUri: 'http://keys.example/jwks' } }, { logger: quiet }).setupOidc()).toThrow(/jwksUri/);
    expect(() => new RegistryAuth({ oidc: { issuer: 'https://idp' } }, { logger: quiet }).setupOidc()).toThrow(/audience/);
  });
});

describe('usage counts', () => {
  test('a failed write keeps them for the next flush', () => {
    const store = new AuthStore(':memory:');
    try {
      store.countRequest('token:1', 'token');
      store.countRequest('token:1', 'token');
      const real = store.stmts.upsertUsage;
      store.stmts.upsertUsage = { run() { throw new Error('disk full'); } };
      expect(() => store.flush()).toThrow('disk full');
      store.stmts.upsertUsage = real;
      store.countRequest('token:1', 'token');
      expect(store.flush()).toBe(1);
      expect(store.usageOf('token:1').requests).toBe(3);
    } finally {
      store.close();
    }
  });
});

describe('AuthStore', () => {
  test('tokens: issue, authenticate, expire, revoke; usage', async () => {
    const store = new AuthStore(':memory:');
    const id = await store.createUser({ login: 'u1', password: 'password-1' });
    const t = store.issueToken(id, { label: 'a' });
    expect(store.authenticateToken(t.token)).toEqual({ userId: id, login: 'u1', tokenId: t.id });
    expect(store.authenticateToken(t.token.slice(0, -1))).toBeNull();
    expect(store.authenticateToken('not a token')).toBeNull();

    const e = store.issueToken(id, { expiresInDays: 1 });
    expect(store.authenticateToken(e.token)).toBeTruthy();
    expect(store.authenticateToken(e.token, Date.now() + 2 * 24 * 3600 * 1000)).toBeNull();
    expect(store.tokensForUser(id).map(x => x.status)).toEqual(['active', 'active']);

    store.countRequest(`token:${t.id}`, 'token');
    store.countRequest(`token:${t.id}`, 'token');
    expect(store.usageOf(`token:${t.id}`).requests).toBe(2);
    expect(store.flush()).toBe(1);
    store.countRequest(`token:${t.id}`, 'token');
    expect(store.usageOf(`token:${t.id}`).requests).toBe(3);

    expect(store.revokeToken(id, t.id)).toBe(true);
    expect(store.revokeToken(id, t.id)).toBe(false);
    expect(store.authenticateToken(t.token)).toBeNull();

    expect(await store.checkPassword(store.userByLogin('u1'), 'password-1')).toBe(true);
    expect(await store.checkPassword(store.userByLogin('u1'), 'nope')).toBe(false);
    store.updateUser(id, { enabled: false });
    expect(store.authenticateToken(e.token)).toBeNull();
    store.deleteUser(id);
    expect(store.tokensForUser(id)).toEqual([]);
    store.close();
  });

  test('token format', () => {
    const t = makeToken();
    expect(t.token).toMatch(/^txr_[A-Za-z0-9_-]{43}$/);
    expect(t.prefix).toBe(t.token.substring(0, 12));
  });
});

describe('header parsing', () => {
  test('presentedToken', () => {
    expect(presentedToken({ headers: { authorization: 'Bearer abc' } })).toEqual({ token: 'abc', scheme: 'bearer' });
    expect(presentedToken({ headers: { authorization: 'bearer   abc  ' } })).toEqual({ token: 'abc', scheme: 'bearer' });
    expect(presentedToken({ headers: { authorization: 'Basic abc' } })).toBeNull();
    expect(presentedToken({ headers: { 'api-key': 'k' } })).toEqual({ token: 'k', scheme: 'api-key' });
    expect(presentedToken({ headers: { 'x-api-key': 'k' } })).toEqual({ token: 'k', scheme: 'api-key' });
    expect(presentedToken({ headers: { 'api-key': ['a', 'b'] } })).toBeNull();
    expect(presentedToken({ headers: {} })).toBeNull();
  });

  test('looksLikeJwt', () => {
    expect(looksLikeJwt('aaa.bbb.ccc')).toBe(true);
    expect(looksLikeJwt('txr_abc')).toBe(false);
    expect(looksLikeJwt('a.b')).toBe(false);
  });
});
