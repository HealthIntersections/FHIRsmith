const {VersionUtilities} = require("../../library/version-utilities");
const { mapShared, designationsFromR5, convertOnce, CS_ADDITIONAL_USE_EXT } = require("./xv-shared");

/**
 * Converts input CodeSystem to R5 format (modifies input object for performance)
 * @param {Object} jsonObj - The input CodeSystem object
 * @param {string} version - Source FHIR version
 * @returns {Object} The same object, potentially modified to R5 format
 * @private
 */

function codeSystemToR5(jsonObj, version) {
  if (VersionUtilities.isR5Ver(version)) {
    return jsonObj; // Already R5, no conversion needed
  }

  if (VersionUtilities.isR3Ver(version)) {
    // R3 to R5: Convert identifier from single object to array
    if (jsonObj.identifier && !Array.isArray(jsonObj.identifier)) {
      jsonObj.identifier = [jsonObj.identifier];
    }
    return jsonObj;
  }

  if (VersionUtilities.isR4Ver(version)) {
    // R4 to R5: identifier is already an array, no conversion needed
    return jsonObj;
  }

  throw new Error(`Unsupported FHIR version: ${version}`);
}

/**
 * Converts R5 CodeSystem to target version format (without changing the original: see xv-shared.js)
 * @param {Object} r5Obj - The R5 format CodeSystem object
 * @param {string} targetVersion - Target FHIR version
 * @returns {Object} New object in target version format
 * @private
 */
function codeSystemFromR5(r5Obj, targetVersion) {
  if (VersionUtilities.isR5Ver(targetVersion)) {
    return r5Obj; // No conversion needed
  }
  const r3 = VersionUtilities.isR3Ver(targetVersion);
  if (!r3 && !VersionUtilities.isR4Ver(targetVersion)) {
    throw new Error(`Unsupported target FHIR version: ${targetVersion}`);
  }

  // Copy on write (see xv-shared.js): the top level and the filters are copied, because the
  // conversions below change them; the concepts are copied only where one changes, so a
  // large code system with nothing to convert in its concepts shares them all
  const cloned = { ...r5Obj };
  if (Array.isArray(r5Obj.filter)) {
    cloned.filter = r5Obj.filter.map(f => (Array.isArray(f.operator) ? { ...f, operator: [...f.operator] } : { ...f }));
  }
  if (Array.isArray(r5Obj.concept)) {
    cloned.concept = convertOnce(r5Obj.concept, r3 ? 'cs-r3' : 'cs-r4', concepts => mapShared(concepts, c => conceptFromR5(c, r3)));
  }
  if (r3 && Array.isArray(r5Obj.property)) {
    // R3 has no decimal properties
    const kept = r5Obj.property.filter(p => p.type !== 'decimal');
    if (kept.length !== r5Obj.property.length) {
      cloned.property = kept;
    }
  }

  return r3 ? codeSystemR5ToR3(cloned) : codeSystemR5ToR4(cloned);
}

/**
 * A concept, and those under it, for R4 or R3: designation.additionalUse into its extension,
 * and for R3, decimal property values dropped (R3 has no decimal properties). The same concept
 * if nothing in it changes.
 * @private
 */
function conceptFromR5(concept, r3) {
  const children = Array.isArray(concept.concept) ? mapShared(concept.concept, c => conceptFromR5(c, r3)) : concept.concept;
  const designation = designationsFromR5(concept.designation, CS_ADDITIONAL_USE_EXT);
  let property = concept.property;
  if (r3 && Array.isArray(property)) {
    const kept = property.filter(p => p.valueDecimal === undefined);
    if (kept.length !== property.length) {
      property = kept;
    }
  }
  if (children === concept.concept && designation === concept.designation && property === concept.property) {
    return concept;
  }
  const copy = { ...concept };
  if (children !== concept.concept) {
    copy.concept = children;
  }
  if (designation !== concept.designation) {
    copy.designation = designation;
  }
  if (property !== concept.property) {
    copy.property = property;
  }
  return copy;
}

/**
 * Converts R5 CodeSystem to R4 format
 * @param {Object} r5Obj - Cloned R5 CodeSystem object
 * @returns {Object} R4 format CodeSystem
 * @private
 */
function codeSystemR5ToR4(r5Obj) {
  // Remove R5-specific elements that don't exist in R4
  if (r5Obj.versionAlgorithmString) {
    delete r5Obj.versionAlgorithmString;
  }
  if (r5Obj.versionAlgorithmCoding) {
    delete r5Obj.versionAlgorithmCoding;
  }

  // Filter out R5-only filter operators
  if (r5Obj.filter && Array.isArray(r5Obj.filter)) {
    r5Obj.filter = r5Obj.filter.map(filter => {
      if (filter.operator && Array.isArray(filter.operator)) {
        // Remove R5-only operators like 'generalizes'
        filter.operator = filter.operator.filter(op =>
          !isR5OnlyFilterOperator(op)
        );
      }
      return filter;
    }).filter(filter =>
      // Remove filters that have no valid operators left
      !filter.operator || filter.operator.length > 0
    );
  }

  return r5Obj;
}

/**
 * Converts R5 CodeSystem to R3 format
 * @param {Object} r5Obj - Cloned R5 CodeSystem object
 * @returns {Object} R3 format CodeSystem
 * @private
 */
function codeSystemR5ToR3(r5Obj) {
  // First apply R4 conversions
  const r4Obj = codeSystemR5ToR4(r5Obj);

  // R5/R4 to R3: Convert identifier from array back to single object
  if (r4Obj.identifier && Array.isArray(r4Obj.identifier)) {
    if (r4Obj.identifier.length > 0) {
      // Take the first identifier if multiple exist
      r4Obj.identifier = r4Obj.identifier[0];
    } else {
      // Remove empty array
      delete r4Obj.identifier;
    }
  }

  // Remove additional R4-specific elements that don't exist in R3
  if (r4Obj.supplements) {
    delete r4Obj.supplements;
  }

  // R3 has more limited filter operator support
  if (r4Obj.filter && Array.isArray(r4Obj.filter)) {
    r4Obj.filter = r4Obj.filter.map(filter => {
      if (filter.operator && Array.isArray(filter.operator)) {
        // Keep only R3-compatible operators
        filter.operator = filter.operator.filter(op =>
          isR3CompatibleFilterOperator(op)
        );
      }
      return filter;
    }).filter(filter =>
      // Remove filters that have no valid operators left
      !filter.operator || filter.operator.length > 0
    );
  }

  return r4Obj;
}

/**
 * Checks if a filter operator is R5-only
 * @param {string} operator - Filter operator code
 * @returns {boolean} True if operator is R5-only
 * @private
 */
function isR5OnlyFilterOperator(operator) {
  // Operators added in R5 that are not valid in R4 or earlier.
  // NOTE: 'generalizes' is NOT R5-only — it is a valid R4 operator
  // (filter-operator value set, 4.0.1), so it must not be stripped here.
  const r5OnlyOperators = [
    'child-of',        // Added in R5
    'descendent-leaf', // Added in R5
  ];
  return r5OnlyOperators.includes(operator);
}

/**
 * Checks if a filter operator is compatible with R3
 * @param {string} operator - Filter operator code
 * @returns {boolean} True if operator is R3-compatible
 * @private
 */
function isR3CompatibleFilterOperator(operator) {
  const r3CompatibleOperators = [
    '=',           // Equal
    'is-a',        // Is-A relationship
    'descendent-of', // Descendant of (note: R3 spelling)
    'is-not-a',    // Is-Not-A relationship
    'regex',       // Regular expression
    'in',          // In set
    'not-in',      // Not in set
    'exists',      // Property exists
  ];
  return r3CompatibleOperators.includes(operator);
}

module.exports = { codeSystemToR5, codeSystemFromR5 };