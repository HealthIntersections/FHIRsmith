// registry/fhirsmith-releases.js
// The list of FHIRsmith releases and their dates, so the registry can say how old the
// FHIRsmith version a registered server reports is.
//
// The list comes from the GitHub releases API, refreshed with each crawl. Until that
// succeeds (or if it can't be reached), the dated headings in this server's own
// CHANGELOG.md are used instead - those only go up to this server's own version.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DEFAULT_RELEASES_URL = 'https://api.github.com/repos/HealthIntersections/FHIRsmith/releases';
const DAY_MS = 24 * 60 * 60 * 1000;

// "v0.14.1" -> [0, 14, 1]; anything that isn't n.n.n (optionally with a -suffix) -> null
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  if (!m) {
    return null;
  }
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], suffix: m[4] || '' };
}

function compareParts(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return 0;
}

function isFhirsmith(softwareName) {
  return /fhirsmith/i.test(softwareName || '');
}

class FhirsmithReleases {
  constructor(config = {}, logger = null) {
    this.url = config.releasesUrl || DEFAULT_RELEASES_URL;
    this.timeout = config.timeout || 30000;
    this.userAgent = config.userAgent || 'FHIRRegistryServer/1.0';
    this.logger = logger;
    this.releases = []; // [{version: '0.14.1', parts: [0,14,1], date: Date}], newest first
    this.source = 'none';
    this.lastRefresh = null;
  }

  setReleases(list, source) {
    const seen = new Set();
    const releases = [];
    for (const r of list) {
      const pv = parseVersion(r.version);
      const date = r.date instanceof Date ? r.date : new Date(r.date);
      // a release is n.n.n - pre-release suffixes are not tracked
      if (!pv || pv.suffix || isNaN(date.getTime())) {
        continue;
      }
      const key = pv.parts.join('.');
      if (!seen.has(key)) {
        seen.add(key);
        releases.push({ version: key, parts: pv.parts, date });
      }
    }
    releases.sort((a, b) => compareParts(b.parts, a.parts));
    this.releases = releases;
    this.source = source;
  }

  /**
   * Read the dated release headings from a CHANGELOG.md - "## [v0.13.4] - 2026-09-17"
   */
  loadFromChangelog(changelogPath = path.join(__dirname, '..', 'CHANGELOG.md')) {
    try {
      const text = fs.readFileSync(changelogPath, 'utf8');
      const list = [];
      const re = /^##\s*\[v?(\d+\.\d+\.\d+)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/gm;
      let m;
      while ((m = re.exec(text)) !== null) {
        list.push({ version: m[1], date: new Date(m[2] + 'T00:00:00Z') });
      }
      this.setReleases(list, 'CHANGELOG.md');
    } catch (error) {
      if (this.logger) {
        this.logger.warn('Could not read FHIRsmith release dates from CHANGELOG.md: ' + error.message);
      }
    }
  }

  /**
   * Fetch the release list from GitHub. On failure the current list is kept.
   */
  async refresh() {
    try {
      const list = [];
      for (let page = 1; page <= 10; page++) {
        const response = await axios.get(`${this.url}?per_page=100&page=${page}`, {
          timeout: this.timeout,
          headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': this.userAgent }
        });
        const batch = Array.isArray(response.data) ? response.data : [];
        for (const r of batch) {
          if (!r.draft && !r.prerelease && r.tag_name && r.published_at) {
            list.push({ version: r.tag_name, date: r.published_at });
          }
        }
        if (batch.length < 100) {
          break;
        }
      }
      if (list.length > 0) {
        this.setReleases(list, 'GitHub');
        this.lastRefresh = new Date();
      }
    } catch (error) {
      if (this.logger) {
        this.logger.warn('Could not fetch FHIRsmith releases from GitHub: ' + error.message);
      }
    }
  }

  latest() {
    return this.releases.length > 0 ? this.releases[0] : null;
  }

  /**
   * How a reported FHIRsmith version stands against the releases:
   *   status: 'current' | 'outdated' | 'dev' (a build between/after releases) | 'unknown'
   *   release: the release it is (or, for 'dev', the most recent release before it)
   *   ageDays: days since that release came out ('current'/'outdated' only)
   *   behind: how many releases have come out since
   */
  describe(reportedVersion, now = Date.now()) {
    const pv = parseVersion(reportedVersion);
    if (!pv || this.releases.length === 0) {
      return { status: 'unknown' };
    }
    const behind = this.releases.filter(r => compareParts(r.parts, pv.parts) > 0).length;
    const exact = !pv.suffix ? this.releases.find(r => compareParts(r.parts, pv.parts) === 0) : null;
    if (exact) {
      return {
        status: behind === 0 ? 'current' : 'outdated',
        release: exact,
        ageDays: Math.max(0, Math.floor((now - exact.date.getTime()) / DAY_MS)),
        behind
      };
    }
    // a snapshot (0.14.2-snapshot), or a version we have no release for
    const base = this.releases.find(r => compareParts(r.parts, pv.parts) < 0) || null;
    return { status: 'dev', release: base, behind };
  }
}

function describeAge(days) {
  if (days < 1) {
    return 'today';
  }
  if (days < 14) {
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (days < 60) {
    return `${Math.floor(days / 7)} weeks`;
  }
  if (days < 730) {
    return `${Math.floor(days / 30.44)} months`;
  }
  return `${(days / 365.25).toFixed(1)} years`;
}

module.exports = { FhirsmithReleases, isFhirsmith, parseVersion, describeAge };
