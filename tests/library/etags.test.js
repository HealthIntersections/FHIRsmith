// ETags (library/etags.js): Express's, bounded; and the tx module's for stored resources

const http = require('http');
const express = require('express');
const etag = require('etag');
const { boundedWeakETag, storedResourceETag } = require('../../library/etags');

describe('boundedWeakETag', () => {
  test('the same ETag Express makes, for bodies up to the limit', () => {
    const f = boundedWeakETag(1000);
    for (const body of ['', 'a', '{"resourceType":"Parameters"}', 'ü€'.repeat(100)]) {
      expect(f(body, 'utf8')).toBe(etag(Buffer.from(body, 'utf8'), { weak: true }));
    }
    const buf = Buffer.from('a buffer');
    expect(f(buf)).toBe(etag(buf, { weak: true }));
  });

  test('none for a body over the limit, counted in bytes', () => {
    const f = boundedWeakETag(1000);
    expect(f('x'.repeat(1001), 'utf8')).toBeUndefined();
    expect(f('€'.repeat(400), 'utf8')).toBeUndefined(); // 400 characters, 1200 bytes
  });
});

describe('storedResourceETag', () => {
  const cs = { resourceType: 'CodeSystem', url: 'http://example.org/cs', version: '1' };

  test('weak, and the same for the same content (in any process)', () => {
    const tag = storedResourceETag(cs, 'json', '5.0');
    expect(tag).toMatch(/^W\/"[A-Za-z0-9_-]{27}-json-5\.0"$/);
    expect(storedResourceETag({ ...cs }, 'json', '5.0')).toBe(tag);
  });

  test('different for each format and version, and for different content', () => {
    const tag = storedResourceETag(cs, 'json', '5.0');
    expect(storedResourceETag(cs, 'xml', '5.0')).not.toBe(tag);
    expect(storedResourceETag(cs, 'json', '4.0')).not.toBe(tag);
    expect(storedResourceETag({ ...cs, version: '2' }, 'json', '5.0')).not.toBe(tag);
  });
});

describe('with Express', () => {
  let server;
  let base;
  let serialised = 0;
  const stored = { resourceType: 'CodeSystem', url: 'http://example.org/cs', version: '1' };

  beforeAll(async () => {
    const app = express();
    app.set('etag', boundedWeakETag(100));
    app.get('/small', (req, res) => res.send('small body'));
    app.get('/large', (req, res) => res.send('x'.repeat(200)));
    // as the tx module does for a stored resource: its ETag, and a 304 before serialising
    app.get('/stored', (req, res) => {
      res.setHeader('ETag', storedResourceETag(stored, 'json', '5.0'));
      if (req.fresh) {
        return res.status(304).end();
      }
      serialised++;
      return res.send(JSON.stringify(stored) + ' '.repeat(200)); // large: Express would make none
    });
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  // plain http: fetch adds Cache-Control: no-cache to a conditional request, and a server
  // rightly answers that in full
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    http.get(base + path, { headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: { get: (name) => res.headers[name.toLowerCase()] ?? null } }));
    }).on('error', reject);
  });

  test('a small body gets an ETag, and a 304 when the client has it', async () => {
    const first = await get('/small');
    const tag = first.headers.get('etag');
    expect(tag).toMatch(/^W\//);
    expect((await get('/small', { 'If-None-Match': tag })).status).toBe(304);
  });

  test('a large body gets none', async () => {
    expect((await get('/large')).headers.get('etag')).toBeNull();
  });

  test('a stored resource keeps its own ETag whatever its size, and a 304 does not serialise it', async () => {
    const first = await get('/stored');
    const tag = first.headers.get('etag');
    expect(tag).toBe(storedResourceETag(stored, 'json', '5.0'));
    const before = serialised;
    const again = await get('/stored', { 'If-None-Match': tag });
    expect(again.status).toBe(304);
    expect(serialised).toBe(before);
  });
});
