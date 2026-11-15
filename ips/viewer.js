//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The SHL viewer: this server as the viewer a SMART Health Link (or a Verifiable Health Link)
 * opens. The link (the part after the viewer's '#', which the browser never sends) comes to
 * the server, which retrieves the document and records every step it takes - the request and
 * the response, headers and body, the key, the decrypted content - so that someone whose SHL
 * server doesn't work can see why. This is a public test service: nothing is hidden.
 *
 *   SHL  {viewer}#shlink:/{base64url JSON payload: url, key, exp, flag, label, v}
 *        flag U: GET {url}?recipient=... gives the one file (a JWE)
 *        else:   POST {url} { recipient, passcode? } gives the manifest: { files: [{ contentType,
 *                embedded | location }] } - or, from a VHL server, a FHIR Bundle of
 *                DocumentReferences whose attachments give the location
 *   VHL  HC1:{base45 of the deflated COSE_Sign1 of the CWT claims: 1 issuer, 4 exp, 6 iat,
 *        -260: { 5: ['shlink://...'] }}; the signature is checked against the certificates
 *        the viewer trusts (by kid)
 *
 * Each file is a JWE (dir / A256GCM, maybe zip DEF) decrypted with the payload's key. Only
 * FHIR JSON is supported; an IPS document (a document Bundle whose Composition.type is LOINC
 * 60591-5) can be added to a project.
 *
 * @module ips/viewer
 */

const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');
const axios = require('axios');
const CBOR = require('cbor');
const pako = require('pako');
const base45 = require('base45');
const { createGuardedAgents } = require('../library/ssrf-guard');
const { requestDeadline, describeRequestFailure } = require('../library/http-limits');

const LOINC = 'http://loinc.org';
const IPS_CODE = '60591-5';
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_MB = 10;
const MAX_REDIRECTS = 5;
// the most of one thing (a body, a document) the log keeps
const MAX_DETAIL = 1024 * 1024;
const BASE45 = /^[0-9A-Z $%*+\-./:]*$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const FLAGS = 'LPU';
const FHIR_JSON = 'application/fhir+json';

/** Stops the retrieval: what went wrong is already in the log. */
class Stop extends Error {}

/**
 * What the viewer did, step by step: { ms (since the start), level (info | ok | warning |
 * error), text, detail? (headers, a body, a payload - as text) }.
 */
class Trace {
  constructor(entries = [], started = Date.now()) {
    this.started = started;
    this.entries = entries;
  }

  add(level, text, detail) {
    const e = { ms: Date.now() - this.started, level, text };
    if (detail !== undefined && detail !== null && detail !== '') {
      const s = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
      e.detail = s.length > MAX_DETAIL ? `${s.substring(0, MAX_DETAIL)}\n... (${s.length} characters in all; the rest is not kept)` : s;
    }
    this.entries.push(e);
    return e;
  }

  info(text, detail) {
    return this.add('info', text, detail);
  }

  ok(text, detail) {
    return this.add('ok', text, detail);
  }

  warning(text, detail) {
    return this.add('warning', text, detail);
  }

  /** Logs the error and stops. */
  fail(text, detail) {
    this.add('error', text, detail);
    throw new Stop(text);
  }
}

/**
 * What a piece of text is: an SHL (anything with shlink:/ in it - a viewer URL, or the shlink
 * itself) or a VHL (HC1:...). null for anything else.
 */
function linkOf(text) {
  const t = String(text || '').trim();
  if (/^HC1:/i.test(t)) {
    return { kind: 'vhl', text: t };
  }
  const i = t.indexOf('shlink:/');
  if (i >= 0) {
    return { kind: 'shl', viewer: i > 0 ? t.substring(0, i) : null, payload: t.substring(i + 'shlink:/'.length).replace(/^\/+/, '') };
  }
  return null;
}

/** A CBOR map's entry, whether its keys are integers (as they should be) or text. */
function claim(m, k) {
  if (m instanceof Map) {
    return m.has(k) ? m.get(k) : m.get(String(k));
  }
  return m && typeof m === 'object' ? m[String(k)] : undefined;
}

/** CBOR, as JSON for the log: maps as objects, byte strings as hex. */
function cborJson(v) {
  if (v instanceof Map) {
    const o = {};
    for (const [k, x] of v) {
      o[String(k)] = cborJson(x);
    }
    return o;
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    return `h'${Buffer.from(v).toString('hex')}'`;
  }
  if (Array.isArray(v)) {
    return v.map(cborJson);
  }
  if (v instanceof CBOR.Tagged) {
    return { tag: v.tag, value: cborJson(v.value) };
  }
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cborJson(x)]));
  }
  return v;
}

/** A kid, as text: the text it is if it is printable, else base64. */
function kidText(kid) {
  if (typeof kid === 'string') {
    return kid;
  }
  if (Buffer.isBuffer(kid) || kid instanceof Uint8Array) {
    const b = Buffer.from(kid);
    const s = b.toString('utf8');
    return /^[\x20-\x7e]+$/.test(s) ? s : b.toString('base64');
  }
  return null;
}

/** When a NumericDate (seconds) is, for people. */
function when(seconds) {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : String(seconds);
}

/**
 * The certificates the viewer checks VHL signatures with: [{ kid, name?, certificate (PEM) |
 * certFile }]. A bad entry is reported and left out.
 */
function loadTrust(list, log) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    try {
      if (!t || typeof t.kid !== 'string' || !t.kid) {
        throw new Error('it has no kid');
      }
      const pem = typeof t.certificate === 'string' && t.certificate ? t.certificate : fs.readFileSync(t.certFile, 'utf8');
      out.push({ kid: t.kid, name: t.name || t.kid, key: crypto.createPublicKey(pem) });
    } catch (e) {
      if (log) {
        log.error(`IPS module: modules.ips.viewer.trust: a certificate could not be loaded (${t?.kid || '?'}): ${e.message}`);
      }
    }
  }
  return out;
}

/**
 * The SHL payload: decoded, checked, and logged (key and all).
 * @returns {Object} the payload
 */
function decodePayload(encoded, trace, options = {}) {
  if (!encoded) {
    trace.fail('There is nothing after shlink:/');
  }
  if (!BASE64URL.test(encoded)) {
    trace.fail('The payload is not base64url: it has characters other than A-Z, a-z, 0-9, - and _', encoded);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch (e) {
    trace.fail(`The payload is not JSON once base64url decoded: ${e.message}`, Buffer.from(encoded, 'base64url').toString('utf8'));
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    trace.fail('The payload is not a JSON object', payload);
  }
  trace.ok('Decoded the payload', payload);
  if (typeof payload.url !== 'string' || !payload.url) {
    trace.fail('The payload has no url');
  }
  let url;
  try {
    url = new URL(payload.url);
  } catch {
    trace.fail(`The payload's url is not a URL: ${payload.url}`);
  }
  if (url.protocol !== 'https:') {
    if (url.protocol === 'http:' && options.allowHttp) {
      trace.warning(`The url is http, not https as the SHL specification requires (allowed here: this server lets the viewer reach private addresses)`);
    } else {
      trace.fail(`The url must be https: ${payload.url}`);
    }
  }
  if (typeof payload.key !== 'string' || !BASE64URL.test(payload.key) || Buffer.from(payload.key, 'base64url').length !== 32) {
    trace.fail(`The key must be 32 bytes, base64url encoded (43 characters): it is ${typeof payload.key === 'string' ? `${payload.key.length} characters` : 'missing'}`);
  }
  trace.info(`The key: ${payload.key}`);
  if (payload.exp !== undefined) {
    if (typeof payload.exp !== 'number') {
      trace.warning(`exp should be a number (seconds since 1970): it is ${JSON.stringify(payload.exp)}`);
    } else if (payload.exp * 1000 < Date.now()) {
      trace.warning(`The link expired at ${when(payload.exp)} (going on anyway: the server decides)`);
    } else {
      trace.info(`The link expires at ${when(payload.exp)}`);
    }
  }
  const flag = payload.flag === undefined ? '' : payload.flag;
  if (typeof flag !== 'string') {
    trace.warning(`flag should be a string: it is ${JSON.stringify(flag)}`);
  } else {
    const odd = [...flag].filter(c => !FLAGS.includes(c));
    if (odd.length) {
      trace.warning(`Unknown flag${odd.length === 1 ? '' : 's'}: ${odd.join('')} (the flags are L, P and U)`);
    }
    const words = [flag.includes('L') ? 'L (long term)' : null, flag.includes('P') ? 'P (needs a passcode)' : null, flag.includes('U') ? 'U (the file is fetched directly)' : null].filter(Boolean);
    trace.info(words.length ? `Flags: ${words.join(', ')}` : 'No flags: the manifest is fetched with a POST');
    if (flag.includes('U') && flag.includes('P')) {
      trace.warning('U and P cannot be used together (the SHL specification says so): taking it as a P link');
    }
  }
  if (payload.label !== undefined) {
    if (typeof payload.label !== 'string') {
      trace.warning('label should be a string');
    } else if (payload.label.length > 80) {
      trace.warning(`label should be at most 80 characters: it is ${payload.label.length}`);
    }
  }
  if (payload.v !== undefined && payload.v !== 1) {
    trace.warning(`v (the version) is ${JSON.stringify(payload.v)}: this viewer knows version 1`);
  }
  return payload;
}

/**
 * A VHL: base45, inflate, COSE_Sign1, the CWT claims; the signature checked against the
 * trusted certificates. Logs each step.
 * @returns {{shlink: string, issuer: *, kid: string|null, verified: boolean|null, verifiedBy: string|null}}
 */
function decodeVhl(text, trust, trace) {
  const body = text.replace(/^HC1:/i, '');
  trace.info(`A VHL: HC1: and ${body.length} characters of base45`);
  if (!BASE45.test(body)) {
    const bad = [...new Set([...body].filter(c => !BASE45.test(c)))].join('');
    trace.fail(`The text after HC1: is not base45: it has ${JSON.stringify(bad)}`);
  }
  const deflated = base45.decode(body);
  let cose;
  try {
    cose = Buffer.from(pako.inflate(deflated));
    trace.ok(`Base45 decoded (${deflated.length} bytes) and inflated (${cose.length} bytes)`);
  } catch (e) {
    trace.warning(`Base45 decoded (${deflated.length} bytes), but it does not inflate (${e.message || e}): trying it as it is`);
    cose = Buffer.from(deflated);
  }
  let decoded;
  try {
    decoded = CBOR.decodeFirstSync(cose);
  } catch (e) {
    trace.fail(`It is not CBOR: ${e.message}`, cose.toString('hex'));
  }
  let parts = decoded;
  if (decoded instanceof CBOR.Tagged) {
    if (decoded.tag !== 18) {
      trace.warning(`The CBOR tag is ${decoded.tag}, not 18 (COSE_Sign1)`);
    }
    parts = decoded.value;
  } else {
    trace.warning('The COSE_Sign1 is not tagged (18)');
  }
  if (!Array.isArray(parts) || parts.length !== 4) {
    trace.fail('It is not a COSE_Sign1 (an array of 4: protected, unprotected, payload, signature)', cborJson(decoded));
  }
  const [prot, unprot, payloadBytes, signature] = parts;
  let headers;
  try {
    headers = Buffer.isBuffer(prot) && prot.length ? CBOR.decodeFirstSync(prot) : new Map();
  } catch (e) {
    trace.fail(`The protected header is not CBOR: ${e.message}`);
  }
  const alg = claim(headers, 1);
  const kid = kidText(claim(headers, 4) ?? claim(unprot, 4));
  trace.info(`COSE_Sign1: alg ${alg} (${alg === -7 ? 'ES256' : alg === -37 ? 'PS256' : 'unknown'}), kid ${kid || '(none)'}`, { protected: cborJson(headers), unprotected: cborJson(unprot) });
  let claims;
  try {
    claims = CBOR.decodeFirstSync(payloadBytes);
  } catch (e) {
    trace.fail(`The payload is not CBOR: ${e.message}`);
  }
  if (!(claims instanceof Map) && claims && typeof claims === 'object' && Object.keys(claims).some(k => /^-?\d+$/.test(k))) {
    trace.warning('The claims have text keys ("1", "-260") where CWT and the GDHCN use integers (1, -260)');
  }
  const issuer = claim(claims, 1);
  const exp = claim(claims, 4);
  const iat = claim(claims, 6);
  trace.ok(`The claims: issuer ${issuer ?? '(none)'}` + (iat !== undefined ? `, issued ${when(iat)}` : '') + (exp !== undefined ? `, expires ${when(exp)}` : ''), cborJson(claims));
  if (typeof exp === 'number' && exp * 1000 < Date.now()) {
    trace.warning(`The VHL expired at ${when(exp)}`);
  }
  const hcert = claim(claims, -260);
  const links = claim(hcert, 5);
  const shlink = Array.isArray(links) ? links.find(x => typeof x === 'string') : (typeof links === 'string' ? links : null);
  if (!shlink) {
    trace.fail('The claims have no link (-260 / 5)');
  }
  trace.info(`The link it carries: ${shlink}`);

  // the signature
  let verified = null;
  let verifiedBy = null;
  const known = kid ? trust.find(t => t.kid === kid) : null;
  if (alg !== -7) {
    trace.warning(`The signature cannot be checked: only ES256 (-7) is supported here`);
  } else if (!known) {
    trace.warning(kid
      ? `The signature cannot be checked: the viewer has no certificate for kid ${kid}. A VHL is checked with its issuer's public certificate - published through the GDHCN trust network - which this server must be configured to trust (modules.ips.viewer.trust)`
      : 'The signature cannot be checked: there is no kid');
  } else {
    const toBeSigned = CBOR.encode(['Signature1', prot, Buffer.alloc(0), payloadBytes]);
    try {
      verified = crypto.verify('sha256', toBeSigned, { key: known.key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature));
    } catch (e) {
      verified = false;
      trace.warning(`The signature could not be checked: ${e.message}`);
    }
    verifiedBy = known.name;
    if (verified) {
      trace.ok(`The signature is good: signed by ${known.name} (kid ${kid})`);
    } else {
      trace.add('error', `The signature is NOT good for ${known.name}'s certificate (kid ${kid}): the VHL may have been changed (going on anyway, to see what it holds)`);
    }
  }
  return { shlink, issuer: issuer === undefined ? null : issuer, kid, verified, verifiedBy };
}

/**
 * Decrypt a JWE (compact; dir / A256GCM; zip DEF allowed) with the key.
 * @returns {{text: string, header: Object}}
 */
function decryptJwe(jwe, key, trace) {
  const s = typeof jwe === 'string' ? jwe.trim() : '';
  const parts = s.split('.');
  if (parts.length !== 5) {
    trace.fail(`It is not a compact JWE (five parts separated by dots): it has ${parts.length} part${parts.length === 1 ? '' : 's'}`, s.substring(0, 2000));
  }
  let header;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch (e) {
    trace.fail(`The JWE's protected header is not base64url JSON: ${e.message}`);
  }
  trace.info(`JWE header: alg ${header.alg}, enc ${header.enc}` + (header.cty ? `, cty ${header.cty}` : '') + (header.zip ? `, zip ${header.zip}` : ''), header);
  if (header.alg !== 'dir') {
    trace.fail(`alg must be dir: it is ${header.alg}`);
  }
  if (header.enc !== 'A256GCM') {
    trace.fail(`enc must be A256GCM: it is ${header.enc}`);
  }
  if (parts[1] !== '') {
    trace.warning('The encrypted key part should be empty for alg dir');
  }
  const iv = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[4], 'base64url');
  if (iv.length !== 12) {
    trace.warning(`The IV should be 12 bytes: it is ${iv.length}`);
  }
  if (tag.length !== 16) {
    trace.fail(`The authentication tag should be 16 bytes: it is ${tag.length}`);
  }
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), iv);
    decipher.setAAD(Buffer.from(parts[0], 'ascii'));
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]);
  } catch {
    trace.fail('Decryption failed: the key is wrong, or the content was changed (the authentication tag does not match)');
  }
  if (header.zip === 'DEF') {
    try {
      plain = zlib.inflateRawSync(plain);
    } catch (e) {
      trace.fail(`Decrypted, but zip DEF does not inflate: ${e.message}`);
    }
  } else if (header.zip !== undefined) {
    trace.fail(`zip ${header.zip} is not supported (only DEF)`);
  }
  trace.ok(`Decrypted: ${plain.length} bytes`);
  return { text: plain.toString('utf8'), header };
}

/**
 * What a decrypted resource is: an IPS document (it can be added to a project), another
 * document (it can be looked at), or something this viewer doesn't show.
 * @returns {{bundle: Object, ips: boolean, document: boolean}|null}
 */
function examine(resource, trace) {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    trace.add('error', 'The content is not a JSON object');
    return null;
  }
  if (resource.resourceType !== 'Bundle') {
    trace.warning(`It is a ${resource.resourceType || 'JSON object with no resourceType'}, not a Bundle: only IPS documents are supported here`);
    return null;
  }
  if (resource.type !== 'document') {
    trace.warning(`It is a Bundle of type ${resource.type || '(none)'}, not a document: only IPS documents are supported here`);
    return null;
  }
  const comp = Array.isArray(resource.entry) ? resource.entry[0]?.resource : null;
  if (!comp || comp.resourceType !== 'Composition') {
    trace.warning('It is a document Bundle, but its first entry is not a Composition');
    return { bundle: resource, ips: false, document: false };
  }
  const codings = Array.isArray(comp.type?.coding) ? comp.type.coding : [];
  if (codings.some(c => c && c.system === LOINC && c.code === IPS_CODE)) {
    trace.ok(`It is an IPS document: Composition.type is LOINC ${IPS_CODE} (${resource.entry.length} entries)`);
    return { bundle: resource, ips: true, document: true };
  }
  const what = codings.map(c => `${c?.system}|${c?.code}`).join(', ') || comp.type?.text || '(none)';
  trace.warning(`It is a document, but not an IPS: Composition.type is ${what}, not LOINC ${IPS_CODE}. It can be looked at, but not added to a project`);
  return { bundle: resource, ips: false, document: true };
}

/** The headers of a response, as text for the log. */
function headerText(headers) {
  return Object.entries(headers || {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n');
}

class ShlViewer {
  /**
   * @param {Object} config - modules.ips.viewer: allowPrivateAddresses, timeout (seconds),
   *   maxMB, trust ([{kid, name, certificate | certFile}])
   * @param {{log?: Object}} [options]
   */
  constructor(config = {}, options = {}) {
    this.config = config || {};
    this.log = options.log || null;
    this.allowPrivate = this.config.allowPrivateAddresses === true;
    this.timeoutMs = (typeof this.config.timeout === 'number' && this.config.timeout > 0 ? this.config.timeout : DEFAULT_TIMEOUT_SECONDS) * 1000;
    this.maxBytes = Math.round((typeof this.config.maxMB === 'number' && this.config.maxMB > 0 ? this.config.maxMB : DEFAULT_MAX_MB) * 1024 * 1024);
    this.trust = loadTrust(this.config.trust, this.log);
    this.agents = createGuardedAgents({ allowPrivate: this.allowPrivate });
    this.corsNoted = false;
  }

  /**
   * One request, logged in full: what was sent, what came back (status, headers, body).
   * Redirects are followed here, so each is logged.
   */
  async request(method, url, { body, headers = {} } = {}, trace, what) {
    let target = url;
    for (let hop = 0; ; hop++) {
      let u;
      try {
        u = new URL(target);
      } catch {
        trace.fail(`${what}: not a URL: ${target}`);
      }
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && this.allowPrivate)) {
        trace.fail(`${what}: ${target} is not https`);
      }
      const sent = { ...headers };
      trace.info(`${what}: ${method} ${target}`, (headerText(sent) + (body !== undefined ? `\n\n${body}` : '')).trim());
      const deadline = requestDeadline(this.timeoutMs);
      const started = Date.now();
      let r;
      try {
        r = await axios.request({
          method, url: target, data: body, headers: sent,
          responseType: 'text', transformResponse: x => x, validateStatus: () => true, maxRedirects: 0,
          maxContentLength: this.maxBytes, signal: deadline.signal,
          httpAgent: this.agents.httpAgent, httpsAgent: this.agents.httpsAgent
        });
      } catch (e) {
        trace.fail(`${what}: ${describeRequestFailure(e, { timeoutMs: this.timeoutMs, maxBytes: this.maxBytes, deadline })}`);
      }
      const text = typeof r.data === 'string' ? r.data : (r.data === undefined || r.data === null ? '' : String(r.data));
      const level = r.status >= 200 && r.status < 300 ? 'ok' : (r.status >= 300 && r.status < 400 ? 'info' : 'error');
      trace.add(level, `${what}: HTTP ${r.status} in ${Date.now() - started} ms` + (r.headers['content-type'] ? `, ${r.headers['content-type']}` : '') + `, ${Buffer.byteLength(text, 'utf8')} bytes`,
        `${headerText(r.headers)}\n\n${text}`);
      if (!this.corsNoted && r.status < 300 && !r.headers['access-control-allow-origin']) {
        this.corsNoted = true;
        trace.warning(`${what}: there is no Access-Control-Allow-Origin header - a viewer that runs in the browser could not read this response (this one runs on the server, so it can)`);
      }
      if (r.status >= 300 && r.status < 400 && r.headers.location) {
        if (hop >= MAX_REDIRECTS) {
          trace.fail(`${what}: more than ${MAX_REDIRECTS} redirects`);
        }
        target = new URL(r.headers.location, target).toString();
        if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === 'POST')) {
          trace.warning(`${what}: a ${r.status} redirect turns the ${method} into a GET`);
          method = 'GET';
          body = undefined;
          delete headers['Content-Type'];
        }
        continue;
      }
      return { status: r.status, headers: r.headers, text };
    }
  }

  /**
   * Open a link: an SHL (with or without a viewer in front of it) or a VHL.
   *
   * @param {string} text - the link
   * @param {{passcode?: string, recipient: string, trace?: Trace}} options
   * @returns {Promise<Object>} { state: ok | needs-passcode | failed, message, payload, vhl,
   *   documents: [{ bundle, ips, document, contentType }], trace }
   */
  async open(text, options = {}) {
    const trace = options.trace || new Trace();
    this.corsNoted = false;
    const result = { state: 'failed', message: null, payload: null, vhl: null, documents: [], trace };
    try {
      const link = linkOf(text);
      if (!link) {
        trace.fail('This is not an SHL (with shlink:/ in it) or a VHL (starting HC1:)', String(text || '').substring(0, 2000));
      }
      let encoded = link.payload;
      if (link.kind === 'vhl') {
        result.vhl = decodeVhl(link.text, this.trust, trace);
        const inner = linkOf(result.vhl.shlink);
        if (!inner || inner.kind !== 'shl') {
          trace.fail('The link in the VHL is not an SHL (shlink:/...)');
        }
        encoded = inner.payload;
      } else {
        trace.info(link.viewer ? `An SHL, opened with the viewer ${link.viewer}` : 'An SHL, with no viewer in front of it');
      }
      const payload = decodePayload(encoded, trace, { allowHttp: this.allowPrivate });
      result.payload = payload;
      const flag = typeof payload.flag === 'string' ? payload.flag : '';
      const recipient = options.recipient || 'FHIRsmith IPS viewer';
      let files;
      if (flag.includes('U') && !flag.includes('P')) {
        const url = new URL(payload.url);
        url.searchParams.set('recipient', recipient);
        const r = await this.request('GET', url.toString(), { headers: { Accept: 'application/jose' } }, trace, 'The file (flag U)');
        if (r.status !== 200) {
          trace.fail(`The SHL server answered HTTP ${r.status} for the file`);
        }
        if (!/application\/jose/.test(r.headers['content-type'] || '')) {
          trace.warning(`The content type should be application/jose: it is ${r.headers['content-type'] || '(none)'}`);
        }
        files = [{ contentType: FHIR_JSON, jwe: r.text, where: 'the U flag GET' }];
      } else {
        if (flag.includes('P') && !options.passcode) {
          trace.info('The link needs a passcode (flag P): asking for it');
          result.state = 'needs-passcode';
          return result;
        }
        const body = { recipient };
        if (options.passcode) {
          body.passcode = options.passcode;
        }
        const r = await this.request('POST', payload.url, { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Accept: 'application/json' } }, trace, 'The manifest');
        if (r.status === 401 && flag.includes('P')) {
          let remaining = null;
          try {
            remaining = JSON.parse(r.text).remainingAttempts;
          } catch {
            remaining = null;
          }
          trace.add('error', 'The passcode was not accepted' + (typeof remaining === 'number' ? ` (${remaining} attempt${remaining === 1 ? '' : 's'} left)` : ''));
          result.state = 'needs-passcode';
          result.message = 'The passcode was not accepted' + (typeof remaining === 'number' ? ` - ${remaining} attempt${remaining === 1 ? '' : 's'} left` : '');
          return result;
        }
        if (r.status === 404) {
          trace.fail('The SHL server does not know the link: it has expired, or was never there');
        }
        if (r.status < 200 || r.status >= 300) {
          trace.fail(`The SHL server answered HTTP ${r.status} for the manifest`);
        }
        let manifest;
        try {
          manifest = JSON.parse(r.text);
        } catch (e) {
          trace.fail(`The manifest is not JSON: ${e.message}`);
        }
        files = this.filesOf(manifest, payload.url, trace);
      }
      for (const [i, f] of files.entries()) {
        const n = files.length > 1 ? `File ${i + 1}` : 'The file';
        if (f.contentType === 'application/smart-health-card') {
          trace.warning(`${n} is a SMART Health Card: they are not supported here`);
          continue;
        }
        if (f.contentType === 'application/smart-api-access') {
          trace.warning(`${n} is SMART API access (a token for a FHIR server): not supported here`);
          continue;
        }
        if (f.contentType !== FHIR_JSON) {
          trace.warning(`${n} is ${f.contentType || 'of no content type'}: only ${FHIR_JSON} is supported here`);
          continue;
        }
        try {
          let jwe = f.jwe;
          if (jwe === undefined) {
            const r = await this.request('GET', f.location, { headers: { Accept: 'application/jose' } }, trace, `${n} (location)`);
            if (r.status !== 200) {
              trace.fail(`The SHL server answered HTTP ${r.status} for ${n.toLowerCase()}`);
            }
            jwe = r.text;
          }
          const { text: plain, header } = decryptJwe(jwe, payload.key, trace);
          if (header.cty && header.cty !== f.contentType) {
            trace.warning(`The JWE's cty (${header.cty}) is not the manifest's content type (${f.contentType})`);
          }
          let resource;
          try {
            resource = JSON.parse(plain);
          } catch (e) {
            trace.fail(`The decrypted content is not JSON: ${e.message}`, plain);
          }
          trace.info(`${n}, decrypted`, plain);
          const doc = examine(resource, trace);
          if (doc) {
            result.documents.push({ ...doc, contentType: f.contentType });
          }
        } catch (e) {
          if (!(e instanceof Stop)) {
            throw e;
          }
          // the rest of the files may still be good
        }
      }
      if (result.documents.length === 0) {
        trace.fail('There is no document to show');
      }
      result.state = 'ok';
      trace.ok(`Done: ${result.documents.length} document${result.documents.length === 1 ? '' : 's'}`);
    } catch (e) {
      if (!(e instanceof Stop)) {
        trace.add('error', `Something went wrong in the viewer: ${e.message}`);
      }
      result.state = 'failed';
      result.message = e.message;
    }
    return result;
  }

  /** The files a manifest lists - an SHL manifest, or a VHL server's DocumentReference Bundle. */
  filesOf(manifest, url, trace) {
    const files = [];
    if (manifest && manifest.resourceType === 'Bundle') {
      trace.info('The manifest is a FHIR Bundle (as a VHL server gives it), not an SHL manifest: reading its DocumentReferences');
      for (const e of Array.isArray(manifest.entry) ? manifest.entry : []) {
        const dr = e?.resource;
        if (!dr || dr.resourceType !== 'DocumentReference') {
          trace.warning(`An entry is a ${dr?.resourceType || 'nothing'}, not a DocumentReference: left out`);
          continue;
        }
        for (const c of Array.isArray(dr.content) ? dr.content : []) {
          let location = c?.attachment?.url;
          let contentType = c?.attachment?.contentType;
          if (!location && typeof c?.url === 'string') {
            trace.warning(`DocumentReference ${dr.id || ''}: content.url is not a FHIR element - it should be content.attachment.url (used anyway)`);
            location = c.url;
            contentType = c.contentType;
          }
          if (!location) {
            trace.warning(`DocumentReference ${dr.id || ''} has content with no attachment url: left out`);
            continue;
          }
          files.push({ contentType, location: new URL(location, url).toString() });
        }
      }
    } else if (manifest && Array.isArray(manifest.files)) {
      if (manifest.status !== undefined) {
        trace.info(`The manifest's status: ${manifest.status}` + (manifest.status === 'no-longer-valid' ? ' - the link should not be used' : ''));
      }
      if (manifest.list !== undefined) {
        trace.info('The manifest has a list (FHIR List): not used here');
      }
      for (const [i, f] of manifest.files.entries()) {
        if (!f || typeof f !== 'object') {
          trace.warning(`File ${i + 1} is not an object: left out`);
          continue;
        }
        if (typeof f.embedded === 'string') {
          files.push({ contentType: f.contentType, jwe: f.embedded, where: 'embedded' });
        } else if (typeof f.location === 'string') {
          files.push({ contentType: f.contentType, location: new URL(f.location, url).toString() });
        } else {
          trace.warning(`File ${i + 1} has neither embedded nor location: left out`);
        }
      }
    } else {
      trace.fail('The manifest has no files');
    }
    trace.info(`The manifest lists ${files.length} file${files.length === 1 ? '' : 's'}`, files.map(f => `${f.contentType}: ${f.jwe !== undefined ? `embedded (${f.jwe.length} characters)` : f.location}`).join('\n'));
    if (files.length === 0) {
      trace.fail('The manifest lists no files');
    }
    return files;
  }
}

module.exports = { ShlViewer, Trace, linkOf, decodePayload, decodeVhl, decryptJwe, examine, loadTrust, IPS_CODE };
