'use strict';
// The built-in providers' answer orders for LOINC, SNOMED CT and RxNorm, as typed arrays over concept ids:
//   rank[id]  the concept's place in the system order (rank.length = concept count + 1)
//   ids[r]    the concept at place r
//   walk      the whole system in the built-in walk order (SNOMED CT: walk.reached is how many
//             the walk reaches; RxNorm: none)
//
// Stored in the file's ix_order table as little-endian Uint32 arrays in 1,024-entry blocks, the
// array's `reached` in meta 'ix.ix_order.<name>.reached'. The index builder computes them from the
// fact tables (computeOrder: SNOMED CT and RxNorm by code); an importer may write them itself (meta
// derived-by-importer: LOINC's orders are the built-in importer's numbering, SNOMED CT's walk). A
// provider reads each array the first time an answer needs it (storedOrder): no row objects, 4
// bytes per concept per array, and nothing for an array no request uses.

const os = require('os');

const LITTLE = os.endianness() === 'LE';

/** the order kind of a code system (by its dialect name), or null for a system without one */
function orderKind(dialectName) {
  return dialectName === 'loinc' || dialectName === 'snomed' || dialectName === 'rxnorm' ? dialectName : null;
}

/** text order of codes (SQLite BINARY for BMP text) */
function byText(a, b) { return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0; }

/** numeric order of digit strings without leading zeros: by length, then as text */
function byNumber(a, b) { return (a[1].length - b[1].length) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0); }

/** rank / ids arrays from [id, code] rows sorted by cmp */
function rankBy(n, rows, cmp) {
  rows.sort(cmp);
  const rank = new Uint32Array(n + 1);
  const ids = new Uint32Array(n + 1);
  rows.forEach((r, i) => { rank[r[0]] = i; ids[i] = r[0]; });
  return { rank, ids };
}

/**
 * The walk (snomedWalk) from its facts, whatever the file format: pairs [parent, child] of the
 * active group-0 is-a links by parent, in release order; the concepts with any is-a link (a
 * root has none, active or not: cs-snomed's import, activeRoots); the active concepts
 */
function walkFrom(n, byCode, pairs, withParent, activeIds) {
  const start = new Uint32Array(n + 2);
  for (const [t] of pairs) start[t + 1]++;
  for (let i = 1; i <= n + 1; i++) start[i] += start[i - 1];
  const kids = new Uint32Array(pairs.length);
  const fill = start.slice();
  for (const [t, c] of pairs) kids[fill[t]++] = c;
  const hasParent = new Uint8Array(n + 1);
  for (const c of withParent) hasParent[c] = 1;
  const isActive = new Uint8Array(n + 1);
  for (const id of activeIds) isActive[id] = 1;
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

function fromBlob(b) {
  const len = b.length >>> 2;
  if (LITTLE && b.byteOffset % 4 === 0) return new Uint32Array(b.buffer, b.byteOffset, len);
  const a = new Uint32Array(len);
  for (let i = 0; i < len; i++) a[i] = b.readUInt32LE(i * 4);
  return a;
}

/**
 * The lazy order object over stored arrays: meta name -> [name, length, reached], read(name) ->
 * the array's bytes (whatever the file format keeps them in)
 */
function orderOf(store, kind, meta, readBytes) {
  for (const k of ['rank', 'ids']) {
    if (!meta.has(k) || meta.get(k)[1] !== store.conceptCount + 1) throw new Error(`${store.file}: ix_order ${k} does not match concept_count`);
  }
  const read = (name) => {
    const t0 = Date.now();
    const buf = store.withoutMmap(() => readBytes(name));
    const a = fromBlob(buf);
    const r = meta.get(name)[2];
    if (r != null) a.reached = r;
    order.readMs += Date.now() - t0;
    return a;
  };
  let rank = null, ids = null, walk;
  const order = {
    kind,
    // behaviour.expansionOrder 'stored-self-first': an is-a / << filter lists its concept first
    selfFirst: kind === 'stored-self-first',
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

const readArray = (store, name) => Buffer.concat(store.stmt('SELECT data FROM main.ix_order WHERE name = ? ORDER BY block').pluck().all(name));

/** the stored rank / ids / walk arrays, read on first use */
function storedOrder(store, kind) {
  // each array's length from its block count and its last block (no other block's data is read at open)
  const meta = new Map(store.db.prepare(`SELECT g.name, g.last * 1024 + (SELECT length(l.data) / 4 FROM main.ix_order l WHERE l.name = g.name AND l.block = g.last),
    (SELECT CAST(value AS INTEGER) FROM main.meta WHERE key = 'ix.ix_order.' || g.name || '.reached')
    FROM (SELECT name, max(block) AS last FROM main.ix_order GROUP BY name) g`).raw().all().map((r) => [r[0], r]));
  return orderOf(store, kind, meta, (name) => readArray(store, name));
}

/**
 * A concept's parent and child entries in the built-in provider's order (LOINC): the stored
 * hier_start / hier arrays where the importer kept them; else from the facts, the concept's parent
 * links (by subject) and its children's (ix_in, by target) merged by seq (the hierarchy-file row of
 * the pair). Null for a file whose hierarchy is not read by target.
 */
function hierarchyOrder(store) {
  const names = new Set(store.db.prepare("SELECT DISTINCT name FROM main.ix_order WHERE name IN ('hier_start', 'hier')").pluck().all());
  if (names.size === 2) {
    let start = null, entries = null;
    const read = (name) => fromBlob(store.withoutMmap(() => readArray(store, name)));
    return {
      of(id) {
        if (!start) {
          start = read('hier_start'); entries = read('hier');
          if (start.length !== store.conceptCount + 2) throw new Error(`${store.file}: ix_order hier_start does not match concept_count`);
        }
        return entries.subarray(start[id], start[id + 1]);
      },
      loadedBytes() { return start ? start.byteLength + entries.byteLength : 0; },
    };
  }
  const h = store.hierarchy;
  if (!h || !h.byTarget) return null;
  const up = store.stmt('SELECT target_id, seq FROM main.link WHERE subject_id = +? AND property_id = +? AND active = 1').raw();
  const down = store.stmt('SELECT subject_id, seq FROM main.ix_in WHERE target_id = +? AND property_id = +? AND active = 1 AND group_id = 0').raw();
  return {
    of(id) {
      const e = [];
      for (const [t, seq] of up.all(id, h.id)) e.push([seq ?? 0, t >>> 0]);
      for (const [c, seq] of down.all(id, h.id)) e.push([seq, (c | HIER_CHILD) >>> 0]);
      e.sort((a, b) => a[0] - b[0]);
      return Uint32Array.from(e.map((x) => x[1]));
    },
    loadedBytes() { return 0; },
  };
}

/**
 * The order arrays from the fact tables, for the index builder: kind 'snomed' (by concept id as
 * a number, as cs-snomed.js lists results; the walk from the is-a links in source order: for is-a
 * and ECL << the concept itself first, selfFirst), 'rxnorm' (by RXCUI as text, '10' before '9':
 * cs-rxnorm.js groups by a text column). LOINC's order is the upstream importer's numbering,
 * which only its importer can compute (derived-by-importer).
 * @param {object} db a connection to the file
 * @param {object} [opts] { walk: false to leave the SNOMED walk out }
 */
function computeOrder(db, kind, n, opts = {}) {
  const rows = db.prepare('SELECT id, code FROM main.concept WHERE cs_id = (SELECT cs_id FROM main.code_system WHERE served = 1)').raw().all();
  if (kind === 'rxnorm') return { ...rankBy(n, rows, byText), walk: null, selfFirst: false };
  if (kind !== 'snomed') throw new Error(`no system order computable from the facts for ${kind}`);
  const { rank, ids } = rankBy(n, rows, byNumber);
  return { rank, ids, walk: opts.walk === false ? null : snomedWalk(db, n, ids), selfFirst: true };
}

/**
 * The whole code system in cs-snomed.js's walk order (iterator + includeCodeAndDescendants): from
 * each active root (no active parent; by id), depth first, the children in release order (inbound
 * active is-a links by seq), each concept once, where first reached. Concepts the walk does not
 * reach (the inactive ones: they have no active is-a row) follow, by id: walk.reached is how many
 * it reaches. cs-snomed.js's expansion of the whole system has only those; other selections of
 * every concept (ECL *) have them all.
 */
function snomedWalk(db, n, byCode) {
  const hid = db.prepare('SELECT id FROM main.property WHERE subsumption = 1 ORDER BY id LIMIT 1').pluck().get();
  return walkFrom(n, byCode,
    db.prepare('SELECT target_id, subject_id FROM main.ix_in WHERE target_id <= ? AND property_id = ? AND active = 1 AND group_id = 0 AND subject_id <= ? ORDER BY target_id, seq').raw().all(n, hid, n),
    db.prepare('SELECT DISTINCT subject_id FROM main.link WHERE property_id = ? AND subject_id <= ? AND target_id <= ?').pluck().iterate(hid, n, n),
    db.prepare('SELECT id FROM main.concept WHERE active = 1 AND id <= ?').pluck().iterate(n));
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
// Where the parent links' seq (the hierarchy-file row of each pair) does not give that order, the
// importer stores two ix_order arrays: hier_start (concept count + 2 offsets, by concept id) and
// hier, each concept's entries in that order: the other concept's id, with HIER_CHILD set for a
// child. Read on the first $lookup that needs it (store.hierarchyOrderOf).

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

module.exports = { orderKind, rankBy, byText, byNumber, walkFrom, fromBlob, orderOf, storedOrder, hierarchyOrder, computeOrder, snomedWalk,
  HIER_CHILD, hierarchyArrays };
