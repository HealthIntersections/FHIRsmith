//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * $expunge, as HAPI has it: versions removed for good. Nothing else ever removes history.
 *
 *   POST [base]/[type]/[id]/_history/[vid]/$expunge    that version (not the current one)
 *   POST [base]/[type]/[id]/$expunge                   that resource's
 *   POST [base]/[type]/$expunge                        every resource of the type's
 *   POST [base]/$expunge                               every resource's
 *
 * with a Parameters body (or none, for a version):
 *
 *   expungePreviousVersions   the versions before the current one
 *   expungeDeletedResources   a deleted resource, every version of it: it is gone, as if it had
 *                             never been, and its id can be used again
 *   expungeEverything         (the endpoint only) every resource, every version
 *   limit                     at most this many versions (default and most: MAX_LIMIT)
 *
 * The answer is a Parameters with count: the versions removed. A current version is never
 * removed while the resource exists: delete it first. It needs the endpoint's manage role,
 * and is audited as an operation.
 *
 * What goes with a version: its tags, and its row in the subscription queue (another row that
 * names it as the previous version no longer does). With a whole resource: its Ids row, its
 * index (a deleted resource has none), and its key in references and compartments of other
 * resources, which become references to something not there (as if never created). The
 * AuditEvents of what was removed stay: they are the record of it.
 *
 * @module rest/operations/expunge
 */

const { badRequest, notFound, conflict } = require('../library/errors');
const { INDEX_TABLES } = require('../database/schema');
const fulltext = require('../indexing/fulltext');
const observations = require('../indexing/observations');

// versions removed in one database transaction, so others' writes get their turn
const BATCH = 500;
const MAX_LIMIT = 100000;

function parameters(freq) {
  const b = freq.body;
  const out = { previous: false, deleted: false, everything: false, limit: MAX_LIMIT };
  if (b === null || b === undefined) {
    return out;
  }
  if (b.resourceType !== 'Parameters') {
    throw badRequest('$expunge takes a Parameters resource');
  }
  for (const p of Array.isArray(b.parameter) ? b.parameter : []) {
    const bool = (name) => {
      if (typeof p.valueBoolean !== 'boolean') {
        throw badRequest(`$expunge: ${name} must be a valueBoolean`);
      }
      return p.valueBoolean;
    };
    if (p.name === 'expungePreviousVersions') {
      out.previous = bool(p.name);
    } else if (p.name === 'expungeDeletedResources') {
      out.deleted = bool(p.name);
    } else if (p.name === 'expungeEverything') {
      out.everything = bool(p.name);
    } else if (p.name === 'limit') {
      const n = p.valueInteger ?? p.valuePositiveInt ?? p.valueUnsignedInt;
      if (!Number.isInteger(n) || n < 1) {
        throw badRequest('$expunge: limit must be a whole number above 0');
      }
      out.limit = Math.min(n, MAX_LIMIT);
    } else {
      throw badRequest(`$expunge doesn't know the parameter '${p.name}'`);
    }
  }
  return out;
}

const inList = (keys) => keys.map(() => '?').join(', ');

/** Remove versions (not their resources): their tags and queue rows too */
async function removeVersions(q, versionKeys) {
  if (!versionKeys.length) {
    return;
  }
  const l = inList(versionKeys);
  await q.run(`DELETE FROM VersionTags WHERE VersionKey IN (${l})`, versionKeys);
  await q.run(`DELETE FROM SubscriptionQueue WHERE VersionKey IN (${l})`, versionKeys);
  await q.run(`UPDATE SubscriptionQueue SET PreviousVersionKey = NULL WHERE PreviousVersionKey IN (${l})`, versionKeys);
  await q.run(`DELETE FROM Versions WHERE VersionKey IN (${l})`, versionKeys);
}

/** Remove a resource altogether: every version, its Ids row, and anything that keys it */
async function removeResource(q, resourceKey) {
  const versions = await q.all('SELECT VersionKey FROM Versions WHERE ResourceKey = ?', [resourceKey]);
  await removeVersions(q, versions.map(v => Number(v.VersionKey)));
  // (a deleted resource has no index; this is for one that isn't, under expungeEverything)
  for (const t of INDEX_TABLES) {
    await q.run(`DELETE FROM ${t} WHERE ResourceKey = ?`, [resourceKey]);
  }
  await q.run('DELETE FROM Compartments WHERE ResourceKey = ?', [resourceKey]);
  await fulltext.remove(q, resourceKey);
  await observations.remove(q, resourceKey);
  const contained = await q.all('SELECT ContainedKey FROM Contained WHERE ResourceKey = ?', [resourceKey]);
  for (const c of contained) {
    for (const t of INDEX_TABLES) {
      await q.run(`DELETE FROM ${t} WHERE ResourceKey = ?`, [-Number(c.ContainedKey)]);
    }
    await q.run('UPDATE IndexReferences SET TargetKey = NULL WHERE TargetKey = ?', [-Number(c.ContainedKey)]);
  }
  await q.run('DELETE FROM Contained WHERE ResourceKey = ?', [resourceKey]);
  // others' references and compartments name it by type and id: no longer keyed
  await q.run('UPDATE IndexReferences SET TargetKey = NULL WHERE TargetKey = ?', [resourceKey]);
  await q.run('UPDATE Compartments SET CompKey = NULL WHERE CompKey = ?', [resourceKey]);
  // a version audited by it (an AuditEvent expunged) no longer points at it
  await q.run('UPDATE Versions SET AuditKey = NULL WHERE AuditKey = ?', [resourceKey]);
  await q.run('DELETE FROM SearchEntries WHERE ResourceKey = ?', [resourceKey]);
  await q.run('DELETE FROM Ids WHERE ResourceKey = ?', [resourceKey]);
  return versions.length;
}

/**
 * Expunge, in batches (each its own transaction), until the limit or nothing is left.
 * @param {Object} ep
 * @param {Object} opts - previous, deleted, everything, limit; typeKey and resourceKey to
 *   narrow it
 * @returns {Promise<number>} versions removed
 */
async function run(ep, opts) {
  let count = 0;
  const where = [];
  const args = [];
  if (opts.resourceKey) {
    where.push('i.ResourceKey = ?');
    args.push(opts.resourceKey);
  } else if (opts.typeKey) {
    where.push('i.TypeKey = ?');
    args.push(opts.typeKey);
  }
  const and = where.length ? ' AND ' + where.join(' AND ') : '';
  // whole resources: deleted ones (or, for everything, all of them)
  if (opts.deleted || opts.everything) {
    let after = 0;
    for (;;) {
      const room = opts.limit - count;
      if (room <= 0) {
        break;
      }
      const done = await ep.db.write(async (q) => {
        const rows = await q.all(`SELECT i.ResourceKey, (SELECT COUNT(*) FROM Versions v WHERE v.ResourceKey = i.ResourceKey) AS N FROM Ids i
          WHERE i.ResourceKey > ? ${opts.everything ? '' : 'AND i.Deleted = 1'} AND i.MostRecent IS NOT NULL${and} ORDER BY i.ResourceKey LIMIT ${BATCH}`, [after, ...args]);
        let n = 0;
        let last = after;
        let full = false;
        for (const r of rows) {
          // a resource goes whole, or not at all
          if (n + Number(r.N) > room) {
            full = true;
            break;
          }
          n += await removeResource(q, Number(r.ResourceKey));
          last = Number(r.ResourceKey);
        }
        return { n, last, full, more: rows.length === BATCH };
      });
      count += done.n;
      after = done.last;
      if (done.full || !done.more) {
        break;
      }
    }
  }
  // the versions before the current one
  if (opts.previous) {
    let after = 0;
    for (;;) {
      const room = Math.min(BATCH, opts.limit - count);
      if (room <= 0) {
        break;
      }
      const n = await ep.db.write(async (q) => {
        const rows = await q.all(`SELECT v.VersionKey FROM Versions v JOIN Ids i ON i.ResourceKey = v.ResourceKey
          WHERE v.VersionKey > ? AND v.VersionKey <> i.MostRecent${and} ORDER BY v.VersionKey LIMIT ${room}`, [after, ...args]);
        const keys = rows.map(r => Number(r.VersionKey));
        await removeVersions(q, keys);
        if (keys.length) {
          after = keys[keys.length - 1];
        }
        return keys.length;
      });
      count += n;
      if (n < room) {
        break;
      }
    }
  }
  return count;
}

async function expunge(ep, freq) {
  const opts = parameters(freq);
  let count;
  let what = null;
  if (freq.vid) {
    // one version: not the current one
    count = await ep.db.write(async (q) => {
      const ids = await ep.store.idRow(q, freq.type, freq.id);
      const v = ids ? await q.get('SELECT VersionKey FROM Versions WHERE ResourceKey = ? AND VersionId = ?', [ids.ResourceKey, Number(freq.vid)]) : null;
      if (!v) {
        throw notFound(`${freq.type}/${freq.id}/_history/${freq.vid} is not known`);
      }
      if (Number(v.VersionKey) === Number(ids.MostRecent)) {
        throw conflict(`${freq.type}/${freq.id}/_history/${freq.vid} is the current version: it can't be expunged (delete the resource, then expunge it with expungeDeletedResources)`);
      }
      await removeVersions(q, [Number(v.VersionKey)]);
      return 1;
    });
    what = `${freq.type}/${freq.id}/_history/${freq.vid}`;
  } else {
    if (!opts.previous && !opts.deleted && !opts.everything) {
      throw badRequest('$expunge needs expungePreviousVersions, expungeDeletedResources or expungeEverything (true)');
    }
    if (opts.everything && freq.type) {
      throw badRequest('expungeEverything is for the endpoint ([base]/$expunge), not a type or a resource');
    }
    let resourceKey = null;
    if (freq.id) {
      const ids = await ep.db.read(q => ep.store.idRow(q, freq.type, freq.id));
      if (!ids) {
        throw notFound(`${freq.type}/${freq.id} is not known`);
      }
      resourceKey = Number(ids.ResourceKey);
      what = `${freq.type}/${freq.id}`;
    }
    count = await run(ep, { ...opts, resourceKey, typeKey: freq.type ? ep.store.typeKey(freq.type) : null });
  }
  await ep.db.write(q => ep.auditWrite(q, freq, 'operation', 200, what || undefined, null));
  ep.log.info(`Rest ${ep.path}: $expunge${freq.type ? ' on ' + freq.type + (freq.id ? '/' + freq.id : '') : ''} removed ${count} version(s)`);
  return { status: 200, resource: { resourceType: 'Parameters', parameter: [{ name: 'count', valueInteger: count }] } };
}

module.exports = { expunge, parameters, MAX_LIMIT, BATCH };
