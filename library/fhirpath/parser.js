//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * FHIRPath text to an ExpressionNode tree (library/fhirpath/expression-node.js), without
 * evaluating it. fhirpath.js's parser (its ANTLR grammar) reads the text, and the parse tree it
 * makes is turned into the tree the Java FHIRPathEngine parses to, so that the Java engine's
 * type checking can work over it. What Java's parser checks as it goes is checked here too:
 * that functions are known, and how many parameters they have.
 *
 * This reads fhirpath.js's ANTLR parse tree (src/parser/generated), not the JSON that its
 * parse() gives, because only the parse tree has where each node ends and every token as it
 * was written.
 *
 * Where this differs from Java's parser:
 *  - a unary +/- applies to its operand, as the grammar says ("-a + b" is (-a) + b; Java's
 *    parser makes it -(a + b)). In an operator chain, it's a Group, since a Unary node has
 *    its own operation
 *  - an operator chain starts on the first node of its first operand, also when that operand
 *    starts with an indexer (Java's parser puts it on the indexer: "a[0] + b")
 *  - a function's end is after its ')' (Java: after its name)
 *  - sort()'s arguments can have asc / desc after them: the parameter's `direction`
 *  - more than one indexer in a row ("a[0][1]") is allowed
 *  - long literals (5L) are constants of type 'integer64'
 *  - instance selectors (Quantity { value: 1 }), which Java doesn't have, are an error
 *
 * @module library/fhirpath/parser
 */

const antlr4 = require('fhirpath/src/parser/antlr4-index.js');
const Lexer = require('fhirpath/src/parser/generated/FHIRPathLexer.js');
const Parser = require('fhirpath/src/parser/generated/FHIRPathParser.js');
const {
  ExpressionNode, SourceLocation, Kind, Function, functionFromCode, operationFromCode
} = require('./expression-node');

/** A problem with the text of an expression: where it is (line and column, from 1) */
class FHIRPathParseError extends Error {
  constructor(message, line, column) {
    super(line != null ? `Error @${line}, ${column}: ${message}` : message);
    this.name = 'FHIRPathParseError';
    this.detail = message;
    this.line = line;
    this.column = column;
  }
}

// how many parameters each function takes, as Java's checkParameters: [min, max], or
// { oneOf: [a, b] }
const PARAM_COUNTS = {
  Empty: [0, 0], Not: [0, 0], Exists: [0, 1], SubsetOf: [1, 1], SupersetOf: [1, 1],
  IsDistinct: [0, 0], Distinct: [0, 0], Count: [0, 0], Where: [1, 1], Select: [1, 1],
  All: [0, 1], Repeat: [1, 1], Aggregate: [1, 2], Item: [1, 1], As: [1, 1], OfType: [1, 1],
  Type: [0, 0], Is: [1, 1], Single: [0, 0], First: [0, 0], Last: [0, 0], Tail: [0, 0],
  Skip: [1, 1], Take: [1, 1], Union: [1, 1], Combine: [1, 1], Intersect: [1, 1],
  Exclude: [1, 1], Iif: [2, 3], Lower: [0, 0], Upper: [0, 0], ToChars: [0, 0],
  IndexOf: [1, 1], Substring: [1, 2], StartsWith: [1, 1], EndsWith: [1, 1], Matches: [1, 1],
  MatchesFull: [1, 1], ReplaceMatches: [2, 2], Contains: [1, 1], Replace: [2, 2],
  Length: [0, 0], Children: [0, 0], Descendants: [0, 0], MemberOf: [1, 1], Trace: [1, 2],
  DefineVariable: [1, 2], Check: [2, 2], Today: [0, 0], Now: [0, 0], Resolve: [0, 0],
  Extension: [1, 1], AllFalse: [0, 0], AnyFalse: [0, 0], AllTrue: [0, 0], AnyTrue: [0, 0],
  HasValue: [0, 0], Encode: [1, 1], Decode: [1, 1], Escape: [1, 1], Unescape: [1, 1],
  Trim: [0, 0], Split: [1, 1], Join: [0, 1], HtmlChecks1: [0, 0], HtmlChecks2: [0, 0],
  Comparable: [1, 1], ToInteger: [0, 0], ToDecimal: [0, 0], ToString: [0, 0],
  ToQuantity: [0, 0], ToBoolean: [0, 0], ToDateTime: [0, 0], ToTime: [0, 0],
  ConvertsToInteger: [0, 0], ConvertsToDecimal: [0, 0], ConvertsToString: [0, 0],
  ConvertsToQuantity: [0, 0], ConvertsToBoolean: [0, 0], ConvertsToDateTime: [0, 0],
  ConvertsToDate: [0, 0], ConvertsToTime: [0, 0], ConformsTo: [1, 1], Round: [0, 1],
  Sqrt: [0, 0], Abs: [0, 0], Ceiling: [0, 0], Exp: [0, 0], Floor: [0, 0], Ln: [0, 0],
  Log: [1, 1], Power: [1, 1], Truncate: [0, 0], Sort: [0, 10], Coalesce: [1, Infinity],
  LowBoundary: [0, 1], HighBoundary: [0, 1], Precision: [0, 0], hasTemplateIdOf: [1, 1],
  Debug: [0, 1], Section: { oneOf: [2, 4] }, Entry: { oneOf: [2, 4] },
  EntryIn: { oneOf: [1, 3] }, Resources: [2, 3], ResourcesIn: [1, 2], SameSubject: [0, 1],
  HasCoding: [2, 3], IsKnown: [0, 0], HasData: [0, 0]
};

// the operators, by the grammar's rule, and the precedence of each (as Java's
// organisePrecedence: lower binds tighter)
const LEVELS = new Map([
  [Parser.MultiplicativeExpressionContext, 0],
  [Parser.AdditiveExpressionContext, 1],
  [Parser.TypeExpressionContext, 2],
  [Parser.UnionExpressionContext, 3],
  [Parser.InequalityExpressionContext, 4],
  [Parser.EqualityExpressionContext, 5],
  [Parser.MembershipExpressionContext, 6],
  [Parser.AndExpressionContext, 7],
  [Parser.OrExpressionContext, 8],
  [Parser.ImpliesExpressionContext, 9]
]);

function levelOf(ctx) {
  for (const [type, level] of LEVELS) {
    if (ctx instanceof type) {
      return level;
    }
  }
  return -1;
}

// the calendar durations, and their UCUM codes (none for year and month: they're not UCUM's)
const CALENDAR_UNITS = {
  year: null, years: null, month: null, months: null, week: 'wk', weeks: 'wk', day: 'd',
  days: 'd', hour: 'h', hours: 'h', minute: 'min', minutes: 'min', second: 's', seconds: 's',
  millisecond: 'ms', milliseconds: 'ms'
};

class ErrorCollector extends antlr4.error.ErrorListener {
  constructor() {
    super();
    this.errors = [];
  }

  syntaxError(recognizer, symbol, line, column, msg) {
    this.errors.push({ line, column: column + 1, msg });
  }
}

/** Where a token starts */
function startOf(token) {
  return new SourceLocation(token.line, token.column + 1);
}

/** The character after a token (which can run over lines: a string) */
function endOf(token) {
  const text = token.text || '';
  const nl = text.lastIndexOf('\n');
  return nl === -1
    ? new SourceLocation(token.line, token.column + 1 + text.length)
    : new SourceLocation(token.line + (text.match(/\n/g) || []).length, text.length - nl);
}

class Converter {
  constructor(options) {
    this.options = options || {};
    this.nextId = 0;
  }

  node(kind, ctx) {
    const n = new ExpressionNode(this.nextId++);
    n.kind = kind;
    if (ctx) {
      n.start = startOf(ctx.start);
      n.end = endOf(ctx.stop || ctx.start);
    }
    return n;
  }

  error(message, token) {
    return token ? new FHIRPathParseError(message, token.line, token.column + 1) : new FHIRPathParseError(message);
  }

  /**
   * An expression: an operator chain, or a single operand (proximal: it's the start of an
   * expression, a group, or a parameter)
   */
  expression(ctx, proximal) {
    const level = levelOf(ctx);
    if (level === -1) {
      const n = this.operand(ctx);
      n.proximal = proximal;
      return n;
    }
    // the operands and operators of this level, left to right
    const items = [];
    this.flatten(ctx, level, items);
    let first = null;
    let last = null;
    for (let i = 0; i < items.length; i += 2) {
      const n = items[i];
      if (!first) {
        first = n;
      } else {
        const op = items[i - 1];
        last.operation = operationFromCode(op.text);
        last.opStart = startOf(op);
        last.opEnd = endOf(op);
        last.opNext = n;
      }
      last = n;
    }
    first.proximal = proximal;
    return first;
  }

  flatten(ctx, level, items) {
    const [left, op, right] = ctx.children;
    if (levelOf(left) === level) {
      this.flatten(left, level, items);
    } else {
      items.push(this.chainOperand(left));
    }
    items.push(op.symbol);
    if (ctx instanceof Parser.TypeExpressionContext) {
      items.push(this.typeSpecifier(right));
    } else if (levelOf(right) === level) {
      // not from the grammar (it's left associative), but as it would be
      this.flatten(right, level, items);
    } else {
      items.push(this.chainOperand(right));
    }
  }

  /** An operand in an operator chain: an expression of another level, or a unary, is a Group */
  chainOperand(ctx) {
    if (levelOf(ctx) !== -1 || ctx instanceof Parser.PolarityExpressionContext) {
      const g = this.node(Kind.Group, ctx);
      g.group = this.expression(ctx, true);
      g.group.proximal = true;
      return g;
    }
    return this.operand(ctx);
  }

  /** The type after is / as: a name, or a qualified name (FHIR.Patient: FHIR, inner Patient) */
  typeSpecifier(ctx) {
    const ids = ctx.qualifiedIdentifier().identifier();
    let first = null;
    let last = null;
    for (const id of ids) {
      const n = this.node(Kind.Name, id);
      n.name = this.identifier(id);
      if (last) {
        last.inner = n;
      } else {
        first = n;
      }
      last = n;
    }
    return first;
  }

  /** Not an operator chain: a term, a path, an indexer, or a unary */
  operand(ctx) {
    if (ctx instanceof Parser.TermExpressionContext) {
      return this.term(ctx.children[0]);
    }
    if (ctx instanceof Parser.InvocationExpressionContext) {
      const n = this.operand(ctx.children[0]);
      tail(n).inner = this.invocation(ctx.children[2]);
      return n;
    }
    if (ctx instanceof Parser.IndexerExpressionContext) {
      const n = this.operand(ctx.children[0]);
      const item = this.node(Kind.Function, null);
      item.setFunction(Function.Item);
      item.start = startOf(ctx.children[1].symbol);
      item.end = endOf(ctx.children[3].symbol);
      item.parameters.push(this.expression(ctx.children[2], true));
      tail(n).inner = item;
      return n;
    }
    if (ctx instanceof Parser.PolarityExpressionContext) {
      const sign = ctx.children[0].symbol;
      const n = this.node(Kind.Unary, ctx);
      n.operation = operationFromCode(sign.text);
      n.opNext = this.operand(ctx.children[1]);
      return n;
    }
    if (levelOf(ctx) !== -1) {
      // an operator chain, as the operand of a unary: "-(a + b)" is a group anyway, but
      // the grammar doesn't need one for "- a * b"
      return this.chainOperand(ctx);
    }
    throw this.error(`Unexpected ${ctx.constructor.name}`, ctx.start);
  }

  term(ctx) {
    if (ctx instanceof Parser.InvocationTermContext) {
      return this.invocation(ctx.children[0]);
    }
    if (ctx instanceof Parser.LiteralTermContext) {
      return this.literal(ctx.children[0]);
    }
    if (ctx instanceof Parser.ExternalConstantTermContext) {
      const c = ctx.children[0];
      const n = this.node(Kind.Constant, ctx);
      const name = c.identifier() ? this.identifier(c.identifier()) : this.string(c.STRING().symbol);
      n.constant = { type: 'constant', value: '%' + name };
      return n;
    }
    if (ctx instanceof Parser.ParenthesizedTermContext) {
      const n = this.node(Kind.Group, ctx);
      n.group = this.expression(ctx.children[1], true);
      return n;
    }
    if (ctx instanceof Parser.InstanceSelectorTermContext) {
      throw this.error('Instance selectors are not supported', ctx.start);
    }
    throw this.error(`Unexpected ${ctx.constructor.name}`, ctx.start);
  }

  invocation(ctx) {
    if (ctx instanceof Parser.MemberInvocationContext) {
      const n = this.node(Kind.Name, ctx);
      n.name = this.identifier(ctx.children[0]);
      return n;
    }
    if (ctx instanceof Parser.ThisInvocationContext || ctx instanceof Parser.IndexInvocationContext ||
      ctx instanceof Parser.TotalInvocationContext) {
      const n = this.node(Kind.Name, ctx);
      n.name = ctx.getText();
      return n;
    }
    if (ctx instanceof Parser.FunctionInvocationContext) {
      return this.functn(ctx.children[0]);
    }
    throw this.error(`Unexpected ${ctx.constructor.name}`, ctx.start);
  }

  functn(ctx) {
    const n = this.node(Kind.Function, ctx);
    const first = ctx.children[0];
    n.name = first.symbol ? (first.symbol.text === '`sort`' ? 'sort' : first.symbol.text) : this.identifier(first);
    let f = functionFromCode(n.name);
    let details = null;
    if (f == null) {
      details = this.options.resolveFunction ? this.options.resolveFunction(n.name) : null;
      if (details == null && !this.options.allowUnknownFunctions) {
        throw this.error(`The name ${n.name} is not a known function name`, ctx.start);
      }
      f = Function.Custom;
    }
    n.setFunction(f);
    for (const child of ctx.children) {
      if (child instanceof Parser.ParamListContext) {
        for (const e of child.expression()) {
          n.parameters.push(this.expression(e, true));
        }
      } else if (child instanceof Parser.SortArgumentContext) {
        const p = this.expression(child.children[0], true);
        if (child.children.length > 1) {
          p.direction = child.children[1].symbol.text;
        }
        n.parameters.push(p);
      }
    }
    this.checkParameters(n, ctx, details);
    return n;
  }

  checkParameters(n, ctx, details) {
    const count = n.parameters.length;
    const rule = n.function === Function.Custom
      ? (details ? [details.minParameters, details.maxParameters] : null)
      : PARAM_COUNTS[n.function];
    if (!rule) {
      return;
    }
    if (rule.oneOf) {
      const [a, b] = rule.oneOf;
      if (count !== a && count !== b) {
        throw this.error(`The function "${n.name}" requires ${a} or ${b} parameters`, ctx.start);
      }
    } else {
      const [min, max] = rule;
      if (min === max && count !== min) {
        throw this.error(`The function "${n.name}" requires ${min} parameters`, ctx.start);
      }
      if (count < min || count > max) {
        throw this.error(`The function "${n.name}" requires between ${min} and ${max === Infinity ? 'any number of' : max} parameters`, ctx.start);
      }
    }
  }

  literal(ctx) {
    const n = this.node(Kind.Constant, ctx);
    if (ctx instanceof Parser.NullLiteralContext) {
      n.constant = null;
    } else if (ctx instanceof Parser.BooleanLiteralContext) {
      n.constant = { type: 'boolean', value: ctx.getText() };
    } else if (ctx instanceof Parser.StringLiteralContext) {
      n.constant = { type: 'string', value: this.string(ctx.children[0].symbol) };
    } else if (ctx instanceof Parser.NumberLiteralContext) {
      const text = ctx.getText();
      n.constant = { type: text.includes('.') ? 'decimal' : 'integer', value: text };
    } else if (ctx instanceof Parser.LongNumberLiteralContext) {
      n.constant = { type: 'integer64', value: ctx.getText().slice(0, -1) };
    } else if (ctx instanceof Parser.DateLiteralContext || ctx instanceof Parser.DateTimeLiteralContext ||
      ctx instanceof Parser.TimeLiteralContext) {
      n.constant = { type: 'constant', value: ctx.getText() };
    } else if (ctx instanceof Parser.QuantityLiteralContext) {
      n.constant = this.quantity(ctx.children[0]);
    } else {
      throw this.error(`Unexpected ${ctx.constructor.name}`, ctx.start);
    }
    return n;
  }

  quantity(ctx) {
    const value = (ctx.INTEGER() || ctx.DECIMAL()).getText();
    const q = { type: 'Quantity', value, unit: null, system: null, code: null };
    const unit = ctx.unit();
    if (unit) {
      if (unit.STRING()) {
        q.code = this.string(unit.STRING().symbol);
        q.system = 'http://unitsofmeasure.org';
      } else {
        const word = unit.getText();
        const ucum = CALENDAR_UNITS[word];
        q.unit = word;
        q.calendar = true;
        if (ucum) {
          q.code = ucum;
          q.system = 'http://unitsofmeasure.org';
        }
      }
    }
    return q;
  }

  identifier(ctx) {
    const token = ctx.children[0].symbol;
    return token.type === Parser.DELIMITEDIDENTIFIER ? this.unescape(token.text, token) : token.text;
  }

  string(token) {
    return this.unescape(token.text, token);
  }

  /** The text of a string or delimited name: without its delimiters, and its escapes done (as Java) */
  unescape(s, token) {
    let b = '';
    let i = 1;
    while (i < s.length - 1) {
      const ch = s[i];
      if (ch === '\\') {
        i++;
        const e = s[i];
        switch (e) {
          case 't': b += '\t'; break;
          case 'r': b += '\r'; break;
          case 'n': b += '\n'; break;
          case 'f': b += '\f'; break;
          case '\'': b += '\''; break;
          case '"': b += '"'; break;
          case '`': b += '`'; break;
          case '\\': b += '\\'; break;
          case '/': b += '/'; break;
          case 'u': {
            const hex = s.substring(i + 1, Math.min(i + 5, s.length - 1));
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw this.error(`Invalid FHIRPath unicode escape \\u${hex}`, token);
            }
            b += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default:
            throw this.error(`Unknown FHIRPath character escape \\${e}`, token);
        }
        i++;
      } else {
        b += ch;
        i++;
      }
    }
    return b;
  }
}

/** The last node of a path (through inner) */
function tail(n) {
  while (n.inner) {
    n = n.inner;
  }
  return n;
}

/**
 * Parse a FHIRPath expression, without evaluating it.
 * @param {string} expression
 * @param {Object} [options]
 * @param {function(string): ({minParameters: number, maxParameters: number}|null)} [options.resolveFunction]
 *   - the functions the host knows about, beyond FHIRPath's (Custom), as Java's
 *   hostServices.resolveFunction
 * @param {boolean} [options.allowUnknownFunctions] - functions no one knows are Custom, not an error
 * @returns {ExpressionNode}
 * @throws {FHIRPathParseError}
 */
function parse(expression, options) {
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new FHIRPathParseError('Path cannot be empty');
  }
  const errors = new ErrorCollector();
  const lexer = new Lexer(new antlr4.InputStream(expression));
  lexer.removeErrorListeners();
  lexer.addErrorListener(errors);
  const parser = new Parser(new antlr4.CommonTokenStream(lexer));
  parser.buildParseTrees = true;
  parser.removeErrorListeners();
  parser.addErrorListener(errors);
  const tree = parser.entireExpression();
  if (errors.errors.length) {
    const e = errors.errors[0];
    throw new FHIRPathParseError(e.msg, e.line, e.column);
  }
  return new Converter(options).expression(tree.children[0], true);
}

module.exports = { parse, FHIRPathParseError };
