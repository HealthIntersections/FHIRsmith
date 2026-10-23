/**
 * The syndication store (tx/syndication/syndication-store.js): what gets recorded, what
 * doesn't, and that it only ever grows. The network is a fake: packages are "downloaded"
 * to be hashed, and binaries are HEAD-checked against the external store.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { SyndicationStore, isBuildVersion, NCTS_SCHEME, FHIRSMITH_SCHEME } = require('../../tx/syndication/syndication-store');

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** a fake fetch: url -> {status, body} for GET; HEAD answers with the body's length */
function fakeFetch(table) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    const hit = table[url];
    const status = hit ? (hit.status || 200) : 404;
    const body = hit ? Buffer.from(hit.body || '') : Buffer.alloc(0);
    const length = hit && hit.length != null ? hit.length : body.length;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(length) : null) },
      arrayBuffer: async () => body
    };
  };
  fn.calls = calls;
  return fn;
}

let dir;
let clock;

function makeStore(fetch) {
  return new SyndicationStore(dir, silent, { fetch, now: () => new Date(clock++) }).open();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synd-'));
  clock = Date.parse('2026-10-23T00:00:00Z');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the store', () => {
  test('is started on first open, and read back after', () => {
    const store = makeStore(fakeFetch({}));
    expect(store.entries).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'syndication.json'))).toBe(true);
    const again = makeStore(fakeFetch({}));
    expect(again.id).toBe(store.id);
    expect(again.created).toBe(store.created);
  });

  test('a store file that is not valid stops it opening', () => {
    fs.writeFileSync(path.join(dir, 'syndication.json'), '{"entries": "no"}');
    expect(() => makeStore(fakeFetch({}))).toThrow(/not valid/);
  });
});

describe('packages', () => {
  const tgz = 'pretend this is a tarball';
  const npm = { 'https://npm.fhir.org/web/hl7.terminology-6.0.2.tgz': { body: tgz } };
  const pkg = { id: 'hl7.terminology', version: '6.0.2', canonical: 'http://terminology.hl7.org', title: 'THO', description: 'HL7 Terminology' };

  test('are linked at npm.fhir.org, and hashed from there', async () => {
    const store = makeStore(fakeFetch(npm));
    await store.inductPackage(pkg);
    expect(store.entries).toHaveLength(1);
    const e = store.entries[0];
    expect(e.category).toEqual({ scheme: NCTS_SCHEME, term: 'FHIR_Package', label: 'FHIR Package' });
    expect(e.identifier).toBe('http://terminology.hl7.org');
    expect(e.version).toBe('http://terminology.hl7.org|6.0.2');
    expect(e.summary).toBe('HL7 Terminology');
    expect(e.fhirVersion).toBeUndefined();
    expect(e.link).toEqual({ href: 'https://npm.fhir.org/web/hl7.terminology-6.0.2.tgz', type: 'application/gzip', length: tgz.length, sha256: sha(tgz) });
    expect(e.id).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(e.inducted).toBe('2026-10-23T00:00:00.001Z');
  });

  test('are only inducted (and downloaded) once', async () => {
    const fetch = fakeFetch(npm);
    let store = makeStore(fetch);
    await store.inductPackage(pkg);
    await store.inductPackage(pkg);
    store = makeStore(fetch); // a restart
    await store.inductPackage(pkg);
    expect(store.entries).toHaveLength(1);
    expect(fetch.calls).toHaveLength(1);
  });

  test('a package id and version are encoded into the npm.fhir.org url', async () => {
    const fetch = fakeFetch({ 'https://npm.fhir.org/web/..%2Fx-1%2F2.tgz': { body: 'x' } });
    const store = makeStore(fetch);
    await store.inductPackage({ ...pkg, id: '../x', version: '1/2' });
    expect(fetch.calls.map(c => c.url)).toEqual(['https://npm.fhir.org/web/..%2Fx-1%2F2.tgz']);
    expect(store.entries).toHaveLength(1);
  });

  test('a streamed download is hashed as it arrives', async () => {
    const chunks = [Buffer.from('part one, '), Buffer.from('part two')];
    const fetch = async () => ({
      ok: true, status: 200, headers: { get: () => null },
      body: (async function* () { yield* chunks; })(),
      arrayBuffer: async () => { throw new Error('should stream'); }
    });
    const store = makeStore(fetch);
    await store.inductPackage(pkg);
    expect(store.entries[0].link.sha256).toBe(sha(Buffer.concat(chunks)));
    expect(store.entries[0].link.length).toBe(18);
  });

  test('a url: source links where it came from', async () => {
    const url = 'https://build.fhir.org/ig/x/y/package.tgz';
    const store = makeStore(fakeFetch({ [url]: { body: 'x' } }));
    await store.inductPackage({ ...pkg, url });
    expect(store.entries[0].link.href).toBe(url);
  });

  test('a core package is version specific', async () => {
    const store = makeStore(fakeFetch({ ...npm, 'https://npm.fhir.org/web/hl7.fhir.r4.core-4.0.1.tgz': { body: 'core' } }));
    await store.inductPackage({ id: 'hl7.fhir.r4.core', version: '4.0.1', canonical: 'http://hl7.org/fhir', fhirVersion: '4.0' });
    await store.inductPackage(pkg);
    expect(store.entries[0].fhirVersion).toBe('4.0');
    expect(store.entriesFor('4.0')).toHaveLength(2);
    expect(store.entriesFor('5.0').map(e => e.identifier)).toEqual(['http://terminology.hl7.org']);
  });

  test('builds are not syndicated', async () => {
    const fetch = fakeFetch(npm);
    const store = makeStore(fetch);
    await store.inductPackage({ ...pkg, requestedVersion: 'current' });
    await store.inductPackage({ ...pkg, version: '6.1.0-cibuild' });
    await store.inductPackage({ ...pkg, version: 'dev' });
    expect(store.entries).toHaveLength(0);
    expect(fetch.calls).toHaveLength(0);
    expect(isBuildVersion('current$branch')).toBe(true);
    expect(isBuildVersion('6.0.2')).toBe(false);
  });

  test('a download that fails is not recorded, and is tried again next time', async () => {
    const store = makeStore(fakeFetch({}));
    await store.inductPackage(pkg);
    expect(store.entries).toHaveLength(0);
    const later = makeStore(fakeFetch(npm));
    await later.inductPackage(pkg);
    expect(later.entries).toHaveLength(1);
  });

  test('a package with no canonical is not recorded', async () => {
    const store = makeStore(fakeFetch(npm));
    await store.inductPackage({ ...pkg, canonical: undefined });
    expect(store.entries).toHaveLength(0);
  });
});

describe('resources from files', () => {
  function writeResource(name, json) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(json));
    return p;
  }
  const cs = { resourceType: 'CodeSystem', url: 'http://example.org/cs', version: '1.0', title: 'Example' };

  test('are copied into the store', async () => {
    const store = makeStore(fakeFetch({}));
    const file = writeResource('cs.json', cs);
    await store.inductResource({ filePath: file, resourceType: 'CodeSystem', url: cs.url, version: cs.version, title: cs.title });
    const e = store.entries[0];
    expect(e.category.term).toBe('FHIR_CodeSystem');
    expect(e.identifier).toBe('http://example.org/cs');
    expect(e.version).toBe('http://example.org/cs|1.0');
    expect(e.link.href).toBeUndefined();
    const copy = store.filePath(e.link.file);
    expect(fs.readFileSync(copy, 'utf8')).toBe(fs.readFileSync(file, 'utf8'));
    expect(e.link.sha256).toBe(sha(fs.readFileSync(file)));
  });

  test('without a version are not syndicated', async () => {
    const store = makeStore(fakeFetch({}));
    const file = writeResource('vs.json', { resourceType: 'ValueSet', url: 'http://example.org/vs' });
    await store.inductResource({ filePath: file, resourceType: 'ValueSet', url: 'http://example.org/vs' });
    expect(store.entries).toHaveLength(0);
  });

  test('the same content again is not a new entry; changed content is, and the old one stays', async () => {
    const store = makeStore(fakeFetch({}));
    const file = writeResource('cs.json', cs);
    const res = { filePath: file, resourceType: 'CodeSystem', url: cs.url, version: cs.version };
    await store.inductResource(res);
    await store.inductResource(res);
    expect(store.entries).toHaveLength(1);
    const first = { ...store.entries[0] };
    writeResource('cs.json', { ...cs, title: 'Changed' });
    await store.inductResource(res);
    expect(store.entries).toHaveLength(2);
    // contentItemVersion is not unique: a later update is a later entry
    expect(store.entries[1].version).toBe(first.version);
    expect(store.entries[1].id).not.toBe(first.id);
    expect(store.entries[0]).toEqual(first);
    expect(fs.existsSync(store.filePath(first.link.file))).toBe(true);
  });

  test('file names are checked', () => {
    const store = makeStore(fakeFetch({}));
    expect(store.filePath('../syndication.json')).toBeNull();
    expect(store.filePath('00000000-0000-0000-0000-000000000000.json')).toBeNull();
  });
});

describe('binaries', () => {
  const base = 'https://storage.googleapis.com/tx-fhir-org';
  function binary(name, content) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  }

  test('published at the external store are linked there, not copied', async () => {
    const content = 'snomed cache bytes';
    const file = binary('sct_intl_20250201.cache', content);
    const store = makeStore(fakeFetch({ [`${base}/sct_intl_20250201.cache`]: { length: content.length } }));
    await store.inductBinary({
      sourceType: 'snomed', filePath: file, baseUrl: base, system: 'http://snomed.info/sct',
      version: 'http://snomed.info/sct/900000000000207008/version/20250201', name: 'SCT intl'
    });
    const e = store.entries[0];
    expect(e.category).toEqual({ scheme: FHIRSMITH_SCHEME, term: 'SNOMED_CACHE', label: 'SNOMED_CACHE' });
    expect(e.identifier).toBe('http://snomed.info/sct/900000000000207008');
    expect(e.version).toBe('http://snomed.info/sct/900000000000207008/version/20250201');
    expect(e.rights).toMatch(/SNOMED CT/);
    expect(e.link).toEqual({ href: `${base}/sct_intl_20250201.cache`, type: 'application/octet-stream', length: content.length, sha256: sha(content) });
    expect(fs.readdirSync(path.join(dir, 'files'))).toEqual([]);
  });

  test('other binaries are identified by system|version, with a generic licence note', async () => {
    const file = binary('Loinc_2.82.db', 'loinc');
    const store = makeStore(fakeFetch({ [`${base}/Loinc_2.82.db`]: { length: 5 } }));
    await store.inductBinary({ sourceType: 'loinc', filePath: file, baseUrl: base + '/', system: 'http://loinc.org', version: '2.82', name: 'LOINC' });
    const e = store.entries[0];
    expect(e.category.term).toBe('LOINC_DB');
    expect(e.identifier).toBe('http://loinc.org');
    expect(e.version).toBe('http://loinc.org|2.82');
    expect(e.title).toBe('LOINC 2.82 (Loinc_2.82.db)');
    expect(e.rights).toMatch(/applicable licence/);
  });

  test('that are only local (or differ from the published one) are not syndicated', async () => {
    const file = binary('sct_test_20250909d.cache', 'local build');
    const store = makeStore(fakeFetch({ [`${base}/sct_test_20250909d.cache`]: { length: 3 } }));
    await store.inductBinary({ sourceType: 'snomed', filePath: file, baseUrl: base, system: 'http://snomed.info/sct', version: 'v' });
    const other = binary('rxnorm_x.db', 'x');
    await store.inductBinary({ sourceType: 'rxnorm', filePath: other, baseUrl: base, system: 's', version: 'v' });
    expect(store.entries).toHaveLength(0);
  });

  test('the full CPT database is never syndicated; the fragment is', async () => {
    const full = binary('CodeSystem-cpt.db', 'full');
    const frag = binary('cpt-2023-fragment-0.1.db', 'frag');
    const fetch = fakeFetch({ [`${base}/CodeSystem-cpt.db`]: { length: 4 }, [`${base}/cpt-2023-fragment-0.1.db`]: { length: 4 } });
    const store = makeStore(fetch);
    await store.inductBinary({ sourceType: 'cpt', filePath: full, baseUrl: base, system: 'http://www.ama-assn.org/go/cpt', version: '2023' });
    await store.inductBinary({ sourceType: 'cpt', filePath: frag, baseUrl: base, system: 'http://www.ama-assn.org/go/cpt', version: '2023' });
    expect(store.entries.map(e => e.link.href)).toEqual([`${base}/cpt-2023-fragment-0.1.db`]);
    expect(fetch.calls.map(c => c.url)).not.toContain(`${base}/CodeSystem-cpt.db`);
  });

  test('a rebuilt binary (new file name) is a new entry; the old one stays', async () => {
    const b = binary('sct_test_b.cache', 'bb');
    const c = binary('sct_test_c.cache', 'ccc');
    const store = makeStore(fakeFetch({ [`${base}/sct_test_b.cache`]: { length: 2 }, [`${base}/sct_test_c.cache`]: { length: 3 } }));
    const bin = { sourceType: 'snomed', baseUrl: base, system: 'http://snomed.info/sct', version: 'http://snomed.info/sct/1/version/2' };
    await store.inductBinary({ ...bin, filePath: b });
    await store.inductBinary({ ...bin, filePath: b });
    await store.inductBinary({ ...bin, filePath: c });
    expect(store.entries.map(e => e.link.href)).toEqual([`${base}/sct_test_b.cache`, `${base}/sct_test_c.cache`]);
    expect(store.entries[0].version).toBe(store.entries[1].version);
  });
});
