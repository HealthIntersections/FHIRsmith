const { LanguagePartType, Languages, Language, LanguageDefinitions} = require('../../library/languages');
const {validateParameter, validateOptionalParameter, validateArrayParameter} = require("../../library/utilities");
const natural = require('natural');
/**
 * Display checking modes for concept designations
 */
const DisplayCheckingStyle = {
  EXACT: 'exact',
  CASE_INSENSITIVE: 'caseInsensitive',
  NORMALISED: 'normalised'
};

const allowedDesignationExtensions = [
  'http://hl7.org/fhir/StructureDefinition/coding-sctdescid',
  'http://hl7.org/fhir/StructureDefinition/rendering-style',
  'http://hl7.org/fhir/StructureDefinition/rendering-xhtml',
  'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status',
  'http://hl7.org/fhir/StructureDefinition/codesystem-alternate'
];
/**
 * Text search filter with stemming support
 */
class SearchFilterText {
  constructor(filter) {
    validateOptionalParameter(filter, 'filter', String);

    this.filter = filter ? filter.toLowerCase() : null;
    this.stems = [];
    // The words the stems came from, index-aligned with stems. A provider whose text
    // index cannot hold a particular token (RxNorm's stem table has nothing that starts
    // with a digit, for one) needs the word itself to search the text with instead.
    this.words = [];
    this.stemmer = natural.PorterStemmer;
    if (filter) {
      this._process();
    }
  }

  /**
   * Check if filter is empty
   */
  get isNull() {
    return this.stems.length === 0;
  }

  /**
   * Check if a value passes the filter
   */
  passes(value, returnRating = false) {
    validateParameter(value, 'value', String);
    validateOptionalParameter(returnRating, 'returnRating', Boolean);

    if (this.isNull) {
      return returnRating ? {passes: true, rating: 0} : true;
    }

    let rating = 0;
    let i = 0;

    while (i < value.length) {
      if (this._isAlphaNumeric(value[i])) {
        const j = i;
        while (i < value.length && this._isAlphaNumeric(value[i])) {
          i++;
        }
        const word = value.substring(j, i).toLowerCase();
        const stemmed = this.stemmer.stem(word);

        if (this._find(stemmed)) {
          if (returnRating) {
            rating += value.length / this.stems.length;
            return {passes: true, rating};
          } else {
            return true;
          }
        }
      } else {
        i++;
      }
    }

    return returnRating ? {passes: false, rating: 0} : false;
  }

  /**
   * Check if designations pass the filter
   */
  passesDesignations(cds) {
    validateOptionalParameter(cds, 'cds', Designations);

    if (this.isNull) {
      return true;
    }

    if (!cds) return false;

    for (const cd of cds.designations) {
      if (cd.value && this.passes(cd.value)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Calculate match score against stems
   */
  matches(stems) {
    validateOptionalParameter(stems, 'stems', Array);

    if (this.stems.length === 0) return 100;
    if (!stems || stems.length === 0) return 0;

    let result = 0;

    for (const stem of stems) {
      let incomplete = false;
      let complete = false;

      for (const filterStem of this.stems) {
        if (filterStem === stem) {
          complete = true;
        } else if (stem.startsWith(filterStem)) {
          incomplete = true;
        }
      }

      if (complete) {
        result += stem.length / this.stems.length;
      } else if (incomplete) {
        result += (stem.length / this.stems.length) / 2;
      }
    }

    return result;
  }

  // Private methods

  _process() {
    let i = 0;
    const found = [];

    while (i < this.filter.length) {
      if (this._isAlphaNumeric(this.filter[i])) {
        const j = i;
        while (i < this.filter.length && this._isAlphaNumeric(this.filter[i])) {
          i++;
        }
        const word = this.filter.substring(j, i).toLowerCase();
        found.push({ word: word, stem: this.stemmer.stem(word) });
      } else {
        i++;
      }
    }

    // Sorted by stem, because _find() binary searches stems - words ride along so that
    // words[n] is always the word stems[n] came from.
    found.sort((a, b) => (a.stem < b.stem ? -1 : (a.stem > b.stem ? 1 : 0)));
    this.stems = found.map((f) => f.stem);
    this.words = found.map((f) => f.word);
  }

  _isAlphaNumeric(char) {
    return /[0-9a-zA-Z]/.test(char);
  }

  _find(stem) {
    // Binary search
    let left = 0;
    let right = this.stems.length - 1;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const midStem = this.stems[mid];

      if (stem.startsWith(midStem)) {
        return true;
      } else if (stem < midStem) {
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }

    return false;
  }
}

/**
 * Language matching types
 */
const LangMatchType = {
    LITERAL: 'literal',
    FULL: 'full',
    LANG_REGION: 'langRegion',
    LANG: 'lang'
  };

/**
 * Display comparison sensitivity modes
 */
const DisplayCompareSensitivity = {
  CaseSensitive: 'case-sensitive',
  CaseInsensitive: 'case-insensitive',
  Normalized: 'normalized'  // Ignore whitespace differences
};

/**
 * Display difference results
 */
const DisplayDifference = {
  Exact: 'exact',
  Case: 'case',
  Normalized: 'normalized',
  None: 'none'
};


/**
 * Standard use codes for designations
 */
const DesignationUse = {
  DISPLAY: {
    system: 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra', // http://terminology.hl7.org/CodeSystem/designation-use',
    code: 'preferredForLanguage', // 'display'
    display: 'Preferred For Language'
  },
  FSN: {
    system: 'http://snomed.info/sct',
    code: '900000000000003001'  // Fully Specified Name
  },
  PREFERRED: {
    system: 'http://snomed.info/sct',
    code: '900000000000548007'  // Preferred term
  },
  SYNONYM: {
    system: 'http://snomed.info/sct',
    code: '900000000000013009'  // Synonym
  }
};

/**
 * Individual concept designation with language, use, and value
 */
class Designation {
  status;
  language;
  use; // Coding {system, version, code, display} - well be DesignationUse.DISPLAY if is display
  value; // string
  extensions = []; // extensions on the designation

  constructor() {
    this.status = null;
    this.language = null;
    this.use = null;
    this.value = null;
    this.extensions = [];
  }

  /**
   * Get the display text for this designation
   */
  get display() {
    return this.value ? this.value || '' : '';
  }

  /**
   * Get a string representation of this designation
   */
  present() {
    let result = this.value ? `"${this.value || ''}"` : '""';

    if (this.language || this.use) {
      result += ' (';
      if (this.language) {
        result += this.language.code;
      }
      if (this.use) {
        result += '/' + this._renderCoding(this.use);
      }
      result += ')';
    }

    return result;
  }

  /**
   * Render a coding object as text
   */
  _renderCoding(coding) {
    if (!coding) return '--';
    if (coding.display) return coding.display;
    if (coding.code) return coding.code;
    return coding.system || '--';
  }

  isPreferred() {
    return this.use && this.use.system == DesignationUse.PREFERRED.system &&
      this.use.code == DesignationUse.PREFERRED.code;
  }

  isActive() {
    let inactive = ["withdrawn", "inactive"].includes(this.status);
    return !inactive;
  }

  asObject() {
    let obj = {}
    if (this.language) {
      obj.language = this.language.code;
    }
    if (this.use) {
      obj.use = this.use;
    }
    if (this.value) {
      obj.value = this.value;
    }
    for (let ext of this.extensions || []) {
      if (allowedDesignationExtensions.includes(ext.url)) {
        if (!obj.extension) {
          obj.extension = [];
        }
        obj.extension.push(ext);
      }
    }
    return obj;
  }
}

/**
 * Collection of concept designations with language matching and preference logic
 */
class Designations {
  constructor(languageDefinitions) {
    validateParameter(languageDefinitions, "languageDefinitions", LanguageDefinitions);
    this.languageDefinitions = languageDefinitions;
    this.baseLang = null;
    this.designations = [];
    this.source = null; // Reference to CodeSystemProvider
  }

  /**
   * Clear all designations and reset base language
   */
  clear() {
    this.baseLang = null;
    this.designations = [];
    this.source = null; // Reference to CodeSystemProvider
  }

  /**
   * Add a designation with string parameters
   */
  addDesignation(isDisplay, status, lang, use, display, extensions = []) {
    validateParameter(status, "status", String);
    validateParameter(isDisplay, "isDisplay", Boolean);
    validateOptionalParameter(lang, "lang", String);
    validateOptionalParameter(use, "use", Object);
    validateParameter(display, "display", String);
    validateArrayParameter(extensions, "extensions", Object);

    const designation = new Designation();
    designation.language = this.languageDefinitions.parse(lang);
    designation.value = display;
    designation.status = status;

    if (isDisplay) {
      designation.use = { ...DesignationUse.DISPLAY };
    } else if (use) {
      designation.use = use;
    }
    if (extensions.length > 0) {
      designation.extensions.push(...extensions)
    }
    this.designations.push(designation);
    return designation;
  }

  /**
   * Add designations from an array of displays
   */
  addDesignationsFromArray(status, isDisplay, lang, use, displays) {
    validateParameter(status, "status", String);
    validateParameter(isDisplay, "isDisplay", Boolean);
    validateParameter(lang, "lang", String);
    validateArrayParameter(displays, "displays", String, false);

    if (displays) {
      for (const display of displays) {
        this.addDesignation(isDisplay, status, lang, use, display);
      }
    }
  }

  /**
   * Add designation from FHIR CodeSystem concept designation
   */
  addDesignationFromConcept(concept) {
    validateOptionalParameter(concept, 'concept', Object);
    if (!concept) return;
    this.addDesignation(false, "unknown", concept.language, concept.use, concept.value.trim(), concept.extension);
    //
    // if (context.display) {
    //   this.addDesignation(true, true, baseLanguage, null, context.display)
    // }
    // if (context.designation && Array.isArray(context.designation)) {
    //   for (const d of context.designation) {
    //     this.addDesignation(false, "unknown", d.language, d.use, d.value, d.extension);
    //   }
    // }
  }

  hasAnyDisplay(value) {
    for (let designation of this.designations) {
      if (designation.value === value) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a display value exists with specified matching criteria
   */
  hasDisplay(langList, defLang, value, active, mode) {
    validateOptionalParameter(langList, 'langList', Languages, true); // Allow null
    validateOptionalParameter(defLang, 'defLang', Language);
    validateParameter(value, 'value', String);
    validateParameter(active, 'active', Boolean);
    validateParameter(mode, 'mode', String);

    const result = { found: false, difference: DisplayDifference.None };

    for (const cd of this.designations) {
      if (this._langsMatch(langList, cd.language, LangMatchType.LANG, defLang) &&
          (!active || cd.isActive()) && cd.value && this._stringMatches(value, cd.value, mode, cd.language)) {
        result.found = true;
        return result;
      }
    }

    if (mode === DisplayCheckingStyle.EXACT) {
      for (const cd of this.designations) {
        if (this._langsMatch(langList, cd.language, LangMatchType.LANG, defLang) &&
          (!active || cd.isActive()) &&
          cd.value &&
          this._stringMatches(value, cd.value, DisplayCheckingStyle.CASE_INSENSITIVE, cd.language)) {
          result.difference = DisplayDifference.Case;
          return result;
        }
      }
    }

    if (mode !== DisplayCheckingStyle.NORMALISED) {
      for (const cd of this.designations) {
        if (this._langsMatch(langList, cd.language, LangMatchType.LANG, defLang) &&
          (!active || cd.isActive()) &&
          cd.value &&
          this._stringMatches(value, cd.value, DisplayCheckingStyle.NORMALISED, cd.language)) {
          result.difference = DisplayDifference.Normalized;
          return result;
        }
      }
    }

    return result;
  }

  /**
   * Count displays matching language criteria
   */
  displayCount(langList, defLang, displayOnly) {
    validateOptionalParameter(langList, 'langList', Languages, true); // Allow null
    validateOptionalParameter(defLang, 'defLang', Language);
    validateParameter(displayOnly, 'displayOnly', Boolean);

    let result = 0;

    // Try full match first
    for (const cd of this.designations) {
      if ((!displayOnly || this.isDisplay(cd)) &&
        this._langsMatch(langList, cd.language, LangMatchType.FULL, defLang) &&
        cd.value) {
        result++;
      }
    }

    if (result === 0) {
      // Try language-region match
      for (const cd of this.designations) {
        if ((!displayOnly || this.isDisplay(cd)) &&
          this._langsMatch(langList, cd.language, LangMatchType.LANG_REGION, defLang) &&
          cd.value) {
          result++;
        }
      }
    }

    if (result === 0) {
      // Try language-only match
      for (const cd of this.designations) {
        if ((!displayOnly || this.isDisplay(cd)) &&
          this._langsMatch(langList, cd.language, LangMatchType.LANG, defLang) &&
          cd.value) {
          result++;
        }
      }
    }

    return result;
  }

  /**
   * Present all matching designations as a formatted string
   */
  present(langList, defLang, displayOnly) {
    validateOptionalParameter(langList, 'langList', Languages, true); // Allow null
    validateOptionalParameter(defLang, 'defLang', Language);
    validateParameter(displayOnly, 'displayOnly', Boolean);

    const results = [];
    let count = 0;

    // Collect matching designations
    for (const cd of this.designations) {
      if ((!displayOnly || this.isDisplay(cd)) &&
        this._langsMatch(langList, cd.language, LangMatchType.LANG, null) &&
        cd.value) {
        count++;
        if (cd.language) {
          results.push(`'${cd.display}' (${cd.language.code})`);
        } else {
          results.push(`'${cd.display}'`);
        }
      }
    }

    // If no language-specific matches, get all
    if (count === 0) {
      for (const cd of this.designations) {
        if ((!displayOnly || this.isDisplay(cd)) && cd.value) {
          count++;
          if (cd.language) {
            results.push(`'${cd.display}' (${cd.language.code})`);
          } else {
            results.push(`'${cd.display}'`);
          }
        }
      }
    }

    return this._joinWithOr(results);
  }

  /**
   * Check if designation should be included for given language criteria
   */
  include(cd, langList, defLang) {
    validateParameter(cd, 'cd', Designation);
    validateParameter(langList, 'langList', Languages, true); // Allow null
    validateOptionalParameter(defLang, 'defLang', Language);

    return this._langsMatch(langList, cd.language, LangMatchType.LANG, defLang);
  }

  /**
   * Find the preferred designation for given language preferences
   */
  preferredDesignation(langList = null, supplements = null) {
    if (this.designations.length === 0) {
      return null;
    }

    if (!langList || langList.length == 0) {
      // No language list, prefer base designations
      for (const cd of this.designations) {
        if (this._isPreferred(cd) && cd.isActive()) {
          if (supplements && cd.source) {
            supplements.add(cd.source);
          }
          return cd;
        }
      }
      for (const cd of this.designations) {
        if (this.isDisplay(cd) && cd.isActive()) {
          if (supplements && cd.source) {
            supplements.add(cd.source);
          }
          return cd;
        }
      }
      for (const cd of this.designations) {
        if (this.isDisplay(cd)) {
          if (supplements && cd.source) {
            supplements.add(cd.source);
          }
          return cd;
        }
      }
      for (const cd of this.designations) {
        if (this._isPreferred(cd)) {
          if (supplements && cd.source) {
            supplements.add(cd.source);
          }
          return cd;
        }
      }
      if (supplements && this.designations[0].source) {
        supplements.add(this.designations[0].source);
      }
      return this.designations[0];
    }

    for (const lang of langList.languages) {
      if (lang.quality <= 0) continue;

      const matchTypes = [LangMatchType.FULL, LangMatchType.LANG_REGION, LangMatchType.LANG];

      for (const activeOnly of [true, false]) {
        for (const matchType of matchTypes) {
          // _isPreferred before isDisplay, matching the no-language branch above.
          // The two sets differ only where a provider's own isDisplay() accepts a
          // designation that isn't a preferred term - today that is the SNOMED FSN,
          // which isDisplay() accepts and _isPreferred() deliberately does not. Testing
          // isDisplay first made a request for a language whose concept has both an FSN
          // and a preferred synonym display the "(disorder)"-suffixed FSN, purely
          // because the FSN was emitted first.
          for (const cd of this.designations) {
            if (this._langMatches(lang, cd.language, matchType) && this._isPreferred(cd) && (!activeOnly || cd.isActive())) {
              if (supplements && cd.source) {
                supplements.add(cd.source);
              }
              return cd;
            }
          }
          for (const cd of this.designations) {
            if (this._langMatches(lang, cd.language, matchType) && this.isDisplay(cd) && (!activeOnly || cd.isActive())) {
              if (supplements && cd.source) {
                supplements.add(cd.source);
              }
              return cd;
            }
          }
          for (const cd of this.designations) {
            if (this._langMatches(lang, cd.language, matchType) && (!activeOnly || cd.isActive())) {
              if (supplements && cd.source) {
                supplements.add(cd.source);
              }
              return cd;
            }
          }
        }
      }
    }
    for (const cd of this.designations) {
      if (!cd.language && this.isDisplay(cd) && cd.isActive()) {
        if (supplements && cd.source) {
          supplements.add(cd.source);
        }
        return cd;
      } if (!cd.language && this.isDisplay(cd)) {
        if (supplements && cd.source) {
          supplements.add(cd.source);
        }
        return cd;
      }
    }
    return null;
  }

  /**
   * Select the best designation from all collected matches
   */ /*
  _selectBestMatch(matches) {
    // Sort by priority:
    // 1. Match type (FULL > LANG_REGION > LANG)
    // 2. Language quality
    // 3. Designation type (base > display > other)
    // 4. Language specificity (exact language > regional variant)

    const matchTypePriority = {
      [LangMatchType.FULL]: 3,
      [LangMatchType.LANG_REGION]: 2,
      [LangMatchType.LANG]: 1
    };

    const getDesignationTypePriority = (cd) => {
      if (cd.base) return 3;
      if (this.isDisplay(cd)) return 2;
      return 1;
    };

    const getLanguageSpecificity = (cd) => {
      // For same match type, prefer exact language over regional variants
      // Shorter language codes are more general (fr vs fr-CA)
      const code = cd.language?.code || '';
      return -code.length; // Negative so shorter codes sort first
    };

    matches.sort((a, b) => {
      // 1. Language quality
      const qualityDiff = b.quality - a.quality;
      if (qualityDiff !== 0) return qualityDiff;

      // 2. Match type priority
      const matchTypeDiff = matchTypePriority[b.matchType] - matchTypePriority[a.matchType];
      if (matchTypeDiff !== 0) return matchTypeDiff;

      // 3. Designation type
      const designationTypeDiff = getDesignationTypePriority(b.designation) - getDesignationTypePriority(a.designation);
      if (designationTypeDiff !== 0) return designationTypeDiff;

      // 4. Language specificity (for same match type, prefer more specific matches)
      return getLanguageSpecificity(b.designation) - getLanguageSpecificity(a.designation);
    });

    return matches[0].designation;
  }
*/
  /**
   * Get preferred display text
   */
  preferredDisplay(langList, defLang) {
    const cd = this.preferredDesignation(langList, defLang);
    return cd ? cd.display : '';
  }

  /**
   * Get summary of all designations
   */
  summary() {
    return this.designations.map(cd => cd.present()).join(', ');
  }

  /**
   * Present this designations object
   */
  presentSelf() {
    let result = this.baseLang ? `Lang: ${this.baseLang.code}` : 'Lang: ??';
    if (this.source) {
      result += `; source: ${this.source.constructor.name}`;
    }
    return result;
  }

  /**
   * Get language code for base language
   */
  get langCode() {
    return this.baseLang ? this.baseLang.code : 'en';
  }

  /**
   * Get count of all designations
   * @returns {number}
   */
  get count() {
    return this.designations.length;
  }
  // Private helper methods

  /**
   * Check if designation is a display designation
   */
  isDisplay(cd) {
    if (!cd.use) {
      return true;
    }
    if ((cd.use.system === DesignationUse.DISPLAY.system &&
        cd.use.code === DesignationUse.DISPLAY.code) ||
      (cd.use.system === DesignationUse.PREFERRED.system &&
        cd.use.code === DesignationUse.PREFERRED.code)) {
      return true;
    }
    return this.source && this.source.isDisplay(cd);
  }

  /**
   * Check if designation is a display designation
   */
  _isPreferred(cd) {
    return !cd.use ||
      (cd.use.system === DesignationUse.DISPLAY.system &&
        cd.use.code === DesignationUse.DISPLAY.code) ||
      (cd.use.system === DesignationUse.PREFERRED.system &&
        cd.use.code === DesignationUse.PREFERRED.code) ||
      // snomed
      (cd.use.system === 'http://snomed.info/sct' &&
        cd.use.code === '900000000000013009');
  }

  /**
   * Get depth for match type
   */
  _depthForMatchType(matchType) {
    switch (matchType) {
      case LangMatchType.LITERAL:
      case LangMatchType.FULL:
        return LanguagePartType.EXTENSION;
      case LangMatchType.LANG_EXACT:
        return LanguagePartType.REGION;
      case LangMatchType.LANG_REGION:
        return LanguagePartType.REGION;
      case LangMatchType.LANG:
        return LanguagePartType.LANGUAGE;
      default:
        return LanguagePartType.EXTENSION;
    }
  }

  /**
   * Check if a single language entry matches a stated language
   */
  _langMatches(langEntry, statedLang, matchType) {
    const actualLang = statedLang || this.baseLang;

    if (langEntry.quality <= 0) {
      return false;
    }

    if (langEntry.code === '*' && matchType !== LangMatchType.LITERAL) {
      return true;
    }

    if (actualLang) {
      if (matchType === LangMatchType.LITERAL) {
        return langEntry.code === actualLang.code;
      }

      // Parse the language entry if needed
      let parsedLang = langEntry;
      if (typeof langEntry.code === 'string') {
        parsedLang = this.languageDefinitions.parse(langEntry.code);
      }

      if (parsedLang && parsedLang.matches(actualLang, this._depthForMatchType(matchType))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if language list matches stated language
   */
  _langsMatch(langList, statedLang, matchType, defLang) {
    if (defLang && statedLang && statedLang.matches(defLang)) {
      return true;
    }

    if (!statedLang || !langList) {
      return true;
    }

    for (const langEntry of langList.languages) {
      if (this._langMatches(langEntry, statedLang, matchType)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if strings match according to specified mode
   */
  _stringMatches(source, possible, mode) {
    // We ignore lang parameter for now, like the Pascal version
    switch (mode) {
      case DisplayCheckingStyle.EXACT:
        return source === possible;
      case DisplayCheckingStyle.CASE_INSENSITIVE:
        return source.toLowerCase() === possible.toLowerCase();
      case DisplayCheckingStyle.NORMALISED:
        return this._normalizeWhitespace(source).toLowerCase() ===
          this._normalizeWhitespace(possible).toLowerCase();
      default:
        return false;
    }
  }

  /**
   * Normalize whitespace in a string
   */
  _normalizeWhitespace(str) {
    return str.replace(/\s+/g, ' ').trim();
  }

  /**
   * Join array with commas and final "or"
   */
  _joinWithOr(items) {
    if (items.length === 0) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} or ${items[1]}`;

    const lastItem = items.pop();
    return `${items.join(', ')} or ${lastItem}`;
  }

  /**
   * Get allowed displays as a list (for error messages)
   * @param {Array<string>} output - Array to populate
   * @param {Languages} languages - Languages to consider
   * @param {Language} defaultLang - Default language fallback
   */
  allowedDisplays(output, languages = null, defaultLang = null) {
    const seen = new Set();

    for (const d of this.designations) {
      if (!d.isActive() || !(this.isDisplay(d)) || !d.value) continue;
      if (seen.has(d.value)) continue;

      // Check language match
      if (languages && languages.length > 0) {
        let langMatch = false;
        if (d.language) {
          langMatch = languagesHasMatch(languages, d.language);
        } else if (defaultLang || this.baseLang) {
          langMatch = true;
        }
        if (!langMatch) continue;
      }

      seen.add(d.value);
      output.push(d.value);
    }
  }


  /**
   * Get the inactive status string for a display
   * @param {string} display - Display text to find
   * @returns {string} Status string or empty
   */
  status(display) {
    for (const d of this.designations) {
      if (d.value === display) {
        return d.status;
      }
    }
    return '';
  }

  /**
   * Check if this collection has any displays for the given languages
   * @param {Languages} languages - Languages to check
   * @returns {boolean}
   */
  hasAnyDisplays(languages) {
    return this.displayCount(languages, null, true) > 0;
  }

  /**
   * Get all designations as an array (for iteration)
   * @returns {ConceptDesignation[]}
   */
  all() {
    return [...this.designations];
  }

  /**
   * Iterator support
   */
  [Symbol.iterator]() {
    return this.designations[Symbol.iterator]();
  }
}


/**
 * Check if a Languages collection has a match for a given language
 * @param {Languages} langs - Languages collection
 * @param {Language|string} target - Target language to match
 * @returns {boolean}
 */
function languagesHasMatch(langs, target) {
  if (!langs || langs.length === 0) return false;

  const targetLang = typeof target === 'string' ? new Language(target) : target;

  for (const lang of langs) {
    if (lang.matchesForDisplay(targetLang)) {
      return true;
    }
  }
  return false;
}


module.exports = {
  Designation,
  Designations,
  DesignationUse,
  SearchFilterText,
  DisplayCheckingStyle,
  DisplayCompareSensitivity,
  DisplayDifference,
  LangMatchType
};