// The server's one login system (library/auth): the store, who a request is, the /auth pages
// (password and GitHub logins, password links, accounts, users and roles), and the CLI

const express = require('express');
const request = require('supertest');
const { auth, ADMIN_PASSWORD, setupAuth, mountAuth, makeUser, tokenFor, csrfOf, login } = require('../helpers/auth');
const { safeReturn, presentedToken } = require('../../library/auth/auth');
const { runPasswordLink, wantsPasswordLink } = require('../../library/auth/cli');

const GOOD = 'a-long-enough-password';

function fakeMailer() {
  const sent = [];
  return { sent, configured: () => true, send: async (m) => { sent.push(m); } };
}

function makeApp(config = {}, mailer = null) {
  setupAuth({ publicUrl: 'https://fhir.example.org', ...config, options: { mailer } });
  const app = express();
  app.set('trust proxy', 'loopback');
  mountAuth(app);
  // a page of a module, to come back to
  app.get('/module/page', auth.session, (req, res) => res.send(auth.currentUser(req) ? `hello ${auth.currentUser(req).login}` : 'nobody'));
  app.get('/module/api', auth.requireApi(p => p.has('mod', 'use')), (req, res) => res.json({ who: req.user.login, via: req.user.via }));
  return app;
}

const form = async (agent, url, data = {}, page = '/auth/login') => {
  const _csrf = await csrfOf(agent, page);
  return agent.post(url).type('form').send({ ...data, _csrf });
};

afterAll(() => auth.shutdown());

describe('the store', () => {
  beforeEach(() => setupAuth());

  test('users: logins and emails are unique and case-insensitive; freeLogin finds a free one', () => {
    const id = auth.store.createUser({ login: 'Grahame', email: 'G@Example.org' });
    expect(auth.store.userByLogin('grahame').id).toBe(id);
    expect(auth.store.userByEmail('g@example.ORG').id).toBe(id);
    expect(auth.store.userByLoginOrEmail('g@example.org').id).toBe(id);
    expect(() => auth.store.createUser({ login: 'GRAHAME' })).toThrow();
    expect(() => auth.store.createUser({ login: 'other', email: 'g@example.org' })).toThrow();
    expect(() => auth.store.createUser({ login: 'x' })).toThrow(/A login is/);
    expect(() => auth.store.createUser({ login: 'ok-login', email: 'not an email' })).toThrow(/email/);
    expect(auth.store.freeLogin('grahame')).toBe('grahame-2');
    expect(auth.store.freeLogin('new one')).toBe('new-one');
  });

  test('tokens: issue, authenticate, count, expire, revoke; a disabled user\'s don\'t work', () => {
    const id = auth.store.createUser({ login: 'bot' });
    const t = auth.store.issueToken(id, { label: 'ci' });
    expect(t.token).toMatch(/^fhs_[A-Za-z0-9_-]{43}$/);
    expect(auth.store.authenticateToken(t.token).user.login).toBe('bot');
    expect(auth.store.authenticateToken(t.token.slice(0, -1))).toBeNull();
    expect(auth.store.authenticateToken('txr_old')).toBeNull();
    auth.store.flush();
    expect(auth.store.tokensForUser(id)[0].use_count).toBe(1);
    const e = auth.store.issueToken(id, { expiresInDays: 1 });
    expect(auth.store.authenticateToken(e.token, Date.now() + 2 * 86400000)).toBeNull();
    expect(auth.store.revokeToken(id, t.id)).toBe(true);
    expect(auth.store.authenticateToken(t.token)).toBeNull();
    auth.store.setEnabled(id, false);
    expect(auth.store.authenticateToken(e.token)).toBeNull();
    // stored as hashes
    expect(JSON.stringify(auth.store.db.prepare('SELECT * FROM tokens').all())).not.toContain(e.token);
  });

  test('links: one at a time, used once, expire', () => {
    const id = auth.store.createUser({ login: 'person' });
    const a = auth.store.createLink(id, 60);
    const b = auth.store.createLink(id, 60);
    expect(auth.store.checkLink(a)).toBeNull();
    expect(auth.store.checkLink(b).id).toBe(id);
    expect(auth.store.checkLink(b, Date.now() + 61 * 60000)).toBeNull();
    expect(auth.store.useLink(b)).toBe(true);
    expect(auth.store.useLink(b)).toBe(false);
    expect(auth.store.checkLink(b)).toBeNull();
    expect(JSON.stringify(auth.store.db.prepare('SELECT * FROM links').all())).not.toContain(b);
  });

  test('roles: scoped, and setHolders replaces a scope\'s holders', () => {
    const a = auth.store.createUser({ login: 'aa' });
    const b = auth.store.createUser({ login: 'bb' });
    auth.store.setHolders('ips', 'manager', '1', [a, b]);
    auth.store.setHolders('ips', 'manager', '2', [a]);
    auth.store.setHolders('ips', 'manager', '1', [b]);
    expect(auth.store.holders('ips', 'manager', '1')).toEqual([b]);
    expect(auth.store.allHolders('ips', 'manager').length).toBe(2);
    const p = auth.principalById(a);
    expect(p.has('ips', 'manager', 2)).toBe(true);
    expect(p.has('ips', 'manager', 1)).toBe(false);
    expect(p.has('ips', 'manager')).toBe(true);
    expect(p.scopes('ips', 'manager')).toEqual(['2']);
    // an unscoped grant covers every scope
    auth.store.grant(b, 'ips', 'manager', '');
    expect(auth.principalById(b).has('ips', 'manager', 99)).toBe(true);
  });
});

describe('administrators from the configuration', () => {
  test('emails get an account; github: names match only an account GitHub vouched for; bare names are ignored', () => {
    const warned = [];
    auth.initialize({ database: ':memory:', bcryptCost: 4, administrators: ['Boss@Example.org', 'github:TheBoss', 'justaname'] },
      { log: { info() {}, warn: m => warned.push(m), error() {} } });
    const boss = auth.store.userByEmail('boss@example.org');
    expect(boss).toBeTruthy();
    expect(auth.principalById(boss.id).isAdmin).toBe(true);
    expect(auth.principalById(boss.id).adminFromConfig).toBe(true);
    expect(warned.some(m => m.includes("'justaname'"))).toBe(true);
    const viaGithub = auth.store.createUser({ login: 'theboss', githubId: 77, githubLogin: 'theboss' });
    const pretender = auth.store.createUser({ login: 'theboss-2', githubLogin: 'theboss' });
    const named = auth.store.createUser({ login: 'justaname' });
    expect(auth.principalById(viaGithub).isAdmin).toBe(true);
    expect(auth.principalById(pretender).isAdmin).toBe(false);
    expect(auth.principalById(named).isAdmin).toBe(false);
    // and starting again doesn't make it twice
    auth.applyConfiguredAdministrators();
    expect(auth.store.users().filter(u => u.email === 'Boss@Example.org' || u.email === 'boss@example.org')).toHaveLength(1);
  });
});

describe('who is asking', () => {
  beforeEach(() => setupAuth());

  test('presentedToken: Bearer, Api-Key, X-API-Key, and Basic with a token as the password', () => {
    expect(presentedToken({ headers: { authorization: 'Bearer abc' } })).toBe('abc');
    expect(presentedToken({ headers: { 'api-key': 'k' } })).toBe('k');
    expect(presentedToken({ headers: { 'x-api-key': 'k' } })).toBe('k');
    expect(presentedToken({ headers: { authorization: 'Basic ' + Buffer.from('me:fhs_abc').toString('base64') } })).toBe('fhs_abc');
    expect(presentedToken({ headers: { authorization: 'Basic ' + Buffer.from('me:password').toString('base64') } })).toBeNull();
    expect(presentedToken({ headers: { 'api-key': ['a', 'b'] } })).toBeNull();
    expect(presentedToken({ headers: {} })).toBeNull();
  });

  test('safeReturn stays on this server', () => {
    expect(safeReturn('/ips/demo?x=1')).toBe('/ips/demo?x=1');
    // an encoded URL in the query is fine: only an encoded / or \ straight after the first / isn't
    expect(safeReturn('/tx/r4/ValueSet?url=http%3A%2F%2Fexample.org')).toBe('/tx/r4/ValueSet?url=http%3A%2F%2Fexample.org');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '/a\r\nLocation: x',
      '/%2Fevil.example', '/%5cevil.example', '/a\tb', '/a\u0000', '', 'x'.repeat(10) + '/', '/' + 'x'.repeat(2000), undefined, 42]) {
      expect(safeReturn(bad, '/home')).toBe('/home');
    }
  });

  test('redirects back go only to paths on this server', async () => {
    const app = makeApp();
    const { agent } = await login(app, 'nobody-here', GOOD);
    await makeUser('person', GOOD);
    for (const [ret, to] of [['/module/page', '/module/page'], ['//evil.example/x', '/auth/account'], ['/%2f%2fevil.example', '/auth/account'], ['https://evil.example', '/auth/account']]) {
      const _csrf = await csrfOf(agent);
      const res = await agent.post('/auth/login').type('form').send({ login: 'person', password: GOOD, return: ret, _csrf });
      expect(res.headers.location).toBe(to);
    }
  });

  test('requireApi: 401 without a principal, 403 without the role; administrators and this server pass', async () => {
    const app = makeApp();
    const user = tokenFor(await makeUser('plain', null));
    const allowed = tokenFor(await makeUser('allowed', null, { roles: [['mod', 'use']] }));
    const admin = tokenFor(await makeUser('root', null, { admin: true }));
    expect((await request(app).get('/module/api')).status).toBe(401);
    expect((await request(app).get('/module/api').set('Authorization', 'Bearer fhs_bad')).body.message).toMatch(/not valid/);
    expect((await request(app).get('/module/api').set('Authorization', `Bearer ${user}`)).status).toBe(403);
    expect((await request(app).get('/module/api').set('Authorization', `Bearer ${allowed}`)).body).toEqual({ who: 'allowed', via: 'token' });
    expect((await request(app).get('/module/api').set('Authorization', `Bearer ${admin}`)).status).toBe(200);
    expect((await request(app).get('/module/api').set(auth.internalHeaders())).body).toEqual({ who: 'server', via: 'internal' });
    expect((await request(app).get('/module/api').set('x-fhirsmith-internal', 'guess')).status).toBe(401);
  });
});

describe('logging in with a password', () => {
  let app;
  beforeEach(async () => {
    app = makeApp();
    await makeUser('person', GOOD, { email: 'person@example.org' });
  });

  test('by login or email; back to the page it started from; no fixation', async () => {
    const agent = request.agent(app);
    const page = await agent.get('/auth/login?return=%2Fmodule%2Fpage');
    expect(page.text).toContain('name="return" value="/module/page"');
    const before = (page.headers['set-cookie'] || [])[0];
    const _csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const res = await agent.post('/auth/login').type('form').send({ login: 'person@example.org', password: GOOD, return: '/module/page', _csrf });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/module/page');
    // a new session id at login
    expect(res.headers['set-cookie'][0].split(';')[0]).not.toBe(before.split(';')[0]);
    expect((await agent.get('/module/page')).text).toBe('hello person');
  });

  test('a wrong password, an unknown user, a disabled user: the same answer', async () => {
    expect((await login(app, 'person', 'wrong-password-here')).res.status).toBe(401);
    expect((await login(app, 'nobody', GOOD)).res.status).toBe(401);
    auth.store.setEnabled(auth.store.userByLogin('person').id, false);
    const res = (await login(app, 'person', GOOD)).res;
    expect(res.status).toBe(401);
    expect(res.text).toContain('Unknown username or wrong password');
  });

  test('a return that leaves the server is ignored', async () => {
    const agent = request.agent(app);
    const _csrf = await csrfOf(agent);
    const res = await agent.post('/auth/login').type('form').send({ login: 'person', password: GOOD, return: '//evil.example/x', _csrf });
    expect(res.headers.location).toBe('/auth/account');
  });

  test('needs the CSRF token, and refuses other sites', async () => {
    expect((await request(app).post('/auth/login').type('form').send({ login: 'person', password: GOOD })).status).toBe(403);
    const agent = request.agent(app);
    const _csrf = await csrfOf(agent);
    expect((await agent.post('/auth/login').set('Origin', 'https://evil.example').type('form').send({ login: 'person', password: GOOD, _csrf })).status).toBe(403);
  });

  test('logging out ends the session', async () => {
    const { agent } = await login(app, 'person', GOOD);
    const res = await form(agent, '/auth/logout', { return: '/module/page' }, '/auth/account');
    expect(res.headers.location).toBe('/module/page');
    expect((await agent.get('/module/page')).text).toBe('nobody');
  });

  test('the account page\'s Logout goes to afterLogout (default /); one that leaves the server is ignored', async () => {
    let { agent } = await login(app, 'person', GOOD);
    expect((await form(agent, '/auth/logout', {}, '/auth/account')).headers.location).toBe('/');
    app = makeApp({ afterLogout: '/ips' });
    await makeUser('person', GOOD);
    ({ agent } = await login(app, 'person', GOOD));
    expect((await agent.get('/auth/account')).text).not.toContain('name="return" value="/"');
    expect((await form(agent, '/auth/logout', {}, '/auth/account')).headers.location).toBe('/ips');
    app = makeApp({ afterLogout: '//evil.example' });
    await makeUser('person', GOOD);
    ({ agent } = await login(app, 'person', GOOD));
    expect((await form(agent, '/auth/logout', {}, '/auth/account')).headers.location).toBe('/');
  });
});

describe('password links', () => {
  let app;
  let mailer;
  beforeEach(async () => {
    mailer = fakeMailer();
    app = makeApp({}, mailer);
    await makeUser('person', GOOD, { email: 'person@example.org' });
  });

  const linkIn = (m) => m.text.match(/https:\/\/fhir\.example\.org(\/auth\/reset\/[A-Za-z0-9_-]+)/)[1];

  test('forgotten: the same answer whether or not there is an account; the link sets the password once, and logs in', async () => {
    const agent = request.agent(app);
    let res = await form(agent, '/auth/forgot', { login: 'nobody' }, '/auth/forgot');
    expect(res.text).toContain('If there is an account');
    expect(mailer.sent).toHaveLength(0);
    res = await form(agent, '/auth/forgot', { login: 'person' }, '/auth/forgot');
    expect(res.text).toContain('If there is an account');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe('person@example.org');
    const path = linkIn(mailer.sent[0]);

    const page = await agent.get(path);
    expect(page.status).toBe(200);
    // not no-referrer: browsers then post with 'Origin: null', which sameOrigin refuses
    expect(page.headers['referrer-policy']).toBe('same-origin');
    expect((await form(agent, path, { password: 'too-short', confirm: 'too-short' }, path)).text).toContain('at least 15 characters');
    expect((await form(agent, path, { password: 'a-new-password-1', confirm: 'a-new-password-2' }, path)).text).toContain('not the same');
    res = await form(agent, path, { password: 'a-new-password-1', confirm: 'a-new-password-1' }, path);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/account');
    expect((await agent.get('/module/page')).text).toBe('hello person');
    // used up
    expect((await request(app).get(path)).status).toBe(404);
    expect((await login(app, 'person', GOOD)).res.status).toBe(401);
    expect((await login(app, 'person', 'a-new-password-1')).res.status).toBe(302);
  });

  test('the links use hostName when there is no publicUrl: https, or http when cookieSecure is false', () => {
    const fakeReq = { protocol: 'http', get: () => 'forged.example.com' };
    setupAuth({ cookieSecure: true, options: { hostName: 'localhost:3001' } });
    expect(auth.publicUrl(fakeReq)).toBe('https://localhost:3001');
    setupAuth({ cookieSecure: false, options: { hostName: 'localhost:3001' } });
    expect(auth.publicUrl(fakeReq)).toBe('http://localhost:3001');
    setupAuth({ cookieSecure: false, publicUrl: 'https://fhir.example.org/', options: { hostName: 'localhost:3001' } });
    expect(auth.publicUrl(fakeReq)).toBe('https://fhir.example.org');
  });

  test('a forgotten password, asked for from the login page, comes back to where logging in started', async () => {
    const agent = request.agent(app);
    const loginPage = await agent.get('/auth/login?return=%2Fmodule%2Fpage');
    expect(loginPage.text).toContain('href="/auth/forgot?return=%2Fmodule%2Fpage"');
    const forgotPage = await agent.get('/auth/forgot?return=%2Fmodule%2Fpage');
    expect(forgotPage.text).toContain('<input type="hidden" name="return" value="/module/page"/>');
    await form(agent, '/auth/forgot', { login: 'person', return: '/module/page' }, '/auth/forgot');
    const m = mailer.sent[0].text.match(/https:\/\/fhir\.example\.org(\/auth\/reset\/[A-Za-z0-9_-]+\?return=%2Fmodule%2Fpage)/);
    expect(m).not.toBeNull();
    const page = await agent.get(m[1]);
    expect(page.text).toContain('<input type="hidden" name="return" value="/module/page"/>');
    const res = await form(agent, m[1], { password: 'a-new-password-1', confirm: 'a-new-password-1', return: '/module/page' }, m[1]);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/module/page');
    expect((await agent.get('/module/page')).text).toBe('hello person');
  });

  test('a return that leaves the server is dropped from the link', async () => {
    const agent = request.agent(app);
    await form(agent, '/auth/forgot', { login: 'person', return: '//evil.example/x' }, '/auth/forgot');
    expect(mailer.sent[0].text).not.toContain('return=');
  });

  test('without email, there is no form - ask the administrator', async () => {
    const other = makeApp();
    const page = await request(other).get('/auth/forgot');
    expect(page.text).toContain('can\'t send email');
    expect(page.text).not.toContain('action="/auth/forgot"');
  });
});

describe('a user\'s account', () => {
  let app;
  beforeEach(async () => {
    app = makeApp({ github: { clientId: 'cid', clientSecret: 'cs' } });
    await makeUser('person', GOOD, { email: 'person@example.org', roles: [['mod', 'use']] });
  });

  test('changing the password logs out the other sessions, not this one', async () => {
    const { agent: here } = await login(app, 'person', GOOD);
    const { agent: there } = await login(app, 'person', GOOD);
    const res = await form(here, '/auth/account/password', { current: GOOD, password: 'another-long-password', confirm: 'another-long-password' }, '/auth/account');
    expect(res.status).toBe(302);
    expect((await here.get('/module/page')).text).toBe('hello person');
    expect((await there.get('/module/page')).text).toBe('nobody');
    // a wrong current password changes nothing
    await form(here, '/auth/account/password', { current: 'wrong', password: 'third-long-password', confirm: 'third-long-password' }, '/auth/account');
    expect((await login(app, 'person', 'another-long-password')).res.status).toBe(302);
  });

  test('the account page shows roles, issues and revokes tokens (shown once)', async () => {
    const { agent } = await login(app, 'person', GOOD);
    const page = await agent.get('/auth/account');
    expect(page.text).toContain('mod: use');
    expect(page.text).toContain('Link GitHub account');
    let res = await form(agent, '/auth/account/tokens', { label: 'my script' }, '/auth/account');
    expect(res.status).toBe(302);
    const shown = (await agent.get('/auth/account')).text.match(/<b>New token:<\/b> <code[^>]*>([^<]+)<\/code>/)[1];
    expect((await agent.get('/auth/account')).text).not.toContain(shown);
    expect((await request(app).get('/module/api').set('Authorization', `Bearer ${shown}`)).status).toBe(200);
    const id = auth.store.tokensForUser(auth.store.userByLogin('person').id)[0].id;
    res = await form(agent, `/auth/account/tokens/${id}/revoke`, {}, '/auth/account');
    expect((await request(app).get('/module/api').set('Authorization', `Bearer ${shown}`)).status).toBe(401);
  });

  test('log out everywhere', async () => {
    const { agent: a } = await login(app, 'person', GOOD);
    const { agent: b } = await login(app, 'person', GOOD);
    await form(a, '/auth/account/logout-everywhere', {}, '/auth/account');
    expect((await a.get('/module/page')).text).toBe('nobody');
    expect((await b.get('/module/page')).text).toBe('nobody');
  });

  test('the account page says who you are and what you can do; only administrators get Users', async () => {
    auth.defineRoles('demo', [{ role: 'run', label: 'Run demos', description: 'start a demo' }], { title: 'Demo', path: '/demo' });
    auth.addAdminPage('demo', { label: 'Demo settings', path: '/demo/settings', description: 'how demos run' });
    await makeUser('runner', GOOD, { name: 'Demo Runner', roles: [['demo', 'run']] });
    await makeUser('nobody-much', GOOD);
    await makeUser('boss', GOOD, { admin: true });

    let page = (await (await login(app, 'runner', GOOD)).agent.get('/auth/account')).text;
    expect(page).toContain('You are logged in as <b>Demo Runner</b>');
    expect(page).toContain('action="/auth/logout"');
    expect(page).toContain('<li><a href="/demo">demo: Run demos</a> - start a demo</li>');
    expect(page).not.toContain('/auth/admin/users');
    expect(page).not.toContain('/demo/settings');

    page = (await (await login(app, 'nobody-much', GOOD)).agent.get('/auth/account')).text;
    expect(page).toContain('You have no roles yet');

    page = (await (await login(app, 'boss', GOOD)).agent.get('/auth/account')).text;
    expect(page).toContain('<b>Administrator</b>');
    expect(page).toContain('<a href="/auth/admin/users">Users</a>');
    expect(page).toContain('<li>Demo: <a href="/demo/settings">Demo settings</a> - how demos run</li>');
    expect(page).not.toContain('You have no roles yet');
  });

  test('the top menu of every page ends with Login, or the user\'s name linked to their account page', async () => {
    const htmlServer = require('../../library/html-server');
    const path = require('path');
    if (!htmlServer.hasTemplate('root')) {
      htmlServer.loadTemplate('root', path.join(__dirname, '..', '..', 'root-template.html'));
    }
    // a module's page, made with a template, knowing nothing about logins
    app.get('/module/html', (req, res) => res.send(htmlServer.renderPage('root', 'A page', '<p>content</p>')));
    let page = (await request(app).get('/module/html')).text;
    expect(page).toContain('<span style="float: right"><a href="/auth/login?return=%2Fmodule%2Fhtml" style="color: gold">Login</a></span>');
    // the login page's Login doesn't come back to itself
    page = (await request(app).get('/auth/login?return=%2Fmodule%2Fhtml')).text;
    expect(page).toContain('<span style="float: right"><a href="/auth/login" style="color: gold">Login</a></span>');
    const { agent } = await login(app, 'person', GOOD);
    page = (await agent.get('/module/html')).text;
    expect(page).toContain('<span style="float: right"><a href="/auth/account" style="color: gold" title="Your account">person</a></span>');
    // outside a request there is no one to name
    expect(auth.accountLink()).toBe('');
  });

  test('the account page needs a login', async () => {
    const res = await request(app).get('/auth/account');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login?return=%2Fauth%2Faccount');
  });
});

describe('logging in with GitHub', () => {
  let app;
  const realFetch = global.fetch;
  let ghUser;
  let ghEmails;
  beforeEach(async () => {
    app = makeApp({ github: { clientId: 'cid', clientSecret: 'secret' }, administrators: ['github:octoboss'] });
    ghUser = { id: 42, login: 'octocat', name: 'The Octocat' };
    ghEmails = [{ email: 'octo@example.org', primary: true, verified: true }];
    global.fetch = async (url, init) => {
      const u = String(url);
      const ok = (body) => ({ ok: true, status: 200, json: async () => body });
      if (u.startsWith('https://github.com/login/oauth/access_token')) {
        const body = JSON.parse(init.body);
        return ok(body.code === 'good' && body.client_secret === 'secret' ? { access_token: 'gho_x' } : { error: 'bad_verification_code' });
      }
      if (u === 'https://api.github.com/user') {
        return ok(ghUser);
      }
      if (u === 'https://api.github.com/user/emails') {
        return ok(ghEmails);
      }
      throw new Error('unexpected fetch ' + u);
    };
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  /** Start at /auth/github (or the link button), and come back with a code */
  async function viaGithub(agent, { code = 'good', link = false } = {}) {
    let start;
    if (link) {
      start = await form(agent, '/auth/account/github/link', {}, '/auth/account');
    } else {
      start = await agent.get('/auth/github?return=%2Fmodule%2Fpage');
    }
    expect(start.status).toBe(302);
    const to = new URL(start.headers.location);
    expect(to.origin + to.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(to.searchParams.get('redirect_uri')).toBe('https://fhir.example.org/auth/github/callback');
    return agent.get(`/auth/github/callback?code=${code}&state=${encodeURIComponent(to.searchParams.get('state'))}`);
  }

  test('the first login makes an account with no roles, tied to the GitHub id', async () => {
    const agent = request.agent(app);
    const res = await viaGithub(agent);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/module/page');
    expect((await agent.get('/module/page')).text).toBe('hello octocat');
    const u = auth.store.userByGithub(42);
    expect(u.email).toBe('octo@example.org');
    expect(auth.store.rolesOf(u.id)).toEqual([]);
    expect(auth.principalById(u.id).isAdmin).toBe(false);
    // renamed on GitHub: the same account
    ghUser.login = 'octocat-renamed';
    await viaGithub(request.agent(app));
    expect(auth.store.users()).toHaveLength(1);
    expect(auth.store.userByGithub(42).github_login).toBe('octocat-renamed');
  });

  test('a state that isn\'t this session\'s, or a bad code, is refused', async () => {
    const agent = request.agent(app);
    expect((await agent.get('/auth/github/callback?code=good&state=made-up')).status).toBe(400);
    expect((await viaGithub(agent, { code: 'bad' })).status).toBe(400);
    expect(auth.store.users()).toHaveLength(0);
  });

  test('an email another account has is not taken, and the accounts are not matched', async () => {
    await makeUser('octo-manual', GOOD, { email: 'octo@example.org' });
    await viaGithub(request.agent(app));
    const gh = auth.store.userByGithub(42);
    expect(gh.login).toBe('octocat');
    expect(gh.email).toBeNull();
  });

  test('a logged in user links GitHub, and then logs in with it', async () => {
    await makeUser('octo-manual', GOOD, { email: 'octo@example.org' });
    const { agent } = await login(app, 'octo-manual', GOOD);
    const res = await viaGithub(agent, { link: true });
    expect(res.headers.location).toBe('/auth/account');
    expect(auth.store.userByLogin('octo-manual').github_id).toBe('42');
    const fresh = request.agent(app);
    await viaGithub(fresh);
    expect((await fresh.get('/module/page')).text).toBe('hello octo-manual');
    expect(auth.store.users()).toHaveLength(1);
  });

  test('a configured github: administrator is one when GitHub says so', async () => {
    ghUser = { id: 7, login: 'OctoBoss', name: '' };
    await viaGithub(request.agent(app));
    expect(auth.principalById(auth.store.userByGithub(7).id).isAdmin).toBe(true);
  });
});

describe('logging in with Google', () => {
  let app;
  const realFetch = global.fetch;
  let info;
  beforeEach(async () => {
    app = makeApp({ github: { clientId: 'gh', clientSecret: 'ghs' }, google: { clientId: 'gid', clientSecret: 'gsecret' }, administrators: ['google:boss@example.org'] });
    info = { sub: '1001', email: 'Jane.Doe@example.org', email_verified: true, name: 'Jane Doe' };
    global.fetch = async (url, init) => {
      const u = String(url);
      const ok = (body) => ({ ok: true, status: 200, json: async () => body });
      if (u === 'https://oauth2.googleapis.com/token') {
        const body = new URLSearchParams(init.body);
        if (body.get('grant_type') !== 'authorization_code' || body.get('redirect_uri') !== 'https://fhir.example.org/auth/google/callback') {
          return { ok: false, status: 400, json: async () => ({ error: 'invalid_request' }) };
        }
        return ok(body.get('code') === 'good' && body.get('client_secret') === 'gsecret' ? { access_token: 'ya29.x', id_token: 'x.y.z' } : { error: 'invalid_grant' });
      }
      if (u === 'https://openidconnect.googleapis.com/v1/userinfo') {
        expect(init.headers.Authorization).toBe('Bearer ya29.x');
        return ok(info);
      }
      throw new Error('unexpected fetch ' + u);
    };
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  async function viaGoogle(agent, { code = 'good', link = false } = {}) {
    const start = link ? await form(agent, '/auth/account/google/link', {}, '/auth/account') : await agent.get('/auth/google?return=%2Fmodule%2Fpage');
    expect(start.status).toBe(302);
    const to = new URL(start.headers.location);
    expect(to.origin + to.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(to.searchParams.get('scope')).toBe('openid email profile');
    expect(to.searchParams.get('response_type')).toBe('code');
    expect(to.searchParams.get('redirect_uri')).toBe('https://fhir.example.org/auth/google/callback');
    return agent.get(`/auth/google/callback?code=${code}&state=${encodeURIComponent(to.searchParams.get('state'))}`);
  }

  test('the login page: GitHub and Google first, then a line, then the password form', async () => {
    const page = (await request(app).get('/auth/login?return=%2Fips')).text;
    const gh = page.indexOf('href="/auth/github?return=%2Fips">Log in with GitHub');
    const go = page.indexOf('href="/auth/google?return=%2Fips">Log in with Google');
    const hr = page.indexOf('<hr/>');
    const pw = page.indexOf('action="/auth/login"');
    expect(gh).toBeGreaterThan(0);
    expect(go).toBeGreaterThan(gh);
    expect(hr).toBeGreaterThan(go);
    expect(pw).toBeGreaterThan(hr);
    expect(page).toContain('an account you have been given');
    // with neither, just the form
    const plain = (await request(makeApp()).get('/auth/login')).text;
    expect(plain).not.toContain('<hr/>');
    expect(plain).not.toContain('Log in with');
  });

  test('the first login makes an account with no roles, tied to Google\'s id; the next finds it', async () => {
    const agent = request.agent(app);
    const res = await viaGoogle(agent);
    expect(res.headers.location).toBe('/module/page');
    expect((await agent.get('/module/page')).text).toBe('hello Jane.Doe');
    const u = auth.store.userByGoogle('1001');
    expect(u.google_email).toBe('jane.doe@example.org');
    expect(u.email).toBe('Jane.Doe@example.org');
    expect(auth.store.rolesOf(u.id)).toEqual([]);
    // a new address at Google: the same account
    info.email = 'jane@example.org';
    await viaGoogle(request.agent(app));
    expect(auth.store.users()).toHaveLength(1);
    expect(auth.store.userByGoogle('1001').google_email).toBe('jane@example.org');
    expect(auth.dailyReport({ since: Date.now() - 60000, now: Date.now() + 1000 })).toMatch(/^2 logins\. /);
  });

  test('an address Google hasn\'t verified, a bad code, or a made-up state is refused', async () => {
    info.email_verified = false;
    const res = await viaGoogle(request.agent(app));
    expect(res.status).toBe(400);
    expect(res.text).toContain('verified email');
    info.email_verified = true;
    expect((await viaGoogle(request.agent(app), { code: 'bad' })).status).toBe(400);
    expect((await request.agent(app).get('/auth/google/callback?code=good&state=x')).status).toBe(400);
    expect(auth.store.users()).toHaveLength(0);
  });

  test('accounts are not matched by email: an address another account has is not taken', async () => {
    await makeUser('jane', GOOD, { email: 'jane.doe@example.org' });
    await viaGoogle(request.agent(app));
    const g = auth.store.userByGoogle('1001');
    expect(g.login).not.toBe('jane');
    expect(g.email).toBeNull();
  });

  test('a password account links Google and logs in with it; it can\'t unlink its only way in', async () => {
    const id = await makeUser('jane', GOOD);
    const { agent } = await login(app, 'jane', GOOD);
    expect((await agent.get('/auth/account')).text).toContain('Link Google account');
    expect((await viaGoogle(agent, { link: true })).headers.location).toBe('/auth/account');
    const fresh = request.agent(app);
    await viaGoogle(fresh);
    expect((await fresh.get('/module/page')).text).toBe('hello jane');
    // without a password, Google is the only way in
    await auth.store.setPassword(id, null);
    await viaGoogle(agent);
    await form(agent, '/auth/account/google/unlink', {}, '/auth/account');
    expect(auth.store.userByGoogle('1001').id).toBe(id);
    expect((await agent.get('/auth/account')).text).toContain('Set a password first');
  });

  test('a configured google: administrator is one when Google says so', async () => {
    info = { sub: '7', email: 'Boss@example.org', email_verified: true, name: 'Boss' };
    await viaGoogle(request.agent(app));
    expect(auth.principalById(auth.store.userByGoogle('7').id).isAdmin).toBe(true);
    // the same address as a plain email entry is a different thing: google: needs Google's word
    expect(auth.isConfiguredAdministrator({ email: 'boss@example.org' }, auth.configuredAdministrators())).toBeFalsy();
  });

  test('a database from before Google gets the columns', () => {
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const Database = require('better-sqlite3');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-old-'));
    const file = path.join(tmp, 'auth.db');
    const old = new Database(file);
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL DEFAULT '',
      email TEXT UNIQUE COLLATE NOCASE, password_hash TEXT, github_id TEXT UNIQUE, github_login TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      epoch INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, last_login_at TEXT)`);
    old.prepare("INSERT INTO users (login, created_at) VALUES ('before', '2026-01-01T00:00:00Z')").run();
    old.close();
    const { AuthStore } = require('../../library/auth/store');
    const store = new AuthStore(file, { bcryptCost: 4 });
    try {
      const u = store.userByLogin('before');
      store.setIdentity('google', u.id, '55', 'before@example.org');
      expect(store.userByGoogle('55').login).toBe('before');
      const other = store.createUser({ login: 'other' });
      expect(() => store.setIdentity('google', other, '55', 'x@example.org')).toThrow();
    } finally {
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('the administrator\'s pages', () => {
  let app;
  let mailer;
  let admin;
  beforeEach(async () => {
    mailer = fakeMailer();
    app = makeApp({}, mailer);
    auth.defineRoles('mod', [{ role: 'use', label: 'Use it' },
      { role: 'edit', label: 'Edit things', scope: { label: 'Project', values: () => [{ value: '1', label: 'one' }, { value: '2', label: 'two' }] } }]);
    await makeUser('admin', ADMIN_PASSWORD, { admin: true });
    admin = (await login(app, 'admin', ADMIN_PASSWORD)).agent;
  });
  afterEach(() => auth.roleDefs.delete('mod'));

  test('only administrators', async () => {
    await makeUser('person', GOOD);
    const { agent } = await login(app, 'person', GOOD);
    expect((await agent.get('/auth/admin/users')).status).toBe(403);
    expect((await request(app).get('/auth/admin/users')).status).toBe(302);
  });

  test('a new account with an email is sent a link to set its password', async () => {
    const res = await form(admin, '/auth/admin/users', { login: 'newbie', name: 'New', email: 'new@example.org' }, '/auth/admin/users');
    expect(res.status).toBe(302);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe('new@example.org');
    expect(mailer.sent[0].text).toContain('with the login newbie');
    expect((await form(admin, '/auth/admin/users', { login: 'newbie' }, '/auth/admin/users')).text).toContain('already a user');
    expect((await form(admin, '/auth/admin/users', { login: 'other', email: 'new@example.org' }, '/auth/admin/users')).text).toContain('already a user with the email');
  });

  test('without email, the link is shown to the administrator, once', async () => {
    const noMail = makeApp();
    await makeUser('admin', ADMIN_PASSWORD, { admin: true });
    const a = (await login(noMail, 'admin', ADMIN_PASSWORD)).agent;
    const res = await form(a, '/auth/admin/users', { login: 'newbie', email: 'new@example.org' }, '/auth/admin/users');
    const page = await a.get(res.headers.location);
    const link = page.text.match(/<b>Password link:<\/b> <code>https:\/\/fhir\.example\.org(\/auth\/reset\/[^<]+)<\/code>/)[1];
    expect((await a.get(res.headers.location)).text).not.toContain(link);
    expect((await request(noMail).get(link)).status).toBe(200);
  });

  test('roles: the modules\' roles, scoped and not, set from the user\'s page', async () => {
    const id = await makeUser('person', GOOD);
    const page = await admin.get(`/auth/admin/users/${id}`);
    expect(page.text).toContain('Use it');
    expect(page.text).toContain('every project');
    const box = (r, s) => JSON.stringify(['mod', r, s]);
    await form(admin, `/auth/admin/users/${id}/roles`, { role: [box('use', ''), box('edit', '2')] }, `/auth/admin/users/${id}`);
    let p = auth.principalById(id);
    expect(p.has('mod', 'use')).toBe(true);
    expect(p.has('mod', 'edit', '2')).toBe(true);
    expect(p.has('mod', 'edit', '1')).toBe(false);
    // a role of a module that isn't running is left alone
    auth.store.grant(id, 'gone', 'thing');
    await form(admin, `/auth/admin/users/${id}/roles`, { role: [box('edit', '')] }, `/auth/admin/users/${id}`);
    p = auth.principalById(id);
    expect(p.has('mod', 'use')).toBe(false);
    expect(p.has('mod', 'edit', '1')).toBe(true);
    expect(p.has('gone', 'thing')).toBe(true);
  });

  test('administrator, disabled, deleted - but not yourself', async () => {
    const id = await makeUser('person', GOOD);
    const { agent: theirs } = await login(app, 'person', GOOD);
    await form(admin, `/auth/admin/users/${id}`, { name: 'P', admin: '1', enabled: '1' }, `/auth/admin/users/${id}`);
    expect(auth.principalById(id).isAdmin).toBe(true);
    await form(admin, `/auth/admin/users/${id}`, { name: 'P', enabled: '1' }, `/auth/admin/users/${id}`);
    expect(auth.principalById(id).isAdmin).toBe(false);
    // disabled: their session ends
    await form(admin, `/auth/admin/users/${id}`, { name: 'P' }, `/auth/admin/users/${id}`);
    expect((await theirs.get('/module/page')).text).toBe('nobody');
    const me = auth.store.userByLogin('admin').id;
    await form(admin, `/auth/admin/users/${me}`, { name: 'Me' }, `/auth/admin/users/${me}`);
    expect(auth.principalById(me).isAdmin).toBe(true);
    expect((await form(admin, `/auth/admin/users/${me}/delete`, {}, `/auth/admin/users/${me}`)).status).toBe(400);
    await form(admin, `/auth/admin/users/${id}/delete`, {}, `/auth/admin/users/${id}`);
    expect(auth.store.userById(id)).toBeNull();
  });

  test('tokens issued for software, with its roles', async () => {
    const id = await makeUser('ci-bot', null, { roles: [['mod', 'use']] });
    await form(admin, `/auth/admin/users/${id}/tokens`, { label: 'ci', expires: '30' }, `/auth/admin/users/${id}`);
    const token = (await admin.get(`/auth/admin/users/${id}`)).text.match(/<b>New token:<\/b> <code[^>]*>([^<]+)<\/code>/)[1];
    expect((await request(app).get('/module/api').set('Authorization', `Bearer ${token}`)).body.who).toBe('ci-bot');
    expect(auth.store.tokensForUser(id)[0].expires_at).toBeTruthy();
  });
});

describe('rate limits', () => {
  test('requests with a login or a token are limited to requestsPerMinute; anonymous ones aren\'t counted', async () => {
    const rateLimit = require('express-rate-limit');
    setupAuth({ requestsPerMinute: 3 });
    const id = await makeUser('bot', null);
    const token = tokenFor(id);
    const app = express();
    app.use(rateLimit(auth.credentialLimits()));
    app.get('/x', (req, res) => res.send('ok'));
    for (let i = 0; i < 6; i++) {
      expect((await request(app).get('/x')).status).toBe(200);
    }
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/x').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    }
    const res = await request(app).get('/x').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(429);
    expect(res.text).toContain('Too many requests with this login or token');
    // a session cookie counts too, and the same address shares the count
    expect((await request(app).get('/x').set('Cookie', 'fhirsmith.sid=s%3Aabc')).status).toBe(429);
    expect((await request(app).get('/x')).status).toBe(200);
  });

  test('sessionOnly counts the session cookie, not a token', async () => {
    const rateLimit = require('express-rate-limit');
    setupAuth({ requestsPerMinute: 1 });
    const app = express();
    app.use(rateLimit(auth.credentialLimits({ sessionOnly: true })));
    app.get('/x', (req, res) => res.send('ok'));
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/x').set('Authorization', 'Bearer fhs_x')).status).toBe(200);
    }
    expect((await request(app).get('/x').set('Cookie', 'fhirsmith.sid=a')).status).toBe(200);
    expect((await request(app).get('/x').set('Cookie', 'fhirsmith.sid=a')).status).toBe(429);
  });
});

describe('the daily report', () => {
  test('nothing when there are no accounts', () => {
    setupAuth();
    expect(auth.dailyReport({ since: Date.now() - 86400000, now: Date.now() })).toBe('');
  });

  test('logins, failed logins altogether and by account, the accounts, and the sessions logged in', async () => {
    const app = makeApp();
    const since = Date.now() - 1000;
    await makeUser('person', GOOD);
    const off = await makeUser('gone-away', GOOD);
    auth.store.setEnabled(off, false);
    const { agent } = await login(app, 'person', GOOD);
    await login(app, 'person', GOOD);
    await login(app, 'person', 'wrong-password');
    await login(app, 'person', 'wrong-again');
    await login(app, 'gone-away', GOOD);
    // names that aren't accounts: counted in the total
    await login(app, 'nobody', GOOD);
    await login(app, 'admin', 'guess');
    await login(app, 'root', 'guess');
    expect((await agent.get('/module/page')).text).toBe('hello person');
    const report = auth.dailyReport({ since, now: Date.now() + 1000 });
    expect(report).toBe('2 logins. 6 failed logins: 3 for names that aren\'t accounts, and 3 for accounts that exist (person 2, gone-away 1). ' +
      '2 user accounts (1 disabled), 2 of them new. 2 sessions are logged in now.');
    // by how, when there was more than one way
    auth.store.recordLogin('login', 'github', 1);
    expect(auth.dailyReport({ since, now: Date.now() + 1000 })).toMatch(/^3 logins \(2 with a password, 1 with GitHub\)\. 6 failed/);
    // the next period has none of them
    expect(auth.dailyReport({ since: Date.now() + 1000, now: Date.now() + 2000 })).toMatch(/^0 logins\. No failed logins\. /);
    // one, for a name that isn't an account
    const t = Date.now() + 3000;
    auth.store.db.prepare("INSERT INTO login_events (at, kind, method, user_id) VALUES (?, 'failed', 'password', NULL)").run(new Date(t).toISOString());
    expect(auth.dailyReport({ since: t - 1, now: t + 1 })).toMatch(/^0 logins\. 1 failed login: 1 for a name that isn't an account\. /);
  });
});

describe('the security review (Nov 2026)', () => {
  test('a login cookie on a request another site made is nobody, on pages and APIs', async () => {
    const app = makeApp();
    const id = await makeUser('person', GOOD, { roles: [['mod', 'use']] });
    const { agent } = await login(app, 'person', GOOD);
    expect((await agent.get('/module/page')).text).toBe('hello person');
    expect((await agent.get('/module/page').set('Origin', 'https://build.example.org')).text).toBe('nobody');
    expect((await agent.get('/module/api')).body.who).toBe('person');
    expect((await agent.get('/module/api').set('Origin', 'https://build.example.org')).status).toBe(401);
    expect((await agent.get('/module/api').set('Origin', 'null')).status).toBe(401);
    // a token is not a cookie: another site's script can only send one it has
    const token = tokenFor(id);
    expect((await request(app).get('/module/api').set('Origin', 'https://build.example.org').set('Authorization', `Bearer ${token}`)).body.via).toBe('token');
  });

  test('the /auth pages, and pages that need a login, can\'t be framed by another site', async () => {
    const app = makeApp();
    for (const url of ['/auth/login', '/auth/account']) {
      const res = await request(app).get(url);
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['content-security-policy']).toBe("frame-ancestors 'self'");
    }
  });

  test('a github: or google: administrator is tied to the first account it matches, and keeps it through a rename', () => {
    const log = { info() {}, warn() {}, error() {} };
    auth.initialize({ database: ':memory:', bcryptCost: 4, administrators: ['github:TheBoss', 'google:boss@example.org', 'github:#555'] }, { log });
    const boss = auth.store.createUser({ login: 'theboss', githubId: 77, githubLogin: 'theboss' });
    expect(auth.principalById(boss).isAdmin).toBe(true);
    expect(auth.store.adminPin('github:theboss')).toBe('77');
    // the boss renames on GitHub, and someone else takes the old name
    auth.store.setGithub(boss, 77, 'the-old-boss');
    const taker = auth.store.createUser({ login: 'taker', githubId: 99, githubLogin: 'theboss' });
    expect(auth.principalById(boss).isAdmin).toBe(true);
    expect(auth.principalById(taker).isAdmin).toBe(false);
    // google: the same
    const g = auth.store.createUser({ login: 'gboss', identity: { provider: 'google', id: 'sub-1', handle: 'boss@example.org' } });
    const g2 = auth.store.createUser({ login: 'gboss2', identity: { provider: 'google', id: 'sub-2', handle: 'boss@example.org' } });
    expect(auth.principalById(g).isAdmin).toBe(true);
    expect(auth.principalById(g2).isAdmin).toBe(false);
    // by id
    const byId = auth.store.createUser({ login: 'byid', githubId: 555, githubLogin: 'whoever' });
    expect(auth.principalById(byId).isAdmin).toBe(true);
    // taken out of the configuration, the tie is forgotten when the server starts
    auth.config.administrators = ['google:boss@example.org'];
    auth.applyConfiguredAdministrators();
    expect(auth.store.adminPin('github:theboss')).toBeNull();
    expect(auth.store.adminPin('google:boss@example.org')).toBe('sub-1');
    expect(auth.principalById(boss).isAdmin).toBe(false);
  });

  test('no password link without auth.publicUrl or hostName - never from the request', async () => {
    setupAuth({ options: { mailer: fakeMailer() } });
    const id = auth.store.createUser({ login: 'person', email: 'p@example.org' });
    expect(auth.passwordLink(id, { protocol: 'https', get: () => 'evil.example.org' })).toBeNull();
    expect(auth.canEmail()).toBe(false);
    expect(await auth.emailPasswordLink(auth.store.userById(id), { protocol: 'https', get: () => 'evil.example.org' })).toBe(false);
  });

  test('forgotten password answers without waiting for the email', async () => {
    const never = { configured: () => true, send: () => new Promise(() => {}) };
    const app = makeApp({}, never);
    await makeUser('person', GOOD, { email: 'person@example.org' });
    const res = await form(request.agent(app), '/auth/forgot', { login: 'person' }, '/auth/forgot');
    expect(res.status).toBe(200);
    expect(res.text).toContain('If there is an account');
  });

  test('changing an account\'s email ends its sessions, and a link sent to the old address', async () => {
    const mailer = fakeMailer();
    const app = makeApp({}, mailer);
    await makeUser('admin', ADMIN_PASSWORD, { admin: true, email: 'admin@example.org' });
    const id = await makeUser('person', GOOD, { email: 'old@example.org' });
    const { agent: theirs } = await login(app, 'person', GOOD);
    const link = auth.passwordLink(id, null).replace('https://fhir.example.org', '');
    const admin = (await login(app, 'admin', ADMIN_PASSWORD)).agent;
    // saving with the same email changes nothing
    await form(admin, `/auth/admin/users/${id}`, { name: 'P', email: 'OLD@example.org', enabled: '1' }, `/auth/admin/users/${id}`);
    expect((await theirs.get('/module/page')).text).toBe('hello person');
    await form(admin, `/auth/admin/users/${id}`, { name: 'P', email: 'new@example.org', enabled: '1' }, `/auth/admin/users/${id}`);
    expect((await theirs.get('/module/page')).text).toBe('nobody');
    expect((await request(app).get(link)).status).toBe(404);
    // an administrator changing their own stays logged in
    const me = auth.store.userByLogin('admin').id;
    await form(admin, `/auth/admin/users/${me}`, { name: 'Me', email: 'me@example.org' }, `/auth/admin/users/${me}`);
    expect((await admin.get('/module/page')).text).toBe('hello admin');
  });

  test('a login can\'t have an @; a name with one is looked up by email first', () => {
    setupAuth();
    expect(() => auth.store.createUser({ login: 'a@example.org' })).toThrow(/A login is/);
    expect(auth.store.freeLogin('a@example.org')).toBe('a-example.org');
    // a login from before, that is another account's email address
    const old = auth.store.createUser({ login: 'placeholder' });
    auth.store.db.prepare('UPDATE users SET login = ? WHERE id = ?').run('alice@example.org', old);
    const alice = auth.store.createUser({ login: 'alice', email: 'alice@example.org' });
    expect(auth.store.userByLoginOrEmail('alice@example.org').id).toBe(alice);
    expect(auth.store.userByLoginOrEmail('alice').id).toBe(alice);
    auth.store.db.prepare('UPDATE users SET login = ? WHERE id = ?').run('bob@example.org', old);
    expect(auth.store.userByLoginOrEmail('bob@example.org').id).toBe(old);
  });

  test('a configured administrator\'s account gets the part of the address before the @ as its login', () => {
    auth.initialize({ database: ':memory:', bcryptCost: 4, administrators: ['grahame@example.org'] }, { log: { info() {}, warn() {}, error() {} } });
    expect(auth.store.userByEmail('grahame@example.org').login).toBe('grahame');
  });

  test('a confirmation with an apostrophe asks (the question is in an attribute, not the script)', async () => {
    const app = makeApp();
    await makeUser('admin', ADMIN_PASSWORD, { admin: true });
    const id = await makeUser('person', GOOD);
    const admin = (await login(app, 'admin', ADMIN_PASSWORD)).agent;
    const page = (await admin.get(`/auth/admin/users/${id}`)).text;
    expect(page).toContain('data-confirm="Remove this user&#39;s password?" onsubmit="return confirm(this.dataset.confirm)"');
    expect(page).not.toMatch(/confirm\('/);
  });
});

describe('node server.js --password-link', () => {
  test('prints a link for an account, and makes a configured administrator\'s', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-cli-'));
    const out = [];
    const err = [];
    const log = jest.spyOn(console, 'log').mockImplementation(m => out.push(m));
    const error = jest.spyOn(console, 'error').mockImplementation(m => err.push(m));
    try {
      const config = { hostName: 'tx.example.org', auth: { database: path.join(dir, 'auth.db'), administrators: ['boss@example.org'], bcryptCost: 4 } };
      expect(wantsPasswordLink(['--password-link', 'x'])).toBe(true);
      expect(wantsPasswordLink(['--check'])).toBe(false);
      expect(runPasswordLink(['--password-link', 'boss@example.org'], config, { databasesDir: dir })).toBe(0);
      expect(out.join('\n')).toMatch(/https:\/\/tx\.example\.org\/auth\/reset\/[A-Za-z0-9_-]+/);
      expect(runPasswordLink(['--password-link=nobody'], config, { databasesDir: dir })).toBe(1);
      expect(err.join('\n')).toContain("no account 'nobody'");
      expect(runPasswordLink(['--password-link'], config, { databasesDir: dir })).toBe(2);
    } finally {
      log.mockRestore();
      error.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
