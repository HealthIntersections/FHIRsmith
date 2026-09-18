/**
 * ConceptMap R3/R4 <-> R5 conversion of equivalence / relationship.
 *
 * The two vocabularies describe the mapping from opposite ends: R4 equivalence says
 * what the TARGET is ('wider' = target is wider than the source), R5 relationship says
 * what the SOURCE is ('source-is-narrower-than-target'). These expectations are the
 * Java convertors' tables (ConceptMap40_50 / ConceptMap30_50), which are the reference.
 */

const { conceptMapToR5, conceptMapFromR5 } = require('../../tx/xversion/xv-conceptmap');

function r4Map(equivalences) {
  return {
    resourceType: 'ConceptMap',
    group: [{
      source: 'http://example.org/src',
      target: 'http://example.org/tgt',
      element: equivalences.map((eq, i) => ({ code: `s${i}`, target: [{ code: `t${i}`, equivalence: eq }] }))
    }]
  };
}

function r5Map(relationships) {
  return {
    resourceType: 'ConceptMap',
    group: [{
      source: 'http://example.org/src',
      target: 'http://example.org/tgt',
      element: relationships.map((rel, i) => ({ code: `s${i}`, target: [{ code: `t${i}`, relationship: rel }] }))
    }]
  };
}

const targets = cm => cm.group[0].element.map(e => e.target[0]);

describe('ConceptMap equivalence -> relationship (R3/R4 -> R5)', () => {
  const table = [
    ['relatedto', 'related-to'],
    ['equivalent', 'equivalent'],
    ['equal', 'equivalent'],
    ['wider', 'source-is-narrower-than-target'],
    ['subsumes', 'source-is-narrower-than-target'],
    ['narrower', 'source-is-broader-than-target'],
    ['specializes', 'source-is-broader-than-target'],
    ['inexact', 'related-to'],
    ['disjoint', 'not-related-to']
  ];

  for (const version of ['4.0.1', '3.0.2']) {
    test.each(table)(`R${version[0]} %s -> %s`, (equivalence, relationship) => {
      const t = targets(conceptMapToR5(r4Map([equivalence]), version))[0];
      expect(t.relationship).toBe(relationship);
    });
  }

  test('a target-less unmatched is lifted to noMap, not converted', () => {
    const cm = conceptMapToR5({
      resourceType: 'ConceptMap',
      group: [{ element: [{ code: 'a', target: [{ equivalence: 'unmatched' }] }] }]
    }, '4.0.1');
    expect(cm.group[0].element[0].noMap).toBe(true);
    expect(cm.group[0].element[0].target).toBeUndefined();
  });
});

describe('ConceptMap relationship -> equivalence (R5 -> R3/R4)', () => {
  const table = [
    ['related-to', 'relatedto'],
    ['equivalent', 'equivalent'],
    ['source-is-narrower-than-target', 'wider'],
    ['source-is-broader-than-target', 'narrower'],
    ['not-related-to', 'disjoint']
  ];

  for (const version of ['4.0.1', '3.0.2']) {
    test.each(table)(`R${version[0]} %s -> %s`, (relationship, equivalence) => {
      const t = targets(conceptMapFromR5(r5Map([relationship]), version))[0];
      expect(t.equivalence).toBe(equivalence);
      expect(t.relationship).toBeUndefined();
    });
  }

  test('R5 output is untouched', () => {
    const cm = r5Map(['source-is-narrower-than-target']);
    expect(targets(conceptMapFromR5(cm, '5.0.0'))[0].relationship).toBe('source-is-narrower-than-target');
  });
});

describe('round trip', () => {
  test.each(['related-to', 'equivalent', 'source-is-narrower-than-target', 'source-is-broader-than-target', 'not-related-to'])(
    'R5 %s survives R5 -> R4 -> R5', rel => {
      const r4 = conceptMapFromR5(r5Map([rel]), '4.0.1');
      expect(targets(conceptMapToR5(r4, '4.0.1'))[0].relationship).toBe(rel);
    });
});
