const {CanonicalResource} = require("./canonical-resource");
const {VersionUtilities} = require("../../library/version-utilities");
const {conceptMapToR5, conceptMapFromR5} = require("../xversion/xv-conceptmap");

/**
 * Represents a FHIR ConceptMap resource with version conversion support
 * @class
 */
class ConceptMap extends CanonicalResource {


  /**
   * Creates a new ConceptMap instance
   * @param {Object} jsonObj - The JSON object containing ConceptMap data
   * @param {string} [version='R5'] - FHIR version ('R3', 'R4', or 'R5')
   */
  constructor(jsonObj, fhirVersion = 'R5') {
    super(jsonObj, fhirVersion);
    // Convert to R5 format internally (modifies input for performance)
    this.jsonObj = conceptMapToR5(jsonObj, fhirVersion);
    this.validate();
    this.id = this.jsonObj.id;
    // Precalculated at construction so callers (e.g. the resource cache) have a
    // cheap O(1) sense of how large this resource is.
    this._conceptCount = ConceptMap._countConcepts(this.jsonObj);
  }

  /**
   * Number of concept nodes this ConceptMap carries: every source `element` plus
   * every `target` across all groups (each is a coded node, so this approximates
   * the resource's size). Precalculated at construction time.
   * @returns {number}
   */
  conceptCount() {
    return this._conceptCount;
  }

  static _countConcepts(jsonObj) {
    let n = 0;
    for (const g of ((jsonObj && jsonObj.group) || [])) {
      for (const e of (g.element || [])) {
        n++;
        n += Array.isArray(e.target) ? e.target.length : 0;
      }
    }
    return n;
  }

  /**
   * Static factory method for convenience
   * @param {string} jsonString - JSON string representation of ValueSet
   * @param {string} [version='R5'] - FHIR version ('R3', 'R4', or 'R5')
   * @returns {ValueSet} New ValueSet instance
   */
  static fromJSON(jsonString, version = 'R5') {
    return new ConceptMap(JSON.parse(jsonString), version);
  }

  /**
   * Returns JSON string representation
   * @param {string} [version='R5'] - Target FHIR version ('R3', 'R4', or 'R5')
   * @returns {string} JSON string
   */
  toJSONString(version = 'R5') {
    const outputObj = conceptMapFromR5(this.jsonObj, version);
    return JSON.stringify(outputObj);
  }

    /**
   * Gets the FHIR version this ConceptMap was loaded from
   * @returns {string} FHIR version ('R3', 'R4', or 'R5')
   */
  getFHIRVersion() {
    return this.version;
  }

  /**
   * Validates that this is a proper ConceptMap resource
   * @throws {Error} If validation fails
   */
  validate() {
    if (!this.jsonObj || typeof this.jsonObj !== 'object') {
      throw new Error('Invalid ConceptMap: expected object');
    }

    if (this.jsonObj.resourceType !== 'ConceptMap') {
      throw new Error(`Invalid ConceptMap: resourceType must be "ConceptMap", got "${this.jsonObj.resourceType}"`);
    }

    if (!this.jsonObj.url || typeof this.jsonObj.url !== 'string') {
      throw new Error('Invalid ConceptMap: url is required and must be a string');
    }

    if (this.jsonObj.name && typeof this.jsonObj.name !== 'string') {
      throw new Error('Invalid ConceptMap: name must be a string if present');
    }

    if (!this.jsonObj.status || typeof this.jsonObj.status !== 'string') {
      throw new Error('Invalid ConceptMap: status is required and must be a string');
    }

    const validStatuses = ['draft', 'active', 'retired', 'unknown'];
    if (!validStatuses.includes(this.jsonObj.status)) {
      throw new Error(`Invalid ConceptMap: status must be one of ${validStatuses.join(', ')}, got "${this.jsonObj.status}"`);
    }

    // Validate identifier - should be array in R5 after conversion
    if (this.jsonObj.identifier && !Array.isArray(this.jsonObj.identifier)) {
      throw new Error('Invalid ConceptMap: identifier should be an array (converted from R3/R4 format)');
    }

    // Validate group structure if present
    if (this.jsonObj.group && !Array.isArray(this.jsonObj.group)) {
      throw new Error('Invalid ConceptMap: group must be an array if present');
    }

    // Validate group elements
    if (this.jsonObj.group) {
      this.jsonObj.group.forEach((group, groupIndex) => {
        if (group.element && !Array.isArray(group.element)) {
          throw new Error(`Invalid ConceptMap: group[${groupIndex}].element must be an array if present`);
        }

        if (group.element) {
          group.element.forEach((element, elementIndex) => {

            if (element.target && !Array.isArray(element.target)) {
              throw new Error(`Invalid ConceptMap: group[${groupIndex}].element[${elementIndex}].target must be an array if present`);
            }
          });
        }
      });
    }
  }

  providesTranslation(sourceSystem, sourceScope, targetScope, targetSystem) {
    let source = this.sourceScope;
    let target = this.targetScope;
    if (this.canonicalMatches(source, sourceScope) && this.canonicalMatches(target, targetScope)) {
      return true;
    }
    for (let grp of this.jsonObj.group || []) {
      let source = grp.source;
      let target = grp.target;
      if (this.canonicalMatches(source, sourceSystem) && this.canonicalMatches(target, targetSystem)) {
        return true;
      }
    }
    return false;
  }


  listTranslations(coding, targetScope, targetSystem) {
    let result = [];
    let vurl = VersionUtilities.vurl(coding.system, coding.version);

    let all = this.canonicalMatches(targetScope, this.targetScope);
    for (const g of this.jsonObj.group || []) {
      const sourceOk = this.canonicalMatches(vurl, g.source);
      const targetOk = !targetSystem || this.canonicalMatches(targetSystem, g.target);
      if (all || (sourceOk && targetOk)) {
        for (const em of g.element || []) {
          if (em.code === coding.code) {
            let match = {
              group: g,
              match: em
            };
            result.push(match);
          }
        }
      }
    }
    return result;
  }

  /**
   * The canonical references this map defers to. Only group.unmapped.otherMap creates
   * such a dependency: a map that names another map cannot be resolved without it, so
   * it has to be consulted first.
   * @returns {string[]} canonical references, as written (may or may not be versioned)
   */
  listDependencies() {
    const result = [];
    for (const g of this.jsonObj.group || []) {
      if (g.unmapped && g.unmapped.mode === 'other-map' && g.unmapped.otherMap) {
        if (!result.includes(g.unmapped.otherMap)) {
          result.push(g.unmapped.otherMap);
        }
      }
    }
    return result;
  }

  /**
   * The groups that would have been consulted for this coding, whether or not any of
   * their elements matched. group.unmapped only applies to a group that was in scope
   * for the translation, so the caller needs the same source/target test that
   * listTranslations applies - without the per-element filter.
   *
   * "In scope" here is only about this group's source and target code systems. It assumes
   * the MAP itself is in scope, which is a separate and prior question: ConceptMap.sourceScope
   * limits the map to codes that are members of that value set, and a map that does not cover
   * the code has no groups in scope at all, whatever their systems say. That test needs a value
   * set lookup and a $validate-code, so it lives in the worker (TranslateWorker.filterMapsByScope)
   * and is applied to the map before this is ever called. Do not read a group coming back from
   * here as evidence that the map applies.
   * @returns {Object[]} the matching group objects
   */
  listGroupsInScope(coding, targetScope, targetSystem) {
    const result = [];
    const vurl = VersionUtilities.vurl(coding.system, coding.version);
    const all = this.canonicalMatches(targetScope, this.targetScope);
    for (const g of this.jsonObj.group || []) {
      const sourceOk = this.canonicalMatches(vurl, g.source);
      const targetOk = !targetSystem || this.canonicalMatches(targetSystem, g.target);
      if (all || (sourceOk && targetOk)) {
        result.push(g);
      }
    }
    return result;
  }

  listTranslationsReverse(coding, targetScope, sourceSystem) {
    let result = [];
    let vurl = VersionUtilities.vurl(coding.system, coding.version);

    let all = this.canonicalMatches(targetScope, this.targetScope);
    for (const g of this.jsonObj.group || []) {
      const targetOk = this.canonicalMatches(vurl, g.target);
      const sourceOk = !sourceSystem || this.canonicalMatches(sourceSystem, g.source);
      if (all || (sourceOk && targetOk)) {
        for (const em of g.element || []) {
          for (const tm of em.target || []) {
            if (tm.code === coding.code) {
              let match = {
                group: g,
                match: em,
                target: tm
              };
              result.push(match);
            }
          }
        }
      }
    }
    return result;
  }
    /**
   * Gets the source scope (R5+) or source (R3/R4).
   *
   * R5 renamed ConceptMap.source[x] to ConceptMap.sourceScope[x], so an R4 resource spells this
   * sourceUri / sourceCanonical and an R5 one sourceScopeUri / sourceScopeCanonical. Both have to
   * be read: this server serves R4 as well as R5, and the R4 client sends the R4 spelling. Reading
   * only the R5 names made this silently undefined on an R4 server, which made every map look
   * unscoped - so the scope never limited anything, and $translate answered for codes outside it.
   * @returns {string|undefined} Source scope
   */
  get sourceScope() {
    return this.jsonObj.sourceScopeUri || this.jsonObj.sourceScopeCanonical
      || this.jsonObj.sourceUri || this.jsonObj.sourceCanonical;
  }

  /**
   * Gets the target scope (R5+) or target (R3/R4). See sourceScope for why both are read.
   * @returns {string|undefined} Target scope
   */
  get targetScope() {
    return this.jsonObj.targetScopeUri || this.jsonObj.targetScopeCanonical
      || this.jsonObj.targetUri || this.jsonObj.targetCanonical;
  }

  /**
   * Gets all mapping groups
   * @returns {Object[]} Array of group objects
   */
  getGroups() {
    return this.jsonObj.group || [];
  }

  /**
   * Gets all source concepts across all groups
   * @returns {Object[]} Array of {system, code, display} objects
   */
  getSourceConcepts() {
    const concepts = [];
    this.getGroups().forEach(group => {
      const system = group.source;
      if (group.element) {
        group.element.forEach(element => {
          concepts.push({
            system: system,
            code: element.code,
            display: element.display
          });
        });
      }
    });
    return concepts;
  }

  /**
   * Gets all target concepts across all groups
   * @returns {Object[]} Array of {system, code, display, equivalence/relationship} objects
   */
  getTargetConcepts() {
    const concepts = [];
    this.getGroups().forEach(group => {
      const system = group.target;
      if (group.element) {
        group.element.forEach(element => {
          if (element.target) {
            element.target.forEach(target => {
              concepts.push({
                system: system,
                code: target.code,
                display: target.display,
                equivalence: target.equivalence,
                relationship: target.relationship
              });
            });
          }
        });
      }
    });
    return concepts;
  }

  /**
   * Finds mappings for a source concept
   * @param {string} sourceSystem - Source system URL
   * @param {string} sourceCode - Source concept code
   * @returns {Object[]} Array of target mappings
   */
  findMappings(sourceSystem, sourceCode) {
    const mappings = [];
    this.getGroups().forEach(group => {
      if (group.source === sourceSystem && group.element) {
        const element = group.element.find(el => el.code === sourceCode);
        if (element && element.target) {
          element.target.forEach(target => {
            mappings.push({
              targetSystem: group.target,
              targetCode: target.code,
              targetDisplay: target.display,
              equivalence: target.equivalence,
              relationship: target.relationship,
              comment: target.comment
            });
          });
        }
      }
    });
    return mappings;
  }

  /**
   * Finds reverse mappings for a target concept
   * @param {string} targetSystem - Target system URL
   * @param {string} targetCode - Target concept code
   * @returns {Object[]} Array of source mappings
   */
  findReverseMappings(targetSystem, targetCode) {
    const mappings = [];
    this.getGroups().forEach(group => {
      if (group.target === targetSystem && group.element) {
        group.element.forEach(element => {
          if (element.target) {
            const targetMatch = element.target.find(t => t.code === targetCode);
            if (targetMatch) {
              mappings.push({
                sourceSystem: group.source,
                sourceCode: element.code,
                sourceDisplay: element.display,
                equivalence: targetMatch.equivalence,
                relationship: targetMatch.relationship,
                comment: targetMatch.comment
              });
            }
          }
        });
      }
    });
    return mappings;
  }

  /**
   * Gets all unique source systems
   * @returns {string[]} Array of source system URLs
   */
  getSourceSystems() {
    const systems = new Set();
    this.getGroups().forEach(group => {
      if (group.source) {
        systems.add(group.source);
      }
    });
    return Array.from(systems);
  }

  /**
   * Gets all unique target systems
   * @returns {string[]} Array of target system URLs
   */
  getTargetSystems() {
    const systems = new Set();
    this.getGroups().forEach(group => {
      if (group.target) {
        systems.add(group.target);
      }
    });
    return Array.from(systems);
  }

  /**
   * Gets basic info about this concept map
   * @returns {Object} Basic information object
   */
  getInfo() {
    const groups = this.getGroups();
    const totalMappings = groups.reduce((sum, group) => {
      return sum + (group.element ? group.element.reduce((elSum, el) => {
        return elSum + (el.target ? el.target.length : 0);
      }, 0) : 0);
    }, 0);

    return {
      resourceType: this.jsonObj.resourceType,
      url: this.jsonObj.url,
      version: this.jsonObj.version,
      name: this.jsonObj.name,
      title: this.jsonObj.title,
      status: this.jsonObj.status,
      fhirVersion: this.version,
      sourceScope: this.getSourceScope(),
      targetScope: this.getTargetScope(),
      groupCount: groups.length,
      sourceSystems: this.getSourceSystems(),
      targetSystems: this.getTargetSystems(),
      totalMappings: totalMappings
    };
  }

  canonicalMatches(value, pattern) {
    if (!pattern || !value) {
      return false;
    }
    const { url: vu, version: vv } = VersionUtilities.splitCanonical(value);
    const { url: pu, version: pv } = VersionUtilities.splitCanonical(pattern);

    if (!vu || !pu || vu != pu) {
      return false;
    }
    if (!pv) {
      return true;
    }
    return vv && VersionUtilities.versionMatchesByAlgorithm(pv, vv);
  }
}


module.exports = { ConceptMap };