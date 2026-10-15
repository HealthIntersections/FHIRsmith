//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * npm registry protocol checks.
 *
 * There is no published conformance suite for the npm registry protocol, so this is our own.
 * It walks the path an npm client takes: search for a package by name, read its package
 * document, read one version's document, and download that version's tarball. At each step
 * it checks the parts of the response that npm clients depend on.
 *
 * Every check must pass against registry.npmjs.org. If one fails there, the check is wrong
 * (or npm has changed its behaviour, which has happened before), not the registry.
 *
 * Used by /packages/npm-check (a report on any registry) and by the test suites
 * tests/packages/npm-registry*.test.js, so all of them run the same checks.
 *
 * References:
 *   https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md
 *   https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md
 */

const crypto = require('crypto');
const zlib = require('zlib');
const axios = require('axios');

// What the npm CLI sends when it fetches a package document
const NPM_ACCEPT = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';
const MISSING_PACKAGE = 'no-such-package-zz9-plural-z-alpha';
const SEARCH_SIZE = 20;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA1_HEX = /^[0-9a-f]{40}$/;
const SRI = /^(sha512|sha384|sha256|sha1)-[A-Za-z0-9+/]+=*$/;

const STEPS = [
  { id: 'search', title: '1. Search', request: 'GET /-/v1/search?text={name}' },
  { id: 'package', title: '2. Package document', request: 'GET /{name}' },
  { id: 'version', title: '3. Version document', request: 'GET /{name}/{version}' },
  { id: 'tarball', title: '4. Tarball', request: 'GET {dist.tarball}' }
];

// A check's failure, with a message for people
class CheckFailure extends Error {}

function show(v) {
  const s = v === undefined ? 'nothing' : JSON.stringify(v);
  return s.length > 120 ? s.substring(0, 117) + '...' : s;
}

function isDate(s) {
  return typeof s === 'string' && !Number.isNaN(Date.parse(s));
}

// What each check is given: the responses, and assertions that fail with a readable message
function context(target, r) {
  const c = {
    pkg: target.pkg,
    version: target.version,
    r,
    fail(msg) {
      throw new CheckFailure(msg);
    },
    ok(cond, msg) {
      if (!cond) {
        c.fail(msg);
      }
    },
    eq(actual, expected, what) {
      if (actual !== expected) {
        c.fail(`${what}: expected ${show(expected)}, got ${show(actual)}`);
      }
    },
    status(name, expected) {
      const res = c.response(name);
      c.ok(res.status === expected, `expected HTTP ${expected}, got ${res.status}`);
    },
    response(name) {
      const res = r[name];
      if (!res) {
        c.fail(`not requested: ${name === 'tarball' ? 'the package document gave no tarball URL for this version' : name}`);
      }
      if (res.error) {
        c.fail(`the request failed: ${res.error}`);
      }
      return res;
    },
    json(name) {
      const res = c.response(name);
      if (!/^application\/(json|vnd\.npm\.install-v1\+json)\b/i.test(res.contentType)) {
        c.fail(`expected JSON, got HTTP ${res.status} ${res.contentType || 'with no Content-Type'}`);
      }
      try {
        return JSON.parse(res.body.toString('utf8'));
      } catch (e) {
        return c.fail(`the response isn't valid JSON: ${e.message}`);
      }
    }
  };
  return c;
}

const CHECKS = [
  // 1. search
  {
    step: 'search', uses: ['search'], title: 'returns 200 with a JSON search result',
    run(c) {
      c.status('search', 200);
      const body = c.json('search');
      c.ok(Array.isArray(body.objects), 'objects is not an array');
      c.ok(Number.isInteger(body.total), `total is not an integer: ${show(body.total)}`);
      c.ok(body.total >= body.objects.length, `total (${body.total}) is less than the number of results (${body.objects.length})`);
      c.ok(isDate(body.time), `time is not a date: ${show(body.time)}`);
    }
  },
  {
    step: 'search', uses: ['search'], title: 'every result has a package with a name and a semver version, and a score',
    run(c) {
      const body = c.json('search');
      c.ok(body.objects?.length > 0, 'there are no results');
      body.objects.forEach((o, i) => {
        const at = `result ${i + 1}`;
        c.ok(typeof o.package?.name === 'string', `${at}: package.name is not a string`);
        c.ok(SEMVER.test(o.package.version), `${at} (${o.package.name}): version is not semver: ${show(o.package.version)}`);
        c.ok(o.package.date === undefined || isDate(o.package.date), `${at} (${o.package.name}): date is not a date: ${show(o.package.date)}`);
        c.ok(typeof o.score?.final === 'number', `${at} (${o.package.name}): score.final is not a number`);
        for (const k of ['quality', 'popularity', 'maintenance']) {
          c.ok(typeof o.score.detail?.[k] === 'number', `${at} (${o.package.name}): score.detail.${k} is not a number`);
        }
        c.ok(typeof o.searchScore === 'number', `${at} (${o.package.name}): searchScore is not a number`);
      });
    }
  },
  {
    step: 'search', uses: ['search'], title: 'the package searched for by name is the first result',
    run(c) {
      const names = c.json('search').objects.map(o => o.package?.name);
      c.ok(names.includes(c.pkg), `${c.pkg} is not in the results`);
      c.eq(names[0], c.pkg, 'the first result');
    }
  },
  {
    step: 'search', uses: ['search', 'searchSize1'], title: 'size limits the number of results',
    run(c) {
      const n = c.json('search').objects.length;
      c.ok(n <= SEARCH_SIZE, `size=${SEARCH_SIZE} returned ${n} results`);
      c.status('searchSize1', 200);
      c.eq(c.json('searchSize1').objects.length, 1, 'the number of results for size=1');
    }
  },
  {
    step: 'search', uses: ['search', 'searchFrom1'], title: 'from skips results',
    run(c) {
      const all = c.json('search').objects.map(o => o.package?.name);
      c.ok(all.length > 1, 'there is only one result, so from can\'t be checked');
      c.eq(c.json('searchFrom1').objects[0]?.package?.name, all[1], 'the first result with from=1');
    }
  },

  // 2. package document
  {
    step: 'package', uses: ['packument'], title: 'returns 200 with JSON for the Accept header the npm CLI sends',
    run(c) {
      c.status('packument', 200);
      c.json('packument');
    }
  },
  {
    step: 'package', uses: ['packument'], title: 'names the package and has a latest dist-tag that points at a listed version',
    run(c) {
      const doc = c.json('packument');
      c.eq(doc.name, c.pkg, 'name');
      c.ok(typeof doc['dist-tags']?.latest === 'string', 'there is no dist-tags.latest');
      const versions = Object.keys(doc.versions || {});
      c.ok(versions.includes(doc['dist-tags'].latest), `dist-tags.latest (${doc['dist-tags'].latest}) is not one of the versions`);
      c.ok(versions.includes(c.version), `version ${c.version} is not in the document`);
    }
  },
  {
    step: 'package', uses: ['packument'], title: 'every version is a semver, names the package, and has a tarball with a checksum',
    run(c) {
      const doc = c.json('packument');
      for (const [v, man] of Object.entries(doc.versions || {})) {
        c.ok(SEMVER.test(v), `version ${show(v)} is not semver`);
        c.eq(man.name, c.pkg, `versions.${v}.name`);
        c.eq(man.version, v, `versions.${v}.version`);
        c.ok(/^https?:\/\//.test(man.dist?.tarball || ''), `versions.${v}: dist.tarball is not an http(s) URL: ${show(man.dist?.tarball)}`);
        // npm needs at least one of these to verify the download
        c.ok(SHA1_HEX.test(man.dist.shasum || '') || SRI.test(man.dist.integrity || ''), `versions.${v}: no valid dist.shasum or dist.integrity`);
        c.ok(man.dist.integrity === undefined || SRI.test(man.dist.integrity), `versions.${v}: dist.integrity is not a valid SRI string`);
        for (const deps of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
          for (const [k, range] of Object.entries(man[deps] || {})) {
            c.ok(typeof range === 'string', `versions.${v}.${deps}.${k} is not a string`);
          }
        }
      }
    }
  },
  {
    step: 'package', uses: ['fullPackument'], title: 'the full document (Accept: application/json) has _id, version _ids and publish times',
    run(c) {
      c.status('fullPackument', 200);
      const doc = c.json('fullPackument');
      c.eq(doc._id, c.pkg, '_id');
      c.eq(doc.name, c.pkg, 'name');
      c.eq(doc.versions?.[c.version]?._id, `${c.pkg}@${c.version}`, `versions.${c.version}._id`);
      c.ok(isDate(doc.time?.created), 'time.created is missing or not a date');
      c.ok(isDate(doc.time?.modified), 'time.modified is missing or not a date');
      for (const v of Object.keys(doc.versions || {})) {
        c.ok(isDate(doc.time[v]), `time.${v} is missing or not a date`);
      }
    }
  },
  {
    step: 'package', uses: ['missing'], title: 'an unknown package is a 404',
    run(c) {
      c.status('missing', 404);
    }
  },

  // 3. version document
  {
    step: 'version', uses: ['versionDoc'], title: 'returns 200 with the JSON manifest of that version',
    run(c) {
      c.status('versionDoc', 200);
      const man = c.json('versionDoc');
      c.eq(man.name, c.pkg, 'name');
      c.eq(man.version, c.version, 'version');
    }
  },
  {
    step: 'version', uses: ['versionDoc', 'packument'], title: 'matches the version in the package document',
    run(c) {
      const man = c.json('versionDoc');
      const fromDoc = c.json('packument').versions?.[c.version];
      c.ok(fromDoc, `version ${c.version} is not in the package document`);
      c.eq(man.dist?.tarball, fromDoc.dist?.tarball, 'dist.tarball');
      if (fromDoc.dist?.shasum) {
        c.eq(man.dist?.shasum, fromDoc.dist.shasum, 'dist.shasum');
      }
      if (fromDoc.dist?.integrity) {
        c.eq(man.dist?.integrity, fromDoc.dist.integrity, 'dist.integrity');
      }
    }
  },
  {
    step: 'version', uses: ['latestDoc', 'packument'], title: 'a dist-tag in place of a version resolves to the tagged version',
    run(c) {
      c.status('latestDoc', 200);
      c.eq(c.json('latestDoc').version, c.json('packument')['dist-tags']?.latest, 'version for /latest');
    }
  },
  {
    step: 'version', uses: ['missingVersion'], title: 'an unknown version is a 404',
    run(c) {
      c.status('missingVersion', 404);
    }
  },

  // 4. tarball
  {
    step: 'tarball', uses: ['tarball'], title: 'downloads (following redirects) as a gzip file',
    run(c) {
      c.status('tarball', 200);
      const body = c.r.tarball.body;
      c.ok(body[0] === 0x1f && body[1] === 0x8b, `not a gzip file (it starts with ${body.subarray(0, 8).toString('hex') || 'nothing'})`);
    }
  },
  {
    step: 'tarball', uses: ['tarball', 'packument'], title: 'matches the checksums in the package document',
    run(c) {
      const body = c.response('tarball').body;
      const dist = c.json('packument').versions?.[c.version]?.dist || {};
      if (dist.shasum) {
        c.eq(crypto.createHash('sha1').update(body).digest('hex'), dist.shasum, 'the sha1 of the tarball (dist.shasum)');
      }
      if (dist.integrity) {
        const [alg, digest] = dist.integrity.split(/-(.*)/s);
        c.eq(crypto.createHash(alg).update(body).digest('base64'), digest, `the ${alg} of the tarball (dist.integrity)`);
      }
    }
  },
  {
    step: 'tarball', uses: ['tarball'], title: 'contains package/package.json for this name and version',
    run(c) {
      let files;
      try {
        files = untar(zlib.gunzipSync(c.response('tarball').body));
      } catch (e) {
        c.fail(`can't unpack the tarball: ${e.message}`);
      }
      c.ok(files['package/package.json'], 'there is no package/package.json');
      let manifest;
      try {
        manifest = JSON.parse(files['package/package.json'].toString('utf8'));
      } catch (e) {
        c.fail(`package/package.json isn't valid JSON: ${e.message}`);
      }
      c.eq(manifest.name, c.pkg, 'package.json name');
      c.eq(manifest.version, c.version, 'package.json version');
    }
  }
];

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

function packageUrl(base, name, version) {
  // npm's form: everything escaped, including the '/' of a scoped name, except its leading '@'
  const id = encodeURIComponent(name).replace(/^%40/, '@');
  return version ? `${base}/${id}/${encodeURIComponent(version)}` : `${base}/${id}`;
}

/**
 * An HTTP GET for the checks: { url, status, contentType, body } or { url, error }.
 *
 * The URLs come from whoever asks for a check (the registry), and from the registry itself
 * (the tarball URL, redirects), so every request must go through SSRF-guarded agents:
 * PackageCrawler.guardedAgents(), which refuse non-public addresses at connection time,
 * redirects included. httpAgent and httpsAgent are required for that reason.
 * options: httpAgent, httpsAgent, timeout (ms), maxBytes (per response), userAgent.
 */
function makeGetter(options = {}) {
  if (!options.httpAgent || !options.httpsAgent) {
    throw new Error('makeGetter needs the SSRF-guarded httpAgent and httpsAgent (PackageCrawler.guardedAgents())');
  }
  return async (url, accept = 'application/json') => {
    if (!/^https?:\/\//i.test(url)) {
      return { url, error: 'not an http(s) URL' };
    }
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        headers: { accept, 'user-agent': options.userAgent || 'FHIRsmith npm registry check' },
        timeout: options.timeout || 30000,
        maxContentLength: options.maxBytes || 100 * 1024 * 1024,
        maxRedirects: 5,
        validateStatus: () => true,
        httpAgent: options.httpAgent,
        httpsAgent: options.httpsAgent
      });
      return { url, status: res.status, contentType: String(res.headers['content-type'] || ''), body: Buffer.from(res.data) };
    } catch (e) {
      const why = e.code === 'ECONNABORTED' ? 'timed out' : /maxContentLength/.test(e.message) ? 'the response is too large' : e.message;
      return { url, error: why };
    }
  };
}

/**
 * Runs every check against one registry. target is { registry, pkg, version }; get is a
 * function from makeGetter. Returns the report: per step, per check, pass or fail with a
 * message, and the requests the checks were based on.
 */
async function runNpmCheck(target, get) {
  let base = target.registry;
  while (base.endsWith('/')) {
    base = base.slice(0, -1);
  }
  const { pkg, version } = target;
  const started = new Date();
  const search = extra => get(`${base}/-/v1/search?text=${encodeURIComponent(pkg)}${extra}`);
  const r = {};
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
    try {
      const tarball = JSON.parse(r.packument.body.toString('utf8')).versions?.[version]?.dist?.tarball;
      if (typeof tarball === 'string' && /^https?:\/\//.test(tarball)) {
        r.tarball = await get(tarball, '*/*');
      }
    } catch (e) {
      // the package document checks report it
    }
  }

  const c = context({ pkg, version }, r);
  const results = CHECKS.map(check => {
    try {
      check.run(c);
      return { step: check.step, title: check.title, uses: check.uses, status: 'pass' };
    } catch (e) {
      const message = e instanceof CheckFailure ? e.message : `the check itself failed: ${e.message}`;
      return { step: check.step, title: check.title, uses: check.uses, status: 'fail', message };
    }
  });

  const requests = {};
  for (const [name, res] of Object.entries(r)) {
    requests[name] = res.error ? { url: res.url, error: res.error }
      : { url: res.url, status: res.status, contentType: res.contentType, bytes: res.body.length };
  }
  return {
    registry: base,
    package: pkg,
    version,
    started: started.toISOString(),
    finished: new Date().toISOString(),
    passed: results.filter(x => x.status === 'pass').length,
    failed: results.filter(x => x.status === 'fail').length,
    steps: STEPS.map(s => ({ ...s, checks: results.filter(x => x.step === s.id) })),
    requests
  };
}

module.exports = { runNpmCheck, makeGetter, CHECKS, STEPS, untar, packageUrl };
