'use strict';

/**
 * ETags for stored resources read by id (a CodeSystem, ValueSet or ConceptMap, as JSON or XML).
 *
 * Clients revalidate these (thousands of 304s a day on tx.fhir.org). Nothing else gets an
 * ETag from the app: Express's own ETag (a SHA-1 of every response body, POSTs included) is
 * off, since no client revalidates an operation or a search, and hashing a large body cost
 * ~100 ms. Static files still get theirs, from express.static.
 *
 * A stored resource can't change once loaded, and its content is fixed by where it came from,
 * so the ETag is worked out from that, without looking at the content:
 * - a resource from a package: the package (id#version - the server loads only released
 *   versions) and the resource's type and id
 * - a value set from a database that keeps a hash of each one's content (VSAC): that hash
 * - otherwise (a folder or file the server loads, which can change between runs with nothing
 *   else to say so): a hash of the resource, worked out once and remembered
 * and, for all of them, the server's version (a release can change how a resource is
 * serialised or converted), the format and the FHIR version of the endpoint. So the same
 * resource has the same ETag in every process, across restarts, and on every server running
 * the same release with the same packages.
 */

const crypto = require('crypto');
const SERVER_VERSION = require('../package.json').version;

// stored resource -> hash of its content, for resources whose source doesn't fix their content
const resourceHashes = new WeakMap();

// a package the server loaded (id#version), not a folder or file it made one up for
function isPackage(sourcePackage) {
  return typeof sourcePackage === 'string' && sourcePackage.includes('#') &&
    !/^(folder|file)\./.test(sourcePackage) && !sourcePackage.endsWith('#0.0.0');
}

// what an ETag may hold (RFC 9110: no quotes, spaces or controls)
function safe(s) {
  return String(s).replace(/[^\x21\x23-\x7e]/g, '_');
}

/**
 * The weak ETag for a stored resource as served in a given format and FHIR version
 *
 * @param {object} resource - the stored resource (R5)
 * @param {string} format - 'json' or 'xml'
 * @param {string} fhirVersion - the endpoint's FHIR version
 * @param {object} [source]
 * @param {string} [source.sourcePackage] - the package it was loaded from (id#version)
 * @param {string} [source.contentHash] - a hash of its content its store already keeps
 * @returns {string}
 */
function storedResourceETag(resource, format, fhirVersion, { sourcePackage = null, contentHash = null } = {}) {
  let key;
  if (isPackage(sourcePackage) && resource.resourceType && resource.id) {
    key = `${sourcePackage}/${resource.resourceType}/${resource.id}`;
  } else if (contentHash) {
    key = contentHash;
  } else {
    key = resourceHashes.get(resource);
    if (!key) {
      key = crypto.createHash('sha1').update(JSON.stringify(resource)).digest('base64url').substring(0, 27);
      resourceHashes.set(resource, key);
    }
  }
  return `W/"${safe(`${key}~${format}~${fhirVersion}~${SERVER_VERSION}`)}"`;
}

module.exports = { storedResourceETag, SERVER_VERSION };
