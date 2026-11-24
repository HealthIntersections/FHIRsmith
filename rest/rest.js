//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The rest module: database-backed FHIR RESTful servers (see rest/README.md).
 *
 * modules.rest.endpoints lists the endpoints. config.json says only where each one is and
 * which database it uses; everything else about an endpoint is in its own database (see
 * endpoint/settings.js):
 *
 *   "rest": {
 *     "enabled": true,
 *     "endpoints": [
 *       { "path": "/fhir/r4", "fhirVersion": "4.0.1",
 *         "database": { "type": "sqlite", "file": "rest/r4.db" } },
 *       { "path": "/fhir/r5", "fhirVersion": "5.0.0",
 *         "database": { "type": "mysql", "host": "localhost", "database": "fhir_r5",
 *                       "user": "fhirsmith", "passwordEnv": "FHIR_R5_DB_PASSWORD" } }
 *     ]
 *   }
 *
 * Like the tx module, it mounts each endpoint on the app at its path, and runs under the
 * cluster: every process serves requests; only the master migrates the schema and runs the
 * background jobs.
 *
 * @module rest/rest
 */

const rateLimit = require('express-rate-limit');
const { RestAdmin, VALUESETS } = require('./admin');
const auth = require('../library/auth');
const folders = require('../library/folder-setup');
const { PackageManager } = require('../library/package-manager');
const { Endpoint } = require('./endpoint/endpoint');
const { MODULE, READ, WRITE, MANAGE } = require('./access');

const PACKAGE_SERVERS = ['https://packages2.fhir.org/packages', 'https://packages.fhir.org'];

class RestModule {
  /**
   * @param {Object} [stats] - a ModuleStats
   * @param {Object} [log]
   */
  constructor(stats, log) {
    this.stats = stats || null;
    this.endpoints = [];
    if (log) {
      this.log = log;
    } else {
      const Logger = require('../library/logger');
      this.log = Logger.getInstance().child({ module: 'rest' });
    }
  }

  /**
   * @param {Object} config - modules.rest
   * @param {Function} app - the express app: each endpoint is mounted at its path
   * @param {Object} [options] - { hostName, master (default true), maxBody, derived (tests),
   *   principal (tests: who a request is) }
   */
  async initialize(config, app, options = {}) {
    this.config = config || {};
    const list = Array.isArray(this.config.endpoints) ? this.config.endpoints : [];
    if (!list.length) {
      this.log.warn('Rest module: no endpoints configured (modules.rest.endpoints)');
    }
    const paths = new Set();
    for (const e of list) {
      const p = String(e.path || '').replace(/\/+$/, '');
      if (paths.has(p)) {
        throw new Error(`Rest module: two endpoints have the path ${p}`);
      }
      paths.add(p);
    }
    const files = new Set();
    for (const e of list) {
      const key = e.database && (e.database.type === 'sqlite' ? 'sqlite:' + e.database.file : `mysql:${e.database.host || 'localhost'}:${e.database.port || 3306}/${e.database.database}`);
      if (key && files.has(key)) {
        throw new Error(`Rest module: two endpoints use the same database (${key}): each endpoint needs its own`);
      }
      files.add(key);
    }
    auth.defineRoles(MODULE, [
      { role: READ, label: 'Read', description: 'read, vread, search and history on the endpoint', scope: { label: 'Endpoint', values: () => this.scopeValues() } },
      { role: WRITE, label: 'Write', description: 'create, update, patch, delete, batch and transaction on the endpoint (and read)', scope: { label: 'Endpoint', values: () => this.scopeValues() } },
      { role: MANAGE, label: 'Manage', description: 'the endpoint\'s settings, types, custom search parameters and reindexing', scope: { label: 'Endpoint', values: () => this.scopeValues() } }
    ], { title: 'FHIR REST', path: list.length ? list[0].path : '/' });

    // the package cache is the tx module's: the core packages are often there already
    const packageManager = options.derived ? null : new PackageManager(this.config.packageServers || PACKAGE_SERVERS, folders.subDir('terminology-cache'));
    for (const e of list) {
      const ep = new Endpoint(e, {
        databasesDir: folders.databasesDir(),
        master: options.master !== false,
        log: this.log,
        packageManager,
        cacheFolder: options.derived ? null : folders.subDir('rest'),
        derived: options.derived ? options.derived(e) : null,
        app,
        hostName: options.hostName,
        maxBody: options.maxBody,
        stats: this.stats,
        principal: options.principal || ((req) => auth.principal(req))
      });
      await ep.open();
      const router = require('express').Router();
      router.use(rateLimit(auth.credentialLimits()));
      // the administration pages (the manage role), then the FHIR API
      router.use(new RestAdmin(ep).router());
      router.use(ep.router());
      auth.addAdminPage(MODULE, { label: `Value sets for searching (${ep.path})`, path: `${ep.path}${VALUESETS}`,
        description: 'value sets too big to expand, searched by membership' });
      app.use(ep.path, router);
      this.endpoints.push(ep);
    }
  }

  scopeValues() {
    return this.endpoints.map(ep => ({ value: ep.path, label: `${ep.path} (${ep.settings ? ep.settings.name : ''})` }));
  }

  /** The paths of the endpoints (for the cluster's routing) */
  paths() {
    return this.endpoints.map(ep => ep.path);
  }

  getStatus() {
    return { enabled: true, endpoints: this.endpoints.map(ep => ({ path: ep.path, fhirVersion: ep.settings && ep.settings.fhirVersion, database: ep.cfg.database.type })) };
  }

  async shutdown() {
    for (const ep of this.endpoints) {
      try {
        await ep.close();
      } catch (e) {
        this.log.error(`Rest module: closing ${ep.path}: ${e.message}`);
      }
    }
    this.endpoints = [];
  }
}

module.exports = RestModule;
