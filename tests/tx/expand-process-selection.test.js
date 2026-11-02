/**
 * $expand hands a whole compose to a code system provider that handles selecting
 * (CodeSystemProvider.handlesSelecting / processSelection; see ValueSetExpander.processCodes).
 *
 * The provider here is the ordinary FHIR CodeSystem provider, told to handle selecting for one
 * test code system only. Its processSelection selects from the CodeSystem's concepts (an include
 * of the whole system, an exclude with a `concept in` filter), applies offset and count, and
 * reports the total - or declines (null), in which case the usual include/exclude path must give
 * the same expansion as a provider that doesn't handle selecting at all.
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const { FhirCodeSystemProvider, FhirCodeSystemProviderFilterContext } = require('../../tx/cs/cs-cs');

const CS_URL = 'http://example.org/fhir/CodeSystem/process-selection-cs';
const N = 12;
const codes = Array.from({ length: N }, (_, i) => 'c' + String(i).padStart(2, '0'));
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  concept: codes.map(code => ({ code, display: 'Display ' + code }))
};

let vsCounter = 0;
function valueSet(compose) {
  vsCounter++;
  return {
    resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/process-selection-' + vsCounter,
    version: '1.0.0', status: 'active', compose
  };
}
const wholeSystem = { system: CS_URL };
const excludeTwo = { system: CS_URL, filter: [{ property: 'concept', op: 'in', value: 'c01,c02' }] };

async function expand(app, vs, extra = []) {
  const res = await request(app).post('/tx/r5/ValueSet/$expand')
    .set('Content-Type', 'application/json')
    .send({ resourceType: 'Parameters', parameter: [
      { name: 'tx-resource', resource: CS },
      { name: 'valueSet', resource: vs },
      ...extra
    ] });
  expect(res.status).toBe(200);
  return res.body;
}
const codesOf = (vs) => (vs.expansion.contains || []).map(c => c.code);

/** the selection a provider would make for this test code system (filters: `concept in` only) */
function select(includes, excludes) {
  const inFilter = (cset) => {
    const f = (cset.filter || [])[0];
    return f ? new Set(f.value.split(',')) : null;
  };
  const out = [];
  for (const code of codes) {
    const inc = includes.some(cset => { const s = inFilter(cset); return s == null || s.has(code); });
    const exc = excludes.some(cset => { const s = inFilter(cset); return s == null || s.has(code); });
    if (inc && !exc) {
      out.push(code);
    }
  }
  return out;
}

describe('$expand: handing a whole compose to the provider (processSelection)', () => {
  let app;
  let calls;
  let behaviour; // 'handle' | 'decline' | 'no-total'
  const spies = [];

  beforeAll(async () => {
    app = await getTestApp();
    const origHandles = FhirCodeSystemProvider.prototype.handlesSelecting;
    spies.push(jest.spyOn(FhirCodeSystemProvider.prototype, 'handlesSelecting').mockImplementation(function () {
      return this.system() === CS_URL && behaviour !== 'off' ? true : origHandles.call(this);
    }));
    spies.push(jest.spyOn(FhirCodeSystemProvider.prototype, 'processSelection').mockImplementation(async function (params, includes, excludes, excludeInactive, offset, count) {
      calls.push({ includes, excludes, excludeInactive, offset, count });
      if (behaviour === 'decline') {
        return null;
      }
      const all = select(includes, excludes);
      const start = Math.max(offset, 0);
      const page = count < 0 ? all.slice(start) : all.slice(start, start + count);
      const set = new FhirCodeSystemProviderFilterContext();
      for (const code of page) {
        set.add(this.codeSystem.getConceptByCode(code));
      }
      return { sets: [set], total: behaviour === 'no-total' ? -1 : all.length };
    }));
  }, 60000);

  afterAll(async () => {
    spies.forEach(s => s.mockRestore());
    await shutdownTestApp();
  });

  beforeEach(() => {
    calls = [];
    behaviour = 'handle';
  });

  test('the provider gets the includes and excludes, and its codes and total make the expansion', async () => {
    const vs = await expand(app, valueSet({ include: [wholeSystem], exclude: [excludeTwo] }));
    expect(calls).toHaveLength(1);
    expect(calls[0].includes).toEqual([wholeSystem]);
    expect(calls[0].excludes).toEqual([excludeTwo]);
    expect(calls[0].offset).toBe(-1);
    expect(calls[0].count).toBe(-1);
    expect(codesOf(vs)).toEqual(codes.filter(c => c !== 'c01' && c !== 'c02'));
    expect(vs.expansion.total).toBe(N - 2);
    expect(vs.expansion.contains[0].display).toBe('Display c00');
    expect(vs.expansion.parameter.some(p => p.name === 'used-codesystem' && p.valueUri === CS_URL + '|1.0.0')).toBe(true);
  });

  test('paging: the provider gets offset and count, and the page it returns is not paged again', async () => {
    const vs = await expand(app, valueSet({ include: [wholeSystem], exclude: [excludeTwo] }),
      [{ name: 'offset', valueInteger: 3 }, { name: 'count', valueInteger: 4 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].offset).toBe(3);
    expect(calls[0].count).toBe(4);
    expect(codesOf(vs)).toEqual(['c05', 'c06', 'c07', 'c08']);
    expect(vs.expansion.total).toBe(N - 2);
    expect(vs.expansion.offset).toBe(3);
  });

  test('count=0: the total only', async () => {
    const vs = await expand(app, valueSet({ include: [wholeSystem] }), [{ name: 'count', valueInteger: 0 }]);
    expect(calls[0].count).toBe(0);
    expect(vs.expansion.contains).toBeUndefined();
    expect(vs.expansion.total).toBe(N);
  });

  test('a total the provider has not counted (-1) leaves the expansion without one', async () => {
    behaviour = 'no-total';
    const vs = await expand(app, valueSet({ include: [wholeSystem] }), [{ name: 'count', valueInteger: 5 }]);
    expect(codesOf(vs)).toEqual(codes.slice(0, 5));
    expect(vs.expansion.total).toBeUndefined();
  });

  test('declined (null): the usual path gives the same expansion as a provider that does not handle selecting', async () => {
    const compose = { include: [wholeSystem], exclude: [excludeTwo] };
    const paging = [{ name: 'offset', valueInteger: 2 }, { name: 'count', valueInteger: 5 }];
    behaviour = 'decline';
    const declined = await expand(app, valueSet(compose), paging);
    expect(calls).toHaveLength(1);
    behaviour = 'off';
    const usual = await expand(app, valueSet(compose), paging);
    expect(codesOf(declined)).toEqual(codesOf(usual));
    expect(codesOf(declined)).toEqual(['c04', 'c05', 'c06', 'c07', 'c08']);
    expect(declined.expansion.total).toEqual(usual.expansion.total);
  });

  test('handled gives the same codes as the usual path', async () => {
    const compose = { include: [{ system: CS_URL, filter: [{ property: 'concept', op: 'in', value: 'c03,c04,c05,c09' }] }], exclude: [excludeTwo] };
    const handled = await expand(app, valueSet(compose));
    expect(calls).toHaveLength(1);
    behaviour = 'off';
    const usual = await expand(app, valueSet(compose));
    expect(codesOf(handled)).toEqual(codesOf(usual));
    expect(handled.expansion.total).toEqual(usual.expansion.total);
  });

  test.each([
    ['a text filter', { include: [wholeSystem] }, [{ name: 'filter', valueString: 'c03' }]],
    ['an enumerated concept list', { include: [{ system: CS_URL, concept: [{ code: 'c03' }, { code: 'c04' }] }] }, []],
    ['a value set import', { include: [{ system: CS_URL, valueSet: ['http://example.org/fhir/ValueSet/none'] }] }, []],
    ['a second code system', { include: [wholeSystem, { system: 'http://hl7.org/fhir/administrative-gender' }] }, []]
  ])('%s: the compose is not handed over', async (_label, compose, extra) => {
    await request(app).post('/tx/r5/ValueSet/$expand')
      .set('Content-Type', 'application/json')
      .send({ resourceType: 'Parameters', parameter: [
        { name: 'tx-resource', resource: CS }, { name: 'valueSet', resource: valueSet(compose) }, ...extra
      ] });
    expect(calls).toHaveLength(0);
  });
});
