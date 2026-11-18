'use strict';

// SNOMED CT English dialects on the engine: the designations (and so the displays) it reports
// are those of cs-snomed.js, for the test edition read as three kinds of edition:
//  - the International edition (display reference set: US English) - en and en-US get the US
//    preferred term, en-GB the GB one
//  - a UK edition (display reference set: GB English) - en and en-GB get the GB term, en-US the US one
//  - a national edition with no entry of its own (display reference sets: US then GB English)
// 262797004 has the GB synonym "Subcapsular liver haematoma" stored before the US "Subcapsular
// liver hematoma"; 35566002 has "Hematoma" (US) before "Haematoma" (GB); 64572001 "Disease" is
// preferred in both.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { SnomedServicesFactory } = require('../../tx/cs/cs-snomed');
const { SnomedImporter } = require('../../tx/importers/import-sct.module');
const SCT_LICENSE = path.join(__dirname, '../../tx/data/snomed/license.txt');
const { importSnomedV2FromCache } = require('../../tx/importers/import-sct-v2-cache.module');
const { loadSqliteV2Factory } = require('../../tx/sqlite-v2');
const { OperationContext } = require('../../tx/operation-context');
const { Designations } = require('../../tx/library/designations');
const { Languages } = require('../../library/languages');
const { TestUtilities } = require('../test-utilities');

const SRC = path.resolve(__dirname, '../../tx/data/snomed');
const EDITIONS = { intl: '31000003106', uk: '83821000000107', national: '11000146104' };
let dir, op, langDefs;
const main = {}, engine = {};

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

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-sct-dialects-'));
  langDefs = await TestUtilities.loadLanguageDefinitions();
  op = new OperationContext('en', await TestUtilities.loadTranslations(langDefs));
  const snap = path.join(dir, 'Snapshot');
  mergeSnapshot(SRC, snap);
  for (const [name, edition] of Object.entries(EDITIONS)) {
    const cache = path.join(dir, name + '.cache');
    const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await new SnomedImporter({ source: snap, dest: cache, edition, version: '20250909',
        uri: `http://snomed.info/sct/${edition}/version/20250909`, language: 'en-US', license: SCT_LICENSE, verbose: false, overwrite: true }).run();
    } finally { quiet.mockRestore(); }
    main[name] = new SnomedServicesFactory(op.i18n, cache);
    await main[name].load();
    await importSnomedV2FromCache({ source: cache, dest: path.join(dir, name + '.db'), overwrite: true, normalForms: false, log: () => {} });
    engine[name] = await loadSqliteV2Factory(op.i18n, path.join(dir, name + '.db'));
  }
}, 240000);

afterAll(async () => {
  for (const f of Object.values(engine)) if (f) f.store.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

async function designations(factory, code, significantOnly) {
  const p = await factory.build(op, []);
  const { context } = await p.locate(code);
  const list = new Designations(langDefs);
  await p.designations(context, list, significantOnly);
  list.source = p;
  return list;
}
const rows = (list) => list.designations.map((d) => `${d.language.code}|${d.use ? d.use.code : ''}|${d.status || ''}|${d.value}`);
async function display(factory, code, lang, significantOnly) {
  const list = await designations(factory, code, significantOnly);
  const pd = list.preferredDesignation(lang ? Languages.fromAcceptLanguage(lang, langDefs, false) : null);
  return pd ? pd.value : null;
}

describe('SNOMED CT English dialects (engine)', () => {
  test('the three files are the editions meant: their display reference sets', () => {
    const codes = (f) => f.displayRefsetIds().map((id) => f.store.conceptRows([id]).get(id).code);
    expect(codes(engine.intl)).toEqual(['900000000000509007']);
    expect(codes(engine.uk)).toEqual(['900000000000508004']);
    expect(codes(engine.national)).toEqual(['900000000000509007', '900000000000508004']);
    expect(engine.intl.store.hasRank).toBe(true); // a v5 file: acceptability is read only where needed
  });

  for (const significantOnly of [true, false]) {
    const op2 = significantOnly ? '$expand' : '$lookup';

    test(op2 + ' designations: International edition - US term for en and en-US, GB term for en-GB', async () => {
      for (const lang of [null, 'en', 'en-US']) {
        expect(await display(engine.intl, '262797004', lang, significantOnly)).toBe('Subcapsular liver hematoma');
        expect(await display(engine.intl, '35566002', lang, significantOnly)).toBe('Hematoma');
        expect(await display(engine.intl, '64572001', lang, significantOnly)).toBe('Disease');
      }
      expect(await display(engine.intl, '262797004', 'en-GB', significantOnly)).toBe('Subcapsular liver haematoma');
      expect(await display(engine.intl, '35566002', 'en-GB', significantOnly)).toBe('Haematoma');
      expect(await display(engine.intl, '64572001', 'en-GB', significantOnly)).toBe('Disease');
      expect(await display(engine.intl, '262797004', 'nl', significantOnly)).toBe('subcapsulair leverhematoom');
    });

    test(op2 + ' designations: UK edition - GB term for en and en-GB, US term for en-US', async () => {
      for (const lang of [null, 'en', 'en-GB']) {
        expect(await display(engine.uk, '262797004', lang, significantOnly)).toBe('Subcapsular liver haematoma');
        expect(await display(engine.uk, '35566002', lang, significantOnly)).toBe('Haematoma');
      }
      expect(await display(engine.uk, '262797004', 'en-US', significantOnly)).toBe('Subcapsular liver hematoma');
      expect(await display(engine.uk, '35566002', 'en-US', significantOnly)).toBe('Hematoma');
    });

    test(op2 + ' designations: every concept, each edition, as cs-snomed.js reports them', async () => {
      for (const name of Object.keys(EDITIONS)) {
        const codes = engine[name].store.db.prepare('SELECT code FROM concept ORDER BY concept_id').pluck().all();
        expect(codes.length).toBeGreaterThan(2000);
        let dialectTagged = 0;
        for (const code of codes) {
          const want = rows(await designations(main[name], code, significantOnly));
          const got = rows(await designations(engine[name], code, significantOnly));
          expect([name, code, got]).toEqual([name, code, want]);
          if (want.some((r) => /^en-GB\|900000000000013009/.test(r) || /^en-US\|900000000000013009/.test(r))) dialectTagged++;
        }
        // the comparison covers concepts whose dialects differ
        expect(dialectTagged).toBeGreaterThan(50);
      }
    }, 120000);
  }

  test('$expand designations: the display, one FSN and one synonym per language, and the other dialect where it differs', async () => {
    expect(rows(await designations(engine.intl, '262797004', true))).toEqual([
      'en-US|preferredForLanguage|active|Subcapsular liver hematoma',
      'en|900000000000003001|active|Subcapsular liver hematoma (disorder)',
      'en|900000000000013009|active|Subcapsular liver hematoma',
      'nl|900000000000013009|active|subcapsulair leverhematoom',
      'en-GB|900000000000013009|active|Subcapsular liver haematoma'
    ]);
  });

  test('a page read for its displays only: a UK edition reads the designations when en-US is asked for', async () => {
    const ask = async (factory, header) => {
      const ctx = new OperationContext(Languages.fromAcceptLanguage(header, langDefs, false), op.i18n);
      const p = await factory.build(ctx, []);
      const handle = await p.prefetchCodes(['262797004'], true, { displayOnly: true });
      const { context } = await p.locate('262797004', handle);
      const list = new Designations(langDefs);
      await p.designations(context, list, true);
      list.source = p;
      return list.preferredDesignation(ctx.langs).value;
    };
    expect(await ask(engine.uk, 'en-US')).toBe('Subcapsular liver hematoma');
    expect(await ask(engine.uk, 'en')).toBe('Subcapsular liver haematoma');
    expect(await ask(engine.intl, 'en-US')).toBe('Subcapsular liver hematoma');
    expect(await ask(engine.intl, 'en')).toBe('Subcapsular liver hematoma');
  });
});
