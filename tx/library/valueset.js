const {CanonicalResource} = require("./canonical-resource");
const {valueSetToR5, valueSetFromR5} = require("../xversion/xv-valueset");
const {countNested} = require("./nesting-limit");

/**
 * Represents a FHIR ValueSet resource with version conversion support
 * @class
 */
class ValueSet extends CanonicalResource {

  /**
   * Creates a new ValueSet instance
   * @param {Object} jsonObj - The JSON object containing ValueSet data
   * @param {string} [fhirVersion='R5'] - FHIR version ('R3', 'R4', or 'R5')
   * @param {string} jsonObj.resourceType - Must be "ValueSet"
   * @param {string} jsonObj.url - Canonical URL for the value set
   * @param {string} [jsonObj.version] - Version of the value set
   * @param {string} jsonObj.name - Name for this value set
   * @param {string} jsonObj.status - Publication status (draft|active|retired|unknown)
   * @param {Object} [jsonObj.compose] - Content logical definition of the value set
   * @param {Object} [jsonObj.expansion] - Used when the value set is "expanded"
   */
  constructor(jsonObj, fhirVersion = 'R5') {
    super(jsonObj, fhirVersion);
    // Convert to R5 format internally (modifies input for performance)
    this.jsonObj = valueSetToR5(jsonObj, fhirVersion);
    this.validate();
    this.checkContained();
    this.buildMaps();
    // Precalculated at construction so callers (e.g. the resource cache) have a
    // cheap O(1) sense of how large this resource is.
    this._conceptCount = ValueSet._countConcepts(this.jsonObj, this._containsCount);
  }

  /**
   * What circular reference detection knows this value set by: its versioned url, or, for
   * a contained value set (see TerminologyWorker.findValueSet), its container's key plus
   * #id - a contained value set's own url, if it has one, says nothing about which
   * container it came from. null for a value set with no url that isn't contained.
   * @returns {string|null}
   */
  get contextKey() {
    if (this.isContained && this.container) {
      const base = this.container.contextKey || this.container.vurl || '(unidentified)';
      return `${base}#${this.jsonObj.id || ''}`;
    }
    return this.vurl || null;
  }

  /**
   * Number of concepts this ValueSet carries: the enumerated concepts in its
   * compose (include + exclude `concept` lists) plus any concepts in an inline
   * expansion (`expansion.contains`, counted recursively). Note this counts the
   * concepts *present in the resource*, not the (possibly unbounded) size of the
   * value set's full expansion. Precalculated at construction time.
   * @returns {number}
   */
  conceptCount() {
    return this._conceptCount;
  }

  static _countConcepts(jsonObj, containsCount) {
    let n = 0;
    const compose = jsonObj && jsonObj.compose;
    if (compose) {
      for (const inc of (compose.include || [])) {
        n += Array.isArray(inc.concept) ? inc.concept.length : 0;
      }
      for (const exc of (compose.exclude || [])) {
        n += Array.isArray(exc.concept) ? exc.concept.length : 0;
      }
    }
    return n + (containsCount || 0);
  }

  /**
   * Map of system(#version)|code to expansion contains item for fast lookup
   * @type {Map<string, Object>}
   */
  codeMap = new Map();

  /**
   * Number of entries in expansion.contains, nested ones included. Counted by the
   * depth-bounding walk in validate(), so the tree is only traversed once.
   * @type {number}
   */
  _containsCount = 0;

  /**
   * Static factory method for convenience
   * @param {string} jsonString - JSON string representation of ValueSet
   * @param {string} [version='R5'] - FHIR version ('R3', 'R4', or 'R5')
   * @returns {ValueSet} New ValueSet instance
   */
  static fromJSON(jsonString, version = 'R5') {
    return new ValueSet(JSON.parse(jsonString), version);
  }


  /**
   * Returns JSON string representation
   * @param {string} [version='R5'] - Target FHIR version ('R3', 'R4', or 'R5')
   * @returns {string} JSON string
   */
  toJSONString(version = 'R5') {
    const outputObj = valueSetFromR5(this.jsonObj, version);
    return JSON.stringify(outputObj);
  }

  /**
   * Gets the FHIR version this ValueSet was loaded from
   * @returns {string} FHIR version ('R3', 'R4', or 'R5')
   */
  getFHIRVersion() {
    return this.version;
  }

  /**
   * Validates that this is a proper ValueSet resource
   * @throws {Error} If validation fails
   */
  validate() {
    if (!this.jsonObj || typeof this.jsonObj !== 'object') {
      throw new Error('Invalid ValueSet: expected object');
    }

    if (this.jsonObj.resourceType !== 'ValueSet') {
      throw new Error(`Invalid ValueSet: resourceType must be "ValueSet", got "${this.jsonObj.resourceType}"`);
    }

    if (this.jsonObj.url && typeof this.jsonObj.url !== 'string') {
      throw new Error('Invalid ValueSet: url must be a string if present');
    }

    if (this.jsonObj.name && typeof this.jsonObj.name !== 'string') {
      throw new Error('Invalid ValueSet: name must be a string if present');
    }

    if (this.jsonObj.status && typeof this.jsonObj.status !== 'string') {
      throw new Error('Invalid ValueSet: status must be a string if present');
    }

    const validStatuses = ['draft', 'active', 'retired', 'unknown'];
    if (this.jsonObj.status && !validStatuses.includes(this.jsonObj.status)) {
      throw new Error(`Invalid ValueSet: status must be one of ${validStatuses.join(', ')}, got "${this.jsonObj.status}"`);
    }

    // Validate identifier - should always be array (no conversion needed for ValueSet)
    if (this.jsonObj.identifier && !Array.isArray(this.jsonObj.identifier)) {
      throw new Error('Invalid ValueSet: identifier should be an array');
    }

    // Validate compose structure if present
    if (this.jsonObj.compose) {
      if (this.jsonObj.compose.include && !Array.isArray(this.jsonObj.compose.include)) {
        throw new Error('Invalid ValueSet: compose.include must be an array if present');
      }
      if (this.jsonObj.compose.exclude && !Array.isArray(this.jsonObj.compose.exclude)) {
        throw new Error('Invalid ValueSet: compose.exclude must be an array if present');
      }
    }

    // Validate expansion structure if present
    if (this.jsonObj.expansion) {
      if (this.jsonObj.expansion.contains && !Array.isArray(this.jsonObj.expansion.contains)) {
        throw new Error('Invalid ValueSet: expansion.contains must be an array if present');
      }
      // Bound the nesting before anything walks it recursively - see nesting-limit.js.
      // This has to happen before buildMaps(), which is itself a recursive walker, so
      // it lives here rather than alongside the concept count in the constructor.
      this._containsCount = countNested(this.jsonObj.expansion.contains, 'contains',
        'Invalid ValueSet: expansion.contains');
    }
  }

  /**
   * Builds internal maps for fast expansion lookup
   * @private
   */
  buildMaps() {
    this.id = this.jsonObj.id;
    this.codeMap.clear();

    if (!this.jsonObj.expansion || !this.jsonObj.expansion.contains) {
      return;
    }

    // Build map of system(#version)|code -> expansion contains item
    this._buildExpansionMap(this.jsonObj.expansion.contains);
  }

  /**
   * Recursively builds expansion map from contains items
   * @param {Object[]} contains - Array of expansion contains items
   * @private
   */
  _buildExpansionMap(contains) {
    contains.forEach(item => {
      if (item.system && item.code) {
        const key = this._buildCodeKey(item.system, item.version, item.code);
        this.codeMap.set(key, item);
      }

      // Handle nested contains (hierarchical expansions)
      if (item.contains && Array.isArray(item.contains)) {
        this._buildExpansionMap(item.contains);
      }
    });
  }

  /**
   * Builds a lookup key for system(#version)|code
   * @param {string} system - Code system URL
   * @param {string} [version] - Code system version
   * @param {string} code - Code value
   * @returns {string} Lookup key
   * @private
   */
  _buildCodeKey(system, version, code) {
    if (version) {
      return `${system}#${version}|${code}`;
    }
    return `${system}|${code}`;
  }

  /**
   * Gets an expansion item by system and code
   * @param {string} system - Code system URL
   * @param {string} code - Code value
   * @param {string} [version] - Code system version
   * @returns {Object|undefined} The expansion contains item or undefined if not found
   */
  getCode(system, code, version = null) {
    const key = this._buildCodeKey(system, version, code);
    return this.codeMap.get(key);
  }

  /**
   * Checks if a code exists in this value set expansion
   * @param {string} system - Code system URL
   * @param {string} code - Code value
   * @param {string} [version] - Code system version
   * @returns {boolean} True if the code exists in expansion
   */
  hasCode(system, code, version = null) {
    const key = this._buildCodeKey(system, version, code);
    return this.codeMap.has(key);
  }

  /**
   * Finds a contains entry in the expansion by system, version, and code
   * Searches recursively through nested contains
   * @param {string} systemUri - Code system URL
   * @param {string} version - Code system version (can be empty string)
   * @param {string} code - Code value
   * @returns {Object|null} The contains entry or null if not found
   */
  findContains(systemUri, version, code) {
    if (!this.jsonObj.expansion || !this.jsonObj.expansion.contains) {
      return null;
    }
    return this._findContainsInList(this.jsonObj.expansion.contains, systemUri, version, code);
  }

  /**
   * Recursively searches for a contains entry in a list
   * @param {Object[]} list - Array of contains entries
   * @param {string} systemUri - Code system URL
   * @param {string} version - Code system version
   * @param {string} code - Code value
   * @returns {Object|null} The contains entry or null
   * @private
   */
  _findContainsInList(list, systemUri, version, code) {
    for (const cc of list) {
      if (systemUri === cc.system && code === cc.code &&
        (!version || version === cc.version)) {
        return cc;
      }
      if (cc.contains && cc.contains.length > 0) {
        const found = this._findContainsInList(cc.contains, systemUri, version, code);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  /**
   * Gets all codes in this value set expansion
   * @returns {Object[]} Array of {system, version, code, display} objects
   */
  getAllCodes() {
    return Array.from(this.codeMap.values()).map(item => ({
      system: item.system,
      version: item.version,
      code: item.code,
      display: item.display
    }));
  }

  /**
   * Gets all codes from a specific system
   * @param {string} system - Code system URL
   * @param {string} [version] - Code system version
   * @returns {Object[]} Array of expansion contains items from the system
   */
  getCodesFromSystem(system, version = null) {
    return Array.from(this.codeMap.values()).filter(item => {
      if (version) {
        return item.system === system && item.version === version;
      }
      return item.system === system;
    });
  }

  /**
   * Gets all unique systems in this value set expansion
   * @returns {string[]} Array of system URLs
   */
  getSystems() {
    const systems = new Set();
    this.codeMap.forEach(item => {
      if (item.system) {
        systems.add(item.system);
      }
    });
    return Array.from(systems);
  }

  /**
   * Checks if the value set is expanded (has expansion.contains)
   * @returns {boolean} True if the value set has an expansion
   */
  isExpanded() {
    return !!(this.jsonObj.expansion && this.jsonObj.expansion.contains && this.jsonObj.expansion.contains.length > 0);
  }

  /**
   * Gets the total count from expansion, if available
   * @returns {number|undefined} Total count or undefined if not available
   */
  getExpansionTotal() {
    return this.jsonObj.expansion?.total;
  }

  /**
   * Gets basic info about this value set
   * @returns {Object} Basic information object
   */
  getInfo() {
    return {
      resourceType: this.jsonObj.resourceType,
      url: this.jsonObj.url,
      version: this.jsonObj.version,
      name: this.jsonObj.name,
      title: this.jsonObj.title,
      status: this.jsonObj.status,
      fhirVersion: this.version,
      isExpanded: this.isExpanded(),
      expansionTotal: this.getExpansionTotal(),
      codeCount: this.codeMap.size,
      systemCount: this.getSystems().length
    };
  }
}

module.exports = ValueSet;