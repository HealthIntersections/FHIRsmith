const path = require('path');
const { describe, beforeAll, afterAll, test, expect } = require('@jest/globals');
const { PackageManager, PackageContentLoader} = require('../../library/package-manager');
const { PackageConceptMapProvider } = require('../../tx/cm/cm-package');
const folders = require('../../library/folder-setup');

describe('PackageConceptMapProvider', () => {
  let packageManager;
  let packagePath;
  let provider;
  const packageCacheDir = folders.ensureFolder('data/terminology-cache');
  const packageId = 'ch.fhir.ig.ch-core';
  const packageVersion = '2.0.0';

  beforeAll(async () => {
    // Setup package manager
    packageManager = new PackageManager(
      ['https://packages.simplifier.net', 'https://packages2.fhir.org/packages'],
      packageCacheDir
    );

    try {
      // Fetch the test package
      console.log(`Fetching package ${packageId}#${packageVersion}...`);
      packagePath = await packageManager.fetch(packageId, packageVersion);
      console.log(`Package extracted to: ${packagePath}`);

      // Create provider
      const fullPackagePath = path.join(packageCacheDir, packagePath);
      const loader = new PackageContentLoader(fullPackagePath);
      provider = new PackageConceptMapProvider(loader);

      // Initialize provider (this creates the database if needed)
      await provider.initialize();
      console.log('Provider initialized successfully');

    } catch (error) {
      console.error('Failed to setup test package:', error);
      throw error;
    }
  }, 60000); // 60 second timeout for package fetch

  afterAll(async () => {
    // Cleanup is not strictly necessary as test files can remain
    // But we could add database cleanup here if needed
  });

  describe('Initialization and Statistics', () => {
    test('should initialize without errors', async () => {
      expect(provider).toBeDefined();
      expect(provider.initialized).toBe(true);
    });

    test('should return statistics', async () => {
      const stats = await provider.getStatistics();

      expect(stats).toHaveProperty('totalConceptMaps');
      expect(stats).toHaveProperty('byStatus');
      expect(stats).toHaveProperty('totalSystems');
      expect(typeof stats.totalConceptMaps).toBe('number');
      expect(stats.totalConceptMaps).toBeGreaterThan(0);

      console.log('Package statistics:', stats);
    });

    test('should have conceptmaps loaded in map', () => {
      const mapSize = provider.getMapSize();
      expect(mapSize).toBeGreaterThan(0);
      console.log(`ConceptMaps loaded in map: ${mapSize}`);
    });
  });

  describe('fetchConceptMap', () => {
    test('should fetch conceptmap by exact URL and version', async () => {
      const url = 'http://fhir.ch/ig/ch-core/ConceptMap/bfs-encounter-class-to-fhir';
      const version = '2.0.0';

      const conceptMap = await provider.fetchConceptMap(url, version);

      expect(conceptMap).toBeDefined();
      expect(conceptMap.resourceType).toBe('ConceptMap');
      expect(conceptMap.url).toBe(url);
      expect(conceptMap.version).toBe(version);
      expect(conceptMap.id).toBe('bfs-encounter-class-to-fhir');
      expect(conceptMap.name).toBe('BfsEncounterClassToFhir');
    });

    test('should fetch conceptmap by URL alone when version matches', async () => {
      const url = 'http://fhir.ch/ig/ch-core/ConceptMap/bfs-encounter-class-to-fhir';
      const version = '0.8.0';

      const conceptMap = await provider.fetchConceptMap(url, version);

      expect(conceptMap).toBeDefined();
      expect(conceptMap.resourceType).toBe('ConceptMap');
      expect(conceptMap.url).toBe(url);
      expect(conceptMap.id).toBe('bfs-encounter-class-to-fhir');
      expect(conceptMap.name).toBe('BfsEncounterClassToFhir');
    });

    test('should handle semver major.minor resolution', async () => {
      const url = 'http://fhir.ch/ig/ch-core/ConceptMap/bfs-encounter-class-to-fhir';

      // Try to fetch with a different patch version
      const conceptMap = await provider.fetchConceptMap(url, '2.0.1');

      expect(conceptMap).toBeDefined();
      expect(conceptMap.url).toBe(url);
      expect(conceptMap.version).toBe('2.0.0'); // Should resolve to existing 0.8.0
    });

    test('should return null non-existent conceptmap', async () => {
      const result = await provider.fetchConceptMap('http://example.com/non-existent', '1.0.0')
      expect(result).toBeNull();
    });

    test('should validate input parameters', async () => {
      await expect(
        provider.fetchConceptMap('', '1.0.0')
      ).rejects.toThrow('URL must be a non-empty string');

      await expect(
        provider.fetchConceptMap('http://example.com/test', 1.0)
      ).rejects.toThrow('Version must be a string');
    });
  });

  describe('searchConceptMaps', () => {
    test('should search by status', async () => {
      const results = await provider.searchConceptMaps([
        { name: 'status', value: 'active' }
      ]);

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      // All results should have active status
      for (const vs of results) {
        expect(vs.status).toBe('active');
      }

      console.log(`Found ${results.length} active ConceptMaps`);
    });

    test('should search by publisher', async () => {
      const results = await provider.searchConceptMaps([
        { name: 'publisher', value: 'HL7' }
      ]);

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      // All results should have publisher containing 'HL7'
      for (const vs of results) {
        expect(vs.publisher).toContain('HL7');
      }

      console.log(`Found ${results.length} ConceptMaps with HL7 publisher`);
    });

    test('should search by name pattern', async () => {
      const results = await provider.searchConceptMaps([
        { name: 'name', value: 'Bfs' }
      ]);

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      // All results should have name containing 'CDS'
      for (const vs of results) {
        expect(vs.name).toContain('Bfs');
      }

      console.log(`Found ${results.length} ConceptMaps with 'CDS' in name`);
    });

    test('should search by url', async () => {
      const url = 'http://fhir.ch/ig/ch-core/ConceptMap/bfs-encounter-class-to-fhir';
      const results = await provider.searchConceptMaps([
        { name: 'url', value: url }
      ]);

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(1);
      expect(results[0].url).toBe(url);
      expect(results[0].name).toBe('BfsEncounterClassToFhir');
    });

    test('should search with multiple criteria', async () => {
      const results = await provider.searchConceptMaps([
        { name: 'status', value: 'active' },
        { name: 'publisher', value: 'HL7' }
      ]);

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      // All results should match both criteria
      for (const vs of results) {
        expect(vs.status).toBe('active');
        expect(vs.publisher).toContain('HL7');
      }

      console.log(`Found ${results.length} active HL7 ConceptMaps`);
    });

    test('should search by system in group', async () => {
      const results = await provider.searchConceptMaps([
        { name: 'source', value: 'http://fhir.ch/ig/ch-core/CodeSystem/bfs-medstats-20-encounterclass' }
      ]);

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      console.log(`Found ${results.length} ConceptMaps using the specified system`);
    });

    test('should handle empty search criteria', async () => {
      const results = await provider.searchConceptMaps([]);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);
    });

    test('should validate search parameters', async () => {
      await expect(
        provider.searchConceptMaps('not an array')
      ).rejects.toThrow('Search parameters must be an array');

      await expect(
        provider.searchConceptMaps([{ name: 123, value: 'test' }])
      ).rejects.toThrow('Search parameter must have string name and value properties');
    });
  });

  describe('Database Integrity', () => {
    test('should have consistent data between map and database', async () => {
      // Search for all active ConceptMaps
      const activeConceptMaps = await provider.searchConceptMaps([
        { name: 'status', value: 'active' }
      ]);

      // Verify each one can be fetched by URL
      for (const vs of activeConceptMaps.slice(0, 5)) { // Test first 5 to avoid long runtime
        const fetched = await provider.fetchConceptMap(vs.url, vs.version);
        expect(fetched.url).toBe(vs.url);
        expect(fetched.version).toBe(vs.version);
        expect(fetched.status).toBe(vs.status);
      }
    });

    test('should maintain referential integrity', async () => {
      const stats = await provider.getStatistics();
      const mapSize = provider.getMapSize();

      // The map should contain entries for URL-only keys plus versioned keys
      // So map total should be >= database total
      expect(mapSize).toBeGreaterThan(0);
      expect(stats.totalConceptMaps).toBeGreaterThan(0);
      expect(mapSize).toBeGreaterThanOrEqual(stats.totalConceptMaps);
    });
  });

  describe('id space', () => {
    let spaced;

    beforeAll(async () => {
      // a provider of its own, so the other tests see the concept maps as they are loaded
      spaced = new PackageConceptMapProvider(new PackageContentLoader(path.join(packageCacheDir, packagePath)));
      await spaced.initialize();
      spaced.assignIds('ch');
    });

    test('concept maps carry their prefixed id, and are fetched by it', async () => {
      const cm = [...spaced.conceptMapMap.values()][0];
      expect(cm.id.startsWith('ch-')).toBe(true);
      expect(cm.jsonObj.id).toBe(cm.id);
      expect(await spaced.fetchConceptMapById(cm.id)).toBe(cm);
    });

    test('a concept map is not found by its unprefixed id', async () => {
      const cm = [...spaced.conceptMapMap.values()][0];
      expect(await spaced.fetchConceptMapById(cm.id.substring('ch-'.length))).toBeNull();
    });

    test('search returns prefixed ids', async () => {
      for (const elements of [null, ['id', 'url']]) {
        const results = await spaced.searchConceptMaps([], elements);
        expect(results.length).toBeGreaterThan(0);
        for (const r of results) {
          expect(r.id.startsWith('ch-')).toBe(true);
          expect(r.id.startsWith('ch-ch-')).toBe(false);
        }
      }
    });
  });

  describe('excludeUrls', () => {
    let reduced;
    let gone;

    beforeAll(async () => {
      reduced = new PackageConceptMapProvider(new PackageContentLoader(path.join(packageCacheDir, packagePath)));
      await reduced.initialize();
      reduced.assignIds('core');
      gone = [...reduced.conceptMapMap.values()][0];
      reduced.excludeUrls(new Set([gone.url]));
    });

    test('an excluded concept map is not fetched, by url or by id', async () => {
      expect(await reduced.fetchConceptMap(gone.url, null)).toBeNull();
      expect(await reduced.fetchConceptMapById(gone.id)).toBeNull();
    });

    test('an excluded concept map is not found by search', async () => {
      for (const elements of [null, ['id', 'url']]) {
        const results = await reduced.searchConceptMaps([], elements);
        expect(results.some(r => r.id === gone.id)).toBe(false);
      }
    });

    test('the package says where it came from', () => {
      expect(reduced.sourcePackage()).toBe('ch.fhir.ig.ch-core');
    });
  });
});
