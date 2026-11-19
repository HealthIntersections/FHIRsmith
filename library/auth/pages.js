// library/auth/pages.js
// The pages under /auth: login (GitHub, Google or a password), logout, forgotten password and the
// one-time password links, a user's own account, and the administrator's users pages.
//
// Every page with a form has auth.session + auth.csrf; every form post has sameOrigin,
// session, the form parser and csrf - written out per route so the CSRF middleware is visible
// on every cookie-using route.

const express = require('express');
const rateLimit = require('express-rate-limit');
const escape = require('escape-html');
const bcrypt = require('bcrypt');
const oauth = require('./oauth');
const { AuthStore } = require('./store');
const { safeReturn, SERVER, ADMINISTRATOR, MIN_PASSWORD } = require('./auth');

const TEMPLATE = 'root';
// accounts, passwords, GitHub, roles and API tokens, for the people who use the pages
const HELP_URL = 'https://github.com/HealthIntersections/FHIRsmith/blob/main/library/auth/README.md';

// ---- rendering ----

function render(auth, req, res, title, content, status = 200) {
  const htmlServer = require('../html-server');
  let html;
  if (htmlServer.hasTemplate(TEMPLATE)) {
    // the template's top menu ends with the user's name, or Login ([%account%])
    html = htmlServer.renderPage(TEMPLATE, title, content);
  } else {
    html = `<!DOCTYPE html><html><head><title>${escape(title)}</title></head><body><p style="text-align: right">${auth.accountLink(req)}</p>` +
      `<h2>${escape(title)}</h2>${content}</body></html>`;
  }
  res.status(status);
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
}

function sendError(auth, req, res, status, message) {
  render(auth, req, res, 'Error', `<div class="alert alert-danger">${escape(message)}</div>`, status);
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

function csrfField(res) {
  return `<input type="hidden" name="_csrf" value="${escape(res.locals._csrf || '')}"/>`;
}

function alert(message) {
  if (!message) {
    return '';
  }
  const text = typeof message === 'string' ? message : message.text;
  const level = typeof message === 'string' ? 'info' : (message.level || 'info');
  return `<div class="alert alert-${escape(level)}">${escape(text)}</div>`;
}

function field(name, label, type, { help = '', required = false, value, autocomplete } = {}) {
  return `<div class="mb-3"><label for="f-${name}" class="form-label">${escape(label)}</label>` +
    `<input type="${type}" class="form-control" id="f-${name}" name="${name}"${required ? ' required' : ''}` +
    `${value !== undefined && value !== null ? ` value="${escape(value)}"` : ''}` +
    `${autocomplete ? ` autocomplete="${autocomplete}"` : ''}/>` +
    (help ? `<div class="form-text">${escape(help)}</div>` : '') + '</div>';
}

function postButton(res, action, label, cls = 'btn-secondary', confirmText = null, hidden = {}) {
  const extra = Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}"/>`).join('');
  return `<form method="post" action="${escape(action)}" style="display: inline"${confirmText ? ` onsubmit="return confirm('${escape(confirmText)}')"` : ''}>` +
    `${csrfField(res)}${extra}<button type="submit" class="btn btn-sm ${cls}">${escape(label)}</button></form>`;
}

function day(iso) {
  return iso ? String(iso).substring(0, 10) : '';
}

function ago(iso, t0 = Date.now()) {
  if (!iso) {
    return 'never';
  }
  const ms = t0 - new Date(iso).getTime();
  if (!(ms >= 0)) {
    return day(iso);
  }
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** A message for the next page */
function flash(req, text, level = 'success') {
  req.session.flash = { text, level };
}

function takeFlash(req) {
  const f = req.session && req.session.flash;
  if (f) {
    delete req.session.flash;
  }
  return f || null;
}

function regenerate(req) {
  return new Promise((resolve, reject) => req.session.regenerate(e => (e ? reject(e) : resolve())));
}

/** Log a user in: a new session (no fixation), remembering the user's epoch */
async function logIn(auth, req, user) {
  await regenerate(req);
  req.session.auth = { uid: user.id, epoch: user.epoch };
  auth.store.touchLogin(user.id);
}

function shown(text) {
  return String(text || '').replace(/[^\x20-\x7e]/g, '?').substring(0, 100);
}

// ---- the router ----

function buildRouter(auth) {
  const r = express.Router();
  // everything here may look someone up: limited, for logins and tokens (auth.credentialLimits)
  r.use(rateLimit(auth.credentialLimits()));
  const { session, csrf, form, sameOrigin } = auth;
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: auth.config.loginAttemptsPerWindow ?? 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => sendError(auth, req, res, 429, 'Too many attempts - try again later')
  });
  const user = auth.requirePage();
  const admin = auth.requireAdmin();
  const h = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(e => {
    auth.log.error(`Auth page ${req.method} ${req.originalUrl.replace(/\/reset\/[^/?]+/, '/reset/...')}: ${e.message}`);
    if (res.headersSent) {
      return next(e);
    }
    sendError(auth, req, res, 500, 'Something went wrong; the log says what');
  });

  // ---- login / logout ----

  r.get('/login', session, csrf, h((req, res) => sendLogin(auth, req, res, 200)));
  r.post('/login', sameOrigin, limiter, session, form, csrf, h((req, res) => login(auth, req, res)));
  r.post('/logout', sameOrigin, session, form, csrf, h((req, res) => {
    const back = safeReturn(str(req.body.return), auth.afterLogout());
    req.session.destroy(() => res.redirect(back));
  }));

  // ---- GitHub, Google (oauth.js) ----

  for (const p of Object.values(oauth.PROVIDERS)) {
    // the routes exist whether or not the provider is configured: 404 if it isn't
    const configured = (req, res) => {
      if (!auth.providers[p.key]) {
        sendError(auth, req, res, 404, `${p.label} login is not configured on this server`);
        return false;
      }
      return true;
    };
    r.get(`/${p.key}`, session, h((req, res) => {
      if (configured(req, res)) {
        oauth.start(auth, p, req, res, { returnTo: safeReturn(str(req.query.return), '/auth/account') });
      }
    }));
    r.get(`/${p.key}/callback`, session, h((req, res) => (configured(req, res) ? providerCallback(auth, p, req, res) : null)));
    r.post(`/account/${p.key}/link`, sameOrigin, session, form, csrf, user, h((req, res) => {
      if (configured(req, res)) {
        oauth.start(auth, p, req, res, { returnTo: '/auth/account', link: req.user.id });
      }
    }));
    r.post(`/account/${p.key}/unlink`, sameOrigin, session, form, csrf, user, h((req, res) => {
      const u = auth.store.userById(req.user.id);
      if (!u.password_hash && !linkedProviders(u).some(o => o.key !== p.key)) {
        flash(req, `Set a password first: without one, and without ${p.label}, you could not log in`, 'danger');
      } else {
        auth.store.setIdentity(p.key, u.id, null, null);
        auth.log.info(`Auth: '${u.login}' unlinked ${p.label}`);
        flash(req, `${p.label} is no longer linked to your account`);
      }
      res.redirect('/auth/account');
    }));
    r.post(`/admin/users/:id/${p.key}/unlink`, sameOrigin, session, form, csrf, admin, h((req, res) => {
      const u = targetUser(auth, req);
      if (!u) {
        return sendError(auth, req, res, 404, 'No such user');
      }
      auth.store.setIdentity(p.key, u.id, null, null);
      auth.log.info(`Auth: ${p.label} unlinked from '${u.login}' by ${req.user.login}`);
      flash(req, `${p.label} unlinked`);
      res.redirect(`/auth/admin/users/${u.id}`);
    }));
  }

  // ---- forgotten passwords, and the links that set one ----

  r.get('/forgot', session, csrf, h((req, res) => sendForgot(auth, req, res, 200)));
  r.post('/forgot', sameOrigin, limiter, session, form, csrf, h((req, res) => forgot(auth, req, res)));
  r.get('/reset/:secret', session, csrf, h((req, res) => sendReset(auth, req, res, 200)));
  r.post('/reset/:secret', sameOrigin, limiter, session, form, csrf, h((req, res) => reset(auth, req, res)));

  // ---- a user's own account ----

  r.get('/account', session, csrf, user, h((req, res) => sendAccount(auth, req, res)));
  r.post('/account/name', sameOrigin, session, form, csrf, user, h((req, res) => {
    auth.store.updateUser(req.user.id, { name: str(req.body.name).trim().substring(0, 200) });
    flash(req, 'Saved');
    res.redirect('/auth/account');
  }));
  r.post('/account/password', sameOrigin, limiter, session, form, csrf, user, h((req, res) => changePassword(auth, req, res)));
  r.post('/account/password-link', sameOrigin, limiter, session, form, csrf, user, h(async (req, res) => {
    const u = auth.store.userById(req.user.id);
    if (await auth.emailPasswordLink(u, req, 'reset')) {
      flash(req, `A link to set your password has been sent to ${u.email}`);
    } else {
      flash(req, u.email ? 'This server can\'t send email: ask the administrator for a link' : 'Your account has no email address: ask the administrator for a link', 'warning');
    }
    res.redirect('/auth/account');
  }));
  r.post('/account/tokens', sameOrigin, session, form, csrf, user, h((req, res) => issueToken(auth, req, res, req.user.id, '/auth/account')));
  r.post('/account/tokens/:tid/revoke', sameOrigin, session, form, csrf, user, h((req, res) => revokeToken(auth, req, res, req.user.id, '/auth/account')));
  r.post('/account/logout-everywhere', sameOrigin, session, form, csrf, user, h((req, res) => {
    auth.store.endSessions(req.user.id);
    req.session.destroy(() => res.redirect('/auth/login'));
  }));

  // ---- administration ----

  r.get('/admin/users', session, csrf, admin, h((req, res) => sendUsers(auth, req, res)));
  r.post('/admin/users', sameOrigin, session, form, csrf, admin, h((req, res) => createUser(auth, req, res)));
  r.get('/admin/users/:id', session, csrf, admin, h((req, res) => sendUser(auth, req, res)));
  r.post('/admin/users/:id', sameOrigin, session, form, csrf, admin, h((req, res) => updateUser(auth, req, res)));
  r.post('/admin/users/:id/roles', sameOrigin, session, form, csrf, admin, h((req, res) => updateRoles(auth, req, res)));
  r.post('/admin/users/:id/link', sameOrigin, session, form, csrf, admin, h((req, res) => adminLink(auth, req, res)));
  r.post('/admin/users/:id/password/remove', sameOrigin, session, form, csrf, admin, h(async (req, res) => {
    const u = targetUser(auth, req);
    if (!u) {
      return sendError(auth, req, res, 404, 'No such user');
    }
    await auth.store.setPassword(u.id, null);
    auth.log.info(`Auth: password of '${u.login}' removed by ${req.user.login}`);
    flash(req, 'Password removed: the user can only log in with GitHub or Google, or after setting a new one from a link');
    res.redirect(`/auth/admin/users/${u.id}`);
  }));
  r.post('/admin/users/:id/sessions', sameOrigin, session, form, csrf, admin, h((req, res) => {
    const u = targetUser(auth, req);
    if (!u) {
      return sendError(auth, req, res, 404, 'No such user');
    }
    auth.store.endSessions(u.id);
    flash(req, 'Every session of the user has ended');
    res.redirect(`/auth/admin/users/${u.id}`);
  }));
  r.post('/admin/users/:id/tokens', sameOrigin, session, form, csrf, admin, h((req, res) => issueToken(auth, req, res, userParam(req), `/auth/admin/users/${userParam(req)}`)));
  r.post('/admin/users/:id/tokens/:tid/revoke', sameOrigin, session, form, csrf, admin, h((req, res) => revokeToken(auth, req, res, userParam(req), `/auth/admin/users/${userParam(req)}`)));
  r.post('/admin/users/:id/delete', sameOrigin, session, form, csrf, admin, h((req, res) => {
    const u = targetUser(auth, req);
    if (!u) {
      return sendError(auth, req, res, 404, 'No such user');
    }
    if (u.id === req.user.id) {
      return sendError(auth, req, res, 400, 'You can\'t delete your own account');
    }
    auth.store.deleteUser(u.id);
    auth.log.info(`Auth: user '${u.login}' deleted by ${req.user.login}`);
    flash(req, `User ${u.login} deleted`);
    res.redirect('/auth/admin/users');
  }));

  // lusca rejects a form post with a missing or wrong token by passing on an error
  r.use((err, req, res, next) => {
    if (err && typeof err.message === 'string' && err.message.startsWith('CSRF token')) {
      return sendError(auth, req, res, 403, 'The form has expired or did not come from this site - reload the page and try again');
    }
    next(err);
  });
  return r;
}

// ---- login ----

function sendLogin(auth, req, res, status, error) {
  const ret = safeReturn(str(req.query.return || req.body?.return), '');
  const q = ret ? `?return=${escape(encodeURIComponent(ret))}` : '';
  let h = alert(error ? { text: error, level: 'danger' } : takeFlash(req));
  // first, logging in with another site's account: anyone can, and the first time makes an account
  const providers = Object.values(oauth.PROVIDERS).filter(p => auth.providers[p.key]);
  if (providers.length > 0) {
    h += '<p>' + providers.map(p => `<a class="btn btn-outline-dark" style="margin: 0 8px 8px 0" href="/auth/${p.key}${q}">Log in with ${p.label}</a>`).join('') + '</p>' +
      `<p class="text-muted"><small>Logging in with ${providers.map(p => p.label).join(' or ')} the first time makes you an account. ` +
      'It can\'t do anything until the administrator gives it a role.</small></p><hr/>' +
      '<p>Or log in with the username and password of an account you have been given:</p>';
  }
  h += `<form method="post" action="/auth/login" style="max-width: 420px">${csrfField(res)}` +
    (ret ? `<input type="hidden" name="return" value="${escape(ret)}"/>` : '') +
    field('login', 'Username or email', 'text', { required: true, autocomplete: 'username' }) +
    field('password', 'Password', 'password', { required: true, autocomplete: 'current-password' }) +
    '<button type="submit" class="btn btn-primary">Log in</button> &nbsp; ' +
    `<a href="/auth/forgot${q}">Forgotten your password?</a></form>`;
  h += `<p class="text-muted"><small><a href="${HELP_URL}">How logging in works</a></small></p>`;
  render(auth, req, res, 'Log in', h, status);
}

/** The providers whose identity is linked to this user row: [{key, label, handle}] */
function linkedProviders(u) {
  return Object.values(oauth.PROVIDERS).map(p => ({ p, i: AuthStore.identityOf(u, p.key) }))
    .filter(x => x.i).map(x => ({ key: x.p.key, label: x.p.label, handle: x.i.handle }));
}

async function login(auth, req, res) {
  const name = str(req.body.login).trim();
  const password = str(req.body.password);
  const u = name ? auth.store.userByLoginOrEmail(name) : null;
  // the comparison is made whether or not there is such a user, so the time taken doesn't say
  // which usernames exist
  const ok = await bcrypt.compare(password, u && u.password_hash ? u.password_hash : auth.store.dummyHash());
  if (!ok || !u || !u.password_hash || !u.enabled) {
    if (u) {
      auth.store.recordLogin('failed', 'password', u.id);
    }
    auth.log.info(`Auth: failed login for '${shown(name)}' from ${req.ip}`);
    return sendLogin(auth, req, res, 401, 'Unknown username or wrong password');
  }
  await logIn(auth, req, u);
  auth.store.recordLogin('login', 'password', u.id);
  auth.log.info(`Auth: '${u.login}' logged in from ${req.ip}`);
  res.redirect(safeReturn(str(req.body.return), '/auth/account'));
}

async function providerCallback(auth, p, req, res) {
  let o;
  let who;
  try {
    o = oauth.checkState(p, req);
    who = await oauth.identity(auth, p, req);
  } catch (e) {
    auth.log.info(`Auth: ${p.label} login failed from ${req.ip}: ${e.message}`);
    return sendError(auth, req, res, 400, e.message);
  }
  const bound = auth.store.userByIdentity(p.key, who.id);
  if (o.link) {
    // linking to the account logged in when it started (and still logged in)
    const me = auth.currentUser(req);
    if (!me || me.id !== o.link) {
      return sendError(auth, req, res, 400, 'You are no longer logged in as the account you were linking');
    }
    if (bound && bound.id !== me.id) {
      return sendError(auth, req, res, 400, `The ${p.label} account ${who.handle} is already linked to another account here`);
    }
    auth.store.setIdentity(p.key, me.id, who.id, who.handle);
    auth.log.info(`Auth: '${me.login}' linked ${p.label} ${who.handle} (${who.id})`);
    flash(req, `${p.label} ${who.handle} is linked: you can log in with it now`);
    return res.redirect('/auth/account');
  }
  let u = bound;
  if (u) {
    const had = AuthStore.identityOf(u, p.key);
    if (had.handle !== who.handle) {
      auth.store.setIdentity(p.key, u.id, who.id, who.handle); // renamed on GitHub, a new address at Google
      u = auth.store.userById(u.id);
    }
  } else {
    // a new account, with no roles. The email is the provider's verified one, unless an account
    // here already has it - accounts are never matched by email
    const email = who.email && !auth.store.userByEmail(who.email) ? who.email : null;
    const id = auth.store.createUser({
      login: auth.store.freeLogin(who.login), name: who.name || who.login, email,
      identity: { provider: p.key, id: who.id, handle: who.handle }, notes: `Made by logging in with ${p.label}`
    });
    u = auth.store.userById(id);
    auth.log.info(`Auth: account '${u.login}' made by ${p.label} login ${who.handle} (${who.id}) from ${req.ip}`);
  }
  if (!u.enabled) {
    auth.store.recordLogin('failed', p.key, u.id);
    return sendError(auth, req, res, 403, 'This account is disabled');
  }
  await logIn(auth, req, u);
  auth.store.recordLogin('login', p.key, u.id);
  auth.log.info(`Auth: '${u.login}' logged in with ${p.label} from ${req.ip}`);
  res.redirect(safeReturn(o.returnTo, '/auth/account'));
}

// ---- forgotten passwords ----

/** The page to come back to after logging in: a path on this server, or '' */
function returnOf(req) {
  return safeReturn(str(req.query.return || req.body?.return), '');
}

function sendForgot(auth, req, res, status, message) {
  const ret = returnOf(req);
  let h = alert(message);
  if (!auth.canEmail()) {
    h += '<p>This server can\'t send email. Ask the administrator for a link to set your password.</p>';
  } else {
    h += '<p>Say who you are, and a link to set your password will be sent to the email address of the account.</p>' +
      `<form method="post" action="/auth/forgot" style="max-width: 420px">${csrfField(res)}` +
      (ret ? `<input type="hidden" name="return" value="${escape(ret)}"/>` : '') +
      field('login', 'Username or email', 'text', { required: true, autocomplete: 'username' }) +
      '<button type="submit" class="btn btn-primary">Send the link</button></form>';
  }
  render(auth, req, res, 'Forgotten password', h, status);
}

async function forgot(auth, req, res) {
  const name = str(req.body.login).trim();
  const u = name ? auth.store.userByLoginOrEmail(name) : null;
  if (u && u.enabled && u.email) {
    try {
      // the link brings the user back to where they started logging in
      await auth.emailPasswordLink(u, req, 'reset', returnOf(req));
      auth.log.info(`Auth: password link for '${u.login}' emailed (asked from ${req.ip})`);
    } catch (e) {
      auth.log.error(`Auth: could not email a password link to '${u.login}': ${e.message}`);
    }
  } else {
    auth.log.info(`Auth: password link asked for '${shown(name)}' from ${req.ip}: no such enabled account with an email`);
  }
  // the same answer either way, so this doesn't say which accounts exist
  sendForgot(auth, req, res, 200, { text: 'If there is an account with an email address by that name, a link has been sent to it.', level: 'info' });
}

// The link's secret is in the URL, so the reset page doesn't send it as a referrer to other
// sites. Not 'no-referrer': with that, browsers send 'Origin: null' on the form post, and
// sameOrigin refuses it.
const RESET_REFERRER_POLICY = 'same-origin';

function sendReset(auth, req, res, status, error) {
  res.setHeader('Referrer-Policy', RESET_REFERRER_POLICY);
  const u = auth.store.checkLink(req.params.secret);
  if (!u) {
    return render(auth, req, res, 'Set your password', '<div class="alert alert-warning">This link has been used, has expired, or is not right. ' +
      '<a href="/auth/forgot">Ask for another</a>.</div>', 404);
  }
  let h = alert(error ? { text: error, level: 'danger' } : null);
  h += `<p>Choose a password for <b>${escape(u.login)}</b>${u.email ? ` (${escape(u.email)})` : ''}. It must be at least ${MIN_PASSWORD} characters; a password manager is a good idea.</p>` +
    `<form method="post" action="/auth/reset/${escape(encodeURIComponent(req.params.secret))}" style="max-width: 420px">${csrfField(res)}` +
    (returnOf(req) ? `<input type="hidden" name="return" value="${escape(returnOf(req))}"/>` : '') +
    `<input type="text" name="username" value="${escape(u.login)}" autocomplete="username" style="display: none"/>` +
    field('password', 'New password', 'password', { required: true, autocomplete: 'new-password' }) +
    field('confirm', 'The same again', 'password', { required: true, autocomplete: 'new-password' }) +
    '<button type="submit" class="btn btn-primary">Set password</button></form>';
  render(auth, req, res, 'Set your password', h, status);
}

async function reset(auth, req, res) {
  res.setHeader('Referrer-Policy', RESET_REFERRER_POLICY);
  const u = auth.store.checkLink(req.params.secret);
  if (!u) {
    return sendReset(auth, req, res, 404);
  }
  const problem = auth.passwordProblem(str(req.body.password), str(req.body.confirm));
  if (problem) {
    return sendReset(auth, req, res, 400, problem);
  }
  if (!auth.store.useLink(req.params.secret)) {
    return sendReset(auth, req, res, 404);
  }
  await auth.store.setPassword(u.id, str(req.body.password));
  auth.log.info(`Auth: password of '${u.login}' set from a link, from ${req.ip}`);
  await logIn(auth, req, auth.store.userById(u.id));
  flash(req, 'Your password is set, and you are logged in');
  // back where logging in started (a forgotten password from the login page), else the account
  res.redirect(returnOf(req) || '/auth/account');
}

// ---- a user's account ----

function describeRole(auth, r) {
  if (r.module === SERVER && r.role === ADMINISTRATOR) {
    return 'Administrator';
  }
  const def = (auth.roleDefs.get(r.module) || []).find(d => d.role === r.role);
  let text = `${r.module}: ${def ? def.label : r.role}`;
  if (r.scope) {
    let label = r.scope;
    if (def && def.scope) {
      try {
        const v = (def.scope.values() || []).find(x => String(x.value) === r.scope);
        label = v ? v.label : `${r.scope} (gone)`;
      } catch {
        // the module can't say: the raw scope
      }
    }
    text += ` - ${def && def.scope ? def.scope.label + ' ' : ''}${label}`;
  } else if (def && def.scope) {
    text += ` - every ${def.scope.label.toLowerCase()}`;
  }
  return text;
}

/**
 * What the user can do, from their roles: one line per role, linked to the module, with what
 * the role lets them do; for an administrator, the pages only administrators have
 */
function canDoHtml(auth, p) {
  let h = '<h4 style="margin-top: 1.5em">What you can do</h4><ul>';
  if (p.isAdmin) {
    h += `<li><b>Administrator</b>${p.adminFromConfig ? ' (from the configuration)' : ''}: everything on this server, in every module</li>` +
      '<li><a href="/auth/admin/users">Users</a>: the accounts on this server, and their roles</li>';
    for (const [module, info] of [...auth.moduleInfo.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const page of info.adminPages || []) {
        h += `<li>${escape(info.title || module)}: <a href="${escape(page.path)}">${escape(page.label)}</a>` +
          (page.description ? ` - ${escape(page.description)}` : '') + '</li>';
      }
    }
  }
  const roles = p.roles.filter(r => !(r.module === SERVER && r.role === ADMINISTRATOR));
  for (const r of roles) {
    const info = auth.moduleInfo.get(r.module) || {};
    const def = (auth.roleDefs.get(r.module) || []).find(d => d.role === r.role);
    const text = escape(describeRole(auth, r));
    h += `<li>${info.path ? `<a href="${escape(info.path)}">${text}</a>` : text}` +
      (def && def.description ? ` - ${escape(def.description)}` : '') + '</li>';
  }
  if (!p.isAdmin && roles.length === 0) {
    h += '<li>Read what this server shows everyone, and look after your account (below). ' +
      'You have no roles yet: an administrator gives them.</li>';
  }
  return h + '</ul>';
}

function sendAccount(auth, req, res) {
  const u = auth.store.userById(req.user.id);
  const p = req.user;
  let h = alert(takeFlash(req)) + newTokenBanner(req);
  h += `<p>You are logged in as <b>${escape(u.name || u.login)}</b>. ` +
    postButton(res, '/auth/logout', 'Logout', 'btn-outline-secondary') + '</p>';
  h += '<table class="grid" style="margin-bottom: 1em">' +
    `<tr><td><b>Login</b></td><td>${escape(u.login)}</td></tr>` +
    `<tr><td><b>Email</b></td><td>${escape(u.email || '(none)')} <small class="text-muted">(the administrator changes this)</small></td></tr>` +
    Object.values(oauth.PROVIDERS).filter(o => auth.providers[o.key] || AuthStore.identityOf(u, o.key)).map(o => {
      const i = AuthStore.identityOf(u, o.key);
      return `<tr><td><b>${o.label}</b></td><td>${i ? escape(i.handle) : '(not linked)'}</td></tr>`;
    }).join('') +
    `<tr><td><b>Since</b></td><td>${escape(day(u.created_at))}</td></tr>` +
    '</table>';
  h += canDoHtml(auth, p);
  h += '<h4 style="margin-top: 1.5em">Your account</h4>';
  h += `<h5>Name</h5><form method="post" action="/auth/account/name" class="row g-2" style="max-width: 560px">${csrfField(res)}` +
    `<div class="col"><input type="text" class="form-control" name="name" value="${escape(u.name)}" maxlength="200"/></div>` +
    '<div class="col-auto"><button type="submit" class="btn btn-secondary">Save</button></div></form>';

  h += '<h5 style="margin-top: 1.5em">Password</h5>';
  if (u.password_hash) {
    h += `<form method="post" action="/auth/account/password" style="max-width: 420px">${csrfField(res)}` +
      `<input type="text" name="username" value="${escape(u.login)}" autocomplete="username" style="display: none"/>` +
      field('current', 'Current password', 'password', { required: true, autocomplete: 'current-password' }) +
      field('password', 'New password', 'password', { required: true, autocomplete: 'new-password', help: `At least ${MIN_PASSWORD} characters` }) +
      field('confirm', 'The same again', 'password', { required: true, autocomplete: 'new-password' }) +
      '<button type="submit" class="btn btn-secondary">Change password</button></form>' +
      '<p class="text-muted"><small>Changing your password logs you out everywhere else.</small></p>';
  } else {
    const via = linkedProviders(u).map(o => o.label).join(' or ');
    h += `<p>Your account has no password: you log in with ${escape(via || 'a password link')}. ` +
      (u.email ? postButton(res, '/auth/account/password-link', 'Email me a link to set one') : 'To have one, ask the administrator for a link.') + '</p>';
  }

  for (const o of Object.values(oauth.PROVIDERS)) {
    const i = AuthStore.identityOf(u, o.key);
    if (!auth.providers[o.key] && !i) {
      continue;
    }
    h += `<h5 style="margin-top: 1.5em">${o.label}</h5>`;
    if (i) {
      h += `<p>You can log in with the ${o.label} account <b>${escape(i.handle)}</b>. ` +
        postButton(res, `/auth/account/${o.key}/unlink`, `Unlink ${o.label}`, 'btn-outline-danger', `Unlink ${o.label} from your account?`) + '</p>';
    } else {
      h += `<p>Link a ${o.label} account, and you can log in with it as well. ` +
        postButton(res, `/auth/account/${o.key}/link`, `Link ${o.label} account`, 'btn-outline-dark') + '</p>';
    }
  }

  h += tokensSection(auth, res, auth.store.tokensForUser(u.id), '/auth/account/tokens');
  h += '<h5 style="margin-top: 1.5em">Sessions</h5><p>' +
    postButton(res, '/auth/account/logout-everywhere', 'Log out everywhere', 'btn-outline-danger', 'End every session of your account, this one too?') + '</p>';
  render(auth, req, res, u.name || u.login, h);
}

async function changePassword(auth, req, res) {
  const u = auth.store.userById(req.user.id);
  if (!(await auth.store.checkPassword(u, str(req.body.current)))) {
    flash(req, 'The current password is wrong', 'danger');
    return res.redirect('/auth/account');
  }
  const problem = auth.passwordProblem(str(req.body.password), str(req.body.confirm));
  if (problem) {
    flash(req, problem, 'danger');
    return res.redirect('/auth/account');
  }
  await auth.store.setPassword(u.id, str(req.body.password));
  // this session goes on (in the new epoch); the user's others end
  await logIn(auth, req, auth.store.userById(u.id));
  auth.log.info(`Auth: '${u.login}' changed their password`);
  flash(req, 'Password changed');
  res.redirect('/auth/account');
}

// ---- tokens ----

function issueToken(auth, req, res, userId, back) {
  const u = auth.store.userById(userId);
  if (!u) {
    return sendError(auth, req, res, 404, 'No such user');
  }
  const label = str(req.body.label).trim().substring(0, 100);
  const days = Number(str(req.body.expires));
  const expiresInDays = Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 3650) : null;
  const t = auth.store.issueToken(u.id, { label, expiresInDays });
  auth.log.info(`Auth: token ${t.prefix}... issued for '${u.login}' by ${req.user.login}`);
  // shown once, on the next page
  req.session.newToken = t.token;
  res.redirect(back);
}

function revokeToken(auth, req, res, userId, back) {
  const tid = Number(req.params.tid);
  if (Number.isInteger(tid) && auth.store.revokeToken(userId, tid)) {
    auth.log.info(`Auth: token ${tid} of user ${userId} revoked by ${req.user.login}`);
    flash(req, 'Token revoked');
  }
  res.redirect(back);
}

function newTokenBanner(req) {
  const token = req.session.newToken;
  if (!token) {
    return '';
  }
  delete req.session.newToken;
  return '<div class="alert alert-success"><b>New token:</b> <code style="font-size: 110%">' + escape(token) + '</code>' +
    '<br/><small>Copy it now - it is not stored and can\'t be shown again. Send it as <code>Authorization: Bearer ' +
    escape(token.substring(0, 12)) + '...</code></small></div>';
}

function tokensSection(auth, res, tokens, issueUrl) {
  let h = '<h4 style="margin-top: 1.5em">API tokens</h4>' +
    '<p class="text-muted"><small>For software acting as this account: a token can do what the account\'s roles allow, no more.</small></p>';
  h += '<table class="grid"><thead><tr><th>Token</th><th>Label</th><th>Status</th><th>Created</th><th>Expires</th><th>Uses</th><th>Last used</th><th></th></tr></thead><tbody>';
  for (const t of tokens) {
    h += `<tr><td><code>${escape(t.prefix)}...</code></td><td>${escape(t.label)}</td><td>${escape(t.status)}</td>` +
      `<td>${escape(day(t.created_at))}</td><td>${escape(day(t.expires_at) || 'never')}</td><td>${t.use_count}</td><td>${escape(ago(t.last_used_at))}</td><td>`;
    if (t.status === 'active') {
      h += postButton(res, `${issueUrl}/${t.id}/revoke`, 'Revoke', 'btn-outline-danger', 'Revoke this token?');
    }
    h += '</td></tr>';
  }
  if (tokens.length === 0) {
    h += '<tr><td colspan="8"><i>no tokens</i></td></tr>';
  }
  h += '</tbody></table>';
  h += `<form method="post" action="${escape(issueUrl)}" class="row g-2" style="max-width: 640px; margin-top: 0.5em">${csrfField(res)}` +
    '<div class="col"><input type="text" class="form-control" name="label" placeholder="Label (what uses it)" maxlength="100"/></div>' +
    '<div class="col"><input type="number" class="form-control" name="expires" placeholder="Expires in days (optional)" min="1" max="3650"/></div>' +
    '<div class="col-auto"><button type="submit" class="btn btn-primary">New token</button></div></form>' +
    '<p class="text-muted"><small>To rotate a token: make a new one, move the software to it, then revoke the old one.</small></p>';
  return h;
}

// ---- administration ----

function userParam(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function targetUser(auth, req) {
  return auth.store.userById(userParam(req));
}

function sendUsers(auth, req, res, message, status = 200) {
  const users = auth.store.users();
  let h = alert(message || takeFlash(req));
  h += '<table class="grid"><thead><tr><th>Login</th><th>Name</th><th>Email</th><th>Logs in with</th><th>Password</th><th>Roles</th><th>Last login</th></tr></thead><tbody>';
  for (const u of users) {
    const p = auth.principalFor(u, 'session');
    const roles = (p.isAdmin ? ['Administrator'] : []).concat(p.roles.filter(r => !(r.module === SERVER && r.role === ADMINISTRATOR)).map(r => describeRole(auth, r)));
    h += `<tr${u.enabled ? '' : ' class="text-muted"'}><td><a href="/auth/admin/users/${u.id}">${escape(u.login)}</a>${u.enabled ? '' : ' (disabled)'}</td>` +
      `<td>${escape(u.name)}</td><td>${escape(u.email || '')}</td><td>${linkedProviders(u).map(o => `${escape(o.label)}: ${escape(o.handle)}`).join('<br/>')}</td><td>${u.password_hash ? 'yes' : ''}</td>` +
      `<td>${roles.length ? roles.map(x => escape(x)).join('<br/>') : '<i>none</i>'}</td><td>${escape(ago(u.last_login_at))}</td></tr>`;
  }
  if (users.length === 0) {
    h += '<tr><td colspan="7"><i>no users yet</i></td></tr>';
  }
  h += '</tbody></table>';
  h += '<h4 style="margin-top: 1.5em">New account</h4>' +
    '<p class="text-muted"><small>People who log in with GitHub or Google make their own accounts. Make one here for someone who will log in with a password, ' +
    `or for software (no email - it uses API tokens). ${auth.canEmail() ? 'Someone with an email address is sent a link to set their password.' : 'This server can\'t send email: you\'ll be shown the link that sets the password, to pass on.'}</small></p>` +
    `<form method="post" action="/auth/admin/users" style="max-width: 480px">${csrfField(res)}` +
    field('login', 'Login', 'text', { required: true, help: 'Letters, digits, and . _ @ + - (an email address will do)' }) +
    field('name', 'Name', 'text', { help: 'Who or what this is' }) +
    field('email', 'Email', 'email', { help: 'Where password links go; leave out for software' }) +
    '<button type="submit" class="btn btn-primary">Make the account</button></form>';
  render(auth, req, res, 'Users', h, status);
}

async function createUser(auth, req, res) {
  const login = str(req.body.login).trim();
  const name = str(req.body.name).trim().substring(0, 200);
  const email = str(req.body.email).trim();
  if (auth.store.userByLogin(login)) {
    return sendUsers(auth, req, res, { text: `There is already a user '${login}'`, level: 'danger' }, 400);
  }
  if (email && auth.store.userByEmail(email)) {
    return sendUsers(auth, req, res, { text: `There is already a user with the email ${email}`, level: 'danger' }, 400);
  }
  let id;
  try {
    id = auth.store.createUser({ login, name, email: email || null, notes: `Made by ${req.user.login}` });
  } catch (e) {
    return sendUsers(auth, req, res, { text: e.message, level: 'danger' }, 400);
  }
  auth.log.info(`Auth: user '${login}' made by ${req.user.login}`);
  const u = auth.store.userById(id);
  if (u.email) {
    await sendOrShowLink(auth, req, u, 'new');
  } else {
    flash(req, 'Account made. Give it roles, and an API token for the software that will use it');
  }
  res.redirect(`/auth/admin/users/${id}`);
}

/** Email the user a link to set their password, or if that can't be done, keep it to show the administrator */
async function sendOrShowLink(auth, req, u, reason) {
  let sent = false;
  try {
    sent = await auth.emailPasswordLink(u, req, reason);
  } catch (e) {
    auth.log.error(`Auth: could not email a password link to '${u.login}': ${e.message}`);
  }
  if (sent) {
    flash(req, `A link to set the password has been emailed to ${u.email}`);
  } else {
    req.session.newLink = auth.passwordLink(u.id, req);
    flash(req, 'The link that sets the password is below: pass it on to the user (it is shown once)', 'warning');
  }
}

function sendUser(auth, req, res, message, status = 200) {
  const u = targetUser(auth, req);
  if (!u) {
    return sendError(auth, req, res, 404, 'No such user');
  }
  const p = auth.principalFor(u, 'session');
  const isSelf = u.id === req.user.id;
  let h = '<p><a href="/auth/admin/users">&laquo; all users</a></p>' + alert(message || takeFlash(req)) + newTokenBanner(req);
  if (req.session.newLink) {
    h += `<div class="alert alert-warning"><b>Password link:</b> <code>${escape(req.session.newLink)}</code><br/><small>It works once, for ${auth.linkMinutes} minutes.</small></div>`;
    delete req.session.newLink;
  }
  h += `<p><b>Login:</b> ${escape(u.login)} &nbsp; <b>Made:</b> ${escape(day(u.created_at))} &nbsp; <b>Last login:</b> ${escape(ago(u.last_login_at))}` +
    linkedProviders(u).map(o => ` &nbsp; <b>${escape(o.label)}:</b> ${escape(o.handle)}`).join('') + ` &nbsp; <b>Password:</b> ${u.password_hash ? 'yes' : 'no'}</p>`;
  h += `<form method="post" action="/auth/admin/users/${u.id}" style="max-width: 560px">${csrfField(res)}` +
    field('name', 'Name', 'text', { value: u.name }) +
    field('email', 'Email', 'email', { value: u.email || '', help: 'Where password links go. An address named in auth.administrators makes the account an administrator' }) +
    field('notes', 'Notes', 'text', { value: u.notes }) +
    `<div class="mb-3"><label><input type="checkbox" name="enabled" value="1"${u.enabled ? ' checked' : ''}${isSelf ? ' disabled' : ''}/> Enabled (a disabled account can't log in, and its tokens don't work)</label></div>` +
    `<div class="mb-3"><label><input type="checkbox" name="admin" value="1"${p.isAdmin ? ' checked' : ''}${p.adminFromConfig || isSelf ? ' disabled' : ''}/> Administrator (server wide)` +
    `${p.adminFromConfig ? ' - from the configuration (auth.administrators)' : ''}</label></div>` +
    '<button type="submit" class="btn btn-primary">Save</button></form>';

  // the modules' roles
  h += '<h4 style="margin-top: 1.5em">Roles</h4>';
  if (auth.roleDefs.size === 0) {
    h += '<p><i>No module that is running has roles.</i></p>';
  } else {
    const held = new Set(p.roles.map(r => `${r.module}\u0000${r.role}\u0000${r.scope}`));
    h += `<form method="post" action="/auth/admin/users/${u.id}/roles">${csrfField(res)}<table class="grid">`;
    for (const [module, defs] of auth.roleDefs) {
      for (const d of defs) {
        h += `<tr><td><b>${escape(module)}</b></td><td>${escape(d.label)}${d.description ? `<br/><small class="text-muted">${escape(d.description)}</small>` : ''}</td><td>`;
        const box = (scope, label) => {
          const key = `${module}\u0000${d.role}\u0000${scope}`;
          return `<label style="margin-right: 1em"><input type="checkbox" name="role" value="${escape(JSON.stringify([module, d.role, scope]))}"${held.has(key) ? ' checked' : ''}/> ${escape(label)}</label>`;
        };
        if (d.scope) {
          h += box('', `every ${d.scope.label.toLowerCase()}`);
          let values = [];
          try {
            values = d.scope.values() || [];
          } catch (e) {
            auth.log.error(`Auth: ${module} could not list the ${d.scope.label}s: ${e.message}`);
          }
          for (const v of values) {
            h += box(String(v.value), v.label);
          }
        } else {
          h += box('', 'yes');
        }
        h += '</td></tr>';
      }
    }
    h += '</table><button type="submit" class="btn btn-primary" style="margin-top: 0.5em">Save roles</button></form>';
    if (p.isAdmin) {
      h += '<p class="text-muted"><small>An administrator has every role anyway.</small></p>';
    }
  }

  h += '<h4 style="margin-top: 1.5em">Password and login</h4><p>' +
    postButton(res, `/auth/admin/users/${u.id}/link`, u.email && auth.canEmail() ? 'Email a link to set the password' : 'Make a link to set the password') + ' ';
  if (u.password_hash) {
    h += postButton(res, `/auth/admin/users/${u.id}/password/remove`, 'Remove the password', 'btn-outline-danger', 'Remove this user\'s password?') + ' ';
  }
  for (const o of linkedProviders(u)) {
    h += postButton(res, `/auth/admin/users/${u.id}/${o.key}/unlink`, `Unlink ${o.label}`, 'btn-outline-danger', `Unlink ${o.label} from this account?`) + ' ';
  }
  h += postButton(res, `/auth/admin/users/${u.id}/sessions`, 'End their sessions', 'btn-outline-secondary') + '</p>';

  h += tokensSection(auth, res, auth.store.tokensForUser(u.id), `/auth/admin/users/${u.id}/tokens`);

  if (!isSelf) {
    h += '<h4 style="margin-top: 1.5em">Delete</h4><p>' +
      postButton(res, `/auth/admin/users/${u.id}/delete`, 'Delete the account', 'btn-danger', 'Delete this account, its roles and its tokens?') + '</p>';
  }
  render(auth, req, res, `User ${u.login}`, h, status);
}

function updateUser(auth, req, res) {
  const u = targetUser(auth, req);
  if (!u) {
    return sendError(auth, req, res, 404, 'No such user');
  }
  const isSelf = u.id === req.user.id;
  const email = str(req.body.email).trim();
  if (email && email.toLowerCase() !== String(u.email || '').toLowerCase() && auth.store.userByEmail(email)) {
    return sendUser(auth, req, res, { text: `Another account has the email ${email}`, level: 'danger' }, 400);
  }
  try {
    auth.store.updateUser(u.id, {
      name: str(req.body.name).trim().substring(0, 200),
      email: email || null,
      notes: str(req.body.notes).trim().substring(0, 1000)
    });
  } catch (e) {
    return sendUser(auth, req, res, { text: e.message, level: 'danger' }, 400);
  }
  if (!isSelf) {
    const enabled = req.body.enabled === '1';
    if (enabled !== u.enabled) {
      auth.store.setEnabled(u.id, enabled);
      auth.log.info(`Auth: '${u.login}' ${enabled ? 'enabled' : 'disabled'} by ${req.user.login}`);
    }
    const p = auth.principalFor(auth.store.userById(u.id), 'session');
    if (!p.adminFromConfig) {
      const wantAdmin = req.body.admin === '1';
      const isRoleAdmin = p.roles.some(r => r.module === SERVER && r.role === ADMINISTRATOR);
      if (wantAdmin && !isRoleAdmin) {
        auth.store.grant(u.id, SERVER, ADMINISTRATOR, '', req.user.login);
        auth.log.info(`Auth: '${u.login}' made an administrator by ${req.user.login}`);
      } else if (!wantAdmin && isRoleAdmin) {
        auth.store.revoke(u.id, SERVER, ADMINISTRATOR, '');
        auth.log.info(`Auth: '${u.login}' is no longer an administrator (${req.user.login})`);
      }
    }
  }
  flash(req, 'Saved');
  res.redirect(`/auth/admin/users/${u.id}`);
}

function updateRoles(auth, req, res) {
  const u = targetUser(auth, req);
  if (!u) {
    return sendError(auth, req, res, 404, 'No such user');
  }
  const wanted = new Set();
  for (const raw of [].concat(req.body.role || [])) {
    try {
      const [m, role, scope] = JSON.parse(raw);
      wanted.add(`${m}\u0000${role}\u0000${scope}`);
    } catch {
      // not one of ours: ignored
    }
  }
  // only the roles the running modules define are changed; others are left as they are
  for (const [module, defs] of auth.roleDefs) {
    for (const d of defs) {
      const scopes = [''];
      if (d.scope) {
        try {
          scopes.push(...(d.scope.values() || []).map(v => String(v.value)));
        } catch {
          // as on the page
        }
      }
      for (const scope of scopes) {
        const key = `${module}\u0000${d.role}\u0000${scope}`;
        if (wanted.has(key)) {
          auth.store.grant(u.id, module, d.role, scope, req.user.login);
        } else {
          auth.store.revoke(u.id, module, d.role, scope);
        }
      }
    }
  }
  auth.log.info(`Auth: roles of '${u.login}' set by ${req.user.login}`);
  flash(req, 'Roles saved');
  res.redirect(`/auth/admin/users/${u.id}`);
}

async function adminLink(auth, req, res) {
  const u = targetUser(auth, req);
  if (!u) {
    return sendError(auth, req, res, 404, 'No such user');
  }
  await sendOrShowLink(auth, req, u, u.password_hash ? 'reset' : 'new');
  auth.log.info(`Auth: password link for '${u.login}' made by ${req.user.login}`);
  res.redirect(`/auth/admin/users/${u.id}`);
}

module.exports = { buildRouter, sendError, render, describeRole };
