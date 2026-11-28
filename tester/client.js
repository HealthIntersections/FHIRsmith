//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The HTTP client the tests use to talk to the server under test: JSON or XML, with the run's
 * bearer token, recording every exchange (the request and response, trimmed) so a test's
 * outcome can show what happened.
 *
 * Connections go through the SSRF guard (library/ssrf-guard.js): only public addresses,
 * unless allowPrivate (the module's allowPrivateAddresses, or the jest run against this
 * server's own endpoint). Every request has a time limit; the run's signal aborts them all
 * (cancelled, or out of time). Requests may only go to the server under test: a link it
 * returns to anywhere else is refused.
 *
 * @module tester/client
 */

const axios = require('axios');
const { createGuardedAgents } = require('../library/ssrf-guard');
const { toXml, fromXml } = require('../library/fhir-xml');

const REQUEST_TIMEOUT_MS = 30000;
// what is kept of a body, in an exchange
const KEEP_BYTES = 64 * 1024;
// the most a response body can be
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

const FHIR_JSON = 'application/fhir+json';
const FHIR_XML = 'application/fhir+xml';

class ClientError extends Error {}

/** The kind of FHIR body a content type names: 'json', 'xml', or null */
function formatOf(contentType) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (ct === FHIR_JSON || ct === 'application/json' || ct === 'application/json+fhir') {
    return 'json';
  }
  if (ct === FHIR_XML || ct === 'application/xml' || ct === 'text/xml' || ct === 'application/xml+fhir') {
    return 'xml';
  }
  return null;
}

function trim(text) {
  if (text == null) {
    return null;
  }
  const s = String(text);
  return s.length > KEEP_BYTES ? s.substring(0, KEEP_BYTES) + `\n... (${s.length - KEEP_BYTES} more characters)` : s;
}

class FhirClient {
  /**
   * @param {Object} options
   * @param {string} options.base - the server's base URL
   * @param {string} [options.token] - a bearer token
   * @param {boolean} [options.allowPrivate] - private addresses too
   * @param {function(string): Object} [options.xmlModel] - the XML model for a FHIR version
   *   (library/fhir-model.js): without it, XML can't be sent or read
   * @param {AbortSignal} [options.signal] - aborts every request
   * @param {number} [options.timeoutMs]
   */
  constructor(options) {
    this.base = String(options.base).replace(/\/+$/, '');
    this.origin = new URL(this.base).origin;
    this.token = options.token || null;
    this.signal = options.signal || null;
    this.timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
    this.xmlModel = null;
    this.xmlModelFor = options.xmlModel || null;
    const agents = createGuardedAgents({ allowPrivate: !!options.allowPrivate });
    this.http = axios.create({
      httpAgent: agents.httpAgent,
      httpsAgent: agents.httpsAgent,
      maxRedirects: 0,
      validateStatus: () => true,
      responseType: 'arraybuffer',
      transformResponse: [(d) => d],
      maxContentLength: MAX_RESPONSE_BYTES,
      // the server's own proxy settings aren't for this
      proxy: false
    });
    // the exchanges since the last take()
    this.exchanges = [];
    // other bases the server's links may use, for this base
    this.aliases = [];
    // what the requests are for, as they're recorded: 'setup' (making what a test needs) or 'test'
    this.phase = 'test';
  }

  /**
   * Another address of the server under test (its CapabilityStatement's implementation.url): a
   * link it gives there is taken to be to the base
   * @param {string} url
   */
  alias(url) {
    try {
      const u = new URL(url);
      const a = u.toString().replace(/\/+$/, '');
      if (a !== this.base && /^https?:$/.test(u.protocol)) {
        this.aliases.push(a);
      }
    } catch (e) {
      // not a URL: no alias
    }
  }

  /** Use the XML model for this FHIR version (once the CapabilityStatement says which) */
  async useVersion(fhirVersion) {
    if (this.xmlModelFor) {
      this.xmlModel = await this.xmlModelFor(fhirVersion);
    }
  }

  /** The exchanges since the last call, and forget them */
  take() {
    const list = this.exchanges;
    this.exchanges = [];
    return list;
  }

  /** A URL for a path (or a link the server gave, which must be on the server under test) */
  url(path) {
    if (/^https?:\/\//i.test(path)) {
      const alias = this.aliases.find(a => path === a || path.startsWith(a + '/') || path.startsWith(a + '?'));
      if (alias) {
        return this.base + path.substring(alias.length);
      }
      const u = new URL(path);
      if (u.origin !== this.origin) {
        throw new ClientError(`The server gave a link to another server (${u.origin}): not followed`);
      }
      return u.toString();
    }
    if (!path) {
      return this.base;
    }
    if (path.startsWith('?')) {
      return this.base + path;
    }
    return this.base + (path.startsWith('/') ? path : '/' + path);
  }

  /**
   * Make a request.
   * @param {string} method
   * @param {string} path - relative to the base ('Patient/1', 'Patient?name=x'), or a link the server gave
   * @param {Object} [options]
   * @param {Object|string|Buffer} [options.body] - a resource (sent in the format), or raw (with contentType)
   * @param {string} [options.format] - 'json' (default) or 'xml': what is sent, and asked for
   * @param {string} [options.contentType] - for a raw body
   * @param {string} [options.accept] - instead of the format's
   * @param {Object} [options.headers]
   * @returns {Promise<{status: number, headers: Object, text: string, data: Buffer, resource: Object|null,
   *   format: string|null, parseError: string|null, ms: number}>}
   */
  async request(method, path, options = {}) {
    const format = options.format || 'json';
    if (format === 'xml' && !this.xmlModel) {
      throw new ClientError('XML can\'t be used: there is no XML model for this FHIR version');
    }
    const url = this.url(path);
    const headers = { Accept: options.accept || (format === 'xml' ? FHIR_XML : FHIR_JSON), ...(options.headers || {}) };
    if (this.token && !Object.keys(headers).some(h => h.toLowerCase() === 'authorization')) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    let data;
    let shown = null;
    if (options.body !== undefined) {
      if (Buffer.isBuffer(options.body) || typeof options.body === 'string') {
        data = options.body;
        headers['Content-Type'] = options.contentType || (format === 'xml' ? FHIR_XML : FHIR_JSON);
      } else if (format === 'xml') {
        data = toXml(options.body, this.xmlModel, { pretty: true });
        headers['Content-Type'] = FHIR_XML;
      } else {
        data = JSON.stringify(options.body);
        headers['Content-Type'] = FHIR_JSON;
      }
      shown = Buffer.isBuffer(data) ? `(${data.length} bytes)` : data;
    }
    const start = Date.now();
    const exchange = {
      phase: this.phase,
      request: { method, url, headers: redact(headers), body: trim(shown) },
      response: null
    };
    this.exchanges.push(exchange);
    if (this.signal && this.signal.aborted) {
      throw new ClientError(this.signal.reason ? String(this.signal.reason.message || this.signal.reason) : 'Cancelled');
    }
    let res;
    try {
      res = await this.http.request({ method, url, headers, data, timeout: this.timeoutMs, signal: this.signal || undefined });
    } catch (e) {
      const why = e.code === 'ECONNABORTED' || /timeout/i.test(e.message) ? `no answer in ${this.timeoutMs / 1000} seconds`
        : this.signal && this.signal.aborted ? String((this.signal.reason && this.signal.reason.message) || 'cancelled')
          : e.message;
      exchange.response = { error: why };
      throw new ClientError(`${method} ${url}: ${why}`);
    }
    const ms = Date.now() - start;
    const buffer = Buffer.from(res.data || []);
    const contentType = res.headers['content-type'] || '';
    const bodyFormat = formatOf(contentType);
    const binary = !bodyFormat && !/^text\/|json|xml|html/i.test(contentType) && buffer.length > 0;
    const text = binary ? '' : buffer.toString('utf8');
    let resource = null;
    let parseError = null;
    if (bodyFormat && text.trim()) {
      try {
        resource = bodyFormat === 'json' ? JSON.parse(text) : this.parseXml(text);
      } catch (e) {
        parseError = e.message;
      }
    }
    exchange.response = { status: res.status, ms, headers: pick(res.headers), body: binary ? `(${buffer.length} bytes, ${contentType})` : trim(text) };
    return { status: res.status, headers: res.headers, text, data: buffer, resource, format: bodyFormat, parseError, ms };
  }

  parseXml(text) {
    if (!this.xmlModel) {
      throw new Error('there is no XML model to read it with');
    }
    return fromXml(text, this.xmlModel);
  }

  get(path, options) {
    return this.request('GET', path, options);
  }

  post(path, body, options = {}) {
    return this.request('POST', path, { ...options, body });
  }

  put(path, body, options = {}) {
    return this.request('PUT', path, { ...options, body });
  }

  patch(path, body, options = {}) {
    return this.request('PATCH', path, { ...options, body });
  }

  delete(path, options) {
    return this.request('DELETE', path, options);
  }
}

/** The headers worth showing (not the token) */
function redact(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = k.toLowerCase() === 'authorization' ? 'Bearer (the run\'s token)' : v;
  }
  return out;
}

const SHOWN_HEADERS = ['content-type', 'location', 'content-location', 'etag', 'last-modified', 'x-progress', 'retry-after', 'www-authenticate'];

function pick(headers) {
  const out = {};
  for (const h of SHOWN_HEADERS) {
    if (headers[h] !== undefined) {
      out[h] = headers[h];
    }
  }
  return out;
}

module.exports = { FhirClient, ClientError, formatOf, FHIR_JSON, FHIR_XML, REQUEST_TIMEOUT_MS, KEEP_BYTES };
