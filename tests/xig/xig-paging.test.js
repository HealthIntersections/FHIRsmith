// XIG lists are at most PAGE_SIZE rows, paged by offset; resources too big to show inline are
// only offered as JSON; every request is logged with its time and size.

const sqlite3 = require('sqlite3');
const zlib = require('zlib');
const express = require('express');
const request = require('supertest');
const xig = require('../../xig/xig');

const { PAGE_SIZE, MAX_INLINE_RESOURCE, buildPager, buildPageLinks, parseOffset, describeRequest, gzipSize } = xig;

describe('XIG paging helpers', () => {
  const urlFor = o => `/xig?type=cs&offset=${o}`;

  test('no pager when the list fits on one page', () => {
    expect(buildPager(PAGE_SIZE, 0, urlFor)).toBe('');
  });

  test('pager links, html escaped', () => {
    const html = buildPager(1000, 400, urlFor);
    expect(html).toContain('href="/xig?type=cs&amp;offset=0">Start');
    expect(html).toContain('href="/xig?type=cs&amp;offset=200">Prev');
    expect(html).toContain('href="/xig?type=cs&amp;offset=600">Next');
    expect(html).toContain('Rows 400 - 600 of 1,000');
    expect(buildPager(1000, 800, urlFor)).not.toContain('Next');
  });

  test('Link header for paged JSON and CSV', () => {
    expect(buildPageLinks(10, 0, urlFor)).toBe('');
    expect(buildPageLinks(450, 0, urlFor)).toBe(
      '</xig?type=cs&offset=0>; rel="first", </xig?type=cs&offset=200>; rel="next", </xig?type=cs&offset=400>; rel="last"');
    expect(buildPageLinks(450, 400, urlFor)).toBe(
      '</xig?type=cs&offset=0>; rel="first", </xig?type=cs&offset=200>; rel="prev", </xig?type=cs&offset=400>; rel="last"');
  });

  test('offsets are whole numbers, 0 or more', () => {
    expect(parseOffset('200')).toBe(200);
    expect(parseOffset(['400', '0'])).toBe(400);
    expect(parseOffset('-5')).toBe(0);
    expect(parseOffset('x')).toBe(0);
    expect(parseOffset(undefined)).toBe(0);
  });

  test('gzip size from the trailer', () => {
    expect(gzipSize(zlib.gzipSync(Buffer.alloc(12345, 'a')))).toBe(12345);
    expect(gzipSize(Buffer.from('not gzip at all, really'))).toBe(-1);
  });

  test('the request log line', () => {
    const res = { statusCode: 200, writableFinished: true, getHeader: () => '5120' };
    expect(describeRequest({ method: 'GET', originalUrl: '/xig?type=cs' }, res, 42)).toBe('GET /xig?type=cs 200 42ms 5120b');
    const gone = { statusCode: 200, writableFinished: false, getHeader: () => undefined };
    expect(describeRequest({ method: 'GET', originalUrl: '/xig' }, gone, 7)).toBe('GET /xig 200 7ms - (client gone)');
  });
});

describe('XIG resource page', () => {
  let db;
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, e => e ? rej(e) : res()));
  const small = { resourceType: 'ValueSet', id: 'small', text: { div: '<div>small <a href="x.html">x</a></div>' } };
  const big = { resourceType: 'ValueSet', id: 'big', compose: { include: [{ concept: [] }] } };
  for (let i = 0; big.compose.include[0].concept.length * 40 < MAX_INLINE_RESOURCE * 1.2; i++) {
    big.compose.include[0].concept.push({ code: `code-${i}`, display: `Display number ${i}` });
  }

  beforeAll(async () => {
    db = new sqlite3.Database(':memory:');
    await run('CREATE TABLE Resources (ResourceKey INTEGER, ResourceType TEXT, Id TEXT, Url TEXT, Web TEXT, Name TEXT, Title TEXT, PackageKey INTEGER)');
    await run('CREATE TABLE Packages (PackageKey INTEGER, PID TEXT)');
    await run('CREATE TABLE DependencyList (TargetKey INTEGER, SourceKey INTEGER, PRIMARY KEY (TargetKey, SourceKey))');
    await run('CREATE TABLE Contents (ResourceKey INTEGER, Json BLOB)');
    await run("INSERT INTO Packages VALUES (1, 'test.pkg#1.0.0')");
    // resource 1 is used by 450 others (keys 100..549)
    await run("INSERT INTO Resources VALUES (1, 'CodeSystem', 'cs', 'http://x/cs', null, 'cs', null, 1)");
    for (let k = 100; k < 550; k++) {
      await run("INSERT INTO Resources VALUES (?, 'ValueSet', ?, ?, null, ?, null, 1)", [k, `vs${k}`, `http://x/vs${k}`, `vs${k}`]);
      await run('INSERT INTO DependencyList VALUES (1, ?)', [k]);
    }
    await run('INSERT INTO Contents VALUES (2, ?)', [zlib.gzipSync(JSON.stringify(small))]);
    await run('INSERT INTO Contents VALUES (3, ?)', [zlib.gzipSync(JSON.stringify(big))]);
    xig.setDatabaseForTests(db);
  });

  afterAll(async () => {
    xig.setDatabaseForTests(null);
    await new Promise(r => db.close(r));
  });

  test('a long dependency list is shown a page at a time', async () => {
    const paging = { path: '/xig/resource/test.pkg%7C1.0.0/CodeSystem/cs', query: {} };
    const first = await xig.buildResourceDependencies({ ResourceKey: 1, ResourceType: 'CodeSystem' }, paging);
    expect((first.match(/href="\/xig\/resource\/test\.pkg%7C1\.0\.0\/ValueSet\//g) || []).length).toBe(PAGE_SIZE);
    expect(first).toContain('Rows 0 - 200 of 450');
    expect(first).toContain('href="/xig/resource/test.pkg%7C1.0.0/CodeSystem/cs?usedByOffset=200#usedBy">Next');

    const last = await xig.buildResourceDependencies({ ResourceKey: 1, ResourceType: 'CodeSystem' },
      { ...paging, query: { usedByOffset: '400' } });
    expect((last.match(/href="\/xig\/resource\/test\.pkg%7C1\.0\.0\/ValueSet\//g) || []).length).toBe(50);
    expect(last).toContain('vs549');
    expect(last).not.toContain('>vs100<');
  });

  test('narrative and source come from one read of the content', async () => {
    const html = await xig.buildResourceContent(2, { Web: 'http://example.org/ig/index.html' }, '/r?_fmt=json');
    expect(html).toContain('href="http://example.org/ig/x.html"');
    expect(html).toContain('&lt;!-- snip (see above) --&gt;');
    expect(html).toContain('<h3>Source</h3>');
  });

  test('a resource too big to show is offered as JSON instead', async () => {
    const html = await xig.buildResourceContent(3, null, '/r?_fmt=json');
    expect(html).toContain('too big to show here');
    expect(html).toContain('href="/r?_fmt=json"');
    expect(html).not.toContain('code-1');
  });

  test('a resource as JSON: the stored gzip when the client takes it', async () => {
    const app = express();
    app.get('/r/:key', (req, res) => xig.sendResourceJson(req, res, { ResourceKey: Number(req.params.key) }));

    const zipped = await request(app).get('/r/3').set('Accept-Encoding', 'gzip');
    expect(zipped.status).toBe(200);
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(zipped.headers['content-type']).toContain('application/fhir+json');
    expect(zipped.body.id).toBe('big'); // supertest unzips it

    const plain = await request(app).get('/r/2').set('Accept-Encoding', 'identity');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(plain.text).id).toBe('small');

    expect((await request(app).get('/r/99')).status).toBe(404);
  });
});
