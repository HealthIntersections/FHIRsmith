/**
 * Cold caches are kept while the source they were written for hasn't changed:
 *
 * - a code system's cold cache file records the source's base checksum it was written for;
 *   a file for the current base checksum is not downloaded again, however old it is
 *   (it used to be, once it was more than COLD_CACHE_FRESHNESS_MS old - every restart then
 *   downloaded every source from OCL again)
 * - the |default=<version> suffix of a discovery checksum, which comes and goes with whether
 *   discovery resolved the default version in that run, neither invalidates the loaded concepts
 *   nor a value set's cached compose
 */
const fs = require('fs/promises');
const path = require('path');
const { LanguageDefinitions } = require('../../library/languages');
const { I18nSupport } = require('../../library/i18nsupport');
const { OCLSourceCodeSystemFactory } = require('../../tx/ocl/cs-ocl');
const { OCLBackgroundJobQueue } = require('../../tx/ocl/jobs/background-queue');
const { CACHE_CS_DIR, getCacheFilePath } = require('../../tx/ocl/cache/cache-paths');
const { ensureCacheDirectories, atomicWriteFile } = require('../../tx/ocl/cache/cache-utils');
const { baseChecksum, sameDependencyChecksums } = require('../../tx/ocl/shared/checksum');

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

  it('compares dependency checksums by base', () => {
    const key = 'https://example.org/CodeSystem/x|';
    expect(sameDependencyChecksums({ [key]: 'abc|default=1.0' }, { [key]: 'abc' })).toBe(true);
    expect(sameDependencyChecksums({ [key]: 'abc' }, { [key]: 'abc|default=1.0' })).toBe(true);
    expect(sameDependencyChecksums({ [key]: 'abc|default=2.0' }, { [key]: 'abc|default=1.0' })).toBe(true);
    expect(sameDependencyChecksums({ [key]: 'xyz' }, { [key]: 'abc' })).toBe(false);
    expect(sameDependencyChecksums({ [key]: 'abc' }, {})).toBe(false);
    expect(sameDependencyChecksums({ [key]: 'abc' }, { 'https://example.org/CodeSystem/y|': 'abc' })).toBe(false);
    expect(sameDependencyChecksums({}, {})).toBe(true);
    expect(sameDependencyChecksums({ [key]: null }, { [key]: null })).toBe(true);
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

  it('drops the loaded concepts when the base checksum changes', async () => {
    const factory = await factoryWithOldColdCache('abc', 'abc');
    await settled(factory);

    factory.meta.checksum = 'xyz|default=1.0';
    factory.currentChecksum();
    expect(factory.isComplete).toBe(false);
    expect(factory.loadedConceptCount).toBe(-1);
  });
});
