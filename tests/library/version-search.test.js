const { VersionUtilities } = require('../../library/version-utilities');

/**
 * The version search parameter: version-aware matching (K8), not a substring
 */
describe('VersionUtilities.versionSearchMatches', () => {
  const m = (c, v, alg) => VersionUtilities.versionSearchMatches(c, v, alg);

  test('semver: exact, or with wildcards', () => {
    expect(m('3.0.0', '3.0.0')).toBe(true);
    expect(m('3.0.x', '3.0.2')).toBe(true);
    expect(m('3.x.x', '3.1.2')).toBe(true);
    expect(m('3.0', '3.0.0')).toBe(false); // a partial version isn't a wildcard
    expect(m('0', '3.0.0')).toBe(false);
    expect(m('0.0', '3.0.0')).toBe(false);
    expect(m('3.0.0', '3.0.1')).toBe(false);
    expect(m('4.x', '3.1.2')).toBe(false);
  });

  test('other versions: exact, or a prefix', () => {
    expect(m('2024-01', '2024-01-15')).toBe(true);
    expect(m('2023', '2024-01-15')).toBe(false);
    expect(m('20240101', '20240101')).toBe(true);
    expect(m('1', '10')).toBe(false);
  });

  test("the resource's own versionAlgorithm is used", () => {
    expect(m('1', '10', 'alpha')).toBe(true);
    expect(m('1', '10', 'integer')).toBe(false);
  });

  test('no version asked for matches anything; a resource with no version matches nothing asked for', () => {
    expect(m('', '1.0.0')).toBe(true);
    expect(m('1.0.0', undefined)).toBe(false);
  });

  test('the prefix every match starts with', () => {
    expect(VersionUtilities.versionSearchPrefix('3.0.x')).toBe('3.0.');
    expect(VersionUtilities.versionSearchPrefix('3.0?')).toBe('3.0');
    expect(VersionUtilities.versionSearchPrefix('3.*')).toBe('3.');
    expect(VersionUtilities.versionSearchPrefix('20240101')).toBe('20240101');
  });

  test('versionAlgorithmOf', () => {
    expect(VersionUtilities.versionAlgorithmOf({ versionAlgorithmString: 'date' })).toBe('date');
    expect(VersionUtilities.versionAlgorithmOf({ versionAlgorithmCoding: { code: 'semver' } })).toBe('semver');
    expect(VersionUtilities.versionAlgorithmOf({})).toBeNull();
  });
});
