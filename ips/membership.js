//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Value set membership for entryIn() and resourcesIn() (fhirpath-ips.js): is a
 * CodeableConcept in a value set? Asked of the terminology server ($validate-code, with
 * the concept), as the rules are evaluated - only what a rule actually reaches is asked.
 *
 * A session is one run of rules over one document. It asks each question once (questions
 * in flight are shared), keeps to a budget, and remembers what it couldn't find out, so a
 * rule that failed because the server couldn't answer can be told from one that plainly
 * failed. Definite answers (true, false) are also kept in a cache that outlives the session
 * (the module's), so the same concept in the next document isn't asked again; an answer
 * the server couldn't give is not kept beyond the session.
 *
 * The module's own value sets (ips/valuesets/) go with the question, with what they draw on,
 * so any server can answer for them; any other is asked by its canonical, and must be one
 * the server knows.
 *
 * @module ips/membership
 */

const DEFAULT_MAX_QUESTIONS = 500;
const MAX_CACHED = 20000;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The codings that matter, in a stable order: the concept's identity for the cache. */
function plainConcept(concept) {
  const coding = (Array.isArray(concept?.coding) ? concept.coding : [])
    .filter(c => isObject(c) && typeof c.system === 'string' && typeof c.code === 'string')
    .map(c => {
      const p = { system: c.system, code: c.code };
      if (typeof c.version === 'string') {
        p.version = c.version;
      }
      return p;
    });
  return { coding };
}

function keyOf(url, concept) {
  return `member|${url}|` + concept.coding.map(c => `${c.system}|${c.version || ''}|${c.code}`).sort().join(',');
}

/** What a $validate-code response says: true, false, or null with why it said neither. */
function answerOf(r, internal) {
  if (!r) {
    return { result: null, message: 'The terminology server could not be reached' };
  }
  const res = r.resource;
  const issueText = (oo) => (Array.isArray(oo?.issue) ? oo.issue : []).map(i => i?.details?.text || i?.diagnostics).filter(Boolean).join('; ');
  if (res?.resourceType === 'Parameters') {
    const result = (res.parameter || []).find(p => p?.name === 'result');
    if (result && typeof result.valueBoolean === 'boolean') {
      return { result: result.valueBoolean, message: null };
    }
    const issues = (res.parameter || []).find(p => p?.name === 'issues');
    return { result: null, message: issueText(issues?.resource) || 'The terminology server gave no result' };
  }
  if (res?.resourceType === 'OperationOutcome') {
    return { result: null, message: issueText(res) || `The terminology server answered HTTP ${r.status}` };
  }
  if (r.status === 404 && internal) {
    return { result: null, message: 'The terminology server is not configured correctly (see the server log)' };
  }
  return { result: null, message: `The terminology server answered HTTP ${r.status}` };
}

class MembershipSession {
  /**
   * @param {Object|null} tx - the module's TxClient (none: nothing can be answered)
   * @param {Object|null} valueSets - the module's IpsValueSets
   * @param {{cache?: Map, maxQuestions?: number, log?: Object}} [options] - cache: kept
   *   beyond the session (the module's), for definite answers
   */
  constructor(tx, valueSets, options = {}) {
    this.tx = tx;
    this.valueSets = valueSets;
    this.cache = options.cache || null;
    this.maxQuestions = Number.isInteger(options.maxQuestions) && options.maxQuestions >= 0 ? options.maxQuestions : DEFAULT_MAX_QUESTIONS;
    this.log = options.log || null;
    this.questions = 0;
    this.answers = new Map();
    // what couldn't be found out: value set -> message
    this.problems = new Map();
    // what fhirpath-ips.js's membership option wants
    this.membership = (url, concept) => this.check(url, concept);
  }

  /**
   * Is the concept in the value set?
   * @returns {boolean|Promise<boolean|null>} at once, when it is known (or can't be in it);
   *   null when it couldn't be found out
   */
  check(url, concept) {
    const plain = plainConcept(concept);
    if (!plain.coding.length) {
      return false;
    }
    const key = keyOf(url, plain);
    if (this.answers.has(key)) {
      return this.answers.get(key);
    }
    if (this.cache && this.cache.has(key)) {
      const known = this.cache.get(key);
      this.answers.set(key, known);
      return known;
    }
    const pending = this.ask(url, plain).then(a => {
      this.answers.set(key, a.result);
      if (a.result === null) {
        this.problem(url, a.message);
      } else if (this.cache) {
        if (this.cache.size >= MAX_CACHED) {
          this.cache.delete(this.cache.keys().next().value);
        }
        this.cache.set(key, a.result);
      }
      return a.result;
    });
    this.answers.set(key, pending);
    return pending;
  }

  problem(url, message) {
    if (!this.problems.has(url)) {
      this.problems.set(url, message);
    }
  }

  async ask(url, concept) {
    if (!this.tx) {
      return { result: null, message: 'No terminology server is configured' };
    }
    if (this.questions >= this.maxQuestions) {
      return { result: null, message: `More than ${this.maxQuestions} value set questions for one document` };
    }
    this.questions++;
    const bar = url.indexOf('|');
    const canonical = bar < 0 ? url : url.substring(0, bar);
    const version = bar < 0 ? null : url.substring(bar + 1);
    const params = { resourceType: 'Parameters', parameter: [] };
    const own = this.valueSets ? this.valueSets.valueSet(canonical) : null;
    if (own && (!version || own.version === version)) {
      params.parameter.push({ name: 'valueSet', resource: own });
      for (const r of this.valueSets.referencedResources(canonical)) {
        params.parameter.push({ name: 'tx-resource', resource: r });
      }
    } else {
      params.parameter.push({ name: 'url', valueUri: canonical });
      if (version) {
        params.parameter.push({ name: 'valueSetVersion', valueString: version });
      }
    }
    params.parameter.push({ name: 'codeableConcept', valueCodeableConcept: concept });
    let r = null;
    try {
      r = await this.tx.post('/ValueSet/$validate-code', params);
    } catch (e) {
      if (this.log) {
        this.log.error(`IPS module: the terminology server could not be reached: ${e.message}`);
      }
    }
    return answerOf(r, this.tx.internal);
  }

  /** What couldn't be found out, by value set: [{valueSet, message}]. */
  unresolved() {
    return [...this.problems].map(([valueSet, message]) => ({ valueSet, message }));
  }
}

module.exports = { MembershipSession, plainConcept, DEFAULT_MAX_QUESTIONS };
