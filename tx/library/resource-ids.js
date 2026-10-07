//
// Resource ids in the server's id spaces
//
// Every CodeSystem, ValueSet and ConceptMap the server serves by id lives in the id space of
// the provider that loaded it, and its id is the provider's prefix, a '-', then the id the
// resource had in its source: "tho-v3-ActCode", "core-v3-MaritalStatus". The prefix is the
// provider's spaceId: given in the library YAML (npm:hl7.terminology=tho), autonumbered by
// the library when the YAML doesn't give one, and "core" for the FHIR core package each
// endpoint loads for itself.
//
// No resource is served under its original id. Two sources can carry resources with the same
// id (hl7.terminology and hl7.fhir.r4.core both have a CodeSystem v3-MaritalStatus), so an
// unprefixed id can't say which one it means - and anything that looks a resource up by its
// raw id must fail, rather than find whichever one happens to come first.
//

// resources whose id has been prefixed - so prefixing is idempotent, and a raw id that
// happens to start with the prefix still gets one
const prefixed = new WeakSet();

/**
 * Prefix a resource's id with spaceId. The resource is either a wrapper with a jsonObj
 * (CodeSystem, ValueSet, ConceptMap) or a plain json object. Does nothing to a resource
 * that has already been prefixed, or that has no id.
 *
 * @param {Object} resource
 * @param {string} spaceId
 */
function applyIdPrefix(resource, spaceId) {
  if (!resource || !spaceId || prefixed.has(resource)) {
    return;
  }
  const json = resource.jsonObj || resource;
  if (!json.id) {
    return;
  }
  const id = `${spaceId}-${json.id}`;
  json.id = id;
  if (resource.jsonObj && Object.prototype.hasOwnProperty.call(resource, 'id')) {
    resource.id = id;
  }
  prefixed.add(resource);
}

/**
 * The id a resource had in its source, for an id served in spaceId - or null, if the id
 * isn't in that space (including when it's a raw id, or there's no spaceId).
 *
 * @param {string} id
 * @param {string} spaceId
 * @returns {string|null}
 */
function stripIdPrefix(id, spaceId) {
  if (!spaceId || typeof id !== 'string') {
    return null;
  }
  const prefix = `${spaceId}-`;
  return id.startsWith(prefix) && id.length > prefix.length ? id.substring(prefix.length) : null;
}

/**
 * Whether a prefix given in the library YAML is acceptable. It's the start of an id, so it
 * may only use id characters, and no '-', so that the prefix of any id is unambiguous.
 * 'core' is the endpoints' own core package, and 'x' is the code system factories
 * (CodeSystem/x-...), so neither is available.
 *
 * @param {string} prefix
 * @returns {string|null} why the prefix isn't acceptable, or null if it is
 */
function checkIdPrefix(prefix) {
  if (!/^[A-Za-z0-9.]{1,32}$/.test(prefix)) {
    return `an id prefix may only contain letters, digits and '.' (up to 32 characters)`;
  }
  if (prefix === CORE_PREFIX || prefix === 'x') {
    return `the id prefix '${prefix}' is reserved`;
  }
  return null;
}

/**
 * Put a provider in an id space - the shared part of the providers' assignIds(spaceId).
 * A provider is put in one id space, once: its resources are prefixed when it is, so
 * moving it to another would leave them in the old one. Asking again for the same space
 * does nothing.
 *
 * @param {Object} provider - a code system, value set or concept map provider
 * @param {string} spaceId
 * @returns {boolean} true if the provider has just been put in the space, and must now
 *   prefix its resources' ids
 */
function assignIdSpace(provider, spaceId) {
  if (!spaceId) {
    throw new Error(`${provider.constructor.name}: no id space given`);
  }
  if (provider.spaceId) {
    if (provider.spaceId === spaceId) {
      return false;
    }
    throw new Error(`${provider.constructor.name} is already in the id space '${provider.spaceId}', so it can't be put in '${spaceId}'`);
  }
  provider.spaceId = spaceId;
  return true;
}

const CORE_PREFIX = 'core';

module.exports = { applyIdPrefix, stripIdPrefix, checkIdPrefix, assignIdSpace, CORE_PREFIX };
