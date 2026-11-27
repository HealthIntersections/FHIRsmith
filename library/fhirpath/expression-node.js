//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * A parsed FHIRPath expression: a port of the Java ExpressionNode
 * (org.hl7.fhir.r5.fhirpath.ExpressionNode), so that the type checking in the Java
 * FHIRPathEngine can be ported over the same tree. The tree is made from fhirpath.js's parser
 * by library/fhirpath/parser.js; fhirpath.js itself still does the evaluation.
 *
 * The shape is the Java one:
 *
 *  - a node is a Name, a Function (with parameters), a Constant, a Group (with group: a
 *    parenthesised expression), or a Unary (+/-: operation, with opNext the operand)
 *  - a path is a chain through inner: "a.b.c" is a, inner b, inner c. An indexer is a
 *    Function Item in the chain: "a[0].b" is a, inner [0], inner b
 *  - operators chain through operation and opNext on the first node of each operand:
 *    "a.b = c" is a (inner b), operation Equals, opNext c. The operators of one precedence
 *    level are one chain, left to right; an operand that is itself an expression of a higher
 *    precedence (or a unary) is a Group: "a + b * c" is a, Plus, Group(b, Times, c). Those
 *    groups were not in the text, as in Java (where organisePrecedence makes them)
 *
 * The constants, as Java's Base types: { type: 'string' | 'integer' | 'integer64' | 'decimal' |
 * 'boolean', value: (text) }, { type: 'Quantity', value, unit, system, code, calendar } (as
 * Java: '3 days' is unit 'days', code 'd', and calendar marks it as written that way), and
 * { type: 'constant', value } (Java's FHIRConstant) for the %names ('%resource') and the
 * date / time literals ('@2020-01-01', '@T10:00'), which are worked out when they are used.
 * The empty collection ({}) is a Constant node with constant null.
 *
 * @module library/fhirpath/expression-node
 */

/** What a node is */
const Kind = Object.freeze({
  Name: 'Name',
  Function: 'Function',
  Constant: 'Constant',
  Group: 'Group',
  Unary: 'Unary'
});

// the functions, by Java's enum name: their code in an expression. Custom (a function the
// host knows about) has no code - its name is the node's name
const FUNCTION_CODES = {
  Empty: 'empty', Not: 'not', Exists: 'exists', SubsetOf: 'subsetOf', SupersetOf: 'supersetOf',
  IsDistinct: 'isDistinct', Distinct: 'distinct', Count: 'count', Where: 'where', Select: 'select',
  All: 'all', Repeat: 'repeat', Aggregate: 'aggregate', Item: 'item', As: 'as', Is: 'is',
  Single: 'single', First: 'first', Last: 'last', Tail: 'tail', Skip: 'skip', Take: 'take',
  Union: 'union', Combine: 'combine', Intersect: 'intersect', Exclude: 'exclude', Iif: 'iif',
  Upper: 'upper', Lower: 'lower', ToChars: 'toChars', IndexOf: 'indexOf', Substring: 'substring',
  StartsWith: 'startsWith', EndsWith: 'endsWith', Matches: 'matches', MatchesFull: 'matchesFull',
  ReplaceMatches: 'replaceMatches', Contains: 'contains', Replace: 'replace', Length: 'length',
  Children: 'children', Descendants: 'descendants', MemberOf: 'memberOf', Trace: 'trace',
  DefineVariable: 'defineVariable', Check: 'check', Today: 'today', Now: 'now', Resolve: 'resolve',
  Extension: 'extension', AllFalse: 'allFalse', AnyFalse: 'anyFalse', AllTrue: 'allTrue',
  AnyTrue: 'anyTrue', HasValue: 'hasValue', OfType: 'ofType', Type: 'type',
  ConvertsToBoolean: 'convertsToBoolean', ConvertsToInteger: 'convertsToInteger',
  ConvertsToString: 'convertsToString', ConvertsToDecimal: 'convertsToDecimal',
  ConvertsToQuantity: 'convertsToQuantity', ConvertsToDateTime: 'convertsToDateTime',
  ConvertsToDate: 'convertsToDate', ConvertsToTime: 'convertsToTime', ToBoolean: 'toBoolean',
  ToInteger: 'toInteger', ToString: 'toString', ToDecimal: 'toDecimal', ToQuantity: 'toQuantity',
  ToDateTime: 'toDateTime', ToTime: 'toTime', ConformsTo: 'conformsTo',
  Round: 'round', Sqrt: 'sqrt', Abs: 'abs', Ceiling: 'ceiling', Exp: 'exp', Floor: 'floor',
  Ln: 'ln', Log: 'log', Power: 'power', Truncate: 'truncate',
  // R3 functions
  Encode: 'encode', Decode: 'decode', Escape: 'escape', Unescape: 'unescape', Trim: 'trim',
  Split: 'split', Join: 'join', LowBoundary: 'lowBoundary', HighBoundary: 'highBoundary',
  Precision: 'precision', Sort: 'sort', Coalesce: 'coalesce',
  // local extensions to FHIRPath
  HtmlChecks1: 'htmlChecks', HtmlChecks2: 'htmlChecks2', Comparable: 'comparable',
  hasTemplateIdOf: 'hasTemplateIdOf', Debug: 'debug',
  // document functions (Java's DocumentFunctions) - local extensions too
  Section: 'section', Entry: 'entry', EntryIn: 'entryIn', Resources: 'resources',
  ResourcesIn: 'resourcesIn', SameSubject: 'sameSubject', HasCoding: 'hasCoding',
  IsKnown: 'isKnown', HasData: 'hasData'
};

/** The functions: Function.Where === 'Where', and so on (and Custom) */
const Function = Object.freeze(Object.fromEntries(['Custom', ...Object.keys(FUNCTION_CODES)].map(f => [f, f])));

const FUNCTION_BY_CODE = new Map(Object.entries(FUNCTION_CODES).map(([f, code]) => [code, f]));
FUNCTION_BY_CODE.set('htmlchecks', Function.HtmlChecks1); // the R3 spelling

/**
 * The function for a name in an expression, or null if it's not one of FHIRPath's (or of the
 * local extensions)
 * @param {string} name
 * @returns {string|null}
 */
function functionFromCode(name) {
  return FUNCTION_BY_CODE.get(name) || null;
}

/**
 * The name of a function in an expression ('?custom?' for Custom, which has none of its own).
 * (Java's toCode gives 'isTime' for ConvertsToTime; this doesn't follow that.)
 * @param {string} f
 * @returns {string}
 */
function functionToCode(f) {
  return FUNCTION_CODES[f] || '?custom?';
}

const OPERATION_CODES = {
  Equals: '=', Equivalent: '~', NotEquals: '!=', NotEquivalent: '!~', LessThan: '<',
  Greater: '>', LessOrEqual: '<=', GreaterOrEqual: '>=', Is: 'is', As: 'as', Union: '|',
  Or: 'or', And: 'and', Xor: 'xor', Implies: 'implies', Times: '*', DivideBy: '/', Plus: '+',
  Minus: '-', Concatenate: '&', Div: 'div', Mod: 'mod', In: 'in', Contains: 'contains',
  MemberOf: 'memberOf'
};

/** The operations: Operation.Equals === 'Equals', and so on */
const Operation = Object.freeze(Object.fromEntries(Object.keys(OPERATION_CODES).map(o => [o, o])));

const OPERATION_BY_CODE = new Map(Object.entries(OPERATION_CODES).map(([o, code]) => [code, o]));

/**
 * The operation for an operator, or null
 * @param {string} code
 * @returns {string|null}
 */
function operationFromCode(code) {
  return code ? OPERATION_BY_CODE.get(code) || null : null;
}

/**
 * The operator for an operation
 * @param {string} op
 * @returns {string}
 */
function operationToCode(op) {
  return OPERATION_CODES[op] || '?custom?';
}

/** As Java's ExpressionNode.CollectionStatus */
const CollectionStatus = Object.freeze({
  SINGLETON: 'SINGLETON',
  ORDERED: 'ORDERED',
  UNORDERED: 'UNORDERED'
});

/**
 * As Java's Utilities.escapeFhirPathString. With backtick, a backtick is escaped too, for a name
 * written in backticks (escaped here with the rest, so that a backslash before it is escaped first)
 */
function escapeFhirPathString(s, backtick = false) {
  if (s == null) {
    return '';
  }
  let b = '';
  for (const c of String(s)) {
    switch (c) {
      case '\\': b += '\\\\'; break;
      case '\'': b += '\\\''; break;
      case '`': b += backtick ? '\\`' : '`'; break;
      case '\r': b += '\\r'; break;
      case '\n': b += '\\n'; break;
      case '\t': b += '\\t'; break;
      case ' ': b += ' '; break;
      default: {
        const code = c.codePointAt(0);
        if (code < 32 || /\s/u.test(c)) {
          b += '\\u' + code.toString(16).padStart(4, '0');
        } else {
          b += c;
        }
      }
    }
  }
  return b;
}

const PLAIN_NAME = /^(\$this|\$index|\$total|[A-Za-z_][A-Za-z0-9_]*)$/;

/** A name as it is written: in backticks if it isn't a plain identifier */
function writeName(name) {
  return PLAIN_NAME.test(name) ? name : '`' + escapeFhirPathString(name, true) + '`';
}

/** A source location: line and column, both from 1 */
class SourceLocation {
  constructor(line, column) {
    this.line = line;
    this.column = column;
  }

  copy() {
    return new SourceLocation(this.line, this.column);
  }

  toString() {
    return `${this.line}, ${this.column}`;
  }
}

class ExpressionNode {
  /**
   * @param {number|string} uniqueId - unique in its expression
   */
  constructor(uniqueId) {
    this.uniqueId = String(uniqueId);
    /** @type {string} one of Kind */
    this.kind = null;
    /** @type {string|null} Name and Function */
    this.name = null;
    /** @type {Object|null} Constant (null: the empty collection) */
    this.constant = null;
    /** @type {string|null} one of Function */
    this.function = null;
    /** @type {ExpressionNode[]|null} made when the function is set */
    this.parameters = null;
    /** @type {ExpressionNode|null} */
    this.inner = null;
    /** @type {ExpressionNode|null} */
    this.group = null;
    /** @type {string|null} one of Operation */
    this.operation = null;
    /**
     * A proximal node is the first of a sequence of operations (the start of an expression,
     * of a group, or of a parameter). This is significant when evaluating the outcomes
     */
    this.proximal = false;
    /** @type {ExpressionNode|null} */
    this.opNext = null;
    /** @type {SourceLocation|null} the first character of the node */
    this.start = null;
    /** @type {SourceLocation|null} the character after the node's own text */
    this.end = null;
    /** @type {SourceLocation|null} the operator */
    this.opStart = null;
    /** @type {SourceLocation|null} */
    this.opEnd = null;
    /** set by type checking */
    this.types = null;
    this.opTypes = null;
  }

  /** Make this a function, with (so far) no parameters */
  setFunction(f) {
    this.function = f;
    if (this.parameters == null) {
      this.parameters = [];
    }
  }

  parameterCount() {
    return this.parameters == null ? 0 : this.parameters.length;
  }

  /** Whether the name is a valid one: $names only $this, $total and $index */
  checkName() {
    return !this.name.startsWith('$') || ['$this', '$total', '$index'].includes(this.name);
  }

  /** The node as FHIRPath (the groups that the precedence made are written, in parentheses) */
  toString() {
    let b = '';
    switch (this.kind) {
      case Kind.Name:
        b += writeName(this.name);
        break;
      case Kind.Function:
        b += this.function === Function.Item ? '[' : writeName(this.name) + '(';
        b += this.parameters.map(p => p.toString() + (p.direction ? ' ' + p.direction : '')).join(', ');
        b += this.function === Function.Item ? ']' : ')';
        break;
      case Kind.Constant:
        b += constantToString(this.constant);
        break;
      case Kind.Group:
        b += '(' + this.group.toString() + ')';
        break;
      case Kind.Unary:
        // the operand is opNext; a unary has no operation of its own after it
        return operationToCode(this.operation) + this.opNext.toString();
    }
    if (this.inner) {
      if (!(this.inner.kind === Kind.Function && this.inner.function === Function.Item)) {
        b += '.';
      }
      b += this.inner.toString();
    }
    if (this.operation != null) {
      b += ' ' + operationToCode(this.operation) + ' ' + this.opNext.toString();
    }
    return b;
  }

  /** As Java's summary(): for logs */
  summary() {
    switch (this.kind) {
      case Kind.Name: return this.uniqueId + ': ' + this.name;
      case Kind.Function: return this.uniqueId + ': ' + this.function + '()';
      case Kind.Constant: return this.uniqueId + ': ' + constantToString(this.constant);
      case Kind.Group: return this.uniqueId + ': (Group)';
      case Kind.Unary: return this.uniqueId + ': (Unary ' + operationToCode(this.operation) + ')';
    }
    return '?exp-kind?';
  }

  /**
   * A problem with the tree, or null (as Java's check(): the parser makes good trees, so this
   * is for trees made some other way)
   * @returns {string|null}
   */
  check() {
    if (this.kind == null) {
      return 'Error in expression - node has no kind';
    }
    switch (this.kind) {
      case Kind.Name:
        if (!this.name) {
          return 'No Name provided @ ' + this.location();
        }
        break;
      case Kind.Function:
        if (this.function == null) {
          return 'No Function id provided @ ' + this.location();
        }
        for (const n of this.parameters) {
          const msg = n.check();
          if (msg != null) {
            return msg;
          }
        }
        break;
      case Kind.Unary:
        if (this.operation == null || this.opNext == null) {
          return 'No operand provided @ ' + this.location();
        }
        return this.opNext.check();
      case Kind.Constant:
        // null is the empty collection
        break;
      case Kind.Group:
        if (this.group == null) {
          return 'No Group provided @ ' + this.location();
        } else {
          const msg = this.group.check();
          if (msg != null) {
            return msg;
          }
        }
        break;
    }
    if (this.inner) {
      const msg = this.inner.check();
      if (msg != null) {
        return msg;
      }
    }
    if (this.operation == null) {
      if (this.opNext != null) {
        return 'Next provided when it shouldn\'t be @ ' + this.location();
      }
    } else if (this.opNext == null) {
      return 'No Next provided @ ' + this.location();
    } else {
      return this.opNext.check();
    }
    return null;
  }

  location() {
    return this.start ? this.start.toString() : '?';
  }

  /**
   * The names at the end of the path (null for anything but a name), as Java's getDistalNames
   * @returns {Array<string|null>}
   */
  getDistalNames() {
    if (this.operation != null) {
      return [null];
    } else if (this.inner) {
      return this.inner.getDistalNames();
    } else if (this.group) {
      return this.group.getDistalNames();
    } else if (this.function != null) {
      return [null];
    } else if (this.constant != null) {
      return [null];
    }
    return [this.name];
  }

  /** Whether this is {} */
  isNullSet() {
    return this.kind === Kind.Constant && this.constant == null;
  }

  isSimpleName(name) {
    return this.kind === Kind.Name && name === this.name;
  }

  hasInnerFunction(name) {
    return this.getInnerFunction(name) != null;
  }

  getInnerFunction(name) {
    if (this.inner && this.inner.kind === Kind.Function && name === this.inner.name) {
      return this.inner;
    }
    return null;
  }

  /** Every node in the tree, depth first (this, its parameters / group, inner, opNext) */
  * nodes() {
    yield this;
    if (this.parameters) {
      for (const p of this.parameters) {
        yield* p.nodes();
      }
    }
    if (this.group) {
      yield* this.group.nodes();
    }
    if (this.inner) {
      yield* this.inner.nodes();
    }
    if (this.opNext) {
      yield* this.opNext.nodes();
    }
  }
}

/** A constant, as FHIRPath */
function constantToString(c) {
  if (c == null) {
    return '{}';
  }
  switch (c.type) {
    case 'string':
      return '\'' + escapeFhirPathString(c.value) + '\'';
    case 'integer64':
      return c.value + 'L';
    case 'Quantity': {
      let s = c.value != null ? c.value : '';
      if (c.calendar) {
        // a calendar duration (year, days, ...), as it was written
        s += ' ' + c.unit;
      } else if (c.unit != null || c.code != null) {
        s += ' \'' + escapeFhirPathString(c.unit != null ? c.unit : c.code) + '\'';
      }
      return s;
    }
    case 'constant':
      return c.value.startsWith('%') ? '%' + writeName(c.value.substring(1)) : c.value;
    default:
      return String(c.value);
  }
}

module.exports = {
  ExpressionNode,
  SourceLocation,
  Kind,
  Function,
  Operation,
  CollectionStatus,
  functionFromCode,
  functionToCode,
  operationFromCode,
  operationToCode,
  escapeFhirPathString,
  constantToString
};
