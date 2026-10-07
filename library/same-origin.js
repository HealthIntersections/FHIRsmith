/**
 * Refuse form posts that come from another site (CSRF).
 *
 * The session-cookie modules (publisher, testing) take state-changing actions on a POST
 * from a logged-in browser. A page on another site can make the browser send such a
 * POST, cookie and all, unless something stops it. Two things do here:
 *
 *  - the session cookie is SameSite=Lax, so current browsers leave it off a POST that
 *    starts on another site;
 *  - this check: every browser sends an Origin header on a cross-site POST (and on
 *    same-site ones), so a POST whose Origin names another host is refused, whatever
 *    the browser did with the cookie.
 *
 * A request with no Origin at all (curl, older browsers on same-origin posts) is let
 * through - it can't be a browser being driven by another site's page. Behind a proxy,
 * the proxy must pass on Host or X-Forwarded-Host, or every post is refused.
 *
 * @module library/same-origin
 */

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Is this request allowed by the same-origin rule?
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isSameOrigin(req) {
  if (SAFE.has(req.method)) {
    return true;
  }
  const origin = req.get('Origin');
  if (!origin) {
    return true;
  }
  let host;
  try {
    // "null" (a sandboxed page, a file: URL, some redirects) does not parse, and is refused
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return host === req.get('host') || host === req.get('x-forwarded-host');
}

/**
 * Middleware that refuses cross-site requests that change things.
 * @param {function(req, res): void} [reject] - sends the refusal; default a plain 403
 */
function requireSameOrigin(reject) {
  return (req, res, next) => {
    if (isSameOrigin(req)) {
      return next();
    }
    if (reject) {
      return reject(req, res);
    }
    res.status(403).type('text/plain').send('Cross-site form posts are not accepted');
  };
}

module.exports = { isSameOrigin, requireSameOrigin };
