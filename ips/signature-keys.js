//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The KeyProvider the signatures step gives verify() (signatures.js): the server's key store
 * (library/keystore). When the key store isn't enabled, it knows no keys.
 *
 * @module ips/signature-keys
 */

const crypto = require('crypto');

class KeyStoreKeyProvider {
  /**
   * @param {Object} [keystore] library/keystore (default: the server's)
   */
  constructor(keystore = require('../library/keystore')) {
    this.keystore = keystore;
  }

  /** The key a signature names by its id, or null */
  async getKeyById(kid) {
    if (!this.keystore.initialized || typeof kid !== 'string' || !kid) {
      return null;
    }
    return this.describe(this.keystore.key(kid));
  }

  /** The key store's entry for a public key that came with a signature (x5c), or null */
  async getKeyByPublicKey(key) {
    if (!this.keystore.initialized || !key) {
      return null;
    }
    return this.describe(this.keystore.keyForPublicKey(key));
  }

  describe(row) {
    if (!row) {
      return null;
    }
    const ks = this.keystore;
    const jwk = ks.jwk(row);
    return {
      keyId: row.key_id,
      key: crypto.createPublicKey({ key: row.spki, format: 'der', type: 'spki' }),
      jwk: Object.fromEntries(['kty', 'crv', 'x', 'y', 'n', 'e', 'kid', 'alg'].filter(k => jwk[k] !== undefined).map(k => [k, jwk[k]])),
      alg: ks.algOf(row),
      status: row.status,
      expires: row.expires || null,
      reason: row.reason || null,
      owner: `${row.origin === 'created' ? 'created' : 'uploaded'} by ${ks.ownerName(row)}`,
      origin: row.origin,
      source: 'keystore'
    };
  }
}

module.exports = { KeyStoreKeyProvider };
