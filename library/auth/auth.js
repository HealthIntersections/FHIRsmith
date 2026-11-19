// library/auth/auth.js
// One login for the whole server. Every module asks this who a request is - a person logged
// in with a session cookie, or software presenting an API token - and what they may do.
//
//  - Users log in with a password, or with GitHub or Google. Anyone can make an account with
//    GitHub or Google; it has no roles until the administrator gives it some. The administrator makes password
//    accounts, and the password is set from a link that is emailed (and the same for a
//    forgotten password). Passwords are at least 15 characters.
//  - Roles: "administrator" is server wide, and passes every check. Modules define their own
//    roles (ips: manager of a project; publisher: queue/approve for a website...), some of
//    them scoped (to a project, a website...), and grant them on their own pages or on the
//    user's page here.
//  - Software uses API tokens, which a user issues (or the administrator issues for them) and
//    which carry that user's roles.
//  - Who is an administrator is said by the configuration (auth.administrators: email addresses
//    github:{name} or google:{email}), and by the role granted on the users page.
//
// It is a singleton (like html-server): require('library/auth') anywhere, and server.js
// initializes it before any module. See library/auth/README.md.

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const lusca = require('lusca');
const { SqliteSessionStore, betterSqlite } = require('../sqlite-session-store');
const { requireSameOrigin, originIsThisSite } = require('../same-origin');
const { AuthStore, TOKEN_PREFIX } = require('./store');

const SERVER = 'server';
const ADMINISTRATOR = 'administrator';
const BY_CONFIGURATION = 'configuration';
const MIN_PASSWORD = 15;
const MAX_PASSWORD_BYTES = 72; // bcrypt reads no further
const DEFAULT_LINK_MINUTES = 60;
const DEFAULT_DATABASE = 'auth.db';
const INTERNAL_HEADER = 'x-fhirsmith-internal';
const FLUSH_MS = 60 * 1000;

// what each request has been worked out to be (a promise), so the question is asked once
const PRINCIPALS = new WeakMap();
const SESSION_COOKIE = 'fhirsmith.sid';
// requests a minute from one address that bring a login or a token (auth.requestsPerMinute)
const DEFAULT_REQUESTS_PER_MINUTE = 1000;

/**
 * The token a request carries, if any: Authorization: Bearer, Api-Key, X-API-Key, or Basic
 * with the token as the password (for clients that can only do Basic, like curl -u)
 */
function presentedToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    let m = /^\s*Bearer\s+(\S+)\s*$/i.exec(auth);
    if (m) {
      return m[1];
    }
    m = /^\s*Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(auth);
    if (m) {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      const pw = colon >= 0 ? decoded.substring(colon + 1) : '';
      if (pw.startsWith(TOKEN_PREFIX)) {
        return pw;
      }
    }
  }
  for (const name of ['api-key', 'x-api-key']) {
    const v = req.headers[name];
    if (typeof v === 'string' && v.trim()) {
      return v.trim();
    }
  }
  return null;
}

/**
 * Is this a path on this server - one a redirect can't turn into another site? It starts with
 * one /, not // or /\ (which browsers take as //host), nor an encoded / or \ there; it has no
 * control characters; and it isn't too long. (Named so that code scanning - CodeQL
 * js/server-side-unvalidated-url-redirection - takes it as the check it is)
 */
function isLocalUrl(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 2000 &&
    value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') &&
    // eslint-disable-next-line no-control-regex -- control characters are what it looks for
    !/^\/(%2f|%5c)/i.test(value) && !/[\u0000-\u001F\u007F]/.test(value);
}

/**
 * Redirect back to where the user was: `value` if it's a path on this server, else `fallback`
 * (a path the server chose). Every redirect to a place a request named goes through this
 */
function redirectBack(res, value, fallback) {
  if (isLocalUrl(value)) {
    return res.redirect(value);
  }
  return res.redirect(fallback);
}

/** A return path that stays on this server: a local path (isLocalUrl), else the fallback */
function safeReturn(value, fallback = '/') {
  if (!isLocalUrl(value)) {
    return fallback;
  }
  return value;
}

/**
 * Who is making a request: a user (with their roles), or this server itself (an in-process
 * call from one module to another)
 */
class Principal {
  constructor(user, { roles = [], isAdmin = false, adminFromConfig = false, via = 'session', tokenId = null } = {}) {
    this.id = user.id;
    this.login = user.login;
    this.name = user.name || user.login;
    this.email = user.email || null;
    this.githubLogin = user.github_login || null;
    this.googleEmail = user.google_email || null;
    this.hasPassword = !!user.hasPassword;
    this.isAdmin = isAdmin;
    this.adminFromConfig = adminFromConfig;
    this.roles = roles;
    this.via = via; // session | token | internal
    this.tokenId = tokenId;
  }

  /**
   * Has this principal a role? An administrator has every role. With no scope, any scope of
   * the role will do; with one, that scope (or the role unscoped, which covers every scope)
   */
  has(module, role, scope) {
    if (this.isAdmin) {
      return true;
    }
    return this.roles.some(r => r.module === module && r.role === role &&
      (scope === undefined || scope === null || r.scope === '' || r.scope === String(scope)));
  }

  /** The scopes this principal has a role in ('' = every scope) */
  scopes(module, role) {
    return this.roles.filter(r => r.module === module && r.role === role).map(r => r.scope);
  }
}

class Auth {
  constructor() {
    this.store = null;
    this.config = {};
    this.log = console;
    this.mailer = null;
    this.roleDefs = new Map(); // module -> [{role, label, description, scope: {label, values()}}]
    this.moduleInfo = new Map(); // module -> {title, path, adminPages: [{label, path, description}]}
    // the request a page is being made for, so the template's [%account%] can say who is logged in
    this.pageRequests = new AsyncLocalStorage();
    this.internalSecret = crypto.randomBytes(32).toString('base64url');
    this.flushTimer = null;
    this.initialized = false;
    // The middleware modules put on their routes. They exist from the start, so a module can be
    // set up before (or, in a test, without) initialize(): until then there is no session, and
    // so nobody logged in
    this._session = null;
    this._csrf = null;
    this.session = (req, res, next) => (this._session ? this._session(req, res, next) : next());
    this.csrf = (req, res, next) => (this._csrf ? this._csrf(req, res, next) : next());
    // pages a visitor reads: the token (and with it a session) only for someone logged in
    this.csrfIfLoggedIn = (req, res, next) => (this._csrf && this.currentUser(req) ? this._csrf(req, res, next) : next());
    // the session and, for a logged in user, the CSRF token: for the pages of every module
    this.web = [this.session, this.csrfIfLoggedIn];
    this.form = express.urlencoded({ extended: false, limit: '64kb' });
    // On every request, before the modules (server.js): the session, when the browser sent a
    // session cookie, so every module's pages know who is logged in; and the request, for
    // [%account%] in the page templates. Software (no cookie) costs nothing
    this.pages = (req, res, next) => {
      const go = () => this.pageRequests.run(req, next);
      if (this._session && !req.session && (req.headers.cookie || '').includes(`${SESSION_COOKIE}=`)) {
        return this._session(req, res, err => (err ? next(err) : go()));
      }
      go();
    };
    this.sameOrigin = requireSameOrigin((req, res) => this.sendError(req, res, 403, 'Cross-site form posts are not accepted'));
  }

  /**
   * @param {object} config the top level "auth" block of config.json (may be empty)
   * @param {object} options
   * @param {object} [options.log]
   * @param {object} [options.mailer] library/mailer
   * @param {string} [options.hostName] config.hostName, for the public URL when auth.publicUrl isn't set
   * @param {string} [options.databasesDir] where a relative auth.database goes
   */
  initialize(config, { log, mailer, hostName, databasesDir } = {}) {
    this.shutdown();
    this.config = config || {};
    this.log = log || console;
    this.mailer = mailer || null;
    this.hostName = hostName || null;
    const db = this.config.database || DEFAULT_DATABASE;
    const dbPath = db === ':memory:' || path.isAbsolute(db) ? db : path.join(databasesDir || require('../folder-setup').databasesDir(), db);
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.dbPath = dbPath;
    this.store = new AuthStore(dbPath, { bcryptCost: this.config.bcryptCost });
    this.linkMinutes = Number.isInteger(this.config.linkMinutes) && this.config.linkMinutes > 0 ? this.config.linkMinutes : DEFAULT_LINK_MINUTES;
    // the login providers configured (library/auth/oauth.js): auth.github, auth.google
    this.providers = {};
    for (const key of ['github', 'google']) {
      const c = this.config[key];
      if (c && typeof c.clientId === 'string' && c.clientId && typeof c.clientSecret === 'string' && c.clientSecret) {
        this.providers[key] = c;
      }
    }
    this.github = this.providers.github || null;
    this.google = this.providers.google || null;
    this.applyConfiguredAdministrators();
    this.setupMiddleware();
    this.flushTimer = setInterval(() => {
      try {
        this.store.flush();
      } catch (e) {
        this.log.error(`Auth: could not write token use: ${e.message}`);
      }
    }, FLUSH_MS);
    this.flushTimer.unref();
    this.initialized = true;
    const on = Object.keys(this.providers);
    this.log.info(`Auth: users in ${dbPath}; ${on.length ? `logging in with ${on.join(' and ')}` : 'no GitHub or Google login (auth.github, auth.google)'}; ` +
      `${this.mailer && this.mailer.configured() ? 'password links are emailed' : 'no email: password links are shown to the administrator'}`);
  }

  shutdown() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.sessionStore) {
      this.sessionStore.close();
      this.sessionStore = null;
    }
    this._session = null;
    this._csrf = null;
    if (this.store) {
      this.store.close();
      this.store = null;
    }
    this.initialized = false;
  }

  requireInitialized() {
    if (!this.store) {
      throw new Error('The auth system is not initialized (library/auth)');
    }
  }

  // ---- administrators from the configuration ----

  /**
   * The configured administrators: {emails, github, google, githubIds, googleIds} (lower case).
   * Only emails, GitHub names or ids (github:#{id}) and Google email addresses or ids
   * (google:#{sub}): a bare login could be taken by anyone who makes an account with GitHub or
   * Google first
   */
  configuredAdministrators() {
    const list = Array.isArray(this.config.administrators) ? this.config.administrators : [];
    const out = { emails: new Set(), github: new Set(), google: new Set(), githubIds: new Set(), googleIds: new Set(), invalid: [] };
    for (const raw of list) {
      if (typeof raw !== 'string' || !raw.trim()) {
        continue;
      }
      const v = raw.trim().toLowerCase();
      if (/^github:#\d+$/.test(v)) {
        out.githubIds.add(v.substring(8));
      } else if (/^google:#\S+$/.test(v)) {
        out.googleIds.add(raw.trim().substring(8)); // Google's ids are case sensitive
      } else if (v.startsWith('github:') && v.length > 7 && !v.includes('#')) {
        out.github.add(v.substring(7));
      } else if (v.startsWith('google:') && /^[^\s@]+@[^\s@]+$/.test(v.substring(7))) {
        out.google.add(v.substring(7));
      } else if (/^[^\s@]+@[^\s@]+$/.test(v)) {
        out.emails.add(v);
      } else {
        out.invalid.push(raw);
      }
    }
    return out;
  }

  /** Is this user named an administrator by the configuration? */
  isConfiguredAdministrator(user, admins = this.configuredAdministrators()) {
    if (!user) {
      return false;
    }
    if (user.email && admins.emails.has(user.email.toLowerCase())) {
      return true;
    }
    // only an account GitHub or Google has vouched for (a github_id, a google_id) matches
    return this.matchesProvider(user, 'github', user.github_id, admins.githubIds, admins.github) ||
      this.matchesProvider(user, 'google', user.google_id, admins.googleIds, admins.google);
  }

  /**
   * Does a user's identity with a provider match an entry of auth.administrators? An id entry
   * ({provider}:#{id}) matches that id. A name entry (github:{name}, google:{email}) is tied to
   * the provider id of the first account that matches it (store.adminPin), and from then on
   * matches that id, whatever the account is called now: a GitHub user who renames keeps it,
   * and whoever takes the old name doesn't get it
   */
  matchesProvider(user, provider, providerId, ids, handles) {
    if (!providerId) {
      return false;
    }
    if (ids.has(String(providerId))) {
      return true;
    }
    if (handles.size === 0 || !this.store) {
      return false;
    }
    const handle = AuthStore.identityOf(user, provider)?.handle;
    const id = String(providerId);
    // an entry already tied to this account (by name now, or by a name it had)
    for (const h of handles) {
      if (this.store.adminPin(`${provider}:${h}`) === id) {
        return true;
      }
    }
    // the entry for the name it has now, if no account has been tied to it yet
    if (handle && handles.has(handle.toLowerCase())) {
      const entry = `${provider}:${handle.toLowerCase()}`;
      if (this.store.adminPin(entry) === null) {
        const pinned = this.store.pinAdmin(entry, id);
        if (pinned === id) {
          this.log.info(`Auth: auth.administrators entry '${entry}' is now tied to ${provider} id ${id} (account '${user.login}')`);
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Make an account for each configured administrator email that has none, so the password
   * can be set from a link (Forgot password, or node server.js --password-link)
   */
  applyConfiguredAdministrators() {
    const admins = this.configuredAdministrators();
    for (const email of admins.emails) {
      if (!this.store.userByEmail(email)) {
        const id = this.store.createUser({ login: this.store.freeLogin(email.split('@')[0]), email, name: '', notes: 'An administrator named in the configuration' });
        this.log.info(`Auth: made the account for the configured administrator ${email} (id ${id}); set its password with Forgot password, or node server.js --password-link ${email}`);
      }
    }
    for (const bad of admins.invalid) {
      this.log.warn(`Auth: auth.administrators entry '${bad}' is neither an email address, github:{name}, github:#{id}, google:{email} nor google:#{id} - ignored`);
    }
    // an entry taken out of the configuration lets go of the account it was tied to
    const entries = [...[...admins.github].map(h => `github:${h}`), ...[...admins.google].map(h => `google:${h}`)];
    const dropped = this.store.dropAdminPinsExcept(entries);
    if (dropped > 0) {
      this.log.info(`Auth: forgot the accounts of ${dropped} auth.administrators entr${dropped === 1 ? 'y' : 'ies'} no longer configured`);
    }
    if (admins.emails.size + admins.github.size + admins.google.size + admins.githubIds.size + admins.googleIds.size === 0) {
      this.log.warn('Auth: no administrators are configured (auth.administrators) - nobody can manage users unless one has been given the role');
    }
  }

  // ---- middleware ----

  setupMiddleware() {
    if (!this.config.sessionSecret) {
      // never a constant: the project is open source, so a fixed default would be a published key
      this.log.warn('Auth: no auth.sessionSecret configured - using a random one, so logins will not survive a restart ' +
        '(and, under the launcher, are not shared between processes)');
    }
    this.sessionStore = new SqliteSessionStore({ db: betterSqlite(this.store.db), table: 'sessions' });
    this._session = session({
      name: SESSION_COOKIE,
      store: this.sessionStore,
      secret: this.config.sessionSecret || crypto.randomBytes(64).toString('hex'),
      resave: false,
      saveUninitialized: false,
      cookie: {
        path: '/',
        // HTTPS only unless cookieSecure is false (a server run over plain http, in development)
        secure: this.config.cookieSecure ?? true,
        // the browser leaves the cookie off a post that starts on another site: with the Origin
        // check and the CSRF token on every form, that is the CSRF protection
        sameSite: 'lax',
        httpOnly: true,
        maxAge: (Number(this.config.sessionHours) > 0 ? Number(this.config.sessionHours) : 24) * 60 * 60 * 1000
      }
    });
    // every form carries the session's token in a hidden _csrf field
    this._csrf = lusca.csrf({ key: '_csrf' });
  }

  // ---- who is asking ----

  /**
   * The user logged in with this request's session (sync), or null. A request another site
   * made (its Origin names another host) is nobody, whatever cookie came with it: the browser
   * attaches the cookie to requests from pages on the same site (build.fhir.org and
   * tx.fhir.org are one site, fhir.org), and SameSite=Lax doesn't stop those. Software uses
   * API tokens, which no browser attaches by itself
   */
  currentUser(req) {
    if (!this.store || !req.session || !req.session.auth || !originIsThisSite(req)) {
      return null;
    }
    const s = req.session.auth;
    const user = this.store.userById(s.uid);
    // a disabled user, a changed password, or "log out everywhere" ends the session
    if (!user || !user.enabled || user.epoch !== s.epoch) {
      return null;
    }
    return this.principalFor(user, 'session');
  }

  /** The principal for a user id (enabled users only), for a module checking what a user may do */
  principalById(id) {
    this.requireInitialized();
    const u = this.store.userById(id);
    return u && u.enabled ? this.principalFor(u, 'session') : null;
  }

  principalFor(user, via, tokenId = null) {
    const roles = this.store.rolesOf(user.id);
    const fromConfig = this.isConfiguredAdministrator(user);
    const isAdmin = fromConfig || roles.some(r => r.module === SERVER && r.role === ADMINISTRATOR);
    return new Principal(user, { roles, isAdmin, adminFromConfig: fromConfig, via, tokenId });
  }

  /**
   * Who makes this request - the session's user, else the user of the API token it presents,
   * else this server itself (an in-process call), else null. Worked out once per request
   * @returns {Promise<Principal|null>}
   */
  principal(req) {
    if (!PRINCIPALS.has(req)) {
      PRINCIPALS.set(req, Promise.resolve().then(() => this.resolvePrincipal(req)));
    }
    return PRINCIPALS.get(req);
  }

  resolvePrincipal(req) {
    if (!this.store) {
      return null;
    }
    const internal = req.headers[INTERNAL_HEADER];
    if (typeof internal === 'string' && internal.length === this.internalSecret.length &&
      crypto.timingSafeEqual(Buffer.from(internal), Buffer.from(this.internalSecret))) {
      return new Principal({ id: 0, login: 'server', name: 'This server' }, { isAdmin: true, via: 'internal' });
    }
    const token = presentedToken(req);
    if (token) {
      const t = this.store.authenticateToken(token);
      return t ? this.principalFor(t.user, 'token', t.tokenId) : null;
    }
    return req.session ? this.currentUser(req) : null;
  }

  /** Did the request present a token (good or bad)? */
  presentsToken(req) {
    return presentedToken(req) !== null;
  }

  /** Headers that make an in-process request (library dispatch) this server itself */
  internalHeaders() {
    return { [INTERNAL_HEADER]: this.internalSecret };
  }

  // ---- guards ----

  /** Where to log in, coming back to this request's page */
  loginUrl(req, back) {
    const ret = safeReturn(back || (req.method === 'GET' ? req.originalUrl : (req.get('Referer') ? new URL(req.get('Referer'), 'http://x').pathname : '/')));
    return `/auth/login?return=${encodeURIComponent(ret)}`;
  }

  /**
   * Middleware for pages: someone logged in (redirect to the login page if not) who passes
   * `check` (403 if not). Sets req.user. Put this.session before it.
   * @param {function(Principal, Request): boolean} [check]
   * @param {function(req, res, status, message)} [onError] how the module shows an error page
   */
  requirePage(check, onError) {
    return (req, res, next) => {
      this.denyFraming(res);
      const user = this.currentUser(req);
      if (!user) {
        return res.redirect(this.loginUrl(req));
      }
      if (check && !check(user, req)) {
        return (onError || ((q, s, status, m) => this.sendError(q, s, status, m)))(req, res, 403, 'You do not have permission to do that');
      }
      req.user = user;
      next();
    };
  }

  /**
   * The headers that stop another site putting a page in a frame (clickjacking): for pages that
   * need someone logged in, and every /auth page
   * @param {import('express').Response} res
   */
  denyFraming(res) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  }

  /** requirePage for administrators */
  requireAdmin(onError) {
    return this.requirePage(u => u.isAdmin, onError);
  }

  /**
   * Middleware for an API: a principal (session, token or this server) that passes `check`,
   * else 401 (none) or 403 (not allowed), as JSON unless `onError` says otherwise. Sets req.user
   * @param {function(Principal, Request): boolean} [check]
   * @param {function(req, res, status, message)} [onError]
   */
  requireApi(check, onError) {
    const fail = onError || ((req, res, status, message) => {
      if (status === 401) {
        res.setHeader('WWW-Authenticate', 'Bearer');
      }
      res.status(status).json({ error: status === 401 ? 'unauthorized' : 'forbidden', message });
    });
    return (req, res, next) => {
      void this.principal(req).then(p => {
        if (!p) {
          return fail(req, res, 401, this.presentsToken(req) ? 'The API token is not valid' :
            'An API token is required: send it as Authorization: Bearer {token}');
        }
        if (check && !check(p, req)) {
          return fail(req, res, 403, `${p.login} does not have permission to do that`);
        }
        req.user = p;
        next();
      }).catch(next);
    };
  }

  // ---- roles ----

  /**
   * A module says what roles it has, for the users pages
   * @param {string} module
   * @param {Array<{role: string, label: string, description?: string, scope?: {label: string, values: function(): Array<{value: string, label: string}>}}>} roles
   */
  defineRoles(module, roles, info) {
    this.roleDefs.set(module, roles);
    if (info) {
      this.defineModule(module, info);
    }
  }

  /**
   * What a module is called and where it is, for the account page (a user's roles link to it)
   * @param {string} module
   * @param {{title?: string, path?: string}} info
   */
  defineModule(module, info) {
    this.moduleInfo.set(module, { adminPages: [], ...(this.moduleInfo.get(module) || {}), ...info });
  }

  /**
   * A page only administrators have, which the account page lists for them
   * @param {string} module
   * @param {{label: string, path: string, description?: string}} page
   */
  addAdminPage(module, page) {
    if (!this.moduleInfo.has(module)) {
      this.defineModule(module, {});
    }
    const pages = this.moduleInfo.get(module).adminPages;
    if (!pages.some(p => p.path === page.path)) {
      pages.push(page);
    }
  }

  /** The users (enabled or not), for modules' pages: [{id, login, name, email}] */
  users() {
    this.requireInitialized();
    return this.store.users().map(u => ({ id: u.id, login: u.login, name: u.name, email: u.email, enabled: u.enabled }));
  }

  user(id) {
    this.requireInitialized();
    const u = this.store.userById(id);
    return u ? { id: u.id, login: u.login, name: u.name, email: u.email, enabled: u.enabled } : null;
  }

  /** The ids of the users holding a role in a scope */
  holders(module, role, scope = '') {
    this.requireInitialized();
    return this.store.holders(module, role, scope);
  }

  /** Every holder of a role, in any scope: [{user_id, scope}] */
  allHolders(module, role) {
    this.requireInitialized();
    return this.store.allHolders(module, role);
  }

  setHolders(module, role, scope, userIds, by = '') {
    this.requireInitialized();
    this.store.setHolders(module, role, scope, userIds, by);
  }

  grant(userId, module, role, scope = '', by = '') {
    this.requireInitialized();
    return this.store.grant(userId, module, role, scope, by);
  }

  revoke(userId, module, role, scope = '') {
    this.requireInitialized();
    return this.store.revoke(userId, module, role, scope);
  }

  // ---- passwords ----

  /** What's wrong with a new password, or null */
  passwordProblem(password, confirm) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
      return `A password must be at least ${MIN_PASSWORD} characters`;
    }
    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
      return `A password can't be more than ${MAX_PASSWORD_BYTES} bytes`;
    }
    if (confirm !== undefined && password !== confirm) {
      return 'The two passwords are not the same';
    }
    return null;
  }

  /**
   * The server's public URL: auth.publicUrl, else hostName (https, or http when cookieSecure is
   * false), else - only when `req` is given - the request's. For the GitHub and Google callbacks,
   * which those sites check against the one registered, so a forged Host header gets nowhere
   */
  publicUrl(req) {
    const base = this.configuredUrl();
    if (base) {
      return base;
    }
    if (req) {
      return `${req.protocol}://${req.get('host')}`;
    }
    return null;
  }

  /**
   * The public URL from the configuration (auth.publicUrl, else hostName), or null. Password
   * links are made only from this: never from the request, whose Host header anyone can forge
   * to have a link to their own site emailed to a user
   */
  configuredUrl() {
    if (typeof this.config.publicUrl === 'string' && /^https?:\/\//.test(this.config.publicUrl)) {
      return this.config.publicUrl.replace(/\/+$/, '');
    }
    if (this.hostName && /^[A-Za-z0-9.-]+(:\d+)?$/.test(this.hostName)) {
      return `${this.config.cookieSecure === false ? 'http' : 'https'}://${this.hostName}`;
    }
    return null;
  }

  /**
   * A link that sets the user's password (any earlier one stops working)
   * @returns {string|null} the URL, or null if there is no public URL (auth.publicUrl or
   *   hostName) to make it from
   */
  passwordLink(userId, req, back = '') {
    this.requireInitialized();
    const base = this.configuredUrl();
    if (!base) {
      this.log.warn('Auth: no link that sets a password can be made: set auth.publicUrl (or hostName) in config.json');
      return null;
    }
    const ret = safeReturn(back, '');
    return `${base}/auth/reset/${this.store.createLink(userId, this.linkMinutes)}${ret ? `?return=${encodeURIComponent(ret)}` : ''}`;
  }

  /** Can password links be emailed: email is set up, and there is a public URL to make them from */
  canEmail() {
    return !!(this.mailer && this.mailer.configured()) && this.configuredUrl() !== null;
  }

  /** Email a user a link that sets their password. Resolves true if it was sent */
  async emailPasswordLink(user, req, reason = 'reset', back = '') {
    if (!this.canEmail() || !user || !user.email) {
      return false;
    }
    const link = this.passwordLink(user.id, req, back);
    if (!link) {
      return false;
    }
    const where = this.configuredUrl();
    const text = (reason === 'new' ?
      `An account has been made for you on ${where}, with the login ${user.login}.\n\nSet its password here:\n\n` :
      `Someone (hopefully you) asked to set the password of the account ${user.login} on ${where}.\n\nSet it here:\n\n`) +
      `${link}\n\nThe link works once, for ${this.linkMinutes} minutes. If you didn't ask for this, ignore it - nothing has changed.\n`;
    await this.mailer.send({ to: user.email, subject: `${reason === 'new' ? 'Your new account' : 'Set your password'} on ${where}`, text });
    return true;
  }

  // ---- pages ----

  /**
   * The paragraph for the daily report (library/daily-report.js), when there are any accounts:
   * logins, failed logins for accounts that exist, the accounts, and the sessions logged in now
   * @param {{since: number, now: number}} period
   * @returns {string} markdown, or '' when there is nothing to say
   */
  dailyReport({ since, now }) {
    if (!this.initialized) {
      return '';
    }
    const { plural } = require('../daily-report');
    const s = this.store.loginStats(since, now);
    if (s.users === 0) {
      return '';
    }
    const how = c => [[c.password, 'with a password'], [c.github, 'with GitHub'], [c.google, 'with Google']].filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`);
    const total = c => c.password + c.github + c.google;
    const logins = total(s.logins);
    const known = total(s.failed);
    const failed = known + s.failedUnknown;
    const sentences = [];
    const first = `${plural(logins, 'login')}${logins > 0 && how(s.logins).length > 1 ? ` (${how(s.logins).join(', ')})` : ''}.`;
    sentences.push(first.charAt(0).toUpperCase() + first.slice(1));
    // failed logins altogether, and by account. (A GitHub or Google login that was cancelled or
    // abandoned isn't one: only a wrong password, or a disabled account, is)
    if (failed === 0) {
      sentences.push('No failed logins.');
    } else {
      const SHOWN = 10;
      const accounts = s.failedAccounts.slice(0, SHOWN).map(a => `${a.login} ${a.n}`).join(', ') +
        (s.failedAccounts.length > SHOWN ? `, and ${s.failedAccounts.length - SHOWN} more` : '');
      const parts = [];
      if (s.failedUnknown > 0) {
        parts.push(`${s.failedUnknown} for ${s.failedUnknown === 1 ? 'a name that isn\'t an account' : 'names that aren\'t accounts'}`);
      }
      if (known > 0) {
        parts.push(`${known} for ${s.failedAccounts.length === 1 ? 'an account that exists' : 'accounts that exist'} (${accounts})`);
      }
      sentences.push(`${plural(failed, 'failed login')}: ${parts.join(', and ')}.`);
    }
    const disabled = s.users - s.enabled;
    sentences.push(`${plural(s.users, 'user account')}${disabled > 0 ? ` (${disabled} disabled)` : ''}` +
      `${s.made > 0 ? `, ${s.made} of them new` : ''}.`);
    if (s.sessions !== null) {
      sentences.push(`${plural(s.sessions, 'session')} ${s.sessions === 1 ? 'is' : 'are'} logged in now.`);
    }
    return sentences.join(' ');
  }

  /** Where logging out goes (auth.afterLogout, a path on this server; default the server's home page) */
  afterLogout() {
    return safeReturn(this.config.afterLogout, '/');
  }

  /**
   * Does the request bring a login (the session cookie) or an API token? Those are the
   * requests that make the server look someone up; the rest are anonymous
   */
  bringsCredentials(req, sessionOnly = false) {
    const session = (req.headers.cookie || '').includes(`${SESSION_COOKIE}=`);
    if (sessionOnly) {
      return session;
    }
    return session || this.presentsToken(req) ||
      (typeof req.headers['x-crawl-token'] === 'string' && req.headers['x-crawl-token'] !== '');
  }

  /**
   * The options for express-rate-limit that every route that looks up who is asking goes
   * behind: `rateLimit(auth.credentialLimits())`, as the first middleware of the module's router
   * (or, where the router serves heavy anonymous traffic, of each such route). Requests that
   * bring a login or a token are limited to auth.requestsPerMinute (1000) a minute from one
   * address; anonymous requests aren't counted - nobody is looked up for them. The rate limiter
   * is in each route's own chain so that code scanning (CodeQL js/missing-rate-limiting) sees it
   * @param {object} [options]
   * @param {boolean} [options.sessionOnly] count only requests with the session cookie (for this.pages,
   *   which is before every route of the server, and looks at nothing else)
   */
  credentialLimits({ sessionOnly = false } = {}) {
    return {
      windowMs: 60 * 1000,
      // read when a request comes, so a module can make its limiter before auth is initialized
      limit: () => {
        const n = Number(this.config.requestsPerMinute);
        return Number.isInteger(n) && n > 0 ? n : DEFAULT_REQUESTS_PER_MINUTE;
      },
      skip: req => !this.bringsCredentials(req, sessionOnly),
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: 'Too many requests with this login or token from your address - try again in a minute'
    };
  }

  /** The router for /auth (login, account, users) - see pages.js */
  router() {
    this.requireInitialized();
    return require('./pages').buildRouter(this);
  }

  /**
   * The right-most item of every page's top menu ([%account%] in the templates): the name of the
   * user logged in, linked to their account page, or "Login". Pages are made inside the request
   * (this.pages), so this finds it; '' when there is none (a page made outside a request)
   * @param {import('express').Request} [req]
   */
  accountLink(req = this.pageRequests.getStore()) {
    if (!req || !this.initialized) {
      return '';
    }
    const escape = require('escape-html');
    const user = req.session ? this.currentUser(req) : null;
    if (user) {
      return `<a href="/auth/account" style="color: gold" title="Your account">${escape(user.name || user.login)}</a>`;
    }
    // from the /auth pages (the login page, a password link), not back to them
    const url = typeof req.originalUrl === 'string' && !req.originalUrl.startsWith('/auth/') ? this.loginUrl(req) : '/auth/login';
    return `<a href="${escape(url)}" style="color: gold">Login</a>`;
  }

  sendError(req, res, status, message) {
    require('./pages').sendError(this, req, res, status, message);
  }
}

module.exports = { Auth, Principal, presentedToken, safeReturn, isLocalUrl, redirectBack, SERVER, ADMINISTRATOR, BY_CONFIGURATION, MIN_PASSWORD, INTERNAL_HEADER, SESSION_COOKIE };
