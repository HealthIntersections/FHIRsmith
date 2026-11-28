'use strict';

// Generic builder for the terminology file (schema.sql). No terminology knowledge here.
//
// An importer names concepts by code and gets back a handle; items (terms, definitions, atoms)
// hang off a concept and also get a handle. Statements (link, literal, identifier, record) take
// node handles, so any of them can be about a concept or an item. Facts are staged with
// provisional handles in a scratch SQLite file; finish():
//   1. numbers concepts (sqlite-v2/numbering.js: active first, depth-first over the subsumption
//      links, siblings by sort key) -> ids 1..N, then items N+1.. in (concept, arrival) order;
//   2. rewrites every staged fact to final ids, in key order, into the destination;
//      item.rank (derived) from the role 'language' relations and meta displayContexts;
//   3. fills the catalog's computed fields (subject_kind, target_kind, n_rows; shape 'union' for a
//      link row with members and no rows of its own) from the rows, by_target (hierarchy or
//      refinable) and by_subject (every identifier row) unless the importer set them;
//   4. builds the ix_* tables (indexes.js, which reads fact tables only);
//   5. writes meta (format, provenance), ANALYZE (sqlite_stat1 only: analyze()) and VACUUM (unless
//      the importer still writes derived-by-importer rows: then it calls vacuumFile() after them).
//
// Handles: a concept is its 0-based arrival index (>= 0); an item is -(its staging row id) (< 0).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { numberConcepts } = require('../sqlite-v2/numbering');
const { buildIndexes } = require('./indexes');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const FORMAT = 'tx-terminology/1';
// PRAGMA user_version of a file in this format (the earlier sqlite-v2 schema wrote 5), so a reader can
// tell an old file before reading any table
const USER_VERSION = 1;
const COMMIT_EVERY = 100000;
const SHAPES = new Set(['link', 'literal', 'both', 'identifier', 'record', 'union']);
const ROLES = new Set(['language']);
/**
 * a source id that is a canonical decimal integer is stored as INTEGER. Bound as a BigInt:
 * better-sqlite3 binds every JS number as REAL, which an untyped column keeps (and CAST AS TEXT
 * then gives '220306011.0')
 */
function externalIdValue(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`external id ${v}: a number must be a safe non-negative integer (pass the source text)`);
    return BigInt(v);
  }
  const t = String(v);
  if (!/^(0|[1-9][0-9]{0,18})$/.test(t)) return t;
  const b = BigInt(t);
  return b > 9223372036854775807n ? t : b;
}
const LITERAL_TYPES = new Set(['code', 'Coding', 'string', 'integer', 'decimal', 'boolean', 'dateTime']);

/** the sections of schema.sql: { facts, factIndexes, ix } */
function schemaSections() {
  const ddl = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const part = (name) => {
    const m = ddl.split(/^-- @(facts|fact-indexes|ix)\s*$/m);
    const i = m.indexOf(name);
    if (i < 0) throw new Error(`schema.sql: no @${name} section`);
    return m[i + 1];
  };
  return { facts: part('facts'), factIndexes: part('fact-indexes'), ix: part('ix') };
}

class TerminologyBuilder {
  /** @param {string} dest @param {object} [options] { overwrite, log, importer } */
  constructor(dest, options = {}) {
    this.dest = path.resolve(dest);
    this.log = options.log || (() => {});
    this.importer = options.importer || 'unknown';
    this.t0 = Date.now();
    this.timings = {};
    if (fs.existsSync(this.dest)) {
      if (!options.overwrite) throw new Error(`Destination exists: ${this.dest} (use overwrite)`);
      fs.rmSync(this.dest, { force: true });
    }
    fs.mkdirSync(path.dirname(this.dest), { recursive: true });
    this.stagePath = `${this.dest}.stage`;
    fs.rmSync(this.stagePath, { force: true });
    this.st = new Database(this.stagePath);
    this.st.pragma('journal_mode = OFF');
    this.st.pragma('synchronous = OFF');
    this.st.pragma('cache_size = -200000');
    this.st.exec(`
      CREATE TABLE s_item (id INTEGER PRIMARY KEY, concept INTEGER, kind INTEGER, external_id, cs_id INTEGER,
        language TEXT, use_id INTEGER, text TEXT, active INTEGER, preferred INTEGER, rank INTEGER);
      CREATE TABLE s_link (subject INTEGER, prop INTEGER, grp INTEGER, target INTEGER, active INTEGER, seq INTEGER);
      CREATE TABLE s_literal (subject INTEGER, prop INTEGER, grp INTEGER, value, active INTEGER);
      CREATE TABLE s_identifier (prop INTEGER, value, subject INTEGER, resolves INTEGER);
      CREATE TABLE s_record (id INTEGER PRIMARY KEY, relation INTEGER, subject INTEGER, target INTEGER, active INTEGER, fields TEXT);
      CREATE TABLE s_mapping (concept INTEGER, prop INTEGER, system TEXT, version TEXT, code TEXT, display TEXT, relationship TEXT);
      CREATE TABLE s_value_label (prop INTEGER, value, display TEXT);
    `);
    const p = (sql) => this.st.prepare(sql);
    this.ins = {
      item: p('INSERT INTO s_item (concept, kind, external_id, cs_id, language, use_id, text, active, preferred, rank) VALUES (?,?,?,?,?,?,?,?,?,?)'),
      link: p('INSERT INTO s_link VALUES (?,?,?,?,?,?)'),
      literal: p('INSERT INTO s_literal VALUES (?,?,?,?,?)'),
      identifier: p('INSERT INTO s_identifier VALUES (?,?,?,?)'),
      record: p('INSERT INTO s_record (relation, subject, target, active, fields) VALUES (?,?,?,?,?)'),
      mapping: p('INSERT INTO s_mapping VALUES (?,?,?,?,?,?,?)'),
      valueLabel: p('INSERT INTO s_value_label VALUES (?,?,?)'),
    };
    this.pending = 0;
    this.st.exec('BEGIN');

    this.systems = [];            // cs_id - 1 -> spec; cs_id 1 is the served system
    this.codes = [];
    this.index = new Map();
    this.conceptCs = [];
    this.active = [];
    this.display = [];
    this.sortKey = [];
    this.properties = [];         // id - 1 -> def
    this.propertyByKey = new Map(); // cs_id|code -> def
    this.members = [];
    this.uses = new Map();
    this.meta = new Map();
    this.sources = [];
    this.counts = {};
  }

  _tick() { if (++this.pending >= COMMIT_EVERY) { this.st.exec('COMMIT; BEGIN'); this.pending = 0; } }
  _count(name) { this.counts[name] = (this.counts[name] || 0) + 1; }

  // ---- release ---------------------------------------------------------------------------

  /**
   * A code system row. The first one is the served system (cs_id 1); later ones are sources that
   * only contribute items (served = 0). Returns the cs_id.
   * { uri, version, name, title, description, releaseDate, content, caseSensitive, hierarchyMeaning, defaultLanguage,
   *   compositional, resource }
   */
  codeSystem(spec) {
    if (!spec.uri || spec.version == null) throw new Error('codeSystem: uri and version are required');
    this.systems.push({ content: 'complete', ...spec, served: this.systems.length === 0 ? 1 : 0 });
    return this.systems.length;
  }

  /** a behaviour setting (meta behaviour.<key>, a JSON value; tx/sqlite-v2/store.js BEHAVIOUR) */
  setBehaviour(key, value) {
    this.meta.set(`behaviour.${key}`, JSON.stringify(value));
  }

  /** a release fact without a column (displayContexts, moduleDependencies, ...): JSON for objects */
  setMeta(key, value) {
    this.meta.set(key, value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value));
  }

  addSource(filePath) {
    const st = fs.statSync(filePath);
    if (st.isDirectory()) { for (const e of fs.readdirSync(filePath).sort()) this.addSource(path.join(filePath, e)); return; }
    this.sources.push({ path: filePath, size: st.size });
  }

  // ---- catalog ---------------------------------------------------------------------------

  /**
   * A catalog row; returns its id (an existing (cs, code) returns the existing id, which must have
   * the same shape). { code, cs = 1, uri, display, shape, fhirType, concept (handle), subsumption,
   * closureFrom, filterable = true, refinable, wildcard, inverseOf (may name a union row), byTarget
   * (default: subsumption or refinable; being named by inverseOf does not imply it), bySubject
   * (shape identifier: its rows are read by subject, ix_by_subject; default true), ordered
   * (link.seq orders a subject's targets and the order is part of the answer), fields
   * ([{name, type, target}]: record shape), role (NULL or 'language': a record relation on items that
   * ranks displays, by meta displayContexts), filterOps (the FHIR operators a filter on it accepts),
   * report ('named' | 'always': when $lookup reports it) }
   */
  property(spec) {
    const cs = spec.cs || 1;
    const key = `${cs}|${spec.code}`;
    const known = this.propertyByKey.get(key);
    if (known) {
      if (known.shape !== spec.shape) throw new Error(`property ${spec.code}: shape ${known.shape}, not ${spec.shape}`);
      return known.id;
    }
    if (!SHAPES.has(spec.shape)) throw new Error(`property ${spec.code}: bad shape ${spec.shape}`);
    if (spec.role != null && !ROLES.has(spec.role)) throw new Error(`property ${spec.code}: bad role ${spec.role}`);
    if (spec.role === 'language' && (spec.shape !== 'record' || !(spec.fields || []).some((f) => f.target))) {
      throw new Error(`property ${spec.code}: a language relation is a record with a target column (the acceptability)`);
    }
    if (spec.bySubject != null && spec.shape !== 'identifier') throw new Error(`property ${spec.code}: bySubject is for shape identifier`);
    if ((spec.shape === 'literal' || spec.shape === 'both') && !LITERAL_TYPES.has(spec.fhirType)) {
      throw new Error(`property ${spec.code}: bad fhirType ${spec.fhirType}`);
    }
    const def = {
      id: this.properties.length + 1, cs, code: spec.code, uri: spec.uri ?? null, display: spec.display ?? null,
      concept: spec.concept ?? null, shape: spec.shape, role: spec.role ?? null, fhirType: spec.fhirType ?? null,
      subsumption: spec.subsumption ? 1 : 0, closureFrom: spec.closureFrom ?? null,
      filterable: spec.filterable === false ? 0 : 1, refinable: spec.refinable ? 1 : 0, wildcard: spec.wildcard ? 1 : 0,
      inverseOf: spec.inverseOf ?? null, byTarget: spec.byTarget == null ? null : (spec.byTarget ? 1 : 0),
      bySubject: spec.shape === 'identifier' && spec.bySubject !== false ? 1 : 0,
      ordered: spec.ordered ? 1 : 0,
      filterOps: spec.filterOps ? JSON.stringify(spec.filterOps) : null, report: spec.report ?? null,
      fields: spec.fields ? JSON.stringify(spec.fields) : null,
      // record shape: positions in record.fields (the non-target columns) that hold node handles
      nodeCols: spec.fields ? spec.fields.filter((f) => !f.target).map((f, i) => ((f.type === 'c' || f.type === 'n') ? i : -1)).filter((i) => i >= 0) : [],
    };
    this.properties.push(def);
    this.propertyByKey.set(key, def);
    return def.id;
  }

  propertyId(code, cs = 1) { const d = this.propertyByKey.get(`${cs}|${code}`); return d ? d.id : undefined; }

  /** the property whose explicit pairs are this (subsumption) property's closure, set after both exist */
  setClosureFrom(property, from) { this.properties[property - 1].closureFrom = from; }

  /** the parent property is the union of the child (property_member) */
  propertyMember(parent, child) { this.members.push([parent, child]); }

  // ---- nodes -----------------------------------------------------------------------------

  /** a concept; returns its handle. Re-adding a code returns the existing handle. */
  concept(code, { cs = 1, active = true, display = null, sortKey = 0 } = {}) {
    const known = this.index.get(code);
    if (known !== undefined) return known;
    if (cs !== 1) throw new Error('concepts belong to the served system (cs 1)');
    const i = this.codes.length;
    this.codes.push(code);
    this.index.set(code, i);
    this.conceptCs.push(cs);
    this.active.push(active ? 1 : 0);
    this.display.push(display);
    this.sortKey.push(sortKey);
    return i;
  }

  idx(code) { return this.index.get(code); }
  setActive(i, active) { this.active[i] = active ? 1 : 0; }
  setDisplay(i, display) { this.display[i] = display; }
  setSortKey(i, key) { this.sortKey[i] = key; }

  /** an item_use coding; returns its use_id */
  use({ system = null, code, display = null }) {
    const k = `${system || ''}|${code}`;
    let u = this.uses.get(k);
    if (!u) this.uses.set(k, u = { id: this.uses.size + 1, system, code, display });
    return u.id;
  }

  /**
   * An item below a concept; returns its handle (< 0), or null for an empty text.
   * { kind = 0, externalId, cs = 1, language, use ({system, code, display} or a use_id), text, active, preferred, rank }
   */
  item(concept, { kind = 0, externalId = null, cs = 1, language = null, use = null, text, active = true, preferred = false, rank = null }) {
    if (text === null || text === undefined || text === '') return null;
    if (!(concept >= 0)) throw new Error('item: the concept handle is required');
    const useId = use == null ? null : typeof use === 'number' ? use : this.use(use);
    const id = this.ins.item.run(concept, kind, externalIdValue(externalId), cs, language, useId, text, active ? 1 : 0, preferred ? 1 : 0, rank).lastInsertRowid;
    this._count('items');
    this._tick();
    return -Number(id);
  }

  /** change an item's preferred flag (the importer decides after reading, e.g. the definition shown) */
  setItemPreferred(handle, preferred) {
    if (!(handle < 0)) throw new Error('setItemPreferred: an item handle is required');
    if (!this._setPref) this._setPref = this.st.prepare('UPDATE s_item SET preferred = ? WHERE id = ?');
    this._setPref.run(preferred ? 1 : 0, -handle);
    this._tick();
  }

  // ---- statements ------------------------------------------------------------------------

  link(subject, property, target, { group = 0, active = true, seq = null } = {}) {
    this.ins.link.run(subject, property, group, target, active ? 1 : 0, seq);
    this._count('links');
    this._tick();
  }

  literal(subject, property, value, { group = 0, active = true } = {}) {
    if (value === null || value === undefined || value === '') return;
    this.ins.literal.run(subject, property, group, this._typed(property, value), active ? 1 : 0);
    this._count('literals');
    this._tick();
  }

  /**
   * a value -> subject statement. resolves: 0 not a code; 1 an alias, accepted as a code and answered
   * with the subject's own code; 2 a code in its own right, answered as written
   */
  identifier(property, value, subject, { resolves = 0 } = {}) {
    const r = resolves === true ? 1 : resolves === false ? 0 : resolves;
    if (r !== 0 && r !== 1 && r !== 2) throw new Error(`identifier ${value}: resolves is 0, 1 or 2`);
    this.ins.identifier.run(property, externalIdValue(value), subject, r);
    this._count('identifiers');
    this._tick();
  }

  /**
   * a record row; seq is its arrival order within the relation. target: a node handle.
   * fields: the values of the relation's non-target columns (property.fields order). In a node
   * column (type c / n) a number is a node handle (rewritten to the node id at finish); a string
   * is kept as it is (a source code that is not a node of this file).
   */
  record(relation, subject, { target = null, active = true, fields = null } = {}) {
    this.ins.record.run(relation, subject, target, active ? 1 : 0, fields ? JSON.stringify(fields) : null);
    this._count('records');
    this._tick();
  }

  /** the display of a literal value of a property (value_label) */
  valueLabel(property, value, display) {
    this.ins.valueLabel.run(property, this._typed(property, value), display);
  }

  mapping(concept, { property = null, system, version = null, code, display = null, relationship }) {
    this.ins.mapping.run(concept, property, system, version, code, display, relationship);
    this._count('mappings');
    this._tick();
  }

  _typed(property, value) {
    const def = this.properties[property - 1];
    switch (def.fhirType) {
      case 'integer': case 'decimal': {
        const n = Number(value);
        if (Number.isNaN(n)) throw new Error(`property ${def.code}: '${value}' is not a number`);
        return n;
      }
      case 'boolean':
        return (value === true || value === 'true' || value === '1' || value === 1 || value === 'Y') ? 1 : 0;
      default:
        return String(value);
    }
  }

  // ---- final stage -----------------------------------------------------------------------

  _record(name, t, r) {
    const rec = { s: (Date.now() - t) / 1000, peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) };
    if (typeof r === 'number') rec.rows = r;
    this.timings[name] = rec;
    this.log(`  ${name}: ${rec.s.toFixed(1)} s${rec.rows !== undefined ? `, ${rec.rows.toLocaleString()} rows` : ''}, peak RSS ${rec.peakRssMiB} MiB`);
  }

  _time(name, fn) { const t = Date.now(); const r = fn(); this._record(name, t, r); return r; }

  async stage(name, fn) { const t = Date.now(); const r = await fn(); this._record(name, t, typeof r === 'number' ? r : undefined); return r; }

  /**
   * record rows to final ids, in SQL: subject and target through the node map, the node columns of
   * fields (property nodeCols: a JSON number there is a node handle) with json_set; seq = arrival
   * order within the relation. One statement per relation, in relation order, so rows go in
   * key order.
   */
  _rewriteRecords(db) {
    db.exec('CREATE INDEX st.s_record_relation ON s_record(relation, id)');
    const rels = db.prepare('SELECT DISTINCT relation FROM st.s_record ORDER BY 1').pluck().all();
    let n = 0;
    for (const rel of rels) {
      const def = this.properties[rel - 1];
      const cols = (def && def.nodeCols) || [];
      // each node column from the staged row: its node id where it is a handle, else as it is
      const f = cols.length ? `json_set(r.fields, ${cols.map((i) => `'$[${i}]', CASE WHEN json_type(r.fields, '$[${i}]') = 'integer'
          THEN (SELECT new FROM st.s_node WHERE old = json_extract(r.fields, '$[${i}]')) ELSE json_extract(r.fields, '$[${i}]') END`).join(', ')})` : 'r.fields';
      n += db.prepare(`INSERT INTO record SELECT r.relation, m.new,
          row_number() OVER (ORDER BY r.id) - 1, mt.new, r.active, ${f}
        FROM st.s_record r JOIN st.s_node m ON m.old = r.subject LEFT JOIN st.s_node mt ON mt.old = r.target
        WHERE r.relation = ? ORDER BY 2, 3`).run(rel).changes;
    }
    return n;
  }

  /**
   * item.rank (derived), from the relations with role 'language' and meta displayContexts
   * ({relations, preferred, use}): 0 an item whose target is `preferred` in one of
   * `relations`, 1 Preferred in another language relation, 2 any other. Only items of `use`
   * ({system, code}) rank 0 or 1, when it is set (SNOMED CT: synonyms; an FSN is Preferred too, but
   * is not a display). Without language relations: the rank the importer gave.
   * Returns the SQL expression for item.rank over staged s_item i and the join it needs.
   */
  _stageRank(db) {
    const lang = this.properties.filter((p) => p.role === 'language');
    if (!lang.length) return { expr: 'i.rank', join: '' };
    // meta displayContexts = {relations: [codes, in order], preferred: <target code>, use: {system, code}}
    const dc = JSON.parse(this.meta.get('displayContexts') || '{}');
    const contexts = (dc.relations || []).map(String);
    if (dc.preferred == null) throw new Error('meta displayContexts: no preferred target for the language relations');
    const t = this.index.get(String(dc.preferred));
    db.exec('CREATE TABLE st.s_pref (relation INTEGER PRIMARY KEY, target INTEGER, display INTEGER)');
    const ins = db.prepare('INSERT INTO st.s_pref VALUES (?, ?, ?)');
    if (t !== undefined) for (const p of lang) ins.run(p.id, t, contexts.includes(p.code) ? 1 : 0);
    db.exec(`CREATE TABLE st.s_rank (item INTEGER PRIMARY KEY, flag INTEGER NOT NULL);
      INSERT INTO st.s_rank SELECT -r.subject, max(CASE WHEN p.display = 1 THEN 2 ELSE 1 END) FROM st.s_record r
        JOIN st.s_pref p ON p.relation = r.relation AND p.target = r.target WHERE r.active = 1 AND r.subject < 0 GROUP BY r.subject`);
    const du = dc.use || null;
    const u = du ? this.uses.get(`${du.system || ''}|${du.code}`) : null;
    const useCond = du ? `i.use_id IS NOT ${u ? u.id : 'NULL'}` : '0';
    return { expr: `CASE WHEN ${useCond} THEN 2 WHEN rk.flag = 2 THEN 0 WHEN rk.flag = 1 THEN 1 ELSE 2 END`, join: 'LEFT JOIN st.s_rank rk ON rk.item = i.id' };
  }

  /**
   * @param {object} [extra] importer stats, kept in meta 'provenance.importer'
   * @param {object} [opts] { vacuum: false when the importer writes derived-by-importer rows after
   *   this (it then calls vacuumFile) }
   */
  finish(extra = {}, opts = {}) {
    if (!this.systems.length) throw new Error('codeSystem() was not called');
    this.st.exec('COMMIT');
    this.timings.parse = { s: (Date.now() - this.t0) / 1000, peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) };
    const n = this.codes.length;
    this.log(`Final stage: ${n.toLocaleString()} concepts`);

    // 1. numbering: concepts over the active subsumption links between concepts
    const hier = this.properties.filter((p) => p.subsumption).map((p) => p.id);
    const [childOf, parentOf] = hier.length
      ? intPairs(this.st.prepare(`SELECT subject, target FROM s_link WHERE active = 1 AND subject >= 0 AND target >= 0 AND prop IN (${hier.join(',')})`))
      : [new Int32Array(0), new Int32Array(0)];
    const num = this._time('number', () => numberConcepts({
      codes: this.codes, active: Uint8Array.from(this.active), childOf, parentOf, sortKey: Float64Array.from(this.sortKey),
    }));
    const { idOf, order, activeCount } = num;

    const db = new Database(this.dest);
    this.db = db;
    db.pragma('page_size = 4096');
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    db.pragma('cache_size = -400000');
    const ddl = schemaSections();
    db.exec(ddl.facts);
    db.pragma(`user_version = ${USER_VERSION}`);
    this.st.close();
    db.prepare('ATTACH DATABASE ? AS st').run(this.stagePath);
    const run = (name, sql) => this._time(`rewrite ${name}`, () => db.prepare(sql).run().changes);

    db.exec('BEGIN');
    // node map: concept handles -> 1..N, item handles -> N+1.. in (concept id, arrival) order
    db.exec('CREATE TABLE st.s_node (old INTEGER PRIMARY KEY, new INTEGER NOT NULL)');
    const insNode = db.prepare('INSERT INTO st.s_node VALUES (?, ?)');
    for (let i = 0; i < n; i++) insNode.run(i, idOf[i]);
    run('item map', `INSERT INTO st.s_node SELECT -i.id, ${n} + row_number() OVER (ORDER BY m.new, i.id)
      FROM st.s_item i JOIN st.s_node m ON m.old = i.concept`);

    const insCs = db.prepare(`INSERT INTO code_system (cs_id, uri, version, name, title, description, release_date, content,
      case_sensitive, hierarchy_meaning, default_language, compositional, served, concept_count, active_count, resource)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const flag = (v) => (v == null ? null : (v ? 1 : 0));
    this.systems.forEach((cs, k) => insCs.run(k + 1, cs.uri, String(cs.version), cs.name ?? null, cs.title ?? null,
      cs.description ?? null, cs.releaseDate ?? null, cs.content, flag(cs.caseSensitive),
      cs.hierarchyMeaning ?? null, cs.defaultLanguage ?? null, flag(cs.compositional), cs.served, cs.served ? n : 0, cs.served ? activeCount : 0,
      cs.resource == null ? null : (typeof cs.resource === 'string' ? cs.resource : JSON.stringify(cs.resource))));
    const insUse = db.prepare('INSERT INTO item_use VALUES (?,?,?,?)');
    for (const u of this.uses.values()) insUse.run(u.id, u.system, u.code, u.display);

    const insConcept = db.prepare('INSERT INTO concept VALUES (?,?,?,?,?)');
    this._time('rewrite concept', () => {
      for (let k = 0; k < n; k++) { const i = order[k]; insConcept.run(k + 1, this.conceptCs[i], this.codes[i], this.active[i], this.display[i]); }
      return n;
    });
    const rank = this._time('item rank', () => this._stageRank(db));
    run('item', `INSERT INTO item SELECT m.new, mc.new, i.kind, i.external_id, i.cs_id, i.language, i.use_id, i.text, i.active, i.preferred, ${rank.expr}
      FROM st.s_item i JOIN st.s_node m ON m.old = -i.id JOIN st.s_node mc ON mc.old = i.concept ${rank.join} ORDER BY 1`);
    // duplicates by key collapse; a link in several rows keeps its first seq
    run('link', `INSERT INTO link SELECT ms.new, l.prop, l.grp, mt.new, l.active, min(l.seq) FROM st.s_link l
      JOIN st.s_node ms ON ms.old = l.subject JOIN st.s_node mt ON mt.old = l.target
      GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4, 5`);
    run('literal', `INSERT OR IGNORE INTO literal SELECT m.new, l.prop, l.grp, l.value, l.active FROM st.s_literal l
      JOIN st.s_node m ON m.old = l.subject ORDER BY 1, 2, 3, 4, 5`);
    run('identifier', `INSERT OR IGNORE INTO identifier SELECT i.prop, i.value, m.new, i.resolves FROM st.s_identifier i
      JOIN st.s_node m ON m.old = i.subject ORDER BY 1, 2, 3`);
    this._time('rewrite record', () => this._rewriteRecords(db));
    run('value_label', `INSERT OR IGNORE INTO value_label SELECT prop, value, display FROM st.s_value_label ORDER BY 1, 2`);
    run('mapping', `INSERT OR IGNORE INTO mapping SELECT m.new, x.prop, x.system, x.version, x.code, x.display, x.relationship
      FROM st.s_mapping x JOIN st.s_node m ON m.old = x.concept ORDER BY 1, 3, 5`);

    // catalog, with its computed fields from the rows just written
    const nodeId = (h) => (h == null ? null : h >= 0 ? idOf[h] : db.prepare('SELECT new FROM st.s_node WHERE old = ?').pluck().get(h));
    const computed = this._time('catalog computed fields', () => catalogStats(db, n));
    const insProp = db.prepare(`INSERT INTO property (id, cs_id, code, uri, display, concept_id, shape, role, fhir_type, subject_kind,
      target_kind, n_rows, subsumption, closure_from, filterable, refinable, wildcard, inverse_of, by_target, by_subject, ordered, filter_ops, report, fields)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const parents = new Set(this.members.map(([a]) => a));
    for (const p of this.properties) {
      // subject_kind NULL for a catalog row with no rows
      const c = computed.get(p.id) || { subjectKind: null, targetKind: null, n: 0 };
      // shape 'union': a link row whose only rows are its members'
      let shape = p.shape;
      if (parents.has(p.id)) {
        if (c.n > 0) throw new Error(`property ${p.code}: a union (property_member) with rows of its own`);
        if (shape !== 'link' && shape !== 'union') throw new Error(`property ${p.code}: shape ${shape} with property_member rows`);
        shape = 'union';
      } else if (shape === 'union') throw new Error(`property ${p.code}: shape union without members`);
      const byTarget = p.byTarget != null ? p.byTarget
        : ((shape === 'link' || shape === 'both') && (p.subsumption || p.refinable) ? 1 : 0);
      insProp.run(p.id, p.cs, p.code, p.uri, p.display, nodeId(p.concept), shape, p.role, p.fhirType, c.subjectKind,
        (shape === 'link' || shape === 'both' || shape === 'record') ? c.targetKind : null, c.n,
        p.subsumption, p.closureFrom, p.filterable, p.refinable, p.wildcard, p.inverseOf, byTarget, p.bySubject, p.ordered, p.filterOps, p.report, p.fields);
    }
    const insMember = db.prepare('INSERT OR IGNORE INTO property_member VALUES (?, ?)');
    for (const [a, b] of this.members) insMember.run(a, b);
    db.exec('COMMIT');
    db.exec('DETACH DATABASE st');
    this._time('fact indexes', () => db.exec(ddl.factIndexes));
    this._time('checks', () => checkFacts(db, n, activeCount));

    // meta: format and provenance (release facts were set by the importer); behaviour settings
    // as a reader checks them
    require('../../sqlite-v2/store').readBehaviour(this.meta, this.dest);
    const insMeta = db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)');
    for (const [k, v] of [...this.meta].sort()) insMeta.run(k, v);
    insMeta.run('format', FORMAT);
    // the languages of the served system's items, in order of first appearance (a release fact)
    insMeta.run('languages', JSON.stringify(db.prepare(`SELECT language FROM item WHERE cs_id = 1 AND language IS NOT NULL
      GROUP BY language ORDER BY min(id)`).pluck().all()));
    this._time('hash', () => { for (const s of this.sources) s.sha256 = sha256File(s.path); });
    insMeta.run('provenance.importer', this.importer);
    insMeta.run('provenance.builtAt', new Date().toISOString());
    insMeta.run('provenance.node', process.version);
    insMeta.run('provenance.sources', JSON.stringify(this.sources.map((s) => ({ name: path.basename(s.path), size: s.size, sha256: s.sha256 }))));
    insMeta.run('provenance.importerStats', JSON.stringify(extra));

    // indexes: from the fact tables only
    const ixStats = buildIndexes(db, { log: this.log, time: (name, fn) => this._time(name, fn) });
    this._time('analyze', () => analyze(db));
    this.timings.total = (Date.now() - this.t0) / 1000;
    insMeta.run('provenance.timings', JSON.stringify(this.timings));
    db.pragma('journal_mode = DELETE');
    if (opts.vacuum !== false) this._time('vacuum', () => { db.exec('VACUUM'); });

    const tables = {};
    for (const t of ['concept', 'item', 'property', 'link', 'literal', 'identifier', 'record', 'mapping', 'ix_set', 'ix_in', 'ix_order', 'ix_word']) {
      tables[t] = db.prepare(`SELECT count(*) AS c FROM ${t}`).get().c;
    }
    db.close();
    fs.rmSync(this.stagePath, { force: true });
    const summary = { concepts: n, activeConcepts: activeCount, items: this.counts.items || 0, tables, indexes: ixStats,
      staged: this.counts, importer: extra, fileBytes: fs.statSync(this.dest).size, timings: this.timings };
    this.log(`Done: ${this.dest} (${(summary.fileBytes / 1048576).toFixed(1)} MiB, ${this.timings.total.toFixed(0)} s)`);
    return summary;
  }
}

/** per property: n_rows, subject_kind, target_kind from the fact rows (ids <= n are concepts) */
function catalogStats(db, n) {
  const out = new Map();
  const kind = (lo, hi) => (lo == null ? null : hi <= n ? 'concept' : lo > n ? 'item' : 'both');
  const merge = (pid, rows, sLo, sHi, tLo, tHi) => {
    const c = out.get(pid) || { n: 0, s: [], t: [] };
    c.n += rows; c.s.push(sLo, sHi);
    if (tLo != null) c.t.push(tLo, tHi);
    out.set(pid, c);
  };
  for (const r of db.prepare('SELECT property_id p, count(*) c, min(subject_id) a, max(subject_id) b, min(target_id) x, max(target_id) y FROM link GROUP BY 1').all()) merge(r.p, r.c, r.a, r.b, r.x, r.y);
  for (const r of db.prepare('SELECT property_id p, count(*) c, min(subject_id) a, max(subject_id) b FROM literal GROUP BY 1').all()) merge(r.p, r.c, r.a, r.b);
  for (const r of db.prepare('SELECT property_id p, count(*) c, min(subject_id) a, max(subject_id) b FROM identifier GROUP BY 1').all()) merge(r.p, r.c, r.a, r.b);
  for (const r of db.prepare('SELECT relation_id p, count(*) c, min(subject_id) a, max(subject_id) b, min(target_id) x, max(target_id) y FROM record GROUP BY 1').all()) merge(r.p, r.c, r.a, r.b, r.x, r.y);
  const res = new Map();
  for (const [pid, c] of out) {
    res.set(pid, { n: c.n, subjectKind: kind(Math.min(...c.s), Math.max(...c.s)),
      targetKind: c.t.length ? kind(Math.min(...c.t), Math.max(...c.t)) : null });
  }
  return res;
}

function checkFacts(db, n, activeCount) {
  const one = (sql) => db.prepare(sql).pluck().get();
  const fail = (m) => { throw new Error(`integrity: ${m}`); };
  if (one('SELECT count(*) FROM concept') !== n) fail('concept count');
  if (one(`SELECT count(*) FROM concept WHERE active <> (id <= ${activeCount})`)) fail('active concepts are not a prefix');
  if (one(`SELECT count(*) FROM item WHERE id <= ${n}`)) fail('an item id is not above every concept id');
  if (one('SELECT count(*) FROM item i LEFT JOIN code_system c ON c.cs_id = i.cs_id WHERE c.cs_id IS NULL')) fail('an item has an unknown cs_id');
  return true;
}

function intPairs(stmt) {
  let a = new Int32Array(1 << 16), b = new Int32Array(1 << 16), k = 0;
  for (const [x, y] of stmt.raw().iterate()) {
    if (k === a.length) { const a2 = new Int32Array(k * 2); a2.set(a); a = a2; const b2 = new Int32Array(k * 2); b2.set(b); b = b2; }
    a[k] = x; b[k] = y; k++;
  }
  return [a.slice(0, k), b.slice(0, k)];
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.allocUnsafe(1 << 22);
  try { let r; while ((r = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, r)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/**
 * ANALYZE (the whole file, or `what`: a table or index) and keep sqlite_stat1 only: the format ships no
 * sqlite_stat4 (with it SQLite re-plans a `col = ?` statement on every bind)
 */
function analyze(db, what = null) {
  db.exec(what ? `ANALYZE ${what}` : 'ANALYZE');
  db.exec('DROP TABLE IF EXISTS sqlite_stat4');
}

/** VACUUM a built file (after the importer's derived-by-importer rows), without sqlite_stat4 */
function vacuumFile(file) {
  const db = new Database(file);
  try { db.exec('DROP TABLE IF EXISTS sqlite_stat4'); db.exec('VACUUM'); } finally { db.close(); }
}

module.exports = { TerminologyBuilder, FORMAT, USER_VERSION, schemaSections, vacuumFile, analyze, externalIdValue };
