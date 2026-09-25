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

function testScriptLabel(ts) {
  return ts ? uriLink(ts) : '<i>(no test script)</i>';
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

const LIST_COLUMNS = [
  ['name', 'Name'], ['status', 'Status'], ['result', 'Result'], ['score', 'Score'],
  ['tester', 'Tester'], ['testscript', 'Test Script'], [null, 'Participants'],
  ['issued', 'Issued'], ['_lastUpdated', 'Received']
];

/**
 * @param {Object} query - the page's own query (form fields included)
 * @param {{total: number, rows: Object[]}} results
 * @param {Object} search - the parsed search (for count/offset/sort)
 * @param {{statuses: string[], results: string[], base: string}} options - base is the module's path, e.g. /testing
 */
function renderList(query, results, search, options) {
  const base = escape(options.base);
  let h = STYLE;
  h += `<p><a href="${base}/summary">Summary grid</a> &nbsp;|&nbsp; <a href="${base}/metadata">CapabilityStatement</a>` +
    ' &nbsp;|&nbsp; FHIR API: <code>POST TestReport</code>, <code>GET TestReport?...</code></p>';

  // filter form: two lines - text filters and drop-downs, then ranges and buttons
  h += '<form method="get" class="tr-filter mb-3"><div class="tr-line">';
  h += input(query, 'name:contains', 'Name contains', 'text', 'Name');
  h += input(query, 'tester:contains', 'Tester contains', 'text', 'Tester');
  h += input(query, 'testscript:below', 'Test script starts with', 'text', 'Test script');
  h += input(query, 'participant:below', 'Participant starts with', 'text', 'Participant');
  h += select(query, 'status', options.statuses, 'Status');
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
  for (const [param, label] of LIST_COLUMNS) {
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
    h += `<td>${escape(r.status)}</td>`;
    h += `<td>${badge(r.result)}</td>`;
    h += `<td>${score(r.score)}</td>`;
    h += `<td>${escape(r.tester)}</td>`;
    h += `<td>${testScriptLabel(r.test_script)}</td>`;
    h += `<td>${r.participants.map(p => uriLink(p.uri) + (p.version ? ` <small>${escape(p.version)}</small>` : '')).join('<br/>')}</td>`;
    h += `<td class="tr-date" title="${escape(r.issued)}">${escape(dateOnly(r.issued))}</td>`;
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
 */
function renderSummary(cells, by, baseUrl) {
  const base = escape(baseUrl);
  let h = STYLE;
  const other = by === 'tester' ? 'participant' : 'tester';
  h += `<p><a href="${base}">All reports</a> &nbsp;|&nbsp; Columns are ${by === 'tester' ? 'testers' : 'participants'} ` +
    `(<a href="${base}/summary?by=${other}">show by ${other}</a>${by === 'tester' ? '' : '; test engines are left out'}). Each cell is the latest report (by issued date) ` +
    'for that test script; the run count links to all of them.</p>';
  if (cells.length === 0) {
    return h + '<p>No reports have been received.</p>';
  }
  const cols = [...new Set(cells.map(c => c.col))].sort();
  const scripts = [...new Set(cells.map(c => c.test_script))];
  const at = new Map(cells.map(c => [c.test_script + '\u0000' + c.col, c]));
  h += '<div style="overflow-x: auto"><table class="table table-sm table-bordered tr-table tr-grid"><tr><th>Test Script</th>';
  for (const c of cols) {
    h += `<th class="tr-col">${by === 'tester' ? escape(c) : uriLink(c)}</th>`;
  }
  h += '</tr>';
  for (const s of scripts) {
    h += `<tr><th style="text-align: left">${testScriptLabel(s)}</th>`;
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

function identifierText(ids) {
  return (Array.isArray(ids) ? ids : [ids]).filter(isObject).map(i =>
    (text(i.system) ? escape(text(i.system)) + ' | ' : '') + escape(text(i.value))).join('<br/>');
}

/**
 * @param {Object} report - the stored TestReport
 */
function renderReport(report, baseUrl) {
  const base = escape(baseUrl);
  let h = STYLE;
  h += `<p><a href="${base}">All reports</a> &nbsp;|&nbsp; <a href="${base}/summary">Summary grid</a> &nbsp;|&nbsp; ` +
    `<a href="${base}/TestReport/${encodeURIComponent(report.id)}?_format=json">JSON</a> &nbsp;|&nbsp; <a href="#raw">Raw JSON below</a></p>`;

  // header
  const ts = report.testScript;
  let tsHtml;
  if (typeof ts === 'string') {
    tsHtml = uriLink(ts);
  } else if (isObject(ts)) {
    tsHtml = uriLink(ts.reference) + (text(ts.display) ? ' (' + escape(ts.display) + ')' : '');
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
      h += `<tr><td>${escape(text(p.type))}</td><td>${uriLink(p.uri)}</td><td>${escape(text(p.version))}</td><td>${escape(text(p.display))}</td></tr>`;
    }
  }
  h += '</table>';

  // tests: one row each. Actions and the log are left to the raw JSON for now
  if (tests.length > 0) {
    const hasDesc = tests.some(t => text(t.description));
    const hasPeriod = tests.some(t => periodText(t.period));
    h += '<h3>Tests</h3><table class="table table-sm table-striped tr-table"><tr><th>Name</th>' +
      (hasDesc ? '<th>Description</th>' : '') + '<th>Result</th>' + (hasPeriod ? '<th>Period</th>' : '') + '</tr>';
    for (const t of tests) {
      h += `<tr><td>${escape(text(t.name))}</td>` +
        (hasDesc ? `<td class="tr-msg">${escape(text(t.description))}</td>` : '') +
        `<td>${badge(testResult(t))}</td>` +
        (hasPeriod ? `<td>${periodText(t.period)}</td>` : '') + '</tr>';
    }
    h += '</table>';
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

module.exports = {
  renderList, renderSummary, renderReport, listQueryToSearch, uriLink, badge
};
