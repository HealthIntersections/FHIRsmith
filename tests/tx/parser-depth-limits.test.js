/**
 * Depth and size limits on the expression parsers (VCL, ECL, SNOMED CT compositional
 * grammar, UCUM).
 *
 * All four are recursive descent, and so is everything that walks what they produce.
 * In node a stack overflow is a catchable RangeError, so none of this could crash the
 * server, but it turned hostile input into a 500 or a misleading error, at a depth
 * that varies with JIT state. Each parser now bounds its input and fails with its own
 * parse error. The tests that matter use input deep enough to overflow, and assert
 * the error is ours and not a RangeError.
 *
 * Also here: the VCL filter list loop that never terminated on an unclosed "{" (a
 * 12-byte request cost ~1.7s of event loop and ~1.5GB of memory).
 */

const fs = require('fs');
const path = require('path');
const { parseVCL, validateVCLExpression, VCLParseException, MAX_VCL_DEPTH } = require('../../vcl/vcl-parser');
const { ECLLexer, ECLParser, MAX_ECL_DEPTH, MAX_ECL_TERMS } = require('../../tx/sct/ecl');
const { SnomedExpressionParser, MAX_EXPRESSION_DEPTH } = require('../../tx/sct/expressions');
const { MAX_UCUM_TERMS } = require('../../tx/library/ucum-parsers');
const { UcumService } = require('../../tx/library/ucum-service');

const HOSTILE = 50000;

/** Run fn, and return what it threw (failing the test if it did not throw). */
function thrown(fn) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected an error');
}

describe('VCL parser limits', () => {
  const nested = (n) => '(http://x)' + '('.repeat(n) + 'a' + ')'.repeat(n);

  test('an unterminated filter list is a parse error, promptly', () => {
    for (const vcl of ['(http://x){a', '(http://x){', '(http://x){a{b}', '(http://x)x.{a=b']) {
      const start = Date.now();
      const e = thrown(() => parseVCL(vcl));
      expect(e).toBeInstanceOf(VCLParseException);
      expect(Date.now() - start).toBeLessThan(500);
      expect(validateVCLExpression(vcl)).toBe(false);
    }
  });

  test('a terminated filter list still parses', () => {
    expect(() => parseVCL('(http://x){a}.b')).not.toThrow();
  });

  test('nesting up to the limit parses', () => {
    expect(() => parseVCL(nested(MAX_VCL_DEPTH))).not.toThrow();
  });

  test('nesting past the limit is a parse error', () => {
    const e = thrown(() => parseVCL(nested(MAX_VCL_DEPTH + 1)));
    expect(e).toBeInstanceOf(VCLParseException);
    expect(e.message).toMatch(/nests more than/);
  });

  test('hostile nesting is our error, not a RangeError', () => {
    const e = thrown(() => parseVCL(nested(HOSTILE)));
    expect(e).toBeInstanceOf(VCLParseException);
    expect(e.message).toMatch(/nests more than/);
  });
});

describe('ECL parser limits', () => {
  const parse = (s) => new ECLParser(new ECLLexer(s).tokenize()).parse();
  const parens = (n) => '('.repeat(n) + '< 404684003' + ')'.repeat(n);
  const chain = (n, op) => Array(n).fill('< 404684003').join(` ${op} `);
  const refinements = (n) => '404684003 : ' + '363698007 = ( 404684003 : '.repeat(n) + '363698007 = 404684003' + ' )'.repeat(n);

  test('ordinary nesting parses', () => {
    expect(() => parse(parens(MAX_ECL_DEPTH - 1))).not.toThrow();
    expect(() => parse(refinements(10))).not.toThrow();
    expect(() => parse('404684003 : ' + '( '.repeat(50) + '363698007 = 404684003' + ' )'.repeat(50))).not.toThrow();
  });

  test('nesting past the limit is a parse error', () => {
    expect(thrown(() => parse(parens(MAX_ECL_DEPTH))).message).toMatch(/nests more than/);
  });

  test('hostile nesting is our error, not a RangeError', () => {
    for (const ecl of [
      parens(HOSTILE),
      refinements(HOSTILE),
      '404684003 : ' + '( '.repeat(HOSTILE) + '363698007 = 404684003' + ' )'.repeat(HOSTILE),
      '404684003 : { ' + '( '.repeat(HOSTILE) + '363698007 = 404684003' + ' )'.repeat(HOSTILE) + ' }',
      '^ ( '.repeat(HOSTILE) + '404684003' + ' )'.repeat(HOSTILE)
    ]) {
      const e = thrown(() => parse(ecl));
      expect(e).not.toBeInstanceOf(RangeError);
      expect(e.message).toMatch(/nests more than/);
    }
  });

  test('a compound chain up to the term limit parses', () => {
    for (const op of ['OR', 'AND', 'MINUS']) {
      expect(() => parse(chain(MAX_ECL_TERMS, op))).not.toThrow();
    }
  });

  test('a compound chain past the term limit is a parse error', () => {
    expect(thrown(() => parse(chain(MAX_ECL_TERMS + 1, 'OR'))).message).toMatch(/more than \d+ terms/);
  });

  test('a hostile compound chain is our error - it parses iteratively but builds a left-deep tree', () => {
    const e = thrown(() => parse(chain(HOSTILE, 'OR')));
    expect(e).not.toBeInstanceOf(RangeError);
    expect(e.message).toMatch(/more than \d+ terms/);
  });

  test('a tree at the term limit is safe for a recursive walker', () => {
    const ast = parse(chain(MAX_ECL_TERMS, 'OR'));
    expect(() => JSON.stringify(ast)).not.toThrow();
  });
});

describe('SNOMED CT expression parser limits', () => {
  const parse = (s) => new SnomedExpressionParser().parse(s);
  const nested = (n) => '404684003 : ' + '363698007 = ( 404684003 : '.repeat(n) + '363698007 = 404684003' + ' )'.repeat(n);

  test('nesting up to the limit parses', () => {
    expect(() => parse(nested(MAX_EXPRESSION_DEPTH))).not.toThrow();
  });

  test('nesting past the limit is a parse error', () => {
    expect(thrown(() => parse(nested(MAX_EXPRESSION_DEPTH + 1))).message).toMatch(/nests more than/);
  });

  test('hostile nesting is our error, not a RangeError', () => {
    const e = thrown(() => parse(nested(HOSTILE)));
    expect(e).not.toBeInstanceOf(RangeError);
    // (at this size the expression is past the length limit too, which is checked first)
    expect(e.message).toMatch(/nests more than|longer than 100000 characters/);
  });

  test('the parser is reusable after a depth error', () => {
    const parser = new SnomedExpressionParser();
    expect(() => parser.parse(nested(HOSTILE))).toThrow();
    expect(() => parser.parse(nested(5))).not.toThrow();
  });
});

describe('UCUM parser limits', () => {
  let ucum;

  beforeAll(() => {
    ucum = new UcumService();
    ucum.init(fs.readFileSync(path.join(__dirname, '../../tx/data/ucum-essence.xml'), 'utf8'));
  });

  const product = (n) => Array(n).fill('m').join('.');

  test('ordinary units are untouched', () => {
    expect(ucum.validate('kg.m2/s2')).toBeNull();
    expect(ucum.validate('(' .repeat(20) + 'm' + ')'.repeat(20))).toBeNull();
    expect(ucum.validate(product(MAX_UCUM_TERMS / 2))).toBeNull();
  });

  test('a unit past the term limit is invalid', () => {
    expect(ucum.validate(product(MAX_UCUM_TERMS + 1))).toMatch(/more than \d+ terms/);
  });

  test('hostile units are our error, not a RangeError', () => {
    for (const unit of [product(HOSTILE), '('.repeat(HOSTILE) + 'm' + ')'.repeat(HOSTILE), '/'.repeat(HOSTILE) + 'm']) {
      expect(ucum.validate(unit)).toMatch(/more than \d+ terms/);
      const e = thrown(() => ucum.getCanonicalUnits(unit));
      expect(e).not.toBeInstanceOf(RangeError);
      expect(e.message).toMatch(/more than \d+ terms/);
    }
  });
});
