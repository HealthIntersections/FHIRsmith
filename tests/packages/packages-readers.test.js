// The packages module reads through a pool of connections (openReaders), so requests don't queue
// behind each other, or behind the crawler's writes, on the one connection

const fs = require('fs');
const os = require('os');
const path = require('path');
const PackagesModule = require('../../packages/packages');
const { tgz } = require('./npm-registry-checks');

function tarball(id, version) {
  return tgz({
    'package/package.json': JSON.stringify({
      name: id, version, type: 'fhir.ig', canonical: `http://example.org/fhir/${id}`,
      fhirVersions: ['4.0.1'], dependencies: {}, description: `Test package ${id}`, license: 'CC0-1.0'
    }),
    'package/.index.json': JSON.stringify({ 'index-version': 2, files: [] })
  });
}

async function start(tmp, extra = {}) {
  const module = new PackagesModule({ countRequest() {} });
  await module.initialize({
    database: path.join(tmp, 'packages.db'),
    mirrorPath: path.join(tmp, 'mirror'),
    masterUrl: 'http://127.0.0.1:1/unused',
    crawler: { enabled: false },
    npmSigning: { enabled: false },
    ...extra
  });
  module.crawler.log = { info() {}, warn() {}, error() {} };
  return module;
}

describe('packages: read connections', () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'packages-readers-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('requests read through 4 connections by default; what the crawler writes, they see', async () => {
    const module = await start(tmp);
    try {
      expect(module.readers).not.toBeNull();
      expect(module.readers.size).toBe(4);
      expect(module.reader).toBe(module.readers);

      const link = 'http://example.org/feed/example.fhir.readers-1.0.0.tgz';
      await module.crawler.store('test-feed', link, link, new Date('2025-01-01T00:00:00Z'),
        tarball('example.fhir.readers', '1.0.0'), 'example.fhir.readers#1.0.0', {});

      // several at once, spread over the connections
      const reads = await Promise.all(Array.from({ length: 8 }, () => module.getPackageVersions('example.fhir.readers')));
      for (const rows of reads) {
        expect(rows.map(r => r.Version)).toEqual(['1.0.0']);
      }
      const found = await module.findPackageVersion('example.fhir.readers', '1.0.0', true);
      expect(found).not.toBeNull();
      expect(Buffer.isBuffer(found.Content)).toBe(true);
    } finally {
      await module.shutdown();
    }
    expect(module.readers).toBeNull();
  });

  test('readConnections sets how many; 0 reads through the one connection', async () => {
    let module = await start(tmp, { readConnections: 2 });
    try {
      expect(module.readers.size).toBe(2);
    } finally {
      await module.shutdown();
    }
    module = await start(tmp, { readConnections: 0 });
    try {
      expect(module.readers).toBeNull();
      expect(module.reader).toBe(module.db);
      expect(await module.getPackageVersions('nothing.here')).toEqual([]);
    } finally {
      await module.shutdown();
    }
  });
});

describe('packages: a download redirected to the bucket', () => {
  test('does not read the tarball out of the database, and is counted', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'packages-bucket-'));
    const module = await start(tmp, { bucketPath: 'https://bucket.example.org/packages' });
    try {
      const link = 'http://example.org/feed/example.fhir.bucket-1.0.0.tgz';
      await module.crawler.store('test-feed', link, link, new Date('2025-01-01T00:00:00Z'),
        tarball('example.fhir.bucket', '1.0.0'), 'example.fhir.bucket#1.0.0', {});
      const asked = [];
      const find = module.findPackageVersion.bind(module);
      module.findPackageVersion = (...args) => {
        asked.push(args[3]);
        return find(...args);
      };
      const res = { redirect: jest.fn(), status: jest.fn(), setHeader: jest.fn(), send: jest.fn(), json: jest.fn() };
      await module.serveDownload(true, 'example.fhir.bucket', '1.0.0', res);
      expect(res.redirect).toHaveBeenCalledWith('https://bucket.example.org/packages/example.fhir.bucket-1.0.0.tgz');
      expect(asked).toEqual([false]);
      expect(await find('example.fhir.bucket', '1.0.0', true, false)).not.toHaveProperty('Content');
      // and it is counted, as a download sent from here is
      await module.flushDownloadCounts(); // counted in memory, and written every 30 s
      const counts = await module.dbGet(`SELECT v.DownloadCount AS v, p.DownloadCount AS p FROM PackageVersions v, Packages p
        WHERE v.Id = p.Id AND v.Id = 'example.fhir.bucket' AND v.Version = '1.0.0'`);
      expect(counts).toEqual({ v: 1, p: 1 });
    } finally {
      await module.shutdown();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('packages: download counts', () => {
  test('are counted in memory, written together, and written at shutdown', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'packages-counts-'));
    const module = await start(tmp, { bucketPath: 'https://bucket.example.org/packages' });
    let stopped = false;
    try {
      const link = 'http://example.org/feed/example.fhir.counted-1.0.0.tgz';
      await module.crawler.store('test-feed', link, link, new Date('2025-01-01T00:00:00Z'),
        tarball('example.fhir.counted', '1.0.0'), 'example.fhir.counted#1.0.0', {});
      const res = () => ({ redirect: jest.fn(), status: jest.fn(), setHeader: jest.fn(), send: jest.fn(), json: jest.fn() });
      await Promise.all([1, 2, 3].map(() => module.serveDownload(true, 'example.fhir.counted', '1.0.0', res())));
      const read = () => module.dbGet(`SELECT v.DownloadCount AS v, p.DownloadCount AS p FROM PackageVersions v, Packages p
        WHERE v.Id = p.Id AND v.Id = 'example.fhir.counted' AND v.Version = '1.0.0'`);
      // nothing written yet: they are written every 30 s, through a connection of their own
      expect(await read()).toEqual({ v: 0, p: 0 });
      expect(module.countsDb).not.toBeNull();
      expect(module.countsDb).not.toBe(module.db);
      await module.flushDownloadCounts();
      expect(await read()).toEqual({ v: 3, p: 3 });
      expect(module.pendingDownloads.size).toBe(0);
      // and what is counted after that is written as the module stops
      await module.serveDownload(true, 'example.fhir.counted', '1.0.0', res());
      await module.shutdown();
      stopped = true;
      const check = await start(tmp, { bucketPath: 'https://bucket.example.org/packages' });
      try {
        const after = await check.dbGet(`SELECT DownloadCount AS v FROM PackageVersions WHERE Id = 'example.fhir.counted'`);
        expect(after).toEqual({ v: 4 });
      } finally {
        await check.shutdown();
      }
    } finally {
      if (!stopped) {
        await module.shutdown();
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
