//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Binary as content: a POST or PUT of the bytes themselves, and a read that gives them back.
 *
 *   in   a POST to [base]/Binary, or a PUT to [base]/Binary/[id], whose Content-Type is not a
 *        FHIR format is stored as a Binary with that contentType and the bytes as its data.
 *        X-Security-Context, if given, is its securityContext. A Content-Type that is a FHIR
 *        format is read as a FHIR resource (the Binary resource itself), as for any type
 *   out  a read or vread of a Binary gives its bytes, with its contentType, unless the request
 *        asks for a FHIR format (_format, or Accept) and the Binary's contentType is not one:
 *        then it's the Binary resource, as for any type
 *
 * What is a FHIR format is decided as the Pascal server decided it (fhir_utilities
 * mimeTypeToFormat): the JSON and XML types, and any type with "json" or "xml" in it
 * (application/foo+json). So a Binary whose content is JSON or XML can only be written as a
 * Binary resource (with the content base64 in data), and is always read back as its content,
 * whatever the Accept (the Pascal server read every Binary back as its content). Other types,
 * text/plain and text/html included, are content.
 *
 * @module rest/binary
 */

const { badRequest } = require('./library/errors');
const { JSON_TYPES, XML_TYPES } = require('./format');

const PATH = /^\/Binary(?:\/([^/?]+))?\/?$/;
const NDJSON = new Set(['application/x-ndjson', 'application/fhir+ndjson', 'application/ndjson']);

function baseOf(contentType) {
  return String(contentType || '').split(';')[0].trim().toLowerCase();
}

/**
 * Whether a content type is a FHIR format, as the Pascal server took it: 'json', 'xml', or null
 * (content)
 * @param {string} contentType
 */
function fhirFormatOf(contentType) {
  const base = baseOf(contentType);
  if (!base || NDJSON.has(base)) {
    return null;
  }
  if (JSON_TYPES.has(base) || base.includes('json')) {
    return 'json';
  }
  if (XML_TYPES.has(base) || base.includes('xml')) {
    return 'xml';
  }
  return null;
}

/** The Binary path a request is to: { id } (null for the type), or null for anything else */
function binaryPath(req) {
  const m = PATH.exec(req.path);
  return m ? { id: m[1] ? decodeURIComponent(m[1]) : null } : null;
}

/**
 * A POST or PUT of a Binary's content: the Binary resource to write, or null when the request
 * is something else (its body is then read as any other is)
 * @param {Object} req
 * @returns {Object|null}
 */
function upload(req) {
  if (req.method !== 'POST' && req.method !== 'PUT') {
    return null;
  }
  const at = binaryPath(req);
  if (!at || (req.method === 'POST' && at.id) || (req.method === 'PUT' && !at.id) || at.id === '_search') {
    return null;
  }
  const ct = req.get('Content-Type');
  if (fhirFormatOf(ct) || baseOf(ct) === 'application/x-www-form-urlencoded') {
    return null;
  }
  if (!ct || !baseOf(ct)) {
    throw badRequest('A Binary\'s content needs a Content-Type (or send a Binary resource, as application/fhir+json or application/fhir+xml)');
  }
  const bytes = Buffer.isBuffer(req.body) ? req.body : typeof req.body === 'string' ? Buffer.from(req.body, 'utf8') : Buffer.alloc(0);
  const bin = { resourceType: 'Binary' };
  if (at.id) {
    bin.id = at.id;
  }
  bin.contentType = String(ct).trim();
  const sc = req.get('X-Security-Context');
  if (sc && String(sc).trim()) {
    bin.securityContext = { reference: String(sc).trim() };
  }
  if (bytes.length) {
    bin.data = bytes.toString('base64');
  }
  return bin;
}

/** The request asks for a FHIR format: _format, or an Accept that names one first */
function asksForFhir(req) {
  const f = typeof req.query._format === 'string' ? req.query._format.trim() : '';
  if (f) {
    return !/html/i.test(f);
  }
  const accept = String(req.get('Accept') || '');
  const first = accept.split(',').map(p => p.split(';')[0].trim().toLowerCase()).find(t => t);
  return !!first && (JSON_TYPES.has(first) || XML_TYPES.has(first));
}

/**
 * Whether a read of this Binary gives its content (not the resource)
 * @param {Object} req
 * @param {Object} binary
 */
function sendsContent(req, binary) {
  return !asksForFhir(req) || fhirFormatOf(binary.contentType) !== null;
}

/**
 * Write a Binary's content as the response (its headers, ETag and the like, already set)
 * @param {Object} req
 * @param {Object} res
 * @param {Object} binary
 */
function send(req, res, binary) {
  const bytes = typeof binary.data === 'string' ? Buffer.from(binary.data, 'base64') : Buffer.alloc(0);
  // (as it was given: res.set would add a charset to some types)
  res.setHeader('Content-Type', binary.contentType || 'application/octet-stream');
  // (so a browser shows it as what it says it is, not what it guesses; and content anyone could
  // upload, HTML or SVG with a script, runs in a sandbox, not as this server's page with the
  // reader's login)
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', 'sandbox');
  if (req.query.download === 'true') {
    res.set('Content-Disposition', 'attachment');
  }
  if (req.method === 'HEAD') {
    res.set('Content-Length', String(bytes.length));
    res.end();
    return;
  }
  res.send(bytes);
}

module.exports = { fhirFormatOf, binaryPath, upload, asksForFhir, sendsContent, send };
