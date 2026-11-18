const {VersionUtilities} = require("../../library/version-utilities");
const { mapShared } = require("./xv-shared");

/**
 * Converts input Parameters to R5 format (modifies input object for performance)
 * @param {Object} jsonObj - The input Parameters object
 * @param {string} version - Source FHIR version
 * @returns {Object} The same object, potentially modified to R5 format
 * @private
 */

function parametersToR5(jsonObj, sourceVersion) {
  if (VersionUtilities.isR5Ver(sourceVersion)) {
    if (jsonObj.parameter && jsonObj.parameter.find(p => p.name == 'match')) {
      return convertResourceWithinR5(JSON.parse(JSON.stringify(jsonObj)));
    } else {
      return jsonObj; // No conversion needed
    }
  }

  const {convertResourceToR5} = require("./xv-resource");
  for (let p of jsonObj.parameter || []) {
    if (p.resource) {
      p.resource = convertResourceToR5(p.resource, sourceVersion);
    }
  }
  return jsonObj;
}

/**
 * Converts R5 Parameters to target version format, copy on write (see xv-shared.js): a
 * parameter is copied only where it changes, and the resources in it are converted the same
 * way, so a large answer ($translate, a batch validation) isn't deep-copied on every R4 or R3
 * response
 * @param {Object} r5Obj - The R5 format Parameters object (not changed)
 * @param {string} targetVersion - Target FHIR version
 * @returns {Object} New object in target version format (sharing parts with r5Obj)
 * @private
 */
function parametersFromR5(r5Obj, targetVersion) {
  if (VersionUtilities.isR5Ver(targetVersion)) {
    return r5Obj; // No conversion needed
  }
  let convert;
  if (VersionUtilities.isR4Ver(targetVersion)) {
    convert = parameterR5ToR4;
  } else if (VersionUtilities.isR3Ver(targetVersion)) {
    convert = (p) => parameterR5ToR3(p, true);
  } else {
    throw new Error(`Unsupported target FHIR version: ${targetVersion}`);
  }
  const out = { ...r5Obj };
  if (Array.isArray(r5Obj.parameter)) {
    out.parameter = mapShared(r5Obj.parameter, convert);
  }
  return out;
}

/** A parameter, for R4 (the same object if nothing changes) @private */
function parameterR5ToR4(p) {
  const {convertResourceFromR5} = require("./xv-resource");
  let copy = p;
  if (p.resource) {
    const resource = convertResourceFromR5(p.resource, "R4");
    if (resource !== p.resource) {
      copy = { ...copy, resource };
    }
  }
  if (p.name == 'match' && p.part) {
    copy = { ...copy, part: matchPartsFor4(p.part) };
  }
  return copy;
}

/**
 * A parameter (and its parts), for R3: valueCanonical becomes valueUri, at every level, and a
 * top level resource is converted (the same object if nothing changes) @private
 */
function parameterR5ToR3(p, topLevel) {
  let copy = p;
  if (topLevel && p.resource) {
    const {convertResourceFromR5} = require("./xv-resource");
    const resource = convertResourceFromR5(p.resource, "R3");
    if (resource !== p.resource) {
      copy = { ...copy, resource };
    }
  }
  if (p.valueCanonical) {
    copy = { ...copy, valueUri: p.valueCanonical };
    delete copy.valueCanonical;
  }
  if (Array.isArray(p.part)) {
    const part = mapShared(p.part, pp => parameterR5ToR3(pp, false));
    if (part !== p.part) {
      copy = { ...copy, part };
    }
  }
  return copy;
}

function convertResourceWithinR5(r5Obj) {
  for (let p of r5Obj.parameter || []) {
    if (p.name == 'match') {
      fixMatchParameterfor5(p);
    }
  }
  return r5Obj;

}

function fixMatchParameterfor5(p) {
  if (p.part) {
    p.part = p.part.filter(pp => pp.name !== 'equivalence');
  }
}

// The parts of a $translate match, for R4: a new array (the parts themselves are not changed)
function matchPartsFor4(parts) {
  const out = [...parts];
  // R4 calls originMap 'source'. originMap is reported in every version; source is added
  // here for R4 only, and is prohibited everywhere else
  if (!out.find(pp => pp.name === 'source')) {
    let om = out.find(pp => pp.name === 'originMap');
    if (om && om.valueCanonical) {
      out.push({name: "source", valueCanonical: om.valueCanonical});
    }
  }
  if (!out.find(pp => pp.name === 'equivalence')) {
    let rel = out.find(pp => pp.name === 'relationship');
    if (rel && rel.valueCode) {
      let pp = {name: "equivalence"};
      switch (rel.valueCode) {
        case 'related-to':
          pp.valueCode = 'relatedto';
          break;
        case 'equivalent':
          pp.valueCode = 'equivalent';
          break;
        case 'source-is-narrower-than-target':
          pp.valueCode = 'wider';
          break;
        case 'source-is-broader-than-target':
          pp.valueCode = 'narrower';
          break;
        case 'not-related-to':
          pp.valueCode = 'unmatched';
          break;
      }
      out.push(pp);
    }
  }
  return out.filter(pp => pp.name !== 'relationship');
}

module.exports = { parametersToR5, parametersFromR5 };