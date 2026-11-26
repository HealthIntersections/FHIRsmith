//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * history: of a resource, a type, or the whole endpoint. Newest first, paged by version key
 * (the next page asks for versions older than the last one shown), so nothing is stored.
 *
 *   _count   page size (the endpoint's default and maximum)
 *   _since   versions written at or after an instant
 *   _at      versions that were current at some point in a date's range
 *
 * @module rest/interactions/history
 */

const { badRequest, notFound } = require('../library/errors');
const { dateRange } = require('../../library/fhir-search-values');
const { decode, OP_CREATE, OP_DELETE } = require('../store');
const { param } = require('../request');

function pageSize(ep, freq) {
  const c = param(freq, '_count');
  if (c === undefined || c === '') {
    return ep.settings.defaultCount;
  }
  if (!/^\d+$/.test(c)) {
    throw badRequest(`_count must be a number, not '${c}'`);
  }
  return Math.min(Number(c), ep.settings.maxCount);
}

async function history(ep, freq, ctx) {
  const level = freq.interaction;
  if (freq.type) {
    ep.checkType(freq.type, level);
  }
  const count = pageSize(ep, freq);
  const where = [];
  const args = [];
  const since = param(freq, '_since');
  if (since) {
    const r = dateRange(since, ep.timeZone);
    if (!r) {
      throw badRequest(`_since must be an instant, not '${since}'`);
    }
    where.push('v.LastUpdated >= ?');
    args.push(r.lo);
  }
  const at = param(freq, '_at');
  if (at) {
    const r = dateRange(at, ep.timeZone);
    if (!r) {
      throw badRequest(`_at must be a date, not '${at}'`);
    }
    // written before the range ends, and not replaced before it starts
    where.push('v.LastUpdated < ?');
    args.push(r.hi);
    // (any later version: versions between may have been expunged)
    where.push('NOT EXISTS (SELECT 1 FROM Versions n WHERE n.ResourceKey = v.ResourceKey AND n.VersionId > v.VersionId AND n.LastUpdated <= ?)');
    args.push(r.lo);
  }
  const cursor = param(freq, '_cursor');
  if (cursor !== undefined) {
    if (!/^\d+$/.test(cursor)) {
      throw badRequest('_cursor is not valid');
    }
    where.push('v.VersionKey < ?');
    args.push(Number(cursor));
  }
  const out = await ep.inRead(ctx, async (q) => {
    let resourceKey = null;
    if (level === 'history-instance') {
      const ids = await ep.store.idRow(q, freq.type, freq.id);
      if (!ids || ids.MostRecent === null) {
        throw notFound(`${freq.type}/${freq.id} is not known`);
      }
      await ep.checkCompartments(q, ctx.access, ids.ResourceKey);
      resourceKey = ids.ResourceKey;
      where.push('v.ResourceKey = ?');
      args.push(resourceKey);
    } else if (level === 'history-type') {
      where.push('i.TypeKey = ?');
      args.push(ep.store.typeKey(freq.type));
    }
    const comp = ep.compartmentFilter(ctx.access, 'i.ResourceKey');
    if (comp) {
      where.push(comp.sql);
      args.push(...comp.args);
    }
    const rows = await q.all(`SELECT v.VersionKey, v.ResourceKey, v.VersionId, v.LastUpdated, v.Operation, v.Compressed, v.Content, i.Id, t.Name
      FROM Versions v JOIN Ids i ON i.ResourceKey = v.ResourceKey JOIN Types t ON t.TypeKey = i.TypeKey
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY v.VersionKey DESC LIMIT ${count + 1}`, args);
    let total;
    if (level === 'history-instance' && cursor === undefined && !since && !at) {
      const t = await q.get('SELECT COUNT(*) AS N FROM Versions WHERE ResourceKey = ?', [resourceKey]);
      total = Number(t.N);
    }
    return { rows, total };
  });
  const more = out.rows.length > count;
  const rows = out.rows.slice(0, count);
  const bundle = { resourceType: 'Bundle', type: 'history' };
  if (out.total !== undefined) {
    bundle.total = out.total;
  }
  const self = freq.base + '/' + freq.segments.map(encodeURIComponent).join('/');
  const keep = freq.params.filter(([n]) => ['_count', '_since', '_at'].includes(n));
  const qs = (extra) => {
    const all = [...keep, ...extra];
    return all.length ? '?' + all.map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('&') : '';
  };
  bundle.link = [{ relation: 'self', url: self + qs(cursor !== undefined ? [['_cursor', cursor]] : []) }];
  if (more) {
    bundle.link.push({ relation: 'next', url: self + qs([['_cursor', String(rows[rows.length - 1].VersionKey)]]) });
  }
  bundle.entry = rows.map(r => {
    const op = Number(r.Operation);
    const e = { fullUrl: `${freq.base}/${r.Name}/${r.Id}` };
    const resource = decode(r);
    if (resource) {
      e.resource = ep.shapeResource(resource, freq);
    }
    e.request = op === OP_CREATE ? { method: 'POST', url: r.Name } : op === OP_DELETE ? { method: 'DELETE', url: `${r.Name}/${r.Id}` } : { method: 'PUT', url: `${r.Name}/${r.Id}` };
    e.response = { status: op === OP_CREATE ? '201' : op === OP_DELETE ? '204' : '200', etag: `W/"${r.VersionId}"`, lastModified: new Date(Number(r.LastUpdated)).toISOString() };
    return e;
  });
  return { status: 200, resource: bundle };
}

module.exports = { history, pageSize };
