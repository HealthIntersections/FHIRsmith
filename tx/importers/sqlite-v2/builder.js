'use strict';

// Shared import machinery for the sqlite-v2 schema (schema-v2.sql).
//
// An importer parses its source and hands facts to a V2Builder, naming concepts by code.
// Facts are staged with provisional concept indexes in a scratch SQLite file next to the
// destination. builder.finish() is the shared final stage used by every vocabulary:
//   1. number concepts depth-first (numbering.js) -> concept_id;
//   2. rewrite every staged fact to final ids, in id order, into the destination;
//   3. build and write the stored sets (sets.js) with their member counts;
//   4. full-text indexes, secondary indexes, integrity checks, ANALYZE;
//   5. record provenance (sources with sha256, counts, timings).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const { numberConcepts } = require('./numbering');
const { dialectFor } = require('../../sqlite-v2/dialects');
const { orderKind, computeOrder, writeOrder, hierarchyArrays, writeHierarchyOrder } = require('../../sqlite-v2/orders');
const { writeTextTables } = require('../../sqlite-v2/text-index');
const {
  SET_KIND, serialize, rangeSet, descendantsFromEdges, descendantsFromPairs, groupSorted,
} = require('./sets');
const sets = require('./sets'); // sets.RoaringBitmap32: roaring loads on first use

const SCHEMA_PATH = path.join(__dirname, 'schema-v2.sql');
const SCHEMA_VERSION = 5; // PRAGMA user_version of schema-v2.sql (5: designation.rank)
const COMMIT_EVERY = 100000;

const FHIR_TYPES = new Set(['code', 'Coding', 'string', 'integer', 'decimal', 'boolean', 'dateTime']);

class V2Builder {
  /**
   * @param {string} dest  destination .db (replaced if options.overwrite)
   * @param {object} [options] { overwrite, log, importer }
   */
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
      CREATE TABLE s_link (src INTEGER, prop INTEGER, grp INTEGER, tgt INTEGER, active INTEGER, seq INTEGER);
      CREATE TABLE s_literal (src INTEGER, prop INTEGER, grp INTEGER, value, active INTEGER);
      CREATE TABLE s_designation (id INTEGER PRIMARY KEY, concept INTEGER, language TEXT, use_id INTEGER,
        term TEXT, active INTEGER, preferred INTEGER);
      CREATE TABLE s_refset (refset INTEGER, concept INTEGER, fields TEXT, time INTEGER, module INTEGER, seq INTEGER);
      CREATE TABLE s_ancestor (descendant INTEGER, ancestor INTEGER);
      CREATE TABLE s_extmap (concept INTEGER, system TEXT, version TEXT, code TEXT, display TEXT, equivalence TEXT);
      CREATE TABLE s_altid (concept INTEGER, scheme INTEGER, identifier TEXT);
    `);
    const p = (sql) => this.st.prepare(sql);
    this.ins = {
      link: p('INSERT INTO s_link VALUES (?,?,?,?,?,?)'),
      literal: p('INSERT INTO s_literal VALUES (?,?,?,?,?)'),
      designation: p('INSERT INTO s_designation (concept, language, use_id, term, active, preferred) VALUES (?,?,?,?,?,?)'),
      refset: p('INSERT INTO s_refset VALUES (?,?,?,?,?,?)'),
      ancestor: p('INSERT INTO s_ancestor VALUES (?,?)'),
      extmap: p('INSERT INTO s_extmap VALUES (?,?,?,?,?,?)'),
      altid: p('INSERT INTO s_altid VALUES (?,?,?)'),
    };
    this.pending = 0;
    this.st.exec('BEGIN');

    // Concepts live in memory until numbering (index = provisional id, 0-based).
    this.codes = [];
    this.index = new Map();
    this.active = [];
    this.display = [];
    this.definition = [];
    this.sortKey = [];

    this.properties = [];          // property_id - 1 -> def
    this.propertyByCode = new Map();
    this.uses = new Map();          // system|code -> {id, system, code, display}
    this.refsetDefs = new Map();    // refset index -> {names, types}
    this.config = new Map();
    this.accept = { n: 0, d: new Int32Array(1 << 16), r: new Int32Array(1 << 16), v: new Int32Array(1 << 16) };
    this.codeSystem = null;
    this.sources = [];
    this.counts = {};
  }

  _tick() {
    if (++this.pending >= COMMIT_EVERY) { this.st.exec('COMMIT; BEGIN'); this.pending = 0; }
  }

  _count(name, n = 1) { this.counts[name] = (this.counts[name] || 0) + n; }

  // ---- release metadata ----------------------------------------------------------------

  /** { uri, version, name, title, description, releaseDate, edition, content } */
  setCodeSystem(cs) { this.codeSystem = { content: 'complete', ...cs }; }

  setConfig(key, value) {
    this.config.set(key, value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value));
  }

  /** Record a source file (or every file under a directory) for provenance. */
  addSource(filePath) {
    const st = fs.statSync(filePath);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(filePath).sort()) this.addSource(path.join(filePath, e));
      return;
    }
    this.sources.push({ path: filePath, size: st.size });
  }

  // ---- properties ----------------------------------------------------------------------

  /** { code, uri, fhirType, valueKind: 'concept'|'literal', isHierarchy, display } -> property_id */
  property(spec) {
    const existing = this.propertyByCode.get(spec.code);
    if (existing) {
      if (existing.valueKind !== spec.valueKind) {
        throw new Error(`property ${spec.code} defined as both ${existing.valueKind} and ${spec.valueKind}`);
      }
      return existing.id;
    }
    if (!FHIR_TYPES.has(spec.fhirType)) throw new Error(`property ${spec.code}: bad fhirType ${spec.fhirType}`);
    if (spec.valueKind !== 'concept' && spec.valueKind !== 'literal') throw new Error(`property ${spec.code}: bad valueKind`);
    const def = {
      id: this.properties.length + 1, code: spec.code, uri: spec.uri ?? null, fhirType: spec.fhirType,
      valueKind: spec.valueKind, isHierarchy: spec.isHierarchy ? 1 : 0, display: spec.display ?? null,
    };
    this.properties.push(def);
    this.propertyByCode.set(spec.code, def);
    return def.id;
  }

  // ---- concepts ------------------------------------------------------------------------

  /** Add a concept; returns its provisional index. Re-adding a code returns the existing index. */
  concept(code, { active = true, display = null, definition = null, sortKey = 0 } = {}) {
    const known = this.index.get(code);
    if (known !== undefined) return known;
    const i = this.codes.length;
    this.codes.push(code);
    this.index.set(code, i);
    this.active.push(active ? 1 : 0);
    this.display.push(display);
    this.definition.push(definition);
    this.sortKey.push(sortKey);
    return i;
  }

  idx(code) { return this.index.get(code); }
  setActive(i, active) { this.active[i] = active ? 1 : 0; }
  setDisplay(i, display) { this.display[i] = display; }
  setDefinition(i, definition) { this.definition[i] = definition; }
  setSortKey(i, key) { this.sortKey[i] = key; }

  /**
   * The concept's place in the built-in importer's key order (LOINC: the CodeKey that
   * import-loinc.module.js gives it), kept in concept_order for the orders the built-in provider
   * lists results in: kind is its group (cs-loinc.js Codes.Type), seq its place (a later call
   * replaces an earlier one, as a re-inserted code takes the later key). None for most systems
   */
  setSourceOrder(i, kind, seq) {
    if (!this.sourceOrder) this.sourceOrder = new Map();
    this.sourceOrder.set(i, [kind, seq]);
  }
  hasSourceOrder(i) { return !!this.sourceOrder && this.sourceOrder.has(i); }
  /**
   * One of a concept's parent or child relations, in the order the built-in provider lists them
   * (LOINC: import-loinc.module.js's Relationships rows), stored as system_order hier_start / hier
   * (tx/sqlite-v2/orders.js). Call in that order; the caller gives each relation once
   */
  hierarchyEntry(i, other, isChild) {
    if (!this.hierEntries) this.hierEntries = { xs: [], others: [], child: [] };
    this.hierEntries.xs.push(i); this.hierEntries.others.push(other); this.hierEntries.child.push(isChild ? 1 : 0);
  }
  /** the concept's place in the built-in provider's whole-system order (LOINC), in concept_order.walk */
  setSourceWalk(i, walk) {
    if (!this.sourceWalk) this.sourceWalk = new Map();
    this.sourceWalk.set(i, walk);
  }

  // ---- facts ---------------------------------------------------------------------------

  /** use = { system, code, display } or null */
  /** Returns the designation's staging id (for acceptability), or null if the term is empty. */
  designation(i, { language = null, use = null, term, active = true, preferred = false }) {
    if (term === null || term === undefined || term === '') return null;
    let useId = null;
    if (use) {
      const k = `${use.system || ''}|${use.code}`;
      let u = this.uses.get(k);
      if (!u) this.uses.set(k, u = { id: this.uses.size + 1, system: use.system || null, code: use.code, display: use.display ?? null });
      useId = u.id;
    }
    const id = this.ins.designation.run(i, language, useId, term, active ? 1 : 0, preferred ? 1 : 0).lastInsertRowid;
    this._count('designations');
    this._tick();
    return Number(id);
  }

  /**
   * @param {{group?: number, active?: boolean, seq?: number}} [opts] seq: the link's place in the
   *   release (SNOMED CT: its row in the relationship file), kept in link_order for the orders the
   *   built-in provider lists links in; none for a link without one
   */
  link(source, propertyId, target, { group = 0, active = true, seq = null } = {}) {
    this.ins.link.run(source, propertyId, group, target, active ? 1 : 0, seq);
    if (seq != null) this.linkSeqs = true;
    this._count('links');
    this._tick();
  }

  literal(source, propertyId, value, { group = 0, active = true } = {}) {
    if (value === null || value === undefined || value === '') return;
    const def = this.properties[propertyId - 1];
    let v = value;
    switch (def.fhirType) {
      case 'integer': case 'decimal': {
        const num = Number(value);
        if (Number.isNaN(num)) throw new Error(`property ${def.code}: '${value}' is not a number`);
        v = num;
        break;
      }
      case 'boolean':
        v = (value === true || value === 'true' || value === '1' || value === 1 || value === 'Y') ? 1 : 0;
        break;
      default:
        v = String(value);
    }
    this.ins.literal.run(source, propertyId, group, v, active ? 1 : 0);
    this._count('literals');
    this._tick();
  }

  /** Language refset acceptability of a designation (its staging id from designation()). */
  acceptability(designation, refset, acceptability) {
    // Kept in memory (3 ints per row) and written sorted in the final stage.
    const a = this.accept;
    if (a.n === a.d.length) for (const k of ['d', 'r', 'v']) { const x = new Int32Array(a.n * 2); x.set(a[k]); a[k] = x; }
    a.d[a.n] = designation; a.r[a.n] = refset; a.v[a.n] = acceptability; a.n++;
    this._count('acceptability');
  }

  /** Field layout of a refset whose rows carry extra columns. */
  refsetDef(refset, names, types) {
    if (!this.refsetDefs.has(refset)) this.refsetDefs.set(refset, { names, types });
  }

  /** Active refset member; fields = array of extra column values or null (membership only). */
  /**
   * Active refset member; fields = array of extra column values or null (membership only);
   * meta = { time: YYYYMMDD, module: staging index of the row's module } when the source has them.
   * Rows keep the order they arrive in (seq): the RF2 row order.
   */
  refsetMember(refset, concept, fields = null, meta = null) {
    this._refsetSeq = (this._refsetSeq || 0) + 1;
    const time = meta && meta.time != null && /^\d{8}$/.test(String(meta.time)) ? Number(meta.time) : null;
    this.ins.refset.run(refset, concept, fields ? JSON.stringify(fields) : null, time, meta && meta.module != null ? meta.module : null, this._refsetSeq);
    this._count('refsetMembers');
    this._tick();
  }

  /** Explicit (descendant, ancestor) pair. If any are given they define the descendant sets. */
  ancestor(descendant, ancestor) {
    this.ins.ancestor.run(descendant, ancestor);
    this._tick();
  }

  externalMap(i, { system, version = null, code, display = null, equivalence = 'equivalent' }) {
    this.ins.extmap.run(i, system, version, code, display, equivalence);
    this._count('externalMaps');
    this._tick();
  }

  alternateIdentifier(i, scheme, identifier) {
    this.ins.altid.run(i, scheme, identifier);
    this._count('alternateIdentifiers');
    this._tick();
  }

  // ---- the shared final stage ----------------------------------------------------------

  // Per-stage wall time, rows (when the stage returns a row count) and peak RSS so far.
  _record(name, t, r) {
    const rec = { s: (Date.now() - t) / 1000, peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) };
    if (typeof r === 'number') rec.rows = r;
    this.timings[name] = rec;
    this.log(`  ${name}: ${rec.s.toFixed(1)} s${rec.rows !== undefined ? `, ${rec.rows.toLocaleString()} rows` : ''}, peak RSS ${rec.peakRssMiB} MiB`);
  }

  _time(name, fn) {
    const t = Date.now();
    const r = fn();
    this._record(name, t, r);
    return r;
  }

  /** Time an importer (parse) stage; fn may be async and may return a row count. */
  async stage(name, fn) {
    const t = Date.now();
    const r = await fn();
    this._record(name, t, typeof r === 'number' ? r : undefined);
    return r;
  }

  /**
   * designation.rank (v5), so a reader need not read acceptability to order designations:
   * 0 = a designation of use rank.use that is preferred (rank.preferred) in one of rank.refsets,
   * 1 = one preferred in another language refset, 2 = any other. SNOMED CT sets it
   * (applySnomedConfig: synonym, preferred, the display refsets); the engine's display order
   * (tx/sqlite-v2/snomed.js) reads it, or acceptability in files without it. Written with the
   * rows (a staged flag per preferred designation), so the table stays packed. Returns the SQL
   * expression for the rank and the join it needs, or NULL.
   */
  _stageDesignationRank(db) {
    const r = this.designationRank;
    if (!r) return { expr: 'NULL', join: '' };
    const use = this.uses.get(`${r.useSystem || ''}|${r.useCode}`);
    const pref = this.index.get(String(r.preferred));
    const display = new Set(r.refsets.map((c) => this.index.get(String(c))).filter((x) => x !== undefined));
    const flag = new Uint8Array(this.counts.designations + 2); // 2 = preferred in a display refset, 1 = in another
    const { d, r: refset, v } = this.accept;
    for (let k = 0; k < this.accept.n; k++) {
      if (v[k] !== pref) continue;
      const f = display.has(refset[k]) ? 2 : 1;
      if (f > flag[d[k]]) flag[d[k]] = f;
    }
    db.exec('CREATE TABLE st.s_drank (stage_id INTEGER PRIMARY KEY, flag INTEGER NOT NULL)');
    const ins = db.prepare('INSERT INTO st.s_drank VALUES (?, ?)');
    for (let i = 0; i < flag.length; i++) if (flag[i]) ins.run(i, flag[i]);
    return {
      expr: `CASE WHEN d.use_id IS NOT ${use ? use.id : 'NULL'} THEN 2 WHEN f.flag = 2 THEN 0 WHEN f.flag = 1 THEN 1 ELSE 2 END`,
      join: 'LEFT JOIN st.s_drank f ON f.stage_id = d.id',
    };
  }

  /**
   * Number, rewrite, build sets, index, verify, record provenance. Returns a summary.
   * @param {object} [extra] importer stats to record in provenance
   */
  finish(extra = {}) {
    if (!this.codeSystem) throw new Error('setCodeSystem() was not called');
    this.st.exec('COMMIT');
    this.timings.parse = { s: (Date.now() - this.t0) / 1000, peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) };
    const n = this.codes.length;
    this.log(`Final stage: ${n.toLocaleString()} concepts`);

    // 1. numbering ------------------------------------------------------------------------
    const hier = this.properties.filter(p => p.isHierarchy).map(p => p.id);
    const [childOf, parentOf] = hier.length
      ? intPairs(this.st.prepare(`SELECT src, tgt FROM s_link WHERE active = 1 AND prop IN (${hier.join(',')})`))
      : [new Int32Array(0), new Int32Array(0)];
    const num = this._time('number', () => numberConcepts({
      codes: this.codes, active: Uint8Array.from(this.active), childOf, parentOf,
      sortKey: Float64Array.from(this.sortKey),
    }));
    const { idOf, order, activeCount } = num;

    // 2. rewrite --------------------------------------------------------------------------
    const db = new Database(this.dest);
    this.db = db;
    db.pragma('page_size = 4096');
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    db.pragma('cache_size = -400000');
    const ddl = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const [tablesDdl, indexDdl] = ddl.split(/^-- @indexes.*$/m);
    db.exec(tablesDdl);
    this.st.close();
    db.prepare('ATTACH DATABASE ? AS st').run(this.stagePath);

    const run = (name, sql) => this._time(`rewrite ${name}`, () => db.prepare(sql).run().changes);
    {
      db.exec('BEGIN');
      db.exec('CREATE TABLE st.s_map (old INTEGER PRIMARY KEY, new INTEGER NOT NULL)');
      const insMap = db.prepare('INSERT INTO st.s_map VALUES (?, ?)');
      for (let i = 0; i < n; i++) insMap.run(i, idOf[i]);

      const cs = this.codeSystem;
      db.prepare(`INSERT INTO code_system (id, uri, version, name, title, description, release_date, edition, content,
        concept_count, active_count) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        cs.uri, cs.version, cs.name ?? null, cs.title ?? null, cs.description ?? null, cs.releaseDate ?? null,
        cs.edition ?? null, cs.content, n, activeCount);
      const insCfg = db.prepare('INSERT INTO cs_config VALUES (?, ?)');
      for (const [k, v] of [...this.config].sort()) insCfg.run(k, v);
      const insProp = db.prepare('INSERT INTO property_def (property_id, code, uri, fhir_type, value_kind, is_hierarchy, display) VALUES (?,?,?,?,?,?,?)');
      for (const p of this.properties) insProp.run(p.id, p.code, p.uri, p.fhirType, p.valueKind, p.isHierarchy, p.display);
      const insUse = db.prepare('INSERT INTO designation_use VALUES (?,?,?,?)');
      for (const u of this.uses.values()) insUse.run(u.id, u.system, u.code, u.display);

      const insConcept = db.prepare('INSERT INTO concept VALUES (?,?,?,?,?)');
      this._time('rewrite concept', () => {
        for (let k = 0; k < n; k++) {
          const i = order[k];
          insConcept.run(k + 1, this.codes[i], this.active[i], this.display[i], this.definition[i]);
        }
        return n;
      });

      run('concept_link', `INSERT OR IGNORE INTO concept_link
        SELECT ms.new, l.prop, l.grp, mt.new, l.active FROM st.s_link l
        JOIN st.s_map ms ON ms.old = l.src JOIN st.s_map mt ON mt.old = l.tgt
        ORDER BY 1, 2, 3, 4, 5`);
      if (this.linkSeqs) {
        // the release order of the links (a link in several rows: its first), for the built-in
        // provider's orders (cs-snomed.js: parents, children and relationships in relationship-file
        // order). Only when the importer gave it (SNOMED CT from RF2)
        db.exec(`CREATE TABLE link_order (source_id INTEGER NOT NULL, property_id INTEGER NOT NULL, group_id INTEGER NOT NULL,
          target_id INTEGER NOT NULL, active INTEGER NOT NULL, seq INTEGER NOT NULL,
          PRIMARY KEY (source_id, property_id, group_id, target_id, active)) WITHOUT ROWID`);
        run('link_order', `INSERT INTO link_order
          SELECT ms.new, l.prop, l.grp, mt.new, l.active, MIN(l.seq) FROM st.s_link l
          JOIN st.s_map ms ON ms.old = l.src JOIN st.s_map mt ON mt.old = l.tgt
          WHERE l.seq IS NOT NULL GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4, 5`);
        db.exec('CREATE INDEX link_order_target ON link_order(target_id, property_id, seq)');
      }
      if (this.sourceOrder) {
        // the built-in importer's key order (LOINC), for the built-in provider's orders: filter
        // results by key, the whole system by kind then key. Only when the importer gave it
        // (walk: the place in the whole-system order, when the importer gave it)
        db.exec(`CREATE TABLE concept_order (concept_id INTEGER PRIMARY KEY, kind INTEGER NOT NULL, seq INTEGER NOT NULL, walk INTEGER)`);
        const insOrder = db.prepare('INSERT INTO concept_order VALUES (?, ?, ?, ?)');
        const walk = this.sourceWalk || new Map();
        this._time('rewrite concept_order', () => {
          for (const [i, [kind, seq]] of this.sourceOrder) insOrder.run(idOf[i], kind, seq, walk.get(i) ?? null);
          return this.sourceOrder.size;
        });
      }
      run('concept_literal', `INSERT OR IGNORE INTO concept_literal
        SELECT m.new, l.prop, l.grp, l.value, l.active FROM st.s_literal l
        JOIN st.s_map m ON m.old = l.src ORDER BY 1, 2, 3, 4, 5`);

      run('designation map', `CREATE TABLE st.s_dmap AS SELECT d.id AS stage_id,
          row_number() OVER (ORDER BY m.new, d.id) AS final_id
        FROM st.s_designation d JOIN st.s_map m ON m.old = d.concept`);
      db.exec('CREATE UNIQUE INDEX st.s_dmap_stage ON s_dmap(stage_id)');
      const rank = this._time('rewrite designation rank', () => this._stageDesignationRank(db));
      run('designation', `INSERT INTO designation (designation_id, concept_id, language, use_id, term, active, preferred, rank)
        SELECT dm.final_id, m.new, d.language, d.use_id, d.term, d.active, d.preferred, ${rank.expr}
        FROM st.s_designation d JOIN st.s_map m ON m.old = d.concept JOIN st.s_dmap dm ON dm.stage_id = d.id ${rank.join}
        ORDER BY dm.final_id`);
      if (this.accept.n) {
        this._time('rewrite designation_acceptability', () => {
          const final = new Int32Array(this.counts.designations + 1);
          for (const [st, fin] of db.prepare('SELECT stage_id, final_id FROM st.s_dmap').raw().iterate()) final[st] = fin;
          const { d, r, v } = this.accept;
          // counting sort by final designation id, so rows go in (nearly) key order
          const m = this.accept.n;
          const start = new Int32Array(final.length + 1);
          for (let k = 0; k < m; k++) start[final[d[k]] + 1]++;
          for (let i = 0; i < final.length; i++) start[i + 1] += start[i];
          const idx = new Int32Array(m);
          for (let k = 0; k < m; k++) idx[start[final[d[k]]]++] = k;
          const ins = db.prepare('INSERT OR IGNORE INTO designation_acceptability VALUES (?, ?, ?)');
          for (const k of idx) ins.run(final[d[k]], idOf[r[k]], idOf[v[k]]);
          return m;
        });
      }

      const insDef = db.prepare('INSERT INTO refset_def VALUES (?, ?, ?)');
      for (const [r, d] of this.refsetDefs) insDef.run(idOf[r], JSON.stringify(d.names), JSON.stringify(d.types));
      // every member row (simple refsets too, with fields []), with its effectiveTime, module and
      // RF2 order: ECL member filters read them, and rules are listed in the order they were given
      run('refset_member', `INSERT OR IGNORE INTO refset_member
        SELECT mr.new, mc.new, COALESCE(r.fields, '[]'), r.time, mm.new, r.seq FROM st.s_refset r
        JOIN st.s_map mr ON mr.old = r.refset JOIN st.s_map mc ON mc.old = r.concept
        LEFT JOIN st.s_map mm ON mm.old = r.module
        ORDER BY 1, 2, 3, 6`);
      run('external_map', `INSERT OR IGNORE INTO external_map
        SELECT m.new, e.system, e.version, e.code, e.display, e.equivalence FROM st.s_extmap e
        JOIN st.s_map m ON m.old = e.concept ORDER BY 1, 2, 4`);
      run('alternate_identifier', `INSERT OR IGNORE INTO alternate_identifier
        SELECT m.new, ms.new, a.identifier FROM st.s_altid a
        JOIN st.s_map m ON m.old = a.concept JOIN st.s_map ms ON ms.old = a.scheme ORDER BY 1, 2, 3`);
      db.exec('COMMIT');
    }

    // 3. sets -----------------------------------------------------------------------------
    const setStats = this._buildSets(n, activeCount, hier);

    // 4. search + indexes + checks ------------------------------------------------------
    db.exec('BEGIN');
    this._time('fts display', () => db.prepare(`INSERT INTO search_display(rowid, term) SELECT concept_id, display
      FROM concept WHERE display IS NOT NULL AND display <> ''`).run().changes);
    this._time('fts designation', () => db.prepare(
      'INSERT INTO search_designation(rowid, term) SELECT designation_id, term FROM designation').run().changes);
    db.exec('COMMIT');
    db.exec('DETACH DATABASE st');
    // a one-block file has each code once (concept() keeps the first): its code index is UNIQUE.
    // (Content files, several blocks in one file, keep schema-v2.sql's plain index.) A lookup by
    // code on a unique index stops at the match: 2.6 against 10 us for the row on SNOMED CT
    const oneBlockIndexes = indexDdl.replace('CREATE INDEX concept_code ON concept(code);', 'CREATE UNIQUE INDEX concept_code ON concept(code);');
    if (oneBlockIndexes === indexDdl) throw new Error('schema-v2.sql: the concept_code index is not where the builder expects it');
    this._time('indexes', () => db.exec(oneBlockIndexes));
    const checks = this._time('checks', () => this._check(n, activeCount, num));
    // the built-in providers' answer orders (LOINC, SNOMED CT), computed here once so that a
    // server reads them from the file (tx/sqlite-v2/orders.js), not from every row at load
    const orderKindHere = orderKind(dialectFor(this.codeSystem.uri).name);
    if (orderKindHere) this._time('system_order', () => writeOrder(db, computeOrder(db, orderKindHere, n)));
    // the built-in providers' text search data (SNOMED CT word index, RxNorm stems:
    // tx/sqlite-v2/text-index.js), so that a server does not build it in memory
    this._time('text index', () => {
      db.exec('BEGIN');
      const r = writeTextTables(db, dialectFor(this.codeSystem.uri).name, n);
      db.exec('COMMIT');
      return r ? r.words : 0;
    });
    if (this.hierEntries) {
      this._time('hierarchy order', () => {
        const { xs, others, child } = this.hierEntries;
        const arrays = hierarchyArrays(n, xs.map((i) => idOf[i]), others.map((i) => idOf[i]), child);
        db.exec('BEGIN');
        writeHierarchyOrder(db, arrays);
        db.exec('COMMIT');
        return xs.length;
      });
    }

    // 5. provenance -----------------------------------------------------------------------
    const tables = {};
    for (const t of ['concept', 'concept_link', 'concept_literal', 'designation', 'designation_acceptability',
      'refset_member', 'external_map', 'alternate_identifier', 'concept_set']) {
      tables[t] = db.prepare(`SELECT count(*) AS c FROM ${t}`).get().c;
    }
    const summary = {
      concepts: n, activeConcepts: activeCount, inactiveConcepts: n - activeCount,
      numbering: { roots: num.roots, reachedByWalk: num.reached, unreachedActive: num.unreached },
      tables, sets: setStats, checks, staged: this.counts, importer: extra,
    };
    this._time('hash', () => { for (const s of this.sources) s.sha256 = sha256File(s.path); });
    db.exec('ANALYZE');
    this.timings.total = (Date.now() - this.t0) / 1000;
    const insProv = db.prepare('INSERT INTO provenance VALUES (?, ?)');
    const prov = {
      schemaVersion: String(SCHEMA_VERSION),
      importer: this.importer,
      builtAt: new Date().toISOString(),
      node: process.version,
      sources: JSON.stringify(this.sources.map(s => ({ name: path.basename(s.path), size: s.size, sha256: s.sha256 }))),
      summary: JSON.stringify(summary),
      timings: JSON.stringify(this.timings),
      roaringFormat: 'portable',
    };
    for (const [k, v] of Object.entries(prov)) insProv.run(k, v);
    db.pragma('journal_mode = DELETE');
    db.close();
    fs.rmSync(this.stagePath, { force: true });
    summary.fileBytes = fs.statSync(this.dest).size;
    summary.timings = this.timings;
    this.log(`Done: ${this.dest} (${(summary.fileBytes / 1048576).toFixed(1)} MiB, ${this.timings.total.toFixed(0)} s)`);
    return summary;
  }

  _buildSets(n, activeCount, hier) {
    const db = this.db;
    const ins = db.prepare('INSERT INTO concept_set VALUES (?, ?, ?, ?, ?)');
    const stats = {};
    const out = [];
    const put = (kind, prop, value, bm) => {
      const card = bm.size;
      if (card === 0) return;
      const buf = serialize(bm);
      out.push([kind, prop, value, card, buf]); // written after the reads (one connection)
      const s = stats[kind] || (stats[kind] = { sets: 0, members: 0, bytes: 0 });
      s.sets++; s.members += card; s.bytes += buf.length;
    };
    db.exec('BEGIN');
    put(SET_KIND.all, 0, 0, rangeSet(1, n));
    put(SET_KIND.active, 0, 0, rangeSet(1, activeCount));

    // descendants: explicit pairs if the importer gave any, else the transitive closure of
    // the active hierarchy links.
    const tDesc = Date.now();
    const pairCount = db.prepare('SELECT count(*) AS c FROM st.s_ancestor').get().c;
    let res;
    if (pairCount > 0) {
      const [d, a] = intPairs(db.prepare(`SELECT md.new, ma.new FROM st.s_ancestor a
        JOIN st.s_map md ON md.old = a.descendant JOIN st.s_map ma ON ma.old = a.ancestor`));
      res = descendantsFromPairs(n, d, a);
      this.descendantSource = 'explicit-pairs';
    } else {
      const [c, p] = hier.length
        ? intPairs(db.prepare(`SELECT source_id, target_id FROM concept_link WHERE active = 1 AND property_id IN (${hier.join(',')})`))
        : [new Int32Array(0), new Int32Array(0)];
      res = descendantsFromEdges(n, c, p);
      this.descendantSource = 'hierarchy-closure';
    }
    this._record('sets descendants', tDesc, n);
    if (res.cyclic) throw new Error(`hierarchy has a cycle: ${res.cyclic} concepts could not be closed`);
    this.desc = res.desc;
    const leaf = new sets.RoaringBitmap32();
    for (let id = 1; id <= n; id++) {
      const d = res.desc[id];
      if (d) put(SET_KIND.descendants, 0, id, d);
      else if (id <= activeCount) leaf.add(id);
    }
    put(SET_KIND.leaf, 0, 0, leaf);

    const tProp = Date.now();
    // prop = value and hasProp, from the active fact rows.
    const has = new Map();
    const hasOf = (p) => { let b = has.get(p); if (!b) has.set(p, b = new sets.RoaringBitmap32()); return b; };
    for (const [table, src, val] of [['concept_link', 'source_id', 'target_id'], ['concept_literal', 'concept_id', 'value']]) {
      const it = db.prepare(`SELECT property_id, ${val}, ${src} FROM ${table} WHERE active = 1
        ORDER BY property_id, ${val}, ${src}`).raw().iterate();
      // Rows arrive grouped by (property, value); !== keeps 1 and '1' apart.
      let curP = null, curV, members = [];
      const flush = () => {
        if (curP === null) return;
        const bm = new sets.RoaringBitmap32(members);
        put(SET_KIND.prop, curP, curV, bm);
        hasOf(curP).orInPlace(bm);
        members = [];
      };
      for (const [p, v, s] of it) {
        if (p !== curP || v !== curV) { flush(); curP = p; curV = v; }
        members.push(s);
      }
      flush();
    }
    for (const [p, bm] of [...has].sort((a, b) => a[0] - b[0])) put(SET_KIND.hasProp, p, 0, bm);

    // refset membership (active members, any refset with concept members).
    const it = db.prepare(`SELECT mr.new, mc.new FROM st.s_refset r
      JOIN st.s_map mr ON mr.old = r.refset JOIN st.s_map mc ON mc.old = r.concept ORDER BY 1, 2`).raw().iterate();
    groupSorted(it, (refset, bm) => put(SET_KIND.refset, 0, refset, bm));
    this._record('sets prop/hasProp/refset', tProp, out.length);
    const tWrite = Date.now();
    for (const row of out) ins.run(...row);
    db.exec('COMMIT');
    this._record('sets write', tWrite, out.length);

    const names = Object.fromEntries(Object.entries(SET_KIND).map(([k, v]) => [v, k]));
    return Object.fromEntries(Object.entries(stats).map(([k, s]) => [names[k], s]));
  }

  _check(n, activeCount) {
    const db = this.db;
    const one = (sql) => db.prepare(sql).get();
    const fail = (msg) => { throw new Error(`integrity: ${msg}`); };
    if (one('SELECT count(*) AS c FROM concept').c !== n) fail('concept count');
    const badActive = one(`SELECT count(*) AS c FROM concept WHERE active <> (concept_id <= ${activeCount})`).c;
    if (badActive) fail(`${badActive} concepts break the active prefix`);
    const dupCode = one('SELECT code, count(*) AS c FROM concept GROUP BY code HAVING c > 1 LIMIT 1');
    if (dupCode) fail(`duplicate code ${dupCode.code}`);
    // Every descendant of an active concept has a larger id; count the exceptions (inactive ancestors).
    let ancestorOrderExceptions = 0;
    for (let id = 1; id <= n; id++) {
      const d = this.desc[id];
      if (d && d.minimum() <= id) {
        if (id <= activeCount) fail(`descendant of active ${id} numbered before it`);
        ancestorOrderExceptions++;
      }
    }
    return { activePrefix: true, uniqueCodes: true, inactiveAncestorsBeforeDescendants: ancestorOrderExceptions,
      descendantSource: this.descendantSource };
  }
}

// Stream a two-integer-column query into two Int32Arrays.
function intPairs(stmt) {
  let a = new Int32Array(1 << 16), b = new Int32Array(1 << 16), n = 0;
  for (const [x, y] of stmt.raw().iterate()) {
    if (n === a.length) {
      const a2 = new Int32Array(n * 2); a2.set(a); a = a2;
      const b2 = new Int32Array(n * 2); b2.set(b); b = b2;
    }
    a[n] = x; b[n] = y; n++;
  }
  return [a.slice(0, n), b.slice(0, n)];
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.allocUnsafe(1 << 22);
  try {
    let r;
    while ((r = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, r));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

module.exports = { V2Builder, SCHEMA_VERSION };
