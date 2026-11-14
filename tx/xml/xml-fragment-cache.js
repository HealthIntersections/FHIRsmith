//
// The XML of large arrays, kept for next time
//

/**
 * Keeps the serialised XML of large arrays of objects - a CodeSystem's concepts, an
 * expansion's contains - so a resource asked for again doesn't have to be serialised again.
 * FhirXmlBase.toXmlAsync asks it for each array it sets aside (see there).
 *
 * What's kept:
 * - only arrays that took at least minMs to render, and only on the second such render of
 *   the same array: a large expansion asked for once isn't worth the memory; ICD-10-CM,
 *   asked for hundreds of times a day, is
 * - keyed on the array itself, with the element name and indent level (a read and a search
 *   indent the resource differently). The R3/R4/R5 conversions share the concepts, so the
 *   versions share the entries too
 * - held weakly: when the array goes (a package is reloaded, an expansion leaves the
 *   expansion cache), its XML goes with it
 * - within budgetBytes for all of them, the least recently used dropped first
 *
 * The XML is only right while the array is unchanged, so this relies on what is served
 * not being changed afterwards (what the expansion cache relies on too). A change in the
 * array's length is noticed, and the entry dropped; a change inside it isn't.
 */
class XmlFragmentCache {
  /**
   * @param {object} opts
   * @param {number} opts.budgetBytes - most text (in characters) held in all
   * @param {number} [opts.minMs=50] - least render (compute) time worth remembering
   */
  constructor({ budgetBytes, minMs = 50 }) {
    this.budgetBytes = budgetBytes;
    this.minMs = minMs;
    this._entries = new WeakMap(); // array -> Map(key -> entry)
    this._seen = new WeakMap(); // array -> Set(key): rendered expensively once
    this._lru = new Set(); // entries, least recently used first
    this.bytes = 0;
    this.hits = 0;
    this.stored = 0;
    // an array that's gone: its entries are dropped (they hold no reference to it)
    this._registry = new FinalizationRegistry(byKey => {
      for (const entry of byKey.values()) {
        this._drop(entry, false);
      }
    });
  }

  /**
   * @returns {string|null} the XML kept for this array at this key, or null
   */
  get(array, key) {
    const entry = this._entries.get(array)?.get(key);
    if (!entry) {
      return null;
    }
    if (entry.length !== array.length) {
      this._drop(entry, true);
      return null;
    }
    this._lru.delete(entry);
    this._lru.add(entry);
    this.hits++;
    return entry.text;
  }

  /**
   * Whether to keep the XML of an array that just took ms to render (if so, call put).
   * The first expensive render is only noted.
   */
  wants(array, key, ms) {
    if (ms < this.minMs) {
      return false;
    }
    let seen = this._seen.get(array);
    if (!seen) {
      seen = new Set();
      this._seen.set(array, seen);
    }
    if (!seen.has(key)) {
      seen.add(key);
      return false;
    }
    return true;
  }

  put(array, key, text) {
    const bytes = text.length;
    if (bytes > this.budgetBytes) {
      return;
    }
    let byKey = this._entries.get(array);
    if (!byKey) {
      byKey = new Map();
      this._entries.set(array, byKey);
      this._registry.register(array, byKey);
    } else if (byKey.has(key)) {
      this._drop(byKey.get(key), true);
    }
    const entry = { key, text, bytes, length: array.length, byKey };
    byKey.set(key, entry);
    this._lru.add(entry);
    this.bytes += bytes;
    this.stored++;
    for (const oldest of this._lru) {
      if (this.bytes <= this.budgetBytes) {
        break;
      }
      this._drop(oldest, true);
    }
  }

  /**
   * Drop everything (memory pressure)
   * @returns {number} characters of XML let go
   */
  clear() {
    const freed = this.bytes;
    for (const entry of [...this._lru]) {
      this._drop(entry, true);
    }
    return freed;
  }

  get size() {
    return this._lru.size;
  }

  _drop(entry, fromMap) {
    if (!this._lru.delete(entry)) {
      return;
    }
    this.bytes -= entry.bytes;
    if (fromMap) {
      entry.byKey.delete(entry.key);
    }
  }
}

module.exports = { XmlFragmentCache };
