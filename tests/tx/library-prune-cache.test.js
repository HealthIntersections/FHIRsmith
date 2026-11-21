/**
 * pruneTerminologyCache (modules.tx.pruneTerminologyCache): once the library and the endpoints'
 * core packages are loaded (Library.pruneUnusedCaches), the .db and .cache files and the package
 * folders in terminology-cache that weren't used are deleted - not other files or folders, not
 * one changed in the last day, and not by a tx-worker
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Library } = require('../../tx/library');

function fakeLog() {
  const lines = [];
  const add = level => msg => lines.push(`${level}: ${msg}`);
  return { lines, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

const OLD = new Date('2026-01-01T00:00:00Z');

describe('pruning the terminology cache', () => {
  let dir;
  let yml;

  function pkg(name, old = true) {
    const p = file(name + '/package/package.json', old);
    file(name + '/package/.valuesets-2.db', old);
    if (old) {
      fs.utimesSync(path.join(dir, name), OLD, OLD);
    }
    return p;
  }

  function file(name, old = true) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x'.repeat(10));
    if (old) {
      fs.utimesSync(p, OLD, OLD);
    }
    return p;
  }
  const exists = (name) => fs.existsSync(path.join(dir, name));

  function library(log = fakeLog()) {
    const lib = new Library(yml, null, log, null);
    lib.cacheFolder = dir;
    return lib;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-prune-'));
    yml = path.join(dir, 'library.yml');
    fs.writeFileSync(yml, 'base:\n  url: http://example.org/none\nsources: []\n');
    file('loinc.db');
    file('snomed.cache');
    file('cpt-full.db');
    file('cpt-fragment.db');
    file('old-loinc.db');
    file('old-loinc.db-wal');
    file('old-loinc.db-shm');
    file('old-sct.CACHE');
    file('new-sct.cache', false);
    file('media-types.xml');
    pkg('hl7.terminology#7.0.0');
    pkg('hl7.terminology#6.5.0');
    pkg('hl7.fhir.r4.core#4.0.1');
    pkg('hl7.fhir.r3.core#3.0.2');
    pkg('_url_temp_123#url');
    pkg('new.package#1.0.0', false);
    file('vsac/vsac-valuesets.db');
    file('folder-source-abc/x.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function use(lib) {
    await lib.getOrDownloadFile('loinc.db');
    await lib.getOrDownloadFile('snomed.cache');
    await lib.getOrDownloadFile('cpt-full.db|cpt-fragment.db');
    // in the cache already, so nothing is downloaded
    await lib.packageManager.fetch('hl7.terminology', '7.0.0');
    await lib.packageManager.fetch('hl7.fhir.r4.core', '4.0.1');
  }

  test('deletes the .db and .cache files the load did not use, with their SQLite side files', async () => {
    const log = fakeLog();
    const lib = library(log);
    await use(lib);
    const deleted = await lib.pruneTerminologyCache();
    expect(deleted.sort()).toEqual(['cpt-fragment.db', 'old-loinc.db', 'old-sct.CACHE']);
    for (const kept of ['loinc.db', 'snomed.cache', 'cpt-full.db', 'new-sct.cache', 'media-types.xml',
      'vsac/vsac-valuesets.db']) {
      expect(exists(kept)).toBe(true);
    }
    for (const gone of ['cpt-fragment.db', 'old-loinc.db', 'old-loinc.db-wal', 'old-loinc.db-shm', 'old-sct.CACHE']) {
      expect(exists(gone)).toBe(false);
    }
    expect(log.lines).toContain('info: Not deleting unused new-sct.cache yet: it changed in the last day');
    expect(log.lines).toContain('info: Deleted 3 unused files from the terminology cache, 0.0 MB');
  });

  test('the fallback of an "a|b" source is used when the first file is not there', async () => {
    fs.rmSync(path.join(dir, 'cpt-full.db'));
    const lib = library();
    await use(lib);
    await lib.pruneTerminologyCache();
    expect(exists('cpt-fragment.db')).toBe(true);
  });

  test('deletes the package folders that were not used: old versions, other FHIR versions, leftovers', async () => {
    const log = fakeLog();
    const lib = library(log);
    await use(lib);
    const deleted = await lib.prunePackages();
    expect(deleted.sort()).toEqual(['_url_temp_123#url', 'hl7.fhir.r3.core#3.0.2', 'hl7.terminology#6.5.0']);
    for (const kept of ['hl7.terminology#7.0.0/package/.valuesets-2.db', 'hl7.fhir.r4.core#4.0.1/package/package.json',
      'new.package#1.0.0/package/package.json', 'vsac/vsac-valuesets.db', 'folder-source-abc/x.db', 'loinc.db']) {
      expect(exists(kept)).toBe(true);
    }
    expect(exists('hl7.terminology#6.5.0')).toBe(false);
    expect(log.lines).toContain('info: Not deleting unused package new.package#1.0.0 yet: it changed in the last day');
    expect(log.lines.some(l => /^info: Deleted 3 unused packages from the terminology cache, 0\.0 MB$/.test(l))).toBe(true);
  });

  test('only when asked to, and never by a tx-worker', async () => {
    const off = library();
    await off.load();
    expect(await off.pruneUnusedCaches()).toEqual({ files: [], packages: [] });
    expect(exists('old-loinc.db')).toBe(true);

    const worker = library();
    worker.pruneTerminologyCacheFiles = true;
    worker.packageCachesReadOnly = true;
    await worker.load();
    expect(await worker.pruneUnusedCaches()).toEqual({ files: [], packages: [] });
    expect(exists('old-loinc.db')).toBe(true);

    const on = library();
    on.pruneTerminologyCacheFiles = true;
    await on.load();
    // load alone deletes nothing: the endpoints' core packages aren't loaded yet
    expect(exists('old-loinc.db')).toBe(true);
    await use(on);
    const deleted = await on.pruneUnusedCaches();
    expect(deleted.files.sort()).toEqual(['cpt-fragment.db', 'old-loinc.db', 'old-sct.CACHE']);
    expect(deleted.packages.sort()).toEqual(['_url_temp_123#url', 'hl7.fhir.r3.core#3.0.2', 'hl7.terminology#6.5.0']);
  });
});

describe('the tx module prunes once the endpoints are set up', () => {
  const express = require('express');
  const TXModule = require('../../tx/tx');
  const LIBRARY = path.join(__dirname, 'fixtures', 'test-library.yaml');

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('pruneTerminologyCache: after every endpoint has loaded its core packages', async () => {
    const calls = [];
    jest.spyOn(Library.prototype, 'cloneWithFhirVersion').mockImplementation(async function (v) {
      calls.push('endpoint ' + v);
      return { fhirVersion: 5, valueSetProviders: [], conceptMapProviders: [], codeSystems: new Map() };
    });
    jest.spyOn(Library.prototype, 'pruneTerminologyCache').mockImplementation(async () => {
      calls.push('files');
      return [];
    });
    jest.spyOn(Library.prototype, 'prunePackages').mockImplementation(async () => {
      calls.push('packages');
      return [];
    });
    jest.spyOn(TXModule.prototype, 'selfTest').mockResolvedValue();
    const tx = new TXModule();
    try {
      await tx.initialize({ librarySource: LIBRARY, pruneTerminologyCache: true,
        endpoints: [{ path: '/p/r5', fhirVersion: '5.0' }, { path: '/p/r4', fhirVersion: '4.0' }] }, express()).catch(e => calls.push('error ' + e.message));
      expect(calls).toEqual(['endpoint 5.0', 'endpoint 4.0', 'files', 'packages']);
    } finally {
      await tx.shutdown();
    }
  });

  test('pruneTerminologyCache must be true or false', async () => {
    const tx = new TXModule();
    await expect(tx.initialize({ librarySource: LIBRARY, pruneTerminologyCache: 'yes', endpoints: [{ path: '/p/r5', fhirVersion: '5.0' }] }, express()))
      .rejects.toThrow("modules.tx.pruneTerminologyCache must be true or false, not 'yes'");
    await tx.shutdown();
  });
});
