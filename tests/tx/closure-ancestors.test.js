/**
 * $closure relates concepts from ancestor sets when the provider can list them
 * (CodeSystemProvider.ancestorsOf), and by subsumesTest per pair when it can't.
 *
 * The provider is a fake over a random hierarchy (several parents per code, so some codes
 * sit under others by more than one path). The same random sequence of adds is run three
 * ways - provider without the hook, with it, and with it for some codes only - and every
 * response, and the table as a resync from 0 reads it, must be the same; the hook must
 * need far fewer provider calls.
 */

const ClosureWorker = require('../../tx/workers/closure');
const { ClosureStore } = require('../../tx/closure/closure-store');
const { OperationContext } = require('../../tx/operation-context');
const { CodeSystemProvider } = require('../../tx/cs/cs-api');
const { TestUtilities } = require('../test-utilities');

const SYS = 'http://example.org/fhir/CodeSystem/closure-ancestors';
const OTHER = 'http://example.org/fhir/CodeSystem/closure-ancestors-other';

/** a seeded random number generator (mulberry32), so a failure can be reproduced */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** codes c0..c(size-1); each code after the first few has 1-3 parents among the codes before it */
function hierarchy(size, random) {
  const parents = new Map();
  for (let i = 0; i < size; i++) {
    const ps = new Set();
    if (i >= 3) {
      const count = 1 + Math.floor(random() * 3);
      for (let j = 0; j < count; j++) {
        ps.add('c' + Math.floor(random() * i));
      }
    }
    parents.set('c' + i, [...ps]);
  }
  const ancestors = new Map();
  const walk = code => {
    if (!ancestors.has(code)) {
      const set = new Set();
      for (const p of parents.get(code)) {
        set.add(p);
        for (const a of walk(p)) {
          set.add(a);
        }
      }
      ancestors.set(code, set);
    }
    return ancestors.get(code);
  };
  for (const code of parents.keys()) {
    walk(code);
  }
  return ancestors;
}

/**
 * hook: 'none' (the default ancestorsOf), 'all', or 'some' (null for codes whose number is a
 * multiple of 3, as a provider does for a code it can't answer for)
 */
class FakeProvider extends CodeSystemProvider {
  constructor(opContext, system, ancestors, hook, calls) {
    super(opContext, []);
    this.sys = system;
    this.anc = ancestors;
    this.hook = hook;
    this.calls = calls;
  }
  system() { return this.sys; }
  version() { return '1'; }
  async locate(code) { return this.anc.has(code) ? { context: { code }, message: null } : { context: null, message: 'unknown' }; }
  async code(ctxt) { return ctxt.code; }
  async display(ctxt) { return 'Display ' + ctxt.code; }
  async subsumesTest(a, b) {
    this.calls.subsumesTest++;
    if (a === b) {
      return 'equivalent';
    }
    if (this.anc.get(b).has(a)) {
      return 'subsumes';
    }
    return this.anc.get(a).has(b) ? 'subsumed-by' : 'not-subsumed';
  }
  async ancestorsOf(code) {
    this.calls.ancestorsOf++;
    if (this.hook === 'none' || (this.hook === 'some' && Number(code.substring(1)) % 3 === 0)) {
      return super.ancestorsOf(code);
    }
    return new Set(this.anc.get(code));
  }
}

function entriesOf(cm) {
  const out = [];
  for (const g of cm.group || []) {
    for (const e of g.element || []) {
      for (const t of e.target || []) {
        out.push(`${g.source}|${e.code} > ${g.target}|${t.code} : ${t.relationship}${t.equivalence ? '/' + t.equivalence : ''}`);
      }
    }
  }
  return out;
}

describe('$closure from ancestor sets (CodeSystemProvider.ancestorsOf)', () => {
  let i18n;
  let languages;

  beforeAll(async () => {
    languages = await TestUtilities.loadLanguageDefinitions();
    i18n = await TestUtilities.loadTranslations(languages);
  });

  /** run the adds against a new table; returns every response's entries, the resync, and the calls */
  async function run(adds, ancestors, hook, fhirVersion = '5.0') {
    const calls = { subsumesTest: 0, ancestorsOf: 0 };
    const store = new ClosureStore({ database: ':memory:' });
    store.open();
    try {
      store.createTable('t', []);
      const responses = [];
      for (const codings of adds) {
        const opContext = new OperationContext('en', i18n);
        const worker = new ClosureWorker(opContext, { info() {}, debug() {}, warn() {}, error() {} }, null, languages, i18n, store, {});
        const providers = new Map([[SYS, new FakeProvider(opContext, SYS, ancestors, hook, calls)],
          [OTHER, new FakeProvider(opContext, OTHER, ancestors, hook, calls)]]);
        worker.setupAdditionalResources = () => {};
        worker.seeSourceProvider = () => {};
        worker.findCodeSystem = async system => providers.get(system);
        const params = codings.map(c => ({ name: 'concept', valueCoding: c }));
        const cm = await worker.add(store.getTable('t'), 't', params, fhirVersion);
        responses.push({ version: cm.version, entries: entriesOf(cm) });
      }
      const table = store.getTable('t');
      const resync = store.entriesSince(table.id, 0)
        .map(e => `${e.source_system}|${e.source_code} > ${e.target_system}|${e.target_code} : ${e.relationship}`).sort();
      return { responses, resync, calls };
    } finally {
      store.close();
    }
  }

  /** a random sequence of adds: batches of 1-40 codes (some repeated, some from the other system) */
  function randomAdds(random, size, batches) {
    const adds = [];
    for (let b = 0; b < batches; b++) {
      const k = 1 + Math.floor(random() * 40);
      const codings = [];
      for (let i = 0; i < k; i++) {
        const system = random() < 0.15 ? OTHER : SYS;
        codings.push({ system, code: 'c' + Math.floor(random() * size) });
      }
      adds.push(codings);
    }
    return adds;
  }

  for (const seed of [1, 2, 3, 4, 5]) {
    test(`random tables (seed ${seed}): the same entries with and without the hook, with far fewer calls`, async () => {
      const random = rng(seed);
      const size = 150 + Math.floor(random() * 150);
      const ancestors = hierarchy(size, random);
      const adds = randomAdds(random, size, 8);

      const pairwise = await run(adds, ancestors, 'none');
      const hooked = await run(adds, ancestors, 'all');
      const some = await run(adds, ancestors, 'some');

      expect(pairwise.resync.length).toBeGreaterThan(0);
      expect(hooked.responses).toEqual(pairwise.responses);
      expect(hooked.resync).toEqual(pairwise.resync);
      expect(some.responses).toEqual(pairwise.responses);
      expect(some.resync).toEqual(pairwise.resync);

      // without the hook: one ancestorsOf (answered null) per new concept, then every pair
      expect(pairwise.calls.subsumesTest).toBeGreaterThan(1000);
      // with it: no pairs at all, and at most one ancestor set per concept per call
      expect(hooked.calls.subsumesTest).toBe(0);
      const concepts = new Set(adds.flat().map(c => c.system + '|' + c.code)).size;
      expect(hooked.calls.ancestorsOf).toBeLessThanOrEqual(concepts * adds.length);
      expect(hooked.calls.ancestorsOf * 5).toBeLessThan(pairwise.calls.subsumesTest);
      // some codes without a set: only the pairs that involve one are tested
      expect(some.calls.subsumesTest).toBeGreaterThan(0);
      expect(some.calls.subsumesTest).toBeLessThan(pairwise.calls.subsumesTest);
    });
  }

  test('both directions, and the R4 equivalence, as subsumesTest gives them', async () => {
    // c0 > c3 > c5, by hand
    const ancestors = new Map([['c0', new Set()], ['c3', new Set(['c0'])], ['c5', new Set(['c3', 'c0'])], ['c7', new Set()]]);
    const adds = [[{ system: SYS, code: 'c3' }], [{ system: SYS, code: 'c5' }, { system: SYS, code: 'c0' }, { system: SYS, code: 'c7' }]];
    for (const fhirVersion of ['5.0', '4.0']) {
      const pairwise = await run(adds, ancestors, 'none', fhirVersion);
      const hooked = await run(adds, ancestors, 'all', fhirVersion);
      expect(hooked.responses).toEqual(pairwise.responses);
      expect(hooked.resync).toEqual(pairwise.resync);
      const legacy = fhirVersion === '4.0' ? '/subsumes' : '';
      expect(hooked.responses[1].entries).toEqual([
        `${SYS}|c3 > ${SYS}|c0 : source-is-narrower-than-target${legacy}`,
        `${SYS}|c5 > ${SYS}|c0 : source-is-narrower-than-target${legacy}`,
        `${SYS}|c5 > ${SYS}|c3 : source-is-narrower-than-target${legacy}`
      ]);
    }
  });

  test('the default ancestorsOf is null', async () => {
    const opContext = new OperationContext('en', i18n);
    const cs = new CodeSystemProvider(opContext, []);
    expect(await cs.ancestorsOf('x')).toBeNull();
  });
});
