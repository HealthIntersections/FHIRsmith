// /npm-check reads a tarball's package.json and works out its digests without holding the event
// loop: the package.json from a streaming gunzip that stops once it's found, the digests in slices

const crypto = require('crypto');
const zlib = require('zlib');
const { readPackageJson, digestsOf } = require('../../packages/npm-check');
const { tgz } = require('./npm-registry-checks');

describe('npm-check: unpacking and hashing a tarball', () => {
  test('finds package/package.json, wherever it is in the tarball', async () => {
    const pkg = JSON.stringify({ name: 'example.fhir', version: '1.0.0' });
    const found = await readPackageJson(tgz({ 'package/other/big.json': Buffer.alloc(3 * 1024 * 1024, 'x'), 'package/package.json': pkg }));
    expect(found.data.toString('utf8')).toBe(pkg);
  });

  test('says when there is none, and when the tarball is not gzip', async () => {
    expect(await readPackageJson(tgz({ 'package/x.json': '{}' }))).toEqual({ data: null });
    const bad = await readPackageJson(Buffer.from('this is not gzip at all'));
    expect(bad.error.message).toMatch(/header/);
  });

  test('a long name (a GNU L entry) is followed', async () => {
    // a tar of an L entry naming package/package.json, then the file under a short name
    const block = (name, type, data) => {
      const header = Buffer.alloc(512);
      header.write(name, 0, 100, 'utf8');
      header.write('0000644\0', 100, 8, 'ascii');
      header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
      header.write(type, 156, 1, 'ascii');
      header.write('ustar\0', 257, 6, 'ascii');
      return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
    };
    const body = Buffer.from('{"name":"long"}');
    const tar = Buffer.concat([block('././@LongLink', 'L', Buffer.from('package/package.json\0')), block('short', '0', body), Buffer.alloc(1024)]);
    expect((await readPackageJson(zlib.gzipSync(tar))).data.toString('utf8')).toBe('{"name":"long"}');
  });

  test('digests in slices are the same as in one go', async () => {
    const buf = crypto.randomBytes(9 * 1024 * 1024 + 17);
    const d = await digestsOf(buf, ['sha1', 'sha512', 'sha1', 'nonesuch']);
    expect(d.get('sha1')).toEqual(crypto.createHash('sha1').update(buf).digest());
    expect(d.get('sha512')).toEqual(crypto.createHash('sha512').update(buf).digest());
    expect(d.get('nonesuch').message).toMatch(/not supported/i);
  });
});
