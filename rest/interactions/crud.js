//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * read, vread, create, update, patch and delete, and their conditional forms.
 *
 * Every write runs in one database transaction covering the resource, its version, tags,
 * index rows, compartments, subscription queue row and AuditEvent. In a transaction Bundle
 * the Bundle's own transaction is used (ctx.q).
 *
 * @module rest/interactions/crud
 */

const { badRequest, notFound, gone, preconditionFailed, unprocessable, FhirError } = require('../library/errors');
const { ifMatchVersion, etagVersion, parseQuery } = require('../request');
const { applyPatch, PatchError } = require('../library/json-patch');
const { applyFhirPathPatch } = require('../library/fhirpath-patch');
const { ID_RE } = require('../store');

/** The headers for a version: ETag, Last-Modified */
function versionHeaders(v) {
  return { ETag: `W/"${v.versionId}"`, 'Last-Modified': new Date(v.lastUpdated).toUTCString() };
}

function checkId(id) {
  if (!ID_RE.test(String(id))) {
    throw badRequest(`'${id}' is not a valid id`);
  }
}

/** Check the body is a resource of the type, with the id (or none, for create) */
function checkBody(freq, type, id) {
  const r = freq.body;
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    throw badRequest('The body must be a resource');
  }
  if (r.resourceType !== type) {
    throw badRequest(`The resource is a ${r.resourceType || '(no resourceType)'}, not a ${type}`);
  }
  if (id !== undefined) {
    if (r.id === undefined || r.id === null) {
      throw badRequest(`The resource has no id: it must be ${id}`);
    }
    if (String(r.id) !== String(id)) {
      throw badRequest(`The resource's id (${r.id}) is not the id in the URL (${id})`);
    }
  }
  return r;
}

/**
 * The If-None-Match / If-Modified-Since checks on a read: true when the client's copy is current.
 */
function notModified(freq, v) {
  const inm = freq.headers['if-none-match'];
  if (inm) {
    return etagVersion(inm) === String(v.versionId);
  }
  const ims = freq.headers['if-modified-since'];
  if (ims) {
    const t = Date.parse(ims);
    return Number.isFinite(t) && Math.floor(v.lastUpdated / 1000) * 1000 <= t;
  }
  return false;
}

async function read(ep, freq, ctx) {
  checkId(freq.id);
  ep.checkType(freq.type, 'read');
  const v = await ep.inRead(ctx, async (q) => {
    const cur = await ep.store.current(q, freq.type, freq.id);
    if (cur) {
      await ep.checkCompartments(q, ctx.access, cur.resourceKey);
    }
    return cur;
  });
  if (!v) {
    throw notFound(`${freq.type}/${freq.id} is not known`);
  }
  if (v.deleted) {
    throw gone(`${freq.type}/${freq.id} has been deleted`, { headers: versionHeaders(v) });
  }
  if (notModified(freq, v)) {
    return { status: 304, headers: versionHeaders(v) };
  }
  return { status: 200, resource: v.resource, headers: versionHeaders(v), shape: true };
}

async function vread(ep, freq, ctx) {
  checkId(freq.id);
  ep.checkType(freq.type, 'vread');
  const v = await ep.inRead(ctx, async (q) => {
    const ver = await ep.store.version(q, freq.type, freq.id, freq.vid);
    if (ver) {
      await ep.checkCompartments(q, ctx.access, ver.resourceKey);
    }
    return ver;
  });
  if (!v) {
    throw notFound(`${freq.type}/${freq.id}/_history/${freq.vid} is not known`);
  }
  if (v.deleted) {
    throw gone(`${freq.type}/${freq.id}/_history/${freq.vid} is a deletion`, { headers: versionHeaders(v) });
  }
  return { status: 200, resource: v.resource, headers: versionHeaders(v), shape: true };
}

/** The result of a write: 200 or 201, with Location and the version headers */
function writeResult(ep, freq, type, r, status) {
  const headers = versionHeaders(r);
  const loc = `${freq.base}/${type}/${r.id}/_history/${r.versionId}`;
  if (status === 201) {
    headers.Location = loc;
  } else {
    headers['Content-Location'] = loc;
  }
  return { status, resource: r.resource, headers, write: true, location: `${type}/${r.id}/_history/${r.versionId}`, written: r };
}

/**
 * The resources matching conditional criteria (If-None-Exist, a conditional update or delete).
 * @returns {Promise<number[]>} resource keys (at most limit + 1)
 */
async function conditionalMatches(ep, q, type, params, ctx, limit) {
  if (!params.length) {
    throw badRequest('A conditional interaction needs search criteria');
  }
  return ep.searcher.matchKeys(q, type, params, { access: ctx.access, limit: limit + 1, strict: true });
}

async function create(ep, freq, ctx) {
  ep.checkType(freq.type, 'create');
  const resource = checkBody(freq, freq.type);
  const settings = ep.typeSettings(freq.type);
  const ifNoneExist = freq.headers['if-none-exist'];
  if (ifNoneExist && !settings.conditionalCreate) {
    throw new FhirError(405, 'not-supported', `Conditional create is not allowed for ${freq.type}`);
  }
  const body = { ...resource };
  // a create ignores the client's id (and its meta.versionId and lastUpdated)
  delete body.id;
  const result = await ep.inWrite(ctx, async (q) => {
    if (ifNoneExist) {
      const params = parseQuery(String(ifNoneExist).replace(/^[^?]*\?/, ''));
      await ep.conditionalLock(q, freq.type, params);
      const keys = await conditionalMatches(ep, q, freq.type, params, ctx, 1);
      if (keys.length > 1) {
        throw preconditionFailed(`If-None-Exist: more than one ${freq.type} matches ${ifNoneExist}`);
      }
      if (keys.length === 1) {
        const [existing] = await ep.store.byKeys(q, keys);
        return { existing };
      }
    }
    const r = await ep.store.put(q, {
      type: freq.type, id: null, resource: body, ifMatch: null, mustCreate: true, userId: ep.userId(freq),
      reservation: ctx.reservation, reserved: ctx.reserved, deferChecks: ctx.deferChecks
    });
    await ep.recordWrite(q, freq, 'create', 201, `${freq.type}/${r.id}/_history/${r.versionId}`, r.versionKey, ctx);
    return { r };
  });
  if (result.existing) {
    const e = result.existing;
    return { status: 200, resource: e.resource, headers: versionHeaders(e), write: true, location: `${freq.type}/${e.id}/_history/${e.versionId}` };
  }
  return writeResult(ep, freq, freq.type, result.r, 201);
}

async function update(ep, freq, ctx) {
  checkId(freq.id);
  ep.checkType(freq.type, 'update');
  const resource = checkBody(freq, freq.type, freq.id);
  const settings = ep.typeSettings(freq.type);
  const r = await ep.inWrite(ctx, async (q) => {
    const cur = await ep.store.current(q, freq.type, freq.id);
    if (cur) {
      await ep.checkCompartments(q, ctx.access, cur.resourceKey);
    }
    const out = await ep.store.put(q, {
      type: freq.type, id: freq.id, resource, ifMatch: ifMatchVersion(freq), createOnUpdate: ep.settings.createOnUpdate,
      versionAware: settings.versionAware, userId: ep.userId(freq), reservation: ctx.reservation, reserved: ctx.reserved, deferChecks: ctx.deferChecks
    });
    await ep.recordWrite(q, freq, out.created ? 'create' : 'update', out.created ? 201 : 200, `${freq.type}/${out.id}/_history/${out.versionId}`, out.versionKey, ctx);
    return out;
  });
  return writeResult(ep, freq, freq.type, r, r.created ? 201 : 200);
}

async function conditionalUpdate(ep, freq, ctx) {
  ep.checkType(freq.type, 'update');
  const settings = ep.typeSettings(freq.type);
  if (!settings.conditionalUpdate) {
    throw new FhirError(405, 'not-supported', `Conditional update is not allowed for ${freq.type}`);
  }
  const resource = checkBody(freq, freq.type);
  const r = await ep.inWrite(ctx, async (q) => {
    await ep.conditionalLock(q, freq.type, freq.params);
    const keys = await conditionalMatches(ep, q, freq.type, freq.params, ctx, 1);
    if (keys.length > 1) {
      throw preconditionFailed(`More than one ${freq.type} matches the criteria`);
    }
    let id;
    if (keys.length === 1) {
      const [existing] = await ep.store.byKeys(q, keys);
      id = existing.id;
      if (resource.id && resource.id !== id) {
        throw badRequest(`The resource's id (${resource.id}) is not the id of the matching resource (${id})`);
      }
    } else {
      // no match: a create, with the client's id if it gave one
      id = resource.id || null;
    }
    const body = { ...resource };
    let out;
    if (id) {
      out = await ep.store.put(q, {
        type: freq.type, id, resource: body, ifMatch: ifMatchVersion(freq), createOnUpdate: true, versionAware: settings.versionAware,
        userId: ep.userId(freq), reserved: ctx.reserved, deferChecks: ctx.deferChecks, reservation: keys.length === 0 ? ctx.reservation : null
      });
    } else {
      delete body.id;
      out = await ep.store.put(q, { type: freq.type, id: null, resource: body, mustCreate: true, userId: ep.userId(freq),
        reservation: ctx.reservation, reserved: ctx.reserved, deferChecks: ctx.deferChecks });
    }
    await ep.recordWrite(q, freq, out.created ? 'create' : 'update', out.created ? 201 : 200, `${freq.type}/${out.id}/_history/${out.versionId}`, out.versionKey, ctx);
    return out;
  });
  return writeResult(ep, freq, freq.type, r, r.created ? 201 : 200);
}

/**
 * Applies the request's patch to a resource: a JSON Patch (an array of operations), or a
 * FHIRPath Patch (a Parameters resource, in JSON or XML)
 */
function applyRequestPatch(ep, freq, resource) {
  const p = freq.body;
  if (Array.isArray(p)) {
    // (no bigger than the biggest body the server takes: a patch can't make what a PUT couldn't)
    return applyPatch(resource, p, { maxBytes: typeof ep.options.maxBody === 'number' ? ep.options.maxBody : undefined });
  }
  if (p && p.resourceType === 'Parameters') {
    const d = ep.definitions;
    return applyFhirPathPatch(resource, p, { model: d.model, options: d.fhirpathOptions, xml: ep.xmlModel() });
  }
  throw badRequest('The body must be a JSON Patch (an array of operations) or a FHIRPath Patch (a Parameters resource)');
}

async function patchOne(ep, q, freq, ctx, type, id, settings) {
  const cur = await ep.store.current(q, type, id);
  if (!cur) {
    throw notFound(`${type}/${id} is not known`);
  }
  if (cur.deleted) {
    throw gone(`${type}/${id} has been deleted`);
  }
  await ep.checkCompartments(q, ctx.access, cur.resourceKey);
  let patched;
  try {
    patched = applyRequestPatch(ep, freq, cur.resource);
  } catch (e) {
    if (e instanceof PatchError) {
      throw unprocessable(`The patch can't be applied: ${e.message}`);
    }
    throw e;
  }
  if (!patched || patched.resourceType !== type || patched.id !== id) {
    throw unprocessable('A patch can\'t change the resource\'s type or id');
  }
  const out = await ep.store.put(q, {
    type, id, resource: patched, ifMatch: ifMatchVersion(freq), versionAware: settings.versionAware, userId: ep.userId(freq),
    reserved: ctx.reserved, deferChecks: ctx.deferChecks
  });
  await ep.recordWrite(q, freq, 'patch', 200, `${type}/${id}/_history/${out.versionId}`, out.versionKey, ctx);
  return out;
}

async function patch(ep, freq, ctx) {
  checkId(freq.id);
  ep.checkType(freq.type, 'patch');
  const settings = ep.typeSettings(freq.type);
  if (settings.versionAware && !ifMatchVersion(freq)) {
    throw preconditionFailed(`Patches to ${freq.type} must say which version they change (If-Match)`);
  }
  const r = await ep.inWrite(ctx, q => patchOne(ep, q, freq, ctx, freq.type, freq.id, settings));
  return writeResult(ep, freq, freq.type, r, 200);
}

async function conditionalPatch(ep, freq, ctx) {
  ep.checkType(freq.type, 'patch');
  const settings = ep.typeSettings(freq.type);
  if (!settings.conditionalUpdate) {
    throw new FhirError(405, 'not-supported', `Conditional patch is not allowed for ${freq.type}`);
  }
  const r = await ep.inWrite(ctx, async (q) => {
    const keys = await conditionalMatches(ep, q, freq.type, freq.params, ctx, 1);
    if (keys.length === 0) {
      throw notFound(`No ${freq.type} matches the criteria`);
    }
    if (keys.length > 1) {
      throw preconditionFailed(`More than one ${freq.type} matches the criteria`);
    }
    const [existing] = await ep.store.byKeys(q, keys);
    return patchOne(ep, q, freq, ctx, freq.type, existing.id, settings);
  });
  return writeResult(ep, freq, freq.type, r, 200);
}

async function remove(ep, freq, ctx) {
  checkId(freq.id);
  ep.checkType(freq.type, 'delete');
  const r = await ep.inWrite(ctx, async (q) => {
    const cur = await ep.store.current(q, freq.type, freq.id);
    if (cur && !cur.deleted) {
      await ep.checkCompartments(q, ctx.access, cur.resourceKey);
    }
    const out = await ep.store.put(q, { type: freq.type, id: freq.id, resource: null, ifMatch: ifMatchVersion(freq), userId: ep.userId(freq) });
    if (!out.unchanged) {
      await ep.recordWrite(q, freq, 'delete', 200, `${freq.type}/${freq.id}/_history/${out.versionId}`, out.versionKey, ctx);
    }
    return out;
  });
  const headers = r.unchanged || !r.versionId ? {} : { ETag: `W/"${r.versionId}"` };
  return { status: 200, outcome: { severity: 'information', code: 'informational',
    diagnostics: r.unchanged ? `${freq.type}/${freq.id} was already deleted, or never existed` : `Deleted ${freq.type}/${freq.id}` },
  headers, write: true, deletion: true };
}

async function conditionalDelete(ep, freq, ctx) {
  ep.checkType(freq.type, 'delete');
  const settings = ep.typeSettings(freq.type);
  if (!settings.conditionalDelete) {
    throw new FhirError(405, 'not-supported', `Conditional delete is not allowed for ${freq.type}`);
  }
  const max = Math.max(1, ep.settings.conditionalDeleteMax || 1);
  const n = await ep.inWrite(ctx, async (q) => {
    const keys = await conditionalMatches(ep, q, freq.type, freq.params, ctx, max);
    if (keys.length > max) {
      throw preconditionFailed(max === 1 ? `More than one ${freq.type} matches the criteria` : `More than ${max} ${freq.type} resources match the criteria`);
    }
    const found = await ep.store.byKeys(q, keys);
    for (const e of found) {
      const out = await ep.store.put(q, { type: freq.type, id: e.id, resource: null, ifMatch: null, userId: ep.userId(freq) });
      await ep.recordWrite(q, freq, 'delete', 200, `${freq.type}/${e.id}/_history/${out.versionId}`, out.versionKey, ctx);
    }
    return found.length;
  });
  return { status: 200, outcome: { severity: 'information', code: 'informational',
    diagnostics: n === 0 ? `No ${freq.type} matched: nothing was deleted` : `Deleted ${n} ${freq.type} resource${n === 1 ? '' : 's'}` }, write: true, deletion: true };
}

module.exports = { read, vread, create, update, conditionalUpdate, patch, conditionalPatch, remove, conditionalDelete, versionHeaders, checkBody };
