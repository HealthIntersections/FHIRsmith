//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Formats: the one place they are handled. JSON only for now; XML is refused with 415 (a
 * body) or 406 (a response), and can be added here later.
 *
 * @module rest/format
 */

const { FhirError, badRequest } = require('./library/errors');

const FHIR_JSON = 'application/fhir+json';
const JSON_TYPES = new Set(['json', 'application/json', 'application/fhir+json', 'fhir+json', 'application/json+fhir', 'text/json']);
const XML_TYPES = new Set(['xml', 'application/xml', 'application/fhir+xml', 'fhir+xml', 'application/xml+fhir', 'text/xml']);
const PATCH_JSON = 'application/json-patch+json';

/**
 * The response format the client wants: 'json', or throws 406.
 * @param {Object} req
 */
function responseFormat(req) {
  const f = typeof req.query._format === 'string' ? req.query._format.trim().toLowerCase().replace(/ /g, '+') : '';
  if (f) {
    const base = f.split(';')[0].trim();
    if (JSON_TYPES.has(base)) {
      return 'json';
    }
    if (XML_TYPES.has(base)) {
      throw new FhirError(406, 'not-supported', 'This server only returns JSON (_format=json)');
    }
    if (base === 'html' || base === 'text/html') {
      return 'json';
    }
    throw new FhirError(406, 'not-supported', `Unknown _format '${f}'`);
  }
  const accept = String(req.get('Accept') || '').toLowerCase();
  if (!accept) {
    return 'json';
  }
  const types = accept.split(',').map(p => p.split(';')[0].trim()).filter(t => t);
  if (types.some(t => JSON_TYPES.has(t) || t === '*/*' || t === 'application/*' || t === 'text/html' || t === 'text/*')) {
    return 'json';
  }
  if (types.some(t => XML_TYPES.has(t))) {
    throw new FhirError(406, 'not-supported', 'This server only returns JSON (Accept: application/fhir+json)');
  }
  return 'json';
}

/**
 * The request body as an object: JSON (the server's parsers leave fhir+json as a Buffer).
 * @param {Object} req
 * @param {Object} [options] - { patch: true } accepts application/json-patch+json
 */
function requestBody(req, options = {}) {
  const ct = String(req.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (XML_TYPES.has(ct)) {
    throw new FhirError(415, 'not-supported', 'This server only accepts JSON (application/fhir+json)');
  }
  if (ct && !JSON_TYPES.has(ct) && !(options.patch && ct === PATCH_JSON) && ct !== 'application/x-www-form-urlencoded') {
    throw new FhirError(415, 'not-supported', `Content-Type ${ct} is not supported: use application/fhir+json`);
  }
  let b = req.body;
  if (Buffer.isBuffer(b)) {
    if (b.length === 0) {
      return null;
    }
    try {
      b = JSON.parse(b.toString('utf8'));
    } catch (e) {
      throw badRequest(`The body is not valid JSON: ${e.message}`);
    }
  } else if (typeof b === 'string') {
    if (!b.trim()) {
      return null;
    }
    try {
      b = JSON.parse(b);
    } catch (e) {
      throw badRequest(`The body is not valid JSON: ${e.message}`);
    }
  } else if (b && typeof b === 'object' && Object.keys(b).length === 0 && !ct) {
    return null;
  }
  return b === undefined ? null : b;
}

/** Whether the client wants indented output */
function pretty(req) {
  return req.query._pretty === 'true';
}

function serialise(req, body) {
  return pretty(req) ? JSON.stringify(body, null, 2) : JSON.stringify(body);
}

module.exports = { responseFormat, requestBody, serialise, FHIR_JSON, PATCH_JSON, JSON_TYPES, XML_TYPES };
