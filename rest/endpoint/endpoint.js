//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * One FHIR endpoint: its database, settings, definitions, and the express router that serves
 * it. Every request goes the same way:
 *
 *   request.js   the HTTP request (or Bundle entry) as a FHIR request, and its interaction
 *   access.js    whether the user may do it, and with what compartment limits
 *   interaction  inside a database transaction (interactions/, search/, operations/)
 *   respond()    the result in the negotiated format (format.js)
 *
 * What changes rarely is cached in the process: settings, Types, the definitions with their
 * compiled expressions, and Spaces and Tags keys. The Config table's generation number is
 * compared with the database's at most once a second, and everything reloads when it
 * changes. Resources and search results are never cached.
 *
 * Under maintenance (maintenance.js: the database being wiped and made again), every request
 * is answered 503 and the background jobs wait. The database's epoch (Config: made with it)
 * tells each process that the database was made again, and the process sets itself up again
 * from it (setup) before it uses the database.
 *
 * @module rest/endpoint/endpoint
 */

const express = require('express');
const crypto = require('crypto');
const { openDatabase } = require('../database');
const settingsStore = require('./settings');
const { Definitions, loadDerived, corePackage, majorMinor } = require('../indexing/definitions');
const { Indexer } = require('../indexing/indexer');
const { Lookups } = require('../database/lookups');
const { Store } = require('../store');
const { Searcher } = require('../search/search');
const { shape } = require('../search/shape');
const { auditBuilder } = require('../audit/audit');
const provenance = require('../interactions/provenance');
const { Terminology } = require('../terminology');
const { FhirError, notFound, notAllowed, forbidden, operationOutcome } = require('../library/errors');
const format = require('../format');
const request = require('../request');
const access = require('../access');
const crud = require('../interactions/crud');
const { history } = require('../interactions/history');
const { capabilities } = require('../interactions/capabilities');
const { bundle } = require('../interactions/bundle');
const { findOperation } = require('../operations/operations');
const { writeParts } = require('../../library/fhir-xml');
const binary = require('../binary');
const { PackageLoader } = require('../packages');
const { QueueRunner } = require('../queue/runner');
const { AsyncJobs, PATH: ASYNC_PATH } = require('../queue/async');
const queueStatus = require('../queue/status');
const terminologyProxy = require('../operations/terminology');
const { RestWeb, wantsHtml } = require('../web');
const { Maintenance } = require('../maintenance');

const GENERATION_CHECK_MS = 1000;
const AUDIT_FLUSH_MS = 1000;
const MAX_AUDIT_BUFFER = 5000;
const REINDEX_BATCH = 200;
// how often the queues are measured for the status page
const STATUS_MS = 15 * 1000;

// how long a client is told to wait, under maintenance (Retry-After, in seconds)
const MAINTENANCE_RETRY_S = 30;

/** The answer under maintenance: 503, saying how it is going */
function maintenanceError(m) {
  const fe = new FhirError(503, 'transient', `The server is under maintenance (${m.state}${m.message ? ': ' + m.message : ''}). Try again later`);
  fe.headers = { ...(fe.headers || {}), 'Retry-After': String(MAINTENANCE_RETRY_S) };
  fe.maintenance = true;
  return fe;
}

// the role an interaction needs, by what access.js calls it
const ACCESS_NAMES = {
  'conditional-update': 'update', 'conditional-delete': 'delete', 'conditional-patch': 'patch'
};

class Endpoint {
  /**
   * @param {Object} cfg - one entry of modules.rest.endpoints: { path, database, fhirVersion,
   *   baseUrl?, initialSettings?, types? }
   * @param {Object} options
   * @param {string} options.databasesDir
   * @param {boolean} options.master - runs migrations, and seeds the settings
   * @param {boolean} [options.jobs] - runs the queue runner (queue/runner.js): the background
   *   jobs and the queues. Default: as master (one process does both, without the cluster)
   * @param {string} [options.localBase] - where this server is reached over HTTP (the
   *   cluster's front door), for a jobs process: a terminology server that is a path on this
   *   server is reached there, since the jobs process doesn't run the tx module
   * @param {Object} options.log - a logger (info, warn, error, debug)
   * @param {Object} [options.packageManager] - library/package-manager PackageManager
   * @param {string} [options.cacheFolder] - where derived definitions are cached
   * @param {Object} [options.derived] - definitions already derived (tests)
   * @param {Function} [options.app] - the express app, for a terminology server on this server
   * @param {function(Object): Promise<Object|null>} [options.principal] - who a request is
   * @param {string} [options.hostName]
   * @param {number} [options.maintenanceGraceMs] - how long a reset gives the requests under
   *   way (maintenance.js; tests: less)
   */
  constructor(cfg, options) {
    if (!cfg || typeof cfg.path !== 'string' || !/^\/[A-Za-z0-9/_-]*$/.test(cfg.path)) {
      throw new Error(`A rest endpoint needs a path like /fhir/r4, not '${cfg && cfg.path}'`);
    }
    this.cfg = cfg;
    this.path = cfg.path.replace(/\/+$/, '');
    this.options = options;
    this.log = options.log;
    this.master = options.master !== false;
    this.jobs = options.jobs === undefined ? this.master : !!options.jobs;
    this.runner = null;
    this.startedAt = Date.now();
    this.auditBuffer = [];
    this.lastGenerationCheck = 0;
    this.generation = null;
    this.bundleReturnsResources = true;
    this.terminology = null;
    // set up from the database (setup): not while a reset is making it again
    this.ready = false;
    this.epoch = null;
    this.settingUp = null;
  }

  // ---- start up and refresh ----

  async open() {
    const cfg = this.cfg;
    this.db = await openDatabase(cfg.database, { databasesDir: this.options.databasesDir, master: this.master, log: (m) => this.log.info(m) });
    this.maintenance = new Maintenance(this, { graceMs: this.options.maintenanceGraceMs });
    const m = await this.maintenance.current(true);
    if (!m || m.state === 'loading') {
      await this.setup({ first: true });
    } else {
      // the database is being made again: set up when it has been (refresh)
      this.log.warn(`Rest ${this.path}: the endpoint is under maintenance (${m.state}): it answers 503 until it is over`);
    }
    this.web = new RestWeb(this);
    this.packages = new PackageLoader(this);
    this.asyncJobs = new AsyncJobs(this);
    if (this.jobs) {
      if (m && m.state === 'loading') {
        // the reset's loads go on (maintenance.js)
        await this.packages.requeueRunning();
      } else if (!m) {
        await this.packages.recover();
      }
      this.startJobs();
    }
    this.auditTimer = setInterval(() => {
      this.flushAudits().catch(e => this.log.error(`Rest ${this.path}: writing AuditEvents failed: ${e.message}`));
    }, AUDIT_FLUSH_MS);
    this.auditTimer.unref();
    if (this.ready) {
      this.log.info(`Rest endpoint ${this.path}: FHIR ${this.settings.fhirVersion}, ${this.typeKeys.size} types, ${this.definitions.byUrl.size} search parameters, ` +
        `${this.cfg.database.type} database${this.master ? '' : this.jobs ? ' (jobs)' : ' (worker)'}${this.master && !this.jobs ? ', jobs in the jobs process' : ''}`);
    }
  }

  /**
   * Set the endpoint up from its database: as the master does for a new database (the settings
   * from initialSettings, the packages to load, the types) when this is the master or the
   * database was just made again by a reset (fresh); then the settings, definitions and keys,
   * all read again (nothing kept from before).
   * @param {Object} options
   * @param {boolean} [options.first] - as the endpoint opens
   * @param {boolean} [options.fresh] - after a reset (maintenance.js), in the process that did it
   */
  async setup(options = {}) {
    if (this.settingUp) {
      return this.settingUp;
    }
    this.settingUp = this.doSetup(options).finally(() => {
      this.settingUp = null;
    });
    return this.settingUp;
  }

  async doSetup(options) {
    const cfg = this.cfg;
    const seeding = this.master || !!options.fresh;
    this.ready = false;
    this.definitions = null;
    this.lookups = null;
    this.auditBuffer = [];
    // the FHIR version is fixed when the database is made
    const initial = { ...(cfg.initialSettings || {}) };
    if (cfg.fhirVersion) {
      initial.fhirVersion = cfg.fhirVersion;
    }
    // packages to load into a new database: not a setting
    const loadPackages = (initial.loadPackages || []).map(p => PackageLoader.parse(p));
    delete initial.loadPackages;
    if (seeding) {
      const isNew = !(await this.db.read(q => q.get("SELECT Value FROM Config WHERE Name = 'generation'")));
      await settingsStore.seed(this.db, initial, []);
      if (isNew) {
        // which database this is: a reset makes a new one
        await this.db.write(q => q.run(q.dialect.insertIgnore('Config', ['Name', 'Value']) + '(?, ?)', ['epoch', crypto.randomUUID()]));
      }
      if (isNew && loadPackages.length) {
        await this.db.write(async (q) => {
          for (const p of loadPackages) {
            await PackageLoader.queue(q, p, 'initialSettings');
          }
        });
        this.log.info(`Rest ${cfg.path}: a new database: ${loadPackages.length} package(s) to load (initialSettings.loadPackages)`);
      }
    }
    let loaded = await settingsStore.load(this.db);
    if (!loaded.endpoint.fhirVersion) {
      throw new Error(`The rest endpoint ${this.path} has no FHIR version: give fhirVersion in its configuration`);
    }
    if (cfg.fhirVersion && majorMinor(cfg.fhirVersion) !== majorMinor(loaded.endpoint.fhirVersion)) {
      throw new Error(`The rest endpoint ${this.path}'s database is FHIR ${loaded.endpoint.fhirVersion}, but the configuration says ${cfg.fhirVersion}`);
    }
    if (options.first) {
      this.warnOverridden(cfg.initialSettings || {}, loaded.endpoint);
    }
    await this.loadDefinitions(loaded.endpoint);
    if (seeding) {
      await settingsStore.seed(this.db, {}, [...this.definitions.resourceTypes], cfg.types || {});
    }
    loaded = await settingsStore.load(this.db);
    const epoch = await this.db.read(q => q.get("SELECT Value FROM Config WHERE Name = 'epoch'"));
    this.epoch = epoch ? epoch.Value : null;
    await this.apply(loaded);
    this.lastGenerationCheck = Date.now();
    this.ready = true;
  }

  /**
   * initialSettings are only written into a new database: say so when the database has
   * something else, since the configuration then looks like it says what the endpoint does
   */
  warnOverridden(initial, current) {
    for (const [name, value] of Object.entries(initial)) {
      if (!(name in current)) {
        continue;
      }
      const a = JSON.stringify(Array.isArray(value) ? value : String(value));
      const b = JSON.stringify(Array.isArray(current[name]) ? current[name] : String(current[name]));
      if (a !== b) {
        this.log.warn(`Rest ${this.path}: initialSettings.${name} is ${a} in config.json, but the database has ${b}, which is what is used ` +
          '(initialSettings are only written into a new database: change the Config table, and bump its generation row)');
      }
    }
  }

  async loadDefinitions(endpointSettings) {
    const fhirVersion = endpointSettings.fhirVersion;
    let derived = this.options.derived;
    if (!derived) {
      const packages = [corePackage(fhirVersion), ...(endpointSettings.packages || [])];
      derived = await loadDerived({ fhirVersion, packages, packageManager: this.options.packageManager, cacheFolder: this.options.cacheFolder });
    }
    let custom = [];
    if (endpointSettings.customSearchParameters) {
      custom = await this.storedSearchParameters();
    }
    const defs = new Definitions(derived, custom, (level, msg) => this.log[level === 'warn' ? 'warn' : 'debug'](`Rest ${this.path}: ${msg}`));
    const hasResources = await this.db.read(async (q) => !!(await q.get('SELECT ResourceKey FROM Ids WHERE MostRecent IS NOT NULL LIMIT 1')));
    const reload = !!this.definitions;
    // who records the definitions in SearchParams: the master as it starts (before anything
    // else runs), and after that the process running the jobs, which notices new ones (a
    // custom SearchParameter) and reindexes: one writer at a time
    const writer = this.jobs || (this.master && !reload);
    const changed = await defs.sync(this.db, writer, hasResources);
    this.definitions = defs;
    if (reload && writer && changed.added + changed.changed > 0) {
      // the workers pick up the new definitions' keys
      await this.db.write(q => settingsStore.bumpGeneration(q));
      this.log.info(`Rest ${this.path}: ${changed.added} new and ${changed.changed} changed search parameters: reindexing`);
    }
  }

  async storedSearchParameters() {
    const out = [];
    await this.db.read(async (q) => {
      const t = await q.get('SELECT TypeKey FROM Types WHERE Name = ?', ['SearchParameter']);
      if (!t) {
        return;
      }
      const rows = await q.all('SELECT v.Compressed, v.Content FROM Ids i JOIN Versions v ON v.VersionKey = i.MostRecent WHERE i.TypeKey = ? AND i.Deleted = 0', [t.TypeKey]);
      const { decode } = require('../store');
      for (const r of rows) {
        const sp = decode(r);
        if (sp && sp.status !== 'retired') {
          out.push(sp);
        }
      }
    });
    return out;
  }

  async apply(loaded) {
    // everything is being reindexed (a schema migration added something every resource needs:
    // the full-text index at version 2, the Contained table at 3)
    this.reindexAll = !!(await this.db.read(q => q.get('SELECT Value FROM Config WHERE Name = ?', ['reindexAll'])));
    this.generation = loaded.generation;
    this.settings = loaded.endpoint;
    this.types = loaded.types;
    this.typeKeys = loaded.typeKeys;
    this.timeZone = this.settings.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.baseUrl = this.cfg.baseUrl || (this.options.hostName ? `https://${this.options.hostName}${this.path}` : null);
    if (!this.lookups) {
      this.lookups = new Lookups();
    }
    this.indexer = new Indexer({ definitions: this.definitions, lookups: this.lookups, typeKeys: this.typeKeys, timeZone: this.timeZone,
      baseUrls: [this.baseUrl].filter(x => x), checkReferences: this.settings.checkReferences, log: (l, m) => this.log.debug(m) });
    this.store = new Store(this);
    this.searcher = new Searcher(this);
    this.audit = auditBuilder(this.settings.fhirVersion);
    this.terminology = null;
    if (this.settings.txServer) {
      try {
        this.terminology = new Terminology(this.terminologyServer(this.settings.txServer), { app: this.options.app, log: this.log });
      } catch (e) {
        this.log.error(`Rest ${this.path}: txServer: ${e.message}`);
      }
    }
  }

  /**
   * The terminology server to use: as set, except that in a jobs process a path on this
   * server is reached through the front door (options.localBase)
   */
  terminologyServer(server) {
    const base = this.options.localBase;
    if (base && typeof server === 'string' && server.startsWith('/')) {
      return base.replace(/\/+$/, '') + server;
    }
    return server;
  }

  /**
   * Reload when the settings' generation has changed (at most once a second); set up again
   * when the database is a new one (a reset), or hasn't been set up yet (it was under
   * maintenance). Not under maintenance: the caller has checked
   */
  async refresh() {
    if (!this.ready) {
      await this.setup({});
      return;
    }
    const now = Date.now();
    if (now - this.lastGenerationCheck < GENERATION_CHECK_MS) {
      return;
    }
    this.lastGenerationCheck = now;
    const rows = await this.db.read(q => q.all("SELECT Name, Value FROM Config WHERE Name IN ('generation', 'epoch')"));
    const value = (name) => {
      const r = rows.find(x => x.Name === name);
      return r ? r.Value : null;
    };
    if (value('epoch') !== this.epoch) {
      this.log.info(`Rest ${this.path}: the database was made again (a reset): setting up from it`);
      await this.setup({});
      return;
    }
    const g = value('generation') === null ? 0 : Number(value('generation'));
    if (g !== this.generation) {
      const loaded = await settingsStore.load(this.db);
      const packagesChanged = JSON.stringify(loaded.endpoint.packages) !== JSON.stringify(this.settings.packages) ||
        loaded.endpoint.customSearchParameters !== this.settings.customSearchParameters;
      if (packagesChanged || loaded.endpoint.customSearchParameters) {
        await this.loadDefinitions(loaded.endpoint);
      } else {
        // the reindexing flags may have changed
        const hasResources = true;
        await this.definitions.sync(this.db, false, hasResources);
      }
      await this.apply(loaded);
      this.log.info(`Rest ${this.path}: settings reloaded (generation ${g})`);
    }
  }

  /**
   * Refuse a request while the endpoint is under maintenance: 503, with how it is going
   * @throws {FhirError}
   */
  async checkMaintenance() {
    const m = await this.maintenance.current();
    if (m) {
      throw maintenanceError(m);
    }
  }

  /** What to answer for an error that wasn't a FhirError: 503 if it's because of maintenance */
  async errorFor(e) {
    if (e instanceof FhirError) {
      return e;
    }
    let m = null;
    try {
      m = await this.maintenance.current(true);
    } catch (e2) {
      // the database itself isn't answering: a 500, as it would be
    }
    return m ? maintenanceError(m) : null;
  }

  // ---- helpers for the interactions ----

  inRead(ctx, fn) {
    return ctx && ctx.q ? fn(ctx.q) : this.db.read(fn);
  }

  inWrite(ctx, fn) {
    return ctx && ctx.q ? fn(ctx.q) : this.db.write(fn);
  }

  typeSettings(type) {
    return this.types.get(type) || { supported: false };
  }

  typeSupported(type) {
    const t = this.types.get(type);
    return !!(t && t.supported);
  }

  /**
   * Check a type exists, is supported, and allows an interaction (405 if not).
   */
  checkType(type, interaction) {
    if (!this.typeKeys.has(type)) {
      throw notFound(`Unknown resource type ${type}`);
    }
    const t = this.typeSettings(type);
    if (!t.supported) {
      throw notFound(`The resource type ${type} is not supported on this endpoint`);
    }
    if (interaction && !settingsStore.typeAllows(t, interaction)) {
      throw notAllowed(`${interaction} is not allowed for ${type} on this endpoint`);
    }
  }

  userId(freq) {
    const p = freq.principal;
    return p ? String(p.login || p.id) : null;
  }

  /** The access name of a request's interaction */
  accessInteraction(freq) {
    if (freq.interaction === 'operation' && terminologyProxy.handles(freq)) {
      // (they read: what they write, the closure, is the terminology server's)
      return 'operation-read';
    }
    if (freq.interaction === 'operation') {
      try {
        const op = findOperation(freq);
        // ($expunge: the manage role)
        return op.manage ? 'manage' : op.read ? 'operation-read' : 'operation';
      } catch (e) {
        return 'operation';
      }
    }
    return ACCESS_NAMES[freq.interaction] || freq.interaction;
  }

  /**
   * SQL limiting resource keys to the request's compartments, or null for no limit.
   */
  compartmentFilter(acc, keyExpr) {
    if (!acc || !acc.compartments) {
      return null;
    }
    if (acc.compartments.length === 0) {
      return { sql: '1 = 0', args: [] };
    }
    const parts = [];
    const args = [];
    for (const c of acc.compartments) {
      const [type, id] = c.split('/');
      parts.push('(ac.CompType = ? AND ac.CompId = ?)');
      args.push(type, id);
    }
    return { sql: `EXISTS (SELECT 1 FROM Compartments ac WHERE ac.ResourceKey = ${keyExpr} AND (${parts.join(' OR ')}))`, args };
  }

  /** Throw 403 if a resource is outside the request's compartments */
  async checkCompartments(q, acc, resourceKey) {
    const f = this.compartmentFilter(acc, 'Ids.ResourceKey');
    if (!f) {
      return;
    }
    const row = await q.get(`SELECT 1 AS ok FROM Ids WHERE ResourceKey = ? AND ${f.sql}`, [resourceKey, ...f.args]);
    if (!row) {
      throw forbidden('The resource is outside the compartments you have access to');
    }
  }

  /** Keep the keys inside the request's compartments */
  async filterKeysByAccess(q, acc, keys) {
    const f = this.compartmentFilter(acc, 'i.ResourceKey');
    if (!f || !keys.length) {
      return keys;
    }
    const rows = await q.all(`SELECT i.ResourceKey FROM Ids i WHERE i.ResourceKey IN (${keys.map(() => '?').join(', ')}) AND ${f.sql}`, [...keys, ...f.args]);
    const ok = new Set(rows.map(r => Number(r.ResourceKey)));
    return keys.filter(k => ok.has(k));
  }

  /** _summary / _elements on a resource */
  shapeResource(resource, freq, control) {
    const c = control || {
      summary: request.param(freq, '_summary') || null,
      elements: request.param(freq, '_elements') ? request.param(freq, '_elements').split(',').map(s => s.trim()).filter(s => s) : null
    };
    if (!c.summary && !(c.elements && c.elements.length)) {
      return resource;
    }
    return shape(resource, c, this.definitions);
  }

  /**
   * Take the lock for a conditional create or update (MySQL; SQLite's write lock already
   * serialises them).
   */
  async conditionalLock(q, type, params) {
    const norm = params.map(([n, v]) => `${n}=${v}`).sort().join('&');
    const name = 'fhirsmith_rest_' + crypto.createHash('sha256').update(`${this.path}|${type}|${norm}`).digest('hex').substring(0, 40);
    await q.lock(name);
  }

  // ---- audit ----

  auditing(kind) {
    const a = this.settings.audit;
    return a === 'all' || (a === 'writes' && kind === 'write');
  }

  /**
   * What a write records besides itself, in its transaction: the Provenance from the
   * X-Provenance header (interactions/provenance.js), and the AuditEvent
   * @param {Object} [ctx] - the write's (deferChecks: whether reference checks wait)
   */
  async recordWrite(q, freq, interaction, status, what, versionKey, ctx) {
    await provenance.target(this, q, freq, interaction, what, !!(ctx && ctx.deferChecks));
    await this.auditWrite(q, freq, interaction, status, what, versionKey);
  }

  /**
   * Record an AuditEvent for a write, in the write's transaction, and point the version at it.
   */
  async auditWrite(q, freq, interaction, status, what, versionKey) {
    if (!this.auditing('write') || !this.typeSupported('AuditEvent')) {
      return;
    }
    const ev = this.audit.build({ interaction, status, principal: freq.principal, ip: freq.ip, what, source: freq.base });
    const r = await this.store.put(q, { type: 'AuditEvent', id: null, resource: ev, mustCreate: true, userId: this.userId(freq), deferChecks: true });
    if (versionKey) {
      await this.store.setAudit(q, versionKey, r.resourceKey);
    }
  }

  /** An AuditEvent for later (reads, and failures): written by flushAudits */
  auditLater(freq, interaction, status, outcomeText) {
    if (!this.typeSupported('AuditEvent') || this.auditBuffer.length >= MAX_AUDIT_BUFFER) {
      return;
    }
    const what = freq.type ? `${freq.type}${freq.id ? '/' + freq.id : ''}${freq.vid ? '/_history/' + freq.vid : ''}` : undefined;
    const query = freq.params && freq.params.length ? freq.params.map(([n, v]) => `${n}=${v}`).join('&') : undefined;
    this.auditBuffer.push({
      ev: this.audit.build({ interaction, status, outcomeText, principal: freq.principal, ip: freq.ip, what: freq.id ? what : undefined,
        query: freq.id ? undefined : (what ? what + (query ? '?' + query : '') : query), source: freq.base, time: Date.now() }),
      userId: this.userId(freq)
    });
  }

  async flushAudits() {
    if (!this.auditBuffer.length) {
      return;
    }
    if (await this.maintenance.active()) {
      // the database they're for is going
      this.auditBuffer = [];
      return;
    }
    // (a new database since: they're dropped, by setup)
    await this.refresh();
    const list = this.auditBuffer.splice(0);
    if (!list.length) {
      return;
    }
    await this.db.write(async (q) => {
      for (const a of list) {
        await this.store.put(q, { type: 'AuditEvent', id: null, resource: a.ev, mustCreate: true, userId: a.userId, deferChecks: true });
      }
    });
  }

  // ---- requests ----

  /**
   * Run a FHIR request.
   * @param {Object} freq - from request.js
   * @param {Object} ctx - { access, q?, reservation?, reserved?, deferChecks? }
   * @returns {Promise<{status: number, resource?: Object, headers?: Object, outcome?: Object, write?: boolean}>}
   */
  async dispatch(freq, ctx) {
    // terminology requests go to the terminology server (operations/terminology.js)
    if (terminologyProxy.handles(freq)) {
      if (freq.type) {
        this.checkType(freq.type, null);
      }
      return terminologyProxy.run(this, freq, ctx);
    }
    switch (freq.interaction) {
      case 'read': return crud.read(this, freq, ctx);
      case 'vread': return crud.vread(this, freq, ctx);
      case 'create': return crud.create(this, freq, ctx);
      case 'update': return crud.update(this, freq, ctx);
      case 'conditional-update': return crud.conditionalUpdate(this, freq, ctx);
      case 'patch': return crud.patch(this, freq, ctx);
      case 'conditional-patch': return crud.conditionalPatch(this, freq, ctx);
      case 'delete': return crud.remove(this, freq, ctx);
      case 'conditional-delete': return crud.conditionalDelete(this, freq, ctx);
      case 'history-instance':
      case 'history-type':
      case 'history-system':
        return history(this, freq, ctx);
      case 'search-type':
      case 'search-system':
        return this.searcher.search(freq, ctx);
      case 'capabilities': return capabilities(this, freq, ctx);
      case 'bundle':
        if (ctx.q) {
          throw new FhirError(400, 'invalid', 'A Bundle can\'t contain another batch or transaction');
        }
        return bundle(this, freq);
      case 'operation': {
        const op = findOperation(freq);
        if (freq.type) {
          this.checkType(freq.type, null);
        }
        return op.run(this, freq, ctx);
      }
    }
    throw notAllowed(`${freq.interaction} is not supported`);
  }

  /** The express router for the endpoint */
  router() {
    const r = express.Router();
    const limit = this.options.maxBody || '50mb';
    // bodies the server's own parsers don't take: JSON Patch, and _search forms
    r.use(express.raw({ type: ['application/json-patch+json'], limit }));
    // XML (application/fhir+xml may have been read already, by the server's own parser)
    r.use(express.raw({ type: ['application/fhir+xml', 'application/xml', 'text/xml', 'application/xml+fhir'], limit }));
    r.use(express.text({ type: ['application/x-www-form-urlencoded'], limit }));
    // a Binary's content, in whatever type it is (binary.js)
    r.use(/^\/Binary(\/[^/]*)?\/?$/, express.raw({ type: () => true, limit }));
    // an async request's status, result and cancellation (queue/async.js)
    const asyncJob = (req, res) => {
      this.handleAsyncJob(req, res).catch((e) => {
        this.log.error(`Rest ${this.path}: ${e.stack || e.message}`);
        if (!res.headersSent) {
          res.status(500).end();
        }
      });
    };
    r.get(`/${ASYNC_PATH}/:id`, asyncJob);
    r.delete(`/${ASYNC_PATH}/:id`, asyncJob);
    r.all(/.*/, (req, res) => {
      this.handle(req, res).catch((e) => {
        this.log.error(`Rest ${this.path}: ${e.stack || e.message}`);
        if (!res.headersSent) {
          res.status(500).end();
        }
      });
    });
    return r;
  }

  /** GET or DELETE [base]/_async/{id}: an async request's status and result, or cancelling it */
  async handleAsyncJob(req, res) {
    try {
      await this.checkMaintenance();
      await this.refresh();
      format.responseFormat(req, this.xmlModel());
      const principal = this.options.principal ? await this.options.principal(req) : null;
      if (req.method === 'DELETE') {
        await this.respond(req, res, { headers: {}, params: [] }, await this.asyncJobs.cancel(req.params.id, principal));
        return;
      }
      const r = await this.asyncJobs.status(req.params.id, principal);
      res.status(r.status);
      for (const [k, v] of Object.entries(r.headers || {})) {
        res.set(k, v);
      }
      if (r.body) {
        res.set('Content-Type', r.contentType);
        res.send(r.body);
      } else {
        res.end();
      }
    } catch (e) {
      const known = await this.errorFor(e);
      if (!known) {
        this.log.error(`Rest ${this.path}: ${req.method} ${req.originalUrl} failed: ${e.stack || e.message}`);
      }
      this.sendError(req, res, known || new FhirError(500, 'exception', 'Internal error'));
    }
  }

  baseFor(req) {
    return this.cfg.baseUrl || `${req.protocol}://${req.get('host')}${req.baseUrl}`;
  }

  async handle(req, res) {
    const start = Date.now();
    let freq = null;
    let interaction = 'unknown';
    try {
      await this.checkMaintenance();
      await this.refresh();
      // (a Binary's own content is whatever type it is: binary.js answers its Accept)
      format.responseFormat(req, this.xmlModel(), { lenient: binary.binaryPath(req) });
      const principal = this.options.principal ? await this.options.principal(req) : null;
      const isPatch = req.method === 'PATCH';
      // a Binary's own content, and a Binary resource in a JSON or XML type of any name (binary.js)
      const content = binary.upload(req);
      const as = binary.binaryPath(req) ? binary.fhirFormatOf(req.get('Content-Type')) : null;
      const body = content || (['POST', 'PUT', 'PATCH'].includes(req.method) && !(req.method === 'POST' && /\/_search\/?(\?|$)/.test(req.originalUrl))
        ? format.requestBody(req, { patch: isPatch, xmlModel: this.xmlModel(), as: isPatch ? null : as }) : null);
      freq = request.fromHttp(req, body, principal, this.baseFor(req));
      interaction = freq.interaction;
      const acc = access.check(principal, this, this.accessInteraction(freq));
      freq.provenance = provenance.fromRequest(this, freq);
      if (!wantsHtml(req) && this.asyncJobs.wanted(req, freq)) {
        // Prefer: respond-async: queued, for the queue runner (queue/async.js)
        await this.respond(req, res, freq, await this.asyncJobs.kickoff(req, freq));
        return;
      }
      const binaryRead = freq.type === 'Binary' && (freq.interaction === 'read' || freq.interaction === 'vread');
      if (wantsHtml(req) && !binaryRead) {
        // a browser: the same interaction, as a page (web.js); a Binary is its content
        await this.web.page(req, res, freq, acc, start);
        return;
      }
      const result = await this.dispatch(freq, { access: acc });
      if (this.auditing('all') && !result.write && freq.interaction !== 'bundle') {
        this.auditLater(freq, freq.interaction === 'operation' ? 'operation' : freq.interaction, result.status);
      }
      await this.respond(req, res, freq, result);
    } catch (e) {
      if (e && e.abandoned) {
        // the client went while a large response was being written: nothing to answer
        return;
      }
      if (res.headersSent) {
        this.log.error(`Rest ${this.path}: ${req.method} ${req.originalUrl} failed after the response started: ${e.message}`);
        return;
      }
      const known = await this.errorFor(e);
      if (!known) {
        this.log.error(`Rest ${this.path}: ${req.method} ${req.originalUrl} failed: ${e.stack || e.message}`);
      }
      const fe = known || new FhirError(500, 'exception', 'Internal error');
      if (freq && this.ready && this.settings && this.settings.audit !== 'off' && fe.status !== 401 && !fe.maintenance) {
        this.auditLater(freq, freq.interaction === 'bundle' ? 'transaction' : interaction, fe.status, fe.message);
      }
      if (wantsHtml(req) && this.web) {
        this.web.error(req, res, fe, start);
      } else {
        this.sendError(req, res, fe);
      }
    } finally {
      if (this.options.stats) {
        this.options.stats.countRequest(interaction, Date.now() - start);
      }
    }
  }

  /** The XML model (null: none, so no XML) */
  xmlModel() {
    return (this.definitions && this.definitions.xml) || null;
  }

  sendError(req, res, fe) {
    res.status(fe.status);
    for (const [k, v] of Object.entries(fe.headers || {})) {
      res.set(k, v);
    }
    if (fe.status === 401) {
      res.set('WWW-Authenticate', 'Bearer');
    }
    let out;
    try {
      out = format.serialise(req, fe.outcome(), format.errorFormat(req, this.xmlModel()), this.xmlModel());
    } catch (e) {
      out = format.serialise(req, fe.outcome());
    }
    res.set('Content-Type', out.contentType);
    res.send(out.text);
  }

  async respond(req, res, freq, result) {
    res.status(result.status);
    for (const [k, v] of Object.entries(result.headers || {})) {
      res.set(k, v);
    }
    if (result.status === 304) {
      res.end();
      return;
    }
    // a read of a Binary: its content, unless a FHIR format was asked for (binary.js)
    if (result.resource && result.resource.resourceType === 'Binary' && !result.write && freq.type === 'Binary' &&
      (freq.interaction === 'read' || freq.interaction === 'vread') && binary.sendsContent(req, result.resource)) {
      binary.send(req, res, result.resource);
      return;
    }
    let body = null;
    if (result.write) {
      const pr = request.preferReturn(freq);
      if (pr === 'minimal') {
        body = null;
      } else if (pr === 'OperationOutcome') {
        body = operationOutcome([result.outcome || { severity: 'information', code: 'informational', diagnostics: 'Done' }]);
      } else {
        body = result.resource || (result.outcome ? operationOutcome([result.outcome]) : null);
      }
    } else if (result.resource) {
      body = result.shape ? this.shapeResource(result.resource, freq) : result.resource;
    } else if (result.outcome) {
      body = operationOutcome([result.outcome]);
    }
    const fmt = format.responseFormat(req, this.xmlModel(), { lenient: binary.binaryPath(req) });
    if (body === null || req.method === 'HEAD') {
      if (body !== null) {
        res.set('Content-Type', format.responseMime(req, fmt) + '; charset=utf-8');
      }
      res.end();
      return;
    }
    // (written first, so a resource that can't be written as XML is an error, not half a
    // response; a large one in parts, letting other requests in as it goes)
    const out = await format.serialiseParts(req, body, fmt, this.xmlModel(), () => !res.destroyed);
    res.set('Content-Type', out.contentType);
    if (out.parts.length === 1 && typeof out.parts[0] === 'string') {
      res.send(out.parts[0]);
    } else {
      await writeParts(res, out.parts);
    }
  }

  // ---- background jobs and queues (the process that runs the jobs: queue/runner.js) ----

  startJobs() {
    this.runner = new QueueRunner(this.path, this.log);
    this.jobTasks(this.runner);
    this.runner.start();
    // a first measure now, rather than in STATUS_MS
    void this.runner.runNow('queue status');
  }

  /**
   * The endpoint's tasks, on a runner. Under maintenance (or before the endpoint is set up)
   * only the maintenance task does anything
   */
  jobTasks(queueRunner) {
    const runner = {
      every: (ms, name, fn) => queueRunner.every(ms, name, async () => {
        if (!this.ready || await this.maintenance.active()) {
          return undefined;
        }
        return fn();
      })
    };
    // a reset (maintenance.js), when one is asked for: the other tasks wait while it goes
    queueRunner.every(1000, 'maintenance', () => this.maintenance.run(() => queueRunner.idle('maintenance')));
    runner.every(5 * 60 * 1000, 'search cleanup', () => this.searcher.cleanup());
    runner.every(5000, 'closure update', async () => {
      if (this.terminology) {
        await this.terminology.updateClosure(this);
      }
    });
    runner.every(5000, 'package loads', async () => {
      await this.packages.runQueued();
    });
    runner.every(5000, 'value set membership', async () => {
      if (this.terminology) {
        await this.terminology.updateValueSets(this);
      }
    });
    runner.every(2000, 'reindexing', async () => {
      // new definitions (a custom SearchParameter) are noticed here, not only on requests
      await this.refresh();
      await this.reindexBatch();
    });
    // async requests (queue/async.js): the next one, and the ones whose runner stopped or
    // whose results have expired
    runner.every(1000, 'async requests', async () => {
      await this.refresh();
      await this.asyncJobs.runNext();
    });
    runner.every(60 * 1000, 'async tidy', () => this.asyncJobs.tidy());
    // the queues, for the status page (jobStatus)
    runner.every(STATUS_MS, 'queue status', async () => {
      this.queueFigures = await queueStatus.measure(this);
    });
  }

  /**
   * The background work, for the status page: the queue runner's tasks, and the queues as last
   * measured; null in a process that doesn't run the jobs
   */
  jobStatus() {
    if (!this.runner) {
      return null;
    }
    return { path: this.path, tasks: this.runner.describe().filter(t => t.name !== 'queue status'), queues: this.queueFigures || null,
      maintenance: (this.maintenance && this.maintenance.row) || null };
  }

  /**
   * Reindex a batch of resources, while search parameters are marked for reindexing. Each
   * batch is its own transaction, so requests keep being served.
   * @returns {Promise<number>} how many resources were reindexed
   */
  async reindexBatch() {
    if ((!this.definitions.reindexing || this.definitions.reindexing.size === 0) && !this.reindexAll) {
      return 0;
    }
    const fromRow = await this.db.read(q => q.get('SELECT Value FROM Config WHERE Name = ?', ['reindexFrom']));
    const from = fromRow ? Number(fromRow.Value) : 0;
    const rows = await this.db.read(q => q.all(`SELECT ResourceKey FROM Ids WHERE ResourceKey > ? AND Deleted = 0 AND MostRecent IS NOT NULL ORDER BY ResourceKey LIMIT ${REINDEX_BATCH}`, [from]));
    const { decode } = require('../store');
    await this.db.write(async (q) => {
      for (const r of rows) {
        const v = await q.get('SELECT v.Compressed, v.Content FROM Ids i JOIN Versions v ON v.VersionKey = i.MostRecent WHERE i.ResourceKey = ? AND i.Deleted = 0', [r.ResourceKey]);
        const resource = v ? decode(v) : null;
        if (resource) {
          await this.indexer.index(q, { resourceKey: Number(r.ResourceKey), resource, deferChecks: true, lenient: true });
        }
      }
      if (rows.length) {
        const last = String(rows[rows.length - 1].ResourceKey);
        const u = await q.run('UPDATE Config SET Value = ? WHERE Name = ?', [last, 'reindexFrom']);
        if (!u.changes) {
          await q.run('INSERT INTO Config (Name, Value) VALUES (?, ?)', ['reindexFrom', last]);
        }
      } else {
        // done: clear the flags, and tell every process
        await q.run('UPDATE SearchParams SET Reindex = 0 WHERE Reindex = 1');
        await q.run('DELETE FROM Config WHERE Name = ?', ['reindexFrom']);
        await q.run('DELETE FROM Config WHERE Name = ?', ['reindexAll']);
        await settingsStore.bumpGeneration(q);
      }
    });
    if (!rows.length) {
      this.definitions.reindexing = new Set();
      this.reindexAll = false;
      this.log.info(`Rest ${this.path}: reindexing finished`);
    }
    return rows.length;
  }

  async close() {
    if (this.runner) {
      await this.runner.stop();
      this.runner = null;
    }
    if (this.auditTimer) {
      clearInterval(this.auditTimer);
    }
    if (this.terminology) {
      // what searches learned from the closure, still being written
      await this.terminology.settled();
    }
    try {
      await this.flushAudits();
    } catch (e) {
      this.log.error(`Rest ${this.path}: writing AuditEvents failed: ${e.message}`);
    }
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }
}

module.exports = { Endpoint, maintenanceError };
