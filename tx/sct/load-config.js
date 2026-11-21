'use strict';

/**
 * How each SNOMED CT cache file is loaded, from the tx module's "snomed" block in config.json:
 *
 *   "snomed": {
 *     "load": "read" | "mmap",   // the default for every edition (absent: "read")
 *     "prewarm": [ ... ],        // map these, then read them through once in the background at startup
 *     "read": [ ... ]            // read these into the process even when load is "mmap"
 *   }
 *
 * An entry names a cache file (e.g. "sct_us_20250901b.cache"), an edition version URI
 * ("http://snomed.info/sct/731000124108/version/20250901"), or an edition URI
 * ("http://snomed.info/sct/731000124108", every loaded version of the edition). "read" wins
 * over "prewarm", which wins over "load".
 *
 *   read    - the file is read into this process (private memory, as before)
 *   mmap    - the file is mapped read-only; pages are read from disk when first touched, and
 *             shared with every other process that maps the same file
 *   prewarm - mapped, and read through once in the background at startup so its pages are
 *             already in the shared page cache when the first requests arrive
 */

const path = require('path');

const MODES = ['read', 'mmap'];

class SnomedLoadConfig {
  /**
   * @param {object} [block] - the "snomed" block of the tx module config
   * @param {function(string)} [warn]
   */
  constructor(block, warn = () => {}) {
    this.warn = warn;
    block = block || {};
    this.load = 'read';
    if (block.load !== undefined) {
      if (MODES.includes(block.load)) {
        this.load = block.load;
      } else {
        warn(`snomed.load must be "read" or "mmap", not ${JSON.stringify(block.load)}; using "read"`);
      }
    }
    this.lists = {};
    for (const name of ['prewarm', 'read']) {
      const v = block[name];
      if (v === undefined) {
        this.lists[name] = [];
      } else if (Array.isArray(v) && v.every(e => typeof e === 'string' && e.trim())) {
        this.lists[name] = v.map(e => e.trim());
      } else {
        warn(`snomed.${name} must be a list of cache file names or edition URIs; ignored`);
        this.lists[name] = [];
      }
    }
    for (const e of this.lists.prewarm) {
      if (this.lists.read.includes(e)) {
        warn(`snomed: ${e} is in both "prewarm" and "read"; it will be read`);
      }
    }
    this.used = new Set();
  }

  /** True if any edition can end up mapped. */
  mapsAnything() {
    return this.load === 'mmap' || this.lists.prewarm.length > 0;
  }

  static #matches(entry, fileName, versionUri) {
    if (entry === fileName) return true;
    if (!versionUri) return false;
    return entry === versionUri || versionUri.startsWith(entry.replace(/\/+$/, '') + '/version/');
  }

  #find(list, fileName, versionUri) {
    const hit = this.lists[list].filter(e => SnomedLoadConfig.#matches(e, fileName, versionUri));
    hit.forEach(e => this.used.add(e));
    return hit.length > 0;
  }

  /**
   * @param {string} filePath - the cache file
   * @param {string|null} versionUri - its edition version URI, e.g. http://snomed.info/sct/900000000000207008/version/20250201
   * @returns {'read'|'mmap'|'prewarm'}
   */
  modeFor(filePath, versionUri) {
    const fileName = path.basename(filePath);
    const read = this.#find('read', fileName, versionUri);
    const prewarm = this.#find('prewarm', fileName, versionUri);
    if (read) return 'read';
    if (prewarm) return 'prewarm';
    return this.load;
  }

  /** Warn about entries that matched no loaded edition. Call once every edition is loaded. */
  checkUnused() {
    for (const list of ['prewarm', 'read']) {
      for (const e of this.lists[list]) {
        if (!this.used.has(e)) {
          this.warn(`snomed.${list}: "${e}" matches no SNOMED CT edition in the library`);
        }
      }
    }
  }
}

module.exports = { SnomedLoadConfig };
