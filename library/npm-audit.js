// library/npm-audit.js
// Periodic self-check of this server's installed npm packages against the npm advisory
// database - the same lookup `npm audit` does, made directly so it needs neither the npm
// binary nor a particular working directory. Reports only; it never changes anything.
//
// The package list comes from node_modules/.package-lock.json (what is actually
// installed), falling back to package-lock.json. Dev dependencies are left out, and
// fhirsmith itself is included, so an advisory published against fhirsmith shows up too.
//
// Config (all optional), top level of config.json:
//   "npmAudit": { "enabled": true, "intervalHours": 24 }

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const escape = require('escape-html');

const DEFAULT_URL = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
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

class NpmAudit {
  constructor(config = {}, logger = null, appDir = path.join(__dirname, '..'), stats = null) {
    this.enabled = config.enabled !== false;
    this.intervalHours = config.intervalHours > 0 ? config.intervalHours : 24;
    this.url = config.url || DEFAULT_URL;
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
    if (!lock || !lock.packages) {
      throw new Error('No package-lock.json found to audit');
    }
    const found = new Map();
    const add = (name, version) => {
      if (!found.has(name)) {
        found.set(name, new Set());
      }
      found.get(name).add(version);
    };
    for (const [key, info] of Object.entries(lock.packages)) {
      if (!key || !info || info.dev || info.link || !info.version) {
        continue;
      }
      const marker = 'node_modules/';
      const name = info.name || key.substring(key.lastIndexOf(marker) + marker.length);
      add(name, info.version);
    }
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(this.appDir, 'package.json'), 'utf8'));
      if (pkg.name && pkg.version) {
        add(pkg.name, pkg.version);
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

  async run() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastAttempt = new Date();
    if (this.stats) {
      this.stats.task('npm audit', 'Checking');
    }
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
      'The server administrator should upgrade to the latest FHIRsmith release. ' +
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

module.exports = { NpmAudit, describeAgo };
