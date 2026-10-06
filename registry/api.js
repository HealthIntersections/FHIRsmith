// Enhanced registry-api.js with resolver and HTML rendering functions

const { ServerRegistryUtilities } = require('./model');
const escape = require('escape-html');
const { Utilities } = require('../library/utilities');

const RELEASE_VERSIONS = {
  R2: '1.0',
  R2B: '1.4',
  R3: '3.0',
  R4: '4.0',
  R4B: '4.3',
  R5: '5.0',
  R6: '6.0'
};

// The ecosystem IG reports a server's security as boolean flags (open, password, token,
// oauth, smart, cert). The crawler records a single string; this maps it. 'api-key' is a
// token. The string itself is still reported as 'security' for existing clients.
function securityFlags(security) {
  switch (security) {
    case 'open': return { open: true };
    case 'api-key': return { token: true };
    case 'password': case 'token': case 'oauth': case 'smart': case 'cert':
      return { [security]: true };
    default: return {};
  }
}

class RegistryAPI {
  constructor(crawler) {
    this.crawler = crawler;
  }

  /**
   * Build rows for code system queries
   * Build the discovery rows for a code system query
   */
  buildRowsForCodeSystem(params = {}) {
    const {
      registryCode = '',
      serverCode = '',
      version = '',
      codeSystem = '',
      language = ''
    } = params;

    const rows = [];
    const data = this.crawler.getData();
    const requestLangs = ServerRegistryUtilities.parseAcceptLanguage(language);

    data.registries.forEach(registry => {
      if (registryCode && registry.code !== registryCode) return;

      registry.servers.forEach(server => {
        if (serverCode && server.code !== serverCode) return;

        // Excluded content is hidden from the ecosystem entirely for this server
        if (codeSystem && server.isExcludedTarget(codeSystem)) return;

        // Check if server is authoritative for this code system, taking language
        // specific claims into account (maskBase matches hasMatchingCodeSystem semantics)
        const authMatch = codeSystem
          ? server.matchAuthCS(codeSystem, requestLangs, true)
          : { isAuth: false, scoped: false };
        const isAuth = authMatch.isAuth;

        server.versions.forEach(versionInfo => {
          if (version && !ServerRegistryUtilities.versionMatches(version, versionInfo.version)) {
            return;
          }

          // Always skip servers with errors - they can't serve requests
          if (versionInfo.error) {
            return;
          }

          // Include if:
          // 1. Authoritative for the requested code system
          // 2. No filter specified
          // 3. Has the code system in its list
          if (isAuth ||
            !codeSystem ||
            (codeSystem && ServerRegistryUtilities.hasMatchingCodeSystem(
              codeSystem,
              versionInfo.codeSystems,
              false // no wildcards for actual content
            ))) {
            const row = ServerRegistryUtilities.createRow(
              registry,
              server,
              versionInfo,
              isAuth
            );
            if (authMatch.scoped) {
              row.languages = [authMatch.tag];
            }
            rows.push(row);
          }
        });
      });
    });

    return this._sortAndRankRows(rows);
  }

  /**
   * Build rows for value set queries
   * Build the discovery rows for a value set query
   */
  buildRowsForValueSet(params = {}) {
    const {
      registryCode = '',
      serverCode = '',
      version = '',
      valueSet = ''
    } = params;

    const rows = [];
    const data = this.crawler.getData();

    data.registries.forEach(registry => {
      if (registryCode && registry.code !== registryCode) return;

      registry.servers.forEach(server => {
        if (serverCode && server.code !== serverCode) return;

        // Excluded content is hidden from the ecosystem entirely for this server
        if (valueSet && server.isExcludedTarget(valueSet)) return;

        // Check if server is authoritative for this value set
        // (value set claims have no language dimension at this time)
        const isAuth = valueSet ? ServerRegistryUtilities.hasMatchingValueSet(
          valueSet,
          server.authVSList,
          true // support wildcards
        ) : false;

        server.versions.forEach(versionInfo => {
          if (version && !ServerRegistryUtilities.versionMatches(version, versionInfo.version)) {
            return;
          }

          // Always skip servers with errors - they can't serve requests
          if (versionInfo.error) {
            return;
          }

          // Include if:
          // 1. No filter specified
          // 2. Authoritative for the value set (even via wildcard)
          // 3. Has the value set in its list
          let includeRow = false;

          if (!valueSet) {
            // No filter, include all working servers
            includeRow = true;
          } else {
            // Check if actually has the value set
            const hasValueSet = ServerRegistryUtilities.hasMatchingValueSet(
              valueSet,
              versionInfo.valueSets,
              false // no wildcards for actual content
            );

            // Include if authoritative OR has the value set
            // if the server is authoritative, all its versions are included
            if (isAuth || hasValueSet) {
              includeRow = true;
            }
          }

          if (includeRow) {
            const row = ServerRegistryUtilities.createRow(
              registry,
              server,
              versionInfo,
              isAuth
            );
            rows.push(row);
          }
        });
      });
    });

    return this._sortAndRankRows(rows);
  }

  /**
   * Get all available registries
   */
  getRegistries() {
    const data = this.crawler.getData();
    return data.registries.map(r => ({
      code: r.code,
      name: r.name,
      address: r.address,
      authority: r.authority,
      error: r.error,
      serverCount: r.servers.length
    }));
  }

  /**
   * Get all servers for a registry
   */
  getServers(registryCode) {
    const data = this.crawler.getData();
    const registry = data.getRegistry(registryCode);

    if (!registry) {
      return null;
    }

    return registry.servers.map(s => ({
      code: s.code,
      name: s.name,
      address: s.address,
      description: s.getDescription(),
      details: s.getDetails(),
      versionCount: s.versions.length,
      authCSCount: s.authCSList.length,
      authVSCount: s.authVSList.length,
      usageTags: s.usageList
    }));
  }

  /**
   * Get server details
   */
  getServerDetails(registryCode, serverCode) {
    const data = this.crawler.getData();
    const registry = data.getRegistry(registryCode);

    if (!registry) {
      return null;
    }

    const server = registry.getServer(serverCode);
    if (!server) {
      return null;
    }

    return {
      ...server.toJSON(),
      versions: server.versions.map(v => ({
        ...v.toJSON(),
        details: v.getDetails(),
        csList: v.getCsListHtml(),
        vsList: v.getVsListHtml()
      }))
    };
  }

  /**
   * Get statistics about the registry
   */
  getStatistics() {
    const data = this.crawler.getData();

    let totalServers = 0;
    let totalVersions = 0;
    let totalCodeSystems = new Set();
    let totalValueSets = new Set();
    let errorCount = 0;
    let workingVersions = 0;

    data.registries.forEach(registry => {
      if (registry.error) errorCount++;

      registry.servers.forEach(server => {
        totalServers++;

        server.versions.forEach(version => {
          totalVersions++;
          if (version.error) {
            errorCount++;
          } else {
            workingVersions++;
          }

          version.codeSystems.forEach(cs => totalCodeSystems.add(cs.uri+(cs.version ? '|'+cs.version : '')));
          version.valueSets.forEach(vs => totalValueSets.add(vs));
        });
      });
    });

    return {
      lastRun: data.lastRun,
      // the page footer: nothing to report until the first crawl has finished
      crawlerStatus: data.lastRun ?
        `last updated ${Utilities.describeAgo(data.lastRun)}, ${totalServers} server${totalServers === 1 ? '' : 's'}` :
        'not yet updated',
      outcome: data.outcome,
      registryCount: data.registries.length,
      serverCount: totalServers,
      versionCount: totalVersions,
      workingVersions: workingVersions,
      uniqueCodeSystems: totalCodeSystems.size,
      uniqueValueSets: totalValueSets.size,
      errorCount: errorCount
    };
  }

  /**
   * Sort and rank rows based on various criteria
   */
  _sortAndRankRows(rows) {
    return rows.sort((a, b) => {
      // 1. Authoritative servers first
      if (a.authoritative !== b.authoritative) {
        return a.authoritative ? -1 : 1;
      }

      // 2. No errors before errors
      const aHasError = a.error !== '';
      const bHasError = b.error !== '';
      if (aHasError !== bHasError) {
        return aHasError ? 1 : -1;
      }

      // 3. More recent success first (smaller lastSuccess value)
      if (a.lastSuccess !== b.lastSuccess) {
        // If one has never succeeded, put it last
        if (a.lastSuccess === 0) return 1;
        if (b.lastSuccess === 0) return -1;
        return a.lastSuccess - b.lastSuccess;
      }

      // 4. More resources is better
      const aResources = a.systems + a.sets;
      const bResources = b.systems + b.sets;
      if (aResources !== bResources) {
        return bResources - aResources;
      }

      // 5. Prefer newer versions
      const versionCompare = this._compareVersions(b.version, a.version);
      if (versionCompare !== 0) {
        return versionCompare;
      }

      // 6. Alphabetical by server name as tie-breaker
      return a.serverName.localeCompare(b.serverName);
    });
  }

  // Release codes (R4, r4b ...) to the version prefix they select; anything else (4.0.1,
  // 4.0) is used as given. R4B and R2B can't be derived from the number alone.
  _normalizeFhirVersion(version) {
    if (!version) return version;
    return RELEASE_VERSIONS[version.toUpperCase()] || version;
  }

  /**
   * Compare semantic versions
   */
  _compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(p => parseInt(p) || 0);
    const parts2 = v2.split('.').map(p => parseInt(p) || 0);

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0;
      const p2 = parts2[i] || 0;
      if (p1 !== p2) {
        return p1 - p2;
      }
    }

    return 0;
  }

  /**
   * Find best server for a given code system/value set
   */
  findBestServer(type, url, version, language = '') {
    let rows;

    if (type === 'codesystem') {
      rows = this.buildRowsForCodeSystem({ codeSystem: url, version, language });
    } else if (type === 'valueset') {
      rows = this.buildRowsForValueSet({ valueSet: url, version, language });
    } else {
      throw new Error(`Unknown type: ${type}`);
    }

    if (rows.length === 0) {
      return null;
    }

    // Return the top-ranked server
    return rows[0];
  }

  /**
   * Get the current data (for direct access)
   */
  getData() {
    return this.crawler.getData();
  }

  /**
   * Express middleware for handling API requests
   */
  expressMiddleware() {
    return (req, res, next) => {
      // Attach API instance to request
      req.registryAPI = this;
      next();
    };
  }

  /**
   * NEW FUNCTION: Resolve the best server for a code system
   * Implements the ecosystem Resolution API for code systems
   */
  resolveCodeSystem(fhirVersion, codeSystem, authoritativeOnly, usage = '', language = '') {
    if (!fhirVersion) {
      throw new Error('A FHIR version is required');
    }
    if (!codeSystem) {
      throw new Error('A code system URL is required');
    }
    const normalizedVersion = this._normalizeFhirVersion(fhirVersion);
    const requestLangs = ServerRegistryUtilities.parseAcceptLanguage(language);

    const result = {
      formatVersion: '1',
      'registry-url': this.getData().address,
      authoritative: [],
      candidates: []
    };

    const matchedServers = [];
    const authMatches = []; // {entry, score} - sorted by language match before returning
    const data = this.crawler.getData();

    data.registries.forEach(registry => {
      registry.servers.forEach(server => {
        let added = false;

        // Excluded content is hidden from the ecosystem entirely for this server -
        // not authoritative, not a candidate
        if (server.isExcludedTarget(codeSystem)) return;

        // Check if server supports the requested usage tag
        if (server.usageList.length === 0 ||
          (usage && server.usageList.includes(usage))) {

          // Check if server is authoritative for this code system, taking language
          // specific claims into account (a language specific claim is invisible to
          // requests without a matching language)
          const authMatch = server.matchAuthCS(codeSystem, requestLangs);
          const isAuth = authMatch.isAuth;

          server.versions.forEach(version => {
            if (ServerRegistryUtilities.versionMatches(normalizedVersion, version.version)) {
              // Check if the server has the code system
              // Test against both the full URL and the base URL
              let content = {};
              const hasMatchingCS =
                // ServerRegistryUtilities.hasMatchingCodeSystem(baseCodeSystem, version.codeSystems, false, content) ||
                // (baseCodeSystem !== codeSystem &&
                  ServerRegistryUtilities.hasMatchingCodeSystem(codeSystem, version.codeSystems, false, content,
                      // we don't want cross version matching at this point for SNOMED. If a version is specified, we want a match
                      // to be decided: what about other code systems?
                      codeSystem.includes("snomed"));

              if (hasMatchingCS) {
                if (isAuth) {
                  authMatches.push({
                    entry: this.createServerEntry(server, version, null, authMatch),
                    score: authMatch.score
                  });
                } else if (!authoritativeOnly) {
                  const candidate = this.createServerEntry(server, version, content.content);
                  if (requestLangs) {
                    // the ecosystem has no knowledge of a candidate's language abilities -
                    // mark it so clients can apply their wildcard strictness policy
                    // (see 'Language Specific Claims' in the tx ecosystem IG)
                    candidate['language-support'] = 'unknown';
                  }
                  result.candidates.push(candidate);
                }
                added = true;
              }
            }
          });

          if (added) {
            matchedServers.push(server.code);
          }
        }
      });
    });

    // No fallback to servers that claim authority but don't host the code system: per the
    // ecosystem IG, 'Servers are not listed as authoritative unless they actually host the
    // CodeSystem(+version) in the request'.

    // Language specific matches rank before authoritative-list matches, most specific
    // match first. Array.prototype.sort is stable, so entries with equal scores (e.g.
    // all matched on the authoritative list) keep their existing (registration) order
    authMatches.sort((a, b) => a.score - b.score);
    result.authoritative = authMatches.map(m => m.entry);

    return {
      result: this._cleanEmptyArrays(result),
      matches: matchedServers.length > 0 ? matchedServers.join(',') : '--'
    };
  }

  /**
   * NEW FUNCTION: Resolve the best server for a value set
   * Implements the ecosystem Resolution API for value sets
   */
  // eslint-disable-next-line no-unused-vars -- language is accepted for API symmetry (see note below)
  resolveValueSet(fhirVersion, valueSet, authoritativeOnly, usage = '', language = '') {
    // Note: the language parameter is accepted for API symmetry with resolveCodeSystem,
    // but value set claims have no language dimension at this time (language specific
    // claims - the languages property - apply to code systems only), so it has no effect
    if (!fhirVersion) {
      throw new Error('A FHIR version is required');
    }
    if (!valueSet) {
      throw new Error('A value set URL is required');
    }

    const normalizedVersion = this._normalizeFhirVersion(fhirVersion);

    const result = {
      formatVersion: '1',
      'registry-url': this.getData().address,
      authoritative: [],
      candidates: []
    };

    const matchedServers = [];
    const data = this.crawler.getData();

    // Extract base value set URL (before any pipe)
    let baseValueSet = valueSet;
    if (valueSet.includes('|')) {
      baseValueSet = valueSet.substring(0, valueSet.indexOf('|'));
    }

    // Lock for thread safety during read
    data.registries.forEach(registry => {
      registry.servers.forEach(server => {
        let added = false;

        // Excluded content is hidden from the ecosystem entirely for this server -
        // not authoritative, not a candidate
        if (server.isExcludedTarget(valueSet)) return;

        // Check if server supports the requested usage tag
        if (server.usageList.length === 0 ||
          (usage && server.usageList.includes(usage))) {

          // Check if server is authoritative for this value set
          const isAuth = server.isAuthVS(baseValueSet);

          server.versions.forEach(version => {
            if (ServerRegistryUtilities.versionMatches(normalizedVersion, version.version)) {
              // For authoritative servers, we don't need to check if they have the value set
              if (isAuth) {
                result.authoritative.push(this.createServerEntry(server, version));
                added = true;
              }
              // For non-authoritative servers, check if they have the value set
              else if (ServerRegistryUtilities.hasMatchingValueSet(baseValueSet, version.valueSets, false) ||
                (baseValueSet !== valueSet &&
                  ServerRegistryUtilities.hasMatchingValueSet(valueSet, version.valueSets, false))) {
                if (!authoritativeOnly) {
                  result.candidates.push(this.createServerEntry(server, version));
                }
                added = true;
              }
            }
          });

          if (added) {
            matchedServers.push(server.code);
          }
        }
      });
    });

    return {
      result: this._cleanEmptyArrays(result),
      matches: matchedServers.length > 0 ? matchedServers.join(',') : '--'
    };
  }

  /**
   * The ecosystem Discovery API (GET {root} as JSON): one row per server endpoint.
   *
   * Filters, all optional: registry and server (codes), fhirVersion (RX or M.n.p), url (a
   * code system, url or url|version), authoritativeOnly, language (only with url).
   *
   * With url, only endpoints that host that code system are listed (an excluded code
   * system hides the server), and the row's 'candidate' list says whether it's hosted but
   * not claimed; authoritativeOnly then keeps only the endpoints authoritative for it.
   * Without url, authoritative/authoritative-valuesets are the server's claim masks and the
   * candidate lists are omitted - listing everything a server hosts would be huge.
   */
  discover(params = {}) {
    const { registry = '', server = '', fhirVersion = '', url = '', language = '' } = params;
    const authoritativeOnly = params.authoritativeOnly === true || params.authoritativeOnly === 'true';
    const normalizedVersion = this._normalizeFhirVersion(fhirVersion);
    const requestLangs = url ? ServerRegistryUtilities.parseAcceptLanguage(language) : null;
    const data = this.crawler.getData();

    const authRows = [];
    const otherRows = [];
    data.registries.forEach(reg => {
      if (registry && reg.code !== registry) return;
      reg.servers.forEach(srv => {
        if (server && srv.code !== server) return;
        if (url && srv.isExcludedTarget(url)) return;

        const authMatch = url ? srv.matchAuthCS(url, requestLangs) : { isAuth: false, scoped: false };

        srv.versions.forEach(version => {
          if (normalizedVersion && !ServerRegistryUtilities.versionMatches(normalizedVersion, version.version)) {
            return;
          }
          let hosted = false;
          if (url) {
            hosted = ServerRegistryUtilities.hasMatchingCodeSystem(url, version.codeSystems, false, {});
            if (!hosted || (authoritativeOnly && !authMatch.isAuth)) {
              return;
            }
          }

          const row = {
            'server-name': srv.name,
            'server-code': srv.code,
            'registry-name': reg.name,
            'registry-code': reg.code,
            'registry-url': reg.address,
            url: version.address,
            fhirVersion: version.version,
            error: version.error || null,
            'last-success': version.lastSuccess ? Math.floor(Date.now() - new Date(version.lastSuccess).getTime()) : null,
            systems: version.codeSystems.length,
            authoritative: [...srv.authCSList],
            'authoritative-valuesets': [...srv.authVSList]
          };
          if (url && !authMatch.isAuth) {
            row.candidate = [url];
          }
          if (authMatch.isAuth && authMatch.scoped) {
            row.languages = [authMatch.tag];
          }
          if (version.security) {
            row.security = version.security;
            Object.assign(row, securityFlags(version.security));
          }
          (authMatch.isAuth ? authRows : otherRows).push({ row, score: authMatch.score || 0 });
        });
      });
    });

    // Endpoints authoritative for url first (language specific matches before the rest;
    // sort is stable, so registration order is kept otherwise)
    authRows.sort((a, b) => a.score - b.score);
    return {
      'last-update': data.lastRun ? new Date(data.lastRun).toISOString() : null,
      'master-url': data.address,
      results: [...authRows, ...otherRows].map(r => r.row)
    };
  }

  _cleanEmptyArrays(result) {
    const cleanedResult = { ...result };

    // Remove empty arrays
    Object.keys(cleanedResult).forEach(key => {
      if (Array.isArray(cleanedResult[key]) && cleanedResult[key].length === 0) {
        delete cleanedResult[key];
      }
    });

    return cleanedResult;
  }

  /**
   * Helper function to create a server entry for resolve results
   * @param {Object} authMatch - optional result of server.matchAuthCS(); when the entry
   *   was matched on a language specific claim, the claim's language tag is reported so
   *   the client can tell language routing applied (vs falling through to the default server)
   */
  createServerEntry(server, version, content = null, authMatch = null) {
    const entry = {
      'server-name': server.name,
      url: version.address,
      fhirVersion: version.version
    };

    if (version.security) {
      entry.security = version.security;
      Object.assign(entry, securityFlags(version.security));
    }
    if (server.accessInfo) {
      entry.access_info = server.accessInfo;
    }
    // Report the content mode of the matched code system, if the server provided one
    // (per the resolve API in the tx ecosystem IG, candidates report content when known).
    // This was previously read from version.content, which doesn't exist - the value
    // passed by resolveCodeSystem was silently dropped.
    if (content) {
      entry.content = content;
    }
    if (authMatch && authMatch.scoped && authMatch.isAuth) {
      entry.languages = [authMatch.tag];
    }

    return entry;
  }

  /**
   * NEW FUNCTION: Render a JSON result as an HTML table
   * Renders a discovery result as an HTML table
   */
  renderJsonToHtml(json, path, regCode = '', serverCode = '', versionCode = '') {
    let html = '<table class="grid">\n';
    html += '<tr>\n';
    
    if (!regCode) {
      html += '<td><b>Registry</b></td>\n';
    }
    if (!serverCode) {
      html += '<td><b>Server</b></td>\n';
    }
    if (!versionCode) {
      html += '<td><b>FHIR Version</b></td>\n';
    }
    
    html += '<td><b>Url</b></td>\n';
    html += '<td><b>Status</b></td>\n';
    html += '<td><b>Content</b></td>\n';
    html += '<td><b>Authoritative</b></td>\n';
    html += '<td><b>Security</b></td>\n';
    html += '</tr>\n';

    const results = json.results || [];
    for (const row of results) {
      html += '<tr>\n';
      
      if (!regCode) {
        html += `<td><a href="${path}&registry=${row['registry-code']}">${escape(row['registry-name'])}</a></td>\n`;
      }
      if (!serverCode) {
        html += `<td><a href="${path}&server=${row['server-code']}">${escape(row['server-name'])}</a></td>\n`;
      }
      if (!versionCode) {
        html += `<td><a href="${path}&fhirVersion=${row.fhirVersion}">${row.fhirVersion}</a></td>\n`;
      }
      
      html += `<td><a href="${escape(row.url)}">${escape(row.url)}</a></td>\n`;
      
      if (row.error) {
        html += `<td><span style="color: maroon">Error: ${escape(row.error)}</span> Last OK ${this._formatDuration(row['last-success'])} ago</td>\n`;
      } else {
        html += `<td>Last OK ${this._formatDuration(row['last-success'])} ago</td>\n`;
      }
      
      html += `<td>${row.systems} systems</td>\n`;
      
      html += '<td>';
      if (row['is-authoritative']) {
        html += 'true';
      }
      html += '</td>\n';

      html += `<td>${row.security}/td>\n`;

      html += '</tr>\n';
    }

    html += '</table>\n';
    return html;
  }

  /**
   * NEW FUNCTION: Render registry info as HTML
   * Renders the registry tree as HTML
   */
  renderInfoToHtml() {
    const data = this.crawler.getData();
    let html = '<table class="grid">';
    
    html += `<tr><td width="130px"><img src="/assets/images/tx-registry-root.gif">&nbsp;Registries</td><td>${data.address} (${escape(data.outcome)})</td></tr>`;
    
    data.registries.forEach(registry => {
      if (registry.error) {
        html += `<tr><td title="${escape(registry.name)}">&nbsp;<img src="/assets/images/tx-registry.png">&nbsp;${registry.code}</td><td><a href="${escape(registry.address)}">${escape(registry.address)}</a>. Error: ${escape(registry.error)}</td></tr>`;
      } else {
        html += `<tr><td title="${escape(registry.name)}">&nbsp;&nbsp;<img src="/assets/images/tx-registry.png">&nbsp;${registry.code}</td><td><a href="${escape(registry.address)}">${escape(registry.address)}</a></td></tr>`;
      }
      
      registry.servers.forEach(server => {
        if (server.authCSList.length > 0 || server.authVSList.length > 0 || server.usageList.length > 0) {
          html += `<tr><td title="${escape(server.name)}">&nbsp;&nbsp;&nbsp;&nbsp;<img src="/assets/images/tx-server.png">&nbsp;${server.code}</td><td><a href="${escape(server.address)}">${escape(server.address)}</a>. ${server.description}</td></tr>`;
        } else {
          html += `<tr><td title="${escape(server.name)}">&nbsp;&nbsp;&nbsp;&nbsp;<img src="/assets/images/tx-server.png">&nbsp;${server.code}</td><td><a href="${escape(server.address)}">${escape(server.address)}</a></td></tr>`;
        }
        
        server.versions.forEach(version => {
          // Get major.minor version only
          const versionParts = version.version.split('.');
          const majorMinor = versionParts.slice(0, 2).join('.');
          
          html += `<tr><td>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<img src="/assets/images/tx-version.png">&nbsp;v${majorMinor}</td><td><a href="${escape(version.address)}">${escape(version.address)}</a>. Status: ${escape(version.details)}. ${version.codeSystems.length} CodeSystems, ${version.valueSets.length} ValueSets</td></tr>`;
        });
      });
    });
    
    html += '</table>';
    return html;
  }

  /**
   * Helper function to format a duration in seconds to a human-readable string
   */
  _formatDuration(seconds) {
    if (seconds < 60) {
      return `${seconds} seconds`;
    } else if (seconds < 3600) {
      return `${Math.floor(seconds / 60)} minutes`;
    } else if (seconds < 86400) {
      return `${Math.floor(seconds / 3600)} hours`;
    } else {
      return `${Math.floor(seconds / 86400)} days`;
    }
  }

  /**
   * Helper function to escape HTML special characters
   */
  _escapeHtml(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

module.exports = RegistryAPI;