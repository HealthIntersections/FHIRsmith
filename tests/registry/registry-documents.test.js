// Documents the registry stores and serves: the server's administrators edit them, and its
// members read the ones that are not public

const express = require('express');
const request = require('supertest');
const RegistryModule = require('../../registry/registry');
const { renderMarkdown } = require('../../registry/documents');
const { ADMIN_PASSWORD, setupAuth, mountAuth, makeUser, tokenFor, login } = require('../helpers/auth');

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
async function makeApp(security = { database: ':memory:' }) {
  const app = express();
  app.set('trust proxy', 'loopback');
  setupAuth();
  mountAuth(app);
  await makeUser('admin', ADMIN_PASSWORD, { admin: true });
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
const loginAs = (app, name, password) => login(app, name, password);
const html = (r) => r.set('Accept', 'text/html');

describe('documents', () => {
  let app, mod, admin;
  beforeAll(async () => {
    ({ app, mod } = await makeApp());
    admin = (await loginAs(app, 'admin', ADMIN_PASSWORD)).agent;
    // a member of the registry, a user who is not, and another administrator
    await makeUser('reader', 'password-1', { roles: [['registry', 'member']] });
    await makeUser('plain', 'password-1');
    await makeUser('editor', 'password-2', { admin: true });
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
    // raw HTML in markdown is left out: no markup a document's author writes reaches the page
    expect(page.text).toContain('Be <!-- raw HTML omitted -->nice<!-- raw HTML omitted -->.');
    expect(page.text).not.toContain('<b>nice</b>');
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

  test('a private JSON document is for members logged in only, and never for API tokens', async () => {
    let r = await form(admin, '/tx-reg/docs', { name: 'config.v1', type: 'json', content: '{"a": [1, 2]}' }, '/tx-reg/docs/new');
    expect(r.status).toBe(302);

    // a stranger: the list hides it, the browser is sent to log in, a client gets 404
    expect((await html(request(app).get('/tx-reg/docs'))).text).not.toContain('config.v1');
    r = await html(request(app).get('/tx-reg/docs/config.v1'));
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/auth/login?return=%2Ftx-reg%2Fdocs%2Fconfig.v1');
    expect((await request(app).get('/tx-reg/docs/config.v1')).status).toBe(404);

    // an API token is not a login, even a member's
    const token = tokenFor(require('../../library/auth').store.userByLogin('reader').id);
    expect((await request(app).get('/tx-reg/docs/config.v1').set('Authorization', `Bearer ${token}`)).status).toBe(404);

    // a logged in user who is not a member doesn't see it
    const { agent: plain } = await loginAs(app, 'plain', 'password-1');
    expect((await html(plain.get('/tx-reg/docs'))).text).not.toContain('config.v1');

    // a member reads it
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
    // its own document, so that it runs on its own (jest -t) as well as after the others
    const created = await form(admin, '/tx-reg/docs', { name: 'charter', type: 'md', public: '1', content: '# Charter\n\nBe <b>nice</b>.\n' }, '/tx-reg/docs/new');
    expect(created.status).toBe(302);
    const { agent: editor } = await loginAs(app, 'editor', 'password-2');
    const page = await html(editor.get('/tx-reg/docs/charter'));
    expect(page.text).toContain('/tx-reg/docs/charter/edit"');
    const edit = await html(editor.get('/tx-reg/docs/charter/edit'));
    expect(edit.status).toBe(200);
    expect(edit.text).toContain('Be &lt;b&gt;nice&lt;/b&gt;.');

    let r = await form(editor, '/tx-reg/docs/charter', { name: 'charter', type: 'md', public: '1', content: '# Charter v2\n' }, '/tx-reg/docs/charter/edit');
    expect(r.status).toBe(302);
    expect((await request(app).get('/tx-reg/docs/charter')).text).toBe('# Charter v2\n');

    r = await form(editor, '/tx-reg/docs/charter', { name: 'charters', type: 'md', content: '# Charter v3\n' }, '/tx-reg/docs/charter/edit');
    expect(r.headers.location).toBe('/tx-reg/docs/charters');
    expect((await request(app).get('/tx-reg/docs/charter')).status).toBe(404);
    expect((await request(app).get('/tx-reg/docs/charters')).status).toBe(404); // no longer public
    expect((await editor.get('/tx-reg/docs/charters')).text).toBe('# Charter v3\n');

    const history = await html(editor.get('/tx-reg/docs/charters/history'));
    expect(history.status).toBe(200);
    const rows = history.text.split('<tr>').slice(2);
    expect(rows.map(x => x.match(/<td>(created|edited|renamed|deleted)<\/td>/)[1])).toEqual(['renamed', 'edited', 'created']);
    expect(rows[0]).toContain('<td>editor</td>');
    expect(rows[2]).toContain('<td>admin</td>');
    const first = history.text.match(/history\/(\d+)">[^<]+<\/a><\/td><td>admin/)[1];
    const version = await html(editor.get(`/tx-reg/docs/charters/history/${first}`));
    expect(version.text).toContain('<h1>Charter</h1>');
    expect(version.text).toContain('then named <code>charter</code>');
  });

  test('a document bigger than the auth forms\' 64kb can be saved, up to the 2 MB limit', async () => {
    const big = '# Big\n\n' + 'All work and no play. '.repeat(15000) + '\n';
    expect(big.length).toBeGreaterThan(300000);
    const r = await form(admin, '/tx-reg/docs', { name: 'big', type: 'md', public: '1', content: big }, '/tx-reg/docs/new');
    expect(r.status).toBe(302);
    expect((await request(app).get('/tx-reg/docs/big')).text).toBe(big);
    const tooBig = await form(admin, '/tx-reg/docs', { name: 'toobig', type: 'md', content: 'x'.repeat(2 * 1024 * 1024 + 10) }, '/tx-reg/docs/new');
    expect(tooBig.status).toBe(400);
    expect(tooBig.text).toMatch(/too large/);
  });

  test('a version from when the document was private stays private', async () => {
    let r = await form(admin, '/tx-reg/docs', { name: 'secret', type: 'md', content: 'the password is swordfish\n' }, '/tx-reg/docs/new');
    expect(r.status).toBe(302);
    r = await form(admin, '/tx-reg/docs/secret', { name: 'secret', type: 'md', public: '1', content: 'nothing to see\n' }, '/tx-reg/docs/secret/edit');
    expect(r.status).toBe(302);
    // public now: anyone reads it, and its public history, but not the private version
    expect((await request(app).get('/tx-reg/docs/secret')).text).toBe('nothing to see\n');
    const history = await html(request(app).get('/tx-reg/docs/secret/history'));
    expect(history.status).toBe(200);
    const ids = [...history.text.matchAll(/history\/(\d+)"/g)].map(m => m[1]);
    expect(ids).toHaveLength(1);
    const all = [...(await html(admin.get('/tx-reg/docs/secret/history'))).text.matchAll(/history\/(\d+)"/g)].map(m => m[1]);
    expect(all).toHaveLength(2);
    const hidden = all.find(id => !ids.includes(id));
    const denied = await html(request(app).get(`/tx-reg/docs/secret/history/${hidden}`));
    expect(denied.status).not.toBe(200);
    expect(denied.text).not.toContain('swordfish');
    expect((await html(admin.get(`/tx-reg/docs/secret/history/${hidden}`))).text).toContain('swordfish');
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

describe('the registry\'s database', () => {
  test('one from before (with users and tokens tables of its own) still opens', () => {
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
      s.createDocument({ name: 'x', type: 'md', content: '# x' }, 'admin');
      expect(s.documentByName('x').content).toBe('# x');
      s.close();
    } finally {
      for (const f of [file, file + '-wal', file + '-shm']) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
  });
});

describe('markdown', () => {
  test('is rendered without raw HTML, and without script links', () => {
    expect(renderMarkdown('*a* <span>b</span>')).toBe('<p><em>a</em> <!-- raw HTML omitted -->b<!-- raw HTML omitted --></p>\n');
    expect(renderMarkdown('<script>alert(1)</script>')).not.toContain('<script');
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('javascript:');
    expect(renderMarkdown('[x](https://example.org/)')).toContain('<a href="https://example.org/">x</a>');
  });
});
