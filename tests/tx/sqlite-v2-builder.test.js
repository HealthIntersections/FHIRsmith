'use strict';

// The shared final import stage of the sqlite-v2 schema: numbering invariants and stored
// sets equal to membership recomputed from the facts, on a small fixture.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { RoaringBitmap32 } = require('roaring');
const { V2Builder } = require('../../tx/importers/sqlite-v2/builder');
const { numberConcepts } = require('../../tx/importers/sqlite-v2/numbering');
const { SET_KIND } = require('../../tx/importers/sqlite-v2/sets');

let dir;
beforeAll(() => { dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

// root
// ├── B ── D ─┬─ F
// │           └─ G (also under E: polyhierarchy)
// ├── C ── E ─── G
// │        └──── H (inactive child of active E)
// └── Z (code sorts last, has no children)
// X: inactive, retired; Y: active, no links at all; Q: inactive parent of active R
// R: active, child of inactive Q only
const IS_A = 'isa';
function buildFixture(dest, { explicitPairs = null } = {}) {
  const b = new V2Builder(dest, { overwrite: true, importer: 'test' });
  b.setCodeSystem({ uri: 'http://example.org/cs', version: '1' });
  const isa = b.property({ code: IS_A, fhirType: 'code', valueKind: 'concept', isHierarchy: true });
  const colour = b.property({ code: 'colour', fhirType: 'string', valueKind: 'literal' });
  const size = b.property({ code: 'size', fhirType: 'integer', valueKind: 'literal' });
  const finding = b.property({ code: 'site', fhirType: 'code', valueKind: 'concept' });
  const inactive = new Set(['H', 'X', 'Q']);
  const c = {};
  for (const code of ['X', 'G', 'F', 'Z', 'E', 'D', 'C', 'B', 'root', 'Y', 'H', 'Q', 'R', 'S1']) {
    c[code] = b.concept(code, { active: !inactive.has(code), display: `display ${code}` });
  }
  const edges = [['B', 'root'], ['C', 'root'], ['Z', 'root'], ['D', 'B'], ['F', 'D'], ['G', 'D'], ['E', 'C'],
    ['G', 'E'], ['H', 'E'], ['R', 'Q'], ['S1', 'root']];
  for (const [ch, pa] of edges) b.link(c[ch], isa, c[pa]);
  b.link(c.F, isa, c.Z, { active: false }); // history only: not an edge
  b.link(c.F, finding, c.Y, { group: 1 });
  b.link(c.G, finding, c.Y, { group: 2 });
  b.link(c.G, finding, c.Y, { group: 3 });
  b.link(c.E, finding, c.Z, { active: false });
  b.literal(c.F, colour, 'red');
  b.literal(c.G, colour, 'red');
  b.literal(c.D, colour, 'blue');
  b.literal(c.D, size, '1');
  b.literal(c.E, size, 1);
  b.literal(c.X, colour, 'red', { active: false });
  b.refsetMember(c.S1, c.F);
  b.refsetMember(c.S1, c.X);
  b.refsetDef(c.S1, ['target'], ['s']);
  b.refsetMember(c.S1, c.G, ['T1']);
  b.designation(c.F, { language: 'en', use: { system: 'u', code: 'syn' }, term: 'eff', preferred: true });
  if (explicitPairs) for (const [d, a] of explicitPairs) b.ancestor(c[d], c[a]);
  const summary = b.finish();
  return { summary, db: new Database(dest, { readonly: true }) };
}

function sets(db) {
  const m = new Map();
  for (const r of db.prepare('SELECT kind, property_id, value, card, data FROM concept_set').all()) {
    const bm = RoaringBitmap32.deserialize(r.data, 'portable');
    expect(bm.size).toBe(r.card);
    m.set(`${r.kind}|${r.property_id}|${typeof r.value}|${r.value}`, Array.from(bm));
  }
  return m;
}
const ids = (db, codes) => codes.map(code => db.prepare('SELECT concept_id FROM concept WHERE code = ?').get(code).concept_id).sort((a, b) => a - b);

describe('sqlite-v2 numbering', () => {
  test('topological, depth-first, children in code order, active prefix', () => {
    const codes = ['r', 'a', 'b', 'c', 'x'];
    // r -> a, r -> b, a -> c, b -> c ; x inactive
    const r = numberConcepts({
      codes, active: Uint8Array.from([1, 1, 1, 1, 0]),
      childOf: Int32Array.from([1, 2, 3, 3]), parentOf: Int32Array.from([0, 0, 1, 2]),
    });
    expect(Array.from(r.order).map(i => codes[i])).toEqual(['r', 'a', 'b', 'c', 'x']);
    expect(r.activeCount).toBe(4);
  });

  test('sort key orders roots and siblings before code', () => {
    const codes = ['a', 'b', 'c'];
    const r = numberConcepts({ codes, active: Uint8Array.from([1, 1, 1]), childOf: new Int32Array(0),
      parentOf: new Int32Array(0), sortKey: Float64Array.from([2, 1, 1]) });
    expect(Array.from(r.order).map(i => codes[i])).toEqual(['b', 'c', 'a']);
  });
});

describe('sqlite-v2 final stage', () => {
  let db, summary, S;
  beforeAll(() => {
    ({ db, summary } = buildFixture(path.join(dir, 'fixture.db')));
    S = sets(db);
  });
  afterAll(() => db.close());

  test('active concepts are exactly the prefix 1..active_count', () => {
    const cs = db.prepare('SELECT concept_count, active_count FROM code_system').get();
    expect(cs).toEqual({ concept_count: 14, active_count: 11 });
    const rows = db.prepare('SELECT concept_id, active FROM concept ORDER BY concept_id').all();
    rows.forEach(r => expect(r.active).toBe(r.concept_id <= cs.active_count ? 1 : 0));
    expect(S.get(`${SET_KIND.active}|0|number|0`)).toEqual(rows.filter(r => r.active).map(r => r.concept_id));
    expect(S.get(`${SET_KIND.all}|0|number|0`)).toEqual(rows.map(r => r.concept_id));
  });

  test('depth-first order: subtrees follow their root; polyhierarchy child after its last parent', () => {
    const order = db.prepare('SELECT code FROM concept ORDER BY concept_id').all().map(r => r.code);
    // R's only parent is inactive, so R is a root among the active concepts.
    // Roots in code order (R, Y, root); G waits for its second parent E.
    expect(order).toEqual(['R', 'Y', 'root', 'B', 'D', 'F', 'C', 'E', 'G', 'S1', 'Z', 'H', 'Q', 'X']);
  });

  test('descendants of an active concept all have larger ids', () => {
    for (const [key, members] of S) {
      const [kind, , , anchor] = key.split('|');
      if (Number(kind) !== SET_KIND.descendants) continue;
      const a = Number(anchor);
      if (a <= summary.activeConcepts) members.forEach(m => expect(m).toBeGreaterThan(a));
    }
  });

  test('descendant sets equal the closure recomputed with a recursive CTE', () => {
    const anchors = db.prepare('SELECT concept_id FROM concept').all().map(r => r.concept_id);
    const stmt = db.prepare(`WITH RECURSIVE d(id) AS (
        SELECT source_id FROM concept_link l JOIN property_def p USING (property_id)
          WHERE p.is_hierarchy = 1 AND l.active = 1 AND l.target_id = ?
        UNION SELECT l.source_id FROM concept_link l JOIN property_def p USING (property_id) JOIN d ON l.target_id = d.id
          WHERE p.is_hierarchy = 1 AND l.active = 1)
      SELECT id FROM d ORDER BY id`);
    let stored = 0;
    for (const a of anchors) {
      const expected = stmt.all(a).map(r => r.id);
      const got = S.get(`${SET_KIND.descendants}|0|number|${a}`) || [];
      expect(got).toEqual(expected);
      if (expected.length) stored++;
    }
    expect(stored).toBe(summary.sets.descendants.sets);
    // spot check: G is under both D and E; the inactive history link F -> Z is not an edge
    expect(S.get(`${SET_KIND.descendants}|0|number|${ids(db, ['E'])[0]}`)).toEqual(ids(db, ['G', 'H']));
    expect(S.get(`${SET_KIND.descendants}|0|number|${ids(db, ['Z'])[0]}`)).toBeUndefined();
  });

  test('leaf = active concepts without descendants', () => {
    expect(S.get(`${SET_KIND.leaf}|0|number|0`)).toEqual(ids(db, ['F', 'G', 'R', 'S1', 'Y', 'Z']));
  });

  test('prop and hasProp sets equal the active fact rows', () => {
    const site = db.prepare("SELECT property_id FROM property_def WHERE code = 'site'").get().property_id;
    const colour = db.prepare("SELECT property_id FROM property_def WHERE code = 'colour'").get().property_id;
    const size = db.prepare("SELECT property_id FROM property_def WHERE code = 'size'").get().property_id;
    const [y] = ids(db, ['Y']);
    expect(S.get(`${SET_KIND.prop}|${site}|number|${y}`)).toEqual(ids(db, ['F', 'G']));
    expect(S.get(`${SET_KIND.prop}|${colour}|string|red`)).toEqual(ids(db, ['F', 'G']));
    expect(S.get(`${SET_KIND.prop}|${colour}|string|blue`)).toEqual(ids(db, ['D']));
    expect(S.get(`${SET_KIND.prop}|${size}|number|1`)).toEqual(ids(db, ['D', 'E'])); // '1' and 1 coerced to integer
    expect(S.get(`${SET_KIND.hasProp}|${colour}|number|0`)).toEqual(ids(db, ['D', 'F', 'G']));
    expect(S.get(`${SET_KIND.hasProp}|${site}|number|0`)).toEqual(ids(db, ['F', 'G']));

    // generic recomputation for every prop set
    for (const [key, members] of S) {
      const [kind, prop, type, value] = key.split('|');
      if (Number(kind) !== SET_KIND.prop) continue;
      const v = type === 'number' ? Number(value) : value;
      const expected = db.prepare(`SELECT source_id AS id FROM concept_link WHERE active = 1 AND property_id = ? AND target_id = ?
        UNION SELECT concept_id FROM concept_literal WHERE active = 1 AND property_id = ? AND value = ? ORDER BY 1`)
        .all(Number(prop), v, Number(prop), v).map(r => r.id);
      expect(members).toEqual(expected);
    }
  });

  test('refset membership is a set; every member row stays in refset_member (v4), [] for no fields, in arrival order', () => {
    const [s1] = ids(db, ['S1']);
    expect(S.get(`${SET_KIND.refset}|0|number|${s1}`)).toEqual(ids(db, ['F', 'G', 'X']));
    const rows = db.prepare('SELECT concept_id, fields, seq FROM refset_member WHERE fields != \'[]\'').all();
    expect(rows.map((r) => ({ concept_id: r.concept_id, fields: r.fields }))).toEqual([{ concept_id: ids(db, ['G'])[0], fields: '["T1"]' }]);
    expect(db.prepare('SELECT count(*) AS n FROM refset_member WHERE seq IS NULL').get().n).toBe(0);
  });

  test('designations are renumbered in concept order and indexed for search', () => {
    const d = db.prepare('SELECT d.*, u.code AS use_code FROM designation d JOIN designation_use u USING (use_id)').all();
    expect(d).toEqual([{ designation_id: 1, concept_id: ids(db, ['F'])[0], language: 'en', use_id: 1, term: 'eff', active: 1, preferred: 1, rank: null, use_code: 'syn' }]);
    expect(db.prepare("SELECT rowid FROM search_designation WHERE term MATCH 'eff'").all()).toEqual([{ rowid: 1 }]);
  });

  test('provenance records the run', () => {
    const p = Object.fromEntries(db.prepare('SELECT key, value FROM provenance').all().map(r => [r.key, r.value]));
    expect(p.schemaVersion).toBe('5');
    expect(JSON.parse(p.summary).concepts).toBe(14);
  });

  test('a one-block file has a unique code index', () => {
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'concept_code'").pluck().get()).toMatch(/^CREATE UNIQUE INDEX/);
  });
});

describe('sqlite-v2 designation rank (v5)', () => {
  test('0 preferred in a display refset, 1 preferred in another, 2 otherwise; written with the rows', () => {
    const dest = path.join(dir, 'rank.db');
    const b = new V2Builder(dest, { overwrite: true, importer: 'test' });
    b.setCodeSystem({ uri: 'http://example.org/cs', version: '1' });
    const c = {};
    for (const code of ['A', 'B', 'US', 'GB', 'PREF', 'ACC']) c[code] = b.concept(code, { display: code });
    const syn = { system: 's', code: 'syn' };
    const t = {};
    t.usPref = b.designation(c.A, { use: syn, term: 'us preferred' });
    t.gbPref = b.designation(c.A, { use: syn, term: 'gb preferred, us acceptable' });
    t.acc = b.designation(c.A, { use: syn, term: 'acceptable only' });
    t.fsn = b.designation(c.A, { use: { system: 's', code: 'fsn' }, term: 'fsn preferred' });
    t.none = b.designation(c.B, { use: syn, term: 'no acceptability' });
    b.acceptability(t.usPref, c.US, c.PREF);
    b.acceptability(t.usPref, c.GB, c.ACC);
    b.acceptability(t.gbPref, c.GB, c.PREF);
    b.acceptability(t.gbPref, c.US, c.ACC);
    b.acceptability(t.acc, c.US, c.ACC);
    b.acceptability(t.fsn, c.US, c.PREF);
    b.designationRank = { useSystem: 's', useCode: 'syn', preferred: 'PREF', refsets: ['US'] };
    b.finish();
    const db = new Database(dest, { readonly: true });
    expect(db.prepare('SELECT term, rank FROM designation ORDER BY designation_id').raw().all()).toEqual([
      ['us preferred', 0], ['gb preferred, us acceptable', 1], ['acceptable only', 2], ['fsn preferred', 2], ['no acceptability', 2]]);
    db.close();
  });
});

describe('sqlite-v2 explicit ancestor pairs', () => {
  test('descendant sets come from the pairs, not the edge closure', () => {
    // Path-style hierarchy: G is under E's path only.
    const pairs = [['B', 'root'], ['C', 'root'], ['D', 'root'], ['D', 'B'], ['F', 'D'], ['F', 'B'], ['F', 'root'],
      ['E', 'C'], ['E', 'root'], ['G', 'E'], ['G', 'C'], ['G', 'root'], ['Z', 'root'], ['S1', 'root']];
    const { db } = buildFixture(path.join(dir, 'pairs.db'), { explicitPairs: pairs });
    const S = sets(db);
    expect(S.get(`${SET_KIND.descendants}|0|number|${ids(db, ['D'])[0]}`)).toEqual(ids(db, ['F']));
    expect(S.get(`${SET_KIND.descendants}|0|number|${ids(db, ['E'])[0]}`)).toEqual(ids(db, ['G']));
    db.close();
  });
});
