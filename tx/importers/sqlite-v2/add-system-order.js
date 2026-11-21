#!/usr/bin/env node
'use strict';
// Add (or rebuild) the system_order table (tx/sqlite-v2/orders.js) in an existing LOINC or
// SNOMED CT sqlite-v2 file, in place: the arrays the importer now writes in builder.finish().
// Seconds per file, against a full import for a new one. Copy the file first to keep the old one.
//
//   node tx/importers/sqlite-v2/add-system-order.js <file.db> [<file.db> ...]

const Database = require('better-sqlite3');
const { dialectFor } = require('../../sqlite-v2/dialects');
const { orderKind, computeOrder, writeOrder } = require('../../sqlite-v2/orders');

function addSystemOrder(file) {
  const t0 = Date.now();
  const db = new Database(file);
  try {
    const cs = db.prepare('SELECT uri, concept_count FROM code_system WHERE id = 1').get();
    if (!cs || db.prepare('SELECT count(*) FROM code_system').pluck().get() !== 1) throw new Error(`${file}: not a one-block sqlite-v2 file`);
    const kind = orderKind(dialectFor(cs.uri).name);
    if (!kind) return { file, kind: null, bytes: 0, ms: Date.now() - t0 };
    const order = computeOrder(db, kind, cs.concept_count);
    db.exec('BEGIN');
    const bytes = writeOrder(db, order);
    db.prepare("INSERT OR REPLACE INTO provenance VALUES ('systemOrder', ?)").run(JSON.stringify({ addedAt: new Date().toISOString(), node: process.version }));
    db.exec('COMMIT');
    return { file, kind, bytes, walk: order.walk ? order.walk.length : 0, reached: order.walk ? order.walk.reached ?? null : null, ms: Date.now() - t0 };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: add-system-order.js <file.db> ...'); process.exit(2); }
  for (const f of files) console.log(JSON.stringify(addSystemOrder(f)));
}

module.exports = { addSystemOrder };
