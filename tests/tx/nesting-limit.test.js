/**
 * Nesting depth limits on self-recursive resource structures.
 *
 * CodeSystem.concept and ValueSet.expansion.contains both nest without limit in FHIR,
 * and both are walked recursively in a dozen places. A hostile resource of a few
 * hundred KB could blow the JS stack; worse, `JSON.stringify` itself overflows at a
 * nesting depth of roughly 1800, so no amount of hardening our own walkers would have
 * been enough. The nesting is therefore bounded once, at construction, and everything
 * downstream is safe by construction.
 *
 * The tests that matter most here are the ones using a tree deep enough to overflow a
 * recursive walker: they assert we get our own error and not a RangeError, which is
 * the whole point of the exercise.
 */

const { MAX_NESTING_DEPTH, countNested } = require('../../tx/library/nesting-limit');
const { CodeSystem } = require('../../tx/library/codesystem');
const ValueSet = require('../../tx/library/valueset');

/** A chain of `depth` items nested through `childProperty`, returned as a 1-item array. */
function chain(depth, childProperty, makeItem = (i) => ({ code: 'c' + i })) {
  const root = makeItem(0);
  let cur = root;
  for (let i = 1; i < depth; i++) {
    const child = makeItem(i);
    cur[childProperty] = [child];
    cur = child;
  }
  return [root];
}

const containsItem = (i) => ({ system: 'http://x/cs', code: 'c' + i });

function valueSetNested(depth) {
  return {
    resourceType: 'ValueSet', url: 'http://x/vs', version: '1', status: 'active',
    expansion: { contains: chain(depth, 'contains', containsItem) }
  };
}

function codeSystemNested(depth) {
  return {
    resourceType: 'CodeSystem', url: 'http://x/cs', version: '1', status: 'active',
    content: 'complete', concept: chain(depth, 'concept')
  };
}

// A depth that reliably overflows a recursive walker (measured: new ValueSet died at
// ~2559, JSON.stringify at ~1828). Nothing here should ever produce a RangeError.
const OVERFLOWING = 50000;

describe('countNested', () => {
  test('counts a flat list', () => {
    expect(countNested([{}, {}, {}], 'concept', 'x')).toBe(3);
  });

  test('counts nested entries', () => {
    expect(countNested(chain(10, 'concept'), 'concept', 'x')).toBe(10);
  });

  test('counts a wide tree with mixed depths', () => {
    const items = [
      { code: 'a', concept: [{ code: 'a1' }, { code: 'a2', concept: [{ code: 'a2i' }] }] },
      { code: 'b' }
    ];
    expect(countNested(items, 'concept', 'x')).toBe(5);
  });

  test('treats a non-array as empty', () => {
    expect(countNested(undefined, 'concept', 'x')).toBe(0);
    expect(countNested(null, 'concept', 'x')).toBe(0);
    expect(countNested({ code: 'a' }, 'concept', 'x')).toBe(0);
  });

  test('tolerates null entries and empty child arrays', () => {
    expect(countNested([null, { code: 'a', concept: [] }], 'concept', 'x')).toBe(2);
  });

  test(`allows exactly ${MAX_NESTING_DEPTH} levels`, () => {
    expect(countNested(chain(MAX_NESTING_DEPTH, 'concept'), 'concept', 'x')).toBe(MAX_NESTING_DEPTH);
  });

  test(`rejects ${MAX_NESTING_DEPTH + 1} levels`, () => {
    expect(() => countNested(chain(MAX_NESTING_DEPTH + 1, 'concept'), 'concept', 'CodeSystem.concept'))
      .toThrow(/CodeSystem\.concept is nested more than 100 levels deep/);
  });

  test('checks depth per branch, not per resource', () => {
    // 50 siblings each 50 deep is 2500 entries but only 50 levels: legal.
    const items = [];
    for (let i = 0; i < 50; i++) {
      items.push(chain(50, 'concept')[0]);
    }
    expect(countNested(items, 'concept', 'x')).toBe(2500);
  });

  test('rejects a tree deep enough to overflow a recursive walker, without recursing itself', () => {
    let err;
    try {
      countNested(chain(OVERFLOWING, 'concept'), 'concept', 'CodeSystem.concept');
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(RangeError);
    expect(err.message).toMatch(/nested more than 100 levels deep/);
  });

  test('the error asks for a 400, not the default 500', () => {
    try {
      countNested(chain(MAX_NESTING_DEPTH + 1, 'concept'), 'concept', 'x');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.statusCode).toBe(400);
      expect(e.issueCode).toBe('structure');
    }
  });
});

describe('ValueSet expansion nesting', () => {
  test(`accepts an expansion ${MAX_NESTING_DEPTH} levels deep`, () => {
    const vs = new ValueSet(valueSetNested(MAX_NESTING_DEPTH));
    expect(vs.conceptCount()).toBe(MAX_NESTING_DEPTH);
    expect(vs.codeMap.size).toBe(MAX_NESTING_DEPTH);
  });

  test(`rejects an expansion ${MAX_NESTING_DEPTH + 1} levels deep`, () => {
    expect(() => new ValueSet(valueSetNested(MAX_NESTING_DEPTH + 1)))
      .toThrow(/Invalid ValueSet: expansion\.contains is nested more than 100 levels deep/);
  });

  test('rejects a hostile expansion instead of overflowing the stack', () => {
    let err;
    try {
      new ValueSet(valueSetNested(OVERFLOWING));
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(RangeError);
    expect(err.statusCode).toBe(400);
  });

  test('still counts compose concepts alongside a legal expansion', () => {
    const vs = new ValueSet({
      resourceType: 'ValueSet', url: 'http://x/vs', version: '1', status: 'active',
      compose: { include: [{ system: 'http://x/cs', concept: [{ code: 'a' }, { code: 'b' }] }] },
      expansion: {
        contains: [
          { system: 'http://x/cs', code: 'a', contains: [{ system: 'http://x/cs', code: 'b' }] },
          { system: 'http://x/cs', code: 'c' }
        ]
      }
    });
    expect(vs.conceptCount()).toBe(5);
  });

  test('a value set with no expansion is unaffected', () => {
    const vs = new ValueSet({
      resourceType: 'ValueSet', url: 'http://x/vs', version: '1', status: 'active',
      compose: { include: [{ system: 'http://x/cs', concept: [{ code: 'a' }] }] }
    });
    expect(vs.conceptCount()).toBe(1);
  });
});

describe('CodeSystem concept nesting', () => {
  test(`accepts concepts ${MAX_NESTING_DEPTH} levels deep`, () => {
    const cs = new CodeSystem(codeSystemNested(MAX_NESTING_DEPTH));
    expect(cs.conceptCount()).toBe(MAX_NESTING_DEPTH);
  });

  test(`rejects concepts ${MAX_NESTING_DEPTH + 1} levels deep`, () => {
    expect(() => new CodeSystem(codeSystemNested(MAX_NESTING_DEPTH + 1)))
      .toThrow(/Invalid CodeSystem: concept is nested more than 100 levels deep/);
  });

  test('names the offending resource, and keeps the 400 through the rewrap', () => {
    try {
      new CodeSystem(codeSystemNested(MAX_NESTING_DEPTH + 1));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.message).toMatch(/\(in http:\/\/x\/cs\|1\)$/);
      expect(e.statusCode).toBe(400);
      expect(e.issueCode).toBe('structure');
    }
  });

  test('the check runs even when map building is skipped (noMaps)', () => {
    // noMaps bypasses validate(), but the concept tree is still walked later, so the
    // bound has to hold on this path too.
    expect(() => new CodeSystem(codeSystemNested(MAX_NESTING_DEPTH + 1), 'R5', true))
      .toThrow(/nested more than 100 levels deep/);
    const cs = new CodeSystem(codeSystemNested(MAX_NESTING_DEPTH), 'R5', true);
    expect(cs.conceptCount()).toBe(MAX_NESTING_DEPTH);
  });

  test('rejects a hostile concept tree instead of overflowing the stack', () => {
    let err;
    try {
      new CodeSystem(codeSystemNested(OVERFLOWING));
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err).not.toBeInstanceOf(RangeError);
    expect(err.statusCode).toBe(400);
  });
});
