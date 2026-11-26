//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Duplicate properties in a JSON body, as OperationOutcome issues.
 *
 * JSON.parse quietly keeps the last of two properties with the same name in an object, so a
 * body with one can't be stored or acted on as it was sent: the modules refuse it, whether or
 * not they validate. The issues are like the Java validator's (DUPLICATE_JSON_PROPERTY_KEY,
 * which says the property will be ignored), but with the message for refusing it
 * (DUPLICATE_JSON_PROPERTY_REJECTED, in core too), in the request's language, with where the
 * name is.
 *
 * @module library/json-duplicates
 */

const fhirJson = require('./fhir-json');
const { requestMessage } = require('./i18nsupport');

const MESSAGE_ID = 'DUPLICATE_JSON_PROPERTY_REJECTED';
const SD = 'http://hl7.org/fhir/StructureDefinition/';

/** line and column (from 1) of an offset in the text */
function lineAndColumn(s, offset) {
  let line = 1;
  let start = 0;
  for (let i = s.indexOf('\n'); i !== -1 && i < offset; i = s.indexOf('\n', i + 1)) {
    line++;
    start = i + 1;
  }
  return [line, offset - start + 1];
}

/**
 * The issues for the duplicate properties in some JSON: [] when there are none.
 * @param {string|Buffer} text - the body as it came
 * @param {Object} [options]
 * @param {string} [options.acceptLanguage] - the request's Accept-Language header
 * @param {string} [options.resourceType] - the body's resourceType, to start the expressions
 * @returns {Object[]} OperationOutcome.issue
 */
function duplicateIssues(text, options = {}) {
  const s = typeof text === 'string' ? text : String(text);
  const dups = fhirJson.findDuplicates(s);
  if (!dups.length) {
    return dups;
  }
  const root = typeof options.resourceType === 'string' && options.resourceType ? options.resourceType : '';
  return dups.map(d => {
    const [line, col] = lineAndColumn(s, d.offset);
    const path = root ? (d.path ? `${root}.${d.path}` : root) : (d.path || '$this');
    return {
      extension: [
        { url: SD + 'operationoutcome-issue-line', valueInteger: line },
        { url: SD + 'operationoutcome-issue-col', valueInteger: col },
        { url: SD + 'operationoutcome-message-id', valueString: MESSAGE_ID }
      ],
      severity: 'error',
      code: 'invalid',
      details: { text: requestMessage(options.acceptLanguage, MESSAGE_ID, [d.name]) },
      expression: [path]
    };
  });
}

/**
 * An OperationOutcome for the duplicate properties in some JSON, or null when there are none.
 * @param {string|Buffer} text
 * @param {Object} [options] - as duplicateIssues
 */
function duplicatesOutcome(text, options) {
  const issue = duplicateIssues(text, options);
  return issue.length ? { resourceType: 'OperationOutcome', issue } : null;
}

module.exports = { duplicateIssues, duplicatesOutcome, MESSAGE_ID };
