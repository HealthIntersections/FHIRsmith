const { CodeSystemProvider, CodeSystemFactoryProvider} = require('./cs-api');
const assert = require('assert');

/**
 * Code system provider for URIs
 * This is a simple provider that treats any URI as a valid code
 * Uses strings directly as context since URIs have no additional metadata
 * Enhanced to support supplements for display and definition lookup
 */
class UriServices extends CodeSystemProvider {
  constructor(opContext, supplements) {
    super(opContext, supplements);
  }

  // ============================================================================
  // Metadata for the code system
  // ============================================================================

  system() {
    return 'urn:ietf:rfc:3986'; // URI_URIs constant equivalent
  }

  version() {
    return null;
  }

  description() {
    return 'URIs';
  }

  totalCount() {
    return -1; // Infinite/unknown count
  }

  name() {
    return 'Internal URI services';
  }

  defLang() {
    return 'en';
  }

  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);
    if (this._hasAnySupplementDisplays(langs)) {
      return true;
    } else {
      return false; // URIs don't have displays by default
    }
  }

  hasParents() {
    return false; // URIs don't have hierarchy
  }

  // ============================================================================
  // Getting Information about concepts
  // ============================================================================

  async code(code) {
    
    await this.#ensureContext(code);
    return code; // For URIs, the code is the context
  }

  async display(code) {
    
    const ctxt = await this.#ensureContext(code);
    return this._displayFromSupplements(ctxt);
  }

  async definition(code) {
    
    await this.#ensureContext(code);
    return null; // URIs don't have definitions by default
  }

  async isAbstract(code) {
    
    await this.#ensureContext(code);
    return false; // URIs are not abstract
  }

  async isInactive(code) {
    
    await this.#ensureContext(code);
    return false; // URIs are not inactive
  }

  async isDeprecated(code) {
    
    await this.#ensureContext(code);
    return false; // URIs are not deprecated
  }

  async designations(code, displays) {
    
    const ctxt = await this.#ensureContext(code);
    if (ctxt != null) {
      this._listSupplementDesignations(ctxt, displays);
    }
  }

  async properties(code) {
    
    const ctxt = await this.#ensureContext(code);
    // Collect properties from all supplements
    let allProperties = [];

    if (this.supplements) {
      for (const supplement of this.supplements) {
        const concept = supplement.getConceptByCode(ctxt);  // ← Uses CodeSystem API
        if (concept && concept.property) {
          // Add all properties from this concept
          allProperties = allProperties.concat(concept.property);
        }
      }
    }

    return allProperties;
  }

  async sameConcept(a, b) {
    
    await this.#ensureContext(a);
    await this.#ensureContext(b);
    return a === b; // For URIs, direct string comparison
  }


  async #ensureContext(code) {
    if (!code || typeof code === 'string') {
      return code;
    }
    throw new Error("Unknown Type at #ensureContext: "+ (typeof code));
  }

  // ============================================================================
  // Finding concepts
  // ============================================================================

  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    // For URIs, any string is potentially valid
    // But we can check if it exists in supplements for better validation
    // but it doesn't make any difference...

    return {
      context: code, // Use the string directly as context
      message: null
    };
  }

  versionAlgorithm() {
    return null;
  }

  isNotClosed() {
    return true;
  }

  canBeExpanded() {
    return false; // URIs cannot be iterated / enumerated
  }

  // ============================================================================
  // Filtering (not supported for URIs)
  // ============================================================================

  // nothing to declare

  // ============================================================================
  // Translations and concept maps
  // ============================================================================
}

/**
 * Factory for creating URI code system providers
 */
class UriServicesFactory extends CodeSystemFactoryProvider {
  constructor(i18n) {
    super(i18n);
  }

  defaultVersion() {
    return null;
  }

  system() {
    return 'urn:ietf:rfc:3986'; // URI_URIs constant equivalent
  }

  version() {
    return null;
  }

  // eslint-disable-next-line no-unused-vars
  async buildKnownValueSet(url, version) {
    return null;
  }

  async build(opContext, supplements) {
    this.recordUse();
    return new UriServices(opContext, supplements);
  }
  name() {
    return 'URI services';
  }


  id() {
    return "urls";
  }
}

module.exports = {
  UriServices,
  UriServicesFactory
};