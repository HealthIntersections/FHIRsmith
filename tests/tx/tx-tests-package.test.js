// Which build of the tx-ecosystem IG the terminology tests come from (tx/tests/tx-tests-package.js)

const { txTestsPackageVersion, txTestsBranch, txTestsSource } = require('../../tx/tests/tx-tests-package');

describe('the tx-ecosystem build the terminology tests come from', () => {
  test('the CI build of main, unless FHIRSMITH_TX_TESTS_VERSION says otherwise', () => {
    expect(txTestsPackageVersion({})).toBe('current');
    expect(txTestsPackageVersion({ FHIRSMITH_TX_TESTS_VERSION: '' })).toBe('current');
    expect(txTestsPackageVersion({ FHIRSMITH_TX_TESTS_VERSION: ' current ' })).toBe('current');
    expect(txTestsBranch('current')).toBeNull();
    expect(txTestsSource('current')).toBe('https://github.com/HL7/fhir-tx-ecosystem-ig/blob/main/tests/test-cases.json');
  });

  test('a branch\'s CI build, or a published version', () => {
    expect(txTestsPackageVersion({ FHIRSMITH_TX_TESTS_VERSION: 'current$2026-11-gg-fix' })).toBe('current$2026-11-gg-fix');
    expect(txTestsBranch('current$2026-11-gg-fix')).toBe('2026-11-gg-fix');
    expect(txTestsSource('current$2026-11-gg-fix')).toBe('https://github.com/HL7/fhir-tx-ecosystem-ig/blob/2026-11-gg-fix/tests/test-cases.json');
    expect(txTestsPackageVersion({ FHIRSMITH_TX_TESTS_VERSION: '1.11.0' })).toBe('1.11.0');
  });

  test('a branch name with a / in it, or anything else, is refused', () => {
    for (const v of ['current$a/b', 'current$', 'current$../x', 'latest', '1.0 OR 2']) {
      expect(() => txTestsPackageVersion({ FHIRSMITH_TX_TESTS_VERSION: v })).toThrow(/FHIRSMITH_TX_TESTS_VERSION is not a version/);
    }
  });
});
