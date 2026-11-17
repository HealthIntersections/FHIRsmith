#!/usr/bin/env node
'use strict';
// Add (or rebuild) the LOINC hierarchy order (system_order rows hier_start and hier,
// tx/sqlite-v2/orders.js) in an existing LOINC sqlite-v2 file, in place: what the importers now
// write in builder.finish(). The order is not in the file itself, so give the source it came from:
//   - the unzipped LOINC release (the directory with AccessoryFiles/), for a file built by
//     import-loinc-v2 (it needs the file's concept_order, which says which codes the built-in
//     importer had keyed before each hierarchy row);
//   - the classic FHIRsmith LOINC db, for a file built by import-loinc-v2-classic.
// The file must already have system_order (add-system-order.js). Copy the file first to keep the
// old one.
//
//   node tx/importers/sqlite-v2/add-hierarchy-order.js <file.db> <release dir | classic.db>

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { csvObjects } = require('./text');
const { hierarchyArrays, writeHierarchyOrder, hasTable } = require('../../sqlite-v2/orders');

// import-loinc-v2.module.js: concept_order.seq = stage * 1e7 + row; stage 3 is the hierarchy
const ORDER_STAGE = 1e7;
const HIERARCHY_STAGE = 3;

/** entries from ComponentHierarchyBySystem.csv, the rule of import-loinc-v2.module.js */
async function fromRelease(db, dir) {
  const file = path.join(dir, 'AccessoryFiles', 'ComponentHierarchyBySystem', 'ComponentHierarchyBySystem.csv');
  if (!fs.existsSync(file)) throw new Error(`${file}: not found`);
  if (!hasTable(db, 'concept_order')) throw new Error('the file has no concept_order (not built by import-loinc-v2): give the classic db');
  const id = new Map(db.prepare('SELECT code, concept_id FROM concept').raw().all());
  const keyedBefore = new Set(db.prepare(`SELECT concept_id FROM concept_order WHERE seq < ${HIERARCHY_STAGE * ORDER_STAGE}`).pluck().all());
  const xs = [], others = [], child = [];
  const seen = new Set();
  for await (const r of csvObjects(file)) {
    const code = r.CODE.trim();
    if (!code) continue;
    const c = id.get(code);
    if (c === undefined) throw new Error(`${code}: in the hierarchy file, not in the db (another release?)`);
    keyedBefore.add(c); // the row's code has a key from here on
    const p = id.get(r.IMMEDIATE_PARENT.trim());
    if (p === undefined || !keyedBefore.has(p)) continue;
    const pair = c + ':' + p;
    if (seen.has(pair)) continue;
    seen.add(pair);
    xs.push(c, p); others.push(p, c); child.push(0, 1);
  }
  return { xs, others, child };
}

/** entries from the classic db's Relationships rows (import-loinc-v2-classic.module.js) */
function fromClassic(db, file) {
  const src = new Database(file, { readonly: true });
  try {
    const id = new Map(db.prepare('SELECT code, concept_id FROM concept').raw().all());
    const code = new Map(src.prepare('SELECT CodeKey, Code FROM Codes').raw().all());
    const rel = new Map(src.prepare('SELECT RelationshipTypeKey, Description FROM RelationshipTypes').raw().all());
    const xs = [], others = [], child = [];
    const seen = new Set();
    for (const [t, s, g] of src.prepare('SELECT RelationshipTypeKey, SourceKey, TargetKey FROM Relationships ORDER BY RelationshipKey').raw().iterate()) {
      const name = rel.get(t);
      if (name !== 'parent' && name !== 'child') continue;
      const x = id.get(code.get(s)), o = id.get(code.get(g));
      if (x === undefined || o === undefined) continue;
      const key = name + ':' + s + ':' + g;
      if (seen.has(key)) continue;
      seen.add(key);
      xs.push(x); others.push(o); child.push(name === 'child' ? 1 : 0);
    }
    return { xs, others, child };
  } finally {
    src.close();
  }
}

async function addHierarchyOrder(file, source) {
  const t0 = Date.now();
  const db = new Database(file);
  try {
    const cs = db.prepare('SELECT uri, concept_count FROM code_system WHERE id = 1').get();
    if (!cs || db.prepare('SELECT count(*) FROM code_system').pluck().get() !== 1) throw new Error(`${file}: not a one-block sqlite-v2 file`);
    if (cs.uri !== 'http://loinc.org') throw new Error(`${file}: holds ${cs.uri}, not LOINC`);
    if (!hasTable(db, 'system_order') || !db.prepare("SELECT 1 FROM system_order WHERE name = 'rank'").get()) {
      throw new Error(`${file}: no system_order yet (run add-system-order.js first)`);
    }
    const e = fs.statSync(source).isDirectory() ? await fromRelease(db, source) : fromClassic(db, source);
    const arrays = hierarchyArrays(cs.concept_count, e.xs, e.others, e.child);
    db.exec('BEGIN');
    const bytes = writeHierarchyOrder(db, arrays);
    db.prepare("INSERT OR REPLACE INTO provenance VALUES ('hierarchyOrder', ?)").run(JSON.stringify({ addedAt: new Date().toISOString(), source: path.basename(source), node: process.version }));
    db.exec('COMMIT');
    return { file, entries: e.xs.length, bytes, ms: Date.now() - t0 };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const [file, source] = process.argv.slice(2);
  if (!file || !source) { console.error('usage: add-hierarchy-order.js <file.db> <release dir | classic.db>'); process.exit(2); }
  addHierarchyOrder(file, source).then((r) => console.log(JSON.stringify(r)), (e) => { console.error(e.message); process.exit(1); });
}

module.exports = { addHierarchyOrder };
