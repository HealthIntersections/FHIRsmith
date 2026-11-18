// A claim of authority for a code system covers every version of it: a request for
// url|version finds the servers that are authoritative for url (the same semantics as
// hasMatchingCodeSystem, which matches the hosted code system on its base url). Edition
// specific claims (SNOMED CT) carry the edition in the claim, and still only match it

const {
  ServerRegistries,
  ServerRegistry,
  ServerInformation,
  ServerVersionInformation
} = require('../../registry/model');
const RegistryCrawler = require('../../registry/crawler');
const RegistryAPI = require('../../registry/api');

const ICD = 'http://id.who.int/icd/release/11/mms';
const SCT = 'http://snomed.info/sct';
const CZ = 'http://snomed.info/sct/11000279109';

function makeServer(code, address, authCS, hosts) {
  const s = new ServerInformation();
  s.code = code;
  s.name = code;
  s.address = address;
  s.accessInfo = 'Open';
  s.authCSList = authCS;
  const v = new ServerVersionInformation();
  v.version = '4.0.1';
  v.address = `${address}/r4`;
  v.security = 'open';
  v.lastSuccess = new Date('2026-07-01T10:00:00Z');
  v.lastTat = '100ms';
  // as the crawler records them: the code system, and each version of it
  v.codeSystems = hosts.flatMap(h => [{ uri: h.uri }, h]);
  s.versions.push(v);
  return s;
}

function api() {
  const data = new ServerRegistries();
  data.address = 'https://registry.example.org';
  data.lastRun = new Date('2026-07-01T10:00:00Z');
  data.outcome = 'ok';
  const reg = new ServerRegistry();
  reg.code = 'main';
  reg.name = 'Main Registry';
  reg.address = 'https://main.registry.org';
  reg.authority = 'Test';
  reg.servers.push(makeServer('main', 'https://main.example.org', [ICD], [{ uri: ICD, version: '2024-01' }, { uri: SCT, version: `${SCT}/900000000000207008/version/20260701` }]));
  reg.servers.push(makeServer('other', 'https://other.example.org', [`${SCT}|${CZ}*`], [{ uri: ICD, version: '2025-01' }, { uri: SCT, version: `${CZ}/version/20260618` }]));
  data.registries.push(reg);
  const crawler = new RegistryCrawler();
  crawler.loadData(data.toJSON());
  return new RegistryAPI(crawler);
}

const urls = (list) => (list || []).map(e => e.url);

describe('Authority claims and versions', () => {
  test('a claim on the code system covers a request for a version of it', () => {
    const { result } = api().resolveCodeSystem('R4', `${ICD}|2020-01`, false);
    expect(urls(result.authoritative)).toEqual(['https://main.example.org/r4']);
    expect(urls(result.candidates)).toEqual(['https://other.example.org/r4']);
  });

  test('and a request without a version', () => {
    const { result } = api().resolveCodeSystem('R4', ICD, false);
    expect(urls(result.authoritative)).toEqual(['https://main.example.org/r4']);
  });

  test('an edition specific claim still only matches its edition', () => {
    const cz = api().resolveCodeSystem('R4', `${SCT}|${CZ}`, false).result;
    expect(urls(cz.authoritative)).toEqual(['https://other.example.org/r4']);
    const intl = api().resolveCodeSystem('R4', `${SCT}|http://snomed.info/sct/900000000000207008`, false).result;
    expect(urls(intl.authoritative)).toEqual([]);
  });

  test('discover agrees', () => {
    const res = api().discover({ url: `${ICD}|2020-01`, fhirVersion: 'R4', authoritativeOnly: 'true' });
    expect(JSON.stringify(res)).toContain('https://main.example.org');
    expect(JSON.stringify(res)).not.toContain('https://other.example.org');
  });
});
