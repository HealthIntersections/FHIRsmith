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
const TIMEOUT_MS = 30000;
const CACHE_MS = 60 * 60 * 1000; // what the registry and the servers say is kept for an hour

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
      userAgent: 'FHIRsmith (ecosystem resolution)',
      agents: () => this.agents
    });
    this.log = Logger.getInstance().child({module: 'tx-ecosystem'});
    this.servers = new Map(); // system|version -> {at, server}
    this.versions = new Map(); // server -> {at, map: code system -> versions}
    this.codes = null; // {at, map: normalised address -> server code}
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
    if (!this.codes || Date.now() - this.codes.at > CACHE_MS) {
      const map = new Map();
      try {
        const json = await this.getRegistryJson(this.registry, opContext);
        for (const r of json.results || []) {
          if (r.url && r['server-code']) {
            map.set(EcosystemResolver.normalise(r.url), r['server-code']);
          }
        }
      } catch (e) {
        this.log.warn(`Unable to read the list of servers from ${this.registry}: ${e.message}`);
      }
      this.codes = { at: Date.now(), map };
    }
    return this.codes.map.get(EcosystemResolver.normalise(address)) || null;
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
      validateStatus: () => true,
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
        validateStatus: () => true,
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
   * The address of a server that the registry says can provide system|version, and that can be
   * used (open, or there are credentials for it, and not excluded), or null. Authoritative
   * servers come first. The registry is asked about the FHIR version of the endpoint first, then
   * the other versions: the operations used on the other server don't depend on its FHIR version
   *
   * @param {string} system
   * @param {string} version - may be null
   * @param {number} fhirVersion - the endpoint's (3, 4, 5 or 6)
   * @param {OperationContext} [opContext] - the operation it's for
   * @returns {Promise<string|null>}
   */
  async findServer(system, version, fhirVersion, opContext = null) {
    if (this.isExcludedSystem(system, version)) {
      return null;
    }
    const key = system + (version ? '|' + version : '');
    const cached = this.servers.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return cached.server;
    }
    let server = null;
    const first = EcosystemResolver.fhirVersionFor(fhirVersion);
    for (const fv of [first, ...['5.0', '4.0'].filter(v => v !== first)]) {
      try {
        const json = await this.getRegistryJson(this.registry + '/resolve?fhirVersion=' + fv + '&url=' + encodeURIComponent(key), opContext);
        server = (await this.chooseServer(json.authoritative, opContext)) || (await this.chooseServer(json.candidates, opContext));
      } catch (e) {
        this.log.warn(`Ecosystem resolution of ${key} for FHIR ${fv} failed: ${e.message}`);
      }
      if (server) {
        break;
      }
    }
    this.servers.set(key, { at: Date.now(), server });
    return server;
  }

  async chooseServer(list, opContext = null) {
    for (const s of list || []) {
      // a candidate that says it doesn't have the content can't answer
      if (!s.url || s.content === 'not-present' || this.isExcludedServer(s.url)) {
        continue;
      }
      const open = (s.open || s.security === 'open') && !s.token;
      if (open || this.credentials.hasCredentials(await this.serverCode(s.url, opContext))) {
        return s.url;
      }
    }
    return null;
  }

  /**
   * The versions of system that a server says it has (from its TerminologyCapabilities), or
   * null if it doesn't list the code system at all (or couldn't be asked)
   *
   * @param {string} server
   * @param {string} system
   * @param {OperationContext} [opContext] - the operation it's for
   * @returns {Promise<{code: string, isDefault: boolean}[]|null>}
   */
  async listVersions(server, system, opContext = null) {
    const caps = await this.codeSystemsOf(server, opContext);
    return caps ? (caps.get(system) || null) : null;
  }

  /**
   * What a server says it has (its TerminologyCapabilities): code system -> versions, or null if
   * it couldn't be asked. Read once (an hour) for all the code systems
   */
  async codeSystemsOf(server, opContext = null) {
    const cached = this.versions.get(server);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return cached.map;
    }
    let map = null;
    try {
      const { status, json } = await this.send(server, server.replace(/\/$/, '') + '/metadata?mode=terminology', null, opContext);
      if (status >= 300 || !json) {
        throw new Error(`it returned status ${status}`);
      }
      map = new Map();
      for (const cs of json.codeSystem || []) {
        if (cs.uri) {
          const list = map.get(cs.uri) || [];
          map.set(cs.uri, list.concat((cs.version || []).filter(v => v.code).map(v => ({ code: v.code, isDefault: v.isDefault === true }))));
        }
      }
    } catch (e) {
      this.log.warn(`Unable to read the code systems that ${server} has: ${e.message}`);
    }
    this.versions.set(server, { at: Date.now(), map });
    return map;
  }
}

module.exports = { EcosystemResolver, FORWARDED_HEADER, DEFAULT_REGISTRY };
