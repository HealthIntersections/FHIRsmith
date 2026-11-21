//
// What a provider remembers on a value set's filter element
//
// A provider may remember what a filter of a value set that is held beyond one request
// resolved to (isCached: a package's, or one a client cache holds), on the filter element
// itself (the `fc` handed to CodeSystemProvider.filter), under one of these symbols.
// Symbol-keyed and defined non-enumerable, so it never serialises, clones, or spreads into a
// response. Each is a Map, from the code system (and version) the filter was resolved against
// - and, for SNOMED's display regex, the language - to what it resolved to.
//
// Who keeps them depends on whose value set it is (markFilters):
// - a package's (held for the life of the server): libraryFilterMemos, least recently used
//   first, within a budget of concepts
// - a client cache's: the client cache, which counts them as concepts it holds, so they come
//   under its limits (cacheMaxConcepts, cacheMaxTotalConcepts), and go when it goes
// - a value set held for one request only (nobody's): remembered as long as it lives
// Providers go through recall and remember, never the maps.
//

// cs-cs.js: Map(code system version key -> concepts[]) - only the expensive filters
const FILTER_ANALYSIS = Symbol('filterAnalysis');
// cs-snomed.js: Map(url|version -> {descendants, members, matches, eclAst}) - resolved ECL
const SNOMED_FILTER_ANALYSIS = Symbol('snomedFilterAnalysis');
// cs-snomed.js: Map(url|version|language -> concept indexes) - display regex scans
const SNOMED_DISPLAY_REGEX = Symbol('snomedDisplayRegex');

const MEMO_SYMBOLS = [FILTER_ANALYSIS, SNOMED_FILTER_ANALYSIS, SNOMED_DISPLAY_REGEX];

// on a filter element: who keeps what is remembered on it (markFilters), and the entries the
// keeper is tracking for it (sym index|key -> entry)
const OWNER = Symbol('filterMemoOwner');
const ENTRIES = Symbol('filterMemoEntries');

/**
 * How big a remembered result is, in concepts: the length of the list (or of each list, for an
 * ECL analysis)
 * @param {*} value
 * @returns {number}
 */
function memoSize(value) {
  const len = (v) => (Array.isArray(v) || ArrayBuffer.isView(v) ? v.length : (v instanceof Set || v instanceof Map ? v.size : 0));
  if (!value || typeof value !== 'object') {
    return 0;
  }
  if (Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof Set || value instanceof Map) {
    return len(value);
  }
  let n = 0;
  for (const v of Object.values(value)) {
    n += len(v);
  }
  return n;
}

/**
 * The results remembered on the filters of the value sets the server holds for its life (the
 * packages': vs-package.js). Without a limit they would grow with every code system version,
 * and language, a filter is resolved against, for as long as the server runs; so they are kept
 * least recently used first, within maxConcepts (memoSize) between them, and a result bigger
 * than that isn't kept at all. Counting them, and letting them all go, doesn't depend on how
 * many value sets there are
 */
class LibraryFilterMemos {
  // 8 bytes or so a concept (a reference, or an index): about 80 MB
  static DEFAULT_MAX_CONCEPTS = 10000000;

  constructor(maxConcepts = LibraryFilterMemos.DEFAULT_MAX_CONCEPTS) {
    this.maxConcepts = maxConcepts;
    this.total = 0;
    this.lru = new Set(); // entries {fc, sym, key, size}, least recently used first
  }

  get size() {
    return this.lru.size;
  }

  /** A result stored: true if it is kept */
  note(fc, sym, key, size) {
    if (size > this.maxConcepts) {
      return false;
    }
    const id = MEMO_SYMBOLS.indexOf(sym) + '|' + key;
    let entries = fc[ENTRIES];
    if (!entries) {
      entries = new Map();
      Object.defineProperty(fc, ENTRIES, { value: entries, enumerable: false, configurable: true, writable: true });
    }
    const old = entries.get(id);
    if (old) {
      this.#drop(old, false);
    }
    const entry = { fc, sym, key, id, size };
    entries.set(id, entry);
    this.lru.add(entry);
    this.total += size;
    for (const oldest of this.lru) {
      if (this.total <= this.maxConcepts) {
        break;
      }
      if (oldest !== entry) {
        this.#drop(oldest, true);
      }
    }
    return true;
  }

  /** A result used */
  touch(fc, sym, key) {
    const entry = fc[ENTRIES] && fc[ENTRIES].get(MEMO_SYMBOLS.indexOf(sym) + '|' + key);
    if (entry && this.lru.delete(entry)) {
      this.lru.add(entry);
    }
  }

  #drop(entry, fromFilter) {
    if (!this.lru.delete(entry)) {
      return;
    }
    this.total -= entry.size;
    if (entry.fc[ENTRIES]) {
      entry.fc[ENTRIES].delete(entry.id);
    }
    if (fromFilter) {
      const map = entry.fc[entry.sym];
      if (map instanceof Map) {
        map.delete(entry.key);
      }
    }
  }

  /**
   * Let every result go
   * @returns {number} how many
   */
  clear() {
    const count = this.lru.size;
    for (const entry of [...this.lru]) {
      this.#drop(entry, true);
    }
    return count;
  }
}

// the one for the whole process (the library is shared by the endpoints)
const libraryFilterMemos = new LibraryFilterMemos();

/**
 * Say who keeps what is remembered on the filters of a value set held beyond one request:
 * libraryFilterMemos for a package's, a client cache for one it holds (operation-context.js). A
 * keeper has note(fc, sym, key, size) => whether to keep it, and touch(fc, sym, key)
 * @param {Object} vs
 * @param {Object} owner
 */
function markFilters(vs, owner) {
  eachFilter(vs, fc => {
    Object.defineProperty(fc, OWNER, { value: owner, enumerable: false, configurable: true, writable: true });
  });
}

/**
 * What was remembered on a filter element for key, or undefined
 * @param {Object} fc - the filter element
 * @param {Symbol} sym - one of MEMO_SYMBOLS
 * @param {string} key
 */
function recall(fc, sym, key) {
  const map = fc ? fc[sym] : null;
  const value = map instanceof Map ? map.get(key) : undefined;
  if (value !== undefined && fc[OWNER]) {
    fc[OWNER].touch(fc, sym, key);
  }
  return value;
}

/**
 * Remember a result on a filter element for key, if its keeper keeps it (a filter with no
 * keeper - a value set held for one request only - keeps it as long as it lives)
 * @returns {boolean} whether it was kept
 */
function remember(fc, sym, key, value) {
  if (!fc) {
    return false;
  }
  if (fc[OWNER] && !fc[OWNER].note(fc, sym, key, memoSize(value))) {
    return false;
  }
  let map = fc[sym];
  if (!(map instanceof Map)) {
    map = new Map();
    Object.defineProperty(fc, sym, { value: map, enumerable: false, configurable: true, writable: true });
  }
  map.set(key, value);
  return true;
}

/**
 * Each filter element of a value set's compose (includes and excludes)
 * @param {Object} vs - a ValueSet wrapper or its JSON
 * @param {Function} fn - fn(filter element)
 */
function eachFilter(vs, fn) {
  const json = vs && vs.jsonObj ? vs.jsonObj : vs;
  const compose = json && json.compose;
  if (!compose) {
    return;
  }
  for (const set of [...(compose.include || []), ...(compose.exclude || [])]) {
    for (const fc of set.filter || []) {
      if (fc && typeof fc === 'object') {
        fn(fc);
      }
    }
  }
}

/**
 * How many results the filters of a value set remember, and how big they are (concepts)
 * @param {Object} vs
 * @returns {{count: number, concepts: number}}
 */
function filterMemoSize(vs) {
  let count = 0;
  let concepts = 0;
  eachFilter(vs, fc => {
    for (const sym of MEMO_SYMBOLS) {
      const map = fc[sym];
      if (map instanceof Map) {
        count += map.size;
        for (const v of map.values()) {
          concepts += memoSize(v);
        }
      }
    }
  });
  return { count, concepts };
}

module.exports = {
  FILTER_ANALYSIS, SNOMED_FILTER_ANALYSIS, SNOMED_DISPLAY_REGEX, MEMO_SYMBOLS,
  LibraryFilterMemos, libraryFilterMemos, markFilters, recall, remember, memoSize, filterMemoSize
};
