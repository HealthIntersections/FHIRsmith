/**
 * Containment for filesystem paths built from request URLs.
 *
 * The rule everywhere a URL path is turned into a filename: resolve first, then check
 * that the result is still inside the directory you meant to serve. `path.join` does
 * not do this - it resolves `..` happily and will walk straight out of the directory.
 *
 * Note that Express does not URL-decode `req.path`, so `%2e%2e` never arrives here as
 * `..`. A literal `..` does: nothing stops a client from sending `GET /../../etc/passwd`
 * on a raw socket, and only the browsers and proxies in between normalise it away.
 *
 * @module library/path-safety
 */

const path = require('path');

/**
 * Resolve a URL path against a root directory, refusing anything that escapes it.
 *
 * The trailing separator in the comparison is load-bearing: without it a sibling
 * directory whose name merely starts with the same characters ('/srv/site' vs
 * '/srv/site-backup') would be accepted as inside the root.
 *
 * @param {string} rootDir - Directory that the result must stay inside. Resolved first,
 *   so a relative or non-normalised root is fine.
 * @param {string} urlPath - Path from the request (e.g. `req.path`), leading slash and all.
 * @returns {string|null} The absolute path, or null if it would escape rootDir. The root
 *   directory itself is allowed through; callers that only want files should stat it.
 */
function resolveWithin(rootDir, urlPath) {
  if (typeof rootDir !== 'string' || typeof urlPath !== 'string') {
    return null;
  }
  // A NUL truncates the name inside libc, so a path containing one is never what it
  // appears to be. Node throws on these anyway; refusing here keeps the answer a null
  // rather than an exception from whatever the caller does next.
  if (urlPath.includes('\0')) {
    return null;
  }
  const root = path.resolve(rootDir);
  // '.' + urlPath keeps the join relative: resolve() would otherwise treat a leading
  // slash as an absolute path and discard the root entirely.
  const full = path.resolve(root, '.' + (urlPath.startsWith('/') ? urlPath : '/' + urlPath));
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(prefix)) {
    return null;
  }
  return full;
}

module.exports = { resolveWithin };
