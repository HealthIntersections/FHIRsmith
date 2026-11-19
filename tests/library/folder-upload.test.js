// The folder module's uploads: an API token of a user with the folder "upload" role for the
// folder, or named in a .users.json (a list of logins) in the directory or above

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const FolderModule = require('../../folder/folder');
const { setupAuth, makeUser, tokenFor } = require('../helpers/auth');

describe('folder uploads', () => {
  let dir;
  let app;
  let uploader;
  let delegate;
  let stranger;
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folder-upload-'));
    fs.mkdirSync(path.join(dir, 'proj'));
    fs.writeFileSync(path.join(dir, 'proj', '.users.json'), JSON.stringify(['delegate']));
    fs.mkdirSync(path.join(dir, 'old'));
    fs.writeFileSync(path.join(dir, 'old', '.users.json'), JSON.stringify({ stranger: 'pw' }));
    setupAuth();
    uploader = tokenFor(await makeUser('uploader', null, { roles: [['folder', 'upload', 'builds']] }));
    delegate = tokenFor(await makeUser('delegate', null));
    stranger = tokenFor(await makeUser('stranger', null));
    app = express();
    const mod = new FolderModule({ countRequest() {} });
    mod.initialize({ folders: [{ name: 'builds', folder: dir, url: '/builds' }] }, app);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const put = (file, auth) => {
    let r = request(app).put(`/builds/${file}`).set('Content-Type', 'application/zip');
    if (auth) {
      r = r.set('Authorization', auth);
    }
    return r.send(Buffer.from('PK'));
  };
  const basic = (login, token) => 'Basic ' + Buffer.from(`${login}:${token}`).toString('base64');

  test('a user with the role uploads anywhere in the folder, by Basic (token as password) or Bearer', async () => {
    expect((await put('a.zip', basic('uploader', uploader))).status).toBe(200);
    expect((await put('proj/b.zip', `Bearer ${uploader}`)).status).toBe(200);
    expect(fs.existsSync(path.join(dir, 'proj', 'b.zip'))).toBe(true);
  });

  test('a user named in a .users.json uploads there and below, not elsewhere', async () => {
    expect((await put('proj/c.zip', basic('delegate', delegate))).status).toBe(200);
    expect((await put('d.zip', basic('delegate', delegate))).status).toBe(403);
  }, 15000);

  test('no token, a password, or an old .users.json with passwords: no upload', async () => {
    expect((await put('e.zip')).status).toBe(401);
    expect((await put('old/e.zip', basic('stranger', 'pw'))).status).toBe(401);
    expect((await put('old/e.zip', basic('stranger', stranger))).status).toBe(403);
  }, 15000);
});
