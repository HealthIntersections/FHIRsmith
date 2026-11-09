const { CodeSystemProvider, FilterExecutionContext, CodeSystemFactoryProvider} = require('./cs-api');
const { Language } = require('../../library/languages');
const { CodeSystem } = require("../library/codesystem");
const assert = require('assert');
const { Issue } = require("../library/operation-outcome");

/**
 * Language component types for filtering
 */
const LanguageComponent = {
  LANG: 'language',
  EXTLANG: 'ext-lang',
  SCRIPT: 'script',
  REGION: 'region',
  VARIANT: 'variant',
  EXTENSION: 'extension',
  PRIVATE_USE: 'private-use'
};

const CODES_LanguageComponent = Object.values(LanguageComponent);

/**
 * The components an `=` filter is offered on. These are the three with a bounded list
 * of registered values behind them, which is what makes an expansion possible at all.
 */
const EQUALITY_COMPONENTS = [LanguageComponent.LANG, LanguageComponent.SCRIPT, LanguageComponent.REGION];

/**
 * Filter context for language component filters
 */
/**
 * How this code system validates a tag. Deliberately stricter than the default parse -
 * see locate().
 */
const LANG_VALIDATION_OPTIONS = Object.freeze({ caseInsensitive: true, checkCombinations: true });

/**
 * Which part of a tag a filter is about, and how a Language exposes it.
 * @param {Language} lang
 * @param {string} component
 * @returns {string} the component's value, '' when the tag does not state it
 */
function componentValue(lang, component) {
  switch (component) {
    case LanguageComponent.LANG: return lang.language || '';
    case LanguageComponent.EXTLANG: return lang.extLang.join('-');
    case LanguageComponent.SCRIPT: return lang.script || '';
    case LanguageComponent.REGION: return lang.region || '';
    case LanguageComponent.VARIANT: return lang.variant || '';
    case LanguageComponent.EXTENSION: return lang.extension || '';
    case LanguageComponent.PRIVATE_USE: return lang.privateUse.join('-');
    default: return null;
  }
}

/**
 * `<component> exists true|false` - does the tag state this part at all?
 */
class IETFLanguageCodeFilter {
  constructor(component, status) {
    this.component = component; // LanguageComponent
    this.status = status; // boolean - true if component must exist, false if must not exist
  }

  /**
   * @param {Language} lang
   * @returns {boolean|string} true/false, or a message when the component is unknown
   */
  matches(lang) {
    const value = componentValue(lang, this.component);
    if (value === null) {
      return `Unknown language component: ${this.component}`;
    }
    return (value !== '') === this.status;
  }

  /** Why a code did not match, for the caller. @returns {string} */
  describe(code) {
    const action = this.status ? 'does not contain' : 'contains';
    const requirement = this.status ? 'required' : 'not allowed';
    return `The language code ${code} ${action} a ${this.component}, and it is ${requirement}`;
  }
}

/**
 * `<component> = <value>` - the tag states this part, with this value.
 *
 * Comparison is case-insensitive, like everything else about BCP 47 tags.
 */
class IETFLanguageEqualityFilter {
  constructor(component, value) {
    this.component = component;
    this.value = value;
  }

  matches(lang) {
    const value = componentValue(lang, this.component);
    if (value === null) {
      return `Unknown language component: ${this.component}`;
    }
    return value.toLowerCase() === this.value.toLowerCase();
  }

  describe(code) {
    return `The language code ${code} does not have a ${this.component} of '${this.value}'`;
  }
}

/**
 * The enumerable combinations.
 *
 * The BCP 47 grammar is unbounded, so a filter can only be expanded where fixing part
 * of a tag leaves a finite list of registry entries to vary. Three combinations do:
 *
 *  - language fixed: every region, plus the bare language, since a tag need state no
 *    region at all
 *  - region fixed: every language with that region
 *  - language AND region fixed: every script, plus the tag with no script
 *
 * Nothing else is enumerable - a script on its own leaves the language open, and there
 * are as many tags as there are languages times everything else. Every one of these is
 * still an incomplete answer, because variants, extensions and private-use subtags can
 * always be added, so the expansion is marked unclosed.
 */
class IETFLanguageEnumerationFilter {
  /**
   * @param {string} mode - 'regions' | 'languages' | 'scripts'
   * @param {object} fixed - { language, region } as far as they are fixed
   * @param {LanguageDefinitions} definitions
   * @param {IETFLanguageEqualityFilter[]} sources - the filters this replaces
   */
  constructor(mode, fixed, definitions, sources) {
    this.mode = mode;
    this.fixed = fixed;
    this.definitions = definitions;
    this.sources = sources;
    this.cursor = 0;
    this._codes = null;
  }

  /**
   * The tags this filter covers, built once on demand.
   * @returns {string[]}
   */
  codes() {
    if (this._codes === null) {
      const d = this.definitions;
      if (this.mode === 'regions') {
        this._codes = [this.fixed.language]
          .concat([...d.regions.keys()].map(r => `${this.fixed.language}-${r}`));
      } else if (this.mode === 'languages') {
        this._codes = [...d.languages.keys()].map(l => `${l}-${this.fixed.region}`);
      } else {
        this._codes = [`${this.fixed.language}-${this.fixed.region}`]
          .concat([...d.scripts.keys()].map(sc => `${this.fixed.language}-${sc}-${this.fixed.region}`));
      }
    }
    return this._codes;
  }

  matches(lang) {
    return this.sources.every(f => f.matches(lang) === true);
  }

  /**
   * Only the rules that actually failed - saying `en-GB` has the wrong language, when
   * it is the region that differs, sends the reader looking in the wrong place.
   */
  describe(code, lang) {
    const failed = lang ? this.sources.filter(f => f.matches(lang) !== true) : this.sources;
    return (failed.length ? failed : this.sources).map(f => f.describe(code)).join('; ');
  }
}

/**
 * IETF Language CodeSystem Provider
 * Provides validation and lookup for BCP 47 language tags
 */
class IETFLanguageCodeProvider extends CodeSystemProvider {
  constructor(opContext, supplements) {
    super(opContext, supplements);
    this.languageDefinitions = opContext.i18n.languageDefinitions;
  }

  // ========== Metadata Methods ==========

  system() {
    return 'urn:ietf:bcp:47'; // BCP 47 URI
  }

  version() {
    return null; // No specific version for BCP 47. Could be date?
  }

  description() {
    return 'IETF language codes (BCP 47)';
  }

  name() {
    return 'IETF Lang (BCP 47)';
  }

  totalCount() {
    return -1; // Unbounded - grammar-based system
  }

  hasParents() {
    return false; // No hierarchy in language codes
  }

  contentMode() {
    return 'complete'
  }

  listFeatures() {
    // not sure about this?

    // // Return supported filter features
    // return CODES_LanguageComponent.map(component => ({
    //   feature: `rest.Codesystem:${this.system()}.filter`,
    //   value: `${component}:exists`
    // }));
  }

  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);
    if (this._hasAnySupplementDisplays(langs)) {
      return true;
    }
    return super.hasAnyDisplays(langs);
  }

  // ========== Subsumption ==========

  /**
   * Does one language tag subsume another?
   *
   * A tag is a set of named components - language, extended language, script, region,
   * variant - not an ordered path, so one tag subsumes another when it says a subset of
   * what the other says: `en` subsumes `en-US`, and `en-US` subsumes `en-Latn-US`,
   * because everything true of the shorter tag is true of the longer one. The language
   * itself must match; it is the one component that cannot be left unstated.
   *
   * This is RFC 4647's extended filtering rather than basic filtering. Basic filtering
   * is strictly positional, so it would not have `en-US` subsume `en-Latn-US` - the
   * script sits between the two subtags the range names. Extended filtering is the
   * reading that matches what subsumption means, and it is the one that makes the
   * relation transitive: `en` subsumes `en-US` subsumes `en-Latn-US`.
   *
   * Grandfathered tags are atomic. `i-klingon` has no components to compare - it does
   * not decompose into valid subtags at all - so it relates only to itself.
   *
   * Note that Suppress-Script is deliberately not consulted: `en` carries
   * `Suppress-Script: Latn`, which arguably makes `en-Latn` mean exactly `en`, but the
   * registry calls that redundant rather than invalid and this server takes no position
   * on it. So `en` subsumes `en-Latn` rather than being equivalent to it.
   *
   * @param {string} codeA
   * @param {string} codeB
   * @returns {Promise<string>} equivalent, subsumes, subsumed-by or not-subsumed
   */
  async subsumesTest(codeA, codeB) {
    const a = await this.#ensureContext(codeA);
    const b = await this.#ensureContext(codeB);
    if (!(a instanceof Language) || !(b instanceof Language)) {
      return 'not-subsumed';
    }

    // A grandfathered tag is matched whole, so the only tag it stands in any relation to
    // is itself (spelling aside - tags are case-insensitive).
    if (a.wholeTag || b.wholeTag) {
      return a.toString().toLowerCase() === b.toString().toLowerCase() ? 'equivalent' : 'not-subsumed';
    }

    const aCoversB = this.#covers(a, b);
    const bCoversA = this.#covers(b, a);
    if (aCoversB && bCoversA) {
      return 'equivalent';
    }
    if (aCoversB) {
      return 'subsumes';
    }
    if (bCoversA) {
      return 'subsumed-by';
    }
    return 'not-subsumed';
  }

  /**
   * Is everything `general` states also stated, identically, by `specific`?
   *
   * Comparison is case-insensitive throughout: the parts have already been canonicalised
   * by the parser, but a tag that arrived in the wrong case must still take part in
   * subsumption on equal terms.
   *
   * @param {Language} general
   * @param {Language} specific
   * @returns {boolean}
   * @private
   */
  #covers(general, specific) {
    const same = (x, y) => (x || '').toLowerCase() === (y || '').toLowerCase();
    const unstatedOrSame = (x, y) => !x || same(x, y);

    if (!same(general.language, specific.language)) {
      return false;
    }
    // Extended languages are ordered and there are at most three, so every one the
    // general tag names has to appear in the specific tag, in the same order.
    for (let i = 0; i < general.extLang.length; i++) {
      if (!same(general.extLang[i], specific.extLang[i])) {
        return false;
      }
    }
    return unstatedOrSame(general.script, specific.script)
      && unstatedOrSame(general.region, specific.region)
      && unstatedOrSame(general.variant, specific.variant)
      && unstatedOrSame(general.extension, specific.extension)
      && general.privateUse.every((p, i) => same(p, specific.privateUse[i]));
  }

  // ========== Code Information Methods ==========

  async code(code) {

    const ctxt = await this.#ensureContext(code);
    if (ctxt instanceof Language) {
      // The CANONICAL casing, not what the caller wrote. BCP 47 s2.1.1 makes tags
      // case-insensitive but recommends a casing - lower case language, Titlecase
      // script, UPPER CASE region - and toString() reassembles the tag from parts that
      // were canonicalised as they were parsed. Returning it here is what lets the
      // validator notice a difference and hand back a normalized-code, the same way it
      // does for any other case-insensitive code system.
      return ctxt.toString();
    }
    throw new Error('Invalid context type');
  }

  async display(code) {

    const ctxt = await this.#ensureContext(code);
    if (!ctxt) {
      return null;
    }
    if (!this.opContext.langs.isEnglishOrNothing()) {
      // Try translated display for the primary requested language
      const primaryLang = this.opContext.langs.getPrimary();
      if (primaryLang && primaryLang.language) {
        const langTranslation = this.languageDefinitions.getTranslatedDisplayForLang(ctxt.language, primaryLang.language);
        if (langTranslation && langTranslation !== ctxt.language) {
          if (ctxt.isLangRegion()) {
            const regionTranslation = this.languageDefinitions.getTranslatedDisplayForRegion(ctxt.region, primaryLang.language);
            if (regionTranslation && regionTranslation !== ctxt.region) {
              return `${langTranslation} (${regionTranslation})`;
            }
          }
          return langTranslation;
        }
      }
    }
    let disp = this._displayFromSupplements(ctxt.code);
    if (disp) {
      return disp;
    }
    return this.languageDefinitions.present(ctxt).trim();
  }

  async definition(code) {
    await this.#ensureContext(code);
    return null; // No definitions for language codes
  }

  async isAbstract(code) {
    await this.#ensureContext(code);
    return false; // Language codes are not abstract
  }

  async isInactive(code) {
    await this.#ensureContext(code);
    return false; // We don't track inactive language codes
  }

  async isDeprecated(code) {
    await this.#ensureContext(code);
    return false; // We don't track deprecated language codes
  }

  async designations(code, displays) {
    const ctxt = await this.#ensureContext(code);
    const designations = [];
    if (ctxt != null) {
      const primaryDisplay = this.languageDefinitions.present(ctxt).trim();
      displays.addDesignation(true, 'active', 'en', CodeSystem.makeUseForDisplay(), primaryDisplay);
      if (ctxt.isLangRegion()) {
        const langDisplay = this.languageDefinitions.getDisplayForLang(ctxt.language);
        const regionDisplay = this.languageDefinitions.getDisplayForRegion(ctxt.region);
        const regionVariant = `${langDisplay} (${regionDisplay})`;
        const regionVariant2 = `${langDisplay} (Region=${regionDisplay})`;
        const regionVariant3 = `${langDisplay}-${regionDisplay}`;
        const regionVariant4 = `${langDisplay}-${regionDisplay.toUpperCase()}`;
        displays.addDesignation(false, 'active', 'en', CodeSystem.makeUseForDisplay(), regionVariant2);
        displays.addDesignation(false, 'active', 'en', CodeSystem.makeUseForDisplay(), regionVariant3);
        displays.addDesignation(false, 'active', 'en', CodeSystem.makeUseForDisplay(), regionVariant4);
        displays.addDesignation(false, 'active', 'en', CodeSystem.makeUseForDisplay(), regionVariant);
      }
      // add alternative displays if available
      const displayCount = this.languageDefinitions.displayCount(ctxt);
      for (let i = 0; i < displayCount; i++) {
        const altDisplay = this.languageDefinitions.present(ctxt, i).trim();
        if (altDisplay && altDisplay !== primaryDisplay) {
          displays.addDesignation(false, 'active', 'en', CodeSystem.makeUseForDisplay(), altDisplay);
          // Add region variants for alternatives too
          if (ctxt.isLangRegion()) {
            const langDisplay = this.languageDefinitions.getDisplayForLang(ctxt.language, i);
            const regionDisplay = this.languageDefinitions.getDisplayForRegion(ctxt.region);
            const altRegionVariant = `${langDisplay} (${regionDisplay})`;
            displays.addDesignation(false, 'active', 'en', CodeSystem.makeUseForDisplay(), altRegionVariant);
          }
        }
      }
      // add translated designations from CSV data
      const translationLangs = ['fr', 'de', 'es', 'ar', 'zh', 'ru', 'ja', 'sw'];
      // languages that don't have upper/lower case distinction
      const caselessLangs = new Set(['ar', 'zh', 'ja']);

      for (const tLang of translationLangs) {
        const langTranslation = this.languageDefinitions.getTranslatedDisplayForLang(ctxt.language, tLang);
        if (langTranslation && langTranslation !== ctxt.language) {
          if (ctxt.isLangRegion()) {
            const regionTranslation = this.languageDefinitions.getTranslatedDisplayForRegion(ctxt.region, tLang);
            if (regionTranslation && regionTranslation !== ctxt.region) {
              const translatedDisplay = `${langTranslation} (${regionTranslation})`;
              displays.addDesignation(false, 'active', tLang, CodeSystem.makeUseForDisplay(), translatedDisplay);
              displays.addDesignation(false, 'active', tLang, CodeSystem.makeUseForDisplay(), `${langTranslation} (Region=${regionTranslation})`);
              displays.addDesignation(false, 'active', tLang, CodeSystem.makeUseForDisplay(), `${langTranslation}-${regionTranslation}`);
              if (!caselessLangs.has(tLang)) {
                displays.addDesignation(false, 'active', tLang, CodeSystem.makeUseForDisplay(), `${langTranslation}-${regionTranslation.toUpperCase()}`);
              }
            } else {
              displays.addDesignation(false, 'active', tLang, CodeSystem.makeUseForDisplay(), langTranslation);
            }
          } else {
            displays.addDesignation(false, 'active', tLang, CodeSystem.makeUseForDisplay(), langTranslation);
          }
        }
      }
      this._listSupplementDesignations(ctxt.code, displays);
    }
    return designations;
  }


  async #ensureContext(code) {
    if (code == null) {
      return code;
    }
    if (typeof code === 'string') {
      const ctxt = await this.locate(code);
      if (!ctxt.context) {
        throw new Error(ctxt.message ? ctxt.message : `Invalid language code: ${code}`);
      } else {
        return ctxt.context;
      }
    }
    if (code instanceof Language) {
      return code;
    }
    throw new Error("Unknown Type at #ensureContext: "+ (typeof code));
  }

  // ========== Lookup Methods ==========

  async locate(code) {

    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    // Validating a code as a member of urn:ietf:bcp:47 is a stricter job than working
    // out what a client asked for in an Accept-Language header, so this asks for the
    // full check. The registry's own statements about subtag combinations - the Prefix
    // on an extlang or variant - are applied, and a variant has to be registered at all.
    // Case folding is on because BCP 47 s2.1.1 says tags are case-insensitive: 'en-us'
    // is a valid way to write 'en-US', whatever the conventional casing recommends.
    //
    // These are OPTIONS rather than the default so that Accept-Language parsing keeps
    // the behaviour it was written against - see Language's constructor.
    const msg = {};
    const language = this.languageDefinitions.parse(code, msg, LANG_VALIDATION_OPTIONS);
    if (!language) {
      return { context: null, message: msg.message };
    }

    return { context: language, message: null };
  }

  // ========== Filter Methods ==========

  async doesFilter(prop, op, value) {

    assert(prop != null && typeof prop === 'string', 'prop must be a non-null string');
    assert(op != null && typeof op === 'string', 'op must be a non-null string');
    assert(value != null && typeof value === 'string', 'value must be a non-null string');

    // Support exists filters for language components
    if (op === 'exists' && (value === 'true' || value === 'false')) {
      return CODES_LanguageComponent.includes(prop);
    }
    if (op === '=') {
      return EQUALITY_COMPONENTS.includes(prop);
    }
    return false;
  }

  async filter(filterContext, forIteration, prop, op, value) {

    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(prop != null && typeof prop === 'string', 'prop must be a non-null string');
    assert(op != null && typeof op === 'string', 'op must be a non-null string');
    assert(value != null && typeof value === 'string', 'value must be a non-null string');

    if (op === '=') {
      if (!EQUALITY_COMPONENTS.includes(prop)) {
        throw new Error(`The '=' filter is only supported on ${EQUALITY_COMPONENTS.join(', ')}, not '${prop}'`);
      }
      // The value has to be a registered subtag of the right kind, or the filter selects
      // nothing and says nothing about why
      const known = { language: this.languageDefinitions.languages,
        script: this.languageDefinitions.scripts, region: this.languageDefinitions.regions }[prop];
      const canonical = [...known.keys()].find(k => k.toLowerCase() === value.toLowerCase());
      if (!canonical) {
        throw new Error(`'${value}' is not a valid ${prop} subtag, so it cannot be filtered on`);
      }
      filterContext.filters.push(new IETFLanguageEqualityFilter(prop, canonical));
      return;
    }

    if (op !== 'exists') {
      throw new Error(`Unsupported filter operator: ${op}`);
    }

    if (value !== 'true' && value !== 'false') {
      throw new Error(`Invalid exists value: ${value}, must be 'true' or 'false'`);
    }

    const componentIndex = CODES_LanguageComponent.indexOf(prop);
    if (componentIndex < 0) {
      throw new Error(`Unsupported filter property: ${prop}`);
    }

    const component = CODES_LanguageComponent[componentIndex];
    const status = value === 'true';

    filterContext.filters.push(new IETFLanguageCodeFilter(component, status));
  }

  async executeFilters(filterContext) {

    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');

    // Whether anything can be enumerated depends on the filters TOGETHER, not one at a
    // time: language alone gives regions, region alone gives languages, and the two
    // together give scripts. So the equality filters are collapsed into a single set
    // that knows which of those it is. Anything else is left alone and acts as a
    // predicate - see filterCheck.
    const equality = filterContext.filters.filter(f => f instanceof IETFLanguageEqualityFilter);
    const language = equality.find(f => f.component === LanguageComponent.LANG);
    const region = equality.find(f => f.component === LanguageComponent.REGION);
    const script = equality.find(f => f.component === LanguageComponent.SCRIPT);

    let mode = null;
    if (language && region && !script) {
      mode = 'scripts';
    } else if (language && !region && !script) {
      mode = 'regions';
    } else if (region && !language && !script) {
      mode = 'languages';
    }
    if (!mode) {
      return filterContext.filters;
    }

    const combined = new IETFLanguageEnumerationFilter(mode,
      { language: language ? language.value : null, region: region ? region.value : null },
      this.languageDefinitions, [language, region].filter(f => f));
    return [combined].concat(filterContext.filters.filter(f => f !== language && f !== region));
  }

  async filterSize(filterContext, set) {

    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');

    if (set instanceof IETFLanguageEnumerationFilter) {
      return set.codes().length;
    }
    throw new Issue('error', 'not-supported', null, 'CODESYSTEM_NOT_ENUMERABLE',
      'This filter on urn:ietf:bcp:47 cannot be expanded: the language grammar is unbounded, and only '
      + 'a fixed language (giving its regions), a fixed region (giving its languages), or both '
      + '(giving the scripts) leave a finite list to enumerate', 'not-supported', 422);
  }

  async filtersNotClosed(filterContext) {

    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    return true; // Grammar-based system is not closed
  }

  async filterMore(filterContext, set) {

    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');

    if (set instanceof IETFLanguageEnumerationFilter) {
      return set.cursor < set.codes().length;
    }
    // Throwing rather than answering false: a mistake here would otherwise surface as an
    // empty expansion, which reads as "there are none" instead of "this cannot be done".
    throw new Issue('error', 'not-supported', null, 'CODESYSTEM_NOT_ENUMERABLE',
      'This filter on urn:ietf:bcp:47 cannot be expanded', 'not-supported', 422);
  }

  async filterConcept(filterContext, set) {

    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');

    if (set instanceof IETFLanguageEnumerationFilter) {
      const code = set.codes()[set.cursor];
      set.cursor++;
      return this.languageDefinitions.parse(code, {}, LANG_VALIDATION_OPTIONS);
    }
    throw new Issue('error', 'not-supported', null, 'CODESYSTEM_NOT_ENUMERABLE',
      'This filter on urn:ietf:bcp:47 cannot be expanded', 'not-supported', 422);
  }

  async filterLocate(filterContext, set, code) {

    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && typeof set.matches === 'function', 'set must be a language filter');
    assert(typeof code === 'string', 'code must be non-null string');

    // Same rules as locate(), or a code could pass one path and fail the other
    const language = this.languageDefinitions.parse(code, {}, LANG_VALIDATION_OPTIONS);
    if (!language) {
      return `Invalid language code: ${code}`;
    }

    const result = set.matches(language);
    if (typeof result === 'string') {
      return result;   // the filter could not be evaluated at all
    }
    return result ? language : set.describe(code, language);
  }


  async filterCheck(filterContext, set, concept) {

    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && typeof set.matches === 'function', 'set must be a language filter');
    const ctxt = await this.#ensureContext(concept);

    return set.matches(ctxt);
  }


  // ========== Iterator Methods ==========
  // Cannot iterate language codes (grammar-based)

  // ========== Additional Methods ==========

  async sameConcept(a, b) {

    const codeA = await this.code(a);
    const codeB = await this.code(b);
    return codeA === codeB;
  }

  versionAlgorithm() {
    return null;
  }

  specialEnumeration() {
    // The BCP-47 language grammar is unbounded, but a useful base expansion is
    // the common languages enumerated by the THO "Languages" value set. A whole-
    // code-system expansion returns that value set marked as an incomplete
    // (unclosed) expansion, mirroring how UCUM uses its common-units value set.
    return 'http://terminology.hl7.org/ValueSet/Languages';
  }

  isNotClosed() {
    return true;
  }
}

/**
 * Factory for creating IETF Language CodeSystem providers
 */
class IETFLanguageCodeFactory extends CodeSystemFactoryProvider  {
  constructor(i18n) {
    super(i18n);
    this.uses = 0;
  }

  defaultVersion() {
    return ''; // No versioning for BCP 47
  }

  system() {
    return 'urn:ietf:bcp:47'; // BCP 47 URI
  }

  version() {
    return null; // No specific version for BCP 47. Could be date?
  }

  build(opContext, supplements) {
    this.recordUse();
    return new IETFLanguageCodeProvider(opContext, supplements);
  }

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;

  }

  name() {
    return 'IETF Lang (BCP 47)';
  }


  // eslint-disable-next-line no-unused-vars
  async buildKnownValueSet(url, version) {
    return null;
  }

  id() {
    return "languages";
  }
}

module.exports = {
  IETFLanguageCodeProvider,
  IETFLanguageCodeFactory,
  IETFLanguageCodeFilter,
  LanguageComponent
};