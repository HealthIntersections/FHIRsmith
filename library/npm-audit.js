// library/npm-audit.js
// Periodic self-check of this server's installed npm packages against the npm advisory
// database - the same lookup `npm audit` does, made directly so it needs neither the npm
// binary nor a particular working directory. Reports only; it never changes anything.
//
// The package list comes from node_modules/.package-lock.json (what is actually
// installed), falling back to package-lock.json. Dev dependencies are left out, and
// fhirsmith itself is included, so an advisory published against fhirsmith shows up too.
// A server installed with `npm install -g fhirsmith` has neither - npm doesn't publish the
// lock file, and keeps no hidden one for a global package - so then the package list is read
// from the package.json files in node_modules (a published install has no dev dependencies).
//
// Config (all optional), top level of config.json:
//   "npmAudit": { "enabled": true, "intervalHours": 24 }
//
// Each check also looks up the latest fhirsmith release on npm. The dashboard always says
// whether a newer release is available, and the advice about any findings says whether
// upgrading will help. When this server is already on the latest release it won't:
// npm ignores our package.json "overrides" for anything but a clone + npm ci, so an
// npm-installed server can carry transitive versions the repo itself has overridden away.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const escape = require('escape-html');

const DEFAULT_URL = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const DEFAULT_LATEST_URL = 'https://registry.npmjs.org/fhirsmith/latest';
const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'];
const HOUR_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000; // let startup finish first

function describeAgo(time, now = Date.now()) {
  const mins = Math.max(0, Math.floor((now - time) / 60000));
  if (mins < 1) {
    return 'just now';
  }
  if (mins < 60) {
    return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 48) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  return `${Math.floor(hours / 24)} days ago`;
}

/**
 * Compare two x.y.z versions numerically (pre-release and build suffixes ignored).
 * Returns <0, 0 or >0, or null if either can't be read
 */
function compareVersions(a, b) {
  const parse = v => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
    return m ? m.slice(1).map(Number) : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) {
    return null;
  }
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) {
      return x[i] - y[i];
    }
  }
  return 0;
}

class NpmAudit {
  constructor(config = {}, logger = null, appDir = path.join(__dirname, '..'), stats = null) {
    this.enabled = config.enabled !== false;
    this.intervalHours = config.intervalHours > 0 ? config.intervalHours : 24;
    this.url = config.url || DEFAULT_URL;
    this.latestUrl = config.latestUrl || DEFAULT_LATEST_URL;
    this.timeout = config.timeout || 60000;
    this.logger = logger;
    this.appDir = appDir;
    this.stats = stats;
    this.timers = [];
    this.running = false;
    // the outcome of the last completed check
    this.checkedAt = null; // Date of the last successful check
    this.packageCount = 0;
    this.findings = []; // [{name, installed: [versions], id, severity, title, url, range}]
    this.lastError = null; // message from the last attempt, if it failed
    this.lastAttempt = null;
    this.installedVersion = null; // this server's fhirsmith version, from package.json
    this.latestVersion = null; // the latest fhirsmith release on npm, if it could be found
  }

  /**
   * name -> [installed versions], production packages only, plus this package itself
   */
  collectPackages() {
    let lock = null;
    for (const file of [path.join(this.appDir, 'node_modules', '.package-lock.json'), path.join(this.appDir, 'package-lock.json')]) {
      try {
        lock = JSON.parse(fs.readFileSync(file, 'utf8'));
        break;
      } catch (e) {
        // try the next one
      }
    }
    const found = new Map();
    const add = (name, version) => {
      if (!found.has(name)) {
        found.set(name, new Set());
      }
      found.get(name).add(version);
    };
    if (lock && lock.packages) {
      for (const [key, info] of Object.entries(lock.packages)) {
        if (!key || !info || info.dev || info.link || !info.version) {
          continue;
        }
        const marker = 'node_modules/';
        const name = info.name || key.substring(key.lastIndexOf(marker) + marker.length);
        add(name, info.version);
      }
    } else if (!this.scanInstalled(path.join(this.appDir, 'node_modules'), add)) {
      throw new Error('No package-lock.json or node_modules found to audit');
    }
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(this.appDir, 'package.json'), 'utf8'));
      if (pkg.name && pkg.version) {
        add(pkg.name, pkg.version);
        this.installedVersion = pkg.version;
      }
    } catch (e) {
      // no package.json - nothing to add
    }
    const result = {};
    for (const [name, versions] of found) {
      result[name] = [...versions].sort();
    }
    return result;
  }

  /**
   * Read the installed packages from the package.json files under a node_modules folder,
   * including scoped packages and the node_modules nested inside packages. Linked packages
   * (symlinks) are left out, as they are from a lock file.
   *
   * @returns {boolean} false if there is no node_modules folder
   */
  scanInstalled(dir, add) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return false;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      const dirs = [];
      if (entry.name.startsWith('@')) {
        let scoped = [];
        try {
          scoped = fs.readdirSync(path.join(dir, entry.name), { withFileTypes: true });
        } catch (e) {
          // unreadable scope folder - nothing in it
        }
        for (const s of scoped) {
          if (s.isDirectory()) {
            dirs.push(path.join(dir, entry.name, s.name));
          }
        }
      } else {
        dirs.push(path.join(dir, entry.name));
      }
      for (const pkgDir of dirs) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
          if (pkg.name && pkg.version) {
            add(pkg.name, pkg.version);
          }
        } catch (e) {
          // not a package
        }
        this.scanInstalled(path.join(pkgDir, 'node_modules'), add);
      }
    }
    return true;
  }

  /**
   * This server's own version, from package.json (collectPackages reads it too, but that
   * can fail for reasons that have nothing to do with the version)
   */
  readInstalledVersion() {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(this.appDir, 'package.json'), 'utf8'));
      if (pkg.version) {
        this.installedVersion = pkg.version;
      }
    } catch (e) {
      // leave it as it was
    }
  }

  /**
   * Dashboard line: this server's version, and whether there is a newer release
   */
  renderRelease() {
    if (!this.installedVersion) {
      return '';
    }
    let html = `<p><strong>FHIRsmith release:</strong> this server runs ${escape(this.installedVersion)}`;
    const cmp = compareVersions(this.installedVersion, this.latestVersion);
    if (cmp === null) {
      html += ' (the latest release could not be checked)';
    } else if (cmp < 0) {
      html += ` - <span style="color:#b60">FHIRsmith ${escape(this.latestVersion)} is available</span>` +
        ' (<a href="https://github.com/HealthIntersections/FHIRsmith/releases">release notes</a>)';
    } else {
      html += ', the latest release';
    }
    return html + '</p>';
  }

  /**
   * Look up the latest fhirsmith release. A failure only means the advice is less specific,
   * so it is logged and otherwise ignored (the previous answer is kept)
   */
  async checkLatest() {
    try {
      const response = await axios.get(this.latestUrl, { timeout: this.timeout, headers: { 'Accept': 'application/json' } });
      const version = response.data && response.data.version;
      if (typeof version === 'string' && compareVersions(version, version) === 0) {
        this.latestVersion = version;
      }
    } catch (error) {
      if (this.logger) {
        this.logger.info('npm audit: could not look up the latest FHIRsmith release: ' + error.message);
      }
    }
  }

  /**
   * What the administrator can do about the findings
   */
  advice() {
    const cmp = compareVersions(this.installedVersion, this.latestVersion);
    if (cmp === null) {
      return 'The server administrator should upgrade to the latest FHIRsmith release.';
    }
    if (cmp < 0) {
      return `The server administrator should upgrade to FHIRsmith ${this.latestVersion} (this server is running ${this.installedVersion}).`;
    }
    return `This server is already running the latest FHIRsmith release (${this.installedVersion}), ` +
      'so these will be fixed by a future FHIRsmith release.';
  }

  async run() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastAttempt = new Date();
    if (this.stats) {
      this.stats.task('npm audit', 'Checking');
    }
    // independent of the audit: failures here are logged and otherwise ignored
    this.readInstalledVersion();
    await this.checkLatest();
    try {
      const packages = this.collectPackages();
      const response = await axios.post(this.url, packages, {
        timeout: this.timeout,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
      });
      const data = response.data && typeof response.data === 'object' ? response.data : {};
      const findings = [];
      for (const [name, advisories] of Object.entries(data)) {
        for (const a of Array.isArray(advisories) ? advisories : []) {
          findings.push({
            name,
            installed: packages[name] || [],
            id: a.id,
            severity: SEVERITIES.includes(a.severity) ? a.severity : 'info',
            title: a.title || '',
            url: a.url || '',
            range: a.vulnerable_versions || ''
          });
        }
      }
      findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.name.localeCompare(b.name));
      this.findings = findings;
      this.packageCount = Object.keys(packages).length;
      this.checkedAt = new Date();
      this.lastError = null;
      const summary = this.summary();
      if (findings.length > 0) {
        if (this.logger) {
          this.logger.warn(`npm audit: ${summary} in ${this.packageCount} packages: ` +
            findings.map(f => `${f.name} (${f.severity}) ${f.url}`).join('; '));
        }
        if (this.stats) {
          this.stats.taskError('npm audit', summary);
        }
      } else {
        if (this.logger) {
          this.logger.info(`npm audit: no known vulnerabilities in ${this.packageCount} packages`);
        }
        if (this.stats) {
          this.stats.taskDone('npm audit', `No known vulnerabilities (${this.packageCount} packages)`);
        }
      }
    } catch (error) {
      this.lastError = error.message;
      if (this.logger) {
        this.logger.warn('npm audit could not be run: ' + error.message);
      }
      if (this.stats) {
        this.stats.taskError('npm audit', 'Could not check: ' + error.message);
      }
    } finally {
      this.running = false;
    }
  }

  start() {
    if (!this.enabled) {
      return;
    }
    if (this.stats) {
      this.stats.addTask('npm audit', `${this.intervalHours} hr`);
    }
    // run() handles its own errors, so the promise never rejects
    const first = setTimeout(() => void this.run(), FIRST_RUN_DELAY_MS);
    const repeat = setInterval(() => void this.run(), this.intervalHours * HOUR_MS);
    for (const t of [first, repeat]) {
      if (t.unref) {
        t.unref();
      }
      this.timers.push(t);
    }
  }

  stop() {
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers = [];
  }

  counts() {
    const counts = {};
    for (const f of this.findings) {
      counts[f.severity] = (counts[f.severity] || 0) + 1;
    }
    return counts;
  }

  // "3 known vulnerabilities (1 critical, 2 high)"
  summary() {
    const n = this.findings.length;
    if (n === 0) {
      return 'no known vulnerabilities';
    }
    const counts = this.counts();
    const parts = SEVERITIES.filter(s => counts[s]).map(s => `${counts[s]} ${s}`);
    return `${n} known vulnerabilit${n === 1 ? 'y' : 'ies'} (${parts.join(', ')})`;
  }

  isSerious() {
    return this.findings.some(f => f.severity === 'critical' || f.severity === 'high');
  }

  /**
   * For the daily report: plain text, and only when there's something to act
   * on - packages with known vulnerabilities (and what to do about them), a
   * check that couldn't be run, or a newer FHIRsmith release. '' otherwise.
   */
  reportText() {
    if (!this.enabled) {
      return '';
    }
    const sentences = [];
    if (this.findings.length > 0) {
      const list = this.findings.map(f => `${f.name} ${f.installed.join('/')} (${f.severity}: ${f.range})`).join(', ');
      sentences.push(`npm audit found ${this.summary()} in the packages this server uses: ${list}. ${this.advice()}`);
    }
    if (this.lastError) {
      sentences.push(this.checkedAt
        ? `The latest npm audit check failed: ${this.lastError}.`
        : `The npm audit check could not be run: ${this.lastError}.`);
    }
    if (this.findings.length === 0 && this.installedVersion && compareVersions(this.installedVersion, this.latestVersion) < 0) {
      sentences.push(`FHIRsmith ${this.latestVersion} is available (this server is running ${this.installedVersion}).`);
    }
    return sentences.join(' ');
  }

  /**
   * Home page: nothing unless there is something to report
   */
  renderBanner(now = Date.now()) {
    if (!this.enabled || !this.checkedAt || this.findings.length === 0) {
      return '';
    }
    const cls = this.isSerious() ? 'alert-danger' : 'alert-warning';
    return `<div class="alert ${cls}" role="alert"><strong>Security:</strong> npm audit found ` +
      `${escape(this.summary())} in the packages this server uses ` +
      `(checked ${escape(describeAgo(this.checkedAt.getTime(), now))}). ` +
      `${escape(this.advice())} ` +
      '<a href="/dashboard#npm-audit">Details</a></div>';
  }

  /**
   * Dashboard: always shown, so a check that is failing or switched off is visible too
   */
  renderDashboard(now = Date.now()) {
    let html = '<div id="npm-audit">';
    if (!this.enabled) {
      return html + '<p><strong>npm audit:</strong> disabled (npmAudit.enabled = false)</p></div>';
    }
    html += this.renderRelease();
    if (!this.checkedAt) {
      html += '<p><strong>npm audit:</strong> ';
      html += this.lastError ? `<span style="color:#b00">could not be run: ${escape(this.lastError)}</span>` : 'not run yet';
      return html + '</p></div>';
    }
    const colour = this.findings.length === 0 ? '#070' : (this.isSerious() ? '#b00' : '#b60');
    html += `<p><strong>npm audit:</strong> <span style="color:${colour}">${escape(this.summary())}</span>` +
      ` in ${this.packageCount} packages, checked ${escape(describeAgo(this.checkedAt.getTime(), now))}`;
    if (this.lastError) {
      html += ` <span style="color:#b00">(the latest check failed: ${escape(this.lastError)})</span>`;
    }
    html += '</p>';
    if (this.findings.length > 0) {
      html += `<p>${escape(this.advice())}</p>`;
      html += '<table class="grid"><tr><th>Severity</th><th>Package</th><th>Installed</th><th>Vulnerable</th><th>Advisory</th></tr>';
      for (const f of this.findings) {
        const link = /^https:\/\//.test(f.url) ? `<a href="${escape(f.url)}">${escape(f.title || f.url)}</a>` : escape(f.title);
        html += `<tr><td>${escape(f.severity)}</td><td>${escape(f.name)}</td><td>${escape(f.installed.join(', '))}</td>` +
          `<td>${escape(f.range)}</td><td>${link}</td></tr>`;
      }
      html += '</table>';
    }
    return html + '</div>';
  }
}

module.exports = { NpmAudit, describeAgo, compareVersions };
