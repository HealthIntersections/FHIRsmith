// The body of a slow request, described in its log line (modules.tx.slowRequestSeconds)
const { summariseBody } = require('../../tx/library/request-summary');

describe('summariseBody', () => {
  test('no body', () => {
    expect(summariseBody(undefined)).toBe('');
    expect(summariseBody({})).toBe('');
  });

  test('Parameters: each parameter, a Coding as system|version#code, a resource as type, url and size', () => {
    const body = {
      resourceType: 'Parameters',
      parameter: [
        { name: 'url', valueUri: 'http://fhir.de/ValueSet/VitalSignDE-Atemfrequenz-SNOMED-CT' },
        { name: 'coding', valueCoding: { system: 'http://snomed.info/sct', version: 'http://snomed.info/sct/900000000000207008', code: '86290005', display: 'Atemfrequenz' } },
        { name: 'displayLanguage', valueCode: 'de-DE' },
        { name: 'abstract', valueBoolean: false },
        { name: 'codeableConcept', valueCodeableConcept: { coding: [{ system: 'http://loinc.org', code: '9279-1' }], text: 'Atemfrequenz' } },
        { name: 'tx-resource', resource: { resourceType: 'ValueSet', url: 'http://example.org/vs', version: '1.0', compose: { include: [{}, {}], exclude: [{}] } } },
        { name: 'tx-resource', resource: { resourceType: 'CodeSystem', url: 'http://example.org/cs', concept: [{}, {}, {}] } },
        { name: 'property', part: [{ name: 'code', valueCode: 'x' }, { name: 'value', valueString: 'y' }] }
      ]
    };
    expect(summariseBody(body)).toBe(
      'url=http://fhir.de/ValueSet/VitalSignDE-Atemfrequenz-SNOMED-CT; ' +
      "coding=http://snomed.info/sct|http://snomed.info/sct/900000000000207008#86290005 'Atemfrequenz'; " +
      'displayLanguage=de-DE; abstract=false; ' +
      "codeableConcept=[http://loinc.org#9279-1, text 'Atemfrequenz']; " +
      'tx-resource=ValueSet http://example.org/vs|1.0 (2 includes, 1 exclude); ' +
      'tx-resource=CodeSystem http://example.org/cs (3 concepts); ' +
      'property=(code=x, value=y)');
  });

  test('another resource: its type and url', () => {
    expect(summariseBody({ resourceType: 'ValueSet', url: 'http://example.org/vs', compose: { include: [{}] } }))
      .toBe('ValueSet http://example.org/vs (1 include)');
  });

  test('a value set: its filters, so an expensive ECL can be repeated', () => {
    const vs = {
      resourceType: 'ValueSet',
      compose: {
        include: [
          { system: 'http://snomed.info/sct', version: 'http://snomed.info/sct/731000124108',
            filter: [{ property: 'constraint', op: '=', value: '<< 404684003 : 363698007 = << 39057004' }] },
          { system: 'http://loinc.org', concept: [{ code: '1-8' }] },
        ],
        exclude: [{ system: 'http://snomed.info/sct', filter: [{ property: 'concept', op: 'is-a', value: '40733004' }, { property: 'inactive', op: '=', value: 'false' }] }],
      },
    };
    expect(summariseBody({ resourceType: 'Parameters', parameter: [{ name: 'valueSet', resource: vs }, { name: 'count', valueInteger: 10 }] }))
      .toBe('valueSet=ValueSet (2 includes, 1 exclude) [include http://snomed.info/sct|http://snomed.info/sct/731000124108 constraint = << 404684003 : 363698007 = << 39057004; ' +
        'exclude http://snomed.info/sct concept is-a 40733004 & inactive = false]; count=10');
  });

  test('a body that was not parsed: its size', () => {
    expect(summariseBody(Buffer.from('<Parameters/>'))).toBe('(13 bytes, not parsed)');
  });

  test('never longer than the limit', () => {
    const body = { resourceType: 'Parameters', parameter: [{ name: 'code', valueCode: 'x'.repeat(100) }] };
    const s = summariseBody(body, 20);
    expect(s).toBe('code=' + 'x'.repeat(15) + '... (105 characters)');
  });
});
