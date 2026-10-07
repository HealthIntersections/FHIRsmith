const {VersionUtilities} = require("../../library/version-utilities");
const {getValueName, getValuePrimitive} = require("../../library/utilities");
const {Extensions} = require("../library/extensions");

// ValueSet.compose.property is R5 and up - it is how a client says which properties it wants
// back in an expansion. R4 and R3 have nowhere to put it, so it travels as a cross-version
// extension, the same one the Java convertors use. Dropping it instead means the expansion
// comes back without the properties that were asked for, which reads as a server fault.
const COMPOSE_PROPERTY_EXT = "http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.compose.property";

/**
 * Converts input ValueSet to R5 format (modifies input object for performance)
 * @param {Object} jsonObj - The input ValueSet object
 * @param {string} version - Source FHIR version
 * @returns {Object} The same object, potentially modified to R5 format
 * @private
 */

function valueSetToR5(jsonObj, sourceVersion) {
  if (VersionUtilities.isR5Ver(sourceVersion)) {
    return jsonObj; // No conversion needed
  }
  for (const inc of jsonObj.compose?.include || []) {
    valueSetIncludeToR5(inc);
  }
  for (const inc of jsonObj.compose?.exclude || []) {
    valueSetIncludeToR5(inc);
  }
  composePropertyToR5(jsonObj.compose);
  if (VersionUtilities.isR4Ver(sourceVersion)) {
    return jsonObj; // No conversion needed
  }
  if (VersionUtilities.isR3Ver(sourceVersion)) {
    // R3 to R5: Remove extensible field (we ignore it completely)
    if (jsonObj.extensible !== undefined) {
      delete jsonObj.extensible;
    }
    return jsonObj; // No conversion needed
  }
  throw new Error(`Unsupported FHIR version: ${sourceVersion}`);
}

/** Read ValueSet.compose.property back out of the cross-version extension. */
function composePropertyToR5(compose) {
  if (!compose) {
    return;
  }
  const carried = Extensions.list(compose, COMPOSE_PROPERTY_EXT);
  if (carried.length === 0) {
    return;
  }
  compose.property = compose.property || [];
  for (const ext of carried) {
    const value = getValuePrimitive(ext);
    if (value !== undefined && value !== null) {
      compose.property.push(value);
    }
  }
  compose.extension = compose.extension.filter(ext => ext.url !== COMPOSE_PROPERTY_EXT);
  if (compose.extension.length === 0) {
    delete compose.extension;
  }
}

function valueSetIncludeToR5(inc) {
  for (const filter of inc.filter || []) {
    if (filter._op) {
      let code = Extensions.readString(filter._op, 'http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.compose.include.filter.op');
      if (code) {
        filter.op = code;
        delete filter._op;
      }
    }
  }
}


/**
 * Converts R5 ValueSet to target version format (clones object first)
 * @param {Object} r5Obj - The R5 format ValueSet object
 * @param {string} targetVersion - Target FHIR version
 * @returns {Object} New object in target version format
 * @private
 */
function valueSetFromR5(r5Obj, targetVersion) {
  if (VersionUtilities.isR5Ver(targetVersion)) {
    return r5Obj; // No conversion needed
  }

  // Clone the object to avoid modifying the original
  const cloned = JSON.parse(JSON.stringify(r5Obj));

  if (VersionUtilities.isR4Ver(targetVersion)) {
    return valueSetR5ToR4(cloned);
  } else if (VersionUtilities.isR3Ver(targetVersion)) {
    return valueSetR5ToR3(cloned);
  }

  throw new Error(`Unsupported target FHIR version: ${targetVersion}`);
}

/**
 * Converts R5 ValueSet to R4 format
 * @param {Object} r5Obj - Cloned R5 ValueSet object
 * @returns {Object} R4 format ValueSet
 * @private
 */
function valueSetR5ToR4(r5Obj) {
  if (r5Obj.versionAlgorithmString) {
    delete r5Obj.versionAlgorithmString;
  }
  if (r5Obj.versionAlgorithmCoding) {
    delete r5Obj.versionAlgorithmCoding;
  }

  // ValueSet.compose.property has no home in R4, so it goes into the extension
  if (r5Obj.compose && Array.isArray(r5Obj.compose.property) && r5Obj.compose.property.length > 0) {
    r5Obj.compose.extension = r5Obj.compose.extension || [];
    for (const prop of r5Obj.compose.property) {
      r5Obj.compose.extension.push({ url: COMPOSE_PROPERTY_EXT, valueString: prop });
    }
    delete r5Obj.compose.property;
  }

  // Filter out R5-only filter operators in compose
  if (r5Obj.compose && r5Obj.compose.include) {
    r5Obj.compose.include = r5Obj.compose.include.map(include => {
      if (include.filter && Array.isArray(include.filter)) {
        include.filter = include.filter.map(filter => {
          if (filter.op && isR5OnlyFilterOperator(filter.op)) {
            filter._op = { "extension": [{ url: "http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.compose.include.filter.op", "valueCode": filter.op}]};
            delete filter.op;
          }
          return filter;
        }).filter(filter => filter !== null);
      }
      return include;
    });
  }

  if (r5Obj.compose && r5Obj.compose.exclude) {
    r5Obj.compose.exclude = r5Obj.compose.exclude.map(exclude => {
      if (exclude.filter && Array.isArray(exclude.filter)) {
        exclude.filter = exclude.filter.map(filter => {
          if (filter.op && isR5OnlyFilterOperator(filter.op)) {
            filter._op = { "extension": [{ url: "http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.compose.include.filter.op", "valueCode": filter.op}]};
            delete filter.op;
          }
          return filter;
        }).filter(filter => filter !== null);
      }
      return exclude;
    });
  }

  if (r5Obj.expansion) {
    let exp = r5Obj.expansion;

    // Convert ValueSet.expansion.property to extensions
    if (exp.property && exp.property.length > 0) {
      exp.extension = exp.extension || [];
      for (let prop of exp.property) {
        exp.extension.push({
          url: "http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.expansion.property",
          extension: [
            { url: "code", valueCode: prop.code },
            { url: "uri", valueUri: prop.uri }
          ]
        });
      }
      delete exp.property;
    }

    // ValueSet.expansion.contains.property is R5-only too, and must be converted
    // whether or not the expansion declares expansion-level property definitions:
    // a contained code can carry a property with no expansion.property present.
    convertContainsPropertyR5ToR4(exp.contains);
  }

  return r5Obj;
}

/**
 * Converts R5 ValueSet to R3 format
 * @param {Object} r5Obj - Cloned R5 ValueSet object
 * @returns {Object} R3 format ValueSet
 * @private
 */
function valueSetR5ToR3(r5Obj) {
  // First apply R4 conversions
  const r4Obj = valueSetR5ToR4(r5Obj);

  // R3 has more limited filter operator support
  if (r4Obj.compose && r4Obj.compose.include) {
    r4Obj.compose.include = r4Obj.compose.include.map(include => {
      if (include.filter && Array.isArray(include.filter)) {
        include.filter = include.filter.map(filter => {
          if (filter.op && !isR3CompatibleFilterOperator(filter.op)) {
            filter._op = { "extension": [{ url: "http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.compose.include.filter.op", "valueCode": filter.op}]};
            delete filter.op;
          }
          return filter;
        }).filter(filter => filter !== null);
      }
      return include;
    });
  }

  if (r4Obj.compose && r4Obj.compose.exclude) {
    r4Obj.compose.exclude = r4Obj.compose.exclude.map(exclude => {
      if (exclude.filter && Array.isArray(exclude.filter)) {
        exclude.filter = exclude.filter.map(filter => {
          if (filter.op && !isR3CompatibleFilterOperator(filter.op)) {
            filter._op = { "extension": [{ url: "http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.compose.include.filter.op", "valueCode": filter.op}]};
            delete filter.op;
          }
          return filter;
        }).filter(filter => filter !== null);
      }
      return exclude;
    });
  }
  return r4Obj;
}



// Recursive function to convert contains.property
function convertContainsPropertyR5ToR4(containsList) {
  if (!containsList) return;

  for (let item of containsList) {
    if (item.property && item.property.length > 0) {
      item.extension = item.extension || [];
      for (let prop of item.property) {
        let ext = {
          url: "http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.expansion.contains.property",
          extension: [
            { url: "code", valueCode: prop.code }
          ]
        };
        let pn = getValueName(prop);
        let subExt = { url: "value" };
        subExt[pn] = prop[pn];
        ext.extension.push(subExt);
        item.extension.push(ext);
      }
      delete item.property;
    }

    // Recurse into nested contains
    if (item.contains) {
      convertContainsPropertyR5ToR4(item.contains);
    }
  }
}


/**
 * Checks if a filter operator is R5-only
 * @param {string} operator - Filter operator code
 * @returns {boolean} True if operator is R5-only
 * @private
 */
function isR5OnlyFilterOperator(operator) {
  const r5OnlyOperators = [
    'child-of', 'descendent-leaf' // Added in R5
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


module.exports = { valueSetToR5, valueSetFromR5 };

