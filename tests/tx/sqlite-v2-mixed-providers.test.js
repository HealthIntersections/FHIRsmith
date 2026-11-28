'use strict';

// Mixed value sets: a sqlite-v2 (engine-backed) code system next to providers that run their own
// code (UCUM, BCP-47) and a FHIR CodeSystem resource, through the real router. A compose of more
// than one system takes expand.js's usual path: the v2 include goes through the provider's filter
// API, on the engine; the other includes stay on their own providers. These are the cases where
// the engine and main gave the same answers on a library with SNOMED CT and LOINC on sqlite-v2
// (a small v2 fixture here).

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');
const { TerminologyBuilder } = require('../../tx/importers/sqlite-v2/builder');
const { loadSqliteV2Factory } = require('../../tx/sqlite-v2');
const { UcumService } = require('../../tx/library/ucum-service');
const { UcumCodeSystemFactory } = require('../../tx/cs/cs-ucum');
const { IETFLanguageCodeFactory } = require('../../tx/cs/cs-lang');
const ValueSet = require('../../tx/library/valueset');

const V2 = 'http://example.org/fhir/CodeSystem/v2-mixed';
const UCUM = 'http://unitsofmeasure.org';
const BCP47 = 'urn:ietf:bcp:47';
const FHIRCS = 'http://example.org/fhir/CodeSystem/mixed-resource';
const EXPAND = '/tx/r5/ValueSet/$expand';
const VALIDATE = '/tx/r5/ValueSet/$validate-code';

// root ─┬─ A ─┬─ A1
//       │     ├─ A2 (inactive)
//       │     └─ A3
//       └─ B ─── B1
function buildV2(dest) {
  const b = new TerminologyBuilder(dest, { overwrite: true, importer: 'test' });
  b.codeSystem({ uri: V2, version: '1' });
  const isa = b.property({ code: 'parent', shape: 'link', subsumption: true });
  const c = {};
  for (const code of ['root', 'A', 'A1', 'A2', 'A3', 'B', 'B1']) {
    c[code] = b.concept(code, { active: code !== 'A2', display: `display ${code}` });
  }
  for (const [ch, pa] of [['A', 'root'], ['B', 'root'], ['A1', 'A'], ['A2', 'A'], ['A3', 'A'], ['B1', 'B']]) b.link(c[ch], isa, c[pa]);
  b.item(c.A1, { language: 'de', text: 'Anzeige A1' });
  b.finish();
}

// a v2 system that is not closed (compositional, as SNOMED CT is: post-coordination), and a
// supplement that defines a property on it
const V2OPEN = 'http://example.org/fhir/CodeSystem/v2-open';
function buildV2Open(dest) {
  const b = new TerminologyBuilder(dest, { overwrite: true, importer: 'test' });
  b.codeSystem({ uri: V2OPEN, version: '1', compositional: true });
  const isa = b.property({ code: 'parent', shape: 'link', subsumption: true });
  const c = {};
  for (const code of ['X', 'X1', 'X2', 'X3']) c[code] = b.concept(code, { active: true, display: `display ${code}` });
  for (const ch of ['X1', 'X2', 'X3']) b.link(c[ch], isa, c.X);
  b.finish();
}
const SUPP_TIER = {
  resourceType: 'CodeSystem', url: 'http://example.org/fhir/CodeSystem/v2-open-tier', version: '1', status: 'active',
  content: 'supplement', supplements: V2OPEN, property: [{ code: 'tier', type: 'string' }],
  concept: [{ code: 'X3', property: [{ code: 'tier', valueString: 'gold' }] }, { code: 'X1', property: [{ code: 'tier', valueString: 'gold' }] },
    { code: 'X2', property: [{ code: 'tier', valueString: 'silver' }] }]
};

// a FHIR CodeSystem resource with a hierarchy, a retired concept and a property to filter on
const FHIR_CS = {
  resourceType: 'CodeSystem', url: FHIRCS, version: '1', status: 'active', content: 'complete', hierarchyMeaning: 'is-a',
  property: [{ code: 'status', uri: 'http://hl7.org/fhir/concept-properties#status', type: 'code' },
    { code: 'colour', type: 'string' }],
  concept: [{ code: 'P', display: 'Parent', concept: [
    { code: 'P1', display: 'Child one', property: [{ code: 'colour', valueString: 'red' }] },
    { code: 'P2', display: 'Child two', property: [{ code: 'status', valueCode: 'retired' }] },
    { code: 'P3', display: 'Child three', property: [{ code: 'colour', valueString: 'red' }] }] }]
};
// the common units list the UCUM `canonical` filter enumerates (the library binds ucum-common)
const COMMON_UNITS = {
  resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/test-ucum-common', status: 'active',
  compose: { include: [{ system: UCUM, concept: ['mg', 'g', 'kg', 'ug', 'mL', 'L', 'mmol/L', 'mg/dL'].map(code => ({ code })) }] }
};
const SUPP_V2 = {
  resourceType: 'CodeSystem', url: 'http://example.org/fhir/CodeSystem/v2-mixed-de', version: '1', status: 'active',
  content: 'supplement', supplements: V2, concept: [{ code: 'A3', designation: [{ language: 'de', value: 'Anzeige A3' }] }]
};
const SUPP_FHIR = {
  resourceType: 'CodeSystem', url: 'http://example.org/fhir/CodeSystem/mixed-resource-de', version: '1', status: 'active',
  content: 'supplement', supplements: FHIRCS, concept: [{ code: 'P1', designation: [{ language: 'de', value: 'Kind eins' }] }]
};

const inc = (system, { codes, filters } = {}) => Object.assign({ system },
  codes ? { concept: codes.map(code => ({ code })) } : {},
  filters ? { filter: filters.map(([property, op, value]) => ({ property, op, value })) } : {});

// v2 is-a + UCUM list + BCP-47 list + FHIR resource is-a, with excludes on each kind of provider
const MIXED = {
  resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/v2-mixed', version: '1', status: 'active',
  compose: {
    include: [inc(V2, { filters: [['concept', 'is-a', 'A']] }), inc(UCUM, { codes: ['mg', 'mg/dL', 'kg'] }),
      inc(BCP47, { codes: ['en', 'en-US', 'de'] }), inc(FHIRCS, { filters: [['concept', 'is-a', 'P']] })],
    exclude: [inc(V2, { codes: ['A3'] }), inc(UCUM, { codes: ['kg'] }), inc(BCP47, { codes: ['de'] }), inc(FHIRCS, { codes: ['P3'] })]
  }
};
const MIXED_CODES = [[V2, 'A'], [V2, 'A1'], [V2, 'A2'], [UCUM, 'mg'], [UCUM, 'mg/dL'], [BCP47, 'en'], [BCP47, 'en-US'],
  [FHIRCS, 'P'], [FHIRCS, 'P1'], [FHIRCS, 'P2']];

function flat(contains, out = []) {
  for (const c of contains || []) {
    out.push([c.system, c.code]);
    flat(c.contains, out);
  }
  return out;
}
const named = (body, name) => (body.parameter || []).find(p => p.name === name);

describe('sqlite-v2 in mixed value sets (custom-code providers alongside the engine)', () => {
  let app, dir;

  async function post(url, parameter) {
    const res = await request(app).post(url).set('Content-Type', 'application/json')
      .send({ resourceType: 'Parameters', parameter: [{ name: 'tx-resource', resource: FHIR_CS }, ...parameter] });
    return res;
  }
  async function expand(vs, extra = []) {
    const res = await post(EXPAND, [{ name: 'valueSet', resource: vs }, ...extra]);
    expect(res.status).toBe(200);
    return res.body;
  }
  async function validate(vs, system, code, extra = []) {
    const res = await post(VALIDATE, [{ name: 'valueSet', resource: vs }, { name: 'system', valueUri: system }, { name: 'code', valueCode: code }, ...extra]);
    expect(res.status).toBe(200);
    return res.body;
  }

  beforeAll(async () => {
    app = await getTestApp();
    const tx = getTxModule();
    dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-mixed-'));
    buildV2(path.join(dir, 'v2.db'));
    const v2 = await loadSqliteV2Factory(tx.i18n, path.join(dir, 'v2.db'));
    buildV2Open(path.join(dir, 'v2-open.db'));
    const v2open = await loadSqliteV2Factory(tx.i18n, path.join(dir, 'v2-open.db'));
    const ucumService = new UcumService();
    await ucumService.init(fs.readFileSync(path.join(__dirname, '../../tx/data/ucum-essence.xml'), 'utf8'));
    const ucum = new UcumCodeSystemFactory(tx.i18n, ucumService);
    await ucum.load();
    ucum.processCommonUnits(new ValueSet(COMMON_UNITS));
    const lang = new IETFLanguageCodeFactory(tx.i18n);
    await lang.load();
    const provider = tx.endpoints[0].provider;
    for (const f of [v2, v2open, ucum, lang]) {
      provider.codeSystemFactories.set(f.system(), f);
      provider.codeSystemFactories.set(f.system() + '|' + f.version(), f);
    }
  }, 120000);

  afterAll(async () => {
    await shutdownTestApp();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('includes and excludes across both kinds of provider: segments in include order, v2 members in id order', async () => {
    const body = await expand(MIXED);
    expect(flat(body.expansion.contains)).toEqual(MIXED_CODES);
    expect(body.expansion.total).toBe(MIXED_CODES.length);
    // listed UCUM and BCP-47 codes do not make the expansion unclosed (main and v2 agree)
    expect((body.expansion.extension || []).some(e => e.url.endsWith('valueset-unclosed'))).toBe(false);
  });

  test('count=0 gives the total of the whole mixed compose', async () => {
    const body = await expand(MIXED, [{ name: 'count', valueInteger: 0 }]);
    expect(body.expansion.total).toBe(MIXED_CODES.length);
    expect(body.expansion.contains).toBeUndefined();
  });

  test('pages across the provider boundaries are slices of the full expansion, with the same total', async () => {
    for (const [offset, count] of [[0, 3], [2, 4], [3, 3], [6, 10], [9, 5], [12, 5]]) {
      const body = await expand(MIXED, [{ name: 'offset', valueInteger: offset }, { name: 'count', valueInteger: count }]);
      expect(flat(body.expansion.contains)).toEqual(MIXED_CODES.slice(offset, offset + count));
      expect(body.expansion.total).toBe(MIXED_CODES.length);
      expect(body.expansion.offset).toBe(offset);
    }
  });

  test('activeOnly drops the inactive v2 concept and the retired resource concept', async () => {
    const body = await expand(MIXED, [{ name: 'activeOnly', valueBoolean: true }]);
    const expected = MIXED_CODES.filter(([s, c]) => !(s === V2 && c === 'A2') && !(s === FHIRCS && c === 'P2'));
    expect(flat(body.expansion.contains)).toEqual(expected);
    expect(body.expansion.total).toBe(expected.length);
  });

  test.each([
    [V2, 'A1', true], [V2, 'A2', true], [V2, 'A3', false], [V2, 'B1', false],
    [UCUM, 'mg/dL', true], [UCUM, 'kg', false], [UCUM, 'mL', false], [UCUM, 'mg/dLx', false],
    [BCP47, 'en-US', true], [BCP47, 'de', false], [BCP47, 'fr', false],
    [FHIRCS, 'P1', true], [FHIRCS, 'P3', false], [FHIRCS, 'P2', true],
    ['http://example.org/nosuch', 'x', false]
  ])('$validate-code on the mixed set: %s#%s -> %s', async (system, code, result) => {
    const body = await validate(MIXED, system, code);
    expect(named(body, 'result').valueBoolean).toBe(result);
  });

  test('$validate-code with activeOnly: inactive members on either kind of provider are not valid', async () => {
    const active = [{ name: 'activeOnly', valueBoolean: true }];
    expect(named(await validate(MIXED, V2, 'A2', active), 'result').valueBoolean).toBe(false);
    expect(named(await validate(MIXED, FHIRCS, 'P2', active), 'result').valueBoolean).toBe(false);
    expect(named(await validate(MIXED, V2, 'A1', active), 'result').valueBoolean).toBe(true);
  });

  test('a UCUM canonical filter next to a v2 include, with a UCUM exclude', async () => {
    const vs = { resourceType: 'ValueSet', status: 'active', compose: {
      include: [inc(UCUM, { filters: [['canonical', '=', 'g']] }), inc(V2, { codes: ['B1'] })],
      exclude: [inc(UCUM, { codes: ['kg'] })] } };
    const body = await expand(vs);
    expect(flat(body.expansion.contains)).toEqual([[UCUM, 'mg'], [UCUM, 'g'], [UCUM, 'ug'], [V2, 'B1']]);
    expect(named(await validate(vs, UCUM, 'ng'), 'result').valueBoolean).toBe(true); // valid code with the canonical: not only the common list
    expect(named(await validate(vs, UCUM, 'kg'), 'result').valueBoolean).toBe(false);
    expect(named(await validate(vs, UCUM, 'mL'), 'result').valueBoolean).toBe(false);
    expect(named(await validate(vs, V2, 'B1'), 'result').valueBoolean).toBe(true);
  });

  test('supplements on the v2 system and on the resource, displayLanguage and designations', async () => {
    const vs = { resourceType: 'ValueSet', status: 'active', compose: {
      include: [inc(V2, { codes: ['A1', 'A3'] }), inc(FHIRCS, { codes: ['P1'] }), inc(BCP47, { codes: ['fr'] }), inc(UCUM, { codes: ['mg'] })] } };
    const supps = [{ name: 'tx-resource', resource: SUPP_V2 }, { name: 'tx-resource', resource: SUPP_FHIR },
      { name: 'useSupplement', valueCanonical: SUPP_V2.url }, { name: 'useSupplement', valueCanonical: SUPP_FHIR.url }];
    const de = await expand(vs, [...supps, { name: 'displayLanguage', valueCode: 'de' }]);
    expect(de.expansion.contains.map(c => c.display)).toEqual(['Anzeige A1', 'Anzeige A3', 'Kind eins', 'Französisch', 'mg']);
    const used = (de.expansion.parameter || []).filter(p => p.name === 'used-supplement').map(p => p.valueUri).sort();
    expect(used).toEqual([SUPP_FHIR.url + '|1', SUPP_V2.url + '|1']);

    const des = await expand(vs, [...supps, { name: 'includeDesignations', valueBoolean: true }]);
    const a3 = des.expansion.contains.find(c => c.code === 'A3');
    expect((a3.designation || []).some(d => d.language === 'de' && d.value === 'Anzeige A3')).toBe(true);

    const ok = await validate(vs, V2, 'A3', [...supps, { name: 'display', valueString: 'Anzeige A3' }, { name: 'displayLanguage', valueCode: 'de' }]);
    expect(named(ok, 'result').valueBoolean).toBe(true);
  });

  test('a filter on a supplement-defined property of a not-closed system does not make the expansion unclosed', async () => {
    const supp = [{ name: 'tx-resource', resource: SUPP_TIER }, { name: 'useSupplement', valueCanonical: SUPP_TIER.url }];
    const unclosed = (body) => (body.expansion.extension || []).some(e => e.url.endsWith('valueset-unclosed'));
    const vs = (...include) => ({ resourceType: 'ValueSet', status: 'active', compose: { include } });
    // next to a UCUM include (expand.js's include-by-include path) and alone (the engine's whole-compose path).
    // Members compared as sets: main lists supplement-filter matches in the supplement's order, v2 in id order.
    const mixed = await expand(vs(inc(V2OPEN, { filters: [['tier', '=', 'gold']] }), inc(UCUM, { codes: ['mg'] })), supp);
    expect(flat(mixed.expansion.contains).map(String).sort()).toEqual([[UCUM, 'mg'], [V2OPEN, 'X1'], [V2OPEN, 'X3']].map(String).sort());
    expect(unclosed(mixed)).toBe(false);
    const alone = await expand(vs(inc(V2OPEN, { filters: [['tier', '=', 'gold']] })), supp);
    expect(flat(alone.expansion.contains).map(String).sort()).toEqual([[V2OPEN, 'X1'], [V2OPEN, 'X3']].map(String).sort());
    expect(unclosed(alone)).toBe(false);
    // the system's own filters still leave it open, with or without a supplement filter beside them
    expect(unclosed(await expand(vs(inc(V2OPEN, { filters: [['concept', 'is-a', 'X']] }), inc(UCUM, { codes: ['mg'] })), supp))).toBe(true);
    expect(unclosed(await expand(vs(inc(V2OPEN, { filters: [['concept', 'is-a', 'X'], ['tier', '=', 'gold']] }), inc(UCUM, { codes: ['mg'] })), supp))).toBe(true);
    expect(unclosed(await expand(vs(inc(V2OPEN, { filters: [['concept', 'is-a', 'X'], ['tier', '=', 'gold']] })), supp))).toBe(true);
  });

  test('$translate with a ConceptMap from the v2 system to UCUM and from BCP-47', async () => {
    const cm = { resourceType: 'ConceptMap', url: 'http://example.org/fhir/ConceptMap/v2-mixed', version: '1', status: 'active',
      group: [{ source: V2, target: UCUM, element: [{ code: 'A1', target: [{ code: 'mg', relationship: 'equivalent' }] }] },
        { source: BCP47, target: V2, element: [{ code: 'en-US', target: [{ code: 'B1', relationship: 'related-to' }] }] }] };
    for (const [system, code, target] of [[V2, 'A1', [UCUM, 'mg']], [BCP47, 'en-US', [V2, 'B1']]]) {
      const res = await request(app).post('/tx/r5/ConceptMap/$translate').set('Content-Type', 'application/json')
        .send({ resourceType: 'Parameters', parameter: [{ name: 'tx-resource', resource: cm }, { name: 'url', valueUri: cm.url },
          { name: 'system', valueUri: system }, { name: 'sourceCode', valueCode: code }] });
      expect(res.status).toBe(200);
      expect(named(res.body, 'result').valueBoolean).toBe(true);
      const concept = named(res.body, 'match').part.find(p => p.name === 'concept').valueCoding;
      expect([concept.system, concept.code]).toEqual(target);
    }
  });

  test('$subsumes on UCUM (same unit written two ways) and on the v2 system', async () => {
    const subsumes = async (system, codeA, codeB) => {
      const res = await request(app).post('/tx/r5/CodeSystem/$subsumes').set('Content-Type', 'application/json')
        .send({ resourceType: 'Parameters', parameter: [{ name: 'system', valueUri: system }, { name: 'codeA', valueCode: codeA }, { name: 'codeB', valueCode: codeB }] });
      expect(res.status).toBe(200);
      return named(res.body, 'outcome').valueCode;
    };
    expect(await subsumes(UCUM, '1/min', 'min-1')).toBe('equivalent');
    expect(await subsumes(UCUM, 'm', 'cm')).toBe('not-subsumed');
    expect(await subsumes(V2, 'A', 'A1')).toBe('subsumes');
    expect(await subsumes(V2, 'B1', 'A')).toBe('not-subsumed');
  });
});
