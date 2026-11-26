//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Formats: the one place they are handled. JSON and XML (by the endpoint's XML model: xml.js).
 *
 * @module rest/format
 */

const { FhirError, badRequest } = require('./library/errors');
const { toXml, toXmlChunks, fromXml, XmlProblem } = require('./xml');
const fhirJson = require('../library/fhir-json');
const { duplicateIssues } = require('../library/json-duplicates');

const FHIR_JSON = 'application/fhir+json';
const FHIR_XML = 'application/fhir+xml';
const JSON_TYPES = new Set(['json', 'application/json', 'application/fhir+json', 'fhir+json', 'application/json+fhir', 'text/json']);
const XML_TYPES = new Set(['xml', 'application/xml', 'application/fhir+xml', 'fhir+xml', 'application/xml+fhir', 'text/xml']);
const PATCH_JSON = 'application/json-patch+json';

/**
 * The response format the client wants: 'json' or 'xml', or throws 406. _format wins; then
 * Accept, the first type in it (by its q values, then its order) that is JSON or XML, where
 * text/html and wildcards are JSON; otherwise JSON.
 * @param {Object} req
 * @param {Object|null} [xmlModel] - the endpoint's (null: XML can't be done)
 */
function responseFormat(req, xmlModel = null) {
  const f = typeof req.query._format === 'string' ? req.query._format.trim().toLowerCase().replace(/ /g, '+') : '';
  if (f) {
    const base = f.split(';')[0].trim();
    if (JSON_TYPES.has(base) || base === 'html' || base === 'text/html') {
      return 'json';
    }
    if (XML_TYPES.has(base)) {
      return xmlOr406(xmlModel);
    }
    throw new FhirError(406, 'not-supported', `Unknown _format '${f}'`);
  }
  const accept = String(req.get('Accept') || '').toLowerCase();
  if (!accept) {
    return 'json';
  }
  const types = accept.split(',').map((p, i) => {
    const [t, ...params] = p.split(';').map(x => x.trim());
    const q = params.map(x => /^q=([0-9.]+)$/.exec(x)).find(x => x);
    return { t, q: q ? Number(q[1]) : 1, i };
  }).filter(x => x.t && x.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { t } of types) {
    // (a browser's text/html, or a wildcard, is the default: JSON)
    if (JSON_TYPES.has(t) || t === '*/*' || t === 'application/*' || t === 'text/html' || t === 'text/*') {
      return 'json';
    }
    if (XML_TYPES.has(t)) {
      return xmlOr406(xmlModel);
    }
  }
  return 'json';
}

function xmlOr406(xmlModel) {
  if (!xmlModel) {
    throw new FhirError(406, 'not-supported', 'This endpoint can\'t do XML: its definitions have no XML model');
  }
  return 'xml';
}

/** The response format, for an error: JSON if what was asked for can't be had */
function errorFormat(req, xmlModel) {
  try {
    return responseFormat(req, xmlModel);
  } catch (e) {
    return 'json';
  }
}

/**
 * A body with a property more than once in an object is refused (400): JSON parsers keep
 * only one of them (the last), so what was meant can't be known. This is checked on every
 * JSON body, whether or not resources are validated.
 */
function noDuplicates(text, req, body) {
  const issues = duplicateIssues(text, {
    acceptLanguage: req.get('Accept-Language'),
    resourceType: body && typeof body === 'object' && !Array.isArray(body) ? body.resourceType : undefined
  });
  if (issues.length) {
    throw badRequest(issues[0].details.text, { issues });
  }
}

/**
 * The request body as an object: JSON or XML (the server's parsers leave them as a Buffer).
 * @param {Object} req
 * @param {Object} [options] - { patch: true } accepts application/json-patch+json; xmlModel:
 *   the endpoint's (null: XML isn't accepted); as: 'json' or 'xml', to read the body as that
 *   whatever its Content-Type says (a Binary's, binary.js)
 */
function requestBody(req, options = {}) {
  let ct = String(req.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (options.as === 'json') {
    ct = FHIR_JSON;
  } else if (options.as === 'xml') {
    ct = FHIR_XML;
  }
  if (XML_TYPES.has(ct)) {
    return xmlBody(req, options.xmlModel || null);
  }
  if (ct && !JSON_TYPES.has(ct) && !(options.patch && ct === PATCH_JSON) && ct !== 'application/x-www-form-urlencoded') {
    throw new FhirError(415, 'not-supported', `Content-Type ${ct} is not supported: use application/fhir+json or application/fhir+xml`);
  }
  let b = req.body;
  // application/json arrives parsed (server.js), with its text alongside: read that instead
  if (Buffer.isBuffer(req.rawBody) && b && typeof b === 'object' && !Buffer.isBuffer(b)) {
    b = req.rawBody;
  }
  if (Buffer.isBuffer(b) || typeof b === 'string') {
    const text = Buffer.isBuffer(b) ? b.toString('utf8') : b;
    if (!text.trim()) {
      return null;
    }
    try {
      b = fhirJson.parse(text);
    } catch (e) {
      throw badRequest(`The body is not valid JSON: ${e.message}`);
    }
    noDuplicates(text, req, b);
  } else if (b && typeof b === 'object' && Object.keys(b).length === 0 && !ct) {
    return null;
  }
  return b === undefined ? null : b;
}

function xmlBody(req, xmlModel) {
  if (!xmlModel) {
    throw new FhirError(415, 'not-supported', 'This endpoint can\'t read XML: its definitions have no XML model');
  }
  const b = req.body;
  const text = Buffer.isBuffer(b) ? b.toString('utf8') : typeof b === 'string' ? b : '';
  if (!text.trim()) {
    return null;
  }
  try {
    return fromXml(text, xmlModel);
  } catch (e) {
    if (e instanceof XmlProblem) {
      throw badRequest(`The body is not FHIR XML this server can read: ${e.message}`);
    }
    throw e;
  }
}

/** Whether the client wants indented output */
function pretty(req) {
  return req.query._pretty === 'true';
}

/**
 * A response body, as the format asks.
 * @param {Object} req
 * @param {Object} body
 * @param {string} fmt - 'json' or 'xml'
 * @param {Object|null} xmlModel
 * @returns {{text: string, contentType: string}}
 * @throws FhirError (500) when the resource can't be written as XML (it has something the
 *   definitions don't)
 */
function serialise(req, body, fmt = 'json', xmlModel = null) {
  if (fmt === 'xml') {
    try {
      return { text: toXml(body, xmlModel, { pretty: pretty(req) }), contentType: FHIR_XML + '; charset=utf-8' };
    } catch (e) {
      if (e instanceof XmlProblem) {
        throw new FhirError(500, 'exception', `This can't be returned as XML: ${e.message} (ask for JSON instead)`);
      }
      throw e;
    }
  }
  return { text: pretty(req) ? fhirJson.stringify(body, null, 2) : fhirJson.stringify(body), contentType: FHIR_JSON + '; charset=utf-8' };
}

/**
 * serialise, in parts, without holding the event loop for a large resource (XML: see
 * library/fhir-xml.js toXmlChunks; JSON is one string, as JSON.stringify makes it).
 * @param {Object} req
 * @param {Object} body
 * @param {string} fmt
 * @param {Object|null} xmlModel
 * @param {Function} [stillWanted] - false when the client has gone: serialising stops
 * @returns {Promise<{parts: Array<string|Buffer>, contentType: string}>}
 */
async function serialiseParts(req, body, fmt = 'json', xmlModel = null, stillWanted = null) {
  if (fmt !== 'xml') {
    const out = serialise(req, body, fmt, xmlModel);
    return { parts: [out.text], contentType: out.contentType };
  }
  try {
    return { parts: await toXmlChunks(body, xmlModel, { pretty: pretty(req), stillWanted }), contentType: FHIR_XML + '; charset=utf-8' };
  } catch (e) {
    if (e instanceof XmlProblem) {
      throw new FhirError(500, 'exception', `This can't be returned as XML: ${e.message} (ask for JSON instead)`);
    }
    throw e;
  }
}

module.exports = { responseFormat, errorFormat, requestBody, serialise, serialiseParts, FHIR_JSON, FHIR_XML, PATCH_JSON, JSON_TYPES, XML_TYPES };
