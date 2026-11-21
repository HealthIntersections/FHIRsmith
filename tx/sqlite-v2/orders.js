'use strict';
// The built-in providers' answer orders for LOINC, SNOMED CT and RxNorm, as typed arrays over concept_id:
//   rank[id]  the concept's place in the system order (rank.length = concept count + 1)
//   ids[r]    the concept at place r
//   walk      the whole system in the built-in walk order (SNOMED CT: walk.reached is how many
//             the walk reaches; files without link_order, and LOINC files without concept_order:
//             none)
//
// They are computed from the file's own rows (computeOrder) at import time and stored in the
// file's system_order table as little-endian Uint32 BLOBs (writeOrder), one row per array. A
// provider reads each array from its BLOB the first time an answer needs it (storedOrder): no
// row objects, 4 bytes per concept per array, and nothing for an array no request uses. A file
// without system_order (built before it) computes the arrays at load, as before.

const os = require('os');

const LITTLE = os.endianness() === 'LE';

/** the order kind of a code system (by its dialect name), or null for a system without one */
function orderKind(dialectName) {
  return dialectName === 'loinc' || dialectName === 'snomed' || dialectName === 'rxnorm' ? dialectName : null;
}

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);
}

/**
 * Compute the order arrays from a file's rows.
 * @param {object} db better-sqlite3 database of a one-block sqlite-v2 file
 * @param {string} kind 'loinc' | 'snomed'
 * @param {number} [n] concept count (default: the file's block 1)
 * @returns {{rank: Uint32Array, ids: Uint32Array, walk: Uint32Array|null, selfFirst: boolean}}
 */
function computeOrder(db, kind, n = db.prepare('SELECT concept_count FROM code_system WHERE id = 1').pluck().get()) {
  if (kind === 'loinc') return loincOrder(db, n);
  if (kind === 'snomed') return snomedOrder(db, n);
  if (kind === 'rxnorm') return rxnormOrder(db, n);
  throw new Error(`no system order for ${kind}`);
}

/**
 * LOINC results in cs-loinc.js's order. Files built with concept_order have the built-in
 * importer's keys: filter results by the built-in importer's key (its filter SQL orders by
 * CodeKey: parts both before and after the terms); the whole system in expand.js's walk of it
 * (concept_order.walk: by type, then key, each part followed by what is below it; files without
 * walk: by type, then key). Older files: terms, then parts, answer lists, answers, each by code
 * with its hyphen removed, compared as text (the built-in order for terms and lists only).
 */
function loincOrder(db, n) {
  const rank = new Uint32Array(n + 1);
  const ids = new Uint32Array(n + 1);
  if (hasTable(db, 'concept_order')) {
    const rows = db.prepare('SELECT concept_id, kind, walk FROM concept_order ORDER BY seq').raw().all();
    rows.forEach((r, i) => { rank[r[0]] = i; ids[i] = r[0]; });
    const byWalk = rows.every((r) => r[2] != null);
    const walk = Uint32Array.from(rows.slice().sort(byWalk ? (a, b) => a[2] - b[2] : (a, b) => a[1] - b[1]).map((r) => r[0]));
    return { rank, ids, walk, selfFirst: false };
  }
  const rows = db.prepare('SELECT concept_id, code FROM concept').raw().all();
  const kindOf = (c) => (c.startsWith('LP') ? 1 : c.startsWith('LL') ? 2 : c.startsWith('LA') ? 3 : 0);
  for (const r of rows) r.push(kindOf(r[1]), r[1].replace(/-/g, ''));
  rows.sort((a, b) => (a[2] - b[2]) || (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  rows.forEach((r, i) => { rank[r[0]] = i; ids[i] = r[0]; });
  return { rank, ids, walk: null, selfFirst: false };
}

/**
 * RxNorm results in cs-rxnorm.js's order: by RXCUI as text ('10' before '9'). Its filter queries
 * group by RXCUI (a text column), and the whole system is ORDER BY RXCUI. concept_id is the
 * importer's (TTY rank, ingredient group) order here
 */
function rxnormOrder(db, n) {
  const rows = db.prepare('SELECT concept_id, code FROM concept').raw().all();
  rows.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const rank = new Uint32Array(n + 1);
  const ids = new Uint32Array(n + 1);
  rows.forEach((r, i) => { rank[r[0]] = i; ids[i] = r[0]; });
  return { rank, ids, walk: null, selfFirst: false };
}

/**
 * SNOMED CT results in cs-snomed.js's order: by concept index, which is the concept id as a
 * number (the cache's concepts are sorted by id), and for is-a (and ECL <<) the concept itself
 * first, as filterIsA lists it (selfFirst). concept_id is the hierarchy's depth-first order
 * here, so a result is sorted by rank.
 */
function snomedOrder(db, n) {
  const rows = db.prepare('SELECT concept_id, code FROM concept').raw().all();
  // numeric order of digit strings without leading zeros: by length, then as text
  rows.sort((a, b) => (a[1].length - b[1].length) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const rank = new Uint32Array(n + 1);
  const ids = new Uint32Array(n + 1);
  rows.forEach((r, i) => { rank[r[0]] = i; ids[i] = r[0]; });
  const walk = hasTable(db, 'link_order') ? snomedWalk(db, n, ids) : null;
  return { rank, ids, walk, selfFirst: true };
}

/**
 * The whole code system in cs-snomed.js's walk order (iterator + includeCodeAndDescendants):
 * from each active root (no active parent; by id), depth first, the children in release order
 * (inbound active is-a rows by row), each concept once, where first reached. Concepts the walk
 * does not reach (the inactive ones: they have no active is-a row) follow, by id: walk.reached
 * is how many it reaches. cs-snomed.js's expansion of the whole system has only those; other
 * selections of every concept (ECL *) have them all. From link_order.
 */
function snomedWalk(db, n, byCode) {
  const hid = db.prepare('SELECT property_id FROM property_def WHERE is_hierarchy = 1 ORDER BY property_id LIMIT 1').pluck().get();
  const pairs = db.prepare('SELECT target_id, source_id FROM link_order WHERE property_id = ? AND active = 1 AND group_id = 0 ORDER BY target_id, seq').raw().all(hid);
  const start = new Uint32Array(n + 2);
  for (const [t] of pairs) start[t + 1]++;
  for (let i = 1; i <= n + 1; i++) start[i] += start[i - 1];
  const kids = new Uint32Array(pairs.length);
  const fill = start.slice();
  for (const [t, c] of pairs) kids[fill[t]++] = c;
  // a root has no is-a row at all, active or not (cs-snomed's import: activeRoots)
  const hasParent = new Uint8Array(n + 1);
  for (const c of db.prepare('SELECT DISTINCT source_id FROM link_order WHERE property_id = ?').pluck().iterate(hid)) hasParent[c] = 1;
  const isActive = new Uint8Array(n + 1);
  for (const id of db.prepare('SELECT concept_id FROM concept WHERE active = 1').pluck().iterate()) isActive[id] = 1;
  const out = new Uint32Array(n);
  const seen = new Uint8Array(n + 1);
  let k = 0;
  const stack = [];
  for (let r = 0; r < n; r++) {
    const id = byCode[r];
    if (!isActive[id] || hasParent[id]) continue; // an active root, in id order
    stack.push(id);
    while (stack.length) {
      const c = stack.pop();
      if (seen[c]) continue;
      seen[c] = 1; out[k++] = c;
      for (let j = start[c + 1] - 1; j >= start[c]; j--) if (!seen[kids[j]]) stack.push(kids[j]);
    }
  }
  const reached = k;
  for (let r = 0; r < n; r++) if (!seen[byCode[r]]) out[k++] = byCode[r];
  out.reached = reached;
  return out;
}

function toBlob(a) {
  if (LITTLE) return Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  const b = Buffer.alloc(a.length * 4);
  for (let i = 0; i < a.length; i++) b.writeUInt32LE(a[i], i * 4);
  return b;
}

function fromBlob(b) {
  const len = b.length >>> 2;
  if (LITTLE && b.byteOffset % 4 === 0) return new Uint32Array(b.buffer, b.byteOffset, len);
  const a = new Uint32Array(len);
  for (let i = 0; i < len; i++) a[i] = b.readUInt32LE(i * 4);
  return a;
}

const DDL = `CREATE TABLE system_order (name TEXT PRIMARY KEY, length INTEGER NOT NULL, reached INTEGER,
  data BLOB NOT NULL) WITHOUT ROWID`;

const ORDER_ROWS = ['rank', 'ids', 'walk'];

/** store computed arrays in the file (replaces the rank, ids and walk rows already there) */
function writeOrder(db, order) {
  db.exec(DDL.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));
  db.prepare(`DELETE FROM system_order WHERE name IN (${ORDER_ROWS.map(() => '?').join(', ')})`).run(...ORDER_ROWS);
  const ins = db.prepare('INSERT INTO system_order VALUES (?, ?, ?, ?)');
  ins.run('rank', order.rank.length, null, toBlob(order.rank));
  ins.run('ids', order.ids.length, null, toBlob(order.ids));
  if (order.walk) ins.run('walk', order.walk.length, order.walk.reached ?? null, toBlob(order.walk));
  return (order.rank.byteLength + order.ids.byteLength + (order.walk ? order.walk.byteLength : 0));
}

/**
 * The stored arrays of a file with system_order, read on first use. `walk` is a getter the
 * engine reads only for an include of the whole system (hasWalk says whether there is one).
 * @param {object} store V2Store
 * @param {string} kind 'loinc' | 'snomed'
 */
function storedOrder(store, kind) {
  const meta = new Map(store.db.prepare('SELECT name, length, reached FROM system_order').raw().all().map((r) => [r[0], r]));
  for (const k of ['rank', 'ids']) {
    if (!meta.has(k) || meta.get(k)[1] !== store.conceptCount + 1) throw new Error(`${store.file}: system_order ${k} does not match concept_count`);
  }
  const read = (name) => {
    const t0 = Date.now();
    const buf = store.withoutMmap(() => store.stmt('SELECT data FROM system_order WHERE name = ?').pluck().get(name));
    const a = fromBlob(buf);
    const r = meta.get(name)[2];
    if (r != null) a.reached = r;
    order.readMs += Date.now() - t0;
    return a;
  };
  let rank = null, ids = null, walk;
  const order = {
    kind,
    selfFirst: kind === 'snomed',
    hasWalk: meta.has('walk'),
    stored: true,
    readMs: 0,
    get rank() { return rank || (rank = read('rank')); },
    get ids() { return ids || (ids = read('ids')); },
    get walk() { if (walk === undefined) walk = meta.has('walk') ? read('walk') : null; return walk; },
    /** bytes of the arrays read so far */
    loadedBytes() { return (rank ? rank.byteLength : 0) + (ids ? ids.byteLength : 0) + (walk ? walk.byteLength : 0); },
  };
  return order;
}

/** an order computed now (a file without system_order) in the same shape */
function builtOrder(computed, kind) {
  return {
    kind, selfFirst: computed.selfFirst, hasWalk: !!computed.walk, stored: false, readMs: 0,
    rank: computed.rank, ids: computed.ids, walk: computed.walk,
    loadedBytes() { return computed.rank.byteLength + computed.ids.byteLength + (computed.walk ? computed.walk.byteLength : 0); },
  };
}

// ---- LOINC hierarchy order -----------------------------------------------------------------
//
// cs-loinc.js lists a code's parent and child relationships in its Relationships rows' order
// (the $lookup query has no ORDER BY; SQLite reads the SourceKey index, so by RelationshipKey).
// The built-in importer inserts them from ComponentHierarchyBySystem.csv, one row at a time: for
// a row (code under parent) the code's parent row, then the parent's child row, each pair once,
// and only when the parent already has a CodeKey. So a part's children come in hierarchy-file
// order, and a part on two paths has its second parent among its children.
//
// Stored as two more system_order rows: hier_start (concept count + 2 offsets, by concept_id)
// and hier, each concept's entries in that order: the other concept's id, with HIER_CHILD set
// for a child. Read on the first $lookup that needs it (store.hierarchyOrderOf).

const HIER_CHILD = 0x80000000;

/**
 * The two arrays from a concept's entries in order (stable: entries of one concept keep the
 * order they were given in).
 * @param {number} n concept count
 * @param {ArrayLike<number>} xs concept id of each entry
 * @param {ArrayLike<number>} others the related concept id of each entry
 * @param {ArrayLike<number>} isChild 1 where the related concept is a child, else 0 (a parent)
 */
function hierarchyArrays(n, xs, others, isChild) {
  const start = new Uint32Array(n + 2);
  for (let k = 0; k < xs.length; k++) start[xs[k] + 1]++;
  for (let i = 1; i < start.length; i++) start[i] += start[i - 1];
  const entries = new Uint32Array(xs.length);
  const fill = start.slice();
  for (let k = 0; k < xs.length; k++) entries[fill[xs[k]]++] = (others[k] | (isChild[k] ? HIER_CHILD : 0)) >>> 0;
  return { start, entries };
}

/** store the hierarchy order (replaces hier_start and hier; the other rows stay) */
function writeHierarchyOrder(db, arrays) {
  db.exec(DDL.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'));
  db.prepare("DELETE FROM system_order WHERE name IN ('hier_start', 'hier')").run();
  const ins = db.prepare('INSERT INTO system_order VALUES (?, ?, ?, ?)');
  ins.run('hier_start', arrays.start.length, null, toBlob(arrays.start));
  ins.run('hier', arrays.entries.length, null, toBlob(arrays.entries));
  return arrays.start.byteLength + arrays.entries.byteLength;
}

/**
 * The stored hierarchy order of a file, or null without one: { of(id) -> Uint32Array of entries }.
 * Both arrays are read on the first call.
 */
function storedHierarchyOrder(store) {
  if (!hasTable(store.db, 'system_order')) return null;
  const meta = new Map(store.db.prepare("SELECT name, length FROM system_order WHERE name IN ('hier_start', 'hier')").raw().all());
  if (!meta.has('hier_start') || !meta.has('hier')) return null;
  if (meta.get('hier_start') !== store.conceptCount + 2) throw new Error(`${store.file}: system_order hier_start does not match concept_count`);
  let start = null, entries = null;
  const read = (name) => fromBlob(store.withoutMmap(() => store.stmt('SELECT data FROM system_order WHERE name = ?').pluck().get(name)));
  return {
    of(id) {
      if (!start) { start = read('hier_start'); entries = read('hier'); }
      return entries.subarray(start[id], start[id + 1]);
    },
    loadedBytes() { return start ? start.byteLength + entries.byteLength : 0; },
  };
}

module.exports = { orderKind, computeOrder, writeOrder, storedOrder, builtOrder, hasTable,
  HIER_CHILD, hierarchyArrays, writeHierarchyOrder, storedHierarchyOrder };
