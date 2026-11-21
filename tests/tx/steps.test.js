// tx/library/steps.js, and what uses it: a large CodeSystem a client sends (tx-resource)
// checked, indexed and hashed without holding the event loop (CodeSystem.createAsync,
// CanonicalResource.computeExpansionKeyHashAsync)

const fs = require('fs');
const path = require('path');
const { runSteps, runStepsAsync, jsonPieces, PAUSE_EVERY } = require('../../tx/library/steps');
const { CodeSystem } = require('../../tx/library/codesystem');
const ValueSet = require('../../tx/library/valueset');
const { CanonicalResource } = require('../../tx/library/canonical-resource');

const joined = (v) => [...jsonPieces(v)].join('');

// a code system of `breadth` top-level concepts, each `depth` deep with `fan` children a level
function bigCodeSystem(breadth = 3, depth = 3, fan = 12) {
  let n = 0;
  const make = (level) => {
    const c = { code: 'c' + (n++), display: 'Concept ' + n, designation: [{ language: 'de', value: 'Begriff ' + n }],
      property: [{ code: 'status', valueCode: 'active' }] };
    if (level < depth) {
      c.concept = Array.from({ length: fan }, () => make(level + 1));
    }
    return c;
  };
  return { resourceType: 'CodeSystem', url: 'http://example.org/big', version: '1', status: 'active', content: 'complete',
    property: [{ code: 'status', type: 'code' }],
    concept: Array.from({ length: breadth }, () => make(1)) };
}

describe('jsonPieces', () => {
  test('joined, they are JSON.stringify', () => {
    const cases = [
      bigCodeSystem(),
      bigCodeSystem(1, 6, 2), // one root with everything under it
      { resourceType: 'ValueSet', compose: { include: [{ system: 's', concept: Array.from({ length: 40 }, (_, i) => ({ code: 'x' + i })) }] },
        expansion: { contains: [{ code: 'a', contains: [{ code: 'b', contains: [{ code: 'c' }] }] }] } },
      { a: [1, undefined, () => 1, Symbol('s'), null, NaN, 'é ✓ "q"\n'], b: undefined, c: () => 2, d: new Date(0),
        e: [], f: {}, g: { concept: [] }, h: Array.from({ length: 20 }, (_, i) => (i % 2 ? { k: i, u: undefined } : [i])) },
      [], {}, 'text', 3, null, true
    ];
    for (const c of cases) {
      expect(joined(c)).toBe(JSON.stringify(c));
    }
  });

  test('a tree of concepts comes in many pieces, not one', () => {
    expect([...jsonPieces(bigCodeSystem(1, 6, 2))].length).toBeGreaterThan(50);
  });

  const icd = path.join(__dirname, '../../data/terminology-cache/fhir.tx.support#1.0.5/package/CodeSystem-icd-10-cm.json');
  (fs.existsSync(icd) ? test : test.skip)('the full ICD-10-CM', () => {
    const json = JSON.parse(fs.readFileSync(icd, 'utf8'));
    let longest = 0;
    let text = '';
    for (const p of jsonPieces(json)) {
      longest = Math.max(longest, p.length);
      text += p;
    }
    expect(text).toBe(JSON.stringify(json));
    // a chapter at most, not the whole thing
    expect(longest).toBeLessThan(text.length / 10);
  });
});

describe('runSteps and runStepsAsync', () => {
  function* steps(n, fail = -1) {
    for (let i = 0; i < n; i++) {
      if (i === fail) {
        throw new Error('step ' + i);
      }
      yield;
    }
    return 'done';
  }

  test('both run to the end and return what the steps do', async () => {
    expect(runSteps(steps(10))).toBe('done');
    expect(await runStepsAsync(steps(10))).toBe('done');
  });

  test('pause is called every so many steps', async () => {
    let pauses = 0;
    await runStepsAsync(steps(PAUSE_EVERY * 3 + 5), async () => { pauses++; });
    expect(pauses).toBe(3);
  });

  test('onError turns the steps\' errors, not pause\'s', async () => {
    const onError = (e) => new Error('wrapped: ' + e.message);
    await expect(runStepsAsync(steps(10, 4), null, onError)).rejects.toThrow('wrapped: step 4');
    const stop = new Error('out of time');
    await expect(runStepsAsync(steps(PAUSE_EVERY * 2), async () => { throw stop; }, onError)).rejects.toBe(stop);
  });
});

describe('CodeSystem.createAsync', () => {
  test('the same code system the constructor makes, and its hash already worked out', async () => {
    const json = bigCodeSystem();
    const expected = new CodeSystem(structuredClone(json));
    let pauses = 0;
    const cs = await CodeSystem.createAsync(structuredClone(json), 'R5', async () => { pauses++; });
    expect(pauses).toBeGreaterThan(0);
    expect([...cs.codeMap.keys()]).toEqual([...expected.codeMap.keys()]);
    expect([...cs.displayMap.keys()]).toEqual([...expected.displayMap.keys()]);
    expect([...cs.parentToChildrenMap.entries()]).toEqual([...expected.parentToChildrenMap.entries()]);
    expect([...cs.childToParentsMap.entries()]).toEqual([...expected.childToParentsMap.entries()]);
    expect(cs.hasMultiHierarchy).toBe(expected.hasMultiHierarchy);
    expect(cs.conceptCount()).toBe(expected.conceptCount());
    expect(cs._expansionKeyHashMemo.hash).toBe(expected.expansionKeyHash());
    expect(cs.expansionKeyHash()).toBe(CanonicalResource.computeExpansionKeyHash(cs.jsonObj));
  });

  test('an R4 code system, as the constructor converts it', async () => {
    const json = { resourceType: 'CodeSystem', url: 'http://example.org/r3', status: 'active', content: 'complete',
      identifier: { system: 'urn:x', value: '1' }, concept: [{ code: 'a' }] };
    const cs = await CodeSystem.createAsync(structuredClone(json), 'R3');
    expect(cs.jsonObj).toEqual(new CodeSystem(structuredClone(json), 'R3').jsonObj);
  });

  test('the same errors as the constructor', async () => {
    const bad = [
      { resourceType: 'CodeSystem', url: 'http://example.org/bad', status: 'active', concept: [{ code: 'a', concept: [{ display: 'no code' }] }] },
      { resourceType: 'CodeSystem', url: 'http://example.org/bad', status: 'active', concept: [{ code: 'a', property: [{}] }] },
      { resourceType: 'CodeSystem', url: 'http://example.org/bad', status: 'active', concept: 'x' },
      { resourceType: 'ValueSet', url: 'http://example.org/bad' }
    ];
    for (const json of bad) {
      let expected = null;
      try {
        new CodeSystem(structuredClone(json));
      } catch (e) {
        expected = e.message;
      }
      expect(expected).not.toBeNull();
      await expect(CodeSystem.createAsync(structuredClone(json))).rejects.toThrow(expected);
    }
  });

  test('a contained resource is refused, as by the constructor', async () => {
    const json = { resourceType: 'CodeSystem', url: 'http://example.org/c', status: 'active', content: 'complete',
      contained: [{ resourceType: 'ValueSet', id: 'v' }], concept: [{ code: 'a' }] };
    expect(() => new CodeSystem(structuredClone(json))).toThrow();
    await expect(CodeSystem.createAsync(structuredClone(json))).rejects.toThrow();
  });

  test('stops when pause says to (out of time, or the client has gone)', async () => {
    const stop = new Error('out of time');
    await expect(CodeSystem.createAsync(bigCodeSystem(), 'R5', async () => { throw stop; })).rejects.toBe(stop);
  });
});

describe('prepareExpansionKeyHash', () => {
  test('the hash expansionKeyHash would work out', async () => {
    const vs = new ValueSet({ resourceType: 'ValueSet', url: 'http://example.org/vs', status: 'active',
      compose: { include: [{ system: 'http://example.org/big', concept: Array.from({ length: 100 }, (_, i) => ({ code: 'c' + i })) }] } });
    const expected = CanonicalResource.computeExpansionKeyHash(vs.jsonObj);
    expect(await vs.prepareExpansionKeyHash(async () => {})).toBe(expected);
    expect(vs.expansionKeyHash()).toBe(expected);
  });
});
