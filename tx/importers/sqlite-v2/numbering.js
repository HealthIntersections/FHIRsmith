'use strict';

// Dense concept numbering for the sqlite-v2 schema.
//
// concept_id is assigned here, once, at import. It is a 1-based position in this order:
//
//   1. active concepts, depth-first over the active hierarchy edges between active concepts.
//      The walk is topological: a concept is numbered when the LAST of its parents has been
//      numbered, so every ancestor gets a smaller id than its descendants. Roots and
//      siblings are visited in (sort key, code) order.
//   2. active concepts the walk could not reach (only possible with a cycle), in (key, code)
//      order.
//   3. inactive concepts, in (key, code) order.
//
// So `active` is exactly the range [1, activeCount] and, for every active concept A, every
// descendant of A has an id greater than A's. With polyhierarchy a concept lives under its
// last-visited parent; subtrees are still mostly contiguous id ranges, which is what makes
// the Roaring descendant sets small.

const DIGITS = /^\d+$/;

// Deterministic code order: all-digit codes (SNOMED, RxNorm) compare numerically (length
// first, then lexically; no BigInt needed for 18-digit SCTIDs); anything else lexically.
function compareCodes(a, b) {
  if (a.length !== b.length && DIGITS.test(a) && DIGITS.test(b)) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param {object} input
 * @param {string[]} input.codes          provisional index -> code (index 0..n-1)
 * @param {Uint8Array} input.active       provisional index -> 1/0
 * @param {Int32Array} input.childOf      hierarchy edge i: child index
 * @param {Int32Array} input.parentOf     hierarchy edge i: parent index
 * @param {Float64Array|Int32Array} [input.sortKey]  optional per-index sort key (smaller first)
 * @returns {{ order: Int32Array, idOf: Int32Array, activeCount: number, reached: number,
 *            unreached: number, roots: number }}
 *   order[k] = provisional index of the concept that gets concept_id k+1;
 *   idOf[i]  = concept_id (1-based) of provisional index i.
 */
function numberConcepts(input) {
  const { codes, active, childOf, parentOf } = input;
  const n = codes.length;
  const key = input.sortKey || null;
  const cmp = (a, b) => (key ? key[a] - key[b] : 0) || compareCodes(codes[a], codes[b]);

  // Edges used for ordering: active child, active parent, no self loops, de-duplicated.
  // (child * n + parent stays below 2^53 for any realistic n.)
  let pairs = new Float64Array(childOf.length);
  let m = 0;
  for (let e = 0; e < childOf.length; e++) {
    const c = childOf[e], p = parentOf[e];
    if (c === p || !active[c] || !active[p]) continue;
    pairs[m++] = c * n + p;
  }
  pairs = pairs.subarray(0, m).sort();
  let u = 0;
  for (let i = 0; i < m; i++) if (i === 0 || pairs[i] !== pairs[u - 1]) pairs[u++] = pairs[i];
  pairs = pairs.subarray(0, u);
  m = u;

  // CSR child lists (sorted by key, code) and remaining-parent counts.
  const childStart = new Int32Array(n + 1);
  const remaining = new Int32Array(n);
  for (const x of pairs) { const p = x % n; childStart[p + 1]++; remaining[Math.floor(x / n)]++; }
  for (let i = 0; i < n; i++) childStart[i + 1] += childStart[i];
  const children = new Int32Array(m);
  const fill = childStart.slice(0, n);
  for (const x of pairs) { const p = x % n; children[fill[p]++] = Math.floor(x / n); }
  for (let p = 0; p < n; p++) {
    const s = childStart[p], e = childStart[p + 1];
    if (e - s > 1) children.set(Array.from(children.subarray(s, e)).sort(cmp), s);
  }

  const roots = [];
  for (let i = 0; i < n; i++) if (active[i] && remaining[i] === 0) roots.push(i);
  roots.sort(cmp);

  const order = new Int32Array(n);
  const placed = new Uint8Array(n);
  let k = 0;
  const nodeStack = new Int32Array(n);
  const curStack = new Int32Array(n);
  for (const r of roots) {
    order[k++] = r; placed[r] = 1;
    let sp = 0;
    nodeStack[0] = r; curStack[0] = childStart[r];
    while (sp >= 0) {
      const node = nodeStack[sp];
      if (curStack[sp] >= childStart[node + 1]) { sp--; continue; }
      const c = children[curStack[sp]++];
      if (--remaining[c] !== 0) continue; // another parent is still to come
      order[k++] = c; placed[c] = 1;
      sp++; nodeStack[sp] = c; curStack[sp] = childStart[c];
    }
  }
  const reached = k;

  const rest = [];
  for (let i = 0; i < n; i++) if (active[i] && !placed[i]) rest.push(i);
  rest.sort(cmp);
  for (const i of rest) { order[k++] = i; placed[i] = 1; }
  const activeCount = k;

  const inactive = [];
  for (let i = 0; i < n; i++) if (!active[i]) inactive.push(i);
  inactive.sort(cmp);
  for (const i of inactive) order[k++] = i;

  const idOf = new Int32Array(n);
  for (let j = 0; j < n; j++) idOf[order[j]] = j + 1;
  return { order, idOf, activeCount, reached, unreached: rest.length, roots: roots.length };
}

module.exports = { numberConcepts, compareCodes };
