//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The endpoint's administration pages (the manage role), at [base]/_admin/...
 *
 *   [base]/_admin/valuesets   value sets registered for searching by membership (:in and
 *                             :not-in on value sets too big to expand, or not closed)
 *   [base]/_admin/packages    packages loaded into the endpoint (rest/packages.js)
 *
 * Pages for a browser: a form post is checked for its origin and CSRF token (library/auth),
 * and answered with a redirect back to the page.
 *
 * @module rest/admin
 */

const express = require('express');
const escape = require('escape-html');
const auth = require('../library/auth');
const access = require('./access');
const { FhirError, badRequest } = require('./library/errors');
const { PackageLoader, STATUS_NAMES, QUEUED, RUNNING } = require('./packages');

const VALUESETS = '/_admin/valuesets';
const PACKAGES = '/_admin/packages';

class RestAdmin {
  /**
   * @param {Object} ep - the Endpoint
   */
  constructor(ep) {
    this.ep = ep;
  }

  /** The routes, for the endpoint's router (before the FHIR API's) */
  router() {
    const r = express.Router();
    r.get(VALUESETS, ...auth.web, (req, res) => this.run(req, res, () => this.valueSets(req, res)));
    r.post(VALUESETS, auth.sameOrigin, auth.session, auth.form, auth.csrf, (req, res) => this.run(req, res, () => this.valueSetAction(req, res)));
    r.get(PACKAGES, ...auth.web, (req, res) => this.run(req, res, () => this.packages(req, res)));
    r.post(PACKAGES, auth.sameOrigin, auth.session, auth.form, auth.csrf, (req, res) => this.run(req, res, () => this.packageAction(req, res)));
    return r;
  }

  async run(req, res, fn) {
    const start = Date.now();
    try {
      const principal = this.ep.options.principal ? await this.ep.options.principal(req) : null;
      access.check(principal, this.ep, 'manage');
      req.restPrincipal = principal;
      await fn(start);
    } catch (e) {
      if (!(e instanceof FhirError)) {
        this.ep.log.error(`Rest ${this.ep.path}: ${req.method} ${req.originalUrl} failed: ${e.stack || e.message}`);
      }
      const fe = e instanceof FhirError ? e : new FhirError(500, 'exception', 'Internal error');
      this.ep.web.error(req, res, fe, start);
    }
  }

  csrfField(res) {
    return `<input type="hidden" name="_csrf" value="${escape((res.locals && res.locals._csrf) || '')}"/>`;
  }

  // ---- value sets registered for searching ----

  async valueSets(req, res) {
    const start = Date.now();
    const ep = this.ep;
    const page = `${req.baseUrl}${VALUESETS}`;
    const { sets, concepts, counts } = await ep.db.read(async (q) => ({
      sets: await q.all('SELECT ValueSetKey, Url, Version, Systems, Status, Registered, RegisteredBy FROM ValueSets ORDER BY Url'),
      concepts: Number((await q.get('SELECT COUNT(*) AS N FROM Concepts')).N),
      counts: await q.all('SELECT ValueSetKey, COUNT(*) AS N, SUM(Member) AS M FROM ValueSetMembers GROUP BY ValueSetKey')
    }));
    const byKey = new Map(counts.map(c => [Number(c.ValueSetKey), { checked: Number(c.N), members: Number(c.M || 0) }]));
    let html = '<p>A search with <code>:in</code> or <code>:not-in</code> expands the value set, which works for value sets of up to ' +
      `${Number(ep.settings.maxValueSetExpansion || 10000).toLocaleString('en-US')} codes (the <code>maxValueSetExpansion</code> setting) that are closed. ` +
      'A value set registered here is searched another way, whatever its size: the server asks the terminology server, in the background, ' +
      'which of the codes in the endpoint\'s resources are in it, and searches by that. A search ignores the version it asks for; ' +
      'the version registered is the one used.</p>';
    if (!ep.terminology) {
      html += '<p><b>This endpoint has no terminology server (the <code>txServer</code> setting): nothing registered here can be worked out.</b></p>';
    }
    if (sets.length) {
      html += '<table class="table table-sm grid"><thead><tr><th>Value set</th><th>Version</th><th>Status</th><th style="text-align: right">Members</th><th>Code systems</th><th></th></tr></thead><tbody>';
      for (const s of sets) {
        const c = byKey.get(Number(s.ValueSetKey)) || { checked: 0, members: 0 };
        const status = Number(s.Status) ? 'ready' : `being worked out: ${Math.min(c.checked, concepts).toLocaleString('en-US')} of ${concepts.toLocaleString('en-US')} codes checked`;
        const systems = s.Systems === null ? '<i>not looked at yet</i>' : s.Systems === '*' ? '<i>unknown: every code is asked about</i>'
          : JSON.parse(s.Systems).map(x => `<code>${escape(x)}</code>`).join('<br/>');
        const form = (action, label, confirm) => `<form method="post" action="${escape(page)}" style="display: inline"${confirm ? ` onsubmit="return confirm('${escape(confirm)}')"` : ''}>` +
          `${this.csrfField(res)}<input type="hidden" name="action" value="${action}"/><input type="hidden" name="key" value="${Number(s.ValueSetKey)}"/>` +
          `<button type="submit" class="btn btn-sm btn-secondary">${label}</button></form>`;
        html += `<tr><td><code>${escape(s.Url)}</code><br/><small>registered ${escape(new Date(Number(s.Registered)).toISOString().substring(0, 16).replace('T', ' '))}` +
          `${s.RegisteredBy ? ' by ' + escape(s.RegisteredBy) : ''}</small></td>` +
          `<td>${s.Version ? escape(s.Version) : '<i>the server\'s</i>'}</td><td>${status}</td><td style="text-align: right">${c.members.toLocaleString('en-US')}</td>` +
          `<td><small>${systems}</small></td>` +
          `<td>${form('rebuild', 'Work out again')} ${form('remove', 'Remove', 'Stop searching by membership in this value set?')}</td></tr>`;
      }
      html += '</tbody></table>';
    } else {
      html += '<p>No value sets are registered.</p>';
    }

    // registering one: find its versions first
    html += '<h3>Register a value set</h3>';
    const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    html += `<form method="get" action="${escape(page)}"><label for="vs-url">Value set URL</label> ` +
      `<input type="text" id="vs-url" name="url" size="80" value="${escape(url)}"/> <button type="submit" class="btn btn-sm btn-secondary">Find its versions</button></form>`;
    if (url) {
      const existing = sets.find(s => s.Url === url);
      const versions = ep.terminology ? await ep.terminology.versions(url) : null;
      html += `<form method="post" action="${escape(page)}" style="margin-top: 10px">${this.csrfField(res)}` +
        `<input type="hidden" name="action" value="register"/><input type="hidden" name="url" value="${escape(url)}"/>`;
      if (existing) {
        html += `<p>This value set is registered${existing.Version ? ' (version ' + escape(existing.Version) + ')' : ''}: registering it again works its members out again.</p>`;
      }
      if (versions === null) {
        html += '<p>The terminology server couldn\'t be asked which versions it has.</p>';
      } else if (!versions.length) {
        html += '<p>The terminology server has no value set with this URL to look at (an implicit value set, such as SNOMED CT\'s <code>?fhir_vs=</code>, ' +
          'can still be registered, if the server can check codes against it).</p>';
      }
      html += '<p>Version:</p><ul style="list-style: none">';
      html += '<li><label><input type="radio" name="version" value="" checked/> whatever version the terminology server has</label></li>';
      for (const v of versions || []) {
        html += `<li><label><input type="radio" name="version" value="${escape(v)}"/> ${escape(v)}</label></li>`;
      }
      html += '</ul><p><button type="submit" class="btn btn-primary">Register</button></p></form>';
    }
    return ep.web.send(req, res, 200, 'Value sets for searching', html, start);
  }

  async valueSetAction(req, res) {
    const ep = this.ep;
    const body = req.body || {};
    const action = String(body.action || '');
    const principal = req.restPrincipal;
    const reset = async (q, key) => {
      await q.run('DELETE FROM ValueSetMembers WHERE ValueSetKey = ?', [key]);
      await q.run('UPDATE ValueSets SET Systems = NULL, Status = 0 WHERE ValueSetKey = ?', [key]);
    };
    if (action === 'register') {
      const url = String(body.url || '').trim();
      const version = String(body.version || '').trim() || null;
      if (!url || url.length > 255 || /\s/.test(url)) {
        throw badRequest('A value set URL (with no spaces, at most 255 characters) is needed');
      }
      if (version && version.length > 64) {
        throw badRequest('The version is too long');
      }
      const by = principal ? String(principal.login || principal.name || principal.id).substring(0, 128) : null;
      await ep.db.write(async (q) => {
        const row = await q.get('SELECT ValueSetKey FROM ValueSets WHERE Url = ?' + q.dialect.forUpdate, [url]);
        if (row) {
          await reset(q, Number(row.ValueSetKey));
          await q.run('UPDATE ValueSets SET Version = ?, Registered = ?, RegisteredBy = ? WHERE ValueSetKey = ?', [version, Date.now(), by, Number(row.ValueSetKey)]);
        } else {
          await q.run('INSERT INTO ValueSets (Url, Version, Systems, Status, Registered, RegisteredBy) VALUES (?, ?, NULL, 0, ?, ?)', [url, version, Date.now(), by]);
        }
      });
      ep.log.info(`Rest ${ep.path}: value set ${url}${version ? '|' + version : ''} registered for searching${by ? ' by ' + by : ''}`);
    } else if (action === 'rebuild' || action === 'remove') {
      const key = Number(body.key);
      if (!Number.isInteger(key)) {
        throw badRequest('Which value set?');
      }
      await ep.db.write(async (q) => {
        if (action === 'rebuild') {
          await reset(q, key);
        } else {
          await q.run('DELETE FROM ValueSetMembers WHERE ValueSetKey = ?', [key]);
          await q.run('DELETE FROM ValueSets WHERE ValueSetKey = ?', [key]);
        }
      });
      ep.log.info(`Rest ${ep.path}: value set ${key} ${action === 'rebuild' ? 'to be worked out again' : 'removed from searching'}`);
    } else {
      throw badRequest(`Unknown action '${action}'`);
    }
    res.redirect(303, `${req.baseUrl}${VALUESETS}`);
  }

  // ---- packages loaded into the endpoint ----

  async packages(req, res) {
    const start = Date.now();
    const ep = this.ep;
    const page = `${req.baseUrl}${PACKAGES}`;
    const when = (t) => t ? escape(new Date(Number(t)).toISOString().substring(0, 19).replace('T', ' ')) : '';
    if (req.query.load) {
      return this.packageReport(req, res, page, when, start);
    }
    const loads = await ep.db.read(q => q.all('SELECT LoadKey, Package, Version, Examples, Status, Requested, RequestedBy, Started, Finished, Message FROM PackageLoads ORDER BY LoadKey DESC'));
    let html = '';
    if (loads.some(l => Number(l.Status) === QUEUED || Number(l.Status) === RUNNING)) {
      // while something is to do, the page keeps itself up to date
      html += '<meta http-equiv="refresh" content="5"/>';
    }
    html += '<p>A package\'s resources are loaded into the endpoint, each to its Type/id. Where a different resource has that id already, ' +
      'it gets a new id, and the package\'s references to it are changed to match; one the same as what\'s there is left alone, so loading a package again ' +
      'changes nothing. Packages are loaded one at a time, in the background; references aren\'t checked. Loading is meant for when the endpoint isn\'t in use.</p>';
    html += '<h3>Load a package</h3>';
    html += `<form method="post" action="${escape(page)}">${this.csrfField(res)}<input type="hidden" name="action" value="load"/>` +
      '<label for="pkg-id">Package</label> <input type="text" id="pkg-id" name="package" size="40" placeholder="hl7.fhir.us.core"/> ' +
      '<label for="pkg-version">Version</label> <input type="text" id="pkg-version" name="version" size="12" placeholder="the latest"/> ' +
      '<label><input type="checkbox" name="examples" value="1"/> with its examples</label> ' +
      '<button type="submit" class="btn btn-primary btn-sm">Load</button></form>';
    html += '<h3>Loads</h3>';
    if (!loads.length) {
      html += '<p>No packages have been loaded.</p>';
    } else {
      html += '<table class="table table-sm grid"><thead><tr><th>Package</th><th>Asked for</th><th>Status</th><th>Result</th><th></th></tr></thead><tbody>';
      for (const l of loads) {
        const status = Number(l.Status);
        const name = `${escape(l.Package)}${l.Version ? '#' + escape(l.Version) : ''}${Number(l.Examples) ? ' <small>(with examples)</small>' : ''}`;
        const took = l.Started && l.Finished ? ` <small>(${((Number(l.Finished) - Number(l.Started)) / 1000).toFixed(1)}s)</small>` : '';
        const action = status === QUEUED
          ? `<form method="post" action="${escape(page)}" style="display: inline">${this.csrfField(res)}<input type="hidden" name="action" value="cancel"/>` +
            `<input type="hidden" name="key" value="${Number(l.LoadKey)}"/><button type="submit" class="btn btn-sm btn-secondary">Cancel</button></form>`
          : status > RUNNING ? `<a href="${escape(page)}?load=${Number(l.LoadKey)}">Details</a>` : '';
        html += `<tr><td>${name}</td><td>${when(l.Requested)}${l.RequestedBy ? '<br/><small>by ' + escape(l.RequestedBy) + '</small>' : ''}</td>` +
          `<td>${STATUS_NAMES[status] || status}${took}</td><td>${escape(l.Message || '')}</td><td>${action}</td></tr>`;
      }
      html += '</tbody></table>';
    }
    return ep.web.send(req, res, 200, 'Packages', html, start);
  }

  async packageReport(req, res, page, when, start) {
    const ep = this.ep;
    const row = await ep.db.read(q => q.get('SELECT * FROM PackageLoads WHERE LoadKey = ?', [Number(req.query.load) || 0]));
    if (!row) {
      throw new FhirError(404, 'not-found', 'No such package load');
    }
    let report = null;
    try {
      report = row.Report ? JSON.parse(row.Report) : null;
    } catch (e) {
      report = null;
    }
    let html = `<p><a href="${escape(page)}">All loads</a></p>`;
    html += `<p><b>${escape(row.Package)}${row.Version ? '#' + escape(row.Version) : ''}</b>: ${STATUS_NAMES[Number(row.Status)]}, ` +
      `${when(row.Started)} to ${when(row.Finished)}. ${escape(row.Message || '')}</p>`;
    if (report) {
      const types = Object.entries(report.skippedTypes || {});
      if (types.length) {
        html += '<h3>Skipped</h3><p>Of types this endpoint doesn\'t have: ' + types.map(([t, n]) => `${escape(t)} (${n})`).join(', ') + '</p>';
      }
      if (report.renamed && report.renamed.length) {
        html += `<h3>Given new ids (${report.counts.renamed})</h3><p>A different resource had the id already.</p><table class="table table-sm grid"><thead><tr><th>In the package</th><th>Stored as</th></tr></thead><tbody>`;
        for (const r of report.renamed) {
          html += `<tr><td>${escape(r.from)}</td><td><a href="${escape(req.baseUrl + '/' + r.to)}">${escape(r.to)}</a></td></tr>`;
        }
        html += '</tbody></table>';
      }
      if (report.errors && report.errors.length) {
        html += `<h3>Failed (${report.counts.failed})</h3><table class="table table-sm grid"><thead><tr><th>File</th><th>Why</th></tr></thead><tbody>`;
        for (const e of report.errors) {
          html += `<tr><td>${escape(e.file)}</td><td>${escape(e.message)}</td></tr>`;
        }
        html += '</tbody></table>';
      }
    }
    return ep.web.send(req, res, 200, `Package ${row.Package}`, html, start);
  }

  async packageAction(req, res) {
    const ep = this.ep;
    const body = req.body || {};
    const action = String(body.action || '');
    const principal = req.restPrincipal;
    if (action === 'load') {
      let p;
      try {
        p = PackageLoader.parse({ package: body.package, version: body.version, examples: body.examples === '1' });
      } catch (e) {
        throw badRequest(e.message);
      }
      const by = principal ? String(principal.login || principal.name || principal.id) : null;
      await ep.db.write(q => PackageLoader.queue(q, p, by));
      ep.log.info(`Rest ${ep.path}: package ${p.package}${p.version ? '#' + p.version : ''} queued to load${by ? ' by ' + by : ''}`);
    } else if (action === 'cancel') {
      const key = Number(body.key);
      if (!Number.isInteger(key)) {
        throw badRequest('Which load?');
      }
      await ep.db.write(q => q.run('DELETE FROM PackageLoads WHERE LoadKey = ? AND Status = ?', [key, QUEUED]));
    } else {
      throw badRequest(`Unknown action '${action}'`);
    }
    res.redirect(303, `${req.baseUrl}${PACKAGES}`);
  }
}

module.exports = { RestAdmin, VALUESETS, PACKAGES };
