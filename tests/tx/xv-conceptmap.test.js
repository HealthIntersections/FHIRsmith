/**
 * ConceptMap R3/R4 <-> R5 conversion of equivalence / relationship.
 *
 * The two vocabularies describe the mapping from opposite ends: R4 equivalence says
 * what the TARGET is ('wider' = target is wider than the source), R5 relationship says
 * what the SOURCE is ('source-is-narrower-than-target'). These expectations are the
 * Java convertors' tables (ConceptMap40_50 / ConceptMap30_50), which are the reference.
 */

const { conceptMapToR5, conceptMapFromR5 } = require('../../tx/xversion/xv-conceptmap');
const { parametersFromR5 } = require('../../tx/xversion/xv-parameters');
const { Renderer } = require('../../tx/library/renderer');
const { OperationContext } = require('../../tx/operation-context');
const { Languages } = require('../../library/languages');
const { TestUtilities } = require('../test-utilities');

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

// $translate builds its match parts from the R5 form of the map (relationship, plus the
// original equivalence when the map came from R3/R4); the Parameters convertor then
// shapes them for the client's version.
describe('$translate match parts across versions', () => {
  function matchFor(target) {
    const parts = [{ name: 'relationship', valueCode: target.relationship }];
    if (target.equivalence) {
      parts.push({ name: 'equivalence', valueCode: target.equivalence });
    }
    return { resourceType: 'Parameters', parameter: [{ name: 'match', part: parts }] };
  }
  const part = (params, name) => (params.parameter[0].part.find(p => p.name === name) || {}).valueCode;

  test('an R5 map (source-is-narrower-than-target) reaches an R4 client as wider', () => {
    const t = targets(r5Map(['source-is-narrower-than-target']))[0];
    const out = parametersFromR5(matchFor(t), '4.0.1');
    expect(part(out, 'equivalence')).toBe('wider');
    expect(part(out, 'relationship')).toBeUndefined();
  });

  test('an R4 map (wider) carries source-is-narrower-than-target for an R5 client', () => {
    const t = targets(conceptMapToR5(r4Map(['wider']), '4.0.1'))[0];
    const out = parametersFromR5(matchFor(t), '5.0.0');
    expect(part(out, 'relationship')).toBe('source-is-narrower-than-target');
  });

  test('an R4 map reaches an R4 client with its own equivalence', () => {
    const t = targets(conceptMapToR5(r4Map(['narrower']), '4.0.1'))[0];
    const out = parametersFromR5(matchFor(t), '4.0.1');
    expect(part(out, 'equivalence')).toBe('narrower');
  });
});

// The renderer prefers relationship over equivalence, so an R4 map shown on any endpoint
// is described by the converted value - this is where the inversion was visible.
describe('rendering an R4 ConceptMap', () => {
  let renderer;

  beforeAll(async () => {
    const langDefs = await TestUtilities.loadLanguageDefinitions();
    const i18n = await TestUtilities.loadTranslations(langDefs);
    renderer = new Renderer(new OperationContext(Languages.fromAcceptLanguage('en-US', langDefs), i18n));
  });

  test.each([
    ['wider', 'is narrower than', 'is broader than'],
    ['narrower', 'is broader than', 'is narrower than']
  ])('%s is described as "%s"', async (equivalence, expected, notExpected) => {
    const cm = conceptMapToR5({ ...r4Map([equivalence]), url: 'http://example.org/cm', status: 'active' }, '4.0.1');
    const html = await renderer.renderConceptMap(cm);
    expect(html).toContain(expected);
    expect(html).not.toContain(notExpected);
  });
});
