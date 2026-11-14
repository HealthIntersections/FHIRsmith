/*
  eslint-disable no-unused-vars
 */

const assert = require('assert');
const https = require('https');
const { CodeSystemProvider, Designation, CodeSystemFactoryProvider } = require('./cs-api');
const { Issue } = require('../library/operation-outcome');

class HGVSCode {
  constructor(code) {
    this.code = code;
  }
}

class HGVSServices extends CodeSystemProvider {
  constructor(opContext, supplements) {
    super(opContext, supplements);
  }

  // Metadata methods
  system() {
    return 'http://varnomen.hgvs.org';
  }

  version() {
    return '2.0';
  }

  description() {
    return 'HGVS validator';
  }

  name() {
    return 'HGVS validator';
  }

  async totalCount() {
    return 0; // No enumerable codes
  }

  specialEnumeration() {
    return null;
  }

  canBeExpanded() {
    return false; // HGVS is a grammar validated externally; its codes cannot be iterated
  }

  defaultToLatest() {
    return true;
  }

  // Core concept methods
  async code(context) {
    
    if (context instanceof HGVSCode) {
      return context.code;
    }
    return null;
  }

  async display(context) {
    
    return this.code(context);
  }

  async definition(context) {
    return '';
  }

  async isAbstract(context) {
    
    return false;
  }

  async isInactive(context) {
    
    return false;
  }

  async isDeprecated(context) {
    
    return false;
  }

  async designations(context, displays) {

    if (context instanceof HGVSCode) {
      displays.addDesignation(true, 'active', '', null, context.code);

      // Add supplement designations
      this._listSupplementDesignations(context.code, displays);
    }
  }

  async extendLookup(ctxt, props, params) {
    
    // No additional properties to add for HGVS codes
  }

  // Lookup methods - this is the main functionality
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    try {
      const result = await this.#validateHGVSCode(code);

      if (result.valid) {
        return {
          context: new HGVSCode(code),
          message: null
        };
      } else {
        return {
          context: null,
          message: result.message || undefined
        };
      }
    } catch (error) {
      throw new Error(`Error validating HGVS code: ${error.message}`);
    }
  }

  async #validateHGVSCode(code) {
    return new Promise((resolve, reject) => {
      const url = `https://clinicaltables.nlm.nih.gov/fhir/R4/CodeSystem/hgvs/$validate-code?code=${encodeURIComponent(code)}`;

      const request = https.get(url, { timeout: 5000 }, (response) => {
        let data = '';

        response.on('data', (chunk) => {
          data += chunk;
        });

        response.on('end', () => {
          try {
            const json = JSON.parse(data);
            let valid = false;
            let message = '';

            if (!json.resourceType) {
              message = 'Invalid response format';
            } else if (json.resourceType == 'OperationOutcome') {
              message = json.issue?.[0]?.details?.text || 'Unknown error';
            } else if (json.resourceType == 'Parameters') {
              // Parse the FHIR Parameters response
              if (json.parameter && Array.isArray(json.parameter)) {
                for (const param of json.parameter) {
                  if (param.name === 'result' && param.valueBoolean) {
                    valid = true;
                  } else if (param.name === 'message' && param.valueString) {
                    if (message) message += ', ';
                    message += param.valueString;
                  }
                }
              }
            } else {
              message = 'Invalid response resource type: ' + json.resourceType;
            }

            resolve({ valid, message });
          } catch (parseError) {
            reject(new Error(`Error parsing HGVS response: ${parseError.message}`));
          }
        });
      });

      request.on('timeout', () => {
        request.destroy();
        reject(new Error('HGVS validation request timed out'));
      });

      request.on('error', (error) => {
        reject(new Error(`HGVS validation request failed: ${error.message}`));
      });
    });
  }

  async locateIsA(code, parent, disallowParent = false) {
    
    return null; // No hierarchy support
  }

  // Iterator methods - not supported
  async iterator(context) {
    
    // Return empty iterator
    return {
      total: 0,
      current: 0,
      more: () => false,
      next: () => this.current++
    };
  }

  async nextContext(iteratorContext) {
    
    iteratorContext.next();
    return null;
  }

  // Filter support - not supported
  async doesFilter(prop, op, value) {
    
    return false;
  }

  async filter(filterContext, forIteration, prop, op, value) {
    throw new Issue('error', 'not-supported', null, 'FILTER_NOT_UNDERSTOOD',
      this.opContext.i18n.translate('FILTER_NOT_UNDERSTOOD', this.opContext.langs, [prop, op, value]), 'vs-invalid', 422);
  }

  async prepare(filterContext) {
    
    throw new Error('Filters are not supported for HGVS');
  }

  async executeFilters(filterContext) {
    
    throw new Error('Filters are not supported for HGVS');
  }

  async filterSize(filterContext, set) {
    
    throw new Error('Filters are not supported for HGVS');
  }

  async filterMore(filterContext, set) {
    
    throw new Error('Filters are not supported for HGVS');
  }

  async filterConcept(filterContext, set) {
    
    throw new Error('Filters are not supported for HGVS');
  }

  async filterLocate(filterContext, set, code) {
    
    throw new Error('Filters are not supported for HGVS');
  }

  async filterCheck(filterContext, set, concept) {
    
    throw new Error('Filters are not supported for HGVS');
  }

  async filterFinish(filterContext) {
    
    throw new Error('Filters are not supported for HGVS');
  }

  async filtersNotClosed(filterContext) {
    
    return false;
  }

  // Subsumption testing - not supported
  async subsumesTest(codeA, codeB) {
    
    throw new Error('Subsumption is not supported for HGVS');
  }

  // Other methods
  async getCDSInfo(card, langList, baseURL, code, display) {
    
    // No CDS info for HGVS
  }

  async defineFeatures(features) {
    
    // No special features
  }


  versionAlgorithm() {
    return null;
  }
}

class HGVSServicesFactory extends CodeSystemFactoryProvider {
  constructor(i18n) {
    super(i18n);
    this.uses = 0;
  }

  defaultVersion() {
    return '2.0';
  }

  // Metadata methods
  system() {
    return 'http://varnomen.hgvs.org';
  }

  version() {
    return '2.0';
  }

  async buildKnownValueSet(url, version) {
    return null;
  }

  async build(opContext, supplements) {
    this.recordUse();
    return new HGVSServices(opContext, supplements);
  }

  static checkService() {
    // Simple check - just return that it's available
    // In practice, you might want to test the external service
    return 'OK (External validation service)';
  }

  name() {
    return 'HGVS validator';
  }


  id() {
    return "hgvs";
  }
}

module.exports = {
  HGVSServices,
  HGVSServicesFactory,
  HGVSCode
};