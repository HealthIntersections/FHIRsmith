// library/auth/oauth.js
// Logging in with another site's account - GitHub or Google: the OAuth 2 authorization code
// flow, done directly (a redirect, then two or three HTTPS calls from the server) rather than
// through passport.
//
// Each provider is a definition below: where to send the browser, what to ask for, and how to
// turn the code that comes back into who the user is. The account here is tied to the
// provider's own id for the user - GitHub's numeric user id, Google's "sub" - never to a name
// or an email address, which can change or be reused.
//
//   GitHub: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
//   Google: https://developers.google.com/identity/openid-connect/openid-connect

const crypto = require('crypto');

const STATE_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 15000;

async function getJson(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) {
    throw new Error(`${new URL(url).host} answered ${r.status}`);
  }
  return r.json();
}

/**
 * The providers. identity() gets {id, handle, name, email}: id is the provider's id for the
 * user; handle what is shown for the identity (and matched by "{provider}:{handle}" in
 * auth.administrators); email a verified address, or null
 */
const PROVIDERS = {
  github: {
    key: 'github',
    label: 'GitHub',
    authorize: 'https://github.com/login/oauth/authorize',
    scope: 'read:user user:email',
    params: {},
    async identity(cfg, code, redirectUri) {
      const t = await getJson('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: redirectUri })
      });
      if (!t.access_token) {
        throw new Error(`GitHub did not give an access token${t.error ? `: ${t.error}` : ''}`);
      }
      const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${t.access_token}`, 'User-Agent': 'FHIRsmith' };
      const user = await getJson('https://api.github.com/user', { headers });
      if (!user || (typeof user.id !== 'number' && typeof user.id !== 'string') || typeof user.login !== 'string') {
        throw new Error('GitHub did not say who the user is');
      }
      let email = null;
      try {
        const emails = await getJson('https://api.github.com/user/emails', { headers });
        const primary = Array.isArray(emails) ? emails.find(e => e && e.primary && e.verified && typeof e.email === 'string') : null;
        email = primary ? primary.email : null;
      } catch {
        // no email: the account is made without one
      }
      return { id: String(user.id), handle: user.login, name: typeof user.name === 'string' ? user.name : '', email, login: user.login };
    }
  },
  google: {
    key: 'google',
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'openid email profile',
    // let someone signed in to more than one Google account choose
    params: { response_type: 'code', prompt: 'select_account' },
    async identity(cfg, code, redirectUri) {
      const t = await getJson('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }).toString()
      }).catch(e => {
        throw new Error(`Google did not give an access token: ${e.message}`);
      });
      if (!t.access_token) {
        throw new Error(`Google did not give an access token${t.error ? `: ${t.error}` : ''}`);
      }
      // the user's claims, straight from Google over TLS with the token just issued: no need to
      // check the id_token's signature as well
      const info = await getJson('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Accept: 'application/json', Authorization: `Bearer ${t.access_token}` } });
      if (!info || typeof info.sub !== 'string' || !info.sub) {
        throw new Error('Google did not say who the user is');
      }
      const verified = info.email_verified === true || info.email_verified === 'true';
      const email = verified && typeof info.email === 'string' ? info.email : null;
      if (!email) {
        throw new Error('Google did not give a verified email address for the account');
      }
      return { id: info.sub, handle: email.toLowerCase(), name: typeof info.name === 'string' ? info.name : '', email, login: email.split('@')[0] };
    }
  }
};

function callbackUrl(auth, provider, req) {
  const cfg = auth.providers[provider.key];
  if (typeof cfg.callbackUrl === 'string' && cfg.callbackUrl) {
    return cfg.callbackUrl;
  }
  return `${auth.publicUrl(req)}/auth/${provider.key}/callback`;
}

/**
 * Send the browser to the provider. `link` is the id of the logged in user whose account the
 * identity is to be linked to, or null to log in
 */
function start(auth, provider, req, res, { returnTo, link = null }) {
  const state = crypto.randomBytes(24).toString('base64url');
  req.session.oauth = { provider: provider.key, state, returnTo, link, at: Date.now() };
  const url = new URL(provider.authorize);
  url.searchParams.set('client_id', auth.providers[provider.key].clientId);
  url.searchParams.set('redirect_uri', callbackUrl(auth, provider, req));
  url.searchParams.set('scope', provider.scope);
  url.searchParams.set('state', state);
  for (const [k, v] of Object.entries(provider.params)) {
    url.searchParams.set(k, v);
  }
  req.session.save(() => res.redirect(url.toString()));
}

/** Check the callback's state against the session's; returns what start() kept, or throws */
function checkState(provider, req) {
  const o = req.session && req.session.oauth;
  delete req.session.oauth;
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (!o || o.provider !== provider.key || !state || state.length !== o.state.length ||
    !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(o.state)) || Date.now() - o.at > STATE_MS) {
    throw new Error(`The ${provider.label} login did not start here, or took too long - try again`);
  }
  if (typeof req.query.error === 'string') {
    throw new Error(req.query.error === 'access_denied' ? `${provider.label} login was cancelled` : `${provider.label} said: ${req.query.error}`);
  }
  if (typeof req.query.code !== 'string' || !req.query.code) {
    throw new Error(`${provider.label} did not give a code`);
  }
  return o;
}

/** Exchange the callback's code for who the user is: {id, handle, name, email, login} */
function identity(auth, provider, req) {
  return provider.identity(auth.providers[provider.key], req.query.code, callbackUrl(auth, provider, req));
}

module.exports = { PROVIDERS, start, checkState, identity, callbackUrl };
