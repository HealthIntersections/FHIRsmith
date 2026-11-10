const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { OCLCodeSystemProvider, OCLSourceCodeSystemFactory } = require('../../tx/ocl/cs-ocl');
const { CACHE_CS_DIR, DISCOVERY_SNAPSHOT_PATH } = require('../../tx/ocl/cache/cache-paths');
const { ensureCacheDirectories, atomicWriteFile } = require('../../tx/ocl/cache/cache-utils');

const TEST_CANONICAL = 'http://example.org/ocl/CodeSystem/follower-test';
const TEST_VERSION = '1.0';

function makeSnapshotFile(entries) {
  return JSON.stringify({
    version: 1,
    timestamp: new Date().toISOString(),
    entries: entries.map(e => ({
      canonicalUrl: e.canonicalUrl,
      checksum: e.checksum || 'test-checksum',
      meta: {
        id: e.id || 'test-source',
        shortCode: e.shortCode || 'test',
        owner: e.owner || 'TestOrg',
        name: e.name || 'Test Source',
        description: e.description || 'A test source',
        canonicalUrl: e.canonicalUrl,
        version: e.version || null,
        conceptsUrl: e.conceptsUrl || '/orgs/TestOrg/sources/test/concepts/',
        checksum: e.checksum || 'test-checksum'
      },
      csJson: {
        resourceType: 'CodeSystem',
        id: e.id || 'test-source',
        url: e.canonicalUrl,
        version: e.version || null,
        name: e.name || 'Test Source',
        title: e.title || 'Test Source Title',
        status: 'active',
        description: e.description || 'A test source',
        publisher: e.owner || 'TestOrg',
        caseSensitive: e.caseSensitive !== undefined ? e.caseSensitive : true,
        language: e.language || null,
        filter: [],
        property: [],
        extension: [{ url: 'http://fhirsmith.io/StructureDefinition/ocl-codesystem', valueBoolean: true }],
        content: 'not-present'
      }
    }))
  }, null, 2);
}

describe('OCL Cluster Follower', () => {
  beforeEach(async () => {
    OCLSourceCodeSystemFactory.factoriesByKey.clear();
    await ensureCacheDirectories(CACHE_CS_DIR);
  });

  afterEach(async () => {
    try { await fs.unlink(DISCOVERY_SNAPSHOT_PATH); } catch (e) { /* ignore */ }
  });

  describe('OCLCodeSystemProvider follower initialization', () => {
    it('should load code systems from discovery snapshot', async () => {
      const snapshotContent = makeSnapshotFile([{
        canonicalUrl: TEST_CANONICAL,
        version: TEST_VERSION,
        id: 'follower-test',
        name: 'Follower Test',
        description: 'Tests follower initialization',
        owner: 'TestOrg',
        caseSensitive: false
      }]);
      await atomicWriteFile(DISCOVERY_SNAPSHOT_PATH, snapshotContent);

      const provider = new OCLCodeSystemProvider({ cluster: 'follower' });
      await provider.initialize();

      const codeSystems = await provider.listCodeSystems('5.0', null);
      expect(codeSystems.length).toBe(1);
      expect(codeSystems[0].url).toBe(TEST_CANONICAL);
      expect(codeSystems[0].version).toBe(TEST_VERSION);
    });

    it('should populate sourceMetaByUrl so getSourceMetas returns metas', async () => {
      const snapshotContent = makeSnapshotFile([{
        canonicalUrl: TEST_CANONICAL,
        version: TEST_VERSION,
        id: 'meta-test'
      }]);
      await atomicWriteFile(DISCOVERY_SNAPSHOT_PATH, snapshotContent);

      const provider = new OCLCodeSystemProvider({ cluster: 'follower' });
      await provider.initialize();

      const metas = provider.getSourceMetas();
      expect(metas.length).toBeGreaterThanOrEqual(1);
      const meta = metas.find(m => m.canonicalUrl === TEST_CANONICAL);
      expect(meta).toBeTruthy();
      expect(meta.id).toBe('meta-test');
      expect(meta.owner).toBe('TestOrg');
      expect(meta.codeSystem).toBeTruthy();
    });

    it('should preserve CodeSystem metadata (caseSensitive, publisher, description)', async () => {
      const snapshotContent = makeSnapshotFile([{
        canonicalUrl: TEST_CANONICAL,
        version: TEST_VERSION,
        caseSensitive: false,
        description: 'Important description',
        owner: 'CIEL'
      }]);
      await atomicWriteFile(DISCOVERY_SNAPSHOT_PATH, snapshotContent);

      const provider = new OCLCodeSystemProvider({ cluster: 'follower' });
      await provider.initialize();

      const codeSystems = await provider.listCodeSystems('5.0', null);
      const cs = codeSystems[0];
      expect(cs.jsonObj.caseSensitive).toBe(false);
      expect(cs.jsonObj.description).toBe('Important description');
      expect(cs.jsonObj.publisher).toBe('CIEL');
    });

    it('should use same id as master from snapshot', async () => {
      const snapshotContent = makeSnapshotFile([{
        canonicalUrl: TEST_CANONICAL,
        id: 'my-unique-source-id'
      }]);
      await atomicWriteFile(DISCOVERY_SNAPSHOT_PATH, snapshotContent);

      const provider = new OCLCodeSystemProvider({ cluster: 'follower' });
      await provider.initialize();

      const codeSystems = await provider.listCodeSystems('5.0', null);
      expect(codeSystems[0].id).toBe('my-unique-source-id');
    });

    it('should handle missing snapshot file gracefully', async () => {
      try { await fs.unlink(DISCOVERY_SNAPSHOT_PATH); } catch (e) { /* ignore */ }

      const provider = new OCLCodeSystemProvider({ cluster: 'follower' });
      await provider.initialize();

      const codeSystems = await provider.listCodeSystems('5.0', null);
      expect(codeSystems.length).toBe(0);
    });

    it('should load multiple code systems from snapshot', async () => {
      const snapshotContent = makeSnapshotFile([
        { canonicalUrl: 'http://example.org/cs/A', id: 'source-a', name: 'Source A' },
        { canonicalUrl: 'http://example.org/cs/B', id: 'source-b', name: 'Source B' },
        { canonicalUrl: 'http://example.org/cs/C', id: 'source-c', name: 'Source C' }
      ]);
      await atomicWriteFile(DISCOVERY_SNAPSHOT_PATH, snapshotContent);

      const provider = new OCLCodeSystemProvider({ cluster: 'follower' });
      await provider.initialize();

      const codeSystems = await provider.listCodeSystems('5.0', null);
      expect(codeSystems.length).toBe(3);
      const urls = codeSystems.map(cs => cs.url).sort();
      expect(urls).toEqual([
        'http://example.org/cs/A',
        'http://example.org/cs/B',
        'http://example.org/cs/C'
      ]);
    });
  });

  describe('follower snapshot reload', () => {
    it('should detect updated snapshot and apply changes', async () => {
      const snapshotV1 = makeSnapshotFile([{
        canonicalUrl: TEST_CANONICAL,
        version: TEST_VERSION,
        id: 'test-source',
        checksum: 'v1'
      }]);
      await atomicWriteFile(DISCOVERY_SNAPSHOT_PATH, snapshotV1);

      const provider = new OCLCodeSystemProvider({ cluster: 'follower' });
      await provider.initialize();

      expect((await provider.listCodeSystems('5.0', null)).length).toBe(1);

      // Simulate leader writing updated snapshot with a new source
      await new Promise(r => setTimeout(r, 50));
      const snapshotV2 = makeSnapshotFile([
        { canonicalUrl: TEST_CANONICAL, version: TEST_VERSION, id: 'test-source', checksum: 'v2' },
        { canonicalUrl: 'http://example.org/cs/New', id: 'new-source', checksum: 'v1' }
      ]);
      await atomicWriteFile(DISCOVERY_SNAPSHOT_PATH, snapshotV2);

      // Trigger the check cycle
      provider.getCodeSystemChanges('5.0', null);
      // Wait for the async refresh
      await new Promise(r => setTimeout(r, 100));

      const codeSystems = await provider.listCodeSystems('5.0', null);
      expect(codeSystems.length).toBe(2);
    });
  });
});
