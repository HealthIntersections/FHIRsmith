# The key store (`library/keystore`)

One list of signing keys for the whole server, at `/keys`. Every key in it is a public key,
listed for anyone to see, on the web and as a JWKS. For some of them the server also holds the
private key, and signs with it for the key's owner - a user, or the server itself - when a module
asks it to.

The store makes **no identity claims**. A key is shown as *uploaded by* or *created by* its owner
(by their display name), and that is all the server says about it. Nothing in an uploaded
certificate is checked.

## Configuration

The top-level `keystore` block of `config.json`. The store is off unless `enabled` is true.

| Setting | Default | |
|---|---|---|
| `enabled` | `false` | `/keys`, the account page's *Your keys*, and the administrator's *Keys* page |
| `database` | `keystore.db` | The public keys, their owners and status, and the log of what happened to them, in the databases folder (or an absolute path). Nothing in it is secret |
| `privateDatabase` | `keystore-private.db` | The private keys, and nothing else. Made with mode 0600 (its journal files too), with SQLite's `secure_delete` on, so a destroyed key is overwritten. It must be a different file from `database` |
| `uploadAllowance` | 10 | How many keys a user can upload before the daily limit applies |
| `uploadsPerDay` | 1 | Past the allowance, how many keys a user can upload in any 24 hours |
| `createsPerDay` | 1 | How many key pairs of each type a user can have made in any 24 hours |
| `rsaBits` | 3072 | The size of the RSA keys the server makes: 2048, 3072 or 4096 |

Administrators have no limits. Under the launcher every process uses the same two databases.

The private keys are not encrypted: anyone who can read the data folder can read everything
there anyway. They are in a database of their own so that copying, backing up or debugging the
other never moves a private key.

## Keys

| Type | Signs | |
|---|---|---|
| EC P-256 | ES256 | |
| EC P-384 | ES384 | |
| RSA (2048 to 16384 bits) | RS256 (an uploaded JWK can say PS256 etc.) | the server makes 3072 bit keys (`rsaBits`) |
| Ed25519 | EdDSA | |

Nothing else is taken: other curves, DSA, RSA under 2048 bits, X25519, PGP.

### Uploading a public key

Any logged in user can upload public keys, on *Your keys* (`/keys/mine`) - pasted, or read from
a file in the browser - or with the API. What is read:

- PEM: `PUBLIC KEY` (SubjectPublicKeyInfo), `RSA PUBLIC KEY` (PKCS#1), `CERTIFICATE` (a chain:
  the first certificate's key; the chain is kept)
- a JWK, or a JWKS (every key in it; up to 20)
- an OpenSSH public key line: `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ecdsa-sha2-nistp384`, `ssh-rsa`
  (the comment becomes the label)
- DER - SubjectPublicKeyInfo, PKCS#1 or a certificate - binary, or as base64 text

What was uploaded is kept as it was (shown on the key's page). An X.509 certificate is kept for
later use, but nothing in it is checked or shown as a claim: not its subject, issuer, dates or
chain.

**Private keys are never uploaded.** An upload with a private key anywhere in it is refused
whole, never stripped: a `... PRIVATE KEY` PEM (PKCS#8, SEC1, PKCS#1, OpenSSH), a JWK with `d`
(or `p`, `q`, `dp`, `dq`, `qi`, `oth`, `k`), private DER, PKCS#12, a PuTTY key file.

**A key is in the store only once** (by its public key), whoever uploaded it.

### Key ids

A key's id is unique in the store; signatures name keys by it (a JWS `kid`).

- An uploader can claim an id: the one their signatures carry. A JWK's `kid` is a claim. A claimed
  id is 1 to 200 printable characters with no spaces, and not one taken by another key. An id
  starting `SHA256:` must be the key's own fingerprint
- Otherwise the id is the key's fingerprint: `SHA256:` and the base64 SHA-256 of its
  SubjectPublicKeyInfo (as npm names keys). Keys the server makes always have this id
- Ids are first come, first served. When someone has claimed an id that is someone else's, the
  administrator changes it (*Key id* on `/keys/admin`; empty gives the key its fingerprint)

### Key pairs the server makes

A user can have the server make a key pair (*Your keys*): one active pair of each type. Making
another of a type retires the last one - its private key is destroyed, and its public key stays
listed, *retired*. The server never gives a private key out; it signs with it when a module asks
(below). Someone who needs to hold their own private key makes it themselves and uploads the
public key.

The administrator makes the **system's** key pairs (`/keys/admin`), one active of each type,
listed as *created by System*.

### Revoking and deleting

- **Revoking** (the key's owner, or an administrator): the key stays listed, *revoked*, with a time
  it is not to be trusted from (now, or a time given, UTC) and a reason. Any private key is
  destroyed. A signature checked with a revoked key fails if it was made at or after that time
- **Deleting** (administrators): the key is gone, and signatures made with it can't be checked
  here any more. For junk, mistakes and abuse

A disabled account's keys stay listed, and sign nothing. When an account is deleted, the private
keys of its key pairs are destroyed (within the hour); the public keys stay.

## Pages and API

| | |
|---|---|
| `GET /keys` | The keys, with filters (`status`, `kty`, `owner=system`) |
| `GET /keys/jwks.json` | The keys as a JWKS, with the same filters. Each has `kid`, `alg`, `use: "sig"`, and `status`, `expires` (revoked), `owner` (display name, or `system`), `origin` (`uploaded`, `created`), `created`, `fingerprint` |
| `GET /keys/key/{kid}` | A key: HTML; JSON (a JWK as above) with `Accept: application/json` or `?format=json`; PEM with `Accept: application/x-pem-file` or `?format=pem` |
| `/keys/mine` | A user's own keys: upload, make, label, revoke |
| `/keys/admin` | The administrator's: system key pairs, revoking, deleting, key ids |
| `POST /keys/api/upload` | `{key, kid?, label?}`: `key` is the text of the upload, or a JWK or JWKS object. 201 `{keys: [jwk]}` |
| `POST /keys/api/create` | `{kty, label?, system?}` (`kty`: `EC-P256`, `EC-P384`, `RSA`, `Ed25519`). 201 the new key's JWK |
| `POST /keys/api/key/{kid}/revoke` | `{reason?, expires?}` |
| `GET /keys/api/mine` | `{keys, uploadsLeft}` |

The API takes an API token (`Authorization: Bearer fhs_...`) or a login. Errors are
`{error, message}`: 400, 401, 403, 404, 409 (already there), 429 (over the limit).

Owners are shown by their display name: never their login or email.

## For modules

There is no endpoint that signs whatever it is given. A module builds the payload for one of its
operations and asks the store to sign it; every use of a private key is logged (the operation, the
key and the hash of what was signed).

A module whose own code has to sign - the FHIR signature formats need the key itself, for a JOSE
library or XML signing (the IPS module's `ips/signatures.js`) - loads the private key with
`loadPrivateKey`. The key stays in the server's memory, for that one operation; each load is logged
with what it was for (and counted in the daily report), and refused for a disabled account.

```js
// the first of these types the owner has an active key pair of; null if none
const loaded = keystore.loadPrivateKey({ owner: user.id, types: ['EC-P256', 'RSA'], purpose: 'ips:sign-document', actor: user.id });
// loaded.row (the key's entry), loaded.privateKey (a crypto.KeyObject)
keystore.usableKey(owner, types);   // the same choice, without loading (or logging) anything
```

```js
const keystore = require('../library/keystore');

if (keystore.initialized) {
  // bytes, with the user's key (the first type they have: EC P-256, EC P-384, Ed25519, RSA)
  const { keyId, alg, signature } = keystore.sign({ owner: user.id, purpose: 'ips:sign-document', payload, actor: user.id });
  // or the system's, of a type
  keystore.sign({ owner: keystore.SYSTEM, kty: 'EC-P256', purpose: 'ips:countersign', payload });
  // a compact JWS (detached by default); the header gets alg and kid
  const jws = keystore.signJws({ owner: user.id, purpose: 'ips:sign-document', payload: canonicalJson,
    header: { canon: 'http://hl7.org/fhir/canonicalization/json' } });

  // checking: {ok, key, owner, problem}. owner is the display name the store shows (or System)
  keystore.verifyJws(jws, canonicalJson, { at: whenFirstSeen });
  keystore.verify({ kid, alg, data, signature, at });
}
```

- `sign` refuses (`KeyStoreError`) when the owner is disabled or gone, or has no key pair of the
  type
- `at`: when the signature was made, as far as you know it - better a time you trust (when the
  document was first seen) than the time the signature claims. Checked against a revoked key's
  expiry
- `keystore.key(kid)`, `keystore.keyForPublicKey(key)` (the entry for a public key, by its fingerprint: a key that came in a signature's certificate may be one the store has revoked), `keystore.list(filter)`, `keystore.jwk(row)`, `keystore.ownerName(row)`

## The daily report

When there are keys, the daily report has a paragraph on them: how many (active, retired,
revoked; active system keys), what was uploaded, made, retired, revoked, deleted and renamed in
the period, uploads refused (private keys, already there, over the limit, unsupported,
unreadable), and signatures made, by operation. The log of these is kept for 400 days.
