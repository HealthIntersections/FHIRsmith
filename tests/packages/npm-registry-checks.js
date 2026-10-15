// npm registry protocol checks, shared by the test suites that run them:
//
//   npm-registry.test.js        live registries: registry.npmjs.org (the control) and others
//   npm-registry-local.test.js  the packages module, started locally with known content
//
// There is no published conformance suite for the npm registry protocol, so this is our
// own. It walks the path an npm client takes: search for a package by name, read its
// package document, read one version's document, and download that version's tarball.
// At each step it checks the parts of the response that npm clients depend on.
//
// Every check here must pass against registry.npmjs.org. If one fails there, the check
// is wrong (or npm has changed its behaviour, which has happened before), not the registry.
//
// References:
//   https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md
//   https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md

const crypto = require('crypto');
const zlib = require('zlib');

// What the npm CLI sends when it fetches a package document
const NPM_ACCEPT = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';
const MISSING_PACKAGE = 'no-such-package-zz9-plural-z-alpha';
const SEARCH_SIZE = 20;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA1_HEX = /^[0-9a-f]{40}$/;
const SRI = /^(sha512|sha384|sha256|sha1)-[A-Za-z0-9+/]+=*$/;

async function get(url, accept = 'application/json') {
  const res = await fetch(url, { headers: { accept }, redirect: 'follow' });
  const body = Buffer.from(await res.arrayBuffer());
  return { url, status: res.status, contentType: res.headers.get('content-type') || '', body };
}

function json(res) {
  expect(res.contentType).toMatch(/^application\/(json|vnd\.npm\.install-v1\+json)\b/);
  return JSON.parse(res.body.toString('utf8'));
}

function isDate(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

function packageUrl(base, name, version) {
  // npm escapes the '/' of a scoped name; '@' is left alone
  const id = name.startsWith('@') ? name.replace('/', '%2f') : encodeURIComponent(name);
  return version ? `${base}/${id}/${encodeURIComponent(version)}` : `${base}/${id}`;
}

// Minimal ustar reader: returns { path: Buffer } for regular files
function untar(buf) {
  const files = {};
  let pos = 0;
  let longName = null;
  while (pos + 512 <= buf.length) {
    const header = buf.subarray(pos, pos + 512);
    if (header.every(b => b === 0)) {
      break;
    }
    const field = (off, len) => header.subarray(off, off + len).toString('utf8').replace(/\0.*$/s, '');
    let name = field(0, 100);
    const prefix = field(345, 155);
    if (prefix) {
      name = `${prefix}/${name}`;
    }
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    const data = buf.subarray(pos + 512, pos + 512 + size);
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/s, '');
    } else {
      if (longName) {
        name = longName;
        longName = null;
      }
      if (type === '0' || type === '') {
        files[name] = data;
      }
    }
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

// Minimal ustar writer: files is { path: string | Buffer }, returns a .tgz Buffer
function tgz(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.fill(' ', 148, 156);
    let sum = 0;
    for (const b of header) {
      sum += b;
    }
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

// Defines the checks for one registry. target is { name, base, pkg, version }; base may be
// filled in later (by a beforeAll in the enclosing describe), as long as it is set before
// these checks' own beforeAll runs.
function defineNpmRegistryChecks(target) {
  describe(`npm registry protocol: ${target.name}`, () => {
    // Each step's response, fetched once
    const r = {};
    let base, pkg, version;

    beforeAll(async () => {
      ({ base, pkg, version } = target);
      const search = (extra = '') => get(`${base}/-/v1/search?text=${encodeURIComponent(pkg)}${extra}`);
      [r.search, r.searchSize1, r.searchFrom1, r.packument, r.fullPackument, r.versionDoc, r.latestDoc, r.missing, r.missingVersion] = await Promise.all([
        search(`&size=${SEARCH_SIZE}`),
        search('&size=1'),
        search(`&size=${SEARCH_SIZE}&from=1`),
        get(packageUrl(base, pkg), NPM_ACCEPT),
        get(packageUrl(base, pkg), 'application/json'),
        get(packageUrl(base, pkg, version)),
        get(packageUrl(base, pkg, 'latest')),
        get(packageUrl(base, MISSING_PACKAGE)),
        get(packageUrl(base, pkg, '99999.0.0'))
      ]);
      if (r.packument.status === 200) {
        const doc = JSON.parse(r.packument.body.toString('utf8'));
        const tarball = doc.versions?.[version]?.dist?.tarball;
        if (tarball) {
          r.tarball = await get(tarball, '*/*');
        }
      }
    }, 120000);

    describe('1. search: GET /-/v1/search?text={name}', () => {
      test('returns 200 with a JSON search result', () => {
        expect(r.search.status).toBe(200);
        const body = json(r.search);
        expect(Array.isArray(body.objects)).toBe(true);
        expect(Number.isInteger(body.total)).toBe(true);
        expect(body.total).toBeGreaterThanOrEqual(body.objects.length);
        expect(isDate(body.time)).toBe(true);
      });

      test('every result has a package with a name and a semver version, and a score', () => {
        const body = json(r.search);
        expect(body.objects.length).toBeGreaterThan(0);
        for (const o of body.objects) {
          expect(typeof o.package?.name).toBe('string');
          expect(o.package.version).toMatch(SEMVER);
          if (o.package.date !== undefined) {
            expect(isDate(o.package.date)).toBe(true);
          }
          expect(typeof o.score?.final).toBe('number');
          for (const k of ['quality', 'popularity', 'maintenance']) {
            expect(typeof o.score.detail?.[k]).toBe('number');
          }
          expect(typeof o.searchScore).toBe('number');
        }
      });

      test('the package searched for by name is the first result', () => {
        const names = json(r.search).objects.map(o => o.package.name);
        expect(names).toContain(pkg);
        expect(names[0]).toBe(pkg);
      });

      test('size limits the number of results', () => {
        expect(json(r.search).objects.length).toBeLessThanOrEqual(SEARCH_SIZE);
        expect(r.searchSize1.status).toBe(200);
        expect(json(r.searchSize1).objects).toHaveLength(1);
      });

      test('from skips results', () => {
        const all = json(r.search).objects.map(o => o.package.name);
        const skipped = json(r.searchFrom1).objects.map(o => o.package.name);
        expect(all.length).toBeGreaterThan(1);
        expect(skipped[0]).toBe(all[1]);
      });
    });

    describe('2. package document: GET /{name}', () => {
      test('returns 200 with JSON for the Accept header the npm CLI sends', () => {
        expect(r.packument.status).toBe(200);
        json(r.packument);
      });

      test('names the package and has a latest dist-tag that points at a listed version', () => {
        const doc = json(r.packument);
        expect(doc.name).toBe(pkg);
        expect(typeof doc['dist-tags']?.latest).toBe('string');
        expect(Object.keys(doc.versions)).toContain(doc['dist-tags'].latest);
        expect(Object.keys(doc.versions)).toContain(version);
      });

      test('every version is a semver, names the package, and has a tarball with a checksum', () => {
        const doc = json(r.packument);
        for (const [v, man] of Object.entries(doc.versions)) {
          expect(v).toMatch(SEMVER);
          expect(man.name).toBe(pkg);
          expect(man.version).toBe(v);
          expect(man.dist?.tarball).toMatch(/^https?:\/\//);
          // npm needs at least one of these to verify the download
          expect(SHA1_HEX.test(man.dist.shasum || '') || SRI.test(man.dist.integrity || '')).toBe(true);
          if (man.dist.integrity !== undefined) {
            expect(man.dist.integrity).toMatch(SRI);
          }
          for (const deps of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
            if (man[deps] !== undefined) {
              for (const [k, range] of Object.entries(man[deps])) {
                expect(typeof k).toBe('string');
                expect(typeof range).toBe('string');
              }
            }
          }
        }
      });

      test('the full document (Accept: application/json) has _id, version _ids and publish times', () => {
        expect(r.fullPackument.status).toBe(200);
        const doc = json(r.fullPackument);
        expect(doc._id).toBe(pkg);
        expect(doc.name).toBe(pkg);
        expect(doc.versions[version]._id).toBe(`${pkg}@${version}`);
        expect(isDate(doc.time?.created)).toBe(true);
        expect(isDate(doc.time?.modified)).toBe(true);
        for (const v of Object.keys(doc.versions)) {
          expect(isDate(doc.time[v])).toBe(true);
        }
      });

      test('an unknown package is a 404', () => {
        expect(r.missing.status).toBe(404);
      });
    });

    describe('3. version document: GET /{name}/{version}', () => {
      test('returns 200 with the JSON manifest of that version', () => {
        expect(r.versionDoc.status).toBe(200);
        const man = json(r.versionDoc);
        expect(man.name).toBe(pkg);
        expect(man.version).toBe(version);
      });

      test('matches the version in the package document', () => {
        const man = json(r.versionDoc);
        const fromDoc = json(r.packument).versions[version];
        expect(man.dist.tarball).toBe(fromDoc.dist.tarball);
        if (fromDoc.dist.shasum) {
          expect(man.dist.shasum).toBe(fromDoc.dist.shasum);
        }
        if (fromDoc.dist.integrity) {
          expect(man.dist.integrity).toBe(fromDoc.dist.integrity);
        }
      });

      test('a dist-tag in place of a version resolves to the tagged version', () => {
        expect(r.latestDoc.status).toBe(200);
        expect(json(r.latestDoc).version).toBe(json(r.packument)['dist-tags'].latest);
      });

      test('an unknown version is a 404', () => {
        expect(r.missingVersion.status).toBe(404);
      });
    });

    describe('4. tarball: GET {dist.tarball}', () => {
      test('downloads (following redirects) as a gzip file', () => {
        expect(r.tarball).toBeDefined();
        expect(r.tarball.status).toBe(200);
        expect(r.tarball.body[0]).toBe(0x1f);
        expect(r.tarball.body[1]).toBe(0x8b);
      });

      test('matches the checksums in the package document', () => {
        const dist = json(r.packument).versions[version].dist;
        if (dist.shasum) {
          expect(crypto.createHash('sha1').update(r.tarball.body).digest('hex')).toBe(dist.shasum);
        }
        if (dist.integrity) {
          const [alg, digest] = dist.integrity.split(/-(.*)/s);
          expect(crypto.createHash(alg).update(r.tarball.body).digest('base64')).toBe(digest);
        }
      });

      test('contains package/package.json for this name and version', () => {
        const files = untar(zlib.gunzipSync(r.tarball.body));
        expect(Object.keys(files)).toContain('package/package.json');
        const manifest = JSON.parse(files['package/package.json'].toString('utf8'));
        expect(manifest.name).toBe(pkg);
        expect(manifest.version).toBe(version);
      });
    });
  });
}

module.exports = { defineNpmRegistryChecks, tgz, untar };
