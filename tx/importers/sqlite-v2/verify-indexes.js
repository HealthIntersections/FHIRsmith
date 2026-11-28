'use strict';
// Check that the ix_* tables of a built terminology file are rebuildable from its fact tables:
// digest every ix_* table (FTS5 shadow tables included), drop them all, rebuild with indexes.js,
// digest again, compare. Modifies the file: run it on a copy.
//
//   node tx/importers/sqlite-v2/verify-indexes.js <copy.db>

const crypto = require('crypto');
const Database = require('better-sqlite3');
const { buildIndexes, dropIndexes } = require('./indexes');

function digests(db) {
  const out = {};
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ix\\_%' ESCAPE '\\' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name").pluck().all();
  for (const t of tables) {
    const h = crypto.createHash('sha256');
    let rows = 0;
    // every column, ordered by all of them
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all().length;
    const by = Array.from({ length: cols }, (_, i) => i + 1).join(', ');
    for (const r of db.prepare(`SELECT * FROM "${t}" ORDER BY ${by}`).raw().iterate()) {
      for (const v of r) h.update(v === null ? '\u0000N' : Buffer.isBuffer(v) ? Buffer.concat([Buffer.from('\u0000B'), v]) : '\u0000' + typeof v + String(v));
      h.update('\u0001');
      rows++;
    }
    out[t] = { rows, sha256: h.digest('hex').slice(0, 16) };
  }
  out['meta ix.*'] = db.prepare("SELECT group_concat(key || '=' || value, ';') FROM (SELECT * FROM meta WHERE key LIKE 'ix.%' ORDER BY key)").pluck().get();
  return out;
}

if (require.main === module) {
  const file = process.argv[2];
  const db = new Database(file);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  const before = digests(db);
  dropIndexes(db);
  const left = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'ix\\_%' ESCAPE '\\'").pluck().all();
  const t0 = Date.now();
  buildIndexes(db);
  const seconds = (Date.now() - t0) / 1000;
  const after = digests(db);
  db.close();
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const diff = names.filter((n) => JSON.stringify(before[n]) !== JSON.stringify(after[n]));
  console.log(JSON.stringify({ file, leftAfterDrop: left, rebuildSeconds: seconds, tables: names.length, differ: diff, before, after }, null, 2));
  process.exit(diff.length ? 1 : 0);
}

module.exports = { digests };
