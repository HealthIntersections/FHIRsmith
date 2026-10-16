const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const htmlServer = require('../library/html-server');
const escape = require('escape-html');
const packageJson = require('../package.json');
const { tokenMatches, tokenConfigured } = require('../library/request-token');

const TEMPLATE_NAME = 'ext-tracker';

// What the IG Publisher submits (ExtensionTracker.generate() in the publisher): anything
// that doesn't look like that is refused, which keeps what anyone can put in the database
// (and so in these pages) to the shapes the pages expect
const CODE = /^[A-Za-z0-9._-]{1,100}$/;
const VERSION = /^[A-Za-z0-9._+-]{1,50}$/;
const FHIR_VERSION = /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/;
const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s"'<>\\]{1,1000}$/;
const RESOURCE_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
// an element path, e.g. Patient.name or ImplementationGuide.definition.page (a logical
// model's type can be a URL)
const PATH = /^[A-Za-z][\w.:/#%[\]-]{0,511}$/;
const TYPE_CODE = /^[^\s"'<>\\]{1,256}$/;
const MAX_TITLE = 1024;
const MAX_ITEMS = 20000;

/**
 * Checks that a submission looks like what the IG Publisher sends.
 *
 * @returns {string[]} what is wrong (empty if nothing)
 */
function validateSubmission(data) {
  const errors = [];
  const check = (ok, message) => {
    if (!ok && errors.length < 10) {
      errors.push(message);
    }
  };
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v, re) => typeof v === 'string' && re.test(v);
  const optionalTitle = (v) => v === undefined || v === null || (typeof v === 'string' && v.length <= MAX_TITLE);
  const onlyKeys = (obj, keys, where) => {
    for (const k of Object.keys(obj)) {
      check(keys.includes(k), `${where}: unexpected property ${JSON.stringify(k.substring(0, 50))}`);
    }
  };

  if (!isObject(data)) {
    return ['the submission must be a JSON object'];
  }
  onlyKeys(data, ['package', 'version', 'fhirVersion', 'jurisdiction', 'extensions', 'profiles', 'usage'], 'submission');
  check(str(data.package, CODE), 'package must be a package id');
  check(str(data.version, VERSION), 'version must be a version');
  check(str(data.fhirVersion, FHIR_VERSION), 'fhirVersion must be a FHIR version (e.g. 4.0.1)');
  check(data.jurisdiction === undefined || data.jurisdiction === null || str(data.jurisdiction, CODE), 'jurisdiction must be a code');

  let items = 0;
  if (data.extensions !== undefined) {
    check(Array.isArray(data.extensions), 'extensions must be an array');
    for (const [i, ext] of (Array.isArray(data.extensions) ? data.extensions : []).entries()) {
      items++;
      if (!isObject(ext)) {
        check(false, `extensions[${i}] must be an object`);
        continue;
      }
      onlyKeys(ext, ['url', 'title', 'types'], `extensions[${i}]`);
      check(str(ext.url, URL_LIKE), `extensions[${i}].url must be a URL`);
      check(optionalTitle(ext.title), `extensions[${i}].title must be text`);
      check(ext.types === undefined || (Array.isArray(ext.types) && ext.types.every(t => str(t, TYPE_CODE))), `extensions[${i}].types must be an array of type codes`);
      items += Array.isArray(ext.types) ? ext.types.length : 0;
    }
  }
  if (data.profiles !== undefined) {
    check(isObject(data.profiles), 'profiles must be an object');
    for (const [type, list] of Object.entries(isObject(data.profiles) ? data.profiles : {})) {
      check(RESOURCE_TYPE.test(type), `profiles: ${JSON.stringify(type.substring(0, 50))} is not a resource type`);
      check(Array.isArray(list), `profiles.${type} must be an array`);
      for (const [i, prof] of (Array.isArray(list) ? list : []).entries()) {
        items++;
        if (!isObject(prof)) {
          check(false, `profiles.${type}[${i}] must be an object`);
          continue;
        }
        onlyKeys(prof, ['url', 'title'], `profiles.${type}[${i}]`);
        check(str(prof.url, URL_LIKE), `profiles.${type}[${i}].url must be a URL`);
        check(optionalTitle(prof.title), `profiles.${type}[${i}].title must be text`);
      }
    }
  }
  if (data.usage !== undefined) {
    check(isObject(data.usage), 'usage must be an object');
    for (const [url, locations] of Object.entries(isObject(data.usage) ? data.usage : {})) {
      check(URL_LIKE.test(url), `usage: ${JSON.stringify(url.substring(0, 50))} is not a URL`);
      check(Array.isArray(locations) && locations.every(l => str(l, PATH)), `usage[${JSON.stringify(url.substring(0, 50))}] must be an array of element paths`);
      items += Array.isArray(locations) ? locations.length : 0;
    }
  }
  check(items <= MAX_ITEMS, `the submission has more than ${MAX_ITEMS} items`);
  return errors;
}

class ExtensionTrackerModule {
  constructor(stats) {
    this.stats = stats;
    this.db = null;
    this.urlBase = '/ext-tracker';
  }

  initialize(config, app) {
    this.config = config;
    const dbPath = config.database || path.join(config.folder || '.', 'extension-tracker.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.createSchema();
    this.prepareStatements();

    this.urlBase = config.url || '/ext-tracker';

    // load template
    const templatePath = path.join(__dirname, 'extension-tracker-template.html');
    htmlServer.loadTemplate(TEMPLATE_NAME, templatePath);

    const router = express.Router();

    // POST - submit extension data
    router.post(this.urlBase, express.json({ limit: '5mb' }), (req, res) => {
      this.handleSubmission(req, res);
    });

    // GET - HTML views
    router.get(this.urlBase, (req, res) => this.handleHome(req, res));
    router.get(this.urlBase + '/extensions', (req, res) => this.handleExtensions(req, res));
    router.get(this.urlBase + '/extensions/packages', (req, res) => this.handleExtensionsByPackage(req, res));
    router.get(this.urlBase + '/profiles', (req, res) => this.handleProfiles(req, res));
    router.get(this.urlBase + '/usage', (req, res) => this.handleUsage(req, res));
    router.get(this.urlBase + '/usage/packages', (req, res) => this.handleUsageByPackage(req, res));
    router.get(this.urlBase + '/package/:pkg', (req, res) => this.handlePackageDetail(req, res));

    app.use('/', router);
    const count = this.db.prepare('SELECT COUNT(*) as count FROM packages').get().count;
    console.log(`Extension tracker: loaded (${count} packages in database) at ${this.urlBase}`);
  }

  createSchema() {
    this.db.exec(`
        CREATE TABLE IF NOT EXISTS packages (
                                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                package TEXT NOT NULL UNIQUE,
                                                version TEXT NOT NULL,
                                                fhir_version TEXT NOT NULL,
                                                jurisdiction TEXT,
                                                submitted_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS extensions (
                                                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                  package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
            url TEXT NOT NULL,
            title TEXT
            );

        CREATE TABLE IF NOT EXISTS extension_types (
                                                       id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                       extension_id INTEGER NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
            type TEXT NOT NULL
            );

        CREATE TABLE IF NOT EXISTS profiles (
                                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
            resource_type TEXT NOT NULL,
            url TEXT NOT NULL,
            title TEXT
            );

        CREATE TABLE IF NOT EXISTS usages (
                                              id INTEGER PRIMARY KEY AUTOINCREMENT,
                                              package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
            extension_url TEXT NOT NULL,
            location TEXT NOT NULL
            );

        CREATE INDEX IF NOT EXISTS idx_extensions_package ON extensions(package_id);
        CREATE INDEX IF NOT EXISTS idx_extensions_url ON extensions(url);
        CREATE INDEX IF NOT EXISTS idx_extension_types_ext ON extension_types(extension_id);
        CREATE INDEX IF NOT EXISTS idx_profiles_package ON profiles(package_id);
        CREATE INDEX IF NOT EXISTS idx_profiles_resource ON profiles(resource_type);
        CREATE INDEX IF NOT EXISTS idx_usages_package ON usages(package_id);
        CREATE INDEX IF NOT EXISTS idx_usages_url ON usages(extension_url);
        CREATE INDEX IF NOT EXISTS idx_usages_location ON usages(location);
    `);
  }

  prepareStatements() {
    this.stmts = {
      deletePackage: this.db.prepare('DELETE FROM packages WHERE package = ?'),
      insertPackage: this.db.prepare(
        'INSERT INTO packages (package, version, fhir_version, jurisdiction, submitted_at) VALUES (?, ?, ?, ?, ?)'
      ),
      insertExtension: this.db.prepare(
        'INSERT INTO extensions (package_id, url, title) VALUES (?, ?, ?)'
      ),
      insertExtensionType: this.db.prepare(
        'INSERT INTO extension_types (extension_id, type) VALUES (?, ?)'
      ),
      insertProfile: this.db.prepare(
        'INSERT INTO profiles (package_id, resource_type, url, title) VALUES (?, ?, ?, ?)'
      ),
      insertUsage: this.db.prepare(
        'INSERT INTO usages (package_id, extension_url, location) VALUES (?, ?, ?)'
      )
    };
  }

  // ---- Client-side column filtering ----

  /**
   * Build a script block that adds filter inputs to each column header of a table.
   * Filters combine (AND) and persist in cookies.
   * @param {string} tableId - the id attribute of the table
   * @param {Array} columns - array of { type: 'text'|'select', options?: string[] }
   * @param {string} cookiePrefix - cookie name prefix for persistence
   */
  buildColumnFilters(tableId, columns, cookiePrefix) {
    // goes inside a <script>, and the options are submitted data: with no '<' in it, no
    // value can close the script element
    const colsJson = JSON.stringify(columns.map(c => ({
      type: c.type || 'text',
      options: c.options || []
    }))).replace(/</g, '\\u003c');

    return `
      <script>
      (function() {
        var table = document.getElementById(${JSON.stringify(tableId)});
        if (!table) return;
        var cols = ${colsJson};
        var prefix = ${JSON.stringify(cookiePrefix)};
        var headerRow = table.querySelector('tr');
        var filterRow = document.createElement('tr');
        filterRow.className = 'filter-row';
        var html = '';
        for (var i = 0; i < cols.length; i++) {
          var c = cols[i];
          if (c.type === 'select') {
            html += '<th><select data-col="' + i + '" class="col-filter" style="width:100%;box-sizing:border-box;">';
            html += '<option value="">All</option>';
            for (var j = 0; j < c.options.length; j++) {
              var o = c.options[j].replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
              html += '<option value="' + o + '">' + o + '</option>';
            }
            html += '</select></th>';
          } else {
            html += '<th><input type="text" data-col="' + i + '" class="col-filter" placeholder="filter..." style="width:100%;box-sizing:border-box;"></th>';
          }
        }
        filterRow.innerHTML = html;
        headerRow.parentNode.insertBefore(filterRow, headerRow.nextSibling);
 
        function getCookie(name) {
          var m = document.cookie.match(new RegExp('(^|;)\\\\s*' + name + '=([^;]*)'));
          return m ? decodeURIComponent(m[2]) : '';
        }
        function setCookie(name, val) {
          document.cookie = name + '=' + encodeURIComponent(val) + ';path=/;max-age=86400;SameSite=Lax';
        }
 
        var filters = filterRow.querySelectorAll('.col-filter');
        var allRows = table.querySelectorAll('tr');
        var rows = [];
        for (var r = 2; r < allRows.length; r++) rows.push(allRows[r]);
 
        function applyFilters() {
          var visible = 0;
          for (var ri = 0; ri < rows.length; ri++) {
            var cells = rows[ri].querySelectorAll('td');
            var show = true;
            for (var fi = 0; fi < filters.length; fi++) {
              var f = filters[fi];
              var ci = parseInt(f.getAttribute('data-col'));
              var val = f.value.toLowerCase();
              if (val && cells[ci]) {
                var text = cells[ci].textContent.toLowerCase();
                if (f.tagName === 'SELECT') {
                  if (text !== val) show = false;
                } else {
                  if (text.indexOf(val) === -1) show = false;
                }
              }
            }
            rows[ri].style.display = show ? '' : 'none';
            if (show) visible++;
          }
          var counter = document.getElementById(${JSON.stringify(tableId)} + '-count');
          if (counter) counter.textContent = visible + ' of ' + rows.length;
        }
 
        for (var fi = 0; fi < filters.length; fi++) {
          (function(f) {
            var ci = f.getAttribute('data-col');
            var saved = getCookie(prefix + '_' + ci);
            if (saved) f.value = saved;
            var evt = f.tagName === 'SELECT' ? 'change' : 'input';
            f.addEventListener(evt, function() {
              setCookie(prefix + '_' + ci, f.value);
              applyFilters();
            });
          })(filters[fi]);
        }
        applyFilters();
      })();
      </script>`;
  }

  // ---- Template rendering ----

  renderPage(title, content, processingTime) {
    if (!htmlServer.hasTemplate(TEMPLATE_NAME)) {
      const templatePath = path.join(__dirname, 'extension-tracker-template.html');
      htmlServer.loadTemplate(TEMPLATE_NAME, templatePath);
    }
    const count = this.db.prepare('SELECT COUNT(*) as count FROM packages').get().count;
    const stats = {
      version: packageJson.version,
      totalPackages: count,
      processingTime: processingTime
    };
    return htmlServer.renderPage(TEMPLATE_NAME, title, content, stats);
  }

  sendHtmlResponse(res, title, content, startTime) {
    const html = this.renderPage(title, content, Date.now() - startTime);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  }

  // ---- POST handler ----

  handleSubmission(req, res) {
    const startTime = Date.now();
    const data = req.body;

    // The IG Publisher sends a token. It is in the publisher's source, so it is no secret,
    // but it keeps out anything that isn't trying to look like the publisher
    if (tokenConfigured(this.config.token)) {
      const auth = req.get('Authorization') || '';
      const supplied = auth.replace(/^Bearer\s+/i, '');
      if (!tokenMatches(this.config.token, supplied)) {
        return res.status(401).json({ error: 'A valid token is required in the Authorization header' });
      }
    }

    const errors = validateSubmission(data);
    if (errors.length > 0) {
      // logged, so that a real publisher submission refused by a rule that is too strict is seen
      console.log(`Extension tracker: refused a submission for ${String(data?.package).substring(0, 100)} from ${req.ip}: ${errors.slice(0, 3).join('; ')}`);
      return res.status(400).json({ error: 'Not a valid submission', issues: errors });
    }

    try {
      this.ingestData(data);
      this.stats.countRequest('handleSubmission', Date.now() - startTime);
      return res.status(200).json({ status: 'ok', package: data.package, version: data.version });
    } catch (err) {
      console.log(`Extension tracker: error ingesting ${data.package}: ${err.message}`);
      return res.status(500).json({ error: 'Failed to process submission' });
    }
  }

  ingestData(data) {
    const ingest = this.db.transaction(() => {
      // delete any existing entry for this package (cascade cleans children)
      this.stmts.deletePackage.run(data.package);

      // insert package
      const result = this.stmts.insertPackage.run(
        data.package, data.version, data.fhirVersion,
        data.jurisdiction || null, new Date().toISOString()
      );
      const packageId = result.lastInsertRowid;

      // insert extensions
      if (Array.isArray(data.extensions)) {
        for (const ext of data.extensions) {
          const extResult = this.stmts.insertExtension.run(packageId, ext.url, ext.title || null);
          const extId = extResult.lastInsertRowid;

          // deduplicate types
          if (Array.isArray(ext.types)) {
            const seen = new Set();
            for (const type of ext.types) {
              if (!seen.has(type)) {
                seen.add(type);
                this.stmts.insertExtensionType.run(extId, type);
              }
            }
          }
        }
      }

      // insert profiles
      if (data.profiles && typeof data.profiles === 'object') {
        for (const [resourceType, profileList] of Object.entries(data.profiles)) {
          if (Array.isArray(profileList)) {
            for (const profile of profileList) {
              this.stmts.insertProfile.run(packageId, resourceType, profile.url, profile.title || null);
            }
          }
        }
      }

      // insert usage
      if (data.usage && typeof data.usage === 'object') {
        for (const [extUrl, locations] of Object.entries(data.usage)) {
          if (Array.isArray(locations)) {
            for (const location of locations) {
              this.stmts.insertUsage.run(packageId, extUrl, location);
            }
          }
        }
      }
    });

    ingest();
  }

  // ---- GET handlers ----

  handleHome(req, res) {
    const startTime = Date.now();
    try {
      const summary = this.db.prepare(`
          SELECT
              COUNT(*) as packageCount,
              COUNT(DISTINCT fhir_version) as fhirVersionCount
          FROM packages
      `).get();

      const extCount = this.db.prepare('SELECT COUNT(*) as count FROM extensions').get().count;
      const profileCount = this.db.prepare('SELECT COUNT(*) as count FROM profiles').get().count;
      const usageCount = this.db.prepare('SELECT COUNT(*) as count FROM usages').get().count;

      const packages = this.db.prepare(
        'SELECT package, version, fhir_version, jurisdiction, submitted_at FROM packages ORDER BY package'
      ).all();

      let content = '<table class="grid">';
      content += `<tr><td><b>Packages</b></td><td>${summary.packageCount}</td></tr>`;
      content += `<tr><td><b>FHIR Versions</b></td><td>${summary.fhirVersionCount}</td></tr>`;
      content += `<tr><td><b>Extensions defined</b></td><td>${extCount}</td></tr>`;
      content += `<tr><td><b>Profiles defined</b></td><td>${profileCount}</td></tr>`;
      content += `<tr><td><b>Extension usages tracked</b></td><td>${usageCount}</td></tr>`;
      content += '</table>';

      content += '<h3>Packages</h3>';
      content += `<p><span id="pkg-table-count">${packages.length}</span> packages</p>`;
      content += '<table class="grid" id="pkg-table"><tr><th>Package</th><th>Version</th><th>FHIR</th><th>Jurisdiction</th><th>Submitted</th></tr>';
      for (const p of packages) {
        content += '<tr>';
        content += `<td><a href="${this.urlBase}/package/${encodeURIComponent(p.package)}">${escape(p.package)}</a></td>`;
        content += `<td>${escape(p.version)}</td>`;
        content += `<td>${escape(p.fhir_version)}</td>`;
        content += `<td>${escape(p.jurisdiction || '')}</td>`;
        content += `<td>${escape(p.submitted_at.substring(0, 10))}</td>`;
        content += '</tr>';
      }
      content += '</table>';

      content += this.buildColumnFilters('pkg-table', [
        { type: 'text' }, { type: 'text' }, { type: 'text' }, { type: 'text' }, { type: 'text' }
      ], 'pkgf');

      this.stats.countRequest('handleHome', Date.now() - startTime);
      this.sendHtmlResponse(res, 'Extension Tracker', content, startTime);
    } catch (error) {
      console.log('Extension tracker: error rendering home:', error);
      htmlServer.sendErrorResponse(res, TEMPLATE_NAME, error);
    }
  }

  handleExtensions(req, res) {
    const startTime = Date.now();
    try {
      // Aggregate by extension URL: combine types across all occurrences, count packages
      const rows = this.db.prepare(`
        SELECT e.url,
          MAX(e.title) as title,
          GROUP_CONCAT(DISTINCT et.type) as types,
          COUNT(DISTINCT e.package_id) as package_count
        FROM extensions e
        LEFT JOIN extension_types et ON et.extension_id = e.id
        GROUP BY e.url
        ORDER BY e.url
      `).all();

      let content = `<p><span id="ext-table-count">${rows.length}</span> extensions</p>`;
      content += '<table class="grid" id="ext-table"><tr><th>Extension</th><th>Title</th><th>Types</th><th>Packages</th></tr>';
      for (const r of rows) {
        content += '<tr>';
        content += `<td>${escape(r.url)}</td>`;
        content += `<td>${escape(r.title || '')}</td>`;
        content += `<td>${escape(r.types || '')}</td>`;
        content += `<td><a href="${this.urlBase}/extensions/packages?url=${encodeURIComponent(r.url)}">${r.package_count}</a></td>`;
        content += '</tr>';
      }
      content += '</table>';

      content += this.buildColumnFilters('ext-table', [
        { type: 'text' }, { type: 'text' }, { type: 'text' }, { type: 'text' }
      ], 'extf');

      this.stats.countRequest('handleExtensions', Date.now() - startTime);
      this.sendHtmlResponse(res, 'Extensions', content, startTime);
    } catch (error) {
      console.log('Extension tracker: error rendering extensions:', error);
      htmlServer.sendErrorResponse(res, TEMPLATE_NAME, error);
    }
  }

  handleExtensionsByPackage(req, res) {
    const startTime = Date.now();
    try {
      const filterUrl = req.query.url || null;

      let query = `
        SELECT e.url, e.title, p.package, p.version,
          GROUP_CONCAT(DISTINCT et.type) as types
        FROM extensions e
        JOIN packages p ON p.id = e.package_id
        LEFT JOIN extension_types et ON et.extension_id = e.id
      `;
      const params = [];
      if (filterUrl) {
        query += ' WHERE e.url = ?';
        params.push(filterUrl);
      }
      query += ' GROUP BY e.id ORDER BY p.package, e.url';

      const rows = this.db.prepare(query).all(...params);

      let content = '<p><a href="' + this.urlBase + '/extensions">&laquo; Back to extensions</a></p>';
      if (filterUrl) {
        content += `<p>Extension: <b>${escape(filterUrl)}</b></p>`;
      }

      content += `<p><span id="extpkg-table-count">${rows.length}</span> entries by package</p>`;
      content += '<table class="grid" id="extpkg-table"><tr><th>Extension</th><th>Title</th><th>Types</th><th>Package</th></tr>';
      for (const r of rows) {
        content += '<tr>';
        content += `<td>${escape(r.url)}</td>`;
        content += `<td>${escape(r.title || '')}</td>`;
        content += `<td>${escape(r.types || '')}</td>`;
        content += `<td><a href="${this.urlBase}/package/${encodeURIComponent(r.package)}">${escape(r.package)}#${escape(r.version)}</a></td>`;
        content += '</tr>';
      }
      content += '</table>';

      content += this.buildColumnFilters('extpkg-table', [
        { type: 'text' }, { type: 'text' }, { type: 'text' }, { type: 'text' }
      ], 'extpkgf');

      this.stats.countRequest('handleExtensionsByPackage', Date.now() - startTime);
      this.sendHtmlResponse(res, 'Extensions by Package', content, startTime);
    } catch (error) {
      console.log('Extension tracker: error rendering extensions by package:', error);
      htmlServer.sendErrorResponse(res, TEMPLATE_NAME, error);
    }
  }

  handleProfiles(req, res) {
    const startTime = Date.now();
    try {
      const rows = this.db.prepare(`
        SELECT pr.resource_type, pr.url, pr.title, p.package, p.version
        FROM profiles pr
        JOIN packages p ON p.id = pr.package_id
        ORDER BY pr.resource_type, p.package, pr.url
      `).all();

      // get distinct resource types for the select filter
      const resourceTypes = this.db.prepare(
        'SELECT DISTINCT resource_type FROM profiles ORDER BY resource_type'
      ).all().map(r => r.resource_type);

      let content = `<p><span id="prof-table-count">${rows.length}</span> profiles</p>`;
      content += '<table class="grid" id="prof-table"><tr><th>Resource</th><th>Profile</th><th>Title</th><th>Package</th></tr>';
      for (const r of rows) {
        content += '<tr>';
        content += `<td>${escape(r.resource_type)}</td>`;
        content += `<td>${escape(r.url)}</td>`;
        content += `<td>${escape(r.title || '')}</td>`;
        content += `<td><a href="${this.urlBase}/package/${encodeURIComponent(r.package)}">${escape(r.package)}#${escape(r.version)}</a></td>`;
        content += '</tr>';
      }
      content += '</table>';

      content += this.buildColumnFilters('prof-table', [
        { type: 'select', options: resourceTypes },
        { type: 'text' },
        { type: 'text' },
        { type: 'text' }
      ], 'proff');

      this.stats.countRequest('handleProfiles', Date.now() - startTime);
      this.sendHtmlResponse(res, 'Profiles', content, startTime);
    } catch (error) {
      console.log('Extension tracker: error rendering profiles:', error);
      htmlServer.sendErrorResponse(res, TEMPLATE_NAME, error);
    }
  }

  handleUsage(req, res) {
    const startTime = Date.now();
    try {
      // Aggregate usages by extension_url + location, counting distinct packages
      const rows = this.db.prepare(`
        SELECT u.extension_url, u.location, COUNT(DISTINCT u.package_id) as package_count
        FROM usages u
        GROUP BY u.extension_url, u.location
        ORDER BY u.extension_url, u.location
      `).all();

      let content = `<p><span id="usage-table-count">${rows.length}</span> usage entries (aggregated across packages)</p>`;
      content += '<table class="grid" id="usage-table"><tr><th>Extension</th><th>Used on</th><th>Packages</th></tr>';
      for (const r of rows) {
        content += '<tr>';
        content += `<td>${escape(r.extension_url)}</td>`;
        content += `<td>${escape(r.location)}</td>`;
        content += `<td><a href="${this.urlBase}/usage/packages?url=${encodeURIComponent(r.extension_url)}&location=${encodeURIComponent(r.location)}">${r.package_count}</a></td>`;
        content += '</tr>';
      }
      content += '</table>';

      content += this.buildColumnFilters('usage-table', [
        { type: 'text' }, { type: 'text' }, { type: 'text' }
      ], 'usagef');

      this.stats.countRequest('handleUsage', Date.now() - startTime);
      this.sendHtmlResponse(res, 'Extension Usage', content, startTime);
    } catch (error) {
      console.log('Extension tracker: error rendering usage:', error);
      htmlServer.sendErrorResponse(res, TEMPLATE_NAME, error);
    }
  }

  handleUsageByPackage(req, res) {
    const startTime = Date.now();
    try {
      const filterUrl = req.query.url || null;
      const filterLocation = req.query.location || null;

      let query = `
        SELECT u.extension_url, u.location, p.package, p.version
        FROM usages u
        JOIN packages p ON p.id = u.package_id
      `;
      const conditions = [];
      const params = [];
      if (filterUrl) {
        conditions.push('u.extension_url = ?');
        params.push(filterUrl);
      }
      if (filterLocation) {
        conditions.push('u.location = ?');
        params.push(filterLocation);
      }
      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }
      query += ' ORDER BY p.package, u.extension_url, u.location';

      const rows = this.db.prepare(query).all(...params);

      let content = '<p><a href="' + this.urlBase + '/usage">&laquo; Back to aggregated usage</a></p>';
      if (filterUrl || filterLocation) {
        const parts = [];
        if (filterUrl) parts.push(`extension: <b>${escape(filterUrl)}</b>`);
        if (filterLocation) parts.push(`location: <b>${escape(filterLocation)}</b>`);
        content += `<p>Filtered to ${parts.join(', ')}</p>`;
      }

      content += `<p><span id="usagepkg-table-count">${rows.length}</span> usage entries by package</p>`;
      content += '<table class="grid" id="usagepkg-table"><tr><th>Extension</th><th>Used on</th><th>Package</th></tr>';
      for (const r of rows) {
        content += '<tr>';
        content += `<td>${escape(r.extension_url)}</td>`;
        content += `<td>${escape(r.location)}</td>`;
        content += `<td><a href="${this.urlBase}/package/${encodeURIComponent(r.package)}">${escape(r.package)}#${escape(r.version)}</a></td>`;
        content += '</tr>';
      }
      content += '</table>';

      content += this.buildColumnFilters('usagepkg-table', [
        { type: 'text' }, { type: 'text' }, { type: 'text' }
      ], 'usagepkgf');

      this.stats.countRequest('handleUsageByPackage', Date.now() - startTime);
      this.sendHtmlResponse(res, 'Usage by Package', content, startTime);
    } catch (error) {
      console.log('Extension tracker: error rendering usage by package:', error);
      htmlServer.sendErrorResponse(res, TEMPLATE_NAME, error);
    }
  }

  handlePackageDetail(req, res) {
    const startTime = Date.now();
    try {
      const pkgName = req.params.pkg;
      const pkg = this.db.prepare('SELECT * FROM packages WHERE package = ?').get(pkgName);
      if (!pkg) {
        return res.status(404).send('Package not found');
      }

      const extensions = this.db.prepare(`
        SELECT e.url, e.title, GROUP_CONCAT(DISTINCT et.type) as types
        FROM extensions e
        LEFT JOIN extension_types et ON et.extension_id = e.id
        WHERE e.package_id = ?
        GROUP BY e.id ORDER BY e.url
      `).all(pkg.id);

      const profiles = this.db.prepare(
        'SELECT resource_type, url, title FROM profiles WHERE package_id = ? ORDER BY resource_type, url'
      ).all(pkg.id);

      const usages = this.db.prepare(
        'SELECT extension_url, location FROM usages WHERE package_id = ? ORDER BY extension_url, location'
      ).all(pkg.id);

      let content = '<table class="grid">';
      content += `<tr><td><b>Package</b></td><td>${escape(pkg.package)}</td></tr>`;
      content += `<tr><td><b>Version</b></td><td>${escape(pkg.version)}</td></tr>`;
      content += `<tr><td><b>FHIR Version</b></td><td>${escape(pkg.fhir_version)}</td></tr>`;
      content += `<tr><td><b>Jurisdiction</b></td><td>${escape(pkg.jurisdiction || '')}</td></tr>`;
      content += `<tr><td><b>Submitted</b></td><td>${escape(pkg.submitted_at)}</td></tr>`;
      content += '</table>';

      if (extensions.length > 0) {
        content += `<h3>Extensions Defined (${extensions.length})</h3>`;
        content += '<table class="grid"><tr><th>URL</th><th>Title</th><th>Types</th></tr>';
        for (const e of extensions) {
          content += '<tr>';
          content += `<td>${escape(e.url)}</td>`;
          content += `<td>${escape(e.title || '')}</td>`;
          content += `<td>${escape(e.types || '')}</td>`;
          content += '</tr>';
        }
        content += '</table>';
      }

      if (profiles.length > 0) {
        content += `<h3>Profiles Defined (${profiles.length})</h3>`;
        content += '<table class="grid"><tr><th>Resource</th><th>URL</th><th>Title</th></tr>';
        for (const p of profiles) {
          content += '<tr>';
          content += `<td>${escape(p.resource_type)}</td>`;
          content += `<td>${escape(p.url)}</td>`;
          content += `<td>${escape(p.title || '')}</td>`;
          content += '</tr>';
        }
        content += '</table>';
      }

      if (usages.length > 0) {
        content += `<h3>Extension Usage (${usages.length})</h3>`;
        content += '<table class="grid"><tr><th>Extension</th><th>Used on</th></tr>';
        for (const u of usages) {
          content += '<tr>';
          content += `<td><a href="${this.urlBase}/usage?url=${encodeURIComponent(u.extension_url)}">${escape(u.extension_url)}</a></td>`;
          content += `<td>${escape(u.location)}</td>`;
          content += '</tr>';
        }
        content += '</table>';
      }
      this.stats.countRequest('packageDetail', Date.now() - startTime);

      this.sendHtmlResponse(res, `${escape(pkgName)}#${escape(pkg.version)}`, content, startTime);
    } catch (error) {
      console.log('Extension tracker: error rendering package detail:', error);
      htmlServer.sendErrorResponse(res, TEMPLATE_NAME, error);
    }
  }

  // ---- Module lifecycle ----

  shutdown() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  getStatus() {
    let startTime = Date.now();
    if (!this.db) {
      return { status: 'closed' };
    }
    const count = this.db.prepare('SELECT COUNT(*) as count FROM packages').get().count;
    this.stats.countRequest('search', Date.now() - startTime);
    return { status: 'running', packages: count };
  }
}

module.exports = ExtensionTrackerModule;
module.exports.validateSubmission = validateSubmission;
