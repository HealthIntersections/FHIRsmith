const {VersionUtilities} = require("../../library/version-utilities");
const {Extensions} = require("../library/extensions");

/**
 * Converts input TerminologyCapabilities to R5 format (modifies input object for performance)
 * @param {Object} jsonObj - The input TerminologyCapabilities object
 * @param {string} version - Source FHIR version
 * @returns {Object} The same object, potentially modified to R5 format
 * @private
 */

function terminologyCapabilitiesToR5(jsonObj, sourceVersion) {
  if (VersionUtilities.isR5Ver(sourceVersion)) {
    return jsonObj; // No conversion needed
  }

  if (VersionUtilities.isR4Ver(sourceVersion)) {
    const contentExtUrl = "http://hl7.org/fhir/5.0/StructureDefinition/extension-TerminologyCapabilities.codeSystem.content";
    for (const cs of jsonObj.codeSystem || []) {
      // In R4 the content is carried only by the content extension (there is no
      // native codeSystem.content), so read it from the extension directly.
      const cnt = Extensions.readString(cs, contentExtUrl);
      if (cnt) {
        cs.content = cnt;
        // Remove the now-redundant source extension (the field is `extension`,
        // singular). Filter so any unrelated extensions are preserved.
        cs.extension = (cs.extension || []).filter(e => e.url !== contentExtUrl);
        if (cs.extension.length === 0) {
          delete cs.extension;
        }
      }
    }

    return jsonObj;
  }

  if (VersionUtilities.isR3Ver(sourceVersion)) {
    // R3: TerminologyCapabilities doesn't exist - it's a Parameters resource
    // Convert from Parameters format to TerminologyCapabilities
    return convertParametersToR5(jsonObj);
  }

  return jsonObj;
}


/**
 * Converts R3 Parameters format to R5 TerminologyCapabilities
 * @param {Object} params - The Parameters resource
 * @returns {Object} TerminologyCapabilities in R5 format
 * @private
 */
function convertParametersToR5(params) {
  if (params.resourceType !== 'Parameters') {
    throw new Error('R3 TerminologyCapabilities must be a Parameters resource');
  }

  const result = {
    resourceType: 'TerminologyCapabilities',
    id: params.id,
    status: 'active', // Default, as Parameters doesn't carry this
    kind: 'instance', // Default for terminology server capabilities
    codeSystem: []
  };

  const parameters = params.parameter || [];
  let currentSystem = null;

  for (const param of parameters) {
    switch (param.name) {
      case 'url':
        result.url = param.valueUri;
        break;
      case 'version':
        if (currentSystem) {
          // This is a code system version
          if (param.valueCode) {
            currentSystem.version = currentSystem.version || [];
            currentSystem.version.push({ code: param.valueCode });
          }
          // Empty version parameter means no specific version
        } else {
          // This is the TerminologyCapabilities version
          result.version = param.valueCode || param.valueString;
        }
        break;
      case 'date':
        result.date = param.valueDateTime;
        break;
      case 'system':
        // Start a new code system
        currentSystem = { uri: param.valueUri };
        result.codeSystem.push(currentSystem);
        break;
      case 'expansion.parameter':
        result.expansion = result.expansion || { parameter: [] };
        result.expansion.parameter.push({ name: param.valueCode });
        break;
    }
  }

  return result;
}


/**
 * Converts R5 TerminologyCapabilities to target version format (clones object first)
 * @param {Object} r5Obj - The R5 format TerminologyCapabilities object
 * @param {string} targetVersion - Target FHIR version
 * @returns {Object} New object in target version format
 * @private
 */
function terminologyCapabilitiesFromR5(r5Obj, targetVersion) {
  if (VersionUtilities.isR5Ver(targetVersion)) {
    return r5Obj; // No conversion needed
  }

  // Clone the object to avoid modifying the original
  const cloned = JSON.parse(JSON.stringify(r5Obj));

  if (VersionUtilities.isR4Ver(targetVersion)) {
    return terminologyCapabilitiesR5ToR4(cloned);
  } else if (VersionUtilities.isR3Ver(targetVersion)) {
    return terminologyCapabilitiesR5ToR3(cloned);
  }

  throw new Error(`Unsupported target FHIR version: ${targetVersion}`);
}

/**
 * Converts R5 TerminologyCapabilities to R4 format
 * @param {Object} r5Obj - Cloned R5 TerminologyCapabilities object
 * @returns {Object} R4 format TerminologyCapabilities
 * @private
 */
function terminologyCapabilitiesR5ToR4(r5Obj) {

  if (r5Obj.versionAlgorithmString) {
    delete r5Obj.versionAlgorithmString;
  }
  if (r5Obj.versionAlgorithmCoding) {
    delete r5Obj.versionAlgorithmCoding;
  }
  for (const cs of r5Obj.codeSystem || []) {
    if (cs.content) {
      if (!cs.extension) {
        cs.extension = [];
      }
      cs.extension.push({"url" : "http://hl7.org/fhir/5.0/StructureDefinition/extension-TerminologyCapabilities.codeSystem.content", valueCode : cs.content});
      delete cs.content;
    }
  }

  return r5Obj;
}

/**
 * Converts R5 TerminologyCapabilities to R3 format
 * @param {Object} r5Obj - Cloned R5 TerminologyCapabilities object
 * @returns {Object} R3 format TerminologyCapabilities
 * @private
 */
function terminologyCapabilitiesR5ToR3(r5Obj) {
  // In R3, TerminologyCapabilities didn't exist - we represent it as a Parameters resource
  const params = {
    resourceType: 'Parameters',
    id: r5Obj.id,
    parameter: []
  };

  // Add url parameter
  if (r5Obj.url) {
    params.parameter.push({
      name: 'url',
      valueUri: r5Obj.url
    });
  }

  // Add version parameter
  if (r5Obj.version) {
    params.parameter.push({
      name: 'version',
      valueCode: r5Obj.version
    });
  }

  // Add date parameter
  if (r5Obj.date) {
    params.parameter.push({
      name: 'date',
      valueDateTime: r5Obj.date
    });
  }

  // Add code systems with their versions
  for (const codeSystem of r5Obj.codeSystem || []) {
    // Add system parameter
    params.parameter.push({
      name: 'system',
      valueUri: codeSystem.uri
    });

    // Add version parameter(s) for this code system
    if (codeSystem.version && codeSystem.version.length > 0) {
      for (const ver of codeSystem.version) {
        if (ver.code) {
          params.parameter.push({
            name: 'version',
            valueCode: ver.code
          });
        } else {
          // Empty version parameter when no specific version
          params.parameter.push({
            name: 'version'
          });
        }
      }
    } else {
      // No version specified for this code system
      params.parameter.push({
        name: 'version'
      });
    }
  }

  // Add expansion parameters
  if (r5Obj.expansion && r5Obj.expansion.parameter) {
    for (const expParam of r5Obj.expansion.parameter) {
      params.parameter.push({
        name: 'expansion.parameter',
        valueCode: expParam.name
      });
    }
  }

  return params;
}

module.exports = { terminologyCapabilitiesToR5, terminologyCapabilitiesFromR5 };
