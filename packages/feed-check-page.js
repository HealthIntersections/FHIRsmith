//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// HTML for /packages/feed-check: the form, and a run's report (see feed-check.js)

const escape = require('escape-html');

function form(values = {}) {
  let html = '<form method="get" action="/packages/feed-check" class="mb-4">';
  html += '<p><label for="url">Package feed URL</label> ';
  html += `<input type="url" id="url" name="url" size="70" required maxlength="500" placeholder="https://example.org/fhir/package-feed.xml" value="${escape(values.url || '')}"> `;
  html += '<button type="submit" class="btn btn-primary">Check the feed</button></p>';
  html += '<p><label for="signing">Signing keys (optional)</label><br>';
  html += '<textarea id="signing" name="signing" rows="6" cols="90" maxlength="5000" aria-describedby="signing-help" ' +
    'placeholder=\'{"required": false, "keys": [{"keyid": "SHA256:...", "key": "MFkw...", "expires": null}]}\'>' +
    `${escape(values.signing || '')}</textarea><br>`;
  html += '<small id="signing-help">The feed\'s <code>signing</code> block as JSON, as it would be in package-feeds.json (or the feed\'s whole entry). ' +
    'Signatures are checked against these keys instead of the ones the registry lists for the feed - so a feed can be tested before its keys are registered.</small></p>';
  html += '<p><small>Reads the feed the way this registry\'s crawler does - each item, its package and its signature - ' +
    'and reports what it finds. Nothing is stored. Packages are downloaded, so a large feed takes a while; ' +
    'the check stops after a set number of items.</small></p>';
  html += '</form>';
  return html;
}

function renderForm(values) {
  return form(values);
}

const SIGNATURE = {
  confirmed: '<span class="text-success">confirmed</span>',
  rejected: '<span class="text-danger">rejected</span>',
  unfetchable: '<span class="text-danger">couldn\'t be fetched</span>',
  unchecked: 'not checked',
  absent: '<span class="text-muted">absent</span>'
};

function item(r) {
  let html = '<tr>';
  const status = r.status === 'ok' ? '<span class="text-success">ok</span>'
    : r.status === 'error' ? '<span class="text-danger">error</span>' : '<span class="text-muted">skipped</span>';
  html += `<td>${status}</td>`;
  html += `<td>${r.link ? `<a href="${escape(r.link)}">${escape(r.title || '(no title)')}</a>` : escape(r.title || '(no title)')}</td>`;
  html += `<td>${r.package ? escape(r.package.fhirVersions || '') : ''}</td>`;
  html += `<td>${r.date ? escape(r.date.substring(0, 10)) : ''}</td>`;
  html += `<td>${r.package ? r.package.sizeKB.toLocaleString() + ' KB' : ''}</td>`;
  if (r.signature) {
    const label = SIGNATURE[r.signature.state] || escape(r.signature.state);
    html += `<td>${r.signature.url ? `<a href="${escape(r.signature.url)}">${label}</a>` : label}` +
      (r.signature.detail && r.signature.state !== 'absent' ? `<br><small>${escape(r.signature.detail)}</small>` : '') + '</td>';
  } else {
    html += '<td></td>';
  }
  html += `<td>${escape(r.held || '')}</td>`;
  const notes = [...r.problems.map(p => `<li class="text-danger">${escape(p)}</li>`),
    ...r.warnings.map(w => `<li>${escape(w)}</li>`),
    ...(r.skipped ? [`<li>${escape(r.skipped)}</li>`] : [])];
  html += `<td>${notes.length ? `<ul class="mb-0">${notes.join('')}</ul>` : ''}</td>`;
  html += '</tr>';
  return html;
}

// job: {id, url, state (running, done, failed), report, error}
function renderJob(job) {
  const r = job.report;
  let html = `<p>Feed: <a href="${escape(job.url)}">${escape(job.url)}</a></p>`;
  if (job.state === 'running') {
    html += `<div class="alert alert-info" role="status">Checking... ${r ? r.items.length : 0} item(s) so far. ` +
      `This page reloads every few seconds until the check finishes (<a href="/packages/feed-check/${escape(job.id)}">reload now</a>).</div>`;
  } else if (job.state === 'failed') {
    html += `<div class="alert alert-danger">The check failed: ${escape(job.error || 'unknown error')}</div>`;
  }
  if (r) {
    if (r.registered) {
      html += `<p>In the registry's feed list as <strong>${escape(r.registered.name || '(no name)')}</strong>.`;
      html += r.signing && r.signingSource === 'registry' ? ` Signing keys: ${r.signing.keys.map(k => `<code>${escape(k)}</code>`).join(', ')}${r.signing.required ? ' (signatures required)' : ''}.`
        : r.signingSource === 'given' ? '' : ' It lists no signing keys.';
      html += '</p>';
    }
    if (r.signingSource === 'given') {
      html += `<p>Signatures checked against the keys given with the check: ${r.signing.keys.map(k => `<code>${escape(k)}</code>`).join(', ')}${r.signing.required ? ' (signatures required)' : ''}.</p>`;
    }
    for (const n of r.notes) {
      html += `<div class="alert alert-warning">${escape(n)}</div>`;
    }
    for (const e of r.errors) {
      html += `<div class="alert alert-danger">${escape(e)}</div>`;
    }
    if (job.state !== 'running') {
      const counts = { ok: 0, error: 0, skipped: 0 };
      r.items.forEach(i => counts[i.status]++);
      const sigs = {};
      r.items.forEach(i => {
        if (i.signature) {
          sigs[i.signature.state] = (sigs[i.signature.state] || 0) + 1;
        }
      });
      html += `<p><strong>${r.items.length}</strong> item(s) on ${r.pages.length} page(s): ${counts.ok} ok, ${counts.error} with errors, ${counts.skipped} skipped. ` +
        `Signatures: ${Object.entries(sigs).map(([k, v]) => `${v} ${escape(k)}`).join(', ') || 'none'}. ` +
        `${r.downloadedMB} MB downloaded.${r.truncated ? ' <strong>The check stopped at its item limit; the feed has more.</strong>' : ''}</p>`;
    }
    if (r.items.length > 0) {
      html += '<div class="table-responsive"><table class="table table-striped">';
      html += '<thead><tr><th>Status</th><th>Package</th><th>FHIR version</th><th>Published</th><th>Size</th><th>Signature</th><th>Held here</th><th>Notes</th></tr></thead><tbody>';
      html += r.items.map(item).join('');
      html += '</tbody></table></div>';
    }
  }
  html += '<h3 class="mt-4">Check another feed</h3>';
  html += form({});
  return html;
}

module.exports = { renderForm, renderJob };
