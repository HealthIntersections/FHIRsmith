//
// Copyright 2025, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Value Set Composition Language (VCL) Parser for JavaScript FHIR
 * Based on the Java VCL parser but adapted for JavaScript
 * Compatible with ES6+ and both Node.js and browser environments
 */

class VCLParseException extends Error {
  constructor(message, position = -1) {
    super(position >= 0 ? `${message} at position ${position}` : message);
    this.name = 'VCLParseException';
    this.position = position;
  }
}

const TokenType = {
  DASH: 'DASH',
  OPEN: 'OPEN',
  CLOSE: 'CLOSE',
  LCRLY: 'LCRLY',
  RCRLY: 'RCRLY',
  SEMI: 'SEMI',
  COMMA: 'COMMA',
  DOT: 'DOT',
  STAR: 'STAR',
  EQ: 'EQ',
  IS_A: 'IS_A',
  IS_NOT_A: 'IS_NOT_A',
  DESC_OF: 'DESC_OF',
  REGEX: 'REGEX',
  IN: 'IN',
  NOT_IN: 'NOT_IN',
  GENERALIZES: 'GENERALIZES',
  CHILD_OF: 'CHILD_OF',
  DESC_LEAF: 'DESC_LEAF',
  EXISTS: 'EXISTS',
  URI: 'URI',
  SCODE: 'SCODE',
  QUOTED_VALUE: 'QUOTED_VALUE',
  EOF: 'EOF'
};

const FilterOperator = {
  EQUAL: '=',
  IS_A: 'is-a',
  IS_NOT_A: 'is-not-a',
  DESCENDENT_OF: 'descendent-of',
  REGEX: 'regex',
  IN: 'in',
  NOT_IN: 'not-in',
  GENERALIZES: 'generalizes',
  CHILD_OF: 'child-of',
  DESCENDENT_LEAF: 'descendent-leaf',
  EXISTS: 'exists'
};

class Token {
  constructor(type, value, position) {
    this.type = type;
    this.value = value;
    this.position = position;
  }

  toString() {
    return `${this.type}(${this.value})`;
  }
}

class VCLLexer {
  constructor(input) {
    this.input = input.trim();
    this.pos = 0;
  }

  current() {
    return this.pos < this.input.length ? this.input[this.pos] : '\0';
  }

  peek(offset = 0) {
    const peekPos = this.pos + 1 + offset;
    return peekPos < this.input.length ? this.input[peekPos] : '\0';
  }

  skipWhitespace() {
    while (this.pos < this.input.length && /\s/.test(this.input[this.pos])) {
      this.pos++;
    }
  }

  isIdentifierChar(c) {
    return /[a-zA-Z0-9:?&%+\-.@#$!{}_]/.test(c);
  }

  isUriChar(c) {
    return /[a-zA-Z0-9?&%+\-.@#$!{}_/]/.test(c);
  }

  isCodeChar(c) {
    return /[a-zA-Z0-9\-_]/.test(c);
  }

  isVersionChar(c) {
    return /[a-zA-Z0-9\-_.+]/.test(c);
  }

  readIdentifierChars() {
    let result = '';
    while (this.pos < this.input.length && this.isIdentifierChar(this.input[this.pos])) {
      result += this.input[this.pos];
      this.pos++;
    }
    return result;
  }

  readUriChars() {
    let result = '';
    while (this.pos < this.input.length && this.isUriChar(this.input[this.pos])) {
      result += this.input[this.pos];
      this.pos++;
    }
    return result;
  }

  readCodeChars() {
    let result = '';
    while (this.pos < this.input.length && this.isCodeChar(this.input[this.pos])) {
      result += this.input[this.pos];
      this.pos++;
    }
    return result;
  }

  readVersionChars() {
    let result = '';
    while (this.pos < this.input.length && this.isVersionChar(this.input[this.pos])) {
      result += this.input[this.pos];
      this.pos++;
    }
    return result;
  }

  readQuotedValue(startPos) {
    let value = '';
    this.pos++; // Skip opening quote

    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];
      if (ch === '"') {
        this.pos++;
        return new Token(TokenType.QUOTED_VALUE, value, startPos);
      } else if (ch === '\\' && this.pos + 1 < this.input.length) {
        this.pos++;
        const escaped = this.input[this.pos];
        if (escaped === '"' || escaped === '\\') {
          value += escaped;
        } else {
          value += '\\' + escaped;
        }
        this.pos++;
      } else {
        value += ch;
        this.pos++;
      }
    }

    throw new VCLParseException('Unterminated quoted string', startPos);
  }

  tokenize() {
    const tokens = [];

    while (this.pos < this.input.length) {
      this.skipWhitespace();
      if (this.pos >= this.input.length) break;

      const startPos = this.pos;
      const ch = this.input[this.pos];

      switch (ch) {
        case '-':
          tokens.push(new Token(TokenType.DASH, '-', startPos));
          this.pos++;
          break;
        case '(':
          tokens.push(new Token(TokenType.OPEN, '(', startPos));
          this.pos++;
          break;
        case ')':
          tokens.push(new Token(TokenType.CLOSE, ')', startPos));
          this.pos++;
          break;
        case '{':
          tokens.push(new Token(TokenType.LCRLY, '{', startPos));
          this.pos++;
          break;
        case '}':
          tokens.push(new Token(TokenType.RCRLY, '}', startPos));
          this.pos++;
          break;
        case ';':
          tokens.push(new Token(TokenType.SEMI, ';', startPos));
          this.pos++;
          break;
        case ',':
          tokens.push(new Token(TokenType.COMMA, ',', startPos));
          this.pos++;
          break;
        case '.':
          tokens.push(new Token(TokenType.DOT, '.', startPos));
          this.pos++;
          break;
        case '*':
          tokens.push(new Token(TokenType.STAR, '*', startPos));
          this.pos++;
          break;
        case '=':
          tokens.push(new Token(TokenType.EQ, '=', startPos));
          this.pos++;
          break;
        case '/':
          tokens.push(new Token(TokenType.REGEX, '/', startPos));
          this.pos++;
          break;
        case '^':
          tokens.push(new Token(TokenType.IN, '^', startPos));
          this.pos++;
          break;
        case '>':
          if (this.peek() === '>') {
            tokens.push(new Token(TokenType.GENERALIZES, '>>', startPos));
            this.pos += 2;
          } else {
            throw new VCLParseException(`Unexpected character: ${ch}`, this.pos);
          }
          break;
        case '<':
          if (this.peek() === '<') {
            tokens.push(new Token(TokenType.IS_A, '<<', startPos));
            this.pos += 2;
          } else if (this.peek() === '!') {
            tokens.push(new Token(TokenType.CHILD_OF, '<!', startPos));
            this.pos += 2;
          } else {
            tokens.push(new Token(TokenType.DESC_OF, '<', startPos));
            this.pos++;
          }
          break;
        case '~':
          if (this.peek() === '<' && this.peek(1) === '<') {
            tokens.push(new Token(TokenType.IS_NOT_A, '~<<', startPos));
            this.pos += 3;
          } else if (this.peek() === '^') {
            tokens.push(new Token(TokenType.NOT_IN, '~^', startPos));
            this.pos += 2;
          } else {
            throw new VCLParseException(`Unexpected character: ${ch}`, this.pos);
          }
          break;
        case '!':
          if (this.peek() === '!' && this.peek(1) === '<') {
            tokens.push(new Token(TokenType.DESC_LEAF, '!!<', startPos));
            this.pos += 3;
          } else {
            throw new VCLParseException(`Unexpected character: ${ch}`, this.pos);
          }
          break;
        case '?':
          tokens.push(new Token(TokenType.EXISTS, '?', startPos));
          this.pos++;
          break;
        case '"':
          tokens.push(this.readQuotedValue(startPos));
          break;
        default:
          if (/[a-zA-Z]/.test(ch)) {
            const value = this.readCodeChars();

            if (this.current() === ':') {
              this.pos++;
              // Read rest of URI
              const uriRest = this.readUriChars();
              let fullValue = value + ':' + uriRest;

              // Check for version
              if (this.pos < this.input.length && this.input[this.pos] === '|') {
                this.pos++;
                fullValue += '|' + this.readVersionChars();
              }
              tokens.push(new Token(TokenType.URI, fullValue, startPos));
            } else {
              tokens.push(new Token(TokenType.SCODE, value, startPos));
            }
          } else if (/[0-9]/.test(ch)) {
            const value = this.readCodeChars();
            tokens.push(new Token(TokenType.SCODE, value, startPos));
          } else {
            throw new VCLParseException(`Unexpected character: ${ch}`, this.pos);
          }
      }
    }

    tokens.push(new Token(TokenType.EOF, '', this.pos));
    return tokens;
  }
}

// How deep brackets may nest. The parser recurses once per bracket, so without a bound a hostile
// expression is a RangeError (stack overflow) rather than a parse error. Real VCL nests a few levels.
const MAX_VCL_DEPTH = 100;

class VCLParserClass {
  constructor(tokens, fhirFactory = null) {
    this.tokens = tokens;
    this.pos = 0;
    this.depth = 0;
    this.fhirFactory = fhirFactory;
    this.valueSet = this.createValueSet();
  }

  createValueSet() {
    if (this.fhirFactory && typeof this.fhirFactory.createValueSet === 'function') {
      return this.fhirFactory.createValueSet();
    }

    // Default FHIR ValueSet structure
    return {
      resourceType: 'ValueSet',
      status: 'draft',
      compose: {
        include: [],
        exclude: []
      }
    };
  }

  current() {
    return this.pos < this.tokens.length ? this.tokens[this.pos] : new Token(TokenType.EOF, '', -1);
  }

  peek() {
    return this.pos + 1 < this.tokens.length ? this.tokens[this.pos + 1] : new Token(TokenType.EOF, '', -1);
  }

  consume(expected) {
    const current = this.current();
    if (current.type !== expected) {
      throw new VCLParseException(`Expected ${expected} but got ${current.type}`, current.position);
    }
    this.pos++;
  }

  expect(expected) {
    const current = this.current();
    if (current.type !== expected) {
      throw new VCLParseException(`Expected ${expected} but got ${current.type}`, current.position);
    }
  }

  isFilterOperator(tokenType) {
    return [
      TokenType.EQ, TokenType.IS_A, TokenType.IS_NOT_A, TokenType.DESC_OF,
      TokenType.REGEX, TokenType.IN, TokenType.NOT_IN, TokenType.GENERALIZES,
      TokenType.CHILD_OF, TokenType.DESC_LEAF, TokenType.EXISTS
    ].includes(tokenType);
  }

  tokenTypeToFilterOperator(tokenType) {
    const mapping = {
      [TokenType.EQ]: FilterOperator.EQUAL,
      [TokenType.IS_A]: FilterOperator.IS_A,
      [TokenType.IS_NOT_A]: FilterOperator.IS_NOT_A,
      [TokenType.DESC_OF]: FilterOperator.DESCENDENT_OF,
      [TokenType.REGEX]: FilterOperator.REGEX,
      [TokenType.IN]: FilterOperator.IN,
      [TokenType.NOT_IN]: FilterOperator.NOT_IN,
      [TokenType.GENERALIZES]: FilterOperator.GENERALIZES,
      [TokenType.CHILD_OF]: FilterOperator.CHILD_OF,
      [TokenType.DESC_LEAF]: FilterOperator.DESCENDENT_LEAF,
      [TokenType.EXISTS]: FilterOperator.EXISTS
    };
    return mapping[tokenType];
  }

  isSimpleCodeList() {
    let lookahead = this.pos;

    while (lookahead < this.tokens.length) {
      const token = this.tokens[lookahead];

      if (token.type === TokenType.CLOSE) {
        return true;
      }

      if (token.type === TokenType.OPEN && lookahead + 2 < this.tokens.length) {
        if (this.tokens[lookahead + 1].type === TokenType.URI &&
          this.tokens[lookahead + 2].type === TokenType.CLOSE) {
          lookahead += 3;
          continue;
        }
      }

      if (token.type === TokenType.OPEN || token.type === TokenType.DASH || this.isFilterOperator(token.type)) {
        return false;
      }

      lookahead++;
    }

    return true;
  }

  createConceptSet(systemUri, isExclusion) {
    const conceptSet = {
      system: '',
      concept: [],
      filter: [],
      valueSet: []
    };

    if (systemUri) {
      const pipePos = systemUri.indexOf('|');
      if (pipePos >= 0) {
        conceptSet.system = systemUri.substring(0, pipePos);
        conceptSet.version = systemUri.substring(pipePos + 1);
      } else {
        conceptSet.system = systemUri;
      }
    }

    if (isExclusion) {
      this.valueSet.compose.exclude.push(conceptSet);
    } else {
      this.valueSet.compose.include.push(conceptSet);
    }

    return conceptSet;
  }

  getCurrentConceptSet(isExclusion) {
    const list = isExclusion ? this.valueSet.compose.exclude : this.valueSet.compose.include;
    return list.length > 0 ? list[list.length - 1] : this.createConceptSet('', isExclusion);
  }

  toImplicitVcl(system, expression) {
    return 'http://fhir.org/VCL?v1='
      + encodeURIComponent(`(${system})(${expression})`)
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29'); // need to encode parentheses for VCL as well
  }

  parseExpr() {
    this.parseSubExpr(false);

    switch (this.current().type) {
      case TokenType.COMMA:
        this.parseConjunction();
        break;
      case TokenType.SEMI:
        this.parseDisjunction();
        break;
      case TokenType.DASH:
        this.parseExclusion();
        break;
    }
  }

  parseSubExpr(isExclusion) {
    let systemUri = '';

    // Check for system URI in parentheses
    if (this.current().type === TokenType.OPEN && this.peek().type === TokenType.URI) {
      this.consume(TokenType.OPEN);
      systemUri = this.current().value;
      this.consume(TokenType.URI);
      this.consume(TokenType.CLOSE);
    }

    if (this.current().type === TokenType.OPEN) {
      this.consume(TokenType.OPEN);
      if (++this.depth > MAX_VCL_DEPTH) {
        throw new VCLParseException(`The expression nests more than ${MAX_VCL_DEPTH} levels deep`, this.current().position);
      }

      // Check for nested system URI
      if (this.current().type === TokenType.OPEN && this.peek().type === TokenType.URI) {
        this.consume(TokenType.OPEN);
        systemUri = this.current().value;
        this.consume(TokenType.URI);
        this.consume(TokenType.CLOSE);
      }

      if (this.isSimpleCodeList()) {
        this.parseSimpleCodeList(systemUri, isExclusion);
      } else {
        this.parseExprWithinParentheses(isExclusion);
      }

      // This should fail for unmatched parentheses
      this.consume(TokenType.CLOSE);
      this.depth--;
    } else {
      this.parseSimpleExpr(systemUri, isExclusion);
    }
  }

  parseSimpleCodeList(systemUri, isExclusion) {
    const conceptSet = this.createConceptSet(systemUri, isExclusion);

    if (this.current().type === TokenType.STAR) {
      this.consume(TokenType.STAR);
      conceptSet.filter.push({
        property: 'concept',
        op: FilterOperator.EXISTS,
        value: 'true'
      });
      return;
    } else if (this.current().type === TokenType.IN) {
      this.parseIncludeVs(conceptSet);
      return;
    } else {
      const code = this.parseCode();
      conceptSet.concept.push({code});
    }

    while ([TokenType.SEMI, TokenType.COMMA].includes(this.current().type)) {
      this.consume(this.current().type);

      if (this.current().type === TokenType.STAR) {
        this.consume(TokenType.STAR);
        conceptSet.filter.push({
          property: 'concept',
          op: FilterOperator.EXISTS,
          value: 'true'
        });
      } else if (this.current().type === TokenType.IN) {
        this.parseIncludeVs(conceptSet);
      } else {
        const code = this.parseCode();
        conceptSet.concept.push({code});
      }
    }
  }

  parseSimpleExpr(systemUri, isExclusion) {
    const conceptSet = this.createConceptSet(systemUri, isExclusion);

    if (this.peek().type === TokenType.DOT) {
      this.parseOf(systemUri, conceptSet);
    } else if (this.current().type === TokenType.STAR) {
      this.consume(TokenType.STAR);
      conceptSet.filter.push({
        property: 'concept',
        op: FilterOperator.EXISTS,
        value: 'true'
      });
    } else if ([TokenType.SCODE, TokenType.QUOTED_VALUE].includes(this.current().type)) {
      if (this.current().type === TokenType.SCODE && this.current().value.includes('.')) {
        this.parseOf(systemUri, conceptSet);
      } else {
        const code = this.parseCode();

        if (this.isFilterOperator(this.current().type)) {
          this.parseFilter(conceptSet, code);
        } else {
          conceptSet.concept.push({ code });
        }
      }
    } else if (this.current().type === TokenType.IN) {
      this.parseIncludeVs(conceptSet);
    } else {
      this.parseOf(systemUri, conceptSet);
    }
  }

  parseOf(systemUri, conceptSet) {
    let isVcl = false;
    const sb = [];

    switch (this.current().type) {
      case TokenType.LCRLY: {
        // codeList or filterList
        this.consume(TokenType.LCRLY);
        if (this.peek().type === TokenType.COMMA) {
          sb.push(this.parseCode());
          while (this.current().type === TokenType.COMMA) {
            this.consume(TokenType.COMMA);
            sb.push(this.parseCode());
          }
        } else {
          isVcl = true;
          this.parseFilterList(sb);
        }
        this.consume(TokenType.RCRLY);
        break;
      }
      case TokenType.STAR: {
        sb.push(this.current().value);
        this.consume(TokenType.STAR);
        break;
      }
      case TokenType.URI: {
        sb.push(this.current().value);
        this.consume(TokenType.URI);
        break;
      }
      case TokenType.SCODE:
      case TokenType.QUOTED_VALUE: {
        sb.push(this.current().value);
        this.parseCode();
        break;
      }
      default:
        throw new VCLParseException("Expected code, codeList, STAR, URI or filterList", this.current().position);
    }

    this.consume(TokenType.DOT);

    const property = this.parseCode();
    const implicitVcl = isVcl ? this.toImplicitVcl(systemUri, sb.join(',')) : sb.join(',');

    conceptSet.filter.push({
      property: property,
      op: FilterOperator.EQUAL, // FIXME: Is this really the value to use?
      _op: {
        extension: [{
          // WARNING: pre-adopting an extension that may change in before R6
          url: 'http://hl7.org/fhir/6.0/StructureDefinition/extension-ValueSet.compose.include.filter.op',
          valueString: 'of'
        }]
      },
      value: implicitVcl,
    });
  }

  parseExprWithinParentheses(isExclusion) {
    this.parseSubExpr(isExclusion);

    while ([TokenType.COMMA, TokenType.SEMI, TokenType.DASH].includes(this.current().type)) {
      switch (this.current().type) {
        case TokenType.COMMA:
          this.parseConjunctionWithFlag(isExclusion);
          break;
        case TokenType.SEMI:
          this.parseDisjunctionWithFlag(isExclusion);
          break;
        case TokenType.DASH:
          this.parseExclusion();
          break;
      }
    }
  }

  parseFilter(conceptSet, propertyCode) {
    const op = this.current().type;
    this.consume(op);

    const filter = {
      property: propertyCode,
      op: this.tokenTypeToFilterOperator(op)
    };

    switch (op) {
      case TokenType.EQ:
      case TokenType.IS_A:
      case TokenType.IS_NOT_A:
      case TokenType.DESC_OF:
      case TokenType.GENERALIZES:
      case TokenType.CHILD_OF:
      case TokenType.DESC_LEAF:
      case TokenType.EXISTS:
        filter.value = this.parseCode();
        break;
      case TokenType.REGEX:
        filter.value = this.parseQuotedString();
        break;
      case TokenType.IN:
      case TokenType.NOT_IN:
        filter.value = this.parseFilterValue(conceptSet.system);
        break;
      default:
        throw new VCLParseException(`Unexpected filter operator: ${op}`, this.current().position);
    }

    conceptSet.filter.push(filter);
  }

  parseIncludeVs(conceptSet) {
    this.consume(TokenType.IN);

    let uri;
    if (this.current().type === TokenType.URI) {
      uri = this.current().value;
      this.consume(TokenType.URI);
    } else if (this.current().type === TokenType.OPEN) {
      this.consume(TokenType.OPEN);
      uri = this.current().value;
      this.consume(TokenType.URI);
      this.consume(TokenType.CLOSE);
    } else {
      throw new VCLParseException('Expected URI after ^', this.current().position);
    }

    conceptSet.valueSet.push(uri);
  }

  parseConjunction() {
    const currentConceptSet = this.getCurrentConceptSet(false);

    while (this.current().type === TokenType.COMMA) {
      this.consume(TokenType.COMMA);

      if ([TokenType.SCODE, TokenType.QUOTED_VALUE].includes(this.current().type)) {
        const code = this.parseCode();
        if (this.isFilterOperator(this.current().type)) {
          this.parseFilter(currentConceptSet, code);
        } else {
          currentConceptSet.concept.push({code});
        }
      } else {
        this.parseSubExpr(false);
      }
    }
  }

  parseConjunctionWithFlag(isExclusion) {
    const currentConceptSet = this.getCurrentConceptSet(isExclusion);

    while (this.current().type === TokenType.COMMA) {
      this.consume(TokenType.COMMA);

      if ([TokenType.SCODE, TokenType.QUOTED_VALUE].includes(this.current().type)) {
        const code = this.parseCode();
        if (this.isFilterOperator(this.current().type)) {
          this.parseFilter(currentConceptSet, code);
        } else {
          currentConceptSet.concept.push({code});
        }
      } else {
        this.parseSubExpr(isExclusion);
      }
    }
  }

  parseDisjunction() {
    while (this.current().type === TokenType.SEMI) {
      this.consume(TokenType.SEMI);
      this.parseSubExpr(false);
    }
  }

  parseDisjunctionWithFlag(isExclusion) {
    while (this.current().type === TokenType.SEMI) {
      this.consume(TokenType.SEMI);
      this.parseSubExpr(isExclusion);
    }
  }

  parseExclusion() {
    this.consume(TokenType.DASH);
    this.parseSubExpr(true);
  }

  parseCode() {
    if (this.current().type === TokenType.SCODE) {
      const code = this.current().value;
      this.consume(TokenType.SCODE);
      return code;
    } else if (this.current().type === TokenType.QUOTED_VALUE) {
      const code = this.current().value;
      this.consume(TokenType.QUOTED_VALUE);
      return code;
    } else {
      throw new VCLParseException('Expected code', this.current().position);
    }
  }

  parseQuotedString() {
    if (this.current().type === TokenType.QUOTED_VALUE) {
      const value = this.current().value;
      this.consume(TokenType.QUOTED_VALUE);
      return value;
    } else {
      throw new VCLParseException('Expected quoted string', this.current().position);
    }
  }

  cleanupEmptyArrays(obj) {
    if (Array.isArray(obj)) {
      return obj.map(item => this.cleanupEmptyArrays(item));
    } else if (obj && typeof obj === 'object') {
      const cleaned = {};
      for (const [key, value] of Object.entries(obj)) {
        if (Array.isArray(value)) {
          if (value.length > 0) {
            cleaned[key] = this.cleanupEmptyArrays(value);
          }
        } else if (value && typeof value === 'object') {
          cleaned[key] = this.cleanupEmptyArrays(value);
        } else if (value !== undefined && value !== null && value !== '') {
          cleaned[key] = value;
        }
      }
      return cleaned;
    }
    return obj;
  }

  parseFilterValue(systemUri) {
    if (this.current().type === TokenType.LCRLY) {
      this.consume(TokenType.LCRLY);
      const codes = [this.parseCode()];

      if (this.isFilterOperator(this.current().type)) {
        this.parseFilterList(codes);
        this.consume(TokenType.RCRLY);
        return this.toImplicitVcl(systemUri, codes.join(''));
      } else {
        while (this.current().type === TokenType.COMMA) {
          this.consume(TokenType.COMMA);
          codes.push(this.parseCode());
        }

        this.consume(TokenType.RCRLY);
        return codes.join(',');
      }
    } else if (this.current().type === TokenType.URI) {
      const uri = this.current().value;
      this.consume(TokenType.URI);
      return uri;
    } else {
      return this.parseCode();
    }
  }

  parseFilterList(terms) {
    let depth = 1;
    while (depth > 0) {
      const tokenType = this.current().type;

      switch (tokenType) {
        case TokenType.EOF:
          // current() answers EOF forever once the tokens run out, so without this an
          // unterminated "{" looped here until the terms array overflowed
          throw new VCLParseException("Expected '}' to close the filter list", this.current().position);
        case TokenType.LCRLY:
          depth++;
          break;
        case TokenType.RCRLY:
          depth--;
          break;
        default:
        // do nothing
      }

      if (depth > 0) {
        terms.push(this.current().value);
        this.consume(tokenType);
      }
    }
  }

  parse() {
    try {
      this.parseExpr();
      this.expect(TokenType.EOF);
      return this.cleanupEmptyArrays(this.valueSet);
    } catch (error) {
      // Make sure we're throwing VCLParseException for any parsing error
      if (error instanceof VCLParseException) {
        throw error;
      } else {
        throw new VCLParseException(`Parse error: ${error.message}`);
      }
    }
  }
}

// Main parsing functions
function parseVCL(vclExpression, fhirFactory = null) {
  if (!vclExpression || vclExpression.trim() === '') {
    throw new VCLParseException('VCL expression cannot be empty');
  }

  const lexer = new VCLLexer(vclExpression);
  const tokens = lexer.tokenize();

  const parser = new VCLParserClass(tokens, fhirFactory);
  const result = parser.parse();

  if (!result) {
    throw new VCLParseException('Parser returned null result');
  }

  return result;
}

function parseVCLAndSetId(vclExpression, fhirFactory = null) {
  // Use the same parsing logic as parseVCL to avoid scope issues
  if (!vclExpression || vclExpression.trim() === '') {
    throw new VCLParseException('VCL expression cannot be empty');
  }

  const lexer = new VCLLexer(vclExpression);
  const tokens = lexer.tokenize();
  const parser = new VCLParserClass(tokens, fhirFactory);
  const valueSet = parser.parse();

  if (!valueSet) {
    throw new VCLParseException('Failed to create ValueSet');
  }

  // Generate hash-based ID (similar to Java version)
  const jsonString = JSON.stringify(valueSet);
  if (!jsonString) {
    throw new VCLParseException('Failed to serialize ValueSet to JSON');
  }

  // Create hash directly inline to avoid scoping issues
  let hash = 0;
  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  const hashCode = Math.abs(hash);

  valueSet.url = `cid:${hashCode}`;

  return valueSet;
}

// Utility functions
function validateVCLExpression(vclExpression) {
  if (!vclExpression || vclExpression.trim() === '') {
    return false;
  }

  try {
    // Make sure we call the same parseVCL function that's being exported
    const lexer = new VCLLexer(vclExpression);
    const tokens = lexer.tokenize();
    const parser = new VCLParserClass(tokens, null);
    parser.parse();
    return true;
  } catch (e) {
    // Return false for any parsing error, regardless of type
    return false;
  }
}

function createVCLValueSet(id, name, description) {
  const valueSet = {
    resourceType: 'ValueSet',
    status: 'draft',
    experimental: true,
    compose: {
      include: [],
      exclude: []
    }
  };

  if (id) valueSet.id = id;
  if (name) valueSet.name = name;
  if (description) valueSet.description = description;

  return valueSet;
}

function splitSystemUri(systemUri) {
  const pipePos = systemUri.indexOf('|');
  if (pipePos >= 0) {
    return {
      system: systemUri.substring(0, pipePos),
      version: systemUri.substring(pipePos + 1)
    };
  }
  return {
    system: systemUri,
    version: ''
  };
}

function isVCLCompatible(valueSet) {
  if (!valueSet.compose) {
    return false;
  }

  const supportedOps = [
    FilterOperator.EQUAL, FilterOperator.IS_A, FilterOperator.IS_NOT_A,
    FilterOperator.DESCENDENT_OF, FilterOperator.REGEX, FilterOperator.IN,
    FilterOperator.NOT_IN, FilterOperator.GENERALIZES, FilterOperator.CHILD_OF,
    FilterOperator.DESCENDENT_LEAF, FilterOperator.EXISTS
  ];

  // Check includes
  if (valueSet.compose.include) {
    for (const include of valueSet.compose.include) {
      if (include.filter) {
        for (const filter of include.filter) {
          if (!supportedOps.includes(filter.op)) {
            return false;
          }
        }
      }
    }
  }

  // Check excludes
  if (valueSet.compose.exclude) {
    for (const exclude of valueSet.compose.exclude) {
      if (exclude.filter) {
        for (const filter of exclude.filter) {
          if (!supportedOps.includes(filter.op)) {
            return false;
          }
        }
      }
    }
  }

  return true;
}

// Simple hash function for generating IDs
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

// Export for different module systems
if (typeof module !== 'undefined' && module.exports) {
  // Node.js
  module.exports = {
    parseVCL,
    parseVCLAndSetId,
    validateVCLExpression,
    createVCLValueSet,
    splitSystemUri,
    isVCLCompatible,
    VCLParseException,
    MAX_VCL_DEPTH,
    TokenType,
    FilterOperator,
    // Export classes for debugging
    VCLLexer,
    VCLParserClass,
    // Export utility functions
    simpleHash
  };
} else if (typeof window !== 'undefined') {
  // Browser - attach everything to window.VCLParser
  window.VCLParser = {
    parseVCL,
    parseVCLAndSetId,
    validateVCLExpression,
    createVCLValueSet,
    splitSystemUri,
    isVCLCompatible,
    VCLParseException,
    MAX_VCL_DEPTH,
    TokenType,
    FilterOperator,
    // Export classes for debugging
    VCLLexer,
    VCLParserClass,
    // Export utility functions
    simpleHash
  };

  // Also make classes available globally for debugging
  window.VCLLexer = VCLLexer;
  window.VCLParseException = VCLParseException;
}

// Examples of usage:
/*
// Basic parsing
const valueSet = parseVCL('(http://snomed.info/sct) 123456789; 987654321');

// With filters
const valueSet2 = parseVCL('(http://snomed.info/sct) 123456789 << 64572001');

// With version and exclusions
const valueSet3 = parseVCL('(http://snomed-alike.info/sct|20210131) * - 123456789');

// With auto-generated ID
const valueSet4 = parseVCLAndSetId('(http://snomed.info/sct) 123456789');

// Validation
if (validateVCLExpression(myExpression)) {
  const valueSet = parseVCL(myExpression);
}

// With custom FHIR factory
const customFactory = {
  createValueSet: () => ({
    resourceType: 'ValueSet',
    status: 'active', // Different default
    compose: { include: [], exclude: [] }
  })
};
const valueSet5 = parseVCL('(http://snomed.info/sct) 123456789', customFactory);
*/