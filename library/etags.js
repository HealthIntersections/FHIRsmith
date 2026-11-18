'use strict';

/**
 * ETags: what Express makes for a response, and the ones the tx module makes for stored resources.
 *
 * Express sets a weak ETag on every res.send with a body, by hashing the body (SHA-1), for every
 * method - so every POST operation pays for a hash no client will ever use. For the few-KB
 * responses most calls return that costs microseconds; for a 64 MB CodeSystem it's about
 * 100 ms, on top of having serialised it. So the app's ETag function (boundedWeakETag) leaves
 * large bodies without one. Small ones get the same ETag as before.
 *
 * A stored resource (a read by id) is the one case where clients do revalidate (thousands of
 * 304s a day on tx.fhir.org, for /r5/CodeSystem/{id}). For those the tx module sets its own
 * ETag - storedResourceETag - from a hash of the resource, worked out once per resource and
 * remembered, and answers a matching If-None-Match with 304 before serialising anything.
 */

const crypto = require('crypto');

// bodies larger than this get no ETag from Express (bytes, measured as characters for a string)
const MAX_HASHED_BODY = 1024 * 1024;

/**
 * The ETag the 'etag' package (what Express uses) makes: length and SHA-1 of the body
 * @private
 */
function entityTag(buf) {
  if (buf.length === 0) {
    return '"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"';
  }
  const hash = crypto.createHash('sha1').update(buf).digest('base64').substring(0, 27);
  return `"${buf.length.toString(16)}-${hash}"`;
}

/**
 * For app.set('etag', ...): Express's weak ETag, except for bodies larger than maxBytes,
 * which get none
 * @param {number} [maxBytes]
 * @returns {Function} (body, encoding) => ETag or undefined
 */
function boundedWeakETag(maxBytes = MAX_HASHED_BODY) {
  return (body, encoding) => {
    if (body.length > maxBytes) {
      return undefined;
    }
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, encoding);
    if (buf.length > maxBytes) {
      return undefined;
    }
    return 'W/' + entityTag(buf);
  };
}

// stored resource -> hash of its content, worked out once
const resourceHashes = new WeakMap();

/**
 * A weak ETag for a stored resource as served in a given format and FHIR version: a hash of
 * the resource (as stored, R5), with the format and version, since each is a different
 * representation. The hash is content, not identity, so every process of a cluster gives the
 * same ETag for the same resource, and a changed resource gets a new one. Worked out once per
 * resource object and remembered - which relies on a stored resource not being changed once
 * served (as the XML cache does).
 *
 * @param {object} resource - the stored resource (R5)
 * @param {string} format - 'json' or 'xml'
 * @param {string} fhirVersion - the endpoint's FHIR version
 * @returns {string}
 */
function storedResourceETag(resource, format, fhirVersion) {
  let hash = resourceHashes.get(resource);
  if (!hash) {
    hash = crypto.createHash('sha1').update(JSON.stringify(resource)).digest('base64url').substring(0, 27);
    resourceHashes.set(resource, hash);
  }
  return `W/"${hash}-${format}-${fhirVersion}"`;
}

module.exports = { boundedWeakETag, storedResourceETag, MAX_HASHED_BODY };
