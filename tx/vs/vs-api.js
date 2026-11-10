const { assignIdSpace } = require('../library/resource-ids');

/**
 * Abstract base class for value set providers
 * Defines the interface that all value set providers must implement
 *
 * Stored concept lists. A value set's include or exclude may list its concepts in a store (a
 * database, say) rather than in memory: the provider puts a handle on the include under
 * STORED_CONCEPTS (tx/library/stored-concepts.js), { count, lookup(code) }, and keeps `concept`
 * readable for code that needs every entry (a getter that reads the list on first use).
 * $validate-code then asks the handle about the one code it checks instead of reading the list.
 * An include without the handle behaves as always.
 */
class AbstractValueSetProvider {
  /**
   * {string} The prefix of this provider's id space (set by assignIds) - given for its source in the library
   * YAML, autonumbered, or 'core' for an endpoint's core package. Every value set this
   * provider provides has an id that starts with spaceId + '-' (see tx/library/resource-ids.js)
   */
  spaceId;

  code() {
    throw new Error('code must be implemented by AbstractValueSetProvider subclass');
  }
  /**
   * Put this provider in an id space: set spaceId, and prefix the ids of the value sets it
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
   * Prefix the ids of the value sets this provider provides with spaceId + '-', once spaceId
   * is set (by assignIds). Value sets the provider loads later must be given ids
   * in the same space.
   */
  prefixIds() {
    throw new Error('prefixIds must be implemented by AbstractValueSetProvider subclass');
  }

  /**
   * Fetches a specific value set by URL and version
   *
   * When the lookup is for a request, the request's OperationContext comes too (Provider.findValueSet
   * passes it). A provider may use it to share work between the lookups of one request (a
   * provider that reads its value sets from a database can read a request's value sets with one
   * connection, or keep what it read for the rest of the request), or to check the request's
   * deadline. It is null for lookups made outside a request (the scans of every value set, say),
   * and a provider that has no use for it ignores it.
   *
   * @param {string} url - The URL/identifier of the value set
   * @param {string} version - The version of the value set
   * @param {OperationContext|null} [opContext] - the request this lookup is for, if any
   * @returns {Promise<ValueSet>} The requested value set
   * @throws {Error} Must be implemented by subclasses
   */
  // eslint-disable-next-line no-unused-vars
  async fetchValueSet(url, version, opContext = null) {
    throw new Error('fetchValueSet must be implemented by subclass');
  }

  /**
   * Fetches a specific value set by id. The id is in this provider's space (spaceId + '-' + the
   * value set's own id); an id that isn't - including an unprefixed one - finds nothing
   *
   * @param {string} id - The id of the value set
   * @returns {Promise<ValueSet>} The requested value set, or null
   * @throws {Error} Must be implemented by subclasses
   */
  // eslint-disable-next-line no-unused-vars
  async fetchValueSetById(id) {
    throw new Error('fetchValueSetById must be implemented by subclass');
  }

  /**
   * Searches for value sets based on provided criteria
   * @param {Array<{name: string, value: string}>} searchParams - List of name/value pairs for search criteria
   * @returns {Promise<Array<ValueSet>>} List of matching value sets
   * @throws {Error} Must be implemented by subclasses
   */
  // eslint-disable-next-line no-unused-vars
  async searchValueSets(searchParams, elements = null) {
    throw new Error('searchValueSets must be implemented by subclass');
  }

  /**
   *
   * @returns {number} total number of value sets
   */
  vsCount() {
    return 0;
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

  async listAllValueSets() {
    return [];
  }

  /**
   * Call fn once for each url in listAllValueSets(), with the latest version of it (what
   * fetchValueSet(url) returns), for the scans that look at every value set (see
   * usage-tracker.js, problems.js). listAllValueSets() can list a url once per stored version:
   * older versions are not scanned, and the latest is scanned only once, so the usage counts
   * are not inflated by how many versions there are. A provider that doesn't hold its value
   * sets in memory can do this more cheaply than fetching each one.
   *
   * @param {function(ValueSet): Promise<void>} fn
   */
  async scanAllValueSets(fn) {
    for (const url of new Set(await this.listAllValueSets())) {
      const vs = await this.fetchValueSet(url);
      if (vs) {
        await fn(vs);
      }
    }
  }

  /**
   * The package this provider's value sets come from (a package id such as "hl7.terminology#7.5.0"),
   * or null. Used for search's source parameter and for THO precedence (Provider.applyTHOPrecedence)
   * @returns {string|null}
   */
  sourcePackage() {
    return null;
  }

  async close() {

  }
}

module.exports = {
  AbstractValueSetProvider
};