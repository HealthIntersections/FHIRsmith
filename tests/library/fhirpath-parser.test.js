//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// library/fhirpath/parser.js: FHIRPath text to the Java engine's ExpressionNode tree.

const fs = require('fs');
const path = require('path');
const { parse, FHIRPathParseError } = require('../../library/fhirpath/parser');
const { Kind, Function, Operation, ExpressionNode } = require('../../library/fhirpath/expression-node');
const { testCaseFile } = require('../helpers/fhir-test-cases');

const loc = (l) => l && `${l.line},${l.column}`;

describe('the same tree as the Java parser', () => {
  // toString() of the Java FHIRPathEngine's parse of these (org.hl7.fhir.r5 7.0.7): the
  // groups in parentheses are the ones the precedence made
  const JAVA = [
    ['a + b * c - d', 'a + (b * c) - d'],
    ['a * b + c * d', '(a * b) + (c * d)'],
    ['a = b and c = d or e', '((a = b) and (c = d)) or e'],
    ['(a or b) and c implies d xor e', '((a or b) and c) implies (d xor e)'],
    ['a | b | c.where(x > 1)', 'a | b | c.where(x > 1)'],
    ['Patient.name.where(use = \'official\').given.first()', 'Patient.name.where(use = \'official\').given.first()'],
    ['a is FHIR.Patient and b as string', '(a is FHIR.Patient) and (b as string)'],
    ['a.as(Patient).id', 'a.as(Patient).id'],
    ['a[0].b[1] | c', 'a[0].b[1] | c'],
    ['%resource.id', '%resource.id'],
    ['%`vs-x`.contains(code)', '%`vs-x`.contains(code)'],
    ['@2020-01-01 < @2021 and @T10:00 > now()', '(@2020-01-01 < @2021) and (@T10:00 > now())'],
    ['{}.empty()', '{}.empty()'],
    ['x.iif(y, 1, 2.5)', 'x.iif(y, 1, 2.5)'],
    ['true implies false xor true', 'true implies (false xor true)'],
    ['a in b and c contains d', '(a in b) and (c contains d)'],
    ['\'a\' & \'b\' + \'c\'', '\'a\' & \'b\' + \'c\''],
    ['a != b and c !~ d and e ~ f', '(a != b) and (c !~ d) and (e ~ f)'],
    ['a.b.c div 2 mod 3', 'a.b.c div 2 mod 3'],
    ['Bundle.entry.resource.ofType(Patient).name.family.exists().not()', 'Bundle.entry.resource.ofType(Patient).name.family.exists().not()']
  ];

  test.each(JAVA)('%s', (text, java) => {
    expect(parse(text).toString()).toBe(java);
  });

  test('a path is a chain through inner, and the operator is on its first node', () => {
    const n = parse('Patient.name.given = \'x\'');
    expect(n.kind).toBe(Kind.Name);
    expect(n.name).toBe('Patient');
    expect(n.proximal).toBe(true);
    expect(n.inner.name).toBe('name');
    expect(n.inner.inner.name).toBe('given');
    expect(n.inner.inner.inner).toBeNull();
    expect(n.operation).toBe(Operation.Equals);
    expect(loc(n.opStart)).toBe('1,20');
    expect(n.opNext.kind).toBe(Kind.Constant);
    expect(n.opNext.constant).toEqual({ type: 'string', value: 'x' });
    expect(n.opNext.proximal).toBe(false);
  });

  test('operators of one level are one chain; a higher one is a group', () => {
    const n = parse('a + b * c - d');
    expect(n.operation).toBe(Operation.Plus);
    const g = n.opNext;
    expect(g.kind).toBe(Kind.Group);
    expect(g.operation).toBe(Operation.Minus);
    expect(g.group.name).toBe('b');
    expect(g.group.proximal).toBe(true);
    expect(g.group.operation).toBe(Operation.Times);
    expect(g.group.opNext.name).toBe('c');
    expect(g.opNext.name).toBe('d');
  });

  test('functions: their parameters each start an expression', () => {
    const n = parse('where(a = 1)');
    expect(n.kind).toBe(Kind.Function);
    expect(n.function).toBe(Function.Where);
    expect(n.proximal).toBe(true);
    const w = parse('x.where(a = 1).exists()').inner;
    expect(w.function).toBe(Function.Where);
    expect(w.name).toBe('where');
    expect(w.parameters).toHaveLength(1);
    expect(w.parameters[0].proximal).toBe(true);
    expect(w.parameters[0].operation).toBe(Operation.Equals);
    expect(w.inner.function).toBe(Function.Exists);
    expect(w.inner.parameters).toEqual([]);
  });

  test('an indexer is a Function Item in the chain', () => {
    const n = parse('a[0].b');
    expect(n.inner.kind).toBe(Kind.Function);
    expect(n.inner.function).toBe(Function.Item);
    expect(n.inner.name).toBeNull();
    expect(n.inner.parameters[0].constant).toEqual({ type: 'integer', value: '0' });
    expect(n.inner.inner.name).toBe('b');
    expect(loc(n.inner.start)).toBe('1,2');
    expect(loc(n.inner.end)).toBe('1,5');
  });

  test('is / as name a type, which can be qualified', () => {
    const n = parse('a is FHIR.Patient');
    expect(n.operation).toBe(Operation.Is);
    expect(n.opNext.kind).toBe(Kind.Name);
    expect(n.opNext.name).toBe('FHIR');
    expect(n.opNext.inner.name).toBe('Patient');
    expect(parse('a as Quantity').opNext.name).toBe('Quantity');
  });
});

describe('constants', () => {
  const c = (text) => parse(text).constant;

  test('as Java\'s types', () => {
    expect(c('\'a\\tb\\u0041\\\'\'')).toEqual({ type: 'string', value: 'a\tbA\'' });
    expect(c('12')).toEqual({ type: 'integer', value: '12' });
    expect(c('1.50')).toEqual({ type: 'decimal', value: '1.50' });
    expect(c('5L')).toEqual({ type: 'integer64', value: '5' });
    expect(c('true')).toEqual({ type: 'boolean', value: 'true' });
    expect(c('{}')).toBeNull();
    expect(parse('{}').isNullSet()).toBe(true);
    expect(c('@2020-01-02T10:00:00Z')).toEqual({ type: 'constant', value: '@2020-01-02T10:00:00Z' });
    expect(c('@T10:00')).toEqual({ type: 'constant', value: '@T10:00' });
    expect(c('%resource')).toEqual({ type: 'constant', value: '%resource' });
    expect(c('%`vs-x`')).toEqual({ type: 'constant', value: '%vs-x' });
    expect(c('%\'us-zip\'')).toEqual({ type: 'constant', value: '%us-zip' });
  });

  test('quantities: UCUM, and the calendar durations', () => {
    expect(c('4 \'mg\'')).toEqual({ type: 'Quantity', value: '4', unit: null, system: 'http://unitsofmeasure.org', code: 'mg' });
    expect(c('3 days')).toEqual({ type: 'Quantity', value: '3', unit: 'days', system: 'http://unitsofmeasure.org', code: 'd', calendar: true });
    expect(c('1 year')).toEqual({ type: 'Quantity', value: '1', unit: 'year', system: null, code: null, calendar: true });
    expect(parse('3 days').toString()).toBe('3 days');
    expect(parse('4.5 \'mg\'').toString()).toBe('4.5 \'mg\'');
  });

  test('bad escapes', () => {
    expect(() => parse('\'a\\qb\'')).toThrow('Unknown FHIRPath character escape \\q');
    expect(() => parse('\'\\u12\'')).toThrow('Invalid FHIRPath unicode escape');
  });
});

describe('unary + and -', () => {
  test('apply to their operand (as the grammar has it)', () => {
    const n = parse('-a.b');
    expect(n.kind).toBe(Kind.Unary);
    expect(n.operation).toBe(Operation.Minus);
    expect(n.opNext.name).toBe('a');
    expect(n.opNext.inner.name).toBe('b');
    expect(n.toString()).toBe('-a.b');
  });

  test('are a group in an operator chain', () => {
    const n = parse('-1 < 2');
    expect(n.kind).toBe(Kind.Group);
    expect(n.group.kind).toBe(Kind.Unary);
    expect(n.operation).toBe(Operation.LessThan);
    expect(n.toString()).toBe('(-1) < 2');
    expect(parse('a * -b').toString()).toBe('a * (-b)');
  });
});

describe('names', () => {
  test('delimited names lose their delimiters, and are written with them when they need them', () => {
    const n = parse('text.`div`.exists() and `a b`');
    expect(n.inner.name).toBe('div');
    expect(n.opNext.name).toBe('a b');
    expect(n.toString()).toBe('text.div.exists() and `a b`');
  });

  test('$this, $index, $total', () => {
    const p = parse('x.where($this = $index)').inner.parameters[0];
    expect(p.name).toBe('$this');
    expect(p.opNext.name).toBe('$index');
    expect(parse('x.aggregate($this + $total, 0)').inner.parameters[0].opNext.name).toBe('$total');
  });

  test('sort(): directions on the parameters', () => {
    const n = parse('x.sort(a desc, b asc, c)').inner;
    expect(n.function).toBe(Function.Sort);
    expect(n.parameters.map(p => p.direction || null)).toEqual(['desc', 'asc', null]);
    expect(n.toString()).toBe('sort(a desc, b asc, c)');
  });
});

describe('where things are', () => {
  test('start and end of nodes, and of operators', () => {
    const n = parse('name.where(use = \'x\')');
    expect(loc(n.start)).toBe('1,1');
    expect(loc(n.end)).toBe('1,5');
    expect(loc(n.inner.start)).toBe('1,6');
    expect(loc(n.inner.end)).toBe('1,22');
    const p = n.inner.parameters[0];
    expect(loc(p.opStart)).toBe('1,16');
    expect(loc(p.opEnd)).toBe('1,17');
  });

  test('over lines and comments', () => {
    const n = parse('\'A\n\t\t\tB\'.matches(\'A.*B\')');
    expect(loc(n.end)).toBe('2,6');
    expect(loc(n.inner.start)).toBe('2,7');
    const m = parse('2 + /* a comment */ 2 = 4');
    expect(loc(m.group.opNext.start)).toBe('1,21');
  });
});

describe('errors', () => {
  test('syntax: where it is', () => {
    let e = null;
    try {
      parse('name.(');
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(FHIRPathParseError);
    expect(e.line).toBe(1);
    expect(e.column).toBe(6);
    expect(e.message).toMatch(/^Error @1, 6: mismatched input '\('/);
  });

  test('empty', () => {
    expect(() => parse('')).toThrow('Path cannot be empty');
    expect(() => parse('  ')).toThrow('Path cannot be empty');
    expect(() => parse(null)).toThrow('Path cannot be empty');
  });

  test('functions: known, and how many parameters (as Java)', () => {
    expect(() => parse('a.nosuch()')).toThrow('The name nosuch is not a known function name');
    expect(() => parse('a.where()')).toThrow('The function "where" requires 1 parameters');
    expect(() => parse('a.substring(1, 2, 3)')).toThrow('The function "substring" requires between 1 and 2 parameters');
    expect(() => parse('a.coalesce()')).toThrow('The function "coalesce" requires between 1 and any number of parameters');
    expect(() => parse('a.section(1, 2, 3)')).toThrow('The function "section" requires 2 or 4 parameters');
    expect(parse('a.section(1, 2)').inner.function).toBe(Function.Section);
  });

  test('functions the host knows about are Custom', () => {
    const resolveFunction = (name) => (name === 'mine' ? { minParameters: 1, maxParameters: 1 } : null);
    const n = parse('a.mine(1)', { resolveFunction });
    expect(n.inner.function).toBe(Function.Custom);
    expect(n.inner.name).toBe('mine');
    expect(() => parse('a.mine()', { resolveFunction })).toThrow('The function "mine" requires 1 parameters');
    expect(() => parse('a.other()', { resolveFunction })).toThrow('not a known function name');
    expect(parse('a.other(1, 2)', { allowUnknownFunctions: true }).inner.function).toBe(Function.Custom);
  });

  test('instance selectors are not supported', () => {
    expect(() => parse('Quantity { value: 1 }')).toThrow('Instance selectors are not supported');
  });
});

describe('ExpressionNode', () => {
  test('check() finds broken trees', () => {
    const n = new ExpressionNode(1);
    expect(n.check()).toBe('Error in expression - node has no kind');
    n.kind = Kind.Name;
    n.name = 'a';
    expect(n.check()).toBeNull();
    n.operation = Operation.Plus;
    expect(n.check()).toMatch(/^No Next provided/);
  });

  test('getDistalNames(), nodes()', () => {
    expect(parse('a.b.c').getDistalNames()).toEqual(['c']);
    expect(parse('a.b.exists()').getDistalNames()).toEqual([null]);
    expect([...parse('a.where(b = 1) | c').nodes()].map(n => n.name || n.kind)).toEqual(['a', 'where', 'b', 'Constant', 'c']);
  });
});

/** The tree, as data (for comparing two trees) */
function shape(n) {
  if (!n) {
    return null;
  }
  return [n.kind, n.name, n.function, n.constant, n.operation, n.proximal, n.direction || null,
    (n.parameters || []).map(shape), shape(n.group), shape(n.inner), shape(n.opNext)];
}

describe('real expressions', () => {
  // the search parameters' expressions (the R4 definitions the rest tests use), and the
  // FHIRPath test suite's
  const definitions = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/rest/r4-definitions.json'), 'utf8'));
  const fromDefinitions = [...new Set(definitions.searchParameters.map(sp => sp.expression).filter(Boolean))];

  const suite = fs.readFileSync(testCaseFile('r5/fhirpath/tests-fhir-r5.xml'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&');
  const fromSuite = [];
  for (const m of suite.matchAll(/<expression([^>]*)>([\s\S]*?)<\/expression>/g)) {
    const invalid = /invalid="(\w+)"/.exec(m[1]);
    fromSuite.push({ text: unxml(m[2]), invalid: invalid ? invalid[1] : null });
  }

  test('there are some', () => {
    expect(fromDefinitions.length).toBeGreaterThan(200);
    expect(fromSuite.length).toBeGreaterThan(1000);
  });

  test('every search parameter expression parses, and comes back the same from toString()', () => {
    for (const text of fromDefinitions) {
      const n = parse(text);
      expect(n.check()).toBeNull();
      expect(shape(parse(n.toString()))).toEqual(shape(n));
    }
  });

  test('the test suite\'s expressions parse, except the ones that are meant not to', () => {
    // fhirpath.js's grammar is stricter than Java's parser about these: div is a keyword
    // (text.`div` is right), and times have no time zone
    const STRICTER = new Set(['text.div.htmlChecks()', '@T14:34:28Z.is(Time)', '@T14:34:28+10:00.is(Time)']);
    const failed = [];
    for (const { text, invalid } of fromSuite) {
      let n = null;
      try {
        n = parse(text, { allowUnknownFunctions: true });
      } catch (e) {
        if (invalid !== 'syntax' && invalid !== 'semantic' && !STRICTER.has(text)) {
          failed.push(`${text}: ${e.message}`);
        }
        continue;
      }
      expect(shape(parse(n.toString(), { allowUnknownFunctions: true }))).toEqual(shape(n));
    }
    expect(failed).toEqual([]);
  });
});
