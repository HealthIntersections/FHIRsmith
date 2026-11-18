/**
 * Containment tests for library/path-safety.
 *
 * These exist because of a real hole: the webBase static override in server.js used
 * path.join(overrideDir, req.path) with no containment check, and `GET /../SECRET.txt`
 * read files anywhere on the box as the server user. Express does not decode req.path,
 * so the encoded forms never arrived - but a literal '..' does, because only the
 * browsers and proxies in between normalise it away, and a raw client is not obliged to.
 */

const path = require('path');
const { resolveWithin } = require('../../library/path-safety');

const ROOT = '/srv/site';

describe('resolveWithin', () => {
  test('resolves an ordinary path under the root', () => {
    expect(resolveWithin(ROOT, '/index.html')).toBe(path.join(ROOT, 'index.html'));
    expect(resolveWithin(ROOT, '/sub/deep.txt')).toBe(path.join(ROOT, 'sub', 'deep.txt'));
  });

  test('allows the root itself', () => {
    expect(resolveWithin(ROOT, '/')).toBe(ROOT);
  });

  test('normalises harmless . and .. that stay inside', () => {
    expect(resolveWithin(ROOT, '/./index.html')).toBe(path.join(ROOT, 'index.html'));
    expect(resolveWithin(ROOT, '/sub/../index.html')).toBe(path.join(ROOT, 'index.html'));
  });

  test('refuses a path that climbs out', () => {
    expect(resolveWithin(ROOT, '/../SECRET.txt')).toBeNull();
    expect(resolveWithin(ROOT, '//../SECRET.txt')).toBeNull();
    expect(resolveWithin(ROOT, '/a/../../SECRET.txt')).toBeNull();
    expect(resolveWithin(ROOT, '/../../../../../../etc/passwd')).toBeNull();
  });

  test('refuses a sibling directory sharing the root name as a prefix', () => {
    // '/srv/site-backup/x' starts with '/srv/site' as a string but is not inside it.
    expect(resolveWithin(ROOT, '/../site-backup/x.txt')).toBeNull();
  });

  test('refuses a NUL in the path', () => {
    expect(resolveWithin(ROOT, '/ok.txt\0.png')).toBeNull();
  });

  test('does not decode percent-encoding, so it stays a literal filename', () => {
    // Express hands us an undecoded path; %2e%2e must be treated as a filename, never
    // as '..'. If a caller ever decodes before calling this, that is the caller's bug.
    expect(resolveWithin(ROOT, '/%2e%2e/SECRET.txt')).toBe(path.join(ROOT, '%2e%2e', 'SECRET.txt'));
  });

  test('tolerates a non-normalised or relative root', () => {
    expect(resolveWithin('/srv/./site/', '/index.html')).toBe(path.join(ROOT, 'index.html'));
    expect(resolveWithin('/srv/site/', '/../SECRET.txt')).toBeNull();
  });

  test('handles a path with no leading slash', () => {
    expect(resolveWithin(ROOT, 'index.html')).toBe(path.join(ROOT, 'index.html'));
  });

  test('returns null for non-string input rather than throwing', () => {
    expect(resolveWithin(ROOT, undefined)).toBeNull();
    expect(resolveWithin(undefined, '/x')).toBeNull();
  });
});
