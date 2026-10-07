//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * HTML for the /testing module: the filterable list, the summary grid, and the
 * best-effort rendering of a single report.
 *
 * Everything in a TestReport came from an anonymous sender, so every value goes through
 * escape() and only http(s) URLs ever become links. The report's narrative (text.div)
 * is deliberately not rendered - it is XHTML from a stranger. It is still visible, as
 * text, in the raw JSON view.
 *
 * @module testing/render
 */

const escape = require('escape-html');
const { runLengthOf } = require('./store');

const RESULT_COLOURS = {
  pass: '#1e7e34',
  fail: '#c82333',
  error: '#c82333',
  warning: '#d39e00',
  pending: '#6c757d',
  skip: '#6c757d'
};

const STYLE = `
<style>
  .tr-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; color: white; font-size: 85%; white-space: nowrap; }
  .tr-table { font-size: 90%; }
  .tr-table td, .tr-table th { vertical-align: top; }
  .tr-uri { word-break: break-all; font-size: 90%; }
  .tr-msg { white-space: pre-wrap; }
  .tr-json { white-space: pre-wrap; word-break: break-all; font-size: 85%; background: #f8f9fa; padding: 8px; border: 1px solid #dee2e6; }
  .tr-filter { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; font-size: 85%; }
  .tr-filter .tr-line { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; width: 100%; }
  .tr-filter input, .tr-filter select { font-size: 100%; padding: 1px 4px; height: auto; }
  .tr-filter input[type=text] { width: 9em; }
  .tr-filter input[type=number] { width: 4.5em; }
  .tr-filter input[type=date] { width: 9.5em; }
  .tr-filter .tr-lbl { color: #555; }
  .tr-filter .tr-btn { font-size: 100%; padding: 1px 10px; line-height: 1.5; }
  .tr-date { white-space: nowrap; }
  /* operations and assertions; nested inside the striped tests table, so reset its colours */
  table.tr-steps { margin-top: 6px; margin-bottom: 0; }
  table.tr-steps > tbody > tr > td, table.tr-steps > tbody > tr > th { background-color: #fff !important; color: #333 !important; padding: 2px 6px; }
  .tr-grid td { text-align: center; }
  .tr-grid th.tr-col { font-size: 80%; word-break: break-all; min-width: 90px; }
</style>`;

function text(v) {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  return '';
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A link if the value is an http(s) URL, otherwise just the escaped text. */
function uriLink(v, cls = 'tr-uri') {
  const s = text(v);
  if (!s) {
    return '';
  }
  if (/^https?:\/\/[^\s"'<>]+$/i.test(s)) {
    return `<a class="${cls}" href="${escape(s)}" rel="nofollow noopener">${escape(s)}</a>`;
  }
  return `<span class="${cls}">${escape(s)}</span>`;
}

function badge(result) {
  const r = text(result);
  if (!r) {
    return '';
  }
  const colour = RESULT_COLOURS[r] || '#495057';
  return `<span class="tr-badge" style="background-color: ${colour}">${escape(r)}</span>`;
}

function score(v) {
  return typeof v === 'number' && Number.isFinite(v) ? escape(String(v)) : '';
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

/**
 * A canonical URL (or participant uri), as its configured name where there is one: the
 * name links to the configured link, the full URL is in the title, and any |version is
 * shown after the name. Otherwise just the URL.
 *
 * @param {string} url
 * @param {Map<string, {name: string, link: string|null}>} [names] - by unversioned canonical
 * @param {string} [version] - a version to show that is not part of the url (participant.version)
 */
function canonicalHtml(url, names, version) {
  const s = text(url);
  if (!s) {
    return '';
  }
  const bar = s.indexOf('|');
  const bare = bar < 0 ? s : s.substring(0, bar);
  const ver = version || (bar < 0 ? '' : s.substring(bar + 1));
  const known = names && names.get(bare);
  let h;
  if (known) {
    h = known.link && /^https?:\/\/[^\s"'<>]+$/i.test(known.link)
      ? `<a href="${escape(known.link)}" title="${escape(s)}" rel="nofollow noopener">${escape(known.name)}</a>`
      : `<span title="${escape(s)}">${escape(known.name)}</span>`;
    return h + (ver ? ` <small>${escape(ver)}</small>` : '');
  }
  return uriLink(s) + (version ? ` <small>${escape(version)}</small>` : '');
}

function testScriptLabel(ts, names) {
  return ts ? canonicalHtml(ts, names) : '<i>(no test script)</i>';
}

/** "850 ms", "12.3 s", "4m 05s", "1h 02m" */
function runLength(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    return '';
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  const secs = Math.round(ms / 1000);
  if (secs < 3600) {
    return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
  }
  const mins = Math.round(secs / 60);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

/** The hidden field every POST form carries: the CSRF token (lusca checks it). */
function csrfField(token) {
  return token ? `<input type="hidden" name="_csrf" value="${escape(token)}"/>` : '';
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
  if (u.canEditLinks) {
    parts.push(`<a href="${base}/admin/links">Named links</a>`);
  }
  if (u.isAdmin) {
    parts.push(`<a href="${base}/admin/users">Users</a>`);
  }
  parts.push(`<form method="post" action="${base}/logout" style="display: inline">${csrfField(ctx.csrf)}<button type="submit" class="btn btn-link" style="padding: 0; font-size: 100%; vertical-align: baseline">Logout</button></form>`);
  return `<div style="float: right; font-size: 85%">${parts.join(' &nbsp;|&nbsp; ')}</div>`;
}

// ---- the list ------------------------------------------------------------------------

// form fields that are not FHIR search parameters, and what they turn into
const HELPERS = {
  'issued-from': ['issued', 'ge'],
  'issued-to': ['issued', 'le'],
  'received-from': ['_lastUpdated', 'ge'],
  'received-to': ['_lastUpdated', 'le'],
  'score-min': ['score', 'ge'],
  'score-max': ['score', 'le']
};

/**
 * Turn the list page's query (FHIR parameters plus the form's helper fields) into a
 * pure FHIR search query.
 */
function listQueryToSearch(query) {
  const out = {};
  const add = (k, v) => {
    if (out[k] === undefined) {
      out[k] = v;
    } else {
      out[k] = [].concat(out[k], v);
    }
  };
  for (const [k, v] of Object.entries(query || {})) {
    if (HELPERS[k]) {
      const [param, prefix] = HELPERS[k];
      for (const x of (Array.isArray(v) ? v : [v])) {
        if (typeof x === 'string' && x.trim() !== '') {
          add(param, prefix + x.trim());
        }
      }
    } else {
      add(k, v);
    }
  }
  return out;
}

function field(query, name) {
  const v = query[name];
  return typeof v === 'string' ? v : (Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '');
}

function select(query, name, values, label, anyLabel) {
  const cur = field(query, name);
  let h = `<select id="f-${escape(name)}" name="${escape(name)}" title="${escape(label)}"><option value="">${escape(anyLabel || label + ': any')}</option>`;
  for (const v of values) {
    h += `<option value="${escape(v)}"${v === cur ? ' selected' : ''}>${escape(v)}</option>`;
  }
  return h + '</select>';
}

function input(query, name, label, type = 'text', placeholder = label) {
  return `<input type="${type}" id="f-${escape(name)}" name="${escape(name)}" placeholder="${escape(placeholder)}" ` +
    `title="${escape(label)}" aria-label="${escape(label)}" value="${escape(field(query, name))}"/>`;
}

/** Just the date part of a FHIR date/dateTime/instant, as sent. */
function dateOnly(v) {
  const s = text(v);
  return /^\d{4}(-\d{2}(-\d{2})?)?/.test(s) ? s.match(/^\d{4}(-\d{2}(-\d{2})?)?/)[0] : s;
}

// [sort parameter, heading]; null parameter = not sortable. Participants are split by type
const LIST_COLUMNS = [
  ['name', 'Name'], ['result', 'Result'], ['score', 'Score'], [null, 'Tests'],
  ['tester', 'Tester'], ['testscript', 'Test Script'],
  [null, 'Test Engine', 'test-engine'], [null, 'Client', 'client'], [null, 'Server', 'server'],
  ['issued', 'Issued'], [null, 'Run Length'], ['_lastUpdated', 'Received']
];

/**
 * @param {Object} query - the page's own query (form fields included)
 * @param {{total: number, rows: Object[]}} results
 * @param {Object} search - the parsed search (for count/offset/sort)
 * @param {{results: string[], base: string, names?: Map, user?: Object, showClient?: boolean}} options -
 *   base is the module's path, e.g. /testing; names the named links; showClient whether any
 *   report has a client participant
 */
function renderList(query, results, search, options) {
  const base = escape(options.base);
  const names = options.names;
  let h = STYLE + userBar(options);
  h += `<p><a href="${base}/summary">Summary grid</a> &nbsp;|&nbsp; <a href="${base}/metadata">CapabilityStatement</a>` +
    ' &nbsp;|&nbsp; FHIR API: <code>POST TestReport</code>, <code>GET TestReport?...</code></p>';

  // filter form: two lines - text filters and drop-downs, then ranges and buttons
  h += '<form method="get" class="tr-filter mb-3"><div class="tr-line">';
  h += input(query, 'name:contains', 'Name contains', 'text', 'Name');
  h += input(query, 'tester:contains', 'Tester contains', 'text', 'Tester');
  h += input(query, 'testscript:below', 'Test script starts with', 'text', 'Test script');
  h += input(query, 'participant:below', 'Participant starts with', 'text', 'Participant');
  h += select(query, 'result', options.results, 'Result');
  h += select(query, '_count', ['20', '50', '100', '200', '500'], 'Page size', 'Page: 50');
  h += '</div><div class="tr-line">';
  h += `<span class="tr-lbl">Score</span>${input(query, 'score-min', 'Score ≥', 'number', 'min')}-${input(query, 'score-max', 'Score ≤', 'number', 'max')}`;
  h += `<span class="tr-lbl">Issued</span>${input(query, 'issued-from', 'Issued from', 'date')}-${input(query, 'issued-to', 'Issued to', 'date')}`;
  h += `<span class="tr-lbl">Received</span>${input(query, 'received-from', 'Received from', 'date')}-${input(query, 'received-to', 'Received to', 'date')}`;
  if (field(query, '_sort')) {
    h += `<input type="hidden" name="_sort" value="${escape(field(query, '_sort'))}"/>`;
  }
  h += '<button type="submit" class="btn btn-primary tr-btn">Filter</button>' +
    `<a class="btn btn-default tr-btn" href="${base}">Clear</a>`;
  h += '</div></form>';

  // anything the search couldn't use
  const from = results.total === 0 ? 0 : search.offset + 1;
  const to = search.offset + results.rows.length;
  h += `<p>${from}-${to} of ${results.total} report${results.total === 1 ? '' : 's'}</p>`;

  // the table; column headers sort
  const curSort = field(query, '_sort');
  h += '<table class="table table-sm table-striped tr-table"><tr>';
  const columns = LIST_COLUMNS.filter(c => c[2] !== 'client' || options.showClient);
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
    const link = qs({ ...query, _sort: next, _offset: '' });
    h += `<th><a href="${escape(link || '?')}">${escape(label)}</a>${arrow}</th>`;
  }
  h += '</tr>';
  for (const r of results.rows) {
    h += '<tr>';
    h += `<td><a href="${base}/TestReport/${encodeURIComponent(r.id)}">${escape(r.name)}</a></td>`;
    h += `<td>${badge(r.result)}</td>`;
    h += `<td>${score(r.score)}</td>`;
    h += `<td>${typeof r.test_count === 'number' ? r.test_count : ''}</td>`;
    h += `<td>${escape(r.tester)}</td>`;
    h += `<td>${testScriptLabel(r.test_script, names)}</td>`;
    for (const [, , type] of columns.filter(c => c[2])) {
      // anything that is not a test engine or a client is taken to be the server
      const ps = r.participants.filter(p => type === 'server'
        ? p.type !== 'test-engine' && p.type !== 'client' : p.type === type);
      h += `<td>${ps.map(p => canonicalHtml(p.uri, names, p.version)).join('<br/>')}</td>`;
    }
    h += `<td class="tr-date" title="${escape(r.issued)}">${escape(dateOnly(r.issued))}</td>`;
    h += `<td class="tr-date">${escape(runLength(r.run_ms))}</td>`;
    h += `<td class="tr-date" title="${escape(r.received)}">${escape(dateOnly(r.received))}</td>`;
    h += '</tr>';
  }
  h += '</table>';

  // paging
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

// ---- the summary grid ----------------------------------------------------------------

/**
 * @param {Array} cells - from store.summary()
 * @param {'participant'|'tester'} by
 * @param {string} baseUrl
 * @param {Array} testers - from store.testerCounts()
 * @param {{names?: Map, user?: Object}} [ctx]
 */
function renderSummary(cells, by, baseUrl, testers = [], ctx = {}) {
  const base = escape(baseUrl);
  let h = STYLE + userBar({ ...ctx, base: baseUrl });
  const other = by === 'tester' ? 'participant' : 'tester';
  h += `<p><a href="${base}">All reports</a> &nbsp;|&nbsp; Columns are ${by === 'tester' ? 'testers' : 'participants'} ` +
    `(<a href="${base}/summary?by=${other}">show by ${other}</a>${by === 'tester' ? '' : '; test engines are left out'}). Each cell is the latest report (by issued date) ` +
    'for that test script; the run count links to all of them.</p>';
  if (cells.length === 0) {
    return h + '<p>No reports have been received.</p>';
  }
  return h + summaryGrid(cells, by, base, ctx.names) + testerTable(testers, base);
}

/** How many reports have come from each tester. */
function testerTable(testers, base) {
  if (testers.length === 0) {
    return '';
  }
  let h = '<h3>Reports by Tester</h3><table class="table table-sm table-striped tr-table" style="width: auto">' +
    `<tr><th>Tester</th><th>Reports</th><th>${badge('pass')}</th><th>${badge('fail')}</th><th>Other</th><th>Latest</th></tr>`;
  for (const t of testers) {
    h += `<tr><td><a href="${base}${escape(qs({ 'tester:exact': t.tester, _sort: '-_lastUpdated' }))}">${escape(t.tester)}</a></td>` +
      `<td>${t.reports}</td><td>${t.pass}</td><td>${t.fail}</td><td>${t.other}</td>` +
      `<td class="tr-date" title="${escape(t.latest)}">${escape(dateOnly(t.latest))}</td></tr>`;
  }
  return h + '</table>';
}

function summaryGrid(cells, by, base, names) {
  let h = '';
  const cols = [...new Set(cells.map(c => c.col))].sort();
  const scripts = [...new Set(cells.map(c => c.test_script))];
  const at = new Map(cells.map(c => [c.test_script + '\u0000' + c.col, c]));
  h += '<div style="overflow-x: auto"><table class="table table-sm table-bordered tr-table tr-grid"><tr><th>Test Script</th>';
  for (const c of cols) {
    h += `<th class="tr-col">${by === 'tester' ? escape(c) : canonicalHtml(c, names)}</th>`;
  }
  h += '</tr>';
  for (const s of scripts) {
    h += `<tr><th style="text-align: left">${testScriptLabel(s, names)}</th>`;
    for (const c of cols) {
      const cell = at.get(s + '\u0000' + c);
      if (!cell) {
        h += '<td></td>';
        continue;
      }
      const filter = { [by === 'tester' ? 'tester:exact' : 'participant']: c };
      if (s) {
        filter.testscript = s;
      } else {
        filter['testscript:missing'] = 'true';
      }
      const sc = score(cell.score);
      h += `<td><a href="${base}/TestReport/${encodeURIComponent(cell.id)}" title="${escape(cell.name)} - ${escape(dateOnly(cell.issued))}">${badge(cell.result)}</a>` +
        (sc ? `<br/>${sc}` : '') +
        `<br/><a href="${base}${escape(qs({ ...filter, _sort: '-issued' }))}" style="font-size: 80%">${cell.runs} run${cell.runs === 1 ? '' : 's'}</a></td>`;
    }
    h += '</tr>';
  }
  return h + '</table></div>';
}

// ---- a single report -----------------------------------------------------------------

// top level elements the report view shows, or deliberately leaves to the raw JSON
const HANDLED = new Set([
  'resourceType', 'id', 'meta', 'text', 'identifier', 'name', 'status', 'testScript', 'result', 'score',
  'tester', 'issued', 'participant', 'setup', 'test', 'teardown', 'log'
]);

function jsonBlock(v) {
  return `<div class="tr-json">${escape(JSON.stringify(v, null, 2))}</div>`;
}

function periodText(p) {
  if (!isObject(p)) {
    return '';
  }
  const start = text(p.start);
  const end = text(p.end);
  if (start && end) {
    return `${escape(start)} &ndash; ${escape(end)}`;
  }
  return start ? escape(start) + ' &ndash;' : (end ? '&ndash; ' + escape(end) : '');
}

/**
 * A test's result. test.result where there is one; otherwise - reports in the R5 shape
 * have none - the worst result among its actions, so that those still show something.
 */
const RESULT_RANK = ['error', 'fail', 'warning', 'pending', 'pass', 'skip'];
function testResult(t) {
  if (text(t.result)) {
    return text(t.result);
  }
  let best = null;
  for (const action of asArray(t.action)) {
    for (const kind of ['operation', 'assert']) {
      const r = isObject(action) && isObject(action[kind]) ? text(action[kind].result) : '';
      if (r) {
        const rank = RESULT_RANK.indexOf(r) < 0 ? RESULT_RANK.length : RESULT_RANK.indexOf(r);
        if (best === null || rank < best.rank) {
          best = { r, rank };
        }
      }
    }
  }
  return best ? best.r : '';
}

/**
 * The operations and assertions in a list of actions, in order, each as
 * {type: 'operation'|'assertion', message, detail, result}.
 */
function actionSteps(actions) {
  const steps = [];
  for (const action of asArray(actions)) {
    if (!isObject(action)) {
      continue;
    }
    for (const [kind, type] of [['operation', 'operation'], ['assert', 'assertion']]) {
      const a = action[kind];
      if (isObject(a)) {
        steps.push({ type, message: text(a.message), detail: text(a.detail), result: text(a.result) });
      }
    }
  }
  return steps;
}

/** A table of operations and assertions: type, message, details link, result. */
function actionsTable(actions) {
  const steps = actionSteps(actions);
  if (steps.length === 0) {
    return '';
  }
  let h = '<table class="table table-sm table-bordered tr-table tr-steps"><tr><th>Type</th><th>Message</th><th>Details</th><th>Result</th></tr>';
  for (const st of steps) {
    const details = /^https?:\/\/[^\s"'<>]+$/i.test(st.detail)
      ? `<a href="${escape(st.detail)}" rel="nofollow noopener">details</a>`
      : (st.detail ? `<span title="${escape(st.detail)}">details</span>` : '');
    h += `<tr><td>${st.type}</td><td class="tr-msg">${escape(st.message)}</td><td>${details}</td><td>${badge(st.result)}</td></tr>`;
  }
  return h + '</table>';
}

/**
 * Whether a test's actions are worth a table: more than one operation or assertion, or a
 * single one that says more than just its result.
 */
function hasActionDetail(t) {
  const steps = actionSteps(t.action);
  return steps.length > 1 || (steps.length === 1 && !!(steps[0].message || steps[0].detail));
}

function identifierText(ids) {
  return (Array.isArray(ids) ? ids : [ids]).filter(isObject).map(i =>
    (text(i.system) ? escape(text(i.system)) + ' | ' : '') + escape(text(i.value))).join('<br/>');
}

/**
 * @param {Object} report - the stored TestReport
 * @param {string} baseUrl
 * @param {{names?: Map, user?: Object, csrf?: string}} [ctx]
 */
function renderReport(report, baseUrl, ctx = {}) {
  const base = escape(baseUrl);
  const names = ctx.names;
  let h = STYLE + userBar({ ...ctx, base: baseUrl });
  h += `<p><a href="${base}">All reports</a> &nbsp;|&nbsp; <a href="${base}/summary">Summary grid</a> &nbsp;|&nbsp; ` +
    `<a href="${base}/TestReport/${encodeURIComponent(report.id)}?_format=json">JSON</a> &nbsp;|&nbsp; <a href="#raw">Raw JSON below</a></p>`;
  if (ctx.user && ctx.user.canDeleteReports) {
    h += `<form method="post" action="${base}/TestReport/${encodeURIComponent(report.id)}/delete" ` +
      'onsubmit="return confirm(\'Delete this report?\')" style="margin-bottom: 10px">' + csrfField(ctx.csrf) +
      '<button type="submit" class="btn btn-danger tr-btn" style="font-size: 85%; padding: 1px 10px">Delete this report</button></form>';
  }

  // header
  const ts = report.testScript;
  let tsHtml;
  if (typeof ts === 'string') {
    tsHtml = canonicalHtml(ts, names);
  } else if (isObject(ts)) {
    tsHtml = canonicalHtml(ts.reference, names) + (text(ts.display) ? ' (' + escape(ts.display) + ')' : '');
  } else {
    tsHtml = '';
  }
  const rows = [
    ['Name', escape(text(report.name))],
    ['Status', escape(text(report.status))],
    ['Result', badge(report.result)],
    ['Score', score(report.score)],
    ['Tester', escape(text(report.tester))],
    ['Test Script', tsHtml],
    ['Issued', escape(text(report.issued))],
    ['Run Length', escape(runLength(runLengthOf(report)))],
    ['Received', escape(text(report.meta && report.meta.lastUpdated))],
    ['Identifier', report.identifier ? identifierText(report.identifier) : '']
  ];
  h += '<table class="table table-sm tr-table" style="width: auto">';
  for (const [k, v] of rows) {
    if (v) {
      h += `<tr><th>${escape(k)}</th><td>${v}</td></tr>`;
    }
  }
  const tests = asArray(report.test).filter(isObject);
  if (tests.length > 0) {
    const tally = {};
    for (const t of tests) {
      const r = testResult(t) || '(none)';
      tally[r] = (tally[r] || 0) + 1;
    }
    h += '<tr><th>Tests</th><td>' + Object.keys(tally).sort().map(k => `${badge(k)} ${tally[k]}`).join(' &nbsp; ') + '</td></tr>';
  }
  h += '</table>';

  // participants
  h += '<h3>Participants</h3><table class="table table-sm tr-table" style="width: auto"><tr><th>Type</th><th>URI</th><th>Version</th><th>Display</th></tr>';
  for (const p of asArray(report.participant)) {
    if (isObject(p)) {
      h += `<tr><td>${escape(text(p.type))}</td><td>${canonicalHtml(p.uri, names)}</td><td>${escape(text(p.version))}</td><td>${escape(text(p.display))}</td></tr>`;
    }
  }
  h += '</table>';

  // setup, then the tests (one row each, with their operations and assertions under the
  // description when there is more to them than a single result), then teardown. The log
  // is left to the raw JSON
  if (isObject(report.setup) && actionSteps(report.setup.action).length > 0) {
    h += '<h3>Setup</h3>' + actionsTable(report.setup.action);
  }
  if (tests.length > 0) {
    const detailed = tests.map(t => hasActionDetail(t));
    const hasDesc = tests.some((t, i) => text(t.description) || detailed[i]);
    const hasPeriod = tests.some(t => periodText(t.period));
    h += '<h3>Tests</h3><table class="table table-sm table-striped tr-table"><tr><th>Name</th>' +
      (hasDesc ? '<th>Description</th>' : '') + '<th>Result</th>' + (hasPeriod ? '<th>Period</th>' : '') + '</tr>';
    tests.forEach((t, i) => {
      h += `<tr><td>${escape(text(t.name))}</td>` +
        (hasDesc ? `<td><div class="tr-msg">${escape(text(t.description))}</div>${detailed[i] ? actionsTable(t.action) : ''}</td>` : '') +
        `<td>${badge(testResult(t))}</td>` +
        (hasPeriod ? `<td>${periodText(t.period)}</td>` : '') + '</tr>';
    });
    h += '</table>';
  }
  if (isObject(report.teardown) && actionSteps(report.teardown.action).length > 0) {
    h += '<h3>Teardown</h3>' + actionsTable(report.teardown.action);
  }

  // anything else
  const others = Object.keys(report).filter(k => !HANDLED.has(k));
  if (others.length > 0) {
    h += '<h3>Other Content</h3><table class="table table-sm tr-table"><tr><th>Element</th><th>Value</th></tr>';
    for (const k of others) {
      h += `<tr><td>${escape(k)}</td><td>${jsonBlock(report[k])}</td></tr>`;
    }
    h += '</table>';
  }
  if (isObject(report.text)) {
    h += '<p><i>The report has a narrative; it is not displayed here, but is in the raw JSON.</i></p>';
  }

  h += '<h3 id="raw">Raw JSON</h3>' + jsonBlock(report);
  return h;
}

// ---- login and administration --------------------------------------------------------

function renderLogin(baseUrl, error, csrf) {
  const base = escape(baseUrl);
  let h = STYLE;
  if (error) {
    h += `<div class="alert alert-danger">${escape(error)}</div>`;
  }
  h += `<form method="post" action="${base}/login" style="max-width: 360px">${csrfField(csrf)}` +
    '<div class="mb-3"><label for="login" class="form-label">Username</label>' +
    '<input type="text" class="form-control" id="login" name="login" required autocomplete="username"/></div>' +
    '<div class="mb-3"><label for="password" class="form-label">Password</label>' +
    '<input type="password" class="form-control" id="password" name="password" required autocomplete="current-password"/></div>' +
    '<button type="submit" class="btn btn-primary">Login</button></form>';
  return h;
}

/**
 * The named links: canonical URLs that are shown by name.
 * @param {Array} links - from store.links()
 * @param {{base: string, user: Object}} ctx
 */
function renderLinks(links, ctx, message) {
  const base = escape(ctx.base);
  let h = STYLE + userBar(ctx);
  h += `<p><a href="${base}">All reports</a> &nbsp;|&nbsp; <a href="${base}/summary">Summary grid</a></p>`;
  h += '<p>Where a test script or participant URL (ignoring any <code>|version</code>) matches a canonical here, ' +
    'the name is shown instead, linking to the link.</p>';
  if (message) {
    h += `<div class="alert alert-warning">${escape(message)}</div>`;
  }
  h += '<table class="table table-sm tr-table"><tr><th>Canonical</th><th>Name</th><th>Link</th><th></th></tr>';
  const row = (l) => {
    const action = l ? `${base}/admin/links/${l.id}` : `${base}/admin/links`;
    const form = l ? `link-${l.id}` : 'link-new';
    return `<tr><td><input form="${form}" type="text" name="canonical" required class="form-control" style="font-size: 85%" value="${escape(l ? l.canonical : '')}" placeholder="http://..."/></td>` +
      `<td><input form="${form}" type="text" name="name" required class="form-control" style="font-size: 85%" value="${escape(l ? l.name : '')}"/></td>` +
      `<td><input form="${form}" type="url" name="link" class="form-control" style="font-size: 85%" value="${escape(l ? l.link || '' : '')}" placeholder="https://..."/></td>` +
      `<td style="white-space: nowrap"><form id="${form}" method="post" action="${action}" style="display: inline">${csrfField(ctx.csrf)}` +
      `<button type="submit" class="btn btn-primary tr-btn" style="font-size: 85%; padding: 1px 10px">${l ? 'Save' : 'Add'}</button></form>` +
      (l ? ` <form method="post" action="${action}/delete" style="display: inline" onsubmit="return confirm('Delete this link?')">${csrfField(ctx.csrf)}` +
        '<button type="submit" class="btn btn-default tr-btn" style="font-size: 85%; padding: 1px 10px">Delete</button></form>' : '') +
      '</td></tr>';
  };
  for (const l of links) {
    h += row(l);
  }
  h += row(null);
  return h + '</table>';
}

/**
 * User administration (the administrator only).
 * @param {Array} users - from store.users()
 * @param {{base: string, user: Object}} ctx
 */
function renderUsers(users, ctx, message) {
  const base = escape(ctx.base);
  let h = STYLE + userBar(ctx);
  h += `<p><a href="${base}">All reports</a> &nbsp;|&nbsp; <a href="${base}/admin/links">Named links</a></p>`;
  h += '<p>The administrator (login <code>admin</code>, password in the configuration) can do everything. ' +
    'Other users get the rights ticked here. Leave the password blank to keep the current one.</p>';
  if (message) {
    h += `<div class="alert alert-warning">${escape(message)}</div>`;
  }
  h += '<table class="table table-sm tr-table"><tr><th>Login</th><th>Name</th><th>Password</th><th>Edit named links</th><th>Delete reports</th><th></th></tr>';
  const cb = (form, name, on) => `<input form="${form}" type="checkbox" name="${name}" value="1"${on ? ' checked' : ''}/>`;
  for (const u of users) {
    const form = `user-${u.id}`;
    const action = `${base}/admin/users/${u.id}`;
    h += `<tr><td>${escape(u.login)}</td>` +
      `<td><input form="${form}" type="text" name="name" required class="form-control" style="font-size: 85%" value="${escape(u.name)}"/></td>` +
      `<td><input form="${form}" type="password" name="password" class="form-control" style="font-size: 85%" autocomplete="new-password" placeholder="(unchanged)"/></td>` +
      `<td>${cb(form, 'editLinks', u.can_edit_links)}</td><td>${cb(form, 'deleteReports', u.can_delete_reports)}</td>` +
      `<td style="white-space: nowrap"><form id="${form}" method="post" action="${action}" style="display: inline">${csrfField(ctx.csrf)}` +
      '<button type="submit" class="btn btn-primary tr-btn" style="font-size: 85%; padding: 1px 10px">Save</button></form> ' +
      `<form method="post" action="${action}/delete" style="display: inline" onsubmit="return confirm('Delete this user?')">${csrfField(ctx.csrf)}` +
      '<button type="submit" class="btn btn-default tr-btn" style="font-size: 85%; padding: 1px 10px">Delete</button></form></td></tr>';
  }
  h += `<tr><td><input form="user-new" type="text" name="login" required class="form-control" style="font-size: 85%" autocomplete="off"/></td>` +
    '<td><input form="user-new" type="text" name="name" required class="form-control" style="font-size: 85%"/></td>' +
    '<td><input form="user-new" type="password" name="password" required class="form-control" style="font-size: 85%" autocomplete="new-password"/></td>' +
    `<td>${cb('user-new', 'editLinks', false)}</td><td>${cb('user-new', 'deleteReports', false)}</td>` +
    `<td><form id="user-new" method="post" action="${base}/admin/users" style="display: inline">${csrfField(ctx.csrf)}` +
    '<button type="submit" class="btn btn-primary tr-btn" style="font-size: 85%; padding: 1px 10px">Add</button></form></td></tr>';
  return h + '</table>';
}

module.exports = {
  renderList, renderSummary, renderReport, renderLogin, renderLinks, renderUsers,
  listQueryToSearch, uriLink, badge, canonicalHtml, runLength
};
