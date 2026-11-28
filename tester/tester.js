//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The /tester module: runs the FHIRsmith RESTful API tests (tester/suite) against a FHIR
 * server someone names, the npm registry protocol checks (tester/npm) against an npm
 * registry, or the HL7 terminology service tests (tester/tx, through the FHIR validator) against
 * a terminology server, and keeps the results.
 *
 *   GET  {base}                    the form (for someone logged in) and the runs; ?kind=npm: the form for a
 *                                  registry, ?kind=tx: for a terminology server
 *   POST {base}/run                start a run: kind (fhir, npm or tx), server, a bearer token (optional; not for
 *                                  tx), for a registry the package and version to test it with, and
 *                                  for a terminology server the modes (repeated)
 *   GET  {base}/runs/:id           a run: how it's going, and each test's result
 *   POST {base}/runs/:id/cancel    stop it (who asked for it, or an administrator)
 *   GET  {base}/runs/:id/tests/:n  a test: what it made to test with, and its requests and responses
 *   GET  {base}/runs/:id/report    the run's TestReport (JSON)
 *
 * Anyone logged in can start a run; everyone can see every run. One run happens at a time, in
 * the background (this process: under the cluster, the master, which serves everything but
 * the tx and rest modules' paths), and each person can have one run waiting or under way.
 * The server's address is checked as every outbound request from this server to an address
 * someone gave is (library/ssrf-guard.js): public addresses only, unless allowPrivateAddresses.
 *
 * At the end of a run its TestReport is sent to the repository configured (reportServer), as
 * utilities/submit-test-report.js sends the tx tests'.
 *
 * The npm registry checks are verified against the npm registry itself (npm.control) once a
 * day, in the background: npm is the reference, so a check that fails there is out of date,
 * and the pages say so.
 *
 * @module tester/tester
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const auth = require('../library/auth');
const folders = require('../library/folder-setup');
const htmlServer = require('../library/html-server');
const { isNonPublicAddress } = require('../library/ssrf-guard');
const packageJson = require('../package.json');
const { TesterStore } = require('./store');
const { TestRun } = require('./engine');
const { NpmRun, npmGetter } = require('./npm/run');
const { runNpmCheck } = require('./npm/checks');
const { TxRun, TX_MODES, TX_RUN_LIMIT_MS } = require('./tx/run');
const { PACKAGE_ID: TX_PACKAGE, txTestsSource } = require('../tx/tests/tx-tests-package');
const { testReport, upload } = require('./report');
const { suite, count } = require('./suite');
const { renderHome, renderRun, renderTest } = require('./render');

const TEMPLATE = 'tester';
const DAY_MS = 24 * 60 * 60 * 1000;
// runs are kept about 6 months; their step details (each test's requests and responses) 30 days
const DEFAULT_KEEP_DAYS = 183;
const DEFAULT_DETAIL_DAYS = 30;
const QUEUE_MS = 2000;
const PAGE_SIZE = 50;
const PACKAGE_SERVERS = ['https://packages2.fhir.org/packages', 'https://packages.fhir.org'];
const CORE_PACKAGES = { R4: 'hl7.fhir.r4.core#4.0.1', R5: 'hl7.fhir.r5.core#5.0.0' };
// the npm registry checks: defaults for modules.tester.npm
const NPM_DEFAULTS = {
  enabled: true,
  requestTimeout: 30000, // ms, per request
  maxDownloadMB: 50, // per response, so for the tarball
  // the npm registry itself, checked once a day so the pages can show the checks still hold
  control: { registry: 'https://registry.npmjs.org', package: 'fhirpath', version: '3.15.0' }
};
// the terminology tests: defaults for modules.tester.tx
const TX_DEFAULTS = {
  enabled: true,
  // the validator's port (the IPS and SHL modules' validators have their own)
  port: 8083,
  // stopped when no terminology run has wanted it for this long
  idleMinutes: 15,
  // the build of the tests (hl7.fhir.uv.tx-ecosystem)
  testsVersion: 'current'
};
// a package's name and version, as the packages module takes them
const PACKAGE_PATTERN = /^(@[a-z0-9._-]+\/)?[a-zA-Z0-9._-]{1,100}$/;
const VERSION_PATTERN = /^[a-zA-Z0-9._+-]{1,50}$/;

/** A terminology run's modes (a list) */
function modesOf(r) {
  try {
    const m = JSON.parse(r.Modes || '[]');
    return Array.isArray(m) ? m : [];
  } catch (e) {
    return [];
  }
}

/** What a run tests, for the log */
function describeRun(r) {
  if (r.Kind === 'npm') {
    return `the npm registry ${r.Server} (${r.Package}#${r.Version})`;
  }
  if (r.Kind === 'tx') {
    return `the terminology server ${r.Server} (modes ${modesOf(r).join(', ')})`;
  }
  return r.Server;
}

class TesterModule {
  /**
   * @param {Object} stats - a ModuleStats
   * @param {Object} [log]
   */
  constructor(stats, log) {
    this.stats = stats;
    this.router = express.Router();
    this.router.use(rateLimit(auth.credentialLimits()));
    if (log) {
      this.log = log;
    } else {
      const Logger = require('../library/logger');
      this.log = Logger.getInstance().child({ module: 'tester' });
    }
    this.store = null;
    this.current = null;
    this.timers = [];
  }

  /**
   * @param {Object} config - modules.tester
   * @param {Object} [options]
   * @param {function(string): Promise<Object>} [options.xmlModel] - the XML model for a FHIR version (tests)
   * @param {Object} [options.packageManager]
   * @param {number} [options.queueMs] - how often the queue is looked at (tests)
   * @param {boolean} [options.autoStart] - false: a run asked for waits for the queue's timer (tests)
   */
  async initialize(config, options = {}) {
    this.config = config || {};
    this.options = options;
    const db = this.config.database || 'tester.db';
    const file = db === ':memory:' || path.isAbsolute(db) ? db : path.join(folders.databasesDir(), db);
    this.store = new TesterStore(file);
    this.allowPrivate = this.config.allowPrivateAddresses === true;
    this.keepDays = Number(this.config.keepDays) > 0 ? Number(this.config.keepDays) : DEFAULT_KEEP_DAYS;
    this.detailDays = Number(this.config.detailDays) > 0 ? Number(this.config.detailDays) : DEFAULT_DETAIL_DAYS;
    this.repository = this.reportRepository();
    this.npm = this.npmConfig();
    this.npmControl = { report: null, running: false };
    this.tx = this.txConfig();
    this.txValidatorState = { validator: null, starting: null, idle: null };
    htmlServer.loadTemplate(TEMPLATE, path.join(__dirname, 'tester-template.html'));
    auth.defineModule('tester', { title: 'Test a FHIR server or npm registry', path: '/tester' });
    const lost = this.store.interrupted();
    if (lost) {
      this.log.warn(`Tester: ${lost} run(s) were under way when the server stopped: marked interrupted`);
    }
    this.setupRoutes();
    if (this.stats) {
      this.stats.addTask('Test runs', `one at a time, checked every ${(options.queueMs || QUEUE_MS) / 1000}s`);
      this.stats.addTask('Test run retention', 'daily');
    }
    const queue = setInterval(() => void this.next(), options.queueMs || QUEUE_MS);
    queue.unref();
    const purge = () => this.purge();
    purge();
    const daily = setInterval(purge, DAY_MS);
    daily.unref();
    this.timers.push(queue, daily);
    if (this.npm.enabled && this.npm.control) {
      if (this.stats) {
        this.stats.addTask('npm check control', `daily, against ${this.npm.control.registry}`);
      }
      this.refreshNpmControl();
      const control = setInterval(() => this.refreshNpmControl(), DAY_MS);
      control.unref();
      this.timers.push(control);
    }
    this.log.info(`Tester: ${this.store.count()} runs in ${file}; ${count()} tests; ` +
      `npm registry checks ${this.npm.enabled ? 'on' : 'off'}; terminology tests ${this.tx.enabled ? 'on' : `off${this.tx.why ? ' (' + this.tx.why + ')' : ''}`}; ${this.allowPrivate ? 'private addresses allowed' : 'public addresses only'}; reports ${this.repository ? 'sent to ' + this.repository.server : 'not sent anywhere'}`);
  }

  /** Where reports go (reportServer), with the token for it (from reportTokenEnv or reportTokenFile), or null */
  reportRepository() {
    const c = this.config;
    if (!c.reportServer) {
      return null;
    }
    let token = null;
    if (c.reportTokenEnv) {
      token = process.env[c.reportTokenEnv] || null;
      if (!token) {
        this.log.warn(`Tester: modules.tester.reportTokenEnv names ${c.reportTokenEnv}, which isn't set: reports are sent without a token`);
      }
    } else if (c.reportTokenFile) {
      const f = path.isAbsolute(c.reportTokenFile) ? c.reportTokenFile : path.join(folders.dataDir(), c.reportTokenFile);
      try {
        token = fs.readFileSync(f, 'utf8').trim() || null;
      } catch (e) {
        this.log.warn(`Tester: can't read modules.tester.reportTokenFile (${f}): ${e.message}: reports are sent without a token`);
      }
    }
    return { server: c.reportServer, token, header: c.reportTokenHeader || 'Authorization' };
  }

  /**
   * modules.tester.tx, with the defaults. Off when there's no Java to run the validator in (why
   * says so), unless the validator is given (options.txValidator: tests)
   */
  txConfig() {
    const c = { ...TX_DEFAULTS, ...(this.config.tx || {}) };
    c.enabled = c.enabled !== false;
    if (c.enabled && !this.options.txValidator) {
      const java = require('child_process').spawnSync('java', ['-version'], { stdio: 'ignore', timeout: 30000 });
      if (java.error || java.status !== 0) {
        c.enabled = false;
        c.why = 'there is no Java to run the FHIR validator in';
      }
    }
    return c;
  }

  /**
   * The FHIR validator the terminology runs use, started the first time one wants it, with its
   * terminology test endpoints. Its SSRF protection is on (https only, public addresses only,
   * checked as it connects, redirects included) unless allowPrivateAddresses: the validator,
   * not this module, makes the requests to the server tested.
   */
  async txValidator() {
    const st = this.txValidatorState;
    if (st.idle) {
      clearTimeout(st.idle);
      st.idle = null;
    }
    if (this.options.txValidator) {
      return typeof this.options.txValidator === 'function' ? this.options.txValidator() : this.options.txValidator;
    }
    if (st.validator) {
      return st.validator;
    }
    if (!st.starting) {
      const FhirValidator = require('fhir-validator-wrapper');
      const localJar = typeof this.tx.jar === 'string' && this.tx.jar.trim() ? (path.isAbsolute(this.tx.jar) ? this.tx.jar : folders.filePath(this.tx.jar)) : null;
      const validator = new FhirValidator(localJar || folders.filePath('bin', 'validator_cli.jar'), this.log);
      this.log.info(`Tester: starting the FHIR validator for the terminology tests, on port ${this.tx.port}`);
      st.starting = validator.start({
        version: '4.0.1',
        txServer: 'n/a',
        txLog: folders.filePath('logs', 'tester-validator-tx.log'),
        port: this.tx.port,
        timeout: this.tx.timeout || 120000,
        txTests: true,
        ssrfProtection: !this.allowPrivate,
        autoDownload: !localJar,
        skipUpdateCheck: !!localJar
      }).then(() => {
        st.validator = validator;
        this.log.info(`Tester: the FHIR validator is running (${validator.jarVersion()})`);
        return validator;
      }).finally(() => {
        st.starting = null;
      });
    }
    return st.starting;
  }

  /** The validator isn't wanted any more: stopped once it has been idle for idleMinutes */
  txIdle() {
    const st = this.txValidatorState;
    if (!st.validator || this.options.txValidator) {
      return;
    }
    if (st.idle) {
      clearTimeout(st.idle);
    }
    st.idle = setTimeout(() => void this.stopTxValidator(), (this.tx.idleMinutes || 15) * 60 * 1000);
    st.idle.unref();
  }

  async stopTxValidator() {
    const st = this.txValidatorState;
    st.idle = null;
    const v = st.validator;
    st.validator = null;
    if (v) {
      this.log.info('Tester: stopping the FHIR validator (no terminology runs for a while)');
      try {
        await v.stop();
      } catch (e) {
        this.log.warn(`Tester: stopping the FHIR validator: ${e.message}`);
      }
    }
  }

  /** The terminology tests: the package's tests folder, test-cases.json, its externals and its version */
  async txTests() {
    if (this.options.txTests) {
      return this.options.txTests();
    }
    const { PackageManager } = require('../library/package-manager');
    const cacheFolder = folders.subDir('terminology-cache');
    const packageManager = this.options.packageManager || new PackageManager(this.config.packageServers || PACKAGE_SERVERS, cacheFolder);
    const where = await packageManager.fetch(TX_PACKAGE, this.tx.testsVersion);
    const pkg = path.join(cacheFolder, where, 'package');
    const folder = path.join(pkg, 'tests');
    const read = (f) => JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8'));
    return { folder, testCases: read('test-cases.json'), externals: read('messages-tx.fhir.org.json'),
      version: JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version };
  }

  /** modules.tester.npm, with the defaults: control null when it's off */
  npmConfig() {
    const c = this.config.npm || {};
    const control = c.control === false ? null : { ...NPM_DEFAULTS.control, ...(typeof c.control === 'object' ? c.control : {}) };
    return { ...NPM_DEFAULTS, ...c, enabled: c.enabled !== false, control };
  }

  /** Run the npm checks against the npm registry itself, in the background */
  refreshNpmControl() {
    const control = this.npm.control;
    if (!control || this.npmControl.running) {
      return;
    }
    this.npmControl.running = true;
    runNpmCheck({ registry: control.registry, pkg: control.package, version: control.version },
      npmGetter({ requestTimeout: this.npm.requestTimeout, maxDownloadMB: this.npm.maxDownloadMB }))
      .then(report => {
        this.npmControl.report = report;
        if (report.failed > 0) {
          this.log.warn(`Tester: ${report.failed} npm registry checks fail against the control ${control.registry}: they may be out of date`);
        }
        if (this.stats) {
          this.stats.taskDone('npm check control', `${report.passed} passed, ${report.failed} failed`);
        }
      })
      .catch(e => this.log.error(`Tester: the npm check control run failed: ${e.message}`))
      .finally(() => {
        this.npmControl.running = false;
      });
  }

  async shutdown() {
    await this.stopTxValidator();
    for (const t of this.timers) {
      clearInterval(t);
    }
    this.timers = [];
    if (this.current) {
      this.current.run.cancel('The server is stopping');
      try {
        await Promise.race([this.current.done, new Promise(resolve => setTimeout(resolve, 5000))]);
      } catch (e) {
        // it ends as it ends
      }
    }
    if (this.store) {
      this.store.close();
      this.store = null;
    }
  }

  purge() {
    try {
      const now = Date.now();
      const n = this.store.purgeBefore(now - this.keepDays * DAY_MS);
      if (n) {
        this.log.info(`Tester: deleted ${n} runs older than ${this.keepDays} days`);
      }
      const d = this.store.clearDetailsBefore(now - this.detailDays * DAY_MS, now);
      if (d) {
        this.log.info(`Tester: cleared the step details of ${d} runs older than ${this.detailDays} days`);
      }
      if (this.stats) {
        this.stats.taskDone('Test run retention', `${n} deleted, ${d} cleared of step details`);
      }
    } catch (e) {
      this.log.error(`Tester: deleting old runs failed: ${e.message}`);
    }
  }

  // ---- the queue ----

  /** Start the next run, if none is running */
  next() {
    if (this.current || !this.store) {
      return null;
    }
    const r = this.store.nextQueued();
    if (!r) {
      return null;
    }
    const common = {
      id: r.Id,
      base: r.Server,
      token: r.Token,
      allowPrivate: this.allowPrivate,
      onResult: (x) => this.store && this.store.addResult(r.Id, run.results.length, x),
      onStatus: (text) => this.store && this.store.progress(r.Id, text)
    };
    const run = r.Kind === 'npm'
      ? new NpmRun({ ...common, pkg: r.Package, version: r.Version, requestTimeout: this.npm.requestTimeout, maxDownloadMB: this.npm.maxDownloadMB })
      : r.Kind === 'tx'
        ? new TxRun({ ...common, modes: modesOf(r), validator: () => this.txValidator(), tests: () => this.txTests(), testsVersion: this.tx.testsVersion,
          tester: this.tester(), limitMs: this.tx.limitMinutes ? this.tx.limitMinutes * 60000 : TX_RUN_LIMIT_MS })
        : new TestRun({ ...common, xmlModel: (v) => this.xmlModel(v) });
    this.store.started(r.Id);
    this.log.info(`Tester: run ${r.Id} of ${describeRun(r)} started`);
    const watch = setInterval(() => {
      if (this.store && this.store.cancelAsked(r.Id)) {
        run.cancel('The run was cancelled');
      }
    }, 1000);
    watch.unref();
    const done = this.runOne(r, run).catch(e => {
      this.log.error(`Tester: run ${r.Id} failed: ${e.stack || e.message}`);
      if (this.store) {
        this.store.finished(r.Id, { status: 'error', message: `The run failed: ${e.message}` });
      }
    }).finally(() => {
      clearInterval(watch);
      this.current = null;
      // straight on to the next
      if (this.options.autoStart !== false) {
        setImmediate(() => void this.next());
      }
    });
    this.current = { id: r.Id, run, done };
    return done;
  }

  async runOne(r, run) {
    let out;
    try {
      out = await run.run();
    } finally {
      if (r.Kind === 'tx') {
        this.txIdle();
      }
    }
    if (!this.store) {
      return;
    }
    const about = out.cap || out.server;
    if (about && (about.fhirVersion || about.software)) {
      this.store.server(r.Id, { fhirVersion: about.fhirVersion, software: about.software });
    }
    const status = out.outcome === 'completed' ? 'completed' : out.outcome === 'cancelled' ? 'cancelled' : 'error';
    const npm = r.Kind === 'npm';
    const tx = r.Kind === 'tx';
    let engineVersion = null;
    if (tx) {
      // (the validator that ran it, if it started)
      const v = this.options.txValidator ? (typeof this.options.txValidator === 'function' ? null : this.options.txValidator) : this.txValidatorState.validator;
      try {
        engineVersion = v && v.jarVersion ? v.jarVersion() : null;
      } catch (e) {
        engineVersion = null;
      }
    }
    const report = out.cap || npm || (tx && out.server && out.server.testsVersion) ? testReport({ id: r.Id, server: r.Server, status, message: out.message,
      software: about ? about.software : null, fhirVersion: about ? about.fhirVersion : null, finished: Date.now(), results: out.results, tester: this.tester(),
      kind: r.Kind, pkg: r.Package, version: r.Version, modes: modesOf(r), testsVersion: out.server && out.server.testsVersion,
      testsSource: txTestsSource(this.tx.testsVersion), engineVersion }) : null;
    this.store.finished(r.Id, { status, message: out.message, cleanup: out.cleanup, report });
    const c = out.results.reduce((a, x) => ({ ...a, [x.outcome]: (a[x.outcome] || 0) + 1 }), {});
    this.log.info(`Tester: run ${r.Id} of ${describeRun(r)}: ${status}${out.message ? ' (' + out.message + ')' : ''}; ` +
      `${c.pass || 0} pass, ${c.fail || 0} fail, ${c.warning || 0} warning, ${c.skip || 0} skip, ${c.error || 0} error`);
    if (this.stats) {
      this.stats.taskDone('Test runs', `${r.Server}: ${status}`);
    }
    if (report && this.repository && status === 'completed') {
      try {
        const where = await upload(report, this.repository);
        this.store.uploaded(r.Id, where, null);
      } catch (e) {
        this.log.warn(`Tester: sending run ${r.Id}'s report failed: ${e.message}`);
        this.store.uploaded(r.Id, null, e.message);
      }
    }
  }

  /** Who the tester is, in reports: this server */
  tester() {
    return this.options.hostName ? `FHIRsmith tester (${this.options.hostName})` : 'FHIRsmith tester';
  }

  /** The XML model for a FHIR version, from its core package (kept in the cache folder) */
  async xmlModel(fhirVersion) {
    if (this.options.xmlModel) {
      return this.options.xmlModel(fhirVersion);
    }
    const release = /^4\.0/.test(fhirVersion) ? 'R4' : /^5\.0/.test(fhirVersion) ? 'R5' : null;
    if (!release) {
      return null;
    }
    this.models = this.models || new Map();
    if (!this.models.has(release)) {
      const { loadXmlModel } = require('../library/fhir-model');
      const packageManager = this.options.packageManager || (this.packageManager = this.packageManager ||
        new (require('../library/package-manager').PackageManager)(this.config.packageServers || PACKAGE_SERVERS, folders.subDir('terminology-cache')));
      this.models.set(release, loadXmlModel({ corePackage: CORE_PACKAGES[release], packageManager, cacheFolder: folders.subDir('tester') })
        .catch(e => {
          this.models.delete(release);
          throw e;
        }));
    }
    return this.models.get(release);
  }

  // ---- pages ----

  setupRoutes() {
    const r = this.router;
    const post = [auth.sameOrigin, auth.session, auth.form, auth.csrf];
    r.get('/', ...auth.web, (req, res) => this.handle(req, res, 'home', () => this.home(req, res)));
    r.post('/run', ...post, (req, res) => this.handle(req, res, 'run', () => this.start(req, res)));
    r.get('/runs/:id', ...auth.web, (req, res) => this.handle(req, res, 'results', () => this.results(req, res)));
    r.post('/runs/:id/cancel', ...post, (req, res) => this.handle(req, res, 'cancel', () => this.cancel(req, res)));
    r.get('/runs/:id/tests/:seq', ...auth.web, (req, res) => this.handle(req, res, 'test', () => this.test(req, res)));
    r.get('/runs/:id/report', (req, res) => this.handle(req, res, 'report', () => this.report(req, res)));
  }

  async handle(req, res, name, fn) {
    const start = Date.now();
    try {
      await fn(start);
    } catch (e) {
      if (e.status) {
        this.sendError(res, e.status, e.message);
      } else {
        this.log.error(`Tester: ${name} failed: ${e.stack || e.message}`);
        if (!res.headersSent) {
          this.sendError(res, 500, 'Internal error');
        }
      }
    } finally {
      if (this.stats) {
        this.stats.countRequest(name, Date.now() - start);
      }
    }
  }

  sendError(res, status, message) {
    htmlServer.sendErrorResponse(res, TEMPLATE, new Error(message), status);
  }

  sendHtml(res, title, content, start) {
    htmlServer.sendHtmlResponse(res, TEMPLATE, title, content, { version: packageJson.version, processingTime: Date.now() - start });
  }

  async home(req, res) {
    const start = Date.now();
    const user = auth.currentUser(req);
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const active = user ? this.store.activeFor(user.id) : null;
    const kind = req.query.kind === 'npm' && this.npm.enabled ? 'npm' : req.query.kind === 'tx' && this.tx.enabled ? 'tx' : 'fhir';
    const text = (v) => (typeof v === 'string' ? v.substring(0, 2000) : '');
    const html = renderHome({
      base: req.baseUrl, runs: this.store.list(page * PAGE_SIZE, PAGE_SIZE), total: this.store.count(), page, pageSize: PAGE_SIZE,
      user, csrf: res.locals && res.locals._csrf, active: active && active.Id, loginUrl: auth.loginUrl(req),
      testCount: count(), groups: suite().map(g => g.name), reportServer: this.repository ? this.repository.server : null,
      kind, npmEnabled: this.npm.enabled, values: { server: text(req.query.server), package: text(req.query.package), version: text(req.query.version) },
      control: this.npm.control, controlReport: this.npmControl.report,
      txEnabled: this.tx.enabled, txModes: TX_MODES, txTestsVersion: this.tx.testsVersion, allowPrivate: this.allowPrivate
    });
    this.sendHtml(res, kind === 'npm' ? 'Test an npm registry' : kind === 'tx' ? 'Test a terminology server' : 'Test a FHIR server', html, start);
  }

  async start(req, res) {
    const user = auth.currentUser(req);
    if (!user) {
      return res.redirect(auth.loginUrl(req, req.baseUrl));
    }
    const body = req.body || {};
    const kind = ['npm', 'tx'].includes(body.kind) ? body.kind : 'fhir';
    const server = String(body.server || '').trim();
    const token = kind === 'tx' ? '' : String(body.token || '').trim();
    let pkg = null;
    let version = null;
    let modes = null;
    if (kind === 'tx') {
      if (!this.tx.enabled) {
        throw httpError(404, 'The terminology tests aren\'t enabled on this server');
      }
      const asked = (Array.isArray(body.modes) ? body.modes : [body.modes]).filter(m => typeof m === 'string');
      modes = TX_MODES.map(m => m.code).filter(c => asked.includes(c));
      if (!modes.length) {
        throw httpError(400, 'Choose at least one mode to run the tests in');
      }
      if (!this.allowPrivate && !/^https:/i.test(server)) {
        throw httpError(400, 'A terminology server\'s address must be https: (the validator, which runs the tests, only connects to public https servers)');
      }
    }
    if (kind === 'npm') {
      if (!this.npm.enabled) {
        throw httpError(404, 'The npm registry checks aren\'t enabled on this server');
      }
      pkg = String(body.package || '').trim();
      version = String(body.version || '').trim();
      if (!PACKAGE_PATTERN.test(pkg)) {
        throw httpError(400, 'Give the name of a package the registry has (such as hl7.fhir.r4.core)');
      }
      if (!VERSION_PATTERN.test(version)) {
        throw httpError(400, 'Give a version of the package the registry has (such as 4.0.1)');
      }
    }
    const problem = await this.checkServer(server);
    if (problem) {
      throw httpError(400, problem);
    }
    if (token.length > 8000 || /[\r\n]/.test(token)) {
      throw httpError(400, 'That isn\'t a bearer token');
    }
    if (this.store.activeFor(user.id)) {
      throw httpError(409, 'You have a run waiting or under way already: you can start another when it\'s over');
    }
    const id = crypto.randomUUID();
    const name = String(user.login || user.name || user.id).substring(0, 128);
    this.store.queue({ id, server: server.replace(/\/+$/, ''), token: token || null, userId: user.id, userName: name, kind, pkg, version, modes });
    this.log.info(`Tester: ${name} asked for a run of ${describeRun({ Kind: kind, Server: server, Package: pkg, Version: version, Modes: modes && JSON.stringify(modes) })} (${id})`);
    if (this.options.autoStart !== false) {
      setImmediate(() => void this.next());
    }
    res.redirect(303, `${req.baseUrl}/runs/${id}`);
  }

  /** What's wrong with a server's address, or null: http(s), no credentials, and (unless allowed) public */
  async checkServer(server) {
    let u;
    try {
      u = new URL(server);
    } catch (e) {
      return 'That isn\'t a URL';
    }
    if (!['http:', 'https:'].includes(u.protocol)) {
      return 'The server\'s address must be http: or https:';
    }
    if (u.username || u.password) {
      return 'The server\'s address can\'t have a user name or password in it: use the bearer token';
    }
    if (u.hash || u.search) {
      return 'The server\'s address is its base: no query or fragment';
    }
    if (server.length > 2000) {
      return 'The server\'s address is too long';
    }
    if (this.allowPrivate) {
      return null;
    }
    const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
    let addresses;
    try {
      addresses = net.isIP(host) ? [host] : (await dns.promises.lookup(host, { all: true })).map(a => a.address);
    } catch (e) {
      return `The server's name (${host}) can't be found`;
    }
    if (addresses.some(a => isNonPublicAddress(a))) {
      return 'The server\'s address isn\'t a public one: this server only tests public servers';
    }
    return null;
  }

  async results(req, res) {
    const start = Date.now();
    const run = this.store.get(req.params.id);
    if (!run) {
      throw httpError(404, 'There is no such run');
    }
    const user = auth.currentUser(req);
    const queued = this.store.queuedIds();
    const html = renderRun({
      base: req.baseUrl, run, results: this.store.results(run.Id), place: queued.indexOf(run.Id) + 1,
      canCancel: !!(user && (user.isAdmin || user.id === run.UserId)), csrf: res.locals && res.locals._csrf,
      control: this.npm.control, controlReport: this.npmControl.report
    });
    this.sendHtml(res, `Test run of ${run.Kind === 'npm' ? 'the npm registry ' : run.Kind === 'tx' ? 'the terminology server ' : ''}${run.Server}`, html, start);
  }

  async test(req, res) {
    const start = Date.now();
    const run = this.store.get(req.params.id);
    const result = run && /^\d{1,5}$/.test(req.params.seq) ? this.store.result(run.Id, Number(req.params.seq)) : null;
    if (!result) {
      throw httpError(404, run ? 'There is no such test in the run' : 'There is no such run');
    }
    this.sendHtml(res, result.Name, renderTest({ base: req.baseUrl, run, result, detailDays: this.detailDays }), start);
  }

  async cancel(req, res) {
    const user = auth.currentUser(req);
    const run = this.store.get(req.params.id);
    if (!run) {
      throw httpError(404, 'There is no such run');
    }
    if (!user || !(user.isAdmin || user.id === run.UserId)) {
      throw httpError(403, 'Only who asked for the run, or an administrator, can cancel it');
    }
    if (this.store.cancel(run.Id)) {
      this.log.info(`Tester: run ${run.Id} cancelled by ${user.login || user.id}`);
      if (this.current && this.current.id === run.Id) {
        this.current.run.cancel('The run was cancelled');
      }
    }
    res.redirect(303, `${req.baseUrl}/runs/${run.Id}`);
  }

  async report(req, res) {
    const run = this.store.get(req.params.id);
    if (!run || !run.Report) {
      throw httpError(404, run ? 'The run has no report (yet)' : 'There is no such run');
    }
    res.status(200).set('Content-Type', 'application/fhir+json; charset=utf-8')
      .set('Content-Disposition', `inline; filename="testreport-${run.Id}.json"`).send(run.Report);
  }

  /** For the server's daily report */
  dailyReport({ since, now }) {
    if (!this.store) {
      return 'The tester\'s database is not open.';
    }
    const n = this.store.db.prepare('SELECT COUNT(*) AS N FROM Runs WHERE Requested >= ? AND Requested < ?').get(since, now).N;
    return `${n} test run${n === 1 ? ' was' : 's were'} asked for; ${this.store.count()} ${this.store.count() === 1 ? 'is' : 'are'} kept.`;
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = TesterModule;
