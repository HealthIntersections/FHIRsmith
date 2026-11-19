// The publisher's users and logins are the server's (library/auth): its administrators manage
// the websites, and the "queue" and "approve" roles, each for a website, say who may do what

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const PublisherModule = require('../../publisher/publisher');
const { auth, ADMIN_PASSWORD, setupAuth, mountAuth, makeUser, login, csrfOf } = require('../helpers/auth');

describe('publisher logins and roles', () => {
  let tmp;
  let mod;
  let app;
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-logins-'));
    require('../../library/html-server').loadTemplate('publisher', path.join(__dirname, '..', '..', 'publisher', 'publisher-template.html'));
    setupAuth();
    await makeUser('admin', ADMIN_PASSWORD, { admin: true, name: 'Administrator' });
    app = express();
    app.set('trust proxy', 'loopback');
    mountAuth(app);
    mod = new PublisherModule({ countRequest() {}, addTask() {}, task() {}, taskDone() {}, taskError() {} });
    await mod.initialize({ database: path.join(tmp, 'publisher.db'), workspaceRoot: tmp, pollInterval: 3600000, adminPassword: 'old' });
    app.use('/publisher', mod.router);
  });
  afterAll(async () => {
    await mod.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const form = async (agent, url, data, page = '/publisher') => {
    const _csrf = await csrfOf(agent, page);
    return agent.post(url).type('form').send({ ...data, _csrf });
  };

  test('the old pages go to the server\'s', async () => {
    expect((await request(app).get('/publisher/login')).headers.location).toBe('/auth/login?return=%2Fpublisher');
    expect((await request(app).get('/publisher/admin/users')).headers.location).toBe('/auth/admin/users');
    expect((await request(app).get('/publisher/admin/websites')).status).toBe(302);
  });

  test('an administrator adds a website, which becomes a scope of the roles; a user given queue for it can queue there', async () => {
    const { agent } = await login(app, 'admin', ADMIN_PASSWORD);
    expect((await agent.get('/publisher')).text).toContain('Welcome, Administrator!');
    const res = await form(agent, '/publisher/admin/websites', {
      name: 'Example IGs', local_folder: tmp, git_root: '', history_templates: tmp, web_templates: tmp, server_update_script: 'true'
    }, '/publisher/admin/websites');
    expect(res.status).toBe(302);
    const website = (await mod.getWebsites())[0];
    expect(mod.websiteList).toEqual([{ value: String(website.id), label: 'Example IGs' }]);
    // the roles, with the website, on the server's page for a user
    const id = await makeUser('editor', 'editor-password-x');
    expect((await agent.get(`/auth/admin/users/${id}`)).text).toContain('Example IGs');

    expect(await mod.userCanQueue(id, website.id)).toBe(false);
    expect(await mod.getUserWebsites(id)).toEqual([]);
    auth.grant(id, 'publisher', 'queue', String(website.id));
    expect(await mod.userCanQueue(id, website.id)).toBe(true);
    expect(await mod.userCanApprove(id, website.id)).toBe(false);
    expect((await mod.getUserWebsites(id)).map(w => w.name)).toEqual(['Example IGs']);
    // an administrator can do anything
    const adminId = auth.store.userByLogin('admin').id;
    expect(await mod.userCanApprove(adminId, website.id)).toBe(true);
    // a plain user can't manage websites
    const { agent: editor } = await login(app, 'editor', 'editor-password-x');
    expect((await editor.get('/publisher/admin/websites')).status).toBe(403);
  });

  test('what users did is logged with their name, which outlives the account', async () => {
    const id = await makeUser('actor', null, { name: 'An Actor' });
    mod.logUserAction(id, 'test_action', 'target-1', '127.0.0.1');
    await new Promise(resolve => setTimeout(resolve, 50));
    auth.store.deleteUser(id);
    const history = await mod.getTaskActions('target-1');
    expect(history[0].user_name).toBe('An Actor (actor)');
  });
});

describe('a publisher database from before the website templates columns', () => {
  test('is migrated, and a website can be created', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-old-db-'));
    const dbPath = path.join(tmp, 'publisher.db');
    // the websites table as early databases have it: no git_root, history_templates or web_templates
    const Database = require('better-sqlite3');
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE websites (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, local_folder TEXT NOT NULL,
      server_update_script TEXT NOT NULL, is_active BOOLEAN DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    old.close();
    setupAuth();
    await makeUser('admin', ADMIN_PASSWORD, { admin: true, name: 'Administrator' });
    const app = express();
    mountAuth(app);
    const pub = new PublisherModule({ countRequest() {}, addTask() {}, task() {}, taskDone() {}, taskError() {} });
    await pub.initialize({ database: dbPath, workspaceRoot: tmp, pollInterval: 3600000 });
    app.use('/publisher', pub.router);
    try {
      const { agent } = await login(app, 'admin', ADMIN_PASSWORD);
      const _csrf = await csrfOf(agent, '/publisher/admin/websites');
      const res = await agent.post('/publisher/admin/websites').type('form').send({ _csrf, name: 'hl7', local_folder: '/w/hl7',
        git_root: '/w/hl7', history_templates: '/w/history', web_templates: '/w/templates', server_update_script: '/w/update.sh' });
      expect(res.status).toBe(302);
      const websites = await pub.getWebsites();
      expect(websites.map(w => [w.name, w.history_templates, w.web_templates])).toEqual([['hl7', '/w/history', '/w/templates']]);
    } finally {
      await pub.shutdown();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
