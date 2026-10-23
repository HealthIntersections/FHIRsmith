// registry/documents.js
// Documents the registry stores and serves: enterprise configuration and policy, as
// markdown or JSON. Each has a name, a type, whether it is public, and when (and by whom)
// it was last edited; every change is logged with the content as it was.
//
//   public documents     anyone can read
//   other documents      anyone logged in (a browser session - never an API token)
//   editing, deleting    administrators (the configured one, or a user flagged admin)
//
// Markdown is rendered as the author wrote it, raw HTML included: the authors are the
// registry's administrators, and they are trusted. Editing is a textarea.
//
// Routes (added to the registry's router by RegistryAuth, since they need its session):
//   GET  /docs                     the list
//   GET  /docs/new, POST /docs     create
//   GET  /docs/{name}              the document: rendered for a browser, raw otherwise
//   GET  /docs/{name}/edit, POST   edit (name, type, public, content)
//   POST /docs/{name}/delete
//   GET  /docs/{name}/history      the log; /history/{entry} shows a past version

const escape = require('escape-html');
const commonmark = require('commonmark');

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const RESERVED = new Set(['new']);
const TYPES = { md: 'text/markdown; charset=utf-8', json: 'application/json; charset=utf-8' };
const MAX_SIZE = 2 * 1024 * 1024;

function str(v) {
  return typeof v === 'string' ? v : '';
}

/** Render markdown to HTML, trusting it (raw HTML passes through) */
function renderMarkdown(md) {
  const parsed = new commonmark.Parser().parse(md);
  return new commonmark.HtmlRenderer({ safe: false }).render(parsed);
}

/** The JSON pretty-printed, or null if it doesn't parse */
function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

class RegistryDocuments {
  /**
   * @param {RegistryAuth} auth the session, csrf and store live there
   * @param {object} logger
   */
  constructor(auth, logger) {
    this.auth = auth;
    this.store = auth.store;
    this.log = logger || console;
  }

  setupRoutes(router) {
    const a = this.auth;
    const h = fn => (req, res) => Promise.resolve().then(() => fn(req, res)).catch(e => {
      this.log.error(`Registry documents: ${e.message}`);
      a.sendError(req, res, 500, e.message);
    });
    const admin = (req, res, next) => {
      const user = a.currentUser(req);
      if (!user) {
        return res.redirect(req.baseUrl + '/login');
      }
      if (!user.isAdmin) {
        return a.sendError(req, res, 403, 'Only an administrator can do that');
      }
      req.user = user;
      next();
    };
    // the session is read on every page, so that a logged in user sees the private
    // documents; CSRF only matters for the forms
    router.get('/docs', a.session, a.csrf, h((req, res) => this.sendList(req, res)));
    router.get('/docs/new', a.session, a.csrf, admin, h((req, res) => this.sendForm(req, res, null)));
    router.post('/docs', a.sameOrigin, a.session, a.form, a.csrf, admin, h((req, res) => this.save(req, res, null)));
    router.get('/docs/:name', a.session, a.csrf, h((req, res) => this.sendDocument(req, res)));
    router.get('/docs/:name/edit', a.session, a.csrf, admin, h((req, res) => this.sendForm(req, res, this.find(req))));
    router.post('/docs/:name', a.sameOrigin, a.session, a.form, a.csrf, admin, h((req, res) => this.save(req, res, this.find(req))));
    router.post('/docs/:name/delete', a.sameOrigin, a.session, a.form, a.csrf, admin, h((req, res) => this.delete(req, res)));
    router.get('/docs/:name/history', a.session, a.csrf, h((req, res) => this.sendHistory(req, res)));
    router.get('/docs/:name/history/:entry', a.session, a.csrf, h((req, res) => this.sendVersion(req, res)));
  }

  find(req) {
    const name = str(req.params.name);
    return NAME_RE.test(name) ? this.store.documentByName(name) : null;
  }

  /** May this request read the document? Public: anyone; else a logged in user */
  canRead(req, doc) {
    return doc.public || !!this.auth.currentUser(req);
  }

  wantsHtml(req) {
    return !!(req.headers.accept && req.headers.accept.includes('text/html'));
  }

  // ---- reading ----

  sendList(req, res) {
    const base = escape(req.baseUrl || '');
    const user = this.auth.currentUser(req);
    const docs = this.store.documents().filter(d => d.public || user);
    let h = '';
    if (user && user.isAdmin) {
      h += `<p style="float: right"><a class="btn btn-primary btn-sm" href="${base}/docs/new">New document</a></p>`;
    }
    h += '<p>Documents this registry publishes: configuration and policy for its ecosystem. ' +
      (user ? '' : 'Documents that are not public are shown to logged in users.') + '</p>';
    h += '<table class="grid"><thead><tr><th>Name</th><th>Type</th><th>Visibility</th><th>Last edited</th><th>By</th><th>Size</th></tr></thead><tbody>';
    for (const d of docs) {
      h += `<tr><td><a href="${base}/docs/${encodeURIComponent(d.name)}">${escape(d.name)}</a></td><td>${escape(d.type)}</td>` +
        `<td>${d.public ? 'public' : 'logged in users'}</td><td>${escape(d.updated_at.substring(0, 16).replace('T', ' '))}</td>` +
        `<td>${escape(d.updated_by)}</td><td>${d.size}</td></tr>`;
    }
    if (docs.length === 0) {
      h += '<tr><td colspan="6"><i>no documents</i></td></tr>';
    }
    h += '</tbody></table>';
    this.auth.renderPage(req, res, 'Documents', h, 200);
  }

  sendDocument(req, res) {
    const doc = this.find(req);
    if (!doc) {
      return this.notFound(req, res);
    }
    if (!this.canRead(req, doc)) {
      return this.denied(req, res);
    }
    if (!this.wantsHtml(req)) {
      res.setHeader('Content-Type', TYPES[doc.type] || 'text/plain; charset=utf-8');
      res.setHeader('Last-Modified', new Date(doc.updated_at).toUTCString());
      res.setHeader('Cache-Control', doc.public ? 'public, max-age=60' : 'private, no-store');
      return res.send(doc.content);
    }
    const base = escape(req.baseUrl || '');
    const user = this.auth.currentUser(req);
    let h = `<p class="text-muted"><small>${escape(doc.type === 'md' ? 'Markdown' : 'JSON')} &middot; ` +
      `${doc.public ? 'public' : 'logged in users'} &middot; last edited ${escape(doc.updated_at.substring(0, 16).replace('T', ' '))} by ${escape(doc.updated_by)} &middot; ` +
      `<a href="${base}/docs/${encodeURIComponent(doc.name)}/history">history</a>`;
    if (user && user.isAdmin) {
      h += ` &middot; <a href="${base}/docs/${encodeURIComponent(doc.name)}/edit">edit</a>`;
    }
    h += '</small></p>';
    h += this.renderContent(doc);
    this.auth.renderPage(req, res, doc.name, h, 200);
  }

  renderContent(doc) {
    if (doc.type === 'json') {
      const pretty = prettyJson(doc.content);
      return `<pre class="json">${escape(pretty === null ? doc.content : pretty)}</pre>`;
    }
    return `<div class="document">${renderMarkdown(doc.content)}</div>`;
  }

  sendHistory(req, res) {
    const doc = this.find(req);
    if (!doc) {
      return this.notFound(req, res);
    }
    if (!this.canRead(req, doc)) {
      return this.denied(req, res);
    }
    const base = escape(req.baseUrl || '');
    const url = `${base}/docs/${encodeURIComponent(doc.name)}`;
    let h = `<p><a href="${url}">&laquo; ${escape(doc.name)}</a></p>`;
    h += '<table class="grid"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Name</th><th>Type</th><th>Visibility</th><th>Size</th></tr></thead><tbody>';
    for (const e of this.store.documentLog(doc.id)) {
      h += `<tr><td><a href="${url}/history/${e.id}">${escape(e.at.substring(0, 19).replace('T', ' '))}</a></td><td>${escape(e.by)}</td>` +
        `<td>${escape(e.action)}</td><td>${escape(e.name)}</td><td>${escape(e.type)}</td><td>${e.public ? 'public' : 'logged in users'}</td><td>${e.size}</td></tr>`;
    }
    h += '</tbody></table>';
    this.auth.renderPage(req, res, `History of ${doc.name}`, h, 200);
  }

  sendVersion(req, res) {
    const doc = this.find(req);
    if (!doc) {
      return this.notFound(req, res);
    }
    if (!this.canRead(req, doc)) {
      return this.denied(req, res);
    }
    const entry = this.store.documentLogEntry(doc.id, Number(req.params.entry));
    if (!entry) {
      return this.notFound(req, res);
    }
    const base = escape(req.baseUrl || '');
    let h = `<p><a href="${base}/docs/${encodeURIComponent(doc.name)}/history">&laquo; history</a></p>`;
    h += `<div class="alert alert-info">The document as ${escape(entry.action)} at ${escape(entry.at.substring(0, 19).replace('T', ' '))} by ${escape(entry.by)}` +
      (entry.name !== doc.name ? `, then named <code>${escape(entry.name)}</code>` : '') + '.</div>';
    h += this.renderContent(entry);
    this.auth.renderPage(req, res, `${doc.name} at ${entry.at.substring(0, 16).replace('T', ' ')}`, h, 200);
  }

  notFound(req, res) {
    if (this.wantsHtml(req)) {
      return this.auth.sendError(req, res, 404, 'No such document');
    }
    res.status(404).json({ error: 'not-found', message: 'No such document' });
  }

  // a document that exists but is not public looks the same as one that doesn't, to a
  // stranger: a browser is sent to log in, anything else gets 404
  denied(req, res) {
    if (this.wantsHtml(req)) {
      return res.redirect(`${req.baseUrl || ''}/login`);
    }
    res.status(404).json({ error: 'not-found', message: 'No such document' });
  }

  // ---- editing ----

  sendForm(req, res, doc, values, error) {
    if (req.params.name && !doc) {
      return this.notFound(req, res);
    }
    const base = escape(req.baseUrl || '');
    const v = values || (doc ? { name: doc.name, type: doc.type, public: doc.public, content: doc.content } : { name: '', type: 'md', public: false, content: '' });
    const action = doc ? `${base}/docs/${encodeURIComponent(doc.name)}` : `${base}/docs`;
    let h = error ? `<div class="alert alert-danger">${escape(error)}</div>` : '';
    h += `<form method="post" action="${action}"><input type="hidden" name="_csrf" value="${escape(res.locals._csrf || '')}"/>` +
      '<div class="row g-3" style="max-width: 900px">' +
      `<div class="col-md-5"><label class="form-label" for="d-name">Name</label><input class="form-control" id="d-name" name="name" value="${escape(v.name)}" required maxlength="100" pattern="[A-Za-z0-9][A-Za-z0-9._-]*"/>` +
      '<div class="form-text">Letters, digits, dots, hyphens and underscores; it is the document\'s address</div></div>' +
      '<div class="col-md-3"><label class="form-label" for="d-type">Type</label><select class="form-select" id="d-type" name="type">' +
      `<option value="md"${v.type === 'md' ? ' selected' : ''}>Markdown</option><option value="json"${v.type === 'json' ? ' selected' : ''}>JSON</option></select></div>` +
      `<div class="col-md-4"><label class="form-label">&nbsp;</label><div><label><input type="checkbox" name="public" value="1"${v.public ? ' checked' : ''}/> Public (anyone can read it)</label></div></div>` +
      `<div class="col-12"><label class="form-label" for="d-content">Content</label><textarea class="form-control" id="d-content" name="content" rows="28" style="font-family: monospace" spellcheck="false">${escape(v.content)}</textarea></div>` +
      `<div class="col-12"><button type="submit" class="btn btn-primary">${doc ? 'Save' : 'Create'}</button> ` +
      `<a class="btn btn-secondary" href="${doc ? action : base + '/docs'}">Cancel</a></div></div></form>`;
    if (doc) {
      h += `<form method="post" action="${action}/delete" style="margin-top: 2em" onsubmit="return confirm('Delete this document?')">` +
        `<input type="hidden" name="_csrf" value="${escape(res.locals._csrf || '')}"/><button type="submit" class="btn btn-outline-danger btn-sm">Delete document</button></form>`;
    }
    this.auth.renderPage(req, res, doc ? `Edit ${doc.name}` : 'New document', h, error ? 400 : 200);
  }

  save(req, res, doc) {
    if (req.params.name && !doc) {
      return this.notFound(req, res);
    }
    const values = {
      name: str(req.body.name).trim(),
      type: str(req.body.type) === 'json' ? 'json' : 'md',
      public: req.body.public === '1',
      content: str(req.body.content).replace(/\r\n/g, '\n')
    };
    let error = null;
    if (!NAME_RE.test(values.name) || RESERVED.has(values.name.toLowerCase())) {
      error = 'The name must be 1-100 letters, digits, dots, hyphens or underscores, starting with a letter or digit';
    } else if (values.content.length > MAX_SIZE) {
      error = `The document is too large (${values.content.length} characters; the limit is ${MAX_SIZE})`;
    } else if (values.type === 'json' && prettyJson(values.content) === null) {
      error = 'The content is not valid JSON';
    } else {
      const existing = this.store.documentByName(values.name);
      if (existing && (!doc || existing.id !== doc.id)) {
        error = `There is already a document named '${values.name}'`;
      }
    }
    if (error) {
      return this.sendForm(req, res, doc, values, error);
    }
    if (doc) {
      this.store.updateDocument(doc.id, values, req.user.login);
      this.log.info(`Registry documents: '${values.name}' edited by ${req.user.login}`);
    } else {
      this.store.createDocument(values, req.user.login);
      this.log.info(`Registry documents: '${values.name}' created by ${req.user.login}`);
    }
    res.redirect(`${req.baseUrl || ''}/docs/${encodeURIComponent(values.name)}`);
  }

  delete(req, res) {
    const doc = this.find(req);
    if (!doc) {
      return this.notFound(req, res);
    }
    this.store.deleteDocument(doc.id, req.user.login);
    this.log.info(`Registry documents: '${doc.name}' deleted by ${req.user.login}`);
    res.redirect(`${req.baseUrl || ''}/docs`);
  }
}

module.exports = { RegistryDocuments, renderMarkdown, NAME_RE };
