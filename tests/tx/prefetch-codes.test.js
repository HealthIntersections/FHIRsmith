/**
 * CodeSystemProvider.prefetchCodes: before the worker locates each code a value set lists, the
 * provider is told the whole list, once - so a provider that reads from a database can read them
 * together. The default does nothing, so the answers are the same with or without it.
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');

const CS_URL = 'http://example.org/fhir/CodeSystem/prefetch-codes-cs';
const codes = ['a1', 'a2', 'a3', 'a4', 'a5'];
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  concept: [...codes, 'other'].map(code => ({ code, display: 'Display ' + code }))
};

function post(app, op, parameter) {
  return request(app).post('/tx/r5/ValueSet/' + op)
    .set('Content-Type', 'application/json')
    .send({ resourceType: 'Parameters', parameter: [{ name: 'tx-resource', resource: CS }, ...parameter] });
}

describe('CodeSystemProvider.prefetchCodes', () => {
  let app;
  let events;
  const spies = [];

  beforeAll(async () => {
    app = await getTestApp();
    const origPrefetch = FhirCodeSystemProvider.prototype.prefetchCodes;
    const origLocate = FhirCodeSystemProvider.prototype.locate;
    spies.push(jest.spyOn(FhirCodeSystemProvider.prototype, 'prefetchCodes').mockImplementation(function (list, withDesignations) {
      if (this.system() === CS_URL) {
        events.push({ prefetch: [...list], withDesignations });
      }
      return origPrefetch.call(this, list, withDesignations);
    }));
    spies.push(jest.spyOn(FhirCodeSystemProvider.prototype, 'locate').mockImplementation(function (code, ...rest) {
      if (this.system() === CS_URL) {
        events.push({ locate: code });
      }
      return origLocate.call(this, code, ...rest);
    }));
  }, 60000);

  afterAll(async () => {
    spies.forEach(s => s.mockRestore());
    await shutdownTestApp();
  });

  beforeEach(() => {
    events = [];
  });

  test('$expand: an include that lists codes - the list once, before the locates', async () => {
    const vs = { resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/prefetch-1', status: 'active',
      compose: { include: [{ system: CS_URL, concept: codes.map(code => ({ code })) }] } };
    const res = await post(app, '$expand', [{ name: 'valueSet', resource: vs }]);
    expect(res.status).toBe(200);
    expect(res.body.expansion.contains.map(c => c.code)).toEqual(codes);

    const prefetches = events.filter(e => e.prefetch);
    expect(prefetches).toEqual([{ prefetch: codes, withDesignations: true }]);
    const first = events.findIndex(e => e.prefetch);
    const firstLocate = events.findIndex(e => e.locate);
    expect(first).toBeLessThan(firstLocate);
    expect(events.filter(e => e.locate).map(e => e.locate)).toEqual(codes);
  });

  test('$expand count=0: the counting pass is told the list once, before its locates', async () => {
    const vs = { resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/prefetch-4', status: 'active',
      compose: { include: [{ system: CS_URL, concept: codes.map(code => ({ code })) }] } };
    const res = await post(app, '$expand', [{ name: 'valueSet', resource: vs }, { name: 'count', valueInteger: 0 }]);
    expect(res.status).toBe(200);
    expect(res.body.expansion.total).toBe(codes.length);

    // counting builds nothing: no designations wanted, and the concept loop doesn't run
    expect(events.filter(e => e.prefetch)).toEqual([{ prefetch: codes, withDesignations: false }]);
    expect(events.findIndex(e => e.prefetch)).toBeLessThan(events.findIndex(e => e.locate));
    expect(events.filter(e => e.locate).map(e => e.locate)).toEqual(codes);
  });

  test('$expand: an exclude that lists codes - the list once, before the locates', async () => {
    const vs = { resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/prefetch-2', status: 'active',
      compose: { include: [{ system: CS_URL }], exclude: [{ system: CS_URL, concept: [{ code: 'a2' }, { code: 'a4' }] }] } };
    const res = await post(app, '$expand', [{ name: 'valueSet', resource: vs }]);
    expect(res.status).toBe(200);
    expect(res.body.expansion.contains.map(c => c.code)).toEqual(['a1', 'a3', 'a5', 'other']);

    expect(events.filter(e => e.prefetch)).toEqual([{ prefetch: ['a2', 'a4'], withDesignations: false }]);
    expect(events.findIndex(e => e.prefetch)).toBeLessThan(events.findIndex(e => e.locate === 'a2'));
  });

  test('$validate-code: before the listed codes are compared with a code that is not listed', async () => {
    // sameConceptDifferentForm locates listed codes only for a code system with two spellings of a
    // code (ICD-11): make this one say it has them, so the listed codes are located
    const spy = jest.spyOn(FhirCodeSystemProvider.prototype, 'classificationCode').mockImplementation(async function () {
      return this.system() === CS_URL ? 'x' : null;
    });
    try {
      const vs = { resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/prefetch-3', status: 'active',
        compose: { include: [{ system: CS_URL, concept: codes.map(code => ({ code })) }] } };
      const res = await post(app, '$validate-code', [{ name: 'valueSet', resource: vs },
        { name: 'coding', valueCoding: { system: CS_URL, code: 'other' } }]);
      expect(res.status).toBe(200);
      expect(res.body.parameter.find(p => p.name === 'result').valueBoolean).toBe(false);

      expect(events.filter(e => e.prefetch)).toEqual([{ prefetch: codes, withDesignations: false }]);
      expect(events.findIndex(e => e.prefetch)).toBeLessThan(events.findIndex(e => e.locate === 'a1'));
    } finally {
      spy.mockRestore();
    }
  });
});
