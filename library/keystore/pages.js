// library/keystore/pages.js
// /keys: the public list of keys (web and JWKS), a page for each key, a user's own keys
// (upload, make, revoke, label), the administrator's page (system keys, deleting, key ids), and
// the API for software (an API token). See README.md.
//
// Every page with a form has auth.session + auth.csrf; every form post has sameOrigin,
// session, the form parser and csrf, written out per route as in library/auth/pages.js.

const express = require('express');
const rateLimit = require('express-rate-limit');
const escape = require('escape-html');
const { KEY_TYPES, MAX_UPLOAD_BYTES } = require('./keys');
const { KeyStoreError, SYSTEM } = require('./keystore');

const HELP_URL = 'https://github.com/HealthIntersections/FHIRsmith/blob/main/library/keystore/README.md';
const EVENT_WORDS = { upload: 'uploaded', create: 'created', retire: 'retired', revoke: 'revoked', rename: 'key id changed', destroy: 'private key destroyed' };

function str(v) {
  return typeof v === 'string' ? v : '';
}

function day(iso) {
  return iso ? String(iso).substring(0, 10) : '';
}

function when(iso) {
  return iso ? String(iso).substring(0, 16).replace('T', ' ') + ' UTC' : '';
}

function keyUrl(row) {
  return `/keys/key/${encodeURIComponent(row.key_id)}`;
}

function csrfField(res) {
  return `<input type="hidden" name="_csrf" value="${escape(res.locals._csrf || '')}"/>`;
}

function postButton(res, action, label, cls = 'btn-secondary', confirmText = null, hidden = {}) {
  const extra = Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}"/>`).join('');
  return `<form method="post" action="${escape(action)}" style="display: inline"${confirmText ? ` data-confirm="${escape(confirmText)}" onsubmit="return confirm(this.dataset.confirm)"` : ''}>` +
    `${csrfField(res)}${extra}<button type="submit" class="btn btn-sm ${cls}">${escape(label)}</button></form>`;
}

function flash(req, text, level = 'success') {
  if (req.session) {
    req.session.keystoreFlash = { text, level };
  }
}

function takeFlash(req) {
  const f = req.session && req.session.keystoreFlash;
  if (f) {
    delete req.session.keystoreFlash;
    return `<div class="alert alert-${escape(f.level)}" role="${f.level === 'danger' ? 'alert' : 'status'}">${escape(f.text)}</div>`;
  }
  return '';
}

function statusText(row) {
  if (row.status === 'revoked') {
    return `revoked${row.expires ? ` (from ${day(row.expires)})` : ''}`;
  }
  return row.status;
}

function buildRouter(ks) {
  const auth = ks.auth;
  const { render, sendError } = require('../auth/pages');
  const r = express.Router();
  // pages and APIs here may look someone up: limited, for logins and tokens (auth.credentialLimits)
  r.use(rateLimit(auth.credentialLimits()));
  const { session, csrf, form, sameOrigin } = auth;
  const user = auth.requirePage();
  const admin = auth.requireAdmin();
  const page = (req, res, title, content, status = 200) => render(auth, req, res, title, content, status);
  const error = (req, res, status, message) => sendError(auth, req, res, status, message);
  const h = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(e => {
    if (e instanceof KeyStoreError) {
      return error(req, res, e.status, e.message);
    }
    ks.log.error(`Keystore page ${req.method} ${req.originalUrl}: ${e.message}`);
    if (res.headersSent) {
      return next(e);
    }
    error(req, res, 500, 'Something went wrong; the log says what');
  });
  // a form action: done (a message for the next page) or refused (the message, as an error), back to `back`
  const act = (fn, back) => h((req, res) => {
    const to = typeof back === 'function' ? back(req) : back;
    try {
      const text = fn(req, res);
      flash(req, text);
    } catch (e) {
      if (!(e instanceof KeyStoreError)) {
        throw e;
      }
      flash(req, e.message, 'danger');
    }
    res.redirect(to);
  });
  const rowParam = (req) => {
    const id = Number(req.params.id);
    const row = Number.isInteger(id) && id > 0 ? ks.keyById(id) : null;
    if (!row) {
      throw new KeyStoreError('No such key', 404);
    }
    return row;
  };
  // back to the page the form was on (the user's keys, a key's page, the admin page)
  const backTo = (req) => {
    const b = str(req.body && req.body.back);
    return /^\/keys(\/[^?#]*)?$/.test(b) ? b : '/keys/mine';
  };

  // ---- the public list ----

  r.get('/', ...auth.web, h((req, res) => {
    const filter = filterOf(req);
    const rows = ks.list(filter);
    const me = auth.currentUser(req);
    let c = takeFlash(req);
    c += '<p>The public keys on this server, for checking signatures. Each key is shown as uploaded or created by its owner: ' +
      'that is all the server says about it. The server holds the private key only of keys it created. ' +
      `<a href="${HELP_URL}">More</a></p>`;
    c += `<p>${me ? '<a href="/keys/mine">Your keys</a>: upload a public key, or have the server make a key pair for you.' :
      `<a href="${escape(auth.loginUrl(req, '/keys/mine'))}">Log in</a> to upload your public keys, or have the server make a key pair for you.`}` +
      `${me && me.isAdmin ? ' <a href="/keys/admin">Administer the keys</a>.' : ''}` +
      ' As JSON: <a href="/keys/jwks.json">JWKS</a>.</p>';
    c += filterForm(filter);
    c += keyTable(ks, rows, { caption: `${rows.length} key${rows.length === 1 ? '' : 's'}` });
    page(req, res, 'Keys', c);
  }));

  r.get('/jwks.json', h((req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.json(ks.jwks(filterOf(req)));
  }));

  // ---- one key ----

  r.get('/key/:kid', ...auth.web, h((req, res) => {
    const row = ks.key(req.params.kid);
    const fmt = str(req.query.format) || (req.accepts(['html', 'application/json', 'application/jwk+json', 'application/x-pem-file']) || 'html');
    if (!row) {
      if (fmt === 'html') {
        return error(req, res, 404, 'No such key');
      }
      return res.status(404).json({ error: 'not-found', message: 'No such key' });
    }
    if (fmt === 'json' || fmt === 'application/json' || fmt === 'application/jwk+json') {
      return res.json(ks.jwk(row));
    }
    if (fmt === 'pem' || fmt === 'application/x-pem-file') {
      res.setHeader('Content-Type', 'application/x-pem-file');
      return res.send(ks.pem(row));
    }
    sendKey(ks, req, res, row, page);
  }));

  // ---- a user's own keys ----

  r.get('/mine', session, csrf, user, h((req, res) => sendMine(ks, req, res, page)));

  r.post('/mine/upload', sameOrigin, session, form, csrf, user, act(req => {
    const added = ks.upload(req.user, str(req.body.key), { kid: str(req.body.kid), label: str(req.body.label) });
    return added.length === 1 ? `Key ${added[0].key_id} uploaded` : `${added.length} keys uploaded`;
  }, '/keys/mine'));

  r.post('/mine/create', sameOrigin, session, form, csrf, user, act(req => {
    const row = ks.create(req.user, str(req.body.kty), { label: str(req.body.label) });
    return `New ${KEY_TYPES[row.kty].label} key pair made: ${row.key_id}`;
  }, '/keys/mine'));

  r.post('/manage/:id/revoke', sameOrigin, session, form, csrf, user, act(req => {
    const row = ks.revoke(req.user, rowParam(req).id, { reason: str(req.body.reason), expires: str(req.body.expires) });
    return `Key ${row.key_id} revoked`;
  }, backTo));

  r.post('/manage/:id/label', sameOrigin, session, form, csrf, user, act(req => {
    ks.setLabel(req.user, rowParam(req).id, str(req.body.label));
    return 'Label saved';
  }, backTo));

  // ---- the administrator ----

  r.get('/admin', session, csrf, admin, h((req, res) => sendAdmin(ks, req, res, page)));

  r.post('/admin/create', sameOrigin, session, form, csrf, admin, act(req => {
    const row = ks.create(req.user, str(req.body.kty), { system: true, label: str(req.body.label) });
    return `New system ${KEY_TYPES[row.kty].label} key pair made: ${row.key_id}`;
  }, '/keys/admin'));

  r.post('/admin/:id/delete', sameOrigin, session, form, csrf, admin, act(req => {
    const row = ks.remove(req.user, rowParam(req).id);
    return `Key ${row.key_id} deleted`;
  }, '/keys/admin'));

  r.post('/admin/:id/kid', sameOrigin, session, form, csrf, admin, act(req => {
    const row = ks.setKid(req.user, rowParam(req).id, str(req.body.kid));
    return `The key's id is now ${row.key_id}`;
  }, '/keys/admin'));

  // ---- the API (an API token, or a login) ----

  const api = auth.requireApi();
  const apiH = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => {
    if (e instanceof KeyStoreError) {
      return res.status(e.status).json({ error: e.kind || 'invalid', message: e.message });
    }
    ks.log.error(`Keystore API ${req.method} ${req.originalUrl}: ${e.message}`);
    res.status(500).json({ error: 'exception', message: 'Something went wrong; the log says what' });
  });
  const body = (req) => (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {});

  // {key: text, or a JWK/JWKS object; kid?; label?}
  r.post('/api/upload', api, apiH((req, res) => {
    const b = body(req);
    const key = typeof b.key === 'string' ? b.key : b.key && typeof b.key === 'object' ? JSON.stringify(b.key) : '';
    const added = ks.upload(req.user, key, { kid: str(b.kid), label: str(b.label) });
    res.status(201).json({ keys: added.map(row => ks.jwk(row)) });
  }));

  // {kty, label?, system?}
  r.post('/api/create', api, apiH((req, res) => {
    const b = body(req);
    const row = ks.create(req.user, str(b.kty), { system: b.system === true, label: str(b.label) });
    res.status(201).json(ks.jwk(row));
  }));

  // {reason?, expires?}
  r.post('/api/key/:kid/revoke', api, apiH((req, res) => {
    const row = ks.key(req.params.kid);
    if (!row) {
      throw new KeyStoreError('No such key', 404);
    }
    const b = body(req);
    res.json(ks.jwk(ks.revoke(req.user, row.id, { reason: str(b.reason), expires: str(b.expires) })));
  }));

  r.get('/api/mine', api, apiH((req, res) => {
    res.json({ keys: ks.list({ owner: req.user.id }).map(row => ks.jwk(row)), uploadsLeft: finite(ks.uploadsLeft(req.user)) });
  }));

  return r;
}

function finite(n) {
  return Number.isFinite(n) ? n : null;
}

function filterOf(req) {
  const q = req.query || {};
  return {
    status: str(q.status),
    kty: str(q.kty),
    system: str(q.owner) === 'system'
  };
}

function filterForm(filter) {
  const opt = (v, label, cur) => `<option value="${escape(v)}"${v === cur ? ' selected' : ''}>${escape(label)}</option>`;
  return '<form method="get" action="/keys" style="display: flex; gap: 0.5em; align-items: flex-end; flex-wrap: wrap; max-width: 760px; margin-bottom: 1em">' +
    '<div style="flex: 1 1 12em"><label for="f-status" class="form-label">Status</label><select id="f-status" name="status" class="form-select">' +
    opt('', 'any', filter.status) + ['active', 'retired', 'revoked'].map(s => opt(s, s, filter.status)).join('') + '</select></div>' +
    '<div style="flex: 1 1 12em"><label for="f-kty" class="form-label">Type</label><select id="f-kty" name="kty" class="form-select">' +
    opt('', 'any', filter.kty) + Object.entries(KEY_TYPES).map(([k, t]) => opt(k, t.label, filter.kty)).join('') + '</select></div>' +
    '<div style="flex: 1 1 12em"><label for="f-owner" class="form-label">Owner</label><select id="f-owner" name="owner" class="form-select">' +
    opt('', 'anyone', filter.system ? 'system' : '') + opt('system', 'the system', filter.system ? 'system' : '') + '</select></div>' +
    '<div><button type="submit" class="btn btn-secondary">Show</button></div></form>';
}

function origin(ks, row) {
  return `${row.origin === 'created' ? 'created' : 'uploaded'} by ${row.owner === SYSTEM ? '<b>System</b>' : escape(ks.ownerName(row))}`;
}

/**
 * Can the server sign with this key? Words, not colour: the server holds the private key of an
 * active key pair it made; an uploaded key is only ever a public key
 */
function signingText(row) {
  if (row.has_private) {
    return '<b>Signs</b>';
  }
  if (row.origin === 'created') {
    return 'No (private key destroyed)';
  }
  return 'No (public key only)';
}

/**
 * A table of keys. actions(row) adds a last column of buttons
 */
function keyTable(ks, rows, { caption = '', actions = null } = {}) {
  let t = '<table class="grid">' + (caption ? `<caption>${escape(caption)}</caption>` : '') +
    '<thead><tr><th scope="col">Key id</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Can sign</th><th scope="col">Owner</th>' +
    '<th scope="col">Created</th><th scope="col">Label</th>' + (actions ? '<th scope="col">Actions</th>' : '') + '</tr></thead><tbody>';
  for (const row of rows) {
    t += `<tr><td><a href="${escape(keyUrl(row))}"><code>${escape(row.key_id)}</code></a>${row.claimed ? ' <small>(claimed)</small>' : ''}</td>` +
      `<td>${escape(KEY_TYPES[row.kty].label)}${row.kty === 'RSA' ? ` ${row.bits}` : ''}</td>` +
      `<td>${escape(statusText(row))}</td><td>${signingText(row)}</td><td>${origin(ks, row)}</td><td>${escape(day(row.created))}</td><td>${escape(row.label)}</td>` +
      (actions ? `<td>${actions(row)}</td>` : '') + '</tr>';
  }
  if (rows.length === 0) {
    t += `<tr><td colspan="${actions ? 8 : 7}"><i>no keys</i></td></tr>`;
  }
  return t + '</tbody></table>';
}

function revokeForm(res, row, back) {
  return `<details><summary class="btn btn-sm btn-outline-danger">Revoke</summary><form method="post" action="/keys/manage/${row.id}/revoke" style="max-width: 420px; margin-top: 0.5em" ` +
    'data-confirm="Revoke this key? It can\'t be undone" onsubmit="return confirm(this.dataset.confirm)">' + csrfField(res) +
    `<input type="hidden" name="back" value="${escape(back)}"/>` +
    `<label for="r-reason-${row.id}" class="form-label">Why (shown with the key)</label>` +
    `<input type="text" id="r-reason-${row.id}" name="reason" class="form-control" maxlength="500"/>` +
    `<label for="r-expires-${row.id}" class="form-label" style="margin-top: 0.5em">Not to be trusted from (UTC; empty: now)</label>` +
    `<input type="datetime-local" id="r-expires-${row.id}" name="expires" class="form-control"/>` +
    '<button type="submit" class="btn btn-sm btn-outline-danger" style="margin-top: 0.5em">Revoke</button></form></details>';
}

function sendKey(ks, req, res, row, page) {
  const me = auth(ks).currentUser(req);
  const manage = ks.canManage(me, row);
  let c = takeFlash(req);
  c += '<table class="grid" style="margin-bottom: 1em"><tbody>' +
    `<tr><th scope="row">Key id</th><td><code>${escape(row.key_id)}</code>${row.claimed ? ' (claimed by the uploader)' : ' (made from the key)'}</td></tr>` +
    `<tr><th scope="row">Fingerprint</th><td><code>${escape(row.fingerprint)}</code></td></tr>` +
    `<tr><th scope="row">Type</th><td>${escape(KEY_TYPES[row.kty].label)}${row.kty === 'RSA' ? ` (${row.bits} bits)` : ''}; signs ${escape(ks.algOf(row))}</td></tr>` +
    `<tr><th scope="row">Owner</th><td>${origin(ks, row)}, ${escape(when(row.created))}. ` +
    `${row.origin === 'created' ? (row.has_private ? 'The server holds the private key.' : 'The server no longer holds the private key.') : 'The server does not have the private key.'}</td></tr>` +
    `<tr><th scope="row">Status</th><td>${escape(statusText(row))}${row.status_changed ? `, ${escape(when(row.status_changed))}` : ''}${row.reason ? `: ${escape(row.reason)}` : ''}</td></tr>` +
    (row.label ? `<tr><th scope="row">Label</th><td>${escape(row.label)}</td></tr>` : '') +
    `<tr><th scope="row">Uploaded as</th><td>${escape({ pem: 'PEM', jwk: 'JWK', ssh: 'OpenSSH public key', x509: 'X.509 certificate', der: 'DER', created: '(made here)' }[row.source_format] || row.source_format)}</td></tr>` +
    '</tbody></table>';
  c += '<p class="text-muted"><small>The server says only who uploaded or created this key. ' +
    (row.source_format === 'x509' ? 'Nothing in the certificate has been checked: not its subject, issuer, dates or chain. ' : '') + '</small></p>';
  c += `<h4>Public key</h4><p><a href="?format=pem">PEM</a> · <a href="?format=json">JWK</a></p><pre>${escape(ks.pem(row))}</pre>`;
  c += `<pre>${escape(JSON.stringify(ks.jwk(row), null, 2))}</pre>`;
  if (row.source_format === 'x509') {
    c += `<h4>Certificate, as uploaded</h4><pre>${escape(row.source)}</pre>`;
  }
  const history = ks.events(row).filter(e => EVENT_WORDS[e.kind]);
  if (history.length) {
    c += '<h4>History</h4><ul>' + history.map(e => `<li>${escape(when(e.at))}: ${escape(EVENT_WORDS[e.kind])}${e.kind === 'rename' && e.detail ? ` (${escape(e.detail)})` : ''}</li>`).join('') + '</ul>';
  }
  if (manage) {
    const signs = ks.events(row, 100000).filter(e => e.kind === 'sign' || e.kind === 'load').length;
    if (row.origin === 'created') {
      c += `<p>Used to sign ${signs} time${signs === 1 ? '' : 's'}.</p>`;
    }
    c += '<h4>Manage</h4>' +
      `<form method="post" action="/keys/manage/${row.id}/label" style="display: flex; gap: 0.5em; align-items: flex-end; flex-wrap: wrap; max-width: 560px">${csrfField(res)}` +
      `<input type="hidden" name="back" value="${escape(keyUrl(row))}"/>` +
      '<div style="flex: 1 1 12em"><label for="k-label" class="visually-hidden">Label</label>' +
      `<input type="text" id="k-label" name="label" class="form-control" value="${escape(row.label)}" maxlength="100" placeholder="Label"/></div>` +
      '<div><button type="submit" class="btn btn-secondary">Save label</button></div></form>';
    if (row.status !== 'revoked') {
      c += revokeForm(res, row, keyUrl(row));
    }
  }
  page(req, res, `Key ${row.key_id.length > 40 ? row.key_id.substring(0, 40) + '...' : row.key_id}`, c);
}

function auth(ks) {
  return ks.auth;
}

function sendMine(ks, req, res, page) {
  const p = req.user;
  const rows = ks.list({ owner: p.id });
  let c = takeFlash(req);
  c += '<p>Your keys are listed publicly, with your name, as <i>uploaded by</i> or <i>created by</i> you. ' +
    'The server can sign for you only with the key pairs it made for you and still holds the private key of (<i>Can sign</i>); ' +
    'a key you uploaded is a public key only, for others to check your signatures with. ' +
    `<a href="${HELP_URL}">More</a></p>`;
  c += keyTable(ks, rows, { caption: 'Your keys', actions: row => (row.status !== 'revoked' ? revokeForm(res, row, '/keys/mine') : '') });

  // make a key pair
  const active = new Map(rows.filter(r => r.origin === 'created' && r.status === 'active').map(r => [r.kty, r]));
  c += '<h4 style="margin-top: 1.5em">Have the server make a key pair</h4>' +
    '<p>The server keeps the private key, and signs with it when you ask it to (the modules say when). ' +
    'It never gives the private key out. You can have one of each type: a new one replaces the last, ' +
    'whose private key is destroyed (its public key stays listed, retired).</p>' +
    `<form method="post" action="/keys/mine/create" style="display: flex; gap: 0.5em; align-items: flex-end; flex-wrap: wrap; max-width: 640px">${csrfField(res)}` +
    '<div style="flex: 1 1 12em"><label for="c-kty" class="form-label">Type</label><select id="c-kty" name="kty" class="form-select">' +
    Object.entries(KEY_TYPES).map(([k, t]) => {
      const why = ks.createProblem(p, k);
      return `<option value="${escape(k)}"${why ? ' disabled' : ''}>${escape(t.label)}${active.has(k) ? ' (replaces your current one)' : ''}${why ? ' - not until tomorrow' : ''}</option>`;
    }).join('') + '</select></div>' +
    '<div style="flex: 1 1 12em"><label for="c-label" class="form-label">Label (optional)</label><input type="text" id="c-label" name="label" class="form-control" maxlength="100"/></div>' +
    '<div><button type="submit" class="btn btn-primary">Make key pair</button></div></form>';

  // upload a public key
  const left = ks.uploadsLeft(p);
  c += '<h4 style="margin-top: 1.5em">Upload a public key</h4>' +
    '<p>A PEM public key or certificate, a JWK or JWKS, an OpenSSH public key line, or base64 DER: paste it, or choose a file. ' +
    'Only public keys: anything with a private key in it is refused. A key can be in the store only once. ' +
    `${Number.isFinite(left) ? `You can upload ${left} more key${left === 1 ? '' : 's'} now.` : ''}</p>` +
    `<form method="post" action="/keys/mine/upload" style="max-width: 760px">${csrfField(res)}` +
    '<div class="mb-3"><label for="u-file" class="form-label">File</label><input type="file" id="u-file" class="form-control"/>' +
    '<div class="form-text">Read in your browser into the box below; nothing is sent until you upload.</div></div>' +
    '<div class="mb-3"><label for="u-key" class="form-label">Key</label>' +
    '<textarea id="u-key" name="key" class="form-control" rows="8" spellcheck="false" style="font-family: monospace" required></textarea></div>' +
    '<div class="mb-3"><label for="u-kid" class="form-label">Key id (optional)</label><input type="text" id="u-kid" name="kid" class="form-control" maxlength="200"/>' +
    '<div class="form-text">The <code>kid</code> your signatures carry, if they carry one. Without one, a JWK\'s own kid is used, or the store makes one from the key (SHA256:...).</div></div>' +
    '<div class="mb-3"><label for="u-label" class="form-label">Label (optional)</label><input type="text" id="u-label" name="label" class="form-control" maxlength="100"/></div>' +
    '<button type="submit" class="btn btn-primary">Upload</button></form>' +
    // a chosen file goes into the box: as text, or (DER) as base64
    `<script>(function(){var f=document.getElementById('u-file');if(!f)return;f.addEventListener('change',function(){var file=f.files&&f.files[0];if(!file)return;` +
    `if(file.size>${MAX_UPLOAD_BYTES}){alert('That file is too big to be a key');return;}var r=new FileReader();r.onload=function(){var b=new Uint8Array(r.result);var t='';` +
    'var text=true;for(var i=0;i<b.length;i++){if(b[i]<9||(b[i]>13&&b[i]<32)){text=false;break;}}' +
    'if(text){t=new TextDecoder().decode(b);}else{var s="";for(var j=0;j<b.length;j++){s+=String.fromCharCode(b[j]);}t=btoa(s);}' +
    'document.getElementById(\'u-key\').value=t;};r.readAsArrayBuffer(file);});})();</script>';
  page(req, res, 'Your keys', c);
}

function sendAdmin(ks, req, res, page) {
  const rows = ks.list();
  let c = takeFlash(req);
  const system = rows.filter(r => r.owner === SYSTEM);
  c += '<h4>System keys</h4><p>The server\'s own key pairs: one active of each type. A new one replaces the last (its private key is destroyed).</p>';
  c += keyTable(ks, system, { actions: row => adminActions(res, row) });
  c += `<form method="post" action="/keys/admin/create" style="display: flex; gap: 0.5em; align-items: flex-end; flex-wrap: wrap; max-width: 640px; margin-top: 0.5em">${csrfField(res)}` +
    '<div style="flex: 1 1 12em"><label for="a-kty" class="form-label">Type</label><select id="a-kty" name="kty" class="form-select">' +
    Object.entries(KEY_TYPES).map(([k, t]) => `<option value="${escape(k)}">${escape(t.label)}${system.some(r => r.kty === k && r.status === 'active' && r.origin === 'created') ? ' (replaces the current one)' : ''}</option>`).join('') +
    '</select></div><div style="flex: 1 1 12em"><label for="a-label" class="form-label">Label (optional)</label><input type="text" id="a-label" name="label" class="form-control" maxlength="100"/></div>' +
    '<div><button type="submit" class="btn btn-primary" onclick="return confirm(\'Make a new system key pair?\')">Make system key pair</button></div></form>';
  const others = rows.filter(r => r.owner !== SYSTEM);
  c += '<h4 style="margin-top: 1.5em">Users\' keys</h4>' +
    '<p>Revoking keeps a key listed, revoked; deleting removes it altogether, and signatures made with it can\'t be checked here any more. ' +
    'Changing a key id (two people claiming the same one): empty gives the key its own fingerprint.</p>';
  c += keyTable(ks, others, { actions: row => adminActions(res, row) });
  page(req, res, 'Keys: administration', c);
}

function adminActions(res, row) {
  return (row.status !== 'revoked' ? revokeForm(res, row, '/keys/admin') : '') +
    `<details><summary class="btn btn-sm btn-outline-secondary">Key id</summary><form method="post" action="/keys/admin/${row.id}/kid" style="display: flex; gap: 0.5em; align-items: flex-end; flex-wrap: wrap; max-width: 420px; margin-top: 0.5em">${csrfField(res)}` +
    `<div style="flex: 1 1 12em"><label for="a-kid-${row.id}" class="visually-hidden">New key id</label>` +
    `<input type="text" id="a-kid-${row.id}" name="kid" class="form-control" value="${escape(row.key_id)}" maxlength="200"/></div>` +
    '<div><button type="submit" class="btn btn-sm btn-secondary">Change</button></div></form></details>' +
    postButton(res, `/keys/admin/${row.id}/delete`, 'Delete', 'btn-outline-danger', `Delete the key ${row.key_id} altogether? Signatures made with it can't be checked here any more`);
}

module.exports = { buildRouter };
