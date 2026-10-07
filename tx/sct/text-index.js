'use strict';

/**
 * In-memory word index for free-text SNOMED CT search ($expand ... filter=).
 *
 * The cache files produced by the Pascal importer carry no words/stems
 * index, and the ones produced by the JS importer carry one keyed on
 * language-specific stems of every description (inactive ones included). So
 * rather than depend on what a given cache happens to hold, the index is
 * built here, in memory, the first time an edition is text-searched:
 *
 *  - every alphanumeric token (Unicode letters and digits, lower-cased,
 *    2+ characters) of every ACTIVE description is a "word"
 *  - words[] is sorted, so a filter token matches every word it is a prefix
 *    of (a user who has typed "radioth" finds "radiotherapy")
 *  - each word is also filed under its Porter stem, so a filter token matches
 *    the other inflections of the same stem ("fractures" finds "fracture")
 *  - postings[w] is the ascending list of concept ORDINALS (reference /
 *    CONCEPT_SIZE) whose active descriptions contain word w
 *  - wordCounts[ordinal] is the number of distinct words the concept has,
 *    used to rank concepts whose terms are mostly the filter above ones where
 *    the filter is a small part of a long term
 *
 * A search requires every (non stop-word) filter token to match somewhere in
 * the concept's active descriptions. For the full International Edition the
 * build takes a few seconds and the index a few tens of MB; it yields to the
 * event loop as it goes, and a search takes milliseconds once it exists.
 */

const natural = require('natural');

const stemmer = natural.PorterStemmer;

// Only the short function words that make a multi-word filter fail to match
// anything when required. Not "with", "without", "no", "not" - those change
// the meaning of a clinical term.
const STOP_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to']);

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

const MIN_WORD_LENGTH = 2;

// How long the build runs before giving the event loop a turn (ms).
const BUILD_SLICE = 20;

// How many of the stem-ranked candidates get the (more expensive)
// description-level ranking.
const RANK_REFINE_LIMIT = 200;

/**
 * Split text into lower-cased word tokens.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text) {
    return [];
  }
  return text.toLowerCase().match(TOKEN_RE) || [];
}

/**
 * The tokens of a filter that the index can search on: 2+ characters, and
 * stop words dropped unless nothing else is left.
 * @param {string} filterText
 * @returns {string[]} distinct tokens, in filter order
 */
function filterTokens(filterText) {
  const tokens = [...new Set(tokenize(filterText))].filter(t => t.length >= MIN_WORD_LENGTH);
  const content = tokens.filter(t => !STOP_WORDS.has(t));
  return content.length > 0 ? content : tokens;
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
   * @returns {Promise<SnomedTextIndex>}
   */
  static async build(sct) {
    const concepts = sct.concepts;
    const conceptSize = concepts.constructor.CONCEPT_SIZE;
    const conceptCount = concepts.count();
    const descMaster = sct.descriptions.master;

    const wordIds = new Map();   // word -> provisional id
    const lists = [];            // provisional id -> number[] of ordinals
    const lastSeen = [];         // provisional id -> last ordinal added
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
        const term = sct.strings.getEntry(descMaster.readUInt32LE(descIndex));
        for (const word of tokenize(term)) {
          if (word.length < MIN_WORD_LENGTH) {
            continue;
          }
          let id = wordIds.get(word);
          if (id === undefined) {
            id = lists.length;
            wordIds.set(word, id);
            lists.push([]);
            lastSeen.push(-1);
          }
          if (lastSeen[id] !== ordinal) {
            lastSeen[id] = ordinal;
            lists[id].push(ordinal);
            distinct++;
          }
        }
      }
      wordCounts[ordinal] = Math.min(distinct, 0xFFFF);
    }

    // Final layout: words sorted, postings as typed arrays, stems -> words.
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
      const stem = stemmer.stem(word);
      let ids = stemWords.get(stem);
      if (!ids) {
        ids = [];
        stemWords.set(stem, ids);
      }
      ids.push(i);
    }
    return new SnomedTextIndex(words, postings, stemWords, wordCounts, conceptSize);
  }

  /**
   * The ids of the words a filter token matches.
   *
   * A token always matches the words that share its stem ("fractures" finds
   * "fracture"). Only the LAST token of the filter also matches the words it
   * is a prefix of - that one may be a word the user is still typing
   * ("radioth" -> "radiotherapy"), whereas treating a completed word as a
   * prefix matches unrelated terms ("anal" -> "analog").
   *
   * @param {string} token
   * @param {boolean} allowPrefix
   * @returns {number[]}
   */
  wordsFor(token, allowPrefix = false) {
    const ids = new Set();
    let lo = 0;
    let hi = this.words.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.words[mid] < token) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (allowPrefix) {
      for (let i = lo; i < this.words.length && this.words[i].startsWith(token); i++) {
        ids.add(i);
      }
    } else if (lo < this.words.length && this.words[lo] === token) {
      ids.add(lo);
    }
    const stemmed = this.stemWords.get(stemmer.stem(token));
    if (stemmed) {
      for (const i of stemmed) {
        ids.add(i);
      }
    }
    return [...ids];
  }

  /**
   * Concept ordinals whose active descriptions match every token.
   * @param {string[]} tokens - from filterTokens()
   * @param {object} [opContext] - for deadCheck
   * @returns {number[]} ascending ordinals
   */
  search(tokens, opContext = null) {
    // Deliberately synchronous: the scratch bitmap below is shared by every
    // search on this edition, so nothing may interleave with it.
    if (tokens.length === 0) {
      return [];
    }
    const perToken = tokens.map((token, i) => {
      const ids = this.wordsFor(token, i === tokens.length - 1);
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
 * Coarse rank for all: the share of the concept's words that the filter
 * accounts for (a concept whose terms are just "appendicitis" beats one that
 * mentions it in passing). The top RANK_REFINE_LIMIT are then checked
 * against their active description terms: exact term 100, term starting with
 * the filter 50, all filter tokens within a single description 30, else 10 -
 * plus the coarse share as a tie-break.
 *
 * @param {object} sct - SnomedServices
 * @param {SnomedTextIndex} index
 * @param {number[]} ordinals
 * @param {string} filterText - lower-cased, trimmed filter
 * @param {string[]} tokens
 * @param {boolean} includeInactive
 * @returns {{index:number, term:bigint, priority:number}[]}
 */
function rankMatches(sct, index, ordinals, filterText, tokens, includeInactive) {
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

  // Coarse rank: the share of the concept's distinct words that the filter
  // accounts for - a concept whose terms are little more than the filter
  // beats one that mentions it in passing. Since the filter is fixed, that
  // share is decided by the concept's word count, so the best
  // RANK_REFINE_LIMIT are picked by counting sort on the word count rather
  // than by sorting every match.
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

  const normalizedFilter = tokenize(filterText).join(' ');
  const tokenStems = tokens.map(t => stemmer.stem(t));
  const descMaster = sct.descriptions.master;
  const scored = head.map(ordinal => {
    const reference = ordinal * size;
    const entry = {
      index: reference,
      ordinal,
      base: 10,
      termLength: Number.MAX_SAFE_INTEGER,
      share: Math.min(1, tokens.length / (wordCounts[ordinal] || 1))
    };
    const descriptionsRef = sct.concepts.getDescriptions(reference);
    if (!descriptionsRef) {
      return entry;
    }
    for (const descIndex of sct.refs.getReferences(descriptionsRef)) {
      if (descMaster.readUInt8(descIndex + 4) === 0) {
        continue;
      }
      const termTokens = tokenize(sct.strings.getEntry(descMaster.readUInt32LE(descIndex)));
      const normalizedTerm = termTokens.join(' ');
      let base;
      if (normalizedTerm === normalizedFilter) {
        base = 100;
      } else if (normalizedTerm.startsWith(normalizedFilter)) {
        base = 50;
      } else if (tokenStems.every((stem, t) => termTokens.some(w => w === tokens[t] || stemmer.stem(w) === stem))) {
        base = 30;
      } else {
        continue;
      }
      // Best term wins; between equally good terms, the shorter one - it is
      // the more specific match ("Diabetes mellitus" over "Diabetes mellitus
      // screening declined").
      if (base > entry.base || (base === entry.base && normalizedTerm.length < entry.termLength)) {
        entry.base = base;
        entry.termLength = normalizedTerm.length;
      }
    }
    return entry;
  });

  scored.sort((a, b) =>
      b.base - a.base ||
      a.termLength - b.termLength ||
      b.share - a.share ||
      a.ordinal - b.ordinal);

  const matches = new Array(scored.length + tail.length);
  let at = 0;
  for (const entry of scored) {
    matches[at++] = {
      index: entry.index,
      term: sct.concepts.getConceptId(entry.index),
      priority: entry.base + entry.share
    };
  }
  // Everything else keeps concept order: these are the matches whose terms are
  // long enough that the filter is a small part of them, and ranking them
  // against each other would cost a pass over the whole match set for a
  // difference no caller sees (count/offset paging stops long before).
  for (const ordinal of tail) {
    const reference = ordinal * size;
    matches[at++] = {
      index: reference,
      term: sct.concepts.getConceptId(reference),
      priority: 10
    };
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
