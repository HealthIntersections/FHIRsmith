const axios = require('axios');
const Logger = require('../library/logger');
const { ServerCredentials } = require('../library/server-credentials');
const { createGuardedAgents } = require('../library/ssrf-guard');

/**
 * Finds another server in the terminology ecosystem for a code system (and version) that this
 * server doesn't hold, by asking the ecosystem registry, and talks to it (modules.tx.ecosystem,
 * see README.md). Provider.getCodeSystemProvider() uses it when it can't resolve a code system
 * itself, and hands the result to a VirtualCodeSystemProvider (cs/cs-virtual.js), which sends its
 * requests through here.
 *
 * A server is used if it's open, or if there are credentials for it (an API key or OAuth client
 * credentials, under its code in the registry, as the registry module has them)
 *
 * The operation context passed in (opContext) has every request this sends for it counted
 * (opContext.externalRequests), so the operation is counted as an external request: what is
 * already known (cached) costs nothing, and isn't counted.
 *
 * What the registry and the servers say about themselves is kept for an hour, and then refreshed
 * in the background: the request that finds it due uses what's known, and doesn't wait (only the
 * first request for something waits for it). The servers' answers to $lookup and $validate-code
 * are kept for an hour too (sendCached), and the same request asked twice at once is only sent
 * once.
 *
 * Every request (to the registry, to the servers it names, and for OAuth tokens) goes through the
 * SSRF guard (library/ssrf-guard.js): only public addresses, unless allowPrivateAddresses is set
 */

/**
 * The header on every request made to another server on behalf of an operation here. A
 * request that arrives with it is never resolved through the ecosystem again, so two
 * servers can't hand a request back and forth
 */
const FORWARDED_HEADER = 'X-FHIRsmith-Ecosystem-Forwarded';

const DEFAULT_REGISTRY = 'https://ecosystem.hl7.org/tx-reg';
// how an R4 (or R3) TerminologyCapabilities says what content it has for a code system
const CAPS_CONTENT_EXT = 'http://hl7.org/fhir/5.0/StructureDefinition/extension-TerminologyCapabilities.codeSystem.content';
const TIMEOUT_MS = 30000; // for the whole request, not just until the answer starts
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // a TerminologyCapabilities is under 1 MB
const CACHE_MS = 60 * 60 * 1000; // what the registry and the servers say is kept for an hour
const RETRY_MS = 5 * 60 * 1000; // a refresh that failed is tried again after this (the old answer is kept)
const MAX_ANSWERS = 10000; // the most answers (to $lookup and $validate-code) kept
const MAX_KNOWN = 1000; // the most entries kept in each of the caches of what the registry and the servers say (#known)

class EcosystemResolver {
  /**
   * @param {Object} config - modules.tx.ecosystem, as checked by EcosystemResolver.checkConfig
   */
  constructor(config) {
    const registry = config.registry || DEFAULT_REGISTRY;
    this.registry = registry.endsWith('/') ? registry.substring(0, registry.length - 1) : registry;
    this.excludedServers = (config.excludedServers || []).map(e => EcosystemResolver.normalise(e));
    this.excludedPatterns = (config.excludedPatterns || []).map(p => EcosystemResolver.patternToRegex(p));
    this.agents = createGuardedAgents({ allowPrivate: config.allowPrivateAddresses === true });
    this.credentials = new ServerCredentials({
      apiKeys: config.apiKeys,
      oauth: config.oauth,
      timeout: TIMEOUT_MS,
      signal: () => AbortSignal.timeout(TIMEOUT_MS),
      userAgent: 'FHIRsmith (ecosystem resolution)',
      agents: () => this.agents
    });
    this.log = Logger.getInstance().child({module: 'tx-ecosystem'});
    // see #known: system|version -> server address (or null); server -> its code systems; and
    // the registry's list of servers (normalised address -> server code)
    this.servers = new Map();
    this.versions = new Map();
    // server|system -> the versions a search of the server's CodeSystems found (see searchVersions)
    this.searched = new Map();
    this.codes = new Map();
    // see sendCached: request -> {at, value} or {pending}, oldest first
    this.answers = new Map();
  }

  /**
   * Check modules.tx.ecosystem, and say what's wrong with it, if anything
   *
   * @returns {Object|null} the configuration, if it's in use
   */
  static checkConfig(cfg) {
    if (cfg === undefined || cfg === null) {
      return null;
    }
    const fail = (why) => { throw new Error(`modules.tx.ecosystem: ${why}`); };
    if (typeof cfg !== 'object' || Array.isArray(cfg)) {
      fail(`must be an object, not ${JSON.stringify(cfg)}`);
    }
    for (const name of ['use', 'allowPrivateAddresses']) {
      if (cfg[name] !== undefined && typeof cfg[name] !== 'boolean') {
        fail(`${name} must be true or false, not ${JSON.stringify(cfg[name])}`);
      }
    }
    if (cfg.registry !== undefined && (typeof cfg.registry !== 'string' || !/^https?:\/\/\S+$/.test(cfg.registry))) {
      fail(`registry must be the address of an ecosystem registry (e.g. ${DEFAULT_REGISTRY}), not ${JSON.stringify(cfg.registry)}`);
    }
    for (const name of ['excludedServers', 'excludedPatterns']) {
      const v = cfg[name];
      if (v !== undefined && (!Array.isArray(v) || v.some(e => typeof e !== 'string' || !e.trim()))) {
        fail(`${name} must be a list of strings, not ${JSON.stringify(v)}`);
      }
    }
    if (cfg.apiKeys !== undefined && (typeof cfg.apiKeys !== 'object' || Array.isArray(cfg.apiKeys) || Object.values(cfg.apiKeys).some(v => typeof v !== 'string'))) {
      fail('apiKeys must be an object: server code -> API key');
    }
    if (cfg.oauth !== undefined) {
      if (typeof cfg.oauth !== 'object' || Array.isArray(cfg.oauth)) {
        fail('oauth must be an object: server code -> { tokenEndpoint, clientId, clientSecret, scope }');
      }
      for (const [code, o] of Object.entries(cfg.oauth)) {
        if (!o || typeof o !== 'object' || !o.tokenEndpoint || !o.clientId || !o.clientSecret) {
          fail(`oauth.${code} needs a tokenEndpoint, clientId and clientSecret`);
        }
        if (!/^https:\/\//i.test(o.tokenEndpoint)) {
          fail(`oauth.${code}.tokenEndpoint must be an https: URL`);
        }
      }
    }
    return cfg.use === true ? cfg : null;
  }

  /**
   * an address without its scheme or a trailing /, in lower case
   */
  static normalise(address) {
    let s = address.trim().toLowerCase().replace(/^[a-z]+:\/\//, '');
    while (s.endsWith('/')) {
      s = s.substring(0, s.length - 1);
    }
    return s;
  }

  /**
   * a pattern as the registry has them: * matches anything
   */
  static patternToRegex(p) {
    return new RegExp('^' + p.trim().split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  }

  isExcludedServer(address) {
    const a = EcosystemResolver.normalise(address);
    return this.excludedServers.some(e => a === e || a.startsWith(e + '/') || a.startsWith(e + ':'));
  }

  /**
   * True if the code system (or version) is never looked for in the ecosystem: it matches one of
   * modules.tx.ecosystem.excludedPatterns. Checked before the registry is asked anything
   */
  isExcludedSystem(system, version) {
    return this.excludedPatterns.some(r => r.test(system) || (version && r.test(system + '|' + version)));
  }

  static fhirVersionFor(v) {
    return v === 3 ? '3.0' : v === 4 ? '4.0' : '5.0';
  }

  /**
   * The code a server has in the registry (what its credentials are under), from the registry's
   * list of servers
   */
  async serverCode(address, opContext = null) {
    const map = await this.#known(this.codes, 'listing', async (ctxt) => {
      const json = await this.getRegistryJson(this.registry, ctxt);
      const m = new Map();
      for (const r of json.results || []) {
        if (r.url && r['server-code']) {
          m.set(EcosystemResolver.normalise(r.url), r['server-code']);
        }
      }
      return m;
    }, opContext, (e) => `Unable to read the list of servers from ${this.registry}: ${e.message}`);
    return (map && map.get(EcosystemResolver.normalise(address))) || null;
  }

  /**
   * What the registry or a server says, kept in cache under key (an hour), loaded by loader if
   * it isn't known. When it's due for a refresh, what's known is returned, and loaded again in the
   * background (not counted against the operation: it doesn't wait for it). A loader that fails
   * (throws) gives null, the first time; on a refresh, the old answer is kept, and the refresh is
   * tried again in a few minutes. The same thing asked for twice at once is only loaded once
   *
   * @param {Map} cache - key -> {at, value, pending, refreshing}
   * @param {function(OperationContext)} loader
   * @param {function(Error): string} why - the warning when it fails
   */
  async #known(cache, key, loader, opContext, why) {
    const now = Date.now();
    const entry = cache.get(key);
    if (entry) {
      // most recently used: the last to be dropped (see #remember)
      this.#remember(cache, key, entry);
    }
    if (entry && entry.pending) {
      // waiting for it is waiting on another server
      if (opContext && opContext.countExternalRequest) {
        opContext.countExternalRequest();
      }
      return entry.pending;
    }
    if (entry && 'value' in entry) {
      if (now - entry.at >= CACHE_MS && !entry.refreshing) {
        entry.refreshing = true;
        loader(null).then(value => {
          this.#remember(cache, key, { at: Date.now(), value });
        }).catch(e => {
          this.log.warn(why(e) + ' (still using what it said before)');
          entry.at = Date.now() - CACHE_MS + RETRY_MS;
        }).finally(() => {
          entry.refreshing = false;
        });
      }
      return entry.value;
    }
    const pending = loader(opContext).then(value => {
      this.#remember(cache, key, { at: Date.now(), value });
      return value;
    }, e => {
      // not known: null for now, and asked again (in the background) in a few minutes
      this.log.warn(why(e));
      this.#remember(cache, key, { at: Date.now() - CACHE_MS + RETRY_MS, value: null });
      return null;
    });
    this.#remember(cache, key, { pending });
    return pending;
  }

  /**
   * Keep entry under key, as the most recently used, and drop the least recently used beyond
   * MAX_KNOWN. Some of these caches are keyed by what requests ask for (a system and version), so
   * without a limit they would grow with every code system anyone names
   */
  #remember(cache, key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > MAX_KNOWN) {
      cache.delete(cache.keys().next().value);
    }
  }

  /**
   * Every request to another server goes through here: it's counted against the operation
   */
  async #request(opContext, config) {
    if (opContext && opContext.countExternalRequest) {
      opContext.countExternalRequest();
    }
    return axios.request(config);
  }

  async getRegistryJson(url, opContext = null) {
    const response = await this.#request(opContext, {
      url,
      method: 'GET',
      headers: { 'Accept': 'application/json', [FORWARDED_HEADER]: 'true' },
      timeout: TIMEOUT_MS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      validateStatus: () => true,
      maxContentLength: MAX_RESPONSE_BYTES,
      httpAgent: this.agents.httpAgent,
      httpsAgent: this.agents.httpsAgent
    });
    if (response.status !== 200 || !response.data || typeof response.data !== 'object') {
      throw new Error(`${url} returned ${response.status}`);
    }
    return response.data;
  }

  /**
   * Send a request to another server, with its credentials, if it has any. An OAuth token that
   * the server refuses (401) is renewed, and the request sent once more
   *
   * @param {string} server - the server's address
   * @param {string} url - the request
   * @param {Object} [body] - a JSON body (POST), or none (GET)
   * @param {OperationContext} [opContext] - the operation it's for
   * @returns {Promise<{status: number, json: Object|null}>}
   */
  async send(server, url, body = null, opContext = null) {
    const code = await this.serverCode(server, opContext);
    const attempt = async (renew) => {
      const headers = Object.assign({ 'Accept': 'application/fhir+json', [FORWARDED_HEADER]: 'true' },
        code ? await this.credentials.headers(code, renew) : {});
      if (body) {
        headers['Content-Type'] = 'application/fhir+json';
      }
      return this.#request(opContext, {
        url,
        method: body ? 'POST' : 'GET',
        headers,
        data: body ? JSON.stringify(body) : undefined,
        timeout: TIMEOUT_MS,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        validateStatus: () => true,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxRedirects: 0, // the credentials go where they were configured to, or nowhere
        httpAgent: this.agents.httpAgent,
        httpsAgent: this.agents.httpsAgent
      });
    };
    let response = await attempt(false);
    if (response.status === 401 && code && this.credentials.getOAuthConfig(code)) {
      response = await attempt(true);
    }
    const json = response.data && typeof response.data === 'object' ? response.data : null;
    return { status: response.status, json };
  }

  /**
   * The address of the first server that the registry says can provide system|version, and that
   * can be used (see findServers), or null
   */
  async findServer(system, version, fhirVersion, opContext = null) {
    const servers = await this.findServers(system, version, fhirVersion, opContext);
    return servers && servers.length > 0 ? servers[0].url : null;
  }

  /**
   * The servers that the registry says can provide system|version, and that can be used (open,
   * or there are credentials for it, and not excluded), authoritative ones first, as
   * {url, authoritative}, or null if there are none. The registry is asked about the FHIR version
   * of the endpoint first, then the other versions: the operations used on the other server don't
   * depend on its FHIR version. Whether a candidate has the content is checked when it's used
   * (listVersions)
   *
   * If this server (an excluded one: see modules.tx.ecosystem.excludedServers) is authoritative
   * for it, there are none: the answer is this server's - e.g. that it doesn't have that version -
   * not whatever another server says
   *
   * @param {string} system
   * @param {string} version - may be null
   * @param {number} fhirVersion - the endpoint's (3, 4, 5 or 6)
   * @param {OperationContext} [opContext] - the operation it's for
   * @returns {Promise<{url: string, authoritative: boolean}[]|null>}
   */
  async findServers(system, version, fhirVersion, opContext = null) {
    if (this.isExcludedSystem(system, version)) {
      return null;
    }
    const key = system + (version ? '|' + version : '');
    return this.#known(this.servers, key + '#' + fhirVersion, async (ctxt) => {
      const first = EcosystemResolver.fhirVersionFor(fhirVersion);
      let failure = null;
      for (const fv of [first, ...['5.0', '4.0'].filter(v => v !== first)]) {
        try {
          const json = await this.getRegistryJson(this.registry + '/resolve?fhirVersion=' + fv + '&url=' + encodeURIComponent(key), ctxt);
          if ((json.authoritative || []).some(s => s.url && this.isExcludedServer(s.url))) {
            return null;
          }
          const servers = [...(await this.chooseServers(json.authoritative, true, ctxt)), ...(await this.chooseServers(json.candidates, false, ctxt))];
          const seen = new Set();
          const list = servers.filter(s => !seen.has(s.url) && seen.add(s.url));
          if (list.length > 0) {
            return list;
          }
        } catch (e) {
          this.log.warn(`Ecosystem resolution of ${key} for FHIR ${fv} failed: ${e.message}`);
          failure = e;
        }
      }
      if (failure) {
        throw failure; // not known: not the same as no server
      }
      return null;
    }, opContext, (e) => `Ecosystem resolution of ${key} failed: ${e.message}`);
  }

  /**
   * The servers in a list from the registry that can be used, in the registry's order. A
   * candidate the registry says doesn't have the content (from its TerminologyCapabilities) isn't
   * used; an authoritative server is, whatever it says: a server that provides services for a code
   * system it says it has no content for (because it holds the concepts in its own tables) has to
   * be registered as authoritative for it
   */
  async chooseServers(list, authoritative, opContext = null) {
    const result = [];
    for (const s of list || []) {
      if (!s.url || this.isExcludedServer(s.url)) {
        continue;
      }
      if (!authoritative && s.content && !EcosystemResolver.isUsableContent(s.content)) {
        continue;
      }
      const open = (s.open || s.security === 'open') && !s.token;
      if (open || this.credentials.hasCredentials(await this.serverCode(s.url, opContext))) {
        result.push({ url: s.url, authoritative });
      }
    }
    return result;
  }

  /**
   * True if a code system's content mode means its codes are there to validate against (the same
   * test the validator applies: complete or fragment)
   */
  static isUsableContent(content) {
    return content === 'complete' || content === 'fragment';
  }

  /**
   * The content mode a TerminologyCapabilities.codeSystem states: R5 has codeSystem.content; R4
   * (and R3) carry it in the cross-version extension. undefined if it doesn't say
   */
  static capsContent(cs) {
    if (cs.content) {
      return cs.content;
    }
    const ext = (cs.extension || []).find(e => e.url === CAPS_CONTENT_EXT);
    return ext ? ext.valueCode : undefined;
  }

  /**
   * The versions of system that a server has, or null if it doesn't have it (or couldn't be
   * asked).
   *
   * What the server says in its TerminologyCapabilities comes first: if it lists the code system,
   * and doesn't say that the content is anything other than complete or fragment, the versions it
   * lists there are the answer. Otherwise - it doesn't list it, or says the content isn't there, or
   * there's no TerminologyCapabilities - the server's CodeSystem resources for it are searched for,
   * and the versions with complete or fragment content are the answer (searchVersions).
   *
   * For a server that's authoritative for the code system, what it says about the content isn't
   * looked at (see chooseServers)
   *
   * @param {string} server
   * @param {string} system
   * @param {OperationContext} [opContext] - the operation it's for
   * @param {boolean} [authoritative] - the registry says the server is authoritative for it
   * @returns {Promise<{code: string, isDefault: boolean}[]|null>}
   */
  async listVersions(server, system, opContext = null, authoritative = false) {
    const caps = await this.codeSystemsOf(server, opContext);
    const entry = caps ? caps.get(system) : null;
    if (entry && (authoritative || entry.content === undefined || EcosystemResolver.isUsableContent(entry.content))) {
      return entry.versions;
    }
    return this.searchVersions(server, system, opContext, authoritative);
  }

  /**
   * What a server says it has (its TerminologyCapabilities): code system -> {content, versions},
   * or null if it couldn't be asked. Read once (an hour) for all the code systems. content is
   * undefined if the server doesn't say
   */
  async codeSystemsOf(server, opContext = null) {
    return this.#known(this.versions, server, async (ctxt) => {
      const { status, json } = await this.send(server, server.replace(/\/$/, '') + '/metadata?mode=terminology', null, ctxt);
      if (status >= 300 || !json) {
        throw new Error(`it returned status ${status}`);
      }
      const map = new Map();
      for (const cs of json.codeSystem || []) {
        if (cs.uri) {
          const entry = map.get(cs.uri) || { content: undefined, versions: [] };
          const content = EcosystemResolver.capsContent(cs);
          if (content !== undefined && !EcosystemResolver.isUsableContent(entry.content)) {
            entry.content = content;
          }
          entry.versions = entry.versions.concat((cs.version || []).filter(v => v.code).map(v => ({ code: v.code, isDefault: v.isDefault === true })));
          map.set(cs.uri, entry);
        }
      }
      return map;
    }, opContext, (e) => `Unable to read the code systems that ${server} has: ${e.message}`);
  }

  /**
   * The versions of system that a server has CodeSystem resources for with complete or fragment
   * content (any content, for a server that's authoritative for it), from a search for them, or
   * null if there aren't any (or it couldn't be asked). Kept for an hour. None of them is the
   * default: a search doesn't say
   */
  async searchVersions(server, system, opContext = null, authoritative = false) {
    return this.#known(this.searched, server + '|' + system + (authoritative ? '#auth' : ''), async (ctxt) => {
      const url = server.replace(/\/$/, '') + '/CodeSystem?url=' + encodeURIComponent(system) + '&_summary=true&_count=100';
      const { status, json } = await this.send(server, url, null, ctxt);
      if (status >= 300 || !json || json.resourceType !== 'Bundle') {
        throw new Error(`it returned status ${status}`);
      }
      let found = false;
      const versions = [];
      for (const e of json.entry || []) {
        const cs = e.resource;
        if (cs && cs.resourceType === 'CodeSystem' && cs.url === system && (authoritative || EcosystemResolver.isUsableContent(cs.content))) {
          found = true;
          if (cs.version && !versions.some(v => v.code === cs.version)) {
            versions.push({ code: cs.version, isDefault: false });
          }
        }
      }
      return found ? versions : null;
    }, opContext, (e) => `Unable to search for ${system} on ${server}: ${e.message}`);
  }

  /**
   * send(), for requests whose answer doesn't change from one minute to the next ($lookup and
   * $validate-code): the answer is kept for an hour (the most recent MAX_ANSWERS of them), and the
   * same request asked for again while it's on its way waits for that answer. Only what the
   * server answered is kept: an answer that says something is wrong with the request (4xx) is
   * kept, but not one about authorisation, throttling or the server itself (401, 403, 429, 5xx),
   * and not a failure to get an answer at all
   */
  async sendCached(server, url, body = null, opContext = null) {
    const key = url + (body ? ' ' + JSON.stringify(body) : '');
    const entry = this.answers.get(key);
    if (entry && entry.pending) {
      if (opContext && opContext.countExternalRequest) {
        opContext.countExternalRequest();
      }
      return entry.pending;
    }
    if (entry && Date.now() - entry.at < CACHE_MS) {
      // most recently used goes to the end, so the oldest are dropped first
      this.answers.delete(key);
      this.answers.set(key, entry);
      return entry.value;
    }
    const pending = this.send(server, url, body, opContext).then(value => {
      const s = value.status;
      if (s < 500 && s !== 401 && s !== 403 && s !== 429) {
        this.answers.set(key, { at: Date.now(), value });
        while (this.answers.size > MAX_ANSWERS) {
          this.answers.delete(this.answers.keys().next().value);
        }
      } else {
        this.answers.delete(key);
      }
      return value;
    }, e => {
      this.answers.delete(key);
      throw e;
    });
    this.answers.delete(key);
    this.answers.set(key, { pending });
    return pending;
  }
}

module.exports = { EcosystemResolver, FORWARDED_HEADER, DEFAULT_REGISTRY };
