'use strict';
// One terminology file (tx/importers/sqlite-v2/schema.sql, meta format tx-terminology/1), opened
// read-only: every SQL statement the providers, engine and terminology adapters run. The FHIR-facing
// code (provider.js, snomed.js, dialects.js, engine/) holds none.
//
// What a property is and how to read it comes from the catalog (`property`), never from probing:
//   - its access path: shape (link / literal / both / union / record / identifier), subject_kind,
//     inverse_of and property_member (inverse and union properties), closure_from (explicit
//     ancestor pairs), ordered (a list whose order is part of the answer), role ('language': the
//     relations that rank displays), by_target (which links ix_in holds), by_subject (which
//     identifier rows ix_by_subject holds);
//   - release facts from code_system and meta (default language, compositional, display contexts,
//     module dependencies, languages).
// How a server presents the system (where both servers that read these files would do the same)
// is in the file too: meta behaviour.* keys (BEHAVIOUR below; an unknown key or value is an error
// at open) and the catalog columns filter_ops and report.
//
// The stored sets (ix_set) are read in batches through loadSets, with the evaluation's working
// set and counters; text search is text-index.js over the file's word index.

const Database = require('better-sqlite3');
const { RoaringBitmap32 } = require('roaring');

const FORMAT = 'tx-terminology/1';
const USER_VERSION = 1;

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

/**
 * A source id or identifier value as the file stores it: a canonical decimal integer as an INTEGER
 * (bound as BigInt: better-sqlite3 binds a JS number as REAL), anything else as text
 */
function idValue(v) {
  const s = String(v);
  return /^(0|[1-9][0-9]{0,18})$/.test(s) && BigInt(s) <= 9223372036854775807n ? BigInt(s) : s;
}

/** the evaluation working-set key of a stored set; vk: the value kind where a property has two */
function setKey(kind, pid, value, vk = 0) {
  return kind + ':' + pid + ':' + (vk ? vk + ':' : '') + (typeof value === 'string' ? 's' + value : value);
}


/**
 * The behaviour settings a file may carry (meta 'behaviour.<key>', JSON values): key -> {values
 * (allowed values, or a check), default}. An importer writes those that differ from the default.
 *   grammar                  the code grammar the server applies: 'snomed' (SNOMED CT expressions
 *                            and ECL), 'icd11'; null: codes are plain codes
 *   lookupName               the name $lookup reports: the code system's 'name' or its 'title'
 *   description              the description a provider reports: 'name' or 'title'
 *   versionAlgorithm         CodeSystem.versionAlgorithm the provider reports ('natural', 'date', ...)
 *   expansionOrder           the order of an expansion: 'ids' (concept ids), 'stored' (ix_order
 *                            rank, walk for the whole system), 'stored-self-first' (as 'stored', and
 *                            an is-a / << filter lists its concept first)
 *   designationUses          'keep': a designation reports its use; 'drop': none does
 *   distinctDesignationTexts true: a concept's designations are its items' distinct texts (RxNorm:
 *                            cs-rxnorm.js lists each STR once; the file keeps every atom)
 *   lookupSkipsMixedLinks    true: the links of a property that also has literals (shape 'both')
 *                            are left out where no property is named ($lookup, main's ECL over the
 *                            store). SNOMED CT: cs-snomed.js keeps one value kind per attribute and
 *                            never reads them; a filter or ECL refinement naming the attribute does
 *   aliasProperty, aliasExtension  identifier aliases (resolves 1) echoed as a $validate-code output
 *                            parameter / checked in a Coding extension (ICD-11 files): the code or URL
 *                            that names them; read by no system this server serves from a file yet
 *   preferredForLanguage     true: a designation whose item has preferred = 1 and no use is reported
 *                            with the use preferredForLanguage in its own language (ICD-11, NDC files)
 *   aliasLiterals            property code -> value: the literal values a concept reports when read
 *                            through an identifier code (resolves 1 or 2) instead of its own values of
 *                            those properties; '{code}' is the concept's code (NDC files)
 *   filters                  null, or the only filters the system understands, as FHIR
 *                            CodeSystem.filter: [{code, operator: [...], values?: [...]}]; code is a
 *                            catalog property or 'inactive' (concept status) (NDC files)
 * The last three are read by no system this server serves from a file yet; they are checked so a file
 * means the same to every reader.
 */
const BEHAVIOUR = {
  grammar: { values: [null, 'snomed', 'icd11'], default: null },
  lookupName: { values: ['name', 'title'], default: 'name' },
  description: { values: ['name', 'title'], default: 'title' },
  versionAlgorithm: { check: (v) => v === null || typeof v === 'string', default: null },
  expansionOrder: { values: ['ids', 'stored', 'stored-self-first'], default: 'ids' },
  designationUses: { values: ['keep', 'drop'], default: 'keep' },
  distinctDesignationTexts: { values: [false, true], default: false },
  lookupSkipsMixedLinks: { values: [false, true], default: false },
  aliasProperty: { check: (v) => v === null || typeof v === 'string', default: null },
  aliasExtension: { check: (v) => v === null || typeof v === 'string', default: null },
  preferredForLanguage: { values: [false, true], default: false },
  aliasLiterals: { check: (v) => isPlainObject(v) && Object.values(v).every((x) => typeof x === 'string'), default: {} },
  filters: { check: (v) => v === null || (Array.isArray(v) && v.every(isFilterSpec)), default: null },
};
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
const isStrings = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');
/** one entry of behaviour.filters: {code, operator: [FHIR filter operators], values?: [strings]} */
function isFilterSpec(f) {
  if (!isPlainObject(f) || typeof f.code !== 'string' || !isStrings(f.operator) || !f.operator.length) return false;
  if (!f.operator.every((o) => FILTER_OPS.has(o))) return false;
  if (f.values !== undefined && !isStrings(f.values)) return false;
  return Object.keys(f).every((k) => k === 'code' || k === 'operator' || k === 'values');
}
const FILTER_OPS = new Set(['=', 'is-a', 'descendent-of', 'is-not-a', 'regex', 'in', 'not-in', 'generalizes', 'child-of', 'descendent-leaf', 'exists']);
const REPORT = new Set([null, 'named', 'always']);

/** meta behaviour.* -> settings object (every key, defaults filled); throws on an unknown key or value */
function readBehaviour(meta, file) {
  const out = {};
  for (const [k, d] of Object.entries(BEHAVIOUR)) out[k] = d.default;
  for (const [key, raw] of meta) {
    if (!key.startsWith('behaviour.')) continue;
    const k = key.substring('behaviour.'.length);
    const d = BEHAVIOUR[k];
    if (!d) throw new Error(`${file}: unknown behaviour setting ${key} (this server knows ${Object.keys(BEHAVIOUR).join(', ')})`);
    let v;
    try { v = JSON.parse(raw); } catch (e) { throw new Error(`${file}: ${key} is not JSON: ${raw}`); }
    if (d.values ? !d.values.includes(v) : !d.check(v)) throw new Error(`${file}: ${key} = ${raw} is not a value this server knows`);
    out[k] = v;
  }
  return Object.freeze(out);
}

const NODE_SHAPES = new Set(['link', 'union']);
const FILTER_SHAPES = new Set(['link', 'literal', 'both', 'union']);
const VK = { none: 0, node: 1, literal: 2 };
// items that are designations: terms, and definitions that carry a use (SNOMED CT text definitions;
// an ICD-11 definition has none) -- in the SQL below as (kind = 0 OR use_id IS NOT NULL)

const json = (a) => JSON.stringify(Array.from(a));

/**
 * The file's format, checked before anything else is read: a terminology file of this format, or
 * an error that says what the file is and what to do (an operator re-imports older files).
 */
function checkFormat(db, file) {
  const name = typeof file === 'string' ? file : 'the file';
  const uv = db.pragma('user_version', { simple: true });
  const has = (t) => !!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const f = uv === USER_VERSION && has('meta') ? db.prepare("SELECT value FROM main.meta WHERE key = 'format'").pluck().get() : null;
  if (f === FORMAT) return;
  if (uv === 5 || (has('cs_config') && has('concept_set'))) {
    throw new Error(`${name} was built by an earlier version of the sqlite-v2 importers (the v5 schema), which this server no longer reads: `
      + 're-import it from the release with tx-import (snomed-v2, snomed-v2-from-cache, loinc-v2, loinc-v2-classic or rxnorm-v2)');
  }
  const other = has('meta') ? db.prepare("SELECT value FROM main.meta WHERE key = 'format'").pluck().get() : null;
  if (typeof other === 'string' && other.startsWith('tx-terminology/')) {
    throw new Error(`${name} is a terminology file in format ${other}; this server reads ${FORMAT}: re-import it with tx-import`);
  }
  throw new Error(`${name} is not a sqlite-v2 terminology file (no meta format ${FORMAT})`);
}

class Store {
  /**
   * @param {string} file path, or ':memory:' style handle for a layer
   * @param {object} [opts] { db: an already open better-sqlite3 handle, stmts: a statement map
   *   shared by stores of one file, unregistered }
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
    this.uid = ++ownerSeq;
    try {
      checkFormat(this.db, file);
      this._loadMeta();
    } catch (e) {
      if (!opts.db) this.db.close();
      throw e;
    }
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

  // ---- sets -------------------------------------------------------------------------------

  /**
   * Load sets for many keys of one (kind, property): one statement whatever the number of keys
   * (the format's _readSets). Missing rows are empty sets. Returns Map(value -> bitmap). Nothing is
   * kept between requests: `local` is the caller's working set for one evaluation (each set read
   * once per evaluation).
   * @param {object} [stats] counters to add to (statements, rows, bytes, loaded, us)
   * @param {Map} [local] key -> bitmap already read in this evaluation
   * @param {number} [vk] the value kind (1 node, 2 literal) for a property that has both
   */
  loadSets(kind, pid, values, stats, local, vk = 0) {
    const out = new Map();
    const miss = [];
    for (const v of values) {
      const b = local && local.get(setKey(kind, pid, v, vk));
      if (b) out.set(v, b);
      else miss.push(v);
    }
    if (miss.length) {
      const t0 = stats ? process.hrtime.bigint() : 0n;
      const { q, rows } = this._readSets(kind, pid, miss, vk);
      let bytes = 0;
      const named = stats && stats.sets ? [] : null;
      for (const r of rows) {
        const b = r.bm || RoaringBitmap32.deserialize(r.data, 'portable');
        const len = r.data ? r.data.length : 0;
        bytes += len;
        out.set(r.value, b);
        if (local) local.set(setKey(kind, pid, r.value, vk), b);
        if (named) named.push({ value: r.value, card: b.size, bytes: len });
      }
      for (const v of miss) {
        if (!out.has(v)) {
          out.set(v, EMPTY);
          if (local) local.set(setKey(kind, pid, v, vk), EMPTY);
        }
      }
      if (stats) {
        if (q) count(stats, this, q, rows.length);
        if (named) stats.sets(this, kind, pid, named);
        stats.setsLoaded += rows.length;
        stats.setBytes += bytes;
        stats.setLoadUs += Number(process.hrtime.bigint() - t0) / 1000;
      }
    }
    return out;
  }

  getSet(kind, pid, value, stats, local, vk = 0) {
    return this.loadSets(kind, pid, [value], stats, local, vk).get(value);
  }

  all(stats, local) { return this.getSet(KIND.all, 0, 0, stats, local); }
  active(stats, local) { return this.getSet(KIND.active, 0, 0, stats, local); }
  leaf(stats, local) { return this.getSet(KIND.leaf, 0, 0, stats, local); }

  // ---- codes ------------------------------------------------------------------------------

  idOf(code, stats) {
    return this.resolveCodes([code], stats).get(code);
  }

  /** ancestors by walking the hierarchy's direct links upward (the format may know them directly) */
  _walkUp(id, stats) {
    const seen = new Set();
    let frontier = [id];
    const pids = new Set([this.hierarchy ? this.hierarchy.id : -1]);
    while (frontier.length) {
      const next = [];
      for (const r of this.linksFrom(frontier, pids, true, stats)) if (!seen.has(r.t)) { seen.add(r.t); next.push(r.t); }
      frontier = next;
    }
    return seen;
  }

  /**
   * Map a set of another file's ids (same system, other release) to this file's ids by code:
   * the members' codes there, then one batched lookup here. Per request (nothing is kept): the
   * cost follows the size of the set, not of the files. Chunks of 20,000 ids, codes only.
   */
  translateFrom(other, bm, stats) {
    const out = new RoaringBitmap32();
    for (let i = 0; i < bm.size; i += 20000) {
      const chunk = bm.rangeUint32Array(i, 20000);
      const codes = other.codesOf(Array.from(chunk), stats);
      for (const id of this.resolveCodes(codes, stats).values()) if (id != null) out.add(id);
    }
    return out;
  }

  // ---- text -------------------------------------------------------------------------------

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
    const def = primaryLang(this.defaultLanguage);
    if (mode === 'designation') return (yield* ti.sctTextSearchG(this, t, lang || def, this.ordinal || ((id) => id), stats)).bm;
    if (mode === 'rxnorm') return (yield* ti.rxTextSearchG(this, t, ti.rxSearchable(this, stats), stats)).bm;
    if (mode === 'display') return (yield* ti.loincTextSearchG(this, t, lang || 'en', this.ordinal || ((id) => id), stats)).bm;
    return (yield* ti.genericTextSearchG(this, t, lang || primaryLang(defLang), defLang, stats)).bm;
  }


  // ---- metadata and catalog -----------------------------------------------------------------

  _loadMeta() {
    const db = this.db;
    const cs = db.prepare('SELECT * FROM main.code_system WHERE served = 1').get();
    if (!cs) throw new Error(`${this.file}: no served code_system row (not a terminology file?)`);
    this.meta = new Map(db.prepare("SELECT key, value FROM main.meta WHERE key NOT LIKE 'provenance.%'").raw().all());
    this.format = this.meta.get('format');
    this.csId = cs.cs_id;
    this.cs = { id: cs.cs_id, uri: cs.uri, version: cs.version, name: cs.name, title: cs.title, description: cs.description,
      release_date: cs.release_date, content: cs.content, edition: this.meta.get('edition') ?? null,
      concept_count: cs.concept_count, active_count: cs.active_count, case_sensitive: cs.case_sensitive, hierarchy_meaning: cs.hierarchy_meaning };
    this.system = cs.uri;
    this.version = cs.version;
    this.conceptCount = cs.concept_count;
    this.activeCount = cs.active_count;
    this.lo = 1;
    this.hi = cs.concept_count;
    this.behaviour = readBehaviour(this.meta, this.file);
    // a compositional system's expansions are never closed (post-coordinated expressions are codes)
    this.notClosed = cs.compositional === 1;
    this.defaultLanguage = cs.default_language || null;
    this.caseSensitive = cs.case_sensitive !== 0;
    const metaJson = (k, d) => (this.meta.has(k) ? JSON.parse(this.meta.get(k)) : d);
    const dc = metaJson('displayContexts', null);
    this.displayRefsets = dc && dc.relations ? dc.relations.map(String) : null;
    this.moduleDependencies = metaJson('moduleDependencies', []);
    this._loadCatalog();
    this.uses = new Map();
    for (const u of db.prepare('SELECT use_id, system, code, display FROM main.item_use').all()) this.uses.set(u.use_id, { system: u.system, code: u.code, display: u.display });
    this.hasFts = true;
    this.hasAcceptability = this.langRelations.size > 0;
    this.hasRank = true;
    // a concept shows a definition (the kind 1 item with preferred = 1): one probe of a partial index
    this.hasDefinitions = !!db.prepare('SELECT 1 FROM main.item WHERE kind = 1 AND preferred = 1 LIMIT 1').get();
    // identifiers accepted as codes (ICD-11 short codes, NDC 11-digit forms): one probe at open
    this.hasCodeIdentifiers = !!db.prepare('SELECT 1 FROM main.identifier WHERE resolves > 0 LIMIT 1').get();
    // children in source order: the hierarchy's links by target (ix_in, in seq order)
    this.hasLinkOrder = !!(this.hierarchy && this.hierarchy.byTarget);
  }

  _loadCatalog() {
    const rows = this.db.prepare('SELECT * FROM main.property WHERE cs_id = ? ORDER BY id').all(this.csId);
    this.catalog = new Map();   // code -> def (every catalog row)
    this.propsById = new Map(); // id -> def
    for (const r of rows) {
      const def = {
        id: r.id, code: r.code, uri: r.uri, display: r.display, type: r.fhir_type || 'code', shape: r.shape,
        // the value kind: node-valued (link, union) or literal; a 'both' property is read as literal
        // unless a filter value names a node (compile.js)
        kind: NODE_SHAPES.has(r.shape) ? 'concept' : r.shape === 'record' || r.shape === 'identifier' ? r.shape : 'literal',
        subjectKind: r.subject_kind, targetKind: r.target_kind, n: r.n_rows, conceptId: r.concept_id,
        isHierarchy: !!r.subsumption, closureFrom: r.closure_from, filterable: !!r.filterable, refinable: !!r.refinable,
        wildcard: !!r.wildcard, byTarget: !!r.by_target, bySubject: !!r.by_subject, ordered: !!r.ordered, role: r.role,
        attribute: !!r.refinable, // (the SNOMED CT adapters' "attribute": a row ECL refines by)
        fields: r.fields ? JSON.parse(r.fields) : null, inverseOfId: r.inverse_of, members: null, reverses: null,
        // the operators a filter on it accepts (null: the dialect's), and when $lookup reports it
        filterOps: r.filter_ops ? JSON.parse(r.filter_ops) : null, report: r.report ?? null,
      };
      if (def.filterOps && !(Array.isArray(def.filterOps) && def.filterOps.every((o) => FILTER_OPS.has(o)))) {
        throw new Error(`${this.file}: property ${def.code} has filter_ops ${r.filter_ops}, not a list of FHIR filter operators`);
      }
      if (!REPORT.has(def.report)) throw new Error(`${this.file}: property ${def.code} has report ${def.report} (named, always or NULL)`);
      this.catalog.set(def.code, def);
      this.propsById.set(def.id, def);
    }
    for (const [a, c] of this.db.prepare('SELECT parent_id, child_id FROM main.property_member ORDER BY parent_id, child_id').raw().all()) {
      const p = this.propsById.get(a), m = this.propsById.get(c);
      if (p && m) (p.members || (p.members = [])).push(m);
    }
    const stored = (d) => (d.members ? d.members.flatMap(stored) : [d]);
    for (const d of this.catalog.values()) {
      if (d.inverseOfId != null) d.reverses = stored(this.propsById.get(d.inverseOfId));
    }
    const closureSources = new Set([...this.catalog.values()].map((d) => d.closureFrom).filter((x) => x != null));
    // the properties a filter or a lookup reads by name: link, literal, both and filterable
    // unions; not the inverse rows, nor a closure source (its pairs are the descendants sets)
    this.props = new Map();
    for (const d of this.catalog.values()) {
      if (!FILTER_SHAPES.has(d.shape) || d.reverses || closureSources.has(d.id)) continue;
      if (d.shape === 'union' && !d.filterable) continue;
      this.props.set(d.code, d);
    }
    this.hierarchy = [...this.catalog.values()].find((d) => d.isHierarchy) || null;
    this.closure = this.hierarchy && this.hierarchy.closureFrom != null ? this.hierarchy.closureFrom : null;
    // link properties linksFrom reads when none is named: not a closure source (its pairs are the
    // descendants sets), and not a 'both' one where the file says so (behaviour.lookupSkipsMixedLinks)
    const skipBoth = this.behaviour.lookupSkipsMixedLinks;
    this.hiddenLinks = [...this.catalog.values()].filter((d) => (skipBoth && d.shape === 'both') || closureSources.has(d.id)).map((d) => d.id);
    // the reference sets: record relations by their concept; the language ones rank displays
    this.relations = new Map();
    this.langRelations = new Map(); // relation id -> refset concept id
    for (const d of this.catalog.values()) {
      if (d.shape !== 'record') continue;
      if (d.conceptId != null) this.relations.set(d.conceptId, d);
      if (d.role === 'language') this.langRelations.set(d.id, d.conceptId);
    }
    this.langRelIds = json(this.langRelations.keys());
    // identifier schemes by their concept
    this.schemes = new Map();
    for (const d of this.catalog.values()) if (d.shape === 'identifier' && d.conceptId != null) this.schemes.set(d.conceptId, d);
    // RxNorm atom-level relationships (an optional build): identifier rows under AUI:<REL or RELA>
    this.hasAtomRelationships = [...this.catalog.values()].some((d) => d.shape === 'identifier' && d.code.startsWith('AUI:'));
    // an ordered list property (LOINC Answer): a list's members are its targets in seq order
    this.listProp = [...this.catalog.values()].find((d) => d.ordered && d.shape === 'link') || null;
  }

  /** the inverse rows: [{code, reverses (the stored properties reversed)}] */
  inverses() { return [...this.catalog.values()].filter((d) => d.reverses); }

  /** the catalog row a FHIR filter may name (filterable, statement-valued), or undefined */
  filterProp(code) {
    const d = this.catalog.get(code);
    return d && d.filterable && FILTER_SHAPES.has(d.shape) ? d : undefined;
  }

  /** value -> display of a literal property's values (value_label) */
  valueLabels(p) {
    if (!this._labels) {
      this._labels = new Map();
      for (const [pid, v, d] of this.db.prepare('SELECT property_id, value, display FROM main.value_label').raw().all()) {
        if (!this._labels.has(pid)) this._labels.set(pid, {});
        this._labels.get(pid)[v] = d;
      }
    }
    return this._labels.get(p.id) || null;
  }

  /** the languages of the served system's items (meta, a release fact) */
  languages() { return JSON.parse(this.meta.get('languages') || '[]'); }

  /** the built-in answer order (ix_order rank / ids / walk), read array by array */
  systemOrder(kind) { return require('./orders').storedOrder(this, kind); }

  hierarchyOrderOf(id) {
    if (this._hierOrder === undefined) this._hierOrder = require('./orders').hierarchyOrder(this);
    return this._hierOrder ? this._hierOrder.of(id) : null;
  }

  /** the source order of a concept's active links ("property:group:target" -> seq) */
  linkSeqFrom(id) {
    if (!this.hasLinkOrder) return null;
    const m = new Map();
    for (const [p, g, t, seq] of this.stmt('SELECT property_id, group_id, target_id, seq FROM main.link WHERE subject_id = +? AND active = 1 AND seq IS NOT NULL').raw().all(id)) m.set(p + ':' + g + ':' + t, seq);
    return m;
  }

  /** the concepts with an active group-0 link of a by-target property to the concept, in source order */
  linkSourcesInOrder(propertyId, id) {
    const d = this.propsById.get(propertyId);
    if (!d || !d.byTarget) return null;
    return this.stmt('SELECT subject_id FROM main.ix_in WHERE target_id = +? AND property_id = +? AND active = 1 AND group_id = 0 ORDER BY seq').pluck().all(id, propertyId);
  }

  // ---- sets -------------------------------------------------------------------------------

  /** ix_set value_kind of a (kind, property) key: 1 node, 2 literal, 0 none */
  _vk(kind, pid, vk) {
    if (vk) return vk;
    if (kind === KIND.descendants) return VK.node;
    if (kind !== KIND.prop) return VK.none;
    const p = this.propsById.get(pid);
    return p && p.kind === 'concept' ? VK.node : VK.literal;
  }

  _readSets(kind, pid, vals, vkIn) {
    const p = pid ? this.propsById.get(pid) : null;
    if (p && p.members && (kind === KIND.prop || kind === KIND.hasProp)) {
      // a union's sets are its members' (never stored): OR them
      const by = new Map();
      for (const m of p.members) {
        for (const [v, b] of this.loadSets(kind, m.id, vals, null, null, vkIn)) if (b.size) { if (!by.has(v)) by.set(v, []); by.get(v).push(b); }
      }
      return { q: null, rows: [...by].map(([value, bs]) => ({ value, bm: RoaringBitmap32.orMany(bs) })) };
    }
    if (kind === KIND.refset) return this._members(vals);
    const vk = this._vk(kind, pid, vkIn);
    let q, rows;
    if (vals.length === 1) {
      // +?: no re-prepare per value where a file has sqlite_stat4 (built before stat1-only), 16 -> 7 us per set
      q = this.stmt('SELECT value, data FROM main.ix_set WHERE kind = +? AND property_id = +? AND value = +? AND value_kind = +?');
      const r = q.get(kind, pid, vals[0], vk);
      rows = r ? [r] : [];
    } else {
      q = this.stmt('SELECT value, data FROM main.ix_set WHERE kind = +? AND property_id = +? AND value IN (SELECT value FROM json_each(?)) AND value_kind = +?');
      rows = q.all(kind, pid, JSON.stringify(vals), vk);
    }
    return { q, rows };
  }

  /**
   * The members of each concept as a "reference set": a record relation's concept: its member
   * set (ix_set kind 7); else, in a file with an ordered list property, the list's targets
   */
  _members(vals) {
    const rel = new Map();
    const lists = [];
    for (const v of vals) { const d = this.relations.get(v); if (d) rel.set(d.id, v); else if (this.listProp) lists.push(v); }
    const rows = [];
    let q = null;
    if (rel.size) {
      q = this.stmt('SELECT property_id, data FROM main.ix_set WHERE kind = 7 AND property_id IN (SELECT value FROM json_each(?)) AND value = 0 AND value_kind = 0');
      for (const r of q.raw().all(json(rel.keys()))) rows.push({ value: rel.get(r[0]), data: r[1] });
    }
    if (lists.length) {
      q = this.stmt('SELECT subject_id, target_id FROM main.link WHERE subject_id IN (SELECT value FROM json_each(?)) AND property_id = +? AND active = 1');
      const by = new Map();
      for (const [l, m] of q.raw().all(json(lists), this.listProp.id)) { if (!by.has(l)) by.set(l, []); by.get(l).push(m); }
      for (const [value, m] of by) rows.push({ value, bm: new RoaringBitmap32(m) });
    }
    return { q, rows };
  }

  /** keys (values) of the stored prop sets of one property, with their cardinalities */
  propValues(pid, stats, vk = 0) {
    const p = this.propsById.get(pid);
    if (p && p.members) {
      const by = new Map();
      for (const m of p.members) for (const r of this.propValues(m.id, stats, vk)) by.set(r.value, (by.get(r.value) || 0) + r.card);
      return [...by].map(([value, card]) => ({ value, card }));
    }
    const q = this.stmt('SELECT value, card FROM main.ix_set WHERE kind = 5 AND property_id = +? AND value_kind = +?');
    const r = q.all(pid, this._vk(KIND.prop, pid, vk));
    if (stats) count(stats, this, q, r.length);
    return r;
  }

  /** the reference sets with concept members, by concept id */
  refsetIds() {
    const ids = this.stmt('SELECT property_id FROM main.ix_set WHERE kind = 7').pluck().all()
      .map((pid) => this.propsById.get(pid)).filter((d) => d && d.conceptId != null).map((d) => d.conceptId);
    return ids.sort((a, b) => a - b);
  }

  // ---- codes ------------------------------------------------------------------------------

  resolveCodes(codes, stats) {
    const out = new Map();
    const want = [...new Set(codes.filter((c) => c != null).map(String))];
    if (!want.length) return out;
    const q = want.length === 1
      ? this.stmt('SELECT id, code FROM main.concept WHERE cs_id = +? AND code = ?')
      : this.stmt('SELECT id, code FROM main.concept WHERE cs_id = +? AND code IN (SELECT value FROM json_each(?))');
    const rows = q.raw().all(this.csId, want.length === 1 ? want[0] : JSON.stringify(want));
    for (const [id, code] of rows) out.set(code, id);
    for (const c of want) if (!out.has(c)) out.set(c, null);
    if (stats) count(stats, this, q, rows.length);
    return out;
  }

  codesOf(ids, stats) {
    const q = this.stmt('SELECT code FROM main.concept WHERE id IN (SELECT value FROM json_each(?))').pluck();
    const r = q.all(json(ids));
    if (stats) count(stats, this, q, r.length);
    return r;
  }

  /** the row columns (concept_id, code, active, display, definition) of a concept statement */
  get _rowCols() {
    return this.hasDefinitions
      ? 'c.id AS concept_id, c.code, c.active, c.display, (SELECT d.text FROM main.item d WHERE d.concept_id = c.id AND d.kind = 1 AND d.preferred = 1 LIMIT 1) AS definition'
      : 'c.id AS concept_id, c.code, c.active, c.display, NULL AS definition';
  }

  rowsForCodes(codes, stats) {
    const out = new Map();
    const want = [...new Set(codes.filter((c) => c != null).map(String))];
    if (!want.length) return out;
    const q = this.stmt(`SELECT ${this._rowCols} FROM json_each(?) j JOIN main.concept c ON c.cs_id = ${this.csId} AND c.code = j.value`);
    const rows = q.all(JSON.stringify(want));
    for (const r of rows) out.set(r.code, r);
    if (stats) count(stats, this, q, rows.length);
    return out;
  }

  rowForCode(code, stats) {
    const q = this.stmt(`SELECT ${this._rowCols} FROM main.concept c WHERE c.cs_id = ${this.csId} AND c.code = ?`);
    const r = q.get(String(code)) || null;
    if (stats) count(stats, this, q, r ? 1 : 0);
    return r;
  }

  /**
   * The concept an identifier accepted as a code names (identifier resolves 1 or 2), with its row
   * and resolves, or null; the lowest resolves first, then the lowest property and subject id
   */
  identifierAsCode(value, stats) {
    const q = this.stmt(`SELECT ${this._rowCols}, i.resolves FROM main.identifier i JOIN main.concept c ON c.id = i.subject_id AND c.cs_id = ${this.csId}
      WHERE i.value = ? AND i.resolves > 0 ORDER BY i.resolves, i.property_id, i.subject_id LIMIT 1`);
    const r = q.get(idValue(value)) || null;
    if (stats) count(stats, this, q, r ? 1 : 0);
    return r;
  }

  idOfNoCase(code) {
    const r = this.stmt('SELECT id FROM main.concept WHERE cs_id = +? AND code = ? COLLATE NOCASE LIMIT 1').pluck().get(this.csId, code);
    return r ?? null;
  }

  codesInRange(low, high) {
    return this.stmt('SELECT id, code FROM main.concept WHERE cs_id = +? AND code >= ? AND code < ?').raw().all(this.csId, low, high);
  }

  codesUpToLength(n) {
    return this.stmt('SELECT id, code FROM main.concept WHERE cs_id = +? AND length(code) <= ?').raw().all(this.csId, n);
  }

  displayIdsNoCase(v) {
    let ids = null;
    if (String(v).length >= 3) {
      try {
        ids = this.stmt('SELECT id FROM main.concept WHERE id IN (SELECT rowid FROM main.ix_text_display WHERE ix_text_display MATCH ?) AND display = ? COLLATE NOCASE')
          .pluck().all('"' + String(v).replace(/"/g, '""') + '"', v);
      } catch (e) { ids = null; }
    }
    if (!ids) ids = this.stmt('SELECT id FROM main.concept WHERE display = ? COLLATE NOCASE AND id <= ?').pluck().all(v, this.hi);
    return ids;
  }

  /**
   * Items by their source id (a SNOMED CT description id, an RXAUI), as {item, concept}; the
   * source id is compared as text (an integer one is stored as INTEGER: bound as BigInt)
   */
  itemsByExternalId(value) {
    return this.stmt('SELECT id AS item, concept_id AS concept FROM main.item WHERE external_id = ?').all(idValue(value));
  }

  // ---- rows -------------------------------------------------------------------------------

  ftsDisplayIds(query, stats) {
    const q = this.stmt('SELECT rowid FROM main.ix_text_display WHERE ix_text_display MATCH ?');
    const ids = q.pluck().all(query);
    if (stats) count(stats, this, q, ids.length);
    return new RoaringBitmap32(ids);
  }

  ftsDesignationConcepts(query, stats) {
    const q = this.stmt('SELECT DISTINCT i.concept_id FROM main.ix_text_item s JOIN main.item i ON i.id = s.rowid WHERE ix_text_item MATCH ? AND i.cs_id = +?').pluck();
    const r = q.all(query, this.csId);
    if (stats) count(stats, this, q, r.length);
    return r;
  }

  ftsDesignationRows(query, stats) {
    const q = this.stmt('SELECT i.concept_id, i.text, i.language, i.use_id, i.active FROM main.ix_text_item s JOIN main.item i ON i.id = s.rowid WHERE ix_text_item MATCH ? AND i.cs_id = +?').raw();
    const r = q.all(query, this.csId);
    if (stats) count(stats, this, q, r.length);
    return r;
  }

  conceptColumn(col, a, b) {
    return this.stmt(`SELECT id, ${col === 'code' ? 'code' : 'display'} AS v FROM main.concept WHERE id BETWEEN ? AND ?`).raw().all(a, b);
  }

  designationRange(a, b, lang = null) {
    if (lang == null) return this.stmt('SELECT concept_id, text, language, use_id, active FROM main.item WHERE active = 1 AND cs_id = +? AND (kind = 0 OR use_id IS NOT NULL) AND concept_id BETWEEN ? AND ?').raw().all(this.csId, a, b);
    return this.stmt("SELECT concept_id, text, language, use_id, active FROM main.item WHERE active = 1 AND cs_id = +? AND (kind = 0 OR use_id IS NOT NULL) AND concept_id BETWEEN ? AND ? AND (lower(language) = ? OR lower(language) LIKE ? || '-%')").raw().all(this.csId, a, b, lang, lang);
  }

  designationsRaw(ids, stats) {
    const q = this.stmt('SELECT concept_id, text, language, use_id, active FROM main.item WHERE concept_id IN (SELECT value FROM json_each(?)) AND cs_id = +? AND (kind = 0 OR use_id IS NOT NULL)').raw();
    const r = q.all(json(ids), this.csId);
    if (stats) count(stats, this, q, r.length);
    return r;
  }

  conceptRows(ids, stats) {
    const out = new Map();
    if (!ids.length) return out;
    const q = ids.length === 1
      ? this.stmt(`SELECT ${this._rowCols} FROM main.concept c WHERE c.id = ?`)
      : this.stmt(`SELECT ${this._rowCols} FROM main.concept c WHERE c.id IN (SELECT value FROM json_each(?))`);
    const rows = ids.length === 1 ? [q.get(ids[0])].filter(Boolean) : q.all(json(ids));
    for (const r of rows) out.set(r.concept_id, r);
    if (stats) count(stats, this, q, rows.length);
    return out;
  }

  /**
   * A concept's designations (the served system's items), in item order: Map(concept id ->
   * [{id, language, use, term, active, preferred, rank, acc}]). opts: skipUse,
   * onlyUse, withAcc: acc = "refset:acceptability,..." from the language relations), and
   * withExternalId: sctid, the item's source id (a description SCTID) as text.
   */
  designationRows(ids, stats, opts = {}) {
    const out = new Map();
    if (!ids.length) return out;
    const useCond = opts.onlyUse != null ? `AND use_id = ${Number(opts.onlyUse)}` : opts.skipUse != null ? `AND use_id IS NOT ${Number(opts.skipUse)}` : '';
    const one = ids.length === 1;
    const q = this.stmt(`SELECT id, concept_id, language, use_id, text, active, preferred, rank${opts.withExternalId ? ', CAST(external_id AS TEXT)' : ''} FROM main.item
      WHERE concept_id ${one ? '= +?' : 'IN (SELECT value FROM json_each(?))'} AND cs_id = ${this.csId} AND (kind = 0 OR use_id IS NOT NULL) ${useCond} ORDER BY id`).raw(true);
    const rows = q.all(one ? ids[0] : json(ids));
    const distinct = this.behaviour.distinctDesignationTexts;
    let l = null, lid = null, seen = null;
    for (const r of rows) {
      if (r[1] !== lid) {
        lid = r[1];
        l = out.get(lid);
        if (!l) out.set(lid, l = []);
        if (distinct) seen = new Set(l.map((d) => d.term));
      }
      if (distinct) { if (seen.has(r[4])) continue; seen.add(r[4]); }
      l.push({ id: r[0], language: r[2], use: r[3] != null ? this.uses.get(r[3]) : null, term: r[4], active: !!r[5], preferred: !!r[6], acc: null, rank: r[7],
        ...(opts.withExternalId ? { sctid: r[8] } : {}) });
    }
    if (stats) count(stats, this, q, rows.length);
    if (opts.withAcc && this.hasAcceptability) {
      const items = [];
      for (const list of out.values()) for (const d of list) items.push(d.id);
      const acc = this._acceptability(items, stats);
      for (const list of out.values()) for (const d of list) { const a = acc.get(d.id); d.acc = a ? a.map(([r, v]) => r + ':' + v).join(',') : null; }
    }
    return out;
  }

  /** item id -> [[refset concept id, acceptability id], ...] from the language relations (active rows) */
  _acceptability(items, stats) {
    const out = new Map();
    if (!items.length) return out;
    const q = this.stmt(`SELECT subject_id, relation_id, target_id FROM main.record WHERE relation_id IN (SELECT value FROM json_each(?))
      AND subject_id IN (SELECT value FROM json_each(?)) AND active = 1 AND target_id IS NOT NULL ORDER BY relation_id, subject_id, seq`).raw();
    const rows = q.all(this.langRelIds, json(items));
    for (const [s, r, t] of rows) { if (!out.has(s)) out.set(s, []); out.get(s).push([this.langRelations.get(r), t]); }
    if (stats) count(stats, this, q, rows.length);
    return out;
  }

  acceptabilityOfConcept(id) {
    if (!this.hasAcceptability) return new Map();
    return this._acceptability(this.stmt('SELECT id FROM main.item WHERE concept_id = +?').pluck().all(id));
  }

  designationById(did) {
    const r = this.stmt('SELECT id, concept_id, language, use_id, text, active, CAST(external_id AS TEXT) AS x FROM main.item WHERE id = ?').get(did);
    if (!r) return null;
    return { id: r.id, conceptId: r.concept_id, language: r.language, useId: r.use_id, term: r.text, active: !!r.active, sctid: r.x, accs: this._acceptability([did]).get(did) || [] };
  }

  designationIdsOf(id) {
    return this.stmt('SELECT id FROM main.item WHERE concept_id = +? AND cs_id = +? AND (kind = 0 OR use_id IS NOT NULL) ORDER BY id').pluck().all(id, this.csId);
  }

  isLanguageRefset(rid) {
    const d = this.relations.get(rid);
    return !!d && d.role === 'language';
  }

  literalValues(ids, pid, stats) {
    const out = new Map();
    if (!ids.length) return out;
    const q = ids.length === 1
      ? this.stmt('SELECT subject_id, value FROM main.literal WHERE subject_id = +? AND property_id = +? AND active = 1')
      : this.stmt('SELECT subject_id, value FROM main.literal WHERE subject_id IN (SELECT value FROM json_each(?)) AND property_id = +? AND active = 1');
    const rows = q.raw().all(ids.length === 1 ? ids[0] : json(ids), pid);
    for (const [s, v] of rows) if (!out.has(s)) out.set(s, v);
    if (stats) count(stats, this, q, rows.length);
    return out;
  }

  literalRows(pids) {
    return this.stmt(`SELECT subject_id AS concept_id, property_id, group_id, value FROM main.literal WHERE active = 1
      AND property_id IN (SELECT value FROM json_each(?)) AND subject_id <= ?`).all(json(pids), this.hi);
  }

  /**
   * Node-valued facts about concepts (one statement): rows {s, p, g, t, active}; pids (a Set) the
   * properties to read, else every link property but the closure sources and the 'both' ones (a
   * 'both' property's links are read when it is named: an ECL attribute with a concept value)
   */
  linksFrom(ids, pids = null, activeOnly = true, stats) {
    if (!ids.length) return [];
    const act = activeOnly ? 'AND active = 1' : '';
    let q, rows;
    if (pids) {
      const want = [...pids].filter((p) => p != null && p !== this.closure);
      if (!want.length) return [];
      q = this.stmt(`SELECT subject_id AS s, property_id AS p, group_id AS g, target_id AS t, active FROM main.link
        WHERE subject_id IN (SELECT value FROM json_each(?)) AND property_id IN (SELECT value FROM json_each(?)) ${act} AND target_id <= ?`);
      rows = q.all(json(ids), JSON.stringify(want), this.hi);
    } else {
      q = this.stmt(`SELECT subject_id AS s, property_id AS p, group_id AS g, target_id AS t, active FROM main.link
        WHERE subject_id IN (SELECT value FROM json_each(?)) AND property_id NOT IN (SELECT value FROM json_each(?)) ${act} AND target_id <= ?`);
      rows = q.all(json(ids), JSON.stringify(this.hiddenLinks), this.hi);
    }
    if (stats) count(stats, this, q, rows.length);
    return rows;
  }

  /** links to a concept of the by-target properties (ix_in): rows {s, p, g, active} */
  linksTo(id, activeOnly = true) {
    return this.stmt(`SELECT subject_id AS s, property_id AS p, group_id AS g, active FROM main.ix_in WHERE target_id = +? ${activeOnly ? 'AND active = 1' : ''}`).all(id);
  }

  literalsOf(ids, activeOnly = true, stats) {
    if (!ids.length) return [];
    const q = this.stmt(`SELECT subject_id AS c, property_id AS p, group_id AS g, value AS v, active FROM main.literal
       WHERE subject_id IN (SELECT value FROM json_each(?)) ${activeOnly ? 'AND active = 1' : ''}`);
    const rows = q.all(json(ids));
    if (stats) count(stats, this, q, rows.length);
    return rows;
  }

  parentsOf(id, stats) {
    if (!this.hierarchy) return [];
    const q = this.stmt('SELECT target_id FROM main.link WHERE subject_id = +? AND property_id = +? AND active = 1');
    const r = q.pluck().all(id, this.hierarchy.id);
    if (stats) count(stats, this, q, r.length);
    return r;
  }

  /** all ancestors: the explicit pairs (catalog closure_from), else a walk up the hierarchy */
  ancestorsOf(id, stats) {
    if (this.closure == null) return [...this._walkUp(id, stats)];
    const q = this.stmt('SELECT target_id FROM main.link WHERE subject_id = +? AND property_id = +? AND active = 1');
    const r = q.pluck().all(id, this.closure);
    if (stats) count(stats, this, q, r.length);
    return r;
  }

  // ---- ordered lists (catalog `ordered`: LOINC answer lists) -----------------------------------

  sequenceOf(listId) {
    if (!this.listProp) return null;
    const r = this.stmt('SELECT target_id FROM main.link WHERE subject_id = +? AND property_id = +? AND active = 1 ORDER BY seq, target_id').pluck().all(listId, this.listProp.id);
    return r.length ? r : null;
  }

  sequencesOf(listIds) {
    const out = new Map(listIds.map((id) => [id, []]));
    if (!listIds.length || !this.listProp) return out;
    for (const [l, m] of this.stmt('SELECT subject_id, target_id FROM main.link WHERE subject_id IN (SELECT value FROM json_each(?)) AND property_id = +? AND active = 1 ORDER BY subject_id, seq, target_id')
      .raw().all(json(listIds), this.listProp.id)) out.get(l).push(m);
    return out;
  }

  sequenceIn(pairs) {
    const out = new Map();
    if (!pairs.length || !this.listProp) return out;
    const rows = this.stmt("SELECT l.target_id, l.seq FROM json_each(?) j JOIN main.link l ON l.subject_id = json_extract(j.value, '$[0]') AND l.property_id = ? AND l.group_id = 0 AND l.target_id = json_extract(j.value, '$[1]') AND l.active = 1")
      .raw().all(JSON.stringify(pairs), this.listProp.id);
    for (const [m, s] of rows) if (!out.has(m) || s < out.get(m)) out.set(m, s);
    return out;
  }

  // ---- reference sets (record relations) ------------------------------------------------------

  refsetRows(refsetId, conceptId) {
    return this.refsetMemberRows(refsetId, conceptId).map((r) => JSON.parse(r.fields));
  }

  /**
   * The member rows of a reference set (of one concept, when subjectId is given), active rows:
   * {concept_id (the subject; for a row about an item, the item's concept), fields (JSON array of
   * the refset's own columns: node ids as codes, values as text), effective_time, module_id},
   * decoded by the relation's columns (property.fields; the target column from record.target_id).
   * opts.raw: no codes looked up; `f` is the own columns as an array, a node column's value its
   * node id (a number) where it is a node of this file (ECL member filters compare ids).
   * opts.targetIn: only the rows whose target column is one of these node ids (in SQL)
   */
  refsetMemberRows(refsetId, subjectId = null, opts = {}) {
    const rel = this.relations.get(refsetId);
    if (!rel) return [];
    // rows about items (a refset of descriptions) are projected to the items' concepts, in item order
    const onItems = rel.role !== 'language' && (rel.subjectKind === 'item' || rel.subjectKind === 'both');
    let rows;
    if (subjectId != null) {
      rows = this.stmt('SELECT subject_id, target_id, fields FROM main.record WHERE relation_id = ? AND subject_id = ? AND active = 1 ORDER BY seq').raw().all(rel.id, subjectId);
      if (onItems) {
        rows = rows.concat(this.stmt(`SELECT i.concept_id, r.target_id, r.fields FROM main.item i JOIN main.record r ON r.relation_id = ? AND r.subject_id = i.id
          WHERE i.concept_id = ? AND r.active = 1 ORDER BY i.id, r.seq`).raw().all(rel.id, subjectId));
      }
    } else if (opts.targetIn) {
      const t = JSON.stringify(opts.targetIn);
      rows = this.stmt(`SELECT subject_id, target_id, fields FROM main.record WHERE relation_id = ? AND active = 1 AND subject_id <= ?
        AND target_id IN (SELECT value FROM json_each(?)) ORDER BY subject_id, seq`).raw().all(rel.id, this.hi, t);
      if (onItems) {
        rows = rows.concat(this.stmt(`SELECT i.concept_id, r.target_id, r.fields FROM main.record r JOIN main.item i ON i.id = r.subject_id
          WHERE r.relation_id = ? AND r.active = 1 AND r.subject_id > ? AND r.target_id IN (SELECT value FROM json_each(?))
          ORDER BY i.concept_id, r.subject_id, r.seq`).raw().all(rel.id, this.hi, t));
      }
    } else {
      rows = this.stmt('SELECT subject_id, target_id, fields FROM main.record WHERE relation_id = ? AND active = 1 AND subject_id <= ? ORDER BY subject_id, seq').raw().all(rel.id, this.hi);
      if (onItems) {
        rows = rows.concat(this.stmt(`SELECT i.concept_id, r.target_id, r.fields FROM main.record r JOIN main.item i ON i.id = r.subject_id
          WHERE r.relation_id = ? AND r.active = 1 AND r.subject_id > ? ORDER BY i.concept_id, r.subject_id, r.seq`).raw().all(rel.id, this.hi));
      }
    }
    const cols = rel.fields || [];
    const hasTarget = cols.some((c) => c.target);
    const decoded = rows.map(([subject, target, fields]) => {
      const rest = fields ? JSON.parse(fields) : [];
      const tail = target == null && hasTarget ? rest.pop() : undefined;
      let k = 0;
      const vals = cols.map((c) => ({ c, v: c.target ? (target != null ? target : tail) : rest[k++], node: c.target ? target != null : (c.type === 'c' || c.type === 'n') }));
      return { subject, vals };
    });
    if (opts.raw) {
      return decoded.map(({ subject, vals }) => {
        const out = { concept_id: subject, f: [], effective_time: null, module_id: null };
        for (const { c, v, node } of vals) {
          if (c.name === 'effectiveTime' && c.type === 't') out.effective_time = v ?? null;
          else if (c.name === 'moduleId' && !c.target) out.module_id = typeof v === 'number' ? v : null;
          else out.f.push(v == null ? '' : node && typeof v === 'number' ? v : String(v));
        }
        return out;
      });
    }
    const ids = new Set();
    for (const r of decoded) for (const x of r.vals) if (x.node && typeof x.v === 'number') ids.add(x.v);
    const code = this._codesOfNodes([...ids]);
    return decoded.map(({ subject, vals }) => {
      const out = { concept_id: subject, fields: null, effective_time: null, module_id: null };
      const extra = [];
      for (const { c, v, node } of vals) {
        if (c.name === 'effectiveTime' && c.type === 't') out.effective_time = v ?? null;
        else if (c.name === 'moduleId' && !c.target) out.module_id = typeof v === 'number' ? v : null;
        else extra.push(v == null ? '' : node && typeof v === 'number' ? (code.get(v) ?? '') : String(v));
      }
      out.fields = JSON.stringify(extra);
      return out;
    });
  }

  /** node id -> code (a concept's code, an item's external id), in chunks */
  codesOfNodes(ids) { return this._codesOfNodes(ids); }

  _codesOfNodes(ids) {
    const out = new Map();
    const c = this.stmt('SELECT id, code FROM main.concept WHERE id IN (SELECT value FROM json_each(?))').raw();
    const i = this.stmt('SELECT id, CAST(external_id AS TEXT) FROM main.item WHERE id IN (SELECT value FROM json_each(?))').raw();
    for (let k = 0; k < ids.length; k += 20000) {
      const part = JSON.stringify(ids.slice(k, k + 20000));
      for (const [id, v] of c.all(part)) out.set(id, v);
      for (const [id, v] of i.all(part)) out.set(id, v == null ? null : String(v));
    }
    return out;
  }

  /** a relation's own columns (not effectiveTime / moduleId): {names, types}, or null without any */
  _ownColumns(d) {
    if (!d || d.role === 'language') return null;
    const own = (d.fields || []).filter((f) => f.name !== 'effectiveTime' && f.name !== 'moduleId');
    return own.length ? { names: own.map((f) => f.name), types: own.map((f) => f.type) } : null;
  }

  refsetDef(rid) { return this._ownColumns(this.relations.get(rid)); }

  /** the name of a reference set's target column (record.target_id), or null */
  refsetTargetField(rid) {
    const d = this.relations.get(rid);
    const c = d && (d.fields || []).find((f) => f.target);
    return c ? c.name : null;
  }

  refsetDefs() {
    const out = new Map();
    for (const [rid, d] of this.relations) { const x = this._ownColumns(d); if (x) out.set(rid, x); }
    return out;
  }

  // ---- identifiers, normal forms, maps ------------------------------------------------------

  /** the concepts of identifier rows of a property (a union: of its members) with any of the values, sorted */
  subjectsOfIdentifiers(def, values, stats) {
    const pids = def.members ? def.members.map((m) => m.id) : [def.id];
    // values as stored: a canonical integer is an INTEGER (json_each gives it as one), text otherwise
    const vals = values.map((v) => (idValue(v) === String(v) ? String(v) : Number(v)));
    const q = this.stmt(`SELECT DISTINCT subject_id FROM main.identifier WHERE property_id IN (SELECT value FROM json_each(?))
      AND value IN (SELECT value FROM json_each(?)) ORDER BY 1`).pluck();
    const r = q.all(JSON.stringify(pids), JSON.stringify(vals));
    if (stats) count(stats, this, q, r.length);
    return r;
  }

  /** a concept's identifiers of the by_subject = 1 schemes (SNOMED CT alternate identifiers), from ix_by_subject */
  alternateIdsOf(id) {
    return this.stmt('SELECT property_id, value FROM main.ix_by_subject WHERE subject_id = ?').raw().all(id)
      .map(([p, value]) => ({ scheme: this.propsById.get(p).code, identifier: String(value) }));
  }

  codesByAlternateId(schemeId, value) {
    const d = this.schemes.get(schemeId);
    if (!d) return [];
    return this.stmt('SELECT c.code FROM main.identifier i JOIN main.concept c ON c.id = i.subject_id WHERE i.property_id = ? AND i.value = ?').pluck().all(d.id, idValue(value));
  }

  conceptsWithScheme(schemeId) {
    const d = this.schemes.get(schemeId);
    if (!d) return [];
    return this.stmt('SELECT DISTINCT subject_id FROM main.identifier WHERE property_id = ? ORDER BY 1').pluck().all(d.id);
  }

  hasAlternateIds() { return this.schemes.size > 0 && !!this.stmt('SELECT 1 FROM main.identifier LIMIT 1').get(); }

  allAlternateIds() {
    return this.stmt('SELECT subject_id, property_id, value FROM main.identifier').raw().all()
      .map(([s, p, v]) => ({ concept_id: s, scheme_id: this.propsById.get(p).conceptId, identifier: String(v) }));
  }

  identifierModules(moduleProp) {
    return this.stmt(`SELECT DISTINCT m.code AS module, p.code AS scheme FROM main.identifier i JOIN main.property p ON p.id = i.property_id
      JOIN main.link l ON l.subject_id = i.subject_id AND l.property_id = ? JOIN main.concept m ON m.id = l.target_id`).all(moduleProp);
  }

  normalFormOf(id) {
    return this.stmt("SELECT key FROM main.ix_key WHERE name = 'normalForm' AND id = ?").pluck().get(id) ?? null;
  }

  conceptsWithNormalForm(nf) {
    return this.stmt("SELECT k.id AS concept_id, c.code FROM main.ix_key k JOIN main.concept c ON c.id = k.id WHERE k.name = 'normalForm' AND k.key = ? AND c.active = 1").all(nf);
  }

  externalMaps(id, system = null) {
    return system == null
      ? this.stmt('SELECT system, version, code, display, relationship AS equivalence FROM main.mapping WHERE concept_id = ? ORDER BY system, code').all(id)
      : this.stmt('SELECT system, version, code, display, relationship AS equivalence FROM main.mapping WHERE concept_id = ? AND system = ? ORDER BY code').all(id, system);
  }

  mapsTo(system, code) {
    return this.stmt('SELECT c.code, c.display, m.relationship AS equivalence FROM main.mapping m JOIN main.concept c ON c.id = m.concept_id WHERE m.system = ? AND m.code = ? ORDER BY c.code').all(system, code);
  }

  hasMap(id, system, code) {
    return !!((id != null && this.stmt('SELECT 1 FROM main.mapping WHERE concept_id = ? AND system = ? LIMIT 1').get(id, system))
      || this.stmt('SELECT 1 FROM main.mapping WHERE system = ? AND code = ? LIMIT 1').get(system, code));
  }

  // ---- text -------------------------------------------------------------------------------

  textIndex() {
    if (this._textIndex === undefined) {
      const words = require('./text-index').FORMAT;
      this._textIndex = this.meta.get('ix.ix_word.format') === words ? new (require('./text-index').WordIndex)(this) : null;
    }
    return this._textIndex;
  }

  /**
   * fn(id, lang, term) for every name a system's text search reads, in concept order (the index
   * builder's word index, or one built in memory): SNOMED CT every active description; LOINC the
   * display and the designations but RELATEDNAMES2; RxNorm the atoms of concepts in RXNCONSO
   */
  eachSearchName(dialect, fn) {
    require('./text-index').eachSearchName(this, dialect, fn);
  }

  searchNames(dialect, ids, fn) {
    return require('./text-index').searchNamesOf(this, dialect, ids, fn);
  }

  activeLanguages() {
    return this.db.prepare('SELECT DISTINCT language FROM main.item WHERE active = 1 AND cs_id = ?').pluck().all(this.csId);
  }

  blockDesignations() {
    return this.stmt('SELECT concept_id, language, text FROM main.item WHERE cs_id = +? AND (kind = 0 OR use_id IS NOT NULL) ORDER BY concept_id, id').raw().all(this.csId);
  }

  blockConcepts(a, b) {
    return this.stmt('SELECT id, code, display FROM main.concept WHERE id BETWEEN ? AND ? ORDER BY id').raw().all(a, b);
  }
}

/** open a terminology file (opts as the Store constructor's) */
function openStore(file, opts = {}) {
  return new Store(file, opts);
}

module.exports = { Store, openStore, checkFormat, readBehaviour, BEHAVIOUR, FORMAT, KIND, EMPTY, VK, setKey, registry, count, holdReadLock, primaryLang };
