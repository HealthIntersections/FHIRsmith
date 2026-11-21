// Securing the registry API: users of the server (library/auth) with the registry "member"
// role and their API tokens, OIDC JWTs, the failed-authentication limit, and usage counts

const http = require('http');
const express = require('express');
const request = require('supertest');
const jose = require('jose');
const RegistryModule = require('../../registry/registry');
const { AuthStore } = require('../../registry/auth-store');
const { RegistryAuth, looksLikeJwt } = require('../../registry/auth');
const { ADMIN_PASSWORD, setupAuth, mountAuth, makeUser, tokenFor, login } = require('../helpers/auth');

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };

async function makeApp(security) {
  const app = express();
  app.set('trust proxy', 'loopback');
  setupAuth();
  mountAuth(app);
  const mod = new RegistryModule({ countRequest() {}, addTask() {}, task() {}, taskDone() {}, taskError() {} });
  mod.logger = quiet;
  await mod.initialize({ crawlInterval: 0, releasesUrl: '', security: security ? { database: ':memory:', ...security } : { database: ':memory:' } });
  app.use('/tx-reg', mod.router);
  return { app, mod };
}

const json = (app, url = '/tx-reg/') => request(app).get(url).set('Accept', 'application/json');

describe('an open registry', () => {
  let app, mod;
  beforeAll(async () => ({ app, mod } = await makeApp(undefined)));
  afterAll(() => mod.shutdown());

  test('answers the API without a token; its old login page goes to the server\'s', async () => {
    expect((await json(app)).status).toBe(200);
    const old = await request(app).get('/tx-reg/login');
    expect(old.status).toBe(302);
    expect(old.headers.location).toBe('/auth/login?return=%2Ftx-reg');
    expect(mod.auth.enabled).toBe(false);
  });
});

describe('a secured registry: members and their tokens', () => {
  let app, mod, member, outsider;
  beforeAll(async () => {
    ({ app, mod } = await makeApp({ required: true }));
    await makeUser('admin', ADMIN_PASSWORD, { admin: true });
    member = tokenFor(await makeUser('client-app', null, { roles: [['registry', 'member']] }));
    outsider = tokenFor(await makeUser('someone', 'someone-password'));
  });
  afterAll(() => mod.shutdown());

  test('the JSON API needs a token', async () => {
    const res = await json(app, '/tx-reg/resolve?fhirVersion=R4&url=http://loinc.org');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/Bearer/);
    expect(res.body.error).toBe('unauthorized');
    expect(res.body.message).toMatch(/requires a token/);
  });

  test('a wrong token is refused, and says so differently; a user who is not a member is forbidden', async () => {
    const res = await json(app).set('Authorization', 'Bearer fhs_nope');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/not valid/);
    const other = await json(app).set('Authorization', `Bearer ${outsider}`);
    expect(other.status).toBe(403);
    expect(other.body.message).toMatch(/not a member/);
  });

  test('a member\'s token works as Bearer, Api-Key and X-API-Key, and is counted', async () => {
    for (const [name, value] of [['Authorization', `Bearer ${member}`], ['Api-Key', member], ['X-API-Key', member]]) {
      expect((await json(app).set(name, value)).status).toBe(200);
    }
    mod.auth.store.flush();
    const { agent } = await login(app, 'admin', ADMIN_PASSWORD);
    const usage = await agent.get('/tx-reg/usage');
    expect(usage.text).toMatch(/client-app<\/a><\/td><td>token<\/td><td>3<\/td>/);
    expect((await request(app).get('/tx-reg/usage')).status).toBe(302);
  });

  test('a member logged in with a browser can use the API too', async () => {
    await makeUser('person', 'person-password-long', { roles: [['registry', 'member']] });
    const { agent } = await login(app, 'person', 'person-password-long');
    expect((await agent.get('/tx-reg/').set('Accept', 'application/json')).status).toBe(200);
  });

  test('the HTML pages and the API description stay open', async () => {
    expect((await request(app).get('/tx-reg/').set('Accept', 'text/html')).status).toBe(200);
    expect((await request(app).get('/tx-reg/software').set('Accept', 'text/html')).status).toBe(200);
    expect((await request(app).get('/tx-reg/openapi.json')).status).toBe(200);
  });

  test('the navbar ends with Login, or the user\'s name; the administrator also gets usage', async () => {
    const anon = (await request(app).get('/tx-reg/').set('Accept', 'text/html')).text;
    expect(anon).toContain('<span style="float: right"><a href="/auth/login?return=%2Ftx-reg%2F" style="color: gold">Login</a></span>');
    expect(anon).not.toContain('/tx-reg/usage');
    const { agent } = await login(app, 'admin', ADMIN_PASSWORD);
    const page = await agent.get('/tx-reg/').set('Accept', 'text/html');
    expect(page.text).toContain('<span style="float: right"><a href="/auth/account" style="color: gold" title="Your account">admin</a></span>');
    expect(page.text).toContain('<a href="/tx-reg/usage" style="color: gold">Usage</a>');
    expect(page.text).not.toContain('/auth/admin/users');
  });
});

describe('the old security settings keep the API closed', () => {
  test('apiToken and users are no longer credentials, but the API stays closed', async () => {
    for (const security of [{ apiToken: 'open-sesame' }, { users: { adminPassword: 'x' } }]) {
      const { app, mod } = await makeApp(security);
      try {
        expect(mod.auth.enabled).toBe(true);
        expect((await json(app).set('Authorization', 'Bearer open-sesame')).status).toBe(401);
      } finally {
        mod.shutdown();
      }
    }
  });
});

describe('failed authentications are limited', () => {
  let app, mod, member;
  beforeAll(async () => {
    ({ app, mod } = await makeApp({ required: true, failedAuthPerWindow: 3 }));
    member = tokenFor(await makeUser('client-app', null, { roles: [['registry', 'member']] }));
  });
  afterAll(() => mod.shutdown());

  test('after too many 401s from an address, 429; good requests are never counted', async () => {
    const good = () => json(app).set('Authorization', `Bearer ${member}`);
    const bad = () => json(app).set('Authorization', 'Bearer fhs_nope');
    for (let i = 0; i < 10; i++) {
      expect((await good()).status).toBe(200);
    }
    // a bad query on /resolve is a 400, not a failed authentication
    expect((await json(app, '/tx-reg/resolve').set('Authorization', `Bearer ${member}`)).status).toBe(400);
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
    const off = await makeApp({ required: true, failedAuthPerWindow: 0 });
    try {
      for (let i = 0; i < 8; i++) {
        expect((await json(off.app).set('Authorization', 'Bearer fhs_nope')).status).toBe(401);
      }
    } finally {
      off.mod.shutdown();
    }
    const open = await makeApp(undefined);
    try {
      for (let i = 0; i < 8; i++) {
        expect((await json(open.app)).status).toBe(200);
      }
    } finally {
      open.mod.shutdown();
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
    ({ app, mod } = await makeApp({ oidc: { issuer: ISSUER, audience: AUDIENCE, jwksUri, requiredScope: 'registry.read' } }));
    await makeUser('admin', ADMIN_PASSWORD, { admin: true });
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
    const { agent } = await login(app, 'admin', ADMIN_PASSWORD);
    expect((await agent.get('/tx-reg/usage')).text).toMatch(/<td>client-42<\/td><td>oidc<\/td><td>1<\/td>/);
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
      store.countRequest('user:1', 'token');
      store.countRequest('user:1', 'token');
      const real = store.stmts.upsertUsage;
      store.stmts.upsertUsage = { run() { throw new Error('disk full'); } };
      expect(() => store.flush()).toThrow('disk full');
      store.stmts.upsertUsage = real;
      store.countRequest('user:1', 'token');
      expect(store.flush()).toBe(1);
      expect(store.usageOf('user:1').requests).toBe(3);
    } finally {
      store.close();
    }
  });
});

describe('header parsing', () => {
  test('looksLikeJwt', () => {
    expect(looksLikeJwt('aaa.bbb.ccc')).toBe(true);
    expect(looksLikeJwt('txr_abc')).toBe(false);
    expect(looksLikeJwt('a.b')).toBe(false);
  });
});
