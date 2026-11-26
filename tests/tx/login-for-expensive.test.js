// The terminology module with auth.loginForExpensive on: XML needs a login (JSON doesn't), and in
// the web pages someone not logged in sees the first page of a search, no Show all, and no more
// than auth.anonymousMaxRows rows of an expansion. A client logged in may have a bigger cache.

const path = require('path');
const express = require('express');
const request = require('supertest');
const TXModule = require('../../tx/tx');
const { ResourceCache } = require('../../tx/operation-context');
const { TxHtmlRenderer } = require('../../tx/tx-html');
const { Renderer } = require('../../tx/library/renderer');
const { auth, setupAuth, makeUser, tokenFor } = require('../helpers/auth');

describe('tx: login for expensive operations', () => {
  let app;
  let tx;
  let token;

  beforeAll(async () => {
    setupAuth({ loginForExpensive: true, anonymousMaxRows: 3 });
    token = tokenFor(await makeUser('software', 'a-long-enough-password'));
    app = express();
    app.use(auth.pages);
    app.use(express.json());
    tx = new TXModule();
    await tx.initialize({
      librarySource: path.join(__dirname, 'fixtures', 'test-library.yaml'),
      endpoints: [{ path: '/tx/r5', fhirVersion: '5.0', context: null }],
      cacheMaxConcepts: 5, cacheMaxConceptsLoggedIn: 50
    }, app);
  }, 60000);

  afterAll(async () => {
    await tx.shutdown();
    auth.shutdown();
  });

  const bearer = r => r.set('Authorization', `Bearer ${token}`);

  test('XML needs a login: an OperationOutcome in XML says so, and that JSON needs none', async () => {
    const res = await request(app).get('/tx/r5/metadata?_format=xml');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/fhir+xml');
    expect(res.text).toContain('<code value="login"/>');
    expect(res.text).toContain('The same request in JSON needs no login');
    expect((await request(app).get('/tx/r5/metadata').set('Accept', 'application/fhir+xml')).status).toBe(401);
    // sending XML too, before its body is read
    const post = await request(app).post('/tx/r5/ValueSet/$expand').set('Content-Type', 'application/fhir+xml').send('<Parameters xmlns="http://hl7.org/fhir"/>');
    expect(post.status).toBe(401);
  });

  test('XML with a token, and JSON without one, are answered', async () => {
    const xml = await bearer(request(app).get('/tx/r5/metadata?_format=xml'));
    expect(xml.status).toBe(200);
    expect(xml.headers['content-type']).toContain('xml');
    const json = await request(app).get('/tx/r5/metadata').set('Accept', 'application/fhir+json');
    expect(json.status).toBe(200);
  });

  test('a web search: the first page for anyone, the next with a login', async () => {
    const first = await request(app).get('/tx/r5/CodeSystem?_format=html');
    expect(first.status).toBe(200);
    expect(first.text).toContain('Next (log in)');
    expect(first.text).toContain('href="/auth/login?return=');
    const next = await request(app).get('/tx/r5/CodeSystem?_format=html&_offset=20');
    expect(next.status).toBe(401);
    expect(next.text).toContain('search results past the first page');
    expect(next.text).toContain('href="/tx/r5/CodeSystem?_format=html"');
    expect((await request(app).get('/tx/r5/CodeSystem?_format=html&_count=200')).status).toBe(401);
    expect((await bearer(request(app).get('/tx/r5/CodeSystem?_format=html&_offset=20'))).status).toBe(200);
    // the API is unaffected
    expect((await request(app).get('/tx/r5/CodeSystem?_offset=20').set('Accept', 'application/fhir+json')).status).toBe(200);
  });

  test('Show all needs a login', async () => {
    const res = await request(app).get('/tx/r5/ValueSet/administrative-gender?_format=html&_showAll=true');
    expect(res.status).toBe(401);
    expect(res.text).toContain('Show all');
  });

  test('an expansion in the web pages: at most anonymousMaxRows rows without a login', async () => {
    const url = '/tx/r5/ValueSet/$expand?url=http://hl7.org/fhir/ValueSet/administrative-gender&_format=html';
    expect((await request(app).get(url + '&count=4')).status).toBe(401);
    expect((await request(app).get(url + '&offset=2&count=2')).status).toBe(401);
    expect((await request(app).get(url + '&offset=3')).status).toBe(401);
    expect((await request(app).get(url + '&count=3')).status).toBe(200);
    expect((await bearer(request(app).get(url + '&count=4'))).status).toBe(200);
    expect((await request(app).get(url.replace('&_format=html', '&count=4')).set('Accept', 'application/fhir+json')).status).toBe(200);
  });

  test('an expansion page that names no count is given one', () => {
    const at = (url, ctx = {}) => {
      const u = new URL(url, 'http://localhost');
      const r = TXModule.webLoginNeeded({ path: u.pathname, originalUrl: url, query: Object.fromEntries(u.searchParams) }, ctx, 1000);
      return { r, ctx };
    };
    expect(at('/ValueSet/$expand?url=x').ctx.anonymousMaxRows).toBe(1000);
    expect(at('/ValueSet/$expand?url=x&offset=400').ctx.anonymousMaxRows).toBe(600);
    expect(at('/ValueSet/x/$expand?offset=1000').r).toEqual({ kind: 'expansion-rows', back: '/ValueSet/x/$expand' });
    expect(at('/ValueSet/$expand?url=x&count=0').r).toBeNull(); // the total only
    expect(at('/CodeSystem?name=x&_offset=0').r).toBeNull();
    expect(at('/CodeSystem?name=x&_offset=20').r).toEqual({ kind: 'search-page', back: '/CodeSystem?name=x' });
    expect(at('/ValueSet/x?_format=html&_showAll=true').r).toEqual({ kind: 'show-all', back: '/ValueSet/x?_format=html' });
  });

  test('Show all, and the next page, link to the login page for someone not logged in', async () => {
    const renderer = new Renderer({ i18n: { formatPhrase: (id) => id, formatPhrasePlural: (id) => id }, langs: null },
      { resolveURL: async () => null, resolveCode: async () => null, resolveCodes: async (ctx, s, v, codes) => codes.map(() => null) });
    const html = new TxHtmlRenderer(renderer, null, null, null, '/tx/r4');
    html.loginUrlFor = url => `/auth/login?return=${encodeURIComponent(url)}`;
    const vs = { resourceType: 'ValueSet', id: 'big', status: 'active',
      compose: { include: [{ system: 'http://example.org/cs', concept: Array.from({ length: 600 }, (_, i) => ({ code: 'c' + i })) }] } };
    const url = '/tx/r4/ValueSet/big?_format=html';
    const out = await html.render(vs, { method: 'GET', path: '/ValueSet/big', originalUrl: url, query: { _format: 'html' } });
    expect(out).toContain('<a href="/auth/login?return=%2Ftx%2Fr4%2FValueSet%2Fbig%3F_format%3Dhtml%26_showAll%3Dtrue">Show all (log in)</a>');
    const links = html.renderPaginationLinks({ link: [{ relation: 'self', url: 'http://x/tx/r4/CodeSystem?_offset=0' }, { relation: 'next', url: 'http://x/tx/r4/CodeSystem?_offset=20' }] });
    expect(links).toContain('href="/auth/login?return=%2Ftx%2Fr4%2FCodeSystem%3F_offset%3D20">Next (log in)</a>');
  });
});

describe('a client logged in may have a bigger cache', () => {
  test('withConceptLimit raises the limit for one call only, never lowers it', () => {
    const cache = new ResourceCache();
    cache.setLimits(5, 1000);
    const seen = [];
    cache.withConceptLimit(50, () => seen.push(cache.maxConceptsPerCache));
    cache.withConceptLimit(2, () => seen.push(cache.maxConceptsPerCache));
    cache.withConceptLimit(undefined, () => seen.push(cache.maxConceptsPerCache));
    expect(() => cache.withConceptLimit(50, () => { throw new Error('x'); })).toThrow('x');
    expect(seen).toEqual([50, 5, 5]);
    expect(cache.maxConceptsPerCache).toBe(5);
  });

  test('a cache bigger than cacheMaxConcepts is kept for a client logged in', () => {
    const cache = new ResourceCache();
    cache.setLimits(5, 1000);
    const cs = n => ({ url: `http://x/cs${n}`, version: '1', conceptCount: () => n });
    const id = cache.start([]);
    cache.withConceptLimit(50, () => cache.add(id, [cs(10)]));
    expect(cache.status(id).exists).toBe(true);
    expect(() => cache.add(id, [cs(3)])).toThrow(/grew too large/);
  });
});

describe('a client not logged in whose cache is too big is told it could have more with a token', () => {
  let app;
  let tx;
  beforeAll(async () => {
    setupAuth({});
    app = express();
    app.use(auth.pages);
    app.use(express.json());
    tx = new TXModule();
    await tx.initialize({
      librarySource: path.join(__dirname, 'fixtures', 'test-library.yaml'),
      endpoints: [{ path: '/tx/r5', fhirVersion: '5.0', context: null }],
      cacheMaxConcepts: 2, cacheMaxConceptsLoggedIn: 50
    }, app);
  }, 60000);
  afterAll(async () => {
    await tx.shutdown();
    auth.shutdown();
  });

  test('CACHE_START_TOO_BIG says so', async () => {
    const cs = { resourceType: 'CodeSystem', url: 'http://example.org/cs3', version: '1', status: 'active', content: 'complete',
      concept: [{ code: 'a' }, { code: 'b' }, { code: 'c' }] };
    const res = await request(app).post('/tx/r5/$cache-control?mode=start').set('Content-Type', 'application/json').set('Accept', 'application/json')
      .send({ resourceType: 'Parameters', parameter: [{ name: 'tx-resource', resource: cs }] });
    expect(res.status).toBe(422);
    expect(res.body.issue[0].details.text).toContain('A client that is logged in (with an API token) may hold 50 concepts in one cache: see ');
  });
});

describe('tx: login for old FHIR tools, and for other clients', () => {
  let app;
  let tx;
  let token;
  beforeAll(async () => {
    setupAuth({ loginForOldTools: true });
    token = tokenFor(await makeUser('builder', 'a-long-enough-password'));
    app = express();
    app.use(auth.pages);
    app.use(express.json());
    tx = new TXModule();
    await tx.initialize({
      librarySource: path.join(__dirname, 'fixtures', 'test-library.yaml'),
      endpoints: [{ path: '/tx/r5', fhirVersion: '5.0', context: null }]
    }, app);
  }, 60000);
  afterAll(async () => {
    await tx.shutdown();
    auth.shutdown();
  });

  // (not /metadata, nor the value set list, which the registry crawler needs: never blocked)
  const as = (agent, url = '/tx/r5/CodeSystem?url=http://hl7.org/fhir/administrative-gender') => request(app).get(url).set('Accept', 'application/fhir+json').set('User-Agent', agent);

  test('a version of the validator or IG Publisher that does not say which it is must log in', async () => {
    const res = await as('fhir/publisher');
    expect(res.status).toBe(401);
    const oo = JSON.parse(res.text);
    expect(oo.issue[0].code).toBe('login');
    expect(oo.issue[0].details.text).toContain('This server needs an API token (Authorization: Bearer {token}) from a version of the FHIR validator or IG Publisher that doesn\'t say which version it is');
    expect(oo.issue[0].details.text).toContain('This client says it is "fhir/publisher"');
    expect((await as('hapi-fhir-tooling-client')).status).toBe(401);
    expect((await as('fhir/main-build')).status).toBe(401);
  });

  test('one that says its version, a token, other clients and the web pages need nothing', async () => {
    expect((await as('fhir/publisher fhir-core/7.0.7')).status).toBe(200);
    expect((await as('fhir/validator/7.0.7 fhir-core/7.0.7')).status).toBe(200);
    expect((await as('fhir/publisher').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await as('curl/8.14.1')).status).toBe(200);
    expect((await request(app).get('/tx/r5/metadata?_format=html').set('User-Agent', 'fhir/publisher')).status).toBe(200);
  });

  test('a minimum version: older ones must log in too', async () => {
    auth.config.loginForOldTools = '7.0.8';
    try {
      expect((await as('fhir/publisher fhir-core/7.0.7')).status).toBe(401);
      expect((await as('fhir/publisher fhir-core/7.0.8')).status).toBe(200);
    } finally {
      auth.config.loginForOldTools = true;
    }
  });

  test('loginForOtherClients: software other than the FHIR tools must log in', async () => {
    auth.config.loginForOtherClients = true;
    try {
      const res = await as('curl/8.14.1');
      expect(res.status).toBe(401);
      expect(JSON.parse(res.text).issue[0].details.text).toContain('answers software other than the FHIR validator and IG Publisher only with an API token');
      expect((await as('curl/8.14.1').set('Authorization', `Bearer ${token}`)).status).toBe(200);
      expect((await as('fhir/publisher fhir-core/7.0.7')).status).toBe(200);
      expect((await request(app).get('/tx/r5/metadata?_format=html').set('User-Agent', 'Mozilla/5.0')).status).toBe(200);
      const xml = await request(app).get('/tx/r5/CodeSystem?url=http://hl7.org/fhir/administrative-gender&_format=xml').set('User-Agent', 'curl/8.14.1');
      expect(xml.status).toBe(401);
      expect(xml.text).toContain('<code value="login"/>');
    } finally {
      auth.config.loginForOtherClients = false;
    }
  });

  test('/auth/why-login lists what this server asks a login for', async () => {
    const page = express();
    page.use('/auth', auth.router());
    const res = await request(page).get('/auth/why-login');
    expect(res.text).toContain('Answers from the terminology API for a version of the FHIR validator or IG Publisher that doesn&#39;t say which version it is');
    expect(res.text).toContain('version 7.0.7 of the FHIR core library');
    expect(res.text).not.toContain('Show all');
  });

  test('clientLoginNeeded', () => {
    expect(TXModule.clientLoginNeeded('fhir/publisher', false, false)).toBeNull();
    expect(TXModule.clientLoginNeeded('fhir/publisher', true, false)).toBe('old-tool');
    expect(TXModule.clientLoginNeeded('okhttp/5.3.2', true, false)).toBeNull();
    expect(TXModule.clientLoginNeeded('okhttp/5.3.2', false, true)).toBe('other-client');
    expect(TXModule.clientLoginNeeded('fhir/publisher', false, true)).toBeNull();
    expect(TXModule.clientLoginNeeded(undefined, false, true)).toBe('other-client');
  });
});

describe('tx: the registry crawler is never blocked', () => {
  let app;
  let tx;
  beforeAll(async () => {
    setupAuth({ loginForOldTools: true, loginForOtherClients: true, loginForExpensive: true });
    app = express();
    app.use(auth.pages);
    app.use(express.json());
    tx = new TXModule();
    await tx.initialize({
      librarySource: path.join(__dirname, 'fixtures', 'test-library.yaml'),
      endpoints: [{ path: '/tx/r5', fhirVersion: '5.0', context: null }]
    }, app);
  }, 60000);
  afterAll(async () => {
    await tx.shutdown();
    auth.shutdown();
  });

  // as registry/crawler.js asks
  const crawl = (url, agent = 'ecosystem.hl7.org/1.0') => request(app).get(url)
    .set('Accept', 'application/json, application/fhir+json').set('User-Agent', agent);

  test('metadata, and the value set list with its next pages', async () => {
    for (const agent of ['ecosystem.hl7.org/1.0', 'fhirsmith/1.0', 'FHIRRegistryServer/1.0', 'fhir/publisher']) {
      expect((await crawl('/tx/r5/metadata', agent)).status).toBe(200);
      expect((await crawl('/tx/r5/metadata?mode=terminology', agent)).status).toBe(200);
      expect((await crawl('/tx/r5/ValueSet?_elements=url,version&_count=1000', agent)).status).toBe(200);
      expect((await crawl('/tx/r5/ValueSet?_elements=url,version&_count=1000&_offset=1000', agent)).status).toBe(200);
    }
  });

  test('anything else from the same client still needs a login', async () => {
    expect((await crawl('/tx/r5/ValueSet?url=http://hl7.org/fhir/ValueSet/administrative-gender')).status).toBe(401);
    expect((await crawl('/tx/r5/ValueSet?_elements=url,version,compose')).status).toBe(401);
    expect((await crawl('/tx/r5/CodeSystem?_elements=url,version')).status).toBe(401);
    expect((await crawl('/tx/r5/ValueSet/administrative-gender')).status).toBe(401);
  });

  test('isRegistryCrawl', () => {
    const r = (method, p, query = {}) => ({ method, path: p, query });
    expect(TXModule.isRegistryCrawl(r('GET', '/metadata', { mode: 'terminology' }))).toBe(true);
    expect(TXModule.isRegistryCrawl(r('GET', '/ValueSet', { _elements: 'version,url', _count: '1000' }))).toBe(true);
    expect(TXModule.isRegistryCrawl(r('POST', '/ValueSet', { _elements: 'url,version' }))).toBe(false);
    expect(TXModule.isRegistryCrawl(r('GET', '/ValueSet', { _elements: 'url,version', name: 'x' }))).toBe(false);
  });
});
