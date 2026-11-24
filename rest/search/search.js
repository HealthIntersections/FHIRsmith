//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Search: parse (parser.js), build one query over Ids (sql.js), run it once sorted, and
 * keep the matching keys in SearchEntries when they need more than one page. Any process can
 * serve any page, since the results are in the database; a page is only served to the user
 * who ran the search.
 *
 * Paging links are [base]?_getpages=[id]&_offset=[n]&_count=[n]. A page shows each
 * resource's current version; one deleted since the search ran is left out.
 *
 * @module rest/search/search
 */

const crypto = require('crypto');
const { SearchParser } = require('./parser');
const { SqlBuilder } = require('./sql');
const { badRequest, notFound, FhirError } = require('../library/errors');
const { param, strict } = require('../request');

// the most resources _include and _revinclude add to one page
const MAX_INCLUDES = 1000;
const INCLUDE_ROUNDS = 3;

const SORT_COLUMNS = {
  string: ['IndexStrings', 'Norm', 'Norm'],
  token: ['IndexTokens', 'Code', 'Code'],
  date: ['IndexDates', 'Lo', 'Hi'],
  number: ['IndexNumbers', 'Value', 'Value'],
  quantity: ['IndexQuantities', 'Value', 'Value'],
  reference: ['IndexReferences', 'TargetId', 'TargetId'],
  uri: ['IndexUris', 'Value', 'Value']
};

function newSearchId() {
  return crypto.randomBytes(16).toString('base64url').substring(0, 22);
}

function userIdOf(principal) {
  return principal ? String(principal.id ?? principal.login) : null;
}

function queryString(params) {
  return params.map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('&');
}

class Searcher {
  constructor(ep) {
    this.ep = ep;
  }

  /** The types a request searches */
  typesFor(freq) {
    const ep = this.ep;
    let types;
    if (freq.type) {
      ep.checkType(freq.type, 'search-type');
      types = [freq.type];
    } else {
      const t = freq.params.filter(([n]) => n === '_type').flatMap(([, v]) => v.split(',')).map(s => s.trim()).filter(s => s);
      if (t.length) {
        for (const x of t) {
          ep.checkType(x, 'search-type');
        }
        types = [...new Set(t)];
      } else {
        types = [...ep.typeKeys.keys()].filter(x => ep.typeSupported(x));
      }
    }
    if (freq.compartment) {
      const c = ep.definitions.compartments.get(freq.compartment.type);
      if (!c) {
        throw badRequest(`${freq.compartment.type} is not a compartment`);
      }
      if (freq.type && !c.has(freq.type) && freq.type !== freq.compartment.type) {
        throw badRequest(`${freq.type} is not in the ${freq.compartment.type} compartment`);
      }
      types = types.filter(t => c.has(t) || t === freq.compartment.type);
    }
    return types;
  }

  /**
   * Parse and build the query for a search: SELECT ... FROM ${from} WHERE ${where}, with
   * fromArgs then args. What is searched is "i": Ids, or with _contained=true or both, the
   * contained resources (Contained, as Ids-like rows keyed -ContainedKey, with their container's
   * MostRecent and Deleted) in place of or as well as them. i.ContainerKey is the resource
   * itself, or a contained resource's container: compartments, and access, go by that.
   * @returns {Promise<{from: string, fromArgs: Array, where: string, args: Array, containerKey: string, parsed: Object, types: string[]}>}
   */
  async prepare(q, types, params, options) {
    const ep = this.ep;
    const parsed = new SearchParser(ep).parse({ types, params, strict: options.strict });
    const mode = options.noContained ? 'false' : parsed.control.contained;
    const all = [...ep.typeKeys.keys()].filter(t => ep.typeSupported(t));
    const typeKeys = types.length < all.length ? types.map(t => ep.typeKeys.get(t)) : null;
    const typeIn = (col) => typeKeys === null ? '' : typeKeys.length === 0 ? ' WHERE 1 = 0' : ` WHERE ${col} IN (${typeKeys.map(() => '?').join(', ')})`;
    let from = 'Ids i';
    const fromArgs = [];
    let containerKey = 'i.ResourceKey';
    if (mode !== 'false') {
      const branches = [];
      if (mode === 'both') {
        branches.push('SELECT ResourceKey AS ResourceKey, TypeKey AS TypeKey, Id AS Id, MostRecent AS MostRecent, Deleted AS Deleted, ResourceKey AS ContainerKey FROM Ids' + typeIn('TypeKey'));
        fromArgs.push(...(typeKeys || []));
      }
      branches.push('SELECT -c.ContainedKey AS ResourceKey, c.TypeKey AS TypeKey, c.LocalId AS Id, ci.MostRecent AS MostRecent, ci.Deleted AS Deleted, ' +
        'c.ResourceKey AS ContainerKey FROM Contained c JOIN Ids ci ON ci.ResourceKey = c.ResourceKey' + typeIn('c.TypeKey'));
      fromArgs.push(...(typeKeys || []));
      from = `(${branches.join(' UNION ALL ')}) i`;
      containerKey = 'i.ContainerKey';
    }
    const b = new SqlBuilder(ep, q);
    b.contained = mode !== 'false';
    const items = [...parsed.criteria.items];
    const crit = await b.build({ kind: 'and', items }, 'i.ResourceKey');
    const where = ['i.Deleted = 0', 'i.MostRecent IS NOT NULL'];
    const args = [];
    if (typeKeys !== null) {
      if (typeKeys.length === 0) {
        where.push('1 = 0');
      } else {
        where.push(`i.TypeKey IN (${typeKeys.map(() => '?').join(', ')})`);
        args.push(...typeKeys);
      }
    }
    if (crit.sql !== '1 = 1') {
      where.push(crit.sql);
      args.push(...crit.args);
    }
    if (options.compartment) {
      const c = await b.build({ kind: 'compartment', type: options.compartment.type, id: options.compartment.id }, containerKey);
      where.push(c.sql);
      args.push(...c.args);
    }
    const comp = ep.compartmentFilter(options.access, containerKey);
    if (comp) {
      where.push(comp.sql);
      args.push(...comp.args);
    }
    return { from, fromArgs, where: where.join(' AND '), args, containerKey, mode, parsed, types };
  }

  orderBy(sort) {
    const parts = [];
    for (const s of sort) {
      const dir = s.desc ? 'DESC' : 'ASC';
      if (s.code === '_id') {
        parts.push(`i.Id ${dir}`);
      } else if (s.code === '_lastUpdated') {
        parts.push(`(SELECT sv.LastUpdated FROM Versions sv WHERE sv.VersionKey = i.MostRecent) ${dir}`);
      } else {
        const [table, asc, desc] = SORT_COLUMNS[s.spType];
        const col = s.desc ? `MAX(so.${desc})` : `MIN(so.${asc})`;
        // the keys are numbers from the database: safe to put in the SQL
        parts.push(`(SELECT ${col} FROM ${table} so WHERE so.ResourceKey = i.ResourceKey AND so.ParamKey IN (${s.keys.map(Number).join(', ')})) ${dir}`);
      }
    }
    parts.push('i.ResourceKey ASC');
    return 'ORDER BY ' + parts.join(', ');
  }

  /**
   * The keys of the resources matching criteria (conditional interactions).
   * @returns {Promise<number[]>}
   */
  async matchKeys(q, type, params, options = {}) {
    const p = await this.prepare(q, [type], params, { access: options.access, strict: options.strict, noContained: true });
    if (p.parsed.used.length === 0 && p.parsed.criteria.items.length === 0) {
      throw badRequest('The search criteria have no parameters this server knows');
    }
    const rows = await q.all(`SELECT i.ResourceKey FROM Ids i WHERE ${p.where} ORDER BY i.ResourceKey LIMIT ${Number(options.limit || 2)}`, p.args);
    return rows.map(r => Number(r.ResourceKey));
  }

  /**
   * A search interaction.
   */
  async search(freq, ctx) {
    const ep = this.ep;
    if (param(freq, '_getpages') !== undefined) {
      return this.page(freq, ctx);
    }
    const types = this.typesFor(freq);
    const max = ep.settings.searchMaxResults;
    const prepared = await ep.inRead(ctx, async (q) => {
      const p = await this.prepare(q, types, freq.params, { access: ctx.access, strict: strict(freq), compartment: freq.compartment });
      const control = p.parsed.control;
      const count = control.count === null ? ep.settings.defaultCount : Math.min(control.count, ep.settings.maxCount);
      // a contained resource that matches brings back its container, once, unless
      // _containedType=contained asks for the contained resource itself
      const containers = p.mode !== 'false' && control.containedType === 'container';
      const countSql = `SELECT COUNT(${containers ? 'DISTINCT i.ContainerKey' : '*'}) AS N FROM ${p.from} WHERE ${p.where}`;
      const allArgs = [...p.fromArgs, ...p.args];
      if (control.summary === 'count' || count === 0) {
        const row = await q.get(countSql, allArgs);
        return { p, count, keys: [], total: Number(row.N), countOnly: true };
      }
      const rows = await q.all(`SELECT i.ResourceKey, ${p.containerKey} AS ContainerKey FROM ${p.from} WHERE ${p.where} ${this.orderBy(control.sort)} LIMIT ${max + 1}`, allArgs);
      const truncated = rows.length > max;
      let keys = rows.slice(0, max).map(r => Number(containers ? r.ContainerKey : r.ResourceKey));
      if (containers) {
        keys = [...new Set(keys)];
      }
      let total = null;
      if (truncated) {
        if (control.total === 'accurate') {
          const row = await q.get(countSql, allArgs);
          total = Number(row.N);
        }
      } else if (control.total !== 'none') {
        total = keys.length;
      }
      return { p, count, keys, total, truncated };
    });
    const { p, count, keys, total } = prepared;
    const warnings = [...p.parsed.warnings];
    if (prepared.truncated) {
      warnings.push(`The search matched more than ${max} resources: only the first ${max} can be paged through`);
    }
    const control = p.parsed.control;
    const self = this.selfLink(freq, p.parsed.used, types);
    if (prepared.countOnly) {
      const bundle = { resourceType: 'Bundle', type: 'searchset', total: prepared.total, link: [{ relation: 'self', url: self }] };
      if (warnings.length) {
        bundle.entry = [this.outcomeEntry(warnings)];
      }
      return { status: 200, resource: bundle };
    }
    let searchId = null;
    if (keys.length > count) {
      searchId = newSearchId();
      const stored = { types, used: p.parsed.used, control: { include: control.include, revinclude: control.revinclude, summary: control.summary, elements: control.elements },
        self, warnings: p.parsed.warnings };
      await ep.inWrite(ctx, async (q) => {
        const now = Date.now();
        const r = await q.run('INSERT INTO Searches (SearchId, Query, Total, StoredCount, UserId, Created, Expires) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [searchId, JSON.stringify(stored), total, keys.length, userIdOf(freq.principal), now, now + ep.settings.searchKeepMinutes * 60000]);
        const sk = Number(r.lastId);
        for (let i = 0; i < keys.length; i += 500) {
          const c = keys.slice(i, i + 500);
          await q.run('INSERT INTO SearchEntries (SearchKey, Pos, ResourceKey) VALUES ' + c.map(() => '(?, ?, ?)').join(', '),
            c.flatMap((k, j) => [sk, i + j, k]));
        }
      });
    }
    return this.buildPage(freq, ctx, { keys: keys.slice(0, count), offset: 0, count, stored: keys.length, total, searchId, self,
      control, warnings });
  }

  selfLink(freq, used, types) {
    const path = freq.segments.filter(s => s !== '_search').map(encodeURIComponent).join('/');
    const params = [...used];
    if (!freq.type && !params.some(([n]) => n === '_type') && freq.params.some(([n]) => n === '_type')) {
      params.push(['_type', types.join(',')]);
    }
    const qs = queryString(params);
    return `${freq.base}${path ? '/' + path : ''}${qs ? '?' + qs : ''}`;
  }

  /** A later page of a stored search */
  async page(freq, ctx) {
    const ep = this.ep;
    const id = param(freq, '_getpages');
    const offsetText = param(freq, '_offset') || '0';
    const countText = param(freq, '_count');
    if (!/^\d+$/.test(offsetText) || (countText !== undefined && !/^\d+$/.test(countText))) {
      throw badRequest('_offset and _count must be numbers');
    }
    const offset = Number(offsetText);
    const count = Math.min(countText === undefined ? ep.settings.defaultCount : Number(countText), ep.settings.maxCount) || ep.settings.defaultCount;
    const found = await ep.inRead(ctx, async (q) => {
      const s = await q.get('SELECT SearchKey, Query, Total, StoredCount, UserId, Expires FROM Searches WHERE SearchId = ?', [String(id)]);
      if (!s || Number(s.Expires) < Date.now() || (s.UserId || null) !== userIdOf(freq.principal)) {
        return null;
      }
      const rows = await q.all('SELECT ResourceKey FROM SearchEntries WHERE SearchKey = ? AND Pos >= ? AND Pos < ? ORDER BY Pos',
        [s.SearchKey, offset, offset + count]);
      return { s, keys: rows.map(r => Number(r.ResourceKey)) };
    });
    if (!found) {
      throw new FhirError(404, 'not-found', `The search ${id} has expired, or is not known`);
    }
    const stored = JSON.parse(found.s.Query);
    return this.buildPage(freq, ctx, { keys: found.keys, offset, count, stored: Number(found.s.StoredCount),
      total: found.s.Total === null ? null : Number(found.s.Total), searchId: String(id), self: stored.self, control: stored.control,
      warnings: stored.warnings || [], paged: true });
  }

  outcomeEntry(warnings) {
    return {
      resource: { resourceType: 'OperationOutcome', issue: warnings.map(w => ({ severity: 'warning', code: 'processing', diagnostics: w })) },
      search: { mode: 'outcome' }
    };
  }

  async buildPage(freq, ctx, pg) {
    const ep = this.ep;
    const { found, included } = await ep.inRead(ctx, async (q) => {
      const f = await this.byKeys(q, pg.keys);
      const inc = await this.includes(q, f, pg.control, ctx.access);
      return { found: f, included: inc };
    });
    const bundle = { resourceType: 'Bundle', type: 'searchset' };
    if (pg.total !== null && pg.total !== undefined) {
      bundle.total = pg.total;
    }
    const pageUrl = (offset) => `${freq.base}?${queryString([['_getpages', pg.searchId], ['_offset', String(offset)], ['_count', String(pg.count)]])}`;
    bundle.link = [{ relation: 'self', url: pg.paged ? pageUrl(pg.offset) : pg.self }];
    if (pg.searchId) {
      const last = Math.max(0, Math.floor((pg.stored - 1) / pg.count) * pg.count);
      bundle.link.push({ relation: 'first', url: pageUrl(0) });
      if (pg.offset > 0) {
        bundle.link.push({ relation: 'previous', url: pageUrl(Math.max(0, pg.offset - pg.count)) });
      }
      if (pg.offset + pg.count < pg.stored) {
        bundle.link.push({ relation: 'next', url: pageUrl(pg.offset + pg.count) });
      }
      bundle.link.push({ relation: 'last', url: pageUrl(last) });
    }
    const shapeControl = { summary: pg.control.summary, elements: pg.control.elements };
    bundle.entry = found.map(r => ({
      fullUrl: r.container ? `${freq.base}/${r.container.type}/${r.container.id}#${r.id}` : `${freq.base}/${r.type}/${r.id}`, resource: ep.shapeResource(r.resource, freq, shapeControl), search: { mode: 'match' }
    }));
    for (const r of included) {
      bundle.entry.push({ fullUrl: `${freq.base}/${r.type}/${r.id}`, resource: ep.shapeResource(r.resource, freq, shapeControl), search: { mode: 'include' } });
    }
    if (pg.warnings.length) {
      bundle.entry.push(this.outcomeEntry(pg.warnings));
    }
    return { status: 200, resource: bundle, searchKeys: found.map(r => r.container ? r.container.resourceKey : r.resourceKey) };
  }

  /**
   * The resources for a page's keys, in order: contained resources (_containedType=contained)
   * are keyed -ContainedKey, and come out of their container's current version, with
   * container set (and id their local id).
   */
  async byKeys(q, keys) {
    const ep = this.ep;
    const neg = keys.filter(k => k < 0).map(k => -k);
    if (!neg.length) {
      return ep.store.byKeys(q, keys);
    }
    const rows = [];
    for (let i = 0; i < neg.length; i += 500) {
      const c = neg.slice(i, i + 500);
      rows.push(...await q.all(`SELECT ContainedKey, ResourceKey, LocalId FROM Contained WHERE ContainedKey IN (${c.map(() => '?').join(', ')})`, c));
    }
    const containerKeys = [...new Set(rows.map(r => Number(r.ResourceKey)))];
    const loaded = await ep.store.byKeys(q, [...new Set([...keys.filter(k => k > 0), ...containerKeys])]);
    const byKey = new Map(loaded.map(r => [r.resourceKey, r]));
    for (const r of rows) {
      const container = byKey.get(Number(r.ResourceKey));
      const res = container && Array.isArray(container.resource.contained) ? container.resource.contained.find(c => c && c.id === r.LocalId) : null;
      if (res) {
        byKey.set(-Number(r.ContainedKey), { resourceKey: -Number(r.ContainedKey), type: res.resourceType, id: r.LocalId, resource: res, container });
      }
    }
    return keys.map(k => byKey.get(k)).filter(x => x);
  }

  /**
   * _include and _revinclude for a page's resources: up to 3 rounds for :iterate.
   */
  async includes(q, matches, control, access) {
    const ep = this.ep;
    if (!control || (!control.include.length && !control.revinclude.length) || !matches.length) {
      return [];
    }
    const seen = new Set(matches.map(m => m.resourceKey));
    const out = [];
    let current = matches;
    for (let round = 0; round < INCLUDE_ROUNDS && current.length && out.length < MAX_INCLUDES; round++) {
      const found = new Set();
      for (const inc of control.include) {
        if (round > 0 && !inc.iterate) {
          continue;
        }
        const src = current.filter(r => !inc.srcType || r.type === inc.srcType).map(r => r.resourceKey);
        if (!src.length) {
          continue;
        }
        for (let i = 0; i < src.length; i += 500) {
          const c = src.slice(i, i + 500);
          // (a contained target, TargetKey < 0, is in the resource already)
          const conds = [`r.ResourceKey IN (${c.map(() => '?').join(', ')})`, 'r.TargetKey > 0'];
          const args = [...c];
          if (inc.key) {
            conds.push('r.ParamKey = ?');
            args.push(inc.key);
          }
          if (inc.target) {
            conds.push('r.TargetType = ?');
            args.push(inc.target);
          }
          const rows = await q.all(`SELECT DISTINCT r.TargetKey FROM IndexReferences r WHERE ${conds.join(' AND ')}`, args);
          rows.forEach(r => found.add(Number(r.TargetKey)));
        }
      }
      for (const inc of control.revinclude) {
        if (round > 0 && !inc.iterate) {
          continue;
        }
        const tgt = current.map(r => r.resourceKey);
        for (let i = 0; i < tgt.length; i += 500) {
          const c = tgt.slice(i, i + 500);
          const conds = [`r.TargetKey IN (${c.map(() => '?').join(', ')})`, 'o.Deleted = 0'];
          const args = [...c];
          if (inc.key) {
            conds.push('r.ParamKey = ?');
            args.push(inc.key);
          }
          if (inc.srcType) {
            conds.push('o.TypeKey = ?');
            args.push(ep.typeKeys.get(inc.srcType));
          }
          const rows = await q.all(`SELECT DISTINCT r.ResourceKey FROM IndexReferences r JOIN Ids o ON o.ResourceKey = r.ResourceKey WHERE ${conds.join(' AND ')}`, args);
          rows.forEach(r => found.add(Number(r.ResourceKey)));
        }
      }
      let fresh = [...found].filter(k => !seen.has(k));
      fresh = await ep.filterKeysByAccess(q, access, fresh);
      fresh = fresh.slice(0, MAX_INCLUDES - out.length);
      fresh.forEach(k => seen.add(k));
      const loaded = await ep.store.byKeys(q, fresh);
      out.push(...loaded);
      current = loaded;
    }
    return out;
  }

  /** Delete expired searches (a master job) */
  async cleanup() {
    const ep = this.ep;
    const now = Date.now();
    const expired = await ep.db.read(q => q.all('SELECT SearchKey FROM Searches WHERE Expires < ? LIMIT 1000', [now]));
    if (!expired.length) {
      return 0;
    }
    const keys = expired.map(r => Number(r.SearchKey));
    await ep.db.write(async (q) => {
      for (let i = 0; i < keys.length; i += 200) {
        const c = keys.slice(i, i + 200);
        await q.run(`DELETE FROM SearchEntries WHERE SearchKey IN (${c.map(() => '?').join(', ')})`, c);
        await q.run(`DELETE FROM Searches WHERE SearchKey IN (${c.map(() => '?').join(', ')})`, c);
      }
    });
    return keys.length;
  }
}

module.exports = { Searcher, MAX_INCLUDES, newSearchId, notFound };
