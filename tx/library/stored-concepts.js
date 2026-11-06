'use strict';
//
// A value set include or exclude whose concept list a value-set provider keeps in a store (a
// database, say) rather than in memory. The provider puts a handle on the include under
// STORED_CONCEPTS:
//
//   { count: number, lookup(code) => the listed concepts with this code, in list order }
//
// lookup may return a promise. The include's `concept` must still give the whole list when it is
// read (typically a getter that reads it on first use), for code that needs every entry; code
// that asks about one code uses the handle and doesn't read the list. An ordinary include, with
// `concept` an array and no handle, behaves as always.
//

const STORED_CONCEPTS = Symbol.for('fhirsmith.storedConcepts');

/** the include's stored-list handle, or null for an ordinary include */
function storedList(cset) {
  return (cset && cset[STORED_CONCEPTS]) || null;
}

/** whether the include lists concepts (as `!!cset.concept`), without reading a stored list */
function hasConcepts(cset) {
  return !!storedList(cset) || !!cset.concept;
}

module.exports = { STORED_CONCEPTS, storedList, hasConcepts };
