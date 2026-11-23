//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Writes a resource's index rows, inside the write transaction that stores it: the index is
 * never behind the data.
 *
 * For each search parameter on the resource's type, the expression is evaluated, the results
 * turned into rows (values.js), systems turned into SpaceKeys, codes into ConceptKeys (for
 * the closure table), local references into the target's ResourceKey, and compartment rows
 * made from the compartment definitions. The old rows go first.
 *
 * @module rest/indexing/indexer
 */

const { extractValues } = require('./values');
const { INDEX_TABLES } = require('../database/schema');
const { chunks } = require('../database/lookups');
const { unprocessable } = require('../library/errors');

// the most rows one search parameter can add for one resource
const MAX_ROWS_PER_PARAM = 200;

const COLUMNS = {
  IndexStrings: ['Norm', 'Exact'],
  IndexTokens: ['SpaceKey', 'Code', 'Implicit', 'ConceptKey', 'TextNorm', 'TypeSpaceKey', 'TypeCode'],
  IndexDates: ['Lo', 'Hi'],
  IndexNumbers: ['Lo', 'Hi', 'Value'],
  IndexQuantities: ['Lo', 'Hi', 'Value', 'SpaceKey', 'Unit', 'CanonLo', 'CanonHi', 'CanonUnit'],
  IndexReferences: ['TargetKey', 'TargetType', 'TargetId', 'TargetVersion', 'Url', 'UrlVersion', 'IdentSpaceKey', 'IdentValue'],
  IndexUris: ['Value']
};

function rowKey(r) {
  const cols = COLUMNS[r.table];
  return r.table + '|' + r.Comp + '|' + r.GroupNo + '|' + cols.map(c => r[c] === undefined ? '' : r[c]).join('|') +
    '|' + (r.system || '') + '|' + (r.targetType || '') + '|' + (r.targetId || '');
}

class Indexer {
  /**
   * @param {Object} options
   * @param {import('./definitions').Definitions} options.definitions
   * @param {import('../database/lookups').Lookups} options.lookups
   * @param {Map<string, number>} options.typeKeys - resource type -> TypeKey
   * @param {string} [options.timeZone] - for dates without a zone (default: the server's)
   * @param {string[]} [options.baseUrls] - URLs that are this endpoint (references to them are local)
   * @param {boolean} [options.checkReferences] - refuse references to resources that don't exist
   * @param {function(string, string)} [options.log]
   */
  constructor(options) {
    this.definitions = options.definitions;
    this.lookups = options.lookups;
    this.typeKeys = options.typeKeys;
    this.ctx = { timeZone: options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone, baseUrls: options.baseUrls || [] };
    this.checkReferences = !!options.checkReferences;
    this.log = options.log || (() => {});
  }

  /**
   * The rows for a resource, without keys (no database).
   * @param {Object} resource
   * @returns {{rows: Object[], problems: string[]}}
   */
  extract(resource) {
    const rows = [];
    const problems = [];
    const type = resource.resourceType;
    for (const def of this.definitions.forType(type).values()) {
      if (def.key === null || def.key === undefined) {
        continue;
      }
      let nodes;
      try {
        nodes = def.fn(resource);
      } catch (e) {
        problems.push(`${def.code}: ${e.message}`);
        continue;
      }
      if (!nodes || nodes.length === 0) {
        continue;
      }
      let out = [];
      if (def.type === 'composite') {
        out = this.compositeRows(def, nodes, problems, resource);
      } else {
        out = extractValues(def.type, nodes, this.ctx);
      }
      const seen = new Set();
      let n = 0;
      for (const r of out) {
        r.ParamKey = def.key;
        r.code = def.code;
        if (r.Comp === undefined) {
          r.Comp = null;
          r.GroupNo = null;
        }
        const k = rowKey(r);
        if (seen.has(k)) {
          continue;
        }
        seen.add(k);
        if (++n > MAX_ROWS_PER_PARAM) {
          problems.push(`${def.code}: more than ${MAX_ROWS_PER_PARAM} values; the rest are not indexed`);
          break;
        }
        rows.push(r);
      }
    }
    return { rows, problems };
  }

  compositeRows(def, nodes, problems, resource) {
    const out = [];
    let g = 0;
    for (const node of nodes) {
      g++;
      let i = 0;
      for (const comp of def.component) {
        const cdef = this.definitions.byUrl.get(comp.definition);
        if (!cdef) {
          problems.push(`${def.code}: component ${comp.definition} is not known`);
          break;
        }
        let cnodes;
        try {
          cnodes = this.definitions.evaluateRelative(node, comp.expression, resource);
        } catch (e) {
          problems.push(`${def.code}: component ${comp.expression}: ${e.message}`);
          break;
        }
        for (const r of extractValues(cdef.type, cnodes, this.ctx)) {
          r.Comp = i;
          r.GroupNo = g;
          out.push(r);
        }
        i++;
      }
    }
    return out;
  }

  /**
   * Index a resource, replacing its old rows.
   * @param {Object} q - a query object in a write transaction
   * @param {Object} entry
   * @param {number} entry.resourceKey
   * @param {Object} entry.resource
   * @param {Set<string>} [entry.reserved] - "Type/id" of resources this transaction is
   *   creating (references to them are fine)
   * @param {boolean} [entry.deferChecks] - don't check references now: return them
   * @returns {Promise<{unresolved: string[]}>} local references whose target doesn't exist
   *   (only when checks are deferred)
   */
  async index(q, entry) {
    const { resourceKey, resource } = entry;
    await this.remove(q, resourceKey);
    const { rows, problems } = this.extract(resource);
    for (const p of problems) {
      this.log('debug', `Indexing ${resource.resourceType}/${resource.id}: ${p}`);
    }

    // systems
    const systems = [];
    for (const r of rows) {
      if (r.system) {
        systems.push(r.system);
      }
      if (r.typeSystem) {
        systems.push(r.typeSystem);
      }
      if (r.identSystem) {
        systems.push(r.identSystem);
      }
    }
    const spaces = await this.lookups.spaceKeys(q, systems);
    for (const r of rows) {
      if (r.table === 'IndexTokens' || r.table === 'IndexQuantities') {
        r.SpaceKey = r.system ? spaces.get(r.system) : null;
      }
      if (r.table === 'IndexTokens') {
        r.TypeSpaceKey = r.typeSystem ? spaces.get(r.typeSystem) : null;
      }
      if (r.table === 'IndexReferences') {
        r.IdentSpaceKey = r.identSystem ? spaces.get(r.identSystem) : null;
      }
    }

    // concepts
    const pairs = rows.filter(r => r.table === 'IndexTokens' && r.concept && r.SpaceKey).map(r => [r.SpaceKey, r.Code]);
    if (pairs.length) {
      const concepts = await this.lookups.conceptKeys(q, pairs);
      for (const r of rows) {
        if (r.table === 'IndexTokens') {
          r.ConceptKey = r.concept && r.SpaceKey ? (concepts.get(r.SpaceKey + '|' + r.Code) || null) : null;
        }
      }
    }

    // local references
    const unresolved = await this.resolveReferences(q, rows, entry);

    // insert
    const byTable = new Map();
    for (const r of rows) {
      if (!byTable.has(r.table)) {
        byTable.set(r.table, []);
      }
      byTable.get(r.table).push(r);
    }
    for (const [table, list] of byTable) {
      const cols = ['ResourceKey', 'ParamKey', 'GroupNo', 'Comp', ...COLUMNS[table]];
      const per = Math.max(1, Math.min(500, Math.floor(q.dialect.maxParams / cols.length)));
      for (const c of chunks(list, per)) {
        const args = [];
        for (const r of c) {
          args.push(resourceKey, r.ParamKey, r.GroupNo, r.Comp, ...COLUMNS[table].map(col => r[col] === undefined ? null : r[col]));
        }
        await q.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ` + c.map(() => '(' + cols.map(() => '?').join(', ') + ')').join(', '), args);
      }
    }

    // compartments
    const comps = this.compartmentRows(resource, rows, resourceKey);
    if (comps.length) {
      for (const c of chunks(comps, 500)) {
        await q.run('INSERT INTO Compartments (ResourceKey, CompType, CompId, CompKey) VALUES ' + c.map(() => '(?, ?, ?, ?)').join(', '),
          c.flatMap(x => [resourceKey, x.type, x.id, x.key]));
      }
    }
    return { unresolved };
  }

  async resolveReferences(q, rows, entry) {
    const refs = rows.filter(r => r.table === 'IndexReferences' && r.local && r.targetType && r.targetId);
    const unresolved = new Set();
    if (refs.length === 0) {
      return [];
    }
    const byType = new Map();
    for (const r of refs) {
      if (!byType.has(r.targetType)) {
        byType.set(r.targetType, new Set());
      }
      byType.get(r.targetType).add(r.targetId);
    }
    const found = new Map(); // Type/id -> {key, deleted}
    for (const [type, ids] of byType) {
      const typeKey = this.typeKeys.get(type);
      if (typeKey === undefined) {
        for (const id of ids) {
          unresolved.add(type + '/' + id);
        }
        continue;
      }
      for (const c of chunks([...ids])) {
        const list = await q.all(`SELECT ResourceKey, Id, Deleted FROM Ids WHERE TypeKey = ? AND Id IN (${c.map(() => '?').join(', ')})`, [typeKey, ...c]);
        for (const row of list) {
          found.set(type + '/' + row.Id, { key: Number(row.ResourceKey), deleted: !!Number(row.Deleted) });
        }
      }
    }
    const reserved = entry.reserved || new Set();
    const self = entry.resource.resourceType + '/' + entry.resource.id;
    const versioned = [];
    for (const r of refs) {
      const k = r.targetType + '/' + r.targetId;
      const f = found.get(k);
      r.TargetType = r.targetType;
      r.TargetId = r.targetId;
      r.TargetKey = f ? f.key : null;
      if ((!f || f.deleted) && !reserved.has(k) && k !== self) {
        unresolved.add(k);
      } else if (r.TargetVersion && k !== self) {
        versioned.push({ r, k, f });
      }
    }
    // a reference to a version: the version must exist (it may be one a transaction writes
    // later: with deferred checks, the transaction looks again at the end)
    for (const { r, k, f } of versioned) {
      const v = /^\d{1,9}$/.test(r.TargetVersion) && f
        ? await q.get('SELECT 1 AS ok FROM Versions WHERE ResourceKey = ? AND VersionId = ?', [f.key, Number(r.TargetVersion)]) : null;
      if (!v) {
        unresolved.add(`${k}/_history/${r.TargetVersion}`);
      }
    }
    for (const r of rows) {
      if (r.table === 'IndexReferences' && !r.local) {
        r.TargetType = null;
        r.TargetId = null;
        r.TargetKey = null;
      }
    }
    if (this.checkReferences && unresolved.size && !entry.deferChecks) {
      throw unprocessable(`The resource refers to resources that don't exist: ${[...unresolved].join(', ')}`);
    }
    return [...unresolved];
  }

  compartmentRows(resource, rows, resourceKey) {
    const out = [];
    const seen = new Set();
    const add = (type, id, key) => {
      const k = type + '/' + id;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ type, id, key });
      }
    };
    const type = resource.resourceType;
    for (const [compType, members] of this.definitions.compartments) {
      if (compType === type) {
        add(type, resource.id, resourceKey);
      }
      const params = members.get(type);
      if (!params) {
        continue;
      }
      for (const code of params) {
        if (code === '{def}') {
          continue;
        }
        for (const r of rows) {
          if (r.table === 'IndexReferences' && r.code === code && r.TargetType === compType && r.TargetId) {
            add(compType, r.TargetId, r.TargetKey);
          }
        }
      }
    }
    return out;
  }

  /**
   * Remove a resource's index and compartment rows.
   * @param {Object} q
   * @param {number} resourceKey
   */
  async remove(q, resourceKey) {
    for (const t of INDEX_TABLES) {
      await q.run(`DELETE FROM ${t} WHERE ResourceKey = ?`, [resourceKey]);
    }
    await q.run('DELETE FROM Compartments WHERE ResourceKey = ?', [resourceKey]);
  }

  /**
   * After a resource is created, fill in TargetKey in rows that already refer to it (by
   * type and id) but were written before it existed (references, and compartments).
   */
  async linkReferences(q, type, id, resourceKey) {
    await q.run('UPDATE IndexReferences SET TargetKey = ? WHERE TargetKey IS NULL AND TargetType = ? AND TargetId = ?', [resourceKey, type, id]);
    await q.run('UPDATE Compartments SET CompKey = ? WHERE CompKey IS NULL AND CompType = ? AND CompId = ?', [resourceKey, type, id]);
  }
}

module.exports = { Indexer, COLUMNS, MAX_ROWS_PER_PARAM };
