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
const { STATUSES } = require('./search');
const { terminologyOf, systemName, describeVersion, linkForSystem, linkForCode, isExternalSystem } = require('./terminology');
const { issueSummary, checkOf } = require('./pipeline');

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
  .ips-json { white-space: pre-wrap; word-break: break-all; font-size: 85%; background: #f8f9fa; padding: 8px; border: 1px solid #dee2e6; }
  .ips-filter { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; font-size: 85%; }
  .ips-filter input, .ips-filter select { font-size: 100%; padding: 1px 4px; height: auto; }
  .ips-filter input[type=text] { width: 10em; }
  .ips-filter input[type=date] { width: 9.5em; }
  .ips-filter .ips-btn { font-size: 100%; padding: 1px 10px; line-height: 1.5; }
  .ips-date { white-space: nowrap; }
  .ips-tabs { margin-bottom: 12px; font-size: 90%; }
  .ips-tabs a, .ips-tabs b { margin-right: 10px; }
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
  .ips-check { font-size: 130%; font-weight: bold; cursor: help; }
  .ips-check-in { color: #1e7e34; }
  .ips-check-not-in { color: #c82333; }
  .ips-check-unknown { color: #fd7e14; }
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
  const items = [`<a href="${purl}/submit">Submit a document</a>`];
  if (ctx.canManage) {
    items.push(`<a href="${purl}/settings">Settings</a>`);
  }
  items.push(`<a href="${purl}/metadata">CapabilityStatement</a>`);
  items.push(`FHIR API: <code>POST ${purl}/Bundle</code>, <code>GET ${purl}/Bundle?...</code>`);
  return `<p>${items.join(' &nbsp;|&nbsp; ')}</p>`;
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
  if (project.description) {
    h += `<p>${escape(project.description)}</p>`;
  }
  h += projectNav(project, ctx);
  if (problems && problems.length > 0) {
    h += '<div class="alert alert-warning">' + problems.map(escape).join('<br/>') + '</div>';
  }

  h += `<form method="get" action="${purl}" class="ips-filter mb-3">`;
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
function renderSettings(project, ctx, message) {
  const purl = projectUrl(ctx, project);
  let h = STYLE + userBar(ctx) + crumbs(ctx, project, 'Settings') + alert(message);
  h += '<h3>Submission token</h3>';
  h += '<p>When a token is set, a document can only be submitted with it: in the <code>token</code> field of the ' +
    `submission form, or in the <code>Authorization</code> header of a <code>POST ${purl}/Bundle</code> ` +
    '(<code>Authorization: Bearer &lt;token&gt;</code>). Clear it and anyone can submit.</p>';
  h += `<p>Current token: ${project.token ? `<code>${escape(project.token)}</code>` : '<i>none - submissions are open</i>'}</p>`;
  h += `<form method="post" action="${purl}/settings" class="ips-form" style="max-width: 480px">${csrfField(ctx.csrf)}` +
    '<label for="token">New token</label><input type="text" id="token" name="token" autocomplete="off" placeholder="leave blank to clear"/>' +
    '<p style="margin-top: 10px"><button type="submit" class="btn btn-primary">Save</button> ' +
    '<button type="submit" name="generate" value="1" class="btn btn-default">Generate a random token</button></p></form>';
  h += '<h3>Managers</h3>';
  const managers = project.managers || [];
  h += managers.length === 0
    ? '<p><i>No users manage this project</i> (the administrator does).</p>'
    : '<p>' + managers.map(m => `${escape(m.name)} (<code>${escape(m.login)}</code>)`).join(', ') + '</p>';
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
  const symbol = { in: '&#10003;', 'not-in': '&#10007;', unknown: '?' }[check.result];
  const vs = check.valueSets.map(v => v.substring(v.lastIndexOf('/') + 1))
    .concat(check.patterns.map(p => `fixed ${p.code}`));
  const title = [check.message, check.valueSets.length ? `Value set${check.valueSets.length === 1 ? '' : 's'}: ${check.valueSets.join(', ')}` : '',
    check.patterns.length ? `Fixed code${check.patterns.length === 1 ? '' : 's'}: ${check.patterns.map(p => `${p.system || ''}|${p.code}`).join(', ')}` : ''].filter(Boolean).join('\n');
  return `<span class="ips-check ips-check-${check.result}" title="${escape(title)}">${symbol}</span>` +
    (vs.length ? ` <span class="ips-small">${vs.map(escape).join(', ')}</span>` : '');
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
  let h = '<p class="ips-small">Every CodeableConcept in the document: the Composition\'s own, then each section\'s entries, ' +
    'sections in the IPS order. Section codes, categories, and the clinical and verification status of conditions and allergies are left out. ' +
    'Analysis: whether any coding is in a value set the IPS prefers for that element (or is the code its profile fixes) - ' +
    '<span class="ips-check ips-check-in">&#10003;</span> yes, <span class="ips-check ips-check-not-in">&#10007;</span> no, ' +
    '<span class="ips-check ips-check-unknown">?</span> the terminology server could not say; blank where the IPS has no binding' +
    (ctx.analysed ? '' : ', and until the document has been processed') + '.</p>';
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
 * The validation view: what the validator made of the document.
 * @param {Object} row - from store.read(), with .results.validation (from store.readResult) or not
 * @param {{level?: string, docUrl?: string}} [options] - level: the least severity shown
 *   (information, the default, shows everything); docUrl: the page's address, for the form
 */
function renderValidation(row, options = {}) {
  const r = row.results?.validation;
  if (!r) {
    if (row.status === 'submitted' || row.status === 'processing') {
      return `<p><i>The document has not been validated yet - it is ${escape(row.status === 'processing' ? 'being processed' : 'waiting in the queue')}.</i></p>`;
    }
    return `<p><i>There is no validation result for this document${row.status === 'error' ? ' - processing failed' + (options.canManage && row.status_message ? `: ${escape(row.status_message)}` : '') : ''}.</i></p>`;
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
  h += '<table class="table table-sm table-striped ips-table"><tr><th>Severity</th><th>Code</th><th>Location</th><th>Message</th></tr>';
  for (const i of issues) {
    const sev = text(i.severity);
    h += `<tr><td><span class="ips-badge" style="background-color: ${SEVERITY_COLOURS[sev] || '#495057'}">${escape(sev)}</span></td>` +
      `<td>${escape(text(i.code))}</td>` +
      `<td>${issueWhere(i).map(w => `<code>${escape(w)}</code>`).join('<br/>')}</td>` +
      `<td>${escape(issueMessage(i))}</td></tr>`;
  }
  h += '</table>';
  h += `<details><summary class="ips-small">OperationOutcome</summary><div class="ips-json">${escape(JSON.stringify(v.outcome, null, 2))}</div></details>`;
  return h;
}

// the views of a document; more come later
const VIEWS = [
  ['narrative', 'Narrative'],
  ['terminology', 'Terminology'],
  ['validation', 'Validation'],
  ['json', 'JSON']
];

/**
 * A document.
 * @param {Object} project
 * @param {Object} row - from store.read(): the columns and .bundle
 * @param {string} view - one of VIEWS
 * @param {{base: string, user?: Object, csrf?: string, canManage?: boolean}} ctx
 */
function renderDocument(project, row, view, ctx) {
  const purl = projectUrl(ctx, project);
  const durl = `${purl}/Bundle/${row.id}`;
  let h = STYLE + userBar(ctx) + crumbs(ctx, project, `Document ${row.id}`);
  h += `<div class="ips-meta">Patient: <b>${escape(row.patient_name || '(no name)')}</b>` +
    (row.patient_gender ? `, ${escape(row.patient_gender)}` : '') +
    (row.patient_birth ? `, born ${escape(row.patient_birth)}` : '') +
    (row.comp_date ? ` &nbsp;|&nbsp; Document date: ${escape(row.comp_date)}` : '') +
    ` &nbsp;|&nbsp; Received: ${escape(row.received)} (${escape(row.source)})` +
    ` &nbsp;|&nbsp; Status: ${badge(row.status)}` + (row.status_message && ctx.canManage ? ` ${escape(row.status_message)}` : '') +
    ` &nbsp;|&nbsp; ${row.size.toLocaleString()} bytes` +
    ` &nbsp;|&nbsp; <a href="${durl}?_format=json">FHIR JSON</a>`;
  if (ctx.canManage) {
    h += ` &nbsp;|&nbsp; <form method="post" action="${durl}/requeue" class="ips-inline">${csrfField(ctx.csrf)}` +
      '<button type="submit" class="btn btn-link" style="padding: 0; font-size: 100%; vertical-align: baseline">Process again</button></form>';
    h += ` &nbsp;|&nbsp; <form method="post" action="${durl}/delete" class="ips-inline" onsubmit="return confirm('Delete document ${row.id}?')">${csrfField(ctx.csrf)}` +
      '<button type="submit" class="btn btn-link" style="padding: 0; font-size: 100%; vertical-align: baseline">Delete</button></form>';
  }
  h += '</div>';
  h += '<div class="ips-tabs">' + VIEWS.map(([v, label]) =>
    v === view ? `<b>${label}</b>` : `<a href="${durl}?view=${v}">${label}</a>`).join('') + '</div>';
  if (view === 'json') {
    h += `<div class="ips-json">${escape(JSON.stringify(row.bundle, null, 2))}</div>`;
  } else if (view === 'terminology') {
    // the analysed copy carries the checks; the concepts are the same
    h += renderTerminology(row.analysed || row.bundle, { ...ctx, analysed: !!row.analysed, docUrl: durl });
  } else if (view === 'validation') {
    h += renderValidation(row, { level: ctx.level, docUrl: durl, canManage: ctx.canManage });
  } else {
    h += assembledNarrative(row.bundle);
  }
  return h;
}

module.exports = {
  renderHome, renderLogin, renderProjects, renderUsers, renderProject, renderSubmit, renderSettings, renderDocument,
  assembledNarrative, renderTerminology, renderValidation, VIEWS
};
