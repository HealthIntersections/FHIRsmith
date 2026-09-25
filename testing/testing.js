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

const folders = require('../library/folder-setup');
const htmlServer = require('../library/html-server');
const { tokenMatches, tokenConfigured } = require('../library/request-token');
const packageJson = require('../package.json');
const { TestReportStore } = require('./store');
const { parseSearch, dateRange, capabilitySearchParams } = require('./search');
const { renderList, renderSummary, renderReport, listQueryToSearch } = require('./render');

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

    this.setupRoutes();
    this.setupRetention();
    this.log.info(`Testing module: ${this.store.count()} reports in ${dbPath}; ` +
      `posting ${tokenConfigured(this.config.token) ? 'requires a token' : 'is open'}, max ${this.maxSize} bytes`);
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

    r.get('/', (req, res) => this.handle(req, res, 'list', () => this.htmlList(req, res)));
    r.get('/summary', (req, res) => this.handle(req, res, 'summary', () => this.htmlSummary(req, res)));
    r.get('/metadata', (req, res) => this.handle(req, res, 'metadata', () => this.metadata(req, res)));
    r.post('/TestReport', ...posting, (req, res) => this.handle(req, res, 'create', () => this.create(req, res)));
    r.get('/TestReport', (req, res) => this.handle(req, res, 'search', () =>
      wantsHtml(req) ? this.htmlList(req, res) : this.search(req, res)));
    r.get('/TestReport/:id', (req, res) => this.handle(req, res, 'read', () => this.read(req, res)));
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
        renderReport(report, req.baseUrl), start);
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
      statuses: this.store.distinct('status'),
      results: this.store.distinct('result'),
      base: req.baseUrl
    });
    this.sendHtml(res, 'Test Reports', content, start);
  }

  async htmlSummary(req, res) {
    const start = Date.now();
    const by = req.query.by === 'tester' ? 'tester' : 'participant';
    this.sendHtml(res, 'Test Report Summary', renderSummary(this.store.summary(by), by, req.baseUrl, this.store.testerCounts()), start);
  }
}

module.exports = TestingModule;
module.exports.validateReport = validateReport;
