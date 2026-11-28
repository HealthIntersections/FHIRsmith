// npm registry protocol checks (npm-registry-checks.js), run against the packages module.
//
// Starts the module on a local port with a fresh database, stores a few packages through
// the crawler's own store() (the same path a crawled package takes), and then runs the
// checks that npm-registry.test.js runs against registry.npmjs.org. No network needed.
//
// Content:
//   example.fhir.npmtest         1.0.0 (2024), 1.1.0 (2025, latest)   <- the package tested
//   example.fhir.npmtest.extras  1.0.0 (2025, newer)                   <- near-matches, so
//   example.fhir.npmtest.legacy  1.0.0 (2023, older)                      search has something
//                                                                         to rank the exact
//                                name above, published both before and after it

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const PackagesModule = require('../../packages/packages');
const { defineNpmRegistryChecks } = require('./npm-registry-checks');
const { PKG, FIXTURES, fixtureTarball } = require('./npm-registry-fixtures');

describe('packages module', () => {
  const target = { name: 'local packages module', pkg: PKG, version: '1.0.0' };
  let tmp, module, server;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-registry-local-'));
    module = new PackagesModule({ countRequest() {} });
    await module.initialize({
      database: path.join(tmp, 'packages.db'),
      mirrorPath: path.join(tmp, 'mirror'),
      masterUrl: 'http://127.0.0.1:1/unused',
      crawler: { enabled: false }
    });

    module.crawler.log = { info() {}, warn() {}, error() {} };
    for (const f of FIXTURES) {
      const link = `http://example.org/feed/${f.id}-${f.version}.tgz`;
      await module.crawler.store('test-feed', link, link, new Date(f.date), fixtureTarball(f), `${f.id}#${f.version}`, {});
    }

    const app = express();
    app.use('/packages', module.router);
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    target.base = `http://127.0.0.1:${server.address().port}/packages`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    if (module) {
      await module.shutdown();
    }
    if (tmp) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  defineNpmRegistryChecks(target);
});

// GET /{id}/{version} gives npm's version document to a request that asks for JSON, and the
// tarball otherwise; the FHIR-Package-Download header always gets the tarball
describe('packages module: GET /{id}/{version} content negotiation', () => {
  let tmp, module, server, base;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-version-doc-'));
    module = new PackagesModule({ countRequest() {} });
    await module.initialize({
      database: path.join(tmp, 'packages.db'),
      mirrorPath: path.join(tmp, 'mirror'),
      masterUrl: 'http://127.0.0.1:1/unused',
      crawler: { enabled: false }
    });
    module.crawler.log = { info() {}, warn() {}, error() {} };
    for (const f of FIXTURES.filter(f => f.id === PKG)) {
      const link = `http://example.org/feed/${f.id}-${f.version}.tgz`;
      await module.crawler.store('test-feed', link, link, new Date(f.date), fixtureTarball(f), `${f.id}#${f.version}`, {});
    }
    const app = express();
    app.use('/packages', module.router);
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}/packages`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await module.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const get = (url, headers = {}) => fetch(`${base}/${url}`, { headers });
  const isTarball = async res => {
    const body = Buffer.from(await res.arrayBuffer());
    return res.status === 200 && body[0] === 0x1f && body[1] === 0x8b;
  };

  test.each([
    ['no Accept header (the Java tools, against a FHIR server)', {}],
    ['Accept: */*', { accept: '*/*' }],
    ['a browser', { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }],
    ['Accept: application/json with FHIR-Package-Download', { accept: 'application/json', 'FHIR-Package-Download': 'tarball' }],
    // axios's default: SUSHI (fhir-package-loader) downloads tarballs from here with it
    ['axios\'s default Accept (SUSHI)', { accept: 'application/json, text/plain, */*' }],
    ['the npm CLI\'s Accept, which ranks */* with npm\'s JSON', { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*' }],
    ['JSON and the tarball type at the same q', { accept: 'application/json, application/tar+gzip' }],
    ['JSON at q=0', { accept: 'application/json;q=0, */*;q=0.1' }]
  ])('%s gets the tarball', async (_, headers) => {
    expect(await isTarball(await get(`${PKG}/1.0.0`, headers))).toBe(true);
  });

  test.each([
    ['application/json'],
    ['application/vnd.npm.install-v1+json'],
    ['application/json, */*;q=0.1'],
    ['application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*; q=0.5']
  ])('Accept: %s gets the version document', async (accept) => {
    // the earlier downloads' counts are written fire-and-forget, through the writing connection,
    // and requests read through others: wait for them, so both documents have the same count
    await module.dbGet('SELECT 1');
    const res = await get(`${PKG}/1.0.0`, { accept });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    const doc = await res.json();
    const pkgDoc = await (await get(PKG, { accept: 'application/json' })).json();
    expect(doc).toEqual(pkgDoc.versions['1.0.0']);
  });

  test('the response varies on Accept and FHIR-Package-Download', async () => {
    const res = await get(`${PKG}/1.0.0`);
    expect(res.headers.get('vary')).toMatch(/Accept/);
    expect(res.headers.get('vary')).toMatch(/FHIR-Package-Download/);
  });

  test('latest resolves to the latest version, for both', async () => {
    expect((await (await get(`${PKG}/latest`, { accept: 'application/json' })).json()).version).toBe('1.1.0');
    expect(await isTarball(await get(`${PKG}/latest`))).toBe(true);
  });

  test('an unknown version or package is a 404 either way', async () => {
    expect((await get(`${PKG}/9.9.9`, { accept: 'application/json' })).status).toBe(404);
    expect((await get(`${PKG}/9.9.9`)).status).toBe(404);
    expect((await get('no.such.package/1.0.0', { accept: 'application/json' })).status).toBe(404);
    expect((await get(`${PKG}/constructor`, { accept: 'application/json' })).status).toBe(404);
  });
});

// GET /packages/npm-check: the npm registry check is the tester module's now
describe('packages module: GET /npm-check (moved to /tester?kind=npm)', () => {
  const request = require('supertest');
  let tmp, module, app;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-'));
    module = new PackagesModule({ countRequest() {} });
    await module.initialize({
      database: path.join(tmp, 'packages.db'),
      mirrorPath: path.join(tmp, 'mirror'),
      masterUrl: 'http://127.0.0.1:1/unused',
      crawler: { enabled: false }
    });
    app = express();
    app.use('/packages', module.router);
  });

  afterAll(async () => {
    await module.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a browser is sent to the tester, with the form filled in; anything else is told where it went', async () => {
    module.npmCheckAt = '/tester?kind=npm';
    const page = await request(app).get('/packages/npm-check').query({ registry: 'https://registry.example.org', package: PKG, version: '1.0.0' }).set('Accept', 'text/html');
    expect(page.status).toBe(301);
    expect(page.headers.location).toBe(`/tester?kind=npm&server=${encodeURIComponent('https://registry.example.org')}&package=${PKG}&version=1.0.0`);
    expect((await request(app).get('/packages/npm-check').set('Accept', 'text/html')).headers.location).toBe('/tester?kind=npm');
    const api = await request(app).get('/packages/npm-check').query({ registry: 'https://registry.example.org', package: PKG, version: '1.0.0' });
    expect(api.status).toBe(410);
    expect(api.body.error).toContain('/tester?kind=npm');
  });

  test('without the tester module, it is a 404', async () => {
    module.npmCheckAt = null;
    expect((await request(app).get('/packages/npm-check').set('Accept', 'text/html')).status).toBe(404);
  });
});
