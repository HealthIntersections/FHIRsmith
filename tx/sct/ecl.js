/**
 * SNOMED CT Expression Constraint Language (ECL) Validator
 *
 * This implementation provides parsing, validation, and evaluation of ECL expressions
 * against SNOMED CT data using the existing SnomedServices infrastructure.
 *
 * Supports the ECL v2.2 grammar from SNOMED International (the parser); which
 * constructs are evaluated is documented on SnomedServices.filterECL in
 * cs-snomed.js. The ECLValidator evaluate* methods in this file are a legacy
 * evaluator that the server does not use.
 */

// ECL Token Types
const ECLTokenType = {
  // Literals
  SCTID: 'SCTID',
  TERM: 'TERM',
  STRING: 'STRING',
  INTEGER: 'INTEGER',
  DECIMAL: 'DECIMAL',

  // Operators (ECL 2.x spec)
  CHILD_OF: 'CHILD_OF',                    // <!   direct children only
  CHILD_OR_SELF_OF: 'CHILD_OR_SELF_OF',   // <<!  self + direct children
  DESCENDANT_OF: 'DESCENDANT_OF',         // <    all transitive descendants, no self
  DESCENDANT_OR_SELF_OF: 'DESCENDANT_OR_SELF_OF', // <<   self + all transitive descendants
  PARENT_OF: 'PARENT_OF',                 // >!   direct parents only
  PARENT_OR_SELF_OF: 'PARENT_OR_SELF_OF', // >>!  self + direct parents
  ANCESTOR_OF: 'ANCESTOR_OF',             // >    all transitive ancestors, no self
  ANCESTOR_OR_SELF_OF: 'ANCESTOR_OR_SELF_OF', // >>   self + all transitive ancestors
  TOP_OF_SET: 'TOP_OF_SET',               // !!>  members of the set with no ancestor in the set
  BOTTOM_OF_SET: 'BOTTOM_OF_SET',         // !!<  members of the set with no descendant in the set

  // Set operators
  AND: 'AND',
  OR: 'OR',
  MINUS: 'MINUS',

  // Refinement
  COLON: 'COLON',                         // :
  EQUALS: 'EQUALS',                       // =
  NOT_EQUALS: 'NOT_EQUALS',               // !=

  // Comparison operators
  LT: 'LT',                               // <
  LTE: 'LTE',                             // <=
  GT: 'GT',                               // >
  GTE: 'GTE',                             // >=

  // Special
  MEMBER_OF: 'MEMBER_OF',                 // ^
  WILDCARD: 'WILDCARD',                   // *
  DOT: 'DOT',                             // .
  CARDINALITY_RANGE: 'CARDINALITY_RANGE', // ..
  REVERSE: 'REVERSE',                     // R

  // Brackets
  LPAREN: 'LPAREN',                       // (
  RPAREN: 'RPAREN',                       // )
  LBRACE: 'LBRACE',                       // {
  RBRACE: 'RBRACE',                       // }
  LFILTER: 'LFILTER',                     // {{  (filter constraint open)
  RFILTER: 'RFILTER',                     // }}  (filter constraint close)
  LBRACKET: 'LBRACKET',                   // [
  RBRACKET: 'RBRACKET',                   // ]

  // Separators
  COMMA: 'COMMA',                         // ,
  PIPE: 'PIPE',                           // |
  HASH: 'HASH',                           // #
  PLUS: 'PLUS',                           // +  (history supplement)

  // Special tokens
  WS: 'WS',
  EOF: 'EOF',
  ERROR: 'ERROR'
};

// ECL Expression Node Types
const ECLNodeType = {
  SIMPLE_EXPRESSION_CONSTRAINT: 'SimpleExpressionConstraint',
  REFINED_EXPRESSION_CONSTRAINT: 'RefinedExpressionConstraint',
  COMPOUND_EXPRESSION_CONSTRAINT: 'CompoundExpressionConstraint',
  DOTTED_EXPRESSION_CONSTRAINT: 'DottedExpressionConstraint',

  CONCEPT_REFERENCE: 'ConceptReference',
  WILDCARD: 'Wildcard',
  MEMBER_OF: 'MemberOf',
  MEMBER_FILTER: 'MemberFilter',          // one {{ M ... }} term
  CONCEPT_FILTER: 'ConceptFilter',        // one {{ C ... }} term
  DESCRIPTION_FILTER: 'DescriptionFilter', // one {{ D ... }} term
  FILTER_CONSTRAINT: 'FilterConstraint',  // a {{ D ... }} / {{ C ... }} / {{ + ... }} block (parsed, not evaluated)

  REFINEMENT: 'Refinement',
  ATTRIBUTE_SET: 'AttributeSet',
  ATTRIBUTE_GROUP: 'AttributeGroup',
  ATTRIBUTE: 'Attribute',

  SUB_EXPRESSION_CONSTRAINT: 'SubExpressionConstraint',
  EXPRESSION_COMPARISON: 'ExpressionComparison',
  NUMERIC_COMPARISON: 'NumericComparison',
  STRING_COMPARISON: 'StringComparison',
  BOOLEAN_COMPARISON: 'BooleanComparison',
  ALT_IDENTIFIER: 'AltIdentifier',        // scheme#code (ECL 2.1 alternate identifier)

  CONJUNCTION: 'Conjunction',
  DISJUNCTION: 'Disjunction',
  EXCLUSION: 'Exclusion',

  CARDINALITY: 'Cardinality'
};

/**
 * ECL Lexer - Tokenizes ECL expressions
 */
class ECLLexer {
  constructor(input) {
    this.input = input;
    this.position = 0;
    this.current = this.input[0] || null;
  }

  error(message) {
    throw new Error(`Lexer error at position ${this.position}: ${message}`);
  }

  advance() {
    this.position++;
    this.current = this.position < this.input.length ? this.input[this.position] : null;
  }

  peek(offset = 1) {
    const pos = this.position + offset;
    return pos < this.input.length ? this.input[pos] : null;
  }

  skipWhitespace() {
    while (this.current && /\s/.test(this.current)) {
      this.advance();
    }
  }

  readSCTID() {
    let value = '';
    while (this.current && /\d/.test(this.current)) {
      value += this.current;
      this.advance();
    }
    return value;
  }

  readTerm() {
    let value = '';
    // We should be positioned at the opening |
    if (this.current !== '|') {
      this.error('Expected | at start of term');
    }
    this.advance(); // Skip opening |

    while (this.current && this.current !== '|') {
      value += this.current;
      this.advance();
    }

    if (this.current !== '|') {
      this.error('Unterminated term - missing closing |');
    }

    this.advance(); // Skip closing |
    return value.trim();
  }

  readString() {
    let value = '';
    const quote = this.current;
    this.advance(); // Skip opening quote

    while (this.current && this.current !== quote) {
      if (this.current === '\\') {
        this.advance();
        if (this.current) {
          value += this.current;
          this.advance();
        }
      } else {
        value += this.current;
        this.advance();
      }
    }

    if (this.current !== quote) {
      this.error('Unterminated string');
    }

    this.advance(); // Skip closing quote
    return value;
  }

  readNumber() {
    let value = '';
    let hasDecimal = false;

    // Handle negative numbers
    if (this.current === '-') {
      value += this.current;
      this.advance();
    }

    while (this.current && (/\d/.test(this.current) || (this.current === '.' && !hasDecimal))) {
      if (this.current === '.') {
        hasDecimal = true;
      }
      value += this.current;
      this.advance();
    }

    return {
      value,
      type: hasDecimal ? ECLTokenType.DECIMAL : ECLTokenType.INTEGER
    };
  }

  getNextToken() {
    while (this.current) {
      if (/\s/.test(this.current)) {
        this.skipWhitespace();
        continue;
      }

      // ECL comments: /* ... */ are whitespace
      if (this.current === '/' && this.peek() === '*') {
        const start = this.position;
        this.advance();
        this.advance();
        while (this.current && !(this.current === '*' && this.peek() === '/')) {
          this.advance();
        }
        if (!this.current) {
          this.position = start;
          this.error('Unterminated comment - missing */');
        }
        this.advance();
        this.advance();
        continue;
      }

      // Single character tokens
      switch (this.current) {
        case '(':
          this.advance();
          return { type: ECLTokenType.LPAREN, value: '(' };
        case ')':
          this.advance();
          return { type: ECLTokenType.RPAREN, value: ')' };
        case '{':
          // "{{" opens an ECL 2.x filter constraint; attribute groups never nest,
          // so a doubled brace is unambiguous.
          if (this.peek() === '{') {
            this.advance();
            this.advance();
            return { type: ECLTokenType.LFILTER, value: '{{' };
          }
          this.advance();
          return { type: ECLTokenType.LBRACE, value: '{' };
        case '}':
          if (this.peek() === '}') {
            this.advance();
            this.advance();
            return { type: ECLTokenType.RFILTER, value: '}}' };
          }
          this.advance();
          return { type: ECLTokenType.RBRACE, value: '}' };
        case '[':
          this.advance();
          return { type: ECLTokenType.LBRACKET, value: '[' };
        case ']':
          this.advance();
          return { type: ECLTokenType.RBRACKET, value: ']' };
        case ',':
          this.advance();
          return { type: ECLTokenType.COMMA, value: ',' };
        case '.':
          // Check for cardinality range operator (..)
          if (this.peek() === '.') {
            this.advance();
            this.advance();
            return { type: ECLTokenType.CARDINALITY_RANGE, value: '..' };
          } else {
            this.advance();
            return { type: ECLTokenType.DOT, value: '.' };
          }
        case ':':
          this.advance();
          return { type: ECLTokenType.COLON, value: ':' };
        case '^':
          this.advance();
          return { type: ECLTokenType.MEMBER_OF, value: '^' };
        case '*':
          this.advance();
          return { type: ECLTokenType.WILDCARD, value: '*' };
        case '#':
          this.advance();
          return { type: ECLTokenType.HASH, value: '#' };
        case '|': {
          // This is a term - read the entire |term| construct
          const termValue = this.readTerm();
          return {type: ECLTokenType.TERM, value: termValue};
        }
      }

      // Multi-character operators
      // ECL 2.x hierarchy operators:
      //   <    descendantOf         (transitive, no self)
      //   <<   descendantOrSelfOf   (transitive, with self)
      //   <!   childOf              (one step)
      //   <<!  childOrSelfOf        (one step + self)
      //   >    ancestorOf           (transitive, no self)
      //   >>   ancestorOrSelfOf     (transitive, with self)
      //   >!   parentOf             (one step)
      //   >>!  parentOrSelfOf       (one step + self)
      if (this.current === '<') {
        if (this.peek() === '<') {
          if (this.peek(2) === '!') {
            this.advance();
            this.advance();
            this.advance();
            return { type: ECLTokenType.CHILD_OR_SELF_OF, value: '<<!' };
          } else {
            this.advance();
            this.advance();
            return { type: ECLTokenType.DESCENDANT_OR_SELF_OF, value: '<<' };
          }
        } else if (this.peek() === '!') {
          this.advance();
          this.advance();
          return { type: ECLTokenType.CHILD_OF, value: '<!' };
        } else if (this.peek() === '=') {
          this.advance();
          this.advance();
          return { type: ECLTokenType.LTE, value: '<=' };
        } else {
          this.advance();
          return { type: ECLTokenType.DESCENDANT_OF, value: '<' };
        }
      }

      if (this.current === '>') {
        if (this.peek() === '>') {
          if (this.peek(2) === '!') {
            this.advance();
            this.advance();
            this.advance();
            return { type: ECLTokenType.PARENT_OR_SELF_OF, value: '>>!' };
          } else {
            this.advance();
            this.advance();
            return { type: ECLTokenType.ANCESTOR_OR_SELF_OF, value: '>>' };
          }
        } else if (this.peek() === '!') {
          this.advance();
          this.advance();
          return { type: ECLTokenType.PARENT_OF, value: '>!' };
        } else if (this.peek() === '=') {
          this.advance();
          this.advance();
          return { type: ECLTokenType.GTE, value: '>=' };
        } else {
          this.advance();
          return { type: ECLTokenType.ANCESTOR_OF, value: '>' };
        }
      }

      if (this.current === '=') {
        this.advance();
        return { type: ECLTokenType.EQUALS, value: '=' };
      }

      if (this.current === '+') {
        this.advance();
        return { type: ECLTokenType.PLUS, value: '+' };
      }

      if (this.current === '!') {
        if (this.peek() === '!' && this.peek(2) === '>') {
          this.advance();
          this.advance();
          this.advance();
          return { type: ECLTokenType.TOP_OF_SET, value: '!!>' };
        }
        if (this.peek() === '!' && this.peek(2) === '<') {
          this.advance();
          this.advance();
          this.advance();
          return { type: ECLTokenType.BOTTOM_OF_SET, value: '!!<' };
        }
        if (this.peek() === '=') {
          this.advance();
          this.advance();
          return { type: ECLTokenType.NOT_EQUALS, value: '!=' };
        } else {
          this.error(`Unexpected character: ${this.current}`);
        }
      }

      // String literals
      if (this.current === '"' || this.current === "'") {
        return { type: ECLTokenType.STRING, value: this.readString() };
      }

      // Handle numbers - check for decimal first, then SCTID
      if (/\d/.test(this.current)) {
        // Look ahead to see if this is a decimal number (digit.digit with no space)
        let pos = this.position;
        while (pos < this.input.length && /\d/.test(this.input[pos])) {
          pos++;
        }

        // Check if immediately followed by .digit (decimal number)
        if (pos < this.input.length &&
            this.input[pos] === '.' &&
            pos + 1 < this.input.length &&
            /\d/.test(this.input[pos + 1])) {
          // This is a decimal number - parse it completely
          const num = this.readNumber();
          return { type: num.type, value: num.value };
        } else {
          // This is a SCTID (concept ID)
          const value = this.readSCTID();
          return { type: ECLTokenType.SCTID, value };
        }
      }

      // Handle negative numbers separately
      if (this.current === '-' && /\d/.test(this.peek())) {
        const num = this.readNumber();
        return { type: num.type, value: num.value };
      }

      // Keywords and identifiers
      if (/[a-zA-Z_]/.test(this.current)) {
        let value = '';
        while (this.current && (/[a-zA-Z0-9_]/.test(this.current) || (this.current === '-' && /[a-zA-Z]/.test(this.peek() || '')))) {
          value += this.current;
          this.advance();
        }

        // Check for keywords
        switch (value.toUpperCase()) {
          case 'AND':
            return { type: ECLTokenType.AND, value: value };
          case 'OR':
            return { type: ECLTokenType.OR, value: value };
          case 'MINUS':
            return { type: ECLTokenType.MINUS, value: value };
          case 'R':
            return { type: ECLTokenType.REVERSE, value: value };
          default:
            // Could be a namespace identifier or other construct
            return { type: ECLTokenType.SCTID, value: value };
        }
      }

      this.error(`Unexpected character: ${this.current}`);
    }

    return { type: ECLTokenType.EOF, value: null };
  }

  tokenize() {
    const tokens = [];
    let token;

    do {
      token = this.getNextToken();
      tokens.push(token);
    } while (token.type !== ECLTokenType.EOF);

    return tokens;
  }
}

/**
 * ECL Parser - Parses tokens into AST
 */
class ECLParser {
  constructor(tokens) {
    this.tokens = tokens;
    this.position = 0;
    this.current = this.tokens[0] || { type: ECLTokenType.EOF };
  }

  error(message) {
    throw new Error(`Parser error at token ${this.position}: ${message}. Current token: ${this.current.type}(${this.current.value})`);
  }

  advance() {
    this.position++;
    this.current = this.position < this.tokens.length ? this.tokens[this.position] : { type: ECLTokenType.EOF };
  }

  peek(offset = 1) {
    const pos = this.position + offset;
    return pos < this.tokens.length ? this.tokens[pos] : { type: ECLTokenType.EOF };
  }

  expect(tokenType) {
    if (this.current.type !== tokenType) {
      this.error(`Expected ${tokenType}, got ${this.current.type}`);
    }
    const token = this.current;
    this.advance();
    return token;
  }

  match(...tokenTypes) {
    return tokenTypes.includes(this.current.type);
  }

  // Main parsing entry point
  parse() {
    const result = this.parseExpressionConstraint();
    if (this.current.type !== ECLTokenType.EOF) {
      this.error('Unexpected tokens after end of expression');
    }
    return result;
  }

  parseExpressionConstraint() {
    return this.parseCompoundExpressionConstraint();
  }

  parseCompoundExpressionConstraint() {
    let left = this.parseRefinedExpressionConstraint();

    // ECL 6.4: conjunction (AND), disjunction (OR) and exclusion (MINUS)
    // operators must not be mixed within a single ungrouped compound expression;
    // round brackets are mandatory to disambiguate. Track the operator used in
    // this compound sequence and reject a mix (e.g. "<< A OR << B AND << C").
    let compoundOp = null;

    // "," is a conjunction in the ECL grammar (conjunction = "AND" / ","), at
    // this level as well as in refinements; a comma that reaches here was not
    // claimed by a refinement.
    while (this.match(ECLTokenType.AND, ECLTokenType.OR, ECLTokenType.MINUS, ECLTokenType.COMMA)) {
      const operator = this.match(ECLTokenType.COMMA) ? { ...this.current, type: ECLTokenType.AND } : this.current;
      if (compoundOp !== null && operator.type !== compoundOp) {
        throw new Error(
          'Ambiguous ECL expression: conjunction, disjunction and exclusion ' +
          'operators cannot be mixed without parentheses (ECL 6.4). ' +
          'Use round brackets to disambiguate.');
      }
      compoundOp = operator.type;
      this.advance();
      const right = this.parseRefinedExpressionConstraint();

      const nodeType = operator.type === ECLTokenType.AND ? ECLNodeType.CONJUNCTION :
          operator.type === ECLTokenType.OR ? ECLNodeType.DISJUNCTION :
              ECLNodeType.EXCLUSION;

      left = {
        type: ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT,
        operator: nodeType,
        left,
        right
      };
    }

    return left;
  }

  parseRefinedExpressionConstraint() {
    let base = this.parseDottedExpressionConstraint();

    if (this.match(ECLTokenType.COLON)) {
      this.advance(); // consume :
      const refinement = this.parseRefinement();

      return {
        type: ECLNodeType.REFINED_EXPRESSION_CONSTRAINT,
        base,
        refinement
      };
    }

    return base;
  }

  parseDottedExpressionConstraint() {
    let base = this.parseSubExpressionConstraint();

    const attributes = [];
    while (this.match(ECLTokenType.DOT)) {
      this.advance(); // consume .
      const attribute = this.parseAttributeName();
      attributes.push(attribute);
    }

    if (attributes.length > 0) {
      return {
        type: ECLNodeType.DOTTED_EXPRESSION_CONSTRAINT,
        base,
        attributes
      };
    }

    return base;
  }

  parseSubExpressionConstraint() {
    // Handle constraint operators
    let operator = null;
    if (this.match(
        ECLTokenType.CHILD_OF, ECLTokenType.CHILD_OR_SELF_OF,
        ECLTokenType.DESCENDANT_OF, ECLTokenType.DESCENDANT_OR_SELF_OF,
        ECLTokenType.PARENT_OF, ECLTokenType.PARENT_OR_SELF_OF,
        ECLTokenType.ANCESTOR_OF, ECLTokenType.ANCESTOR_OR_SELF_OF,
        ECLTokenType.TOP_OF_SET, ECLTokenType.BOTTOM_OF_SET
    )) {
      operator = this.current;
      this.advance();
    }

    let focus;

    // Handle memberOf
    if (this.match(ECLTokenType.MEMBER_OF)) {
      this.advance(); // consume ^
      // Optional reference set field selection: ^ [field, field] refset
      // (ECL 2.x). Parsed into focus.fields; the evaluator decides what it
      // can do with it.
      let fields = null;
      if (this.match(ECLTokenType.LBRACKET)) {
        this.advance();
        fields = [];
        do {
          if (!this.match(ECLTokenType.SCTID) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(this.current.value)) {
            this.error('Expected a reference set field name after ^ [');
          }
          fields.push(this.current.value);
          this.advance();
        } while (this.match(ECLTokenType.COMMA) && (this.advance(), true));
        this.expect(ECLTokenType.RBRACKET);
      }
      // Parse the reference set - can be concept reference, wildcard, or parenthesized expression
      // but NOT another constraint operator or member-of expression
      let refSet;
      if (this.match(ECLTokenType.LPAREN)) {
        this.advance(); // consume (
        refSet = this.parseExpressionConstraint();
        this.expect(ECLTokenType.RPAREN);
      } else {
        refSet = this.parseEclFocusConcept();
      }

      focus = {
        type: ECLNodeType.MEMBER_OF,
        refSet
      };
      if (fields) {
        focus.fields = fields;
      }
    } else if (this.match(ECLTokenType.LPAREN)) {
      this.advance(); // consume (
      focus = this.parseExpressionConstraint();
      this.expect(ECLTokenType.RPAREN);
    } else {
      focus = this.parseEclFocusConcept();
    }

    // ECL 2.x filter constraints: *(memberFilterConstraint) directly after a
    // memberOf focus, then *(descriptionFilter / conceptFilter) and an optional
    // history supplement after any sub expression. Member filters are parsed
    // into focus.memberFilters; the others are parsed into focus-level
    // `filters` and rejected (as unsupported) at evaluation time.
    const filters = [];
    while (this.match(ECLTokenType.LFILTER)) {
      const fc = this.parseFilterConstraint();
      if (fc.kind === 'M') {
        if (focus.type !== ECLNodeType.MEMBER_OF) {
          throw new Error('A member filter ({{ M ... }}) may only follow a memberOf (^) expression constraint');
        }
        if (filters.length > 0) {
          throw new Error('A member filter ({{ M ... }}) must precede any description, concept or history filter');
        }
        focus.memberFilters = (focus.memberFilters || []).concat(fc.filters);
      } else {
        filters.push(fc);
      }
    }

    const result = {
      type: ECLNodeType.SUB_EXPRESSION_CONSTRAINT,
      operator: operator ? operator.type : null,
      focus
    };
    if (filters.length > 0) {
      result.filters = filters;
    }

    return result;
  }

  /**
   * Parse one "{{ ... }}" block. Returns { kind: 'M'|'D'|'C'|'+', filters } where
   * filters is only populated for member filters; the other kinds keep their
   * raw token text so the evaluator can report them as unsupported.
   */
  parseFilterConstraint() {
    this.expect(ECLTokenType.LFILTER);
    let kind;
    if (this.match(ECLTokenType.PLUS)) {
      kind = '+';
      this.advance();
    } else if (this.match(ECLTokenType.SCTID) && /^[MDCmdc]$/.test(this.current.value)) {
      kind = this.current.value.toUpperCase();
      this.advance();
    } else {
      this.error('Expected M, D, C or + after {{');
    }

    if (kind === 'C' || kind === 'D') {
      const parseOne = kind === 'C' ? () => this.parseConceptFilter() : () => this.parseDescriptionFilter();
      const filters = [parseOne()];
      while (this.match(ECLTokenType.COMMA)) {
        this.advance();
        filters.push(parseOne());
      }
      this.expect(ECLTokenType.RFILTER);
      return { type: ECLNodeType.FILTER_CONSTRAINT, kind, filters };
    }

    if (kind === '+') {
      // historySupplement = "{{" "+" "HISTORY" [ "-MIN" / "-MOD" / "-MAX" / "(" (expressionConstraint / "*") ")" ] "}}"
      if (!this.match(ECLTokenType.SCTID) || !/^HISTORY(-MIN|-MOD|-MAX)?$/i.test(this.current.value)) {
        this.error('Expected HISTORY, HISTORY-MIN, HISTORY-MOD or HISTORY-MAX after {{ +');
      }
      const word = this.current.value.toUpperCase();
      this.advance();
      const node = { type: ECLNodeType.FILTER_CONSTRAINT, kind, profile: word === 'HISTORY' ? 'MAX' : word.substring(8) };
      if (this.match(ECLTokenType.LPAREN)) {
        if (node.profile !== 'MAX' || word !== 'HISTORY') {
          this.error('A history profile (HISTORY-MIN/MOD/MAX) cannot also name reference sets');
        }
        this.advance();
        if (this.match(ECLTokenType.WILDCARD)) {
          this.advance();
          node.profile = 'MAX';
        } else {
          node.profile = 'EXPLICIT';
          node.refsets = this.parseExpressionConstraint();
        }
        this.expect(ECLTokenType.RPAREN);
      }
      this.expect(ECLTokenType.RFILTER);
      return node;
    }

    const filters = [this.parseMemberFilter()];
    while (this.match(ECLTokenType.COMMA)) {
      this.advance();
      filters.push(this.parseMemberFilter());
    }
    this.expect(ECLTokenType.RFILTER);
    return { type: ECLNodeType.FILTER_CONSTRAINT, kind, filters };
  }

  /**
   * descriptionFilter = termFilter / languageFilter / typeFilter / dialectFilter
   *                   / moduleFilter / effectiveTimeFilter / activeFilter / descriptionIdFilter
   *
   *   term          = / != (typedSearchTerm / "(" typedSearchTerm* ")")   typedSearchTerm = [match:]"..." / wild:"..."
   *   language      = / != (languageCode / "(" languageCode* ")")        e.g. en, fr
   *   typeId        = / != (subExpressionConstraint / "(" conceptRef* ")")
   *   type          = / != (syn / fsn / def, or a bracketed set of them)
   *   dialectId     = / != (subExpressionConstraint / "(" dialectId [acceptabilitySet]* ")") [acceptabilitySet]
   *   dialect       = / != (dialectAlias / "(" dialectAlias [acceptabilitySet]* ")") [acceptabilitySet]
   *   moduleId      = / != (subExpressionConstraint / "(" conceptRef* ")")
   *   effectiveTime timeComparisonOperator (timeValue / "(" timeValue* ")")
   *   active        = / != (true / false / 1 / 0)
   *   id            = / != (descriptionId / "(" descriptionId* ")")
   *
   * acceptabilitySet = "(" (preferred / acceptable / prefer / accept / conceptRef)* ")"
   */
  parseDescriptionFilter() {
    if (!this.match(ECLTokenType.SCTID) || !/^[A-Za-z_]/.test(this.current.value)) {
      this.error('Expected term, language, typeId, type, dialectId, dialect, moduleId, effectiveTime, active or id in description filter');
    }
    const field = this.current.value;
    const lower = field.toLowerCase();
    this.advance();
    const operator = this.parseComparisonOperator(field);
    const node = { type: ECLNodeType.DESCRIPTION_FILTER, field, operator };
    const booleanOnly = () => {
      if (operator !== '=' && operator !== '!=') {
        throw new Error(`Operator ${operator} is not valid for ${field} in a description filter`);
      }
    };
    switch (lower) {
      case 'term':
        booleanOnly();
        node.valueType = 'term';
        node.values = this.parseStringValueSet(true).map(v => typeof v === 'string' ? { kind: 'match', value: v } : v);
        for (const v of node.values) {
          if (v.value.trim() === '') {
            throw new Error('A term filter needs a non-empty search term');
          }
        }
        break;
      case 'language':
        booleanOnly();
        node.valueType = 'language';
        node.values = this.parseTokenSet(/^[a-z]{2}$/i, 'a two-letter language code').map(v => v.toLowerCase());
        break;
      case 'typeid':
      case 'moduleid':
        booleanOnly();
        node.valueType = 'expression';
        node.value = this.parseConceptReferenceSetOrExpression();
        break;
      case 'type':
        booleanOnly();
        node.valueType = 'type';
        node.values = this.parseTokenSet(/^(syn|fsn|def)$/i, 'syn, fsn or def').map(v => v.toLowerCase());
        break;
      case 'dialectid':
      case 'dialect': {
        booleanOnly();
        node.valueType = lower === 'dialectid' ? 'dialectId' : 'dialect';
        node.dialects = this.parseDialectSet(lower === 'dialectid');
        if (this.match(ECLTokenType.LPAREN)) {
          const acc = this.parseAcceptabilitySet();
          for (const d of node.dialects) {
            if (!d.acceptability) d.acceptability = acc;
          }
        }
        break;
      }
      case 'effectivetime':
        node.valueType = 'time';
        node.values = this.parseTimeValueSet();
        break;
      case 'active':
        booleanOnly();
        node.valueType = 'boolean';
        node.value = this.parseBooleanValue();
        break;
      case 'id':
        booleanOnly();
        node.valueType = 'id';
        node.values = this.parseTokenSet(/^\d{6,18}$/, 'a description id');
        break;
      default:
        throw new Error(`Unknown description filter field ${field} - expected term, language, typeId, type, dialectId, dialect, moduleId, effectiveTime, active or id`);
    }
    return node;
  }

  // token / "(" token* ")" where each token is an identifier matching `pattern`
  parseTokenSet(pattern, what) {
    const values = [];
    const readOne = () => {
      if (this.match(ECLTokenType.SCTID) && pattern.test(this.current.value)) {
        values.push(this.current.value);
        this.advance();
      } else {
        this.error(`Expected ${what}`);
      }
    };
    if (this.match(ECLTokenType.LPAREN)) {
      this.advance();
      do {
        readOne();
      } while (!this.match(ECLTokenType.RPAREN) && !this.match(ECLTokenType.EOF));
      this.expect(ECLTokenType.RPAREN);
    } else {
      readOne();
    }
    return values;
  }

  /**
   * The dialects of a dialect filter: [{ id | alias, acceptability? }]. A
   * dialectId value may be a sub expression (one entry with `expression`), or a
   * bracketed list of ids each optionally followed by its own acceptability set;
   * a dialect alias (en-us, en-gb, ...) is an identifier.
   */
  parseDialectSet(byId) {
    const readAlias = () => {
      // "en-gb" lexes as SCTID(en-gb) because '-' followed by a letter is kept in identifiers
      if (this.match(ECLTokenType.SCTID) && /^[a-z]{2}(-[a-z0-9]+)*$/i.test(this.current.value)) {
        const alias = this.current.value.toLowerCase();
        this.advance();
        return { alias };
      }
      this.error('Expected a dialect alias such as en-us or en-gb');
    };
    if (!byId) {
      if (!this.match(ECLTokenType.LPAREN)) {
        return [readAlias()];
      }
      this.advance();
      const dialects = [];
      while (!this.match(ECLTokenType.RPAREN) && !this.match(ECLTokenType.EOF)) {
        const d = readAlias();
        if (this.match(ECLTokenType.LPAREN)) d.acceptability = this.parseAcceptabilitySet();
        dialects.push(d);
      }
      this.expect(ECLTokenType.RPAREN);
      return dialects;
    }
    // by id: "(" id [acceptabilitySet] ... ")" or a sub expression
    if (this.match(ECLTokenType.LPAREN) && this.peek().type === ECLTokenType.SCTID && /^\d+$/.test(this.peek().value)) {
      this.advance();
      const dialects = [];
      while (!this.match(ECLTokenType.RPAREN) && !this.match(ECLTokenType.EOF)) {
        const d = { expression: { type: ECLNodeType.SUB_EXPRESSION_CONSTRAINT, operator: null, focus: this.parseEclFocusConcept() } };
        if (this.match(ECLTokenType.LPAREN)) d.acceptability = this.parseAcceptabilitySet();
        dialects.push(d);
      }
      this.expect(ECLTokenType.RPAREN);
      return dialects;
    }
    return [{ expression: this.parseSubExpressionConstraint() }];
  }

  // "(" (preferred / acceptable / prefer / accept / conceptRef)* ")" -> ['preferred'|'acceptable'|conceptId ...]
  parseAcceptabilitySet() {
    this.expect(ECLTokenType.LPAREN);
    const values = [];
    while (!this.match(ECLTokenType.RPAREN) && !this.match(ECLTokenType.EOF)) {
      if (this.match(ECLTokenType.SCTID) && /^(prefer|preferred|accept|acceptable)$/i.test(this.current.value)) {
        values.push(/^pref/i.test(this.current.value) ? 'preferred' : 'acceptable');
        this.advance();
      } else if (this.match(ECLTokenType.SCTID) && /^\d+$/.test(this.current.value)) {
        values.push(this.parseEclFocusConcept().conceptId);
      } else {
        this.error('Expected preferred, acceptable or an acceptability concept id');
      }
    }
    this.expect(ECLTokenType.RPAREN);
    if (values.length === 0) {
      this.error('An acceptability set must not be empty');
    }
    return values;
  }

  /**
   * conceptFilter = definitionStatusIdFilter / definitionStatusTokenFilter / moduleFilter
   *               / effectiveTimeFilter / activeFilter
   *
   *   definitionStatusId = / != (subExpressionConstraint / "(" conceptRef* ")")
   *   definitionStatus   = / != (primitive / defined / "(" (primitive / defined)* ")")
   *   moduleId           = / != (subExpressionConstraint / "(" conceptRef* ")")
   *   effectiveTime      timeComparisonOperator (timeValue / "(" timeValue* ")")
   *   active             = / != (true / false / 1 / 0)
   */
  parseConceptFilter() {
    if (!this.match(ECLTokenType.SCTID) || !/^[A-Za-z_]/.test(this.current.value)) {
      this.error('Expected definitionStatusId, definitionStatus, moduleId, effectiveTime or active in concept filter');
    }
    const field = this.current.value;
    const lower = field.toLowerCase();
    this.advance();
    const operator = this.parseComparisonOperator(field);
    const node = { type: ECLNodeType.CONCEPT_FILTER, field, operator };
    const booleanOnly = () => {
      if (operator !== '=' && operator !== '!=') {
        throw new Error(`Operator ${operator} is not valid for ${field} in a concept filter`);
      }
    };
    switch (lower) {
      case 'effectivetime':
        node.valueType = 'time';
        node.values = this.parseTimeValueSet();
        break;
      case 'active':
        booleanOnly();
        node.valueType = 'boolean';
        node.value = this.parseBooleanValue();
        break;
      case 'moduleid':
      case 'definitionstatusid':
        booleanOnly();
        node.valueType = 'expression';
        node.value = this.parseConceptReferenceSetOrExpression();
        break;
      case 'definitionstatus': {
        booleanOnly();
        node.valueType = 'definitionStatus';
        node.values = [];
        const readToken = () => {
          if (this.match(ECLTokenType.SCTID) && /^(primitive|defined)$/i.test(this.current.value)) {
            node.values.push(this.current.value.toLowerCase());
            this.advance();
          } else {
            this.error('Expected primitive or defined');
          }
        };
        if (this.match(ECLTokenType.LPAREN)) {
          this.advance();
          do {
            readToken();
          } while (!this.match(ECLTokenType.RPAREN) && !this.match(ECLTokenType.EOF));
          this.expect(ECLTokenType.RPAREN);
        } else {
          readToken();
        }
        break;
      }
      default:
        throw new Error(`Unknown concept filter field ${field} - expected definitionStatusId, definitionStatus, moduleId, effectiveTime or active`);
    }
    return node;
  }

  parseComparisonOperator(field) {
    if (this.match(ECLTokenType.EQUALS, ECLTokenType.NOT_EQUALS, ECLTokenType.LT, ECLTokenType.LTE,
        ECLTokenType.GT, ECLTokenType.GTE, ECLTokenType.DESCENDANT_OF, ECLTokenType.ANCESTOR_OF)) {
      // "<" and ">" lex as hierarchy operators; in a comparison they are less/greater than
      const t = this.current.type;
      const operator = t === ECLTokenType.DESCENDANT_OF ? '<' : t === ECLTokenType.ANCESTOR_OF ? '>' : this.current.value;
      this.advance();
      return operator;
    }
    this.error(`Expected comparison operator after ${field}`);
  }

  parseTimeValueSet() {
    const values = this.parseStringValueSet();
    for (const v of values) {
      if (!/^\d{8}$/.test(v)) {
        throw new Error(`Invalid effectiveTime value "${v}" - expected "YYYYMMDD"`);
      }
    }
    return values;
  }

  /**
   * subExpressionConstraint / eclConceptReferenceSet. The reference set form
   * "( 123 |a| 456 |b| )" is a bare list of concept references, which is not a
   * valid expression; it is parsed into an OR of the references.
   */
  parseConceptReferenceSetOrExpression() {
    if (this.match(ECLTokenType.LPAREN)) {
      // look ahead: "(" SCTID [TERM] (SCTID / ")") marks a reference set
      let i = 1;
      if (this.peek(i).type === ECLTokenType.SCTID && /^\d+$/.test(this.peek(i).value)) {
        i++;
        if (this.peek(i).type === ECLTokenType.TERM) i++;
        if (this.peek(i).type === ECLTokenType.SCTID || this.peek(i).type === ECLTokenType.RPAREN) {
          this.advance(); // (
          let node = null;
          while (!this.match(ECLTokenType.RPAREN)) {
            if (!this.match(ECLTokenType.SCTID)) {
              this.error('Expected a concept reference in the reference set');
            }
            const ref = { type: ECLNodeType.SUB_EXPRESSION_CONSTRAINT, operator: null, focus: this.parseEclFocusConcept() };
            node = node === null ? ref : {
              type: ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT, operator: ECLNodeType.DISJUNCTION, left: node, right: ref
            };
          }
          this.advance(); // )
          return node;
        }
      }
    }
    return this.parseSubExpressionConstraint();
  }

  /**
   * memberFilter = (refsetFieldName / "moduleId" / "effectiveTime" / "active") ws comparison
   *
   * The comparison form is decided by the field name for the three standard
   * fields, and otherwise by the token that follows the operator:
   *   "#" number                 -> numeric
   *   string / ( string ... )    -> string (or time, for an 8-digit value)
   *   true/false/1/0             -> boolean
   *   anything else              -> subExpressionConstraint (a concept-valued field)
   */
  parseMemberFilter() {
    if (!this.match(ECLTokenType.SCTID) || !/^[A-Za-z_]/.test(this.current.value)) {
      this.error('Expected a reference set field name in member filter');
    }
    const field = this.current.value;
    this.advance();

    const operator = this.parseComparisonOperator(field);
    const node = { type: ECLNodeType.MEMBER_FILTER, field, operator };
    const lower = field.toLowerCase();

    if (lower === 'effectivetime') {
      node.valueType = 'time';
      node.values = this.parseTimeValueSet();
    } else if (lower === 'active') {
      node.valueType = 'boolean';
      node.value = this.parseBooleanValue();
      if (operator !== '=' && operator !== '!=') {
        throw new Error(`Operator ${operator} is not valid for a boolean member filter`);
      }
    } else if (lower === 'moduleid') {
      node.valueType = 'expression';
      node.value = this.parseConceptReferenceSetOrExpression();
      if (operator !== '=' && operator !== '!=') {
        throw new Error(`Operator ${operator} is not valid for moduleId in a member filter`);
      }
    } else if (this.match(ECLTokenType.HASH)) {
      this.advance();
      if (!this.match(ECLTokenType.INTEGER, ECLTokenType.DECIMAL, ECLTokenType.SCTID)) {
        this.error('Expected a number after #');
      }
      node.valueType = 'numeric';
      node.value = this.current.value;
      this.advance();
    } else if (this.match(ECLTokenType.STRING, ECLTokenType.LPAREN) && this.#looksLikeStringSet()) {
      node.valueType = 'string';
      node.values = this.parseStringValueSet();
    } else if (this.match(ECLTokenType.SCTID) && /^(true|false|1|0)$/i.test(this.current.value) &&
        !this.#followedByTerm()) {
      node.valueType = 'boolean';
      node.value = this.parseBooleanValue();
    } else {
      node.valueType = 'expression';
      node.value = this.parseSubExpressionConstraint();
      if (operator !== '=' && operator !== '!=') {
        throw new Error(`Operator ${operator} is not valid for a concept-valued member filter field`);
      }
    }
    return node;
  }

  // Is the current token a string, or a bracketed list of strings (as opposed to
  // a bracketed sub expression constraint)?
  #looksLikeStringSet() {
    if (this.match(ECLTokenType.STRING)) return true;
    return this.peek().type === ECLTokenType.STRING;
  }

  #followedByTerm() {
    return this.peek().type === ECLTokenType.TERM;
  }

  // string / "(" string *(ws string) ")"   (also accepts the typed forms match:"x" / wild:"x")
  parseStringValueSet(allowWild = false) {
    const values = [];
    const readOne = () => {
      if (this.match(ECLTokenType.SCTID) && /^(match|wild)$/i.test(this.current.value) &&
          this.peek().type === ECLTokenType.COLON) {
        const kind = this.current.value.toLowerCase();
        this.advance();
        this.advance();
        if (kind === 'wild' && !allowWild) {
          throw new Error('wild: search terms are not supported in member filters');
        }
        if (!this.match(ECLTokenType.STRING)) {
          this.error('Expected a quoted string value');
        }
        values.push({ kind, value: this.current.value });
        this.advance();
        return;
      }
      if (!this.match(ECLTokenType.STRING)) {
        this.error('Expected a quoted string value');
      }
      values.push(this.current.value);
      this.advance();
    };
    if (this.match(ECLTokenType.LPAREN)) {
      this.advance();
      do {
        readOne();
      } while (!this.match(ECLTokenType.RPAREN) && !this.match(ECLTokenType.EOF));
      this.expect(ECLTokenType.RPAREN);
    } else {
      readOne();
    }
    return values;
  }

  parseBooleanValue() {
    if (this.match(ECLTokenType.SCTID) && /^(true|false|1|0)$/i.test(this.current.value)) {
      const v = this.current.value.toLowerCase();
      this.advance();
      return v === 'true' || v === '1';
    }
    this.error('Expected true, false, 1 or 0');
  }

  parseEclFocusConcept() {
    if (this.match(ECLTokenType.WILDCARD)) {
      this.advance();
      return {
        type: ECLNodeType.WILDCARD
      };
    }

    // ECL 2.1 alternate identifiers: "scheme#code" (quoted) or scheme#code
    if (this.match(ECLTokenType.STRING) && /^[A-Za-z0-9_-]+#.+$/.test(this.current.value)) {
      const [scheme, ...rest] = this.current.value.split('#');
      this.advance();
      return this.#altIdentifier(scheme, rest.join('#'));
    }
    if (this.match(ECLTokenType.SCTID) && /^[A-Za-z]/.test(this.current.value) && this.peek().type === ECLTokenType.HASH) {
      const scheme = this.current.value;
      this.advance();
      this.advance(); // #
      let code = '';
      // the code runs until whitespace: alphanumerics, "-", "." and "_"
      while (this.match(ECLTokenType.SCTID, ECLTokenType.INTEGER, ECLTokenType.DECIMAL, ECLTokenType.DOT, ECLTokenType.CARDINALITY_RANGE)) {
        code += this.current.value;
        this.advance();
      }
      if (code === '') {
        this.error(`Expected a code after ${scheme}#`);
      }
      return this.#altIdentifier(scheme, code);
    }

    if (this.match(ECLTokenType.SCTID)) {
      const conceptId = this.current.value;
      if (!/^\d{6,18}$/.test(conceptId)) {
        this.error(`"${conceptId}" is not a valid SNOMED CT concept id`);
      }
      this.advance();

      let term = null;
      if (this.match(ECLTokenType.TERM)) {
        term = this.current.value;
        this.advance();
      }

      return {
        type: ECLNodeType.CONCEPT_REFERENCE,
        conceptId,
        term
      };
    }

    this.error('Expected concept reference or wildcard');
  }

  #altIdentifier(scheme, code) {
    let term = null;
    if (this.match(ECLTokenType.TERM)) {
      term = this.current.value;
      this.advance();
    }
    return { type: ECLNodeType.ALT_IDENTIFIER, scheme, code, term };
  }

  /**
   * eclRefinement = subRefinement *(ws (AND / OR / ",") ws subRefinement)
   * subRefinement = eclAttributeSet / eclAttributeGroup / "(" eclRefinement ")"
   *
   * "," is a conjunction. As with compound expressions, AND and OR may not be
   * mixed in one un-bracketed sequence (ECL 6.4). A single sub refinement is
   * returned as-is; otherwise an ATTRIBUTE_SET with operator 'AND' or 'OR'.
   */
  parseRefinement() {
    return this.parseRefinementSet(() => this.parseSubRefinement(), 'refinement');
  }

  parseRefinementSet(parseItem, what) {
    const items = [parseItem()];
    let operator = null;
    for (;;) {
      let op;
      if (this.match(ECLTokenType.COMMA, ECLTokenType.AND)) {
        op = 'AND';
      } else if (this.match(ECLTokenType.OR)) {
        op = 'OR';
      } else {
        break;
      }
      if (operator !== null && op !== operator) {
        throw new Error(
          `Ambiguous ECL ${what}: AND (or ",") and OR cannot be mixed without parentheses (ECL 6.4). ` +
          'Use round brackets to disambiguate.');
      }
      operator = op;
      this.advance();
      items.push(parseItem());
    }
    if (items.length === 1) {
      return items[0];
    }
    return {
      type: ECLNodeType.ATTRIBUTE_SET,
      operator,
      attributes: items
    };
  }

  parseSubRefinement() {
    // A leading cardinality may prefix either a single attribute
    // ([m..n] attr = v) or an attribute group ([m..n] { ... }). Parse it once,
    // then dispatch on whether a group ({) or an attribute follows.
    let cardinality = null;
    if (this.match(ECLTokenType.LBRACKET)) {
      cardinality = this.parseCardinality();
    }
    if (this.match(ECLTokenType.LBRACE)) {
      return this.parseAttributeGroup(cardinality);
    }
    if (cardinality === null && this.match(ECLTokenType.LPAREN) && !this.#parenIsAttributeName()) {
      this.advance();
      const inner = this.parseRefinement();
      this.expect(ECLTokenType.RPAREN);
      return inner;
    }
    return this.parseAttribute(cardinality);
  }

  // At a "(" inside a refinement: is this a bracketed attribute name
  // ("(A OR B) = x") rather than a bracketed sub refinement ("(A = x OR B = y)")?
  // It is when the token after the matching ")" is a comparison operator.
  #parenIsAttributeName() {
    let depth = 0;
    for (let i = 0; ; i++) {
      const t = this.peek(i).type;
      if (t === ECLTokenType.EOF) return false;
      if (t === ECLTokenType.LPAREN) depth++;
      if (t === ECLTokenType.RPAREN && --depth === 0) {
        return [ECLTokenType.EQUALS, ECLTokenType.NOT_EQUALS, ECLTokenType.LT, ECLTokenType.LTE, ECLTokenType.GT,
          ECLTokenType.GTE, ECLTokenType.DESCENDANT_OF, ECLTokenType.ANCESTOR_OF].includes(this.peek(i + 1).type);
      }
    }
  }

  /**
   * eclAttributeSet = subAttributeSet *(ws (AND / OR / ",") ws subAttributeSet)
   * subAttributeSet = eclAttribute / "(" eclAttributeSet ")"
   * (the contents of an attribute group - no nested groups)
   */
  parseAttributeSet() {
    return this.parseRefinementSet(() => {
      if (this.match(ECLTokenType.LPAREN) && !this.#parenIsAttributeName()) {
        this.advance();
        const inner = this.parseAttributeSet();
        this.expect(ECLTokenType.RPAREN);
        return inner;
      }
      return this.parseAttribute();
    }, 'attribute set');
  }

  parseAttributeGroup(cardinality = null) {
    // Cardinality may have been parsed by the caller (parseSubRefinement); if
    // not, check for it here (before the opening brace).
    if (cardinality === null && this.match(ECLTokenType.LBRACKET)) {
      cardinality = this.parseCardinality();
    }

    this.expect(ECLTokenType.LBRACE);
    const content = this.parseAttributeSet();
    this.expect(ECLTokenType.RBRACE);

    return {
      type: ECLNodeType.ATTRIBUTE_GROUP,
      cardinality,
      // A plain conjunction of attributes ("{ a = x, b = y }") stays a flat
      // list, as it always was; anything with OR or nesting is a single
      // ATTRIBUTE_SET entry carrying that structure.
      attributes: content.type === ECLNodeType.ATTRIBUTE_SET && content.operator === 'AND' &&
        content.attributes.every(a => a.type === ECLNodeType.ATTRIBUTE) ? content.attributes : [content]
    };
  }

  parseAttribute(cardinality = null) {
    let reverse = false;

    // Cardinality may have been parsed by the caller (parseAttributeSet); if
    // not, check for it here (it must come before the attribute name).
    if (cardinality === null && this.match(ECLTokenType.LBRACKET)) {
      cardinality = this.parseCardinality();
    }

    // Check for reverse flag
    if (this.match(ECLTokenType.REVERSE)) {
      reverse = true;
      this.advance();
    }

    const name = this.parseAttributeName();

    // Parse comparison operator and value
    let comparison = null;
    if (this.match(ECLTokenType.EQUALS, ECLTokenType.NOT_EQUALS)) {
      const operator = this.current;
      this.advance();
      if (this.match(ECLTokenType.HASH)) {
        // numeric concrete value: = #5, != #1.5
        this.advance();
        if (!this.match(ECLTokenType.SCTID, ECLTokenType.DECIMAL, ECLTokenType.INTEGER)) {
          this.error('Expected numeric value after #');
        }
        comparison = { type: ECLNodeType.NUMERIC_COMPARISON, operator: operator.type, value: this.current.value };
        this.advance();
      } else if (this.match(ECLTokenType.STRING) ||
          (this.match(ECLTokenType.LPAREN) && this.peek().type === ECLTokenType.STRING) ||
          (this.match(ECLTokenType.SCTID) && /^(match|wild)$/i.test(this.current.value) && this.peek().type === ECLTokenType.COLON)) {
        // string concrete value: = "x", != ("x" "y"), = match:"x"
        comparison = { type: ECLNodeType.STRING_COMPARISON, operator: operator.type, values: this.parseStringValueSet(true) };
      } else if (this.match(ECLTokenType.SCTID) && /^(true|false)$/i.test(this.current.value) && this.peek().type !== ECLTokenType.TERM) {
        // boolean concrete value: = true, != false
        comparison = { type: ECLNodeType.BOOLEAN_COMPARISON, operator: operator.type, value: this.parseBooleanValue() };
      } else {
        const value = this.parseSubExpressionConstraint();
        comparison = {
          type: ECLNodeType.EXPRESSION_COMPARISON,
          operator: operator.type,
          value
        };
      }
    } else if (this.match(ECLTokenType.LT, ECLTokenType.LTE, ECLTokenType.DESCENDANT_OF, ECLTokenType.ANCESTOR_OF, ECLTokenType.GTE)) {
      // In ECL, bare `<` and `>` are overloaded: they lex as hierarchy
      // operators (DESCENDANT_OF / ANCESTOR_OF) but in an attribute comparison
      // context they mean less-than / greater-than. Accept them here and map
      // them to LT / GT so downstream consumers see a uniform shape.
      const operator = this.current;
      this.advance();

      this.expect(ECLTokenType.HASH);

      let value;
      if (this.match(ECLTokenType.SCTID, ECLTokenType.DECIMAL, ECLTokenType.INTEGER)) {
        // In numeric comparison context, accept SCTID, DECIMAL, or INTEGER as numbers
        value = this.current.value;
        this.advance();
      } else {
        this.error('Expected numeric value after #');
      }

      // Map DESCENDANT_OF to LT and ANCESTOR_OF to GT for numeric comparisons
      let operatorType = operator.type;
      if (operator.type === ECLTokenType.DESCENDANT_OF) {
        operatorType = ECLTokenType.LT;
      } else if (operator.type === ECLTokenType.ANCESTOR_OF) {
        operatorType = ECLTokenType.GT;
      }

      comparison = {
        type: ECLNodeType.NUMERIC_COMPARISON,
        operator: operatorType,
        value
      };
    }

    if (!comparison) {
      // eclAttribute = [cardinality] [reverseFlag] eclAttributeName comparison - a
      // bare name is a syntax error. This is what "(A : B = C OR D)" trips on:
      // the OR binds inside the refinement, so D is an attribute name without a
      // comparison.
      this.error('Expected a comparison operator (=, !=, <, <=, >, >=) after the attribute name');
    }

    return {
      type: ECLNodeType.ATTRIBUTE,
      cardinality,
      reverse,
      name,
      comparison
    };
  }

  /**
   * eclAttributeName = subExpressionConstraint. A plain concept reference or
   * wildcard is returned unwrapped (the shape every consumer expects); anything
   * else (<< 363698007, (A OR B), ^ refset) is returned as the sub expression.
   */
  parseAttributeName() {
    const node = this.parseSubExpressionConstraint();
    if (node.type === ECLNodeType.SUB_EXPRESSION_CONSTRAINT && !node.operator && !node.filters &&
        (node.focus.type === ECLNodeType.CONCEPT_REFERENCE || node.focus.type === ECLNodeType.WILDCARD)) {
      return node.focus;
    }
    return node;
  }

  parseCardinality() {
    this.expect(ECLTokenType.LBRACKET);

    let min = null;
    let max = null;

    if (this.match(ECLTokenType.SCTID)) {
      // Parse as number in cardinality context
      min = parseInt(this.current.value);
      this.advance();

      // Check for range syntax: ..
      if (this.match(ECLTokenType.CARDINALITY_RANGE)) {
        this.advance(); // consume ..

        if (this.match(ECLTokenType.SCTID)) {
          max = parseInt(this.current.value);
          this.advance();
        } else if (this.match(ECLTokenType.WILDCARD)) {
          max = '*';
          this.advance();
        } else {
          this.error('Expected number or * after ..');
        }
      } else {
        max = min; // Single number means exact cardinality
      }
    } else if (this.match(ECLTokenType.WILDCARD)) {
      min = 0;
      max = '*';
      this.advance();
    } else {
      this.error('Expected number or * for cardinality');
    }

    this.expect(ECLTokenType.RBRACKET);

    return {
      type: ECLNodeType.CARDINALITY,
      min,
      max
    };
  }
}

/**
 * ECL Validator - Validates and evaluates ECL expressions
 */
class ECLValidator {
  constructor(snomedServices) {
    this.sct = snomedServices;
  }

  /**
   * Parse and validate an ECL expression
   */
  parse(eclExpression) {
    try {
      const lexer = new ECLLexer(eclExpression);
      const tokens = lexer.tokenize();

      const parser = new ECLParser(tokens);
      const ast = parser.parse();

      // Validate the AST
      this.validateAST(ast);

      return {
        success: true,
        ast,
        errors: []
      };
    } catch (error) {
      return {
        success: false,
        ast: null,
        errors: [error.message]
      };
    }
  }

  /**
   * Validate AST node semantically
   */
  validateAST(node) {
    if (!node || typeof node !== 'object') {
      throw new Error('Invalid AST node');
    }

    switch (node.type) {
      case ECLNodeType.CONCEPT_REFERENCE:
        this.validateConceptReference(node);
        break;

      case ECLNodeType.REFINED_EXPRESSION_CONSTRAINT:
        this.validateAST(node.base);
        this.validateAST(node.refinement);
        break;

      case ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT:
        this.validateAST(node.left);
        this.validateAST(node.right);
        break;

      case ECLNodeType.DOTTED_EXPRESSION_CONSTRAINT:
        this.validateAST(node.base);
        node.attributes.forEach(attr => this.validateAST(attr));
        break;

      case ECLNodeType.SUB_EXPRESSION_CONSTRAINT:
        this.validateAST(node.focus);
        for (const fc of node.filters || []) {
          for (const f of fc.filters || []) {
            if (f.valueType === 'expression') {
              this.validateAST(f.value);
            }
          }
        }
        break;

      case ECLNodeType.MEMBER_OF:
        this.validateAST(node.refSet);
        this.validateReferenceSet(node.refSet);
        for (const f of node.memberFilters || []) {
          if (f.valueType === 'expression') {
            this.validateAST(f.value);
          }
        }
        break;

      case ECLNodeType.ATTRIBUTE_SET:
        node.attributes.forEach(attr => this.validateAST(attr));
        break;

      case ECLNodeType.ATTRIBUTE_GROUP:
        node.attributes.forEach(attr => this.validateAST(attr));
        break;

      case ECLNodeType.ATTRIBUTE:
        this.validateAST(node.name);
        if (node.comparison) {
          this.validateComparison(node.comparison);
        }
        break;

      case ECLNodeType.EXPRESSION_COMPARISON:
        this.validateAST(node.value);
        break;

      case ECLNodeType.WILDCARD:
        // Wildcards are always valid
        break;

      default:
        // Allow other node types to pass through
        break;
    }
  }

  /**
   * Validate concept reference exists in SNOMED CT
   */
  /**
   * Validate concept reference exists in SNOMED CT and term matches if provided
   */
  validateConceptReference(node) {
    if (!node.conceptId) {
      throw new Error('Concept reference missing concept ID');
    }

    if (!/^\d+$/.test(node.conceptId)) {
      throw new Error(`Invalid SNOMED CT concept ID format: ${node.conceptId}`);
    }

    // Check if it's a valid concept ID
    try {
      if (!this.sct.conceptExists(node.conceptId)) {
        // Check if it might be a number used in wrong context
        const numValue = parseInt(node.conceptId);
        if (numValue < 1000000) {
          throw new Error(`${node.conceptId} appears to be a number rather than a SNOMED CT concept ID. SNOMED concept IDs are typically 6+ digits. If this should be a numeric value, use it in a cardinality [${node.conceptId}] or comparison >= #${node.conceptId} context.`);
        } else {
          throw new Error(`SNOMED CT concept ${node.conceptId} not found in the loaded terminology`);
        }
      }
    } catch (error) {
      if (error.message.includes('not found')) {
        throw error; // Re-throw our custom message
      }
      throw new Error(`Error validating concept ${node.conceptId}: ${error.message}`);
    }

    // Validate term if provided
    if (node.term) {
      try {
        const conceptIndex = this.getConceptReference(node.conceptId);
        const concept = this.sct.concepts.getConcept(conceptIndex);
        const descriptionsRef = concept.descriptions;

        if (descriptionsRef === 0) {
          throw new Error(`Concept ${node.conceptId} has no descriptions`);
        }

        const descriptionIndices = this.sct.refs.getReferences(descriptionsRef);
        let termFound = false;

        const list = [];
        // Check if the provided term matches any of the concept's descriptions
        for (const descIndex of descriptionIndices) {
          const description = this.sct.descriptions.getDescription(descIndex);
          const actualTerm = this.sct.strings.getEntry(description.iDesc).trim();
          list.push(actualTerm);
          if (actualTerm === node.term.trim()) {
            termFound = true;
            break;
          }
        }

        if (!termFound) {
          // Get the preferred term for a more helpful error message
          const preferredTerm = this.sct.getDisplayName(conceptIndex);
          throw new Error(`Term "${node.term}" does not match any active description for concept ${node.conceptId}. Expected term like "${preferredTerm}" or from ${list}`);
        }
      } catch (error) {
        if (error.message.includes('does not match')) {
          throw error; // Re-throw our term validation error
        }
        throw new Error(`Error validating term for concept ${node.conceptId}: ${error.message}`);
      }
    }
  }
  /**
   * Validate reference set concept
   */
  validateReferenceSet(node) {
    if (node.type === ECLNodeType.CONCEPT_REFERENCE) {
      const conceptIndex = this.getConceptReference(node.conceptId);
      const refSetIndex = this.sct.getConceptRefSet(conceptIndex, false);
      if (refSetIndex === 0) {
        throw new Error(`Concept ${node.conceptId} is not a reference set`);
      }
    }
  }

  /**
   * Validate comparison expressions
   */
  validateComparison(comparison) {
    switch (comparison.type) {
      case ECLNodeType.EXPRESSION_COMPARISON:
        this.validateAST(comparison.value);
        break;

      case ECLNodeType.NUMERIC_COMPARISON:
        if (!/^-?\d+(\.\d+)?$/.test(comparison.value)) {
          throw new Error(`Invalid numeric value: ${comparison.value}`);
        }
        break;

      case ECLNodeType.STRING_COMPARISON:
      case ECLNodeType.BOOLEAN_COMPARISON:
        // String and boolean values are always valid
        break;
    }
  }

  /**
   * Evaluate ECL expression and return matching concepts
   */
  async evaluate(eclExpression, options = {}) {
    const parseResult = this.parse(eclExpression);

    if (!parseResult.success) {
      throw new Error(`ECL parsing failed: ${parseResult.errors.join(', ')}`);
    }

    const filterContext = await this.evaluateAST(parseResult.ast, options);
    return this.convertFilterToResults(filterContext);
  }

  /**
   * Evaluate AST node and return filter context
   */
  async evaluateAST(node = {}) {
    if (!node) {
      throw new Error('Cannot evaluate null AST node');
    }

    switch (node.type) {
      case ECLNodeType.CONCEPT_REFERENCE:
        return await this.evaluateConceptReference(node);

      case ECLNodeType.WILDCARD:
        return await this.evaluateWildcard();

      case ECLNodeType.SUB_EXPRESSION_CONSTRAINT:
        return await this.evaluateSubExpressionConstraint(node);

      case ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT:
        return await this.evaluateCompoundExpression(node);

      case ECLNodeType.REFINED_EXPRESSION_CONSTRAINT:
        return await this.evaluateRefinedExpression(node);

      case ECLNodeType.MEMBER_OF:
        return await this.evaluateMemberOf(node);

      default:
        throw new Error(`Unsupported AST node type: ${node.type}`);
    }
  }

  async evaluateConceptReference(node) {
    const conceptId = this.sct.stringToId(node.conceptId);
    return this.sct.filterEquals(conceptId);
  }

  async evaluateWildcard() {
    const { SnomedFilterContext } = require('../cs/cs-snomed');

    // Return all concepts - this would need optimization in practice
    const filter = new SnomedFilterContext();
    const allConcepts = [];

    for (let i = 0; i < this.sct.concepts.count(); i++) {
      const conceptIndex = i * this.sct.concepts.constructor.CONCEPT_SIZE;
      if (this.sct.isActive(conceptIndex)) {
        allConcepts.push(conceptIndex);
      }
    }

    filter.descendants = allConcepts;
    return filter;
  }

  async evaluateSubExpressionConstraint(node) {
    const { SnomedFilterContext } = require('../cs/cs-snomed');

    const baseFilter = await this.evaluateAST(node.focus);

    if (!node.operator) {
      return baseFilter;
    }

    // Apply constraint operator — collect into a Set to deduplicate across
    // multi-concept base filters.
    const accumulated = new Set();

    for (const conceptIndex of baseFilter.descendants || []) {
      const conceptId = this.sct.concepts.getConceptId(conceptIndex);

      let operatorFilter;
      switch (node.operator) {
          // ── Descendants ─────────────────────────────────────────────────────
        case ECLTokenType.DESCENDANT_OF:           // <    transitive, no self
          operatorFilter = this.sct.filterIsA(conceptId, false);
          break;
        case ECLTokenType.DESCENDANT_OR_SELF_OF:   // <<   transitive + self
          operatorFilter = this.sct.filterIsA(conceptId, true);
          break;
        case ECLTokenType.CHILD_OF:                // <!   direct children only
          operatorFilter = this.sct.filterChildOf(conceptId);
          break;
        case ECLTokenType.CHILD_OR_SELF_OF: {      // <<!  self + direct children
          operatorFilter = new SnomedFilterContext();
          const selfResult = this.sct.concepts.findConcept(conceptId);
          const children = selfResult.found ? this.sct.getConceptChildren(selfResult.index) : [];
          operatorFilter.descendants = selfResult.found ? [selfResult.index, ...children] : children;
          break;
        }

          // ── Ancestors ───────────────────────────────────────────────────────
        case ECLTokenType.ANCESTOR_OF:             // >    transitive, no self
          operatorFilter = this.sct.filterGeneralizes(conceptId);
          break;
        case ECLTokenType.ANCESTOR_OR_SELF_OF: {   // >>   transitive + self
          operatorFilter = this.sct.filterGeneralizes(conceptId);
          const selfResult = this.sct.concepts.findConcept(conceptId);
          if (selfResult.found && !operatorFilter.descendants.includes(selfResult.index)) {
            operatorFilter.descendants.push(selfResult.index);
          }
          break;
        }
        case ECLTokenType.PARENT_OF: {             // >!   direct parents only
          operatorFilter = new SnomedFilterContext();
          const selfResult = this.sct.concepts.findConcept(conceptId);
          operatorFilter.descendants = selfResult.found
              ? this.sct.getConceptParents(selfResult.index)
              : [];
          break;
        }
        case ECLTokenType.PARENT_OR_SELF_OF: {     // >>!  self + direct parents
          operatorFilter = new SnomedFilterContext();
          const selfResult = this.sct.concepts.findConcept(conceptId);
          const parents = selfResult.found ? this.sct.getConceptParents(selfResult.index) : [];
          operatorFilter.descendants = selfResult.found ? [selfResult.index, ...parents] : parents;
          break;
        }

        default:
          throw new Error(`Unknown constraint operator: ${node.operator}`);
      }

      for (const idx of operatorFilter.descendants || []) {
        accumulated.add(idx);
      }
    }

    const results = new SnomedFilterContext();
    results.descendants = [...accumulated];
    return results;
  }

  async evaluateCompoundExpression(node) {
    const { SnomedFilterContext } = require('../cs/cs-snomed');

    const leftFilter = await this.evaluateAST(node.left);
    const rightFilter = await this.evaluateAST(node.right);

    const result = new SnomedFilterContext();
    const leftSet = new Set(leftFilter.descendants || []);
    const rightSet = new Set(rightFilter.descendants || []);

    switch (node.operator) {
      case ECLNodeType.CONJUNCTION:
        result.descendants = [...leftSet].filter(x => rightSet.has(x));
        break;
      case ECLNodeType.DISJUNCTION:
        result.descendants = [...new Set([...leftSet, ...rightSet])];
        break;
      case ECLNodeType.EXCLUSION:
        result.descendants = [...leftSet].filter(x => !rightSet.has(x));
        break;
      default:
        throw new Error(`Unknown compound operator: ${node.operator}`);
    }

    return result;
  }

  async evaluateRefinedExpression(node) {
    // This is a simplified implementation
    // Full refinement evaluation would require analyzing concept relationships
    const baseFilter = await this.evaluateAST(node.base);

    // For now, return the base filter
    // TODO: Implement refinement filtering based on node.refinement
    return baseFilter;
  }

  async evaluateMemberOf(node) {
    const refSetFilter = await this.evaluateAST(node.refSet);

    if (refSetFilter.descendants && refSetFilter.descendants.length > 0) {
      const conceptIndex = refSetFilter.descendants[0];
      return this.sct.filterIn(this.sct.concepts.getConceptId(conceptIndex));
    }

    throw new Error('Invalid reference set for memberOf operation');
  }

  /**
   * Convert filter context to user-friendly results
   */
  convertFilterToResults(filterContext) {
    const results = [];

    const concepts = filterContext.descendants || filterContext.matches || [];

    for (const conceptIndex of concepts.slice(0, 1000)) { // Limit results
      try {
        let conceptId, term;

        if (typeof conceptIndex === 'object' && conceptIndex.index !== undefined) {
          // From search results
          conceptId = conceptIndex.term;
          term = this.sct.getDisplayName(conceptIndex.index);
        } else {
          // From regular index
          conceptId = this.sct.concepts.getConceptId(conceptIndex);
          term = this.sct.getDisplayName(conceptIndex);
        }

        results.push({
          conceptId: conceptId.toString(),
          term,
          active: this.sct.isActive(conceptIndex)
        });
      } catch (error) {
        // Skip concepts that can't be read
        continue;
      }
    }

    return {
      total: concepts.length,
      results
    };
  }

  /**
   * Helper to get concept reference index from concept ID
   */
  getConceptReference(conceptId) {
    const id = this.sct.stringToId(conceptId);
    const result = this.sct.concepts.findConcept(id);
    if (!result.found) {
      throw new Error(`Concept ${conceptId} not found`);
    }
    return result.index;
  }

  /**
   * Validate ECL syntax only (no semantic validation)
   */
  validateSyntax(eclExpression) {
    try {
      const lexer = new ECLLexer(eclExpression);
      const tokens = lexer.tokenize();

      const parser = new ECLParser(tokens);
      const ast = parser.parse();

      return {
        success: true,
        ast,
        errors: []
      };
    } catch (error) {
      return {
        success: false,
        ast: null,
        errors: [error.message]
      };
    }
  }

  /**
   * Get examples of valid ECL expressions
   */
  getExamples() {
    return [
      // Simple concept
      '73211009 |Diabetes mellitus|',

      // Descendants
      '< 73211009 |Diabetes mellitus|',
      '<< 404684003 |Clinical finding|',

      // Wildcards
      '*',

      // Boolean operations
      '<< 19829001 |Disorder of lung| AND << 301867009 |Edema of trunk|',
      '<< 126537000 |Neoplasm of bone| OR << 92691004 |Secondary malignant neoplasm of bone|',

      // Refinements
      '<< 404684003 |Clinical finding|: 116676008 |Associated morphology| = 72704001 |Fracture|',

      // Attribute groups
      '<< 404684003 |Clinical finding|: {116676008 |Associated morphology| = 72704001 |Fracture|, 363698007 |Finding site| = << 71341001 |Bone structure|}',

      // Member of reference set
      '^ 447562003 |ICD-10 complex map reference set|',

      // Dotted attributes
      '<< 404684003 |Clinical finding|.116676008 |Associated morphology|'
    ];
  }

  static CONCEPT_MODEL_ATTRIBUTE = '410662002'; // |Concept model attribute|
  static CLINICAL_FINDING = '404684003'; // |Clinical finding|
  static PROCEDURE = '71388002'; // |Procedure|

  /**
   * Perform semantic validation on a parsed AST
   * This is separate from parse() and optional
   */
  validateSemantics(ast) {
    const errors = [];
    this.validateSemanticAST(ast, errors);

    return {
      success: errors.length === 0,
      errors
    };
  }

  /**
   * Parse AND validate semantics in one call
   */
  parseAndValidateSemantics(eclExpression) {
    const parseResult = this.parse(eclExpression);

    if (!parseResult.success) {
      return parseResult;
    }

    const semanticResult = this.validateSemantics(parseResult.ast);

    return {
      success: parseResult.success && semanticResult.success,
      ast: parseResult.ast,
      errors: [...parseResult.errors, ...semanticResult.errors]
    };
  }

  /**
   * Semantic validation traversal (separate from basic validateAST)
   */
  validateSemanticAST(node, errors) {
    if (!node || typeof node !== 'object') {
      return;
    }

    switch (node.type) {
      case ECLNodeType.REFINED_EXPRESSION_CONSTRAINT:
        this.validateRefinedExpressionSemantics(node, errors);
        break;

      case ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT:
        this.validateSemanticAST(node.left, errors);
        this.validateSemanticAST(node.right, errors);
        break;

      case ECLNodeType.DOTTED_EXPRESSION_CONSTRAINT:
        this.validateSemanticAST(node.base, errors);
        node.attributes.forEach(attr => this.validateSemanticAST(attr, errors));
        break;

      case ECLNodeType.SUB_EXPRESSION_CONSTRAINT:
        this.validateSemanticAST(node.focus, errors);
        break;

      case ECLNodeType.MEMBER_OF:
        this.validateSemanticAST(node.refSet, errors);
        break;

      case ECLNodeType.ATTRIBUTE_SET:
        node.attributes.forEach(attr => this.validateSemanticAST(attr, errors));
        break;

      case ECLNodeType.ATTRIBUTE_GROUP:
        node.attributes.forEach(attr => this.validateSemanticAST(attr, errors));
        break;

      case ECLNodeType.ATTRIBUTE:
        this.validateAttributeSemantics(node, errors);
        break;

      case ECLNodeType.EXPRESSION_COMPARISON:
        this.validateSemanticAST(node.value, errors);
        break;

        // Basic nodes don't need semantic validation
      case ECLNodeType.CONCEPT_REFERENCE:
      case ECLNodeType.WILDCARD:
        break;

      default:
        // Allow unknown node types to pass through
        break;
    }
  }

  /**
   * Validate semantics of refined expressions
   */
  validateRefinedExpressionSemantics(node, errors) {
    this.validateSemanticAST(node.base, errors);
    this.validateSemanticAST(node.refinement, errors);

    // Get the base concept(s) being refined
    const baseConcepts = this.extractBaseConceptIds(node.base);
    const attributes = this.extractAttributesFromRefinement(node.refinement);

    // Validate each attribute in context
    for (const attr of attributes) {
      this.validateAttributeInContext(attr, baseConcepts, errors);
    }
  }

  /**
   * Validate attribute semantics
   */
  validateAttributeSemantics(node, errors) {
    // Validate the attribute name is a relationship type
    this.validateRelationshipType(node.name, errors);

    // Validate the comparison if present
    if (node.comparison && node.comparison.value) {
      this.validateSemanticAST(node.comparison.value, errors);
      this.validateAttributeRange(node.name, node.comparison.value, errors);
    }
  }

  /**
   * Check if concept is a valid relationship type
   */
  validateRelationshipType(attributeNode, errors) {
    if (attributeNode.type !== ECLNodeType.CONCEPT_REFERENCE) {
      return; // Skip validation for wildcards or complex expressions
    }

    try {
      const conceptId = attributeNode.conceptId;
      const conceptIndex = this.getConceptReference(conceptId);

      // Check if it's a descendant of "Concept model attribute"
      const attributeRootIndex = this.getConceptReference(ECLValidator.CONCEPT_MODEL_ATTRIBUTE);

      if (!this.sct.subsumes(attributeRootIndex, conceptIndex)) {
        const displayName = attributeNode.term || this.sct.getDisplayName(conceptIndex);
        errors.push(`Concept ${conceptId} |${displayName}| is not a valid relationship type. Relationship types must be descendants of ${ECLValidator.CONCEPT_MODEL_ATTRIBUTE} |Concept model attribute|`);
      }
    } catch (error) {
      errors.push(`Error validating relationship type ${attributeNode.conceptId}: ${error.message}`);
    }
  }

  /**
   * Validate attribute usage in context of base concepts
   */
  validateAttributeInContext(attribute, baseConcepts, errors) {
    // Check domain appropriateness
    for (const baseConcept of baseConcepts) {
      this.validateAttributeDomain(attribute.name, baseConcept, errors);
    }
  }

  /**
   * Validate attribute domain (which concepts can use this attribute)
   */
  validateAttributeDomain(attributeNode, baseConceptIndex, errors) {
    if (attributeNode.type !== ECLNodeType.CONCEPT_REFERENCE) {
      return;
    }

    try {
      const attributeId = attributeNode.conceptId;

      // Define common domain restrictions
      const domainRules = {
        '116676008': ['404684003'], // |Associated morphology| -> |Clinical finding|
        '363698007': ['404684003'], // |Finding site| -> |Clinical finding|
        '42752001': ['71388002'],   // |Due to| -> |Procedure|
        '260686004': ['71388002'],  // |Method| -> |Procedure|
        '405815000': ['71388002']   // |Procedure device| -> |Procedure|
      };

      if (domainRules[attributeId]) {
        const allowedHierarchies = domainRules[attributeId];
        const isValidDomain = allowedHierarchies.some(hierarchyId => {
          const hierarchyIndex = this.getConceptReference(hierarchyId);
          return this.sct.subsumes(hierarchyIndex, baseConceptIndex);
        });

        if (!isValidDomain) {
          const hierarchyNames = allowedHierarchies.map(id => {
            const idx = this.getConceptReference(id);
            return this.sct.getDisplayName(idx);
          }).join(', ');

          const displayName = attributeNode.term || this.sct.getDisplayName(this.getConceptReference(attributeId));
          errors.push(`Attribute ${attributeId} |${displayName}| is not typically used with concepts outside of: ${hierarchyNames}`);
        }
      }
    } catch (error) {
      errors.push(`Error validating attribute domain for ${attributeNode.conceptId}: ${error.message}`);
    }
  }

  /**
   * Validate attribute range (what values are allowed)
   */
  validateAttributeRange(attributeNode, valueNode, errors) {
    if (attributeNode.type !== ECLNodeType.CONCEPT_REFERENCE) {
      return;
    }

    try {
      // Extract the actual concept reference from the value node
      let actualValueNode = valueNode;
      if (valueNode.type === ECLNodeType.SUB_EXPRESSION_CONSTRAINT) {
        actualValueNode = valueNode.focus;
      }

      if (actualValueNode.type !== ECLNodeType.CONCEPT_REFERENCE) {
        return; // Skip validation for wildcards or complex expressions
      }

      const attributeId = attributeNode.conceptId;
      const valueId = actualValueNode.conceptId;

      // Define common range restrictions
      const rangeRules = {
        '116676008': ['49755003'],  // |Associated morphology| -> |Morphologically abnormal structure|
        '363698007': ['442083009'], // |Finding site| -> |Anatomical or acquired body structure|
        '42752001': ['404684003'],  // |Due to| -> |Clinical finding|
        '47429007': ['78621006']    // |Associated with| -> |Physical force|
      };

      if (rangeRules[attributeId]) {
        const allowedRanges = rangeRules[attributeId];
        const valueIndex = this.getConceptReference(valueId);

        const isValidRange = allowedRanges.some(rangeId => {
          const rangeIndex = this.getConceptReference(rangeId);
          return this.sct.subsumes(rangeIndex, valueIndex);
        });

        if (!isValidRange) {
          const rangeNames = allowedRanges.map(id => {
            const idx = this.getConceptReference(id);
            return this.sct.getDisplayName(idx);
          }).join(', ');

          const valueDisplayName = actualValueNode.term || this.sct.getDisplayName(valueIndex);
          errors.push(`Value ${valueId} |${valueDisplayName}| is not a valid concept for attribute ${attributeId}. Expected values from: ${rangeNames}`);
        }
      }
    } catch (error) {
      errors.push(`Error validating attribute range for ${attributeNode.conceptId}: ${error.message}`);
    }
  }

  /**
   * Extract base concept IDs from expression constraint
   */
  extractBaseConceptIds(node) {
    const concepts = [];

    switch (node.type) {
      case ECLNodeType.SUB_EXPRESSION_CONSTRAINT:
        concepts.push(...this.extractBaseConceptIds(node.focus));
        break;
      case ECLNodeType.CONCEPT_REFERENCE:
        concepts.push(this.getConceptReference(node.conceptId));
        break;
      case ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT:
        concepts.push(...this.extractBaseConceptIds(node.left));
        concepts.push(...this.extractBaseConceptIds(node.right));
        break;
      case ECLNodeType.MEMBER_OF:
        concepts.push(...this.extractBaseConceptIds(node.refSet));
        break;
      case ECLNodeType.WILDCARD:
        // Wildcards represent all concepts - skip semantic validation
        break;
    }

    return concepts;
  }

  /**
   * Extract attributes from refinement
   */
  extractAttributesFromRefinement(refinementNode) {
    const attributes = [];

    switch (refinementNode.type) {
      case ECLNodeType.ATTRIBUTE:
        attributes.push(refinementNode);
        break;
      case ECLNodeType.ATTRIBUTE_SET:
      case ECLNodeType.ATTRIBUTE_GROUP:
        for (const a of refinementNode.attributes) {
          attributes.push(...this.extractAttributesFromRefinement(a));
        }
        break;
    }

    return attributes;
  }


}

module.exports = {
  ECLValidator,
  ECLLexer,
  ECLParser,
  ECLTokenType,
  ECLNodeType
};