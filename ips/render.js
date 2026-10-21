//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * HTML for the /ips module: the list of projects, a project's filterable list of
 * documents, the submission form, the views of a document, and the administration
 * pages (login, projects, users, a project's settings).
 *
 * Everything in a document came from a stranger, so every value goes through escape().
 * The one exception is the narrative view, which shows the document's own XHTML
 * (Composition.text.div and the sections' text.div): that is the point of the view, and
 * it is safe to show because every narrative in a document is checked for active content
 * (library/narrative-check) before the document is accepted.
 *
 * @module ips/render
 */

const escape = require('escape-html');
const parse5 = require('parse5');
const { checkNarrative } = require('../library/narrative-check');
const { tokenConfigured } = require('../library/request-token');
const { STATUSES } = require('./search');
const { terminologyOf, systemName, describeVersion, linkForSystem, linkForCode, isExternalSystem } = require('./terminology');
const { issueSummary, checkOf, translationOf } = require('./pipeline');

const STATUS_COLOURS = {
  submitted: '#6c757d',
  processing: '#0d6efd',
  processed: '#1e7e34',
  error: '#c82333'
};

const STYLE = `
<style>
  .ips-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; color: white; font-size: 85%; white-space: nowrap; }
  .ips-table { font-size: 90%; }
  .ips-table td, .ips-table th { vertical-align: top; }
  .ips-json { white-space: pre-wrap; word-break: break-all; font-size: 85%; background: #f8f9fa; padding: 8px; border: 1px solid #dee2e6; font-family: monospace; }
  .ips-banner { background: #ede7f6; border: 1px solid #d1c4e9; border-radius: 4px; padding: 10px 14px; margin-bottom: 10px; }
  .ips-banner .ips-patient { font-size: 120%; }
  .ips-banner .ips-project-name { font-size: 130%; }
  .ips-actions-line { margin-bottom: 10px; }
  .ips-actions-line .btn { font-size: 90%; padding: 3px 12px; }
  .ips-search { background: #fffde7; border: 1px solid #fff59d; border-radius: 4px; padding: 8px 10px; }
  .ips-docs h4 { margin-top: 0; }
  .ips-api td:first-child { white-space: nowrap; }
  .ips-banner .ips-facts { font-size: 90%; color: #444; margin-top: 4px; }
  .ips-banner .ips-facts a { margin-left: 4px; }
  .ips-steps { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin-bottom: 10px; font-size: 90%; }
  .ips-step { display: inline-block; padding: 2px 10px; border-radius: 12px; color: white; white-space: nowrap; cursor: default; }
  .ips-step-done { background: #1e7e34; }
  .ips-step-failed { background: #c82333; }
  .ips-step-running { background: #0d6efd; }
  .ips-step-waiting { background: #6c757d; }
  .ips-steps .ips-actions { margin-left: auto; display: flex; gap: 6px; }
  .ips-steps .ips-actions .btn { font-size: 90%; padding: 2px 10px; }
  .ips-nav.nav-tabs { margin-bottom: 14px; }
  .ips-nav.nav-tabs > li > a { padding: 6px 14px; }
  .ips-explain { margin-top: 18px; padding-top: 8px; border-top: 1px solid #dee2e6; }
  .ips-filter { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; font-size: 85%; }
  .ips-filter input, .ips-filter select { font-size: 100%; padding: 1px 4px; height: auto; }
  .ips-filter input[type=text] { width: 10em; }
  .ips-filter input[type=date] { width: 9.5em; }
  .ips-filter .ips-btn { font-size: 100%; padding: 1px 10px; line-height: 1.5; }
  .ips-date { white-space: nowrap; }
  .ips-narrative { border: 1px solid #dee2e6; padding: 12px; background: #fff; }
  .ips-narrative h3 { font-size: 110%; margin-top: 18px; border-bottom: 1px solid #eee; }
  .ips-narrative h4 { font-size: 100%; margin-top: 12px; }
  .ips-narrative table { border-collapse: collapse; margin-bottom: 8px; }
  .ips-narrative td, .ips-narrative th { border: 1px solid #ddd; padding: 2px 6px; font-size: 90%; }
  .ips-meta { font-size: 85%; color: #555; margin-bottom: 10px; }
  .ips-form label { display: block; font-weight: bold; margin-top: 10px; }
  .ips-form textarea { width: 100%; height: 20em; font-family: monospace; font-size: 85%; }
  .ips-form input[type=text], .ips-form input[type=password] { width: 100%; max-width: 480px; }
  .ips-small { font-size: 85%; color: #555; }
  .ips-term th.ips-section { background: #e9ecef; font-size: 105%; }
  .ips-term th.ips-resource { background: #f8f9fa; font-weight: normal; font-style: italic; }
  .ips-term ul { margin: 0; padding-left: 1.2em; }
  .ips-term code { font-size: 95%; }
  .ips-copy { font-size: 85%; padding: 0 6px; }
  .ips-grade { font-size: 110%; padding: 2px 10px; }
  .ips-issues td.ips-path { max-width: 28em; overflow: hidden; }
  .ips-issues td.ips-path code { white-space: normal; word-break: keep-all; overflow-wrap: normal; }
  .ips-oo { margin-top: 10px; }
  .ips-oo summary { list-style: none; display: inline-block; }
  .ips-oo summary::-webkit-details-marker { display: none; }
  .ips-oo pre { margin-top: 8px; }
  .ips-generated table.ips-section, .ips-generated table.ips-facts { border-collapse: collapse; margin-bottom: 10px; font-size: 90%; }
  .ips-generated table.ips-section th, .ips-generated table.ips-section td, .ips-generated table.ips-facts td { border: 1px solid #dee2e6; padding: 3px 6px; vertical-align: top; }
  .ips-generated table.ips-section th { background: #f8f9fa; }
  .ips-generated tr.ips-follow td { background: #fcfcfc; }
  .ips-generated tr.ips-follow ul { margin: 0; padding-left: 18px; }
  .ips-generated .ips-as-submitted { font-size: 85%; color: #6c757d; margin-bottom: 4px; }
  .ips-generated h1 { font-size: 150%; } .ips-generated h2 { font-size: 125%; margin-top: 16px; } .ips-generated h3 { font-size: 110%; }
  .ips-translated { font-size: 80%; color: #fff; background: #6f42c1; border-radius: 3px; padding: 0 5px; cursor: help; }
  .ips-check { font-size: 130%; font-weight: bold; cursor: help; }
  .ips-check-in { color: #1e7e34; }
  .ips-check-international { color: #fd7e14; }
  .ips-check-not-in { color: #c82333; }
  .ips-check-unknown { color: #6c757d; }
  .ips-inline { display: inline; }
</style>`;

function text(v) {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  return '';
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function badge(status) {
  const s = text(status);
  if (!s) {
    return '';
  }
  return `<span class="ips-badge" style="background-color: ${STATUS_COLOURS[s] || '#495057'}">${escape(s)}</span>`;
}

/** Just the date part of a FHIR date/dateTime/instant, as sent. */
function dateOnly(v) {
  const s = text(v);
  const m = /^\d{4}(-\d{2}(-\d{2})?)?/.exec(s);
  return m ? m[0] : s;
}

/** Build a query string from a plain object, dropping empty values. */
function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    for (const x of (Array.isArray(v) ? v : [v])) {
      if (typeof x === 'string' && x !== '') {
        u.append(k, x);
      }
    }
  }
  const s = u.toString();
  return s ? '?' + s : '';
}

function field(query, name) {
  const v = query[name];
  return typeof v === 'string' ? v : (Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '');
}

/** The hidden field every POST form carries: the CSRF token (lusca checks it). */
function csrfField(token) {
  return token ? `<input type="hidden" name="_csrf" value="${escape(token)}"/>` : '';
}

function alert(message, kind = 'warning') {
  return message ? `<div class="alert alert-${kind}">${escape(message)}</div>` : '';
}

/**
 * The line at the top of every page: who is logged in, and what they can get to.
 * @param {{base: string, user?: Object, csrf?: string}} ctx
 */
function userBar(ctx) {
  const base = escape(ctx.base);
  const u = ctx.user;
  if (!u) {
    return `<div style="float: right; font-size: 85%"><a href="${base}/login">Login</a></div>`;
  }
  const parts = [`Logged in as <b>${escape(u.name)}</b>`];
  if (u.isAdmin) {
    parts.push(`<a href="${base}/admin/projects">Projects</a>`);
    parts.push(`<a href="${base}/admin/users">Users</a>`);
  }
  parts.push(`<form method="post" action="${base}/logout" class="ips-inline">${csrfField(ctx.csrf)}<button type="submit" class="btn btn-link" style="padding: 0; font-size: 100%; vertical-align: baseline">Logout</button></form>`);
  return `<div style="float: right; font-size: 85%">${parts.join(' &nbsp;|&nbsp; ')}</div>`;
}

function projectUrl(ctx, project) {
  return `${escape(ctx.base)}/${encodeURIComponent(project.code)}`;
}

function crumbs(ctx, project, extra) {
  let h = `<p class="ips-small"><a href="${escape(ctx.base)}">IPS projects</a>`;
  if (project) {
    h += ` &raquo; <a href="${projectUrl(ctx, project)}">${escape(project.name)}</a>`;
  }
  if (extra) {
    h += ` &raquo; ${escape(extra)}`;
  }
  return h + '</p>';
}

// ---- the root: projects ----------------------------------------------------------------

/**
 * The list of projects.
 * @param {Array} projects - from store.projects()
 * @param {{base: string, user?: Object, csrf?: string}} ctx
 */
function renderHome(projects, ctx) {
  let h = STYLE + userBar(ctx);
  h += '<p>Each project is a collection of International Patient Summary documents, with its own FHIR endpoint ' +
    '(<code>POST</code> / <code>GET {project}/Bundle</code>) and web pages.</p>';
  if (projects.length === 0) {
    return h + '<p>There are no projects yet' + (ctx.user?.isAdmin ? `: <a href="${escape(ctx.base)}/admin/projects">create one</a>` : '') + '.</p>';
  }
  h += '<table class="table table-sm table-striped ips-table"><tr><th>Project</th><th>Code</th><th>Description</th><th>Documents</th></tr>';
  for (const p of projects) {
    h += `<tr><td><a href="${projectUrl(ctx, p)}">${escape(p.name)}</a></td><td><code>${escape(p.code)}</code></td>` +
      `<td>${escape(p.description || '')}</td><td>${p.documents}</td></tr>`;
  }
  return h + '</table>';
}

function renderLogin(ctx, error) {
  const base = escape(ctx.base);
  let h = STYLE + crumbs(ctx) + alert(error, 'danger');
  h += `<form method="post" action="${base}/login" style="max-width: 360px">${csrfField(ctx.csrf)}` +
    '<div class="mb-3"><label for="login" class="form-label">Username</label>' +
    '<input type="text" class="form-control" id="login" name="login" required autocomplete="username"/></div>' +
    '<div class="mb-3"><label for="password" class="form-label">Password</label>' +
    '<input type="password" class="form-control" id="password" name="password" required autocomplete="current-password"/></div>' +
    '<button type="submit" class="btn btn-primary">Login</button></form>';
  return h;
}

/**
 * The administrator's projects page: create, edit, delete, and who manages each.
 * @param {Array} projects - from store.projects()
 * @param {Array} users - from store.users()
 */
function renderProjects(projects, users, ctx, message) {
  const base = escape(ctx.base);
  let h = STYLE + userBar(ctx) + crumbs(ctx, null, 'Projects') + alert(message);
  h += '<p>A project\'s code is its address: <code>' + base + '/{code}</code>. Codes are 2-32 lower case letters, digits and hyphens, and can\'t be changed once a project exists.</p>';
  const managerBoxes = (p, form) => users.map(u => {
    const on = p && p.managers.some(m => m.id === u.id);
    return `<label class="ips-inline" style="margin-right: 8px; font-weight: normal"><input form="${form}" type="checkbox" name="manager" value="${u.id}"${on ? ' checked' : ''}/> ${escape(u.login)}</label>`;
  }).join('') || '<span class="ips-small">(no users yet)</span>';
  h += '<table class="table table-sm ips-table"><tr><th>Code</th><th>Name</th><th>Description</th><th>Managers</th><th>Documents</th><th></th></tr>';
  for (const p of projects) {
    const form = `project-${p.id}`;
    const action = `${base}/admin/projects/${p.id}`;
    h += `<tr><td><a href="${projectUrl(ctx, p)}"><code>${escape(p.code)}</code></a></td>` +
      `<td><input form="${form}" type="text" name="name" required class="form-control" style="font-size: 85%" value="${escape(p.name)}"/></td>` +
      `<td><input form="${form}" type="text" name="description" class="form-control" style="font-size: 85%" value="${escape(p.description || '')}"/></td>` +
      `<td>${managerBoxes(p, form)}</td><td>${p.documents}</td>` +
      `<td style="white-space: nowrap"><form id="${form}" method="post" action="${action}" class="ips-inline">${csrfField(ctx.csrf)}` +
      '<button type="submit" class="btn btn-primary ips-btn" style="font-size: 85%; padding: 1px 10px">Save</button></form> ' +
      `<form method="post" action="${action}/delete" class="ips-inline" onsubmit="return confirm('Delete project ${escape(p.code)} and its ${p.documents} documents?')">${csrfField(ctx.csrf)}` +
      '<button type="submit" class="btn btn-default ips-btn" style="font-size: 85%; padding: 1px 10px">Delete</button></form></td></tr>';
  }
  h += `<tr><td><input form="project-new" type="text" name="code" required class="form-control" style="font-size: 85%" placeholder="code" pattern="[a-z0-9][a-z0-9-]{1,31}"/></td>` +
    '<td><input form="project-new" type="text" name="name" required class="form-control" style="font-size: 85%" placeholder="Name"/></td>' +
    '<td><input form="project-new" type="text" name="description" class="form-control" style="font-size: 85%" placeholder="Description"/></td>' +
    `<td>${managerBoxes(null, 'project-new')}</td><td></td>` +
    `<td><form id="project-new" method="post" action="${base}/admin/projects">${csrfField(ctx.csrf)}` +
    '<button type="submit" class="btn btn-primary ips-btn" style="font-size: 85%; padding: 1px 10px">Create</button></form></td></tr>';
  return h + '</table>';
}

/**
 * The administrator's users page.
 * @param {Array} users - from store.users()
 */
function renderUsers(users, ctx, message) {
  const base = escape(ctx.base);
  let h = STYLE + userBar(ctx) + crumbs(ctx, null, 'Users') + alert(message);
  h += `<p>Users manage projects: which ones is set on the <a href="${base}/admin/projects">projects</a> page. ` +
    'Leave the password blank to keep it.</p>';
  h += '<table class="table table-sm ips-table"><tr><th>Username</th><th>Name</th><th>Password</th><th>Manages</th><th></th></tr>';
  for (const u of users) {
    const form = `user-${u.id}`;
    const action = `${base}/admin/users/${u.id}`;
    h += `<tr><td>${escape(u.login)}</td>` +
      `<td><input form="${form}" type="text" name="name" required class="form-control" style="font-size: 85%" value="${escape(u.name)}"/></td>` +
      `<td><input form="${form}" type="password" name="password" class="form-control" style="font-size: 85%" autocomplete="new-password" placeholder="(unchanged)"/></td>` +
      `<td>${u.projects.map(c => `<code>${escape(c)}</code>`).join(' ')}</td>` +
      `<td style="white-space: nowrap"><form id="${form}" method="post" action="${action}" class="ips-inline">${csrfField(ctx.csrf)}` +
      '<button type="submit" class="btn btn-primary ips-btn" style="font-size: 85%; padding: 1px 10px">Save</button></form> ' +
      `<form method="post" action="${action}/delete" class="ips-inline" onsubmit="return confirm('Delete user ${escape(u.login)}?')">${csrfField(ctx.csrf)}` +
      '<button type="submit" class="btn btn-default ips-btn" style="font-size: 85%; padding: 1px 10px">Delete</button></form></td></tr>';
  }
  h += '<tr><td><input form="user-new" type="text" name="login" required class="form-control" style="font-size: 85%" placeholder="username" autocomplete="off"/></td>' +
    '<td><input form="user-new" type="text" name="name" required class="form-control" style="font-size: 85%" placeholder="Name"/></td>' +
    '<td><input form="user-new" type="password" name="password" required class="form-control" style="font-size: 85%" autocomplete="new-password" placeholder="at least 8 characters"/></td>' +
    `<td></td><td><form id="user-new" method="post" action="${base}/admin/users">${csrfField(ctx.csrf)}` +
    '<button type="submit" class="btn btn-primary ips-btn" style="font-size: 85%; padding: 1px 10px">Add</button></form></td></tr>';
  return h + '</table>';
}

// ---- a project -------------------------------------------------------------------------

function input(query, name, label, type = 'text', placeholder = label) {
  return `<input type="${type}" id="f-${escape(name)}" name="${escape(name)}" placeholder="${escape(placeholder)}" ` +
    `title="${escape(label)}" aria-label="${escape(label)}" value="${escape(field(query, name))}"/>`;
}

function select(query, name, values, label, anyLabel) {
  const cur = field(query, name);
  let h = `<select id="f-${escape(name)}" name="${escape(name)}" title="${escape(label)}"><option value="">${escape(anyLabel || label + ': any')}</option>`;
  for (const v of values) {
    h += `<option value="${escape(v)}"${v === cur ? ' selected' : ''}>${escape(v)}</option>`;
  }
  return h + '</select>';
}

/** The links under a project's title. */
function projectNav(project, ctx) {
  const purl = projectUrl(ctx, project);
  let h = `<div class="ips-actions-line"><a class="btn btn-primary" href="${purl}/submit">Submit a document</a>`;
  if (ctx.canManage) {
    h += ` <a class="btn btn-default" href="${purl}/settings">Settings</a>`;
  }
  return h + '</div>';
}

/** The documentation at the foot of a project's page: how to reach it as a FHIR endpoint. */
function projectDocs(project, ctx) {
  const purl = projectUrl(ctx, project);
  return '<div class="ips-explain ips-docs"><h4>Documentation</h4>' +
    `<p>This project is a FHIR endpoint: <code>${purl}</code> (<a href="${purl}/metadata">CapabilityStatement</a>). ` +
    'Documents are IPS Bundles (<code>type: document</code>, a Composition first, with the Patient it refers to) in JSON.</p>' +
    '<table class="table table-sm ips-table ips-api"><tr><th>Request</th><th></th></tr>' +
    `<tr><td><code>POST ${purl}/Bundle</code></td><td>submit a document${tokenConfigured(project.token) ? ' (this project requires a token: <code>Authorization: Bearer {token}</code>)' : ''}; the response is the stored document, with its id</td></tr>` +
    `<tr><td><code>GET ${purl}/Bundle/{id}</code></td><td>read a document - JSON for a FHIR client, this web page for a browser (<code>?_format=json</code> forces JSON, <code>?download=1</code> downloads it)</td></tr>` +
    `<tr><td><code>GET ${purl}/Bundle?...</code></td><td>search: Bundle's search parameters (<code>_id</code>, <code>identifier</code>, <code>_lastUpdated</code>, <code>composition</code>), chained to the Composition and Patient as ` +
    '<code>composition.date</code>, <code>composition.title</code>, <code>composition.patient.name</code>, <code>composition.patient.gender</code>, <code>composition.patient.birthdate</code>, <code>composition.patient.identifier</code>, ...; ' +
    'with <code>_sort</code>, <code>_count</code>, <code>_offset</code>, <code>_summary=count</code>, and <code>processing-status</code> for where a document is in the pipeline (the CapabilityStatement lists them all)</td></tr>' +
    `<tr><td><code>GET ${purl}/metadata</code></td><td>the CapabilityStatement</td></tr></table>` +
    '<p class="ips-small">The filters above are the same searches, as the page sends them. See the ' +
    '<a href="https://github.com/HealthIntersections/FHIRsmith/blob/main/ips/readme.md">IPS module documentation</a> for the processing pipeline and the document views.</p></div>';
}

/**
 * A project's page: the filter form and the list of documents.
 *
 * @param {Object} project
 * @param {Object} query - the page's own query (form fields included)
 * @param {{total: number, rows: Object[]}} results
 * @param {Object} search - the parsed search (for count/offset/sort)
 * @param {{base: string, user?: Object, csrf?: string, canManage?: boolean}} ctx
 */
function renderProject(project, query, results, search, ctx, problems) {
  const purl = projectUrl(ctx, project);
  let h = STYLE + userBar(ctx) + crumbs(ctx);
  h += `<div class="ips-banner"><div class="ips-project-name"><b>${escape(project.name)}</b></div>`;
  if (project.description) {
    h += `<div class="ips-facts">${escape(project.description)}</div>`;
  }
  h += '</div>';
  h += projectNav(project, ctx);
  if (problems && problems.length > 0) {
    h += '<div class="alert alert-warning">' + problems.map(escape).join('<br/>') + '</div>';
  }

  h += `<form method="get" action="${purl}" class="ips-filter ips-search mb-3">`;
  h += input(query, 'name', 'Patient name (any part)', 'text', 'Patient name');
  h += select(query, 'gender', ['male', 'female', 'other', 'unknown'], 'Gender');
  h += input(query, 'date', 'Document date', 'date');
  h += input(query, 'identifier', 'Document id or patient identifier', 'text', 'Identifier');
  h += select(query, 'status', STATUSES, 'Status');
  h += select(query, '_count', ['20', '50', '100', '200', '500'], 'Page size', 'Page: 50');
  if (field(query, '_sort')) {
    h += `<input type="hidden" name="_sort" value="${escape(field(query, '_sort'))}"/>`;
  }
  h += '<button type="submit" class="btn btn-primary ips-btn">Filter</button>' +
    `<a class="btn btn-default ips-btn" href="${purl}">Clear</a></form>`;

  const from = results.total === 0 ? 0 : search.offset + 1;
  const to = search.offset + results.rows.length;
  h += `<p>${from}-${to} of ${results.total} document${results.total === 1 ? '' : 's'}</p>`;

  // [sort parameter, heading]; null parameter = not sortable
  const columns = [
    ['_id', 'Id'], ['composition.patient.name', 'Patient'], ['composition.patient.gender', 'Gender'],
    ['composition.patient.birthdate', 'Born'], ['composition.date', 'Date'], ['composition.title', 'Title'],
    ['processing-status', 'Status'], ['_lastUpdated', 'Received']
  ];
  if (ctx.canManage) {
    columns.push([null, '']);
  }
  const curSort = field(query, '_sort');
  h += '<table class="table table-sm table-striped ips-table"><tr>';
  for (const [param, label] of columns) {
    if (!param) {
      h += `<th>${escape(label)}</th>`;
      continue;
    }
    let next = param;
    let arrow = '';
    if (curSort === param) {
      next = '-' + param;
      arrow = ' ▲';
    } else if (curSort === '-' + param) {
      arrow = ' ▼';
    }
    h += `<th><a href="${escape(qs({ ...query, _sort: next, _offset: '' }) || '?')}">${escape(label)}</a>${arrow}</th>`;
  }
  h += '</tr>';
  for (const r of results.rows) {
    const durl = `${purl}/Bundle/${r.id}`;
    h += `<tr><td><a href="${durl}">${r.id}</a></td>` +
      `<td><a href="${durl}">${escape(r.patient_name || '(no name)')}</a></td>` +
      `<td>${escape(r.patient_gender || '')}</td>` +
      `<td class="ips-date">${escape(r.patient_birth || '')}</td>` +
      `<td class="ips-date" title="${escape(r.comp_date || '')}">${escape(dateOnly(r.comp_date))}</td>` +
      `<td>${escape(r.comp_title || '')}</td>` +
      `<td title="${escape(ctx.canManage ? r.status_message || '' : '')}">${badge(r.status)}</td>` +
      `<td class="ips-date" title="${escape(r.received)}">${escape(dateOnly(r.received))}</td>`;
    if (ctx.canManage) {
      h += `<td><form method="post" action="${durl}/delete" class="ips-inline" onsubmit="return confirm('Delete document ${r.id}?')">${csrfField(ctx.csrf)}` +
        '<button type="submit" class="btn btn-link" style="padding: 0; font-size: 85%">delete</button></form></td>';
    }
    h += '</tr>';
  }
  h += '</table>';

  const links = [];
  if (search.offset > 0) {
    links.push(`<a href="${escape(qs({ ...query, _offset: '' }) || '?')}">First</a>`);
    links.push(`<a href="${escape(qs({ ...query, _offset: String(Math.max(0, search.offset - search.count)) }))}">Previous</a>`);
  }
  if (search.count > 0 && search.offset + search.count < results.total) {
    links.push(`<a href="${escape(qs({ ...query, _offset: String(search.offset + search.count) }))}">Next</a>`);
    const last = Math.floor((results.total - 1) / search.count) * search.count;
    links.push(`<a href="${escape(qs({ ...query, _offset: String(last) }))}">Last</a>`);
  }
  if (links.length > 0) {
    h += `<p>${links.join(' &nbsp;|&nbsp; ')}</p>`;
  }
  h += projectDocs(project, ctx);
  return h;
}

/**
 * The form for submitting a document by hand: paste the JSON, or pick a file (which the
 * page reads into the text area - there is no upload).
 */
function renderSubmit(project, ctx, options = {}) {
  const purl = projectUrl(ctx, project);
  let h = STYLE + userBar(ctx) + crumbs(ctx, project, 'Submit') + alert(options.error, 'danger');
  h += '<p>Paste an IPS document (a FHIR R4 <code>Bundle</code> of type <code>document</code>, as JSON, whose first entry is the ' +
    'Composition), or choose a file. Once received, the document is queued for processing.</p>';
  if (options.aiEnabled) {
    h += '<div class="alert alert-info">Documents submitted to this project are sent to an external AI service for assessment, as part of their processing.</div>';
  }
  h += `<form method="post" action="${purl}/submit" class="ips-form">${csrfField(ctx.csrf)}`;
  if (options.needsToken) {
    h += '<label for="token">Submission token</label><input type="password" id="token" name="token" required autocomplete="off"/>' +
      '<div class="ips-small">This project requires a token to submit documents; ask its managers.</div>';
  }
  h += '<label for="file">File</label><input type="file" id="file" accept=".json,application/json,application/fhir+json"/>';
  h += `<label for="bundle">Document</label><textarea id="bundle" name="bundle" required>${escape(options.bundle || '')}</textarea>`;
  h += '<p style="margin-top: 10px"><button type="submit" class="btn btn-primary">Submit</button></p></form>';
  h += `<script>
document.getElementById('file').addEventListener('change', function () {
  var f = this.files && this.files[0];
  if (!f) { return; }
  var r = new FileReader();
  r.onload = function () { document.getElementById('bundle').value = r.result; };
  r.readAsText(f);
});
</script>`;
  return h;
}

/** A project's settings, for its managers: the submission token. */
function renderSettings(project, ctx, message, options = {}) {
  const purl = projectUrl(ctx, project);
  let h = STYLE + userBar(ctx) + crumbs(ctx, project, 'Settings') + alert(message, message && /must|cannot|not a URL|Unknown|no model|no API key/.test(message) ? 'danger' : 'success');
  h += '<h3>Submission token</h3>';
  h += '<p>When a token is set, a document can only be submitted with it: in the <code>token</code> field of the ' +
    `submission form, or in the <code>Authorization</code> header of a <code>POST ${purl}/Bundle</code> ` +
    '(<code>Authorization: Bearer &lt;token&gt;</code>). Clear it and anyone can submit.</p>';
  h += `<p>Current token: ${project.token ? `<code>${escape(project.token)}</code>` : '<i>none - submissions are open</i>'}</p>`;
  h += `<form method="post" action="${purl}/settings" class="ips-form" style="max-width: 480px">${csrfField(ctx.csrf)}` +
    '<label for="token">New token</label><input type="text" id="token" name="token" autocomplete="off" placeholder="leave blank to clear"/>' +
    '<p style="margin-top: 10px"><button type="submit" class="btn btn-primary">Save</button> ' +
    '<button type="submit" name="generate" value="1" class="btn btn-default">Generate a random token</button></p></form>';
  h += aiSettingsHtml(project, ctx, options);
  h += '<h3>Managers</h3>';
  const managers = project.managers || [];
  h += managers.length === 0
    ? '<p><i>No users manage this project</i> (the administrator does).</p>'
    : '<p>' + managers.map(m => `${escape(m.name)} (<code>${escape(m.login)}</code>)`).join(', ') + '</p>';
  return h;
}

/** The AI assessment part of the settings page. */
function aiSettingsHtml(project, ctx, options) {
  const purl = projectUrl(ctx, project);
  const ai = options.ai || {};
  const { PROVIDERS } = require('./ai-client');
  let h = '<h3>AI assessment</h3>';
  h += '<p>When it is on, every document is sent, after the other processing, to an AI service to be graded for consistency and for its terminology ' +
    '(the document as JSON, with the narrative as the sender wrote it or with none). This sends the document to a third party: turn it on only for a project whose documents may go there. ' +
    (options.serverDefault ? `This server has a default account (${escape(options.serverModel || '')}), which a project without its own uses. ` : 'This server has no default account: a project needs its own. ') +
    `Each project may make ${escape(String(options.dailyCap))} assessments a day unless its cap says otherwise.</p>`;
  if (options.usage) {
    const u = options.usage;
    const row = (label, x) => `<tr><td>${label}</td><td>${tokens(x.calls)}</td><td>${tokens(x.input)}</td><td>${tokens(x.output)}</td>` +
      `<td>${x.costed > 0 ? escape(usd(x.cost)) + (x.costed < x.calls ? ` <small>(${tokens(x.calls - x.costed)} call${x.calls - x.costed === 1 ? '' : 's'} with no known cost)</small>` : '') : (x.calls > 0 ? '<small>not known</small>' : '')}</td></tr>`;
    h += '<table class="table table-sm ips-table" style="max-width: 640px"><tr><th>Usage</th><th>Assessments</th><th>Tokens in</th><th>Tokens out</th><th>Cost</th></tr>' +
      row('Today', u.day) + row('Last 30 days', u.month) + row('All time', u.all) + '</table>' +
      '<p class="ips-small">Cost is what the service reports (OpenRouter does), else from the price list in the server\'s configuration (<code>modules.ips.ai.prices</code>, USD per million tokens by model), else not known.</p>';
  }
  h += `<p>Currently: <b>${ai.enabled ? 'on' : 'off'}</b>` + (ai.keyEnc ? `, with the project's own account (${escape(PROVIDERS[ai.provider]?.name || ai.provider || '')}, model <code>${escape(ai.model || '')}</code>)` : (options.serverDefault ? ', using the server\'s default account' : ', with no account')) + '</p>';
  h += `<form method="post" action="${purl}/settings" class="ips-form" style="max-width: 560px">${csrfField(ctx.csrf)}<input type="hidden" name="form" value="ai"/>`;
  h += `<label><input type="checkbox" name="enabled" value="1"${ai.enabled ? ' checked' : ''}/> Assess documents with an AI service</label>`;
  h += '<label for="ai-provider">Provider</label><select id="ai-provider" name="provider">' +
    Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}"${(ai.provider || 'openai') === k ? ' selected' : ''}>${escape(v.name)}</option>`).join('') + '</select>';
  h += `<label for="ai-baseUrl">Base URL</label><input type="text" id="ai-baseUrl" name="baseUrl" value="${escape(ai.baseUrl || '')}" placeholder="leave blank for the provider's own"/>` +
    '<div class="ips-small">An OpenAI-compatible service (OpenRouter, LiteLLM, Groq, Ollama, ...) is its base URL, up to and including the version (e.g. https://openrouter.ai/api/v1)</div>';
  h += `<label for="ai-model">Model</label><input type="text" id="ai-model" name="model" value="${escape(ai.model || '')}"/>`;
  if (options.canKeep) {
    h += `<label for="ai-apiKey">API key</label><input type="password" id="ai-apiKey" name="apiKey" autocomplete="off" placeholder="${ai.keyEnc ? 'leave blank to keep the current key' : 'leave blank to use the server\'s default account'}"/>`;
    if (ai.keyEnc) {
      h += '<label><input type="checkbox" name="clearKey" value="1"/> Forget the project\'s key (use the server\'s default account)</label>';
    }
  } else {
    h += '<div class="ips-small">This server cannot keep a key for the project (no aiKeySecret is configured): the server\'s default account is used.</div>';
  }
  const narrative = typeof ai.sendNarrative === 'boolean' ? (ai.sendNarrative ? 'send' : 'strip') : 'default';
  h += '<label for="ai-narrative">Narrative</label><select id="ai-narrative" name="narrative">' +
    `<option value="default"${narrative === 'default' ? ' selected' : ''}>As the server does (${options.serverNarrative ? 'sent, as submitted' : 'not sent'})</option>` +
    `<option value="send"${narrative === 'send' ? ' selected' : ''}>Sent, as submitted - the model also reports what the narrative says that the data does not back up</option>` +
    `<option value="strip"${narrative === 'strip' ? ' selected' : ''}>Not sent - the structured data only (smaller, cheaper)</option></select>`;
  h += `<label for="ai-dailyCap">Daily cap</label><input type="text" id="ai-dailyCap" name="dailyCap" value="${Number.isInteger(ai.dailyCap) ? ai.dailyCap : ''}" placeholder="${escape(String(options.dailyCap))}" style="width: 8em"/>`;
  h += '<p style="margin-top: 10px"><button type="submit" class="btn btn-primary">Save</button></p></form>';
  return h;
}

// ---- a document ------------------------------------------------------------------------

/**
 * The narrative of a resource, if there is one and it is clean, as the browser will see it.
 *
 * The check (at submission, and again here) parses each narrative on its own. What is sent
 * is the parsed tree serialised again - never the string as written - because an
 * unterminated tag at the end of one narrative, which the parser drops, would otherwise
 * swallow the start of the next one on the page and could turn its text into attributes of
 * a live element. Serialising closes what was left open, and each narrative is wrapped in
 * its own div.
 */
function narrativeOf(res) {
  const div = res?.text?.div;
  if (typeof div !== 'string' || div.trim() === '') {
    return null;
  }
  if (checkNarrative(div)) {
    return '<p class="ips-small"><i>(narrative not shown: it contains active content)</i></p>';
  }
  return `<div class="ips-narrative-text">${parse5.serialize(parse5.parseFragment(div))}</div>`;
}

function sectionsHtml(sections, level) {
  let h = '';
  for (const s of Array.isArray(sections) ? sections : []) {
    if (!isObject(s)) {
      continue;
    }
    const tag = level <= 4 ? `h${level}` : 'h5';
    h += `<${tag}>${escape(text(s.title) || text(s.code?.text) || '')}</${tag}>`;
    const n = narrativeOf(s);
    if (n) {
      h += n;
    } else if (!s.section) {
      h += '<p class="ips-small"><i>(no narrative)</i></p>';
    }
    h += sectionsHtml(s.section, level + 1);
  }
  return h;
}

/**
 * The document's assembled narrative: the Composition's own, then each section's, with
 * the section titles.
 */
function assembledNarrative(bundle) {
  const comp = Array.isArray(bundle?.entry) ? bundle.entry[0]?.resource : null;
  if (!isObject(comp) || comp.resourceType !== 'Composition') {
    return '<p><i>The document has no Composition.</i></p>';
  }
  let h = '<div class="ips-narrative">';
  if (text(comp.title)) {
    h += `<h2>${escape(comp.title)}</h2>`;
  }
  h += narrativeOf(comp) || '';
  h += sectionsHtml(comp.section, 3);
  return h + '</div>';
}

// ---- the terminology view ----

/** Text, as a link when there is somewhere to go. */
function linked(label, href, title) {
  const t = title ? ` title="${escape(title)}"` : '';
  return href ? `<a href="${escape(href)}"${t}>${label}</a>` : `<span${t}>${label}</span>`;
}

/**
 * The contents of a CodeableConcept: its text, and each coding as system, code, display,
 * arranged as the Java DataRenderer does: the system by name with the version described
 * after it in brackets - for SNOMED CT, the edition and release ("SNOMED CT [US rel. Mar
 * 2024]"), with the edition's full name on hover - and the URL on hover. The external code
 * systems (SNOMED CT, LOINC, RxNorm, ...) link to their own browsers, name and code; any
 * other system links to the code system on the terminology server.
 *
 * @param {Object} cc
 * @param {Function|null} codeSystemLink - system URL -> href on the tx server, or null for no server
 */
function conceptHtml(cc, codeSystemLink) {
  const items = [];
  if (text(cc.text)) {
    items.push(`<li>Text: ${escape(cc.text)}</li>`);
  }
  for (const c of Array.isArray(cc.coding) ? cc.coding : []) {
    if (!isObject(c)) {
      continue;
    }
    const sys = systemName(c.system);
    const parts = [];
    const external = isExternalSystem(c.system);
    if (sys) {
      const href = external ? linkForSystem(c.system) : (codeSystemLink ? codeSystemLink(c.system) : null);
      let h = linked(escape(sys), href, text(c.system));
      if (text(c.version)) {
        const v = describeVersion(c.version);
        h += ` <small>[${linked(escape(v.text), null, v.title ? `${v.title} (${c.version})` : c.version)}]</small>`;
      }
      parts.push(h);
    }
    const codeHref = external ? linkForCode(c.system, c.version, c.code) : null;
    parts.push(`<code>${linked(escape(text(c.code)), codeHref, null)}</code>`);
    if (text(c.display)) {
      parts.push(`"${escape(c.display)}"`);
    }
    // a coding the translate step added (in the analysed copy)
    const tr = translationOf(c);
    if (tr) {
      const detail = [`translated by ${tr.server || 'the terminology server'}`, tr.conceptMap ? `with ${tr.conceptMap}` : '', tr.relationship ? `(${tr.relationship})` : ''].filter(Boolean).join(' ');
      parts.push(`<span class="ips-translated" title="${escape(detail)}">translated${tr.relationship ? `, ${escape(tr.relationship)}` : ''}</span>`);
    }
    items.push(`<li>${parts.join(' ')}</li>`);
  }
  if (items.length === 0) {
    return '<i>(empty)</i>';
  }
  return `<ul>${items.join('')}</ul>`;
}

/**
 * The analysis of a concept: the terminology check's verdict from the analysed copy - a
 * green tick (a coding is in an IPS value set), a red cross (none is), or an orange question
 * mark (the server could not say) - with the detail on hover; nothing for an element the
 * IPS doesn't bind, or a document not yet analysed.
 */
function analysisHtml(concept, analysed) {
  // verdicts come from the analysed copy only: the master is the submitter's, extensions
  // and all
  const check = analysed ? checkOf(concept) : null;
  if (!check) {
    return '';
  }
  const symbol = { in: '&#10003;', international: '&#9888;', 'not-in': '&#10007;', unknown: '?' }[check.result];
  const name = (url) => url.substring(url.lastIndexOf('/') + 1);
  const title = [check.message, check.valueSet ? `Value set: ${check.valueSet}` : '', check.system ? `Code system: ${check.system}` : ''].filter(Boolean).join('\n');
  return `<span class="ips-check ips-check-${check.result}" title="${escape(title)}">${symbol}</span>` +
    (check.valueSet ? ` <span class="ips-small">${escape(name(check.valueSet))}</span>` : check.system ? ` <span class="ips-small">${escape(name(check.system))}</span>` : '');
}

function conceptRowFor(c, codeSystemLink, analysed) {
  return `<tr><td><code>${escape(c.path)}</code></td><td>${conceptHtml(c.concept, codeSystemLink)}</td><td>${analysisHtml(c.concept, analysed)}</td>` +
    `<td><button type="button" class="btn btn-default ips-copy" data-json="${escape(JSON.stringify(c.concept))}">Copy</button></td></tr>`;
}

/**
 * The terminology view: every CodeableConcept in the document, by section and resource.
 * @param {Object} bundle
 * @param {{codeSystemLink?: Function|null}} [ctx]
 */
function renderTerminology(bundle, ctx = {}) {
  const t = terminologyOf(bundle);
  const link = ctx.codeSystemLink || null;
  const conceptRow = (c) => conceptRowFor(c, link, !!ctx.analysed);
  // "problems only": just the concepts whose check found something wrong (not in a value
  // set, or undeterminable); the rest, and the section and resource headings left with
  // nothing under them, are hidden
  const problemsOnly = !!ctx.problemsOnly && !!ctx.analysed;
  const isProblem = (c) => {
    const check = checkOf(c.concept);
    return !!check && check.result !== 'in';
  };
  const shown = (concepts) => (problemsOnly ? concepts.filter(isProblem) : concepts);
  let total = t.composition.length;
  let kept = shown(t.composition).length;
  for (const s of t.sections) {
    for (const e of s.entries) {
      total += e.concepts.length;
      kept += shown(e.concepts).length;
    }
  }
  // the explanation goes at the bottom of the page; the filter stays at the top
  const explanation = '<p class="ips-small">Every CodeableConcept in the document: the Composition\'s own, then each section\'s entries, ' +
    'sections in the IPS order. Section codes, categories, and the clinical and verification status of conditions and allergies are left out. ' +
    'Analysis: whether any coding is in the value set this server holds the element to for international exchange - ' +
    '<span class="ips-check ips-check-in">&#10003;</span> yes (or, for an element with no value set of its own, the coding is international anyway); ' +
    '<span class="ips-check ips-check-international">&#9888;</span> no, but a coding is international (SNOMED CT International, LOINC, or an HL7 terminology); ' +
    '<span class="ips-check ips-check-not-in">&#10007;</span> no coding is; ' +
    '<span class="ips-check ips-check-unknown">?</span> the terminology server could not say' +
    (ctx.analysed ? '' : '; blank until the document has been processed') + '. The value set, or the code system, is named beside the mark, in full on hover. ' +
    'A coding marked <span class="ips-translated">translated</span> was added by this server, translating the concept into the value set; the server, concept map and relationship are on hover.</p>';
  let h = '';
  if (ctx.analysed) {
    h += `<form method="get" action="${escape(ctx.docUrl || '')}" class="ips-filter mb-2"><input type="hidden" name="view" value="terminology"/>` +
      `<label><input type="checkbox" name="problems" value="1"${problemsOnly ? ' checked' : ''} onchange="this.form.submit()"/> Only concepts with a problem</label>` +
      '<noscript><button type="submit" class="btn btn-default ips-btn">Apply</button></noscript>' +
      (problemsOnly ? `<span class="ips-small">Showing ${kept} of ${total} concepts</span>` : '') + '</form>';
  }
  h += '<table class="table table-sm table-bordered ips-table ips-term"><tr><th style="width: 30%">Element</th><th>Contents</th><th style="width: 25%">Analysis</th><th></th></tr>';
  const compositionRows = shown(t.composition);
  if (!problemsOnly || compositionRows.length > 0) {
    h += '<tr><th colspan="4" class="ips-section">Composition</th></tr>';
    h += t.composition.length === 0 ? '<tr><td colspan="4"><i>No CodeableConcepts</i></td></tr>' : compositionRows.map(conceptRow).join('');
  }
  for (const s of t.sections) {
    const entries = problemsOnly ? s.entries.filter(e => shown(e.concepts).length > 0) : s.entries;
    if (problemsOnly && entries.length === 0) {
      continue;
    }
    h += `<tr><th colspan="4" class="ips-section">${escape(s.title)}${s.known ? '' : ' <small>(not an IPS section)</small>'}</th></tr>`;
    if (s.entries.length === 0) {
      h += '<tr><td colspan="4"><i>No entries</i></td></tr>';
    }
    for (const e of entries) {
      h += `<tr><th colspan="4" class="ips-resource">${escape(e.label)}${e.resolved ? '' : ' - <b>not found in the document</b>'}</th></tr>`;
      if (e.resolved && e.concepts.length === 0) {
        h += '<tr><td colspan="4"><i>No CodeableConcepts</i></td></tr>';
      }
      h += shown(e.concepts).map(conceptRow).join('');
    }
  }
  if (problemsOnly && kept === 0) {
    h += '<tr><td colspan="4"><i>No problems: every checked concept is in a value set the IPS prefers.</i></td></tr>';
  }
  h += '</table>';
  h += `<div class="ips-explain">${explanation}</div>`;
  h += `<script>
document.querySelectorAll('.ips-copy').forEach(function (b) {
  b.addEventListener('click', function () {
    var json = JSON.stringify(JSON.parse(b.getAttribute('data-json')), null, 2);
    var done = function () { var t = b.textContent; b.textContent = 'Copied'; setTimeout(function () { b.textContent = t; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(done, function () { window.prompt('Copy the JSON:', json); });
    } else {
      window.prompt('Copy the JSON:', json);
    }
  });
});
</script>`;
  return h;
}

// ---- the validation view ----

const SEVERITY_COLOURS = { fatal: '#c82333', error: '#c82333', warning: '#d39e00', information: '#17a2b8' };

/** Where an issue is: its expression (FHIRPath), else its location. */
function issueWhere(i) {
  const e = Array.isArray(i.expression) ? i.expression.filter(x => typeof x === 'string') : [];
  if (e.length > 0) {
    return e;
  }
  return Array.isArray(i.location) ? i.location.filter(x => typeof x === 'string') : [];
}

/** The validator's message for an issue: details.text, else diagnostics. */
function issueMessage(i) {
  return text(i.details?.text) || text(i.diagnostics) || '';
}

// the minimum severity the validation view shows, and how it is said
const LEVELS = [
  ['information', 'Everything'],
  ['warning', 'Warnings and errors'],
  ['error', 'Errors only']
];
const SEVERITY_RANK = { fatal: 3, error: 2, warning: 1, information: 0 };

/**
 * Why a step has no result to show: the document is still queued, or this step failed (its
 * reason, for managers), or an earlier step failed so it never ran, or it was never run.
 */
function noResultNote(row, step, what, options = {}) {
  if (row.status === 'submitted' || row.status === 'processing') {
    return `<p><i>${what} - the document is ${escape(row.status === 'processing' ? 'being processed' : 'waiting in the queue')}.</i></p>`;
  }
  const r = row.results?.[step]?.result;
  if (r?.status === 'failed') {
    return `<p><i>The ${escape(step)} step failed${options.canManage && r.message ? `: ${escape(r.message)}` : ' (the reason is shown to the project\'s managers)'}.</i></p>`;
  }
  if (r?.status === 'waiting') {
    return `<p><i>The ${escape(step)} step did not run: an earlier step failed${options.canManage && row.status_message ? ` (${escape(row.status_message)})` : ''}.</i></p>`;
  }
  return `<p><i>${what}${row.status === 'error' ? ' - processing failed' + (options.canManage && row.status_message ? `: ${escape(row.status_message)}` : '') : ''}.</i></p>`;
}

// what the translate step's outcomes mean on the page: [label, colour]
const TRANSLATION_OUTCOMES = {
  translated: ['Translated', '#1e7e34'],
  'no-translation': ['No translation', '#c82333'],
  failed: ['Failed', '#c82333'],
  'not-needed': ['Not needed', '#6c757d'],
  'not-checked': ['Not checked', '#fd7e14'],
  'no-codings': ['No codings', '#6c757d']
};

/** A coding, briefly: system|code "display". */
function briefCoding(c) {
  return `<code>${escape(`${systemName(c.system) || c.system || ''}|${c.code}`)}</code>` + (typeof c.display === 'string' && c.display ? ` "${escape(c.display)}"` : '');
}

/**
 * The translation view: what the translate step did with each CodeableConcept - left it
 * (already in its value set, or the check could not say), translated it (the codings that
 * came back, with their concept maps and relationships), or found no translation.
 * @param {Object} row - from store.read(), with .results.translate or not
 */
function renderTranslation(row, options = {}) {
  const r = row.results?.translate;
  if (!r || (r.result.status && r.result.status !== 'done') || !Array.isArray(r.result.entries)) {
    return noResultNote(row, 'translate', 'There is no translation record for this document', options);
  }
  const v = r.result;
  const counts = v.counts || {};
  let h = `<p class="ips-small">Translated ${escape(r.made)}` + (v.server ? ` with ${escape(String(v.server))}` : '') +
    (typeof v.ms === 'number' ? ` in ${escape(String(v.ms))} ms` : '') + '</p>';
  h += `<p><b>${escape(`${counts.translated || 0} of ${counts.tried || 0} concepts translated (${counts.codings || 0} codings added)`)}` +
    (counts.failed ? escape(`, ${counts.failed} failed`) : '') + '</b></p>';
  h += '<table class="table table-sm table-striped ips-table"><tr><th>Element</th><th>Codings</th><th>Value set</th><th>Outcome</th><th>Detail</th></tr>';
  for (const e of v.entries) {
    const [label, colour] = TRANSLATION_OUTCOMES[e.outcome] || [e.outcome || '?', '#6c757d'];
    const codings = (Array.isArray(e.codings) ? e.codings : []).map(c => `<li>${briefCoding(c)}</li>`);
    if (e.text) {
      codings.unshift(`<li>Text: ${escape(e.text)}</li>`);
    }
    let detail = e.message ? escape(e.message) : '';
    if (Array.isArray(e.added) && e.added.length > 0) {
      detail += '<ul>' + e.added.map(m => `<li>${briefCoding(m.coding)}` + (m.relationship ? ` <i>${escape(m.relationship)}</i>` : '') +
        (m.conceptMap ? ` from <code>${escape(m.conceptMap)}</code>` : '') + (m.present ? ' (already in the concept)' : '') + '</li>').join('') + '</ul>';
    }
    h += `<tr><td><code>${escape(e.path || '')}</code></td><td>${codings.length ? `<ul>${codings.join('')}</ul>` : '<i>(empty)</i>'}</td>` +
      `<td><span title="${escape(e.target || '')}">${escape(e.target ? e.target.substring(e.target.lastIndexOf('/') + 1) : '')}</span>${e.ownValueSet ? '' : ' <small>(fallback)</small>'}</td>` +
      `<td><span class="ips-badge" style="background-color: ${colour}">${escape(label)}</span></td><td>${detail}</td></tr>`;
  }
  h += '</table>';
  h += '<div class="ips-explain"><p class="ips-small">What the translate step did with each CodeableConcept, before validation: a concept already in the value set this server holds its element to ' +
    '(or, with no value set of its own, already international) needs no translation; one the terminology server could not check is left alone; the rest are sent to the server to translate into the value set ' +
    '(<code>ConceptMap/$translate</code>), and the codings that come back are added to the concept in the analysed copy, with the concept map and relationship the server gave for each.</p></div>';
  return h;
}

/**
 * The generated narrative view: what the narrative step made of the document.
 * @param {Object} row - from store.read(), with .results.narrative or not
 */
function renderGenerated(row, options = {}) {
  const r = row.results?.narrative;
  if (!r || (r.result.status && r.result.status !== 'done') || typeof r.result.html !== 'string') {
    return noResultNote(row, 'narrative', 'There is no generated narrative for this document', options);
  }
  const v = r.result;
  let h = `<p class="ips-small">Generated ${escape(r.made)}` + (typeof v.ms === 'number' ? ` in ${escape(String(v.ms))} ms` : '') +
    (v.lookups ? `, with ${escape(String(v.lookups))} display lookup${v.lookups === 1 ? '' : 's'}` : '') + '</p>';
  // our own output, but parsed and re-serialised like any narrative, never the string itself
  h += `<div class="ips-narrative ips-generated">${parse5.serialize(parse5.parseFragment(v.html))}</div>`;
  h += '<div class="ips-explain"><p class="ips-small">The narrative this server generates for the document (the IPS presenter): the Composition\'s header and the patient, ' +
    'then the sections in the IPS order, each a table of its entries with the columns that suit the resource type (the ones no entry fills are left out) and the nested parts as bullets beneath. ' +
    'Coded values show their text, else a display, else what the terminology server knows, else --. It is also written into the analysed copy as the Composition\'s and the sections\' narrative, which is what the validator sees.</p></div>';
  return h;
}

const tokens = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '?');
const usd = (n) => (n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

const AI_SEVERITY_COLOURS = { high: '#c82333', medium: '#d39e00', low: '#17a2b8' };
const GRADE_COLOURS = { A: '#1e7e34', B: '#5cb85c', C: '#d39e00', D: '#fd7e14', F: '#c82333' };

/**
 * The AI assessment view: the grade, the summary, and the findings.
 * @param {Object} row - from store.read(), with .results.ai or not
 */
function renderAi(row, options = {}) {
  const r = row.results?.ai;
  if (!r || (r.result.status && r.result.status !== 'done')) {
    return noResultNote(row, 'ai', 'There is no AI assessment for this document', options);
  }
  const v = r.result;
  if (v.skipped) {
    return `<p><i>The document was not assessed: ${escape(v.skipped)}.</i></p>`;
  }
  let h = `<p class="ips-small">Assessed ${escape(r.made)} by ${escape(String(v.model || ''))} (${escape(String(v.provider || ''))}, the ${escape(String(v.account || ''))}'s account)` +
    (v.withNarrative ? ', with the narrative as submitted' : ', without the narrative') +
    (typeof v.ms === 'number' ? ` in ${escape(String(v.ms))} ms` : '') +
    (v.usage && (v.usage.input !== null || v.usage.output !== null) ? `; ${escape(tokens(v.usage.input))} tokens in, ${escape(tokens(v.usage.output))} out` : '') +
    (typeof v.cost === 'number' ? ` (${escape(usd(v.cost))})` : '') +
    (v.truncated ? '; <b>the answer was cut off at the token limit</b>' : '') +
    (typeof v.bytesSent === 'number' ? `; ${escape(v.bytesSent.toLocaleString('en-US'))} bytes sent` : '') + '</p>';
  const a = v.assessment;
  if (!a) {
    h += '<p><b>The model did not answer with the expected JSON.</b>' +
      (v.truncated ? ` Its answer was cut off at the limit of ${escape(tokens(v.maxTokens))} tokens - raise <code>modules.ips.ai.maxTokens</code>.` : '') + ' Its answer:</p>';
    h += `<pre class="ips-json">${escape(String(v.raw || ''))}</pre>`;
    return h;
  }
  h += `<p><span class="ips-badge ips-grade" style="background-color: ${GRADE_COLOURS[a.grade] || '#6c757d'}">Grade ${escape(a.grade || '?')}</span> ${escape(a.summary || '')}</p>`;
  const sev = (x) => `<span class="ips-badge" style="background-color: ${AI_SEVERITY_COLOURS[x] || '#6c757d'}">${escape(x)}</span>`;
  h += '<h4>Consistency and integrity</h4>';
  if (a.consistency.length === 0) {
    h += '<p><i>No findings</i></p>';
  } else {
    h += '<table class="table table-sm table-striped ips-table"><tr><th>Severity</th><th>Finding</th><th>Where</th></tr>' +
      a.consistency.map(x => `<tr><td>${sev(x.severity)}</td><td>${escape(x.finding)}</td><td>${escape(x.where || '')}</td></tr>`).join('') + '</table>';
  }
  h += '<h4>Missing</h4>';
  h += a.missing.length === 0 ? '<p><i>Nothing noted as missing</i></p>' : `<ul>${a.missing.map(x => `<li>${escape(x)}</li>`).join('')}</ul>`;
  h += '<h4>Terminology</h4>';
  if (a.terminology.length === 0) {
    h += '<p><i>No findings</i></p>';
  } else {
    h += '<table class="table table-sm table-striped ips-table"><tr><th>Severity</th><th>Finding</th><th>Codes</th></tr>' +
      a.terminology.map(x => `<tr><td>${sev(x.severity)}</td><td>${escape(x.finding)}</td><td>${x.codes.map(c => `<code>${escape(c)}</code>`).join('<br/>')}</td></tr>`).join('') + '</table>';
  }
  h += '<details class="ips-oo"><summary><button type="button" class="btn btn-default ips-btn ips-oo-toggle">Show the model\'s answer</button></summary>' +
    `<pre class="ips-json">${escape(String(v.raw || ''))}</pre></details>`;
  h += `<script>
document.querySelectorAll('.ips-oo-toggle').forEach(function (b) {
  var d = b.closest('details');
  b.addEventListener('click', function (e) { e.preventDefault(); d.open = !d.open; });
  d.addEventListener('toggle', function () { b.textContent = (d.open ? 'Hide' : 'Show') + " the model's answer"; });
});
</script>`;
  h += '<div class="ips-explain"><p class="ips-small">An AI service\'s assessment of the document (the analysed copy, with the narrative as submitted or without any, as the project\'s settings say): its consistency and integrity as a whole - do its details agree with each other and the overall picture, and is anything missing; with the narrative, what it says that the data does not back up - ' +
    'and its terminology - are the codes consistent with each other and with their text. The grade runs A (consistent and complete) to F (not usable). It is the model\'s opinion, to be read as such.</p></div>';
  return h;
}

/**
 * The validation view: what the validator made of the document.
 * @param {Object} row - from store.read(), with .results.validation (from store.readResult) or not
 * @param {{level?: string, docUrl?: string}} [options] - level: the least severity shown
 *   (information, the default, shows everything); docUrl: the page's address, for the form
 */
function renderValidation(row, options = {}) {
  const r = row.results?.validation;
  // a step that has only been marked waiting, running or failed has made nothing yet
  if (!r || (r.result.status && r.result.status !== 'done')) {
    return noResultNote(row, 'validation', 'There is no validation result for this document', options);
  }
  const v = r.result;
  const counts = v.counts || {};
  let h = `<p class="ips-small">Validated ${escape(r.made)}` +
    (v.validatorVersion ? ` with validator ${escape(String(v.validatorVersion))}` : '') +
    (Array.isArray(v.profiles) && v.profiles.length ? ` against ${v.profiles.map(p => `<code>${escape(p)}</code>`).join(', ')}` : '') +
    (typeof v.ms === 'number' ? ` in ${escape(String(v.ms))} ms` : '') + '</p>';
  h += `<p><b>${escape(issueSummary(counts))}</b></p>`;
  const all = Array.isArray(v.outcome?.issue) ? v.outcome.issue.filter(isObject) : [];
  if (all.length === 0) {
    return h;
  }
  const level = LEVELS.some(([l]) => l === options.level) ? options.level : 'information';
  const min = SEVERITY_RANK[level];
  const issues = all.filter(i => (SEVERITY_RANK[text(i.severity)] ?? 3) >= min);
  // the minimum level: a form that submits itself on change (and has a button without script)
  h += `<form method="get" action="${escape(options.docUrl || '')}" class="ips-filter mb-2"><input type="hidden" name="view" value="validation"/>` +
    '<label for="f-level">Show</label> <select id="f-level" name="level" onchange="this.form.submit()">' +
    LEVELS.map(([l, label]) => `<option value="${l}"${l === level ? ' selected' : ''}>${escape(label)}</option>`).join('') +
    '</select><noscript><button type="submit" class="btn btn-default ips-btn">Apply</button></noscript>';
  if (issues.length < all.length) {
    const which = level === 'error' ? 'errors and above' : 'warnings and above';
    h += `<span class="ips-small">Showing ${issues.length} of ${all.length} issues (${which})</span>`;
  }
  h += '</form>';
  // the severity is the colour of the code (its name on hover); paths break at their dots,
  // slashes and hyphens (only), so that the message keeps its room
  h += '<table class="table table-sm table-striped ips-table ips-issues"><tr><th>Code</th><th>Location</th><th>Message</th></tr>';
  for (const i of issues) {
    const sev = text(i.severity);
    h += `<tr><td><span class="ips-badge" style="background-color: ${SEVERITY_COLOURS[sev] || '#495057'}" title="${escape(sev)}">${escape(text(i.code) || sev)}</span></td>` +
      `<td class="ips-path">${issueWhere(i).map(w => `<code>${escape(w).replace(/([./-])/g, '$1<wbr/>')}</code>`).join('<br/>')}</td>` +
      `<td>${escape(issueMessage(i))}</td></tr>`;
  }
  h += '</table>';
  // the raw OperationOutcome, behind a button (a <details> for a browser without scripts)
  h += '<details class="ips-oo"><summary><button type="button" class="btn btn-default ips-btn ips-oo-toggle">Show the OperationOutcome</button></summary>' +
    `<pre class="ips-json">${escape(JSON.stringify(v.outcome, null, 2))}</pre></details>`;
  h += `<script>
document.querySelectorAll('.ips-oo-toggle').forEach(function (b) {
  var d = b.closest('details');
  b.addEventListener('click', function (e) { e.preventDefault(); d.open = !d.open; });
  d.addEventListener('toggle', function () { b.textContent = (d.open ? 'Hide' : 'Show') + ' the OperationOutcome'; });
});
</script>`;
  return h;
}

// the views of a document; more come later
const VIEWS = [
  ['narrative', 'Narrative'],
  ['translation', 'Translation'],
  ['generated', 'Generated Narrative'],
  ['validation', 'Validation'],
  ['terminology', 'Terminology'],
  ['ai', 'AI Assessment'],
  ['json', 'JSON']
];

/**
 * A document.
 * @param {Object} project
 * @param {Object} row - from store.read(): the columns and .bundle
 * @param {string} view - one of VIEWS
 * @param {{base: string, user?: Object, csrf?: string, canManage?: boolean}} ctx
 */
// the processing steps, as the page shows them: [state, symbol, label]
const STEP_STATES = {
  done: ['done', '&#10003;', 'done'],
  failed: ['failed', '&#10007;', 'failed'],
  running: ['running', '&#9881;', 'running'],
  waiting: ['waiting', '&#9790;', 'waiting']
};

/**
 * Where each processing step is with the document - from the step results, read against
 * the document's own status: a document still in the queue has every step waiting, a
 * document that finished with no result rows (processed before steps were recorded) has
 * every step done.
 */
function stepState(row, step) {
  const r = row.results?.[step]?.result;
  if (r && STEP_STATES[r.status]) {
    return { state: r.status, message: r.message || null };
  }
  if (row.status === 'processed') {
    return { state: 'done', message: null };
  }
  return { state: 'waiting', message: null };
}

function stepsHtml(row, ctx) {
  let h = '';
  for (const step of ctx.steps || []) {
    const { state, message } = stepState(row, step);
    const [, symbol, word] = STEP_STATES[state];
    // a failure's reason can name the inside of the server: for managers
    const detail = message && (state !== 'failed' || ctx.canManage) ? `: ${message}` : '';
    h += `<span class="ips-step ips-step-${state}" title="${escape(`${step} - ${word}${detail}`)}">${symbol} ${escape(step)}</span>`;
  }
  return h;
}

function renderDocument(project, row, view, ctx) {
  const purl = projectUrl(ctx, project);
  const durl = `${purl}/Bundle/${row.id}`;
  let h = STYLE + userBar(ctx) + crumbs(ctx, project, `Document ${row.id}`);

  // the banner: who and what
  h += '<div class="ips-banner">';
  h += `<div class="ips-patient"><b>${escape(row.patient_name || '(no name)')}</b>` +
    (row.patient_gender ? `, ${escape(row.patient_gender)}` : '') +
    (row.patient_birth ? `, born ${escape(row.patient_birth)}` : '') + '</div>';
  h += '<div class="ips-facts">' +
    (row.comp_date ? `Document date ${escape(row.comp_date)} &nbsp;|&nbsp; ` : '') +
    `Received ${escape(row.received)} (${escape(row.source)}) &nbsp;|&nbsp; ${row.size.toLocaleString()} bytes` +
    ` &nbsp;|&nbsp; <a href="${durl}?_format=json">FHIR JSON</a> &nbsp;|&nbsp; <a href="${durl}?download=1">Download</a></div>`;
  h += '</div>';

  // the steps, and what can be done
  h += '<div class="ips-steps">' + stepsHtml(row, ctx);
  if (ctx.canManage) {
    h += '<span class="ips-actions">' +
      `<form method="post" action="${durl}/requeue" class="ips-inline">${csrfField(ctx.csrf)}<button type="submit" class="btn btn-default">Process again</button></form>` +
      `<form method="post" action="${durl}/delete" class="ips-inline" onsubmit="return confirm('Delete document ${row.id}?')">${csrfField(ctx.csrf)}<button type="submit" class="btn btn-danger">Delete</button></form>` +
      '</span>';
  }
  h += '</div>';

  // the views, as tabs
  h += '<ul class="nav nav-tabs ips-nav">' + VIEWS.map(([v, label]) =>
    `<li${v === view ? ' class="active"' : ''}><a href="${durl}?view=${v}">${label}</a></li>`).join('') + '</ul>';

  if (view === 'json') {
    h += `<pre class="ips-json">${escape(JSON.stringify(row.bundle, null, 2))}</pre>`;
  } else if (view === 'terminology') {
    // the analysed copy carries the checks; the concepts are the same
    h += renderTerminology(row.analysed || row.bundle, { ...ctx, analysed: !!row.analysed, docUrl: durl });
  } else if (view === 'translation') {
    h += renderTranslation(row, { canManage: ctx.canManage });
  } else if (view === 'generated') {
    h += renderGenerated(row, { canManage: ctx.canManage });
  } else if (view === 'ai') {
    h += renderAi(row, { canManage: ctx.canManage });
  } else if (view === 'validation') {
    h += renderValidation(row, { level: ctx.level, docUrl: durl, canManage: ctx.canManage });
  } else {
    h += assembledNarrative(row.bundle);
  }
  return h;
}

module.exports = {
  renderHome, renderLogin, renderProjects, renderUsers, renderProject, renderSubmit, renderSettings, renderDocument,
  assembledNarrative, renderTerminology, renderTranslation, renderGenerated, renderAi, renderValidation, VIEWS
};
