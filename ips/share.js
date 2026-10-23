//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Sharing an IPS document as a QR code: a SMART Health Link (SHL), or a Verifiable Health
 * Link (VHL) signed as the GDHCN does it. The same steps the healthintersections.com.au
 * passport page takes in the browser, here on the server, against an SHL server - this
 * server's own shl module (an internal path, dispatched in-process) or another FHIRsmith's:
 *
 *   1. POST {shl}/create  { password, days, vhl }       -> { uuid, pword, link }
 *   2. encrypt the document as a JWE (dir / A256GCM, a random 256-bit key)
 *   3. POST {shl}/upload  { uuid, pword, files: [{ cnt: base64(jwe), type }] }
 *   4. the shlink payload { url: link, flag: 'U', key, label }, base64url
 *      SHL: {viewer}#shlink:/{payload} - the QR carries that
 *      VHL: POST {shl}/sign { url: 'shlink://{payload}' } -> { signature } (a COSE_Sign1 of
 *           the GDHCN payload, deflated and base45) - the QR carries 'HC1:' + signature
 *   5. the QR code, as SVG
 *
 * @module ips/share
 */

const crypto = require('crypto');
const jose = require('jose');
const qrcode = require('qrcode-generator');
const { dispatch } = require('./tx-client');

const DEFAULT_VIEWER = 'https://viewer.tcpdev.org/#';
const DEFAULT_DAYS = 100;
const DEFAULT_TIMEOUT_MS = 30000;
const FHIR_JSON = 'application/fhir+json';
// the most a document can be, as its JWE, before it isn't shared this way
const MAX_SHARE_BYTES = 2 * 1024 * 1024;

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * A client for an SHL server: `server` an http(s) URL of the module (https://host/shl), or
 * a path on this server (/shl) dispatched in-process.
 */
class ShlClient {
  /**
   * @param {{server: string, password: string, days?: number, viewer?: string, timeoutMs?: number}} config
   * @param {{app?: Object, log?: Object}} [options]
   */
  constructor(config, options = {}) {
    if (!config || typeof config.server !== 'string' || !config.server.trim()) {
      throw new Error('modules.ips.shl.server is required (a URL, or a path on this server)');
    }
    if (typeof config.password !== 'string' || !config.password) {
      throw new Error('modules.ips.shl.password is required (the shl module\'s password)');
    }
    this.base = config.server.trim().replace(/\/+$/, '');
    this.internal = this.base.startsWith('/');
    if (!this.internal && !/^https?:\/\//.test(this.base)) {
      throw new Error('modules.ips.shl.server must be an http(s) URL or a path on this server');
    }
    if (this.internal && !options.app) {
      throw new Error('An SHL server on this server needs the app to dispatch to');
    }
    this.app = options.app || null;
    this.log = options.log || null;
    this.password = config.password;
    this.days = Number.isInteger(config.days) && config.days > 0 ? config.days : DEFAULT_DAYS;
    this.viewer = typeof config.viewer === 'string' && config.viewer ? config.viewer : DEFAULT_VIEWER;
    this.timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  /** Where the server is, for messages. */
  get url() {
    return this.base;
  }

  /**
   * A JSON POST to the SHL server. The Host header goes along for an internal call, so
   * the links the server makes name this server as the browser sees it.
   */
  async post(path, body, host) {
    const target = `${this.base}${path}`;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    let status;
    let text;
    if (this.internal) {
      if (host) {
        headers.Host = host;
      }
      let timer;
      const r = await Promise.race([
        dispatch(this.app, { method: 'POST', url: target, headers, body: JSON.stringify(body) }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`No answer from ${target} within ${this.timeoutMs}ms`)), this.timeoutMs);
        })
      ]).finally(() => clearTimeout(timer));
      status = r.status;
      text = r.body;
    } else {
      const r = await fetch(target, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
      status = r.status;
      text = await r.text();
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (status < 200 || status >= 300) {
      // the server's own message is for the log: the page gets the step that failed
      if (this.log) {
        this.log.error(`IPS module: the SHL server answered ${status} to ${path}: ${(json && json.error) || (text || '').substring(0, 200)}`);
      }
      throw new Error(`The SHL server answered HTTP ${status} to ${path}`);
    }
    if (!json || typeof json !== 'object') {
      throw new Error(`The SHL server did not answer ${path} with JSON`);
    }
    return json;
  }

  /**
   * Share a document.
   *
   * @param {Object} bundle - the document
   * @param {{kind: 'shl'|'vhl', host?: string, label?: string, days?: number}} options
   * @returns {Promise<{kind: string, link: string, qr: string, text: string, expires: string, bytes: number}>}
   *   link: the SHL server's link to the manifest; qr: the QR code as SVG; text: what the QR
   *   carries (the viewer link with the shlink, or HC1:...)
   */
  async share(bundle, options) {
    const kind = options.kind === 'vhl' ? 'vhl' : 'shl';
    const days = Number.isInteger(options.days) && options.days > 0 ? options.days : this.days;
    const json = JSON.stringify(bundle);
    const keyBytes = crypto.randomBytes(32);
    const jwe = await new jose.CompactEncrypt(new TextEncoder().encode(json))
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM', cty: FHIR_JSON })
      .encrypt(new Uint8Array(keyBytes));
    if (jwe.length > MAX_SHARE_BYTES) {
      throw new Error(`The document is too big to share this way (${jwe.length} bytes encrypted; the limit is ${MAX_SHARE_BYTES})`);
    }
    const created = await this.post('/create', { password: this.password, days, vhl: kind === 'vhl' }, options.host);
    if (typeof created.uuid !== 'string' || typeof created.pword !== 'string' || typeof created.link !== 'string') {
      throw new Error('The SHL server did not give a uuid, password and link');
    }
    await this.post('/upload', { uuid: created.uuid, pword: created.pword, files: [{ cnt: Buffer.from(jwe, 'utf8').toString('base64'), type: FHIR_JSON }] }, options.host);
    const payload = { url: created.link, flag: 'U', key: b64url(keyBytes), label: options.label || 'Patient Health Document' };
    const encoded = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
    let text;
    if (kind === 'vhl') {
      // 'shlink://' (two slashes) is what the GDHCN validator expects
      const signed = await this.post('/sign', { url: `shlink://${encoded}` }, options.host);
      if (typeof signed.signature !== 'string' || !signed.signature) {
        throw new Error('The SHL server did not sign the link');
      }
      text = `HC1:${signed.signature}`;
    } else {
      text = `${this.viewer}shlink:/${encoded}`;
    }
    const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    return { kind, link: created.link, qr: qrSvg(text), text, expires, bytes: jwe.length };
  }
}

/** A QR code (error correction L, as the passport page makes them) as an SVG. */
function qrSvg(text) {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
}

module.exports = { ShlClient, qrSvg, DEFAULT_VIEWER, DEFAULT_DAYS, MAX_SHARE_BYTES };
