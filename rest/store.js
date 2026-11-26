//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Resources in the database: reading the current or a past version, and writing a new
 * version (with its tags, index rows, compartments and subscription queue row) inside the
 * caller's write transaction.
 *
 * Ids: a row per resource, (TypeKey, Id) unique. MostRecent is the current version's key;
 * NULL means the id is reserved by a transaction that hasn't written it yet. Deleted is 1
 * when the current version is a deletion.
 *
 * Versions: one per version, VersionId counting up from 1 per resource. A new version is
 * written by moving Ids.MostRecent from the version it was based on, as a conditional update:
 * if another request got there first, nothing changes and the write starts again from the
 * newer version (or fails, with If-Match).
 *
 * @module rest/store
 */

const zlib = require('zlib');
const crypto = require('crypto');
const fhirJson = require('../library/fhir-json');
const { FhirError, preconditionFailed, conflict, badRequest } = require('./library/errors');

const OP_CREATE = 1;
const OP_UPDATE = 2;
const OP_DELETE = 3;
const OP_NAMES = { 1: 'create', 2: 'update', 3: 'delete' };

// tag kinds in Tags
const TAG = 1;
const SECURITY = 2;
const PROFILE = 3;
const PROFILE_SYSTEM = 'urn:profile';

const ID_RE = /^[A-Za-z0-9\-.]{1,64}$/;

function encode(resource, compress) {
  const text = Buffer.from(fhirJson.stringify(resource), 'utf8');
  return compress ? { compressed: 1, content: zlib.gzipSync(text) } : { compressed: 0, content: text };
}

function decode(row) {
  if (!row || row.Content === null || row.Content === undefined) {
    return null;
  }
  let buf = Buffer.isBuffer(row.Content) ? row.Content : Buffer.from(row.Content);
  if (Number(row.Compressed)) {
    buf = zlib.gunzipSync(buf);
  }
  return fhirJson.parse(buf.toString('utf8'));
}

function newUuid() {
  return crypto.randomUUID();
}

/** The tags, security labels and profiles in a resource's meta */
function metaTags(meta) {
  const out = [];
  if (!meta) {
    return out;
  }
  for (const t of meta.tag || []) {
    if (t && t.code) {
      out.push({ kind: TAG, system: t.system || '', code: t.code, display: t.display });
    }
  }
  for (const t of meta.security || []) {
    if (t && t.code) {
      out.push({ kind: SECURITY, system: t.system || '', code: t.code, display: t.display });
    }
  }
  for (const p of meta.profile || []) {
    if (typeof p === 'string' && p) {
      out.push({ kind: PROFILE, system: PROFILE_SYSTEM, code: p.substring(0, 255) });
    }
  }
  return out;
}

class Store {
  /**
   * @param {Object} endpoint - an Endpoint: settings, typeKeys, lookups, indexer, audit
   */
  constructor(endpoint) {
    this.endpoint = endpoint;
  }

  typeKey(type) {
    const k = this.endpoint.typeKeys.get(type);
    if (k === undefined) {
      throw badRequest(`Unknown resource type ${type}`);
    }
    return k;
  }

  /**
   * The Ids row for a resource, or null.
   * @returns {Promise<{ResourceKey: number, MostRecent: number|null, Deleted: number}|null>}
   */
  async idRow(q, type, id, lock = false) {
    if (!ID_RE.test(String(id))) {
      return null;
    }
    const forUpdate = lock && q.inTransaction ? q.dialect.forUpdate || '' : '';
    const row = await q.get('SELECT ResourceKey, MostRecent, Deleted FROM Ids WHERE TypeKey = ? AND Id = ?' + forUpdate, [this.typeKey(type), id]);
    if (!row) {
      return null;
    }
    return { ResourceKey: Number(row.ResourceKey), MostRecent: row.MostRecent === null ? null : Number(row.MostRecent), Deleted: Number(row.Deleted) };
  }

  /**
   * The current version of a resource.
   * @returns {Promise<null|{resourceKey, versionKey, versionId, lastUpdated, deleted, resource, userId}>}
   *   null when there is no such resource (or only a reservation)
   */
  async current(q, type, id, lock = false) {
    const ids = await this.idRow(q, type, id, lock);
    if (!ids || ids.MostRecent === null) {
      return null;
    }
    const v = await q.get('SELECT VersionKey, VersionId, LastUpdated, Operation, UserId, Compressed, Content FROM Versions WHERE VersionKey = ?', [ids.MostRecent]);
    if (!v) {
      return null;
    }
    return this.versionResult(ids.ResourceKey, v, !!ids.Deleted);
  }

  versionResult(resourceKey, v, deleted) {
    return {
      resourceKey,
      versionKey: Number(v.VersionKey),
      versionId: Number(v.VersionId),
      lastUpdated: Number(v.LastUpdated),
      operation: Number(v.Operation),
      deleted: deleted === undefined ? Number(v.Operation) === OP_DELETE : deleted,
      userId: v.UserId,
      resource: decode(v)
    };
  }

  /** A version of a resource, or null */
  async version(q, type, id, versionId) {
    const ids = await this.idRow(q, type, id);
    if (!ids || !/^\d{1,9}$/.test(String(versionId))) {
      return null;
    }
    const v = await q.get('SELECT VersionKey, VersionId, LastUpdated, Operation, UserId, Compressed, Content FROM Versions WHERE ResourceKey = ? AND VersionId = ?',
      [ids.ResourceKey, Number(versionId)]);
    return v ? this.versionResult(ids.ResourceKey, v) : null;
  }

  /** The current resources for a list of keys (in that order; missing or deleted ones left out) */
  async byKeys(q, keys) {
    if (!keys.length) {
      return [];
    }
    const out = new Map();
    for (let i = 0; i < keys.length; i += 500) {
      const c = keys.slice(i, i + 500);
      const rows = await q.all(`SELECT i.ResourceKey, i.Id, t.Name, v.VersionKey, v.VersionId, v.LastUpdated, v.Operation, v.UserId, v.Compressed, v.Content
        FROM Ids i JOIN Types t ON t.TypeKey = i.TypeKey JOIN Versions v ON v.VersionKey = i.MostRecent
        WHERE i.Deleted = 0 AND i.ResourceKey IN (${c.map(() => '?').join(', ')})`, c);
      for (const r of rows) {
        const res = this.versionResult(Number(r.ResourceKey), r, false);
        res.type = r.Name;
        res.id = r.Id;
        out.set(Number(r.ResourceKey), res);
      }
    }
    return keys.map(k => out.get(Number(k))).filter(x => x);
  }

  /**
   * Reserve an id for a resource this transaction will create (an Ids row with no version).
   * @param {Object} q
   * @param {string} type
   * @param {string|null} id - a client id (PUT), or null for a server-assigned one
   * @returns {Promise<{resourceKey: number, id: string, existing: boolean}>}
   */
  async reserve(q, type, id) {
    const typeKey = this.typeKey(type);
    if (id) {
      if (!ID_RE.test(id)) {
        throw badRequest(`'${id}' is not a valid id`);
      }
      const row = await this.idRow(q, type, id);
      if (row) {
        return { resourceKey: row.ResourceKey, id, existing: true };
      }
      try {
        const r = await q.run('INSERT INTO Ids (TypeKey, Id, MostRecent, Deleted) VALUES (?, ?, NULL, 0)', [typeKey, id]);
        return { resourceKey: Number(r.lastId), id, existing: false };
      } catch (e) {
        if (e.unique) {
          // made by another request since we looked: the caller starts again
          e.retryable = true;
        }
        throw e;
      }
    }
    if (this.endpoint.settings.idStrategy === 'uuid') {
      const uuid = newUuid();
      const r = await q.run('INSERT INTO Ids (TypeKey, Id, MostRecent, Deleted) VALUES (?, ?, NULL, 0)', [typeKey, uuid]);
      return { resourceKey: Number(r.lastId), id: uuid, existing: false };
    }
    // the resource key: the row is made with a temporary id, then given its key as id. A
    // client may already have used that number as an id (PUT): then a UUID
    const r = await q.run('INSERT INTO Ids (TypeKey, Id, MostRecent, Deleted) VALUES (?, ?, NULL, 0)', [typeKey, '~' + newUuid().substring(0, 30)]);
    const key = Number(r.lastId);
    let newId = String(key);
    const taken = await q.get('SELECT ResourceKey FROM Ids WHERE TypeKey = ? AND Id = ?', [typeKey, newId]);
    if (taken) {
      newId = newUuid();
    }
    await q.run('UPDATE Ids SET Id = ? WHERE ResourceKey = ?', [newId, key]);
    return { resourceKey: key, id: newId, existing: false };
  }

  /**
   * Write a new version of a resource (create, update or delete).
   * @param {Object} q - in a write transaction
   * @param {Object} w
   * @param {string} w.type
   * @param {string} w.id
   * @param {number} w.resourceKey - from reserve() or the current version
   * @param {number|null} w.basedOn - the version key this is based on (null for a create)
   * @param {number} w.previousVersionId - 0 for a create
   * @param {Object|null} w.resource - null for a delete
   * @param {number} w.operation - OP_CREATE, OP_UPDATE, OP_DELETE
   * @param {string|null} w.userId
   * @param {Set<string>} [w.reserved] - Type/id of resources this transaction creates
   * @param {boolean} [w.deferChecks]
   * @param {number} [w.now]
   * @returns {Promise<{versionKey, versionId, lastUpdated, resource, unresolved}>}
   */
  async writeVersion(q, w) {
    const ep = this.endpoint;
    const now = w.now || Date.now();
    const versionId = (w.previousVersionId || 0) + 1;
    let resource = null;
    if (w.resource) {
      resource = { ...w.resource, id: w.id };
      resource.meta = { ...(resource.meta || {}), versionId: String(versionId), lastUpdated: new Date(now).toISOString() };
    }
    const enc = resource ? encode(resource, ep.settings.compress) : { compressed: 0, content: null };
    let vr;
    try {
      vr = await q.run('INSERT INTO Versions (ResourceKey, VersionId, LastUpdated, Operation, UserId, AuditKey, Compressed, Content) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
        [w.resourceKey, versionId, now, w.operation, w.userId ? String(w.userId).substring(0, 128) : null, enc.compressed, enc.content]);
    } catch (e) {
      if (e.unique) {
        e.retryable = true;
      }
      throw e;
    }
    const versionKey = Number(vr.lastId);
    const deleted = w.operation === OP_DELETE ? 1 : 0;
    const moved = w.basedOn === null || w.basedOn === undefined
      ? await q.run('UPDATE Ids SET MostRecent = ?, Deleted = ? WHERE ResourceKey = ? AND MostRecent IS NULL', [versionKey, deleted, w.resourceKey])
      : await q.run('UPDATE Ids SET MostRecent = ?, Deleted = ? WHERE ResourceKey = ? AND MostRecent = ?', [versionKey, deleted, w.resourceKey, w.basedOn]);
    if (!moved.changes) {
      // another request wrote a version first
      const e = conflict(`${w.type}/${w.id} was changed by another request`);
      e.retryable = true;
      throw e;
    }
    let unresolved = [];
    if (resource) {
      const tagKeys = await ep.lookups.tagKeys(q, metaTags(resource.meta));
      if (tagKeys.length) {
        const uniq = [...new Set(tagKeys)];
        await q.run('INSERT INTO VersionTags (VersionKey, TagKey) VALUES ' + uniq.map(() => '(?, ?)').join(', '), uniq.flatMap(k => [versionKey, k]));
      }
      const r = await ep.indexer.index(q, { resourceKey: w.resourceKey, resource, reserved: w.reserved, deferChecks: w.deferChecks });
      unresolved = r.unresolved;
    } else {
      await ep.indexer.remove(q, w.resourceKey);
    }
    if (w.operation === OP_CREATE || (w.previousVersionId > 0 && w.previousDeleted)) {
      await ep.indexer.linkReferences(q, w.type, w.id, w.resourceKey);
    }
    if (w.type === 'SearchParameter' && ep.settings.customSearchParameters) {
      // the definitions change: every process reloads them, and the master reindexes
      await require('./endpoint/settings').bumpGeneration(q);
    }
    await q.run('INSERT INTO SubscriptionQueue (ResourceKey, VersionKey, PreviousVersionKey, Operation, Entered, Handled) VALUES (?, ?, ?, ?, ?, NULL)',
      [w.resourceKey, versionKey, w.basedOn || null, w.operation, now]);
    return { versionKey, versionId, lastUpdated: now, resource, unresolved };
  }

  /**
   * Create, update or delete with the version checks: the common path for every write.
   * @param {Object} q
   * @param {Object} p
   * @param {string} p.type
   * @param {string|null} p.id - null: a server-assigned id (create)
   * @param {Object|null} p.resource - null: delete
   * @param {string|null} p.ifMatch - the version the client says it is updating
   * @param {boolean} [p.mustCreate] - a create: an existing id is a conflict
   * @param {boolean} [p.createOnUpdate]
   * @param {boolean} [p.versionAware] - the type needs If-Match on update
   * @param {string|null} p.userId
   * @param {Object} [p.reservation] - an id already reserved by this transaction
   * @returns {Promise<{created: boolean, deleted: boolean, unchanged: boolean, id, resourceKey, versionKey, versionId, lastUpdated, resource, previous}>}
   */
  async put(q, p) {
    let reservation = p.reservation || null;
    let cur = null;
    let ids = null;
    // the row is locked (MySQL) until the transaction ends: another write to the same
    // resource waits for this one
    if (!reservation && p.id) {
      ids = await this.idRow(q, p.type, p.id, true);
    }
    if (reservation) {
      ids = await this.idRow(q, p.type, reservation.id, true);
    }
    if (ids && ids.MostRecent !== null) {
      cur = await this.current(q, p.type, p.id || reservation.id);
    }
    if (p.mustCreate && cur && !cur.deleted) {
      throw conflict(`${p.type}/${p.id} already exists`);
    }
    if (p.ifMatch !== null && p.ifMatch !== undefined) {
      if (!cur || String(cur.versionId) !== String(p.ifMatch)) {
        throw preconditionFailed(cur ? `Version ${p.ifMatch} is not the current version (${cur.versionId}) of ${p.type}/${p.id}`
          : `${p.type}/${p.id} doesn't exist (If-Match ${p.ifMatch})`);
      }
    } else if (p.versionAware && cur && !cur.deleted && p.resource) {
      throw preconditionFailed(`Updates to ${p.type} must say which version they update (If-Match)`);
    }
    if (!p.resource) {
      // delete
      if (!cur || cur.deleted) {
        return { deleted: true, unchanged: true, id: p.id, resourceKey: ids ? ids.ResourceKey : null, versionId: cur ? cur.versionId : null, previous: cur };
      }
      const r = await this.writeVersion(q, { type: p.type, id: p.id, resourceKey: cur.resourceKey, basedOn: cur.versionKey,
        previousVersionId: cur.versionId, resource: null, operation: OP_DELETE, userId: p.userId });
      return { deleted: true, unchanged: false, id: p.id, resourceKey: cur.resourceKey, ...r, previous: cur };
    }
    if (!cur && !reservation) {
      if (p.id && !p.createOnUpdate && !p.mustCreate) {
        throw new FhirError(405, 'not-supported', `${p.type}/${p.id} doesn't exist, and this server doesn't create resources by PUT`);
      }
      reservation = ids ? { resourceKey: ids.ResourceKey, id: p.id } : await this.reserve(q, p.type, p.id);
    }
    const id = cur ? p.id || reservation.id : reservation.id;
    const resourceKey = cur ? cur.resourceKey : reservation.resourceKey;
    const operation = cur && !cur.deleted ? OP_UPDATE : OP_CREATE;
    const r = await this.writeVersion(q, {
      type: p.type, id, resourceKey, basedOn: cur ? cur.versionKey : null, previousVersionId: cur ? cur.versionId : 0,
      previousDeleted: cur ? cur.deleted : false, resource: p.resource, operation,
      userId: p.userId, reserved: p.reserved, deferChecks: p.deferChecks
    });
    return { created: !cur || cur.deleted, deleted: false, unchanged: false, id, resourceKey, ...r, previous: cur };
  }

  /** Set the AuditEvent that recorded a version */
  async setAudit(q, versionKey, auditKey) {
    await q.run('UPDATE Versions SET AuditKey = ? WHERE VersionKey = ?', [auditKey, versionKey]);
  }

  /**
   * Replace the meta of the current version without a new version ($meta-add, $meta-delete).
   */
  async rewriteMeta(q, cur, type, resource) {
    const ep = this.endpoint;
    const enc = encode(resource, ep.settings.compress);
    await q.run('UPDATE Versions SET Compressed = ?, Content = ? WHERE VersionKey = ?', [enc.compressed, enc.content, cur.versionKey]);
    await q.run('DELETE FROM VersionTags WHERE VersionKey = ?', [cur.versionKey]);
    const tagKeys = [...new Set(await ep.lookups.tagKeys(q, metaTags(resource.meta)))];
    if (tagKeys.length) {
      await q.run('INSERT INTO VersionTags (VersionKey, TagKey) VALUES ' + tagKeys.map(() => '(?, ?)').join(', '), tagKeys.flatMap(k => [cur.versionKey, k]));
    }
    await ep.indexer.index(q, { resourceKey: cur.resourceKey, resource });
  }

  /** Whether any resource exists (for deciding whether new definitions need reindexing) */
  async hasResources(q) {
    const row = await q.get('SELECT ResourceKey FROM Ids WHERE MostRecent IS NOT NULL LIMIT 1');
    return !!row;
  }
}

module.exports = { Store, encode, decode, metaTags, OP_CREATE, OP_UPDATE, OP_DELETE, OP_NAMES, TAG, SECURITY, PROFILE, PROFILE_SYSTEM, ID_RE };
