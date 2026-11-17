'use strict';

// sqlite-v2 query engine and provider on a small fixture built with the v2 importer stage:
// compose filters and ECL compile to set algebra over stored sets; results page by position;
// membership by probing; statement counts; supplement layers; RxNorm REL filters.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { V2Builder } = require('../../tx/importers/sqlite-v2/builder');
const { V2Store } = require('../../tx/sqlite-v2/store');
const { Engine } = require('../../tx/sqlite-v2/engine/engine');
const { Compiler } = require('../../tx/sqlite-v2/engine/compile');
const { dialectFor } = require('../../tx/sqlite-v2/dialects');
const { countingTracer } = require('./sqlite-v2-counting-tracer');
const { buildLayer, LayerSet } = require('../../tx/sqlite-v2/layers');

let dir;
let store;
let rx;

// root
// ├── B ── D ─┬─ F (site = Y, colour red)
// │           └─ G (also under E; site = Y in two groups, colour red)
// ├── C ── E ─── G
// │        └──── H (inactive)
// └── Z
// Y: active, no parents; X: inactive
function buildFixture(dest) {
  const b = new V2Builder(dest, { overwrite: true, importer: 'test' });
  b.setCodeSystem({ uri: 'http://example.org/cs', version: '1' });
  const isa = b.property({ code: 'parent', fhirType: 'code', valueKind: 'concept', isHierarchy: true });
  const colour = b.property({ code: 'colour', fhirType: 'string', valueKind: 'literal' });
  const site = b.property({ code: 'site', fhirType: 'code', valueKind: 'concept' });
  const lat = b.property({ code: 'laterality', fhirType: 'code', valueKind: 'concept' });
  const c = {};
  for (const code of ['root', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'Z', 'Y', 'X', 'L', 'R']) {
    c[code] = b.concept(code, { active: !['H', 'X'].includes(code), display: `display ${code}` });
  }
  for (const [ch, pa] of [['B', 'root'], ['C', 'root'], ['Z', 'root'], ['D', 'B'], ['F', 'D'], ['G', 'D'], ['E', 'C'], ['G', 'E'], ['H', 'E']]) b.link(c[ch], isa, c[pa]);
  b.link(c.F, site, c.Y, { group: 1 });
  b.link(c.F, lat, c.L, { group: 1 });
  b.link(c.G, site, c.Y, { group: 1 });
  b.link(c.G, lat, c.R, { group: 2 });
  b.literal(c.F, colour, 'red');
  b.literal(c.G, colour, 'Red');
  b.literal(c.D, colour, 'blue');
  b.designation(c.F, { language: 'en', term: 'effervescent thing' });
  b.finish();
}

function buildRx(dest) {
  const b = new V2Builder(dest, { overwrite: true, importer: 'test' });
  b.setCodeSystem({ uri: 'http://www.nlm.nih.gov/research/umls/rxnorm', version: '1' });
  const tty = b.property({ code: 'TTY', fhirType: 'code', valueKind: 'literal' });
  const hpi = b.property({ code: 'has_precise_ingredient', fhirType: 'code', valueKind: 'concept' });
  const hpiRN = b.property({ code: 'has_precise_ingredient@RN', fhirType: 'code', valueKind: 'concept' });
  const hi = b.property({ code: 'has_ingredient', fhirType: 'code', valueKind: 'concept' });
  const c = {};
  for (const code of ['1', '2', '3', '4', '5']) c[code] = b.concept(code, { active: code !== '5', display: 'drug ' + code });
  b.literal(c['2'], tty, 'SCD');
  b.literal(c['3'], tty, 'SCD');
  b.literal(c['5'], tty, 'SCD');
  b.link(c['2'], hpi, c['1']);
  b.link(c['2'], hpiRN, c['1']);
  b.link(c['3'], hpi, c['1']); // the RO row: not RN
  b.link(c['4'], hi, c['1']);
  b.link(c['5'], hi, c['1']);
  b.setConfig('relaByRel', { RN: ['has_precise_ingredient@RN'], RO: ['has_ingredient', 'has_precise_ingredient'] });
  b.finish();
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-engine-'));
  buildFixture(path.join(dir, 'cs.db'));
  buildRx(path.join(dir, 'rx.db'));
  store = new V2Store(path.join(dir, 'cs.db'));
  rx = new V2Store(path.join(dir, 'rx.db'));
});
afterAll(() => {
  store.close();
  rx.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function codesOf(S, ids) {
  const rows = S.conceptRows(ids);
  return ids.map((id) => rows.get(id).code);
}

function expand(S, includes, { excludes = [], activeOnly = false, offset = 0, count = -1, engine, layers } = {}) {
  const e = engine || new Engine(S);
  const c = new Compiler({ store: S, dialect: dialectFor(S.system), layers });
  const r = e.run(c.selection(includes, excludes, activeOnly), { offset, count });
  return { r, codes: codesOf(S, r.page(offset, count)) };
}

const inc = (filter) => ({ system: 'http://example.org/cs', filter });
const f = (property, op, value) => ({ property, op, value });

describe('sqlite-v2 engine: filters as set algebra', () => {
  test('hierarchy filters', () => {
    expect(expand(store, [inc([f('concept', 'is-a', 'D')])]).codes.sort()).toEqual(['D', 'F', 'G']);
    expect(expand(store, [inc([f('concept', 'descendent-of', 'C')])]).codes.sort()).toEqual(['E', 'G', 'H']);
    expect(expand(store, [inc([f('concept', 'child-of', 'E')])]).codes.sort()).toEqual(['G', 'H']);
    expect(expand(store, [inc([f('concept', 'generalizes', 'G')])]).codes.sort()).toEqual(['B', 'C', 'D', 'E', 'G', 'root']);
    expect(expand(store, [inc([f('concept', 'is-not-a', 'B')])]).codes.sort()).toEqual(['C', 'E', 'H', 'L', 'R', 'X', 'Y', 'Z', 'root']);
    expect(expand(store, [inc([f('concept', 'descendent-leaf', 'root')])]).codes.sort()).toEqual(['F', 'G', 'Z']);
  });

  test('properties: =, in, not-in, exists, regex, case-insensitive literals', () => {
    expect(expand(store, [inc([f('colour', '=', 'red')])]).codes.sort()).toEqual(['F', 'G']);
    expect(expand(store, [inc([f('colour', 'in', 'blue,red')])]).codes.sort()).toEqual(['D', 'F', 'G']);
    expect(expand(store, [inc([f('site', '=', 'Y')])]).codes.sort()).toEqual(['F', 'G']);
    expect(expand(store, [inc([f('site', 'exists', 'true')])]).codes.sort()).toEqual(['F', 'G']);
    expect(expand(store, [inc([f('colour', 'regex', 'bl.*')])]).codes).toEqual(['D']);
    expect(expand(store, [inc([f('concept', 'is-a', 'root'), f('colour', 'not-in', 'red')])]).codes.sort()).toEqual(['B', 'C', 'D', 'E', 'H', 'Z', 'root']);
    // a regex on a concept-valued property matches the target's display
    expect(expand(store, [inc([f('laterality', 'regex', 'display L')])]).codes).toEqual(['F']);
  });

  test('R5 generic filters: designation = / regex (display counts), search prefixes', () => {
    expect(expand(store, [inc([f('designation', '=', 'effervescent thing')])]).codes).toEqual(['F']);
    expect(expand(store, [inc([f('designation', '=', 'display D')])]).codes).toEqual(['D']);
    // regex matches the whole term (tx-ecosystem simple-expand-regex, expand-regex-bad)
    expect(expand(store, [inc([f('designation', 'regex', 'efferv')])]).codes).toEqual([]);
    expect(expand(store, [inc([f('designation', 'regex', 'efferv.*')])]).codes).toEqual(['F']);
    expect(expand(store, [inc([f('code', 'regex', '[A-Z]')])]).codes.sort()).toEqual(['B', 'C', 'D', 'E', 'F', 'G', 'H', 'L', 'R', 'X', 'Y', 'Z']);
    expect(expand(store, [inc([f('code', 'regex', 'roo')])]).codes).toEqual([]);
  });

  test('planner budget: an estimated cost over maxScanRows is refused before the work', () => {
    const { settings } = require('../../tx/sqlite-v2/settings');
    const saved = settings.maxScanRows;
    settings.maxScanRows = 3;
    try {
      expect(() => expand(store, [inc([f('designation', 'regex', 'x')])])).toThrow(/estimated cost/);
    } finally {
      settings.maxScanRows = saved;
    }
  });

  test('includes, excludes and activeOnly', () => {
    const { codes, r } = expand(store, [inc([f('concept', 'is-a', 'E')]), inc([f('concept', 'is-a', 'D')])],
      { excludes: [inc([f('colour', '=', 'red')])], activeOnly: true });
    expect(codes.sort()).toEqual(['D', 'E']);
    expect(r.total).toBe(2);
  });

  test('explicit concepts keep their order; paging is by position across segments', () => {
    const e = new Engine(store);
    const sel = [{ system: 'http://example.org/cs', concept: [{ code: 'Z' }, { code: 'B' }, { code: 'nope' }] }, inc([f('concept', 'is-a', 'D')])];
    const all = expand(store, sel, { engine: e }).codes;
    expect(all).toEqual(['Z', 'B', 'D', 'F', 'G']);
    expect(expand(store, sel, { engine: e, offset: 1, count: 3 }).codes).toEqual(['B', 'D', 'F']);
  });

  test('ECL hierarchy operators over the wildcard (tx-ecosystem sct/ecl/*-of-any)', () => {
    const ev = (text) => codesOf(store, new Engine(store).evaluate(new Compiler({ store, dialect: {} }).ecl(text)).toArray()).sort();
    const all = ev('*');
    const hasParent = ev('< *'); // an active is-a link up
    const hasChild = ev('> *'); // an active concept that is not a leaf
    expect(hasParent).toEqual(['B', 'C', 'D', 'E', 'F', 'G', 'H', 'Z']);
    expect(hasChild).toEqual(['B', 'C', 'D', 'E', 'root']);
    expect(ev('<! *')).toEqual(hasParent);
    expect(ev('>! *')).toEqual(hasChild);
    for (const op of ['<<', '<<!', '>>', '>>!']) expect(ev(op + ' *')).toEqual(all);
    expect(ev('!!< *')).toEqual(all.filter((c) => !hasChild.includes(c))); // bottom of the set: no children
    expect(ev('!!> *')).toEqual(all.filter((c) => !hasParent.includes(c))); // top of the set: no parents
  });

  test('ECL: refinements, groups, cardinality, reverse, dotted', () => {
    const ecl = (text) => {
      const c = new Compiler({ store, dialect: {} });
      return codesOf(store, new Engine(store).evaluate(c.ecl(text)).toArray()).sort();
    };
    // the fixture's codes are not SCTIDs; build the AST by hand through the compiler's ECL node API
    const n = (code) => ({ type: 'SubExpressionConstraint', operator: null, focus: { type: 'ConceptReference', conceptId: code } });
    const c = new Compiler({ store, dialect: {} });
    const ev = (node) => codesOf(store, new Engine(store).evaluate(node).toArray()).sort();
    const desc = (code) => ({ type: 'SubExpressionConstraint', operator: 'DESCENDANT_OR_SELF_OF', focus: { type: 'ConceptReference', conceptId: code } });
    const attr = (name, value, extra = {}) => ({ type: 'Attribute', cardinality: null, reverse: false, name: { type: 'ConceptReference', conceptId: name }, comparison: { type: 'ExpressionComparison', operator: 'EQUALS', value }, ...extra });
    expect(ev(c.eclNode({ type: 'RefinedExpressionConstraint', base: desc('root'), refinement: attr('site', n('Y')) }))).toEqual(['F', 'G']);
    // F has site=Y and laterality=L in one group; G has them in different groups
    const group = { type: 'AttributeGroup', cardinality: null, attributes: [attr('site', n('Y')), attr('laterality', { type: 'SubExpressionConstraint', operator: null, focus: { type: 'Wildcard' } })] };
    expect(ev(c.eclNode({ type: 'RefinedExpressionConstraint', base: desc('root'), refinement: group }))).toEqual(['F']);
    expect(ev(c.eclNode({ type: 'RefinedExpressionConstraint', base: desc('D'), refinement: attr('laterality', n('L'), { cardinality: { min: 0, max: 0 } }) }))).toEqual(['D', 'G']);
    expect(ev(c.eclNode({ type: 'RefinedExpressionConstraint', base: { type: 'SubExpressionConstraint', operator: null, focus: { type: 'Wildcard' } }, refinement: attr('site', desc('D'), { reverse: true }) }))).toEqual(['Y']);
    expect(ev(c.eclNode({ type: 'DottedExpressionConstraint', base: desc('D'), attributes: [{ type: 'ConceptReference', conceptId: 'laterality' }] }))).toEqual(['L', 'R']);
    // cardinality counts (group, value) occurrences: G has site=Y in group 1 and laterality R in group 2
    const any = { type: 'SubExpressionConstraint', operator: null, focus: { type: 'Wildcard' } };
    expect(ev(c.eclNode({ type: 'RefinedExpressionConstraint', base: desc('root'), refinement: { type: 'AttributeSet', operator: 'OR', attributes: [attr('site', any, { cardinality: { min: 1, max: 1 } })] } }))).toEqual(['F', 'G']);
    expect(ev(c.eclNode({ type: 'RefinedExpressionConstraint', base: desc('root'), refinement: { type: 'AttributeGroup', cardinality: { min: 2, max: '*' }, attributes: [attr('laterality', any)] } }))).toEqual([]);
    expect(ev(c.eclNode({ type: 'RefinedExpressionConstraint', base: desc('D'), refinement: { type: 'AttributeGroup', cardinality: { min: 0, max: 1 }, attributes: [attr('laterality', any)] } }))).toEqual(['D', 'F', 'G']);
    expect(ev(c.eclNode({ type: 'SubExpressionConstraint', operator: 'BOTTOM_OF_SET', focus: { type: 'CompoundExpressionConstraint', operator: 'Disjunction', left: n('B'), right: n('D') } }))).toEqual(['D']);
    void ecl;
  });

  test('membership of one code is answered by probing, without materialising a text scan', () => {
    const e = new Engine(store);
    const c = new Compiler({ store, dialect: {} });
    const node = { t: 'and', items: [c.filter('concept', 'is-a', 'root'), { t: 'text', field: 'display', re: 'display [FG]' }] };
    expect(e.contains(node, store.idOf('F'))).toBe(true);
    expect(e.contains(node, store.idOf('D'))).toBe(false);
  });

  test('lazy first page: no total; a full request is complete', () => {
    const e = new Engine(store, { lazyMinDriver: 2 });
    const sel = [inc([f('concept', 'is-a', 'root'), f('concept', 'regex', '[A-Z]')])];
    const c = new Compiler({ store, dialect: {} });
    const first = e.run(c.selection(sel, [], false), { offset: 0, count: 2 });
    expect(first.page(0, 2).length).toBe(2);
    const all = e.run(c.selection(sel, [], false), { offset: 0, count: -1 });
    expect(all.complete).toBe(true);
    expect(codesOf(store, all.page(0, -1)).sort()).toEqual(['B', 'C', 'D', 'E', 'F', 'G', 'H', 'Z']);
  });
});

describe('sqlite-v2 engine: value set imports', () => {
  test('an include of imported value sets is their intersection; an import is includes minus excludes', () => {
    const vsA = { include: [inc([f('concept', 'is-a', 'root')])], exclude: [inc([f('concept', 'is-a', 'C')])] };
    const vsB = { include: [inc([f('colour', 'exists', 'true')])] };
    // G is also under C (polyhierarchy), so the exclude removes it
    expect(expand(store, [{ imports: [vsA] }]).codes.sort()).toEqual(['B', 'D', 'F', 'Z', 'root']);
    expect(expand(store, [{ imports: [vsA, vsB] }]).codes.sort()).toEqual(['D', 'F']);
    expect(expand(store, [{ system: 'http://example.org/cs', filter: [f('colour', '=', 'red')], imports: [vsA] }]).codes.sort()).toEqual(['F']);
  });
});

describe('sqlite-v2 supplement layers', () => {
  const supp = {
    resourceType: 'CodeSystem', url: 'http://example.org/supp', version: '1', content: 'supplement', supplements: 'http://example.org/cs', language: 'fr',
    property: [{ code: 'flavour', type: 'code' }],
    concept: [
      { code: 'F', display: 'chose F', designation: [{ language: 'fr', value: 'chose effervescente' }], property: [{ code: 'flavour', valueCode: 'sweet' }] },
      { code: 'D', property: [{ code: 'flavour', valueCode: 'sour' }] },
      { code: 'G', property: [{ code: 'flavour', valueCode: 'sweet' }] },
      { code: 'unknown-to-base', display: 'x' }
    ]
  };

  test('layer ids are base ids; unknown codes are counted and skipped', () => {
    const l = buildLayer(store, supp);
    expect(l.info.unknownCodes).toBe(1);
    expect(l.info.concepts).toBe(3);
    expect(l.store.idOf('F')).toBe(store.idOf('F'));
  });

  test('a supplement property filter combines with base filters', () => {
    const layers = new LayerSet([{ json: supp, build: () => ({ layer: buildLayer(store, supp), entry: null }) }]);
    expect(expand(store, [inc([f('flavour', '=', 'sweet')])], { layers }).codes.sort()).toEqual(['F', 'G']);
    expect(expand(store, [inc([f('flavour', '=', 'sweet'), f('concept', 'child-of', 'E')])], { layers }).codes).toEqual(['G']);
    expect(expand(store, [inc([f('concept', 'is-a', 'D'), f('flavour', 'exists', 'false')])], { layers }).codes).toEqual([]);
  });

  describe('the layer cache', () => {
    const { SupplementLayers, layerCache } = require('../../tx/sqlite-v2/layers');
    const { settings } = require('../../tx/sqlite-v2/settings');
    const saved = settings.supplementLayerCacheMB;
    const factory = () => new SupplementLayers(store);
    // one request: a filter on the supplement property, then the request ends
    const request = (json, filters = [f('flavour', '=', 'sweet')]) => {
      const layers = factory().forSupplements([json]);
      try {
        const codes = expand(store, [inc(filters)], { layers }).codes.sort();
        return { codes, layer: layers.built[0].layer };
      } finally {
        layers.close();
      }
    };
    const copy = (o) => JSON.parse(JSON.stringify(o));
    beforeEach(() => { layerCache.clear(); layerCache.stats = { hits: 0, misses: 0, uncached: 0, evictions: 0 }; });
    afterAll(() => { settings.supplementLayerCacheMB = saved; layerCache.clear(); });

    test('a repeat request hits, with the same results (a tx-resource sent again is a new object)', () => {
      const a = request(supp);
      const b = request(copy(supp));
      expect(layerCache.stats).toMatchObject({ hits: 1, misses: 1 });
      expect(b.layer).toBe(a.layer);
      expect(b.codes).toEqual(a.codes);
      expect(b.codes).toEqual(['F', 'G']);
      // still open after both requests ended, and read-only
      expect(() => b.layer.store.db.prepare('DELETE FROM concept').run()).toThrow(/readonly|read-only|query_only/i);
      expect(request(supp).codes).toEqual(['F', 'G']);
    });

    test('a changed supplement misses (same url and version)', () => {
      const a = request(supp);
      const changed = copy(supp);
      changed.concept[1].property[0].valueCode = 'sweet';
      const b = request(changed);
      expect(layerCache.stats).toMatchObject({ hits: 0, misses: 2 });
      expect(b.layer).not.toBe(a.layer);
      expect(b.codes).toEqual(['D', 'F', 'G']);
      expect(request(supp).codes).toEqual(['F', 'G']);
    });

    test('the bound evicts the least recently used; a layer used by a request is closed only when it ends', () => {
      const bytes = buildLayer(store, supp).info.bytes;
      settings.supplementLayerCacheMB = (2.5 * bytes) / 1048576; // room for two
      const v = (n) => ({ ...copy(supp), version: String(n) });
      const s1 = v(1); const s2 = v(2); const s3 = v(3);
      request(s1); request(s2); request(s1); // s2 is now the least recently used
      const held = factory().forSupplements([s1]);
      expand(store, [inc([f('flavour', '=', 'sweet')])], { layers: held });
      request(s3);
      expect(layerCache.stats.evictions).toBe(1);
      expect(layerCache.entries.size).toBe(2);
      expect(layerCache.bytes).toBeLessThanOrEqual(layerCache.maxBytes);
      request(s1); request(s3);
      expect(layerCache.stats.hits).toBe(4); // s1 twice before, s1 (held), s1, s3
      request(s2);
      expect(layerCache.stats.misses).toBe(4);
      // s1 was evicted by s2 while `held` still uses it: it stays open until that request ends
      const l1 = held.built[0].layer;
      expect(layerCache.entries.has(factory().keyOf(s1))).toBe(false);
      expect(l1.store.db.open).toBe(true);
      held.close();
      expect(l1.store.db.open).toBe(false);
    });

    test('a layer bigger than the whole bound is built per request and not kept', () => {
      settings.supplementLayerCacheMB = 0;
      const a = request(supp);
      const b = request(supp);
      expect(layerCache.stats).toMatchObject({ hits: 0, misses: 2, uncached: 2 });
      expect(layerCache.entries.size).toBe(0);
      expect(b.codes).toEqual(['F', 'G']);
      expect(a.layer.store.db.open).toBe(false);
    });
  });
});

describe('sqlite-v2 SNOMED concept in an unknown id', () => {
  test('is an error, not an empty set', () => {
    const c = new Compiler({ store, dialect: { strictIn: true, unknownConcept: (cc, op, v) => { throw new Error(`The SNOMED CT Concept ${v} is not known`); } } });
    expect(() => c.filter('concept', 'in', 'D,nope')).toThrow('The SNOMED CT Concept nope is not known');
  });
});

describe('sqlite-v2 SNOMED concept in / code in', () => {
  // a refset contributes its members, any other concept itself (tx-ecosystem sct/*-concept-in, *-code-in)
  let sct;
  beforeAll(() => {
    const b = new V2Builder(path.join(dir, 'sct.db'), { overwrite: true, importer: 'test' });
    b.setCodeSystem({ uri: 'http://snomed.info/sct', version: 'http://snomed.info/sct/900000000000207008/version/20250201' });
    const isa = b.property({ code: 'parent', fhirType: 'code', valueKind: 'concept', isHierarchy: true });
    const c = {};
    for (const code of ['138875005', '1001001', '1002001', '1003001', '1004001', '9001001']) c[code] = b.concept(code, { active: true, display: 'c ' + code });
    for (const k of ['1001001', '1002001', '1003001', '1004001', '9001001']) b.link(c[k], isa, c['138875005']);
    b.refsetMember(c['9001001'], c['1001001']);
    b.refsetMember(c['9001001'], c['1002001']);
    b.finish();
    sct = new V2Store(path.join(dir, 'sct.db'));
  });
  afterAll(() => sct.close());
  const sinc = (filter) => ({ system: 'http://snomed.info/sct', filter });

  test('plain concepts are themselves, a refset its members, code is the same property', () => {
    for (const prop of ['concept', 'code']) {
      const r = expand(sct, [sinc([f(prop, 'in', '1003001,1004001,1001001')])]);
      expect(r.codes.sort()).toEqual(['1001001', '1003001', '1004001']);
      expect(r.r.total).toBe(3);
      expect(expand(sct, [sinc([f(prop, 'in', '9001001,1004001')])]).codes.sort()).toEqual(['1001001', '1002001', '1004001']);
      expect(expand(sct, [sinc([f(prop, 'not-in', '1003001')])]).codes).not.toContain('1003001');
    }
    expect(() => expand(sct, [sinc([f('code', 'in', '1003001,41000147108')])])).toThrow('The SNOMED CT Concept 41000147108 is not known');
  });
});

describe('sqlite-v2 LOINC CLASSTYPE by code or name', () => {
  test('a name maps to its code through propertyValueDescriptions (case-insensitive)', () => {
    const { Compiler: C } = require('../../tx/sqlite-v2/engine/compile');
    const fake = { store: { ...store, config: { propertyValueDescriptions: { colour: { red: 'Clinical class' } } }, propValues: store.propValues.bind(store), props: store.props, resolveCodes: store.resolveCodes.bind(store), idOf: store.idOf.bind(store), hierarchy: store.hierarchy, system: store.system }, dialect: {} };
    const c = new C(fake);
    const n = c.filter('colour', '=', 'clinical CLASS');
    expect(new Engine(store).evaluate(n).size).toBe(2); // 'red' (F) and 'Red' (G): literal values match without case, as upstream
  });
});

describe('sqlite-v2 RxNorm REL filters', () => {
  const rxinc = (filter) => ({ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', filter });
  test('REL = RN uses the REL-qualified links, RELA its full set; archived concepts are never selected', () => {
    expect(expand(rx, [rxinc([f('RN', '=', 'CUI:1')])]).codes).toEqual(['2']);
    expect(expand(rx, [rxinc([f('has_precise_ingredient', '=', 'CUI:1')])]).codes.sort()).toEqual(['2', '3']);
    expect(expand(rx, [rxinc([f('RO', '=', 'CUI:1')])]).codes.sort()).toEqual(['2', '3', '4']);
    expect(expand(rx, [rxinc([f('TTY', '=', 'SCD')])]).codes.sort()).toEqual(['2', '3']);
    expect(() => expand(rx, [rxinc([f('XX', '=', 'CUI:1')])])).toThrow('The filter "XX = CUI:1" is not understood or supported');
    // every FHIR operator the data can answer, beyond upstream's set
    expect(expand(rx, [rxinc([f('has_ingredient', 'in', 'CUI:1,CUI:3')])]).codes).toEqual(['4']);
    expect(expand(rx, [rxinc([f('concept', 'in', '2,4,5')])]).codes.sort()).toEqual(['2', '4']);
    expect(expand(rx, [rxinc([f('tty', 'not-in', 'SCD')])]).codes.sort()).toEqual(['1', '4']);
    expect(expand(rx, [rxinc([f('display', 'regex', 'drug [23]')])]).codes.sort()).toEqual(['2', '3']);
  });
});

describe('sqlite-v2 provider (cs-api contract)', () => {
  const { OperationContext } = require('../../tx/operation-context');
  const { TestUtilities } = require('../test-utilities');
  const { SqliteV2Factory } = require('../../tx/sqlite-v2/provider');
  const { Designations } = require('../../tx/library/designations');
  let factory, op;

  beforeAll(async () => {
    op = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    factory = new SqliteV2Factory(op.i18n, path.join(dir, 'cs.db'));
    await factory.load();
  });
  afterAll(() => factory.store.close());

  test('locate, display, designations, inactive', async () => {
    const p = await factory.build(op, []);
    const f = await p.locate('F');
    expect(await p.display(f.context)).toBe('display F');
    expect(await p.isInactive((await p.locate('H')).context)).toBe(true);
    expect((await p.locate('nope')).context).toBeNull();
    const ds = new Designations(op.i18n.languageDefinitions);
    await p.designations(f.context, ds);
    expect(ds.designations.map((d) => d.value)).toEqual(expect.arrayContaining(['display F', 'effervescent thing']));
  });

  test('prefetchCodes: another provider of the file answers from the handle (a batch\'s entries)', async () => {
    const t = countingTracer();
    op.tracer = t;
    try {
      const reader = await factory.build(op, []);
      const h = await reader.prefetchCodes(['F', 'G', 'nope'], true);
      const after = t.stats.statements;
      const p = await factory.build(op, []);
      expect(p).not.toBe(reader);
      const f = await p.locate('F', h);
      const ds = new Designations(op.i18n.languageDefinitions);
      await p.designations(f.context, ds);
      expect(ds.designations.map((d) => d.value)).toEqual(expect.arrayContaining(['display F', 'effervescent thing']));
      expect(await p.display((await p.locate('G', h)).context)).toBe('display G');
      expect((await p.locate('nope', h)).context).toBeNull();
      expect(t.stats.statements).toBe(after);
      // a handle from another file is not used
      expect((await p.locate('D', { store: {}, ids: new Map([['D', null]]), concepts: new Map() })).context).not.toBeNull();
    } finally {
      op.tracer = null;
    }
  });

  test('prefetchCodes: a handle that locate() answers from, without per-code statements', async () => {
    const t = countingTracer();
    op.tracer = t;
    try {
      const p = await factory.build(op, []);
      const h = await p.prefetchCodes(['F', 'G', 'nope'], true);
      expect(h).toEqual(expect.objectContaining({ store: p.store }));
      const after = t.stats.statements;
      expect(after).toBe(2); // codes with their rows, designations: one statement each
      const ds = new Designations(op.i18n.languageDefinitions);
      const f = await p.locate('F', h);
      await p.designations(f.context, ds);
      expect(ds.designations.map((d) => d.value)).toEqual(expect.arrayContaining(['display F', 'effervescent thing']));
      expect(await p.display((await p.locate('G', h)).context)).toBe('display G');
      expect((await p.locate('nope', h)).context).toBeNull();
      expect(t.stats.statements).toBe(after);
      // a code that was not prefetched is still read on demand
      expect(await p.display((await p.locate('D', h)).context)).toBe('display D');
      expect(t.stats.statements).toBeGreaterThan(after);
    } finally {
      op.tracer = null;
    }
  });

  test('prefetchCodes: nothing is kept on the provider; without a handle locate reads', async () => {
    const t = countingTracer();
    op.tracer = t;
    try {
      const p = await factory.build(op, []);
      const other = await factory.build(op, []);
      const h1 = await p.prefetchCodes(['F'], false);
      const h2 = await p.prefetchCodes(['G'], false);
      const foreign = await other.prefetchCodes(['nope'], false);
      let before = t.stats.statements;
      // two handles in progress stay apart: each answers its own codes
      expect((await p.locate('F', h1)).context.code).toBe('F');
      expect((await p.locate('G', h2)).context.code).toBe('G');
      expect(t.stats.statements).toBe(before);
      // no handle: the code is looked up (a statement), and the answer is the same
      expect((await p.locate('F')).context.code).toBe('F');
      expect(t.stats.statements).toBeGreaterThan(before);
      // another provider's handle of this file (which says 'nope' is not there) answers too
      before = t.stats.statements;
      expect((await p.locate('nope', foreign)).context).toBeNull();
      expect(t.stats.statements).toBe(before);
      expect(await p.prefetchCodes([], false)).toBeNull();
    } finally {
      op.tracer = null;
    }
  });

  test('subsumes from descendant sets', async () => {
    const p = await factory.build(op, []);
    expect(await p.subsumesTest('B', 'G')).toBe('subsumes');
    expect(await p.subsumesTest('G', 'C')).toBe('subsumed-by');
    expect(await p.subsumesTest('B', 'E')).toBe('not-subsumed');
    expect(await p.subsumesTest('D', 'D')).toBe('equivalent');
  });

  test('ancestorsOf agrees with subsumesTest on every pair (CodeSystemProvider.ancestorsOf)', async () => {
    const p = await factory.build(op, []);
    const codes = ['root', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'Z', 'Y', 'X', 'L', 'R'];
    for (const b of codes) {
      const anc = await p.ancestorsOf(b);
      expect(anc).toBeInstanceOf(Set);
      for (const a of codes) {
        if (a !== b) expect([a, b, anc.has(a)]).toEqual([a, b, (await p.subsumesTest(a, b)) === 'subsumes']);
      }
    }
    expect([...await p.ancestorsOf('G')].sort()).toEqual(['B', 'C', 'D', 'E', 'root']);
    expect(await p.ancestorsOf('root')).toEqual(new Set());
    expect(await p.ancestorsOf('nope')).toBeNull();
    expect(await p.ancestorsOf((await p.locate('G')).context)).toEqual(await p.ancestorsOf('G'));
  });

  test('ancestorsOf: a known RxNorm code sits under nothing (its subsumesTest is flat)', async () => {
    const rf = new SqliteV2Factory(op.i18n, path.join(dir, 'rx.db'));
    await rf.load();
    try {
      const p = await rf.build(op, []);
      expect(await p.ancestorsOf('2')).toEqual(new Set());
      expect(await p.subsumesTest('1', '2')).toBe('not-subsumed');
      expect(await p.ancestorsOf('nope')).toBeNull();
    } finally {
      rf.store.close();
    }
  });

  test('processSelection: one page, exact total, rows already loaded', async () => {
    const p = await factory.build(op, []);
    const inc = [{ system: 'http://example.org/cs', filter: [{ property: 'concept', op: 'is-a', value: 'root' }] }];
    const sel = await p.processSelection({}, inc, [], false, 2, 3);
    expect(sel.total).toBe(9); // root B C D E F G H Z
    expect(sel.notClosed).toBe(false);
    const [set] = sel.sets;
    const codes = [];
    while (await p.filterMore(null, set)) {
      const c = await p.filterConcept(null, set);
      expect(c.row).toBeTruthy();
      codes.push(await p.code(c));
    }
    expect(codes.length).toBe(3);
    // unsupported composes are handed back (null)
    expect(await p.processSelection({}, [{ system: 'http://example.org/cs', valueSet: ['http://x'] }], [], false, 0, 10)).toBeNull();
  });

  test('processSelection: a planner refusal is the too-costly Issue naming the value set it was told of', async () => {
    const { settings } = require('../../tx/sqlite-v2/settings');
    const p = await factory.build(op, []);
    const inc = [{ system: 'http://example.org/cs', filter: [{ property: 'designation', op: 'regex', value: 'x' }] }];
    const saved = settings.maxScanRows;
    settings.maxScanRows = 3;
    try {
      const refuse = (context) => p.processSelection({}, inc, [], false, -1, -1, context).then(() => null, (e) => e);
      const e = await refuse({ valueSet: { url: 'http://example.org/vs', version: '2.0' } });
      expect(e.statusCode).toBe(422);
      expect(e.cause).toBe('too-costly');
      expect(e.message).toContain("'http://example.org/vs|2.0'");
      expect(e.message).toMatch(/estimated cost/);
      // a value set given without url: no name to give
      expect((await refuse(undefined)).message).toContain("'??'");
    } finally {
      settings.maxScanRows = saved;
    }
  });

  test('filter API: iteration and membership without iteration', async () => {
    const p = await factory.build(op, []);
    const prep = await p.getPrepContext(false);
    await p.filter(prep, false, 'colour', '=', 'red');
    const [set] = await p.executeFilters(prep);
    expect(await p.filterLocate(prep, set, 'F')).toBeTruthy();
    expect(await p.filterLocate(prep, set, 'D')).toBeNull();
    const it = await p.getPrepContext(true);
    await p.filter(it, true, 'concept', 'is-a', 'D');
    const [s2] = await p.executeFilters(it);
    expect(await p.filterSize(it, s2)).toBe(3);
    await expect(p.filter(it, true, 'nonsense', '=', 'x')).rejects.toThrow('not supported');
  });

  test('filter API: a chunk\'s designations are read when one of its codes first needs them, in one statement', async () => {
    // an import expanded for its codes only (expand.js deferDetails) asks for no designation:
    // none are read. The first designations() of the chunk reads the rest of the chunk's too.
    const t = countingTracer();
    op.tracer = t;
    try {
      const p = await factory.build(op, []);
      const prep = await p.getPrepContext(true);
      await p.filter(prep, true, 'concept', 'is-a', 'root');
      const [set] = await p.executeFilters(prep);
      const cs = [];
      while (await p.filterMore(prep, set)) cs.push(await p.filterConcept(prep, set));
      expect(cs.length).toBe(9);
      expect(cs.every((c) => c.row && c.desigs === null)).toBe(true);
      const before = t.stats.statements;
      const read = async (prov, c) => {
        const ds = new Designations(op.i18n.languageDefinitions);
        await prov.designations(c, ds);
        return ds.designations.map((d) => [d.value, d.language && d.language.code]);
      };
      const got = [];
      for (const c of cs) got.push(await read(p, c));
      expect(t.stats.statements).toBe(before + 1);
      expect(cs.every((c) => Array.isArray(c.desigs) && c.peers === null)).toBe(true);
      // the same designations as a code located on its own
      const q = await factory.build(op, []);
      for (let i = 0; i < cs.length; i++) expect(got[i]).toEqual(await read(q, (await q.locate(cs[i].code)).context));
    } finally {
      op.tracer = null;
    }
  });
});

// A text filter searches one language (main since #335; CodeSystemProvider.searchLanguage):
// LOINC-style ('display' mode) English searches the display and English designations, another
// language its designations in that language, never RELATEDNAMES2 (#398); SNOMED-style ('designation' mode) designations in it only
describe('text filter in one language (store.searchText)', () => {
  let ts;
  beforeAll(() => {
    const b = new V2Builder(path.join(dir, 'text.db'), { overwrite: true, importer: 'test' });
    b.setCodeSystem({ uri: 'http://example.org/text', version: '1' });
    const use = (code) => ({ system: 'http://loinc.org', code, display: code });
    const g = b.concept('G', { active: true, display: 'Glucose [Mass/volume] in Serum' });
    const h = b.concept('H', { active: true, display: 'Hemoglobin in Blood' });
    b.designation(g, { language: 'de-DE', use: use('LONG_COMMON_NAME'), term: 'Glucose [Masse/Volumen] in Serum', active: true });
    b.designation(h, { language: 'de-DE', use: use('RELATEDNAMES2'), term: 'Volumen; Blut', active: true });
    b.designation(h, { language: 'en-US', use: use('SHORTNAME'), term: 'Hgb Bld', active: true });
    b.finish();
    ts = new V2Store(path.join(dir, 'text.db'));
  });
  afterAll(() => ts.close());
  const ids = (bm) => bm.toArray().map((id) => ts.conceptRows([id]).get(id).code).sort();

  test('display mode: English searches displays, German the German names but not RELATEDNAMES2', () => {
    expect(ids(ts.searchText('volumen', null, 'display', 'en'))).toEqual([]);
    expect(ids(ts.searchText('volumen', null, 'display', 'de'))).toEqual(['G']);
    expect(ids(ts.searchText('glucose', null, 'display', 'en'))).toEqual(['G']);
    // #398: every English name (not RELATEDNAMES2), so the short name too
    expect(ids(ts.searchText('hgb', null, 'display', 'en'))).toEqual(['H']);
    expect(ids(ts.searchText('blut', null, 'display', 'de'))).toEqual([]);
  });

  test('designation mode: only designations in the language', () => {
    expect(ids(ts.searchText('volumen', null, 'designation', 'de'))).toEqual(['G', 'H']);
    expect(ids(ts.searchText('volumen', null, 'designation', 'en'))).toEqual([]);
    expect(ids(ts.searchText('hgb', null, 'designation', 'en'))).toEqual(['H']);
    expect(ids(ts.searchText('hgb', null, 'designation', null))).toEqual(['H']);
  });
});
