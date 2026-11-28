'use strict';

// SNOMED CT ECL with description filters ({{ term = ... }}, dialect, language, type, active; 1.0.4
// #401 narrows the term filters by the text index) and compound ECL: the same concepts as
// cs-snomed.js, in its order (_eclIntersect: the right side's; _eclUnion: the left's, then the
// right's; _eclMinus: the left's; refinements and {{ }} filters: their base's; << X: X first; <<! X:
// X, then its children in release order), on the test edition's cache and its reverse-loaded file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { SnomedServicesFactory } = require('../../tx/cs/cs-snomed');
const { SnomedImporter } = require('../../tx/importers/import-sct.module');
// main's importer requires the license the edition is distributed under (cache format 21)
const SCT_LICENSE = path.join(__dirname, '../../tx/data/snomed/license.txt');
const { importSnomedV2FromCache } = require('../../tx/importers/import-sct-v2-cache.module');
const { loadSqliteV2Factory } = require('../../tx/sqlite-v2');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');

const SRC = path.resolve(__dirname, '../../tx/data/snomed');
let dir, op, main, engine;

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

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-sct-ecl-'));
  const langDefs = await TestUtilities.loadLanguageDefinitions();
  op = new OperationContext('en', await TestUtilities.loadTranslations(langDefs));
  const snap = path.join(dir, 'Snapshot');
  mergeSnapshot(SRC, snap);
  await mainCache(snap, path.join(dir, 't.cache'), 'en-US');
  main = new SnomedServicesFactory(op.i18n, path.join(dir, 't.cache'));
  await main.load();
  await importSnomedV2FromCache({ source: path.join(dir, 't.cache'), dest: path.join(dir, 't.db'), overwrite: true, normalForms: false, log: () => {} });
  engine = await loadSqliteV2Factory(op.i18n, path.join(dir, 't.db'));
}, 180000);

afterAll(async () => {
  if (engine) engine.store.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/** the codes an ECL filter selects, in the provider's order (as expand.js walks the filter set) */
async function ecl(factory, text) {
  const p = await factory.build(op, []);
  const prep = await p.getPrepContext(true, null);
  await p.filter(prep, true, 'constraint', '=', text);
  const sets = await p.executeFilters(prep);
  const out = [];
  while (await p.filterMore(prep, sets[0])) out.push(await p.code(await p.filterConcept(prep, sets[0])));
  return out;
}

async function same(text) {
  const want = await ecl(main, text);
  expect([text, await ecl(engine, text)]).toEqual([text, want]);
  return want;
}

describe('SNOMED CT ECL description filters and compound ECL, as cs-snomed.js', () => {
  test('description filters: term, dialect, language, type, active', async () => {
    for (const e of ['<< 159033005 {{ term = "dietitian" }}', '<< 159033005 {{ term = "renal diet" }}', '<< 159033005 {{ term = "DIET" }}',
      '<< 159033005 {{ term = ("renal" "liver") }}', '<< 159033005 {{ term = wild:"*dietitian" }}', '<< 159033005 {{ term != "renal" }}',
      '<< 159033005 {{ term = "a" }}', '<< 159033005 {{ term = "dietitian", dialect = en-us }}', '<< 159033005 {{ dialect = en-us (prefer) }}',
      '<< 159033005 {{ dialect = en-gb }}', '<< 159033005 {{ term = "dietitian", language = en }}', '<< 159033005 {{ term = "dietitian", type = fsn }}',
      '<< 159033005 {{ term = "dietitian", active = true }}', '<< 159033005 {{ term = "dietitian", active = false }}',
      '<< 159033005 {{ D term = "dietitian" }} {{ D term = "renal" }}', '<< 138875005 {{ term = "dietitian" }}']) await same(e);
    expect((await same('<< 159033005 {{ term = "dietitian", dialect = en-us }}')).length).toBeGreaterThan(1);
    expect((await same('<< 159033005 {{ term = "dietitian" }}'))[0]).toBe('159033005');
  });

  test('compound ECL in cs-snomed.js\'s order', async () => {
    for (const e of ['<< 309413008 OR << 159033005', '<< 159033005 OR << 309413008', '<< 159033005 AND << 309413008', '<< 309413008 AND << 159033005',
      '<< 159033005 AND *', '* AND << 159033005', '<< 159033005 MINUS << 309413008', '<<! 159033005', '<< 159033005', '< 159033005',
      '(<< 159033005 {{ term = "renal" }}) OR (<< 159033005 {{ term = "liver" }})', '<< 159033005 MINUS (<< 159033005 {{ term = "renal" }})']) await same(e);
    expect((await same('<< 309413008 OR << 159033005'))[0]).toBe('309413008');
  });
});

describe('SNOMED CT ECL the engine hands to main\'s ECL (sct-main-ecl.js)', () => {
  test('evaluated by main\'s (async) ECL first, then compiled: the same codes as cs-snomed.js', async () => {
    const texts = ['< 404684003 : { [1..1] 363698007 = << 123037004 }', '< 404684003 : { [0..1] 363698007 = * }'];
    for (const text of texts) {
      const want = await same(text);
      expect([text, want.length > 0]).toEqual([text, true]);
      // the engine did not evaluate it: main's result is kept for the file
      expect(engine.store._mainEcl && engine.store._mainEcl.has(text)).toBe(true);
    }
  });

  test('an unknown concept in such ECL is reported as before (a filter error, at compile)', async () => {
    const p = await engine.build(op, []);
    const prep = await p.getPrepContext(true, null);
    await expect(p.filter(prep, true, 'constraint', '=', '< 404684003 : { [1..1] 363698007 = << 999999999999 }')).rejects.toThrow();
  });
});
