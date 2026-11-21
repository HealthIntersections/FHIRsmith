// library/keystore/keystore.js
// The server's key store: public keys anyone can see, some of which the server also holds the
// private key for, and signs with on behalf of their owner (a user, or the server itself) when a
// module asks. See README.md.
//
// The store makes no identity claims: a key is "uploaded by X" or "created by X", and that is
// all. Private keys are never uploaded and never leave the server.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { KeyStoreDb, SYSTEM, DAY_MS } = require('./store');
const keys = require('./keys');

const DEFAULT_DATABASE = 'keystore.db';
const DEFAULT_PRIVATE_DATABASE = 'keystore-private.db';
const HOUSEKEEPING_MS = 60 * 60 * 1000;
// when a module doesn't say which type to sign with: the first of these the owner has
const SIGNING_PREFERENCE = ['EC-P256', 'EC-P384', 'Ed25519', 'RSA'];
const STATUSES = ['active', 'retired', 'revoked'];
const LABEL_MAX = 100;
const REASON_MAX = 500;

function posInt(v, dflt) {
  return Number.isInteger(v) && v >= 0 ? v : dflt;
}

/** Something a user asked for that can't be done: `status` is the HTTP status that fits */
class KeyStoreError extends Error {
  constructor(message, status = 400, kind = 'invalid') {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

/** A SQLite unique constraint failure as a 409; anything else as it was */
function uniqueClash(e, message) {
  return e && typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT') ? new KeyStoreError(message, 409, 'duplicate') : e;
}

class KeyStore {
  constructor() {
    this.db = null;
    this.config = {};
    this.log = console;
    this.auth = null;
    this.timer = null;
    this.initialized = false;
  }

  /**
   * @param {object} config the top level "keystore" block of config.json
   * @param {object} options
   * @param {object} [options.log]
   * @param {string} [options.databasesDir] where relative database paths go
   * @param {object} [options.auth] library/auth (default: the server's)
   */
  initialize(config, { log, databasesDir, auth } = {}) {
    this.shutdown();
    this.config = config || {};
    this.log = log || console;
    this.auth = auth || require('../auth');
    const dir = databasesDir || require('../folder-setup').databasesDir();
    const where = (v, d) => {
      const f = v || d;
      return f === ':memory:' || path.isAbsolute(f) ? f : path.join(dir, f);
    };
    this.dbPath = where(this.config.database, DEFAULT_DATABASE);
    this.privatePath = where(this.config.privateDatabase, DEFAULT_PRIVATE_DATABASE);
    for (const p of [this.dbPath, this.privatePath]) {
      if (p !== ':memory:') {
        fs.mkdirSync(path.dirname(p), { recursive: true });
      }
    }
    if (this.dbPath !== ':memory:' && this.dbPath === this.privatePath) {
      throw new Error('keystore.database and keystore.privateDatabase must be different files');
    }
    this.db = new KeyStoreDb(this.dbPath, this.privatePath);
    this.limits = {
      uploadAllowance: posInt(this.config.uploadAllowance, 10),
      uploadsPerDay: posInt(this.config.uploadsPerDay, 1),
      createsPerDay: posInt(this.config.createsPerDay, 1)
    };
    const bits = this.config.rsaBits;
    this.rsaBits = [2048, 3072, 4096].includes(bits) ? bits : 3072;
    this.initialized = true;
    this.housekeeping();
    this.timer = setInterval(() => this.housekeeping(), HOUSEKEEPING_MS);
    this.timer.unref();
    this.log.info(`Keystore: public keys in ${this.dbPath}, private keys in ${this.privatePath}`);
  }

  shutdown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
  }

  requireInitialized() {
    if (!this.db) {
      throw new Error('The key store is not initialized (library/keystore)');
    }
  }

  /**
   * Hourly: private keys of accounts that have been deleted are destroyed (a disabled account's
   * stay: it may be enabled again); a private key a crash left with no public key is destroyed;
   * old events go
   */
  housekeeping() {
    try {
      for (const owner of this.db.privateOwners()) {
        if (this.auth.initialized && !this.auth.user(Number(owner))) {
          for (const k of this.db.ofOwner(owner).filter(r => r.has_private)) {
            this.db.destroyPrivate(k.key_id);
            this.db.event('destroy', { keyId: k.key_id, kty: k.kty, owner, detail: 'account deleted' });
            this.log.info(`Keystore: private key ${k.key_id} destroyed: its account (${owner}) has been deleted`);
          }
        }
      }
      for (const kid of this.db.orphanPrivateKeys()) {
        this.db.destroyPrivate(kid);
      }
      this.db.purgeEvents();
    } catch (e) {
      this.log.error(`Keystore: housekeeping failed: ${e.message}`);
    }
  }

  // ---- who ----

  /** The name a key's owner is shown by: "System", or the user's display name (never their login or email) */
  ownerName(row) {
    if (row.owner === SYSTEM) {
      return 'System';
    }
    const u = this.auth.initialized ? this.auth.user(Number(row.owner)) : null;
    return u ? (u.name || u.login) : `(account ${row.owner} deleted)`;
  }

  /** May this principal manage (label, revoke) this key? Its owner, or an administrator */
  canManage(p, row) {
    return Boolean(p && row && (p.isAdmin || (row.owner !== SYSTEM && row.owner === String(p.id))));
  }

  // ---- reading ----

  /**
   * The keys, newest first
   * @param {{owner?: string|number, status?: string, kty?: string, system?: boolean}} [filter]
   */
  list(filter = {}) {
    this.requireInitialized();
    let rows = filter.owner !== undefined && filter.owner !== null && filter.owner !== '' ? this.db.ofOwner(filter.owner) : this.db.all();
    if (filter.system) {
      rows = rows.filter(r => r.owner === SYSTEM);
    }
    if (filter.status && STATUSES.includes(filter.status)) {
      rows = rows.filter(r => r.status === filter.status);
    }
    if (filter.kty && keys.KEY_TYPES[filter.kty]) {
      rows = rows.filter(r => r.kty === filter.kty);
    }
    return rows;
  }

  key(kid) {
    this.requireInitialized();
    return this.db.byKid(kid);
  }

  keyById(id) {
    this.requireInitialized();
    return this.db.byId(id);
  }

  /**
   * The store's entry for a public key, whatever its id: a key that came with a signature (a
   * certificate in it, x5c) may still be one the store knows, and has revoked
   * @param {crypto.KeyObject|Buffer} key a public key, or its SPKI DER
   */
  keyForPublicKey(key) {
    this.requireInitialized();
    const spki = Buffer.isBuffer(key) ? key : key.export({ type: 'spki', format: 'der' });
    return this.db.byFingerprint(keys.fingerprint(spki));
  }

  events(row, limit = 100) {
    return this.db.events(row.key_id, limit);
  }

  /** The algorithm a key signs with: its own (an uploaded JWK's alg), else its type's */
  algOf(row) {
    return row.alg || keys.KEY_TYPES[row.kty].alg;
  }

  /** A key as a JWK, with what the store knows about it as extra members */
  jwk(row) {
    const j = { kid: row.key_id, ...keys.toJwk(row.spki), alg: this.algOf(row), use: 'sig' };
    j.status = row.status;
    if (row.expires) {
      j.expires = row.expires;
    }
    j.owner = row.owner === SYSTEM ? 'system' : this.ownerName(row);
    j.origin = row.origin;
    // the server holds the private key, and signs with it when a module asks
    j.signs = Boolean(row.has_private);
    j.created = row.created;
    j.fingerprint = row.fingerprint;
    return j;
  }

  jwks(filter = {}) {
    return { keys: this.list(filter).map(r => this.jwk(r)) };
  }

  pem(row) {
    return keys.toPem(row.spki);
  }

  // ---- limits ----

  /** How many more keys this principal may upload now (Infinity for an administrator) */
  uploadsLeft(p) {
    if (p.isAdmin) {
      return Infinity;
    }
    const total = this.db.countByActor(p.id, 'upload');
    const today = this.db.countByActor(p.id, 'upload', new Date(Date.now() - DAY_MS).toISOString());
    return Math.max(this.limits.uploadAllowance - total, this.limits.uploadsPerDay - today, 0);
  }

  /** '' when this principal may make a key pair of this type now (for themselves, or for the system), else why not */
  createProblem(p, kty, { system = false } = {}) {
    if (!keys.KEY_TYPES[kty]) {
      return `Unknown key type ${kty}`;
    }
    if (system && !p.isAdmin) {
      return 'Only administrators make the system\'s keys';
    }
    if (p.isAdmin) {
      return '';
    }
    const made = this.db.countCreates(String(p.id), kty, new Date(Date.now() - DAY_MS).toISOString());
    if (made >= this.limits.createsPerDay) {
      return `You have made a ${keys.KEY_TYPES[kty].label} key pair in the last 24 hours: you can make another tomorrow`;
    }
    return '';
  }

  // ---- what users do ----

  /**
   * Upload public keys, owned by the uploader. All or nothing
   * @param {Principal} p
   * @param {string|Buffer} input the upload (see keys.parseUpload)
   * @param {{kid?: string, label?: string}} [options] kid: the key id claimed (one key only)
   * @returns {Array<object>} the rows added
   */
  upload(p, input, { kid = '', label = '' } = {}) {
    this.requireInitialized();
    let found;
    try {
      found = keys.parseUpload(input);
    } catch (e) {
      if (e instanceof keys.KeyError) {
        this.refused(p, e.kind, e.message);
        throw new KeyStoreError(e.message, 400, e.kind);
      }
      throw e;
    }
    kid = String(kid || '').trim();
    if (kid && found.length > 1) {
      throw new KeyStoreError('A key id can be claimed only when uploading one key: in a JWKS, each key has its own "kid"');
    }
    const left = this.uploadsLeft(p);
    if (found.length > left) {
      this.refused(p, 'limit', `${found.length} keys, ${left} left`);
      throw new KeyStoreError(left === 0 ? 'You have uploaded as many keys as you can for now: you can upload another tomorrow' :
        `You can upload ${left} more key${left === 1 ? '' : 's'} for now, not ${found.length}`, 429, 'limit');
    }
    // check them all before adding any
    const ids = new Set();
    const rows = found.map(f => {
      const fp = keys.fingerprint(f.spki);
      const have = this.db.byFingerprint(fp);
      if (have) {
        this.refused(p, 'duplicate', fp);
        throw new KeyStoreError(`That key is already in the store, as ${have.key_id} (${have.origin} by ${this.ownerName(have)})`, 409, 'duplicate');
      }
      const claim = kid || f.kid;
      if (claim) {
        const problem = keys.kidProblem(claim, f.spki);
        if (problem) {
          throw new KeyStoreError(`${problem} ("${claim.substring(0, 50)}")`);
        }
      }
      const keyId = claim || fp;
      if (this.db.byKid(keyId) || ids.has(keyId)) {
        this.refused(p, 'duplicate', keyId);
        throw new KeyStoreError(`The key id "${keyId}" is already taken: claim another (or none, and the store makes one from the key)`, 409, 'duplicate');
      }
      ids.add(keyId);
      return {
        key_id: keyId, claimed: Boolean(claim) && claim !== fp, fingerprint: fp, kty: f.kty, bits: f.bits, alg: f.alg,
        spki: f.spki, source_format: f.sourceFormat, source: f.source, origin: 'uploaded', owner: String(p.id), actor: p.id,
        label: String(label || f.label || '').trim().substring(0, LABEL_MAX)
      };
    });
    const added = [];
    try {
      this.db.db.transaction(() => {
        for (const r of rows) {
          added.push(this.db.add(r));
          this.db.event('upload', { keyId: r.key_id, kty: r.kty, owner: r.owner, actor: p.id, detail: r.source_format });
        }
      })();
    } catch (e) {
      // another process added the same key or id since the checks above
      throw uniqueClash(e, 'That key, or its key id, was added to the store just now');
    }
    for (const r of added) {
      this.log.info(`Keystore: ${p.login} uploaded ${r.kty} key ${r.key_id}`);
    }
    return added;
  }

  refused(p, kind, detail) {
    this.db.event('refused', { actor: p ? p.id : null, owner: p ? String(p.id) : null, operation: kind, detail: String(detail || '').substring(0, 200) });
  }

  /**
   * Make a key pair: the user's own, or (an administrator) the system's. A key pair the owner
   * already has of this type is retired, and its private key destroyed
   * @returns {object} the new row
   */
  create(p, kty, { system = false, label = '' } = {}) {
    this.requireInitialized();
    const problem = this.createProblem(p, kty, { system });
    if (problem) {
      throw new KeyStoreError(problem, keys.KEY_TYPES[kty] ? (system ? 403 : 429) : 400, 'limit');
    }
    const owner = system ? SYSTEM : String(p.id);
    const k = keys.generate(kty, { rsaBits: this.rsaBits });
    const fp = keys.fingerprint(k.spki);
    let row;
    let old = null;
    try {
      this.db.db.transaction(() => {
        old = this.db.activeCreated(owner, kty);
        if (old) {
          this.db.retire(old.id, { by: p.id, reason: 'replaced by a new key pair' });
          this.db.event('retire', { keyId: old.key_id, kty, owner, actor: p.id });
        }
        row = this.db.add({
          key_id: fp, fingerprint: fp, kty, bits: k.bits, spki: k.spki, source_format: 'created', origin: 'created',
          owner, actor: p.id, label: String(label || '').trim().substring(0, LABEL_MAX)
        }, k.pkcs8);
        this.db.event('create', { keyId: fp, kty, owner, actor: p.id });
      })();
    } catch (e) {
      // another process made one for the same owner and type just now
      throw uniqueClash(e, 'A key pair of that type was made just now: try again');
    }
    // the old private key goes once the new key is in place (a separate database, outside the
    // transaction: if this were rolled back, the old key would still be usable)
    if (old) {
      this.db.destroyPrivate(old.key_id);
    }
    this.log.info(`Keystore: ${p.login} made ${system ? 'the system\'s' : 'their'} ${kty} key ${fp}`);
    return row;
  }

  /**
   * Revoke a key: its owner, or an administrator. It stays listed, revoked, with an expiry (now,
   * or the time given: when it stopped being trustworthy) and a reason; any private key goes
   */
  revoke(p, id, { reason = '', expires = '' } = {}) {
    this.requireInitialized();
    const row = this.db.byId(id);
    if (!row) {
      throw new KeyStoreError('No such key', 404);
    }
    if (!this.canManage(p, row)) {
      throw new KeyStoreError('You can revoke only your own keys', 403);
    }
    if (row.status === 'revoked') {
      throw new KeyStoreError('That key is already revoked', 409);
    }
    let when = new Date();
    if (expires) {
      // a time with no zone (the form's datetime-local) is UTC
      when = new Date(/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(expires) ? expires + 'Z' : expires);
      if (isNaN(when.getTime())) {
        throw new KeyStoreError('The expiry is not a date and time');
      }
    }
    const r = this.db.setStatus(row.id, 'revoked', { by: p.id, reason: String(reason || '').trim().substring(0, REASON_MAX) || null, expires: when.toISOString() });
    this.db.event('revoke', { keyId: row.key_id, kty: row.kty, owner: row.owner, actor: p.id, detail: r.reason });
    this.log.info(`Keystore: ${p.login} revoked key ${row.key_id}`);
    return r;
  }

  /** Delete a key altogether (administrators): signatures made with it can't be checked here any more */
  remove(p, id) {
    this.requireInitialized();
    if (!p.isAdmin) {
      throw new KeyStoreError('Only administrators delete keys', 403);
    }
    const row = this.db.remove(id);
    if (!row) {
      throw new KeyStoreError('No such key', 404);
    }
    this.db.event('delete', { keyId: row.key_id, kty: row.kty, owner: row.owner, actor: p.id });
    this.log.info(`Keystore: ${p.login} deleted key ${row.key_id}`);
    return row;
  }

  /** Change a key's id (administrators: two people claiming the same id); '' gives it its fingerprint */
  setKid(p, id, kid) {
    this.requireInitialized();
    if (!p.isAdmin) {
      throw new KeyStoreError('Only administrators change key ids', 403);
    }
    const row = this.db.byId(id);
    if (!row) {
      throw new KeyStoreError('No such key', 404);
    }
    kid = String(kid || '').trim() || row.fingerprint;
    const problem = keys.kidProblem(kid, row.spki);
    if (problem) {
      throw new KeyStoreError(problem);
    }
    if (kid === row.key_id) {
      return row;
    }
    const other = this.db.byKid(kid);
    if (other) {
      throw new KeyStoreError(`The key id "${kid}" is taken by another key: change that one first`, 409);
    }
    this.db.setKid(row.id, kid, kid !== row.fingerprint);
    this.db.event('rename', { keyId: kid, kty: row.kty, owner: row.owner, actor: p.id, detail: `was ${row.key_id}` });
    this.log.info(`Keystore: ${p.login} changed key id ${row.key_id} to ${kid}`);
    return this.db.byId(row.id);
  }

  setLabel(p, id, label) {
    this.requireInitialized();
    const row = this.db.byId(id);
    if (!row) {
      throw new KeyStoreError('No such key', 404);
    }
    if (!this.canManage(p, row)) {
      throw new KeyStoreError('You can label only your own keys', 403);
    }
    this.db.setLabel(row.id, String(label || '').trim().substring(0, LABEL_MAX));
    return this.db.byId(row.id);
  }

  // ---- for modules: signing and checking ----

  /**
   * The key a module signs with for an owner: their active key pair of the type (or of the first
   * type they have, SIGNING_PREFERENCE), or null
   * @param {number|string} owner a user id, or SYSTEM
   */
  signingKey(owner, kty) {
    this.requireInitialized();
    const o = String(owner);
    for (const t of kty ? [kty] : SIGNING_PREFERENCE) {
      const k = this.db.activeCreated(o, t);
      if (k && k.has_private) {
        return k;
      }
    }
    return null;
  }

  /**
   * Sign bytes a module has made for one of its operations, with the owner's key. There is no
   * HTTP endpoint for this: each module builds its own payload (a user's key can't be made to
   * sign any statement someone chooses). Every use is logged
   * @param {object} args
   * @param {number|string} args.owner a user id, or keystore.SYSTEM
   * @param {string} args.purpose the module and operation ("ips:sign-document"), for the log
   * @param {Buffer|string} args.payload
   * @param {string} [args.kty] the key type (default: the first the owner has, SIGNING_PREFERENCE)
   * @param {string} [args.alg] the JOSE algorithm (default: the key's)
   * @param {number} [args.actor] the user who asked (default: the owner)
   * @returns {{keyId: string, alg: string, signature: Buffer, kty: string}}
   */
  sign({ owner, purpose, payload, kty, alg, actor }) {
    this.requireInitialized();
    if (typeof purpose !== 'string' || !purpose) {
      throw new KeyStoreError('A signature needs a purpose (module:operation)');
    }
    const o = owner === SYSTEM ? SYSTEM : String(owner);
    if (o !== SYSTEM) {
      // a disabled (or deleted) account's keys sign nothing
      if (!this.auth.initialized || !this.auth.principalById(Number(o))) {
        throw new KeyStoreError('That account can\'t sign: it is disabled or gone', 403);
      }
    }
    const row = this.signingKey(o, kty);
    if (!row) {
      throw new KeyStoreError(`${o === SYSTEM ? 'The system has' : 'That account has'} no ${kty ? keys.KEY_TYPES[kty]?.label || kty : ''} key pair to sign with`.replace(/\s+/g, ' '), 409);
    }
    const a = alg || this.algOf(row);
    if (!keys.ALGS[row.kty].includes(a)) {
      throw new KeyStoreError(`A ${keys.KEY_TYPES[row.kty].label} key can't sign ${a}`);
    }
    const pkcs8 = this.db.privateKey(row.key_id);
    if (!pkcs8) {
      throw new KeyStoreError('The private key is missing', 500);
    }
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const signature = keys.joseSign(a, pkcs8, data);
    this.db.event('sign', {
      keyId: row.key_id, kty: row.kty, owner: o, actor: actor ?? (o === SYSTEM ? null : Number(o)), operation: purpose,
      detail: crypto.createHash('sha256').update(data).digest('base64')
    });
    return { keyId: row.key_id, alg: a, signature, kty: row.kty };
  }

  /**
   * The private key of an owner's key pair, for a module whose own code signs with it (the IPS
   * module's signatures.js, which needs the key itself to sign as the FHIR signature formats
   * want). The key never leaves the server. Refused, as sign() is, for an account that is
   * disabled or gone. Every load is logged, with the purpose
   * @param {object} args
   * @param {number|string} args.owner a user id, or keystore.SYSTEM
   * @param {string[]} [args.types] the key types the module can use, best first (default SIGNING_PREFERENCE)
   * @param {string} args.purpose the module and operation ("ips:sign-document"), for the log
   * @param {number} [args.actor] the user who asked
   * @returns {{row: object, privateKey: crypto.KeyObject}|null} null: the owner has no key pair of those types
   */
  loadPrivateKey({ owner, types, purpose, actor }) {
    this.requireInitialized();
    if (typeof purpose !== 'string' || !purpose) {
      throw new KeyStoreError('Loading a private key needs a purpose (module:operation)');
    }
    const o = owner === SYSTEM ? SYSTEM : String(owner);
    if (o !== SYSTEM && (!this.auth.initialized || !this.auth.principalById(Number(o)))) {
      throw new KeyStoreError('That account can\'t sign: it is disabled or gone', 403);
    }
    const row = this.usableKey(o, types);
    if (!row) {
      return null;
    }
    const pkcs8 = this.db.privateKey(row.key_id);
    if (!pkcs8) {
      throw new KeyStoreError('The private key is missing', 500);
    }
    this.db.event('load', { keyId: row.key_id, kty: row.kty, owner: o, actor: actor ?? (o === SYSTEM ? null : Number(o)), operation: purpose });
    return { row, privateKey: crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }) };
  }

  /** The owner's active key pair of the first of these types they have, or null (nothing is logged) */
  usableKey(owner, types) {
    this.requireInitialized();
    const o = owner === SYSTEM ? SYSTEM : String(owner);
    for (const t of Array.isArray(types) && types.length ? types : SIGNING_PREFERENCE) {
      const k = keys.KEY_TYPES[t] ? this.db.activeCreated(o, t) : null;
      if (k && k.has_private) {
        return k;
      }
    }
    return null;
  }

  /**
   * A JWS (compact serialization) over a payload, with the owner's key: the header gets alg and
   * kid. detached: the payload part is left empty (RFC 7515 appendix F), as FHIR signatures are
   * @returns {string}
   */
  signJws({ owner, purpose, payload, header = {}, detached = true, kty, alg, actor }) {
    const row = this.signingKey(owner === SYSTEM ? SYSTEM : String(owner), kty);
    const a = alg || (row ? this.algOf(row) : undefined);
    const h = Buffer.from(JSON.stringify({ ...header, alg: a, kid: row ? row.key_id : undefined })).toString('base64url');
    const p = (Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')).toString('base64url');
    const s = this.sign({ owner, purpose, payload: `${h}.${p}`, kty: row ? row.kty : kty, alg: a, actor });
    return `${h}.${detached ? '' : p}.${s.signature.toString('base64url')}`;
  }

  /**
   * Check a signature with a key in the store, by its id. What the result says about who
   * signed goes no further than the store: "a key uploaded/created by X"
   * @param {{kid: string, alg: string, data: Buffer|string, signature: Buffer, at?: string|Date}} args
   *   at: when the signature was made (a trusted time, when there is one), checked against a
   *   revoked key's expiry
   * @returns {{ok: boolean, key: object|null, owner: string|null, problem: string}}
   */
  verify({ kid, alg, data, signature, at }) {
    this.requireInitialized();
    const row = this.db.byKid(kid);
    if (!row) {
      return { ok: false, key: null, owner: null, problem: `No key ${kid} in the store` };
    }
    const owner = this.ownerName(row);
    if (!keys.ALGS[row.kty].includes(alg)) {
      return { ok: false, key: row, owner, problem: `The key is ${keys.KEY_TYPES[row.kty].label}, which doesn't sign ${alg}` };
    }
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    if (!keys.joseVerify(alg, row.spki, bytes, signature)) {
      return { ok: false, key: row, owner, problem: 'The signature does not verify with the key' };
    }
    if (row.status === 'revoked') {
      const t = at ? new Date(at) : new Date();
      if (isNaN(t.getTime()) || t.toISOString() >= row.expires) {
        return { ok: false, key: row, owner, problem: `The key was revoked (from ${row.expires})${row.reason ? `: ${row.reason}` : ''}` };
      }
    }
    return { ok: true, key: row, owner, problem: '' };
  }

  /**
   * Check a compact JWS (detached, or not): the header's kid names the key
   * @param {string} jws
   * @param {Buffer|string} [payload] the detached payload
   */
  verifyJws(jws, payload, { at } = {}) {
    const parts = String(jws).split('.');
    if (parts.length !== 3) {
      return { ok: false, key: null, owner: null, problem: 'That is not a compact JWS' };
    }
    let header;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    } catch {
      return { ok: false, key: null, owner: null, problem: 'The JWS header is not JSON' };
    }
    if (typeof header.kid !== 'string' || typeof header.alg !== 'string') {
      return { ok: false, key: null, owner: null, problem: 'The JWS header has no kid or alg' };
    }
    const p = parts[1] || (payload === undefined ? '' : (Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')).toString('base64url'));
    return this.verify({ kid: header.kid, alg: header.alg, data: `${parts[0]}.${p}`, signature: Buffer.from(parts[2], 'base64url'), at });
  }

  // ---- the daily report ----

  /**
   * The paragraph for the daily report (library/daily-report.js), when there are any keys or
   * anything happened: the keys, and in the period, what was uploaded, made, retired, revoked,
   * deleted and refused, and what was signed
   */
  dailyReport({ since, now }) {
    if (!this.initialized) {
      return '';
    }
    const { plural } = require('../daily-report');
    const counts = this.db.counts();
    const events = this.db.eventsBetween(new Date(since).toISOString(), new Date(now).toISOString());
    const total = counts.reduce((n, c) => n + c.n, 0);
    if (total === 0 && events.length === 0) {
      return '';
    }
    const sum = (f) => counts.filter(f).reduce((n, c) => n + c.n, 0);
    const n = (kind) => events.filter(e => e.kind === kind).reduce((t, e) => t + e.n, 0);
    const sentences = [];
    const byStatus = STATUSES.map(s => [s, sum(c => c.status === s)]).filter(([, v]) => v > 0).map(([s, v]) => `${v} ${s}`);
    const system = sum(c => c.system && c.status === 'active');
    sentences.push(`Key store: ${plural(total, 'key')}${byStatus.length ? ` (${byStatus.join(', ')})` : ''}` +
      `${system ? `, ${plural(system, 'active system key')}` : ''}.`);
    const done = [['upload', 'uploaded'], ['create', 'made'], ['retire', 'retired'], ['revoke', 'revoked'], ['delete', 'deleted'], ['rename', 'given a new id'], ['destroy', 'private keys destroyed with their account']]
      .map(([k, w]) => [n(k), w]).filter(([v]) => v > 0).map(([v, w]) => `${v} ${w}`);
    sentences.push(done.length ? `In the period: ${done.join(', ')}.` : 'No keys uploaded, made, revoked or deleted in the period.');
    const refused = events.filter(e => e.kind === 'refused');
    if (refused.length) {
      const by = {};
      for (const e of refused) {
        by[e.operation || 'invalid'] = (by[e.operation || 'invalid'] || 0) + e.n;
      }
      const words = { private: 'private keys', duplicate: 'already there', limit: 'over the limit', unsupported: 'unsupported', invalid: 'unreadable' };
      sentences.push(`${plural(n('refused'), 'upload')} refused (${Object.entries(by).map(([k, v]) => `${v} ${words[k] || k}`).join(', ')}).`);
    }
    const signs = events.filter(e => e.kind === 'sign');
    if (signs.length) {
      const by = {};
      for (const e of signs) {
        by[e.operation] = (by[e.operation] || 0) + e.n;
      }
      sentences.push(`${plural(n('sign'), 'signature')} made (${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ')}).`);
    }
    const loads = events.filter(e => e.kind === 'load');
    if (loads.length) {
      const by = {};
      for (const e of loads) {
        by[e.operation] = (by[e.operation] || 0) + e.n;
      }
      sentences.push(`Private keys loaded to sign with ${n('load')} time${n('load') === 1 ? '' : 's'} (${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ')}).`);
    }
    return sentences.join(' ');
  }

  router() {
    this.requireInitialized();
    return require('./pages').buildRouter(this);
  }
}

module.exports = { KeyStore, KeyStoreError, SYSTEM, SIGNING_PREFERENCE };
