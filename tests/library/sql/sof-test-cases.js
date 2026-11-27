//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The shared SQL on FHIR test cases: the sql-on-fhir folder of fhir-test-cases
 * (https://github.com/FHIR/fhir-test-cases), the same cases org.hl7.fhir.core runs, listed by
 * its manifest.json. Found by tests/helpers/fhir-test-cases.js: in $FHIR_TEST_CASES, a
 * test-cases clone beside FHIRsmith, or downloaded from GitHub into test-cache.
 */

const fs = require('fs');
const path = require('path');
const { testCaseFolder } = require('../../helpers/fhir-test-cases');

function findFolder() {
  return testCaseFolder('sql-on-fhir');
}

/**
 * @returns {{folder: string, files: Array<{name: string, content: Object}>}}
 */
function loadTestCases() {
  const folder = findFolder();
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  const files = manifest.map(name => ({
    name,
    content: JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'))
  }));
  return { folder, files };
}

module.exports = { loadTestCases };
