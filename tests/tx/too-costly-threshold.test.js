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
  test('without the header: the configured limit, or 3000', () => {
    expect(tx().externalLimit(req())).toBe(3000);
    expect(tx({ externalLimit: 500 }).externalLimit(req())).toBe(500);
  });

  test('a lower limit is used', () => {
    expect(tx().externalLimit(req('50'))).toBe(50);
    expect(tx({ externalLimit: 500 }).externalLimit(req('50'))).toBe(50);
    expect(tx().externalLimit(req('50', 'Tools/Java'))).toBe(50);
  });

  test('a higher one is allowed up to the internal limit, and no further', () => {
    expect(tx().externalLimit(req('5000'))).toBe(5000);
    expect(tx().externalLimit(req('1000000'))).toBe(10000);
    expect(tx({ internalLimit: 20000 }).externalLimit(req('1000000'))).toBe(20000);
    // the test runner always gets the default internal limit
    expect(tx({ internalLimit: 20000 }).externalLimit(req('1000000', 'Tools/Java'))).toBe(10000);
  });

  test('0, a negative, a fraction or anything that is not a number is ignored: there is always a limit', () => {
    for (const v of ['0', '-5', '2.5', 'abc', '', 'Infinity', '10abc']) {
      expect(tx().externalLimit(req(v))).toBe(3000);
    }
  });
});
