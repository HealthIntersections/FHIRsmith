//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The terminology server the /ips module uses: for links to code systems now, and for
 * the queries the analysis will make.
 *
 * It is named by modules.ips.txServer, which is either
 *
 *   - an http(s) URL: an external server, reached over the network; or
 *   - a path on this server, such as /tx/r4: the tx module's own endpoint. Requests to it
 *     never leave the process - they are dispatched straight into the Express app, so
 *     they go through the same middleware and routes an HTTP request would, without a
 *     socket.
 *
 * Either way, the client speaks FHIR over the server's REST interface, so the analysis
 * code doesn't care which it has.
 *
 * @module ips/tx-client
 */

const http = require('http');
const { Duplex } = require('stream');

const FHIR_JSON = 'application/fhir+json';

/**
 * Send a request into an Express app without a network: a real http.IncomingMessage and
 * http.ServerResponse, with no socket, so everything Express and its middleware rely on
 * (headers, the body stream, res.end) is there.
 *
 * @param {Function} app - the Express app
 * @param {{method: string, url: string, headers?: Object, body?: string}} req
 * @returns {Promise<{status: number, headers: Object, body: string}>}
 */
function dispatch(app, { method, url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(null);
    req.method = method;
    req.url = url;
    req.headers = Object.fromEntries(Object.entries({ host: 'localhost', ...headers }).map(([k, v]) => [k.toLowerCase(), String(v)]));
    // enough of a socket for Express, on-finished, the body parsers and the message's own
    // teardown to be happy: a stream that goes nowhere
    req.socket = new Duplex({ read() {}, write(chunk, encoding, cb) { cb(); } });
    req.socket.remoteAddress = '127.0.0.1';
    req.socket.encrypted = false;
    req.connection = req.socket;
    if (body !== undefined) {
      const buf = Buffer.from(body, 'utf8');
      req.headers['content-length'] = String(buf.length);
      // the body is the stream Express's body parsers read
      req.push(buf);
    }
    req.push(null);
    const res = new http.ServerResponse(req);
    const chunks = [];
    res.write = (chunk, encoding, cb) => {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8'));
      }
      if (typeof encoding === 'function') {
        encoding();
      } else if (cb) {
        cb();
      }
      return true;
    };
    res.end = (chunk, encoding, cb) => {
      if (typeof chunk === 'function') {
        cb = chunk;
        chunk = undefined;
      } else if (typeof encoding === 'function') {
        cb = encoding;
        encoding = undefined;
      }
      if (chunk) {
        res.write(chunk, encoding);
      }
      res.finished = true;
      res.writableEnded = true;
      if (cb) {
        cb();
      }
      resolve({ status: res.statusCode, headers: res.getHeaders(), body: Buffer.concat(chunks).toString('utf8') });
      return res;
    };
    try {
      app(req, res);
    } catch (e) {
      reject(e);
    }
  });
}

class TxClient {
  /**
   * @param {string} server - modules.ips.txServer: an http(s) URL, or a path on this server
   * @param {Object} [options]
   * @param {Function} [options.app] - the Express app, for a path on this server
   * @param {number} [options.timeoutMs] - how long to wait for an answer (default 30s)
   * @param {Object} [options.log] - a logger, for what callers shouldn't show
   */
  constructor(server, options = {}) {
    if (typeof server !== 'string' || server.trim() === '') {
      throw new Error('A terminology server is required: an http(s) URL, or a path on this server such as /tx/r4');
    }
    const s = server.trim().replace(/\/+$/, '');
    if (/^https?:\/\//i.test(s)) {
      this.internal = false;
      this.base = s;
    } else if (s.startsWith('/')) {
      if (typeof options.app !== 'function') {
        throw new Error(`The terminology server '${server}' is a path on this server, which needs the Express app to route to`);
      }
      this.internal = true;
      this.base = s;
      this.app = options.app;
    } else {
      throw new Error(`The terminology server must be an http(s) URL or a path on this server, not '${server}'`);
    }
    this.timeoutMs = options.timeoutMs || 30000;
    this.log = options.log || null;
  }

  /** Where the server is, for links and messages: a URL, or a path on this server. */
  get url() {
    return this.base;
  }

  /** The address of a code system on the server: its search page / search result. */
  codeSystemLink(system) {
    return `${this.base}/CodeSystem?url=${encodeURIComponent(system)}`;
  }

  /**
   * A FHIR request to the server.
   *
   * @param {string} method - GET or POST
   * @param {string} path - relative to the server, e.g. /CodeSystem/$validate-code
   * @param {Object} [options]
   * @param {Object} [options.query] - query parameters
   * @param {Object} [options.body] - a resource (POST)
   * @returns {Promise<{status: number, resource: Object|null, text: string}>} the parsed
   *   JSON when there is some
   */
  async request(method, path, options = {}) {
    const qs = options.query ? new URLSearchParams(Object.entries(options.query).filter(([, v]) => v !== undefined && v !== null)).toString() : '';
    const target = `${this.base}${path}${qs ? '?' + qs : ''}`;
    const headers = { Accept: FHIR_JSON };
    let body;
    if (options.body !== undefined) {
      headers['Content-Type'] = FHIR_JSON;
      body = JSON.stringify(options.body);
    }
    let status;
    let text;
    if (this.internal) {
      // a handler that never answers must not hang the caller (the pipeline runs one
      // document at a time, and would stop for good)
      let timer;
      const r = await Promise.race([
        dispatch(this.app, { method, url: target, headers, body }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`No answer from ${target} within ${this.timeoutMs}ms`)), this.timeoutMs);
        })
      ]).finally(() => clearTimeout(timer));
      status = r.status;
      text = r.body;
    } else {
      const r = await fetch(target, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
      status = r.status;
      text = await r.text();
    }
    let resource = null;
    if (text) {
      try {
        resource = JSON.parse(text);
      } catch {
        resource = null;
      }
    }
    return { status, resource, text };
  }

  get(path, query) {
    return this.request('GET', path, { query });
  }

  post(path, body) {
    return this.request('POST', path, { body });
  }
}

module.exports = { TxClient, dispatch };
