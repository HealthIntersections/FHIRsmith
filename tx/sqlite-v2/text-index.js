'use strict';
// $expand filter= (a text filter) as the built-in providers answer it since #398: the rules of
// tx/library/text-match.js (TextQuery, the same code), and each provider's own choice of names,
// code match and order:
//
//   SNOMED CT (cs-snomed.js searchFilter, tx/sct/text-index.js rankMatches)
//     names: the concept's active descriptions in the search language. Codes: an identifier
//     that starts with the filter's digits (the concept itself 100, then the others, in
//     identifier order), first. Then the text matches: a filter of one word, the
//     RANK_REFINE_LIMIT concepts with the fewest distinct words (all of them tied at the cut)
//     by their best description (TextQuery.nameRank, at least 10), the rest in concept order; a
//     filter of several words, every concept with a description that has all of them, by its
//     best description. Ties by concept order.
//   LOINC (cs-loinc.js searchFilter with TextIndex, tx/importers/loinc-text-index.js)
//     names: in English the display and every English description, in another language its
//     descriptions; never RELATEDNAMES2. The codes in TextQuery.codeRanges (codeRank) and the
//     concepts with a name that ranks (TextQuery.nameRank of the name as the index holds it:
//     its distinct words, indexedName), each by its best; the best first (#399), then by display
//     (String.localeCompare), then the file's concept order (CodeKey).
//   RxNorm (cs-rxnorm.js #textSearchFilter and #rank, tx/importers/rxnorm-text-index.js)
//     names: every RXNORM atom of the concept, in English. A name match or a code in
//     TextQuery.codeRanges, among the concepts with an RXNCONSO atom other than SY; the best
//     first (nameRank of the best name, as for LOINC, or codeRank), then in RXCUI order (as text).
//
// The searches are generators with a bare yield at their pause points (engine/evaluate.js):
// ranking a broad filter's names takes seconds (most of it stemming, in TextQuery.nameRank), as
// in the built-in providers, which let other work run while they rank (bestRanks).
//   anything else (cs-cs.js searchFilter): see contentTextSearch.
//
// Which concepts have a name with a word is a word index, one per language (primary subtag) of
// the names: ix_word(lang, word, stem, ids), every word (text-match words: folded letters, marks
// and digits) with its stem in that language and the concepts that have it (portable Roaring
// bitmap of concept ids), and for SNOMED CT the row with word '', the distinct words of each
// concept (Uint16 by concept id). A filter word matches the words it is the start of and those
// with its stem, a single letter or digit only itself; a filter of several words is then checked
// name by name (TextQuery.nameMatches), as every word has to be in one name.
//
// The index builder writes it (tx/importers/sqlite-v2/indexes.js), with meta 'ix.ix_word.format'
// naming the rules it was made by (FORMAT); a file without one made by these rules has it built in
// memory on the first search, as the built-in providers do.

const { RoaringBitmap32 } = require('roaring');
const { TextQuery, words: textWords, stem: stemOf, languageOf } = require('../library/text-match');

const FORMAT = 'text-match/1';
const RANK_REFINE_LIMIT = 200;
const SEARCH_CACHE = 8;
// pause points (evaluate.js runAsync): concepts whose names are read and ranked per statement,
// comparisons per sort step, concepts rated, and concept rows read per statement (blockConcepts)
const NAMES_CHUNK = 500;
const SORT_CHUNK = 20000;
const RATE_CHUNK = 2000;
const ROW_CHUNK = 20000;
// blockConcepts yields this between its chunks, for rateConceptsG to pause at
const PAUSE = Symbol('pause');
const MAX = '\u{10FFFF}';

function primaryLanguage(code, defLang) {
  return languageOf(code || null, defLang || 'en');
}

// ---- the names ------------------------------------------------------------------------------

/** the RELATEDNAMES2 item use (LOINC: never a searched name), or -1 */
function relatedUse(store) {
  if (store._relatedUse === undefined) {
    store._relatedUse = -1;
    for (const [id, u] of store.uses) if (u.code === 'RELATEDNAMES2') store._relatedUse = id;
  }
  return store._relatedUse;
}

/** fn(id, lang, term) for every name the system's search reads, in concept order (one statement) */
function eachSearchName(store, dialect, fn) {
  const db = store.db;
  const defLang = store.defaultLanguage || 'en';
  if (dialect === 'snomed') {
    for (const [id, language, term] of db.prepare('SELECT concept_id, language, text FROM main.item WHERE active = 1 AND cs_id = ? AND (kind = 0 OR use_id IS NOT NULL) ORDER BY concept_id').raw().iterate(store.csId)) {
      fn(id, primaryLanguage(language, defLang), term);
    }
  } else if (dialect === 'loinc') {
    const q = db.prepare(`SELECT id, NULL, display FROM main.concept WHERE display IS NOT NULL AND display <> ''
      UNION ALL SELECT concept_id, coalesce(language, @def), text FROM main.item WHERE cs_id = @cs AND use_id IS NOT @rel AND text <> '' ORDER BY 1`).raw();
    for (const [id, language, term] of q.iterate({ def: defLang, rel: relatedUse(store), cs: store.csId })) fn(id, language == null ? 'en' : primaryLanguage(language, defLang), term);
  } else if (dialect === 'rxnorm') {
    // the concepts in RXNCONSO (a SUPPRESS literal), as cs-rxnorm.js searches only those
    const sup = store.props.get('SUPPRESS');
    const q = sup
      ? db.prepare('SELECT concept_id, text FROM main.item WHERE cs_id = ? AND concept_id IN (SELECT DISTINCT subject_id FROM main.literal WHERE property_id = ? AND subject_id <= ?) ORDER BY concept_id').raw()
      : db.prepare('SELECT concept_id, text FROM main.item WHERE cs_id = ? ORDER BY concept_id').raw();
    for (const [id, term] of (sup ? q.iterate(store.csId, sup.id, store.hi) : q.iterate(store.csId))) fn(id, 'en', term);
  }
}

/** fn(id, lang, term) for the names of some concepts the system's search reads; the rows read */
function searchNamesOf(store, dialect, ids, fn) {
  const def = store.defaultLanguage || 'en';
  const j = JSON.stringify(ids);
  let rows = 0;
  if (dialect === 'snomed') {
    for (const [id, language, term] of store.stmt('SELECT concept_id, language, text FROM main.item WHERE concept_id IN (SELECT value FROM json_each(?)) AND active = 1 AND cs_id = +? AND (kind = 0 OR use_id IS NOT NULL) ORDER BY id').raw().iterate(j, store.csId)) {
      rows++;
      fn(id, primaryLanguage(language, def), term);
    }
  } else if (dialect === 'loinc') {
    for (const [id, display] of store.stmt("SELECT id, display FROM main.concept WHERE id IN (SELECT value FROM json_each(?)) AND display IS NOT NULL AND display <> ''").raw().iterate(j)) {
      rows++;
      fn(id, 'en', display);
    }
    for (const [id, language, term] of store.stmt('SELECT concept_id, language, text FROM main.item WHERE concept_id IN (SELECT value FROM json_each(?)) AND cs_id = +? AND use_id IS NOT ?').raw().iterate(j, store.csId, relatedUse(store))) {
      rows++;
      fn(id, primaryLanguage(language, def), term);
    }
  } else {
    for (const [id, term] of store.stmt('SELECT concept_id, text FROM main.item WHERE concept_id IN (SELECT value FROM json_each(?)) AND cs_id = +?').raw().iterate(j, store.csId)) {
      rows++;
      fn(id, 'en', term);
    }
  }
  return rows;
}


/** the dialects with a word index */
function indexed(dialect) {
  return dialect === 'snomed' || dialect === 'loinc' || dialect === 'rxnorm';
}

/**
 * The index of a list of names: each(fn) calls fn(id, lang, term) in id order.
 * @returns {Map<string, {words: Map<string, number[]>, counts: Uint16Array|null}>} by language
 */
function computeTextIndexFrom(each, dialect, n) {
  const byLang = new Map();
  const counting = dialect === 'snomed';
  const of = (lang) => {
    let x = byLang.get(lang);
    if (!x) {
      x = { words: new Map(), counts: counting ? new Uint16Array(n + 1) : null };
      byLang.set(lang, x);
    }
    return x;
  };
  each((id, lang, term) => {
    const x = of(lang);
    for (const w of textWords(term)) {
      let list = x.words.get(w);
      if (!list) { list = []; x.words.set(w, list); }
      if (list[list.length - 1] !== id) {
        list.push(id);
        if (counting && x.counts[id] < 0xFFFF) x.counts[id]++;
      }
    }
  });
  return byLang;
}

// ---- reading the index ------------------------------------------------------------------------

/** the word index the index builder stored (ix_word) */
class WordIndex {
  constructor(store) {
    this.store = store;
    this.langs = new Set(store.db.prepare("SELECT DISTINCT lang FROM main.ix_word WHERE word <> ''").pluck().all());
    this._counts = new Map();
  }

  counts(lang) {
    let c = this._counts.get(lang);
    if (!c) {
      const b = this.store.stmt("SELECT ids FROM main.ix_word WHERE lang = ? AND word = ''").pluck().get(lang);
      c = b ? new Uint16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : new Uint16Array(0);
      this._counts.set(lang, c);
    }
    return c;
  }

  /** the languages with per-concept counts (every language of the names, where counts are kept), or null */
  languages() {
    const l = this.store.db.prepare("SELECT lang FROM main.ix_word WHERE word = ''").pluck().all();
    return l.length ? l : null;
  }

  conceptsFor(lang, token, stats) {
    const rows = token.whole
      ? this.store.stmt('SELECT ids FROM main.ix_word WHERE lang = ? AND word = ?').pluck().all(lang, token.word)
      : this.store.stmt(`SELECT ids FROM main.ix_word WHERE lang = @lang AND word >= @w AND word < @hi
          UNION ALL SELECT ids FROM main.ix_word WHERE lang = @lang AND stem = @stem AND word <> '' AND NOT (word >= @w AND word < @hi)`)
        .pluck().all({ lang, w: token.word, hi: token.word + MAX, stem: token.stem });
    if (stats) { stats.statements++; stats.rows += rows.length; }
    const bm = new RoaringBitmap32();
    for (const b of rows) bm.orInPlace(RoaringBitmap32.deserialize(b, 'portable'));
    return bm;
  }

  bytes() {
    let n = 0;
    for (const c of this._counts.values()) n += c.byteLength;
    return n;
  }

  close() {}
}

/** a file without a stored index: built in memory on its first search, as the built-in providers do */
class MemoryTextIndex {
  constructor(byLang) {
    this.langs = new Set(byLang.keys());
    this._byLang = new Map();
    for (const [lang, x] of byLang) {
      const words = [...x.words.keys()].sort();
      const postings = words.map((w) => Uint32Array.from(x.words.get(w)));
      const stems = new Map();
      words.forEach((w, i) => {
        const s = stemOf(w, lang);
        if (!stems.has(s)) stems.set(s, []);
        stems.get(s).push(i);
      });
      this._byLang.set(lang, { words, postings, stems, counts: x.counts || new Uint16Array(0) });
    }
  }

  counts(lang) { const x = this._byLang.get(lang); return x ? x.counts : new Uint16Array(0); }

  conceptsFor(lang, token) {
    const x = this._byLang.get(lang);
    const bm = new RoaringBitmap32();
    if (!x) return bm;
    let lo = 0, hi = x.words.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (x.words[mid] < token.word) lo = mid + 1; else hi = mid; }
    const ids = new Set();
    if (token.whole) {
      if (lo < x.words.length && x.words[lo] === token.word) ids.add(lo);
    } else {
      for (let i = lo; i < x.words.length && x.words[i].startsWith(token.word); i++) ids.add(i);
      for (const i of x.stems.get(token.stem) || []) ids.add(i);
    }
    for (const i of ids) bm.addMany(x.postings[i]);
    return bm;
  }

  bytes() {
    let n = 0;
    for (const x of this._byLang.values()) {
      n += x.counts.byteLength;
      for (const p of x.postings) n += p.byteLength;
    }
    return n;
  }

  close() {}
}

/** the file's index: stored in the file, else built in memory now */
function textIndexOf(store, dialect) {
  const stored = store.textIndex();
  if (stored) return stored;
  // built in memory, for the names of the dialect asked for (a file serves one)
  const built = store._textIndexBuilt || (store._textIndexBuilt = new Map());
  if (!built.has(dialect)) {
    built.set(dialect, new MemoryTextIndex(store.withoutMmap(() => computeTextIndexFrom((fn) => store.eachSearchName(dialect, fn), dialect, store.conceptCount))));
  }
  return built.get(dialect);
}

/** the concepts with a word for each token (before checking that they are in one name) */
function* candidates(index, lang, tokens, stats) {
  let bm = null;
  for (let i = 0; i < tokens.length && (!bm || bm.size); i++) {
    if (i) yield;
    const t = index.conceptsFor(lang, tokens[i], stats);
    bm = bm ? bm.andInPlace(t) : t;
  }
  return bm || new RoaringBitmap32();
}

/** fn(id, lang, term) for the names of some concepts the built-in provider searches (the store's searchNames) */
function namesOf(store, dialect, ids, stats, fn) {
  if (!ids.length) return;
  const rows = store.searchNames(dialect, ids, fn);
  if (stats) { stats.statements++; stats.rows += rows; }
}

/**
 * namesOf for many concepts, NAMES_CHUNK at a time, pausing (a bare yield: evaluate.js runAsync)
 * between them: ranking a broad filter's names (TextQuery.nameRank, stemming each word) takes
 * seconds, as it does in the built-in providers (bestRanks, which lets other work run every 20 ms)
 */
function* namesOfG(store, dialect, ids, stats, fn) {
  for (let i = 0; i < ids.length; i += NAMES_CHUNK) {
    if (i) yield;
    namesOf(store, dialect, ids.slice(i, i + NAMES_CHUNK), stats, fn);
  }
}

/** the candidates with a name (in lang) that has every word of the filter */
function* inOneName(store, dialect, bm, q, lang, stats) {
  const ok = new RoaringBitmap32();
  yield* namesOfG(store, dialect, bm.toArray(), stats, (id, l, term) => {
    if (l === lang && !ok.has(id) && q.nameMatches(term, lang)) ok.add(id);
  });
  return ok;
}

/** a generator straight through (the sync API) */
function runSync(g) {
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

/**
 * A sort that pauses: merge sort (stable, as Array.prototype.sort), a bare yield every
 * SORT_CHUNK comparisons. A broad LOINC filter sorts ~100,000 matches by String.localeCompare
 */
function* sortG(arr, cmp) {
  let a = arr.slice();
  let b = new Array(a.length);
  let n = 0;
  for (let w = 1; w < a.length; w *= 2) {
    for (let lo = 0; lo < a.length; lo += 2 * w) {
      const mid = Math.min(lo + w, a.length);
      const hi = Math.min(lo + 2 * w, a.length);
      let i = lo, j = mid, k = lo;
      while (i < mid && j < hi) {
        b[k++] = cmp(a[j], a[i]) < 0 ? a[j++] : a[i++];
        if (++n % SORT_CHUNK === 0) yield;
      }
      while (i < mid) b[k++] = a[i++];
      while (j < hi) b[k++] = a[j++];
    }
    [a, b] = [b, a];
  }
  return a;
}

function* cached(store, key, fn) {
  const cache = store._textSearches || (store._textSearches = new Map());
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const result = yield* fn();
  cache.set(key, result);
  while (cache.size > SEARCH_CACHE) cache.delete(cache.keys().next().value);
  return result;
}

/** the concepts whose code is in one of the ranges [low, high): ids in code order */
function codesInRanges(store, ranges, stats) {
  if (!ranges.length) return [];
  const seen = new Set();
  const rows = [];
  for (const [low, high] of ranges) {
    for (const r of store.codesInRange(low, high)) {
      if (!seen.has(r[0])) { seen.add(r[0]); rows.push(r); }
    }
  }
  if (stats) { stats.statements += ranges.length; stats.rows += rows.length; }
  // binary order, as SQLite compares text: by UTF-8 bytes, which is code point order
  rows.sort((a, b) => cmpBinary(a[1], b[1]));
  return rows.map((r) => r[0]);
}

// SQLite's BINARY order (UTF-8 bytes, so code points); JavaScript's < is UTF-16 units, which is the
// same unless a string has a character outside the BMP
const ASTRAL = /[\uD800-\uDFFF]/;
function cmpBinary(x, y) {
  if (x === y) return 0;
  if (!ASTRAL.test(x) && !ASTRAL.test(y)) return x < y ? -1 : 1;
  return Buffer.compare(Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8'));
}

/**
 * A name as a database text index holds it (text-match.js indexColumns: its distinct words, in
 * order), which is what cs-loinc.js and cs-rxnorm.js rank (bestRanks over the words column)
 */
function indexedName(term) {
  return [...new Set(textWords(term))].join(' ');
}

// ---- SNOMED CT --------------------------------------------------------------------------------

/**
 * cs-snomed.js #addCodeMatches: active concepts whose identifier starts with the filter's digits,
 * the concept itself first, then in identifier order. main takes the digits as a number p and
 * selects, for each identifier length L from the filter's length to 18, the identifiers in
 * [p * 10^(L - n), (p + 1) * 10^(L - n)): for digits without a leading zero, the identifiers that
 * start with them; with leading zeros, those that start with p's digits and have at most
 * 18 - n + (p's length) digits (p = 0: every identifier of at most 18 - n digits)
 */
function sctCodeMatches(store, q, active, stats) {
  if (!/^[0-9]{1,18}$/.test(q.code)) return [];
  const n = q.code.length;
  const p = BigInt(q.code);
  const digits = p === 0n ? '' : p.toString();
  const maxLen = 18 - n + digits.length;
  const rows = digits ? store.codesInRange(digits, digits + MAX) : store.codesUpToLength(maxLen);
  if (stats) { stats.statements++; stats.rows += rows.length; }
  const found = rows.filter(([id, code]) => active.has(id) && code.length <= maxLen && /^[1-9][0-9]*$/.test(code));
  // identifier order (as numbers: shorter first), the concept itself in front
  found.sort((a, b) => (a[1] === q.code ? 0 : 1) - (b[1] === q.code ? 0 : 1) || a[1].length - b[1].length || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return found.map((r) => r[0]);
}

/**
 * The concepts a SNOMED CT text filter matches, and their order (see the top of this file).
 * @param {object} store Store of a SNOMED CT file
 * @param {string} text the filter
 * @param {string} lang the search language (primary subtag)
 * @param {function} ordinal concept id -> its place in the built-in concept order
 * @returns {{bm: RoaringBitmap32, ids: Uint32Array}} active matches; ids best first
 */
function* sctTextSearchG(store, text, lang, ordinal, stats = null) {
  return yield* cached(store, 'sct\u0000' + lang + '\u0000' + text, function* () {
    const q = new TextQuery(text);
    const tokens = q.tokens(lang);
    const active = store.active(stats);
    let ranked = [];
    if (tokens.length) {
      const index = textIndexOf(store, 'snomed');
      const bm = (yield* candidates(index, lang, tokens, stats)).andInPlace(active);
      const kept = Array.from(bm.toUint32Array()).sort((a, b) => ordinal(a) - ordinal(b));
      yield;
      ranked = yield* rankSct(store, kept, ordinal, index.counts(lang), q, lang, tokens.length > 1, stats);
    }
    const codes = sctCodeMatches(store, q, active, stats);
    const ids = codes.length ? (() => { const have = new Set(codes); return codes.concat(ranked.filter((id) => !have.has(id))); })() : ranked;
    return { bm: new RoaringBitmap32(ids), ids: Uint32Array.from(ids) };
  });
}

/** tx/sct/text-index.js rankMatches; kept: the active candidates in concept order */
function* rankSct(store, kept, ordinal, counts, q, lang, several, stats) {
  if (!kept.length) return [];
  const rate = function* (ids) {
    const best = new Map(ids.map((id) => [id, 0]));
    yield* namesOfG(store, 'snomed', ids, stats, (id, l, term) => {
      if (l !== lang) return;
      const r = q.nameRank(term, lang);
      if (r > best.get(id)) best.set(id, r);
    });
    return best;
  };
  const byRank = (best) => (a, b) => best.get(b) - best.get(a) || ordinal(a) - ordinal(b);
  if (several) {
    // every word in one description: each candidate is rated, those without such a description dropped
    const best = yield* rate(kept);
    return yield* sortG(kept.filter((id) => best.get(id) > 0), byRank(best));
  }
  const wc = (id) => counts[id] || 1;
  const byCount = new Map();
  for (const id of kept) { const c = wc(id); byCount.set(c, (byCount.get(c) || 0) + 1); }
  const distinct = [...byCount.keys()].sort((a, b) => a - b);
  let cutoff = distinct[distinct.length - 1];
  let running = 0;
  for (const c of distinct) {
    running += byCount.get(c);
    if (running >= RANK_REFINE_LIMIT) { cutoff = c; break; }
  }
  const head = [], tail = [];
  for (const id of kept) (wc(id) <= cutoff ? head : tail).push(id);
  const best = yield* rate(head);
  for (const id of head) best.set(id, Math.max(best.get(id), 10));
  return head.sort(byRank(best)).concat(tail);
}

/**
 * The languages the file has active descriptions in (primary subtags), once per file. A stored
 * index has one count row for each of them (computeTextIndexFrom: every name eachSearchName lists, words
 * or none), so it answers at once; a file without one reads every description (0.1-0.3 s on a
 * national edition), which only a text or display regex filter asks for.
 */
function sctTextLanguages(store) {
  if (!store._textLangs) {
    const idx = store.textIndex();
    const stored = idx ? idx.languages() : null;
    if (stored) store._textLangs = new Set(stored);
    else {
      const defLang = store.defaultLanguage || 'en';
      store._textLangs = new Set(store.activeLanguages().map((l) => primaryLanguage(l, defLang)));
    }
  }
  return store._textLangs;
}

/**
 * RxNorm: the concepts cs-rxnorm.js's text search selects from, those with an RXNCONSO atom
 * (a SUPPRESS literal) of a term type other than SY
 */
function rxSearchable(store, stats) {
  if (!store._rxSearchable) {
    const { KIND } = require('./store');
    const sup = store.props.get('SUPPRESS'), tty = store.props.get('TTY');
    const bm = sup ? store.getSet(KIND.hasProp, sup.id, 0, stats).clone() : store.active(stats).clone();
    if (tty) {
      const types = new RoaringBitmap32();
      for (const r of store.propValues(tty.id, stats)) if (r.value !== 'SY') types.orInPlace(store.getSet(KIND.prop, tty.id, r.value, stats));
      bm.andInPlace(types);
    }
    store._rxSearchable = bm;
  }
  return store._rxSearchable;
}

// ---- LOINC ------------------------------------------------------------------------------------

/**
 * The concepts a LOINC text filter matches, in the built-in provider's order (see the top).
 * @param {string} lang the search language (primary subtag)
 * @param {function} ordinal concept id -> the file's concept order (CodeKey)
 * @returns {{bm: RoaringBitmap32, ids: Uint32Array}}
 */
function* loincTextSearchG(store, text, lang, ordinal, stats = null) {
  return yield* cached(store, 'loinc\u0000' + lang + '\u0000' + text, function* () {
    const q = new TextQuery(text);
    const rank = new Map(); // concept -> rank (cs-loinc.js: codeRank, then a better nameRank)
    const codes = codesInRanges(store, q.codeRanges(text), stats);
    const codeRows = store.conceptRows(codes, stats);
    for (const id of codes) rank.set(id, q.codeRank(codeRows.get(id).code));
    const tokens = q.tokens(lang);
    if (tokens.length) {
      const index = textIndexOf(store, 'loinc');
      if (index.langs.has(lang)) {
        // every candidate's names in the search language, ranked as main ranks the TextIndex rows
        // that match (bestRanks over their words column); a candidate none of whose names ranks is
        // left out, as there
        const bm = yield* candidates(index, lang, tokens, stats);
        yield* namesOfG(store, 'loinc', bm.toArray(), stats, (id, l, term) => {
          if (l !== lang) return;
          const r = q.nameRank(indexedName(term), lang);
          if (r > (rank.get(id) ?? 0)) rank.set(id, r);
        });
      }
    }
    yield;
    const rows = store.conceptRows([...rank.keys()], stats);
    const disp = (id) => String(rows.get(id).display ?? '');
    // the best first; then by display (String.localeCompare, as cs-loinc.js), then CodeKey
    const ids = yield* sortG([...rank.keys()], (a, b) => (rank.get(b) - rank.get(a)) || disp(a).localeCompare(disp(b)) || ordinal(a) - ordinal(b));
    return { bm: new RoaringBitmap32(ids), ids: Uint32Array.from(ids) };
  });
}

// ---- RxNorm -----------------------------------------------------------------------------------

/**
 * RxNorm text filter as cs-rxnorm.js answers it (see the top).
 * @param {RoaringBitmap32} eligible the concepts with an RXNCONSO atom other than SY
 * @returns {{bm: RoaringBitmap32, ids: Uint32Array}} ids in RXCUI order (as text)
 */
function* rxTextSearchG(store, text, eligible, stats = null) {
  return yield* cached(store, 'rx\u0000' + text, function* () {
    const q = new TextQuery(text);
    const tokens = q.tokens('en');
    let bm = new RoaringBitmap32();
    if (tokens.length) {
      bm = (yield* candidates(textIndexOf(store, 'rxnorm'), 'en', tokens, stats)).andInPlace(eligible);
      if (tokens.length > 1 && bm.size) bm = yield* inOneName(store, 'rxnorm', bm, q, 'en', stats);
    }
    const best = new Map(); // concept -> its best name's rank (bestRanks over RXNTEXT's words)
    if (tokens.length && bm.size) {
      yield* namesOfG(store, 'rxnorm', bm.toArray(), stats, (id, l, term) => {
        const r = q.nameRank(indexedName(term), 'en');
        if (r > (best.get(id) ?? 0)) best.set(id, r);
      });
    }
    for (const id of codesInRanges(store, q.codeRanges(text), stats)) if (eligible.has(id)) bm.add(id);
    yield;
    const rows = store.conceptRows(bm.toArray(), stats);
    const code = (id) => rows.get(id).code;
    const rank = new Map([...rows.keys()].map((id) => [id, Math.max(best.get(id) ?? 0, q.codeRank(code(id)))]));
    // cs-rxnorm.js #rank: the best first (nameRank or codeRank), then in RXCUI order (as text)
    const ids = yield* sortG(bm.toArray(), (a, b) => (rank.get(b) - rank.get(a)) || cmpBinary(code(a), code(b)));
    return { bm, ids: Uint32Array.from(ids) };
  });
}

// ---- other code systems (cs-cs.js) ------------------------------------------------------------

/**
 * cs-cs.js searchFilter: a concept's rating is its best name in the search language that has every
 * word of the filter (TextQuery.nameRank, less 10 for a designation that is not the display; at
 * least 1), or for a code that starts with the filter (TextQuery.codeRank: 100 the code, 90 a code it
 * starts), whichever is better; codes a supplement in use matches (and nothing else did) 10. In
 * rating order, ties in the code system's order.
 * @param {Iterable<{id, code, display, names: Array<[lang, text]>}>} concepts in the code system's order;
 *   names: the display (in the code system's language) and each designation (in its language or that one)
 * @param {TextQuery} q
 * @param {string} lang the search language (primary subtag)
 * @param {Set<string>} [supplementCodes]
 * @returns {Array<{id, rating, supplement?, code?}>} sorted; supplement: rated by supplementCodes alone
 */
function rateConcepts(concepts, q, lang, supplementCodes = null) {
  return runSync(rateConceptsG(concepts, q, lang, supplementCodes));
}

/** rateConcepts, pausing every RATE_CHUNK concepts; concepts may be a generator that pauses too */
function* rateConceptsG(concepts, q, lang, supplementCodes = null) {
  const hits = [];
  let n = 0;
  for (const c of concepts) {
    if (c === PAUSE) { yield; continue; }
    if (++n % RATE_CHUNK === 0) yield;
    let rating = 0;
    let named = false;
    for (const [l, t] of c.names) {
      if (l !== lang || !t) continue;
      const r = q.nameRank(t, lang);
      if (r > 0) {
        named = true;
        rating = Math.max(rating, r - (t === c.display ? 0 : 10));
      }
    }
    if (named) rating = Math.max(1, rating);
    const cr = q.codeRank(c.code);
    if (cr > 0) rating = Math.max(rating, cr);
    if (rating > 0) hits.push({ id: c.id, rating });
    else if (supplementCodes && supplementCodes.has(c.code)) hits.push({ id: c.id, rating: 10, supplement: true, code: c.code });
  }
  return yield* sortG(hits, (a, b) => b.rating - a.rating);
}

/** the concepts of a file, for rateConcepts: display and designations */
function* blockConcepts(store, csLang, stats) {
  const lang = primaryLanguage(csLang, 'en');
  // two statements read side by side: a better-sqlite3 iterator holds its connection, so the
  // designations are read whole first
  const desRows = store.blockDesignations();
  let di = 0;
  const des = { next: () => (di < desRows.length ? { done: false, value: desRows[di++] } : { done: true }) };
  let d = des.next();
  let rows = 0;
  // read in chunks (no statement iterator is held across a pause: evaluate.js)
  for (let from = store.lo; from <= store.hi; from += ROW_CHUNK) {
    if (from > store.lo) yield PAUSE;
  for (const [id, code, display] of store.blockConcepts(from, Math.min(from + ROW_CHUNK - 1, store.hi))) {
    rows++;
    const names = display ? [[lang, display]] : [];
    while (!d.done && d.value[0] < id) d = des.next();
    while (!d.done && d.value[0] === id) { rows++; names.push([primaryLanguage(d.value[1], lang), d.value[2]]); d = des.next(); }
    yield { id, code, display, names };
  }
  }
  if (stats) { stats.statements += 2; stats.rows += rows; }
}

/** any other code system: cs-cs.js's rules over its concepts (rateConcepts) */
function* genericTextSearchG(store, text, lang, csLang, stats = null, supplementCodes = null) {
  const run = function* () {
    const hits = yield* rateConceptsG(blockConcepts(store, csLang, stats), new TextQuery(text), lang, supplementCodes);
    const ids = hits.map((h) => h.id);
    return { bm: new RoaringBitmap32(ids), ids: Uint32Array.from(ids) };
  };
  return supplementCodes && supplementCodes.size ? yield* run() : yield* cached(store, 'gen\u0000' + lang + '\u0000' + csLang + '\u0000' + text, run);
}

// the sync API (runSync): the same searches straight through
const sctTextSearch = (...a) => runSync(sctTextSearchG(...a));
const loincTextSearch = (...a) => runSync(loincTextSearchG(...a));
const rxTextSearch = (...a) => runSync(rxTextSearchG(...a));
const genericTextSearch = (...a) => runSync(genericTextSearchG(...a));

module.exports = {
  FORMAT, WordIndex, blockConcepts, indexed, eachSearchName, searchNamesOf, rxSearchable,
  computeTextIndexFrom, textIndexOf, primaryLanguage,
  sctTextSearch, sctTextLanguages, loincTextSearch, rxTextSearch, genericTextSearch, rateConcepts,
  sctTextSearchG, loincTextSearchG, rxTextSearchG, genericTextSearchG
};
