// registry-language.test.js
// Tests for language specific authoritative claims and language-aware resolution
// See the tx ecosystem IG: Language Specific Claims
//
// The languages property on a server entry is an object: BCP-47 tag -> list of
// code system masks with the same syntax and meaning as authoritative, applying
// to requests in that language.

const {
  ServerRegistries,
  ServerRegistry,
  ServerInformation,
  ServerVersionInformation,
  ServerRegistryUtilities
} = require('../../registry/model');
const RegistryCrawler = require('../../registry/crawler');
const RegistryAPI = require('../../registry/api');

const CS = 'http://example.org/cs/colours';
const CS2 = 'http://example.org/cs/shapes';
const VS = 'http://example.org/vs/colours';

function makeVersion(address) {
  const v = new ServerVersionInformation();
  v.version = '4.0.1';
  v.address = address;
  v.security = 'open';
  v.lastSuccess = new Date('2026-07-01T10:00:00Z');
  v.lastTat = '100ms';
  v.codeSystems = [{ uri: CS }, { uri: CS2 }];
  v.valueSets = [VS];
  return v;
}

function makeServer(code, name, address, { authCS = [], authVS = [], languages = {} } = {}) {
  const s = new ServerInformation();
  s.code = code;
  s.name = name;
  s.address = address;
  s.accessInfo = 'Open';
  s.authCSList = authCS;
  s.authVSList = authVS;
  s.languages = languages;
  s.versions.push(makeVersion(`${address}/r4`));
  return s;
}

// Servers, per the design's test matrix:
// A: language independent claim on CS (and VS)
// B: claims CS for 'de' only; hosts CS
// D: claims CS for 'de-AT' only; hosts CS
// E: language independent claim on CS2 AND claims CS for 'de' - the mixed case
//    that motivated the object format (one server, both kinds of claim)
// X: hosts CS, no claims
function createLanguageSampleData() {
  const data = new ServerRegistries();
  data.address = 'https://registry.example.org';
  data.lastRun = new Date('2026-07-01T10:00:00Z');
  data.outcome = 'ok';

  const reg = new ServerRegistry();
  reg.code = 'main';
  reg.name = 'Main Registry';
  reg.address = 'https://main.registry.org';
  reg.authority = 'Test';

  reg.servers.push(makeServer('a', 'Default Server', 'https://a.example.org',
    { authCS: [CS + '*'], authVS: [VS + '*'] }));
  reg.servers.push(makeServer('b', 'German Server', 'https://b.example.org',
    { languages: { 'de': [CS + '*'] } }));
  reg.servers.push(makeServer('d', 'Austrian Server', 'https://d.example.org',
    { languages: { 'de-AT': [CS + '*'] } }));
  reg.servers.push(makeServer('e', 'Mixed Server', 'https://e.example.org',
    { authCS: [CS2 + '*'], languages: { 'de': [CS + '*'] } }));
  reg.servers.push(makeServer('x', 'Bystander Server', 'https://x.example.org', {}));

  data.registries.push(reg);
  return data;
}

describe('Language utilities', () => {
  test('parseAcceptLanguage handles single tags', () => {
    expect(ServerRegistryUtilities.parseAcceptLanguage('de')).toEqual([{ tag: 'de', q: 1.0 }]);
  });

  test('parseAcceptLanguage orders weighted lists by weight', () => {
    const parsed = ServerRegistryUtilities.parseAcceptLanguage('en;q=0.1, de-AT, de;q=0.9');
    expect(parsed.map(p => p.tag)).toEqual(['de-AT', 'de', 'en']);
  });

  test('parseAcceptLanguage drops wildcards and zero weights', () => {
    const parsed = ServerRegistryUtilities.parseAcceptLanguage('de, *;q=0.1, en;q=0');
    expect(parsed.map(p => p.tag)).toEqual(['de']);
  });

  test('parseAcceptLanguage returns null for nothing usable', () => {
    expect(ServerRegistryUtilities.parseAcceptLanguage('')).toBeNull();
    expect(ServerRegistryUtilities.parseAcceptLanguage(null)).toBeNull();
    expect(ServerRegistryUtilities.parseAcceptLanguage('*')).toBeNull();
  });

  test('languageTagCovers implements BCP-47 tags as masks', () => {
    expect(ServerRegistryUtilities.languageTagCovers('de', 'de')).toBe(true);
    expect(ServerRegistryUtilities.languageTagCovers('de', 'de-AT')).toBe(true);
    expect(ServerRegistryUtilities.languageTagCovers('de', 'de-CH-1996')).toBe(true);
    expect(ServerRegistryUtilities.languageTagCovers('de', 'dent')).toBe(false);
    expect(ServerRegistryUtilities.languageTagCovers('de-AT', 'de')).toBe(false);
    expect(ServerRegistryUtilities.languageTagCovers('DE', 'de-at')).toBe(true); // case insensitive
  });
});

describe('matchAuthCS', () => {
  const langs = (v) => ServerRegistryUtilities.parseAcceptLanguage(v);

  test('language independent claims match with or without a request language', () => {
    const a = makeServer('a', 'A', 'https://a.example.org', { authCS: [CS + '*'] });
    expect(a.matchAuthCS(CS, null).isAuth).toBe(true);
    expect(a.matchAuthCS(CS, langs('de')).isAuth).toBe(true);
    expect(a.matchAuthCS(CS, langs('de')).scoped).toBe(false);
  });

  test('language specific claims are invisible without a request language', () => {
    const b = makeServer('b', 'B', 'https://b.example.org', { languages: { 'de': [CS + '*'] } });
    expect(b.matchAuthCS(CS, null).isAuth).toBe(false);
    expect(b.matchAuthCS(CS, langs('de')).isAuth).toBe(true);
    expect(b.matchAuthCS(CS, langs('de')).tag).toBe('de');
  });

  test('language specific claims are per code system', () => {
    const b = makeServer('b', 'B', 'https://b.example.org', { languages: { 'de': [CS + '*'] } });
    expect(b.matchAuthCS(CS2, langs('de')).isAuth).toBe(false);
  });

  test('mixed claims: independent and language specific on one server', () => {
    const e = makeServer('e', 'E', 'https://e.example.org',
      { authCS: [CS2 + '*'], languages: { 'de': [CS + '*'] } });
    // CS2: authoritative irrespective of language
    expect(e.matchAuthCS(CS2, null)).toEqual(expect.objectContaining({ isAuth: true, scoped: false }));
    expect(e.matchAuthCS(CS2, langs('fr'))).toEqual(expect.objectContaining({ isAuth: true, scoped: false }));
    // CS: only for de
    expect(e.matchAuthCS(CS, null).isAuth).toBe(false);
    expect(e.matchAuthCS(CS, langs('de'))).toEqual(expect.objectContaining({ isAuth: true, scoped: true, tag: 'de' }));
  });

  test('language specific matches score better than independent ones, more specific tags better still', () => {
    const both = makeServer('m', 'M', 'https://m.example.org',
      { authCS: [CS + '*'], languages: { 'de': [CS + '*'], 'de-AT': [CS + '*'] } });
    const deAt = both.matchAuthCS(CS, langs('de-AT'));
    expect(deAt.tag).toBe('de-AT'); // most specific claimed tag wins
    const independent = makeServer('a', 'A', 'https://a.example.org', { authCS: [CS + '*'] });
    expect(deAt.score).toBeLessThan(independent.matchAuthCS(CS, langs('de-AT')).score);
  });

  test('languages object round-trips through toJSON/fromJSON', () => {
    const e = makeServer('e', 'E', 'https://e.example.org',
      { authCS: [CS2 + '*'], languages: { 'de': [CS + '*'], 'de-AT': ['http://other/*'] } });
    const restored = ServerInformation.fromJSON(e.toJSON());
    expect(restored.languages).toEqual({ 'de': [CS + '*'], 'de-AT': ['http://other/*'] });
    expect(restored.authCSList).toEqual([CS2 + '*']);
    // legacy data without languages loads cleanly
    const legacy = e.toJSON();
    delete legacy.languages;
    expect(ServerInformation.fromJSON(legacy).languages).toEqual({});
  });
});

describe('Language-aware resolution', () => {
  let api;

  beforeEach(() => {
    const crawler = new RegistryCrawler();
    crawler.loadData(createLanguageSampleData().toJSON());
    api = new RegistryAPI(crawler);
  });

  function authUrls(result) {
    return (result.authoritative || []).map(e => e.url);
  }
  function candidateUrls(result) {
    return (result.candidates || []).map(e => e.url);
  }

  test('no language: language specific claims are invisible as authoritative', () => {
    const { result } = api.resolveCodeSystem('R4', CS, false);
    expect(authUrls(result)).toEqual(['https://a.example.org/r4']);
    // servers with only language specific claims still appear as candidates via hosting
    expect(candidateUrls(result)).toEqual(expect.arrayContaining([
      'https://b.example.org/r4', 'https://d.example.org/r4', 'https://x.example.org/r4']));
    result.authoritative.forEach(e => expect(e.languages).toBeUndefined());
  });

  test('language=de: language specific claims first, default server after, de-AT not matched', () => {
    const { result } = api.resolveCodeSystem('R4', CS, false, '', 'de');
    // b and e both claim CS for de (same score); a matched on its authoritative list
    expect(authUrls(result)).toEqual([
      'https://b.example.org/r4', 'https://e.example.org/r4', 'https://a.example.org/r4']);
    expect(result.authoritative[0].languages).toEqual(['de']);
    expect(result.authoritative[1].languages).toEqual(['de']);
    expect(result.authoritative[2].languages).toBeUndefined();
    // de-AT claim does not cover plain de - candidate only
    expect(candidateUrls(result)).toEqual(expect.arrayContaining(['https://d.example.org/r4']));
  });

  test('language=de-AT: most specific claimed tag wins', () => {
    const { result } = api.resolveCodeSystem('R4', CS, false, '', 'de-AT');
    expect(authUrls(result)).toEqual([
      'https://d.example.org/r4',  // de-AT: exact, most specific
      'https://b.example.org/r4',  // de covers de-AT
      'https://e.example.org/r4',  // de covers de-AT
      'https://a.example.org/r4'   // authoritative list, language independent
    ]);
    expect(result.authoritative[0].languages).toEqual(['de-AT']);
  });

  test('language=fr: no language specific claim matches, default routing only', () => {
    const { result } = api.resolveCodeSystem('R4', CS, false, '', 'fr');
    expect(authUrls(result)).toEqual(['https://a.example.org/r4']);
  });

  test('mixed server: language independent claim unaffected by language parameter', () => {
    const noLang = api.resolveCodeSystem('R4', CS2, false).result;
    expect(authUrls(noLang)).toEqual(['https://e.example.org/r4']);
    const fr = api.resolveCodeSystem('R4', CS2, false, '', 'fr').result;
    expect(authUrls(fr)).toEqual(['https://e.example.org/r4']);
    expect(fr.authoritative[0].languages).toBeUndefined();
  });

  test('weighted list: earlier (heavier) language dominates', () => {
    const { result } = api.resolveCodeSystem('R4', CS, false, '', 'fr, de;q=0.5');
    // nothing claims fr; de matches at lower weight - still ahead of the default server
    expect(authUrls(result)).toEqual([
      'https://b.example.org/r4', 'https://e.example.org/r4', 'https://a.example.org/r4']);
  });

  test('wildcard in the language list does not change routing', () => {
    const { result } = api.resolveCodeSystem('R4', CS, false, '', 'de, *;q=0.1');
    expect(authUrls(result)).toEqual([
      'https://b.example.org/r4', 'https://e.example.org/r4', 'https://a.example.org/r4']);
  });

  test('authoritativeOnly with language keeps ordering', () => {
    const { result } = api.resolveCodeSystem('R4', CS, true, '', 'de');
    expect(authUrls(result)).toEqual([
      'https://b.example.org/r4', 'https://e.example.org/r4', 'https://a.example.org/r4']);
    expect(result.candidates).toBeUndefined();
  });

  test('value set resolution: claims have no language dimension', () => {
    const noLang = api.resolveValueSet('R4', VS, false).result;
    const de = api.resolveValueSet('R4', VS, false, '', 'de').result;
    expect(authUrls(de)).toEqual(authUrls(noLang));
    expect(authUrls(de)).toEqual(['https://a.example.org/r4']);
  });

  test('discovery rows: language filter gates authoritative status', () => {
    const noLang = api.buildRowsForCodeSystem({ codeSystem: CS });
    expect(noLang.filter(r => r.authoritative).map(r => r.serverCode)).toEqual(['a']);

    const de = api.buildRowsForCodeSystem({ codeSystem: CS, language: 'de' });
    const authDe = de.filter(r => r.authoritative).map(r => r.serverCode).sort();
    expect(authDe).toEqual(['a', 'b', 'e']);
    // rows carry the tag of the matched language specific claim
    expect(de.find(r => r.serverCode === 'b').languages).toEqual(['de']);
    expect(de.find(r => r.serverCode === 'a').languages).toEqual([]);
  });

  test('candidates under a language request are marked language-support unknown', () => {
    const de = api.resolveCodeSystem('R4', CS, false, '', 'de').result;
    expect(de.candidates.length).toBeGreaterThan(0);
    de.candidates.forEach(c => expect(c['language-support']).toBe('unknown'));
    // authoritative entries are never marked - absence of `languages` already
    // signals default routing
    de.authoritative.forEach(a => expect(a['language-support']).toBeUndefined());
    // and without a language parameter, nothing is marked
    const noLang = api.resolveCodeSystem('R4', CS, false).result;
    noLang.candidates.forEach(c => expect(c['language-support']).toBeUndefined());
  });

  test('language parameter is harmless when nothing claims the language', () => {
    const noLang = api.resolveCodeSystem('R4', CS, false).result;
    const withLang = api.resolveCodeSystem('R4', CS, false, '', 'en').result;
    expect(authUrls(withLang)).toEqual(authUrls(noLang));
  });
});
