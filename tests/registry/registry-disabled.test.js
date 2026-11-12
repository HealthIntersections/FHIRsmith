// Registrations marked "disabled": true (registry/crawler.js; see the tx ecosystem IG:
// Disabling) - a disabled registry isn't read, a disabled server isn't scanned, and
// neither is in the crawl's data

const nock = require('nock');
const RegistryCrawler = require('../../registry/crawler');

const MASTER = 'https://master.example';
const REG_A = 'https://reg-a.example';
const REG_B = 'https://reg-b.example';
const TX_ON = 'https://on.example';
const TX_OFF = 'https://off.example';

const quietLog = { error() {}, warn() {}, info() {}, debug() {} };
const stats = { task() {} };

function makeCrawler() {
  const crawler = new RegistryCrawler({ masterUrl: `${MASTER}/tx-servers.json` }, stats);
  crawler.useLog(quietLog);
  return crawler;
}

function mockServer(base) {
  const host = new URL(base).origin;
  const path = new URL(base).pathname;
  const scope = nock(host);
  scope.get(`${path}/metadata`).query(q => q.mode !== 'terminology')
    .reply(200, { resourceType: 'CapabilityStatement', fhirVersion: '4.0.1', software: { name: 'Test', version: '1.0' } });
  scope.get(`${path}/metadata`).query(q => q.mode === 'terminology')
    .reply(200, { resourceType: 'TerminologyCapabilities', codeSystem: [{ uri: 'http://example.org/cs' }] });
  scope.get(`${path}/ValueSet`).query(true)
    .reply(200, { resourceType: 'Bundle', entry: [] });
  return scope;
}

function server(code, base, extra = {}) {
  return Object.assign({ code, name: code.toUpperCase(), url: base, fhirVersions: [{ version: 'R4', url: `${base}/fhir` }] }, extra);
}

describe('Registry crawler - disabled registrations', () => {
  beforeAll(() => nock.disableNetConnect());
  afterEach(() => nock.cleanAll());
  afterAll(() => nock.enableNetConnect());

  test('a disabled server is not scanned and not in the data', async () => {
    nock(MASTER).get('/tx-servers.json').query(true)
      .reply(200, { formatVersion: '1', registries: [{ code: 'a', name: 'A', url: `${REG_A}/reg.json` }] });
    nock(REG_A).get('/reg.json').query(true)
      .reply(200, { formatVersion: '1', servers: [server('on', TX_ON), server('off', TX_OFF, { disabled: true })] });
    const on = mockServer(`${TX_ON}/fhir`);
    // any request to the disabled server fails the test (net connect is disabled)
    const crawler = makeCrawler();
    const data = await crawler.crawl();

    expect(on.isDone()).toBe(true);
    expect(data.registries).toHaveLength(1);
    expect(data.registries[0].servers.map(s => s.code)).toEqual(['on']);
    expect(crawler.errors).toEqual([]);
    expect(crawler.logs.some(l => l.level !== 'error' && /Server OFF is disabled/.test(l.message))).toBe(true);
    expect(crawler.logs.some(l => l.level === 'error')).toBe(false);
  });

  test('a disabled registry is not read and not in the data', async () => {
    nock(MASTER).get('/tx-servers.json').query(true)
      .reply(200, { formatVersion: '1', registries: [
        { code: 'a', name: 'A', url: `${REG_A}/reg.json` },
        { code: 'b', name: 'B', url: `${REG_B}/reg.json`, disabled: true }
      ] });
    nock(REG_A).get('/reg.json').query(true)
      .reply(200, { formatVersion: '1', servers: [server('on', TX_ON)] });
    mockServer(`${TX_ON}/fhir`);
    const regB = nock(REG_B).get('/reg.json').query(true).reply(200, { formatVersion: '1', servers: [] });

    const crawler = makeCrawler();
    const data = await crawler.crawl();

    expect(regB.isDone()).toBe(false);
    expect(data.registries.map(r => r.code)).toEqual(['a']);
    expect(crawler.logs.some(l => /Registry B is disabled/.test(l.message))).toBe(true);
  });

  test('only the JSON value true disables', async () => {
    nock(MASTER).get('/tx-servers.json').query(true)
      .reply(200, { formatVersion: '1', registries: [{ code: 'a', name: 'A', url: `${REG_A}/reg.json`, disabled: false }] });
    nock(REG_A).get('/reg.json').query(true)
      .reply(200, { formatVersion: '1', servers: [server('on', TX_ON, { disabled: 'true' })] });
    const on = mockServer(`${TX_ON}/fhir`);

    const data = await makeCrawler().crawl();

    expect(on.isDone()).toBe(true);
    expect(data.registries[0].servers.map(s => s.code)).toEqual(['on']);
  });
});
