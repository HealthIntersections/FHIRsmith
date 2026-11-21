/**
 * The SNOMED CT expression parser against hostile and malformed input. Found by fuzzing
 * (2026-11-12): an unterminated term read on past the end of the input until V8's string
 * limit - on tx.fhir.org a $validate-code held a worker for 321 s and 17 GB. These need no
 * SNOMED distribution: the parser runs without a concept list.
 */
const { SnomedExpressionParser, SnomedExpressionServices, SnomedServicesRenderOption } = require('../../tx/sct/expressions');
const { SnomedReferences } = require('../../tx/sct/structures');

const parse = (s) => new SnomedExpressionParser().parse(s);
const render = (e) => Object.create(SnomedExpressionServices.prototype).renderExpression(e, SnomedServicesRenderOption.AsIs);

describe('SNOMED CT expression parser: hostile input', () => {
  test.each([
    ['an unterminated term', '86290005 |Atemfrequenz', /Unterminated term/],
    ['an unterminated attribute name term', '64572001:363698007 |Finding site', /Unterminated term/],
    ['an unterminated value term', '64572001:363698007=10200004 |Liver', /Unterminated term/],
    ['a term over 1024 characters', '64572001 |' + 'x'.repeat(1025) + '|', /Term too long/]
  ])('%s fails at once', (_name, source, message) => {
    const t0 = Date.now();
    expect(() => parse(source)).toThrow(message);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('a term of 1024 characters is fine', () => {
    expect(parse('64572001 |' + 'x'.repeat(1024) + '|').concepts[0].description).toHaveLength(1024);
  });

  test('a NUL is a character, not the end of the input', () => {
    expect(() => parse('64572001\u0000garbage')).toThrow(/after end of expression/);
    expect(parse('64572001 |a\u0000b|').concepts[0].description).toBe('a\u0000b');
  });

  test('an expression is at most 100,000 characters', () => {
    expect(() => parse('64572001 ' + ' '.repeat(100000))).toThrow(/longer than 100000 characters/);
  });

  test('an expression has at most 500 concepts', () => {
    const many = (n) => '64572001:' + Array.from({ length: n }, () => '363698007=10200004').join(',');
    expect(() => parse(many(249))).not.toThrow(); // 1 + 2 x 249 = 499
    expect(() => parse(many(250))).toThrow(/more than 500 concepts/);
  });

  test('a concept id is at most 18 digits', () => {
    expect(parse('9'.repeat(18)).concepts[0].code).toBe('9'.repeat(18));
    expect(() => parse('9'.repeat(19))).toThrow(/at most 18 digits/);
    expect(() => parse('9'.repeat(1000000))).toThrow(/longer than 100000 characters/);
  });
});

describe('SNOMED CT expression parser: the compositional grammar', () => {
  test.each(['#5', '"abc"', '#5:363698007=10200004', '64572001 + #5', '64572001:363698007=(#5:363698007=10200004)'])(
    'a value is not a focus concept: %s', (source) => {
      expect(() => parse(source)).toThrow(/must be a concept, not a value/);
    });

  test.each(['#', '#.', '#...', '#1.2.3', '#1.', '#.5', '#--1'])('not a number: 64572001:1142135004=%s', (n) => {
    expect(() => parse('64572001:1142135004=' + n)).toThrow(/Not a valid number/);
  });

  test.each(['#250', '#0.5', '#-1', '#+3', '#-0.25'])('a number: 64572001:1142135004=%s', (n) => {
    expect(render(parse('64572001:1142135004=' + n))).toBe('64572001:1142135004=' + n);
  });

  test('a string value can\'t be empty', () => {
    expect(() => parse('64572001:3311482005=""')).toThrow(/can't be empty/);
  });

  test('a string value escapes quotes and backslashes, and renders them escaped', () => {
    const e = parse('64572001:3311482005="say \\"hi\\" \\\\ here"');
    expect(e.refinements[0].value.concepts[0].literal).toBe('say "hi" \\ here');
    const out = render(e);
    expect(out).toBe('64572001:3311482005="say \\"hi\\" \\\\ here"');
    expect(render(parse(out))).toBe(out);
  });
});

describe('SnomedReferences.hasSortedReference', () => {
  function refsOf(lists) {
    const refs = new SnomedReferences();
    refs.startBuild();
    const at = lists.map(l => refs.addReferences(l));
    refs.doneBuild();
    return { refs, at };
  }

  test('finds every member of a sorted list, and nothing else', () => {
    const list = [2, 3, 5, 8, 13, 21, 34, 55, 89];
    const { refs, at } = refsOf([[1], list]);
    for (let v = 0; v < 100; v++) {
      expect(refs.hasSortedReference(at[1], v)).toBe(list.includes(v));
    }
  });

  test('no list', () => {
    const { refs } = refsOf([[1]]);
    expect(refs.hasSortedReference(0, 1)).toBe(false);
    expect(refs.hasSortedReference(0xFFFFFFFF, 1)).toBe(false);
  });
});

test('the expression services have a logger (their warnings used to throw a TypeError)', () => {
  const services = Object.create(SnomedExpressionServices.prototype);
  expect(typeof services.log.warn).toBe('function');
});
