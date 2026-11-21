'use strict';

// SNOMED CT on sqlite-v2: post-coordination (tx/sqlite-v2/sct-native.js) - an expression is located,
// rendered, checked against the MRCM and subsumed as main does, from the file - and ECL the engine
// refuses, run by main's ECL over the file (tx/sqlite-v2/sct-main-ecl.js). Test edition: the RF2 in tx/data/snomed.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { importSnomedV2 } = require('../../tx/importers/import-sct-v2.module');
const { SnomedV2Factory } = require('../../tx/sqlite-v2/snomed');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');

const SRC = path.resolve(__dirname, '../../tx/data/snomed');
let dir, factory, op;

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
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-sct-postcoord-'));
  mergeSnapshot(SRC, path.join(dir, 'Snapshot'));
  await importSnomedV2({ source: path.join(dir, 'Snapshot'), dest: path.join(dir, 'test.db'), edition: '31000003106', version: '20250909',
    versionUri: 'http://snomed.info/xsct/31000003106/version/20250909', overwrite: true, log: () => {} });
  op = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
  factory = new SnomedV2Factory(op.i18n, path.join(dir, 'test.db'));
  await factory.load();
}, 120000);

afterAll(() => {
  if (factory) factory.store.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('sqlite-v2 SNOMED CT post-coordination (native) and ECL fallback', () => {
  test('an expression is located and displayed as main renders it', async () => {
    const p = await factory.build(op, []);
    const r = await p.locate('128241005:{363698007=181268008}');
    expect(r.context).toBeTruthy();
    expect(await p.display(r.context)).toBe('128241005|Inflammatory disease of liver|:{363698007|Finding site|=181268008|Entire liver|}');
  });

  test('a refinement never breaks a stated is-a; plain concepts still use the engine', async () => {
    const p = await factory.build(op, []);
    expect(await p.subsumesTest('40468003:{363698007=181268008}', '3738000')).toBe('subsumed-by');
    expect(await p.subsumesTest('3738000', '40468003')).toBe('subsumes');
  });

  test('the MRCM is applied: an attribute outside its domain is reported', async () => {
    const p = await factory.build(op, []);
    const r = await p.locate('367430006:{42752001=789750003}');
    expect(r.context).toBeNull();
    expect(r.message).toMatch(/does not allow the attribute 42752001 \|Due to\| on 367430006/);
  });

  test('ECL the engine does not evaluate itself is evaluated by main over the file', async () => {
    const p = await factory.build(op, []);
    const ids = async (ecl) => {
      const prep = await p.getPrepContext(true);
      await p.filter(prep, true, 'constraint', '=', ecl);
      const [set] = await p.executeFilters(prep);
      return set.bm.size;
    };
    // group cardinality [0..0]: clinical findings with no finding site at all
    const none = await ids('< 404684003 : [0..0] { 363698007 = * }');
    const some = await ids('< 404684003 : [1..*] { 363698007 = * }');
    const all = await ids('< 404684003');
    expect(none + some).toBe(all);
  });

  test('a concept filter naming a concept the edition lacks is a 400 invalid, not a 500', async () => {
    const p = await factory.build(op, []);
    for (const [prop, o, v] of [['concept', 'in', '41000147108'], ['code', 'in', '3738000,61231000210108'], ['concept', 'is-a', '584021000052104'], ['concept', 'descendent-of', '99999999']]) {
      const prep = await p.getPrepContext(true);
      const err = await p.filter(prep, true, prop, o, v).then(() => null, (e) => e);
      expect(err).toBeTruthy();
      expect(err.statusCode).toBe(400);
      expect(err.isSetForhandleAsOO).toBe(true);
      expect(err.asIssue()).toMatchObject({ severity: 'error', code: 'invalid' });
      expect(err.message).toBe(`The SNOMED CT Concept ${v.split(',').pop()} is not known`);
    }
  });

  test('mapped:<scheme> exists: concepts with (or without) an alternate identifier', async () => {
    const p = await factory.build(op, []);
    const count = async (v) => {
      const prep = await p.getPrepContext(true);
      await p.filter(prep, true, 'mapped:30051010000102', 'exists', v);
      const [set] = await p.executeFilters(prep);
      return set.bm.size;
    };
    const yes = await count('true');
    expect(yes).toBeGreaterThan(0);
    expect(yes + (await count('false'))).toBe(factory.store.conceptCount);
  });

  test('refset members keep effectiveTime, module and RF2 order; ECL member filters use them natively', async () => {
    const S = factory.store;
    const meta = S.stmt('SELECT count(*) AS n, count(effective_time) AS t, count(module_id) AS m FROM refset_member').get();
    expect(meta.n).toBeGreaterThan(0);
    expect(meta.t).toBe(meta.n);
    expect(meta.m).toBe(meta.n);
    const p = await factory.build(op, []);
    const size = async (ecl) => {
      const prep = await p.getPrepContext(true);
      await p.filter(prep, true, 'constraint', '=', ecl);
      const [set] = await p.executeFilters(prep);
      return set.bm.size;
    };
    const all = await size('^ 900000000000526001');
    const after = await size('^ 900000000000526001 {{ M effectiveTime >= "20240101" }}');
    const before = await size('^ 900000000000526001 {{ M effectiveTime < "20240101" }}');
    expect(all).toBeGreaterThan(0);
    expect(after + before).toBeGreaterThanOrEqual(all);
    expect(after).toBeLessThanOrEqual(all);
  });

  test('expressions: locate, display, MRCM, subsumption, stored normal forms', async () => {
    const p = await factory.build(op, []);
    const r = await p.locate('128241005:{363698007=181268008}');
    expect(await p.display(r.context)).toBe('128241005|Inflammatory disease of liver|:{363698007|Finding site|=181268008|Entire liver|}');
    expect(await p.subsumesTest('40468003:{363698007=181268008}', '3738000')).toBe('subsumed-by');
    const bad = await p.locate('367430006:{42752001=789750003}');
    expect(bad.message).toMatch(/does not allow the attribute 42752001 \|Due to\| on 367430006/);
    const nf = factory.store.stmt('SELECT count(*) AS n FROM concept_normal_form').get().n;
    expect(nf).toBeGreaterThan(100);
  });

  test('ancestorsOf agrees with subsumesTest for plain concept ids; expressions and other spellings get null', async () => {
    const p = await factory.build(op, []);
    const all = factory.store.stmt('SELECT code FROM concept ORDER BY concept_id').pluck().all();
    const codes = [...new Set([...all.filter((c, i) => i % 40 === 0), '3738000', '40468003', '128241005', '138875005'])];
    let related = 0;
    for (const b of codes) {
      const anc = await p.ancestorsOf(b);
      expect(anc).toBeInstanceOf(Set);
      for (const a of codes) {
        if (a === b) continue;
        const s = (await p.subsumesTest(a, b)) === 'subsumes';
        if (s) related++;
        expect([a, b, anc.has(a)]).toEqual([a, b, s]);
      }
    }
    expect(related).toBeGreaterThan(20);
    expect((await p.ancestorsOf('40468003')).has('3738000')).toBe(true);
    expect(await p.ancestorsOf('40468003:{363698007=181268008}')).toBeNull();
    expect(await p.ancestorsOf('40468003|Viral hepatitis, type A|')).toBeNull();
    expect(await p.ancestorsOf(' 40468003')).toBeNull();
    expect(await p.ancestorsOf('999999999')).toBeNull();
  });
});
