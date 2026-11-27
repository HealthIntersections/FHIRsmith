//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The operations: $meta, $meta-add, $meta-delete, $everything on Patient, $lastn and $stats
 * on Observation (observations.js), and $expunge (expunge.js).
 *
 * @module rest/operations/operations
 */

const { badRequest, notFound, gone, notSupported, notAllowed } = require('../library/errors');
const { TAG, SECURITY, PROFILE, metaTags } = require('../store');
const { versionHeaders } = require('../interactions/crud');
const { param } = require('../request');
const observations = require('./observations');
const { expunge } = require('./expunge');

const OPERATIONS = [
  { name: 'meta', definition: 'http://hl7.org/fhir/OperationDefinition/Resource-meta', types: null, system: true, type: true, instance: true, read: true, run: meta },
  { name: 'meta-add', definition: 'http://hl7.org/fhir/OperationDefinition/Resource-meta-add', types: null, system: false, type: false, instance: true, read: false, run: metaAdd },
  { name: 'meta-delete', definition: 'http://hl7.org/fhir/OperationDefinition/Resource-meta-delete', types: null, system: false, type: false, instance: true, read: false, run: metaDelete },
  { name: 'everything', definition: 'http://hl7.org/fhir/OperationDefinition/Patient-everything', types: ['Patient'], system: false, type: false, instance: true, read: true, run: everything },
  { name: 'lastn', definition: 'http://hl7.org/fhir/OperationDefinition/Observation-lastn', types: ['Observation'], system: false, type: true, instance: false, read: true,
    run: (ep, freq, ctx) => observations.lastn(ep, freq, ctx) },
  { name: 'stats', definition: 'http://hl7.org/fhir/OperationDefinition/Observation-stats', types: ['Observation'], system: false, type: true, instance: false, read: true,
    run: (ep, freq, ctx) => observations.stats(ep, freq, ctx) },
  // HAPI's: removes versions for good (expunge.js); needs the manage role. version: on [type]/[id]/_history/[vid]
  { name: 'expunge', definition: 'http://healthintersections.com.au/fhir/OperationDefinition/expunge', types: null, system: true, type: true, instance: true, version: true, read: false, manage: true, run: expunge }
];

/** Find an operation for a request; throws if there is none at that level */
function findOperation(freq) {
  const op = OPERATIONS.find(o => o.name === freq.operation);
  if (!op) {
    throw notSupported(`The operation $${freq.operation} is not supported`);
  }
  const level = freq.vid ? 'version' : freq.id ? 'instance' : freq.type ? 'type' : 'system';
  if (!op[level] || (freq.type && op.types && !op.types.includes(freq.type))) {
    throw notSupported(`$${freq.operation} can't be used ${level === 'system' ? 'on the endpoint' : level === 'type' ? 'on ' + freq.type : level === 'version' ? 'on a version' : 'on a ' + freq.type}`);
  }
  if (!op.read && freq.method !== 'POST') {
    throw notAllowed(`$${freq.operation} needs POST`);
  }
  return op;
}

function metaOf(rows) {
  const meta = {};
  for (const r of rows) {
    const kind = Number(r.Kind);
    if (kind === PROFILE) {
      (meta.profile = meta.profile || []).push(r.Code);
    } else {
      const c = { system: r.TagSystem || undefined, code: r.Code };
      if (r.Display) {
        c.display = r.Display;
      }
      if (kind === TAG) {
        (meta.tag = meta.tag || []).push(c);
      } else if (kind === SECURITY) {
        (meta.security = meta.security || []).push(c);
      }
    }
  }
  return meta;
}

function metaParameters(meta) {
  return { resourceType: 'Parameters', parameter: [{ name: 'return', valueMeta: meta }] };
}

async function meta(ep, freq, ctx) {
  const rows = await ep.inRead(ctx, async (q) => {
    if (freq.id) {
      const cur = await ep.store.current(q, freq.type, freq.id);
      if (!cur) {
        throw notFound(`${freq.type}/${freq.id} is not known`);
      }
      await ep.checkCompartments(q, ctx.access, cur.resourceKey);
      return q.all('SELECT DISTINCT t.Kind, t.TagSystem, t.Code, t.Display FROM VersionTags vt JOIN Tags t ON t.TagKey = vt.TagKey WHERE vt.VersionKey = ? ORDER BY t.Kind, t.TagSystem, t.Code', [cur.versionKey]);
    }
    if (freq.type) {
      return q.all(`SELECT DISTINCT t.Kind, t.TagSystem, t.Code, t.Display FROM Ids i JOIN VersionTags vt ON vt.VersionKey = i.MostRecent JOIN Tags t ON t.TagKey = vt.TagKey
        WHERE i.TypeKey = ? AND i.Deleted = 0 ORDER BY t.Kind, t.TagSystem, t.Code`, [ep.store.typeKey(freq.type)]);
    }
    return q.all('SELECT DISTINCT t.Kind, t.TagSystem, t.Code, t.Display FROM Ids i JOIN VersionTags vt ON vt.VersionKey = i.MostRecent JOIN Tags t ON t.TagKey = vt.TagKey WHERE i.Deleted = 0 ORDER BY t.Kind, t.TagSystem, t.Code');
  });
  return { status: 200, resource: metaParameters(metaOf(rows)) };
}

function metaInput(freq) {
  const b = freq.body;
  if (!b || b.resourceType !== 'Parameters') {
    throw badRequest('The body must be a Parameters resource with a meta parameter');
  }
  const p = (b.parameter || []).find(x => x.name === 'meta');
  if (!p || !p.valueMeta) {
    throw badRequest('The Parameters must have a meta parameter (valueMeta)');
  }
  return p.valueMeta;
}

function sameCoding(a, b) {
  return (a.system || '') === (b.system || '') && a.code === b.code;
}

async function changeMeta(ep, freq, ctx, change) {
  const input = metaInput(freq);
  return ep.inWrite(ctx, async (q) => {
    const cur = await ep.store.current(q, freq.type, freq.id);
    if (!cur) {
      throw notFound(`${freq.type}/${freq.id} is not known`);
    }
    if (cur.deleted) {
      throw gone(`${freq.type}/${freq.id} has been deleted`);
    }
    await ep.checkCompartments(q, ctx.access, cur.resourceKey);
    const resource = cur.resource;
    const m = { ...(resource.meta || {}) };
    change(m, input);
    for (const k of ['tag', 'security', 'profile']) {
      if (Array.isArray(m[k]) && m[k].length === 0) {
        delete m[k];
      }
    }
    resource.meta = m;
    await ep.store.rewriteMeta(q, cur, freq.type, resource);
    await ep.auditWrite(q, freq, 'operation', 200, `${freq.type}/${freq.id}/_history/${cur.versionId}`, null);
    const out = {};
    for (const k of ['tag', 'security', 'profile']) {
      if (m[k]) {
        out[k] = m[k];
      }
    }
    return { status: 200, resource: metaParameters(out), headers: versionHeaders(cur) };
  });
}

async function metaAdd(ep, freq, ctx) {
  return changeMeta(ep, freq, ctx, (m, input) => {
    for (const k of ['tag', 'security']) {
      for (const c of input[k] || []) {
        m[k] = m[k] || [];
        if (!m[k].some(x => sameCoding(x, c))) {
          m[k].push(c);
        }
      }
    }
    for (const p of input.profile || []) {
      m.profile = m.profile || [];
      if (!m.profile.includes(p)) {
        m.profile.push(p);
      }
    }
  });
}

async function metaDelete(ep, freq, ctx) {
  return changeMeta(ep, freq, ctx, (m, input) => {
    for (const k of ['tag', 'security']) {
      if (m[k]) {
        m[k] = m[k].filter(x => !(input[k] || []).some(c => sameCoding(x, c)));
      }
    }
    if (m.profile) {
      m.profile = m.profile.filter(p => !(input.profile || []).includes(p));
    }
  });
}

/**
 * Patient/[id]/$everything: the patient, everything in its compartment, and what those refer
 * to; _since, _type and _count as for a search.
 */
async function everything(ep, freq, ctx) {
  const exists = await ep.inRead(ctx, q => ep.store.current(q, 'Patient', freq.id));
  if (!exists) {
    throw notFound(`Patient/${freq.id} is not known`);
  }
  if (exists.deleted) {
    throw gone(`Patient/${freq.id} has been deleted`);
  }
  const params = [];
  for (const [n, v] of freq.params) {
    if (n === '_count' || n === '_type') {
      params.push([n, v]);
    } else if (n === '_since') {
      params.push(['_lastUpdated', 'ge' + v]);
    } else if (n === 'start' || n === 'end') {
      // clinical dates: not applied yet
    }
  }
  if (param(freq, '_getpages') !== undefined) {
    return ep.searcher.search({ ...freq, params: freq.params }, ctx);
  }
  params.push(['_include', '*']);
  const sfreq = { ...freq, type: null, id: null, compartment: { type: 'Patient', id: freq.id }, params, interaction: 'search-system',
    segments: freq.segments };
  const r = await ep.searcher.search(sfreq, ctx);
  r.resource.type = 'searchset';
  return r;
}

module.exports = { OPERATIONS, findOperation, metaTags };
