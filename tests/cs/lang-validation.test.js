/**
 * IETF BCP 47 validation for urn:ietf:bcp:47 — base language, script, region, and the
 * combinations lang.dat says are and are not allowed.
 *
 * The registry (tx/data/lang.dat) is the only authority here: a subtag is valid if it
 * appears there, and a combination is valid if the registry does not say otherwise. Two
 * things it says about combinations, both previously ignored:
 *
 *  - Prefix, on an extlang or variant, names the language(s) that subtag may follow.
 *    `cmn` has `Prefix: zh`, so `en-cmn` is not a tag anyone may write.
 *  - a variant has to be registered at all — `en-abcdef` used to parse happily.
 *
 * Two loader gaps are covered too. The registry writes private-use allocations as
 * ranges (`QM..QZ`, `Qaaa..Qabx`), which were stored as literal keys nobody could look
 * up, so every code in them read as unregistered while singly-allocated `AA` worked.
 * And the 26 grandfathered tags were skipped on load, so `i-klingon` — a registered tag —
 * was rejected.
 *
 * Case matters in the other direction: BCP 47 §2.1.1 says tags are case-insensitive and
 * the familiar casing (lowercase language, Titlecase script, UPPERCASE region) is a
 * recommendation, so `en-us` is a valid way of writing `en-US`. That folding is applied
 * HERE, in the code system, and deliberately not to Accept-Language parsing.
 */

const { OperationContext } = require('../../tx/operation-context');
const { IETFLanguageCodeProvider } = require('../../tx/cs/cs-lang');
const { TestUtilities } = require('../test-utilities');

describe('IETF language code validation', () => {
  let provider;

  beforeAll(async () => {
    const languageDefinitions = await TestUtilities.loadLanguageDefinitions();
    const opContext = new OperationContext('en', await TestUtilities.loadTranslations(languageDefinitions));
    provider = new IETFLanguageCodeProvider(opContext, []);
  }, 60000);

  async function valid(code) {
    const r = await provider.locate(code);
    return r.context !== null && r.context !== undefined;
  }
  async function reason(code) {
    const r = await provider.locate(code);
    return r.message || '';
  }

  describe('base language', () => {
    test.each([['en'], ['fr'], ['de'], ['zh'], ['sr']])('%s is valid', async (code) => {
      expect(await valid(code)).toBe(true);
    });

    test.each([
      ['zz', 'two letters, not allocated'],
      ['xyz', 'three letters, not allocated'],
      ['e', 'too short to be a language subtag']
    ])('%s is not (%s)', async (code) => {
      expect(await valid(code)).toBe(false);
      expect(await reason(code)).toMatch(/language .* is not valid/);
    });
  });

  describe('region', () => {
    test.each([
      ['en-US', 'ISO 3166 alpha-2'],
      ['en-GB', 'ISO 3166 alpha-2'],
      ['en-001', 'UN M.49 numeric, World'],
      ['en-419', 'UN M.49 numeric, Latin America'],
      ['en-AA', 'private use, allocated singly in the registry'],
      ['en-QM', 'private use, inside the QM..QZ range'],
      ['en-XA', 'private use, inside the XA..XZ range'],
      ['en-XX', 'also inside XA..XZ - not a typo case, a real private-use code'],
      ['en-ZZ', 'private use']
    ])('%s is valid (%s)', async (code) => {
      expect(await valid(code)).toBe(true);
    });

    test.each([
      ['en-AB', 'two letters, not allocated and not in a private-use range'],
      ['en-999', 'three digits, not an M.49 code']
    ])('%s is not (%s)', async (code) => {
      expect(await valid(code)).toBe(false);
      expect(await reason(code)).toMatch(/region .* is not valid/);
    });
  });

  describe('script', () => {
    test.each([
      ['zh-Hans', 'Simplified Han'],
      ['zh-Hant', 'Traditional Han'],
      ['sr-Cyrl', 'Cyrillic'],
      ['en-Zzzz', 'uncoded script'],
      ['en-Qaaa', 'private use, inside the Qaaa..Qabx range'],
      ['en-Cyrl', 'no rule forbids English written in Cyrillic']
    ])('%s is valid (%s)', async (code) => {
      expect(await valid(code)).toBe(true);
    });

    test('en-Abcd is not, being four letters nobody registered', async () => {
      expect(await valid('en-Abcd')).toBe(false);
      expect(await reason('en-Abcd')).toMatch(/script .* is not valid/);
    });
  });

  describe('language + script + region together', () => {
    test.each([
      ['zh-Hans-CN'], ['sr-Latn-RS'], ['en-Latn-US'], ['zh-Hans-ZZ'], ['zh-Zzzz-CN']
    ])('%s is valid: the registry constrains the subtags, not this combination', async (code) => {
      expect(await valid(code)).toBe(true);
    });

    test('a bad subtag anywhere in the combination fails', async () => {
      expect(await valid('zh-Hans-AB')).toBe(false);
      expect(await valid('zh-Abcd-CN')).toBe(false);
      expect(await valid('zz-Hans-CN')).toBe(false);
    });
  });

  describe('combinations the registry does constrain', () => {
    test('an extlang may only follow the language its Prefix names', async () => {
      expect(await valid('zh-cmn')).toBe(true);      // cmn has Prefix: zh
      expect(await valid('ar-aao')).toBe(true);      // aao has Prefix: ar
      expect(await valid('en-cmn')).toBe(false);
      expect(await reason('en-cmn')).toMatch(/may only be used with 'zh'/);
    });

    test('a variant may only follow the language its Prefix names', async () => {
      expect(await valid('de-1901')).toBe(true);     // 1901 has Prefix: de
      expect(await valid('de-DE-1901')).toBe(true);  // a region in between is fine
      expect(await valid('en-1901')).toBe(false);
      expect(await reason('en-1901')).toMatch(/may only be used with 'de'/);
    });

    test('a variant has to be registered at all', async () => {
      expect(await valid('en-abcdef')).toBe(false);
      expect(await valid('en-zzzzzzz')).toBe(false);
      expect(await reason('en-abcdef')).toMatch(/variant .* is not valid/);
    });
  });

  describe('grandfathered tags', () => {
    test.each([['i-klingon'], ['en-GB-oed'], ['art-lojban'], ['zh-min-nan']])(
      '%s is valid: registered whole, and it does not decompose', async (code) => {
        expect(await valid(code)).toBe(true);
      });

    test('something merely shaped like one is not', async () => {
      expect(await valid('i-nothere')).toBe(false);
    });
  });

  describe('redundant entries still decompose', () => {
    // zh-Hans is in the registry as `redundant` - it is redundant precisely BECAUSE it
    // can be built from subtags, so it must not be matched as an opaque whole tag or the
    // caller loses the script.
    test.each([['zh-Hans', 'zh', 'Hans'], ['az-Arab', 'az', 'Arab']])(
      '%s parses as %s + %s', async (code, language, script) => {
        const r = await provider.locate(code);
        expect(r.context.language).toBe(language);
        expect(r.context.script).toBe(script);
      });
  });

  describe('case insensitivity', () => {
    test.each([['EN'], ['en-us'], ['ZH-hans-CN'], ['EN-GB'], ['zh-HANS']])(
      '%s is valid: BCP 47 tags are case-insensitive', async (code) => {
        expect(await valid(code)).toBe(true);
      });

    test('the parts are still reported in canonical case', async () => {
      const r = await provider.locate('ZH-hans-cn');
      expect(r.context.language).toBe('zh');
      expect(r.context.script).toBe('Hans');
      expect(r.context.region).toBe('CN');
    });

    // code() reporting the canonical form is what lets the validator hand back a
    // normalized-code and a CODE_CASE_DIFFERENCE note, exactly as it does for any other
    // case-insensitive code system. The recommended casing is lower case language,
    // Titlecase script, UPPER CASE region.
    test.each([
      ['EN', 'en'],
      ['en-us', 'en-US'],
      ['ZH-hans-cn', 'zh-Hans-CN'],
      ['EN-GB', 'en-GB'],
      ['zh-HANS', 'zh-Hans']
    ])('%s normalises to %s', async (code, canonical) => {
      expect(await provider.code(code)).toBe(canonical);
    });

    test.each([['en'], ['en-US'], ['zh-Hans'], ['zh-Hans-CN'], ['de-1901']])(
      '%s is already canonical, so nothing to normalise', async (code) => {
        expect(await provider.code(code)).toBe(code);
      });

    test('a grandfathered tag normalises to the registry spelling', async () => {
      expect(await provider.code('EN-GB-OED')).toBe('en-GB-oed');
      expect(await provider.code('I-Klingon')).toBe('i-klingon');
    });
  });

  describe('subsumption', () => {
    // A tag is a set of named components, not an ordered path: one tag subsumes another
    // when it states a subset of what the other states, and the language must match.
    const outcome = (a, b) => provider.subsumesTest(a, b);

    test.each([
      ['en', 'en-US', 'a region added'],
      ['en', 'en-Latn-US', 'script and region added'],
      ['zh', 'zh-Hans', 'a script added'],
      ['zh', 'zh-Hans-CN', 'script and region added'],
      ['zh-Hans', 'zh-Hans-CN', 'a region added to a script'],
      ['de', 'de-1901', 'a variant added'],
      ['de-1901', 'de-DE-1901', 'a region added around a variant'],
      ['zh', 'zh-cmn', 'an extended language added'],
      ['en', 'en-Latn', 'a script the registry calls redundant is still narrower here - Suppress-Script is deliberately not consulted']
    ])('%s subsumes %s (%s)', async (a, b) => {
      expect(await outcome(a, b)).toBe('subsumes');
      expect(await outcome(b, a)).toBe('subsumed-by');
    });

    test('en-US subsumes en-Latn-US, though the added script sits between the two subtags', async () => {
      // RFC 4647 extended filtering rather than basic filtering. Basic filtering is
      // strictly positional and would answer not-subsumed here; extended filtering is
      // the reading that makes the relation transitive, since en subsumes en-US and en
      // subsumes en-Latn-US.
      expect(await outcome('en-US', 'en-Latn-US')).toBe('subsumes');
      expect(await outcome('en-Latn-US', 'en-US')).toBe('subsumed-by');
    });

    test.each([
      ['en', 'en'],
      ['en-US', 'en-US'],
      ['zh-Hans-CN', 'zh-Hans-CN']
    ])('%s is equivalent to itself', async (code) => {
      expect(await outcome(code, code)).toBe('equivalent');
    });

    test('a tag is equivalent to itself however it is cased', async () => {
      expect(await outcome('EN-US', 'en-us')).toBe('equivalent');
    });

    test('case does not stop subsumption either', async () => {
      expect(await outcome('EN', 'en-us')).toBe('subsumes');
      expect(await outcome('en', 'EN-US')).toBe('subsumes');
    });

    test.each([
      ['en-US', 'en-GB', 'two regions of one language'],
      ['zh-Hant', 'zh-Hans-CN', 'different scripts'],
      ['en-Latn', 'en-US', 'each states something the other does not'],
      ['en', 'fr', 'different languages'],
      ['de-1901', 'de-1996', 'different variants']
    ])('%s and %s are unrelated (%s)', async (a, b) => {
      expect(await outcome(a, b)).toBe('not-subsumed');
      expect(await outcome(b, a)).toBe('not-subsumed');
    });

    test('a grandfathered tag relates only to itself, having no components to compare', async () => {
      expect(await outcome('i-klingon', 'i-klingon')).toBe('equivalent');
      expect(await outcome('i-klingon', 'en')).toBe('not-subsumed');
      expect(await outcome('en', 'i-klingon')).toBe('not-subsumed');
      // even though it starts with a real language subtag
      expect(await outcome('zh', 'zh-min-nan')).toBe('not-subsumed');
    });
  });

  describe('filters', () => {
    const { FilterExecutionContext } = require('../../tx/cs/cs-api');

    async function build(filters) {
      const ctx = new FilterExecutionContext();
      for (let i = 0; i < filters.length; i++) {
        const [prop, op, value] = filters[i];
        await provider.filter(ctx, i === 0, prop, op, value);
      }
      return { ctx, sets: await provider.executeFilters(ctx) };
    }
    async function expand(filters) {
      const { ctx, sets } = await build(filters);
      const codes = [];
      while (await provider.filterMore(ctx, sets[0])) {
        codes.push((await provider.filterConcept(ctx, sets[0])).toString());
      }
      return { size: await (async () => { const s2 = await build(filters); return provider.filterSize(s2.ctx, s2.sets[0]); })(), codes };
    }
    async function inFilter(filters, code) {
      const { ctx, sets } = await build(filters);
      return typeof (await provider.filterLocate(ctx, sets[0], code)) !== 'string';
    }

    describe('what the server will offer', () => {
      test.each([['language'], ['script'], ['region']])('= is supported on %s', async (prop) => {
        expect(await provider.doesFilter(prop, '=', 'en')).toBe(true);
      });

      test('= is not offered on the components with no bounded list behind them', async () => {
        expect(await provider.doesFilter('variant', '=', '1901')).toBe(false);
        expect(await provider.doesFilter('private-use', '=', 'x')).toBe(false);
      });

      test('a filter value has to be a registered subtag of the right kind', async () => {
        await expect(build([['language', '=', 'zz']])).rejects.toThrow(/not a valid language subtag/);
        await expect(build([['region', '=', 'AB']])).rejects.toThrow(/not a valid region subtag/);
        await expect(build([['script', '=', 'Abcd']])).rejects.toThrow(/not a valid script subtag/);
      });
    });

    describe('expansion', () => {
      // The grammar is unbounded, so only these three combinations leave a finite list.
      test('a fixed language gives every region, and the bare language too', async () => {
        const { size, codes } = await expand([['language', '=', 'en']]);
        expect(codes[0]).toBe('en');                       // a tag need state no region
        expect(codes).toContain('en-US');
        expect(codes).toContain('en-GB');
        expect(codes).toContain('en-QM');                  // private-use regions included
        expect(size).toBe(codes.length);
        expect(codes.every(c => c === 'en' || c.startsWith('en-'))).toBe(true);
      });

      test('a fixed region gives every language', async () => {
        const { size, codes } = await expand([['region', '=', 'US']]);
        expect(codes).toContain('en-US');
        expect(codes).toContain('fr-US');
        expect(codes.every(c => c.endsWith('-US'))).toBe(true);
        // no bare region: a region on its own is not a language tag
        expect(codes).not.toContain('US');
        expect(size).toBe(codes.length);
      });

      test('language AND region together give every script', async () => {
        const { size, codes } = await expand([['language', '=', 'en'], ['region', '=', 'US']]);
        expect(codes[0]).toBe('en-US');                    // the tag with no script
        expect(codes).toContain('en-Latn-US');
        expect(codes).toContain('en-Cyrl-US');
        expect(codes.every(c => c === 'en-US' || (c.startsWith('en-') && c.endsWith('-US')))).toBe(true);
        expect(size).toBe(codes.length);
      });

      test.each([
        [[['script', '=', 'Latn']], 'a script alone leaves the language open'],
        [[['language', '=', 'en'], ['script', '=', 'Latn']], 'language and script leave the region open'],
        [[['region', 'exists', 'true']], 'an exists filter fixes nothing']
      ])('%#: not enumerable - %s', async (filters) => {
        const { ctx, sets } = await build(filters);
        await expect(provider.filterSize(ctx, sets[0])).rejects.toThrow(/cannot be expanded/);
        // and filterMore throws rather than answering false, so a mistake cannot look
        // like an empty result
        await expect(provider.filterMore(ctx, sets[0])).rejects.toThrow(/cannot be expanded/);
      });

      test('every expansion is unclosed: variants and extensions can always be added', async () => {
        const { ctx } = await build([['language', '=', 'en']]);
        expect(await provider.filtersNotClosed(ctx)).toBe(true);
      });
    });

    describe('validation against a filter', () => {
      test('a fixed language accepts the language and anything built on it', async () => {
        for (const code of ['en', 'en-US', 'en-Latn-US', 'en-GB', 'EN-us']) {
          expect(await inFilter([['language', '=', 'en']], code)).toBe(true);
        }
        for (const code of ['fr', 'fr-US', 'de-1901']) {
          expect(await inFilter([['language', '=', 'en']], code)).toBe(false);
        }
      });

      test('a fixed region accepts any language with it', async () => {
        expect(await inFilter([['region', '=', 'US']], 'fr-US')).toBe(true);
        expect(await inFilter([['region', '=', 'US']], 'en-Latn-US')).toBe(true);
        expect(await inFilter([['region', '=', 'US']], 'en')).toBe(false);
        expect(await inFilter([['region', '=', 'US']], 'en-GB')).toBe(false);
      });

      test('both together accept only tags with both', async () => {
        const f = [['language', '=', 'en'], ['region', '=', 'US']];
        expect(await inFilter(f, 'en-US')).toBe(true);
        expect(await inFilter(f, 'en-Latn-US')).toBe(true);
        expect(await inFilter(f, 'en-GB')).toBe(false);
        expect(await inFilter(f, 'fr-US')).toBe(false);
      });

      test('an absent component does not match a fixed one', async () => {
        // A tag that simply does not say what its region is is not thereby a tag whose
        // region is US: RFC 4647 basic filtering matches a prefix of the tag, and 'en'
        // has no region subtag to compare. This is the distinction the 'out' cases below
        // do not test, because they all supply a different value rather than none.
        expect(await inFilter([['region', '=', 'US']], 'en')).toBe(false);
        expect(await inFilter([['script', '=', 'Latn']], 'en-US')).toBe(false);
        expect(await inFilter([['language', '=', 'en'], ['region', '=', 'US']], 'en')).toBe(false);
        // the mirror case: a language filter is satisfied by the bare language, because
        // there the component is present and equal
        expect(await inFilter([['language', '=', 'en']], 'en')).toBe(true);
      });

      test('the message names the rule that actually failed', async () => {
        const { ctx, sets } = await build([['language', '=', 'en'], ['region', '=', 'US']]);
        // en-GB has the right language, so complaining about the language would send the
        // reader looking in the wrong place
        const msg = await provider.filterLocate(ctx, sets[0], 'en-GB');
        expect(msg).toMatch(/does not have a region of 'US'/);
        expect(msg).not.toMatch(/language of 'en'/);
      });

      test('an invalid code is rejected by the filter path as it is by locate', async () => {
        expect(await inFilter([['language', '=', 'en']], 'en-cmn')).toBe(false);
        expect(await inFilter([['language', '=', 'en']], 'en-AB')).toBe(false);
      });
    });
  });

  describe('malformed tags', () => {
    test.each([['en-'], ['-US'], ['en--US'], ['toolongsubtagvalue']])(
      '%s is not valid', async (code) => {
        expect(await valid(code)).toBe(false);
      });

    test('an empty code says so specifically', async () => {
      expect(await reason('')).toBe('Empty code');
    });
  });
});
