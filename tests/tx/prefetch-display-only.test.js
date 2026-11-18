/**
 * prefetchCodes(codes, withDesignations, { displayOnly }): when $expand locates the codes a value
 * set lists, it tells the provider whether the response shows each code's display and none of its
 * other designations - the request's languages are English or none, it asks for no designations
 * (includeDesignations, designation, displayLanguage), and there is no text filter. A provider may
 * then leave the other designations unread; one that ignores the hint (the default) is unaffected.
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');

const CS_URL = 'http://example.org/fhir/CodeSystem/prefetch-display-only-cs';
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  concept: ['a1', 'a2', 'a3'].map(code => ({ code, display: 'Display ' + code,
    designation: [{ language: 'de', value: 'Anzeige ' + code }] }))
};
const VS = {
  resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/prefetch-display-only', version: '1', status: 'active',
  compose: { include: [{ system: CS_URL, concept: [{ code: 'a1' }, { code: 'a2' }, { code: 'a3' }] }] }
};

describe('$expand tells prefetchCodes when the response shows displays only', () => {
  let app;
  let hints;
  let spy;

  beforeAll(async () => {
    app = await getTestApp();
    spy = jest.spyOn(FhirCodeSystemProvider.prototype, 'prefetchCodes').mockImplementation(async function (codes, withDesignations, h) {
      if (this.system() === CS_URL) {
        hints.push(h);
      }
      return null;
    });
  }, 60000);

  afterAll(async () => {
    spy.mockRestore();
    await shutdownTestApp();
  });

  beforeEach(() => {
    hints = [];
  });

  async function expand(extra = [], headers = {}) {
    let req = request(app).post('/tx/r5/ValueSet/$expand').set('Content-Type', 'application/json');
    for (const [k, v] of Object.entries(headers)) {
      req = req.set(k, v);
    }
    const res = await req.send({ resourceType: 'Parameters', parameter: [
      { name: 'tx-resource', resource: CS }, { name: 'valueSet', resource: VS }, ...extra] });
    expect(res.status).toBe(200);
    expect(hints).toHaveLength(1);
    return { body: res.body, displayOnly: hints[0] && hints[0].displayOnly };
  }

  test('no languages, no designations asked for: displayOnly', async () => {
    const { body, displayOnly } = await expand();
    expect(displayOnly).toBe(true);
    expect(body.expansion.contains.map(c => c.display)).toEqual(['Display a1', 'Display a2', 'Display a3']);
  });

  test('Accept-Language en-US: displayOnly', async () => {
    expect((await expand([], { 'Accept-Language': 'en-US' })).displayOnly).toBe(true);
  });

  test.each([
    ['includeDesignations', [{ name: 'includeDesignations', valueBoolean: true }], {}],
    ['designation', [{ name: 'designation', valueString: 'de' }], {}],
    ['displayLanguage', [{ name: 'displayLanguage', valueCode: 'de' }], {}],
    ['Accept-Language de', [], { 'Accept-Language': 'de' }],
    ['a text filter', [{ name: 'filter', valueString: 'Display' }], {}]
  ])('%s: not displayOnly', async (name, extra, headers) => {
    expect((await expand(extra, headers)).displayOnly).toBe(false);
  });
});
