const escape = require('escape-html');

class ProblemFinder {

  async scanValueSets(provider) {
    let unknownVersions = {};  // system -> Set of versions not known to the server
    for (let vsp of provider.valueSetProviders) {
      let sourceUnknownVersions = unknownVersions[vsp.sourcePackage()];
      if (!sourceUnknownVersions) {
        sourceUnknownVersions = {};
        unknownVersions[vsp.sourcePackage()] = sourceUnknownVersions;
      }

      let list = await vsp.listAllValueSets();
      for (let url of list) {
        let vs = await vsp.fetchValueSet(url);
        if (vs && vs.jsonObj.compose) {
          await this.scanValueSet(vs.jsonObj.compose, sourceUnknownVersions);
        }
      }
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