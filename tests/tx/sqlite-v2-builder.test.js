'use strict';

// The terminology file builder (tx/importers/sqlite-v2/builder.js) and index builder (indexes.js)
// on a small fixture: numbering invariants, items above concepts, the catalog's computed fields,
// stored sets equal to membership recomputed from the facts, the derived display rank, identifiers
// accepted as codes, and the format checks a reader makes before it reads a table.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { RoaringBitmap32 } = require('roaring');
const { TerminologyBuilder, FORMAT } = require('../../tx/importers/sqlite-v2/builder');
const { buildIndexes } = require('../../tx/importers/sqlite-v2/indexes');
const { numberConcepts } = require('../../tx/importers/sqlite-v2/numbering');
const { SET_KIND } = require('../../tx/importers/sqlite-v2/sets');
const { openStore } = require('../../tx/sqlite-v2/store');

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
// R: active, child of inactive Q only; S1: a reference set (record relation) with three members
function buildFixture(dest, { explicitPairs = null } = {}) {
  const b = new TerminologyBuilder(dest, { overwrite: true, importer: 'test' });
  b.codeSystem({ uri: 'http://example.org/cs', version: '1' });
  const isa = b.property({ code: 'isa', shape: 'link', subsumption: true });
  const colour = b.property({ code: 'colour', shape: 'literal', fhirType: 'string' });
  const size = b.property({ code: 'size', shape: 'literal', fhirType: 'integer' });
  const site = b.property({ code: 'site', shape: 'link' });
  const note = b.property({ code: 'note', shape: 'literal', fhirType: 'string', filterable: false });
  const inactive = new Set(['H', 'X', 'Q']);
  const c = {};
  for (const code of ['X', 'G', 'F', 'Z', 'E', 'D', 'C', 'B', 'root', 'Y', 'H', 'Q', 'R', 'S1']) {
    c[code] = b.concept(code, { active: !inactive.has(code), display: `display ${code}` });
  }
  const edges = [['B', 'root'], ['C', 'root'], ['Z', 'root'], ['D', 'B'], ['F', 'D'], ['G', 'D'], ['E', 'C'],
    ['G', 'E'], ['H', 'E'], ['R', 'Q'], ['S1', 'root']];
  for (const [ch, pa] of edges) b.link(c[ch], isa, c[pa]);
  b.link(c.F, isa, c.Z, { active: false }); // history only: not an edge
  b.link(c.F, site, c.Y, { group: 1 });
  b.link(c.G, site, c.Y, { group: 2 });
  b.link(c.G, site, c.Y, { group: 3 });
  b.link(c.E, site, c.Z, { active: false });
  b.literal(c.F, colour, 'red');
  b.literal(c.G, colour, 'red');
  b.literal(c.D, colour, 'blue');
  b.literal(c.D, size, '1');
  b.literal(c.E, size, 1);
  b.literal(c.X, colour, 'red', { active: false });
  b.literal(c.F, note, 'a note');
  const s1 = b.property({ code: 'S1', shape: 'record', concept: c.S1, fields: [{ name: 'target', type: 's' }] });
  b.record(s1, c.F, { fields: [null] });
  b.record(s1, c.X, { fields: [null] });
  b.record(s1, c.G, { fields: ['T1'] });
  b.item(c.F, { language: 'en', use: { system: 'u', code: 'syn' }, text: 'eff', preferred: true });
  if (explicitPairs) {
    const anc = b.property({ code: 'ancestor', shape: 'link', filterable: false });
    b.setClosureFrom(isa, anc);
    for (const [d, a] of explicitPairs) b.link(c[d], anc, c[a]);
  }
  const summary = b.finish();
  return { summary, db: new Database(dest, { readonly: true }) };
}

function sets(db) {
  const m = new Map();
  for (const r of db.prepare('SELECT kind, property_id, value, card, data FROM ix_set').all()) {
    const bm = RoaringBitmap32.deserialize(r.data, 'portable');
    expect(bm.size).toBe(r.card);
    m.set(`${r.kind}|${r.property_id}|${typeof r.value}|${r.value}`, Array.from(bm));
  }
  return m;
}
const ids = (db, codes) => codes.map(code => db.prepare('SELECT id FROM concept WHERE code = ?').pluck().get(code)).sort((a, b) => a - b);
const pid = (db, code) => db.prepare('SELECT id FROM property WHERE code = ?').pluck().get(code);

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

describe('sqlite-v2 terminology file builder', () => {
  let db, summary, S;
  beforeAll(() => {
    ({ db, summary } = buildFixture(path.join(dir, 'fixture.db')));
    S = sets(db);
  });
  afterAll(() => db.close());

  test('active concepts are exactly the prefix 1..active_count; items above every concept', () => {
    const cs = db.prepare('SELECT concept_count, active_count FROM code_system WHERE served = 1').get();
    expect(cs).toEqual({ concept_count: 14, active_count: 11 });
    const rows = db.prepare('SELECT id, active FROM concept ORDER BY id').all();
    rows.forEach(r => expect(r.active).toBe(r.id <= cs.active_count ? 1 : 0));
    expect(S.get(`${SET_KIND.active}|0|number|0`)).toEqual(rows.filter(r => r.active).map(r => r.id));
    expect(S.get(`${SET_KIND.all}|0|number|0`)).toEqual(rows.map(r => r.id));
    expect(db.prepare('SELECT min(id) FROM item').pluck().get()).toBe(15);
  });

  test('depth-first order: subtrees follow their root; polyhierarchy child after its last parent', () => {
    const order = db.prepare('SELECT code FROM concept ORDER BY id').all().map(r => r.code);
    // R's only parent is inactive, so R is a root among the active concepts.
    // Roots in code order (R, Y, root); G waits for its second parent E.
    expect(order).toEqual(['R', 'Y', 'root', 'B', 'D', 'F', 'C', 'E', 'G', 'S1', 'Z', 'H', 'Q', 'X']);
  });

  test('the catalog\'s computed fields: rows, subject and target kinds, by_target for the hierarchy', () => {
    const row = (code) => db.prepare('SELECT shape, subject_kind, target_kind, n_rows, by_target, filterable FROM property WHERE code = ?').get(code);
    expect(row('isa')).toEqual({ shape: 'link', subject_kind: 'concept', target_kind: 'concept', n_rows: 12, by_target: 1, filterable: 1 });
    expect(row('colour')).toEqual({ shape: 'literal', subject_kind: 'concept', target_kind: null, n_rows: 4, by_target: 0, filterable: 1 });
    expect(row('S1')).toEqual({ shape: 'record', subject_kind: 'concept', target_kind: null, n_rows: 3, by_target: 0, filterable: 1 });
  });

  test('descendant sets equal the closure recomputed with a recursive CTE', () => {
    const anchors = db.prepare('SELECT id FROM concept').pluck().all();
    const stmt = db.prepare(`WITH RECURSIVE d(id) AS (
        SELECT subject_id FROM link l JOIN property p ON p.id = l.property_id
          WHERE p.subsumption = 1 AND l.active = 1 AND l.target_id = ?
        UNION SELECT l.subject_id FROM link l JOIN property p ON p.id = l.property_id JOIN d ON l.target_id = d.id
          WHERE p.subsumption = 1 AND l.active = 1)
      SELECT id FROM d ORDER BY id`);
    let stored = 0;
    for (const a of anchors) {
      const expected = stmt.pluck().all(a);
      const got = S.get(`${SET_KIND.descendants}|0|number|${a}`) || [];
      expect(got).toEqual(expected);
      if (expected.length) stored++;
    }
    expect(stored).toBe(summary.indexes.sets.descendants.sets);
    // spot check: G is under both D and E; the inactive history link F -> Z is not an edge
    expect(S.get(`${SET_KIND.descendants}|0|number|${ids(db, ['E'])[0]}`)).toEqual(ids(db, ['G', 'H']));
    expect(S.get(`${SET_KIND.descendants}|0|number|${ids(db, ['Z'])[0]}`)).toBeUndefined();
  });

  test('leaf = active concepts without descendants', () => {
    expect(S.get(`${SET_KIND.leaf}|0|number|0`)).toEqual(ids(db, ['F', 'G', 'R', 'S1', 'Y', 'Z']));
  });

  test('prop sets (filterable properties only) and has-property sets equal the active fact rows', () => {
    const site = pid(db, 'site'), colour = pid(db, 'colour'), size = pid(db, 'size'), note = pid(db, 'note');
    const [y] = ids(db, ['Y']);
    expect(S.get(`${SET_KIND.prop}|${site}|number|${y}`)).toEqual(ids(db, ['F', 'G']));
    expect(S.get(`${SET_KIND.prop}|${colour}|string|red`)).toEqual(ids(db, ['F', 'G']));
    expect(S.get(`${SET_KIND.prop}|${colour}|string|blue`)).toEqual(ids(db, ['D']));
    expect(S.get(`${SET_KIND.prop}|${size}|number|1`)).toEqual(ids(db, ['D', 'E'])); // '1' and 1 coerced to integer
    expect(S.get(`${SET_KIND.hasProp}|${colour}|number|0`)).toEqual(ids(db, ['D', 'F', 'G']));
    expect(S.get(`${SET_KIND.hasProp}|${site}|number|0`)).toEqual(ids(db, ['F', 'G']));
    // a property no filter can name has its has-property set and no property = value sets
    expect(S.get(`${SET_KIND.prop}|${note}|string|a note`)).toBeUndefined();
    expect(S.get(`${SET_KIND.hasProp}|${note}|number|0`)).toEqual(ids(db, ['F']));

    // generic recomputation for every prop set
    for (const [key, members] of S) {
      const [kind, prop, type, value] = key.split('|');
      if (Number(kind) !== SET_KIND.prop) continue;
      const v = type === 'number' ? Number(value) : value;
      const expected = db.prepare(`SELECT subject_id FROM link WHERE active = 1 AND property_id = ? AND target_id = ?
        UNION SELECT subject_id FROM literal WHERE active = 1 AND property_id = ? AND value = ? ORDER BY 1`)
        .pluck().all(Number(prop), v, Number(prop), v);
      expect(members).toEqual(expected);
    }
  });

  test('record members are a set (inactive concepts too); rows keep their fields in arrival order', () => {
    const s1 = pid(db, 'S1');
    expect(S.get(`${SET_KIND.refset}|${s1}|number|0`)).toEqual(ids(db, ['F', 'G', 'X']));
    const rows = db.prepare('SELECT c.code, r.seq, r.fields FROM record r JOIN concept c ON c.id = r.subject_id WHERE relation_id = ? ORDER BY r.seq').raw().all(s1);
    expect(rows).toEqual([['F', 0, '[null]'], ['X', 1, '[null]'], ['G', 2, '["T1"]']]);
  });

  test('items are renumbered in concept order and indexed for search', () => {
    const d = db.prepare('SELECT i.id, i.concept_id, i.language, i.text, i.active, i.preferred, u.code AS use FROM item i JOIN item_use u USING (use_id)').all();
    expect(d).toEqual([{ id: 15, concept_id: ids(db, ['F'])[0], language: 'en', text: 'eff', active: 1, preferred: 1, use: 'syn' }]);
    expect(db.prepare("SELECT rowid FROM ix_text_item WHERE ix_text_item MATCH 'eff'").pluck().all()).toEqual([15]);
  });

  test('meta: the format, the languages, provenance; PRAGMA user_version 1; a unique code index', () => {
    const m = Object.fromEntries(db.prepare('SELECT key, value FROM meta').raw().all());
    expect(m.format).toBe(FORMAT);
    expect(FORMAT).toBe('tx-terminology/1');
    expect(JSON.parse(m.languages)).toEqual(['en']);
    expect(m['provenance.importer']).toBe('test');
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'concept_code'").pluck().get()).toMatch(/^CREATE UNIQUE INDEX/);
  });

  test('statistics: sqlite_stat1 only, no sqlite_stat4', () => {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%' ORDER BY 1").pluck().all()).toEqual(['sqlite_stat1']);
  });

  test('the index tables are rebuildable from the fact tables', () => {
    const copy = path.join(dir, 'rebuilt.db');
    fs.copyFileSync(path.join(dir, 'fixture.db'), copy);
    const w = new Database(copy);
    const dump = (d) => d.prepare('SELECT kind, property_id, value_kind, value, hex(data) FROM ix_set ORDER BY 1, 2, 3, 4').raw().all();
    const before = dump(w);
    buildIndexes(w);
    expect(dump(w)).toEqual(before);
    w.close();
  });
});

describe('sqlite-v2 display rank from language relations', () => {
  test('0 preferred in a display relation, 1 preferred in another, 2 otherwise (only items of the ranked use)', () => {
    const dest = path.join(dir, 'rank.db');
    const b = new TerminologyBuilder(dest, { overwrite: true, importer: 'test' });
    b.codeSystem({ uri: 'http://example.org/cs', version: '1' });
    const c = {};
    for (const code of ['A', 'B', 'US', 'GB', 'PREF', 'ACC']) c[code] = b.concept(code, { display: code });
    const lang = (code) => b.property({ code, shape: 'record', role: 'language', concept: c[code], fields: [{ name: 'acceptabilityId', type: 'c', target: true }] });
    const us = lang('US'), gb = lang('GB');
    const syn = { system: 's', code: 'syn' };
    const t = {};
    t.usPref = b.item(c.A, { use: syn, text: 'us preferred' });
    t.gbPref = b.item(c.A, { use: syn, text: 'gb preferred, us acceptable' });
    t.acc = b.item(c.A, { use: syn, text: 'acceptable only' });
    t.fsn = b.item(c.A, { use: { system: 's', code: 'fsn' }, text: 'fsn preferred' });
    t.none = b.item(c.B, { use: syn, text: 'no acceptability' });
    b.record(us, t.usPref, { target: c.PREF });
    b.record(gb, t.usPref, { target: c.ACC });
    b.record(gb, t.gbPref, { target: c.PREF });
    b.record(us, t.gbPref, { target: c.ACC });
    b.record(us, t.acc, { target: c.ACC });
    b.record(us, t.fsn, { target: c.PREF });
    b.setMeta('displayContexts', { relations: ['US'], preferred: 'PREF', use: syn });
    b.finish();
    const db = new Database(dest, { readonly: true });
    expect(db.prepare('SELECT text, rank FROM item ORDER BY id').raw().all()).toEqual([
      ['us preferred', 0], ['gb preferred, us acceptable', 1], ['acceptable only', 2], ['fsn preferred', 2], ['no acceptability', 2]]);
    db.close();
  });
});

describe('sqlite-v2 explicit ancestor pairs', () => {
  test('descendant sets come from the pairs (closure_from), not the edge closure', () => {
    // Path-style hierarchy: G is under E's path only.
    const pairs = [['B', 'root'], ['C', 'root'], ['D', 'root'], ['D', 'B'], ['F', 'D'], ['F', 'B'], ['F', 'root'],
      ['E', 'C'], ['E', 'root'], ['G', 'E'], ['G', 'C'], ['G', 'root'], ['Z', 'root'], ['S1', 'root']];
    const { db } = buildFixture(path.join(dir, 'pairs.db'), { explicitPairs: pairs });
    const S = sets(db);
    expect(S.get(`${SET_KIND.descendants}|0|number|${ids(db, ['D'])[0]}`)).toEqual(ids(db, ['F']));
    expect(S.get(`${SET_KIND.descendants}|0|number|${ids(db, ['E'])[0]}`)).toEqual(ids(db, ['G']));
    // the closure source has no sets of its own
    expect([...S.keys()].some((k) => k.startsWith(`${SET_KIND.prop}|${pid(db, 'ancestor')}|`))).toBe(false);
    db.close();
  });
});

describe('sqlite-v2 identifiers accepted as codes; definitions; the format check', () => {
  let file;
  beforeAll(() => {
    file = path.join(dir, 'ident.db');
    const b = new TerminologyBuilder(file, { overwrite: true, importer: 'test' });
    b.codeSystem({ uri: 'http://example.org/ident', version: '1' });
    const short = b.property({ code: 'short', shape: 'identifier' });
    const form = b.property({ code: 'form', shape: 'identifier' });
    const other = b.property({ code: 'other', shape: 'identifier' });
    const byValue = b.property({ code: 'byValue', shape: 'identifier', bySubject: false });
    const a = b.concept('A-1', { display: 'Alpha' });
    const k = b.concept('K-2', { display: 'Kappa' });
    b.identifier(short, 'A1', a, { resolves: 1 });          // an alias: answered as A-1
    b.identifier(form, '00002', k, { resolves: 2 });        // a code in its own right: answered as written
    b.identifier(other, 'X9', a);                           // not a code
    b.identifier(short, 'K-2', a, { resolves: 1 });         // the same value as a concept code: the concept wins
    b.identifier(byValue, 'V7', a);                         // read by value only: not in ix_by_subject
    b.item(a, { kind: 1, text: 'a definition with no use', preferred: true });
    b.item(k, { kind: 1, use: { system: 'u', code: 'def' }, text: 'a definition with a use', preferred: true });
    b.finish();
  });

  test('resolves 1 is answered with the concept\'s code, 2 as written, 0 not at all; a concept code wins', async () => {
    const { SqliteV2Factory } = require('../../tx/sqlite-v2/provider');
    const { OperationContext } = require('../../tx/operation-context');
    const { TestUtilities } = require('../test-utilities');
    const op = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    const f = new SqliteV2Factory(op.i18n, file);
    await f.load();
    try {
      const p = await f.build(op, []);
      const code = async (c) => { const r = await p.locate(c); return r.context ? [await p.code(r.context), await p.display(r.context)] : null; };
      expect(await code('A1')).toEqual(['A-1', 'Alpha']);
      expect(await code('00002')).toEqual(['00002', 'Kappa']);
      expect(await code('X9')).toBeNull();
      expect(await code('K-2')).toEqual(['K-2', 'Kappa']);
    } finally { f.store.close(); }
  });

  test('by_subject: identifier rows read by subject are in ix_by_subject, only for the catalog rows that ask', () => {
    const db = new Database(file, { readonly: true });
    try {
      expect(db.prepare("SELECT code, by_subject FROM property WHERE shape = 'identifier' ORDER BY id").raw().all())
        .toEqual([['short', 1], ['form', 1], ['other', 1], ['byValue', 0]]);
      expect(db.prepare('SELECT p.code, x.value FROM ix_by_subject x JOIN property p ON p.id = x.property_id ORDER BY 1, 2').raw().all())
        .toEqual([['form', '00002'], ['other', 'X9'], ['short', 'A1'], ['short', 'K-2']]);
      expect(db.prepare("SELECT count(*) FROM sqlite_master WHERE name = 'identifier_subject'").pluck().get()).toBe(0);
      const { Store } = require('../../tx/sqlite-v2/store');
      const S = new Store(file, { db, unregistered: true });
      const a = db.prepare("SELECT id FROM concept WHERE code = 'A-1'").pluck().get();
      expect(S.alternateIdsOf(a).map((r) => [r.scheme, r.identifier])).toEqual([['short', 'A1'], ['short', 'K-2'], ['other', 'X9']]);
      // the reader's code probe says resolves > 0, so it reads the partial index identifier_code
      expect(S.identifierAsCode('A1').code).toBe('A-1');
      const probe = [...S._stmts.keys()].find((q) => /FROM main\.identifier/.test(q));
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${probe}`).all('A1').map((r) => r.detail).join('; ');
      expect(plan).toMatch(/USING INDEX identifier_code/);
    } finally { db.close(); }
  });

  test('a definition is a designation only when it has a use; the definition shown either way', () => {
    const S = openStore(file, { unregistered: true });
    try {
      const rows = S.designationRows([S.idOf('A-1'), S.idOf('K-2')]);
      expect(rows.get(S.idOf('A-1')) || []).toEqual([]);
      expect(rows.get(S.idOf('K-2')).map((d) => d.term)).toEqual(['a definition with a use']);
      expect(S.rowForCode('A-1').definition).toBe('a definition with no use');
    } finally { S.close(); }
  });

  test('a file of the earlier sqlite-v2 schema, or of another format version, is refused with what to do', () => {
    const v5 = path.join(dir, 'old-v5.db');
    const d = new Database(v5);
    d.exec('CREATE TABLE cs_config (key TEXT, value TEXT); CREATE TABLE concept_set (kind INTEGER); PRAGMA user_version = 5;');
    d.close();
    expect(() => openStore(v5)).toThrow(/earlier version of the sqlite-v2 importers.*re-import it/);
    const older = path.join(dir, 'old-format.db');
    fs.copyFileSync(file, older);
    const w = new Database(older);
    w.exec("UPDATE meta SET value = 'tx-terminology/0.3' WHERE key = 'format'; PRAGMA user_version = 0;");
    w.close();
    expect(() => openStore(older)).toThrow(/format tx-terminology\/0\.3; this server reads tx-terminology\/1: re-import/);
  });

  test('behaviour settings: defaults, the ones a file sets, and an unknown key or value refused at open', () => {
    const S = openStore(file, { unregistered: true });
    try {
      expect(S.behaviour).toMatchObject({ grammar: null, expansionOrder: 'ids', lookupName: 'name', distinctDesignationTexts: false });
    } finally { S.close(); }
    const bad = (key, value, msg) => {
      const f = path.join(dir, 'behaviour.db');
      fs.copyFileSync(file, f);
      const w = new Database(f);
      w.prepare('INSERT INTO meta VALUES (?, ?)').run(key, value);
      w.close();
      expect(() => openStore(f)).toThrow(msg);
    };
    bad('behaviour.colour', '"red"', /unknown behaviour setting behaviour.colour/);
    bad('behaviour.designationUses', '"sometimes"', /behaviour.designationUses = "sometimes" is not a value this server knows/);
    bad('behaviour.grammar', 'snomed', /is not JSON/);
    bad('behaviour.preferredForLanguage', '"yes"', /behaviour.preferredForLanguage = "yes" is not a value/);
    bad('behaviour.aliasLiterals', '{"code-type": 11}', /behaviour.aliasLiterals = .* is not a value/);
    bad('behaviour.filters', '[{"code": "kind", "operator": ["like"]}]', /behaviour.filters = .* is not a value/);
    bad('behaviour.filters', '[{"code": "kind", "operator": ["="], "values": "product"}]', /behaviour.filters = .* is not a value/);
    const good = path.join(dir, 'behaviour-ok.db');
    fs.copyFileSync(file, good);
    const w = new Database(good);
    w.prepare('INSERT INTO meta VALUES (?, ?)').run('behaviour.preferredForLanguage', 'true');
    w.prepare('INSERT INTO meta VALUES (?, ?)').run('behaviour.aliasLiterals', '{"code-type": "11-digit", "synonym": "{code}"}');
    w.prepare('INSERT INTO meta VALUES (?, ?)').run('behaviour.filters',
      '[{"code": "inactive", "operator": ["="], "values": ["true", "false"]}, {"code": "category", "operator": ["=", "in"]}]');
    w.close();
    const G = openStore(good, { unregistered: true });
    try {
      expect(G.behaviour.preferredForLanguage).toBe(true);
      expect(G.behaviour.aliasLiterals).toEqual({ 'code-type': '11-digit', synonym: '{code}' });
      expect(G.behaviour.filters.map((f) => f.code)).toEqual(['inactive', 'category']);
    } finally { G.close(); }
    const b = new TerminologyBuilder(path.join(dir, 'never.db'), { overwrite: true, importer: 'test' });
    b.codeSystem({ uri: 'http://example.org/x', version: '1' });
    b.concept('a');
    b.setBehaviour('lookupName', 'nickname');
    expect(() => b.finish()).toThrow(/behaviour.lookupName = "nickname" is not a value/);
  });
});
