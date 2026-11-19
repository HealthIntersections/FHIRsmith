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
 * Logins are the server's (library/auth): the administrator manages the module, and the
 * managers of a project are the users given the ips "manager" role for it. CSRF tokens are on
 * every form.
 *
 * @module ips/ips
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const scripts = require('./scripts');
const assets = require('./assets');
const { minimalIpsProblems } = require('./minimal');
const rateLimit = require('express-rate-limit');
const escape = require('escape-html');
const auth = require('../library/auth');

// the role of the users who can be made managers of projects
const PROJECT_ADMIN = 'project-admin';
// the role of the users approved to submit to a project, when it takes approved users
const SUBMITTER = 'submitter';

const folders = require('../library/folder-setup');
const htmlServer = require('../library/html-server');
const { tokenMatches, tokenConfigured } = require('../library/request-token');
const { requireSameOrigin } = require('../library/same-origin');
const { checkNarrative, checkResourceNarratives } = require('../library/narrative-check');
const packageJson = require('../package.json');
const { IpsStore } = require('./store');
const patients = require('./patients');
const { parseSearch, listQueryToSearch, capabilitySearchParams, compositionOf, patientOf } = require('./search');
const render = require('./render');
const { TxClient } = require('./tx-client');
const { STEPS, stripChecks } = require('./pipeline');
const { Reports, SOURCES: REPORT_SOURCES } = require('./reports');

// the extension definitions remembered from the validator (the analysis step)
const MAX_CACHED_EXTENSIONS = 5000;
const { IpsValueSets } = require('./ips-valuesets');
const aiClient = require('./ai-client');
const { ShlClient } = require('./share');
const { ShlViewer, Trace } = require('./viewer');
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
// the document creators (the general and patient IPS editors), as the chooser lists them
const EDITORS = [
  { key: 'general', name: 'General IPS editor', description: 'An editor for the whole IPS: the patient, the author, and each section, with coded entries looked up on the terminology server. For people who know what goes in a patient summary.' },
  { key: 'patient', name: 'Patient IPS editor', description: 'A form for patients to fill in about themselves - who they are, their story and goals, their medical history, care needs and preferences - that becomes an IPS document. It offers test patients, and can load an IPS document to edit.' }
];
/**
 * A document's page title: IPS #{id}: what the document is - its title, with the patient's
 * name if the title doesn't already have it (many say just "Patient Summary"), and its date
 * when it has no title.
 */
function documentPageTitle(row) {
  const title = String(row.comp_title || '').trim();
  const patient = String(row.patient_name || '').trim();
  const date = String(row.comp_date || '').substring(0, 10);
  let what;
  if (title && patient && !title.toLowerCase().includes(patient.toLowerCase())) {
    what = `${title} - ${patient}`;
  } else if (title) {
    what = title;
  } else if (patient) {
    what = date ? `${patient}, ${date}` : patient;
  } else {
    what = date ? `Patient Summary, ${date}` : 'Patient Summary';
  }
  return `IPS #${row.id}: ${what.length > 120 ? what.substring(0, 117) + '...' : what}`;
}

/** The patient's name in a document, for a share's label: text, or given and family; '' if none. */
function summaryOfName(bundle) {
  const n = (patientOf(bundle) || {}).name;
  const name = Array.isArray(n) ? n.find(x => x && typeof x === 'object') : null;
  if (!name) {
    return '';
  }
  if (typeof name.text === 'string' && name.text.trim()) {
    return name.text.trim().substring(0, 100);
  }
  const given = Array.isArray(name.given) ? name.given.filter(g => typeof g === 'string') : [];
  return [...given, typeof name.family === 'string' ? name.family : ''].join(' ').trim().substring(0, 100);
}
// how long a document shared from an editor stays available, by default (days)
const DEFAULT_EDITOR_SHARE_DAYS = 5;
// paths at the root that can't be project codes
const { jurisdiction: jurisdictionOf } = require('./jurisdictions');
const { SNOMED_LINKABLE_EDITIONS } = require('../tx/sct/editions');
const RESERVED = new Set(['login', 'logout', 'admin', 'metadata', 'openapi', 'static', 'assets', 'lookup', 'national-profiles', 'queue', 'view', 'compose', 'reports']);
// how long the SHL viewer keeps what it retrieved (modules.ips.viewer.keepMinutes)
const DEFAULT_VIEW_KEEP_MINUTES = 60;
// a viewer page's address
const VIEW_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
// the most a link given to the viewer can be (a VHL is about 300 characters, an SHL less)
const MAX_LINK_LENGTH = 20000;

/**
 * What's wrong with a national profile's details, or null: a jurisdiction (a country's ISO 3166
 * two-letter code, or a region's UN M49 three-digit code - see jurisdictions.js), a FHIR package id (lower case, at
 * least two parts separated by dots), a version (as package versions are written), the
 * canonical URL (http or https) of the IG's profile on Bundle, and - optionally - the SNOMED CT
 * edition the IG takes for granted, by its module id (one of SNOMED_LINKABLE_EDITIONS).
 */
function nationalProfileProblem(jurisdiction, packageId, version, url, snomedEdition) {
  if (!jurisdictionOf(jurisdiction)) {
    return 'The jurisdiction must be a country, by its ISO 3166 two-letter code (e.g. AU), or a region, by its UN M49 three-digit code (e.g. 150 for Europe)';
  }
  if (packageId.length > 128 || !/^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/.test(packageId)) {
    return 'The package id must be a FHIR package id: lower case letters, digits, - and _, in two or more parts separated by dots (e.g. hl7.fhir.au.ips)';
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(version)) {
    return 'The version must be a package version (e.g. 1.0.0, or 1.1.0-ballot)';
  }
  if (url.length > 1024 || !/^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/.test(url)) {
    return 'The profile must be the canonical URL (http or https) of the IG\'s profile on Bundle';
  }
  if (snomedEdition && !SNOMED_LINKABLE_EDITIONS.has(snomedEdition)) {
    return 'The SNOMED CT edition must be one of the editions offered (or none)';
  }
  return null;
}

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
    // routes that look up who is asking (library/auth) are rate limited, for requests that bring
    // a login or a token (anonymous requests aren't counted)
    this.router.use(rateLimit(auth.credentialLimits()));
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
    // reports (reports.js): their tables are in a database of their own, beside this one
    const rcfg = this.config.reports || {};
    const rdb = rcfg.database || (dbPath === ':memory:' ? ':memory:' : path.join(path.dirname(dbPath), 'ips-reports.db'));
    const reportsPath = rdb === ':memory:' || path.isAbsolute(rdb) ? rdb : path.join(folders.databasesDir(), rdb);
    this.reports = new Reports({ store: this.store, dbPath: reportsPath, log: this.log, config: rcfg });
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

    // users and logins are the server's (library/auth). The manager of a project, granted on the
    // projects page or the user's page; and the IPS Project Admins, the users the projects page
    // offers as managers, given by the administrator on the user's page
    auth.defineRoles('ips', [{
      role: 'manager', label: 'Manage project', description: 'The project\'s settings and submission token, and deleting and reprocessing its documents',
      scope: { label: 'Project', values: () => this.store.projects().map(p => ({ value: String(p.id), label: `${p.code} (${p.name})` })) }
    }, {
      role: SUBMITTER, label: 'Submit documents', description: 'Submit documents to the project, when it takes them from approved users',
      scope: { label: 'Project', values: () => this.store.projects().map(p => ({ value: String(p.id), label: `${p.code} (${p.name})` })) }
    }, {
      role: PROJECT_ADMIN, label: 'IPS Project Admin', description: 'Can be made a manager of IPS projects: the projects page offers only these users'
    }], { title: 'IPS', path: '/ips' });
    auth.addAdminPage('ips', { label: 'Projects', path: '/ips/admin/projects', description: 'make and remove IPS projects, and give them managers' });
    auth.addAdminPage('ips', { label: 'Reports', path: '/ips/reports', description: 'the reports projects can run' });
    if (tokenConfigured(this.config.adminPassword)) {
      this.log.warn('IPS module: modules.ips.adminPassword is no longer used - the server\'s administrators (auth.administrators) manage the module');
    }

    // the terminology server: links to code systems, and the analysis's queries. None
    // configured, no links and no analysis
    this.tx = null;
    // set by checkTxServer while a path on this server has nothing (good) at it
    this.txMissing = false;
    if (this.config.txServer) {
      this.tx = new TxClient(this.config.txServer, { app: this.app, log: this.log });
      if (this.tx.internal) {
        // a path on this server must be one of the tx module's endpoints. The tx module is
        // set up after this one, so the check is made when the queue first runs (checkTxServer);
        // until it has answered, the server is taken to be not there yet
        this.txChecked = false;
        this.txMissing = true;
      }
      this.startedAt = Date.now();
    } else {
      this.log.warn('IPS module: no txServer configured - code systems will not be linked, and documents will not be analysed');
    }

    // the secret the projects' AI keys are encrypted with: its own, else the module's old
    // sessionSecret (keys stored before logins moved to the server were encrypted with it)
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

    // the SHL viewer: other systems can name this server's /ips/view as the viewer in their SHLs
    this.viewer = null;
    if (this.config.viewer?.enabled !== false) {
      this.viewer = new ShlViewer(this.config.viewer || {}, { log: this.log });
      const minutes = this.config.viewer?.keepMinutes;
      this.viewKeepMinutes = typeof minutes === 'number' && minutes > 0 ? minutes : DEFAULT_VIEW_KEEP_MINUTES;
    }

    this.setupSession();
    this.setupRootRoutes();
    this.setupProfileRoutes();
    this.setupNationalProfileRoutes();
    this.setupReportRoutes();
    this.setupViewerRoutes();
    this.setupComposeRoutes();
    this.setupProjectRoutes();
    this.setupValidator();
    this.setupValueSets();
    this.setupQueue();
    this.log.info(`IPS module: ${this.store.projects().length} projects, ${this.store.count()} documents in ${dbPath}; max ${this.maxSize} bytes; ` +
      `terminology server ${this.tx ? (this.tx.internal ? `${this.tx.url} (this server)` : this.tx.url) : 'none'}`);
  }

  /**
   * The login session and CSRF protection are the server's (library/auth). The FHIR API (POST
   * Bundle) is authenticated by a token in a header, not a cookie, so it gets neither; the
   * pages get this.web, and every form post gets sameOrigin + this.session + a form parser +
   * this.csrf.
   */
  setupSession() {
    this.session = auth.session;
    this.csrf = auth.csrf;
    this.web = auth.web;
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
    const admin = (req, res, next) => {
      auth.denyFraming(res);
      const user = this.currentUser(req);
      if (!user) {
        return res.redirect(auth.loginUrl(req));
      }
      if (!user.isAdmin) {
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error('Only the administrator can do that'), 403);
      }
      req.user = user;
      next();
    };
    this.adminOnly = admin;

    r.get('/', ...this.web, h('home', (req, res) => {
      this.sendHtml(res, 'International Patient Summary', render.renderHome(this.store.projects(), { ...this.ctx(req, res), viewerUrl: this.viewer ? this.viewerUrl(req) : null }), Date.now());
    }));

    // Every page with a form has this.session, this.csrf; every form post has sameOrigin,
    // this.session, form, this.csrf. They are written out in each route rather than spread
    // from an array, so that CodeQL can see the CSRF middleware on every cookie-using route.
    // the processing queue: one for the whole module
    r.get('/queue', ...this.web, h('queue', (req, res) => this.sendQueue(req, res)));
    // logging in is the server's: an old link to the module's login page goes there
    r.get('/login', (req, res) => res.redirect(auth.loginUrl(req, req.baseUrl || '/')));

    r.get('/admin/projects', this.session, this.csrf, admin, h('projects', (req, res) => this.sendProjects(req, res)));
    r.post('/admin/projects', this.sameOrigin, this.session, this.form, this.csrf, admin, h('projects', (req, res) => this.saveProject(req, res, null)));
    r.post('/admin/projects/:id', this.sameOrigin, this.session, this.form, this.csrf, admin, h('projects', (req, res) => this.saveProject(req, res, req.params.id)));
    r.post('/admin/projects/:id/delete', this.sameOrigin, this.session, this.form, this.csrf, admin, h('projects', (req, res) => {
      const p = this.store.projectById(parseInt(req.params.id, 10));
      if (p && this.store.deleteProject(p.id)) {
        this.reports.deleteProject(p.id);
        auth.setHolders('ips', 'manager', String(p.id), []);
        this.log.info(`IPS module: project '${p.code}' deleted by the administrator`);
      }
      res.redirect(req.baseUrl + '/admin/projects');
    }));
    // users are the server's
    r.get('/admin/users', (req, res) => res.redirect('/auth/admin/users'));
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

    r.get('/profile-editor.js', scripts.handler('profile-editor.js'));
    r.get('/lookup', this.session, adminJson, ...this.lookups, h('lookup', (req, res) => this.systemLookup(req, res)));
    r.get('/lookup-vs', this.session, adminJson, ...this.lookups, h('lookup', (req, res) => this.valueSetLookup(req, res)));
    r.get('/StructureDefinition', ...this.web, h('profiles', (req, res) => this.profileList(req, res)));
    r.get('/StructureDefinition/new', this.session, this.csrf, admin, h('profiles', (req, res) => this.profileEditor(req, res, null)));
    r.post('/StructureDefinition', this.sameOrigin, this.session, json, this.csrf, adminJson, h('profiles', (req, res) => this.profileSave(req, res, null)));
    r.get('/StructureDefinition/:id', profile, ...this.web, h('profile', (req, res) => this.profileRead(req, res)));
    r.get('/StructureDefinition/:id/edit', profile, this.session, this.csrf, admin, h('profile', (req, res) => this.profileEditor(req, res, req.profile)));
    r.post('/StructureDefinition/:id', profile, this.sameOrigin, this.session, json, this.csrf, adminJson, h('profile', (req, res) => this.profileSave(req, res, req.profile)));
    // one constraint at a time, from the profile's page: add, edit (keeping its key), delete
    r.post('/StructureDefinition/:id/constraint', profile, this.sameOrigin, this.session, json, this.csrf, adminJson, h('profile', (req, res) => this.constraintSave(req, res, null)));
    r.post('/StructureDefinition/:id/constraint/:key', profile, this.sameOrigin, this.session, json, this.csrf, adminJson, h('profile', (req, res) => this.constraintSave(req, res, req.params.key)));
    r.post('/StructureDefinition/:id/constraint/:key/delete', profile, this.sameOrigin, this.session, this.form, this.csrf, admin, h('profile', (req, res) => this.constraintDelete(req, res)));
    r.post('/StructureDefinition/:id/delete', profile, this.sameOrigin, this.session, this.form, this.csrf, admin, h('profile', (req, res) => {
      this.store.deleteProfile(req.profileId);
      res.redirect(req.baseUrl + '/StructureDefinition');
    }));
  }

  /**
   * The national profiles, across all projects: everyone can see them, only the administrator
   * adds, edits and deletes them. Before the project routes, so /national-profiles isn't taken
   * for a project code.
   */
  setupNationalProfileRoutes() {
    const r = this.router;
    const h = (name, fn) => (req, res) => this.handle(req, res, name, () => fn(req, res));
    const admin = this.adminOnly;
    r.get('/national-profiles', ...this.web, h('national-profiles', (req, res) => this.sendNationalProfiles(req, res)));
    r.post('/national-profiles', this.sameOrigin, this.session, this.form, this.csrf, admin, h('national-profiles', (req, res) => this.saveNationalProfile(req, res, null)));
    r.post('/national-profiles/:id', this.sameOrigin, this.session, this.form, this.csrf, admin, h('national-profiles', (req, res) => this.saveNationalProfile(req, res, req.params.id)));
    r.post('/national-profiles/:id/delete', this.sameOrigin, this.session, this.form, this.csrf, admin, h('national-profiles', (req, res) => {
      const np = /^\d{1,15}$/.test(req.params.id) ? this.store.nationalProfile(parseInt(req.params.id, 10)) : null;
      if (np && this.store.deleteNationalProfile(np.id)) {
        this.log.info(`IPS module: national profile ${np.packageId}#${np.version} deleted`);
      }
      res.redirect(req.baseUrl + '/national-profiles');
    }));
  }

  /**
   * Reports, across all projects (reports.js): everyone can see their definitions, only the
   * administrator adds, edits and deletes them. Before the project routes, so /reports isn't
   * taken for a project code; each project shows them under {code}/reports.
   */
  setupReportRoutes() {
    const r = this.router;
    const h = (name, fn) => (req, res) => this.handle(req, res, name, () => fn(req, res));
    const admin = this.adminOnly;
    // a ViewDefinition and its statements are more than the usual form
    const reportForm = express.urlencoded({ extended: false, limit: '1mb' });
    const report = (req, res, next) => {
      const rep = this.reports.get(req.params.id);
      if (!rep) {
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error(`There is no report '${req.params.id}'`), 404);
      }
      req.report = rep;
      next();
    };
    r.get('/reports', ...this.web, h('reports', (req, res) => this.sendReports(req, res)));
    r.get('/reports/new', this.session, this.csrf, admin, h('reports', (req, res) => this.sendReportEditor(req, res, null)));
    r.post('/reports', this.sameOrigin, this.session, reportForm, this.csrf, admin, h('reports', (req, res) => this.saveReport(req, res, null)));
    r.get('/reports/:id', report, ...this.web, h('report', (req, res) => this.sendReportDefinition(req, res)));
    r.get('/reports/:id/edit', report, this.session, this.csrf, admin, h('report', (req, res) => this.sendReportEditor(req, res, req.report)));
    r.post('/reports/:id', report, this.sameOrigin, this.session, reportForm, this.csrf, admin, h('report', (req, res) => this.saveReport(req, res, req.report)));
    r.post('/reports/:id/delete', report, this.sameOrigin, this.session, this.form, this.csrf, admin, h('report', (req, res) => {
      this.reports.delete(req.report.id);
      this.log.info(`IPS module: report '${req.report.id}' deleted`);
      res.redirect(req.baseUrl + '/reports');
    }));
  }

  /**
   * The rate limit on submitting (and on the SHL viewer, which fetches from other servers),
   * as middleware: one limiter, so submissions and the viewer count together.
   */
  submissionLimiters() {
    if (!this.postingLimiters) {
      const rl = this.config.rateLimit || {};
      const max = rl.max === undefined ? 60 : rl.max;
      this.postingLimiters = [];
      if (max > 0) {
        this.postingLimiters.push(rateLimit({
          windowMs: (rl.windowMinutes || 1) * 60 * 1000,
          limit: max,
          standardHeaders: 'draft-7',
          legacyHeaders: false,
          handler: (req, res) => wantsHtml(req)
            ? htmlServer.sendErrorResponse(res, TEMPLATE, new Error('Too many documents submitted; try again later'), 429)
            : this.sendOutcome(res, 429, 'throttled', 'Too many documents submitted; try again later')
        }));
      }
    }
    return this.postingLimiters;
  }

  setupViewerRoutes() {
    if (!this.viewer) {
      return;
    }
    const r = this.router;
    const h = (name, fn) => (req, res) => this.handle(req, res, name, () => fn(req, res));
    const limit = this.submissionLimiters();
    // a viewer page, from its token; 404 once it has expired
    const view = (req, res, next) => {
      const v = VIEW_TOKEN_RE.test(req.params.token) ? this.store.readView(req.params.token) : null;
      if (!v) {
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error('There is no such viewer page: it has expired (they are kept for ' +
          `${this.viewKeepMinutes} minutes), or never existed. Open the link again`), 404);
      }
      req.view = v;
      next();
    };
    // Like the submission form, these posts start no session and carry no CSRF token: the
    // viewer is open to anyone, and adding a document needs the project's token (in the form)
    r.get('/view', ...this.web, h('view', (req, res) => this.sendViewerStart(req, res)));
    r.post('/view', this.sameOrigin, ...limit, this.form, h('view', (req, res) => this.viewerOpen(req, res)));
    r.get('/view/:token', view, ...this.web, h('view', (req, res) => this.sendView(req, res)));
    r.post('/view/:token', view, this.sameOrigin, ...limit, this.form, h('view', (req, res) => this.viewerPasscode(req, res)));
    r.post('/view/:token/add', view, this.sameOrigin, ...limit, this.session, this.form, auth.csrfIfLoggedIn, h('view', (req, res) => this.viewerAdd(req, res)));
  }

  /**
   * The document creators: a chooser, and the editors, with or without a project (from a
   * project, they submit to it; without one, the user picks the project to submit to). The
   * editors' calls (JSON) build, check, load, share and submit documents; the browser
   * creates the downloads itself. The posts start no session and carry no CSRF token, like
   * the submission form: anyone can use the editors, and submitting needs the project's token.
   */
  setupComposeRoutes() {
    const r = this.router;
    const h = (name, fn) => (req, res) => this.handle(req, res, name, () => fn(req, res));
    const posting = this.submissionLimiters();
    const json = express.json({ limit: Math.max(2 * 1024 * 1024, Math.ceil(this.maxSize * 1.5)) });
    r.get('/assets/*file', assets.handler);
    r.get('/doc-actions.js', scripts.handler('doc-actions.js'));
    r.get('/compose', ...this.web, h('compose', (req, res) => this.sendComposeChoice(req, res)));
    r.get('/compose/general', ...this.web, h('compose', (req, res) => this.sendCompose(req, res)));
    r.get('/compose/patient', ...this.web, h('compose', (req, res) => this.sendPatientEditor(req, res)));
    r.get('/compose/lookup', ...this.lookups, h('lookup', (req, res) => this.lookup(req, res)));
    r.post('/compose/build', this.sameOrigin, ...this.lookups, json, h('compose', (req, res) => this.composeBuild(req, res)));
    r.post('/compose/check', this.sameOrigin, ...this.lookups, json, h('compose', (req, res) => this.composeCheck(req, res)));
    r.post('/compose/model', this.sameOrigin, ...this.lookups, json, h('compose', (req, res) => this.composeModel(req, res)));
    r.post('/compose/share', this.sameOrigin, ...posting, json, h('compose', (req, res) => this.composeShare(req, res)));
    // a project can take documents from logged in users: for them, a submission rides on the
    // session, so it carries the CSRF token too (anonymous ones have no session to ride on)
    r.post('/compose/submit', this.sameOrigin, ...posting, this.session, json, auth.csrfIfLoggedIn, h('compose', (req, res) => this.composeSubmit(req, res)));
  }

  setupProjectRoutes() {
    const r = this.router;
    const h = (name, fn) => (req, res) => this.handle(req, res, name, () => fn(req, res));
    const posting = this.submissionLimiters();

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
      auth.denyFraming(res);
      const user = this.currentUser(req);
      if (!user) {
        return res.redirect(auth.loginUrl(req));
      }
      if (!this.canManage(user, req.project)) {
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error('You do not manage this project'), 403);
      }
      req.user = user;
      next();
    };

    r.get('/editor.js', scripts.handler('editor.js'));
    r.get('/:code', project, ...this.web, h('list', (req, res) => this.htmlList(req, res)));
    r.get('/:code/metadata', project, h('metadata', (req, res) => this.metadata(req, res)));
    // The submission form has no CSRF token and starts no session: submitting is open to
    // anyone (or needs the project's token, which is in the form itself), so there is no
    // credential for a cross-site post to ride on, and a token for every visitor would give
    // every crawler a session. The Origin check still applies to the post.
    r.get('/:code/submit', project, ...this.web, h('submit', (req, res) => this.sendSubmit(req, res)));
    // the editor: the page, its script (served before the project routes catch the name),
    // the code lookups it makes, and what it posts
    r.get('/:code/compose', project, ...this.web, h('compose', (req, res) => {
      // the editor used to be here: links to edit a document go to the general editor
      if (typeof req.query.from === 'string') {
        return res.redirect(`${req.baseUrl}/${encodeURIComponent(req.project.code)}/compose/general?from=${encodeURIComponent(req.query.from)}`);
      }
      return this.sendComposeChoice(req, res);
    }));
    r.get('/:code/compose/general', project, ...this.web, h('compose', (req, res) => this.sendCompose(req, res)));
    r.get('/:code/compose/patient', project, ...this.web, h('compose', (req, res) => this.sendPatientEditor(req, res)));
    r.get('/:code/lookup', project, ...this.lookups, h('lookup', (req, res) => this.lookup(req, res)));
    r.post('/:code/compose', project, this.sameOrigin, ...posting, this.session, express.json({ limit: '2mb' }), auth.csrfIfLoggedIn, h('compose', (req, res) => this.compose(req, res)));
    r.post('/:code/submit', project, this.sameOrigin, ...posting, this.session, this.bigForm, auth.csrfIfLoggedIn, h('submit', (req, res) => this.submitForm(req, res)));
    r.get('/:code/settings', project, this.session, this.csrf, manager, h('settings', (req, res) => this.sendSettings(req, res)));
    // the reports (reports.js), for this project's documents
    r.get('/:code/reports', project, ...this.web, h('reports', (req, res) => this.sendProjectReports(req, res)));
    r.get('/:code/reports/:id', project, ...this.web, h('report', (req, res) => this.sendProjectReport(req, res)));
    r.get('/:code/reports/:id/csv', project, h('report', (req, res) => this.sendReportCsv(req, res)));
    r.post('/:code/settings', project, this.sameOrigin, this.session, this.form, this.csrf, manager, h('settings', (req, res) => this.saveSettings(req, res)));

    // the token before the body: a submission without it is refused before anything is read,
    // and the body is read no bigger than maxSize (the server's own parsers leave /ips alone)
    const submitter = async (req, res, next) => {
      // on the API, a user is the owner of an API token: never a session cookie
      const p = this.submitAccess(req.project).users ? await auth.principal(req) : null;
      const problem = this.submissionProblem(req, req.project, this.suppliedToken(req), p && p.via === 'token' ? p : null, 'api');
      if (problem) {
        if (problem.status === 401) {
          res.set('WWW-Authenticate', 'Bearer');
        }
        return this.sendOutcome(res, problem.status, problem.status === 401 ? 'login' : 'forbidden', problem.message);
      }
      next();
    };
    const documentBody = express.raw({ type: ['application/fhir+json', 'application/json'], limit: this.maxSize });
    r.post('/:code/Bundle', project, ...posting, submitter, documentBody, h('create', (req, res) => this.create(req, res)));
    // the project's patients (matched as documents arrive: patients.js), and IPS $summary
    r.get('/:code/Patient', project, ...this.web, h('patient', (req, res) => this.patientSearch(req, res)));
    r.get('/:code/Patient/\\$summary', project, h('summary', (req, res) => this.summary(req, res, null)));
    r.get('/:code/Patient/:pid/\\$summary', project, h('summary', (req, res) => this.summary(req, res, req.params.pid)));
    r.get('/:code/Patient/:pid', project, ...this.web, h('patient', (req, res) => this.patientRead(req, res)));
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
      this.reports.deleteDocument(id);
      this.log.info(`IPS module: document ${id} in '${req.project.code}' deleted by ${req.user.name}`);
      res.redirect(`${req.baseUrl}/${encodeURIComponent(req.project.code)}`);
    }));
    r.post('/:code/Bundle/:id/requeue', project, this.sameOrigin, this.session, this.form, this.csrf, manager, h('requeue', (req, res) => {
      const id = docId(req.params.id);
      const done = this.store.requeue(id, req.project.id);
      if (!done) {
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error(`No document with id '${req.params.id}'`), 404);
      }
      if (done === 'processing') {
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error(`Document ${id} is being processed now; it can be queued again when that is done`), 409);
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
      // the body parsers': too big, or not what it claims to be - said in the route's own terms
      if (err && (err.type === 'entity.too.large' || err.type === 'entity.parse.failed' || err.type === 'encoding.unsupported' || err.type === 'charset.unsupported')) {
        const status = err.type === 'entity.too.large' ? 413 : (err.status || 400);
        const message = err.type === 'entity.too.large' ? `The request is too big (the limit is ${err.limit} bytes)` : 'The body could not be read: ' + err.message;
        if (/\/Bundle$/.test(req.path)) {
          return this.sendOutcome(res, status, status === 413 ? 'too-costly' : 'structure', status === 413 ? `Documents can't be bigger than ${this.maxSize} bytes` : message);
        }
        if (!wantsHtml(req)) {
          return res.status(status).json({ error: message, problems: [message] });
        }
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error(message), status);
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
    // the national profiles' packages, as they are loaded into the validator: id#version -> Promise
    this.nationalPackages = new Map();
    const cfg = this.config.validator;
    if (!cfg || cfg.enabled === false) {
      this.log.warn('IPS module: no validator configured (modules.ips.validator) - documents will not be validated');
      return;
    }
    const FhirValidator = require('fhir-validator-wrapper');
    // a jar of its own (a validator built locally, say): used as it is, never downloaded or
    // updated; otherwise the released one in the data folder's bin directory, kept up to date
    const localJar = typeof cfg.jar === 'string' && cfg.jar.trim() ? (path.isAbsolute(cfg.jar) ? cfg.jar : folders.filePath(cfg.jar)) : null;
    const jar = localJar || folders.filePath('bin', 'validator_cli.jar');
    this.validator = new FhirValidator(jar, this.log);
    const settings = {
      autoDownload: !localJar,
      skipUpdateCheck: !!localJar,
      version: cfg.version || '4.0.1',
      txServer: cfg.txServer || 'http://tx.fhir.org/r4',
      txLog: cfg.txLog || folders.filePath('logs', 'ips-validator-tx.log'),
      port: cfg.port || 8082,
      igs: Array.isArray(cfg.packages) ? cfg.packages : ['hl7.fhir.uv.ips#1.1.0'],
      timeout: cfg.timeout || 120000,
      // lookupExtension(): an extension the validator doesn't have is looked for the way the
      // validator does while validating - the package that defines it is found from the url,
      // downloaded and loaded (validator 7.0.5 and later; fhir-validator-wrapper 1.7.0 and later)
      autoLoadPackages: cfg.autoLoadPackages !== false
    };
    this.log.info(`IPS module: starting the FHIR validator${localJar ? ` (${localJar})` : ''} on port ${settings.port} (tx ${settings.txServer}; ${settings.igs.join(', ')})`);
    this.validatorStarting = this.validator.start(settings).then(() => {
      this.log.info('IPS module: the FHIR validator is running');
      // documents wait for this too, so the analysis step - which looks up extensions before
      // the national step would load the packages - finds what the national IGs define
      return this.loadNationalPackages().then(() => this.loadReportsPackage());
    }).catch(e => {
      this.log.error('IPS module: the FHIR validator failed to start: ' + e.message);
      this.validatorError = e.message;
    }).finally(() => {
      this.validatorStarting = null;
    });
  }

  /**
   * Load the SQL on FHIR IG into the validator, so it can check the reports' ViewDefinitions
   * (modules.ips.reports.package; org.sql-on-fhir.ig#2.0.0 by default). A failure is logged,
   * and saving a report then fails at the validator.
   * @returns {Promise<void>}
   */
  async loadReportsPackage() {
    const spec = this.config.reports?.package || 'org.sql-on-fhir.ig#2.0.0';
    const [packageId, version] = spec.split('#');
    try {
      const outcome = await this.validator.loadIG(packageId, version || 'current');
      const bad = (Array.isArray(outcome?.issue) ? outcome.issue : []).filter(i => i && (i.severity === 'error' || i.severity === 'fatal'));
      if (bad.length > 0) {
        throw new Error(bad.map(i => i.details?.text || i.diagnostics || i.code).join('; '));
      }
      this.log.info(`IPS module: ${spec} loaded into the validator, for the reports' ViewDefinitions`);
    } catch (e) {
      this.log.warn(`IPS module: the validator could not load ${spec}, so report ViewDefinitions can't be checked: ${e.message}`);
    }
  }

  /**
   * Load every national profile's package into the validator (as the national step would), so
   * that what they define is there from the start. A package that won't load is logged (and
   * remembered) by loadNationalPackage(), and doesn't stop the others.
   * @returns {Promise<void>}
   */
  async loadNationalPackages() {
    if (!this.validator || !this.store) {
      return;
    }
    const list = this.store.nationalProfiles();
    if (list.length === 0) {
      return;
    }
    const started = Date.now();
    this.log.info(`IPS module: loading the packages of ${list.length} national profiles into the validator`);
    // one at a time: the validator loads one package per request anyway
    for (const np of list) {
      try {
        await this.loadNationalPackage(np.packageId, np.version);
      } catch (e) {
        // already logged
      }
    }
    this.log.info(`IPS module: national profile packages loaded in ${Math.round((Date.now() - started) / 1000)}s`);
  }

  /**
   * Load a national profile's package into the validator - once: a package that loaded, or
   * failed to (with why), is remembered until the national profiles are changed, so each
   * document doesn't ask again. The validator's packages (modules.ips.validator.packages) are
   * loaded when it starts; these are added to them.
   * @returns {Promise<void>} rejects with the reason the package could not be loaded
   */
  loadNationalPackage(packageId, version) {
    const key = `${packageId}#${version}`;
    let p = this.nationalPackages.get(key);
    if (!p) {
      p = this.validator.loadIG(packageId, version).then(outcome => {
        const bad = (Array.isArray(outcome?.issue) ? outcome.issue : []).filter(i => i && (i.severity === 'error' || i.severity === 'fatal'));
        if (bad.length > 0 || outcome?.resourceType !== 'OperationOutcome') {
          const why = bad.map(i => i.details?.text || i.diagnostics || i.code).filter(Boolean).join('; ') || 'the validator did not return an OperationOutcome';
          throw new Error(`The validator could not load ${key}: ${why}`);
        }
        this.log.info(`IPS module: national profile package ${key} loaded into the validator`);
        // the validator knows more now: extensions it couldn't find before may be there
        this.forgetMissingExtensions();
      });
      p.catch(e => this.log.warn(`IPS module: ${e.message}`));
      this.nationalPackages.set(key, p);
    }
    return p;
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
   * Forget the extensions the validator couldn't find: it has loaded a package since, and may
   * know them now. The ones it found are kept.
   */
  forgetMissingExtensions() {
    if (this.extensionCache) {
      for (const [url, answer] of this.extensionCache) {
        if (answer === null) {
          this.extensionCache.delete(url);
        }
      }
    }
  }

  /**
   * The definition of an extension, for the analysis step: {url, title, name, description},
   * or null when it can't be found. It is asked of the validator (the wrapper's
   * lookupCanonical(), the service's /canonical, which looks in the validator's context - and,
   * with modules.ips.validator.autoLoadPackages (on by default), finds and loads the package that
   * defines one it doesn't have).
   * Answers are remembered (a bounded cache); a validator that isn't there, or that fails, or
   * that predates /canonical, isn't an answer, and is asked again next time.
   * @param {string} url
   * @returns {Promise<Object|null>}
   */
  async lookupExtension(url) {
    const v = this.validator;
    if (!v || typeof v.lookupCanonical !== 'function' || typeof v.isRunning !== 'function' || !v.isRunning()) {
      return null;
    }
    const cache = this.extensionCache || (this.extensionCache = new Map());
    if (cache.has(url)) {
      return cache.get(url);
    }
    let answer = null;
    try {
      const r = await v.lookupCanonical(url);
      if (r) {
        const str = (x) => (typeof x === 'string' ? x : '');
        answer = { url: str(r.url), title: str(r.title), name: str(r.name), description: str(r.description).substring(0, 1000) };
      }
    } catch (e) {
      this.log.warn(`IPS module: looking up extension ${url} failed: ${e.message}`);
      return null;
    }
    if (cache.size >= MAX_CACHED_EXTENSIONS) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(url, answer);
    return answer;
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
    // a check in progress is shared - even inside the recheck interval
    if (this.txChecking) {
      return this.txChecking;
    }
    if (this.txChecked === true || (this.txCheckedAt && Date.now() - this.txCheckedAt < TX_RECHECK_MS)) {
      return;
    }
    this.txChecking = (async () => {
      this.txCheckedAt = Date.now();
      // anything but a CapabilityStatement is "not there yet": a 404 while the tx module
      // hasn't mounted its endpoints, or a 5xx or no answer while it loads
      let why = null;
      try {
        const r = await this.tx.get('/metadata');
        if (r.status !== 200 || r.resource?.resourceType !== 'CapabilityStatement') {
          why = r.status === 404 ? 'nothing answers' : `it answered ${r.status} to /metadata`;
        }
      } catch (e) {
        why = `it could not be reached (${e.message})`;
      }
      try {
        if (why) {
          if (!this.txMissingWarned) {
            this.txMissingWarned = true;
            this.log.warn(`IPS module: the terminology server ${this.tx.url} on this server is not there (yet): ${why} - ` +
              'is the tx module enabled, and is modules.ips.txServer one of its endpoint paths (modules.tx.endpoints[].path)? ' +
              'Looking again until it is');
          }
          this.txMissing = true;
          if (!this.txMissingLogged && Date.now() - this.startedAt >= TX_STARTUP_GRACE_MS) {
            this.txMissingLogged = true;
            this.log.error(`IPS module: still no terminology server at ${this.tx.url} on this server (${why}); documents are processed without it`);
          }
          return;
        }
        if (this.txMissingWarned) {
          this.log.info(`IPS module: the terminology server ${this.tx.url} is there now`);
        }
        this.txMissing = false;
        this.txChecked = true;
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
    // claimed before anything is awaited, so two timer ticks can never both get past here
    this.processing = true;
    let n = 0;
    try {
      await this.checkTxServer();
      for (;;) {
        if (!this.pipelineReady()) {
          break;
        }
        const row = this.store.claimNext();
        if (!row) {
          break;
        }
        n++;
        const project = this.store.projectById(row.project_id);
        // for the queue page: which document, and (processDocument) which step
        this.current = { id: row.id, started: Date.now(), step: null, stepStarted: null };
        try {
          const note = await this.processDocument(row, project);
          this.store.finish(row.id, true, note || null);
        } catch (e) {
          this.log.error(`IPS module: processing document ${row.id} failed: ${e.stack || e.message}`);
          this.store.finish(row.id, false, e.message);
          if (this.stats) {
            this.stats.taskError('IPS processing', `document ${row.id}: ${e.message}`);
          }
        } finally {
          this.current = null;
        }
      }
      if (n > 0 && this.stats) {
        this.stats.taskDone('IPS processing', `${n} processed`);
      }
      // then report tables waiting to be built (or rebuilt): a little at a time, after the
      // documents, so a document that arrives meanwhile doesn't wait long
      if (this.reports && this.reports.building()) {
        try {
          await this.reports.buildStep(this.config.reports?.buildBudgetMs || 2000);
        } catch (e) {
          this.log.error(`IPS module: building report tables failed: ${e.stack || e.message}`);
        }
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
        if (this.current && this.current.id === row.id) {
          this.current.step = step.name;
          this.current.stepStarted = Date.now();
        }
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
        // for the averages on the queue page: not a step that was skipped (it did no work)
        try {
          if (!this.store.readResult(row.id, step.name)?.result?.skipped) {
            this.store.recordStepTime(step.name, row.id, Date.now() - started, row.size);
          }
        } catch (e) {
          this.log.error(`IPS module: the time of ${step.name} could not be recorded: ${e.message}`);
        }
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
   * The paragraph for the server's daily report: pages served (and how many were about documents - a
   * document's page, in any of its views), new documents and how many are stored, and the
   * processing pipeline - how many times it was started, and how many of those didn't finish
   * (it failed, or the server stopped while it ran).
   */
  dailyReport({since, now}) {
    const {plural} = require('../library/daily-report');
    const was = (n) => n === 1 ? 'was' : 'were';
    const sentences = [];
    if (this.stats) {
      const counts = this.stats.countsSince(since, now);
      const docs = counts.operations.read || 0;
      sentences.push(`${plural(counts.total, 'page')} ${was(counts.total)} served${counts.total ? `, ${docs} of them about documents` : ''}.`);
    }
    if (this.store) {
      const received = this.store.countReceived(since, now);
      const stored = this.store.count();
      sentences.push(`${plural(received, 'new document')} ${was(received)} received; ${plural(stored, 'document')} ${stored === 1 ? 'is' : 'are'} stored.`);
      const runs = this.store.countRuns(since, now);
      const unfinished = runs.failed + runs.interrupted;
      const why = [runs.failed ? `${runs.failed} failed` : '', runs.interrupted ? `${runs.interrupted} interrupted by a shutdown` : ''].filter(Boolean).join(', ');
      sentences.push(`The processing pipeline was started ${plural(runs.started, 'time')}; ${unfinished} didn't finish${why ? ` (${why})` : ''}` +
        `${runs.running ? `, and ${runs.running} ${runs.running === 1 ? 'is' : 'are'} still running` : ''}.`);
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
    if (this.reports) {
      this.reports.close();
      this.reports = null;
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
      // the page, for logging in and out and coming back to it
      here: auth.safeReturn(req.method === 'GET' ? req.originalUrl : req.baseUrl, req.baseUrl),
      user,
      csrf: res.locals._csrf,
      canManage: req.project ? this.canManage(user, req.project) : false,
      canShare: !!this.shl,
      codeSystemLink: this.tx ? (system) => this.tx.codeSystemLink(system) : null
    };
  }

  // ---- the SHL viewer ----

  /** The viewer's address on this server, as SHLs name it (the shlink goes after the #). */
  viewerUrl(req) {
    return `${req.protocol}://${req.get('host')}${req.baseUrl}/view#`;
  }

  /** Who the viewer says it is, to the SHL server. */
  viewerRecipient(req) {
    const r = this.config.viewer?.recipient;
    return typeof r === 'string' && r ? r : `FHIRsmith IPS viewer (${req.get('host')})`;
  }

  /** The viewer's first page: it reads the link from the address (after #), or takes it pasted in. */
  sendViewerStart(req, res, message = null, status = 200) {
    res.status(status);
    this.sendHtml(res, 'SHL viewer', render.renderViewerStart({ ...this.ctx(req, res), keepMinutes: this.viewKeepMinutes, viewerUrl: this.viewerUrl(req) }, message), Date.now());
  }

  /** Keep what the viewer did. */
  saveView(token, link, result, added = []) {
    this.store.saveView(token, link, {
      state: result.state,
      message: result.message || null,
      payload: result.payload || null,
      vhl: result.vhl || null,
      documents: result.documents || [],
      trace: { started: result.trace.started, entries: result.trace.entries },
      added
    }, this.viewKeepMinutes * 60 * 1000);
  }

  /** One line in the server's log for each link opened (the page has the details). */
  logView(token, result) {
    const docs = (result.documents || []).length;
    this.log.info(`IPS module: SHL viewer ${token}: ${result.state} - ${result.payload?.url || '(no url)'}` +
      `${result.message ? `: ${result.message}` : ''} (${docs} document${docs === 1 ? '' : 's'}, ${result.trace.entries.length} steps)`);
  }

  /** Open a link: retrieve the document, keep what happened, and show it on its own page. */
  async viewerOpen(req, res) {
    const link = typeof req.body.link === 'string' ? req.body.link.trim() : '';
    if (!link) {
      return this.sendViewerStart(req, res, 'Give the link to open', 400);
    }
    if (link.length > MAX_LINK_LENGTH) {
      return this.sendViewerStart(req, res, `The link is too long (${link.length} characters; the limit is ${MAX_LINK_LENGTH})`, 400);
    }
    const passcode = typeof req.body.passcode === 'string' && req.body.passcode ? req.body.passcode : undefined;
    const result = await this.viewer.open(link, { passcode, recipient: this.viewerRecipient(req) });
    const token = crypto.randomBytes(18).toString('base64url');
    this.saveView(token, link, result);
    this.logView(token, result);
    res.redirect(303, `${req.baseUrl}/view/${token}`);
  }

  /** Try a link that needs a passcode again, with one. */
  async viewerPasscode(req, res) {
    const v = req.view;
    const passcode = typeof req.body.passcode === 'string' ? req.body.passcode : '';
    if (v.result.state !== 'needs-passcode') {
      return res.redirect(303, `${req.baseUrl}/view/${v.token}`);
    }
    if (!passcode) {
      return this.sendView(req, res, 'Give the passcode', 400);
    }
    // the log goes on from where it was
    const trace = new Trace(v.result.trace.entries, v.result.trace.started);
    trace.info('Trying again, with the passcode the user gave');
    const result = await this.viewer.open(v.link, { passcode, recipient: this.viewerRecipient(req), trace });
    this.saveView(v.token, v.link, result, v.result.added || []);
    this.logView(v.token, result);
    res.redirect(303, `${req.baseUrl}/view/${v.token}`);
  }

  /** What the viewer retrieved: the documents' narratives, adding them to a project, and the log. */
  sendView(req, res, message = null, status = 200) {
    const v = req.view;
    const projects = this.store.projects().map(p => {
      const full = this.store.projectByCode(p.code);
      return { code: p.code, name: p.name, ...this.submitOffer(full, auth.currentUser(req)), ai: full ? this.store.projectAi(full).enabled === true : false };
    });
    // the same document already here: the same Bundle.identifier
    const duplicates = (v.result.documents || []).map(d => {
      const id = d.bundle?.identifier;
      return id && typeof id.value === 'string' ? this.store.findByIdentifier(id.system, id.value) : null;
    });
    res.status(status);
    this.sendHtml(res, 'SHL viewer', render.renderView(v, { ...this.ctx(req, res), projects, duplicates, keepMinutes: this.viewKeepMinutes }, message), Date.now());
  }

  /** Add a document the viewer retrieved to a project: the rules of the submission form. */
  viewerAdd(req, res) {
    const v = req.view;
    const index = parseInt(req.body.doc, 10);
    const doc = Number.isInteger(index) ? (v.result.documents || [])[index] : null;
    if (!doc || !doc.ips) {
      return this.sendView(req, res, 'Only an IPS document can be added to a project', 400);
    }
    const code = typeof req.body.project === 'string' ? req.body.project : '';
    const project = CODE_RE.test(code) && !RESERVED.has(code) ? this.store.projectByCode(code) : null;
    if (!project) {
      return this.sendView(req, res, 'Choose a project to add the document to', 400);
    }
    const supplied = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    const problem = this.submissionProblem(req, project, supplied, auth.currentUser(req), 'web');
    if (problem) {
      return this.sendView(req, res, `${project.name}: ${problem.message}`, problem.status);
    }
    const bundle = structuredClone(doc.bundle);
    if (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > this.maxSize) {
      return this.sendView(req, res, `Documents can't be bigger than ${this.maxSize} bytes`, 413);
    }
    const problems = validateDocument(bundle);
    if (problems.length > 0) {
      return this.sendView(req, res, `The document can't be added: ${problems.join('. ')}`, 400);
    }
    req.project = project;
    const { id } = this.receive(req, bundle, 'shl');
    const added = [...(v.result.added || []), { doc: index, project: project.code, name: project.name, id }];
    this.store.saveView(v.token, v.link, { ...v.result, added }, this.viewKeepMinutes * 60 * 1000);
    this.log.info(`IPS module: SHL viewer ${v.token}: document ${index + 1} added to '${project.code}' as document ${id}`);
    res.redirect(303, `${req.baseUrl}/${encodeURIComponent(project.code)}/Bundle/${id}`);
  }

  // ---- the processing queue ----

  /**
   * Whether the queue is being worked through, and if not, why not - for the queue page.
   * @returns {{state: string, text: string}} state is running, idle, waiting or off
   */
  queueState() {
    const cfg = this.config.processing || {};
    if (this.processing) {
      return { state: 'running', text: 'Processing is running' };
    }
    if (cfg.enabled === false) {
      return { state: 'off', text: 'Processing is turned off on this server (modules.ips.processing.enabled): documents stay in the queue' };
    }
    if (this.validatorStarting) {
      return { state: 'waiting', text: 'Processing is waiting for the validator to start' };
    }
    if (this.txMissing && Date.now() - this.startedAt < TX_STARTUP_GRACE_MS) {
      return { state: 'waiting', text: 'Processing is waiting for the terminology server to answer' };
    }
    const seconds = typeof cfg.intervalSeconds === 'number' && cfg.intervalSeconds > 0 ? cfg.intervalSeconds : DEFAULT_INTERVAL_SECONDS;
    return { state: 'idle', text: `Processing is idle: the queue is looked at every ${seconds} second${seconds === 1 ? '' : 's'}` };
  }

  /**
   * The processing queue: the document being processed, and the step it is up to, then the
   * documents waiting, in the order they will be processed. JSON for a client that is not
   * a browser.
   */
  sendQueue(req, res) {
    const start = Date.now();
    const q = this.store.queue();
    const steps = this.steps.map(st => st.name);
    const current = this.current;
    for (const row of q.processing) {
      row.results = {};
      for (const step of steps) {
        row.results[step] = this.store.readResult(row.id, step);
      }
      // the step it is up to: the one running, as the results say (else as this process knows)
      row.step = steps.find(st => row.results[st]?.result?.status === 'running') || (current && current.id === row.id ? current.step : null);
      if (current && current.id === row.id) {
        row.startedMs = current.started;
        row.stepStartedMs = current.step === row.step ? current.stepStarted : null;
      }
    }
    const state = this.queueState();
    const timings = this.store.stepTimings();
    if (!wantsHtml(req)) {
      const doc = (r) => ({ id: r.id, project: r.project_code, received: r.received, patient: r.patient_name || null, title: r.comp_title || null, size: r.size });
      return res.json({
        state: state.state,
        processing: q.processing.map(r => ({ ...doc(r), step: r.step || null, ...(r.startedMs ? { started: new Date(r.startedMs).toISOString() } : {}) })),
        waiting: q.waiting.map(doc),
        waitingTotal: q.waitingTotal,
        steps: steps.map(st => ({ step: st, ...(timings[st] ? { runs: timings[st].runs, averageMs: Math.round(timings[st].avgMs), msPerKb: timings[st].msPerKb === null ? null : Number(timings[st].msPerKb.toFixed(3)) } : { runs: 0 }) }))
      });
    }
    this.sendHtml(res, 'IPS processing queue', render.renderQueue(q, state, { ...this.ctx(req, res), steps, timings, now: Date.now() }), start);
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
    // the original (as submitted), or the modified copy - what the processing ended up with
    const source = req.body.source === 'modified' ? 'modified' : 'original';
    const doc = source === 'modified' ? row.analysed : row.bundle;
    if (!doc) {
      return fail(409, `Document ${id} has not been processed yet, so there is no modified copy to share`);
    }
    const label = row.patient_name ? `Patient Health Document for ${row.patient_name}` : 'Patient Health Document';
    let out;
    try {
      // the QR opens this server's viewer, unless the configuration names another
      out = await this.shl.share(doc, { kind, host: req.get('host'), label, viewer: this.viewer ? this.viewerUrl(req) : undefined });
      out.source = source;
    } catch (e) {
      this.log.error(`IPS module: document ${id} could not be shared as ${kind}: ${e.message}`);
      return fail(502, e.message);
    }
    this.log.info(`IPS module: document ${id} in '${req.project.code}' shared (${source}) as ${kind.toUpperCase()} (${out.bytes} bytes, until ${out.expires})`);
    if (json) {
      return res.json(out);
    }
    this.sendHtml(res, `${req.project.name}: Document ${id} - ${kind.toUpperCase()}`,
      render.renderShare(req.project, row, out, this.ctx(req, res)), Date.now(), req);
  }

  // ---- users ----

  /**
   * Who is logged in (library/auth), with the projects they manage as they are now (not as
   * they were at login, so taking a project away, or disabling the user, takes effect at once).
   * projects: the ids; allProjects: a manager of every project
   */
  currentUser(req) {
    const p = auth.currentUser(req);
    if (!p) {
      return null;
    }
    const scopes = p.scopes('ips', 'manager');
    return {
      id: p.id, name: p.name, login: p.login, isAdmin: p.isAdmin,
      allProjects: scopes.includes(''),
      projects: scopes.filter(x => /^\d+$/.test(x)).map(x => parseInt(x, 10))
    };
  }

  canManage(user, project) {
    return !!user && (user.isAdmin || user.allProjects || user.projects.includes(project.id));
  }

  /** The projects (store.projects()), each with its managers from the server's users */
  projectsWithManagers() {
    const users = new Map(auth.users().map(u => [u.id, u]));
    const byScope = new Map();
    for (const h of auth.allHolders('ips', 'manager')) {
      const u = users.get(h.user_id);
      if (u) {
        if (!byScope.has(h.scope)) {
          byScope.set(h.scope, []);
        }
        byScope.get(h.scope).push({ id: u.id, login: u.login, name: u.name || u.login });
      }
    }
    return this.store.projects().map(p => ({ ...p, managers: byScope.get(String(p.id)) || [] }));
  }

  // ---- administration: projects and users ----

  sendProjects(req, res, message, status = 200) {
    res.status(status);
    this.sendHtml(res, 'IPS Projects', render.renderProjects(this.projectsWithManagers(), this.managerCandidates(), this.ctx(req, res), message), Date.now());
  }

  /** The users the projects page offers as managers: enabled, with the IPS Project Admin role */
  managerCandidates() {
    const ids = new Set(auth.allHolders('ips', PROJECT_ADMIN).map(h => h.user_id));
    return auth.users().filter(u => u.enabled && ids.has(u.id));
  }

  saveProject(req, res, id) {
    const code = typeof req.body.code === 'string' ? req.body.code.trim().toLowerCase() : '';
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
    // an IPS Project Admin, or someone who manages the project already (kept, though they no
    // longer have the role, until they are taken off)
    const allowed = new Set(this.managerCandidates().map(u => u.id));
    if (id !== null) {
      for (const uid of auth.holders('ips', 'manager', String(parseInt(id, 10)))) {
        allowed.add(uid);
      }
    }
    const managers = [].concat(req.body.manager || []).filter(m => /^\d{1,9}$/.test(m)).map(m => parseInt(m, 10)).filter(m => allowed.has(m));
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
    auth.setHolders('ips', 'manager', String(projectId), managers, req.user.login);
    res.redirect(req.baseUrl + '/admin/projects');
  }

  // ---- a project's settings ----

  projectWithManagers(project) {
    return { ...project, managers: (this.projectsWithManagers().find(p => p.id === project.id) || {}).managers || [] };
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
        serverNarrative: this.config.ai?.sendNarrative === true, usage,
        // the users approved to submit (the ips submitter role, for this project or every project)
        approved: [...new Set([...auth.holders('ips', SUBMITTER, String(req.project.id)), ...auth.holders('ips', SUBMITTER, '')])]
          .map(id => auth.user(id)).filter(u => u && u.enabled)
      }), Date.now(), req);
  }

  saveSettings(req, res) {
    if (req.body.form === 'ai') {
      return this.saveAiSettings(req, res);
    }
    if (req.body.form === 'users') {
      const mode = req.body.users === 'any' || req.body.users === 'approved' ? req.body.users : '';
      this.store.setProjectSubmitUsers(req.project.id, mode);
      this.log.info(`IPS module: users who may submit to '${req.project.code}' set to ${mode || 'none'} by ${req.user.name}`);
      req.project = this.store.projectById(req.project.id);
      return this.sendSettings(req, res, mode === 'any' ? 'Any logged in user can now submit documents'
        : mode === 'approved' ? 'Users approved by the administrator can now submit documents' : 'Users can no longer submit documents as themselves');
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
    this.sendSettings(req, res, token ? 'The token has been set'
      : this.submitAccess(req.project).users ? 'The token has been cleared; only users can submit' : 'The token has been cleared; anyone can submit');
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
    if (!Object.prototype.hasOwnProperty.call(aiClient.PROVIDERS, settings.provider)) {
      settings.provider = 'openai';
    }
    // a key is for the service it was given for: pointing the account somewhere else (another
    // provider, another base URL) needs the key again, so a stored key can't be sent to a host
    // its owner didn't choose
    const sameService = settings.provider === (current.provider || 'openai') && settings.baseUrl.replace(/\/+$/, '') === String(current.baseUrl || '').replace(/\/+$/, '');
    let keyDropped = false;
    if (settings.keyEnc && !sameService) {
      settings.keyEnc = null;
      keyDropped = true;
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
    this.sendSettings(req, res, keyDropped && !apiKey
      ? 'The AI assessment settings have been saved. The stored API key was removed because the provider or base URL changed - enter it again for the new service'
      : 'The AI assessment settings have been saved');
  }

  // ---- receiving documents ----

  /**
   * Store a document, once it has passed validation and the token check.
   * @returns {{id: number, bundle: Object}}
   */
  receive(req, bundle, source) {
    const now = Date.now();
    const id = this.store.insert(req.project.id, bundle, { ip: req.ip, source, receivedMs: now });
    // the user it came from, when a user was what let it in (submissionProblem)
    const who = req.submitter ? `${req.submitter.name} (${req.submitter.login})` : null;
    if (who) {
      this.store.setSubmittedBy(id, who);
    }
    this.log.info(`IPS module: document ${id} received in '${req.project.code}' (${source}, ${bundle.entry.length} entries${who ? `, from ${who}` : ''})`);
    return { id, bundle };
  }

  /**
   * Who may submit to a project. token: the project has a submission token; users: '' (no
   * users), 'any' (any logged in user), 'approved' (users with the ips submitter role for the
   * project - or who manage it). A project with neither is open to anyone. With both, either
   * will do
   */
  submitAccess(p) {
    const users = p && (p.submit_users === 'any' || p.submit_users === 'approved') ? p.submit_users : '';
    const token = !!p && tokenConfigured(p.token);
    return { token, users, open: !token && !users };
  }

  /** May this user (a Principal, or null) submit to the project as a user? */
  userMaySubmit(p, who) {
    const a = this.submitAccess(p);
    if (!who || !who.id || !a.users) {
      return false;
    }
    return a.users === 'any' || who.has('ips', SUBMITTER, String(p.id)) || who.has('ips', 'manager', String(p.id));
  }

  /**
   * Check a submission against the project's rules: the token it carries (supplied), or the user
   * (who: from the session on the pages, from an API token on the API). Sets req.submitter to
   * the user when a user was what let it in.
   * @param {'api'|'web'} channel - for the wording
   * @returns {null|{status: number, message: string}} null when it may go ahead
   */
  submissionProblem(req, p, supplied, who, channel) {
    const a = this.submitAccess(p);
    req.submitter = null;
    if (a.open) {
      return null;
    }
    if (a.token && supplied && tokenMatches(p.token, supplied)) {
      return null;
    }
    if (a.users && who && who.id) {
      if (this.userMaySubmit(p, who)) {
        req.submitter = who;
        return null;
      }
      if (!a.token || !supplied) {
        return { status: 403, message: 'You have not been approved to submit documents to this project: the server\'s administrator approves users' };
      }
    }
    return { status: 401, message: this.submitNeeds(p, channel) };
  }

  /** What a submission to the project needs, as a message */
  submitNeeds(p, channel) {
    const a = this.submitAccess(p);
    const users = a.users === 'approved' ? 'a logged in user who has been approved' : 'a logged in user';
    if (channel === 'api') {
      if (!a.users) {
        return 'This project requires its submission token in the Authorization header';
      }
      return `This project requires ${a.token ? 'its submission token, or ' : ''}${users}: send ${a.token ? 'the token, or ' : ''}the user's API token (made on their account page) as Authorization: Bearer`;
    }
    if (!a.users) {
      return 'The submission token is missing or wrong';
    }
    return `This project takes documents from ${users}${a.token ? ', or with its submission token' : ''}: log in${a.token ? ', or give the token' : ''}`;
  }

  /**
   * How a page offers submitting to a project, for the user looking at it: needsToken (show the
   * token field), login (the user should log in to submit), blocked (why they can't, if they
   * can't), asUser (they will submit as themselves), label (a few words for a list)
   */
  submitOffer(p, user) {
    const a = this.submitAccess(p);
    const asUser = this.userMaySubmit(p, user);
    const out = { needsToken: a.token && !asUser, login: !!a.users && !user, asUser, blocked: null, label: '' };
    if (a.users && !a.token && !asUser) {
      out.blocked = user ? 'You have not been approved to submit documents to this project' : 'Log in to submit documents to this project';
    }
    out.label = a.open || asUser ? '' : a.users && a.token ? '(log in, or a token)' : a.users ? '(log in)' : '(needs a token)';
    return out;
  }

  /** The token from the Authorization header, without any "Bearer " prefix. */
  suppliedToken(req) {
    const v = req.get('Authorization');
    return typeof v === 'string' ? v.replace(/^Bearer\s+/i, '').trim() : v;
  }

  async create(req, res) {
    // who may submit was checked before the body was read (the submitter middleware)
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
      render.renderSubmit(req.project, this.ctx(req, res), { ...this.submitOffer(req.project, auth.currentUser(req)), loginUrl: auth.loginUrl(req, `${req.baseUrl}/${req.project.code}/submit`),
        aiEnabled: this.store.projectAi(req.project).enabled === true, ...options }), Date.now(), req);
  }

  // ---- reports ----

  sendReports(req, res) {
    this.sendHtml(res, 'Reports', render.renderReports(this.reports.list(), this.ctx(req, res), REPORT_SOURCES), Date.now(), req);
  }

  /** A report's definition: the page, or (download) the definition as JSON. */
  sendReportDefinition(req, res) {
    const r = req.report;
    if (req.query.download !== undefined) {
      res.setHeader('Content-Disposition', `attachment; filename="report-${r.id}.json"`);
      res.type('application/json');
      return res.send(JSON.stringify({ title: r.title, description: r.description, source: r.source, view: r.view, statements: r.statements }, null, 2));
    }
    this.sendHtml(res, `Report: ${r.title}`, render.renderReportDefinition(r, this.ctx(req, res), REPORT_SOURCES), Date.now(), req);
  }

  sendReportEditor(req, res, report, form = null, issues = null, status = 200) {
    res.status(status);
    this.sendHtml(res, report ? `Edit Report: ${report.title}` : 'New Report',
      render.renderReportEditor(report, form, issues, this.ctx(req, res), REPORT_SOURCES), Date.now(), req);
  }

  /**
   * Save a report from the administrator's form: checked (reports.check - the validator last),
   * then saved; a new or changed view means its table is rebuilt in the background.
   */
  async saveReport(req, res, existing) {
    const b = req.body || {};
    const str = (v) => (typeof v === 'string' ? v : '');
    const list = (v) => (Array.isArray(v) ? v : (v === undefined ? [] : [v])).map(str);
    const names = list(b.stmt_name);
    const sqls = list(b.stmt_sql);
    const statements = [];
    for (let i = 0; i < Math.max(names.length, sqls.length); i++) {
      const name = (names[i] || '').trim();
      const sql = (sqls[i] || '').trim();
      if (name || sql) {
        statements.push({ name, sql });
      }
    }
    const form = { title: str(b.title), description: str(b.description), source: str(b.source), view: str(b.view), statements };
    let view = null;
    let issues = [];
    try {
      view = JSON.parse(form.view);
    } catch (e) {
      issues.push(`The ViewDefinition is not valid JSON: ${e.message}`);
    }
    if (view) {
      issues = await this.reports.check({ ...form, view }, existing, this.validator);
    }
    if (issues.length > 0) {
      return this.sendReportEditor(req, res, existing, form, issues, 400);
    }
    const rebuild = this.reports.save({ ...form, view }, existing);
    this.log.info(`IPS module: report '${view.name}' ${existing ? 'saved' : 'added'}${rebuild ? '; its table will be built' : ''}`);
    res.redirect(`${req.baseUrl}/reports/${encodeURIComponent(view.name)}`);
  }

  sendProjectReports(req, res) {
    this.sendHtml(res, `${req.project.name}: Reports`,
      render.renderProjectReports(req.project, this.reports.list(), this.ctx(req, res), REPORT_SOURCES), Date.now(), req);
  }

  /** A report for the project: its statements' output, then the table's first rows. */
  async sendProjectReport(req, res) {
    const report = this.reports.get(req.params.id);
    if (!report) {
      return htmlServer.sendErrorResponse(res, TEMPLATE, new Error(`There is no report '${req.params.id}'`), 404);
    }
    let out = null;
    let problem = null;
    try {
      out = await this.reports.query(report, req.project.id);
    } catch (e) {
      problem = e.message;
    }
    this.sendHtml(res, `${req.project.name}: ${report.title}`,
      render.renderProjectReport(req.project, report, out, problem, this.reports.errors(report, req.project.id),
        { ...this.ctx(req, res), codeSystemLink: this.tx ? (system) => this.tx.codeSystemLink(system) : null }, this.reports.maxRows),
      Date.now(), req);
  }

  /** The project's rows of a report's table, as CSV. */
  async sendReportCsv(req, res) {
    const report = this.reports.get(req.params.id);
    if (!report) {
      return htmlServer.sendErrorResponse(res, TEMPLATE, new Error(`There is no report '${req.params.id}'`), 404);
    }
    let csv;
    try {
      csv = await this.reports.csv(report, req.project.id);
    } catch (e) {
      return htmlServer.sendErrorResponse(res, TEMPLATE, e, 409);
    }
    res.setHeader('Content-Disposition', `attachment; filename="${req.project.code}-${report.id}.csv"`);
    res.type('text/csv');
    res.send(csv);
  }

  // ---- national profiles ----

  /** The national profiles: a page (with the administrator's forms), or JSON. */
  sendNationalProfiles(req, res, message, status = 200) {
    const list = this.store.nationalProfiles();
    res.status(status);
    if (!wantsHtml(req) && !message) {
      return res.json(list.map(np => ({ jurisdiction: np.jurisdiction, packageId: np.packageId, version: np.version, url: np.url,
        ...(np.snomedEdition ? { snomedEdition: np.snomedEdition } : {}) })));
    }
    this.sendHtml(res, 'National Profiles', render.renderNationalProfiles(list, this.ctx(req, res), message), Date.now(), req);
  }

  /** Add (id null) or change a national profile, from the form: jurisdiction, packageId, version, url, snomedEdition (optional). */
  saveNationalProfile(req, res, id) {
    const field = (name) => (typeof req.body[name] === 'string' ? req.body[name].trim() : '');
    const packageId = field('packageId');
    const version = field('version');
    const url = field('url');
    // a country code is upper case; a region's is digits
    const jurisdiction = field('jurisdiction').toUpperCase();
    // the edition's module id; empty for none
    const snomedEdition = field('snomedEdition') || null;
    const problem = nationalProfileProblem(jurisdiction, packageId, version, url, snomedEdition);
    if (problem) {
      return this.sendNationalProfiles(req, res, problem, 400);
    }
    const existing = this.store.nationalProfileByPackage(packageId, version);
    if (id === null) {
      if (existing) {
        return this.sendNationalProfiles(req, res, `There is already a national profile for ${packageId}#${version}`, 409);
      }
      this.store.createNationalProfile(packageId, version, url, jurisdiction, snomedEdition);
      this.log.info(`IPS module: national profile ${packageId}#${version} (${jurisdiction}${snomedEdition ? `, SNOMED CT ${snomedEdition}` : ''}) added (${url})`);
    } else {
      const n = /^\d{1,15}$/.test(id) ? parseInt(id, 10) : -1;
      if (existing && existing.id !== n) {
        return this.sendNationalProfiles(req, res, `There is already a national profile for ${packageId}#${version}`, 409);
      }
      if (!this.store.updateNationalProfile(n, packageId, version, url, jurisdiction, snomedEdition)) {
        return this.sendNationalProfiles(req, res, 'That national profile no longer exists', 404);
      }
      this.log.info(`IPS module: national profile ${packageId}#${version} (${jurisdiction}${snomedEdition ? `, SNOMED CT ${snomedEdition}` : ''}) saved (${url})`);
    }
    // a package that failed to load is tried again; the packages are loaded now (in the
    // background), so the analysis step finds what they define
    this.nationalPackages = new Map();
    if (this.validator && this.validator.isRunning()) {
      this.loadNationalPackages().catch(e => this.log.warn(`IPS module: loading the national profile packages failed: ${e.message}`));
    }
    res.redirect(req.baseUrl + '/national-profiles');
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
    const ctx = { ...this.ctx(req, res), valueSetTitle: (url) => this.valueSetTitle(url), profileTitle: (url) => this.profileTitle(url) };
    // the administrator edits the rows in place, a row at a time
    const editor = ctx.user?.isAdmin ? {
      constraints: this.editorConstraints(sd),
      sections: profiles.IPS_SECTIONS, systems: profiles.SYSTEMS, resourceTypes: profiles.RESOURCE_TYPES, sectionSystem: editorSchema.LOINC, canLookup: !!this.tx
    } : null;
    this.sendHtml(res, `Clinical Profile: ${sd.title}`, render.renderProfile(sd, ctx, editor), Date.now(), req);
  }

  /**
   * What to call a profile a rule says resources conform to: one of the clinical profiles (by
   * its title), or one of the national profiles (by its jurisdiction and package), or null.
   */
  profileTitle(url) {
    if (typeof url !== 'string') {
      return null;
    }
    const plain = url.split('|')[0];
    const m = /\/StructureDefinition\/profile-([a-f0-9]{12})$/.exec(plain);
    const sd = m ? this.store.profile(m[1]) : null;
    if (sd && sd.url === plain) {
      return sd.title;
    }
    const np = this.store.nationalProfiles().find(p => p.url === plain);
    return np ? `${np.jurisdiction ? `${np.jurisdiction} ` : ''}national profile (${np.packageId}#${np.version})` : null;
  }

  /** The title of one of this module's own value sets, or null. */
  valueSetTitle(url) {
    const vs = this.valueSets && typeof url === 'string' ? this.valueSets.valueSet(url.split('|')[0]) : null;
    return vs ? (vs.title || vs.name || null) : null;
  }

  /** The editor, for a new profile or an existing one. */
  editorConstraints(sd) {
    return profiles.constraintsOf(sd).map(c => ({ ...c, shape: profiles.parseShape(c.expression), rshape: profiles.parseResourceShape(c.expression) }));
  }

  profileEditor(req, res, sd) {
    const constraints = this.editorConstraints(sd);
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

  /**
   * Add a constraint to a profile ({human, expression}), or replace one (by its key, which it
   * keeps). 201/200 with {key}, 404 when there is no constraint with that key, 422 with {problems}.
   */
  constraintSave(req, res, key) {
    const previous = req.profile;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const row = { key, human: body.human, expression: body.expression };
    const constraints = profiles.constraintsOf(previous);
    const at = key === null ? constraints.length : constraints.findIndex(c => c.key === key);
    if (at < 0) {
      return res.status(404).json({ problems: [`The profile has no constraint '${key}'`] });
    }
    // the row by itself first, so what is wrong is said of it, not of a number in the list
    const alone = profiles.checkInput({ title: previous.title, constraints: [{ human: row.human, expression: row.expression }] }, null);
    if (alone.problems.length) {
      return res.status(422).json({ problems: alone.problems.map(p => p.replace(/^Constraint 1/, 'The rule')) });
    }
    constraints.splice(at, key === null ? 0 : 1, row);
    const checked = profiles.checkInput({ title: previous.title, constraints }, previous);
    if (checked.problems.length) {
      return res.status(422).json({ problems: checked.problems });
    }
    this.saveConstraints(previous, checked.constraints);
    this.log.info(`IPS module: clinical profile ${previous.id}: constraint ${checked.constraints[at].key} ${key === null ? 'added' : 'saved'}`);
    res.status(key === null ? 201 : 200).json({ key: checked.constraints[at].key });
  }

  /** Delete one of a profile's constraints, back to the profile's page. */
  constraintDelete(req, res) {
    const previous = req.profile;
    const constraints = profiles.constraintsOf(previous);
    const at = constraints.findIndex(c => c.key === req.params.key);
    if (at < 0) {
      return htmlServer.sendErrorResponse(res, TEMPLATE, new Error(`The profile has no constraint '${req.params.key}'`), 404);
    }
    constraints.splice(at, 1);
    this.saveConstraints(previous, constraints);
    this.log.info(`IPS module: clinical profile ${previous.id}: constraint ${req.params.key} deleted`);
    res.redirect(`${req.baseUrl}/StructureDefinition/${previous.id}`);
  }

  saveConstraints(previous, constraints) {
    const id = previous.id.substring('profile-'.length);
    this.store.saveProfile(id, profiles.build({ id, url: previous.url, title: previous.title, constraints }));
  }

  // ---- the editor ----

  /** The projects an editor without a project can submit to: code, name, and how (submitOffer). */
  submitTargets(user) {
    // the list leaves the token out; whether there is one comes from the project itself
    return this.store.projects().map(p => ({ code: p.code, name: p.name, ...this.submitOffer(this.store.projectByCode(p.code), user) }));
  }

  /** What every editor page passes to the document actions (doc-actions.js). */
  actionsConfig(req, editor, res = null) {
    const base = req.baseUrl;
    const p = req.project;
    return {
      editor,
      project: p ? { code: p.code, name: p.name, ...this.submitOffer(p, auth.currentUser(req)) } : null,
      projects: p ? [] : this.submitTargets(auth.currentUser(req)),
      // a logged in user's posts carry the CSRF token (lusca checks it for them)
      csrf: res.locals?._csrf || null,
      canShare: !!this.shl,
      shareDays: DEFAULT_EDITOR_SHARE_DAYS,
      urls: {
        check: `${base}/compose/check`, share: `${base}/compose/share`, submit: `${base}/compose/submit`, viewer: this.viewer ? `${base}/view` : null,
        vendor: {
          jspdf: assets.src(base, 'vendor/jspdf.umd.min.js'), html2canvas: assets.src(base, 'vendor/html2canvas.min.js'),
          pdflib: assets.src(base, 'vendor/pdf-lib.min.js'), zip: assets.src(base, 'vendor/zip.min.js')
        }
      }
    };
  }

  /** The list of document creators, for a project or for none. */
  sendComposeChoice(req, res) {
    const p = req.project || null;
    this.sendHtml(res, p ? `${p.name}: Compose a Document` : 'Compose a Document',
      render.renderComposeChoice(p, this.ctx(req, res), { editors: EDITORS }), Date.now(), req);
  }

  /** The general IPS editor: empty, or holding a document of the project's (?from=). */
  sendCompose(req, res) {
    let model = null;
    let from = null;
    const p = req.project || null;
    if (p && typeof req.query.from === 'string' && /^\d{1,12}$/.test(req.query.from)) {
      const row = this.store.read(parseInt(req.query.from, 10), p.id);
      if (!row) {
        return htmlServer.sendErrorResponse(res, TEMPLATE, new Error(`No document with id '${req.query.from}'`), 404);
      }
      model = composer.modelOf(row.bundle);
      from = row.id;
    }
    const title = from ? `Edit Document ${from}` : 'General IPS Editor';
    this.sendHtml(res, p ? `${p.name}: ${title}` : title,
      render.renderCompose(p, this.ctx(req, res), {
        schema: editorSchema.forBrowser(), model, from,
        aiEnabled: p ? this.store.projectAi(p).enabled === true : false, canLookup: !!(this.tx && this.valueSets),
        actions: this.actionsConfig(req, 'general', res),
        testPatients: assets.testPatients(req.baseUrl)
      }), Date.now(), req);
  }

  /** The patient IPS editor (the form that was the Patient Document Generator on healthintersections.com.au). */
  sendPatientEditor(req, res) {
    const p = req.project || null;
    this.sendHtml(res, p ? `${p.name}: Patient IPS Editor` : 'Patient IPS Editor',
      render.renderPatientEditor(p, this.ctx(req, res), {
        page: assets.text('patient-editor', 'page.html'),
        actions: this.actionsConfig(req, 'patient', res),
        aiEnabled: p ? this.store.projectAi(p).enabled === true : false
      }), Date.now(), req);
  }

  /** The bundle in an editor's call, or null. */
  bundleIn(req) {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body.bundle : null;
    return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
  }

  /** What's wrong with the document for the editors' actions: not a document, not a minimal IPS, too big. */
  editorProblems(bundle) {
    const problems = validateDocument(bundle);
    if (problems.length > 0) {
      return problems;
    }
    const minimal = minimalIpsProblems(bundle);
    if (minimal.length > 0) {
      return minimal;
    }
    const size = Buffer.byteLength(JSON.stringify(bundle), 'utf8');
    return size > this.maxSize ? [`The document is ${size} bytes; documents can't be bigger than ${this.maxSize} bytes`] : [];
  }

  /** The general editor: build the document from its model; the document and what's wrong with it. */
  async composeBuild(req, res) {
    const model = req.body && typeof req.body === 'object' ? req.body.model : null;
    let built;
    try {
      built = await composer.build(model);
    } catch (e) {
      this.log.error(`IPS module: composing a document failed: ${e.message}`);
      return res.status(500).json({ error: 'The document could not be built' });
    }
    if (!built.bundle) {
      return res.json({ bundle: null, problems: built.problems });
    }
    res.json({ bundle: built.bundle, problems: [...built.problems, ...this.editorProblems(built.bundle)] });
  }

  /** Whether a document is ready for the editors' actions: what's wrong with it ([] if nothing). */
  composeCheck(req, res) {
    const bundle = this.bundleIn(req);
    res.json({ problems: bundle ? this.editorProblems(bundle) : ['There is no document'] });
  }

  /** The general editor: a document, as the editor's model (for loading a document, or a test patient). */
  composeModel(req, res) {
    const bundle = this.bundleIn(req);
    const problems = bundle ? validateDocument(bundle) : ['There is no document'];
    if (problems.length > 0) {
      return res.status(400).json({ error: 'That is not a document the editor can load', problems });
    }
    res.json({ model: composer.modelOf(bundle) });
  }

  /** Share a document from an editor as an SHL or VHL QR code. It isn't stored in a project. */
  async composeShare(req, res) {
    if (!this.shl) {
      return res.status(404).json({ error: 'Sharing is not configured on this server (modules.ips.shl)' });
    }
    const bundle = this.bundleIn(req);
    const problems = bundle ? this.editorProblems(bundle) : ['There is no document'];
    if (problems.length > 0) {
      return res.status(400).json({ error: 'The document is not ready to share', problems });
    }
    const kind = req.body.kind === 'vhl' ? 'vhl' : 'shl';
    const days = parseInt(req.body.days, 10);
    const name = summaryOfName(bundle);
    let out;
    try {
      out = await this.shl.share(bundle, {
        kind, host: req.get('host'), label: name ? `Patient Health Document for ${name}` : 'Patient Health Document',
        days: Number.isInteger(days) && days >= 1 && days <= 365 ? days : DEFAULT_EDITOR_SHARE_DAYS,
        viewer: this.viewer ? this.viewerUrl(req) : undefined
      });
    } catch (e) {
      this.log.error(`IPS module: a document from an editor could not be shared as ${kind}: ${e.message}`);
      return res.status(502).json({ error: e.message });
    }
    this.log.info(`IPS module: a document from an editor shared as ${kind.toUpperCase()} (${out.bytes} bytes, until ${out.expires})`);
    res.json(out);
  }

  /** Submit a document from an editor to a project (the project's page names it; otherwise the user picked it). */
  composeSubmit(req, res) {
    const code = typeof req.body?.project === 'string' ? req.body.project : '';
    const p = CODE_RE.test(code) && !RESERVED.has(code) ? this.store.projectByCode(code) : null;
    if (!p) {
      return res.status(404).json({ error: code ? `There is no project '${code}'` : 'Choose the project to submit the document to' });
    }
    const supplied = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    const problem = this.submissionProblem(req, p, supplied, auth.currentUser(req), 'web');
    if (problem) {
      return res.status(problem.status).json({ error: problem.message });
    }
    const bundle = this.bundleIn(req);
    const problems = bundle ? this.editorProblems(bundle) : ['There is no document'];
    if (problems.length > 0) {
      return res.status(400).json({ error: 'The document could not be submitted', problems });
    }
    req.project = p;
    const { id } = this.receive(req, bundle, req.body.editor === 'patient' ? 'patient-editor' : 'editor');
    res.status(201).json({ id, url: `${req.baseUrl}/${encodeURIComponent(p.code)}/Bundle/${id}` });
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
      const problem = this.submissionProblem(req, p, supplied, auth.currentUser(req), 'web');
      if (problem) {
        return res.status(problem.status).json({ error: problem.message });
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
    const problem = this.submissionProblem(req, p, supplied, auth.currentUser(req), 'web');
    if (problem) {
      return this.sendSubmit(req, res, { error: problem.message, bundle: text }, problem.status);
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
      const { view, narrative, source } = render.viewOf(req.query);
      row.results = {};
      for (const step of this.steps) {
        row.results[step.name] = this.store.readResult(row.id, step.name);
      }
      const ctx = {
        ...this.ctx(req, res),
        steps: this.steps.map(st => st.name),
        level: typeof req.query.level === 'string' ? req.query.level : undefined,
        np: typeof req.query.np === 'string' ? req.query.np : undefined,
        problemsOnly: req.query.problems === '1',
        narrative,
        source
      };
      return this.sendHtml(res, documentPageTitle(row), render.renderDocument(req.project, row, view, ctx), start, req);
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

  // ---- patients ----

  /**
   * The project's patients that match a search: _id, identifier (system|value, or a value),
   * name / family / given (starts a word of the name, without regard to case or accents; a name
   * that is only text is searched by family and given too), birthdate (the date, or its year or
   * year and month), gender. _count and _offset page it.
   * @returns {{patients: Array, problems: string[], unknown: string[], count: number, offset: number}}
   */
  findPatients(req) {
    const q = req.query || {};
    const problems = [];
    const unknown = [];
    const one = (k) => (Array.isArray(q[k]) ? q[k][q[k].length - 1] : q[k]);
    let list = this.store.patients(req.project.id);
    const KNOWN = new Set(['_id', 'identifier', 'name', 'family', 'given', 'birthdate', 'gender', '_count', '_offset', '_format']);
    for (const k of Object.keys(q)) {
      if (!KNOWN.has(k)) {
        unknown.push(k);
      }
    }
    const value = (k) => (typeof one(k) === 'string' ? one(k).trim() : '');
    if (value('_id')) {
      const ids = new Set(value('_id').split(',').map(x => x.trim()));
      list = list.filter(p => ids.has(String(p.id)));
    }
    if (value('identifier')) {
      const ids = new Set(this.store.patientsByIdentifier(req.project.id, value('identifier')));
      list = list.filter(p => ids.has(p.id));
    }
    const nameWords = (p, part) => (Array.isArray(p.resource.name) ? p.resource.name : []).flatMap(n => {
      if (!n || typeof n !== 'object') {
        return [];
      }
      const given = (Array.isArray(n.given) ? n.given : []).flatMap(patients.words);
      const family = patients.words(n.family);
      const text = patients.words(n.text);
      if (part === 'family') {
        return family.length ? family : (given.length ? [] : text);
      }
      if (part === 'given') {
        return given.length ? given : (family.length ? [] : text);
      }
      return [...given, ...family, ...text];
    });
    for (const part of ['name', 'family', 'given']) {
      if (value(part)) {
        const want = patients.words(value(part));
        list = list.filter(p => {
          const have = nameWords(p, part);
          return want.every(w => have.some(h => h.startsWith(w)));
        });
      }
    }
    if (value('birthdate')) {
      const d = value('birthdate').replace(/^eq/, '');
      if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(d)) {
        problems.push(`The birthdate '${value('birthdate')}' is not a date (YYYY, YYYY-MM or YYYY-MM-DD)`);
      } else {
        list = list.filter(p => typeof p.birth_date === 'string' && p.birth_date.startsWith(d));
      }
    }
    if (value('gender')) {
      list = list.filter(p => p.gender === value('gender'));
    }
    const count = Math.min(Math.max(parseInt(value('_count') || '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(value('_offset') || '0', 10) || 0, 0);
    return { all: list, patients: list.slice(offset, offset + count), problems, unknown, count, offset };
  }

  patientSearch(req, res) {
    const start = Date.now();
    const found = this.findPatients(req);
    if (wantsHtml(req) && !/json/.test(String(req.query._format || ''))) {
      return this.sendHtml(res, `${req.project.name}: Patients`, render.renderPatients(req.project, found, req.query, this.ctx(req, res)), start, req);
    }
    if (found.problems.length > 0) {
      return this.sendOutcome(res, 400, 'invalid', found.problems);
    }
    const base = this.projectUrl(req);
    const link = (offset) => {
      const u = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query)) {
        if (!['_count', '_offset', '_format'].includes(k) && typeof v === 'string') {
          u.append(k, v);
        }
      }
      u.append('_count', String(found.count));
      u.append('_offset', String(offset));
      return `${base}/Patient?${u.toString()}`;
    };
    const links = [{ relation: 'self', url: link(found.offset) }];
    if (found.offset + found.count < found.all.length) {
      links.push({ relation: 'next', url: link(found.offset + found.count) });
    }
    const bundle = {
      resourceType: 'Bundle', id: crypto.randomUUID(), meta: { lastUpdated: new Date().toISOString() }, type: 'searchset',
      total: found.all.length, link: links,
      entry: found.patients.map(p => ({ fullUrl: `${base}/Patient/${p.id}`, resource: p.resource, search: { mode: 'match' } }))
    };
    if (found.unknown.length > 0) {
      bundle.entry.push({ resource: operationOutcome('warning', 'not-supported', found.unknown.map(u => `Unknown search parameter '${u}' was ignored`)), search: { mode: 'outcome' } });
    }
    if (bundle.entry.length === 0) {
      delete bundle.entry;
    }
    return this.sendJson(res, 200, bundle);
  }

  patientRead(req, res) {
    const start = Date.now();
    const pid = /^\d{1,12}$/.test(req.params.pid) ? parseInt(req.params.pid, 10) : NaN;
    const p = this.store.patient(req.project.id, pid);
    const html = wantsHtml(req) && !/json/.test(String(req.query._format || ''));
    if (!p) {
      return html ? htmlServer.sendErrorResponse(res, TEMPLATE, new Error(`No patient with id '${req.params.pid}'`), 404)
        : this.sendOutcome(res, 404, 'not-found', `No Patient with id '${req.params.pid}'`);
    }
    if (html) {
      const name = p.name || '(no name)';
      return this.sendHtml(res, `Patient #${p.id}: ${name}`, render.renderPatient(req.project, p, this.store.patientDocuments(p.id), this.ctx(req, res)), start, req);
    }
    return this.sendJson(res, 200, p.resource);
  }

  /**
   * IPS $summary: the patient's latest document (the most recently received) - the modified
   * copy, unless modules.ips.summarySource is "original" (or it hasn't been processed yet).
   * By the patient's id, or by an identifier (?identifier=system|value).
   */
  summary(req, res, pidText) {
    let patientId;
    if (pidText !== null) {
      patientId = /^\d{1,12}$/.test(pidText) ? parseInt(pidText, 10) : NaN;
      if (!this.store.patient(req.project.id, patientId)) {
        return this.sendOutcome(res, 404, 'not-found', `No Patient with id '${pidText}'`);
      }
    } else {
      const identifier = typeof req.query.identifier === 'string' ? req.query.identifier.trim() : '';
      if (!identifier) {
        return this.sendOutcome(res, 400, 'required', 'Patient/$summary needs the patient\'s id (Patient/[id]/$summary) or an identifier (?identifier=system|value)');
      }
      const ids = this.store.patientsByIdentifier(req.project.id, identifier);
      if (ids.length === 0) {
        return this.sendOutcome(res, 404, 'not-found', `No patient has the identifier '${identifier}'`);
      }
      if (ids.length > 1) {
        return this.sendOutcome(res, 422, 'multiple-matches', `More than one patient has the identifier '${identifier}' (${ids.map(i => `Patient/${i}`).join(', ')})`);
      }
      patientId = ids[0];
    }
    const docs = this.store.patientDocuments(patientId);
    const row = docs.length ? this.store.read(docs[0].id, req.project.id) : null;
    if (!row) {
      return this.sendOutcome(res, 404, 'not-found', `Patient ${patientId} has no documents`);
    }
    const doc = this.config.summarySource !== 'original' && row.analysed ? row.analysed : row.bundle;
    return this.sendJson(res, 200, doc);
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
        documentation: this.submitAccess(p).open ? 'Anyone may submit a document' : this.submitNeeds(p, 'api'),
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
        }, {
          type: 'Patient',
          documentation: 'The patients of the documents received: each document\'s Patient is matched to one seen before ' +
            '(the same identifier, or the same name and birth date) or is a new one; the resource is what the documents have said about them, cumulatively, ' +
            'with this server\'s id. $summary returns the patient\'s latest document',
          interaction: [{ code: 'read' }, { code: 'search-type' }],
          versioning: 'no-version',
          readHistory: false,
          updateCreate: false,
          searchParam: [
            { name: '_id', type: 'token' }, { name: 'identifier', type: 'token' }, { name: 'name', type: 'string' },
            { name: 'family', type: 'string' }, { name: 'given', type: 'string' }, { name: 'birthdate', type: 'date' }, { name: 'gender', type: 'token' }
          ],
          operation: [{ name: 'summary', definition: 'http://hl7.org/fhir/uv/ips/OperationDefinition/summary' }]
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
