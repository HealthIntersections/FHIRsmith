const { convertResourceToR5, convertResourceFromR5 } = require('../../tx/xversion/xv-resource');

/**
 * Cross-version conversion tests, focused on resources that omit optional
 * properties the converters previously assumed were present:
 *   - ValueSet without `compose` (expansion-only)
 *   - Parameters without a `parameter` array (empty Parameters)
 *   - Bundle entries without a `resource` (request/response/search-only)
 * Plus "still works" cases to ensure the added guards didn't change normal
 * conversion behaviour.
 */

describe('xversion — ValueSet without compose (the reported bug)', () => {
  test('expansion-only ValueSet converts R4 -> R5 without throwing', () => {
    const vs = { resourceType: 'ValueSet', url: 'http://x', expansion: { contains: [{ system: 's', code: 'a' }] } };
    let out;
    expect(() => { out = convertResourceToR5(vs, '4.0'); }).not.toThrow();
    expect(out.resourceType).toBe('ValueSet');
    expect(out.expansion.contains).toHaveLength(1);
  });

  test('expansion-only ValueSet converts R3 -> R5 without throwing', () => {
    const vs = { resourceType: 'ValueSet', url: 'http://x', expansion: { contains: [] } };
    expect(() => convertResourceToR5(vs, '3.0')).not.toThrow();
  });

  test('ValueSet with neither compose nor expansion converts without throwing', () => {
    expect(() => convertResourceToR5({ resourceType: 'ValueSet', url: 'http://x' }, '4.0')).not.toThrow();
  });

  test('ValueSet WITH compose still converts (guard did not skip real work)', () => {
    const vs = {
      resourceType: 'ValueSet',
      compose: { include: [{ system: 's', filter: [{ property: 'p', op: 'is-a', value: 'v' }] }] }
    };
    const out = convertResourceToR5(vs, '4.0');
    expect(out.compose.include[0].filter[0].op).toBe('is-a');
  });

  test('R5-only filter operator is moved to an extension when targeting R4', () => {
    const vs = {
      resourceType: 'ValueSet',
      compose: { include: [{ system: 's', filter: [{ property: 'p', op: 'child-of', value: 'v' }] }] }
    };
    const out = convertResourceFromR5(vs, '4.0');
    const filter = out.compose.include[0].filter[0];
    expect(filter.op).toBeUndefined();
    expect(filter._op).toBeDefined();
    // _op is a FHIR primitive-element extension: { extension: [ { url, valueCode } ] }
    expect(Array.isArray(filter._op.extension)).toBe(true);
    expect(filter._op.extension[0].url).toBe('http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.compose.include.filter.op');
    expect(filter._op.extension[0].valueCode).toBe('child-of');
  });
});

describe('xversion — filter op _op extension is a well-formed primitive extension', () => {
  const OP_EXT_URL = 'http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.compose.include.filter.op';

  // Assert the FHIR-correct shape: { extension: [ { url, valueCode } ] }
  function expectWellFormedOp(filter, expectedCode) {
    expect(filter.op).toBeUndefined();
    expect(filter._op).toBeDefined();
    expect(Array.isArray(filter._op.extension)).toBe(true);
    expect(filter._op.extension).toHaveLength(1);
    expect(filter._op.extension[0].url).toBe(OP_EXT_URL);
    expect(filter._op.extension[0].valueCode).toBe(expectedCode);
    // the URL must NOT be sitting directly on _op (the original bug)
    expect(typeof filter._op.extension).not.toBe('string');
  }

  test('R5 -> R4 include filter (R5-only op)', () => {
    const vs = { resourceType: 'ValueSet', compose: { include: [{ system: 's', filter: [{ property: 'p', op: 'child-of', value: 'v' }] }] } };
    const out = convertResourceFromR5(vs, '4.0');
    expectWellFormedOp(out.compose.include[0].filter[0], 'child-of');
  });

  test('R5 -> R4 exclude filter (R5-only op)', () => {
    const vs = { resourceType: 'ValueSet', compose: { exclude: [{ system: 's', filter: [{ property: 'p', op: 'child-of', value: 'v' }] }] } };
    const out = convertResourceFromR5(vs, '4.0');
    expectWellFormedOp(out.compose.exclude[0].filter[0], 'child-of');
  });

  test('R5 -> R3 include filter (op not R3-compatible)', () => {
    const vs = { resourceType: 'ValueSet', compose: { include: [{ system: 's', filter: [{ property: 'p', op: 'generalizes', value: 'v' }] }] } };
    const out = convertResourceFromR5(vs, '3.0');
    expectWellFormedOp(out.compose.include[0].filter[0], 'generalizes');
  });

  test('R5 -> R3 exclude filter (op not R3-compatible)', () => {
    const vs = { resourceType: 'ValueSet', compose: { exclude: [{ system: 's', filter: [{ property: 'p', op: 'generalizes', value: 'v' }] }] } };
    const out = convertResourceFromR5(vs, '3.0');
    expectWellFormedOp(out.compose.exclude[0].filter[0], 'generalizes');
  });
});

describe('xversion — Parameters without a parameter array', () => {
  test('empty Parameters converts R4 -> R5 without throwing', () => {
    expect(() => convertResourceToR5({ resourceType: 'Parameters' }, '4.0')).not.toThrow();
  });

  test('empty Parameters converts R5 -> R4 without throwing', () => {
    expect(() => convertResourceFromR5({ resourceType: 'Parameters' }, '4.0')).not.toThrow();
  });

  test('empty Parameters converts R5 -> R3 without throwing', () => {
    expect(() => convertResourceFromR5({ resourceType: 'Parameters' }, '3.0')).not.toThrow();
  });

  test('R5 Parameters with a match param but no parameter array does not throw', () => {
    // Exercises the R5->R5 match-fixing clone path
    expect(() => convertResourceToR5({ resourceType: 'Parameters' }, '5.0')).not.toThrow();
  });

  test('Parameters WITH parameters still converts a nested resource', () => {
    const params = {
      resourceType: 'Parameters',
      parameter: [{ name: 'tx-resource', resource: { resourceType: 'ValueSet', expansion: { contains: [] } } }]
    };
    const out = convertResourceToR5(params, '4.0');
    expect(out.parameter[0].resource.resourceType).toBe('ValueSet');
  });

  test('R5 -> R4 converts a match relationship to a legacy equivalence', () => {
    const params = {
      resourceType: 'Parameters',
      parameter: [{ name: 'match', part: [{ name: 'relationship', valueCode: 'source-is-narrower-than-target' }] }]
    };
    const out = convertResourceFromR5(params, '4.0');
    const equ = out.parameter[0].part.find(p => p.name === 'equivalence');
    expect(equ).toBeDefined();
    expect(equ.valueCode).toBe('wider');
    // relationship is removed in R4
    expect(out.parameter[0].part.find(p => p.name === 'relationship')).toBeUndefined();
  });
});

describe('xversion — Bundle entries without a resource', () => {
  test('request-only entry converts R4 -> R5 without throwing', () => {
    const bundle = { resourceType: 'Bundle', type: 'batch', entry: [{ request: { method: 'GET', url: 'ValueSet' } }] };
    expect(() => convertResourceToR5(bundle, '4.0')).not.toThrow();
  });

  test('request-only entry converts R5 -> R4 and is preserved', () => {
    const bundle = { resourceType: 'Bundle', type: 'batch', entry: [{ request: { method: 'GET', url: 'ValueSet' } }] };
    const out = convertResourceFromR5(bundle, '4.0');
    expect(out.entry).toHaveLength(1);
    expect(out.entry[0].request.url).toBe('ValueSet');
    expect(out.entry[0].resource).toBeUndefined();
  });

  test('Bundle without an entry array converts without throwing', () => {
    expect(() => convertResourceToR5({ resourceType: 'Bundle', type: 'searchset' }, '4.0')).not.toThrow();
  });

  test('entry WITH a resource still has that resource converted', () => {
    const bundle = {
      resourceType: 'Bundle', type: 'collection',
      entry: [{ resource: { resourceType: 'ValueSet', compose: { include: [{ system: 's' }] } } }]
    };
    const out = convertResourceFromR5(bundle, '4.0');
    expect(out.entry[0].resource.resourceType).toBe('ValueSet');
    expect(out.entry[0].resource.compose.include[0].system).toBe('s');
  });
});

describe('xversion — dispatcher passthrough', () => {
  test('an undefined resource passes through both directions without throwing', () => {
    expect(() => convertResourceToR5(undefined, '4.0')).not.toThrow();
    expect(() => convertResourceFromR5(undefined, '4.0')).not.toThrow();
    expect(convertResourceToR5(undefined, '4.0')).toBeUndefined();
  });

  test('a resource with no resourceType is returned unchanged', () => {
    const obj = { foo: 'bar' };
    expect(convertResourceToR5(obj, '4.0')).toBe(obj);
  });

  test('R5 source/target is a no-op passthrough', () => {
    const vs = { resourceType: 'ValueSet', url: 'http://x' };
    expect(convertResourceToR5(vs, '5.0')).toBe(vs);
    expect(convertResourceFromR5(vs, '5.0')).toBe(vs);
  });
});

describe('xversion — CodeSystem filter operator down-conversion (issue #251 part 1)', () => {
  function cs(operators) {
    return { resourceType: 'CodeSystem', url: 'http://x', status: 'active',
      content: 'complete', filter: [{ code: 'concept', description: 'd', operator: operators, value: 'v' }] };
  }

  test('R5 -> R4 keeps generalizes (valid R4) and strips child-of / descendent-leaf (R5-only)', () => {
    const out = convertResourceFromR5(cs(['is-a', 'generalizes', 'child-of', 'descendent-leaf']), '4.0');
    expect(out.filter[0].operator).toEqual(['is-a', 'generalizes']);
  });

  test('R5 -> R4 leaves an all-valid-R4 filter untouched', () => {
    const out = convertResourceFromR5(cs(['=', 'is-a', 'descendent-of', 'is-not-a', 'regex', 'in', 'not-in', 'generalizes', 'exists']), '4.0');
    expect(out.filter[0].operator).toEqual(['=', 'is-a', 'descendent-of', 'is-not-a', 'regex', 'in', 'not-in', 'generalizes', 'exists']);
  });

  test('R5 -> R4 drops a filter whose operators are all R5-only', () => {
    const out = convertResourceFromR5(cs(['child-of', 'descendent-leaf']), '4.0');
    expect(out.filter || []).toHaveLength(0);
  });

  test('R5 -> R3 keeps only R3-compatible operators (generalizes is R4+, so dropped)', () => {
    const out = convertResourceFromR5(cs(['is-a', 'regex', 'generalizes', 'child-of']), '3.0');
    expect(out.filter[0].operator).toEqual(['is-a', 'regex']);
  });
});

describe('xversion — TerminologyCapabilities codeSystem.content (issue #251 part 2)', () => {
  const CONTENT_EXT = 'http://hl7.org/fhir/5.0/StructureDefinition/extension-TerminologyCapabilities.codeSystem.content';

  test('R5 -> R4 moves content into the content extension', () => {
    const r5 = { resourceType: 'TerminologyCapabilities', status: 'active', codeSystem: [{ uri: 'http://x', content: 'complete' }] };
    const out = convertResourceFromR5(r5, '4.0');
    const c0 = out.codeSystem[0];
    expect(c0.content).toBeUndefined();
    expect(c0.extension.find(e => e.url === CONTENT_EXT).valueCode).toBe('complete');
  });

  test('R4 -> R5 lifts content from the extension and removes that extension', () => {
    const r4 = { resourceType: 'TerminologyCapabilities', status: 'active',
      codeSystem: [{ uri: 'http://x', extension: [{ url: CONTENT_EXT, valueCode: 'complete' }] }] };
    const out = convertResourceToR5(r4, '4.0');
    const c0 = out.codeSystem[0];
    expect(c0.content).toBe('complete');
    // the redundant content extension must be gone (the delete previously no-op'd)
    expect((c0.extension || []).some(e => e.url === CONTENT_EXT)).toBe(false);
  });

  test('R4 -> R5 preserves unrelated extensions while removing only the content one', () => {
    const r4 = { resourceType: 'TerminologyCapabilities', status: 'active',
      codeSystem: [{ uri: 'http://x', extension: [
        { url: 'http://other/ext', valueString: 'keep-me' },
        { url: CONTENT_EXT, valueCode: 'fragment' }
      ] }] };
    const out = convertResourceToR5(r4, '4.0');
    const c0 = out.codeSystem[0];
    expect(c0.content).toBe('fragment');
    expect(c0.extension).toEqual([{ url: 'http://other/ext', valueString: 'keep-me' }]);
  });

  test('round-trip R5 -> R4 -> R5 preserves codeSystem.content', () => {
    const r5 = { resourceType: 'TerminologyCapabilities', status: 'active', codeSystem: [{ uri: 'http://x', content: 'complete' }] };
    const r4 = convertResourceFromR5(JSON.parse(JSON.stringify(r5)), '4.0');
    const back = convertResourceToR5(r4, '4.0');
    expect(back.codeSystem[0].content).toBe('complete');
    expect((back.codeSystem[0].extension || []).some(e => e.url === CONTENT_EXT)).toBe(false);
  });
});

describe('xversion — ValueSet compose.property', () => {
  const COMPOSE_PROPERTY_EXT = 'http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.compose.property';

  test('R5 -> R4 moves compose.property into the extension', () => {
    const r5 = { resourceType: 'ValueSet', status: 'active',
      compose: { property: ['status', 'definition'], include: [{ system: 'http://x' }] } };
    const out = convertResourceFromR5(r5, '4.0');
    expect(out.compose.property).toBeUndefined();
    expect(out.compose.extension.filter(e => e.url === COMPOSE_PROPERTY_EXT).map(e => e.valueString))
      .toEqual(['status', 'definition']);
  });

  test('R4 -> R5 lifts compose.property out of the extension and removes it', () => {
    const r4 = { resourceType: 'ValueSet', status: 'active',
      compose: { extension: [{ url: COMPOSE_PROPERTY_EXT, valueString: 'status' }], include: [{ system: 'http://x' }] } };
    const out = convertResourceToR5(r4, '4.0');
    expect(out.compose.property).toEqual(['status']);
    expect((out.compose.extension || []).some(e => e.url === COMPOSE_PROPERTY_EXT)).toBe(false);
  });

  test('R4 -> R5 preserves unrelated extensions while removing only the property ones', () => {
    const r4 = { resourceType: 'ValueSet', status: 'active',
      compose: { extension: [
        { url: 'http://other/ext', valueString: 'keep-me' },
        { url: COMPOSE_PROPERTY_EXT, valueString: 'definition' }
      ], include: [{ system: 'http://x' }] } };
    const out = convertResourceToR5(r4, '4.0');
    expect(out.compose.property).toEqual(['definition']);
    expect(out.compose.extension).toEqual([{ url: 'http://other/ext', valueString: 'keep-me' }]);
  });

  test('round-trip R5 -> R4 -> R5 preserves compose.property, in order', () => {
    const r5 = { resourceType: 'ValueSet', status: 'active',
      compose: { property: ['status', 'definition', '*'], include: [{ system: 'http://x' }] } };
    const r4 = convertResourceFromR5(JSON.parse(JSON.stringify(r5)), '4.0');
    const back = convertResourceToR5(r4, '4.0');
    expect(back.compose.property).toEqual(['status', 'definition', '*']);
    expect((back.compose.extension || []).some(e => e.url === COMPOSE_PROPERTY_EXT)).toBe(false);
  });

  test('a compose with no property is left alone in both directions', () => {
    const r5 = { resourceType: 'ValueSet', status: 'active', compose: { include: [{ system: 'http://x' }] } };
    const r4 = convertResourceFromR5(JSON.parse(JSON.stringify(r5)), '4.0');
    expect(r4.compose.extension).toBeUndefined();
    expect(convertResourceToR5(r4, '4.0').compose).toEqual({ include: [{ system: 'http://x' }] });
  });
});
