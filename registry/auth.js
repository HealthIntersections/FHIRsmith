// registry/auth.js
// Securing the registry's API. With modules.registry.security.required (or OIDC configured),
// every JSON API call must come from:
//
//   - a user of this server (library/auth) with the registry "member" role - software sends
//     the user's API token (Authorization: Bearer {token}, or Api-Key: {token}, the two headers
//     the HL7 Java tooling sends for a server in fhir-settings.json; X-API-Key works too), and a
//     person logged in with a browser works too
//   - oidc: a JWT issued by an enterprise identity provider (OAuth2 client credentials for
//     software, the usual login flow for people), verified against the issuer's published
//     keys: issuer, audience, expiry and, if configured, a scope or role
//
// Without it the API is open, as it has always been. Only the JSON API (/ and /resolve answering
// JSON, /choose-server) is protected. The HTML pages, the OpenAPI description and the login page
// stay open, so that a client can find out how to authenticate.
//
// Users, logins, roles and tokens are the server's (library/auth); the registry keeps its
// documents, and counts the requests each user and OIDC client makes, in its own database.

const path = require('path');
const rateLimit = require('express-rate-limit');
const escape = require('escape-html');
const auth = require('../library/auth');
const folders = require('../library/folder-setup');
const { tokenConfigured } = require('../library/request-token');
const { AuthStore } = require('./auth-store');
const { RegistryDocuments } = require('./documents');

// failed authentications allowed per address per 15 minutes, before 429s
const DEFAULT_FAILED_AUTH_PER_WINDOW = 60;
const DEFAULT_DATABASE = 'registry-auth.db';
const DEFAULT_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];
const USAGE_FLUSH_MS = 60 * 1000;
const ROLE = 'member';

// the requests already authenticated, and who they are (a promise)
const AUTHENTICATED = new WeakMap();

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
    this.oidcConfig = this.config.oidc && typeof this.config.oidc === 'object' ? this.config.oidc : null;
    // before the server's login system, a configured apiToken or users closed the API: they
    // still do, so a closed registry doesn't open on upgrade (the credentials themselves are gone)
    this.legacy = tokenConfigured(this.config.apiToken) || !!this.config.users;
    this.required = this.config.required === true || this.legacy;
    this.store = null;
    this.jwks = null;
    this.jose = null;
    this.flushTimer = null;
  }

  /** Is the API secured at all? */
  get enabled() {
    return !!(this.required || this.oidcConfig);
  }

  /** The ways in, for the log and the pages */
  get methods() {
    const m = [];
    if (this.enabled) m.push(`users with the registry "${ROLE}" role`);
    if (this.oidcConfig) m.push(`oidc (${this.oidcConfig.issuer})`);
    return m;
  }

  async initialize() {
    auth.defineRoles('registry', [{ role: ROLE, label: 'Use the registry', description: 'Call the API when it is secured (modules.registry.security), and read the documents that are not public' }], { title: 'Registry', path: '/tx-reg' });
    auth.addAdminPage('registry', { label: 'Usage', path: '/tx-reg/usage', description: 'who has used the registry API' });
    if (this.legacy) {
      this.log.warn('Registry security: security.apiToken and security.users are no longer used - the API stays closed: ' +
        `give the clients' users the registry "${ROLE}" role, and an API token (set security.required: true, and remove them)`);
    }
    const db = this.config.database || (this.config.users && this.config.users.database) || DEFAULT_DATABASE;
    const dbPath = db === ':memory:' || path.isAbsolute(db) ? db : path.join(folders.databasesDir(), db);
    if (dbPath !== ':memory:') {
      require('fs').mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.store = new AuthStore(dbPath);
    this.flushTimer = setInterval(() => {
      try {
        this.store.flush();
      } catch (e) {
        this.log.error(`Registry security: could not write usage: ${e.message}`);
      }
    }, USAGE_FLUSH_MS);
    this.flushTimer.unref();
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
   * Who the request is, or null - worked out once per request (the limiter and the guard
   * both ask): {kind: oidc|token|session|internal, principal, name, member}
   */
  authenticate(req) {
    if (!AUTHENTICATED.has(req)) {
      AUTHENTICATED.set(req, this.authenticateRequest(req));
    }
    return AUTHENTICATED.get(req);
  }

  async authenticateRequest(req) {
    const token = auth.presentedToken(req);
    if (this.oidcConfig && looksLikeJwt(token)) {
      const who = await this.verifyJwt(token);
      return who ? { ...who, member: true } : null;
    }
    const p = await auth.principal(req);
    if (!p) {
      return null;
    }
    return { kind: p.via, principal: `user:${p.id}`, name: p.login, userId: p.id, member: p.has('registry', ROLE) };
  }

  /**
   * The session middleware (the server's), so a page can say who is logged in. It makes no
   * session for a visitor without one
   */
  optionalSession() {
    return auth.session;
  }

  /**
   * Express middleware for the JSON API, before apiGuard(): a limit on failed
   * authentications - only the requests answered 401 count, and a request with a valid token
   * is never held back, so a busy client with a good token is never slowed - per address,
   * `failedAuthPerWindow` (default 60) in 15 minutes; past it, the address gets 429 for the
   * rest of the window. Guessing tokens, and making the server check one bad JWT after
   * another, is what it stops; general volume is the proxy's business. Does nothing when no
   * security is configured, or for the HTML pages (which apiGuard lets through), or when
   * failedAuthPerWindow is 0.
   */
  apiLimiter() {
    const limit = Number.isInteger(this.config.failedAuthPerWindow) && this.config.failedAuthPerWindow >= 0 ? this.config.failedAuthPerWindow : DEFAULT_FAILED_AUTH_PER_WINDOW;
    if (limit === 0) {
      return (req, res, next) => next();
    }
    return rateLimit({
      windowMs: 15 * 60 * 1000,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      // the token first: a valid one is never limited, even from an address over the limit
      // (a NAT with one client retrying a bad token doesn't lock out the others behind it)
      skip: async (req) => !this.enabled || (req.headers.accept || '').includes('text/html') || (await this.authenticate(req).catch(() => null)) !== null,
      requestWasSuccessful: (req, res) => res.statusCode !== 401,
      skipSuccessfulRequests: true,
      handler: (req, res) => res.status(429).json({ error: 'too-many-requests', message: 'Too many requests with a token that is not valid for this registry; try again later' })
    });
  }

  /**
   * Express middleware for the JSON API: lets an authenticated member through (and counts
   * it), and answers 401 (no one) or 403 (not a member) otherwise. Does nothing when no
   * security is configured
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
        if (!who.member) {
          return res.status(403).json({ error: 'forbidden', message: `${who.name} is not a member of this registry (the registry "${ROLE}" role)` });
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
    res.setHeader('WWW-Authenticate', 'Bearer realm="tx-reg"');
    res.status(401).json({
      error: 'unauthorized',
      message: auth.presentsToken(req) ? 'The token is not valid for this registry' :
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
        // jose checks exp only when the claim is there: a token without one would never expire
        requiredClaims: ['exp'],
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

  // ---- the pages ----

  /** Add the documents' routes to the registry's router (users and logins are the server's) */
  setupRoutes(router) {
    this.session = auth.session;
    this.csrf = auth.csrf;
    this.csrfIfLoggedIn = auth.csrfIfLoggedIn;
    this.form = auth.form;
    this.sameOrigin = auth.sameOrigin;
    // the old login and users pages
    router.get('/login', (req, res) => res.redirect(auth.loginUrl(req, req.baseUrl || '/')));
    router.get('/admin/users', (req, res) => res.redirect('/auth/admin/users'));
    router.get('/account', (req, res) => res.redirect('/auth/account'));
    this.documents = new RegistryDocuments(this, this.log);
    this.documents.setupRoutes(router);
    // the requests made by each client, for the administrators
    router.get('/usage', auth.session, auth.csrf, auth.requireAdmin((req, res, status, message) => this.sendError(req, res, status, message)),
      (req, res) => this.sendUsage(req, res));
  }

  sendUsage(req, res) {
    const rows = this.store.allUsage();
    let h = `<p>The API requests made by each client since ${this.enabled ? 'the registry was secured' : 'counting began'}: users of this server (by their API tokens or a login), and OIDC clients (by their client id). ` +
      `${this.enabled ? '' : 'The API is open, so only the requests that sent a token are counted. '}` +
      'Users get the registry "member" role, and their tokens, on the <a href="/auth/admin/users">users</a> pages.</p>';
    h += '<table class="grid"><thead><tr><th>Client</th><th>Kind</th><th>Requests</th><th>First seen</th><th>Last seen</th></tr></thead><tbody>';
    for (const u of rows) {
      let client = u.principal;
      const m = /^user:(\d+)$/.exec(u.principal);
      if (m) {
        const user = auth.user(Number(m[1]));
        client = user ? `<a href="/auth/admin/users/${user.id}">${escape(user.login)}</a>` : `${escape(u.principal)} (deleted)`;
      } else {
        client = escape(u.principal.replace(/^oidc:/, ''));
      }
      h += `<tr><td>${client}</td><td>${escape(u.kind)}</td><td>${u.requests}</td><td>${escape(String(u.first_seen).substring(0, 10))}</td><td>${escape(String(u.last_seen).substring(0, 16).replace('T', ' '))}</td></tr>`;
    }
    if (rows.length === 0) {
      h += '<tr><td colspan="5"><i>none yet</i></td></tr>';
    }
    h += '</tbody></table>';
    this.renderPage(req, res, 'Registry Usage', h, 200);
  }

  /** The navbar links for these pages; the registry puts them in its template */
  navLinks(req) {
    // pages rendered without a request (the registry's own) link as the template does
    const base = escape(typeof req.baseUrl === 'string' ? req.baseUrl : '/tx-reg');
    const user = req.session ? this.currentUser(req) : null;
    let h = ` &nbsp;|&nbsp; <a href="${base}/docs" style="color: gold">Documents</a>`;
    if (user && user.isAdmin) {
      h += ` &nbsp;|&nbsp; <a href="${base}/usage" style="color: gold">Usage</a>`;
    }
    return h;
  }

  /**
   * Who is logged in (library/auth): {id, login, name, isAdmin, member}. member: may read the
   * documents that are not public
   */
  currentUser(req) {
    const p = auth.currentUser(req);
    return p ? { id: p.id, login: p.login, name: p.name, isAdmin: p.isAdmin, member: p.has('registry', ROLE) } : null;
  }

  /** The logged in user (session), for other parts of the registry; null if none */
  sessionUser(req) {
    return this.currentUser(req);
  }

  loginUrl(req) {
    return auth.loginUrl(req);
  }

  sendError(req, res, status, message) {
    res.status(status);
    this.renderPage(req, res, 'Error', `<div class="alert alert-danger">${escape(message)}</div>`, status);
  }
}

module.exports = { RegistryAuth, presentedToken: auth.presentedToken, looksLikeJwt };
