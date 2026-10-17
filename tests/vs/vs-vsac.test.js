const fs = require('fs');
const path = require('path');
const ini = require('ini');
const { describe, beforeAll, afterAll, test, expect } = require('@jest/globals');
const { VSACValueSetProvider } = require('../../tx/vs/vs-vsac');
const folders = require('../../library/folder-setup');

// Rate limiting: don't run more than once every 2 hours
const RATE_LIMIT_HOURS = 2;
const LAST_RUN_FILE = path.join(__dirname, '.vsac-last-run');
let allTestsPassed = true;

describe('VSACValueSetProvider', () => {
  let provider;
  let apiKey;
  let shouldSkipTests = false;
  const cacheFolder = folders.ensureFolder('vsac');

  beforeAll(async () => {
    // Skip tests in CI/cloud environments
    if (process.env.CI || process.env.GITHUB_ACTIONS || process.env.JENKINS_URL) {
      console.log('Skipping VSAC tests in CI environment');
      shouldSkipTests = true;
      return;
    }

    try {
      // Check rate limiting - minimise load on vsac
      if (await shouldSkipDueToRateLimit()) {
        console.log(`Skipping VSAC tests due to rate limiting (max once every ${RATE_LIMIT_HOURS} hours)`);
        shouldSkipTests = true;
        return;
      }

      // Read API key from passwords.ini
      const configPath = folders.ensureFilePath('config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      if (!config.modules?.tx?.vsackey) {
        console.log('VSAC API key not found in config.json - skipping tests');
        shouldSkipTests = true;
        return;
      }

      apiKey = config.modules?.tx?.vsackey;
      console.log('VSAC API key loaded successfully');

      // Create provider with limited refresh for testing
      provider = new VSACValueSetProvider({
        apiKey: apiKey,
        cacheFolder: cacheFolder,
        refreshIntervalHours: 24, // Set high to prevent auto-refresh during tests
        baseUrl: 'https://cts.nlm.nih.gov/fhir'
      });
      provider.initialize();

      // DON'T record the test run yet - only do it when tests actually succeed

    } catch (error) {
      console.log('Failed to setup VSAC tests (will skip):', error.message);
      shouldSkipTests = true;
    }
  }, 10000); // 10 second timeout

  afterEach(() => {
    if (expect.getState().numFailingTests > 0) {
      allTestsPassed = false;
    }
  });

  afterAll(async () => {
    if (provider) {
      // Clean up - stop refresh timer
      provider.stopRefreshTimer();
    }
    if (!shouldSkipTests && allTestsPassed) {
      await recordTestRun();
    }
  });

  /**
   * Check if we should skip tests due to rate limiting
   */
  async function shouldSkipDueToRateLimit() {
    try {
      const lastRunData = await fs.readFile(LAST_RUN_FILE, 'utf8');
      const lastRun = new Date(lastRunData.trim());
      const now = new Date();
      const hoursDiff = (now - lastRun) / (1000 * 60 * 60);

      return hoursDiff < RATE_LIMIT_HOURS;
    } catch (error) {
      // File doesn't exist or is corrupted, allow the test to run
      return false;
    }
  }

  /**
   * Record when tests were run
   */
  async function recordTestRun() {
    try {
      await fs.writeFile(LAST_RUN_FILE, new Date().toISOString());
    } catch (error) {
      console.warn('Could not record test run time:', error.message);
    }
  }

  describe('Initialization and Authentication', () => {
    test('should skip tests if conditions not met', () => {
      if (shouldSkipTests) {
        console.log('VSAC tests skipped - see beforeAll for reasons');
        return;
      }
    });

    test('should initialize without errors', async () => {
      if (shouldSkipTests) return;

      expect(provider).toBeDefined();
      expect(provider.apiKey).toBe(apiKey);
      expect(provider.cacheFolder).toBe(cacheFolder);
    });

    test('should validate configuration', () => {
      if (shouldSkipTests) return;

      // Test invalid configurations
      expect(() => {
        new VSACValueSetProvider({});
      }).toThrow('API key is required');

      expect(() => {
        new VSACValueSetProvider({ apiKey: 'test' });
      }).toThrow('Cache folder is required');
    });
  });

  describe('Limited VSAC Data Fetch', () => {
    test('should fetch limited data from VSAC (2 pages max)', async () => {
      if (shouldSkipTests) return;

      console.log('Starting limited VSAC data fetch test...');

      // Custom limited refresh - we'll override the refresh method to only fetch 2 pages
      let totalFetched = 0;
      let pageCount = 0;
      const maxPages = 2;

      // Mock the _fetchBundle method to limit pages
      const originalFetchBundle = provider._fetchBundle.bind(provider);
      provider._fetchBundle = async function(url) {
        pageCount++;
        console.log(`Fetching page ${pageCount}: ${url}`);

        if (pageCount > maxPages) {
          // Return empty bundle to stop pagination
          return {
            resourceType: 'Bundle',
            type: 'searchset',
            total: totalFetched,
            entry: [],
            link: []
          };
        }

        const result = await originalFetchBundle(url);
        totalFetched += result.entry ? result.entry.length : 0;
        return result;
      };

      // Perform limited refresh
      await provider.refreshValueSets();

      // Verify we fetched data from 2 pages
      expect(pageCount).toBe(maxPages+1);
      expect(totalFetched).toBeGreaterThan(0);

      // Should have around 200 ValueSets (100 per page * 2 pages)
      expect(totalFetched).toBeGreaterThanOrEqual(150); // Allow some tolerance
      expect(totalFetched).toBeLessThanOrEqual(250);

      console.log(`Successfully fetched ${totalFetched} ValueSets from ${pageCount} pages`);

      // Restore original method
      provider._fetchBundle = originalFetchBundle;


    }, 120000); // 2 minute timeout for network operations

    test('should have ValueSets loaded after fetch', async () => {
      if (shouldSkipTests) return;

      const mapSize = provider.getMapSize();
      expect(mapSize).toBeGreaterThan(0);

      console.log(`ValueSets loaded in map: ${mapSize}`);
    });

    test('should return statistics', async () => {
      if (shouldSkipTests) return;

      const stats = await provider.getStatistics();

      expect(stats).toHaveProperty('totalValueSets');
      expect(stats).toHaveProperty('byStatus');
      expect(stats).toHaveProperty('refreshInfo');
      expect(typeof stats.totalValueSets).toBe('number');
      expect(stats.totalValueSets).toBeGreaterThan(0);

      // Check refresh info
      expect(stats.refreshInfo).toHaveProperty('lastRefresh');
      expect(stats.refreshInfo).toHaveProperty('isRefreshing');
      expect(stats.refreshInfo).toHaveProperty('refreshIntervalHours');
      expect(stats.refreshInfo.lastRefresh).toBeInstanceOf(Date);

      console.log('VSAC statistics:', {
        totalValueSets: stats.totalValueSets,
        statusBreakdown: stats.byStatus,
        lastRefresh: stats.refreshInfo.lastRefresh,
        refreshIntervalHours: stats.refreshInfo.refreshIntervalHours
      });
    });
  });

  describe('ValueSet Operations', () => {
    let sampleValueSets = [];

    beforeAll(async () => {
      if (shouldSkipTests) return;

      // Get some sample ValueSets for testing
      const searchResults = await provider.searchValueSets([
        { name: 'status', value: 'active' }
      ]);

      sampleValueSets = searchResults.slice(0, 3); // Take first 3 for testing
      console.log(`Using ${sampleValueSets.length} sample ValueSets for testing`);
    });

    test('should fetch ValueSet by URL and version', async () => {
      if (shouldSkipTests || sampleValueSets.length === 0) return;

      const sample = sampleValueSets[0];
      console.log(`Testing fetch for: ${sample.url} v${sample.version}`);

      const fetched = await provider.fetchValueSet(sample.url, sample.version);

      expect(fetched).toBeDefined();
      expect(fetched.resourceType).toBe('ValueSet');
      expect(fetched.url).toBe(sample.url);
      expect(fetched.version).toBe(sample.version);
    });

    test('should search ValueSets by status', async () => {
      if (shouldSkipTests) return;

      const results = await provider.searchValueSets([
        { name: 'status', value: 'active' }
      ]);

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBeGreaterThan(0);

      // All results should have active status
      for (const vs of results) {
        expect(vs.status).toBe('active');
      }

      console.log(`Found ${results.length} active ValueSets`);
    });

    test('should search ValueSets by publisher pattern', async () => {
      if (shouldSkipTests) return;

      const results = await provider.searchValueSets([
        { name: 'publisher', value: 'Optum' }
      ]);

      expect(Array.isArray(results)).toBe(true);

      if (results.length > 0) {
        // All results should have publisher containing 'Optum'
        for (const vs of results) {
          expect(vs.jsonObj.publisher).toContain('Optum');
        }

        console.log(`Found ${results.length} ValueSets from Optum`);
      } else {
        console.log('No Optum ValueSets found in limited dataset');
      }
    });

    test('should handle empty search results gracefully', async () => {
      if (shouldSkipTests) return;

      const results = await provider.searchValueSets([
        { name: 'publisher', value: 'NonExistentPublisher12345' }
      ]);

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(0);
    });

    test('should validate input parameters', async () => {
      if (shouldSkipTests) return;

      await expect(
        provider.fetchValueSet('', '1.0.0')
      ).rejects.toThrow('URL must be a non-empty string');

      await expect(
        provider.fetchValueSet('http://example.com/test', 1.1)
      ).rejects.toThrow('Version must be a string');

      await expect(
        provider.searchValueSets('not an array')
      ).rejects.toThrow('Search parameters must be an array');
    });
  });

  describe('Refresh Management', () => {
    test('should track refresh state', async () => {
      if (shouldSkipTests) return;

      expect(provider.isCurrentlyRefreshing()).toBe(false);
      expect(provider.getLastRefreshTime()).toBeInstanceOf(Date);
    });

    test('should stop refresh timer', () => {
      if (shouldSkipTests) return;

      // This should not throw
      provider.stopRefreshTimer();
      expect(() => provider.stopRefreshTimer()).not.toThrow();
    });
  });

  describe('Error Handling', () => {
    test('should handle network errors gracefully', async () => {
      if (shouldSkipTests) return;

      // Create provider with invalid base URL to test error handling
      const badProvider = new VSACValueSetProvider({
        apiKey: apiKey,
        cacheFolder: path.join(cacheFolder, 'bad-test'),
        baseUrl: 'http://non-existent-vsac-server.invalid'
      });

      await expect(badProvider.forceRefresh()).rejects.toThrow();

      // Cleanup
      badProvider.stopRefreshTimer();
    });

    test('should handle authentication errors', async () => {
      if (shouldSkipTests) return;

      // Create provider with invalid API key
      const badProvider = new VSACValueSetProvider({
        apiKey: 'invalid-key',
        cacheFolder: path.join(cacheFolder, 'auth-test'),
        baseUrl: 'https://cts.nlm.nih.gov/fhir'
      });

      await expect(badProvider.forceRefresh()).rejects.toThrow();

      // Cleanup
      badProvider.stopRefreshTimer();
    });
  });

  describe('Integration Test Summary', () => {
    test('should report test summary', async () => {
      if (shouldSkipTests) {
        console.log('\n=== VSAC Test Summary ===');
        console.log('Tests were skipped due to:');
        console.log('- CI environment detected, OR');
        console.log('- API key not available in passwords.ini, OR');
        console.log('- Rate limiting (tests run less than 2 hours ago)');
        console.log('========================\n');
        return;
      }

      const stats = await provider.getStatistics();
      const mapSize = provider.getMapSize();

      console.log('\n=== VSAC Test Summary ===');
      console.log(`✅ Successfully connected to VSAC`);
      console.log(`✅ Fetched ValueSets: ${stats.totalValueSets}`);
      console.log(`✅ Loaded in map: ${mapSize}`);
      console.log(`✅ Last refresh: ${stats.refreshInfo.lastRefresh}`);
      console.log(`✅ Status breakdown:`, stats.byStatus);
      console.log('✅ Limited fetch test completed successfully');
      console.log('✅ Search functionality verified');
      console.log('========================\n');
    });
  });
});

// Helper to create the ini dependency mock if not available
if (typeof ini === 'undefined') {
  global.ini = {
    parse: (content) => {
      const lines = content.split('\n');
      const result = {};
      let currentSection = null;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
          continue;
        }

        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          currentSection = trimmed.slice(1, -1);
          result[currentSection] = {};
        } else if (currentSection && trimmed.includes('=')) {
          const [key, ...valueParts] = trimmed.split('=');
          result[currentSection][key.trim()] = valueParts.join('=').trim();
        }
      }

      return result;
    }
  };
}