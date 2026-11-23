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
const { badRequest, notSupported } = require('../library/errors');
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

class SqlBuilder {
  /**
   * @param {Object} ep - the Endpoint
   * @param {Object} q - a query object
   */
  constructor(ep, q) {
    this.ep = ep;
    this.q = q;
    this.n = 0;
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
        const sql = `EXISTS (SELECT 1 FROM Ids ${a} WHERE ${a}.ResourceKey = ${key} AND ${a}.Id IN (${inList(node.ids.length)}))`;
        return { sql: node.negate ? 'NOT ' + sql : sql, args: node.ids };
      }
      case 'lastUpdated': {
        const a = this.alias('z');
        const v = this.alias('zv');
        const parts = node.values.map(x => dateClause({ lo: `${v}.LastUpdated`, hi: `(${v}.LastUpdated + 1)` }, x.prefix, x.range));
        return { sql: `EXISTS (SELECT 1 FROM Ids ${a} JOIN Versions ${v} ON ${v}.VersionKey = ${a}.MostRecent WHERE ${a}.ResourceKey = ${key} AND (${parts.map(p => p.sql).join(' OR ')}))`,
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
        return this.tokenValue(v, x);
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

  async tokenValue(v, x) {
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
        return this.subsumption(v, x);
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

  async subsumption(v, x) {
    const sk = await this.space(v.system);
    if (sk === null) {
      return NOTHING;
    }
    const row = await this.q.get('SELECT ConceptKey FROM Concepts WHERE SpaceKey = ? AND Code = ?', [sk, v.code]);
    if (!row) {
      return NOTHING;
    }
    const ck = Number(row.ConceptKey);
    const ce = this.alias('ce');
    if (v.mode === 'below') {
      return { sql: `(${x}.ConceptKey = ? OR ${x}.ConceptKey IN (SELECT ${ce}.SubsumedKey FROM ClosureEntries ${ce} WHERE ${ce}.SubsumesKey = ?))`, args: [ck, ck] };
    }
    return { sql: `(${x}.ConceptKey = ? OR ${x}.ConceptKey IN (SELECT ${ce}.SubsumesKey FROM ClosureEntries ${ce} WHERE ${ce}.SubsumedKey = ?))`, args: [ck, ck] };
  }

  async inValueSet(v, x) {
    if (!this.ep.terminology) {
      throw notSupported(':in and :not-in need a terminology server (the endpoint\'s txServer setting)');
    }
    const codes = await this.ep.terminology.expand(v.valueSet);
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
        if (v.urlVersion) {
          return { sql: `(${x}.Url = ? AND ${x}.UrlVersion = ?)`, args: [v.url, v.urlVersion] };
        }
        return { sql: `${x}.Url = ?`, args: [v.url] };
    }
    throw badRequest('Unknown reference value');
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
