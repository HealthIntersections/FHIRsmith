/**
 * The text filter rules (tx/library/text-match.js) that every provider's search follows, and the
 * FTS5 form of them that the database providers use: the same names match either way
 */

const {
  TextQuery, NameIndex, fold, words, stem, stemmerFor, hasStemmer, languageOf,
  indexColumns, createTextIndexSql, isTextIndexSql
} = require('../../tx/library/text-match');

describe('words', () => {
  test('folded: lower case, accents dropped from Latin, Greek and Cyrillic letters', () => {
    expect(fold('Cólera ÄRZTLICHE Éé')).toBe('colera arztliche ee');
    expect(words('Glucose [Mass/volume] in Serum')).toEqual(['glucose', 'mass', 'volume', 'in', 'serum']);
    expect(words('İstanbul')).toEqual(['istanbul']);
  });

  test('marks in other scripts are part of the word', () => {
    expect(words('नमस्ते दुनिया')).toEqual(['नमस्ते', 'दुनिया']);
    expect(fold('がん')).not.toBe(fold('かん'));
  });

  test('digits are words', () => {
    expect(words('Calcium [Mass/time] in 24 hour Urine')).toContain('24');
  });
});

describe('stemmers', () => {
  test('the best stemmer for the language', () => {
    expect(stem('fractures', 'en')).toBe('fractur');
    expect(stem('untersuchungen', 'de-CH')).toBe('untersuch');
    expect(stem('urinaires', 'fr')).toBe('urinair');
    expect(stem('переломы', 'ru')).toBe('перелом');
    expect(hasStemmer('de')).toBe(true);
  });

  test('a language without one is not stemmed', () => {
    expect(hasStemmer('uz')).toBe(false);
    expect(stem('qondagi', 'uz')).toBe('qondagi');
    expect(stemmerFor('zh-Hans').stem('胃癌')).toBe('胃癌');
  });

  test('language subtags', () => {
    expect(languageOf('en-AU')).toBe('en');
    expect(languageOf(null, 'de')).toBe('de');
    expect(languageOf({ language: 'fr' })).toBe('fr');
  });
});

describe('TextQuery', () => {
  test('stop words are dropped, unless that leaves nothing', () => {
    expect(new TextQuery('potassium in urine').words).toEqual(['potassium', 'urine']);
    expect(new TextQuery('of the').words).toEqual(['of', 'the']);
  });

  test('at most 10 words, each once, from the first 100 characters', () => {
    expect(new TextQuery('one two one three').words).toEqual(['one', 'two', 'three']);
    expect(new TextQuery(Array.from({ length: 15 }, (_, i) => 'w' + i).join(' ')).words).toHaveLength(10);
    expect(new TextQuery('x'.repeat(150)).words[0]).toHaveLength(100);
  });

  test('empty is null; punctuation alone is not, but has no words', () => {
    expect(new TextQuery('').isNull).toBe(true);
    expect(new TextQuery('  ').isNull).toBe(true);
    const q = new TextQuery('-');
    expect(q.isNull).toBe(false);
    expect(q.nameMatches('-', 'en')).toBe(false);
  });

  test.each([
    ['glucose serum', 'Glucose [Mass/volume] in Serum or Plasma', true],
    ['serum glucoses', 'Glucose [Mass/volume] in Serum or Plasma', true], // any order, stemmed
    ['gluc ser', 'Glucose [Mass/volume] in Serum or Plasma', true], // the start of a word
    ['glucose urine', 'Glucose [Mass/volume] in Serum or Plasma', false], // every word
    ['infecti', 'Infection of the lung', true], // still being typed
    ['fractures', 'Fracture of femur', true], // the same stem
    ['therapies', 'Radiation therapy', true],
    ['cats', 'Catheter', false], // a word, not the start of the stem
    ['hepatitis b', 'Hepatitis B virus', true],
    ['hepatitis b', 'Hepatitis C', false], // a single letter is a whole word
    ['hepatitis b', 'Hepatitis, unspecified, bacterial', false],
    ['potassium in urine', 'Potassium [Moles/volume] in Urine', true],
    ['colera', 'Cólera', true], // accents
    ['CÓLERA', 'colera', true]
  ])('"%s" and "%s"', (filter, name, expected) => {
    expect(new TextQuery(filter).nameMatches(name, 'en')).toBe(expected);
  });

  test('stemmed in the language searched', () => {
    const q = new TextQuery('Untersuchungen');
    expect(q.nameMatches('Untersuchung des Blutes', 'de')).toBe(true);
    expect(q.tokens('de')[0].stem).toBe('untersuch');
    expect(q.tokens('en')[0].stem).not.toBe('untersuch');
  });

  test('codes: the code starts with the filter', () => {
    const q = new TextQuery('2345');
    expect(q.codeMatches('2345-7')).toBe(true);
    expect(q.codeMatches('12345-7')).toBe(false);
    expect(new TextQuery('lp1234').codeMatches('LP12345-6')).toBe(true);
    expect(q.codeRank('2345-7')).toBe(90);
    expect(new TextQuery('2345-7').codeRank('2345-7')).toBe(100);
  });

  test('codes: a straight left match, without regard to case - not words, stems or folding', () => {
    expect(new TextQuery('a01.1').codeMatches('A01.10')).toBe(true);
    expect(new TextQuery('  A01 ').codeMatches('a01.1')).toBe(true);
    expect(new TextQuery('a 01').codeMatches('A01')).toBe(false);
    expect(new TextQuery('a01 1').codeMatches('A01.1')).toBe(false);
    expect(new TextQuery('colera').codeMatches('cólera')).toBe(false);
    expect(new TextQuery('fractures').codeMatches('fracture')).toBe(false);
    expect(new TextQuery('lp12').codeRanges('lp12')).toEqual([['lp12', 'lp12\u{10FFFF}'], ['LP12', 'LP12\u{10FFFF}']]);
  });

  test('rank: the name itself, then a name that starts with it, then has it, then has its words; shorter names first', () => {
    const q = new TextQuery('diabetes mellitus');
    const exact = q.nameRank('Diabetes mellitus', 'en');
    const starts = q.nameRank('Diabetes mellitus type 2', 'en');
    const has = q.nameRank('Screening for diabetes mellitus', 'en');
    const longer = q.nameRank('Screening for diabetes mellitus declined by patient', 'en');
    const words = q.nameRank('Mellitus, diabetes', 'en');
    expect(exact).toBeGreaterThan(starts);
    expect(starts).toBeGreaterThan(has);
    expect(has).toBeGreaterThan(longer);
    expect(longer).toBeGreaterThan(words);
    expect(q.nameRank('Hypertension', 'en')).toBe(0);
  });

  test('the FTS5 query', () => {
    expect(new TextQuery('hepatitis b').ftsQuery('en')).toBe('(words : "hepatitis"* OR stems : "hepat") AND words : "b"');
    expect(new TextQuery('-').ftsQuery('en')).toBeNull();
  });
});

describe('NameIndex', () => {
  const concepts = [
    { code: 'A1', names: [['en', 'Glucose in serum'], ['de', 'Glukose im Serum']] },
    { code: 'A2', names: [['en', 'Glucose in urine'], ['en', 'Urine sugar']] },
    { code: 'B1', names: [['en', 'Hepatitis B'], ['de', 'Hepatitis B']] },
    { code: 'B10', names: [['en', 'Hepatitis C']] }
  ];
  let index;
  beforeAll(async () => {
    index = new NameIndex();
    for (const c of concepts) {
      index.addCode(c.code, c.code);
      for (const [lang, name] of c.names) {
        index.add(c.code, lang, name);
      }
    }
    await index.build();
  });

  test('the same names as nameMatches, by language', () => {
    for (const filter of ['glucose', 'gluc ser', 'urine', 'sugars urine', 'hepatitis b', 'hepatitis', 'serum', 'nothing']) {
      for (const lang of ['en', 'de']) {
        const q = new TextQuery(filter);
        const expected = new Map();
        for (const c of concepts) {
          const texts = c.names.filter(([l, name]) => l === lang && q.nameMatches(name, lang)).map(([, name]) => name);
          if (texts.length > 0) {
            expected.set(c.code, texts);
          }
        }
        expect([filter, lang, index.searchNames(q, lang)]).toEqual([filter, lang, expected]);
      }
    }
  });

  test('codes that start with the filter', () => {
    expect(index.searchCodes(new TextQuery('b1'))).toEqual(['B1', 'B10']);
    expect(index.searchCodes(new TextQuery('a'))).toEqual(['A1', 'A2']);
    expect(index.searchCodes(new TextQuery('c'))).toEqual([]);
  });

  test('languages', () => {
    expect([...index.languages()].sort()).toEqual(['de', 'en']);
  });
});

describe('the database form', () => {
  test('columns: distinct words, and their stems', () => {
    expect(indexColumns('Fractures of the femur, fracture', 'en')).toEqual({ words: 'fractures of the femur fracture', stems: 'fractur of the femur' });
  });

  test('the table, and knowing it', () => {
    const sql = createTextIndexSql('TextIndex', ['codekey', 'lang']);
    expect(sql).toContain('codekey UNINDEXED, lang UNINDEXED, words, stems');
    expect(isTextIndexSql(sql)).toBe(true);
    expect(isTextIndexSql("CREATE VIRTUAL TABLE TextIndex USING fts5(codekey UNINDEXED, text, tokenize = 'porter unicode61 remove_diacritics 2')")).toBe(false);
  });

  // the same names match in SQLite as in memory (needs the native sqlite3)
  let sqlite3 = null;
  try {
    sqlite3 = require('sqlite3');
    new sqlite3.Database(':memory:').close();
  } catch (e) {
    sqlite3 = null;
  }
  (sqlite3 ? test : test.skip)('FTS5 matches the same names as nameMatches', async () => {
    const names = [
      ['en', 'Glucose [Mass/volume] in Serum or Plasma'], ['en', 'Calcium [Mass/time] in 24 hour Urine'],
      ['en', 'Hepatitis B virus surface Ag'], ['en', 'Hepatitis C virus Ab'], ['en', 'Catheter tip culture'],
      ['en', 'Infection of the lung'], ['en', 'Fracture of femur'], ['en', 'Radiation therapy'],
      ['de', 'Kalium [Mol/Volumen] in Urin'], ['de', 'Untersuchung des Blutes'], ['fr', 'Potassium urinaire'],
      ['hi', 'नमस्ते दुनिया'], ['es', 'Cólera']
    ];
    const filters = ['glucose serum', 'gluc ser', 'serum glucoses', 'calcium 24 hour urine', 'hepatitis b', 'hepatitis',
      'cats', 'catheter', 'infecti', 'fractures', 'therapies', 'kalium urin', 'untersuchungen', 'potassium urine',
      'नमस', 'colera', 'potassium in urine', 'b'];
    const db = new sqlite3.Database(':memory:');
    const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, e => e ? rej(e) : res()));
    const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, rows) => e ? rej(e) : res(rows)));
    await run(createTextIndexSql('T', ['id', 'lang']));
    for (let i = 0; i < names.length; i++) {
      const [lang, name] = names[i];
      const c = indexColumns(name, lang);
      await run('INSERT INTO T (id, lang, words, stems) VALUES (?, ?, ?, ?)', [i, lang, c.words, c.stems]);
    }
    for (const filter of filters) {
      for (const lang of ['en', 'de', 'fr', 'hi', 'es']) {
        const q = new TextQuery(filter);
        const expected = names.map(([l, name], i) => (l === lang && q.nameMatches(name, lang) ? i : -1)).filter(i => i >= 0);
        const fts = q.ftsQuery(lang);
        const got = fts ? (await all('SELECT id FROM T WHERE T MATCH ? AND lang = ? ORDER BY id', [fts, lang])).map(r => Number(r.id)) : [];
        expect([filter, lang, got]).toEqual([filter, lang, expected]);
      }
    }
    db.close();
  });
});
