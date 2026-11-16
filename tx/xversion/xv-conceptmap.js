const {VersionUtilities} = require("../../library/version-utilities");
const { mapShared, convertOnce } = require("./xv-shared");

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
  if (!unmapped || !(unmapped.mode === 'use-source-code' || unmapped.otherMap !== undefined ||
      unmapped.valueSet !== undefined || unmapped.relationship !== undefined)) {
    return unmapped;
  }
  // a copy: the stored map is not changed (copy on write, see conceptMapFromR5)
  const copy = { ...unmapped };
  if (copy.mode === 'use-source-code') {
    copy.mode = 'provided';
  }
  if (copy.otherMap !== undefined) {
    copy.url = copy.otherMap;
    delete copy.otherMap;
  }
  if (copy.valueSet !== undefined || copy.relationship !== undefined) {
    copy.extension = [...(copy.extension || [])];
  }
  if (copy.valueSet !== undefined) {
    copy.extension.push({url: EXT_UNMAPPED_VALUESET, valueCanonical: copy.valueSet});
    delete copy.valueSet;
  }
  if (copy.relationship !== undefined) {
    copy.extension.push({url: EXT_UNMAPPED_RELATIONSHIP, valueCode: copy.relationship});
    delete copy.relationship;
  }
  return copy;
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
 * Converts R5 ConceptMap to target version format, copy on write (see xv-shared.js): the top
 * level is copied; in the groups, only what changes is, so a large map whose targets need no
 * change shares them all, and the converted groups are kept for the next time (convertOnce)
 * @param {Object} r5Obj - The R5 format ConceptMap object (not changed)
 * @param {string} targetVersion - Target FHIR version
 * @returns {Object} New object in target version format (sharing parts with r5Obj)
 * @private
 */
function conceptMapFromR5(r5Obj, targetVersion) {
  if (VersionUtilities.isR5Ver(targetVersion)) {
    return r5Obj; // No conversion needed
  }
  // R3 is converted as R4 is
  if (!VersionUtilities.isR4Ver(targetVersion) && !VersionUtilities.isR3Ver(targetVersion)) {
    throw new Error(`Unsupported target FHIR version: ${targetVersion}`);
  }

  const out = { ...r5Obj };
  // Remove R5-specific elements
  delete out.versionAlgorithmString;
  delete out.versionAlgorithmCoding;
  delete out.property;
  delete out.additionalAttribute;

  // Convert identifier array back to single object
  if (Array.isArray(r5Obj.identifier)) {
    if (r5Obj.identifier.length > 0) {
      out.identifier = r5Obj.identifier[0]; // Take first identifier
    } else {
      delete out.identifier;
    }
  }

  // Convert sourceScope/targetScope back to source/target + version
  if (r5Obj.sourceScope) {
    const parts = r5Obj.sourceScope.split('|');
    out.source = parts[0];
    if (parts.length > 1) {
      out.sourceVersion = parts[1];
    }
    delete out.sourceScope;
  }
  if (r5Obj.targetScope) {
    const parts = r5Obj.targetScope.split('|');
    out.target = parts[0];
    if (parts.length > 1) {
      out.targetVersion = parts[1];
    }
    delete out.targetScope;
  }

  // Convert relationship back to equivalence in group.element.target
  if (Array.isArray(r5Obj.group)) {
    out.group = convertOnce(r5Obj.group, 'cm-r4', groups => mapShared(groups, groupFromR5));
  }
  return out;
}

/** A group (the same object if nothing in it changes) @private */
function groupFromR5(group) {
  const unmapped = unmappedFromR5(group.unmapped);
  const element = Array.isArray(group.element) ? mapShared(group.element, elementFromR5) : group.element;
  if (unmapped === group.unmapped && element === group.element) {
    return group;
  }
  const copy = { ...group };
  if (unmapped !== group.unmapped) {
    copy.unmapped = unmapped;
  }
  if (element !== group.element) {
    copy.element = element;
  }
  return copy;
}

/** An element (the same object if none of its targets changes) @private */
function elementFromR5(element) {
  if (!Array.isArray(element.target)) {
    return element;
  }
  const target = mapShared(element.target, targetFromR5);
  return target === element.target ? element : { ...element, target };
}

/** A target: relationship becomes equivalence (the same object if it has no relationship) @private */
function targetFromR5(target) {
  if (target.relationship === undefined) {
    return target;
  }
  const copy = { ...target };
  // If we have both equivalence and relationship, prefer equivalence for R4
  if (target.relationship && !target.equivalence) {
    copy.equivalence = convertRelationshipToEquivalence(target.relationship);
  }
  // Remove R5-only relationship field
  delete copy.relationship;
  return copy;
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




