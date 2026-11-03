/**
 * A code that is not in an enumerated include costs one lookup of the code, not one per listed code.
 *
 * Before checking whether a listed concept is the same concept written in another form (ICD-11's
 * short code and entity id), the checker located the code once per listed concept, though the
 * answer (does the code have another form at all?) does not depend on the listed concept. A miss
 * against a 33,000-code VSAC list never finished. It is now asked once per include.
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');
const { ValueSetChecker } = require('../../tx/workers/validate');

const CS_URL = 'http://example.org/fhir/CodeSystem/enumerated-miss-cs';
const VS_URL = 'http://example.org/fhir/ValueSet/enumerated-miss-vs';
const N = 300;
const codes = Array.from({ length: N }, (_, i) => 'c' + i);
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  concept: [...codes, 'unlisted'].map(code => ({ code, display: 'Display ' + code }))
};
const VS = {
  resourceType: 'ValueSet', url: VS_URL, version: '1.0.0', status: 'active',
  compose: { include: [{ system: CS_URL, concept: codes.map(code => ({ code })) }] }
};

async function validate(app, code) {
  return request(app).post('/tx/r5/ValueSet/$validate-code')
    .set('Content-Type', 'application/json')
    .send({ resourceType: 'Parameters', parameter: [
      { name: 'tx-resource', resource: CS },
      { name: 'valueSet', resource: VS },
      { name: 'coding', valueCoding: { system: CS_URL, code } }
    ] });
}

const resultOf = (res) => res.body.parameter.find(p => p.name === 'result').valueBoolean;

describe('$validate-code: a miss against an enumerated include', () => {
  let app;
  beforeAll(async () => { app = await getTestApp(); }, 60000);
  afterAll(async () => { await shutdownTestApp(); });

  test.each([
    ['in the code system but not listed', 'unlisted'],
    ['not in the code system', 'no-such-code']
  ])('a code %s is located a handful of times, not once per listed code', async (_label, code) => {
    const spy = jest.spyOn(FhirCodeSystemProvider.prototype, 'locate');
    try {
      const res = await validate(app, code);
      expect(res.status).toBe(200);
      expect(resultOf(res)).toBe(false);
      const lookupsOfCode = spy.mock.calls.filter(c => c[0] === code).length;
      expect(lookupsOfCode).toBeLessThan(10);
    } finally {
      spy.mockRestore();
    }
  });

  test('a listed code still validates', async () => {
    const res = await validate(app, 'c150');
    expect(res.status).toBe(200);
    expect(resultOf(res)).toBe(true);
  });
});

/**
 * otherFormMatch against the loop it replaces, on a code system with two spellings per concept
 * (as ICD-11 has): an entity id, and for most concepts a short code. The old loop called
 * sameConceptDifferentForm for each listed concept in turn and took the first that said yes.
 */
describe('otherFormMatch gives what the old loop gave', () => {
  // canonical code -> short code (null: no short code, so only one spelling)
  const concepts = { 100: '1A00', 200: '1B00', 300: null, 400: '1D00' };
  const byForm = new Map();
  for (const [id, short] of Object.entries(concepts)) {
    byForm.set(id, { id, short });
    if (short) byForm.set(short, { id, short });
  }
  const fakeCs = () => ({
    locate: jest.fn(async (code) => ({ context: byForm.get(code) || null })),
    classificationCode: async (ctxt) => ctxt.short,
    code: async (ctxt) => ctxt.id
  });
  const checker = Object.create(ValueSetChecker.prototype);

  async function oldLoop(cs, code, list) {
    if (list && !list.some(cc => cc.code === code)) {
      for (const cc of list) {
        if (await checker.sameConceptDifferentForm(cs, code, cc.code)) {
          return cc;
        }
      }
    }
    return null;
  }

  // every code as asked (each spelling, and unknown ones) against many lists of listed codes
  const asked = [...byForm.keys(), 'nope', '9Z99'];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const lists = [[]];
  for (let i = 0; i < 200; i++) {
    lists.push(Array.from({ length: 1 + rnd(6) }, () => ({ code: asked[rnd(asked.length)] })));
  }

  test('the same listed concept (or none) for every code and list', async () => {
    let matches = 0;
    for (const code of asked) {
      for (const list of lists) {
        const expected = await oldLoop(fakeCs(), code, list);
        const actual = await checker.otherFormMatch(fakeCs(), code, list);
        expect(actual).toBe(expected);
        if (actual) matches++;
      }
    }
    expect(matches).toBeGreaterThan(50); // the comparison exercised real matches, not just misses
  });

  test('a code with one spelling is located once, however long the list', async () => {
    const list = Array.from({ length: 1000 }, (_, i) => ({ code: 'x' + i }));
    for (const code of ['300', 'nope']) {
      const cs = fakeCs();
      expect(await checker.otherFormMatch(cs, code, list)).toBeNull();
      expect(cs.locate).toHaveBeenCalledTimes(1);
    }
  });

  test('an empty list locates nothing, as before', async () => {
    const cs = fakeCs();
    expect(await checker.otherFormMatch(cs, '100', [])).toBeNull();
    expect(cs.locate).not.toHaveBeenCalled();
  });
});
