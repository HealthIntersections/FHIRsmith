/**
 * $expand of a value set that imports another (include.valueSet, exclude.valueSet): the imported
 * value set is expanded for its codes, and only the codes the response returns have their details
 * read (displays and designations, definition, properties). What the import contributes is the
 * same: its own displays, designations and extensions for the codes it lists still win, nested
 * imports included, and the property declarations are those of the codes returned.
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');

const CS_URL = 'http://example.org/fhir/CodeSystem/import-membership';
const N = 150;
const codes = Array.from({ length: N }, (_, i) => 'm' + String(i).padStart(3, '0'));
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  property: [{ code: 'grade', type: 'code' }, { code: 'status', uri: 'http://hl7.org/fhir/concept-properties#status', type: 'code' }],
  concept: codes.map((code, i) => ({
    code, display: 'Display ' + code, definition: 'Definition ' + code,
    designation: [{ language: 'de', value: 'Anzeige ' + code }],
    property: [{ code: 'grade', valueCode: 'g' + (i % 3) }, ...(i % 7 === 3 ? [{ code: 'status', valueCode: 'retired' }] : [])]
  }))
};

// imported value sets: every code, by a filter; listed codes with displays, designations and labels
// of their own (some differ from the code system's); one that imports the listed one again
const BY_FILTER = vs('by-filter', { include: [{ system: CS_URL, filter: [{ property: 'grade', op: 'in', value: 'g0,g1,g2' }] }] });
const LISTED = vs('listed', { include: [{ system: CS_URL, concept: codes.slice(0, 120).reverse().map((code, i) => ({
  code,
  ...(i % 2 === 0 ? { display: 'VS display ' + code } : {}),
  ...(i % 5 === 0 ? { designation: [{ language: 'fr', value: 'Affichage ' + code }] } : {}),
  ...(i % 4 === 0 ? { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/valueset-label', valueString: 'L' + i }] } : {})
})) }] }, { language: 'en' });
const NESTED = vs('nested', { include: [{ valueSet: [LISTED.url] }, { system: CS_URL, concept: codes.slice(130, 140).map(code => ({ code, display: 'Nested ' + code })) }] });
const WHOLE = vs('whole', { include: [{ system: CS_URL }] });
const IMPORTS = [BY_FILTER, LISTED, NESTED, WHOLE];

function vs(name, compose, extra = {}) {
  return { resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/import-membership-' + name, version: '1.0.0', status: 'active', ...extra, compose };
}
let n = 0;
function outer(compose) {
  n++;
  return vs('outer-' + n, compose);
}
// a language pack that applies to every value set (global), for some of the codes
const GLOBAL_PACK = {
  resourceType: 'CodeSystem', url: 'http://example.org/fhir/CodeSystem/import-membership-uz', version: '1.0.0', status: 'active',
  content: 'supplement', supplements: CS_URL, language: 'uz',
  extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/codesystem-supplement-type', valueCode: 'lang-pack' },
    { url: 'http://hl7.org/fhir/StructureDefinition/codesystem-supplement-global', valueBoolean: true }],
  concept: codes.slice(60, 90).map(code => ({ code, designation: [{ language: 'uz', value: 'Ko\'rsatish ' + code }] }))
};
function expand(app, valueSet, { offset, count, extra = [], resources = [] } = {}) {
  const parameter = [{ name: 'tx-resource', resource: CS }, ...[...IMPORTS, ...resources].map(resource => ({ name: 'tx-resource', resource })),
    { name: 'valueSet', resource: valueSet }, ...extra];
  if (offset !== undefined) parameter.push({ name: 'offset', valueInteger: offset });
  if (count !== undefined) parameter.push({ name: 'count', valueInteger: count });
  return request(app).post('/tx/r5/ValueSet/$expand').set('Content-Type', 'application/json').send({ resourceType: 'Parameters', parameter });
}
// the expansion without what differs from one request to the next, and the codes and properties
const rest = (exp) => ({ ...exp, timestamp: undefined, identifier: undefined, contains: undefined, total: undefined, offset: undefined,
  property: undefined, parameter: (exp.parameter || []).filter(p => !['offset', 'count'].includes(p.name)) });
// the property declarations a page has: the whole expansion's that the page's codes use. (Their
// order is the order the page's codes first use them, as for any paged expansion)
const declared = (exp) => (exp.property || []).map(p => JSON.stringify(p)).sort();
function declaredFor(whole, contains) {
  const used = new Set((contains || []).flatMap(c => (c.property || []).map(p => p.code)));
  return declared({ property: (whole.property || []).filter(p => used.has(p.code)) });
}

describe('$expand of a value set that imports another: only the codes returned are built', () => {
  let app;
  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);
  afterAll(async () => {
    await shutdownTestApp();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  const extra = [{ name: 'includeDesignations', valueBoolean: true }, { name: 'property', valueString: 'grade' }, { name: 'property', valueString: 'definition' }];

  const cases = {
    'an import of a filter': outer({ include: [{ valueSet: [BY_FILTER.url] }] }),
    'an import of listed codes with displays, designations and labels of its own': outer({ include: [{ valueSet: [LISTED.url] }] }),
    'nested imports: an import that imports the listed codes again': outer({ include: [{ valueSet: [NESTED.url] }] }),
    'two imports, the second testing membership': outer({ include: [{ valueSet: [WHOLE.url, LISTED.url] }] }),
    'an import, and codes of the code system after it': outer({ include: [{ valueSet: [LISTED.url] }, { system: CS_URL, concept: codes.slice(100, 150).map(code => ({ code })) }] }),
    'a filter that only keeps the codes an import has': outer({ include: [{ system: CS_URL, filter: [{ property: 'grade', op: '=', value: 'g1' }], valueSet: [LISTED.url] }] })
  };
  for (const [name, valueSet] of Object.entries(cases)) {
    test(`${name}: each page is that slice of the whole expansion, with the same details, and only its codes are read`, async () => {
      const whole = await expand(app, valueSet, { extra });
      expect(whole.status).toBe(200);
      const all = whole.body.expansion.contains;
      expect(all.length).toBeGreaterThan(30);
      for (const [offset, count] of [[0, 10], [25, 10], [all.length - 5, 10], [0, all.length + 5]]) {
        const spy = jest.spyOn(FhirCodeSystemProvider.prototype, 'designations');
        const res = await expand(app, valueSet, { offset, count, extra });
        expect(res.status).toBe(200);
        expect(res.body.expansion.contains).toEqual(all.slice(offset, offset + count));
        expect(res.body.expansion.total).toBe(whole.body.expansion.total);
        expect(rest(res.body.expansion)).toEqual(rest(whole.body.expansion));
        expect(declared(res.body.expansion)).toEqual(declaredFor(whole.body.expansion, res.body.expansion.contains));
        // each code returned is read once (one in the code system and the import counts twice
        // for an outer include that reads its own), and the codes not returned aren't read
        expect(spy.mock.calls.length).toBeLessThanOrEqual(2 * Math.min(count, all.length - offset));
        spy.mockRestore();
      }
    });
  }

  for (const [name, langExtra] of [['with designations', []], ['in the language pack\'s language', [{ name: 'displayLanguage', valueCode: 'uz' }]]]) {
    test(`a global language pack, ${name}: the same codes, details and supplements reported as when every code is built`, async () => {
      const valueSet = outer({ include: [{ valueSet: [LISTED.url] }] });
      const all = [...extra, ...langExtra];
      const whole = await expand(app, valueSet, { extra: all, resources: [GLOBAL_PACK] });
      expect(whole.status).toBe(200);
      // (the pack is reported as used: its codes are on no page below but the second)
      expect((whole.body.expansion.parameter || []).filter(p => p.name === 'used-supplement').map(p => p.valueUri))
        .toEqual([GLOBAL_PACK.url + '|1.0.0']);
      for (const [offset, count] of [[0, 10], [40, 10], [100, 10]]) {
        const res = await expand(app, valueSet, { offset, count, extra: all, resources: [GLOBAL_PACK] });
        expect(res.status).toBe(200);
        expect(res.body.expansion.contains).toEqual(whole.body.expansion.contains.slice(offset, offset + count));
        expect(rest(res.body.expansion)).toEqual(rest(whole.body.expansion));
      }
    });
  }

  test('the imported codes are as the import has them: its own displays, designations and labels, nested imports included', async () => {
    // the import's own expansion, built in full
    const direct = await expand(app, NESTED, { extra });
    const want = new Map(direct.body.expansion.contains.map(c => [c.code, c]));
    const res = await expand(app, outer({ include: [{ valueSet: [NESTED.url] }] }), { offset: 20, count: 30, extra });
    expect(res.body.expansion.contains).toHaveLength(30);
    for (const c of res.body.expansion.contains) {
      expect(c).toEqual(want.get(c.code));
    }
    const byCode = new Map(res.body.expansion.contains.map(c => [c.code, c]));
    expect((byCode.get('m099').designation || []).map(d => d.value)).toEqual(expect.arrayContaining(['VS display m099', 'Affichage m099']));
    expect(byCode.get('m095').property.find(p => p.code === 'label').valueString).toBe('L24');
  });

  test('count=0: the total, and no code\'s details are read', async () => {
    const valueSet = outer({ include: [{ valueSet: [LISTED.url] }] });
    const whole = await expand(app, valueSet, { extra });
    const spy = jest.spyOn(FhirCodeSystemProvider.prototype, 'designations');
    const res = await expand(app, valueSet, { count: 0, extra });
    expect(res.status).toBe(200);
    expect(res.body.expansion.total).toBe(whole.body.expansion.total);
    expect(res.body.expansion.contains).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  test('an import with an exclude: each page is that slice of the whole expansion, and only its codes are read', async () => {
    const valueSet = outer({ include: [{ valueSet: [LISTED.url] }], exclude: [{ system: CS_URL, concept: [{ code: 'm100' }, { code: 'm050' }] }] });
    const whole = await expand(app, valueSet, { extra });
    expect(whole.status).toBe(200);
    const all = whole.body.expansion.contains;
    expect(all.map(c => c.code)).not.toContain('m100');
    for (const [offset, count] of [[0, 10], [40, 10], [all.length - 5, 10]]) {
      const spy = jest.spyOn(FhirCodeSystemProvider.prototype, 'designations');
      const res = await expand(app, valueSet, { offset, count, extra });
      expect(res.body.expansion.contains).toEqual(all.slice(offset, offset + count));
      expect(res.body.expansion.total).toBe(whole.body.expansion.total);
      expect(rest(res.body.expansion)).toEqual(rest(whole.body.expansion));
      expect(declared(res.body.expansion)).toEqual(declaredFor(whole.body.expansion, res.body.expansion.contains));
      expect(spy.mock.calls.length).toBeLessThanOrEqual(Math.min(count, all.length - offset));
      spy.mockRestore();
    }
  });

  test('an excluded import: only which codes it has is read', async () => {
    const valueSet = outer({ include: [{ system: CS_URL }], exclude: [{ valueSet: [LISTED.url] }] });
    const spy = jest.spyOn(FhirCodeSystemProvider.prototype, 'designations');
    const res = await expand(app, valueSet, { extra });
    expect(res.status).toBe(200);
    expect(res.body.expansion.contains.map(c => c.code)).toEqual(codes.slice(120));
    // the include reads each code before it is refused as excluded; the excluded import reads none
    expect(spy.mock.calls.length).toBe(N);
  });

  test('sorted by display: the import is built in full, so the page holds the same codes as without the import', async () => {
    // the imported value set is sorted by display before its codes are taken: the page is its first codes in that order
    const sort = [...extra, { name: 'sort', valueString: 'display' }];
    const direct = await expand(app, LISTED, { extra: sort });
    const res = await expand(app, outer({ include: [{ valueSet: [LISTED.url] }] }), { offset: 0, count: 10, extra: sort });
    expect(res.status).toBe(200);
    const first = direct.body.expansion.contains.slice(0, 10).map(c => c.code).sort();
    expect(res.body.expansion.contains.map(c => c.code).sort()).toEqual(first);
  });
});
