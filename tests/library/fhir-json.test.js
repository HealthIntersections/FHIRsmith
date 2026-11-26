//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// library/fhir-json.js: numbers kept as they were written, and duplicate properties found.

const { parse, reviver, stringify, clone, copyNotes, writtenAs, findDuplicates } = require('../../library/fhir-json');

describe('numbers, as they were written', () => {
  const text = '{"resourceType":"Observation","valueQuantity":{"value":1.0,"unit":"mg"},"component":[{"valueQuantity":{"value":2.50}},' +
    '{"valueInteger":3}],"x":[1E+3,-0,12345678901234567890,0.1,1e-24],"s":"1.0","v":"4.0.1"}';

  test('come back the same, while the values are numbers', () => {
    const o = parse(text);
    expect(o.valueQuantity.value).toBe(1);
    expect(o.component[0].valueQuantity.value).toBe(2.5);
    expect(o.x).toEqual([1000, -0, 12345678901234567000, 0.1, 1e-24]);
    expect(stringify(o)).toBe(text);
    expect(writtenAs(o.valueQuantity, 'value')).toBe('1.0');
    expect(writtenAs(o.x, 1)).toBe('-0');
    expect(writtenAs(o.x, 3)).toBeUndefined();
  });

  test('indented too, and with a replacer', () => {
    const o = parse(text);
    expect(stringify(o, null, 2)).toContain('"value": 1.0,');
    expect(stringify(o, (k, v) => (k === 'unit' ? undefined : v))).toContain('"valueQuantity":{"value":1.0}');
    expect(() => stringify(o, ['a'])).toThrow(/replacer must be a function/);
  });

  test('a value that has changed is written as usual', () => {
    const o = parse(text);
    o.valueQuantity.value = 7;
    o.component[0].valueQuantity.value = 2.5;
    const out = stringify(o);
    expect(out).toContain('"value":7,');
    // the same value: still as written
    expect(out).toContain('"value":2.50');
  });

  test('clone keeps the notes, a plain copy doesn\'t', () => {
    const o = parse(text);
    expect(stringify(clone(o))).toBe(text);
    expect(stringify(structuredClone(o))).toContain('"value":1,');
    const rebuilt = { ...o.valueQuantity };
    expect(stringify(rebuilt)).toBe('{"value":1,"unit":"mg"}');
    copyNotes(o.valueQuantity, rebuilt);
    expect(stringify(rebuilt)).toBe('{"value":1.0,"unit":"mg"}');
  });

  test('the reviver, for express.json', () => {
    const o = JSON.parse(text, reviver);
    expect(stringify(o)).toBe(text);
  });

  test('text without such numbers is parsed plainly; a reviver still works; errors are JSON.parse\'s', () => {
    expect(parse('{"a":1.5,"b":"x"}')).toEqual({ a: 1.5, b: 'x' });
    expect(parse(Buffer.from('{"a":2.0}')).a).toBe(2);
    expect(parse('{"a":2.0,"b":"x"}', (k, v) => (k === 'b' ? 'y' : v))).toEqual({ a: 2, b: 'y' });
    expect(() => parse('{"a":')).toThrow(SyntaxError);
  });
});

describe('findDuplicates', () => {
  test('properties more than once, where they are', () => {
    const t = '{"a":1,"b":{"x":1,"x":2},"a":[{"q\\u0041":1,"qA":2}],"s":"{\\"s\\":1,\\"s\\":2}","list":[{"y":1},{"y":2,"y":3}]}';
    expect(findDuplicates(t)).toEqual([
      { path: 'b', name: 'x', offset: 18 },
      { path: '', name: 'a', offset: 25 },
      { path: 'a[0]', name: 'qA', offset: 43 },
      { path: 'list[1]', name: 'y', offset: 99 }
    ]);
    expect(findDuplicates('{"a":{"a":{"a":1}}}')).toEqual([]);
    expect(findDuplicates('[{"a":1},{"a":1}]')).toEqual([]);
     // the offset is where the later name starts
    expect(t.substring(18, 21)).toBe('"x"');
    expect(t.substring(99, 102)).toBe('"y"');
  });
});
