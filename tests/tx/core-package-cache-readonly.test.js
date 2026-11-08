/**
 * A tx-worker (cluster.md) opens the FHIR core package's value set and concept map caches
 * read-only, as it does every other package's: cloneWithFhirVersion loads the core package
 * through Provider.loadNpm, which must pass packageCachesReadOnly on to the providers.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Library } = require('../../tx/library');

const PID = 'hl7.fhir.r4.core#4.0.1';
const log = { info() {}, warn() {}, error() {}, debug() {} };

function writePackage(cacheFolder) {
  const pkg = path.join(cacheFolder, PID, 'package');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'),
    JSON.stringify({ name: 'hl7.fhir.r4.core', version: '4.0.1', fhirVersions: ['4.0.1'] }));
  const vs = { resourceType: 'ValueSet', id: 'vs1', url: 'http://example.org/vs1', version: '4.0.1', status: 'active',
    compose: { include: [{ system: 'http://example.org/cs', concept: [{ code: 'a' }] }] } };
  const cm = { resourceType: 'ConceptMap', id: 'cm1', url: 'http://example.org/cm1', version: '4.0.1', status: 'active' };
  fs.writeFileSync(path.join(pkg, 'ValueSet-vs1.json'), JSON.stringify(vs));
  fs.writeFileSync(path.join(pkg, 'ConceptMap-cm1.json'), JSON.stringify(cm));
  fs.writeFileSync(path.join(pkg, '.index.json'), JSON.stringify({ 'index-version': 2, files: [
    { filename: 'ValueSet-vs1.json', resourceType: 'ValueSet', id: 'vs1', url: vs.url, version: vs.version },
    { filename: 'ConceptMap-cm1.json', resourceType: 'ConceptMap', id: 'cm1', url: cm.url, version: cm.version }
  ] }));
}

function library(cacheFolder, readOnly) {
  const lib = new Library(null, undefined, log, null);
  lib.cacheFolder = cacheFolder;
  lib.packageManager = { fetch: async () => PID };
  lib.packageCachesReadOnly = readOnly;
  return lib;
}

describe('FHIR core package caches in a tx-worker', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-ro-'));
    writePackage(dir);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the master builds them; a worker opens them read-only and leaves them unchanged', async () => {
    const master = await library(dir, false).cloneWithFhirVersion('4.0.1', null, '/r4');
    expect(master.valueSetProviders[0].readOnly).toBe(false);
    for (const p of [...master.valueSetProviders, ...master.conceptMapProviders]) {
      await p.close?.();
    }
    const files = ['.valuesets-2.db', '.conceptmaps-2.db'].map((f) => path.join(dir, PID, f));
    const before = files.map((f) => fs.readFileSync(f));

    const worker = await library(dir, true).cloneWithFhirVersion('4.0.1', null, '/r4');
    const vs = worker.valueSetProviders.find((p) => p.sourcePackage() === 'hl7.fhir.r4.core');
    const cm = worker.conceptMapProviders[0];
    expect(vs.readOnly).toBe(true);
    expect(cm.readOnly).toBe(true);
    expect(await worker.findValueSet(null, 'http://example.org/vs1', null)).toBeTruthy();
    for (const p of [...worker.valueSetProviders, ...worker.conceptMapProviders]) {
      await p.close?.();
    }
    files.forEach((f, i) => expect(fs.readFileSync(f).equals(before[i])).toBe(true));
  });
});
