//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * batch and transaction.
 *
 * A batch runs each entry on its own (its own transaction); one failure doesn't stop the
 * others.
 *
 * A transaction runs every entry in one database transaction: see the notes on transaction()
 * below for how it is planned and run.
 *
 * @module rest/interactions/bundle
 */

const http = require('http');
const { FhirError, badRequest, preconditionFailed, unprocessable, notFound } = require('../library/errors');
const { fromEntry, parseQuery, preferReturn } = require('../request');
const access = require('../access');
const crud = require('./crud');

const ORDER = { DELETE: 0, POST: 1, PUT: 2, PATCH: 2, GET: 3, HEAD: 3 };

function statusText(status) {
  return `${status} ${http.STATUS_CODES[status] || ''}`.trim();
}

/** The response entry for a result */
function responseEntry(ep, freq, result) {
  const response = { status: statusText(result.status) };
  const h = result.headers || {};
  if (result.location) {
    response.location = result.location;
  }
  if (h.ETag) {
    response.etag = h.ETag;
  }
  if (h['Last-Modified']) {
    response.lastModified = new Date(h['Last-Modified']).toISOString();
  }
  const entry = {};
  if (result.outcome) {
    response.outcome = { resourceType: 'OperationOutcome', issue: [result.outcome] };
  }
  if (result.resource) {
    const pr = preferReturn(freq);
    if (!result.write || pr === 'representation' || (!pr && ep.bundleReturnsResources)) {
      entry.resource = result.resource;
      if (result.write && result.location) {
        entry.fullUrl = `${freq.base}/${result.location.split('/_history/')[0]}`;
      }
    }
  }
  entry.response = response;
  return entry;
}

function errorEntry(err) {
  const status = err instanceof FhirError ? err.status : 500;
  const outcome = err instanceof FhirError ? err.outcome()
    : { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception', diagnostics: 'Internal error' }] };
  return { response: { status: statusText(status), outcome } };
}

function checkBundle(bundle) {
  if (!bundle || bundle.resourceType !== 'Bundle') {
    throw badRequest('POST to the endpoint takes a Bundle (batch or transaction)');
  }
  if (bundle.type !== 'batch' && bundle.type !== 'transaction') {
    throw badRequest(`A Bundle of type ${bundle.type} can't be processed: post a batch or a transaction`);
  }
  if (bundle.entry !== undefined && !Array.isArray(bundle.entry)) {
    throw badRequest('Bundle.entry must be an array');
  }
}

async function bundle(ep, freq) {
  checkBundle(freq.body);
  return freq.body.type === 'batch' ? batch(ep, freq) : transaction(ep, freq);
}

async function batch(ep, freq) {
  const entries = freq.body.entry || [];
  const out = [];
  for (const entry of entries) {
    try {
      const efreq = fromEntry(entry, freq);
      if (efreq.interaction === 'bundle') {
        throw badRequest('A batch can\'t contain another batch or transaction');
      }
      // entries in a batch are independent: one can't refer to another by its fullUrl
      if (efreq.body && efreq.method !== 'PATCH') {
        eachReference(efreq.body, (r) => {
          if (URN.test(r.reference)) {
            throw badRequest(`The reference ${r.reference} is to another entry: entries in a batch can't refer to each other (use a transaction)`);
          }
        });
      }
      const eaccess = access.check(freq.principal, ep, ep.accessInteraction(efreq));
      const result = await ep.dispatch(efreq, { access: eaccess });
      out.push(responseEntry(ep, efreq, result));
    } catch (err) {
      if (!(err instanceof FhirError)) {
        ep.log.error(`Batch entry failed: ${err.stack || err.message}`);
      }
      out.push(errorEntry(err));
    }
  }
  return { status: 200, resource: { resourceType: 'Bundle', type: 'batch-response', entry: out } };
}

/** Replace strings exactly equal to a mapped value, everywhere in a resource */
// ---- transactions ----
//
// A transaction is planned before anything is written, inside the database transaction:
//
//  1. every entry is parsed and its access checked (before the database transaction starts)
//  2. each write entry is given the one resource it changes: a DELETE or PUT names it, a POST
//     gets a new id reserved for it, and the conditional forms (If-None-Exist, PUT/PATCH/DELETE
//     with search criteria) are searched once, here. A resource may be changed by only one
//     entry: two entries that change the same one fail the transaction
//  3. conditional references (Patient?identifier=x) are searched: exactly one match
//  4. every fullUrl a write entry has is mapped to its resource, and references to it inside
//     the Bundle are rewritten (references, uris, and <a href> / <img src> in narratives);
//     a urn:uuid: or urn:oid: reference that is still left points at nothing: it fails
//  5. references marked resolve-as-version-specific are pointed at the version this
//     transaction writes
//  6. the entries run, in the specification's order: deletes, creates, updates and patches,
//     reads. Reference checks wait until every entry has been written
//
// Any failure rolls everything back, and the failing entry's OperationOutcome is returned.

const RESOLVE_AS_VERSION_SPECIFIC = 'http://hl7.org/fhir/StructureDefinition/resolve-as-version-specific';
const URN = /^urn:(uuid|oid):/;

/** The mapped value for a string: an exact match, or a match of the part before '#' */
function mapped(map, s) {
  if (map.has(s)) {
    return map.get(s);
  }
  const hash = s.indexOf('#');
  if (hash > 0 && map.has(s.substring(0, hash))) {
    return map.get(s.substring(0, hash)) + s.substring(hash);
  }
  return null;
}

/**
 * Point the links in a narrative at the new resources: only <a href> and <img src>, and only
 * attributes that match exactly (or up to a #). Nothing else in the XHTML is touched.
 */
function rewriteNarrative(div, map) {
  return div.replace(/<(a|img)\b[^>]*>/gi, (tag, name) => {
    const attr = name.toLowerCase() === 'a' ? 'href' : 'src';
    return tag.replace(new RegExp(`(\\s${attr}\\s*=\\s*)(["'])([^"']*)\\2`, 'i'), (m, pre, q, value) => {
      const unescaped = value.replace(/&amp;/g, '&');
      const to = mapped(map, unescaped);
      return to === null ? m : `${pre}${q}${to.replace(/&/g, '&amp;')}${q}`;
    });
  });
}

/**
 * Replace strings that are references to entries of the Bundle, everywhere in a resource
 * (any element whose whole value is the fullUrl: references, uris, urls), and the links in
 * narratives. Strings that only contain a fullUrl are left alone.
 */
function rewrite(obj, map) {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'string') {
        const to = mapped(map, obj[i]);
        if (to !== null) {
          obj[i] = to;
        }
      } else if (obj[i] && typeof obj[i] === 'object') {
        rewrite(obj[i], map);
      }
    }
  } else if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (k === 'div' && typeof v === 'string') {
        obj[k] = rewriteNarrative(v, map);
      } else if (typeof v === 'string') {
        const to = mapped(map, v);
        if (to !== null) {
          obj[k] = to;
        }
      } else if (v && typeof v === 'object') {
        rewrite(v, map);
      }
    }
  }
}

/** Walk the Reference-like objects (those with a string reference) in a resource */
function eachReference(obj, fn) {
  if (Array.isArray(obj)) {
    obj.forEach(x => eachReference(x, fn));
  } else if (obj && typeof obj === 'object') {
    if (typeof obj.reference === 'string') {
      fn(obj);
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') {
        eachReference(v, fn);
      }
    }
  }
}

/** Conditional references (Type?criteria) in a resource */
function conditionalReferences(obj) {
  const out = new Set();
  eachReference(obj, (r) => {
    if (/^[A-Z][A-Za-z]+\?/.test(r.reference)) {
      out.add(r.reference);
    }
  });
  return out;
}

function entryError(it, e) {
  if (e instanceof FhirError) {
    e.message = `Entry ${it.index} (${it.efreq.method} ${it.efreq.url}): ${e.message}`;
    e.issues = null;
  }
  return e;
}

/**
 * Plan a write entry: what it changes, with its conditional criteria searched.
 * Sets it.plan = { kind, type, id, ids, reservation, version, existing }.
 */
async function planEntry(ep, q, it, reserved) {
  const f = it.efreq;
  const search = (type, params, limit) => ep.searcher.matchKeys(q, type, params, { access: it.access, limit, strict: true });
  const current = async (type, id) => ep.store.current(q, type, id);
  switch (f.interaction) {
    case 'create': {
      ep.checkType(f.type, 'create');
      const ine = f.headers['if-none-exist'];
      if (ine) {
        const settings = ep.typeSettings(f.type);
        if (!settings.conditionalCreate) {
          throw new FhirError(405, 'not-supported', `Conditional create is not allowed for ${f.type}`);
        }
        const params = parseQuery(String(ine).replace(/^[^?]*\?/, ''));
        // as outside a transaction: two requests mustn't both find nothing and both create
        await ep.conditionalLock(q, f.type, params);
        const keys = await search(f.type, params, 2);
        if (keys.length > 1) {
          throw preconditionFailed(`If-None-Exist matches more than one ${f.type}`);
        }
        if (keys.length === 1) {
          const [existing] = await ep.store.byKeys(q, keys);
          it.plan = { kind: 'existing', type: f.type, id: existing.id, existing };
          return;
        }
      }
      const reservation = await ep.store.reserve(q, f.type, null);
      reserved.add(`${f.type}/${reservation.id}`);
      it.plan = { kind: 'create', type: f.type, id: reservation.id, reservation, version: 1 };
      return;
    }
    case 'update':
    case 'conditional-update': {
      ep.checkType(f.type, 'update');
      let id = f.id;
      if (f.interaction === 'conditional-update') {
        if (!ep.typeSettings(f.type).conditionalUpdate) {
          throw new FhirError(405, 'not-supported', `Conditional update is not allowed for ${f.type}`);
        }
        await ep.conditionalLock(q, f.type, f.params);
        const keys = await search(f.type, f.params, 2);
        if (keys.length > 1) {
          throw preconditionFailed(`More than one ${f.type} matches ${f.url}`);
        }
        if (keys.length === 1) {
          const [existing] = await ep.store.byKeys(q, keys);
          if (f.body && f.body.id && f.body.id !== existing.id) {
            throw badRequest(`The resource's id (${f.body.id}) is not the id of the resource that matches (${existing.id})`);
          }
          id = existing.id;
        } else {
          id = f.body && f.body.id ? f.body.id : null;
        }
      }
      const cur = id ? await current(f.type, id) : null;
      if (!id || !cur) {
        if (!id || f.interaction === 'conditional-update' || ep.settings.createOnUpdate) {
          const reservation = await ep.store.reserve(q, f.type, id);
          if (!reservation.existing) {
            reserved.add(`${f.type}/${reservation.id}`);
          }
          id = reservation.id;
          it.plan = { kind: 'update', type: f.type, id, reservation, version: 1, creates: true };
          return;
        }
      }
      if (cur && cur.deleted) {
        reserved.add(`${f.type}/${id}`);
      }
      it.plan = { kind: 'update', type: f.type, id, version: cur ? cur.versionId + 1 : 1, creates: !cur || cur.deleted };
      return;
    }
    case 'patch':
    case 'conditional-patch': {
      ep.checkType(f.type, 'patch');
      let id = f.id;
      if (f.interaction === 'conditional-patch') {
        if (!ep.typeSettings(f.type).conditionalUpdate) {
          throw new FhirError(405, 'not-supported', `Conditional patch is not allowed for ${f.type}`);
        }
        const keys = await search(f.type, f.params, 2);
        if (keys.length === 0) {
          throw notFound(`No ${f.type} matches ${f.url}`);
        }
        if (keys.length > 1) {
          throw preconditionFailed(`More than one ${f.type} matches ${f.url}`);
        }
        id = (await ep.store.byKeys(q, keys))[0].id;
      }
      const cur = await current(f.type, id);
      it.plan = { kind: 'patch', type: f.type, id, version: cur && !cur.deleted ? cur.versionId + 1 : null };
      return;
    }
    case 'delete':
      ep.checkType(f.type, 'delete');
      it.plan = { kind: 'delete', type: f.type, ids: [f.id] };
      return;
    case 'conditional-delete': {
      ep.checkType(f.type, 'delete');
      if (!ep.typeSettings(f.type).conditionalDelete) {
        throw new FhirError(405, 'not-supported', `Conditional delete is not allowed for ${f.type}`);
      }
      const max = Math.max(1, ep.settings.conditionalDeleteMax || 1);
      const keys = await search(f.type, f.params, max + 1);
      if (keys.length > max) {
        throw preconditionFailed(max === 1 ? `More than one ${f.type} matches ${f.url}` : `More than ${max} ${f.type} resources match ${f.url}`);
      }
      const found = await ep.store.byKeys(q, keys);
      it.plan = { kind: 'delete', type: f.type, ids: found.map(x => x.id), conditional: true };
      return;
    }
    default:
      it.plan = { kind: 'read' };
  }
}

/** The resources a planned entry changes, as Type/id */
function identities(plan) {
  switch (plan.kind) {
    case 'create':
    case 'update':
    case 'patch':
      return [`${plan.type}/${plan.id}`];
    case 'delete':
      return plan.ids.map(id => `${plan.type}/${id}`);
    default:
      return [];
  }
}

/**
 * Run a planned entry: the interaction, made concrete (no conditional left in it).
 */
async function runEntry(ep, q, it, reserved) {
  const f = it.efreq;
  const p = it.plan;
  const ctx = { q, access: it.access, reserved, deferChecks: true, reservation: null };
  switch (p.kind) {
    case 'existing':
      return { status: 200, resource: p.existing.resource, headers: crud.versionHeaders(p.existing), write: true,
        location: `${p.type}/${p.existing.id}/_history/${p.existing.versionId}` };
    case 'create': {
      const headers = { ...f.headers };
      delete headers['if-none-exist'];
      return crud.create(ep, { ...f, headers }, { ...ctx, reservation: p.reservation });
    }
    case 'update': {
      // a PUT keeps its body as it is (its id is checked against the URL); a conditional
      // update's body takes the id of the resource it resolved to
      const body = f.interaction === 'update' ? f.body : { ...f.body, id: p.id };
      return crud.update(ep, { ...f, interaction: 'update', id: p.id, body, params: [] }, { ...ctx, reservation: p.reservation || null });
    }
    case 'patch':
      return crud.patch(ep, { ...f, interaction: 'patch', id: p.id, params: [] }, ctx);
    case 'delete': {
      if (!p.conditional) {
        return crud.remove(ep, f, ctx);
      }
      for (const id of p.ids) {
        await crud.remove(ep, { ...f, interaction: 'delete', id, params: [] }, ctx);
      }
      const n = p.ids.length;
      return { status: 200, outcome: { severity: 'information', code: 'informational',
        diagnostics: n === 0 ? `No ${p.type} matched: nothing was deleted` : `Deleted ${n} ${p.type} resource${n === 1 ? '' : 's'}` }, write: true, deletion: true };
    }
    default:
      return ep.dispatch(f, ctx);
  }
}

/** Check the references left unresolved by the entries, now that they are all written */
async function checkUnresolved(ep, q, unresolved) {
  const missing = [];
  for (const ref of unresolved) {
    const parts = ref.split('/');
    const [type, id] = parts;
    if (!ep.typeKeys.has(type)) {
      missing.push(ref);
      continue;
    }
    const row = await ep.store.idRow(q, type, id);
    if (!row || row.MostRecent === null || row.Deleted) {
      missing.push(ref);
      continue;
    }
    if (parts.length === 4) {
      const v = /^\d{1,9}$/.test(parts[3]) ? await q.get('SELECT 1 AS ok FROM Versions WHERE ResourceKey = ? AND VersionId = ?', [row.ResourceKey, Number(parts[3])]) : null;
      if (!v) {
        missing.push(ref);
      }
    }
  }
  return missing;
}

async function transaction(ep, freq) {
  const entries = freq.body.entry || [];
  if (entries.length > ep.settings.transactionMaxEntries) {
    throw badRequest(`A transaction is limited to ${ep.settings.transactionMaxEntries} entries on this endpoint`);
  }
  // parse every entry first: a malformed one fails the transaction before it starts
  const items = entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw badRequest(`Entry ${index} is not an object`);
    }
    let efreq;
    try {
      efreq = fromEntry(entry, freq);
    } catch (e) {
      if (e instanceof FhirError) {
        e.message = `Entry ${index}: ${e.message}`;
      }
      throw e;
    }
    if (efreq.interaction === 'bundle') {
      throw badRequest(`Entry ${index}: a transaction can't contain another batch or transaction`);
    }
    if ((efreq.method === 'POST' || efreq.method === 'PUT') && efreq.interaction !== 'operation' && (!entry.resource || typeof entry.resource !== 'object')) {
      throw badRequest(`Entry ${index}: a ${efreq.method} needs a resource`);
    }
    if (efreq.method === 'PATCH' && !entry.resource) {
      throw badRequest(`Entry ${index}: a PATCH needs a Binary resource holding the JSON Patch`);
    }
    if (efreq.interaction === 'operation') {
      throw badRequest(`Entry ${index}: operations can't be used in a transaction`);
    }
    const eaccess = access.check(freq.principal, ep, ep.accessInteraction(efreq));
    return { index, entry, efreq, access: eaccess };
  });
  const fullUrls = new Map();
  const criteria = new Map();
  for (const it of items) {
    const fu = it.entry.fullUrl;
    if (fu && it.efreq.method !== 'GET' && it.efreq.method !== 'HEAD') {
      if (fullUrls.has(fu)) {
        throw badRequest(`Entries ${fullUrls.get(fu)} and ${it.index} both have the fullUrl ${fu}`);
      }
      fullUrls.set(fu, it.index);
    }
    const ine = it.efreq.interaction === 'create' && it.efreq.headers['if-none-exist'];
    if (ine) {
      // two conditional creates with the same criteria would both find nothing, and make two
      const key = it.efreq.type + '?' + parseQuery(String(ine).replace(/^[^?]*\?/, '')).map(([n, v]) => `${n}=${v}`).sort().join('&');
      if (criteria.has(key)) {
        throw badRequest(`Entries ${criteria.get(key)} and ${it.index} are conditional creates with the same criteria (${ine})`);
      }
      criteria.set(key, it.index);
    }
  }
  const ordered = [...items].sort((a, b) => (ORDER[a.efreq.method] ?? 9) - (ORDER[b.efreq.method] ?? 9) || a.index - b.index);

  const results = await ep.db.write(async (q) => {
    // fresh copies of everything the planning changes: the transaction can run again (busy, deadlock)
    const work = ordered.map(it => ({ ...it, efreq: { ...it.efreq, headers: { ...it.efreq.headers }, body: it.efreq.body ? JSON.parse(JSON.stringify(it.efreq.body)) : null }, plan: null, result: null }));
    const reserved = new Set();

    // 2. what each entry changes; a resource changed by two entries fails
    const changedBy = new Map();
    for (const it of work) {
      try {
        await planEntry(ep, q, it, reserved);
      } catch (e) {
        throw entryError(it, e);
      }
      for (const ident of identities(it.plan)) {
        if (changedBy.has(ident)) {
          throw badRequest(`Entries ${changedBy.get(ident)} and ${it.index} both change ${ident}: a resource can only be changed once in a transaction`);
        }
        changedBy.set(ident, it.index);
      }
    }

    // 3. conditional references
    const map = new Map();
    for (const it of work) {
      if (!it.efreq.body) {
        continue;
      }
      for (const ref of conditionalReferences(it.efreq.body)) {
        if (map.has(ref)) {
          continue;
        }
        const qm = ref.indexOf('?');
        const type = ref.substring(0, qm);
        try {
          ep.checkType(type, 'search-type');
          const keys = await ep.searcher.matchKeys(q, type, parseQuery(ref.substring(qm + 1)), { access: it.access, limit: 2, strict: true });
          if (keys.length !== 1) {
            throw new FhirError(412, 'conflict', `The conditional reference ${ref} matches ${keys.length === 0 ? 'nothing' : 'more than one resource'}`);
          }
          const [target] = await ep.store.byKeys(q, keys);
          map.set(ref, `${type}/${target.id}`);
        } catch (e) {
          throw entryError(it, e);
        }
      }
    }

    // 4. fullUrls to their resources, and the references to them
    const targets = new Map();
    for (const it of work) {
      const p = it.plan;
      const fu = it.entry.fullUrl;
      if (p.kind === 'create' || p.kind === 'update' || p.kind === 'patch' || p.kind === 'existing') {
        const local = `${p.type}/${p.id}`;
        targets.set(local, p);
        if (fu) {
          map.set(fu, local);
        }
      }
    }
    if (map.size) {
      for (const it of work) {
        if (it.efreq.body) {
          rewrite(it.efreq.body, map);
        }
      }
    }
    for (const it of work) {
      if (!it.efreq.body || it.efreq.method === 'PATCH') {
        continue;
      }
      eachReference(it.efreq.body, (r) => {
        if (URN.test(r.reference)) {
          throw entryError(it, badRequest(`The reference ${r.reference} is not the fullUrl of any resource in the transaction`));
        }
      });
    }

    // 5. references to the versions this transaction writes
    for (const it of work) {
      if (!it.efreq.body) {
        continue;
      }
      eachReference(it.efreq.body, (r) => {
        const ext = Array.isArray(r.extension) ? r.extension.find(x => x && x.url === RESOLVE_AS_VERSION_SPECIFIC) : null;
        if (!ext) {
          return;
        }
        if (ext.valueBoolean !== false) {
          const p = targets.get(r.reference);
          if (!p || !p.version && p.kind !== 'existing') {
            throw entryError(it, badRequest(`The reference ${r.reference} is to be resolved to a version, but no entry in the transaction writes it`));
          }
          r.reference = `${r.reference}/_history/${p.kind === 'existing' ? p.existing.versionId : p.version}`;
        }
        r.extension = r.extension.filter(x => x !== ext);
        if (!r.extension.length) {
          delete r.extension;
        }
      });
    }

    // 6. run the entries, in order
    const unresolved = new Set();
    for (const it of work) {
      try {
        it.result = await runEntry(ep, q, it, reserved);
      } catch (e) {
        throw entryError(it, e);
      }
      if (it.result.written && it.result.written.unresolved) {
        it.result.written.unresolved.forEach(u => unresolved.add(u));
      }
    }

    // and the references, now that everything is written
    if (ep.settings.checkReferences && unresolved.size) {
      const missing = await checkUnresolved(ep, q, unresolved);
      if (missing.length) {
        throw unprocessable(`The transaction refers to resources that don't exist: ${missing.join(', ')}`);
      }
    }
    return work;
  });
  const byIndex = new Map(results.map(it => [it.index, it]));
  const out = entries.map((e, i) => responseEntry(ep, byIndex.get(i).efreq, byIndex.get(i).result));
  return { status: 200, resource: { resourceType: 'Bundle', type: 'transaction-response', entry: out } };
}

module.exports = { bundle, batch, transaction, rewrite, rewriteNarrative, notFound };
