//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * npm registry signatures.
 *
 * A registry signature says "this registry served name@version with this integrity". It is
 * the registry's statement, not the publisher's, so it can be made for every package this
 * server holds, wherever it was crawled from. npm checks them with `npm audit signatures`:
 *
 *   - GET {registry}/-/npm/v1/keys lists the registry's public keys. A registry without it
 *     (a 404) is one that doesn't sign, and npm skips its packages.
 *   - each version's dist.signatures is [{ keyid, sig }], where sig is the base64 DER ECDSA
 *     P-256 / SHA-256 signature of `${name}@${version}:${dist.integrity}`, and
 *     dist.integrity is the sha512 SRI string of the tarball.
 *   - once a registry lists keys, a version with no signature (or a bad one) is an error.
 *
 * References:
 *   https://docs.npmjs.com/about-registry-signatures
 *   https://github.com/npm/cli/blob/latest/lib/utils/verify-signatures.js
 *   https://github.com/npm/pacote/blob/main/lib/registry.js (verifySignatures)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_TYPE = 'ecdsa-sha2-nistp256';
const HASH_SLICE = 4 * 1024 * 1024;

// The message a registry signature is over
function signedMessage(name, version, integrity) {
  return `${name}@${version}:${integrity}`;
}

// sha512 SRI string of a tarball. Hashed in slices, yielding between them, so a large
// package doesn't hold up the event loop.
async function integrityOf(buffer) {
  const hash = crypto.createHash('sha512');
  for (let i = 0; i < buffer.length; i += HASH_SLICE) {
    hash.update(buffer.subarray(i, i + HASH_SLICE));
    if (i + HASH_SLICE < buffer.length) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  return 'sha512-' + hash.digest('base64');
}

// The same, synchronously
function integrityOfSync(buffer) {
  return 'sha512-' + crypto.createHash('sha512').update(buffer).digest('base64');
}

// npm's key id: SHA256: and the base64 sha256 of the public key (SPKI DER)
function keyIdOf(spkiDer) {
  return 'SHA256:' + crypto.createHash('sha256').update(spkiDer).digest('base64');
}

// Checks a signature the way npm does (pacote's verifySignatures): key is an entry from
// /-/npm/v1/keys. Returns true or false.
function verifySignature(key, name, version, integrity, sig) {
  try {
    const pem = `-----BEGIN PUBLIC KEY-----\n${key.key}\n-----END PUBLIC KEY-----`;
    const verifier = crypto.createVerify('SHA256');
    verifier.write(signedMessage(name, version, integrity));
    verifier.end();
    return verifier.verify(pem, sig, 'base64');
  } catch (e) {
    return false;
  }
}

class NpmSigner {
  constructor(privateKey) {
    const details = privateKey.asymmetricKeyDetails || {};
    if (privateKey.asymmetricKeyType !== 'ec' || details.namedCurve !== 'prime256v1') {
      throw new Error(`An npm signing key must be an EC P-256 (prime256v1) key; this one is ${privateKey.asymmetricKeyType} ${details.namedCurve || ''}`.trim());
    }
    this.privateKey = privateKey;
    const der = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    this.publicKey = der.toString('base64');
    this.keyid = keyIdOf(der);
  }

  /**
   * The signing key in file (PEM, PKCS#8 or SEC1). If there is no file, a new key is made and
   * saved there, readable only by this user. log is told when a key is made.
   */
  static load(file, log) {
    if (!fs.existsSync(file)) {
      const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        // wx: never replace a key that appeared meanwhile
        fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
        log?.info?.(`Made a new npm signing key: ${file}`);
      } catch (e) {
        if (e.code !== 'EEXIST') {
          throw e;
        }
      }
    }
    return new NpmSigner(crypto.createPrivateKey(fs.readFileSync(file)));
  }

  // The body of /-/npm/v1/keys
  keysDocument() {
    return {
      keys: [{
        expires: null,
        keyid: this.keyid,
        keytype: KEY_TYPE,
        scheme: KEY_TYPE,
        key: this.publicKey
      }]
    };
  }

  // The base64 DER signature for name@version with this integrity
  sign(name, version, integrity) {
    return crypto.sign('sha256', Buffer.from(signedMessage(name, version, integrity), 'utf8'), this.privateKey).toString('base64');
  }
}

module.exports = { NpmSigner, integrityOf, integrityOfSync, verifySignature, signedMessage, keyIdOf };
