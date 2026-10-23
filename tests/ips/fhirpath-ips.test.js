const { evaluate, ipsFunctions, inBundle } = require('../../ips/fhirpath-ips');
const fhirpath = require('fhirpath');
const r4Model = require('fhirpath/fhir-context/r4');

const L = 'http://loinc.org';
const S = 'http://snomed.info/sct';
const cc = (system, code) => ({ coding: [{ system, code }] });

// problems (two, one nested under medications too), medications, immunizations, and a
// results section whose entries are referenced in each of the ways a Bundle allows
function doc() {
  return {
    resourceType: 'Bundle', type: 'document',
    entry: [
      { fullUrl: 'urn:uuid:comp', resource: { resourceType: 'Composition', id: 'comp',
        contained: [{ resourceType: 'Observation', id: 'inner', code: cc(L, '2345-7') }],
        section: [
          { code: cc(L, '11450-4'), entry: [{ reference: 'urn:uuid:p1' }, { reference: 'urn:uuid:p2' }] },
          { code: cc(L, '10160-0'), entry: [{ reference: 'urn:uuid:m1' }, { reference: 'urn:uuid:m2' }],
            section: [{ code: cc(L, '11450-4'), entry: [{ reference: 'urn:uuid:p1' }] }] },
          { code: cc(L, '11369-6'), entry: [{ reference: 'urn:uuid:i1' }] },
          { code: cc(L, '30954-2'), entry: [{ reference: '#inner' }, { reference: 'urn:uuid:missing' }, { reference: 'Observation/elsewhere' }] }
        ] } },
      { fullUrl: 'urn:uuid:p1', resource: { resourceType: 'Condition', code: cc(S, '38341003') } },
      { fullUrl: 'urn:uuid:p2', resource: { resourceType: 'Condition', code: cc(S, '44054006') } },
      { fullUrl: 'urn:uuid:m1', resource: { resourceType: 'MedicationStatement', medicationCodeableConcept: cc(S, '774421004') } },
      { fullUrl: 'urn:uuid:m2', resource: { resourceType: 'MedicationStatement', medicationReference: { reference: 'urn:uuid:med' } } },
      { fullUrl: 'urn:uuid:med', resource: { resourceType: 'Medication', code: cc(S, '774421004') } },
      { fullUrl: 'urn:uuid:i1', resource: { resourceType: 'Immunization', vaccineCode: cc(S, '836377006') } }
    ]
  };
}
const ev = (expr, res = doc(), options) => evaluate(res, expr, options);

describe('section()', () => {
  test('finds the sections with the code, nested ones too', () => {
    expect(ev(`section('${L}', '11450-4').count()`)).toEqual([2]);
    expect(ev(`section('${L}', '10160-0').entry.reference`)).toEqual(['urn:uuid:m1', 'urn:uuid:m2']);
    expect(ev(`section('${L}', '99999-9')`)).toEqual([]);
    expect(ev(`section('http://other', '11450-4')`)).toEqual([]);
  });

  test('all or nothing for each input, by min..max', () => {
    expect(ev(`section('${L}', '11450-4', 1, 1)`)).toEqual([]);
    expect(ev(`section('${L}', '11450-4', 1, 2).count()`)).toEqual([2]);
    expect(ev(`section('${L}', '11450-4', 0, '*').count()`)).toEqual([2]);
    expect(ev(`section('${L}', '11450-4', 3, '*')`)).toEqual([]);
    expect(ev(`section('${L}', '10160-0', 1, 1).exists()`)).toEqual([true]);
  });

  test('takes Compositions, and several inputs each on its own', () => {
    expect(ev(`entry.resource.ofType(Composition).section('${L}', '10160-0').count()`)).toEqual([1]);
    expect(evaluate(doc().entry[0].resource, `section('${L}', '11450-4').count()`)).toEqual([2]);
    // two documents: each is counted alone
    const one = doc();
    one.entry[0].resource.section[1].section = [];
    expect(evaluate([doc(), one], `section('${L}', '11450-4', 1, 1).count()`, {})).toEqual([1]);
    // anything else is passed over
    expect(evaluate({ resourceType: 'Patient' }, `section('${L}', '11450-4')`)).toEqual([]);
    expect(evaluate({ resourceType: 'Bundle', type: 'collection' }, `section('${L}', '11450-4')`)).toEqual([]);
  });

  test('bad bounds are errors', () => {
    expect(() => ev(`section('${L}', '11450-4', 2, 1)`)).toThrow(/max must be an integer no less than min/);
    expect(() => ev(`section('${L}', '11450-4', 1, 'x')`)).toThrow(/max must be an integer or '\*'/);
    expect(() => ev(`section('${L}', '11450-4', 'a', 1)`)).toThrow();
  });
});

describe('entry()', () => {
  test('resolves the entries and matches their code, medicationCodeableConcept or vaccineCode', () => {
    expect(ev(`section('${L}', '11450-4').entry('${S}', '38341003').resourceType`)).toEqual(['Condition', 'Condition']);
    expect(ev(`section('${L}', '10160-0').entry('${S}', '774421004').resourceType`)).toEqual(['MedicationStatement']);
    expect(ev(`section('${L}', '11369-6').entry('${S}', '836377006').resourceType`)).toEqual(['Immunization']);
    // what comes back can be navigated
    expect(ev(`section('${L}', '10160-0').entry('${S}', '774421004').medicationCodeableConcept.coding.code`)).toEqual(['774421004']);
  });

  test('does not follow medicationReference', () => {
    expect(ev(`section('${L}', '10160-0').entry('${S}', '774421004', 2, 2)`)).toEqual([]);
  });

  test('all or nothing for each section, by min..max', () => {
    // in the top problems section once, and in the nested one once
    expect(ev(`section('${L}', '11450-4').entry('${S}', '38341003', 1, 1).count()`)).toEqual([2]);
    expect(ev(`section('${L}', '11450-4').entry('${S}', '44054006', 1, 1).count()`)).toEqual([1]);
    expect(ev(`section('${L}', '11450-4').entry('${S}', '44054006', 0, 0)`)).toEqual([]);
    expect(ev(`section('${L}', '11450-4').entry('${S}', '38341003', 2, '*')`)).toEqual([]);
  });

  test('works on any section, not just section()\'s', () => {
    expect(ev(`entry.resource.ofType(Composition).section.entry('${S}', '836377006').resourceType`)).toEqual(['Immunization']);
    expect(ev(`entry.resource.ofType(Composition).section.section.entry('${S}', '38341003').count()`)).toEqual([1]);
    // a Composition on its own: its contained resources only, or what the caller resolves
    const comp = doc().entry[0].resource;
    expect(evaluate(comp, `section('${L}', '30954-2').entry('${L}', '2345-7').id`)).toEqual(['inner']);
    expect(evaluate(comp, `section('${L}', '11450-4').entry('${S}', '38341003')`)).toEqual([]);
    const all = Object.fromEntries(doc().entry.map(e => [e.fullUrl, e.resource]));
    const seen = [];
    const resolve = (ref, c) => { seen.push([ref, c?.id]); return all[ref] || null; };
    expect(evaluate(comp, `section('${L}', '11450-4').entry('${S}', '38341003').count()`, { resolve })).toEqual([2]);
    expect(seen).toContainEqual(['urn:uuid:p1', 'comp']);
  });

  test('contained, missing and unresolvable references', () => {
    expect(ev(`section('${L}', '30954-2').entry('${L}', '2345-7').id`)).toEqual(['inner']);
    const asked = [];
    const resolve = (ref) => { asked.push(ref); return ref === 'Observation/elsewhere' ? { resourceType: 'Observation', id: 'elsewhere', code: cc(L, '2345-7') } : null; };
    expect(ev(`section('${L}', '30954-2').entry('${L}', '2345-7').id`, doc(), { resolve })).toEqual(['inner', 'elsewhere']);
    expect(asked).toEqual(['urn:uuid:missing', 'Observation/elsewhere']);
  });

  test('relative references, against the Composition\'s base or by type and id', () => {
    const rest = {
      resourceType: 'Bundle', type: 'document',
      entry: [
        { fullUrl: 'http://ex.org/fhir/Composition/c', resource: { resourceType: 'Composition', id: 'c', section: [{ code: cc(L, '11450-4'), entry: [{ reference: 'Condition/1' }, { reference: 'Condition/2/_history/3' }] }] } },
        { fullUrl: 'http://other.org/fhir/Condition/1', resource: { resourceType: 'Condition', id: '1', code: cc(S, 'x') } },
        { fullUrl: 'http://ex.org/fhir/Condition/1', resource: { resourceType: 'Condition', id: '1', code: cc(S, 'a') } },
        { fullUrl: 'http://ex.org/fhir/Condition/2', resource: { resourceType: 'Condition', id: '2', code: cc(S, 'a') } }
      ]
    };
    expect(ev(`section('${L}', '11450-4').entry('${S}', 'a').count()`, rest)).toEqual([2]);
    expect(ev(`section('${L}', '11450-4').entry('${S}', 'x')`, rest)).toEqual([]);
    // no fullUrls: by type and id
    const bare = structuredClone(rest);
    bare.entry.forEach(e => delete e.fullUrl);
    bare.entry.splice(1, 1);
    expect(ev(`section('${L}', '11450-4').entry('${S}', 'a').count()`, bare)).toEqual([2]);
    expect(inBundle(bare, 'Condition/9')).toBeNull();
    expect(inBundle(bare, 'not a reference')).toBeNull();
  });
});

test('the table plugs into fhirpath.js directly', () => {
  const r = fhirpath.evaluate(doc(), `section('${L}', '11369-6', 1, 1).entry('${S}', '836377006', 1, 1).exists()`, null, r4Model, { userInvocationTable: ipsFunctions() });
  expect(r).toEqual([true]);
});

describe('resources()', () => {
  test('finds the resources in the document with the code, of a type when given', () => {
    expect(ev(`resources('${S}', '38341003').resourceType`)).toEqual(['Condition']);
    expect(ev(`resources('${S}', '774421004').resourceType`)).toEqual(['MedicationStatement', 'Medication']);
    expect(ev(`resources('${S}', '774421004', 'Medication').count()`)).toEqual([1]);
    expect(ev(`resources('${S}', '836377006', 'Immunization').exists()`)).toEqual([true]);
    expect(ev(`resources('${S}', '38341003', 'Observation')`)).toEqual([]);
    // what comes back can be navigated; the leading type name works as usual
    expect(ev(`Bundle.resources('${S}', '38341003').code.coding.code`)).toEqual(['38341003']);
    expect(ev(`Bundle.resources('${S}', '44054006').where(code.coding.exists()).count() = 1`)).toEqual([true]);
  });

  test('from inside the document, and once per document', () => {
    expect(ev(`entry.resource.ofType(Composition).resources('${S}', '38341003').count()`)).toEqual([1]);
    expect(ev(`(entry.resource.ofType(Composition) | entry.resource.ofType(Condition)).resources('${S}', '38341003').count()`)).toEqual([1]);
    // a Composition on its own is in no document
    expect(evaluate(doc().entry[0].resource, `resources('${S}', '38341003')`)).toEqual([]);
    expect(() => ev(`resources('${S}', '38341003', 'not a type')`)).toThrow(/type must be a resource type/);
  });
});

describe('entryIn() and resourcesIn()', () => {
  const PROBLEMS = 'http://example.org/ValueSet/problems';
  const MEDS = 'http://example.org/ValueSet/meds';
  // what is in which value set
  const members = { [PROBLEMS]: ['38341003', '44054006'], [MEDS]: ['774421004'] };
  const inVs = (url, concept) => (members[url.split('|')[0]] || []).some(c => concept.coding.some(x => x.code === c));

  test('match by value set, synchronously when the answers are', () => {
    const membership = inVs;
    expect(ev(`section('${L}', '11450-4').entryIn('${PROBLEMS}').count()`, doc(), { membership })).toEqual([3]);
    expect(ev(`section('${L}', '11450-4').entryIn('${PROBLEMS}', 2, 2).count()`, doc(), { membership })).toEqual([2]);
    expect(ev(`section('${L}', '11450-4').entryIn('${MEDS}')`, doc(), { membership })).toEqual([]);
    expect(ev(`resourcesIn('${MEDS}').resourceType`, doc(), { membership })).toEqual(['MedicationStatement', 'Medication']);
    expect(ev(`resourcesIn('${MEDS}', 'Medication').count()`, doc(), { membership })).toEqual([1]);
    expect(ev(`resourcesIn('${PROBLEMS}|2.0').count()`, doc(), { membership })).toEqual([2]);
    // with no membership, nothing is in anything
    expect(ev(`resourcesIn('${MEDS}')`)).toEqual([]);
    expect(() => ev("resourcesIn('not a canonical')")).toThrow(/must be a canonical URL/);
    expect(() => ev(`section('${L}', '11450-4').entryIn('${MEDS}', 2, 1)`)).toThrow(/max must be an integer no less than min/);
  });

  test('ask asynchronously, and only for what the rule reaches', async () => {
    const asked = [];
    const membership = (url, concept) => {
      asked.push(`${url}:${concept.coding.map(c => c.code).join(',')}`);
      return new Promise(resolve => setTimeout(() => resolve(inVs(url, concept)), 1));
    };
    const { evaluateAsync } = require('../../ips/fhirpath-ips');
    expect(await evaluateAsync(doc(), `section('${L}', '10160-0').entryIn('${MEDS}', 1, 1).exists()`, { membership })).toEqual([true]);
    // the medications section's two entries: one coded, one by reference (no code to ask about)
    expect(asked).toEqual([`${MEDS}:774421004`]);
    expect(await evaluateAsync(doc(), `resourcesIn('${PROBLEMS}', 'Condition').count() = 2`, { membership })).toEqual([true]);
    // asynchronous answers need an asynchronous evaluation
    expect(() => ev(`resourcesIn('${PROBLEMS}')`, doc(), { membership })).toThrow(/async/i);
  });
});
