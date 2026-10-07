const fs = require('fs');
const os = require('os');
const {validateOptionalParameter, Utilities} = require("./utilities");
const {join} = require("node:path");

/**
 * Language part types for matching depth
 */
const LanguagePartType = {
  NONE: 0,
  LANGUAGE: 1,
  EXTLANG: 2,
  SCRIPT: 3,
  REGION: 4,
  VARIANT: 5,
  EXTENSION: 6
};

/**
 * Base class for language entries
 */
class LanguageEntry {
  constructor() {
    this.code = '';
    this.displays = [];
    this.translations = new Map(); // language code -> translated display name
  }
}

/**
 * Language definition entry
 */
class LanguageLanguage extends LanguageEntry {
  constructor() {
    super();
    this.suppressScript = '';
    this.scope = '';
  }
}

/**
 * Extended language definition entry
 */
class LanguageExtLang extends LanguageEntry {}

/**
 * Script definition entry
 */
class LanguageScript extends LanguageEntry {}

/**
 * Region definition entry
 */
class LanguageRegion extends LanguageEntry {}

/**
 * Variant definition entry
 */
class LanguageVariant extends LanguageEntry {}

/**
 * Individual language representation based on BCP 47
 */
class Language {
  /**
   * @param {string} code - the language tag
   * @param {LanguageDefinitions} [languageDefinitions] - registry to validate against; without
   *   one the tag is only broken into parts, not checked
   * @param {object} [options] - extra checking, off by default so that existing callers
   *   (Accept-Language handling above all) keep the behaviour they were written against
   * @param {boolean} [options.caseInsensitive] - fold subtags to their registry case before
   *   looking them up. BCP 47 s2.1.1 says tags are case-insensitive and the conventional
   *   casing is a recommendation, so `en-us` is a valid way to write `en-US`
   * @param {boolean} [options.checkCombinations] - apply the registry's statements about
   *   which subtags may go together: the Prefix on an extlang or variant, and that a
   *   variant is registered at all
   */
  constructor(code = '', languageDefinitions = null, options = {}) {
    this.options = options || {};
    this.code = code;
    this.language = '';
    this.extLang = [];
    this.script = '';
    this.region = '';
    this.variant = '';
    this.extension = '';
    this.privateUse = [];
    this.quality = 1.0; // For Accept-Language header quality values

    if (this.code) {
      this._parse(languageDefinitions);
    }
  }

  /**
   * Get system default language, fallback to en-US
   */
  static _getDefaultLanguage() {
    try {
      // Try to get system locale
      const locale = Intl.DateTimeFormat().resolvedOptions().locale ||
      process.env.LANG ||
      process.env.LANGUAGE ||
      os.platform() === 'win32' ? 'en-US' : 'en-US';

      return locale.replace('_', '-'); // Convert underscore to hyphen
    } catch (error) {
      return 'en-US';
    }
  }

  /**
   * Create Language from xml:lang attribute
   */
  static fromXmlLang(xmlLang) {
    return new Language(xmlLang || 'en-US');
  }

  /**
   * Create Language from system default
   */
  static fromSystemDefault() {
    return new Language(this._getDefaultLanguage());
  }

  /**
   * Parse the language code according to BCP 47
   */
  _parse(languageDefinitions) {
    if (!this.code) return;

    // Grandfathered tags are whole tags, and most do not decompose into valid subtags
    // (i-klingon has no language 'i'), so they have to be recognised before the tag is
    // split up. Redundant entries are deliberately NOT here: zh-Hans decomposes, and
    // matching it whole would rob the caller of the script.
    if (languageDefinitions && languageDefinitions.wholeTags.has(this.code.toLowerCase())) {
      const entry = languageDefinitions.wholeTags.get(this.code.toLowerCase());
      this.language = entry.code;
      this.wholeTag = entry;
      return;
    }

    const fold = this.options.caseInsensitive;
    const parts = this.code.split('-');
    let index = 0;

    // Language (required)
    if (index < parts.length) {
      this.language = fold ? parts[index].toLowerCase() : parts[index];
      if (this.language != '*' && languageDefinitions && !languageDefinitions.languages.has(this.language)) {
        throw new Error("The language '"+parts[index]+"' in the code '"+this.code+"' is not valid");
      }
      index++;
    }

    // Extended language (up to 3)
    for (let i = 0; i < 3 && index < parts.length; i++) {
      const part = parts[index];
      const key = fold ? part.toLowerCase() : part;
      if (part.length === 3 && /^[a-zA-Z]{3}$/.test(part)) {
        if (languageDefinitions && !languageDefinitions.extLanguages.has(key)) {
          throw new Error("The extLanguage '"+part+"' in the code '"+this.code+"' is not valid");
        }
        if (this.options.checkCombinations && languageDefinitions) {
          this._checkPrefix(languageDefinitions.extLanguages.get(key), 'extLanguage', part);
        }
        this.extLang.push(part.toLowerCase());
        index++;
      } else {
        break;
      }
    }

    // Script (4 letters)
    if (index < parts.length) {
      const part = parts[index];
      if (part.length === 4 && /^[a-zA-Z]{4}$/.test(part)) {
        const key = fold ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part;
        if (languageDefinitions && !languageDefinitions.scripts.has(key)) {
          throw new Error("The script '"+part+"' in the code '"+this.code+"' is not valid");
        }
        this.script = part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
        index++;
      }
    }

    // Region (2 letters or 3 digits)
    if (index < parts.length) {
      const part = parts[index];
      if ((part.length === 2 && /^[a-zA-Z]{2}$/.test(part)) ||
        (part.length === 3 && /^[0-9]{3}$/.test(part))) {
        const key = fold ? part.toUpperCase() : part;
        if (languageDefinitions && !languageDefinitions.regions.has(key)) {
          throw new Error("The region '"+part+"' in the code '"+this.code+"' is not valid");
        }
        this.region = part.toUpperCase();
        index++;
      }
    }

    // Variant (5-8 chars or 4 chars starting with digit)
    if (index < parts.length) {
      const part = parts[index];
      if ((part.length >= 5 && part.length <= 8) ||
        (part.length === 4 && /^[0-9]/.test(part))) {
        const key = part.toLowerCase();
        if (this.options.checkCombinations && languageDefinitions) {
          // The variant is the one subtag whose existence was never checked at all -
          // 'en-abcdef' parsed happily with variant 'abcdef'.
          if (!languageDefinitions.variants.has(key)) {
            throw new Error("The variant '"+part+"' in the code '"+this.code+"' is not valid");
          }
          this._checkPrefix(languageDefinitions.variants.get(key), 'variant', part);
        }
        this.variant = key;
        index++;
      }
    }

    // Extensions and private use
    while (index < parts.length) {
      const part = parts[index];
      if (part === 'x') {
        // Private use
        index++;
        while (index < parts.length) {
          this.privateUse.push(parts[index]);
          index++;
        }
      } else if (part.length === 1 && part !== 'x') {
        // Extension
        this.extension = part + '-' + parts.slice(index + 1).join('-');
        index++;
        break;
      } else {
        throw new Error("Unable to recognised '"+parts[index]+"' as a valid part in the language code "+this.code);
      }
    }
  }

  /**
   * The registry's Prefix field names the language(s) a subtag may follow; it is the only
   * thing lang.dat says about which subtags go together. An entry with no Prefix may
   * follow anything.
   *
   * The prefix itself may be a multi-subtag tag (variant 'nedis' has Prefix 'sl-rozaj'),
   * so what has been parsed so far is reassembled and compared from the left.
   *
   * @param {object} entry - the registry entry, carrying `prefixes`
   * @param {string} what - 'extLanguage' or 'variant', for the message
   * @param {string} part - the subtag as written, for the message
   * @private
   */
  _checkPrefix(entry, what, part) {
    if (!entry || !entry.prefixes || entry.prefixes.length === 0) {
      return;
    }
    const soFar = [this.language.toLowerCase()]
      .concat(this.extLang.map(e => e.toLowerCase()))
      .concat(this.script ? [this.script.toLowerCase()] : [])
      .concat(this.region ? [this.region.toLowerCase()] : [])
      .join('-');
    const ok = entry.prefixes.some(prefix => soFar === prefix || soFar.startsWith(prefix + '-'));
    if (!ok) {
      throw new Error("The " + what + " '" + part + "' in the code '" + this.code
        + "' may only be used with " + entry.prefixes.map(p => "'" + p + "'").join(' or ')
        + ", not with '" + soFar + "'");
    }
  }

  /**
   * Check if this language matches another to a given depth
   */
  matches(other, depth = LanguagePartType.LANGUAGE) {
    if (!other) return false;

    if (depth >= LanguagePartType.EXTENSION) {
      if (this.extension !== other.extension) return false;
    }

    if (depth >= LanguagePartType.VARIANT) {
      if (this.variant !== other.variant) return false;
    }

    if (depth >= LanguagePartType.REGION) {
      if (this.region !== other.region) return false;
    }

    if (depth >= LanguagePartType.SCRIPT) {
      if (this.script !== other.script) return false;
    }

    if (depth >= LanguagePartType.EXTLANG) {
      if (JSON.stringify(this.extLang) !== JSON.stringify(other.extLang)) return false;
    }

    if (depth >= LanguagePartType.LANGUAGE) {
      return this.language === other.language;
    }

    return true;
  }

  /**
   * Simple matching (all non-empty parts must match)
   */
  matchesSimple(other) {
    if (!other) return false;

    if (this.extension && this.extension !== other.extension) return false;
    if (this.variant && this.variant !== other.variant) return false;
    if (this.region && this.region !== other.region) return false;
    if (this.script && this.script !== other.script) return false;
    if (this.extLang.length > 0 &&
      JSON.stringify(this.extLang) !== JSON.stringify(other.extLang)) return false;

    return this.language === other.language;
  }

  /**
   * Check if this is a simple language-region tag
   */
  isLangRegion() {
    return (this.language !== '' && this.region !== '' &&
      this.extLang.length === 0 && this.script === '' &&
      this.variant === '' && this.extension === '' && this.privateUse.length === 0);
  }

  /**
   * Check if this language matches another according to display matching rules:
   * - Same language (e.g. en = en)
   * - This language has more details than the target (e.g. en-AU matches en)
   * - Either is blank and the other is en or en-US
   */
  matchesForDisplay(other) {
    if (!other) return false;

    const thisLang = typeof other === 'string' ? new Language(other) : other;

    // Handle blank languages - match only if other is exactly 'en' or 'en-US'
    if (!this.language || this.language === '') {
      return thisLang.code === 'en' || thisLang.code === 'en-US';
    }
    if (!thisLang.language || thisLang.language === '') {
      return this.code === 'en' || this.code === 'en-US';
    }

    // Must match at language level
    if (this.language !== thisLang.language) {
      return false;
    }

    // Check each component: if target specifies it, this must match exactly
    // If target doesn't specify it, this can have any value (more specific is OK)

    // Check script
    if (thisLang.script && thisLang.script !== '') {
      if (this.script !== thisLang.script) {
        return false;
      }
    }

    // Check region
    if (thisLang.region && thisLang.region !== '') {
      if (this.region !== thisLang.region) {
        return false;
      }
    }

    // Check variant
    if (thisLang.variant && thisLang.variant !== '') {
      if (this.variant !== thisLang.variant) {
        return false;
      }
    }

    return true;
  }


  isEnglishOrNothing() {
    return !this.code || this.code === 'en' || this.code === 'en-US';
  }

  toString() {
    const parts = [];

    if (this.language) parts.push(this.language);
    parts.push(...this.extLang);
    if (this.script) parts.push(this.script);
    if (this.region) parts.push(this.region);
    if (this.variant) parts.push(this.variant);
    if (this.extension) parts.push(this.extension);
    if (this.privateUse.length > 0) {
      parts.push('x');
      parts.push(...this.privateUse);
    }

    return parts.join('-');
  }

  asString() {
    if (this.quality != undefined && this.quality != 1) {
      return this.code+"; q="+this.quality;
    } else {
      return this.code;
    }
  }
}

/**
 * Collection of languages with preference ordering
 */
class Languages {
  definitions;

  constructor(definitions) {
    validateOptionalParameter(definitions, "definitions", LanguageDefinitions);
    this.definitions = definitions;
    this.languages = [];

  }

  /**
   * Parse Accept-Language header
   * Format: "en-US,en;q=0.9,fr;q=0.8"
   */
  static fromAcceptLanguage(acceptLanguageHeader, languageDefinitions, addWildcard) {
    const languages = new Languages(languageDefinitions);
    let wc = false;

    if (!acceptLanguageHeader) {
      languages.add(Language.fromSystemDefault());
      return languages;
    }

    const entries = acceptLanguageHeader.split(',').map(s => s.trim());
    const parsed = [];

    for (const entry of entries) {
      const [langCode, qValue] = entry.split(';');
      const quality = qValue ? Utilities.parseFloatOrDefault(qValue.split('=')[1], 1.0) : 1.0;

      let lc = langCode.trim();
      wc = wc || lc == '*';
      const lang = new Language(lc, languageDefinitions);
      lang.quality = quality;
      parsed.push(lang);
    }
    if (addWildcard && !wc) {
      const lang = new Language('*', languageDefinitions);
      lang.quality = 0.01;
      lang.implicit = true;
      parsed.push(lang);
    }
    // Sort by quality (descending)
    parsed.sort((a, b) => b.quality - a.quality);

    for (const lang of parsed) {
      languages.add(lang);
    }

    return languages;
  }

  /**
   * Add a language to the collection
   */
  add(language) {
    this.languages.push(language);
  }

  /**
   * Get iterator for languages in preference order
   */
  [Symbol.iterator]() {
    return this.languages[Symbol.iterator]();
  }

  /**
   * Get language by index
   */
  get(index) {
    return this.languages[index];
  }

  /**
   * Get number of languages
   */
  get length() {
    return this.languages.length;
  }

  /**
   * Find best match for a given language
   */
  findBestMatch(target, depth = LanguagePartType.LANGUAGE) {
    for (const lang of this.languages) {
      if (lang.matches(target, depth)) {
        return lang;
      }
    }
    return null;
  }

  /**
   * Check if any language matches the target
   */
  matches(target, depth = LanguagePartType.LANGUAGE) {
    return this.findBestMatch(target, depth) !== null;
  }

  /**
   * Get primary language (first in preference order)
   */
  getPrimary() {
    return this.languages.length > 0 ? this.languages[0] : new Language('en-US');
  }

  isEnglishOrNothing() {
    for (const lang of this.languages) {
      if (!lang.isEnglishOrNothing()) {
        return false;
      }
    }
    return true;
  }

  includesLanguage(code) {
    const llang = new Language(code);
    for (const lang of this.languages) {
      if (lang.matches(llang)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Convert to string representation (similar to Accept-Language header format)
   */
  toString() {
    if (this.languages.length === 0) {
      return '';
    }

    return this.languages.map(lang => {
      if (lang.quality === 1.0) {
        return lang.code;
      } else {
        return `${lang.code};q=${lang.quality}`;
      }
    }).join(',');
  }

  asString(incWildcard) {
    const parts = [];
    for (const lang of this.languages) {
      if ((incWildcard || lang.code !== '*') && !lang.implicit) {
        parts.push(lang.asString());
      }
    }
    return parts.join(', ');
  }

  /**
   * The languages as they were asked for, in the form a displayLanguage parameter takes
   * (the Accept-Language syntax: "en,it;q=0.8,*"). Unlike asString, which is for reading
   * in messages, there are no spaces; unlike toString, implicit languages are left out.
   */
  asParameter() {
    return this.languages.filter(lang => !lang.implicit).map(lang => {
      if (lang.quality === undefined || lang.quality === 1.0) {
        return lang.code;
      } else {
        return `${lang.code};q=${lang.quality}`;
      }
    }).join(',');
  }
}

/**
 * Global language definitions loaded from IETF registry
 */
class LanguageDefinitions {
  constructor() {
    this.languages = new Map();
    this.extLanguages = new Map();
    this.scripts = new Map();
    this.regions = new Map();
    this.variants = new Map();
    // Whole tags that predate the current syntax (i-klingon, en-GB-oed) or that the
    // registry records as ready-made combinations (az-Arab). They are matched as
    // complete tags, before the tag is broken into subtags, because most of them do
    // not decompose into valid subtags at all. Keyed lower case: BCP 47 tags are
    // case-insensitive, and the registry writes these in mixed case.
    this.wholeTags = new Map();
    this.parsed = new Map(); // Cache for parsed languages
  }

  /**
   * Expand a registry subtag range into its members.
   *
   * The registry writes private-use allocations as ranges - `QM..QZ`, `Qaaa..Qabx`,
   * `qaa..qtz`, `XA..XZ` - in a single record. Stored literally, the key `QM..QZ` is
   * one nobody will ever look up, and every code in the range reads as unregistered:
   * `en-QM` was rejected while `en-AA` (allocated singly) was accepted.
   *
   * Only the trailing letters vary, so the shared prefix is kept and the remainder is
   * counted through base 26, rendered in the case the range itself uses.
   *
   * @param {string} subtag - a subtag, with or without `..`
   * @returns {string[]} every code the entry covers; a single-element array if not a range
   */
  static expandSubtagRange(subtag) {
    const at = subtag.indexOf('..');
    if (at === -1) {
      return [subtag];
    }
    const from = subtag.substring(0, at);
    const to = subtag.substring(at + 2);
    if (from.length !== to.length || !/^[a-zA-Z]+$/.test(from) || !/^[a-zA-Z]+$/.test(to)) {
      return [subtag];
    }
    let shared = 0;
    while (shared < from.length && from[shared] === to[shared]) {
      shared++;
    }
    const prefix = from.substring(0, shared);
    const upper = /[A-Z]/.test(from.substring(shared));
    const A = 'a'.charCodeAt(0);
    const toIndex = (text) => [...text.toLowerCase()].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - A), 0);
    const width = from.length - shared;
    const render = (n) => {
      let out = '';
      for (let i = 0; i < width; i++) {
        out = String.fromCharCode(A + (n % 26)) + out;
        n = Math.floor(n / 26);
      }
      return upper ? out.toUpperCase() : out;
    };
    const result = [];
    for (let n = toIndex(from.substring(shared)); n <= toIndex(to.substring(shared)); n++) {
      result.push(prefix + render(n));
    }
    return result;
  }

  /**
   * Load definitions from IETF language subtag registry file
   */
  static async fromFiles(filePath) {
    const definitions = new LanguageDefinitions();
    const content = fs.readFileSync(join(filePath, "lang.dat"), 'utf8');
    definitions._load(content);
    definitions._loadTranslations(join(filePath, "languages.csv"), definitions.languages);
    definitions._loadTranslations(join(filePath, "regions.csv"), definitions.regions);
    return definitions;
  }

  /**
   * Load definitions from content string
   */
  static fromContent(content) {
    const definitions = new LanguageDefinitions();
    definitions._load(content);
    return definitions;
  }

  /**
   * Check if source content is valid
   */
  static checkSource(source) {
    return source.startsWith('%%') ? 'Ok' : 'Invalid';
  }

  /**
   * Parse the IETF registry format
   */
  _load(source) {
    const lines = source.split('\n');
    let i = 0;

    while (i < lines.length) {
      if (lines[i].trim() === '%%') {
        i++;
        const [vars, nextIndex] = this._readVars(lines, i);
        i = nextIndex;

        switch (vars.Type) {
          case 'language':
            this._loadLanguage(vars);
            break;
          case 'extlang':
            this._loadExtLang(vars);
            break;
          case 'script':
            this._loadScript(vars);
            break;
          case 'region':
            this._loadRegion(vars);
            break;
          case 'variant':
            this._loadVariant(vars);
            break;
          case 'grandfathered':
            this._loadWholeTag(vars);
            break;
          case 'redundant':
            // Nothing to do: a redundant entry is called that because it decomposes into
            // subtags that already say the same thing (zh-Hans is zh + Hans), so the
            // normal path handles it and gives the caller the parts as well.
            break;
          default:
            throw new Error(`Unknown type: ${vars.Type} at line ${i + 1}`);
        }
      } else {
        i++;
      }
    }
  }

  /**
   * Load a grandfathered entry - a whole tag from before the current syntax, most of
   * which cannot be decomposed into valid subtags at all ('i-klingon' has no language
   * 'i'), so they are matched entire.
   */
  _loadWholeTag(vars) {
    const tag = vars.Tag || vars.Subtag;
    if (!tag) {
      return;
    }
    this.wholeTags.set(tag.toLowerCase(), {
      code: tag,
      displays: vars.Description ? vars.Description.split('|') : [],
      deprecated: !!vars.Deprecated,
      preferred: vars['Preferred-Value'] || ''
    });
  }

  /**
   * Read variables from the registry format
   */
  _readVars(lines, startIndex) {
    const vars = {};
    let i = startIndex;

    while (i < lines.length && lines[i].trim() !== '%%') {
      const line = lines[i].trim();
      if (line && !line.startsWith(' ')) {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim();
          const value = line.substring(colonIndex + 1).trim();

          if (vars[key]) {
            vars[key] += '|' + value;
          } else {
            vars[key] = value;
          }
        }
      }
      i++;
    }

    return [vars, i];
  }

  /**
   * Load translations from a CSV file into an existing map of entries.
   * CSV format: code,english,french,german,spanish,arabic,chinese,russian,japanese,swahili
   * The language codes for the translation columns:
   */
  _loadTranslations(csvPath, targetMap) {
    if (!fs.existsSync(csvPath)) {
      return;
    }
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n');
    if (lines.length < 2) return;

    const header = this._parseCsvLine(lines[0]);
    // header[0] = 'code', header[1..] = language names mapped to codes
    const langCodeMap = {
      'english': 'en',
      'french': 'fr',
      'german': 'de',
      'spanish': 'es',
      'arabic': 'ar',
      'chinese': 'zh',
      'russian': 'ru',
      'japanese': 'ja',
      'swahili': 'sw'
    };

    const columnLangs = header.slice(1).map(h => langCodeMap[h.toLowerCase()] || h.toLowerCase());

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const fields = this._parseCsvLine(line);
      if (fields.length < 2) continue;

      const code = fields[0];
      const entry = targetMap.get(code);
      if (!entry) continue;

      for (let j = 1; j < fields.length && j < header.length; j++) {
        const langCode = columnLangs[j - 1];
        const value = fields[j];
        if (value) {
          entry.translations.set(langCode, value);
        }
      }
    }
  }

  /**
   * Parse a single CSV line, handling quoted fields with commas
   */
  _parseCsvLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          fields.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
    }
    fields.push(current);
    return fields;
  }

  /**
   * Load language entry
   */
  _loadLanguage(vars) {
    const lang = new LanguageLanguage();
    lang.code = vars.Subtag;
    lang.displays = vars.Description ? vars.Description.split('|') : [];
    lang.suppressScript = vars['Suppress-Script'] || '';
    lang.scope = vars.Scope || '';

    for (const code of LanguageDefinitions.expandSubtagRange(lang.code)) {
      if (this.languages.has(code)) {
        throw new Error(`Duplicate language code: ${code}`);
      }
      this.languages.set(code, lang.code === code ? lang : Object.assign(Object.create(Object.getPrototypeOf(lang)), lang, { code }));
    }
  }

  /**
   * Load extended language entry
   */
  _loadExtLang(vars) {
    const extLang = new LanguageExtLang();
    extLang.code = vars.Subtag;
    extLang.displays = vars.Description ? vars.Description.split('|') : [];
    // Prefix is the registry saying which language(s) this subtag may follow
    extLang.prefixes = vars.Prefix ? vars.Prefix.split('|').map(v => v.trim().toLowerCase()) : [];

    for (const code of LanguageDefinitions.expandSubtagRange(extLang.code)) {
      if (this.extLanguages.has(code)) {
        throw new Error(`Duplicate extlang code: ${code}`);
      }
      this.extLanguages.set(code, extLang.code === code ? extLang : Object.assign(Object.create(Object.getPrototypeOf(extLang)), extLang, { code }));
    }
  }

  /**
   * Load script entry
   */
  _loadScript(vars) {
    const script = new LanguageScript();
    script.code = vars.Subtag;
    script.displays = vars.Description ? vars.Description.split('|') : [];

    for (const code of LanguageDefinitions.expandSubtagRange(script.code)) {
      if (this.scripts.has(code)) {
        throw new Error(`Duplicate script code: ${code}`);
      }
      this.scripts.set(code, script.code === code ? script : Object.assign(Object.create(Object.getPrototypeOf(script)), script, { code }));
    }
  }

  /**
   * Load region entry
   */
  _loadRegion(vars) {
    const region = new LanguageRegion();
    region.code = vars.Subtag;
    region.displays = vars.Description ? vars.Description.split('|') : [];

    for (const code of LanguageDefinitions.expandSubtagRange(region.code)) {
      if (this.regions.has(code)) {
        throw new Error(`Duplicate region code: ${code}`);
      }
      this.regions.set(code, region.code === code ? region : Object.assign(Object.create(Object.getPrototypeOf(region)), region, { code }));
    }
  }

  /**
   * Load variant entry
   */
  _loadVariant(vars) {
    const variant = new LanguageVariant();
    variant.code = vars.Subtag;
    variant.displays = vars.Description ? vars.Description.split('|') : [];
    variant.prefixes = vars.Prefix ? vars.Prefix.split('|').map(v => v.trim().toLowerCase()) : [];

    for (const code of LanguageDefinitions.expandSubtagRange(variant.code)) {
      if (this.variants.has(code)) {
        throw new Error(`Duplicate variant code: ${code}`);
      }
      this.variants.set(code, variant.code === code ? variant : Object.assign(Object.create(Object.getPrototypeOf(variant)), variant, { code }));
    }
  }

  /**
   * Parse and validate a language code
   *
   * @return {Language} parsed language (or null)
   */
  parse(code, msg, options = {}) {
    if (!code) {
      if (msg) {
        msg.message = 'No code provided';
      }
      return null;
    }

    // The cache key carries the options: the same tag can be valid under one set of
    // rules and not another, so a lenient parse must not be served to a strict caller.
    const key = (options.caseInsensitive ? 'i' : '') + (options.checkCombinations ? 'c' : '') + ':' + code;
    if (this.parsed.has(key)) {
      return this.parsed.get(key);
    }

    try {
      const lang = new Language(code, this, options);
      // Cache the result
      this.parsed.set(key, lang);
      return lang;
    } catch (e) {
      if (msg) {
        msg.message = e.message;
      }
      return null;
    }
  }

  /**
   * Get display name for language, optionally translated
   */
  getDisplayForLang(code, displayIndex = 0) {
    const lang = this.languages.get(code);
    return lang && lang.displays[displayIndex] ? lang.displays[displayIndex] : code;
  }

  /**
   * Get translated display name for a language code
   * @param {string} code - the language subtag
   * @param {string} displayLang - the language to translate into (e.g. 'fr', 'de')
   * @returns {string} translated name, or English name, or the code itself
   */
  getTranslatedDisplayForLang(code, displayLang) {
    const lang = this.languages.get(code);
    if (!lang) return code;
    if (displayLang) {
      const translated = lang.translations.get(displayLang);
      if (translated) return translated;
    }
    return lang.displays[0] || code;
  }

  /**
   * Get display name for region
   */
  getDisplayForRegion(code, displayIndex = 0) {
    const region = this.regions.get(code);
    return region && region.displays[displayIndex] ? region.displays[displayIndex] : code;
  }

  /**
   * Get translated display name for a region code
   * @param {string} code - the region subtag
   * @param {string} displayLang - the language to translate into (e.g. 'fr', 'de')
   * @returns {string} translated name, or English name, or the code itself
   */
  getTranslatedDisplayForRegion(code, displayLang) {
    const region = this.regions.get(code);
    if (!region) return code;
    if (displayLang) {
      const translated = region.translations.get(displayLang);
      if (translated) return translated;
    }
    return region.displays[0] || code;
  }

  /**
   * Get display name for script
   */
  getDisplayForScript(code, displayIndex = 0) {
    const script = this.scripts.get(code);
    return script && script.displays[displayIndex] ? script.displays[displayIndex] : code;
  }

  /**
   * Present a language with full display names
   */
  present(lang, displayIndex = 0, template = null) {
    if (!lang) return '';

    if (template) {
      return template
        .replace('{{lang}}', this.getDisplayForLang(lang.language, displayIndex))
        .replace('{{region}}', this.getDisplayForRegion(lang.region, displayIndex))
        .replace('{{script}}', this.getDisplayForScript(lang.script, displayIndex));
    }

    let result = this.getDisplayForLang(lang.language, displayIndex);
    const parts = [];
    if (lang.region && !lang.script && !lang.variant) {
      parts.push(`${this.getDisplayForRegion(lang.region, 0)}`);
    } else {
      if (lang.script) {
        parts.push(`Script=${this.getDisplayForScript(lang.script, 0)}`);
      }
      if (lang.region) {
        parts.push(`Region=${this.getDisplayForRegion(lang.region, 0)}`);
      }
      if (lang.variant) {
        const variant = this.variants.get(lang.variant);
        const variantDisplay = variant && variant.displays[0] ? variant.displays[0] : lang.variant;
        parts.push(`Variant=${variantDisplay}`);
      }
    }

    if (parts.length > 0) {
      result += ` (${parts.join(', ')})`;
    }

    return result;
  }

  /**
   * Get number of available displays for a language
   */
  displayCount(lang) {
    if (!lang) return 0;
    const language = this.languages.get(lang.language);
    return language ? language.displays.length : 0;
  }
}

module.exports = {
  Language,
  Languages,
  LanguageDefinitions,
  LanguagePartType,
  LanguageEntry,
  LanguageLanguage,
  LanguageExtLang,
  LanguageScript,
  LanguageRegion,
  LanguageVariant
};