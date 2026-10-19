/**
 * UCUM CodeSystem Provider
 * Implementation of CodeSystemProvider for UCUM (Unified Code for Units of Measure)
 */

const { FilterExecutionContext, CodeSystemFactoryProvider} = require('./cs-api');
const ValueSet = require("../library/valueset");
const assert = require('assert');
const {UcumService} = require("../library/ucum-service");
const {Pair, Decimal} = require("../library/ucum-types");
const {validateArrayParameter, validateParameter, validateOptionalParameter} = require("../../library/utilities");
const {DesignationUse} = require("../library/designations");
const {BaseCSServices} = require("./cs-base");

/**
 * UCUM provider context for concepts
 */
class UcumContext {
  constructor(code) {
    assert(typeof code === 'string', 'code must be string');
    this.code = code;
  }
}

/**
 * UCUM canonical unit filters
 */
class UcumFilter {
  constructor(canonical = '') {
    this.canonical = canonical;
    this.cursor = -1; // Used for iteration
    this.codes = undefined;
  }
}

/**
 * UCUM CodeSystem Provider
 * Provides validation and lookup for UCUM unit expressions
 */
class UcumCodeSystemProvider extends BaseCSServices {
  ucumService;
  commonUnits;

  constructor(opContext, supplements, ucumService, commonUnits = null) {
    super(opContext, supplements);
    assert(ucumService != null && ucumService instanceof UcumService, 'ucumService must be a UcumService');
    validateOptionalParameter(commonUnits, 'commonUnits', Object);

    this.ucumService = ucumService;
    this.commonUnits = commonUnits;
  }


  // ========== Metadata Methods ==========

  system() {
    return 'http://unitsofmeasure.org'; // UCUM URI
  }

  version() {
    return this.ucumService.ucumIdentification().version;
  }

  description() {
    return 'Unified Code for Units of Measure (UCUM)';
  }

  name() {
    return 'UCUM';
  }

  /** $lookup's display name: the code system's title. */
  // eslint-disable-next-line no-unused-vars
  lookupName(languages) {
    return 'Unified Code for Units of Measure (UCUM)';
  }

  totalCount() {
    return -1; // Unbounded due to grammar
  }

  hasParents() {
    return false; // No hierarchy in UCUM
  }

  contentMode() {
    return 'complete';
  }

  expandLimitation() {
    return 0; // No limitation
  }

  specialEnumeration() {
    // Return URL of common units if available
    return this.commonUnits ? this.commonUnits.url || null : null;
  }

  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);
    if (this._hasAnySupplementDisplays(langs)) {
      return true;
    }
    return langs.isEnglishOrNothing();
  }

  listFeatures() {
    return [
      {
        feature: `rest.Codesystem:${this.system()}.filter`,
        value: 'canonical:equals'
      }
    ];
  }

  // ========== Code Information Methods ==========

  async code(code) {
    
    const ctxt = await this.#ensureContext(code);
    return ctxt.code;
  }

  async display(code) {
    
    const ctxt = await this.#ensureContext(code);

    if (this.opContext.langs.isEnglishOrNothing()) {
      // Check for common units display first
      if (this.commonUnits) {
        for (const concept of this.commonUnits.units) {
          if (concept.code === ctxt.code && concept.display) {
            return concept.display.trim();
          }
        }
      }

      // Check supplements
      const supplementDisplay = this._displayFromSupplements(ctxt.code);
      if (supplementDisplay) {
        return supplementDisplay;
      }

      // Default to analysis
      return this.ucumService.analyse(ctxt.code);
    }

    // Non-English languages - check supplements first
    const supplementDisplay = this._displayFromSupplements(ctxt.code);
    if (supplementDisplay) {
      return supplementDisplay;
    }

    // Fall back to code per THO advice
    return ctxt.code;
  }

  async definition(code) {
    
    await this.#ensureContext(code);
    return null; // UCUM doesn't provide definitions
  }

  async isAbstract(code) {
    
    await this.#ensureContext(code);
    return false; // UCUM codes are not abstract
  }

  async isInactive(code) {
    
    await this.#ensureContext(code);
    return false; // We don't track inactive UCUM codes
  }

  async isDeprecated(code) {
    
    await this.#ensureContext(code);
    return false; // We don't track deprecated UCUM codes
  }

  async designations(code, displays) {
    
    const ctxt = await this.#ensureContext(code);

    // Primary display (analysis)
    const analysis = this.ucumService.analyse(ctxt.code);
    displays.addDesignation(true, 'active', 'en', DesignationUse.DISPLAY, ctxt.code);
    displays.addDesignation(true, 'active', 'en', DesignationUse.SYNONYM, analysis);

    // Common unit display if available
    if (this.commonUnits) {
      for (const concept of this.commonUnits.units) {
        if (concept.code === ctxt.code && concept.display) {
          const display = concept.display.trim();
          if (display !== ctxt.code) {
            displays.addDesignation(false, 'active', 'en', DesignationUse.SYNONYM, display);
          }
        }
      }
    }

    // Add supplement designations
    this._listSupplementDesignations(ctxt.code, displays);
  }

  async #ensureContext(code) {
    if (!code) {
      return code;
    }
    if (typeof code === 'string') {
      const result = await this.locate(code);
      if (!result.context) {
        throw new Error(result.message);
      } else {
        return result.context;
      }
    }
    if (code instanceof UcumContext) {
      return code;
    }
    throw new Error("Unknown Type at #ensureContext: " + (typeof code));
  }

  // ========== Lookup Methods ==========

  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');

    if (!code) {
      return { context: null, message: 'Empty code' };
    }

    const validationResult = this.ucumService.validate(code);
    if (!validationResult) {
      return { context: new UcumContext(code), message: null };
    } else {
      return { context: null, message: validationResult };
    }
  }

  // ========== Filter Methods ==========

  async doesFilter(prop, op, value) {
    
    assert(prop != null && typeof prop === 'string', 'prop must be a non-null string');
    assert(op != null && typeof op === 'string', 'op must be a non-null string');
    assert(value != null && typeof value === 'string', 'value must be a non-null string');

    // Support canonical unit filters
    return (prop === 'canonical' && op === '=');
  }

  async specialFilter(filterContext, filter, sort) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(filter && typeof filter === 'string', 'filter must be a non-null string');
    assert(typeof sort === 'boolean', 'sort must be a boolean');

    throw new Error('Special filter not presently implemented for UCUM');
    // const ucumFilter = new UcumFilterContext('');
    // filterContext.filters.push(ucumFilter);
  }

  async filter(filterContext, forIteration, prop, op, value) {
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(prop != null && typeof prop === 'string', 'prop must be a non-null string');
    assert(op != null && typeof op === 'string', 'op must be a non-null string');
    assert(value != null && typeof value === 'string', 'value must be a non-null string');

    if (prop !== 'canonical') {
      throw new Error(`Unsupported filter property: ${prop}`);
    }

    if (op !== '=') {
      throw new Error(`Unsupported filter operator for canonical: ${op}`);
    }

    const ucumFilter = new UcumFilter(value);
    filterContext.filters.push(ucumFilter);
    if (filterContext.forIterate) {
      if (!this.commonUnits) {
        throw new Error(`Cannot expand a UCUM filter unless the common units value set is available`);
      }
      let set = [];
      for (let concept of this.commonUnits.units) {
        try {
          if (concept.canonical === value) {
            set.push(concept);
          }
        } catch (error) {
          // nothing
        }
      }
      ucumFilter.codes = set;
    }
  }

  async executeFilters(filterContext) {
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    return filterContext.filters;
  }

  async filterSize(filterContext, set) {
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof UcumFilter, 'set must be a UcumFilter');

    return set.codes.length;
  }

  async filtersNotClosed(filterContext) {
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    return true; // Grammar-based system is never closed
  }

  async filterMore(filterContext, set) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof UcumFilter, 'set must be a UcumFilter');

    set.cursor++;
    return set.cursor < set.codes.length;
  }

  async filterConcept(filterContext, set) {
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof UcumFilter, 'set must be a UcumFilter');
    return new UcumContext(set.codes[set.cursor].code);
  }

  async filterLocate(filterContext, set, code) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof UcumFilter, 'set must be a UcumFilter');
    assert(typeof code === 'string', 'code must be non-null string');

    // Validate the code first
    const validationResult = this.ucumService.validate(code);
    if (validationResult) {
      return `Invalid UCUM code: ${validationResult}`;
    }

    if (!set.canonical) {
      // Special enumeration case - check if in common units
      if (this.commonUnits) {
        const found = this.commonUnits.units.find(concept => concept.code == code);
        if (found) {
          return new UcumContext(code);
        } else {
          return `Code ${code} is not in the common units enumeration`;
        }
      } else {
        return new UcumContext(code); // Valid code
      }
    } else {
      // Check canonical units
      try {
        const canonical = this.ucumService.getCanonicalUnits(code);
        if (canonical === set.canonical) {
          return new UcumContext(code);
        } else {
          return `Code ${code} has canonical form ${canonical}, not ${set.canonical} as required`;
        }
      } catch (error) {
        return `Error getting canonical form for ${code}: ${error.message}`;
      }
    }
  }

  async filterCheck(filterContext, set, concept) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof UcumFilter, 'set must be a UcumFilter');

    const ctxt = await this.#ensureContext(concept);

    if (!set.canonical) {
      // Special enumeration case
      if (this.commonUnitList) {
        return this.commonUnitList.some(c => c.code === ctxt.code);
      }
      return true; // All valid codes are included
    } else {
      // Check canonical units
      try {
        const canonical = this.ucumService.getCanonicalUnits(ctxt.code);
        return canonical === set.canonical;
      } catch (error) {
        return false;
      }
    }
  }


  // ========== Not Iterator Methods: Cannot iterate UCUM codes ==========

  // ========== Additional Methods ==========

  async sameConcept(a, b) {
    
    const codeA = await this.#ensureContext(a);
    const codeB = await this.#ensureContext(b);
    return codeA === codeB;
  }

  /**
   * UCUM has no hierarchy, so no code is ever a subtype of another. Two different codes can
   * still mean the same unit though - 1/min and min-1 are the same thing written two ways -
   * so when the codes differ, compare what they canonicalise to.
   *
   * This is the canonical *form*, not the canonical units: getCanonicalUnits() drops the
   * magnitude, so m and cm both answer 'm' and would compare equal when they are different
   * units. getCanonicalForm() carries the conversion factor with the unit, which is what
   * distinguishes the same unit written differently from a merely comparable one.
   *
   * @param {string|UcumContext} codeA
   * @param {string|UcumContext} codeB
   * @returns {string} equivalent or not-subsumed
   */
  async subsumesTest(codeA, codeB) {
    const a = await this.#ensureContext(codeA);
    const b = await this.#ensureContext(codeB);

    if (a.code === b.code) {
      return 'equivalent';
    }

    try {
      const ca = this.ucumService.getCanonicalForm(new Pair(Decimal.one(), a.code));
      const cb = this.ucumService.getCanonicalForm(new Pair(Decimal.one(), b.code));
      if (ca.getCode() === cb.getCode() && ca.getValue().comparesTo(cb.getValue()) === 0) {
        return 'equivalent';
      }
    } catch (e) {
      // a unit that won't canonicalise is simply not equivalent to anything. locate() has
      // already accepted both codes, so this is a unit the analyser can't reduce, not junk
    }

    return 'not-subsumed';
  }

  async extendLookup(ctxt, props, params) {
    validateArrayParameter(props, 'props', String);
    validateArrayParameter(params, 'params', Object);


    if (this._hasProp(props, 'canonical', true)) {
      try {
        const canonical = this.ucumService.getCanonicalUnits(ctxt.code);
        // Add canonical property to params - implementation depends on your Parameters class
        if (params && typeof params.addProperty === 'function') {
          params.addProperty('canonical', canonical);
        }
      } catch (error) {
        // Ignore errors in canonical form calculation
      }
    }
  }

  versionAlgorithm() {
    return 'natural';
  }


  isNotClosed() {
    return true;
  }

  makeUseForSynonym() {
    return ;
  }
}

/**
 * Factory for creating UCUM CodeSystem providers
 */
class UcumCodeSystemFactory extends CodeSystemFactoryProvider {
  constructor(i18n, ucumService, commonUnitVS = null) {
    super(i18n);
    assert(ucumService != null && ucumService instanceof UcumService, 'ucumService must be a UcumService');
    assert(!commonUnitVS || commonUnitVS instanceof ValueSet, 'if provided, commonUnits must be a ValueSet');
    this.ucumService = ucumService;
    this.uses = 0;

    if (commonUnitVS) {
      this.processCommonUnits(commonUnitVS);
    }
  }

  processCommonUnits(vs) {
    validateParameter(vs, 'vs', ValueSet);
    if (vs) {
      this.commonUnits = { units : [] };
      this.commonUnits.url = vs.url;
      for (let c of vs.jsonObj.compose.include[0].concept) {
        let concept = { code: c.code, display : c.display };
        try {
          let canonical = this.ucumService.getCanonicalUnits(c.code);
          if (canonical) {
            concept.canonical = canonical;
          }
        } catch (err) {
          // nothing
        }
        this.commonUnits.units.push(concept);
      }
    } else {
      this.commonUnits = null;
    }
  }

  system() {
    return 'http://unitsofmeasure.org'; // UCUM URI
  }

  version() {
    return this.ucumService.ucumIdentification().getVersion();
  }

  // eslint-disable-next-line no-unused-vars
  async buildKnownValueSet(url, version) {
    return null;
  }

  defaultVersion() {
    if (this.ucumService && typeof this.ucumService.ucumIdentification === 'function') {
      const versionDetails = this.ucumService.ucumIdentification();
      return versionDetails ? versionDetails.getVersion() : '';
    }
    return '';
  }

  build(opContext, supplements) {
    this.recordUse();
    return new UcumCodeSystemProvider(opContext, supplements, this.ucumService, this.commonUnits);
  }

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;
  }

  name() {
    return 'UCUM';
  }

  id() {
    return "ucum";
  }
}

module.exports = {
  UcumCodeSystemProvider,
  UcumCodeSystemFactory,
  UcumContext,
  UcumFilter
};