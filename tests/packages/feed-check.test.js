// The feed check (/packages/feed-check, packages/feed-check.js): a package feed read the way the
// crawler reads it - each item, its package and its signature - reported, with nothing stored.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const PackagesModule = require('../../packages/packages');
const { FeedCheck } = require('../../packages/feed-check');
const { keyIdOf, pae, purl } = require('../../packages/npm-signing');
const { tgz } = require('./npm-registry-checks');

function makeKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey, entry: { keyid: keyIdOf(der), key: der.toString('base64'), expires: null } };
}

function sign(k, buf, name, version) {
  const payload = Buffer.from(JSON.stringify({
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: purl(name, version), digest: { sha512: crypto.createHash('sha512').update(buf).digest('hex') } }],
    predicateType: 'http://hl7.org/fhir/package-signature/v1', predicate: {}
  }));
  const type = 'application/vnd.in-toto+json';
  return JSON.stringify({
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: { publicKey: { hint: k.entry.keyid }, tlogEntries: [] },
    dsseEnvelope: { payload: payload.toString('base64'), payloadType: type,
      signatures: [{ sig: crypto.sign('sha256', pae(type, payload), k.privateKey).toString('base64'), keyid: k.entry.keyid }] }
  });
}

function tarball(id, version, extra = {}) {
  return tgz({
    'package/package.json': JSON.stringify({
      name: id, version, type: 'fhir.ig', canonical: `http://example.org/fhir/${id}`,
      fhirVersions: ['4.0.1'], license: 'CC0-1.0', ...extra
    })
  });
}

const DATE = 'Mon, 01 Jun 2026 00:00:00 GMT';

describe('feed check', () => {
  let tmp, module, server, base, key, files, master;

  // the web: path -> Buffer or string
  function serve(p, content) {
    files[p] = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  }

  function item({ title, link, sig, extra = '' }) {
    return `<item><title>${title}</title><guid isPermaLink="true">${link || title}</guid>` +
      (link ? `<link>${link}</link>` : '') + `<pubDate>${DATE}</pubDate>` +
      (sig ? `<fhir:signature>${sig}</fhir:signature>` : '') + extra + '</item>';
  }

  function feed(items, next) {
    return '<?xml version="1.0"?><rss xmlns:fhir="http://hl7.org/fhir/feed" xmlns:atom="http://www.w3.org/2005/Atom" version="2.0"><channel>' +
      '<title>t</title><link>x</link>' + (next ? `<atom:link rel="next" href="${next}"/>` : '') + items.join('') + '</channel></rss>';
  }

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-check-'));
    files = {};
    const app = express();
    app.get('*splat', (req, res) => files[req.path] ? res.send(files[req.path]) : res.status(404).send('no'));
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
    module = new PackagesModule({ countRequest() {} });
    await module.initialize({
      database: path.join(tmp, 'packages.db'),
      mirrorPath: path.join(tmp, 'mirror'),
      masterUrl: 'http://127.0.0.1:1/unused',
      crawler: { enabled: false },
      npmSigning: { enabled: false },
      allowPrivateAddresses: true
    });
    key = makeKey();
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    await module.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    files = {};
    master = {
      feeds: [{ name: 'Test feed', url: `${base}/feed.xml`, signing: { keys: [key.entry] } }],
      'package-restrictions': [{ mask: 'hl7.fhir.*', feeds: ['https://hl7.org/fhir/package-feed.xml'] }]
    };
  });

  // https is tried first by the crawler (fixUrl); the test server only speaks http
  const check = (opts = {}) => {
    const fc = new FeedCheck({ allowPrivateAddresses: true }, {
      master: async () => master,
      held: (id, version) => module.dbGet('SELECT Hash AS hash FROM PackageVersions WHERE Id = ? AND Version = ?', [id, version]),
      signing: opts.signing || null,
      maxItems: opts.maxItems || 50, maxTotalMB: 500
    });
    const reader = fc.reader.bind(fc);
    fc.reader = () => {
      const c = reader();
      c.fixUrl = u => u;
      return c;
    };
    return fc;
  };

  test('reports each item: its package, its signature and what is wrong', async () => {
    const good = tarball('ex.good', '1.0.0');
    serve('/good.tgz', good);
    serve('/good.tgz.sigstore.json', sign(key, good, 'ex.good', '1.0.0'));
    const bad = tarball('ex.bad', '1.0.0');
    serve('/bad.tgz', bad);
    serve('/bad.tgz.sigstore.json', sign(makeKey(), bad, 'ex.bad', '1.0.0'));
    serve('/unsigned.tgz', tarball('ex.unsigned', '1.0.0'));
    serve('/notpkg.tgz', 'this is not a package');
    serve('/restricted.tgz', tarball('hl7.fhir.uv.thing', '1.0.0'));
    serve('/js.tgz', tgz({ 'package/package.json': JSON.stringify({ name: 'ex.js', version: '1.0.0', type: 'fhir.ig', canonical: 'http://example.org/x' }), 'package/x.js': 'alert(1)' }));
    serve('/feed.xml', feed([
      item({ title: 'ex.good#1.0.0', link: `${base}/good.tgz`, sig: `${base}/good.tgz.sigstore.json` }),
      item({ title: 'ex.bad#1.0.0', link: `${base}/bad.tgz`, sig: `${base}/bad.tgz.sigstore.json` }),
      item({ title: 'ex.unsigned#1.0.0', link: `${base}/unsigned.tgz` }),
      item({ title: 'ex.notpkg#1.0.0', link: `${base}/notpkg.tgz` }),
      item({ title: 'hl7.fhir.uv.thing#1.0.0', link: `${base}/restricted.tgz` }),
      item({ title: 'ex.js#1.0.0', link: `${base}/js.tgz` }),
      item({ title: 'ex.missing#1.0.0', link: `${base}/missing.tgz` }),
      item({ title: 'ex.nolink#1.0.0' }),
      item({ title: 'ex.draft#1.0.0', link: `${base}/x.tgz`, extra: '<notForPublication>true</notForPublication>' }),
      item({ title: 'ex.good#1.0.0', link: `${base}/good.tgz` })
    ]));
    const report = await check().run(`${base}/feed.xml`);
    const by = t => report.items.filter(i => i.title === t);

    expect(report.registered).toEqual({ name: 'Test feed' });
    expect(report.signing).toEqual({ required: false, keys: [key.entry.keyid] });
    expect(report.errors).toEqual([]);
    expect(report.items).toHaveLength(10);

    const good1 = by('ex.good#1.0.0')[0];
    expect(good1).toMatchObject({ status: 'ok', held: 'no', package: { id: 'ex.good', version: '1.0.0', fhirVersions: '4.0.1' } });
    expect(good1.signature).toMatchObject({ state: 'confirmed' });
    expect(by('ex.good#1.0.0')[1].warnings).toEqual([expect.stringMatching(/more than once/)]);

    expect(by('ex.bad#1.0.0')[0].signature.state).toBe('rejected');
    expect(by('ex.bad#1.0.0')[0].status).toBe('ok'); // logged, not refused: the feed doesn't require signatures
    expect(by('ex.unsigned#1.0.0')[0].signature.state).toBe('absent');
    expect(by('ex.notpkg#1.0.0')[0]).toMatchObject({ status: 'error', problems: [expect.stringMatching(/can't be read/)] });
    expect(by('hl7.fhir.uv.thing#1.0.0')[0].problems).toEqual([expect.stringMatching(/doesn't allow hl7.fhir.uv.thing from this feed/)]);
    expect(by('ex.js#1.0.0')[0].problems).toEqual([expect.stringMatching(/JavaScript/)]);
    expect(by('ex.missing#1.0.0')[0].status).toBe('error');
    expect(by('ex.nolink#1.0.0')[0].problems).toEqual([expect.stringMatching(/no link/)]);
    expect(by('ex.draft#1.0.0')[0]).toMatchObject({ status: 'skipped' });
  });

  test('a feed that requires signatures: an unsigned package would be refused', async () => {
    master.feeds[0].signing.required = true;
    serve('/u.tgz', tarball('ex.u', '1.0.0'));
    serve('/feed.xml', feed([item({ title: 'ex.u#1.0.0', link: `${base}/u.tgz` })]));
    const report = await check().run(`${base}/feed.xml`);
    expect(report.items[0]).toMatchObject({ status: 'error', problems: [expect.stringMatching(/would refuse this package: it is not signed/)] });
  });

  test('a feed that isn\'t registered: signatures can\'t be checked, and it says so', async () => {
    const buf = tarball('ex.other', '1.0.0');
    serve('/o.tgz', buf);
    serve('/o.tgz.sigstore.json', sign(key, buf, 'ex.other', '1.0.0'));
    serve('/other.xml', feed([item({ title: 'ex.other#1.0.0', link: `${base}/o.tgz`, sig: `${base}/o.tgz.sigstore.json` })]));
    const report = await check().run(`${base}/other.xml`);
    expect(report.registered).toBeNull();
    expect(report.notes).toEqual([expect.stringMatching(/isn't in the registry's feed list/)]);
    expect(report.items[0].signature).toMatchObject({ state: 'unchecked' });
    expect(report.items[0].signature.detail).toContain(key.entry.keyid);
  });

  test('signing keys given with the check are used instead of the registry\'s', async () => {
    const other = makeKey();
    const buf = tarball('ex.given', '1.0.0');
    serve('/g.tgz', buf);
    serve('/g.tgz.sigstore.json', sign(other, buf, 'ex.given', '1.0.0'));
    serve('/feed.xml', feed([item({ title: 'ex.given#1.0.0', link: `${base}/g.tgz`, sig: `${base}/g.tgz.sigstore.json` })]));
    // against the registry's key, it fails
    expect((await check().run(`${base}/feed.xml`)).items[0].signature.state).toBe('rejected');
    // against the key given, it is confirmed
    const report = await check({ signing: { required: true, keys: [other.entry] } }).run(`${base}/feed.xml`);
    expect(report.signingSource).toBe('given');
    expect(report.signing).toEqual({ required: true, keys: [other.entry.keyid] });
    expect(report.items[0].signature.state).toBe('confirmed');
    // and for a feed the registry doesn't list
    serve('/other.xml', feed([item({ title: 'ex.given#1.0.0', link: `${base}/g.tgz`, sig: `${base}/g.tgz.sigstore.json` })]));
    const unlisted = await check({ signing: { keys: [other.entry] } }).run(`${base}/other.xml`);
    expect(unlisted.items[0].signature.state).toBe('confirmed');
    expect(unlisted.notes).toEqual([expect.stringMatching(/checked against the keys given/)]);
  });

  test('follows next pages, up to the item limit', async () => {
    serve('/a.tgz', tarball('ex.a', '1.0.0'));
    serve('/feed.xml', feed([item({ title: 'ex.a#1.0.0', link: `${base}/a.tgz` }), item({ title: 'ex.a#1.0.1', link: `${base}/a.tgz` })], `${base}/page2.xml`));
    serve('/page2.xml', feed([item({ title: 'ex.a#1.0.2', link: `${base}/a.tgz` }), item({ title: 'ex.a#1.0.3', link: `${base}/a.tgz` })]));
    const all = await check().run(`${base}/feed.xml`);
    expect(all.pages.map(p => p.items)).toEqual([2, 2]);
    expect(all.items).toHaveLength(4);
    expect(all.items[1].warnings).toEqual([expect.stringMatching(/the package is ex.a#1.0.0/)]);
    const some = await check({ maxItems: 3 }).run(`${base}/feed.xml`);
    expect(some.items).toHaveLength(3);
    expect(some.truncated).toBe(true);
  });

  test('a feed can\'t make it read local files', async () => {
    serve('/feed.xml', feed([item({ title: 'ex.a#1.0.0', link: '/etc/passwd' })], '/etc/hosts'));
    const report = await check().run(`${base}/feed.xml`);
    expect(report.items[0].problems).toEqual([expect.stringMatching(/not an http\(s\) URL/)]);
    expect(report.errors).toEqual([expect.stringMatching(/not an http\(s\) URL/)]);
  });

  test('something that isn\'t a feed is reported', async () => {
    serve('/nope.xml', '<html><body>hello</body></html>');
    expect((await check().run(`${base}/nope.xml`)).errors).toEqual([expect.stringMatching(/not an RSS feed/)]);
    expect((await check().run(`${base}/absent.xml`)).errors).toEqual([expect.stringMatching(/Failed to fetch XML/)]);
  });

  test('says whether this registry already holds each version, and whether it is the same', async () => {
    const buf = tarball('ex.held', '1.0.0');
    const link = `${base}/held.tgz`;
    await module.crawler.store('test', link, link, new Date(DATE), buf, 'ex.held#1.0.0', {});
    serve('/held.tgz', buf);
    serve('/feed.xml', feed([item({ title: 'ex.held#1.0.0', link })]));
    expect((await check().run(`${base}/feed.xml`)).items[0].held).toBe('yes, the same bytes');
    serve('/held.tgz', tarball('ex.held', '1.0.0', { description: 'changed' }));
    expect((await check().run(`${base}/feed.xml`)).items[0].held).toBe('yes, but different bytes');
  });

  describe('the pages', () => {
    let app;
    beforeAll(() => {
      app = express();
      app.use('/packages', module.router);
    });

    const counts = () => module.dbGet(`SELECT (SELECT COUNT(*) FROM PackageVersions) AS v, (SELECT COUNT(*) FROM PackageSignatures) AS s,
                                       (SELECT COUNT(*) FROM FeedPages) AS p`);

    test('a run starts, its report is polled, and nothing is stored', async () => {
      module.feedCheckMasterList = async () => master;
      const buf = tarball('ex.page', '1.0.0');
      serve('/p.tgz', buf);
      serve('/p.tgz.sigstore.json', sign(key, buf, 'ex.page', '1.0.0'));
      serve('/feed.xml', feed([item({ title: 'ex.page#1.0.0', link: `${base}/p.tgz`, sig: `${base}/p.tgz.sigstore.json` })]));
      const before = await counts();

      // the crawler fetches http as https first; make the run use the URLs as given
      const realFix = require('../../packages/package-crawler').prototype.fixUrl;
      require('../../packages/package-crawler').prototype.fixUrl = u => u;
      try {
        const started = await request(app).get('/packages/feed-check').query({ url: `${base}/feed.xml` }).set('Accept', 'text/html');
        expect(started.status).toBe(303);
        const where = started.headers.location;
        expect(where).toMatch(/^\/packages\/feed-check\/[0-9a-f]{24}$/);
        let job;
        for (let i = 0; i < 100; i++) {
          job = (await request(app).get(where).set('Accept', 'application/json')).body;
          if (job.state !== 'running') {
            break;
          }
          await new Promise(r => setTimeout(r, 50));
        }
        expect(job.state).toBe('done');
        expect(job.report.items[0]).toMatchObject({ status: 'ok', signature: { state: 'confirmed' } });
        const page = await request(app).get(where).set('Accept', 'text/html');
        expect(page.text).toContain('confirmed');
        expect(page.text).toContain('ex.page#1.0.0');
        expect(page.headers.refresh).toBeUndefined();
      } finally {
        require('../../packages/package-crawler').prototype.fixUrl = realFix;
      }
      expect(await counts()).toEqual(before);
    });

    test('signing information must be usable JSON', async () => {
      const go = signing => request(app).get('/packages/feed-check').query({ url: `${base}/feed.xml`, signing }).set('Accept', 'application/json');
      expect((await go('not json')).body.error).toMatch(/isn't JSON/);
      expect((await go('{"keys": []}')).body.error).toMatch(/needs a keys array/);
      expect((await go('{"keys": [{"keyid": "x", "key": "not a key"}]}')).body.error).toMatch(/isn't a base64 public key/);
      expect((await go('{"keys": [{"keyid": "x", "key": "not a key"}]}')).status).toBe(400);
    });

    test('only one check runs at a time', async () => {
      module.feedCheckRunning = true;
      try {
        const res = await request(app).get('/packages/feed-check').query({ url: `${base}/feed.xml` }).set('Accept', 'application/json');
        expect(res.status).toBe(503);
        expect(res.body.error).toMatch(/one runs at a time/);
      } finally {
        module.feedCheckRunning = false;
      }
    });

    test('only http(s) URLs; an unknown run is a 404; the form is served', async () => {
      expect((await request(app).get('/packages/feed-check').query({ url: 'file:///etc/passwd' })).status).toBe(400);
      expect((await request(app).get('/packages/feed-check/0123456789abcdef01234567').set('Accept', 'application/json')).status).toBe(404);
      expect((await request(app).get('/packages/feed-check/not-a-run').set('Accept', 'application/json')).status).toBe(404);
      const form = await request(app).get('/packages/feed-check').set('Accept', 'text/html');
      expect(form.status).toBe(200);
      expect(form.text).toContain('name="url"');
    });

    test('the nav bar links to the feed check only while it is enabled', async () => {
      const link = 'href="/packages/feed-check"';
      expect((await request(app).get('/packages/log').set('Accept', 'text/html')).text).toContain(link);
      const saved = module.config.feedCheck;
      module.config.feedCheck = { enabled: false };
      try {
        const page = await request(app).get('/packages/log').set('Accept', 'text/html');
        expect(page.status).toBe(200);
        expect(page.text).not.toContain(link);
        expect(page.text).not.toContain('[%feed-check-link%]');
      } finally {
        module.config.feedCheck = saved;
      }
    });
  });
});
