/**
 * The memory limits (cacheMaxConcepts, cacheMaxTotalConcepts, usageTrackerMaxCodes,
 * usageTrackerMaxCodeLength, languageTagCacheSize) are read from the tx config: left out
 * or null = the default, 0 = no limit. See tx/README.md, "Configuration Options".
 */
const path = require('path');
const express = require('express');
const TXModule = require('../../tx/tx');
const Logger = require('../../library/logger');
const { ResourceCache } = require('../../tx/operation-context');
const ConceptUsageTracker = require('../../tx/usage-tracker');
const { LanguageDefinitions } = require('../../library/languages');

const DEFAULTS = {
  cacheMaxConcepts: ResourceCache.MAX_CONCEPTS_PER_CACHE,
  cacheMaxTotalConcepts: ResourceCache.MAX_TOTAL_CONCEPTS,
  usageTrackerMaxCodes: ConceptUsageTracker.MAX_CODES,
  usageTrackerMaxCodeLength: ConceptUsageTracker.MAX_CODE_LENGTH,
  languageTagCacheSize: LanguageDefinitions.MAX_PARSED
};

describe('TXModule.resourceLimits', () => {
  test('left out or null = the default', () => {
    expect(TXModule.resourceLimits({})).toEqual(DEFAULTS);
    expect(TXModule.resourceLimits({ cacheMaxConcepts: null, languageTagCacheSize: undefined })).toEqual(DEFAULTS);
    expect(DEFAULTS).toEqual({ cacheMaxConcepts: 250000, cacheMaxTotalConcepts: 1000000,
      usageTrackerMaxCodes: 1000000, usageTrackerMaxCodeLength: 100, languageTagCacheSize: 1000 });
  });

  test('set values are used; 0 = no limit; anything not a number = the default', () => {
    expect(TXModule.resourceLimits({ cacheMaxConcepts: 7, cacheMaxTotalConcepts: 0, usageTrackerMaxCodes: '3',
      usageTrackerMaxCodeLength: 'lots', languageTagCacheSize: -1 })).toEqual({ cacheMaxConcepts: 7,
      cacheMaxTotalConcepts: Infinity, usageTrackerMaxCodes: 3, usageTrackerMaxCodeLength: 100, languageTagCacheSize: 1000 });
  });

  test('no limit really is none', () => {
    const tracker = new ConceptUsageTracker(Infinity, Infinity);
    tracker.codes = ConceptUsageTracker.MAX_CODES;
    tracker.seeConcept('http://a', 'x'.repeat(ConceptUsageTracker.MAX_CODE_LENGTH + 1));
    expect(tracker.usages('http://a').size).toBe(1);
  });
});

describe('the tx module applies the configured limits, and logs them', () => {
  let tx;
  let logged;

  beforeAll(async () => {
    const logger = Logger.getInstance();
    const spy = jest.spyOn(logger, '_log');
    tx = new TXModule();
    await tx.initialize({
      librarySource: path.join(__dirname, 'fixtures', 'test-library.yaml'),
      endpoints: [{ path: '/tx/r5', fhirVersion: '5.0', context: null }],
      cacheMaxConcepts: 7, cacheMaxTotalConcepts: 0,
      usageTrackerMaxCodes: 3, usageTrackerMaxCodeLength: 0, languageTagCacheSize: 5
    }, express());
    logged = spy.mock.calls.map(c => String(c[1]));
    spy.mockRestore();
  }, 60000);
  afterAll(async () => { await tx.shutdown(); });

  test('every limit reaches what it bounds', () => {
    const cache = tx.endpoints[0].resourceCache;
    expect(cache.maxConceptsPerCache).toBe(7);
    expect(cache.maxTotalConcepts).toBe(Infinity);
    expect(tx.usageTracker.maxCodes).toBe(3);
    expect(tx.usageTracker.maxCodeLength).toBe(Infinity);
    expect(tx.languages.maxParsed).toBe(5);
  });

  test('one startup line gives them all', () => {
    expect(logged.filter(m => m.includes('Limits: '))).toEqual([expect.stringContaining(
      'Limits: operationTimeLimit=20s, cacheTimeout=30min, cacheMaxConcepts=7, cacheMaxTotalConcepts=unlimited, ' +
      'usageTrackerMaxCodes=3, usageTrackerMaxCodeLength=unlimited, languageTagCacheSize=5')]);
  });
});
