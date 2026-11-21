/**
 * conceptCount() tests for CodeSystem, ValueSet, ConceptMap.
 *
 * conceptCount() is precalculated at construction and gives a cheap O(1) sense of
 * how large a cached resource is (used by cache sizing/limits). It counts the
 * concepts *present in the resource*, not the size of a value set's full expansion.
 */

const { CodeSystem } = require('../../tx/library/codesystem');
const ValueSet = require('../../tx/library/valueset');
const { ConceptMap } = require('../../tx/library/conceptmap');

describe('CodeSystem.conceptCount()', () => {
  test('counts a flat concept list', () => {
    const cs = new CodeSystem({
      resourceType: 'CodeSystem', url: 'http://x/cs', version: '1', status: 'active', content: 'complete',
      concept: [{ code: 'a' }, { code: 'b' }, { code: 'c' }]
    });
    expect(cs.conceptCount()).toBe(3);
  });

  test('counts nested concepts recursively', () => {
    const cs = new CodeSystem({
      resourceType: 'CodeSystem', url: 'http://x/cs', version: '1', status: 'active', content: 'complete',
      concept: [
        { code: 'a', concept: [{ code: 'a1' }, { code: 'a2', concept: [{ code: 'a2i' }] }] },
        { code: 'b' }
      ]
    });
    // a, a1, a2, a2i, b = 5
    expect(cs.conceptCount()).toBe(5);
  });

  test('is 0 when there are no concepts (e.g. not-present / grammar systems)', () => {
    const cs = new CodeSystem({
      resourceType: 'CodeSystem', url: 'http://x/cs', version: '1', status: 'active', content: 'not-present'
    });
    expect(cs.conceptCount()).toBe(0);
  });
});

describe('ValueSet.conceptCount()', () => {
  test('counts enumerated concepts in compose include and exclude', () => {
    const vs = new ValueSet({
      resourceType: 'ValueSet', url: 'http://x/vs', status: 'active',
      compose: {
        include: [{ system: 'http://x/cs', concept: [{ code: 'a' }, { code: 'b' }, { code: 'c' }] }],
        exclude: [{ system: 'http://x/cs', concept: [{ code: 'c' }] }]
      }
    });
    expect(vs.conceptCount()).toBe(4); // 3 include + 1 exclude
  });

  test('counts an inline expansion (contains) recursively', () => {
    const vs = new ValueSet({
      resourceType: 'ValueSet', url: 'http://x/vs', status: 'active',
      expansion: {
        contains: [
          { system: 'http://x/cs', code: 'a' },
          { system: 'http://x/cs', code: 'b', contains: [{ system: 'http://x/cs', code: 'b1' }] }
        ]
      }
    });
    expect(vs.conceptCount()).toBe(3); // a, b, b1
  });

  test('counts compose + inline expansion together', () => {
    const vs = new ValueSet({
      resourceType: 'ValueSet', url: 'http://x/vs', status: 'active',
      compose: { include: [{ system: 'http://x/cs', concept: [{ code: 'a' }] }] },
      expansion: { contains: [{ system: 'http://x/cs', code: 'a' }, { system: 'http://x/cs', code: 'b' }] }
    });
    expect(vs.conceptCount()).toBe(3); // 1 compose + 2 expansion
  });

  test('is 0 for an include-by-system with no enumerated concepts', () => {
    const vs = new ValueSet({
      resourceType: 'ValueSet', url: 'http://x/vs', status: 'active',
      compose: { include: [{ system: 'urn:ietf:bcp:13' }] }
    });
    expect(vs.conceptCount()).toBe(0);
  });
});

describe('ConceptMap.conceptCount()', () => {
  test('counts elements plus targets across groups', () => {
    const cm = new ConceptMap({
      resourceType: 'ConceptMap', url: 'http://x/cm', status: 'active',
      group: [
        {
          source: 'http://x/cs1', target: 'http://x/cs2',
          element: [
            { code: 'a', target: [{ code: 'A', relationship: 'equivalent' }] },
            { code: 'b', target: [{ code: 'B1', relationship: 'equivalent' }, { code: 'B2', relationship: 'equivalent' }] }
          ]
        }
      ]
    });
    // elements: a, b (2) + targets: A, B1, B2 (3) = 5
    expect(cm.conceptCount()).toBe(5);
  });

  test('is 0 with no groups', () => {
    const cm = new ConceptMap({
      resourceType: 'ConceptMap', url: 'http://x/cm', status: 'active'
    });
    expect(cm.conceptCount()).toBe(0);
  });
});
