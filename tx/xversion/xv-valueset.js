const {VersionUtilities} = require("../../library/version-utilities");
const {getValueName, getValuePrimitive} = require("../../library/utilities");
const {Extensions} = require("../library/extensions");
const { mapShared, designationsFromR5, convertOnce, VS_ADDITIONAL_USE_EXT } = require("./xv-shared");

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
 * Converts R5 ValueSet to target version format, without changing the original: what changes
 * is copied, and the rest shared (see xv-shared.js) - for a large expansion, only the contains
 * that carry properties or designation.additionalUse are copied
 * @param {Object} r5Obj - The R5 format ValueSet object
 * @param {string} targetVersion - Target FHIR version
 * @returns {Object} New object in target version format
 * @private
 */
function valueSetFromR5(r5Obj, targetVersion) {
  if (VersionUtilities.isR5Ver(targetVersion)) {
    return r5Obj; // No conversion needed
  }
  const r3 = VersionUtilities.isR3Ver(targetVersion);
  if (!r3 && !VersionUtilities.isR4Ver(targetVersion)) {
    throw new Error(`Unsupported target FHIR version: ${targetVersion}`);
  }

  const out = { ...r5Obj };
  if (out.versionAlgorithmString) {
    delete out.versionAlgorithmString;
  }
  if (out.versionAlgorithmCoding) {
    delete out.versionAlgorithmCoding;
  }
  if (out.compose) {
    out.compose = composeFromR5(out.compose, r3);
  }
  if (out.expansion) {
    out.expansion = expansionFromR5(out.expansion, r3);
  }
  return out;
}

/**
 * ValueSet.compose for R4 or R3: compose.property into its extension, filter operators the
 * version doesn't have into the filter.op extension, and designation.additionalUse into its
 * extension
 * @private
 */
function composeFromR5(compose, r3) {
  const out = { ...compose };
  // ValueSet.compose.property has no home in R4, so it goes into the extension
  if (Array.isArray(compose.property) && compose.property.length > 0) {
    out.extension = [...(compose.extension || []), ...compose.property.map(prop => ({ url: COMPOSE_PROPERTY_EXT, valueString: prop }))];
    delete out.property;
  }
  if (compose.include) {
    out.include = compose.include.map(inc => includeFromR5(inc, r3));
  }
  if (compose.exclude) {
    out.exclude = compose.exclude.map(inc => includeFromR5(inc, r3));
  }
  return out;
}

/** An include or exclude (the same object if nothing in it changes) @private */
function includeFromR5(inc, r3) {
  const filter = Array.isArray(inc.filter) ? mapShared(inc.filter, f => filterFromR5(f, r3)) : inc.filter;
  const concept = Array.isArray(inc.concept)
    ? mapShared(inc.concept, c => {
      const designation = designationsFromR5(c.designation, VS_ADDITIONAL_USE_EXT);
      return designation === c.designation ? c : { ...c, designation };
    })
    : inc.concept;
  if (filter === inc.filter && concept === inc.concept) {
    return inc;
  }
  const out = { ...inc };
  if (filter !== inc.filter) {
    out.filter = filter;
  }
  if (concept !== inc.concept) {
    out.concept = concept;
  }
  return out;
}

/**
 * A filter whose operator the version doesn't have: the operator goes into the filter.op
 * extension (R5-only operators for R4; for R3, also those R3 doesn't have)
 * @private
 */
function filterFromR5(filter, r3) {
  let out = filter;
  if (out.op && isR5OnlyFilterOperator(out.op)) {
    out = { ...out, _op: filterOpExtension(out.op) };
    delete out.op;
  }
  if (r3 && out.op && !isR3CompatibleFilterOperator(out.op)) {
    out = { ...out, _op: filterOpExtension(out.op) };
    delete out.op;
  }
  return out;
}

function filterOpExtension(op) {
  return { "extension": [{ url: "http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.compose.include.filter.op", "valueCode": op }] };
}

/**
 * ValueSet.expansion for R4 or R3: expansion.property, and each contains.property, into their
 * extensions (both R5-only), and designation.additionalUse into its extension
 * @private
 */
function expansionFromR5(expansion, r3) {
  const out = { ...expansion };
  if (expansion.property && expansion.property.length > 0) {
    // uri is 0..1: a property without one (a provider that doesn't declare its properties)
    // must not produce an empty uri extension, which is not valid
    out.extension = [...(expansion.extension || []), ...expansion.property.map(prop => {
      const ext = [{ url: "code", valueCode: prop.code }];
      if (prop.uri) {
        ext.push({ url: "uri", valueUri: prop.uri });
      }
      return { url: "http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.expansion.property", extension: ext };
    })];
    delete out.property;
  }
  // contains.property must be converted whether or not the expansion declares expansion-level
  // property definitions: a contained code can carry a property with no expansion.property present.
  // (A cached expansion's contains are converted again on every R4 response: convertOnce keeps
  // the result, so it's the same each time - and its XML can come from the XML cache)
  if (Array.isArray(expansion.contains)) {
    out.contains = convertOnce(expansion.contains, r3 ? 'vs-r3' : 'vs-r4', contains => mapShared(contains, containsFromR5));
  }
  return out;
}

/** A contains, and those under it (the same object if nothing in it changes) @private */
function containsFromR5(item) {
  const contains = Array.isArray(item.contains) ? mapShared(item.contains, containsFromR5) : item.contains;
  const designation = designationsFromR5(item.designation, VS_ADDITIONAL_USE_EXT);
  const hasProperties = item.property && item.property.length > 0;
  if (!hasProperties && contains === item.contains && designation === item.designation) {
    return item;
  }
  const out = { ...item };
  if (hasProperties) {
    out.extension = [...(item.extension || []), ...item.property.map(prop => {
      const pn = getValueName(prop);
      const value = { url: "value" };
      value[pn] = prop[pn];
      return {
        url: "http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.expansion.contains.property",
        extension: [{ url: "code", valueCode: prop.code }, value]
      };
    })];
    delete out.property;
  }
  if (contains !== item.contains) {
    out.contains = contains;
  }
  if (designation !== item.designation) {
    out.designation = designation;
  }
  return out;
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

