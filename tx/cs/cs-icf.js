/**
 * ICF (http://hl7.org/fhir/sid/icf).
 *
 * The content is an ordinary CodeSystem resource (fhir.tx.support has 2001a and 2017a), so
 * this extends FhirCodeSystemProvider rather than being a factory with its own data:
 * FhirCodeSystemProvider.create() picks this class by url.
 *
 * What ICF adds is a grammar: a category may be followed by '.' and qualifier digits, one per
 * position, and what the positions are depends on the component - the first letter of the code
 * (see QUALIFIERS):
 *   b  body functions             extent
 *   s  body structures            extent, nature, localization
 *   d  activities/participation   performance, capacity, then optionally capacity with
 *                                 assistance and performance without assistance
 *   e  environmental factors      one: a barrier after '.', or a facilitator after '+' (in
 *                                 place of the '.') - e310.2, e310+3
 * Each digit must be a value of its position's scale, which the code system carries as the
 * concepts q1-n (extent of impairment), q2-n (nature), q3-n (localization), q4-n (extent of
 * problem), q5-n (barrier) and q6-n (facilitator, which has no 9), under the group concepts
 * q1..q6. A position cannot be omitted; 8 (not specified) is
 * what fills it, and 8 says nothing in the display. Each position is reported by $lookup as the
 * property named in QUALIFIERS.
 *
 * Qualifiers are not mandatory at the code system level: a plain category is still a valid
 * code. Qualified codes cannot be enumerated, so the code system is not closed.
 *
 * Value sets control qualifiers with filters:
 *   <qualifier property> exists true|false - the qualifier is required / not allowed. 8 (not
 *       specified) counts as absent, so it never satisfies exists = true, and always satisfies
 *       exists = false. A qualifier the code's component does not have is absent
 *   qualified  =  true|false  - qualified codes only / no qualified codes at all (b1100.888
 *       is qualified, though it says nothing)
 * These combine with the other filters in an include as usual. A qualified code is in any
 * other filter's results when its category is.
 */

const { CodeSystem } = require('../library/codesystem');
const { Issue } = require('../library/operation-outcome');
const { FhirCodeSystemProvider, FhirCodeSystemProviderContext, FhirCodeSystemProviderFilterContext } = require('./cs-cs');

/**
 * The qualifier positions of each component, by the separator that introduces them: the
 * property that reports the qualifier, the scale (group concept) its values come from, and the
 * label that introduces its value in the display (none where the value says what it is).
 * Only environmental factors take '+', which makes the qualifier a facilitator.
 */
const QUALIFIERS = {
  b: {
    '.': [{ property: 'extent', scale: 'q1' }]
  },
  s: {
    '.': [
      { property: 'extent', scale: 'q1' },
      { property: 'nature', scale: 'q2' },
      { property: 'localization', scale: 'q3' }
    ]
  },
  d: {
    '.': [
      { property: 'performance', scale: 'q4', label: 'performance' },
      { property: 'capacity', scale: 'q4', label: 'capacity' },
      { property: 'capacity-with-assistance', scale: 'q4', label: 'capacity with assistance' },
      { property: 'performance-without-assistance', scale: 'q4', label: 'performance without assistance' }
    ]
  },
  e: {
    '.': [{ property: 'barrier', scale: 'q5' }],
    '+': [{ property: 'facilitator', scale: 'q6' }]
  }
};

const COMPONENT_NAMES = { b: 'body functions', s: 'body structures', d: 'activities and participation', e: 'environmental factors' };
const COMPONENT_CODES = { b: 'a body functions (b) code', s: 'a body structures (s) code', d: 'an activities and participation (d) code', e: 'an environmental factors (e) code' };

const QUALIFIER_PROPERTIES = new Set(Object.values(QUALIFIERS).flatMap(c => Object.values(c)).flatMap(q => q.map(p => p.property)));

/**
 * A category with qualifiers. code and concept are the category's, so whatever is inherited
 * from FhirCodeSystemProvider describes the category; qualifiedCode is the code as a whole.
 */
class IcfQualifiedContext extends FhirCodeSystemProviderContext {
  /**
   * @param {string} qualifiedCode - e.g. s7300.183
   * @param {Object} concept - the category's concept
   * @param {{position: number, digit: string, code: string, concept: Object, property: string}[]} qualifiers
   */
  constructor(qualifiedCode, concept, qualifiers) {
    super(concept.code, concept);
    this.qualifiedCode = qualifiedCode;
    this.qualifiers = qualifiers;
  }
}

/**
 * The result of a qualifier filter. test() decides membership for a located code, qualified or
 * not. concepts (what iteration walks) holds only the plain categories that pass, since
 * qualified codes cannot be listed; closesQualified marks the one filter (qualified = false)
 * that admits no qualified code, so an include with it is closed again.
 */
class IcfQualifierFilter extends FhirCodeSystemProviderFilterContext {
  constructor(test, closesQualified) {
    super();
    this.test = test;
    this.closesQualified = closesQualified;
  }
}

function propertyValue(concept, code) {
  const p = (concept.property || []).find(p => p.code === code);
  return p ? (p.valueCode ?? p.valueBoolean ?? p.valueString) : undefined;
}

class IcfCodeSystemProvider extends FhirCodeSystemProvider {

  /** Qualified codes are a grammar: they cannot all be listed. */
  isNotClosed() {
    return true;
  }

  // -- locating -------------------------------------------------------------------------

  /**
   * A code in the code system, or a selectable category followed by '.' (or, for an
   * environmental factor, '+') and its qualifier digits. An unknown category is a plain miss
   * (no message); a known category with bad qualifiers says what is wrong with them.
   */
  async locate(code) {
    const base = await super.locate(code);
    if (base.context || typeof code !== 'string') {
      return base;
    }
    const sep = code.search(/[.+]/);
    if (sep <= 0) {
      return base;
    }
    const separator = code[sep];
    const stemCode = code.substring(0, sep);
    const digits = code.substring(sep + 1);
    const stem = this.codeSystem.getConceptByCode(stemCode);
    if (!stem) {
      return { context: null, message: undefined };
    }
    if (!this.#isQualifiable(stem)) {
      return { context: null, message: `The ICF code '${code}' is not valid: qualifiers can only follow a selectable ICF category, and '${stemCode}' is not one` };
    }
    const component = stemCode[0];
    const positions = (QUALIFIERS[component] || {})[separator];
    if (!positions) {
      return { context: null, message: separator === '+'
        ? `The ICF code '${code}' is not valid: only an environmental factor (e) can be a facilitator, written with '+'`
        : `The ICF code '${code}' is not valid: qualifiers on ${COMPONENT_NAMES[component] || 'these'} codes are not supported` };
    }
    const names = positions.map(q => q.property).join(', ');
    if (!new RegExp(`^[0-9]{1,${positions.length}}$`).test(digits)) {
      return { context: null, message: positions.length === 1
        ? `The ICF code '${code}' is not valid: ${COMPONENT_CODES[component]} takes one qualifier digit after the '${separator}' (${names})`
        : `The ICF code '${code}' is not valid: ${COMPONENT_CODES[component]} takes 1 to ${positions.length} qualifier digits after the '${separator}' (${names})` };
    }
    const qualifiers = [];
    for (let i = 0; i < digits.length; i++) {
      const position = positions[i];
      const concept = this.codeSystem.getConceptByCode(position.scale + '-' + digits[i]);
      if (!concept) {
        return { context: null, message: `The ICF code '${code}' is not valid: '${digits[i]}' is not a valid value for qualifier ${i + 1} (${position.property})` };
      }
      qualifiers.push({ position: i + 1, digit: digits[i], code: concept.code, concept, property: position.property, label: position.label });
    }
    return { context: new IcfQualifiedContext(code, stem, qualifiers), message: null };
  }

  /** A selectable primary category: not a heading, and not a qualifier value. */
  #isQualifiable(concept) {
    const kind = propertyValue(concept, 'kind');
    if (kind !== undefined && kind !== 'primary') {
      return false;
    }
    return propertyValue(concept, 'notSelectable') !== true;
  }

  async #resolve(context) {
    if (typeof context === 'string') {
      const r = await this.locate(context);
      if (!r.context) {
        throw new Error(r.message ? r.message : `Code '${context}' not found in CodeSystem '${this.system()}'`);
      }
      return r.context;
    }
    return context || null;
  }

  // -- concept information --------------------------------------------------------------

  async code(context) {
    const ctxt = await this.#resolve(context);
    return ctxt instanceof IcfQualifiedContext ? ctxt.qualifiedCode : super.code(ctxt);
  }

  /** The category's display, then the qualifiers' displays, leaving out any 8 (not specified). */
  async display(context) {
    const ctxt = await this.#resolve(context);
    const display = await super.display(ctxt);
    if (!(ctxt instanceof IcfQualifiedContext)) {
      return display;
    }
    const parts = ctxt.qualifiers.filter(q => q.digit !== '8')
      .map(q => (q.label ? q.label + ' ' : '') + (q.concept.display || '').trim());
    return parts.length > 0 ? display + ': ' + parts.join(', ') : display;
  }

  /** A qualified code has one designation: its display. The category's translations do not describe it. */
  async designations(context, displays) {
    const ctxt = await this.#resolve(context);
    if (!(ctxt instanceof IcfQualifiedContext)) {
      return super.designations(ctxt, displays);
    }
    const lang = this.defaultLanguage ? this.defaultLanguage.toString() : null;
    displays.addDesignation(true, 'active', lang, CodeSystem.makeUseForDisplay(), await this.display(ctxt));
  }

  /**
   * A qualified code has the category's properties, less parent (its parent is the category),
   * plus one property per qualifier, named by the qualifier's scale (extent, nature, localization).
   */
  async properties(context) {
    const ctxt = await this.#resolve(context);
    const props = await super.properties(ctxt);
    if (!(ctxt instanceof IcfQualifiedContext)) {
      return props;
    }
    const result = props.filter(p => p.code !== 'parent');
    for (const q of ctxt.qualifiers) {
      result.push({ code: q.property, valueCode: q.code, definition: this.getPropertyDefinition(this.codeSystem.jsonObj, q.property) });
    }
    return result;
  }

  async parent(context) {
    const ctxt = await this.#resolve(context);
    return ctxt instanceof IcfQualifiedContext ? ctxt.code : super.parent(ctxt);
  }

  async sameConcept(a, b) {
    const ca = await this.#resolve(a);
    const cb = await this.#resolve(b);
    if (!ca || !cb) {
      return false;
    }
    return (await this.code(ca)) === (await this.code(cb));
  }

  /** As for any concept, but a qualified code has no children. */
  async extendLookup(ctxt, props, params) {
    const start = params.length;
    await super.extendLookup(ctxt, props, params);
    if (ctxt instanceof IcfQualifiedContext) {
      for (let i = params.length - 1; i >= start; i--) {
        if (params[i].name === 'property' && params[i].part?.[0]?.valueCode === 'child') {
          params.splice(i, 1);
        }
      }
    }
  }

  // -- hierarchy ------------------------------------------------------------------------

  /**
   * Whether `general` subsumes `specific` or is it: a qualified code sits under its category,
   * and so under everything the category does. Qualified codes are related only to themselves.
   */
  #isA(specific, general) {
    if (general instanceof IcfQualifiedContext) {
      return specific instanceof IcfQualifiedContext && specific.qualifiedCode === general.qualifiedCode;
    }
    const code = specific.code; // the category, for a qualified code
    if (code === general.code) {
      return true;
    }
    return this.codeSystem.isDescendantOf(code, general.code);
  }

  async locateIsA(code, parent, disallowSelf = false) {
    const codeResult = await this.locate(code);
    if (!codeResult.context) {
      return codeResult;
    }
    const parentResult = await this.locate(parent);
    if (!(codeResult.context instanceof IcfQualifiedContext) && !(parentResult.context instanceof IcfQualifiedContext)) {
      return super.locateIsA(code, parent, disallowSelf);
    }
    if (!parentResult.context) {
      return { context: null, message: `Parent code '${parent}' not found in CodeSystem '${this.system()}'` };
    }
    if (code === parent) {
      return disallowSelf ? { context: null, message: `Code '${code}' cannot be the same as its parent` } : codeResult;
    }
    if (this.#isA(codeResult.context, parentResult.context)) {
      return codeResult;
    }
    return { context: null, message: `Code '${code}' is not a descendant of '${parent}'` };
  }

  async subsumesTest(codeA, codeB) {
    const a = (await this.locate(codeA)).context;
    if (!a) {
      throw new Error(`Unknown Code "${codeA}"`);
    }
    const b = (await this.locate(codeB)).context;
    if (!b) {
      throw new Error(`Unknown Code "${codeB}"`);
    }
    if (!(a instanceof IcfQualifiedContext) && !(b instanceof IcfQualifiedContext)) {
      return super.subsumesTest(codeA, codeB);
    }
    if ((await this.code(a)) === (await this.code(b))) {
      return 'equivalent';
    }
    if (this.#isA(b, a)) {
      return 'subsumes';
    }
    if (this.#isA(a, b)) {
      return 'subsumed-by';
    }
    return 'not-subsumed';
  }

  /** A qualified code has no children. */
  async iterator(context) {
    if (context) {
      const ctxt = await this.#resolve(context);
      if (ctxt instanceof IcfQualifiedContext) {
        return { type: 'children', parentCode: ctxt.qualifiedCode, codes: [], current: 0, total: 0 };
      }
      return super.iterator(ctxt);
    }
    return super.iterator(context);
  }

  // -- filters --------------------------------------------------------------------------

  #isQualifierFilter(prop, op) {
    return (op === 'exists' && QUALIFIER_PROPERTIES.has(prop)) || (prop === 'qualified' && op === '=');
  }

  async doesFilter(prop, op, value) {
    if (this.#isQualifierFilter(prop, op)) {
      return value === 'true' || value === 'false';
    }
    return super.doesFilter(prop, op, value);
  }

  async filter(filterContext, forIteration, prop, op, value, fc) {
    if (!this.#isQualifierFilter(prop, op)) {
      return super.filter(filterContext, forIteration, prop, op, value, fc);
    }
    if (value !== 'true' && value !== 'false') {
      throw new Issue('error', 'exception', null, 'FILTER_NOT_UNDERSTOOD',
        this.opContext.i18n.translate('FILTER_NOT_UNDERSTOOD', this.opContext.langs, [prop, op, value]), 'vs-invalid', 422);
    }
    const want = value === 'true';
    let test;
    if (prop === 'qualified') {
      test = (ctxt) => (ctxt instanceof IcfQualifiedContext) === want;
    } else {
      test = (ctxt) => {
        const q = ctxt instanceof IcfQualifiedContext ? ctxt.qualifiers.find(q => q.property === prop) : undefined;
        return (q !== undefined && q.digit !== '8') === want;
      };
    }
    const results = new IcfQualifierFilter(test, prop === 'qualified' && !want);
    // the plain categories that pass: none for exists = true or qualified = true
    for (const code of this.codeSystem.getAllCodes()) {
      const concept = this.codeSystem.getConceptByCode(code);
      if (concept && this.#isPrimary(concept) && test(new FhirCodeSystemProviderContext(code, concept))) {
        results.add(concept);
      }
    }
    if (!filterContext.filters) {
      filterContext.filters = [];
    }
    filterContext.filters.push(results);
    return results;
  }

  /** A primary ICF category (heading or not), as opposed to a qualifier value. */
  #isPrimary(concept) {
    const kind = propertyValue(concept, 'kind');
    return kind === undefined || kind === 'primary';
  }

  /** Every include can admit qualified codes, unless it has a qualified = false filter. */
  async filtersNotClosed(filterContext) {
    return !(filterContext.filters || []).some(f => f instanceof IcfQualifierFilter && f.closesQualified);
  }

  async filterCheck(filterContext, set, concept) {
    if (set instanceof IcfQualifierFilter && concept instanceof IcfQualifiedContext) {
      return set.test(concept) ? true : `Code '${concept.qualifiedCode}' does not meet the qualifier rules`;
    }
    return super.filterCheck(filterContext, set, concept);
  }

  /**
   * A qualified code is in a filter's results when its category is: it is-a the category,
   * and has the category's properties. (filterCheck needs nothing extra: it checks the
   * context's concept, which is the category's.)
   */
  async filterLocate(filterContext, set, code) {
    if (set instanceof IcfQualifierFilter) {
      const loc = await this.locate(code);
      if (!loc.context) {
        return null;
      }
      return (await this.filterCheck(filterContext, set, loc.context)) === true ? loc.context : null;
    }
    const found = await super.filterLocate(filterContext, set, code);
    if (found) {
      return found;
    }
    const loc = await this.locate(code);
    if (!(loc.context instanceof IcfQualifiedContext)) {
      return found;
    }
    const stem = await super.filterLocate(filterContext, set, loc.context.code);
    return stem && typeof stem !== 'string' ? loc.context : null;
  }
}

module.exports = {
  IcfCodeSystemProvider,
  IcfQualifiedContext
};
