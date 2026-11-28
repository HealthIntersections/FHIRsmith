/**
 * Cold caches are kept while the source they were written for hasn't changed:
 *
 * - a code system's cold cache file records the source's base checksum it was written for;
 *   a file for the current base checksum is not downloaded again, however old it is
 *   (it used to be, once it was more than COLD_CACHE_FRESHNESS_MS old - every restart then
 *   downloaded every source from OCL again)
 * - the |default=<version> suffix of a discovery checksum, which comes and goes with whether
 *   discovery resolved the default version in that run, neither invalidates the loaded concepts
 *   nor a value set's cached compose by coming or going; a different suffix (a new default
 *   release) does
 */
const fs = require('fs/promises');
const path = require('path');
const { LanguageDefinitions } = require('../../library/languages');
const { I18nSupport } = require('../../library/i18nsupport');
const { OCLSourceCodeSystemFactory } = require('../../tx/ocl/cs-ocl');
const { OCLBackgroundJobQueue } = require('../../tx/ocl/jobs/background-queue');
const { CACHE_CS_DIR, getCacheFilePath } = require('../../tx/ocl/cache/cache-paths');
const { ensureCacheDirectories, atomicWriteFile } = require('../../tx/ocl/cache/cache-utils');
const { baseChecksum, defaultSuffix, sameChecksum, sameDependencyChecksums, collectionPath, sameCollectionSignature } = require('../../tx/ocl/shared/checksum');

const CANONICAL = 'http://example.org/ocl/CodeSystem/cold-cache-checksum';
const VERSION = '1.0';
const THREE_HOURS_AGO = (Date.now() - 3 * 60 * 60 * 1000) / 1000;

function coldCache(sourceChecksum) {
  const concepts = [{ code: 'a', display: 'A' }, { code: 'b', display: 'B' }, { code: 'c', display: 'C' }];
  const data = { canonicalUrl: CANONICAL, version: VERSION, fingerprint: 'fp3', conceptCount: concepts.length, concepts };
  if (sourceChecksum !== undefined) {
    data.sourceChecksum = sourceChecksum;
  }
  return JSON.stringify(data);
}

describe('OCL checksums: base and |default= suffix', () => {
  it('takes the suffix off', () => {
    expect(baseChecksum('abc|default=20250905-RNDS')).toBe('abc');
    expect(baseChecksum('abc')).toBe('abc');
    expect(baseChecksum(null)).toBe(null);
    expect(baseChecksum(undefined)).toBe(null);
  });

  it('finds the suffix', () => {
    expect(defaultSuffix('abc|default=20250905-RNDS')).toBe('|default=20250905-RNDS');
    expect(defaultSuffix('abc')).toBe(null);
    expect(defaultSuffix(null)).toBe(null);
  });

  it('accepts the suffix missing from one of the two, but not two different ones', () => {
    expect(sameChecksum('abc|default=1.0', 'abc')).toBe(true);
    expect(sameChecksum('abc', 'abc|default=1.0')).toBe(true);
    expect(sameChecksum('abc|default=1.0', 'abc|default=1.0')).toBe(true);
    expect(sameChecksum('abc', 'abc')).toBe(true);
    expect(sameChecksum('abc|default=2.0', 'abc|default=1.0')).toBe(false);
    expect(sameChecksum('xyz|default=1.0', 'abc|default=1.0')).toBe(false);
    expect(sameChecksum('xyz', 'abc')).toBe(false);
  });

  it('compares dependency checksums by base and default version', () => {
    const key = 'https://example.org/CodeSystem/x|';
    expect(sameDependencyChecksums({ [key]: 'abc|default=1.0' }, { [key]: 'abc' })).toBe(true);
    expect(sameDependencyChecksums({ [key]: 'abc' }, { [key]: 'abc|default=1.0' })).toBe(true);
    expect(sameDependencyChecksums({ [key]: 'abc|default=1.0' }, { [key]: 'abc|default=1.0' })).toBe(true);
    // a new default release: a value set over the source with no version given is built again
    expect(sameDependencyChecksums({ [key]: 'abc|default=2.0' }, { [key]: 'abc|default=1.0' })).toBe(false);
    expect(sameDependencyChecksums({ [key]: 'xyz' }, { [key]: 'abc' })).toBe(false);
    expect(sameDependencyChecksums({ [key]: 'abc' }, {})).toBe(false);
    expect(sameDependencyChecksums({ [key]: 'abc' }, { 'https://example.org/CodeSystem/y|': 'abc' })).toBe(false);
    expect(sameDependencyChecksums({}, {})).toBe(true);
    expect(sameDependencyChecksums({ [key]: null }, { [key]: null })).toBe(true);
  });
});

describe('OCL value set metadata signature: collection URLs compared as paths', () => {
  // as found on tx.gointerop.com (2026-11-25): the compose of BRCID10 cached on 2026-11-20, with the
  // URLs absolute from the API, and the signature from a discovery by the global listing, which
  // builds them from the owner and id - the same collection, unchanged since 2026-11-16
  const cachedSignature = JSON.stringify({
    url: 'https://terminologia.saude.gov.br/fhir/ValueSet/BRCID10', version: 'HEAD',
    lastUpdated: '2026-11-16T19:46:40.482Z', collectionId: 'BRCID10-1.0',
    conceptsUrl: 'https://oclapi2.ips.hsl.org.br/orgs/MS/collections/BRCID10-1.0/concepts',
    expansionUrl: 'https://oclapi2.ips.hsl.org.br/orgs/MS/collections/BRCID10-1.0/HEAD/expansions/autoexpand-HEAD',
    preferredSource: null
  });
  const currentSignature = JSON.stringify({
    url: 'https://terminologia.saude.gov.br/fhir/ValueSet/BRCID10', version: 'HEAD',
    lastUpdated: '2026-11-16T19:46:40.482Z', collectionId: 'BRCID10-1.0',
    conceptsUrl: '/orgs/MS/collections/BRCID10-1.0/concepts/',
    expansionUrl: '/orgs/MS/collections/BRCID10-1.0/HEAD/expansions/autoexpand-HEAD/',
    preferredSource: null
  });

  it('takes the host and the trailing slash off a collection URL', () => {
    expect(collectionPath('https://oclapi2.ips.hsl.org.br/orgs/MS/collections/X/concepts')).toBe('/orgs/MS/collections/X/concepts');
    expect(collectionPath('/orgs/MS/collections/X/concepts/')).toBe('/orgs/MS/collections/X/concepts');
    expect(collectionPath(null)).toBe(null);
  });

  it('accepts the same collection with absolute or built URLs', () => {
    expect(sameCollectionSignature(currentSignature, cachedSignature)).toBe(true);
    expect(sameCollectionSignature(cachedSignature, cachedSignature)).toBe(true);
  });

  it('rejects a collection updated since, or another collection', () => {
    const updated = JSON.parse(currentSignature);
    updated.lastUpdated = '2026-11-24T10:00:00.000Z';
    expect(sameCollectionSignature(JSON.stringify(updated), cachedSignature)).toBe(false);
    const other = JSON.parse(currentSignature);
    other.conceptsUrl = '/orgs/MS/collections/BRCID10-2.0/concepts/';
    expect(sameCollectionSignature(JSON.stringify(other), cachedSignature)).toBe(false);
    const otherId = JSON.parse(currentSignature);
    otherId.collectionId = 'BRCID10-2.0';
    expect(sameCollectionSignature(JSON.stringify(otherId), cachedSignature)).toBe(false);
  });

  it('rejects what it cannot read', () => {
    expect(sameCollectionSignature(currentSignature, null)).toBe(false);
    expect(sameCollectionSignature(currentSignature, 'not json')).toBe(false);
  });
});

describe('OCL code system cold cache kept while the source is unchanged', () => {
  const file = getCacheFilePath(CACHE_CS_DIR, CANONICAL, VERSION);
  let i18n;
  let enqueue;

  beforeAll(async () => {
    const languages = await LanguageDefinitions.fromFiles(path.join(__dirname, '../../tx/data'));
    i18n = new I18nSupport(path.join(__dirname, '../../translations'), languages);
    await i18n.load();
  });

  beforeEach(async () => {
    OCLSourceCodeSystemFactory.factoriesByKey.clear();
    await ensureCacheDirectories(CACHE_CS_DIR);
    enqueue = jest.spyOn(OCLBackgroundJobQueue, 'enqueue').mockImplementation(() => {});
  });

  afterEach(async () => {
    enqueue.mockRestore();
    try { await fs.unlink(file); } catch (e) { /* ignore */ }
  });

  async function factoryWithOldColdCache(sourceChecksum, metaChecksum) {
    await atomicWriteFile(file, coldCache(sourceChecksum));
    await fs.utimes(file, THREE_HOURS_AGO, THREE_HOURS_AGO);
    const meta = { id: 'checksum-test', canonicalUrl: CANONICAL, version: VERSION, checksum: metaChecksum,
      conceptsUrl: '/orgs/TestOrg/sources/checksum/concepts/' };
    // a master's (or single server's) factory: not a follower
    return new OCLSourceCodeSystemFactory(i18n, null, meta, 'leader');
  }

  async function settled(factory) {
    for (let i = 0; i < 100 && factory._coldCacheLoad; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    await new Promise(r => setTimeout(r, 10));
  }

  it('does not download again a cold cache written for the current base checksum, however old', async () => {
    const factory = await factoryWithOldColdCache('abc', 'abc|default=1.0');
    await settled(factory);
    expect(factory.isComplete).toBe(true);

    factory.scheduleBackgroundLoad('proactive-warm');
    await settled(factory);

    expect(enqueue).not.toHaveBeenCalled();
    expect(factory.isComplete).toBe(true);
    expect(factory.loadedConceptCount).toBe(3);
  });

  it('downloads again when the source changed (another base checksum)', async () => {
    const factory = await factoryWithOldColdCache('old', 'abc|default=1.0');
    await settled(factory);

    factory.scheduleBackgroundLoad('proactive-warm');
    await settled(factory);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(factory.isComplete).toBe(false);
  });

  it('keeps a cold cache written with or without the suffix while the default version is the same', async () => {
    for (const [written, current] of [['abc|default=1.0', 'abc'], ['abc|default=1.0', 'abc|default=1.0'], ['abc', 'abc|default=1.0']]) {
      enqueue.mockClear();
      OCLSourceCodeSystemFactory.factoriesByKey.clear();
      const factory = await factoryWithOldColdCache(written, current);
      await settled(factory);
      factory.scheduleBackgroundLoad('proactive-warm');
      await settled(factory);
      expect(enqueue).not.toHaveBeenCalled();
    }
  });

  it('downloads again when the source has a new default release', async () => {
    const factory = await factoryWithOldColdCache('abc|default=1.0', 'abc|default=2.0');
    await settled(factory);

    factory.scheduleBackgroundLoad('proactive-warm');
    await settled(factory);

    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('downloads an old file that does not say its source checksum once (as before)', async () => {
    const factory = await factoryWithOldColdCache(undefined, 'abc');
    await settled(factory);

    factory.scheduleBackgroundLoad('proactive-warm');
    await settled(factory);

    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('waits for the cold cache being read before deciding', async () => {
    const factory = await factoryWithOldColdCache('abc', 'abc');
    // straight away: the read the constructor started may still be going on
    factory.scheduleBackgroundLoad('proactive-warm');
    await settled(factory);

    expect(enqueue).not.toHaveBeenCalled();
    expect(factory.isComplete).toBe(true);
  });

  it('keeps the loaded concepts when only the |default= suffix comes or goes', async () => {
    const factory = await factoryWithOldColdCache('abc', 'abc');
    await settled(factory);
    expect(factory.isComplete).toBe(true);

    factory.meta.checksum = 'abc|default=1.0';
    factory.currentChecksum();
    expect(factory.isComplete).toBe(true);
    expect(factory.loadedConceptCount).toBe(3);

    factory.meta.checksum = 'abc';
    factory.currentChecksum();
    expect(factory.isComplete).toBe(true);
    expect(factory.loadedConceptCount).toBe(3);
  });

  it('drops the loaded concepts on a new default release, even after a run without the suffix', async () => {
    const factory = await factoryWithOldColdCache('abc|default=1.0', 'abc|default=1.0');
    await settled(factory);
    expect(factory.isComplete).toBe(true);

    factory.meta.checksum = 'abc';
    factory.currentChecksum();
    expect(factory.isComplete).toBe(true);

    factory.meta.checksum = 'abc|default=2.0';
    factory.currentChecksum();
    expect(factory.isComplete).toBe(false);
    expect(factory.loadedConceptCount).toBe(-1);
  });

  it('drops the loaded concepts when the base checksum changes', async () => {
    const factory = await factoryWithOldColdCache('abc', 'abc');
    await settled(factory);

    factory.meta.checksum = 'xyz|default=1.0';
    factory.currentChecksum();
    expect(factory.isComplete).toBe(false);
    expect(factory.loadedConceptCount).toBe(-1);
  });
});
