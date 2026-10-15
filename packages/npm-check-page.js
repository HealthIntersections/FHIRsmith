//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// HTML for /packages/npm-check: the form, and the report of a run (see npm-check.js)

const escape = require('escape-html');

const PASS = '<span style="color: #198754; font-weight: bold">&#10003;</span>';
const FAIL = '<span style="color: #dc3545; font-weight: bold">&#10007;</span>';

function when(iso) {
  return escape(new Date(iso).toUTCString());
}

function form(values) {
  let html = '<form method="get" action="/packages/npm-check" class="mb-4">';
  html += '<table class="grid">';
  html += `<tr><td><label for="registry">Registry URL</label></td><td><input type="url" id="registry" name="registry" size="60" required maxlength="500" placeholder="https://registry.example.org/packages" value="${escape(values.registry || '')}"></td></tr>`;
  html += `<tr><td><label for="package">Package</label></td><td><input type="text" id="package" name="package" size="40" required maxlength="100" value="${escape(values.package || 'hl7.fhir.r4.core')}"></td></tr>`;
  html += `<tr><td><label for="version">Version</label></td><td><input type="text" id="version" name="version" size="20" required maxlength="50" value="${escape(values.version || '4.0.1')}"></td></tr>`;
  html += '</table>';
  html += '<p class="mt-2"><button type="submit" class="btn btn-primary">Run the checks</button> ';
  html += '<small>A run makes about ten requests to the registry, including downloading the package\'s tarball, and can take up to a minute.</small></p>';
  html += '</form>';
  return html;
}

function controlSummary(control, controlReport) {
  if (!control) {
    return '';
  }
  const what = `${escape(control.registry)} (${escape(control.pkg)} ${escape(control.version)})`;
  if (!controlReport) {
    return `<p><small>The checks are verified daily against the npm registry itself, ${what}. That hasn't run yet; reload this page in a minute to see it.</small></p>`;
  }
  const total = controlReport.passed + controlReport.failed;
  if (controlReport.failed === 0) {
    return `<p><small>${PASS} The checks are verified daily against the npm registry itself: all ${total} passed against ${what} on ${when(controlReport.finished)}.</small></p>`;
  }
  let html = `<div class="alert alert-warning"><p>${FAIL} The checks are verified daily against the npm registry itself, and on ${when(controlReport.finished)} ${controlReport.failed} of ${total} failed against ${what}. The npm registry is the reference, so those checks may be out of date - treat their results below with caution:</p><ul>`;
  for (const step of controlReport.steps) {
    for (const c of step.checks.filter(x => x.status === 'fail')) {
      html += `<li>${escape(step.title)}: ${escape(c.title)} - ${escape(c.message)}</li>`;
    }
  }
  return html + '</ul></div>';
}

function intro() {
  let html = '<p>Checks a registry against the npm registry protocol, the way an npm client uses it: search for a package by name, ';
  html += 'read its package document, read one version\'s document, and download that version\'s tarball. ';
  html += 'At each step it checks the parts of the response that npm clients depend on. ';
  html += 'Give the registry\'s base URL (the one you would pass to <code>npm --registry</code>) and a package version it holds.</p>';
  return html;
}

function renderForm({ values = {}, control, controlReport }) {
  return intro() + form(values) + controlSummary(control, controlReport);
}

function renderReport({ report, control, controlReport }) {
  const total = report.passed + report.failed;
  let html = '';
  html += `<p><strong>Registry:</strong> ${escape(report.registry)}<br>`;
  html += `<strong>Package:</strong> ${escape(report.package)} ${escape(report.version)}<br>`;
  html += `<strong>Run:</strong> ${when(report.started)}</p>`;
  if (report.failed === 0) {
    html += `<div class="alert alert-success">${PASS} All ${total} checks passed.</div>`;
  } else {
    html += `<div class="alert alert-danger">${FAIL} ${report.failed} of ${total} checks failed.</div>`;
  }
  html += controlSummary(control, controlReport);

  for (const step of report.steps) {
    html += `<h4 class="mt-4">${escape(step.title)}: <code>${escape(step.request)}</code></h4>`;
    html += '<table class="grid">';
    for (const c of step.checks) {
      html += `<tr><td>${c.status === 'pass' ? PASS : FAIL}</td><td>${escape(c.title)}`;
      if (c.status !== 'pass') {
        html += `<br><span style="color: #dc3545">${escape(c.message)}</span>`;
        const urls = [...new Set(c.uses.map(u => report.requests[u]?.url).filter(Boolean))];
        if (urls.length > 0) {
          html += `<br><small>${urls.map(escape).join('<br>')}</small>`;
        }
      }
      html += '</td></tr>';
    }
    html += '</table>';
  }

  html += '<h4 class="mt-4">Requests</h4>';
  html += '<table class="grid"><tr><td><b>URL</b></td><td><b>Result</b></td></tr>';
  for (const r of Object.values(report.requests)) {
    const result = r.error ? `<span style="color: #dc3545">${escape(r.error)}</span>`
      : `${escape(String(r.status))} ${escape(r.contentType || '')} (${escape(String(r.bytes))} bytes)`;
    html += `<tr><td><small>${escape(r.url)}</small></td><td><small>${result}</small></td></tr>`;
  }
  html += '</table>';

  html += '<h4 class="mt-4">Check again</h4>';
  html += form({ registry: report.registry, package: report.package, version: report.version });
  return html;
}

module.exports = { renderForm, renderReport };
