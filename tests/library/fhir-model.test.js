//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// library/fhir-model.js: what the model knows of the types, beyond what XML needs.

const fs = require('fs');
const path = require('path');
const { FhirModel, deriveModel, XmlModel, deriveXmlModel } = require('../../library/fhir-model');

// the R4 model the rest tests use (tests/rest/make-fixture.js)
const DEFINITIONS = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/rest/r4-definitions.json'), 'utf8'));
const model = new FhirModel(DEFINITIONS.xml);

describe('the types', () => {
  test('kind, base, abstract, url', () => {
    expect(model.info('Patient')).toEqual({ name: 'Patient', kind: 'resource', base: 'DomainResource', abstract: false,
      url: 'http://hl7.org/fhir/StructureDefinition/Patient', system: null });
    expect(model.info('DomainResource')).toMatchObject({ kind: 'resource', base: 'Resource', abstract: true });
    expect(model.info('Resource')).toMatchObject({ base: null, abstract: true });
    expect(model.info('HumanName')).toMatchObject({ kind: 'complex', base: 'Element' });
    expect(model.info('code')).toMatchObject({ kind: 'primitive', base: 'string', system: 'String' });
    expect(model.info('Nothing')).toBeNull();
  });

  test('what specialises what', () => {
    expect(model.isA('Patient', 'Resource')).toBe(true);
    expect(model.isA('Patient', 'DomainResource')).toBe(true);
    expect(model.isA('Bundle', 'DomainResource')).toBe(false);
    expect(model.isA('Bundle', 'Resource')).toBe(true);
    expect(model.isA('code', 'string')).toBe(true);
    expect(model.isA('positiveInt', 'integer')).toBe(true);
    expect(model.isA('Age', 'Quantity')).toBe(true);
    expect(model.isA('string', 'code')).toBe(false);
    expect(model.baseOf('Age')).toBe('Quantity');
  });

  test('descendants', () => {
    const d = model.descendants('DomainResource');
    expect(d).toContain('DomainResource');
    expect(d).toContain('Patient');
    expect(d).not.toContain('Bundle');
    expect(model.descendants('Quantity')).toEqual(expect.arrayContaining(['Quantity', 'Age', 'Duration', 'Count', 'Distance']));
    expect(model.descendants('string')).toEqual(expect.arrayContaining(['string', 'code', 'id', 'markdown']));
  });

  test('primitives: System types, from the type or what it specialises', () => {
    expect(model.systemTypeOf('string')).toBe('String');
    expect(model.systemTypeOf('code')).toBe('String');
    expect(model.systemTypeOf('boolean')).toBe('Boolean');
    expect(model.systemTypeOf('positiveInt')).toBe('Integer');
    expect(model.systemTypeOf('decimal')).toBe('Decimal');
    expect(model.systemTypeOf('dateTime')).toBe('DateTime');
    expect(model.systemTypeOf('HumanName')).toBeNull();
    expect(model.isPrimitive('code')).toBe(true);
    expect(model.isResource('Patient')).toBe(true);
    expect(model.isAbstract('Resource')).toBe(true);
  });

  test('types by url', () => {
    expect(model.typeForUrl('http://hl7.org/fhir/StructureDefinition/Patient')).toBe('Patient');
    expect(model.typeForUrl('http://hl7.org/fhir/StructureDefinition/Patient|4.0.1')).toBe('Patient');
    expect(model.typeForUrl('http://example.org/Patient')).toBeNull();
    expect(model.typeNames()).toEqual(expect.arrayContaining(['Patient', 'string', 'HumanName']));
  });
});

describe('the elements', () => {
  test('by name (value for value[x]), with their cardinality', () => {
    const v = model.element('Observation', 'value');
    expect(v.choice).toBe(true);
    expect(v.types).toEqual(expect.arrayContaining(['Quantity', 'string', 'CodeableConcept']));
    expect(model.element('Observation', 'valueQuantity')).toBeNull();
    expect(model.element('Observation', 'status')).toMatchObject({ min: 1, array: false });
    expect(model.element('Patient', 'name')).toMatchObject({ min: 0, array: true, types: ['HumanName'] });
    expect(model.element('Patient.contact', 'name')).toMatchObject({ types: ['HumanName'] });
    expect(model.element('Nothing', 'x')).toBeNull();
  });

  test('System types', () => {
    expect(model.element('Element', 'id')).toMatchObject({ types: ['string'], system: 'String' });
    expect(model.element('Extension', 'url')).toMatchObject({ types: ['uri'], system: 'String' });
    expect(model.element('Patient', 'gender').system).toBeNull();
  });

  test('target profiles, and bindings', () => {
    expect(model.element('Patient', 'managingOrganization').targets).toEqual({ Reference: ['http://hl7.org/fhir/StructureDefinition/Organization'] });
    expect(model.element('Observation', 'subject').targets.Reference).toEqual(expect.arrayContaining([
      'http://hl7.org/fhir/StructureDefinition/Patient', 'http://hl7.org/fhir/StructureDefinition/Group']));
    expect(model.element('Patient', 'gender').binding).toEqual({ strength: 'required', valueSet: 'http://hl7.org/fhir/ValueSet/administrative-gender|4.0.1' });
    expect(model.element('Patient', 'name').binding).toBeNull();
  });
});

describe('deriving', () => {
  const sd = (type, kind, base, elements, extra = {}) => ({ resourceType: 'StructureDefinition', type, kind, derivation: 'specialization',
    url: 'http://hl7.org/fhir/StructureDefinition/' + type, baseDefinition: base ? 'http://hl7.org/fhir/StructureDefinition/' + base : undefined,
    snapshot: { element: [{ path: type }, ...elements] }, ...extra });

  test('profiles and logical models are left out, and the first definition of a type wins', () => {
    const raw = deriveModel([
      sd('Thing', 'resource', 'DomainResource', [{ path: 'Thing.a', min: 1, max: '1', type: [{ code: 'string', profile: ['http://x/p'] }] }]),
      sd('Thing', 'resource', 'DomainResource', [{ path: 'Thing.b', max: '1', type: [{ code: 'string' }] }]),
      { ...sd('Thing', 'resource', 'Thing', []), derivation: 'constraint', url: 'http://x/thing-profile' },
      sd('Model', 'logical', null, []),
      sd('flag', 'primitive-type', 'Element', [{ path: 'flag.value', type: [{ code: 'http://hl7.org/fhirpath/System.Boolean' }] }])
    ]);
    expect(Object.keys(raw.info).sort()).toEqual(['Thing', 'flag']);
    expect(raw.types.Thing).toEqual([['a', 0, ['string'], null, { n: 1, p: { string: ['http://x/p'] } }]]);
    expect(raw.info.flag).toEqual({ k: 'primitive', b: 'Element', s: 'Boolean' });
    expect(raw.primitives.flag).toBe('string');
    const m = new FhirModel(raw);
    expect(m.element('Thing', 'a').profiles).toEqual({ string: ['http://x/p'] });
  });

  test('the names XML has always used are the same things', () => {
    expect(XmlModel).toBe(FhirModel);
    expect(deriveXmlModel).toBe(deriveModel);
  });
});
