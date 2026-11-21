// The conversions from R5 copy only what they change, and never change what they're given
// (tx/xversion/xv-shared.js)

const { codeSystemFromR5 } = require('../../tx/xversion/xv-codesystem');
const { valueSetFromR5 } = require('../../tx/xversion/xv-valueset');
const { mapShared, CS_ADDITIONAL_USE_EXT, VS_ADDITIONAL_USE_EXT } = require('../../tx/xversion/xv-shared');

// frozen all the way down. A change to it throws in strict code, and is silently ignored in
// sloppy code (the converters aren't strict) - so the tests below also check that converting a
// frozen resource gives the same result as converting one that isn't
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) {
      deepFreeze(o[k]);
    }
  }
  return o;
}

const additionalUse = { system: 'http://snomed.info/sct', code: '900000000000013009', display: 'Synonym' };

function codeSystem() {
  return {
    resourceType: 'CodeSystem', url: 'http://example.org/cs', status: 'active', content: 'complete',
    versionAlgorithmString: 'semver',
    filter: [{ code: 'concept', operator: ['is-a', 'child-of'], value: 'code' }],
    property: [{ code: 'weight', type: 'decimal' }, { code: 'kind', type: 'code' }],
    concept: [
      { code: 'a', display: 'A', concept: [{ code: 'a1', display: 'A1' }] },
      {
        code: 'b', display: 'B',
        designation: [{ language: 'de', value: 'Bee', additionalUse: [additionalUse] }],
        property: [{ code: 'weight', valueDecimal: 1.5 }, { code: 'kind', valueCode: 'x' }],
        concept: [{ code: 'b1', display: 'B1' }]
      }
    ]
  };
}

function valueSet() {
  return {
    resourceType: 'ValueSet', url: 'http://example.org/vs', status: 'active',
    compose: {
      property: ['status'],
      include: [
        { system: 'http://example.org/cs', filter: [{ property: 'concept', op: 'child-of', value: 'a' }] },
        { system: 'http://example.org/cs', concept: [{ code: 'b', designation: [{ value: 'Bee', additionalUse: [additionalUse] }] }] },
        { system: 'http://example.org/other', concept: [{ code: 'z' }] }
      ]
    },
    expansion: {
      identifier: 'x', timestamp: '2026-11-14', property: [{ code: 'status', uri: 'http://hl7.org/fhir/concept-properties#status' }],
      contains: [
        { system: 'http://example.org/cs', code: 'a', contains: [{ system: 'http://example.org/cs', code: 'a1', property: [{ code: 'status', valueCode: 'active' }] }] },
        { system: 'http://example.org/cs', code: 'b', designation: [{ value: 'Bee', additionalUse: [additionalUse] }] },
        { system: 'http://example.org/cs', code: 'c' }
      ]
    }
  };
}

describe('mapShared', () => {
  test('the same array when nothing changes, a new one when something does', () => {
    const a = [1, 2, 3];
    expect(mapShared(a, x => x)).toBe(a);
    const b = mapShared(a, x => (x === 2 ? 20 : x));
    expect(b).not.toBe(a);
    expect(b).toEqual([1, 20, 3]);
    expect(a).toEqual([1, 2, 3]);
  });
});

describe('codeSystemFromR5', () => {
  test.each(['4.0.1', '3.0.2'])('does not change the R5 code system (%s)', (version) => {
    const cs = deepFreeze(codeSystem());
    expect(JSON.stringify(codeSystemFromR5(cs, version))).toBe(JSON.stringify(codeSystemFromR5(codeSystem(), version)));
    expect(cs).toEqual(codeSystem());
  });

  test('R4: designation.additionalUse goes into its extension', () => {
    const r4 = codeSystemFromR5(deepFreeze(codeSystem()), '4.0.1');
    const des = r4.concept[1].designation[0];
    expect(des.additionalUse).toBeUndefined();
    expect(des.extension).toEqual([{ url: CS_ADDITIONAL_USE_EXT, valueCoding: additionalUse }]);
    expect(r4.versionAlgorithmString).toBeUndefined();
    expect(r4.filter[0].operator).toEqual(['is-a']);
    // decimal properties are fine in R4
    expect(r4.property.map(p => p.code)).toEqual(['weight', 'kind']);
    expect(r4.concept[1].property.map(p => p.code)).toEqual(['weight', 'kind']);
  });

  test('R3: decimal properties, which R3 does not have, are dropped', () => {
    const r3 = codeSystemFromR5(deepFreeze(codeSystem()), '3.0.2');
    expect(r3.property.map(p => p.code)).toEqual(['kind']);
    expect(r3.concept[1].property).toEqual([{ code: 'kind', valueCode: 'x' }]);
    expect(r3.concept[1].designation[0].extension).toEqual([{ url: CS_ADDITIONAL_USE_EXT, valueCoding: additionalUse }]);
  });

  test('concepts with nothing to convert are shared with the original', () => {
    const cs = deepFreeze(codeSystem());
    const r4 = codeSystemFromR5(cs, '4.0.1');
    expect(r4.concept).not.toBe(cs.concept); // b changed
    expect(r4.concept[0]).toBe(cs.concept[0]); // a, and a1 under it, didn't
    expect(r4.concept[1].concept).toBe(cs.concept[1].concept);

    const plain = deepFreeze({ resourceType: 'CodeSystem', url: 'http://example.org/p', concept: [{ code: 'x', concept: [{ code: 'y' }] }] });
    expect(codeSystemFromR5(plain, '4.0.1').concept).toBe(plain.concept);
  });

  test('converting the same code system again gives the same concepts (so their XML can come from the cache)', () => {
    const cs = deepFreeze(codeSystem());
    expect(codeSystemFromR5(cs, '4.0.1').concept).toBe(codeSystemFromR5(cs, '4.0.1').concept);
    expect(codeSystemFromR5(cs, '3.0.2').concept).not.toBe(codeSystemFromR5(cs, '4.0.1').concept);
  });
});

describe('valueSetFromR5', () => {
  test.each(['4.0.1', '3.0.2'])('does not change the R5 value set (%s)', (version) => {
    const vs = deepFreeze(valueSet());
    expect(JSON.stringify(valueSetFromR5(vs, version))).toBe(JSON.stringify(valueSetFromR5(valueSet(), version)));
    expect(vs).toEqual(valueSet());
  });

  test('R4: the R5-only parts go into their extensions', () => {
    const r4 = valueSetFromR5(deepFreeze(valueSet()), '4.0.1');
    expect(r4.compose.property).toBeUndefined();
    expect(r4.compose.extension[0].valueString).toBe('status');
    expect(r4.compose.include[0].filter[0].op).toBeUndefined();
    expect(r4.compose.include[0].filter[0]._op.extension[0].valueCode).toBe('child-of');
    expect(r4.compose.include[1].concept[0].designation[0]).toEqual({ value: 'Bee', extension: [{ url: VS_ADDITIONAL_USE_EXT, valueCoding: additionalUse }] });
    expect(r4.expansion.property).toBeUndefined();
    expect(r4.expansion.extension).toHaveLength(1);
    const a1 = r4.expansion.contains[0].contains[0];
    expect(a1.property).toBeUndefined();
    expect(a1.extension[0].extension).toEqual([{ url: 'code', valueCode: 'status' }, { url: 'value', valueCode: 'active' }]);
    expect(r4.expansion.contains[1].designation[0].extension[0].url).toBe(VS_ADDITIONAL_USE_EXT);
  });

  test('R3: operators R3 does not have also go into the extension', () => {
    const vs = valueSet();
    vs.compose.include[0].filter.push({ property: 'concept', op: 'generalizes', value: 'a' }, { property: 'concept', op: 'is-a', value: 'a' });
    const r3 = valueSetFromR5(deepFreeze(vs), '3.0.2');
    expect(r3.compose.include[0].filter.map(f => f.op ?? f._op.extension[0].valueCode)).toEqual(['child-of', 'generalizes', 'is-a']);
    expect(r3.compose.include[0].filter.map(f => f.op === undefined)).toEqual([true, true, false]);
  });

  test('what has nothing to convert is shared with the original', () => {
    const vs = deepFreeze(valueSet());
    const r4 = valueSetFromR5(vs, '4.0.1');
    expect(r4.compose.include[2]).toBe(vs.compose.include[2]);
    expect(r4.expansion.contains[2]).toBe(vs.expansion.contains[2]);
    expect(r4.expansion.contains[0]).not.toBe(vs.expansion.contains[0]); // a1 under it changed
  });

  test('converting the same expansion again gives the same contains (so their XML can come from the cache)', () => {
    const vs = deepFreeze(valueSet());
    expect(valueSetFromR5(vs, '4.0.1').expansion.contains).toBe(valueSetFromR5(vs, '4.0.1').expansion.contains);
  });
});

const { conceptMapFromR5 } = require('../../tx/xversion/xv-conceptmap');
const { parametersFromR5 } = require('../../tx/xversion/xv-parameters');

function conceptMap() {
  return {
    resourceType: 'ConceptMap', url: 'http://example.org/cm', status: 'active',
    identifier: [{ system: 'urn:ietf:rfc:3986', value: 'urn:oid:1.2.3' }],
    sourceScope: 'http://example.org/vs1|1.0', targetScope: 'http://example.org/vs2',
    property: [{ code: 'p', type: 'string' }],
    group: [
      {
        source: 'http://example.org/a', target: 'http://example.org/b',
        element: [
          { code: '1', target: [{ code: 'x', relationship: 'source-is-narrower-than-target' }] },
          { code: '2', noMap: true }
        ],
        unmapped: { mode: 'use-source-code', relationship: 'related-to' }
      },
      // nothing to convert in this group
      { source: 'http://example.org/c', target: 'http://example.org/d', element: [{ code: '3', noMap: true }] }
    ]
  };
}

describe('conceptMapFromR5', () => {
  test('R4: the R5 parts are converted, and the stored map is not changed', () => {
    const plain = conceptMapFromR5(conceptMap(), '4.0.1');
    const r4 = conceptMapFromR5(deepFreeze(conceptMap()), '4.0.1');
    expect(r4).toEqual(plain);
    expect(r4.identifier).toEqual({ system: 'urn:ietf:rfc:3986', value: 'urn:oid:1.2.3' });
    expect(r4).toMatchObject({ source: 'http://example.org/vs1', sourceVersion: '1.0', target: 'http://example.org/vs2' });
    expect(r4.sourceScope).toBeUndefined();
    expect(r4.property).toBeUndefined();
    expect(r4.group[0].element[0].target[0]).toEqual({ code: 'x', equivalence: 'wider' });
    expect(r4.group[0].unmapped).toEqual({ mode: 'provided',
      extension: [{ url: 'http://hl7.org/fhir/5.0/StructureDefinition/extension-ConceptMap.group.unmapped.relationship', valueCode: 'related-to' }] });
  });

  test('groups and elements with nothing to convert are shared with the original', () => {
    const cm = deepFreeze(conceptMap());
    const r4 = conceptMapFromR5(cm, '4.0.1');
    expect(r4.group[1]).toBe(cm.group[1]);
    expect(r4.group[0].element[1]).toBe(cm.group[0].element[1]);
  });

  test('converting the same map again gives the same groups (so their XML can come from the cache)', () => {
    const cm = deepFreeze(conceptMap());
    expect(conceptMapFromR5(cm, '4.0.1').group).toBe(conceptMapFromR5(cm, '3.0.2').group);
  });
});

function translateParameters() {
  return {
    resourceType: 'Parameters',
    parameter: [
      { name: 'result', valueBoolean: true },
      { name: 'match', part: [
        { name: 'relationship', valueCode: 'equivalent' },
        { name: 'concept', valueCoding: { system: 'http://example.org/b', code: 'x' } },
        { name: 'originMap', valueCanonical: 'http://example.org/cm' }
      ] },
      { name: 'map', resource: conceptMap() }
    ]
  };
}

describe('parametersFromR5', () => {
  test('R4: a match gets its equivalence and source, and the original is not changed', () => {
    const plain = parametersFromR5(translateParameters(), '4.0.1');
    const r4 = parametersFromR5(deepFreeze(translateParameters()), '4.0.1');
    expect(r4).toEqual(plain);
    expect(r4.parameter[1].part.map(p => p.name)).toEqual(['concept', 'originMap', 'source', 'equivalence']);
    expect(r4.parameter[1].part.find(p => p.name === 'equivalence').valueCode).toBe('equivalent');
    expect(r4.parameter[2].resource.group[0].element[0].target[0].equivalence).toBe('wider');
  });

  test('R3: valueCanonical becomes valueUri at every level', () => {
    const r3 = parametersFromR5(deepFreeze(translateParameters()), '3.0.2');
    const om = r3.parameter[1].part.find(p => p.name === 'originMap');
    expect(om).toEqual({ name: 'originMap', valueUri: 'http://example.org/cm' });
    expect(r3.parameter[1].part.find(p => p.name === 'relationship')).toBeDefined();
  });

  test('parameters with nothing to convert are shared with the original', () => {
    const p = deepFreeze(translateParameters());
    expect(parametersFromR5(p, '4.0.1').parameter[0]).toBe(p.parameter[0]);
    expect(parametersFromR5(p, '3.0.2').parameter[0]).toBe(p.parameter[0]);
  });
});

describe('capResourceCodes on a ConceptMap', () => {
  const { capResourceCodes } = require('../../tx/tx-html');
  test('no more than the limit of elements, across the groups, and the map is not changed', () => {
    const cm = deepFreeze({ resourceType: 'ConceptMap', group: [
      { source: 'a', element: [{ code: '1' }, { code: '2' }, { code: '3' }] },
      { source: 'b', element: [{ code: '4' }, { code: '5' }] }
    ] });
    const capped = capResourceCodes(cm, 4);
    expect(capped).toMatchObject({ shown: 4, total: 5 });
    expect(capped.resource.group.map(g => g.element.map(e => e.code))).toEqual([['1', '2', '3'], ['4']]);
    expect(capResourceCodes(cm, 5).resource).toBe(cm);
  });
});
