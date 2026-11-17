#!/usr/bin/env node
'use strict';

// Compare two sqlite-v2 files of the same code system by codes (ids and property ids are local to a
// file). Used to validate reverse-loaded SNOMED caches against RF2 builds.
//
//   node tx/importers/sqlite-v2/diff.js A.db B.db [--json out.json] [--examples N]
//
// Reports, per fact table, rows only in A / only in B (as code-keyed tuples, with grouped breakdowns
// and examples), whether concept_id numbering is identical, and concept_set equality per
// (kind, property code, value) - by bytes when the numbering is identical, else by translated members.

const fs = require('fs');
const Database = require('better-sqlite3');
const sets = require('./sets'); // RoaringBitmap32 through sets: roaring loads on first use

/**
 * @param {string} A first .db
 * @param {string} B second .db
 * @param {object} [o] { log (default: silent), examples (default 5) }
 * @returns report: tables (row counts), facts (per code-keyed view: onlyA/onlyB/groups/examples),
 *          sets (identicalNumbering, byKind)
 */
function diffV2(A, B, o = {}) {
const nEx = o.examples ?? 5;
const log = o.log || (() => {});
const db = new Database(':memory:');
db.pragma('cache_size = -400000');
db.prepare('ATTACH ? AS a').run(A);
db.prepare('ATTACH ? AS b').run(B);
db.exec('PRAGMA temp_store = FILE');
const report = { a: A, b: B, tables: {}, facts: {}, sets: {} };

for (const t of ['concept', 'concept_link', 'concept_literal', 'designation', 'designation_acceptability',
  'refset_def', 'refset_member', 'alternate_identifier', 'external_map', 'concept_set', 'property_def']) {
  const ca = db.prepare(`SELECT count(*) c FROM a.${t}`).get().c;
  const cb = db.prepare(`SELECT count(*) c FROM b.${t}`).get().c;
  report.tables[t] = { a: ca, b: cb };
}
log('rows (a / b):');
for (const [t, v] of Object.entries(report.tables)) log(`  ${t.padEnd(28)} ${String(v.a).padStart(10)} ${String(v.b).padStart(10)}${v.a === v.b ? '' : '  *'}`);
for (const s of ['a', 'b']) {
  const cs = db.prepare(`SELECT version, concept_count, active_count FROM ${s}.code_system`).get();
  report[`codeSystem_${s}`] = cs;
}

// code-keyed views of each fact table
const V = {
  concept: (s) => `SELECT code, active, display, definition FROM ${s}.concept`,
  link: (s) => `SELECT cs.code src, p.code prop, l.group_id grp, ct.code tgt, l.active FROM ${s}.concept_link l
    JOIN ${s}.concept cs ON cs.concept_id = l.source_id JOIN ${s}.concept ct ON ct.concept_id = l.target_id
    JOIN ${s}.property_def p ON p.property_id = l.property_id`,
  literal: (s) => `SELECT c.code src, p.code prop, l.group_id grp, CAST(l.value AS TEXT) value, l.active FROM ${s}.concept_literal l
    JOIN ${s}.concept c ON c.concept_id = l.concept_id JOIN ${s}.property_def p ON p.property_id = l.property_id`,
  designation: (s) => `SELECT c.code concept, d.language, u.code use, d.term, d.active, d.preferred FROM ${s}.designation d
    JOIN ${s}.concept c ON c.concept_id = d.concept_id LEFT JOIN ${s}.designation_use u ON u.use_id = d.use_id`,
  acceptability: (s) => `SELECT c.code concept, d.language, u.code use, d.term, d.active, r.code refset, v.code value
    FROM ${s}.designation_acceptability x JOIN ${s}.designation d ON d.designation_id = x.designation_id
    JOIN ${s}.concept c ON c.concept_id = d.concept_id LEFT JOIN ${s}.designation_use u ON u.use_id = d.use_id
    JOIN ${s}.concept r ON r.concept_id = x.refset_id JOIN ${s}.concept v ON v.concept_id = x.acceptability_id`,
  refset_member: (s) => `SELECT r.code refset, c.code concept, m.fields FROM ${s}.refset_member m
    JOIN ${s}.concept r ON r.concept_id = m.refset_id JOIN ${s}.concept c ON c.concept_id = m.concept_id`,
  refset_def: (s) => `SELECT r.code refset, d.field_names, d.field_types FROM ${s}.refset_def d JOIN ${s}.concept r ON r.concept_id = d.refset_id`,
  alternate_identifier: (s) => `SELECT c.code concept, sc.code scheme, x.identifier FROM ${s}.alternate_identifier x
    JOIN ${s}.concept c ON c.concept_id = x.concept_id JOIN ${s}.concept sc ON sc.concept_id = x.scheme_id`,
  property_def: (s) => `SELECT code, uri, fhir_type, value_kind, is_hierarchy, display FROM ${s}.property_def`,
};
// how to break differences down (SQL expression over the view's columns)
const GROUP = {
  concept: "CASE WHEN x.code IN (SELECT code FROM other) THEN 'changed' ELSE 'missing' END",
  link: 'prop || \' active=\' || active',
  literal: 'prop',
  designation: 'use || \' \' || language || \' active=\' || active || \' preferred=\' || preferred',
  acceptability: 'refset || \' \' || value',
  refset_member: 'refset',
  refset_def: 'refset',
  alternate_identifier: 'scheme',
  property_def: 'code',
};

function cols(s) {
  // column list of the view
  return db.prepare(`SELECT * FROM (${V[s]('a')}) LIMIT 0`).columns().map((c) => c.name);
}

for (const name of Object.keys(V)) {
  const t = Date.now();
  db.exec(`DROP TABLE IF EXISTS temp.va; DROP TABLE IF EXISTS temp.vb;
    CREATE TEMP TABLE va AS ${V[name]('a')}; CREATE TEMP TABLE vb AS ${V[name]('b')};`);
  const c = cols(name).join(', ');
  const res = { onlyA: 0, onlyB: 0, groupsA: {}, groupsB: {}, examplesA: [], examplesB: [] };
  for (const [side, x, y] of [['A', 'va', 'vb'], ['B', 'vb', 'va']]) {
    db.exec(`DROP TABLE IF EXISTS temp.d; CREATE TEMP TABLE d AS SELECT ${c} FROM ${x} EXCEPT SELECT ${c} FROM ${y};`);
    res[`only${side}`] = db.prepare('SELECT count(*) c FROM d').get().c;
    if (res[`only${side}`]) {
      db.exec(`DROP VIEW IF EXISTS temp.other; CREATE TEMP VIEW other AS SELECT * FROM ${y}`);
      for (const r of db.prepare(`SELECT ${GROUP[name]} g, count(*) n FROM d x GROUP BY 1 ORDER BY 2 DESC LIMIT 40`).all()) res[`groups${side}`][r.g] = r.n;
      res[`examples${side}`] = db.prepare(`SELECT * FROM d LIMIT ${nEx}`).all();
    }
  }
  // multiset check: duplicates are collapsed by EXCEPT; compare raw counts too
  res.countA = db.prepare('SELECT count(*) c FROM va').get().c;
  res.countB = db.prepare('SELECT count(*) c FROM vb').get().c;
  report.facts[name] = res;
  log(`\n${name}: ${res.countA} / ${res.countB} rows; only in a ${res.onlyA}, only in b ${res.onlyB} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  for (const side of ['A', 'B']) {
    if (!res[`only${side}`]) continue;
    log(`  only in ${side.toLowerCase()} by group: ${JSON.stringify(res[`groups${side}`])}`);
    for (const e of res[`examples${side}`]) log(`    ${JSON.stringify(e)}`);
  }
}
db.exec('DROP TABLE IF EXISTS temp.va; DROP TABLE IF EXISTS temp.vb; DROP TABLE IF EXISTS temp.d;');

// ---- numbering and sets ---------------------------------------------------------------------
const idsA = db.prepare('SELECT concept_id, code FROM a.concept').raw().all();
const idB = new Map(db.prepare('SELECT code, concept_id FROM b.concept').raw().all());
let sameIds = idsA.length === idB.size;
const maxA = idsA.reduce((m, r) => Math.max(m, r[0]), 0);
const tr = new Int32Array(maxA + 1).fill(-1);
for (const [id, code] of idsA) {
  const o = idB.get(code);
  if (o === undefined) sameIds = false; else tr[id] = o;
  if (o !== id) sameIds = false;
}
report.sets.identicalNumbering = sameIds;
log(`\nconcept_id numbering identical: ${sameIds}`);

const keyed = (s) => {
  const props = new Map(db.prepare(`SELECT property_id, code, value_kind FROM ${s}.property_def`).raw().all().map((r) => [r[0], r]));
  const codeOf = new Map(db.prepare(`SELECT concept_id, code FROM ${s}.concept`).raw().all());
  const m = new Map();
  for (const [kind, prop, value, card, data] of db.prepare(`SELECT kind, property_id, value, card, data FROM ${s}.concept_set`).raw().iterate()) {
    const p = props.get(prop);
    const conceptValued = kind === 4 || kind === 7 || (kind === 5 && p && p[2] === 'concept');
    const k = `${kind}|${p ? p[1] : prop}|${conceptValued ? codeOf.get(value) : value}`;
    m.set(k, { card, data });
  }
  return m;
};
const sa = keyed('a'), sb = keyed('b');
const kinds = {};
const K = (kind) => (kinds[kind] || (kinds[kind] = { a: 0, b: 0, onlyA: 0, onlyB: 0, equal: 0, differ: 0, examples: [] }));
for (const [k, va] of sa) {
  const kind = k.split('|')[0];
  const s = K(kind); s.a++;
  const vb = sb.get(k);
  if (!vb) { s.onlyA++; if (s.examples.length < nEx) s.examples.push({ key: k, only: 'a', card: va.card }); continue; }
  let eq;
  if (sameIds) eq = Buffer.compare(va.data, vb.data) === 0;
  else {
    const ma = sets.RoaringBitmap32.deserialize(va.data, 'portable').toUint32Array();
    const mb = sets.RoaringBitmap32.deserialize(vb.data, 'portable');
    eq = ma.length === mb.size && ma.every((x) => mb.has(tr[x]));
  }
  if (eq) s.equal++; else { s.differ++; if (s.examples.length < nEx) s.examples.push({ key: k, cardA: va.card, cardB: vb.card }); }
}
for (const k of sb.keys()) {
  const s = K(k.split('|')[0]); s.b++;
  if (!sa.has(k)) { s.onlyB++; if (s.examples.length < nEx * 2) s.examples.push({ key: k, only: 'b', card: sb.get(k).card }); }
}
report.sets.byKind = kinds;
log('concept_set by kind (1 all, 2 active, 3 leaf, 4 descendants, 5 prop, 6 hasProp, 7 refset):');
for (const [k, s] of Object.entries(kinds)) {
  log(`  kind ${k}: a ${s.a}, b ${s.b}, equal ${s.equal}, differ ${s.differ}, only a ${s.onlyA}, only b ${s.onlyB}`);
  for (const e of s.examples) log(`    ${JSON.stringify(e)}`);
}
db.close();
return report;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
  const jsonOut = opt('--json', null);
  const examples = Number(opt('--examples', 5));
  const [A, B] = args;
  if (!A || !B) { console.error('usage: diff.js A.db B.db [--json out.json] [--examples N]'); process.exit(2); }
  const report = diffV2(A, B, { log: (...m) => console.log(...m), examples });
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 1));
}

module.exports = { diffV2 };
