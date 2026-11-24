//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Interned values: systems and URIs (Spaces), concepts (Concepts) and tags (Tags). Each is
 * inserted with insert-or-ignore and read back, so no process allocates keys.
 *
 * Keys are cached in the process, but only for rows that were already there: a row this
 * transaction inserted isn't committed yet, and if the transaction rolls back, a cached key
 * for it would point at nothing.
 *
 * @module rest/database/lookups
 */

const MAX_CACHE = 200000;
const CHUNK = 200;

class KeyCache {
  constructor() {
    this.map = new Map();
  }

  get(k) {
    return this.map.get(k);
  }

  set(k, v) {
    if (this.map.size >= MAX_CACHE) {
      this.map.clear();
    }
    this.map.set(k, v);
  }
}

function chunks(list, n = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += n) {
    out.push(list.slice(i, i + n));
  }
  return out;
}

class Lookups {
  constructor() {
    this.spaces = new KeyCache();
    this.concepts = new KeyCache();
    this.tags = new KeyCache();
    this.paramConcepts = new KeyCache();
  }

  /**
   * Record which concepts are in which place (resource type and search parameter), for the
   * closure tables: [typeKey, paramKey, conceptKey] triples, inserted if they aren't there.
   * @param {Object} q - in a write transaction
   * @param {Array<number[]>} triples
   */
  async recordParamConcepts(q, triples) {
    const todo = [];
    const seen = new Set();
    for (const t of triples) {
      const k = t.join('|');
      if (!seen.has(k) && this.paramConcepts.get(k) === undefined) {
        seen.add(k);
        todo.push(t);
      }
    }
    for (const c of chunks(todo, 100)) {
      const where = c.map(() => '(TypeKey = ? AND ParamKey = ? AND ConceptKey = ?)').join(' OR ');
      const existing = await q.all(`SELECT TypeKey, ParamKey, ConceptKey FROM ParamConcepts WHERE ${where}`, c.flat());
      const have = new Set(existing.map(r => [r.TypeKey, r.ParamKey, r.ConceptKey].map(Number).join('|')));
      // only rows already there are cached: one inserted here is gone if the transaction rolls back
      have.forEach(k => this.paramConcepts.set(k, true));
      const toAdd = c.filter(t => !have.has(t.join('|')));
      if (toAdd.length) {
        await q.run(q.dialect.insertIgnore('ParamConcepts', ['TypeKey', 'ParamKey', 'ConceptKey', 'InClosure']) + toAdd.map(() => '(?, ?, ?, 0)').join(', '), toAdd.flat());
      }
    }
  }

  /**
   * Keys for systems/URIs, making those that don't exist (when q is in a transaction).
   * @param {Object} q
   * @param {string[]} uris
   * @param {boolean} [create] - make missing ones (false: just look them up)
   * @returns {Promise<Map<string, number>>}
   */
  async spaceKeys(q, uris, create = true) {
    const out = new Map();
    const missing = [];
    for (const u of new Set(uris.filter(x => x))) {
      const k = this.spaces.get(u);
      if (k !== undefined) {
        out.set(u, k);
      } else {
        missing.push(u);
      }
    }
    if (missing.length === 0) {
      return out;
    }
    const fresh = new Set();
    if (create) {
      for (const c of chunks(missing)) {
        // which of these are new: they are not cached when found
        const existing = await q.all(`SELECT Uri FROM Spaces WHERE Uri IN (${c.map(() => '?').join(', ')})`, c);
        const have = new Set(existing.map(r => r.Uri));
        const toAdd = c.filter(u => !have.has(u));
        if (toAdd.length) {
          await q.run(q.dialect.insertIgnore('Spaces', ['Uri']) + toAdd.map(() => '(?)').join(', '), toAdd);
          toAdd.forEach(u => fresh.add(u));
        }
      }
    }
    for (const c of chunks(missing)) {
      const rows = await q.all(`SELECT SpaceKey, Uri FROM Spaces WHERE Uri IN (${c.map(() => '?').join(', ')})`, c);
      for (const r of rows) {
        out.set(r.Uri, Number(r.SpaceKey));
        if (!fresh.has(r.Uri)) {
          this.spaces.set(r.Uri, Number(r.SpaceKey));
        }
      }
    }
    return out;
  }

  /** One space key, or null (looked up only) */
  async spaceKey(q, uri) {
    if (!uri) {
      return null;
    }
    const m = await this.spaceKeys(q, [uri], false);
    return m.has(uri) ? m.get(uri) : null;
  }

  /**
   * Keys for concepts (spaceKey, code), making missing ones, flagged as not yet in the
   * closure.
   * @param {Object} q
   * @param {Array<[number, string]>} pairs
   * @param {boolean} [create]
   * @returns {Promise<Map<string, number>>} "spaceKey|code" -> key
   */
  async conceptKeys(q, pairs, create = true) {
    const out = new Map();
    const missing = [];
    const seen = new Set();
    for (const [s, c] of pairs) {
      const k = s + '|' + c;
      if (seen.has(k)) {
        continue;
      }
      seen.add(k);
      const v = this.concepts.get(k);
      if (v !== undefined) {
        out.set(k, v);
      } else {
        missing.push([s, c]);
      }
    }
    if (missing.length === 0) {
      return out;
    }
    const fresh = new Set();
    for (const c of chunks(missing, 100)) {
      const where = c.map(() => '(SpaceKey = ? AND Code = ?)').join(' OR ');
      const args = c.flat();
      const existing = await q.all(`SELECT ConceptKey, SpaceKey, Code FROM Concepts WHERE ${where}`, args);
      const have = new Map(existing.map(r => [r.SpaceKey + '|' + r.Code, Number(r.ConceptKey)]));
      for (const [k, v] of have) {
        out.set(k, v);
        this.concepts.set(k, v);
      }
      const toAdd = c.filter(([s, code]) => !have.has(s + '|' + code));
      if (toAdd.length && create) {
        await q.run(q.dialect.insertIgnore('Concepts', ['SpaceKey', 'Code', 'InClosure']) + toAdd.map(() => '(?, ?, 0)').join(', '), toAdd.flat());
        toAdd.forEach(([s, code]) => fresh.add(s + '|' + code));
        const rows = await q.all(`SELECT ConceptKey, SpaceKey, Code FROM Concepts WHERE ${toAdd.map(() => '(SpaceKey = ? AND Code = ?)').join(' OR ')}`, toAdd.flat());
        for (const r of rows) {
          out.set(r.SpaceKey + '|' + r.Code, Number(r.ConceptKey));
        }
      }
    }
    return out;
  }

  /**
   * Keys for tags (kind 1 tag, 2 security label, 3 profile), making missing ones.
   * @param {Object} q
   * @param {Array<{kind: number, system: string, code: string, display?: string}>} tags
   * @returns {Promise<number[]>}
   */
  async tagKeys(q, tags) {
    const keys = [];
    for (const t of tags) {
      const k = `${t.kind}|${t.system}|${t.code}`;
      let v = this.tags.get(k);
      if (v === undefined) {
        let row = await q.get('SELECT TagKey FROM Tags WHERE Kind = ? AND TagSystem = ? AND Code = ?', [t.kind, t.system, t.code]);
        if (row) {
          v = Number(row.TagKey);
          this.tags.set(k, v);
        } else {
          await q.run(q.dialect.insertIgnore('Tags', ['Kind', 'TagSystem', 'Code', 'Display']) + '(?, ?, ?, ?)',
            [t.kind, t.system, t.code, t.display ? String(t.display).substring(0, 255) : null]);
          row = await q.get('SELECT TagKey FROM Tags WHERE Kind = ? AND TagSystem = ? AND Code = ?', [t.kind, t.system, t.code]);
          v = Number(row.TagKey);
        }
      }
      keys.push(v);
    }
    return keys;
  }

  /** A tag's key, or null (looked up only) */
  async tagKey(q, kind, system, code) {
    const k = `${kind}|${system}|${code}`;
    const v = this.tags.get(k);
    if (v !== undefined) {
      return v;
    }
    const row = await q.get('SELECT TagKey FROM Tags WHERE Kind = ? AND TagSystem = ? AND Code = ?', [kind, system, code]);
    return row ? Number(row.TagKey) : null;
  }
}

module.exports = { Lookups, chunks };
