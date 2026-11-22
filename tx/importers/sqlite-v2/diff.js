#!/usr/bin/env node
'use strict';

// Compare two terminology files of the same code system by codes (node and property ids are local
// to a file). Used to check the reverse loaders (a SNOMED CT .cache, a classic LOINC .db) against
// builds from the release.
//
//   node tx/importers/sqlite-v2/diff.js A.db B.db [--json out.json] [--examples N]
//
// Reports, per fact table, rows only in A / only in B as code-keyed tuples (a node is 'c:<code>'
// for a concept, 'i:<concept code>:<external id or text>' for an item; record node fields are
// translated the same way), whether the concept numbering is identical, and ix_set equality per
// (kind, property code, value kind, value): by bytes when the numbering is identical, else by
// members translated to codes. Holds each file's keyed rows in memory: a tool for fixtures and
// single editions.

const fs = require('fs');
const Database = require('better-sqlite3');
const sets = require('./sets'); // RoaringBitmap32 through sets: roaring loads on first use

const FACTS = ['concept', 'item', 'item_use', 'property', 'property_member', 'link', 'literal', 'identifier', 'record', 'mapping', 'value_label'];

/** node id -> key, property id -> code, and the keyed rows of every fact table, for one file */
function keyed(db) {
  const conceptCode = new Map(db.prepare('SELECT id, code FROM concept').raw().all());
  const node = new Map();
  for (const [id, code] of conceptCode) node.set(id, 'c:' + code);
  for (const [id, c, x, t] of db.prepare('SELECT id, concept_id, CAST(external_id AS TEXT), text FROM item').raw().iterate()) {
    node.set(id, 'i:' + conceptCode.get(c) + ':' + (x != null ? x : t));
  }
  const pcode = new Map(db.prepare('SELECT id, code FROM property').raw().all());
  const key = (id) => (id == null ? null : node.get(id) ?? '?' + id);
  const uses = new Map(db.prepare('SELECT use_id, code FROM item_use').raw().all());
  const out = {};
  const view = (name, sql, fn) => {
    const m = new Map();
    for (const r of db.prepare(sql).raw().iterate()) {
      const k = JSON.stringify(fn(r));
      m.set(k, (m.get(k) || 0) + 1);
    }
    out[name] = m;
  };
  view('concept', 'SELECT code, active, display FROM concept', (r) => r);
  view('item', 'SELECT concept_id, kind, CAST(external_id AS TEXT), language, use_id, text, active, preferred, rank FROM item',
    ([c, ...r]) => [conceptCode.get(c), r[0], r[1], r[2], uses.get(r[3]) ?? null, ...r.slice(4)]);
  view('item_use', 'SELECT system, code, display FROM item_use', (r) => r);
  view('property', `SELECT code, uri, display, concept_id, shape, role, fhir_type, subject_kind, target_kind, n_rows, subsumption,
    closure_from, filterable, refinable, wildcard, inverse_of, by_target, by_subject, ordered, fields FROM property`,
  (r) => { r[3] = key(r[3]); r[11] = r[11] == null ? null : pcode.get(r[11]); r[15] = r[15] == null ? null : pcode.get(r[15]); return r; });
  view('property_member', 'SELECT parent_id, child_id FROM property_member', ([a, b]) => [pcode.get(a), pcode.get(b)]);
  view('link', 'SELECT subject_id, property_id, group_id, target_id, active FROM link', ([s, p, g, t, a]) => [key(s), pcode.get(p), g, key(t), a]);
  view('literal', 'SELECT subject_id, property_id, group_id, CAST(value AS TEXT), active FROM literal', ([s, p, g, v, a]) => [key(s), pcode.get(p), g, v, a]);
  view('identifier', 'SELECT property_id, value, subject_id, resolves FROM identifier', ([p, v, s, r]) => [pcode.get(p), String(v), key(s), r]);
  // record node fields (property.fields types c / n, not the target column): numbers are node ids
  const nodeCols = new Map();
  for (const [id, f] of db.prepare("SELECT id, fields FROM property WHERE shape = 'record'").raw().all()) {
    const cols = (f ? JSON.parse(f) : []).filter((c) => !c.target);
    nodeCols.set(id, new Set(cols.map((c, i) => (c.type === 'c' || c.type === 'n' ? i : -1)).filter((i) => i >= 0)));
  }
  view('record', 'SELECT relation_id, subject_id, target_id, active, fields FROM record', ([rel, s, t, a, f]) => {
    const cols = nodeCols.get(rel) || new Set();
    const fields = f ? JSON.parse(f).map((v, i) => (cols.has(i) && typeof v === 'number' ? key(v) : v)) : null;
    return [pcode.get(rel), key(s), key(t), a, fields];
  });
  view('mapping', 'SELECT concept_id, property_id, system, version, code, display, relationship FROM mapping',
    ([c, p, ...r]) => [key(c), p == null ? null : pcode.get(p), ...r]);
  view('value_label', 'SELECT property_id, CAST(value AS TEXT), display FROM value_label', ([p, ...r]) => [pcode.get(p), ...r]);
  return { out, conceptCode, node, pcode, key };
}

/**
 * @param {string} A first .db
 * @param {string} B second .db
 * @param {object} [o] { log (default: silent), examples (default 5) }
 * @returns report: tables (row counts), codeSystem_a / _b, facts (per view: onlyA, onlyB, examplesA,
 *   examplesB: decoded tuples), sets (identicalNumbering, byKind: {same, differ, onlyA, onlyB})
 */
function diffFiles(A, B, o = {}) {
  const nEx = o.examples ?? 5;
  const log = o.log || (() => {});
  const da = new Database(A, { readonly: true });
  const dbb = new Database(B, { readonly: true });
  try {
    const report = { a: A, b: B, tables: {}, facts: {}, sets: {} };
    for (const t of [...FACTS, 'ix_set']) {
      report.tables[t] = { a: da.prepare(`SELECT count(*) FROM ${t}`).pluck().get(), b: dbb.prepare(`SELECT count(*) FROM ${t}`).pluck().get() };
    }
    const cs = (d) => d.prepare('SELECT uri, version, concept_count, active_count FROM code_system WHERE served = 1').get();
    report.codeSystem_a = cs(da);
    report.codeSystem_b = cs(dbb);
    const ka = keyed(da), kb = keyed(dbb);
    for (const v of FACTS) {
      const a = ka.out[v], b = kb.out[v];
      const onlyA = [], onlyB = [];
      for (const [k, n] of a) { const m = b.get(k) || 0; for (let i = m; i < n; i++) onlyA.push(k); }
      for (const [k, n] of b) { const m = a.get(k) || 0; for (let i = m; i < n; i++) onlyB.push(k); }
      report.facts[v] = { onlyA: onlyA.length, onlyB: onlyB.length,
        examplesA: onlyA.slice(0, nEx).map((k) => JSON.parse(k)), examplesB: onlyB.slice(0, nEx).map((k) => JSON.parse(k)) };
      log(`  ${v.padEnd(16)} onlyA ${onlyA.length} onlyB ${onlyB.length}`);
    }
    // sets
    const order = (d) => d.prepare('SELECT code FROM concept ORDER BY id').pluck().all();
    const oa = order(da), ob = order(dbb);
    const identical = oa.length === ob.length && oa.every((c, i) => c === ob[i]);
    report.sets.identicalNumbering = identical;
    const setRows = (d, k) => {
      const m = new Map();
      for (const [kind, p, vk, value, data] of d.prepare('SELECT kind, property_id, value_kind, value, data FROM ix_set').raw().iterate()) {
        const v = vk === 1 ? k.key(value) : typeof value === 'number' ? value : String(value);
        const id = JSON.stringify([kind, p ? k.pcode.get(p) : 0, vk, v]);
        let members;
        if (identical) members = data.toString('hex');
        else members = Array.from(sets.RoaringBitmap32.deserialize(data, 'portable')).map((x) => k.conceptCode.get(x)).sort().join(',');
        m.set(id, { kind, members });
      }
      return m;
    };
    const sa = setRows(da, ka), sb = setRows(dbb, kb);
    const byKind = {};
    const of = (k) => byKind[k] || (byKind[k] = { same: 0, differ: 0, onlyA: 0, onlyB: 0, examples: [] });
    for (const [id, x] of sa) {
      const y = sb.get(id);
      const s = of(x.kind);
      if (!y) { s.onlyA++; if (s.examples.length < nEx) s.examples.push(['onlyA', JSON.parse(id)]); } else if (y.members === x.members) s.same++;
      else { s.differ++; if (s.examples.length < nEx) s.examples.push(['differ', JSON.parse(id)]); }
    }
    for (const [id, y] of sb) if (!sa.has(id)) { const s = of(y.kind); s.onlyB++; if (s.examples.length < nEx) s.examples.push(['onlyB', JSON.parse(id)]); }
    report.sets.byKind = byKind;
    return report;
  } finally {
    da.close();
    dbb.close();
  }
}

module.exports = { diffFiles };

if (require.main === module) {
  const args = process.argv.slice(2);
  const [A, B] = args.filter((x) => !x.startsWith('--'));
  const jsonAt = args.indexOf('--json');
  const exAt = args.indexOf('--examples');
  const r = diffFiles(A, B, { log: console.log, examples: exAt >= 0 ? Number(args[exAt + 1]) : 5 });
  if (jsonAt >= 0) fs.writeFileSync(args[jsonAt + 1], JSON.stringify(r, null, 2));
  else console.log(JSON.stringify({ tables: r.tables, sets: r.sets }, null, 2));
}
