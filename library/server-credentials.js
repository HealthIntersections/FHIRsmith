// Credentials for other terminology servers: an API key, or an OAuth2 client_credentials token,
// under the server's code in the registry. Used by the registry crawler (registry/crawler.js) and
// by the tx module when it asks other servers in the ecosystem (tx/ecosystem-resolver.js)

const axios = require('axios');

class ServerCredentials {
  /**
   * @param {Object} options
   * @param {Object} options.apiKeys - server code -> API key (sent as Api-Key)
   * @param {Object} options.oauth - server code -> { tokenEndpoint, clientId, clientSecret, scope }
   * @param {number} [options.timeout] - for the token request, in ms
   * @param {string} [options.userAgent]
   * @param {function(): {httpAgent, httpsAgent}} [options.agents] - for the token request (the crawler's SSRF guard)
   * @param {function(): AbortSignal} [options.signal] - for the token request
   * @param {function(string, string)} [options.log] - (level, message)
   */
  constructor(options = {}) {
    this.apiKeys = options.apiKeys || {};
    this.oauth = options.oauth || {};
    this.timeout = options.timeout || 30000;
    this.userAgent = options.userAgent || 'FHIRsmith';
    this.agents = options.agents || (() => ({}));
    this.signal = options.signal || (() => undefined);
    this.log = options.log || (() => {});
    // server code -> { token, renewAt } or { pending: Promise }
    this.tokens = new Map();
  }

  /**
   * The API key for a server code, or null
   */
  getApiKey(code) {
    if (code && Object.prototype.hasOwnProperty.call(this.apiKeys, code)) {
      return this.apiKeys[code];
    }
    return null;
  }

  /**
   * The OAuth client credentials configured for a server code, or null
   */
  getOAuthConfig(code) {
    if (code && Object.prototype.hasOwnProperty.call(this.oauth, code)) {
      return this.oauth[code] || null;
    }
    return null;
  }

  /**
   * 'oauth', 'api-key' or 'open': what is sent to the server with this code
   */
  security(code) {
    return this.getOAuthConfig(code) ? 'oauth' : this.getApiKey(code) == null ? 'open' : 'api-key';
  }

  hasCredentials(code) {
    return this.security(code) !== 'open';
  }

  /**
   * The headers that carry a server's credentials: an OAuth bearer token if the server has
   * an oauth entry, otherwise its API key, otherwise none
   * @param {string} code
   * @param {boolean} renewToken - discard the cached token (the server refused it)
   */
  async headers(code, renewToken = false) {
    if (this.getOAuthConfig(code)) {
      return { 'Authorization': `Bearer ${await this.getAccessToken(code, renewToken)}` };
    }
    const apiKey = this.getApiKey(code);
    return apiKey ? { 'Api-Key': apiKey } : {};
  }

  /**
   * An access token for a server, from the cache while it has more than a minute (or a tenth
   * of its life, if less) to run, otherwise from the token endpoint. Concurrent callers share
   * one token request.
   * @param {string} code
   * @param {boolean} renew - discard the cached token (the server refused it)
   * @returns {Promise<string>}
   */
  async getAccessToken(code, renew = false) {
    const cached = this.tokens.get(code);
    if (cached) {
      if (cached.pending) {
        return cached.pending;
      }
      if (!renew && Date.now() < cached.renewAt) {
        return cached.token;
      }
    }
    const pending = this.requestAccessToken(code)
      .then(t => {
        this.tokens.set(code, t);
        return t.token;
      })
      .catch(err => {
        this.tokens.delete(code);
        throw err;
      });
    this.tokens.set(code, { pending });
    return pending;
  }

  /**
   * The client_credentials grant (RFC 6749 4.4), the client authenticating with its secret in
   * the form body (client_secret_post). Error messages name the server and the endpoint, but
   * never carry the secret or anything the endpoint said beyond its error code.
   */
  async requestAccessToken(code) {
    const cfg = this.getOAuthConfig(code);
    const endpoint = cfg.tokenEndpoint;
    const fail = (why) => new Error(`Could not get an OAuth token for ${code} from ${endpoint}: ${why}`);
    if (!endpoint || !/^https:\/\//i.test(endpoint)) {
      throw new Error(`The OAuth tokenEndpoint for ${code} must be an https: URL`);
    }
    if (!cfg.clientId || !cfg.clientSecret) {
      throw new Error(`The OAuth configuration for ${code} needs a clientId and clientSecret`);
    }

    const form = new URLSearchParams();
    form.set('grant_type', 'client_credentials');
    form.set('client_id', cfg.clientId);
    form.set('client_secret', cfg.clientSecret);
    if (cfg.scope) {
      form.set('scope', cfg.scope);
    }

    let response;
    try {
      response = await axios.post(endpoint, form.toString(), {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'User-Agent': this.userAgent
        },
        signal: this.signal(),
        validateStatus: () => true,
        maxContentLength: 1024 * 1024,
        maxRedirects: 0, // the form carries the secret: it goes where it was configured to, or nowhere
        httpAgent: this.agents().httpAgent,
        httpsAgent: this.agents().httpsAgent
      });
    } catch (error) {
      throw fail(error.response ? `HTTP ${error.response.status}` : `no response (${error.code || error.message})`);
    }

    const body = response.data && typeof response.data === 'object' ? response.data : {};
    if (response.status !== 200) {
      const ec = typeof body.error === 'string' && /^[\w.-]{1,64}$/.test(body.error) ? ` ${body.error}` : '';
      throw fail(`HTTP ${response.status}${ec}`);
    }
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw fail('the response has no access_token');
    }
    if (body.token_type && String(body.token_type).toLowerCase() !== 'bearer') {
      throw fail(`unsupported token_type ${String(body.token_type).substring(0, 20)}`);
    }

    const lifetime = Number(body.expires_in) > 0 ? Number(body.expires_in) * 1000 : 5 * 60 * 1000;
    const margin = Math.min(60 * 1000, lifetime / 10);
    this.log('info', `  Got an OAuth token for ${code} from ${endpoint}, valid for ${Math.round(lifetime / 1000)}s`);
    return { token: body.access_token, renewAt: Date.now() + lifetime - margin };
  }
}

module.exports = { ServerCredentials };
