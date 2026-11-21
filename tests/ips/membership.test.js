const { MembershipSession } = require('../../ips/membership');
const { IpsValueSets } = require('../../ips/ips-valuesets');

const S = 'http://snomed.info/sct';
const cc = (...codes) => ({ coding: codes.map(code => ({ system: S, code, display: 'x' })) });

// a terminology server: codes starting with 1 are in every value set, 'boom' breaks it
function fakeTx() {
  const tx = {
    internal: false,
    calls: [],
    async post(path, params) {
      tx.calls.push(params);
      const concept = params.parameter.find(p => p.name === 'codeableConcept').valueCodeableConcept;
      if (concept.coding.some(c => c.code === 'boom')) {
        return { status: 500, resource: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception', details: { text: 'kaboom' } }] } };
      }
      const url = params.parameter.find(p => p.name === 'url')?.valueUri;
      if (url === 'http://unknown.org/vs') {
        return { status: 404, resource: { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-found', details: { text: 'Unknown value set' } }] } };
      }
      return { status: 200, resource: { resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: concept.coding.some(c => c.code.startsWith('1')) }] } };
    }
  };
  return tx;
}

describe('value set membership', () => {
  const VS = 'http://example.org/vs';
  test('asks each question once, and remembers definite answers across sessions', async () => {
    const tx = fakeTx();
    const cache = new Map();
    const one = new MembershipSession(tx, null, { cache });
    const [a, b, c] = await Promise.all([one.check(VS, cc('123')), one.check(VS, cc('123')), one.check(VS, cc('999'))]);
    expect([a, b, c]).toEqual([true, true, false]);
    expect(tx.calls).toHaveLength(2);
    // the same codes in another order are the same question; displays don't matter
    expect(await one.check(VS, { coding: [{ system: S, code: '123', display: 'other' }] })).toBe(true);
    expect(tx.calls).toHaveLength(2);
    expect(tx.calls[0].parameter).toEqual([{ name: 'url', valueUri: VS }, { name: 'codeableConcept', valueCodeableConcept: { coding: [{ system: S, code: '123' }] } }]);
    // a new session (the next document) gets them from the cache, synchronously
    const two = new MembershipSession(tx, null, { cache });
    expect(two.check(VS, cc('123'))).toBe(true);
    expect(two.check(VS, cc('999'))).toBe(false);
    expect(tx.calls).toHaveLength(2);
    // nothing to ask about
    expect(two.check(VS, { coding: [] })).toBe(false);
    expect(two.check(VS, null)).toBe(false);
  });

  test('what it can\'t find out is null, reported, and not remembered beyond the session', async () => {
    const tx = fakeTx();
    const cache = new Map();
    const s = new MembershipSession(tx, null, { cache });
    expect(await s.check(VS, cc('boom'))).toBeNull();
    expect(await s.check('http://unknown.org/vs', cc('123'))).toBeNull();
    expect(s.unresolved()).toEqual([{ valueSet: VS, message: 'kaboom' }, { valueSet: 'http://unknown.org/vs', message: 'Unknown value set' }]);
    expect([...cache.keys()]).toEqual([]);
    // within the session it isn't asked again
    expect(s.check(VS, cc('boom'))).toBeNull();
    expect(tx.calls).toHaveLength(2);
  });

  test('a version is sent as the value set version; our own value sets go with the question', async () => {
    const tx = fakeTx();
    const valueSets = new IpsValueSets().load();
    const s = new MembershipSession(tx, valueSets);
    await s.check(`${VS}|2.0`, cc('123'));
    expect(tx.calls[0].parameter.slice(0, 2)).toEqual([{ name: 'url', valueUri: VS }, { name: 'valueSetVersion', valueString: '2.0' }]);
    const own = 'http://healthintersections.com.au/fhirsmith/ValueSet/ips-condition-code';
    await s.check(own, cc('123'));
    expect(tx.calls[1].parameter[0]).toMatchObject({ name: 'valueSet', resource: { url: own } });
  });

  test('a budget, and no server', async () => {
    const tx = fakeTx();
    const s = new MembershipSession(tx, null, { maxQuestions: 1 });
    expect(await s.check(VS, cc('123'))).toBe(true);
    expect(await s.check(VS, cc('124'))).toBeNull();
    expect(s.unresolved()[0].message).toMatch(/More than 1 value set questions/);
    const none = new MembershipSession(null, null);
    expect(await none.check(VS, cc('123'))).toBeNull();
    expect(none.unresolved()).toEqual([{ valueSet: VS, message: 'No terminology server is configured' }]);
  });

  test('with the FHIRPath functions', async () => {
    const { evaluateAsync } = require('../../ips/fhirpath-ips');
    const tx = fakeTx();
    const s = new MembershipSession(tx, null);
    const bundle = { resourceType: 'Bundle', type: 'document', entry: [
      { resource: { resourceType: 'Composition' } },
      { resource: { resourceType: 'Condition', code: cc('123') } },
      { resource: { resourceType: 'Condition', code: cc('999') } }] };
    expect(await evaluateAsync(bundle, `Bundle.resourcesIn('${VS}', 'Condition').count()`, { membership: s.membership })).toEqual([1]);
    expect(tx.calls).toHaveLength(2);
  });
});
