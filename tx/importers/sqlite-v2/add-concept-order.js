#!/usr/bin/env node
'use strict';
// Add (or rebuild) LOINC's concept_order (the built-in importer's key order, its code types and
// the whole-system walk: tx/sqlite-v2/orders.js loincOrder) in an existing LOINC sqlite-v2 file,
// in place, from the classic FHIRsmith LOINC db the file was reverse-loaded from
// (import-loinc-v2-classic): its CodeKey and Type for each code, and its child Relationships rows
// for the walk, as that importer reads them. The arrays of system_order that come from it are
// rewritten with it. Copy the file first to keep the old one.
//
// A file built from the LOINC release (import-loinc-v2) without concept_order is re-imported
// instead: its key order is the one the CSV importer works out while it reads the release files
// in the built-in importer's order (import-loinc-v2.module.js), and a second copy of that here
// would save little over the import itself (84 s for LOINC 2.83).
//
//   node tx/importers/sqlite-v2/add-concept-order.js <file.db> <classic.db>

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { loincWalk } = require('../import-loinc-v2.module');
const { computeOrder, writeOrder, hasTable } = require('../../sqlite-v2/orders');

async function addConceptOrder(file, classic) {
  const t0 = Date.now();
  if (!fs.existsSync(classic) || fs.statSync(classic).isDirectory()) throw new Error(`${classic}: give the classic LOINC db (a file built from the release is re-imported)`);
  const db = new Database(file);
  const src = new Database(classic, { readonly: true });
  try {
    const cs = db.prepare('SELECT uri, concept_count FROM code_system WHERE id = 1').get();
    if (!cs || db.prepare('SELECT count(*) FROM code_system').pluck().get() !== 1) throw new Error(`${file}: not a one-block sqlite-v2 file`);
    if (cs.uri !== 'http://loinc.org') throw new Error(`${file}: holds ${cs.uri}, not LOINC`);
    const id = new Map(db.prepare('SELECT code, concept_id FROM concept').raw().all());
    // the classic keys, as import-loinc-v2-classic reads them (blank codes are not concepts)
    const order = new Map(); // concept_id -> [Type, CodeKey]
    const byKey = new Map(); // CodeKey -> concept_id
    for (const [key, code, type] of src.prepare('SELECT CodeKey, Code, Type FROM Codes ORDER BY Type, CodeKey').raw().iterate()) {
      const c = (code || '').trim();
      if (!c) continue;
      const i = id.get(c);
      if (i === undefined) throw new Error(`${c}: in ${path.basename(classic)}, not in ${path.basename(file)} (another release?)`);
      order.set(i, [type, key]);
      byKey.set(key, i);
    }
    if (order.size !== id.size) throw new Error(`${file}: ${id.size} concepts, ${path.basename(classic)} ${order.size} codes (another release?)`);
    const child = src.prepare('SELECT RelationshipTypeKey FROM RelationshipTypes WHERE Description = ?').pluck().get('child');
    const childLinks = new Map();
    if (child != null) {
      for (const [s, g] of src.prepare('SELECT SourceKey, TargetKey FROM Relationships WHERE RelationshipTypeKey = ? ORDER BY RelationshipKey').raw().iterate(child)) {
        const a = byKey.get(s), b = byKey.get(g);
        if (a === undefined || b === undefined) continue;
        let kids = childLinks.get(a);
        if (!kids) childLinks.set(a, kids = []);
        if (!kids.includes(b)) kids.push(b);
      }
    }
    const walk = loincWalk(order, childLinks);
    db.exec('BEGIN');
    db.exec('DROP TABLE IF EXISTS concept_order');
    db.exec('CREATE TABLE concept_order (concept_id INTEGER PRIMARY KEY, kind INTEGER NOT NULL, seq INTEGER NOT NULL, walk INTEGER)');
    const ins = db.prepare('INSERT INTO concept_order VALUES (?, ?, ?, ?)');
    for (const [i, [kind, seq]] of order) ins.run(i, kind, seq, walk.get(i) ?? null);
    let orderBytes = 0;
    if (hasTable(db, 'system_order')) orderBytes = writeOrder(db, computeOrder(db, 'loinc', cs.concept_count));
    db.prepare("INSERT OR REPLACE INTO provenance VALUES ('conceptOrder', ?)").run(JSON.stringify({ addedAt: new Date().toISOString(), source: path.basename(classic), node: process.version }));
    db.exec('COMMIT');
    return { file, concepts: order.size, walk: walk.size, orderBytes, ms: Date.now() - t0 };
  } finally {
    src.close();
    db.close();
  }
}

if (require.main === module) {
  const [file, classic] = process.argv.slice(2);
  if (!file || !classic) { console.error('usage: add-concept-order.js <file.db> <classic.db>'); process.exit(2); }
  addConceptOrder(file, classic).then((r) => console.log(JSON.stringify(r)), (e) => { console.error(e.message); process.exit(1); });
}

module.exports = { addConceptOrder };
