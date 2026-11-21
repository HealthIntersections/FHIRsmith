//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Checking and making an IPS document's signatures. verify() is the first step of the
 * pipeline (the signatures step in pipeline.js), shown at the top of the analysis view; sign()
 * signs a copy of a document for download or sharing (the source view's banner: ips.js
 * signedCopy).
 *
 * This file is the contract; the implementation is still to be written. See
 * https://build.fhir.org/signatures.html for what a FHIR signature is.
 *
 * ## verify(bundle, keys, options)
 *
 * - `bundle`: the document, as parsed JSON. It is a copy: change it as you like. NB: it is the
 *   document as the server stored it, which has its own `id` (the server's serial) and
 *   `meta.lastUpdated` (when it was received), and no `meta.versionId`, in place of whatever
 *   the submitter sent
 * - `keys`: where public keys come from - a KeyProvider (below). Don't go to the key store
 *   (library/keystore) directly: other key stores may be added
 * - `options.receivedAt`: when the server received the document (ISO 8601). A time the server
 *   trusts, unlike the time a signature says it was made: use it for a revoked key's expiry
 * - `options.log`: the module's log (info, warn, error)
 *
 * Returns (a promise of) a list of outcomes, each
 *
 *   { status: 'error' | 'warning' | 'information', keyId: string | null, description: string }
 *
 * for example
 *
 *   { status: 'information', keyId: null, description: 'The document has no signatures' }
 *   { status: 'error', keyId: 'SHA256:hwBa...', description: 'The signature is not valid' }
 *   { status: 'warning', keyId: 'SHA256:hwBa...', description: 'The key has been revoked (from 2026-11-01), but the signature was made before that' }
 *
 * Something that goes wrong in verify() (it throws) is shown as an error outcome, and the
 * document's processing goes on: a signature that can't be checked doesn't stop the analysis.
 * Outcomes that aren't of this form are shown as errors too.
 *
 * ## KeyProvider
 *
 * Both methods are async, and return null when the key isn't known:
 *
 * - `getKeyById(kid)`: the key a signature names (the JWS header's kid)
 * - `getKeyByPublicKey(key)`: the provider's entry for a public key that came some other way -
 *   in the signature's own certificate (x5c). The key in a signature is used to check it, but
 *   look it up too: the key may be known here, and revoked
 *
 * A key is
 *
 *   {
 *     keyId:   string,                  the key's id
 *     key:     crypto.KeyObject,        the public key, for crypto.verify (key.asymmetricKeyType: 'ec', 'rsa', 'ed25519')
 *     jwk:     object,                  the same key as a JWK (kty, crv, x, y, n, e; kid, alg)
 *     alg:     string,                  the JOSE algorithm it signs with (ES256, ES384, RS256, PS256, EdDSA, ...)
 *     status:  'active' | 'retired' | 'revoked',   retired: replaced by a newer key, but its signatures stand
 *     expires: string | null,           for a revoked key, from when it is not to be trusted (ISO 8601)
 *     reason:  string | null,           why it was revoked, if anyone said
 *     owner:   string,                  who it belongs to, as the provider shows it ("uploaded by" / "created by"): the provider's say-so, not an identity check
 *     origin:  'uploaded' | 'created',  created: the provider made the key pair, and holds the private key
 *     source:  string                   which provider ('keystore')
 *   }
 *
 * ## sign(bundle, signers, options)
 *
 * - `bundle`: the document to sign, as parsed JSON: a copy of the original, or of the modified
 *   copy (whichever the user is looking at). Change it as you like
 * - `signers`: `{ user, system }`, each null or a signer; at least one is not null. user: the
 *   logged in user's own key pair; system: the server's
 * - `options.log`: the module's log
 *
 * Returns (a promise of) the signed document, as parsed JSON. Throw to refuse: the message is
 * shown to the user. The signed document is not kept: it is downloaded, or shared, as it is.
 *
 * A signer is
 *
 *   {
 *     key:        Object,              the public key, as a KeyProvider gives it (above)
 *     privateKey: crypto.KeyObject,    the private key: crypto.sign, or a JOSE library
 *     url:        string               the key's permalink: its page on this server, for anyone checking
 *   }
 *
 * The server chooses the key pair: the first type in `signingKeyTypes` (below) the user (or
 * the system) has. Its names are the key store's: 'EC-P256', 'EC-P384', 'Ed25519', 'RSA'.
 *
 * @module ips/signatures
 */

/**
 * The key types sign() can sign with, best first. A user (or the system) with none of them
 * can't sign.
 */
const signingKeyTypes = ['EC-P256', 'EC-P384', 'Ed25519', 'RSA'];

/**
 * Check the signatures in a document.
 *
 * @param {Object} bundle - the document (a copy)
 * @param {{getKeyById: function(string): Promise<Object|null>, getKeyByPublicKey: function(import('crypto').KeyObject): Promise<Object|null>}} keys
 * @param {{receivedAt?: string, log?: Object}} [options]
 * @returns {Promise<Array<{status: 'error'|'warning'|'information', keyId: string|null, description: string}>>}
 */
// eslint-disable-next-line no-unused-vars
async function verify(bundle, keys, options = {}) {
  return [{ status: 'information', keyId: null, description: 'Signature checking is not implemented yet' }];
}

/**
 * Sign a document.
 *
 * @param {Object} bundle - the document (a copy)
 * @param {{user: Object|null, system: Object|null}} signers
 * @param {{log?: Object}} [options]
 * @returns {Promise<Object>} the signed document
 */
// eslint-disable-next-line no-unused-vars
async function sign(bundle, signers, options = {}) {
  return bundle;
}

module.exports = { verify, sign, signingKeyTypes };
