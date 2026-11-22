'use strict';

// Native SNOMED CT post-coordination on a sqlite-v2 file: expressions are parsed with the
// compositional-grammar parser (tx/sct/expressions.js), and checked, normalised, compared and
// rendered by NativeExpressionServices. That class keeps main's expression algorithms (it extends
// SnomedExpressionServices) but answers every data question from the engine and the file:
//   - a concept "reference" is its concept id;
//   - definitions are the concept's active links; is-a and descendants are the stored sets;
//   - normal forms are read from ix_key 'normalForm', which the importer fills (buildNormalForms);
//   - the MRCM rules come from the MRCM reference sets' records, parsed once per file (store._nativeMrcm: file-load
//     data, like the LOINC order rank);
//   - an MRCM range or an ECL value-set constraint is evaluated by the engine's own ECL.
// Membership of an expression in an ECL constraint (exprSatisfies) and the edition and
// identifier translations are implemented here over the same data.
//
// One instance per request (no state kept between requests).

const E = require('../sct/expressions');
const { ECLLexer, ECLParser, ECLNodeType, ECLTokenType } = require('../sct/ecl');
const { KIND } = require('./store');
const { wildTermMatcher } = require('../sct/ecl');

const IS_A = '116680003';
const PRIMITIVE = '900000000000074008';
const ROOT = '138875005';
const US_ENGLISH = '900000000000509007';
const PREFERRED = '900000000000548007';
const SYNONYM = '900000000000013009';
const FSN = '900000000000003001';
const MRCM_ATTRIBUTE_DOMAIN = '723561005';
const MRCM_ATTRIBUTE_RANGE = '723562003';
const CONTENT_ALL = '723596005';
const CONTENT_POST = '723595009';
const STRENGTH_OPTIONAL = '723598006';
const NO_REFERENCE = E.NO_REFERENCE;

class NativeExpressionServices extends E.SnomedExpressionServices {
  /**
   * @param {import('./store').Store} store
   * @param {{building?: boolean, compilerFor?: function}} opts
   */
  constructor(store, opts = {}) {
    super({}, null);
    this.S = store;
    this.building = !!opts.building;
    this._log = { warn() { } }; // main's log is a getter that fetches the logger when _log is unset (#379)
    this.defaultLanguage = 1;
    this.assumeClassified = true;
    this.relationships = { getRelationship: (r) => r }; // relationships are records here
    this.ids = new Map();      // code -> concept_id | null
    this.facts = new Map();    // concept_id -> { code, active, links, primitive, module, display }
    this.nf = new Map();       // concept_id -> rendered normal form (building mode)
    this.ecl = new Map();      // constraint text -> bitmap | null
    this.compilerFor = opts.compilerFor || null;
    this.isAIndex = this.id(IS_A);
    this.eclConstraintMatcher = (constraint, value) => this.rangeSatisfied(constraint, value);
    this.conceptList = { findConcept: (code) => { const id = this.id(String(code)); return id == null ? { found: false, index: 0 } : { found: true, index: id }; } };
  }

  // ---- data -----------------------------------------------------------------------------

  id(code) {
    const c = String(code);
    if (!this.ids.has(c)) this.ids.set(c, this.S.idOf(c));
    return this.ids.get(c);
  }

  fact(id) {
    let f = this.facts.get(id);
    if (f) return f;
    const S = this.S;
    const row = S.conceptRows([id]).get(id);
    if (!row) throw new Error(`Concept ${id} not found`);
    const links = S.linksFrom([id], null, true);
    const props = S.propsById;
    let primitive = false;
    let module = null;
    const defs = [];
    for (const l of links) {
      const p = props.get(l.p);
      if (!p) continue;
      if (p.code === 'definitionStatusId') primitive = S.conceptRows([l.t]).get(l.t).code === PRIMITIVE;
      else if (p.code === 'moduleId') module = l.t;
      else if (p.attribute && p.code !== IS_A && p.kind === 'concept') defs.push({ relType: this.id(p.code), target: l.t, group: l.g || 0, active: true, defining: true, source: id });
    }
    f = { code: row.code, active: !!row.active, display: row.display, links, primitive, module, defs };
    this.facts.set(id, f);
    return f;
  }

  descendants(id) { return this.S.getSet(KIND.descendants, 0, id); }

  // ---- what main's algorithms ask of the data -------------------------------------------

  getConceptId(ref) { return this.fact(ref).code; }
  conceptIndexOf(conceptId) { const id = this.id(String(conceptId)); return id == null ? null : id; }
  isPrimitive(ref) { return this.fact(ref).primitive; }
  isActive(ref) { return this.fact(ref).active; }
  moduleOf(ref) { return this.fact(ref).module; }

  getConceptParents(ref) {
    const isa = this.S.hierarchy.id;
    return this.fact(ref).links.filter((l) => l.p === isa).map((l) => l.t);
  }

  getConceptChildren(ref) { return this.S.getSet(KIND.prop, this.S.hierarchy.id, ref).toArray(); }

  subsumes(a, b) { return a === b || this.descendants(a).has(b); }

  getDefiningRelationships(ref) { return this.fact(ref).defs; }

  /** the normal form: stored at import (ix_key 'normalForm'); computed when building it */
  createNormalForm(ref) {
    if (this.building) {
      let s = this.nf.get(ref);
      if (s === undefined) {
        this.nf.set(ref, null); // a definition cycle reads as the concept itself
        const exp = new E.SnomedExpression();
        this.createDefinedExpression(ref, exp, false);
        s = this.renderExpression(this.normaliseExpression(exp), E.SnomedServicesRenderOption.Minimal);
        this.nf.set(ref, s);
      }
      const r = new E.SnomedExpressionParser(this.conceptList).parse(s || this.getConceptId(ref));
      return r;
    }
    const nf = this.S.normalFormOf(ref);
    const r = new E.SnomedExpressionParser().parse(nf || this.getConceptId(ref));
    this.resolveExpressionReferences(r);
    return r;
  }

  checkConcept(concept, limits) {
    if (concept.code) {
      const id = this.id(concept.code);
      if (id != null) concept.reference = id;
      else if (concept.code !== '111115') throw new Error(`Concept ${concept.code} not found`);
    }
    if (limits && concept.reference && concept.reference !== NO_REFERENCE) {
      let ok = false;
      for (const limit of limits) {
        const lid = this.id(String(limit));
        if (lid != null && this.descendants(lid).has(concept.reference)) { ok = true; break; }
      }
      if (!ok) {
        const desc = this.describeConceptForMessage(concept.reference);
        const limitDesc = limits.map((l) => { const ix = this.conceptIndexOf(String(l)); return ix === null ? String(l) : this.describeConceptForMessage(ix); });
        if (limits.length === 1) throw new Error(`Concept ${desc} is not valid in this context (must be a descendant of ${limitDesc[0]})`);
        throw new Error(`Concept ${desc} is not valid in this context (must be a descendant of one of ${limitDesc.join(', ')})`);
      }
    }
    if (concept.reference !== NO_REFERENCE && concept.reference && concept.description) {
      const displayNames = this.listDisplayNames(concept.reference, 0);
      const wanted = this.normalizeText(concept.description);
      const ok = displayNames.some((d) => this.normalizeText(d.term) === wanted);
      if (!ok) {
        const validTerms = displayNames.map((d) => d.term).join('", "');
        throw new Error(`Term "${concept.description}" doesn't match a defined term at position ${concept.start} (valid terms would be from this list: "${validTerms}")`);
      }
    }
  }

  /** active FSNs and synonyms, in description order, the US English preferred synonym marked */
  listDisplayNames(ref) {
    const S = this.S;
    const rows = S.designationRows([ref], null, { withAcc: true }).get(ref) || [];
    const us = this.id(US_ENGLISH);
    const pref = this.id(PREFERRED);
    const out = [];
    for (const d of rows) {
      if (!d.active || !d.use || (d.use.code !== SYNONYM && d.use.code !== FSN)) continue;
      const accs = d.acc ? String(d.acc).split(',').map((x) => x.split(':').map(Number)) : [];
      const isPreferred = d.use.code === SYNONYM && accs.some(([r, a]) => r === us && a === pref);
      out.push({ isPreferred, isActive: true, languageCode: String(d.language || 'en').split('-')[0], term: d.term.trim() });
    }
    // (in description order, as main lists them: messages name a concept by the first)
    if (!out.length) {
      const f = this.fact(ref);
      if (f.display) out.push({ isPreferred: true, isActive: true, languageCode: 'en', term: f.display });
    }
    return out;
  }

  getDisplayName(conceptIdOrReference) {
    const ref = typeof conceptIdOrReference === 'string' ? this.id(conceptIdOrReference) : conceptIdOrReference;
    if (ref == null) return '';
    const names = this.listDisplayNames(ref);
    const p = names.find((d) => d.isPreferred);
    return p ? p.term : (names[0] ? names[0].term : '');
  }

  describeConceptForMessage(ref) {
    const id = this.getConceptId(ref);
    const names = this.listDisplayNames(ref);
    return names.length && names[0].term ? `${id} |${names[0].term}|` : id;
  }

  conceptInRefSet(refSetConcept, ref) { return this.S.getSet(KIND.refset, 0, refSetConcept).has(ref); }

  findRefSetByConceptId(conceptId) {
    const id = this.conceptIndexOf(String(conceptId));
    return id != null && this.S.getSet(KIND.refset, 0, id).size ? { definition: id } : null;
  }

  /** the MRCM rules of the file, parsed once per file (file-load data) */
  mrcm() {
    const S = this.S;
    if (S._nativeMrcm) return S._nativeMrcm;
    const domains = new Map();
    const ranges = new Map();
    const parseMax = (t) => { const m = /^\s*\d+\s*\.\.\s*(\d+|\*)\s*$/.exec(t || ''); return !m || m[1] === '*' ? Infinity : parseInt(m[1], 10); };
    const all = this.id(CONTENT_ALL);
    const post = this.id(CONTENT_POST);
    const optional = this.id(STRENGTH_OPTIONAL);
    const rows = (rid) => (rid == null ? [] : S.refsetMemberRows(rid));
    const refsets = new Set(S.refsetIds());
    for (const r of rows(this.id(MRCM_ATTRIBUTE_DOMAIN))) {
      // domainId, grouped, attributeCardinality, attributeInGroupCardinality, ruleStrengthId, contentTypeId
      const [domainId, grouped, card, inGroup, strength, content] = JSON.parse(r.fields);
      const ct = this.id(content);
      if (ct !== all && ct !== post) continue;
      const domain = this.id(domainId);
      if (domain == null) continue;
      if (!domains.has(r.concept_id)) domains.set(r.concept_id, []);
      domains.get(r.concept_id).push({ domain, isRefset: refsets.has(domain), grouped: String(grouped) === '1', optional: this.id(strength) === optional, max: parseMax(card), maxInGroup: parseMax(inGroup) });
    }
    const fromPost = new Set();
    for (const r of rows(this.id(MRCM_ATTRIBUTE_RANGE))) {
      // rangeConstraint, attributeRule, ruleStrengthId, contentTypeId
      const [constraint, , , content] = JSON.parse(r.fields);
      const ct = this.id(content);
      if (ct !== all && ct !== post) continue;
      if (ranges.has(r.concept_id) && fromPost.has(r.concept_id) && ct !== post) continue;
      if (!constraint) continue;
      ranges.set(r.concept_id, constraint);
      if (ct === post) fromPost.add(r.concept_id);
    }
    S._nativeMrcm = { domains, ranges };
    return S._nativeMrcm;
  }

  mrcmAttributeDomains() { return this.mrcm().domains; }
  mrcmAttributeRanges() { return this.mrcm().ranges; }

  // ---- ECL through the engine -----------------------------------------------------------

  /** the concepts an ECL constraint selects (engine), or null when the engine cannot say */
  async eclSet(text) {
    if (this.ecl.has(text)) return this.ecl.get(text);
    let bm = null;
    for (let tries = 0; ; tries++) {
      try {
        const c = this.compilerFor();
        bm = c.engineFor().evaluate(c.ecl(text));
      } catch (e) {
        // ECL only main's (async) evaluator answers: evaluate it, then compile again
        if (e && e.needsMainEcl && tries < 16) {
          await e.resolve();
          continue;
        }
        bm = null;
      }
      break;
    }
    this.ecl.set(text, bm);
    return bm;
  }

  evalNode(node) {
    const c = this.compilerFor();
    return c.engineFor().evaluate(c.eclNode(node));
  }

  /** does a refinement value satisfy an MRCM range constraint? null: cannot say (a concrete range) */
  async rangeSatisfied(constraint, value) { // awaited by main's checkRefinementRange (1.0.5)
    const set = await this.eclSet(constraint);
    if (!set) return null;
    const concepts = (value.concepts || []).filter((c) => c.reference != null && c.reference !== NO_REFERENCE);
    const refined = value.hasRefinements() || value.hasRefinementGroups();
    if (!refined) {
      if (!concepts.length) return null;
      return concepts.every((c) => set.has(c.reference));
    }
    let ast;
    try { ast = new ECLParser(new ECLLexer(constraint).tokenize()).parse(); } catch (e) { return null; }
    return this.exprSatisfies(value, ast);
  }

  // ---- an expression against an ECL constraint ------------------------------------------

  /** relationship records of an expression: its focus concepts' (and their inbound) plus its own */
  exprRels(expression) {
    const rels = [];
    const S = this.S;
    for (const c of expression.concepts || []) {
      if (c.reference == null || c.reference === NO_REFERENCE) continue;
      for (const d of this.fact(c.reference).defs) rels.push(d);
      for (const l of S.literalsOf([c.reference], true)) {
        const p = S.propsById.get(l.p);
        if (!p || !p.attribute) continue;
        rels.push({ active: true, relType: this.id(p.code), group: l.g || 0, target: -1, concrete: concreteOf(p, l.v) });
      }
    }
    // inbound relationships (for reversed attributes) are read only when one is asked about
    // (ix_in, the links of the by-target properties)
    const focus = (expression.concepts || []).map((c) => c.reference).filter((r) => r != null && r !== NO_REFERENCE);
    Object.defineProperty(rels, 'inbound', { value: () => {
      const out = [];
      for (const ref of focus) {
        for (const r of S.linksTo(ref, true)) {
          const p = S.propsById.get(r.p);
          if (!p || !p.attribute || p.code === IS_A) continue;
          out.push({ active: true, relType: this.id(p.code), group: r.g, source: r.s, target: ref, inbound: true });
        }
      }
      return out;
    } });
    let maxGroup = 0;
    for (const r of rels) if (r.group > maxGroup) maxGroup = r.group;
    const toRel = (ref, g) => {
      const t = ref.name ? ref.name.reference : NO_REFERENCE;
      const v = ref.value && ref.value.concepts && ref.value.concepts.length ? ref.value.concepts[0].reference : NO_REFERENCE;
      return t === NO_REFERENCE || v === NO_REFERENCE ? null : { active: true, relType: t, target: v, group: g };
    };
    for (const ref of expression.refinements || []) { const r = toRel(ref, 0); if (r) rels.push(r); }
    let g = maxGroup;
    for (const grp of expression.refinementGroups || []) {
      g += 1;
      for (const ref of grp.refinements || []) { const r = toRel(ref, g); if (r) rels.push(r); }
    }
    return rels;
  }

  exprSatisfies(expr, node) {
    return this.exprNode(expr, this.exprRels(expr), node);
  }

  exprNode(expr, rels, node) {
    if (!node) return false;
    switch (node.type) {
      case ECLNodeType.SUB_EXPRESSION_CONSTRAINT: {
        const f = node.focus;
        if (f.type === ECLNodeType.WILDCARD) return true;
        if (f.type === ECLNodeType.MEMBER_OF) return false; // an expression is not a refset member
        if (f.type === ECLNodeType.CONCEPT_REFERENCE) return this.exprConcept(expr, f.conceptId, node.operator);
        return this.exprNode(expr, rels, f);
      }
      case ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT: {
        const l = this.exprNode(expr, rels, node.left);
        const r = this.exprNode(expr, rels, node.right);
        if (node.operator === ECLNodeType.CONJUNCTION) return l && r;
        if (node.operator === ECLNodeType.DISJUNCTION) return l || r;
        if (node.operator === ECLNodeType.EXCLUSION) return l && !r;
        throw new Error(`Unsupported ECL compound operator: ${node.operator}`);
      }
      case ECLNodeType.REFINED_EXPRESSION_CONSTRAINT:
        return this.exprNode(expr, rels, node.base) && this.refinementMatches(rels, node.refinement);
      case ECLNodeType.CONCEPT_REFERENCE:
        return this.exprConcept(expr, node.conceptId, null);
      case ECLNodeType.WILDCARD:
        return true;
      case ECLNodeType.MEMBER_OF:
        return false;
      default:
        throw new Error(`Unsupported ECL node type for expression membership: ${node.type}`);
    }
  }

  /** a refined expression is strictly below its focus: only < and << can hold */
  exprConcept(expr, conceptId, operator) {
    const target = this.id(conceptId);
    if (target == null) throw new Error(`The SNOMED CT Concept ${conceptId} is not known`);
    const focus = (expr.concepts || []).map((c) => c.reference).filter((r) => r != null && r !== NO_REFERENCE);
    if (!focus.length) return false;
    const subsumed = focus.every((f) => this.subsumes(target, f));
    return (operator === ECLTokenType.DESCENDANT_OR_SELF_OF || operator === ECLTokenType.DESCENDANT_OF) ? subsumed : false;
  }

  refinementMatches(rels, r) {
    switch (r.type) {
      case ECLNodeType.ATTRIBUTE: return this.attributeMatches(rels, r, null);
      case ECLNodeType.ATTRIBUTE_SET:
        return r.operator === 'OR' ? r.attributes.some((a) => this.refinementMatches(rels, a)) : r.attributes.every((a) => this.refinementMatches(rels, a));
      case ECLNodeType.ATTRIBUTE_GROUP: return this.groupMatches(rels, r);
      default: throw new Error(`Unsupported refinement node type: ${r.type}`);
    }
  }

  inGroup(rels, node, g) {
    if (node.type === ECLNodeType.ATTRIBUTE_SET) {
      return node.operator === 'OR' ? node.attributes.some((a) => this.inGroup(rels, a, g)) : node.attributes.every((a) => this.inGroup(rels, a, g));
    }
    if (node.type !== ECLNodeType.ATTRIBUTE) throw new Error(`Unsupported node type in attribute group: ${node.type}`);
    return this.attributeMatches(rels, node, g);
  }

  attributeMatches(rels, attr, groupFilter) {
    if (!attr.comparison) throw new Error('ECL attribute without a comparison is not supported');
    const n = this.countMatches(rels, attr, groupFilter);
    return attr.cardinality ? accepts(attr.cardinality, n) : n >= 1;
  }

  countMatches(rels, attr, groupFilter) {
    let res = attr._native;
    if (!res) {
      res = { types: this.attributeTypes(attr.name) };
      if (attr.comparison.type === ECLNodeType.EXPRESSION_COMPARISON) res.values = this.evalNode(attr.comparison.value);
      else res.concrete = concreteMatcher(attr.comparison);
      attr._native = res;
    }
    const matched = new Set();
    if (res.concrete) {
      for (const rel of rels) {
        if (!rel.concrete || (res.types && !res.types.has(rel.relType))) continue;
        if (groupFilter !== null && rel.group !== groupFilter) continue;
        if (res.concrete(rel.concrete)) matched.add(rel.group + ':' + JSON.stringify(rel.concrete.value));
      }
      return matched.size;
    }
    const notEquals = attr.comparison.operator === ECLTokenType.NOT_EQUALS;
    const reverse = !!attr.reverse;
    if (reverse && rels.inbound && !rels._inboundRead) { rels.push(...rels.inbound()); rels._inboundRead = true; }
    for (const rel of rels) {
      if (!rel.active || rel.concrete || !!rel.inbound !== reverse) continue;
      if (res.types && !res.types.has(rel.relType)) continue;
      if (groupFilter !== null && rel.group !== groupFilter) continue;
      const v = reverse ? rel.source : rel.target;
      if (res.values.has(v) !== notEquals) matched.add(rel.group + ':' + v);
    }
    return matched.size;
  }

  attributeTypes(name) {
    if (name.type === ECLNodeType.WILDCARD) return null;
    if (name.type === ECLNodeType.CONCEPT_REFERENCE) {
      const id = this.id(name.conceptId);
      if (id == null) throw new Error(`The SNOMED CT Concept ${name.conceptId} is not known`);
      return new Set([id]);
    }
    return new Set(this.evalNode(name).toArray());
  }

  groupMatches(rels, group) {
    const groups = new Set(rels.filter((r) => r.active && r.group > 0).map((r) => r.group));
    let n = 0;
    for (const g of groups) {
      if (group.attributes.every((a) => this.inGroup(rels, a, g))) {
        n++;
        if (!group.cardinality) return true;
      }
    }
    return group.cardinality ? accepts(group.cardinality, n) : false;
  }
}

function accepts(card, n) {
  if (card.min != null && n < card.min) return false;
  if (card.max != null && card.max !== '*' && n > card.max) return false;
  return true;
}

function concreteOf(p, v) {
  if (p.type === 'boolean') return { kind: 'boolean', value: v === 1 || v === '1' || v === 'true' };
  if (p.type === 'string') return { kind: 'string', value: String(v) };
  return { kind: 'number', value: Number(v) };
}

function concreteMatcher(c) {
  const cmp = (a, op, b) => ({ '=': a === b, '!=': a !== b, '<': a < b, '<=': a <= b, '>': a > b, '>=': a >= b })[op];
  const opOf = { [ECLTokenType.EQUALS]: '=', [ECLTokenType.NOT_EQUALS]: '!=', [ECLTokenType.LT]: '<', [ECLTokenType.LTE]: '<=', [ECLTokenType.GT]: '>', [ECLTokenType.GTE]: '>=' };
  const op = opOf[c.operator] || c.operator;
  if (c.type === ECLNodeType.NUMERIC_COMPARISON) { const n = Number(c.value); return (v) => v.kind === 'number' && cmp(v.value, op, n); }
  if (c.type === ECLNodeType.BOOLEAN_COMPARISON) return (v) => v.kind === 'boolean' && ((op === '=') === (v.value === c.value));
  const vals = (c.values || []).map((x) => (typeof x === 'object' ? x : { kind: 'exact', value: x }));
  const test = (s) => vals.some((x) => {
    if (x.kind === 'wild') return wildTermMatcher(String(x.value))(s); // main's matcher: see compile.js termMatcher
    if (x.kind === 'match') { const w = x.value.toLowerCase().split(/\s+/).filter(Boolean); const tw = s.toLowerCase().split(/[^\p{L}\p{N}]+/u); return w.every((a) => tw.some((b) => b.startsWith(a))); }
    return s === x.value;
  });
  return (v) => v.kind === 'string' && (op === '=' ? test(v.value) : !test(v.value));
}

/**
 * Normal forms at import: every active, fully defined concept whose normal form differs from its
 * own id, rendered in the minimal form (as main stores them), each through opts.write(id, nf)
 * (the importer's derived-by-importer ix_key rows: sct-v2-common.js derivedIndexes).
 * @returns {{written: number, failed: number}}
 */
function buildNormalForms(store, db, log = () => { }, opts = {}) {
  const ins = { run: opts.write };
  const svc = new NativeExpressionServices(store, { building: true });
  const ids = store.active().toArray();
  let n = 0;
  let failed = 0;
  db.exec('BEGIN');
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try {
      if (svc.isPrimitive(id)) continue;
      const nf = svc.createNormalForm(id);
      const rendered = svc.renderExpression(nf, E.SnomedServicesRenderOption.Minimal);
      if (rendered !== svc.getConceptId(id)) { ins.run(id, rendered); n++; }
    } catch (e) {
      failed++;
    }
    if (svc.facts.size > 200000) { svc.facts.clear(); }
    if (i % 50000 === 0 && i) log(`  normal forms: ${i.toLocaleString()} / ${ids.length.toLocaleString()}`);
  }
  db.exec('COMMIT');
  return { written: n, failed };
}

module.exports = { NativeExpressionServices, buildNormalForms, ROOT };
