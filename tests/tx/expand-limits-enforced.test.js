/**
 * The response limit (the request's x-too-costly-threshold, or the server's) and the internal
 * limit (for imported value sets) apply to every expansion: value sets with an exclude, and
 * value sets that import other value sets, are no exception. They are paged like any other, and
 * count=0 still only counts.
 *
 * Before: a value set with an exclude was exempt from the response limit (and from paging), and
 * an imported code didn't count against it, so a value set with an exclude or an import came
 * back whole, whatever its size; and an imported value set with an exclude escaped the internal
 * limit
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const TXModule = require('../../tx/tx');

const CS_URL = 'http://example.org/fhir/CodeSystem/limits';
const IMP_URL = 'http://example.org/fhir/ValueSet/limits-imported';
const N = 300;
const codes = Array.from({ length: N }, (_, i) => 'c' + String(i).padStart(3, '0'));

// root, with 300 children: 301 codes
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1', status: 'active', content: 'complete',
  hierarchyMeaning: 'is-a',
  concept: [{ code: 'root', concept: codes.map(code => ({ code })) }]
};

const isa = { system: CS_URL, filter: [{ property: 'concept', op: 'is-a', value: 'root' }] };
const whole = { system: CS_URL };
const listed = { system: CS_URL, concept: codes.slice(0, 200).map(code => ({ code })) };
const exclude = [{ system: CS_URL, concept: [{ code: 'c000' }] }];
const importIt = { valueSet: [IMP_URL] };

function imported(compose) {
  return { resourceType: 'ValueSet', url: IMP_URL, version: '1', status: 'active', compose };
}

let app;
let n = 0;

beforeAll(async () => {
  app = await getTestApp();
}, 60000);

afterAll(async () => {
  jest.restoreAllMocks();
  await shutdownTestApp();
});

async function expand(compose, { threshold, count, offset, imp } = {}) {
  n++;
  const vs = { resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/limits-' + n, version: '1', status: 'active', compose };
  const parameter = [{ name: 'tx-resource', resource: CS }, { name: 'valueSet', resource: vs }];
  if (imp) {
    parameter.push({ name: 'tx-resource', resource: imp });
  }
  if (count !== undefined) {
    parameter.push({ name: 'count', valueInteger: count });
  }
  if (offset !== undefined) {
    parameter.push({ name: 'offset', valueInteger: offset });
  }
  let r = request(app).post('/tx/r5/ValueSet/$expand').set('Content-Type', 'application/json');
  if (threshold) {
    r = r.set('x-too-costly-threshold', String(threshold));
  }
  return r.send({ resourceType: 'Parameters', parameter });
}

function expectTooCostly(res, limit) {
  expect(res.status).toBe(422);
  expect(res.body.resourceType).toBe('OperationOutcome');
  expect(res.body.issue[0].code).toBe('too-costly');
  expect(res.body.issue[0].details.text).toContain('(>' + limit + ')');
}

function expectPage(res, size, total) {
  expect(res.status).toBe(200);
  expect(res.body.expansion.contains.length).toBe(size);
  expect(res.body.expansion.total).toBe(total);
}

function expectCount(res, total) {
  expect(res.status).toBe(200);
  expect(res.body.expansion.contains).toBeUndefined();
  expect(res.body.expansion.total).toBe(total);
}

describe('the response limit applies to value sets with an exclude', () => {
  test('a filter include', async () => {
    expectTooCostly(await expand({ include: [isa], exclude }, { threshold: 50 }), 50);
  });

  test('a whole code system include', async () => {
    expectTooCostly(await expand({ include: [whole], exclude }, { threshold: 50 }), 50);
  });

  test('listed codes', async () => {
    expectTooCostly(await expand({ include: [listed], exclude }, { threshold: 50 }), 50);
  });

  test('under the limit, the whole expansion', async () => {
    const res = await expand({ include: [isa], exclude }, { threshold: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.expansion.contains.length).toBe(300);
    expect(res.body.expansion.contains.some(c => c.code === 'c000')).toBe(false);
  });
});

describe('the response limit applies to value sets that import value sets', () => {
  test('an imported whole code system', async () => {
    expectTooCostly(await expand({ include: [importIt] }, { threshold: 50, imp: imported({ include: [whole] }) }), 50);
  });

  test('an imported filter', async () => {
    expectTooCostly(await expand({ include: [importIt] }, { threshold: 50, imp: imported({ include: [isa] }) }), 50);
  });

  test('an import, with an exclude', async () => {
    expectTooCostly(await expand({ include: [importIt], exclude }, { threshold: 50, imp: imported({ include: [isa] }) }), 50);
  });
});

describe('value sets with an exclude or an import are paged', () => {
  test('a deep page, past the limit', async () => {
    const res = await expand({ include: [isa], exclude }, { threshold: 50, offset: 100, count: 20 });
    expectPage(res, 20, undefined);
    expect(res.body.expansion.contains[0].code).toBe('c100');
  });

  test('the first page: no total, when the whole is past the limit', async () => {
    expectPage(await expand({ include: [isa], exclude }, { threshold: 50, offset: 0, count: 20 }), 20, undefined);
  });

  test('the first page: a total, when the whole is under the limit', async () => {
    expectPage(await expand({ include: [isa], exclude }, { threshold: 1000, offset: 0, count: 20 }), 20, 300);
  });

  test('an import, a deep page past the limit', async () => {
    expectPage(await expand({ include: [importIt] }, { threshold: 50, offset: 100, count: 20, imp: imported({ include: [isa] }) }), 20, undefined);
  });
});

describe('count=0 only counts, past the limit', () => {
  test('a filter include, with an exclude', async () => {
    expectCount(await expand({ include: [isa], exclude }, { threshold: 50, count: 0 }), 300);
  });

  test('a whole code system include, with an exclude', async () => {
    expectCount(await expand({ include: [whole], exclude }, { threshold: 50, count: 0 }), 300);
  });

  test('listed codes, with an exclude', async () => {
    expectCount(await expand({ include: [listed], exclude }, { threshold: 50, count: 0 }), 199);
  });

  test('an import', async () => {
    expectCount(await expand({ include: [importIt] }, { threshold: 50, count: 0, imp: imported({ include: [isa] }) }), 301);
  });
});

describe('the internal limit applies to imported value sets with an exclude', () => {
  beforeAll(() => {
    jest.spyOn(TXModule.prototype, 'internalLimit').mockReturnValue(100);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  test('without an exclude, as before', async () => {
    expectTooCostly(await expand({ include: [importIt] }, { imp: imported({ include: [isa] }) }), 100);
  });

  test('a filter, with an exclude', async () => {
    expectTooCostly(await expand({ include: [importIt] }, { imp: imported({ include: [isa], exclude }) }), 100);
  });

  test('listed codes, with an exclude', async () => {
    expectTooCostly(await expand({ include: [importIt] }, { imp: imported({ include: [listed], exclude }) }), 100);
  });

  test('a system and an import, together', async () => {
    expectTooCostly(await expand({ include: [{ system: CS_URL, valueSet: [IMP_URL] }] }, { imp: imported({ include: [isa], exclude }) }), 100);
  });

  test('an exclude of a value set', async () => {
    expectTooCostly(await expand({ include: [whole], exclude: [{ valueSet: [IMP_URL] }] }, { imp: imported({ include: [isa], exclude }) }), 100);
  });
});
