/**
 * ICD-11's text search: by the rules every provider's search follows (text-match.js), from the
 * text index (designation_text: icd11-text-index.js) - a name in the search language with every
 * word of the filter, or a short code that starts with it. A database without the index is
 * searched as before, for the whole filter text. A small database is built from the importer's
 * schema.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ICD11ServicesFactory } = require('../../tx/cs/cs-icd11');
const { SCHEMA } = require('../../tx/importers/import-icd11');
const { buildTextIndex } = require('../../tx/importers/icd11-text-index');
const { SearchFilterText } = require('../../tx/library/designations');
const { Languages } = require('../../library/languages');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');

const MMS = 'http://id.who.int/icd/release/11/mms';

// entity id, short code, [lang, kind, text]...
const CONCEPTS = [
  ['0900', 'XY99', [['en', 'title', 'Applied action']]],
  ['0901', 'DB10', [['en', 'title', 'Acute appendicitis']]],
  ['1000', '1A00', [['en', 'title', 'Cholera'], ['es', 'title', 'Cólera']]],
  ['1001', '1A01', [['en', 'title', 'Intestinal infection due to other Vibrio']]],
  ['1002', '1A02', [['en', 'title', 'Intestinal infections due to Shigella'], ['en', 'indexTerm', 'Bacillary dysentery']]],
  ['1003', '1A03', [['en', 'title', 'Intestinal infections due to Escherichia coli']]],
  ['1100', '1E50', [['en', 'title', 'Acute hepatitis B']]],
  ['1101', '1E51', [['en', 'title', 'Acute hepatitis C']]],
  ['1102', '1E52', [['en', 'title', 'Intestinal parasite'], ['en', 'definition', 'Infection of the gut by a worm']]]
];

function buildDb(file, withIndex) {
  const db = new Database(file);
  db.exec(SCHEMA);
  db.pragma('journal_mode = DELETE');
  db.prepare("INSERT INTO meta (key, value) VALUES ('languages', 'en,es')").run();
  db.prepare('INSERT INTO system (id, code, url, version, title, is_tree, api_root, uri_stem) VALUES (1, ?, ?, ?, ?, 1, ?, ?)')
    .run('mms', MMS, '2026-01', 'ICD-11 MMS', '/icd/release/11/2026-01/mms', MMS);
  const concept = db.prepare(`INSERT INTO concept (id, system, entity_id, uri, code, class_kind, selectable, depth, lft, rgt)
    VALUES (?, 1, ?, ?, ?, 'category', 1, 1, ?, ?)`);
  const designation = db.prepare('INSERT INTO designation (concept, lang, kind, value, seq) VALUES (?, ?, ?, ?, 0)');
  let id = 1;
  for (const [entity, code, names] of CONCEPTS) {
    concept.run(id, entity, MMS + '/' + entity, code, id * 2, id * 2 + 1);
    for (const [lang, kind, text] of names) {
      designation.run(id, lang, kind, text);
    }
    id++;
  }
  if (withIndex) {
    buildTextIndex(db);
  }
  db.close();
}

let dir;
let i18n;
let langDefs;
const factories = {};
const providers = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icd11-text-'));
  langDefs = await TestUtilities.loadLanguageDefinitions();
  i18n = await TestUtilities.loadTranslations(langDefs);
  for (const withIndex of [true, false]) {
    const file = path.join(dir, `icd11-${withIndex}.db`);
    buildDb(file, withIndex);
    factories[withIndex] = new ICD11ServicesFactory(i18n, file, 'mms');
    await factories[withIndex].load();
  }
});

afterAll(() => {
  for (const p of providers) p.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// the short codes of the concepts found (a concept's code is its entity id)
const SHORT = new Map(CONCEPTS.map(([entity, code]) => [entity, code]));

async function codes(text, { lang = null, withIndex = true } = {}) {
  const provider = await factories[withIndex].build(new OperationContext('en', i18n), []);
  providers.push(provider);
  const languages = lang ? Languages.fromAcceptLanguage(lang, langDefs, true) : null;
  const filterContext = await provider.getPrepContext(true, languages);
  await provider.searchFilter(filterContext, new SearchFilterText(text), false);
  const [set] = await provider.executeFilters(filterContext);
  const result = [];
  while (await provider.filterMore(filterContext, set)) {
    result.push(SHORT.get(await provider.code(await provider.filterConcept(filterContext, set))));
  }
  return result;
}

describe('ICD-11 text search', () => {
  test('the database has the text index', () => {
    expect(factories[true]._shared.textIndex).toBe(true);
    expect(factories[false]._shared.textIndex).toBe(false);
  });

  test('every word, in any order, as the start of a word or with the same stem', async () => {
    expect((await codes('infection intestinal')).sort()).toEqual(['1A01', '1A02', '1A03']);
    expect(await codes('intest shig')).toEqual(['1A02']);
    expect(await codes('intestinal infections shigella')).toEqual(['1A02']);
  });

  test('the best match first: the filter\'s words in its order, then the classification\'s order', async () => {
    // Applied action comes first in the classification, but its words are the other way round
    expect(await codes('ac ap')).toEqual(['DB10', 'XY99']);
    // all three start with the filter's words; the shortest name is the closest match
    expect(await codes('intestinal infection')).toEqual(['1A02', '1A01', '1A03']);
  });

  test('index terms are names; definitions are not', async () => {
    expect(await codes('dysentery')).toEqual(['1A02']);
    expect(await codes('worm')).toEqual([]);
  });

  test('a single letter is a whole word', async () => {
    expect(await codes('hepatitis b')).toEqual(['1E50']);
  });

  test('a short code that starts with the filter', async () => {
    expect(await codes('1a0')).toEqual(['1A00', '1A01', '1A02', '1A03']);
    expect(await codes('1E51')).toEqual(['1E51']);
  });

  test('in the search language, without regard to accents', async () => {
    expect(await codes('colera', { lang: 'es' })).toEqual(['1A00']);
    expect(await codes('cholera', { lang: 'es' })).toEqual([]);
  });

  test('a database without the index: the whole filter text, as before', async () => {
    expect(await codes('intestinal infections', { withIndex: false })).toEqual(['1A02', '1A03']);
    expect(await codes('infection intestinal', { withIndex: false })).toEqual([]);
  });
});
