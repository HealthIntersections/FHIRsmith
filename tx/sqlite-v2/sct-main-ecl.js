'use strict';

// ECL that the sqlite-v2 engine does not evaluate itself (some group/attribute cardinality
// combinations, alternate identifiers, attribute-name sets, member filters on older files), evaluated
// by main's own ECL code (tx/cs/cs-snomed.js) over a sqlite-v2 file: the binary structures main's
// ECL reads (tx/sct/structures.js) are replaced by read-through views of the store that answer the
// same calls. Post-coordination does not come here: it is native (sct-native.js).
//
// Built per call: what it reads stays in this call's memo maps. Main's ECL evaluation is async
// (1.0.5), and the engine compiles synchronously, so the result is evaluated first and kept per
// file (resolveMainEcl: the file is read-only, so a result never goes stale); the compiler then
// reads it (mainEclResult). A compile that needs one not evaluated yet throws NeedsMainEcl, which
// the provider's async entry points answer by evaluating it and compiling again
// (provider.js _compiled).
//
// Addresses: a concept's "index" is (concept_id - 1) * 56, as main's fixed-size records;
// a description's is designation_id * 40; a relationship gets an index the first time it is read.
// Lists (main's refs) and strings are handles allocated on demand.

const { SnomedServices } = require('../cs/cs-snomed');
const { SnomedExpressionServices } = require('../sct/expressions');
const { SnomedTextIndexes } = require('../sct/text-index');
const { KIND } = require('./store');
const { RoaringBitmap32 } = require('roaring');
// a description's language, as main's language byte (the one table, shared with main's importer)
const { languageByte } = require('../sct/languages');

const CONCEPT_SIZE = 56;
const DESC_SIZE = 40;
const REL_SIZE = 40;
const NO = 0xFFFFFFFF;
const IS_A = '116680003';
const PRIMITIVE = '900000000000074008';
const INFERRED = '900000000000011006';
const IDENTIFIER_SCHEME_TYPES = { c: 1, i: 4, s: 5 };

/** handles for main's list (refs) and string offsets: numbers, resolved lazily */
class Handles {
  constructor() {
    this.next = 16;
    this.thunks = new Map();
    this.values = new Map();
  }

  value(v) {
    const h = this.next;
    this.next += 4;
    this.values.set(h, v);
    return h;
  }

  lazy(thunk) {
    const h = this.next;
    this.next += 4;
    this.thunks.set(h, thunk);
    return h;
  }

  get(h) {
    if (this.values.has(h)) return this.values.get(h);
    const t = this.thunks.get(h);
    if (!t) throw new Error(`sqlite-v2 adapter: unknown handle ${h}`);
    const v = t();
    this.thunks.delete(h);
    this.values.set(h, v);
    return v;
  }
}

/** the store, read as main's structures */
class V2View {
  constructor(store) {
    this.store = store;
    this.h = new Handles();
    this.rows = new Map();      // concept_id -> row (+ facts)
    this.idByCode = new Map();
    this.rels = [];             // relationship records; index = (position + 1) * REL_SIZE
    this.relKey = new Map();
    this.desc = new Map();      // designation_id -> record
    const p = store.props;
    this.isAProp = p.get(IS_A);
    this.moduleProp = p.get('module');
    this.defStatusProp = p.get('definitionStatusId');
    this.timeProp = p.get('effectiveTime');
    // attribute properties are the ones named by a concept id
    this.attrProps = new Map();
    for (const [code, def] of p) if (/^\d+$/.test(code) && def.kind === 'concept') this.attrProps.set(def.id, code);
    this.literalAttrProps = new Map();
    for (const [code, def] of p) if (/^\d+$/.test(code) && def.kind !== 'concept') this.literalAttrProps.set(def.id, code);
  }

  /** the reference sets a concept belongs to (concept indexes), from the stored refset sets */
  refsetsOf(id) {
    if (!this.refsetSets) {
      const S = this.store;
      const rids = S.stmt('SELECT value FROM concept_set WHERE kind = ? AND property_id = 0').pluck().all(KIND.refset);
      this.refsetSets = [...S.loadSets(KIND.refset, 0, rids)];
    }
    return this.refsetSets.filter(([, bm]) => bm.has(id)).map(([rid]) => this.idx(rid));
  }

  idx(id) { return (id - 1) * CONCEPT_SIZE; }
  idOf(index) { return index / CONCEPT_SIZE + 1; }

  conceptId(code) {
    const c = String(code);
    if (!this.idByCode.has(c)) this.idByCode.set(c, this.store.idOf(c));
    return this.idByCode.get(c);
  }

  /** concept row and its facts, read once per request */
  facts(id) {
    let f = this.rows.get(id);
    if (f) return f;
    const S = this.store;
    const row = S.conceptRows([id]).get(id);
    if (!row) throw new Error(`sqlite-v2 adapter: no concept ${id}`);
    const links = S.linksFrom([id], null, false);
    const lits = S.literalsOf([id], false);
    f = { row, links, lits };
    this.rows.set(id, f);
    return f;
  }

  code(id) { return this.facts(id).row.code; }

  relIndex(source, pid, group, target, active) {
    const key = source + ':' + pid + ':' + group + ':' + target + ':' + active;
    let i = this.relKey.get(key);
    if (i === undefined) {
      this.rels.push({ source, pid, group, target, active });
      i = this.rels.length * REL_SIZE;
      this.relKey.set(key, i);
    }
    return i;
  }

  relationship(index) {
    const r = this.rels[index / REL_SIZE - 1];
    if (!r) throw new Error('Wrong length index getting snomed relationship Details');
    const type = this.conceptId(this.attrProps.get(r.pid));
    const inferred = this.conceptId(INFERRED);
    return {
      source: this.idx(r.source), target: this.idx(r.target), relType: type ? this.idx(type) : 0,
      module: 0, kind: inferred ? this.idx(inferred) : 0, modifier: 0, date: 0,
      active: !!r.active, defining: true, group: r.group, identity: 0n
    };
  }

  /** designation record (main's description) */
  description(did) {
    let d = this.desc.get(did);
    if (d) return d;
    const S = this.store;
    const r = S.stmt('SELECT designation_id, concept_id, language, use_id, term, active FROM designation WHERE designation_id = ?').get(did);
    if (!r) throw new Error('Wrong length index getting snomed Desc Details');
    const acc = S.hasAcceptability ? S.stmt('SELECT refset_id, acceptability_id FROM designation_acceptability WHERE designation_id = ?').all(did) : [];
    const use = r.use_id != null ? S.uses.get(r.use_id) : null;
    const useId = use ? this.conceptId(use.code) : null;
    const lang = String(r.language || 'en').toLowerCase().split('-')[0];
    d = {
      iDesc: this.h.value(r.term), active: !!r.active, id: BigInt(r.designation_id), concept: this.idx(r.concept_id),
      module: 0, kind: useId ? this.idx(useId) : 0, caps: 0, date: 0, lang: languageByte(lang) || 1,
      refsets: acc.length ? this.h.value(acc.map((a) => this.idx(a.refset_id))) : 0,
      valueses: acc.length ? this.h.value(acc.map((a) => this.h.value([this.idx(a.acceptability_id), 1]))) : 0
    };
    this.desc.set(did, d);
    return d;
  }

  effectiveTime(lits) {
    const t = this.timeProp && lits.find((l) => l.p === this.timeProp.id);
    if (!t) return 0;
    const s = String(t.v).replace(/-/g, '');
    if (!/^\d{8}$/.test(s)) return 0;
    const d = Date.UTC(+s.substring(0, 4), +s.substring(4, 6) - 1, +s.substring(6, 8));
    return Math.round((d - Date.UTC(1899, 11, 30)) / 86400000);
  }
}

// ---- main's structure interfaces over the view ---------------------------------------------

function strings(v) {
  return { getEntry: (h) => String(v.h.get(h)) };
}

function refs(v) {
  return {
    getReferences: (h) => (h === 0 || h === NO || h == null ? null : v.h.get(h)),
    getLength: (h) => (h === 0 || h === NO || h == null ? 0 : (v.h.get(h) || []).length)
  };
}

function concepts(v) {
  const S = v.store;
  const self = {
    findConcept(identity) {
      const id = v.conceptId(String(identity));
      return id == null ? { found: false, index: 0 } : { found: true, index: v.idx(id) };
    },
    count() { return S.conceptCount; },
    getConceptByCount(ord) { return self.getConcept(ord * CONCEPT_SIZE); },
    conceptExists(index) { return index >= 0 && index % CONCEPT_SIZE === 0 && v.idOf(index) <= S.conceptCount; },
    getConcept(index) {
      const id = v.idOf(index);
      const f = v.facts(id);
      const prim = v.defStatusProp && f.links.some((l) => l.p === v.defStatusProp.id && v.code(l.t) === PRIMITIVE);
      return {
        index, identity: BigInt(f.row.code),
        flags: (f.row.active ? 0 : 1) | (prim ? 0x10 : 0),
        parents: self.getParent(index),
        descriptions: self.getDescriptions(index),
        inbounds: self.getInbounds(index),
        outbounds: self.getOutbounds(index),
        effectiveTime: v.effectiveTime(f.lits),
        refsets: self.getRefsets(index)
      };
    },
    getConceptId(index) { return BigInt(v.code(v.idOf(index))); },
    getIdentity(index) { return BigInt(v.code(v.idOf(index))); },
    getParent(index) {
      const id = v.idOf(index);
      // as main: 0 when there are none (callers read 0 as "no parents")
      const ps = v.facts(id).links.filter((l) => v.isAProp && l.p === v.isAProp.id && l.active).map((l) => v.idx(l.t));
      return ps.length ? v.h.value(ps) : 0;
    },
    getDescriptions(index) {
      const id = v.idOf(index);
      return v.h.lazy(() => S.stmt('SELECT designation_id FROM designation WHERE concept_id = +? ORDER BY designation_id').pluck().all(id).map((d) => d * DESC_SIZE));
    },
    getOutbounds(index) {
      const id = v.idOf(index);
      return v.h.lazy(() => v.facts(id).links.filter((l) => v.attrProps.has(l.p)).map((l) => v.relIndex(id, l.p, l.g || 0, l.t, l.active ? 1 : 0)));
    },
    getInbounds(index) {
      const id = v.idOf(index);
      return v.h.lazy(() => S.stmt('SELECT source_id, property_id, group_id, active FROM concept_link WHERE target_id = ?').all(id)
        .filter((r) => v.attrProps.has(r.property_id)).map((r) => v.relIndex(r.source_id, r.property_id, r.group_id, id, r.active)));
    },
    getAllDesc(index) {
      const id = v.idOf(index);
      return v.h.lazy(() => {
        const bm = S.loadSets(KIND.descendants, 0, [id]).get(id);
        return bm ? bm.toArray().map((d) => v.idx(d)) : [];
      });
    },
    getDepth(index) {
      // ancestors along the longest is-a path (main stores the depth at import)
      let depth = 0;
      let frontier = [v.idOf(index)];
      const seen = new Set();
      while (frontier.length && depth < 64) {
        const next = [];
        for (const id of frontier) {
          for (const l of v.facts(id).links) if (v.isAProp && l.p === v.isAProp.id && l.active && !seen.has(l.t)) { seen.add(l.t); next.push(l.t); }
        }
        if (!next.length) break;
        depth++;
        frontier = next;
      }
      return depth;
    },
    getModuleId(index) {
      const f = v.facts(v.idOf(index));
      const m = v.moduleProp && f.links.find((l) => l.p === v.moduleProp.id);
      return m ? v.idx(m.t) : 0;
    },
    getStatus(index) { return v.facts(v.idOf(index)).row.active ? 0 : 1; },
    getRefsets(index) {
      const id = v.idOf(index);
      return v.h.lazy(() => v.refsetsOf(id));
    },
    getNormalForm() { return 0; }, // ECL never reads normal forms (expressions do: sct-native.js)
    getStems() { return 0; }
  };
  return self;
}

function relationships(v) {
  return {
    getRelationship: (index) => v.relationship(index),
    // the fields relationship matching needs (main's getRelationshipCore, 1.0.5)
    getRelationshipCore: (index) => {
      const r = v.relationship(index);
      return { source: r.source, target: r.target, relType: r.relType, active: r.active, group: r.group };
    },
    // main's getConceptRelationships keeps active rows only (cs-snomed.js, #331)
    isActive: (index) => v.relationship(index).active,
    count: () => v.rels.length
  };
}

function descriptions(v) {
  return {
    count: () => 0,
    getDescription: (index) => v.description(index / DESC_SIZE),
    conceptByIndex: (index) => v.description(index / DESC_SIZE).concept
  };
}

function descriptionIndex() {
  // description SCTIDs are not kept in sqlite-v2 files
  return { findDescription: () => ({ found: false, index: 0 }), count: () => 0 };
}

/** reference sets: one record per refset in refset_def or refset_member, members sorted by ref */
function refSetIndexAndMembers(v) {
  const S = v.store;
  let list = null;
  const load = () => {
    if (list) return list;
    const defs = new Map(S.stmt('SELECT refset_id, field_names, field_types FROM refset_def').all().map((r) => [r.refset_id, r]));
    const ids = S.stmt('SELECT DISTINCT refset_id FROM refset_member').pluck().all();
    for (const id of defs.keys()) if (!ids.includes(id)) ids.push(id);
    // simple reference sets are kept only as stored sets (concept_set kind refset)
    for (const id of S.stmt('SELECT value FROM concept_set WHERE kind = ? AND property_id = 0').pluck().all(KIND.refset)) if (!ids.includes(id)) ids.push(id);
    const md = S.config.moduleDependencies;
    list = ids.sort((a, b) => a - b).map((rid) => {
      const def = defs.get(rid);
      const names = def ? JSON.parse(def.field_names) : [];
      const types = def ? JSON.parse(def.field_types) : [];
      const code = v.code(rid);
      return {
        definition: v.idx(rid), filename: v.h.value(''), name: v.h.value(nameFor(code, names)),
        fieldTypes: v.h.value(types.map((t) => IDENTIFIER_SCHEME_TYPES[t] || 5)),
        fieldNames: names.length ? v.h.value(names.map((n) => v.h.value(n))) : 0,
        membersByRef: v.h.lazy(() => members(rid, names, types)),
        membersByName: NO, langs: 0
      };
    });
    if (md && md.length) {
      // module dependencies (cs_config): main's ModuleDependency refset, members by the row's module
      list.push({
        definition: NO, filename: v.h.value(''), name: v.h.value('ModuleDependency'), fieldTypes: v.h.value([5, 5]),
        fieldNames: v.h.value([v.h.value('sourceEffectiveTime'), v.h.value('targetEffectiveTime')]),
        membersByRef: v.h.lazy(() => md.map(([module, ref, se, te]) => {
          const m = v.conceptId(module);
          const r = v.conceptId(ref);
          return r ? { id: null, module: m ? v.idx(m) : 0, date: null, kind: 0, ref: v.idx(r), values: v.h.value([v.h.value(se || ''), 5, v.h.value(te || ''), 5]) } : null;
        }).filter(Boolean).sort((a, b) => a.ref - b.ref)),
        membersByName: NO, langs: 0
      });
    }
    return list;
  };
  const members = (rid, names, types) => {
    // v4 files keep each row's effectiveTime, module and RF2 order
    const v4 = S.stmt("SELECT 1 FROM pragma_table_info('refset_member') WHERE name = 'seq'").get();
    let rows = v4
      ? S.stmt('SELECT concept_id, fields, effective_time, module_id FROM refset_member WHERE refset_id = ? ORDER BY seq').all(rid)
      : S.stmt('SELECT concept_id, fields FROM refset_member WHERE refset_id = ?').all(rid);
    if (!rows.length) {
      const bm = S.loadSets(KIND.refset, 0, [rid]).get(rid);
      rows = bm ? bm.toArray().map((c) => ({ concept_id: c, fields: '[]' })) : [];
    }
    const out = [];
    for (const r of rows) {
      const fields = JSON.parse(r.fields || '[]');
      const vals = [];
      fields.forEach((x, i) => {
        const t = types[i];
        if (t === 'c') { const c = v.conceptId(x); vals.push(c ? v.idx(c) : 0, 1); }
        else if (t === 'i') vals.push(Number(x), 4);
        else vals.push(v.h.value(String(x)), 5);
      });
      const mod = r.module_id != null ? v.idx(r.module_id) : null;
      out.push({ id: null, module: mod, date: r.effective_time != null ? daysOf(String(r.effective_time)) : null, kind: 0, ref: v.idx(r.concept_id), values: vals.length ? v.h.value(vals) : 0 });
    }
    out.sort((a, b) => a.ref - b.ref); // stable: rows for one concept stay in RF2 order
    return out;
  };
  const index = {
    count: () => load().length,
    getReferenceSet: (i) => { const r = load()[i]; if (!r) throw new Error('Wrong length index getting snomed relationship Details'); return r; },
    getRefSetByConcept: (conceptIndex) => load().findIndex((r) => r.definition === conceptIndex),
    getMembersByConcept: (conceptIndex, byName = false) => { const r = load().find((x) => x.definition === conceptIndex); return r ? (byName ? r.membersByName : r.membersByRef) : 0; }
  };
  const mem = {
    getMembers: (h) => (h === NO || h === 0 || h == null ? null : v.h.get(h)),
    getMemberCount: (h) => (h === NO || h === 0 || h == null ? 0 : (v.h.get(h) || []).length)
  };
  return { index, mem };
}

/** YYYYMMDD -> main's stored date (days since 1899-12-30) */
function daysOf(s) {
  const t = String(s).replace(/-/g, '');
  if (!/^\d{8}$/.test(t)) return null;
  return Math.round((Date.UTC(+t.substring(0, 4), +t.substring(4, 6) - 1, +t.substring(6, 8)) - Date.UTC(1899, 11, 30)) / 86400000);
}

function nameFor(code, names) {
  if (code === '900000000000534007') return 'ModuleDependency';
  return names.length ? 'cRefset' : 'Refset';
}

// ---- main's services and provider over the view --------------------------------------------

/**
 * SnomedServices (main) answering from a sqlite-v2 file. Built for one request.
 * @param {import('./snomed').SnomedV2Factory} factory
 */
function servicesFor(factory) {
  const store = factory.store;
  if (!factory.version) factory = { store, version: () => store.version, edition: () => store.cs.edition };
  const v = new V2View(store);
  // a real (empty) instance, for its class-field methods; its structures are replaced below
  const sv = new SnomedServices({ identifiers: [], concreteValues: null, textIndexes: noTextIndexes() });
  sv.strings = strings(v);
  sv.words = { getEntry: () => null, getString: () => '', count: () => 0 };
  sv.stems = { getEntry: () => null, getString: () => '', count: () => 0 };
  sv._textIndex = null;
  sv._textIndexPromise = null;
  sv.refs = refs(v);
  sv.descriptions = descriptions(v);
  sv.descriptionIndex = descriptionIndex();
  sv.concepts = concepts(v);
  sv.relationships = relationships(v);
  const rs = refSetIndexAndMembers(v);
  sv.refSetIndex = rs.index;
  sv.refSetMembers = rs.mem;
  sv.versionUri = factory.version();
  const vd = /\/version\/(\d{8})$/.exec(sv.versionUri);
  sv.versionDate = vd ? vd[1] : null;
  sv.edition = factory.edition();
  sv.version = vd ? vd[1] : null;
  sv.totalCount = store.conceptCount;
  const isa = v.conceptId(IS_A);
  sv.isAIndex = isa ? v.idx(isa) : 0;
  const root = v.conceptId('138875005');
  sv.activeRoots = root ? [v.idx(root)] : [];
  sv.inactiveRoots = [];
  sv.defaultLanguage = languageByte(store.config.defaultLanguage) || 1;
  sv.isTesting = /\/xsct\//.test(sv.versionUri);
  sv.expressionServices = new SnomedExpressionServices({
    strings: sv.strings, words: sv.words, stems: sv.stems, refs: sv.refs, descriptions: sv.descriptions,
    descriptionIndex: sv.descriptionIndex, concepts: sv.concepts, relationships: sv.relationships,
    refSetMembers: sv.refSetMembers, refSetIndex: sv.refSetIndex
  }, sv.isAIndex);
  // whole-edition enumerations come from the stored sets, without reading each concept
  sv._eclEnumerateAllConcepts = () => store.all().toArray().map((id) => v.idx(id));
  sv.activeConceptCount = () => store.active().size;
  // read when first used
  lazyField(sv, ['identifiersByConcept', 'conceptsByIdentifier', 'identifierModules'], () => loadIdentifiers(sv, v));
  lazyField(sv, ['concreteValues'], () => loadConcreteValues(sv, v));
  return sv;
}

function lazyField(obj, names, load) {
  let done = false;
  for (const n of names) {
    Object.defineProperty(obj, n, {
      configurable: true, enumerable: true,
      get() {
        if (!done) { done = true; for (const m of names) Object.defineProperty(obj, m, { value: undefined, writable: true, configurable: true, enumerable: true }); load(); }
        return obj[n];
      },
      set(x) { Object.defineProperty(obj, n, { value: x, writable: true, configurable: true, enumerable: true }); }
    });
  }
}

/** main's #loadIdentifiers, from alternate_identifier (the module is the concept's) */
function loadIdentifiers(sv, v) {
  sv.identifiersByConcept = new Map();
  sv.conceptsByIdentifier = new Map();
  sv.identifierModules = new Map();
  const S = v.store;
  for (const r of S.stmt('SELECT concept_id, scheme_id, identifier FROM alternate_identifier').all()) {
    const conceptId = v.code(r.concept_id);
    const scheme = v.code(r.scheme_id);
    const modIdx = sv.concepts.getModuleId(v.idx(r.concept_id));
    const module = modIdx ? String(sv.concepts.getConceptId(modIdx)) : '';
    const entry = { scheme, module, code: r.identifier };
    if (!sv.identifiersByConcept.has(conceptId)) sv.identifiersByConcept.set(conceptId, []);
    sv.identifiersByConcept.get(conceptId).push(entry);
    const key = scheme + '|' + r.identifier;
    if (!sv.conceptsByIdentifier.has(key)) sv.conceptsByIdentifier.set(key, []);
    sv.conceptsByIdentifier.get(key).push(conceptId);
    if (!sv.identifierModules.has(module)) sv.identifierModules.set(module, new Set());
    sv.identifierModules.get(module).add(scheme);
  }
}

/** main's #loadConcreteValues, from the concept literals of attribute properties */
function loadConcreteValues(sv, v) {
  sv.concreteValues = new Map();
  const S = v.store;
  if (!v.literalAttrProps.size) return;
  const pids = [...v.literalAttrProps.keys()];
  const rows = S.stmt(`SELECT concept_id, property_id, group_id, value FROM concept_literal WHERE active = 1 AND property_id IN (${pids.map(() => '?').join(',')})`).all(...pids);
  for (const r of rows) {
    const type = v.conceptId(v.literalAttrProps.get(r.property_id));
    if (!type) continue;
    let value;
    if (typeof r.value === 'number') value = { kind: 'number', value: r.value, decimal: !Number.isInteger(r.value) };
    else if (/^#-?\d+(\.\d+)?$/.test(String(r.value))) value = { kind: 'number', value: Number(String(r.value).substring(1)), decimal: String(r.value).includes('.') };
    else if (/^(true|false)$/i.test(String(r.value))) value = { kind: 'boolean', value: String(r.value).toLowerCase() === 'true' };
    else value = { kind: 'string', value: String(r.value).replace(/^"(.*)"$/, '$1') };
    const src = v.idx(r.concept_id);
    const list = sv.concreteValues.get(src) || [];
    list.push({ relType: v.idx(type), group: r.group_id || 0, concrete: value });
    sv.concreteValues.set(src, list);
  }
}

/**
 * An ECL expression the engine does not evaluate itself, by main's ECL over this file: the concept
 * ids (a bitmap). Errors are main's (INVALID_ECL / UNSUPPORTED_ECL).
 */
/** an empty text index section (main's ECL only uses it to narrow term filters: none, no narrowing) */
let NO_TEXT_INDEXES = null;
function noTextIndexes() {
  return NO_TEXT_INDEXES || (NO_TEXT_INDEXES = new SnomedTextIndexes([], new Map()).serialize());
}

async function evaluateEcl(store, text, opContext) {
  const { ECLLexer, ECLParser } = require('../sct/ecl');
  const sv = servicesFor({ store });
  const ast = new ECLParser(new ECLLexer(text).tokenize()).parse();
  const ctx = await sv._evalECLNode(ast, opContext || null);
  if (ctx.eclWildcard && !(ctx.descendants && ctx.descendants.length)) return store.all();
  return new RoaringBitmap32(sv._eclToIndexArray(ctx).map((i) => i / CONCEPT_SIZE + 1));
}

// ---- results kept per file, for the synchronous compiler ------------------------------------

const KEPT_RESULTS = 64; // per file; the oldest is let go first

/** A compile needs main's ECL result for `text`, not evaluated yet: resolve() it and compile again */
class NeedsMainEcl extends Error {
  constructor(store, text) {
    super(`main's ECL has not evaluated ${text.slice(0, 60)} yet`);
    this.needsMainEcl = true;
    this.resolve = () => resolveMainEcl(store, text);
  }
}

/** the kept result for `text`: {bm} or {err}; undefined if not evaluated */
function mainEclResult(store, text) {
  return store._mainEcl ? store._mainEcl.get(text) : undefined;
}

/** evaluate `text` with main's ECL and keep the result (or the error it throws) */
async function resolveMainEcl(store, text) {
  const kept = store._mainEcl || (store._mainEcl = new Map());
  if (kept.has(text)) return;
  let entry;
  try {
    entry = { bm: await evaluateEcl(store, text, null) };
  } catch (err) {
    entry = { err };
  }
  if (kept.size >= KEPT_RESULTS) kept.delete(kept.keys().next().value);
  kept.set(text, entry);
}

module.exports = { evaluateEcl, mainEclResult, resolveMainEcl, NeedsMainEcl };
