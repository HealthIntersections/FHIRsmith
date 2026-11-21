'use strict';

// Set construction for the sqlite-v2 schema: every membership question is answered by one of
// these Roaring bitmaps over concept_id. Pure functions over typed arrays, so the shared
// final import stage and the tests use the same code.

// roaring is loaded when a set is first made, not with this module: the importer CLI loads every
// importer module, and one without the engine's dependency installed should not warn about it
let roaring = null;
function R() {
  return roaring || (roaring = require('roaring').RoaringBitmap32);
}

const SET_KIND = Object.freeze({
  all: 1, active: 2, leaf: 3, descendants: 4, prop: 5, hasProp: 6, refset: 7,
});

/** Run-optimise and serialise ('portable' = the CRoaring cross-language format). */
function serialize(bm) {
  bm.runOptimize();
  bm.shrinkToFit();
  return bm.serialize('portable');
}

function rangeSet(lo, hiInclusive) {
  const bm = new (R())();
  if (hiInclusive >= lo) bm.addRange(lo, hiInclusive + 1);
  return bm;
}

/**
 * Descendant sets (self excluded) from child -> parent edges by the transitive closure.
 * Children are folded into parents in reverse topological order (Kahn over the edge graph),
 * so this does not depend on the numbering.
 *
 * @param {number} n             concept count (ids 1..n)
 * @param {Int32Array} childOf   edge i child id
 * @param {Int32Array} parentOf  edge i parent id
 * @returns {{ desc: Array<RoaringBitmap32|undefined>, cyclic: number }} desc[id] (undefined = empty)
 */
function descendantsFromEdges(n, childOf, parentOf) {
  // CSR children per parent, de-duplicated.
  const start = new Int32Array(n + 2);
  for (let e = 0; e < parentOf.length; e++) start[parentOf[e] + 1]++;
  for (let i = 0; i <= n; i++) start[i + 1] += start[i];
  const kids = new Int32Array(parentOf.length);
  const fill = start.slice(0, n + 1);
  for (let e = 0; e < parentOf.length; e++) kids[fill[parentOf[e]]++] = childOf[e];
  const parentsStart = new Int32Array(n + 2);
  for (let e = 0; e < childOf.length; e++) parentsStart[childOf[e] + 1]++;
  for (let i = 0; i <= n; i++) parentsStart[i + 1] += parentsStart[i];
  const parents = new Int32Array(childOf.length);
  const pfill = parentsStart.slice(0, n + 1);
  for (let e = 0; e < childOf.length; e++) parents[pfill[childOf[e]]++] = parentOf[e];

  const pending = new Int32Array(n + 1); // children not yet folded in
  for (let p = 1; p <= n; p++) pending[p] = start[p + 1] - start[p];
  const desc = new Array(n + 1);
  const queue = new Int32Array(n + 1);
  let qh = 0, qt = 0;
  for (let i = 1; i <= n; i++) if (pending[i] === 0) queue[qt++] = i;
  let done = 0;
  while (qh < qt) {
    const node = queue[qh++];
    done++;
    if (start[node + 1] > start[node]) {
      const parts = [new (R())(kids.subarray(start[node], start[node + 1]))];
      for (let k = start[node]; k < start[node + 1]; k++) {
        const d = desc[kids[k]];
        if (d) parts.push(d);
      }
      desc[node] = parts.length === 1 ? parts[0] : R().orMany(parts);
    }
    for (let k = parentsStart[node]; k < parentsStart[node + 1]; k++) {
      const p = parents[k];
      if (--pending[p] === 0) queue[qt++] = p;
    }
  }
  return { desc, cyclic: n - done };
}

/**
 * Descendant sets from explicit (descendant, ancestor) pairs (e.g. LOINC PATH_TO_ROOT).
 * Self pairs are ignored.
 */
function descendantsFromPairs(n, descOf, ancOf) {
  const lists = new Map();
  for (let i = 0; i < descOf.length; i++) {
    const a = ancOf[i], d = descOf[i];
    if (a === d) continue;
    let l = lists.get(a);
    if (!l) lists.set(a, l = []);
    l.push(d);
  }
  const desc = new Array(n + 1);
  for (const [a, l] of lists) desc[a] = new (R())(l);
  return { desc, cyclic: 0 };
}

/**
 * Group (key, member) rows that arrive sorted by key into sets.
 * `rows` is an iterable of [key, member]; calls emit(key, RoaringBitmap32) once per key.
 */
function groupSorted(rows, emit) {
  let cur, have = false;
  let buf = new Uint32Array(1024), len = 0;
  const flush = () => {
    if (have) emit(cur, new (R())(buf.subarray(0, len)));
    len = 0;
  };
  for (const [key, member] of rows) {
    if (!have || key !== cur) { flush(); cur = key; have = true; }
    if (len === buf.length) { const b = new Uint32Array(buf.length * 2); b.set(buf); buf = b; }
    buf[len++] = member;
  }
  flush();
}

module.exports = { SET_KIND, serialize, rangeSet, descendantsFromEdges, descendantsFromPairs, groupSorted };
// (a getter, so that only a module that uses RoaringBitmap32 loads roaring)
Object.defineProperty(module.exports, 'RoaringBitmap32', { enumerable: true, get: R });
