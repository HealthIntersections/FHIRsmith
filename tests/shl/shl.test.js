const express = require('express');
const request = require('supertest');
const sqlite3 = require('sqlite3');
const jose = require('jose');
const crypto = require('crypto');
const SHLModule = require('../../shl/shl');
const { setupAuth, makeUser, tokenFor, auth } = require('../helpers/auth');

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

  describe('VHL', () => {
    test('the manifest is a searchset Bundle of DocumentReferences, the files as attachments', async () => {
      await addShl('vhl1', true, 1);
      const r = await request(app).post('/shl/access/vhl1').set('Host', 'example.org').send({ recipient: 'x' });
      expect(r.status).toBe(200);
      expect(r.body.resourceType).toBe('Bundle');
      expect(r.body.type).toBe('searchset');
      expect(r.body.entry[0].resource).toMatchObject({
        resourceType: 'DocumentReference', status: 'current',
        content: [{ attachment: { contentType: 'application/fhir+json', url: 'https://example.org/shl/file/vhl1-f0' } }]
      });
      expect(r.body.entry[0].resource.content[0].url).toBeUndefined();
    });

    test('signs the link with integer claim keys, as the IPS viewer checks it', async () => {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      mod.config = { certificates: { kid: 'test-kid' }, vhl: { issuer: 'XX' } };
      mod.loadCertificates = () => ({ certPem: publicKey.export({ type: 'spki', format: 'pem' }), keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
      const shlink = 'shlink://eyJ1cmwiOiJodHRwczovL2V4YW1wbGUub3JnL3NobC9hY2Nlc3MvdmhsMSJ9';
      setupAuth();
      expect((await request(app).post('/shl/sign').send({ url: shlink })).status).toBe(401);
      const r = await request(app).post('/shl/sign').set(auth.internalHeaders()).send({ url: shlink });
      expect(r.status).toBe(200);
      const { decodeVhl, loadTrust, Trace } = require('../../ips/viewer');
      const trace = new Trace();
      const out = decodeVhl(`HC1:${r.body.signature}`, loadTrust([{ kid: 'test-kid', name: 'the test key', certificate: publicKey.export({ type: 'spki', format: 'pem' }) }]), trace);
      expect(out).toEqual({ shlink, issuer: 'XX', kid: 'test-kid', verified: true, verifiedBy: 'the test key' });
      expect(trace.entries.filter(e => e.level === 'warning' || e.level === 'error')).toEqual([]);
    });
  });
  describe('create', () => {
    let creator;
    let other;
    beforeAll(async () => {
      setupAuth();
      creator = tokenFor(await makeUser('sharer', null, { roles: [['shl', 'create']] }));
      other = tokenFor(await makeUser('someone', null));
      mod.config = { ...(mod.config || {}) };
    });

    const create = (headers = {}, body = { vhl: false, days: 7 }) => {
      let r = request(app).post('/shl/create');
      for (const [k, v] of Object.entries(headers)) {
        r = r.set(k, v);
      }
      return r.send(body);
    };

    test('for a user with the shl "create" role, or this server itself', async () => {
      let r = await create({ Authorization: `Bearer ${creator}` });
      expect(r.status).toBeLessThan(300);
      expect(typeof r.body.uuid).toBe('string');
      expect(typeof r.body.pword).toBe('string');
      r = await create(auth.internalHeaders());
      expect(r.status).toBeLessThan(300);
    });

    test('not for anyone else; the old password in the body is ignored', async () => {
      expect((await create()).status).toBe(401);
      expect((await create({}, { vhl: false, days: 7, password: 'the-old-shared-password' })).status).toBe(401);
      expect((await create({ Authorization: `Bearer ${other}` })).status).toBe(403);
      // and with the role, an old client's password does no harm
      expect((await create({ Authorization: `Bearer ${creator}` }, { vhl: false, days: 7, password: 'x' })).status).toBeLessThan(300);
    });
  });

  describe('everything but reading a link needs the role', () => {
    test('upload, sign, validate and its status: 401 without a token, 403 without the role; access and file stay open', async () => {
      setupAuth();
      const other = tokenFor(await makeUser('someone', null));
      const creator = tokenFor(await makeUser('sharer', null, { roles: [['shl', 'create']] }));
      const calls = [['post', '/shl/upload', { uuid: 'one', pword: 'pw', files: [] }], ['post', '/shl/sign', { url: 'shlink://x' }],
        ['post', '/shl/validate', {}], ['get', '/shl/validate/status']];
      for (const [method, url, body] of calls) {
        const call = (token) => {
          const r = request(app)[method](url);
          return (token ? r.set('Authorization', `Bearer ${token}`) : r).send(body);
        };
        expect([url, (await call(null)).status]).toEqual([url, 401]);
        expect([url, (await call(other)).status]).toEqual([url, 403]);
        expect([401, 403]).not.toContain((await call(creator)).status);
      }
      expect((await request(app).get('/shl/access/one?recipient=x')).status).toBe(200);
    });
  });

  describe('users: "any"', () => {
    afterEach(() => {
      delete mod.config.users;
    });

    test('any logged in account may make, fill and sign links, not only the role; not load IGs', async () => {
      setupAuth();
      const someone = tokenFor(await makeUser('someone', null));
      const call = (method, url, body) => request(app)[method](url).set('Authorization', `Bearer ${someone}`).send(body);
      expect((await call('post', '/shl/create', { vhl: false, days: 1 })).status).toBe(403);
      mod.config.users = 'any';
      const r = await call('post', '/shl/create', { vhl: false, days: 1 });
      expect(r.status).toBe(201);
      expect((await call('post', '/shl/upload', { uuid: r.body.uuid, pword: r.body.pword, files: [] })).status).not.toBe(403);
      expect((await call('get', '/shl/validate/status')).status).toBe(200);
      expect((await call('post', '/shl/validate/loadig', { packageId: 'x', version: '1' })).status).toBe(403);
      // still nobody without a login
      expect((await request(app).post('/shl/create').send({ vhl: false, days: 1 })).status).toBe(401);
    });
  });

  describe('loading an IG into the validator', () => {
    test('needs the shl "load-ig" role (or an administrator)', async () => {
      setupAuth();
      const loader = tokenFor(await makeUser('loader', null, { roles: [['shl', 'load-ig']] }));
      const other = tokenFor(await makeUser('someone', null));
      const admin = tokenFor(await makeUser('admin', null, { admin: true }));
      const load = (token) => {
        const r = request(app).post('/shl/validate/loadig');
        return (token ? r.set('Authorization', `Bearer ${token}`) : r).send({ packageId: 'hl7.fhir.uv.ips', version: '2.0.0' });
      };
      expect((await load(null)).status).toBe(401);
      expect((await load(other)).status).toBe(403);
      // past the guard: there is no validator running here
      expect((await load(loader)).status).toBe(503);
      expect((await load(admin)).status).toBe(503);
    });
  });
});
