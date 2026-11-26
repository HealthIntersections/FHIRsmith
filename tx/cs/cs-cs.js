const { CodeSystem}  = require("../library/codesystem");
const { CodeSystemFactoryProvider, FilterExecutionContext, CodeSystemProvider }  = require( "./cs-api");
const { VersionUtilities }  = require("../../library/version-utilities");
const { Language }  = require ("../../library/languages");
const { validateOptionalParameter, getValuePrimitive, validateArrayParameter} = require("../../library/utilities");
const {Issue} = require("../library/operation-outcome");
const {Extensions} = require("../library/extensions");
const {BaseCSServices} = require("./cs-base");
const regexUtilities = require("../../library/regex-utilities");
const { NameIndex } = require("../library/text-match");
const { TextIndexStore } = require("../library/text-index-store");

// Symbol key under which resolved filter analysis is memoised directly on the
// ValueSet compose.include.filter element (`fc`). Symbol-keyed and defined
// non-enumerable, so it never serialises, clones (structuredClone), or spreads
// into a response - it simply lives and dies with the filter element (and thus
// the cached ValueSet). The value is Map(codeSystemVersionKey -> concepts[]):
// the resolved concept list is only valid for the code system version it was
// computed against. Only the expensive full-scan / subtree-walk filters are
// cached (see _isCacheableFilter); cheap ones (=, in, child-of) are not. cs-cs
// filter results do not depend on forIteration, so one form is stored per version.
const { FILTER_ANALYSIS, recall, remember } = require('../library/filter-memo');

// The standard concept properties (http://hl7.org/fhir/concept-properties)
const CONCEPT_PROPERTIES = 'http://hl7.org/fhir/concept-properties#';

// The text index of each code system (text-match.js), built the first time it is searched, and
// dropped with the code system: {size, promise of a NameIndex}
const TEXT_INDEXES = new WeakMap();

/**
 * Context class for FHIR CodeSystem provider concepts
 */
class FhirCodeSystemProviderContext {
  /**
   * @param {string} code - the code
   * @param {Object} concept - its definition in the code system
   * @param {boolean} reserved - true if the code system doesn't define the code, but it is in its
   *   reserved code space (so the concept is just the code, and supplements may define it)
   */
  constructor(code, concept, reserved = false) {
    this.code = code;
    this.concept = concept;
    this.reserved = reserved;
  }
}

/**
 * Context class for FHIR CodeSystem provider filter results
 */
class FhirCodeSystemProviderFilterContext {
  constructor() {
    this.concepts = []; // Array of {concept, rating} objects
    this.currentIndex = -1;
    this.include = true; // Whether this is an include or exclude filter
  }

  /**
   * Add a concept to the filter results
   * @param {Object} concept - The concept object
   * @param {number} rating - Search relevance rating (higher = more relevant)
   */
  add(concept, rating = 0) {
    this.concepts.push({ concept, rating });
  }

  /**
   * Sort concepts by rating (highest first)
   */
  sort() {
    this.concepts.sort((a, b) => b.rating - a.rating);
  }

  /**
   * Get the total number of concepts in the filter
   * @returns {number} Number of concepts
   */
  size() {
    return this.concepts.length;
  }

  /**
   * Check if there are more concepts to iterate
   * @returns {boolean} True if more concepts available
   */
  hasMore() {
    return this.currentIndex + 1 < this.concepts.length;
  }

  /**
   * Move to next concept and return it
   * @returns {Object|null} Next concept or null if exhausted
   */
  next() {
    if (this.hasMore()) {
      this.currentIndex++;
      return this.concepts[this.currentIndex].concept;
    }
    return null;
  }

  /**
   * Reset iterator to beginning
   */
  reset() {
    this.currentIndex = -1;
  }

  /**
   * Find a concept by code in the filter results
   * @param {string} code - The code to find
   * @returns {Object|null} The concept if found, null otherwise
   */
  findConceptByCode(code) {
    for (const item of this.concepts) {
      if (item.concept.code === code) {
        return item.concept;
      }
    }
    return null;
  }

  /**
   * Check if a concept is in the filter results
   * @param {Object} concept - The concept to check
   * @returns {boolean} True if concept is in results
   */
  containsConcept(concept) {
    return this.concepts.some(item => item.concept === concept);
  }
}

// Code systems loaded as ordinary CodeSystem resources (from a package, or supplied by a
// client) that need behaviour beyond the resource: a grammar, say. Keyed on the CodeSystem
// url; the class extends FhirCodeSystemProvider, so the content still comes from the
// resource. Required lazily, because the subclasses require this module.
let specialisedProviders = null;

function providerClassFor(url) {
  if (specialisedProviders === null) {
    specialisedProviders = new Map([
      ['http://hl7.org/fhir/sid/icf', require('./cs-icf').IcfCodeSystemProvider]
    ]);
  }
  return specialisedProviders.get(url) || FhirCodeSystemProvider;
}

class FhirCodeSystemProvider extends BaseCSServices {
  /**
   * A code system that reserves code spaces for users (codesystem-reservedCodeSpace) has codes that
   * aren't listed in an expansion of all of it
   * @returns {string|null}
   */
  openCodeSpaceReason() {
    return this.codeSystem.reservedCodeSpaces().length > 0 ?
      "The code system '" + this.system() + "' reserves code spaces for users to define their own codes, and those codes are not in the expansion" : null;
  }

  /**
   * The provider for a CodeSystem resource: a FhirCodeSystemProvider, or the subclass
   * registered for its url. Always use this rather than the constructor.
   * @param {OperationContext} opContext
   * @param {CodeSystem} codeSystem
   * @param {CodeSystem[]} supplements
   * @returns {FhirCodeSystemProvider}
   */
  static create(opContext, codeSystem, supplements) {
    const cls = providerClassFor(codeSystem.url);
    return new cls(opContext, codeSystem, supplements);
  }

  /**
   * @param {CodeSystem} codeSystem - The primary CodeSystem
   * @param {CodeSystem[]} supplements - Array of supplement CodeSystems
   */
  constructor(opContext, codeSystem, supplements) {
    super(opContext, supplements);
    if (codeSystem.content == 'supplements') {
      throw new Issue('error', 'invalid', null, 'CODESYSTEM_CS_NO_SUPPLEMENT', opContext.i18n.translate('CODESYSTEM_CS_NO_SUPPLEMENT', opContext.langs, codeSystem.vurl));
    }
    this.codeSystem = codeSystem;
    this.hasHierarchyFlag = codeSystem.hasHierarchy();

    // Parse the default language if specified
    this.defaultLanguage = codeSystem.langCode();
  }

  // ============ Metadata Methods ============

  /**
   * @returns {string} URI and version identifier for the code system
   */
  name() {
    return this.codeSystem.jsonObj.name || '';
  }

  /**
   * $lookup's display name: CodeSystem.title, translated where the resource carries a
   * translation for one of the request's languages, else the title as written, else name.
   * @param {Languages} [languages] - the request's working languages
   * @returns {string}
   */
  lookupName(languages) {
    const cs = this.codeSystem.jsonObj;
    if (!cs.title) return this.name();
    const base = (c) => String(c || '').toLowerCase().split('-')[0];
    const translations = (cs._title?.extension || [])
      .filter(e => e.url === 'http://hl7.org/fhir/StructureDefinition/translation')
      .map(e => ({
        lang: (e.extension || []).find(x => x.url === 'lang')?.valueCode,
        content: (e.extension || []).find(x => x.url === 'content')?.valueString,
      }))
      .filter(t => t.lang && t.content);
    for (const l of languages || []) {
      const want = base(l.language || l.code);
      if (!want) continue;
      if (cs.language && base(cs.language) === want) return cs.title;
      const t = translations.find(t => base(t.lang) === want);
      if (t) return t.content;
    }
    return cs.title;
  }

  /**
   * @returns {string} URI for the code system
   */
  system() {
    return this.codeSystem.jsonObj.url || '';
  }

  /**
   * @returns {string|null} Version for the code system
   */
  version() {
    return this.codeSystem.jsonObj.version || null;
  }

  /**
   * @returns {string|null} valueset for the code system
   */
  valueSet() {
    return this.codeSystem.jsonObj.valueSet || null;
  }

  /**
   * @returns {string} Default language for the code system
   */
  defLang() {
    return this.defaultLanguage?.toString() || 'en';
  }

  /**
   * @returns {string} Content mode for the CodeSystem
   */
  contentMode() {
    return this.codeSystem.content;
  }

  /**
   * @returns {string} Description for the code system
   */
  description() {
    return this.codeSystem.jsonObj.description || this.codeSystem.jsonObj.title || this.codeSystem.jsonObj.name || '';
  }

  /**
   * @returns {string|null} Source package for the code system, if known
   */
  sourcePackage() {
    return this.codeSystem.sourcePackage;
  }

  /**
   * @returns {number} Total number of concepts in the code system
   */
  totalCount() {
    return this.codeSystem.codeMap.size;
  }

  /**
   * @returns {Object[]|null} Defined properties for the code system
   */
  propertyDefinitions() {
    return this.codeSystem.jsonObj.property || null;
  }

  /**
   * The codes this code system uses for one of the standard concept properties
   * (http://hl7.org/fhir/concept-properties#<name>). A property declared with the
   * standard uri counts whatever local code it was given. A code that the code
   * system declares with a different uri is a different property, and does not
   * count. A code the code system doesn't declare (or declares with no uri) is
   * recognised by the code alone - the standard code, and any legacy aliases
   *
   * @param {string} name - the standard property code (e.g. notSelectable)
   * @param {string[]} aliases - legacy codes also recognised when not declared otherwise
   * @returns {Set<string>} the local codes for the property
   */
  standardPropertyCodes(name, aliases = []) {
    const uri = CONCEPT_PROPERTIES + name;
    const defs = this.propertyDefinitions() || [];
    const codes = new Set();
    for (const d of defs) {
      if (d.uri === uri) {
        codes.add(d.code);
      }
    }
    for (const c of [name, ...aliases]) {
      if (!defs.some(d => d.code === c && d.uri && d.uri !== uri)) {
        codes.add(c);
      }
    }
    return codes;
  }

  /**
   * Whether the code system declares the code of a standard concept property for a
   * property of its own (with a different uri), so that the code is not the standard one
   * @param {string} name - the standard property code
   * @returns {boolean}
   */
  redefinesStandardProperty(name) {
    const uri = CONCEPT_PROPERTIES + name;
    return (this.propertyDefinitions() || []).some(d => d.code === name && d.uri && d.uri !== uri);
  }

  /**
   * @param {Languages} languages - Language specification
   * @returns {boolean} Whether any displays are available for the languages
   */
  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);

    // Check supplements first
    if (this._hasAnySupplementDisplays(langs)) {
      return true;
    }

    // Check if we have English or if no specific languages requested
    if (langs.isEnglishOrNothing()) {
      return true; // We always have displays for concepts
    }

    // Check if the CodeSystem's language matches requested languages
    if (this.defaultLanguage) {
      for (const requestedLang of langs) {
        if (this.defaultLanguage.matchesForDisplay(requestedLang)) {
          return true;
        }
      }
    }

    // Check concept designations for matching languages
    for (const concept of this.codeSystem.getAllConcepts()) {
      if (concept.designation && Array.isArray(concept.designation)) {
        for (const designation of concept.designation) {
          if (designation.language) {
            const designationLang = new Language(designation.language);
            for (const requestedLang of langs) {
              if (designationLang.matchesForDisplay(requestedLang)) {
                return true;
              }
            }
          }
        }
      }
    }

    return false;
  }

  /**
   * @returns {boolean} True if there's a hierarchy
   */
  hasParents() {
    return this.hasHierarchyFlag;
  }

  /**
   * @param {string} checkVersion - First version
   * @param {string} actualVersion - Second version
   * @returns {boolean} True if v1 is more detailed than v2
   */
  versionIsMoreDetailed(checkVersion, actualVersion) {
    return VersionUtilities.versionMatchesByAlgorithm(checkVersion, actualVersion, this.versionAlgorithm());
  }

  /**
   * @returns {{status: string, standardsStatus: string, experimental: boolean}|null} Status information
   */
  status() {
    const cs = this.codeSystem.jsonObj;
    if (!cs.status) return {};

    return {
      status: cs.status,
      standardsStatus: cs.extension?.find(ext =>
        ext.url === 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status'
      )?.valueCode || '',
      experimental: cs.experimental || false
    };
  }

  /**
   * @param {string|FhirCodeSystemProviderContext} context - Code or context
   * @returns {Promise<string|null>} The correct code for the concept
   */
  async code(context) {
    
    const ctxt = await this.#ensureContext(context);
    return ctxt ? ctxt.code : null;
  }

  /**
   * @param {string} code - The code to locate
   * @returns {Promise<{context: FhirCodeSystemProviderContext|null, message: string|null}>} Locate result
   */
  async locate(code) {
    

    if (!code || typeof code !== 'string') {
      return { context: null, message: 'Empty or invalid code' };
    }

    const concept = this.codeSystem.getConceptByCode(code);
    if (concept) {
      return {
        context: new FhirCodeSystemProviderContext(concept.code, concept),
        message: null
      };
    }

    // a code the code system doesn't define, in a code space it reserves for users to define their own
    // codes, is a valid code. An extension-codes supplement in scope may define it (display etc); if
    // none does, it has no display
    if (this.codeSystem.isInReservedCodeSpace(code)) {
      return {
        context: new FhirCodeSystemProviderContext(code, { code: code }, true),
        message: null
      };
    }

    return {
      context: null,
      message: undefined
    };
  }

  /**
   * Helper method to ensure we have a proper context object
   * @param {string|FhirCodeSystemProviderContext} context - Code or context
   * @returns {Promise<FhirCodeSystemProviderContext|null>} Resolved context
   * @private
   */
  async #ensureContext(context) {
    if (!context) {
      return null;
    }

    if (typeof context === 'string') {
      const result = await this.locate(context);
      if (!result.context) {
        throw new Error(result.message ? result.message :  `Code '${context}' not found in CodeSystem '${this.system()}'`);
      }
      return result.context;
    }

    if (context instanceof FhirCodeSystemProviderContext) {
      return context;
    }

    throw new Error("Unknown Type at #ensureContext: " + (typeof context));
  }
  /**
   * @param {string|FhirCodeSystemProviderContext} context - Code or context
   * @returns {Promise<string|null>} The best display given the languages in the operation context
   */
  async display(context) {
    
    const ctxt = await this.#ensureContext(context);
    if (!ctxt) {
      return null;
    }

    // Check supplements first
    const supplementDisplay = this._displayFromSupplements(ctxt.code);
    if (supplementDisplay) {
      return supplementDisplay;
    }
    // a code in the reserved code space has the display an extension-codes supplement gives it,
    // whatever languages were asked for - or, if none does, the code space's default display
    if (ctxt.reserved) {
      return this._extensionCodeDisplay(ctxt.code) || this.codeSystem.reservedCodeSpaceFor(ctxt.code).defaultDisplay;
    }

    // Use language-aware display logic
    if (this.opContext.langs && !this.opContext.langs.isEnglishOrNothing()) {
      // Try to find exact language match in designations
      if (ctxt.concept.designation && Array.isArray(ctxt.concept.designation)) {
        for (const lang of this.opContext.langs.languages) {
          for (const designation of ctxt.concept.designation) {
            if (designation.language) {
              const designationLang = new Language(designation.language);
              if (designationLang.matchesForDisplay(lang)) {
                return designation.value.trim();
              }
            }
          }
        }
      }

      // Check if the CodeSystem's language matches requested languages
      if (this.defaultLanguage) {
        for (const requestedLang of this.opContext.langs.languages) {
          if (this.defaultLanguage.matchesForDisplay(requestedLang)) {
            return ctxt.concept.display?.trim() || '';
          }
        }
      }
    }

    // Default to the concept's display
    return ctxt.concept.display?.trim() || '';
  }

  /**
   * @param {string|FhirCodeSystemProviderContext} context - Code or context
   * @returns {Promise<string|null>} The definition for the concept (if available)
   */
  async definition(context) {
    
    const ctxt = await this.#ensureContext(context);
    return ctxt ? (ctxt.concept.definition || null) : null;
  }

  isCaseSensitive() {
    return !this.codeSystem.caseInsensitive();
  }

  /**
   * @param {string|FhirCodeSystemProviderContext} context - Code or context
   * @returns {Promise<boolean>} If the concept is abstract
   */
  async isAbstract(context) {
    
    const ctxt = await this.#ensureContext(context);
    if (!ctxt) {
      return false;
    }

    // Check for the notSelectable property, by whatever code this code system gives it
    if (ctxt.concept.property && Array.isArray(ctxt.concept.property)) {
      const codes = this.standardPropertyCodes('notSelectable', ['abstract', 'not-selectable']);
      const abstractProp = ctxt.concept.property.find(p => codes.has(p.code));
      if (abstractProp && abstractProp.valueBoolean) {
        return true;
      }
    }

    return false;
  }

  /**
   * @param {string|FhirCodeSystemProviderContext} context - Code or context
   * @returns {Promise<boolean>} If the concept is inactive
   */
  async isInactive(context) {
    
    const ctxt = await this.#ensureContext(context);
    if (!ctxt) {
      return false;
    }

    if (ctxt.concept.property && Array.isArray(ctxt.concept.property)) {
      for (const p of ctxt.concept.property) {
        // Check inactive property with boolean value
        if (p.code === 'inactive' && p.valueBoolean === true) {
          return true;
        }
        // Check inactive property with code value 'true'
        if (p.code === 'inactive' && p.valueCode === 'true') {
          return true;
        }
        // Check status property for inactive or retired
        if (p.code === 'status') {
          const value = p.valueCode || p.valueString || (p.value && p.value.toString());
          if (value === 'inactive' || value === 'retired') {
            return true;
          }
        }
      }
    }

    // Check standards-status extension for withdrawn
    if (ctxt.concept.extension && Array.isArray(ctxt.concept.extension)) {
      const standardsStatus = ctxt.concept.extension.find(e =>
        e.url === 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status'
      );
      if (standardsStatus) {
        const value = standardsStatus.valueCode || standardsStatus.valueString || '';
        if (value.toLowerCase() === 'withdrawn') {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * @param {string|FhirCodeSystemProviderContext} context - Code or context
   * @returns {Promise<boolean>} If the concept is deprecated
   */
  async isDeprecated(context) {
    
    const ctxt = await this.#ensureContext(context);
    if (!ctxt) {
      return false;
    }

    // Check for deprecated property or status
    if (ctxt.concept.property && Array.isArray(ctxt.concept.property)) {
      const deprecatedProp = ctxt.concept.property.find(p =>
        p.code === 'deprecated' ||
        p.uri === 'http://hl7.org/fhir/concept-properties#deprecated'
      );
      if (deprecatedProp && deprecatedProp.valueBoolean) {
        return true;
      }

      // Check status property
      const statusProp = ctxt.concept.property.find(p =>
        p.code === 'status' ||
        p.uri === 'http://hl7.org/fhir/concept-properties#status'
      );
      if (statusProp && (statusProp.valueCode === 'deprecated' || statusProp.valueCode === 'retired')) {
        return true;
      }
    }

    return false;
  }

  /**
   * @param {string|FhirCodeSystemProviderContext} context - Code or context
   * @returns {Promise<string|null>} Status
   */
  async getStatus(context) {

    const ctxt = await this.#ensureContext(context);
    if (!ctxt) {
      return null;
    }

    for (let cp of ctxt.concept.property || []) {
      if (cp.code === 'status' || cp.uri === 'http://hl7.org/fhir/concept-properties#status') {
        return getValuePrimitive(cp);
      }
    }

    // Second pass: check various deprecation/inactive/retired patterns
    for (let cp of ctxt.concept.property || []) {
      if (cp.code === 'deprecated') {
        if (cp.valueBoolean === true) return 'deprecated';
        if (getValuePrimitive(cp) === 'true') return 'deprecated';
      }
      if (cp.code === 'deprecationDate' && cp.valueDateTime) {
        if (new Date(cp.valueDateTime) < new Date()) return 'deprecated';
      }
      if (cp.code === 'inactive') {
        if (cp.valueBoolean === true) return 'inactive';
        if (getValuePrimitive(cp) === 'true') return 'inactive';
      }
      if (cp.code === 'retired') {
        if (cp.valueBoolean === true) return 'retired';
        if (getValuePrimitive(cp) === 'true') return 'retired';
      }
    }
    const ext = (ctxt.concept.extension || []).find(
      e => e.url === 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status'
    );
    if (ext) {
      return ext.valueCode || ext.valueString || '';
    }

    return null;
  }

  /**
   * @param {string|FhirCodeSystemProviderContext} context - Code or context
   * @returns {Promise<string|null>} Assigned itemWeight - if there is one
   */
  async itemWeight(context) {
    
    const ctxt = await this.#ensureContext(context);
    if (!ctxt) {
      return null;
    }

    // Check for itemWeight extension
    if (ctxt.concept.extension && Array.isArray(ctxt.concept.extension)) {
      const itemWeightExt = ctxt.concept.extension.find(ext =>
        ext.url === 'http://hl7.org/fhir/StructureDefinition/itemWeight'
      );
      if (itemWeightExt && itemWeightExt.valueDecimal !== undefined) {
        return itemWeightExt.valueDecimal.toString();
      }
    }

    // Check in supplements
    if (this.supplements) {
      for (const supplement of this.supplements) {
        const supplementConcept = supplement.getConceptByCode(ctxt.code);
        if (supplementConcept && supplementConcept.extension && Array.isArray(supplementConcept.extension)) {
          const itemWeightExt = supplementConcept.extension.find(ext =>
            ext.url === 'http://hl7.org/fhir/StructureDefinition/itemWeight'
          );
          if (itemWeightExt && itemWeightExt.valueDecimal !== undefined) {
            return itemWeightExt.valueDecimal;
          }
        }
      }
    }

    return null;
  }

  /**
   * @param {string|FhirCodeSystemProviderContext} context - Code or context
   * @param {ConceptDesignations} designation list
   * @returns {Promise<Designation[]|null>} Whatever designations exist (in all languages)
   */
  async designations(context, displays) {
    
    const ctxt = await this.#ensureContext(context);
    if (!ctxt) {
      return null;
    }

    // Add main display as a designation
    if (ctxt.concept.display) {
      const displayLang = this.defaultLanguage ? this.defaultLanguage.toString() : null; // 'en';
      displays.addDesignation(true, 'active', displayLang, CodeSystem.makeUseForDisplay(), ctxt.concept.display);
    }

    // Add concept designations. A designation with no language of its own is in the code
    // system's language (CodeSystem.language), not in no language at all
    if (ctxt.concept.designation && Array.isArray(ctxt.concept.designation)) {
      const csLang = this.defaultLanguage ? this.defaultLanguage.toString() : '';
      for (const designation of ctxt.concept.designation) {
        let status = Extensions.readString(designation, "http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status");
        displays.addDesignation(false, status || 'active',
          designation.language || csLang,
          designation.use || null,
          designation.value,
          designation.extension?.length > 0 ? designation.extension : []
        );
      }
    }

    // a code in the reserved code space that no extension-codes supplement in scope gives a display has
    // its code space's default display ('User-assigned'). It is a placeholder, so (as for ISO 3166's
    // user-assigned codes) another display is not wrong - see validate.js checkDisplays
    if (ctxt.reserved && !this._extensionCodeDisplay(ctxt.code)) {
      displays.userDefined = true;
      const displayLang = this.defaultLanguage ? this.defaultLanguage.toString() : null;
      displays.addDesignation(true, 'active', displayLang, CodeSystem.makeUseForDisplay(), this.codeSystem.reservedCodeSpaceFor(ctxt.code).defaultDisplay);
    }

    // Add supplement designations
    this._listSupplementDesignations(ctxt.code, displays, ctxt.reserved);
  }

  /**
   * @param {string|FhirCodeSystemProviderContext} context - Code or context
   * @returns {Promise<Object[]|null>} Extensions, if any
   */
  async extensions(context) {
    
    const ctxt = await this.#ensureContext(context);
    if (!ctxt) {
      return null;
    }

    const extensions = [];

    // Add extensions from main concept
    if (ctxt.concept.extension && Array.isArray(ctxt.concept.extension)) {
      extensions.push(...ctxt.concept.extension);
    }

    // Add extensions from supplements
    if (this.supplements) {
      for (const supplement of this.supplements) {
        const supplementConcept = supplement.getConceptByCode(ctxt.code);
        if (supplementConcept && supplementConcept.extension && Array.isArray(supplementConcept.extension)) {
          extensions.push(...supplementConcept.extension);
        }
      }
    }

    return extensions.length > 0 ? extensions : null;
  }

  getPropertyDefinition(cs, code) {
    for (let p of cs.property || []) {
      if (code == p.code) {
        return p;
      }
    }
    return undefined;
  }

  /**
   * @param {string|FhirCodeSystemProviderContext} context - Code or context
   * @returns {Promise<Object[]|null>} Properties, if any
   */
  async properties(context) {
    
    const ctxt = await this.#ensureContext(context);
    if (!ctxt) {
      return [];
    }

    const properties = [];

    // Add properties from main concept
    for (let p of ctxt.concept.property || []) {
      let pd = this.getPropertyDefinition(this.codeSystem.jsonObj, p.code);
      properties.push({ ...p, definition: pd });
    }

    // Add properties from supplements
    if (this.supplements) {
      for (const supplement of this.supplements) {
        const supplementConcept = supplement.getConceptByCode(ctxt.code);
        if (supplementConcept) {
          for (let p of supplementConcept.property || []) {
            let pd = this.getPropertyDefinition(supplement.jsonObj, p.code);
            properties.push({...p, definition: pd});
          }
        }
      }
    }

    return properties;
  }

  /**
   * @param {string|FhirCodeSystemProviderContext} context - Code or context
   * @returns {Promise<string|null>} Parent, if there is one
   */
  async parent(context) {
    
    const ctxt = await this.#ensureContext(context);
    if (!ctxt) {
      return null;
    }

    // Get parents from CodeSystem hierarchy maps
    const parents = this.codeSystem.getParents(ctxt.code);
    return parents.length > 0 ? parents[0] : null;
  }

  /**
   * @param {string|FhirCodeSystemProviderContext} a - First code or context
   * @param {string|FhirCodeSystemProviderContext} b - Second code or context
   * @returns {Promise<boolean>} True if they're the same
   */
  async sameConcept(a, b) {
    

    const ctxtA = await this.#ensureContext(a);
    const ctxtB = await this.#ensureContext(b);

    if (!ctxtA || !ctxtB) {
      return false;
    }

    return ctxtA.code === ctxtB.code;
  }

  /**
   * @param {string} code - The code to locate
   * @param {string} parent - The parent code
   * @param {boolean} disallowSelf - Whether to disallow the code being the same as parent
   * @returns {Promise<{context: FhirCodeSystemProviderContext|null, message: string|null}>} Locate result
   */
  async locateIsA(code, parent, disallowSelf = false) {
    

    if (!this.hasParents()) {
      return {
        context: null,
        message: `The CodeSystem ${this.name()} does not have parents`
      };
    }

    // First check if both codes exist
    const codeResult = await this.locate(code);
    if (!codeResult.context) {
      return codeResult;
    }

    const parentResult = await this.locate(parent);
    if (!parentResult.context) {
      return {
        context: null,
        message: `Parent code '${parent}' not found in CodeSystem '${this.system()}'`
      };
    }

    // Check if code is same as parent
    if (code === parent) {
      if (disallowSelf) {
        return {
          context: null,
          message: `Code '${code}' cannot be the same as its parent`
        };
      } else {
        return codeResult; // Return the code itself
      }
    }

    // Check if code is a descendant of parent
    const ancestors = this.codeSystem.getAncestors(code);
    if (ancestors.includes(parent)) {
      return codeResult;
    }

    return {
      context: null,
      message: `Code '${code}' is not a descendant of '${parent}'`
    };
  }

  /**
   * @param {string} codeA - First code
   * @param {string} codeB - Second code
   * @returns {Promise<string>} 'subsumes', 'subsumed-by', 'equivalent', or 'not-subsumed'
   */
  async subsumesTest(codeA, codeB) {
    

    // Check if both codes exist
    const resultA = await this.locate(codeA);
    if (!resultA.context) {
      throw new Error(`Unknown Code "${codeA}"`);
    }

    const resultB = await this.locate(codeB);
    if (!resultB.context) {
      throw new Error(`Unknown Code "${codeB}"`);
    }

    // Check if they're the same
    if (codeA === codeB) {
      return 'equivalent';
    }

    // If no hierarchy, codes can't subsume each other
    if (!this.hasParents()) {
      return 'not-subsumed';
    }

    // Check if A subsumes B (B is descendant of A)
    if (this.codeSystem.isDescendantOf(codeB, codeA)) {
      return 'subsumes';
    }

    // Check if B subsumes A (A is descendant of B)
    if (this.codeSystem.isDescendantOf(codeA, codeB)) {
      return 'subsumed-by';
    }

    return 'not-subsumed';
  }

  /**
   * The codes a code sits under, for $closure (see CodeSystemProvider.ancestorsOf): the
   * CodeSystem's own ancestor walk, which is what subsumesTest above asks of each pair.
   *
   * Only a code in the form code() gives is answered (in a case-insensitive code system,
   * another spelling gets null). A subclass with its own subsumesTest (ICF) gets null too,
   * since this walk may not be what it answers from.
   *
   * @param {string|FhirCodeSystemProviderContext} code
   * @returns {Promise<Set<string>|null>}
   */
  async ancestorsOf(code) {
    if (this.subsumesTest !== FhirCodeSystemProvider.prototype.subsumesTest) {
      return null;
    }
    const ctxt = typeof code === 'string' ? (await this.locate(code)).context : code;
    if (!(ctxt instanceof FhirCodeSystemProviderContext) || (typeof code === 'string' && ctxt.code !== code)) {
      return null;
    }
    return new Set(this.hasParents() ? this.codeSystem.getAncestors(ctxt.code) : []);
  }

  /**
   * @param {string|FhirCodeSystemProviderContext} context - Code or context to iterate from
   * @returns {Promise<Object|null>} A handle that can be passed to nextContext (or null if can't be iterated)
   */
  async iterator(context) {


    if (!context) {
      const allCodes = this.codeSystem.getRootConcepts();
      return {
        type: 'all',
        codes: allCodes,
        current: 0,
        total: allCodes.length
      };
    } else {
      const ctxt = await this.#ensureContext(context);
      if (!ctxt) {
        return null;
      }

      // Iterate children of the specified concept
      const children = this.codeSystem.getChildren(ctxt.code);
      return {
        type: 'children',
        parentCode: ctxt.code,
        codes: children,
        current: 0,
        total: children.length
      };
    }
  }

  /**
   * @returns {Promise<Object|null>} A handle that can be passed to nextContext (or null if can't be iterated)
   */
  async iteratorAll() {
    const allCodes = this.codeSystem.getAllCodes();
    return {
      type: 'all',
      codes: allCodes,
      current: 0,
      total: allCodes.length
    };
  }

  /**
   * @param {Object} iteratorContext - Iterator context from iterator()
   * @returns {Promise<FhirCodeSystemProviderContext|null>} The next concept, or null
   */
  async nextContext(iteratorContext) {
    

    if (!iteratorContext || iteratorContext.current >= iteratorContext.total) {
      return null;
    }

    const code = iteratorContext.codes[iteratorContext.current];
    iteratorContext.current++;

    // Get the concept for this code
    const concept = this.codeSystem.getConceptByCode(code);
    if (!concept) {
      return null;
    }

    return new FhirCodeSystemProviderContext(code, concept);
  }

  /**
   * @param {FhirCodeSystemProviderContext} ctxt - The context to add properties for
   * @param {string[]} props - The properties requested
   * @param {Object} params - The parameters response to add to
   */
  async extendLookup(ctxt, props, params) {
    validateArrayParameter(props, 'props', String);
    validateArrayParameter(params, 'params', Object);


    if (!ctxt || !(ctxt instanceof FhirCodeSystemProviderContext)) {
      return;
    }

    // Add the concept's properties: each one if it was asked for by its code (or '*', or nothing
    // was asked for). 'property' asks for all of them - it used to be the only thing that did, so
    // asking for a property by its own code returned nothing. A code the server doesn't know is
    // simply not matched
    {
      const properties = await this.properties(ctxt);
      if (properties) {
        for (const property of properties) {
          if (!this._hasProp(props, property.code, true) && !this._hasProp(props, 'property', true)) {
            continue;
          }
          let parts = [];
          parts.push({ name: 'code', valueCode: property.code });

          // Add the appropriate value based on the property type
          if (property.valueCode) {
            parts.push({ name: 'value', valueCode: property.valueCode });
          } else if (property.valueString) {
            parts.push({ name: 'value', valueString: property.valueString });
          } else if (property.valueInteger !== undefined) {
            parts.push({ name: 'value', valueInteger: property.valueInteger });
          } else if (property.valueBoolean !== undefined) {
            parts.push({ name: 'value', valueBoolean: property.valueBoolean });
          } else if (property.valueDateTime) {
            parts.push({ name: 'value', valueDateTime: property.valueDateTime });
          } else if (property.valueDecimal !== undefined) {
            parts.push({ name: 'value', valueDecimal: property.valueDecimal });
          } else if (property.valueCoding) {
            parts.push({ name: 'value', valueCoding: property.valueCoding });
          }
          params.push({ name: 'property', part: [...parts]});
        }
      }
    }

    // Add parent if requested and exists
    if (this._hasProp(props, 'parent', true)) {
      const parentCode = await this.parent(ctxt);
      if (parentCode) {
        let parts = [];
        parts.push({ name: 'code', valueCode: 'parent' });
        parts.push({ name: 'value', valueCode: parentCode });
        parts.push({ name: 'description', valueString: await this.display(parentCode) });
        params.push({ name: 'property', part : [...parts]});
      }
    }

    // Add children if requested
    if (this._hasProp(props, 'child', true)) {
      const children = this.codeSystem.getChildren(ctxt.code);
      if (children.length > 0) {
        for (const childCode of children) {
          let parts = [];
          parts.push({ name: 'code', valueCode: 'child' });
          parts.push({ name: 'value', valueCode: childCode });
          parts.push({ name: 'description', valueString: await this.display(childCode) });
          params.push({ name: 'property', part : [...parts]});
        }
      }
    }
  }

  /**
   * @param {boolean} iterate - True if results will be iterated
   * @returns {FilterExecutionContext} Filter context
   */
  async getPrepContext(iterate, languages = null) {
    const result = new FilterExecutionContext(iterate);
    result.languages = languages; // what the request asked for (a text filter searches one language)
    return result;
  }

  /**
   * @param {FilterExecutionContext} filterContext - Filter context
   * @returns {boolean} True if filters are not closed (infinite results possible)
   */
  // eslint-disable-next-line no-unused-vars
  async filtersNotClosed(filterContext) {
    
    return false; // FHIR CodeSystems are typically closed/finite
  }

  /**
   * Determines if a specific filter is supported
   * @param {string} prop - Property name
   * @param {string} op - Filter operator (=, is-a, descendent-of, etc.)
   * @param {string} value - Filter value
   * @returns {Promise<boolean>} True if filter is supported
   */
  async doesFilter(prop, op, value) {
    validateOptionalParameter(value, "value", String);
    if (!value) {
      return false;
    }
    // Supported hierarchy filters
    if ((prop === 'concept' || prop === 'code') &&
      ['is-a', 'descendent-of', 'descendent-leaf', 'is-not-a', 'child-of', 'in', 'not-in', '=', 'regex'].includes(op)) {
      return true;
    }

    // Child existence filter
    if (prop === 'child' && op === 'exists') {
      return true;
    }

    // Property-based filters
    const propertyDefs = this.propertyDefinitions();
    if (propertyDefs) {
      const hasProperty = propertyDefs.some(p => p.code === prop);
      if (hasProperty && ['=', 'in', 'not-in', 'regex', 'exists'].includes(op)) {
        return true;
      }
    }

    // Known special properties
    const knownProperties = ['notSelectable', 'status', 'inactive', 'deprecated'];
    if (knownProperties.includes(prop) && ['=', 'in', 'not-in'].includes(op)) {
      return true;
    }

    return false;
  }

  /**
   * Execute filter preparation - returns array of filter contexts
   * @param {FilterExecutionContext} filterContext - Filter context
   * @returns {Promise<Array>} Array of filter result sets
   */
  async executeFilters(filterContext) {
    

    // Return the accumulated filters from the context
    return filterContext.filters || [];
  }

  /**
   * Get the size of a filter result set
   * @param {FilterExecutionContext} filterContext - Filter context
   * @param {FhirCodeSystemProviderFilterContext} set - Filter result set
   * @returns {Promise<number>} Number of concepts in the set
   */
  async filterSize(filterContext, set) {
    
    return set ? set.size() : 0;
  }

  /**
   * Check if there are more results in the filter set iterator
   * @param {FilterExecutionContext} filterContext - Filter context
   * @param {FhirCodeSystemProviderFilterContext} set - Filter result set
   * @returns {Promise<boolean>} True if more results available
   */
  async filterMore(filterContext, set) {
    
    if (!set) return false;
    return set.hasMore();
  }

  /**
   * Get the current concept from the filter set iterator
   * @param {FilterExecutionContext} filterContext - Filter context
   * @param {FhirCodeSystemProviderFilterContext} set - Filter result set
   * @returns {Promise<FhirCodeSystemProviderContext|null>} Current concept context
   */
  async filterConcept(filterContext, set) {
    
    if (!set) return null;

    const concept = set.next();
    return concept ? new FhirCodeSystemProviderContext(concept.code, concept) : null;
  }

  /**
   * Find a specific code in the filter results
   * @param {FilterExecutionContext} filterContext - Filter context
   * @param {FhirCodeSystemProviderFilterContext} set - Filter result set
   * @param {string} code - Code to find
   * @returns {Promise<FhirCodeSystemProviderContext|string>} Context if found, error message if not
   */
  async filterLocate(filterContext, set, code) {
    
    if (!set) {
      return `Code '${code}' not found: no filter results`;
    }

    const concept = set.findConceptByCode(code);
    if (concept) {
      return new FhirCodeSystemProviderContext(code, concept);
    }

    return null; // `Code '${code}' not found in filter results`;
  }

  /**
   * Check if a concept is in the filter results
   * @param {FilterExecutionContext} filterContext - Filter context
   * @param {FhirCodeSystemProviderFilterContext} set - Filter result set
   * @param {FhirCodeSystemProviderContext} concept - Concept to check
   * @returns {Promise<boolean|string>} True if found, error message if not
   */
  async filterCheck(filterContext, set, concept) {
    
    if (!set || !concept) {
      return 'Invalid filter set or concept';
    }

    const found = set.containsConcept(concept.concept);
    return found ? true : `Concept '${concept.code}' not found in filter results`;
  }

  /**
   * Clean up filter resources
   * @param {FilterExecutionContext} filterContext - Filter context
   */
  async filterFinish(filterContext) {
    
    // Clear any cached data
    if (filterContext.filters) {
      filterContext.filters.forEach(filter => {
        if (filter.reset) {
          filter.reset();
        }
      });
      filterContext.filters.length = 0;
    }
  }
  /**
   * Execute text-based search filter. The same rules as every provider's search (text-match.js):
   * the concepts with a name (the display, or a designation) in the search language that has every
   * word of the filter, or a code that starts with it; and those that a supplement in use gives a
   * matching name (_supplementSearchCodes). Answered from the code system's text index, built the
   * first time it is searched
   * @param {FilterExecutionContext} filterContext - Filter context
   * @param {SearchFilterText} filter - the filter
   * @param {boolean} sort - Whether to sort results by relevance
   * @returns {Promise<FhirCodeSystemProviderFilterContext>} Filter results
   */
  async searchFilter(filterContext, filter, sort) {
    const results = new FhirCodeSystemProviderFilterContext();
    const query = filter.query;
    // the display and designations in one language only (see searchLanguage)
    const lang = this.searchLanguage(filterContext.languages);
    const allConcepts = this.codeSystem.getAllConcepts();
    const index = await this.#textIndex(allConcepts);
    this.opContext.deadCheck('cs:searchFilter');

    const ratings = new Map(); // concept ordinal -> rating
    for (const [ordinal, texts] of index.searchNames(query, lang)) {
      const concept = allConcepts[ordinal];
      let rating = 0;
      for (const text of texts) {
        // the display is the better match; a designation, a little less
        const r = query.nameRank(text, lang) - (text === concept.display ? 0 : 10);
        rating = Math.max(rating, r);
      }
      ratings.set(ordinal, Math.max(1, rating));
    }
    for (const ordinal of index.searchCodes(query)) {
      ratings.set(ordinal, Math.max(ratings.get(ordinal) || 0, query.codeRank(allConcepts[ordinal].code)));
    }
    if (this.supplements && this.supplements.length > 0) {
      const sources = new Map();
      const supplementCodes = await this._supplementSearchCodes(filter, lang, sources);
      if (supplementCodes.size > 0) {
        for (let ordinal = 0; ordinal < allConcepts.length; ordinal++) {
          const code = allConcepts[ordinal].code;
          if (supplementCodes.has(code) && !ratings.has(ordinal)) {
            ratings.set(ordinal, 10);
            CodeSystemProvider.noteSupplementUsed(filterContext, sources.get(code));
          }
        }
      }
    }

    // in the code system's order, unless sorted
    for (const ordinal of [...ratings.keys()].sort((a, b) => a - b)) {
      results.add(allConcepts[ordinal], ratings.get(ordinal));
    }
    if (sort) {
      results.sort();
    }

    // Add to filter context
    if (!filterContext.filters) {
      filterContext.filters = [];
    }
    filterContext.filters.push(results);

    return results;
  }

  /**
   * The text index of the code system: its concepts' displays (in its language) and designations
   * (in theirs), and codes, keyed by the concept's place in getAllConcepts(). Built once, letting
   * other work run while it is; built again if the concepts change
   */
  async #textIndex(allConcepts) {
    // a code system loaded as the server started has its index in the store (text-index-store.js)
    const stored = TextIndexStore.indexFor(this.codeSystem);
    if (stored && stored.size === allConcepts.length) {
      return stored;
    }
    let entry = TEXT_INDEXES.get(this.codeSystem);
    if (!entry || entry.size !== allConcepts.length) {
      const index = new NameIndex();
      TextIndexStore.fillCodeSystem(allConcepts, this.defLang(), index);
      entry = { size: allConcepts.length, promise: index.build() };
      entry.promise.catch(() => TEXT_INDEXES.delete(this.codeSystem));
      TEXT_INDEXES.set(this.codeSystem, entry);
    }
    return await entry.promise;
  }

  /**
   * The code's own display, without what supplements give it
   */
  async _rootDisplay(code) {
    const concept = this.codeSystem.getConceptByCode(code);
    return concept ? concept.display || null : null;
  }

  /**
   * As for any code system (CodeSystemProvider.searchLanguage), but whether there is text in
   * a language is decided by what the code system actually has: its own language, a designation
   * in it, or a supplement's (hasAnyDisplays says yes to English whatever the code system's
   * language is)
   */
  searchLanguage(languages) {
    for (const lang of (languages && languages.languages) || []) {
      if (lang && lang.language && lang.code !== '*' && this.#hasSearchText(lang)) {
        return lang;
      }
    }
    return new Language(this.defLang());
  }

  #hasSearchText(lang) {
    const csLang = this.defLang();
    if (CodeSystemProvider.inSearchLanguage(csLang, lang)) {
      return true;
    }
    for (const concept of this.codeSystem.getAllConcepts()) {
      if ((concept.designation || []).some(d => d.value && CodeSystemProvider.inSearchLanguage(d.language, lang, csLang))) {
        return true;
      }
    }
    return this._hasSupplementText(lang);
  }

  /**
   * Execute a value set filter
   * @param {FilterExecutionContext} filterContext - Filter context
   * @param {string} prop - Property name to filter on
   * @param {string} op - Filter operator
   * @param {string} value - Filter value
   * @returns {Promise<FhirCodeSystemProviderFilterContext>} Filter results
   */
  async filter(filterContext, forIteration, prop, op, value, fc) {
    let results = null;

    // Reuse previously resolved analysis when this same cached value set filter
    // is resolved again against the same code system version (see filter()/fc).
    // Only expensive filters are cached; the concept list is shared read-only,
    // wrapped in a fresh context so iteration state (the cursor) is per-use.
    // Caching needs a stable code system identity. When the code system has no
    // url (odd corner cases) _filterCacheVersionKey returns null and caching is
    // skipped entirely - there's no safe key to store or look up under.
    const vkey = fc ? this._filterCacheVersionKey() : null;
    const cacheable = vkey !== null && this._isCacheableFilter(prop, op);
    if (cacheable) {
      const cachedConcepts = recall(fc, FILTER_ANALYSIS, vkey);
      if (cachedConcepts) {
        results = new FhirCodeSystemProviderFilterContext();
        results.concepts = cachedConcepts; // immutable: read-only from here
      }
    }

    if (!results) {
      // Handle concept/code hierarchy filters
      if ((prop === 'concept' || prop === 'code')) {
        results = await this._handleConceptFilter(filterContext, prop, op, value);
      }

      // Handle child existence filter
      if (prop === 'child' && op === 'exists') {
        results = await this._handleChildExistsFilter(filterContext, value);
      }

      // Handle property-based filters
      const propertyDefs = this.propertyDefinitions();
      if (propertyDefs) {
        const propertyDef = propertyDefs.find(p => p.code === prop);
        if (propertyDef) {
          results = await this._handlePropertyFilter(filterContext, propertyDef, op, value);
        }
      }

      // Handle known special properties - unless the code system uses the code for a
      // property of its own, in which case the property filter above applies
      const knownProperties = ['notSelectable', 'status', 'inactive', 'deprecated'];
      if (knownProperties.includes(prop) && !this.redefinesStandardProperty(prop)) {
        results = await this._handleKnownPropertyFilter(filterContext, prop, op, value);
      }

      if (!results) {
        throw new Issue('error', 'not-supported', null, 'FILTER_NOT_UNDERSTOOD',
              this.opContext.i18n.translate('FILTER_NOT_UNDERSTOOD', this.opContext.langs, [prop, op, value]), 'vs-invalid', 422);
      }

      // Store a private copy of the resolved concept list for reuse. A slice
      // isolates the cache from any later mutation of this request's context.
      if (cacheable) {
        remember(fc, FILTER_ANALYSIS, vkey, results.concepts.slice());
      }
    }

    // Add to filter context
    if (!filterContext.filters) {
      filterContext.filters = [];
    }
    filterContext.filters.push(results);

    return results;
  }

  /**
   * Whether a filter is expensive enough to be worth memoising: the full-scan
   * or subtree-walk families. Cheap lookups (=, in on a code list, child-of)
   * are not cached. Mirrors the dispatch in filter().
   * @private
   */
  _isCacheableFilter(prop, op) {
    if (prop === 'concept' || prop === 'code') {
      return op === 'is-a' || op === 'descendent-of' || op === 'descendent-leaf' || op === 'is-not-a' || op === 'regex';
    }
    if (prop === 'child' && op === 'exists') {
      return true;
    }
    const propertyDefs = this.propertyDefinitions();
    if (propertyDefs && propertyDefs.find(p => p.code === prop)) {
      return true;
    }
    return ['notSelectable', 'status', 'inactive', 'deprecated'].includes(prop);
  }

  /**
   * Cache key pinning resolved analysis to the code system identity + version.
   * @private
   */
  _filterCacheVersionKey() {
    const url = this.codeSystem.jsonObj.url;
    if (!url) {
      return null;
    }
    return url + '|' + (this.codeSystem.jsonObj.version || '');
  }

  /**
   * Handle concept/code filters (is-a, descendent-of, etc.)
   * @param {FilterExecutionContext} filterContext - Filter context
   * @param {string} op - Filter operator
   * @param {string} value - Filter value (code)
   * @returns {Promise<FhirCodeSystemProviderFilterContext>} Filter results
   * @private
   */
  async _handleConceptFilter(filterContext, prop, op, value) {
    const results = new FhirCodeSystemProviderFilterContext();

    if (op === 'is-a' || op === 'descendent-of') {
      // Find all descendants of the specified code
      const includeRoot = (op === 'is-a');
      await this._addDescendants(results, value, includeRoot);
    } else if (op === 'descendent-leaf') {
      // R5: the descendants that have no children of their own
      if (this.codeSystem.getConceptByCode(value)) {
        for (const code of this.codeSystem.getDescendants(value)) {
          this.opContext.deadCheck('cs:conceptFilter:descendent-leaf');
          if (code !== value && this.codeSystem.getChildren(code).length === 0) {
            const concept = this.codeSystem.getConceptByCode(code);
            if (concept) {
              results.add(concept, 0);
            }
          }
        }
      }
    } else if (op === 'child-of') {
      // Find all descendants of the specified code
      await this._addChildren(results, value);
    } else if (op === 'is-not-a') {
      // Find all concepts that are NOT descendants of the specified code
      const excludeDescendants = this.codeSystem.getDescendants(value);
      const excludeSet = new Set([value, ...excludeDescendants]);

      const allCodes = this.codeSystem.getAllCodes();
      for (const code of allCodes) {
        this.opContext.deadCheck('cs:conceptFilter:is-not-a');
        if (!excludeSet.has(code)) {
          const concept = this.codeSystem.getConceptByCode(code);
          if (concept) {
            results.add(concept, 0);
          }
        }
      }
    }
    else if (op === 'in') {
      // Value is comma-separated list of codes
      const codes = value.split(',').map(c => c.trim());
      for (const code of codes) {
        const concept = this.codeSystem.getConceptByCode(code);
        if (concept) {
          results.add(concept, 0);
        }
      }
    }
    else if (op === 'not-in') {
      // Every code except the listed ones (comma separated) - their descendants are not excluded
      const excludeSet = new Set(value.split(',').map(c => c.trim()));
      const allCodes = this.codeSystem.getAllCodes();
      for (const code of allCodes) {
        this.opContext.deadCheck('cs:conceptFilter:not-in');
        if (!excludeSet.has(code)) {
          const concept = this.codeSystem.getConceptByCode(code);
          if (concept) {
            results.add(concept, 0);
          }
        }
      }
    }
    else if (op === '=') {
      // Exact match
      const concept = this.codeSystem.getConceptByCode(value);
      if (concept) {
        results.add(concept, 0);
      }
    }
    else if (op === 'regex') {
      // Regular expression match
      try {
        const regex = regexUtilities.compile('^(?:' + value + ')$'); // the whole value: a|b is ^(?:a|b)$, not ^a|b$
        const allCodes = this.codeSystem.getAllCodes();
        for (const code of allCodes) {
          this.opContext.deadCheck('cs:conceptFilter:regex');
          if (regex.test(code)) {
            const concept = this.codeSystem.getConceptByCode(code);
            if (concept) {
              results.add(concept, 0);
            }
          }
        }
      } catch (error) {
        throw new Issue('error', 'exception', null, 'INVALID_REGEX', this.opContext.i18n.translate('INVALID_REGEX', this.opContext.langs, [value, error.message]), 'vs-invalid', 422);
      }
    } else {
      throw new Issue('error', 'not-supported', null, 'FILTER_NOT_UNDERSTOOD',
          this.opContext.i18n.translate('FILTER_NOT_UNDERSTOOD', this.opContext.langs, [prop, op, value]), 'vs-invalid', 422);
    }

    return results;
  }

  /**
   * Add descendants of a code to the results
   * @param {FhirCodeSystemProviderFilterContext} results - Results to add to
   * @param {string} ancestorCode - The ancestor code
   * @param {boolean} includeRoot - Whether to include the root code itself
   * @private
   */
  async _addDescendants(results, ancestorCode, includeRoot) {
    const concept = this.codeSystem.getConceptByCode(ancestorCode);
    if (concept) {
      if (includeRoot) {
        results.add(concept, 0);
      }
      const descendants = this.codeSystem.getDescendants(ancestorCode);
      for (const code of descendants) {
        this.opContext.deadCheck('cs:addDescendants');
        if (code !== ancestorCode) {
          const concept = this.codeSystem.getConceptByCode(code);
          if (concept) {
            results.add(concept, 0);
          }
        }
      }
    }
  }

  /**
   * Add immediate children of a code to the results
   * @param {FhirCodeSystemProviderFilterContext} results - Results to add to
   * @param {string} ancestorCode - The parent code
   * @private
   */
  async _addChildren(results, parentCode) {
    const concept = this.codeSystem.getConceptByCode(parentCode);
    if (concept) {
      const descendants = this.codeSystem.getChildren(parentCode);
      for (const code of descendants) {
        this.opContext.deadCheck('cs:addChildren');
        if (code !== parentCode) { // should not be
          const concept = this.codeSystem.getConceptByCode(code);
          if (concept) {
            results.add(concept, 0);
          }
        }
      }
    }
  }

  /**
   * Handle child exists filter
   * @param {FilterExecutionContext} filterContext - Filter context
   * @param {string} value - 'true' or 'false'
   * @returns {Promise<FhirCodeSystemProviderFilterContext>} Filter results
   * @private
   */
  async _handleChildExistsFilter(filterContext, value) {
    const results = new FhirCodeSystemProviderFilterContext();
    const wantChildren = (value === 'true');

    const allCodes = this.codeSystem.getAllCodes();
    for (const code of allCodes) {
      this.opContext.deadCheck('cs:childExistsFilter');
      const hasChildren = this.codeSystem.getChildren(code).length > 0;
      if (hasChildren === wantChildren) {
        const concept = this.codeSystem.getConceptByCode(code);
        if (concept) {
          results.add(concept, 0);
        }
      }
    }

    return results;
  }

  /**
   * Handle property-based filter
   * @param {FilterExecutionContext} filterContext - Filter context
   * @param {Object} propertyDef - Property definition
   * @param {string} op - Filter operator
   * @param {string} value - Filter value
   * @returns {Promise<FhirCodeSystemProviderFilterContext>} Filter results
   * @private
   */
  async _handlePropertyFilter(filterContext, propertyDef, op, value) {
    const results = new FhirCodeSystemProviderFilterContext();
    const allConcepts = this.codeSystem.getAllConcepts();

    for (const concept of allConcepts) {
      this.opContext.deadCheck('cs:propertyFilter');
      if (this._conceptMatchesPropertyFilter(concept, propertyDef, op, value)) {
        results.add(concept, 0);
      }
    }

    return results;
  }

  /**
   * Check if concept matches property filter
   * @param {Object} concept - The concept to check
   * @param {Object} propertyDef - Property definition
   * @param {string} op - Filter operator
   * @param {string} value - Filter value
   * @returns {boolean} True if concept matches filter
   * @private
   */
  _conceptMatchesPropertyFilter(concept, propertyDef, op, value) {
    // A concept without a property element simply has no values for this property:
    // it must still match not-in and exists=false.
    const allProperties = Array.isArray(concept.property) ? concept.property : [];
    const properties = allProperties.filter(p => p.code === propertyDef.code);

    if (op === 'exists') {
      // "The specified property of the code has a value (if the filter value is true)
      // or does not have a value (if false)."
      if (value === 'true') {
        return properties.length > 0;
      }
      if (value === 'false') {
        return properties.length === 0;
      }
      return false;
    }
    else if (op === '=') {
      return properties.some(p => this._getPropertyValue(p) === value);
    }
    else if (op === 'in') {
      const values = value.split(',').map(v => v.trim());
      return properties.some(p => values.includes(this._getPropertyValue(p)));
    }
    else if (op === 'not-in') {
      const values = value.split(',').map(v => v.trim());
      return !properties.some(p => values.includes(this._getPropertyValue(p)));
    }
    else if (op === 'regex') {
      try {
        const regex = regexUtilities.compile('^(?:' + value + ')$'); // the whole value: a|b is ^(?:a|b)$, not ^a|b$
        return properties.some(p => regex.test(this._getPropertyValue(p)));
      } catch (error) {
        return false;
      }
    }

    return false;
  }

  /**
   * Get property value as string
   * @param {Object} property - The property object
   * @returns {string} Property value
   * @private
   */
  _getPropertyValue(property) {
    if (property.valueCode) return property.valueCode;
    if (property.valueString) return property.valueString;
    if (property.valueInteger !== undefined) return property.valueInteger.toString();
    if (property.valueBoolean !== undefined) return property.valueBoolean.toString();
    if (property.valueDecimal !== undefined) return property.valueDecimal.toString();
    if (property.valueDateTime) return property.valueDateTime;
    if (property.valueCoding) return property.valueCoding.code || '';

    return '';
  }

  /**
   * Handle known property filters (notSelectable, status, etc.)
   * @param {FilterExecutionContext} filterContext - Filter context
   * @param {string} prop - Property name
   * @param {string} op - Filter operator
   * @param {string} value - Filter value
   * @returns {Promise<FhirCodeSystemProviderFilterContext>} Filter results
   * @private
   */
  async _handleKnownPropertyFilter(filterContext, prop, op, value) {
    const results = new FhirCodeSystemProviderFilterContext();
    const allConcepts = this.codeSystem.getAllConcepts();
    const nsCodes = this.standardPropertyCodes('notSelectable', ['abstract', 'not-selectable']);

    for (const concept of allConcepts) {
      this.opContext.deadCheck('cs:knownPropertyFilter');
      let matches = false;

      if (prop === 'notSelectable') {
        const abstractProp = (concept.property || []).find(p => nsCodes.has(p.code));
        let vv = abstractProp ? String(getValuePrimitive(abstractProp)) : null;
        if (op === '=') {
          matches = (vv === value);
        } else if (op === 'in') {
          const values = value.split(',').map(v => v.trim());
          matches = values.includes(vv);
        } else if (op === 'not-in') {
          const values = value.split(',').map(v => v.trim());
          matches = !values.includes(vv);
        }
      }
      else if (prop === 'status') {
        const status = await this.getStatus(new FhirCodeSystemProviderContext(concept.code, concept));
        if (op === '=') {
          matches = (status === value);
        } else if (op === 'in') {
          const values = value.split(',').map(v => v.trim());
          matches = values.includes(status);
        } else if (op === 'not-in') {
          const values = value.split(',').map(v => v.trim());
          matches = !values.includes(status);
        }
      }
      else if (prop === 'inactive') {
        const isInactive = await this.isInactive(new FhirCodeSystemProviderContext(concept.code, concept));
        const expectedValue = (value === 'true');
        matches = (isInactive === expectedValue);
      }
      else if (prop === 'deprecated') {
        const isDeprecated = await this.isDeprecated(new FhirCodeSystemProviderContext(concept.code, concept));
        const expectedValue = (value === 'true');
        matches = (isDeprecated === expectedValue);
      }

      if (matches) {
        results.add(concept, 0);
      }
    }

    return results;
  }

  versionAlgorithm() {
    return this.codeSystem.versionAlgorithm();
  }

  versionNeeded() {
    return this.codeSystem.jsonObj.versionNeeded ? true : false;
  }

  hasMultiHierarchy() {
    return this.codeSystem.hasMultiHierarchy;
  }

}

class FhirCodeSystemFactory extends CodeSystemFactoryProvider {
  constructor(i18n) {
    super(i18n);
  }

  defaultVersion() {
    return 'unknown'; // No default version for FHIR CodeSystems
  }

  /**
   * Build a FHIR CodeSystem provider
   * @param {CodeSystem} codeSystem - The FHIR CodeSystem to wrap
   * @param {CodeSystem[]} supplements - Array of supplement CodeSystems
   * @returns {FhirCodeSystemProvider} New provider instance
   */
  build(opContext, supplements, codeSystem) {
    this.recordUse();

    // Validate parameters
    if (!codeSystem || typeof codeSystem !== 'object') {
      throw new Error('codeSystem parameter is required and must be a CodeSystem object');
    }

    if (codeSystem.jsonObj?.resourceType !== 'CodeSystem') {
      throw new Error('codeSystem must be a FHIR CodeSystem resource');
    }

    // Validate supplements array
    if (supplements && !Array.isArray(supplements)) {
      throw new Error('supplements must be an array');
    }

    if (supplements) {
      supplements.forEach((supplement, index) => {
        if (!supplement || typeof supplement !== 'object' || supplement.jsonObj?.resourceType !== 'CodeSystem') {
          throw new Error(`Supplement ${index} must be a FHIR CodeSystem resource`);
        }
      });
    }

    return FhirCodeSystemProvider.create(opContext, codeSystem, supplements);
  }

  // eslint-disable-next-line no-unused-vars
  async buildKnownValueSet(url, version) {
    return null;
  }

  name() {
    return "CodeSystem";
  }

  id() {
    return "cs";
  }

  /**
   * This factory wraps whatever CodeSystem it is handed at build() time, so it has no
   * system or version of its own. It is never registered in codeSystemFactories (which
   * is keyed on system()); these answer for the abstract contract, not for a lookup.
   */
  system() {
    return null;
  }

  version() {
    return null;
  }

}

/**
 * Whether a code system has a text index built in memory (for the caches page)
 * @param {CodeSystem} codeSystem
 */
function hasMemoryTextIndex(codeSystem) {
  return TEXT_INDEXES.has(codeSystem);
}

/**
 * Let go of a code system's in-memory text index (it is built again when next searched)
 * @param {CodeSystem} codeSystem
 * @returns {boolean} whether it had one
 */
function dropMemoryTextIndex(codeSystem) {
  return TEXT_INDEXES.delete(codeSystem);
}

module.exports = {
  hasMemoryTextIndex,
  dropMemoryTextIndex,
  FhirCodeSystemFactory,
  FhirCodeSystemProvider,
  FhirCodeSystemProviderContext,
  FhirCodeSystemProviderFilterContext
};