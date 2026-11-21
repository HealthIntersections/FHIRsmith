const { AbstractCodeSystemProvider } = require('./cs-provider-api');
const { applyIdPrefix } = require('../library/resource-ids');

/**
 * Package-based ValueSet provider using shared database layer
 */
class ListCodeSystemProvider extends AbstractCodeSystemProvider {
  /**
   * {CodeSystem[]} The preloaded FHIR code systems in this list. This is an
   * array — append with .push(), not Map-style .set().
   */
  codeSystems = [];

  /**
   * prefix the ids of the code systems with this provider's spaceId. A code system without
   * an id gets its position in the list
   */
  prefixIds() {
    let i = 0;
    for (const cs of this.codeSystems) {
      i++;
      const json = cs.jsonObj || cs;
      if (!json.id) {
        json.id = String(i);
      }
      applyIdPrefix(cs, this.spaceId);
    }
  }


  // eslint-disable-next-line no-unused-vars
  async listCodeSystems(fhirVersion, context) {
    return this.codeSystems;
  }
}

module.exports = {
  ListCodeSystemProvider
};
