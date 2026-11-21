const { RE2JS } = require('re2js');

// Translate a JS-style flags string ("i", "im", "is", etc.) into the bit-flag
// integer that RE2JS.compile() expects. Only the flags actually used by callers
// (and their natural counterparts) are mapped; anything else is ignored.
function toRE2JSFlags(flags) {
  if (!flags) return 0;
  let bits = 0;
  if (flags.includes('i')) bits |= RE2JS.CASE_INSENSITIVE;
  if (flags.includes('m')) bits |= RE2JS.MULTILINE;
  if (flags.includes('s')) bits |= RE2JS.DOTALL;
  // The 'u' flag was a re2-wasm workaround; re2js is pure JS and handles
  // unicode natively, so it's a no-op here.
  return bits;
}

// Thin wrapper that exposes the only method the rest of the codebase uses
// against compiled regexes: a JS-RegExp-style `.test(input)` that returns
// true if the pattern is found anywhere in `input`.
class CompiledRegex {
  constructor(pattern, flags) {
    this._pattern = RE2JS.compile(pattern, toRE2JSFlags(flags));
  }

  test(input) {
    if (input == null) return false;
    return this._pattern.matcher(String(input)).find();
  }
}

class RegExUtilities {

  // re2js doesn't have re2-wasm's WASM-heap leak, so the cache here is
  // purely a performance optimisation. We cap it with a simple LRU so a
  // workload with many distinct regex patterns can't grow it without bound.
  static MAX_CACHE_SIZE = 1000;

  constructor() {
    this._cache = new Map();
  }

  compile(pattern, flags) {
    const key = pattern + '|' + (flags || '');
    const cached = this._cache.get(key);
    if (cached) {
      // Move to most-recently-used position by re-inserting.
      this._cache.delete(key);
      this._cache.set(key, cached);
      return cached;
    }
    const compiled = new CompiledRegex(pattern, flags);
    if (this._cache.size >= RegExUtilities.MAX_CACHE_SIZE) {
      // Evict the oldest entry. Map iteration order is insertion order, so
      // the first key is the least-recently-used.
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
    this._cache.set(key, compiled);
    return compiled;
  }

}

module.exports = new RegExUtilities();
