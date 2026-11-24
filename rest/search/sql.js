//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Turn a search tree (parser.js) into SQL: a condition on a resource key expression. Each
 * parameter is an EXISTS against its index table; a chain joins IndexReferences.TargetKey to
 * the next condition; _has goes the other way. Everything is parameterised.
 *
 * Several values of one parameter are OR'd. A negated value (ne, :not, :not-in) matches when
 * no value of the resource is equal: NOT EXISTS.
 *
 * @module rest/search/sql
 */

const { dateClause, escapeLikeBang } = require('../../library/fhir-search-values');
const { canonicalQuantity, UCUM } = require('../indexing/values');
const { badRequest, notSupported, FhirError } = require('../library/errors');
const { TAG, PROFILE } = require('../store');

const TABLES = {
  string: 'IndexStrings', token: 'IndexTokens', date: 'IndexDates', number: 'IndexNumbers', quantity: 'IndexQuantities',
  reference: 'IndexReferences', uri: 'IndexUris'
};

const NOTHING = { sql: '1 = 0', args: [] };
const EVERYTHING = { sql: '1 = 1', args: [] };

function inList(n) {
  return new Array(n).fill('?').join(', ');
}

// how far :above and :below on a reference follow the hierarchy (a cycle stops here too)
const HIERARCHY_DEPTH = 30;

class SqlBuilder {
  /**
   * @param {Object} ep - the Endpoint
   * @param {Object} q - a query object
   */
  constructor(ep, q) {
    this.ep = ep;
    this.q = q;
    this.n = 0;
    // whether the keys searched include contained resources (-ContainedKey): then _id is the
    // contained resource's local id, and _lastUpdated its container's
    this.contained = false;
    // what the search should be told (a registered value set still being worked out)
    this.warnings = [];
  }

  /** a's ResourceKey is key, or (for a contained resource) its container's */
  selfOrContainer(a, key) {
    if (!this.contained) {
      return `${a}.ResourceKey = ${key}`;
    }
    const ca = this.alias('ca');
    return `(${a}.ResourceKey = ${key} OR ${a}.ResourceKey = (SELECT ${ca}.ResourceKey FROM Contained ${ca} WHERE ${ca}.ContainedKey = -(${key})))`;
  }

  alias(p) {
    return p + (++this.n);
  }

  /**
   * A condition on a resource key.
   * @param {Object} node
   * @param {string} key - the SQL expression for the resource key (i.ResourceKey)
   * @returns {Promise<{sql: string, args: Array}>}
   */
  async build(node, key) {
    switch (node.kind) {
      case 'and': {
        if (!node.items.length) {
          return EVERYTHING;
        }
        const parts = [];
        for (const n of node.items) {
          parts.push(await this.build(n, key));
        }
        return { sql: '(' + parts.map(p => p.sql).join(' AND ') + ')', args: parts.flatMap(p => p.args) };
      }
      case 'or': {
        const parts = [];
        for (const n of node.items) {
          parts.push(await this.build(n, key));
        }
        return { sql: '(' + parts.map(p => p.sql).join(' OR ') + ')', args: parts.flatMap(p => p.args) };
      }
      case 'not': {
        const p = await this.build(node.item, key);
        return { sql: `NOT ${p.sql}`, args: p.args };
      }
      case 'none':
        return NOTHING;
      case 'id': {
        const a = this.alias('z');
        let sql = `EXISTS (SELECT 1 FROM Ids ${a} WHERE ${a}.ResourceKey = ${key} AND ${a}.Id IN (${inList(node.ids.length)}))`;
        let args = node.ids;
        if (this.contained) {
          const ca = this.alias('ca');
          sql = `(${sql} OR EXISTS (SELECT 1 FROM Contained ${ca} WHERE ${ca}.ContainedKey = -(${key}) AND ${ca}.LocalId IN (${inList(node.ids.length)})))`;
          args = [...node.ids, ...node.ids];
        }
        return { sql: node.negate ? 'NOT ' + sql : sql, args };
      }
      case 'lastUpdated': {
        const a = this.alias('z');
        const v = this.alias('zv');
        const parts = node.values.map(x => dateClause({ lo: `${v}.LastUpdated`, hi: `(${v}.LastUpdated + 1)` }, x.prefix, x.range));
        return { sql: `EXISTS (SELECT 1 FROM Ids ${a} JOIN Versions ${v} ON ${v}.VersionKey = ${a}.MostRecent WHERE ${this.selfOrContainer(a, key)} AND (${parts.map(p => p.sql).join(' OR ')}))`,
          args: parts.flatMap(p => p.args) };
      }
      case 'tag':
        return this.tag(node, key);
      case 'tagMissing': {
        const a = this.alias('z');
        const vt = this.alias('vt');
        const tg = this.alias('tg');
        const sql = `EXISTS (SELECT 1 FROM Ids ${a} JOIN VersionTags ${vt} ON ${vt}.VersionKey = ${a}.MostRecent JOIN Tags ${tg} ON ${tg}.TagKey = ${vt}.TagKey WHERE ${a}.ResourceKey = ${key} AND ${tg}.Kind = ?)`;
        return { sql: node.missing ? 'NOT ' + sql : sql, args: [node.tagKind] };
      }
      case 'list':
        return this.list(node, key);
      case 'compartment': {
        const c = this.alias('c');
        return { sql: `EXISTS (SELECT 1 FROM Compartments ${c} WHERE ${c}.ResourceKey = ${key} AND ${c}.CompType = ? AND ${c}.CompId = ?)`, args: [node.type, node.id] };
      }
      case 'missing': {
        if (node.spType === 'composite') {
          return this.compositeMissing(node, key);
        }
        const t = TABLES[node.spType];
        const x = this.alias('x');
        const sql = `EXISTS (SELECT 1 FROM ${t} ${x} WHERE ${x}.ResourceKey = ${key} AND ${x}.ParamKey IN (${inList(node.keys.length)}))`;
        return { sql: node.missing ? 'NOT ' + sql : sql, args: node.keys };
      }
      case 'chain': {
        const r = this.alias('r');
        const inner = await this.build(node.inner, `${r}.TargetKey`);
        let typeCond = '';
        const args = [...node.keys];
        if (node.targetTypes) {
          typeCond = ` AND ${r}.TargetType IN (${inList(node.targetTypes.length)})`;
          args.push(...node.targetTypes);
        }
        return { sql: `EXISTS (SELECT 1 FROM IndexReferences ${r} WHERE ${r}.ResourceKey = ${key} AND ${r}.ParamKey IN (${inList(node.keys.length)})${typeCond} AND ${r}.TargetKey IS NOT NULL AND ${inner.sql})`,
          args: [...args, ...inner.args] };
      }
      case 'has': {
        const r = this.alias('r');
        const o = this.alias('o');
        const inner = await this.build(node.inner, `${r}.ResourceKey`);
        return { sql: `EXISTS (SELECT 1 FROM IndexReferences ${r} JOIN Ids ${o} ON ${o}.ResourceKey = ${r}.ResourceKey WHERE ${r}.TargetKey = ${key} AND ${r}.ParamKey IN (${inList(node.keys.length)}) AND ${o}.TypeKey = ? AND ${o}.Deleted = 0 AND ${inner.sql})`,
          args: [...node.keys, node.typeKey, ...inner.args] };
      }
      case 'param':
        return this.param(node, key);
      case 'fulltext':
        return require('../indexing/fulltext').condition(this.q.dialect.name, key, node.column, node.tree);
    }
    throw new Error(`Unknown search node ${node.kind}`);
  }

  async tag(node, key) {
    const a = this.alias('z');
    const vt = this.alias('vt');
    const tg = this.alias('tg');
    const conds = [];
    const args = [node.tagKind];
    for (const v of node.values) {
      if (node.tagKind === PROFILE && v.below) {
        conds.push(`${tg}.Code LIKE ? ESCAPE '!'`);
        args.push(escapeLikeBang(v.code) + '%');
      } else if (v.system === undefined) {
        conds.push(`${tg}.Code = ?`);
        args.push(v.code);
      } else if (v.code === undefined) {
        conds.push(`${tg}.TagSystem = ?`);
        args.push(v.system);
      } else {
        conds.push(`(${tg}.TagSystem = ? AND ${tg}.Code = ?)`);
        args.push(v.system || '', v.code);
      }
    }
    const sql = `EXISTS (SELECT 1 FROM Ids ${a} JOIN VersionTags ${vt} ON ${vt}.VersionKey = ${a}.MostRecent JOIN Tags ${tg} ON ${tg}.TagKey = ${vt}.TagKey WHERE ${a}.ResourceKey = ${key} AND ${tg}.Kind = ? AND (${conds.join(' OR ')}))`;
    return { sql: node.negate ? 'NOT ' + sql : sql, args };
  }

  async list(node, key) {
    const listType = this.ep.typeKeys.get('List');
    const item = this.ep.definitions.param('List', 'item');
    if (listType === undefined || !item || item.key === null) {
      throw notSupported('_list needs the List resource and its item search parameter');
    }
    const r = this.alias('r');
    const l = this.alias('l');
    return { sql: `EXISTS (SELECT 1 FROM IndexReferences ${r} JOIN Ids ${l} ON ${l}.ResourceKey = ${r}.ResourceKey WHERE ${l}.TypeKey = ? AND ${l}.Id = ? AND ${l}.Deleted = 0 AND ${r}.ParamKey = ? AND ${r}.TargetKey = ${key})`,
      args: [listType, node.id, item.key] };
  }

  async compositeMissing(node, key) {
    const x = this.alias('x');
    const subs = Object.values(TABLES).map(t => `SELECT 1 FROM ${t} ${x}${t} WHERE ${x}${t}.ResourceKey = ${key} AND ${x}${t}.ParamKey IN (${inList(node.keys.length)})`);
    const sql = `EXISTS (${subs.join(' UNION ALL ')})`;
    return { sql: node.missing ? 'NOT ' + sql : sql, args: Object.values(TABLES).flatMap(() => node.keys) };
  }

  /**
   * One parameter: positive values in one EXISTS, each negated value in a NOT EXISTS.
   */
  async param(node, key) {
    if (node.spType === 'composite') {
      return this.composite(node, key);
    }
    const t = TABLES[node.spType];
    const pos = [];
    const neg = [];
    for (const v of node.values) {
      const x = this.alias('x');
      const c = await this.value(node.spType, node, v, x);
      (v.negate ? neg : pos).push({ x, c });
    }
    const parts = [];
    const args = [];
    const sub = (x, c) => `SELECT 1 FROM ${t} ${x} WHERE ${x}.ResourceKey = ${key} AND ${x}.ParamKey IN (${inList(node.keys.length)}) AND ${c.sql}`;
    if (pos.length) {
      // one EXISTS per value keeps each value's join simple; OR'd
      for (const { x, c } of pos) {
        parts.push(`EXISTS (${sub(x, c)})`);
        args.push(...node.keys, ...c.args);
      }
    }
    for (const { x, c } of neg) {
      parts.push(`NOT EXISTS (${sub(x, c)})`);
      args.push(...node.keys, ...c.args);
    }
    return { sql: '(' + parts.join(' OR ') + ')', args };
  }

  /**
   * The condition on an index row (alias x) for one value.
   */
  async value(spType, node, v, x) {
    switch (spType) {
      case 'string':
        return this.stringValue(v, x);
      case 'token':
        return this.tokenValue(v, x, node);
      case 'date':
        return dateClause({ lo: `${x}.Lo`, hi: `${x}.Hi` }, v.prefix, v.range);
      case 'number':
        return this.numberClause(`${x}.Value`, v);
      case 'quantity':
        return this.quantityValue(v, x);
      case 'reference':
        return this.referenceValue(node, v, x);
      case 'uri':
        return this.uriValue(v, x);
    }
    throw badRequest(`Search parameters of type ${spType} are not supported`);
  }

  stringValue(v, x) {
    switch (v.mode) {
      case 'exact': return { sql: `${x}.Exact = ?`, args: [v.text] };
      case 'contains': return { sql: `${x}.Norm LIKE ? ESCAPE '!'`, args: ['%' + escapeLikeBang(v.norm) + '%'] };
      case 'end': return { sql: `${x}.Norm LIKE ? ESCAPE '!'`, args: ['%' + escapeLikeBang(v.norm)] };
      case 'eqnorm': return { sql: `${x}.Norm = ?`, args: [v.norm] };
      case 'gt': return { sql: `${x}.Norm > ?`, args: [v.norm] };
      case 'lt': return { sql: `${x}.Norm < ?`, args: [v.norm] };
      case 'ge': return { sql: `${x}.Norm >= ?`, args: [v.norm] };
      case 'le': return { sql: `${x}.Norm <= ?`, args: [v.norm] };
      default: return { sql: `${x}.Norm LIKE ? ESCAPE '!'`, args: [escapeLikeBang(v.norm) + '%'] };
    }
  }

  async space(uri) {
    return this.ep.lookups.spaceKey(this.q, uri);
  }

  async tokenValue(v, x, node) {
    switch (v.mode) {
      case 'text':
        return { sql: `${x}.TextNorm LIKE ? ESCAPE '!'`, args: [escapeLikeBang(v.norm) + '%'] };
      case 'of-type': {
        const sk = await this.space(v.typeSystem);
        if (sk === null) {
          return NOTHING;
        }
        return { sql: `(${x}.TypeSpaceKey = ? AND ${x}.TypeCode = ? AND ${x}.Code = ?)`, args: [sk, v.typeCode, v.code] };
      }
      case 'below':
      case 'above':
        return this.subsumption(v, x, node);
      case 'in':
        return this.inValueSet(v, x);
    }
    if (v.system === undefined) {
      return { sql: `${x}.Code = ?`, args: [v.code] };
    }
    if (v.system === null) {
      return { sql: `(${x}.SpaceKey IS NULL AND ${x}.Implicit = 0 AND ${x}.Code = ?)`, args: [v.code] };
    }
    const sk = await this.space(v.system);
    if (v.code === undefined) {
      return sk === null ? NOTHING : { sql: `${x}.SpaceKey = ?`, args: [sk] };
    }
    if (sk === null) {
      // the system is not known, but a code with an implicit system (a code element) can match
      return { sql: `(${x}.Implicit = 1 AND ${x}.Code = ?)`, args: [v.code] };
    }
    return { sql: `((${x}.SpaceKey = ? OR ${x}.Implicit = 1) AND ${x}.Code = ?)`, args: [sk, v.code] };
  }

  /**
   * :below and :above: the code, and what the closure tables relate it to. A code that isn't
   * in the closure table of a place searched is added to it now (Terminology.relateSearched),
   * and what the server says about it is used directly: the closure table in the database
   * only has it once that is written, after the search.
   */
  async subsumption(v, x, node) {
    const sk = await this.space(v.system);
    const row = sk === null ? null : await this.q.get('SELECT ConceptKey FROM Concepts WHERE SpaceKey = ? AND Code = ?', [sk, v.code]);
    const ck = row ? Number(row.ConceptKey) : null;
    const parts = [];
    const args = [];
    if (ck !== null) {
      const ce = this.alias('ce');
      parts.push(`${x}.ConceptKey = ?`);
      parts.push(v.mode === 'below'
        ? `${x}.ConceptKey IN (SELECT ${ce}.SubsumedKey FROM ClosureEntries ${ce} WHERE ${ce}.SubsumesKey = ?)`
        : `${x}.ConceptKey IN (SELECT ${ce}.SubsumesKey FROM ClosureEntries ${ce} WHERE ${ce}.SubsumedKey = ?)`);
      args.push(ck, ck);
    }
    if (this.ep.terminology && node && node.places && node.places.length) {
      const pairs = await this.ep.terminology.relateSearched(this.ep, this.q, node.places, v.system, v.code, ck);
      const related = pairs.map(([up, down]) => v.mode === 'below'
        ? (up.system === v.system && up.code === v.code ? down : null)
        : (down.system === v.system && down.code === v.code ? up : null)).filter(c => c);
      if (related.length) {
        const spaces = await this.ep.lookups.spaceKeys(this.q, related.map(c => c.system), false);
        const keys = await this.ep.lookups.conceptKeys(this.q, related.filter(c => spaces.get(c.system)).map(c => [spaces.get(c.system), c.code]), false);
        const list = [...new Set(keys.values())];
        if (list.length) {
          parts.push(`${x}.ConceptKey IN (${inList(list.length)})`);
          args.push(...list);
        }
      }
    }
    return parts.length ? { sql: '(' + parts.join(' OR ') + ')', args } : NOTHING;
  }

  /**
   * :in and :not-in. A value set an administrator has registered for searching (whatever the
   * version asked for) is searched by membership (ValueSetMembers, worked out in the
   * background: terminology.js); any other is expanded, if it isn't too big or unclosed.
   */
  async inValueSet(v, x) {
    const url = String(v.valueSet).split('|')[0];
    const reg = await this.q.get('SELECT ValueSetKey, Status FROM ValueSets WHERE Url = ?', [url]);
    if (reg) {
      return this.inRegistered(v, x, url, reg);
    }
    if (!this.ep.terminology) {
      throw notSupported(':in and :not-in need a terminology server (the endpoint\'s txServer setting)');
    }
    const codes = await this.ep.terminology.expand(v.valueSet, this.expandOptions());
    return this.inCodes(codes, x);
  }

  expandOptions() {
    return { limit: this.ep.settings.maxValueSetExpansion || 10000, adminPath: this.ep.path + '/_admin/valuesets' };
  }

  async inRegistered(v, x, url, reg) {
    if (!Number(reg.Status)) {
      const w = `The value set ${url} is still being prepared for searching: results may be incomplete`;
      if (!this.warnings.includes(w)) {
        this.warnings.push(w);
      }
    }
    const m = this.alias('vm');
    const parts = [`${x}.ConceptKey IN (SELECT ${m}.ConceptKey FROM ValueSetMembers ${m} WHERE ${m}.ValueSetKey = ? AND ${m}.Member = 1)`];
    const args = [Number(reg.ValueSetKey)];
    // code elements (no system in the resource, so no concept) only by expanding it, when it can be
    if (this.ep.terminology) {
      try {
        const codes = await this.ep.terminology.expand(v.valueSet, this.expandOptions());
        const implicit = this.implicitCodes(codes, x);
        parts.push(...implicit.parts);
        args.push(...implicit.args);
      } catch (e) {
        if (!(e instanceof FhirError)) {
          throw e;
        }
      }
    }
    return { sql: '(' + parts.join(' OR ') + ')', args };
  }

  implicitCodes(codes, x) {
    const parts = [];
    const args = [];
    const all = [...new Set(codes.map(c => c.code))];
    for (let i = 0; i < all.length; i += 1000) {
      const c = all.slice(i, i + 1000);
      parts.push(`(${x}.Implicit = 1 AND ${x}.Code IN (${inList(c.length)}))`);
      args.push(...c);
    }
    return { parts, args };
  }

  async inCodes(codes, x) {
    const bySystem = new Map();
    for (const c of codes) {
      if (!bySystem.has(c.system)) {
        bySystem.set(c.system, []);
      }
      bySystem.get(c.system).push(c.code);
    }
    const parts = [];
    const args = [];
    for (const [system, list] of bySystem) {
      const sk = await this.space(system);
      if (sk === null) {
        continue;
      }
      for (let i = 0; i < list.length; i += 1000) {
        const c = list.slice(i, i + 1000);
        parts.push(`(${x}.SpaceKey = ? AND ${x}.Code IN (${inList(c.length)}))`);
        args.push(sk, ...c);
      }
    }
    // a code element has no system in the resource (its system is implied by its binding):
    // it matches on the code, as for a plain token search
    const implicit = this.implicitCodes(codes, x);
    parts.push(...implicit.parts);
    args.push(...implicit.args);
    return parts.length ? { sql: '(' + parts.join(' OR ') + ')', args } : NOTHING;
  }

  numberClause(col, v) {
    switch (v.prefix) {
      case 'eq': return { sql: `(${col} >= ? AND ${col} < ?)`, args: [v.lo, v.hi] };
      case 'ne': return { sql: `NOT (${col} >= ? AND ${col} < ?)`, args: [v.lo, v.hi] };
      case 'gt': return { sql: `${col} > ?`, args: [v.value] };
      case 'lt': return { sql: `${col} < ?`, args: [v.value] };
      case 'ge': return { sql: `${col} >= ?`, args: [v.value] };
      case 'le': return { sql: `${col} <= ?`, args: [v.value] };
      case 'sa': return { sql: `${col} >= ?`, args: [v.hi] };
      case 'eb': return { sql: `${col} < ?`, args: [v.lo] };
      case 'ap': {
        const w = Math.max(Math.abs(v.value) * 0.1, v.hi - v.lo);
        return { sql: `(${col} >= ? AND ${col} <= ?)`, args: [v.value - w, v.value + w] };
      }
    }
    throw badRequest(`Unknown prefix ${v.prefix}`);
  }

  async quantityValue(v, x) {
    if (v.system === UCUM && v.unit) {
      const lo = canonicalQuantity(v.unit, v.lo);
      const hi = canonicalQuantity(v.unit, v.hi);
      const val = canonicalQuantity(v.unit, v.value);
      if (lo && hi && val) {
        const cv = { prefix: v.prefix, lo: Math.min(lo.value, hi.value), hi: Math.max(lo.value, hi.value), value: val.value };
        const c = this.numberClause(`((${x}.CanonLo + ${x}.CanonHi) / 2)`, cv);
        return { sql: `(${x}.CanonUnit = ? AND ${c.sql})`, args: [lo.unit, ...c.args] };
      }
    }
    const c = this.numberClause(`${x}.Value`, v);
    const conds = [c.sql];
    const args = [...c.args];
    if (v.system) {
      const sk = await this.space(v.system);
      if (sk === null) {
        return NOTHING;
      }
      conds.push(`${x}.SpaceKey = ?`);
      args.push(sk);
    }
    if (v.unit) {
      conds.push(`${x}.Unit = ?`);
      args.push(v.unit);
    }
    return { sql: '(' + conds.join(' AND ') + ')', args };
  }

  async referenceValue(node, v, x) {
    switch (v.mode) {
      case 'nothing':
        return NOTHING;
      case 'identifier': {
        if (v.system === undefined) {
          return { sql: `${x}.IdentValue = ?`, args: [v.value] };
        }
        const sk = v.system ? await this.space(v.system) : null;
        if (v.system && sk === null) {
          return NOTHING;
        }
        return v.system ? { sql: `(${x}.IdentSpaceKey = ? AND ${x}.IdentValue = ?)`, args: [sk, v.value] }
          : { sql: `(${x}.IdentSpaceKey IS NULL AND ${x}.IdentValue = ?)`, args: [v.value] };
      }
      case 'local': {
        const conds = [`${x}.TargetId = ?`];
        const args = [v.id];
        const type = v.type || (node.modifier && node.modifier !== 'missing' ? node.modifier : null);
        if (type) {
          conds.push(`${x}.TargetType = ?`);
          args.push(type);
        }
        if (v.version) {
          conds.push(`${x}.TargetVersion = ?`);
          args.push(v.version);
        }
        return { sql: '(' + conds.join(' AND ') + ')', args };
      }
      case 'url':
        if (v.urlVersion && v.hierarchy === 'below') {
          // the version, or any below it: 1.2 is 1.2, 1.2.0, 1.2.3...
          return { sql: `(${x}.Url = ? AND (${x}.UrlVersion = ? OR ${x}.UrlVersion LIKE ? ESCAPE '!'))`,
            args: [v.url, v.urlVersion, escapeLikeBang(v.urlVersion) + '.%'] };
        }
        if (v.urlVersion && v.hierarchy === 'above') {
          // the version, or any above it: 1.2.3 is 1.2.3, 1.2, 1 (and no version at all)
          return { sql: `(${x}.Url = ? AND (${x}.UrlVersion IS NULL OR ${x}.UrlVersion = ? OR ? LIKE ${this.q.dialect.concat(`${x}.UrlVersion`, '\'.%\'')}))`,
            args: [v.url, v.urlVersion, v.urlVersion] };
        }
        if (v.urlVersion) {
          return { sql: `(${x}.Url = ? AND ${x}.UrlVersion = ?)`, args: [v.url, v.urlVersion] };
        }
        // no version: any version (with or without :below)
        return { sql: `${x}.Url = ?`, args: [v.url] };
      case 'hierarchy':
        return this.hierarchy(v, x);
    }
    throw badRequest('Unknown reference value');
  }

  /**
   * :below and :above on a reference: the resource named, and everything below (or above) it
   * in its hierarchy, by a recursive query over the hierarchy's references (IndexReferences:
   * Location.partOf), to HIERARCHY_DEPTH levels (which also ends a cycle).
   */
  hierarchy(v, x) {
    const h = this.alias('h');
    const r = this.alias('hr');
    const i = this.alias('hi');
    const typeKeys = v.types.map(t => this.ep.typeKeys.get(t));
    const step = v.hierarchy === 'below'
      // what is part of something already in the set
      ? `SELECT ${r}.ResourceKey, ${h}.D + 1 FROM IndexReferences ${r} JOIN ${h} ON ${r}.TargetKey = ${h}.K WHERE ${r}.ParamKey IN (${inList(v.keys.length)}) AND ${h}.D < ${HIERARCHY_DEPTH}`
      // what something already in the set is part of
      : `SELECT ${r}.TargetKey, ${h}.D + 1 FROM IndexReferences ${r} JOIN ${h} ON ${r}.ResourceKey = ${h}.K WHERE ${r}.ParamKey IN (${inList(v.keys.length)}) AND ${r}.TargetKey IS NOT NULL AND ${h}.D < ${HIERARCHY_DEPTH}`;
    const cte = `WITH RECURSIVE ${h} (K, D) AS (SELECT ${i}.ResourceKey, 0 FROM Ids ${i} WHERE ${i}.TypeKey IN (${inList(typeKeys.length)}) AND ${i}.Id = ? AND ${i}.Deleted = 0 ` +
      `UNION ${step}) SELECT K FROM ${h}`;
    return { sql: `${x}.TargetKey IN (${cte})`, args: [...typeKeys, v.id, ...v.keys] };
  }

  uriValue(v, x) {
    switch (v.mode) {
      case 'below': return { sql: `${x}.Value LIKE ? ESCAPE '!'`, args: [escapeLikeBang(v.value) + '%'] };
      case 'contains': return { sql: `${x}.Value LIKE ? ESCAPE '!'`, args: ['%' + escapeLikeBang(v.value) + '%'] };
      case 'above': return { sql: `? LIKE ${this.q.dialect.concat(`${x}.Value`, '\'%\'')}`, args: [v.value] };
      default: return { sql: `${x}.Value = ?`, args: [v.value] };
    }
  }

  /**
   * A composite: the components' rows share ResourceKey, ParamKey and GroupNo.
   */
  async composite(node, key) {
    const parts = [];
    const args = [];
    for (const v of node.values) {
      const aliases = v.comps.map(() => this.alias('k'));
      const froms = [];
      const conds = [];
      const cargs = [];
      for (let i = 0; i < v.comps.length; i++) {
        const comp = v.comps[i];
        const a = aliases[i];
        const t = TABLES[comp.spType];
        if (i === 0) {
          froms.push(`${t} ${a}`);
        } else {
          froms.push(`JOIN ${t} ${a} ON ${a}.ResourceKey = ${aliases[0]}.ResourceKey AND ${a}.ParamKey = ${aliases[0]}.ParamKey AND ${a}.GroupNo = ${aliases[0]}.GroupNo AND ${a}.Comp = ${i}`);
        }
        const c = await this.value(comp.spType, { modifier: null }, comp.value, a);
        conds.push(c.sql);
        cargs.push(...c.args);
      }
      parts.push(`EXISTS (SELECT 1 FROM ${froms.join(' ')} WHERE ${aliases[0]}.ResourceKey = ${key} AND ${aliases[0]}.ParamKey IN (${inList(node.keys.length)}) AND ${aliases[0]}.Comp = 0 AND ${conds.join(' AND ')})`);
      args.push(...node.keys, ...cargs);
    }
    return { sql: '(' + parts.join(' OR ') + ')', args };
  }
}

module.exports = { SqlBuilder, TABLES, NOTHING, EVERYTHING, TAG };
