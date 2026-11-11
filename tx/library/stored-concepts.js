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
// The whole list is read in one case: when the code isn't listed as given, and the code system
// has another form of it (classificationCode() - ICD-11's short code and entity id), each listed
// code is located and compared, as for an ordinary include.
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

/**
 * The concepts the include lists with this code, in list order: asked of a stored list, found in
 * an ordinary one
 * @returns {Promise<Object[]>}
 */
async function listedConcepts(cset, code) {
  const stored = storedList(cset);
  if (stored) {
    return (await stored.lookup(code)) || [];
  }
  return (cset.concept || []).filter(cc => cc.code === code);
}

module.exports = { STORED_CONCEPTS, storedList, hasConcepts, listedConcepts };
