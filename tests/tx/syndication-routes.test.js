/**
 * The syndication feed end to end: a TX module with syndication turned on, loading a folder
 * source and the automatic R5 core package. The network calls the store makes (downloading
 * a package to hash it) are faked; everything else is real.
 */

const request = require('supertest');
const express = require('express');
const path = require('path');
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
const TXModule = require('../../tx/tx');
const folders = require('../../library/folder-setup');

const LIBRARY = path.join(__dirname, 'fixtures', 'test-library-syndication.yaml');
const BASE = '/tx/r5';
const STORE = path.join(folders.subDir('terminology-cache'), 'syndication');

const realFetch = globalThis.fetch;

function fakeResponse(status, body) {
  const buf = Buffer.from(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(buf.length) : null) },
    arrayBuffer: async () => buf
  };
}

/** the Cache-Control of archive 1, with enough (in-memory only) entries for there to be one */
async function archiveCacheControl(app, txModule) {
  const entries = txModule.syndicationStore.entries;
  const n = entries.length;
  for (let i = 0; i < 30; i++) {
    entries.push({ ...entries[0], id: `urn:uuid:00000000-0000-4000-8000-${String(i).padStart(12, '0')}` });
  }
  try {
    const res = await request(app).get(`${BASE}/syndication/archive/1`).set('Accept', 'application/atom+xml');
    expect(res.status).toBe(200);
    return res.headers['cache-control'];
  } finally {
    entries.splice(n);
  }
}

function parse(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, parseAttributeValue: false, isArray: (name) => ['entry', 'link'].includes(name) });
  return parser.parse(xml).feed;
}

async function startApp(extraConfig, server) {
  const app = express();
  app.use(express.json());
  const txModule = new TXModule();
  await txModule.initialize({
    librarySource: LIBRARY,
    endpoints: [{ path: BASE, fhirVersion: '5.0', context: null }],
    ...extraConfig
  }, app, server);
  return { app, txModule };
}

describe('syndication is off by default', () => {
  let app, txModule;

  beforeAll(async () => {
    fs.rmSync(STORE, { recursive: true, force: true });
    ({ app, txModule } = await startApp({}));
  }, 120000);
  afterAll(async () => { await txModule.shutdown(); });

  test('there is no feed and no store', async () => {
    const res = await request(app).get(`${BASE}/syndication`).set('Accept', 'application/atom+xml');
    expect(res.status).toBe(404);
    expect(fs.existsSync(STORE)).toBe(false);
  });

  test('there is no nav item', async () => {
    const res = await request(app).get(`${BASE}/`).set('Accept', 'text/html');
    expect(res.text).not.toContain('/syndication');
  });
});

describe('syndication turned on', () => {
  let app, txModule;
  const fetched = [];

  beforeAll(async () => {
    fs.rmSync(STORE, { recursive: true, force: true });
    globalThis.fetch = async (url, opts) => {
      if (String(url).startsWith('https://npm.fhir.org/')) {
        fetched.push(String(url));
        return fakeResponse(200, 'tarball for ' + url);
      }
      return realFetch(url, opts);
    };
    ({ app, txModule } = await startApp({ syndication: { enabled: true }, title: 'Test Server' }));
    await txModule.syndicationStore.whenIdle();
  }, 120000);

  afterAll(async () => {
    await txModule.shutdown();
    globalThis.fetch = realFetch;
    fs.rmSync(STORE, { recursive: true, force: true });
  });

  test('the store records the versioned resource and the core package', () => {
    const entries = txModule.syndicationStore.entries;
    expect(entries.map(e => e.category.term).sort()).toEqual(['FHIR_CodeSystem', 'FHIR_Package']);
    const core = entries.find(e => e.kind === 'package');
    expect(core.identifier).toBe('http://hl7.org/fhir');
    expect(core.fhirVersion).toBe('5.0');
    expect(fetched).toEqual([core.link.href]);
    expect(core.link.href).toMatch(/^https:\/\/npm\.fhir\.org\/web\/hl7\.fhir\.r5\.core-5\.0\.0\.tgz$/);
    // the unversioned ValueSet in the folder is not syndicated
    expect(entries.find(e => e.identifier.includes('unversioned'))).toBeUndefined();
  });

  test('the feed is Atom, with both entries', async () => {
    // the Host is set: supertest's own is whichever loopback address the OS chose (127.0.0.1 or [::1])
    const res = await request(app).get(`${BASE}/syndication`).set('Accept', 'application/atom+xml').set('Host', 'localhost:8080');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/atom\+xml/);
    expect(res.headers['cache-control']).toBe('no-cache');
    const feed = parse(res.text);
    expect(feed.title).toBe('Test Server Syndication Feed (FHIR 5.0)');
    expect(feed.entry).toHaveLength(2);
    expect(feed.link.find(l => l['@rel'] === 'self')['@href']).toBe('http://localhost:8080/tx/r5/syndication');
    const cs = feed.entry.find(e => e.category['@term'] === 'FHIR_CodeSystem');
    expect(cs.title).toBe('Syndication Test');
    expect(cs.summary).toBe('A code system for the syndication feed tests');
    expect(cs['ncts:contentItemVersion']).toBe('http://example.org/fhir/CodeSystem/syndication-test|1.0.0');
    expect(cs['ncts:fhirVersion']).toBe('5.0');
  });

  test('the copied resource file can be downloaded', async () => {
    const res = await request(app).get(`${BASE}/syndication`).set('Accept', 'application/atom+xml');
    const cs = parse(res.text).entry.find(e => e.category['@term'] === 'FHIR_CodeSystem');
    const href = new URL(cs.link[0]['@href']).pathname;
    const file = await request(app).get(href);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/^application\/fhir\+json/);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    const original = fs.readFileSync(path.join(__dirname, 'fixtures', 'syndication-folder', 'codesystem.json'), 'utf8');
    expect(file.text).toBe(original);
  });

  test('unknown files and archives are 404, and the request is not echoed back', async () => {
    const bad = '%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E';
    for (const url of [`${BASE}/syndication/files/${bad}`, `${BASE}/syndication/archive/${bad}`]) {
      for (const accept of ['text/html', 'application/atom+xml']) {
        const res = await request(app).get(url).set('Accept', accept);
        expect(res.status).toBe(404);
        expect(res.text).not.toContain('onerror');
      }
    }
    expect((await request(app).get(`${BASE}/syndication/files/..%2Fsyndication.json`)).status).toBe(404);
    expect((await request(app).get(`${BASE}/syndication/files/nope.json`)).status).toBe(404);
    expect((await request(app).get(`${BASE}/syndication/archive/1`).set('Accept', 'application/atom+xml')).status).toBe(404);
    expect((await request(app).get(`${BASE}/syndication/archive/x`).set('Accept', 'application/atom+xml')).status).toBe(404);
  });

  test('a browser gets a page, with the nav item and feed autodiscovery', async () => {
    const res = await request(app).get(`${BASE}/syndication`).set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.text).toContain('Syndication Test');
    expect(res.text).toContain(`href="${BASE}/syndication" style="color: gold">Syndication</a>`);
    expect(res.text).toContain('type="application/atom+xml"');
  });

  test('_format=atom gets Atom whatever the Accept header says', async () => {
    const res = await request(app).get(`${BASE}/syndication?_format=atom`).set('Accept', 'text/html');
    expect(res.headers['content-type']).toMatch(/^application\/atom\+xml/);
  });

  test('without a configured host name, links follow the request and archives are not cached', async () => {
    const res = await request(app).get(`${BASE}/syndication`).set('Accept', 'application/atom+xml').set('Host', 'other.example.org');
    const self = parse(res.text).link.find(l => l['@rel'] === 'self')['@href'];
    expect(self).toBe('http://other.example.org/tx/r5/syndication');
    expect(await archiveCacheControl(app, txModule)).toBe('no-cache');
  });

  test('with a configured host name, links ignore the Host header', async () => {
    await txModule.shutdown();
    ({ app, txModule } = await startApp({ syndication: { enabled: true } }, { hostName: 'tx.example.org' }));
    await txModule.syndicationStore.whenIdle();
    const res = await request(app).get(`${BASE}/syndication`).set('Accept', 'application/atom+xml').set('Host', 'evil.example.org');
    const feed = parse(res.text);
    expect(feed.link.find(l => l['@rel'] === 'self')['@href']).toBe('https://tx.example.org/tx/r5/syndication');
    const cs = feed.entry.find(e => e.category['@term'] === 'FHIR_CodeSystem');
    expect(cs.link[0]['@href']).toMatch(/^https:\/\/tx\.example\.org\/tx\/r5\/syndication\/files\//);
    expect(res.text).not.toContain('evil');
    expect(txModule.syndicationBase({}, BASE)).toBe('https://tx.example.org/tx/r5');
    expect(await archiveCacheControl(app, txModule)).toBe('public, max-age=31536000, immutable');
  });

  test('a host name that is not a host name (a display name) is ignored', async () => {
    const tx = new TXModule();
    tx.publicHost = null;
    await tx.initialize({ librarySource: LIBRARY, endpoints: [] }, express(), { hostName: 'NPM Publisher' }).catch(() => {});
    expect(tx.publicHost).toBeNull();
  });

  test('a restart finds nothing new', async () => {
    const before = txModule.syndicationStore.entries.length;
    await txModule.shutdown();
    fetched.length = 0;
    ({ app, txModule } = await startApp({ syndication: { enabled: true } }));
    await txModule.syndicationStore.whenIdle();
    expect(txModule.syndicationStore.entries).toHaveLength(before);
    expect(fetched).toEqual([]);
  }, 120000);
});
