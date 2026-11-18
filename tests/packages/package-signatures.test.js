// Publishers' package signatures: the IG Publisher signs a package with a partner file
// ({package}.tgz.sigstore.json, see org.hl7.fhir.utilities.npm.NpmPackageSigner), its feed links
// it (fhir:signature), and package-feeds.json lists the keys each feed may sign with. The crawler
// checks them (crawler.signatures: ignore, check, require) and keeps the file as it checked it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const PackagesModule = require('../../packages/packages');
const PackageCrawler = require('../../packages/package-crawler');
const { verifyPackageSignature, keyIdOf, pae, purl } = require('../../packages/npm-signing');
const express = require('express');
const request = require('supertest');
const { tgz } = require('./npm-registry-checks');

// Made by the Java NpmPackageSigner (core), so the two must agree: a package, its signature and the key
const JAVA = {
  tgz: 'H4sIAAAAAAAC/+3SMU/EIBQHcD4KYT4p3DUdbr3NwZhc4mIckMOWs6UE8OLF+N0Fqg4OTsZB/7/lNX8e7zHUK/2oetP4pfJjnB35YSLr2rbW7GsVm05+ftdcym7dESrIL3iKSYW8nvxPL8ypybAtZeZZTX40/GGwgR/VSUXbO3NgK8pOJkQ7u9Il+ZpvSpbOvl6r7bYvkVZudlarseRDSn7bNB9T59A3pbX5Zk2JbpZVMY+4ZS0XXLK7fDRabVysC3c7cSG5KBcOJupgfXp/2zKJ3p9pGgy9zLPplZ+ulz97Xw4DeyUAAAAAAAAAAAAAAAAAAAAAAAB/wxunn3wnACgAAA==',
  bundle: '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json","verificationMaterial":{"publicKey":{"hint":"SHA256:+KXtfuyPAZYLYKlucbMaE8Ew0jVSL4VxPwDchPa9VU8="},"tlogEntries":[]},"dsseEnvelope":{"payload":"eyJfdHlwZSI6Imh0dHBzOi8vaW4tdG90by5pby9TdGF0ZW1lbnQvdjEiLCJzdWJqZWN0IjpbeyJuYW1lIjoicGtnOm5wbS9leGFtcGxlLmZoaXIuamF2YXNpZ25lZEAxLjIuMyIsImRpZ2VzdCI6eyJzaGE1MTIiOiIwYjg5MzIwODM2MDg0YWY1YmFiMzg1MzMyYzRkZTlmNTI1ZWQ1Yjc1YWQ1MjI1NzZjZGRkMmNjZjAwOWJjOTVjNGU5MDE0MmE2ZjcwYmJjMDliNTBiNmZjMDc2MzZjYzhiNmU4YTA4YjAxNTI0Y2M3MzA0N2YyM2EzMmQ4ZDViNSJ9fV0sInByZWRpY2F0ZVR5cGUiOiJodHRwOi8vaGw3Lm9yZy9maGlyL3BhY2thZ2Utc2lnbmF0dXJlL3YxIiwicHJlZGljYXRlIjp7InRvb2wiOiJpbnRlcm9wIHRlc3QiLCJzaWduZWRBdCI6IjIwMjYtMTEtMTFUMDc6MzI6NTYuMzc1OTUwNDAwWiJ9fQ==","payloadType":"application/vnd.in-toto+json","signatures":[{"sig":"MEUCIFF4j3yAhl8IbG8ij5UffIJ5ddt73QGvl6KKlnLMexC6AiEAuj6NFCM/waqVKrF7sUe2wLttUVR1uwHxe7SmGRNXwPo=","keyid":"SHA256:+KXtfuyPAZYLYKlucbMaE8Ew0jVSL4VxPwDchPa9VU8="}]}}',
  key: { keyid: 'SHA256:+KXtfuyPAZYLYKlucbMaE8Ew0jVSL4VxPwDchPa9VU8=', key: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEw/ZJZgfyq7S7N6p34JNavAfcIv8pGaJ5fItBPvVWgqrkvHCO6OVTtbhRILhEs3MqnKE3WbX2dWUocxPvlAGTeA==', expires: null }
};

function makeKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey, entry: { keyid: keyIdOf(der), key: der.toString('base64'), expires: null } };
}

// A signature bundle as the IG Publisher writes one
function sign(k, buf, name, version) {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: purl(name, version), digest: { sha512: crypto.createHash('sha512').update(buf).digest('hex') } }],
    predicateType: 'http://hl7.org/fhir/package-signature/v1',
    predicate: { tool: 'test', signedAt: new Date().toISOString() }
  };
  const payload = Buffer.from(JSON.stringify(statement), 'utf8');
  const type = 'application/vnd.in-toto+json';
  return JSON.stringify({
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: { publicKey: { hint: k.entry.keyid }, tlogEntries: [] },
    dsseEnvelope: {
      payload: payload.toString('base64'), payloadType: type,
      signatures: [{ sig: crypto.sign('sha256', pae(type, payload), k.privateKey).toString('base64'), keyid: k.entry.keyid }]
    }
  }, null, 2);
}

function tarball(id, version, build = 'a') {
  return tgz({
    'package/package.json': JSON.stringify({
      name: id, version, type: 'fhir.ig', canonical: `http://example.org/fhir/${id}`,
      fhirVersions: ['4.0.1'], description: `${id} build ${build}`, license: 'CC0-1.0'
    })
  });
}

describe('verifyPackageSignature', () => {
  const buf = Buffer.from(JAVA.tgz, 'base64');
  const bundle = JSON.parse(JAVA.bundle);

  test('accepts a signature made by the Java NpmPackageSigner', () => {
    const v = verifyPackageSignature(buf, bundle, [JAVA.key], 'example.fhir.javasigned', '1.2.3', new Date());
    expect(v.keyid).toBe(JAVA.key.keyid);
    expect(v.signedAt).toBe('2026-11-11T07:32:56.375950400Z');
  });

  test('refuses it for another package or version', () => {
    expect(() => verifyPackageSignature(buf, bundle, [JAVA.key], 'example.fhir.other', '1.2.3', null)).toThrow(/not for pkg:npm\/example.fhir.other@1.2.3/);
    expect(() => verifyPackageSignature(buf, bundle, [JAVA.key], 'example.fhir.javasigned', '1.2.4', null)).toThrow(/not for/);
  });

  test('refuses it for other bytes', () => {
    expect(() => verifyPackageSignature(Buffer.concat([buf, Buffer.from([0])]), bundle, [JAVA.key], 'example.fhir.javasigned', '1.2.3', null)).toThrow(/sha512/);
  });

  test('refuses a key the feed doesn\'t list, or one that had expired when the package was published', () => {
    expect(() => verifyPackageSignature(buf, bundle, [makeKey().entry], 'example.fhir.javasigned', '1.2.3', null)).toThrow(/no signature verifies/);
    const expired = { ...JAVA.key, expires: '2026-01-01T00:00:00Z' };
    expect(() => verifyPackageSignature(buf, bundle, [expired], 'example.fhir.javasigned', '1.2.3', new Date('2026-06-01'))).toThrow(/no signature verifies/);
    expect(verifyPackageSignature(buf, bundle, [expired], 'example.fhir.javasigned', '1.2.3', new Date('2025-06-01')).keyid).toBe(JAVA.key.keyid);
  });

  test('refuses a changed statement', () => {
    const forged = JSON.parse(JAVA.bundle);
    const st = JSON.parse(Buffer.from(forged.dsseEnvelope.payload, 'base64').toString('utf8'));
    st.predicate.tool = 'forged';
    forged.dsseEnvelope.payload = Buffer.from(JSON.stringify(st)).toString('base64');
    expect(() => verifyPackageSignature(buf, forged, [JAVA.key], 'example.fhir.javasigned', '1.2.3', null)).toThrow(/no signature verifies/);
  });
});

describe('crawler: publishers\' signatures', () => {
  let tmp, module, crawler, key;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-signatures-'));
    module = new PackagesModule({ countRequest() {} });
    await module.initialize({
      database: path.join(tmp, 'packages.db'),
      mirrorPath: path.join(tmp, 'mirror'),
      masterUrl: 'http://127.0.0.1:1/unused',
      crawler: { enabled: false },
      npmSigning: { enabled: false }
    });
    crawler = module.crawler;
    crawler.log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    crawler.served = {};
    crawler.fetchUrl = jest.fn(async url => {
      if (!crawler.served[url]) {
        throw new Error(`no fixture for ${url}`);
      }
      return crawler.served[url];
    });
    key = makeKey();
  });

  afterEach(async () => {
    await module.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const link = (id, version) => `https://example.org/fhir/${id}/${version}/package.tgz`;
  const signatures = () => new Promise((resolve, reject) => module.db.all(
    'SELECT v.Id, v.Version, s.Url, s.KeyId, s.Valid, s.Message, s.Bundle FROM PackageSignatures s JOIN PackageVersions v ON v.PackageVersionKey = s.PackageVersionKey ORDER BY v.Id',
    (e, r) => e ? reject(e) : resolve(r)));
  const stored = id => new Promise((resolve, reject) => module.db.get(
    'SELECT COUNT(*) AS n FROM PackageVersions WHERE Id = ?', [id], (e, r) => e ? reject(e) : resolve(r.n)));

  // Runs one item of a feed through the crawler. sig: the signature file's content (or null: unsigned)
  async function crawl(id, version, { buf = tarball(id, version), sig = null, sigUrl = undefined, feed = { keys: [key.entry] } } = {}) {
    const l = link(id, version);
    crawler.served[l] = buf;
    const item = { guid: { '#text': l }, title: `${id}#${version}`, link: l, pubDate: 'Mon, 01 Jun 2026 00:00:00 GMT' };
    if (sig !== null || sigUrl) {
      item['fhir:signature'] = sigUrl || `${l}.sigstore.json`;
      if (sig !== null) {
        crawler.served[item['fhir:signature']] = Buffer.from(sig, 'utf8');
      }
    }
    crawler.packages.clear();
    const feedLog = { items: [] };
    await crawler.updateItem('https://example.org/feed.xml', item, 0, [], feedLog, crawler.signingFor(feed));
    return feedLog.items[0];
  }

  test('check: a good signature is recorded, with the file as it was', async () => {
    const buf = tarball('ex.good', '1.0.0');
    const sig = sign(key, buf, 'ex.good', '1.0.0');
    const item = await crawl('ex.good', '1.0.0', { buf, sig });
    expect(item.status).toBe('Fetched');
    expect(item.signature).toBe(`valid (${key.entry.keyid})`);
    const rows = await signatures();
    expect(rows).toEqual([{ Id: 'ex.good', Version: '1.0.0', Url: `${link('ex.good', '1.0.0')}.sigstore.json`, KeyId: key.entry.keyid, Valid: 1, Message: null, Bundle: sig }]);
  });

  test('check: a bad signature is logged and recorded, and the package is stored', async () => {
    const buf = tarball('ex.bad', '1.0.0');
    const sig = sign(key, tarball('ex.bad', '1.0.0', 'other build'), 'ex.bad', '1.0.0');
    const item = await crawl('ex.bad', '1.0.0', { buf, sig });
    expect(item.status).toBe('Fetched');
    expect(item.signature).toMatch(/^invalid: .*sha512/);
    expect(crawler.log.error).toHaveBeenCalledWith(expect.stringMatching(/Signature check failed for ex.bad#1.0.0/));
    const rows = await signatures();
    expect(rows[0]).toMatchObject({ Id: 'ex.bad', Valid: 0, KeyId: null, Bundle: sig });
    expect(rows[0].Message).toMatch(/sha512/);
  });

  test('check: a feed that says signing.required has a bad signature refused', async () => {
    const sig = sign(makeKey(), tarball('ex.req', '1.0.0'), 'ex.req', '1.0.0');
    const item = await crawl('ex.req', '1.0.0', { sig, feed: { required: true, keys: [key.entry] } });
    expect(item.status).toBe('Exception');
    expect(item.error).toMatch(/rejected: its signature is not valid/);
    expect(await stored('ex.req')).toBe(0);
    expect(await signatures()).toEqual([]);
  });

  test('check: an unsigned package is stored, and noted', async () => {
    const item = await crawl('ex.unsigned', '1.0.0');
    expect(item.status).toBe('Fetched');
    expect(item.signature).toBe('unsigned');
  });

  test('check: a signature that can\'t be fetched is logged; the package is stored', async () => {
    const item = await crawl('ex.nofile', '1.0.0', { sigUrl: 'https://example.org/missing.sigstore.json' });
    expect(item.status).toBe('Fetched');
    expect(item.signature).toMatch(/could not be fetched/);
    expect(await signatures()).toEqual([]);
  });

  test('require: unsigned and badly signed packages are refused; a good one is stored', async () => {
    crawler.signatureMode = 'require';
    expect((await crawl('ex.r1', '1.0.0')).error).toMatch(/rejected: it is not signed/);
    const bad = sign(key, tarball('ex.r2', '1.0.0', 'x'), 'ex.r2', '1.0.0');
    expect((await crawl('ex.r2', '1.0.0', { sig: bad })).error).toMatch(/rejected: its signature is not valid/);
    const buf = tarball('ex.r3', '1.0.0');
    expect((await crawl('ex.r3', '1.0.0', { buf, sig: sign(key, buf, 'ex.r3', '1.0.0') })).status).toBe('Fetched');
    expect([await stored('ex.r1'), await stored('ex.r2'), await stored('ex.r3')]).toEqual([0, 0, 1]);
  });

  test('require: a feed that lists no keys isn\'t read at all; one that does is', async () => {
    crawler.signatureMode = 'require';
    crawler.fetchJson = jest.fn(async () => ({
      feeds: [
        { name: 'unsigned', url: 'https://example.org/unsigned/package-feed.xml' },
        { name: 'signed', url: 'https://example.org/signed/package-feed.xml', signing: { keys: [key.entry] } }
      ]
    }));
    crawler.updateTheFeed = jest.fn(async () => {});
    crawler.stats = { task() {}, taskDone() {}, taskError() {} };
    const log = await crawler.crawl(crawler.log);
    expect(crawler.updateTheFeed.mock.calls.map(c => c[0])).toEqual(['https://example.org/signed/package-feed.xml']);
    expect(crawler.updateTheFeed.mock.calls[0][4]).toEqual({ keys: [key.entry], required: true });
    expect(log.feeds).toEqual([{ url: 'https://example.org/unsigned/package-feed.xml', skipped: expect.stringMatching(/no signing keys/), items: [] }]);
  });

  test('check: a feed that lists no keys is read, and its packages aren\'t checked', async () => {
    const item = await crawl('ex.nokeys', '1.0.0', { feed: null });
    expect(item.status).toBe('Fetched');
    expect(item.signature).toBeUndefined();
  });

  test('ignore: signatures are not fetched', async () => {
    crawler.signatureMode = 'ignore';
    const buf = tarball('ex.ign', '1.0.0');
    const item = await crawl('ex.ign', '1.0.0', { buf, sig: sign(key, buf, 'ex.ign', '1.0.0') });
    expect(item.status).toBe('Fetched');
    expect(item.signature).toBeUndefined();
    expect(crawler.fetchUrl).toHaveBeenCalledTimes(1);
    expect(await signatures()).toEqual([]);
  });

  test('a package stored before it was signed has its signature checked against the stored bytes, once', async () => {
    const buf = tarball('ex.later', '1.0.0');
    expect((await crawl('ex.later', '1.0.0', { buf })).status).toBe('Fetched');
    // the publisher signs it later
    const sig = sign(key, buf, 'ex.later', '1.0.0');
    const item = await crawl('ex.later', '1.0.0', { buf, sig });
    expect(item.status).toBe('Already Processed');
    expect(item.signature).toBe(`valid (${key.entry.keyid})`);
    expect((await signatures())[0]).toMatchObject({ Id: 'ex.later', Valid: 1, Bundle: sig });
    const calls = crawler.fetchUrl.mock.calls.length;
    expect((await crawl('ex.later', '1.0.0', { buf, sig })).signature).toBeUndefined();
    expect(crawler.fetchUrl.mock.calls.length).toBe(calls);
  });

  test('a stored package whose signature doesn\'t match is kept, and the failure logged and recorded', async () => {
    const buf = tarball('ex.mismatch', '1.0.0');
    await crawl('ex.mismatch', '1.0.0', { buf });
    const sig = sign(key, tarball('ex.mismatch', '1.0.0', 'republished'), 'ex.mismatch', '1.0.0');
    const item = await crawl('ex.mismatch', '1.0.0', { buf, sig });
    expect(item.signature).toMatch(/^invalid/);
    expect(await stored('ex.mismatch')).toBe(1);
    expect((await signatures())[0]).toMatchObject({ Valid: 0 });
  });

  test('the Java signer\'s package and signature are accepted end to end', async () => {
    const item = await crawl('example.fhir.javasigned', '1.2.3', { buf: Buffer.from(JAVA.tgz, 'base64'), sig: JAVA.bundle, feed: { required: true, keys: [JAVA.key] } });
    expect(item.status).toBe('Fetched');
    expect(item.signature).toBe(`valid (${JAVA.key.keyid})`);
  });

  test('the HTML lists show each package\'s signature as confirmed, rejected or absent', async () => {
    const good = tarball('ex.list', '1.0.0');
    await crawl('ex.list', '1.0.0', { buf: good, sig: sign(key, good, 'ex.list', '1.0.0') });
    await crawl('ex.list', '1.1.0', { sig: sign(key, tarball('ex.list', '1.1.0', 'x'), 'ex.list', '1.1.0') });
    await crawl('ex.list', '1.2.0');
    const app = express();
    app.use('/packages', module.router);
    const html = async url => (await request(app).get(url).set('Accept', 'text/html')).text;
    const cells = page => [...page.matchAll(/<td[^>]*>(?:<span[^>]*>)?(confirmed|rejected|absent)</g)].map(m => m[1]);

    // the versions page, newest first
    expect(cells(await html('/packages/ex.list'))).toEqual(['absent', 'rejected', 'confirmed']);
    // search and updates list the current version
    expect(cells(await html('/packages/catalog?name=ex.list'))).toEqual(['absent']);
    const updates = await html('/packages/updates?dateType=absolute&dateValue=2020-01-01');
    expect(cells(updates).sort()).toEqual(['absent', 'confirmed', 'rejected']);
    expect(updates).toContain(`Signed with ${key.entry.keyid}`);
  });

  test('the package document links each checked signature in dist.fhir-signature, and serves it as fetched', async () => {
    const good = tarball('ex.doc', '1.0.0');
    const goodSig = sign(key, good, 'ex.doc', '1.0.0');
    await crawl('ex.doc', '1.0.0', { buf: good, sig: goodSig });
    const badSig = sign(key, tarball('ex.doc', '1.1.0', 'x'), 'ex.doc', '1.1.0');
    await crawl('ex.doc', '1.1.0', { sig: badSig });
    await crawl('ex.doc', '1.2.0');
    const app = express();
    app.use('/packages', module.router);

    const doc = (await request(app).get('/packages/ex.doc').set('Accept', 'application/json').set('Host', 'reg.example.org')).body;
    expect(doc.versions['1.0.0'].dist['fhir-signature']).toEqual({
      url: 'http://reg.example.org/packages/-/fhir/v1/signatures/ex.doc@1.0.0', status: 'confirmed', keyid: key.entry.keyid
    });
    expect(doc.versions['1.1.0'].dist['fhir-signature']).toEqual({
      url: 'http://reg.example.org/packages/-/fhir/v1/signatures/ex.doc@1.1.0', status: 'rejected'
    });
    expect(doc.versions['1.2.0'].dist['fhir-signature']).toBeUndefined();
    // npm must not see these as attestations
    expect(doc.versions['1.0.0'].dist.attestations).toBeUndefined();

    const res = await request(app).get('/packages/-/fhir/v1/signatures/ex.doc@1.0.0');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.text).toBe(goodSig);
    expect((await request(app).get('/packages/-/fhir/v1/signatures/ex.doc@1.1.0')).text).toBe(badSig);
    expect((await request(app).get('/packages/-/fhir/v1/signatures/ex.doc@1.2.0')).status).toBe(404);
    expect((await request(app).get('/packages/-/fhir/v1/signatures/ex.doc')).status).toBe(400);
  });

  test('crawler.signatures must be ignore, check or require', () => {
    expect(() => new PackageCrawler({ crawler: { signatures: 'sometimes' } }, module.db, {})).toThrow(/ignore, check, require/);
  });
});
