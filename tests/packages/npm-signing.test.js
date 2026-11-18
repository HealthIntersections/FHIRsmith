// npm registry signatures (packages/npm-signing.js): the key, signing and verifying, the
// signatures in package documents, /-/npm/v1/keys, signing the versions an older database
// holds in the background, and `npm audit signatures` against the packages module.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execFile } = require('child_process');
const express = require('express');
const PackagesModule = require('../../packages/packages');
const PackageCrawler = require('../../packages/package-crawler');
const { NpmSigner, integrityOf, integrityOfSync, verifySignature } = require('../../packages/npm-signing');
const { runNpmCheck, makeGetter } = require('../../packages/npm-check');
const { tgz } = require('./npm-registry-checks');

const PKG = 'example.fhir.signed';
const VERSIONS = [
  { version: '1.0.0', date: '2024-03-01T00:00:00Z' },
  { version: '1.1.0', date: '2025-03-01T00:00:00Z' }
];

function fixtureTarball(id, version) {
  return tgz({
    'package/package.json': JSON.stringify({
      name: id,
      version,
      type: 'fhir.ig',
      canonical: `http://example.org/fhir/${id}`,
      url: `http://example.org/fhir/${id}/${version}`,
      fhirVersions: ['4.0.1'],
      dependencies: {},
      description: `Test package ${id}`,
      author: 'FHIRsmith tests',
      license: 'CC0-1.0'
    }, null, 2),
    'package/.index.json': JSON.stringify({ 'index-version': 2, files: [] })
  });
}

const quiet = { info() {}, warn() {}, error() {} };

// A packages module on a local port. dir holds the database (kept between modules, so a
// second module sees what the first stored); extra is merged into its config.
async function startModule(dir, extra = {}) {
  const module = new PackagesModule({ countRequest() {} });
  await module.initialize({
    database: path.join(dir, 'packages.db'),
    mirrorPath: path.join(dir, 'mirror'),
    masterUrl: 'http://127.0.0.1:1/unused',
    crawler: { enabled: false },
    ...extra
  });
  module.crawler.log = quiet;
  const app = express();
  app.use('/packages', module.router);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/packages`;
  const stop = async () => {
    await new Promise(resolve => server.close(resolve));
    await module.shutdown();
  };
  return { module, base, stop };
}

async function store(module, id, version, date) {
  const link = `http://example.org/feed/${id}-${version}.tgz`;
  await module.crawler.store('test-feed', link, link, new Date(date), fixtureTarball(id, version), `${id}#${version}`, {});
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  return { status: res.status, body: await res.json() };
}

// Every version in the package document is signed by the registry's key
async function expectAllSigned(base, pkg = PKG) {
  const keys = await getJson(`${base}/-/npm/v1/keys`);
  expect(keys.status).toBe(200);
  const doc = (await getJson(`${base}/${pkg}`)).body;
  expect(Object.keys(doc.versions).length).toBeGreaterThan(0);
  for (const [v, man] of Object.entries(doc.versions)) {
    expect(man.dist.signatures).toHaveLength(1);
    const sig = man.dist.signatures[0];
    const key = keys.body.keys.find(k => k.keyid === sig.keyid);
    expect(key).toBeDefined();
    expect(verifySignature(key, pkg, v, man.dist.integrity, sig.sig)).toBe(true);
  }
  return { keys: keys.body, doc };
}

describe('npm-signing.js', () => {
  let tmp;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-signing-'));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a missing key file gets a new P-256 key, readable only by its owner, and the same key is loaded again', () => {
    const file = path.join(tmp, 'sub', 'key.pem');
    const made = NpmSigner.load(file);
    expect(fs.existsSync(file)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(NpmSigner.load(file).keyid).toBe(made.keyid);
  });

  test('the key id is npm\'s: SHA256: and the base64 sha256 of the public key', () => {
    const signer = NpmSigner.load(path.join(tmp, 'keyid.pem'));
    const doc = signer.keysDocument();
    expect(doc.keys).toHaveLength(1);
    const key = doc.keys[0];
    expect(key).toMatchObject({ keytype: 'ecdsa-sha2-nistp256', scheme: 'ecdsa-sha2-nistp256', expires: null });
    const der = Buffer.from(key.key, 'base64');
    expect(key.keyid).toBe('SHA256:' + crypto.createHash('sha256').update(der).digest('base64'));
    expect(key.keyid).toBe(signer.keyid);
    expect(crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }).asymmetricKeyDetails.namedCurve).toBe('prime256v1');
  });

  test('a signature verifies the way npm checks it, and only for that name, version and integrity', () => {
    const signer = NpmSigner.load(path.join(tmp, 'sign.pem'));
    const key = signer.keysDocument().keys[0];
    const integrity = integrityOfSync(Buffer.from('a tarball'));
    const sig = signer.sign('a.b.c', '1.0.0', integrity);
    expect(verifySignature(key, 'a.b.c', '1.0.0', integrity, sig)).toBe(true);
    expect(verifySignature(key, 'a.b.c', '1.0.1', integrity, sig)).toBe(false);
    expect(verifySignature(key, 'a.b.d', '1.0.0', integrity, sig)).toBe(false);
    expect(verifySignature(key, 'a.b.c', '1.0.0', integrityOfSync(Buffer.from('another')), sig)).toBe(false);
    expect(verifySignature(NpmSigner.load(path.join(tmp, 'other.pem')).keysDocument().keys[0], 'a.b.c', '1.0.0', integrity, sig)).toBe(false);
  });

  test('a key that isn\'t EC P-256 is refused', () => {
    const file = path.join(tmp, 'rsa.pem');
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    expect(() => NpmSigner.load(file)).toThrow(/P-256/);
    const p384 = path.join(tmp, 'p384.pem');
    fs.writeFileSync(p384, crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    expect(() => NpmSigner.load(p384)).toThrow(/P-256/);
  });

  test('integrity is the sha512 SRI string, hashed in slices or not', async () => {
    const big = crypto.randomBytes(9 * 1024 * 1024 + 17);
    const expected = 'sha512-' + crypto.createHash('sha512').update(big).digest('base64');
    expect(integrityOfSync(big)).toBe(expected);
    expect(await integrityOf(big)).toBe(expected);
  });
});

describe('packages module: signatures', () => {
  let tmp, mod;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-signed-'));
    mod = await startModule(tmp);
    for (const v of VERSIONS) {
      await store(mod.module, PKG, v.version, v.date);
    }
    await mod.module.distBackfill;
  });

  afterAll(async () => {
    await mod.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the key is made next to the database', () => {
    expect(fs.existsSync(path.join(tmp, 'npm-signing-key.pem'))).toBe(true);
  });

  test('every version stored is signed, over the integrity of the tarball served', async () => {
    const { doc } = await expectAllSigned(mod.base);
    for (const [v, man] of Object.entries(doc.versions)) {
      const res = await fetch(man.dist.tarball, { headers: { 'FHIR-Package-Download': 'tarball' } });
      const body = Buffer.from(await res.arrayBuffer());
      expect({ v, integrity: integrityOfSync(body) }).toEqual({ v, integrity: man.dist.integrity });
    }
  });

  test('the version document carries the same signature', async () => {
    const doc = (await getJson(`${mod.base}/${PKG}`)).body;
    const man = (await getJson(`${mod.base}/${PKG}/1.0.0`)).body;
    expect(man.dist.signatures).toEqual(doc.versions['1.0.0'].dist.signatures);
    expect(man.dist.integrity).toEqual(doc.versions['1.0.0'].dist.integrity);
  });

  test('/status reports signing as complete', async () => {
    const status = (await getJson(`${mod.base}/status`)).body;
    expect(status.npmSigning).toMatchObject({ enabled: true, state: 'complete', missing: 0 });
    expect(status.npmSigning.keyid).toBe(mod.module.signer.keyid);
  });

  test('the keys are a 404 while versions are still being signed', async () => {
    const state = mod.module.distStatus.state;
    mod.module.distStatus.state = 'running';
    try {
      expect((await getJson(`${mod.base}/-/npm/v1/keys`)).status).toBe(404);
    } finally {
      mod.module.distStatus.state = state;
    }
  });

  test('/npm-check\'s signature checks pass, and fail on a bad signature', async () => {
    const crawler = Object.create(PackageCrawler.prototype);
    crawler.config = {};
    const get = makeGetter(crawler.guardedAgents({ allowLoopback: true }));
    const signatureChecks = report => report.steps.find(s => s.id === 'signatures').checks;

    const good = await runNpmCheck({ registry: mod.base, pkg: PKG, version: '1.0.0' }, get);
    expect(signatureChecks(good).map(c => c.status)).toEqual(['pass', 'pass']);

    const db = mod.module;
    const key = (await db.dbGet('SELECT PackageVersionKey AS k FROM PackageVersions WHERE Id = ? AND Version = ?', [PKG, '1.1.0'])).k;
    const row = await db.dbGet('SELECT Signature FROM PackageDist WHERE PackageVersionKey = ?', [key]);
    const other = mod.module.signer.sign(PKG, '9.9.9', 'sha512-AAAA');
    await db.dbRun('UPDATE PackageDist SET Signature = ? WHERE PackageVersionKey = ?', [other, key]);
    try {
      const bad = await runNpmCheck({ registry: mod.base, pkg: PKG, version: '1.0.0' }, get);
      const checks = signatureChecks(bad);
      expect(checks[0].status).toBe('pass');
      expect(checks[1].status).toBe('fail');
      expect(checks[1].message).toMatch(/versions\.1\.1\.0/);
    } finally {
      await db.dbRun('UPDATE PackageDist SET Signature = ? WHERE PackageVersionKey = ?', [row.Signature, key]);
    }
  });
});

describe('packages module: signing the versions an older database holds', () => {
  let tmp;

  beforeAll(async () => {
    // A database from before signing: stored by a module that doesn't sign, then with its
    // PackageDist table dropped
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-backfill-'));
    const old = await startModule(tmp, { npmSigning: { enabled: false } });
    for (const v of VERSIONS) {
      await store(old.module, PKG, v.version, v.date);
    }
    await store(old.module, `${PKG}.other`, '2.0.0', '2025-06-01T00:00:00Z');
    await old.module.dbRun('DROP TABLE PackageDist');
    await old.stop();
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('without signing, versions get their integrity but no signatures, and there are no keys', async () => {
    const mod = await startModule(tmp, { npmSigning: { enabled: false } });
    try {
      await mod.module.distBackfill;
      expect(mod.module.distStatus).toMatchObject({ state: 'complete', missing: 0, done: 3, failed: 0 });
      expect((await getJson(`${mod.base}/-/npm/v1/keys`)).status).toBe(404);
      const doc = (await getJson(`${mod.base}/${PKG}`)).body;
      for (const man of Object.values(doc.versions)) {
        expect(man.dist.integrity).toMatch(/^sha512-/);
        expect(man.dist.signatures).toBeUndefined();
      }
    } finally {
      await mod.stop();
    }
  });

  test('turning signing on signs them all in the background, then publishes the key', async () => {
    const mod = await startModule(tmp);
    try {
      await mod.module.distBackfill;
      expect(mod.module.distStatus).toMatchObject({ state: 'complete', missing: 0, done: 3, failed: 0 });
      await expectAllSigned(mod.base);
      await expectAllSigned(mod.base, `${PKG}.other`);
    } finally {
      await mod.stop();
    }
  });

  test('a restart with the same key has nothing to do', async () => {
    const mod = await startModule(tmp);
    try {
      await mod.module.distBackfill;
      expect(mod.module.distStatus).toMatchObject({ state: 'complete', missing: 0, done: 0 });
    } finally {
      await mod.stop();
    }
  });

  test('a new key: everything is signed again with it, and the old signatures are not served', async () => {
    const before = NpmSigner.load(path.join(tmp, 'npm-signing-key.pem')).keyid;
    const mod = await startModule(tmp, { npmSigning: { keyFile: 'rotated.pem' } });
    try {
      expect(mod.module.signer.keyid).not.toBe(before);
      await mod.module.distBackfill;
      expect(mod.module.distStatus).toMatchObject({ state: 'complete', done: 3 });
      const { keys } = await expectAllSigned(mod.base);
      expect(keys.keys.map(k => k.keyid)).toEqual([mod.module.signer.keyid]);
    } finally {
      await mod.stop();
    }
  });

  test('rows for versions that are gone are removed', async () => {
    const mod = await startModule(tmp);
    try {
      await mod.module.distBackfill;
      await mod.module.dbRun('INSERT INTO PackageDist (PackageVersionKey, Integrity) VALUES (9999, ?)', ['sha512-AAAA']);
      await mod.module.startDistBackfill();
      expect(await mod.module.dbGet('SELECT * FROM PackageDist WHERE PackageVersionKey = 9999')).toBeUndefined();
    } finally {
      await mod.stop();
    }
  });

  test('a version whose tarball changed after it was hashed is not given the old integrity', async () => {
    const mod = await startModule(tmp);
    try {
      await mod.module.distBackfill;
      const key = (await mod.module.dbGet('SELECT PackageVersionKey AS k FROM PackageVersions WHERE Id = ? AND Version = ?', [PKG, '1.0.0'])).k;
      const kept = await mod.module.dbGet('SELECT * FROM PackageDist WHERE PackageVersionKey = ?', [key]);
      await mod.module.dbRun('DELETE FROM PackageDist WHERE PackageVersionKey = ?', [key]);
      // the crawler replaces the tarball between the backfill reading it and writing the row
      const realGet = mod.module.dbGet.bind(mod.module);
      mod.module.dbGet = async (sql, params) => {
        const row = await realGet(sql, params);
        if (/SELECT Content, Hash/.test(sql)) {
          await mod.module.dbRun('UPDATE PackageVersions SET Hash = ? WHERE PackageVersionKey = ?', ['replaced', key]);
        }
        return row;
      };
      await mod.module.fillDist(key, null);
      delete mod.module.dbGet;
      expect(await mod.module.dbGet('SELECT * FROM PackageDist WHERE PackageVersionKey = ?', [key])).toBeUndefined();
      await mod.module.dbRun('INSERT INTO PackageDist (PackageVersionKey, Integrity, KeyId, Signature) VALUES (?, ?, ?, ?)',
        [kept.PackageVersionKey, kept.Integrity, kept.KeyId, kept.Signature]);
    } finally {
      await mod.stop();
    }
  });
});

// The real client: npm installs a package from the module, then checks its signature
describe('npm audit signatures against the packages module', () => {
  let tmp, mod, project, npmAvailable;

  beforeAll(async () => {
    try {
      execFileSync('npm', ['--version'], { stdio: 'ignore' });
      npmAvailable = true;
    } catch (e) {
      npmAvailable = false;
      return;
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-audit-signatures-'));
    mod = await startModule(path.join(tmp, 'server'));
    for (const v of VERSIONS) {
      await store(mod.module, PKG, v.version, v.date);
    }
    await mod.module.distBackfill;
    project = path.join(tmp, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'audit-test', version: '1.0.0', private: true }));
  }, 60000);

  afterAll(async () => {
    if (mod) {
      await mod.stop();
    }
    if (tmp) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // eslint-disable-next-line no-control-regex
  const plain = s => String(s || '').replace(/\u001b\[[0-9;]*m/g, '');

  // Not execFileSync: the server is in this process, so blocking it would hang npm
  const npm = args => new Promise((resolve, reject) => {
    // No colour: Jest passes FORCE_COLOR to its workers, and npm then puts ANSI codes in the
    // middle of the messages these tests look for
    const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
    execFile('npm', [...args, '--registry', `${mod.base}/`, '--cache', path.join(tmp, 'cache'), '--no-fund', '--no-update-notifier', '--color', 'false'],
      { cwd: project, encoding: 'utf8', timeout: 50000, env }, (err, stdout, stderr) => {
        if (err) {
          err.stdout = plain(stdout);
          err.stderr = plain(stderr);
          reject(err);
        } else {
          resolve(plain(stdout));
        }
      });
  });

  test('npm verifies the registry signature of a package installed from it', async () => {
    if (!npmAvailable) {
      return;
    }
    await npm(['install', `${PKG}@1.0.0`, '--no-audit']);
    const out = await npm(['audit', 'signatures']);
    expect(out).toMatch(/1 package has a verified registry signature/);
  }, 60000);

  test('npm reports a bad signature', async () => {
    if (!npmAvailable) {
      return;
    }
    const key = (await mod.module.dbGet('SELECT PackageVersionKey AS k FROM PackageVersions WHERE Id = ? AND Version = ?', [PKG, '1.0.0'])).k;
    await mod.module.dbRun('UPDATE PackageDist SET Signature = ? WHERE PackageVersionKey = ?', [mod.module.signer.sign(PKG, '1.0.1', 'sha512-AAAA'), key]);
    let failure;
    try {
      await npm(['audit', 'signatures']);
    } catch (e) {
      failure = e;
    }
    expect(failure).toBeDefined();
    expect(failure.stdout + failure.stderr).toMatch(/invalid registry signature/i);
  }, 60000);
});
