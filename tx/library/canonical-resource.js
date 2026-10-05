const {VersionUtilities, VersionPrecision} = require("../../library/version-utilities");
const {Issue} = require("./operation-outcome");

/**
 * Contained resources. The terminology server supports exactly one use of them: a ValueSet
 * that contains ValueSets, which its compose refers to as #id. Any other contained resource
 * - a contained CodeSystem or ConceptMap, anything contained in a CodeSystem or ConceptMap,
 * or a contained ValueSet that itself contains something - is rejected, whatever path the
 * resource arrives by (request, tx-resource, cache, package). Supporting them would mean
 * resolving references to them everywhere, and the terminology ecosystem only requires
 * servers to support contained value sets in value sets.
 *
 * @param {Object} jsonObj - the resource (R5 form)
 * @throws {Issue} if the resource contains anything not supported
 */
function checkContained(jsonObj) {
  const contained = jsonObj ? jsonObj.contained : undefined;
  if (contained === undefined || contained === null) {
    return;
  }
  const type = jsonObj.resourceType;
  const which = `${type}${jsonObj.id ? '/' + jsonObj.id : ''}${jsonObj.url ? ' (' + jsonObj.url + ')' : ''}`;
  if (!Array.isArray(contained)) {
    throw new Issue('error', 'structure', `${type}.contained`, 'CONTAINED_RESOURCE_NOT_SUPPORTED',
      `${which}: contained must be an array`, 'invalid-data', 400);
  }
  contained.forEach((c, i) => {
    const ct = c && typeof c === 'object' ? c.resourceType : undefined;
    let problem = null;
    if (type !== 'ValueSet') {
      problem = `${which} contains a ${ct || 'resource'}: this server only supports ValueSets contained in a ValueSet`;
    } else if (ct !== 'ValueSet') {
      problem = `${which} contains a ${ct || 'resource with no resourceType'}: this server only supports ValueSets contained in a ValueSet`;
    } else if (Array.isArray(c.contained) && c.contained.length > 0) {
      problem = `${which}: the contained ValueSet${c.id ? ' #' + c.id : ''} itself contains resources, which is not allowed`;
    }
    if (problem) {
      throw new Issue('error', 'not-supported', `${type}.contained[${i}]`, 'CONTAINED_RESOURCE_NOT_SUPPORTED',
        problem, 'not-supported', 400);
    }
  });
}

/**
 * Base class for metadata resources to provide common interface
 */
class CanonicalResource {
  /**
   * The original JSON object (always stored in R5 format internally)
   * @type {Object}
   */
  jsonObj = null;

  /**
   * FHIR source version of the loaded Resource
   *
   * Note that the constructors of the sub-classes conver the actual format to R5
   * this is the source version, not the actual version
   *
   * @type {string}
   */
  fhirVersion = 'R5';

  /**
   * The source package the CodeSystem was loaded from
   * @type {String}
   */
  sourcePackage = null;

  constructor(jsonObj, fhirVersion = 'R5') {
    this.jsonObj = jsonObj;
    this.fhirVersion = fhirVersion;
  }

  /**
   * Rejects contained resources this server doesn't support - see checkContained.
   * Subclasses call this once the resource is in R5 form.
   */
  checkContained() {
    checkContained(this.jsonObj);
  }

  get resourceType() {
    return this.jsonObj.resourceType;
  }

  get url() {
    return this.jsonObj.url;
  }

  get version() {
    return this.jsonObj.version;
  }

  get name() {
    return this.jsonObj.name;
  }

  get title() {
    return this.jsonObj.title;
  }

  get status() {
    return this.jsonObj.status;
  }


  get versionedUrl() {
    return this.version ? this.url+'|' + this.version : this.url;
  }

  get vurl() {
    return this.version ? this.url+'|' + this.version : this.url;
  }

  get vurlOrMsg() {
    if (this.url) {
      return this.version ? this.url+'|' + this.version : this.url;
    } else {
      return '(unidentified)';
    }
  }

  get fhirType() {
    return this.jsonObj.resourceType;
  }


  /**
   * Gets the FHIR version this CodeSystem was loaded from
   * @returns {string} FHIR version ('R3', 'R4', or 'R5')
   */
  getFHIRVersion() {
    return this.fhirVersion;
  }

  versionAlgorithm() {
    let c = this.jsonObj.versionAlgorithmCoding;
    if (c) {
      return c.code;
    }
    return this.jsonObj.versionAlgorithmString;
  }

  guessVersionAlgorithmFromVersion(version) {
    if (VersionUtilities.isSemVerWithWildcards(version)) {
      return 'semver';
    }
    if (this.appearsToBeDate(version)) {
      return 'date';
    }
    if (this.isAnInteger(version)) {
      return 'integer';
    }
    return 'alpha';
  }

  /**
   * returns true if this is more recent than other.
   *
   * Uses version if possible, otherwise uses date
   *
   * @param other
   * @returns {boolean}
   */
  isMoreRecent(other) {
    if (this.version && other.version && this.version != other.version) {
      const fmt = this.versionAlgorithm() || other.versionAlgorithm() || this.guessVersionAlgorithmFromVersion(this.version);
      switch (fmt) {
        case 'semver':
          try {
            return VersionUtilities.isThisOrLater(other.version, this.version, VersionPrecision.PATCH);
          } catch (error) {
            // other is not semver. Not much we can do
            return false;
          }
        case 'date':
          return this.dateIsMoreRecent(this.version, other.version);
        case 'integer':
          return parseInt(this.version, 10) > parseInt(other.version, 10);
        case 'alpha':
        default:
          // Return a boolean: true only when this.version sorts after other.version.
          return this.version.localeCompare(other.version) > 0;
      }
    }
    if (this.date && other.date && this.date != other.date) {
      return this.dateIsMoreRecent(this.date, other.date);
    }
    return false;
  }

  appearsToBeDate(version) {
    if (!version || typeof version !== 'string') return false;
    // Strip optional time portion (T...) before checking
    const datePart = version.split('T')[0];
    return /^\d{4}-?\d{2}(-?\d{2})?$/.test(datePart);

  }

  dateIsMoreRecent(date, date2) {
    return this.normaliseDateString(date) > this.normaliseDateString(date2);
  }

  normaliseDateString(date) {
    // Strip time portion, then remove dashes so all formats compare uniformly as YYYYMMDD or YYYYMM
    return date.split('T')[0].replace(/-/g, '');
  }

  isAnInteger(version) {
    return /^\d+$/.test(version);
  }
}

module.exports = { CanonicalResource, checkContained };
