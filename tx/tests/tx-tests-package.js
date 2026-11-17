/**
 * Which build of the tx-ecosystem IG (hl7.fhir.uv.tx-ecosystem) the terminology tests run, and
 * the test list is generated, from: FHIRSMITH_TX_TESTS_VERSION, or "current" (the CI build of
 * main).
 *
 * A FHIRsmith PR that needs changes to the tests can be tested against the tx-ecosystem PR that
 * makes them, before that is merged: the CI build of a branch is "current$<branch>". The PR
 * workflow (.github/workflows/ci.yml) sets it when the tx-ecosystem repository has an open PR
 * from a branch with the same name as this PR's, and a CI build of it. A branch name with a /
 * in it isn't supported: the CI build server can't be asked for one.
 */

const PACKAGE_ID = 'hl7.fhir.uv.tx-ecosystem';
const REPO = 'https://github.com/HL7/fhir-tx-ecosystem-ig';
const VERSION_PATTERN = /^(current|current\$[A-Za-z0-9][A-Za-z0-9._-]*|[0-9][0-9A-Za-z.\-+]*)$/;

/**
 * @param {Object} [env] - process.env
 * @returns {string} "current", "current$<branch>", or a published version
 */
function txTestsPackageVersion(env = process.env) {
  const version = (env.FHIRSMITH_TX_TESTS_VERSION || '').trim() || 'current';
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`FHIRSMITH_TX_TESTS_VERSION is not a version of ${PACKAGE_ID} that can be used: ${JSON.stringify(version)} ` +
      '(current, current$<branch> with no / in the branch name, or a published version)');
  }
  return version;
}

/**
 * The branch a version is the CI build of, or null
 * @param {string} version
 * @returns {string|null}
 */
function txTestsBranch(version) {
  return version.startsWith('current$') ? version.substring('current$'.length) : null;
}

/**
 * The test-cases.json the tests come from, for the TestReport's testScript
 * @param {string} version
 * @returns {string}
 */
function txTestsSource(version) {
  return `${REPO}/blob/${txTestsBranch(version) || 'main'}/tests/test-cases.json`;
}

module.exports = { PACKAGE_ID, txTestsPackageVersion, txTestsBranch, txTestsSource };
