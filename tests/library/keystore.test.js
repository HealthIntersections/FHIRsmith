// The key store (library/keystore): reading uploads, refusing private keys, key ids, limits,
// making key pairs, revoking and deleting, signing and checking, and the /keys pages and API

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { auth, setupAuth, mountAuth, makeUser, tokenFor, csrfOf, login } = require('../helpers/auth');
const keystore = require('../../library/keystore');
const keys = require('../../library/keystore/keys');

const quiet = { info() {}, warn() {}, error() {} };
const PASSWORD = 'a-long-enough-password';

function setup(config = {}) {
  setupAuth();
  keystore.initialize({ database: ':memory:', privateDatabase: ':memory:', ...config }, { log: quiet, auth });
  return keystore;
}

async function principal(loginName, options = {}) {
  const id = await makeUser(loginName, null, { name: options.name || `${loginName} name`, ...options });
  return auth.principalById(id);
}

function ecPem() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' });
}

function sshLine(type) {
  // an OpenSSH line, built from a node key
  const str = b => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  if (type === 'ed25519') {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const x = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
    return { key: publicKey, line: `ssh-ed25519 ${Buffer.concat([str(Buffer.from('ssh-ed25519')), str(x)]).toString('base64')} me@laptop` };
  }
  if (type === 'rsa') {
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const j = publicKey.export({ format: 'jwk' });
    const mp = b => (b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
    return { key: publicKey, line: `ssh-rsa ${Buffer.concat([str(Buffer.from('ssh-rsa')), str(mp(Buffer.from(j.e, 'base64url'))), str(mp(Buffer.from(j.n, 'base64url')))]).toString('base64')}` };
  }
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const j = publicKey.export({ format: 'jwk' });
  const q = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]);
  return { key: publicKey, line: `ecdsa-sha2-nistp384 ${Buffer.concat([str(Buffer.from('ecdsa-sha2-nistp384')), str(Buffer.from('nistp384')), str(q)]).toString('base64')}` };
}

function spkiOf(key) {
  return key.export({ type: 'spki', format: 'der' });
}

afterAll(() => {
  keystore.shutdown();
  auth.shutdown();
});

describe('reading uploads (keys.js)', () => {
  test('PEM, PKCS#1 PEM, JWK, JWKS, base64 and binary DER', () => {
    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const fp = keys.fingerprint(spkiOf(publicKey));
    expect(keys.parseUpload(publicKey.export({ type: 'spki', format: 'pem' }))[0]).toMatchObject({ kty: 'EC-P256', sourceFormat: 'pem' });
    expect(keys.fingerprint(keys.parseUpload(spkiOf(publicKey))[0].spki)).toBe(fp);
    expect(keys.fingerprint(keys.parseUpload(spkiOf(publicKey).toString('base64'))[0].spki)).toBe(fp);
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'my-key', alg: 'ES256', use: 'sig' };
    expect(keys.parseUpload(JSON.stringify(jwk))[0]).toMatchObject({ kid: 'my-key', alg: 'ES256', sourceFormat: 'jwk' });
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
    expect(keys.parseUpload(rsa.export({ type: 'pkcs1', format: 'pem' }))[0]).toMatchObject({ kty: 'RSA', bits: 2048 });
    const jwks = { keys: [jwk, { ...rsa.export({ format: 'jwk' }), kid: 'r', alg: 'PS256' }] };
    expect(keys.parseUpload(JSON.stringify(jwks)).map(k => k.kty)).toEqual(['EC-P256', 'RSA']);
  });

  test('OpenSSH lines: Ed25519 (the comment is the label), RSA, ECDSA P-384', () => {
    for (const t of ['ed25519', 'rsa', 'ecdsa']) {
      const { key, line } = sshLine(t);
      const [k] = keys.parseUpload(line);
      expect(k.sourceFormat).toBe('ssh');
      expect(keys.fingerprint(k.spki)).toBe(keys.fingerprint(spkiOf(key)));
    }
    expect(keys.parseUpload(sshLine('ed25519').line)[0].label).toBe('me@laptop');
    expect(() => keys.parseUpload('ssh-dss AAAAB3NzaC1kc3MAAACBAP1')).toThrow(/not supported/);
  });

  test('an X.509 certificate: the key, and the certificate kept as uploaded', () => {
    // a self-signed certificate, made with openssl when it is there
    const { execFileSync } = require('child_process');
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-'));
    let pem;
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', path.join(dir, 'k.pem'),
        '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=Test Signer'], { stdio: 'ignore' });
      pem = fs.readFileSync(path.join(dir, 'c.pem'), 'utf8');
    } catch {
      return; // no openssl
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const [k] = keys.parseUpload(pem);
    expect(k).toMatchObject({ kty: 'EC-P256', sourceFormat: 'x509', label: 'Test Signer' });
    expect(k.source).toContain('BEGIN CERTIFICATE');
    const der = new crypto.X509Certificate(pem).raw;
    expect(keys.parseUpload(der)[0].sourceFormat).toBe('x509');
  });

  test('private keys are refused, in every form, never stripped', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const refused = (input) => {
      try {
        keys.parseUpload(input);
      } catch (e) {
        return e.kind;
      }
      return 'accepted';
    };
    expect(refused(privateKey.export({ type: 'pkcs8', format: 'pem' }))).toBe('private');
    expect(refused(privateKey.export({ type: 'sec1', format: 'pem' }))).toBe('private');
    expect(refused(privateKey.export({ type: 'pkcs8', format: 'der' }))).toBe('private');
    expect(refused(privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'))).toBe('private');
    // a PEM with the public key and the private key in one file
    expect(refused(publicKey.export({ type: 'spki', format: 'pem' }) + privateKey.export({ type: 'pkcs8', format: 'pem' }))).toBe('private');
    expect(refused(JSON.stringify(privateKey.export({ format: 'jwk' })))).toBe('private');
    expect(refused(JSON.stringify({ keys: [publicKey.export({ format: 'jwk' }), privateKey.export({ format: 'jwk' })] }))).toBe('private');
    expect(refused(JSON.stringify({ kty: 'oct', k: 'c2VjcmV0' }))).toBe('private');
    expect(refused('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----')).toBe('private');
    expect(refused('PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none')).toBe('private');
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(refused(rsa.export({ type: 'pkcs1', format: 'pem' }))).toBe('private');
    expect(refused(rsa.export({ type: 'pkcs1', format: 'der' }))).toBe('private');
  });

  test('key types the store doesn\'t take, and what isn\'t a key', () => {
    const kind = (input) => {
      try {
        keys.parseUpload(input);
      } catch (e) {
        return e.kind;
      }
      return 'accepted';
    };
    expect(kind(crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey.export({ type: 'spki', format: 'pem' }))).toBe('unsupported');
    expect(kind(crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' }))).toBe('unsupported');
    expect(kind(crypto.generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'pem' }))).toBe('unsupported');
    expect(kind('-----BEGIN PGP PUBLIC KEY BLOCK-----\nabc\n-----END PGP PUBLIC KEY BLOCK-----')).toBe('unsupported');
    expect(kind('hello world')).toBe('unsupported');
    expect(kind('')).toBe('invalid');
    expect(kind('{"kty": "EC"')).toBe('invalid');
    expect(kind(JSON.stringify({ ...crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }), use: 'enc' }))).toBe('invalid');
    expect(kind(JSON.stringify({ ...crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }), alg: 'RS256' }))).toBe('invalid');
    expect(kind(ecPem() + ecPem())).toBe('invalid');
  });

  test('claimed key ids: printable, no spaces; SHA256: ids must be the key\'s own', () => {
    const spki = spkiOf(crypto.generateKeyPairSync('ed25519').publicKey);
    expect(keys.kidProblem('my-key-1', spki)).toBe('');
    expect(keys.kidProblem('has space', spki)).not.toBe('');
    expect(keys.kidProblem('', spki)).not.toBe('');
    expect(keys.kidProblem('SHA256:abc', spki)).toMatch(/fingerprint/);
    expect(keys.kidProblem(keys.fingerprint(spki), spki)).toBe('');
  });
});

describe('the store', () => {
  beforeEach(() => setup());

  test('upload: owned by the uploader; a key and a key id only once; a JWK\'s kid is a claim', async () => {
    const alice = await principal('alice');
    const bob = await principal('bob');
    const pem = ecPem();
    const [k] = keystore.upload(alice, pem, { label: 'laptop' });
    expect(k).toMatchObject({ owner: String(alice.id), origin: 'uploaded', status: 'active', claimed: 0, label: 'laptop', has_private: 0 });
    expect(k.key_id).toBe(k.fingerprint);
    expect(() => keystore.upload(bob, pem)).toThrow(/already in the store/);
    const jwk = { ...crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }), kid: 'shared-kid' };
    expect(keystore.upload(bob, JSON.stringify(jwk))[0]).toMatchObject({ key_id: 'shared-kid', claimed: 1 });
    expect(() => keystore.upload(alice, ecPem(), { kid: 'shared-kid' })).toThrow(/already taken/);
    expect(keystore.upload(alice, ecPem(), { kid: 'alice-1' })[0].key_id).toBe('alice-1');
    expect(keystore.ownerName(k)).toBe('alice name');
  });

  test('upload limits: 10, then one a day; administrators have none; a JWKS counts each key', async () => {
    const carol = await principal('carol');
    for (let i = 0; i < 10; i++) {
      keystore.upload(carol, ecPem());
    }
    // all ten today: the day's one is used too
    expect(keystore.uploadsLeft(carol)).toBe(0);
    expect(() => keystore.upload(carol, ecPem())).toThrow(/tomorrow/);
    // a day later
    keystore.db.db.prepare("UPDATE key_events SET at = '2020-01-01T00:00:00.000Z'").run();
    expect(keystore.uploadsLeft(carol)).toBe(1);
    const jwk = () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
    expect(() => keystore.upload(carol, JSON.stringify({ keys: [jwk(), jwk()] }))).toThrow(/1 more key/);
    keystore.upload(carol, ecPem());
    const admin = await principal('root', { admin: true });
    expect(keystore.uploadsLeft(admin)).toBe(Infinity);
    // refused uploads are logged, for the daily report
    expect(keystore.db.db.prepare("SELECT COUNT(*) AS n FROM key_events WHERE kind = 'refused'").get().n).toBe(2);
  });

  test('create: one active pair per type; a new one retires the old and destroys its private key; once a day per type', async () => {
    const dave = await principal('dave');
    const k1 = await keystore.create(dave, 'EC-P256');
    expect(k1).toMatchObject({ origin: 'created', status: 'active', has_private: 1, owner: String(dave.id) });
    expect(keystore.db.privateKey(k1.key_id)).not.toBeNull();
    await expect(keystore.create(dave, 'EC-P256')).rejects.toThrow(/tomorrow/);
    // another type, the same day: fine
    await keystore.create(dave, 'Ed25519');
    keystore.db.db.prepare("UPDATE key_events SET at = '2020-01-01T00:00:00.000Z'").run();
    const k2 = await keystore.create(dave, 'EC-P256');
    expect(keystore.keyById(k1.id)).toMatchObject({ status: 'retired', has_private: 0 });
    expect(keystore.db.privateKey(k1.key_id)).toBeNull();
    expect(keystore.signingKey(dave.id, 'EC-P256').id).toBe(k2.id);
    await expect(keystore.create(dave, 'DSA')).rejects.toThrow(/Unknown key type/);
  });

  test('system keys: administrators only, one active per type, no limits', async () => {
    const admin = await principal('root', { admin: true });
    const user = await principal('erin');
    await expect(keystore.create(user, 'EC-P256', { system: true })).rejects.toThrow(/administrators/);
    const s1 = await keystore.create(admin, 'EC-P256', { system: true });
    const s2 = await keystore.create(admin, 'EC-P256', { system: true });
    expect(s2.owner).toBe(keystore.SYSTEM);
    expect(keystore.keyById(s1.id).status).toBe('retired');
    expect(keystore.ownerName(s2)).toBe('System');
    expect(keystore.list({ system: true })).toHaveLength(2);
  });

  test('revoke: owners and administrators; stays listed, with an expiry and reason; the private key goes', async () => {
    const frank = await principal('frank');
    const grace = await principal('grace');
    const admin = await principal('root', { admin: true });
    const k = await keystore.create(frank, 'EC-P256');
    expect(() => keystore.revoke(grace, k.id)).toThrow(/only your own/);
    const r = keystore.revoke(frank, k.id, { reason: 'laptop stolen', expires: '2026-11-01T10:00' });
    expect(r).toMatchObject({ status: 'revoked', reason: 'laptop stolen', expires: '2026-11-01T10:00:00.000Z', has_private: 0 });
    expect(keystore.db.privateKey(k.key_id)).toBeNull();
    expect(() => keystore.revoke(frank, k.id)).toThrow(/already revoked/);
    const [u] = keystore.upload(grace, ecPem());
    expect(keystore.revoke(admin, u.id).status).toBe('revoked');
    expect(() => keystore.revoke(frank, u.id, {})).toThrow();
  });

  test('delete and key id changes: administrators only', async () => {
    const heidi = await principal('heidi');
    const admin = await principal('root', { admin: true });
    const [u] = keystore.upload(heidi, ecPem(), { kid: 'taken-kid' });
    expect(() => keystore.remove(heidi, u.id)).toThrow(/administrators/);
    expect(() => keystore.setKid(heidi, u.id, 'x')).toThrow(/administrators/);
    // the administrator sorts out a disputed id: the squatter's key gets its fingerprint
    expect(keystore.setKid(admin, u.id, '').key_id).toBe(u.fingerprint);
    expect(keystore.key('taken-kid')).toBeNull();
    const c = await keystore.create(heidi, 'Ed25519');
    expect(keystore.setKid(admin, c.id, 'heidi-ed').key_id).toBe('heidi-ed');
    // the private key moved with it
    expect(keystore.sign({ owner: heidi.id, purpose: 'test:x', payload: 'hi' }).keyId).toBe('heidi-ed');
    expect(() => keystore.setKid(admin, c.id, u.fingerprint)).toThrow(/own SHA-256 fingerprint/);
    keystore.upload(heidi, ecPem(), { kid: 'other-kid' });
    expect(() => keystore.setKid(admin, c.id, 'other-kid')).toThrow(/taken/);
    keystore.remove(admin, c.id);
    expect(keystore.key('heidi-ed')).toBeNull();
    expect(keystore.db.privateKey('heidi-ed')).toBeNull();
  });

  test('sign and verify: each type; JWS, detached; a revoked key fails from its expiry; a disabled account signs nothing', async () => {
    const ivan = await principal('ivan');
    for (const kty of Object.keys(keystore.KEY_TYPES)) {
      const k = await keystore.create(ivan, kty);
      const s = keystore.sign({ owner: ivan.id, purpose: 'test:sign', payload: 'the payload', kty });
      expect(s.keyId).toBe(k.key_id);
      expect(keystore.verify({ kid: s.keyId, alg: s.alg, data: 'the payload', signature: s.signature }).ok).toBe(true);
      expect(keystore.verify({ kid: s.keyId, alg: s.alg, data: 'another payload', signature: s.signature }).ok).toBe(false);
    }
    // the default type: P-256
    expect(keystore.sign({ owner: ivan.id, purpose: 'test:sign', payload: 'x' }).alg).toBe('ES256');
    expect(keystore.sign({ owner: ivan.id, purpose: 'test:sign', payload: 'x', kty: 'RSA', alg: 'PS256' }).alg).toBe('PS256');
    expect(() => keystore.sign({ owner: ivan.id, payload: 'x' })).toThrow(/purpose/);
    const jws = keystore.signJws({ owner: ivan.id, purpose: 'test:jws', payload: '{"a":1}', header: { canon: 'http://hl7.org/fhir/canonicalization/json' } });
    expect(jws.split('.')[1]).toBe('');
    const v = keystore.verifyJws(jws, '{"a":1}');
    expect(v).toMatchObject({ ok: true, owner: 'User: ivan name' });
    expect(keystore.verifyJws(jws, '{"a":2}').ok).toBe(false);
    // the jose library agrees
    const jose = require('jose');
    const header = JSON.parse(Buffer.from(jws.split('.')[0], 'base64url').toString());
    const pub = await jose.importJWK(keystore.jwk(keystore.key(header.kid)), 'ES256');
    await expect(jose.flattenedVerify({ protected: jws.split('.')[0], payload: Buffer.from('{"a":1}').toString('base64url'), signature: jws.split('.')[2] }, pub)).resolves.toBeTruthy();
    // revoked from a time: signatures made before it are fine, after it not
    const k = keystore.signingKey(ivan.id, 'EC-P256');
    const s = keystore.sign({ owner: ivan.id, purpose: 'test:sign', payload: 'p' });
    keystore.revoke(ivan, k.id, { expires: '2026-06-01T00:00:00Z' });
    expect(keystore.verify({ kid: s.keyId, alg: 'ES256', data: 'p', signature: s.signature, at: '2026-05-01T00:00:00Z' }).ok).toBe(true);
    expect(keystore.verify({ kid: s.keyId, alg: 'ES256', data: 'p', signature: s.signature, at: '2026-07-01T00:00:00Z' }).problem).toMatch(/revoked/);
    expect(() => keystore.sign({ owner: ivan.id, purpose: 't', payload: 'x', kty: 'EC-P256' })).toThrow(/no EC P-256 key pair/);
    // a disabled account
    auth.store.db.prepare('UPDATE users SET enabled = 0 WHERE id = ?').run(ivan.id);
    expect(() => keystore.sign({ owner: ivan.id, purpose: 't', payload: 'x' })).toThrow(/disabled/);
    // every use is logged
    expect(keystore.db.db.prepare("SELECT COUNT(*) AS n FROM key_events WHERE kind = 'sign' AND operation = 'test:sign'").get().n).toBeGreaterThan(4);
  });

  test('the system signs', async () => {
    const admin = await principal('root', { admin: true });
    await keystore.create(admin, 'EC-P256', { system: true });
    const s = keystore.sign({ owner: keystore.SYSTEM, purpose: 'test:system', payload: 'x' });
    expect(keystore.verify({ kid: s.keyId, alg: s.alg, data: 'x', signature: s.signature })).toMatchObject({ ok: true, owner: 'System' });
  });

  test('housekeeping: a deleted account\'s private keys are destroyed; its public keys stay', async () => {
    const judy = await principal('judy');
    const k = await keystore.create(judy, 'EC-P256');
    auth.store.db.prepare('DELETE FROM users WHERE id = ?').run(judy.id);
    keystore.housekeeping();
    expect(keystore.keyById(k.id)).toMatchObject({ has_private: 0, status: 'active' });
    expect(keystore.db.privateKey(k.key_id)).toBeNull();
    expect(keystore.ownerName(k)).toMatch(/deleted/);
  });

  test('no account can be called System, so no user key looks like the system\'s', async () => {
    expect(() => auth.store.createUser({ login: 'sys1', name: 'System' })).toThrow(/the server's own name/);
    const id = auth.store.createUser({ login: 'sys2', name: 'Someone' });
    expect(() => auth.store.updateUser(id, { name: ' system ' })).toThrow(/the server's own name/);
    expect(() => auth.store.updateUser(id, { name: 'The System' })).toThrow(/the server's own name/);
    auth.store.updateUser(id, { name: 'Systematic' });
    // a user whose login is "system", and has no name: still shown as a user
    const p = auth.principalById(auth.store.createUser({ login: 'system' }));
    const [k] = keystore.upload(p, ecPem());
    expect(keystore.ownerLabel(k)).toBe('User: system');
    expect(keystore.jwk(k)).toMatchObject({ ownerKind: 'user', owner: 'User: system' });
  });

  test('JWKS: kid, alg, use and what the store knows; filters', async () => {
    const admin = await principal('root', { admin: true });
    const ken = await principal('ken');
    await keystore.create(admin, 'Ed25519', { system: true });
    const [u] = keystore.upload(ken, ecPem());
    keystore.revoke(ken, u.id);
    const all = keystore.jwks();
    expect(all.keys).toHaveLength(2);
    expect(all.keys.find(k => k.ownerKind === 'system')).toMatchObject({ owner: 'System', kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig', status: 'active', origin: 'created' });
    expect(all.keys.find(k => k.owner === 'User: ken name')).toMatchObject({ status: 'revoked', origin: 'uploaded', signs: false });
    expect(all.keys.find(k => k.ownerKind === 'system').signs).toBe(true);
    expect(keystore.jwks({ status: 'active' }).keys).toHaveLength(1);
    expect(keystore.jwks({ system: true }).keys).toHaveLength(1);
    // no private members, ever
    expect(JSON.stringify(all)).not.toMatch(/"d":/);
  });

  test('the daily report', async () => {
    const lee = await principal('lee');
    expect(keystore.dailyReport({ since: Date.now() - 86400000, now: Date.now() + 1000 })).toBe('');
    keystore.upload(lee, ecPem());
    await keystore.create(lee, 'EC-P256');
    keystore.sign({ owner: lee.id, purpose: 'ips:sign', payload: 'x' });
    expect(() => keystore.upload(lee, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }))).toThrow();
    const text = keystore.dailyReport({ since: Date.now() - 86400000, now: Date.now() + 1000 });
    expect(text).toMatch(/2 keys \(2 active\)/);
    expect(text).toMatch(/1 uploaded, 1 made/);
    expect(text).toMatch(/1 upload refused \(1 private keys\)/);
    expect(text).toMatch(/ips:sign 1/);
  });
});

describe('the private database', () => {
  test('a file of its own, 0600', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-db-'));
    try {
      setupAuth();
      keystore.initialize({}, { log: quiet, auth, databasesDir: dir });
      expect(fs.statSync(path.join(dir, 'keystore-private.db')).mode & 0o777).toBe(0o600);
      // no WAL for the private keys (it would keep a destroyed key's old pages)
      expect(keystore.db.secrets.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(keystore.db.db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(fs.existsSync(path.join(dir, 'keystore.db'))).toBe(true);
      keystore.shutdown();
      expect(() => keystore.initialize({ database: 'same.db', privateDatabase: 'same.db' }, { log: quiet, auth, databasesDir: dir })).toThrow(/different files/);
    } finally {
      keystore.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the pages and the API', () => {
  let app;
  beforeEach(() => {
    setup();
    app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());
    mountAuth(app);
    app.use('/keys', keystore.router());
  });

  const post = async (agent, url, data, page = '/keys/mine') => {
    const _csrf = await csrfOf(agent, page);
    return agent.post(url).type('form').send({ ...data, _csrf });
  };

  test('the public list, a key\'s page (HTML, JWK, PEM) and the JWKS need no login', async () => {
    const mia = await principal('mia', { name: 'Mia Display' });
    const [k] = keystore.upload(mia, ecPem(), { kid: 'mia/key 1'.replace(' ', '-') });
    const list = await request(app).get('/keys');
    expect(list.status).toBe(200);
    expect(list.text).toContain('Mia Display');
    expect(list.text).not.toContain('>mia<');
    const page = await request(app).get(`/keys/key/${encodeURIComponent(k.key_id)}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('uploaded by User: Mia Display');
    const jwk = await request(app).get(`/keys/key/${encodeURIComponent(k.key_id)}?format=json`);
    expect(jwk.body).toMatchObject({ kid: 'mia/key-1', kty: 'EC', crv: 'P-256' });
    const pem = await request(app).get(`/keys/key/${encodeURIComponent(k.key_id)}`).set('Accept', 'application/x-pem-file');
    expect(pem.text).toContain('BEGIN PUBLIC KEY');
    const jwks = await request(app).get('/keys/jwks.json');
    expect(jwks.body.keys).toHaveLength(1);
    expect((await request(app).get('/keys/key/nope')).status).toBe(404);
    expect((await request(app).get('/keys/key/nope?format=json')).body.error).toBe('not-found');
  });

  test('a user\'s own keys: login needed; upload, make, label, revoke', async () => {
    expect((await request(app).get('/keys/mine')).status).toBe(302);
    await makeUser('nina', PASSWORD, { name: 'Nina' });
    const { agent } = await login(app, 'nina', PASSWORD);
    const mine = await agent.get('/keys/mine');
    expect(mine.status).toBe(200);
    expect(mine.text).toContain('Upload a public key');
    let r = await post(agent, '/keys/mine/upload', { key: ecPem(), kid: 'nina-1', label: 'phone' });
    expect(r.status).toBe(302);
    expect(keystore.key('nina-1')).toMatchObject({ label: 'phone' });
    r = await post(agent, '/keys/mine/upload', { key: crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) });
    expect((await agent.get('/keys/mine')).text).toContain('Private keys are never uploaded');
    await post(agent, '/keys/mine/create', { kty: 'EC-P256' });
    // which can sign, and which can't
    const listed = (await agent.get('/keys/mine')).text;
    expect(listed).toContain('<b>Signs</b>');
    expect(listed).toContain('No (public key only)');
    const created = keystore.list({ owner: auth.store.userByLogin('nina').id }).find(k => k.origin === 'created');
    expect(created).toBeTruthy();
    await post(agent, `/keys/manage/${created.id}/label`, { label: 'signing', back: '/keys/mine' });
    expect(keystore.keyById(created.id).label).toBe('signing');
    await post(agent, `/keys/manage/${created.id}/revoke`, { reason: 'done with it', back: '/keys/mine' });
    expect(keystore.keyById(created.id).status).toBe('revoked');
    expect((await agent.get('/keys/mine')).text).toContain('No (private key destroyed)');
    // no CSRF token: refused
    const bad = await agent.post('/keys/mine/create').type('form').send({ kty: 'Ed25519' });
    expect(bad.status).toBe(403);
  });

  test('someone else\'s key can\'t be revoked; the admin page is for administrators', async () => {
    const owner = await principal('olga');
    const [k] = keystore.upload(owner, ecPem());
    await makeUser('pete', PASSWORD);
    const { agent } = await login(app, 'pete', PASSWORD);
    await post(agent, `/keys/manage/${k.id}/revoke`, { back: '/keys/mine' });
    expect(keystore.keyById(k.id).status).toBe('active');
    expect((await agent.get('/keys/admin')).status).toBe(403);
  });

  test('the administrator: system keys, key ids, deleting', async () => {
    await makeUser('root', PASSWORD, { admin: true });
    const owner = await principal('quinn');
    const [k] = keystore.upload(owner, ecPem(), { kid: 'squatted' });
    const { agent } = await login(app, 'root', PASSWORD);
    expect((await agent.get('/keys/admin')).status).toBe(200);
    await post(agent, '/keys/admin/create', { kty: 'Ed25519' }, '/keys/admin');
    expect(keystore.list({ system: true })).toHaveLength(1);
    await post(agent, `/keys/admin/${k.id}/kid`, { kid: '' }, '/keys/admin');
    expect(keystore.keyById(k.id).key_id).toBe(k.fingerprint);
    await post(agent, `/keys/admin/${k.id}/delete`, {}, '/keys/admin');
    expect(keystore.keyById(k.id)).toBeNull();
  });

  test('the API: a token uploads, makes and revokes; no token, 401 - a login is not enough', async () => {
    expect((await request(app).post('/keys/api/upload').send({ key: ecPem() })).status).toBe(401);
    await makeUser('sess', PASSWORD);
    const { agent } = await login(app, 'sess', PASSWORD);
    const viaSession = await agent.post('/keys/api/create').send({ kty: 'Ed25519' });
    expect(viaSession.status).toBe(401);
    expect(viaSession.body.message).toMatch(/API token is required/);
    expect(keystore.list()).toHaveLength(0);
    const id = await makeUser('robot', null);
    const token = tokenFor(id);
    const jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ format: 'jwk' });
    let r = await request(app).post('/keys/api/upload').set('Authorization', `Bearer ${token}`).send({ key: { ...jwk, kid: 'robot-384' } });
    expect(r.status).toBe(201);
    expect(r.body.keys[0]).toMatchObject({ kid: 'robot-384', alg: 'ES384' });
    r = await request(app).post('/keys/api/upload').set('Authorization', `Bearer ${token}`).send({ key: { ...jwk, kid: 'again' } });
    expect(r.status).toBe(409);
    r = await request(app).post('/keys/api/create').set('Authorization', `Bearer ${token}`).send({ kty: 'Ed25519' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kty: 'OKP', origin: 'created' });
    r = await request(app).post('/keys/api/create').set('Authorization', `Bearer ${token}`).send({ kty: 'Ed25519', system: true });
    expect(r.status).toBe(403);
    r = await request(app).post(`/keys/api/key/${encodeURIComponent('robot-384')}/revoke`).set('Authorization', `Bearer ${token}`).send({ reason: 'test' });
    expect(r.body).toMatchObject({ status: 'revoked' });
    r = await request(app).get('/keys/api/mine').set('Authorization', `Bearer ${token}`);
    expect(r.body.keys).toHaveLength(2);
    expect(r.body.uploadsLeft).toBe(9);
  });
});
