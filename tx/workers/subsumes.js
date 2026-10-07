//
// Subsumes Worker - Handles CodeSystem $subsumes operation
//
// GET /CodeSystem/$subsumes?{params}
// POST /CodeSystem/$subsumes
// GET /CodeSystem/{id}/$subsumes?{params}
// POST /CodeSystem/{id}/$subsumes
//

const { TerminologyWorker, Unknown_Code_in_VersionSCT, SCTVersion } = require('./worker');
const { FhirCodeSystemProvider } = require('../cs/cs-cs');
const {TxParameters} = require("../params");
const {Parameters} = require("../library/parameters");
const {Issue, OperationOutcome} = require("../library/operation-outcome");
const {debugLog} = require("../operation-context");
class SubsumesWorker extends TerminologyWorker {
  /**
   * @param {OperationContext} opContext - Operation context
   * @param {Logger} log - Logger instance
   * @param {Provider} provider - Provider for code systems and resources
   * @param {LanguageDefinitions} languages - Language definitions
   * @param {I18nSupport} i18n - Internationalization support
   */
  constructor(opContext, log, provider, languages, i18n) {
    super(opContext, log, provider, languages, i18n);
  }

  /**
   * Get operation name
   * @returns {string}
   */
  opName() {
    return 'subsumes';
  }

  /**
   * Handle a type-level $subsumes request
   * GET/POST /CodeSystem/$subsumes
   * @param {express.Request} req - Express request
   * @param {express.Response} res - Express response
   */
  async handle(req, res) {
    try {
      await this.handleTypeLevelSubsumes(req, res);
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      req.logInfo = "error "+(error.msgId || error.className);
      if (error instanceof Issue) {
        let oo = new OperationOutcome();
        oo.addIssue(error);
        return res.status(error.statusCode || 500).json(oo.jsonObj);
      } else {
        return res.status(error.statusCode || 500).json(this.unexpectedErrorOutcome(error));
      }
    }
  }

  /**
   * Handle an instance-level $subsumes request
   * GET/POST /CodeSystem/{id}/$subsumes
   * @param {express.Request} req - Express request
   * @param {express.Response} res - Express response
   */
  async handleInstance(req, res) {
    try {
      await this.handleInstanceLevelSubsumes(req, res);
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      if (error instanceof Issue) {
        let oo = new OperationOutcome();
        oo.addIssue(error);
        return res.status(error.statusCode || 500).json(oo.jsonObj);
      } else {
        return res.status(error.statusCode || 500).json(this.unexpectedErrorOutcome(error));
      }
    }
  }

  /**
   * Handle type-level subsumes: /CodeSystem/$subsumes
   * CodeSystem identified by system+version params or from codingA/codingB
   */
  async handleTypeLevelSubsumes(req, res) {
    this.deadCheck('subsumes-type-level');

    // Parse the parameters first, then hand them to setupAdditionalResources. It used to be
    // handed req.body, which meant a GET (no body) never reached the cache-id handling: when a
    // client front-loads a suite's resources into a server-side cache the request carries no
    // tx-resource at all, only the X-Cache-Id header, and every code system supplied that way
    // was invisible. On a GET parseParameters turns the query string into the same Parameters
    // shape, and the cache-id comes off the operation context
    const params = new Parameters(this.parseParameters(req));
    this.setupAdditionalResources(params.jsonObj);
    const txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n);
    txp.readParams(params.jsonObj);

    // Get the codings and code system provider
    let codingA, codingB;
    let csProvider;

    let names = ['codeA', 'codeB'];
    if (params.has('codingA') && params.has('codingB')) {
      names = ['codingA', 'codingB'];
      // Using codingA and codingB (only from Parameters resource)
      codingA = params.get('codingA');
      codingB = params.get('codingB');

      // A Coding with no system has no defined meaning, so there is nothing to test. This is a
      // problem with the request (400/invalid), not a code system the server can't find
      for (const [name, coding] of [['codingA', codingA], ['codingB', codingB]]) {
        if (!coding.system) {
          throw this.parameterIssue(txp, 'SUBSUMPTION_NO_SYSTEM', [name], name);
        }
      }
      // Codings must have the same system
      if (codingA.system !== codingB.system) {
        throw this.parameterIssue(txp, 'SUBSUMPTION_SYSTEM_MISMATCH', [codingA.system, codingB.system], 'codingB');
      }
      // Get the code system provider from the coding's system
      csProvider = await this.findCodeSystem(codingA.system, codingA.version || '', txp, ['complete'], null, false);
      this.seeSourceProvider(csProvider, codingA.system);
    } else if (params.has('codeA') && params.has('codeB')) {
      // Using codeA, codeB - system is required
      if (!params.has('system')) {
        throw this.parameterIssue(txp, 'SUBSUMPTION_NO_SYSTEM', ['codeA'], 'codeA');
      }

      csProvider = await this.findCodeSystem(params.get('system'), params.get('version') || '', txp, ['complete'], null, false);
      this.seeSourceProvider(csProvider, params.get('system'));
      // Create codings from the codes
      codingA = {
        system: csProvider.system(),
        version: csProvider.version(),
        code: params.get('codeA')
      };
      codingB = {
        system: csProvider.system(),
        version: csProvider.version(),
        code: params.get('codeB')
      };

    } else {
      throw new Issue('error', 'invalid', null, null, 'Must provide either codingA and codingB, or codeA and codeB with system', null, 400);
    }

    // Perform the subsumes check
    const result = await this.doSubsumes(csProvider, codingA, codingB, txp, names);
    req.logInfo = this.usedSources.join("|")+txp.logInfo();
    return res.status(200).json(result);
  }

  /**
   * Handle instance-level subsumes: /CodeSystem/{id}/$subsumes
   * CodeSystem identified by resource ID
   */
  async handleInstanceLevelSubsumes(req, res) {
    this.deadCheck('subsumes-instance-level');

    const { id } = req.params;

    // Find the CodeSystem by ID
    const codeSystem = await this.provider.getCodeSystemById(this.opContext, id);

    if (!codeSystem) {
      throw new Issue('error', 'not found', null, null, `CodeSystem/${id} not found`, null, 404);
    }

    // See handleTypeLevelSubsumes: parse first, so a GET reaches the cache-id handling too
    const params = new Parameters(this.parseParameters(req));
    this.setupAdditionalResources(params.jsonObj);
    const txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n);
    txp.readParams(params.jsonObj);

    // Load any supplements
    const supplements = this.loadSupplements(codeSystem.url, codeSystem.version, txp.supplements);

    // Create a FhirCodeSystemProvider for this CodeSystem
    const csProvider = new FhirCodeSystemProvider(this.opContext, codeSystem, supplements);

    // Get the codings
    let codingA, codingB;

    let names = ['codeA', 'codeB'];
    if (params.has('codingA') && params.has('codingB')) {
      names = ['codingA', 'codingB'];
      codingA = params.get('codingA');
      codingB = params.get('codingB');
    } else if (params.has('codeA') && params.has('codeB')) {
      // Create codings from the codes using this CodeSystem
      codingA = {
        system: csProvider.system(),
        version: csProvider.version(),
        code: params.get('codeA')
      };
      codingB = {
        system: csProvider.system(),
        version: csProvider.version(),
        code: params.get('codeB')
      };
    } else {
      throw new Issue('error', 'invalid', null, null, 'Must provide either codingA and codingB, or codeA and codeB with system', null, 400);
    }

    // Perform the subsumes check
    const result = await this.doSubsumes(csProvider, codingA, codingB, txp, names);
    req.logInfo = this.usedSources.join("|")+txp.logInfo();
    return res.json(result);
  }
  /**
   * Parse parameters from request (query params, form body, or Parameters resource)
   * Returns a FHIR Parameters resource
   * @param {express.Request} req - Express request
   * @returns {Object} FHIR Parameters resource
   */
  parseParameters(req) {
    // Check if body is a Parameters resource
    if (req.body && req.body.resourceType === 'Parameters') {
      return req.body;
    }

    // Parse from query params or form body and convert to Parameters resource
    const params = req.method === 'POST' ? req.body : req.query;
    return this.simpleParamsToParametersResource(params);
  }

  /**
   * Convert simple parameters (query string or form body) to a FHIR Parameters resource
   * @param {Object} params - Query params or form body
   * @returns {Object} FHIR Parameters resource
   */
  simpleParamsToParametersResource(params) {
    const result = {
      resourceType: 'Parameters',
      parameter: []
    };

    if (!params) {
      return result;
    }

    for (const [name, value] of Object.entries(params)) {
      if (value === undefined || value === null) {
        continue;
      }

      // Handle arrays (e.g., repeated query params)
      if (Array.isArray(value)) {
        for (const v of value) {
          result.parameter.push({
            name: name,
            valueString: String(v)
          });
        }
      } else {
        result.parameter.push({
          name: name,
          valueString: String(value)
        });
      }
    }

    return result;
  }

  /**
   * Perform the actual subsumes check
   * @param {CodeSystemProvider} csProvider - CodeSystem provider
   * @param {Object} codingA - First coding
   * @param {Object} codingB - Second coding
   * @param {TxParameters} txp - parsed parameters (for languages)
   * @param {Array<string>} names - the parameters the two codes came from, for `expression`
   * @returns {Object} Parameters resource with subsumes result
   */
  async doSubsumes(csProvider, codingA, codingB, txp, names = ['codeA', 'codeB']) {
    this.deadCheck('doSubsumes');

    const csSystem = csProvider.system();

    // Check system uri matches for both codings
    if (csSystem !== codingA.system) {
      const error = new Error(`System uri / code uri mismatch - not supported at this time (${csSystem}/${codingA.system})`);
      error.statusCode = 400;
      error.issueCode = 'not-supported';
      throw error;
    }
    if (csSystem !== codingB.system) {
      const error = new Error(`System uri / code uri mismatch - not supported at this time (${csSystem}/${codingB.system})`);
      error.statusCode = 400;
      error.issueCode = 'not-supported';
      throw error;
    }

    // Validate both codes exist
    const locateA = await csProvider.locate(codingA.code);
    if (!locateA || !locateA.context) {
      throw this.unknownCodeIssue(csProvider, codingA.code, names[0], locateA ? locateA.message : null, txp);
    }

    const locateB = await csProvider.locate(codingB.code);
    if (!locateB || !locateB.context) {
      throw this.unknownCodeIssue(csProvider, codingB.code, names[1], locateB ? locateB.message : null, txp);
    }

    let equal = false;
    if (csProvider.isCaseSensitive()) {
      equal = codingA.code == codingB.code;
    } else {
      equal = codingA.code === codingB.code;
    }
    equal = equal || locateA == locateB;

    // Determine the subsumption relationship
    let outcome = equal ? 'equivalent' : await csProvider.subsumesTest(codingA.code, codingB.code);

    return {
      resourceType: 'Parameters',
      parameter: [
        {
          name: 'outcome',
          valueCode: outcome
        }
      ]
    };
  }

  /**
   * Build the Issue for a request that is malformed - a missing or unusable parameter. These
   * are 400 / invalid: the request can't be processed as given, whatever the server knows
   */
  parameterIssue(txp, msgId, args, path) {
    const msg = this.i18n.translate(msgId, txp.HTTPLanguages, args);
    return new Issue('error', 'invalid', path, msgId, msg, 'invalid-data', 400);
  }

  /**
   * Build the Issue for a code that isn't in the code system. Uses the same message ids
   * and tx-issue-type detail code as $validate-code, so clients get consistent errors
   * @param {CodeSystemProvider} csProvider - CodeSystem provider
   * @param {string} code - the code that wasn't found
   * @param {string} path - the parameter the code came from ('codeA' / 'codeB')
   * @param {string} message - any explanation the provider gave for not finding it
   * @param {TxParameters} txp - parsed parameters (for languages)
   * @returns {Issue}
   */
  unknownCodeIssue(csProvider, code, path, message, txp) {
    const system = csProvider.system();
    const version = csProvider.version();
    const msgId = Unknown_Code_in_VersionSCT(system, version);
    const langs = txp ? txp.HTTPLanguages : null;
    const msg = this.i18n.translate(msgId, langs, [code, system, version, SCTVersion(system, version)]);
    const issue = new Issue('error', 'code-invalid', path, msgId, msg, 'invalid-code', 404);
    if (message) {
      issue.withDiagnostics(message);
    }
    return issue;
  }

  /**
   * Wrap an error we did not expect as an OperationOutcome. The message goes in details.text,
   * not diagnostics: TxTester strips diagnostics from every issue it compares, so anything
   * reported that way is invisible in a failing test - all you see is 'exception'
   * @param {Error} error - the error that escaped
   * @returns {Object} OperationOutcome resource
   */
  unexpectedErrorOutcome(error) {
    // txIssueType, when the thrower set one, becomes the details.coding - that is where
    // a client looks for the machine-readable reason (e.g. cannot-determine).
    const issue = new Issue('error', error.issueCode || 'exception', null, null,
      error.message || String(error), error.txIssueType || null, error.statusCode || 500);
    const oo = new OperationOutcome();
    oo.addIssue(issue);
    return oo.jsonObj;
  }
}

module.exports = SubsumesWorker;