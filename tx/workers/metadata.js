//
// Metadata Handler - Handles /metadata endpoint and $versions operation
//
// GET /metadata - Returns CapabilityStatement
// GET /metadata?mode=terminology - Returns TerminologyCapabilities
// GET /$versions - Returns supported FHIR versions
//

const {CapabilityStatement} = require("../library/capabilitystatement");
const {TerminologyCapabilities} = require("../library/terminologycapabilities");

/**
 * Metadata handler for FHIR terminology server
 * Used by TXModule to handle /metadata requests
 */
class MetadataHandler {
  host;

  /**
   * @param {Object} config - Server configuration
   */
  constructor(config = {}) {
    this.config = config;
    this.host = config.host;
  }

  /**
   * Handle GET /metadata request
   * @param {express.Request} req - Express request (with txEndpoint and txProvider attached)
   * @param {express.Response} res - Express response
   */
  async handle(req, res) {
    const mode = req.query.mode;
    const endpoint = req.txEndpoint;
    const provider = req.txProvider;

    if (mode === 'terminology') {
      this.logInfo = 'termcaps';
      const tc = new TerminologyCapabilities(await this.buildTerminologyCapabilities(endpoint, provider, req));
      return res.json(tc.jsonObj);
    }
    this.logInfo = 'metadata';

    // Default: return CapabilityStatement
    const cs = new CapabilityStatement(this.buildCapabilityStatement(endpoint, provider, req));
    return res.json(cs.jsonObj);
  }

  /**
   * Resolve the public base URL for this request.
   * Derived from what the client actually asked for (scheme + host) plus the
   * endpoint path, so the server echoes the host the client used rather than a
   * fixed, hardcoded value. Falls back to config/host only when no request is
   * available (e.g. unit tests calling the build methods directly).
   * @param {express.Request} [req] - Express request
   * @param {Object} endpoint - Endpoint info {path, ...}
   * @returns {string} Base URL, e.g. https://tx.fhir.org/r4
   */
  resolveBaseUrl(req, endpoint) {
    if (!req) {
      return this.config.baseUrl || `https://${this.host}${endpoint.path}`;
    }
    // Requires app.set('trust proxy', ...) and nginx forwarding X-Forwarded-Proto
    // for the scheme to be correct behind the reverse proxy.
    const proto = req.protocol || 'https';
    const host = req.get('host') || this.host;
    return `${proto}://${host}${endpoint.path}`;
  }

  /**
   * Handle GET /$versions request
   * @param {express.Request} req - Express request (with txEndpoint attached)
   * @param {express.Response} res - Express response
   */
  handleVersions(req, res) {
    const endpoint = req.txEndpoint;
    const fhirVersion = this.getShortFhirVersion(endpoint.fhirVersion);

    // Check Accept header to determine response format
    const accept = req.get('Accept') || '';
    const isFhirJson = accept.includes('application/fhir+json') ||
      accept.includes('application/fhir+xml');

    if (isFhirJson) {
      // Return FHIR Parameters resource
      return res.json({
        resourceType: 'Parameters',
        parameter: [
          {
            name: 'version',
            valueCode: fhirVersion
          },
          {
            name: 'default',
            valueCode: fhirVersion
          }
        ]
      });
    } else {
      // Return simple JSON
      return res.json({
        versions: [fhirVersion],
        default: fhirVersion
      });
    }
  }

  /**
   * Get short FHIR version (e.g., "4.0" from "4.0.1" or "4.0")
   * @param {string} version - FHIR version string
   * @returns {string} Short version (X.0 format)
   */
  getShortFhirVersion(version) {
    if (!version) return '4.0';

    // If already short format (e.g., "4.0"), return as-is
    const parts = String(version).split('.');
    if (parts.length >= 2) {
      return `${parts[0]}.${parts[1]}`;
    }
    return version;
  }

  /**
   * Build CapabilityStatement for an endpoint
   * @param {Object} endpoint - Endpoint info {path, fhirVersion, context}
   * @param {Object} provider - Provider for code systems and resources
   * @returns {Object} CapabilityStatement resource
   */
  buildCapabilityStatement(endpoint, provider, req) {

    const now = new Date().toISOString();
    const fhirVersion = this.mapFhirVersion(endpoint.fhirVersion);
    const baseUrl = this.resolveBaseUrl(req, endpoint);
    const serverVersion = this.config.serverVersion;

    return {
      resourceType: 'CapabilityStatement',
      id: this.config.id || 'FhirServer',
      'extension' : [
        {
          'extension' : [
            {
              'url' : 'definition',
              'valueCanonical' : 'http://hl7.org/fhir/uv/tx-tests/FeatureDefinition/test-version'
            },
            {
              'url' : 'value',
              'valueCode' : this.config.txVersion
            },
            {
              'extension' : [
                {
                  'url' : 'name',
                  'valueCode' : 'mode'
                },
                {
                  'url' : 'value',
                  'valueCode' : 'tx.fhir.org'
                }
              ],
              'url' : 'qualifier'
            }
          ],
          'url' : 'http://hl7.org/fhir/uv/application-feature/StructureDefinition/feature'
        },
        {
          'extension' : [
            {
              'url' : 'definition',
              'valueCanonical' : 'http://hl7.org/fhir/uv/tx-ecosystem/FeatureDefinition/CodeSystemAsParameter'
            },
            {
              'url' : 'value',
              'valueBoolean' : true
            }
          ],
          'url' : 'http://hl7.org/fhir/uv/application-feature/StructureDefinition/feature'
        }
      ],
      url: `${baseUrl}/CapabilityStatement/tx`,
      version: `${fhirVersion}-${serverVersion}`,
      name: this.config.name || 'FHIRTerminologyServer',
      title: this.config.title || 'FHIR Terminology Server Conformance Statement',
      status: 'active',
      date: now,
      contact: this.config.contact || [
        {
          telecom: [
            {
              system: 'other',
              value: this.config.contactUrl || 'http://example.org/'
            }
          ]
        }
      ],
      description: this.config.description || 'FHIR Terminology Server',
      kind: 'instance',
      instantiates: [
        'http://hl7.org/fhir/CapabilityStatement/terminology-server'
      ],
      software: {
        name: this.config.softwareName || 'FHIR Terminology Server',
        version: serverVersion,
        releaseDate: this.config.releaseDate || now
      },
      implementation: {
        description: `FHIR Server running at ${baseUrl}`,
        url: baseUrl
      },
      fhirVersion: fhirVersion,
      format: ['application/fhir+xml', 'application/fhir+json'],
      rest: [
        {
          mode: 'server',
          security: {
            cors: true
          },
          resource: [
            {
              type: 'CodeSystem',
              interaction: [
                { code: 'read', documentation: 'Read a code system' },
                { code: 'search-type', documentation: 'Search the code systems' }
              ],
              searchParam: [
                { name: 'url', type: 'uri' },
                { name: 'version', type: 'token' },
                { name: 'name', type: 'string' },
                { name: 'title', type: 'string' },
                { name: 'status', type: 'token' },
                { name: '_id', type: 'token' }
              ],
              operation: [
                { name: 'lookup', definition: 'http://hl7.org/fhir/OperationDefinition/CodeSystem-lookup' },
                { name: 'validate-code', definition: 'http://hl7.org/fhir/OperationDefinition/CodeSystem-validate-code' },
                { name: 'subsumes', definition: 'http://hl7.org/fhir/OperationDefinition/CodeSystem-subsumes' }
              ]
            },
            {
              type: 'ValueSet',
              interaction: [
                { code: 'read', documentation: 'Read a ValueSet' },
                { code: 'search-type', documentation: 'Search the value sets' }
              ],
              searchParam: [
                { name: 'url', type: 'uri' },
                { name: 'version', type: 'token' },
                { name: 'name', type: 'string' },
                { name: 'title', type: 'string' },
                { name: 'status', type: 'token' },
                { name: '_id', type: 'token' }
              ],
              operation: [
                { name: 'expand', definition: 'http://hl7.org/fhir/OperationDefinition/ValueSet-expand' },
                { name: 'validate-code', definition: 'http://hl7.org/fhir/OperationDefinition/ValueSet-validate-code' },
                { name: 'compare', definition: 'http://hl7.org/fhir/tools/OperationDefinition/ValueSet-compare' }
              ]
            },
            {
              type: 'ConceptMap',
              interaction: [
                { code: 'read', documentation: 'Read a ConceptMap' },
                { code: 'search-type', documentation: 'Search the concept maps' }
              ],
              searchParam: [
                { name: 'url', type: 'uri' },
                { name: 'version', type: 'token' },
                { name: 'name', type: 'string' },
                { name: 'title', type: 'string' },
                { name: 'status', type: 'token' },
                { name: '_id', type: 'token' }
              ],
              operation: [
                { name: 'translate', definition: 'http://hl7.org/fhir/OperationDefinition/ConceptMap-translate' },
                { name: 'closure', definition: 'http://hl7.org/fhir/OperationDefinition/ConceptMap-closure' }
              ]
            }
          ],
          interaction: [
            { code: 'transaction' }
          ],
          operation: [
            { name: 'expand', definition: 'http://hl7.org/fhir/OperationDefinition/ValueSet-expand' },
            { name: 'lookup', definition: 'http://hl7.org/fhir/OperationDefinition/CodeSystem-lookup' },
            { name: 'subsumes', definition: 'http://hl7.org/fhir/OperationDefinition/CodeSystem-subsumes' },
            { name: 'validate-code', definition: 'http://hl7.org/fhir/OperationDefinition/Resource-validate-code' },
            { name: 'translate', definition: 'http://hl7.org/fhir/OperationDefinition/ConceptMap-translate' },
            { name: 'closure', definition: 'http://hl7.org/fhir/OperationDefinition/ConceptMap-closure' },
            { name: 'compare', definition: 'http://hl7.org/fhir/tools/OperationDefinition/ValueSet-compare' },
            { name: 'cache-control', definition: 'http://hl7.org/fhir/tools/OperationDefinition/cache-control' },
            { name: 'versions', definition: 'http://hl7.org/fhir/OperationDefinition/fhir-versions' }
          ]
        }
      ]
    };
  }

  /**
   * Build TerminologyCapabilities resource
   * @param {Object} endpoint - Endpoint info
   * @param {Object} provider - Provider for code systems and resources
   * @returns {Object} TerminologyCapabilities resource
   */
  async buildTerminologyCapabilities(endpoint, provider, req) {
    const now = new Date().toISOString();
    const baseUrl = this.resolveBaseUrl(req, endpoint);
    const serverVersion = this.config.serverVersion || '1.0.0';

    const tc = {
      resourceType: 'TerminologyCapabilities',
      id: this.config.id || 'FhirServer',
      url: `${baseUrl}/TerminologyCapabilities/tx`,
      version: serverVersion,
      name: this.config.name || 'FHIRTerminologyServerCapabilities',
      title: this.config.title || 'FHIR Terminology Server Capability Statement',
      status: 'active',
      date: now,
      contact: this.config.contact || [
        {
          telecom: [
            {
              system: 'other',
              value: this.config.contactUrl || 'http://example.org/'
            }
          ]
        }
      ],
      description: this.config.description || 'Terminology Capability Statement for FHIR Terminology Server',
      kind: 'instance',
      codeSystem: await this.buildCodeSystemEntries(provider),
      expansion: this.buildExpansionCapabilities(),
      validateCode: this.buildValidateCodeCapabilities(),
      translation: this.buildTranslationCapabilities()
    };

    return tc;
  }

  /**
   * Build codeSystem entries from provider
   * @param {Object} provider - Provider with codeSystems and codeSystemFactories
   * @returns {Object[]} Array of codeSystem entries
   */
  async buildCodeSystemEntries(provider) {
    const seenSystems = new Map(); // url -> entry for deduplication

    // Process provider.codeSystems (direct CodeSystem resources)
    if (provider && provider.codeSystems) {
      for (const cs of provider.codeSystems.values()) {
        const url = cs.url || (cs.jsonObj && cs.jsonObj.url);
        const version = cs.version || (cs.jsonObj && cs.jsonObj.version);
        const content = cs.content || cs.jsonObj.content;

        if (url) {
          this.addCodeSystemEntry(seenSystems, url, version, content);
        }
      }
    }

    // Process provider.codeSystemFactories (factory providers)
    if (provider && provider.codeSystemFactories) {
      for (const factory of provider.codeSystemFactories.values()) {
        const url = factory.system();
        const version = factory.version();

        if (url) {
          this.addCodeSystemEntry(seenSystems, url, version, factory.content());
        }
      }
    }

    // Convert map to array and sort by URI
    const entries = Array.from(seenSystems.values());
    entries.sort((a, b) => (a.uri || '').localeCompare(b.uri || ''));

    return entries.length > 0 ? entries : undefined;
  }

  /**
   * Add or update a code system entry
   * @param {Map} seenSystems - Map of URL to entry
   * @param {string} url - Code system URL
   * @param {string} version - Code system version (may be null)
   */
  addCodeSystemEntry(seenSystems, url, version, content) {
    if (!seenSystems.has(url)) {
      // Create new entry
      const entry = { uri: url };
      if (version) {
        entry.version = [{ code: version }];
      }
      if (content) {
        entry.content = content;
      }
      seenSystems.set(url, entry);
    } else if (version) {
      // Add version to existing entry
      const entry = seenSystems.get(url);
      if (!entry.version) {
        entry.version = [];
      }
      if (content) {
        entry.content = content;
      }
      // Check if version already exists
      if (!entry.version.some(v => v.code === version)) {
        entry.version.push({ code: version });
      }
    }
  }

  /**
   * Build expansion capabilities
   * @returns {Object} Expansion capabilities object
   */
  buildExpansionCapabilities() {
    return {
      parameter: [
        // NOTE: `cache-id` is deliberately not advertised as an expansion parameter.
        // Caching is now discovered via the $cache-control operation in the
        // CapabilityStatement, not by advertising a cache-id parameter here. The old
        // advertisement implied the implicit "auto-create on first sight" protocol,
        // which has been replaced: a cache must be created explicitly with
        // $cache-control?mode=start before its cache-id can be used. Clients that
        // only know the old mechanism will see no cache-id parameter and simply not
        // cache (inlining each request), which is correct, just not optimised.
        {
          name: 'tx-resource',
          documentation: 'Additional valuesets needed for evaluation e.g. value sets referred to from the import statement of the value set being expanded'
        },
        // Parameters the $expand handler reads - see handleTypeLevelExpand in
        // tx/workers/expand.js and TxParameters.seeParameter in tx/params.js.
        // Keep this list in step with those when adding a parameter.
        { name: '_incomplete' },
        { name: 'abstract' },
        { name: 'activeOnly' },
        { name: 'check-system-version' },
        { name: 'check-valueset-version' },
        { name: 'count' },
        { name: 'default-to-latest-version' },
        { name: 'default-valueset-version' },
        { name: 'designation' },
        { name: 'displayLanguage' },
        { name: 'excludeNested' },
        { name: 'excludeNotForUI' },
        { name: 'excludePostCoordinated' },
        { name: 'filter' },
        { name: 'force-system-version' },
        { name: 'force-valueset-version' },
        { name: 'inactive' },
        { name: 'includeAlternateCodes' },
        { name: 'includeDefinition' },
        { name: 'includeDesignations' },
        { name: 'incomplete-ok' },
        {
          name: 'limit',
          documentation: 'Upper bound on the size of the expansion; the operation fails as too-costly beyond it'
        },
        { name: 'limitedExpansion' },
        {
          name: 'mode',
          documentation: '=lenient-display-validation'
        },
        { name: 'no-cache' },
        { name: 'offset' },
        { name: 'profile' },
        { name: 'property' },
        {
          name: 'sort',
          documentation: 'code | display | design | prop:{name}; prefix with - to reverse. Ignored for hierarchical expansions'
        },
        { name: 'system-version' },
        { name: 'url' },
        { name: 'useSupplement' },
        { name: 'valueSet' },
        {
          name: 'valueSetMode',
          documentation: '= CHECK_MEMBERSHIP_ONLY | NO_MEMBERSHIP_CHECK'
        },
        { name: 'valueSetVersion' }
      ]
    };
  }

  /**
   * Build validateCode capabilities
   * @returns {Object} ValidateCode capabilities object
   */
  buildValidateCodeCapabilities() {
    return {
      "translations" : true
    };
  }

  /**
   * Build translation capabilities
   * @returns {Object} Translation capabilities object
   */
  buildTranslationCapabilities() {
    return {
      needsMap : false
    };
  }

  /**
   * Map short FHIR version to full version string
   * @param {string} version - Short version (e.g., '4.0')
   * @returns {string} Full version (e.g., '4.0.1')
   */
  mapFhirVersion(version) {
    const versionMap = {
      '3.0': '3.0.2',
      '4.0': '4.0.1',
      '4.3': '4.3.0',
      '5.0': '5.0.0',
      '6.0': '6.0.0'
    };
    return versionMap[version] || version || '4.0.1';
  }
}

module.exports = { MetadataHandler };