// library/keystore/keys.js
// Reading and making keys: what an upload holds (PEM, JWK/JWKS, an OpenSSH line, an X.509
// certificate, base64 or binary DER), refusing private key material, the key types the store
// takes, key ids, and the JOSE forms (JWK, alg) - see README.md. No state, no database.

const crypto = require('crypto');

// The key types the store takes and makes. `alg` is the JOSE algorithm a key of the type
// signs with, unless the key says otherwise (an uploaded RSA JWK with "alg": "PS256")
// Keys are made with crypto.generateKeyPair, which works in libuv's thread pool: an RSA key
// takes up to seconds to make, and must not hold the event loop that long
const generateKeyPair = require('util').promisify(crypto.generateKeyPair);
const KEY_TYPES = {
  'EC-P256': { label: 'EC P-256', alg: 'ES256', hash: 'sha256', generate: () => generateKeyPair('ec', { namedCurve: 'P-256' }) },
  'EC-P384': { label: 'EC P-384', alg: 'ES384', hash: 'sha384', generate: () => generateKeyPair('ec', { namedCurve: 'P-384' }) },
  'RSA': { label: 'RSA', alg: 'RS256', hash: 'sha256', generate: (bits) => generateKeyPair('rsa', { modulusLength: bits || 3072 }) },
  'Ed25519': { label: 'Ed25519', alg: 'EdDSA', hash: null, generate: () => generateKeyPair('ed25519') }
};

// the JOSE algorithms each type may sign with
const ALGS = {
  'EC-P256': ['ES256'],
  'EC-P384': ['ES384'],
  'RSA': ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512'],
  'Ed25519': ['EdDSA']
};

const MIN_RSA_BITS = 2048;
const MAX_RSA_BITS = 16384;
// a claimed key id: printable ASCII, no whitespace
const KID_RE = /^[\x21-\x7e]{1,200}$/;
// what an upload may be, at most (a certificate chain, a JWKS of a few keys)
const MAX_UPLOAD_BYTES = 64 * 1024;
const MAX_JWKS_KEYS = 20;
// JWK members that only a private (or secret) key has
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

/** A refused upload: `kind` says why, for the daily report (private, unsupported, invalid, ...) */
class KeyError extends Error {
  constructor(message, kind = 'invalid') {
    super(message);
    this.kind = kind;
  }
}

/** The store's key id for a public key: SHA256: + base64(sha256(SPKI DER)), as npm names keys */
function fingerprint(spkiDer) {
  return 'SHA256:' + crypto.createHash('sha256').update(spkiDer).digest('base64');
}

/** Is this a key id someone may claim? '' when it is, else why not */
function kidProblem(kid, spkiDer) {
  if (typeof kid !== 'string' || !KID_RE.test(kid)) {
    return 'A key id is 1 to 200 printable characters, with no spaces';
  }
  // an id that looks like one the store makes must be the key's own
  if (kid.startsWith('SHA256:') && spkiDer && kid !== fingerprint(spkiDer)) {
    return 'A key id that starts with SHA256: must be the key\'s own SHA-256 fingerprint';
  }
  return '';
}

// ---- describing a public key ----

/**
 * The store's view of a public key: {kty, bits, spki}. Throws KeyError for a type the store
 * doesn't take
 * @param {crypto.KeyObject} key
 */
function describe(key) {
  if (key.type !== 'public') {
    throw new KeyError('That is not a public key', 'private');
  }
  const t = key.asymmetricKeyType;
  const d = key.asymmetricKeyDetails || {};
  let kty = null;
  let bits = null;
  if (t === 'ec') {
    kty = d.namedCurve === 'prime256v1' ? 'EC-P256' : d.namedCurve === 'secp384r1' ? 'EC-P384' : null;
    if (!kty) {
      throw new KeyError(`EC keys on the curve ${d.namedCurve} are not supported: P-256 and P-384 are`, 'unsupported');
    }
    bits = kty === 'EC-P256' ? 256 : 384;
  } else if (t === 'rsa') {
    kty = 'RSA';
    bits = d.modulusLength;
    if (!(bits >= MIN_RSA_BITS)) {
      throw new KeyError(`RSA keys must be at least ${MIN_RSA_BITS} bits (this one is ${bits})`, 'unsupported');
    }
    if (bits > MAX_RSA_BITS) {
      throw new KeyError(`RSA keys of more than ${MAX_RSA_BITS} bits are not supported`, 'unsupported');
    }
  } else if (t === 'ed25519') {
    kty = 'Ed25519';
    bits = 256;
  } else {
    throw new KeyError(`${t ? t.toUpperCase() : 'This kind of'} keys are not supported: EC P-256, EC P-384, RSA and Ed25519 are`, 'unsupported');
  }
  return { kty, bits, spki: key.export({ type: 'spki', format: 'der' }) };
}

// ---- OpenSSH public key lines ----

function sshReader(buf) {
  let pos = 0;
  return {
    string() {
      if (pos + 4 > buf.length) {
        throw new KeyError('The OpenSSH key is cut short');
      }
      const len = buf.readUInt32BE(pos);
      pos += 4;
      if (pos + len > buf.length) {
        throw new KeyError('The OpenSSH key is cut short');
      }
      const v = buf.subarray(pos, pos + len);
      pos += len;
      return v;
    },
    done: () => pos === buf.length
  };
}

/** an SSH mpint as unsigned big-endian bytes, base64url */
function mpint(b) {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) {
    i++;
  }
  return b.subarray(i).toString('base64url');
}

const SSH_TYPES = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ssh-rsa'];

/** An OpenSSH public key line ("ssh-ed25519 AAAA... comment") -> {key, comment} */
function parseSshLine(line) {
  const m = /^(\S+)\s+([A-Za-z0-9+/]+={0,2})(?:\s+(.*))?$/.exec(line);
  if (!m) {
    throw new KeyError('That is not an OpenSSH public key line');
  }
  if (!SSH_TYPES.includes(m[1])) {
    throw new KeyError(`OpenSSH ${m[1]} keys are not supported: ${SSH_TYPES.join(', ')} are`, 'unsupported');
  }
  const r = sshReader(Buffer.from(m[2], 'base64'));
  const type = r.string().toString('latin1');
  if (type !== m[1]) {
    throw new KeyError('The OpenSSH key says it is a different type inside');
  }
  let jwk;
  if (type === 'ssh-ed25519') {
    const x = r.string();
    if (x.length !== 32) {
      throw new KeyError('The Ed25519 key is the wrong length');
    }
    jwk = { kty: 'OKP', crv: 'Ed25519', x: x.toString('base64url') };
  } else if (type === 'ssh-rsa') {
    const e = r.string();
    const n = r.string();
    jwk = { kty: 'RSA', e: mpint(e), n: mpint(n) };
  } else {
    const curve = r.string().toString('latin1');
    const size = curve === 'nistp256' ? 32 : curve === 'nistp384' ? 48 : 0;
    const q = r.string();
    if (!size || `ecdsa-sha2-${curve}` !== type || q.length !== 1 + 2 * size || q[0] !== 4) {
      throw new KeyError('The OpenSSH ECDSA key is not a key this server can read');
    }
    jwk = { kty: 'EC', crv: size === 32 ? 'P-256' : 'P-384', x: q.subarray(1, 1 + size).toString('base64url'), y: q.subarray(1 + size).toString('base64url') };
  }
  if (!r.done()) {
    throw new KeyError('The OpenSSH key has extra content');
  }
  return { key: publicFromJwk(jwk), comment: (m[3] || '').trim() };
}

// ---- private key material ----

/** Does a JWK carry private (or secret) key material? */
function jwkIsPrivate(jwk) {
  return jwk && typeof jwk === 'object' && PRIVATE_JWK_MEMBERS.some(k => k in jwk);
}

/** Do these bytes read as a private key in any DER form node knows? */
function derIsPrivate(der) {
  for (const type of ['pkcs8', 'sec1', 'pkcs1']) {
    try {
      crypto.createPrivateKey({ key: der, format: 'der', type });
      return true;
    } catch {
      // not that
    }
  }
  // a PKCS#12 file (PFX): SEQUENCE { INTEGER 3, SEQUENCE { OID pkcs7-data ... } }
  const pkcs7data = Buffer.from('06092a864886f70d010701', 'hex');
  const head = der.subarray(0, 32);
  return der[0] === 0x30 && head.includes(Buffer.from('020103', 'hex')) && der.subarray(0, 64).includes(pkcs7data);
}

const PRIVATE_TEXT = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /-----BEGIN PGP PRIVATE KEY BLOCK-----/,
  /PuTTY-User-Key-File-/,
  /-----BEGIN SSH2 ENCRYPTED PRIVATE KEY-----/
];

function refusePrivate() {
  return new KeyError('That contains a private key. Private keys are never uploaded: upload only the public key', 'private');
}

// ---- JWK ----

function publicFromJwk(jwk) {
  try {
    return crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch (e) {
    throw new KeyError(`The JWK is not a key this server can read: ${e.message}`);
  }
}

/** The public JWK of a key (kty, crv/x/y, n/e), with no kid or alg */
function toJwk(spkiDer) {
  const jwk = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' }).export({ format: 'jwk' });
  const out = {};
  for (const k of ['kty', 'crv', 'x', 'y', 'n', 'e']) {
    if (jwk[k] !== undefined) {
      out[k] = jwk[k];
    }
  }
  return out;
}

/** The public key as PEM (SubjectPublicKeyInfo) */
function toPem(spkiDer) {
  return crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' });
}

// ---- reading an upload ----

/**
 * One key read from an upload: describe() plus where it came from
 * @returns {{kty, bits, spki, alg: string|null, kid: string|null, label: string, sourceFormat: string, source: string}}
 */
function entry(key, { sourceFormat, source, kid = null, alg = null, label = '' }) {
  const d = describe(key);
  if (alg && !(ALGS[d.kty] || []).includes(alg)) {
    throw new KeyError(`The key says it is for ${alg}, which a ${KEY_TYPES[d.kty].label} key can't be`);
  }
  return { ...d, alg: alg || null, kid: kid || null, label, sourceFormat, source };
}

function readJson(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new KeyError(`That looks like JSON, but isn't: ${e.message}`);
  }
  const list = v && Array.isArray(v.keys) ? v.keys : [v];
  if (list.length === 0) {
    throw new KeyError('The JWKS has no keys');
  }
  if (list.length > MAX_JWKS_KEYS) {
    throw new KeyError(`A JWKS can have at most ${MAX_JWKS_KEYS} keys`);
  }
  // all or nothing: a private member anywhere refuses the whole upload
  if (list.some(jwkIsPrivate)) {
    throw refusePrivate();
  }
  return list.map(jwk => {
    if (!jwk || typeof jwk !== 'object' || typeof jwk.kty !== 'string') {
      throw new KeyError('That is not a JWK (it has no "kty")');
    }
    if (jwk.use !== undefined && jwk.use !== 'sig') {
      throw new KeyError(`The key ${jwk.kid ? `"${jwk.kid}" ` : ''}is for use "${jwk.use}": only signing keys ("sig") go in this store`);
    }
    if (jwk.kid !== undefined && typeof jwk.kid !== 'string') {
      throw new KeyError('A JWK\'s "kid" must be a string');
    }
    // the JWK as uploaded, kept as the source of this key
    return entry(publicFromJwk(jwk), { sourceFormat: 'jwk', source: JSON.stringify(jwk), kid: jwk.kid || null, alg: typeof jwk.alg === 'string' ? jwk.alg : null });
  });
}

function readPem(text) {
  const blocks = [...text.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g)];
  if (blocks.length === 0) {
    throw new KeyError('The PEM has no complete BEGIN ... END block');
  }
  const type = blocks[0][1];
  const pem = blocks[0][0];
  if (type === 'CERTIFICATE') {
    // a chain: the first certificate is the key's; the rest are kept with it
    if (blocks.some(b => b[1] !== 'CERTIFICATE')) {
      throw new KeyError('Upload one key at a time: a certificate (or a chain), or one public key');
    }
    let cert;
    try {
      cert = new crypto.X509Certificate(pem);
    } catch (e) {
      throw new KeyError(`The certificate can't be read: ${e.message}`);
    }
    return [entry(cert.publicKey, { sourceFormat: 'x509', source: blocks.map(b => b[0]).join('\n') + '\n', label: subjectLabel(cert) })];
  }
  if (blocks.length > 1) {
    throw new KeyError('Upload one key at a time (or a JWKS, for several)');
  }
  if (type === 'PGP PUBLIC KEY BLOCK') {
    throw new KeyError('PGP keys are not supported', 'unsupported');
  }
  if (type !== 'PUBLIC KEY' && type !== 'RSA PUBLIC KEY') {
    throw new KeyError(`A PEM "${type}" is not something this server reads: PUBLIC KEY, RSA PUBLIC KEY or CERTIFICATE`, 'unsupported');
  }
  let key;
  try {
    key = crypto.createPublicKey(pem);
  } catch (e) {
    throw new KeyError(`The public key can't be read: ${e.message}`);
  }
  return [entry(key, { sourceFormat: 'pem', source: pem + '\n' })];
}

/** The certificate's subject CN, as a starting label: shown as the uploader's label, not a claim */
function subjectLabel(cert) {
  const cn = /(?:^|\n)CN=([^\n]*)/.exec(cert.subject || '');
  return cn ? cn[1].substring(0, 100) : '';
}

function readDer(der) {
  if (derIsPrivate(der)) {
    throw refusePrivate();
  }
  try {
    return [entry(crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }), { sourceFormat: 'der', source: toPem(der) })];
  } catch (e) {
    if (e instanceof KeyError) {
      throw e;
    }
  }
  try {
    const key = crypto.createPublicKey({ key: der, format: 'der', type: 'pkcs1' });
    return [entry(key, { sourceFormat: 'der', source: key.export({ type: 'pkcs1', format: 'pem' }) })];
  } catch (e) {
    if (e instanceof KeyError) {
      throw e;
    }
  }
  let cert;
  try {
    cert = new crypto.X509Certificate(der);
  } catch {
    throw new KeyError('That is not a public key format this server reads: PEM, a JWK or JWKS, an OpenSSH public key line, or an X.509 certificate', 'unsupported');
  }
  return [entry(cert.publicKey, { sourceFormat: 'x509', source: cert.toString(), label: subjectLabel(cert) })];
}

/**
 * The keys in an upload: pasted text (PEM, JWK, JWKS, an OpenSSH line, base64 DER) or a file's
 * bytes (any of those, or binary DER). Throws KeyError - with kind 'private' for anything that
 * holds a private key, which is refused whole, never stripped
 * @param {string|Buffer} input
 * @returns {Array<ReturnType<typeof entry>>}
 */
function parseUpload(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8');
  if (buf.length === 0) {
    throw new KeyError('There is nothing to upload');
  }
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new KeyError(`An upload can be at most ${MAX_UPLOAD_BYTES / 1024} KB`);
  }
  // text, or binary DER?
  const text = buf.toString('utf8');
  // (a byte that isn't UTF-8 decodes as U+FFFD; a control character other than whitespace)
  const binary = text.includes(String.fromCharCode(0xfffd)) || buf.some(b => b < 9 || (b > 13 && b < 32));
  if (binary) {
    return readDer(buf);
  }
  const t = text.trim();
  if (PRIVATE_TEXT.some(re => re.test(t)) || /^-----BEGIN OPENSSH PRIVATE KEY-----/m.test(t)) {
    throw refusePrivate();
  }
  if (t.startsWith('{')) {
    return readJson(t);
  }
  if (t.includes('-----BEGIN ')) {
    return readPem(t);
  }
  if (/^(ssh-|ecdsa-sha2-|sk-)/.test(t)) {
    const lines = t.split(/\r?\n/).filter(l => l.trim());
    if (lines.length > 1) {
      throw new KeyError('Upload one OpenSSH key at a time');
    }
    const { key, comment } = parseSshLine(lines[0].trim());
    return [entry(key, { sourceFormat: 'ssh', source: lines[0].trim(), label: comment.substring(0, 100) })];
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(t)) {
    return readDer(Buffer.from(t.replace(/\s+/g, ''), 'base64'));
  }
  throw new KeyError('That is not a public key format this server reads: PEM, a JWK or JWKS, an OpenSSH public key line, or an X.509 certificate', 'unsupported');
}

// ---- making keys, and signing ----

/** A new key pair of a type (a promise): {kty, bits, spki, pkcs8} */
async function generate(kty, { rsaBits = 3072 } = {}) {
  const t = KEY_TYPES[kty];
  if (!t) {
    throw new KeyError(`Unknown key type ${kty}`);
  }
  const { publicKey, privateKey } = await t.generate(rsaBits);
  return { ...describe(publicKey), pkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }) };
}

/**
 * A JOSE signature (JWS's form: ECDSA as r||s) over bytes, with a private key (PKCS#8 DER)
 * @returns {Buffer}
 */
function joseSign(alg, pkcs8, data) {
  const key = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return crypto.sign(...joseArgs(alg, data, key));
}

/** Check a JOSE signature with a public key (SPKI DER) */
function joseVerify(alg, spkiDer, data, signature) {
  const key = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  try {
    return crypto.verify(...joseArgs(alg, data, key), signature);
  } catch {
    return false;
  }
}

function joseArgs(alg, data, key) {
  const m = /^(ES|RS|PS)(256|384|512)$/.exec(alg);
  if (alg === 'EdDSA') {
    return [null, data, key];
  }
  if (!m) {
    throw new KeyError(`Unknown algorithm ${alg}`);
  }
  const hash = `sha${m[2]}`;
  if (m[1] === 'ES') {
    return [hash, data, { key, dsaEncoding: 'ieee-p1363' }];
  }
  if (m[1] === 'PS') {
    return [hash, data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: Number(m[2]) / 8 }];
  }
  return [hash, data, key];
}

module.exports = {
  KEY_TYPES, ALGS, KeyError, MAX_UPLOAD_BYTES, MIN_RSA_BITS,
  fingerprint, kidProblem, describe, parseUpload, parseSshLine, toJwk, toPem, generate, joseSign, joseVerify, jwkIsPrivate
};
