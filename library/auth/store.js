// library/auth/store.js
// The server's users, their roles, their API tokens, the one-time links that set a password,
// and the login sessions - one SQLite database (better-sqlite3, synchronous) shared by every
// module and, under the launcher, by every process.
//
// Secrets are stored only as hashes:
//  - passwords: bcrypt
//  - API tokens and one-time links: SHA-256. They are 256 bits of randomness, so a fast hash
//    is enough to make the stored form useless to a thief, and a lookup is one indexed read
//
// A user's `epoch` goes up whenever their password changes, they are disabled, or they ask to
// be logged out everywhere: a session remembers the epoch it was made in, and one from an
// earlier epoch is no longer logged in.

const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

const TOKEN_PREFIX = 'fhs_';
const BCRYPT_COST = 12;
// no @: a login can't be mistaken for another account's email address (userByLoginOrEmail)
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{1,99}$/;
const EMAIL_RE = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,255}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A new random secret: prefix + 32 random bytes, base64url */
function randomSecret(prefix = '') {
  return prefix + crypto.randomBytes(32).toString('base64url');
}

// how long login events are kept, for the daily report
const EVENT_DAYS = 90;

function now() {
  return new Date().toISOString();
}

class AuthStore {
  /**
   * @param {string} dbPath file path, or ':memory:'
   * @param {object} [options]
   * @param {number} [options.bcryptCost] the work factor for password hashes (12; tests use less)
   */
  constructor(dbPath, { bcryptCost } = {}) {
    this.bcryptCost = Number.isInteger(bcryptCost) && bcryptCost >= 4 && bcryptCost <= 15 ? bcryptCost : BCRYPT_COST;
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
      // several processes share the file under the launcher
      this.db.pragma('busy_timeout = 5000');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        login         TEXT UNIQUE NOT NULL COLLATE NOCASE,
        name          TEXT NOT NULL DEFAULT '',
        email         TEXT UNIQUE COLLATE NOCASE,
        password_hash TEXT,
        github_id     TEXT UNIQUE,
        github_login  TEXT,
        google_id     TEXT,
        google_email  TEXT,
        enabled       INTEGER NOT NULL DEFAULT 1,
        epoch         INTEGER NOT NULL DEFAULT 0,
        notes         TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE TABLE IF NOT EXISTS roles (
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        module     TEXT NOT NULL,
        role       TEXT NOT NULL,
        scope      TEXT NOT NULL DEFAULT '',
        granted_at TEXT NOT NULL,
        granted_by TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (user_id, module, role, scope)
      );
      CREATE INDEX IF NOT EXISTS roles_role ON roles(module, role, scope);
      CREATE TABLE IF NOT EXISTS tokens (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        prefix       TEXT NOT NULL,
        hash         TEXT UNIQUE NOT NULL,
        label        TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL,
        expires_at   TEXT,
        revoked_at   TEXT,
        last_used_at TEXT,
        use_count    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);
      CREATE TABLE IF NOT EXISTS links (
        hash       TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at    TEXT
      );
      -- logins and failed logins, for the daily report: no user reference, so the counts stay
      -- when an account is deleted. Kept for EVENT_DAYS
      CREATE TABLE IF NOT EXISTS login_events (
        at      TEXT NOT NULL,
        kind    TEXT NOT NULL,
        method  TEXT NOT NULL,
        user_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS login_events_at ON login_events(at);
      -- the provider id each github:{name} / google:{email} entry of auth.administrators was
      -- first matched by: from then on the entry is that id, so a name or address someone
      -- else takes later (a renamed GitHub account's old name) doesn't make them an administrator
      CREATE TABLE IF NOT EXISTS admin_pins (
        entry       TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        pinned_at   TEXT NOT NULL
      );
    `);
    // columns added since the table was first made
    const cols = new Set(this.db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
    for (const c of ['google_id', 'google_email']) {
      if (!cols.has(c)) {
        this.db.exec(`ALTER TABLE users ADD COLUMN ${c} TEXT`);
      }
    }
    // (SQLite can't add a UNIQUE column: an index does it)
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google ON users(google_id)');
    this.db.pragma('foreign_keys = ON');
    this.pendingUse = new Map(); // token id -> { count, last }
    const p = sql => this.db.prepare(sql);
    this.stmts = {
      userById: p('SELECT * FROM users WHERE id = ?'),
      userByLogin: p('SELECT * FROM users WHERE login = ?'),
      userByEmail: p('SELECT * FROM users WHERE email = ?'),
      userByGithub: p('SELECT * FROM users WHERE github_id = ?'),
      userByGoogle: p('SELECT * FROM users WHERE google_id = ?'),
      setGoogle: p('UPDATE users SET google_id = ?, google_email = ? WHERE id = ?'),
      users: p('SELECT * FROM users ORDER BY login'),
      insertUser: p('INSERT INTO users (login, name, email, github_id, github_login, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      updateUser: p('UPDATE users SET name = ?, email = ?, notes = ? WHERE id = ?'),
      setEnabled: p('UPDATE users SET enabled = ?, epoch = epoch + 1 WHERE id = ?'),
      setPassword: p('UPDATE users SET password_hash = ?, epoch = epoch + 1 WHERE id = ?'),
      bumpEpoch: p('UPDATE users SET epoch = epoch + 1 WHERE id = ?'),
      setGithub: p('UPDATE users SET github_id = ?, github_login = ? WHERE id = ?'),
      touchLogin: p('UPDATE users SET last_login_at = ? WHERE id = ?'),
      deleteUser: p('DELETE FROM users WHERE id = ?'),
      rolesOf: p('SELECT module, role, scope, granted_at, granted_by FROM roles WHERE user_id = ? ORDER BY module, role, scope'),
      grant: p('INSERT OR IGNORE INTO roles (user_id, module, role, scope, granted_at, granted_by) VALUES (?, ?, ?, ?, ?, ?)'),
      revoke: p('DELETE FROM roles WHERE user_id = ? AND module = ? AND role = ? AND scope = ?'),
      holders: p('SELECT user_id FROM roles WHERE module = ? AND role = ? AND scope = ?'),
      allHolders: p('SELECT user_id, scope FROM roles WHERE module = ? AND role = ?'),
      tokenByHash: p('SELECT * FROM tokens WHERE hash = ?'),
      tokensForUser: p('SELECT * FROM tokens WHERE user_id = ? ORDER BY created_at DESC'),
      insertToken: p('INSERT INTO tokens (user_id, prefix, hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
      revokeToken: p('UPDATE tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL'),
      useToken: p('UPDATE tokens SET use_count = use_count + ?, last_used_at = ? WHERE id = ?'),
      insertLink: p('INSERT INTO links (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
      linkByHash: p('SELECT * FROM links WHERE hash = ?'),
      useLink: p('UPDATE links SET used_at = ? WHERE hash = ? AND used_at IS NULL'),
      dropLinks: p('DELETE FROM links WHERE user_id = ? AND used_at IS NULL'),
      purgeLinks: p('DELETE FROM links WHERE expires_at < ?'),
      insertEvent: p('INSERT INTO login_events (at, kind, method, user_id) VALUES (?, ?, ?, ?)'),
      purgeEvents: p('DELETE FROM login_events WHERE at < ?'),
      countEvents: p('SELECT kind, method, user_id IS NOT NULL AS known, COUNT(*) AS n FROM login_events WHERE at > ? AND at <= ? GROUP BY kind, method, known'),
      failedByUser: p(`SELECT u.login, COUNT(*) AS n FROM login_events e JOIN users u ON u.id = e.user_id
        WHERE e.kind = 'failed' AND e.at > ? AND e.at <= ? GROUP BY e.user_id ORDER BY n DESC, u.login`),
      countUsers: p('SELECT COUNT(*) AS total, SUM(enabled) AS enabled, SUM(CASE WHEN created_at > ? AND created_at <= ? THEN 1 ELSE 0 END) AS made FROM users'),
      adminPin: p('SELECT provider_id FROM admin_pins WHERE entry = ?'),
      insertAdminPin: p('INSERT OR IGNORE INTO admin_pins (entry, provider_id, pinned_at) VALUES (?, ?, ?)'),
      adminPins: p('SELECT entry, provider_id, pinned_at FROM admin_pins ORDER BY entry'),
      dropAdminPin: p('DELETE FROM admin_pins WHERE entry = ?')
    };
  }

  // ---- users ----

  _user(row) {
    return row ? { ...row, enabled: !!row.enabled, hasPassword: !!row.password_hash } : null;
  }

  users() {
    return this.stmts.users.all().map(u => this._user(u));
  }

  userById(id) {
    return this._user(this.stmts.userById.get(id));
  }

  userByLogin(login) {
    return typeof login === 'string' ? this._user(this.stmts.userByLogin.get(login)) : null;
  }

  userByEmail(email) {
    return typeof email === 'string' && email ? this._user(this.stmts.userByEmail.get(email)) : null;
  }

  /**
   * The user a login form names: an email address (it has an @) by email, else by login. (A
   * login made before logins couldn't have an @ is still found by it, when it isn't an
   * account's email address)
   */
  userByLoginOrEmail(text) {
    if (typeof text === 'string' && text.includes('@')) {
      return this.userByEmail(text) || this.userByLogin(text);
    }
    return this.userByLogin(text);
  }

  userByGithub(githubId) {
    return githubId ? this._user(this.stmts.userByGithub.get(String(githubId))) : null;
  }

  userByGoogle(googleId) {
    return googleId ? this._user(this.stmts.userByGoogle.get(String(googleId))) : null;
  }

  /** The user an identity from a login provider ('github', 'google') is linked to, or null */
  userByIdentity(provider, id) {
    return provider === 'github' ? this.userByGithub(id) : provider === 'google' ? this.userByGoogle(id) : null;
  }

  /**
   * Link (or, with no id, unlink) a provider's identity: its id, and the handle shown for it
   * (the GitHub login, the Google email)
   */
  setIdentity(provider, userId, id, handle) {
    if (provider === 'github') {
      return this.setGithub(userId, id, handle);
    }
    if (provider === 'google') {
      return this.stmts.setGoogle.run(id ? String(id) : null, id ? handle : null, userId).changes > 0;
    }
    throw new Error(`Unknown login provider ${provider}`);
  }

  /** The id and handle of a provider's identity linked to this user row, or null */
  static identityOf(user, provider) {
    if (!user) {
      return null;
    }
    const [id, handle] = provider === 'github' ? [user.github_id, user.github_login] : provider === 'google' ? [user.google_id, user.google_email] : [null, null];
    return id ? { id, handle } : null;
  }

  /** A login that isn't taken, from what's wanted: wanted, else wanted-2, wanted-3... */
  freeLogin(wanted) {
    let base = String(wanted || 'user').replace(/[^A-Za-z0-9._+-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').substring(0, 90) || 'user';
    if (base.length < 2) {
      base = base + '-user';
    }
    let login = base;
    for (let i = 2; this.stmts.userByLogin.get(login); i++) {
      login = `${base}-${i}`;
    }
    return login;
  }

  /**
   * @returns {number} the new user's id
   * @throws if the login or email is taken, or not valid
   */
  createUser({ login, name = '', email = null, githubId = null, githubLogin = null, notes = '', identity = null }) {
    if (!LOGIN_RE.test(login || '')) {
      throw new Error('A login is 2-100 letters, digits, and . _ @ + -, starting with a letter or digit');
    }
    if (email && !EMAIL_RE.test(email)) {
      throw new Error('That is not an email address');
    }
    const create = () => {
      const r = this.stmts.insertUser.run(login, name, email || null, githubId ? String(githubId) : null, githubLogin, notes, now());
      const id = Number(r.lastInsertRowid);
      // identity: {provider, id, handle}, from a login provider
      if (identity) {
        this.setIdentity(identity.provider, id, identity.id, identity.handle);
      }
      return id;
    };
    return this.db.transaction(create)();
  }

  updateUser(id, { name, email, notes }) {
    const u = this.stmts.userById.get(id);
    if (!u) {
      return false;
    }
    const e = email === undefined ? u.email : (email || null);
    if (e && !EMAIL_RE.test(e)) {
      throw new Error('That is not an email address');
    }
    this.stmts.updateUser.run(name ?? u.name, e, notes ?? u.notes, id);
    return true;
  }

  setEnabled(id, enabled) {
    return this.stmts.setEnabled.run(enabled ? 1 : 0, id).changes > 0;
  }

  /** Set (or with null, remove) a password; every session of the user ends */
  async setPassword(id, password) {
    const hash = password ? await bcrypt.hash(password, this.bcryptCost) : null;
    return this.stmts.setPassword.run(hash, id).changes > 0;
  }

  /** A hash of nothing in particular, at the same cost: compared against when a login names no user */
  dummyHash() {
    if (!this._dummy) {
      this._dummy = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), this.bcryptCost);
    }
    return this._dummy;
  }

  async checkPassword(user, password) {
    if (!user || !user.password_hash || typeof password !== 'string') {
      return false;
    }
    return bcrypt.compare(password, user.password_hash);
  }

  /** The user's unused links that set a password stop working */
  dropLinks(id) {
    return this.stmts.dropLinks.run(id).changes;
  }

  /** Every session of the user ends */
  endSessions(id) {
    return this.stmts.bumpEpoch.run(id).changes > 0;
  }

  setGithub(id, githubId, githubLogin) {
    return this.stmts.setGithub.run(githubId ? String(githubId) : null, githubId ? githubLogin : null, id).changes > 0;
  }

  touchLogin(id) {
    this.stmts.touchLogin.run(now(), id);
  }

  /**
   * A login (kind 'login'), or a failed login ('failed'), for the daily report. A failed login
   * has the account's id when there is such an account, and none when the name isn't one
   * @param {'login'|'failed'} kind
   * @param {'password'|'github'|'google'} method
   */
  recordLogin(kind, method, userId) {
    this.stmts.insertEvent.run(now(), kind, method, userId ?? null);
  }

  /**
   * For the daily report, between two times (ms): logins and failed logins by method, the
   * accounts (all, enabled, made in the period), and the sessions logged in now
   */
  loginStats(since, until) {
    const from = new Date(since).toISOString();
    const to = new Date(until).toISOString();
    this.stmts.purgeEvents.run(new Date(until - EVENT_DAYS * 24 * 60 * 60 * 1000).toISOString());
    const counts = { login: { password: 0, github: 0, google: 0 }, failed: { password: 0, github: 0, google: 0 } };
    let failedUnknown = 0;
    for (const r of this.stmts.countEvents.all(from, to)) {
      if (r.kind === 'failed' && !r.known) {
        failedUnknown += r.n;
      } else if (counts[r.kind]) {
        counts[r.kind][r.method] = (counts[r.kind][r.method] || 0) + r.n;
      }
    }
    // the accounts that had failed logins, most first: [{login, n}]
    const failedAccounts = this.stmts.failedByUser.all(from, to);
    const u = this.stmts.countUsers.get(from, to);
    let sessions = null;
    try {
      // sessions with a user in them, not expired, whose user is still enabled and hasn't
      // logged out everywhere (or changed their password) since
      sessions = this.db.prepare(`SELECT COUNT(*) AS n FROM sessions s JOIN users u
        ON u.id = json_extract(s.sess, '$.auth.uid') AND u.epoch = json_extract(s.sess, '$.auth.epoch') AND u.enabled = 1
        WHERE s.expired >= ?`).get(until).n;
    } catch {
      // no sessions table (yet): the session store makes it
    }
    return {
      logins: counts.login, failed: counts.failed, failedUnknown, failedAccounts,
      users: u.total || 0, enabled: u.enabled || 0, made: u.made || 0, sessions
    };
  }

  deleteUser(id) {
    return this.stmts.deleteUser.run(id).changes > 0;
  }

  // ---- the configured administrators' provider ids ----

  /** The provider id a configured entry ('github:{name}', 'google:{email}') is tied to, or null */
  adminPin(entry) {
    const r = this.stmts.adminPin.get(entry);
    return r ? r.provider_id : null;
  }

  /**
   * Tie a configured entry to a provider id, unless it is tied already (another process may
   * have got there first)
   * @returns {string} the id the entry is tied to
   */
  pinAdmin(entry, providerId) {
    this.stmts.insertAdminPin.run(entry, String(providerId), now());
    return this.adminPin(entry);
  }

  adminPins() {
    return this.stmts.adminPins.all();
  }

  /** Forget the ties of entries no longer configured */
  dropAdminPinsExcept(entries) {
    const keep = new Set(entries);
    let n = 0;
    for (const p of this.adminPins()) {
      if (!keep.has(p.entry)) {
        n += this.stmts.dropAdminPin.run(p.entry).changes;
      }
    }
    return n;
  }

  // ---- roles ----

  rolesOf(userId) {
    return this.stmts.rolesOf.all(userId);
  }

  grant(userId, module, role, scope = '', by = '') {
    return this.stmts.grant.run(userId, module, role, String(scope ?? ''), now(), by).changes > 0;
  }

  revoke(userId, module, role, scope = '') {
    return this.stmts.revoke.run(userId, module, role, String(scope ?? '')).changes > 0;
  }

  /** The ids of the users with a role (in a scope) */
  holders(module, role, scope = '') {
    return this.stmts.holders.all(module, role, String(scope ?? '')).map(r => r.user_id);
  }

  /** Every holder of a role, in every scope: [{user_id, scope}] */
  allHolders(module, role) {
    return this.stmts.allHolders.all(module, role);
  }

  /** Make exactly these users the holders of a role in a scope */
  setHolders(module, role, scope, userIds, by = '') {
    const want = new Set(userIds.map(Number));
    this.db.transaction(() => {
      for (const id of this.holders(module, role, scope)) {
        if (!want.has(id)) {
          this.revoke(id, module, role, scope);
        }
      }
      for (const id of want) {
        if (this.stmts.userById.get(id)) {
          this.grant(id, module, role, scope, by);
        }
      }
    })();
  }

  // ---- API tokens ----

  /**
   * Issue a token for a user. The clear token is returned once, here, and never stored
   * @returns {{id: number, token: string, prefix: string}}
   */
  issueToken(userId, { label = '', expiresInDays = null } = {}) {
    const token = randomSecret(TOKEN_PREFIX);
    const prefix = token.substring(0, 12);
    const expires = expiresInDays && expiresInDays > 0 ? new Date(Date.now() + expiresInDays * DAY_MS).toISOString() : null;
    const r = this.stmts.insertToken.run(userId, prefix, sha256(token), label, now(), expires);
    return { id: Number(r.lastInsertRowid), token, prefix };
  }

  tokensForUser(userId) {
    const t0 = Date.now();
    return this.stmts.tokensForUser.all(userId).map(t => {
      const p = this.pendingUse.get(t.id);
      return {
        ...t,
        use_count: t.use_count + (p ? p.count : 0),
        last_used_at: p ? new Date(p.last).toISOString() : t.last_used_at,
        status: t.revoked_at ? 'revoked' : (t.expires_at && new Date(t.expires_at).getTime() < t0 ? 'expired' : 'active')
      };
    });
  }

  revokeToken(userId, tokenId) {
    return this.stmts.revokeToken.run(now(), tokenId, userId).changes > 0;
  }

  /**
   * The live token presented, and its user (enabled), or null. Use is counted (written by flush())
   * @returns {{user: object, tokenId: number}|null}
   */
  authenticateToken(token, t0 = Date.now()) {
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX) || token.length > 200) {
      return null;
    }
    const t = this.stmts.tokenByHash.get(sha256(token));
    if (!t || t.revoked_at || (t.expires_at && new Date(t.expires_at).getTime() < t0)) {
      return null;
    }
    const user = this.userById(t.user_id);
    if (!user || !user.enabled) {
      return null;
    }
    const p = this.pendingUse.get(t.id);
    if (p) {
      p.count++;
      p.last = t0;
    } else {
      this.pendingUse.set(t.id, { count: 1, last: t0 });
    }
    return { user, tokenId: t.id };
  }

  /** Write the token use counted since the last flush */
  flush() {
    if (this.pendingUse.size === 0) {
      return 0;
    }
    const entries = [...this.pendingUse.entries()];
    this.pendingUse.clear();
    this.db.transaction(() => {
      for (const [id, p] of entries) {
        this.stmts.useToken.run(p.count, new Date(p.last).toISOString(), id);
      }
    })();
    return entries.length;
  }

  // ---- one-time links that set a password ----

  /**
   * A new link for a user: any earlier unused one stops working
   * @returns {string} the secret for the URL (not stored)
   */
  createLink(userId, minutes) {
    const secret = randomSecret();
    const t0 = Date.now();
    this.db.transaction(() => {
      this.stmts.dropLinks.run(userId);
      this.stmts.purgeLinks.run(new Date(t0).toISOString());
      this.stmts.insertLink.run(sha256(secret), userId, new Date(t0).toISOString(), new Date(t0 + minutes * 60 * 1000).toISOString());
    })();
    return secret;
  }

  /** The user a link is for, if it is unused and unexpired (it is not used up by looking) */
  checkLink(secret, t0 = Date.now()) {
    if (typeof secret !== 'string' || secret.length < 20 || secret.length > 100) {
      return null;
    }
    const l = this.stmts.linkByHash.get(sha256(secret));
    if (!l || l.used_at || new Date(l.expires_at).getTime() < t0) {
      return null;
    }
    const user = this.userById(l.user_id);
    return user && user.enabled ? user : null;
  }

  /** Use a link up: true if it was there to use */
  useLink(secret) {
    return this.stmts.useLink.run(now(), sha256(secret)).changes > 0;
  }

  close() {
    try {
      this.flush();
    } finally {
      this.db.close();
    }
  }
}

module.exports = { AuthStore, TOKEN_PREFIX, LOGIN_RE, EMAIL_RE, sha256 };
