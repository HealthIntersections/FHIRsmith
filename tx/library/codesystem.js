const { Language } = require("../../library/languages");
const {CanonicalResource} = require("./canonical-resource");
const {codeSystemFromR5, codeSystemToR5} = require("../xversion/xv-codesystem");
const {getValuePrimitive} = require("../../library/utilities");
const {VersionUtilities} = require("../../library/version-utilities");
const {countNested} = require("./nesting-limit");

const CodeSystemContentMode = Object.freeze({
  Complete: 'complete',
  NotPresent: 'not-present',
  Example: 'example',
  Fragment : 'fragment',
  Supplement : 'supplement'
});

/**
 * Represents a FHIR CodeSystem resource with version conversion support
 * @class
 */
class CodeSystem extends CanonicalResource {

  /**
   * Creates a new CodeSystem instance
   * @param {Object} jsonObj - The JSON object containing CodeSystem data
   * @param {string} [version='R5'] - FHIR version ('R3', 'R4', or 'R5')
   * @param {string} jsonObj.resourceType - Must be "CodeSystem"
   * @param {string} jsonObj.url - Canonical URL for the code system
   * @param {string} [jsonObj.version] - Version of the code system
   * @param {string} jsonObj.name - Name for this code system
   * @param {string} jsonObj.status - Publication status (draft|active|retired|unknown)
   * @param {Object[]} [jsonObj.concept] - Array of concept definitions
   */
  constructor(jsonObj, fhirVersion = 'R5', noMaps = false) {
    super(jsonObj, fhirVersion);
    // Convert to R5 format internally (modifies input for performance)
    this.jsonObj = codeSystemToR5(this.jsonObj, fhirVersion);
    try {
      // Bound the nesting before anything walks the concept tree recursively - see
      // nesting-limit.js. It has to precede validate(), which recurses itself, and it
      // runs on the noMaps path too: validate() is skipped there, but the count below
      // and every later consumer still walk the tree. The count is a by-product, so
      // callers (e.g. the resource cache) get a cheap O(1) sense of the resource size
      // without a second traversal.
      // Optional chaining because this runs ahead of validate()'s "expected object"
      // guard, and a null body must still get that message rather than a TypeError.
      this._conceptCount = countNested(this.jsonObj?.concept, 'concept', 'Invalid CodeSystem: concept');
      if (!noMaps) {
        this.validate();
      }
    } catch (e) {
      const id = this.jsonObj?.url ? `${this.jsonObj.url}|${this.jsonObj.version || ''}` : this.jsonObj?.name || 'unknown';
      const wrapped = new Error(`${e.message} (in ${id})`);
      // Don't let the rewrap swallow the HTTP shape the thrower asked for.
      if (e.statusCode) { wrapped.statusCode = e.statusCode; }
      if (e.issueCode) { wrapped.issueCode = e.issueCode; }
      throw wrapped;
    }
    this.checkContained();
    if (!noMaps) {
      this.buildMaps();
    }
  }

  /**
   * Number of concepts defined in this CodeSystem, counted recursively (nested
   * concepts included). Precalculated at construction time.
   * @returns {number}
   */
  conceptCount() {
    return this._conceptCount;
  }

  /**
   * Map of code to concept object for fast lookup
   * @type {Map<string, Object>}
   */
  codeMap = new Map();

  /**
   * Map of code to concept object for fast lookup - not case sensitive, only for non-case sensitive code systems
   * @type {Map<string, Object>}
   */
  codeMapNC;

  /**
   * Map of display text to concept object for fast lookup
   * @type {Map<string, Object>}
   */
  displayMap = new Map();

  /**
   * Map of parent code to array of child codes
   * @type {Map<string, string[]>}
   */
  parentToChildrenMap = new Map();

  /**
   * Map of child code to array of parent codes
   * @type {Map<string, string[]>}
   */
  childToParentsMap = new Map();

  hasMultiHierarchy = false;

  /**
   * Static factory method for convenience
   * @param {string} jsonString - JSON string representation of CodeSystem
   * @param {string} [version='R5'] - FHIR version ('R3', 'R4', or 'R5')
   * @returns {CodeSystem} New CodeSystem instance
   */
  static fromJSON(jsonString, version = 'R5') {
    return new CodeSystem(JSON.parse(jsonString), version);
  }

  /**
   * Returns JSON string representation
   * @param {string} [version='R5'] - Target FHIR version ('R3', 'R4', or 'R5')
   * @returns {string} JSON string
   */
  toJSONString(version = 'R5') {
    const outputObj = codeSystemFromR5(this.jsonObj, version);
    return JSON.stringify(outputObj);
  }

  /**
   * Validates that this is a proper CodeSystem resource
   * @throws {Error} If validation fails
   */
  /**
   * Enhanced validate method for CodeSystem class
   * Add this to replace the existing validate() method
   */
  validate() {
    if (!this.jsonObj || typeof this.jsonObj !== 'object') {
      throw new Error('Invalid CodeSystem: expected object');
    }

    if (this.jsonObj.resourceType !== 'CodeSystem') {
      throw new Error(`Invalid CodeSystem: resourceType must be "CodeSystem", got "${this.jsonObj.resourceType}"`);
    }

    if (!this.jsonObj.url || typeof this.jsonObj.url !== 'string') {
      throw new Error('Invalid CodeSystem: url is required and must be a string');
    }

    if (this.jsonObj.status && typeof this.jsonObj.status !== 'string') {
      throw new Error('Invalid CodeSystem: status must be a string');
    }
    if (this.jsonObj.status && typeof this.jsonObj.status == 'string') {
      const validStatuses = ['draft', 'active', 'retired', 'unknown'];
      if (!validStatuses.includes(this.jsonObj.status)) {
        throw new Error(`Invalid CodeSystem: status must be one of ${validStatuses.join(', ')}, got "${this.jsonObj.status}"`);
      }
    }

    // Validate identifier array
    if (this.jsonObj.identifier) {
      // Convert single identifier object to array if needed (for R3)
      if (!Array.isArray(this.jsonObj.identifier)) {
        this.jsonObj.identifier = [this.jsonObj.identifier];
      }

      this._validateArray(this.jsonObj.identifier, 'identifier', (identifier, index) => {
        if (!identifier || typeof identifier !== 'object') {
          throw new Error(`Invalid CodeSystem: identifier[${index}] must be an object`);
        }
      });
    }

    // Validate jurisdiction array
    if (this.jsonObj.jurisdiction) {
      if (!Array.isArray(this.jsonObj.jurisdiction)) {
        throw new Error('Invalid CodeSystem: jurisdiction must be an array if present');
      }
      this._validateArray(this.jsonObj.jurisdiction, 'jurisdiction', (jurisdiction, index) => {
        if (!jurisdiction || typeof jurisdiction !== 'object') {
          throw new Error(`Invalid CodeSystem: jurisdiction[${index}] must be an object`);
        }
      });
    }

    // Validate useContext array
    if (this.jsonObj.useContext) {
      if (!Array.isArray(this.jsonObj.useContext)) {
        throw new Error('Invalid CodeSystem: useContext must be an array if present');
      }
      this._validateArray(this.jsonObj.useContext, 'useContext', (useContext, index) => {
        if (!useContext || typeof useContext !== 'object') {
          throw new Error(`Invalid CodeSystem: useContext[${index}] must be an object`);
        }
      });
    }

    // Validate filter array
    if (this.jsonObj.filter) {
      if (!Array.isArray(this.jsonObj.filter)) {
        throw new Error('Invalid CodeSystem: filter must be an array if present');
      }
      this._validateArray(this.jsonObj.filter, 'filter', (filter, index) => {
        if (!filter || typeof filter !== 'object') {
          throw new Error(`Invalid CodeSystem: filter[${index}] must be an object`);
        }
        if (filter.operator && !Array.isArray(filter.operator)) {
          throw new Error(`Invalid CodeSystem: filter[${index}].operator must be an array if present`);
        }
        if (filter.operator) {
          this._validateArray(filter.operator, `filter[${index}].operator`, (operator, opIndex) => {
            if (typeof operator !== 'string') {
              throw new Error(`Invalid CodeSystem: filter[${index}].operator[${opIndex}] must be a string`);
            }
          });
        }
      });
    }

    // Validate property array
    if (this.jsonObj.property) {
      if (!Array.isArray(this.jsonObj.property)) {
        throw new Error('Invalid CodeSystem: property must be an array if present');
      }
      this._validateArray(this.jsonObj.property, 'property', (property, index) => {
        if (!property || typeof property !== 'object') {
          throw new Error(`Invalid CodeSystem: property[${index}] must be an object`);
        }
        if (!property.code || typeof property.code !== 'string') {
          throw new Error(`Invalid CodeSystem: property[${index}].code is required and must be a string`);
        }
      });
    }

    // Validate concept array
    if (this.jsonObj.concept) {
      if (!Array.isArray(this.jsonObj.concept)) {
        throw new Error('Invalid CodeSystem: concept must be an array if present');
      }
      this._validateConceptArray(this.jsonObj.concept, 'concept');
    }
  }

  /**
   * Helper method to validate arrays for null/undefined elements
   * @param {Array} array - The array to validate
   * @param {string} path - Path description for error messages
   * @param {Function} [itemValidator] - Optional function to validate each item
   * @private
   */
  _validateArray(array, path, itemValidator) {
    if (!Array.isArray(array)) {
      throw new Error(`Invalid CodeSystem: ${path} must be an array`);
    }

    array.forEach((item, index) => {
      if (item === null || item === undefined) {
        throw new Error(`Invalid CodeSystem: ${path}[${index}] is null or undefined`);
      }
      if (itemValidator) {
        itemValidator(item, index);
      }
    });
  }

  /**
   * Recursively validates concept arrays and their nested structure
   * @param {Array} concepts - Array of concepts to validate
   * @param {string} path - Path description for error messages
   * @private
   */
  _validateConceptArray(concepts, path) {
    this._validateArray(concepts, path, (concept, index) => {
      const conceptPath = `${path}[${index}]`;

      if (!concept || typeof concept !== 'object') {
        throw new Error(`Invalid CodeSystem: ${conceptPath} must be an object`);
      }

      if (!concept.code || typeof concept.code !== 'string') {
        throw new Error(`Invalid CodeSystem: ${conceptPath}.code is required and must be a string`);
      }

      // Validate designation array
      if (concept.designation) {
        if (!Array.isArray(concept.designation)) {
          throw new Error(`Invalid CodeSystem: ${conceptPath}.designation must be an array if present`);
        }
        this._validateArray(concept.designation, `${conceptPath}.designation`, (designation, desigIndex) => {
          if (!designation || typeof designation !== 'object') {
            throw new Error(`Invalid CodeSystem: ${conceptPath}.designation[${desigIndex}] must be an object`);
          }
          // We could add more specific designation validation here if needed
        });
      }

      // Validate property array
      if (concept.property) {
        if (!Array.isArray(concept.property)) {
          throw new Error(`Invalid CodeSystem: ${conceptPath}.property must be an array if present`);
        }
        this._validateArray(concept.property, `${conceptPath}.property`, (property, propIndex) => {
          if (!property || typeof property !== 'object') {
            throw new Error(`Invalid CodeSystem: ${conceptPath}.property[${propIndex}] must be an object`);
          }
          if (!property.code || typeof property.code !== 'string') {
            throw new Error(`Invalid CodeSystem: ${conceptPath}.property[${propIndex}].code is required and must be a string`);
          }
        });
      }

      // Recursively validate nested concepts
      if (concept.concept) {
        if (!Array.isArray(concept.concept)) {
          throw new Error(`Invalid CodeSystem: ${conceptPath}.concept must be an array if present`);
        }
        this._validateConceptArray(concept.concept, `${conceptPath}.concept`);
      }
    });
  }

  /**
   * Builds internal maps for fast concept lookup and hierarchy navigation
   * @private
   */
  buildMaps() {
    this.codeMap.clear();
    if (this.caseInsensitive()) {
      this.codeMapNC = new Map();
    }
    this.displayMap.clear();
    this.parentToChildrenMap.clear();
    this.childToParentsMap.clear();

    if (!this.jsonObj.concept) {
      return;
    }

    // First pass: build basic maps and collect all concepts (including nested)
    const allConcepts = [];
    this._collectAllConcepts(this.jsonObj.concept, allConcepts);

    allConcepts.forEach(concept => {
      // Build code and display maps
      this.codeMap.set(concept.code, concept);
      if (this.caseInsensitive()) {
        this.codeMapNC.set(concept.code.toLowerCase(), concept);
      }
      if (concept.display) {
        this.displayMap.set(concept.display, concept);
      }
    });

    // Second pass: build hierarchy maps
    allConcepts.forEach(concept => {
      this._buildHierarchyMaps(concept);
    });

    // Third pass: handle nested concept structures
    this._buildNestedHierarchy(this.jsonObj.concept);

    this.hasMultiHierarchy = Array.from(this.childToParentsMap.values()).some(parents => parents.length > 1);
  }

  /**
   * Recursively collects all concepts including nested ones
   * @param {Object[]} concepts - Array of concepts
   * @param {Object[]} allConcepts - Accumulator for all concepts
   * @private
   */
  _collectAllConcepts(concepts, allConcepts) {
    concepts.forEach(concept => {
      allConcepts.push(concept);
      if (concept.concept && Array.isArray(concept.concept)) {
        this._collectAllConcepts(concept.concept, allConcepts);
      }
    });
  }

  /**
   * Builds hierarchy maps from concept properties
   * @param {Object} concept - The concept to process
   * @private
   */
  _buildHierarchyMaps(concept) {
    if (!concept.property || !Array.isArray(concept.property)) {
      return;
    }

    concept.property.forEach(property => {
      if ((property.code === 'parent' || this.isPropUri(property.code, 'http://hl7.org/fhir/concept-properties#parent')) && property.valueCode) {
        // This concept has a parent
        this._addToChildToParentsMap(concept.code, property.valueCode);
        this._addToParentToChildrenMap(property.valueCode, concept.code);
      } else if ((property.code === 'child' || this.isPropUri(property.code, 'http://hl7.org/fhir/concept-properties#child')) && property.valueCode) {
        // This concept has a child
        this._addToParentToChildrenMap(concept.code, property.valueCode);
        this._addToChildToParentsMap(property.valueCode, concept.code);
      }
    });
  }

  /**
   * Builds hierarchy from nested concept structures
   * @param {Object[]} concepts - Array of concepts
   * @param {string} [parentCode] - Code of parent concept
   * @private
   */
  _buildNestedHierarchy(concepts, parentCode = null) {
    concepts.forEach(concept => {
      if (parentCode) {
        this._addToChildToParentsMap(concept.code, parentCode);
        this._addToParentToChildrenMap(parentCode, concept.code);
      }

      if (concept.concept && Array.isArray(concept.concept)) {
        this._buildNestedHierarchy(concept.concept, concept.code);
      }
    });
  }

  /**
   * Adds a parent-child relationship to the child-to-parents map
   * @param {string} childCode - The child concept code
   * @param {string} parentCode - The parent concept code
   * @private
   */
  _addToChildToParentsMap(childCode, parentCode) {
    if (!this.childToParentsMap.has(childCode)) {
      this.childToParentsMap.set(childCode, []);
    }
    const parents = this.childToParentsMap.get(childCode);
    if (!parents.includes(parentCode)) {
      parents.push(parentCode);
    }
  }

  /**
   * Adds a parent-child relationship to the parent-to-children map
   * @param {string} parentCode - The parent concept code
   * @param {string} childCode - The child concept code
   * @private
   */
  _addToParentToChildrenMap(parentCode, childCode) {
    if (!this.parentToChildrenMap.has(parentCode)) {
      this.parentToChildrenMap.set(parentCode, []);
    }
    const children = this.parentToChildrenMap.get(parentCode);
    if (!children.includes(childCode)) {
      children.push(childCode);
    }
  }

  /**
   * Gets a concept by its code
   * @param {string} code - The concept code to look up
   * @returns {Object|undefined} The concept object or undefined if not found
   */
  getConceptByCode(code) {
    return this.caseInsensitive() ? this.codeMapNC.get(code.toLowerCase()) : this.codeMap.get(code);
  }

  /**
   * Gets a concept by its display text
   * @param {string} display - The display text to look up
   * @returns {Object|undefined} The concept object or undefined if not found
   */
  getConceptByDisplay(display) {
    return this.displayMap.get(display);
  }

  /**
   * Gets all child codes for a given parent code
   * @param {string} parentCode - The parent concept code
   * @returns {string[]} Array of child codes (empty array if no children)
   */
  getChildren(parentCode) {
    return this.parentToChildrenMap.get(parentCode) || [];
  }

  /**
   * Gets all parent codes for a given child code
   * @param {string} childCode - The child concept code
   * @returns {string[]} Array of parent codes (empty array if no parents)
   */
  getParents(childCode) {
    return this.childToParentsMap.get(childCode) || [];
  }

  /**
   * Gets all descendant codes (children, grandchildren, etc.) for a given code
   * @param {string} code - The ancestor concept code
   * @returns {string[]} Array of all descendant codes
   */
  getDescendants(code) {
    const descendants = [];
    const descSet = new Set();
    this.addDescendents(descendants, descSet, code, false);
    return descendants;
  }

  addDescendents(descendants, descSet, current, add) {
    if (!descSet.has(current)) {
      descSet.add(current);
      if (add) {
        descendants.push(current);
      }
      const children = this.getChildren(current);
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        this.addDescendents(descendants, descSet, child, true);
      }
    }
  }
  /**
   * Gets all ancestor codes (parents, grandparents, etc.) for a given code
   * @param {string} code - The descendant concept code
   * @returns {string[]} Array of all ancestor codes
   */
  getAncestors(code) {
    const ancestors = new Set();
    const visited = new Set([code]); // Track visited codes to handle circular references
    const toProcess = [code];

    while (toProcess.length > 0) {
      const current = toProcess.pop();
      const parents = this.getParents(current);

      parents.forEach(parent => {
        if (!visited.has(parent)) {
          visited.add(parent);
          ancestors.add(parent);
          toProcess.push(parent);
        }
      });
    }

    return Array.from(ancestors);
  }

  /**
   * Checks if a code is a descendant of another code
   * @param {string} descendantCode - The potential descendant code
   * @param {string} ancestorCode - The potential ancestor code
   * @returns {boolean} True if descendantCode is a descendant of ancestorCode
   */
  isDescendantOf(descendantCode, ancestorCode) {
    return this.getAncestors(descendantCode).includes(ancestorCode);
  }

  /**
   * Gets root concepts (concepts with no parents)
   * @returns {string[]} Array of root concept codes
   */
  getRootConcepts() {
    return Array.from(this.codeMap.keys()).filter(code =>
      this.getParents(code).length === 0
    );
  }

  /**
   * Gets leaf concepts (concepts with no children)
   * @returns {string[]} Array of leaf concept codes
   */
  getLeafConcepts() {
    return Array.from(this.codeMap.keys()).filter(code =>
      this.getChildren(code).length === 0
    );
  }

  /**
   * Checks if a code exists in this code system
   * @param {string} code - The code to check
   * @returns {boolean} True if the code exists
   */
  hasCode(code) {
    return this.caseInsensitive() ? this.codeMapNC.has(code.toLowerCase()) : this.codeMap.has(code);
  }

  /**
   * Gets all codes in this code system
   * @returns {string[]} Array of all codes
   */
  getAllCodes() {
    return Array.from(this.codeMap.keys());
  }

  /**
   * Gets all concepts in this code system
   * @returns {Object[]} Array of all concept objects
   */
  getAllConcepts() {
    return Array.from(this.codeMap.values());
  }

  /**
   * Gets basic info about this code system
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
      fhirVersion: this.fhirVersion,
      conceptCount: this.codeMap.size,
      rootConceptCount: this.getRootConcepts().length,
      leafConceptCount: this.getLeafConcepts().length
    };
  }

  static isUseADisplay(use) {
    return (use != null) || true; // for now
  }

  static makeUseForDisplay() {
    return null;
  }

  /**
   * Gets the language for this CodeSystem as a Language object
   * @returns {Language|null} Parsed language or null if not specified
   */
  langCode() {
    return this.jsonObj.language ? new Language(this.jsonObj.language) : null;
  }

  get content() {
    return this.jsonObj.content;
  }

  hasHierarchy() {
    return this.parentToChildrenMap.size > 0 || this.childToParentsMap.size > 0;
  }

  caseInsensitive() {
    return this.jsonObj.caseSensitive == undefined || this.jsonObj.caseSensitive == false;
  }

  get id() {
    return this.jsonObj.id;
  }

  set id(value) {
    this.jsonObj.id = value;
  }

  isLangPack() {
    // todo: this is a temporary work around until fhir.tx.support.r4#0.37.0 is released that properly marks this as a language pack
    if (this.jsonObj.url === 'https://terminology.dhp.uz/fhir/CodeSystem/loinc-supplement-uz') {
      return true;
    }
    return (this.jsonObj.extension || []).find(x => x.url == 'http://hl7.org/fhir/StructureDefinition/codesystem-supplement-type' && getValuePrimitive(x) == 'lang-pack');
  }

  isPropUri(code, uri) {
    return (this.jsonObj.property || []).find(x => x.code == code && x.uri == uri);
  }

  isSupplementFor(url, version) {
    if (this.jsonObj.content !== 'supplement') {
      return false;
    }
    let suppU = this.jsonObj.supplements;
    if (suppU == url) {
      return true;
    }
    if (suppU.startsWith(url + '|')) {
      let suppV = suppU.substring(suppU.indexOf('|') + 1);
      return VersionUtilities.versionMatchesByAlgorithm(suppV, version, VersionUtilities.guessVersionAlgorithmFromVersion(version));
    }
    return false;
  }
}

module.exports = { CodeSystem, CodeSystemContentMode };