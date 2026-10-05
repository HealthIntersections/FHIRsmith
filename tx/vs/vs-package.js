const path = require('path');
const fs = require('fs').promises;
const { AbstractValueSetProvider } = require('./vs-api');
const { PackageContentLoader } = require('../../library/package-manager');
const { ValueSetDatabase } = require('./vs-database');
const { checkContained } = require('../library/canonical-resource');
const { VersionUtilities } = require('../../library/version-utilities');
const {validateParameter} = require("../../library/utilities");

/**
 * Package-based ValueSet provider using shared database layer
 */
class PackageValueSetProvider extends AbstractValueSetProvider {
  USE_DATABASE_SEARCH = true;

  /**
   * @param {PackageContentLoader} packageLoader - Path to the extracted package folder
   */
  constructor(packageLoader) {
    super();
    validateParameter(packageLoader, "packageLoader", PackageContentLoader);
    this.packageLoader = packageLoader;
    this.dbPath = path.join(packageLoader.packageFolder, '.valuesets.db');
    this.database = new ValueSetDatabase(this.dbPath);
    this.valueSetMap = new Map();
    this.initialized = false;
    this.count = 0;
    this.sourcePackageCode = packageLoader.id();
  }

  code() {
    return this.sourcePackageCode;
  }
  sourcePackage() {
    return this.sourcePackageCode;
  }

  /**
   * Initialize the provider - check/create database and load value sets into memory
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) {
      return;
    }
    await this.packageLoader.initialize();

    const dbExists = await this.database.exists();

    if (!dbExists) {
      await this.database.create();
      await this._populateDatabase();
    }

    this.valueSetMap = await this.database.loadAllValueSets(this.sourcePackage());

    // Self-heal caches built before pipe-versioned canonical urls were normalized at
    // load time (the R4 v2 tables 0006/0360/0391 - see normalizeVersionedCanonicals in
    // package-manager.js): if any cached value set still carries a "system|version"
    // include or a pipe in its url, rebuild this cache from the package.
    if (dbExists && this.#hasPipeVersionedCanonicals()) {
      await this.database.close();
      await fs.rm(this.dbPath, { force: true });
      this.database = new ValueSetDatabase(this.dbPath);
      await this.database.create();
      await this._populateDatabase();
      this.valueSetMap = await this.database.loadAllValueSets(this.sourcePackage());
    }

    // Mark each value set as cached as it enters the store: it is retained in
    // memory for the process lifetime, so its compose.include.filter elements
    // persist and a provider may memoise resolved filter analysis on them
    // (see CodeSystemProvider.filter()'s `fc` parameter).
    for (const vs of this.valueSetMap.values()) {
      if (vs) {
        // non-enumerable: internal marker only, must never serialise into a
        // response or be copied by structuredClone/spread when a VS is cloned.
        Object.defineProperty(vs, 'isCached', { value: true, enumerable: false, configurable: true, writable: true });
      }
    }
    this.initialized = true;
  }

  /**
   * True if any loaded value set still has a pipe-versioned canonical (url or
   * compose include/exclude system) - the signature of a cache written before
   * load-time normalization existed.
   */
  #hasPipeVersionedCanonicals() {
    for (const vs of this.valueSetMap.values()) {
      if (!vs) {
        continue;
      }
      if (typeof vs.url === 'string' && vs.url.includes('|')) {
        return true;
      }
      if (vs.compose) {
        for (const list of [vs.compose.include, vs.compose.exclude]) {
          for (const inc of list || []) {
            if (typeof inc.system === 'string' && inc.system.includes('|')) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  async close() {
    await this.database.close();
  }
  /**
   * Populate the database with value sets from the package
   * @returns {Promise<void>}
   * @private
   */
  async _populateDatabase() {
    // Get all ValueSet resources
    const valueSetEntries = await this.packageLoader.getResourcesByType('ValueSet');

    if (valueSetEntries.length === 0) {
      return; // No value sets in this package
    }

    const valueSets = [];
    for (const entry of valueSetEntries) {
      const valueSet = await this.packageLoader.loadFile(entry);
      if (valueSet.url) {
        try {
          // don't store a value set the server can't use (e.g. one that contains a
          // CodeSystem): it would be listed by search, and fail when read
          checkContained(valueSet);
        } catch (e) {
          require('../../library/logger').getInstance().child({ module: 'tx' })
            .warn(`Package ${this.packageLoader.pid ? this.packageLoader.pid() : ''}: skipping ValueSet ${valueSet.url}: ${e.message}`);
          continue;
        }
        valueSets.push(valueSet);
      }
    }

    if (valueSets.length > 0) {
      await this.batchUpsertValueSets(valueSets);
    }
  }


  /**
   * Insert multiple ValueSets in a batch operation
   * @param {Array<Object>} valueSets - Array of ValueSet resources
   * @returns {Promise<void>}
   */
  async batchUpsertValueSets(valueSets) {
    if (valueSets.length === 0) {
      return;
    }

    // Process sequentially to avoid database locking
    for (const valueSet of valueSets) {
      await this.database.upsertValueSet(valueSet);
    }
  }


  /**
   * Fetches a value set by URL and version
   * @param {string} url - The canonical URL of the value set
   * @param {string} version - The version of the value set
   * @returns {Promise<Object>} The requested value set
   */
  async fetchValueSet(url, version) {
    await this.initialize();
    this._validateFetchParams(url, version);

    // Try exact match first: url|version
    let key = `${url}|${version}`;
    if (this.valueSetMap.has(key)) {
      return this.valueSetMap.get(key);
    }

    // If version is semver, try url|major.minor
    try {
      if (VersionUtilities.isSemVer(version)) {
        const majorMinor = VersionUtilities.getMajMin(version);
        if (majorMinor) {
          key = `${url}|${majorMinor}`;
          if (this.valueSetMap.has(key)) {
            return this.valueSetMap.get(key);
          }
        }
      }
    } catch (error) {
      // Ignore version parsing errors
    }

    // Finally try just the URL
    if (!version && this.valueSetMap.has(url)) {
      return this.valueSetMap.get(url);
    }

    return null;
  }

  /**
   * Searches for value sets based on criteria
   * @param {Array<{name: string, value: string}>} searchParams - Search criteria
   * @returns {Promise<Array<Object>>} List of matching value sets
   */
  async searchValueSets(searchParams, elements = null) {
    await this.initialize();
    this._validateSearchParams(searchParams);

    if (this.USE_DATABASE_SEARCH) {
      return await this.database.search(this.spaceId, this.valueSetMap, searchParams, elements);
    } else {
      const matches = [];
      const seen = new Set(); // Track by URL to avoid duplicates from versioned keys

      // Convert array format to object for easier access
      const params = {};
      for (const {name, value} of searchParams) {
        params[name] = value.toLowerCase();
      }

      const hasSearchParams = Object.keys(params).length > 0;

      for (const vs of this.valueSetMap.values()) {
        const json = vs.jsonObj || vs;

        // Only process each ValueSet once (use URL to deduplicate)
        const vsUrl = json.url;
        if (seen.has(vsUrl)) {
          continue;
        }

        if (!hasSearchParams) {
          seen.add(vsUrl);
          matches.push(vs);
          continue;
        }

        // Check each search parameter
        let isMatch = true;
        for (const [param, searchValue] of Object.entries(params)) {
          // Ignore content-mode and supplements for ValueSet search
          if (param === 'content-mode' || param === 'supplements') {
            continue;
          }

          if (param === 'system') {
            // Special handling: match against compose.include[].system
            if (!this._matchSystem(json, searchValue)) {
              isMatch = false;
              break;
            }
          } else if (param === 'jurisdiction') {
            // Special handling for jurisdiction - array of CodeableConcept
            if (!this._matchJurisdiction(json.jurisdiction, searchValue)) {
              isMatch = false;
              break;
            }
          } else if (param === 'identifier') {
            // Special handling for identifier
            if (!this._matchIdentifier(json.identifier, searchValue)) {
              isMatch = false;
              break;
            }
          } else if (param === 'url') {
            const propValue = json[param];
            if (!this._matchValueFull(propValue, searchValue)) {
              isMatch = false;
              break;
            }
          } else {
            // Standard partial text match on property
            const propValue = json[param];
            if (!this._matchValue(propValue, searchValue)) {
              isMatch = false;
              break;
            }
          }
        }

        if (isMatch) {
          seen.add(vsUrl);
          // Return with prefixed id
          matches.push(json);
        }
      }

      return matches;
    }
  }

  /**
   * Check if a value matches the search term (partial, case-insensitive)
   */
  _matchValue(propValue, searchValue) {
    if (propValue === undefined || propValue === null) {
      return false;
    }
    const strValue = String(propValue).toLowerCase();
    return strValue.includes(searchValue);
  }

  /**
   * Check if a value matches the search term (partial, case-insensitive)
   */
  _matchValueFull(propValue, searchValue) {
    if (propValue === undefined || propValue === null) {
      return false;
    }
    const strValue = String(propValue).toLowerCase();
    return strValue === searchValue;
  }

  /**
   * Check if system matches any compose.include[].system
   */
  _matchSystem(json, searchValue) {
    if (!json.compose?.include || !Array.isArray(json.compose.include)) {
      return false;
    }
    for (const include of json.compose.include) {
      if (include.system && include.system.toLowerCase().includes(searchValue)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if jurisdiction matches - jurisdiction is an array of CodeableConcept
   */
  _matchJurisdiction(jurisdictions, searchValue) {
    if (!jurisdictions || !Array.isArray(jurisdictions)) {
      return false;
    }
    for (const cc of jurisdictions) {
      if (cc.coding && Array.isArray(cc.coding)) {
        for (const coding of cc.coding) {
          if (coding.code && coding.code.toLowerCase().includes(searchValue)) {
            return true;
          }
          if (coding.display && coding.display.toLowerCase().includes(searchValue)) {
            return true;
          }
        }
      }
      if (cc.text && cc.text.toLowerCase().includes(searchValue)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if identifier matches
   */
  _matchIdentifier(identifiers, searchValue) {
    if (!identifiers) {
      return false;
    }
    const idArray = Array.isArray(identifiers) ? identifiers : [identifiers];
    for (const id of idArray) {
      if (id.system && id.system.toLowerCase().includes(searchValue)) {
        return true;
      }
      if (id.value && id.value.toLowerCase().includes(searchValue)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get statistics about the loaded value sets
   * @returns {Promise<Object>} Statistics object
   */
  async getStatistics() {
    await this.initialize();
    return await this.database.getStatistics();
  }

  /**
   * Get the number of value sets loaded into memory
   * @returns {number} Number of unique value sets in map
   */
  getMapSize() {
    const uniqueUrls = new Set();
    for (const [key, valueSet] of this.valueSetMap.entries()) {
      if (!key.includes('|')) { // Only count base URL keys
        uniqueUrls.add(valueSet.url);
      }
    }
    return uniqueUrls.size;
  }

  async fetchValueSetById(id) {
    return this.valueSetMap.get(id);
  }

  // eslint-disable-next-line no-unused-vars
  assignIds(ids) {
    if (!this.spaceId) {
      return;
    }

    const prefix = this.spaceId + '-';
    const alreadyPrefixed = new Set();

    // Get all current entries - we'll iterate and modify
    const entries = Array.from(this.valueSetMap.entries());

    // eslint-disable-next-line no-unused-vars
    for (const [key, vs] of entries) {
      // Skip if we've already processed this ValueSet instance
      if (alreadyPrefixed.has(vs)) {
        continue;
      }

      // Update the id on the ValueSet itself
      if (vs.id && !vs.id.startsWith(prefix)) {
        const oldId = vs.id;
        vs.id = prefix + oldId;

        // Add to map under the new id as well
        this.valueSetMap.set(vs.id, vs);
      }

      alreadyPrefixed.add(vs);
    }
  }

  vsCount() {
    return this.database.vsCount;
  }

  async listAllValueSets() {
    return await this.database.listAllValueSets();
  }
}

module.exports = {
  PackageValueSetProvider
};
