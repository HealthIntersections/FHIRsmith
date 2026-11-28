//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * A run of the npm registry protocol checks (tester/npm/checks.js) against a registry, as the
 * tester module's queue runs it: the same shape of run as tester/engine.js's TestRun, so the
 * module keeps, shows and reports both alike.
 *
 * Each check is a test, in a group for its step (search, package document, version document,
 * tarball, signatures), and its exchanges are the requests it was based on. Nothing is made
 * on the registry, so there is nothing to clean up.
 *
 * @module tester/npm/run
 */

const crypto = require('crypto');
const { createGuardedAgents } = require('../../library/ssrf-guard');
const { runNpmCheck, makeGetter, STEPS } = require('./checks');

// the most a run takes
const NPM_RUN_LIMIT_MS = 5 * 60 * 1000;
const DEFAULTS = { requestTimeout: 30000, maxDownloadMB: 50 };
const USER_AGENT = 'FHIRsmith npm registry check (+https://github.com/HealthIntersections/FHIRsmith)';

/** The SSRF-guarded getter the checks use */
function npmGetter({ allowPrivate = false, requestTimeout, maxDownloadMB, signal, token, registry } = {}) {
  return makeGetter({
    ...createGuardedAgents({ allowPrivate }),
    timeout: requestTimeout || DEFAULTS.requestTimeout,
    maxBytes: (maxDownloadMB || DEFAULTS.maxDownloadMB) * 1024 * 1024,
    userAgent: USER_AGENT,
    signal,
    token,
    tokenOrigin: token && registry ? new URL(registry).origin : null
  });
}

/** A request the checks made, as an exchange (as tester/client.js records them) */
function exchange(req) {
  const response = req.error ? { error: req.error, ms: req.ms } : { status: req.status, headers: req.headers || {}, body: req.body, ms: req.ms };
  return { phase: 'test', request: { method: 'GET', url: req.url, headers: req.accept ? { accept: req.accept } : {} }, response };
}

class NpmRun {
  /**
   * @param {Object} options
   * @param {string} options.base - the registry's base URL
   * @param {string} options.pkg - the package
   * @param {string} options.version - a version of it the registry has
   * @param {string} [options.token] - a bearer token, sent only to the registry's origin
   * @param {string} [options.id]
   * @param {boolean} [options.allowPrivate]
   * @param {number} [options.requestTimeout] - ms
   * @param {number} [options.maxDownloadMB]
   * @param {function(Object): void} [options.onResult]
   * @param {function(string): void} [options.onStatus]
   * @param {number} [options.limitMs]
   */
  constructor(options) {
    this.options = options;
    this.id = options.id || crypto.randomUUID();
    this.results = [];
    this.controller = new AbortController();
  }

  cancel(reason = 'The run was cancelled') {
    if (!this.controller.signal.aborted) {
      this.stopReason = reason;
      this.controller.abort(new Error(reason));
    }
  }

  status(text) {
    if (this.options.onStatus) {
      this.options.onStatus(text);
    }
  }

  /**
   * @returns {Promise<{outcome: string, message: string|null, cap: null, results: Object[], cleanup: null, report: Object}>}
   */
  async run() {
    const o = this.options;
    const limitMs = o.limitMs || NPM_RUN_LIMIT_MS;
    const timer = setTimeout(() => this.cancel(`The run took more than ${Math.round(limitMs / 60000)} minutes`), limitMs);
    timer.unref();
    this.started = new Date();
    try {
      const get = npmGetter({ allowPrivate: o.allowPrivate, requestTimeout: o.requestTimeout, maxDownloadMB: o.maxDownloadMB,
        signal: this.controller.signal, token: o.token, registry: o.base });
      const report = await runNpmCheck({ registry: o.base, pkg: o.pkg, version: o.version }, get, { detail: true, onStatus: (t) => this.status(t) });
      const at = report.finished;
      for (const step of report.steps) {
        for (const c of step.checks) {
          const result = {
            group: `${step.title}: ${step.request}`,
            name: c.title,
            outcome: c.status === 'pass' ? 'pass' : 'fail',
            message: c.message || null,
            ms: 0,
            start: report.started,
            end: at,
            exchanges: [...new Set(c.uses)].filter(u => report.requests[u]).map(u => exchange(report.requests[u])),
            resources: []
          };
          if (this.controller.signal.aborted && result.outcome === 'fail') {
            result.outcome = 'error';
            result.message = `Not finished: ${this.stopReason}`;
          }
          this.results.push(result);
          if (o.onResult) {
            o.onResult(result);
          }
        }
      }
      const stopped = this.controller.signal.aborted;
      return { outcome: stopped ? 'cancelled' : 'completed', message: stopped ? this.stopReason : null, cap: null, results: this.results, cleanup: null,
        report, started: this.started, finished: new Date() };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { NpmRun, npmGetter, NPM_RUN_LIMIT_MS, STEPS };
