// The limits on what a package can make the crawler download, unpack and hold in memory
// (crawlerLimits in packages/package-crawler.js), so that a decompression bomb, or a package
// that is simply too large, costs a bounded amount

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const PackageCrawler = require('../../packages/package-crawler');
const { tgz } = require('./npm-registry-checks');

const MB = 1024 * 1024;

function crawler(limits = {}, extra = {}) {
  const c = Object.create(PackageCrawler.prototype);
  c.config = { crawler: limits, ...extra };
  c.log = { info() {}, warn: jest.fn(), error() {} };
  c.totalBytes = 0;
  return c;
}

const packageJson = (extra = {}) => JSON.stringify({ name: 'ex.a', version: '1.0.0', canonical: 'http://example.org/fhir/a', fhirVersions: ['4.0.1'], ...extra });

// A tar header for a file of the given size
function header(name, size) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8, 'ascii');
  h.write('0000000\0', 108, 8, 'ascii');
  h.write('0000000\0', 116, 8, 'ascii');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii');
  h.write('0', 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.fill(' ', 148, 156);
  let sum = 0;
  for (const b of h) {
    sum += b;
  }
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

// A package whose package.json is followed by a file of mb MB of spaces: a decompression
// bomb that is about 1 KB per MB. Built from repeated gzip members (which gunzip joins up),
// so the test doesn't need the memory it is checking the crawler doesn't use
function bomb(name, mb) {
  const pj = Buffer.from(packageJson());
  const start = Buffer.concat([header('package/package.json', pj.length), pj, Buffer.alloc((512 - pj.length % 512) % 512), header(`package/${name}`, mb * MB)]);
  const member = zlib.gzipSync(Buffer.alloc(MB, ' '));
  return Buffer.concat([zlib.gzipSync(start), ...Array(mb).fill(member), zlib.gzipSync(Buffer.alloc(1024))]);
}

// Unpacks a package in a child process, and reports the most memory it was holding: each
// reading is taken just after a garbage collection, so it counts what is in use, not
// garbage waiting to be collected (which depends on the machine). The last reading is taken
// with the result still held.
function unpackAndMeasure(pkg, crawlerPath = require.resolve('../../packages/package-crawler')) {
  const { spawn } = require('child_process');
  const code = `
    const PackageCrawler = require(${JSON.stringify(crawlerPath)});
    const chunks = [];
    process.stdin.on('data', d => chunks.push(d));
    process.stdin.on('end', async () => {
      const pkg = Buffer.concat(chunks);
      chunks.length = 0;
      const used = () => { global.gc(); const m = process.memoryUsage(); return m.heapUsed + m.external + m.arrayBuffers; };
      const base = used() - pkg.length;
      let peak = 0;
      // every 20 ms: each reading is a full garbage collection, and at 2 ms they took up the
      // whole process, so unpacking that takes a quarter of a second took minutes on a busy
      // CI runner. Unpacking still spans a dozen readings, and holding the package (the bug
      // this checks for) shows up in every one of them
      const timer = setInterval(() => { peak = Math.max(peak, used() - base); }, 20);
      const c = Object.create(PackageCrawler.prototype);
      c.config = {};
      c.log = { info() {}, warn() {}, error() {} };
      try {
        const result = await c.extractNpmPackage(pkg, 'test');
        clearInterval(timer);
        peak = Math.max(peak, used() - base);
        process.stdout.write(JSON.stringify({ id: result.id, peak }));
      } catch (e) {
        process.stdout.write(JSON.stringify({ error: e.message }));
      }
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--expose-gc', '-e', code], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`no result from the child process: ${out}`));
      }
    });
    child.stdin.end(pkg);
  });
}

describe('crawler limits: unpacking', () => {
  test('a package is read as before: its metadata, file names and resource urls', async () => {
    const pkg = await crawler().extractNpmPackage(tgz({
      'package/package.json': packageJson(),
      'package/.index.json': JSON.stringify({ 'index-version': 2, files: [] }),
      'package/ig.ini': '[IG]\ncanonical = http://example.org/ig\n',
      'package/ValueSet-x.json': JSON.stringify({ resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/x' }),
      'package/other/notes.json': '{"a": 1}',
      'package/broken.json': '{',
      'package/README.md': '# x'
    }), 'test');
    expect(pkg).toEqual(expect.objectContaining({ id: 'ex.a', version: '1.0.0', canonical: 'http://example.org/fhir/a', hasJavaScript: false }));
    expect(pkg.fileNames.sort()).toEqual(['.index.json', 'README.md', 'ValueSet-x.json', 'broken.json', 'ig.ini', 'other/notes.json', 'package.json']);
    expect(pkg.resourceUrls).toEqual(['http://example.org/fhir/ValueSet/x']);
    expect(crawler().processPackageUrls({ ...pkg, url: 'http://example.org/home' })).toEqual(['http://example.org/fhir/ValueSet/x', 'http://example.org/home']);
  });

  test('a package that unzips to more than maxUnpackedMB is refused', async () => {
    await expect(crawler({ maxUnpackedMB: 5 }).extractNpmPackage(bomb('content.bin', 20), 'test'))
      .rejects.toThrow(/unzips to more than the limit of 5 MB \(maxUnpackedMB\)/);
  });

  test('a package.json larger than maxFileMB is refused', async () => {
    await expect(crawler({ maxFileMB: 2 }).extractNpmPackage(bomb('package.json', 3), 'test'))
      .rejects.toThrow(/package.json is 3 MB, more than the limit of 2 MB \(maxFileMB\)/);
  });

  test('a .index.json, ig.ini or other .json file larger than maxFileMB is not read, and that is reported', async () => {
    for (const name of ['.index.json', 'ig.ini', 'CodeSystem-big.json']) {
      const c = crawler({ maxFileMB: 2 });
      const pkg = await c.extractNpmPackage(bomb(name, 3), 'test');
      expect(pkg.id).toBe('ex.a');
      expect(pkg.fileNames).toContain(name);
      if (name.endsWith('.json')) {
        expect(c.log.warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`1 file\\(s\\) are more than the limit of 2 MB \\(maxFileMB\\).*${name.replace('.', '\\.')}`)));
      }
    }
  });

  test('a package with more than maxFiles files is refused', async () => {
    const files = { 'package/package.json': packageJson() };
    for (let i = 0; i < 20; i++) {
      files[`package/f${i}.txt`] = 'x';
    }
    await expect(crawler({ maxFiles: 10 }).extractNpmPackage(tgz(files), 'test')).rejects.toThrow(/more than 10 files \(maxFiles\)/);
    await expect(crawler({ maxFiles: 30 }).extractNpmPackage(tgz(files), 'test')).resolves.toBeTruthy();
  });

  test('unpacking a large package doesn\'t hold it in memory', async () => {
    // 300 MB of .json, of which at most maxFileMB (50 MB) is ever held. The old code held it
    // all, twice (the unzipped tar, and every file as a string)
    const result = await unpackAndMeasure(bomb('huge.json', 300));
    expect(result.id).toBe('ex.a');
    expect(result.peak).toBeLessThan(100 * MB);
  }, 60000);

  test('a file that is not a tar once unzipped is reported', async () => {
    await expect(crawler().extractNpmPackage(zlib.gzipSync(Buffer.from('not a tar file '.repeat(100))), 'test'))
      .rejects.toThrow(/not a tar file|package.json not found/);
  });

  test('a corrupt gzip is reported', async () => {
    const good = tgz({ 'package/package.json': packageJson() });
    const corrupt = Buffer.concat([good.subarray(0, 20), Buffer.alloc(100, 7)]);
    await expect(crawler().extractNpmPackage(corrupt, 'test')).rejects.toThrow(/could not unzip the package/);
  });
});

describe('crawler limits: downloading', () => {
  test('a Content-Encoding that undoes to more than maxDownloadMB is refused', () => {
    const big = Buffer.alloc(3 * MB, 1);
    const c = crawler({ maxDownloadMB: 2 });
    // a .tgz compressed again for transfer, whose .tgz is too large
    const bigTgz = zlib.gzipSync(crypto.randomBytes(3 * MB));
    for (const [enc, body] of [['gzip', zlib.gzipSync(bigTgz)], ['br', zlib.brotliCompressSync(big)], ['deflate', zlib.deflateSync(big)]]) {
      expect(() => c.decodePackageBody(body, enc)).toThrow(/more than the limit of 2 MB \(maxDownloadMB\) once its Content-Encoding is undone/);
    }
  });

  test('a large .tgz labelled Content-Encoding: gzip is taken as is, however large its tar', () => {
    const tar = Buffer.concat([header('package/package.json', 3 * MB), Buffer.alloc(3 * MB, ' ')]);
    const pkg = zlib.gzipSync(tar);
    expect(crawler({ maxDownloadMB: 2 }).decodePackageBody(pkg, 'gzip')).toBe(pkg);
  });

  test('a local package file larger than maxDownloadMB is refused', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-limits-'));
    try {
      const file = path.join(dir, 'big.tgz');
      fs.writeFileSync(file, Buffer.alloc(3 * MB));
      const c = crawler({ maxDownloadMB: 2 }, { localFeedDirs: dir });
      await expect(c.fetchUrl(file)).rejects.toThrow(/the package is 3 MB, more than the limit of 2 MB \(maxDownloadMB\)/);
      fs.writeFileSync(file, Buffer.alloc(MB));
      await expect(c.fetchUrl(file)).resolves.toHaveLength(MB);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a download larger than maxDownloadMB is refused', async () => {
    const http = require('http');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/gzip' });
      res.end(Buffer.alloc(3 * MB));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      const c = crawler({ maxDownloadMB: 2 }, { allowPrivateAddresses: true });
      await expect(c.fetchUrl(`http://127.0.0.1:${server.address().port}/big.tgz`))
        .rejects.toThrow(/the package is more than the limit of 2 MB \(maxDownloadMB\)/);
    } finally {
      await new Promise(r => server.close(r));
    }
  });
});
