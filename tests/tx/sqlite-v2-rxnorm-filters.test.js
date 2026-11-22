'use strict';

// RxNorm include filters on sqlite-v2 against main's provider (tx/cs/cs-rxnorm.js), both built
// from one small RRF fixture and run through the real router. Main takes `=` and `in` on TTY, STY
// and SAB (any case), on concept and code, and on a relationship (a REL or RELA that RXNREL has,
// from any source) whose values are all CUI:<rxcui> or AUI:<rxaui>. Anything else is a 422
// FILTER_NOT_UNDERSTOOD. A CUI: value follows RxNorm's own concept-level rows. An AUI: value
// main follows over the atom-level rows of every source; sqlite-v2 stores no atom-level rows and
// refuses it with the same 422 (a known difference).

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');
const { importRxNormV2 } = require('../../tx/importers/import-rxnorm-v2.module');
const { RxNormImporter } = require('../../tx/importers/import-rxnorm.module');
const { RxNormServicesFactory } = require('../../tx/cs/cs-rxnorm');
const { loadSqliteV2Factory } = require('../../tx/sqlite-v2');

const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const VERSION = '01012026';
let app, tx, dir, v2, classic;

// RXNCONSO: RXCUI|LAT|TS|LUI|STT|SUI|ISPREF|RXAUI|SAUI|SCUI|SDUI|SAB|TTY|CODE|STR|SRL|SUPPRESS|CVF
const conso = (cui, aui, sab, tty, str, sup = 'N') => [cui, 'ENG', '', '', '', '', '', aui, '', '', '', sab, tty, cui, str, '', sup, ''].join('|') + '|';
// RXNATOMARCHIVE: RXAUI|AUI|STR|ARCHIVE_TIMESTAMP|CREATED_TIMESTAMP|UPDATED_TIMESTAMP|CODE|IS_BRAND|LAT|
//                 LAST_RELEASED|SAUI|VSAB|RXCUI|SAB|TTY|MERGED_TO_RXCUI
const archive = (cui, aui, tty, str) => [aui, '', str, '', '', '', cui, '', 'ENG', '', '', '', cui, 'RXNORM', tty, ''].join('|') + '|';
// RXNREL: RXCUI1|RXAUI1|STYPE1|REL|RXCUI2|RXAUI2|STYPE2|RELA|RUI|SRUI|SAB|SL|RG|DIR|SUPPRESS|CVF
const cuiRel = (cui1, rel, cui2, rela, sab = 'RXNORM') => [cui1, '', 'CUI', rel, cui2, '', 'CUI', rela, '', '', sab, '', '', '', 'N', ''].join('|') + '|';
const auiRel = (aui1, rel, aui2, rela, sab) => ['', aui1, 'AUI', rel, '', aui2, 'AUI', rela, '', '', sab, '', '', '', '', ''].join('|') + '|';

function buildRrf(rrf) {
  fs.mkdirSync(rrf, { recursive: true });
  fs.writeFileSync(path.join(rrf, 'RXNCONSO.RRF'), [
    conso('100', '1001', 'RXNORM', 'SCD', 'drug a 10 MG Oral Tablet'),
    conso('100', '1003', 'MMSL', 'BD', 'drug a tablet (MMSL)'),
    conso('200', '2001', 'RXNORM', 'IN', 'ingredient b'),
    conso('200', '2002', 'MMSL', 'IN', 'ingredient b (MMSL)'),
    conso('300', '3001', 'RXNORM', 'SBD', 'brand c 10 MG Oral Tablet'),
    conso('300', '3002', 'MTHSPL', 'SU', 'brand c (SPL)'),
    conso('400', '4001', 'RXNORM', 'IN', 'ingredient d'),
    conso('500', '5001', 'MMSL', 'BD', 'not an RxNorm concept'),
    conso('90', '9001', 'RXNORM', 'SCD', 'drug e 5 MG Oral Tablet'), // before 100 by number, after it as text
    conso('600', '6001', 'RXNORM', 'SCD', 'obsolete drug f', 'O'),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(rrf, 'RXNREL.RRF'), [
    cuiRel('200', 'RO', '100', 'has_ingredient'), // 100 has_ingredient 200
    cuiRel('400', 'RO', '100', 'has_ingredient'), // 100 has_ingredient 400
    cuiRel('100', 'RB', '300', 'tradename_of'), // 300 tradename_of 100
    cuiRel('200', 'RO', '700', 'has_ingredient'), // the archived concept: never selected
    auiRel('2002', 'RO', '1003', 'has_ingredient', 'MMSL'), // atom 1003 (concept 100) has_ingredient atom 2002
    auiRel('3001', 'SY', '3002', '', 'RXNORM'), // atom-level SY row, no RELA
    auiRel('2002', 'RO', '3002', 'has_active_ingredient', 'MTHSPL'), // a RELA only atom-level rows have
    auiRel('2002', 'RO', '5001', 'has_active_ingredient', 'MTHSPL'), // to an atom of a concept RxNorm doesn't have
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(rrf, 'RXNSTY.RRF'), ['100|T200|||A|', '200|T121|||A|', '300|T200|||A|', '400|T121|||A|', '90|T200|||A|', '600|T200|||A|', '700|T200|||A|'].join('\n') + '\n');
  fs.writeFileSync(path.join(rrf, 'RXNATOMARCHIVE.RRF'), archive('700', '7001', 'SCD', 'archived drug g') + '\n');
}

/** serve RxNorm from this factory only */
function use(f) {
  const p = tx.endpoints[0].provider;
  for (const key of [...p.codeSystemFactories.keys()]) if (key === RX || key.startsWith(RX + '|')) p.codeSystemFactories.delete(key);
  p.codeSystemFactories.set(RX, f);
  p.codeSystemFactories.set(RX + '|' + f.version(), f);
  for (const e of tx.endpoints) e.expansionCache.clearAll();
}

async function expand(filters, { count = 100, inactive, activeOnly } = {}) {
  const include = filters ? { system: RX, filter: filters.map(([property, op, value]) => ({ property, op, value })) } : { system: RX };
  const valueSet = { resourceType: 'ValueSet', status: 'active', compose: Object.assign({ include: [include] }, inactive != null ? { inactive } : {}) };
  const parameter = [{ name: 'valueSet', resource: valueSet }, { name: 'count', valueInteger: count }];
  if (activeOnly != null) parameter.push({ name: 'activeOnly', valueBoolean: activeOnly });
  const res = await request(app).post('/tx/r5/ValueSet/$expand').send({ resourceType: 'Parameters', parameter });
  if (res.status !== 200) {
    const issues = (res.body.issue || []).map((i) => [i.severity, i.code, i.details && i.details.text,
      ((i.details && i.details.coding) || []).map((c) => c.code).join(','),
      ((i.extension || []).find((e) => /operationoutcome-message-id/.test(e.url)) || {}).valueString]);
    return { status: res.status, issues };
  }
  return { status: 200, codes: (res.body.expansion.contains || []).map((c) => c.code), total: res.body.expansion.total };
}

async function both(filters, opts) {
  use(v2);
  const a = await expand(filters, opts);
  use(classic);
  const b = await expand(filters, opts);
  use(v2);
  return { v2: a, main: b };
}

beforeAll(async () => {
  app = await getTestApp();
  tx = getTxModule();
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-rxfilters-'));
  const rrf = path.join(dir, 'rrf');
  buildRrf(rrf);
  await importRxNormV2({ source: rrf, dest: path.join(dir, 'rx.db'), version: VERSION, overwrite: true, log: () => {} });
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await new RxNormImporter(rrf, path.join(dir, 'rxnorm_' + VERSION + '.db'), VERSION, { verbose: false, createStems: true }).import();
  } finally { quiet.mockRestore(); }
  v2 = await loadSqliteV2Factory(tx.i18n, path.join(dir, 'rx.db'));
  classic = new RxNormServicesFactory(tx.i18n, path.join(dir, 'rxnorm_' + VERSION + '.db'));
  await classic.load();
  use(v2);
}, 120000);

afterAll(async () => {
  await shutdownTestApp();
  if (v2) v2.store.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const ACCEPTED = [
  [['TTY', '=', 'SCD']], [['TTY', 'in', 'SCD,IN']], [['tty', '=', 'IN']], [['STY', '=', 'T200']], [['SAB', '=', 'MMSL']],
  [['SAB', 'in', 'MMSL, MTHSPL']], [['concept', '=', '100']], [['concept', 'in', '100,200']], [['code', '=', '300']],
  [['has_ingredient', '=', 'CUI:200']], [['has_ingredient', 'in', 'CUI:200,CUI:400']], [['RO', '=', 'CUI:200']],
  [['RB', '=', 'CUI:100']], [['tradename_of', '=', 'CUI:100']],
  // a REL or RELA only atom-level rows have, with a CUI value: RxNorm's own rows have none of it
  [['has_active_ingredient', '=', 'CUI:200']], [['SY', '=', 'CUI:300']],
  [['TTY', '=', 'SCD'], ['has_ingredient', '=', 'CUI:200']],
];

const REFUSED = [
  [['TTY', 'regex', 'SC.*']], [['TTY', 'not-in', 'SCD']], [['TTY', 'exists', 'true']], [['STY', 'is-a', 'T200']],
  [['concept', 'is-a', '100']], [['concept', 'descendent-of', '100']], [['concept', 'regex', '1.*']], [['concept', 'not-in', '100']],
  [['display', 'regex', 'drug.*']], [['display', '=', 'ingredient b']],
  [['has_ingredient', '=', '200']], [['has_ingredient', 'in', 'CUI:200,400']], [['has_ingredient', 'exists', 'true']],
  [['has_ingredient', 'not-in', 'CUI:200']], [['has_ingredient', 'regex', 'CUI:.*']], [['RO', '=', '200']],
  [['XX', '=', 'CUI:1']], [['SUPPRESS', '=', 'N']], [['TTY', 'in', ' , ']],
  [['TTY', '=', 'SCD'], ['TTY', 'regex', 'S.*']],
];

// main follows these over the atom-level rows (200); sqlite-v2 refuses them
const AUI = [
  [['has_ingredient', '=', 'AUI:2002']], [['has_ingredient', 'in', 'CUI:400,AUI:2002']], [['has_ingredient', 'in', 'AUI:2002,CUI:400']],
  [['RO', '=', 'AUI:2002']], [['SY', '=', 'AUI:3001']], [['has_active_ingredient', '=', 'AUI:2002']], [['has_ingredient', '=', 'AUI:9999']],
];

const refusal = (filters) => {
  const [property, op, value] = filters[filters.length - 1];
  return { status: 422, issues: [['error', 'not-supported', `The filter "${property} ${op} ${value}" is not understood or supported`, 'vs-invalid', 'FILTER_NOT_UNDERSTOOD']] };
};

describe('sqlite-v2 RxNorm filters, as main', () => {
  test.each(ACCEPTED)('accepted: %j', async (...filters) => {
    const r = await both(filters);
    expect(r.main.status).toBe(200);
    expect(r.v2).toEqual(r.main);
  });

  test.each(REFUSED)('refused: %j', async (...filters) => {
    const r = await both(filters);
    expect(r.main.status).toBe(422);
    expect(r.main.issues.map((i) => i[4])).toContain('FILTER_NOT_UNDERSTOOD');
    expect(r.v2).toEqual(r.main);
  });

  test.each(AUI)('AUI: value, main follows atom-level rows, sqlite-v2 refuses: %j', async (...filters) => {
    const r = await both(filters);
    expect(r.main.status).toBe(200);
    expect(r.v2).toEqual(refusal(filters));
  });

  test.each([
    [{}], [{ count: 2 }], [{ count: 0 }], [{ count: 0, inactive: false }], [{ count: 0, activeOnly: true }], [{ activeOnly: true }], [{ inactive: false }],
  ])('the whole system %j: the same codes, order and total', async (opts) => {
    const r = await both(null, opts);
    expect(r.main.status).toBe(200);
    expect(r.v2).toEqual(r.main);
  });

  test('the whole system: obsolete concepts are counted and listed, archived ones never; RXCUI in text order', async () => {
    const r = await both(null, {});
    expect(r.main.codes).toEqual(['100', '200', '300', '400', '600', '90']);
    expect(r.main.total).toBe(6);
    expect((await both(null, { count: 0, inactive: false })).main.total).toBe(6);
  });

  test.each([[[['STY', '=', 'T200']]], [[['has_ingredient', '=', 'CUI:200']]], [[['TTY', 'in', 'SCD,SBD']]]])('the filter API (expand.js\'s usual path) %j: the codes of main, in its order', async (filters) => {
    const { OperationContext } = require('../../tx/operation-context');
    const op = new OperationContext('en', tx.i18n);
    const codesOf = async (f) => {
      const p = await f.build(op, []);
      const prep = await p.getPrepContext(true);
      for (const [prop, o, value] of filters) await p.filter(prep, true, prop, o, value);
      const [set] = await p.executeFilters(prep);
      const out = [];
      while (await p.filterMore(prep, set)) out.push(await p.code(await p.filterConcept(prep, set)));
      return out;
    };
    const want = await codesOf(classic);
    expect(want.length).toBeGreaterThan(0);
    expect(want).not.toContain('700');
    expect(await codesOf(v2)).toEqual(want);
  });

  test('the fixture finds something: CUI values, and (main only) AUI values over other sources\' rows', async () => {
    const r = async (f) => (await both([f])).main.codes;
    expect(await r(['has_ingredient', '=', 'CUI:200'])).toEqual(['100']);
    expect(await r(['has_ingredient', '=', 'AUI:2002'])).toEqual(['100']);
    expect(await r(['SY', '=', 'AUI:3001'])).toEqual(['300']);
    expect(await r(['has_active_ingredient', '=', 'AUI:2002'])).toEqual(['300']);
    expect(await r(['has_active_ingredient', '=', 'CUI:200'])).toEqual([]);
  });

  test('the default file holds no atom-level rows; the REL and RELA names of every source are catalog rows', () => {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(dir, 'rx.db'), { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) FROM property WHERE code LIKE 'AUI:%'").pluck().get()).toBe(0);
      expect(db.prepare('SELECT count(*) FROM identifier').pluck().get()).toBe(0);
      const rows = Object.fromEntries(db.prepare('SELECT code, shape, wildcard, n_rows FROM property').raw().all().map(([c, ...r]) => [c, r]));
      for (const rela of ['has_ingredient', 'has_active_ingredient', 'tradename_of']) expect(rows[rela]).toBeDefined();
      for (const rel of ['RO', 'RB', 'SY']) expect(rows[rel]).toBeDefined();
      // has_active_ingredient: only other sources' atom-level rows have it, so it selects nothing
      expect(rows.has_active_ingredient).toEqual(['link', 1, 0]);
    } finally { db.close(); }
  });
});
