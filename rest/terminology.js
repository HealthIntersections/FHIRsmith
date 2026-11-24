//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The endpoint's terminology server: value set expansions for :in and :not-in, and the
 * closure table (for :below and :above), kept up to date as a client of the server's
 * $closure. The server is a path on this server (the tx module, in process) or a URL, as for
 * the IPS module.
 *
 * @module rest/terminology
 */

const crypto = require('crypto');
const { TxClient } = require('../ips/tx-client');
const { FhirError, tooCostly } = require('./library/errors');

const MAX_EXPANSION = 10000;
const EXPANSION_KEEP_MS = 5 * 60 * 1000;
const CLOSURE_BATCH = 200;

// R4 equivalence and R5 relationship: does the target subsume the source (up), or the
// source the target (down)?
const UP = new Set(['subsumes', 'wider', 'source-is-narrower-than-target']);
const DOWN = new Set(['specializes', 'narrower', 'source-is-broader-than-target']);

class Terminology {
  /**
   * @param {string} server - a path on this server or an http(s) URL
   * @param {Object} options - { app, log, closureName }
   */
  constructor(server, options = {}) {
    this.client = new TxClient(server, { app: options.app, log: options.log });
    this.log = options.log;
    this.closureName = options.closureName;
    this.expansions = new Map();
  }

  /**
   * The codes in a value set.
   * @param {string} url
   * @returns {Promise<Array<{system: string, code: string}>>}
   */
  async expand(url) {
    const cached = this.expansions.get(url);
    if (cached && cached.until > Date.now()) {
      return cached.codes;
    }
    const r = await this.client.get('/ValueSet/$expand', { url, count: MAX_EXPANSION + 1, excludeNested: true });
    if (r.status !== 200 || !r.resource || r.resource.resourceType !== 'ValueSet') {
      const msg = r.resource && r.resource.issue ? r.resource.issue.map(i => i.diagnostics || (i.details && i.details.text)).filter(x => x).join('; ') : `status ${r.status}`;
      throw new FhirError(400, 'processing', `The value set ${url} couldn't be expanded: ${msg}`);
    }
    const codes = [];
    const walk = (list) => {
      for (const c of list || []) {
        if (c.system && c.code && !c.abstract) {
          codes.push({ system: c.system, code: c.code });
        }
        walk(c.contains);
      }
    };
    walk(r.resource.expansion && r.resource.expansion.contains);
    const total = r.resource.expansion && r.resource.expansion.total;
    if (codes.length > MAX_EXPANSION || (typeof total === 'number' && total > MAX_EXPANSION)) {
      throw tooCostly(`The value set ${url} has more than ${MAX_EXPANSION} codes: too many for :in`);
    }
    this.expansions.set(url, { codes, until: Date.now() + EXPANSION_KEEP_MS });
    if (this.expansions.size > 200) {
      this.expansions.delete(this.expansions.keys().next().value);
    }
    return codes;
  }

  /**
   * One round of the closure job: send the concepts not yet in the closure, and apply what
   * comes back. A master job.
   * @param {Object} ep - the Endpoint
   * @returns {Promise<number>} how many concepts were sent
   */
  async updateClosure(ep) {
    const db = ep.db;
    const closure = await db.read(q => q.get('SELECT ClosureKey, Name, Version FROM Closures WHERE Name = ?', [this.closureName]));
    let closureKey;
    if (!closure) {
      const r = await this.client.post('/$closure', { resourceType: 'Parameters', parameter: [{ name: 'name', valueString: this.closureName }] });
      if (r.status !== 200) {
        throw new Error(`The terminology server didn't start the closure ${this.closureName} (status ${r.status})`);
      }
      closureKey = await db.write(async (q) => {
        await q.run(q.dialect.insertIgnore('Closures', ['Name', 'Version']) + '(?, NULL)', [this.closureName]);
        const row = await q.get('SELECT ClosureKey FROM Closures WHERE Name = ?', [this.closureName]);
        return Number(row.ClosureKey);
      });
    } else {
      closureKey = Number(closure.ClosureKey);
    }
    const pending = await db.read(q => q.all(`SELECT c.ConceptKey, c.Code, s.Uri FROM Concepts c JOIN Spaces s ON s.SpaceKey = c.SpaceKey
      WHERE c.InClosure = 0 ORDER BY c.ConceptKey LIMIT ${CLOSURE_BATCH}`));
    if (!pending.length) {
      return 0;
    }
    const params = { resourceType: 'Parameters', parameter: [{ name: 'name', valueString: this.closureName }] };
    for (const c of pending) {
      params.parameter.push({ name: 'concept', valueCoding: { system: c.Uri, code: c.Code } });
    }
    // (no version: $closure adds concepts or resynchronises from a version, never both; the
    // answer to adding concepts is everything new they bring)
    const r = await this.client.post('/$closure', params);
    if (r.status !== 200 || !r.resource || r.resource.resourceType !== 'ConceptMap') {
      throw new Error(`$closure failed (status ${r.status}): ${JSON.stringify(r.resource).substring(0, 400)}`);
    }
    const pairs = [];
    for (const g of r.resource.group || []) {
      for (const e of g.element || []) {
        for (const t of e.target || []) {
          const rel = t.equivalence || t.relationship;
          const src = { system: g.source, code: e.code };
          const tgt = { system: g.target, code: t.code };
          if (UP.has(rel)) {
            pairs.push([tgt, src]);
          } else if (DOWN.has(rel)) {
            pairs.push([src, tgt]);
          }
        }
      }
    }
    await db.write(async (q) => {
      if (pairs.length) {
        const systems = pairs.flatMap(([a, b]) => [a.system, b.system]);
        const spaces = await ep.lookups.spaceKeys(q, systems);
        const concepts = await ep.lookups.conceptKeys(q, pairs.flatMap(([a, b]) => [[spaces.get(a.system), a.code], [spaces.get(b.system), b.code]]));
        const rows = pairs.map(([a, b]) => [concepts.get(spaces.get(a.system) + '|' + a.code), concepts.get(spaces.get(b.system) + '|' + b.code)])
          .filter(([a, b]) => a && b && a !== b);
        for (let i = 0; i < rows.length; i += 300) {
          const c = rows.slice(i, i + 300);
          await q.run(q.dialect.insertIgnore('ClosureEntries', ['ClosureKey', 'SubsumesKey', 'SubsumedKey']) + c.map(() => '(?, ?, ?)').join(', '),
            c.flatMap(([a, b]) => [closureKey, a, b]));
        }
      }
      const keys = pending.map(p => Number(p.ConceptKey));
      await q.run(`UPDATE Concepts SET InClosure = 1 WHERE ConceptKey IN (${keys.map(() => '?').join(', ')})`, keys);
      if (r.resource.version) {
        await q.run('UPDATE Closures SET Version = ? WHERE ClosureKey = ?', [String(r.resource.version), closureKey]);
      }
    });
    return pending.length;
  }
}

/** A closure name for an endpoint: stable, and different for each endpoint's database */
function closureName(path, instance) {
  return 'fhirsmith-rest-' + crypto.createHash('sha256').update(path + '|' + instance).digest('hex').substring(0, 16);
}

module.exports = { Terminology, closureName, MAX_EXPANSION };
