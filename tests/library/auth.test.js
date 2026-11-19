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
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '/a\r\nLocation: x', undefined]) {
      expect(safeReturn(bad, '/home')).toBe('/home');
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

describe('the daily report', () => {
  test('nothing when there are no accounts', () => {
    setupAuth();
    expect(auth.dailyReport({ since: Date.now() - 86400000, now: Date.now() })).toBe('');
  });

  test('logins, failed logins for accounts that exist, the accounts, and the sessions logged in', async () => {
    const app = makeApp();
    const since = Date.now() - 1000;
    await makeUser('person', GOOD);
    const off = await makeUser('gone-away', GOOD);
    auth.store.setEnabled(off, false);
    const { agent } = await login(app, 'person', GOOD);
    await login(app, 'person', GOOD);
    await login(app, 'person', 'wrong-password');
    await login(app, 'gone-away', GOOD);
    // not an account: not counted
    await login(app, 'nobody', GOOD);
    expect((await agent.get('/module/page')).text).toBe('hello person');
    const report = auth.dailyReport({ since, now: Date.now() + 1000 });
    expect(report).toBe('2 logins, and 2 failed logins for accounts that exist. 2 user accounts (1 disabled), 2 of them new. 2 sessions are logged in now.');
    // by how, when there was more than one way
    auth.store.recordLogin('login', 'github', 1);
    expect(auth.dailyReport({ since, now: Date.now() + 1000 })).toMatch(/^3 logins \(2 with a password, 1 with GitHub\), and 2 failed/);
    // the next period has none of them
    expect(auth.dailyReport({ since: Date.now() + 1000, now: Date.now() + 2000 })).toMatch(/^0 logins, and 0 failed logins/);
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
