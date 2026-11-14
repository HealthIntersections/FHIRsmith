// Limits on a request to another server, and saying which one it hit (library/http-limits.js),
// and the clients that use them: the registry crawler, the package crawler and the npm check

const http = require('http');
const { requestDeadline, describeRequestFailure } = require('../../library/http-limits');
const RegistryCrawler = require('../../registry/crawler');
const PackageCrawler = require('../../packages/package-crawler');
const { makeGetter } = require('../../packages/npm-check');
const { createGuardedAgents } = require('../../library/ssrf-guard');

describe('requestDeadline', () => {
  test('expires on its own, and says it was the one that did', async () => {
    const d = requestDeadline(20);
    expect(d.expired()).toBe(false);
    await new Promise(r => setTimeout(r, 60));
    expect(d.signal.aborted).toBe(true);
    expect(d.expired()).toBe(true);
  });

  test('is stopped by the outer signal too, which is not the deadline expiring', () => {
    const outer = new AbortController();
    const d = requestDeadline(10000, outer.signal);
    outer.abort();
    expect(d.signal.aborted).toBe(true);
    expect(d.expired()).toBe(false);
  });
});

describe('describeRequestFailure', () => {
  test('says which limit a request hit', () => {
    expect(describeRequestFailure(new Error('maxContentLength size of 10485760 exceeded'), { maxBytes: 10 * 1024 * 1024 }))
      .toBe('the response is more than 10 MB');
    expect(describeRequestFailure(new Error('canceled'), { timeoutMs: 30000, deadline: { expired: () => true } }))
      .toBe('no complete response within 30 s');
    expect(describeRequestFailure(Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }), { timeoutMs: 30000 }))
      .toBe('no complete response within 30 s');
  });

  test('otherwise, the error as it was', () => {
    expect(describeRequestFailure(new Error('connect ECONNREFUSED 127.0.0.1:1'), { timeoutMs: 30000, deadline: { expired: () => false } }))
      .toBe('connect ECONNREFUSED 127.0.0.1:1');
    // stopped from outside (a crawl stopped), not by the deadline
    expect(describeRequestFailure(new Error('canceled'), { timeoutMs: 30000, deadline: { expired: () => false } })).toBe('canceled');
  });
});

// a server that sends its headers, then a byte now and then, and never finishes; and one that
// sends a feed larger than the limit
describe('clients of a server that never finishes', () => {
  let server;
  let base;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url.startsWith('/big')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"feeds":"' + 'x'.repeat(3 * 1024 * 1024) + '"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': req.url.includes('xml') ? 'application/xml' : 'application/json' });
      res.write(req.url.includes('xml') ? '<rss>' : '{"x":"');
      const t = setInterval(() => res.write(' '), 50);
      req.on('close', () => clearInterval(t));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  });

  const packageCrawler = (crawler) => {
    const c = Object.create(PackageCrawler.prototype);
    c.config = { crawler, allowPrivateAddresses: true };
    c.log = { info() {}, warn() {}, error() {} };
    c.totalBytes = 0;
    return c;
  };

  test('the registry crawler gives up at maxRequestSeconds', async () => {
    const crawler = new RegistryCrawler({ allowPrivateAddresses: true, maxRequestSeconds: 0.5 });
    const start = Date.now();
    await expect(crawler.fetchJson(`${base}/slow.json`, 'x')).rejects.toThrow(/^No complete response from .*slow\.json.* within 0\.5 s$/);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  test('the package crawler gives up on a feed at maxRequestSeconds', async () => {
    const c = packageCrawler({ maxRequestSeconds: 0.5 });
    await expect(c.fetchJson(`${base}/slow.json`)).rejects.toThrow(/slow\.json: no complete response within 0.5 s \(maxRequestSeconds\)$/);
    await expect(c.fetchXml(`${base}/slow.xml`)).rejects.toThrow(/slow\.xml: no complete response within 0.5 s \(maxRequestSeconds\)$/);
  });

  test('the package crawler gives up on a package at maxRequestSeconds', async () => {
    const c = packageCrawler({ maxRequestSeconds: 0.5 });
    await expect(c.fetchUrl(`${base}/slow.tgz`)).rejects.toThrow(/no complete response within 0.5 s \(maxRequestSeconds\)/);
  });

  test('the package crawler refuses a feed larger than maxFeedMB', async () => {
    const c = packageCrawler({ maxFeedMB: 2 });
    await expect(c.fetchJson(`${base}/big.json`)).rejects.toThrow(/the feed is more than the limit of 2 MB \(maxFeedMB\)$/);
  });

  test('the npm check gives up at its request timeout', async () => {
    const get = makeGetter({ timeout: 500, ...createGuardedAgents({ allowPrivate: true }) });
    const start = Date.now();
    expect(await get(`${base}/slow.json`)).toMatchObject({ error: 'timed out' });
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
