/**
 * Copy-on-write helpers for the conversions from R5 (xv-codesystem.js, xv-valueset.js).
 *
 * The resources being converted are the stored ones (or cached expansions), so a conversion
 * must not change them. It used to deep-copy the whole resource first - for a large code
 * system or expansion, tens of MB of copying and garbage on every R4 or R3 response. Instead
 * a conversion copies only what is on the way to something it changes: an object it changes
 * is copied (shallowly), and so is every object and array above it; everything else is shared
 * with the original. A part where nothing changes comes back as the same object, so an
 * unchanged concept tree costs a walk and no allocation.
 *
 * What a conversion returns shares objects with what it was given, so it must not be changed
 * either: it is for serialising.
 */

// R5 designation.additionalUse has no R4 or R3 element: it goes into the cross-version
// extension, as ValueSet.compose.property and filter.op already do
const CS_ADDITIONAL_USE_EXT = 'http://hl7.org/fhir/5.0/StructureDefinition/extension-CodeSystem.concept.designation.additionalUse';
const VS_ADDITIONAL_USE_EXT = 'http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.compose.include.concept.designation.additionalUse';

/**
 * array.map(fn), but the same array when fn returns every item unchanged
 * @param {Array} array
 * @param {Function} fn - item => the item, or a converted copy
 * @returns {Array}
 */
function mapShared(array, fn) {
  let out = null;
  for (let i = 0; i < array.length; i++) {
    const item = array[i];
    const next = fn(item);
    if (out) {
      out.push(next);
    } else if (next !== item) {
      out = array.slice(0, i);
      out.push(next);
    }
  }
  return out || array;
}

/**
 * A designation without additionalUse (R4, R3): the same designation if it has none, else a
 * copy with each one in the cross-version extension
 * @param {object} designation
 * @param {string} url - the extension for where the designation is
 * @returns {object}
 */
function designationFromR5(designation, url) {
  if (!designation || !Array.isArray(designation.additionalUse)) {
    return designation;
  }
  const copy = { ...designation };
  if (designation.additionalUse.length > 0) {
    copy.extension = [...(designation.extension || []), ...designation.additionalUse.map(c => ({ url, valueCoding: c }))];
  }
  delete copy.additionalUse;
  return copy;
}

/**
 * The designations of a concept (or contains), as designationFromR5
 * @returns {Array|undefined} the same array if none changes
 */
function designationsFromR5(designations, url) {
  return Array.isArray(designations) ? mapShared(designations, d => designationFromR5(d, url)) : designations;
}

// a converted array for each original one and target, for arrays converted again and again
// (the concepts of a stored code system, the contains of a cached expansion): the same
// result each time, so serialising it can come from the XML cache
const converted = new WeakMap();

/**
 * convert(array), remembered for this array and key. Only for arrays that aren't changed
 * once served (see the note at the top).
 * @param {Array} array
 * @param {string} key - the target version, and anything else the result depends on
 * @param {Function} convert - array => the converted array (the same one if unchanged)
 */
function convertOnce(array, key, convert) {
  let byKey = converted.get(array);
  if (!byKey) {
    byKey = new Map();
    converted.set(array, byKey);
  }
  let result = byKey.get(key);
  if (result === undefined || result.length !== array.length) {
    result = convert(array);
    byKey.set(key, result);
  }
  return result;
}

module.exports = { mapShared, designationFromR5, designationsFromR5, convertOnce, CS_ADDITIONAL_USE_EXT, VS_ADDITIONAL_USE_EXT };
