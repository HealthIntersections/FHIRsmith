'use strict';
//
// A value set include or exclude whose concept list a value-set provider keeps in a store (a
// database, say) rather than in memory. The provider puts a handle on the include under
// STORED_CONCEPTS:
//
//   { count: number, lookup(code) => the listed concepts with this code, in list order }
//
// The handle is per include (and per exclude), since a compose may have several for one system.
// lookup may return a promise. The include's `concept` must still give the whole list when it is
// read (typically a getter that reads it on first use), for code that needs every entry; code
// that asks about one code uses the handle and doesn't read the list. An ordinary include, with
// `concept` an array and no handle, behaves as always.
//
// What the provider promises:
//
// - lookup(code) returns the entries whose code is exactly `code`, as the in-memory path finds
//   them (cc.code === code): case included, whether or not the code system is case-sensitive.
//   (For a code system that isn't case-sensitive, $validate-code still matches a listed code
//   exactly, so a stored list must too.) listedConcepts keeps only exact matches of whatever
//   lookup returns, so a lookup that also matches other spellings (a NOCASE column, say) can't
//   change the answer; one that misses an exact match would.
// - No listed concept carries a modifierExtension. For an ordinary include, $validate-code
//   refuses the value set when any listed concept has one (422, VALUESET_MODIFIER_EXTENSION_UNKNOWN,
//   at ValueSet.compose.include[i].concept[j], or exclude[i]), before it checks the code, whatever
//   the code. It doesn't read a stored list to look, so a provider leaves such an include as an
//   ordinary array (no handle), and the validator refuses it as always. ($expand reads the whole
//   list, and refuses such an entry when it reaches it, either way.)
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
 * The concepts the include lists with exactly this code, in list order: asked of a stored list,
 * found in an ordinary one
 * @returns {Promise<Object[]>}
 */
async function listedConcepts(cset, code) {
  const stored = storedList(cset);
  const found = stored ? ((await stored.lookup(code)) || []) : (cset.concept || []);
  return found.filter(cc => cc.code === code);
}

module.exports = { STORED_CONCEPTS, storedList, hasConcepts, listedConcepts };
