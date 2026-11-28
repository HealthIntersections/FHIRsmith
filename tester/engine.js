//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Running the test suite (tester/suite) against a server: the same for the web pages (the
 * module's queue: tester/tester.js) and for jest (tests/tester/suite.test.js).
 *
 * The server's CapabilityStatement decides what runs: a test that needs something the server
 * doesn't say it supports isn't run, and its outcome says why. Only R4 and R5 servers are
 * tested, in JSON, and in XML too when the server says it does XML.
 *
 * The server already has data, and other clients may be using it, so everything a run creates
 * is marked as the run's (a tag with the run's id), and as the test's (a second tag, and an
 * identifier system, of the test's own), and every search the tests check is limited to the
 * test's own resources (by _tag, or by identifier when the server doesn't list _tag). At the
 * end what the run created is deleted, and expunged when the server has $expunge.
 *
 * Outcomes (as TestReport's): pass; fail (the server didn't do what the specification
 * requires); warning (it did, but not as the specification recommends); skip (not run, and
 * why); error (the test couldn't be completed: no answer, say).
 *
 * @module tester/engine
 */

const crypto = require('crypto');
const { FhirClient, ClientError } = require('./client');
const { Capabilities } = require('./capabilities');
const { suite } = require('./suite');

// the most a run takes, and the time cleaning up gets after that
const RUN_LIMIT_MS = 15 * 60 * 1000;
const CLEANUP_LIMIT_MS = 2 * 60 * 1000;

const TAG_SYSTEM = 'https://github.com/HealthIntersections/FHIRsmith/tester';
// the tag that marks what one test made, to limit its searches to them
const TEST_TAG_SYSTEM = TAG_SYSTEM + '/test';

class Failed extends Error {}
class Skipped extends Error {}

/** A short account of an OperationOutcome in a response, for a message */
function outcomeText(res) {
  const r = res && res.resource;
  if (r && r.resourceType === 'OperationOutcome' && Array.isArray(r.issue)) {
    const t = r.issue.map(i => (i.details && i.details.text) || i.diagnostics || i.code).filter(Boolean).join('; ');
    return t ? `: ${t.substring(0, 300)}` : '';
  }
  return '';
}

/** The id at the end of a Location header ([base]/Type/id/_history/v) */
function idFromLocation(location, type) {
  const m = new RegExp(`(?:^|/)${type}/([A-Za-z0-9\\-.]{1,64})(?:/_history/([^/?]+))?(?:[/?]|$)`).exec(String(location || ''));
  return m ? { id: m[1], version: m[2] || null } : null;
}

/**
 * What a test gets: the client, the capabilities, the run's marks, and the checks.
 */
class TestContext {
  constructor(run, test, index) {
    this.run = run;
    this.test = test;
    this.code = `${run.id}.${index}`;
    this.testTag = { system: TEST_TAG_SYSTEM, code: this.code };
    this.identifierSystem = `${TAG_SYSTEM}/${run.id}/${index}`;
    this.client = run.client;
    this.cap = run.cap;
    this.release = run.cap.release;
    // the server's address as it knows itself (its CapabilityStatement's implementation.url, or the address tested)
    this.serverBase = run.serverBase || run.client.base;
    this.warnings = [];
    this.notes = [];
    // the resources the test made to test with: [{ type, id, resource (as the server has it) }]
    this.resources = [];
    // optional features (ctx.optional): those the server refused, and how many it did
    this.unsupported = [];
    this.optionalRan = 0;
  }

  /**
   * A search using something the server needn't support (a modifier, a chain, a prefix, an
   * include...). A server SHALL refuse what it doesn't support, so a 4xx (or 501) means it
   * doesn't: noted, and false. Otherwise it must find what's expected (level 'must'), or should
   * ('should': a warning). Finding everything the test made, as if the parameter weren't there,
   * is a warning that it seems to have been ignored.
   * @param {string} type
   * @param {Array<[string, string]>} params
   * @param {string[]} expected - the ids
   * @param {Object} [options] - { level: 'must' | 'should', what (for the messages), feature (what isn't supported) }
   * @returns {Promise<boolean>} whether the server did it, and found what was expected
   */
  async optional(type, params, expected, options = {}) {
    const what = options.what || `${type}?${params.map(([n, v]) => `${n}=${v}`).join('&')}`;
    const scope = this.scope(type);
    if (!scope) {
      this.skip(`The server lists neither _tag nor identifier as a search parameter of ${type}, so a search can't be limited to this run's resources`);
    }
    const all = [...params, ...scope];
    const res = await this.client.get(`${type}?${all.map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('&')}`, options.format ? { format: options.format } : {});
    if ([400, 404, 405, 422, 501].includes(res.status)) {
      this.unsupported.push(`${options.feature || what} (${res.status}${outcomeText(res)})`);
      return false;
    }
    this.optionalRan++;
    this.status(res, 200, what);
    const bundle = this.body(res, 'Bundle', what);
    const ids = matches(bundle, type);
    if (sameIds(ids, expected)) {
      return true;
    }
    const everything = await this.everything(type);
    if (!sameIds(expected, everything) && sameIds(ids, everything)) {
      this.should(false, `${what} found everything the test made, as if the server ignored it (a server that doesn't support something SHALL refuse it)`);
      return false;
    }
    const message = `${what} found ${ids.length ? ids.join(', ') : 'nothing'}, not ${expected.length ? expected.join(', ') : 'nothing'}`;
    if (options.level === 'should') {
      this.should(false, message);
      return false;
    }
    this.fail(message);
    return false;
  }

  /** The ids of everything of a type the test made (a search with only the test's scope) */
  async everything(type) {
    const scope = this.scope(type);
    const res = this.status(await this.client.get(`${type}?${scope.map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('&')}&_count=100`), 200, `Searching ${type} for everything the test made`);
    return matches(this.body(res, 'Bundle', 'the search'), type);
  }

  /**
   * Do what the test needs before it tests: the requests are shown as setup
   * @param {function(): Promise<*>} fn
   */
  async setup(fn) {
    const was = this.client.phase;
    this.client.phase = 'setup';
    try {
      return await fn();
    } finally {
      this.client.phase = was;
    }
  }

  /** The test fails unless cond: the server doesn't do what the specification requires */
  must(cond, message) {
    if (!cond) {
      throw new Failed(message);
    }
  }

  /** A warning unless cond: the specification recommends it */
  should(cond, message) {
    if (!cond) {
      this.warnings.push(message);
    }
    return !!cond;
  }

  fail(message) {
    throw new Failed(message);
  }

  /** The test isn't run, and why (found out while running it) */
  skip(reason) {
    throw new Skipped(reason);
  }

  /** Something worth saying in the outcome, that isn't a problem */
  note(message) {
    this.notes.push(message);
  }

  /**
   * The response's status must be one of these
   * @param {Object} res
   * @param {number|number[]} expected
   * @param {string} what - what was done, for the message
   */
  status(res, expected, what) {
    const list = Array.isArray(expected) ? expected : [expected];
    this.must(list.includes(res.status), `${what}: the server answered ${res.status}, not ${list.join(' or ')}${outcomeText(res)}`);
    return res;
  }

  /** The response's body must be a resource of this type */
  body(res, type, what) {
    this.must(!res.parseError, `${what}: the response couldn't be read: ${res.parseError}`);
    this.must(res.resource && res.resource.resourceType === type,
      `${what}: the response is ${res.resource ? `a ${res.resource.resourceType}` : 'not a resource'}, not a ${type}`);
    return res.resource;
  }

  /** A new identifier, unique to the run, in the test's own system */
  identifier() {
    return { system: this.identifierSystem, value: `${this.run.id}-${++this.run.counter}` };
  }

  /**
   * A resource of the run's: tagged, and (for these types) with an identifier of the run's
   * @param {string} type
   * @param {Object} [fields]
   */
  resource(type, fields = {}) {
    const r = { resourceType: type, ...fields };
    r.meta = { ...(fields.meta || {}), tag: [...((fields.meta && fields.meta.tag) || []), this.run.tag, this.testTag] };
    if (['Patient', 'Organization', 'Practitioner', 'Observation', 'Group', 'Location', 'Device', 'RelatedPerson'].includes(type)) {
      r.identifier = [...(fields.identifier || []), this.identifier()];
    }
    return r;
  }

  /** Note that the run made a resource, to delete at the end */
  created(type, id) {
    if (id && !this.run.created.some(c => c.type === type && c.id === id)) {
      this.run.created.push({ type, id });
    }
  }

  /**
   * Create a resource (POST), and read it back if the server sent nothing
   * @returns {Promise<{id: string, version: string|null, resource: Object, res: Object}>}
   */
  async create(resource, options = {}) {
    return this.setup(() => this.createNow(resource, options));
  }

  /** As create, but as part of what is tested (its requests aren't setup) */
  async createNow(resource, options = {}) {
    const type = resource.resourceType;
    const res = await this.client.post(type, resource, options);
    this.status(res, 201, `Creating a ${type}`);
    const loc = idFromLocation(res.headers.location, type);
    const id = (res.resource && res.resource.resourceType === type && res.resource.id) || (loc && loc.id);
    this.must(id, `Creating a ${type}: the server said where it is in neither the Location header nor the body`);
    this.created(type, id);
    let body = res.resource && res.resource.resourceType === type ? res.resource : null;
    if (!body) {
      const r = await this.client.get(`${type}/${id}`, options);
      this.status(r, 200, `Reading the ${type} just created`);
      body = this.body(r, type, `Reading the ${type} just created`);
    }
    this.resources.push({ type, id, resource: body });
    return { id, version: (body.meta && body.meta.versionId) || (loc && loc.version) || null, resource: body, res };
  }

  /** The search parameters that limit a search of a type to the test's own resources, or null */
  scope(type) {
    const how = this.run.scopeFor(type);
    if (how === '_tag') {
      return [['_tag', `${this.testTag.system}|${this.testTag.code}`]];
    }
    if (how === 'identifier') {
      return [['identifier', `${this.identifierSystem}|`]];
    }
    return null;
  }

  /**
   * Search a type, limited to the run's resources
   * @param {string} type
   * @param {Array<[string, string]>} params
   * @param {Object} [options] - format; post (POST _search)
   * @returns {Promise<{bundle: Object, ids: string[], res: Object}>} ids: the matches (not includes)
   */
  async search(type, params, options = {}) {
    const scope = this.scope(type);
    if (!scope) {
      this.skip(`The server lists neither _tag nor identifier as a search parameter of ${type}, so a search can't be limited to this run's resources`);
    }
    const all = [...params, ...scope];
    let res;
    if (options.post) {
      const form = all.map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('&');
      res = await this.client.post(`${type}/_search`, form, { ...options, contentType: 'application/x-www-form-urlencoded' });
    } else {
      res = await this.client.get(`${type}?${all.map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('&')}`, options);
    }
    const what = `Searching ${type}?${params.map(([n, v]) => `${n}=${v}`).join('&')}`;
    this.status(res, 200, what);
    const bundle = this.body(res, 'Bundle', what);
    this.must(bundle.type === 'searchset', `${what}: the Bundle is a ${bundle.type}, not a searchset`);
    return { bundle, ids: matches(bundle, type), res };
  }

  /** The ids of a search Bundle's matches of a type */
  matches(bundle, type) {
    return matches(bundle, type);
  }

  /** Every page of a search, following the next links (at most 50 pages) */
  async allPages(first, type, what) {
    const ids = [...matches(first, type)];
    const pages = [first];
    let bundle = first;
    for (let n = 0; n < 50; n++) {
      const next = (bundle.link || []).find(l => l.relation === 'next');
      if (!next || !next.url) {
        break;
      }
      const res = await this.client.get(next.url);
      this.status(res, 200, `${what}: the next page`);
      bundle = this.body(res, 'Bundle', `${what}: the next page`);
      pages.push(bundle);
      ids.push(...matches(bundle, type));
    }
    return { ids, pages };
  }
}

/** Whether two lists of ids have the same ids */
function sameIds(a, b) {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** The ids of a search Bundle's matches of a type (entries that say they're includes aren't) */
function matches(bundle, type) {
  return (bundle.entry || []).filter(e => e && e.resource && e.resource.resourceType === type && (!e.search || !e.search.mode || e.search.mode === 'match'))
    .map(e => e.resource.id);
}

/** Why a test can't run on this server, or null */
function whyNot(test, cap, run) {
  const r = test.requires || {};
  for (const [type, code] of r.interactions || []) {
    if (!cap.hasType(type)) {
      return `The server doesn't list ${type} in its CapabilityStatement`;
    }
    if (!cap.interaction(type, code)) {
      return `The CapabilityStatement doesn't list ${code} for ${type}`;
    }
  }
  for (const code of r.system || []) {
    if (!cap.systemInteraction(code)) {
      return `The CapabilityStatement doesn't list ${code} for the server`;
    }
  }
  for (const [type, name] of r.search || []) {
    if (!cap.searchParam(type, name)) {
      return `The CapabilityStatement doesn't list the ${name} search parameter for ${type}`;
    }
  }
  for (const [type, name] of r.operations || []) {
    if (!cap.operation(name, type)) {
      return `The CapabilityStatement doesn't list $${name}${type ? ' for ' + type : ''}`;
    }
  }
  for (const type of r.scope || []) {
    if (!run.scopeFor(type)) {
      return `The server lists neither _tag nor identifier as a search parameter of ${type}, so a search can't be limited to this run's resources`;
    }
  }
  if (r.format === 'xml' && !cap.format('xml')) {
    return 'The CapabilityStatement doesn\'t list XML as a format';
  }
  if (r.format === 'xml' && !run.client.xmlModel) {
    return `There is no XML model for FHIR ${cap.fhirVersion} here`;
  }
  if (r.check) {
    return r.check(cap) || null;
  }
  return null;
}

class TestRun {
  /**
   * @param {Object} options
   * @param {string} options.base - the server's base URL
   * @param {string} [options.token] - a bearer token
   * @param {string} [options.id] - the run's id (a UUID)
   * @param {boolean} [options.allowPrivate]
   * @param {function(string): Promise<Object>} [options.xmlModel] - the XML model for a FHIR version
   * @param {function(Object): void} [options.onResult] - each result, as it comes
   * @param {function(string): void} [options.onStatus] - what the run is doing
   * @param {number} [options.limitMs]
   * @param {Object[]} [options.groups] - the suite (tester/suite), or a part of it
   * @param {function(Object): boolean} [options.filter] - which tests to run
   */
  constructor(options) {
    this.options = options;
    this.id = options.id || crypto.randomUUID();
    this.tag = { system: TAG_SYSTEM, code: this.id, display: 'Made by a FHIRsmith test run' };
    this.counter = 0;
    this.index = 0;
    this.created = [];
    this.results = [];
    this.controller = new AbortController();
    this.client = new FhirClient({ base: options.base, token: options.token, allowPrivate: options.allowPrivate, xmlModel: options.xmlModel,
      signal: this.controller.signal });
    this.cap = null;
    this.scopes = new Map();
  }

  /** Stop the run: the test under way is abandoned, the rest aren't run, and what was made is cleaned up */
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

  /** How a search of a type is limited to a test's resources: '_tag', 'identifier', or null */
  scopeFor(type) {
    if (!this.scopes.has(type)) {
      this.scopes.set(type, this.cap.searchParam(type, '_tag') ? '_tag' : this.cap.searchParam(type, 'identifier') ? 'identifier' : null);
    }
    return this.scopes.get(type);
  }

  /**
   * Run the tests
   * @returns {Promise<{outcome: string, message: string|null, cap: Capabilities|null, results: Object[], cleanup: Object}>}
   *   outcome: completed, cancelled, or error (the run couldn't start: the message says why)
   */
  async run() {
    const limitMs = this.options.limitMs || RUN_LIMIT_MS;
    const timer = setTimeout(() => this.cancel(`The run took more than ${Math.round(limitMs / 60000)} minutes`), limitMs);
    timer.unref();
    this.started = new Date();
    try {
      this.status('Reading the CapabilityStatement');
      let res;
      try {
        res = await this.client.get('metadata');
      } catch (e) {
        return this.finish('error', `The server didn't answer: ${e.message}`);
      }
      if (res.status !== 200 || !res.resource || res.resource.resourceType !== 'CapabilityStatement') {
        return this.finish('error', `GET [base]/metadata didn't return a CapabilityStatement (the answer was ${res.status}${res.resource ? ', a ' + res.resource.resourceType : ''}${outcomeText(res)})`);
      }
      this.cap = new Capabilities(res.resource);
      this.capabilityStatement = res.resource;
      // the links the server makes may use the address it says it has
      const own = res.resource.implementation && res.resource.implementation.url;
      if (own) {
        this.client.alias(own);
      }
      // the server's own address, as it knows it: for absolute references to it
      this.serverBase = own && /^https?:\/\//.test(own) ? String(own).replace(/\/+$/, '') : this.client.base;
      if (!this.cap.release) {
        return this.finish('error', `The server is FHIR ${this.cap.fhirVersion || '(no fhirVersion)'}: only R4 and R5 servers are tested`);
      }
      if (!this.cap.format('json')) {
        return this.finish('error', 'The CapabilityStatement doesn\'t list JSON as a format: the tests are in JSON');
      }
      if (this.cap.format('xml')) {
        try {
          await this.client.useVersion(this.cap.fhirVersion);
        } catch (e) {
          this.status(`No XML model for FHIR ${this.cap.fhirVersion}: ${e.message}`);
        }
      }
      this.client.take();
      for (const group of this.options.groups || suite()) {
        for (const test of group.tests) {
          if (this.options.filter && !this.options.filter(test, group)) {
            continue;
          }
          await this.runTest(group, test);
        }
      }
      return this.finish(this.controller.signal.aborted ? 'cancelled' : 'completed', this.controller.signal.aborted ? this.stopReason : null);
    } finally {
      clearTimeout(timer);
    }
  }

  async runTest(group, test) {
    const result = { group: group.name, name: test.name, outcome: 'pass', message: null, ms: 0, exchanges: [], start: new Date().toISOString(), end: null };
    const started = Date.now();
    let ctx = null;
    if (this.controller.signal.aborted) {
      result.outcome = 'skip';
      result.message = `Not run: ${this.stopReason}`;
    } else {
      const reason = whyNot(test, this.cap, this);
      if (reason) {
        result.outcome = 'skip';
        result.message = reason;
      } else {
        this.status(`${group.name}: ${test.name}`);
        ctx = new TestContext(this, test, ++this.index);
        try {
          await test.run(ctx);
          if (ctx.unsupported.length && !ctx.optionalRan && !ctx.warnings.length) {
            // nothing the test tests is supported
            result.outcome = 'skip';
            result.message = `The server refused what this tests, so it doesn't support it: ${ctx.unsupported.join('; ')}`;
          } else if (ctx.warnings.length) {
            result.outcome = 'warning';
            result.message = ctx.warnings.join('\n');
          }
        } catch (e) {
          if (e instanceof Failed) {
            result.outcome = 'fail';
            result.message = [e.message, ...ctx.warnings].join('\n');
          } else if (e instanceof Skipped) {
            result.outcome = 'skip';
            result.message = e.message;
          } else if (this.controller.signal.aborted) {
            result.outcome = 'error';
            result.message = `Not finished: ${this.stopReason}`;
          } else {
            result.outcome = 'error';
            result.message = e instanceof ClientError ? e.message : `The test couldn't be completed: ${e.message}`;
          }
        }
        if (ctx.unsupported.length && result.outcome !== 'skip') {
          ctx.notes.push(`Not supported (the server refused it): ${ctx.unsupported.join('; ')}`);
        }
        if (ctx.notes.length) {
          result.message = [result.message, ...ctx.notes].filter(Boolean).join('\n');
        }
      }
    }
    result.exchanges = this.client.take();
    result.resources = ctx ? ctx.resources : [];
    result.ms = Date.now() - started;
    result.end = new Date().toISOString();
    this.results.push(result);
    if (this.options.onResult) {
      this.options.onResult(result);
    }
  }

  async finish(outcome, message) {
    this.finished = new Date();
    const cleanup = await this.cleanUp();
    return { outcome, message: message || null, cap: this.cap, results: this.results, cleanup, started: this.started, finished: new Date() };
  }

  /**
   * Delete what the run made, newest first, and expunge it when the server has $expunge; a
   * delete refused (something else of the run's refers to it) is tried again after the others
   */
  async cleanUp() {
    const summary = { created: this.created.length, deleted: 0, expunged: 0, left: [] };
    if (!this.created.length || !this.cap) {
      return summary;
    }
    this.status(`Cleaning up: ${this.created.length} resources`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Cleaning up took too long')), CLEANUP_LIMIT_MS);
    timer.unref();
    const client = new FhirClient({ base: this.options.base, token: this.options.token, allowPrivate: this.options.allowPrivate, signal: controller.signal });
    let todo = [...this.created].reverse();
    try {
      for (let pass = 0; pass < 3 && todo.length; pass++) {
        const refused = [];
        for (const c of todo) {
          if (!this.cap.interaction(c.type, 'delete')) {
            refused.push(c);
            continue;
          }
          try {
            const res = await client.delete(`${c.type}/${c.id}`);
            if ([200, 202, 204, 404, 410].includes(res.status)) {
              summary.deleted++;
              if (this.cap.operation('expunge', c.type)) {
                const x = await client.post(`${c.type}/${c.id}/$expunge`, { resourceType: 'Parameters', parameter: [
                  { name: 'expungeDeletedResources', valueBoolean: true }, { name: 'expungePreviousVersions', valueBoolean: true }] });
                if (x.status === 200) {
                  summary.expunged++;
                }
              }
            } else {
              refused.push(c);
            }
          } catch (e) {
            refused.push(c);
          }
        }
        if (refused.length === todo.length) {
          todo = refused;
          break;
        }
        todo = refused;
      }
    } finally {
      clearTimeout(timer);
    }
    summary.left = todo.map(c => `${c.type}/${c.id}`);
    return summary;
  }
}

module.exports = { TestRun, TestContext, TAG_SYSTEM, TEST_TAG_SYSTEM, RUN_LIMIT_MS, idFromLocation, matches, sameIds, outcomeText };
