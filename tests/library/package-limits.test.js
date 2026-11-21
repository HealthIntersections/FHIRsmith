// The limit on what a package may unzip to (library/package-limits.js), wherever FHIRsmith
// unpacks one: the package manager, the npm registry check, and the crawler's default. The
// limit is made 1 MB here, so a 3 MB file is enough to pass it

jest.mock('../../library/package-limits', () => ({ MAX_UNPACKED_MB: 1, MAX_UNPACKED_BYTES: 1024 * 1024 }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PackageManager } = require('../../library/package-manager');
const { readPackageJson } = require('../../packages/npm-check');
const PackageCrawler = require('../../packages/package-crawler');
const { tgz } = require('../packages/npm-registry-checks');

const pj = JSON.stringify({ name: 'ex.limits', version: '1.0.0' });
const big = Buffer.alloc(3 * 1024 * 1024, ' ');

describe('the unpacked size limit', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'package-limits-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the package manager extracts a package under the limit', async () => {
    const pm = new PackageManager(['http://127.0.0.1:1'], tmp);
    expect(await pm.extractToCache('ex.limits', '1.0.0', tgz({ 'package/package.json': pj }))).toBe('ex.limits#1.0.0');
    expect(await pm.checkCache('ex.limits', '1.0.0')).toBe('ex.limits#1.0.0');
    expect(fs.readdirSync(tmp)).toEqual(['ex.limits#1.0.0']);
    // again, over what's there (as after a fetch at the same time)
    expect(await pm.extractToCache('ex.limits', '1.0.0', tgz({ 'package/package.json': pj }))).toBe('ex.limits#1.0.0');
    expect(fs.readdirSync(tmp)).toEqual(['ex.limits#1.0.0']);
  });

  test('the package manager replaces an empty folder an earlier failure left', async () => {
    const pm = new PackageManager(['http://127.0.0.1:1'], tmp);
    fs.mkdirSync(path.join(tmp, 'ex.limits#1.0.0'));
    expect(await pm.extractToCache('ex.limits', '1.0.0', tgz({ 'package/package.json': pj }))).toBe('ex.limits#1.0.0');
    expect(await pm.checkCache('ex.limits', '1.0.0')).toBe('ex.limits#1.0.0');
  });

  test('the package manager refuses a package over the limit, and leaves nothing in the cache', async () => {
    const pm = new PackageManager(['http://127.0.0.1:1'], tmp);
    // package.json comes first, so it is extracted before the limit is reached
    await expect(pm.extractToCache('ex.limits', '1.0.0', tgz({ 'package/package.json': pj, 'package/big.bin': big })))
      .rejects.toThrow(/unzips to more than the limit of 1 MB/);
    expect(await pm.checkCache('ex.limits', '1.0.0')).toBeNull();
    // nothing left behind, even once anything the extractor was still writing has finished
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  test('the npm check stops at the limit', async () => {
    const found = await readPackageJson(tgz({ 'package/big.bin': big, 'package/package.json': pj }));
    expect(found.error.message).toMatch(/unzips to more than the limit of 1 MB/);
    // the whole tarball is read (for duplicate names), so where package.json is makes no difference
    expect((await readPackageJson(tgz({ 'package/package.json': pj, 'package/big.bin': big }))).error.message).toMatch(/limit of 1 MB/);
  });

  test('the crawler uses it as its default maxUnpackedMB', async () => {
    const c = Object.create(PackageCrawler.prototype);
    c.config = {};
    await expect(c.unpackPackage(tgz({ 'package/package.json': pj, 'package/big.bin': big })))
      .rejects.toThrow(/limit of 1 MB \(maxUnpackedMB\)/);
  });
});
