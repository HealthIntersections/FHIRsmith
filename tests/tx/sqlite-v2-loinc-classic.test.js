'use strict';

// Reverse loader (FHIRsmith classic LOINC db -> terminology file, import-loinc-v2-classic.module.js): build
// a classic db from the LOINC test fixture in tx/data/loinc with main's importer, reverse-load it,
// and compare with the CSV import of the same release. Every concept, link, literal, item
// and stored set must agree; what a classic file cannot carry is the answers' SequenceNumber (the
// list order stands in for it, so the order of each list agrees). Then the shape of older classic
// files (loinc-2.77-a.db): a blank Answer code '' shared by the externally defined lists, and
// CLASSTYPE stored as its description.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { importLoincV2 } = require('../../tx/importers/import-loinc-v2.module');
const { importLoincV2FromClassic } = require('../../tx/importers/import-loinc-v2-classic.module');
const { LoincDataMigrator } = require('../../tx/importers/import-loinc.module');
const { diffFiles } = require('../../tx/importers/sqlite-v2/diff');
const { openStore } = require('../../tx/sqlite-v2/store');

const SRC = path.resolve(__dirname, '../../tx/data/loinc');
const VERSION = '2.80-test';
let dir, report, summary;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'loinc-from-classic-'));
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await new LoincDataMigrator().migrate(SRC, path.join(dir, 'classic.db'), VERSION, { verbose: false, mainOnly: false });
  } finally { quiet.mockRestore(); }
  await importLoincV2({ source: SRC, dest: path.join(dir, 'csv.db'), version: VERSION, overwrite: true, log: () => {} });
  summary = await importLoincV2FromClassic({ source: path.join(dir, 'classic.db'), dest: path.join(dir, 'rev.db'), overwrite: true, log: () => {} });
  report = diffFiles(path.join(dir, 'csv.db'), path.join(dir, 'rev.db'), { examples: 20 });
}, 120000);

afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('the same concepts, numbered the same, with the version from the classic Config', () => {
  expect(summary.concepts).toBe(report.codeSystem_a.concept_count);
  expect(summary.concepts).toBe(483); // 322 terms + 147 parts + 3 answer lists + 8 answers + 3 hierarchy-only nodes
  expect(report.codeSystem_b).toEqual(report.codeSystem_a);
  expect(report.codeSystem_b.version).toBe(VERSION);
  expect(report.facts.concept.onlyA + report.facts.concept.onlyB).toBe(0);
  expect(report.sets.identicalNumbering).toBe(true);
});

test.each(['link', 'literal', 'item', 'item_use', 'property', 'property_member', 'value_label'])('%s: every row agrees', (name) => {
  const f = report.facts[name];
  expect([f.onlyA, f.onlyB, report.tables[name].a]).toEqual([0, 0, report.tables[name].b]);
});

test('external maps agree (main stores them in ExternalCodes / ExternalMappings)', () => {
  const f = report.facts.mapping;
  expect(report.tables.mapping.a).toBe(report.tables.mapping.b);
  expect([f.onlyA, f.onlyB]).toEqual([0, 0]);
});

test('every stored set agrees: descendants (path closure), properties, has-property', () => {
  for (const [kind, s] of Object.entries(report.sets.byKind)) {
    expect({ kind, differ: s.differ, onlyA: s.onlyA, onlyB: s.onlyB }).toEqual({ kind, differ: 0, onlyA: 0, onlyB: 0 });
  }
});

test('the hierarchy order ($lookup parent and child) agrees: the classic Relationships rows against the release file', () => {
  // each concept's entries as the reader gives them (stored arrays, or the parent links merged by seq)
  const entries = (f) => {
    const S = openStore(f, { unregistered: true });
    try {
      const code = (id) => S.conceptRows([id]).get(id).code;
      const out = [];
      for (let id = 1; id <= S.conceptCount; id++) {
        const e = S.hierarchyOrderOf(id);
        if (e && e.length) out.push([code(id), [...e].map((x) => (x & 0x80000000 ? 'c' : 'p') + code(x & 0x7fffffff))]);
      }
      return out;
    } finally { S.close(); }
  };
  const a = entries(path.join(dir, 'csv.db'));
  expect(a.length).toBeGreaterThan(20);
  expect(entries(path.join(dir, 'rev.db'))).toEqual(a);
});

test('answer lists keep their order (the classic file has no SequenceNumber)', () => {
  const order = (file) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.prepare(`SELECT r.code list, group_concat(c.code) members FROM (SELECT l.* FROM link l JOIN property p ON p.id = l.property_id
          WHERE p.code = 'Answer' ORDER BY l.subject_id, l.seq, l.target_id) m
        JOIN concept r ON r.id = m.subject_id JOIN concept c ON c.id = m.target_id GROUP BY r.code ORDER BY r.code`).all();
    } finally { db.close(); }
  };
  const a = order(path.join(dir, 'csv.db'));
  expect(a.length).toBeGreaterThan(0);
  expect(order(path.join(dir, 'rev.db'))).toEqual(a);
});

test('the system order (main\'s key order and whole-system walk, ix_order) agrees', () => {
  const arrays = (file) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.prepare("SELECT name, hex(group_concat(data, x'')) FROM (SELECT name, data FROM ix_order WHERE name IN ('rank', 'ids', 'walk', 'active') ORDER BY name, block) GROUP BY name ORDER BY name").raw().all();
    } finally { db.close(); }
  };
  const a = arrays(path.join(dir, 'csv.db'));
  expect(a.map((r) => r[0])).toEqual(['active', 'ids', 'rank', 'walk']);
  expect(arrays(path.join(dir, 'rev.db'))).toEqual(a);
});

test('an older classic file: the blank Answer code is dropped with its links, CLASSTYPE comes back as its code', async () => {
  const old = path.join(dir, 'old.db');
  fs.copyFileSync(path.join(dir, 'classic.db'), old);
  const db = new Database(old);
  const k = db.prepare('SELECT max(CodeKey) + 1 FROM Codes').pluck().get();
  db.prepare("INSERT INTO Codes (CodeKey, Code, Type, RelationshipKey, StatusKey, Description) VALUES (?, '', 4, NULL, 0, '')").run(k);
  const list = db.prepare("SELECT CodeKey FROM Codes WHERE Type = 3 ORDER BY CodeKey LIMIT 1").pluck().get();
  const rk = db.prepare('SELECT max(RelationshipKey) + 1 FROM Relationships').pluck().get();
  const rel = (t) => db.prepare('SELECT RelationshipTypeKey FROM RelationshipTypes WHERE Description = ?').pluck().get(t);
  db.prepare('INSERT INTO Relationships VALUES (?, ?, ?, ?, 0)').run(rk, rel('Answer'), list, k);
  db.prepare('INSERT INTO Relationships VALUES (?, ?, ?, ?, 0)').run(rk + 1, rel('AnswerList'), k, list);
  // CLASSTYPE as the older importer stored it
  const ct = db.prepare("SELECT PropertyTypeKey FROM PropertyTypes WHERE Description = 'CLASSTYPE'").pluck().get();
  const names = { 1: 'Laboratory class', 2: 'Clinical class', 3: 'Claims attachment', 4: 'Surveys' };
  for (const [code, name] of Object.entries(names)) {
    db.prepare(`UPDATE PropertyValues SET Value = ? WHERE Value = ? AND PropertyValueKey IN (SELECT PropertyValueKey FROM Properties WHERE PropertyTypeKey = ?)`).run(name, code, ct);
  }
  db.close();
  const s = await importLoincV2FromClassic({ source: old, dest: path.join(dir, 'old-rev.db'), overwrite: true, log: () => {} });
  expect([s.concepts, s.importer.blankCodesDropped, s.importer.linksToDropped]).toEqual([483, 1, 1]);
  const r = diffFiles(path.join(dir, 'csv.db'), path.join(dir, 'old-rev.db'));
  for (const name of ['concept', 'link', 'literal', 'item']) expect([name, r.facts[name].onlyA, r.facts[name].onlyB]).toEqual([name, 0, 0]);
  for (const s2 of Object.values(r.sets.byKind)) expect([s2.differ, s2.onlyA, s2.onlyB]).toEqual([0, 0, 0]);
});

test('a version that does not match the classic Config is refused', async () => {
  await expect(importLoincV2FromClassic({ source: path.join(dir, 'classic.db'), dest: path.join(dir, 'x.db'), version: '9.99', overwrite: true, log: () => {} }))
    .rejects.toThrow(/classic db says 2.80-test/);
});
