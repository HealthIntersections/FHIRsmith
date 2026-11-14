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
