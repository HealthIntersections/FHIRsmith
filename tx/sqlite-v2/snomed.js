'use strict';
// SNOMED CT on sqlite-v2: editions and versions, display and designation rules, $lookup
// properties, ECL error reporting, implicit value sets (?fhir_vs...) and the implicit concept
// maps of the historical association reference sets (?fhir_cm=...). Semantics follow
// tx/cs/cs-snomed.js; membership comes from the engine like every other system.

const { SqliteV2Provider, SqliteV2Factory } = require('./provider');
const { KIND } = require('./store');
const { Issue } = require('../library/operation-outcome');
const { ECLLexer, ECLParser } = require('../sct/ecl');
const { ConceptMap } = require('../library/conceptmap');
const { editionName, editionCode } = require('../sct/editions');
const { formatDateMMDDYYYY } = require('../../library/utilities');

const SCT = 'http://snomed.info/sct';
const FSN = '900000000000003001';
const SYNONYM = '900000000000013009';
const PREFERRED = '900000000000548007';
const IS_A = '116680003';
const ASSOCIATIONS = {
  '900000000000523009': ['POSSIBLY EQUIVALENT TO', 'inexact'],
  '900000000000526001': ['REPLACED BY', 'equivalent'],
  '900000000000527005': ['SAME AS', 'equal'],
  '900000000000530003': ['ALTERNATIVE', 'inexact']
};
const IDENTIFIER_SCHEMES = { '30051010000102': { system: 'http://loinc.org', property: 'loinc' } };
// whether props names this property explicitly (property=* does not count)
const askedFor = (props, name) => !!props && props.some((p) => p && String(p).toLowerCase() === name.toLowerCase());
const isConceptId = (code) => /^\s*\d+\s*$/.test(String(code));
// post-coordinated expressions and the edition / identifier translations: sct-native.js, over
// this file (stored normal forms, MRCM from the file)
const native = require('./sct-native');
const E = require('../sct/expressions');
const { cannotDetermineSubsumption } = require('../cs/cs-api');
const { DesignationUse } = require('../library/designations');

/** an expression located natively */
class NativeExprContext {
  constructor(source, expression) {
    this.source = source;
    this.code = source;
    this.expression = expression;
  }
  isComplex() { return this.expression.isComplex(); }
  getReference() { return this.expression.concepts[0].reference; }
}

class SnomedV2Provider extends SqliteV2Provider {
  name() { return `SNOMED CT ${editionName(this.f.edition()) || 'Unknown Edition'}`; }
  description() { return this.name(); }
  lookupName() { return this.name(); }
  versionAlgorithm() { return 'url'; }
  isNotClosed() { return true; }
  hasParents() { return true; }
  hasMultiHierarchy() { return true; }

  versionIsMoreDetailed(check, actual) {
    return !!actual && !!check && actual.startsWith(check);
  }

  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);
    if (this._hasAnySupplementDisplays(langs)) return true;
    return langs.isEnglishOrNothing();
  }

  normaliseCode(code) {
    const s = String(code).trim();
    // as BigInt(code): leading zeros are tolerated
    return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : s;
  }

  /** a concept id as stored: an expression, or an id with spaces or leading zeros, goes through locate() */
  _plainListedCode(code) { return typeof code === 'string' && /^[1-9]\d*$/.test(code); }

  /** native expression services for this request */
  _native() {
    if (!this._nativeSvc) {
      this._nativeSvc = new native.NativeExpressionServices(this.store, {
        compilerFor: () => { const c = this._compiler(); c.engineFor = () => this.engine; return c; }
      });
    }
    return this._nativeSvc;
  }

  async _locate(code, prefetched = null) {
    if (code == null || code === '') return { context: null, message: 'Empty code' };
    if (!isConceptId(code)) return this._nativeLocate(String(code));
    const r = await super._locate(code, prefetched);
    if (r.context) r.context.code = r.context.row ? r.context.row.code : r.context.code;
    return r;
  }

  isDisplay(d) {
    return !!(d && d.use && d.use.system === SCT && (d.use.code === SYNONYM || d.use.code === FSN));
  }

  async _designations(context, displays, significantOnly = false) {
    const c = await this._ensure(context);
    if (!c) return;
    if (!c.desigs && c.displayOnly) {
      this._displayOnly(c, displays);
      return;
    }
    this._needDesigs(c);
    const refsets = this.f.displayRefsetIds();
    const isPreferredIn = (d, ids) => !!d.acc && d.acc.split(',').some((a) => { const [r, v] = a.split(':'); return v === String(this.f.preferredId()) && (!ids || ids.includes(Number(r))); });
    // v5 files: the rank the importer stored (0 preferred in a display refset, 1 in another, 2 not)
    const rankOf = (d) => (d.rank != null ? d.rank : (!d.use || d.use.code !== SYNONYM ? 2 : isPreferredIn(d, refsets) ? 0 : isPreferredIn(d, null) ? 1 : 2));
    const use = (d) => (d.use ? { system: SCT, code: d.use.code, display: d.use.display } : null);
    if (significantOnly) {
      const lang = 'en';
      displays.addDesignation(true, 'active', lang === 'en' ? 'en-US' : lang, null, c.row.display || '');
      const seenFsn = new Set();
      const seenSyn = new Set();
      for (const d of c.desigs) {
        if (!d.active || !d.use) continue;
        if (d.use.code === FSN && !seenFsn.has(d.language)) {
          seenFsn.add(d.language);
          displays.addDesignation(false, 'active', d.language, use(d), d.term);
        }
      }
      for (const d of c.desigs) {
        if (!d.active || !d.use || d.use.code !== SYNONYM || seenSyn.has(d.language)) continue;
        if (rankOf(d) <= 1) {
          seenSyn.add(d.language);
          displays.addDesignation(false, 'active', d.language, use(d), d.term);
        }
      }
    } else {
      // each designation ranked once, not in every comparison
      const list = c.desigs.map((d, i) => ({ d, i, r: rankOf(d) })).sort((a, b) => (a.r - b.r) || (a.i - b.i));
      for (const { d } of list) displays.addDesignation(false, d.active ? 'active' : 'inactive', d.language, use(d), d.term);
    }
    this._listSupplementDesignations(c.code, displays);
  }

  /** the concept's text definition (900000000000550004), as the release states it */
  async definition(context) {
    const c = await this._ensure(context);
    return c && c.row ? c.row.definition || null : null;
  }

  async getStatus(context) {
    const c = await this._ensure(context);
    return c.row.active ? 'active' : 'inactive';
  }

  async isDeprecated() { return false; }

  async _extendLookup(context, props, params, noNormalForm = false) {
    const c = await this._ensure(context);
    if (!c) return;
    const S = this.store;
    const st = this._stats();
    const links = S.linksFrom([c.id], null, true, st);
    // in release order where the file has it (cs-snomed.js: parents and relationships in
    // relationship-file order); otherwise as read
    const seqs = S.linkSeqFrom(c.id);
    if (seqs) {
      const at = (l) => seqs.get(l.p + ':' + (l.g || 0) + ':' + l.t) ?? Infinity;
      links.sort((a, b) => at(a) - at(b));
    }
    const lits = S.literalsOf([c.id], true, st);
    const hid = S.hierarchy.id;
    const children = S.getSet(KIND.prop, hid, c.id, st).toArray();
    const childOrder = S.linkSourcesInOrder(hid, c.id);
    const want = new Set([...links.map((l) => l.t), ...children]);
    const attrCodes = [...new Set(links.map((l) => S.propsById.get(l.p)).filter((p) => p && /^\d+$/.test(p.code)).map((p) => p.code))];
    const attrIds = S.resolveCodes(attrCodes, st);
    for (const id of attrIds.values()) want.add(id);
    want.delete(undefined);
    want.delete(null);
    const rows = S.conceptRows([...want], st);
    const disp = (id) => (rows.get(id) ? rows.get(id).display : null);
    const code = (id) => (rows.get(id) ? rows.get(id).code : null);
    if (this._hasProp(props, 'effectiveTime', true)) {
      const et = lits.find((r) => S.propsById.get(r.p).code === 'effectiveTime');
      if (et) this._addDateTimeProperty(params, 'property', 'effectiveTime', fmtDate(String(et.v)));
    }
    if (this._hasProp(props, 'parent', true)) {
      for (const l of links) if (l.p === hid) this._addCodeProperty(params, 'property', 'parent', code(l.t), null, disp(l.t));
    }
    if (this._hasProp(props, 'child', true)) {
      const byCode = (a, b) => (code(a).length - code(b).length) || (code(a) < code(b) ? -1 : code(a) > code(b) ? 1 : 0);
      // release order (cs-snomed.js getConceptChildren: inbound is-a rows by row), else by code
      let ordered = [...children].sort(byCode);
      if (childOrder) {
        const kids = new Set(children);
        const inOrder = [...new Set(childOrder.filter((id) => kids.has(id)))];
        const placed = new Set(inOrder);
        ordered = [...inOrder, ...ordered.filter((id) => !placed.has(id))];
      }
      for (const id of ordered) this._addCodeProperty(params, 'property', 'child', code(id), null, disp(id));
    }
    // moduleId, as the SNOMED CT on FHIR page names it ("module" asked for by name is still
    // understood, and answered as moduleId), as main (#331)
    if (this._hasProp(props, 'moduleId', true) || askedFor(props, 'module')) {
      const m = links.find((l) => S.propsById.get(l.p).code === 'module');
      if (m) this._addCodeProperty(params, 'property', 'moduleId', code(m.t), null, disp(m.t));
    }
    // returned for property=* or by name, not by default
    if (this._hasProp(props, 'sufficientlyDefined', false)) {
      // SNOMED CT on FHIR: true when the concept is fully defined (definitionStatus 900000000000073002)
      const ds = links.find((l) => S.propsById.get(l.p).code === 'definitionStatusId');
      if (ds) {
        const dsCode = S.conceptRows([ds.t], st).get(ds.t);
        params.push({ name: 'property', part: [{ name: 'code', valueCode: 'sufficientlyDefined' }, { name: 'value', valueBoolean: !!dsCode && dsCode.code === '900000000000073002' }] });
      }
    }
    if (this._hasProp(props, 'semanticTag', false)) {
      // the bracketed suffix of the concept's active fully specified name
      this._needDesigs(c);
      for (const d of c.desigs || []) {
        if (!d.active || !d.use || d.use.code !== FSN) continue;
        const m = /\(([^()]+)\)\s*$/.exec(d.term || '');
        if (m) {
          params.push({ name: 'property', part: [{ name: 'code', valueCode: 'semanticTag' }, { name: 'value', valueString: m[1] }] });
          break;
        }
      }
    }
    const seen = new Set();
    for (const l of links) {
      const p = S.propsById.get(l.p);
      if (!p || !/^\d+$/.test(p.code) || p.code === IS_A || !this._hasProp(props, p.code, true)) continue;
      const k = p.code + ':' + code(l.t);
      if (seen.has(k)) continue;
      seen.add(k);
      const pr = this._addCodeProperty(params, 'property', p.code, code(l.t), null, disp(l.t));
      const tid = attrIds.get(p.code);
      pr.part.push({ name: 'code-display', valueString: rows.get(tid) ? rows.get(tid).display : p.display || p.code });
    }
    // concrete values (literal attributes), when asked for by id: typed as the attribute's range
    // in the MRCM says (int / dec), booleans and strings as stored
    const concreteLits = lits.filter((l) => { const p = S.propsById.get(l.p); return p && /^\d+$/.test(p.code) && this._hasProp(props, p.code, true); })
      .sort((a, b) => (S.propsById.get(a.p).code < S.propsById.get(b.p).code ? -1 : 1));
    for (const l of concreteLits) {
      const p = S.propsById.get(l.p);
      const aid = S.idOf(p.code);
      const adisp = aid != null && S.conceptRows([aid], st).get(aid) ? S.conceptRows([aid], st).get(aid).display : p.display || p.code;
      let value;
      if (p.type === 'boolean') value = { valueBoolean: l.v === 1 || l.v === 'true' || l.v === '1' };
      else if (p.type === 'string') value = { valueString: String(l.v) };
      else value = this._concreteIsInteger(p.code) ? { valueInteger: Math.round(Number(l.v)) } : { valueDecimal: Number(l.v) };
      params.push({ name: 'property', part: [{ name: 'code', valueCode: p.code }, { name: 'value', ...value }, { name: 'code-display', valueString: adisp }] });
    }
    const ids = S.stmt('SELECT s.code AS scheme, a.identifier FROM alternate_identifier a JOIN concept s ON s.concept_id = a.scheme_id WHERE a.concept_id = ?').all(c.id);
    for (const r of ids) {
      const scheme = IDENTIFIER_SCHEMES[r.scheme];
      if (scheme && this._hasProp(props, scheme.property, true)) {
        params.push({ name: 'property', part: [{ name: 'code', valueCode: scheme.property }, { name: 'value', valueCoding: { system: scheme.system, code: r.identifier } }] });
      }
    }
    if (!noNormalForm) this._addNormalForms(c.id, null, props, params);
  }

  /**
   * normalForm (with terms) and normalFormTerse (without), for a concept or an expression: only
   * when asked for by name (not by default, not by property=*), as main (#331)
   */
  _addNormalForms(id, expression, props, params) {
    const wantFull = askedFor(props, 'normalForm');
    const wantTerse = askedFor(props, 'normalFormTerse');
    if (!wantFull && !wantTerse) return;
    const svc = this._native();
    const nf = expression ? svc.normaliseExpression(expression) : svc.createNormalForm(id);
    if (wantFull) params.push({ name: 'property', part: [{ name: 'code', valueCode: 'normalForm' }, { name: 'value', valueString: svc.renderExpression(nf, E.SnomedServicesRenderOption.FillMissing) }] });
    if (wantTerse) params.push({ name: 'property', part: [{ name: 'code', valueCode: 'normalFormTerse' }, { name: 'value', valueString: svc.renderExpression(nf, E.SnomedServicesRenderOption.Minimal) }] });
  }

  /** whether a concrete attribute's MRCM range (refset 723562003) is an integer: int(...) */
  _concreteIsInteger(attrCode) {
    const S = this.store;
    const rs = S.idOf('723562003');
    const a = S.idOf(attrCode);
    if (rs == null || a == null) return false;
    const r = S.stmt('SELECT fields FROM refset_member WHERE refset_id = +? AND concept_id = +? LIMIT 1').get(rs, a);
    return !!r && /^\s*int\(/i.test(JSON.parse(r.fields || '[]')[0] || '');
  }

  async subsumesTest(codeA, codeB) {
    if (!isConceptId(codeA) || !isConceptId(codeB)) return this._nativeSubsumes(codeA, codeB);
    return super.subsumesTest(codeA, codeB);
  }

  // ---- native post-coordination -----------------------------------------------------------

  async _nativeLocate(code) {
    const svc = this._native();
    try {
      const exp = new E.SnomedExpressionParser().parse(code);
      svc.checkExpression(exp);
      if (exp.isSimple() && !exp.concepts[0].literal) {
        // a single concept (with its term, say): the concept itself
        return super._locate(exp.concepts[0].code);
      }
      return { context: new NativeExprContext(code, exp), message: null };
    } catch (e) {
      return { context: null, message: `Not a valid expression: ${e.message}` };
    }
  }

  async _nativeSubsumes(codeA, codeB) {
    const svc = this._native();
    try {
      const a = new E.SnomedExpressionParser(svc.conceptList).parse(codeA);
      const b = new E.SnomedExpressionParser(svc.conceptList).parse(codeB);
      if (a.isSimple() && b.isSimple()) {
        const ra = a.concepts[0].reference;
        const rb = b.concepts[0].reference;
        if (ra === rb) return 'equivalent';
        if (svc.subsumes(ra, rb)) return 'subsumes';
        if (svc.subsumes(rb, ra)) return 'subsumed-by';
        return 'not-subsumed';
      }
      const b1 = svc.expressionSubsumes(a, b);
      const b2 = svc.expressionSubsumes(b, a);
      if (b1 && b2) return 'equivalent';
      if (b1) return 'subsumes';
      if (b2) return 'subsumed-by';
      throw cannotDetermineSubsumption('Unable to determine the subsumption relationship between '
        + `'${codeA}' and '${codeB}': at least one is a postcoordinated expression and no `
        + 'relationship follows from comparing their normal forms. Establishing that there '
        + 'is no relationship would require classification, which this server does not do, '
        + 'so no outcome is returned rather than one that may be wrong');
    } catch (error) {
      if (error.statusCode) throw error;
      throw new Error(`Error in subsumption test: ${error.message}`);
    }
  }

  /** an expression's membership of a filter set, natively (as main decides it) */
  async _nativeMember(set, ctxt) {
    const svc = this._native();
    const specs = set.specs || [];
    for (const f of specs) {
      if (f.prop === 'expressions' && f.op === '=') {
        if (String(f.value) === 'false' && ctxt.isComplex()) return false;
        continue;
      }
      if (f.prop === 'constraint' && f.op === '=' && ctxt.isComplex()) {
        let ast;
        try { ast = new ECLParser(new ECLLexer(String(f.value)).tokenize()).parse(); } catch (e) { return false; }
        if (!svc.exprSatisfies(ctxt.expression, ast)) return false;
        continue;
      }
      // any other filter: its focus concept is tested (as main does)
      const node = this._compiler().filter(f.prop, f.op, f.value);
      if (!this.engine.contains(node, ctxt.getReference(), this._trace)) return false;
    }
    return true;
  }

  async _nativeLookup(ctxt, props, params) {
    if (ctxt.expression.concepts.length === 1) {
      const r = await super._locate(ctxt.expression.concepts[0].code);
      if (r.context) await this._extendLookup(r.context, props, params, true);
    }
    this._addNormalForms(null, ctxt.expression, props, params);
    const svc = this._native();
    const add = async (refinement) => {
      const value = new NativeExprContext('', refinement.value);
      const code = value.isComplex() ? svc.renderExpression(refinement.value, E.SnomedServicesRenderOption.Minimal) : refinement.value.concepts[0].code;
      const description = value.isComplex() ? svc.renderExpression(refinement.value, E.SnomedServicesRenderOption.FillMissing) : svc.getDisplayName(refinement.value.concepts[0].reference);
      const p = this._addCodeProperty(params, 'property', refinement.name.code, code, null, description);
      p.part.push({ name: 'code-display', valueString: svc.getDisplayName(refinement.name.code) });
    };
    for (const r of ctxt.expression.refinements) await add(r);
    for (const g of ctxt.expression.refinementGroups) for (const r of g.refinements) await add(r);
  }

  /** translation by alternate identifier (e.g. the LOINC Extension's LOINC codes), both ways */
  async _nativeByIdentifier(map, coding, target) {
    const { schemes } = map.jsonObj.identifierMap;
    const targetSystem = target ? target.split('|')[0] : null;
    const S = this.store;
    const out = [];
    if (coding.system === SCT) {
      const id = S.idOf(this.normaliseCode(coding.code));
      if (id == null) return [];
      for (const r of S.stmt('SELECT s.code AS scheme, a.identifier FROM alternate_identifier a JOIN concept s ON s.concept_id = a.scheme_id WHERE a.concept_id = ?').all(id)) {
        const scheme = IDENTIFIER_SCHEMES[r.scheme];
        if (scheme && schemes.includes(r.scheme) && (!targetSystem || targetSystem === scheme.system)) {
          out.push({ map: map.vurl, system: scheme.system, code: r.identifier, relationship: 'equivalent' });
        }
      }
    } else if (!targetSystem || targetSystem === SCT) {
      for (const schemeId of schemes) {
        const scheme = IDENTIFIER_SCHEMES[schemeId];
        if (!scheme || scheme.system !== coding.system) continue;
        const sid = S.idOf(schemeId);
        if (sid == null) continue;
        for (const r of S.stmt('SELECT c.code FROM alternate_identifier a JOIN concept c ON c.concept_id = a.concept_id WHERE a.scheme_id = ? AND a.identifier = ?').all(sid, coding.code)) {
          out.push({ map: map.vurl, system: SCT, version: this.version(), code: r.code, display: await this.display(r.code), relationship: 'equivalent' });
        }
      }
    }
    return out;
  }

  /** translation to an edition this one depends on, from the definitions (as main does it) */
  async _nativeToEdition(map, coding) {
    const ed = map.jsonObj.editionTranslation;
    const svc = this._native();
    const S = this.store;
    const src = S.idOf(this.normaliseCode(coding.code));
    if (src == null) return [];
    const inTarget = (id) => ed.modules.has(svc.moduleOf(id));
    const name = (id) => svc.getDisplayName(id);
    const mk = (code, display, relationship) => ({ map: map.vurl, system: SCT, version: ed.version, code, display, relationship });
    const named = (id) => `${svc.getConceptId(id)} |${name(id)}|`;
    if (inTarget(src)) return [mk(svc.getConceptId(src), name(src), 'equivalent')];
    if (!svc.isActive(src)) {
      const out = [];
      for (const [refset, relationship] of [['900000000000527005', 'equivalent'], ['900000000000526001', 'equivalent'],
        ['900000000000523009', 'related-to'], ['900000000000530003', 'related-to']]) {
        const rid = S.idOf(refset);
        if (rid == null) continue;
        for (const fields of S.refsetRows(rid, src)) {
          const t = fields.length ? S.idOf(String(fields[0])) : null;
          if (t != null && inTarget(t)) out.push(mk(svc.getConceptId(t), name(t), relationship));
        }
      }
      return out;
    }
    if (!svc.isPrimitive(src)) {
      const nf = svc.createNormalForm(src);
      const used = [];
      const walk = (e) => {
        for (const c of e.concepts) if (c.reference != null && c.reference !== E.NO_REFERENCE) used.push(c.reference);
        for (const r of [...e.refinements, ...e.refinementGroups.flatMap((g) => g.refinements)]) {
          if (r.name && r.name.reference != null && r.name.reference !== E.NO_REFERENCE) used.push(r.name.reference);
          if (r.value) walk(r.value);
        }
      };
      walk(nf);
      if (used.every(inTarget)) {
        // a concept of the target edition with the same normal form (lowest id, as main's index)
        const rendered = svc.renderExpression(nf, E.SnomedServicesRenderOption.Minimal);
        const same = S.stmt('SELECT n.concept_id, c.code FROM concept_normal_form n JOIN concept c USING (concept_id) WHERE n.nf = ? AND c.active = 1').all(rendered)
          .filter((r) => r.concept_id !== src && inTarget(r.concept_id)).sort((a, b) => (BigInt(a.code) < BigInt(b.code) ? -1 : 1))[0];
        if (same) return [mk(same.code, name(same.concept_id), 'equivalent')];
        const out = svc.ungroupNeverGroupedRefinements(nf);
        return [mk(svc.renderExpression(out, E.SnomedServicesRenderOption.Minimal), svc.renderExpression(out, E.SnomedServicesRenderOption.FillMissing), 'equivalent')];
      }
    }
    // proximal ancestors in the target edition
    const result = [];
    const seen = new Set();
    const todo = [...svc.getConceptParents(src)];
    while (todo.length) {
      const p = todo.shift();
      if (seen.has(p)) continue;
      seen.add(p);
      if (inTarget(p)) result.push(p); else todo.push(...svc.getConceptParents(p));
    }
    const ancestors = result.filter((a) => !result.some((b) => b !== a && svc.subsumes(a, b)));
    if (!ancestors.length) return [];
    const root = S.idOf(native.ROOT);
    const depth = (a) => (a === root ? 0 : svc.getConceptParents(a).includes(root) ? 1 : 2);
    const useful = ancestors.filter((a) => depth(a) >= 2);
    if (!useful.length) {
      const list = ancestors.map(named);
      const msgId = list.length === 1 ? 'TRANSLATE_SCT_EDITION_TOP_LEVEL_ONE' : 'TRANSLATE_SCT_EDITION_TOP_LEVEL_MANY';
      return [{ message: this.opContext.i18n.translate(msgId, this.opContext.langs, [editionName(ed.moduleId) || 'Unknown Edition', named(src), list.join(', ')]) }];
    }
    return useful.map((a) => mk(svc.getConceptId(a), name(a), 'source-is-narrower-than-target'));
  }

  /** the key an extension-codes supplement uses for an expression: as given, else its minimal form */
  _nativeExtKey(ctxt) {
    if (ctxt.source && this._extensionCodeDisplay(ctxt.source)) return ctxt.source;
    return this._native().renderExpression(ctxt.expression, E.SnomedServicesRenderOption.Minimal);
  }

  /** a native expression context's own answers */
  _nativeAnswer(m, ctxt, rest) {
    const svc = this._native();
    switch (m) {
      case 'code': return ctxt.isComplex() ? svc.renderExpression(ctxt.expression, E.SnomedServicesRenderOption.Minimal) : ctxt.source;
      case 'display': {
        const sup = this._displayFromSupplements(ctxt.source);
        if (sup) return sup;
        const ext = this._extensionCodeDisplay(this._nativeExtKey(ctxt));
        if (ext) return ext;
        return svc.renderExpression(ctxt.expression, E.SnomedServicesRenderOption.FillMissing);
      }
      case 'designations': {
        const displays = rest[0];
        // an extension-codes supplement's display first (the preferred one), then the generated one
        if (displays) this._listSupplementDesignations(this._nativeExtKey(ctxt), displays, true);
        const d = svc.renderExpression(ctxt.expression, E.SnomedServicesRenderOption.FillMissing);
        if (d && displays) displays.addDesignation(true, 'active', 'en-US', DesignationUse.PREFERRED, d);
        return null;
      }
      case 'extendLookup': return this._nativeLookup(ctxt, rest[0], rest[1]);
      case 'isAbstract': case 'isInactive': case 'isDeprecated': return false;
      case 'properties': return [];
      case 'expansionCode': return rest[0];
      default: return null;
    }
  }

  async _filterLocate(prep, set, code) {
    if (code != null && !isConceptId(code)) {
      const r = await this._nativeLocate(String(code));
      if (!r.context) return r.message;
      if (!(r.context instanceof NativeExprContext)) return super._filterLocate(prep, set, r.context.code);
      return (await this._nativeMember(set, r.context)) ? r.context : null;
    }
    return super._filterLocate(prep, set, code);
  }

  async filterCheck(prep, set, concept) {
    if (concept instanceof NativeExprContext) return this._nativeMember(set, concept);
    return super.filterCheck(prep, set, concept);
  }

  async _subsumesTest(codeA, codeB) {
    const a = await this.locate(codeA);
    const b = await this.locate(codeB);
    if (!a.context) throw new Error(a.message || `Unknown code ${codeA}`);
    if (!b.context) throw new Error(b.message || `Unknown code ${codeB}`);
    return super._subsumesTest(a.context, b.context);
  }

  /** ECL failures are reported as upstream does: INVALID_ECL / UNSUPPORTED_ECL, 400 */
  filterError(e, prop, op, value) {
    if (prop === 'constraint' && (e.unsupported || e.eclSyntax || e.eclUnknown || e.filterError)) {
      const id = e.eclSyntax || e.eclUnknown || /is not known/.test(e.message) ? 'INVALID_ECL' : 'UNSUPPORTED_ECL';
      return new Issue('error', 'invalid', null, id, this.opContext.i18n.translate(id, this.opContext.langs, [value, e.message]), 'vs-invalid').handleAsOO(400);
    }
    // concept is-a / in / ... naming a concept the edition does not have: the request is invalid
    // (400, as an unknown concept in ECL is: tx-ecosystem snomed-expand-ecl-unknown-concept), not a 500
    if (e.unknownConcept) return new Issue('error', 'invalid', null, null, e.message, 'vs-invalid').handleAsOO(400);
    return super.filterError(e);
  }

  async getTranslations(map, coding, target, reverse) {
    if (map && map.jsonObj.identifierMap) return this._nativeByIdentifier(map, coding, target);
    if (map && map.jsonObj.editionTranslation) return reverse ? [] : this._nativeToEdition(map, coding);
    if (!map || reverse) return [];
    if (target && target !== SCT) return [];
    const refset = this.store.idOf(map.id);
    const src = this.store.idOf(this.normaliseCode(coding.code));
    if (refset == null || src == null) return [];
    const out = [];
    for (const fields of this.store.refsetRows(refset, src)) {
      if (!fields.length) continue;
      const tgt = String(fields[0]);
      out.push({ map: map.vurl, code: tgt, system: SCT, version: this.version(), display: await this.display(tgt), relationship: map.jsonObj.relationship });
    }
    return out;
  }
}

function fmtDate(v) {
  return /^\d{8}$/.test(v) ? v.substring(0, 4) + '-' + v.substring(4, 6) + '-' + v.substring(6, 8) : v;
}

const LOADED = new Set();

class SnomedV2Factory extends SqliteV2Factory {
  edition() { return this.store.cs.edition; }

  name() {
    return this.version().includes('xsct') ? 'SNOMED CT Test Set' : `SCT ${editionCode(this.edition()) || 'Unknown Edition'}`;
  }
  nameBase() { return 'SCT'; }
  description() { return `SNOMED CT ${editionName(this.edition()) || 'Unknown Edition'}`; } // (cs-snomed.js getEditionName)
  lookupName() { return this.description(); }
  versionAlgorithm() { return 'url'; }

  getPartialVersion() {
    const v = this.version();
    return v.includes('/version') ? v.substring(0, v.indexOf('/version')) : null;
  }

  /**
   * As cs-snomed.js id(), byte for byte: 'SCT-<edition>-<date>', or null without a dated version.
   * Main's test-edition branch (snomed.info/xsct) prefixes 'x' to the match array, which makes it
   * a string, so its [1] and [2] are the characters 'h' and 't': every xsct edition has the id
   * 'SCT-h-t'. Kept so CodeSystem/x-<id> reads and search ids are the same on both engines.
   */
  id() {
    let match = this.version().match(/^http:\/\/snomed\.info\/sct\/(\d+)(?:\/version\/(\d{8}))?$/);
    if (!match) {
      match = this.version().match(/^http:\/\/snomed\.info\/xsct\/(\d+)(?:\/version\/(\d{8}))?$/);
      if (match) match = 'x' + match;
    }
    return match && match[1] && match[2] ? 'SCT-' + match[1] + '-' + match[2] : null;
  }

  describeVersion(version) {
    const m = String(version).match(/^http:\/\/snomed\.info\/sct\/(\d+)(?:\/version\/(\d{8}))?$/);
    if (!m) return version;
    const ed = editionName(m[1]);
    if (!m[2]) return ed;
    return ed + ' ' + formatDateMMDDYYYY(m[2].substring(4, 6) + m[2].substring(6, 8) + m[2].substring(0, 4));
  }

  isMyEdition(version) {
    const mine = this.version();
    return version === mine || mine.startsWith(version + '/version/');
  }

  idOfCode(code) { return this.store.idOf(code); }

  preferredId() { return this._preferredId; }

  displayRefsetIds() { return this._displayRefsets; }

  /** another loaded version of this edition is later than this one */
  laterVersionLoaded() {
    const mine = this.version();
    for (const f of LOADED) {
      if (f !== this && f.edition() === this.edition() && f.version() > mine) return true;
    }
    return false;
  }

  async load() {
    await super.load();
    LOADED.add(this); // the SNOMED files this server loaded (load-time data, for edition-only URLs)
    // data read at load (no caches): the acceptability and display refset ids
    this._preferredId = this.store.idOf(PREFERRED);
    this._displayRefsets = [].concat(this.store.config.displayRefsets || ['900000000000509007'])
      .map((c) => this.store.idOf(String(c))).filter((x) => x != null);
  }

  async build(opContext, supplements) {
    this.recordUse();
    return new SnomedV2Provider(opContext, supplements, this);
  }

  /**
   * Whether url is an implicit value set of this edition, and in which form (as main's
   * cs-snomed.js, #331; the provider chooses the version with library/implicit-valuesets.js):
   *   generic - http://snomed.info/sct?fhir_vs...              (any edition)
   *   edition - http://snomed.info/sct/<edition>?fhir_vs...    (this edition, no version given)
   *   version - http://snomed.info/sct/<edition>/version/<date>?fhir_vs... (this version)
   * The edition and version forms are also recognised under this version's own base
   * (http://snomed.info/xsct/... for the test edition).
   * @returns {{form: string, query: string}|null}
   */
  implicitValueSetForm(url) {
    if (!url || !this.store) return null;
    const q = url.indexOf('?fhir_vs');
    if (q < 0) return null;
    const head = url.substring(0, q);
    const query = url.substring(q);
    if (query !== '?fhir_vs' && !query.startsWith('?fhir_vs=')) return null;
    const mine = this.version();
    const edition = this.edition();
    const m = /\/version\/(\d{8})$/.exec(mine);
    const editionBases = new Set([`${SCT}/${edition}`, this.getPartialVersion()]);
    const versionBases = new Set([mine, m ? `${SCT}/${edition}/version/${m[1]}` : mine]);
    if (head === SCT) return { form: 'generic', query };
    if (editionBases.has(head)) return { form: 'edition', query };
    if (versionBases.has(head)) return { form: 'version', query };
    return null;
  }

  async buildKnownValueSet(url, version) {
    if (!url.startsWith('http://snomed.info/')) return null;
    if (version != null && !this.version().startsWith(version)) return null;
    const form = this.implicitValueSetForm(url);
    if (!form) return null;
    // an edition-only URL means the latest loaded version of that edition, as a version
    // parameter naming only the edition does; other versions decline
    if (form.form === 'edition' && this.laterVersionLoaded()) return null;
    const now = new Date().toISOString();
    const vs = this._knownValueSet(url, form.query, now);
    // a URL that names this edition (http://snomed.info/sct/<module>[/version/<date>]?fhir_vs...)
    // expands against this edition, not the server's default one
    if (vs && form.form !== 'generic') for (const inc of vs.compose.include) inc.version = this.version();
    return vs;
  }

  _knownValueSet(url, id, now) {
    const base = { resourceType: 'ValueSet', url, status: 'active', date: now };
    if (id === '?fhir_vs') {
      return { ...base, name: 'ALLSNOMEDCT', title: 'SNOMED CT Reference Set (All of SNOMED CT)', description: 'SNOMED CT Reference Set (All of SNOMED CT)', compose: { include: [{ system: SCT }] } };
    }
    if (id === '?fhir_vs=refset') {
      const rows = this.store.db.prepare('SELECT c.code FROM concept_set s JOIN concept c ON c.concept_id = s.value WHERE s.kind = 7 ORDER BY c.code').all();
      return { ...base, name: 'SNOMEDCTReferenceSetList', title: 'SNOMED CT Reference Set List', description: 'Reference Sets defined in this SNOMED-CT version', compose: { include: [{ system: SCT, concept: rows.map((r) => ({ code: r.code })) }] } };
    }
    if (id.startsWith('?fhir_vs=refset/')) {
      const code = id.substring(16);
      const cid = this.store.idOf(code);
      if (cid == null || !this.store.getSet(KIND.refset, 0, cid).size) return null;
      const row = this.store.conceptRows([cid]).get(cid);
      return { ...base, name: 'SNOMEDCTRefSet' + code, title: 'SNOMED CT Reference Set ' + code, description: row.display, compose: { include: [{ system: SCT, filter: [{ property: 'concept', op: 'in', value: code }] }] } };
    }
    if (id.startsWith('?fhir_vs=isa/')) {
      const code = id.substring(13);
      const cid = this.store.idOf(code);
      if (cid == null) return null;
      const row = this.store.conceptRows([cid]).get(cid);
      return { ...base, name: 'SNOMEDCTConcept' + code, title: 'SNOMED CT Concept ' + code + ' and descendants', description: 'All Snomed CT concepts for ' + row.display, compose: { include: [{ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: code }] }] } };
    }
    if (id.startsWith('?fhir_vs=ecl/')) {
      const ecl = decodeURIComponent(id.substring(13));
      return { ...base, name: 'SNOMEDCTECL', title: 'SNOMED CT ECL ' + ecl, description: 'SNOMED CT concepts matching ' + ecl, compose: { include: [{ system: SCT, filter: [{ property: 'constraint', op: '=', value: ecl }] }] } };
    }
    return null;
  }

  /**
   * The implicit maps main defines from an edition's content: to an edition it depends on
   * (?fhir_cm=edition/<module>), and those of a module's alternate identifiers (?fhir_cm=<module>,
   * e.g. LOINC codes), computed from this file; the maps point back here.
   */
  async findImplicitConceptMaps(conceptMaps, source, sourceVersion, dest) {
    if (!dest) return;
    return this._nativeImplicitMaps(conceptMaps, source, sourceVersion, dest);
  }

  // ---- implicit maps defined by content, natively --------------------------------------

  /** the module this edition is published under (from its version URI) */
  _editionModuleCode() {
    const m = /^http:\/\/snomed\.info\/x?sct\/(\d+)/.exec(this.version());
    return m ? m[1] : null;
  }

  /** module -> [{module, targetEffectiveTime}] (cs_config.moduleDependencies) */
  _moduleDeps(code) {
    return (this.store.config.moduleDependencies || []).filter((r) => r[0] === code).map((r) => ({ module: r[1], sourceEffectiveTime: r[2], targetEffectiveTime: r[3] }));
  }

  _editionDependency(targetEdition) {
    const m = /^http:\/\/snomed\.info\/x?sct\/(\d+)(?:\/version\/(\d{8}))?$/.exec(targetEdition || '');
    const mine = this._editionModuleCode();
    if (!m || !mine || this.store.idOf(m[1]) == null) return null;
    for (const d of this._moduleDeps(mine)) {
      if (d.module === m[1] && (!m[2] || m[2] === d.targetEffectiveTime)) {
        const modules = new Set();
        const todo = [m[1]];
        while (todo.length) {
          const x = todo.pop();
          if (modules.has(x)) continue;
          modules.add(x);
          for (const dd of this._moduleDeps(x)) todo.push(dd.module);
        }
        const ids = new Set([...modules].map((c) => this.store.idOf(c)).filter((x) => x != null));
        const version = d.targetEffectiveTime ? `http://snomed.info/sct/${m[1]}/version/${d.targetEffectiveTime}` : `http://snomed.info/sct/${m[1]}`;
        return { moduleId: m[1], version, modules: ids };
      }
    }
    return null;
  }

  _editionTranslationMap(dep) {
    const target = editionName(dep.moduleId) || 'Unknown Edition';
    return new ConceptMap({
      resourceType: 'ConceptMap', internalSource: this, editionTranslation: dep,
      url: `${this.version()}?fhir_cm=edition/${dep.moduleId}`,
      name: `SNOMED CT ${this.describeVersion(this.version())} to ${target} Concept Map`,
      description: `The translation implied by the concept definitions of the edition ${this.version()} to the ${target} that it depends on`,
      status: 'active', group: [{ source: SCT, target: SCT }]
    });
  }

  /** modules carrying alternate identifiers, with their schemes: module code -> Set of scheme codes */
  _identifierModules() {
    const S = this.store;
    const mp = S.props.get('module');
    const out = new Map();
    if (!mp) return out;
    const rows = S.stmt(`SELECT DISTINCT m.code AS module, s.code AS scheme FROM alternate_identifier a
      JOIN concept s ON s.concept_id = a.scheme_id
      JOIN concept_link l ON l.source_id = a.concept_id AND l.property_id = ? JOIN concept m ON m.concept_id = l.target_id`).all(mp.id);
    for (const r of rows) { if (!out.has(r.module)) out.set(r.module, new Set()); out.get(r.module).add(r.scheme); }
    return out;
  }

  _identifierMap(moduleId, mods) {
    const schemes = [...((mods || this._identifierModules()).get(moduleId) || [])].filter((x) => IDENTIFIER_SCHEMES[x]);
    if (!schemes.length) return null;
    const systems = schemes.map((x) => IDENTIFIER_SCHEMES[x].system);
    const mid = this.store.idOf(moduleId);
    const moduleName = mid != null ? (this.store.conceptRows([mid]).get(mid).display || moduleId) : moduleId;
    return new ConceptMap({
      resourceType: 'ConceptMap', internalSource: this, identifierMap: { module: moduleId, schemes },
      url: `${this.version()}?fhir_cm=${moduleId}`, name: `SNOMED CT ${moduleName} Concept Map`,
      description: `The concept map implied by the alternate identifiers (${systems.join(', ')}) of the module ${moduleId} |${moduleName}| in ${this.version()}`,
      status: 'active',
      group: [...systems.map((x) => ({ source: SCT, target: x })), ...systems.map((x) => ({ source: x, target: SCT }))]
    });
  }

  async _nativeImplicitMaps(conceptMaps, source, sourceVersion, dest) {
    const bar = dest.indexOf('|');
    const destSystem = bar < 0 ? dest : dest.substring(0, bar);
    const destVersion = bar < 0 ? null : dest.substring(bar + 1);
    const fromMe = source === SCT && sourceVersion && this.isMyEdition(sourceVersion);
    const toMe = destSystem === SCT && destVersion && this.isMyEdition(destVersion);
    const ident = fromMe ? destSystem : toMe ? source : null;
    if (ident && this.store.stmt('SELECT 1 FROM alternate_identifier LIMIT 1').get()) {
      const mods = this._identifierModules();
      for (const [moduleId, schemes] of mods) {
        if ([...schemes].some((x) => IDENTIFIER_SCHEMES[x] && IDENTIFIER_SCHEMES[x].system === ident)) {
          const cm = this._identifierMap(moduleId, mods);
          if (cm && !conceptMaps.some((m) => m.url === cm.url)) conceptMaps.push(cm);
        }
      }
    }
    if (!fromMe || destSystem !== SCT || !destVersion) return;
    const dep = this._editionDependency(destVersion);
    if (dep) {
      const cm = this._editionTranslationMap(dep);
      if (!conceptMaps.some((m) => m.url === cm.url)) conceptMaps.push(cm);
    }
  }

  async findImplicitConceptMap(url, version) {
    if (version && version !== this.version()) return null;
    if (url && url.includes('?fhir_cm=') && !url.startsWith(SCT + '?fhir_cm=')) {
      const q = url.indexOf('?fhir_cm=');
      if (!this.isMyEdition(url.substring(0, q))) return null;
      const id = url.substring(q + '?fhir_cm='.length);
      if (id.startsWith('edition/')) {
        const dep = this._editionDependency(`http://snomed.info/sct/${id.substring('edition/'.length)}`);
        return dep ? this._editionTranslationMap(dep) : null;
      }
      return this._identifierMap(id);
    }
    if (!url || !url.startsWith(SCT + '?fhir_cm=')) return null;
    const id = url.substring(url.indexOf('=') + 1);
    const a = ASSOCIATIONS[id];
    if (!a) return null;
    return new ConceptMap({
      resourceType: 'ConceptMap', internalSource: this, relationship: a[1], id, url: `${SCT}?fhir_cm=${id}`, version: this.version(),
      name: `SNOMED CT ${a[0]} Concept Map`, description: `The concept map implicitly defined by the ${a[0]} Association Reference Set`,
      copyright: 'This value set includes content from SNOMED CT, which is copyright © 2002+ International Health Terminology Standards Development Organisation (SNOMED International), and distributed by agreement between SNOMED International and HL7',
      status: 'active', sourceUri: `${SCT}?fhir_vs`, targetUri: `${SCT}?fhir_vs`, group: [{ source: SCT, target: SCT }]
    });
  }

  webSource() { return this.version(); }
}


// an expression context is answered natively
for (const m of ['code', 'display', 'definition', 'isAbstract', 'isInactive', 'isDeprecated', 'getStatus', 'itemWeight',
  'parent', 'designations', 'extensions', 'properties', 'incompleteValidationMessage', 'extendLookup', 'expansionCode']) {
  const own = SnomedV2Provider.prototype[m];
  SnomedV2Provider.prototype[m] = async function (context, ...rest) {
    if (context instanceof NativeExprContext) return this._nativeAnswer(m, context, rest);
    if (typeof context === 'string' && context !== '' && !isConceptId(context)) {
      const r = await this._nativeLocate(context);
      if (!r.context) throw new Error(r.message);
      if (r.context instanceof NativeExprContext) return this._nativeAnswer(m, r.context, rest);
      return own.call(this, r.context, ...rest);
    }
    return own.call(this, context, ...rest);
  };
}

module.exports = { SnomedV2Provider, SnomedV2Factory };
