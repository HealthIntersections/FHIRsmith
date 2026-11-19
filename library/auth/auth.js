// library/auth/auth.js
// One login for the whole server. Every module asks this who a request is - a person logged
// in with a session cookie, or software presenting an API token - and what they may do.
//
//  - Users log in with a password, or with GitHub. Anyone can make an account with GitHub; it
//    has no roles until the administrator gives it some. The administrator makes password
//    accounts, and the password is set from a link that is emailed (and the same for a
//    forgotten password). Passwords are at least 15 characters.
//  - Roles: "administrator" is server wide, and passes every check. Modules define their own
//    roles (ips: manager of a project; publisher: queue/approve for a website...), some of
//    them scoped (to a project, a website...), and grant them on their own pages or on the
//    user's page here.
//  - Software uses API tokens, which a user issues (or the administrator issues for them) and
//    which carry that user's roles.
//  - Who is an administrator is said by the configuration (auth.administrators: email addresses
//    or github:{name}), and by the role granted on the users page.
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
const { requireSameOrigin } = require('../same-origin');
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

/** A return path that stays on this server: a local path, never //host or /\host */
function safeReturn(value, fallback = '/') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || value.length > 2000 || /[\r\n]/.test(value)) {
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
    this.github = this.config.github && this.config.github.clientId && this.config.github.clientSecret ? this.config.github : null;
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
    this.log.info(`Auth: users in ${dbPath}; ${this.github ? 'GitHub login on' : 'no GitHub login (auth.github)'}; ` +
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
   * The configured administrators: {emails, github} (lower case). Only emails and GitHub
   * names: a bare login could be taken by anyone who makes an account with GitHub first
   */
  configuredAdministrators() {
    const list = Array.isArray(this.config.administrators) ? this.config.administrators : [];
    const out = { emails: new Set(), github: new Set(), invalid: [] };
    for (const raw of list) {
      if (typeof raw !== 'string' || !raw.trim()) {
        continue;
      }
      const v = raw.trim().toLowerCase();
      if (v.startsWith('github:')) {
        out.github.add(v.substring(7));
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
    return !!user && ((user.email && admins.emails.has(user.email.toLowerCase())) ||
      // only an account GitHub has vouched for (a github_id) matches a github: entry
      (user.github_id && user.github_login && admins.github.has(user.github_login.toLowerCase())));
  }

  /**
   * Make an account for each configured administrator email that has none, so the password
   * can be set from a link (Forgot password, or node server.js --password-link)
   */
  applyConfiguredAdministrators() {
    const admins = this.configuredAdministrators();
    for (const email of admins.emails) {
      if (!this.store.userByEmail(email)) {
        const id = this.store.createUser({ login: this.store.freeLogin(email), email, name: '', notes: 'An administrator named in the configuration' });
        this.log.info(`Auth: made the account for the configured administrator ${email} (id ${id}); set its password with Forgot password, or node server.js --password-link ${email}`);
      }
    }
    for (const bad of admins.invalid) {
      this.log.warn(`Auth: auth.administrators entry '${bad}' is neither an email address nor github:{name} - ignored`);
    }
    if (admins.emails.size + admins.github.size === 0) {
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

  /** The user logged in with this request's session (sync), or null */
  currentUser(req) {
    if (!this.store || !req.session || !req.session.auth) {
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
   * The base URL links in emails start with: auth.publicUrl, else hostName (https, or http
   * when cookieSecure is false), else the request's. hostName comes before the request so
   * that a forged Host header can't point a password link at another site.
   */
  publicUrl(req) {
    if (typeof this.config.publicUrl === 'string' && /^https?:\/\//.test(this.config.publicUrl)) {
      return this.config.publicUrl.replace(/\/+$/, '');
    }
    if (this.hostName && /^[A-Za-z0-9.-]+(:\d+)?$/.test(this.hostName)) {
      return `${this.config.cookieSecure === false ? 'http' : 'https'}://${this.hostName}`;
    }
    if (req) {
      return `${req.protocol}://${req.get('host')}`;
    }
    return null;
  }

  /**
   * A link that sets the user's password (any earlier one stops working)
   * @returns {string|null} the URL, or null if there is no public URL to make it from
   */
  passwordLink(userId, req, back = '') {
    this.requireInitialized();
    const base = this.publicUrl(req);
    if (!base) {
      return null;
    }
    const ret = safeReturn(back, '');
    return `${base}/auth/reset/${this.store.createLink(userId, this.linkMinutes)}${ret ? `?return=${encodeURIComponent(ret)}` : ''}`;
  }

  canEmail() {
    return !!(this.mailer && this.mailer.configured());
  }

  /** Email a user a link that sets their password. Resolves true if it was sent */
  async emailPasswordLink(user, req, reason = 'reset', back = '') {
    if (!this.canEmail() || !user || !user.email) {
      return false;
    }
    const link = this.passwordLink(user.id, req, back);
    const where = this.publicUrl(req) || 'FHIRsmith';
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
    const how = c => [[c.password, 'with a password'], [c.github, 'with GitHub']].filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`);
    const logins = s.logins.password + s.logins.github;
    const failed = s.failed.password + s.failed.github;
    const sentences = [];
    let first = `${plural(logins, 'login')}${logins > 0 && how(s.logins).length > 1 ? ` (${how(s.logins).join(', ')})` : ''}`;
    first += `, and ${plural(failed, 'failed login')} for accounts that exist${failed > 0 && how(s.failed).length > 1 ? ` (${how(s.failed).join(', ')})` : ''}.`;
    sentences.push(first.charAt(0).toUpperCase() + first.slice(1));
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

module.exports = { Auth, Principal, presentedToken, safeReturn, SERVER, ADMINISTRATOR, BY_CONFIGURATION, MIN_PASSWORD, INTERNAL_HEADER, SESSION_COOKIE };
