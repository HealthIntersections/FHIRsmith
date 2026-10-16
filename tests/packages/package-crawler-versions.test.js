// Each id#version is stored once: how the crawler treats a second copy of a version
// (PackageCrawler.checkVersion), the mirror only being written for stored packages, and
// packages/utilities/dedupe-versions.js, which repairs databases built before that.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const PackagesModule = require('../../packages/packages');
const { dedupe, isSimplifier, fixPrefix } = require('../../packages/utilities/dedupe-versions');
const PackageCrawler = require('../../packages/package-crawler');
const { tgz } = require('./npm-registry-checks');

const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');

// A package tarball; build distinguishes copies of the same id#version
function tarball(id, version, build = 'a', extra = {}) {
  return tgz({
    'package/package.json': JSON.stringify({
      name: id, version, type: 'fhir.ig', canonical: `http://example.org/fhir/${id}`,
      fhirVersions: ['4.0.1'], description: `${id} build ${build}`, license: 'CC0-1.0', ...extra
    })
  });
}

const direct = (id, version, n = '') => `https://example.org/fhir/${id}/${version}${n}/package.tgz`;
const simplifier = (id, version) => `https://packages.simplifier.net/${id}/${version}`;

async function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crawler-versions-'));
  const module = new PackagesModule({ countRequest() {} });
  await module.initialize({
    database: path.join(tmp, 'packages.db'),
    mirrorPath: path.join(tmp, 'mirror'),
    masterUrl: 'http://127.0.0.1:1/unused',
    crawler: { enabled: false }
  });
  const crawler = module.crawler;
  crawler.log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  crawler.served = {};
  crawler.fetchUrl = jest.fn(async url => {
    if (!crawler.served[url]) {
      throw new Error(`no fixture for ${url}`);
    }
    return crawler.served[url];
  });
  const all = sql => new Promise((resolve, reject) => module.db.all(sql, (e, r) => e ? reject(e) : resolve(r)));
  return { tmp, module, crawler, all };
}

// Runs one feed item through the crawler, serving buf at its link
async function feedItem(crawler, title, link, buf, pubDate = 'Mon, 01 Jun 2026 00:00:00 GMT') {
  crawler.served[link] = buf;
  crawler.packages.clear(); // each item as if in its own crawl
  const feedLog = { items: [] };
  await crawler.updateItem('https://example.org/feed.xml', { guid: { '#text': link }, title, link, pubDate }, 0, [], feedLog);
  return feedLog.items[0];
}

describe('crawler: one copy of each id#version', () => {
  let env;

  beforeEach(async () => {
    env = await setup();
  });

  afterEach(async () => {
    await env.module.shutdown();
    fs.rmSync(env.tmp, { recursive: true, force: true });
  });

  const rows = (id) => env.all(`SELECT PackageVersionKey, Version, GUID, Hash FROM PackageVersions WHERE Id = '${id}' ORDER BY Version`);
  const mirror = (id, version) => fs.readFileSync(path.join(env.tmp, 'mirror', `${id}-${version}.tgz`));

  test('a Simplifier echo of a version held directly is not fetched', async () => {
    const buf = tarball('ex.a', '1.0.0');
    expect((await feedItem(env.crawler, 'ex.a#1.0.0', direct('ex.a', '1.0.0'), buf)).status).toBe('Fetched');
    const item = await feedItem(env.crawler, 'ex.a#1.0.0', simplifier('ex.a', '1.0.0'), tarball('ex.a', '1.0.0', 'b'));
    expect(item.status).toBe('Already Stored');
    expect(env.crawler.fetchUrl).not.toHaveBeenCalledWith(simplifier('ex.a', '1.0.0'), expect.anything());
    expect(await rows('ex.a')).toEqual([expect.objectContaining({ GUID: direct('ex.a', '1.0.0'), Hash: sha1(buf) })]);
    expect(mirror('ex.a', '1.0.0')).toEqual(buf);
  });

  test('a direct copy replaces the Simplifier copy, in the database and the mirror', async () => {
    await feedItem(env.crawler, 'ex.b#1.0.0', simplifier('ex.b', '1.0.0'), tarball('ex.b', '1.0.0', 'simplifier'));
    const [before] = await rows('ex.b');
    const buf = tarball('ex.b', '1.0.0', 'direct');
    expect((await feedItem(env.crawler, 'ex.b#1.0.0', direct('ex.b', '1.0.0'), buf)).status).toBe('Replaced Simplifier copy');
    expect(await rows('ex.b')).toEqual([{ PackageVersionKey: before.PackageVersionKey, Version: '1.0.0', GUID: direct('ex.b', '1.0.0'), Hash: sha1(buf) }]);
    expect(mirror('ex.b', '1.0.0')).toEqual(buf);
    const [pkg] = await env.all("SELECT CurrentVersion FROM Packages WHERE Id = 'ex.b'");
    expect(pkg.CurrentVersion).toBe(before.PackageVersionKey);
  });

  test('a second direct copy from another GUID is an error, and ignored', async () => {
    const buf = tarball('ex.c', '1.0.0', 'first');
    await feedItem(env.crawler, 'ex.c#1.0.0', direct('ex.c', '1.0.0'), buf);
    const item = await feedItem(env.crawler, 'ex.c#1.0.0', direct('ex.c', '1.0.0', '-again'), tarball('ex.c', '1.0.0', 'second'));
    expect(item.status).toBe('error');
    expect(item.error).toMatch(/already stored from/);
    expect(env.crawler.log.error).toHaveBeenCalledWith(expect.stringContaining('ex.c#1.0.0'));
    expect(await rows('ex.c')).toEqual([expect.objectContaining({ GUID: direct('ex.c', '1.0.0'), Hash: sha1(buf) })]);
    expect(mirror('ex.c', '1.0.0')).toEqual(buf);
  });

  test('the tarball\'s own id#version is checked, not just the feed title', async () => {
    const buf = tarball('ex.d', '1.0.0', 'first');
    await feedItem(env.crawler, 'ex.d#1.0.0', direct('ex.d', '1.0.0'), buf);
    // the feed says 1.0.1, but the tarball is 1.0.0 again
    const item = await feedItem(env.crawler, 'ex.d#1.0.1', direct('ex.d', '1.0.1'), tarball('ex.d', '1.0.0', 'mislabelled'));
    expect(item.status).toBe('Exception');
    expect(await rows('ex.d')).toHaveLength(1);
    expect(mirror('ex.d', '1.0.0')).toEqual(buf);
  });

  test('a tarball that fails validation does not touch the mirror', async () => {
    const buf = tarball('ex.e', '1.0.0', 'simplifier');
    await feedItem(env.crawler, 'ex.e#1.0.0', simplifier('ex.e', '1.0.0'), buf);
    // a direct copy would replace it, but this one is a draft build
    const item = await feedItem(env.crawler, 'ex.e#1.0.0', direct('ex.e', '1.0.0'), tarball('ex.e', '1.0.0', 'draft', { notForPublication: true }));
    expect(item.status).toBe('Exception');
    expect(mirror('ex.e', '1.0.0')).toEqual(buf);
    expect(await feedItem(env.crawler, 'ex.e#2.0.0', direct('ex.e', '2.0.0'), tarball('ex.e', '2.0.0', 'draft', { notForPublication: true })))
      .toEqual(expect.objectContaining({ status: 'Exception' }));
    expect(fs.existsSync(path.join(env.tmp, 'mirror', 'ex.e-2.0.0.tgz'))).toBe(false);
  });

  test('the database refuses a second row for an id#version', async () => {
    await feedItem(env.crawler, 'ex.f#1.0.0', direct('ex.f', '1.0.0'), tarball('ex.f', '1.0.0'));
    await expect(env.crawler.run(`INSERT INTO PackageVersions (GUID, PubDate, Indexed, Id, Version, Kind, DownloadCount, Canonical, FhirVersions, Hash, Author, License, HomePage, Content)
      SELECT 'other', PubDate, Indexed, Id, Version, Kind, 0, Canonical, FhirVersions, Hash, Author, License, HomePage, Content FROM PackageVersions WHERE Id = 'ex.f'`))
      .rejects.toThrow(/UNIQUE/);
  });
});

describe('dedupe-versions.js', () => {
  let env, dbPath, mirrorPath;

  // Stores a copy directly, bypassing the crawler's checks, as older crawlers did
  async function storeRaw(id, version, guid, buf, date) {
    const pkg = await env.crawler.extractNpmPackage(buf, guid);
    await env.crawler.commit(buf, pkg, new Date(date), guid, id, version, `http://example.org/fhir/${id}`, []);
    fs.writeFileSync(path.join(mirrorPath, `${id}-${version}.tgz`), buf);
  }

  const bufs = {
    simpOnly1: tarball('d.simp', '1.0.0', 's1'), simpOnly2: tarball('d.simp', '1.0.0', 's2'),
    direct: tarball('d.mixed', '1.0.0', 'direct'), simp: tarball('d.mixed', '1.0.0', 'simplifier'),
    same: tarball('d.same', '1.0.0'),
    conflict1: tarball('d.conflict', '1.0.0', 'one'), conflict2: tarball('d.conflict', '1.0.0', 'two'), conflictSimp: tarball('d.conflict', '1.0.0', 'simp'),
    single: tarball('d.single', '1.0.0'), stray: tarball('d.single', '1.0.0', 'stray')
  };

  async function build({ withConflict }) {
    env = await setup();
    dbPath = path.join(env.tmp, 'packages.db');
    mirrorPath = path.join(env.tmp, 'mirror');
    // node-sqlite3 runs statements in parallel, so this can meet the start-up PRAGMAs
    for (let i = 0; ; i++) {
      try {
        await env.crawler.run('DROP INDEX SK_PackageVersions_IdVersion');
        break;
      } catch (e) {
        if (i > 20 || !/LOCKED|BUSY/.test(e.message)) {
          throw e;
        }
        await new Promise(r => setTimeout(r, 50));
      }
    }
    await storeRaw('d.simp', '1.0.0', simplifier('d.simp', '1.0.0'), bufs.simpOnly1, '2024-01-01');
    await storeRaw('d.simp', '1.0.0', simplifier('d.simp', '1.0.0') + '/', bufs.simpOnly2, '2024-01-02');
    // the Simplifier copy stored last, so it is in the mirror
    await storeRaw('d.mixed', '1.0.0', direct('d.mixed', '1.0.0'), bufs.direct, '2024-01-01');
    await storeRaw('d.mixed', '1.0.0', simplifier('d.mixed', '1.0.0'), bufs.simp, '2024-01-02');
    await storeRaw('d.mixed', '0.9.0', direct('d.mixed', '0.9.0'), tarball('d.mixed', '0.9.0'), '2023-01-01');
    await storeRaw('d.same', '1.0.0', direct('d.same', '1.0.0'), bufs.same, '2024-01-01');
    await storeRaw('d.same', '1.0.0', direct('d.same', '1.0.0'), bufs.same, '2024-01-01');
    if (withConflict) {
      await storeRaw('d.conflict', '1.0.0', direct('d.conflict', '1.0.0'), bufs.conflict1, '2024-01-01');
      await storeRaw('d.conflict', '1.0.0', direct('d.conflict', '1.0.0', '-b'), bufs.conflict2, '2024-01-02');
      await storeRaw('d.conflict', '1.0.0', simplifier('d.conflict', '1.0.0'), bufs.conflictSimp, '2024-01-03');
    }
    // no duplicates, but a mirror file overwritten by a rejected tarball, and one missing
    await storeRaw('d.single', '1.0.0', direct('d.single', '1.0.0'), bufs.single, '2024-01-01');
    fs.writeFileSync(path.join(mirrorPath, 'd.single-1.0.0.tgz'), bufs.stray);
    fs.unlinkSync(path.join(mirrorPath, 'd.same-1.0.0.tgz'));
    await env.module.shutdown();
  }

  afterEach(() => {
    if (env) {
      fs.rmSync(env.tmp, { recursive: true, force: true });
      env = undefined;
    }
  });

  const query = sql => {
    const db = new Database(dbPath);
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  };
  const versions = () => query('SELECT Id, Version, GUID, Hash FROM PackageVersions ORDER BY Id, Version, PackageVersionKey');
  const mirror = (id, version) => fs.readFileSync(path.join(mirrorPath, `${id}-${version}.tgz`));

  test('its copies of the crawler\'s helpers match the crawler', () => {
    for (const guid of [simplifier('a', '1.0.0'), 'http://packages.simplifier.net/a/1', direct('a', '1.0.0'), 'https://simplifier.net/a', '', undefined]) {
      expect(isSimplifier(guid)).toBe(PackageCrawler.prototype.isSimplifierGuid(guid));
    }
    for (const id of ['hl7.fhir.r4.core', '@hl7/hl7.fhir.uv.tools', '@scope/name', '']) {
      expect(fixPrefix(id)).toBe(PackageCrawler.prototype.fixPrefix(id));
    }
  });

  test('a dry run reports and changes nothing', async () => {
    await build({ withConflict: true });
    const before = versions();
    const report = dedupe({ dbPath, mirrorPath, log() {} });
    expect(report.groups).toBe(4);
    expect(report.deleted).toHaveLength(4);
    expect(report.conflicts).toEqual([{ id: 'd.conflict', version: '1.0.0', kept: [direct('d.conflict', '1.0.0'), direct('d.conflict', '1.0.0', '-b')] }]);
    expect(report.mirror.rewritten.map(r => `${r.id}#${r.version}`).sort())
      .toEqual(['d.mixed#1.0.0', 'd.same#1.0.0', 'd.simp#1.0.0', 'd.single#1.0.0']);
    expect(versions()).toEqual(before);
    expect(mirror('d.single', '1.0.0')).toEqual(bufs.stray);
  });

  test('-apply keeps one row per id#version and repairs the mirror; a conflict is left alone', async () => {
    await build({ withConflict: true });
    const report = dedupe({ dbPath, mirrorPath, apply: true, log() {} });
    expect(versions()).toEqual([
      { Id: 'd.conflict', Version: '1.0.0', GUID: direct('d.conflict', '1.0.0'), Hash: sha1(bufs.conflict1) },
      { Id: 'd.conflict', Version: '1.0.0', GUID: direct('d.conflict', '1.0.0', '-b'), Hash: sha1(bufs.conflict2) },
      expect.objectContaining({ Id: 'd.mixed', Version: '0.9.0' }),
      { Id: 'd.mixed', Version: '1.0.0', GUID: direct('d.mixed', '1.0.0'), Hash: sha1(bufs.direct) },
      { Id: 'd.same', Version: '1.0.0', GUID: direct('d.same', '1.0.0'), Hash: sha1(bufs.same) },
      { Id: 'd.simp', Version: '1.0.0', GUID: simplifier('d.simp', '1.0.0'), Hash: sha1(bufs.simpOnly1) },
      { Id: 'd.single', Version: '1.0.0', GUID: direct('d.single', '1.0.0'), Hash: sha1(bufs.single) }
    ]);
    expect(report.indexCreated).toBe(false);
    expect(mirror('d.mixed', '1.0.0')).toEqual(bufs.direct);
    expect(mirror('d.same', '1.0.0')).toEqual(bufs.same);
    expect(mirror('d.simp', '1.0.0')).toEqual(bufs.simpOnly1);
    expect(mirror('d.single', '1.0.0')).toEqual(bufs.single);
    // every package's current version is a row that still exists
    expect(query(`SELECT p.Id FROM Packages p LEFT JOIN PackageVersions v ON v.PackageVersionKey = p.CurrentVersion WHERE v.PackageVersionKey IS NULL`)).toEqual([]);
    expect(query(`SELECT v.Version FROM Packages p JOIN PackageVersions v ON v.PackageVersionKey = p.CurrentVersion WHERE p.Id = 'd.mixed'`)).toEqual([{ Version: '1.0.0' }]);
    // nothing left pointing at deleted rows
    expect(query('SELECT COUNT(*) AS n FROM PackageFHIRVersions WHERE PackageVersionKey NOT IN (SELECT PackageVersionKey FROM PackageVersions)')).toEqual([{ n: 0 }]);
  });

  test('-keep settles a conflict: the chosen copy stays, its mirror file is written, and the index is created', async () => {
    await build({ withConflict: true });
    dedupe({ dbPath, mirrorPath, apply: true, log() {} });
    const logged = [];
    const report = dedupe({ dbPath, mirrorPath, apply: true, keep: [direct('d.conflict', '1.0.0', '-b'), 'http://nothing/here'], log: m => logged.push(m) });
    expect(report.conflicts).toEqual([]);
    expect(report.indexCreated).toBe(true);
    expect(versions().filter(v => v.Id === 'd.conflict')).toEqual([
      { Id: 'd.conflict', Version: '1.0.0', GUID: direct('d.conflict', '1.0.0', '-b'), Hash: sha1(bufs.conflict2) }
    ]);
    expect(mirror('d.conflict', '1.0.0')).toEqual(bufs.conflict2);
    expect(logged.join('\n')).toMatch(/-keep http:\/\/nothing\/here: not a copy of any duplicated id#version/);
  });

  test('with no conflicts left, -apply creates the unique index, and a second run finds nothing to do', async () => {
    await build({ withConflict: false });
    expect(dedupe({ dbPath, mirrorPath, apply: true, log() {} }).indexCreated).toBe(true);
    expect(query("SELECT name FROM sqlite_master WHERE name = 'SK_PackageVersions_IdVersion'")).toHaveLength(1);
    const again = dedupe({ dbPath, mirrorPath, apply: true, log() {} });
    expect(again.groups).toBe(0);
    expect(again.mirror.rewritten).toEqual([]);
    expect(again.mirror.ok).toBe(again.mirror.checked);
  });
});

describe('crawler: package downloads keep the file\'s own bytes', () => {
  const zlib = require('zlib');
  const decode = (body, enc) => PackageCrawler.prototype.decodePackageBody(body, enc);
  const pkg = tarball('ex.g', '1.0.0');

  test('a .tgz with no Content-Encoding is taken as is', () => {
    expect(decode(pkg, undefined)).toEqual(pkg);
    expect(decode(pkg, 'identity')).toEqual(pkg);
  });

  test('a .tgz labelled Content-Encoding: gzip or x-gzip (doc.mednet.swiss) is taken as is', () => {
    expect(decode(pkg, 'x-gzip')).toEqual(pkg);
    expect(decode(pkg, 'gzip')).toEqual(pkg);
  });

  test('a .tgz really compressed again for transfer is unwrapped once', () => {
    expect(decode(zlib.gzipSync(pkg), 'gzip')).toEqual(pkg);
    expect(decode(zlib.brotliCompressSync(pkg), 'br')).toEqual(pkg);
    expect(decode(zlib.deflateSync(pkg), 'deflate')).toEqual(pkg);
  });

  test('a package that isn\'t gzip is reported as such', async () => {
    const tar = zlib.gunzipSync(pkg);
    await expect(PackageCrawler.prototype.extractNpmPackage.call({ log: { warn() {} } }, tar, 'test'))
      .rejects.toThrow(/not a gzip file \(it starts with 7061636b6167652f/);
  });
});

// The SSRF guard on the crawler's (and /npm-check's) HTTP agents
describe('crawler: requests to non-public addresses are refused', () => {
  const http = require('http');
  const axios = require('axios');
  let server, port;

  beforeAll(async () => {
    server = http.createServer((req, res) => res.end('reached'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(() => new Promise(resolve => server.close(resolve)));

  const fetchVia = async (config, url, options) => {
    const crawler = Object.create(PackageCrawler.prototype);
    crawler.config = config;
    const agents = crawler.guardedAgents(options);
    try {
      return (await axios.get(url, { ...agents, timeout: 5000 })).data;
    } catch (e) {
      return e.message;
    }
  };

  test.each([
    ['an IP address, which Node connects to without a lookup', () => `http://127.0.0.1:${port}/`],
    ['an IPv6 address', () => `http://[::1]:${port}/`],
    ['an IP address in another notation', () => `http://2130706433:${port}/`],
    ['a name that resolves to a non-public address', () => `http://localhost:${port}/`]
  ])('%s', async (_, url) => {
    expect(await fetchVia({}, url())).toMatch(/Blocked request to non-public address/);
  });

  test.each([
    ['127.0.0.1', () => `http://127.0.0.1:${port}/`],
    ['localhost', () => `http://localhost:${port}/`],
    ['another notation', () => `http://2130706433:${port}/`]
  ])('allowLoopback (for /npm-check) lets loopback through: %s', async (_, url) => {
    expect(await fetchVia({}, url(), { allowLoopback: true })).toBe('reached');
  });

  test.each([
    ['http://169.254.169.254/'],
    ['http://10.1.2.3/'],
    ['http://[fd00::1]/']
  ])('allowLoopback still refuses other non-public addresses: %s', async (url) => {
    expect(await fetchVia({}, url, { allowLoopback: true })).toMatch(/Blocked request to non-public address/);
  });

  test('a redirect to a non-public address is refused too', async () => {
    const { makeGetter } = require('../../packages/npm-check');
    const redirector = http.createServer((req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    await new Promise(resolve => redirector.listen(0, '127.0.0.1', resolve));
    try {
      const crawler = Object.create(PackageCrawler.prototype);
      crawler.config = {};
      const get = makeGetter({ ...crawler.guardedAgents({ allowLoopback: true }), timeout: 5000 });
      const res = await get(`http://127.0.0.1:${redirector.address().port}/`);
      expect(res.error).toMatch(/Blocked request to non-public address 169\.254\.169\.254/);
    } finally {
      await new Promise(resolve => redirector.close(resolve));
    }
  });

  test('the npm check\'s HTTP client refuses to run without the guarded agents', () => {
    const { makeGetter } = require('../../packages/npm-check');
    expect(() => makeGetter()).toThrow(/SSRF-guarded/);
  });

  test('unless allowPrivateAddresses is set', async () => {
    expect(await fetchVia({ allowPrivateAddresses: true }, `http://127.0.0.1:${port}/`)).toBe('reached');
  });
});

describe('crawler: package versions must be whole semver', () => {
  const valid = v => PackageCrawler.prototype.isValidSemVersion(v);

  test.each(['1.0.0', '6.0.0-ballot3', '2.0.0-cibuild', '1.0.0-snapshot.1+build.5', '2027.0.0-ballot.rc1'])('%s is accepted', (v) => {
    expect(valid(v)).toBe(true);
  });

  test.each(['1.0.0/../../../tmp/x', '1.0.0 ', '1.0.0<script>', '1.0', '1.0.0-', 'current'])('%j is refused', (v) => {
    expect(valid(v)).toBe(false);
  });
});
