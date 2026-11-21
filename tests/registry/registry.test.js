// registry-api.test.js
// Tests for the registry API with sample data

const { 
  ServerRegistries, 
  ServerRegistry, 
  ServerInformation, 
  ServerVersionInformation,
  ServerRegistryUtilities
} = require('../../registry/model');
const RegistryCrawler = require('../../registry/crawler');
const RegistryAPI = require('../../registry/api');

// Create sample test data covering the standard registry scenarios
function createSampleData() {
  const data = new ServerRegistries();
  data.address = 'https://registry.example.org';
  data.lastRun = new Date('2024-01-15T10:00:00Z');
  data.outcome = 'Crawled 2 registries successfully, 0 errors';
  data.doco = 'Test registry for unit tests';

  // Registry 1: Main Registry
  const reg1 = new ServerRegistry();
  reg1.code = 'main';
  reg1.name = 'Main Terminology Registry';
  reg1.address = 'https://main.registry.org';
  reg1.authority = 'HL7 International';

  // Server 1.1: TX Server (authoritative for LOINC and SNOMED)
  const server11 = new ServerInformation();
  server11.code = 'tx1';
  server11.name = 'TX Terminology Server';
  server11.address = 'https://tx.fhir.org';
  server11.accessInfo = 'Public FHIR terminology server';
  server11.authCSList = ['http://loinc.org*', 'http://snomed.info/sct*'];
  server11.authVSList = ['http://hl7.org/fhir/ValueSet/loinc*'];
  server11.usageList = ['production', 'public'];

  // Version 4.0.1 for TX Server
  const version111 = new ServerVersionInformation();
  version111.version = '4.0.1';
  version111.address = 'https://tx.fhir.org/r4';
  version111.security = '';
  version111.lastSuccess = new Date('2024-01-15T09:55:00Z');
  version111.lastTat = '250ms';
  version111.codeSystems = [
    { uri: 'http://loinc.org' },
    { uri: 'http://snomed.info/sct'},
    { uri: 'http://hl7.org/fhir/sid/icd-10'},
    { uri: 'http://www.nlm.nih.gov/research/umls/rxnorm'}
  ].sort();
  version111.valueSets = [
    'http://hl7.org/fhir/ValueSet/observation-codes',
    'http://hl7.org/fhir/ValueSet/condition-code',
    'http://hl7.org/fhir/ValueSet/loinc-diagnostic-report-codes'
  ].sort();
  server11.versions.push(version111);

  // Version 5.0.0 for TX Server
  const version112 = new ServerVersionInformation();
  version112.version = '5.0.0';
  version112.address = 'https://tx.fhir.org/r5';
  version112.security = 'open';
  version112.lastSuccess = new Date('2024-01-15T09:56:00Z');
  version112.lastTat = '180ms';
  version112.codeSystems = [
    { uri: 'http://loinc.org' },
    { uri: 'http://snomed.info/sct' },
    { uri: 'http://hl7.org/fhir/sid/icd-11' }
  ].sort();
  version112.valueSets = [
    'http://hl7.org/fhir/ValueSet/observation-codes'
  ].sort();
  server11.versions.push(version112);

  // Server 1.2: Ontoserver (authoritative for SNOMED)
  const server12 = new ServerInformation();
  server12.code = 'onto';
  server12.name = 'Ontoserver';
  server12.address = 'https://ontoserver.example.org';
  server12.accessInfo = 'Enterprise terminology server';
  server12.authCSList = ['http://snomed.info/sct*'];
  server12.authVSList = [];
  server12.usageList = ['production'];

  const version121 = new ServerVersionInformation();
  version121.version = '6.4.0';
  version121.address = 'https://ontoserver.example.org/fhir';
  version121.security = 'oauth';
  version121.lastSuccess = new Date('2024-01-15T09:50:00Z');
  version121.lastTat = '180ms';
  version121.codeSystems = [
    { uri: 'http://snomed.info/sct' },
    { uri: 'http://snomed.info/sct/32506021000036107' }, // Australian extension
    { uri: 'http://loinc.org' }
  ].sort();
  version121.valueSets = [
    'http://snomed.info/sct?fhir_vs=ecl/<404684003',
    'http://snomed.info/sct?fhir_vs=ecl/<373873005'
  ].sort();
  server12.versions.push(version121);

  reg1.servers.push(server11);
  reg1.servers.push(server12);

  // Registry 2: Test Registry
  const reg2 = new ServerRegistry();
  reg2.code = 'test';
  reg2.name = 'Test Terminology Registry';
  reg2.address = 'https://test.registry.org';
  reg2.authority = 'Testing Authority';

  // Server 2.1: Test Server with error
  const server21 = new ServerInformation();
  server21.code = 'test-server';
  server21.name = 'Test Server';
  server21.address = 'https://test.server.org';
  server21.accessInfo = 'Test server (currently down)';

  const version211 = new ServerVersionInformation();
  version211.version = '1.0.0';
  version211.address = 'https://test.server.org/fhir';
  version211.error = 'Connection timeout';
  version211.security = new Set();
  server21.versions.push(version211);

  // Server 2.2: Local Dev Server (authoritative for custom code systems)
  const server22 = new ServerInformation();
  server22.code = 'local';
  server22.name = 'Local Development Server';
  server22.address = 'http://localhost:8080';
  server22.accessInfo = 'Local development instance';
  server22.authCSList = ['http://example.org/codesystem/*'];
  server22.authVSList = ['http://example.org/valueset/*'];

  const version221 = new ServerVersionInformation();
  version221.version = '5.0.0';
  version221.address = 'http://localhost:8080/fhir';
  version221.security = 'open';
  version221.lastSuccess = new Date('2024-01-15T08:00:00Z');
  version221.lastTat = '50ms';
  version221.codeSystems = [
    { uri: 'http://example.org/codesystem/test1'},
    { uri: 'http://example.org/codesystem/test2'},
    { uri: 'http://hl7.org/fhir/sid/icd-10' }
  ].sort();
  version221.valueSets = [
    'http://example.org/valueset/test1',
    'http://example.org/valueset/test2'
  ].sort();
  server22.versions.push(version221);

  reg2.servers.push(server21);
  reg2.servers.push(server22);

  data.registries.push(reg1);
  data.registries.push(reg2);

  return data;
}

// Test suite
describe('Registry API Tests', () => {
  let crawler;
  let api;

  beforeEach(() => {
    crawler = new RegistryCrawler();
    crawler.loadData(createSampleData().toJSON());
    api = new RegistryAPI(crawler);
  });

  describe('Statistics', () => {
    test('should return correct statistics', () => {
      const stats = api.getStatistics();
      
      expect(stats.registryCount).toBe(2);
      expect(stats.serverCount).toBe(4);
      expect(stats.versionCount).toBe(5);
      expect(stats.workingVersions).toBe(4);
      expect(stats.uniqueCodeSystems).toBe(8);
      expect(stats.uniqueValueSets).toBe(7);
      expect(stats.errorCount).toBe(1);
    });
  });

  describe('Registry Queries', () => {
    test('should return all registries', () => {
      const registries = api.getRegistries();
      
      expect(registries).toHaveLength(2);
      expect(registries[0].code).toBe('main');
      expect(registries[0].serverCount).toBe(2);
      expect(registries[1].code).toBe('test');
      expect(registries[1].serverCount).toBe(2);
    });

    test('should return servers for a registry', () => {
      const servers = api.getServers('main');
      
      expect(servers).toHaveLength(2);
      expect(servers[0].code).toBe('tx1');
      expect(servers[0].versionCount).toBe(2);
      expect(servers[1].code).toBe('onto');
      expect(servers[1].authCSCount).toBe(1);
    });

    test('should return null for unknown registry', () => {
      const servers = api.getServers('unknown');
      expect(servers).toBeNull();
    });
  });

  describe('Code System Queries', () => {
    test('should find servers supporting LOINC', () => {
      const rows = api.buildRowsForCodeSystem({
        codeSystem: 'http://loinc.org'
      });
      
      expect(rows).toHaveLength(3); // tx1 v4, tx1 v5, onto v6
      // TX Server versions should be first (authoritative)
      expect(rows[0].serverCode).toBe('tx1');
      expect(rows[0].authoritative).toBe(true);
      expect(rows[1].serverCode).toBe('tx1');
      expect(rows[1].authoritative).toBe(true);
      // Ontoserver should be last (not authoritative for LOINC)
      expect(rows[2].serverCode).toBe('onto');
      expect(rows[2].authoritative).toBe(false);
    });

    test('should find servers supporting SNOMED CT', () => {
      const rows = api.buildRowsForCodeSystem({
        codeSystem: 'http://snomed.info/sct'
      });
      
      expect(rows).toHaveLength(3); // tx1 v4, tx1 v5, onto v6
      // All should be marked as authoritative
      const authCount = rows.filter(r => r.authoritative).length;
      expect(authCount).toBe(3);
    });

    test('should filter by registry code', () => {
      const rows = api.buildRowsForCodeSystem({
        registryCode: 'test',
        codeSystem: 'http://example.org/codesystem/test1'
      });
      
      expect(rows).toHaveLength(1);
      expect(rows[0].serverCode).toBe('local');
      expect(rows[0].authoritative).toBe(true);
    });

    test('should handle wildcard authoritative matching', () => {
      const rows = api.buildRowsForCodeSystem({
        codeSystem: 'http://example.org/codesystem/anything'
      });
      
      // Should match the local server due to wildcard
      const localRows = rows.filter(r => r.serverCode === 'local');
      expect(localRows).toHaveLength(1);
      expect(localRows[0].authoritative).toBe(true);
    });

    test('should filter by version', () => {
      const rows = api.buildRowsForCodeSystem({
        version: '4.0',
        codeSystem: 'http://loinc.org'
      });
      
      expect(rows).toHaveLength(1);
      expect(rows[0].version).toBe('4.0.1');
    });

    test('should exclude servers with errors unless authoritative', () => {
      const rows = api.buildRowsForCodeSystem({
        registryCode: 'test',
        codeSystem: 'http://hl7.org/fhir/sid/icd-10'
      });
      
      // Should only get the local server, not the test-server with error
      expect(rows).toHaveLength(1);
      expect(rows[0].serverCode).toBe('local');
      expect(rows[0].error).toBe('');
    });

    test('should return all servers when no filter specified', () => {
      const rows = api.buildRowsForCodeSystem({});
      
      // Should get all working versions (4 total)
      expect(rows).toHaveLength(4);
      // Error server should not be included
      expect(rows.every(r => r.serverCode !== 'test-server')).toBe(true);
    });
  });

  describe('Value Set Queries', () => {
    test('should find servers supporting specific value sets', () => {
      const rows = api.buildRowsForValueSet({
        valueSet: 'http://hl7.org/fhir/ValueSet/observation-codes'
      });
      
      expect(rows).toHaveLength(2); // tx1 v4 and v5
      expect(rows[0].serverCode).toBe('tx1');
      expect(rows[1].serverCode).toBe('tx1');
    });

    test('should handle wildcard value set matching', () => {
      const rows = api.buildRowsForValueSet({
        valueSet: 'http://hl7.org/fhir/ValueSet/loinc-diagnostic-report-codes'
      });
      
      // Should match TX server (both versions) due to wildcard authVSList
      // if the server is authoritative, ALL its versions are included
      expect(rows).toHaveLength(2);
      expect(rows[0].serverCode).toBe('tx1');
      expect(rows[1].serverCode).toBe('tx1');
      expect(rows[0].authoritative).toBe(true);
      expect(rows[1].authoritative).toBe(true);
      // Version 4.0.1 actually has the value set, 5.0.0 doesn't but is included because server is authoritative
      const versions = rows.map(r => r.version).sort();
      expect(versions).toEqual(['4.0.1', '5.0.0']);
    });

    test('should match authoritative wildcards for value sets', () => {
      const rows = api.buildRowsForValueSet({
        valueSet: 'http://example.org/valueset/custom'
      });
      
      // Should match local server due to wildcard
      const localRows = rows.filter(r => r.serverCode === 'local');
      expect(localRows).toHaveLength(1);
      expect(localRows[0].authoritative).toBe(true);
    });

    test('should return all working servers when no value set filter specified', () => {
      const rows = api.buildRowsForValueSet({});
      
      // Should get all working versions (4 total)
      expect(rows).toHaveLength(4);
      
      // Should not include error server
      expect(rows.every(r => r.serverCode !== 'test-server')).toBe(true);
      
      // Verify the servers returned
      const serverVersions = rows.map(r => `${r.serverCode}(${r.version})`).sort();
      expect(serverVersions).toEqual([
        'local(5.0.0)',
        'onto(6.4.0)',
        'tx1(4.0.1)',
        'tx1(5.0.0)'
      ]);
    });
  });

  describe('Error Handling', () => {
    test('should exclude servers with errors unless authoritative', () => {
      const rows = api.buildRowsForCodeSystem({
        registryCode: 'test',
        codeSystem: 'http://hl7.org/fhir/sid/icd-10'
      });
      
      // Should only get the local server, not the test-server with error
      expect(rows).toHaveLength(1);
      expect(rows[0].serverCode).toBe('local');
      expect(rows[0].error).toBe('');
    });

    test('should exclude servers with errors even if authoritative', () => {
      // Make the error server authoritative
      const data = crawler.getData();
      const testServer = data.registries[1].servers[0];
      testServer.authCSList = ['http://test.org/*'];
      
      const rows = api.buildRowsForCodeSystem({
        codeSystem: 'http://test.org/cs'
      });
      
      // Should not include the error server even though it's authoritative
      const hasNoErrorServer = rows.every(r => r.serverCode !== 'test-server');
      expect(hasNoErrorServer).toBe(true);
    });

    test('should never include error servers in unfiltered queries', () => {
      const csRows = api.buildRowsForCodeSystem({});
      const vsRows = api.buildRowsForValueSet({});
      
      // Neither should include the error server
      expect(csRows.every(r => r.error === '')).toBe(true);
      expect(vsRows.every(r => r.error === '')).toBe(true);
      
      // Both should have the same count (4 working versions)
      expect(csRows).toHaveLength(4);
      expect(vsRows).toHaveLength(4);
    });
  });

  describe('Version Filtering', () => {
    test('should filter by exact version', () => {
      const rows = api.buildRowsForCodeSystem({
        version: '4.0.1',
        codeSystem: 'http://loinc.org'
      });
      
      expect(rows).toHaveLength(1);
      expect(rows[0].version).toBe('4.0.1');
      expect(rows[0].serverCode).toBe('tx1');
    });

    test('should filter by major version', () => {
      const rows = api.buildRowsForCodeSystem({
        version: '4.0',
        codeSystem: 'http://loinc.org'
      });
      
      expect(rows).toHaveLength(1);
      expect(rows[0].version).toBe('4.0.1');
    });

    test('should filter by major version only', () => {
      const rows = api.buildRowsForCodeSystem({
        version: '5',
        codeSystem: 'http://loinc.org'
      });
      
      // Should match both 5.0.0 versions (tx1 and local)
      const v5Rows = rows.filter(r => r.version.startsWith('5'));
      expect(v5Rows.length).toBeGreaterThan(0);
      v5Rows.forEach(row => {
        expect(row.version).toMatch(/^5\./);
      });
    });

    test('should return empty when version does not match', () => {
      const rows = api.buildRowsForCodeSystem({
        version: '3.0',
        codeSystem: 'http://loinc.org'
      });
      
      expect(rows).toHaveLength(0);
    });
  });

  describe('Combined Filtering', () => {
    test('should filter by registry and server', () => {
      const rows = api.buildRowsForCodeSystem({
        registryCode: 'main',
        serverCode: 'tx1',
        codeSystem: 'http://loinc.org'
      });
      
      expect(rows).toHaveLength(2); // Two versions of tx1
      rows.forEach(row => {
        expect(row.registryCode).toBe('main');
        expect(row.serverCode).toBe('tx1');
      });
    });

    test('should filter by registry, server, and version', () => {
      const rows = api.buildRowsForCodeSystem({
        registryCode: 'main',
        serverCode: 'tx1',
        version: '4.0',
        codeSystem: 'http://loinc.org'
      });
      
      expect(rows).toHaveLength(1);
      expect(rows[0].registryCode).toBe('main');
      expect(rows[0].serverCode).toBe('tx1');
      expect(rows[0].version).toBe('4.0.1');
    });

    test('should return empty when filters do not match', () => {
      const rows = api.buildRowsForCodeSystem({
        registryCode: 'main',
        serverCode: 'local', // local is in 'test' registry, not 'main'
        codeSystem: 'http://loinc.org'
      });
      
      expect(rows).toHaveLength(0);
    });

    test('should work with wildcards and filters combined', () => {
      const rows = api.buildRowsForCodeSystem({
        registryCode: 'test',
        codeSystem: 'http://example.org/codesystem/anything'
      });
      
      // Should match local server due to wildcard, but only in test registry
      expect(rows).toHaveLength(1);
      expect(rows[0].registryCode).toBe('test');
      expect(rows[0].serverCode).toBe('local');
      expect(rows[0].authoritative).toBe(true);
    });
  });

  describe('Server Details', () => {
    test('should return detailed server information', () => {
      const details = api.getServerDetails('main', 'tx1');
      
      expect(details).toBeDefined();
      expect(details.code).toBe('tx1');
      expect(details.name).toBe('TX Terminology Server');
      expect(details.versions).toHaveLength(2);
      expect(details.authoritative).toBe('http://loinc.org*,http://snomed.info/sct*');
      expect(details.versions[0].details).toContain('Server Processed Ok');
    });

    test('should return null for unknown server', () => {
      const details = api.getServerDetails('main', 'unknown');
      expect(details).toBeNull();
    });

    test('should return null for unknown registry', () => {
      const details = api.getServerDetails('unknown', 'tx1');
      expect(details).toBeNull();
    });

    test('should include HTML formatted lists', () => {
      const details = api.getServerDetails('main', 'tx1');
      
      expect(details.versions[0].csList).toContain('<ul>');
      expect(details.versions[0].csList).toContain('http://loinc.org');
      expect(details.versions[0].vsList).toContain('<ul>');
      expect(details.versions[0].vsList).toContain('http://hl7.org/fhir/ValueSet/');
    });

    test('should include error information when present', () => {
      const details = api.getServerDetails('test', 'test-server');
      
      expect(details).toBeDefined();
      expect(details.versions).toHaveLength(1);
      expect(details.versions[0].error).toBe('Connection timeout');
      expect(details.versions[0].details).toContain('Connection timeout');
    });
  });

  describe('Best Server Selection', () => {
    test('should find best server for code system', () => {
      const best = api.findBestServer('codesystem', 'http://loinc.org', '4.0');
      
      expect(best).toBeDefined();
      expect(best.serverCode).toBe('tx1');
      expect(best.version).toBe('4.0.1');
      expect(best.authoritative).toBe(true);
    });

    test('should find best server for value set', () => {
      const best = api.findBestServer('valueset', 'http://example.org/valueset/test1');
      
      expect(best).toBeDefined();
      expect(best.serverCode).toBe('local');
      expect(best.authoritative).toBe(true);
    });

    test('should return null when no server found', () => {
      const best = api.findBestServer('codesystem', 'http://unknown.org/cs');
      expect(best).toBeNull();
    });

    test('should prefer authoritative server even if older', () => {
      const best = api.findBestServer('codesystem', 'http://snomed.info/sct');
      
      expect(best).toBeDefined();
      expect(best.authoritative).toBe(true);
      // Should be tx1 v5 (most recent among authoritative)
      expect(best.serverCode).toBe('tx1');
      expect(best.version).toBe('5.0.0');
    });

    test('should handle version filtering in best server selection', () => {
      const best = api.findBestServer('codesystem', 'http://loinc.org', '6');
      
      // Only Ontoserver has version 6.x
      expect(best).toBeDefined();
      expect(best.serverCode).toBe('onto');
      expect(best.version).toBe('6.4.0');
    });
  });
  describe('Utility Functions', () => {
    test('should correctly match wildcards', () => {
      expect(ServerRegistryUtilities.passesMask('http://loinc.org*', 'http://loinc.org')).toBe(true);
      expect(ServerRegistryUtilities.passesMask('http://loinc.org*', 'http://loinc.org/vs/123')).toBe(true);
      expect(ServerRegistryUtilities.passesMask('http://loinc.org', 'http://loinc.org')).toBe(true);
      expect(ServerRegistryUtilities.passesMask('http://loinc.org', 'http://loinc.org/vs/123')).toBe(false);
    });

    test('should match versions correctly', () => {
      expect(ServerRegistryUtilities.versionMatches('4.0', '4.0.1')).toBe(true);
      expect(ServerRegistryUtilities.versionMatches('4.0.1', '4.0.1')).toBe(true);
      expect(ServerRegistryUtilities.versionMatches('4', '4.0.1')).toBe(true);
      expect(ServerRegistryUtilities.versionMatches('5.0', '4.0.1')).toBe(false);
      expect(ServerRegistryUtilities.versionMatches('4.0.2', '4.0.1')).toBe(false);
    });

    test('should handle versioned code systems', () => {
      const hasMatch = ServerRegistryUtilities.hasMatchingCodeSystem(
        'http://snomed.info/sct|http://snomed.info/sct/900000000000207008/version/20240201',
        ['http://snomed.info/sct'],
        false
      );
      expect(hasMatch).toBe(true);
    });

    test('should handle versioned value sets', () => {
      const hasMatch = ServerRegistryUtilities.hasMatchingValueSet(
        'http://hl7.org/fhir/ValueSet/observation-codes|4.0.1',
        ['http://hl7.org/fhir/ValueSet/observation-codes'],
        false
      );
      expect(hasMatch).toBe(true);
    });

    test('should create row with correct data', () => {
      const data = crawler.getData();
      const registry = data.registries[0];
      const server = registry.servers[0];
      const version = server.versions[0];
      
      const row = ServerRegistryUtilities.createRow(registry, server, version, true);
      
      expect(row.serverName).toBe(server.name);
      expect(row.serverCode).toBe(server.code);
      expect(row.registryName).toBe(registry.name);
      expect(row.registryCode).toBe(registry.code);
      expect(row.version).toBe(version.version);
      expect(row.authoritative).toBe(true);
      expect(row.systems).toBe(version.codeSystems.length);
      expect(row.sets).toBe(version.valueSets.length);
    });
  });
});