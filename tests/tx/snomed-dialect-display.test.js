/**
 * SNOMED CT display by English dialect
 *
 * The International edition (and the test edition, which is derived from it) has two
 * English language reference sets, US (900000000000509007) and GB (900000000000508004),
 * and where the spelling differs a concept has a preferred synonym in each, both stored
 * with the language 'en'. These tests pin which one a request gets:
 *  - no language, en and en-US: the edition's display (the US preferred term), for every
 *    concept - en used to give the GB term for the concepts whose GB synonym happens to
 *    be stored first, so one expansion mixed the two dialects
 *  - en-GB: the GB preferred term - it used to give the US one
 *  - $lookup and $validate-code answer as $expand does
 *
 * Concepts used (test edition, tx/data/snomed):
 *  - 262797004: GB synonym stored first (390820015 "Subcapsular liver haematoma", then
 *    390821016 "Subcapsular liver hematoma"); also has a Dutch preferred term
 *  - 35566002:  US synonym stored first (59338013 "Hematoma", 486214017 "Haematoma")
 *  - 64572001:  one preferred term for both dialects ("Disease")
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const request = require('supertest');
const TXModule = require('../../tx/tx');
const folders = require('../../library/folder-setup');
const { SnomedFileReader } = require('../../tx/sct/structures');

const SNOMED_URI = 'http://snomed.info/sct';
const GB_FIRST = '262797004';
const US_FIRST = '35566002';
const SAME = '64572001';

jest.setTimeout(60000);

describe('SNOMED CT display by English dialect', () => {
  let app;
  let txModule;

  beforeAll(async () => {
    const committed = path.resolve(__dirname, '../../tx/data/snomed-testing.cache');
    const cacheFolder = folders.subDir('terminology-cache');
    const target = path.join(cacheFolder, 'sct_test_20250909-21.cache');
    if (!fs.existsSync(target) || !SnomedFileReader.isCurrent(target)) {
      fs.copyFileSync(committed, target);
    }

    app = express();
    app.use(cors());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    txModule = new TXModule();
    await txModule.initialize({
      librarySource: path.join(__dirname, 'fixtures', 'test-library-snomed.yaml'),
      endpoints: [
        { path: '/tx/r5', fhirVersion: '5.0', context: null }
      ]
    }, app);
  }, 60000);

  afterAll(async () => {
    if (txModule) {
      await txModule.shutdown();
    }
  });

  function post(op, parameter, headers = {}) {
    let req = request(app)
      .post('/tx/r5/' + op)
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json');
    for (const [k, v] of Object.entries(headers)) {
      req = req.set(k, v);
    }
    return req.send({ resourceType: 'Parameters', parameter });
  }

  const language = (lang) => lang ? [{ name: 'displayLanguage', valueCode: lang }] : [];

  async function expand(lang, extra = [], headers = {}) {
    const response = await post('ValueSet/$expand', [
      {
        name: 'valueSet',
        resource: {
          resourceType: 'ValueSet',
          status: 'active',
          compose: { include: [{ system: SNOMED_URI, concept: [{ code: GB_FIRST }, { code: US_FIRST }, { code: SAME }] }] }
        }
      },
      ...language(lang),
      ...extra
    ], headers);
    expect(response.status).toBe(200);
    return response.body.expansion.contains;
  }

  const displays = (contains) => Object.fromEntries(contains.map(c => [c.code, c.display]));

  const US = { [GB_FIRST]: 'Subcapsular liver hematoma', [US_FIRST]: 'Hematoma', [SAME]: 'Disease' };
  const GB = { [GB_FIRST]: 'Subcapsular liver haematoma', [US_FIRST]: 'Haematoma', [SAME]: 'Disease' };

  describe('$expand', () => {
    test('no language: the US preferred terms', async () => {
      expect(displays(await expand(null))).toEqual(US);
    });

    test('displayLanguage=en: the same displays as with no language, in one dialect', async () => {
      expect(displays(await expand('en'))).toEqual(US);
    });

    test('displayLanguage=en-US: the US preferred terms', async () => {
      expect(displays(await expand('en-US'))).toEqual(US);
    });

    test('displayLanguage=en-GB: the GB preferred terms', async () => {
      expect(displays(await expand('en-GB'))).toEqual(GB);
    });

    test('Accept-Language: en-GB gives the GB preferred terms', async () => {
      expect(displays(await expand(null, [], { 'Accept-Language': 'en-GB' }))).toEqual(GB);
    });

    test('Accept-Language: en gives the US preferred terms', async () => {
      expect(displays(await expand(null, [], { 'Accept-Language': 'en' }))).toEqual(US);
    });

    test('displayLanguage=nl still gives the Dutch preferred term', async () => {
      const d = displays(await expand('nl'));
      expect(d[GB_FIRST]).toBe('subcapsulair leverhematoom');
      expect(d[US_FIRST]).toBe('hematoom');
    });

    test('with designations: the GB term is tagged en-GB, only where it differs', async () => {
      const contains = await expand('en', [{ name: 'includeDesignations', valueBoolean: true }]);
      expect(displays(contains)).toEqual(US);
      const synonyms = (code) => contains.find(c => c.code === code).designation
        .filter(d => d.use && d.use.code === '900000000000013009')
        .map(d => d.language + ': ' + d.value);
      expect(synonyms(GB_FIRST)).toEqual(['nl: subcapsulair leverhematoom', 'en-GB: Subcapsular liver haematoma']);
      expect(synonyms(US_FIRST)).toEqual(['nl: hematoom', 'en-GB: Haematoma']);
      // no en-GB designation for a concept whose two dialects share the preferred term
      const all = contains.find(c => c.code === SAME).designation || [];
      expect(all.filter(d => d.language === 'en-GB')).toEqual([]);
      expect(all.filter(d => d.language === 'en-US').map(d => d.value)).toEqual(['Disease']);
    });
  });

  describe('$lookup', () => {
    async function lookup(code, lang) {
      const response = await post('CodeSystem/$lookup', [
        { name: 'system', valueUri: SNOMED_URI },
        { name: 'code', valueCode: code },
        ...language(lang)
      ]);
      expect(response.status).toBe(200);
      const parameter = response.body.parameter;
      const part = (p, name) => { const x = p.part.find(e => e.name === name); return x && (x.valueCode || x.valueString); };
      return {
        display: parameter.find(p => p.name === 'display').valueString,
        designations: parameter.filter(p => p.name === 'designation').map(p => part(p, 'language') + ': ' + part(p, 'value'))
      };
    }

    for (const code of [GB_FIRST, US_FIRST, SAME]) {
      test(code + ': US term for no language, en and en-US; GB term for en-GB', async () => {
        expect((await lookup(code, null)).display).toBe(US[code]);
        expect((await lookup(code, 'en')).display).toBe(US[code]);
        expect((await lookup(code, 'en-US')).display).toBe(US[code]);
        expect((await lookup(code, 'en-GB')).display).toBe(GB[code]);
      });
    }

    test('the GB preferred term is reported as en-GB, the other English descriptions as en', async () => {
      const { designations } = await lookup(GB_FIRST, null);
      expect(designations).toContain('en: Subcapsular liver hematoma');
      expect(designations).toContain('en-GB: Subcapsular liver haematoma');
      expect(designations).toContain('nl: subcapsulair leverhematoom');
      expect(designations.filter(d => d.startsWith('en-GB: '))).toHaveLength(1);
      expect(designations.filter(d => d.startsWith('en-US: '))).toHaveLength(0);

      const same = await lookup(SAME, null);
      expect(same.designations.filter(d => !d.startsWith('en: '))).toEqual([]);
    });
  });

  describe('$validate-code', () => {
    async function validate(code, lang, display) {
      const response = await post('CodeSystem/$validate-code', [
        { name: 'url', valueUri: SNOMED_URI },
        { name: 'code', valueCode: code },
        ...(display ? [{ name: 'display', valueString: display }] : []),
        ...language(lang)
      ]);
      expect(response.status).toBe(200);
      const value = (name) => { const p = response.body.parameter.find(e => e.name === name); return p && (p.valueString ?? p.valueBoolean); };
      return { result: value('result'), display: value('display'), message: value('message') };
    }

    test('display is the US term for en and en-US, the GB term for en-GB', async () => {
      expect((await validate(GB_FIRST, null)).display).toBe(US[GB_FIRST]);
      expect((await validate(GB_FIRST, 'en')).display).toBe(US[GB_FIRST]);
      expect((await validate(GB_FIRST, 'en-US')).display).toBe(US[GB_FIRST]);
      expect((await validate(GB_FIRST, 'en-GB')).display).toBe(GB[GB_FIRST]);
    });

    test('either dialect\'s term is still a valid display under either dialect', async () => {
      for (const lang of [null, 'en', 'en-US', 'en-GB']) {
        for (const display of [US[GB_FIRST], GB[GB_FIRST]]) {
          const r = await validate(GB_FIRST, lang, display);
          expect(r.result).toBe(true);
          expect(r.message).toBeUndefined();
        }
      }
    });
  });
});
