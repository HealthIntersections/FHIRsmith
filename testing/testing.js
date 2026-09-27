//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The /testing module: a place to send TestReports (from TxTester, and anything else),
 * and to look at them.
 *
 *   POST   {base}/TestReport        create (token required if one is configured)
 *   GET    {base}/TestReport        search - a Bundle, or HTML for a browser
 *   GET    {base}/TestReport/:id    read - JSON, or the rendered report for a browser
 *   DELETE {base}/TestReport/:id    admin only (adminToken)
 *   GET    {base}/metadata          CapabilityStatement
 *   GET    {base}                   the filterable list (HTML)
 *   GET    {base}/summary           latest result per test script x participant (HTML)
 *   GET    {base}/login             login for the administration pages; POST {base}/logout
 *   GET    {base}/admin/links       names for known canonical URLs (users who can edit links)
 *   GET    {base}/admin/users       users and their rights (the administrator only)
 *
 * Logins work as the publisher's do: a session cookie, bcrypt password hashes, a rate
 * limited login. The administrator logs in as 'admin' with the adminPassword from the
 * configuration, and manages the other users; a user can have either or both of the
 * rights to edit the named links and to delete reports.
 *
 * R4 and R5 TestReports are treated as the same thing. Reports can't be changed once
 * received: each POST is a new report, even when it's the same report as before.
 *
 * @module testing/testing
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const escape = require('escape-html');
const session = require('express-session');
const lusca = require('lusca');
const bcrypt = require('bcrypt');

const folders = require('../library/folder-setup');
const htmlServer = require('../library/html-server');
const { tokenMatches, tokenConfigured } = require('../library/request-token');
const { requireSameOrigin } = require('../library/same-origin');
const packageJson = require('../package.json');
const { TestReportStore } = require('./store');
const { parseSearch, dateRange, capabilitySearchParams } = require('./search');
const {
  renderList, renderSummary, renderReport, renderLogin, renderLinks, renderUsers, listQueryToSearch
} = require('./render');

const TEMPLATE = 'testing';
const DEFAULT_MAX_SIZE = 500 * 1024;
const DEFAULT_TOKEN_HEADER = 'Authorization';
const FHIR_JSON = 'application/fhir+json; charset=utf-8';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What's wrong with a submitted resource, if anything.
 *
 * @param {*} r - the parsed JSON
 * @returns {string[]} problems; empty if it's acceptable
 */
function validateReport(r) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) {
    return ['The body must be a JSON object'];
  }
  if (r.resourceType !== 'TestReport') {
    return [`The resource must be a TestReport, not ${typeof r.resourceType === 'string' ? r.resourceType : 'something without a resourceType'}`];
  }
  const problems = [];
  const needString = (name) => {
    if (typeof r[name] !== 'string' || r[name].trim() === '') {
      problems.push(`TestReport.${name} is required`);
    }
  };
  ['name', 'status', 'result', 'tester', 'issued'].forEach(needString);
  if (typeof r.issued === 'string' && r.issued.trim() !== '' && !dateRange(r.issued)) {
    problems.push(`TestReport.issued is not a valid dateTime: '${r.issued}'`);
  }
  if (!Array.isArray(r.participant) || r.participant.length === 0) {
    problems.push('TestReport.participant is required (at least one)');
  } else {
    r.participant.forEach((p, i) => {
      if (p === null || typeof p !== 'object' || typeof p.uri !== 'string' || p.uri.trim() === '') {
        problems.push(`TestReport.participant[${i}].uri is required`);
      }
    });
  }
  if (r.score !== undefined && (typeof r.score !== 'number' || !Number.isFinite(r.score))) {
    problems.push('TestReport.score must be a number');
  }
  if (r.meta !== undefined && (r.meta === null || typeof r.meta !== 'object' || Array.isArray(r.meta))) {
    problems.push('TestReport.meta must be an object');
  }
  return problems;
}

function operationOutcome(severity, code, messages) {
  return {
    resourceType: 'OperationOutcome',
    issue: (Array.isArray(messages) ? messages : [messages]).map(m => ({
      severity, code, details: { text: m }
    }))
  };
}

function preferValue(req, name) {
  const prefer = req.get('Prefer') || '';
  for (const part of prefer.split(/[,;]/)) {
    const [k, v] = part.split('=').map(s => s && s.trim());
    if (k === name) {
      return v ? v.replace(/^"|"$/g, '') : '';
    }
  }
  return null;
}

function wantsHtml(req) {
  const f = req.query._format;
  if (typeof f === 'string' && f !== '') {
    return /html/i.test(f);
  }
  return (req.get('Accept') || '').includes('text/html');
}

class TestingModule {
  /**
   * @param {Object} stats - a ModuleStats
   * @param {Object} [log] - a logger; defaults to the server's
   */
  constructor(stats, log) {
    this.stats = stats;
    this.router = express.Router();
    this.store = null;
    this.config = null;
    this.retentionTimer = null;
    if (log) {
      this.log = log;
    } else {
      const Logger = require('../library/logger');
      this.log = Logger.getInstance().child({ module: 'testing' });
    }
  }

  async initialize(config) {
    this.config = config || {};
    const db = this.config.database || 'testing.db';
    const dbPath = db === ':memory:' || path.isAbsolute(db) ? db : path.join(folders.databasesDir(), db);
    this.store = new TestReportStore(dbPath);
    this.maxSize = Number.isInteger(this.config.maxSize) && this.config.maxSize > 0 ? this.config.maxSize : DEFAULT_MAX_SIZE;
    this.tokenHeader = this.config.tokenHeader || DEFAULT_TOKEN_HEADER;

    htmlServer.loadTemplate(TEMPLATE, path.join(__dirname, 'testing-template.html'));

    this.setupSession();
    this.setupRoutes();
    this.setupAdminRoutes();
    this.setupRetention();
    this.log.info(`Testing module: ${this.store.count()} reports in ${dbPath}; ` +
      `posting ${tokenConfigured(this.config.token) ? 'requires a token' : 'is open'}, max ${this.maxSize} bytes`);
  }

  /**
   * The session (login) cookie and CSRF protection. Neither is put on the whole router:
   * the FHIR API (POST and DELETE of TestReports) is authenticated by a token in a header,
   * not a cookie, so it needs neither and must not be made to carry a CSRF token. The web
   * pages get this.web; every form post gets sameOrigin + this.session + a form parser +
   * this.csrf (see setupAdminRoutes).
   *
   * CSRF has two layers: lusca's per-session token, which every form carries in a hidden
   * _csrf field, and the Origin check (library/same-origin). The cookie is also SameSite=Lax.
   */
  setupSession() {
    if (!this.config.sessionSecret) {
      // as for the publisher: never a constant secret, which would be a published signing key
      this.log.warn('testing: no sessionSecret configured - using a random one, so logins will not ' +
        'survive a restart. Set modules.testing.sessionSecret.');
    }
    this.session = session({
      name: 'testing.sid',
      secret: this.config.sessionSecret || crypto.randomBytes(64).toString('hex'),
      resave: false,
      saveUninitialized: false,
      cookie: {
        // HTTPS only unless cookieSecure is false - see the publisher's notes on nginx
        secure: this.config.cookieSecure ?? true,
        // the browser will not send the cookie on a form posted from another site, which,
        // with the Origin check on every form post, is the CSRF protection
        sameSite: 'lax',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
      }
    });
    const luscaCsrf = lusca.csrf({ key: '_csrf' });
    // lusca reports a bad or missing token by passing an error on; show it as a page
    this.csrf = (req, res, next) => luscaCsrf(req, res, (err) => err
      ? htmlServer.sendErrorResponse(res, TEMPLATE, new Error('The form has expired or did not come from this site - reload the page and try again'), 403)
      : next());
    // the pages show a logout form (which needs a token) only to someone logged in. Making
    // a token stores a secret in the session, so doing it for every visitor would give
    // every crawler a session
    const csrfIfLoggedIn = (req, res, next) => this.currentUser(req) ? this.csrf(req, res, next) : next();
    this.web = [this.session, csrfIfLoggedIn];
  }

  setupRoutes() {
    const r = this.router;
    const rl = this.config.rateLimit || {};
    const max = rl.max === undefined ? 60 : rl.max;
    const posting = [];
    if (max > 0) {
      posting.push(rateLimit({
        windowMs: (rl.windowMinutes || 1) * 60 * 1000,
        limit: max,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        handler: (req, res) => this.sendOutcome(res, 429, 'throttled', 'Too many reports submitted; try again later')
      }));
    }

    r.get('/', ...this.web, (req, res) => this.handle(req, res, 'list', () => this.htmlList(req, res)));
    r.get('/summary', ...this.web, (req, res) => this.handle(req, res, 'summary', () => this.htmlSummary(req, res)));
    r.get('/metadata', (req, res) => this.handle(req, res, 'metadata', () => this.metadata(req, res)));
    r.post('/TestReport', ...posting, (req, res) => this.handle(req, res, 'create', () => this.create(req, res)));
    r.get('/TestReport', ...this.web, (req, res) => this.handle(req, res, 'search', () =>
      wantsHtml(req) ? this.htmlList(req, res) : this.search(req, res)));
    r.get('/TestReport/:id', ...this.web, (req, res) => this.handle(req, res, 'read', () => this.read(req, res)));
    r.delete('/TestReport/:id', (req, res) => this.handle(req, res, 'delete', () => this.remove(req, res)));
  }

  setupRetention() {
    const days = this.config.retentionDays;
    if (!(typeof days === 'number' && days > 0)) {
      return;
    }
    const purge = () => {
      try {
        const n = this.store.purgeBefore(Date.now() - days * DAY_MS);
        if (n > 0) {
          this.log.info(`Testing module: deleted ${n} reports older than ${days} days`);
        }
        if (this.stats) {
          this.stats.taskDone('TestReport retention', `${n} deleted`);
        }
      } catch (e) {
        this.log.error('Testing module: retention purge failed: ' + e.message);
        if (this.stats) {
          this.stats.taskError('TestReport retention', e.message);
        }
      }
    };
    if (this.stats) {
      this.stats.addTask('TestReport retention', 'daily');
    }
    purge();
    this.retentionTimer = setInterval(purge, DAY_MS);
    this.retentionTimer.unref();
  }

  async shutdown() {
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    if (this.store) {
      this.store.close();
      this.store = null;
    }
  }

  // ---- plumbing ----

  async handle(req, res, name, fn) {
    const start = Date.now();
    try {
      await fn();
    } catch (e) {
      this.log.error(`Testing module: ${name} failed: ${e.stack || e.message}`);
      if (!res.headersSent) {
        if (wantsHtml(req)) {
          htmlServer.sendErrorResponse(res, TEMPLATE, e);
        } else {
          this.sendOutcome(res, 500, 'exception', 'Internal error: ' + e.message);
        }
      }
    } finally {
      if (this.stats) {
        this.stats.countRequest(name, Date.now() - start);
      }
    }
  }

  baseUrl(req) {
    return `${req.protocol}://${req.get('host')}${req.baseUrl}`;
  }

  sendJson(res, status, body) {
    res.status(status).set('Content-Type', FHIR_JSON).send(JSON.stringify(body, null, 2));
  }

  sendOutcome(res, status, code, messages) {
    const severity = status < 400 ? 'information' : 'error';
    this.sendJson(res, status, operationOutcome(severity, code, messages));
  }

  sendHtml(res, title, content, start) {
    htmlServer.sendHtmlResponse(res, TEMPLATE, title, content, {
      version: packageJson.version,
      processingTime: Date.now() - start
    });
  }

  /** The token from the configured header, without any "Bearer " prefix. */
  suppliedToken(req) {
    const v = req.get(this.tokenHeader);
    return typeof v === 'string' ? v.replace(/^Bearer\s+/i, '').trim() : v;
  }

  // ---- FHIR API ----

  async create(req, res) {
    if (tokenConfigured(this.config.token) && !tokenMatches(this.config.token, this.suppliedToken(req))) {
      res.set('WWW-Authenticate', 'Bearer');
      return this.sendOutcome(res, 401, 'login', `A valid token is required in the ${this.tokenHeader} header`);
    }
    if (!req.is('application/fhir+json') && !req.is('application/json')) {
      return this.sendOutcome(res, 415, 'not-supported', 'Reports must be JSON (application/fhir+json)');
    }
    const declared = parseInt(req.get('Content-Length') || '', 10);
    if (declared > this.maxSize) {
      return this.sendOutcome(res, 413, 'too-costly', `Reports can't be bigger than ${this.maxSize} bytes`);
    }

    // the server's body parsers have already run: application/fhir+json arrives as a
    // Buffer, application/json already parsed
    let report;
    let size;
    if (Buffer.isBuffer(req.body)) {
      size = req.body.length;
      if (size > this.maxSize) {
        return this.sendOutcome(res, 413, 'too-costly', `Reports can't be bigger than ${this.maxSize} bytes`);
      }
      try {
        report = JSON.parse(req.body.toString('utf8'));
      } catch (e) {
        return this.sendOutcome(res, 400, 'structure', 'The body is not valid JSON: ' + e.message);
      }
    } else if (req.body && typeof req.body === 'object') {
      report = req.body;
      size = Buffer.byteLength(JSON.stringify(report), 'utf8');
      if (size > this.maxSize) {
        return this.sendOutcome(res, 413, 'too-costly', `Reports can't be bigger than ${this.maxSize} bytes`);
      }
    } else {
      return this.sendOutcome(res, 400, 'structure', 'No report was found in the body');
    }

    const problems = validateReport(report);
    if (problems.length > 0) {
      return this.sendOutcome(res, 400, 'invalid', problems);
    }

    // id and lastUpdated are the server's; there are no versions
    const now = Date.now();
    const lastUpdated = new Date(now).toISOString();
    const meta = { ...(report.meta || {}), lastUpdated };
    delete meta.versionId;
    const stored = { resourceType: report.resourceType, id: crypto.randomUUID(), meta };
    for (const [k, v] of Object.entries(report)) {
      if (!(k in stored)) {
        stored[k] = v;
      }
    }
    this.store.insert(stored, { ip: req.ip, receivedMs: now });

    const location = `${this.baseUrl(req)}/TestReport/${stored.id}`;
    res.set('Location', location);
    res.set('Last-Modified', new Date(now).toUTCString());
    const ret = preferValue(req, 'return');
    if (ret === 'minimal') {
      return res.status(201).end();
    }
    if (ret === 'OperationOutcome') {
      return this.sendOutcome(res, 201, 'informational', `Report stored as ${location}`);
    }
    return this.sendJson(res, 201, stored);
  }

  async read(req, res) {
    const start = Date.now();
    const report = this.store.read(req.params.id);
    if (wantsHtml(req)) {
      if (!report) {
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error(`No report with id '${req.params.id}'`), 404);
      }
      return this.sendHtml(res, 'Test Report: ' + (typeof report.name === 'string' ? report.name : report.id),
        renderReport(report, req.baseUrl, { names: this.names(), user: this.currentUser(req), csrf: res.locals._csrf }), start);
    }
    if (!report) {
      return this.sendOutcome(res, 404, 'not-found', `No TestReport with id '${req.params.id}'`);
    }
    res.set('Last-Modified', new Date(report.meta.lastUpdated).toUTCString());
    return this.sendJson(res, 200, report);
  }

  async remove(req, res) {
    if (!tokenConfigured(this.config.adminToken) || !tokenMatches(this.config.adminToken, this.suppliedToken(req))) {
      return this.sendOutcome(res, 403, 'forbidden', 'Deleting reports requires the admin token');
    }
    if (!this.store.delete(req.params.id)) {
      return this.sendOutcome(res, 404, 'not-found', `No TestReport with id '${req.params.id}'`);
    }
    this.log.info(`Testing module: report ${req.params.id} deleted by admin`);
    return res.status(204).end();
  }

  async search(req, res) {
    const search = parseSearch(req.query);
    if (search.errors.length > 0) {
      return this.sendOutcome(res, 400, 'invalid', search.errors);
    }
    if (search.unknown.length > 0 && preferValue(req, 'handling') === 'strict') {
      return this.sendOutcome(res, 400, 'not-supported', search.unknown.map(u => `Unknown search parameter '${u}'`));
    }
    const results = this.store.search(search, { withJson: true });
    const base = this.baseUrl(req);

    const link = (offset) => {
      const u = new URLSearchParams();
      for (const [k, v] of search.used) {
        u.append(k, v);
      }
      if (search.sort) {
        u.append('_sort', search.sort);
      }
      if (search.summaryCount) {
        u.append('_summary', 'count');
      } else {
        u.append('_count', String(search.count));
        u.append('_offset', String(offset));
      }
      return `${base}/TestReport?${u.toString()}`;
    };
    const links = [{ relation: 'self', url: link(search.offset) }];
    if (!search.summaryCount && search.count > 0) {
      links.push({ relation: 'first', url: link(0) });
      if (search.offset > 0) {
        links.push({ relation: 'previous', url: link(Math.max(0, search.offset - search.count)) });
      }
      if (search.offset + search.count < results.total) {
        links.push({ relation: 'next', url: link(search.offset + search.count) });
      }
      links.push({ relation: 'last', url: link(results.total === 0 ? 0 : Math.floor((results.total - 1) / search.count) * search.count) });
    }

    const bundle = {
      resourceType: 'Bundle',
      id: crypto.randomUUID(),
      meta: { lastUpdated: new Date().toISOString() },
      type: 'searchset',
      total: results.total,
      link: links,
      entry: results.rows.map(row => ({
        fullUrl: `${base}/TestReport/${row.id}`,
        resource: JSON.parse(row.json),
        search: { mode: 'match' }
      }))
    };
    if (search.unknown.length > 0) {
      bundle.entry.push({
        resource: operationOutcome('warning', 'not-supported', search.unknown.map(u => `Unknown search parameter '${u}' was ignored`)),
        search: { mode: 'outcome' }
      });
    }
    if (bundle.entry.length === 0) {
      delete bundle.entry;
    }
    return this.sendJson(res, 200, bundle);
  }

  metadata(req, res) {
    const cs = {
      resourceType: 'CapabilityStatement',
      status: 'active',
      date: new Date().toISOString(),
      kind: 'instance',
      software: { name: 'FHIRsmith', version: packageJson.version },
      implementation: {
        description: 'FHIRsmith TestReport repository',
        url: this.baseUrl(req)
      },
      fhirVersion: '5.0.0',
      format: ['json'],
      rest: [{
        mode: 'server',
        documentation: tokenConfigured(this.config.token)
          ? `Submitting a report requires a token in the ${this.tokenHeader} header`
          : 'Anyone may submit a report',
        resource: [{
          type: 'TestReport',
          interaction: [{ code: 'create' }, { code: 'read' }, { code: 'search-type' }],
          versioning: 'no-version',
          readHistory: false,
          updateCreate: false,
          searchParam: capabilitySearchParams()
        }]
      }]
    };
    return this.sendJson(res, 200, cs);
  }

  // ---- HTML ----

  async htmlList(req, res) {
    const start = Date.now();
    const query = req.query || {};
    const search = parseSearch(listQueryToSearch(query));
    let prefix = '';
    if (search.errors.length > 0) {
      prefix = '<div class="alert alert-warning">' + search.errors.map(e => escape(e)).join('<br/>') + '</div>';
      // show everything rather than nothing
      const fallback = parseSearch({ _count: query._count });
      search.where = fallback.where;
      search.args = fallback.args;
    }
    const results = this.store.search(search);
    const content = prefix + renderList(query, results, search, {
      results: this.store.distinct('result'),
      base: req.baseUrl,
      names: this.names(),
      user: this.currentUser(req),
      csrf: res.locals._csrf,
      showClient: this.store.hasParticipantType('client')
    });
    this.sendHtml(res, 'Test Reports', content, start);
  }

  async htmlSummary(req, res) {
    const start = Date.now();
    const by = req.query.by === 'tester' ? 'tester' : 'participant';
    this.sendHtml(res, 'Test Report Summary', renderSummary(this.store.summary(by), by, req.baseUrl, this.store.testerCounts(),
      { names: this.names(), user: this.currentUser(req), csrf: res.locals._csrf }), start);
  }

  // ---- users, named links, and the administration pages ----

  /** The named links, by unversioned canonical. Cached until they change. */
  names() {
    if (!this.namesCache) {
      this.namesCache = new Map(this.store.links().map(l => [l.canonical, l]));
    }
    return this.namesCache;
  }

  /**
   * Who is logged in, with their rights as they are now (not as they were at login, so
   * taking a right away, or deleting the user, takes effect at once).
   */
  currentUser(req) {
    const s = req.session;
    if (!s) {
      return null;
    }
    if (s.testingAdmin) {
      return { name: 'Administrator', isAdmin: true, canEditLinks: true, canDeleteReports: true };
    }
    if (s.testingUserId) {
      const u = this.store.userById(s.testingUserId);
      if (u) {
        return { id: u.id, name: u.name, isAdmin: false, canEditLinks: !!u.can_edit_links, canDeleteReports: !!u.can_delete_reports };
      }
    }
    return null;
  }

  setupAdminRoutes() {
    const r = this.router;
    const form = express.urlencoded({ extended: false, limit: '64kb' });
    const loginLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: this.config.loginAttemptsPerWindow ?? 20,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (req, res) => this.sendLogin(req, res, 429, 'Too many login attempts - try again later')
    });
    // every form post must come from one of our own pages
    const sameOrigin = requireSameOrigin((req, res) =>
      htmlServer.sendErrorResponse(res, TEMPLATE, new Error('Cross-site form posts are not accepted'), 403));
    // a right, or the administrator
    const need = (right) => (req, res, next) => {
      const user = this.currentUser(req);
      if (!user) {
        return res.redirect(req.baseUrl + '/login');
      }
      if (!(user.isAdmin || (right && user[right]))) {
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error('You do not have permission to do that'), 403);
      }
      req.user = user;
      next();
    };
    const h = (name, fn) => (req, res) => this.handle(req, res, name, () => fn(req, res));
    // what every page with a form needs, and what every form post needs
    const page = [this.session, this.csrf];
    const post = [sameOrigin, this.session, form, this.csrf];

    r.get('/login', ...page, h('login', (req, res) => this.sendLogin(req, res, 200)));
    r.post('/login', sameOrigin, loginLimiter, this.session, form, this.csrf, h('login', (req, res) => this.login(req, res)));
    r.post('/logout', ...post, h('logout', (req, res) => {
      req.session.destroy(() => res.redirect(req.baseUrl || '/'));
    }));

    r.get('/admin/links', ...page, need('canEditLinks'), h('links', (req, res) => this.sendLinks(req, res)));
    r.post('/admin/links', ...post, need('canEditLinks'), h('links', (req, res) => this.saveLink(req, res, null)));
    r.post('/admin/links/:id', ...post, need('canEditLinks'), h('links', (req, res) => this.saveLink(req, res, req.params.id)));
    r.post('/admin/links/:id/delete', ...post, need('canEditLinks'), h('links', (req, res) => {
      this.store.deleteLink(parseInt(req.params.id, 10));
      this.namesCache = null;
      res.redirect(req.baseUrl + '/admin/links');
    }));

    r.get('/admin/users', ...page, need(null), h('users', (req, res) => this.sendUsers(req, res)));
    r.post('/admin/users', ...post, need(null), h('users', (req, res) => this.saveUser(req, res, null)));
    r.post('/admin/users/:id', ...post, need(null), h('users', (req, res) => this.saveUser(req, res, req.params.id)));
    r.post('/admin/users/:id/delete', ...post, need(null), h('users', (req, res) => {
      this.store.deleteUser(parseInt(req.params.id, 10));
      this.log.info(`Testing module: user ${req.params.id} deleted`);
      res.redirect(req.baseUrl + '/admin/users');
    }));

    r.post('/TestReport/:id/delete', ...post, need('canDeleteReports'), h('delete', (req, res) => {
      if (!this.store.delete(req.params.id)) {
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error(`No report with id '${req.params.id}'`), 404);
      }
      this.log.info(`Testing module: report ${req.params.id} deleted by ${req.user.name}`);
      res.redirect(req.baseUrl);
    }));
  }

  sendLogin(req, res, status, error) {
    res.status(status);
    this.sendHtml(res, 'Login', renderLogin(req.baseUrl, error, res.locals._csrf), Date.now());
  }

  async login(req, res) {
    const login = typeof req.body.login === 'string' ? req.body.login.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    let ok = false;
    const regenerate = () => new Promise((resolve, reject) => req.session.regenerate(e => e ? reject(e) : resolve()));
    if (login === 'admin') {
      if (tokenConfigured(this.config.adminPassword) && tokenMatches(this.config.adminPassword, password)) {
        await regenerate();
        req.session.testingAdmin = true;
        ok = true;
      }
    } else if (login) {
      const user = this.store.userByLogin(login);
      if (user && await bcrypt.compare(password, user.password_hash)) {
        await regenerate();
        req.session.testingUserId = user.id;
        ok = true;
      }
    }
    if (!ok) {
      this.log.info(`Testing module: failed login for '${login}' from ${req.ip}`);
      return this.sendLogin(req, res, 401, 'Unknown username or wrong password');
    }
    this.log.info(`Testing module: '${login}' logged in from ${req.ip}`);
    res.redirect(req.baseUrl || '/');
  }

  sendLinks(req, res, message, status = 200) {
    res.status(status);
    this.sendHtml(res, 'Named Links', renderLinks(this.store.links(), { base: req.baseUrl, user: req.user, csrf: res.locals._csrf }, message), Date.now());
  }

  saveLink(req, res, id) {
    const canonical = typeof req.body.canonical === 'string' ? req.body.canonical.trim() : '';
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const link = typeof req.body.link === 'string' ? req.body.link.trim() : '';
    let problem = null;
    if (!canonical || /\s/.test(canonical) || canonical.length > 1024) {
      problem = 'The canonical must be a URL with no spaces';
    } else if (!name || name.length > 200) {
      problem = 'A name is required (up to 200 characters)';
    } else if (link && !/^https?:\/\/[^\s"'<>]+$/i.test(link)) {
      problem = 'The link must be an http or https URL';
    }
    if (problem) {
      return this.sendLinks(req, res, problem, 400);
    }
    try {
      if (id === null) {
        this.store.saveLink(canonical, name, link);
      } else if (!this.store.updateLink(parseInt(id, 10), canonical, name, link)) {
        return this.sendLinks(req, res, 'That link no longer exists', 404);
      }
    } catch (e) {
      if (/UNIQUE/.test(e.message)) {
        return this.sendLinks(req, res, `There is already a name for ${canonical}`, 409);
      }
      throw e;
    }
    this.namesCache = null;
    res.redirect(req.baseUrl + '/admin/links');
  }

  sendUsers(req, res, message, status = 200) {
    res.status(status);
    this.sendHtml(res, 'Users', renderUsers(this.store.users(), { base: req.baseUrl, user: req.user, csrf: res.locals._csrf }, message), Date.now());
  }

  async saveUser(req, res, id) {
    const login = typeof req.body.login === 'string' ? req.body.login.trim() : '';
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const rights = { editLinks: req.body.editLinks === '1', deleteReports: req.body.deleteReports === '1' };
    let problem = null;
    if (id === null && !/^[A-Za-z0-9._@-]{1,64}$/.test(login)) {
      problem = 'The username must be 1-64 letters, digits, or . _ @ -';
    } else if (id === null && login.toLowerCase() === 'admin') {
      problem = "'admin' is the administrator's login";
    } else if (!name || name.length > 100) {
      problem = 'A name is required (up to 100 characters)';
    } else if ((id === null || password) && password.length < 8) {
      problem = 'Passwords must be at least 8 characters';
    }
    if (problem) {
      return this.sendUsers(req, res, problem, 400);
    }
    const hash = password ? await bcrypt.hash(password, 10) : null;
    if (id === null) {
      if (this.store.userByLogin(login)) {
        return this.sendUsers(req, res, `There is already a user '${login}'`, 409);
      }
      this.store.createUser(login, name, hash, rights);
      this.log.info(`Testing module: user '${login}' created`);
    } else if (!this.store.updateUser(parseInt(id, 10), name, rights, hash)) {
      return this.sendUsers(req, res, 'That user no longer exists', 404);
    }
    res.redirect(req.baseUrl + '/admin/users');
  }
}

module.exports = TestingModule;
module.exports.validateReport = validateReport;
