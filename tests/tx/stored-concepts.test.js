/**
 * A value set include whose concept list is kept in a store (tx/library/stored-concepts.js):
 * $validate-code asks the list about the one code (lookup) instead of reading every entry, and
 * gives the same answers as for an ordinary array.
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');
const { ValueSetChecker } = require('../../tx/workers/validate');
const { STORED_CONCEPTS, storedList, hasConcepts } = require('../../tx/library/stored-concepts');

const CS_URL = 'http://example.org/fhir/CodeSystem/stored-concepts-cs';
const N = 50;
const codes = Array.from({ length: N }, (_, i) => 'c' + i);
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  concept: [...codes, 'unlisted', 'alt7'].map(code => ({ code, display: 'Display ' + code }))
};
const VS_URL = 'http://example.org/fhir/ValueSet/stored-concepts-vs';
const VS = {
  resourceType: 'ValueSet', url: VS_URL, version: '1.0.0', status: 'active',
  compose: { include: [{ system: CS_URL, concept: codes.map(code => ({ code, display: 'VS display ' + code })) }] }
};

/** turn an include into a stored list: `concept` reads (and counts) the list, the handle answers lookups */
function makeStored(cset, stats) {
  const list = cset.concept;
  delete cset.concept;
  Object.defineProperty(cset, 'concept', {
    get() { stats.reads++; return list; }, enumerable: false, configurable: true
  });
  cset[STORED_CONCEPTS] = {
    count: list.length,
    lookup: async (code) => { stats.lookups.push(code); return list.filter(cc => cc.code === code); }
  };
}

describe('stored-concepts helpers', () => {
  test('an ordinary include', async () => {
    const inc = { system: 'x', concept: [{ code: 'a' }, { code: 'b' }, { code: 'a', display: 'again' }] };
    expect(storedList(inc)).toBeNull();
    expect(hasConcepts(inc)).toBe(true);
    expect(hasConcepts({ system: 'x' })).toBe(false);
    expect(hasConcepts({ system: 'x', concept: [] })).toBe(true); // as !!cset.concept
  });

  test('a stored include is asked, not read', async () => {
    const stats = { reads: 0, lookups: [] };
    const inc = { system: 'x', concept: [{ code: 'a' }, { code: 'b' }] };
    makeStored(inc, stats);
    expect(storedList(inc).count).toBe(2);
    expect(hasConcepts(inc)).toBe(true);
    expect(await storedList(inc).lookup('b')).toEqual([{ code: 'b' }]);
    expect(stats).toEqual({ reads: 0, lookups: ['b'] });
  });
});

describe('$validate-code against a stored concept list', () => {
  let app;
  let stats;
  let stored; // whether the next request's include is turned into a stored list
  const spies = [];

  beforeAll(async () => {
    app = await getTestApp();
    const origPrepare = ValueSetChecker.prototype.prepare;
    spies.push(jest.spyOn(ValueSetChecker.prototype, 'prepare').mockImplementation(async function (...args) {
      const compose = this.valueSet && this.valueSet.jsonObj.compose;
      if (stored && compose && this.valueSet.url === VS_URL) {
        for (const inc of compose.include) {
          if (!storedList(inc)) {
            makeStored(inc, stats);
          }
        }
      }
      return origPrepare.apply(this, args);
    }));
  }, 60000);

  afterAll(async () => {
    spies.forEach(s => s.mockRestore());
    await shutdownTestApp();
  });

  async function validate(coding, extra = []) {
    const res = await request(app).post('/tx/r5/ValueSet/$validate-code')
      .set('Content-Type', 'application/json')
      .send({ resourceType: 'Parameters', parameter: [
        { name: 'tx-resource', resource: CS },
        { name: 'valueSet', resource: structuredClone(VS) },
        ...(coding ? [{ name: 'coding', valueCoding: coding }] : []),
        ...extra
      ] });
    expect(res.status).toBe(200);
    const out = {};
    for (const p of res.body.parameter) {
      if (p.name !== 'issues') {
        out[p.name] = p.valueBoolean ?? p.valueString ?? p.valueCode ?? p.valueUri;
      }
    }
    return out;
  }

  /** the answer for an ordinary list, then for the stored list (and what the stored list was asked) */
  async function both(coding, extra) {
    stored = false;
    const plain = await validate(coding, extra);
    stored = true;
    stats = { reads: 0, lookups: [] };
    const fromStore = await validate(coding, extra);
    return { plain, fromStore, stats };
  }

  test('a listed code: one lookup, the list is not read, same answer', async () => {
    const { plain, fromStore, stats } = await both({ system: CS_URL, code: 'c25' });
    expect(plain.result).toBe(true);
    expect(fromStore).toEqual(plain);
    expect(stats.lookups).toEqual(['c25']);
    expect(stats.reads).toBe(0);
  });

  test('a code that is not listed: the list is not read, same answer', async () => {
    const { plain, fromStore, stats } = await both({ system: CS_URL, code: 'unlisted' });
    expect(plain.result).toBe(false);
    expect(fromStore).toEqual(plain);
    expect(stats.reads).toBe(0);
  });

  test('inferring the system from the value set asks the list too', async () => {
    const { plain, fromStore, stats } = await both(null, [{ name: 'code', valueCode: 'c3' }, { name: 'inferSystem', valueBoolean: true }]);
    expect(plain.result).toBe(true);
    expect(plain.system).toBe(CS_URL);
    expect(fromStore).toEqual(plain);
    expect(stats.lookups).toContain('c3');
    expect(stats.reads).toBe(0);
  });

  test('a code listed in another form (ICD-11 short code vs id): the whole list is read, same answer', async () => {
    // 'alt7' stands for the same concept as the listed 'c7': it has a classification code, and
    // its code() is 'c7' (otherFormMatch locates each listed code and compares code())
    const origCode = FhirCodeSystemProvider.prototype.code;
    const s1 = jest.spyOn(FhirCodeSystemProvider.prototype, 'classificationCode').mockImplementation(async function (ctx) {
      return this.system() === CS_URL && (await origCode.call(this, ctx)) === 'alt7' ? 'x' : null;
    });
    const s2 = jest.spyOn(FhirCodeSystemProvider.prototype, 'code').mockImplementation(async function (ctx) {
      const c = await origCode.call(this, ctx);
      return this.system() === CS_URL && c === 'alt7' ? 'c7' : c;
    });
    try {
      const { plain, fromStore, stats } = await both({ system: CS_URL, code: 'alt7' });
      expect(plain.result).toBe(true);
      expect(fromStore).toEqual(plain);
      expect(stats.lookups).toEqual(['alt7']);
      expect(stats.reads).toBeGreaterThan(0);
    } finally {
      s1.mockRestore();
      s2.mockRestore();
    }
  });
});
