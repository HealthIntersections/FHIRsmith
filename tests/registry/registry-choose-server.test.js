// registry-choose-server.test.js
// Tests for choosing one server for a set of code systems (RegistryAPI.chooseServer and
// GET /choose-server) - the server side copy of the Java tooling's routing

const express = require('express');
const request = require('supertest');
const RegistryModule = require('../../registry/registry');
const RegistryCrawler = require('../../registry/crawler');
const RegistryAPI = require('../../registry/api');

const TX = 'http://tx.fhir.org/r4';
const AU = 'https://tx.au.example/fhir';
const NZ = 'https://tx.nz.example/fhir';
const OTHER = 'https://other.example/fhir';
const DEFAULT = 'https://default.example/fhir';

function version(address, terminologies, valuesets = []) {
  return { version: '4.0.1', address, security: 'open', terminologies, valuesets };
}

function server(code, address, authoritative, terminologies, valuesets = []) {
  return {
    code, name: code, address, authoritative, 'authoritative-valuesets': '', usageList: [],
    versions: [version(address, terminologies, valuesets)]
  };
}

const DATA = {
  version: '1',
  address: 'https://example.org/tx-servers.json',
  registries: [{
    code: 'test', name: 'Test',
    servers: [
      server('tx', TX, 'http://hl7.org/*,http://terminology.hl7.org/*', [
        'http://loinc.org', 'http://snomed.info/sct', 'http://terminology.hl7.org/CodeSystem/v2-0203',
        { uri: 'http://example.org/cs/shared', content: 'complete' }
      ]),
      server('au', AU, 'https://au.example/CodeSystem*', [
        'https://au.example/CodeSystem/a', 'https://au.example/CodeSystem/b',
        'http://terminology.hl7.org/CodeSystem/v2-0203',
        { uri: 'http://example.org/cs/shared', content: 'complete' },
        { uri: 'http://example.org/cs/frag', content: 'not-present' }
      ]),
      server('nz', NZ, 'https://nz.example/CodeSystem*', [
        'https://nz.example/CodeSystem/x',
        { uri: 'http://example.org/cs/shared', content: 'complete' },
        'http://example.org/cs/other'
      ], ['https://nz.example/ValueSet/vs1']),
      server('other', OTHER, '', [
        { uri: 'http://example.org/cs/frag', content: 'complete' }
      ])
    ]
  }]
};

function makeApi() {
  const crawler = new RegistryCrawler();
  crawler.loadData(DATA);
  return new RegistryAPI(crawler);
}

describe('RegistryAPI.chooseServer', () => {
  const api = makeApi();
  const choose = (systems, valueSet = '') => api.chooseServer('R4', systems, DEFAULT, valueSet);
  const last = r => r.log[r.log.length - 1];

  test('fhirVersion and default are required', () => {
    expect(() => api.chooseServer('', ['http://loinc.org'], DEFAULT)).toThrow(/FHIR version/);
    expect(() => api.chooseServer('R4', ['http://loinc.org'], '')).toThrow(/default server/);
  });

  test('no code systems: the default', () => {
    const r = choose([]);
    expect(r.server).toBe(DEFAULT);
    expect(r.log).toEqual(['No code systems: using the default server']);
  });

  test('a server authoritative for the one system', () => {
    const r = choose(['https://au.example/CodeSystem/a']);
    expect(r.server).toBe(AU);
    expect(last(r)).toBe(`Found authoritative server ${AU}`);
    expect(r.log[0]).toBe(`https://au.example/CodeSystem/a: authoritative [${AU}], candidates []`);
  });

  test('a server authoritative for all the systems', () => {
    const r = choose(['https://au.example/CodeSystem/a', 'https://au.example/CodeSystem/b']);
    expect(r.server).toBe(AU);
    expect(last(r)).toBe(`Found authoritative server ${AU}`);
  });

  test('authoritative for one, candidate for the other', () => {
    const r = choose(['https://au.example/CodeSystem/a', 'http://terminology.hl7.org/CodeSystem/v2-0203']);
    expect(r.server).toBe(AU);
    expect(last(r)).toBe(`Found partially authoritative server ${AU}`);
  });

  test('a system nobody hosts does not constrain the choice', () => {
    const r = choose(['https://au.example/CodeSystem/a', 'http://unknown.example/cs']);
    expect(r.server).toBe(AU);
    expect(last(r)).toBe(`Found partially authoritative server ${AU}`);
  });

  test('SNOMED CT with other systems: chosen for SNOMED CT alone', () => {
    const r = choose(['http://snomed.info/sct', 'https://nz.example/CodeSystem/x']);
    expect(r.server).toBe(DEFAULT);
    expect(r.log).toContain('Several code systems including SNOMED CT: choosing for SNOMED CT alone');
    expect(last(r)).toBe('Use primary server (the default) for http://snomed.info/sct');
  });

  test('a system with special handling goes to the default', () => {
    const r = choose(['http://loinc.org|2.80']);
    expect(r.server).toBe(DEFAULT);
    expect(last(r)).toBe('Use primary server (the default) for http://loinc.org');
  });

  test('a server that is a candidate for all of them', () => {
    // tx and au host shared but not other, so only nz is a candidate for both
    const r = choose(['http://example.org/cs/shared', 'http://example.org/cs/other']);
    expect(r.server).toBe(NZ);
    expect(last(r)).toBe(`Found candidate server ${NZ}`);
  });

  test('a candidate without a usable copy is passed over', () => {
    const r = choose(['http://example.org/cs/frag']);
    expect(r.server).toBe(OTHER);
    expect(r.log).toContain(`Candidate server ${AU} dropped for http://example.org/cs/frag: its copy of the code system is 'not-present'`);
    expect(last(r)).toBe(`Found candidate server ${OTHER}`);
  });

  test('no agreement: the most authoritative, the first on a tie', () => {
    const r = choose(['https://au.example/CodeSystem/a', 'https://nz.example/CodeSystem/x']);
    expect(r.server).toBe(AU);
    expect(last(r)).toBe(`Found most authoritative server ${AU}`);
  });

  test('nothing: the server the value set comes from', () => {
    const r = choose(['http://unknown.example/cs'], 'https://nz.example/ValueSet/vs1');
    expect(r.server).toBe(NZ);
    expect(r.log[0]).toBe('Value set: https://nz.example/ValueSet/vs1');
    expect(last(r)).toBe(`Not handled by any servers. Using source @ '${NZ}'`);
  });

  test('nothing, and the value set is not hosted anywhere: the default', () => {
    const r = choose(['http://unknown.example/cs', 'http://unknown.example/cs2'], 'http://unknown.example/vs');
    expect(r.server).toBe(DEFAULT);
    expect(last(r)).toBe('Handled by multiple servers. Using the default server');
  });
});

describe('GET /tx-reg/choose-server', () => {
  const module = new RegistryModule({ countRequest() {} });
  module.crawler = new RegistryCrawler();
  module.crawler.loadData(DATA);
  module.api = new RegistryAPI(module.crawler);
  module.setupRoutes();
  const app = express();
  app.use('/tx-reg', module.router);

  test('repeated system parameters', async () => {
    const res = await request(app).get('/tx-reg/choose-server').query({
      fhirVersion: 'R4', default: DEFAULT,
      system: ['https://au.example/CodeSystem/a', 'http://terminology.hl7.org/CodeSystem/v2-0203']
    });
    expect(res.status).toBe(200);
    expect(res.body.server).toBe(AU);
    expect(res.body.log).toHaveLength(3);
  });

  test('a single system parameter', async () => {
    const res = await request(app).get('/tx-reg/choose-server')
      .query({ fhirVersion: 'R4', default: DEFAULT, system: 'https://nz.example/CodeSystem/x' });
    expect(res.status).toBe(200);
    expect(res.body.server).toBe(NZ);
  });

  test('the default is required', async () => {
    const res = await request(app).get('/tx-reg/choose-server')
      .query({ fhirVersion: 'R4', system: 'http://loinc.org' });
    expect(res.status).toBe(400);
  });

  test('a malformed system is rejected', async () => {
    const res = await request(app).get('/tx-reg/choose-server')
      .query({ fhirVersion: 'R4', default: DEFAULT, system: 'not a url' });
    expect(res.status).toBe(400);
  });

  test('a browser gets JSON too', async () => {
    const res = await request(app).get('/tx-reg/choose-server').set('Accept', 'text/html')
      .query({ fhirVersion: 'R4', default: DEFAULT });
    expect(res.status).toBe(200);
    expect(res.body.server).toBe(DEFAULT);
  });
});
