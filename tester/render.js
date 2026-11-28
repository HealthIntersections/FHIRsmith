//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The tester's pages: the form and the list of runs, and a run's results. Everything that
 * came from a server under test (messages, exchanges) is escaped.
 *
 * @module tester/render
 */

const escape = require('escape-html');

// the colours the testing module's pages use (testing/render.js)
const BADGES = { pass: '#1e7e34', fail: '#c82333', warning: '#d39e00', skip: '#6c757d', error: '#c82333' };
const STATUS_BADGES = { queued: '#6c757d', running: '#0069d9', completed: '#1e7e34', cancelled: '#d39e00', error: '#c82333', interrupted: '#c82333' };

function when(t) {
  return t ? escape(new Date(Number(t)).toISOString().substring(0, 19).replace('T', ' ')) + ' <small>UTC</small>' : '';
}

function duration(a, b) {
  if (!a || !b) {
    return '';
  }
  const s = Math.round((Number(b) - Number(a)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function badge(text, colour) {
  return `<span style="display: inline-block; padding: 1px 6px; border-radius: 3px; color: white; font-size: 85%; white-space: nowrap; ` +
    `background-color: ${colour}">${escape(text)}</span>`;
}

function counts(r) {
  const parts = [];
  for (const [k, label] of [['Pass', 'pass'], ['Fail', 'fail'], ['Warning', 'warning'], ['Skip', 'skip'], ['Error', 'error']]) {
    if (Number(r[k])) {
      parts.push(`${badge(`${r[k]} ${label}`, BADGES[label])}`);
    }
  }
  return parts.join(' ');
}

/** The kind of server a run tested, for the list of runs */
function kindOf(r) {
  if (r.Kind === 'npm') {
    return 'npm registry';
  }
  if (r.Kind === 'tx') {
    return `terminology${r.FhirVersion ? ` (FHIR ${escape(r.FhirVersion)})` : ''}`;
  }
  return r.FhirVersion ? `FHIR ${escape(r.FhirVersion)}` : 'FHIR';
}

/** What a run tested: the server, and for a registry, the package */
function serverCell(r) {
  return `<code>${escape(r.Server)}</code>` + (r.Kind === 'npm' && r.Package ? `<br/><small>with <code>${escape(r.Package)}#${escape(r.Version || '')}</code></small>` : '') +
    (r.Kind === 'tx' ? `<br/><small>modes ${escape(modesOf(r).join(', '))}</small>` : '') +
    (r.Software ? `<br/><small>${escape(r.Software)}</small>` : '');
}

/**
 * Whether the npm checks still pass against the npm registry itself (checked daily)
 * @param {Object} control - { registry, package, version }, or null (not checked)
 * @param {Object} report - the latest run's report (tester/npm/checks.js), or null (not yet)
 */
function controlSummary(control, report) {
  if (!control) {
    return '';
  }
  const what = `<code>${escape(control.registry)}</code> (<code>${escape(control.package)}#${escape(control.version)}</code>)`;
  if (!report) {
    return `<p><small>The checks are verified daily against the npm registry itself, ${what}. That hasn't finished yet.</small></p>`;
  }
  const total = report.passed + report.failed;
  if (report.failed === 0) {
    return `<p><small>${badge('pass', BADGES.pass)} The checks are verified daily against the npm registry itself: all ${total} passed against ${what} on ${escape(new Date(report.finished).toUTCString())}.</small></p>`;
  }
  let html = `<div class="alert alert-warning"><p>The checks are verified daily against the npm registry itself, and on ${escape(new Date(report.finished).toUTCString())} ` +
    `${report.failed} of ${total} failed against ${what}. The npm registry is the reference, so those checks may be out of date: treat their results with caution.</p><ul>`;
  for (const step of report.steps) {
    for (const c of step.checks.filter(x => x.status === 'fail')) {
      html += `<li>${escape(step.title)}: ${escape(c.title)}: ${escape(c.message)}</li>`;
    }
  }
  return html + '</ul></div>';
}

/** A terminology run's modes (a list) */
function modesOf(r) {
  try {
    const m = JSON.parse(r.Modes || '[]');
    return Array.isArray(m) ? m : [];
  } catch (e) {
    return [];
  }
}

// where the modes chosen are kept, in the browser
const TX_MODES_KEY = 'fhirsmith.tester.txModes';

/** The terminology form's modes: a checkbox each, general ticked to start with, and what was chosen last kept in localStorage */
function txModesHtml(modes) {
  let html = '<fieldset class="mb-2"><legend class="form-label" style="font-size: 100%">The modes to run the tests in (what the server is expected to have and do)</legend>';
  for (const m of modes) {
    html += `<div class="form-check"><input class="form-check-input tx-mode" type="checkbox" name="modes" value="${escape(m.code)}" id="mode-${escape(m.code)}"` +
      `${m.code === 'general' ? ' checked="checked"' : ''}/> <label class="form-check-label" for="mode-${escape(m.code)}"><b>${escape(m.title)}</b>: ${escape(m.description)}</label></div>`;
  }
  html += '</fieldset>';
  // (localStorage can be missing, or throw: then the boxes are as the page has them)
  html += `<script>(function () {
  var key = ${JSON.stringify(TX_MODES_KEY)};
  var boxes = document.querySelectorAll('input.tx-mode');
  try {
    var saved = JSON.parse(window.localStorage.getItem(key) || 'null');
    if (Array.isArray(saved)) {
      for (var i = 0; i < boxes.length; i++) { boxes[i].checked = saved.indexOf(boxes[i].value) >= 0; }
    }
  } catch (e) { }
  function save() {
    var chosen = [];
    for (var i = 0; i < boxes.length; i++) { if (boxes[i].checked) { chosen.push(boxes[i].value); } }
    try { window.localStorage.setItem(key, JSON.stringify(chosen)); } catch (e) { }
  }
  for (var i = 0; i < boxes.length; i++) { boxes[i].addEventListener('change', save); }
})();</script>`;
  return html;
}

/** The form, for a kind of server */
function form(o) {
  const v = o.values || {};
  const npm = o.kind === 'npm';
  const tx = o.kind === 'tx';
  const label = npm ? 'The registry\'s address (what you would give <code>npm --registry</code>)'
    : tx ? `The terminology server's address (its base, where <code>[base]/metadata</code> is)${o.allowPrivate ? '' : ': https only'}` : 'The server\'s address';
  let html = `<form method="post" action="${escape(o.base)}/run" class="mb-4">` +
    `<input type="hidden" name="_csrf" value="${escape(o.csrf || '')}"/><input type="hidden" name="kind" value="${npm ? 'npm' : tx ? 'tx' : 'fhir'}"/>` +
    `<div class="mb-2"><label for="server" class="form-label">${label}</label> ` +
    `<input type="url" class="form-control" id="server" name="server" required="required" maxlength="2000" placeholder="${npm ? 'https://registry.example.org/packages' : tx ? 'https://tx.example.org/r4' : 'https://example.org/fhir'}" ` +
    `value="${escape(v.server || '')}" style="max-width: 40em"/></div>`;
  if (tx) {
    return html + txModesHtml(o.txModes || []) + '<button type="submit" class="btn btn-primary">Run the tests</button></form>';
  }
  if (npm) {
    html += '<div class="mb-2"><label for="package" class="form-label">A package the registry has</label> ' +
      `<input type="text" class="form-control" id="package" name="package" required="required" maxlength="100" value="${escape(v.package || 'hl7.fhir.r4.core')}" style="max-width: 25em"/></div>` +
      '<div class="mb-2"><label for="version" class="form-label">A version of it the registry has</label> ' +
      `<input type="text" class="form-control" id="version" name="version" required="required" maxlength="50" value="${escape(v.version || '4.0.1')}" style="max-width: 12em"/></div>`;
  }
  html += '<div class="mb-2"><label for="token" class="form-label">Bearer token (optional)</label> ' +
    '<input type="password" class="form-control" id="token" name="token" maxlength="8000" autocomplete="off" style="max-width: 40em"/>' +
    '<div class="form-text">The token is never shown, or kept once the run ends. Everything else is public: anyone can see the run, ' +
    'the requests it made and what the server answered.</div></div>' +
    `<button type="submit" class="btn btn-primary">${npm ? 'Run the checks' : 'Run the tests'}</button></form>`;
  return html;
}

/**
 * The home page: the form (for someone logged in), and the runs
 * @param {Object} o - { base, runs, total, page, pageSize, user (or null), csrf, active (the user's run), loginUrl, testCount, reportServer, groups,
 *   kind ('fhir', 'npm' or 'tx': the form shown), npmEnabled, values (to fill the form with), control, controlReport,
 *   txEnabled, txModes, txTestsVersion, allowPrivate }
 */
function renderHome(o) {
  const npm = o.kind === 'npm';
  const tx = o.kind === 'tx';
  let html = '';
  if (o.npmEnabled || o.txEnabled) {
    const tab = (k, label) => k === o.kind ? `<b>${label}</b>` : `<a href="${escape(o.base)}${k === 'fhir' ? '' : '?kind=' + k}">${label}</a>`;
    html += `<p>Test: ${[tab('fhir', 'a FHIR server'), o.npmEnabled ? tab('npm', 'an npm registry') : null, o.txEnabled ? tab('tx', 'a terminology server') : null].filter(x => x).join(' | ')}</p>`;
  }
  if (tx) {
    html += '<p>Runs the HL7 terminology service tests (the test cases of the <a href="https://build.fhir.org/ig/HL7/fhir-tx-ecosystem-ig/">terminology ecosystem IG</a>, ' +
      `<code>hl7.fhir.uv.tx-ecosystem#${escape(o.txTestsVersion || 'current')}</code>) against a terminology server, through the FHIR validator, which makes the requests and compares the answers with the expected ones. ` +
      'The tests are those of the modes chosen, at the server\'s FHIR version (from its metadata). A test that fails shows what was expected and what the server answered. ' +
      'The tests load the code systems and value sets they need in each request; the closure tests make closure tables on the server.</p>';
  } else if (npm) {
    html += '<p>Checks a registry against the npm registry protocol, the way an npm client uses it: search for a package by name, ' +
      'read its package document, read one version\'s document, and download that version\'s tarball, checking at each step the parts of the response that npm clients depend on, ' +
      'and the registry\'s signatures, if it signs. Give the registry\'s base address, a package and version it has, and a bearer token if it needs one (it is sent only to the registry). ' +
      'A run makes about a dozen requests, including downloading the tarball; nothing is changed on the registry.</p>';
    html += controlSummary(o.control, o.controlReport);
  } else {
    html += '<p>Runs the FHIRsmith RESTful API tests against a FHIR server: give its address (its base, where <code>[base]/metadata</code> is), and a bearer token if it needs one. ' +
      'The tests test what the server\'s CapabilityStatement says it supports (R4 and R5, JSON and XML); a test of something it doesn\'t say it supports isn\'t run, and says why. ' +
      'The client needs to be able to write. Everything a run makes is marked with the run\'s id, and deleted (and expunged, if the server can) at the end. ' +
      `There are ${o.testCount} tests, in these groups: ${o.groups.map(g => escape(g)).join(', ')}.</p>`;
  }
  html += `<p>One run happens at a time, in the background, and each person can have one run waiting or under way. A run is given at most ${npm ? 5 : tx ? 30 : 15} minutes${tx ? '' : ', and each request 30 seconds'}. ` +
    (tx ? '' : 'The token is kept only while the run is waiting or running, and is never shown. ') + 'Everyone can see every run\'s results' +
    (o.reportServer ? `, and each run's report is sent to <a href="${escape(o.reportServer)}">${escape(o.reportServer)}</a>` : '') + '.</p>';
  if (!o.user) {
    html += `<p><a href="${escape(o.loginUrl)}">Log in</a> to run the ${npm ? 'checks' : 'tests'}.</p>`;
  } else if (o.active) {
    html += `<p>You have a <a href="${escape(o.base)}/runs/${escape(o.active)}">run waiting or under way</a>: you can start another when it's over.</p>`;
  } else {
    html += form(o);
  }
  html += '<h3>Runs</h3>';
  if (!o.runs.length) {
    html += '<p><i>None yet.</i></p>';
    return html;
  }
  html += '<table class="table table-sm grid"><thead><tr><th>Asked for</th><th>Server</th><th>By</th><th>Kind</th><th>Status</th><th>Results</th><th>Took</th></tr></thead><tbody>';
  for (const r of o.runs) {
    html += `<tr><td><a href="${escape(o.base)}/runs/${escape(r.Id)}">${when(r.Requested)}</a></td>` +
      `<td>${serverCell(r)}</td>` +
      `<td>${escape(r.UserName || '')}</td><td>${kindOf(r)}</td>` +
      `<td>${badge(r.Status, STATUS_BADGES[r.Status] || '#495057')}</td><td>${counts(r)}</td><td>${duration(r.Started, r.Finished)}</td></tr>`;
  }
  html += '</tbody></table>';
  const pages = Math.ceil(o.total / o.pageSize);
  if (pages > 1) {
    const link = (p, label) => `<a href="${escape(o.base)}?page=${p}">${label}</a>`;
    html += `<p>Page ${o.page + 1} of ${pages}: ${o.page > 0 ? link(o.page - 1, 'newer') : ''} ${o.page + 1 < pages ? link(o.page + 1, 'older') : ''}</p>`;
  }
  return html;
}

const PRE = 'white-space: pre-wrap; word-break: break-all; font-size: 85%; max-height: 40em; overflow: auto; background: #f8f9fa; padding: 6px; border: 1px solid #dee2e6';

/** A body as it is shown: JSON indented */
function pretty(body) {
  if (typeof body !== 'string') {
    return '';
  }
  const s = body.trim();
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(s), null, 2);
    } catch (e) {
      // not quite JSON (trimmed): as it is
    }
  }
  return body;
}

/** One request and its response */
function exchangeHtml(x, n) {
  const q = x.request || {};
  const s = x.response || {};
  const status = s.error ? 'no answer' : String(s.status);
  const ok = !s.error && s.status < 400;
  return `<div class="mt-3"><h5 style="font-size: 100%">${n}. ${x.phase === 'setup' ? '<i>(setup)</i> ' : ''}<code>${escape(q.method)} ${escape(q.url)}</code> ` +
    `&rarr; ${badge(status, ok ? '#1e7e34' : '#c82333')}${s.ms !== undefined ? ` <small>${Number(s.ms)} ms</small>` : ''}</h5>` +
    `<pre style="${PRE}">${escape(`${q.method} ${q.url}\n${Object.entries(q.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n')}${q.body ? '\n\n' + pretty(q.body) : ''}`)}</pre>` +
    `<pre style="${PRE}">${escape(s.error ? `(no response: ${s.error})` : `${s.status}\n${Object.entries(s.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n')}${s.body ? '\n\n' + pretty(s.body) : ''}`)}</pre></div>`;
}

/** A terminology test: what it does, the request it sends, what's expected, and (if it failed) what the server answered */
function txDetailHtml(tx, outcome) {
  let html = '<h4 class="mt-3">The test</h4><table class="table table-sm grid" style="width: auto"><tbody>' +
    (tx.operation ? `<tr><th>Operation</th><td><code>${escape(tx.operation)}</code></td></tr>` : '') +
    (tx.description ? `<tr><th>What it tests</th><td>${escape(tx.description)}</td></tr>` : '') +
    (tx.httpCode ? `<tr><th>Expected status</th><td>${escape(tx.httpCode)}</td></tr>` : '') + '</tbody></table>';
  html += '<p><small>The validator made the request and compared the answer with the expected one; the request and the expected response are the test\'s, from the test package. ' +
    'In the expected response, <code>$...$</code> are patterns (any id, any instant, a message as tx.fhir.org words it...). Content is cut at 64 KB.</small></p>';
  if (tx.request) {
    html += `<h5 style="font-size: 100%">The request</h5><pre style="${PRE}">${escape(tx.request)}</pre>`;
  }
  if (tx.expected) {
    html += `<h5 style="font-size: 100%">The expected response</h5><pre style="${PRE}">${escape(tx.expected)}</pre>`;
  }
  if (tx.actual) {
    html += `<h5 style="font-size: 100%">What the server answered</h5><pre style="${PRE}">${escape(tx.actual)}</pre>`;
  } else if (outcome === 'fail') {
    html += '<p><i>The validator didn\'t keep what the server answered (the request may not have got an answer: see the message).</i></p>';
  }
  return html;
}

/**
 * A test's page: its outcome, the resources it made to test with, and every request and response
 * @param {Object} o - { base, run, result, detailDays }
 */
function renderTest(o) {
  const r = o.result;
  const runLink = `${escape(o.base)}/runs/${escape(o.run.Id)}`;
  let html = `<p><a href="${runLink}">&larr; the run of ${o.run.Kind === 'npm' ? 'the npm registry ' : o.run.Kind === 'tx' ? 'the terminology server ' : ''}<code>${escape(o.run.Server)}</code></a></p>`;
  html += '<table class="table table-sm grid" style="width: auto"><tbody>' +
    `<tr><th>Group</th><td>${escape(r.GroupName)}</td></tr>` +
    `<tr><th>Outcome</th><td>${badge(r.Outcome, BADGES[r.Outcome] || '#495057')}</td></tr>` +
    (r.Message ? `<tr><th>${r.Outcome === 'skip' ? 'Why not' : 'Message'}</th><td style="white-space: pre-wrap">${escape(r.Message)}</td></tr>` : '') +
    (o.run.Kind === 'npm' ? '' : `<tr><th>Took</th><td>${Number(r.Ms) || 0} ms</td></tr>`) + '</tbody></table>';
  if (r.Resources.length) {
    html += `<h4>What the test made to test with</h4><p><small>Each resource as the server had it once it was made (the requests are below, as setup).</small></p>`;
    for (const x of r.Resources) {
      html += `<details><summary><code>${escape(x.type)}/${escape(x.id)}</code></summary><pre style="${PRE}">${escape(JSON.stringify(x.resource, null, 2))}</pre></details>`;
    }
  }
  const txDetail = r.Exchanges.find(x => x && x.tx);
  if (o.run.DetailsCleared) {
    html += '<p><i>The requests and responses, and the resources the test made, are no longer kept: ' +
      `a run's step details are cleared ${Number(o.detailDays) || 30} days after it.</i></p>`;
  } else if (txDetail) {
    html += txDetailHtml(txDetail.tx, r.Outcome);
  } else if (r.Exchanges.length) {
    const setup = r.Exchanges.filter(x => x.phase === 'setup').length;
    html += `<h4 class="mt-3">Requests and responses</h4><p><small>${r.Exchanges.length} request${r.Exchanges.length === 1 ? '' : 's'}` +
      `${setup ? `, ${setup} of them setup` : ''}${o.run.Kind === 'npm' ? ': those the check is based on (the requests are made first, then every check is made)' : ', in order'}. ` +
      'The bearer token isn\'t shown; bodies are cut at 64 KB.</small></p>';
    r.Exchanges.forEach((x, i) => {
      html += exchangeHtml(x, i + 1);
    });
  } else if (r.Outcome !== 'skip') {
    html += '<p><i>No requests.</i></p>';
  }
  return html;
}

/**
 * A run's page
 * @param {Object} o - { base, run, results, place (in the queue), canCancel, csrf, control, controlReport (npm runs) }
 */
function renderRun(o) {
  const r = o.run;
  const npm = r.Kind === 'npm';
  const going = ['queued', 'running'].includes(r.Status);
  let html = going ? '<meta http-equiv="refresh" content="5"/>' : '';
  html += '<table class="table table-sm grid" style="width: auto"><tbody>' +
    `<tr><th>${npm ? 'npm registry' : r.Kind === 'tx' ? 'Terminology server' : 'Server'}</th><td><code>${escape(r.Server)}</code></td></tr>` +
    (npm ? `<tr><th>Package</th><td><code>${escape(r.Package || '')}#${escape(r.Version || '')}</code></td></tr>` : '') +
    (r.Kind === 'tx' ? `<tr><th>Modes</th><td>${escape(modesOf(r).join(', '))}</td></tr>` : '') +
    (r.Software || r.FhirVersion ? `<tr><th>Software</th><td>${escape(r.Software || '')}${r.FhirVersion ? ` (FHIR ${escape(r.FhirVersion)})` : ''}</td></tr>` : '') +
    `<tr><th>Asked for</th><td>${when(r.Requested)}${r.UserName ? ' by ' + escape(r.UserName) : ''}</td></tr>` +
    `<tr><th>Status</th><td>${badge(r.Status, STATUS_BADGES[r.Status] || '#495057')}` +
    (r.Status === 'queued' && o.place ? ` (number ${o.place} in the queue)` : '') +
    (r.Status === 'running' && r.Progress ? ` ${escape(r.Progress)}` : '') +
    (r.CancelAsked && going ? ' (cancelling)' : '') + '</td></tr>' +
    (r.Started ? `<tr><th>Ran</th><td>${when(r.Started)}${r.Finished ? `, for ${duration(r.Started, r.Finished)}` : ''}</td></tr>` : '') +
    (r.Message ? `<tr><th>Note</th><td>${escape(r.Message)}</td></tr>` : '') +
    `<tr><th>Results</th><td>${counts(r) || '<i>none yet</i>'}</td></tr>`;
  if (r.Cleanup) {
    const c = JSON.parse(r.Cleanup);
    html += `<tr><th>Cleaning up</th><td>${c.created} made, ${c.deleted} deleted${c.expunged ? `, ${c.expunged} expunged` : ''}` +
      (c.left && c.left.length ? `; left on the server: ${c.left.slice(0, 20).map(x => `<code>${escape(x)}</code>`).join(', ')}${c.left.length > 20 ? ` and ${c.left.length - 20} more` : ''}` : '') + '</td></tr>';
  }
  if (r.Report) {
    html += `<tr><th>Report</th><td><a href="${escape(o.base)}/runs/${escape(r.Id)}/report">TestReport (JSON)</a>` +
      (r.Uploaded ? ` - sent to the repository${/^https?:/.test(r.Uploaded) ? `: <a href="${escape(r.Uploaded)}">${escape(r.Uploaded)}</a>` : ''}` : '') +
      (r.UploadError ? ` - <span class="text-danger">not sent: ${escape(r.UploadError)}</span>` : '') + '</td></tr>';
  }
  html += '</tbody></table>';
  if (npm) {
    html += controlSummary(o.control, o.controlReport);
  }
  if (o.canCancel && going && !r.CancelAsked) {
    html += `<form method="post" action="${escape(o.base)}/runs/${escape(r.Id)}/cancel"><input type="hidden" name="_csrf" value="${escape(o.csrf || '')}"/>` +
      '<button type="submit" class="btn btn-secondary btn-sm">Cancel the run</button></form>';
  }
  if (!o.results.length) {
    return html;
  }
  let group = null;
  html += '<table class="table table-sm grid mt-3"><tbody>';
  for (const x of o.results) {
    if (x.GroupName !== group) {
      group = x.GroupName;
      html += `<tr><th colspan="3"><h4 class="mt-2">${escape(group)}</h4></th></tr>`;
    }
    html += `<tr><td>${badge(x.Outcome, BADGES[x.Outcome] || '#495057')}</td>` +
      `<td><a href="${escape(o.base)}/runs/${escape(r.Id)}/tests/${Number(x.Seq)}">${escape(x.Name)}</a>` +
      (x.Message ? `<br/><small style="white-space: pre-wrap">${escape(x.Message)}</small>` : '') +
      `</td><td>${npm ? '' : `<small>${Number(x.Ms) || 0} ms</small>`}</td></tr>`;
  }
  html += '</tbody></table>';
  return html;
}

module.exports = { renderHome, renderRun, renderTest, controlSummary };
