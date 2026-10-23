const express = require('express');
const request = require('supertest');
const sqlite3 = require('sqlite3');
const jose = require('jose');
const crypto = require('crypto');
const SHLModule = require('../../shl/shl');

describe('SHL Module', () => {
  let app, mod, key, jwe;

  const run = (sql, params = []) => new Promise((resolve, reject) =>
    mod.db.run(sql, params, (err) => err ? reject(err) : resolve()));
  const all = (sql, params = []) => new Promise((resolve, reject) =>
    mod.db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
  const addShl = async (uuid, vhl, fileCount) => {
    await run('INSERT INTO SHL (uuid, vhl, expires_at, password) VALUES (?, ?, ?, ?)',
      [uuid, vhl, new Date(Date.now() + 86400000 * 2).toISOString(), 'pw']);
    for (let i = 0; i < fileCount; i++) {
      await run('INSERT INTO SHLFiles (id, shl_uuid, cnt, type) VALUES (?, ?, ?, ?)',
        [`${uuid}-f${i}`, uuid, Buffer.from(jwe, 'utf8').toString('base64'), 'application/fhir+json']);
    }
  };

  beforeAll(async () => {
    key = crypto.randomBytes(32);
    jwe = await new jose.CompactEncrypt(new TextEncoder().encode('{"resourceType":"Bundle"}'))
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', cty: 'application/fhir+json' })
      .encrypt(new Uint8Array(key));
    mod = new SHLModule({ countRequest: () => {} });
    mod.db = new sqlite3.Database(':memory:');
    await mod.createTables();
    await addShl('one', false, 1);
    await addShl('two', false, 2);
    app = express();
    app.use(express.json());
    app.use('/shl', mod.router);
  });

  afterAll(() => mod.db.close());

  describe('access (U flag GET)', () => {
    test('returns the single file as a JWE, not a manifest', async () => {
      const r = await request(app).get('/shl/access/one?recipient=Dr%20Who').buffer(true).parse((res, cb) => {
        let d = ''; res.on('data', c => { d += c; }); res.on('end', () => cb(null, d));
      });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/^application\/jose/);
      expect(r.body).toBe(jwe);
      const { plaintext } = await jose.compactDecrypt(r.body, new Uint8Array(key));
      expect(new TextDecoder().decode(plaintext)).toBe('{"resourceType":"Bundle"}');
    });

    test('logs the recipient from the query', async () => {
      const rows = await all('SELECT recipient FROM SHLViews WHERE shl_uuid = ?', ['one']);
      expect(rows.map(r => r.recipient)).toContain('Dr Who');
    });

    test('unknown link is 404', async () => {
      const r = await request(app).get('/shl/access/nope?recipient=x');
      expect(r.status).toBe(404);
    });

    test('more than one file still gets the manifest', async () => {
      const r = await request(app).get('/shl/access/two?recipient=x').set('Host', 'example.org');
      expect(r.status).toBe(200);
      expect(r.body.files).toHaveLength(2);
    });
  });

  describe('access (manifest POST)', () => {
    test('returns a finalized manifest with https locations and the JWE embedded', async () => {
      const r = await request(app).post('/shl/access/one').set('Host', 'example.org').send({ recipient: 'x' });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('finalized');
      expect(r.body.files).toHaveLength(1);
      expect(r.body.files[0].contentType).toBe('application/fhir+json');
      expect(r.body.files[0].location).toBe('https://example.org/shl/file/one-f0');
      expect(r.body.files[0].embedded).toBe(jwe);
    });

    test('embeddedLengthMax leaves out embedded', async () => {
      const r = await request(app).post('/shl/access/one').send({ recipient: 'x', embeddedLengthMax: 10 });
      expect(r.status).toBe(200);
      expect(r.body.files[0].embedded).toBeUndefined();
      expect(r.body.files[0].location).toMatch(/^https:\/\//);
    });

    test('recipient is required', async () => {
      const r = await request(app).post('/shl/access/one').send({});
      expect(r.status).toBe(400);
    });
  });
});
