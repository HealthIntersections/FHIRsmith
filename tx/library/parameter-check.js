//
// Checking what a code system provider adds to a $lookup response
//
// extendLookup() hands the provider the response parameter list and lets it
// push whatever it likes. Most providers push values they built themselves out
// of curated content, where the shape is known good. Some pass data through
// from a remote API, where a value can be any JSON at all - an object, an
// array, a null - and a structure like that in a FHIR primitive produces a
// response that is not valid FHIR.
//
// That's a bug in the provider, not something the client did, so it fails the
// operation (500/exception) rather than shipping a malformed response and
// leaving someone downstream to work out where it came from.
//

// value[x] elements carried by a JSON string
const STRING_VALUES = new Set([
  'valueString', 'valueCode', 'valueUri', 'valueUrl', 'valueCanonical',
  'valueId', 'valueOid', 'valueUuid', 'valueMarkdown', 'valueBase64Binary',
  'valueDate', 'valueDateTime', 'valueTime', 'valueInstant'
]);

// value[x] elements carried by a JSON integer
const INTEGER_VALUES = new Set(['valueInteger', 'valuePositiveInt', 'valueUnsignedInt']);

// The one complex type a lookup property is allowed to carry. Its own members
// are all primitives (system, version, code, display, userSelected), so an
// object or array inside one is just as wrong as it would be at the top.
const CODING_VALUE = 'valueCoding';

function describe(value) {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return 'a ' + typeof value;
}

function fail(source, path, message) {
  throw new Error(`Code system provider ${source} produced an invalid $lookup response at ${path}: ${message}`);
}

function checkCoding(value, source, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(source, path, `valueCoding must be an object, not ${describe(value)}`);
  }
  for (const [key, member] of Object.entries(value)) {
    if (member === null || member === undefined) {
      continue;
    }
    const type = typeof member;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
      fail(source, path, `valueCoding.${key} must be a primitive, not ${describe(member)}`);
    }
  }
}

function checkValue(key, value, source, path) {
  if (STRING_VALUES.has(key)) {
    if (typeof value !== 'string') {
      fail(source, path, `${key} must be a string, not ${describe(value)}`);
    }
    return;
  }
  if (INTEGER_VALUES.has(key)) {
    if (!Number.isInteger(value)) {
      fail(source, path, `${key} must be an integer, not ${describe(value)}`);
    }
    return;
  }
  if (key === 'valueDecimal') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(source, path, `${key} must be a finite number, not ${describe(value)}`);
    }
    return;
  }
  if (key === 'valueBoolean') {
    if (typeof value !== 'boolean') {
      fail(source, path, `${key} must be a boolean, not ${describe(value)}`);
    }
    return;
  }
  if (key === CODING_VALUE) {
    checkCoding(value, source, path);
    return;
  }
  fail(source, path, `${key} is not a value type a lookup property may carry`);
}

function checkParameter(param, source, path) {
  if (param === null || typeof param !== 'object' || Array.isArray(param)) {
    fail(source, path, `a parameter must be an object, not ${describe(param)}`);
  }
  if (typeof param.name !== 'string' || param.name === '') {
    fail(source, path, `a parameter must have a name, not ${describe(param.name)}`);
  }

  const name = param.name;
  const valueKeys = Object.keys(param).filter(key => key.startsWith('value'));
  if (valueKeys.length > 1) {
    fail(source, `${path}.${name}`, `a parameter may carry one value, not ${valueKeys.length} (${valueKeys.join(', ')})`);
  }
  for (const key of valueKeys) {
    checkValue(key, param[key], source, `${path}.${name}`);
  }

  if (param.part !== undefined) {
    if (!Array.isArray(param.part)) {
      fail(source, `${path}.${name}`, `part must be an array, not ${describe(param.part)}`);
    }
    for (const part of param.part) {
      checkParameter(part, source, `${path}.${name}`);
    }
  }
}

/**
 * Check the parameters a provider added to a lookup response.
 *
 * @param {Array} params - the whole response parameter list
 * @param {number} fromIndex - where the provider's own additions start, so
 *   that only what extendLookup() added is checked
 * @param {string} source - the code system, for the error message
 * @throws {Error} if the provider produced something that isn't valid FHIR
 */
function checkAddedParameters(params, fromIndex, source) {
  if (!Array.isArray(params)) {
    return;
  }
  for (let i = fromIndex; i < params.length; i++) {
    checkParameter(params[i], source || 'unknown', 'parameter');
  }
}

module.exports = {
  checkAddedParameters
};
