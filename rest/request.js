//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * A FHIR request: an HTTP request, or an entry of a batch or transaction Bundle, turned into
 * one shape, and the interaction it asks for.
 *
 *   { method, segments, params: [[name, value]...], headers (lower-case names), body,
 *     interaction, type, id, vid, compartment, operation, principal, ip, base }
 *
 * The query is parsed here, not by express (whose parser makes objects of a[b]=c): search
 * needs the parameters in order, with repeats.
 *
 * @module rest/request
 */

const { badRequest, notAllowed } = require('./library/errors');

const TYPE_RE = /^[A-Z][A-Za-z]{0,63}$/;

/**
 * Split a relative URL (path and query) into segments and parameters.
 * @param {string} url - e.g. "Patient/123/_history?_count=10"
 */
function splitUrl(url) {
  const q = url.indexOf('?');
  const pathPart = q >= 0 ? url.substring(0, q) : url;
  const query = q >= 0 ? url.substring(q + 1) : '';
  const segments = pathPart.split('/').filter(s => s !== '').map(s => {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      throw badRequest(`The URL segment '${s}' is not properly encoded`);
    }
  });
  return { segments, params: parseQuery(query) };
}

/**
 * Parse a query string into [name, value] pairs, in order.
 * @param {string} query
 */
function parseQuery(query) {
  const out = [];
  if (!query) {
    return out;
  }
  for (const part of query.split('&')) {
    if (!part) {
      continue;
    }
    const eq = part.indexOf('=');
    const rawName = eq >= 0 ? part.substring(0, eq) : part;
    const rawValue = eq >= 0 ? part.substring(eq + 1) : '';
    try {
      out.push([decodeURIComponent(rawName.replace(/\+/g, ' ')), decodeURIComponent(rawValue.replace(/\+/g, ' '))]);
    } catch (e) {
      throw badRequest(`The query parameter '${rawName}' is not properly encoded`);
    }
  }
  return out;
}

/** The first value of a parameter, or undefined */
function param(freq, name) {
  const p = freq.params.find(([n]) => n === name);
  return p ? p[1] : undefined;
}

/**
 * Work out the interaction from the method and the segments.
 * @param {Object} freq - with method, segments, params
 */
function classify(freq) {
  const s = freq.segments;
  const m = freq.method;
  const out = { interaction: null, type: null, id: null, vid: null, compartment: null, operation: null };
  const isOp = (x) => typeof x === 'string' && x.startsWith('$');
  const checkType = (t) => {
    if (!TYPE_RE.test(t)) {
      throw badRequest(`'${t}' is not a resource type`);
    }
    return t;
  };
  if (s.length === 0) {
    if (m === 'POST') {
      out.interaction = 'bundle';
    } else if (m === 'GET' || m === 'HEAD') {
      out.interaction = 'search-system';
    }
  } else if (s.length === 1) {
    if (s[0] === 'metadata' && (m === 'GET' || m === 'HEAD')) {
      out.interaction = 'capabilities';
    } else if (s[0] === '_history' && (m === 'GET' || m === 'HEAD')) {
      out.interaction = 'history-system';
    } else if (s[0] === '_search' && m === 'POST') {
      out.interaction = 'search-system';
    } else if (isOp(s[0])) {
      out.interaction = 'operation';
      out.operation = s[0].substring(1);
    } else {
      out.type = checkType(s[0]);
      out.interaction = { GET: 'search-type', HEAD: 'search-type', POST: 'create', PUT: 'conditional-update', DELETE: 'conditional-delete',
        PATCH: 'conditional-patch' }[m] || null;
    }
  } else if (s.length === 2) {
    out.type = checkType(s[0]);
    if (s[1] === '_history' && (m === 'GET' || m === 'HEAD')) {
      out.interaction = 'history-type';
    } else if (s[1] === '_search' && m === 'POST') {
      out.interaction = 'search-type';
    } else if (isOp(s[1])) {
      out.interaction = 'operation';
      out.operation = s[1].substring(1);
    } else {
      out.id = s[1];
      out.interaction = { GET: 'read', HEAD: 'read', PUT: 'update', PATCH: 'patch', DELETE: 'delete' }[m] || null;
    }
  } else if (s.length === 3) {
    out.type = checkType(s[0]);
    out.id = s[1];
    if (s[2] === '_history' && (m === 'GET' || m === 'HEAD')) {
      out.interaction = 'history-instance';
    } else if (isOp(s[2])) {
      out.interaction = 'operation';
      out.operation = s[2].substring(1);
    } else if (m === 'GET' || m === 'HEAD') {
      // a compartment search: Patient/123/Observation (or Patient/123/* )
      out.compartment = { type: out.type, id: out.id };
      out.type = s[2] === '*' ? null : checkType(s[2]);
      out.id = null;
      out.interaction = out.type ? 'search-type' : 'search-system';
    }
  } else if (s.length === 4) {
    out.type = checkType(s[0]);
    out.id = s[1];
    if (s[2] === '_history' && (m === 'GET' || m === 'HEAD')) {
      out.vid = s[3];
      out.interaction = 'vread';
    } else if (m === 'POST' && s[3] === '_search') {
      out.compartment = { type: out.type, id: out.id };
      out.type = checkType(s[2]);
      out.id = null;
      out.interaction = 'search-type';
    }
  }
  if (!out.interaction) {
    throw notAllowed(`${m} ${s.join('/') || '/'} is not a FHIR interaction this server knows`);
  }
  return out;
}

/**
 * A FHIR request from an express request.
 * @param {Object} req
 * @param {Object|null} body - the parsed body
 * @param {Object|null} principal
 * @param {string} base - the endpoint's full URL
 */
function fromHttp(req, body, principal, base) {
  const url = req.originalUrl.substring(req.baseUrl.length) || '/';
  const { segments, params } = splitUrl(url);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  const freq = { method: req.method.toUpperCase(), segments, params, headers, body, principal, ip: req.ip, base, url };
  // a POST _search carries its parameters in the body, as a form
  if (req.method === 'POST' && segments[segments.length - 1] === '_search' && typeof req.body === 'string') {
    freq.params.push(...parseQuery(req.body));
    freq.body = null;
  } else if (req.method === 'POST' && segments[segments.length - 1] === '_search' && Buffer.isBuffer(req.body) &&
    /x-www-form-urlencoded/.test(headers['content-type'] || '')) {
    freq.params.push(...parseQuery(req.body.toString('utf8')));
    freq.body = null;
  }
  Object.assign(freq, classify(freq));
  return freq;
}

/**
 * A FHIR request from a Bundle entry.
 * @param {Object} entry
 * @param {Object} parent - the Bundle's request (principal, ip, base, headers)
 */
function fromEntry(entry, parent) {
  const r = entry.request || {};
  if (!r.method || !r.url) {
    throw badRequest('A Bundle entry needs request.method and request.url');
  }
  let url = String(r.url);
  if (url.startsWith(parent.base + '/')) {
    url = url.substring(parent.base.length + 1);
  }
  const { segments, params } = splitUrl(url);
  const headers = {};
  if (r.ifMatch) {
    headers['if-match'] = r.ifMatch;
  }
  if (r.ifNoneMatch) {
    headers['if-none-match'] = r.ifNoneMatch;
  }
  if (r.ifNoneExist) {
    headers['if-none-exist'] = r.ifNoneExist;
  }
  if (r.ifModifiedSince) {
    headers['if-modified-since'] = r.ifModifiedSince;
  }
  if (parent.headers.prefer) {
    headers.prefer = parent.headers.prefer;
  }
  const freq = { method: String(r.method).toUpperCase(), segments, params, headers, body: entry.resource || null,
    principal: parent.principal, ip: parent.ip, base: parent.base, url, inBundle: true };
  if (freq.method === 'PATCH' && entry.resource && entry.resource.resourceType === 'Binary' && entry.resource.data) {
    // a JSON Patch in a Bundle comes as a Binary
    try {
      freq.body = JSON.parse(Buffer.from(entry.resource.data, 'base64').toString('utf8'));
    } catch (e) {
      throw badRequest('The PATCH entry\'s Binary is not a JSON Patch');
    }
  }
  Object.assign(freq, classify(freq));
  return freq;
}

/** The Prefer header's return= value: minimal, representation, OperationOutcome, or null */
function preferReturn(freq) {
  const m = /return=([A-Za-z]+)/.exec(freq.headers.prefer || '');
  return m ? m[1] : null;
}

/** Prefer: handling=strict */
function strict(freq) {
  return /handling=strict/.test(freq.headers.prefer || '');
}

// an ETag is short: anything longer than this isn't one of ours
const MAX_ETAG = 200;

/**
 * The version an ETag names: W/"3", "3" or 3 all give '3'. Parsed by hand, not with a regular
 * expression: a header is the client's, and a pattern like \s*"?([^"]*)"?\s* backtracks badly
 * on a long run of spaces or tabs.
 * @param {string} text
 * @returns {string}
 */
function etagVersion(text) {
  let s = String(text).substring(0, MAX_ETAG).trim();
  if (s.startsWith('W/')) {
    s = s.substring(2);
  }
  if (s.startsWith('"')) {
    const close = s.indexOf('"', 1);
    s = close >= 0 ? s.substring(1, close) : s.substring(1);
  }
  return s;
}

/** The version in If-Match (W/"3" or "3" or 3), or null */
function ifMatchVersion(freq) {
  const v = freq.headers['if-match'];
  return v ? etagVersion(v) : null;
}

module.exports = { fromHttp, fromEntry, splitUrl, parseQuery, param, classify, preferReturn, strict, ifMatchVersion, etagVersion, TYPE_RE };
