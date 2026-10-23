// registry/auth-store.js
// The registry's users and their API tokens, in SQLite (better-sqlite3: synchronous, like
// stats-db.js). A token is stored only as its SHA-256 hash: tokens are 256 bits of
// randomness, so a fast hash is enough to make the stored form useless to a thief, and a
// lookup by hash is one indexed read per request. Usage is counted per principal - a
// user's token, the configured API token, or an OIDC client - and flushed in batches.

const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

const TOKEN_PREFIX = 'txr_';

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Make a new token: txr_ + 32 random bytes, base64url. The first 12 characters are kept
 * in clear as the token's name on the pages
 */
function makeToken() {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { token, prefix: token.substring(0, 12), hash: hashToken(token) };
}

class AuthStore {
  /**
   * @param {string} dbPath file path, or ':memory:'
   */
  constructor(dbPath) {
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        password_hash TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        prefix TEXT NOT NULL,
        hash TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);
      CREATE TABLE IF NOT EXISTS usage (
        principal TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL,
        public INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS document_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        public INTEGER NOT NULL,
        content TEXT NOT NULL,
        at TEXT NOT NULL,
        by TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS document_log_doc ON document_log(doc_id);
    `);
    // added after the first release of the table
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'admin'").get()) {
      this.db.exec('ALTER TABLE users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0');
    }
    this.db.pragma('foreign_keys = ON');
    this.pending = new Map(); // principal -> { kind, count, last }
    this.stmts = {
      userByLogin: this.db.prepare('SELECT * FROM users WHERE login = ?'),
      userById: this.db.prepare('SELECT * FROM users WHERE id = ?'),
      users: this.db.prepare('SELECT * FROM users ORDER BY login'),
      insertUser: this.db.prepare('INSERT INTO users (login, name, password_hash, enabled, notes, admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      updateUser: this.db.prepare('UPDATE users SET name = ?, enabled = ?, notes = ?, admin = ? WHERE id = ?'),
      setPassword: this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
      deleteUser: this.db.prepare('DELETE FROM users WHERE id = ?'),
      tokenByHash: this.db.prepare('SELECT t.*, u.login, u.enabled AS user_enabled FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.hash = ?'),
      tokensForUser: this.db.prepare('SELECT * FROM tokens WHERE user_id = ? ORDER BY created_at DESC'),
      tokenById: this.db.prepare('SELECT * FROM tokens WHERE id = ?'),
      insertToken: this.db.prepare('INSERT INTO tokens (user_id, prefix, hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
      revokeToken: this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL'),
      usage: this.db.prepare('SELECT * FROM usage WHERE principal = ?'),
      allUsage: this.db.prepare('SELECT * FROM usage ORDER BY last_seen DESC'),
      upsertUsage: this.db.prepare(`INSERT INTO usage (principal, kind, requests, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(principal) DO UPDATE SET requests = requests + excluded.requests, last_seen = excluded.last_seen`),
      documents: this.db.prepare('SELECT id, name, type, public, updated_at, updated_by, length(content) AS size FROM documents ORDER BY name'),
      documentByName: this.db.prepare('SELECT * FROM documents WHERE name = ?'),
      documentById: this.db.prepare('SELECT * FROM documents WHERE id = ?'),
      insertDocument: this.db.prepare('INSERT INTO documents (name, type, public, content, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)'),
      updateDocument: this.db.prepare('UPDATE documents SET name = ?, type = ?, public = ?, content = ?, updated_at = ?, updated_by = ? WHERE id = ?'),
      deleteDocument: this.db.prepare('DELETE FROM documents WHERE id = ?'),
      logDocument: this.db.prepare('INSERT INTO document_log (doc_id, action, name, type, public, content, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      documentLog: this.db.prepare('SELECT id, action, name, type, public, at, by, length(content) AS size FROM document_log WHERE doc_id = ? ORDER BY id DESC'),
      documentLogEntry: this.db.prepare('SELECT * FROM document_log WHERE id = ? AND doc_id = ?')
    };
  }

  // ---- users ----

  users() {
    return this.stmts.users.all().map(u => this._user(u));
  }

  userById(id) {
    const u = this.stmts.userById.get(id);
    return u ? this._user(u) : null;
  }

  userByLogin(login) {
    const u = this.stmts.userByLogin.get(login);
    return u ? this._user(u) : null;
  }

  _user(row) {
    return { ...row, enabled: !!row.enabled, admin: !!row.admin, hasPassword: !!row.password_hash };
  }

  /**
   * @returns {number} the new user's id
   * @throws if the login is taken
   */
  async createUser({ login, name = '', password = null, notes = '', enabled = true, admin = false }) {
    const hash = password ? await bcrypt.hash(password, 10) : null;
    const r = this.stmts.insertUser.run(login, name, hash, enabled ? 1 : 0, notes, admin ? 1 : 0, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  updateUser(id, { name, enabled, notes, admin }) {
    const u = this.stmts.userById.get(id);
    if (!u) {
      return false;
    }
    this.stmts.updateUser.run(name ?? u.name, (enabled ?? !!u.enabled) ? 1 : 0, notes ?? u.notes, (admin ?? !!u.admin) ? 1 : 0, id);
    return true;
  }

  async setPassword(id, password) {
    const hash = password ? await bcrypt.hash(password, 10) : null;
    return this.stmts.setPassword.run(hash, id).changes > 0;
  }

  async checkPassword(user, password) {
    if (!user || !user.password_hash) {
      return false;
    }
    return bcrypt.compare(password, user.password_hash);
  }

  deleteUser(id) {
    return this.stmts.deleteUser.run(id).changes > 0;
  }

  // ---- tokens ----

  /**
   * Issue a token for a user. The clear token is returned once, here, and never stored
   * @param {number} userId
   * @param {object} [options]
   * @param {string} [options.label]
   * @param {number} [options.expiresInDays]
   * @returns {{id: number, token: string, prefix: string}}
   */
  issueToken(userId, { label = '', expiresInDays = null } = {}) {
    const t = makeToken();
    const now = Date.now();
    const expires = expiresInDays && expiresInDays > 0 ? new Date(now + expiresInDays * 24 * 60 * 60 * 1000).toISOString() : null;
    const r = this.stmts.insertToken.run(userId, t.prefix, t.hash, label, new Date(now).toISOString(), expires);
    return { id: Number(r.lastInsertRowid), token: t.token, prefix: t.prefix };
  }

  tokensForUser(userId) {
    const now = Date.now();
    return this.stmts.tokensForUser.all(userId).map(t => ({
      ...t,
      status: t.revoked_at ? 'revoked' : (t.expires_at && new Date(t.expires_at).getTime() < now ? 'expired' : 'active'),
      usage: this.usageOf(`token:${t.id}`)
    }));
  }

  revokeToken(userId, tokenId) {
    return this.stmts.revokeToken.run(new Date().toISOString(), tokenId, userId).changes > 0;
  }

  /**
   * The user behind a presented token, if it is a live token of an enabled user
   * @returns {{userId: number, login: string, tokenId: number}|null}
   */
  authenticateToken(token, now = Date.now()) {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) {
      return null;
    }
    const t = this.stmts.tokenByHash.get(hashToken(token));
    if (!t || t.revoked_at || !t.user_enabled) {
      return null;
    }
    if (t.expires_at && new Date(t.expires_at).getTime() < now) {
      return null;
    }
    return { userId: t.user_id, login: t.login, tokenId: t.id };
  }

  // ---- usage ----

  /**
   * Count a request by a principal. Counts are kept in memory and written by flush()
   * @param {string} principal e.g. token:12, api-token, oidc:{iss}|{sub}
   * @param {string} kind token | api-token | oidc
   */
  countRequest(principal, kind, now = Date.now()) {
    const p = this.pending.get(principal);
    if (p) {
      p.count++;
      p.last = now;
    } else {
      this.pending.set(principal, { kind, count: 1, last: now });
    }
  }

  flush() {
    if (this.pending.size === 0) {
      return 0;
    }
    const entries = [...this.pending.entries()];
    this.pending.clear();
    const write = this.db.transaction(() => {
      for (const [principal, p] of entries) {
        const at = new Date(p.last).toISOString();
        this.stmts.upsertUsage.run(principal, p.kind, p.count, at, at);
      }
    });
    write();
    return entries.length;
  }

  usageOf(principal) {
    const row = this.stmts.usage.get(principal);
    const p = this.pending.get(principal);
    if (!row && !p) {
      return null;
    }
    return {
      requests: (row ? row.requests : 0) + (p ? p.count : 0),
      firstSeen: row ? row.first_seen : new Date(p.last).toISOString(),
      lastSeen: p ? new Date(p.last).toISOString() : row.last_seen
    };
  }

  /** Usage of principals other than users' tokens (the API token, OIDC clients) */
  otherUsage() {
    this.flush();
    return this.stmts.allUsage.all().filter(u => u.kind !== 'token');
  }

  // ---- documents ----

  _document(row) {
    return row ? { ...row, public: !!row.public } : null;
  }

  /** The documents' metadata (no content), by name */
  documents() {
    return this.stmts.documents.all().map(d => this._document(d));
  }

  documentByName(name) {
    return this._document(this.stmts.documentByName.get(name));
  }

  documentById(id) {
    return this._document(this.stmts.documentById.get(id));
  }

  /**
   * Create a document; every change is also written to the log
   * @returns {number} the document's id
   * @throws if the name is taken
   */
  createDocument({ name, type, public: isPublic = false, content }, by, now = new Date()) {
    const at = now.toISOString();
    return this.db.transaction(() => {
      const r = this.stmts.insertDocument.run(name, type, isPublic ? 1 : 0, content, at, by);
      const id = Number(r.lastInsertRowid);
      this.stmts.logDocument.run(id, 'created', name, type, isPublic ? 1 : 0, content, at, by);
      return id;
    })();
  }

  updateDocument(id, { name, type, public: isPublic, content }, by, now = new Date()) {
    const d = this.stmts.documentById.get(id);
    if (!d) {
      return false;
    }
    const at = now.toISOString();
    const next = {
      name: name ?? d.name, type: type ?? d.type,
      public: (isPublic ?? !!d.public) ? 1 : 0, content: content ?? d.content
    };
    this.db.transaction(() => {
      this.stmts.updateDocument.run(next.name, next.type, next.public, next.content, at, by, id);
      this.stmts.logDocument.run(id, next.name !== d.name ? 'renamed' : 'edited', next.name, next.type, next.public, next.content, at, by);
    })();
    return true;
  }

  deleteDocument(id, by, now = new Date()) {
    const d = this.stmts.documentById.get(id);
    if (!d) {
      return false;
    }
    this.db.transaction(() => {
      this.stmts.logDocument.run(id, 'deleted', d.name, d.type, d.public, d.content, now.toISOString(), by);
      this.stmts.deleteDocument.run(id);
    })();
    return true;
  }

  /** A document's log, newest first, without the content */
  documentLog(docId) {
    return this.stmts.documentLog.all(docId).map(e => ({ ...e, public: !!e.public }));
  }

  /** One log entry, with the content as it was */
  documentLogEntry(docId, entryId) {
    const e = this.stmts.documentLogEntry.get(entryId, docId);
    return e ? { ...e, public: !!e.public } : null;
  }

  close() {
    try {
      this.flush();
    } finally {
      this.db.close();
    }
  }
}

module.exports = { AuthStore, makeToken, hashToken, TOKEN_PREFIX };
