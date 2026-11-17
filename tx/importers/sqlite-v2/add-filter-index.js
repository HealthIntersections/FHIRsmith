#!/usr/bin/env node
'use strict';
// Build the word index that filter= ($expand text filter) searches (tx/sqlite-v2/text-index.js:
// SNOMED CT, LOINC, RxNorm) for an existing sqlite-v2 file, as the importer writes it in
// builder.finish(). Seconds per file (LOINC, 17 languages: about a minute), against a full import.
//
// By default the index is a sidecar beside the file, <file>.words (written as <file>.words.tmp,
// then renamed), and the file itself is only read: the server uses the sidecar when the file has
// no index of its own, and checks it is for that file (system, version, concept count). With
// --in-place the tables are written into the file instead (copy it first to keep the old one).
//
//   node tx/importers/sqlite-v2/add-filter-index.js [--in-place] <file.db> [<file.db> ...]

const fs = require('fs');
const Database = require('better-sqlite3');
const { dialectFor } = require('../../sqlite-v2/dialects');
const { writeTextTables, identityOf, sidecarPath, indexed } = require('../../sqlite-v2/text-index');

function addFilterIndex(file, { inPlace = false } = {}) {
  const t0 = Date.now();
  const src = new Database(file, inPlace ? {} : { readonly: true, fileMustExist: true });
  try {
    const cs = src.prepare('SELECT uri, concept_count FROM code_system WHERE id = 1').get();
    if (!cs || src.prepare('SELECT count(*) FROM code_system').pluck().get() !== 1) throw new Error(`${file}: not a one-block sqlite-v2 file`);
    const dialect = dialectFor(cs.uri).name;
    if (!indexed(dialect)) return { file, kind: null, ms: Date.now() - t0 };
    if (inPlace) {
      src.exec('BEGIN');
      const r = writeTextTables(src, dialect, cs.concept_count);
      src.prepare("INSERT OR REPLACE INTO provenance VALUES ('textIndex', ?)").run(JSON.stringify({ addedAt: new Date().toISOString(), node: process.version, ...r, langs: undefined }));
      src.exec('COMMIT');
      src.exec('ANALYZE text_word');
      return { file, ...r, ms: Date.now() - t0 };
    }
    const out = sidecarPath(file);
    const tmp = out + '.tmp';
    try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
    const dst = new Database(tmp);
    let r;
    try {
      dst.pragma('journal_mode = OFF');
      dst.pragma('synchronous = OFF');
      dst.exec('BEGIN');
      r = writeTextTables(dst, dialect, cs.concept_count, src, identityOf(src));
      dst.exec('COMMIT');
      dst.exec('ANALYZE');
    } finally {
      dst.close();
    }
    fs.renameSync(tmp, out);
    return { file: out, ...r, langs: r.langs.length, ms: Date.now() - t0 };
  } finally {
    src.close();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const inPlace = args.includes('--in-place');
  const files = args.filter((a) => a !== '--in-place');
  if (!files.length) { console.error('usage: add-filter-index.js [--in-place] <file.db> ...'); process.exit(2); }
  for (const f of files) console.log(JSON.stringify(addFilterIndex(f, { inPlace })));
}

module.exports = { addFilterIndex };
