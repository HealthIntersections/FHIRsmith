/**
 * CodeSystemMap keeps an index of the CodeSystems it holds by the url they supplement, so that
 * Provider.loadSupplements() does not scan every loaded CodeSystem on every lookup.
 *
 * The property tests below run the same random sequences of changes against a Provider whose map
 * is a plain Map (the scan, as before) and one whose map is a CodeSystemMap (the index), and check
 * that loadSupplements gives the same objects in the same order for every question asked.
 */
const { CodeSystemMap, Provider } = require('../../tx/provider');
const { CodeSystem } = require('../../tx/library/codesystem');

const GLOBAL = [
  { url: 'http://hl7.org/fhir/StructureDefinition/codesystem-supplement-type', valueCode: 'lang-pack' },
  { url: 'http://hl7.org/fhir/StructureDefinition/codesystem-supplement-global', valueBoolean: true }
];

function codeSystem({ url, version, content = 'supplement', supplements, global = false, sourcePackage }) {
  const json = { resourceType: 'CodeSystem', url, status: 'active', content };
  if (version) json.version = version;
  if (supplements) json.supplements = supplements;
  if (global) json.extension = GLOBAL;
  const cs = new CodeSystem(json);
  if (sourcePackage) cs.sourcePackage = sourcePackage;
  return cs;
}

function provider(map) {
  const p = Object.create(Provider.prototype);
  p.codeSystemFactories = new Map();
  p.codeSystems = map;
  return p;
}

describe('CodeSystemMap', () => {
  test('indexes by the supplemented url, without its version', () => {
    const m = new CodeSystemMap();
    const base = codeSystem({ url: 'http://x/base', version: '1', content: 'complete' });
    const s1 = codeSystem({ url: 'http://x/s1', version: '1', supplements: 'http://x/base' });
    const s2 = codeSystem({ url: 'http://x/s2', version: '2', supplements: 'http://x/base|1' });
    const other = codeSystem({ url: 'http://x/other', version: '1', supplements: 'http://y/base' });
    m.set(base.url, base).set(s1.url, s1).set(s2.vurl, s2).set(other.url, other);
    expect(m.supplementsOf('http://x/base')).toEqual([s1, s2]);
    expect(m.supplementsOf('http://x/base|1')).toEqual([s1, s2]); // a url with |version: same key
    expect(m.supplementsOf('http://y/base')).toEqual([other]);
    expect(m.supplementsOf('http://z')).toEqual([]);
  });

  test('a key given a value that supplements another url moves to that url, and keeps its place', () => {
    const m = new CodeSystemMap();
    const a1 = codeSystem({ url: 'http://x/s', version: '1', supplements: 'http://x/a' });
    const b0 = codeSystem({ url: 'http://x/t', version: '1', supplements: 'http://x/b' });
    const b2 = codeSystem({ url: 'http://x/s', version: '2', supplements: 'http://x/b' });
    m.set('k', a1);
    m.set('t', b0);
    m.set('k', b2); // same key, now supplements b; Map keeps 'k' before 't'
    expect(m.supplementsOf('http://x/a')).toEqual([]);
    expect(m.supplementsOf('http://x/b')).toEqual([b2, b0]);
    expect([...m.values()]).toEqual([b2, b0]);
    m.delete('k');
    expect(m.supplementsOf('http://x/b')).toEqual([b0]);
    m.set('k', a1); // deleted and added again: now last, as in the Map
    m.set('k2', codeSystem({ url: 'http://x/u', supplements: 'http://x/a' }));
    expect(m.supplementsOf('http://x/a').map(c => c.url)).toEqual(['http://x/s', 'http://x/u']);
    m.clear();
    expect(m.supplementsOf('http://x/a')).toEqual([]);
    expect(m.supplementIndex.size).toBe(0);
    expect(m.indexedUnder.size).toBe(0);
  });

  test('a value that is replaced is removed from the index under the url it was indexed under', () => {
    const m = new CodeSystemMap();
    const s = codeSystem({ url: 'http://x/s', supplements: 'http://x/a' });
    m.set('k', s);
    m.set('k', codeSystem({ url: 'http://x/plain', content: 'complete' }));
    expect(m.supplementsOf('http://x/a')).toEqual([]);
    expect(m.supplementIndex.size).toBe(0);
  });

  test('behaves as a Map', () => {
    const a = codeSystem({ url: 'http://x/a', version: '1', content: 'complete' });
    const m = new CodeSystemMap([['a', a]]);
    expect(m.get('a')).toBe(a);
    expect(m.size).toBe(1);
    expect(m instanceof Map).toBe(true);
    expect(m.delete('nope')).toBe(false);
    expect(m.delete('a')).toBe(true);
    expect(m.size).toBe(0);
  });
});

describe('loadSupplements: the index gives what the scan gave', () => {
  // a small deterministic generator, so a failure can be replayed
  function rng(seed) {
    let s = seed >>> 0;
    return (n) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s >>> 16) % n; };
  }

  const TARGETS = ['http://x/a', 'http://x/b', 'http://x/a/sub'];
  const SUPPLEMENTS_VALUES = [
    'http://x/a', 'http://x/a|1.0.0', 'http://x/a|2.0.0', 'http://x/a|1', 'http://x/b', 'http://x/b|1.0.0',
    'http://x/a/sub', 'http://x/a/sub|2.0.0'
  ];
  const PACKAGES = [undefined, 'hl7.terminology.r4#6.0.2', 'hl7.fhir.r4.core#4.0.1', 'example.ig#1.0.0'];

  function randomCodeSystem(r) {
    const supp = r(6) > 0;
    return codeSystem({
      url: `http://s/${1 + r(4)}`,
      version: [undefined, '1.0.0', '2.0.0', '3.0.0'][r(4)],
      // a code system can carry supplements without being a supplement: the index takes it in,
      // and isSupplementFor turns it away, as the scan did
      content: supp ? (r(5) ? 'supplement' : 'complete') : 'complete',
      supplements: supp ? SUPPLEMENTS_VALUES[r(SUPPLEMENTS_VALUES.length)] : undefined,
      global: r(2) === 0,
      sourcePackage: PACKAGES[r(PACKAGES.length)]
    });
  }

  const QUESTIONS = [];
  for (const url of [...TARGETS, 'http://x/a|1.0.0', 'http://x/c']) {
    for (const version of ['', '1.0.0', '2.0.0', '1']) {
      for (const stated of [null, new Set(['http://s/1']), new Set(['http://s/2|1.0.0', 'http://s/3'])]) {
        QUESTIONS.push([url, version, stated]);
      }
    }
  }

  function compare(scan, index) {
    for (const [url, version, stated] of QUESTIONS) {
      const expected = scan.loadSupplements(url, version, stated);
      const actual = index.loadSupplements(url, version, stated);
      expect(actual.length).toBe(expected.length);
      actual.forEach((cs, i) => expect(cs).toBe(expected[i]));
    }
  }

  test.each([1, 2, 3, 4, 5, 6, 7, 8])('random add/delete sequences through the Provider (seed %i)', (seed) => {
    const r = rng(seed);
    const scan = provider(new Map());
    const index = provider(new CodeSystemMap());
    const added = [];
    let nonEmpty = 0;
    for (let step = 0; step < 150; step++) {
      const op = r(10);
      if (op < 6 || added.length === 0) {
        const cs = randomCodeSystem(r);
        added.push(cs);
        scan.addCodeSystem(cs);
        index.addCodeSystem(cs);
      } else {
        const cs = added.splice(r(added.length), 1)[0];
        scan.deleteCodeSystem(cs);
        index.deleteCodeSystem(cs);
      }
      expect([...index.codeSystems.entries()]).toEqual([...scan.codeSystems.entries()]);
      compare(scan, index);
      if (QUESTIONS.some(([u, v, s]) => scan.loadSupplements(u, v, s).length > 0)) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThan(50); // the sequences did find supplements, not only empty lists
  });

  test.each([11, 12, 13, 14])('random set/delete/clear on the map itself, any key (seed %i)', (seed) => {
    const r = rng(seed);
    const scan = provider(new Map());
    const index = provider(new CodeSystemMap());
    const keys = ['k1', 'k2', 'k3', 'k4', 'k5', 'http://x/a', 'http://s/1', 'http://s/1|1.0.0'];
    for (let step = 0; step < 200; step++) {
      const op = r(20);
      const k = keys[r(keys.length)];
      if (op === 0) {
        scan.codeSystems.clear();
        index.codeSystems.clear();
      } else if (op < 6) {
        expect(index.codeSystems.delete(k)).toBe(scan.codeSystems.delete(k));
      } else {
        const cs = randomCodeSystem(r);
        scan.codeSystems.set(k, cs);
        index.codeSystems.set(k, cs);
      }
      expect([...index.codeSystems.entries()]).toEqual([...scan.codeSystems.entries()]);
      compare(scan, index);
    }
  });

  test('a supplement re-added with another supplements url: found under the new one only', () => {
    const scan = provider(new Map());
    const index = provider(new CodeSystemMap());
    const v1 = codeSystem({ url: 'http://s/1', version: '1.0.0', supplements: 'http://x/a', global: true });
    const v1b = codeSystem({ url: 'http://s/1', version: '1.0.0', supplements: 'http://x/b', global: true });
    for (const p of [scan, index]) {
      p.addCodeSystem(v1);
      p.deleteCodeSystem(v1);
      p.addCodeSystem(v1b);
    }
    compare(scan, index);
    expect(index.loadSupplements('http://x/a', '', null)).toEqual([]);
    expect(index.loadSupplements('http://x/b', '', null)).toEqual([v1b]);
  });

  test('a supplement pinned to a version: found only for that version, or when no version is asked', () => {
    const p = provider(new CodeSystemMap());
    const s = codeSystem({ url: 'http://s/1', version: '1.0.0', supplements: 'http://x/a|2.0.0', global: true });
    p.addCodeSystem(s);
    expect(p.loadSupplements('http://x/a', '2.0.0', null)).toEqual([s]);
    expect(p.loadSupplements('http://x/a', '1.0.0', null)).toEqual([]);
    expect(p.loadSupplements('http://x/a', '', null)).toEqual([]); // as isSupplementFor says
    expect(p.loadSupplements('http://x/a|2.0.0', '', null)).toEqual([s]); // supplements === url
  });

  // The one difference: CodeSystem.isSupplementFor throws on a code system marked as a supplement
  // with no supplements element, so with one of those loaded the scan threw on every lookup of
  // every code system. The index never offers it, so it is skipped.
  test('a supplement with no supplements element: the scan threw on every lookup; the index skips it', () => {
    const broken = codeSystem({ url: 'http://s/broken', content: 'supplement' });
    const good = codeSystem({ url: 'http://s/1', supplements: 'http://x/a', global: true });
    const scan = provider(new Map());
    const index = provider(new CodeSystemMap());
    for (const p of [scan, index]) {
      p.addCodeSystem(broken);
      p.addCodeSystem(good);
    }
    expect(() => scan.loadSupplements('http://x/a', '', null)).toThrow(TypeError);
    expect(index.loadSupplements('http://x/a', '', null)).toEqual([good]);
  });
});
