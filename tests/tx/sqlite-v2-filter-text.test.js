'use strict';

// $expand text filters on sqlite-v2 answer as the built-in providers do, in their order:
//   SNOMED CT  cs-snomed.js + tx/sct/text-index.js (word prefixes, stems, words spread over a
//              concept's descriptions, the filter split as the terms are, short words, ranking,
//              the request's language), on the test edition cache and its reverse-loaded file,
//              with the stored word index and without it (built in memory, as main does)
//   RxNorm     cs-rxnorm.js's stem search, on an RRF fixture through both importers

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { SnomedServicesFactory } = require('../../tx/cs/cs-snomed');
const { RxNormServicesFactory } = require('../../tx/cs/cs-rxnorm');
const { RxNormImporter } = require('../../tx/importers/import-rxnorm.module');
const { importSnomedV2FromCache } = require('../../tx/importers/import-sct-v2-cache.module');
const { importRxNormV2 } = require('../../tx/importers/import-rxnorm-v2.module');
const { addFilterIndex } = require('../../tx/importers/sqlite-v2/add-filter-index');
const { loadSqliteV2Factory } = require('../../tx/sqlite-v2');
const { OperationContext } = require('../../tx/operation-context');
const { SearchFilterText } = require('../../tx/library/designations');
const { Languages } = require('../../library/languages');
const { TestUtilities } = require('../test-utilities');

const { SnomedImporter } = require('../../tx/importers/import-sct.module');

const SRC = path.resolve(__dirname, '../../tx/data/snomed');
let dir, op, langDefs, main, stored, memory, rxMain, rxV2;

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
// the test edition is split by module; main's cache importer reads one file of each kind
function mergeSnapshot(src, dst) {
  const groups = new Map();
  for (const f of walk(src)) {
    if (!f.endsWith('.txt') || /Readme/i.test(f)) continue;
    const rel = path.relative(src, f);
    const key = path.join(path.dirname(rel), path.basename(rel).replace(/_(INT|TEST1000003|LO1010000)_/, '_MERGED_'));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  for (const [k, files] of groups) {
    const out = path.join(dst, k);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, files.flatMap((f, i) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).slice(i ? 1 : 0)).join('\n') + '\n');
  }
}

// RXNCONSO: RXCUI|LAT|TS|LUI|STT|SUI|ISPREF|RXAUI|SAUI|SCUI|SDUI|SAB|TTY|CODE|STR|SRL|SUPPRESS|CVF
const conso = (cui, aui, tty, str, sup = 'N', sab = 'RXNORM') => [cui, 'ENG', '', '', '', '', '', aui, '', '', '', sab, tty, cui, str, '', sup, ''].join('|');
const archive = (cui, aui, tty, str) => [aui, '', str, '', '', '', cui, '', 'ENG', '', '', '', cui, 'RXNORM', tty, ''].join('|');

async function buildRxNorm() {
  const rrf = path.join(dir, 'rrf');
  fs.mkdirSync(rrf);
  const rows = [
    conso('6809', 'A1', 'IN', 'metformin'),
    conso('6809', 'A2', 'SY', 'Glucophage generic'),
    conso('583192', 'A3', 'BN', 'Metforming'),
    conso('861007', 'A4', 'SCD', 'metformin hydrochloride 500 MG Oral Tablet'),
    conso('861007', 'A5', 'PSN', 'metFORMIN HCl 500 MG Oral Tablet'),
    conso('1043563', 'A6', 'SCD', '24 HR metformin hydrochloride 1000 MG Extended Release Oral Tablet'),
    conso('1007411', 'A7', 'MIN', 'chlorpropamide / metformin', 'O'),
    conso('70', 'A8', 'SY', 'metformin only a synonym'),
    conso('161', 'A9', 'IN', 'acetaminophen'),
    conso('202433', 'A10', 'BN', 'Tylenol'),
    conso('2', 'A11', 'SCD', 'acetaminophen 325 MG Oral Tablet'),
    conso('19', 'A12', 'SCD', 'acetaminophen 500 MG / oxycodone hydrochloride 5 MG Oral Tablet'),
    conso('300', 'A13', 'SCD', 'Glucose-6-phosphate 2.5 MG/ML Injectable Solution'),
    conso('6809', 'A14', 'BD', 'other source', 'N', 'MMSL'),
  ];
  fs.writeFileSync(path.join(rrf, 'RXNCONSO.RRF'), rows.join('\n') + '\n');
  fs.writeFileSync(path.join(rrf, 'RXNATOMARCHIVE.RRF'), archive('999', 'A99', 'SCD', 'metformin archived') + '\n');
  fs.writeFileSync(path.join(rrf, 'RXNREL.RRF'), '');
  fs.writeFileSync(path.join(rrf, 'RXNSTY.RRF'), ['6809', '861007'].map((c) => `${c}|T121|||A|`).join('\n') + '\n');
  fs.writeFileSync(path.join(rrf, 'RXNSAB.RRF'), '');
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await new RxNormImporter(rrf, path.join(dir, 'rx-classic.db'), '01012026', { verbose: false }).import();
  } finally { quiet.mockRestore(); }
  await importRxNormV2({ source: rrf, dest: path.join(dir, 'rx-v2.db'), version: '01012026', overwrite: true, log: () => {} });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-text-'));
  langDefs = await TestUtilities.loadLanguageDefinitions();
  op = new OperationContext('en', await TestUtilities.loadTranslations(langDefs));
  // main's cache of the test edition, and the engine's file reverse-loaded from it (the same concepts and order)
  const snap = path.join(dir, 'Snapshot');
  mergeSnapshot(SRC, snap);
  const cache = path.join(dir, 't.cache');
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await new SnomedImporter({ source: snap, dest: cache, edition: '31000003106', version: '20250909',
      uri: 'http://snomed.info/sct/31000003106/version/20250909', language: 'en-US', verbose: false, overwrite: true }).run();
  } finally { quiet.mockRestore(); }
  main = new SnomedServicesFactory(op.i18n, cache);
  await main.load();
  await importSnomedV2FromCache({ source: cache, dest: path.join(dir, 'sct.db'), overwrite: true, log: () => {} });
  fs.copyFileSync(path.join(dir, 'sct.db'), path.join(dir, 'sct-bare.db'));
  const bare = new Database(path.join(dir, 'sct-bare.db'));
  bare.exec('DROP TABLE text_word; DROP TABLE text_word_count; DROP TABLE text_word_meta;');
  bare.close();
  stored = await loadSqliteV2Factory(op.i18n, path.join(dir, 'sct.db'));
  memory = await loadSqliteV2Factory(op.i18n, path.join(dir, 'sct-bare.db'));
  await buildRxNorm();
  rxMain = new RxNormServicesFactory(op.i18n, path.join(dir, 'rx-classic.db'));
  await rxMain.load();
  rxV2 = await loadSqliteV2Factory(op.i18n, path.join(dir, 'rx-v2.db'));
}, 180000);

afterAll(async () => {
  for (const f of [stored, memory, rxV2]) if (f) f.store.close();
  if (rxMain && rxMain.close) await rxMain.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const langs = (header) => (header ? Languages.fromAcceptLanguage(header, langDefs, false) : null);

/** the codes a provider's text filter selects, in its order (as expand.js walks the first filter set) */
async function search(factory, text, header = null) {
  const p = await factory.build(op, []);
  const prep = await p.getPrepContext(true, langs(header));
  await p.searchFilter(prep, new SearchFilterText(text), true);
  const sets = await p.executeFilters(prep);
  const out = [];
  while (await p.filterMore(prep, sets[0])) out.push(await p.code(await p.filterConcept(prep, sets[0])));
  return out;
}

/** main's answer, and the engine's on the file with the stored index and on the file without it */
async function both(text, header = null) {
  const want = await search(main, text, header);
  expect([text, header, await search(stored, text, header)]).toEqual([text, header, want]);
  expect([text, header, await search(memory, text, header)]).toEqual([text, header, want]);
  return want;
}

describe('SNOMED CT text filter, as cs-snomed.js', () => {
  test('the importer writes the word index', () => {
    const db = new Database(path.join(dir, 'sct.db'), { readonly: true });
    try {
      expect(db.prepare('SELECT lang FROM text_word_count ORDER BY lang').pluck().all()).toEqual(['en', 'nl']);
      expect(db.prepare("SELECT count(*) FROM text_word WHERE lang = 'en' AND word = 'liver'").pluck().get()).toBe(1);
    } finally { db.close(); }
  });

  test('add-filter-index writes the same tables, in place or in a sidecar (the file untouched)', async () => {
    const f = path.join(dir, 'sct-again.db');
    fs.copyFileSync(path.join(dir, 'sct-bare.db'), f);
    addFilterIndex(f, { inPlace: true });
    const g = path.join(dir, 'sct-side.db');
    fs.copyFileSync(path.join(dir, 'sct-bare.db'), g);
    const before = fs.readFileSync(g);
    addFilterIndex(g);
    expect(fs.readFileSync(g).equals(before)).toBe(true);
    expect(fs.existsSync(g + '.words')).toBe(true);
    const a = new Database(path.join(dir, 'sct.db'), { readonly: true });
    const b = new Database(f, { readonly: true });
    const c = new Database(g + '.words', { readonly: true });
    try {
      for (const q of ['SELECT lang, word, stem, ids FROM text_word ORDER BY lang, word', 'SELECT lang, data FROM text_word_count ORDER BY lang']) {
        expect(b.prepare(q).raw().all()).toEqual(a.prepare(q).raw().all());
        expect(c.prepare(q).raw().all()).toEqual(a.prepare(q).raw().all());
      }
      expect(c.prepare("SELECT value FROM text_word_meta WHERE key = 'system'").pluck().get()).toBe('http://snomed.info/sct');
    } finally { a.close(); b.close(); c.close(); }
    // the server uses the sidecar: same answers as main
    const side = await loadSqliteV2Factory(op.i18n, g);
    try {
      for (const t of ['liver', 'hepatitis', 'chronic hepat', '2']) {
        expect([t, await search(side, t)]).toEqual([t, await search(main, t)]);
      }
      expect(side.store._textIndex && side.store._textIndex.own).toBe(true);
    } finally { side.store.close(); }
  });

  test('(2) every word may be the start of a word (#398)', async () => {
    for (const f of ['hepat', 'cirrh', 'intrahep', 'liver dis', 'chronic hepat', 'hepat liver', 'chron hepat']) expect((await both(f)).length).toBeGreaterThan(0);
  });

  test('(3) a word matches the other words of its stem', async () => {
    const none = [];
    for (const f of ['livers', 'tendons', 'infections', 'diseases', 'cysts', 'biopsies']) if (!(await both(f)).length) none.push(f);
    expect(none).toEqual([]);
  });

  test('(4) the words must be in one description (#398)', async () => {
    // a concept found only through two of its descriptions
    const db = new Database(path.join(dir, 'sct.db'), { readonly: true });
    let spread;
    try {
      spread = db.prepare(`SELECT c.code, a.term AS a, b.term AS b FROM concept c JOIN designation a ON a.concept_id = c.concept_id AND a.active = 1
        JOIN designation b ON b.concept_id = c.concept_id AND b.active = 1 AND b.designation_id <> a.designation_id
        WHERE c.active = 1 AND lower(a.term) LIKE '%hepat%' AND lower(a.term) NOT LIKE '%liver%' AND lower(b.term) LIKE '%liver%' LIMIT 1`).get();
    } finally { db.close(); }
    expect(spread).toBeTruthy();
    const words = (t) => t.toLowerCase().match(/[a-z]{4,}/g);
    const f = `${words(spread.a).find((w) => w.startsWith('hepat'))} ${words(spread.b).find((w) => w === 'liver')}`;
    expect(await both(f)).not.toContain(spread.code);
  });

  test('(5) the filter splits on the same punctuation as the terms', async () => {
    const none = [];
    for (const f of ['crigler-najjar', 'crigler najjar', "hunter's syndrome", "von gierke's", 'glucose-6-phosphate', 'alpha-1-antitrypsin']) if (!(await both(f)).length) none.push(f);
    expect(none).toEqual([]);
  });

  test('(6) quotes and other punctuation are not part of a word', async () => {
    expect(await both('"crigler najjar"')).toEqual(await both('crigler najjar'));
    expect(await both("'liver'")).toEqual(await both('liver'));
    await both('(liver)');
  });

  test('(7) short words: a single letter or digit is a whole word; stop words; codes', async () => {
    for (const f of ['ct', 'ct liver', 'nos', 'type i', 'c', 'r', '2', 'i', '-', 'of', 'of the', 'the liver', 'hepatitis b', 'hepatitis c',
      '35566002', '3556', '1', '9', ' 35566 ']) await both(f);
    expect((await both('ct')).length).toBeGreaterThan(0);
    expect(await both('-')).toEqual([]);
    expect((await both('3556'))[0]).toMatch(/^3556/);
    expect((await both('35566002'))[0]).toBe('35566002');
  });

  test('(8) ranking: exact term, then terms starting with the filter, then all words in one term, then the rest', async () => {
    for (const f of ['liver', 'hepatitis', 'liver disease', 'chronic hepatitis', 'disorder', 'structure', 'entire liver', 'cirrhosis of liver']) await both(f);
    const r = await both('hepatitis');
    expect(r.length).toBeGreaterThan(200); // past RANK_REFINE_LIMIT: the tail keeps concept order
  });

  test('(9) #399: the filter\'s words in its order first (at the start, together, with words between), shorter names first', async () => {
    for (const f of ['hepatitis chronic', 'chronic hepatitis', 'liver disease', 'disease liver', 'disease of liver', 'cirrhosis liver',
      'liver cirrhosis', 'entire liver', 'liver entire', 'chr hep', 'hep chr']) await both(f);
  });

  test('(10) the request language: its descriptions only; the first language asked for that the edition has', async () => {
    for (const [f, h] of [['hematoom', 'nl'], ['hematoom', 'nl-NL'], ['hematoom', null], ['hematoom', 'en'], ['leverbloeding', 'de, nl;q=0.5'],
      ['hematoma', 'nl'], ['hematoma', null], ['lever', 'nl'], ['hemat', 'nl'], ['h', 'nl']]) await both(f, h);
    expect(await both('hematoom', 'nl')).toContain('35566002');
    expect(await both('hematoom')).toEqual([]);
  });
});

describe('SNOMED CT: the languages a text or display regex filter chooses from', () => {
  /** a fresh factory on the file, with the SQL its store prepares from now on */
  async function watched(file) {
    const f = await loadSqliteV2Factory(op.i18n, path.join(dir, file));
    const sql = [];
    for (const db of [f.store.db]) {
      const prepare = db.prepare.bind(db);
      db.prepare = (q) => { sql.push(q); return prepare(q); };
    }
    return { f, sql, scanned: () => sql.some((q) => /DISTINCT language FROM designation/.test(q)) };
  }
  async function filterCodes(factory, prop, opName, value) {
    const p = await factory.build(op, []);
    const prep = await p.getPrepContext(true, null);
    await p.filter(prep, true, prop, opName, value);
    const sets = await p.executeFilters(prep);
    let n = 0;
    while (await p.filterMore(prep, sets[0])) n++;
    return n;
  }

  test('ECL and a property filter do not list the languages; a display regex lists them from the word index', async () => {
    if (!fs.existsSync(path.join(dir, 'sct-side.db.words'))) {
      fs.copyFileSync(path.join(dir, 'sct-bare.db'), path.join(dir, 'sct-side.db'));
      addFilterIndex(path.join(dir, 'sct-side.db'));
    }
    for (const file of ['sct.db', 'sct-side.db']) {
      const w = await watched(file);
      try {
        expect(await filterCodes(w.f, 'constraint', '=', '<< 404684003')).toBeGreaterThan(0);
        expect(await filterCodes(w.f, 'concept', 'is-a', '404684003')).toBeGreaterThan(0);
        expect([file, w.f.store._textLangs, w.scanned()]).toEqual([file, undefined, false]);
        expect(await filterCodes(w.f, 'display', 'regex', '.*hepat.*')).toBeGreaterThan(0);
        expect([file, [...w.f.store._textLangs].sort(), w.scanned()]).toEqual([file, ['en', 'nl'], false]);
      } finally { w.f.store.close(); }
    }
  });

  test('a file without a word index reads them from its descriptions: the same languages and answers', async () => {
    const w = await watched('sct-bare.db');
    try {
      expect(await filterCodes(w.f, 'constraint', '=', '<< 404684003')).toBeGreaterThan(0);
      expect(w.f.store._textLangs).toBeUndefined();
      const n = await filterCodes(w.f, 'display', 'regex', '.*hepat.*');
      expect([[...w.f.store._textLangs].sort(), w.scanned()]).toEqual([['en', 'nl'], true]);
      expect(n).toBe(await filterCodes(stored, 'display', 'regex', '.*hepat.*'));
    } finally { w.f.store.close(); }
    expect(await search(memory, 'hematoom', 'nl')).toEqual(await search(stored, 'hematoom', 'nl'));
  });
});

describe('RxNorm text filter, as cs-rxnorm.js', () => {
  const rx = async (text) => {
    const want = await search(rxMain, text);
    expect([text, await search(rxV2, text)]).toEqual([text, want]);
    return want;
  };

  test('stems, prefixes, numbers; the best name first, then the RXCUI order (as text)', async () => {
    // #398: Metforming too (metformin is the start of it); one name has every word. #399: the
    // concept named metformin first, then by how closely the best name follows the filter
    expect(await rx('metformin')).toEqual(['6809', '583192', '861007', '1007411', '1043563']);
    for (const f of ['metf', 'METFORMIN', 'metformin 500', '500 metformin', 'hydrochloride', 'hr', '24 HR', 'acetaminophen / oxycodone',
      'tylenol', 'glucose-6', 'glucophage', 'mg', '2.5', '68', '6809', '1', 'oral tablet metformin', 'glucophage generic', 'metformin hcl']) await rx(f);
  });

  test('#399: ranked by the best name (as RXNTEXT holds it), then the RXCUI order', async () => {
    for (const f of ['metformin', 'metformin 500', '500 metformin', 'tablet metformin', 'metformin oral tablet', 'oral tablet', 'mg',
      'hydrochloride metformin', '24 hr', 'hr 24', '68']) await rx(f);
  });

  test('synonym-only and archived concepts are not selected', async () => {
    const r = await rx('metformin');
    expect(r).not.toContain('70');
    expect(r).not.toContain('999');
    expect(await rx('archived')).toEqual([]);
  });
});
