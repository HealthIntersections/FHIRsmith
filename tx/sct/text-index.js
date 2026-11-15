'use strict';

/**
 * In-memory word index for free-text SNOMED CT search ($expand ... filter=).
 *
 * The cache files produced by the Pascal importer carry no words/stems
 * index, and the ones produced by the JS importer carry one keyed on
 * language-specific stems of every description (inactive ones included). So
 * rather than depend on what a given cache happens to hold, the index is
 * built here, in memory, the first time an edition is text-searched.
 *
 * It follows the rules every provider's text search follows (text-match.js):
 *
 *  - every word (text-match words: folded, Unicode letters, marks and digits)
 *    of every ACTIVE description is a "word"
 *  - words[] is sorted, so a filter word matches every word it is the start
 *    of (a user who has typed "radioth" finds "radiotherapy"); a filter word
 *    of a single letter or digit only matches that word
 *  - each word is also filed under its stem, in the language of the
 *    descriptions it is in, so a filter word matches the other inflections of
 *    the same stem ("fractures" finds "fracture")
 *  - postings[w] is the ascending list of concept ORDINALS (reference /
 *    CONCEPT_SIZE) whose active descriptions contain word w
 *  - wordCounts[ordinal] is the number of distinct words the concept has,
 *    used to rank concepts whose terms are mostly the filter above ones where
 *    the filter is a small part of a long term
 *
 * The index finds the concepts with every filter word (stop words aside)
 * somewhere in their active descriptions; rankMatches then keeps those with
 * every word in one description (one name), as the rules have it. For the
 * full International Edition the build takes a few seconds and the index a
 * few tens of MB; it yields to the event loop as it goes, and a search takes
 * milliseconds once it exists.
 */

const { words: textWords, stem: stemOf, TextQuery, STOP_WORDS } = require('../library/text-match');

// How long the build runs before giving the event loop a turn (ms).
const BUILD_SLICE = 20;

// How many of the stem-ranked candidates of a one-word filter get the (more
// expensive) description-level ranking.
const RANK_REFINE_LIMIT = 200;

/**
 * Split text into words (text-match.js).
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return text ? textWords(text) : [];
}

/**
 * The words of a filter that the index searches on (TextQuery: stop words
 * dropped unless nothing else is left; each once)
 * @param {string} filterText
 * @returns {string[]} distinct words, in filter order
 */
function filterTokens(filterText) {
  return new TextQuery(filterText).words;
}

function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

class SnomedTextIndex {
  constructor(words, postings, stemWords, wordCounts, conceptSize) {
    this.words = words;           // sorted string[]
    this.postings = postings;     // Uint32Array[] parallel to words
    this.stemWords = stemWords;   // Map stem -> word ids (number[])
    this.wordCounts = wordCounts; // Uint16Array by concept ordinal
    this.conceptSize = conceptSize;
    this.scratch = new Uint8Array(wordCounts.length);
  }

  /**
   * Build the index for a loaded edition. Yields to the event loop every
   * BUILD_SLICE ms of work.
   * @param {object} sct - SnomedServices
   * @param {number|null} lang - only descriptions in this language (byte), or null for all
   * @param {Object<number, string>} [languageCodes] - language byte -> code, for the stemmers
   * @returns {Promise<SnomedTextIndex>}
   */
  static async build(sct, lang = null, languageCodes = {}) {
    const concepts = sct.concepts;
    const conceptSize = concepts.constructor.CONCEPT_SIZE;
    const conceptCount = concepts.count();
    const descMaster = sct.descriptions.master;

    const wordIds = new Map();   // word -> provisional id
    const lists = [];            // provisional id -> number[] of ordinals
    const lastSeen = [];         // provisional id -> last ordinal added
    const langMasks = [];        // provisional id -> bit mask of the language bytes it is in
    const wordCounts = new Uint16Array(conceptCount);

    let sliceStart = performance.now();
    for (let ordinal = 0; ordinal < conceptCount; ordinal++) {
      if ((ordinal & 0xFF) === 0 && performance.now() - sliceStart >= BUILD_SLICE) {
        await yieldToEventLoop();
        sliceStart = performance.now();
      }
      const descriptionsRef = concepts.getDescriptions(ordinal * conceptSize);
      if (descriptionsRef === 0) {
        continue;
      }
      let distinct = 0;
      for (const descIndex of sct.refs.getReferences(descriptionsRef)) {
        if (descMaster.readUInt8(descIndex + 4) === 0) {
          continue; // inactive description
        }
        const descLang = descMaster.readUInt8(descIndex + 31);
        if (lang !== null && descLang !== lang) {
          continue; // another language
        }
        const term = sct.strings.getEntry(descMaster.readUInt32LE(descIndex));
        for (const word of tokenize(term)) {
          let id = wordIds.get(word);
          if (id === undefined) {
            id = lists.length;
            wordIds.set(word, id);
            lists.push([]);
            lastSeen.push(-1);
            langMasks.push(0);
          }
          langMasks[id] |= 1 << (descLang & 31);
          if (lastSeen[id] !== ordinal) {
            lastSeen[id] = ordinal;
            lists[id].push(ordinal);
            distinct++;
          }
        }
      }
      wordCounts[ordinal] = Math.min(distinct, 0xFFFF);
    }

    // Final layout: words sorted, postings as typed arrays, stems -> words
    // (each word under its stem in each language it is in).
    const words = [...wordIds.keys()].sort();
    const postings = new Array(words.length);
    const stemWords = new Map();
    sliceStart = performance.now();
    for (let i = 0; i < words.length; i++) {
      if ((i & 0xFF) === 0 && performance.now() - sliceStart >= BUILD_SLICE) {
        await yieldToEventLoop();
        sliceStart = performance.now();
      }
      const word = words[i];
      const id = wordIds.get(word);
      postings[i] = Uint32Array.from(lists[id]);
      lists[id] = null;
      const stems = new Set();
      for (let b = 0; b < 32; b++) {
        if (langMasks[id] & (1 << b)) {
          stems.add(stemOf(word, languageCodes[b] || 'en'));
        }
      }
      for (const stem of stems) {
        let ids = stemWords.get(stem);
        if (!ids) {
          ids = [];
          stemWords.set(stem, ids);
        }
        ids.push(i);
      }
    }
    return new SnomedTextIndex(words, postings, stemWords, wordCounts, conceptSize);
  }

  /**
   * The ids of the words a filter word matches: the words it is the start of,
   * and those with its stem; only the word itself for a single letter or digit
   *
   * @param {{word: string, stem: string, whole: boolean}} token - from TextQuery.tokens
   * @returns {number[]}
   */
  wordsFor(token) {
    const ids = new Set();
    let lo = 0;
    let hi = this.words.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.words[mid] < token.word) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (token.whole) {
      if (lo < this.words.length && this.words[lo] === token.word) {
        ids.add(lo);
      }
      return [...ids];
    }
    for (let i = lo; i < this.words.length && this.words[i].startsWith(token.word); i++) {
      ids.add(i);
    }
    const stemmed = this.stemWords.get(token.stem);
    if (stemmed) {
      for (const i of stemmed) {
        ids.add(i);
      }
    }
    return [...ids];
  }

  /**
   * Concept ordinals whose active descriptions match every filter word.
   * @param {{word: string, stem: string, whole: boolean}[]} tokens - from TextQuery.tokens
   * @param {object} [opContext] - for deadCheck
   * @returns {number[]} ascending ordinals
   */
  search(tokens, opContext = null) {
    // Deliberately synchronous: the scratch bitmap below is shared by every
    // search on this edition, so nothing may interleave with it.
    if (tokens.length === 0) {
      return [];
    }
    const perToken = tokens.map(token => {
      const ids = this.wordsFor(token);
      let size = 0;
      for (const id of ids) {
        size += this.postings[id].length;
      }
      return { ids, size };
    });
    perToken.sort((a, b) => a.size - b.size);
    if (perToken[0].size === 0) {
      return [];
    }

    const mark = this.scratch;
    // Candidates: the union for the rarest token.
    let candidates;
    const first = perToken[0].ids;
    if (first.length === 1) {
      candidates = Array.from(this.postings[first[0]]);
    } else {
      mark.fill(0);
      for (const id of first) {
        for (const ordinal of this.postings[id]) {
          mark[ordinal] = 1;
        }
      }
      candidates = [];
      for (let o = 0; o < mark.length; o++) {
        if (mark[o]) {
          candidates.push(o);
        }
      }
    }

    // Narrow by each further token.
    for (let t = 1; t < perToken.length && candidates.length > 0; t++) {
      if (opContext) {
        opContext.deadCheck('sct:textIndex');
      }
      mark.fill(0);
      for (const id of perToken[t].ids) {
        for (const ordinal of this.postings[id]) {
          mark[ordinal] = 1;
        }
      }
      candidates = candidates.filter(o => mark[o] === 1);
    }
    return candidates;
  }
}

/**
 * Rank the matched concepts and turn them into SnomedFilterContext matches.
 *
 * Each concept is rated by its best active description in the language
 * searched (TextQuery.nameRank: the term itself, a term that starts with the
 * filter, one that has it, one that has its words; shorter terms first). A
 * filter of several words has to have all of them in one description, so
 * every candidate is checked, and those without such a description are
 * dropped.
 *
 * A filter of one word can match 100k+ concepts, and any description with the
 * word is a match, so only the best RANK_REFINE_LIMIT by a coarse rank (the
 * share of the concept's words that the filter accounts for: a concept whose
 * terms are just "appendicitis" beats one that mentions it in passing) are
 * rated by their descriptions; the rest follow, in concept order.
 *
 * @param {object} sct - SnomedServices
 * @param {SnomedTextIndex} index
 * @param {number[]} ordinals
 * @param {TextQuery} query
 * @param {string} langCode - the language searched (for the stemmer)
 * @param {number|null} lang - the description language byte searched, or null for all
 * @param {boolean} includeInactive
 * @param {object} [opContext] - for checkAndYield
 * @returns {Promise<{index:number, term:bigint, priority:number}[]>}
 */
async function rankMatches(sct, index, ordinals, query, langCode, lang, includeInactive, opContext = null) {
  const size = index.conceptSize;
  const conceptMaster = sct.concepts.master;
  const wordCounts = index.wordCounts;

  // Active concepts only (unless asked otherwise). The flags byte is read
  // straight from the concept record: getConcept() builds an object per
  // concept, and a one-word filter can match 100k+ of them.
  const kept = [];
  for (const ordinal of ordinals) {
    if (!includeInactive && (conceptMaster.readUInt8(ordinal * size + 8) & 0x0F) !== 0) {
      continue;
    }
    kept.push(ordinal);
  }
  if (kept.length === 0) {
    return [];
  }

  const descMaster = sct.descriptions.master;
  const rate = (ordinal) => {
    const reference = ordinal * size;
    const entry = { index: reference, ordinal, base: 0 };
    const descriptionsRef = sct.concepts.getDescriptions(reference);
    if (!descriptionsRef) {
      return entry;
    }
    for (const descIndex of sct.refs.getReferences(descriptionsRef)) {
      if (descMaster.readUInt8(descIndex + 4) === 0) {
        continue;
      }
      if (lang !== null && descMaster.readUInt8(descIndex + 31) !== lang) {
        continue;
      }
      const base = query.nameRank(sct.strings.getEntry(descMaster.readUInt32LE(descIndex)), langCode);
      if (base > entry.base) {
        entry.base = base;
      }
    }
    return entry;
  };
  const byRank = (a, b) => b.base - a.base || a.ordinal - b.ordinal;
  const toMatch = (entry) => ({
    index: entry.index,
    term: sct.concepts.getConceptId(entry.index),
    priority: entry.base
  });

  if (query.tokens(langCode).length > 1) {
    // every word in one description: each candidate is checked
    const scored = [];
    for (let i = 0; i < kept.length; i++) {
      if (opContext && (i & 0x3FF) === 0x3FF) {
        await opContext.checkAndYield('sct:searchFilter');
      }
      const entry = rate(kept[i]);
      if (entry.base > 0) {
        scored.push(entry);
      }
    }
    scored.sort(byRank);
    return scored.map(toMatch);
  }

  // Coarse rank: the share of the concept's distinct words that the filter
  // accounts for. Since the filter is fixed, that share is decided by the
  // concept's word count, so the best RANK_REFINE_LIMIT are picked by
  // counting sort on the word count rather than by sorting every match.
  const counts = new Map();
  for (const ordinal of kept) {
    const c = wordCounts[ordinal] || 1;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const distinct = [...counts.keys()].sort((a, b) => a - b);
  let cutoff = distinct[distinct.length - 1];
  let running = 0;
  for (const c of distinct) {
    running += counts.get(c);
    if (running >= RANK_REFINE_LIMIT) {
      cutoff = c;
      break;
    }
  }

  const head = [];
  const tail = [];
  for (const ordinal of kept) {
    if ((wordCounts[ordinal] || 1) <= cutoff) {
      head.push(ordinal);
    } else {
      tail.push(ordinal);
    }
  }

  const scored = head.map(rate).map(entry => ({ ...entry, base: Math.max(entry.base, 10) }));
  scored.sort(byRank);

  const matches = scored.map(toMatch);
  // Everything else keeps concept order: these are the matches whose terms are
  // long enough that the filter is a small part of them, and ranking them
  // against each other would cost a pass over the whole match set for a
  // difference no caller sees (count/offset paging stops long before).
  for (const ordinal of tail) {
    const reference = ordinal * size;
    matches.push({
      index: reference,
      term: sct.concepts.getConceptId(reference),
      priority: 10
    });
  }
  return matches;
}

module.exports = {
  SnomedTextIndex,
  rankMatches,
  filterTokens,
  tokenize,
  STOP_WORDS
};
