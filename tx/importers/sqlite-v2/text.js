'use strict';

// Streaming text helpers for the sqlite-v2 importers.

const fs = require('fs');

/** Lines of a UTF-8 file (no terminators, CR stripped), streamed in 4 MiB chunks. */
async function* lines(filePath) {
  let rest = '';
  for await (const chunk of fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 22 })) {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop();
    for (const l of parts) yield l.endsWith('\r') ? l.slice(0, -1) : l;
  }
  if (rest) yield rest.endsWith('\r') ? rest.slice(0, -1) : rest;
}

/** Tab-separated rows (RF2), header skipped. Yields arrays of fields. */
async function* tsvRows(filePath) {
  let first = true;
  for await (const l of lines(filePath)) {
    if (first) { first = false; continue; }
    if (l) yield l.split('\t');
  }
}

/** Split one CSV record (RFC 4180: quotes, doubled quotes, embedded commas/newlines). */
function splitCsv(rec) {
  const out = [];
  let i = 0;
  const n = rec.length;
  while (i <= n) {
    if (rec.charCodeAt(i) === 34) { // quoted
      let v = '';
      i++;
      for (;;) {
        const q = rec.indexOf('"', i);
        if (q < 0) { v += rec.slice(i); i = n; break; }
        v += rec.slice(i, q);
        if (rec.charCodeAt(q + 1) === 34) { v += '"'; i = q + 2; } else { i = q + 1; break; }
      }
      out.push(v);
      const c = rec.indexOf(',', i);
      i = c < 0 ? n + 1 : c + 1;
    } else {
      const c = rec.indexOf(',', i);
      if (c < 0) { out.push(rec.slice(i)); break; }
      out.push(rec.slice(i, c));
      i = c + 1;
      if (i === n) { out.push(''); break; }
    }
  }
  return out;
}

/**
 * CSV records as objects keyed by header name. A record whose quotes are unbalanced at the
 * end of a line continues on the next line (LOINC has newlines inside quoted fields).
 */
async function* csvObjects(filePath) {
  let header = null, pending = null, quotes = 0;
  for await (const l of lines(filePath)) {
    pending = pending === null ? l : `${pending}\n${l}`;
    for (let i = 0; i < l.length; i++) if (l.charCodeAt(i) === 34) quotes++;
    if (quotes % 2) continue;
    const rec = pending;
    pending = null; quotes = 0;
    if (!rec) continue;
    const f = splitCsv(rec);
    if (!header) { header = f.map((h, k) => (k === 0 ? h.replace(/^\uFEFF/, '') : h)); continue; }
    const o = {};
    for (let k = 0; k < header.length; k++) o[header[k]] = f[k] === undefined ? '' : f[k];
    yield o;
  }
}

/** First line of a file (for header sniffing). */
function firstLine(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const t = buf.toString('utf8', 0, n);
    const e = t.indexOf('\n');
    return (e < 0 ? t : t.slice(0, e)).replace(/\r$/, '').replace(/^\uFEFF/, '');
  } finally { fs.closeSync(fd); }
}

/** Every regular file under dir, sorted. */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(p, out); } else if (e.isFile()) out.push(p);
  }
  return out;
}

module.exports = { lines, tsvRows, splitCsv, csvObjects, firstLine, walk };
