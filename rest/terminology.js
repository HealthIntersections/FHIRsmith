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

const EXPANSION_KEEP_MS = 5 * 60 * 1000;
const CLOSURE_BATCH = 200;
// concepts checked for a value set's membership in one round, and asked about in one call
const MEMBERSHIP_BATCH = 1000;
const VALIDATE_BATCH = 200;
const UNCLOSED = 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed';

// R4 equivalence and R5 relationship: does the target subsume the source (up), or the
// source the target (down)?
const UP = new Set(['subsumes', 'wider', 'source-is-narrower-than-target']);
const DOWN = new Set(['specializes', 'narrower', 'source-is-broader-than-target']);

class Terminology {
  /**
   * @param {string} server - a path on this server or an http(s) URL
   * @param {Object} options - { app, log }
   */
  constructor(server, options = {}) {
    this.client = new TxClient(server, { app: options.app, log: options.log });
    this.log = options.log;
    this.expansions = new Map();
    // codes searched for, by closure: their relationships, or null if the server refused them
    this.searched = new Map();
    // writes of what searches learned, not waited for by the search
    this.writes = new Set();
  }

  /**
   * A code searched for with :below or :above, in the places searched: where a place has a
   * closure table and the code isn't in it, it's added now, and the relationships the server
   * gives for it are returned, for the search to use; they are written to the database (and
   * the code marked as in the table) afterwards, without the search waiting. A failure
   * (other than the server refusing the code) is logged, and the search goes on with what's
   * in the database.
   * @param {Object} ep
   * @param {Object} q - the search's query object (read only)
   * @param {Array<number[]>} places - [typeKey, paramKey]
   * @param {string} system
   * @param {string} code
   * @param {number|null} ck - the code's ConceptKey, if it has one
   * @returns {Promise<Array<Array<{system: string, code: string}>>>} [subsumer, subsumed] pairs
   */
  async relateSearched(ep, q, places, system, code, ck) {
    const out = [];
    for (const [typeKey, paramKey] of places) {
      const closure = await q.get('SELECT ClosureKey, Name FROM Closures WHERE TypeKey = ? AND ParamKey = ?', [typeKey, paramKey]);
      if (!closure) {
        // no codes there yet (or not sent yet): nothing to relate it to
        continue;
      }
      const ckey = Number(closure.ClosureKey);
      const cacheKey = ckey + '|' + system + '|' + code;
      if (this.searched.has(cacheKey)) {
        out.push(...(this.searched.get(cacheKey) || []));
        continue;
      }
      if (ck !== null) {
        const pc = await q.get('SELECT InClosure FROM ParamConcepts WHERE TypeKey = ? AND ParamKey = ? AND ConceptKey = ?', [typeKey, paramKey, ck]);
        if (pc && Number(pc.InClosure) !== 0) {
          // in the table (its relationships are in ClosureEntries), or refused
          continue;
        }
      }
      const g = { typeKey, paramKey };
      let r;
      try {
        r = await this.sendConcepts(closure.Name, [{ system, code }]);
      } catch (e) {
        this.log.warn(`Closure for ${this.where(ep, g)}: couldn't add ${system}|${code} for a search: ${e.message}`);
        continue;
      }
      if (r.status === 200 && r.resource && r.resource.resourceType === 'ConceptMap') {
        const pairs = parsePairs(r.resource);
        this.remember(cacheKey, pairs);
        out.push(...pairs);
        this.later(ep, async (wq) => {
          const c = await this.conceptFor(ep, wq, system, code);
          await this.storePairs(ep, wq, ckey, pairs);
          await this.markSearched(wq, g, c, 1);
        });
      } else if ([400, 404, 422].includes(r.status) && reason(r) !== 'CLOSURE_TABLE_UNKNOWN' && !/^CLOSURE_TOO_MANY/.test(reason(r) || '')) {
        // a code the server doesn't know
        this.remember(cacheKey, null);
        this.later(ep, async (wq) => {
          await this.markSearched(wq, g, await this.conceptFor(ep, wq, system, code), 2);
        });
      } else {
        this.log.warn(`Closure for ${this.where(ep, g)}: couldn't add ${system}|${code} for a search (status ${r.status}${reason(r) ? ', ' + reason(r) : ''})`);
      }
    }
    return out;
  }

  remember(k, v) {
    if (this.searched.size >= 10000) {
      this.searched.clear();
    }
    this.searched.set(k, v);
  }

  /** A write after the search, in its own transaction (the search may be in a write transaction) */
  later(ep, fn) {
    const p = new Promise(resolve => setImmediate(resolve))
      .then(() => ep.db.write(fn))
      .catch(e => this.log.warn(`Closure: couldn't store what a search learned: ${e.message}`))
      .finally(() => this.writes.delete(p));
    this.writes.add(p);
  }

  /** Wait for the writes searches have started (tests, shutdown) */
  async settled() {
    while (this.writes.size) {
      await Promise.all([...this.writes]);
    }
  }

  async conceptFor(ep, q, system, code) {
    const spaces = await ep.lookups.spaceKeys(q, [system]);
    const keys = await ep.lookups.conceptKeys(q, [[spaces.get(system), code]]);
    return keys.get(spaces.get(system) + '|' + code);
  }

  async markSearched(q, g, ck, value) {
    await q.run(q.dialect.insertIgnore('ParamConcepts', ['TypeKey', 'ParamKey', 'ConceptKey', 'InClosure']) + '(?, ?, ?, ?)', [g.typeKey, g.paramKey, ck, value]);
    await q.run('UPDATE ParamConcepts SET InClosure = ? WHERE TypeKey = ? AND ParamKey = ? AND ConceptKey = ? AND InClosure = 0', [value, g.typeKey, g.paramKey, ck]);
  }

  /**
   * The codes in a value set, for searching by expansion.
   * @param {string} url - the value set (url or url|version)
   * @param {Object} options
   * @param {number} options.limit - the most codes (maxValueSetExpansion)
   * @param {string} [options.adminPath] - the page where an administrator can register it
   * @returns {Promise<Array<{system: string, code: string}>>}
   * @throws 400 too-costly when it has more codes than the limit, or isn't closed: it can't be
   *   searched by expanding it (but can be registered for searching); 400 when the server
   *   can't expand it
   */
  async expand(url, options) {
    const limit = options.limit;
    const cacheKey = url + '#' + limit;
    const cached = this.expansions.get(cacheKey);
    if (cached && cached.until > Date.now()) {
      if (cached.error) {
        throw cached.error;
      }
      return cached.codes;
    }
    let codes = null;
    let error = null;
    const r = await this.client.get('/ValueSet/$expand', { url, count: limit + 1, excludeNested: true });
    const unsupported = (why) => tooCostly(`The value set ${url} can't be used to search: ${why}. ` +
      `An administrator can register it for searching${options.adminPath ? ' (' + options.adminPath + ')' : ''}`);
    if (r.status !== 200 || !r.resource || r.resource.resourceType !== 'ValueSet') {
      const issues = r.resource && Array.isArray(r.resource.issue) ? r.resource.issue : [];
      const msg = issues.map(i => (i.details && i.details.text) || i.diagnostics).filter(x => x).join('; ') || `status ${r.status}`;
      error = issues.some(i => i.code === 'too-costly')
        ? unsupported(`it has more codes than the terminology server will expand (${msg})`)
        : new FhirError(400, 'processing', `The value set ${url} couldn't be expanded: ${msg}`);
    } else {
      const exp = r.resource.expansion || {};
      const unclosed = (exp.extension || []).find(e => e.url === UNCLOSED);
      if (unclosed) {
        const why = (exp.extension || []).find(e => e.url === UNCLOSED + '-reason');
        error = unsupported(`it isn't closed (its codes can't all be listed${why && why.valueString ? ': ' + why.valueString : ''})`);
      } else {
        codes = [];
        const walk = (list) => {
          for (const c of list || []) {
            if (c.system && c.code && !c.abstract) {
              codes.push({ system: c.system, code: c.code });
            }
            walk(c.contains);
          }
        };
        walk(exp.contains);
        const total = typeof exp.total === 'number' ? exp.total : codes.length;
        if (codes.length > limit || total > limit) {
          const n = total > limit ? total.toLocaleString('en-US') : 'more than ' + limit.toLocaleString('en-US');
          error = unsupported(`it has ${n} codes, more than ${limit.toLocaleString('en-US')} (maxValueSetExpansion)`);
          codes = null;
        }
      }
    }
    // failures are kept too, so a value set too big to expand isn't asked for on every search
    this.expansions.set(cacheKey, { codes, error, until: Date.now() + EXPANSION_KEEP_MS });
    if (this.expansions.size > 200) {
      this.expansions.delete(this.expansions.keys().next().value);
    }
    if (error) {
      throw error;
    }
    return codes;
  }

  // ---- value sets registered for searching by membership ----

  /**
   * The versions of a value set the server has (for the administrator choosing one).
   * @param {string} url
   * @returns {Promise<string[]|null>} null if the server couldn't be asked
   */
  async versions(url) {
    const found = await this.findValueSets(url);
    return found === null ? null : [...new Set(found.map(v => v.version).filter(v => v))];
  }

  async findValueSets(url) {
    try {
      const r = await this.client.get('/ValueSet', { url });
      if (r.status !== 200 || !r.resource || r.resource.resourceType !== 'Bundle') {
        return null;
      }
      return (r.resource.entry || []).map(e => e.resource).filter(v => v && v.resourceType === 'ValueSet' && v.url === url);
    } catch (e) {
      return null;
    }
  }

  /**
   * The code systems a value set draws on, from its compose (following the value sets it
   * includes), so concepts in other systems can be left out without asking; null when that
   * can't be known (no definition, an include with neither, too deep).
   */
  async composeSystems(url, version, depth = 0, seen = new Set()) {
    if (depth > 5) {
      return null;
    }
    if (seen.has(url)) {
      return [];
    }
    seen.add(url);
    const found = await this.findValueSets(url);
    if (!found || !found.length) {
      return null;
    }
    const vs = (version && found.find(v => v.version === version)) || found[0];
    if (!vs.compose || !Array.isArray(vs.compose.include) || !vs.compose.include.length) {
      return null;
    }
    const out = new Set();
    for (const inc of vs.compose.include) {
      if (inc.system) {
        out.add(inc.system);
      } else if (Array.isArray(inc.valueSet) && inc.valueSet.length) {
        for (const ref of inc.valueSet) {
          const [u, v] = String(ref).split('|');
          const sub = await this.composeSystems(u, v || null, depth + 1, seen);
          if (sub === null) {
            return null;
          }
          sub.forEach(x => out.add(x));
        }
      } else {
        return null;
      }
    }
    return [...out];
  }

  /**
   * One round of the membership job: for each registered value set, the concepts not yet
   * checked, asked about with $batch-validate-code (those in systems the value set doesn't
   * draw on are not members, without asking). A queue runner job; a value set the server fails on
   * is logged and tried again next round, without holding up the others.
   * @param {Object} ep
   * @param {number} [budgetMs] - stop starting batches after this long
   * @returns {Promise<number>} how many concepts were dealt with
   */
  async updateValueSets(ep, budgetMs = 3000) {
    const db = ep.db;
    const until = Date.now() + budgetMs;
    let n = 0;
    const sets = await db.read(q => q.all('SELECT ValueSetKey, Url, Version, Systems, Status FROM ValueSets ORDER BY ValueSetKey'));
    for (const vs of sets) {
      const key = Number(vs.ValueSetKey);
      try {
        let systems = vs.Systems === null ? undefined : (vs.Systems === '*' ? null : JSON.parse(vs.Systems));
        if (systems === undefined) {
          systems = await this.composeSystems(vs.Url, vs.Version);
          await db.write(q => q.run('UPDATE ValueSets SET Systems = ? WHERE ValueSetKey = ?', [systems === null ? '*' : JSON.stringify(systems), key]));
        }
        while (Date.now() < until) {
          const pending = await db.read(q => q.all(`SELECT c.ConceptKey, c.Code, s.Uri FROM Concepts c JOIN Spaces s ON s.SpaceKey = c.SpaceKey
            LEFT JOIN ValueSetMembers m ON m.ValueSetKey = ? AND m.ConceptKey = c.ConceptKey
            WHERE m.ConceptKey IS NULL ORDER BY c.ConceptKey LIMIT ${MEMBERSHIP_BATCH}`, [key]));
          if (!pending.length) {
            if (!Number(vs.Status)) {
              await db.write(q => q.run('UPDATE ValueSets SET Status = 1 WHERE ValueSetKey = ? AND Status = 0', [key]));
              this.log.info(`Value set ${vs.Url}: ready for searching`);
            }
            break;
          }
          const results = new Map();
          const ask = [];
          for (const p of pending) {
            if (systems && !systems.includes(p.Uri)) {
              results.set(Number(p.ConceptKey), 0);
            } else {
              ask.push(p);
            }
          }
          for (let i = 0; i < ask.length; i += VALIDATE_BATCH) {
            const chunk = ask.slice(i, i + VALIDATE_BATCH);
            const answers = await this.validateBatch(vs.Url, vs.Version, chunk.map(p => ({ system: p.Uri, code: p.Code })));
            chunk.forEach((p, j) => results.set(Number(p.ConceptKey), answers[j] ? 1 : 0));
          }
          await db.write(async (q) => {
            const rows = [...results.entries()];
            for (let i = 0; i < rows.length; i += 300) {
              const c = rows.slice(i, i + 300);
              await q.run(q.dialect.insertIgnore('ValueSetMembers', ['ValueSetKey', 'ConceptKey', 'Member']) + c.map(() => '(?, ?, ?)').join(', '),
                c.flatMap(([ck, m]) => [key, ck, m]));
            }
          });
          n += pending.length;
        }
      } catch (e) {
        this.log.warn(`Value set ${vs.Url}: working out its members failed: ${e.message}`);
      }
    }
    return n;
  }

  /**
   * Whether each coding is in the value set, by $batch-validate-code.
   * @returns {Promise<boolean[]>} in order; an entry the server can't answer is false
   */
  async validateBatch(url, version, codings) {
    const parameter = codings.map(c => {
      const p = [{ name: 'url', valueUri: url }];
      if (version) {
        p.push({ name: 'valueSetVersion', valueString: version });
      }
      p.push({ name: 'coding', valueCoding: { system: c.system, code: c.code } });
      return { name: 'validation', resource: { resourceType: 'Parameters', parameter: p } };
    });
    const r = await this.client.post('/ValueSet/$batch-validate-code', { resourceType: 'Parameters', parameter });
    if (r.status !== 200 || !r.resource || !Array.isArray(r.resource.parameter)) {
      throw new Error(`$batch-validate-code failed (status ${r.status}${reason(r) ? ', ' + reason(r) : ''})`);
    }
    const out = r.resource.parameter.filter(p => p.name === 'validation').map(p => {
      const res = p.resource;
      const result = res && res.resourceType === 'Parameters' ? (res.parameter || []).find(x => x.name === 'result') : null;
      return !!(result && result.valueBoolean === true);
    });
    if (out.length !== codings.length) {
      throw new Error(`$batch-validate-code answered ${out.length} of ${codings.length}`);
    }
    return out;
  }

  /**
   * One round of the closure job: send the concepts not yet in their closures, and apply what
   * comes back. A queue runner job.
   *
   * Each place a code can be (a resource type's token search parameter: Observation.code and
   * Condition.code are two, though one SearchParameter defines both) has its own closure
   * table on the server, named with a UUID, holding only the codes found there: :below and
   * :above only ever compare codes in one place, and the tables stay small.
   *
   * What the server refuses is marked (ParamConcepts.InClosure = 2) and not sent again: a
   * batch with an unknown code in it is sent again a concept at a time, to find it; a table
   * that is full refuses the rest of the batch. Anything else (the server down, busy) is
   * thrown, and the batch is sent again next round.
   * @param {Object} ep - the Endpoint
   * @returns {Promise<number>} how many concepts were dealt with
   */
  async updateClosure(ep) {
    const db = ep.db;
    const pending = await db.read(q => q.all(`SELECT pc.TypeKey, pc.ParamKey, pc.ConceptKey, c.Code, s.Uri
      FROM ParamConcepts pc JOIN Concepts c ON c.ConceptKey = pc.ConceptKey JOIN Spaces s ON s.SpaceKey = c.SpaceKey
      WHERE pc.InClosure = 0 ORDER BY pc.TypeKey, pc.ParamKey, pc.ConceptKey LIMIT ${CLOSURE_BATCH}`));
    const groups = new Map();
    for (const p of pending) {
      const k = p.TypeKey + '|' + p.ParamKey;
      if (!groups.has(k)) {
        groups.set(k, { typeKey: Number(p.TypeKey), paramKey: Number(p.ParamKey), concepts: [] });
      }
      groups.get(k).concepts.push({ key: Number(p.ConceptKey), system: p.Uri, code: p.Code });
    }
    for (const g of groups.values()) {
      await this.updateOne(ep, g);
    }
    return pending.length;
  }

  async updateOne(ep, g) {
    const closure = await this.closureFor(ep, g.typeKey, g.paramKey);
    const r = await this.sendConcepts(closure.name, g.concepts);
    if (r.status === 200) {
      await this.apply(ep, closure.key, g, g.concepts, r.resource);
      return;
    }
    const why = reason(r);
    if (why === 'CLOSURE_TABLE_UNKNOWN') {
      // the server has lost the table (or it's a different server): start it again
      this.log.warn(`Closure for ${this.where(ep, g)}: the terminology server doesn't know its table any more; rebuilding it`);
      await ep.db.write(async (q) => {
        await q.run('DELETE FROM ClosureEntries WHERE ClosureKey = ?', [closure.key]);
        await q.run('DELETE FROM Closures WHERE ClosureKey = ?', [closure.key]);
        await q.run('UPDATE ParamConcepts SET InClosure = 0 WHERE TypeKey = ? AND ParamKey = ?', [g.typeKey, g.paramKey]);
      });
      return;
    }
    if (r.status === 422 && /^CLOSURE_TOO_MANY/.test(why || '')) {
      // too many: the table is full, or the batch too big for it
      this.log.warn(`Closure for ${this.where(ep, g)}: the terminology server refused ${g.concepts.length} codes (${why || r.status}); :below and :above won't relate them`);
      await this.refuse(ep, g, g.concepts);
      return;
    }
    if (r.status !== 400 && r.status !== 404 && r.status !== 422) {
      throw new Error(`$closure for ${this.where(ep, g)} failed (status ${r.status}${why ? ', ' + why : ''})`);
    }
    // an unknown system (422) or code (404) somewhere in the batch: one at a time
    for (const c of g.concepts) {
      const one = await this.sendConcepts(closure.name, [c]);
      if (one.status === 200) {
        await this.apply(ep, closure.key, g, [c], one.resource);
      } else if (one.status === 400 || one.status === 404 || one.status === 422) {
        this.log.debug(`Closure for ${this.where(ep, g)}: ${c.system}|${c.code} refused (${reason(one) || one.status})`);
        await this.refuse(ep, g, [c]);
      } else {
        throw new Error(`$closure for ${this.where(ep, g)} failed (status ${one.status})`);
      }
    }
  }

  where(ep, g) {
    const type = [...ep.typeKeys.entries()].find(([, k]) => k === g.typeKey);
    const def = ep.definitions && [...ep.definitions.byUrl.values()].find(d => d.key === g.paramKey);
    return `${type ? type[0] : g.typeKey}.${def ? def.code : g.paramKey}`;
  }

  /** The closure for a place, starting it on the server if it's new */
  async closureFor(ep, typeKey, paramKey) {
    const row = await ep.db.read(q => q.get('SELECT ClosureKey, Name FROM Closures WHERE TypeKey = ? AND ParamKey = ?', [typeKey, paramKey]));
    if (row) {
      return { key: Number(row.ClosureKey), name: row.Name };
    }
    const name = crypto.randomUUID();
    const r = await this.client.post('/$closure', { resourceType: 'Parameters', parameter: [{ name: 'name', valueString: name }] });
    if (r.status !== 200) {
      throw new Error(`The terminology server didn't start a closure (status ${r.status}${reason(r) ? ', ' + reason(r) : ''})`);
    }
    const key = await ep.db.write(async (q) => {
      const ins = await q.run('INSERT INTO Closures (Name, Version, TypeKey, ParamKey) VALUES (?, NULL, ?, ?)', [name, typeKey, paramKey]);
      return Number(ins.lastId);
    });
    return { key, name };
  }

  sendConcepts(name, concepts) {
    const params = { resourceType: 'Parameters', parameter: [{ name: 'name', valueString: name }] };
    for (const c of concepts) {
      params.parameter.push({ name: 'concept', valueCoding: { system: c.system, code: c.code } });
    }
    // (no version: $closure adds concepts or resynchronises from a version, never both; the
    // answer to adding concepts is everything new they bring)
    return this.client.post('/$closure', params);
  }

  /** Store the relationships a $closure answer brings, and mark the concepts sent */
  async apply(ep, closureKey, g, concepts, cm) {
    if (!cm || cm.resourceType !== 'ConceptMap') {
      throw new Error('$closure didn\'t return a ConceptMap');
    }
    const pairs = parsePairs(cm);
    await ep.db.write(async (q) => {
      await this.storePairs(ep, q, closureKey, pairs);
      await this.mark(q, g, concepts, 1);
      if (cm.version) {
        await q.run('UPDATE Closures SET Version = ? WHERE ClosureKey = ?', [String(cm.version), closureKey]);
      }
    });
  }

  async storePairs(ep, q, closureKey, pairs) {
    if (!pairs.length) {
      return;
    }
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

  async refuse(ep, g, concepts) {
    await ep.db.write(q => this.mark(q, g, concepts, 2));
  }

  async mark(q, g, concepts, value) {
    const keys = concepts.map(c => c.key);
    await q.run(`UPDATE ParamConcepts SET InClosure = ? WHERE TypeKey = ? AND ParamKey = ? AND ConceptKey IN (${keys.map(() => '?').join(', ')})`,
      [value, g.typeKey, g.paramKey, ...keys]);
  }
}

/** A $closure answer's relationships, as [subsumer, subsumed] pairs */
function parsePairs(cm) {
  const pairs = [];
  for (const grp of cm.group || []) {
    for (const e of grp.element || []) {
      for (const t of e.target || []) {
        const rel = t.equivalence || t.relationship;
        const src = { system: grp.source, code: e.code };
        const tgt = { system: grp.target, code: t.code };
        if (UP.has(rel)) {
          pairs.push([tgt, src]);
        } else if (DOWN.has(rel)) {
          pairs.push([src, tgt]);
        }
      }
    }
  }
  return pairs;
}

/** The message id of the first issue in an OperationOutcome (CLOSURE_TABLE_UNKNOWN...), or its text */
function reason(r) {
  const issue = r && r.resource && Array.isArray(r.resource.issue) ? r.resource.issue[0] : null;
  if (!issue) {
    return null;
  }
  const id = (issue.extension || []).find(e => e.url === 'http://hl7.org/fhir/StructureDefinition/operationoutcome-message-id');
  return id ? id.valueString : (issue.details && issue.details.text) || issue.diagnostics || null;
}

module.exports = { Terminology };
