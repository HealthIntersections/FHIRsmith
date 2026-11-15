//
// A text index of a CodeSystem supplement's displays and designations, for text filters
//

/**
 * What a supplement in use offers a text filter ($expand filter=...): its displays (in the
 * supplement's language) and designations (each in its own language, or the supplement's), by
 * language and by stem, so a filter is answered from the index rather than by stemming every
 * display of the supplement again for each request. A global language pack for LOINC (the
 * Uzbek one, on tx.fhir.org) has a display and designations for every LOINC code: stemming them
 * all took about a second of every LOINC text search, without letting anything else run.
 *
 * Built once per supplement (they are long-lived; the index is held weakly, so a supplement
 * that is reloaded gets a new one):
 * - languages(): the language subtags it has text in - cheap, built on first use
 * - search(filter, language): the codes with a text in that language that matches the filter,
 *   in the supplement's concept order. The index (a NameIndex: text-match.js, the rules every
 *   provider's search follows) is built on the first search, letting other work run every 25 ms
 *   while it does
 *
 * The match is per text: every word of the filter in one display, or in one designation, as
 * SearchFilterText.passes on that text gives.
 */

const { NameIndex, languageOf } = require('./text-match');

const YIELD_MS = 25;

const indexes = new WeakMap(); // supplement CodeSystem -> SupplementTextIndex
// a global supplement (a language pack) is loaded once for each endpoint (FHIR version), as
// separate objects with the same content: they share one index, by vurl
const shared = new Map(); // vurl#language -> SupplementTextIndex

class SupplementTextIndex {
  /**
   * The index of a supplement (a CodeSystem, as the providers hold them: jsonObj, getAllConcepts)
   * @param {CodeSystem} supplement
   * @param {string} defLang - the language of a supplement that doesn't say (the code system's)
   */
  static of(supplement, defLang) {
    // the code system's language only matters to a supplement that doesn't say its own
    const lang = supplement.jsonObj && supplement.jsonObj.language ? '' : (defLang || 'en');
    const size = SupplementTextIndex.#size(supplement);
    if (supplement.vurl && typeof supplement.isGlobalSupplement === 'function' && supplement.isGlobalSupplement()) {
      const key = supplement.vurl + '#' + lang;
      let index = shared.get(key);
      if (!index || index.size !== size) {
        index = new SupplementTextIndex(supplement, defLang, size);
        shared.set(key, index);
      }
      return index;
    }
    let index = indexes.get(supplement);
    if (!index || index.lang !== lang || index.size !== size) {
      index = new SupplementTextIndex(supplement, defLang, size);
      indexes.set(supplement, index);
    }
    return index;
  }

  /**
   * Build the index of a supplement now, in the background (letting other work run), so the
   * first search that needs it doesn't wait for it: for the global supplements, as the server
   * starts (TXModule)
   * @returns {Promise<void>}
   */
  static async warm(supplement, defLang) {
    await SupplementTextIndex.of(supplement, defLang).#ensureBuilt();
  }

  static #size(supplement) {
    return supplement.codeMap instanceof Map ? supplement.codeMap.size : supplement.getAllConcepts().length;
  }

  constructor(supplement, defLang, size) {
    this.supplement = supplement;
    this.defLang = defLang;
    this.lang = supplement.jsonObj && supplement.jsonObj.language ? '' : (defLang || 'en');
    this.size = size;
    this._languages = null;
    this._built = null; // Promise of a NameIndex
  }

  /**
   * The primary language subtag of a language tag (en-US -> en), or of `fallback`
   */
  static languageOf(tag, fallback) {
    return languageOf(tag, fallback);
  }

  /**
   * Each text of the supplement: fn(code, language subtag, text)
   */
  #eachText(fn) {
    const suppLang = SupplementTextIndex.languageOf(this.supplement.jsonObj.language, this.defLang);
    for (const concept of this.supplement.getAllConcepts()) {
      if (concept.display) {
        fn(concept.code, suppLang, concept.display);
      }
      for (const d of concept.designation || []) {
        if (d.value) {
          fn(concept.code, SupplementTextIndex.languageOf(d.language, suppLang), d.value);
        }
      }
    }
  }

  /**
   * The language subtags the supplement has text in
   * @returns {Set<string>}
   */
  languages() {
    if (!this._languages) {
      const langs = new Set();
      this.#eachText((code, lang) => langs.add(lang));
      this._languages = langs;
    }
    return this._languages;
  }

  /**
   * Whether the supplement has text in a language (compared at the language subtag)
   */
  hasText(language) {
    return this.languages().has(SupplementTextIndex.languageOf(language));
  }

  async #build() {
    const index = new NameIndex();
    this.#eachText((code, lang, value) => index.add(code, lang, value));
    return await index.build(YIELD_MS);
  }

  /**
   * The codes with a text in the language that has every word of the filter
   *
   * @param {SearchFilterText} filter
   * @param {string|Language} language
   * @returns {Promise<Set<string>>} in the supplement's concept order
   */
  async search(filter, language) {
    return new Set((await this.searchTexts(filter, language)).keys());
  }

  /**
   * As search, with the texts of each code that matched
   * @returns {Promise<Map<string, string[]>>} code -> its matching texts, in concept order
   */
  async searchTexts(filter, language) {
    const result = new Map();
    if (!filter || filter.isNull || !this.hasText(language)) {
      return result;
    }
    const index = await this.#ensureBuilt();
    return index.searchNames(filter.query, language);
  }

  #ensureBuilt() {
    if (this._built === null) {
      this._built = this.#build();
      this._built.catch(() => {
        this._built = null; // try again next time
      });
    }
    return this._built;
  }
}

module.exports = { SupplementTextIndex };
