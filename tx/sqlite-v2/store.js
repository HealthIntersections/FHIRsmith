'use strict';
// One sqlite-v2 file (one release of one code system), opened read-only.
//
// The store is the only code that talks SQL. SQLite holds facts (rows); the Roaring bitmaps in
// concept_set answer every membership question. Everything here is batched: sets are loaded per
// (kind, property) with one statement for any number of keys, page rows with one statement per
// table, and every statement is prepared once.
//
// Schema: tx/importers/sqlite-v2/schema-v2.sql.

const Database = require('better-sqlite3');
const { RoaringBitmap32 } = require('roaring');
const { storedHierarchyOrder } = require('./orders');

const KIND = Object.freeze({ all: 1, active: 2, leaf: 3, descendants: 4, prop: 5, hasProp: 6, refset: 7 });

let ownerSeq = 0;

/** every open store and engine, for /<name>/stats */
const registry = { stores: new Set(), engines: new Set() };

const EMPTY = Object.freeze(new RoaringBitmap32());

function primaryLang(l) { return String(l || 'en').toLowerCase().split('-')[0]; }

/**
 * Count one statement in a trace's counters (stats is the tracer's; callers check it is set).
 * With a trace, the tracer also records what the statement read: database, table, index and
 * statement shape (trace.js).
 */
function count(stats, store, st, rows) {
  stats.statements++;
  stats.rows += rows;
  if (stats.read) stats.read(store, st, rows);
}

/**
 * A read-only connection to a file that is never written in place (rollback journal: terminology,
 * package and supplement files are built aside and renamed into place): hold the shared lock for
 * the life of the connection (locking_mode EXCLUSIVE, which for a reader is a SHARED lock never
 * released) instead of taking and dropping it, and re-checking for a journal, around every
 * statement: 7 system calls (4 fcntl, 2 stat, 1 fstat) per statement otherwise. Other readers are
 * not affected; a writer would be blocked, and there is none. A WAL file (VSAC's content file,
 * which its sync writes in place) keeps normal locking.
 */
function holdReadLock(db) {
  if (String(db.pragma('journal_mode', { simple: true })).toLowerCase() !== 'wal') db.pragma('locking_mode = EXCLUSIVE');
}

function setKey(kind, pid, value) {
  return kind + ':' + pid + ':' + (typeof value === 'string' ? 's' + value : value);
}

class V2Store {
  /**
   * @param {string} file path, or ':memory:' style handle for a layer
   * @param {object} [opts] { db: an already open better-sqlite3 handle, setCacheBytes, readonly,
   *   block: the code_system id this store serves (default 1; a package file has one block per
   *   CodeSystem), stmts: a statement map shared by the blocks of one file }
   */
  constructor(file, opts = {}) {
    this.file = file;
    this.db = opts.db || new Database(file, { readonly: true, fileMustExist: true });
    if (!opts.db) {
      this.db.pragma('query_only = 1');
      // a small SQLite page cache per connection; reads go through mmap and the OS page cache
      const { settings } = require('./settings');
      this.db.pragma(`cache_size = -${settings.sqliteCacheKB}`);
      this.db.pragma(`mmap_size = ${settings.mmapMB * 1048576}`);
      holdReadLock(this.db);
    }
    this._stmts = opts.stmts || new Map();
    this.block = opts.block || 1;
    this.uid = ++ownerSeq;
    this._loadMeta();
    if (!opts.unregistered) registry.stores.add(this);
  }

  close() {
    registry.stores.delete(this);
    try { this.db.close(); } catch (e) { /* already closed */ }
  }

  /**
   * Run a whole-table read (load-time data) through SQLite's page cache instead of the mmap
   * window, so it does not leave hundreds of MiB of the file mapped into the process.
   */
  withoutMmap(fn) {
    const before = this.db.pragma('mmap_size', { simple: true });
    this.db.pragma('mmap_size = 0');
    try {
      return fn();
    } finally {
      this.db.pragma(`mmap_size = ${before}`);
    }
  }

  stmt(sql) {
    let s = this._stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this._stmts.set(sql, s);
    }
    return s;
  }

  // ---- metadata ---------------------------------------------------------------------------

  _loadMeta() {
    const cs = this.db.prepare('SELECT * FROM code_system WHERE id = ?').get(this.block);
    if (!cs) throw new Error(`${this.file}: no code_system row ${this.block} (not a sqlite-v2 file?)`);
    this.cs = cs;
    this.system = cs.uri;
    this.version = cs.version;
    this.conceptCount = cs.concept_count;
    this.activeCount = cs.active_count;
    // block bounds: this store's concepts are lo..hi. A terminology file is one block (lo = 1).
    // Package blocks (FHIR CodeSystems, `resource` set) key their all/active/leaf sets by block id.
    this.lo = (cs.id_base || 0) + 1;
    this.hi = (cs.id_base || 0) + cs.concept_count;
    this.blockKey = cs.resource != null ? this.block : 0;
    this.fhirBlock = cs.resource != null;
    delete cs.resource; // the resource JSON is read when needed (StoredCodeSystem), not kept per store
    this.config = {};
    for (const r of (this.fhirBlock ? [] : this.db.prepare('SELECT key, value FROM cs_config').all())) {
      let v = r.value;
      if (/^[[{]/.test(v)) { try { v = JSON.parse(v); } catch (e) { /* keep text */ } }
      this.config[r.key] = v;
    }
    // LOINC CLASSTYPE 3: main names it 'Claims attachment' (cs-loinc.js classTypes, as the HL7
    // tests expect); files built before the importer said so carry 'Claims attachments'. Both
    // spellings are accepted in filters, as main accepts them.
    const ct = this.config.propertyValueDescriptions && this.config.propertyValueDescriptions.CLASSTYPE;
    if (ct && ct['3'] === 'Claims attachments') {
      ct['3'] = 'Claims attachment';
      this.config.propertyValueAliases = { ...(this.config.propertyValueAliases || {}), CLASSTYPE: { 'claims attachments': '3' } };
    }
    this.props = new Map();     // code -> def
    this.propsById = new Map(); // id -> def
    const perBlock = this.db.prepare('PRAGMA table_info(property_def)').all().some((c) => c.name === 'cs_id');
    const propRows = perBlock
      ? this.db.prepare('SELECT * FROM property_def WHERE cs_id = ? ORDER BY property_id').all(this.block)
      : this.db.prepare('SELECT * FROM property_def ORDER BY property_id').all();
    for (const p of propRows) {
      const def = { id: p.property_id, code: p.code, uri: p.uri, type: p.fhir_type, kind: p.value_kind, isHierarchy: !!p.is_hierarchy, display: p.display };
      this.props.set(p.code, def);
      this.propsById.set(def.id, def);
    }
    this.hierarchy = [...this.props.values()].find((p) => p.isHierarchy) || null;
    this.uses = new Map();
    for (const u of this.db.prepare('SELECT * FROM designation_use').all()) {
      this.uses.set(u.use_id, { system: u.system, code: u.code, display: u.display });
    }
    const hasTable = (n) => !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(n);
    this.hasFts = hasTable('search_display');
    this.hasAcceptability = hasTable('designation_acceptability');
    // an empty acceptability table (LOINC, RxNorm): no per-row subquery
    if (this.hasAcceptability) this.hasAcceptability = !!this.db.prepare('SELECT 1 FROM designation_acceptability LIMIT 1').get();
    // v5 SNOMED CT files rank each designation at import (designation.rank): its display order
    // needs no acceptability then. Older files read acceptability per designation
    this.hasRank = this.hasAcceptability && this.db.prepare('PRAGMA table_info(designation)').all().some((c) => c.name === 'rank')
      && !!this.db.prepare('SELECT 1 FROM designation WHERE rank IS NOT NULL LIMIT 1').get();
    // files built with the links' release order (SNOMED CT from RF2, link_order): the orders the
    // built-in provider lists parents, children and relationships in
    this.hasLinkOrder = hasTable('link_order');
    // files built with the built-in importer's key order (LOINC, concept_order): the orders the
    // built-in provider lists filter results and the whole system in
    this.hasConceptOrder = hasTable('concept_order');
  }

  /**
   * The release order of a concept's active links ("property:group:target" -> seq), or null for
   * a file without link_order
   */
  linkSeqFrom(id) {
    if (!this.hasLinkOrder) return null;
    const m = new Map();
    for (const [p, g, t, seq] of this.stmt('SELECT property_id, group_id, target_id, seq FROM link_order WHERE source_id = ? AND active = 1').raw().all(id)) m.set(p + ':' + g + ':' + t, seq);
    return m;
  }

  /**
   * A concept's parent and child relations in the built-in provider's order (LOINC files with the
   * stored hierarchy order, orders.js): Uint32Array of related ids, HIER_CHILD set on children;
   * null for a file without it
   */
  hierarchyOrderOf(id) {
    if (this._hierOrder === undefined) this._hierOrder = storedHierarchyOrder(this);
    return this._hierOrder ? this._hierOrder.of(id) : null;
  }

  /**
   * The concepts with an active group-0 link of this property to the concept, in release order
   * (cs-snomed.js getConceptChildren: inbound relationships by row), or null without link_order
   */
  linkSourcesInOrder(propertyId, id) {
    if (!this.hasLinkOrder) return null;
    return this.stmt('SELECT source_id FROM link_order WHERE target_id = ? AND property_id = ? AND active = 1 AND group_id = 0 ORDER BY seq').pluck().all(id, propertyId);
  }

  // ---- sets -------------------------------------------------------------------------------

  /**
   * Load sets for many keys of one (kind, property): one statement whatever the number of keys.
   * Missing rows are empty sets. Returns Map(value -> bitmap). Nothing is kept between requests:
   * `local` is the caller's working set for one evaluation (each set read once per evaluation).
   * @param {object} [stats] counters to add to (statements, rows, bytes, loaded, us)
   * @param {Map} [local] key -> bitmap already read in this evaluation
   */
  loadSets(kind, pid, values, stats, local) {
    const out = new Map();
    const miss = [];
    for (const v of values) {
      const b = local && local.get(setKey(kind, pid, v));
      if (b) out.set(v, b);
      else miss.push(v);
    }
    if (miss.length) {
      const t0 = stats ? process.hrtime.bigint() : 0n;
      let rows;
      let q;
      if (miss.length === 1) {
        q = this.stmt('SELECT value, data FROM concept_set WHERE kind = ? AND property_id = ? AND value = ?');
        const r = q.get(kind, pid, miss[0]);
        rows = r ? [r] : [];
      } else {
        q = this.stmt('SELECT value, data FROM concept_set WHERE kind = ? AND property_id = ? AND value IN (SELECT value FROM json_each(?))');
        rows = q.all(kind, pid, JSON.stringify(miss));
      }
      let bytes = 0;
      const named = stats && stats.sets ? [] : null;
      for (const r of rows) {
        const b = RoaringBitmap32.deserialize(r.data, 'portable');
        bytes += r.data.length;
        out.set(r.value, b);
        if (local) local.set(setKey(kind, pid, r.value), b);
        if (named) named.push({ value: r.value, card: b.size, bytes: r.data.length });
      }
      for (const v of miss) {
        if (!out.has(v)) {
          out.set(v, EMPTY);
          if (local) local.set(setKey(kind, pid, v), EMPTY);
        }
      }
      if (stats) {
        count(stats, this, q, rows.length);
        if (named) stats.sets(this, kind, pid, named);
        stats.setsLoaded += rows.length;
        stats.setBytes += bytes;
        stats.setLoadUs += Number(process.hrtime.bigint() - t0) / 1000;
      }
    }
    return out;
  }

  getSet(kind, pid, value, stats, local) {
    return this.loadSets(kind, pid, [value], stats, local).get(value);
  }

  all(stats, local) { return this.getSet(KIND.all, 0, this.blockKey, stats, local); }
  active(stats, local) { return this.getSet(KIND.active, 0, this.blockKey, stats, local); }
  leaf(stats, local) { return this.getSet(KIND.leaf, 0, this.blockKey, stats, local); }

  /** keys (values) of the stored prop sets of one property, with their cardinalities */
  propValues(pid, stats) {
    const q = this.stmt('SELECT value, card FROM concept_set WHERE kind = 5 AND property_id = ?');
    const r = q.all(pid);
    if (stats) count(stats, this, q, r.length);
    return r;
  }

  // ---- codes ------------------------------------------------------------------------------

  /** code -> concept_id for many codes in one statement (null when unknown) */
  resolveCodes(codes, stats) {
    const out = new Map();
    const want = [...new Set(codes.filter((c) => c != null).map(String))];
    if (!want.length) return out;
    const q = want.length === 1
      ? this.stmt('SELECT concept_id, code FROM concept WHERE code = ? AND concept_id BETWEEN ? AND ?')
      : this.stmt('SELECT concept_id, code FROM concept WHERE code IN (SELECT value FROM json_each(?)) AND concept_id BETWEEN ? AND ?');
    const rows = want.length === 1 ? [q.get(want[0], this.lo, this.hi)].filter(Boolean) : q.all(JSON.stringify(want), this.lo, this.hi);
    for (const r of rows) out.set(r.code, r.concept_id);
    for (const c of want) if (!out.has(c)) out.set(c, null);
    if (stats) count(stats, this, q, rows.length);
    return out;
  }

  /** code -> concept row for many codes, in one statement (resolveCodes and conceptRows together); unknown codes absent */
  rowsForCodes(codes, stats) {
    const out = new Map();
    const want = [...new Set(codes.filter((c) => c != null).map(String))];
    if (!want.length) return out;
    const q = this.stmt('SELECT c.concept_id, c.code, c.active, c.display, c.definition FROM json_each(?) j JOIN concept c ON c.code = j.value AND c.concept_id BETWEEN ? AND ?');
    const rows = q.all(JSON.stringify(want), this.lo, this.hi);
    for (const r of rows) out.set(r.code, r);
    if (stats) count(stats, this, q, rows.length);
    return out;
  }

  /** the concept row for one code (resolveCodes and conceptRows together, one statement), or null */
  rowForCode(code, stats) {
    const q = this.stmt('SELECT concept_id, code, active, display, definition FROM concept WHERE code = ? AND concept_id BETWEEN ? AND ?');
    const r = q.get(String(code), this.lo, this.hi) || null;
    if (stats) count(stats, this, q, r ? 1 : 0);
    return r;
  }

  idOf(code, stats) {
    return this.resolveCodes([code], stats).get(code);
  }

  /** case-insensitive code match (for case-insensitive systems), or null */
  idOfNoCase(code) {
    const r = this.stmt('SELECT concept_id FROM concept WHERE code = ? COLLATE NOCASE AND concept_id BETWEEN ? AND ? LIMIT 1').get(code, this.lo, this.hi);
    return r ? r.concept_id : null;
  }

  // ---- rows (facts) -----------------------------------------------------------------------

  /** concepts whose display matches an FTS5 trigram query (one statement); a bitmap */
  ftsDisplayIds(query, stats) {
    const q = this.stmt('SELECT rowid FROM search_display WHERE search_display MATCH ? AND rowid BETWEEN ? AND ?');
    const ids = q.pluck().all(query, this.lo, this.hi);
    if (stats) count(stats, this, q, ids.length);
    return new RoaringBitmap32(ids);
  }

  /** concept rows for ids, in one statement; Map(id -> row) */
  conceptRows(ids, stats) {
    const out = new Map();
    if (!ids.length) return out;
    const q = ids.length === 1
      ? this.stmt('SELECT concept_id, code, active, display, definition FROM concept WHERE concept_id = ?')
      : this.stmt('SELECT concept_id, code, active, display, definition FROM concept WHERE concept_id IN (SELECT value FROM json_each(?))');
    const rows = ids.length === 1 ? [q.get(ids[0])].filter(Boolean) : q.all(JSON.stringify(Array.from(ids)));
    for (const r of rows) out.set(r.concept_id, r);
    if (stats) count(stats, this, q, rows.length);
    return out;
  }

  /**
   * designations for ids, in one statement; Map(id -> [{id, language, use, term, active, preferred, acceptability?}]),
   * each list in designation_id order. opts.skipUse: a use_id not to read (LOINC RELATEDNAMES2 when the
   * caller never shows them); opts.onlyUse: read that use_id only. A designation has `rank` (v5 SNOMED CT
   * files: tx/importers/sqlite-v2/builder.js _rankDesignations) or else `acc` (refset:acceptability, ...);
   * opts.withAcc: acc in any case.
   */
  designationRows(ids, stats, opts = {}) {
    const out = new Map();
    if (!ids.length) return out;
    const useCond = opts.onlyUse != null ? `AND d.use_id = ${Number(opts.onlyUse)}` : opts.skipUse != null ? `AND d.use_id IS NOT ${Number(opts.skipUse)}` : '';
    const sql = this.hasAcceptability && (opts.withAcc || !this.hasRank)
      ? `SELECT d.designation_id, d.concept_id, d.language, d.use_id, d.term, d.active, d.preferred,
                (SELECT group_concat(a.refset_id || ':' || a.acceptability_id) FROM designation_acceptability a WHERE a.designation_id = d.designation_id) AS acc,
                ${this.hasRank ? 'd.rank' : 'NULL'}
         FROM designation d WHERE d.concept_id IN (SELECT value FROM json_each(?)) ${useCond} ORDER BY d.designation_id`
      : `SELECT d.designation_id, d.concept_id, d.language, d.use_id, d.term, d.active, d.preferred, NULL AS acc, ${this.hasRank ? 'd.rank' : 'NULL'}
         FROM designation d WHERE d.concept_id IN (SELECT value FROM json_each(?)) ${useCond} ORDER BY d.designation_id`;
    // one id: `= +?`, not json_each. (+? also keeps SQLite from re-preparing the statement for each
    // new value, as it does for a bare parameter on a non-unique index when sqlite_stat4 is present.)
    const one = ids.length === 1;
    // rows as arrays (raw): the designation objects below are the only ones made per row
    const q = this.stmt(one ? sql.replace('d.concept_id IN (SELECT value FROM json_each(?))', 'd.concept_id = +?') : sql).raw(true);
    const rows = one ? q.all(ids[0]) : q.all(JSON.stringify(Array.from(ids)));
    let l = null;
    let lid = null;
    for (const r of rows) {
      // [designation_id, concept_id, language, use_id, term, active, preferred, acc, rank]
      if (r[1] !== lid) {
        lid = r[1];
        l = out.get(lid);
        if (!l) out.set(lid, l = []);
      }
      l.push({
        id: r[0], language: r[2], use: r[3] != null ? this.uses.get(r[3]) : null,
        term: r[4], active: !!r[5], preferred: !!r[6], acc: r[7], rank: r[8]
      });
    }
    if (stats) count(stats, this, q, rows.length);
    return out;
  }

  /** the active value of one literal property for ids, in one statement; Map(id -> value) (first row per id) */
  literalValues(ids, pid, stats) {
    const out = new Map();
    if (!ids.length) return out;
    // one id: `= +?` (3.4 -> 1.4 us), not json_each; a bare ? on this PK prefix would be re-prepared for
    // each new value (sqlite_stat4), as designationRows notes
    const q = ids.length === 1
      ? this.stmt('SELECT concept_id, value FROM concept_literal WHERE concept_id = +? AND property_id = ? AND active = 1')
      : this.stmt('SELECT concept_id, value FROM concept_literal WHERE property_id = ? AND active = 1 AND concept_id IN (SELECT value FROM json_each(?))');
    const rows = ids.length === 1 ? q.all(ids[0], pid) : q.all(pid, JSON.stringify(Array.from(ids)));
    for (const r of rows) if (!out.has(r.concept_id)) out.set(r.concept_id, r.value);
    if (stats) count(stats, this, q, rows.length);
    return out;
  }

  /** concept-valued facts from sources (one statement); rows {s, p, g, t, active} */
  linksFrom(ids, pids = null, activeOnly = true, stats) {
    if (!ids.length) return [];
    const q = this.stmt(`SELECT source_id AS s, property_id AS p, group_id AS g, target_id AS t, active FROM concept_link
       WHERE source_id IN (SELECT value FROM json_each(?)) ${activeOnly ? 'AND active = 1' : ''}`);
    const rows = q.all(JSON.stringify(Array.from(ids)));
    if (stats) count(stats, this, q, rows.length);
    return pids ? rows.filter((r) => pids.has(r.p)) : rows;
  }

  /** literal facts for ids (one statement); rows {c, p, g, v, active} */
  literalsOf(ids, activeOnly = true, stats) {
    if (!ids.length) return [];
    const q = this.stmt(`SELECT concept_id AS c, property_id AS p, group_id AS g, value AS v, active FROM concept_literal
       WHERE concept_id IN (SELECT value FROM json_each(?)) ${activeOnly ? 'AND active = 1' : ''}`);
    const rows = q.all(JSON.stringify(Array.from(ids)));
    if (stats) count(stats, this, q, rows.length);
    return rows;
  }

  /** direct parents over the hierarchy property (active links) */
  parentsOf(id, stats) {
    if (!this.hierarchy) return [];
    const q = this.stmt('SELECT target_id FROM concept_link WHERE source_id = +? AND property_id = ? AND active = 1');
    const rows = q.all(id, this.hierarchy.id);
    if (stats) count(stats, this, q, rows.length);
    return rows.map((r) => r.target_id);
  }

  /** all ancestors: walk direct links upward. With explicit-pair hierarchies (LOINC) keep only A with D(A).has(id). */
  ancestorsOf(id, stats) {
    const seen = new Set();
    let frontier = [id];
    while (frontier.length) {
      const next = [];
      const rows = this.linksFrom(frontier, new Set([this.hierarchy ? this.hierarchy.id : -1]), true, stats);
      for (const r of rows) if (!seen.has(r.t)) { seen.add(r.t); next.push(r.t); }
      frontier = next;
    }
    if (this.config.hierarchyPairs || this.system === 'http://loinc.org') {
      const sets = this.loadSets(KIND.descendants, 0, [...seen], stats);
      for (const a of [...seen]) if (!sets.get(a).has(id)) seen.delete(a);
    }
    return [...seen];
  }

  /**
   * Map a set of another file's ids (same system, other release) to this file's ids by code:
   * the members' codes there, then one batched lookup here. Per request (nothing is kept): the
   * cost follows the size of the set, not of the files.
   */
  translateFrom(other, bm, stats) {
    // chunks of 20,000 ids, codes only: the transient working set stays a few MiB
    const out = new RoaringBitmap32();
    const codesOf = other.stmt('SELECT code FROM concept WHERE concept_id IN (SELECT value FROM json_each(?))').raw();
    const idsOf = this.stmt('SELECT concept_id FROM concept WHERE code IN (SELECT value FROM json_each(?))').raw();
    for (let i = 0; i < bm.size; i += 20000) {
      const chunk = bm.rangeUint32Array(i, 20000);
      const codes = codesOf.all(JSON.stringify(Array.from(chunk))).map((r) => r[0]);
      for (const r of idsOf.all(JSON.stringify(codes))) out.add(r[0]);
      if (stats) { count(stats, other, codesOf, chunk.length); count(stats, this, idsOf, codes.length); }
    }
    return out;
  }

  /** members of an ordered list (refset_def field `sequence`, e.g. LOINC answer lists) in order, or null */
  sequenceOf(refsetId) {
    const def = this.stmt('SELECT field_names FROM refset_def WHERE refset_id = ?').get(refsetId);
    if (!def || JSON.parse(def.field_names)[0] !== 'sequence') return null;
    return this.stmt("SELECT concept_id FROM refset_member WHERE refset_id = ? ORDER BY json_extract(fields, '$[0]'), concept_id").all(refsetId).map((r) => r.concept_id);
  }

  /** members of several ordered lists: Map list id -> member ids in sequence (one statement) */
  sequencesOf(refsetIds) {
    const out = new Map(refsetIds.map((id) => [id, []]));
    if (!refsetIds.length) return out;
    const rows = this.stmt("SELECT refset_id, concept_id FROM refset_member WHERE refset_id IN (SELECT value FROM json_each(?)) ORDER BY refset_id, json_extract(fields, '$[0]'), concept_id")
      .raw().all(JSON.stringify(refsetIds));
    for (const [l, m] of rows) out.get(l).push(m);
    return out;
  }

  /**
   * Each member's position in the given ordered lists: Map member -> sequence, for (list, member)
   * pairs (one statement)
   */
  sequenceIn(pairs) {
    const out = new Map();
    if (!pairs.length) return out;
    const rows = this.stmt("SELECT r.concept_id, json_extract(r.fields, '$[0]') FROM json_each(?) j JOIN refset_member r ON r.refset_id = json_extract(j.value, '$[0]') AND r.concept_id = json_extract(j.value, '$[1]')")
      .raw().all(JSON.stringify(pairs));
    for (const [m, s] of rows) if (!out.has(m) || s < out.get(m)) out.set(m, s);
    return out;
  }

  /**
   * RxNorm: the concepts cs-rxnorm.js's text search selects from, those with an RXNCONSO atom
   * (a SUPPRESS literal) of a term type other than SY
   */
  rxSearchable(stats) {
    if (!this._rxSearchable) {
      const sup = this.props.get('SUPPRESS'), tty = this.props.get('TTY');
      const bm = sup ? this.getSet(KIND.hasProp, sup.id, 0, stats).clone() : this.active(stats).clone();
      if (tty) {
        const types = new RoaringBitmap32();
        for (const r of this.propValues(tty.id, stats)) if (r.value !== 'SY') types.orInPlace(this.getSet(KIND.prop, tty.id, r.value, stats));
        bm.andInPlace(types);
      }
      this._rxSearchable = bm;
    }
    return this._rxSearchable;
  }

  /** refset member rows (fields) for a concept */
  refsetRows(refsetId, conceptId) {
    return this.stmt('SELECT fields FROM refset_member WHERE refset_id = +? AND concept_id = +?').all(refsetId, conceptId).map((r) => JSON.parse(r.fields));
  }

  /**
   * Text filter ($expand filter): the concepts a text filter matches, by the rules every built-in
   * provider follows since #398 (tx/library/text-match.js), with each one's names (text-index.js):
   *   mode 'designation' : SNOMED CT (sctTextSearch)
   *   mode 'rxnorm'      : RxNorm (rxTextSearch)
   *   mode 'display'     : LOINC (loincTextSearch)
   *   default            : cs-cs.js's rules (genericTextSearch)
   * `lang` (a primary language subtag) is the one language a text filter searches
   * (CodeSystemProvider.searchLanguage). A designation with no language is in `defLang`.
   */
  searchText(text, stats, mode, lang = null, defLang = 'en') {
    const g = this.searchTextG(text, stats, mode, lang, defLang);
    let r = g.next();
    while (!r.done) r = g.next();
    return r.value;
  }

  /**
   * searchText as an evaluation step (engine/evaluate.js): a generator with a bare yield at its
   * pause points, so a broad filter's ranking does not hold the event loop
   */
  * searchTextG(text, stats, mode, lang = null, defLang = 'en') {
    const t = String(text == null ? '' : text);
    if (!t.trim()) return null;
    const ti = require('./text-index');
    const def = primaryLang(this.config.defaultLanguage);
    if (mode === 'designation') return (yield* ti.sctTextSearchG(this, t, lang || def, this.ordinal || ((id) => id), stats)).bm;
    if (mode === 'rxnorm') return (yield* ti.rxTextSearchG(this, t, this.rxSearchable(stats), stats)).bm;
    if (mode === 'display') return (yield* ti.loincTextSearchG(this, t, lang || 'en', this.ordinal || ((id) => id), stats)).bm;
    return (yield* ti.genericTextSearchG(this, t, lang || primaryLang(defLang), defLang, stats)).bm;
  }
}

module.exports = { V2Store, KIND, EMPTY, setKey, registry, count, holdReadLock };
