// registry-exclusions.test.js
// Tests for exclusions: code systems / value sets the server holds that are hidden
// from the ecosystem entirely - never offered as authoritative NOR as a candidate,
// even when an authoritative mask (or language specific claim) would otherwise match.
// See the tx ecosystem IG: Exclusions.

const {
  ServerRegistries,
  ServerRegistry,
  ServerInformation,
  ServerVersionInformation
} = require('../../registry/model');
const RegistryCrawler = require('../../registry/crawler');
const RegistryAPI = require('../../registry/api');

const CS_HIDDEN = 'http://example.org/cs/hidden';
const CS_OK = 'http://example.org/cs/visible';
const VS_HIDDEN = 'http://example.org/vs/hidden';
const VS_OK = 'http://example.org/vs/visible';

function makeServer(code, name, address, { authCS = [], authVS = [], languages = {}, exclusions = [], hosts = [], vsHosts = [] } = {}) {
  const s = new ServerInformation();
  s.code = code;
  s.name = name;
  s.address = address;
  s.accessInfo = 'Open';
  s.authCSList = authCS;
  s.authVSList = authVS;
  s.languages = languages;
  s.exclusions = exclusions;
  const v = new ServerVersionInformation();
  v.version = '4.0.1';
  v.address = `${address}/r4`;
  v.security = 'open';
  v.lastSuccess = new Date('2026-07-01T10:00:00Z');
  v.lastTat = '100ms';
  v.codeSystems = hosts.map(uri => ({ uri }));
  v.valueSets = vsHosts;
  s.versions.push(v);
  return s;
}

// m: wildcard claims covering both CS urls, excludes CS_HIDDEN, but (simulating stale
//    persisted data) still lists CS_HIDDEN as hosted - exclusion must win anyway
// f: wildcard claim covering CS_HIDDEN, excludes it, hosts nothing - previously leaked
//    back in via the (since removed) resolve fallback path
// g: language specific claim covering CS_HIDDEN for de, excludes it
function createData() {
  const data = new ServerRegistries();
  data.address = 'https://registry.example.org';
  data.lastRun = new Date('2026-07-01T10:00:00Z');
  data.outcome = 'ok';

  const reg = new ServerRegistry();
  reg.code = 'main';
  reg.name = 'Main Registry';
  reg.address = 'https://main.registry.org';
  reg.authority = 'Test';

  reg.servers.push(makeServer('m', 'Mask Server', 'https://m.example.org', {
    authCS: ['http://example.org/cs/*'],
    authVS: ['http://example.org/vs/*'],
    exclusions: [CS_HIDDEN, VS_HIDDEN],
    hosts: [CS_HIDDEN, CS_OK],
    vsHosts: [VS_HIDDEN, VS_OK]
  }));
  reg.servers.push(makeServer('f', 'Fallback Server', 'https://f.example.org', {
    authCS: ['http://example.org/cs/*'],
    exclusions: [CS_HIDDEN]
  }));
  reg.servers.push(makeServer('g', 'German Server', 'https://g.example.org', {
    languages: { 'de': ['http://example.org/cs/*'] },
    exclusions: [CS_HIDDEN],
    hosts: [CS_HIDDEN, CS_OK]
  }));

  data.registries.push(reg);
  return data;
}

describe('Exclusion matching', () => {
  test('isExcludedTarget matches exact, wildcard, and versioned canonicals', () => {
    const s = makeServer('s', 'S', 'https://s.example.org', {
      exclusions: [CS_HIDDEN, 'http://example.org/other/*']
    });
    expect(s.isExcludedTarget(CS_HIDDEN)).toBe(true);
    expect(s.isExcludedTarget(CS_HIDDEN + '|1.0.0')).toBe(true); // base url matching
    expect(s.isExcludedTarget('http://example.org/other/anything')).toBe(true);
    expect(s.isExcludedTarget(CS_OK)).toBe(false);
  });

  test('exclusions defeat authoritative masks (isAuthCS/isAuthVS/matchAuthCS)', () => {
    const s = makeServer('s', 'S', 'https://s.example.org', {
      authCS: ['http://example.org/cs/*'],
      authVS: ['http://example.org/vs/*'],
      languages: { 'de': ['http://example.org/cs/*'] },
      exclusions: [CS_HIDDEN, VS_HIDDEN]
    });
    expect(s.isAuthCS(CS_OK)).toBe(true);
    expect(s.isAuthCS(CS_HIDDEN)).toBe(false);
    expect(s.isAuthVS(VS_OK)).toBe(true);
    expect(s.isAuthVS(VS_HIDDEN)).toBe(false);
    expect(s.matchAuthCS(CS_OK).isAuth).toBe(true);
    expect(s.matchAuthCS(CS_HIDDEN).isAuth).toBe(false);
    // exclusion also defeats language specific claims
    const de = require('../../registry/model').ServerRegistryUtilities.parseAcceptLanguage('de');
    expect(s.matchAuthCS(CS_OK, de).isAuth).toBe(true);
    expect(s.matchAuthCS(CS_HIDDEN, de).isAuth).toBe(false);
  });

  test('exclusions round-trip through toJSON/fromJSON', () => {
    const s = makeServer('s', 'S', 'https://s.example.org', {
      exclusions: [CS_HIDDEN, 'http://example.org/other/*']
    });
    const restored = ServerInformation.fromJSON(s.toJSON());
    expect(restored.exclusions).toEqual([CS_HIDDEN, 'http://example.org/other/*']);
    // legacy data without exclusions loads cleanly
    const legacy = s.toJSON();
    delete legacy.exclusions;
    expect(ServerInformation.fromJSON(legacy).exclusions).toEqual([]);
  });
});

describe('Exclusions hide the server entirely', () => {
  let api;

  beforeEach(() => {
    const crawler = new RegistryCrawler();
    crawler.loadData(createData().toJSON());
    api = new RegistryAPI(crawler);
  });

  function urls(list) {
    return (list || []).map(e => e.url);
  }

  test('resolve: excluded code system - not authoritative, not a candidate (even if listed as hosted)', () => {
    const { result } = api.resolveCodeSystem('R4', CS_HIDDEN, false);
    expect(urls(result.authoritative)).toEqual([]);
    expect(urls(result.candidates)).toEqual([]);
  });

  test('resolve: non-excluded code system under the same mask works normally', () => {
    const { result } = api.resolveCodeSystem('R4', CS_OK, false);
    expect(urls(result.authoritative)).toContain('https://m.example.org/r4');
  });

  test('a server that claims authority but does not host the code system is not returned', () => {
    // f claims http://example.org/cs/* but hosts nothing. There used to be a fallback
    // ("no matches anywhere -> use authoritative masks"); the ecosystem IG says servers
    // are not listed as authoritative unless they actually host the code system
    const { result } = api.resolveCodeSystem('R4', CS_HIDDEN, false);
    expect(urls(result.authoritative)).not.toContain('https://f.example.org/r4');
    const unhosted = api.resolveCodeSystem('R4', 'http://example.org/cs/unhosted', false).result;
    expect(urls(unhosted.authoritative)).toEqual([]);
    expect(urls(unhosted.candidates)).toEqual([]);
  });

  test('exclusion defeats language routing too', () => {
    const { result } = api.resolveCodeSystem('R4', CS_HIDDEN, false, '', 'de');
    expect(urls(result.authoritative)).toEqual([]);
    expect(urls(result.candidates)).toEqual([]);
    // g still routes for the visible code system
    const ok = api.resolveCodeSystem('R4', CS_OK, false, '', 'de').result;
    expect(urls(ok.authoritative)[0]).toBe('https://g.example.org/r4');
  });

  test('discovery rows cannot show a server as authoritative for an excluded code system', () => {
    const rows = api.buildRowsForCodeSystem({ codeSystem: CS_HIDDEN });
    expect(rows.map(r => r.serverCode)).toEqual([]);
    const okRows = api.buildRowsForCodeSystem({ codeSystem: CS_OK });
    expect(okRows.filter(r => r.authoritative).map(r => r.serverCode)).toContain('m');
  });

  test('resolve: excluded value set - not authoritative, not a candidate', () => {
    const hidden = api.resolveValueSet('R4', VS_HIDDEN, false).result;
    expect(urls(hidden.authoritative)).toEqual([]);
    expect(urls(hidden.candidates)).toEqual([]);
    const ok = api.resolveValueSet('R4', VS_OK, false).result;
    expect(urls(ok.authoritative)).toContain('https://m.example.org/r4');
  });

  test('discovery rows: excluded value set hidden', () => {
    const rows = api.buildRowsForValueSet({ valueSet: VS_HIDDEN });
    expect(rows.map(r => r.serverCode)).toEqual([]);
  });
});
