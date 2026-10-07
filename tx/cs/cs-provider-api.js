const { assignIdSpace } = require('../library/resource-ids');

/**
 * Abstract base class for value set providers
 * Defines the interface that all value set providers must implement
 */
class AbstractCodeSystemProvider {
  /**
   * {string} The prefix of this provider's id space (set by assignIds) - given for its source in the library
   * YAML, or autonumbered. Every code system this provider provides has an id that starts
   * with spaceId + '-' (see tx/library/resource-ids.js)
   */
  spaceId;

  /**
   * Put this provider in an id space: set spaceId, and prefix the ids of the code systems it
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
   * Prefix the ids of the code systems this provider provides with spaceId + '-', once spaceId
   * is set (by assignIds). Code systems the provider provides later (see
   * getCodeSystemChanges) must be given ids in the same space.
   */
  prefixIds() {
    throw new Error('prefixIds must be implemented by subclass');
  }

  /**
   * Returns the list of CodeSystems this provider provides. This is called once at start up.
   * The code systems should be fully loaded; lazy loading code systems is not considered good
   * for engineering.
   *
   *
   * Note that unlike value sets, which are accessed from the provider on the fly, code systems
   * are all preloaded into the kernel (e.g. provider) at start up
   *
  * @param {string} fhirVersion - The FHIRVersion in scope - if relevant (there's always a stated version, though R5 is always used)
  * @param {string} context - The client's stated context - if provided.
  * @returns {Map<String, CodeSystem>} The list of CodeSystems
  * @throws {Error} Must be implemented by subclasses
  */
  // eslint-disable-next-line no-unused-vars
  async listCodeSystems(fhirVersion, context) {
    throw new Error('listCodeSystems must be implemented by AbstractCodeSystemProvider subclass');
  }

  /**
   * This is called once a minute to update the code system list that the provider maintains.
   *
   * return an object that has three Map<String, CodeSystem>: {added, changed, deleted}
   *
   * these use the same key as the
   *
   * code systems are identified by url and version
   *
   * @param fhirVersion
   * @param context
   * @returns {Promise<null>}
   */
  // eslint-disable-next-line no-unused-vars
  async getCodeSystemChanges(fhirVersion, context){
    return null;
  }

  async close() {

  }

}

module.exports = {
  AbstractCodeSystemProvider
};