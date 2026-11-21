'use strict';

// sqlite-v2 RxNorm concept status, as cs-rxnorm.js: a concept whose display atom is
// SUPPRESS = O is inactive with status 'obsolete' (still selected by filters and whole-system
// includes, not deprecated); one found only in RXNATOMARCHIVE is inactive, 'archived' and
// deprecated, and never selected.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { importRxNormV2 } = require('../../tx/importers/import-rxnorm-v2.module');
const { V2Store } = require('../../tx/sqlite-v2/store');
const { Engine } = require('../../tx/sqlite-v2/engine/engine');
const { Compiler } = require('../../tx/sqlite-v2/engine/compile');
const { dialectFor } = require('../../tx/sqlite-v2/dialects');

const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';
let dir, db;

// RXNCONSO: RXCUI|LAT|TS|LUI|STT|SUI|ISPREF|RXAUI|SAUI|SCUI|SDUI|SAB|TTY|CODE|STR|SRL|SUPPRESS|CVF
const conso = (cui, aui, sab, tty, str, sup) => [cui, 'ENG', '', '', '', '', '', aui, '', '', '', sab, tty, cui, str, '', sup, ''].join('|');
// RXNATOMARCHIVE: RXAUI|AUI|STR|ARCHIVE_TIMESTAMP|CREATED_TIMESTAMP|UPDATED_TIMESTAMP|CODE|IS_BRAND|LAT|
//                 LAST_RELEASED|SAUI|VSAB|RXCUI|SAB|TTY|MERGED_TO_RXCUI
const archive = (cui, aui, tty, str) => [aui, '', str, '', '', '', cui, '', 'ENG', '', '', '', cui, 'RXNORM', tty, ''].join('|');

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-rxstatus-'));
  const rrf = path.join(dir, 'rrf');
  fs.mkdirSync(rrf);
  fs.writeFileSync(path.join(rrf, 'RXNCONSO.RRF'), [
    conso('100', 'A1', 'RXNORM', 'SCD', 'current drug', 'N'),
    conso('200', 'A2', 'RXNORM', 'SCD', 'obsolete drug', 'O'),
    conso('200', 'A3', 'RXNORM', 'SY', 'obsolete synonym', 'N'), // SY: never the display atom
    conso('300', 'A4', 'RXNORM', 'PSN', 'prescribable name', 'O'), // ranked after the SCD atom
    conso('300', 'A5', 'RXNORM', 'SCD', 'current by display atom', 'N'),
    conso('100', 'A6', 'MMSL', 'BD', 'other source, obsolete', 'O'), // other sources do not count
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(rrf, 'RXNATOMARCHIVE.RRF'), archive('400', 'A7', 'SCD', 'archived drug') + '\n');
  fs.writeFileSync(path.join(rrf, 'RXNREL.RRF'), '');
  fs.writeFileSync(path.join(rrf, 'RXNSTY.RRF'), ['100', '200', '300'].map((c) => `${c}|T200|||A|`).join('\n') + '\n');
  db = path.join(dir, 'rx.db');
  await importRxNormV2({ source: rrf, dest: db, version: '01012026', overwrite: true, log: () => {} });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('sqlite-v2 RxNorm obsolete and archived concepts', () => {
  test('selection: filters and the whole system take obsolete concepts, never archived ones', () => {
    const S = new V2Store(db);
    try {
      const run = (includes, activeOnly = false) => {
        const c = new Compiler({ store: S, dialect: dialectFor(S.system) });
        const r = new Engine(S).run(c.selection(includes, [], activeOnly), { offset: 0, count: -1 });
        const rows = S.conceptRows(r.page(0, -1));
        return [...rows.values()].map((x) => x.code).sort();
      };
      expect(run([{ system: RX }])).toEqual(['100', '200', '300']);
      expect(run([{ system: RX }], true)).toEqual(['100', '300']);
      expect(run([{ system: RX, filter: [{ property: 'TTY', op: '=', value: 'SCD' }] }])).toEqual(['100', '200', '300']);
      expect(run([{ system: RX, filter: [{ property: 'STY', op: '=', value: 'T200' }] }], true)).toEqual(['100', '300']);
    } finally {
      S.close();
    }
  });

  test('provider: inactive, status and deprecation as cs-rxnorm.js', async () => {
    const { OperationContext } = require('../../tx/operation-context');
    const { TestUtilities } = require('../test-utilities');
    const { SqliteV2Factory } = require('../../tx/sqlite-v2/provider');
    const op = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    const factory = new SqliteV2Factory(op.i18n, db);
    await factory.load();
    try {
      const p = await factory.build(op, []);
      const facts = async (code) => {
        const ctx = (await p.locate(code)).context;
        return [await p.isInactive(ctx), await p.getStatus(ctx), await p.isDeprecated(ctx)];
      };
      expect(await facts('100')).toEqual([false, null, false]);
      expect(await facts('200')).toEqual([true, 'obsolete', false]);
      expect(await facts('300')).toEqual([false, null, false]);
      expect(await facts('400')).toEqual([true, 'archived', true]);
      const all = await p.iteratorAll();
      expect(all.total).toBe(3);
    } finally {
      factory.store.close();
    }
  });
});
