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
const { RestWeb, wantsHtml } = require('../web');

const GENERATION_CHECK_MS = 1000;
const AUDIT_FLUSH_MS = 1000;
const MAX_AUDIT_BUFFER = 5000;
const REINDEX_BATCH = 200;

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
   * @param {boolean} options.master - runs migrations and the background jobs
   * @param {Object} options.log - a logger (info, warn, error, debug)
   * @param {Object} [options.packageManager] - library/package-manager PackageManager
   * @param {string} [options.cacheFolder] - where derived definitions are cached
   * @param {Object} [options.derived] - definitions already derived (tests)
   * @param {Function} [options.app] - the express app, for a terminology server on this server
   * @param {function(Object): Promise<Object|null>} [options.principal] - who a request is
   * @param {string} [options.hostName]
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
    this.startedAt = Date.now();
    this.timers = [];
    this.auditBuffer = [];
    this.lastGenerationCheck = 0;
    this.generation = null;
    this.bundleReturnsResources = true;
    this.terminology = null;
  }

  // ---- start up and refresh ----

  async open() {
    const cfg = this.cfg;
    this.db = await openDatabase(cfg.database, { databasesDir: this.options.databasesDir, master: this.master, log: (m) => this.log.info(m) });
    // the FHIR version is fixed when the database is made
    const initial = { ...(cfg.initialSettings || {}) };
    if (cfg.fhirVersion) {
      initial.fhirVersion = cfg.fhirVersion;
    }
    if (this.master) {
      await settingsStore.seed(this.db, initial, []);
    }
    let loaded = await settingsStore.load(this.db);
    if (!loaded.endpoint.fhirVersion) {
      throw new Error(`The rest endpoint ${this.path} has no FHIR version: give fhirVersion in its configuration`);
    }
    if (cfg.fhirVersion && majorMinor(cfg.fhirVersion) !== majorMinor(loaded.endpoint.fhirVersion)) {
      throw new Error(`The rest endpoint ${this.path}'s database is FHIR ${loaded.endpoint.fhirVersion}, but the configuration says ${cfg.fhirVersion}`);
    }
    this.warnOverridden(cfg.initialSettings || {}, loaded.endpoint);
    await this.loadDefinitions(loaded.endpoint);
    if (this.master) {
      await settingsStore.seed(this.db, {}, [...this.definitions.resourceTypes], cfg.types || {});
    }
    await this.apply(await settingsStore.load(this.db));
    this.web = new RestWeb(this);
    if (this.master) {
      this.startJobs();
    }
    this.auditTimer = setInterval(() => {
      this.flushAudits().catch(e => this.log.error(`Rest ${this.path}: writing AuditEvents failed: ${e.message}`));
    }, AUDIT_FLUSH_MS);
    this.auditTimer.unref();
    loaded = null;
    this.log.info(`Rest endpoint ${this.path}: FHIR ${this.settings.fhirVersion}, ${this.typeKeys.size} types, ${this.definitions.byUrl.size} search parameters, ` +
      `${this.cfg.database.type} database${this.master ? '' : ' (worker)'}`);
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
    const changed = await defs.sync(this.db, this.master, hasResources);
    const reload = !!this.definitions;
    this.definitions = defs;
    if (reload && this.master && changed.added + changed.changed > 0) {
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
        this.terminology = new Terminology(this.settings.txServer, { app: this.options.app, log: this.log, closureName: await this.closureName() });
      } catch (e) {
        this.log.error(`Rest ${this.path}: txServer: ${e.message}`);
      }
    }
  }

  async closureName() {
    const row = await this.db.read(q => q.get('SELECT Name FROM Closures ORDER BY ClosureKey LIMIT 1'));
    return row ? row.Name : 'fhirsmith-rest-' + crypto.randomBytes(8).toString('hex');
  }

  /** Reload when the settings' generation has changed (at most once a second) */
  async refresh() {
    const now = Date.now();
    if (now - this.lastGenerationCheck < GENERATION_CHECK_MS) {
      return;
    }
    this.lastGenerationCheck = now;
    const g = await this.db.read(q => settingsStore.readGeneration(q));
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
    if (freq.interaction === 'operation') {
      try {
        return findOperation(freq).read ? 'operation-read' : 'operation';
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
    const list = this.auditBuffer.splice(0);
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
    r.use(express.text({ type: ['application/x-www-form-urlencoded'], limit }));
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

  baseFor(req) {
    return this.cfg.baseUrl || `${req.protocol}://${req.get('host')}${req.baseUrl}`;
  }

  async handle(req, res) {
    const start = Date.now();
    let freq = null;
    let interaction = 'unknown';
    try {
      await this.refresh();
      format.responseFormat(req);
      const principal = this.options.principal ? await this.options.principal(req) : null;
      const isPatch = req.method === 'PATCH';
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) && !(req.method === 'POST' && /\/_search\/?(\?|$)/.test(req.originalUrl))
        ? format.requestBody(req, { patch: isPatch }) : null;
      freq = request.fromHttp(req, body, principal, this.baseFor(req));
      interaction = freq.interaction;
      const acc = access.check(principal, this, this.accessInteraction(freq));
      if (wantsHtml(req)) {
        // a browser: the same interaction, as a page (web.js)
        await this.web.page(req, res, freq, acc, start);
        return;
      }
      const result = await this.dispatch(freq, { access: acc });
      if (this.auditing('all') && !result.write && freq.interaction !== 'bundle') {
        this.auditLater(freq, freq.interaction === 'operation' ? 'operation' : freq.interaction, result.status);
      }
      this.respond(req, res, freq, result);
    } catch (e) {
      if (!(e instanceof FhirError)) {
        this.log.error(`Rest ${this.path}: ${req.method} ${req.originalUrl} failed: ${e.stack || e.message}`);
      }
      const fe = e instanceof FhirError ? e : new FhirError(500, 'exception', 'Internal error');
      if (freq && this.settings && this.settings.audit !== 'off' && fe.status !== 401) {
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

  sendError(req, res, fe) {
    res.status(fe.status);
    for (const [k, v] of Object.entries(fe.headers || {})) {
      res.set(k, v);
    }
    if (fe.status === 401) {
      res.set('WWW-Authenticate', 'Bearer');
    }
    res.set('Content-Type', format.FHIR_JSON + '; charset=utf-8');
    res.send(format.serialise(req, fe.outcome()));
  }

  respond(req, res, freq, result) {
    res.status(result.status);
    for (const [k, v] of Object.entries(result.headers || {})) {
      res.set(k, v);
    }
    if (result.status === 304) {
      res.end();
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
    if (body === null || req.method === 'HEAD') {
      if (body !== null) {
        res.set('Content-Type', format.FHIR_JSON + '; charset=utf-8');
      }
      res.end();
      return;
    }
    res.set('Content-Type', format.FHIR_JSON + '; charset=utf-8');
    res.send(format.serialise(req, body));
  }

  // ---- background jobs (the master) ----

  startJobs() {
    const every = (ms, name, fn) => {
      let running = false;
      const t = setInterval(() => {
        if (running) {
          return;
        }
        running = true;
        fn().catch(e => this.log.error(`Rest ${this.path}: ${name} failed: ${e.message}`)).finally(() => {
          running = false;
        });
      }, ms);
      t.unref();
      this.timers.push(t);
    };
    every(5 * 60 * 1000, 'search cleanup', () => this.searcher.cleanup());
    every(5000, 'closure update', async () => {
      if (this.terminology) {
        await this.terminology.updateClosure(this);
      }
    });
    every(2000, 'reindexing', async () => {
      // the master notices new definitions (a custom SearchParameter) here, not only on requests
      await this.refresh();
      await this.reindexBatch();
    });
  }

  /**
   * Reindex a batch of resources, while search parameters are marked for reindexing. Each
   * batch is its own transaction, so requests keep being served.
   * @returns {Promise<number>} how many resources were reindexed
   */
  async reindexBatch() {
    if (!this.definitions.reindexing || this.definitions.reindexing.size === 0) {
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
          await this.indexer.index(q, { resourceKey: Number(r.ResourceKey), resource, deferChecks: true });
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
        await settingsStore.bumpGeneration(q);
      }
    });
    if (!rows.length) {
      this.definitions.reindexing = new Set();
      this.log.info(`Rest ${this.path}: reindexing finished`);
    }
    return rows.length;
  }

  async close() {
    for (const t of this.timers) {
      clearInterval(t);
    }
    this.timers = [];
    if (this.auditTimer) {
      clearInterval(this.auditTimer);
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

module.exports = { Endpoint };
