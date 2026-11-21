'use strict';

// The SNOMED CT edition's default language (#397, 1.0.4): the language a text or display regex
// filter searches when the request names none. Main's importer records the edition's language in
// the cache's default-language slot (format 20), and its server reads the slot (a language byte,
// or, in the original server's caches, a language reference set's offset). The engine's importers
// record the same language in cs_config, and the engine chooses the search language as
// cs-snomed.js #filterLanguage does. Here: the test edition imported as a Dutch edition
// (--language nl-NL), by main's importer and the engine's two.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { SnomedServicesFactory } = require('../../tx/cs/cs-snomed');
const { SnomedImporter } = require('../../tx/importers/import-sct.module');
// main's importer requires the license the edition is distributed under (cache format 21)
const SCT_LICENSE = path.join(__dirname, '../../tx/data/snomed/license.txt');
const { importSnomedV2FromCache, cacheDefaultLanguage } = require('../../tx/importers/import-sct-v2-cache.module');
const { importSnomedV2, rf2DefaultLanguage } = require('../../tx/importers/import-sct-v2.module');
const { SnomedFileReader } = require('../../tx/sct/structures');
const { languageByte } = require('../../tx/sct/languages');
const { loadSqliteV2Factory } = require('../../tx/sqlite-v2');
const { OperationContext } = require('../../tx/operation-context');
const { SearchFilterText } = require('../../tx/library/designations');
const { Languages } = require('../../library/languages');
const { TestUtilities } = require('../test-utilities');

const SRC = path.resolve(__dirname, '../../tx/data/snomed');
let dir, op, langDefs, main, fromCache, fromRf2, mainEn, engineEn;

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
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

async function mainCache(snap, dest, language) {
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await new SnomedImporter({ source: snap, dest, edition: '31000003106', version: '20250909',
      uri: 'http://snomed.info/sct/31000003106/version/20250909', language, license: SCT_LICENSE, verbose: false, overwrite: true }).run();
  } finally { quiet.mockRestore(); }
}

const config = (file) => {
  const db = new Database(file, { readonly: true });
  try { return db.prepare("SELECT value FROM cs_config WHERE key = 'defaultLanguage'").pluck().get(); } finally { db.close(); }
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-sct-deflang-'));
  langDefs = await TestUtilities.loadLanguageDefinitions();
  op = new OperationContext('en', await TestUtilities.loadTranslations(langDefs));
  const snap = path.join(dir, 'Snapshot');
  mergeSnapshot(SRC, snap);
  await mainCache(snap, path.join(dir, 'nl.cache'), 'nl-NL');
  await mainCache(snap, path.join(dir, 'en.cache'), 'en-US');
  main = new SnomedServicesFactory(op.i18n, path.join(dir, 'nl.cache'));
  await main.load();
  mainEn = new SnomedServicesFactory(op.i18n, path.join(dir, 'en.cache'));
  await mainEn.load();
  await importSnomedV2FromCache({ source: path.join(dir, 'nl.cache'), dest: path.join(dir, 'nl-cache.db'), overwrite: true, normalForms: false, log: () => {} });
  await importSnomedV2FromCache({ source: path.join(dir, 'en.cache'), dest: path.join(dir, 'en-cache.db'), overwrite: true, normalForms: false, log: () => {} });
  await importSnomedV2({ source: snap, dest: path.join(dir, 'nl-rf2.db'), edition: '31000003106', version: '20250909', language: 'nl-NL', overwrite: true, normalForms: false, log: () => {} });
  fromCache = await loadSqliteV2Factory(op.i18n, path.join(dir, 'nl-cache.db'));
  fromRf2 = await loadSqliteV2Factory(op.i18n, path.join(dir, 'nl-rf2.db'));
  engineEn = await loadSqliteV2Factory(op.i18n, path.join(dir, 'en-cache.db'));
}, 180000);

afterAll(async () => {
  for (const f of [fromCache, fromRf2, engineEn]) if (f) f.store.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const langs = (header) => (header ? Languages.fromAcceptLanguage(header, langDefs, false) : null);

/** the codes a provider's text filter (or display regex) selects, in its order */
async function select(factory, how, header = null) {
  const p = await factory.build(op, []);
  const prep = await p.getPrepContext(true, langs(header));
  if (how.text != null) await p.searchFilter(prep, new SearchFilterText(how.text), true);
  else await p.filter(prep, true, 'display', 'regex', how.regex);
  const sets = await p.executeFilters(prep);
  const out = [];
  while (await p.filterMore(prep, sets[0])) out.push(await p.code(await p.filterConcept(prep, sets[0])));
  return out;
}

async function same(how, header = null, m = main, engines = [fromCache, fromRf2]) {
  const want = await select(m, how, header);
  for (const e of engines) expect([how, header, await select(e, how, header)]).toEqual([how, header, want]);
  return want;
}

describe('SNOMED CT default language', () => {
  test('main\'s importer writes the edition\'s language; the engine\'s files record the same', async () => {
    const d = await new SnomedFileReader(path.join(dir, 'nl.cache')).loadSnomedData();
    expect(d.cacheVersion).toBe('21');
    expect(d.defaultLanguage).toBe(languageByte('nl'));
    expect(main.snomedServices.defaultLanguage).toBe(languageByte('nl'));
    expect(cacheDefaultLanguage(d)).toBe(languageByte('nl'));
    expect(config(path.join(dir, 'nl-cache.db'))).toBe('nl');
    expect(config(path.join(dir, 'nl-rf2.db'))).toBe('nl');
    // English: as before
    expect(config(path.join(dir, 'en-cache.db'))).toBe('en-US');
  });

  test('an older cache: a language reference set\'s offset in the slot (the original server\'s caches) is read as main read it up to 1.0.4', async () => {
    const d = await new SnomedFileReader(path.join(dir, 'nl.cache')).loadSnomedData();
    const svc = main.snomedServices;
    // main up to 1.0.4: the language most of that reference set's descriptions are in; any
    // other value English. Main's server now reads only format 21 (a language byte).
    let seen = 0;
    for (let i = 0; i < svc.refSetIndex.count(); i++) {
      const offset = svc.refSetIndex.getReferenceSet(i).membersByRef;
      const counts = [...svc.refSetMembers.descriptionLanguages(offset, svc.descriptions)].sort((a, b) => b[1] - a[1]);
      const want = counts.length ? counts[0][0] : 1;
      if (counts.length) seen++;
      expect(cacheDefaultLanguage({ ...d, cacheVersion: '16', defaultLanguage: offset })).toBe(want);
    }
    expect(seen).toBeGreaterThan(0); // the test edition has language reference sets
    expect(cacheDefaultLanguage({ ...d, cacheVersion: '19', defaultLanguage: languageByte('nl') })).toBe(languageByte('nl'));
    expect(cacheDefaultLanguage({ ...d, cacheVersion: '20', defaultLanguage: 999999 })).toBe(1);
  });

  test('the RF2 importer: --language, else the edition\'s language, if the edition has descriptions in it', () => {
    expect(rf2DefaultLanguage({ edition: '11000146104' }, new Set(['en', 'nl']))).toBe('nl');
    expect(rf2DefaultLanguage({ edition: '11000146104' }, new Set(['en']))).toBe(null);
    expect(rf2DefaultLanguage({ edition: '449081005' }, new Set(['en', 'es']))).toBe('es');
    expect(rf2DefaultLanguage({ edition: '900000000000207008' }, new Set(['en']))).toBe(null);
    expect(rf2DefaultLanguage({ edition: '31000003106', language: 'nl-NL' }, new Set(['en', 'nl']))).toBe('nl');
    expect(rf2DefaultLanguage({ edition: '51000202101' }, new Set(['en', 'no']))).toBe('no');
    expect(rf2DefaultLanguage({ edition: '31000003106' }, new Set(['en', 'nl']))).toBe(null);
  });

  test('a text filter with no request language searches the edition\'s language, as main', async () => {
    for (const [f, h] of [['hematoom', null], ['hematoma', null], ['lever', null], ['hematoom', 'en'], ['hematoma', 'en'],
      ['hematoom', 'nl'], ['hematoom', 'de'], ['hematoma', 'de'], ['hemat', null]]) await same({ text: f }, h);
    expect(await same({ text: 'hematoom' })).toContain('35566002');
    expect(await same({ text: 'hematoma' })).toEqual([]);
    // the English edition, as before
    expect(await same({ text: 'hematoom' }, null, mainEn, [engineEn])).toEqual([]);
  });

  test('a display regex with no request language matches the edition\'s language, as main', async () => {
    for (const [r, h] of [['.*hematoom.*', null], ['.*[Hh]ematoma.*', null], ['.*hematoom.*', 'en'], ['.*[Hh]ematoma.*', 'en']]) {
      await same({ regex: r }, h);
    }
    expect((await same({ regex: '.*hematoom.*' })).length).toBeGreaterThan(0);
  });

  test('a request in Norwegian finds descriptions under either "no" or "nb"/"nn" (languageBytesFor)', async () => {
    const p = await fromCache.build(op, []);
    const store = p.store;
    const saved = store._textLangs;
    try {
      store._textLangs = new Set(['en', 'no']);
      expect(p._sctFilterLanguage(['nb'])).toBe('no');
      expect(p._sctFilterLanguage(['nn-NO'])).toBe('no');
      store._textLangs = new Set(['en', 'nb']);
      expect(p._sctFilterLanguage(['no'])).toBe('nb');
      expect(p._sctFilterLanguage(['de', 'nb'])).toBe('nb');
      // none named: the default (nl), if the edition has it, else its language with the lowest byte
      expect(p._sctFilterLanguage([])).toBe('en');
      store._textLangs = new Set(['nb', 'fr']);
      expect(p._sctFilterLanguage([])).toBe('fr');
      store._textLangs = new Set(['nl', 'en']);
      expect(p._sctFilterLanguage([])).toBe('nl');
    } finally {
      store._textLangs = saved;
    }
  });
});
