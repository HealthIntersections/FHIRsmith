const path = require('path');
const fs = require('fs');

const { SnomedServicesFactory } = require('../../tx/cs/cs-snomed');
const { SnomedTextIndex, filterTokens, tokenize } = require('../../tx/sct/text-index');
const { OperationContext } = require('../../tx/operation-context');
const { LanguageDefinitions } = require('../../library/languages');
const { I18nSupport } = require('../../library/i18nsupport');
const { SearchFilterText } = require('../../tx/library/designations');
const folders = require('../../library/folder-setup');

// Same cache resolution as cs-snomed.test.js: the scratch copy if a run has
// produced one, else the copy committed under tx/data.
const testCachePath = folders.ensureFilePath('snomed-testing.cache');
const committedCachePath = path.resolve(__dirname, '../../tx/data/snomed-testing.cache');
const cacheFile = fs.existsSync(testCachePath) ? testCachePath
    : (fs.existsSync(committedCachePath) ? committedCachePath : null);

describe('SNOMED text search', () => {

  describe('filter tokenising', () => {
    test('splits on non-alphanumerics and lower-cases', () => {
      expect(tokenize('Fracture of shaft-of tibia (disorder)')).toEqual(
          ['fracture', 'of', 'shaft', 'of', 'tibia', 'disorder']);
    });

    test('drops stop words and single characters', () => {
      expect(filterTokens('fracture of the T6 a')).toEqual(['fracture', 't6']);
    });

    test('keeps stop words when the filter is nothing else', () => {
      expect(filterTokens('of the')).toEqual(['of', 'the']);
    });

    test('drops duplicate tokens', () => {
      expect(filterTokens('right right lymph node')).toEqual(['right', 'lymph', 'node']);
    });

    test('yields nothing indexable for a single character', () => {
      expect(filterTokens('a')).toEqual([]);
    });
  });

  (cacheFile ? describe : describe.skip)('against the test edition', () => {
    let factory;
    let sct;
    let i18n;

    beforeAll(async () => {
      const langDefs = await LanguageDefinitions.fromFiles(path.resolve(__dirname, '../../tx/data'));
      i18n = new I18nSupport(path.resolve(__dirname, '../../translations'), langDefs);
      await i18n.load();
      factory = new SnomedServicesFactory(i18n, cacheFile);
      await factory.load();
      sct = factory.snomedServices;
    }, 60000);

    async function search(text, includeInactive = false) {
      const result = await sct.searchFilter(new SearchFilterText(text), includeInactive, null);
      return result.matches.map(m => m.term.toString());
    }

    test('builds an index on first search and reuses it', async () => {
      expect(sct._textIndex).toBeNull();
      await search('appendicitis');
      expect(sct._textIndex).toBeInstanceOf(SnomedTextIndex);
      const first = sct._textIndex;
      await search('appendicitis');
      expect(sct._textIndex).toBe(first);
    });

    test('concurrent first searches share one build', async () => {
      const fresh = new SnomedServicesFactory(i18n, cacheFile);
      await fresh.load();
      const services = fresh.snomedServices;
      const [a, b] = await Promise.all([services.getTextIndex(null), services.getTextIndex(null)]);
      expect(a).toBe(b);
    }, 60000);

    test('finds the concept named by the filter', async () => {
      expect(await search('appendicitis')).toContain('74400008');
    });

    test('matches other inflections of the same stem', async () => {
      // "fractures" must find concepts whose terms say "fracture"
      expect(await search('fractures')).toContain('72704001');
    });

    test('requires every filter word', async () => {
      expect(await search('appendicitis fever')).toEqual([]);
    });

    test('prefix-matches the last word only', async () => {
      // "append" is still being typed, so it reaches Appendicitis
      expect(await search('append')).toContain('74400008');
      // but a completed word is not a prefix: "liver pain" must not be
      // reachable as "live pain"
      expect(await search('live pain')).toEqual([]);
    });

    test('ranks an exact term first', async () => {
      const matches = await search('fracture');
      expect(matches[0]).toBe('72704001'); // Fracture
    });

    test('ignores inactive concepts unless asked', async () => {
      const active = await search('appendicitis');
      const all = await search('appendicitis', true);
      expect(all.length).toBeGreaterThanOrEqual(active.length);
    });

    test('an unindexable filter still searches, by scan', async () => {
      const scanned = await sct.searchFilter(new SearchFilterText('a'), false, null);
      // every term containing "a" - the point is that it does not throw or
      // silently return nothing
      expect(scanned.matches.length).toBeGreaterThan(0);
    });

    test('scanSearch requires all the filter words', async () => {
      const both = await sct.scanSearch('fracture tibia', false, null);
      const codes = both.matches.map(m => m.term.toString());
      expect(codes).toContain('6990005'); // Fracture of shaft of tibia
      const neither = await sct.scanSearch('fracture zzzz', false, null);
      expect(neither.matches).toEqual([]);
    });

    test('the scan yields through the operation context', async () => {
      // The scan is the expensive path (a full pass over the edition), so it
      // must hand the event loop back as it goes - see checkAndYield.
      const opContext = new OperationContext('en', i18n, 'test-scan', 20);
      const calls = [];
      const realCheckAndYield = opContext.checkAndYield.bind(opContext);
      opContext.checkAndYield = async (place) => {
        calls.push(place);
        return realCheckAndYield(place);
      };
      await sct.scanSearch('fracture', false, opContext);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]).toBe('sct:searchFilter');
    });

  });
});
