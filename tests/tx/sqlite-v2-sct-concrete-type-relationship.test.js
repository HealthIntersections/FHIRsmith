'use strict';

// An inactive sct2_Relationship row whose typeId is also a concrete-value attribute, with a concept
// target (the UK Edition has two: retired pre-concrete-domain drug rows of 149501000000101 typed
// 1142139005 and 1142140007). Both importers keep the row, as a link of that attribute, whose
// catalog row then has shape 'both' (links and literals). Main's provider never reads inactive
// relationships, nor links of a concrete attribute: the reader leaves them out where no property
// is named (READER_RULES unnamedLinksSkipBoth), so $lookup is main's.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openStore } = require('../../tx/sqlite-v2/store');
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

/** the attribute's catalog shape, its rows, and the links the reader gives a $lookup of the source */
function rows(db, code) {
  const d = new Database(db, { readonly: true });
  let p, links, literals;
  try {
    p = d.prepare('SELECT id, shape FROM property WHERE code = ?').get(code);
    links = d.prepare('SELECT count(*) FROM link WHERE property_id = ?').pluck().get(p.id);
    literals = d.prepare('SELECT count(*) FROM literal WHERE property_id = ?').pluck().get(p.id);
  } finally { d.close(); }
  const S = openStore(db, { unregistered: true });
  try {
    const unnamed = S.linksFrom([S.idOf(SOURCE)], null, false).filter((l) => l.p === p.id).length;
    const named = S.linksFrom([S.idOf(SOURCE)], new Set([p.id]), false).length;
    return { shape: p.shape, links, literals, unnamed, named };
  } finally { S.close(); }
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

test('RF2: the inactive row is a link of the attribute (shape both), not read by an unnamed lookup', async () => {
  const db = path.join(dir, 'rf2.db');
  const summary = await importSnomedV2({ source: snap, dest: db, edition: '31000003106', version: '20250909', overwrite: true,
    normalForms: false, log: () => {} });
  expect(summary.importer.concreteTypeLinks).toBe(1);
  expect(rows(db, COUNT_OF_BASE)).toEqual({ shape: 'both', links: 1, literals: 4, unnamed: 0, named: 1 });
}, 120000);

test('cache: the same row from main\'s cache, the same way', async () => {
  const cache = path.join(dir, 't.cache');
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await new SnomedImporter({ source: snap, dest: cache, edition: '31000003106', version: '20250909',
      uri: 'http://snomed.info/sct/31000003106/version/20250909', language: 'en-US', license: SCT_LICENSE, verbose: false, overwrite: true }).run();
  } finally { quiet.mockRestore(); }
  const db = path.join(dir, 'rev.db');
  const summary = await importSnomedV2FromCache({ source: cache, dest: db, overwrite: true, normalForms: false, log: () => {} });
  expect(summary.importer.concreteTypeLinks).toBe(1);
  expect(rows(db, COUNT_OF_BASE)).toEqual({ shape: 'both', links: 1, literals: 4, unnamed: 0, named: 1 });
}, 120000);
