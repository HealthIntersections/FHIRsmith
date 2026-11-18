const path = require('path');
const fs = require('fs');

const { SnomedServicesFactory, SnomedServices, SnomedProvider } = require('../../tx/cs/cs-snomed');
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
// (the scratch copy only if it's in the current cache format: one from an older version's run isn't)
const { SnomedFileReader } = require('../../tx/sct/structures');
const cacheFile = fs.existsSync(testCachePath) && SnomedFileReader.isCurrent(testCachePath) ? testCachePath
    : (fs.existsSync(committedCachePath) ? committedCachePath : null);

describe('SNOMED text search', () => {

  describe('filter tokenising', () => {
    test('splits on non-alphanumerics and lower-cases', () => {
      expect(tokenize('Fracture of shaft-of tibia (disorder)')).toEqual(
          ['fracture', 'of', 'shaft', 'of', 'tibia', 'disorder']);
    });

    test('drops stop words', () => {
      expect(filterTokens('fracture of the T6 a')).toEqual(['fracture', 't6']);
    });

    test('keeps single letters and digits (they match whole words)', () => {
      expect(filterTokens('hepatitis b')).toEqual(['hepatitis', 'b']);
    });

    test('keeps stop words when the filter is nothing else', () => {
      expect(filterTokens('of the')).toEqual(['of', 'the']);
    });

    test('drops duplicate tokens', () => {
      expect(filterTokens('right right lymph node')).toEqual(['right', 'lymph', 'node']);
    });

    test('a stop word alone is kept', () => {
      expect(filterTokens('a')).toEqual(['a']);
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

    test('the index comes with the cache', () => {
      expect(sct._textIndex).toBeInstanceOf(SnomedTextIndex);
      expect(sct.getTextIndex(null)).toBe(sct._textIndex);
    });

    test('an index read from the cache is the one the importer built', async () => {
      const { SnomedTextIndex: Index } = require('../../tx/sct/text-index');
      const built = await Index.build(sct, null);
      const read = sct._textIndex;
      expect(read.words.length).toBe(built.words.length);
      for (const id of [0, Math.floor(built.words.length / 2), built.words.length - 1]) {
        expect(read.words.get(id)).toBe(built.words.get(id));
        expect(Array.from(read.postings(id))).toEqual(Array.from(built.postings(id)));
      }
      expect(Array.from(read.wordCounts)).toEqual(Array.from(built.wordCounts));
      expect(Index.deserialize(built.serialize()).words.length).toBe(built.words.length);
    });

    test('a language the edition has no descriptions in has an empty index', () => {
      expect(sct.getTextIndex(200).search([{ word: 'liver', stem: 'liver', whole: false }])).toEqual([]);
    });

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

    test('every word can be the start of a word', async () => {
      // "append" is still being typed, so it reaches Appendicitis
      expect(await search('append')).toContain('74400008');
      expect(await search('fract tib')).toContain('6990005'); // Fracture of shaft of tibia
    });

    test('every word has to be in one description', async () => {
      // 1059007 is "Opisthorchiasis" and "Cat liver fluke infection": both words are the
      // concept's, but no one description has them both
      const index = sct.getTextIndex(null);
      const query = new SearchFilterText('opisthorchiasis liver').query;
      expect(index.search(query.tokens('en')).length).toBeGreaterThan(0);
      expect(await search('opisthorchiasis liver')).not.toContain('1059007');
      expect(await search('liver fluke')).toContain('1059007');
    });

    test('finds a concept by its identifier', async () => {
      expect((await search('74400008'))[0]).toBe('74400008');
      expect(await search('7440000')).toContain('74400008');
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

    test('a one-letter filter searches that word', async () => {
      const found = await sct.searchFilter(new SearchFilterText('a'), false, null);
      expect(found.matches.length).toBeGreaterThan(0);
    });

    describe('the edition default language', () => {
      // The language a text filter searches when the request names none comes from the
      // cache's default-language slot. The test edition is English, plus Dutch descriptions
      // of a few hematoma concepts and a Dutch language reference set (1000601000003105) in
      // its TEST1000003 extension.
      // the concepts with a Dutch description with the word "hematoom" ("hematoom",
      // "intrahepatisch hematoom"; "leverhematoom" is one word)
      const DUTCH = ['262798009', '35566002'];
      const servicesWith = (slot) => new SnomedServices({ ...factory._sharedData, defaultLanguage: slot });
      const codes = async (services, text, languages = null) => {
        const provider = new SnomedProvider(new OperationContext('en', i18n), [], services);
        const fc = await provider.getPrepContext(true, languages);
        const f = await provider.searchFilter(fc, new SearchFilterText(text), null);
        return f.matches.map(m => m.term.toString()).sort();
      };

      test('importer cache: the slot holds the language', async () => {
        const dutch = servicesWith(3);
        expect(dutch.defaultLanguage).toBe(3);
        expect(await codes(dutch, 'hematoom')).toEqual(DUTCH);
        const english = servicesWith(1);
        expect(english.defaultLanguage).toBe(1);
        expect(await codes(english, 'hematoom')).toEqual([]);
        expect(await codes(english, 'appendicitis')).toContain('74400008');
      }, 60000);

      test('descriptionLanguages counts what getMembers reads, with and without member ids', () => {
        let withIds = 0;
        for (let i = 0; i < sct.refSetIndex.count(); i++) {
          const { membersByRef } = sct.refSetIndex.getReferenceSet(i);
          const expected = new Map();
          for (const m of sct.refSetMembers.getMembers(membersByRef) || []) {
            if (m.kind !== 1) continue;
            const lang = sct.descriptions.getDescription(m.ref).lang;
            expected.set(lang, (expected.get(lang) || 0) + 1);
          }
          if (sct.refSetMembers.master.readUInt8(membersByRef + 4) !== 0) withIds++;
          expect(sct.refSetMembers.descriptionLanguages(membersByRef, sct.descriptions)).toEqual(expected);
        }
        expect(withIds).toBeGreaterThan(0);
      });

      test('a slot that is neither is read as English', async () => {
        const services = servicesWith(51756144); // no reference set's members start there
        expect(services.defaultLanguage).toBe(1);
        expect(await codes(services, 'appendicitis')).toContain('74400008');
      }, 60000);
    });

  });
});
