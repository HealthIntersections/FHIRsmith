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
const { defineNpmRegistryChecks, tgz } = require('./npm-registry-checks');

const PKG = 'example.fhir.npmtest';

const FIXTURES = [
  { id: PKG, version: '1.0.0', date: '2024-03-01T00:00:00Z', deps: { 'hl7.fhir.r4.core': '4.0.1' } },
  { id: PKG, version: '1.1.0', date: '2025-03-01T00:00:00Z', deps: { 'hl7.fhir.r4.core': '4.0.1' } },
  { id: `${PKG}.extras`, version: '1.0.0', date: '2025-06-01T00:00:00Z', deps: { [PKG]: '1.1.0' } },
  { id: `${PKG}.legacy`, version: '1.0.0', date: '2023-06-01T00:00:00Z', deps: { 'hl7.fhir.r4.core': '4.0.1' } }
];

function fixtureTarball({ id, version, deps }) {
  return tgz({
    'package/package.json': JSON.stringify({
      name: id,
      version,
      type: 'fhir.ig',
      canonical: `http://example.org/fhir/${id}`,
      url: `http://example.org/fhir/${id}/${version}`,
      fhirVersions: ['4.0.1'],
      dependencies: deps,
      description: `Test package ${id}`,
      author: 'FHIRsmith tests',
      license: 'CC0-1.0'
    }, null, 2),
    'package/.index.json': JSON.stringify({ 'index-version': 2, files: [] })
  });
}

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
    ['Accept: application/json with FHIR-Package-Download', { accept: 'application/json', 'FHIR-Package-Download': 'tarball' }]
  ])('%s gets the tarball', async (_, headers) => {
    expect(await isTarball(await get(`${PKG}/1.0.0`, headers))).toBe(true);
  });

  test.each([
    ['application/json'],
    ['application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*']
  ])('Accept: %s gets the version document', async (accept) => {
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

// GET /packages/npm-check: the same checks, run by the server against any registry - here,
// against itself
describe('packages module: GET /npm-check', () => {
  const request = require('supertest');
  let tmp, module, server, app, base;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-'));
    module = new PackagesModule({ countRequest() {} });
    await module.initialize({
      database: path.join(tmp, 'packages.db'),
      mirrorPath: path.join(tmp, 'mirror'),
      masterUrl: 'http://127.0.0.1:1/unused',
      crawler: { enabled: false },
      // the registry checked is this test server, on 127.0.0.1; and this suite makes more
      // runs than the default rate limit allows
      npmCheck: { control: false, runsPerWindow: 1000 }
    });
    module.crawler.log = { info() {}, warn() {}, error() {} };
    for (const f of FIXTURES) {
      const link = `http://example.org/feed/${f.id}-${f.version}.tgz`;
      await module.crawler.store('test-feed', link, link, new Date(f.date), fixtureTarball(f), `${f.id}#${f.version}`, {});
    }
    app = express();
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

  const check = (query, accept = 'application/json') => request(app).get('/packages/npm-check').query(query).set('Accept', accept);
  const withConfig = async (overrides, fn) => {
    const saved = module.config.npmCheck;
    module.config.npmCheck = { ...saved, ...overrides };
    try {
      return await fn();
    } finally {
      module.config.npmCheck = saved;
    }
  };

  test('a run returns the report, and this module passes every check', async () => {
    const res = await check({ registry: base, package: PKG, version: '1.0.0' });
    expect(res.status).toBe(200);
    const failures = res.body.steps.flatMap(s => s.checks).filter(c => c.status !== 'pass');
    expect(failures).toEqual([]);
    expect(res.body).toEqual(expect.objectContaining({ registry: base, package: PKG, version: '1.0.0', failed: 0 }));
    expect(res.body.passed).toBeGreaterThan(10);
    expect(res.body.requests.tarball.status).toBe(200);
  });

  test('a failing check says why, and which request it was based on', async () => {
    // 0.5.0 isn't held, so every check about that version fails
    const res = await check({ registry: base, package: PKG, version: '0.5.0' });
    expect(res.status).toBe(200);
    expect(res.body.failed).toBeGreaterThan(0);
    const c = res.body.steps.find(s => s.id === 'package').checks.find(x => x.title.startsWith('names the package'));
    expect(c).toEqual(expect.objectContaining({ status: 'fail', message: 'version 0.5.0 is not in the document', uses: ['packument'] }));
  });

  test('in a browser: the form, and the report as a page', async () => {
    const form = await check({}, 'text/html');
    expect(form.status).toBe(200);
    expect(form.text).toContain('<form method="get" action="/packages/npm-check"');
    const page = await check({ registry: base, package: PKG, version: '1.0.0' }, 'text/html');
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/All \d+ checks passed/);
    expect(page.text).toContain(`${base}/-/v1/search?text=${PKG}`);
  });

  test('the registry, package and version are all needed, and the registry must be http(s)', async () => {
    expect((await check({})).status).toBe(400);
    expect((await check({ registry: base })).status).toBe(400);
    expect((await check({ registry: 'ftp://example.org', package: PKG, version: '1.0.0' })).status).toBe(400);
    expect((await check({ registry: 'https://user:pw@example.org', package: PKG, version: '1.0.0' })).status).toBe(400);
  });

  test.each([
    ['localhost', () => base.replace('127.0.0.1', 'localhost')],
    ['IPv4 loopback in another notation', () => base.replace('127.0.0.1', '2130706433')]
  ])('this server can be checked over loopback: %s', async (_, url) => {
    const res = await check({ registry: url(), package: PKG, version: '1.0.0' });
    expect(res.body.failed).toBe(0);
  });

  test.each([
    ['cloud metadata', 'http://169.254.169.254/packages'],
    ['a private network', 'http://10.1.2.3/packages'],
    ['a private network, IPv6', 'http://[fd00::1]/packages']
  ])('other non-public addresses are refused: %s', async (_, registry) => {
    const res = await check({ registry, package: PKG, version: '1.0.0' });
    expect(res.status).toBe(200);
    expect(res.body.passed).toBe(0);
    expect(Object.values(res.body.requests).every(r => /non-public address/.test(r.error))).toBe(true);
  });

  test('a response bigger than maxDownloadMB is not read', async () => {
    // about 100 bytes: smaller than any of the responses here
    const res = await withConfig({ maxDownloadMB: 0.0001 }, () => check({ registry: base, package: PKG, version: '1.0.0' }));
    expect(res.body.requests.search.error).toBe('the response is too large');
  });

  test('beyond maxConcurrentRuns, a run is refused with 503', async () => {
    const res = await withConfig({ maxConcurrentRuns: 0 }, () => check({ registry: base, package: PKG, version: '1.0.0' }));
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
  });

  test('beyond runsPerWindow from one address, a run is refused with 429', async () => {
    const res = await withConfig({ runsPerWindow: 1 }, () => check({ registry: base, package: PKG, version: '1.0.0' }));
    expect(res.status).toBe(429);
  });

  test('turned off, it is a 404', async () => {
    const res = await withConfig({ enabled: false }, () => check({ registry: base, package: PKG, version: '1.0.0' }));
    expect(res.status).toBe(404);
  });
});
