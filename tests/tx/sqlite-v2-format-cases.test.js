'use strict';

// Cases the terminology file answers through the generic reader paths (catalog shapes), over the
// real router:
//   1. a SNOMED CT description id (item external_id): as a code it is an unknown code, the same
//      answer as any other unknown concept id; ECL {{ D id = ... }} selects its concept
//   2. a property with links and literals (shape 'both'): `1142139005 = 1` (main: 500 "Invalid
//      concept ID: 1") selects the concepts whose concrete value is 1, `1142139005 = <code>` the
//      concepts linked to that code
//   3. a reference set with members that are descriptions: ^ R and `concept in R` project them to
//      their concepts; member filters apply to the description rows
//   4. RxNorm atom-level relationships (importer option atomRelationships): REL / RELA = AUI:x,
//      as main's cs-rxnorm.js answers them from the same RRF; refused (422) without them

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');
const { importSnomedV2 } = require('../../tx/importers/import-sct-v2.module');
const { importRxNormV2 } = require('../../tx/importers/import-rxnorm-v2.module');
const { RxNormImporter } = require('../../tx/importers/import-rxnorm.module');
const { RxNormServicesFactory } = require('../../tx/cs/cs-rxnorm');
const { loadSqliteV2Factory } = require('../../tx/sqlite-v2');

const SCT = 'http://snomed.info/sct';
const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const SRC = path.resolve(__dirname, '../../tx/data/snomed');
const COUNT_OF_BASE = '1142139005'; // concrete #1 on 776168003, 329238006, 779430005, 1204474000 (the fixture)
const SOURCE = '329238006', TARGET = '776168003';
const DESCRIPTION = '3761854015'; // 329238006 |Halibut liver oil 4000 unit oral capsule|
const REFSET = '723264001'; // a simple refset of the fixture (concept members)
let app, tx, dir, sct, rx, rxAtoms, classic;

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
function mergeSnapshot(src, dst) {
  const groups = new Map();
  for (const f of walk(src)) {
    if (!f.endsWith('.txt') || /Readme|license/i.test(f)) continue;
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

// RxNorm fixture (as tests/tx/sqlite-v2-rxnorm-filters.test.js)
const conso = (cui, aui, sab, tty, str, sup = 'N') => [cui, 'ENG', '', '', '', '', '', aui, '', '', '', sab, tty, cui, str, '', sup, ''].join('|') + '|';
const cuiRel = (cui1, rel, cui2, rela, sab = 'RXNORM') => [cui1, '', 'CUI', rel, cui2, '', 'CUI', rela, '', '', sab, '', '', '', 'N', ''].join('|') + '|';
const auiRel = (aui1, rel, aui2, rela, sab) => ['', aui1, 'AUI', rel, '', aui2, 'AUI', rela, '', '', sab, '', '', '', '', ''].join('|') + '|';
function buildRrf(rrf) {
  fs.mkdirSync(rrf, { recursive: true });
  fs.writeFileSync(path.join(rrf, 'RXNCONSO.RRF'), [
    conso('100', '1001', 'RXNORM', 'SCD', 'drug a 10 MG Oral Tablet'), conso('100', '1003', 'MMSL', 'BD', 'drug a tablet (MMSL)'),
    conso('100', '1004', 'RXNORM', 'SY', 'drug a tablet'),
    conso('200', '2001', 'RXNORM', 'IN', 'ingredient b'), conso('200', '2002', 'MMSL', 'IN', 'ingredient b (MMSL)'),
    conso('300', '3001', 'RXNORM', 'SBD', 'brand c 10 MG Oral Tablet'), conso('300', '3002', 'MTHSPL', 'SU', 'brand c (SPL)'),
    conso('400', '4001', 'RXNORM', 'IN', 'ingredient d'), conso('500', '5001', 'MMSL', 'BD', 'not an RxNorm concept'),
    conso('90', '9001', 'RXNORM', 'SCD', 'drug e 5 MG Oral Tablet'), conso('600', '6001', 'RXNORM', 'SCD', 'obsolete drug f', 'O'),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(rrf, 'RXNREL.RRF'), [
    cuiRel('200', 'RO', '100', 'has_ingredient'), cuiRel('400', 'RO', '100', 'has_ingredient'), cuiRel('100', 'RB', '300', 'tradename_of'),
    auiRel('2002', 'RO', '1003', 'has_ingredient', 'MMSL'), // atom 1003 (concept 100) has_ingredient atom 2002 (of 200)
    auiRel('3001', 'SY', '3002', '', 'RXNORM'), // an RxNorm atom-level SY row, no RELA
    auiRel('1001', 'SY', '1004', '', 'RXNORM'), // between two RxNorm atoms of 100
    auiRel('2002', 'RO', '3002', 'has_active_ingredient', 'MTHSPL'),
    auiRel('2002', 'RO', '5001', 'has_active_ingredient', 'MTHSPL'), // to an atom of a concept RxNorm doesn't have
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(rrf, 'RXNSTY.RRF'), ['100|T200|||A|', '200|T121|||A|', '300|T200|||A|', '400|T121|||A|', '90|T200|||A|', '600|T200|||A|'].join('\n') + '\n');
}

function use(system, f) {
  const p = tx.endpoints[0].provider;
  for (const key of [...p.codeSystemFactories.keys()]) if (key === system || key.startsWith(system + '|')) p.codeSystemFactories.delete(key);
  p.codeSystemFactories.set(system, f);
  p.codeSystemFactories.set(system + '|' + f.version(), f);
  for (const e of tx.endpoints) e.expansionCache.clearAll();
}

async function expand(system, filters, count = 1000) {
  const include = { system, filter: filters.map(([property, op, value]) => ({ property, op, value })) };
  const res = await request(app).post('/tx/r5/ValueSet/$expand').send({ resourceType: 'Parameters', parameter: [
    { name: 'valueSet', resource: { resourceType: 'ValueSet', status: 'active', compose: { include: [include] } } }, { name: 'count', valueInteger: count }] });
  if (res.status !== 200) return { status: res.status, text: (res.body.issue || []).map((i) => i.details && i.details.text).join(' | ') };
  return { status: 200, codes: (res.body.expansion.contains || []).map((c) => c.code).sort() };
}

const ecl = (text) => expand(SCT, [['constraint', '=', text]]);

beforeAll(async () => {
  app = await getTestApp();
  tx = getTxModule();
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-gaps-'));
  const snap = path.join(dir, 'Snapshot');
  mergeSnapshot(SRC, snap);
  // 2: an active relationship typed by the concrete attribute (the property has links and literals)
  const relFile = walk(snap).find((f) => /sct2_Relationship_Snapshot_/.test(path.basename(f)));
  fs.appendFileSync(relFile, ['9990021000003127', '20250909', '1', '31000003106', SOURCE, TARGET, '0', COUNT_OF_BASE,
    '900000000000011006', '900000000000451002'].join('\t') + '\n');
  // 3: a description as a member of the simple refset (its other members are concepts)
  const simple = walk(snap).find((f) => /der2_Refset_SimpleSnapshot_/.test(path.basename(f)));
  fs.appendFileSync(simple, ['e1b5c3d6-0000-4000-8000-000000000001', '20250909', '1', '31000003106', REFSET, DESCRIPTION].join('\t') + '\n');
  await importSnomedV2({ source: snap, dest: path.join(dir, 'sct.db'), edition: '31000003106', version: '20250909', overwrite: true, normalForms: false, log: () => {} });
  sct = await loadSqliteV2Factory(tx.i18n, path.join(dir, 'sct.db'));
  // 4: RxNorm, the default build and one with the atom-level relationships
  const rrf = path.join(dir, 'rrf');
  buildRrf(rrf);
  await importRxNormV2({ source: rrf, dest: path.join(dir, 'rx.db'), version: '01012026', overwrite: true, log: () => {} });
  await importRxNormV2({ source: rrf, dest: path.join(dir, 'rx-atoms.db'), version: '01012026', overwrite: true, atomRelationships: true, log: () => {} });
  rx = await loadSqliteV2Factory(tx.i18n, path.join(dir, 'rx.db'));
  rxAtoms = await loadSqliteV2Factory(tx.i18n, path.join(dir, 'rx-atoms.db'));
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await new RxNormImporter(rrf, path.join(dir, 'rxnorm_01012026.db'), '01012026', { verbose: false, createStems: true }).import();
  } finally { quiet.mockRestore(); }
  classic = new RxNormServicesFactory(tx.i18n, path.join(dir, 'rxnorm_01012026.db'));
  await classic.load();
  use(SCT, sct);
}, 240000);

afterAll(async () => {
  await shutdownTestApp();
  for (const f of [sct, rx, rxAtoms]) if (f) f.store.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('1. SNOMED CT description ids', () => {
  test('$validate-code and $lookup of a description id: the answer for any unknown concept id', async () => {
    use(SCT, sct);
    // the same requests with a concept id the edition does not have; main (cs-snomed.js locate)
    // gives an unknown concept id no message of its own, whatever the id is
    const UNKNOWN = '99999999999';
    const answers = async (code) => {
      const cs = await request(app).get(`/tx/r5/CodeSystem/$validate-code?url=${encodeURIComponent(SCT)}&code=${code}`);
      const vs = await request(app).post('/tx/r5/ValueSet/$validate-code').send({ resourceType: 'Parameters', parameter: [
        { name: 'valueSet', resource: { resourceType: 'ValueSet', status: 'active', compose: { include: [{ system: SCT }] } } },
        { name: 'coding', valueCoding: { system: SCT, code } }] });
      const l = await request(app).get(`/tx/r5/CodeSystem/$lookup?system=${encodeURIComponent(SCT)}&code=${code}`);
      return JSON.stringify([cs.status, cs.body, vs.status, vs.body, l.status, l.body]).split(code).join('<code>');
    };
    const d = await answers(DESCRIPTION);
    expect(d).toBe(await answers(UNKNOWN));
    expect(d).not.toContain('description id');
    // a concept id is as before
    const c = await request(app).get(`/tx/r5/CodeSystem/$validate-code?url=${encodeURIComponent(SCT)}&code=${SOURCE}`);
    expect(c.body.parameter.find((p) => p.name === 'result').valueBoolean).toBe(true);
  });

  test('ECL {{ D id = ... }}: the concept of that description, with the block\'s other filters on the same description', async () => {
    expect(await ecl(`* {{ D id = ${DESCRIPTION} }}`)).toEqual({ status: 200, codes: [SOURCE] });
    expect(await ecl(`* {{ D id = ${DESCRIPTION}, term = "halibut" }}`)).toEqual({ status: 200, codes: [SOURCE] });
    // the description is a synonym, not an FSN
    expect(await ecl(`* {{ D id = ${DESCRIPTION}, type = fsn }}`)).toEqual({ status: 200, codes: [] });
    expect(await ecl(`* {{ D id = (${DESCRIPTION} 3732533010) }}`)).toEqual({ status: 200, codes: [SOURCE, TARGET].sort() });
    expect(await ecl('* {{ D id = 999999999999019 }}')).toEqual({ status: 200, codes: [] });
  });
});

describe('2. a property with links and literals', () => {
  test('the catalog row is shape both', () => {
    expect(sct.store.filterProp(COUNT_OF_BASE).shape).toBe('both');
  });

  test(`${COUNT_OF_BASE} = 1: the concepts whose concrete value is 1 (main: 500 Invalid concept ID: 1)`, async () => {
    const r = await expand(SCT, [[COUNT_OF_BASE, '=', '1']]);
    expect(r.status).toBe(200);
    expect(r.codes).toEqual(expect.arrayContaining([SOURCE, TARGET, '779430005', '1204474000']));
    expect(await expand(SCT, [[COUNT_OF_BASE, '=', '#1']])).toEqual(r);
    expect(await expand(SCT, [[COUNT_OF_BASE, '=', '7']])).toEqual({ status: 200, codes: [] });
  });

  test(`${COUNT_OF_BASE} = <a code>: the concepts linked to it`, async () => {
    expect(await expand(SCT, [[COUNT_OF_BASE, '=', TARGET]])).toEqual({ status: 200, codes: [SOURCE] });
  });

  test('ECL: a concrete value and a concept value on the same attribute', async () => {
    const lits = await ecl(`* : ${COUNT_OF_BASE} = #1`);
    expect(lits.codes).toEqual(expect.arrayContaining([SOURCE, TARGET]));
    expect(await ecl(`* : ${COUNT_OF_BASE} = ${TARGET}`)).toEqual({ status: 200, codes: [SOURCE] });
  });
});

describe('3. a reference set with description members', () => {
  test('^ R and concept in R: the concept members and the concepts of the description members', async () => {
    const members = sct.store.getSet(7, 0, sct.store.idOf(REFSET));
    expect(members.has(sct.store.idOf(SOURCE))).toBe(true); // projected from the description row
    const r = await ecl(`^ ${REFSET}`);
    expect(r.codes).toContain(SOURCE);
    expect(r.codes).toContain('302525009'); // a concept member
    expect(await expand(SCT, [['concept', 'in', REFSET]])).toEqual(r);
  });

  test('member filters apply to the description row, then project', async () => {
    expect(await ecl(`^ ${REFSET} {{ M moduleId = 31000003106 }}`)).toEqual({ status: 200, codes: [SOURCE] });
  });
});

describe('4. RxNorm atom-level relationships (importer option atomRelationships)', () => {
  const AUI = [
    [['has_ingredient', '=', 'AUI:2002']], [['has_ingredient', 'in', 'CUI:400,AUI:2002']], [['RO', '=', 'AUI:2002']],
    [['SY', '=', 'AUI:3001']], [['SY', '=', 'AUI:1001']], [['has_active_ingredient', '=', 'AUI:2002']], [['has_ingredient', '=', 'AUI:9999']],
  ];
  const run = async (f, filters) => { use(RX, f); try { return await expand(RX, filters); } finally { use(SCT, sct); } };

  test.each(AUI)('every source\'s atom rows: as main (cs-rxnorm.js) %j', async (...filters) => {
    const want = await run(classic, filters);
    expect(want.status).toBe(200);
    expect(await run(rxAtoms, filters)).toEqual(want);
  });

  test('the statements: value RXAUI1 -> the concept of RXAUI2, one per row under its (REL, RELA) pair; no other source\'s atom is an item', () => {
    const db = rxAtoms.store.db;
    const rows = db.prepare(`SELECT p.code, i.value, c.code FROM identifier i JOIN property p ON p.id = i.property_id JOIN concept c ON c.id = i.subject_id
      ORDER BY 1, 2, 3`).raw().all();
    // 2002 -> 5001 (concept 500, no RxNorm atom) is left out; values are stored as integers
    expect(rows).toEqual([['AUI:RO:has_active_ingredient', 2002, '300'], ['AUI:RO:has_ingredient', 2002, '100'], ['AUI:SY:', 1001, '100'], ['AUI:SY:', 3001, '300']]);
    const members = db.prepare(`SELECT u.code, group_concat(m.code, ',' ORDER BY m.code) FROM property_member x JOIN property u ON u.id = x.parent_id JOIN property m ON m.id = x.child_id
      WHERE u.code LIKE 'AUI:%' GROUP BY u.code ORDER BY u.code`).raw().all();
    expect(members).toEqual([['AUI:RO', 'AUI:RO:has_active_ingredient,AUI:RO:has_ingredient'], ['AUI:SY', 'AUI:SY:'],
      ['AUI:has_active_ingredient', 'AUI:RO:has_active_ingredient'], ['AUI:has_ingredient', 'AUI:RO:has_ingredient']]);
    expect(db.prepare("SELECT count(*) FROM item WHERE external_id IN ('1003', '2002', '3002')").pluck().get()).toBe(0);
  });

  test('the default build has no atom rows: AUI: values are refused (422), CUI: values answered as main', async () => {
    expect(rx.store.hasAtomRelationships).toBe(false);
    const r = await run(rx, AUI[0]);
    expect(r.status).toBe(422);
    expect(await run(rx, [['has_ingredient', '=', 'CUI:200']])).toEqual(await run(classic, [['has_ingredient', '=', 'CUI:200']]));
    expect(await run(rxAtoms, [['has_ingredient', '=', 'CUI:200']])).toEqual(await run(classic, [['has_ingredient', '=', 'CUI:200']]));
  });
});
