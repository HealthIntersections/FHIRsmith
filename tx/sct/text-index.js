'use strict';

/**
 * Word index for free-text SNOMED CT search ($expand ... filter=, and ECL term filters).
 *
 * The importer builds it and the cache file carries it (cache format 21): one index for all
 * the edition's languages and, when it has descriptions in more than one, one for each. The
 * server reads them where they are in the cache file (memory-mapped, or read) - nothing is
 * built when the cache loads or when it is searched.
 *
 * It follows the rules every provider's text search follows (text-match.js):
 *
 *  - every word (text-match words: folded, Unicode letters, marks and digits)
 *    of every ACTIVE description is a "word"
 *  - words are sorted (by their UTF-8 bytes), so a filter word matches every word it is the
 *    start of (a user who has typed "radioth" finds "radiotherapy"); a filter word
 *    of a single letter or digit only matches that word
 *  - each word is also filed under its stem, in the language of the
 *    descriptions it is in, so a filter word matches the other inflections of
 *    the same stem ("fractures" finds "fracture")
 *  - postings(w) is the ascending list of concept ORDINALS (reference /
 *    CONCEPT_SIZE) whose active descriptions contain word w
 *  - wordCounts[ordinal] is the number of distinct words the concept has,
 *    used to rank concepts whose terms are mostly the filter above ones where
 *    the filter is a small part of a long term
 *
 * The index finds the concepts with every filter word (stop words aside)
 * somewhere in their active descriptions; rankMatches then keeps those with
 * every word in one description (one name), as the rules have it. Since the indexes are built
 * at import, a change to what decides the words or stems (text-match.js) means a new
 * TEXT_INDEX_VERSION, and every edition imported again.
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

// The version of the text index layout and of the rules that built it (tokenizing, folding,
// stemming - text-match.js). The importer writes it with the indexes; a cache whose indexes
// say another version is refused, and has to be imported again. Change it when anything that
// decides which words or stems an index holds changes.
const TEXT_INDEX_VERSION = 1;

// SnomedTextIndexes.lang for the index of every language
const ALL_LANGUAGES = 0xFFFFFFFF;

function align(n, to) {
  return (n + to - 1) & ~(to - 1);
}

/**
 * A typed array over buf at rel - a view when it is aligned (a memory-mapped or read cache
 * file: no copy), else a copy
 */
function typedView(Type, buf, rel, length) {
  const at = buf.byteOffset + rel;
  if (at % Type.BYTES_PER_ELEMENT === 0) {
    return new Type(buf.buffer, at, length);
  }
  const copy = new Type(length);
  buf.copy(Buffer.from(copy.buffer), 0, rel, rel + length * Type.BYTES_PER_ELEMENT);
  return copy;
}

/**
 * Strings sorted by their UTF-8 bytes, held as one block of bytes and the offset of each:
 * binary searched without decoding
 */
class SortedStrings {
  constructor(bytes, offsets) {
    this.bytes = bytes;       // Buffer
    this.offsets = offsets;   // Uint32Array, count + 1
  }

  static from(sortedBuffers) {
    const offsets = new Uint32Array(sortedBuffers.length + 1);
    let total = 0;
    for (let i = 0; i < sortedBuffers.length; i++) {
      offsets[i] = total;
      total += sortedBuffers[i].length;
    }
    offsets[sortedBuffers.length] = total;
    return new SortedStrings(Buffer.concat(sortedBuffers, total), offsets);
  }

  get length() {
    return this.offsets.length - 1;
  }

  get(i) {
    return this.bytes.toString('utf8', this.offsets[i], this.offsets[i + 1]);
  }

  // the first i whose string is not below key (a Buffer)
  lowerBound(key) {
    let lo = 0;
    let hi = this.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (key.compare(this.bytes, this.offsets[mid], this.offsets[mid + 1]) > 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  equals(i, key) {
    return this.offsets[i + 1] - this.offsets[i] === key.length &&
      key.compare(this.bytes, this.offsets[i], this.offsets[i + 1]) === 0;
  }

  startsWith(i, key) {
    return this.offsets[i + 1] - this.offsets[i] >= key.length &&
      key.compare(this.bytes, this.offsets[i], this.offsets[i] + key.length) === 0;
  }

  indexOf(key) {
    const i = this.lowerBound(key);
    return i < this.length && this.equals(i, key) ? i : -1;
  }
}

const byBytes = (a, b) => Buffer.compare(a, b);

class SnomedTextIndex {
  /**
   * @param {object} parts
   * @param {SortedStrings} parts.words - every word, sorted by its UTF-8 bytes
   * @param {Uint32Array} parts.postingOffsets - word id -> start in postingData (words + 1)
   * @param {Uint32Array} parts.postingData - concept ordinals, ascending for each word
   * @param {SortedStrings} parts.stems - every stem, sorted by its UTF-8 bytes
   * @param {Uint32Array} parts.stemWordOffsets - stem id -> start in stemWordIds (stems + 1)
   * @param {Uint32Array} parts.stemWordIds - the word ids of each stem
   * @param {Uint16Array} parts.wordCounts - concept ordinal -> distinct words
   * @param {number} parts.conceptSize
   */
  constructor(parts) {
    this.words = parts.words;
    this.postingOffsets = parts.postingOffsets;
    this.postingData = parts.postingData;
    this.stems = parts.stems;
    this.stemWordOffsets = parts.stemWordOffsets;
    this.stemWordIds = parts.stemWordIds;
    this.wordCounts = parts.wordCounts;
    this.conceptSize = parts.conceptSize;
    this.scratch = null; // allocated by the first search
  }

  /** An index with no words (for a language the edition has no descriptions in) */
  static empty(conceptSize) {
    const none = new SortedStrings(Buffer.alloc(0), new Uint32Array(1));
    return new SnomedTextIndex({
      words: none, postingOffsets: new Uint32Array(1), postingData: new Uint32Array(0),
      stems: none, stemWordOffsets: new Uint32Array(1), stemWordIds: new Uint32Array(0),
      wordCounts: new Uint16Array(0), conceptSize
    });
  }

  /** The concept ordinals of the word with this id (ascending) */
  postings(id) {
    return this.postingData.subarray(this.postingOffsets[id], this.postingOffsets[id + 1]);
  }

  /** The ids of the words filed under this stem, or null */
  stemWords(stem) {
    const i = this.stems.indexOf(Buffer.from(stem, 'utf8'));
    return i < 0 ? null : this.stemWordIds.subarray(this.stemWordOffsets[i], this.stemWordOffsets[i + 1]);
  }

  /**
   * Build the index for an edition (the importer does this, and the cache carries it). Yields
   * to the event loop every BUILD_SLICE ms of work.
   * @param {object} sct - what it reads: concepts, refs, descriptions, strings
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

    // Final layout: words sorted by their bytes, postings in one block, stems -> words (each
    // word under its stem in each language it is in)
    const sorted = [...wordIds.keys()].map(word => ({ word, bytes: Buffer.from(word, 'utf8') }));
    sorted.sort((a, b) => byBytes(a.bytes, b.bytes));
    let total = 0;
    for (const { word } of sorted) {
      total += lists[wordIds.get(word)].length;
    }
    const postingOffsets = new Uint32Array(sorted.length + 1);
    const postingData = new Uint32Array(total);
    const stemMap = new Map();
    let at = 0;
    sliceStart = performance.now();
    for (let i = 0; i < sorted.length; i++) {
      if ((i & 0xFF) === 0 && performance.now() - sliceStart >= BUILD_SLICE) {
        await yieldToEventLoop();
        sliceStart = performance.now();
      }
      const id = wordIds.get(sorted[i].word);
      postingOffsets[i] = at;
      postingData.set(lists[id], at);
      at += lists[id].length;
      lists[id] = null;
      const stems = new Set();
      for (let b = 0; b < 32; b++) {
        if (langMasks[id] & (1 << b)) {
          stems.add(stemOf(sorted[i].word, languageCodes[b] || 'en'));
        }
      }
      for (const stem of stems) {
        let ids = stemMap.get(stem);
        if (!ids) {
          ids = [];
          stemMap.set(stem, ids);
        }
        ids.push(i);
      }
    }
    postingOffsets[sorted.length] = at;

    const stemList = [...stemMap.keys()].map(stem => ({ stem, bytes: Buffer.from(stem, 'utf8') }));
    stemList.sort((a, b) => byBytes(a.bytes, b.bytes));
    let stemTotal = 0;
    for (const { stem } of stemList) {
      stemTotal += stemMap.get(stem).length;
    }
    const stemWordOffsets = new Uint32Array(stemList.length + 1);
    const stemWordIds = new Uint32Array(stemTotal);
    at = 0;
    for (let i = 0; i < stemList.length; i++) {
      const ids = stemMap.get(stemList[i].stem);
      stemWordOffsets[i] = at;
      stemWordIds.set(ids, at);
      at += ids.length;
    }
    stemWordOffsets[stemList.length] = at;

    return new SnomedTextIndex({
      words: SortedStrings.from(sorted.map(w => w.bytes)),
      postingOffsets, postingData,
      stems: SortedStrings.from(stemList.map(s => s.bytes)),
      stemWordOffsets, stemWordIds,
      wordCounts, conceptSize
    });
  }

  /**
   * The index as bytes, for the cache file. Every array starts at a multiple of 4 from the
   * start, so where the start is aligned in the file, deserialize reads them in place.
   * @returns {Buffer}
   */
  serialize() {
    const header = [this.conceptSize, this.wordCounts.length, this.words.length, this.stems.length,
      this.postingData.length, this.stemWordIds.length, this.words.bytes.length, this.stems.bytes.length];
    const sections = [
      Buffer.from(new Uint32Array(header).buffer),
      typedBytes(this.words.offsets), typedBytes(this.postingOffsets), typedBytes(this.postingData),
      typedBytes(this.stems.offsets), typedBytes(this.stemWordOffsets), typedBytes(this.stemWordIds),
      typedBytes(this.wordCounts), this.words.bytes, this.stems.bytes
    ];
    const parts = [];
    let length = 0;
    for (const s of sections) {
      parts.push(s);
      length += s.length;
      const pad = align(length, 4) - length;
      if (pad > 0) {
        parts.push(Buffer.alloc(pad));
        length += pad;
      }
    }
    return Buffer.concat(parts, length);
  }

  /**
   * An index from what serialize wrote, over buf (no copy where buf is aligned)
   * @param {Buffer} buf
   * @returns {SnomedTextIndex}
   */
  static deserialize(buf) {
    const h = typedView(Uint32Array, buf, 0, 8);
    const [conceptSize, conceptCount, wordCount, stemCount, postingTotal, stemWordTotal, wordBytes, stemBytes] = h;
    let rel = 32;
    const take = (Type, length) => {
      const view = typedView(Type, buf, rel, length);
      rel = align(rel + length * Type.BYTES_PER_ELEMENT, 4);
      return view;
    };
    const takeBytes = (length) => {
      const view = buf.subarray(rel, rel + length);
      rel = align(rel + length, 4);
      return view;
    };
    const wordOffsets = take(Uint32Array, wordCount + 1);
    const postingOffsets = take(Uint32Array, wordCount + 1);
    const postingData = take(Uint32Array, postingTotal);
    const stemOffsets = take(Uint32Array, stemCount + 1);
    const stemWordOffsets = take(Uint32Array, stemCount + 1);
    const stemWordIds = take(Uint32Array, stemWordTotal);
    const wordCounts = take(Uint16Array, conceptCount);
    const words = new SortedStrings(takeBytes(wordBytes), wordOffsets);
    const stems = new SortedStrings(takeBytes(stemBytes), stemOffsets);
    if (rel > buf.length) {
      throw new Error('SNOMED CT text index is truncated');
    }
    return new SnomedTextIndex({ words, postingOffsets, postingData, stems, stemWordOffsets, stemWordIds, wordCounts, conceptSize });
  }

  /**
   * The ids of the words a filter word matches: the words it is the start of,
   * and those with its stem; only the word itself for a single letter or digit
   *
   * @param {{word: string, stem: string, whole: boolean}} token - from TextQuery.tokens
   * @returns {number[]}
   */
  wordsFor(token) {
    const key = Buffer.from(token.word, 'utf8');
    const ids = new Set();
    const lo = this.words.lowerBound(key);
    if (token.whole) {
      if (lo < this.words.length && this.words.equals(lo, key)) {
        ids.add(lo);
      }
      return [...ids];
    }
    for (let i = lo; i < this.words.length && this.words.startsWith(i, key); i++) {
      ids.add(i);
    }
    const stemmed = token.stem ? this.stemWords(token.stem) : null;
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
        size += this.postingOffsets[id + 1] - this.postingOffsets[id];
      }
      return { ids, size };
    });
    perToken.sort((a, b) => a.size - b.size);
    if (perToken[0].size === 0) {
      return [];
    }

    const mark = this.scratch ??= new Uint8Array(this.wordCounts.length);
    // Candidates: the union for the rarest token.
    let candidates;
    const first = perToken[0].ids;
    if (first.length === 1) {
      candidates = Array.from(this.postings(first[0]));
    } else {
      mark.fill(0);
      for (const id of first) {
        for (const ordinal of this.postings(id)) {
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
        for (const ordinal of this.postings(id)) {
          mark[ordinal] = 1;
        }
      }
      candidates = candidates.filter(o => mark[o] === 1);
    }
    return candidates;
  }
}

function typedBytes(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * The text indexes of an edition, as the cache carries them: one for all its languages, and,
 * when it has descriptions in more than one, one for each; and the languages it has active
 * descriptions in.
 */
class SnomedTextIndexes {
  /**
   * @param {number[]} languages - the language bytes of the active descriptions
   * @param {Map<number|null, SnomedTextIndex>} indexes - null for all languages
   */
  constructor(languages, indexes) {
    this.languages = new Set(languages);
    this.indexes = indexes;
  }

  get all() {
    return this.indexes.get(null) || null;
  }

  /**
   * Build them all for an edition (the importer)
   * @param {object} sct - concepts, refs, descriptions, strings
   * @param {Object<number, string>} languageCodes
   * @param {function(string)} [progress] - told which index is being built
   */
  static async build(sct, languageCodes, progress = () => {}) {
    const languages = [...sct.descriptions.activeLanguages()].sort((a, b) => a - b);
    const indexes = new Map();
    progress('all languages');
    indexes.set(null, await SnomedTextIndex.build(sct, null, languageCodes));
    if (languages.length > 1) {
      for (const lang of languages) {
        progress(languageCodes[lang] || `language ${lang}`);
        indexes.set(lang, await SnomedTextIndex.build(sct, lang, languageCodes));
      }
    }
    return new SnomedTextIndexes(languages, indexes);
  }

  /**
   * As bytes: [version, language count, languages..., index count, (lang, offset, length)...],
   * then each index at a multiple of 8 from the start
   * @returns {Buffer}
   */
  serialize() {
    const entries = [...this.indexes.entries()].map(([lang, index]) => ({ lang, bytes: index.serialize() }));
    const head = [TEXT_INDEX_VERSION, this.languages.size, ...this.languages, entries.length];
    let offset = align((head.length + entries.length * 3) * 4, 8);
    for (const e of entries) {
      e.offset = offset;
      head.push(e.lang === null ? ALL_LANGUAGES : e.lang, offset, e.bytes.length);
      offset = align(offset + e.bytes.length, 8);
    }
    const out = Buffer.alloc(offset);
    Buffer.from(new Uint32Array(head).buffer).copy(out, 0);
    for (const e of entries) {
      e.bytes.copy(out, e.offset);
    }
    return out;
  }

  /**
   * @param {Buffer} buf - what serialize wrote
   * @returns {SnomedTextIndexes}
   */
  static deserialize(buf) {
    const u32 = (i) => buf.readUInt32LE(i * 4);
    const version = u32(0);
    if (version !== TEXT_INDEX_VERSION) {
      throw new Error(`its text indexes are version ${version}, and this server reads version ${TEXT_INDEX_VERSION}`);
    }
    const languageCount = u32(1);
    const languages = [];
    for (let i = 0; i < languageCount; i++) {
      languages.push(u32(2 + i));
    }
    let at = 2 + languageCount;
    const count = u32(at++);
    const indexes = new Map();
    for (let i = 0; i < count; i++) {
      const lang = u32(at++);
      const offset = u32(at++);
      const length = u32(at++);
      indexes.set(lang === ALL_LANGUAGES ? null : lang, SnomedTextIndex.deserialize(buf.subarray(offset, offset + length)));
    }
    return new SnomedTextIndexes(languages, indexes);
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
      if (opContext && (i & 0x3F) === 0x3F) {
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

  // Every concept with the cutoff's word count is in the head, so it can be far more than
  // RANK_REFINE_LIMIT: rating each stems its descriptions, and on tx.fhir.org (2026-11-25)
  // "Penicillin" on the allergy value set held the event loop for 2.5 s here. So it yields
  const scored = [];
  for (let i = 0; i < head.length; i++) {
    if (opContext && (i & 0x3F) === 0x3F) {
      await opContext.checkAndYield('sct:searchFilter');
    }
    const entry = rate(head[i]);
    entry.base = Math.max(entry.base, 10);
    scored.push(entry);
  }
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
  SnomedTextIndexes,
  TEXT_INDEX_VERSION,
  rankMatches,
  filterTokens,
  tokenize,
  STOP_WORDS
};
