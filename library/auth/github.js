// library/auth/github.js
// Logging in with GitHub: the OAuth web flow (https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps),
// done directly - three HTTP calls - rather than through passport.
//
// The account is tied to GitHub's numeric user id, never the login name: a GitHub user can be
// renamed, and the old name taken by someone else.

const crypto = require('crypto');

const AUTHORIZE = 'https://github.com/login/oauth/authorize';
const TOKEN = 'https://github.com/login/oauth/access_token';
const API = 'https://api.github.com';
const STATE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 15000;

function callbackUrl(auth, req) {
  if (typeof auth.github.callbackUrl === 'string' && auth.github.callbackUrl) {
    return auth.github.callbackUrl;
  }
  return `${auth.publicUrl(req)}/auth/github/callback`;
}

/**
 * Send the browser to GitHub. `link` is the id of the logged in user whose account the GitHub
 * identity is to be linked to, or null to log in
 */
function start(auth, req, res, { returnTo, link = null }) {
  const state = crypto.randomBytes(24).toString('base64url');
  req.session.oauth = { state, returnTo, link, at: Date.now() };
  const url = new URL(AUTHORIZE);
  url.searchParams.set('client_id', auth.github.clientId);
  url.searchParams.set('redirect_uri', callbackUrl(auth, req));
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  req.session.save(() => res.redirect(url.toString()));
}

/** Check the callback's state against the session's; returns what start() kept, or throws */
function checkState(req) {
  const o = req.session && req.session.oauth;
  delete req.session.oauth;
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (!o || !state || state.length !== o.state.length ||
    !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(o.state)) || Date.now() - o.at > STATE_MS) {
    throw new Error('The GitHub login did not start here, or took too long - try again');
  }
  if (typeof req.query.error === 'string') {
    throw new Error(req.query.error === 'access_denied' ? 'GitHub login was cancelled' : `GitHub said: ${req.query.error}`);
  }
  if (typeof req.query.code !== 'string' || !req.query.code) {
    throw new Error('GitHub did not give a code');
  }
  return o;
}

async function getJson(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) {
    throw new Error(`GitHub answered ${r.status} to ${new URL(url).pathname}`);
  }
  return r.json();
}

/**
 * Exchange the callback's code for the GitHub identity
 * @returns {Promise<{id: string, login: string, name: string, email: string|null}>} email: the primary, verified one
 */
async function identity(auth, req) {
  const t = await getJson(TOKEN, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: auth.github.clientId, client_secret: auth.github.clientSecret, code: req.query.code, redirect_uri: callbackUrl(auth, req) })
  });
  if (!t.access_token) {
    throw new Error(`GitHub did not give an access token${t.error ? `: ${t.error}` : ''}`);
  }
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${t.access_token}`, 'User-Agent': 'FHIRsmith' };
  const user = await getJson(`${API}/user`, { headers });
  if (!user || (typeof user.id !== 'number' && typeof user.id !== 'string') || typeof user.login !== 'string') {
    throw new Error('GitHub did not say who the user is');
  }
  let email = null;
  try {
    const emails = await getJson(`${API}/user/emails`, { headers });
    const primary = Array.isArray(emails) ? emails.find(e => e && e.primary && e.verified && typeof e.email === 'string') : null;
    email = primary ? primary.email : null;
  } catch {
    // no email: the account is made without one
  }
  return { id: String(user.id), login: user.login, name: typeof user.name === 'string' ? user.name : '', email };
}

module.exports = { start, checkState, identity };
