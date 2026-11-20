// ETags (library/etags.js): the tx module's for stored resources, and none from Express

const http = require('http');
const express = require('express');
const { storedResourceETag, SERVER_VERSION } = require('../../library/etags');

describe('storedResourceETag', () => {
  const cs = { resourceType: 'CodeSystem', id: 'cs', url: 'http://example.org/cs', version: '1' };

  test('from a package: the package and the resource, with no hashing', () => {
    const tag = storedResourceETag(cs, 'json', '5.0', { sourcePackage: 'hl7.terminology#7.0.0' });
    expect(tag).toBe(`W/"hl7.terminology#7.0.0/CodeSystem/cs~json~5.0~${SERVER_VERSION}"`);
    // the content isn't looked at: the package fixes it
    expect(storedResourceETag({ ...cs, version: '2' }, 'json', '5.0', { sourcePackage: 'hl7.terminology#7.0.0' })).toBe(tag);
    expect(storedResourceETag(cs, 'json', '5.0', { sourcePackage: 'hl7.terminology#7.0.1' })).not.toBe(tag);
  });

  test('different for each format and FHIR version', () => {
    const source = { sourcePackage: 'p#1.0.0' };
    const tag = storedResourceETag(cs, 'json', '5.0', source);
    expect(storedResourceETag(cs, 'xml', '5.0', source)).not.toBe(tag);
    expect(storedResourceETag(cs, 'json', '4.0', source)).not.toBe(tag);
  });

  test('a hash its store keeps, when it has one and no package', () => {
    expect(storedResourceETag(cs, 'json', '5.0', { sourcePackage: 'VSAC', contentHash: 'abc123' }))
      .toBe(`W/"abc123~json~5.0~${SERVER_VERSION}"`);
  });

  test('a folder or file the server loaded: a hash of the content, since it can change between runs', () => {
    for (const sourcePackage of ['folder.local#0.0.0', 'file.extra#0.0.0', null]) {
      const tag = storedResourceETag(cs, 'json', '5.0', { sourcePackage });
      expect(tag).toMatch(new RegExp(`^W/"[A-Za-z0-9_-]{27}~json~5\\.0~${SERVER_VERSION.replace(/\./g, '\\.')}"$`));
      expect(storedResourceETag({ ...cs }, 'json', '5.0', { sourcePackage })).toBe(tag);
      expect(storedResourceETag({ ...cs, version: '2' }, 'json', '5.0', { sourcePackage })).not.toBe(tag);
    }
  });

  test('nothing an ETag may not hold', () => {
    const odd = { resourceType: 'ValueSet', id: 'a b"c' };
    expect(storedResourceETag(odd, 'json', '5.0', { sourcePackage: 'p#1.0.0' })).toMatch(/^W\/"[\x21\x23-\x7e]+"$/);
  });
});

describe('with Express', () => {
  let server;
  let base;
  let serialised = 0;
  const stored = { resourceType: 'CodeSystem', id: 'cs', url: 'http://example.org/cs', version: '1' };

  beforeAll(async () => {
    const app = express();
    app.set('etag', false); // as server.js
    app.get('/other', (req, res) => res.send('an operation or a search'));
    // as the tx module does for a stored resource: its ETag, and a 304 before serialising
    app.get('/stored', (req, res) => {
      res.setHeader('ETag', storedResourceETag(stored, 'json', '5.0', { sourcePackage: 'p#1.0.0' }));
      if (req.fresh) {
        return res.status(304).end();
      }
      serialised++;
      return res.send(JSON.stringify(stored));
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

  test('anything else gets no ETag', async () => {
    expect((await get('/other')).headers.get('etag')).toBeNull();
  });

  test('a stored resource gets its ETag, and a 304 does not serialise it', async () => {
    const first = await get('/stored');
    const tag = first.headers.get('etag');
    expect(tag).toBe(storedResourceETag(stored, 'json', '5.0', { sourcePackage: 'p#1.0.0' }));
    const before = serialised;
    const again = await get('/stored', { 'If-None-Match': tag });
    expect(again.status).toBe(304);
    expect(serialised).toBe(before);
  });
});
