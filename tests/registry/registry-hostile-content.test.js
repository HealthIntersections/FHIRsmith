// The registry shows what it crawls: registry lists, which other people host, and the
// CapabilityStatements and TerminologyCapabilities of the servers they list. None of that
// must be able to put script in its pages, nor can the request parameters.

const http = require('http');
const express = require('express');
const request = require('supertest');
const parse5 = require('parse5');
const RegistryCrawler = require('../../registry/crawler');
const RegistryAPI = require('../../registry/api');
const RegistryModule = require('../../registry/registry');

const EVIL = '</script><script>alert(document.domain)</script>';
const EVIL_ATTR = '"><img src=x onerror=alert(document.domain)>';
const EVIL_URL = 'javascript:alert(document.domain)';
const BAD = EVIL + EVIL_ATTR;

// script elements, event handlers and script URLs that the injected content would add
function injected(html) {
  const found = [];
  (function walk(n) {
    if (n.tagName === 'script' && (n.childNodes || []).map(c => c.value).join('').trim() === 'alert(document.domain)') {
      found.push('script');
    }
    for (const a of n.attrs || []) {
      if (/^on/i.test(a.name)) {
        found.push(`${n.tagName} ${a.name}`);
      }
      if (['href', 'src', 'action', 'formaction'].includes(a.name) && /^\s*javascript:/i.test(a.value)) {
        found.push(`${n.tagName} ${a.name}=${a.value}`);
      }
    }
    (n.childNodes || []).forEach(walk);
  })(parse5.parse(html));
  return found;
}

describe('registry: hostile registry and server content', () => {
  let server, base, app, crawler;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      let body;
      if (u.pathname === '/master.json') {
        body = { formatVersion: '1', documentation: BAD, registration: EVIL_URL, 'ecosystem-documentation': 'https://evil.org/' + EVIL_ATTR, registries: [{ code: 'evil', name: 'Evil' + BAD, url: `${base}/registry.json`, authority: BAD }] };
      } else if (u.pathname === '/registry.json') {
        body = {
          formatVersion: '1',
          servers: [
            {
              code: 'evil-server', name: 'Evil server' + BAD, url: EVIL_URL, access_info: BAD,
              authoritative: ['http://evil.org/*' + BAD], 'authoritative-valuesets': ['http://evil.org/vs/*' + BAD],
              usage: [BAD], exclusions: [], languages: { [BAD]: ['http://evil.org/*' + BAD] },
              fhirVersions: [{ version: '4.0.1', url: `${base}/r4` }, { version: '4.0.1' + BAD, url: `${base}/r4x" onmouseover="alert(document.domain)` }]
            },
            { code: 'evil2', name: 'Second' + BAD, url: `${base}/x" onmouseover="alert(document.domain)`, fhirVersions: [{ version: '5.0.0', url: `${base}/r5` }] }
          ]
        };
      } else if (u.pathname.endsWith('/metadata') && u.searchParams.get('mode') === 'terminology') {
        body = { resourceType: 'TerminologyCapabilities', codeSystem: [{ uri: 'http://evil.org/cs' + BAD, content: BAD, version: [{ code: BAD }] }, { uri: EVIL_URL }] };
      } else if (u.pathname.endsWith('/metadata')) {
        body = { resourceType: 'CapabilityStatement', fhirVersion: u.pathname.includes('r5') ? '5.0.0' : '4.0.1', software: { name: 'Evil' + BAD, version: BAD, releaseDate: BAD } };
      } else if (u.pathname.endsWith('/ValueSet')) {
        body = { resourceType: 'Bundle', entry: [{ resource: { url: 'http://evil.org/vs' + BAD, version: BAD } }, { resource: { url: EVIL_URL } }] };
      } else {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
      res.end(JSON.stringify(body));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;

    crawler = new RegistryCrawler({ masterUrl: `${base}/master.json`, allowPrivateAddresses: true }, { task() {}, taskDone() {}, taskError() {} });
    crawler.useLog({ info() {}, debug() {}, warn() {}, error() {} });
    await crawler.crawl();

    const module = new RegistryModule({ countRequest() {} });
    module.crawler = crawler;
    module.api = new RegistryAPI(crawler);
    module.currentData = crawler.getData();
    module.releases = { latest: () => null, source: 'test', describe: () => ({}) };
    module.setupRoutes();
    app = express();
    app.use('/tx-reg', module.router);
  }, 60000);

  afterAll(() => new Promise(r => server.close(r)));

  test('the crawl saw the hostile content', () => {
    const json = JSON.stringify(crawler.getData());
    expect(json).toContain('Evil server');
    expect(json).toContain('http://evil.org/cs');
  });

  const pages = [
    '/tx-reg',
    '/tx-reg?registry=evil&fhirVersion=4.0.1',
    '/tx-reg?server=evil-server',
    '/tx-reg/software',
    '/tx-reg/log',
    '/tx-reg/resolve',
    '/tx-reg/resolve?fhirVersion=4.0.1&url=' + encodeURIComponent('http://evil.org/cs' + BAD),
    '/tx-reg/resolve?fhirVersion=4.0.1&url=' + encodeURIComponent('http://evil.org/x'),
    '/tx-reg/resolve?fhirVersion=4.0.1&valueSet=' + encodeURIComponent('http://evil.org/vs/x'),
    '/tx-reg/resolve?fhirVersion=' + encodeURIComponent(BAD) + '&url=' + encodeURIComponent(BAD) + '&usage=' + encodeURIComponent(BAD) + '&language=' + encodeURIComponent(BAD),
    '/tx-reg/resolve?fhirVersion=4.0.1&valueSet=' + encodeURIComponent(EVIL_URL),
    // the first server only answers requests for its own usage
    '/tx-reg/resolve?fhirVersion=4.0.1&usage=' + encodeURIComponent(BAD) + '&url=' + encodeURIComponent('http://evil.org/cs' + BAD),
    '/tx-reg/resolve?fhirVersion=4.0.1&usage=' + encodeURIComponent(BAD) + '&url=' + encodeURIComponent('http://evil.org/other'),
    '/tx-reg/resolve?fhirVersion=4.0.1&usage=' + encodeURIComponent(BAD) + '&language=' + encodeURIComponent(BAD) + '&url=' + encodeURIComponent('http://evil.org/other'),
    '/tx-reg/resolve?fhirVersion=4.0.1&usage=' + encodeURIComponent(BAD) + '&valueSet=' + encodeURIComponent('http://evil.org/vs' + BAD),
    '/tx-reg/resolve?fhirVersion=4.0.1&usage=' + encodeURIComponent(BAD) + '&valueSet=' + encodeURIComponent('http://evil.org/vs/x'),
    '/tx-reg/resolve?fhirVersion=5.0.0&url=' + encodeURIComponent('http://evil.org/cs' + BAD),
    '/tx-reg/openapi'
  ];

  test('the resolve pages list the hostile servers', async () => {
    const res = await request(app).get(pages.find(p => p.includes('usage=') && p.includes('cs'))).set('Accept', 'text/html');
    expect(res.text).toContain('Evil server');
  });

  test.each(pages)('%s has no injected script', async (url) => {
    const res = await request(app).get(url).set('Accept', 'text/html');
    expect(res.status).toBeLessThan(500);
    expect(injected(res.text)).toEqual([]);
  });
});

describe('registry crawler: response size', () => {
  const zlib = require('zlib');
  let server, base;

  beforeAll(async () => {
    // 200 MB of JSON whitespace, gzipped to about 200 KB
    const member = zlib.gzipSync(Buffer.alloc(1024 * 1024, ' '));
    const bomb = Buffer.concat([zlib.gzipSync(Buffer.from('{"formatVersion": "1", "x": "')), ...Array(200).fill(member), zlib.gzipSync(Buffer.from('"}'))]);
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      res.end(bomb);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(() => new Promise(r => server.close(r)));

  test('a response that unzips to more than maxResponseMB is refused', async () => {
    const crawler = new RegistryCrawler({ allowPrivateAddresses: true, maxResponseMB: 10 });
    await expect(crawler.fetchJson(`${base}/master.json`, 'master')).rejects.toThrow(/is more than 10 MB/);
  });
});

describe('registry: the FHIR version a server claims', () => {
  test('the crawler keeps only a fhirVersion that looks like one', () => {
    const crawler = new RegistryCrawler({});
    for (const v of ['4.0.1', '5.0.0', '1.0.2', '6.0.0-ballot3', '4.3']) {
      expect(crawler.fhirVersionOf({ fhirVersion: v }, '4.0.1', 'x')).toBe(v);
    }
    for (const v of [BAD, '4.0.1' + EVIL_ATTR, 401, { a: 1 }, ['4.0.1']]) {
      expect(crawler.fhirVersionOf({ fhirVersion: v }, '4.0.1', 'x')).toBe('4.0.1');
    }
    expect(crawler.fhirVersionOf({}, '3.0.2', 'x')).toBe('3.0.2');
  });

  test('the authoritative tables escape the versions they show', () => {
    const m = Object.create(RegistryModule.prototype);
    const servers = [{ code: 'evil', name: 'Evil', address: 'https://evil.example.org/fhir', authCSList: ['http://example.org/cs'],
      authVSList: ['http://example.org/vs'], languages: {}, versions: [{ version: EVIL_ATTR }] }];
    m.crawler = { getData: () => ({ registries: [{ servers }] }) };
    for (const html of [m._renderAuthoritativeCodeSystemsTable(), m._renderAuthoritativeValueSetsTable()]) {
      expect(injected(html)).toEqual([]);
      expect(html).toContain(require('escape-html')(EVIL_ATTR));
    }
  });
});

describe('registry crawler: credentials and redirects', () => {
  let a, b, aBase, bBase;
  const seen = [];
  beforeAll(async () => {
    b = http.createServer((req, res) => {
      seen.push({ where: 'b', apiKey: req.headers['api-key'] || null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok": true}');
    });
    await new Promise(r => b.listen(0, '127.0.0.1', r));
    bBase = `http://127.0.0.1:${b.address().port}`;
    a = http.createServer((req, res) => {
      seen.push({ where: 'a', apiKey: req.headers['api-key'] || null });
      if (req.url === '/same') {
        res.writeHead(302, { Location: `${aBase}/final` });
      } else if (req.url === '/final') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('{"ok": true}');
      } else {
        res.writeHead(302, { Location: `${bBase}/elsewhere` });
      }
      res.end();
    });
    await new Promise(r => a.listen(0, '127.0.0.1', r));
    aBase = `http://127.0.0.1:${a.address().port}`;
  });
  afterAll(async () => {
    await new Promise(r => a.close(r));
    await new Promise(r => b.close(r));
  });

  test('the Api-Key goes to the server it is for, and not on to another host it redirects to', async () => {
    const crawler = new RegistryCrawler({ allowPrivateAddresses: true });
    await crawler.getJson(`${aBase}/start`, { 'Api-Key': 'secret' });
    expect(seen).toEqual([{ where: 'a', apiKey: 'secret' }, { where: 'b', apiKey: null }]);
    seen.length = 0;
    await crawler.getJson(`${aBase}/same`, { 'Api-Key': 'secret' });
    expect(seen).toEqual([{ where: 'a', apiKey: 'secret' }, { where: 'a', apiKey: 'secret' }]);
  });
});

describe('registry: the registry tree and the matches table (RegistryAPI)', () => {
  test('codes, descriptions and versions from the registries are escaped', () => {
    const data = { address: 'https://x/master.json' + EVIL, outcome: 'ok', registries: [{ code: 'r' + EVIL_ATTR, name: 'n', address: 'https://x', servers: [
      { code: 's' + EVIL, name: 'n', address: 'https://s', description: BAD, authCSList: ['http://cs'], authVSList: [], usageList: [],
        versions: [{ version: '4.0' + EVIL, address: 'https://s/r4', codeSystems: [], valueSets: [], details: BAD }] }] }] };
    const api = new RegistryAPI({ getData: () => data });
    expect(injected(api.renderInfoToHtml())).toEqual([]);
    const table = api.renderJsonToHtml({ results: [{ 'registry-code': 'r' + EVIL_ATTR, 'registry-name': BAD, 'server-code': 's' + EVIL, 'server-name': BAD,
      fhirVersion: '4.0.1' + EVIL_ATTR, url: EVIL_URL, systems: BAD, security: BAD, error: BAD }] }, '/tx-reg?x=1');
    expect(injected(table)).toEqual([]);
  });
});
