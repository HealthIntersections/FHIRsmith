// registry-model.js
// Data model for terminology server registry
const escape = require('escape-html');

class ServerVersionInformation {
  constructor() {
    this.version = '';
    this.address = '';
    this.security = '';
    this.error = '';
    this.lastSuccess = null; // Date object
    this.lastTat = '';
    this.software = ''; // what software is running
    this.softwareVersion = ''; // CapabilityStatement.software.version, if the server reports one
    this.softwareReleaseDate = ''; // CapabilityStatement.software.releaseDate, if it is a real date
    this.codeSystems = []; // Array of strings (sorted, unique)
    this.valueSets = []; // Array of strings (sorted, unique)
  }

  update(source) {
    this.address = source.address;
    this.error = source.error;
    if (!source.error) {
      this.security = source.security;
      this.lastSuccess = source.lastSuccess;
      this.codeSystems = [...source.codeSystems];
      this.valueSets = [...source.valueSets];
      this.lastTat = source.lastTat;
    }
  }

  getDetails() {
    let result = this.error ? this.error : 'Server Processed Ok';
    const lastSeenStr = this.lastSuccess ? this.lastSuccess.toISOString() : 'never';
    result += ` (last seen ${lastSeenStr}, last tat = ${this.lastTat})`;
    return result;
  }

  getCsListHtml() {
    if (this.codeSystems.length === 0) return '<ul></ul>';
    return '<ul>' + this.codeSystems.map(cs => 
      `<li>${escape(cs.uri+(cs.version ? '|'+cs.version : ''))}</li>`
    ).join('') + '</ul>';
  }

  getVsListHtml() {
    if (this.valueSets.length === 0) return '<ul></ul>';
    return '<ul>' + this.valueSets.map(vs => 
      `<li>${escape(vs)}</li>`
    ).join('') + '</ul>';
  }

  toJSON() {
    return {
      version: this.version,
      address: this.address,
      security: this.security,
      error: this.error,
      'last-success': this.lastSuccess?.toISOString() || '',
      lastTat: this.lastTat,
      terminologies: this.codeSystems,
      software: this.software,
      'software-version': this.softwareVersion,
      'software-release-date': this.softwareReleaseDate,
      valuesets: this.valueSets
    };
  }

  static fromJSON(json) {
    const instance = new ServerVersionInformation();
    instance.version = json.version || '';
    instance.address = json.address || '';
    instance.security =  typeof json.security === 'string' ? json.security : "";
    instance.error = json.error || '';
    instance.lastSuccess = json['last-success'] ? new Date(json['last-success']) : null;
    instance.lastTat = json.lastTat || '';
    instance.software = json.software;
    instance.softwareVersion = json['software-version'] || '';
    instance.softwareReleaseDate = json['software-release-date'] || '';
    instance.codeSystems = json.terminologies || [];
    instance.valueSets = json.valuesets || [];
    return instance;
  }
}

class ServerInformation {
  constructor() {
    this.code = '';
    this.name = '';
    this.address = '';
    this.accessInfo = '';
    this.authCSList = []; // Authoritative code systems (with wildcards)
    this.authVSList = []; // Authoritative value sets (with wildcards)
    this.usageList = []; // Usage tags
    this.languages = {}; // Language specific authoritative claims: BCP-47 tag -> list of CS masks
    this.exclusions = []; // CodeSystem/ValueSet masks hidden from the ecosystem entirely
    this.versions = []; // Array of ServerVersionInformation
  }

  getVersion(ver) {
    return this.versions.find(v => v.version === ver) || null;
  }

  update(source) {
    this.name = source.name;
    this.address = source.address;
    this.accessInfo = source.accessInfo;
    this.authCSList = [...source.authCSList];
    this.authVSList = [...source.authVSList];
    this.usageList = [...source.usageList];
    this.languages = {};
    Object.keys(source.languages || {}).forEach(tag => {
      this.languages[tag] = [...source.languages[tag]];
    });
    this.exclusions = [...(source.exclusions || [])];
    
    source.versions.forEach(sourceVersion => {
      const existing = this.getVersion(sourceVersion.version);
      if (existing) {
        existing.update(sourceVersion);
      } else {
        this.versions.push(sourceVersion);
      }
    });
  }

  getDetails() {
    return this.accessInfo;
  }

  isAuthCS(codeSystem) {
    return !this.isExcludedTarget(codeSystem) &&
      this.authCSList.some(mask => this._passesMask(mask, codeSystem));
  }

  isAuthVS(valueSet) {
    return !this.isExcludedTarget(valueSet) &&
      this.authVSList.some(mask => this._passesMask(mask, valueSet));
  }

  /**
   * True if the code system / value set is hidden from the ecosystem for this server
   * (matches an entry in exclusions). Excluded content is hidden entirely: the server
   * is never offered for it, neither as authoritative nor as a candidate, even if an
   * authoritative mask (or language specific claim) would otherwise match it.
   * Masks are tested against both the full canonical (url|version) and the base url.
   */
  isExcludedTarget(value) {
    return (this.exclusions || []).some(mask => this._passesMaskEx(mask, value, true));
  }

  /**
   * Match this server's authoritative claims for a code system, taking language specific
   * claims (the languages property: BCP-47 tag -> mask list) into account.
   *
   * Language specific claims are only visible when the request specifies a language. A
   * claimed tag is inherently a mask: it covers a request language that is equal to it or
   * more specific ('de' covers 'de' and 'de-AT'; 'de-AT' does not cover plain 'de'). The
   * best match is on the earliest (heaviest) request language, then the most specific
   * claimed tag. Claims in the authoritative list apply irrespective of language, but rank
   * after all language specific matches (score = MAX_SAFE_INTEGER).
   *
   * @param {string} codeSystem - canonical url or url|version
   * @param {Array|null} requestLangs - parsed Accept-Language list ([{tag, q}] in descending
   *   weight order, per ServerRegistryUtilities.parseAcceptLanguage), or null for no language
   * @param {boolean} maskBase - also test masks against the base URL (before '|'), matching
   *   the semantics of hasMatchingCodeSystem as used for the discovery rows
   * @returns {Object} {isAuth: boolean, scoped: boolean, tag?: string, score: number}
   *   score: lower is better - earlier request languages and more specific tags win
   */
  matchAuthCS(codeSystem, requestLangs = null, maskBase = false) {
    // excluded content is hidden entirely - no claim of any kind can match it
    if (this.isExcludedTarget(codeSystem)) {
      return { isAuth: false, scoped: false, score: Number.MAX_SAFE_INTEGER };
    }

    const masksMatch = (masks) => masks.some(mask => this._passesMaskEx(mask, codeSystem, maskBase));

    if (requestLangs && requestLangs.length > 0 && this.languages) {
      let best = null;
      for (let i = 0; i < requestLangs.length; i++) {
        for (const tag of Object.keys(this.languages)) {
          if (!ServerRegistryUtilities.languageTagCovers(tag, requestLangs[i].tag)) continue;
          if (!masksMatch(this.languages[tag] || [])) continue;
          // earlier request language (higher weight) dominates; then longer (more specific) tag
          const score = i * 1000 + (256 - tag.length);
          if (!best || score < best.score) {
            best = { isAuth: true, scoped: true, tag, score };
          }
        }
        if (best) return best; // don't consider later (lighter) request languages
      }
    }
    if (masksMatch(this.authCSList)) {
      return { isAuth: true, scoped: false, score: Number.MAX_SAFE_INTEGER };
    }
    return { isAuth: false, scoped: false, score: Number.MAX_SAFE_INTEGER };
  }

  _passesMaskEx(mask, value, includeBase) {
    if (this._passesMask(mask, value)) return true;
    if (includeBase && value.includes('|')) {
      return this._passesMask(mask, value.substring(0, value.indexOf('|')));
    }
    return false;
  }

  _passesMask(mask, value) {
    if (mask.endsWith('*')) {
      return value.startsWith(mask.slice(0, -1));
    }
    return value === mask;
  }

  getDescription() {
    let result = '';

    if (this.usageList.length > 0) {
      result = `Usage Tags: ${this.usageList.join(', ')}`;
    }

    const langTags = Object.keys(this.languages || {});
    if (langTags.length > 0) {
      if (result) result += '. ';
      result += 'Authoritative for particular languages: <ul>';
      langTags.forEach(tag => {
        (this.languages[tag] || []).forEach(mask => {
          const escaped = escape(mask).replace(/\*/g, '<b>*</b>');
          result += `<li>${escape(tag)}: ${escaped}</li>`;
        });
      });
      result += '</ul>';
    }

    if (this.exclusions && this.exclusions.length > 0) {
      if (result) result += '. ';
      result += 'Excluded (hidden from the ecosystem): <ul>';
      this.exclusions.forEach(mask => {
        const escaped = escape(mask).replace(/\*/g, '<b>*</b>');
        result += `<li>${escaped}</li>`;
      });
      result += '</ul>';
    }

    if (this.authCSList.length > 0) {
      if (result) result += '. ';
      result += 'Authoritative for the following CodeSystems: <ul>';
      this.authCSList.forEach(cs => {
        const escaped = escape(cs).replace(/\*/g, '<b>*</b>');
        result += `<li>${escaped}</li>`;
      });
      result += '</ul>';
    }
    
    if (this.authVSList.length > 0) {
      if (result) result += '. ';
      result += 'Authoritative for the following ValueSets: <ul>';
      this.authVSList.forEach(vs => {
        const escaped = escape(vs).replace(/\*/g, '<b>*</b>');
        result += `<li>${escaped}</li>`;
      });
      result += '</ul>';
    }
    
    return result;
  }

  toJSON() {
    return {
      code: this.code,
      name: this.name,
      address: this.address,
      'access-info': this.accessInfo,
      authoritative: this.authCSList.join(','),
      'authoritative-valuesets': this.authVSList.join(','),
      usageList: this.usageList,
      languages: this.languages,
      exclusions: this.exclusions.join(','),
      versions: this.versions.map(v => v.toJSON())
    };
  }

  static fromJSON(json) {
    const instance = new ServerInformation();
    instance.code = json.code || '';
    instance.name = json.name || '';
    instance.address = json.address || '';
    instance.accessInfo = json['access-info'] || '';
    instance.authCSList = json.authoritative
      ? json.authoritative.split(',').filter(s => s)
      : [];
    instance.authVSList = json['authoritative-valuesets']
      ? json['authoritative-valuesets'].split(',').filter(s => s)
      : [];
    instance.usageList = json.usageList || [];
    // languages is an object (tag -> mask list); tolerate legacy/absent data
    instance.languages = (json.languages && typeof json.languages === 'object' && !Array.isArray(json.languages))
      ? json.languages
      : {};
    instance.exclusions = json.exclusions
      ? json.exclusions.split(',').filter(s => s)
      : [];
    instance.versions = (json.versions || []).map(v => ServerVersionInformation.fromJSON(v));
    return instance;
  }
}

class ServerRegistry {
  constructor() {
    this.code = '';
    this.name = '';
    this.address = '';
    this.authority = '';
    this.error = '';
    this.servers = []; // Array of ServerInformation
  }

  getServer(code) {
    return this.servers.find(s => s.code === code) || null;
  }

  update(source) {
    this.name = source.name;
    this.address = source.address;
    this.authority = source.authority;
    this.error = source.error;
    
    source.servers.forEach(sourceServer => {
      const existing = this.getServer(sourceServer.code);
      if (existing) {
        existing.update(sourceServer);
      } else {
        this.servers.push(sourceServer);
      }
    });
  }

  toJSON() {
    return {
      code: this.code,
      name: this.name,
      address: this.address,
      authority: this.authority,
      error: this.error,
      servers: this.servers.map(s => s.toJSON())
    };
  }

  static fromJSON(json) {
    const instance = new ServerRegistry();
    instance.code = json.code || '';
    instance.name = json.name || '';
    instance.address = json.address || '';
    instance.authority = json.authority || '';
    instance.error = json.error || '';
    instance.servers = (json.servers || []).map(s => ServerInformation.fromJSON(s));
    return instance;
  }
}

class ServerRegistries {
  constructor() {
    this.address = '';
    this.doco = '';
    this.lastRun = null; // Date object
    this.outcome = '';
    this.registries = []; // Array of ServerRegistry
    this._lockName = null; // For tracking lock state
  }

  lock(name) {
    // In Node.js, we might use async locks or mutexes
    // For now, this is a simple flag-based approach
    this._lockName = name;
  }

  unlock() {
    this._lockName = null;
  }

  getRegistry(code) {
    return this.registries.find(r => r.code === code) || null;
  }

  update(source) {
    this.lastRun = source.lastRun;
    this.outcome = source.outcome;
    this.doco = source.doco;
    
    source.registries.forEach(sourceRegistry => {
      const existing = this.getRegistry(sourceRegistry.code);
      if (existing) {
        existing.update(sourceRegistry);
      } else {
        this.registries.push(sourceRegistry);
      }
    });
  }

  toJSON() {
    return {
      version: '1',
      address: this.address,
      doco: this.doco,
      'last-run': this.lastRun?.toISOString() || '',
      outcome: this.outcome,
      registries: this.registries.map(r => r.toJSON())
    };
  }

  static fromJSON(json) {
    if (json.version !== '1') {
      throw new Error(`Unsupported version ${json.version}`);
    }
    
    const instance = new ServerRegistries();
    instance.address = json.address || '';
    instance.doco = json.doco || '';
    instance.lastRun = json['last-run'] ? new Date(json['last-run']) : null;
    instance.outcome = json.outcome || '';
    instance.registries = (json.registries || []).map(r => ServerRegistry.fromJSON(r));
    return instance;
  }
}

// ServerRow is a flattened representation for API responses
class ServerRow {
  constructor() {
    this.serverName = '';
    this.serverCode = '';
    this.registryName = '';
    this.registryCode = '';
    this.registryUrl = '';
    this.authCSList = [];
    this.authVSList = [];
    this.version = '';
    this.url = '';
    this.error = '';
    this.security = '';
    this.lastSuccess = 0; // milliseconds since last success
    this.systems = 0; // count of code systems
    this.sets = 0; // count of value sets
    this.authoritative = false;
    this.languages = []; // language tag(s) of the language specific claim matched (empty = none)
  }

  toJSON() {
    const json = {
      'server-name': this.serverName,
      'server-code': this.serverCode,
      'registry-name': this.registryName,
      'registry-code': this.registryCode,
      'registry-url': this.registryUrl,
      url: this.url,
      version: this.version,
      error: this.error,
      'last-success': this.lastSuccess,
      systems: this.systems,
      security: this.security,
      sets: this.sets
    };
    
    if (this.authoritative) {
      json['is-authoritative'] = true;
    }
    
    if (this.authCSList.length > 0) {
      json.authoritative = this.authCSList;
    }
    
    if (this.authVSList.length > 0) {
      json['authoritative-valuesets'] = this.authVSList;
    }

    if (this.languages.length > 0) {
      json.languages = this.languages;
    }

    return json;
  }

  static fromJSON(json) {
    const instance = new ServerRow();
    instance.serverName = json['server-name'] || '';
    instance.serverCode = json['server-code'] || '';
    instance.registryName = json['registry-name'] || '';
    instance.registryCode = json['registry-code'] || '';
    instance.registryUrl = json['registry-url'] || '';
    instance.url = json.url || '';
    instance.version = json.version || '';
    instance.error = json.error || '';
    instance.lastSuccess = json['last-success'] || 0;
    instance.systems = json.systems || 0;
    instance.sets = json.sets || 0;
    instance.authoritative = json['is-authoritative'] || false;
    instance.authCSList = json.authoritative || [];
    instance.authVSList = json['authoritative-valuesets'] || [];
    instance.security = json['security'] || '';
    instance.languages = json.languages || [];

    return instance;
  }
}

// Utility functions for registry matching and row building
class ServerRegistryUtilities {
  static passesMask(mask, value) {
    if (mask.endsWith('*')) {
      return value.startsWith(mask.slice(0, -1));
    }
    return value === mask;
  }

  /**
   * Parse an Accept-Language style value ('de', 'de-AT, de;q=0.9, en;q=0.1') into
   * an ordered list of {tag, q}, highest weight first. Wildcards ('*') and zero-weight
   * entries are dropped - they don't constrain routing. Returns null when nothing usable.
   */
  static parseAcceptLanguage(value) {
    if (!value || typeof value !== 'string') return null;
    const items = [];
    for (const part of value.split(',')) {
      const pieces = part.trim().split(';').map(p => p.trim());
      const tag = pieces[0];
      if (!tag || tag === '*') continue;
      let q = 1.0;
      for (let i = 1; i < pieces.length; i++) {
        const m = /^q\s*=\s*([0-9.]+)$/i.exec(pieces[i]);
        if (m) q = parseFloat(m[1]);
      }
      if (!(q > 0)) continue;
      items.push({ tag, q });
    }
    if (items.length === 0) return null;
    items.sort((a, b) => b.q - a.q); // stable: preserves order among equal weights
    return items;
  }

  /**
   * BCP-47 tags are hierarchical, so a tag is inherently a mask: a scoped tag covers a
   * request language that is equal to it, or more specific (on '-' boundaries).
   * languageTagCovers('de', 'de-AT') = true; ('de', 'dent') = false; ('de-AT', 'de') = false.
   */
  static languageTagCovers(scopedTag, requestTag) {
    if (!scopedTag || !requestTag) return false;
    const s = scopedTag.toLowerCase();
    const r = requestTag.toLowerCase();
    return r === s || r.startsWith(s + '-');
  }

  static hasMatchingCodeSystem(cs, list, supportMask, content, noVersionIndependentMatching = false) {
    if (!cs || list.length === 0) return false;

    // Handle URLs with pipes - extract base URL
    let baseCs = cs;
    if (cs.includes('|') && !noVersionIndependentMatching) {
      baseCs = cs.substring(0, cs.indexOf('|'));
    }

    return list.some(item => {
      // If we support wildcards (masks) and the item ends with "*", do prefix matching
      let vurl = item.uri ? item.version ? item.uri+"|"+item.version : item.uri : item;
      let ok = false;
      if (supportMask && vurl.endsWith('*')) {
        const prefix = vurl.slice(0, -1);
        ok = cs.startsWith(prefix) || baseCs.startsWith(prefix);
      } else {
        // Otherwise do exact matching on both full and base URL
        ok = vurl === cs || vurl === baseCs;
        // A SNOMED CT version URI extends its edition URI, so a server hosting
        // sct|.../{edition}/version/{date} hosts the edition sct|.../{edition}. Servers
        // list only full versions, so without this an edition-level request would never
        // find the servers that host the edition.
        if (!ok && noVersionIndependentMatching && cs.includes('|')) {
          ok = vurl.startsWith(cs + '/');
        }
      }
      if (ok && content) {
        content.content = item.content;
      }
      return ok;
    });
  }

  static hasMatchingValueSet(vs, list, supportMask) {
    let baseVs = vs;
    if (vs.includes('|')) {
      baseVs = vs.substring(0, vs.indexOf('|'));
    }
    
    return list.some(item => {
      if (supportMask && this.passesMask(item, vs)) {
        return true;
      }
      if (!supportMask && (item === vs || item === baseVs)) {
        return true;
      }
      return false;
    });
  }

  static versionMatches(requested, available) {
    // Simple semantic version matching
    if (!requested || !available) return true;
    
    if (requested === available) return true;
    
    // Check if available starts with requested version
    // e.g., "4.0" matches "4.0.1"
    if (available.startsWith(requested + '.')) return true;
    
    // More sophisticated semver matching could be added here
    const requestedParts = requested.split('.');
    const availableParts = available.split('.');
    
    for (let i = 0; i < requestedParts.length; i++) {
      if (i >= availableParts.length) return false;
      if (requestedParts[i] !== availableParts[i]) return false;
    }
    
    return true;
  }

  static createRow(registry, server, version, isAuthoritative) {
    const row = new ServerRow();
    
    row.authoritative = isAuthoritative;
    row.serverName = server.name;
    row.serverCode = server.code;
    row.registryName = registry.name;
    row.registryCode = registry.code;
    row.registryUrl = registry.address;
    
    row.url = version.address;
    row.error = version.error;
    row.version = version.version;
    row.security = version.security;
    row.systems = version.codeSystems.length;
    row.sets = version.valueSets.length;
    row.authCSList = [...server.authCSList];
    row.authVSList = [...server.authVSList];
    
    // Calculate milliseconds since last success
    if (version.lastSuccess) {
      row.lastSuccess = Math.floor(Date.now() - version.lastSuccess.getTime());
    } else {
      row.lastSuccess = 0;
    }
    
    return row;
  }
}

module.exports = {
  ServerVersionInformation,
  ServerInformation,
  ServerRegistry,
  ServerRegistries,
  ServerRow,
  ServerRegistryUtilities
};