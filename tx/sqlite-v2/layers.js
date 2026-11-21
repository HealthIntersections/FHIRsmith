'use strict';
// CodeSystem supplements as layers.
//
// A supplement (loaded with the server, or supplied per request through tx-resource /
// useSupplement) becomes an in-memory SQLite database with the same v2 schema as the base
// file. Its concepts carry the BASE concept_ids, so its bitmaps (prop, hasProp) combine with the
// base sets by ordinary set algebra: a filter on a supplement-defined property is just another
// IR leaf ({t:'layer'}), evaluated against the layer's store. Supplement codes the base does not
// contain are not imported (upstream treats them as unknown codes) and are counted.
//
// Displays and designations keep upstream's semantics: the base provider class reads them from
// the CodeSystem resource (_displayFromSupplements / _listSupplementDesignations), which is
// already a hash lookup per code. The layer adds what upstream cannot do: supplement property
// filters and text search over supplement designations.
//
// Built layers are kept in one small LRU per process (LayerCache below), bounded by
// settings.supplementLayerCacheMB: a repeat request with the same supplement (server-known, or
// the same tx-resource sent again) reuses the layer instead of rebuilding it. The key is base
// store + url|version + a hash of the supplement's content, so a changed supplement never hits
// an entry built from another. A cached layer is read-only (query_only) and shared by
// concurrent requests; each request holds a reference, so an evicted layer is closed only when
// the last request using it ends.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const { V2Store, KIND } = require('./store');
const { serialize, rangeSet, RoaringBitmap32 } = require('../importers/sqlite-v2/sets');
const { settings } = require('./settings');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'importers', 'sqlite-v2', 'schema-v2.sql'), 'utf8')
  .split('-- @indexes')[0];

let layerSeq = 0;

class Layer {
  constructor(store, info) {
    this.id = ++layerSeq;
    this.store = store;
    this.info = info; // { url, version, concepts, unknownCodes, buildMs, properties }
  }
}

/** literal value of a supplement property, as stored (same typing rule as the importers) */
function propValue(p) {
  for (const k of ['valueCode', 'valueString', 'valueInteger', 'valueDecimal', 'valueDateTime']) if (p[k] !== undefined) return [k.substring(5).toLowerCase(), p[k]];
  if (p.valueBoolean !== undefined) return ['boolean', p.valueBoolean ? 1 : 0];
  if (p.valueCoding) return ['code', p.valueCoding.code];
  return [null, null];
}

/**
 * Write a supplement's layer into an open, empty database: the v2 schema, its concepts under the
 * BASE concept_ids, designations, property values and their sets (buildLayer: an in-memory
 * database, kept in the process's LayerCache).
 * @returns {{concepts: object[], unknown: number, props: Map<string, number>}}
 */
function fillLayer(db, base, json) {
  db.exec(SCHEMA);
  const concepts = [];
  const walk = (list) => { for (const c of list || []) { concepts.push(c); walk(c.concept); } };
  walk(json.concept);
  const ids = base.resolveCodes(concepts.map((c) => c.code));
  let unknown = 0;
  const props = new Map();
  const insConcept = db.prepare('INSERT OR IGNORE INTO concept (concept_id, code, active, display, definition) VALUES (?, ?, 1, ?, ?)');
  const insUse = db.prepare('INSERT OR IGNORE INTO designation_use (system, code, display) VALUES (?, ?, ?)');
  const useId = db.prepare('SELECT use_id FROM designation_use WHERE system IS ? AND code = ?');
  const insDesig = db.prepare('INSERT INTO designation (concept_id, language, use_id, term, active, preferred) VALUES (?, ?, ?, ?, 1, 0)');
  const insProp = db.prepare('INSERT INTO property_def (code, uri, fhir_type, value_kind) VALUES (?, ?, ?, \'literal\')');
  const insLit = db.prepare('INSERT OR IGNORE INTO concept_literal (concept_id, property_id, group_id, value, active) VALUES (?, ?, 0, ?, 1)');
  const pending = [];
  const tx = db.transaction(() => {
    for (const pd of json.property || []) {
      const info = insProp.run(pd.code, pd.uri || null, pd.type || 'string');
      props.set(pd.code, Number(info.lastInsertRowid));
    }
    const uses = new Map();
    for (const c of concepts) {
      const id = ids.get(c.code);
      if (id == null) { unknown++; continue; }
      insConcept.run(id, c.code, c.display || null, c.definition || null);
      for (const d of c.designation || []) {
        let uid = null;
        if (d.use) {
          const k = (d.use.system || '') + '|' + d.use.code;
          uid = uses.get(k);
          if (uid === undefined) {
            insUse.run(d.use.system || null, d.use.code, d.use.display || null);
            uid = useId.get(d.use.system || null, d.use.code).use_id;
            uses.set(k, uid);
          }
        }
        insDesig.run(id, d.language || json.language || null, uid, d.value);
      }
      for (const p of c.property || []) {
        let pid = props.get(p.code);
        const [type, v] = propValue(p);
        if (v == null) continue;
        if (pid === undefined) {
          pid = Number(insProp.run(p.code, null, type).lastInsertRowid);
          props.set(p.code, pid);
        }
        insLit.run(id, pid, v);
        pending.push([pid, v, id]);
      }
    }
    // sets: all / active are the BASE ranges, so layer-side complements mean the same thing
    const insSet = db.prepare('INSERT INTO concept_set (kind, property_id, value, card, data) VALUES (?, ?, ?, ?, ?)');
    const put = (kind, pid, value, bm) => { if (bm.size) insSet.run(kind, pid, value, bm.size, serialize(bm)); };
    put(KIND.all, 0, 0, rangeSet(1, base.conceptCount));
    put(KIND.active, 0, 0, rangeSet(1, base.activeCount));
    const groups = new Map(); // pid -> Map(value -> ids)
    for (const [pid, v, id] of pending) {
      let g = groups.get(pid);
      if (!g) groups.set(pid, g = new Map());
      let l = g.get(v);
      if (!l) g.set(v, l = []);
      l.push(id);
    }
    for (const [pid, g] of groups) {
      const all = [];
      for (const [v, l] of g) {
        const bm = new RoaringBitmap32(l);
        put(KIND.prop, pid, v, bm);
        all.push(bm);
      }
      put(KIND.hasProp, pid, 0, RoaringBitmap32.orMany(all));
    }
    db.prepare(`INSERT INTO code_system (id, uri, version, name, content, concept_count, active_count) VALUES (1, ?, ?, ?, 'supplement', ?, ?)`)
      .run(json.url || 'urn:supplement', json.version || '', json.name || null, base.conceptCount, base.activeCount);
    db.exec('CREATE INDEX designation_concept ON designation(concept_id);');
  });
  tx();
  return { concepts, unknown, props };
}

/**
 * Build a layer for one supplement over a base store.
 * @param {V2Store} base
 * @param {object} json CodeSystem (content = supplement)
 */
function buildLayer(base, json) {
  const t0 = process.hrtime.bigint();
  const db = new Database(':memory:');
  db.pragma('journal_mode = OFF');
  const { concepts, unknown, props } = fillLayer(db, base, json);
  const store = new V2Store(':memory:', { db, unregistered: true });
  // read-only from here on: a layer may be shared by concurrent requests (LayerCache)
  db.pragma('query_only = ON');
  // the trigram index costs more than the rest of the layer: built on the first text search
  // (synchronously, so no other request sees it half built)
  store.ensureFts = () => {
    db.pragma('query_only = OFF');
    try {
      db.exec(`INSERT INTO search_display (rowid, term) SELECT concept_id, display FROM concept WHERE display IS NOT NULL;
               INSERT INTO search_designation (rowid, term) SELECT designation_id, term FROM designation;`);
    } finally {
      db.pragma('query_only = ON');
    }
    store.ensureFts = null;
  };
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const bytes = db.pragma('page_count', { simple: true }) * db.pragma('page_size', { simple: true });
  return new Layer(store, Object.freeze({ url: json.url, version: json.version, concepts: concepts.length - unknown, unknownCodes: unknown,
    buildMs: Math.round(ms * 10) / 10, bytes, properties: Object.freeze([...props.keys()]) }));
}

/** sha-256 of a supplement's content; computed once per resource object (resources are not mutated) */
const hashes = new WeakMap();
function contentHash(json) {
  let h = hashes.get(json);
  if (!h) {
    h = crypto.createHash('sha256').update(JSON.stringify(json)).digest('hex');
    hashes.set(json, h);
  }
  return h;
}

/**
 * The built layers of this process, least recently used first, bounded by
 * settings.supplementLayerCacheMB (the layers' SQLite pages: about 120 bytes per concept with
 * one designation). Each process of a cluster has its own.
 */
class LayerCache {
  constructor() {
    this.entries = new Map(); // key -> { key, layer, bytes, users, evicted }; Map order = LRU order
    this.bytes = 0;
    this.stats = { hits: 0, misses: 0, uncached: 0, evictions: 0 };
  }

  get maxBytes() { return settings.supplementLayerCacheMB * 1048576; }

  /**
   * A layer for `key`, built by `build` on a miss. Returns a handle; pass it to release() when
   * the request ends. A layer bigger than the whole bound is not kept (handle.entry is null).
   */
  acquire(key, build) {
    let e = this.entries.get(key);
    if (e) {
      this.stats.hits++;
      this.entries.delete(key);
      this.entries.set(key, e); // most recently used
      e.users++;
      return { layer: e.layer, entry: e };
    }
    this.stats.misses++;
    const layer = build();
    const bytes = layer.info.bytes;
    if (bytes > this.maxBytes) {
      this.stats.uncached++;
      return { layer, entry: null };
    }
    e = { key, layer, bytes, users: 1, evicted: false };
    this.entries.set(key, e);
    this.bytes += bytes;
    for (const [k, old] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this._evict(k, old);
    }
    return { layer, entry: e };
  }

  release(handle) {
    const e = handle.entry;
    if (!e) { handle.layer.store.close(); return; }
    e.users--;
    if (e.evicted && e.users === 0) e.layer.store.close();
  }

  _evict(key, e) {
    this.entries.delete(key);
    this.bytes -= e.bytes;
    this.stats.evictions++;
    e.evicted = true;
    if (e.users === 0) e.layer.store.close();
  }

  /** drop every unused entry (tests; and a lowered bound) */
  clear() {
    for (const [k, e] of this.entries) this._evict(k, e);
  }
}

const layerCache = new LayerCache();

/** the layers that apply to one request: built on first use (a filter or search that needs one) */
class LayerSet {
  /**
   * @param {Array<{json, build}>} entries the request's supplements; a layer is built only when
   *   a filter names a property that supplement defines, and closed when the request ends
   */
  constructor(entries) {
    this.entries = entries;
    this.built = [];
    this.closed = false;
  }

  get size() { return this.entries.length; }

  /** IR for a filter on a property only a supplement defines, or null */
  filterNode(compiler, prop, op, value) {
    for (const e of this.entries) {
      // a disk-backed supplement's layer is open already: its file says which properties it has
      if (e.layer ? !e.layer.store.props.has(prop) : !definesProperty(e.json, prop)) continue;
      if (!e.layer) {
        if (this.closed) {
          // the request has ended (closeProviders ran: the client went, or the batch entry is
          // done): a layer built now would never be closed
          const error = new Error('supplement layer requested after the request ended');
          error.abandoned = true;
          throw error;
        }
        const h = e.build();
        e.layer = h.layer;
        this.built.push(h);
      }
      const l = e.layer;
      const def = l.store.props.get(prop);
      if (!def) continue;
      const { Compiler } = require('./engine/compile');
      const node = new Compiler({ store: l.store, dialect: {} }, { stats: compiler.stats }).propertyFilter(def, op, value);
      return { t: 'layer', layer: l, node, label: `supplement ${l.info.url} ${prop} ${op} ${value}` };
    }
    return null;
  }

  /** release the layers this request used (an uncached one is closed; a cached one is kept) */
  close() {
    this.closed = true;
    for (const h of this.built) layerCache.release(h);
    this.built = [];
  }
}

/** does the supplement define (or use) this property? (no layer needed to answer) */
function definesProperty(json, prop) {
  if ((json.property || []).some((p) => p.code === prop)) return true;
  const walk = (list) => (list || []).some((c) => (c.property || []).some((p) => p.code === prop) || walk(c.concept));
  return walk(json.concept);
}

class SupplementLayers {
  constructor(base) {
    this.base = base;
  }

  /**
   * The layers for one request. A layer is built only when a filter needs it, and is then
   * kept in the process's LayerCache for later requests with the same supplement content.
   */
  forSupplements(supplements) {
    const layers = [];
    for (const s of supplements || []) {
      const json = s.jsonObj || s;
      if (!(json.concept && json.concept.length)) continue;
      layers.push({ json, build: () => layerCache.acquire(this.keyOf(json, s), () => buildLayer(this.base, json)) });
    }
    return new LayerSet(layers);
  }

  /**
   * cache key: the base store, the supplement's url|version, and a hash of its content. A
   * wrapper's hash is the one it remembers for the expansion cache key
   * (CanonicalResource.expansionKeyHash: the first 16 hex characters of the sha256 of the same
   * JSON), which the expansion cache key has usually just computed, so a tx-resource supplement
   * is serialised and hashed once per request; a plain resource's is the full sha256.
   */
  keyOf(json, s) {
    const h = s && s.jsonObj === json && typeof s.expansionKeyHash === 'function' ? 'k' + s.expansionKeyHash() : contentHash(json);
    return this.base.uid + '|' + (json.url || '') + '|' + (json.version || '') + '|' + h;
  }
}

module.exports = { SupplementLayers, LayerSet, LayerCache, layerCache, buildLayer, fillLayer, Layer, contentHash, SCHEMA };
