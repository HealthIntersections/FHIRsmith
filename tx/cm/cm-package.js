const path = require('path');
const { AbstractConceptMapProvider } = require('./cm-api');
const { PackageContentLoader } = require('../../library/package-manager');
const { ConceptMapDatabase } = require('./cm-database');
const { VersionUtilities } = require('../../library/version-utilities');
const {validateParameter} = require("../../library/utilities");
const {ConceptMap} = require("../library/conceptmap");
const { applyIdPrefix, stripIdPrefix } = require('../library/resource-ids');

/**
 * Package-based ConceptMap provider using shared database layer
 */
class PackageConceptMapProvider extends AbstractConceptMapProvider {
  USE_DATABASE_SEARCH = true;

  /**
   * @param {PackageContentLoader} packageLoader - Path to the extracted package folder
   */
  constructor(packageLoader) {
    super();
    validateParameter(packageLoader, "packageLoader", PackageContentLoader);
    this.packageLoader = packageLoader;
    this.dbPath = path.join(packageLoader.packageFolder, '.conceptmaps.db');
    this.database = new ConceptMapDatabase(this.dbPath);
    this.conceptMapMap = new Map();
    this.initialized = false;
    this.count = 0;
  }

  /**
   * Initialize the provider - check/create database and load concept maps into memory
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

    this.conceptMapMap = await this.database.loadAllConceptMaps();
    // nothing, unless the spaceId was assigned before the provider was initialized
    this.#applyIdPrefix();
    this.initialized = true;
  }

  /**
   * Populate the database with concept maps from the package
   * @returns {Promise<void>}
   * @private
   */
  async _populateDatabase() {
    // Get all ConceptMap resources
    const conceptMapEntries = await this.packageLoader.getResourcesByType('ConceptMap');

    if (conceptMapEntries.length === 0) {
      return; // No concept maps in this package
    }

    const conceptMaps = [];
    for (const entry of conceptMapEntries) {
      const conceptMap = await this.packageLoader.loadFile(entry);
      if (conceptMap.url) {
        try {
          conceptMaps.push(new ConceptMap(conceptMap, this.packageLoader.fhirVersion())); // get in converted to R5 format
        } catch (e) {
          // one unacceptable concept map (e.g. one with contained resources, which the
          // server doesn't support) must not stop the rest of the package loading
          require('../../library/logger').getInstance().child({ module: 'tx' })
            .warn(`Package ${this.packageLoader.pid ? this.packageLoader.pid() : ''}: skipping ConceptMap ${conceptMap.url}: ${e.message}`);
        }
      }
    }

    if (conceptMaps.length > 0) {
      await this.database.batchUpsertConceptMaps(conceptMaps);
    }
  }

  /**
   * Fetches a concept map by URL and version
   * @param {string} url - The canonical URL of the concept map
   * @param {string} version - The version of the concept map
   * @returns {Promise<Object>} The requested concept map
   */
  async fetchConceptMap(url, version) {
    await this.initialize();
    this._validateFetchParams(url, version);

    // Try exact match first: url|version
    let key = `${url}|${version}`;
    if (this.conceptMapMap.has(key)) {
      return this.conceptMapMap.get(key);
    }

    // If version is semver, try url|major.minor
    try {
      if (VersionUtilities.isSemVer(version)) {
        const majorMinor = VersionUtilities.getMajMin(version);
        if (majorMinor) {
          key = `${url}|${majorMinor}`;
          if (this.conceptMapMap.has(key)) {
            return this.conceptMapMap.get(key);
          }
        }
      }
    } catch (error) {
      // Ignore version parsing errors
    }

    // Finally try just the URL
    if (this.conceptMapMap.has(url)) {
      return this.conceptMapMap.get(url);
    }

    return null;
  }

  /**
   * Searches for concept maps based on criteria
   * @param {Array<{name: string, value: string}>} searchParams - Search criteria
   * @returns {Promise<Array<Object>>} List of matching concept maps
   */
  async searchConceptMaps(searchParams, elements = null) {
    await this.initialize();
    this._validateSearchParams(searchParams);

    if (this.USE_DATABASE_SEARCH) {
      const results = await this.database.search(this.spaceId, searchParams, elements);
      return this.#excludedIds.size === 0 ? results
        : results.filter(r => !this.#excludedIds.has(stripIdPrefix(r.id, this.spaceId)));
    } else {
      const matches = [];
      const seen = new Set(); // Track by URL to avoid duplicates from versioned keys

      // Convert array format to object for easier access
      const params = {};
      for (const {name, value} of searchParams) {
        params[name] = value.toLowerCase();
      }

      const hasSearchParams = Object.keys(params).length > 0;

      for (const vs of this.conceptMapMap.values()) {
        const json = vs.jsonObj || vs;

        // Only process each ConceptMap once (use URL to deduplicate)
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
          // Ignore content-mode and supplements for ConceptMap search
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
          // the id is already prefixed (see assignIds)
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
   * Get statistics about the loaded concept maps
   * @returns {Promise<Object>} Statistics object
   */
  async getStatistics() {
    await this.initialize();
    return await this.database.getStatistics();
  }

  /**
   * Get the number of concept maps loaded into memory
   * @returns {number} Number of unique concept maps in map
   */
  getMapSize() {
    const uniqueUrls = new Set();
    for (const [key, conceptMap] of this.conceptMapMap.entries()) {
      if (!key.includes('|')) { // Only count base URL keys
        uniqueUrls.add(conceptMap.url);
      }
    }
    return uniqueUrls.size;
  }

  async fetchConceptMapById(id) {
    // the map is keyed by the concept map's own id (and its url); the concept map itself
    // carries the prefixed id, which is how a url key that happens to match is excluded
    const cm = this.conceptMapMap.get(stripIdPrefix(id, this.spaceId));
    return cm && cm.id === id ? cm : null;
  }

  sourcePackage() {
    return this.packageLoader.id();
  }

  // the concept maps left out by excludeUrls, by their own (unprefixed) id
  #excludedIds = new Set();

  /**
   * Leave out the concept maps with any of these urls: they can't be fetched, they aren't
   * found by search, and they aren't used for translation. The FHIR core package's concept
   * maps are left out where hl7.terminology provides the same url (see
   * Provider.applyTHOPrecedence). Must be called once the provider is initialized - the
   * database is shared, so it isn't changed.
   *
   * @param {Set<string>} urls
   */
  excludeUrls(urls) {
    const excluded = new Set();
    for (const cm of this.conceptMapMap.values()) {
      if (cm && urls.has(cm.url)) {
        excluded.add(cm);
      }
    }
    for (const [key, cm] of [...this.conceptMapMap]) {
      if (excluded.has(cm)) {
        this.conceptMapMap.delete(key);
      }
    }
    for (const cm of excluded) {
      this.#excludedIds.add(stripIdPrefix(cm.id, this.spaceId) ?? cm.id);
    }
  }

  prefixIds() {
    this.#applyIdPrefix();
  }

  #applyIdPrefix() {
    for (const cm of new Set(this.conceptMapMap.values())) {
      applyIdPrefix(cm, this.spaceId);
    }
  }

  async findConceptMapForTranslation(opContext, conceptMaps, sourceSystem, sourceScope, targetScope, targetSystem) {
    for (let cm of this.conceptMapMap.values()) {
      if (cm.providesTranslation(sourceSystem, sourceScope, targetScope, targetSystem)) {
        conceptMaps.push(cm);
      }
    }
  }

  cmCount() {
    return this.database.cmCount;
}

}

module.exports = {
  PackageConceptMapProvider
};
