'use strict';

// The CodeSystem id of each system the sqlite-v2 engine serves natively must be the one main's
// provider gives it (read.js and search.js serve it as CodeSystem/x-<id>, as tx.fhir.org does:
// x-loinc2.82, x-RxNorm-03022026, x-SCT-900000000000207008-20260701). First over the test fixtures,
// both engines loaded from the same release; then main's id() and the engine's over a table of
// versions, each called on a factory that has only its version (and edition) set.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');
const { LoincDataMigrator } = require('../../tx/importers/import-loinc.module');
const { importLoincV2 } = require('../../tx/importers/import-loinc-v2.module');
const { RxNormImporter } = require('../../tx/importers/import-rxnorm.module');
const { importRxNormV2 } = require('../../tx/importers/import-rxnorm-v2.module');
const { importSnomedV2FromCache } = require('../../tx/importers/import-sct-v2-cache.module');
const { LoincServicesFactory } = require('../../tx/cs/cs-loinc');
const { RxNormServicesFactory } = require('../../tx/cs/cs-rxnorm');
const { SnomedServicesFactory } = require('../../tx/cs/cs-snomed');
const { SqliteV2Factory } = require('../../tx/sqlite-v2/provider');
const { SnomedV2Factory } = require('../../tx/sqlite-v2/snomed');

const LOINC = 'http://loinc.org';
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const SCT = 'http://snomed.info/sct';
const DATA = path.resolve(__dirname, '../../tx/data');
const LOINC_VERSION = '2.80-test';
// main's importer writes no RXNVer, so main takes the version from the file name (rxnorm_<MMDDYYYY>.db)
const RXNORM_VERSION = '08242025';

let dir, op;
const loaded = {}; // system -> { main, v2 }

// The id needs only the version, so RxNorm comes from the first rows of each fixture file: the
// whole fixture (43 MB) took 12 of this setup's 15 s alone, and over jest's hook limit when the
// tx suites run in parallel. Both importers read the same trimmed copy.
const RXNORM_ROWS = 2000;
function trimmedRxNorm(dest) {
  fs.mkdirSync(dest);
  for (const f of fs.readdirSync(path.join(DATA, 'rxnorm'))) {
    if (!f.endsWith('.RRF')) continue;
    const text = fs.readFileSync(path.join(DATA, 'rxnorm', f), 'utf8');
    let end = 0;
    for (let k = 0; k < RXNORM_ROWS && end >= 0; k++) end = text.indexOf('\n', end + 1);
    fs.writeFileSync(path.join(dest, f), end < 0 ? text : text.slice(0, end + 1));
  }
  return dest;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-cs-ids-'));
  op = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
  const rxnorm = trimmedRxNorm(path.join(dir, 'rxnorm-src'));
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await new LoincDataMigrator().migrate(path.join(DATA, 'loinc'), path.join(dir, 'loinc-classic.db'), LOINC_VERSION, { verbose: false, mainOnly: false });
    await new RxNormImporter(rxnorm, path.join(dir, 'rxnorm_' + RXNORM_VERSION + '.db'), RXNORM_VERSION, { verbose: false, createStems: true }).import();
  } finally { quiet.mockRestore(); }
  await importLoincV2({ source: path.join(DATA, 'loinc'), dest: path.join(dir, 'loinc.db'), version: LOINC_VERSION, overwrite: true, log: () => {} });
  await importRxNormV2({ source: rxnorm, dest: path.join(dir, 'rxnorm.db'), version: RXNORM_VERSION, overwrite: true, log: () => {} });
  // an old-format cache (no modules, no definition status): enough for the version, which is all
  // this needs
  await importSnomedV2FromCache({ source: path.join(DATA, 'snomed-testing.cache'), dest: path.join(dir, 'sct.db'), overwrite: true, force: true, log: () => {} });

  const load = async (f) => { await f.load(); return f; };
  loaded[LOINC] = { main: await load(new LoincServicesFactory(op.i18n, path.join(dir, 'loinc-classic.db'))), v2: await load(new SqliteV2Factory(op.i18n, path.join(dir, 'loinc.db'))) };
  loaded[RXNORM] = { main: await load(new RxNormServicesFactory(op.i18n, path.join(dir, 'rxnorm_' + RXNORM_VERSION + '.db'))), v2: await load(new SqliteV2Factory(op.i18n, path.join(dir, 'rxnorm.db'))) };
  loaded[SCT] = { main: await load(new SnomedServicesFactory(op.i18n, path.join(DATA, 'snomed-testing.cache'))), v2: await load(new SnomedV2Factory(op.i18n, path.join(dir, 'sct.db'))) };
}, 180000);

afterAll(() => {
  for (const { main, v2 } of Object.values(loaded)) {
    for (const f of [main, v2]) { try { if (f.close) f.close(); else if (f.store) f.store.close(); } catch { /* closing only */ } }
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('over the test fixtures, the same release on both engines', () => {
  test.each([
    [LOINC, 'loinc2.80-test'],
    [RXNORM, 'RxNorm-08242025'],
    [SCT, 'xSCT-31000003106-20250909'] // the fixture is a test edition (snomed.info/xsct): see SnomedV2Factory.id()
  ])('%s', (system, id) => {
    const { main, v2 } = loaded[system];
    expect(v2.system()).toBe(main.system());
    expect(v2.version()).toBe(main.version());
    expect(v2.id()).toBe(main.id());
    expect(main.id()).toBe(id);
  });
});

describe('main\'s id() and the engine\'s, over a table of versions', () => {
  // a factory of each class with only what id() reads: the version, and for RxNorm the name
  const mainLoinc = (v) => Object.assign(Object.create(LoincServicesFactory.prototype), { _sharedData: { _version: v } });
  const mainRxNorm = (v) => Object.assign(Object.create(RxNormServicesFactory.prototype), { isNCI: false, _sharedData: { version: v } });
  const mainSct = (v, edition) => Object.assign(Object.create(SnomedServicesFactory.prototype), { _sharedData: { versionUri: v, edition } });
  const v2 = (cls, system, version, cs = {}) => Object.assign(Object.create(cls.prototype), { store: { system, version, cs } });

  test.each(['2.77', '2.78', '2.81', '2.82', '2.83', '2.80-test'])('LOINC %s', (v) => {
    expect(v2(SqliteV2Factory, LOINC, v).id()).toBe(mainLoinc(v).id());
    expect(v2(SqliteV2Factory, LOINC, v).id()).toBe('loinc' + v);
  });

  test.each(['03022026', '11042024', '01012026'])('RxNorm %s', (v) => {
    expect(v2(SqliteV2Factory, RXNORM, v).id()).toBe(mainRxNorm(v).id());
    expect(v2(SqliteV2Factory, RXNORM, v).id()).toBe('RxNorm-' + v);
  });

  test.each([
    ['900000000000207008', 'http://snomed.info/sct/900000000000207008/version/20260701'], // International
    ['731000124108', 'http://snomed.info/sct/731000124108/version/20250901'], // US
    ['83821000000107', 'http://snomed.info/sct/83821000000107/version/20251001'], // UK
    ['11000172109', 'http://snomed.info/sct/11000172109/version/20251115'], // Belgium
    ['900000000000207008', 'http://snomed.info/sct/900000000000207008'], // no version: no id
    ['31000003106', 'http://snomed.info/xsct/31000003106/version/20250909'], // test edition
    ['11010000107', 'http://snomed.info/sct/11010000107/version/20261021'], // LOINC extension: not in the edition list
    ['900000000000207008', 'http://snomed.info/xsct/900000000000207008/version/20250814'],
    ['31000003106', 'http://snomed.info/xsct/31000003106'] // undated test edition: no id, as for sct
  ])('SNOMED CT %s %s', (edition, v) => {
    const engine = v2(SnomedV2Factory, SCT, v, { edition });
    expect(engine.id()).toBe(mainSct(v, edition).id());
    // the placeholder's name too (search and read show it): 'SCT Unknown Edition' for an unlisted edition
    expect(engine.name()).toBe(mainSct(v, edition).name());
  });

  test('two dated test editions have different ids', () => {
    const a = v2(SnomedV2Factory, SCT, 'http://snomed.info/xsct/31000003106/version/20250909', { edition: '31000003106' });
    const b = v2(SnomedV2Factory, SCT, 'http://snomed.info/xsct/31000003106/version/20240909', { edition: '31000003106' });
    expect(a.id()).toBe('xSCT-31000003106-20250909');
    expect(a.id()).not.toBe(b.id());
  });
});
