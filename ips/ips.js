//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The /ips module: collections ("projects") of International Patient Summary documents.
 *
 * The root is the list of projects, which the administrator (whose login is in the
 * configuration) creates and deletes, along with the users who manage them:
 *
 *   GET  {base}                       the projects (HTML)
 *   GET  {base}/login                 login; POST {base}/logout
 *   GET  {base}/admin/projects        create, edit, delete projects; assign managers (administrator)
 *   GET  {base}/admin/users           create, edit, delete users (administrator)
 *
 * Each project is a FHIR endpoint and a web site at {base}/{code}:
 *
 *   GET    {base}/{code}              the filterable list of documents (HTML)
 *   GET    {base}/{code}/submit       a form for submitting a document; POST the same
 *   GET    {base}/{code}/settings     the submission token (the project's managers)
 *   GET    {base}/{code}/metadata     CapabilityStatement
 *   POST   {base}/{code}/Bundle       submit a document (the project's token, if it has one)
 *   GET    {base}/{code}/Bundle       search - a Bundle, or the list for a browser
 *   GET    {base}/{code}/Bundle/{id}  read - JSON, or a view of the document for a browser (?view=)
 *   POST   {base}/{code}/Bundle/{id}/delete, /requeue   from the pages (managers)
 *
 * A document is an R4 Bundle of type document whose first entry is a Composition with a
 * Patient subject. Once received it is given a serial id, indexed for searching (see
 * search.js), and queued: a background loop takes documents in turn and runs the
 * processing pipeline over them (pipeline.js - validation, so far), moving the status
 * from 'submitted' through 'processing' to 'processed' or 'error', and keeping what each
 * step made of the document for the pages to show.
 *
 * Logins work as the publisher's and the testing module's do: a session cookie, bcrypt
 * password hashes, a rate limited login, CSRF tokens on every form.
 *
 * @module ips/ips
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
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
const { checkNarrative, checkResourceNarratives } = require('../library/narrative-check');
const packageJson = require('../package.json');
const { IpsStore } = require('./store');
const { parseSearch, listQueryToSearch, capabilitySearchParams, compositionOf, patientOf } = require('./search');
const render = require('./render');
const { TxClient } = require('./tx-client');
const { STEPS, stripChecks } = require('./pipeline');
const { IpsValueSets } = require('./ips-valuesets');
const aiClient = require('./ai-client');
const { ShlClient } = require('./share');
const composer = require('./composer');
const editorSchema = require('./editor-schema');
const profiles = require('./profiles');
const { MembershipSession } = require('./membership');

const TEMPLATE = 'ips';
const DEFAULT_DATABASE = 'ips/ips-content.db';
const DEFAULT_MAX_SIZE = 10 * 1024 * 1024;
const DEFAULT_INTERVAL_SECONDS = 5;
// a terminology server on this server that isn't there: how often to look again, and how
// long after start-up documents wait for it
const TX_RECHECK_MS = 10 * 1000;
const TX_STARTUP_GRACE_MS = 5 * 60 * 1000;
const FHIR_JSON = 'application/fhir+json; charset=utf-8';
const CODE_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
// paths at the root that can't be project codes
const RESERVED = new Set(['login', 'logout', 'admin', 'metadata', 'openapi', 'static', 'assets', 'lookup']);

/**
 * What's wrong with a submitted document, if anything.
 *
 * @param {*} b - the parsed JSON
 * @returns {string[]} problems; empty if it's acceptable
 */
function validateDocument(b) {
  if (b === null || typeof b !== 'object' || Array.isArray(b)) {
    return ['The body must be a JSON object'];
  }
  if (b.resourceType !== 'Bundle') {
    return [`The resource must be a Bundle, not ${typeof b.resourceType === 'string' ? b.resourceType : 'something without a resourceType'}`];
  }
  const problems = [];
  if (b.type !== 'document') {
    problems.push(`The Bundle must be of type 'document', not '${typeof b.type === 'string' ? b.type : ''}'`);
  }
  if (!Array.isArray(b.entry) || b.entry.length === 0) {
    problems.push('The Bundle has no entries');
    return problems;
  }
  for (const [i, e] of b.entry.entries()) {
    if (e === null || typeof e !== 'object' || e.resource === null || typeof e.resource !== 'object' || typeof e.resource.resourceType !== 'string') {
      problems.push(`Bundle.entry[${i}] has no resource`);
    }
  }
  if (problems.length > 0) {
    return problems;
  }
  const comp = compositionOf(b);
  if (!comp) {
    problems.push(`The first entry must be a Composition, not a ${b.entry[0].resource.resourceType}`);
    return problems;
  }
  if (!patientOf(b, comp)) {
    problems.push("The Composition's subject must be a Patient in the bundle");
  }
  // every narrative in the document is shown on the web site, so none may have active
  // content: the resources' own (and their contained resources'), and the sections'
  const active = checkResourceNarratives(b);
  if (active) {
    problems.push(active);
  } else {
    const sections = (secs, where) => {
      for (const [i, s] of (Array.isArray(secs) ? secs : []).entries()) {
        const found = checkNarrative(s?.text?.div);
        if (found) {
          return `${where}[${i}]: ${found}`;
        }
        const nested = sections(s?.section, `${where}[${i}].section`);
        if (nested) {
          return nested;
        }
      }
      return null;
    };
    const found = sections(comp.section, 'Composition.section');
    if (found) {
      problems.push(found);
    }
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

function docId(s) {
  return /^\d{1,18}$/.test(s) ? parseInt(s, 10) : NaN;
}

class IpsModule {
  /**
   * @param {Object} stats - a ModuleStats
   * @param {Object} [log] - a logger; defaults to the server's
   */
  constructor(stats, log) {
    this.stats = stats;
    this.router = express.Router();
    this.store = null;
    this.config = null;
    this.queueTimer = null;
    this.processing = false;
    // the steps run over each document, in order (pipeline.js); tests swap them
    this.steps = STEPS;
    // the FHIR validator (fhir-validator-wrapper), when modules.ips.validator is enabled.
    // Starting it takes a while, so it happens in the background and the queue waits for it
    this.validator = null;
    this.validatorStarting = null;
    // the value sets the terminology check holds documents to (ips/valuesets/)
    this.valueSets = null;
    if (log) {
      this.log = log;
    } else {
      const Logger = require('../library/logger');
      this.log = Logger.getInstance().child({ module: 'ips' });
    }
  }

  /**
   * @param {Object} config - modules.ips
   * @param {Function} [app] - the Express app, needed when txServer is a path on this server
   */
  async initialize(config, app) {
    this.config = config || {};
    this.app = app || null;
    const db = this.config.database || DEFAULT_DATABASE;
    const dbPath = db === ':memory:' || path.isAbsolute(db) ? db : path.join(folders.databasesDir(), db);
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.store = new IpsStore(dbPath);
    // clinical profiles were once on Composition: they are on Bundle now
    for (const p of this.store.profiles()) {
      const moved = profiles.migrate(this.store.profile(p.id));
      if (moved) {
        this.store.saveProfile(p.id, moved);
        this.log.info(`IPS module: clinical profile ${moved.id} (${moved.title}) moved from Composition onto Bundle`);
      }
    }
    this.maxSize = Number.isInteger(this.config.maxSize) && this.config.maxSize > 0 ? this.config.maxSize : DEFAULT_MAX_SIZE;

    htmlServer.loadTemplate(TEMPLATE, path.join(__dirname, 'ips-template.html'));

    // the administrator's password is checked the same way as everyone else's: bcrypt against
    // a hash, made once here, of the configured password
    this.adminUsername = typeof this.config.adminUsername === 'string' && this.config.adminUsername ? this.config.adminUsername : 'admin';
    this.adminHash = tokenConfigured(this.config.adminPassword) ? bcrypt.hashSync(this.config.adminPassword, 10) : null;
    // compared against when a login names no user, so that takes as long as a real one
    this.dummyHash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
    if (!this.adminHash) {
      this.log.warn('IPS module: no adminPassword configured - nobody can create projects or users');
    }

    // the terminology server: links to code systems, and the analysis's queries. None
    // configured, no links and no analysis
    this.tx = null;
    // set by checkTxServer when a path on this server has nothing at it
    this.txMissing = false;
    if (this.config.txServer) {
      this.tx = new TxClient(this.config.txServer, { app: this.app, log: this.log });
      if (this.tx.internal) {
        // a path on this server must be one of the tx module's endpoints. The tx module is
        // set up after this one, so the check is made when the queue first runs (checkTxServer)
        this.txChecked = false;
      }
      this.startedAt = Date.now();
    } else {
      this.log.warn('IPS module: no txServer configured - code systems will not be linked, and documents will not be analysed');
    }

    // the secret the projects' AI keys are encrypted with: its own, else the session's
    // (when that is configured - a random one would make the keys unreadable after a restart)
    this.aiSecret = typeof this.config.aiKeySecret === 'string' && this.config.aiKeySecret ? this.config.aiKeySecret : (this.config.sessionSecret || null);
    if (!this.aiSecret) {
      this.log.warn('IPS module: no aiKeySecret or sessionSecret configured - projects cannot keep their own AI accounts');
    }
    if (this.config.ai?.apiKey) {
      try {
        aiClient.checkAccount({ provider: this.config.ai.provider || 'openai', baseUrl: this.config.ai.baseUrl, model: this.config.ai.model, apiKey: this.config.ai.apiKey });
        this.log.info(`IPS module: AI assessments use ${this.config.ai.provider || 'openai'} / ${this.config.ai.model} by default`);
      } catch (e) {
        this.log.error(`IPS module: modules.ips.ai: ${e.message}`);
      }
    }

    // sharing documents as SHL / VHL QR codes, through an SHL server (this server's own shl
    // module, usually)
    this.shl = null;
    if (this.config.shl) {
      try {
        this.shl = new ShlClient(this.config.shl, { app: this.app, log: this.log });
        this.log.info(`IPS module: documents can be shared as SHL/VHL through ${this.shl.url}`);
      } catch (e) {
        this.log.error(`IPS module: modules.ips.shl: ${e.message} - documents cannot be shared`);
      }
    }

    this.setupSession();
    this.setupRootRoutes();
    this.setupProfileRoutes();
    this.setupProjectRoutes();
    this.setupValidator();
    this.setupValueSets();
    this.setupQueue();
    this.log.info(`IPS module: ${this.store.projects().length} projects, ${this.store.count()} documents in ${dbPath}; max ${this.maxSize} bytes; ` +
      `terminology server ${this.tx ? (this.tx.internal ? `${this.tx.url} (this server)` : this.tx.url) : 'none'}`);
  }

  /**
   * The session (login) cookie and CSRF protection - as the testing module has them. The
   * FHIR API (POST Bundle) is authenticated by a token in a header, not a cookie, so it
   * gets neither; the pages get this.web, and every form post gets sameOrigin +
   * this.session + a form parser + this.csrf.
   */
  setupSession() {
    if (!this.config.sessionSecret) {
      this.log.warn('ips: no sessionSecret configured - using a random one, so logins will not ' +
        'survive a restart. Set modules.ips.sessionSecret.');
    }
    this.session = session({
      name: 'ips.sid',
      secret: this.config.sessionSecret || crypto.randomBytes(64).toString('hex'),
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: this.config.cookieSecure ?? true,
        sameSite: 'lax',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000
      }
    });
    this.csrf = lusca.csrf({ key: '_csrf' });
    const csrfIfLoggedIn = (req, res, next) => this.currentUser(req) ? this.csrf(req, res, next) : next();
    this.web = [this.session, csrfIfLoggedIn];
    this.form = express.urlencoded({ extended: false, limit: '64kb' });
    // the submission form carries a whole document
    this.bigForm = express.urlencoded({ extended: false, limit: Math.ceil(this.maxSize * 1.5) });
    this.sameOrigin = requireSameOrigin((req, res) =>
      htmlServer.sendErrorResponse(res, TEMPLATE, new Error('Cross-site form posts are not accepted'), 403));
  }

  // ---- routes ----

  setupRootRoutes() {
    const r = this.router;
    const h = (name, fn) => (req, res) => this.handle(req, res, name, () => fn(req, res));
    const loginLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: this.config.loginAttemptsPerWindow ?? 20,
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
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error('Only the administrator can do that'), 403);
      }
      req.user = user;
      next();
    };
    this.adminOnly = admin;

    r.get('/', ...this.web, h('home', (req, res) => {
      this.sendHtml(res, 'International Patient Summary', render.renderHome(this.store.projects(), this.ctx(req, res)), Date.now());
    }));

    // Every page with a form has this.session, this.csrf; every form post has sameOrigin,
    // this.session, form, this.csrf. They are written out in each route rather than spread
    // from an array, so that CodeQL can see the CSRF middleware on every cookie-using route.
    r.get('/login', this.session, this.csrf, h('login', (req, res) => this.sendLogin(req, res, 200)));
    r.post('/login', this.sameOrigin, loginLimiter, this.session, this.form, this.csrf, h('login', (req, res) => this.login(req, res)));
    r.post('/logout', this.sameOrigin, this.session, this.form, this.csrf, h('logout', (req, res) => {
      req.session.destroy(() => res.redirect(req.baseUrl || '/'));
    }));

    r.get('/admin/projects', this.session, this.csrf, admin, h('projects', (req, res) => this.sendProjects(req, res)));
    r.post('/admin/projects', this.sameOrigin, this.session, this.form, this.csrf, admin, h('projects', (req, res) => this.saveProject(req, res, null)));
    r.post('/admin/projects/:id', this.sameOrigin, this.session, this.form, this.csrf, admin, h('projects', (req, res) => this.saveProject(req, res, req.params.id)));
    r.post('/admin/projects/:id/delete', this.sameOrigin, this.session, this.form, this.csrf, admin, h('projects', (req, res) => {
      const p = this.store.projectById(parseInt(req.params.id, 10));
      if (p && this.store.deleteProject(p.id)) {
        this.log.info(`IPS module: project '${p.code}' deleted by the administrator`);
      }
      res.redirect(req.baseUrl + '/admin/projects');
    }));

    r.get('/admin/users', this.session, this.csrf, admin, h('users', (req, res) => this.sendUsers(req, res)));
    r.post('/admin/users', this.sameOrigin, this.session, this.form, this.csrf, admin, h('users', (req, res) => this.saveUser(req, res, null)));
    r.post('/admin/users/:id', this.sameOrigin, this.session, this.form, this.csrf, admin, h('users', (req, res) => this.saveUser(req, res, req.params.id)));
    r.post('/admin/users/:id/delete', this.sameOrigin, this.session, this.form, this.csrf, admin, h('users', (req, res) => {
      if (this.store.deleteUser(parseInt(req.params.id, 10))) {
        this.log.info(`IPS module: user ${req.params.id} deleted`);
      }
      res.redirect(req.baseUrl + '/admin/users');
    }));
  }

  /**
   * The clinical profiles, across all projects: everyone can see them, only the
   * administrator changes them. Before the project routes, so /StructureDefinition and
   * /lookup aren't taken for project codes.
   */
  setupProfileRoutes() {
    const r = this.router;
    const h = (name, fn) => (req, res) => this.handle(req, res, name, () => fn(req, res));
    const rl = this.config.rateLimit || {};
    // the editors' code lookups: many small requests, their own allowance
    const lookupMax = rl.lookupMax === undefined ? 600 : rl.lookupMax;
    this.lookups = lookupMax > 0 ? [rateLimit({
      windowMs: (rl.windowMinutes || 1) * 60 * 1000,
      limit: lookupMax,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (req, res) => res.status(429).json({ error: 'Too many lookups; try again later' })
    })] : [];
    const admin = this.adminOnly;
    // the administrator, for the editor's fetches: JSON, not a redirect to the login page
    const adminJson = (req, res, next) => {
      const user = this.currentUser(req);
      if (!user || !user.isAdmin) {
        return res.status(user ? 403 : 401).json({ problems: [user ? 'Only the administrator can change clinical profiles' : 'You are not logged in (or your session has expired)'] });
      }
      req.user = user;
      next();
    };
    const json = express.json({ limit: '2mb' });
    const profile = (req, res, next) => {
      const m = /^profile-([a-f0-9]{12})$/.exec(req.params.id);
      const sd = m ? this.store.profile(m[1]) : null;
      if (!sd) {
        return wantsHtml(req)
          ? htmlServer.sendErrorResponse(res, TEMPLATE, new Error(`There is no clinical profile '${req.params.id}'`), 404)
          : this.sendOutcome(res, 404, 'not-found', `There is no clinical profile '${req.params.id}'`);
      }
      req.profileId = m[1];
      req.profile = sd;
      next();
    };

    r.get('/profile-editor.js', (req, res) => res.sendFile(path.join(__dirname, 'profile-editor.js'), { maxAge: '1h' }));
    r.get('/lookup', this.session, adminJson, ...this.lookups, h('lookup', (req, res) => this.systemLookup(req, res)));
    r.get('/lookup-vs', this.session, adminJson, ...this.lookups, h('lookup', (req, res) => this.valueSetLookup(req, res)));
    r.get('/StructureDefinition', ...this.web, h('profiles', (req, res) => this.profileList(req, res)));
    r.get('/StructureDefinition/new', this.session, this.csrf, admin, h('profiles', (req, res) => this.profileEditor(req, res, null)));
    r.post('/StructureDefinition', this.sameOrigin, this.session, json, this.csrf, adminJson, h('profiles', (req, res) => this.profileSave(req, res, null)));
    r.get('/StructureDefinition/:id', profile, ...this.web, h('profile', (req, res) => this.profileRead(req, res)));
    r.get('/StructureDefinition/:id/edit', profile, this.session, this.csrf, admin, h('profile', (req, res) => this.profileEditor(req, res, req.profile)));
    r.post('/StructureDefinition/:id', profile, this.sameOrigin, this.session, json, this.csrf, adminJson, h('profile', (req, res) => this.profileSave(req, res, req.profile)));
    r.post('/StructureDefinition/:id/delete', profile, this.sameOrigin, this.session, this.form, this.csrf, admin, h('profile', (req, res) => {
      this.store.deleteProfile(req.profileId);
      res.redirect(req.baseUrl + '/StructureDefinition');
    }));
  }

  setupProjectRoutes() {
    const r = this.router;
    const h = (name, fn) => (req, res) => this.handle(req, res, name, () => fn(req, res));
    const rl = this.config.rateLimit || {};
    const max = rl.max === undefined ? 60 : rl.max;
    const posting = [];
    if (max > 0) {
      posting.push(rateLimit({
        windowMs: (rl.windowMinutes || 1) * 60 * 1000,
        limit: max,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        handler: (req, res) => wantsHtml(req)
          ? htmlServer.sendErrorResponse(res, TEMPLATE, new Error('Too many documents submitted; try again later'), 429)
          : this.sendOutcome(res, 429, 'throttled', 'Too many documents submitted; try again later')
      }));
    }

    // the project, from its code; 404 if there isn't one
    const project = (req, res, next) => {
      const code = req.params.code;
      const p = CODE_RE.test(code) && !RESERVED.has(code) ? this.store.projectByCode(code) : null;
      if (!p) {
        return wantsHtml(req)
          ? htmlServer.sendErrorResponse(res, TEMPLATE, new Error(`There is no project '${code}'`), 404)
          : this.sendOutcome(res, 404, 'not-found', `There is no project '${code}'`);
      }
      req.project = p;
      next();
    };
    // a manager of the project, or the administrator
    const manager = (req, res, next) => {
      const user = this.currentUser(req);
      if (!user) {
        return res.redirect(req.baseUrl + '/login');
      }
      if (!this.canManage(user, req.project)) {
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error('You do not manage this project'), 403);
      }
      req.user = user;
      next();
    };

    r.get('/editor.js', (req, res) => res.sendFile(path.join(__dirname, 'editor.js'), { maxAge: '1h' }));
    r.get('/:code', project, ...this.web, h('list', (req, res) => this.htmlList(req, res)));
    r.get('/:code/metadata', project, h('metadata', (req, res) => this.metadata(req, res)));
    // The submission form has no CSRF token and starts no session: submitting is open to
    // anyone (or needs the project's token, which is in the form itself), so there is no
    // credential for a cross-site post to ride on, and a token for every visitor would give
    // every crawler a session. The Origin check still applies to the post.
    r.get('/:code/submit', project, ...this.web, h('submit', (req, res) => this.sendSubmit(req, res)));
    // the editor: the page, its script (served before the project routes catch the name),
    // the code lookups it makes, and what it posts
    r.get('/:code/compose', project, ...this.web, h('compose', (req, res) => this.sendCompose(req, res)));
    r.get('/:code/lookup', project, ...this.lookups, h('lookup', (req, res) => this.lookup(req, res)));
    r.post('/:code/compose', project, this.sameOrigin, ...posting, this.session, express.json({ limit: '2mb' }), h('compose', (req, res) => this.compose(req, res)));
    r.post('/:code/submit', project, this.sameOrigin, ...posting, this.session, this.bigForm, h('submit', (req, res) => this.submitForm(req, res)));
    r.get('/:code/settings', project, this.session, this.csrf, manager, h('settings', (req, res) => this.sendSettings(req, res)));
    r.post('/:code/settings', project, this.sameOrigin, this.session, this.form, this.csrf, manager, h('settings', (req, res) => this.saveSettings(req, res)));

    r.post('/:code/Bundle', project, ...posting, h('create', (req, res) => this.create(req, res)));
    r.get('/:code/Bundle', project, ...this.web, h('search', (req, res) =>
      wantsHtml(req) ? this.htmlList(req, res) : this.search(req, res)));
    r.get('/:code/Bundle/:id', project, ...this.web, h('read', (req, res) => this.read(req, res)));
    // sharing: anyone who can read the document (same origin, and rate limited as
    // submissions are, since each share stores a copy on the SHL server)
    r.post('/:code/Bundle/:id/share', project, this.sameOrigin, ...posting, this.form, h('share', (req, res) => this.share(req, res)));
    r.post('/:code/Bundle/:id/delete', project, this.sameOrigin, this.session, this.form, this.csrf, manager, h('delete', (req, res) => {
      const id = docId(req.params.id);
      if (!this.store.delete(id, req.project.id)) {
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error(`No document with id '${req.params.id}'`), 404);
      }
      this.log.info(`IPS module: document ${id} in '${req.project.code}' deleted by ${req.user.name}`);
      res.redirect(`${req.baseUrl}/${encodeURIComponent(req.project.code)}`);
    }));
    r.post('/:code/Bundle/:id/requeue', project, this.sameOrigin, this.session, this.form, this.csrf, manager, h('requeue', (req, res) => {
      const id = docId(req.params.id);
      if (!this.store.requeue(id, req.project.id)) {
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error(`No document with id '${req.params.id}'`), 404);
      }
      res.redirect(`${req.baseUrl}/${encodeURIComponent(req.project.code)}/Bundle/${id}`);
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

  // ---- the processing queue ----

  /**
   * Start the FHIR validator, if it is configured, as the SHL module does: the validator
   * CLI jar in the data folder's bin directory, run as a service on its own port, with
   * the IPS package loaded. It is started in the background; until it is up, documents
   * wait in the queue.
   */
  setupValidator() {
    const cfg = this.config.validator;
    if (!cfg || cfg.enabled === false) {
      this.log.warn('IPS module: no validator configured (modules.ips.validator) - documents will not be validated');
      return;
    }
    const FhirValidator = require('fhir-validator-wrapper');
    const jar = folders.filePath('bin', 'validator_cli.jar');
    this.validator = new FhirValidator(jar, this.log);
    const settings = {
      version: cfg.version || '4.0.1',
      txServer: cfg.txServer || 'http://tx.fhir.org/r4',
      txLog: cfg.txLog || folders.filePath('logs', 'ips-validator-tx.log'),
      port: cfg.port || 8082,
      igs: Array.isArray(cfg.packages) ? cfg.packages : ['hl7.fhir.uv.ips#1.1.0'],
      timeout: cfg.timeout || 120000
    };
    this.log.info(`IPS module: starting the FHIR validator on port ${settings.port} (tx ${settings.txServer}; ${settings.igs.join(', ')})`);
    this.validatorStarting = this.validator.start(settings).then(() => {
      this.log.info('IPS module: the FHIR validator is running');
    }).catch(e => {
      this.log.error('IPS module: the FHIR validator failed to start: ' + e.message);
      this.validatorError = e.message;
    }).finally(() => {
      this.validatorStarting = null;
    });
  }

  /** Read the value sets the terminology check holds documents to: the module's own, in ips/valuesets/. */
  setupValueSets() {
    try {
      this.valueSets = new IpsValueSets().load();
      this.log.info(`IPS module: ${this.valueSets.valueSets.size} value sets for ${this.valueSets.elements.size} elements read for the terminology check`);
    } catch (e) {
      this.valueSets = null;
      this.log.error(`IPS module: could not read the value sets for the terminology check: ${e.message}`);
    }
  }

  /**
   * The AI account a project's assessments use: the project's own, when it has a key, else
   * the server's default (modules.ips.ai), else null.
   * @returns {{account: Object, source: 'project'|'server'}|null}
   */
  aiAccountFor(project) {
    const own = this.store.projectAi(project);
    if (own.keyEnc) {
      const apiKey = this.aiSecret ? aiClient.decryptKey(own.keyEnc, this.aiSecret) : null;
      if (apiKey) {
        return { account: { provider: own.provider, baseUrl: own.baseUrl || '', model: own.model, apiKey }, source: 'project' };
      }
      this.log.warn(`IPS module: the AI key for '${project.code}' cannot be read (the key secret has changed?) - using the server's default, if any`);
    }
    const cfg = this.config.ai;
    if (cfg && typeof cfg.apiKey === 'string' && cfg.apiKey && typeof cfg.model === 'string') {
      return { account: { provider: cfg.provider || 'openai', baseUrl: cfg.baseUrl || '', model: cfg.model, apiKey: cfg.apiKey }, source: 'server' };
    }
    return null;
  }

  /**
   * Whether the pipeline can run now: not while the validator is still starting, nor -
   * for a while after start-up - while a terminology server on this server isn't there
   * yet (the tx module loads after this one, and can take a while).
   */
  pipelineReady() {
    if (this.validatorStarting) {
      return false;
    }
    return !(this.txMissing && Date.now() - this.startedAt < TX_STARTUP_GRACE_MS);
  }

  /**
   * Is the terminology server there? For a path on this server, that means the tx module
   * answers at it (its endpoints are configured separately, as modules.tx.endpoints[].path,
   * and /tx/r4 is only an example). The tx module is set up after this one and can take
   * a while to load, so a miss is looked at again (at most every TX_RECHECK_MS) until it
   * answers. A miss is logged once, and its arrival after that, so a wrong path is found
   * in the log rather than as a question mark on every concept.
   */
  async checkTxServer() {
    if (!this.tx || !this.tx.internal) {
      return;
    }
    if (this.txChecked === true || (this.txCheckedAt && Date.now() - this.txCheckedAt < TX_RECHECK_MS)) {
      return;
    }
    if (this.txChecking) {
      return this.txChecking;
    }
    this.txChecking = (async () => {
      this.txCheckedAt = Date.now();
      try {
        const r = await this.tx.get('/metadata');
        if (r.status === 404) {
          if (!this.txMissing) {
            this.log.warn(`IPS module: nothing answers at the terminology server ${this.tx.url} on this server (yet) - ` +
              'is the tx module enabled, and is modules.ips.txServer one of its endpoint paths (modules.tx.endpoints[].path)? ' +
              'Looking again until it does');
          }
          this.txMissing = true;
          if (!this.txMissingLogged && Date.now() - this.startedAt >= TX_STARTUP_GRACE_MS) {
            this.txMissingLogged = true;
            this.log.error(`IPS module: still nothing at the terminology server ${this.tx.url} on this server; documents are processed without it`);
          }
          return;
        }
        if (this.txMissing) {
          this.log.info(`IPS module: the terminology server ${this.tx.url} is there now`);
        }
        this.txMissing = false;
        this.txChecked = true;
        if (r.status !== 200 || r.resource?.resourceType !== 'CapabilityStatement') {
          this.log.warn(`IPS module: the terminology server ${this.tx.url} answered ${r.status} to /metadata`);
        }
      } catch (e) {
        this.log.error(`IPS module: the terminology server ${this.tx.url} could not be reached: ${e.message}`);
      } finally {
        this.txChecking = null;
      }
    })();
    return this.txChecking;
  }

  setupQueue() {
    const reset = this.store.resetProcessing();
    if (reset > 0) {
      this.log.info(`IPS module: ${reset} documents were being processed at the last shutdown; queued again`);
    }
    const cfg = this.config.processing || {};
    if (cfg.enabled === false) {
      return;
    }
    const seconds = typeof cfg.intervalSeconds === 'number' && cfg.intervalSeconds > 0 ? cfg.intervalSeconds : DEFAULT_INTERVAL_SECONDS;
    if (this.stats) {
      this.stats.addTask('IPS processing', `every ${seconds}s`);
    }
    this.queueTimer = setInterval(() => { this.processQueue().catch(e => this.log.error('IPS module: queue run failed: ' + e.message)); }, seconds * 1000);
    this.queueTimer.unref();
  }

  /**
   * Work through everything that is waiting. One document at a time, and never two
   * runs at once; a run that finds nothing is free.
   * @returns {Promise<number>} how many documents were processed
   */
  async processQueue() {
    if (this.processing || !this.store) {
      return 0;
    }
    await this.checkTxServer();
    if (!this.pipelineReady()) {
      return 0;
    }
    this.processing = true;
    let n = 0;
    try {
      for (;;) {
        const row = this.store.claimNext();
        if (!row) {
          break;
        }
        n++;
        const project = this.store.projectById(row.project_id);
        try {
          const note = await this.processDocument(row, project);
          this.store.finish(row.id, true, note || null);
        } catch (e) {
          this.log.error(`IPS module: processing document ${row.id} failed: ${e.stack || e.message}`);
          this.store.finish(row.id, false, e.message);
          if (this.stats) {
            this.stats.taskError('IPS processing', `document ${row.id}: ${e.message}`);
          }
        }
      }
      if (n > 0 && this.stats) {
        this.stats.taskDone('IPS processing', `${n} processed`);
      }
    } finally {
      this.processing = false;
    }
    return n;
  }

  /**
   * Process one document: run the pipeline's steps over it, in order. A step that throws
   * stops the pipeline, and its message becomes the document's.
   *
   * @param {Object} row - from store.read(): the columns and .bundle
   * @param {Object} project
   * @returns {Promise<string|null>} a note for the status: the steps' notes
   */
  async processDocument(row, project) {
    const notes = [];
    // the analysed copy starts as the master, and the steps adorn it; whatever they managed
    // is kept, even when one of them fails
    row.analysed = stripChecks(structuredClone(row.bundle));
    this.store.clearResults(row.id);
    for (const step of this.steps) {
      this.store.saveStepStatus(row.id, step.name, 'waiting');
    }
    try {
      for (const step of this.steps) {
        this.store.saveStepStatus(row.id, step.name, 'running');
        this.log.info(`IPS module: document ${row.id} ('${project.code}'): ${step.name} starting`);
        const started = Date.now();
        let note;
        try {
          note = await step.run(row, project, this);
        } catch (e) {
          this.store.saveStepStatus(row.id, step.name, 'failed', e.message);
          this.log.error(`IPS module: document ${row.id}: ${step.name} failed after ${Date.now() - started} ms: ${e.message}`);
          throw new Error(`${step.name}: ${e.message}`);
        }
        this.store.saveStepStatus(row.id, step.name, 'done', typeof note === 'string' ? note : null);
        this.log.info(`IPS module: document ${row.id}: ${step.name} done in ${Date.now() - started} ms${typeof note === 'string' && note ? ` - ${note}` : ''}`);
        if (typeof note === 'string' && note) {
          notes.push(note);
        }
      }
    } finally {
      this.store.saveAnalysed(row.id, row.analysed);
    }
    return notes.length > 0 ? notes.join('; ') : null;
  }

  /**
   * The paragraph for the server's daily report: pages served, documents
   * received in the period, and how many are stored.
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
      const stored = this.store.count();
      sentences.push(`${plural(received, 'IPS document')} ${received === 1 ? 'was' : 'were'} received; ${plural(stored, 'document')} ${stored === 1 ? 'is' : 'are'} stored.`);
    } else {
      sentences.push('The document store is not open.');
    }
    return sentences.join(' ');
  }

  async shutdown() {
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
    if (this.validator) {
      try {
        if (this.validatorStarting) {
          await this.validatorStarting;
        }
        await this.validator.stop();
      } catch (e) {
        this.log.error('IPS module: stopping the validator failed: ' + e.message);
      }
      this.validator = null;
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
      this.log.error(`IPS module: ${name} failed: ${e.stack || e.message}`);
      if (!res.headersSent) {
        // the detail is in the log; the response doesn't say what broke inside
        if (wantsHtml(req)) {
          htmlServer.sendErrorResponse(res, TEMPLATE, new Error('Something went wrong handling the request'));
        } else {
          this.sendOutcome(res, 500, 'exception', 'Internal error');
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

  projectUrl(req) {
    return `${this.baseUrl(req)}/${encodeURIComponent(req.project.code)}`;
  }

  sendJson(res, status, body) {
    res.status(status).set('Content-Type', FHIR_JSON).send(JSON.stringify(body, null, 2));
  }

  sendOutcome(res, status, code, messages) {
    const severity = status < 400 ? 'information' : 'error';
    this.sendJson(res, status, operationOutcome(severity, code, messages));
  }

  /**
   * @param {Object} [req] - when given and the request is for a project, the nav bar
   *   gets a link to the project
   */
  sendHtml(res, title, content, start, req) {
    const p = req && req.project;
    htmlServer.sendHtmlResponse(res, TEMPLATE, title, content, {
      version: packageJson.version,
      processingTime: Date.now() - start,
      contextLink: p ? ` &nbsp;|&nbsp; <a href="${escape(req.baseUrl)}/${encodeURIComponent(p.code)}" style="color: gold">${escape(p.name)}</a>` : ''
    });
  }

  /** What the renderers need to know about the request. */
  ctx(req, res) {
    const user = this.currentUser(req);
    return {
      base: req.baseUrl,
      user,
      csrf: res.locals._csrf,
      canManage: req.project ? this.canManage(user, req.project) : false,
      canShare: !!this.shl,
      codeSystemLink: this.tx ? (system) => this.tx.codeSystemLink(system) : null
    };
  }

  // ---- sharing ----

  /**
   * Share a document as an SHL or VHL QR code. The browser asks with fetch (JSON back);
   * without scripts, the form posts and gets a page.
   */
  async share(req, res) {
    const json = !wantsHtml(req) || /json/.test(req.get('Accept') || '');
    const fail = (status, message) => (json
      ? res.status(status).json({ error: message })
      : htmlServer.sendErrorResponse(res, TEMPLATE, new Error(message), status));
    if (!this.shl) {
      return fail(404, 'Sharing is not configured on this server (modules.ips.shl)');
    }
    const id = docId(req.params.id);
    const row = this.store.read(id, req.project.id);
    if (!row) {
      return fail(404, `No document with id '${req.params.id}'`);
    }
    const kind = req.body.kind === 'vhl' ? 'vhl' : 'shl';
    const label = row.patient_name ? `Patient Health Document for ${row.patient_name}` : 'Patient Health Document';
    let out;
    try {
      out = await this.shl.share(row.bundle, { kind, host: req.get('host'), label });
    } catch (e) {
      this.log.error(`IPS module: document ${id} could not be shared as ${kind}: ${e.message}`);
      return fail(502, e.message);
    }
    this.log.info(`IPS module: document ${id} in '${req.project.code}' shared as ${kind.toUpperCase()} (${out.bytes} bytes, until ${out.expires})`);
    if (json) {
      return res.json(out);
    }
    this.sendHtml(res, `${req.project.name}: Document ${id} - ${kind.toUpperCase()}`,
      render.renderShare(req.project, row, out, this.ctx(req, res)), Date.now(), req);
  }

  // ---- users ----

  /**
   * Who is logged in, with the projects they manage as they are now (not as they were at
   * login, so taking a project away, or deleting the user, takes effect at once).
   */
  currentUser(req) {
    const s = req.session;
    if (!s) {
      return null;
    }
    if (s.ipsAdmin) {
      return { name: 'Administrator', login: this.adminUsername, isAdmin: true, projects: [] };
    }
    if (s.ipsUserId) {
      const u = this.store.userById(s.ipsUserId);
      if (u) {
        return { id: u.id, name: u.name, login: u.login, isAdmin: false, projects: this.store.managedProjectIds(u.id) };
      }
    }
    return null;
  }

  canManage(user, project) {
    return !!user && (user.isAdmin || user.projects.includes(project.id));
  }

  sendLogin(req, res, status, error) {
    res.status(status);
    this.sendHtml(res, 'Login', render.renderLogin({ base: req.baseUrl, csrf: res.locals._csrf }, error), Date.now());
  }

  async login(req, res) {
    const login = typeof req.body.login === 'string' ? req.body.login.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    // for the log: no control characters, no novel
    const shown = login.replace(/[^\x20-\x7e]/g, '?').substring(0, 64);
    let ok = false;
    const regenerate = () => new Promise((resolve, reject) => req.session.regenerate(e => e ? reject(e) : resolve()));
    if (login === this.adminUsername) {
      if (this.adminHash && await bcrypt.compare(password, this.adminHash)) {
        await regenerate();
        req.session.ipsAdmin = true;
        ok = true;
      }
    } else {
      const user = login ? this.store.userByLogin(login) : null;
      // the comparison is made whether or not there is such a user, so the time taken
      // doesn't say which usernames exist
      if (await bcrypt.compare(password, user ? user.password_hash : this.dummyHash) && user) {
        await regenerate();
        req.session.ipsUserId = user.id;
        ok = true;
      }
    }
    if (!ok) {
      this.log.info(`IPS module: failed login for '${shown}' from ${req.ip}`);
      return this.sendLogin(req, res, 401, 'Unknown username or wrong password');
    }
    this.log.info(`IPS module: '${shown}' logged in from ${req.ip}`);
    res.redirect(req.baseUrl || '/');
  }

  // ---- administration: projects and users ----

  sendProjects(req, res, message, status = 200) {
    res.status(status);
    this.sendHtml(res, 'IPS Projects', render.renderProjects(this.store.projects(), this.store.users(), this.ctx(req, res), message), Date.now());
  }

  saveProject(req, res, id) {
    const code = typeof req.body.code === 'string' ? req.body.code.trim().toLowerCase() : '';
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
    const managers = [].concat(req.body.manager || []).filter(m => /^\d{1,9}$/.test(m)).map(m => parseInt(m, 10));
    let problem = null;
    if (id === null && (!CODE_RE.test(code) || RESERVED.has(code))) {
      problem = 'The code must be 2-32 lower case letters, digits and hyphens, starting with a letter or digit' +
        (RESERVED.has(code) ? `, and '${code}' is reserved` : '');
    } else if (!name || name.length > 200) {
      problem = 'A name is required (up to 200 characters)';
    } else if (description.length > 2000) {
      problem = 'The description can be up to 2000 characters';
    }
    if (problem) {
      return this.sendProjects(req, res, problem, 400);
    }
    let projectId;
    if (id === null) {
      if (this.store.projectByCode(code)) {
        return this.sendProjects(req, res, `There is already a project '${code}'`, 409);
      }
      projectId = this.store.createProject(code, name, description);
      this.log.info(`IPS module: project '${code}' created`);
    } else {
      projectId = parseInt(id, 10);
      if (!this.store.updateProject(projectId, name, description)) {
        return this.sendProjects(req, res, 'That project no longer exists', 404);
      }
    }
    this.store.setProjectManagers(projectId, managers);
    res.redirect(req.baseUrl + '/admin/projects');
  }

  sendUsers(req, res, message, status = 200) {
    res.status(status);
    this.sendHtml(res, 'IPS Users', render.renderUsers(this.store.users(), this.ctx(req, res), message), Date.now());
  }

  async saveUser(req, res, id) {
    const login = typeof req.body.login === 'string' ? req.body.login.trim() : '';
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    let problem = null;
    if (id === null && !/^[A-Za-z0-9._@-]{1,64}$/.test(login)) {
      problem = 'The username must be 1-64 letters, digits, or . _ @ -';
    } else if (id === null && login === this.adminUsername) {
      problem = `'${login}' is the administrator's login`;
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
      this.store.createUser(login, name, hash);
      this.log.info(`IPS module: user '${login}' created`);
    } else if (!this.store.updateUser(parseInt(id, 10), name, hash)) {
      return this.sendUsers(req, res, 'That user no longer exists', 404);
    }
    res.redirect(req.baseUrl + '/admin/users');
  }

  // ---- a project's settings ----

  projectWithManagers(project) {
    return { ...project, managers: (this.store.projects().find(p => p.id === project.id) || {}).managers || [] };
  }

  sendSettings(req, res, message, status = 200) {
    res.status(status);
    const ai = this.store.projectAi(req.project);
    const now = Date.now();
    const usage = {
      day: this.store.aiUsage(req.project.id, now - 24 * 60 * 60 * 1000),
      month: this.store.aiUsage(req.project.id, now - 30 * 24 * 60 * 60 * 1000),
      all: this.store.aiUsage(req.project.id, 0)
    };
    this.sendHtml(res, `${req.project.name}: Settings`,
      render.renderSettings(this.projectWithManagers(req.project), this.ctx(req, res), message, {
        ai, serverDefault: !!(this.config.ai?.apiKey && this.config.ai?.model), canKeep: !!this.aiSecret,
        serverModel: this.config.ai?.model || null, dailyCap: Number.isInteger(this.config.ai?.dailyCap) ? this.config.ai.dailyCap : 50,
        serverNarrative: this.config.ai?.sendNarrative === true, usage
      }), Date.now(), req);
  }

  saveSettings(req, res) {
    if (req.body.form === 'ai') {
      return this.saveAiSettings(req, res);
    }
    let token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    if (req.body.generate === '1') {
      token = crypto.randomUUID();
    }
    if (token && (token.length > 256 || /\s/.test(token))) {
      return this.sendSettings(req, res, 'The token must have no white space, and be at most 256 characters', 400);
    }
    this.store.setProjectToken(req.project.id, token || null);
    this.log.info(`IPS module: submission token for '${req.project.code}' ${token ? 'set' : 'cleared'} by ${req.user.name}`);
    req.project = this.store.projectById(req.project.id);
    this.sendSettings(req, res, token ? 'The token has been set' : 'The token has been cleared; anyone can submit');
  }

  /** The AI assessment settings: on/off, the account (its key encrypted), the daily cap. */
  saveAiSettings(req, res) {
    const b = req.body;
    const text = (v, max) => (typeof v === 'string' ? v.trim().substring(0, max) : '');
    const current = this.store.projectAi(req.project);
    const settings = {
      enabled: b.enabled === '1',
      provider: text(b.provider, 20),
      baseUrl: text(b.baseUrl, 500),
      model: text(b.model, 200),
      keyEnc: current.keyEnc || null,
      dailyCap: current.dailyCap
    };
    if (b.narrative === 'send' || b.narrative === 'strip') {
      settings.sendNarrative = b.narrative === 'send';
    }
    if (!aiClient.PROVIDERS[settings.provider]) {
      settings.provider = 'openai';
    }
    const cap = text(b.dailyCap, 10);
    if (cap !== '') {
      if (!/^\d{1,6}$/.test(cap)) {
        return this.sendSettings(req, res, 'The daily cap must be a whole number', 400);
      }
      settings.dailyCap = parseInt(cap, 10);
    } else {
      delete settings.dailyCap;
    }
    const apiKey = text(b.apiKey, 1000);
    if (b.clearKey === '1') {
      settings.keyEnc = null;
    } else if (apiKey) {
      if (!this.aiSecret) {
        return this.sendSettings(req, res, 'This server cannot keep AI keys: it has no aiKeySecret (or sessionSecret) configured', 400);
      }
      settings.keyEnc = aiClient.encryptKey(apiKey, this.aiSecret);
    }
    if (settings.keyEnc) {
      try {
        aiClient.checkAccount({ provider: settings.provider, baseUrl: settings.baseUrl, model: settings.model, apiKey: 'x' });
      } catch (e) {
        return this.sendSettings(req, res, e.message, 400);
      }
    }
    if (!settings.keyEnc) {
      settings.keyEnc = null;
    }
    this.store.setProjectAi(req.project.id, settings);
    this.log.info(`IPS module: AI assessment settings for '${req.project.code}' saved by ${req.user.name} (${settings.enabled ? 'on' : 'off'}, ${settings.keyEnc ? 'own account' : 'server default'})`);
    req.project = this.store.projectById(req.project.id);
    this.sendSettings(req, res, 'The AI assessment settings have been saved');
  }

  // ---- receiving documents ----

  /**
   * Store a document, once it has passed validation and the token check.
   * @returns {{id: number, bundle: Object}}
   */
  receive(req, bundle, source) {
    const now = Date.now();
    const id = this.store.insert(req.project.id, bundle, { ip: req.ip, source, receivedMs: now });
    this.log.info(`IPS module: document ${id} received in '${req.project.code}' (${source}, ${bundle.entry.length} entries)`);
    return { id, bundle };
  }

  /** The token from the Authorization header, without any "Bearer " prefix. */
  suppliedToken(req) {
    const v = req.get('Authorization');
    return typeof v === 'string' ? v.replace(/^Bearer\s+/i, '').trim() : v;
  }

  async create(req, res) {
    const p = req.project;
    if (tokenConfigured(p.token) && !tokenMatches(p.token, this.suppliedToken(req))) {
      res.set('WWW-Authenticate', 'Bearer');
      return this.sendOutcome(res, 401, 'login', "This project requires its submission token in the Authorization header");
    }
    if (!req.is('application/fhir+json') && !req.is('application/json')) {
      return this.sendOutcome(res, 415, 'not-supported', 'Documents must be JSON (application/fhir+json)');
    }
    const declared = parseInt(req.get('Content-Length') || '', 10);
    if (declared > this.maxSize) {
      return this.sendOutcome(res, 413, 'too-costly', `Documents can't be bigger than ${this.maxSize} bytes`);
    }

    // the server's body parsers have already run: application/fhir+json arrives as a
    // Buffer, application/json already parsed
    let bundle;
    if (Buffer.isBuffer(req.body)) {
      if (req.body.length > this.maxSize) {
        return this.sendOutcome(res, 413, 'too-costly', `Documents can't be bigger than ${this.maxSize} bytes`);
      }
      try {
        bundle = JSON.parse(req.body.toString('utf8'));
      } catch (e) {
        return this.sendOutcome(res, 400, 'structure', 'The body is not valid JSON: ' + e.message);
      }
    } else if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      bundle = req.body;
      if (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > this.maxSize) {
        return this.sendOutcome(res, 413, 'too-costly', `Documents can't be bigger than ${this.maxSize} bytes`);
      }
    } else {
      return this.sendOutcome(res, 400, 'structure', 'No document was found in the body');
    }

    const problems = validateDocument(bundle);
    if (problems.length > 0) {
      return this.sendOutcome(res, 400, 'invalid', problems);
    }
    const { id, bundle: stored } = this.receive(req, bundle, 'api');

    const location = `${this.projectUrl(req)}/Bundle/${id}`;
    res.set('Location', location);
    res.set('Last-Modified', new Date(stored.meta.lastUpdated).toUTCString());
    const ret = preferValue(req, 'return');
    if (ret === 'minimal') {
      return res.status(201).end();
    }
    if (ret === 'OperationOutcome') {
      return this.sendOutcome(res, 201, 'informational', `Document stored as ${location}`);
    }
    return this.sendJson(res, 201, stored);
  }

  sendSubmit(req, res, options = {}, status = 200) {
    res.status(status);
    this.sendHtml(res, `${req.project.name}: Submit a Document`,
      render.renderSubmit(req.project, this.ctx(req, res), { needsToken: tokenConfigured(req.project.token), aiEnabled: this.store.projectAi(req.project).enabled === true, ...options }), Date.now(), req);
  }

  // ---- clinical profiles ----

  /** The clinical profiles: a page, or a FHIR searchset of the StructureDefinitions. */
  profileList(req, res) {
    const list = this.store.profiles();
    if (!wantsHtml(req)) {
      const base = this.baseUrl(req);
      const entry = list.map(p => this.store.profile(p.id)).filter(Boolean).map(sd => ({ fullUrl: `${base}/StructureDefinition/${sd.id}`, resource: sd, search: { mode: 'match' } }));
      res.type('application/fhir+json');
      return res.send(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', total: entry.length, entry }));
    }
    this.sendHtml(res, 'Clinical Profiles', render.renderProfiles(list, this.ctx(req, res)), Date.now(), req);
  }

  /** A clinical profile: the page, the StructureDefinition, or the StructureDefinition as a download. */
  profileRead(req, res) {
    const sd = req.profile;
    if (req.query.download !== undefined) {
      res.setHeader('Content-Disposition', `attachment; filename="${sd.name || 'profile'}.json"`);
      res.type('application/fhir+json');
      return res.send(JSON.stringify(sd, null, 2));
    }
    if (!wantsHtml(req)) {
      res.type('application/fhir+json');
      return res.send(JSON.stringify(sd));
    }
    this.sendHtml(res, `Clinical Profile: ${sd.title}`, render.renderProfile(sd, { ...this.ctx(req, res), valueSetTitle: (url) => this.valueSetTitle(url) }), Date.now(), req);
  }

  /** The title of one of this module's own value sets, or null. */
  valueSetTitle(url) {
    const vs = this.valueSets && typeof url === 'string' ? this.valueSets.valueSet(url.split('|')[0]) : null;
    return vs ? (vs.title || vs.name || null) : null;
  }

  /** The editor, for a new profile or an existing one. */
  profileEditor(req, res, sd) {
    const constraints = profiles.constraintsOf(sd).map(c => ({ ...c, shape: profiles.parseShape(c.expression), rshape: profiles.parseResourceShape(c.expression) }));
    this.sendHtml(res, sd ? `Edit Clinical Profile: ${sd.title}` : 'New Clinical Profile',
      render.renderProfileEditor(sd, this.ctx(req, res), {
        profile: { id: sd ? sd.id : null, title: sd ? sd.title : '', constraints },
        sections: profiles.IPS_SECTIONS, systems: profiles.SYSTEMS, resourceTypes: profiles.RESOURCE_TYPES, sectionSystem: editorSchema.LOINC, canLookup: !!this.tx
      }), Date.now(), req);
  }

  /**
   * Save a profile from the editor ({title, constraints}), or a new one from an uploaded
   * StructureDefinition ({upload}). 200/201 with {id, url}, or 422 with {problems}.
   */
  profileSave(req, res, previous) {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    let input = body;
    if (body.upload !== undefined) {
      if (previous) {
        return res.status(400).json({ problems: ['An upload makes a new profile; it can\'t replace one'] });
      }
      const up = profiles.fromUpload(body.upload);
      if (up.problems.length) {
        return res.status(422).json({ problems: up.problems });
      }
      input = up.input;
    }
    const checked = profiles.checkInput(input, previous);
    if (checked.problems.length) {
      return res.status(422).json({ problems: checked.problems });
    }
    const id = previous ? previous.id.substring('profile-'.length) : profiles.newId();
    const url = previous ? previous.url : `${this.baseUrl(req)}/StructureDefinition/profile-${id}`;
    const sd = profiles.build({ id, url, title: checked.title, constraints: checked.constraints });
    this.store.saveProfile(id, sd);
    this.log.info(`IPS module: clinical profile ${sd.id} (${sd.title}) ${previous ? 'saved' : (body.upload !== undefined ? 'uploaded' : 'created')}, ${checked.constraints.length} constraints`);
    res.status(previous ? 200 : 201).json({ id: sd.id, url: `${req.baseUrl}/StructureDefinition/${sd.id}` });
  }

  // ---- the editor ----

  sendCompose(req, res) {
    let model = null;
    let from = null;
    if (typeof req.query.from === 'string' && /^\d{1,12}$/.test(req.query.from)) {
      const row = this.store.read(parseInt(req.query.from, 10), req.project.id);
      if (!row) {
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error(`No document with id '${req.query.from}'`), 404);
      }
      model = composer.modelOf(row.bundle);
      from = row.id;
    }
    this.sendHtml(res, `${req.project.name}: ${from ? `Edit Document ${from}` : 'Compose a Document'}`,
      render.renderCompose(req.project, this.ctx(req, res), {
        schema: editorSchema.forBrowser(), model, from, needsToken: tokenConfigured(req.project.token),
        aiEnabled: this.store.projectAi(req.project).enabled === true, canLookup: !!(this.tx && this.valueSets)
      }), Date.now(), req);
  }

  /**
   * A code lookup for the editor: the value set's codes whose display matches the text,
   * from the terminology server (ValueSet/$expand with a filter; the value set and what
   * it draws on go with the request).
   */
  async lookup(req, res) {
    const vsId = typeof req.query.vs === 'string' ? req.query.vs : '';
    if (!this.tx || !this.valueSets) {
      return res.status(503).json({ error: 'No terminology server is configured', matches: [] });
    }
    const url = /^[a-z0-9-]{1,64}$/.test(vsId) ? `${editorSchema.VS}${vsId}` : '';
    const vs = url ? this.valueSets.valueSet(url) : null;
    if (!vs) {
      return res.status(400).json({ error: 'Unknown value set', matches: [] });
    }
    return this.expandLookup(req, res, vs, this.valueSets.referencedResources(url), vsId);
  }

  /**
   * A code lookup in one code system (any code in it), for the clinical profile editor:
   * an ad hoc value set of the whole system.
   */
  async systemLookup(req, res) {
    const system = typeof req.query.system === 'string' ? req.query.system.trim() : '';
    if (!this.tx) {
      return res.status(503).json({ error: 'No terminology server is configured', matches: [] });
    }
    if (!/^[a-z][a-z0-9+.-]*:\S{1,250}$/i.test(system)) {
      return res.status(400).json({ error: 'The code system must be a URI', matches: [] });
    }
    const vs = { resourceType: 'ValueSet', status: 'active', compose: { include: [{ system }] } };
    return this.expandLookup(req, res, vs, [], system);
  }

  /**
   * Value sets, for the clinical profile editor: ?q= finds them by title - this module's
   * own first, then the terminology server's (a ValueSet search); ?url= finds the one with
   * that canonical (|version or not). {matches: [{url, version, title, own}]}
   */
  async valueSetLookup(req, res) {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase().substring(0, 100) : '';
    const url = typeof req.query.url === 'string' ? req.query.url.trim().substring(0, 300) : '';
    const canonical = url.split('|')[0];
    const own = this.valueSets ? this.valueSets.all().map(v => ({ ...v, own: true })) : [];
    let matches;
    if (url) {
      matches = own.filter(v => v.url === canonical);
    } else if (q.length >= 2) {
      matches = own.filter(v => v.title.toLowerCase().includes(q) || v.url.toLowerCase().includes(q));
    } else {
      return res.json({ matches: [] });
    }
    if (matches.length === 0 || (!url && matches.length < 20)) {
      if (!this.tx) {
        return res.json({ matches, error: matches.length ? undefined : 'No terminology server is configured' });
      }
      await this.checkTxServer();
      if (this.txMissing) {
        return res.json({ matches, error: matches.length ? undefined : `Nothing answers at the terminology server ${this.tx.url} on this server yet` });
      }
      let r;
      try {
        r = await this.tx.get('/ValueSet', { ...(url ? { url: canonical } : { title: q }), _elements: 'url,version,title,name', _count: 20 });
      } catch (e) {
        this.log.error(`IPS module: value set lookup failed: ${e.message}`);
        return res.json({ matches, error: matches.length ? undefined : 'The terminology server could not be reached' });
      }
      if (r.status === 200 && r.resource?.resourceType === 'Bundle') {
        const seen = new Set(matches.map(m => `${m.url}|${m.version}`));
        for (const e of Array.isArray(r.resource.entry) ? r.resource.entry : []) {
          const v = e?.resource;
          if (v?.resourceType === 'ValueSet' && typeof v.url === 'string' && !seen.has(`${v.url}|${v.version || null}`)) {
            seen.add(`${v.url}|${v.version || null}`);
            matches.push({ url: v.url, version: typeof v.version === 'string' ? v.version : null, title: typeof v.title === 'string' ? v.title : (typeof v.name === 'string' ? v.name : v.url), own: false });
          }
        }
      } else if (!matches.length) {
        return res.json({ matches, error: `The terminology server answered HTTP ${r.status} to a ValueSet search` });
      }
    }
    res.json({ matches: matches.slice(0, 20) });
  }

  /**
   * A session for entryIn() and resourcesIn() over one document: membership asked of the
   * terminology server as the rules need it, the definite answers kept across documents.
   */
  membershipSession() {
    return new MembershipSession(this.tx, this.valueSets, { cache: this.txCache || (this.txCache = new Map()), log: this.log });
  }

  /** The matches for ?q= in a value set, from the terminology server ($expand with a filter). */
  async expandLookup(req, res, vs, txResources, label) {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().substring(0, 100) : '';
    await this.checkTxServer();
    if (this.txMissing) {
      return res.status(503).json({ error: `Nothing answers at the terminology server ${this.tx.url} on this server yet (modules.ips.txServer)`, matches: [] });
    }
    if (q.length < 2) {
      return res.json({ matches: [] });
    }
    const params = { resourceType: 'Parameters', parameter: [
      { name: 'valueSet', resource: vs },
      ...txResources.map(r => ({ name: 'tx-resource', resource: r })),
      { name: 'filter', valueString: q },
      { name: 'count', valueInteger: 20 },
      { name: 'includeDesignations', valueBoolean: false }
    ] };
    let r;
    try {
      r = await this.tx.post('/ValueSet/$expand', params);
    } catch (e) {
      this.log.error(`IPS module: lookup in ${label} failed: ${e.message}`);
      return res.status(502).json({ error: 'The terminology server could not be reached', matches: [] });
    }
    // an expansion with nothing in it has no contains at all
    const expansion = r.resource?.resourceType === 'ValueSet' && r.resource.expansion && typeof r.resource.expansion === 'object' ? r.resource.expansion : null;
    const contains = expansion ? (Array.isArray(expansion.contains) ? expansion.contains : []) : null;
    if (r.status !== 200 || !contains) {
      const issue = (Array.isArray(r.resource?.issue) ? r.resource.issue : []).map(i => i?.details?.text || i?.diagnostics).filter(Boolean)[0];
      this.log.warn(`IPS module: lookup in ${label} for '${q}' answered ${r.status}: ${issue || (r.text || '').replace(/\s+/g, ' ').substring(0, 200) || '(no body)'}`);
      return res.status(502).json({ error: `The terminology server could not look that up (HTTP ${r.status}${issue ? `: ${issue.substring(0, 200)}` : ''})`, matches: [] });
    }
    res.json({ matches: contains.filter(c => c && typeof c.code === 'string').slice(0, 20).map(c => ({ system: c.system, code: c.code, display: typeof c.display === 'string' ? c.display : c.code })) });
  }

  /** What the editor posts: build the document, and submit it or hand it back. */
  async compose(req, res) {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const action = body.action === 'download' ? 'download' : 'submit';
    const p = req.project;
    if (action === 'submit') {
      const supplied = typeof body.token === 'string' ? body.token.trim() : '';
      if (tokenConfigured(p.token) && !tokenMatches(p.token, supplied)) {
        return res.status(401).json({ error: 'The submission token is missing or wrong' });
      }
    }
    let built;
    try {
      built = await composer.build(body.model);
    } catch (e) {
      this.log.error(`IPS module: composing a document failed: ${e.message}`);
      return res.status(500).json({ error: 'The document could not be built' });
    }
    if (!built.bundle) {
      return res.status(400).json({ error: 'The document could not be built', problems: built.problems });
    }
    const problems = validateDocument(built.bundle);
    if (problems.length > 0) {
      return res.status(400).json({ error: 'The document could not be built', problems });
    }
    const text = JSON.stringify(built.bundle);
    if (Buffer.byteLength(text, 'utf8') > this.maxSize) {
      return res.status(413).json({ error: `Documents can't be bigger than ${this.maxSize} bytes` });
    }
    if (action === 'download') {
      res.type(FHIR_JSON);
      res.set('Content-Disposition', 'attachment; filename="ips.json"');
      return res.send(text);
    }
    const { id } = this.receive(req, built.bundle, 'editor');
    res.status(201).json({ id, url: `${req.baseUrl}/${encodeURIComponent(p.code)}/Bundle/${id}` });
  }

  async submitForm(req, res) {
    const p = req.project;
    const text = typeof req.body.bundle === 'string' ? req.body.bundle : '';
    const supplied = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    if (tokenConfigured(p.token) && !tokenMatches(p.token, supplied)) {
      return this.sendSubmit(req, res, { error: 'The submission token is missing or wrong', bundle: text }, 401);
    }
    if (Buffer.byteLength(text, 'utf8') > this.maxSize) {
      return this.sendSubmit(req, res, { error: `Documents can't be bigger than ${this.maxSize} bytes` }, 413);
    }
    let bundle;
    try {
      bundle = JSON.parse(text);
    } catch (e) {
      return this.sendSubmit(req, res, { error: 'The document is not valid JSON: ' + e.message, bundle: text }, 400);
    }
    const problems = validateDocument(bundle);
    if (problems.length > 0) {
      return this.sendSubmit(req, res, { error: problems.join('. '), bundle: text }, 400);
    }
    const { id } = this.receive(req, bundle, 'form');
    res.redirect(`${req.baseUrl}/${encodeURIComponent(p.code)}/Bundle/${id}`);
  }

  // ---- FHIR API: read, search, metadata ----

  async read(req, res) {
    const start = Date.now();
    const id = docId(req.params.id);
    const row = this.store.read(id, req.project.id);
    // ?download=1 is the JSON as a file, whatever the client is
    if (wantsHtml(req) && req.query.download !== '1') {
      if (!row) {
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error(`No document with id '${req.params.id}'`), 404);
      }
      const view = render.VIEWS.some(([v]) => v === req.query.view) ? req.query.view : render.VIEWS[0][0];
      row.results = {};
      for (const step of this.steps) {
        row.results[step.name] = this.store.readResult(row.id, step.name);
      }
      const ctx = {
        ...this.ctx(req, res),
        steps: this.steps.map(st => st.name),
        level: typeof req.query.level === 'string' ? req.query.level : undefined,
        problemsOnly: req.query.problems === '1'
      };
      return this.sendHtml(res, `${req.project.name}: Document ${row.id}`, render.renderDocument(req.project, row, view, ctx), start, req);
    }
    if (!row) {
      return this.sendOutcome(res, 404, 'not-found', `No Bundle with id '${req.params.id}'`);
    }
    res.set('Last-Modified', new Date(row.received).toUTCString());
    if (req.query.download === '1') {
      res.set('Content-Disposition', `attachment; filename="ips-${req.project.code}-${row.id}.json"`);
    }
    return this.sendJson(res, 200, row.bundle);
  }

  async search(req, res) {
    const search = parseSearch(req.query);
    if (search.errors.length > 0) {
      return this.sendOutcome(res, 400, 'invalid', search.errors);
    }
    if (search.unknown.length > 0 && preferValue(req, 'handling') === 'strict') {
      return this.sendOutcome(res, 400, 'not-supported', search.unknown.map(u => `Unknown search parameter '${u}'`));
    }
    const results = this.store.search(req.project.id, search, { withJson: true });
    const base = this.projectUrl(req);

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
      return `${base}/Bundle?${u.toString()}`;
    };
    const links = [{ relation: 'self', url: link(search.offset) }];
    if (!search.summaryCount && search.count > 0) {
      links.push({ relation: 'first', url: link(0) });
      if (search.offset > 0) {
        links.push({ relation: 'previous', url: link(Math.max(0, search.offset - search.count)) });
      }
      // the next page starts where this one stopped, which is short of _count when the
      // page's byte budget cut it
      const pageEnd = search.offset + (results.truncated ? results.rows.length : search.count);
      if (pageEnd < results.total) {
        links.push({ relation: 'next', url: link(pageEnd) });
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
        fullUrl: `${base}/Bundle/${row.id}`,
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
    const p = req.project;
    const cs = {
      resourceType: 'CapabilityStatement',
      status: 'active',
      date: new Date().toISOString(),
      kind: 'instance',
      software: { name: 'FHIRsmith', version: packageJson.version },
      implementation: {
        description: `FHIRsmith IPS repository: ${p.name}`,
        url: this.projectUrl(req)
      },
      fhirVersion: '4.0.1',
      format: ['json'],
      rest: [{
        mode: 'server',
        documentation: tokenConfigured(p.token)
          ? 'Submitting a document requires the project\'s token in the Authorization header (Bearer)'
          : 'Anyone may submit a document',
        resource: [{
          type: 'Bundle',
          profile: 'http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips',
          documentation: 'IPS documents: a Bundle of type document whose first entry is the Composition. ' +
            'Composition and Patient parameters are reached by chaining: composition.date, composition.patient.name',
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
    let problems = search.errors;
    if (problems.length > 0) {
      // show everything rather than nothing
      const fallback = parseSearch({ _count: query._count });
      search.where = fallback.where;
      search.args = fallback.args;
    }
    const results = this.store.search(req.project.id, search, { identifier: typeof query.identifier === 'string' ? query.identifier : undefined });
    this.sendHtml(res, req.project.name, render.renderProject(req.project, query, results, search, this.ctx(req, res), problems), start, req);
  }
}

module.exports = IpsModule;
module.exports.validateDocument = validateDocument;
module.exports.CODE_RE = CODE_RE;
