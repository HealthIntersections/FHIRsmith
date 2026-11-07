// The registry crawler scanning servers that need an OAuth2 client_credentials token
// (registry/crawler.js; config in registry/documentation/configuration.md#oauth)

const nock = require('nock');
const RegistryCrawler = require('../../registry/crawler');

const MASTER = 'https://master.example';
const REGISTRY = 'https://reg.example';
const TX = 'https://tx.example.nz';
const TOKEN_HOST = 'https://auth.example.nz';
const TOKEN_PATH = '/realms/nzhts/protocol/openid-connect/token';
const SECRET = 'very-secret-value';

const quietLog = { error() {}, warn() {}, info() {}, debug() {} };
const stats = { task() {} };

function makeCrawler(extra = {}) {
  const crawler = new RegistryCrawler(Object.assign({
    masterUrl: `${MASTER}/tx-servers.json`,
    oauth: {
      nzhts: { tokenEndpoint: TOKEN_HOST + TOKEN_PATH, clientId: 'hl7', clientSecret: SECRET }
    }
  }, extra), stats);
  crawler.useLog(quietLog);
  return crawler;
}

function mockRegistry(servers) {
  nock(MASTER).get('/tx-servers.json').query(true)
    .reply(200, { formatVersion: '1', registries: [{ code: 'r', name: 'R', url: `${REGISTRY}/reg.json` }] });
  nock(REGISTRY).get('/reg.json').query(true)
    .reply(200, { formatVersion: '1', servers });
}

const NZHTS = { code: 'nzhts', name: 'NZHTS', url: TX, fhirVersions: [{ version: 'R4', url: `${TX}/fhir` }] };

// metadata, terminology capabilities and one page of value sets, each requiring the header
function mockServer(base, reqheaders, opts = {}) {
  const host = new URL(base).origin;
  const path = new URL(base).pathname;
  const scope = nock(host, { reqheaders, badheaders: opts.badheaders || [] });
  scope.get(`${path}/metadata`).query(q => q.mode !== 'terminology')
    .reply(200, { resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', software: { name: 'Test', version: '1.0' } });
  scope.get(`${path}/metadata`).query(q => q.mode === 'terminology')
    .reply(200, { resourceType: 'TerminologyCapabilities', codeSystem: [{ uri: 'http://example.org/cs' }] });
  scope.get(`${path}/ValueSet`).query(true)
    .reply(200, { resourceType: 'Bundle', entry: [{ resource: { url: 'http://example.org/vs' } }], link: opts.next ? [{ relation: 'next', url: opts.next }] : [] });
  return scope;
}

function mockToken(token, expiresIn = 86400, times = 1) {
  const bodies = [];
  const scope = nock(TOKEN_HOST).post(TOKEN_PATH, body => { bodies.push(body); return true; })
    .times(times)
    .reply(200, { access_token: token, expires_in: expiresIn, token_type: 'Bearer', scope: '' });
  return { scope, bodies };
}

function versionOf(data, code = 'nzhts') {
  const server = data.registries[0].servers.find(s => s.code === code);
  return server.versions[0];
}

describe('Registry crawler - OAuth client credentials', () => {
  beforeAll(() => nock.disableNetConnect());
  afterEach(() => nock.cleanAll());
  afterAll(() => nock.enableNetConnect());

  test('gets a token by client_credentials and sends it as a bearer token, once per crawl', async () => {
    const crawler = makeCrawler();
    mockRegistry([NZHTS]);
    const token = mockToken('tok-1');
    const server = mockServer(`${TX}/fhir`, { authorization: 'Bearer tok-1' });

    const data = await crawler.crawl();

    expect(server.isDone()).toBe(true);
    expect(token.scope.isDone()).toBe(true);
    expect(token.bodies).toHaveLength(1);
    expect(token.bodies[0]).toEqual({ grant_type: 'client_credentials', client_id: 'hl7', client_secret: SECRET });
    const v = versionOf(data);
    expect(v.error || '').toBe('');
    expect(v.security).toBe('oauth');
    expect(v.codeSystems.map(cs => cs.uri)).toContain('http://example.org/cs');

    // the log says that the scan was authenticated, and how
    const messages = crawler.logs.map(l => l.message);
    expect(messages.some(m => /Got an OAuth token for nzhts from .*, valid for 86400s/.test(m))).toBe(true);
    expect(messages.some(m => m.includes(`Server ${TX}/fhir:`) && m.endsWith('(oauth)'))).toBe(true);
  });

  test('sends scope when configured', async () => {
    const crawler = makeCrawler({ oauth: { nzhts: { tokenEndpoint: TOKEN_HOST + TOKEN_PATH, clientId: 'hl7', clientSecret: SECRET, scope: 'system/*.rs' } } });
    const token = mockToken('tok-s');
    await crawler.getAccessToken('nzhts');
    expect(token.bodies[0].scope).toBe('system/*.rs');
  });

  test('does not send credentials to the master or registry files', async () => {
    const crawler = makeCrawler();
    nock(MASTER, { badheaders: ['authorization', 'api-key'] }).get('/tx-servers.json').query(true)
      .reply(200, { formatVersion: '1', registries: [{ code: 'r', name: 'R', url: `${REGISTRY}/reg.json` }] });
    nock(REGISTRY, { badheaders: ['authorization', 'api-key'] }).get('/reg.json').query(true)
      .reply(200, { formatVersion: '1', servers: [NZHTS] });
    mockToken('tok-1');
    mockServer(`${TX}/fhir`, { authorization: 'Bearer tok-1' });

    const data = await crawler.crawl();
    expect(versionOf(data).error || '').toBe('');
  });

  test('reuses the token across crawls while it is valid', async () => {
    const crawler = makeCrawler();
    const token = mockToken('tok-1');
    mockRegistry([NZHTS]);
    mockServer(`${TX}/fhir`, { authorization: 'Bearer tok-1' });
    await crawler.crawl();
    mockRegistry([NZHTS]);
    mockServer(`${TX}/fhir`, { authorization: 'Bearer tok-1' });
    const data = await crawler.crawl();

    expect(token.bodies).toHaveLength(1);
    expect(versionOf(data).error || '').toBe('');
  });

  test('gets a new token when the old one is about to expire', async () => {
    const crawler = makeCrawler();
    let now = 1_000_000;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      nock(TOKEN_HOST).post(TOKEN_PATH).reply(200, { access_token: 'tok-1', expires_in: 600, token_type: 'Bearer' });
      nock(TOKEN_HOST).post(TOKEN_PATH).reply(200, { access_token: 'tok-2', expires_in: 600, token_type: 'Bearer' });
      expect(await crawler.getAccessToken('nzhts')).toBe('tok-1');
      now += 500 * 1000; // more than a minute left
      expect(await crawler.getAccessToken('nzhts')).toBe('tok-1');
      now += 50 * 1000;  // less than a minute left
      expect(await crawler.getAccessToken('nzhts')).toBe('tok-2');
    } finally {
      spy.mockRestore();
    }
  });

  test('concurrent callers share one token request', async () => {
    const crawler = makeCrawler();
    const token = mockToken('tok-1');
    const all = await Promise.all([crawler.getAccessToken('nzhts'), crawler.getAccessToken('nzhts'), crawler.getAccessToken('nzhts')]);
    expect(all).toEqual(['tok-1', 'tok-1', 'tok-1']);
    expect(token.bodies).toHaveLength(1);
  });

  test('a 401 gets a new token and retries once', async () => {
    const crawler = makeCrawler();
    nock(TOKEN_HOST).post(TOKEN_PATH).reply(200, { access_token: 'stale', expires_in: 86400, token_type: 'Bearer' });
    nock(TOKEN_HOST).post(TOKEN_PATH).reply(200, { access_token: 'fresh', expires_in: 86400, token_type: 'Bearer' });
    await crawler.getAccessToken('nzhts'); // cache the stale one

    mockRegistry([NZHTS]);
    nock(TX, { reqheaders: { authorization: 'Bearer stale' } }).get('/fhir/metadata').query(true).reply(401);
    mockServer(`${TX}/fhir`, { authorization: 'Bearer fresh' });

    const data = await crawler.crawl();
    expect(versionOf(data).error || '').toBe('');
    expect(nock.pendingMocks()).toEqual([]);
  });

  test('a server that keeps answering 401 is an error, not a loop', async () => {
    const crawler = makeCrawler();
    const token = mockToken('tok', 86400, 2);
    mockRegistry([NZHTS]);
    nock(TX).get('/fhir/metadata').query(true).times(2).reply(401);

    const data = await crawler.crawl();
    expect(versionOf(data).error).toMatch(/HTTP 401/);
    expect(token.bodies).toHaveLength(2);
  });

  test('a refused token request is an error for that server only, and does not leak the secret', async () => {
    const crawler = makeCrawler();
    mockRegistry([NZHTS, { code: 'open', name: 'Open', url: 'https://open.example', fhirVersions: [{ version: 'R4', url: 'https://open.example/fhir' }] }]);
    nock(TOKEN_HOST).post(TOKEN_PATH)
      .reply(401, { error: 'invalid_client', error_description: `Invalid client secret ${SECRET}` });
    mockServer('https://open.example/fhir', {}, { badheaders: ['authorization', 'api-key'] });

    const data = await crawler.crawl();

    const v = versionOf(data);
    expect(v.error).toMatch(/Could not get an OAuth token for nzhts/);
    expect(v.error).toMatch(/HTTP 401 invalid_client/);
    expect(versionOf(data, 'open').error || '').toBe('');
    expect(versionOf(data, 'open').security).toBe('open');

    const everything = JSON.stringify([data, crawler.logs, crawler.errors]);
    expect(everything).not.toContain(SECRET);
  });

  test('the token is not reported anywhere', async () => {
    const crawler = makeCrawler();
    mockRegistry([NZHTS]);
    mockToken('the-access-token');
    mockServer(`${TX}/fhir`, { authorization: 'Bearer the-access-token' });

    const data = await crawler.crawl();
    const everything = JSON.stringify([data, crawler.getData(), crawler.logs, crawler.errors]);
    expect(everything).not.toContain('the-access-token');
    expect(everything).not.toContain(SECRET);
  });

  test('credentials are not sent to a next link on another origin', async () => {
    const crawler = makeCrawler();
    mockRegistry([NZHTS]);
    mockToken('tok-1');
    mockServer(`${TX}/fhir`, { authorization: 'Bearer tok-1' }, { next: 'https://elsewhere.example/fhir/ValueSet?page=2' });
    nock('https://elsewhere.example', { badheaders: ['authorization', 'api-key'] })
      .get('/fhir/ValueSet').query(true)
      .reply(200, { resourceType: 'Bundle', entry: [{ resource: { url: 'http://example.org/vs2' } }] });

    const data = await crawler.crawl();
    expect(versionOf(data).error || '').toBe('');
    expect(versionOf(data).valueSets).toContain('http://example.org/vs2');
    expect(nock.pendingMocks()).toEqual([]);
  });

  test('refuses a token endpoint that is not https', async () => {
    const crawler = makeCrawler({ oauth: { nzhts: { tokenEndpoint: 'http://auth.example.nz/token', clientId: 'hl7', clientSecret: SECRET } } });
    await expect(crawler.getAccessToken('nzhts')).rejects.toThrow(/must be an https: URL/);
  });

  test('does not follow a redirect from the token endpoint', async () => {
    const crawler = makeCrawler();
    nock(TOKEN_HOST).post(TOKEN_PATH).reply(307, '', { Location: 'https://evil.example/token' });
    await expect(crawler.getAccessToken('nzhts')).rejects.toThrow(/HTTP 307/);
  });

  test('a missing access_token is an error', async () => {
    const crawler = makeCrawler();
    nock(TOKEN_HOST).post(TOKEN_PATH).reply(200, { token_type: 'Bearer' });
    await expect(crawler.getAccessToken('nzhts')).rejects.toThrow(/no access_token/);
  });

  test('oauth takes precedence over an api key for the same server', async () => {
    const crawler = makeCrawler({ apiKeys: { nzhts: 'key-1' } });
    mockRegistry([NZHTS]);
    mockToken('tok-1');
    mockServer(`${TX}/fhir`, { authorization: 'Bearer tok-1' }, { badheaders: ['api-key'] });
    const data = await crawler.crawl();
    expect(versionOf(data).error || '').toBe('');
    expect(versionOf(data).security).toBe('oauth');
  });

  test('api keys still work, by server code, for R3 servers too', async () => {
    const crawler = makeCrawler({ oauth: {}, apiKeys: { r3: 'key-3' } });
    mockRegistry([{ code: 'r3', name: 'An R3 server', url: 'https://r3.example', fhirVersions: [{ version: 'R3', url: 'https://r3.example/fhir' }] }]);
    const scope = nock('https://r3.example', { reqheaders: { 'api-key': 'key-3' } });
    scope.get('/fhir/metadata').query(q => q.mode !== 'terminology').reply(200, { resourceType: 'CapabilityStatement', fhirVersion: '3.0.2' });
    scope.get('/fhir/metadata').query(q => q.mode === 'terminology').reply(200, { resourceType: 'Parameters', parameter: [{ name: 'system', valueUri: 'http://example.org/cs3' }] });
    scope.get('/fhir/ValueSet').query(true).reply(200, { resourceType: 'Bundle' });

    const data = await crawler.crawl();
    const v = versionOf(data, 'r3');
    expect(v.error || '').toBe('');
    expect(v.security).toBe('api-key');
    expect(v.codeSystems.map(cs => cs.uri || cs)).toContain('http://example.org/cs3');
  });
});
