/**
 * Shared-secret checks for administrative endpoints (library/request-token).
 *
 * The behaviour that matters: an unconfigured token never matches anything, so an
 * endpoint gated on this fails closed rather than defaulting to open.
 */

const { tokenMatches, tokenConfigured } = require('../../library/request-token');

describe('tokenMatches', () => {
  test('accepts the configured token', () => {
    expect(tokenMatches('s3cret', 's3cret')).toBe(true);
  });

  test('rejects a wrong token, including one that shares a prefix', () => {
    expect(tokenMatches('s3cret', 'wrong')).toBe(false);
    expect(tokenMatches('s3cret', 's3cre')).toBe(false);
    expect(tokenMatches('s3cret', 's3cretlonger')).toBe(false);
    expect(tokenMatches('s3cret', 'S3CRET')).toBe(false);
  });

  test('fails closed when nothing is configured', () => {
    expect(tokenMatches(undefined, 'anything')).toBe(false);
    expect(tokenMatches(null, 'anything')).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
    expect(tokenMatches('', 'anything')).toBe(false);
  });

  test('rejects a missing or non-string supplied value', () => {
    expect(tokenMatches('s3cret', undefined)).toBe(false);
    expect(tokenMatches('s3cret', '')).toBe(false);
    // Node hands back an array when a header is sent more than once.
    expect(tokenMatches('s3cret', ['s3cret', 's3cret'])).toBe(false);
    expect(tokenMatches('s3cret', { toString: () => 's3cret' })).toBe(false);
  });

  test('handles non-ASCII tokens', () => {
    expect(tokenMatches('pässwörd-✓', 'pässwörd-✓')).toBe(true);
    expect(tokenMatches('pässwörd-✓', 'password-✓')).toBe(false);
  });
});

describe('tokenConfigured', () => {
  test('distinguishes configured from absent', () => {
    expect(tokenConfigured('x')).toBe(true);
    expect(tokenConfigured('')).toBe(false);
    expect(tokenConfigured(undefined)).toBe(false);
    expect(tokenConfigured(null)).toBe(false);
    expect(tokenConfigured(123)).toBe(false);
  });
});
