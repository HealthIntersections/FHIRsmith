const escape = require('escape-html');

// How long a problems report is kept (scanValueSets). The page reads every value set the
// server has - 18,000 from VSAC on tx.fhir.org - so it isn't worked out again for each view;
// it is sooner, if a value set provider says its content has changed (scanSignature)
const PROBLEMS_CACHE_MS = 15 * 60 * 1000;

// provider -> { signature, at, report: Promise<string> }. A request that comes while the report
// is being made waits for that one
const reports = new WeakMap();

class ProblemFinder {

  /**
   * The report for the problems page: what versions of code systems the value sets ask for that
   * the server doesn't have, by source. Kept for PROBLEMS_CACHE_MS, or until a value set
   * provider's scanSignature() changes
   * @param {Provider} provider
   * @returns {Promise<string>} HTML
   */
  async scanValueSets(provider) {
    const signature = await ProblemFinder.signature(provider);
    const now = Date.now();
    const kept = reports.get(provider);
    if (kept && kept.signature === signature && now - kept.at < PROBLEMS_CACHE_MS) {
      return kept.report;
    }
    const entry = { signature, at: now, report: this.buildReport(provider) };
    reports.set(provider, entry);
    // a report that failed isn't kept
    entry.report.catch(() => {
      if (reports.get(provider) === entry) {
        reports.delete(provider);
      }
    });
    return entry.report;
  }

  /** What the value set providers say about their content (scanSignature), together */
  static async signature(provider) {
    const parts = [];
    for (const vsp of provider.valueSetProviders) {
      parts.push(typeof vsp.scanSignature === 'function' ? await vsp.scanSignature() : '');
    }
    return parts.join('\n');
  }

  async buildReport(provider) {
    let unknownVersions = {};  // system -> Set of versions not known to the server
    for (let vsp of provider.valueSetProviders) {
      let sourceUnknownVersions = unknownVersions[vsp.sourcePackage()];
      if (!sourceUnknownVersions) {
        sourceUnknownVersions = {};
        unknownVersions[vsp.sourcePackage()] = sourceUnknownVersions;
      }

      await vsp.scanAllValueSets(async (vs) => {
        if (vs.jsonObj.compose) {
          await this.scanValueSet(vs.jsonObj.compose, sourceUnknownVersions);
        }
      });
    }
    let result = '';
    for (let sp of provider.listValueSetSourceCodes()) {
      let sourceUnknownVersions = unknownVersions[sp];
      if (sourceUnknownVersions) {
        // Filter to only versions the server doesn't know about
        for (const [system, vset] of Object.entries(sourceUnknownVersions)) {
          for (let v of [...vset]) {
            if (await provider.hasCsVersion(system, v)) {
              vset.delete(v);
            }
          }
          if (vset.size === 0) {
            delete sourceUnknownVersions[system];
          }
        }
        let list = await this.unknownVersionsHtml(sourceUnknownVersions, provider, sp);
        if (list) {
          result = result + `<h4>${escape(sp)}</h4>` + list;
        }
      }
    }
    return result;
  }

  async unknownVersionsHtml(unknownVersions, provider, source) {
    const entries = Object.entries(unknownVersions || {});
    if (entries.length === 0) {
      return '<p>No unknown system versions found.</p>';
    }
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    let html = '<table class="grid"><thead><tr><th>System</th><th>Unknown Versions</th><th>Known Versions</th></tr></thead><tbody>';
    for (const [system, vset] of entries) {
      // values from the loaded packages: URL-encoded in links, HTML-escaped everywhere
      const elements = '&_elements=url%2Cversion%2Cname%2Ctitle%2Cstatus%2Ccontent%2Cdate';
      const versions = [...vset].sort((a, b) => a.localeCompare(b));
      const versionRefs = [];
      for (const v of versions) {
        const href = `ValueSet?system=${encodeURIComponent(system + '|' + v)}&source=${encodeURIComponent(source)}${elements}`;
        versionRefs.push(`<a href="${escape(href)}">${escape(v)}</a>`);
      }
      const knownVersions = [...await provider.listCodeSystemVersions(system)].map(v => escape(v)).join('<br/>');
      html += `<tr><td><a href="${escape(`CodeSystem?url=${encodeURIComponent(system)}${elements}`)}">${escape(system)}</a></td>`+
        `<td>${versionRefs.join('<br/>')}</td><td>${knownVersions}</td></tr>`;
    }
    html += '</tbody></table>';
    return html;
  }

  async scanValueSet(compose, versions) {
    for (let inc of compose.include || []) {
      if (inc.system && inc.version) {
        this.seeVersion(versions, inc.system, inc.version);
      }
    }
  }

  seeVersion(versions, system, version) {
    let set = versions[system];
    if (set == null) {
      set = new Set();
      versions[system] = set;
    }
    set.add(version);
  }
}

module.exports = ProblemFinder;