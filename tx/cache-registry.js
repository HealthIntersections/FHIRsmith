//
// The caches of the tx module, in one list
//
// Every cache the tx module keeps registers here: how many entries it holds, and how to
// empty it. The caches page (tx.js, /caches) lists them and lets an administrator empty
// them, and the memory guard (library/memory-guard.js) empties them when memory is short.
//
// There are three kinds:
//  - 'cache': kept by an endpoint or by the process, for speed (expansions, XML, recently
//    read value sets...). Emptied by the memory guard when memory is short, before the
//    client caches
//  - 'content': kept on what was loaded as the server started (a value set's filters, a
//    SNOMED CT edition's text indexes...), built as it is used
//  - 'client': the client caches ($cache-control cache-ids). Emptying them makes clients
//    start their caches again (they are told the cache-id is unknown), so the memory guard
//    empties them last, and only if emptying the rest didn't get memory back under its
//    threshold
// Emptying any of them loses nothing but time: each is built again as it is needed. What
// was loaded as the server started (the library) isn't a cache, and isn't here.
//

const KINDS = ['cache', 'content', 'client'];
// the most entries of one cache shown (the most recently used)
const LIST_ROWS = 5000;

class CacheRegistry {
  constructor() {
    this.caches = [];
  }

  /**
   * @param {Object} cache
   * @param {string} cache.name - what it is
   * @param {string} cache.scope - whose it is ('process', or an endpoint's path)
   * @param {string} cache.kind - 'cache', 'content' or 'client' (see above)
   * @param {Function} cache.count - () => how many entries it holds
   * @param {Function} [cache.detail] - () => more about what it holds, in words (or null)
   * @param {Function} [cache.clear] - () => empties it; returns about how many bytes that let go,
   *   or null if that isn't known. No clear: it is listed, but never emptied
   * @param {string} [cache.limit] - its limit, in words
   * @param {string} [cache.id] - names it in a link to its entries (with list)
   * @param {Function} [cache.list] - () => its entries, for an administrator to look at:
   *   {columns: string[], rows: Array[]} (see LIST_ROWS)
   */
  add(cache) {
    if (!KINDS.includes(cache.kind)) {
      throw new Error(`Unknown cache kind '${cache.kind}'`);
    }
    this.caches.push(cache);
    return cache;
  }

  /**
   * Each cache and what it holds now
   * @returns {Object[]} {name, scope, kind, entries, detail, limit, clearable}
   */
  report() {
    return this.caches.map(c => {
      let entries = null;
      let detail = null;
      try {
        entries = c.count();
        detail = c.detail ? c.detail() : null;
      } catch (e) {
        detail = `unable to count: ${e.message}`;
      }
      return { name: c.name, scope: c.scope, kind: c.kind, entries, detail, limit: c.limit || null, clearable: !!c.clear,
        id: c.list && c.id ? c.id : null };
    });
  }

  /**
   * The entries of the cache with this id (at most LIST_ROWS of them), or null if there is none
   * that lists them
   * @param {string} id
   * @returns {Object|null} {id, name, scope, columns, rows, total}
   */
  list(id) {
    const c = this.caches.find(x => x.id === id && x.list);
    if (!c) {
      return null;
    }
    const { columns, rows } = c.list();
    return { id, name: c.name, scope: c.scope, columns, rows: rows.slice(-LIST_ROWS), total: rows.length };
  }

  /**
   * Empty the caches of the kinds given
   * @param {string[]} kinds
   * @returns {Object[]} {name, scope, kind, entries (before), bytes (let go, or null)}
   */
  clear(kinds) {
    const done = [];
    for (const c of this.caches) {
      if (!kinds.includes(c.kind) || !c.clear) {
        continue;
      }
      let entries = null;
      try {
        entries = c.count();
      } catch (e) {
        // count what we can
      }
      let bytes = null;
      try {
        const freed = c.clear();
        bytes = typeof freed === 'number' && freed >= 0 ? freed : null;
      } catch (e) {
        done.push({ name: c.name, scope: c.scope, kind: c.kind, entries, bytes, error: e.message });
        continue;
      }
      done.push({ name: c.name, scope: c.scope, kind: c.kind, entries, bytes });
    }
    return done;
  }
}

module.exports = { CacheRegistry, KINDS, LIST_ROWS };
