const regexUtilities = require('../../library/regex-utilities');

/**
 * A value set filter on a property that a supplement in use defines, and the code system
 * itself doesn't (catalog-group = renal-diabetes on LOINC, with a supplement that gives
 * LOINC codes a catalog-group). The supplement says which codes have which values, so the
 * filter is evaluated from the supplement, the same way whatever the code system and
 * whichever provider serves it - the provider never sees the filter.
 *
 * A filter that selects codes the supplement lists (=, in, regex, exists = true) can drive
 * an expansion on its own; one that selects codes by what the supplement doesn't say
 * (not-in, exists = false) can only narrow what other filters select.
 */
class SupplementPropertyFilter {
  /**
   * @param {string} property
   * @param {string} op
   * @param {string} value
   * @param {CodeSystem[]} supplements - the supplements in use that define the property
   */
  constructor(property, op, value, supplements) {
    this.property = property;
    this.op = op;
    this.value = value;
    this.values = new Map(); // code -> string[] (the property's values on that code)
    for (const supplement of supplements) {
      this.#scan(supplement.jsonObj.concept || []);
    }
    if (op === 'regex') {
      this.regex = regexUtilities.compile('^(?:' + value + ')$'); // the whole value: a|b is ^(?:a|b)$, not ^a|b$
    } else if (op === 'in' || op === 'not-in') {
      this.list = value.split(',').map(s => s.trim());
    }
  }

  #scan(concepts) {
    for (const concept of concepts) {
      for (const p of concept.property || []) {
        if (p.code === this.property) {
          const v = SupplementPropertyFilter.valueOf(p);
          if (v !== null) {
            if (!this.values.has(concept.code)) {
              this.values.set(concept.code, []);
            }
            this.values.get(concept.code).push(v);
          }
        }
      }
      this.#scan(concept.concept || []);
    }
  }

  /** the value of a CodeSystem.concept.property, as a string to compare with a filter value */
  static valueOf(p) {
    for (const [k, v] of Object.entries(p)) {
      if (k.startsWith('value') && v !== undefined && v !== null) {
        if (typeof v === 'object') {
          return v.code !== undefined ? String(v.code) : null; // Coding
        }
        return String(v);
      }
    }
    return null;
  }

  static ops() {
    return ['=', 'in', 'not-in', 'regex', 'exists'];
  }

  /** whether the codes this filter selects are all codes the supplement lists */
  get enumerable() {
    return this.op !== 'not-in' && !(this.op === 'exists' && this.value === 'false');
  }

  #valueMatches(v) {
    switch (this.op) {
      case '=': return v === this.value;
      case 'in': return this.list.includes(v);
      case 'regex': return this.regex.test(v);
      default: return false;
    }
  }

  /** whether the code passes this filter */
  matches(code) {
    const vals = this.values.get(code) || [];
    switch (this.op) {
      case 'exists': return (vals.length > 0) === (this.value === 'true');
      case 'not-in': return !vals.some(v => this.list.includes(v));
      default: return vals.some(v => this.#valueMatches(v));
    }
  }

  /** the codes this filter selects (only for an enumerable filter), in the supplement's order */
  codes() {
    return [...this.values.keys()].filter(code => this.matches(code));
  }

  toString() {
    return this.property + ' ' + this.op + ' ' + this.value;
  }
}

/**
 * The supplement filter for a ValueSet filter on this code system, or null when the filter is
 * the code system's own (it isn't on a property a supplement in use defines, or the code system
 * does the filter itself, which takes precedence)
 *
 * @param {CodeSystemProvider} cs
 * @param {Object} fc - the ValueSet.compose.include.filter
 * @returns {Promise<SupplementPropertyFilter|null>}
 */
async function supplementFilter(cs, fc) {
  const supplements = (cs.supplements || []).filter(s => (s.jsonObj.property || []).some(p => p.code === fc.property));
  if (supplements.length === 0 || !SupplementPropertyFilter.ops().includes(fc.op) || !fc.value) {
    return null;
  }
  if (await cs.doesFilter(fc.property, fc.op, fc.value)) {
    return null;
  }
  return new SupplementPropertyFilter(fc.property, fc.op, fc.value, supplements);
}

/**
 * Split a ValueSet include's filters into the code system's own, and those on properties
 * that supplements define
 *
 * @param {CodeSystemProvider} cs
 * @param {Object[]} filters
 * @returns {Promise<{base: Object[], supplement: SupplementPropertyFilter[]}>}
 */
async function splitFilters(cs, filters) {
  const result = { base: [], supplement: [] };
  for (const fc of filters || []) {
    const sf = await supplementFilter(cs, fc);
    if (sf) {
      result.supplement.push(sf);
    } else {
      result.base.push(fc);
    }
  }
  return result;
}

module.exports = { SupplementPropertyFilter, supplementFilter, splitFilters };
