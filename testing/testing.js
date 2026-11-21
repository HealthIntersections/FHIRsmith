//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The /testing module: a place to send TestReports (from TxTester, and anything else),
 * and to look at them.
 *
 *   POST   {base}/TestReport        create (with requireToken: an API token of a user with the testing "submit" role)
 *   GET    {base}/TestReport        search - a Bundle, or HTML for a browser
 *   GET    {base}/TestReport/:id    read - JSON, or the rendered report for a browser
 *   DELETE {base}/TestReport/:id    an API token of a user with the testing "delete-reports" role
 *   GET    {base}/metadata          CapabilityStatement
 *   GET    {base}                   the filterable list (HTML)
 *   GET    {base}/summary           latest result per test script x participant (HTML)
 *   GET    {base}/admin/links       names for known canonical URLs (users who can edit links)
 *
 * Users and logins are the server's (library/auth). The module's roles: "submit" (post
 * reports, when requireToken is set), "edit-links" (the named links) and "delete-reports";
 * the server's administrators have them all. They are given on the server's users pages.
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
const auth = require('../library/auth');

const folders = require('../library/folder-setup');
const htmlServer = require('../library/html-server');
const { tokenConfigured } = require('../library/request-token');
const { requireSameOrigin } = require('../library/same-origin');
const packageJson = require('../package.json');
const { TestReportStore } = require('./store');
const { parseSearch, dateRange, capabilitySearchParams } = require('./search');
const testingOpenApi = require('./openapi');
const {
  renderList, renderSummary, renderReport, renderLinks, listQueryToSearch
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
  // contained resources aren't accepted: nothing in a report needs them, and allowing them
  // would mean describing (and rendering) any resource at all
  if (r.contained !== undefined) {
    problems.push('TestReport.contained is not allowed: reports may not contain resources');
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
    // routes that look up who is asking (library/auth) are rate limited, for requests that bring
    // a login or a token (anonymous requests aren't counted)
    this.router.use(rateLimit(auth.credentialLimits()));
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

    auth.defineRoles('testing', [
      { role: 'submit', label: 'Submit reports', description: 'POST TestReports (when modules.testing.requireToken is set), with an API token' },
      { role: 'edit-links', label: 'Edit named links' },
      { role: 'delete-reports', label: 'Delete reports' }
    ], { title: 'Test reports', path: '/testing' });
    // posting is open unless requireToken is set. The old shared token closed it: so does its
    // being there (it is no longer the credential - an API token is)
    this.requireToken = this.config.requireToken === true || tokenConfigured(this.config.token);
    for (const old of ['token', 'adminToken', 'adminPassword', 'sessionSecret']) {
      if (this.config[old]) {
        this.log.warn(`Testing module: modules.testing.${old} is no longer used - users, roles and API tokens are the server's (library/auth)` +
          (old === 'token' ? '; posting needs an API token with the testing "submit" role (set requireToken: true)' : ''));
      }
    }

    this.setupSession();
    this.setupRoutes();
    this.setupAdminRoutes();
    this.setupRetention();
    this.log.info(`Testing module: ${this.store.count()} reports in ${dbPath}; ` +
      `posting ${this.requireToken ? 'requires an API token (testing "submit" role)' : 'is open'}, max ${this.maxSize} bytes`);
  }

  /**
   * The login session and CSRF protection are the server's (library/auth). Neither is put on
   * the whole router: the FHIR API (POST and DELETE of TestReports) is authenticated by an API
   * token, not a cookie, so it needs neither and must not be made to carry a CSRF token. The
   * web pages get this.web; every form post gets sameOrigin + this.session + a form parser +
   * this.csrf (see setupAdminRoutes).
   */
  setupSession() {
    this.session = auth.session;
    this.csrf = auth.csrf;
    this.web = auth.web;
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

    // RFC 8631: where to find the machine-readable description of this API
    r.use((req, res, next) => {
      res.setHeader('Link', `<${req.baseUrl}/openapi.json>; rel="service-desc", <${req.baseUrl}/openapi>; rel="service-doc"`);
      next();
    });

    // the OpenAPI description: /openapi.json, /openapi.yaml, and /openapi (an HTML reference
    // for browsers, the JSON otherwise)
    r.get('/openapi.json', (req, res) => this.handle(req, res, 'openapi', () => res.type('application/json').send(testingOpenApi.getJson())));
    r.get('/openapi.yaml', (req, res) => this.handle(req, res, 'openapi', () =>
      res.set('Content-Type', 'application/yaml').send(testingOpenApi.getYaml())));
    r.get('/openapi', (req, res) => this.handle(req, res, 'openapi', () => {
      if (!wantsHtml(req)) {
        return res.type('application/json').send(testingOpenApi.getJson());
      }
      return this.sendHtml(res, 'Test Report API', testingOpenApi.renderHtml(), Date.now());
    }));

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

  /**
   * The paragraph for the server's daily report: pages served, reports received
   * in the period, and how many are held.
   */
  dailyReport({since, now}) {
    const {plural} = require('../library/daily-report');
    const sentences = [];
    if (this.stats) {
      const counts = this.stats.countsSince(since, now);
      sentences.push(`${plural(counts.total, 'page')} ${counts.total === 1 ? 'was' : 'were'} served.`);
    }
    if (this.store) {
      const received = this.store.countReceived(since, now);
      sentences.push(`${plural(received, 'test report')} ${received === 1 ? 'was' : 'were'} received; ${plural(this.store.count(), 'report')} ${this.store.count() === 1 ? 'is' : 'are'} held.`);
    } else {
      sentences.push('The report store is not open.');
    }
    return sentences.join(' ');
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

  /**
   * Who the request's API token (or session) is, or null. The token is looked for where
   * library/auth looks (Authorization: Bearer, Api-Key...), and in the configured tokenHeader
   */
  async apiUser(req) {
    if (this.tokenHeader.toLowerCase() !== 'authorization' && !auth.presentsToken(req)) {
      const v = req.get(this.tokenHeader);
      if (typeof v === 'string' && v.trim()) {
        req.headers.authorization = 'Bearer ' + v.replace(/^Bearer\s+/i, '').trim();
      }
    }
    return auth.principal(req);
  }

  // ---- FHIR API ----

  async create(req, res) {
    if (this.requireToken) {
      const who = await this.apiUser(req);
      if (!who) {
        res.set('WWW-Authenticate', 'Bearer');
        return this.sendOutcome(res, 401, 'login', `A valid API token is required in the ${this.tokenHeader} header`);
      }
      if (!who.has('testing', 'submit')) {
        return this.sendOutcome(res, 403, 'forbidden', `${who.login} does not have the testing "submit" role`);
      }
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
    const who = await this.apiUser(req);
    if (!who) {
      res.set('WWW-Authenticate', 'Bearer');
      return this.sendOutcome(res, 401, 'login', 'Deleting reports requires an API token');
    }
    if (!who.has('testing', 'delete-reports')) {
      return this.sendOutcome(res, 403, 'forbidden', `${who.login} does not have the testing "delete-reports" role`);
    }
    if (!this.store.delete(req.params.id)) {
      return this.sendOutcome(res, 404, 'not-found', `No TestReport with id '${req.params.id}'`);
    }
    this.log.info(`Testing module: report ${req.params.id} deleted by ${who.login}`);
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
  /** Who is logged in (library/auth), with the module's rights */
  currentUser(req) {
    const p = auth.currentUser(req);
    if (!p) {
      return null;
    }
    return { id: p.id, name: p.name, login: p.login, isAdmin: p.isAdmin, canEditLinks: p.has('testing', 'edit-links'), canDeleteReports: p.has('testing', 'delete-reports') };
  }

  setupAdminRoutes() {
    const r = this.router;
    const form = express.urlencoded({ extended: false, limit: '64kb' });
    // every form post must come from one of our own pages
    const sameOrigin = requireSameOrigin((req, res) =>
      htmlServer.sendErrorResponse(res, TEMPLATE, new Error('Cross-site form posts are not accepted'), 403));
    // a right, or the administrator
    const need = (right) => (req, res, next) => {
      auth.denyFraming(res);
      const user = this.currentUser(req);
      if (!user) {
        return res.redirect(auth.loginUrl(req));
      }
      if (!(user.isAdmin || (right && user[right]))) {
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error('You do not have permission to do that'), 403);
      }
      req.user = user;
      next();
    };
    const h = (name, fn) => (req, res) => this.handle(req, res, name, () => fn(req, res));
    // Every page with a form has this.session, this.csrf; every form post has sameOrigin,
    // this.session, form, this.csrf. They are written out in each route rather than spread
    // from an array, so that CodeQL can see the CSRF middleware on every cookie-using route.

    // logging in is the server's: an old link to the module's login page goes there
    r.get('/login', (req, res) => res.redirect(auth.loginUrl(req, req.baseUrl || '/')));

    r.get('/admin/links', this.session, this.csrf, need('canEditLinks'), h('links', (req, res) => this.sendLinks(req, res)));
    r.post('/admin/links', sameOrigin, this.session, form, this.csrf, need('canEditLinks'), h('links', (req, res) => this.saveLink(req, res, null)));
    r.post('/admin/links/:id', sameOrigin, this.session, form, this.csrf, need('canEditLinks'), h('links', (req, res) => this.saveLink(req, res, req.params.id)));
    r.post('/admin/links/:id/delete', sameOrigin, this.session, form, this.csrf, need('canEditLinks'), h('links', (req, res) => {
      this.store.deleteLink(parseInt(req.params.id, 10));
      this.namesCache = null;
      res.redirect(req.baseUrl + '/admin/links');
    }));
    // users are the server's
    r.get('/admin/users', (req, res) => res.redirect('/auth/admin/users'));

    r.post('/TestReport/:id/delete', sameOrigin, this.session, form, this.csrf, need('canDeleteReports'), h('delete', (req, res) => {
      if (!this.store.delete(req.params.id)) {
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error(`No report with id '${req.params.id}'`), 404);
      }
      this.log.info(`Testing module: report ${req.params.id} deleted by ${req.user.name}`);
      res.redirect(req.baseUrl);
    }));

    // lusca rejects a form post with a missing or wrong token by passing on an error
    // ("CSRF token missing" / "CSRF token mismatch"); anything else goes on as it was
    r.use((err, req, res, next) => {
      if (err && typeof err.message === 'string' && err.message.startsWith('CSRF token')) {
        return htmlServer.sendErrorResponse(res, TEMPLATE,
          new Error('The form has expired or did not come from this site - reload the page and try again'), 403);
      }
      next(err);
    });
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
}

module.exports = TestingModule;
module.exports.validateReport = validateReport;
