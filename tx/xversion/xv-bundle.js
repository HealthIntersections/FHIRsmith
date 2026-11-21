const {VersionUtilities} = require("../../library/version-utilities");

/**
 * Converts input Bundle to R5 format (modifies input object for performance)
 * @param {Object} jsonObj - The input Bundle object
 * @param {string} version - Source FHIR version
 * @returns {Object} The same object, potentially modified to R5 format
 * @private
 */

function bundleToR5(jsonObj, sourceVersion) {
  const { convertResourceToR5 } = require("./xv-resource");

  if (VersionUtilities.isR5Ver(sourceVersion)) {
    return jsonObj; // No conversion needed
  }

  for (let be of jsonObj.entry || []) {
    convertResourceToR5(be.resource, sourceVersion);
  }
  return jsonObj;
}

/**
 * Converts R5 Bundle to target version format (clones object first)
 * @param {Object} r5Obj - The R5 format Bundle object
 * @param {string} targetVersion - Target FHIR version
 * @returns {Object} New object in target version format
 * @private
 */
function bundleFromR5(r5Obj, targetVersion) {
  const {convertResourceFromR5} = require("./xv-resource");

  if (VersionUtilities.isR5Ver(targetVersion)) {
    return r5Obj; // No conversion needed
  }

  // Clone the object to avoid modifying the original
  const bundle = {
    resourceType: "Bundle"
  }
  bundle.id = r5Obj.id;
  bundle.meta = r5Obj.meta;
  bundle.implicitRules = r5Obj.implicitRules;
  bundle.language = r5Obj.language;
  bundle.identifier = r5Obj.identifier;
  bundle.type = r5Obj.type;
  if (VersionUtilities.isR4Ver(targetVersion)) {
    bundle.timestamp = r5Obj.timestamp;
  }
  bundle.total = r5Obj.total;
  bundle.link = r5Obj.link;
  for (let be5 of r5Obj.entry || []) {
    let be = {};
    if (!bundle.entry) {
      bundle.entry = [];
    }
    bundle.entry.push(be);
    be.link = be5.link;
    be.fullUrl = be5.fullUrl;
    be.search = be5.search;
    be.request = be5.request;
    be.response = be5.response;
    be.resource = convertResourceFromR5(be5.resource, targetVersion);
  }

  return bundle;
}

module.exports = { bundleToR5, bundleFromR5 };
