'use strict';

// An inactive sct2_Relationship row whose typeId is also a concrete-value attribute, with a concept
// target (the UK Edition has two: retired pre-concrete-domain drug rows of 149501000000101 typed
// 1142139005 and 1142140007). A sqlite-v2 property has one value kind, so registering the type as
// concept-valued for the relationship and literal for the concrete values stopped both importers
// ("property 1142139005 defined as both concept and literal"). Main's provider never reads inactive
// relationships, so both importers leave such a row out.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { SnomedImporter } = require('../../tx/importers/import-sct.module');
const { importSnomedV2 } = require('../../tx/importers/import-sct-v2.module');
const { importSnomedV2FromCache } = require('../../tx/importers/import-sct-v2-cache.module');

const SRC = path.resolve(__dirname, '../../tx/data/snomed');
const SCT_LICENSE = path.join(SRC, 'license.txt');
const COUNT_OF_BASE = '1142139005'; // a concrete attribute of the fixture (#1 on 329238006 and 776168003)
const SOURCE = '329238006', TARGET = '776168003';
let dir, snap;

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
}

// one file per kind, as the RF2 v2 importer reads (as sqlite-v2-sct-from-cache.test.js)
function mergeSnapshot(src, dst) {
  const groups = new Map();
  for (const f of walk(src)) {
    if (!f.endsWith('.txt')) continue;
    const rel = path.relative(src, f);
    const key = path.join(path.dirname(rel), path.basename(rel).replace(/_(INT|TEST1000003|LO1010000)_/, '_MERGED_'));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  for (const [k, files] of groups) {
    const out = path.join(dst, k);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const lines = files.flatMap((f, i) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).slice(i ? 1 : 0));
    fs.writeFileSync(out, lines.join('\n') + '\n');
  }
}

function links(db, code) {
  const d = new Database(db, { readonly: true });
  try {
    const kind = d.prepare('SELECT value_kind FROM property_def WHERE code = ?').get(code);
    const n = d.prepare('SELECT count(*) AS n FROM concept_link l JOIN property_def p USING (property_id) WHERE p.code = ?').get(code).n;
    const lit = d.prepare('SELECT count(*) AS n FROM concept_literal l JOIN property_def p USING (property_id) WHERE p.code = ?').get(code).n;
    return { kind: kind && kind.value_kind, links: n, literals: lit };
  } finally { d.close(); }
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sct-concrete-type-'));
  snap = path.join(dir, 'Snapshot');
  mergeSnapshot(SRC, snap);
  const rel = walk(snap).find((f) => /sct2_Relationship_Snapshot_/.test(path.basename(f)));
  fs.appendFileSync(rel, ['9990011000003121', '20200101', '0', '31000003106', SOURCE, TARGET, '0', COUNT_OF_BASE,
    '900000000000011006', '900000000000451002'].join('\t') + '\n');
}, 30000);

afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('RF2: the inactive row is left out and the attribute stays literal', async () => {
  const db = path.join(dir, 'rf2.db');
  const summary = await importSnomedV2({ source: snap, dest: db, edition: '31000003106', version: '20250909', overwrite: true,
    normalForms: false, log: () => {} });
  expect(summary.importer.inactiveConcreteTypeRelationshipsSkipped).toBe(1);
  expect(links(db, COUNT_OF_BASE)).toEqual({ kind: 'literal', links: 0, literals: 4 });
}, 120000);

test('cache: the same row from main\'s cache is left out too', async () => {
  const cache = path.join(dir, 't.cache');
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await new SnomedImporter({ source: snap, dest: cache, edition: '31000003106', version: '20250909',
      uri: 'http://snomed.info/sct/31000003106/version/20250909', language: 'en-US', license: SCT_LICENSE, verbose: false, overwrite: true }).run();
  } finally { quiet.mockRestore(); }
  const db = path.join(dir, 'rev.db');
  const summary = await importSnomedV2FromCache({ source: cache, dest: db, overwrite: true, normalForms: false, log: () => {} });
  expect(summary.importer.inactiveConcreteTypeRelationshipsSkipped).toBe(1);
  expect(links(db, COUNT_OF_BASE)).toEqual({ kind: 'literal', links: 0, literals: 4 });
}, 120000);
