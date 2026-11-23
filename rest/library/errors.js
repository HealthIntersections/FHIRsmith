//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Errors that become an OperationOutcome and an HTTP status.
 *
 * @module rest/library/errors
 */

class FhirError extends Error {
  /**
   * @param {number} status - HTTP status
   * @param {string} code - issue type (not-found, invalid, conflict, ...)
   * @param {string} message
   * @param {Object} [extra] - { expression: string[], headers: Object, issues: Object[] }
   */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.expression = extra.expression;
    this.headers = extra.headers || {};
    this.issues = extra.issues || null;
  }

  outcome() {
    return operationOutcome(this.issues || [{ severity: 'error', code: this.code, diagnostics: this.message, expression: this.expression }]);
  }
}

const badRequest = (msg, extra) => new FhirError(400, 'invalid', msg, extra);
const notFound = (msg) => new FhirError(404, 'not-found', msg);
const gone = (msg, extra) => new FhirError(410, 'deleted', msg, extra);
const conflict = (msg) => new FhirError(409, 'conflict', msg);
const preconditionFailed = (msg) => new FhirError(412, 'conflict', msg);
const forbidden = (msg) => new FhirError(403, 'forbidden', msg);
const unauthorised = (msg) => new FhirError(401, 'login', msg);
const notSupported = (msg) => new FhirError(501, 'not-supported', msg);
const notAllowed = (msg) => new FhirError(405, 'not-supported', msg);
const unprocessable = (msg, extra) => new FhirError(422, 'processing', msg, extra);
const tooCostly = (msg) => new FhirError(400, 'too-costly', msg);

/**
 * @param {Array<{severity: string, code: string, diagnostics?: string, expression?: string[]}>} issues
 */
function operationOutcome(issues) {
  return {
    resourceType: 'OperationOutcome',
    issue: issues.map(i => {
      const o = { severity: i.severity || 'error', code: i.code || 'processing' };
      if (i.diagnostics) {
        o.diagnostics = i.diagnostics;
        o.details = { text: i.diagnostics };
      }
      if (i.expression && i.expression.length) {
        o.expression = i.expression;
      }
      return o;
    })
  };
}

module.exports = {
  FhirError, badRequest, notFound, gone, conflict, preconditionFailed, forbidden, unauthorised, notSupported, notAllowed,
  unprocessable, tooCostly, operationOutcome
};
