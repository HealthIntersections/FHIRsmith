// Fetching a package from a URL (CIBuildClient.fetchFromUrlSpecific): redirects, timeouts and one
// more try. On CI, "Timeout fetching https://packages2.fhir.org/packages/..." came now and again:
// packages2 redirects to packages-cdn.fhir.org, and the timer of the redirect's request went on
// running while the download was under way, and named the wrong URL when it went off

const http = require('http');
const { CIBuildClient, PackageManager } = require('../../library/package-manager');
const os = require('os');
const path = require('path');

describe('fetching a package from a URL', () => {
  let server;
  let base;
  let hits;
  const routes = {};

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits[req.url] = (hits[req.url] || 0) + 1;
      const route = routes[req.url];
      if (!route) {
        res.statusCode = 404;
        res.end();
        return;
      }
      route(req, res, hits[req.url]);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    CIBuildClient.FETCH_IDLE_MS = 30000;
    CIBuildClient.FETCH_RETRY_MS = 1000;
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  });

  beforeEach(() => {
    hits = {};
    CIBuildClient.FETCH_IDLE_MS = 300;
    CIBuildClient.FETCH_RETRY_MS = 10;
  });

  // a download that takes longer than the idle time in all, but is never idle that long
  routes['/cdn/slow.tgz'] = (req, res) => {
    res.writeHead(200);
    let n = 0;
    const t = setInterval(() => {
      res.write(Buffer.alloc(10, 'x'));
      if (++n === 8) {
        clearInterval(t);
        res.end();
      }
    }, 100);
  };
  routes['/packages/slow'] = (req, res) => {
    res.writeHead(302, { Location: '/cdn/slow.tgz' });
    res.end('Found');
  };

  test('a redirect\'s own timer doesn\'t go off while the download it led to is under way', async () => {
    const data = await new CIBuildClient().fetchFromUrlSpecific(`${base}/packages/slow`);
    expect(data.length).toBe(80);
    expect(hits['/packages/slow']).toBe(1);
  });

  // no answer the first time, an answer the second
  routes['/packages/hangs-once'] = (req, res, n) => {
    if (n > 1) {
      res.end('ok');
    }
  };

  test('a request that gets no answer is tried once more', async () => {
    const data = await new CIBuildClient().fetchFromUrlSpecific(`${base}/packages/hangs-once`);
    expect(data.toString()).toBe('ok');
    expect(hits['/packages/hangs-once']).toBe(2);
  });

  routes['/packages/hangs'] = () => {};
  routes['/packages/to-hangs'] = (req, res) => {
    res.writeHead(302, { Location: '/packages/hangs' });
    res.end();
  };

  test('a timeout names the URL that didn\'t answer, and the one asked for', async () => {
    await expect(new CIBuildClient().fetchFromUrlSpecific(`${base}/packages/to-hangs`)).rejects
      .toThrow(`Timeout fetching ${base}/packages/hangs (redirected from ${base}/packages/to-hangs): no answer for 0.3 seconds`);
    expect(hits['/packages/hangs']).toBe(2);
  });

  routes['/packages/missing'] = (req, res) => {
    res.statusCode = 404;
    res.end();
  };
  routes['/packages/loop'] = (req, res) => {
    res.writeHead(302, { Location: '/packages/loop' });
    res.end();
  };

  test('a 404 isn\'t tried again; a redirect loop stops', async () => {
    await expect(new CIBuildClient().fetchFromUrlSpecific(`${base}/packages/missing`)).rejects.toThrow('HTTP 404');
    expect(hits['/packages/missing']).toBe(1);
    await expect(new CIBuildClient().fetchFromUrlSpecific(`${base}/packages/loop`)).rejects.toThrow('more than 5 redirects');
  });

  // the package servers path (PackageManager.fetchFromServer, axios): on CI
  // "getaddrinfo EAI_AGAIN packages-cdn.fhir.org" failed a test now and again
  routes['/srv/flaky/1.0.0'] = (req, res, n) => {
    if (n === 1) {
      res.statusCode = 503;
      res.end();
      return;
    }
    res.writeHead(200);
    res.end('package');
  };
  routes['/srv/drops/1.0.0'] = (req, res, n) => {
    if (n === 1) {
      req.socket.destroy();
      return;
    }
    res.writeHead(200);
    res.end('package');
  };
  routes['/srv/gone/1.0.0'] = (req, res) => {
    res.statusCode = 404;
    res.end();
  };

  const packageManager = () => new PackageManager([`${base}/srv`], path.join(os.tmpdir(), 'fhirsmith-package-fetch-test'));

  test('a package server\'s 5xx or dropped connection is tried once more; a 404 isn\'t', async () => {
    expect((await packageManager().fetchFromServer(`${base}/srv`, 'flaky', '1.0.0')).toString()).toBe('package');
    expect(hits['/srv/flaky/1.0.0']).toBe(2);
    expect((await packageManager().fetchFromServer(`${base}/srv`, 'drops', '1.0.0')).toString()).toBe('package');
    expect(hits['/srv/drops/1.0.0']).toBe(2);
    await expect(packageManager().fetchFromServer(`${base}/srv`, 'gone', '1.0.0')).rejects.toThrow('not found');
    expect(hits['/srv/gone/1.0.0']).toBe(1);
  });

  test('a name that doesn\'t resolve is tried once more', () => {
    expect(PackageManager.isTransientFetchError(Object.assign(new Error('getaddrinfo EAI_AGAIN packages-cdn.fhir.org'), { code: 'EAI_AGAIN' }))).toBe(true);
    expect(PackageManager.isTransientFetchError(Object.assign(new Error('x'), { response: { status: 403 } }))).toBe(false);
    expect(PackageManager.isTransientFetchError(Object.assign(new Error('x'), { response: { status: 502 } }))).toBe(true);
  });
});
