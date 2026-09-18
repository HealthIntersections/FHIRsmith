const {VersionUtilities} = require("../../library/version-utilities");

// R4/R3 have no ConceptMap.group.unmapped.valueSet or .relationship. The Java version
// convertors carry them across as these cross-version extensions, so read them back.
const EXT_UNMAPPED_VALUESET = 'http://hl7.org/fhir/5.0/StructureDefinition/extension-ConceptMap.group.unmapped.valueSet';
const EXT_UNMAPPED_RELATIONSHIP = 'http://hl7.org/fhir/5.0/StructureDefinition/extension-ConceptMap.group.unmapped.relationship';

/**
 * R4 spells group.unmapped differently: the target map is 'url' rather than 'otherMap',
 * and the 'provided' mode is called 'use-source-code' in R5.
 */
function unmappedToR5(unmapped) {
  if (!unmapped) {
    return;
  }
  if (unmapped.mode === 'provided') {
    unmapped.mode = 'use-source-code';
  }
  if (unmapped.url !== undefined && unmapped.otherMap === undefined) {
    unmapped.otherMap = unmapped.url;
    delete unmapped.url;
  }
  for (const ext of unmapped.extension || []) {
    if (ext.url === EXT_UNMAPPED_VALUESET && unmapped.valueSet === undefined) {
      unmapped.valueSet = ext.valueCanonical || ext.valueUri;
    }
    if (ext.url === EXT_UNMAPPED_RELATIONSHIP && unmapped.relationship === undefined) {
      unmapped.relationship = ext.valueCode || ext.valueString;
    }
  }
  if (unmapped.extension) {
    unmapped.extension = unmapped.extension.filter(e => e.url !== EXT_UNMAPPED_VALUESET && e.url !== EXT_UNMAPPED_RELATIONSHIP);
    if (unmapped.extension.length === 0) {
      delete unmapped.extension;
    }
  }
}

/** The inverse of unmappedToR5. */
function unmappedFromR5(unmapped) {
  if (!unmapped) {
    return;
  }
  if (unmapped.mode === 'use-source-code') {
    unmapped.mode = 'provided';
  }
  if (unmapped.otherMap !== undefined) {
    unmapped.url = unmapped.otherMap;
    delete unmapped.otherMap;
  }
  if (unmapped.valueSet !== undefined) {
    (unmapped.extension = unmapped.extension || []).push({url: EXT_UNMAPPED_VALUESET, valueCanonical: unmapped.valueSet});
    delete unmapped.valueSet;
  }
  if (unmapped.relationship !== undefined) {
    (unmapped.extension = unmapped.extension || []).push({url: EXT_UNMAPPED_RELATIONSHIP, valueCode: unmapped.relationship});
    delete unmapped.relationship;
  }
}

/**
 * Converts input ConceptMap to R5 format (modifies input object for performance)
 * @param {Object} jsonObj - The input ConceptMap object
 * @param {string} version - Source FHIR version
 * @returns {Object} The same object, potentially modified to R5 format
 * @private
 */

function conceptMapToR5(jsonObj, sourceVersion) {
  if (VersionUtilities.isR5Ver(sourceVersion)) {
    return jsonObj; // No conversion needed
  }

  if (VersionUtilities.isR3Ver(sourceVersion) || VersionUtilities.isR4Ver(sourceVersion)) {
    // Convert identifier from single object to array
    if (jsonObj.identifier && !Array.isArray(jsonObj.identifier)) {
      jsonObj.identifier = [jsonObj.identifier];
    }

    // Convert source/target to sourceScope/targetScope
    if (jsonObj.source !== undefined) {
      // Combine source + sourceVersion if both exist
      if (jsonObj.sourceVersion) {
        jsonObj.sourceScope = `${jsonObj.source}|${jsonObj.sourceVersion}`;
        delete jsonObj.sourceVersion;
      } else {
        jsonObj.sourceScope = jsonObj.source;
      }
      delete jsonObj.source;
    }

    if (jsonObj.target !== undefined) {
      // Combine target + targetVersion if both exist
      if (jsonObj.targetVersion) {
        jsonObj.targetScope = `${jsonObj.target}|${jsonObj.targetVersion}`;
        delete jsonObj.targetVersion;
      } else {
        jsonObj.targetScope = jsonObj.target;
      }
      delete jsonObj.target;
    }

    // Convert equivalence to relationship in group.element.target
    if (jsonObj.group && Array.isArray(jsonObj.group)) {
      jsonObj.group.forEach(group => {
        unmappedToR5(group.unmapped);
        if (group.element && Array.isArray(group.element)) {
          group.element.forEach(element => {
            // R4 has no element.noMap. A target with equivalence = 'unmatched' and no
            // code is R4's way of saying the same thing: there is positively no map
            // for this concept. Lift it to noMap and drop the placeholder target, so
            // everything downstream sees one R5 shape. This mirrors what the Java
            // convertors do (ConceptMap40_50.convertSourceElementComponent), including
            // their reservation of 'unmatched' for noMap - a real 'not-related-to'
            // target converts to 'disjoint' and carries a code, so it is untouched here.
            if (element.target && Array.isArray(element.target)) {
              const noMapTargets = element.target.filter(t => t.equivalence === 'unmatched' && !t.code);
              if (noMapTargets.length > 0) {
                element.noMap = true;
                const comment = noMapTargets.find(t => t.comment);
                if (comment && !element.comment) {
                  element.comment = comment.comment;
                }
                element.target = element.target.filter(t => !(t.equivalence === 'unmatched' && !t.code));
                if (element.target.length === 0) {
                  delete element.target;
                }
              }
            }
            if (element.target && Array.isArray(element.target)) {
              element.target.forEach(target => {
                if (target.equivalence && !target.relationship) {
                  // Convert equivalence to relationship and keep both
                  target.relationship = convertEquivalenceToRelationship(target.equivalence);
                  // Keep equivalence for backward compatibility
                }
              });
            }
          });
        }
      });
    }

    return jsonObj;
  }
  throw new Error(`Unsupported FHIR version: ${sourceVersion}`);
}

/**
 * Converts R5 ConceptMap to target version format (clones object first)
 * @param {Object} r5Obj - The R5 format ConceptMap object
 * @param {string} targetVersion - Target FHIR version
 * @returns {Object} New object in target version format
 * @private
 */
function conceptMapFromR5(r5Obj, targetVersion) {
  if (VersionUtilities.isR5Ver(targetVersion)) {
    return r5Obj; // No conversion needed
  }

  // Clone the object to avoid modifying the original
  const cloned = JSON.parse(JSON.stringify(r5Obj));

  if (VersionUtilities.isR4Ver(targetVersion)) {
    return conceptMapR5ToR4(cloned);
  } else if (VersionUtilities.isR3Ver(targetVersion)) {
    return conceptMapR5ToR3(cloned);
  }

  throw new Error(`Unsupported target FHIR version: ${targetVersion}`);
}

/**
 * Converts R5 ConceptMap to R4 format
 * @param {Object} r5Obj - Cloned R5 ConceptMap object
 * @returns {Object} R4 format ConceptMap
 * @private
 */
function conceptMapR5ToR4(r5Obj) {
  // Remove R5-specific elements
  if (r5Obj.versionAlgorithmString) {
    delete r5Obj.versionAlgorithmString;
  }
  if (r5Obj.versionAlgorithmCoding) {
    delete r5Obj.versionAlgorithmCoding;
  }
  if (r5Obj.property) {
    delete r5Obj.property;
  }
  if (r5Obj.additionalAttribute) {
    delete r5Obj.additionalAttribute;
  }

  // Convert identifier array back to single object
  if (r5Obj.identifier && Array.isArray(r5Obj.identifier)) {
    if (r5Obj.identifier.length > 0) {
      r5Obj.identifier = r5Obj.identifier[0]; // Take first identifier
    } else {
      delete r5Obj.identifier;
    }
  }

  // Convert sourceScope/targetScope back to source/target + version
  if (r5Obj.sourceScope) {
    const parts = r5Obj.sourceScope.split('|');
    r5Obj.source = parts[0];
    if (parts.length > 1) {
      r5Obj.sourceVersion = parts[1];
    }
    delete r5Obj.sourceScope;
  }

  if (r5Obj.targetScope) {
    const parts = r5Obj.targetScope.split('|');
    r5Obj.target = parts[0];
    if (parts.length > 1) {
      r5Obj.targetVersion = parts[1];
    }
    delete r5Obj.targetScope;
  }

  // Convert relationship back to equivalence in group.element.target
  if (r5Obj.group && Array.isArray(r5Obj.group)) {
    r5Obj.group.forEach(group => {
      unmappedFromR5(group.unmapped);
      if (group.element && Array.isArray(group.element)) {
        group.element.forEach(element => {
          if (element.target && Array.isArray(element.target)) {
            element.target.forEach(target => {
              // If we have both equivalence and relationship, prefer equivalence for R4
              if (target.relationship && !target.equivalence) {
                target.equivalence = convertRelationshipToEquivalence(target.relationship);
              }
              // Remove R5-only relationship field
              delete target.relationship;
            });
          }
        });
      }
    });
  }

  return r5Obj;
}

/**
 * Converts R5 ConceptMap to R3 format
 * @param {Object} r5Obj - Cloned R5 ConceptMap object
 * @returns {Object} R3 format ConceptMap
 * @private
 */
function conceptMapR5ToR3(r5Obj) {
  // First apply R4 conversions
  const r4Obj = conceptMapR5ToR4(r5Obj);

  return r4Obj;
}


/**
 * Converts R3/R4 equivalence to R5 relationship
 * @param {string} equivalence - R3/R4 equivalence value
 * @returns {string} R5 relationship value
 * @private
 */
// The two vocabularies name the relationship from opposite ends. R3/R4 equivalence
// describes the TARGET ('wider' = the target is wider than the source); R5 relationship
// describes the SOURCE ('source-is-narrower-than-target'). So wider <-> narrower-than-
// target, and narrower <-> broader-than-target. These tables follow the Java convertors
// (ConceptMap30_50 / ConceptMap40_50), which are the reference.
function convertEquivalenceToRelationship(equivalence) {
  const equivalenceToRelationship = {
    'relatedto': 'related-to',
    'equivalent': 'equivalent',
    'equal': 'equivalent',
    'wider': 'source-is-narrower-than-target',
    'subsumes': 'source-is-narrower-than-target',
    'narrower': 'source-is-broader-than-target',
    'specializes': 'source-is-broader-than-target',
    'inexact': 'related-to',
    // Java gives no relationship for 'unmatched' (a target-less 'unmatched' is lifted to
    // element.noMap before this is reached); R5 requires one, so not-related-to it is
    'unmatched': 'not-related-to',
    'disjoint': 'not-related-to'
  };
  return equivalenceToRelationship[equivalence] || 'related-to';
}

/**
 * Converts R5 relationship back to R3/R4 equivalence
 * @param {string} relationship - R5 relationship value
 * @returns {string} R3/R4 equivalence value
 * @private
 */
function convertRelationshipToEquivalence(relationship) {
  const relationshipToEquivalence = {
    'related-to': 'relatedto',
    'equivalent': 'equivalent',
    'source-is-narrower-than-target': 'wider',
    'source-is-broader-than-target': 'narrower',
    // 'unmatched' is reserved for "no map" (see conceptMapToR5); a real not-related-to
    // target is disjoint, as in the Java convertors
    'not-related-to': 'disjoint'
  };
  return relationshipToEquivalence[relationship] || 'relatedto';
}



module.exports = { conceptMapToR5, conceptMapFromR5 };




