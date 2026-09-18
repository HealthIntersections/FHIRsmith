//
// Closure Worker - Handles the $closure operation
//
// POST [base]/$closure
//
// $closure is defined on ConceptMap (OperationDefinition ConceptMap-closure) but is a
// SYSTEM-level operation: system=true, type=false, instance=false in R3, R4 and R5.
// So it lives at [base]/$closure, not [base]/ConceptMap/$closure (issue #100).
//
// Not implemented yet: every request gets a not-supported OperationOutcome.
//

const { TerminologyWorker } = require('./worker');
const { buildOperationOutcome, outcomeFromError } = require('../library/operation-outcome');
const { debugLog } = require('../operation-context');

class ClosureWorker extends TerminologyWorker {
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

  opName() {
    return 'closure';
  }

  // Not a value-set operation; the base class requires this to be implemented.
  vsHandle() {
    return null;
  }

  /**
   * Express entry point for [base]/$closure (GET and POST).
   * @param {express.Request} req - Express request
   * @param {express.Response} res - Express response
   */
  async handle(req, res) {
    try {
      return res.status(501).json(buildOperationOutcome('error', 'not-supported',
        'The $closure operation is not yet implemented on this server', 'not-supported'));
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      return res.status(error.statusCode || 500).json(outcomeFromError(error));
    }
  }
}

module.exports = ClosureWorker;
