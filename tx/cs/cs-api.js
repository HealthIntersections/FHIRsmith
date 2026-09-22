/* eslint-disable no-unused-vars */

const assert = require('assert');
const {CodeSystem, CodeSystemContentMode} = require("../library/codesystem");
const {Languages, Language, LanguageDefinitions} = require("../../library/languages");
const { OperationContext } = require("../operation-context");
const {Extensions} = require("../library/extensions");
const {validateParameter, validateArrayParameter} = require("../../library/utilities");
const {I18nSupport} = require("../../library/i18nsupport");
const {VersionUtilities} = require("../../library/version-utilities");

/**
 * For documentation, see cs-api.md
 */
class FilterExecutionContext {
  filters = [];
  forIterate = false;

  constructor(forIterate) {
    this.forIterate = forIterate;
  }
}

class CodeSystemProvider {

  /**
   * {OperationContext} The context in which this is executing
   */
  opContext;

  /**
   * @type {CodeSystem[]}
   */
  supplements;

  constructor(opContext, supplements = null) {
    this.opContext = opContext;
    this.supplements = supplements;
    this._ensureOpContext(opContext);
    this._validateSupplements();
  }

  _ensureOpContext(opContext) {
    assert(opContext && opContext instanceof OperationContext, "opContext is not an instance of OperationContext");
  }

  /**
   * Validates that supplements are CodeSystem instances
   * @private
   */
  _validateSupplements() {
    if (!this.supplements) return;

    if (!Array.isArray(this.supplements)) {
      throw new Error('Supplements must be an array');
    }

    this.supplements.forEach((supplement, index) => {
      if (!(supplement instanceof CodeSystem)) {
        throw new Error(`Supplement ${index} must be a CodeSystem instance, got ${typeof supplement}`);
      }
    });
  }

  /**
   * @section Metadata for the code system
   */

  /**
   * The display name of the code system - what $lookup reports as its name parameter, and
   * what a person reads. Every provider should override this; the fallback is the
   * versioned uri, which is not a name, and a provider that forgets ends up reporting
   * "http://snomed.info/sct|http://snomed.info/sct/731000124108/version/20230301" where
   * the others report "LOINC".
   * @returns {string} display name for the code system
   */
  name() { return this.system() + (this.version() ? "|"+this.version() : "") }

  /**
   * @returns {string} uri for the code system
   */
  system() { throw new Error("Must override"); }

  /**
   * @returns {string} version for the code system
   */
  version() { throw new Error("Must override"); }

  vurl() {
    if (this.version()) {
      return this.system()+ "|"+ this.version();
    } else {
      return this.system();
    }
  }
  /**
   * @returns {string} default language for the code system
   */
  defLang() { return 'en' }

  /**
   * @returns {CodeSystemContentMode} content mode for the CodeSystem
   */
  contentMode() { return CodeSystemContentMode.Complete; }

  /**
   * @returns {integer} agreed limitation of expansions (see CPT). 0 means no limitation
   */
  expandLimitation() { return 0; }

  /**
   * @returns {string} description for the code system
   */
  description() { throw new Error("Must override"); }

  /**
   * @returns {string} source package for the code system, if known
   */
  sourcePackage() { return null; }

  /**
   * @returns {integer} total number of concepts in the code system
   */
  totalCount() { throw new Error("Must override"); }

  /**
   * The number of codes an "all codes" expansion of this code system would
   * contain, computed WITHOUT materialising them - used by the count=0 (count
   * only) expansion fast path. `excludeInactive` mirrors the expansion's
   * active-only handling. Defaults to totalCount(); providers that distinguish
   * active from inactive override this to honour excludeInactive.
   * @param {boolean} excludeInactive
   * @returns {integer}
   */
  async countAllCodes(excludeInactive) {  // eslint-disable-line no-unused-vars
    return await this.totalCount();
  }

  /**
   * @returns {CodeSystem.property[]} defined properties for the code system
   */
  propertyDefinitions() { return null; }

  /**
   * returns true if the code system cannot be completely enumerated - e.g. it has a grammar
   * @returns {boolean}
   */
  isNotClosed() {
    return false;
  }

  /**
   * returns false if the code system cannot be iterated / enumerated in any
   * meaningful sense - as distinct from isNotClosed(), which marks a code system
   * that has a grammar whose base set may still be partially expanded. An
   * expansion that would need to iterate a system for which this is false
   * returns an OperationOutcome rather than attempting the iteration.
   * @returns {boolean}
   */
  canBeExpanded() {
    return true;
  }

  /**
   * returns true if the code system is case sensitive when comparing codes.
   * this is true by default
   *
   * @returns {boolean}
   */
  isCaseSensitive() {
    return true;
  }

  /**
   * @param {Languages} languages language specification
   * @returns {boolean} defined properties for the code system
   */
  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);
    return langs.isEnglishOrNothing();
  }

  resourceLanguageMatches(resource, languages, ifNoLang = false) {
    if (resource.language) {
      const resourceLang = new Language(resource.language);
      for (const requestedLang of languages) {
        if (resourceLang.matchesForDisplay(requestedLang)) {
          return true;
        }
      }
    } else {
      return ifNoLang;
    }
  }

  _hasAnySupplementDisplays(languages) {
    // Check if any supplements have displays in the requested languages
    if (this.supplements) {
      // displays have preference
      for (const supplement of this.supplements) {
        // Check if supplement language matches and has displays
        if (this.resourceLanguageMatches(supplement.jsonObj, languages, false)) {
          // Check if any concept has a display
          const allConcepts = supplement.getAllConcepts();
          if (allConcepts.some(c => c.display)) {
            return true;
          }
        }
      }
      // Check concept designations for display uses
      for (const supplement of this.supplements) {
        const allConcepts = supplement.getAllConcepts();
        for (const concept of allConcepts) {
          if (concept.designation) {
            for (const designation of concept.designation) {
              if (CodeSystem.isUseADisplay(designation.use)) {
                if (designation.language) {
                  const designationLang = new Language(designation.language);
                  for (const requestedLang of languages) {
                    if (designationLang.matchesForDisplay(requestedLang)) {
                      return true;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    return false; // nothing in the supplements
  }

  /**
   * @returns {boolean} true if there's a heirarchy
   */
  hasParents() { return false; }

  /**
   * @returns {string} true if the code system nominates an enumeration to use in place of iterating (UCUM)
   */
  specialEnumeration() { return null; }

  /**
   * @param {string} url the supplement of interest
   * @returns {boolean} true if the nominated supplement is in scope
   */
  hasSupplement(url) {
    if (!this.supplements) return false;
    return this.supplements.some(supp => supp.url === url || supp.vurl === url);
  }

  /**
   * @param {boolean} langPacks - whether to include language packs
   * @returns {string[]} all supplements in scope
   */
  listSupplements(langPacks) {
    return this.supplements ? this.supplements.filter(s => langPacks || !s.isLangPack()).map(s => s.vurl) : [];
  }

  /**
   * @returns {Feature[]} applicable Features
   */
  listFeatures() { return null; }

  /**
   * @param {string} checkVersion - first version
   * @param {string} actualVersion - second version
   * @returns {boolean} True if actualVersion is more detailed than checkVersion (for SCT)
   */
  versionIsMoreDetailed(checkVersion, actualVersion) {
     return false;
  }

  /**
   * @returns { {status, standardsStatus : String, experimental : boolean} } applicable Features
   */
  status() { return {}; }

  /**
   * @section Getting Information about the concepts in the CodeSystem
   */

  /**
   * @param {String | CodeSystemProviderContext} code
   * @returns {string} the correct code for the concept specified
   */
  async code(code) {throw new Error("Must override"); }

  /**
   * @param {String | CodeSystemProviderContext} code
   * @returns {string} the best display given the languages in the operation context
   */
  async display(code) {
    throw new Error("Must override");
  }

  /**
   * Protected!
   *
   
   * @param {String} code
   * @returns {string} the best display given the languages in the operation context
   */
  _displayFromSupplements(code) {
    assert(typeof code === 'string', 'code must be string');
    if (this.supplements) {
      const concepts = [];
      // displays have preference
      for (const supplement of this.supplements) {
        // Check if supplement language matches and has displays
        if (this.resourceLanguageMatches(supplement.jsonObj, this.opContext.langs, false)) {
          // Check if any concept has a display
          const concept= supplement.getConceptByCode(code);
          if (concept) {
            if (concept.display) {
              return concept.display;
            }
            concepts.push(concept);
          }
        }
      }
      // Check concept designations for display uses
      for (const concept in concepts) {
        if (concept.designation) {
          for (const designation of concept.designation) {
            if (CodeSystem.isUseADisplay(designation.use) && this.opContext.langs.hasMatch(designation.language)) {
              return designation.value;
            }
          }
        }
      }
      // still here? try again, for any non-language display
      for (const supplement of this.supplements) {
        if (!supplement.jsonObj.language) {
          const concept= supplement.getConceptByCode(code);
          if (concept && concept.display) {
            return concept.display;
          }
        }
      }
    }
    return null; // nothing in the supplements
  }

  /**
   
   * @param {string | CodeSystemProviderContext} code
   * @returns {string} the definition for the concept (if available)
   */
  async definition(code) {throw new Error("Must override"); }

  /**
   
   * @param {string | CodeSystemProviderContext} code
   * @returns {boolean} if the concept is abstract
   */
  async isAbstract(code) { return false; }

  /**
   
   * @param {string | CodeSystemProviderContext} code
   * @returns {boolean} if the concept is inactive
   */
  async isInactive(code) { return false; }

  /**
   
   * @param {string | CodeSystemProviderContext} code
   * @returns {boolean} if the concept is inactive
   */
  async isDeprecated(code) { return false; }

  /**
   
   * @param {string | CodeSystemProviderContext} code
   * @returns {string} status
   */
  async getStatus(code) { return null; }

  /**
   
   * @param {string | CodeSystemProviderContext} code
   * @returns {string} assigned itemWeight - if there is one
   */
  async itemWeight(code) { return null; }

  /**
   
   * @param {string | CodeSystemProviderContext} code
   * @returns {string} parent, if there is one
   */
  async parent(code) { return null; }

  /**
   * This is calleed if the designation is not marked with a usual use code indicating that it is considered as a display
   * @param designation
   * @returns {boolean}
   */
  isDisplay(designation) {
    return false;
  }

  /**
   * List the designations for a concept, adding them to `displays`.
   *
   * @param {string | CodeSystemProviderContext} code
   * @param {ConceptDesignations} displays - designation list to add to
   * @param {boolean} [significantOnly=false] - when true, emit only the
   *   designations that are significant for a value set expansion (the display,
   *   and - for code systems that distinguish them - the fully specified name
   *   and the preferred term), rather than every designation. This narrows which
   *   designations are emitted, NOT which languages: the display for a request is
   *   chosen downstream by preferredDesignation(displayLanguage), so a provider
   *   that emits significant designations for one language only makes localized
   *   expansions fall back to that language. Emit the significant designations
   *   for every language the concept has.
   *   The $expand worker passes true when the client did not ask for
   *   designations; $lookup and includeDesignations=true use the default (false)
   *   to return the complete set. Providers that do not distinguish significant
   *   designations may ignore this parameter and return all designations either
   *   way.
   * @returns {Designation[]} whatever designations exist (in all languages)
   */
  async designations(code, displays, significantOnly = false) { return null; }

  _listSupplementDesignations(code, displays) {
    assert(typeof code === 'string', 'code must be string');

    if (this.supplements) {
      for (const supplement of this.supplements) {
        const concept= supplement.getConceptByCode(code);
        if (concept) {
          if (concept.display) {
            // sometimes the display is just repeated from the base code system
            if (!displays.hasAnyDisplay(concept.display)) {
              displays.addDesignation(true, 'active', supplement.jsonObj.language, CodeSystem.makeUseForDisplay(), concept.display).supplement = supplement;
            }
          }
          if (concept.designation) {
            for (const d of concept.designation) {
              let status = Extensions.readString(d, "http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status");
              displays.addDesignation(false, status || 'active', d.language, d.use, d.value, d.extension?.length > 0 ? d.extension : []).supplement = supplement;
            }
          }
        }
      }
    }
  }

  /**
   
   * @param {string | CodeSystemProviderContext} code
   * @returns {Extension[]} extensions, if any
   */
  async extensions(code) { return null; }

  /**
   
   * @param {string | CodeSystemProviderContext} code
   * @returns {CodeSystem.concept.property[]} list of properties (may be empty)
   */
  async properties(code) { return []; }

  /**
   
   * @param {string | CodeSystemProviderContext} code
   * @returns {string} information about incomplete validation on the concept, if there is any information (SCT)
   */
  async incompleteValidationMessage(code) { return null; }

  /**
   
   * @param {string | CodeSystemProviderContext} a
   * @param {string | CodeSystemProviderContext} b
   * @returns {boolean} true if they're the same
   */
  async sameConcept(a, b) { return false; }

  /**
   * @section Finding concepts in the CodeSystem
   */

  /**
   
   * @param {string } code
   * @returns {{context : CodeSystemProviderContext, message : String} the result of looking for the code
   */
  async locate(code) { throw new Error("Must override"); }

  /**
   
   * @param {string} code
   * @param {string} parent
   * @param {boolean} disallowParent
   * @returns {{context : CodeSystemProviderContext, message : String} the result of looking for the code in the context of the parent
   */
  async locateIsA(code) {
    if (this.hasParents()) throw new Error("Must override"); else return { context : null, message: "The CodeSystem "+this.name()+" does not have parents"}
  }

  /**
   iterate all the root concepts
   * @param {string | CodeSystemProviderContext} code
   * @returns {CodeSystemIterator} a handle that can be passed to nextConcept (or null, if it can't be iterated)
   */
  async iterator(code) { return null }

  /**
   iterate all the concepts
   * @param {string | CodeSystemProviderContext} code
   * @returns {CodeSystemIterator} a handle that can be passed to nextConcept (or null, if it can't be iterated)
   */
  async iteratorAll() {
    if (this.hasParents()) throw new Error("Must override"); else return await this.iterator(null);
  }

  /**
   
   * @param {CodeSystemIterator} context
   * @returns {CodeSystemProviderContext} the next concept, or null
   */
  async nextContext(context) { return null; }

  /**
   
   * @param {string | CodeSystemProviderContext} codeA
   * @param {string | CodeSystemProviderContext} codeB
   * @returns {string} one of: equivalent, subsumes, subsumed-by, and not-subsumed
   */
  async subsumesTest(codeA, codeB) { return 'not-subsumed'; }

  /**
   
   * @param {CodeSystemProviderContext} ctxt the context to add properties for
   * @param {string[]} props the properties requested
   * @param {Parameters} params the parameters response to add to
   */

  async extendLookup(ctxt, props, params) { }

  // procedure getCDSInfo(card : TCDSHookCard; langList : THTTPLanguageList; baseURL, code, display : String); virtual;

  /**
   * There are two models for handling concepts and filters. The first is where the logic is entirely
   * handled by worker classes; this is needed for value sets that select codes across systems, and
   * with references to other value sets. This workflow consists of calling GetPrepContext, followed
   * by some combination of filter+searchFilter, and then executeFilters
   *
   * followed by filterMore/filterConcept. All code system providers have to support this workflow
   *
   * But an important subset of value sets simply select codes from one codeSystem, from large
   * code systems. Such processing can be done much more efficiently by the code system provider.
   * providers that do this should return handlesSelecting() = true, and then for suitable valuesets,
   * the method processSelection() will be called
   */
  handlesSelecting() {
    return false;
  }

  /**
   * Process a set of includes and excludes for the code system
   *
   * @param {TxParameters} params: information from the request that the user made, to help optimise loading
   * @param {Object[]} includes - a list of includes from the code system. Each include may contain just the system(+version), concepts and/or filters (but won't contain value sets)
   * @param {Object[]} excludes - a list of excludes from the code system. Each include may contain just the system(+version), concepts and/or filters (but won't contain value sets)
   * @param {boolean} excludeInactive: whether the server will use inactive codes or not
   * @param {int} offset if handlesOffset() and !iterate, and if the value set is a simple one that only uses this provider, then this is the applicable offset. -1 if not applicable
   * @param {int} count if handlesOffset() and !iterate, and if the value set is a simple one that only uses this provider, then this is the applicable count. -1 if not applicable
   * @returns {FilterConceptSet[]} filter sets. In general, it wouldn't make sense to return more than one, but providers can do if they want to. See futher comments on executeFilters
   */
  processSelection(params, includes, excludes, excludeInactive, offset, count) {
    // well, you only need to override if handlesSelecting=true, but that's the only time this will be called
    throw new Error("Must override");
  }

  /**
   * returns true if a filter is supported
   *
   * @param {String} prop
   * @param {ValueSetFilterOperator} op
   * @param {String} prop
   * @returns {boolean} true if suppoted
   * */
  async doesFilter(prop, op, value) { return false; }

  /**
   * gets a single context in which filters will be evaluated. The server doesn't doesn't make use of this context;
   * it's only use is to be passed back to the CodeSystem provider so it can make use of it to organise the filter process
   *
   * @param {boolean} iterate true if the conceptSets that result from this will be iterated, and false if they'll be used to locate a single code
   * @returns {FilterExecutionContext} filter
   *
   **/
  async getPrepContext(iterate) { return new FilterExecutionContext(iterate); }


  /**
   * executes a text search filter (whatever that means) and returns a FilterConceptSet
   *
   * throws an exception if the search filter can't be handled
   *
   * @param {FilterExecutionContext} filterContext filtering context
   * @param {String} filter user entered text search
   * @param {boolean} sort ?
   **/
  async searchFilter(filterContext, filter, sort) { throw new Error("Text Search is not supported"); } // ? must override?

  /**
   * Used for searching ucum (see specialEnumeration)
   *
   * throws an exception if the search filter can't be handled
   * @param {FilterExecutionContext} filterContext filtering context
   * @param {boolean} sort ?
   **/
  async specialFilter(filterContext, sort) {
    if (this.specialEnumeration()) {
      throw new Error("Must override");
    }
  } // ? must override?

  /**
   * inform the CS provider about a filter
   *
   * throws an exception if the search filter can't be handled
   *
   * @param {FilterExecutionContext} filterContext filtering context
   * @param {boolean} forIteration - whether this filter is going to be iterated
   * @param {String} prop
   * @param {ValueSetFilterOperator} op
   * @param {String} value
   * @param {Object} [fc] the ValueSet compose filter element
   *   (ValueSet.compose.include.filter) this filter was derived from. It is a stable
   *   sub-object of the (cached) ValueSet resource, so a provider MAY use it as a place
   *   to memoise the resolved analysis of this filter (e.g. the enumerated concept set),
   *   which is then reused on subsequent expand/validate calls for as long as the
   *   ValueSet stays cached - trading memory for the cost of re-preparing the filter.
   *
   *   Two rules govern any such cache:
   *   - It MUST be pinned to the resolved code system VERSION. The same ValueSet can be
   *     resolved against different versions/editions, and a resolved filter (a set of
   *     version-specific concept references) is only valid for the version it was
   *     computed against.
   *   - It must NOT be pinned to forIteration. The same ValueSet is used both ways
   *     (iterated for $expand, non-iterated for validate), so if the iterated and
   *     non-iterated resolved forms differ, store BOTH rather than assuming one.
   *
   *   Providers that gain nothing from this (the SQL-backed providers, and the trivial
   *   in-memory enumerations) simply ignore fc.
   **/
  async filter(filterContext, forIteration, prop, op, value, fc) { throw new Error("Must override"); } // well, only if any filters are actually supported

  /**
   * called once all the filters have been handled, and iteration is about to happen.
   * this function returns one more filters. If there were multiple filters, but only
   * one FilterConceptSet, then the code system provider has done the join across the
   * filters, otherwise the engine will do so as required
   *
   * The first in the set of returned FilterConceptSet is used for iterating; other
   * FilterConceptSets are used for filterCheck();
   *
   * @param {FilterExecutionContext} filterContext filtering context
   * @returns {FilterConceptSet[]} filter sets
   **/
  async executeFilters(filterContext) { throw new Error("Must override"); } // well, only if any filters are actually supported

  /**
   * return how many concepts are in the filter set
   @param {FilterExecutionContext} filterContext filtering context
   @param {FilterConceptSet} set of interest
   @returns {int} number of concepts in the set
   */
  async filterSize(filterContext, set) {throw new Error("Must override"); }

  /**
   * return true if there's an infinite number of members (or at least, beyond knowing)
   *
   * This is true if the code system defines a grammar
   *
   @param {FilterExecutionContext} filterContext filtering context
   @returns {boolean} true if not closed
   */
  async filtersNotClosed(filterContext) { return false; }

  /**
   * iterate the filter set. Iteration is forwards only, using the style
   * while (filterMore()) { something(filterConcept()};
   *
   @param {FilterExecutionContext} filterContext filtering context
   @param {FilterConceptSet} set of interest
   @returns {boolean} if there is a concept
   */
  async filterMore(filterContext, set) {throw new Error("Must override"); }

  /**
   * get the current concept
   *
   @param {FilterExecutionContext} filterContext filtering context
   @param {FilterConceptSet} set of interest
   @returns {CodeSystemProviderContext} if there is a concept
   */
  async filterConcept(filterContext, set) {throw new Error("Must override"); }

  /**
   * filterLocate - instead of iterating, find a code in the FilterConceptSet
   *
   @param {FilterExecutionContext} filterContext filtering context
   @param {FilterConceptSet} set of interest
   @param {string} code the code to find
   @returns {string | CodeSystemProviderContext} an error explaining why it isn't in the set, or a handle to the concept
   */
   async filterLocate(filterContext, set, code) {throw new Error("Must override"); }

   /**
   * filterLocate - instead of iterating, find a code in the FilterConceptSet
   *
   @param {FilterExecutionContext} filterContext filtering context
   @param {FilterConceptSet} set of interest
   @param {CodeSystemProviderContext} concept the code to find
   @returns {string | boolean } an error explaining why it isn't in the set, or true if it is
   */
   async filterCheck(filterContext, set, concept) {throw new Error("Must override"); }

  /**
   * filterFinish - opportunity for the provider to close up and recover resources etc
   *
   @param {FilterExecutionContext} filterContext filtering context
   */
  async filterFinish(filterContext) {

  }

  /**
   * register the concept maps that are implicitly defined as part of the code system
   *
   * @param {ConceptMap[]} conceptMaps
   *
   */
  registerConceptMaps(list) {}


  /**
   * register the concept maps that are implicitly defined as part of the code system
   *
   * @param {ConceptMap} map the map (this will have been returned from findImplicitConceptMap)
   * @param {Coding} coding the coding to translate
   * @param {String} target the target code system
   * @param {boolean} reverse - if the translation is being run backwards
   * @returns {CodeTranslation[]} the list of translations, each CodeTranslation has map, code, system, version, display, and relationship
   */
  async getTranslations(map, coding, target, reverse) { return null;}

  // ==== Parameter checking methods =========
  _ensureLanguages(param) {
    assert(
      typeof param === 'string' ||
      param instanceof Languages ||
      (Array.isArray(param) && param.every(item => typeof item === 'string')),
      'Parameter must be string, Languages object, or array of strings'
    );

    if (typeof param === 'string') {
      return Languages.fromAcceptLanguage(param, this.languageDefinitions, false);
    } else if (Array.isArray(param)) {
      const languages = new Languages();
      for (const str of param) {
        const lang = new Language(str);
        languages.add(lang);
      }
      return languages;
    } else {
      return param; // Already a Languages object
    }
  }

  /**
   * @returns {String} the version algorithm for this version of the code system
   */
  versionAlgorithm() {
    return null;
  }

  versionNeeded() {
    return false;
  }

  hasMultiHierarchy() {
    return false;
  }
  /**
   *
   * @returns {string} valueset for the code system
   */
  valueSet() {
    return null;
  }

  /**
   * a record of observed usages of codes from this code system
   * - a map of code and object which has count, an integer count
   * of frequency of use (this server iteration, for now)
   *
   * Only populated when expanding, and read-only to the CS Provider
   *
   * @type {Map<String, Object>}
   */
  usages() {
    if (this.usagesObj == undefined) {
      this.usagesObj = this.opContext.usageTracker ? this.opContext.usageTracker.usages(this.system()) : null;
    }
    return this.usagesObj;
  }
  usagesObj = undefined;
}

class CodeSystemFactoryProvider {
  uses = 0;

  /**
   * {I18nSupport}
   */
  i18n;

  constructor(i18n) {
    validateParameter(i18n, "i18n", I18nSupport);

    this.i18n = i18n;
  }


  /**
   * @returns {String} the latest version, if known
   */
  defaultVersion() { throw new Error("Must override"); }

  async load() {
    // nothing here
  }

  /**
   
   * @param {CodeSystem[]} supplements any supplements that are in scope
   * @returns {CodeSystemProvider} a built provider - or an exception
   */
  build(opContext, supplements) { throw new Error("Must override Factory"); }

  /**
   * @returns {string} uri for the code system
   */
  system() {
    throw new Error("Must override");
  }

  /**
   * @returns {string} name for the code system
   */
  name() {
    throw new Error("Must override");
  }

  /**
   * @returns {string} name for the code system, without version information
   */
  nameBase() {
    return this.name();
  }

  /**
   * @returns {string} version for the code system
   */
  version() { throw new Error("Must override"); }

  content() {
    return "complete";
  }

  getPartialVersion() {
    let ver = this.version();
    if (ver && VersionUtilities.isSemVer(ver)) {
      return VersionUtilities.getMajMin(ver);
    }
    return ver;
  }

  /**
   * the version parameter might not be the same as version() once
   * all matching rules are done
   * @param version
   */
  describeVersion(version) {
    return "v"+version;
  }

/**
   * @returns {number} how many times the factory has been asked to construct a provider
   */
  useCount() {return this.uses}

  recordUse() {
    this.uses++;
  }

  /**
   * build and return a known value set from the URL, if there is one.
   *
   * @param url
   * @param version
   * @returns {ValueSet}
   */
  async buildKnownValueSet(url, version) {
    return null;
  }

  /**
   * If the data available to the provider includes the definition of some supplements,
   * then the provider has to declare them to the server by overriding this method. The
   * method returns a list of CodeSystem resources, with jsonObj provided. The jsonObj
   * in this case must include the correct metadata, with content = supplement, but need
   * not include any actual content (which might be anticipated to be large). If the
   * server sees a CodeSystem supplement with no content that comes from a provider
   * then the server will use fillOutSupplement to ask for the details to be populated
   * if a client has done something that means the server needs it (mostly, it doesn't)
   *
   * @returns {CodeSystem[]}
   */
  async registerSupplements() {
    return [];
  }

  /**
   *
   * @param supplements - the list of supplements to populate - fill with any supplements matching url(+version)
   * @param url - url of code system
   * @param version - version of codesystem
   * @param {Map} statedSupplements - return language packs and supplements that are listed in stated supplements, by versioned URL
   * @returns {Promise<void>}
   */
  async listSupplements(supplements, url, version, statedSupplements) {
    // do nothing
  }
  /**
   * see comments for registerSupplements()
   *
   * @param {CodeSystem} supplement - the supplement to flesh out
   * @returns void
   */
  async fillOutSupplement(supplement) {
    // nothing
  }

  /**
   * build and return a known concept map from the URL, if there is one.
   *
   * the conceptmap is never visible to a user; if it has an implicitSource, then
   * provider.getTranslations will be called when it's actually used
   * @param url
   * @param version
   * @returns {ConceptMap}
   */
  async findImplicitConceptMaps(conceptMaps, source, dest) {
    return null;
  }

  /**
   * build and return a known concept map from the URL, if there is one.
   *
   * @param url
   * @param version
   * @returns {ConceptMap}
   */
  async findImplicitConceptMap(url, version) {
    return null;
  }

  id() {
    throw new Error("Must override");
  }

  codeLink(code) {
    return undefined;
  }

  iteratable() {
    return false;
  }

  // nothing here - might be overriden
  async close() {

  }

  /**
   * if known, the right place to point to on the web for the code system
   * @returns {String}
   */
  webSource() {
    return undefined;
  }
}

/**
 * The error a code system provider raises when it cannot work out the subsumption
 * relationship between two codes.
 *
 * $subsumes has four outcome codes - equivalent, subsumes, subsumed-by, not-subsumed -
 * and none of them means "unknown", so a server that cannot decide has no honest answer
 * to give and must report an error instead. Answering `not-subsumed` would assert
 * something the server has not established, in the direction that wrongly drops a code
 * out of a cohort. See FHIR-58748.
 *
 * This is a real condition in more than one code system: SNOMED CT expressions that no
 * classifier has seen, and media types whose difference lies in a parameter the server
 * does not understand.
 *
 * 422 rather than 400 because the request is well formed and both codes are valid - the
 * server simply cannot answer it.
 *
 * @param {string} message - what could not be determined, and why
 * @returns {Error} tagged with statusCode, issueCode and txIssueType
 */
function cannotDetermineSubsumption(message) {
  const error = new Error(message);
  error.statusCode = 422;
  error.issueCode = 'not-supported';
  error.txIssueType = 'cannot-determine';
  return error;
}

module.exports = {
  FilterExecutionContext,
  CodeSystemProvider,
  CodeSystemContentMode,
  CodeSystemFactoryProvider,
  cannotDetermineSubsumption
};