// registry-unknown-host.test.js
// Tests for unknown-host: a code system resolution that finds nothing says when no server
// the request would consider hosts any code system on the url's host, so the client needn't
// ask about the host's other code systems. See the tx ecosystem IG: Unknown Hosts.

const {
  ServerRegistries,
  ServerRegistry,
  ServerInformation,
  ServerVersionInformation,
  ServerRegistryUtilities
} = require('../../registry/model');
const RegistryCrawler = require('../../registry/crawler');
const RegistryAPI = require('../../registry/api');

function makeServer(code, address, { fhirVersion = '4.0.1', authCS = [], usage = [], exclusions = [], hosts = [], vsHosts = [] } = {}) {
  const s = new ServerInformation();
  s.code = code;
  s.name = code;
  s.address = address;
  s.accessInfo = 'Open';
  s.authCSList = authCS;
  s.authVSList = [];
  s.usageList = usage;
  s.exclusions = exclusions;
  const v = new ServerVersionInformation();
  v.version = fhirVersion;
  v.address = `${address}/r${fhirVersion.charAt(0)}`;
  v.security = 'open';
  v.lastSuccess = new Date('2026-07-01T10:00:00Z');
  v.lastTat = '100ms';
  v.codeSystems = hosts.map(h => (typeof h === 'string' ? { uri: h } : h));
  v.valueSets = vsHosts;
  s.versions.push(v);
  return s;
}

// a: authoritative for, and hosts, a code system on known.example.org
// b: hosts a code system on cand.example.org (https), no claims - only ever a candidate
// c: hosts a code system on pub.example.org, but only for usage 'publication'
// d: hosts a code system on hidden.example.org, but excludes it
// e: hosts a code system on r5.example.org, at R5 only
// p: hosts a versioned code system on port.example.org:8080
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

  reg.servers.push(makeServer('a', 'https://a.example.org', {
    authCS: ['http://known.example.org/cs/*'],
    hosts: ['http://known.example.org/cs/a']
  }));
  reg.servers.push(makeServer('b', 'https://b.example.org', {
    hosts: ['https://cand.example.org/cs/b']
  }));
  reg.servers.push(makeServer('c', 'https://c.example.org', {
    usage: ['publication'],
    hosts: ['http://pub.example.org/cs/c']
  }));
  reg.servers.push(makeServer('d', 'https://d.example.org', {
    exclusions: ['http://hidden.example.org/cs/d'],
    hosts: ['http://hidden.example.org/cs/d']
  }));
  reg.servers.push(makeServer('e', 'https://e.example.org', {
    fhirVersion: '5.0.0',
    hosts: ['http://r5.example.org/cs/e']
  }));
  reg.servers.push(makeServer('p', 'https://p.example.org', {
    hosts: [{ uri: 'http://port.example.org:8080/cs/p', version: '1.0' }],
    vsHosts: ['http://dnvimatis.com/fhir/ValueSet/x']
  }));

  data.registries.push(reg);
  return data;
}

describe('urlHost', () => {
  test('http and https urls give the host, in lower case, with any port', () => {
    expect(ServerRegistryUtilities.urlHost('http://dnvimatis.com/fhir/CodeSystem/x')).toBe('dnvimatis.com');
    expect(ServerRegistryUtilities.urlHost('https://DNVIMATIS.com/x')).toBe('dnvimatis.com');
    expect(ServerRegistryUtilities.urlHost('HTTP://dnvimatis.com')).toBe('dnvimatis.com');
    expect(ServerRegistryUtilities.urlHost('http://port.example.org:8080/cs')).toBe('port.example.org:8080');
  });

  test('a version is ignored', () => {
    expect(ServerRegistryUtilities.urlHost('https://termgit.elga.gv.at/CodeSystem/x|1.2.0+20250723')).toBe('termgit.elga.gv.at');
    expect(ServerRegistryUtilities.urlHost('http://snomed.info/sct|http://snomed.info/sct/45991000052106')).toBe('snomed.info');
  });

  test('anything that is not an http or https url has no host', () => {
    expect(ServerRegistryUtilities.urlHost('urn:oid:1.2.246.537.6.55')).toBeNull();
    expect(ServerRegistryUtilities.urlHost('urn:rfc3881')).toBeNull();
    expect(ServerRegistryUtilities.urlHost('urn:uuid:9d1c6a4e-1f0b-4f6c-9b0e-2b7c8e1a0f11')).toBeNull();
    expect(ServerRegistryUtilities.urlHost('ftp://example.org/cs')).toBeNull();
    expect(ServerRegistryUtilities.urlHost('example.org/cs')).toBeNull();
    expect(ServerRegistryUtilities.urlHost('http://')).toBeNull();
    expect(ServerRegistryUtilities.urlHost('')).toBeNull();
    expect(ServerRegistryUtilities.urlHost(null)).toBeNull();
  });
});

describe('Resolution: unknown-host', () => {
  let api;

  beforeEach(() => {
    const crawler = new RegistryCrawler();
    crawler.loadData(createData().toJSON());
    api = new RegistryAPI(crawler);
  });

  function resolve(url, { fhirVersion = 'R4', authoritativeOnly = false, usage = '', language = '' } = {}) {
    return api.resolveCodeSystem(fhirVersion, url, authoritativeOnly, usage, language).result;
  }

  test('a code system on a host nobody hosts anything on: unknown-host', () => {
    const r = resolve('http://dnvimatis.com/fhir/CodeSystem/task-subcategoryid');
    expect(r['unknown-host']).toBe('dnvimatis.com');
    expect(r.authoritative).toBeUndefined();
    expect(r.candidates).toBeUndefined();
    expect(r.formatVersion).toBe('1');
  });

  test('a versioned url on an unknown host: unknown-host', () => {
    expect(resolve('https://termgit.elga.gv.at/CodeSystem/eimpf-impfstoffe|2.6.0+20230724')['unknown-host']).toBe('termgit.elga.gv.at');
  });

  test('the host is in lower case', () => {
    expect(resolve('http://DNVIMATIS.com/fhir/CodeSystem/x')['unknown-host']).toBe('dnvimatis.com');
  });

  test('a code system that is found: no unknown-host', () => {
    const r = resolve('http://known.example.org/cs/a');
    expect(r.authoritative.map(e => e.url)).toEqual(['https://a.example.org/r4']);
    expect(r['unknown-host']).toBeUndefined();
  });

  test('an unknown code system on a host where another is hosted: no unknown-host', () => {
    const r = resolve('http://known.example.org/cs/other');
    expect(r.authoritative).toBeUndefined();
    expect(r.candidates).toBeUndefined();
    expect(r['unknown-host']).toBeUndefined();
  });

  test('host matching ignores case', () => {
    expect(resolve('http://KNOWN.example.org/cs/other')['unknown-host']).toBeUndefined();
  });

  test('the host exactly: not the hosts under it, or names that start with it', () => {
    expect(resolve('http://www.known.example.org/cs/a')['unknown-host']).toBe('www.known.example.org');
    expect(resolve('http://known.example.org.au/cs/a')['unknown-host']).toBe('known.example.org.au');
    expect(resolve('http://example.org/cs/a')['unknown-host']).toBe('example.org');
  });

  test('http and https are the same host', () => {
    // b hosts https://cand.example.org/cs/b
    expect(resolve('http://cand.example.org/cs/other')['unknown-host']).toBeUndefined();
    expect(resolve('https://cand.example.org/cs/other')['unknown-host']).toBeUndefined();
    // a hosts http://known.example.org/cs/a
    expect(resolve('https://known.example.org/cs/other')['unknown-host']).toBeUndefined();
  });

  test('the port is part of the host', () => {
    expect(resolve('http://port.example.org:8080/cs/other')['unknown-host']).toBeUndefined();
    expect(resolve('http://port.example.org/cs/p')['unknown-host']).toBe('port.example.org');
  });

  test('authoritativeOnly: a host where a server is only a candidate is not unknown', () => {
    const r = resolve('https://cand.example.org/cs/b', { authoritativeOnly: true });
    expect(r.authoritative).toBeUndefined();
    expect(r.candidates).toBeUndefined();
    expect(r['unknown-host']).toBeUndefined();
  });

  test('language makes no difference', () => {
    expect(resolve('http://dnvimatis.com/fhir/CodeSystem/x', { language: 'de' })['unknown-host']).toBe('dnvimatis.com');
    expect(resolve('http://known.example.org/cs/other', { language: 'de' })['unknown-host']).toBeUndefined();
  });

  test('usage: a server the request would not consider does not make a host known', () => {
    expect(resolve('http://pub.example.org/cs/other')['unknown-host']).toBe('pub.example.org');
    expect(resolve('http://pub.example.org/cs/other', { usage: 'validation' })['unknown-host']).toBe('pub.example.org');
    expect(resolve('http://pub.example.org/cs/other', { usage: 'publication' })['unknown-host']).toBeUndefined();
  });

  test('excluded content does not make a host known', () => {
    const r = resolve('http://hidden.example.org/cs/d');
    expect(r.candidates).toBeUndefined();
    expect(r['unknown-host']).toBe('hidden.example.org');
  });

  test('FHIR version: a host known at another FHIR version is unknown at this one', () => {
    expect(resolve('http://r5.example.org/cs/other')['unknown-host']).toBe('r5.example.org');
    expect(resolve('http://r5.example.org/cs/other', { fhirVersion: 'R5' })['unknown-host']).toBeUndefined();
    expect(resolve('http://known.example.org/cs/other', { fhirVersion: 'R5' })['unknown-host']).toBe('known.example.org');
  });

  test('a host where only value sets are hosted is unknown for code systems', () => {
    expect(resolve('http://dnvimatis.com/fhir/CodeSystem/y')['unknown-host']).toBe('dnvimatis.com');
  });

  test('urls that are not http or https: no unknown-host', () => {
    for (const url of ['urn:oid:1.2.246.537.6.55', 'urn:rfc3881', 'urn:uuid:9d1c6a4e-1f0b-4f6c-9b0e-2b7c8e1a0f11']) {
      const r = resolve(url);
      expect(r.authoritative).toBeUndefined();
      expect(r.candidates).toBeUndefined();
      expect(r['unknown-host']).toBeUndefined();
    }
  });

  test('value set resolution never returns unknown-host', () => {
    const r = api.resolveValueSet('R4', 'http://nobody.example.org/ValueSet/x', false).result;
    expect(r['unknown-host']).toBeUndefined();
  });
});
