'use strict';

// Library: SNOMED CT, LOINC and RxNorm from sqlite-v2 files (snomed-v2:, loinc-v2:, rxnorm-v2:
// source lines). The test file is a SNOMED CT edition built from the RF2 in tx/data/snomed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Library } = require('../../tx/library');
const folders = require('../../library/folder-setup');

const SRC = path.resolve(__dirname, '../../tx/data/snomed');
// the terminology-cache name records the file format: a file of an earlier format is not reused
const NAME = 'library-sqlite-v2-tx1-test.db';

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

// one snapshot from the test RF2's modules (as tests/tx/sqlite-v2-sct-lookup.test.js)
function mergeSnapshot(src, dst) {
  const groups = new Map();
  for (const f of walk(src)) {
    if (!f.endsWith('.txt') || /Readme/i.test(f)) continue;
    const rel = path.relative(src, f);
    const key = path.join(path.dirname(rel), path.basename(rel).replace(/_(INT|TEST1000003|LO1010000)_/, '_MERGED_'));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  for (const [k, files] of groups) {
    const out = path.join(dst, k);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, files.flatMap((f, i) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).slice(i ? 1 : 0)).join('\n') + '\n');
  }
}

let tmpDir;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-sqlite-v2-'));
  const target = path.join(folders.subDir('terminology-cache'), NAME);
  if (!fs.existsSync(target)) {
    mergeSnapshot(SRC, path.join(tmpDir, 'Snapshot'));
    const { importSnomedV2 } = require('../../tx/importers/import-sct-v2.module');
    await importSnomedV2({ source: path.join(tmpDir, 'Snapshot'), dest: path.join(tmpDir, NAME), edition: '31000003106', version: '20250909',
      versionUri: 'http://snomed.info/xsct/31000003106/version/20250909', overwrite: true, log: () => {} });
    fs.copyFileSync(path.join(tmpDir, NAME), target);
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function load(lines) {
  const yamlPath = path.join(tmpDir, 'library.yml');
  fs.writeFileSync(yamlPath, 'base:\n  url: https://storage.googleapis.com/tx-fhir-org\nsources:\n' + lines.map(l => `  - ${l}\n`).join(''));
  const log = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const library = new Library(yamlPath, undefined, log, { addStat: jest.fn() });
  await library.load();
  return library;
}

describe('Library: sqlite-v2 source lines', () => {
  test('a library without sqlite-v2 lines loads neither the engine nor roaring', () => {
    // in a fresh process: this file's own setup has loaded the importer
    const yamlPath = path.join(tmpDir, 'plain.yml');
    fs.writeFileSync(yamlPath, 'base:\n  url: https://storage.googleapis.com/tx-fhir-org\nsources:\n  - internal:lang\n');
    const script = `
      const { Library } = require(${JSON.stringify(path.resolve(__dirname, '../../tx/library'))});
      const log = { info() {}, error() {}, warn() {}, debug() {} };
      new Library(${JSON.stringify(yamlPath)}, undefined, log, { addStat() {} }).load().then(() => {
        const loaded = Object.keys(require.cache).filter(f => f.includes('sqlite-v2') || f.includes('roaring'));
        process.stdout.write(JSON.stringify(loaded));
        process.exit(0);
      }, (e) => { console.error(e); process.exit(1); });`;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n').pop())).toEqual([]);
  });

  test('snomed-v2! registers the file\'s factory as the default SNOMED CT', async () => {
    const library = await load([`snomed-v2!:${NAME}`]);
    const factory = library.codeSystemFactories.get('http://snomed.info/sct');
    expect(factory.constructor.name).toBe('SnomedV2Factory');
    expect(library.codeSystemFactories.get('http://snomed.info/sct|' + factory.version())).toBe(factory);
  });

  test('a file that holds another code system than the type names stops the load', async () => {
    await expect(load([`loinc-v2:${NAME}`])).rejects.toThrow(/holds http:\/\/snomed.info\/sct, not http:\/\/loinc.org/);
  });
});
