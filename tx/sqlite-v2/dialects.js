'use strict';
// Per-system filter rules on top of the generic compiler (compile.js), matching what the
// upstream providers (cs-loinc.js, cs-rxnorm.js, cs-snomed.js) accept and report.

const { FilterError, Unsupported, splitList } = require('./engine/compile');
const { KIND } = require('./store');
const { requiredLiterals } = require('./engine/regex-literals');
const regexUtilities = require('../../library/regex-utilities');

const FSN_ID = '900000000000003001';
const SYNONYM_ID = '900000000000013009';

/**
 * A filter the code system has no rule for: reported as main's providers report it since #383,
 * FILTER_NOT_UNDERSTOOD, 422 (the provider translates it, provider.js filterError)
 */
function notUnderstood(prop, op, value) {
  return new FilterError(`The filter "${prop} ${op} ${value}" is not understood or supported`, { notUnderstood: [prop, op, value] });
}

const LOINC = 'http://loinc.org';
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const SCT = 'http://snomed.info/sct';

// ---- LOINC ---------------------------------------------------------------------------------

// The filters cs-loinc.js knows (#executeFilterQuery); any other is "not supported", as there.
// Its relationship and property types are those the built-in importer creates; the relationship
// types it creates but never uses (no rows) match nothing
const LOINC_RELATIONSHIPS = new Set(['N/A', 'adjustment', 'challenge', 'CLASS', 'COMPONENT', 'count', 'analyte-divisor', 'document-kind',
  'document-role', 'document-setting', 'document-subject-matter-domain', 'document-type-of-service', 'analyte-gene', 'METHOD_TYP', 'PROPERTY',
  'rad-anatomic-location-imaging-focus', 'rad-guidance-for-action', 'rad-guidance-for-approach', 'rad-guidance-for-object',
  'rad-guidance-for-presence', 'rad-maneuver-maneuver-type', 'rad-modality-modality-subtype', 'rad-modality-modality-type',
  'rad-pharmaceutical-route', 'rad-pharmaceutical-substance-given', 'rad-reason-for-exam', 'rad-subject', 'rad-timing',
  'rad-view-aggregation', 'rad-view-view-type', 'SCALE_TYP', 'analyte-suffix', 'super-system', 'SYSTEM', 'TIME_ASPCT', 'time-modifier',
  'rad-anatomic-location-laterality', 'rad-anatomic-location-laterality-presence', 'rad-anatomic-location-region-imaged',
  'AnswerList', 'Answer', 'answers-for', 'parent', 'child']);
const LOINC_UNUSED_RELATIONSHIPS = new Set(['N/A', 'adjustment', 'challenge', 'count', 'analyte-divisor', 'analyte-gene', 'analyte-suffix',
  'super-system', 'time-modifier']);
const LOINC_PROPERTIES = new Set(['CLASSTYPE', 'ORDER_OBS', 'EXAMPLE_UNITS', 'EXAMPLE_UCUM_UNITS', 'PanelType', 'AskAtOrderEntry',
  'UNITSREQUIRED', 'Copyright', 'ValidHL7AttachmentRequest']);
const LOINC_STATUS = new Set(['NotStated', 'ACTIVE', 'DEPRECATED', 'TRIAL', 'DISCOURAGED', 'EXAMPLE', 'PREFERRED', 'Primary',
  'DocumentOntology', 'Radiology', 'NORMATIVE']);
const LOINC_GENERIC_OPS = new Set(['=', 'in', 'exists', 'regex']);
function loincKnows(c, prop, op, value) {
  if (prop === 'LIST' && op === '=' && c.id(value) != null) return true;
  if (prop === 'answer-list' && op === '=') return true;
  if (prop === 'answers-for' && (op === '=' || op === 'in')) return true;
  if ((LOINC_RELATIONSHIPS.has(prop) || LOINC_PROPERTIES.has(prop)) && LOINC_GENERIC_OPS.has(op)) {
    return op !== 'exists' || value === 'true' || value === 'false';
  }
  if (prop === 'STATUS') return op === '=' && LOINC_STATUS.has(value);
  if (prop === 'concept') return ['is-a', 'descendent-of', '=', 'in'].includes(op);
  if (prop === 'code') return ['is-a', 'descendent-of', '='].includes(op);
  if (prop === 'ancestor') return op === '=' || op === 'in';
  if (prop === 'copyright') return op === '=' && (value === 'LOINC' || value === '3rdParty');
  if (prop === '$text') return op === '>' || op === '<';
  return false;
}

const loinc = {
  name: 'loinc',
  notSupported(prop, op, value) {
    return notUnderstood(prop, op, value);
  },
  /** a relationship filter value may be the target's code or its name (Codes.Description, no case): every match */
  valuesByName(c, v) {
    const S = c.store;
    let ids = null;
    if (String(v).length >= 3) {
      try {
        ids = S.stmt('SELECT concept_id FROM concept WHERE concept_id IN (SELECT rowid FROM search_display WHERE search_display MATCH ?) AND display = ? COLLATE NOCASE AND concept_id BETWEEN ? AND ?')
          .all('"' + String(v).replace(/"/g, '""') + '"', v, S.lo, S.hi).map((r) => r.concept_id);
      } catch (e) { ids = null; }
    }
    if (!ids) ids = S.stmt('SELECT concept_id FROM concept WHERE display = ? COLLATE NOCASE AND concept_id BETWEEN ? AND ?').all(v, S.lo, S.hi).map((r) => r.concept_id);
    return ids;
  },
  searchMode: 'display',
  filter(c, prop, op, value) {
    const S = c.store;
    if (!loincKnows(c, prop, op, value)) throw loinc.notSupported(prop, op, value);
    if (op === 'in' && (LOINC_RELATIONSHIPS.has(prop) || LOINC_PROPERTIES.has(prop) || prop === 'answers-for')) {
      // in is the union of = each value (cs-loinc.js since #386): a relationship's value is a
      // part code or a part name, a property's its own value (CLASSTYPE: 1-4 or the name),
      // answers-for's an answer list or a term
      const items = [...new Set(splitList(value))].map((v) => c.filter(prop, '=', v)).filter((n) => n.t !== 'empty');
      if (!items.length) return { t: 'empty' };
      return items.length === 1 ? items[0] : { t: 'or', items };
    }
    if (LOINC_UNUSED_RELATIONSHIPS.has(prop) && !S.props.has(prop)) {
      return op === 'exists' && value === 'false' ? { t: 'minus', a: { t: 'all' }, b: { t: 'empty' } } : { t: 'empty' };
    }
    if (prop === 'STATUS' && value === 'NotStated' && S.props.has(prop)) {
      // upstream's status key 0: the codes the release gives no status (answer lists, answers,
      // hierarchy-only parts, parts without one), and any it calls NotStated
      const p = S.props.get(prop);
      return { t: 'or', items: [{ t: 'minus', a: { t: 'all' }, b: { t: 'set', kind: KIND.hasProp, pid: p.id, value: 0 } }, c.propertyFilter(p, '=', value)] };
    }
    if (prop === 'parent' && op === 'regex' && S.hierarchy) {
      // the codes whose parent's name matches (a relationship regex, as for the other links)
      return { t: 'propIn', pids: [S.hierarchy.id], values: { t: 'text', field: 'display', re: value } };
    }
    if (prop === 'LIST' && op === '=') {
      // answers-for = [answer list], kept for backwards compatibility (cs-loinc.js, UP-645).
      // Upstream supports it only for a code LOINC has
      const id = c.id(value);
      if (id == null) throw loinc.notSupported(prop, op, value);
      // in upstream's order (ORDER BY its key), which is not the list's sequence: answers by
      // where they first appear in the release (engine.js _firstSeen)
      const ans = S.props.get('Answer');
      return { t: 'set', kind: KIND.refset, pid: 0, value: id, ...(ans ? { order: 'firstSeen', via: ans.id } : {}) };
    }
    if (prop === 'AnswerList' && !S.props.has(prop)) {
      // upstream's AnswerList relationship (a term or an answer -> its answer lists): the
      // inverse of Answer and answers-for (cs_config.inverseProperties). = and regex match the
      // list's code or name, in its codes, exists true or false
      const pids = ['Answer', 'answers-for'].map((n) => S.props.get(n)).filter(Boolean).map((p) => p.id);
      // upstream's key order: terms, then answers where they first appear (engine.js _firstSeen)
      const ans = S.props.get('Answer');
      const of = (sources) => ({ t: 'propOf', pids, sources, ...(ans ? { order: 'firstSeen', via: ans.id } : {}) });
      if (op === '=') return of({ t: 'ids', ids: [...new Set(c.valueIds(value))].sort((a, b) => a - b) });
      if (op === 'in') {
        const m = c.ids(splitList(value));
        return of({ t: 'ids', ids: [...new Set([...m.values()].filter((x) => x != null))].sort((a, b) => a - b) });
      }
      if (op === 'regex') return of({ t: 'text', field: 'display', re: value });
      if (op === 'exists' && (value === 'true' || value === 'false')) {
        const n = of({ t: 'all' });
        return value === 'true' ? n : { t: 'minus', a: { t: 'all' }, b: n };
      }
      throw loinc.notSupported(prop, op, value);
    }
    if (prop === 'child' && !S.props.has(prop) && S.hierarchy) {
      // upstream's child relationship (a part -> the parts and terms below it): the inverse of
      // parent, so child = X is X's parents. = takes a code or a name, in codes only, regex the
      // child's name, exists true or false (cs-loinc.js relationship filters)
      const parents = (of) => ({ t: 'hier', dir: 'parents', self: false, of });
      if (op === '=') return parents({ t: 'ids', ids: [...new Set(c.valueIds(value))].sort((a, b) => a - b) });
      if (op === 'in') {
        const m = c.ids(splitList(value));
        return parents({ t: 'ids', ids: [...new Set([...m.values()].filter((x) => x != null))].sort((a, b) => a - b) });
      }
      if (op === 'regex') return parents({ t: 'text', field: 'display', re: value });
      if (op === 'exists' && (value === 'true' || value === 'false')) {
        const n = parents({ t: 'all' });
        return value === 'true' ? n : { t: 'minus', a: { t: 'all' }, b: n };
      }
      throw loinc.notSupported(prop, op, value);
    }
    if (prop === 'ancestor' && op === '=') {
      // implicit part value sets (http://loinc.org/vs/LP...): the codes below the part
      const id = c.id(value);
      return id == null ? { t: 'empty' } : { t: 'set', kind: KIND.descendants, pid: 0, value: id };
    }
    if (prop === 'ancestor' && op === 'in') {
      // the union over the parts (cs-loinc.js, #331)
      const m = c.ids(splitList(value));
      const ids = [...new Set([...m.values()].filter((x) => x != null))];
      if (!ids.length) return { t: 'empty' };
      const n = ids.map((id) => ({ t: 'set', kind: KIND.descendants, pid: 0, value: id }));
      return n.length === 1 ? n[0] : { t: 'or', items: n };
    }
    if (prop === 'answers-for' && op === '=') {
      const id = c.id(value);
      if (id == null) return { t: 'empty' };
      if (String(value).startsWith('LL')) return { t: 'set', kind: KIND.refset, pid: 0, value: id };
      const p = S.props.get('answers-for');
      // a term's answers: its lists in order, each in its sequence (as upstream lists them)
      return { t: 'refsetOf', of: { t: 'set', kind: KIND.prop, pid: p.id, value: id }, order: 'lists' };
    }
    if (prop === 'answer-list' && op === '=') {
      // the answer lists (LL) an answer (LA) is in: the sources of Answer = value, by code only
      // (cs-loinc.js, #371, UP-645). Any other code, an answer list included, is in none
      const id = c.id(value);
      const p = S.props.get('Answer');
      return id == null || !p ? { t: 'empty' } : { t: 'set', kind: KIND.prop, pid: p.id, value: id };
    }
    if (prop === 'copyright' && op === '=') {
      const p = S.props.get('Copyright');
      const has = { t: 'set', kind: KIND.hasProp, pid: p ? p.id : -1, value: 0 };
      if (value === 'LOINC') return { t: 'minus', a: { t: 'all' }, b: has };
      if (value === '3rdParty') return has;
      throw loinc.notSupported(prop, op, value);
    }
    // CLASSTYPE = takes the code (1-4) or its name ("Laboratory class", ...), as upstream does;
    // the generic literal rule maps names through cs_config.propertyValueDescriptions. Upstream
    // stores the name, and maps a code to it for = only: in and regex match the names
    const names = S.config.propertyValueDescriptions && S.config.propertyValueDescriptions.CLASSTYPE;
    if (prop === 'CLASSTYPE' && names && S.props.has(prop) && op === 'regex') {
      const re = regexUtilities.compile('^(?:' + value + ')$');
      const codes = Object.keys(names).filter((k) => re.test(String(names[k])));
      return codes.length ? c.propertyFilter(S.props.get(prop), 'in', codes.join(',')) : { t: 'empty' };
    }
    // in, on a property the file has beyond cs-loinc.js's lists: only the values that are LOINC
    // codes (the rule cs-loinc.js had before #386; its own properties and relationships are the
    // union of = above)
    if (op === 'in' && S.props.has(prop) && !(c.inverseOf && c.inverseOf(prop))) {
      const p = S.props.get(prop);
      const m = c.ids(splitList(value));
      const known = [...m].filter(([, id]) => id != null).map(([v]) => v);
      if (!known.length || p.kind !== 'concept') return { t: 'empty' };
      return c.propertyFilter(p, 'in', known.join(','));
    }
    return null;
  }
};

// ---- RxNorm --------------------------------------------------------------------------------

const rxnorm = {
  name: 'rxnorm',
  // text filter: cs-rxnorm.js's stem search (text-index.js rxTextSearch)
  searchMode: 'rxnorm',
  // every upstream query is over RXNCONSO: archived concepts (RXNATOMARCHIVE only) are never
  // selected; obsolete ones (inactive, but in RXNCONSO) are. RXNCONSO concepts are the ones with
  // a SUPPRESS literal; a file without SUPPRESS has no obsolete concepts, so its active set.
  domain: 'live',
  live(S) {
    const p = S.props.get('SUPPRESS');
    return p ? { t: 'set', kind: KIND.hasProp, pid: p.id, value: 0 } : { t: 'active' };
  },
  notSupported(prop, op, value) {
    return notUnderstood(prop, op, value);
  },
  /**
   * cs-rxnorm.js doesFilter / filter: `=` and `in` only, with at least one value; on TTY, STY and
   * SAB (any case), on concept and code, and on a relationship - a REL or RELA that RXNREL has,
   * from any source - whose values are all CUI:<rxcui>. Anything else is FILTER_NOT_UNDERSTOOD,
   * 422, including an AUI:<rxaui> value, which cs-rxnorm.js follows over the atom-level rows of
   * every source: the file holds no atom-level rows (a table rxnorm_atom_rel in a file built by an
   * earlier importer is not read). A filter on a property a supplement in use defines is left to the
   * supplement layer, as before.
   */
  filter(c, prop, op, value) {
    const S = c.store;
    const up = String(prop).toUpperCase();
    const refuse = () => {
      const n = c.term && c.term.layers && !S.props.has(prop) ? c.term.layers.filterNode(c, prop, op, value) : null;
      if (n) return n;
      throw rxnorm.notSupported(prop, op, value);
    };
    if (op !== '=' && op !== 'in') return refuse();
    // cs-rxnorm.js #filterValues
    const vals = op === 'in' ? splitList(value) : (value != null && String(value).trim() ? [String(value).trim()] : []);
    if (!vals.length) return refuse();
    if (up === 'TTY' || up === 'STY' || up === 'SAB') {
      // property names are case-insensitive upstream; the generic rule matches the literal
      const v = op === '=' ? vals[0] : value;
      if (prop !== up || !S.props.has(up) || v !== value) return c.filter(up, op, v);
      return null;
    }
    if (prop === 'concept' || prop === 'code') return null; // the generic rule: the codes listed
    const rels = S.config.rxRels || Object.keys(S.config.relaByRel || {});
    const relas = S.config.rxRelas || [...S.props.values()].filter((p) => p.kind === 'concept').map((p) => p.code);
    const isRel = rels.includes(prop);
    if (!isRel && !relas.includes(prop)) return refuse();
    if (!vals.every((v) => v.startsWith('CUI:'))) return refuse();
    // RxNorm's own concept-level rows (SAB = RXNORM), as concept-valued properties. A REL or RELA
    // only other sources' or atom-level rows have names no property here, so selects nothing.
    const relaMap = S.config.relaByRel || {};
    const pids = (isRel ? (relaMap[prop] || []) : [prop]).map((a) => S.props.get(a)).filter((p) => p && p.kind === 'concept').map((p) => p.id);
    const m = c.ids(vals.map((v) => v.substring(4)));
    const ids = [...new Set([...m.values()].filter((x) => x != null))];
    const items = pids.flatMap((pid) => ids.map((id) => ({ t: 'set', kind: KIND.prop, pid, value: id })));
    return items.length === 0 ? { t: 'empty' } : items.length === 1 ? items[0] : { t: 'or', items };
  }
};

// ---- SNOMED CT -----------------------------------------------------------------------------

function sctId(v) {
  return /^\s*\d{6,18}\s*$/.test(String(v));
}

const snomed = {
  name: 'snomed',
  searchMode: 'designation',
  generalizesExcludesSelf: true, // as cs-snomed.js filterGeneralizes(id, false)
  strictIn: true, // concept in X,Y: an unknown concept is an error (cs-snomed.js filterIn)
  notSupported(prop, op, value) {
    return notUnderstood(prop, op, value);
  },
  /** ECL the engine refuses: evaluated by main's ECL (cs-snomed.js) over this file, as ids */
  eclFallback(c, text, e) {
    const M = require('./sct-main-ecl');
    const kept = M.mainEclResult(c.store, text);
    if (kept === undefined) throw new M.NeedsMainEcl(c.store, text);
    const bm = kept.bm;
    if (kept.err) {
      const err = kept.err;
      const msg = err && err.message ? err.message : String(err);
      if ((err && err.eclInvalid) || /is not known/.test(msg)) throw new FilterError(msg, { eclUnknown: true });
      throw new Unsupported('ecl-feature', msg);
    }
    void e;
    return { t: 'ids', ids: bm.toArray(), label: 'ECL (main) ' + text.slice(0, 60) };
  },
  rootNode(c) {
    const id = c.id('138875005');
    return id == null ? { t: 'empty' } : { t: 'ids', ids: [id] };
  },
  unknownConcept(c, op, value) {
    throw new FilterError(`The SNOMED CT Concept ${value} is not known`, { unknownConcept: value });
  },
  /**
   * concept in X,Y,…: a refset contributes its active members, any other concept itself (owner and
   * THO, 2026-11-02; tx-ecosystem sct/*-concept-in). An unknown concept is an error (strictIn).
   */
  conceptIn(c, ids) {
    const S = c.store;
    const sets = S.loadSets(KIND.refset, 0, ids, c.stats);
    const items = [];
    const plain = [];
    for (const id of ids) {
      if (sets.get(id) && sets.get(id).size) items.push({ t: 'set', kind: KIND.refset, pid: 0, value: id });
      else plain.push(id);
    }
    if (plain.length) items.push({ t: 'ids', ids: plain });
    return items.length === 1 ? items[0] : { t: 'or', items };
  },
  filter(c, prop, op, value) {
    const S = c.store;
    // code is the same filter property as concept (cs-snomed.js #filterProperty; tx-ecosystem
    // sct/*-code-in), and is reported as concept
    if (prop === 'concept' || prop === 'code') {
      // cs-snomed.js SNOMED_CONCEPT_FILTER_OPS (no not-in, regex or exists)
      if (!['=', 'is-a', 'descendent-of', 'child-of', 'generalizes', 'in', 'is-not-a', 'descendent-leaf'].includes(op)) {
        throw notUnderstood('concept', op, value);
      }
      if (op !== 'in' && !sctId(value)) throw new FilterError(`Invalid concept ID: ${value}`);
      return null; // generic concept rules
    }
    if (prop === 'inactive') {
      if (op !== '=') throw notUnderstood(prop, op, value);
      if (value !== 'true' && value !== 'false') throw new FilterError(`Invalid filter value: ${value}`);
      return value === 'true' ? { t: 'inactive' } : { t: 'active' };
    }
    if (prop === 'constraint') {
      if (op !== '=') throw notUnderstood(prop, op, value);
      return c.ecl(value);
    }
    if (prop === 'moduleId') {
      if (op !== '=') throw notUnderstood(prop, op, value);
      if (!sctId(value)) throw new FilterError(`Invalid concept ID: ${value}`);
      const id = c.id(value);
      return id == null ? { t: 'empty' } : { t: 'set', kind: KIND.prop, pid: S.props.get('module').id, value: id };
    }
    if (prop === 'expressions' && op === '=') {
      // true: expressions are allowed as well (an expansion still lists only concepts; an
      // expression's membership is decided by main's services over this file, see snomed.js)
      if (value === 'true') return { t: 'all', expressionsTrue: true };
      return { t: 'all', expressionsFalse: true };
    }
    if (String(prop).startsWith('mapped:')) {
      // mapped:<identifier scheme> exists true|false: concepts with (or without) an alternate
      // identifier in that scheme (e.g. 30051010000102: a LOINC code)
      const scheme = String(prop).substring('mapped:'.length);
      if (!sctId(scheme)) throw notUnderstood(prop, op, value);
      if (op !== 'exists') throw notUnderstood(prop, op, value);
      if (value !== 'true' && value !== 'false') throw new FilterError(`Invalid filter value: ${value}`);
      const sid = c.id(scheme);
      const ids = sid == null ? [] : S.stmt('SELECT DISTINCT concept_id FROM alternate_identifier WHERE scheme_id = ? ORDER BY concept_id').pluck().all(sid);
      const has = { t: 'ids', ids, label: `${prop} exists` };
      return value === 'true' ? has : { t: 'minus', a: { t: 'all' }, b: has };
    }
    if (prop === 'display' && op === 'regex') {
      // tx-ecosystem requirements (display regex): any active FSN or synonym in the one language the
      // request chooses (c.term.lang) matches the whole term, case-sensitively
      const lits = S.hasFts ? requiredLiterals(value) : [];
      const lang = c.term.lang || 'en';
      return { t: 'desigRegex', re: String(value), lang, uses: [FSN_ID, SYNONYM_ID], ...(lits.length ? { lits } : {}), label: `display (${lang}) ~ /${value}/` };
    }
    // display: regex only, as cs-snomed.js
    if (prop === 'display') throw notUnderstood(prop, op, value);
    if (sctId(prop)) {
      if (op !== '=') throw notUnderstood(prop, op, value);
      if (!sctId(value)) throw new FilterError(`Invalid concept ID: ${value}`);
      const p = S.props.get(String(prop).trim());
      const id = c.id(value);
      if (!p || id == null) return { t: 'empty' };
      return { t: 'set', kind: KIND.prop, pid: p.id, value: id };
    }
    return null; // generic rules (supplement properties, ...); unknown properties fail there
  }
};

const generic = { name: 'generic' };

function dialectFor(system) {
  if (system === LOINC) return loinc;
  if (system === RXNORM) return rxnorm;
  if (system === SCT) return snomed;
  return generic;
}

module.exports = { dialectFor, LOINC, RXNORM, SCT };
