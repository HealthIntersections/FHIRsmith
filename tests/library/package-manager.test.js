/**
 * PackageManager Test Suite
 * Tests FHIR package fetching with caching using hl7.fhir.us.core
 */

const { PackageManager, PackageContentLoader } = require('../../library/package-manager');
const fs = require('fs').promises;
const path = require('path');
const { checkThrottle, recordRun } = require('../utils/run-throttle');
const rimraf = (dir) => require('fs').rmSync(dir, { recursive: true, force: true });

/**
 * PackageManager and PackageContentLoader Test Suite
 * Tests FHIR package fetching, caching, and content loading
 */

// Timestamp management for slow tests
const TIMESTAMP_FILE = path.join(__dirname, '.last-integration-test-run');
const MIN_HOURS_BETWEEN_RUNS = 2;


// at most once every MIN_HOURS_BETWEEN_RUNS (tests/utils/run-throttle.js;
// FHIRSMITH_FORCE_SLOW_TESTS=1 runs them anyway)
function shouldRunSlowTests() {
    const throttle = checkThrottle(TIMESTAMP_FILE, MIN_HOURS_BETWEEN_RUNS);
    if (throttle.skip) {
        // eslint-disable-next-line no-console -- why the suite is skipped
        console.log(`Skipping slow integration tests: ${throttle.reason}`);
    }
    return !throttle.skip;
}

async function markTestsAsRun() {
    try {
        recordRun(TIMESTAMP_FILE);
    } catch (error) {
        console.warn('Could not update timestamp file:', error.message);
    }
}

// Check if we should run the tests
const runTests = shouldRunSlowTests();

// Conditional describe - only run if enough time has passed
(runTests ? describe : describe.skip)('Package Management', () => {
    const CACHE_FOLDER = path.join(process.cwd(), 'package-cache');
    const SERVERS = [
        'http://packages2.fhir.org/packages',
        'http://packages.fhir.org'
    ];

    // Mark tests as run after all tests complete
    afterAll(async () => {
        if (runTests) {
            await markTestsAsRun();
        }
    });

    describe('PackageManager', () => {
        const TEST_PACKAGE = 'hl7.fhir.us.core';
        let packageManager;

        beforeAll(() => {
            // Create package manager instance
            packageManager = new PackageManager(SERVERS, CACHE_FOLDER);
        });

        beforeEach(async () => {
            // Ensure cache folder exists
            await fs.mkdir(CACHE_FOLDER, { recursive: true });
        });

        afterEach(async () => {
            // Clean up cache after each test to ensure isolation
            // Comment this out if you want to preserve cache between tests for speed
            try {
                rimraf(CACHE_FOLDER);
            } catch (error) {
                // Ignore cleanup errors
            }
        });

        describe('Specific version fetching', () => {
            test('should fetch a specific version (4.0.0)', async () => {
                const result = await packageManager.fetch(TEST_PACKAGE, '4.0.0');
                expect(result).toBe('hl7.fhir.us.core#4.0.0');

                // Verify cache folder was created
                const cachedPath = path.join(CACHE_FOLDER, result);
                const stats = await fs.stat(cachedPath);
                expect(stats.isDirectory()).toBe(true);
            }, 30000);

            test('should fetch latest stable version (8.0.0)', async () => {
                const result = await packageManager.fetch(TEST_PACKAGE, '8.0.0');
                expect(result).toBe('hl7.fhir.us.core#8.0.0');
            }, 30000);

            test('should fetch a pre-release version (7.0.0-ballot)', async () => {
                const result = await packageManager.fetch(TEST_PACKAGE, '7.0.0-ballot');
                expect(result).toBe('hl7.fhir.us.core#7.0.0-ballot');
            }, 30000);

            test('should fetch an old version (1.0.0)', async () => {
                const result = await packageManager.fetch(TEST_PACKAGE, '1.0.0');
                expect(result).toBe('hl7.fhir.us.core#1.0.0');
            }, 30000);

            test('should fetch tools package for content loader tests', async () => {
                const result = await packageManager.fetch('hl7.fhir.uv.tools', '0.2.0');
                expect(result).toBe('hl7.fhir.uv.tools#0.2.0');

                // Verify the package contains expected files
                const packagePath = path.join(CACHE_FOLDER, result, 'package');
                const indexPath = path.join(packagePath, '.index.json');
                const indexExists = await fs.stat(indexPath).then(() => true).catch(() => false);
                expect(indexExists).toBe(true);
            }, 30000);
        });

        describe('Wildcard version resolution', () => {
            test('should resolve major wildcard (4?) to latest 4.x', async () => {
                const result = await packageManager.fetch(TEST_PACKAGE, '4.x?');
                expect(result).toBe('hl7.fhir.us.core#4.1.0');
            }, 30000);

            test('should resolve major wildcard (6?) to latest 6.x stable', async () => {
                const result = await packageManager.fetch(TEST_PACKAGE, '6.1?');
                expect(result).toBe('hl7.fhir.us.core#6.1.0');
            }, 30000);

            test('should resolve minor wildcard (6.0.*) to latest 6.0.x', async () => {
                const result = await packageManager.fetch(TEST_PACKAGE, '6.0.*');
                expect(result).toBe('hl7.fhir.us.core#6.0.0');
            }, 30000);

            test('should resolve minor wildcard (3.1.*) to latest 3.1.x', async () => {
                const result = await packageManager.fetch(TEST_PACKAGE, '3.1.*');
                expect(result).toBe('hl7.fhir.us.core#3.1.1');
            }, 30000);

            test('should resolve question mark wildcard (6.0?) to match 6.0.x', async () => {
                const result = await packageManager.fetch(TEST_PACKAGE, '6.0?');
                // Should match 6.0.0 or 6.0.0-ballot
                expect(result).toMatch(/^hl7\.fhir\.us\.core#6\.0/);
            }, 30000);

            test('should resolve question mark wildcard (7?) to latest 7.x', async () => {
                const result = await packageManager.fetch(TEST_PACKAGE, '7.0?');
                // Should match any 7.x version
                expect(result).toMatch(/^hl7\.fhir\.us\.core#7\./);
            }, 30000);

            test('should resolve x wildcard (4.0.x) to latest 4.0.x', async () => {
                const result = await packageManager.fetch(TEST_PACKAGE, '4.0.x');
                expect(result).toBe('hl7.fhir.us.core#4.0.0');
            }, 30000);

            test('should resolve X wildcard (5.0.X) to latest 5.0.x', async () => {
                const result = await packageManager.fetch(TEST_PACKAGE, '5.0.X');
                expect(result).toBe('hl7.fhir.us.core#5.0.1');
            }, 30000);

            test('should resolve complex wildcard (6.0.x-*)', async () => {
                const result = await packageManager.fetch(TEST_PACKAGE, '6.0.x-*');
                // Should match 6.0.0-ballot
                expect(result).toBe('hl7.fhir.us.core#6.0.0-ballot');
            }, 30000);

            test('should resolve 4.*.* to match any 4.x.x version', async () => {
                const result = await packageManager.fetch(TEST_PACKAGE, '4.*.*');
                expect(result).toBe('hl7.fhir.us.core#4.1.0');
            }, 30000);
        });

        describe('Cache behavior', () => {
            test('should use cached version on second fetch', async () => {
                // First fetch - downloads from server
                const result1 = await packageManager.fetch(TEST_PACKAGE, '3.0.0');
                expect(result1).toBe('hl7.fhir.us.core#3.0.0');

                // Mark time
                const startTime = Date.now();

                // Second fetch - should use cache (much faster)
                const result2 = await packageManager.fetch(TEST_PACKAGE, '3.0.0');
                expect(result2).toBe('hl7.fhir.us.core#3.0.0');

                const elapsed = Date.now() - startTime;
                // Cache hit should be very fast (< 100ms)
                expect(elapsed).toBeLessThan(100);
            }, 30000);

            test('should resolve wildcard and then use cache', async () => {
                // First fetch with wildcard
                const result1 = await packageManager.fetch(TEST_PACKAGE, '2.1?');
                expect(result1).toBe('hl7.fhir.us.core#2.1.0');

                // Second fetch with same wildcard should resolve to same version and use cache
                const startTime = Date.now();
                const result2 = await packageManager.fetch(TEST_PACKAGE, '2.1?');
                expect(result2).toBe('hl7.fhir.us.core#2.1.0');

                const elapsed = Date.now() - startTime;
                // Should still resolve version but cache the actual package
                expect(elapsed).toBeLessThan(2000);
            }, 30000);
        });

        describe('Error handling', () => {
            test('should throw error for non-existent package', async () => {
                await expect(
                  packageManager.fetch('non.existent.package', '1.0.0')
                ).rejects.toThrow(/Failed to fetch non\.existent\.package/);
            }, 30000);

            test('should throw error for non-existent version', async () => {
                await expect(
                  packageManager.fetch(TEST_PACKAGE, '99.99.99')
                ).rejects.toThrow(/Failed to fetch hl7\.fhir\.us\.core#99\.99\.99/);
            }, 30000);

            test('should throw error for wildcard with no matches', async () => {
                await expect(
                  packageManager.fetch(TEST_PACKAGE, '99?')
                ).rejects.toThrow(/Could not resolve version 99\?/);
            }, 30000);
        });

        describe('Server fallback', () => {
            test('should fall back to second server if first fails', async () => {
                // Create manager with bad first server
                const fallbackManager = new PackageManager(
                  ['http://invalid.server.example', 'http://packages.fhir.org'],
                  CACHE_FOLDER
                );

                // Should still work using second server
                const result = await fallbackManager.fetch(TEST_PACKAGE, '5.0.0');
                expect(result).toBe('hl7.fhir.us.core#5.0.0');
            }, 30000);

            test('should throw error if all servers fail', async () => {
                // Create manager with all bad servers
                const failManager = new PackageManager(
                  ['http://invalid1.example', 'http://invalid2.example'],
                  CACHE_FOLDER
                );

                await expect(
                  failManager.fetch(TEST_PACKAGE, '1.0.0')
                ).rejects.toThrow(/Failed to fetch hl7\.fhir\.us\.core#1\.0\.0 from any server/);
            }, 30000);
        });

        describe('Edge cases', () => {
            test('should handle version 0.0.0', async () => {
                const result = await packageManager.fetch(TEST_PACKAGE, '0.0.0');
                expect(result).toBe('hl7.fhir.us.core#0.0.0');
            }, 30000);

            test('should fetch snapshot versions', async () => {
                const result = await packageManager.fetch(TEST_PACKAGE, '6.1.0-snapshot1');
                expect(result).toBe('hl7.fhir.us.core#6.1.0-snapshot1');
            }, 30000);

            test('should handle multiple fetches in parallel', async () => {
                const promises = [
                    packageManager.fetch(TEST_PACKAGE, '1.0.0'),
                    packageManager.fetch(TEST_PACKAGE, '2.0.0'),
                    packageManager.fetch(TEST_PACKAGE, '3.0.0')
                ];

                const results = await Promise.all(promises);

                expect(results).toEqual([
                    'hl7.fhir.us.core#1.0.0',
                    'hl7.fhir.us.core#2.0.0',
                    'hl7.fhir.us.core#3.0.0'
                ]);
            }, 60000);
        });

        describe('Constructor validation', () => {
            test('should throw error if no servers provided', () => {
                expect(() => new PackageManager([], CACHE_FOLDER))
                  .toThrow('At least one package server must be provided');
            });

            test('should throw error if servers is null', () => {
                expect(() => new PackageManager(null, CACHE_FOLDER))
                  .toThrow('At least one package server must be provided');
            });
        });

        describe('fetchUrl', () => {
            test('should fetch a package from a direct URL and use name#version cache key', async () => {
                const packageManager = new PackageManager(SERVERS, CACHE_FOLDER);
                const url = 'https://packages2.fhir.org/packages/hl7.fhir.uv.tools/0.2.0';
                const result = await packageManager.fetchUrl(url);
                expect(result).toBe('hl7.fhir.uv.tools#0.2.0');

                // Verify the extracted package has content
                const packageDir = path.join(CACHE_FOLDER, result);
                const files = await fs.readdir(path.join(packageDir, 'package'));
                expect(files).toContain('package.json');
            }, 30000);

            test('should throw on duplicate fetch of same package', async () => {
                const packageManager = new PackageManager(SERVERS, CACHE_FOLDER);
                const url = 'https://packages2.fhir.org/packages/hl7.fhir.uv.tools/0.2.0';
                await packageManager.fetchUrl(url);
                await expect(
                    packageManager.fetchUrl(url)
                ).rejects.toThrow(/already exists in cache/);
            }, 30000);

            test('should throw on invalid URL', async () => {
                const packageManager = new PackageManager(SERVERS, CACHE_FOLDER);
                await expect(
                    packageManager.fetchUrl('https://invalid.example.com/nonexistent/package.tgz')
                ).rejects.toThrow();
            }, 30000);
        });

    });

    describe('PackageContentLoader', () => {
        const TOOLS_PACKAGE = 'hl7.fhir.uv.tools';
        const TOOLS_VERSION = '0.2.0';
        let packageManager;
        let loader;
        let packagePath;

        beforeAll(async () => {
            // Create package manager and fetch the tools package
            packageManager = new PackageManager(SERVERS, CACHE_FOLDER);

            // Ensure cache folder exists
            await fs.mkdir(CACHE_FOLDER, { recursive: true });

            // Fetch the tools package for testing
            const packageName = await packageManager.fetch(TOOLS_PACKAGE, TOOLS_VERSION);
            packagePath = path.join(CACHE_FOLDER, packageName);

            // Create loader instance
            loader = new PackageContentLoader(packagePath);
        }, 60000);

        afterAll(() => {
            // Clean up
            rimraf(CACHE_FOLDER);
        });

        describe('Initialization', () => {
            test('should initialize and load index', async () => {
                await loader.initialize();
                const index = await loader.getIndex();

                expect(index).toBeDefined();
                expect(index['index-version']).toBe(2);
                expect(index.files).toBeDefined();
                expect(Array.isArray(index.files)).toBe(true);
                expect(index.files.length).toBeGreaterThan(0);
            });

            test('should handle multiple initialization calls', async () => {
                await loader.initialize();
                await loader.initialize(); // Should not throw

                const index = await loader.getIndex();
                expect(index).toBeDefined();
            });
        });

        describe('Load by reference', () => {
            test('should load by resourceType and id', async () => {
                const resource = await loader.loadByReference({
                    resourceType: 'CodeSystem',
                    id: 'CDSActionType'
                });

                expect(resource).toBeDefined();
                expect(resource.resourceType).toBe('CodeSystem');
                expect(resource.id).toBe('CDSActionType');
                expect(resource.url).toBe('http://hl7.org/fhir/tools/CodeSystem/CDSActionType');
            });

            test('should load by canonical URL', async () => {
                const resource = await loader.loadByReference({
                    url: 'http://hl7.org/fhir/tools/CodeSystem/CDSActionType'
                });

                expect(resource).toBeDefined();
                expect(resource.resourceType).toBe('CodeSystem');
                expect(resource.id).toBe('CDSActionType');
            });

            test('should load by canonical URL with version', async () => {
                const resource = await loader.loadByReference({
                    url: 'http://hl7.org/fhir/tools/ValueSet/CDSActionType',
                    version: '0.2.0'
                });

                expect(resource).toBeDefined();
                expect(resource.resourceType).toBe('ValueSet');
                expect(resource.version).toBe('0.2.0');
            });

            test('should load ImplementationGuide', async () => {
                const resource = await loader.loadByReference({
                    resourceType: 'ImplementationGuide',
                    id: 'hl7.fhir.uv.tools'
                });

                expect(resource).toBeDefined();
                expect(resource.resourceType).toBe('ImplementationGuide');
                expect(resource.id).toBe('hl7.fhir.uv.tools');
                expect(resource.version).toBe('0.2.0');
            });

            test('should return null for non-existent resource', async () => {
                const resource = await loader.loadByReference({
                    resourceType: 'Patient',
                    id: 'non-existent'
                });

                expect(resource).toBeNull();
            });

            test('should handle resource without canonical URL', async () => {
                const resource = await loader.loadByReference({
                    resourceType: 'Binary',
                    id: 'CDSHookServices'
                });

                expect(resource).toBeDefined();
                expect(resource.resourceType).toBe('Binary');
                expect(resource.id).toBe('CDSHookServices');
            });
        });

        describe('Get resources by type', () => {
            test('should return all CodeSystems', async () => {
                const codeSystems = await loader.getResourcesByType('CodeSystem');

                expect(codeSystems).toBeDefined();
                expect(Array.isArray(codeSystems)).toBe(true);
                expect(codeSystems.length).toBeGreaterThan(0);

                // Check they're all CodeSystems
                codeSystems.forEach(cs => {
                    expect(cs.resourceType).toBe('CodeSystem');
                });

                // Should include CDSActionType
                const cdsActionType = codeSystems.find(cs => cs.id === 'CDSActionType');
                expect(cdsActionType).toBeDefined();
            });

            test('should return all StructureDefinitions', async () => {
                const structureDefs = await loader.getResourcesByType('StructureDefinition');

                expect(structureDefs).toBeDefined();
                expect(Array.isArray(structureDefs)).toBe(true);
                expect(structureDefs.length).toBeGreaterThan(0);

                // Check they're all StructureDefinitions
                structureDefs.forEach(sd => {
                    expect(sd.resourceType).toBe('StructureDefinition');
                });
            });

            test('should return empty array for non-existent type', async () => {
                const patients = await loader.getResourcesByType('Patient');

                expect(patients).toEqual([]);
            });

            test('should return all ValueSets', async () => {
                const valueSets = await loader.getResourcesByType('ValueSet');

                expect(valueSets).toBeDefined();
                expect(Array.isArray(valueSets)).toBe(true);
                expect(valueSets.length).toBeGreaterThan(0);

                valueSets.forEach(vs => {
                    expect(vs.resourceType).toBe('ValueSet');
                });
            });
        });

        describe('Load by filter', () => {
            test('should load all resources matching version filter', async () => {
                const filter = (entry) => entry.version === '0.2.0';
                const resources = await loader.loadByFilter(filter);

                expect(resources).toBeDefined();
                expect(Array.isArray(resources)).toBe(true);
                expect(resources.length).toBeGreaterThan(0);

                resources.forEach(resource => {
                    if (resource.version) {
                        expect(resource.version).toBe('0.2.0');
                    }
                });
            });

            test('should load resources with specific property', async () => {
                const filter = (entry) => entry.content === 'complete';
                const resources = await loader.loadByFilter(filter);

                expect(resources).toBeDefined();
                expect(Array.isArray(resources)).toBe(true);

                // All CodeSystems should have content: complete
                resources.forEach(resource => {
                    if (resource.resourceType === 'CodeSystem') {
                        expect(resource.content).toBe('complete');
                    }
                });
            });

            test('should load Extensions (StructureDefinitions with type Extension)', async () => {
                const filter = (entry) =>
                  entry.resourceType === 'StructureDefinition' &&
                  entry.type === 'Extension';
                const resources = await loader.loadByFilter(filter);

                expect(resources).toBeDefined();
                expect(Array.isArray(resources)).toBe(true);
                expect(resources.length).toBeGreaterThan(0);

                resources.forEach(resource => {
                    expect(resource.resourceType).toBe('StructureDefinition');
                    expect(resource.type).toBe('Extension');
                });
            });

            test('should load logical models', async () => {
                const filter = (entry) =>
                  entry.resourceType === 'StructureDefinition' &&
                  entry.kind === 'logical';
                const resources = await loader.loadByFilter(filter);

                expect(resources).toBeDefined();
                expect(Array.isArray(resources)).toBe(true);

                if (resources.length > 0) {
                    resources.forEach(resource => {
                        expect(resource.resourceType).toBe('StructureDefinition');
                        expect(resource.kind).toBe('logical');
                    });
                }
            });

            test('should return empty array when no matches', async () => {
                const filter = (entry) => entry.resourceType === 'Observation';
                const resources = await loader.loadByFilter(filter);

                expect(resources).toEqual([]);
            });

            test('should handle complex filters', async () => {
                const filter = (entry) =>
                  entry.url && entry.url.includes('/CodeSystem/');
                const resources = await loader.loadByFilter(filter);

                expect(resources).toBeDefined();
                expect(Array.isArray(resources)).toBe(true);
                expect(resources.length).toBeGreaterThan(0);

                resources.forEach(resource => {
                    expect(resource.resourceType).toBe('CodeSystem');
                });
            });
        });

        describe('Utility methods', () => {
            test('should check if resource exists', async () => {
                const exists1 = await loader.exists({
                    resourceType: 'CodeSystem',
                    id: 'CDSActionType'
                });
                expect(exists1).toBe(true);

                const exists2 = await loader.exists({
                    resourceType: 'Patient',
                    id: 'test'
                });
                expect(exists2).toBe(false);

                const exists3 = await loader.exists({
                    url: 'http://hl7.org/fhir/tools/ValueSet/CDSActionType'
                });
                expect(exists3).toBe(true);
            });

            test('should get all resources', async () => {
                const allResources = await loader.getAllResources();

                expect(allResources).toBeDefined();
                expect(Array.isArray(allResources)).toBe(true);
                expect(allResources.length).toBeGreaterThan(0);

                // Should have the expected resource types
                const resourceTypes = new Set(allResources.map(r => r.resourceType));
                expect(resourceTypes.has('ImplementationGuide')).toBe(true);
                expect(resourceTypes.has('CodeSystem')).toBe(true);
                expect(resourceTypes.has('ValueSet')).toBe(true);
                expect(resourceTypes.has('StructureDefinition')).toBe(true);
            });

            test('should get statistics', async () => {
                const stats = await loader.getStatistics();

                expect(stats.totalResources).toBeGreaterThan(0);
                expect(stats.indexVersion).toBe(2);
                expect(stats.resourceTypes).toBeDefined();

                // Should have counts for expected resource types
                expect(stats.resourceTypes['ImplementationGuide']).toBeGreaterThanOrEqual(1);
                expect(stats.resourceTypes['CodeSystem']).toBeGreaterThanOrEqual(1);
                expect(stats.resourceTypes['ValueSet']).toBeGreaterThanOrEqual(1);
                expect(stats.resourceTypes['StructureDefinition']).toBeGreaterThanOrEqual(1);
            });
        });

        describe('Edge cases', () => {
            test('should handle resources with same id but different types', async () => {
                // CDSActionType exists as both CodeSystem and ValueSet
                const codeSystem = await loader.loadByReference({
                    resourceType: 'CodeSystem',
                    id: 'CDSActionType'
                });
                expect(codeSystem).toBeDefined();
                expect(codeSystem.resourceType).toBe('CodeSystem');

                const valueSet = await loader.loadByReference({
                    resourceType: 'ValueSet',
                    id: 'CDSActionType'
                });
                expect(valueSet).toBeDefined();
                expect(valueSet.resourceType).toBe('ValueSet');

                // They should be different resources
                expect(codeSystem.url).not.toBe(valueSet.url);
            });

            test('should prefer versioned URL when both version and non-version exist', async () => {
                const resource = await loader.loadByReference({
                    url: 'http://hl7.org/fhir/tools/CodeSystem/CDSActionType',
                    version: '0.2.0'
                });

                expect(resource).toBeDefined();
                expect(resource.version).toBe('0.2.0');
            });

            test('should handle empty filter results', async () => {
                const resources = await loader.loadByFilter(() => false);
                expect(resources).toEqual([]);
            });

            test('should load specific extensions by URL', async () => {
                const resource = await loader.loadByReference({
                    url: 'http://hl7.org/fhir/tools/StructureDefinition/additional-binding'
                });

                expect(resource).toBeDefined();
                expect(resource.resourceType).toBe('StructureDefinition');
                expect(resource.type).toBe('Extension');
                expect(resource.id).toBe('additional-binding');
            });
        });

        describe('Error handling', () => {
            test('should throw error for invalid package folder', async () => {
                const badLoader = new PackageContentLoader('/non/existent/path');

                await expect(badLoader.initialize()).rejects.toThrow('no such file or directory');
            });
        });
    });
});