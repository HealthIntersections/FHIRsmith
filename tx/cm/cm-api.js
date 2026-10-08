const { assignIdSpace } = require('../library/resource-ids');

/**
 * Abstract base class for Concept Map providers
 * Defines the interface that all Concept Map providers must implement
 */
class AbstractConceptMapProvider {
  /**
   * {string} The prefix of this provider's id space (set by assignIds) - given for its source in the library
   * YAML, autonumbered, or 'core' for an endpoint's core package. Every concept map this
   * provider provides has an id that starts with spaceId + '-' (see tx/library/resource-ids.js)
   */
  spaceId;

  /**
   * Put this provider in an id space: set spaceId, and prefix the ids of the concept maps it
   * provides with spaceId + '-'. A provider is put in one id space, once - asking for a
   * different one later is an error (see assignIdSpace)
   *
   * @param {string} spaceId
   */
  assignIds(spaceId) {
    if (assignIdSpace(this, spaceId)) {
      this.prefixIds();
    }
  }

  /**
   * Prefix the ids of the concept maps this provider provides with spaceId + '-', once spaceId
   * is set (by assignIds). Concept maps the provider loads later must be given ids
   * in the same space.
   */
  prefixIds() {
    throw new Error('prefixIds must be implemented by AbstractConceptMapProvider subclass');
  }

  /**
   * Fetches a specific Concept Map by URL and version
   * @param {string} url - The URL/identifier of the Concept Map
   * @param {string} version - The version of the Concept Map
   * @returns {Promise<ConceptMap>} The requested Concept Map
   * @throws {Error} Must be implemented by subclasses
   */
  // eslint-disable-next-line no-unused-vars
  async fetchConceptMap(url, version) {
    throw new Error('fetchConceptMap must be implemented by subclass');
  }

  /**
   * Fetches a specific Concept Map by id. The id is in this provider's space (spaceId + '-' +
   * the concept map's own id); an id that isn't - including an unprefixed one - finds nothing
   *
   * @param {string} id - The id of the Concept Map
   * @returns {Promise<ConceptMap>} The requested Concept Map, or null
   * @throws {Error} Must be implemented by subclasses
   */
  // eslint-disable-next-line no-unused-vars
  async fetchConceptMapById(id) {
    throw new Error('fetchConceptMapById must be implemented by subclass');
  }

  /**
   * Searches for Concept Maps based on provided criteria
   * @param {Array<{name: string, value: string}>} searchParams - List of name/value pairs for search criteria
   * @returns {Promise<Array<ConceptMap>>} List of matching Concept Maps
   * @throws {Error} Must be implemented by subclasses
   */
  // eslint-disable-next-line no-unused-vars
  async searchConceptMaps(searchParams, elements = null) {
    throw new Error('searchConceptMaps must be implemented by subclass');
  }

  /**
   * Validates search parameters
   * @param {Array<{name: string, value: string}>} searchParams - Search parameters to validate
   * @protected
   */
  _validateSearchParams(searchParams) {
    if (!Array.isArray(searchParams)) {
      throw new Error('Search parameters must be an array');
    }

    for (const param of searchParams) {
      if (!param || typeof param !== 'object') {
        throw new Error('Each search parameter must be an object');
      }
      if (typeof param.name !== 'string' || typeof param.value !== 'string') {
        throw new Error('Search parameter must have string name and value properties');
      }
    }
  }

  /**
   * Validates URL and version parameters
   * @param {string} url - URL to validate
   * @param {string} version - Version to validate
   * @protected
   */
  _validateFetchParams(url, version) {
    if (typeof url !== 'string' || !url.trim()) {
      throw new Error('URL must be a non-empty string');
    }
    if (version != null && typeof version !== 'string') {
      throw new Error('Version must be a string');
    }
  }

  // eslint-disable-next-line no-unused-vars
  async findConceptMapForTranslation(opContext, conceptMaps, sourceSystem, sourceScope, targetScope, targetSystem) {
    // nothing
  }

  cmCount() {
    return 0;
  }

  async close() {

  }

}

module.exports = {
  AbstractConceptMapProvider
};