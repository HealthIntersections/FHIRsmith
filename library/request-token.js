/**
 * Shared-secret checks for administrative endpoints.
 *
 * These are endpoints that do something expensive or destructive and have no user
 * behind them - a crawl trigger, a cache flush - so they are gated on a token from the
 * configuration rather than on a login. Two rules make that safe, and both are easy to
 * get wrong by hand:
 *
 *  - Fail closed. If no token is configured the endpoint is CLOSED, not open. An
 *    administrative endpoint that quietly defaults to unauthenticated is worse than one
 *    that is missing, because nothing about the deployment looks wrong.
 *  - Compare in constant time. A byte-at-a-time comparison leaks the token one
 *    character per round trip to anyone who can measure it.
 *
 * @module library/request-token
 */

const crypto = require('crypto');

/**
 * Does `supplied` match the configured token?
 *
 * @param {string|undefined|null} configured - The token from configuration. Anything
 *   empty or non-string means the endpoint is not configured, and the answer is always
 *   false - callers should say so rather than reporting a bad token.
 * @param {*} supplied - The token from the request (a header value). Non-strings, and
 *   the array Node produces for a repeated header, are rejected.
 * @returns {boolean}
 */
function tokenMatches(configured, supplied) {
  if (typeof configured !== 'string' || configured.length === 0) {
    return false;
  }
  if (typeof supplied !== 'string' || supplied.length === 0) {
    return false;
  }
  const a = Buffer.from(configured, 'utf8');
  const b = Buffer.from(supplied, 'utf8');
  // timingSafeEqual throws unless the lengths match, and the length itself is not a
  // secret worth protecting - but returning early on it would still be a comparison
  // whose cost depends on the input, so hash both to a fixed width and compare that.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Is this endpoint configured with a token at all?
 * @param {string|undefined|null} configured
 * @returns {boolean}
 */
function tokenConfigured(configured) {
  return typeof configured === 'string' && configured.length > 0;
}

module.exports = { tokenMatches, tokenConfigured };
