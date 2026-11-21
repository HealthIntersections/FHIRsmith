// x-too-costly-threshold: a request can ask for a lower expansion limit (so test cases can
// pass), or a higher one up to the internal limit - never more, and never "no limit"

const TXModule = require('../../tx/tx');

function tx(config = {}) {
  const m = Object.create(TXModule.prototype);
  m.config = config;
  return m;
}

function req(threshold, userAgent = 'test') {
  const headers = { 'user-agent': userAgent };
  if (threshold !== undefined) {
    headers['x-too-costly-threshold'] = threshold;
  }
  return { headers, header: (name) => headers[name.toLowerCase()] };
}

describe('x-too-costly-threshold', () => {
  test('without the header: the configured limit, or 10000', () => {
    expect(tx().externalLimit(req())).toBe(10000);
    expect(tx({ externalLimit: 500 }).externalLimit(req())).toBe(500);
  });

  test('a lower limit is used', () => {
    expect(tx().externalLimit(req('50'))).toBe(50);
    expect(tx({ externalLimit: 500 }).externalLimit(req('50'))).toBe(50);
    expect(tx().externalLimit(req('50', 'Tools/Java'))).toBe(50);
  });

  test('a higher one is allowed up to the internal limit, and no further', () => {
    expect(tx().externalLimit(req('50000'))).toBe(50000);
    expect(tx().externalLimit(req('10000000'))).toBe(100000);
    expect(tx({ internalLimit: 20000 }).externalLimit(req('1000000'))).toBe(20000);
  });

  test('the test runner (Tools/Java) gets the same limits as any client', () => {
    expect(tx({ externalLimit: 500 }).externalLimit(req(undefined, 'Tools/Java'))).toBe(500);
    expect(tx({ internalLimit: 20000 }).externalLimit(req('1000000', 'Tools/Java'))).toBe(20000);
    expect(tx({ internalLimit: 20000 }).internalLimit(req(undefined, 'Tools/Java'))).toBe(20000);
  });

  test('0, a negative, a fraction or anything that is not a number is ignored: there is always a limit', () => {
    for (const v of ['0', '-5', '2.5', 'abc', '', 'Infinity', '10abc']) {
      expect(tx().externalLimit(req(v))).toBe(10000);
    }
  });
});

describe('the configured expansion limits', () => {
  test('the defaults: external 10000, internal 100000, walk 10 x internal', () => {
    expect(TXModule.expansionLimits({})).toEqual({ external: 10000, internal: 100000, walk: 1000000 });
    expect(TXModule.expansionLimits({ internalLimit: 20000 })).toEqual({ external: 10000, internal: 20000, walk: 200000 });
    // an internal limit below the default external one takes it down with it
    expect(TXModule.expansionLimits({ internalLimit: 5000 })).toEqual({ external: 5000, internal: 5000, walk: 50000 });
    expect(TXModule.expansionLimits({ externalLimit: '2000', internalLimit: '30000', walkLimit: '30000' })).toEqual({ external: 2000, internal: 30000, walk: 30000 });
  });

  test('a value that is not a whole number above 0 stops startup', () => {
    for (const v of [0, -5, 2.5, 'abc', '', true]) {
      expect(() => TXModule.expansionLimits({ externalLimit: v })).toThrow(/^modules\.tx\.externalLimit must be a whole number above 0/);
      expect(() => TXModule.expansionLimits({ internalLimit: v })).toThrow(/^modules\.tx\.internalLimit must be a whole number above 0/);
      expect(() => TXModule.expansionLimits({ walkLimit: v })).toThrow(/^modules\.tx\.walkLimit must be a whole number above 0/);
    }
  });

  test('external <= internal <= walk', () => {
    expect(() => TXModule.expansionLimits({ externalLimit: 20000, internalLimit: 10000 })).toThrow(/externalLimit \(20000\) can't be more than internalLimit \(10000\)/);
    expect(() => TXModule.expansionLimits({ walkLimit: 50000 })).toThrow(/walkLimit \(50000\) can't be less than internalLimit \(100000\)/);
  });
});
