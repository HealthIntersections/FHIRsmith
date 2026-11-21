// library/keystore/store.js
// The key store's two SQLite databases (better-sqlite3, synchronous; shared by every process
// under the launcher, as the auth database is):
//
//  - keystore.db: the public keys, who has them, their status, and the log of what happened to
//    them. Nothing in it is secret: copying, backing up or debugging it never moves a private key
//  - keystore-private.db: the private keys and nothing else, key_id -> PKCS#8 DER. Made 0600
//    (SQLite makes its journal and WAL files with the database file's permissions), with
//    secure_delete on, so a destroyed key is overwritten, not left in a free page
//
// Owners are user ids of the login system (library/auth), or SYSTEM for the server's own keys.

const fs = require('fs');
const Database = require('better-sqlite3');

const SYSTEM = '#system';
const DAY_MS = 24 * 60 * 60 * 1000;
// how long the log of key events is kept (the keys themselves are kept for ever)
const EVENT_DAYS = 400;

function now() {
  return new Date().toISOString();
}

function openDb(dbPath, { secret = false } = {}) {
  if (secret && dbPath !== ':memory:') {
    // made (or tightened) before SQLite opens it, so the journal files get the same mode
    fs.closeSync(fs.openSync(dbPath, 'a', 0o600));
    fs.chmodSync(dbPath, 0o600);
  }
  const db = new Database(dbPath);
  if (dbPath !== ':memory:') {
    db.pragma('busy_timeout = 5000');
    // the private keys: a rollback journal, not a WAL - a WAL keeps old pages (a destroyed key)
    // until it is checkpointed and reused, where secure_delete doesn't reach
    db.pragma(secret ? 'journal_mode = DELETE' : 'journal_mode = WAL');
  }
  if (secret) {
    db.pragma('secure_delete = ON');
  }
  return db;
}

class KeyStoreDb {
  /**
   * @param {string} dbPath keystore.db (or ':memory:')
   * @param {string} privatePath keystore-private.db (or ':memory:')
   */
  constructor(dbPath, privatePath) {
    this.db = openDb(dbPath);
    this.secrets = openDb(privatePath, { secret: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS keys (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id         TEXT NOT NULL UNIQUE,
        claimed        INTEGER NOT NULL DEFAULT 0,
        fingerprint    TEXT NOT NULL UNIQUE,
        kty            TEXT NOT NULL,
        bits           INTEGER,
        alg            TEXT,
        spki           BLOB NOT NULL,
        source_format  TEXT NOT NULL,
        source         TEXT,
        origin         TEXT NOT NULL,
        owner          TEXT NOT NULL,
        actor          INTEGER,
        created        TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'active',
        status_changed TEXT,
        status_by      INTEGER,
        reason         TEXT,
        expires        TEXT,
        has_private    INTEGER NOT NULL DEFAULT 0,
        label          TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS keys_owner ON keys(owner);
      -- one active key pair the server holds per owner per key type
      CREATE UNIQUE INDEX IF NOT EXISTS keys_one_active ON keys(owner, kty) WHERE origin = 'created' AND status = 'active';
      -- what happened: uploads, creates, retires, revokes, deletes, key id changes, refused
      -- uploads and every use of a private key. key_id is text, not a reference: the event stays
      -- when the key is deleted
      CREATE TABLE IF NOT EXISTS key_events (
        at        TEXT NOT NULL,
        kind      TEXT NOT NULL,
        key_id    TEXT,
        kty       TEXT,
        owner     TEXT,
        actor     INTEGER,
        operation TEXT,
        detail    TEXT
      );
      CREATE INDEX IF NOT EXISTS key_events_at ON key_events(at);
      CREATE INDEX IF NOT EXISTS key_events_actor ON key_events(actor, kind, at);
    `);
    this.secrets.exec(`
      CREATE TABLE IF NOT EXISTS private_keys (
        key_id  TEXT PRIMARY KEY,
        pkcs8   BLOB NOT NULL,
        created TEXT NOT NULL
      );
    `);
    const p = sql => this.db.prepare(sql);
    this.stmts = {
      byId: p('SELECT * FROM keys WHERE id = ?'),
      byKid: p('SELECT * FROM keys WHERE key_id = ?'),
      byFingerprint: p('SELECT * FROM keys WHERE fingerprint = ?'),
      all: p('SELECT * FROM keys ORDER BY created DESC, id DESC'),
      ofOwner: p('SELECT * FROM keys WHERE owner = ? ORDER BY created DESC, id DESC'),
      activeCreated: p("SELECT * FROM keys WHERE owner = ? AND kty = ? AND origin = 'created' AND status = 'active'"),
      insert: p(`INSERT INTO keys (key_id, claimed, fingerprint, kty, bits, alg, spki, source_format, source, origin, owner, actor, created, has_private, label)
        VALUES (@key_id, @claimed, @fingerprint, @kty, @bits, @alg, @spki, @source_format, @source, @origin, @owner, @actor, @created, @has_private, @label)`),
      setStatus: p('UPDATE keys SET status = ?, status_changed = ?, status_by = ?, reason = ?, expires = ?, has_private = 0 WHERE id = ?'),
      setLabel: p('UPDATE keys SET label = ? WHERE id = ?'),
      setKid: p('UPDATE keys SET key_id = ?, claimed = ? WHERE id = ?'),
      noPrivate: p('UPDATE keys SET has_private = 0 WHERE key_id = ?'),
      remove: p('DELETE FROM keys WHERE id = ?'),
      event: p('INSERT INTO key_events (at, kind, key_id, kty, owner, actor, operation, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      eventsOf: p('SELECT * FROM key_events WHERE key_id = ? ORDER BY at DESC LIMIT ?'),
      countByActor: p('SELECT COUNT(*) AS n FROM key_events WHERE actor = ? AND kind = ? AND at >= ?'),
      countCreates: p("SELECT COUNT(*) AS n FROM key_events WHERE owner = ? AND kty = ? AND kind = 'create' AND at >= ?"),
      eventsSince: p('SELECT kind, operation, detail, COUNT(*) AS n FROM key_events WHERE at >= ? AND at < ? GROUP BY kind, operation, detail'),
      purgeEvents: p('DELETE FROM key_events WHERE at < ?'),
      counts: p('SELECT status, origin, owner = ? AS system, COUNT(*) AS n FROM keys GROUP BY status, origin, owner = ?'),
      privateOwners: p('SELECT DISTINCT owner FROM keys WHERE has_private = 1 AND owner != ?')
    };
    const s = sql => this.secrets.prepare(sql);
    this.secretStmts = {
      put: s('INSERT INTO private_keys (key_id, pkcs8, created) VALUES (?, ?, ?)'),
      get: s('SELECT pkcs8 FROM private_keys WHERE key_id = ?'),
      remove: s('DELETE FROM private_keys WHERE key_id = ?'),
      rename: s('UPDATE private_keys SET key_id = ? WHERE key_id = ?'),
      olderThan: s('SELECT key_id FROM private_keys WHERE created < ?')
    };
  }

  close() {
    this.db.close();
    this.secrets.close();
  }

  // ---- reading ----

  byId(id) {
    return this.stmts.byId.get(id) || null;
  }

  byKid(kid) {
    return this.stmts.byKid.get(kid) || null;
  }

  byFingerprint(fp) {
    return this.stmts.byFingerprint.get(fp) || null;
  }

  all() {
    return this.stmts.all.all();
  }

  ofOwner(owner) {
    return this.stmts.ofOwner.all(String(owner));
  }

  activeCreated(owner, kty) {
    return this.stmts.activeCreated.get(String(owner), kty) || null;
  }

  privateKey(kid) {
    const r = this.secretStmts.get.get(kid);
    return r ? r.pkcs8 : null;
  }

  events(kid, limit = 100) {
    return this.stmts.eventsOf.all(kid, limit);
  }

  // ---- writing ----

  event(kind, { keyId = null, kty = null, owner = null, actor = null, operation = null, detail = null } = {}) {
    this.stmts.event.run(now(), kind, keyId, kty, owner === null ? null : String(owner), actor, operation, detail);
  }

  /**
   * Add a key (and its private key, for a key the server made). Throws on a duplicate key or id
   * @returns {object} the row
   */
  add(row, pkcs8 = null) {
    const at = now();
    const r = {
      claimed: 0, bits: null, alg: null, source: null, actor: null, label: '', ...row,
      owner: String(row.owner), created: at, has_private: pkcs8 ? 1 : 0
    };
    r.claimed = r.claimed ? 1 : 0;
    // the private key first: a crash between the two leaves a private key with no public one
    // (harmless, and tidied), never a public key that says it has a private one it hasn't
    if (pkcs8) {
      this.secretStmts.put.run(r.key_id, pkcs8, at);
    }
    try {
      const id = this.stmts.insert.run(r).lastInsertRowid;
      return this.byId(id);
    } catch (e) {
      if (pkcs8) {
        this.secretStmts.remove.run(r.key_id);
      }
      throw e;
    }
  }

  /** retired or revoked: the private key goes */
  setStatus(id, status, { by = null, reason = null, expires = null } = {}) {
    const k = this.byId(id);
    if (!k) {
      return null;
    }
    this.destroyPrivate(k.key_id);
    this.stmts.setStatus.run(status, now(), by, reason, expires, id);
    return this.byId(id);
  }

  /** retired, in a transaction on this database: the caller destroys the private key after it */
  retire(id, { by = null, reason = null } = {}) {
    this.stmts.setStatus.run('retired', now(), by, reason, null, id);
  }

  destroyPrivate(kid) {
    this.secretStmts.remove.run(kid);
    this.stmts.noPrivate.run(kid);
  }

  setLabel(id, label) {
    this.stmts.setLabel.run(label, id);
  }

  /** a new key id (the administrator's): the private key, if any, moves with it */
  setKid(id, kid, claimed) {
    const k = this.byId(id);
    this.stmts.setKid.run(kid, claimed ? 1 : 0, id);
    if (k.has_private) {
      this.secretStmts.rename.run(kid, k.key_id);
    }
  }

  remove(id) {
    const k = this.byId(id);
    if (k) {
      this.destroyPrivate(k.key_id);
      this.stmts.remove.run(id);
    }
    return k;
  }

  // ---- counting ----

  /** events of a kind by an actor since a time */
  countByActor(actor, kind, sinceIso = '') {
    return this.stmts.countByActor.get(actor, kind, sinceIso).n;
  }

  /** key pairs made for an owner of a type since a time */
  countCreates(owner, kty, sinceIso) {
    return this.stmts.countCreates.get(String(owner), kty, sinceIso).n;
  }

  eventsBetween(since, until) {
    return this.stmts.eventsSince.all(since, until);
  }

  counts() {
    return this.stmts.counts.all(SYSTEM, SYSTEM);
  }

  /** the user owners of private keys (for tidying the keys of deleted users) */
  privateOwners() {
    return this.stmts.privateOwners.all(SYSTEM).map(r => r.owner);
  }

  /**
   * private keys with no public key that says it has one (a crash between the two writes). Only
   * ones more than an hour old: under the launcher, another process may be between the two now
   */
  orphanPrivateKeys() {
    return this.secretStmts.olderThan.all(new Date(Date.now() - 60 * 60 * 1000).toISOString()).map(r => r.key_id).filter(kid => {
      const k = this.byKid(kid);
      return !k || !k.has_private;
    });
  }

  purgeEvents() {
    this.stmts.purgeEvents.run(new Date(Date.now() - EVENT_DAYS * DAY_MS).toISOString());
  }
}

module.exports = { KeyStoreDb, SYSTEM, DAY_MS };
