//
// Batch Worker - Handles batch terminology operations
//
// POST /tx/r5 (with Bundle)
//

const { TerminologyWorker } = require('./worker');
const { Issue, OperationOutcome, buildOperationOutcome, outcomeFromError } = require('../library/operation-outcome');
const {debugLog} = require("../operation-context");

class BatchWorker extends TerminologyWorker {
  /**
   * @param {OperationContext} opContext - Operation context
   * @param {Logger} log - Logger instance
   * @param {Provider} provider - Provider for terminology resources
   * @param {LanguageDefinitions} languages - Language definitions
   * @param {I18nSupport} i18n - Internationalization support
   * @param {Object} workers - Map of operation workers (validate, lookup, subsumes, translate, expand)
   */
  constructor(opContext, log, provider, languages, i18n, workers) {
    super(opContext, log, provider, languages, i18n);
    this.workers = workers;
  }

  /**
   * Get operation name
   * @returns {string}
   */
  opName() {
    return 'batch-validate-code';
  }

  /**
   * Handle a batch request
   * POST with Bundle resource
   * @param {express.Request} req - Express request
   * @param {express.Response} res - Express response
   */
  async handle(req, res) {
    try {
      await this.handleBatch(req, res);
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      if (error instanceof Issue) {
        const oo = new OperationOutcome();
        oo.addIssue(error);
        return res.status(error.statusCode || 500).json(oo.jsonObj);
      } else {
        return res.status(error.statusCode || 500).json(outcomeFromError(error));
      }
    }
  }

  /**
   * Handle the batch operation
   * @param {express.Request} req - Express request
   * @param {express.Response} res - Express response
   */
  async handleBatch(req, res) {
    this.deadCheck('batch');

    const bundle = req.body;

    // Validate input is a Bundle
    if (!bundle || bundle.resourceType !== 'Bundle') {
      throw new Issue('error', 'invalid', null, null,
        'Request body must be a Bundle resource', null, 400);
    }

    // Must be a batch bundle
    if (bundle.type !== 'batch') {
      throw new Issue('error', 'invalid', null, null,
        `Bundle type must be 'batch', got '${bundle.type}'`, null, 400);
    }

    // Process entries
    const entries = bundle.entry || [];
    const responseEntries = [];

    for (let i = 0; i < entries.length; i++) {
      this.deadCheck(`batch-entry-${i}`);
      const entry = entries[i];
      const responseEntry = await this.processEntry(entry, i);
      responseEntries.push(responseEntry);
    }

    // Build response bundle
    const responseBundle = {
      resourceType: 'Bundle',
      type: 'batch-response',
      entry: responseEntries
    };

    return res.status(200).json(responseBundle);
  }

  /**
   * Process a single batch entry
   * @param {Object} entry - Bundle entry
   * @param {number} index - Entry index for error reporting
   * @returns {Object} Response entry
   */
  async processEntry(entry, index) {
    try {
      // Validate entry has request
      if (!entry.request) {
        return this.errorEntry(400, 'invalid', `Entry ${index}: missing request element`);
      }

      const request = entry.request;
      const method = request.method?.toUpperCase();
      const url = request.url;

      if (!method) {
        return this.errorEntry(400, 'invalid', `Entry ${index}: missing request.method`);
      }

      if (!url) {
        return this.errorEntry(400, 'invalid', `Entry ${index}: missing request.url`);
      }

      // Parse the URL to determine the operation
      const parsedOp = this.parseOperationUrl(url);

      if (!parsedOp) {
        return this.errorEntry(400, 'not-supported',
          `Entry ${index}: unsupported URL pattern '${url}'`);
      }

      // Get the appropriate worker
      const worker = this.getWorkerForOperation(parsedOp.operation);

      if (!worker) {
        return this.errorEntry(501, 'not-supported',
          `Entry ${index}: operation '${parsedOp.operation}' not supported`);
      }

      // Build a mock request object for the worker
      const mockReq = this.buildMockRequest(method, parsedOp, entry.resource, request);

      // Build a mock response object to capture the result
      const mockRes = this.buildMockResponse();

      // Execute the operation
      if (parsedOp.instanceId) {
        await worker.handleInstance(mockReq, mockRes);
      } else {
        await worker.handle(mockReq, mockRes);
      }

      // Build response entry from captured result
      return {
        resource: mockRes.body,
        response: {
          status: `${mockRes.statusCode}`,
          outcome: mockRes.statusCode >= 400 ? mockRes.body : undefined
        }
      };

    } catch (error) {
      this.log.error(error);
      debugLog(error);
      const statusCode = error.statusCode || 500;
      // on a plain Error, issueCode is the FHIR issue type and txIssueType the tx-issue-type
      return this.errorEntry(statusCode, error.issueCode || 'exception', error.message, error.txIssueType);
    }
  }

  /**
   * Parse an operation URL to extract the operation type and parameters
   * @param {string} url - Request URL (e.g., "CodeSystem/$lookup?system=...&code=...")
   * @returns {Object|null} Parsed operation info or null if not recognized
   */
  parseOperationUrl(url) {
    // Remove leading slash if present
    const cleanUrl = url.startsWith('/') ? url.substring(1) : url;

    // Split URL and query string
    const [path, queryString] = cleanUrl.split('?');
    const queryParams = this.parseQueryString(queryString);

    // Patterns to match:
    // CodeSystem/$lookup
    // CodeSystem/{id}/$lookup
    // CodeSystem/$validate-code
    // CodeSystem/{id}/$validate-code
    // CodeSystem/$subsumes
    // CodeSystem/{id}/$subsumes
    // ValueSet/$expand
    // ValueSet/{id}/$expand
    // ValueSet/$validate-code
    // ValueSet/{id}/$validate-code
    // ConceptMap/$translate
    // ConceptMap/{id}/$translate

    // Type-level operations
    const typeLevelMatch = path.match(/^(CodeSystem|ValueSet|ConceptMap)\/\$(.+)$/);
    if (typeLevelMatch) {
      return {
        resourceType: typeLevelMatch[1],
        operation: typeLevelMatch[2],
        instanceId: null,
        queryParams
      };
    }

    // Instance-level operations
    const instanceLevelMatch = path.match(/^(CodeSystem|ValueSet|ConceptMap)\/([^/$]+)\/\$(.+)$/);
    if (instanceLevelMatch) {
      return {
        resourceType: instanceLevelMatch[1],
        operation: instanceLevelMatch[3],
        instanceId: instanceLevelMatch[2],
        queryParams
      };
    }

    return null;
  }

  /**
   * Parse a query string into an object
   * @param {string} queryString - Query string (without leading ?)
   * @returns {Object} Parsed query parameters
   */
  parseQueryString(queryString) {
    if (!queryString) {
      return {};
    }

    const params = {};
    const pairs = queryString.split('&');

    for (const pair of pairs) {
      const [key, value] = pair.split('=').map(decodeURIComponent);
      if (key) {
        // Handle repeated parameters
        if (params[key] !== undefined) {
          if (Array.isArray(params[key])) {
            params[key].push(value);
          } else {
            params[key] = [params[key], value];
          }
        } else {
          params[key] = value;
        }
      }
    }

    return params;
  }

  /**
   * Get the worker for a given operation
   * @param {string} operation - Operation name (e.g., 'lookup', 'validate-code', 'expand')
   * @returns {Object|null} Worker instance or null
   */
  getWorkerForOperation(operation) {
    const operationMap = {
      'lookup': this.workers.lookup,
      'validate-code': this.workers.validate,
      'subsumes': this.workers.subsumes,
      'expand': this.workers.expand,
      'translate': this.workers.translate
    };

    return operationMap[operation] || null;
  }

  /**
   * Build a mock request object for a worker
   * @param {string} method - HTTP method
   * @param {Object} parsedOp - Parsed operation info
   * @param {Object} resource - Request resource (for POST)
   * @param {Object} request - Original request element
   * @returns {Object} Mock request object
   */
  buildMockRequest(method, parsedOp, resource) {
    return {
      method,
      params: {
        id: parsedOp.instanceId
      },
      query: parsedOp.queryParams,
      body: resource || {},
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json'
      },
      get: function(header) {
        return this.headers[header.toLowerCase()];
      }
    };
  }

  /**
   * Build a mock response object to capture worker output
   * @returns {Object} Mock response object
   */
  buildMockResponse() {
    const mockRes = {
      statusCode: 200,
      body: null,
      status: function(code) {
        this.statusCode = code;
        return this;
      },
      json: function(body) {
        this.body = body;
        return this;
      }
    };
    return mockRes;
  }

  /**
   * Build an error response entry
   * @param {number} statusCode - HTTP status code
   * @param {string} issueCode - FHIR issue type
   * @param {string} message - Error message
   * @param {string} [txIssueType] - tx-issue-type; defaulted from issueCode when not given
   * @returns {Object} Error entry
   */
  errorEntry(statusCode, issueCode, message, txIssueType = null) {
    const outcome = buildOperationOutcome('error', issueCode, message, txIssueType);

    return {
      resource: outcome,
      response: {
        status: `${statusCode}`,
        outcome: outcome
      }
    };
  }

  /**
   * Build an OperationOutcome. Delegates to the shared builder so that every outcome this
   * server emits has details.text and a tx-issue-type coding: diagnostics is stripped by
   * the test harness, so nothing a caller needs may live there.
   * @param {string} severity - error, warning, information
   * @param {string} code - FHIR issue type
   * @param {string} message - the human readable account of the problem
   * @param {string} [txIssueType] - tx-issue-type; defaulted from code when not given
   * @returns {Object} OperationOutcome resource
   */
  operationOutcome(severity, code, message, txIssueType = null) {
    return buildOperationOutcome(severity, code, message, txIssueType);
  }
}

module.exports = BatchWorker;