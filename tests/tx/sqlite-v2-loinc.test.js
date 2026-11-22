'use strict';

// LOINC on sqlite-v2: the importer (tx/importers/import-loinc-v2.module.js) and the LOINC
// dialect (tx/sqlite-v2/dialects.js) over the LOINC test fixture in tx/data/loinc, the one the
// classic tests use (tests/cs/cs-loinc.test.js). Each request runs twice through the real
// router: once on the sqlite-v2 file, once on main's provider (tx/cs/cs-loinc.js) over the same
// fixture; where main's answer is defined, the two must agree (as sets where order is not).
//
// The fixture gets two small additions in a temporary copy, so the cases have something to find:
// an externally defined answer list (a row with no AnswerStringId, as AnswerList.csv in 2.83 has
// 65 of) linked to a term, and a third-party copyright notice on one term.

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const Database = require('better-sqlite3');
const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');
const { importLoincV2 } = require('../../tx/importers/import-loinc-v2.module');
const { LoincDataMigrator } = require('../../tx/importers/import-loinc.module');
const { splitCsv } = require('../../tx/importers/sqlite-v2/text');
const { loadSqliteV2Factory } = require('../../tx/sqlite-v2');
const { LoincServicesFactory } = require('../../tx/cs/cs-loinc');
const { countingTracer } = require('./sqlite-v2-counting-tracer');
const { SqliteV2Provider } = require('../../tx/sqlite-v2/provider');

const L = 'http://loinc.org';
const SRC = path.resolve(__dirname, '../../tx/data/loinc');
const VERSION = '2.80-test';
const EXT_LIST = 'LL1892-0'; // externally defined: no answers
const COPYRIGHT_TERM = '595-9';

let app, tx, dir, v2, classic;

const q = (v) => '"' + String(v).replace(/"/g, '""') + '"';
const csvLine = (fields) => fields.map(q).join(',');

/** the fixture, with the two additions */
function buildFixture(dest) {
  fs.cpSync(SRC, dest, { recursive: true });
  const loinc = path.join(dest, 'LoincTable', 'Loinc.csv');
  const lines = fs.readFileSync(loinc, 'utf8').split(/\r?\n/);
  const header = splitCsv(lines[0]);
  const col = header.indexOf('EXTERNAL_COPYRIGHT_NOTICE');
  const k = lines.findIndex((l) => l.startsWith(q(COPYRIGHT_TERM) + ','));
  const row = splitCsv(lines[k]);
  row[col] = 'Copyright (c) A Third Party. Used by permission.';
  lines[k] = csvLine(row);
  fs.writeFileSync(loinc, lines.join('\n'));
  // AnswerListId, AnswerListName, AnswerListOID, ExtDefinedYN, ExtDefinedAnswerListCodeSystem,
  // ExtDefinedAnswerListLink, AnswerStringId, LocalAnswerCode, LocalAnswerCodeSystem, SequenceNumber,
  // DisplayText, ExtCodeId, ExtCodeDisplayName, ExtCodeSystem, ExtCodeSystemVersion,
  // ExtCodeSystemCopyrightNotice, SubsequentTextPrompt, Description, Score
  const answers = path.join(dest, 'AccessoryFiles', 'AnswerFile', 'AnswerList.csv');
  fs.writeFileSync(answers, fs.readFileSync(answers, 'utf8').replace(/\s*$/, '') + '\n' + csvLine([EXT_LIST, 'ICD-9_ICD-10', '1.3.6.1.4.1.12009.10.1.1892', 'Y', 'ICD-10', 'http://www.who.int/classifications/icd10',
    '', '', '', '', '', '', '', '', '', '', '', '', '']) + '\n');
  const links = path.join(dest, 'AccessoryFiles', 'AnswerFile', 'LoincAnswerListLink.csv');
  const body = fs.readFileSync(links, 'utf8').replace(/\s*$/, '');
  fs.writeFileSync(links, body + '\n' + csvLine(['10332-5', 'Cortisol', EXT_LIST, 'ICD-9_ICD-10', 'EXAMPLE', '']) + '\n');
}

/** serve http://loinc.org from this factory only */
function use(f) {
  const p = tx.endpoints[0].provider;
  for (const key of [...p.codeSystemFactories.keys()]) if (key === L || key.startsWith(L + '|')) p.codeSystemFactories.delete(key);
  p.codeSystemFactories.set(L, f);
  p.codeSystemFactories.set(L + '|' + f.version(), f);
  for (const e of tx.endpoints) e.expansionCache.clearAll();
}

/** the same request on both engines: { v2, classic } */
async function both(fn) {
  use(v2);
  const a = await fn('v2');
  use(classic);
  const b = await fn('classic');
  use(v2);
  return { v2: a, classic: b };
}

const vs = (include, exclude) => ({ resourceType: 'ValueSet', status: 'active', compose: Object.assign({ include }, exclude ? { exclude } : {}) });
const filterVs = (...filters) => vs([{ system: L, filter: filters.map(([property, op, value]) => ({ property, op, value })) }]);

function params(o) {
  const parameter = [];
  for (const [name, v] of Object.entries(o)) {
    if (name === 'valueSet') parameter.push({ name, resource: v });
    else if (Array.isArray(v)) for (const x of v) parameter.push({ name, valueString: x });
    else if (typeof v === 'number') parameter.push({ name, valueInteger: v });
    else if (typeof v === 'boolean') parameter.push({ name, valueBoolean: v });
    else if (name === 'url') parameter.push({ name, valueUri: v });
    else parameter.push({ name, valueString: v });
  }
  return { resourceType: 'Parameters', parameter };
}

async function expand(o) {
  const res = await request(app).post('/tx/r5/ValueSet/$expand').send(params(o));
  if (res.status !== 200) return { status: res.status, text: (res.body.issue || []).map((i) => i.details?.text || i.diagnostics).join('; ') };
  return res.body.expansion;
}
const codes = (e) => (e.contains || []).map((c) => c.code);
const sorted = (a) => [...a].sort();

/** a concept as listed: code, display, inactive, designations and properties, order-free */
function listed(c) {
  const val = (p) => p.valueCode ?? p.valueString ?? p.valueBoolean ?? p.valueInteger ?? (p.valueCoding && sortedJson(p.valueCoding));
  return [c.code, c.display || '', !!c.inactive,
    sorted((c.designation || []).map((d) => [d.language, d.use && d.use.code, d.value].join('|'))).join(';'),
    sorted((c.property || []).map((p) => p.code + '=' + val(p))).join(';')].join(' # ');
}
const sortedJson = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));

/** a Parameters body as an order-free list of name=value (parts flattened) */
function flatParams(body) {
  const val = (p) => p.valueCode ?? p.valueString ?? p.valueBoolean ?? p.valueInteger ?? p.valueUri ?? p.valueDecimal ??
    (p.valueCoding && sortedJson(p.valueCoding)) ?? (p.valueCodeableConcept && JSON.stringify(p.valueCodeableConcept));
  const one = (p) => p.part ? p.name + '(' + sorted(p.part.map(one)).join(',') + ')' : p.name + '=' + val(p);
  return sorted((body.parameter || []).map((p) => (p.resource ? p.name + ':' + JSON.stringify(p.resource.issue || p.resource) : one(p))));
}

beforeAll(async () => {
  app = await getTestApp();
  tx = getTxModule();
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-loinc-'));
  buildFixture(path.join(dir, 'src'));
  await importLoincV2({ source: path.join(dir, 'src'), dest: path.join(dir, 'v2.db'), version: VERSION, overwrite: true, log: () => {} });
  await new LoincDataMigrator().migrate(path.join(dir, 'src'), path.join(dir, 'classic.db'), VERSION, { verbose: false, mainOnly: false });
  v2 = await loadSqliteV2Factory(tx.i18n, path.join(dir, 'v2.db'));
  classic = new LoincServicesFactory(tx.i18n, path.join(dir, 'classic.db'));
  await classic.load();
  use(v2);
}, 180000);

afterAll(async () => {
  await shutdownTestApp();
  if (v2) v2.store.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the importer -------------------------------------------------------------------------

describe('LOINC v2 importer over the test fixture', () => {
  let db, cdb;
  beforeAll(() => {
    db = new Database(path.join(dir, 'v2.db'), { readonly: true });
    cdb = new Database(path.join(dir, 'classic.db'), { readonly: true });
  });
  afterAll(() => { db.close(); cdb.close(); });
  const id = (code) => db.prepare('SELECT id FROM concept WHERE code = ?').pluck().get(code);
  const links = (code, prop) => db.prepare(`SELECT t.code FROM link l JOIN concept s ON s.id = l.subject_id
    JOIN concept t ON t.id = l.target_id JOIN property p ON p.id = l.property_id WHERE s.code = ? AND p.code = ? ORDER BY t.code`).pluck().all(code, prop);

  test('every term, part, answer list, answer and hierarchy node once: the same codes as main', () => {
    const cs = db.prepare('SELECT * FROM code_system WHERE served = 1').get();
    // 322 terms + 147 parts + 4 answer lists (one externally defined) + 8 answers + 3 hierarchy-only nodes
    expect([cs.uri, cs.version, cs.concept_count, cs.active_count]).toEqual([L, VERSION, 484, 482]);
    const v2Codes = db.prepare('SELECT code FROM concept').pluck().all();
    const mainCodes = cdb.prepare('SELECT Code FROM Codes').pluck().all();
    expect(sorted(v2Codes)).toEqual(sorted(mainCodes));
    expect(new Set(v2Codes).size).toBe(v2Codes.length);
  });

  test('an externally defined answer list is a code with no answers, and no blank code (as main)', () => {
    expect(id('')).toBeUndefined();
    expect(cdb.prepare("SELECT count(*) FROM Codes WHERE Code = ''").pluck().get()).toBe(0);
    expect(db.prepare('SELECT display FROM concept WHERE code = ?').pluck().get(EXT_LIST)).toBe('ICD-9_ICD-10');
    expect(links(EXT_LIST, 'Answer')).toEqual([]);
    expect(links(EXT_LIST, 'answers-for')).toEqual(['10332-5']);
    // a list's members are its Answer links
    expect(db.prepare("SELECT count(*) FROM link WHERE subject_id = ? AND property_id = (SELECT id FROM property WHERE code = 'Answer')")
      .pluck().get(id(EXT_LIST))).toBe(0);
  });

  test('inactive iff DISCOURAGED; STATUS literal on terms and parts', () => {
    expect(db.prepare('SELECT code FROM concept WHERE active = 0 ORDER BY code').pluck().all()).toEqual(['22760-3', '42569-4']);
    const status = db.prepare(`SELECT l.value FROM literal l JOIN property p ON p.id = l.property_id
      WHERE l.subject_id = ? AND p.code = 'STATUS'`).pluck();
    expect(status.all(id('22760-3'))).toEqual(['DISCOURAGED']);
    expect(status.all(id('10550-2'))).toEqual(['DEPRECATED']);
    expect(status.all(id('LP7786-9'))).toEqual(['ACTIVE']);
  });

  test('properties: part links, literals, hierarchy and answer properties; the inverse and closure rows', () => {
    const defs = Object.fromEntries(db.prepare('SELECT code, shape, subsumption FROM property').all().map((r) => [r.code, [r.shape, r.subsumption]]));
    for (const p of ['COMPONENT', 'PROPERTY', 'TIME_ASPCT', 'SYSTEM', 'SCALE_TYP', 'METHOD_TYP', 'CLASS', 'Answer', 'answers-for']) expect(defs[p]).toEqual(['link', 0]);
    for (const p of ['CLASSTYPE', 'ORDER_OBS', 'EXAMPLE_UNITS', 'UNITSREQUIRED', 'Copyright', 'STATUS']) expect(defs[p]).toEqual(['literal', 0]);
    expect(defs.parent).toEqual(['link', 1]);
    const row = (code) => db.prepare('SELECT p.code, i.code AS inverse_of, p.filterable, p.ordered, p.n_rows FROM property p LEFT JOIN property i ON i.id = p.inverse_of WHERE p.code = ?').get(code);
    expect(row('child')).toEqual({ code: 'child', inverse_of: 'parent', filterable: 1, ordered: 0, n_rows: 0 });
    expect(row('AnswerList')).toEqual({ code: 'AnswerList', inverse_of: 'Answer|answers-for', filterable: 1, ordered: 0, n_rows: 0 });
    expect(db.prepare("SELECT c.code FROM property_member m JOIN property p ON p.id = m.parent_id JOIN property c ON c.id = m.child_id WHERE p.code = 'Answer|answers-for' ORDER BY c.code").pluck().all()).toEqual(['Answer', 'answers-for']);
    expect(row('Answer').ordered).toBe(1);
    expect(db.prepare("SELECT a.code FROM property h JOIN property a ON a.id = h.closure_from WHERE h.code = 'parent'").pluck().get()).toBe('ancestor');
    expect(db.prepare("SELECT value, display FROM value_label WHERE property_id = (SELECT id FROM property WHERE code = 'CLASSTYPE') ORDER BY value").raw().all())
      .toEqual([['1', 'Laboratory class'], ['2', 'Clinical class'], ['3', 'Claims attachment'], ['4', 'Surveys']]);
    // 10332-5: the six axes from LoincPartLink_Primary, CLASS from Loinc.csv
    const axes = Object.fromEntries(['COMPONENT', 'PROPERTY', 'TIME_ASPCT', 'SYSTEM', 'SCALE_TYP', 'CLASS'].map((p) => [p, links('10332-5', p)]));
    // (its CLASS, CHAL, has no CLASS part in the fixture: no link, as main)
    expect(axes).toEqual({ COMPONENT: ['LP305473-3'], PROPERTY: ['LP6827-2'], TIME_ASPCT: ['LP6960-1'], SYSTEM: ['LP7576-4'], SCALE_TYP: ['LP7753-9'], CLASS: [] });
    expect(links('6298-4', 'CLASS')).toEqual(['LP7786-9']);
    // the third-party notice, on that term only
    expect(db.prepare(`SELECT c.code FROM literal l JOIN concept c ON c.id = l.subject_id
      JOIN property p ON p.id = l.property_id WHERE p.code = 'Copyright' AND l.value != ''`).pluck().all()).toEqual([COPYRIGHT_TERM]);
  });

  test('answer lists: Answer links, members in SequenceNumber order, answers-for links', () => {
    expect(links('LL6136-7', 'Answer')).toEqual(['LA10105-7', 'LA32971-6', 'LA32972-4', 'LA9040-2']);
    // the SequenceNumber is the Answer link's seq
    const members = db.prepare(`SELECT c.code, l.seq FROM link l JOIN concept c ON c.id = l.target_id
      WHERE l.subject_id = ? AND l.property_id = (SELECT id FROM property WHERE code = 'Answer') ORDER BY l.seq`).raw().all(id('LL6136-7'));
    expect(members).toEqual([['LA32971-6', 1], ['LA32972-4', 2], ['LA9040-2', 3], ['LA10105-7', 4]]);
    expect(links('LL360-9', 'answers-for')).toEqual(['100041-3', '100865-5', '101448-9', '106016-9', '107188-5', '95675-5']);
  });

  test('hierarchy: parent links from IMMEDIATE_PARENT, ancestors from PATH_TO_ROOT', () => {
    expect(links('LP31398-8', 'parent')).toEqual(['LP7786-9']);
    // LP14355-9 is listed under two paths; one parent link (as main, cs-loinc.test.js)
    expect(links('LP14355-9', 'parent')).toEqual(['LP31398-8']);
  });

  test('designations: English names, consumer names, every linguistic variant language', () => {
    const langs = db.prepare('SELECT DISTINCT language FROM item ORDER BY language').pluck().all();
    const files = fs.readdirSync(path.join(SRC, 'AccessoryFiles', 'LinguisticVariants')).map((f) => /^([a-z]{2})([A-Z]{2})\d+LinguisticVariant/.exec(f)).filter(Boolean).map((m) => `${m[1]}-${m[2]}`);
    expect(files.length).toBeGreaterThan(10);
    expect(langs).toEqual(sorted(['en-US', ...files]));
    const uses = db.prepare(`SELECT DISTINCT u.code FROM item d JOIN item_use u ON u.use_id = d.use_id WHERE d.concept_id = ? ORDER BY u.code`).pluck().all(id('10332-5'));
    expect(uses).toEqual(expect.arrayContaining(['ConsumerName', 'LONG_COMMON_NAME', 'RELATEDNAMES2', 'SHORTNAME']));
  });

  test('numbering: concept ids, not main\'s CodeKey; active ids first, ancestors before descendants', () => {
    // the id is the builder's own numbering; main's CodeKey order is kept apart, in ix_order
    expect(db.prepare("SELECT count(*) FROM pragma_table_info('concept') WHERE name IN ('code_key', 'main_seq', 'seq')").pluck().get()).toBe(0);
    expect(db.prepare('SELECT max(id) FROM concept WHERE active = 1').pluck().get()).toBe(482);
    expect(db.prepare('SELECT min(id) FROM concept WHERE active = 0').pluck().get()).toBe(483);
    const bad = db.prepare(`SELECT count(*) FROM link l JOIN property p ON p.id = l.property_id
      JOIN concept s ON s.id = l.subject_id JOIN concept t ON t.id = l.target_id
      WHERE p.subsumption = 1 AND s.active = 1 AND t.active = 1 AND t.id >= s.id`).pluck().get();
    expect(bad).toBe(0);
  });

  // main's CodeKey order is kept as the ix_order arrays (derived-by-importer)
  test('ix_order ids: main\'s CodeKey order', () => {
    const { fromBlobs } = { fromBlobs: (name) => { const b = Buffer.concat(db.prepare('SELECT data FROM main.ix_order WHERE name = ? ORDER BY block').pluck().all(name)); return new Uint32Array(b.buffer, b.byteOffset, b.length / 4); } };
    const ids = fromBlobs('ids'), walk = fromBlobs('walk');
    const code = new Map(db.prepare('SELECT id, code FROM main.concept').raw().all());
    const main = cdb.prepare('SELECT Code FROM Codes ORDER BY CodeKey').pluck().all();
    expect([...ids].slice(0, main.length).map((i) => code.get(i))).toEqual(main);
    expect(new Set(walk).size).toBe(484);
  });

  test('ix_order: the answer orders are stored at import, and the provider reads them from the file', () => {
    const rows = new Map(db.prepare('SELECT name, CAST(group_concat(data, \'\' ORDER BY block) AS BLOB) FROM main.ix_order GROUP BY name').raw().all());
    // active: the walk's active concepts, stored as the DISCOURAGED terms are not at its end
    expect([...rows.keys()].filter((k) => !k.startsWith('hier')).sort()).toEqual(['active', 'ids', 'rank', 'walk']);
    const arr = (k) => { const b = rows.get(k); return [...new Uint32Array(b.buffer, b.byteOffset, b.length / 4)]; };
    expect(arr('active')).toEqual(arr('walk').filter((id) => id <= 482));
    const o = v2.engine._order;
    expect([o.stored, o.kind, o.selfFirst, o.hasWalk]).toEqual([true, 'stored', false, true]);
    expect([...o.rank]).toEqual(arr('rank'));
    expect([...o.ids]).toEqual(arr('ids'));
    expect([...o.walk]).toEqual(arr('walk'));
    expect(new Set(o.walk).size).toBe(484);
  });

});

// ---- the dialect, through the router, against main ----------------------------------------

describe('LOINC v2 dialect against main\'s provider (same fixture)', () => {
  test('the v2 run is served by the engine (one selection), the classic one is not', async () => {
    const sel = jest.spyOn(SqliteV2Provider.prototype, 'processSelection');
    try {
      const calls = [];
      const r = await both(async (arm) => { const before = sel.mock.calls.length; const e = await expand({ valueSet: filterVs(['CLASS', '=', 'CHEM']) }); calls.push([arm, sel.mock.calls.length - before]); return e; });
      expect(calls).toEqual([['v2', 1], ['classic', 0]]);
      expect(codes(r.v2)).toEqual(codes(r.classic));
    } finally { sel.mockRestore(); }
  });

  test('CodeSystem/x-loinc<version>: read and search give the same placeholder as main', async () => {
    const r = await both(async () => {
      const read = await request(app).get(`/tx/r5/CodeSystem/x-loinc${VERSION}`);
      const search = await request(app).get(`/tx/r5/CodeSystem?url=${encodeURIComponent(L)}`);
      const hits = (search.body.entry || []).map((e) => e.resource).filter((c) => c.url === L);
      return { status: read.status, read: read.body, search: hits.map((c) => ({ id: c.id, version: c.version, name: c.name })) };
    });
    expect(r.classic.status).toBe(200);
    expect(r.v2).toEqual(r.classic);
    expect(r.v2.read.id).toBe(`x-loinc${VERSION}`);
    expect(r.v2.search).toEqual([{ id: `x-loinc${VERSION}`, version: VERSION, name: 'LOINC' }]);
  });

  // [filter, expected count]: the same codes in the same order on both engines (main's key order)
  const FILTERS = [
    [['COMPONENT', '=', 'LP14082-9'], 209],
    [['COMPONENT', '=', 'Bacteria'], 209], // by the part's name
    [['COMPONENT', 'in', 'LP14082-9,LP15098-4'], 263],
    [['COMPONENT', 'regex', '.*Potassium.*'], 55],
    [['CLASS', '=', 'LP7786-9'], 64],
    [['CLASS', '=', 'CHEM'], 64],
    [['SCALE_TYP', '=', 'LP7753-9'], 25],
    [['METHOD_TYP', 'exists', 'true'], 24],
    [['SYSTEM', 'exists', 'false'], 431],
    [['STATUS', '=', 'DEPRECATED'], 7],
    [['STATUS', '=', 'TRIAL'], 2],
    [['STATUS', '=', 'DISCOURAGED'], 2],
    [['parent', '=', 'LP31398-8'], 3],
    [['ancestor', '=', 'LP7786-9'], 9],
    [['ancestor', 'in', 'LP7786-9,LP14082-9'], 13],
    [['concept', 'is-a', 'LP7786-9'], 10],
    [['concept', 'descendent-of', 'LP7786-9'], 9],
    [['code', 'is-a', 'LP31398-8'], 4],
    [['answers-for', '=', '100041-3'], 2], // a term: its lists' answers
    [['answers-for', '=', 'LL360-9'], 2], // a list: its answers
    [['answers-for', '=', '10332-5'], 0], // an externally defined list only
    [['LIST', '=', 'LL6136-7'], 4],
    [['LIST', '=', EXT_LIST], 0],
    [['copyright', '=', 'LOINC'], 483],
    [['copyright', '=', '3rdParty'], 1],
    [['ORDER_OBS', '=', 'Observation'], 48],
    [['CLASSTYPE', '=', '2'], 9],
    [['CLASSTYPE', '=', 'Clinical class'], 9],
    // in is the union of = each value (main since #386): a part name, a literal value, a CLASSTYPE number
    [['COMPONENT', 'in', 'Bacteria,LP15098-4'], 263],
    [['CLASSTYPE', 'in', '2,Clinical class'], 9],
    [['ORDER_OBS', 'in', 'Observation,Both'], 318],
    [['answers-for', 'in', '100041-3,LL360-9'], 2],
    [['CLASSTYPE', 'regex', 'Clin.*'], 9],
    [['child', '=', 'LP31398-8'], 1], // the parents of the part
    [['child', 'exists', 'true'], 14],
    [['STATUS', '=', 'NotStated'], 15], // main's status 0: lists, answers and parts with no status
    [['parent', 'regex', 'Bact.*'], 5],
  ];
  test.each(FILTERS)('$expand %j: %d codes, as main', async (f, n) => {
    const r = await both(() => expand({ valueSet: filterVs(f), count: 1000 }));
    expect(r.v2.status).toBeUndefined();
    expect(codes(r.v2)).toEqual(codes(r.classic));
    expect(r.v2.total ?? codes(r.v2).length).toBe(n);
    expect(codes(r.v2).length).toBe(n);
  });

  // a compose with a second system is not handed to the engine whole: expand.js iterates each
  // filter through the filter API, and the engine lists its members in the same order
  const GENDER = { system: 'http://hl7.org/fhir/administrative-gender', concept: [{ code: 'male' }] };
  test.each(FILTERS.filter(([, n]) => n > 1))('$expand %j beside another system: the same codes in the same order as main', async (f) => {
    const r = await both(() => expand({ valueSet: vs([{ system: L, filter: [{ property: f[0], op: f[1], value: f[2] }] }, GENDER]), count: 1000 }));
    expect(r.v2.status).toBeUndefined();
    expect(codes(r.v2)).toEqual(codes(r.classic));
    expect(codes(r.v2).slice(-1)).toEqual(['male']);
  });

  test('$expand: two filters intersect, an exclude subtracts (as main)', async () => {
    const two = await both(() => expand({ valueSet: filterVs(['CLASS', '=', 'CHEM'], ['SCALE_TYP', '=', 'LP7753-9']) }));
    expect(codes(two.v2)).toEqual(codes(two.classic));
    expect(codes(two.v2)).toHaveLength(10);
    const ex = await both(() => expand({ valueSet: vs([{ system: L, filter: [{ property: 'CLASS', op: '=', value: 'CHEM' }] }],
      [{ system: L, filter: [{ property: 'SCALE_TYP', op: '=', value: 'LP7753-9' }] }]) }));
    expect(sorted(codes(ex.v2))).toEqual(sorted(codes(ex.classic)));
    expect(codes(ex.v2)).toHaveLength(54);
  });

  test.each([
    [['COMPONENT', 'is-a', 'LP14082-9']], [['concept', 'not-in', '6298-4']], [['concept', 'generalizes', '6298-4']],
    [['concept', 'child-of', 'LP7786-9']], [['concept', 'regex', '62.*']], [['code', 'in', '6298-4']], [['STATUS', 'in', 'ACTIVE']],
    [['STATUS', '=', 'active']], [['display', '=', 'Potassium']], [['RELATEDNAMES2', '=', 'K']], [['COMPONENT', 'exists', 'maybe']],
  ])('$expand %j: a filter main does not support is refused, as main', async (f) => {
    const r = await both(() => expand({ valueSet: filterVs(f) }));
    expect(r.v2.status).toBeGreaterThanOrEqual(400);
    expect([r.v2.status, r.v2.text]).toEqual([r.classic.status, r.classic.text]);
  });

  test('$expand answer-list = [answer]: the lists the answer is in (UP-645, cs-loinc.test.js expectations)', async () => {
    for (const [value, want] of [['LA9040-2', ['LL6136-7']], ['LA6576-8', ['LL360-9']], ['LL6136-7', []], ['LA0000-0', []]]) {
      const r = await expand({ valueSet: filterVs(['answer-list', '=', value]) });
      expect(r.status).toBeUndefined();
      expect(sorted(codes(r))).toEqual(want);
    }
    const check = async (f, code) => {
      const res = await request(app).post('/tx/r5/ValueSet/$validate-code').send({ resourceType: 'Parameters', parameter: [
        { name: 'valueSet', resource: filterVs(f) }, { name: 'system', valueUri: L }, { name: 'code', valueCode: code }] });
      expect(res.status).toBe(200);
      return flatParams(res.body).includes('result=true');
    };
    expect(await check(['answer-list', '=', 'LA9040-2'], 'LL6136-7')).toBe(true);
    expect(await check(['answer-list', '=', 'LA9040-2'], 'LL360-9')).toBe(false);
  });

  test.each([
    [['LIST', '=', 'LL6136-7']], [['LIST', '=', 'LL360-9']], [['answers-for', '=', 'LL6136-7']], [['answers-for', '=', '100041-3']],
    [['AnswerList', '=', 'LL360-9']], [['AnswerList', '=', 'LL6136-7']],
  ])('$expand %j: the same codes in the same order as main', async (f) => {
    const r = await both(() => expand({ valueSet: filterVs(f), count: 1000 }));
    expect(r.v2.status).toBeUndefined();
    expect(codes(r.v2).length).toBeGreaterThan(0);
    expect(codes(r.v2)).toEqual(codes(r.classic));
  });

  test('$expand LIST = a code LOINC does not have: refused, as main', async () => {
    const r = await both(() => expand({ valueSet: filterVs(['LIST', '=', 'LL0000-0']) }));
    expect(r.v2.status).toBeGreaterThanOrEqual(400);
    expect(r.classic.status).toBe(r.v2.status);
  });

  test('$expand of an answer list\'s implicit value set: the list\'s order, as main', async () => {
    const r = await both(() => expand({ url: 'http://loinc.org/vs/LL6136-7' }));
    expect(codes(r.v2)).toEqual(['LA32971-6', 'LA32972-4', 'LA9040-2', 'LA10105-7']);
    expect(codes(r.v2)).toEqual(codes(r.classic));
  });

  test('$expand of a part\'s implicit value set: its descendants, as main', async () => {
    const r = await both(() => expand({ url: 'http://loinc.org/vs/LP7786-9' }));
    expect(codes(r.v2)).toEqual(codes(r.classic));
    expect(codes(r.v2)).toHaveLength(9);
    expect(codes(r.v2)).not.toContain('LP7786-9');
  });

  test('$expand displays, designations and properties, as main', async () => {
    for (const o of [
      { valueSet: filterVs(['CLASS', '=', 'CHEM']), displayLanguage: 'de-DE' },
      { valueSet: filterVs(['COMPONENT', '=', 'LP15098-4']), displayLanguage: 'nl-NL' },
      { valueSet: vs([{ system: L, concept: [{ code: '10332-5' }, { code: 'LP14355-9' }, { code: 'LA6576-8' }] }]), includeDesignations: true },
      { valueSet: vs([{ system: L, concept: [{ code: '10332-5' }, { code: '100041-3' }, { code: 'LP31398-8' }] }]),
        property: ['COMPONENT', 'CLASS', 'STATUS', 'answers-for', 'AnswerList', 'parent', 'child'] },
    ]) {
      const r = await both(() => expand(o));
      expect(sorted(r.v2.contains.map(listed))).toEqual(sorted(r.classic.contains.map(listed)));
    }
    const nl = await expand({ valueSet: filterVs(['COMPONENT', '=', 'LP15098-4']), displayLanguage: 'nl-NL' });
    expect(nl.contains.find((c) => c.code === '6298-4').display).toBe('Kalium [mol/volume] in bloed');
  });

  test('$expand text filter: the same matches in the same order as main', async () => {
    for (const filter of ['glucose', 'Bact', 'Kalium']) {
      const r = await both(() => expand({ url: 'http://loinc.org/vs', filter, count: 1000 }));
      expect(codes(r.v2)).toEqual(codes(r.classic));
    }
    expect(codes(await expand({ url: 'http://loinc.org/vs', filter: 'glucose' }))).toEqual(['LP14635-4', '104597-0']);
  });

  test('$expand text filter (#398): words in any order in one name, codes, stop words, one letter; ties in main\'s CodeKey order', async () => {
    let n = 0;
    for (const filter of ['k', 'a', 'mass', 'serum', 'blood', 'urine', 'ser', 'glucose serum', 'serum glucose', 'mass or moles', 'in', 'the',
      '2345', '2345-7', 'lp', 'la', 'b', 'hepatitis b', 'glucose [mass/volume]', 'qn', '-']) {
      const r = await both(() => expand({ url: 'http://loinc.org/vs', filter, count: 1000 }));
      expect([filter, codes(r.v2)]).toEqual([filter, codes(r.classic)]);
      n += codes(r.v2).length;
    }
    expect(n).toBeGreaterThan(0);
  });

  test('$expand text filter (#399): ranked as main ranks (TextQuery.nameRank of the best name, codeRank), ties by display (localeCompare)', async () => {
    for (const filter of ['glucose', 'serum glucose', 'glucose serum', 'urine calcium', 'calcium urine', 'mass serum', 'serum mass', 'la', 'lp',
      'gluc ser', 'bld', 'moles volume']) {
      const r = await both(() => expand({ url: 'http://loinc.org/vs', filter, count: 1000 }));
      expect([filter, codes(r.v2)]).toEqual([filter, codes(r.classic)]);
    }
  });

  test('$expand of an include filter on an unknown concept (#396): no codes, and the same expansion-issue warning as main', async () => {
    for (const [prop, op, value] of [['concept', 'is-a', 'LP0000-0'], ['concept', 'descendent-of', 'NOPE-1'], ['code', '=', 'NOPE-2'], ['concept', 'is-a', '2345-7'],
      ['concept', 'in', '6298-4,NOPE-3'], ['code', 'in', '10332-5, NOPE-4'], ['concept', 'in', '6298-4, 10332-5']]) {
      const body = async () => {
        const res = await request(app).post('/tx/r5/ValueSet/$expand').send(params({ valueSet: filterVs([prop, op, value]), count: 20 }));
        const oo = (res.body.contained || []).filter((c) => c.resourceType === 'OperationOutcome').flatMap((c) => c.issue.map((i) => [i.severity, i.details && i.details.text]));
        return { status: res.status, codes: codes(res.body.expansion || {}), oo };
      };
      const r = await both(body);
      expect([prop, op, value, r.v2]).toEqual([prop, op, value, r.classic]);
    }
  });

  test('processSelection takes a `concept in` list whose codes are all known, and leaves one with an unknown code to the usual path', async () => {
    const { OperationContext } = require('../../tx/operation-context');
    const p2 = await v2.build(new OperationContext('en', tx.i18n), []);
    const inc = (value) => [{ system: L, filter: [{ property: 'concept', op: 'in', value }] }];
    const known = await p2.processSelection(null, inc('6298-4, 10332-5'), [], false, -1, -1);
    expect(known).not.toBeNull();
    expect(known.total).toBe(2);
    expect(await p2.processSelection(null, inc('6298-4,NOPE-3'), [], false, -1, -1)).toBeNull();
  });

  test('$expand whole system: the same codes as main; activeOnly drops the DISCOURAGED terms', async () => {
    const all = await both(() => expand({ valueSet: vs([{ system: L }]), count: 1000 }));
    expect(all.v2.total).toBe(484);
    // main's order: expand.js's walk (by type, then CodeKey, each part followed by what is below
    // it: ix_order walk)
    expect(codes(all.v2)).toEqual(codes(all.classic));
    const act = await both(() => expand({ valueSet: vs([{ system: L }]), count: 1000, activeOnly: true }));
    expect(sorted(codes(act.v2))).toEqual(sorted(codes(act.classic)));
    expect(act.v2.total).toBe(482);
    expect(codes(act.v2)).not.toContain('22760-3');
    // count=0: the total only, the code system's size as main reports it (activeOnly does not change it)
    const n = await both(() => expand({ valueSet: vs([{ system: L }]), count: 0, activeOnly: true }));
    expect([n.v2.total, n.v2.contains]).toEqual([484, undefined]);
    expect(n.v2.total).toBe(n.classic.total);
  });

  test('$expand paging: every page is a slice of the full expansion, with the same total', async () => {
    const full = codes(await expand({ valueSet: vs([{ system: L }]), count: 1000 }));
    for (const [offset, count] of [[0, 10], [100, 20], [315, 15], [470, 50], [484, 5]]) {
      const page = await expand({ valueSet: vs([{ system: L }]), offset, count });
      expect([page.total, page.offset]).toEqual([484, offset]);
      expect(codes(page)).toEqual(full.slice(offset, offset + count));
    }
    const f = filterVs(['COMPONENT', '=', 'LP14082-9']);
    const fullF = codes(await expand({ valueSet: f, count: 1000 }));
    const pages = [];
    for (let offset = 0; offset < fullF.length; offset += 50) pages.push(...codes(await expand({ valueSet: f, offset, count: 50 })));
    expect(pages).toEqual(fullF);
  });

  const LOOKUP_CODES = ['10332-5', '100041-3', '22760-3', '62580-6', '10550-2', 'LP14355-9', 'LP7786-9', 'LP432695-7', 'LL360-9', EXT_LIST, 'LA6576-8'];
  test.each(LOOKUP_CODES)('$lookup %s: the same properties and designations as main', async (code) => {
    for (const extra of ['', '&property=*', '&displayLanguage=nl-NL']) {
      const r = await both(async () => {
        const res = await request(app).get(`/tx/r5/CodeSystem/$lookup?system=${L}&code=${code}${extra}`);
        expect(res.status).toBe(200);
        return flatParams(res.body);
      });
      expect(r.v2).toEqual(r.classic);
    }
  });

  test('$lookup 10332-5: part properties, literals and designations', async () => {
    const res = await request(app).get(`/tx/r5/CodeSystem/$lookup?system=${L}&code=10332-5&property=*`);
    const f = flatParams(res.body);
    expect(f).toEqual(expect.arrayContaining(['property(code=COMPONENT,description=Cortisol^pre 250 ug corticotropin IM,value=LP305473-3)', 'property(code=SCALE_TYP,description=Qn,value=LP7753-9)',
      'property(code=CLASSTYPE,description=Laboratory class,value=1)', 'property(code=UNITSREQUIRED,value=Y)', 'property(code=ORDER_OBS,value=Observation)',
      'property(code=STATUS,value=ACTIVE)', 'property(code=AnswerList,description=ICD-9_ICD-10,value=LL1892-0)', 'property(code=RELATEDNAMES2,language=nl-NL,value=adrenocorticotroop hormoon; adrenocorticotrofine; corticotrofine)']));
    expect(f.some((p) => p.startsWith('designation(') && p.includes('value=Cortis pre 250 ug ACTH IM SerPl-mCnc'))).toBe(true);
  });

  // a code-valued property carries the display of the code it names as its description (as main,
  // cs-loinc.test.js); CLASS stays a string property with the part code as partCode
  test('$lookup: code-valued properties have the named code\'s display as their description, as main', async () => {
    for (const [code, prop, value, description] of [['10332-5', 'COMPONENT', 'LP305473-3', 'Cortisol^pre 250 ug corticotropin IM'],
      ['LP14355-9', 'parent', 'LP31398-8', 'Renal function'], ['10332-5', 'AnswerList', 'LL1892-0', 'ICD-9_ICD-10']]) {
      const r = await both(async () => {
        const res = await request(app).get(`/tx/r5/CodeSystem/$lookup?system=${L}&code=${code}&property=${prop}`);
        return flatParams(res.body).filter((p) => p.startsWith('property('));
      });
      expect(r.v2).toEqual(r.classic);
      expect(r.v2).toContain(`property(code=${prop},description=${description},value=${value})`);
    }
  });

  const VALIDATE = [
    ['CodeSystem', `url=${L}&code=10332-5`],
    ['CodeSystem', `url=${L}&code=10332-5&display=Wrong`],
    ['CodeSystem', `url=${L}&code=10332-5&display=${encodeURIComponent('Cortis pre 250 ug ACTH IM SerPl-mCnc')}`],
    ['CodeSystem', `url=${L}&code=6298-4&display=${encodeURIComponent('Kalium [mol/volume] in bloed')}&displayLanguage=nl-NL`],
    ['CodeSystem', `url=${L}&code=nope-1`],
    ['CodeSystem', `url=${L}&code=22760-3`],
    ['CodeSystem', `url=${L}&code=LA6576-8&display=Positive`],
    ['CodeSystem', `url=${L}&code=${EXT_LIST}`],
    ['ValueSet', `url=${encodeURIComponent('http://loinc.org/vs/LL360-9')}&system=${L}&code=LA6576-8`],
    ['ValueSet', `url=${encodeURIComponent('http://loinc.org/vs/LL360-9')}&system=${L}&code=LA11882-0`],
    ['ValueSet', `url=${encodeURIComponent('http://loinc.org/vs/LP7786-9')}&system=${L}&code=6298-4`],
    ['ValueSet', `url=${encodeURIComponent('http://loinc.org/vs/LP7786-9')}&system=${L}&code=595-9`],
    ['ValueSet', `url=${encodeURIComponent('http://loinc.org/vs')}&system=${L}&code=22760-3&activeOnly=true`],
  ];
  test.each(VALIDATE)('%s/$validate-code?%s: as main', async (kind, query) => {
    const r = await both(async () => {
      const res = await request(app).get(`/tx/r5/${kind}/$validate-code?${query}`);
      expect(res.status).toBe(200);
      return flatParams(res.body);
    });
    expect(r.v2).toEqual(r.classic);
  });

  test('ValueSet/$validate-code against filters: in and out, as main', async () => {
    const check = async (f, code) => {
      const r = await both(async () => {
        const res = await request(app).post('/tx/r5/ValueSet/$validate-code').send({ resourceType: 'Parameters', parameter: [
          { name: 'valueSet', resource: filterVs(f) }, { name: 'system', valueUri: L }, { name: 'code', valueCode: code }] });
        expect(res.status).toBe(200);
        return flatParams(res.body);
      });
      expect(r.v2).toEqual(r.classic);
      return r.v2.includes('result=true');
    };
    expect(await check(['COMPONENT', '=', 'LP14082-9'], '595-9')).toBe(true);
    expect(await check(['COMPONENT', '=', 'LP14082-9'], '6298-4')).toBe(false);
    expect(await check(['answers-for', '=', '100041-3'], 'LA6576-8')).toBe(true);
    expect(await check(['ancestor', '=', 'LP7786-9'], 'LP7786-9')).toBe(false);
    expect(await check(['copyright', '=', '3rdParty'], COPYRIGHT_TERM)).toBe(true);
    expect(await check(['COMPONENT', 'regex', '.*Potassium.*'], '6298-4')).toBe(true);
  });

  test('$subsumes from the component hierarchy, as main', async () => {
    for (const [a, b, outcome] of [['LP7786-9', '6298-4', 'subsumes'], ['6298-4', 'LP7786-9', 'subsumed-by'], ['LP7786-9', 'LP7786-9', 'equivalent'],
      ['LP14082-9', '6298-4', 'not-subsumed'], ['LP15098-4', 'LP386601-1', 'subsumes']]) {
      const r = await both(async () => {
        const res = await request(app).get(`/tx/r5/CodeSystem/$subsumes?system=${L}&codeA=${a}&codeB=${b}`);
        return res.body.parameter;
      });
      expect(r.v2).toEqual([{ name: 'outcome', valueCode: outcome }]);
      expect(r.v2).toEqual(r.classic);
    }
  });

  test('$lookup properties in main\'s order (#385: relationships, properties, STATUS, RELATEDNAMES2, mappings), every term and answer', async () => {
    const { OperationContext } = require('../../tx/operation-context');
    const op = new OperationContext('en', tx.i18n);
    const p2 = await v2.build(op, []);
    const pc = await classic.build(op, []);
    // not the parts: a part's children are in id order here, in hierarchy-file order on main
    const codes = v2.store.db.prepare("SELECT code FROM concept WHERE code NOT LIKE 'LP%' ORDER BY id").pluck().all();
    let n = 0;
    for (const code of codes) {
      const c2 = (await p2.locate(code)).context;
      const cc = (await pc.locate(code)).context;
      if (!c2 || !cc) continue;
      for (const props of [[], ['*'], ['STATUS', 'COMPONENT', 'CLASSTYPE']]) {
        const a = [], b = [];
        await p2.extendLookup(c2, props, a);
        await pc.extendLookup(cc, props, b);
        expect([code, props, JSON.stringify(a)]).toEqual([code, props, JSON.stringify(b)]);
        n++;
      }
    }
    expect(n).toBeGreaterThan(100);
  });

  test('$lookup of every part in main\'s order: parent and child in its Relationships rows\' order (hierarchy-file order)', async () => {
    const { OperationContext } = require('../../tx/operation-context');
    const op = new OperationContext('en', tx.i18n);
    const p2 = await v2.build(op, []);
    const pc = await classic.build(op, []);
    const codes = v2.store.db.prepare("SELECT code FROM concept WHERE code LIKE 'LP%' ORDER BY id").pluck().all();
    let n = 0, withChildren = 0;
    for (const code of codes) {
      const c2 = (await p2.locate(code)).context;
      const cc = (await pc.locate(code)).context;
      if (!c2 || !cc) continue;
      for (const props of [[], ['*'], ['parent', 'child']]) {
        const a = [], b = [];
        await p2.extendLookup(c2, props, a);
        await pc.extendLookup(cc, props, b);
        expect([code, props, JSON.stringify(a)]).toEqual([code, props, JSON.stringify(b)]);
        if (props.length === 0 && a.filter((x) => x.part && x.part[0].valueCode === 'child').length > 1) withChildren++;
        n++;
      }
    }
    expect(n).toBeGreaterThan(100);
    expect(withChildren).toBeGreaterThan(3);
  });

  test('ancestorsOf: the same sets as main\'s (#388, the Closure table) for every code of the fixture', async () => {
    const { OperationContext } = require('../../tx/operation-context');
    const op = new OperationContext('en', tx.i18n);
    const p2 = await v2.build(op, []);
    const pc = await classic.build(op, []);
    const codes = v2.store.db.prepare('SELECT code FROM concept ORDER BY id').pluck().all();
    let withAncestors = 0;
    for (const code of codes) {
      const a2 = await p2.ancestorsOf(code);
      const ac = await pc.ancestorsOf(code);
      expect([code, a2 && [...a2].sort()]).toEqual([code, ac && [...ac].sort()]);
      if (a2 && a2.size) withAncestors++;
    }
    expect(withAncestors).toBeGreaterThan(10);
    expect(await p2.ancestorsOf('6298-4')).toEqual(expect.any(Set));
    expect((await p2.ancestorsOf('6298-4')).has('LP7786-9')).toBe(true);
    expect(await p2.ancestorsOf('nope')).toBeNull();
    expect(await p2.ancestorsOf('lp7786-9')).toBe(await pc.ancestorsOf('lp7786-9'));
  });

  test('ancestorsOf agrees with subsumesTest (CodeSystemProvider.ancestorsOf)', async () => {
    const { OperationContext } = require('../../tx/operation-context');
    const p2 = await v2.build(new OperationContext('en', tx.i18n), []);
    // the parts with children, and terms under them
    const parts = v2.store.db.prepare('SELECT c.code FROM concept c JOIN ix_set s ON s.value = c.id AND s.kind = 4 ORDER BY c.id LIMIT 40').pluck().all();
    const terms = ['6298-4', '595-9', 'LP386601-1', 'LP14082-9', 'LP15098-4', 'LA6576-8'];
    for (const b of [...parts, ...terms]) {
      const anc = await p2.ancestorsOf(b);
      for (const a of [...parts, ...terms]) {
        if (a !== b) expect([a, b, anc.has(a)]).toEqual([a, b, (await p2.subsumesTest(a, b)) === 'subsumes']);
      }
    }
  });
});

// ---- the provider filter API (the path an include takes in a multi-system compose) ---------

describe('LOINC v2 provider filter API against main\'s', () => {
  const { OperationContext } = require('../../tx/operation-context');
  let p2, pc;
  beforeAll(async () => {
    const op = new OperationContext('en', tx.i18n);
    p2 = await v2.build(op, []);
    pc = await classic.build(op, []);
  });

  test('designations of every code in main\'s order (a part\'s DisplayName before its PartName variants)', async () => {
    const { Designations } = require('../../tx/library/designations');
    const { OperationContext } = require('../../tx/operation-context');
    const op = new OperationContext('en', tx.i18n);
    const p = await v2.build(op, []);
    const pcl = await classic.build(new OperationContext('en', tx.i18n), []);
    const codes = v2.store.db.prepare('SELECT code FROM concept ORDER BY id').pluck().all();
    let n = 0, partsWithBoth = 0;
    for (const code of codes) {
      const a = (await p.locate(code)).context;
      const b = (await pcl.locate(code)).context;
      if (!a || !b) continue;
      const da = new Designations(op.i18n.languageDefinitions);
      const db = new Designations(op.i18n.languageDefinitions);
      await p.designations(a, da, true);
      await pcl.designations(b, db, true);
      const flat = (ds) => ds.designations.map((d) => [d.language && d.language.code, d.use && d.use.code, d.value]);
      expect([code, flat(da)]).toEqual([code, flat(db)]);
      const uses = flat(db).map((d) => d[1]);
      if (uses.includes('DisplayName') && uses.includes('PartName')) partsWithBoth++;
      n++;
    }
    expect(n).toBeGreaterThan(400);
    expect(partsWithBoth).toBeGreaterThan(5);
  });

  test('a prefetched list: status and designations as main, from three statements whatever the length', async () => {
    const { Designations } = require('../../tx/library/designations');
    const codes = ['10332-5', '100041-3', '22760-3', '62580-6', '10550-2', 'LP14355-9', 'LA6576-8', 'nope'];
    const op = new OperationContext('en', tx.i18n);
    const t = countingTracer();
    op.tracer = t;
    const p = await v2.build(op, []);
    const pcl = await classic.build(new OperationContext('en', tx.i18n), []);
    const h = await p.prefetchCodes(codes, true);
    const after = t.stats.statements;
    expect(after).toBe(3); // codes with rows, STATUS, designations (RELATEDNAMES2 left out)
    for (const code of codes) {
      const a = await p.locate(code, h);
      const b = await pcl.locate(code);
      expect(!!a.context).toBe(!!b.context);
      if (!a.context) continue;
      expect(await p.getStatus(a.context)).toBe(await pcl.getStatus(b.context));
      const da = new Designations(op.i18n.languageDefinitions);
      const db = new Designations(op.i18n.languageDefinitions);
      await p.designations(a.context, da, true);
      await pcl.designations(b.context, db, true);
      const flat = (ds) => ds.designations.map((d) => [d.language && d.language.code, d.use && d.use.code, d.value]).sort();
      expect(flat(da)).toEqual(flat(db));
    }
    expect(t.stats.statements).toBe(after);
    // $lookup still reports RELATEDNAMES2 for a prefetched concept
    const params = [];
    await p.extendLookup((await p.locate('10332-5', h)).context, ['RELATEDNAMES2'], params);
    expect(params.some((x) => x.part.some((q) => q.name === 'code' && q.valueCode === 'RELATEDNAMES2'))).toBe(true);
  });

  async function run(p, prop, opr, value) {
    const prep = await p.getPrepContext(true);
    await p.filter(prep, true, prop, opr, value);
    const [set] = await p.executeFilters(prep);
    const out = [];
    while (await p.filterMore(prep, set)) out.push(await p.code(await p.filterConcept(prep, set)));
    return { out, size: await p.filterSize(prep, set), prep, set };
  }

  test.each([
    ['COMPONENT', '=', 'LP14082-9'], ['CLASS', '=', 'CHEM'], ['SCALE_TYP', '=', 'LP7753-9'], ['STATUS', '=', 'DEPRECATED'],
    ['parent', '=', 'LP31398-8'], ['ancestor', 'in', 'LP7786-9,LP14082-9'], ['concept', 'is-a', 'LP7786-9'],
    ['answers-for', '=', '100041-3'], ['LIST', '=', 'LL6136-7'], ['copyright', '=', '3rdParty'], ['ORDER_OBS', '=', 'Observation'],
    ['COMPONENT', 'regex', '.*Potassium.*'],
  ])('%s %s %s: the same codes; locate and check agree', async (prop, opr, value) => {
    expect(await p2.doesFilter(prop, opr, value)).toBe(true);
    const a = await run(p2, prop, opr, value);
    const b = await run(pc, prop, opr, value);
    expect(sorted(a.out)).toEqual(sorted(b.out));
    expect(a.size).toBe(a.out.length);
    if (a.out.length) {
      const located = await p2.filterLocate(a.prep, a.set, a.out[0]);
      expect(await p2.code(located)).toBe(a.out[0]);
    }
    const outside = (await p2.locate('LP432695-7')).context;
    expect(!!(await p2.filterCheck(a.prep, a.set, outside))).toBe(a.out.includes('LP432695-7'));
  });
});
