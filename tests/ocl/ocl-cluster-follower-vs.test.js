const fs = require('fs/promises');
const { OCLValueSetProvider } = require('../../tx/ocl/vs-ocl');
const { VS_DISCOVERY_SNAPSHOT_PATH, CACHE_VS_DIR } = require('../../tx/ocl/cache/cache-paths');
const { ensureCacheDirectories, atomicWriteFile } = require('../../tx/ocl/cache/cache-utils');
const nock = require('nock');

const TEST_BASE_URL = 'https://ocl-test.example.org';

function makeVsSnapshotFile(entries) {
  return JSON.stringify({
    version: 1,
    entries: entries.map(e => ({
      id: e.id || 'test-collection',
      canonical_url: e.canonical_url || `http://example.org/ValueSet/${e.id || 'test'}`,
      version: e.version || null,
      name: e.name || e.id || 'Test Collection',
      full_name: e.full_name || e.name || e.id || 'Test Collection',
      description: e.description || null,
      publisher: e.publisher || 'TestOrg',
      owner: e.owner || 'TestOrg',
      owner_type: e.owner_type || 'Organization',
      default_locale: e.default_locale || null,
      experimental: false,
      immutable: false,
      preferred_source: e.preferred_source || null,
      concepts_url: e.concepts_url || `/orgs/TestOrg/collections/${e.id || 'test'}/concepts/`,
      expansion_url: e.expansion_url || null,
      short_code: e.short_code || e.id || 'test',
      updated_on: null
    }))
  }, null, 2);
}

describe('OCL Cluster Follower VS Discovery', () => {
  beforeEach(async () => {
    await ensureCacheDirectories(CACHE_VS_DIR);
    nock(TEST_BASE_URL).persist().get(/.*/).reply(200, []);
  });

  afterEach(async () => {
    nock.cleanAll();
    try { await fs.unlink(VS_DISCOVERY_SNAPSHOT_PATH); } catch (e) { /* ignore */ }
  });

  it('should load value sets from VS discovery snapshot', async () => {
    const snapshot = makeVsSnapshotFile([
      { id: 'vs-alpha', canonical_url: 'http://example.org/ValueSet/Alpha' },
      { id: 'vs-beta', canonical_url: 'http://example.org/ValueSet/Beta' }
    ]);
    await atomicWriteFile(VS_DISCOVERY_SNAPSHOT_PATH, snapshot);

    const provider = new OCLValueSetProvider({ baseUrl: TEST_BASE_URL, cluster: 'follower' });
    await provider.initialize();

    const all = await provider.listAllValueSets();
    expect(all).toContain('http://example.org/ValueSet/Alpha');
    expect(all).toContain('http://example.org/ValueSet/Beta');
  });

  it('should handle missing VS snapshot gracefully', async () => {
    try { await fs.unlink(VS_DISCOVERY_SNAPSHOT_PATH); } catch (e) { /* ignore */ }

    const provider = new OCLValueSetProvider({ baseUrl: TEST_BASE_URL, cluster: 'follower' });
    await provider.initialize();

    const all = await provider.listAllValueSets();
    expect(all.length).toBe(0);
  });

  it('should detect new value sets when VS snapshot is updated', async () => {
    const snapshot1 = makeVsSnapshotFile([
      { id: 'vs-one', canonical_url: 'http://example.org/ValueSet/One' }
    ]);
    await atomicWriteFile(VS_DISCOVERY_SNAPSHOT_PATH, snapshot1);

    const provider = new OCLValueSetProvider({ baseUrl: TEST_BASE_URL, cluster: 'follower' });
    await provider.initialize();

    let all = await provider.listAllValueSets();
    expect(all.length).toBe(1);

    // Simulate leader writing an updated snapshot
    await new Promise(r => setTimeout(r, 50));
    const snapshot2 = makeVsSnapshotFile([
      { id: 'vs-one', canonical_url: 'http://example.org/ValueSet/One' },
      { id: 'vs-two', canonical_url: 'http://example.org/ValueSet/Two' }
    ]);
    await atomicWriteFile(VS_DISCOVERY_SNAPSHOT_PATH, snapshot2);

    // searchValueSets triggers VS snapshot check for followers
    await provider.searchValueSets([], null);
    await new Promise(r => setTimeout(r, 50));

    all = await provider.listAllValueSets();
    expect(all).toContain('http://example.org/ValueSet/Two');
  });
});
