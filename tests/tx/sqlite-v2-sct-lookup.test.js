'use strict';

// SNOMED CT on sqlite-v2: $lookup properties and implicit value set urls as main reports them
// (cs-snomed.js after #331), and main's ECL over the file seeing active relationships only.
// Test edition: the RF2 in tx/data/snomed.

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
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-sct-lookup-'));
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


async function lookup(code, props) {
  const p = await factory.build(op, []);
  const r = await p.locate(code);
  const params = [];
  await p.extendLookup(r.context, props, params);
  const out = {};
  for (const x of params) {
    const c = x.part.find((pp) => pp.name === 'code').valueCode;
    const v = x.part.find((pp) => pp.name === 'value');
    (out[c] = out[c] || []).push(v.valueCode ?? v.valueString ?? v.valueBoolean ?? v.valueInteger ?? v.valueDecimal ?? v.valueDateTime);
  }
  return out;
}

describe('sqlite-v2 SNOMED CT $lookup and implicit value sets, as main', () => {
  test('moduleId by default; module asked for by name is answered as moduleId', async () => {
    const all = await lookup('40468003', []);
    expect(all.moduleId).toEqual(['900000000000207008']);
    expect(all.module).toBeUndefined();
    expect(all.semanticTag).toBeUndefined();
    expect(all.normalForm).toBeUndefined();
    expect(await lookup('40468003', ['module'])).toEqual({ moduleId: ['900000000000207008'] });
  });

  test('property=* adds sufficientlyDefined and semanticTag, not the normal forms', async () => {
    const all = await lookup('40468003', ['*']);
    expect(all.sufficientlyDefined).toEqual([true]);
    expect(all.semanticTag).toEqual(['disorder']);
    expect(all.normalForm).toBeUndefined();
  });

  test('the normal forms, by name', async () => {
    const nf = await lookup('40468003', ['normalForm', 'normalFormTerse']);
    expect(nf.normalFormTerse).toEqual(['64572001:{116676008=409774005,246075003=32452004,363698007=10200004,370135005=441862004}']);
    expect(nf.normalForm[0]).toMatch(/^64572001\|Disease\|:\{116676008\|Associated morphology\|=409774005\|/);
  });

  test('implicit value set urls: generic, edition (sct or the version\'s own base) and version forms', async () => {
    expect(factory.implicitValueSetForm('http://snomed.info/sct?fhir_vs=isa/16763008').form).toBe('generic');
    expect(factory.implicitValueSetForm('http://snomed.info/sct/31000003106?fhir_vs=isa/16763008').form).toBe('edition');
    expect(factory.implicitValueSetForm('http://snomed.info/xsct/31000003106?fhir_vs=isa/16763008').form).toBe('edition');
    expect(factory.implicitValueSetForm('http://snomed.info/sct/31000003106/version/20250909?fhir_vs').form).toBe('version');
    expect(factory.implicitValueSetForm('http://snomed.info/sct/900000000000207008?fhir_vs')).toBeNull();
    const vs = await factory.buildKnownValueSet('http://snomed.info/sct/31000003106?fhir_vs=isa/16763008', null);
    expect(vs.compose.include[0].version).toBe('http://snomed.info/xsct/31000003106/version/20250909');
    const generic = await factory.buildKnownValueSet('http://snomed.info/sct?fhir_vs=isa/16763008', null);
    expect(generic.compose.include[0].version).toBeUndefined();
  });

  test('$expand properties: no property definitions (no uris), and each code\'s properties in main\'s order', async () => {
    // main's SNOMED CT provider declares no property definitions, so expansion.property has codes
    // and no uris. The HL7 tester sorts expansion.property by uri (absent first), then code: a
    // uri here would order the definitions differently from the expected response
    // (snomed-expand-property)
    const p = await factory.build(op, []);
    expect(p.propertyDefinitions()).toBeNull();
    const r = await p.locate('51292008');
    const props = await p.properties(r.context, ['moduleId', 'sufficientlyDefined', '363698007']);
    expect(props.map((x) => x.code)).toEqual(['moduleId', 'sufficientlyDefined', '363698007', '363698007']);
    expect(props.filter((x) => x.code === '363698007').map((x) => x.valueCode)).toEqual(['10200004', '64033007']);
  });

  test('main\'s ECL over the file: refinements see the relationships', async () => {
    const { evaluateEcl } = require('../../tx/sqlite-v2/sct-main-ecl');
    const bm = await evaluateEcl(factory.store, '< 64572001 : 363698007 = << 10200004', null);
    expect(bm.size).toBeGreaterThan(0);
  });
});

describe('sqlite-v2 SNOMED CT designation rank (v5)', () => {
  test('the stored rank orders designations as acceptability does (files without it)', async () => {
    const { Designations } = require('../../tx/library/designations');
    const S = factory.store;
    expect(S.hasRank).toBe(true);
    const ids = S.db.prepare('SELECT DISTINCT concept_id FROM designation ORDER BY concept_id').pluck().all();
    const run = async (significant) => {
      const out = [];
      for (const id of ids) {
        const p = await factory.build(op, []);
        const r = await p.locate(S.db.prepare('SELECT code FROM concept WHERE concept_id = ?').pluck().get(id));
        const d = new Designations(op.i18n.languageDefinitions);
        await p.designations(r.context, d, significant);
        out.push(d.designations.map((x) => [x.language && x.language.code, x.use && x.use.code, x.value]));
      }
      return out;
    };
    for (const significant of [false, true]) {
      const ranked = await run(significant);
      S.hasRank = false; // as a v4 file: acceptability per designation
      try {
        expect(await run(significant)).toEqual(ranked);
      } finally {
        S.hasRank = true;
      }
    }
  });
});
