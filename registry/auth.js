// registry/auth.js
// Securing the registry's API. Three ways, any of which can be configured, together or
// alone, under modules.registry.security; with none of them the API is open, as it has
// always been:
//
//   apiToken  - one token the administrator sets, that every API call must carry
//   users     - users the administrator (or they themselves) manage on the registry's
//               pages, each with their own tokens (stored hashed, shown once)
//   oidc      - JWTs issued by an enterprise identity provider (OAuth2 client credentials
//               for software, the usual login flow for people), verified against the
//               issuer's published keys: issuer, audience, expiry and, if configured, a
//               scope or role
//
// Only the JSON API (/ and /resolve answering JSON) is protected. The HTML pages, the
// OpenAPI description and the login page stay open, so that a client can find out how
// to authenticate. A token is sent as `Authorization: Bearer {token}` or `Api-Key:
// {token}` (the two headers the HL7 Java tooling sends for a server in fhir-settings.json);
// `X-API-Key` is accepted too.
//
// Users are mostly software, so a user's token is the credential that matters; the
// password is for the user's own page (see their tokens and usage, rotate a token).

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const lusca = require('lusca');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const escape = require('escape-html');
const folders = require('../library/folder-setup');
const { tokenMatches, tokenConfigured } = require('../library/request-token');
const { requireSameOrigin } = require('../library/same-origin');
const { AuthStore } = require('./auth-store');
const { RegistryDocuments } = require('./documents');

const DEFAULT_DATABASE = 'registry-auth.db';
const DEFAULT_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];
const LOGIN_RE = /^[a-z0-9][a-z0-9._@-]{1,63}$/i;
const USAGE_FLUSH_MS = 60 * 1000;

/**
 * The token a request carries, if any: Authorization: Bearer, Api-Key or X-API-Key.
 * A repeated header (an array) is refused
 */
function presentedToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(auth);
    if (m) {
      return { token: m[1], scheme: 'bearer' };
    }
  }
  for (const name of ['api-key', 'x-api-key']) {
    const v = req.headers[name];
    if (typeof v === 'string' && v.trim()) {
      return { token: v.trim(), scheme: 'api-key' };
    }
  }
  return null;
}

function looksLikeJwt(token) {
  return typeof token === 'string' && /^[\w-]+\.[\w-]+\.[\w-]*$/.test(token);
}

class RegistryAuth {
  /**
   * @param {object} config modules.registry.security
   * @param {object} options
   * @param {object} options.logger
   * @param {function} options.renderPage (req, res, title, content, status) => void - the
   *   registry's page rendering, so these pages look like the rest
   */
  constructor(config, { logger, renderPage }) {
    this.config = config || {};
    this.log = logger || console;
    this.renderPage = renderPage;
    this.apiToken = tokenConfigured(this.config.apiToken) ? this.config.apiToken : null;
    this.usersConfig = this.config.users && typeof this.config.users === 'object' ? this.config.users : null;
    this.oidcConfig = this.config.oidc && typeof this.config.oidc === 'object' ? this.config.oidc : null;
    this.store = null;
    this.jwks = null;
    this.jose = null;
    this.flushTimer = null;
  }

  /** Is the API secured at all? */
  get enabled() {
    return !!(this.apiToken || this.usersConfig || this.oidcConfig);
  }

  /** The configured methods, for the log and the pages */
  get methods() {
    const m = [];
    if (this.apiToken) m.push('api token');
    if (this.usersConfig) m.push('users');
    if (this.oidcConfig) m.push(`oidc (${this.oidcConfig.issuer})`);
    return m;
  }

  async initialize() {
    if (this.usersConfig) {
      const db = this.usersConfig.database || DEFAULT_DATABASE;
      const dbPath = db === ':memory:' || path.isAbsolute(db) ? db : path.join(folders.databasesDir(), db);
      if (dbPath !== ':memory:') {
        require('fs').mkdirSync(path.dirname(dbPath), { recursive: true });
      }
      this.store = new AuthStore(dbPath);
      this.adminUsername = typeof this.usersConfig.adminUsername === 'string' && this.usersConfig.adminUsername ? this.usersConfig.adminUsername : 'admin';
      this.adminHash = tokenConfigured(this.usersConfig.adminPassword) ? bcrypt.hashSync(this.usersConfig.adminPassword, 10) : null;
      // compared against when a login names no user, so that takes as long as a real one
      this.dummyHash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
      if (!this.adminHash) {
        this.log.warn('Registry security: users are configured but there is no adminPassword - nobody can create users');
      }
      this.setupSession();
      this.flushTimer = setInterval(() => {
        try {
          this.store.flush();
        } catch (e) {
          this.log.error(`Registry security: could not write usage: ${e.message}`);
        }
      }, USAGE_FLUSH_MS);
      this.flushTimer.unref();
    }
    if (this.oidcConfig) {
      this.setupOidc();
    }
    if (this.enabled) {
      this.log.info(`Registry security: API requires authentication (${this.methods.join(', ')})`);
    }
  }

  shutdown() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.store) {
      this.store.close();
      this.store = null;
    }
  }

  // ---- authenticating API requests ----

  /**
   * Who is making this request, by any of the configured methods
   * @returns {Promise<{kind: string, principal: string, name: string}|null>}
   */
  async authenticate(req) {
    const presented = presentedToken(req);
    if (!presented) {
      return null;
    }
    const { token } = presented;
    if (this.oidcConfig && looksLikeJwt(token)) {
      return this.verifyJwt(token);
    }
    if (this.apiToken && tokenMatches(this.apiToken, token)) {
      return { kind: 'api-token', principal: 'api-token', name: 'API token' };
    }
    if (this.store) {
      const t = this.store.authenticateToken(token);
      if (t) {
        return { kind: 'token', principal: `token:${t.tokenId}`, name: t.login, userId: t.userId };
      }
    }
    return null;
  }

  /**
   * Express middleware for the JSON API: lets an authenticated request through (and
   * counts it), and answers 401 otherwise. Does nothing when no security is configured
   */
  apiGuard() {
    return (req, res, next) => {
      if (!this.enabled) {
        return next();
      }
      this.authenticate(req).then(who => {
        if (!who) {
          return this.unauthorized(req, res);
        }
        req.registryUser = who;
        if (this.store) {
          this.store.countRequest(who.principal, who.kind);
        }
        next();
      }).catch(e => {
        this.log.error(`Registry security: ${e.message}`);
        this.unauthorized(req, res);
      });
    };
  }

  unauthorized(req, res) {
    const challenge = [];
    if (this.oidcConfig || this.apiToken || this.store) {
      challenge.push('Bearer realm="tx-reg"');
    }
    res.setHeader('WWW-Authenticate', challenge.join(', ') || 'Bearer');
    const presented = presentedToken(req);
    res.status(401).json({
      error: 'unauthorized',
      message: presented ? 'The token is not valid for this registry' :
        'This registry requires a token: send it as Authorization: Bearer {token} or Api-Key: {token}',
      documentation: `${req.baseUrl || ''}/openapi`
    });
  }

  // ---- OIDC / JWT ----

  setupOidc() {
    const c = this.oidcConfig;
    if (typeof c.issuer !== 'string' || !/^https:\/\//.test(c.issuer)) {
      throw new Error('modules.registry.security.oidc.issuer must be an https URL');
    }
    if (!c.audience || (typeof c.audience !== 'string' && !Array.isArray(c.audience))) {
      throw new Error('modules.registry.security.oidc.audience is required (a string or list of strings)');
    }
    // https, except on loopback (tests, and a key server on the same box)
    if (c.jwksUri !== undefined && !/^https:\/\//.test(String(c.jwksUri)) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(String(c.jwksUri))) {
      throw new Error('modules.registry.security.oidc.jwksUri must be an https URL');
    }
    try {
      this.jose = require('jose');
    } catch (e) {
      throw new Error('OIDC security needs the jose package: npm install jose');
    }
    // asymmetric only: a shared HMAC secret would defeat the point of an identity provider
    this.algorithms = (Array.isArray(c.algorithms) && c.algorithms.length > 0 ? c.algorithms : DEFAULT_ALGORITHMS)
      .filter(a => typeof a === 'string' && !/^HS/i.test(a));
    if (this.algorithms.length === 0) {
      throw new Error('modules.registry.security.oidc.algorithms must name at least one asymmetric algorithm (RS256, ES256, ...)');
    }
    this.requiredScope = typeof c.requiredScope === 'string' && c.requiredScope ? c.requiredScope : null;
    this.jwks = c.jwksUri ? this.makeJwks(c.jwksUri) : null; // else discovered on first use
    this.discovering = null;
  }

  makeJwks(uri) {
    return this.jose.createRemoteJWKSet(new URL(uri), { cooldownDuration: 30000, timeoutDuration: 10000 });
  }

  /** The JWKS, from the issuer's discovery document when no jwksUri is configured */
  async getJwks() {
    if (this.jwks) {
      return this.jwks;
    }
    if (!this.discovering) {
      const url = this.oidcConfig.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration';
      this.discovering = (async () => {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} from ${url}`);
        }
        const doc = await res.json();
        if (typeof doc.jwks_uri !== 'string' || !/^https:\/\//.test(doc.jwks_uri)) {
          throw new Error(`${url} has no https jwks_uri`);
        }
        this.jwks = this.makeJwks(doc.jwks_uri);
        this.log.info(`Registry security: OIDC keys from ${doc.jwks_uri}`);
        return this.jwks;
      })().catch(e => {
        this.discovering = null; // try again next time
        throw new Error(`OIDC discovery failed: ${e.message}`);
      });
    }
    return this.discovering;
  }

  /**
   * Verify a JWT against the issuer: signature, issuer, audience, time, and the
   * required scope (in scp, scope or roles) if there is one
   */
  async verifyJwt(token) {
    let payload;
    try {
      const jwks = await this.getJwks();
      ({ payload } = await this.jose.jwtVerify(token, jwks, {
        issuer: this.oidcConfig.issuer,
        audience: this.oidcConfig.audience,
        algorithms: this.algorithms,
        clockTolerance: 60
      }));
    } catch (e) {
      this.log.info(`Registry security: JWT rejected: ${e.code || e.name}: ${e.message}`);
      return null;
    }
    if (this.requiredScope && !this.hasScope(payload, this.requiredScope)) {
      this.log.info(`Registry security: JWT for ${payload.sub} lacks ${this.requiredScope}`);
      return null;
    }
    const client = payload.azp || payload.client_id || payload.appid || payload.sub || '?';
    return { kind: 'oidc', principal: `oidc:${client}`, name: String(client), claims: payload };
  }

  hasScope(payload, wanted) {
    const values = [];
    for (const claim of ['scp', 'scope']) {
      const v = payload[claim];
      if (typeof v === 'string') {
        values.push(...v.split(/\s+/));
      } else if (Array.isArray(v)) {
        values.push(...v);
      }
    }
    if (Array.isArray(payload.roles)) {
      values.push(...payload.roles);
    }
    return values.includes(wanted);
  }

  // ---- the pages: login, users, account ----

  setupSession() {
    if (!this.usersConfig.sessionSecret) {
      this.log.warn('Registry security: no users.sessionSecret configured - using a random one, so logins will not survive a restart');
    }
    this.session = session({
      name: 'txreg.sid',
      secret: this.usersConfig.sessionSecret || crypto.randomBytes(64).toString('hex'),
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: this.usersConfig.cookieSecure ?? true,
        sameSite: 'lax',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
      }
    });
    this.csrf = lusca.csrf({ key: '_csrf' });
    this.form = express.urlencoded({ extended: false, limit: '64kb' });
    this.sameOrigin = requireSameOrigin((req, res) => this.sendError(req, res, 403, 'Cross-site form posts are not accepted'));
  }

  /**
   * Add the login, administration and account routes to the registry's router. Only
   * when users are configured - the other methods have no pages
   */
  setupRoutes(router) {
    if (!this.store) {
      return;
    }
    const r = router;
    const loginLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: this.usersConfig.loginAttemptsPerWindow ?? 20,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (req, res) => this.sendLogin(req, res, 429, 'Too many login attempts - try again later')
    });
    const admin = (req, res, next) => {
      const user = this.currentUser(req);
      if (!user) {
        return res.redirect(req.baseUrl + '/login');
      }
      if (!user.isAdmin) {
        return this.sendError(req, res, 403, 'Only the administrator can do that');
      }
      req.user = user;
      next();
    };
    // a user's own page: any user with a record (an administrator too); the configured
    // administrator has no record, and so no tokens of its own
    const self = (req, res, next) => {
      const user = this.currentUser(req);
      if (!user) {
        return res.redirect(req.baseUrl + '/login');
      }
      if (user.id === 0) {
        return res.redirect(req.baseUrl + '/admin/users');
      }
      req.user = user;
      next();
    };
    const h = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => {
      this.log.error(`Registry security page: ${e.message}`);
      this.sendError(req, res, 500, e.message);
    });

    // Every page with a form has this.session, this.csrf; every form post has sameOrigin,
    // this.session, form, this.csrf - written out per route so the CSRF middleware is
    // visible on every cookie-using route
    r.get('/login', this.session, this.csrf, h((req, res) => this.sendLogin(req, res, 200)));
    r.post('/login', this.sameOrigin, loginLimiter, this.session, this.form, this.csrf, h((req, res) => this.login(req, res)));
    r.post('/logout', this.sameOrigin, this.session, this.form, this.csrf, h((req, res) => {
      req.session.destroy(() => res.redirect(req.baseUrl || '/'));
    }));

    r.get('/admin/users', this.session, this.csrf, admin, h((req, res) => this.sendUsers(req, res)));
    r.post('/admin/users', this.sameOrigin, this.session, this.form, this.csrf, admin, h((req, res) => this.createUser(req, res)));
    r.get('/admin/users/:id', this.session, this.csrf, admin, h((req, res) => this.sendUser(req, res)));
    r.post('/admin/users/:id', this.sameOrigin, this.session, this.form, this.csrf, admin, h((req, res) => this.updateUser(req, res)));
    r.post('/admin/users/:id/password', this.sameOrigin, this.session, this.form, this.csrf, admin, h((req, res) => this.adminSetPassword(req, res)));
    r.post('/admin/users/:id/delete', this.sameOrigin, this.session, this.form, this.csrf, admin, h((req, res) => this.deleteUser(req, res)));
    r.post('/admin/users/:id/tokens', this.sameOrigin, this.session, this.form, this.csrf, admin, h((req, res) => this.issueToken(req, res, this.userParam(req), `/admin/users/${this.userParam(req)}`)));
    r.post('/admin/users/:id/tokens/:tid/revoke', this.sameOrigin, this.session, this.form, this.csrf, admin, h((req, res) => this.revokeToken(req, res, this.userParam(req), `/admin/users/${this.userParam(req)}`)));

    r.get('/account', this.session, this.csrf, self, h((req, res) => this.sendAccount(req, res)));
    r.post('/account/tokens', this.sameOrigin, this.session, this.form, this.csrf, self, h((req, res) => this.issueToken(req, res, req.user.id, '/account')));
    r.post('/account/tokens/:tid/revoke', this.sameOrigin, this.session, this.form, this.csrf, self, h((req, res) => this.revokeToken(req, res, req.user.id, '/account')));
    r.post('/account/password', this.sameOrigin, this.session, this.form, this.csrf, self, h((req, res) => this.changePassword(req, res)));

    // the documents live with the users: same database, same sessions, same administrators
    this.documents = new RegistryDocuments(this, this.log);
    this.documents.setupRoutes(r);
  }

  /** The navbar links for these pages; the registry puts them in its template */
  navLinks(req) {
    if (!this.store) {
      return '';
    }
    // pages rendered without a request (the registry's own) link as the template does
    const base = escape(typeof req.baseUrl === 'string' ? req.baseUrl : '/tx-reg');
    const user = req.session ? this.currentUser(req) : null;
    let h = ` &nbsp;|&nbsp; <a href="${base}/docs" style="color: gold">Documents</a>`;
    if (user && user.isAdmin) {
      h += ` &nbsp;|&nbsp; <a href="${base}/admin/users" style="color: gold">Users</a>`;
    }
    if (user && user.id > 0) {
      h += ` &nbsp;|&nbsp; <a href="${base}/account" style="color: gold">${escape(user.login)}</a>`;
    } else if (!user) {
      h += ` &nbsp;|&nbsp; <a href="${base}/login" style="color: gold">Login</a>`;
    }
    return h;
  }

  currentUser(req) {
    const s = req.session;
    if (!s) {
      return null;
    }
    if (s.regAdmin) {
      return { id: 0, login: this.adminUsername, isAdmin: true };
    }
    if (s.regUserId) {
      const u = this.store.userById(s.regUserId);
      if (u && u.enabled) {
        return { id: u.id, login: u.login, name: u.name, isAdmin: u.admin };
      }
    }
    return null;
  }

  /** The logged in user (session), for other parts of the registry; null if none */
  sessionUser(req) {
    return this.store ? this.currentUser(req) : null;
  }

  userParam(req) {
    const id = Number(req.params.id);
    return Number.isInteger(id) && id > 0 ? id : 0;
  }

  // ---- login ----

  sendLogin(req, res, status, error) {
    const base = escape(req.baseUrl || '');
    let h = alert(error, 'danger');
    h += `<form method="post" action="${base}/login" style="max-width: 360px">${csrfField(res)}` +
      '<div class="mb-3"><label for="login" class="form-label">Username</label>' +
      '<input type="text" class="form-control" id="login" name="login" required autocomplete="username"/></div>' +
      '<div class="mb-3"><label for="password" class="form-label">Password</label>' +
      '<input type="password" class="form-control" id="password" name="password" required autocomplete="current-password"/></div>' +
      '<button type="submit" class="btn btn-primary">Login</button></form>';
    h += '<p class="text-muted" style="margin-top: 1em"><small>Software clients don\'t log in: they send their token as ' +
      '<code>Authorization: Bearer {token}</code> or <code>Api-Key: {token}</code>.</small></p>';
    this.renderPage(req, res, 'Login', h, status);
  }

  async login(req, res) {
    const login = typeof req.body.login === 'string' ? req.body.login.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const shown = login.replace(/[^\x20-\x7e]/g, '?').substring(0, 64);
    let ok = false;
    let target = '/account';
    const regenerate = () => new Promise((resolve, reject) => req.session.regenerate(e => e ? reject(e) : resolve()));
    if (login === this.adminUsername) {
      if (this.adminHash && await bcrypt.compare(password, this.adminHash)) {
        await regenerate();
        req.session.regAdmin = true;
        ok = true;
        target = '/admin/users';
      }
    } else {
      const user = login ? this.store.userByLogin(login) : null;
      // the comparison is made whether or not there is such a user, so the time taken
      // doesn't say which usernames exist
      const hash = user && user.password_hash ? user.password_hash : this.dummyHash;
      if (await bcrypt.compare(password, hash) && user && user.password_hash && user.enabled) {
        await regenerate();
        req.session.regUserId = user.id;
        ok = true;
        if (user.admin) {
          target = '/admin/users';
        }
      }
    }
    if (!ok) {
      this.log.info(`Registry security: failed login for '${shown}' from ${req.ip}`);
      return this.sendLogin(req, res, 401, 'Unknown username or wrong password');
    }
    this.log.info(`Registry security: '${shown}' logged in from ${req.ip}`);
    res.redirect((req.baseUrl || '') + target);
  }

  // ---- administration ----

  sendUsers(req, res, message, status = 200) {
    const base = escape(req.baseUrl || '');
    const users = this.store.users();
    let h = userBar(req, res) + alert(message);
    h += '<p>Each user is a client of the API - usually a piece of software - with its own tokens. ' +
      'A user with a password can log in here to see its tokens and usage and rotate them; one without can\'t. ' +
      'An administrator can also manage users and edit documents.</p>';
    h += '<table class="grid"><thead><tr><th>Login</th><th>Name</th><th>Enabled</th><th>Admin</th><th>Tokens</th><th>Requests</th><th>Last used</th><th>Notes</th></tr></thead><tbody>';
    for (const u of users) {
      const tokens = this.store.tokensForUser(u.id);
      const active = tokens.filter(t => t.status === 'active');
      const requests = tokens.reduce((n, t) => n + (t.usage ? t.usage.requests : 0), 0);
      const last = tokens.map(t => t.usage ? t.usage.lastSeen : '').filter(x => x).sort().pop() || '';
      h += `<tr><td><a href="${base}/admin/users/${u.id}">${escape(u.login)}</a></td><td>${escape(u.name)}</td>` +
        `<td>${u.enabled ? 'yes' : '<span class="text-danger">no</span>'}</td><td>${u.admin ? 'yes' : ''}</td>` +
        `<td>${active.length} active${tokens.length > active.length ? ` (${tokens.length - active.length} revoked/expired)` : ''}</td>` +
        `<td>${requests}</td><td>${escape(ago(last))}</td><td>${escape(u.notes)}</td></tr>`;
    }
    if (users.length === 0) {
      h += '<tr><td colspan="8"><i>no users yet</i></td></tr>';
    }
    h += '</tbody></table>';

    h += `<h4 style="margin-top: 1.5em">New user</h4><form method="post" action="${base}/admin/users" style="max-width: 480px">${csrfField(res)}` +
      field('login', 'Login', 'text', 'Letters, digits, . _ @ -; 2-64 characters', true) +
      field('name', 'Name', 'text', 'Who or what this is') +
      field('password', 'Password', 'password', 'Optional: lets the user log in here') +
      field('notes', 'Notes', 'text') +
      '<div class="mb-3"><label><input type="checkbox" name="admin" value="1"/> Administrator (can manage users and edit documents)</label></div>' +
      '<button type="submit" class="btn btn-primary">Create user</button></form>';

    const other = this.store.otherUsage();
    if (other.length > 0 || this.apiToken || this.oidcConfig) {
      h += '<h4 style="margin-top: 1.5em">Other clients</h4>';
      h += '<p class="text-muted"><small>Requests made with the configured API token, and by OIDC clients (by their client id).</small></p>';
      h += '<table class="grid"><thead><tr><th>Client</th><th>Kind</th><th>Requests</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>';
      for (const u of other) {
        h += `<tr><td>${escape(u.principal.replace(/^oidc:/, ''))}</td><td>${escape(u.kind)}</td><td>${u.requests}</td>` +
          `<td>${escape(day(u.first_seen))}</td><td>${escape(ago(u.last_seen))}</td></tr>`;
      }
      if (other.length === 0) {
        h += '<tr><td colspan="5"><i>none yet</i></td></tr>';
      }
      h += '</tbody></table>';
    }
    res.status(status);
    this.renderPage(req, res, 'Registry Users', h, status);
  }

  async createUser(req, res) {
    const login = str(req.body.login).trim();
    const name = str(req.body.name).trim().substring(0, 200);
    const password = str(req.body.password);
    const notes = str(req.body.notes).trim().substring(0, 1000);
    if (!LOGIN_RE.test(login) || login === this.adminUsername) {
      return this.sendUsers(req, res, { text: 'The login must be 2-64 letters, digits, dots, underscores, @ or hyphens, and not the administrator\'s', level: 'danger' }, 400);
    }
    if (password && password.length < 8) {
      return this.sendUsers(req, res, { text: 'A password must be at least 8 characters', level: 'danger' }, 400);
    }
    if (this.store.userByLogin(login)) {
      return this.sendUsers(req, res, { text: `There is already a user '${login}'`, level: 'danger' }, 400);
    }
    const id = await this.store.createUser({ login, name, password: password || null, notes, admin: req.body.admin === '1' });
    this.log.info(`Registry security: user '${login}' created by ${req.user.login}`);
    res.redirect(`${req.baseUrl || ''}/admin/users/${id}`);
  }

  sendUser(req, res, message, status = 200) {
    const base = escape(req.baseUrl || '');
    const user = this.store.userById(this.userParam(req));
    if (!user) {
      return this.sendError(req, res, 404, 'No such user');
    }
    let h = userBar(req, res) + `<p><a href="${base}/admin/users">&laquo; all users</a></p>` + alert(message) + this.newTokenBanner(req);
    h += `<form method="post" action="${base}/admin/users/${user.id}" style="max-width: 480px">${csrfField(res)}` +
      `<p><b>Login:</b> ${escape(user.login)} &nbsp; <b>Created:</b> ${escape(day(user.created_at))}</p>` +
      field('name', 'Name', 'text', '', false, user.name) +
      field('notes', 'Notes', 'text', '', false, user.notes) +
      `<div class="mb-3"><label><input type="checkbox" name="enabled" value="1"${user.enabled ? ' checked' : ''}/> Enabled (a disabled user's tokens don't work, and it can't log in)</label></div>` +
      `<div class="mb-3"><label><input type="checkbox" name="admin" value="1"${user.admin ? ' checked' : ''}/> Administrator (can manage users and edit documents)</label></div>` +
      '<button type="submit" class="btn btn-primary">Save</button></form>';

    h += this.tokensSection(res, this.store.tokensForUser(user.id), `${base}/admin/users/${user.id}/tokens`, true);

    h += `<h4 style="margin-top: 1.5em">Password</h4><p class="text-muted"><small>${user.hasPassword ? 'The user has a password and can log in here.' : 'The user has no password, so it can\'t log in here; its tokens still work.'}</small></p>` +
      `<form method="post" action="${base}/admin/users/${user.id}/password" style="max-width: 480px">${csrfField(res)}` +
      field('password', 'New password', 'password', 'At least 8 characters; empty removes the password') +
      '<button type="submit" class="btn btn-secondary">Set password</button></form>';

    h += `<h4 style="margin-top: 1.5em">Delete</h4><form method="post" action="${base}/admin/users/${user.id}/delete" onsubmit="return confirm('Delete this user and all its tokens?')">${csrfField(res)}` +
      '<button type="submit" class="btn btn-danger">Delete user</button></form>';
    res.status(status);
    this.renderPage(req, res, `User ${user.login}`, h, status);
  }

  updateUser(req, res) {
    const id = this.userParam(req);
    const ok = this.store.updateUser(id, {
      name: str(req.body.name).trim().substring(0, 200),
      notes: str(req.body.notes).trim().substring(0, 1000),
      enabled: req.body.enabled === '1',
      admin: req.body.admin === '1'
    });
    if (!ok) {
      return this.sendError(req, res, 404, 'No such user');
    }
    return this.sendUser(req, res, { text: 'Saved' });
  }

  async adminSetPassword(req, res) {
    const id = this.userParam(req);
    const password = str(req.body.password);
    if (password && password.length < 8) {
      return this.sendUser(req, res, { text: 'A password must be at least 8 characters', level: 'danger' }, 400);
    }
    if (!(await this.store.setPassword(id, password || null))) {
      return this.sendError(req, res, 404, 'No such user');
    }
    return this.sendUser(req, res, { text: password ? 'Password set' : 'Password removed' });
  }

  deleteUser(req, res) {
    const user = this.store.userById(this.userParam(req));
    if (!user) {
      return this.sendError(req, res, 404, 'No such user');
    }
    this.store.deleteUser(user.id);
    this.log.info(`Registry security: user '${user.login}' deleted by ${req.user.login}`);
    return this.sendUsers(req, res, { text: `User '${user.login}' deleted` });
  }

  // ---- tokens (admin and self) ----

  issueToken(req, res, userId, back) {
    const user = this.store.userById(userId);
    if (!user) {
      return this.sendError(req, res, 404, 'No such user');
    }
    const label = str(req.body.label).trim().substring(0, 100);
    const days = Number(str(req.body.expires));
    const expiresInDays = Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 3650) : null;
    const t = this.store.issueToken(user.id, { label, expiresInDays });
    this.log.info(`Registry security: token ${t.prefix} issued for '${user.login}' by ${req.user.login}`);
    // shown once, on the next page
    req.session.newToken = t.token;
    res.redirect((req.baseUrl || '') + back);
  }

  revokeToken(req, res, userId, back) {
    const tid = Number(req.params.tid);
    if (this.store.revokeToken(userId, tid)) {
      const user = this.store.userById(userId);
      this.log.info(`Registry security: token ${tid} of '${user ? user.login : userId}' revoked by ${req.user.login}`);
    }
    res.redirect((req.baseUrl || '') + back);
  }

  newTokenBanner(req) {
    const token = req.session.newToken;
    if (!token) {
      return '';
    }
    delete req.session.newToken;
    return '<div class="alert alert-success"><b>New token:</b> <code style="font-size: 110%">' + escape(token) + '</code>' +
      '<br/><small>Copy it now - it is not stored and cannot be shown again. Send it as <code>Authorization: Bearer ' +
      escape(token.substring(0, 12)) + '...</code></small></div>';
  }

  tokensSection(res, tokens, issueUrl, forAdmin) {
    let h = '<h4 style="margin-top: 1.5em">Tokens</h4>';
    h += '<table class="grid"><thead><tr><th>Token</th><th>Label</th><th>Status</th><th>Created</th><th>Expires</th><th>Requests</th><th>Last used</th><th></th></tr></thead><tbody>';
    for (const t of tokens) {
      const cls = t.status === 'active' ? 'text-success' : 'text-muted';
      h += `<tr><td><code>${escape(t.prefix)}...</code></td><td>${escape(t.label)}</td><td><span class="${cls}">${t.status}</span></td>` +
        `<td>${escape(day(t.created_at))}</td><td>${escape(day(t.expires_at) || 'never')}</td>` +
        `<td>${t.usage ? t.usage.requests : 0}</td><td>${escape(ago(t.usage ? t.usage.lastSeen : ''))}</td><td>`;
      if (t.status === 'active') {
        h += `<form method="post" action="${issueUrl}/${t.id}/revoke" style="display: inline">${csrfField(res)}<button type="submit" class="btn btn-sm btn-outline-danger">Revoke</button></form>`;
      }
      h += '</td></tr>';
    }
    if (tokens.length === 0) {
      h += '<tr><td colspan="8"><i>no tokens</i></td></tr>';
    }
    h += '</tbody></table>';
    h += `<form method="post" action="${issueUrl}" class="row g-2" style="max-width: 640px; margin-top: 0.5em">${csrfField(res)}` +
      '<div class="col"><input type="text" class="form-control" name="label" placeholder="Label (optional)" maxlength="100"/></div>' +
      '<div class="col"><input type="number" class="form-control" name="expires" placeholder="Expires in days (optional)" min="1" max="3650"/></div>' +
      `<div class="col-auto"><button type="submit" class="btn btn-primary">${forAdmin ? 'Issue token' : 'New token'}</button></div></form>`;
    h += '<p class="text-muted"><small>To rotate a token: issue a new one, move the client to it, then revoke the old one.</small></p>';
    return h;
  }

  // ---- a user's own page ----

  sendAccount(req, res, message, status = 200) {
    const base = escape(req.baseUrl || '');
    let h = userBar(req, res) + alert(message) + this.newTokenBanner(req);
    h += `<p>Logged in as <b>${escape(req.user.login)}</b>${req.user.name ? ` (${escape(req.user.name)})` : ''}.</p>`;
    h += this.tokensSection(res, this.store.tokensForUser(req.user.id), `${base}/account/tokens`, false);
    h += `<h4 style="margin-top: 1.5em">Change password</h4><form method="post" action="${base}/account/password" style="max-width: 480px">${csrfField(res)}` +
      field('current', 'Current password', 'password', '', true) +
      field('password', 'New password', 'password', 'At least 8 characters', true) +
      '<button type="submit" class="btn btn-secondary">Change password</button></form>';
    res.status(status);
    this.renderPage(req, res, 'Your Account', h, status);
  }

  async changePassword(req, res) {
    const user = this.store.userById(req.user.id);
    const current = str(req.body.current);
    const password = str(req.body.password);
    if (!(await this.store.checkPassword(user, current))) {
      return this.sendAccount(req, res, { text: 'The current password is wrong', level: 'danger' }, 400);
    }
    if (password.length < 8) {
      return this.sendAccount(req, res, { text: 'A password must be at least 8 characters', level: 'danger' }, 400);
    }
    await this.store.setPassword(user.id, password);
    return this.sendAccount(req, res, { text: 'Password changed' });
  }

  sendError(req, res, status, message) {
    res.status(status);
    this.renderPage(req, res, 'Error', `<div class="alert alert-danger">${escape(message)}</div>`, status);
  }
}

// ---- html bits ----

function str(v) {
  return typeof v === 'string' ? v : '';
}

function csrfField(res) {
  return `<input type="hidden" name="_csrf" value="${escape(res.locals._csrf || '')}"/>`;
}

function alert(message, level) {
  if (!message) {
    return '';
  }
  const text = typeof message === 'string' ? message : message.text;
  const cls = typeof message === 'string' ? (level || 'info') : (message.level || 'info');
  return `<div class="alert alert-${cls}">${escape(text)}</div>`;
}

function field(name, label, type, help, required, value) {
  return `<div class="mb-3"><label for="f-${name}" class="form-label">${escape(label)}</label>` +
    `<input type="${type}" class="form-control" id="f-${name}" name="${name}"${required ? ' required' : ''}` +
    `${value !== undefined ? ` value="${escape(value)}"` : ''}${type === 'password' ? ' autocomplete="new-password"' : ''}/>` +
    (help ? `<div class="form-text">${escape(help)}</div>` : '') + '</div>';
}

function userBar(req, res) {
  const base = escape(req.baseUrl || '');
  const login = req.user ? escape(req.user.login) : '';
  return `<form method="post" action="${base}/logout" style="float: right">${csrfField(res)}` +
    `<span class="text-muted">${login}</span> <button type="submit" class="btn btn-sm btn-outline-secondary">Logout</button></form>`;
}

function day(iso) {
  return iso ? String(iso).substring(0, 10) : '';
}

function ago(iso, now = Date.now()) {
  if (!iso) {
    return 'never';
  }
  const ms = now - new Date(iso).getTime();
  if (!(ms >= 0)) {
    return day(iso);
  }
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

module.exports = { RegistryAuth, presentedToken, looksLikeJwt };
