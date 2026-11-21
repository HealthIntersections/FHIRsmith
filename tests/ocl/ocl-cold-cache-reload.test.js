/**
 * A cluster follower reloads a source's cold cache file when the master rewrites it
 * (OCLSourceCodeSystemFactory.reloadColdCacheIfChanged, called on requests). One reload at a
 * time: requests that arrive while a reload is going on don't each start another (each one
 * read and parsed the whole file, synchronously, again)
 */
const fs = require('fs/promises');
const path = require('path');
const { LanguageDefinitions } = require('../../library/languages');
const { I18nSupport } = require('../../library/i18nsupport');
const { OCLSourceCodeSystemFactory } = require('../../tx/ocl/cs-ocl');
const { CACHE_CS_DIR, getCacheFilePath } = require('../../tx/ocl/cache/cache-paths');
const { ensureCacheDirectories, atomicWriteFile } = require('../../tx/ocl/cache/cache-utils');

const CANONICAL = 'http://example.org/ocl/CodeSystem/cold-cache-reload';
const VERSION = '1.0';

function coldCache(count) {
  const concepts = [];
  for (let i = 0; i < count; i++) {
    concepts.push({ code: `c${i}`, display: `Concept ${i}` });
  }
  return JSON.stringify({ canonicalUrl: CANONICAL, version: VERSION, fingerprint: `fp${count}`, conceptCount: count, concepts });
}

describe('OCL follower cold cache reload', () => {
  const file = getCacheFilePath(CACHE_CS_DIR, CANONICAL, VERSION);
  let i18n;

  beforeAll(async () => {
    const languages = await LanguageDefinitions.fromFiles(path.join(__dirname, '../../tx/data'));
    i18n = new I18nSupport(path.join(__dirname, '../../translations'), languages);
    await i18n.load();
  });

  beforeEach(async () => {
    OCLSourceCodeSystemFactory.factoriesByKey.clear();
    await ensureCacheDirectories(CACHE_CS_DIR);
  });

  afterEach(async () => {
    try { await fs.unlink(file); } catch (e) { /* ignore */ }
  });

  it('reloads a rewritten file once, however many requests ask while it does', async () => {
    await atomicWriteFile(file, coldCache(3));
    // a follower's factory for the source, as it makes them from the master's discovery snapshot
    const meta = { id: 'reload-test', canonicalUrl: CANONICAL, version: VERSION, checksum: 'v1',
      conceptsUrl: '/orgs/TestOrg/sources/reload/concepts/' };
    const factory = new OCLSourceCodeSystemFactory(i18n, null, meta, 'follower');
    // the load the factory starts when it is made
    for (let i = 0; i < 100 && factory.loadedConceptCount !== 3; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    expect(factory.loadedConceptCount).toBe(3);

    // the master rewrites the file (a later modification time)
    await new Promise(r => setTimeout(r, 20));
    await atomicWriteFile(file, coldCache(5));

    // count the reads of the file while five requests ask for a reload at once
    const readFile = fs.readFile;
    let reads = 0;
    fs.readFile = function (f, ...rest) {
      if (f === file) {
        reads++;
      }
      return readFile.call(this, f, ...rest);
    };
    try {
      const asked = [1, 2, 3, 4, 5].map(() => factory.reloadColdCacheIfChanged());
      expect(asked).toEqual([true, false, false, false, false]);
      for (let i = 0; i < 100 && factory.loadedConceptCount !== 5; i++) {
        await new Promise(r => setTimeout(r, 10));
      }
      expect(factory.loadedConceptCount).toBe(5);
      expect(reads).toBe(1);
      // and nothing more to do once it has
      expect(factory.reloadColdCacheIfChanged()).toBe(false);
    } finally {
      fs.readFile = readFile;
    }
  });
});
