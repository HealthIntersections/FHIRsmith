//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The web interface over an endpoint's API: a browser (Accept: text/html, or _format=html)
 * that GETs an endpoint's URLs gets pages instead of JSON. The same URLs, the same access
 * checks, and the same interactions underneath: the pages are a view of what the API returns.
 *
 *   [base]                 the endpoint: what it is, the resource types with how many of each,
 *                          and the CapabilityStatement
 *   [base]/metadata        the CapabilityStatement
 *   [base]/[type]          the type: how many there are, and a search form built from its
 *                          search parameters
 *   [base]/[type]?...      search results (and history: [base]/_history, ...)
 *   [base]/[type]/[id]     a resource: what identifies it, its narrative, and its JSON
 *
 * Writes stay JSON: there are no forms that change anything. The CapabilityStatement is drawn
 * by the tx module's renderer, which needs the translations: they are loaded on the first page.
 *
 * @module rest/web
 */

const path = require('path');
const escape = require('escape-html');
const parse5 = require('parse5');
const htmlServer = require('../library/html-server');
const { checkResourceNarratives } = require('../library/narrative-check');

const TEMPLATE = 'rest';
const TEMPLATE_PATH = path.join(__dirname, 'html', 'rest-template.html');

// what a search parameter's value looks like, by type, for the form's placeholders
const HINTS = {
  string: 'starts with (:exact, :contains)',
  token: 'code, or system|code',
  date: 'e.g. 2020-01-01, ge2020, lt2021-06',
  number: 'e.g. 5, gt5.0',
  quantity: 'value|system|code, e.g. gt5.4|http://unitsofmeasure.org|mmol/L',
  reference: 'Type/id, or a URL',
  uri: 'a URI (:below, :above)',
  composite: 'values separated by $'
};

const COMMON = [
  { code: '_id', type: 'token', description: 'The resource\'s id' },
  { code: '_lastUpdated', type: 'date', description: 'When the resource was last changed' },
  { code: '_tag', type: 'token', description: 'A tag in the resource\'s meta' },
  { code: '_profile', type: 'uri', description: 'A profile the resource says it conforms to' },
  { code: '_security', type: 'token', description: 'A security label in the resource\'s meta' }
];

// the parameters that control a search rather than choose what it finds
const CONTROL = new Set(['_format', '_pretty', '_count', '_sort', '_summary', '_elements', '_total', '_include', '_revinclude']);

let i18nPromise = null;

/** The translations the tx module's renderer needs: loaded once, on the first page that needs them */
function translations() {
  if (!i18nPromise) {
    i18nPromise = (async () => {
      const { LanguageDefinitions } = require('../library/languages');
      const { I18nSupport } = require('../library/i18nsupport');
      const languages = await LanguageDefinitions.fromFiles(path.join(__dirname, '..', 'tx', 'data'));
      const i18n = new I18nSupport(path.join(__dirname, '..', 'translations'), languages);
      await i18n.load();
      return i18n;
    })();
    i18nPromise.catch(() => {
      i18nPromise = null;
    });
  }
  return i18nPromise;
}

/**
 * Whether a request is for a page: a GET (or HEAD) that asks for HTML, by _format or Accept.
 * @param {Object} req
 */
function wantsHtml(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }
  const f = typeof req.query._format === 'string' ? req.query._format.trim().toLowerCase() : '';
  if (f) {
    return f === 'html' || f === 'text/html';
  }
  const accept = String(req.get('Accept') || '').toLowerCase();
  // a browser asks for text/html first; an API client that also takes */* isn't a browser
  return accept.split(',').map(s => s.split(';')[0].trim()).includes('text/html');
}

/** The part of a parameter's description for one type (the core shares parameters across types) */
function describeFor(description, type) {
  if (!description) {
    return '';
  }
  const m = new RegExp(`\\* \\[${type}\\]\\([^)]*\\): ([^\\n]*)`).exec(description);
  if (m) {
    return m[1].trim();
  }
  if (/^Multiple Resources/.test(description)) {
    return '';
  }
  return description.split('\n')[0].trim();
}

function fmtDate(ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

/** A short text for a resource: its name, title or text, where it has one */
function displayOf(r) {
  if (!r || typeof r !== 'object') {
    return '';
  }
  if (typeof r.title === 'string') {
    return r.title;
  }
  if (typeof r.name === 'string') {
    return r.name;
  }
  if (Array.isArray(r.name) && r.name[0]) {
    const n = r.name[0];
    if (n.text) {
      return n.text;
    }
    if (n.family || n.given) {
      return [...(n.given || []), n.family].filter(x => x).join(' ');
    }
  }
  for (const k of ['code', 'type', 'category']) {
    const v = Array.isArray(r[k]) ? r[k][0] : r[k];
    if (v && typeof v === 'object') {
      if (v.text) {
        return v.text;
      }
      const c = (v.coding || [])[0];
      if (c && (c.display || c.code)) {
        return c.display || c.code;
      }
    }
  }
  if (typeof r.description === 'string') {
    return r.description.substring(0, 100);
  }
  return '';
}

class RestWeb {
  /**
   * @param {Object} ep - the Endpoint
   */
  constructor(ep) {
    this.ep = ep;
    if (!htmlServer.hasTemplate(TEMPLATE)) {
      htmlServer.loadTemplate(TEMPLATE, TEMPLATE_PATH);
    }
  }

  base(req) {
    return req.baseUrl;
  }

  send(req, res, status, title, content, start) {
    const html = htmlServer.renderPage(TEMPLATE, title, content, {
      endpointpath: req.baseUrl,
      fhirversion: this.ep.settings.fhirVersion,
      processingTime: Date.now() - start,
      templateVars: { 'endpoint-name': this.ep.settings.name || 'Endpoint' }
    });
    res.status(status).set('Content-Type', 'text/html; charset=utf-8');
    if (req.method === 'HEAD') {
      res.end();
    } else {
      res.send(html);
    }
  }

  /**
   * A page for a request (already parsed and allowed): the endpoint, a type, or what the
   * interaction returned.
   * @param {Object} req
   * @param {Object} res
   * @param {Object} freq - from request.js
   * @param {Object} access - from access.js
   * @param {number} start
   */
  async page(req, res, freq, access, start) {
    // a page for the endpoint or a type when nothing is asked of it; any parameter is a search
    const asked = freq.params.filter(([n]) => n !== '_format' && n !== '_pretty').length > 0;
    if (freq.interaction === 'search-system' && !freq.compartment && !asked) {
      return this.home(req, res, freq, start);
    }
    if (freq.interaction === 'capabilities') {
      const r = await this.ep.dispatch(freq, { access });
      return this.send(req, res, 200, 'Capability Statement', await this.capabilityStatement(r.resource), start);
    }
    if (freq.interaction === 'search-type' && !freq.compartment && !asked && !freq.segments.includes('_search')) {
      return this.typeHome(req, res, freq, start);
    }
    const r = await this.ep.dispatch(freq, { access });
    if (r.status === 304) {
      res.status(304).end();
      return;
    }
    const resource = r.resource;
    if (!resource) {
      return this.send(req, res, r.status, 'Done', this.outcome(r.outcome ? { issue: [r.outcome] } : { issue: [] }), start);
    }
    if (resource.resourceType === 'Bundle') {
      const title = freq.interaction.startsWith('history') ? `History${freq.type ? ': ' + freq.type : ''}${freq.id ? '/' + freq.id : ''}`
        : `Search${freq.type ? ': ' + freq.type : ''}`;
      return this.send(req, res, r.status, title, await this.bundle(req, freq, resource), start);
    }
    if (resource.resourceType === 'OperationOutcome') {
      return this.send(req, res, r.status, 'Outcome', this.outcome(resource), start);
    }
    if (resource.resourceType === 'Parameters') {
      return this.send(req, res, r.status, `$${freq.operation || 'operation'}`, this.json(resource, true), start);
    }
    const title = `${resource.resourceType}/${resource.id}${freq.vid ? ' (version ' + freq.vid + ')' : ''}`;
    return this.send(req, res, r.status, title, await this.resource(req, resource), start);
  }

  /** An error as a page; 401 with a link to log in */
  error(req, res, fe, start) {
    let content = this.outcome(fe.outcome());
    if (fe.status === 401) {
      let login = '/auth/login';
      try {
        login = require('../library/auth').loginUrl(req);
      } catch (e) {
        // no logins on this server
      }
      content += `<p><a class="btn btn-primary" href="${escape(login)}">Log in</a></p>`;
    }
    for (const [k, v] of Object.entries(fe.headers || {})) {
      res.set(k, v);
    }
    this.send(req, res, fe.status, fe.status === 404 ? 'Not found' : fe.status === 410 ? 'Deleted' : 'Error', content, start);
  }

  // ---- the endpoint ----

  async counts() {
    const rows = await this.ep.db.read(q => q.all('SELECT TypeKey, COUNT(*) AS N FROM Ids WHERE Deleted = 0 AND MostRecent IS NOT NULL GROUP BY TypeKey'));
    const byKey = new Map(rows.map(r => [Number(r.TypeKey), Number(r.N)]));
    const out = new Map();
    for (const [type, key] of this.ep.typeKeys) {
      out.set(type, byKey.get(key) || 0);
    }
    return out;
  }

  async home(req, res, freq, start) {
    const ep = this.ep;
    const s = ep.settings;
    const base = this.base(req);
    const counts = await this.counts();
    const types = [...ep.typeKeys.keys()].filter(t => ep.typeSupported(t)).sort();
    const total = types.reduce((n, t) => n + counts.get(t), 0);
    let html = '';
    if (s.description) {
      html += `<p>${escape(s.description)}</p>`;
    }
    html += '<table class="grid">';
    const row = (k, v) => `<tr><td><b>${escape(k)}</b></td><td>${v}</td></tr>`;
    html += row('Address', `<code>${escape(freq.base)}</code>`);
    html += row('FHIR version', escape(s.fhirVersion));
    if (s.packages && s.packages.length) {
      html += row('Packages', escape(s.packages.join(', ')));
    }
    html += row('Resources', `${total.toLocaleString()} (current versions, of ${types.length} types)`);
    html += row('Access', s.anonymous === 'write' ? 'anyone can read and write' : s.anonymous === 'read' ? 'anyone can read; writing needs a login' : 'a login or an API token');
    html += row('Server-assigned ids', s.idStrategy === 'uuid' ? 'UUIDs' : 'numbers');
    html += row('Create by PUT', s.createOnUpdate ? 'yes' : 'no');
    html += row('Reference checks', s.checkReferences ? 'on' : 'off');
    if (s.txServer) {
      html += row('Terminology server', escape(s.txServer));
    }
    html += '</table>';

    html += '<h3>Resource types</h3>';
    const used = types.filter(t => counts.get(t) > 0);
    const empty = types.filter(t => counts.get(t) === 0);
    if (used.length) {
      html += '<table class="table table-sm grid" style="width: auto"><thead><tr><th>Type</th><th style="text-align: right">Resources</th><th></th></tr></thead><tbody>';
      for (const t of used) {
        const u = `${base}/${encodeURIComponent(t)}`;
        html += `<tr><td><a href="${escape(u)}">${escape(t)}</a></td><td style="text-align: right">${counts.get(t).toLocaleString()}</td>` +
          `<td><a href="${escape(u)}?_sort=-_lastUpdated">latest</a></td></tr>`;
      }
      html += '</tbody></table>';
    } else {
      html += '<p>There are no resources yet.</p>';
    }
    if (empty.length) {
      html += `<p>${used.length ? 'Also supported, with none yet' : 'Supported'}: ` +
        empty.map(t => `<a href="${escape(base + '/' + encodeURIComponent(t))}">${escape(t)}</a>`).join(', ') + '</p>';
    }

    html += '<h3>Capability Statement</h3>';
    const cs = await ep.dispatch({ ...freq, interaction: 'capabilities' }, {});
    html += await this.capabilityStatement(cs.resource);
    return this.send(req, res, 200, s.name || 'FHIR server', html, start);
  }

  async capabilityStatement(cs) {
    try {
      const { Renderer } = require('../tx/library/renderer');
      const { OperationContext } = require('../tx/operation-context');
      const i18n = await translations();
      const html = await new Renderer(new OperationContext('en', i18n)).renderCapabilityStatement(cs);
      return `<div class="narrative">${html}</div>` + this.json(cs, false);
    } catch (e) {
      this.ep.log.warn(`Rest ${this.ep.path}: the CapabilityStatement couldn't be drawn: ${e.message}`);
      return this.json(cs, true);
    }
  }

  // ---- a type ----

  /** The search parameters a type's form offers: the common ones, then its own by name */
  formParams(type) {
    const own = [...this.ep.definitions.forType(type).values()]
      .filter(d => d.key !== null && d.key !== undefined)
      .map(d => ({ code: d.code, type: d.type, description: describeFor(d.description, type) }))
      .sort((a, b) => a.code.localeCompare(b.code));
    return [...COMMON, ...own];
  }

  async typeHome(req, res, freq, start) {
    const ep = this.ep;
    const type = freq.type;
    ep.checkType(type, 'search-type');
    const base = this.base(req);
    const n = (await this.counts()).get(type) || 0;
    const action = `${base}/${encodeURIComponent(type)}`;
    let html = `<p>${n.toLocaleString()} ${escape(type)} resource${n === 1 ? '' : 's'}. ` +
      `<a href="${escape(action)}?_sort=-_lastUpdated">The latest</a> &nbsp;|&nbsp; ` +
      `<a href="${escape(action)}/_history">History</a></p>`;
    const params = this.formParams(type);
    html += `<form method="get" action="${escape(action)}">`;
    html += '<table class="grid"><thead><tr><th>Parameter</th><th>Value</th><th>Description</th></tr></thead><tbody>';
    for (const p of params) {
      const id = 'sp_' + p.code.replace(/[^A-Za-z0-9_-]/g, '_');
      html += `<tr><td><label for="${escape(id)}"><code>${escape(p.code)}</code></label><br/><small>${escape(p.type)}</small></td>` +
        `<td><input type="text" id="${escape(id)}" name="${escape(p.code)}" size="40" placeholder="${escape(HINTS[p.type] || '')}"/></td>` +
        `<td><small>${escape(p.description || '')}</small></td></tr>`;
    }
    html += '</tbody></table>';
    const sortable = params.filter(p => p.type !== 'composite');
    html += '<p style="margin-top: 10px">';
    html += '<label for="_sort">Sort by</label> <select id="_sort" name="_sort"><option value="">(none)</option>';
    for (const p of sortable) {
      html += `<option value="${escape(p.code)}">${escape(p.code)}</option><option value="-${escape(p.code)}">${escape(p.code)} (descending)</option>`;
    }
    html += '</select> &nbsp; ';
    html += `<label for="_count">Page size</label> <input type="number" id="_count" name="_count" min="1" max="${ep.settings.maxCount}" value="${ep.settings.defaultCount}" style="width: 6em"/> &nbsp; `;
    html += '<label for="_summary">Summary</label> <select id="_summary" name="_summary"><option value="">(full)</option><option>true</option><option>data</option><option>text</option><option>count</option></select>';
    html += '</p>';
    html += '<p><button type="submit" class="btn btn-primary">Search</button> ' +
      '<small>Empty fields are left out. Repeat a parameter in the URL to AND values; separate values with commas to OR them.</small></p>';
    html += '</form>';
    // empty fields would otherwise each send name=
    html += `<script>document.currentScript.previousElementSibling.addEventListener('submit', function (e) {
  for (const el of this.querySelectorAll('input, select')) { if (!el.value) { el.disabled = true; } }
});</script>`;
    return this.send(req, res, 200, type, html, start);
  }

  // ---- what the API returned ----

  pager(bundle) {
    const links = bundle.link || [];
    const order = ['first', 'previous', 'next', 'last'];
    const items = order.map(rel => links.find(l => l.relation === rel)).filter(l => l);
    if (!items.length) {
      return '';
    }
    const rel = (u) => u.replace(/^https?:\/\/[^/]+/, '');
    return '<nav><ul class="pagination">' + items.map(l =>
      `<li class="page-item"><a class="page-link" href="${escape(rel(l.url))}">${escape(l.relation.charAt(0).toUpperCase() + l.relation.slice(1))}</a></li>`).join('') + '</ul></nav>';
  }

  async bundle(req, freq, bundle) {
    const base = this.base(req);
    const entries = bundle.entry || [];
    const matches = entries.filter(e => e.resource && (!e.search || e.search.mode !== 'outcome'));
    const outcomes = entries.filter(e => e.search && e.search.mode === 'outcome');
    let html = '';
    for (const o of outcomes) {
      html += this.outcome(o.resource);
    }
    const criteria = freq.params.filter(([n]) => !CONTROL.has(n) && n !== '_getpages' && n !== '_offset');
    if (criteria.length) {
      html += '<p>Where ' + criteria.map(([n, v]) => `<code>${escape(n)}</code> = <code>${escape(v)}</code>`).join(' and ') + '</p>';
    }
    if (typeof bundle.total === 'number') {
      html += `<p>${bundle.total.toLocaleString()} found${matches.length < bundle.total ? `, ${matches.length} on this page` : ''}.</p>`;
    } else if (bundle.type === 'searchset') {
      html += `<p>${matches.length} on this page.</p>`;
    }
    if (freq.type && freq.interaction === 'search-type' && !freq.compartment) {
      html += `<p><a href="${escape(base + '/' + encodeURIComponent(freq.type))}">New search</a></p>`;
    }
    html += this.pager(bundle);
    if (matches.length) {
      html += '<table class="table table-sm grid"><thead><tr><th>Resource</th><th>Summary</th><th>Version</th><th>Updated</th><th></th></tr></thead><tbody>';
      for (const e of entries) {
        if (e.search && e.search.mode === 'outcome') {
          continue;
        }
        const r = e.resource;
        const req2 = e.request;
        if (!r) {
          // a deletion, in history
          const what = req2 ? req2.url : '';
          html += `<tr><td>${escape(what)}</td><td><i>deleted</i></td><td>${escape((e.response && e.response.etag || '').replace(/^W\/"|"$/g, ''))}</td>` +
            `<td>${escape(e.response && e.response.lastModified ? e.response.lastModified : '')}</td><td></td></tr>`;
          continue;
        }
        const link = `${base}/${encodeURIComponent(r.resourceType)}/${encodeURIComponent(r.id)}`;
        const vid = r.meta && r.meta.versionId;
        const vlink = vid ? `${link}/_history/${encodeURIComponent(vid)}` : link;
        const mode = e.search && e.search.mode === 'include' ? ' <span class="badge bg-secondary">included</span>' : '';
        const op = req2 ? ` <small>(${escape(req2.method === 'POST' ? 'created' : req2.method === 'PUT' ? 'updated' : req2.method)})</small>` : '';
        html += `<tr><td><a href="${escape(bundle.type === 'history' ? vlink : link)}">${escape(r.resourceType)}/${escape(r.id)}</a>${mode}</td>` +
          `<td>${escape(displayOf(r))}</td><td>${escape(vid || '')}${op}</td>` +
          `<td>${escape(r.meta && r.meta.lastUpdated ? r.meta.lastUpdated.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '')}</td>` +
          `<td><a href="${escape(link)}?_format=json">JSON</a></td></tr>`;
      }
      html += '</tbody></table>';
    }
    html += this.pager(bundle);
    return html;
  }

  /** The things that identify a resource, as table rows */
  identity(req, r) {
    const base = this.base(req);
    const rows = [];
    const add = (k, v) => {
      if (v) {
        rows.push(`<tr><td><b>${escape(k)}</b></td><td>${v}</td></tr>`);
      }
    };
    const link = `${base}/${encodeURIComponent(r.resourceType)}/${encodeURIComponent(r.id)}`;
    add('Id', `${escape(r.id)}`);
    if (r.meta) {
      add('Version', r.meta.versionId ? `${escape(r.meta.versionId)} (<a href="${escape(link)}/_history">history</a>)` : null);
      add('Updated', r.meta.lastUpdated ? escape(fmtDate(Date.parse(r.meta.lastUpdated))) : null);
      add('Profiles', (r.meta.profile || []).map(p => `<code>${escape(p)}</code>`).join('<br/>'));
      add('Tags', (r.meta.tag || []).map(t => escape(`${t.system ? t.system + '|' : ''}${t.code}${t.display ? ' (' + t.display + ')' : ''}`)).join('<br/>'));
      add('Security', (r.meta.security || []).map(t => escape(`${t.system ? t.system + '|' : ''}${t.code}`)).join('<br/>'));
    }
    if (typeof r.url === 'string') {
      add('URL', `<code>${escape(r.url)}</code>${r.version ? ' version ' + escape(r.version) : ''}`);
    }
    const ids = Array.isArray(r.identifier) ? r.identifier : r.identifier ? [r.identifier] : [];
    add('Identifiers', ids.filter(i => i && i.value).map(i => escape(`${i.system ? i.system + '|' : ''}${i.value}`)).join('<br/>'));
    add('Name', escape(displayOf(r)));
    if (typeof r.status === 'string') {
      add('Status', escape(r.status));
    }
    for (const k of ['subject', 'patient', 'encounter']) {
      const ref = r[k];
      if (ref && typeof ref.reference === 'string') {
        const p = /^([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})$/.exec(ref.reference);
        add(k.charAt(0).toUpperCase() + k.slice(1), p ? `<a href="${escape(base + '/' + p[1] + '/' + p[2])}">${escape(ref.display || ref.reference)}</a>` : escape(ref.display || ref.reference));
      }
    }
    return `<table class="grid">${rows.join('')}</table>`;
  }

  async resource(req, r) {
    let html = this.identity(req, r);
    html += '<h3>Narrative</h3>';
    html += this.narrative(r);
    html += this.json(r, false);
    return html;
  }

  /** The resource's narrative, made safe: none if it carries active content */
  narrative(r) {
    const found = checkResourceNarratives({ resourceType: r.resourceType, id: r.id, text: r.text });
    if (found) {
      return `<div class="alert alert-danger">This narrative is not shown: ${escape(found)}</div>`;
    }
    const div = r.text && r.text.div;
    if (typeof div !== 'string' || !div) {
      return '<p><i>The resource has no narrative.</i></p>';
    }
    // the parsed tree written out again, never the string as it is: an unterminated tag
    // would otherwise swallow the rest of the page
    return `<div class="narrative">${parse5.serialize(parse5.parseFragment(div))}</div>`;
  }

  json(resource, open) {
    const id = 'json_' + Math.random().toString(36).substring(2, 10);
    return `<div style="margin-top: 10px"><button type="button" class="btn btn-sm btn-secondary" onclick="toggleJsonSource('${id}')">${open ? 'Hide JSON' : 'Show JSON'}</button>` +
      `<div id="${id}" style="display: ${open ? 'block' : 'none'}"><pre>${escape(JSON.stringify(resource, null, 2))}</pre></div></div>`;
  }

  outcome(oo) {
    const cls = { fatal: 'alert-danger', error: 'alert-danger', warning: 'alert-warning', information: 'alert-info' };
    return (oo.issue || []).map(i => `<div class="alert ${cls[i.severity] || 'alert-info'}">` +
      `${escape((i.details && i.details.text) || i.diagnostics || i.code)}</div>`).join('');
  }
}

module.exports = { RestWeb, wantsHtml, describeFor, displayOf };
