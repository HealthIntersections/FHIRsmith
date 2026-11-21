'use strict';

// Reverse loader (FHIRsmith SNOMED cache -> sqlite-v2): build a cache from the test edition RF2 in
// tx/data/snomed with main's cache importer, reverse-load it, and compare with the RF2 v2 import of
// the same files. Every fact and every stored set must agree, except what the cache cannot carry:
// here, refset fields naming concepts that are not in the edition.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { SnomedImporter } = require('../../tx/importers/import-sct.module');
// main's importer requires the license the edition is distributed under (cache format 21)
const SCT_LICENSE = path.join(__dirname, '../../tx/data/snomed/license.txt');
const { importSnomedV2 } = require('../../tx/importers/import-sct-v2.module');
const { importSnomedV2FromCache, readCache } = require('../../tx/importers/import-sct-v2-cache.module');
const { SnomedFileReader } = require('../../tx/sct/structures');
const { diffV2 } = require('../../tx/importers/sqlite-v2/diff');

const SRC = path.resolve(__dirname, '../../tx/data/snomed');
let dir, report, cacheSummary, olderSummary, olderReport;

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
}

// The fixture is split by module (INT, TEST1000003, LO1010000); the RF2 v2 importer reads one
// concept / relationship file, so merge each kind into one Snapshot file first.
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

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sct-from-cache-'));
  const snap = path.join(dir, 'Snapshot');
  mergeSnapshot(SRC, snap);
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await new SnomedImporter({ source: snap, dest: path.join(dir, 't.cache'), edition: '31000003106', version: '20250909',
      uri: 'http://snomed.info/sct/31000003106/version/20250909', language: 'en-US', license: SCT_LICENSE, verbose: false, overwrite: true }).run();
  } finally { quiet.mockRestore(); }
  await importSnomedV2({ source: snap, dest: path.join(dir, 'rf2.db'), edition: '31000003106', version: '20250909', overwrite: true, log: () => {} });
  cacheSummary = await importSnomedV2FromCache({ source: path.join(dir, 't.cache'), dest: path.join(dir, 'rev.db'), overwrite: true, log: () => {} });
  report = diffV2(path.join(dir, 'rf2.db'), path.join(dir, 'rev.db'), { examples: 50 });
  // the same edition in cache format 20 (main's server reads only 21; this importer reads both)
  writeFormat20(await new SnomedFileReader(path.join(dir, 't.cache')).loadSnomedData(), path.join(dir, 't20.cache'));
  olderSummary = await importSnomedV2FromCache({ source: path.join(dir, 't20.cache'), dest: path.join(dir, 'rev20.db'), overwrite: true, log: () => {} });
  olderReport = diffV2(path.join(dir, 'rev.db'), path.join(dir, 'rev20.db'), { examples: 50 });
}, 120000);

/**
 * A cache in format 20's layout (tx/sct/structures.js before 1.0.5), from a format-21 cache's
 * sections: no license or text indexes; empty words and stems sections (nothing read them)
 */
function writeFormat20(d, file) {
  const out = [];
  const str = (t) => { const b = Buffer.from(t, 'utf8'); out.push(Buffer.from([6, b.length]), b); };
  const int = (n) => { const b = Buffer.alloc(5); b.writeUInt8(4, 0); b.writeInt32LE(n, 1); out.push(b); };
  const bytes = (b) => { int(b.length); out.push(Buffer.from(b)); };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); out.push(b); };
  str('20'); str(d.versionUri); str(d.versionDate);
  bytes(d.strings); bytes(d.refs); bytes(d.desc); bytes(Buffer.alloc(0)); bytes(Buffer.alloc(0));
  bytes(d.concept); bytes(d.rel); bytes(d.refSetIndex); bytes(d.refSetMembers); bytes(d.descRef);
  int(d.isAIndex);
  int(d.inactiveRoots.length); d.inactiveRoots.forEach(u64);
  int(d.activeRoots.length); d.activeRoots.forEach(u64);
  int(d.defaultLanguage);
  bytes(Buffer.from(JSON.stringify(d.identifiers)));
  bytes(Buffer.from(JSON.stringify(d.concreteValues)));
  fs.writeFileSync(file, Buffer.concat(out));
}

afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('the current cache format carries everything else', () => {
  expect(cacheSummary.importer.cacheVersion).toBe('21');
  expect(cacheSummary.importer.cacheWarnings).toEqual([]);
});

test('an older cache format (20, which main\'s server no longer reads) gives the same file', async () => {
  expect(SnomedFileReader.isCurrent(path.join(dir, 't20.cache'))).toBe(false);
  await expect(new SnomedFileReader(path.join(dir, 't20.cache')).loadSnomedData()).rejects.toThrow(/only reads format 21/);
  const d = await readCache(path.join(dir, 't20.cache'));
  expect([d.cacheVersion, d.hasLangs, d.concreteValues !== null]).toEqual(['20', true, true]);
  expect(olderSummary.importer.cacheVersion).toBe('20');
  expect(olderSummary.importer.cacheWarnings).toEqual([]);
  for (const [f, x] of Object.entries(olderReport.facts)) expect([f, x.onlyA, x.onlyB]).toEqual([f, 0, 0]);
  expect(olderReport.sets.identicalNumbering).toBe(true);
  for (const [kind, x] of Object.entries(olderReport.sets.byKind)) expect([kind, x.differ, x.onlyA, x.onlyB]).toEqual([kind, 0, 0, 0]);
});

test('a cache format this importer does not know is refused', async () => {
  const bad = path.join(dir, 'bad.cache');
  fs.writeFileSync(bad, Buffer.concat([Buffer.from([6, 2]), Buffer.from('15'), Buffer.alloc(16)]));
  await expect(readCache(bad)).rejects.toThrow(/format 15 is not one this importer reads/);
});

test('concepts, links, literals, designations, acceptability and identifiers are identical', () => {
  for (const f of ['concept', 'link', 'literal', 'designation', 'acceptability', 'alternate_identifier', 'refset_def', 'property_def']) {
    expect([f, report.facts[f].onlyA, report.facts[f].onlyB]).toEqual([f, 0, 0]);
  }
});

test('numbering and every stored set are identical', () => {
  expect(report.sets.identicalNumbering).toBe(true);
  for (const [kind, s] of Object.entries(report.sets.byKind)) {
    expect([kind, s.differ, s.onlyA, s.onlyB]).toEqual([kind, 0, 0, 0]);
  }
});

test('refset members differ only where a field names a concept missing from the edition', () => {
  const r = report.facts.refset_member;
  expect(r.onlyA).toBe(r.onlyB);
  const a = new Map(r.examplesA.map((x) => [`${x.refset}|${x.concept}`, JSON.parse(x.fields)]));
  for (const x of r.examplesB) {
    const fa = a.get(`${x.refset}|${x.concept}`);
    expect(fa).toBeDefined();
    const fb = JSON.parse(x.fields);
    fb.forEach((v, i) => { if (v !== fa[i]) expect(v).toBe(''); });
  }
  expect(cacheSummary.importer.unknownFieldValues).toBe(r.onlyB);
});

test('link_order: the cache\'s record order gives the same parents and children order as the RF2 rows', () => {
  const Database = require('better-sqlite3');
  const order = (file) => {
    const db = new Database(file, { readonly: true });
    try {
      const q = (by, other) => db.prepare(`SELECT a.code k, group_concat(b.code) v FROM (SELECT * FROM link_order WHERE active = 1 AND group_id = 0
        AND property_id = (SELECT property_id FROM property_def WHERE is_hierarchy = 1) ORDER BY ${by}, seq) l
        JOIN concept a ON a.concept_id = l.${by} JOIN concept b ON b.concept_id = l.${other} GROUP BY a.code ORDER BY a.code`).all();
      return { children: q('target_id', 'source_id'), parents: q('source_id', 'target_id') };
    } finally { db.close(); }
  };
  const a = order(path.join(dir, 'rf2.db'));
  expect(a.children.length).toBeGreaterThan(100);
  expect(order(path.join(dir, 'rev.db'))).toEqual(a);
});

describe('system_order (tx/sqlite-v2/orders.js)', () => {
  const Database = require('better-sqlite3');
  const { computeOrder, storedOrder, builtOrder } = require('../../tx/sqlite-v2/orders');
  const { addSystemOrder } = require('../../tx/importers/sqlite-v2/add-system-order');
  const { V2Store } = require('../../tx/sqlite-v2/store');
  const blobs = (file) => {
    const db = new Database(file, { readonly: true });
    try { return db.prepare('SELECT name, length, reached, data FROM system_order ORDER BY name').raw().all(); } finally { db.close(); }
  };

  test('both importers store the same orders, equal to those computed from the rows', () => {
    const a = blobs(path.join(dir, 'rf2.db'));
    expect(a.map((r) => r[0])).toEqual(['ids', 'rank', 'walk']);
    expect(blobs(path.join(dir, 'rev.db'))).toEqual(a);
    const db = new Database(path.join(dir, 'rf2.db'), { readonly: true });
    try {
      const want = computeOrder(db, 'snomed');
      const n = db.prepare('SELECT concept_count FROM code_system').pluck().get();
      expect([want.rank.length, want.ids.length, want.walk.length]).toEqual([n + 1, n + 1, n]);
      expect(a.find((r) => r[0] === 'walk')[2]).toBe(want.walk.reached);
      expect(want.walk.reached).toBeGreaterThan(n / 2);
      expect(want.walk.reached).toBeLessThan(n);
      for (const r of a) expect(Buffer.compare(r[3], Buffer.from(want[r[0]].buffer))).toBe(0);
    } finally { db.close(); }
  });

  test('read lazily: no array until used; the same arrays as the load-time computation of a file without the table', () => {
    const old = path.join(dir, 'no-order.db');
    fs.copyFileSync(path.join(dir, 'rf2.db'), old);
    { const db = new Database(old); db.exec('DROP TABLE system_order'); db.close(); }
    const s1 = new V2Store(path.join(dir, 'rf2.db'), { unregistered: true });
    const s2 = new V2Store(old, { unregistered: true });
    try {
      const stored = storedOrder(s1, 'snomed');
      expect(stored.loadedBytes()).toBe(0);
      expect([stored.selfFirst, stored.hasWalk]).toEqual([true, true]);
      const built = builtOrder(s2.withoutMmap(() => computeOrder(s2.db, 'snomed', s2.conceptCount)), 'snomed');
      expect([...stored.rank]).toEqual([...built.rank]);
      expect(stored.loadedBytes()).toBe(stored.rank.byteLength);
      expect([...stored.ids]).toEqual([...built.ids]);
      expect([...stored.walk]).toEqual([...built.walk]);
      expect(stored.walk.reached).toBe(built.walk.reached);
      expect(stored.loadedBytes()).toBe(built.loadedBytes());
    } finally { s1.close(); s2.close(); }
    // add-system-order.js writes the same table into the old file
    const r = addSystemOrder(old);
    expect([r.kind, r.reached]).toEqual(['snomed', blobs(path.join(dir, 'rf2.db')).find((x) => x[0] === 'walk')[2]]);
    expect(blobs(old)).toEqual(blobs(path.join(dir, 'rf2.db')));
  });
});
