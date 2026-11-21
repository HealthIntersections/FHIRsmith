'use strict';
// ValueSet.compose includes / filters and ECL -> IR (see evaluate.js for the node list).
//
// Generic rules cover the concept filters (is-a, descendent-of, child-of, generalizes, =, in,
// not-in, is-not-a, descendent-leaf, regex) and every property in property_def (=, in, not-in,
// exists, regex). A per-system dialect (dialects.js) adds or overrides filters. Two error kinds:
//   FilterError  - the request is wrong for this system (the message is what upstream reports)
//   Unsupported  - the engine cannot do it; the caller hands the request back to expand.js

const { ECLLexer, ECLParser } = require('../../sct/ecl');
const { requiredLiterals } = require('./regex-literals');
const { Unsupported, Evaluator } = require('./evaluate');
const { KIND } = require('../store');

// an ECL wild: term: main's matcher (cs-snomed.js wildTermMatcher), linear with no regex
const { wildTermMatcher } = require('../../sct/ecl');

class FilterError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
    this.filterError = true;
  }
}

function splitList(v) {
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

function uniqSorted(ids) {
  return Array.from(new Set(ids)).sort((a, b) => a - b);
}

class Compiler {
  /**
   * @param {object} term { store, dialect, layers: [{store, ...}] }
   * @param {object} [opts] { stats }
   */
  constructor(term, opts = {}) {
    this.term = term;
    this.store = term.store;
    this.dialect = term.dialect || {};
    this.stats = opts.stats || null;
    this.codeMap = new Map(); // codes resolved while compiling this request (one statement for all)
  }

  // ---- codes -------------------------------------------------------------------------------

  ids(codes) {
    const miss = codes.filter((c) => c != null && !this.codeMap.has(String(c)));
    if (miss.length) for (const [c, id] of this.store.resolveCodes(miss, this.stats)) this.codeMap.set(c, id);
    const out = new Map();
    for (const c of codes) if (c != null) out.set(c, this.codeMap.get(String(c)) ?? null);
    return out;
  }

  id(code) {
    return this.store.idOf(String(code).trim(), this.stats);
  }

  /** concept ids for a filter value: the code, or a dialect-specific alternative (LOINC part names) */
  valueIds(v) {
    const id = this.id(v);
    if (id != null) return [id];
    return this.dialect.valuesByName ? this.dialect.valuesByName(this, v) : [];
  }

  // ---- compose -------------------------------------------------------------------------------

  /** prefetch every code a set of includes mentions, in one statement */
  prefetch(incs) {
    const want = new Set();
    for (const inc of incs) {
      for (const c of inc.concept || []) want.add(c.code);
      for (const f of inc.filter || []) {
        if (f.value == null || f.op === 'regex' || f.property === 'constraint' || f.property === 'expression') continue;
        for (const v of splitList(f.value)) want.add(v);
      }
    }
    if (want.size) this.ids([...want]);
  }

  selection(includes, excludes, activeOnly) {
    this.prefetch([...includes, ...excludes]);
    return {
      includes: includes.map((inc) => this.include(inc)),
      excludes: excludes.map((inc) => this.include(inc)),
      activeOnly: !!activeOnly
    };
  }

  include(inc) {
    if (inc.valueSet && inc.valueSet.length) throw new Unsupported('valueset-import');
    if (inc.otherVersion) {
      // another version of this system (an exclude): compiled on that file, evaluated there and
      // translated into this file's ids by code (tx/sqlite-v2/store.js translateFrom)
      const other = inc.provider && inc.provider.store;
      if (!other || other.system !== this.store.system) throw new Unsupported('other-version', inc.version);
      const oc = new Compiler({ store: other, dialect: inc.provider.dialect }, { stats: this.stats });
      oc.prefetch([inc]);
      const parts = oc.include({ ...inc, otherVersion: false });
      return { parts: parts.parts.map((p) => ({ node: { t: 'xlate', from: other, node: p.node, label: 'from ' + other.version }, order: null })) };
    }
    if (inc.imports && inc.imports.length) {
      // value set imports resolved by expand.js: each is a set; an include is their
      // intersection with its own concepts/filters (FHIR include semantics)
      const items = inc.imports.map((c) => this.importNode(c));
      if (inc.system && ((inc.filter && inc.filter.length) || (inc.concept && inc.concept.length))) {
        const own = this.include({ ...inc, imports: undefined });
        items.push(own.parts.length === 1 ? own.parts[0].node : { t: 'or', items: own.parts.map((p) => p.node) });
      }
      return { parts: [{ node: items.length === 1 ? items[0] : { t: 'and', items }, order: null }] };
    }
    const parts = [];
    if (!(inc.concept && inc.concept.length) && !(inc.filter && inc.filter.length)) {
      // (whole: the include names the whole code system, which the built-in provider walks)
      parts.push({ node: this.domain({ t: 'all', whole: true }), order: null });
      return { parts };
    }
    if (inc.concept && inc.concept.length) {
      const codes = inc.concept.map((c) => c.code);
      const m = this.ids(codes);
      const order = [];
      for (const c of codes) if (m.get(c) != null) order.push(m.get(c));
      parts.push({ node: { t: 'ids', ids: uniqSorted(order) }, order });
    }
    if (inc.filter && inc.filter.length) {
      const items = inc.filter.map((f) => this.filter(f.property, f.op, f.value));
      const node = items.length === 1 ? items[0] : { t: 'and', items };
      // upstream adds an include's concepts and its filters separately (expand.js includeCodes)
      parts.push({ node: this.domain(node), order: null });
    }
    return { parts };
  }

  /** the concepts a filter can select at all (RxNorm: never archived concepts) */
  domain(node) {
    if (this.dialect.domain !== 'live') return node;
    const live = this.dialect.live(this.store);
    return node.t === 'all' ? live : { t: 'and', items: [node, live] };
  }

  /** an imported value set's compose as one node: its includes minus its excludes */
  importNode(c) {
    this.prefetch([...(c.include || []), ...(c.exclude || [])]);
    const flat = (list) => list.flatMap((inc) => this.include(inc).parts.map((p) => p.node));
    const inc = flat(c.include || []);
    const exc = flat(c.exclude || []);
    let node = inc.length === 1 ? inc[0] : { t: 'or', items: inc };
    if (exc.length) node = { t: 'minus', a: node, b: exc.length === 1 ? exc[0] : { t: 'or', items: exc } };
    if (c.inactive === false) node = { t: 'and', items: [node, { t: 'active' }] };
    return node;
  }

  // ---- filters -------------------------------------------------------------------------------

  filter(prop, op, value) {
    if (this.dialect.filter) {
      const n = this.dialect.filter(this, prop, op, value);
      if (n) return n;
    }
    if (prop === 'display' && !this.store.props.has('display')) return this.displayFilter(op, value);
    if (prop === 'designation' && !this.store.props.has('designation')) {
      // R5 CodeSystem 4.8.15 generic filters: designation = / regex; the display counts as one
      if (op === '=') return { t: 'desigMatch', eq: String(value), label: `designation = "${value}"` };
      if (op === 'regex') return { t: 'desigMatch', re: String(value), label: `designation regex /${value}/` };
      throw this.notSupported(prop, op, value);
    }
    if (prop === 'concept' || prop === 'code' || (this.store.hierarchy && prop === this.store.hierarchy.code && op !== '=' && op !== 'in' && op !== 'exists')) {
      return this.conceptFilter(op, value, prop);
    }
    const p = this.store.props.get(prop);
    if (!p) {
      const n = this.term.layers ? this.term.layers.filterNode(this, prop, op, value) : null;
      if (n) return n;
      throw this.notSupported(prop, op, value);
    }
    return this.propertyFilter(p, op, value);
  }

  /** display = / in / regex (the concept's display; FHIR's "display" filter property) */
  displayFilter(op, value) {
    if (op === 'regex') {
      // literals every match contains: candidates from the trigram index before RE2 runs (evaluate.js)
      const lits = this.store.hasFts ? requiredLiterals(value) : [];
      return lits.length ? { t: 'text', field: 'display', re: value, lits } : { t: 'text', field: 'display', re: value };
    }
    if (op === '=' || op === 'in') {
      const vals = op === '=' ? [String(value)] : splitList(value);
      const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { t: 'text', field: 'display', re: '^(?:' + vals.map(esc).join('|') + ')$' };
    }
    throw this.notSupported('display', op, value);
  }

  notSupported(prop, op, value) {
    if (this.dialect.notSupported) return this.dialect.notSupported(prop, op, value);
    return new FilterError(`The filter "${prop} ${op} ${value}" is not supported for ${this.store.system}`);
  }

  conceptFilter(op, value, prop = 'concept') {
    const S = this.store;
    if (op === 'in' || op === 'not-in') {
      const vals = splitList(value);
      const m = this.ids(vals);
      const unknown = vals.filter((v) => m.get(v) == null);
      // SNOMED: a concept (or refset) the edition does not have is an error, as upstream reports it
      if (unknown.length && this.dialect.strictIn && this.dialect.unknownConcept) this.dialect.unknownConcept(this, op, unknown[0]);
      const ids = uniqSorted(vals.map((v) => m.get(v)).filter((x) => x != null));
      const n = this.dialect.conceptIn ? this.dialect.conceptIn(this, ids) : { t: 'ids', ids };
      return op === 'in' ? n : { t: 'minus', a: { t: 'all' }, b: n };
    }
    if (op === 'regex') return { t: 'text', field: 'code', re: value };
    if (op === 'exists') throw this.notSupported(prop, op, value);
    const id = this.id(value);
    if (id == null) {
      if (this.dialect.unknownConcept) return this.dialect.unknownConcept(this, op, value);
      return { t: 'empty', why: 'unknown code ' + value };
    }
    const desc = { t: 'set', kind: KIND.descendants, pid: 0, value: id };
    switch (op) {
      case '=': return { t: 'ids', ids: [id] };
      case 'is-a': return { t: 'self', id, of: desc };
      case 'descendent-of': return desc;
      case 'is-not-a': return { t: 'minus', a: { t: 'all' }, b: { t: 'self', id, of: desc } };
      case 'generalizes': return { t: 'anc', id, self: !this.dialect.generalizesExcludesSelf };
      case 'child-of': return S.hierarchy ? { t: 'set', kind: KIND.prop, pid: S.hierarchy.id, value: id } : { t: 'empty' };
      case 'descendent-leaf': return { t: 'and', items: [desc, { t: 'leaf' }] };
      default: throw this.notSupported(prop, op, value);
    }
  }

  propertyFilter(p, op, value) {
    const inverse = this.inverseOf(p.code);
    switch (op) {
      case '=':
      case 'in':
      case 'not-in': {
        const vals = op === '=' ? [String(value)] : splitList(value);
        let node;
        if (inverse) {
          // P' = X where P' is the inverse of P: the targets of P from X
          const ids = uniqSorted(vals.flatMap((v) => this.valueIds(v)));
          node = { t: 'or', items: inverse.map((q) => (q.isHierarchy ? { t: 'hier', dir: 'parents', self: false, of: { t: 'ids', ids } } : { t: 'propOf', pids: [q.id], sources: { t: 'ids', ids } })) };
          if (node.items.length === 1) node = node.items[0];
        } else if (p.kind === 'concept') {
          const ids = uniqSorted(vals.flatMap((v) => this.valueIds(v)));
          node = ids.length === 1 ? { t: 'set', kind: KIND.prop, pid: p.id, value: ids[0] } : { t: 'propIn', pids: [p.id], values: { t: 'ids', ids } };
        } else if (op === '=' && ['integer', 'decimal', 'dateTime'].includes(p.type) && /^(eq|ne|gt|lt|ge|le|sa|eb|ap)./.test(String(value))) {
          // R5 CodeSystem 4.8.15.1: FHIR search prefixes on integer, decimal and dateTime properties
          node = litSets(p.id, this.store.propValues(p.id, this.stats).filter((r) => searchPrefixMatch(p.type, String(value), r.value)).map((r) => r.value));
        } else {
          node = litSets(p.id, this.literalKeys(p, vals));
        }
        return op === 'not-in' ? { t: 'minus', a: { t: 'all' }, b: node } : node;
      }
      case 'exists': {
        let n;
        if (inverse) {
          n = { t: 'or', items: inverse.map((q) => ({ t: 'propOf', pids: [q.id], sources: { t: 'all' } })) };
        } else {
          n = { t: 'set', kind: KIND.hasProp, pid: p.id, value: 0 };
        }
        const v = String(value).toLowerCase();
        if (v !== 'true' && v !== 'false') throw this.notSupported(p.code, op, value);
        return v === 'false' ? { t: 'minus', a: { t: 'all' }, b: n } : n;
      }
      case 'regex':
        if (p.kind === 'concept') {
          // regex over the target's code or display: match the target keys, then their sources
          return { t: 'propIn', pids: [p.id], values: { t: 'text', field: this.dialect.conceptRegexField || 'display', re: value } };
        }
        return { t: 'litMatch', pid: p.id, re: value };
      default:
        throw this.notSupported(p.code, op, value);
    }
  }

  /** inverse property definitions (cs_config.inverseProperties), or null */
  inverseOf(code) {
    const inv = this.store.config.inverseProperties;
    if (!inv || !inv[code]) return null;
    return [].concat(inv[code]).map((c) => this.store.props.get(c)).filter(Boolean);
  }

  /** map literal filter values onto stored keys (case-insensitive for strings) */
  literalKeys(p, vals) {
    const keys = this.store.propValues(p.id, this.stats);
    const out = new Set();
    const map = this.store.config.propertyValueDescriptions && this.store.config.propertyValueDescriptions[p.code];
    for (let v of vals) {
      if (map) for (const [k, d] of Object.entries(map)) if (String(d).toLowerCase() === v.toLowerCase()) v = k;
      const aliases = this.store.config.propertyValueAliases && this.store.config.propertyValueAliases[p.code];
      if (aliases && aliases[v.toLowerCase()] !== undefined) v = aliases[v.toLowerCase()];
      const lv = v.toLowerCase();
      for (const r of keys) if (String(r.value).toLowerCase() === lv) out.add(r.value);
    }
    return [...out];
  }

  // ---- ECL -----------------------------------------------------------------------------------

  ecl(text) {
    let ast;
    try {
      ast = new ECLParser(new ECLLexer(text).tokenize()).parse();
    } catch (e) {
      throw new FilterError(e.message, { eclSyntax: true });
    }
    const pre = new Set();
    collectIds(ast, pre);
    if (pre.size) this.ids([...pre]);
    try {
      return this.eclNode(ast);
    } catch (e) {
      // a feature the engine does not evaluate: the dialect may hand the expression on (SNOMED CT:
      // main's ECL over this file); otherwise the error stands
      if (e.unsupported && this.dialect.eclFallback) return this.dialect.eclFallback(this, text, e);
      throw e;
    }
  }

  eclNode(n) {
    switch (n.type) {
      case 'SubExpressionConstraint': return this.eclSub(n);
      case 'CompoundExpressionConstraint': {
        const l = this.eclNode(n.left);
        const r = this.eclNode(n.right);
        // eclOrder: the order cs-snomed.js lists the result in (engine.js _eclOrdered)
        if (n.operator === 'Conjunction') return { t: 'and', items: [l, r], eclOrder: 'conj' };
        if (n.operator === 'Disjunction') return { t: 'or', items: [l, r], eclOrder: 'disj' };
        return { t: 'minus', a: l, b: r, eclOrder: 'minus' };
      }
      case 'RefinedExpressionConstraint':
        return { t: 'and', items: [this.eclNode(n.base), this.eclRefinement(n.refinement)], eclOrder: 'base' };
      case 'DottedExpressionConstraint': {
        let cur = this.eclNode(n.base);
        for (const a of n.attributes) cur = { t: 'propOf', pids: this.eclAttrIds(a), sources: cur };
        return cur;
      }
      case 'ConceptReference': case 'Wildcard': case 'MemberOf':
        return this.eclSub({ type: 'SubExpressionConstraint', operator: null, focus: n });
      default:
        throw new Unsupported('ecl-feature', n.type);
    }
  }

  eclConcept(code) {
    const id = this.id(code);
    if (id == null) throw new FilterError(`The SNOMED CT Concept ${code} is not known`, { eclUnknown: true });
    return id;
  }

  eclSub(n) {
    if (n.filters && n.filters.length) {
      // {{ C }} concept filters and {{ D }} description filters narrow; {{ + HISTORY }} adds
      let node = this.eclSub({ ...n, filters: undefined });
      const narrow = [];
      for (const fc of n.filters) if (fc.kind === 'C') narrow.push(...fc.filters.map((f) => this.eclConceptFilter(f)));
      for (const fc of n.filters) if (fc.kind === 'D') narrow.push(this.eclDescriptionFilter(fc.filters));
      if (narrow.length) node = { t: 'and', items: [node, ...narrow], eclOrder: 'base' };
      for (const fc of n.filters) if (fc.kind === '+') node = this.eclHistory(node, fc);
      for (const fc of n.filters) if (!['C', 'D', '+'].includes(fc.kind)) throw new Unsupported('ecl-feature', 'filter ' + fc.kind);
      return node;
    }
    const f = n.focus;
    let base;
    let id = null;
    if (f.type === 'ConceptReference') {
      id = this.eclConcept(f.conceptId);
      base = { t: 'ids', ids: [id] };
    } else if (f.type === 'Wildcard') {
      base = { t: 'all' };
    } else if (f.type === 'MemberOf') {
      if (f.fields) throw new Unsupported('ecl-feature', 'member fields');
      if (f.memberFilters && f.memberFilters.length) {
        if (f.refSet.type !== 'ConceptReference') throw new Unsupported('ecl-feature', 'member filter on a refset expression');
        return this.eclMemberFilter(this.eclConcept(f.refSet.conceptId), f.refSet.conceptId, f.memberFilters);
      }
      if (f.refSet.type === 'ConceptReference') {
        const rid = this.eclConcept(f.refSet.conceptId);
        if (this.store.hasAcceptability && !this.store.getSet(KIND.refset, 0, rid, this.stats).size
          && this.store.stmt('SELECT 1 FROM designation_acceptability WHERE refset_id = ? LIMIT 1').get(rid)) {
          // a language reference set: its members are descriptions (as main reports it)
          throw new FilterError(`The members of reference set ${f.refSet.conceptId} are descriptions, not concepts, so ^ cannot be evaluated for it`);
        }
        base = { t: 'set', kind: KIND.refset, pid: 0, value: rid };
      } else if (f.refSet.type === 'Wildcard') {
        throw new Unsupported('ecl-feature', '^ *');
      } else {
        base = { t: 'refsetOf', of: this.eclNode(f.refSet) };
      }
    } else if (f.type === 'AltIdentifier') {
      throw new Unsupported('ecl-feature', 'alternate identifier');
    } else {
      base = this.eclNode(f);
    }
    const op = n.operator;
    if (!op) return base;
    if (f.type === 'Wildcard') {
      // over every concept (tx-ecosystem sct/ecl/*-of-any): "has a parent" is having an active is-a
      // link (stored as hasProp); "has a child" is an active concept that is not a leaf
      const hier = this.store.hierarchy;
      const hasParent = hier ? { t: 'set', kind: KIND.hasProp, pid: hier.id, value: 0 } : { t: 'empty' };
      const hasChild = { t: 'minus', a: { t: 'active' }, b: { t: 'leaf' } };
      switch (op) {
        case 'DESCENDANT_OR_SELF_OF': case 'CHILD_OR_SELF_OF': case 'ANCESTOR_OR_SELF_OF': case 'PARENT_OR_SELF_OF': return { t: 'all' };
        case 'DESCENDANT_OF': case 'CHILD_OF': return hasParent;
        case 'ANCESTOR_OF': case 'PARENT_OF': return hasChild;
        case 'TOP_OF_SET': return { t: 'minus', a: { t: 'all' }, b: hasParent };
        case 'BOTTOM_OF_SET': return { t: 'minus', a: { t: 'all' }, b: hasChild };
        default: throw new Unsupported('ecl-feature', op + ' *');
      }
    }
    if (id != null) {
      const desc = { t: 'set', kind: KIND.descendants, pid: 0, value: id };
      const hid = this.store.hierarchy.id;
      switch (op) {
        case 'DESCENDANT_OF': return desc;
        case 'DESCENDANT_OR_SELF_OF': return { t: 'self', id, of: desc };
        case 'CHILD_OF': return { t: 'set', kind: KIND.prop, pid: hid, value: id };
        case 'CHILD_OR_SELF_OF': return { t: 'self', id, of: { t: 'set', kind: KIND.prop, pid: hid, value: id } };
        case 'ANCESTOR_OF': return { t: 'anc', id, self: false };
        case 'ANCESTOR_OR_SELF_OF': return { t: 'anc', id, self: true };
        case 'PARENT_OF': return { t: 'parents', id, self: false };
        case 'PARENT_OR_SELF_OF': return { t: 'parents', id, self: true };
        default: break;
      }
    }
    const map = {
      DESCENDANT_OF: ['desc', false], DESCENDANT_OR_SELF_OF: ['desc', true],
      CHILD_OF: ['children', false], CHILD_OR_SELF_OF: ['children', true],
      ANCESTOR_OF: ['anc', false], ANCESTOR_OR_SELF_OF: ['anc', true],
      PARENT_OF: ['parents', false], PARENT_OR_SELF_OF: ['parents', true],
      TOP_OF_SET: ['top', false], BOTTOM_OF_SET: ['bottom', false]
    };
    const m = map[op];
    if (!m) throw new Unsupported('ecl-feature', op);
    return { t: 'hier', dir: m[0], self: m[1], of: base };
  }

  /** {{ C field op value }} as a set */
  eclConceptFilter(f) {
    const S = this.store;
    const field = f.field.toLowerCase();
    const neg = f.operator === '!=';
    const not = (n) => (neg ? { t: 'minus', a: { t: 'all' }, b: n } : n);
    if (field === 'active') return (f.value === true) !== neg ? { t: 'active' } : { t: 'inactive' };
    if (field === 'moduleid' || field === 'definitionstatusid') {
      const p = S.props.get(field === 'moduleid' ? 'module' : 'definitionStatusId');
      if (!p) return { t: 'empty' };
      return not({ t: 'propIn', pids: [p.id], values: this.eclNode(f.value) });
    }
    if (field === 'definitionstatus') {
      const p = S.props.get('definitionStatusId');
      const ids = (f.values || []).map((v) => this.id(v === 'primitive' ? '900000000000074008' : '900000000000073002')).filter((x) => x != null);
      return not({ t: 'propIn', pids: [p.id], values: { t: 'ids', ids } });
    }
    if (field === 'effectivetime') {
      const p = S.props.get('effectiveTime');
      const vals = (f.values || []).map(String);
      const cmp = { '=': (x) => vals.includes(x), '!=': (x) => !vals.includes(x), '<': (x) => x < vals[0], '<=': (x) => x <= vals[0], '>': (x) => x > vals[0], '>=': (x) => x >= vals[0] }[f.operator];
      if (!p || !cmp) throw new Unsupported('ecl-feature', 'effectiveTime ' + f.operator);
      return litSets(p.id, S.propValues(p.id, this.stats).filter((r) => cmp(String(r.value).replace(/-/g, ''))).map((r) => r.value));
    }
    throw new Unsupported('ecl-feature', 'concept filter ' + f.field);
  }

  /** {{ D ... }}: one description of the concept must satisfy every filter of the block */
  eclDescriptionFilter(filters) {
    const S = this.store;
    const prepared = filters.map((f) => {
      const field = f.field.toLowerCase();
      const out = { field, neg: f.operator === '!=' };
      if (f.valueType === 'term') out.matchers = f.values.map((v) => termMatcher(v));
      else if (field === 'language') out.values = f.values.map((v) => String(v).toLowerCase());
      else if (field === 'type') out.uses = f.values.map((t) => ({ syn: '900000000000013009', fsn: '900000000000003001', def: '900000000000550004' })[t]);
      else if (field === 'typeid') out.uses = this.eclCodes(f.value);
      else if (field === 'dialect' || field === 'dialectid') {
        out.dialects = f.dialects.map((d) => ({
          refsets: d.alias ? [this.id(DIALECT_ALIASES[d.alias] || '')].filter((x) => x != null) : this.eclIds(d.expression),
          acceptability: d.acceptability ? d.acceptability.map((a) => this.id(a === 'preferred' ? '900000000000548007' : a === 'acceptable' ? '900000000000549004' : a)) : null
        }));
      } else if (field === 'active') out.value = f.value;
      else throw new Unsupported('ecl-feature', 'description filter ' + f.field);
      return out;
    });
    // words for a full-text pre-selection (match terms with words of >= 3 characters)
    const words = [];
    for (const f of prepared) {
      if (f.field === 'term' && !f.neg && f.matchers.length === 1 && f.matchers[0].words) words.push(...f.matchers[0].words.filter((w) => w.length >= 3));
    }
    void S;
    return { t: 'descFilter', filters: prepared, words, label: 'description filter' };
  }

  eclIds(expr) {
    if (!expr) return null;
    return new (require('./engine').Engine)(this.store).evaluate(this.eclNode(expr)).toArray();
  }

  eclCodes(expr) {
    const ids = this.eclIds(expr);
    if (!ids) return null;
    return [...this.store.conceptRows(ids, this.stats).values()].map((r) => r.code);
  }

  /** {{ + HISTORY-x }}: add the inactive concepts associated with members of the result */
  eclHistory(node, hs) {
    const PROFILES = { MIN: ['900000000000527005'], MOD: ['900000000000527005', '900000000000528000', '900000000000526001', '1186924009'] };
    let refsets;
    if (hs.profile === 'EXPLICIT') refsets = this.eclIds(hs.refsets) || [];
    else if (hs.profile === 'MAX' || !hs.profile) {
      const root = this.id('900000000000522004');
      refsets = root == null ? [] : this.store.getSet(KIND.descendants, 0, root, this.stats).toArray();
    } else refsets = (PROFILES[hs.profile] || []).map((c) => this.id(c)).filter((x) => x != null);
    return { t: 'history', of: node, refsets };
  }

  eclRefinement(r) {
    switch (r.type) {
      case 'Attribute': return this.eclAttribute(r);
      case 'AttributeSet': {
        const items = r.attributes.map((a) => this.eclRefinement(a));
        return items.length === 1 ? items[0] : { t: r.operator === 'OR' ? 'or' : 'and', items };
      }
      case 'AttributeGroup': return this.eclGroup(r);
      default: throw new Unsupported('ecl-feature', r.type);
    }
  }

  eclGroup(g) {
    const card = g.cardinality;
    const attrs = g.attributes;
    const simple = attrs.every((a) => a.type === 'Attribute' && !a.reverse && !a.cardinality && a.comparison && a.comparison.type === 'ExpressionComparison' && a.comparison.operator === 'EQUALS');
    if (!simple) throw new Unsupported('ecl-feature', 'group content');
    const parts = attrs.map((a) => ({ pids: this.eclAttrIds(a.name), values: this.eclNode(a.comparison.value) }));
    const node = parts.length === 1 ? { t: 'propIn', pids: parts[0].pids, values: parts[0].values } : { t: 'group', attrs: parts };
    if (!card || (card.min === 1 && card.max === '*')) return node;
    if (card.min === 0 && card.max === 0) return { t: 'minus', a: { t: 'all' }, b: node };
    // [m..n] { ... }: count the role groups that satisfy every attribute
    const g2 = { t: 'group', attrs: parts, min: card.min, max: card.max === '*' ? Infinity : card.max };
    return card.min === 0 ? { t: 'or', items: [g2, { t: 'minus', a: { t: 'all' }, b: node }] } : g2;
  }

  eclAttribute(a) {
    const c = a.comparison;
    const card = a.cardinality;
    const pids = this.eclAttrIds(a.name);
    let node;
    if (c.type === 'ExpressionComparison') {
      const value = this.eclNode(c.value);
      if (c.operator === 'EQUALS') {
        if (!a.reverse && value.t === 'all') {
          // attr = * : any value; the hasProp sets
          const items = pids.map((pid) => ({ t: 'set', kind: KIND.hasProp, pid, value: 0 }));
          node = items.length === 1 ? items[0] : { t: 'or', items };
          node.values = value;
        } else {
          node = a.reverse ? { t: 'propOf', pids, sources: value } : { t: 'propIn', pids, values: value };
        }
      } else if (c.operator === 'NOT_EQUALS' && !a.reverse) {
        // has a value outside the set
        node = { t: 'propIn', pids, values: { t: 'minus', a: { t: 'all' }, b: value } };
      } else {
        throw new Unsupported('ecl-feature', 'attribute ' + c.operator);
      }
    } else if (c.type === 'NumericComparison' || c.type === 'StringComparison' || c.type === 'BooleanComparison') {
      node = this.eclConcrete(pids, c);
    } else {
      throw new Unsupported('ecl-feature', c.type);
    }
    if (!card || (card.min === 1 && card.max === '*')) return node;
    if (card.min === 0 && card.max === 0) return { t: 'minus', a: { t: 'all' }, b: node };
    if (card.min === 0 && card.max === '*') return { t: 'all' };
    if (c.type !== 'ExpressionComparison' || a.reverse) throw new Unsupported('ecl-feature', 'attribute cardinality on this comparison');
    // [m..n]: count the matching (group, value) occurrences on each candidate
    return { t: 'attrCard', pids, values: node.values, min: card.min, max: card.max === '*' ? Infinity : card.max, base: node };
  }

  eclConcrete(pids, c) {
    // concrete values: keys of the attribute's literal prop sets that satisfy the comparison
    const S = this.store;
    const items = [];
    for (const pid of pids) {
      const def = S.propsById.get(pid);
      if (!def) continue;
      const opName = c.operator;
      let test;
      // a value only compares with a value of its own type: a number with a number (#4000), a
      // string with a string ("4000" matches no numeric value)
      const isNum = (x) => typeof x === 'number' || (typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x) && def.type !== 'string');
      if (c.type === 'NumericComparison') {
        const v = Number(c.value);
        const cmp = { EQUALS: (x) => x === v, NOT_EQUALS: (x) => x !== v, GT: (x) => x > v, GTE: (x) => x >= v, LT: (x) => x < v, LTE: (x) => x <= v }[opName];
        test = cmp && ((x) => isNum(x) && cmp(Number(x)));
      } else if (c.type === 'BooleanComparison') {
        test = opName === 'EQUALS' ? (x) => String(x) === String(c.value ? 1 : 0) || String(x) === String(c.value) : (x) => !(String(x) === String(c.value ? 1 : 0) || String(x) === String(c.value));
      } else {
        // string values: exact, or match:/wild: as description terms are matched
        const tests = (c.values || []).map((v) => {
          if (typeof v === 'object' && v.kind) return termMatcher({ kind: v.kind === 'wild' ? 'wild' : 'match', value: v.value });
          const s = typeof v === 'object' ? v.value : v;
          return (x) => x === s;
        });
        const any = (x) => !isNum(x) && tests.some((t) => t(String(x)));
        test = opName === 'EQUALS' ? any : (x) => !isNum(x) && !tests.some((t) => t(String(x)));
      }
      if (!test) throw new Unsupported('ecl-feature', 'concrete ' + opName);
      const keys = S.propValues(pid, this.stats).filter((r) => test(r.value)).map((r) => r.value);
      items.push(litSets(pid, keys));
    }
    if (!items.length) return { t: 'empty' };
    return items.length === 1 ? items[0] : { t: 'or', items };
  }

  /**
   * ^ X {{ M ... }}: the members whose row passes every member filter (refset_member rows: active
   * only, with effectiveTime and moduleId when the file has them, and the refset's own fields)
   */
  eclMemberFilter(rid, code, filters) {
    const S = this.store;
    const rows = S.stmt('SELECT concept_id, fields, effective_time, module_id FROM refset_member WHERE refset_id = ?').all(rid);
    const def = S.stmt('SELECT field_names, field_types FROM refset_def WHERE refset_id = ?').get(rid);
    const names = def ? JSON.parse(def.field_names).map((n) => String(n).toLowerCase()) : [];
    const types = def ? JSON.parse(def.field_types) : [];
    const cmp = (actual, op, values, c) => {
      switch (op) {
        case '=': return values.some((v) => c(actual, v) === 0);
        case '!=': return !values.some((v) => c(actual, v) === 0);
        case '<': return c(actual, values[0]) < 0;
        case '<=': return c(actual, values[0]) <= 0;
        case '>': return c(actual, values[0]) > 0;
        case '>=': return c(actual, values[0]) >= 0;
        default: throw new Unsupported('ecl-feature', 'member filter operator ' + op);
      }
    };
    const str = (a, b) => String(a).localeCompare(String(b));
    const tests = filters.map((fl) => {
      const field = String(fl.field).toLowerCase();
      const setOf = () => (fl.valueType === 'expression' ? new Evaluator(S).mat(this.eclNode(fl.value)) : null);
      if (field === 'active') return () => (fl.operator === '=') === fl.value;
      if (field === 'effectivetime') return (r) => r.effective_time != null && cmp(String(r.effective_time), fl.operator, fl.values, str);
      if (field === 'moduleid') {
        const bm = setOf();
        return (r) => r.module_id != null && (fl.operator === '=' ? bm.has(r.module_id) : !bm.has(r.module_id));
      }
      const i = names.indexOf(field);
      if (i < 0) throw new FilterError(`Reference set ${code} has no field named ${fl.field}`);
      const t = types[i];
      if (fl.valueType === 'expression') {
        if (t !== 'c') throw new FilterError(`Reference set field ${fl.field} is not a concept field`);
        const bm = setOf();
        return (r) => {
          const v = r.f[i];
          if (v == null || v === '') return false;
          const id = this.id(String(v));
          const inSet = id != null && bm.has(id);
          return fl.operator === '=' ? inSet : !inSet;
        };
      }
      if (fl.valueType === 'numeric') {
        if (t !== 'i') throw new FilterError(`Reference set field ${fl.field} is not a numeric field`);
        return (r) => r.f[i] != null && r.f[i] !== '' && cmp(Number(r.f[i]), fl.operator, [Number(fl.value)], (a, b) => a - b);
      }
      if (fl.valueType === 'boolean') return (r) => (fl.operator === '=') === ((String(r.f[i]) === '1' || String(r.f[i]).toLowerCase() === 'true') === fl.value);
      // string / time
      return (r) => r.f[i] != null && r.f[i] !== '' && cmp(String(r.f[i]), fl.operator, fl.values, str);
    });
    const ids = new Set();
    for (const r of rows) {
      r.f = JSON.parse(r.fields || '[]');
      if (tests.every((t) => t(r))) ids.add(r.concept_id);
    }
    return { t: 'ids', ids: [...ids].sort((a, b) => a - b), label: `^ ${code} {{ M ... }}` };
  }

  /** attribute name expression -> property ids (attributes are concepts too) */
  eclAttrIds(name) {
    const S = this.store;
    if (name.type === 'ConceptReference') {
      const p = S.props.get(name.conceptId);
      return p ? [p.id] : [];
    }
    if (name.type === 'Wildcard') {
      return [...S.props.values()].filter((p) => /^\d+$/.test(p.code) && !p.isHierarchy).map((p) => p.id);
    }
    if (name.type === 'SubExpressionConstraint' && name.focus.type === 'ConceptReference' && !name.filters) {
      const id = this.eclConcept(name.focus.conceptId);
      const op = name.operator;
      if (!op) return this.eclAttrIds(name.focus);
      if (op === 'DESCENDANT_OR_SELF_OF' || op === 'DESCENDANT_OF') {
        const d = S.getSet(KIND.descendants, 0, id, this.stats);
        const ids = d.toArray();
        if (op === 'DESCENDANT_OR_SELF_OF') ids.push(id);
        const rows = S.conceptRows(ids, this.stats);
        const out = [];
        for (const r of rows.values()) {
          const p = S.props.get(r.code);
          if (p && !p.isHierarchy) out.push(p.id);
        }
        if (op === 'DESCENDANT_OR_SELF_OF' && S.hierarchy && S.hierarchy.code === name.focus.conceptId) out.push(S.hierarchy.id);
        return out;
      }
    }
    throw new Unsupported('ecl-feature', 'attribute name expression');
  }
}

/** FHIR search prefix comparison of a stored literal against `eq5`, `ge2020-01-01`, ... */
function searchPrefixMatch(type, spec, stored) {
  const pre = spec.substring(0, 2);
  const raw = spec.substring(2);
  let a, b;
  if (type === 'dateTime') {
    // compare at the precision of the value given: digits only (YYYY[MM[DD[hh[mm[ss]]]]])
    b = raw.replace(/\D/g, '');
    a = String(stored).replace(/\D/g, '').substring(0, b.length);
  } else {
    a = Number(stored);
    b = Number(raw);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  }
  switch (pre) {
    case 'eq': case 'ap': return a === b || (typeof a === 'string' && a === b);
    case 'ne': return a !== b;
    case 'gt': case 'sa': return a > b;
    case 'lt': case 'eb': return a < b;
    case 'ge': return a >= b;
    case 'le': return a <= b;
    default: return false;
  }
}

/** literal property = any of the stored keys: their prop sets (prefetched in one statement) */
function litSets(pid, keys) {
  if (!keys.length) return { t: 'empty' };
  const items = keys.map((v) => ({ t: 'set', kind: KIND.prop, pid, value: v }));
  return items.length === 1 ? items[0] : { t: 'or', items };
}

const DIALECT_ALIASES = {
  'en-us': '900000000000509007', 'en-gb': '900000000000508004', 'en-au': '32570271000036106', 'en-ca': '19491000087109',
  'en-nz': '271000210107', 'en-ie': '21000220103', 'fr-ca': '20581000087109', 'fr-be': '21000172104', 'nl-be': '31000172101',
  'nl-nl': '31000146106', 'es-es': '448879004', 'sv-se': '46011000052107'
};

/** ECL term matching: "match" = every word is a prefix of a word of the term; "wild" = whole-term pattern */
function termMatcher(v) {
  if (typeof v === 'string') v = { kind: 'match', value: v };
  if (v.kind === 'wild') {
    // as main's ECL wild: (cs-snomed.js): no regex, so no backtracking; a run of '*'s means one
    return wildTermMatcher(String(v.value));
  }
  const words = v.value.toLowerCase().split(/\s+/).filter(Boolean);
  const m = (t) => {
    const tw = t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return words.every((w) => tw.some((x) => x.startsWith(w)));
  };
  m.words = words;
  return m;
}

function collectIds(n, out) {
  if (!n || typeof n !== 'object') return;
  if (n.type === 'ConceptReference' && n.conceptId) out.add(n.conceptId);
  for (const v of Object.values(n)) {
    if (Array.isArray(v)) v.forEach((x) => collectIds(x, out));
    else if (v && typeof v === 'object') collectIds(v, out);
  }
}

module.exports = { Compiler, FilterError, Unsupported, splitList, uniqSorted, litSets };
