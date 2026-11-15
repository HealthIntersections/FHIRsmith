'use strict';

//
// How a text filter ($expand filter=...) matches: the one set of rules every provider uses
//

/**
 * Every provider's text search follows these rules, whether it searches in memory (SNOMED CT,
 * code systems from packages, supplements) or in a database (LOINC, RxNorm, ICD-11):
 *
 * - **Words.** A text is folded (lower case; accents dropped from Latin, Greek and Cyrillic
 *   letters, where they are accents, but kept in other scripts, where marks are part of how a
 *   word is spelt) and split into words: runs of letters, marks and digits (Unicode).
 * - **Stems.** Each word is stemmed with the best stemmer there is for the language of the text
 *   (stemmerFor). A language without one isn't stemmed: a word is its own stem.
 * - **The filter.** The filter's words (from its first MAX_TEXT characters, at most MAX_WORDS of
 *   them, each once), without the stop words (STOP_WORDS, as SNOMED CT has always had them),
 *   unless that leaves none. The filter is stemmed in the language being searched.
 * - **A name matches** when every word of the filter matches a word of the name: the name's
 *   word starts with it, or has the same stem. A filter word of a single letter or digit only
 *   matches that word ("hepatitis b" doesn't find "hepatitis c"). All the words have to be in
 *   one name (a display, or one designation), not spread over several.
 * - **A code matches** when it starts with the whole filter, as given (trimmed), without regard
 *   to case: a straight left match - not split into words, stemmed or folded. People search by
 *   code too.
 *
 * A database keeps, for each name, its words and its stems (indexColumns) in an FTS5 table
 * (createTextIndexSql) whose tokenizer only splits on spaces as the words are already made
 * here, and is queried with ftsQuery: so the stemming is done here, once, the same way for
 * every provider, and SQLite only looks the words up.
 *
 * @module tx/library/text-match
 */

const natural = require('natural/lib/natural/stemmers'); // just the stemmers: the package index also loads its storage backends, and dotenv with them

// Only the short function words that make a filter of several words fail to match anything
// when required. Not "with", "without", "no", "not" - those change the meaning of a clinical
// term. In every language (a French "à", folded, is "a" too)
const STOP_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to']);

// how much of a filter takes part
const MAX_TEXT = 100;
const MAX_WORDS = 10;

const WORD_RE = /[\p{L}\p{M}\p{N}]+/gu;
const ACCENTED = /([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu;

// The stemmers, by primary language subtag: the best that the natural package has. A language
// that isn't here isn't stemmed
const STEMMERS = {
  en: natural.PorterStemmer,
  de: natural.PorterStemmerDe,
  es: natural.PorterStemmerEs,
  fa: natural.PorterStemmerFa,
  fr: natural.PorterStemmerFr,
  id: natural.StemmerId,
  it: natural.PorterStemmerIt,
  nb: natural.PorterStemmerNo,
  nl: natural.PorterStemmerNl,
  nn: natural.PorterStemmerNo,
  no: natural.PorterStemmerNo,
  pt: natural.PorterStemmerPt,
  ru: natural.PorterStemmerRu,
  sv: natural.PorterStemmerSv,
  uk: natural.PorterStemmerUk
};

const NO_STEMMER = { stem: (word) => word };

/**
 * The primary language subtag of a language tag or Language (en-US -> en); `fallback` when
 * there is none
 * @param {string|Object|null} tag
 * @param {string} [fallback]
 * @returns {string}
 */
function languageOf(tag, fallback = 'en') {
  const t = tag && typeof tag === 'object' ? (tag.language || tag.code) : tag;
  const s = (typeof t === 'string' && t) ? t : (fallback || 'en');
  const dash = s.indexOf('-');
  return (dash < 0 ? s : s.substring(0, dash)).toLowerCase();
}

/**
 * The stemmer for a language: {stem(word)}
 * @param {string|Object|null} lang - a tag or a Language
 */
function stemmerFor(lang) {
  return STEMMERS[languageOf(lang)] || NO_STEMMER;
}

/**
 * Whether a language has a stemmer
 */
function hasStemmer(lang) {
  return Object.prototype.hasOwnProperty.call(STEMMERS, languageOf(lang));
}

/**
 * A text in lower case without accents (see the module comment)
 * @param {string} text
 * @returns {string}
 */
function fold(text) {
  return String(text ?? '').toLowerCase().normalize('NFD').replace(ACCENTED, '$1').normalize('NFC');
}

/**
 * The words of a text, folded
 * @param {string} text
 * @returns {string[]}
 */
function words(text) {
  return fold(text).match(WORD_RE) || [];
}

/**
 * The stem of a (folded) word in a language
 */
function stem(word, lang) {
  try {
    return stemmerFor(lang).stem(word) || word;
  } catch (e) {
    return word; // a stemmer that can't cope with a word in another script
  }
}

/**
 * A text filter, as the rules above use it
 */
class TextQuery {
  /**
   * @param {string} text - the filter as given
   */
  constructor(text) {
    const raw = String(text ?? '').substring(0, MAX_TEXT);
    // the whole filter, folded, with its white space made single spaces
    this.text = fold(raw).trim().replace(/\s+/g, ' ');
    // the whole filter as given, trimmed, in lower case: a code starts with it
    this.code = String(text ?? '').trim().toLowerCase();
    const all = [...new Set(words(raw))];
    // every word, stop words too: an exact name is all of them
    this.allWords = all;
    const content = all.filter(w => !STOP_WORDS.has(w));
    this.words = (content.length > 0 ? content : all).slice(0, MAX_WORDS);
    this._tokens = new Map(); // language -> tokens
  }

  /** Nothing to search for: everything passes */
  get isNull() {
    return this.text === '';
  }

  /**
   * The words of the filter as searched in a language: {word, stem, whole}. A whole word (a
   * single letter or digit) only matches that word
   * @param {string|Object|null} lang
   */
  tokens(lang) {
    const key = languageOf(lang);
    let tokens = this._tokens.get(key);
    if (!tokens) {
      tokens = this.words.map(word => ({ word, stem: stem(word, key), whole: word.length === 1 }));
      this._tokens.set(key, tokens);
    }
    return tokens;
  }

  /**
   * Whether a code starts with the filter: a straight left match, without regard to case
   * @param {string} code
   */
  codeMatches(code) {
    return this.code !== '' && code != null && String(code).toLowerCase().startsWith(this.code);
  }

  /**
   * Whether a name (a display or designation, in language lang) has every word of the filter
   * @param {string} name
   * @param {string|Object|null} lang
   */
  nameMatches(name, lang) {
    const tokens = this.tokens(lang);
    if (tokens.length === 0 || !name) {
      return false;
    }
    const ws = words(name);
    const key = languageOf(lang);
    let stems = null;
    return tokens.every(t => {
      if (t.whole) {
        return ws.includes(t.word);
      }
      if (ws.some(w => w.startsWith(t.word))) {
        return true;
      }
      stems ??= ws.map(w => stem(w, key));
      return stems.includes(t.stem);
    });
  }

  /**
   * How well a code matches: 100 the code itself, 90 a code it starts; 0 no match
   */
  codeRank(code) {
    if (!this.codeMatches(code)) {
      return 0;
    }
    return String(code).toLowerCase() === this.code ? 100 : 90;
  }

  /**
   * How well a name matches: 0 if it doesn't; else 90 the name is the filter, 50 it starts
   * with the filter, 35 it has the filter's words together and in order, 20 it has them; to the
   * last three, up to 10 for how much of the name the filter is (the shorter the name, the closer
   * the match)
   */
  nameRank(name, lang) {
    if (!this.nameMatches(name, lang)) {
      return 0;
    }
    const n = words(name).join(' ');
    const f = this.allWords.join(' ');
    const share = n.length === 0 ? 0 : Math.min(1, f.length / n.length);
    if (n === f) {
      return 90;
    }
    const base = n.startsWith(f) ? 50 : ((' ' + n).includes(' ' + f) ? 35 : 20);
    return base + 10 * share;
  }

  /**
   * The FTS5 query for a table made by createTextIndexSql, in a language (that of the names
   * searched); null when there are no words to search for
   * @param {string|Object|null} lang
   * @returns {string|null}
   */
  ftsQuery(lang) {
    const tokens = this.tokens(lang);
    if (tokens.length === 0) {
      return null;
    }
    // the words are runs of letters, marks and digits, so there is nothing to escape
    return tokens.map(t => t.whole
      ? `words : "${t.word}"`
      : `(words : "${t.word}"* OR stems : "${t.stem}")`).join(' AND ');
  }

  /**
   * The ranges of codes that start with the filter, for a query on an indexed text column
   * (code >= low AND code < high): the filter as given, in lower case and in upper case (a
   * column compares with regard to case; codes are mostly one case or the other, and people
   * type them in either): [[low, high], ...]; empty if there is no filter
   * @param {string} [original] - the filter as given
   */
  codeRanges(original = null) {
    if (this.code === '') {
      return [];
    }
    const forms = new Set([this.code, this.code.toUpperCase()]);
    if (original) {
      forms.add(String(original).trim());
    }
    return [...forms].filter(f => f).map(f => [f, f + '\u{10FFFF}']);
  }
}

/**
 * The columns of a name in a text index: its words, and its stems in its language, each a
 * string of space separated tokens (distinct)
 * @param {string} name
 * @param {string|Object|null} lang
 * @returns {{words: string, stems: string}}
 */
function indexColumns(name, lang) {
  const ws = [...new Set(words(name))];
  const key = languageOf(lang);
  return { words: ws.join(' '), stems: [...new Set(ws.map(w => stem(w, key)))].join(' ') };
}

// The FTS5 tokenizer of a text index: splits where indexColumns put spaces, and leaves the
// words as they are (they are folded already, so the diacritics option changes nothing)
const TEXT_INDEX_TOKENIZE = `unicode61 remove_diacritics 0 categories 'L* M* N* Co'`;

/**
 * The CREATE statement for a text index: an FTS5 table with the (unindexed) columns given, then
 * words and stems (indexColumns)
 * @param {string} table
 * @param {string[]} columns - kept with each name, not searched (code key, language, type...)
 */
function createTextIndexSql(table, columns) {
  return `CREATE VIRTUAL TABLE ${table} USING fts5(${columns.map(c => c + ' UNINDEXED').join(', ')}, words, stems, tokenize = "${TEXT_INDEX_TOKENIZE}")`;
}

/**
 * Whether a table's CREATE statement (from sqlite_master) is a text index of these rules
 */
function isTextIndexSql(sql) {
  return typeof sql === 'string' && /\bfts5\b/i.test(sql) && /\bstems\b/.test(sql) && sql.includes(TEXT_INDEX_TOKENIZE);
}

/**
 * An in-memory text index, for what is searched in memory: names by language, and codes. Built
 * once (it lets other work run while it builds), then searched in milliseconds
 */
class NameIndex {
  constructor() {
    this._names = []; // [{key, lang, text}] until built
    this._codes = []; // [{key, code}] until built
    this.keys = []; // name id -> key
    this.texts = []; // name id -> text
    this.byLang = new Map(); // language subtag -> {words: string[] sorted, postings: Map(word -> ids), stems: Map(stem -> ids)}
    this.codes = []; // [code in lower case, key] sorted by code
    this.built = false;
  }

  /** A name (a display or designation) of key, in language lang */
  add(key, lang, text) {
    if (text) {
      this._names.push({ key, lang: languageOf(lang), text });
    }
  }

  /** The code of key */
  addCode(key, code) {
    if (code != null && code !== '') {
      this._codes.push({ key, code });
    }
  }

  /** The language subtags it has names in */
  languages() {
    return new Set(this.built ? this.byLang.keys() : this._names.map(n => n.lang));
  }

  /**
   * Build the index, letting other work run every yieldMs
   * @param {number} [yieldMs]
   */
  async build(yieldMs = 25) {
    let last = performance.now();
    const breathe = async () => {
      if (performance.now() - last >= yieldMs) {
        await new Promise(resolve => setImmediate(resolve));
        last = performance.now();
      }
    };
    const names = this._names;
    for (let id = 0; id < names.length; id++) {
      await breathe();
      const { key, lang, text } = names[id];
      this.keys.push(key);
      this.texts.push(text);
      let entry = this.byLang.get(lang);
      if (!entry) {
        entry = { words: null, postings: new Map(), stems: new Map() };
        this.byLang.set(lang, entry);
      }
      const ws = new Set(words(text));
      for (const w of ws) {
        NameIndex.#post(entry.postings, w, id);
      }
      for (const s of new Set([...ws].map(w => stem(w, lang)))) {
        NameIndex.#post(entry.stems, s, id);
      }
    }
    for (const entry of this.byLang.values()) {
      entry.words = [...entry.postings.keys()].sort();
    }
    this.codes = this._codes.map(c => [String(c.code).toLowerCase(), c.key]).sort((a, b) => (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0)));
    this._names = null;
    this._codes = null;
    this.built = true;
    return this;
  }

  static #post(map, token, id) {
    let list = map.get(token);
    if (!list) {
      list = [];
      map.set(token, list);
    }
    if (list[list.length - 1] !== id) {
      list.push(id); // ascending: names are visited in order
    }
  }

  /**
   * The names in language lang that match the query: key -> its matching texts, keys in the
   * order they were added
   * @param {TextQuery} query
   * @param {string|Object|null} lang
   * @returns {Map<*, string[]>}
   */
  searchNames(query, lang) {
    const result = new Map();
    const entry = this.byLang.get(languageOf(lang));
    const tokens = query.tokens(lang);
    if (!entry || tokens.length === 0) {
      return result;
    }
    let ids = null;
    for (const t of tokens) {
      const matching = new Set();
      if (t.whole) {
        for (const id of entry.postings.get(t.word) || []) {
          matching.add(id);
        }
      } else {
        for (let i = lowerBound(entry.words, t.word); i < entry.words.length && entry.words[i].startsWith(t.word); i++) {
          for (const id of entry.postings.get(entry.words[i])) {
            matching.add(id);
          }
        }
        for (const id of entry.stems.get(t.stem) || []) {
          matching.add(id);
        }
      }
      ids = ids === null ? matching : new Set([...ids].filter(id => matching.has(id)));
      if (ids.size === 0) {
        return result;
      }
    }
    for (const id of [...ids].sort((a, b) => a - b)) {
      const key = this.keys[id];
      if (!result.has(key)) {
        result.set(key, []);
      }
      result.get(key).push(this.texts[id]);
    }
    return result;
  }

  /**
   * The keys whose code starts with the filter (TextQuery.codeMatches), in code order
   * @param {TextQuery} query
   * @returns {Array}
   */
  searchCodes(query) {
    const result = [];
    if (query.code === '') {
      return result;
    }
    const codes = this.codes;
    let lo = 0;
    let hi = codes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (codes[mid][0] < query.code) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    for (let i = lo; i < codes.length && codes[i][0].startsWith(query.code); i++) {
      result.push(codes[i][1]);
    }
    return result;
  }
}

// the first index of a sorted array whose value is >= value
function lowerBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

module.exports = {
  STOP_WORDS, MAX_TEXT, MAX_WORDS, TEXT_INDEX_TOKENIZE,
  languageOf, stemmerFor, hasStemmer, fold, words, stem,
  TextQuery, NameIndex, indexColumns, createTextIndexSql, isTextIndexSql, lowerBound
};
