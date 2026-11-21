const { CanonicalResource } = require('../../tx/library/canonical-resource');

/**
 * isMoreRecent() is documented to return a boolean. The 'alpha' and (especially)
 * the 'default' branch compare versions with localeCompare(), which yields
 * -1/0/1 — and -1 is truthy. The default branch previously returned that raw
 * number, so it both returned a non-boolean and reported "more recent" exactly
 * when the version actually sorted EARLIER. These tests lock in the boolean
 * contract and correct ordering for both branches.
 */

function cr(version, algorithm) {
  const jsonObj = { resourceType: 'CodeSystem', url: 'http://example.org/cs', version };
  if (algorithm !== undefined) {
    jsonObj.versionAlgorithmString = algorithm;
  }
  return new CanonicalResource(jsonObj);
}

describe('CanonicalResource.isMoreRecent — boolean contract', () => {
  describe('alpha algorithm', () => {
    test('returns a strict boolean', () => {
      expect(typeof cr('b', 'alpha').isMoreRecent(cr('a', 'alpha'))).toBe('boolean');
      expect(typeof cr('a', 'alpha').isMoreRecent(cr('b', 'alpha'))).toBe('boolean');
    });

    test('true when this version sorts after other', () => {
      expect(cr('b', 'alpha').isMoreRecent(cr('a', 'alpha'))).toBe(true);
    });

    test('false when this version sorts before other', () => {
      expect(cr('a', 'alpha').isMoreRecent(cr('b', 'alpha'))).toBe(false);
    });
  });

  describe('default (unrecognised) algorithm', () => {
    test('returns a strict boolean even for the fallback branch', () => {
      expect(typeof cr('b', 'totally-unknown').isMoreRecent(cr('a', 'totally-unknown'))).toBe('boolean');
      expect(typeof cr('a', 'totally-unknown').isMoreRecent(cr('b', 'totally-unknown'))).toBe('boolean');
    });

    test('true when this version sorts after other', () => {
      expect(cr('b', 'totally-unknown').isMoreRecent(cr('a', 'totally-unknown'))).toBe(true);
    });

    // The original bug: localeCompare('a','b') === -1 (truthy) was returned as-is,
    // so this earlier-sorting version was wrongly reported as more recent.
    test('false (not truthy -1) when this version sorts before other', () => {
      const result = cr('a', 'totally-unknown').isMoreRecent(cr('b', 'totally-unknown'));
      expect(result).toBe(false);
    });
  });

  test('returns false when versions are equal', () => {
    expect(cr('a', 'totally-unknown').isMoreRecent(cr('a', 'totally-unknown'))).toBe(false);
  });
});
