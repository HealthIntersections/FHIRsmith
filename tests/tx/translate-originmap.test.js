const TranslateWorker = require('../../tx/workers/translate');

/**
 * Issue #247: $translate emitted `originMap` keyed to *direction* rather than
 * explicitness — a dropped 8th argument meant `reverse` landed in the `explicit`
 * slot, so forward always emitted it and reverse never did. The chosen policy is
 * "always emit": originMap (the versioned canonical of the contributing map)
 * should be present for every match, in both directions.
 *
 * These call the helpers directly via the prototype (no provider/sqlite needed);
 * they use only cm.listGroupsInScope(...)/listTranslationsReverse(...), cm.vurl
 * and this.hasMatch.
 *
 * The forward helper walks groups rather than pre-matched translations, so that each
 * group's own group.unmapped can be consulted when that group has no element for the
 * concept - hence the stub exposes listGroupsInScope, and the helper is async.
 */

const CM_VURL = 'http://hl7.org/fhir/ConceptMap/example|1.0.0';

function stubCm() {
  return {
    vurl: CM_VURL,
    listGroupsInScope() {
      return [{
        source: 'http://example.org/source',
        target: 'http://example.org/target',
        element: [{ code: 'S', target: [{ code: 'T', relationship: 'equivalent', equivalence: 'equal' }] }]
      }];
    },
    listTranslationsReverse() {
      return [{
        group: { source: 'http://example.org/source', target: 'http://example.org/target' },
        match: { code: 'S' },
        target: { code: 'T', relationship: 'equivalent', equivalence: 'equal' }
      }];
    }
  };
}

function worker() {
  return Object.create(TranslateWorker.prototype);
}

function originMapOf(output) {
  const match = output.find(o => o.name === 'match');
  if (!match) return undefined;
  const om = match.part.find(p => p.name === 'originMap');
  return om && om.valueCanonical;
}

describe('$translate originMap is emitted in both directions (issue #247)', () => {
  test('forward translate emits originMap (versioned canonical)', async () => {
    const output = [];
    const added = await worker().translateUsingGroupsForwards(
      stubCm(), { system: 'http://example.org/source', code: 'S' }, null, null, null, output);
    expect(added).toBe(true);
    expect(originMapOf(output)).toBe(CM_VURL);
  });

  test('reverse translate also emits originMap (previously never did)', () => {
    const output = [];
    const added = worker().translateUsingGroupsReverse(
      stubCm(), { system: 'http://example.org/target', code: 'T' }, null, null, null, output);
    expect(added).toBe(true);
    expect(originMapOf(output)).toBe(CM_VURL);
  });

  test('neither helper takes an explicit/reverse trailing arg', () => {
    // The trailing arguments that do exist are about map chaining, not direction:
    // forwards is (cm, coding, targetScope, targetSystem, params, output, origin, visited),
    // where origin carries the start of an unmapped.otherMap chain and visited guards it.
    // Reverse remains (cm, coding, targetScope, targetSystem, params, output).
    expect(TranslateWorker.prototype.translateUsingGroupsForwards.length).toBe(8);
    expect(TranslateWorker.prototype.translateUsingGroupsReverse.length).toBe(6);
  });
});
