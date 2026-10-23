// Documents the registry stores and serves, and the administrator flag on users

const express = require('express');
const request = require('supertest');
const RegistryModule = require('../../registry/registry');
const { renderMarkdown } = require('../../registry/documents');

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
const USERS = { database: ':memory:', adminPassword: 'admin-secret', cookieSecure: false, sessionSecret: 's' };

async function makeApp(security = { users: USERS }) {
  const app = express();
  app.set('trust proxy', 'loopback');
  const mod = new RegistryModule({ countRequest() {}, addTask() {}, task() {}, taskDone() {}, taskError() {} });
  mod.logger = quiet;
  await mod.initialize({ crawlInterval: 0, releasesUrl: '', security });
  app.use('/tx-reg', mod.router);
  return { app, mod };
}

const csrfOf = async (agent, page) => (await agent.get(page)).text.match(/name="_csrf" value="([^"]+)"/)[1];
const form = async (agent, url, data, page) => {
  const _csrf = await csrfOf(agent, page); // before the post is made, so its cookie jar has the session
  return agent.post(url).type('form').send({ ...data, _csrf });
};
const loginAs = async (app, login, password) => {
  const agent = request.agent(app);
  const res = await form(agent, '/tx-reg/login', { login, password }, '/tx-reg/login');
  return { agent, res };
};
const html = (r) => r.set('Accept', 'text/html');

describe('documents', () => {
  let app, mod, admin;
  beforeAll(async () => {
    ({ app, mod } = await makeApp());
    admin = (await loginAs(app, 'admin', 'admin-secret')).agent;
    // a plain user, and an administrator user
    await form(admin, '/tx-reg/admin/users', { login: 'reader', password: 'password-1' }, '/tx-reg/admin/users');
    await form(admin, '/tx-reg/admin/users', { login: 'editor', password: 'password-2', admin: '1' }, '/tx-reg/admin/users');
  });
  afterAll(() => mod.shutdown());

  test('the list is open, and empty', async () => {
    const res = await html(request(app).get('/tx-reg/docs'));
    expect(res.status).toBe(200);
    expect(res.text).toContain('no documents');
    expect(res.text).not.toContain('New document');
  });

  test('only administrators can create', async () => {
    expect((await html(request(app).get('/tx-reg/docs/new'))).status).toBe(302);
    const { agent: reader } = await loginAs(app, 'reader', 'password-1');
    expect((await html(reader.get('/tx-reg/docs/new'))).status).toBe(403);
  });

  test('the configured administrator creates a public markdown document, and anyone reads it', async () => {
    const r = await form(admin, '/tx-reg/docs', { name: 'policy', type: 'md', public: '1', content: '# Policy\n\nBe <b>nice</b>.\n' }, '/tx-reg/docs/new');
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/tx-reg/docs/policy');

    const page = await html(request(app).get('/tx-reg/docs/policy'));
    expect(page.status).toBe(200);
    expect(page.text).toContain('<h1>Policy</h1>');
    expect(page.text).toContain('Be <b>nice</b>.'); // raw HTML is trusted
    expect(page.text).toContain('last edited');
    expect(page.text).toContain('by admin');
    expect(page.text).not.toContain('/edit"'); // not an admin

    const raw = await request(app).get('/tx-reg/docs/policy');
    expect(raw.status).toBe(200);
    expect(raw.headers['content-type']).toMatch(/text\/markdown/);
    expect(raw.text).toBe('# Policy\n\nBe <b>nice</b>.\n');
    expect(raw.headers['cache-control']).toBe('public, max-age=60');

    expect((await html(request(app).get('/tx-reg/docs'))).text).toContain('href="/tx-reg/docs/policy"');
  });

  test('a private JSON document is for logged in users only, and never for API tokens', async () => {
    let r = await form(admin, '/tx-reg/docs', { name: 'config.v1', type: 'json', content: '{"a": [1, 2]}' }, '/tx-reg/docs/new');
    expect(r.status).toBe(302);

    // a stranger: the list hides it, the browser is sent to log in, a client gets 404
    expect((await html(request(app).get('/tx-reg/docs'))).text).not.toContain('config.v1');
    r = await html(request(app).get('/tx-reg/docs/config.v1'));
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/tx-reg/login');
    expect((await request(app).get('/tx-reg/docs/config.v1')).status).toBe(404);

    // an API token is not a login
    r = await form(admin, '/tx-reg/admin/users/1/tokens', { label: 't' }, '/tx-reg/admin/users/1');
    const token = (await admin.get('/tx-reg/admin/users/1')).text.match(/<b>New token:<\/b> <code[^>]*>([^<]+)<\/code>/)[1];
    expect((await request(app).get('/tx-reg/docs/config.v1').set('Authorization', `Bearer ${token}`)).status).toBe(404);

    // a logged in user, even a plain one, reads it
    const { agent: reader } = await loginAs(app, 'reader', 'password-1');
    expect((await html(reader.get('/tx-reg/docs'))).text).toContain('config.v1');
    const page = await html(reader.get('/tx-reg/docs/config.v1'));
    expect(page.status).toBe(200);
    expect(page.text).toContain('&quot;a&quot;: [\n    1,\n    2\n  ]');
    const raw = await reader.get('/tx-reg/docs/config.v1');
    expect(raw.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(raw.text)).toEqual({ a: [1, 2] });
    expect(raw.headers['cache-control']).toBe('private, no-store');
  });

  test('an administrator user edits, renames, and the log keeps every version', async () => {
    const { agent: editor } = await loginAs(app, 'editor', 'password-2');
    const page = await html(editor.get('/tx-reg/docs/policy'));
    expect(page.text).toContain('/tx-reg/docs/policy/edit"');
    const edit = await html(editor.get('/tx-reg/docs/policy/edit'));
    expect(edit.status).toBe(200);
    expect(edit.text).toContain('Be &lt;b&gt;nice&lt;/b&gt;.');

    let r = await form(editor, '/tx-reg/docs/policy', { name: 'policy', type: 'md', public: '1', content: '# Policy v2\n' }, '/tx-reg/docs/policy/edit');
    expect(r.status).toBe(302);
    expect((await request(app).get('/tx-reg/docs/policy')).text).toBe('# Policy v2\n');

    r = await form(editor, '/tx-reg/docs/policy', { name: 'policies', type: 'md', content: '# Policy v3\n' }, '/tx-reg/docs/policy/edit');
    expect(r.headers.location).toBe('/tx-reg/docs/policies');
    expect((await request(app).get('/tx-reg/docs/policy')).status).toBe(404);
    expect((await request(app).get('/tx-reg/docs/policies')).status).toBe(404); // no longer public
    expect((await editor.get('/tx-reg/docs/policies')).text).toBe('# Policy v3\n');

    const history = await html(editor.get('/tx-reg/docs/policies/history'));
    expect(history.status).toBe(200);
    const rows = history.text.split('<tr>').slice(2);
    expect(rows.map(x => x.match(/<td>(created|edited|renamed|deleted)<\/td>/)[1])).toEqual(['renamed', 'edited', 'created']);
    expect(rows[0]).toContain('<td>editor</td>');
    expect(rows[2]).toContain('<td>admin</td>');
    const first = history.text.match(/history\/(\d+)">[^<]+<\/a><\/td><td>admin/)[1];
    const version = await html(editor.get(`/tx-reg/docs/policies/history/${first}`));
    expect(version.text).toContain('<h1>Policy</h1>');
    expect(version.text).toContain('then named <code>policy</code>');
  });

  test('validation: names, JSON, duplicates', async () => {
    let r = await form(admin, '/tx-reg/docs', { name: 'has space', type: 'md', content: 'x' }, '/tx-reg/docs/new');
    expect(r.status).toBe(400);
    r = await form(admin, '/tx-reg/docs', { name: 'new', type: 'md', content: 'x' }, '/tx-reg/docs/new');
    expect(r.status).toBe(400);
    r = await form(admin, '/tx-reg/docs', { name: 'bad', type: 'json', content: '{oops' }, '/tx-reg/docs/new');
    expect(r.status).toBe(400);
    expect(r.text).toContain('not valid JSON');
    r = await form(admin, '/tx-reg/docs', { name: 'config.v1', type: 'md', content: 'x' }, '/tx-reg/docs/new');
    expect(r.status).toBe(400);
    expect(r.text).toContain('already a document');
    expect((await html(request(app).get('/tx-reg/docs/nothing'))).status).toBe(404);
    expect((await html(request(app).get('/tx-reg/docs/%3Cscript%3E'))).status).toBe(404);
  });

  test('delete is logged, and the name is free again', async () => {
    let r = await form(admin, '/tx-reg/docs/config.v1/delete', {}, '/tx-reg/docs/config.v1/edit');
    expect(r.status).toBe(302);
    expect((await admin.get('/tx-reg/docs/config.v1')).status).toBe(404);
    r = await form(admin, '/tx-reg/docs', { name: 'config.v1', type: 'json', public: '1', content: '[]' }, '/tx-reg/docs/new');
    expect(r.status).toBe(302);
    expect(mod.auth.store.documentLog(mod.auth.store.documentByName('config.v1').id).map(e => e.action)).toEqual(['created']);
  });

  test('the navbar links to the documents', async () => {
    expect((await html(request(app).get('/tx-reg/software'))).text).toContain('href="/tx-reg/docs"');
  });
});

describe('administrator users', () => {
  let app, mod;
  beforeAll(async () => ({ app, mod } = await makeApp()));
  afterAll(() => mod.shutdown());

  test('an admin user manages users and has an account page; a plain user has neither', async () => {
    const root = (await loginAs(app, 'admin', 'admin-secret')).agent;
    await form(root, '/tx-reg/admin/users', { login: 'ops', password: 'password-1', admin: '1' }, '/tx-reg/admin/users');
    await form(root, '/tx-reg/admin/users', { login: 'plain', password: 'password-1' }, '/tx-reg/admin/users');
    expect((await root.get('/tx-reg/admin/users')).text).toMatch(/ops<\/a><\/td><td><\/td><td>yes<\/td><td>yes<\/td>/);

    const { agent: ops, res } = await loginAs(app, 'ops', 'password-1');
    expect(res.headers.location).toBe('/tx-reg/admin/users');
    expect((await ops.get('/tx-reg/admin/users')).status).toBe(200);
    expect((await ops.get('/tx-reg/account')).status).toBe(200);
    let r = await form(ops, '/tx-reg/admin/users', { login: 'made-by-ops' }, '/tx-reg/admin/users');
    expect(r.status).toBe(302);

    const { agent: plain } = await loginAs(app, 'plain', 'password-1');
    expect((await plain.get('/tx-reg/admin/users')).status).toBe(403);

    // the flag can be taken away
    const id = mod.auth.store.userByLogin('ops').id;
    r = await form(root, `/tx-reg/admin/users/${id}`, { name: '', notes: '', enabled: '1' }, `/tx-reg/admin/users/${id}`);
    expect(r.status).toBe(200);
    expect((await ops.get('/tx-reg/admin/users')).status).toBe(403);
    // the configured administrator has no account page of its own
    expect((await root.get('/tx-reg/account')).headers.location).toBe('/tx-reg/admin/users');
  });

  test('an existing database without the admin column is migrated', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const Database = require('better-sqlite3');
    const { AuthStore } = require('../../registry/auth-store');
    const file = path.join(os.tmpdir(), `registry-auth-${process.pid}.db`);
    const old = new Database(file);
    old.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '', password_hash TEXT, enabled INTEGER NOT NULL DEFAULT 1, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)");
    old.exec("INSERT INTO users (login, created_at) VALUES ('legacy', '2026-01-01T00:00:00Z')");
    old.close();
    try {
      const s = new AuthStore(file);
      expect(s.userByLogin('legacy').admin).toBe(false);
      s.updateUser(s.userByLogin('legacy').id, { admin: true });
      expect(s.userByLogin('legacy').admin).toBe(true);
      s.close();
    } finally {
      for (const f of [file, file + '-wal', file + '-shm']) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });
});

describe('markdown', () => {
  test('is rendered with raw HTML allowed', () => {
    expect(renderMarkdown('*a* <span>b</span>')).toBe('<p><em>a</em> <span>b</span></p>\n');
  });
});
