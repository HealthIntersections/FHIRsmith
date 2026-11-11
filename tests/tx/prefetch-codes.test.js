/**
 * CodeSystemProvider.prefetchCodes: before the worker locates each code a value set lists, the
 * provider is told the whole list, once - so a provider that reads from a database can read them
 * together. It returns a handle (or null), which the worker passes back as locate(code, prefetched)
 * for each code of that list. The default returns null, so the answers are the same either way.
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');
const { CodeSystemProvider } = require('../../tx/cs/cs-api');

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

describe('CodeSystemProvider.prefetchCodes: the default', () => {
  test('returns null: this provider does no prefetching', async () => {
    expect(await CodeSystemProvider.prototype.prefetchCodes.call(null, ['a1'], true)).toBeNull();
  });
});

/**
 * A provider that reads from a "database" (a Map here, counting its reads): prefetchCodes reads the
 * list in one go and returns a handle; locate answers from a handle of its own, and reads the
 * database for anything else.
 */
class DbLikeProvider extends CodeSystemProvider {
  constructor(db) {
    super(null);
    this.db = db;
    this.reads = 0;
  }
  _ensureOpContext() { }
  system() { return 'http://example.org/db-like'; }

  async prefetchCodes(list) {
    this.reads++;
    return { owner: this, found: new Map(list.filter(c => this.db.has(c)).map(c => [c, this.db.get(c)])) };
  }

  async locate(code, prefetched = null) {
    if (prefetched && prefetched.owner === this) {
      const context = prefetched.found.get(code);
      return context ? { context, message: null, fromHandle: true } : { context: null, message: 'not found: ' + code, fromHandle: true };
    }
    this.reads++;
    const context = this.db.get(code);
    return context ? { context, message: null } : { context: null, message: 'not found: ' + code };
  }
}

describe('CodeSystemProvider.prefetchCodes: a provider that prefetches', () => {
  const db = () => new Map(codes.map(c => [c, { code: c }]));

  test('locate answers from its handle, with no further reads', async () => {
    const cs = new DbLikeProvider(db());
    const h = await cs.prefetchCodes(['a1', 'a2', 'zz'], false);
    expect(cs.reads).toBe(1);
    const r1 = await cs.locate('a1', h);
    const rz = await cs.locate('zz', h);
    expect(r1).toEqual({ context: { code: 'a1' }, message: null, fromHandle: true });
    expect(rz.context).toBeNull();
    expect(rz.fromHandle).toBe(true);
    expect(cs.reads).toBe(1);
  });

  test('locate without a handle, or with another provider\'s, looks the code up as usual', async () => {
    const cs = new DbLikeProvider(db());
    const other = new DbLikeProvider(db());
    const foreign = await other.prefetchCodes(['a1'], false);
    expect(await cs.locate('a3')).toEqual({ context: { code: 'a3' }, message: null });
    expect(await cs.locate('a3', null)).toEqual({ context: { code: 'a3' }, message: null });
    expect(await cs.locate('a1', foreign)).toEqual({ context: { code: 'a1' }, message: null });
    expect(cs.reads).toBe(3);
  });

  test('two lists in progress on one provider: each handle answers for its own list', async () => {
    const cs = new DbLikeProvider(db());
    const h1 = await cs.prefetchCodes(['a1', 'a2'], false);
    const h2 = await cs.prefetchCodes(['a3', 'a4'], false);
    // interleaved, as two value set loops on one provider would be
    expect((await cs.locate('a1', h1)).context).toEqual({ code: 'a1' });
    expect((await cs.locate('a3', h2)).context).toEqual({ code: 'a3' });
    expect((await cs.locate('a2', h1)).context).toEqual({ code: 'a2' });
    expect((await cs.locate('a4', h2)).context).toEqual({ code: 'a4' });
    // a handle doesn't see the other list (with hidden state, the later prefetch would win)
    expect((await cs.locate('a3', h1)).context).toBeNull();
    expect((await cs.locate('a1', h2)).context).toBeNull();
    expect(cs.reads).toBe(2);
  });
});

describe('CodeSystemProvider.prefetchCodes: the workers pass the handle back', () => {
  let app;
  let events;
  const spies = [];

  beforeAll(async () => {
    app = await getTestApp();
    const origLocate = FhirCodeSystemProvider.prototype.locate;
    let n = 0;
    // FhirCodeSystemProvider made to prefetch: the handle holds what locate found for each code,
    // and locate answers from a handle of its own
    spies.push(jest.spyOn(FhirCodeSystemProvider.prototype, 'prefetchCodes').mockImplementation(async function (list, withDesignations) {
      if (this.system() !== CS_URL) {
        return null;
      }
      const handle = { owner: this, id: ++n, found: new Map() };
      for (const c of list) {
        handle.found.set(c, await origLocate.call(this, c));
      }
      events.push({ prefetch: [...list], withDesignations, handle: handle.id });
      return handle;
    }));
    spies.push(jest.spyOn(FhirCodeSystemProvider.prototype, 'locate').mockImplementation(async function (code, prefetched = null) {
      if (this.system() !== CS_URL) {
        return origLocate.call(this, code);
      }
      if (prefetched && prefetched.owner === this && prefetched.found.has(code)) {
        events.push({ locate: code, handle: prefetched.id });
        return prefetched.found.get(code);
      }
      events.push({ locate: code, handle: null });
      return origLocate.call(this, code);
    }));
  }, 60000);

  afterAll(async () => {
    spies.forEach(s => s.mockRestore());
    await shutdownTestApp();
  });

  beforeEach(() => {
    events = [];
  });

  const prefetches = () => events.filter(e => e.prefetch);
  const locates = () => events.filter(e => e.locate);

  test('$expand: an include that lists codes - the list once, and each locate gets its handle', async () => {
    const vs = { resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/prefetch-1', status: 'active',
      compose: { include: [{ system: CS_URL, concept: codes.map(code => ({ code })) }] } };
    const res = await post(app, '$expand', [{ name: 'valueSet', resource: vs }]);
    expect(res.status).toBe(200);
    expect(res.body.expansion.contains.map(c => c.code)).toEqual(codes);

    expect(prefetches().map(({ prefetch, withDesignations }) => ({ prefetch, withDesignations })))
      .toEqual([{ prefetch: codes, withDesignations: true }]);
    const h = prefetches()[0].handle;
    expect(locates()).toEqual(codes.map(locate => ({ locate, handle: h })));
  });

  test('$expand count=0: the counting pass gets a handle of its own', async () => {
    const vs = { resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/prefetch-4', status: 'active',
      compose: { include: [{ system: CS_URL, concept: codes.map(code => ({ code })) }] } };
    const res = await post(app, '$expand', [{ name: 'valueSet', resource: vs }, { name: 'count', valueInteger: 0 }]);
    expect(res.status).toBe(200);
    expect(res.body.expansion.total).toBe(codes.length);

    // counting builds nothing: no designations wanted, and the concept loop doesn't run
    expect(prefetches().map(e => e.withDesignations)).toEqual([false]);
    expect(locates()).toEqual(codes.map(locate => ({ locate, handle: prefetches()[0].handle })));
  });

  test('$expand: an include and an exclude that list codes - two handles, each for its own list', async () => {
    const vs = { resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/prefetch-2', status: 'active',
      compose: { include: [{ system: CS_URL, concept: ['a1', 'a2', 'a3'].map(code => ({ code })) }],
        exclude: [{ system: CS_URL, concept: [{ code: 'a2' }, { code: 'a4' }] }] } };
    const res = await post(app, '$expand', [{ name: 'valueSet', resource: vs }]);
    expect(res.status).toBe(200);
    expect(res.body.expansion.contains.map(c => c.code)).toEqual(['a1', 'a3']);

    const inc = prefetches().find(e => e.prefetch.length === 3);
    const exc = prefetches().find(e => e.prefetch.length === 2);
    expect(inc.prefetch).toEqual(['a1', 'a2', 'a3']);
    expect(exc).toEqual({ prefetch: ['a2', 'a4'], withDesignations: false, handle: exc.handle });
    expect(inc.handle).not.toBe(exc.handle);
    // every locate was answered from a handle, and from the one for the list it came from
    expect(locates().every(e => e.handle !== null)).toBe(true);
    expect(locates().filter(e => e.handle === exc.handle).map(e => e.locate)).toEqual(['a2', 'a4']);
    expect(locates().filter(e => e.handle === inc.handle).map(e => e.locate)).toEqual(['a1', 'a2', 'a3']);
  });

  test('$validate-code: the listed codes compared with a code that is not listed come from the handle', async () => {
    // otherFormMatch locates listed codes only for a code system with two spellings of a
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

      expect(prefetches().map(e => [e.prefetch, e.withDesignations])).toEqual([[codes, false]]);
      const h = prefetches()[0].handle;
      // 'other' (the code asked about) isn't in the list: it is located as usual
      expect(locates().filter(e => codes.includes(e.locate))).toEqual(codes.map(locate => ({ locate, handle: h })));
      expect(locates().filter(e => e.locate === 'other').every(e => e.handle === null)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
