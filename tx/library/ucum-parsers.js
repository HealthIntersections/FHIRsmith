/**
 * UCUM Parsers - JavaScript port of UCUM Java library parsers
 * BSD 3-Clause License
 * Copyright (c) 2006+, Health Intersections Pty Ltd
 */

const {XMLParser} = require('fast-xml-parser');
const {
  ConceptKind, Operator, TokenType, UcumException, Decimal, Utilities,
  BaseUnit, DefinedUnit, Prefix, Value, Term, Symbol, Factor, Canonical, CanonicalUnit,
  Registry
} = require('./ucum-types.js');
const regexUtilities = require("../../library/regex-utilities");

// Lexer for tokenizing UCUM expressions (port of Lexer.java)
class Lexer {
  static NO_CHAR = '\0';

  constructor(source) {
    if (typeof source !== 'string') {
      throw new Error("not a string");
    }
    this.source = source || '';
    this.index = 0;
    this.token = null;
    this.type = TokenType.NONE;
    this.start = 0;

    this.consume();
  }

  consume() {
    this.token = null;
    this.type = TokenType.NONE;
    this.start = this.index;

    if (this.index < this.source.length) {
      const ch = this._nextChar();

      if (!(this._checkSingle(ch, '/', TokenType.SOLIDUS) ||
        this._checkSingle(ch, '.', TokenType.PERIOD) ||
        this._checkSingle(ch, '(', TokenType.OPEN) ||
        this._checkSingle(ch, ')', TokenType.CLOSE) ||
        this._checkAnnotation(ch) ||
        this._checkNumber(ch) ||
        this._checkNumberOrSymbol(ch))) {
        throw new UcumException(`Error processing unit '${this.source}': unexpected character '${ch}' at character ${this.start+1}`);
      }
    }
  }

  _checkNumber(ch) {
    if (ch === '+' || ch === '-') {
      this.token = ch;
      let nextCh = this._peekChar();

      while (nextCh >= '0' && nextCh <= '9') {
        this.token += nextCh;
        this.index++;
        nextCh = this._peekChar();
      }

      if (this.token.length === 1) {
        throw new UcumException(`Error processing unit '${this.source}': unexpected character '${ch}' at character ${this.start+1}: a + or - must be followed by at least one digit`);
      }

      this.type = TokenType.NUMBER;
      return true;
    }
    return false;
  }

  _checkNumberOrSymbol(ch) {
    let isSymbol = false;
    let inBrackets = false;

    if (this._isValidSymbolChar(ch, true, false)) {
      this.token = ch;
      isSymbol = isSymbol || !(ch >= '0' && ch <= '9');
      inBrackets = this._checkBrackets(ch, inBrackets);

      let nextCh = this._peekChar();
      inBrackets = this._checkBrackets(nextCh, inBrackets);

      while (this._isValidSymbolChar(nextCh, !isSymbol || inBrackets, inBrackets)) {
        this.token += nextCh;
        isSymbol = isSymbol || (nextCh !== Lexer.NO_CHAR && !(nextCh >= '0' && nextCh <= '9'));
        this.index++;
        nextCh = this._peekChar();
        inBrackets = this._checkBrackets(nextCh, inBrackets);
      }

      this.type = isSymbol ? TokenType.SYMBOL : TokenType.NUMBER;
      return true;
    }
    return false;
  }

  _checkBrackets(ch, inBrackets) {
    if (ch === '[') {
      if (inBrackets) {
        this.error('Nested [');
      }
      return true;
    }
    if (ch === ']') {
      if (!inBrackets) {
        this.error('] without [');
      }
      return false;
    }
    return inBrackets;
  }

  _isValidSymbolChar(ch, allowDigits, inBrackets) {
    return (allowDigits && ch >= '0' && ch <= '9') ||
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      ch === '[' || ch === ']' || ch === '%' || ch === '*' ||
      ch === '^' || ch === "'" || ch === '"' || ch === '_' ||
      (inBrackets && ch === '.');
  }

  _checkAnnotation(ch) {
    if (ch === '{') {
      const b = [];
      let nextCh = this._nextChar();

      while (nextCh !== '}') {
        if (!Utilities.isAsciiChar(nextCh)) {
          throw new UcumException(`Error processing unit '${this.source}': Annotation contains non-ascii characters`);
        }
        if (nextCh === Lexer.NO_CHAR) {
          throw new UcumException(`Error processing unit '${this.source}': unterminated annotation`);
        }
        b.push(nextCh);
        nextCh = this._nextChar();
      }

      this.token = b.join('');
      this.type = TokenType.ANNOTATION;
      return true;
    }
    return false;
  }

  _checkSingle(ch, test, type) {
    if (ch === test) {
      this.token = ch;
      this.type = type;
      return true;
    }
    return false;
  }

  _nextChar() {
    const res = this.index < this.source.length ? this.source.charAt(this.index) : Lexer.NO_CHAR;
    this.index++;
    return res;
  }

  _peekChar() {
    return this.index < this.source.length ? this.source.charAt(this.index) : Lexer.NO_CHAR;
  }

  getToken() {
    return this.token;
  }

  getType() {
    return this.type;
  }

  error(errMsg) {
    throw new UcumException(`Error processing unit '${this.source}': ${errMsg} at character ${this.start+1}`);
  }

  getTokenAsInt() {
    return this.token.charAt(0) === '+' ? parseInt(this.token.substring(1)) : parseInt(this.token);
  }

  finished() {
    return this.index === this.source.length;
  }
}

// Expression parser for UCUM unit expressions (port of ExpressionParser.java)
// A UCUM expression parses into a chain of Terms, one level per operator and per bracket, and
// the parser and every walker of the result recurse along that chain. Bound it so that a hostile
// unit is a clean error rather than a RangeError (stack overflow). Real units have a few terms.
const MAX_UCUM_TERMS = 100;

class ExpressionParser {
  constructor(model) {
    this.model = model;
  }

  parse(code) {
    const lexer = new Lexer(code);
    this.terms = 0;
    const res = this._parseTerm(lexer, true);

    if (!lexer.finished()) {
      throw new UcumException('Expression was not parsed completely. Syntax Error?');
    }

    return res;
  }

  _parseTerm(lexer, first) {
    if (++this.terms > MAX_UCUM_TERMS) {
      lexer.error(`The unit has more than ${MAX_UCUM_TERMS} terms and brackets`);
    }
    const res = new Term();

    if (first && lexer.getType() === TokenType.NONE) {
      res.comp = new Factor(1);
    } else if (lexer.getType() === TokenType.SOLIDUS) {
      res.op = Operator.DIVISION;
      lexer.consume();
      res.term = this._parseTerm(lexer, false);
    } else {
      if (lexer.getType() === TokenType.ANNOTATION) {
        res.comp = new Factor(1); // still lose the annotation
        lexer.consume();
      } else {
        res.comp = this._parseComp(lexer);
      }

      if (lexer.getType() !== TokenType.NONE && lexer.getType() !== TokenType.CLOSE) {
        if (lexer.getType() === TokenType.SOLIDUS) {
          res.op = Operator.DIVISION;
          lexer.consume();
        } else if (lexer.getType() === TokenType.PERIOD) {
          res.op = Operator.MULTIPLICATION;
          lexer.consume();
        } else if (lexer.getType() === TokenType.ANNOTATION) {
          res.op = Operator.MULTIPLICATION; // implicit
        } else {
          lexer.error("Expected '/' or '.'");
        }
        res.term = this._parseTerm(lexer, false);
      }
    }

    return res;
  }

  _parseComp(lexer) {
    if (lexer.getType() === TokenType.NUMBER) {
      const fact = new Factor(lexer.getTokenAsInt());
      lexer.consume();
      return fact;
    } else if (lexer.getType() === TokenType.SYMBOL) {
      return this._parseSymbol(lexer);
    } else if (lexer.getType() === TokenType.NONE) {
      lexer.error('unexpected end of expression looking for a symbol or a number');
    } else if (lexer.getType() === TokenType.OPEN) {
      lexer.consume();
      const res = this._parseTerm(lexer, true);
      if (lexer.getType() === TokenType.CLOSE) {
        lexer.consume();
      } else {
        lexer.error(`Unexpected Token Type '${lexer.getType()}' looking for a close bracket`);
      }
      return res;
    } else {
      lexer.error('unexpected token looking for a symbol or a number');
    }
    return null; // we never get to here
  }

  _parseSymbol(lexer) {
    const symbol = new Symbol();
    const sym = lexer.getToken();

    // now, can we pick a prefix that leaves behind a metric unit?
    let selected = null;
    let unit = null;

    for (const prefix of this.model.getPrefixes()) {
      if (sym.startsWith(prefix.code)) {
        unit = this.model.getUnit(sym.substring(prefix.code.length));
        if (unit != null && (unit.kind === ConceptKind.BASEUNIT || unit.metric)) {
          selected = prefix;
          break;
        }
      }
    }

    if (selected !== null) {
      symbol.prefix = selected;
      symbol.unit = unit;
    } else {
      unit = this.model.getUnit(sym);
      if (unit != null) {
        symbol.unit = unit;
      } else if (sym !== '1') {
        lexer.error(`The unit '${sym}' is unknown`);
      }
    }

    lexer.consume();
    if (lexer.getType() === TokenType.NUMBER) {
      symbol.exponent = lexer.getTokenAsInt();
      lexer.consume();
    } else {
      symbol.exponent = 1;
    }

    return symbol;
  }
}

// Expression composer for creating string representations (port of ExpressionComposer.java)
class ExpressionComposer {
  compose(termOrCanonical, includeValue = true) {
    if (termOrCanonical === null || termOrCanonical === undefined) {
      return '1';
    }

    // Handle Canonical objects
    if (termOrCanonical instanceof Canonical) {
      return this.composeCanonical(termOrCanonical, includeValue);
    }

    // Handle Term objects
    const bldr = [];
    this._composeTerm(bldr, termOrCanonical);
    return bldr.join('');
  }

  composeCanonical(can, includeValue = true) {
    const b = [];
    if (includeValue) {
      b.push(can.value.toString());
    }

    let first = true;
    for (const c of can.units) {
      if (first) {
        first = false;
      } else {
        b.push('.');
      }
      b.push(c.base.code);
      if (c.exponent !== 1) {
        b.push(c.exponent.toString());
      }
    }
    return b.join('');
  }

  _composeTerm(bldr, term) {
    if (term.comp !== null) {
      this._composeComp(bldr, term.comp);
    }
    if (term.op !== null) {
      this._composeOp(bldr, term.op);
    }
    if (term.term !== null) {
      this._composeTerm(bldr, term.term);
    }
  }

  _composeComp(bldr, comp) {
    if (comp instanceof Factor) {
      this._composeFactor(bldr, comp);
    } else if (comp instanceof Symbol) {
      this._composeSymbol(bldr, comp);
    } else if (comp instanceof Term) {
      bldr.push('(');
      this._composeTerm(bldr, comp);
      bldr.push(')');
    } else {
      bldr.push('?');
    }
  }

  _composeSymbol(bldr, symbol) {
    if (symbol.prefix !== null) {
      bldr.push(symbol.prefix.code);
    }
    bldr.push(symbol.unit.code);
    if (symbol.exponent !== 1) {
      bldr.push(symbol.exponent.toString());
    }
  }

  _composeFactor(bldr, comp) {
    bldr.push(comp.value.toString());
  }

  _composeOp(bldr, op) {
    if (op === Operator.DIVISION) {
      bldr.push('/');
    } else {
      bldr.push('.');
    }
  }
}

// Formal structure composer for human-readable representations (port of FormalStructureComposer.java)
class FormalStructureComposer {
  compose(term) {
    const bldr = [];
    this._composeTerm(bldr, term);
    return bldr.join('');
  }

  _composeTerm(bldr, term) {
    if (term.comp !== null) {
      this._composeComp(bldr, term.comp);
    }
    if (term.op !== null) {
      this._composeOp(bldr, term.op);
    }
    if (term.term !== null) {
      this._composeTerm(bldr, term.term);
    }
  }

  _composeComp(bldr, comp) {
    if (comp instanceof Factor) {
      this._composeFactor(bldr, comp);
    } else if (comp instanceof Symbol) {
      this._composeSymbol(bldr, comp);
    } else if (comp instanceof Term) {
      this._composeTerm(bldr, comp);
    } else {
      bldr.push('?');
    }
  }

  _composeSymbol(bldr, symbol) {
    bldr.push('(');
    if (symbol.prefix !== null) {
      bldr.push(symbol.prefix.names[0]);
    }
    bldr.push(symbol.unit.names[0]);
    if (symbol.exponent !== 1) {
      bldr.push(' ^ ');
      bldr.push(symbol.exponent.toString());
    }
    bldr.push(')');
  }

  _composeFactor(bldr, comp) {
    bldr.push(comp.value.toString());
  }

  _composeOp(bldr, op) {
    if (op === Operator.DIVISION) {
      bldr.push(' / ');
    } else {
      bldr.push(' * ');
    }
  }
}

// UCUM model for storing all units, prefixes, etc.
class UcumModel {
  constructor(version = null, revision = null, revisionDate = null) {
    this.version = version;
    this.revision = revision;
    this.revisionDate = revisionDate;
    this.prefixes = [];
    this.baseUnits = [];
    this.definedUnits = [];
    this.unitsMap = new Map(); // For quick lookup by code
  }

  addPrefix(prefix) {
    this.prefixes.push(prefix);
  }

  addBaseUnit(unit) {
    this.baseUnits.push(unit);
    this.unitsMap.set(unit.code, unit);
    if (unit.codeUC !== unit.code) {
      this.unitsMap.set(unit.codeUC, unit);
    }
  }

  addDefinedUnit(unit) {
    this.definedUnits.push(unit);
    this.unitsMap.set(unit.code, unit);
  }

  getUnit(code) {
    return this.unitsMap.get(code);
  }

  getPrefixes() {
    return this.prefixes;
  }

  getBaseUnits() {
    return this.baseUnits;
  }

  getDefinedUnits() {
    return this.definedUnits;
  }

  getAllUnits() {
    return [...this.baseUnits, ...this.definedUnits];
  }
}

// Parser for UCUM essence XML format using fast-xml-parser
class UcumEssenceParser {
  constructor() {
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      textNodeName: '#text',
      parseAttributeValue: false,
      parseTagValue: false,
      trimValues: true,
      parseTrueNumberOnly: false,
      arrayMode: false,
      alwaysCreateTextNode: true
    });
  }

  parse(xmlContent) {
    let parsedXml;
    try {
      parsedXml = this.parser.parse(xmlContent);
    } catch (e) {
      e.message = `Invalid XML content: ${e.message}`;
      throw e;
    }

    const root = parsedXml.root;
    if (!root) {
      throw new UcumException("Unable to process XML document: expected 'root' element not found");
    }

    // Parse revision date
    let date = null;
    if (root['@_revision-date']) {
      const dt = root['@_revision-date'];
      if (dt.length > 25) {
        // old format: $Date: 2017-11-21 19:04:52 -0500"
        const dateStr = dt.substring(7, 32);
        date = new Date(dateStr);
      } else {
        date = new Date(dt);
      }
    }

    const model = new UcumModel(
      root['@_version'],
      root['@_revision'],
      date
    );

    // Parse prefixes
    if (root.prefix) {
      const prefixes = Array.isArray(root.prefix) ? root.prefix : [root.prefix];
      for (const prefixData of prefixes) {
        model.addPrefix(this._parsePrefix(prefixData));
      }
    }

    // Parse base units
    if (root['base-unit']) {
      const baseUnits = Array.isArray(root['base-unit']) ? root['base-unit'] : [root['base-unit']];
      for (const unitData of baseUnits) {
        model.addBaseUnit(this._parseBaseUnit(unitData));
      }
    }

    // Parse defined units
    if (root.unit) {
      const units = Array.isArray(root.unit) ? root.unit : [root.unit];
      for (const unitData of units) {
        model.addDefinedUnit(this._parseUnit(unitData));
      }
    }

    return model;
  }

  _parseUnit(x) {
    const unit = new DefinedUnit(x['@_Code'], x['@_CODE']);
    unit.metric = x['@_isMetric'] === 'yes';
    unit.isSpecial = x['@_isSpecial'] === 'yes';
    unit.class_ = x['@_class'];

    // Parse names
    if (x.name) {
      const names = Array.isArray(x.name) ? x.name : [x.name];
      for (const nameData of names) {
        const nameText = typeof nameData === 'string' ? nameData : nameData['#text'];
        if (nameText) {
          unit.names.push(nameText);
        }
      }
    }

    // Parse print symbol
    if (x.printSymbol) {
      unit.printSymbol = typeof x.printSymbol === 'string' ? x.printSymbol : x.printSymbol['#text'];
    }

    // Parse property
    if (x.property) {
      unit.property = typeof x.property === 'string' ? x.property : x.property['#text'];
    }

    // Parse value
    if (x.value) {
      unit.value = this._parseValue(x.value, `unit ${unit.code}`);
    }


    return unit;
  }

  _parseValue(x, context) {
    let val = null;
    const valueAttr = x['@_value'];
    if (valueAttr !== null && valueAttr !== undefined && valueAttr) {
      try {
        if (valueAttr.includes("."))
          val = new Decimal(valueAttr, 24); // unlimited precision for these
        else
          val = new Decimal(valueAttr);
      } catch (e) {
        e.message = "Error reading "+context+": "+e.message;
        throw e;
      }
    }
    const value = new Value(
      x['@_Unit'] || '',
      x['@_UNIT'] || '',
      val
    );
    value.text = typeof x === 'string' ? x : x['#text'] || '';
    return value;
  }

  _parseBaseUnit(x) {
    const base = new BaseUnit(x['@_Code'], x['@_CODE']);
    const dimAttr = x['@_dim'];
    if (dimAttr) {
      base.dim = String(dimAttr).charAt(0);
    }

    // Parse names
    if (x.name) {
      const names = Array.isArray(x.name) ? x.name : [x.name];
      for (const nameData of names) {
        const nameText = typeof nameData === 'string' ? nameData : nameData['#text'];
        if (nameText) {
          base.names.push(nameText);
        }
      }
    }

    // Parse print symbol
    if (x.printSymbol) {
      base.printSymbol = typeof x.printSymbol === 'string' ? x.printSymbol : x.printSymbol['#text'];
    }

    // Parse property
    if (x.property) {
      base.property = typeof x.property === 'string' ? x.property : x.property['#text'];
    }

    return base;
  }

  _parsePrefix(x) {
    const prefix = new Prefix(x['@_Code'], x['@_CODE']);

    // Parse names
    if (x.name) {
      const names = Array.isArray(x.name) ? x.name : [x.name];
      for (const nameData of names) {
        const nameText = typeof nameData === 'string' ? nameData : nameData['#text'];
        if (nameText) {
          prefix.names.push(nameText);
        }
      }
    }

    // Parse print symbol
    if (x.printSymbol) {
      prefix.printSymbol = typeof x.printSymbol === 'string' ? x.printSymbol : x.printSymbol['#text'];
    }

    // Parse value
    if (x.value && x.value['@_value']) {
      try {
        const valueStr = String(x.value['@_value']);
        // Handle scientific notation by converting to regular decimal first
        if (valueStr.includes('e') || valueStr.includes('E')) {
          const numValue = parseFloat(valueStr);
          if (isNaN(numValue)) {
            throw new Error(`Invalid numeric value: ${valueStr}`);
          }
          prefix.value = new Decimal(numValue.toString(), 24);
        } else {
          prefix.value = new Decimal(valueStr, 24);
        }
      } catch (e) {
        e.message = `Error parsing prefix '${prefix.code}' value '${x.value['@_value']}': ${e.message}`;
        throw e;
      }
    }

    return prefix;
  }
}

// Search functionality for finding concepts
class Search {
  doSearch(model, kind = null, text = '', isRegex = false) {
    const concepts = [];

    if (!kind || kind === ConceptKind.PREFIX) {
      this._searchPrefixes(concepts, model.getPrefixes(), text, isRegex);
    }
    if (!kind || kind === ConceptKind.BASEUNIT) {
      this._searchUnits(concepts, model.getBaseUnits(), text, isRegex);
    }
    if (!kind || kind === ConceptKind.UNIT) {
      this._searchUnits(concepts, model.getDefinedUnits(), text, isRegex);
    }

    return concepts;
  }

  _searchUnits(concepts, units, text, isRegex) {
    for (const unit of units) {
      if (this._matchesUnit(unit, text, isRegex)) {
        concepts.push(unit);
      }
    }
  }

  _matchesUnit(unit, text, isRegex) {
    return this._matches(unit.property, text, isRegex) ||
      this._matchesConcept(unit, text, isRegex);
  }

  _searchPrefixes(concepts, prefixes, text, isRegex) {
    for (const concept of prefixes) {
      if (this._matchesConcept(concept, text, isRegex)) {
        concepts.push(concept);
      }
    }
  }

  _matchesConcept(concept, text, isRegex) {
    for (const name of concept.names) {
      if (this._matches(name, text, isRegex)) {
        return true;
      }
    }

    return this._matches(concept.code, text, isRegex) ||
      this._matches(concept.codeUC, text, isRegex) ||
      this._matches(concept.printSymbol, text, isRegex);
  }

  _matches(value, text, isRegex) {
    if (!value) return false;

    if (isRegex) {
      try {
        const regex = regexUtilities.compile(text);
        return regex.test(value);
      } catch (e) {
        this.log.error(e);
        return false;
      }
    } else {
      return value.toLowerCase().includes(text.toLowerCase());
    }
  }
}

// Converter for converting terms to canonical form (port of Converter.java)
class Converter {
  constructor(model, handlers) {
    this.model = model;
    this.handlers = handlers || new Registry();
  }

  convert(term) {
    return this._normalise("  ", term);
  }

  _normalise(indent, term) {
    const result = new Canonical(new Decimal("1.000000000000000000000000000000"));

    this._debug(indent, "canonicalise", term);
    let div = false;
    let t = term;

    while (t != null) {
      if (t.comp instanceof Term) {
        const temp = this._normalise(indent + "  ", t.comp);
        if (div) {
          result.divideValue(temp.getValue());
          for (const c of temp.getUnits()) {
            c.setExponent(0 - c.getExponent());
          }
        } else {
          result.multiplyValue(temp.getValue());
        }
        result.getUnits().push(...temp.getUnits());
      } else if (t.comp instanceof Factor) {
        if (div) {
          result.divideValue(t.comp.value);
        } else {
          result.multiplyValue(t.comp.value);
        }
      } else if (t.comp instanceof Symbol) {
        this._debug(indent, "comp", t.comp.unit);
        const temp = this._normaliseSymbol(indent, t.comp);
        if (div) {
          result.divideValue(temp.getValue());
          for (const c of temp.getUnits()) {
            c.setExponent(0 - c.getExponent());
          }
        } else {
          result.multiplyValue(temp.getValue());
        }
        result.getUnits().push(...temp.getUnits());
      }
      div = t.op === Operator.DIVISION;
      t = t.term;
    }

    this._debug(indent, "collate", result);

    // Collate units of the same base
    for (let i = result.getUnits().length - 1; i >= 0; i--) {
      const sf = result.getUnits()[i];
      for (let j = i - 1; j >= 0; j--) {
        const st = result.getUnits()[j];
        if (st.getBase() === sf.getBase()) {
          st.setExponent(sf.getExponent() + st.getExponent());
          result.getUnits().splice(i, 1);
          break;
        }
      }
    }

    // Remove units with 0 exponent
    for (let i = result.getUnits().length - 1; i >= 0; i--) {
      const sf = result.getUnits()[i];
      if (sf.getExponent() === 0) {
        result.getUnits().splice(i, 1);
      }
    }

    this._debug(indent, "sort", result);

    // Sort units by base code
    result.getUnits().sort((lhs, rhs) => {
      return lhs.getBase().code.localeCompare(rhs.getBase().code);
    });

    this._debug(indent, "done", result);
    return result;
  }

  _normaliseSymbol(indent, sym) {
    const result = new Canonical(new Decimal("1.000000000000000000000000000000"));

    if (sym.unit instanceof BaseUnit) {
      result.getUnits().push(new CanonicalUnit(sym.unit, sym.exponent));
    } else {
      const can = this._expandDefinedUnit(indent, sym.unit);
      for (const c of can.getUnits()) {
        c.setExponent(c.getExponent() * sym.exponent);
      }
      result.getUnits().push(...can.getUnits());

      if (sym.exponent > 0) {
        for (let i = 0; i < sym.exponent; i++) {
          result.multiplyValue(can.getValue());
        }
      } else {
        for (let i = 0; i > sym.exponent; i--) {
          result.divideValue(can.getValue());
        }
      }
    }

    if (sym.prefix != null) {
      if (sym.exponent > 0) {
        for (let i = 0; i < sym.exponent; i++) {
          result.multiplyValue(sym.prefix.value);
        }
      } else {
        for (let i = 0; i > sym.exponent; i--) {
          result.divideValue(sym.prefix.value);
        }
      }
    }
    return result;
  }

  _expandDefinedUnit(indent, unit) {
    let u = unit.value.unit;
    let v = unit.value.value;

    if (unit.isSpecial) {
      if (!this.handlers.exists(unit.code)) {
        throw new UcumException("Not handled yet (special unit)");
      } else {
        const handler = this.handlers.get(unit.code);
        u = handler.getUnits();
        v = handler.getValue();
        if (handler.hasOffset()) {
          throw new UcumException("Not handled yet (special unit with offset from 0 at intersect)");
        }
      }
    }

    const t = new ExpressionParser(this.model).parse(u);
    this._debug(indent, "now handle", t);
    const result = this._normalise(indent + "  ", t);
    result.multiplyValue(v);
    return result;
  }

  // eslint-disable-next-line no-unused-vars
  _debug(indent, state, unit) {
    // Debug output - can be enabled for debugging
    // if (unit instanceof DefinedUnit) {
    //   console.log(indent + state + ": " +unit.code+"="+unit.value.value+" "+unit.value.unit);
    // } else if (unit instanceof Unit) {
    //   console.log(indent + state + ": " +unit.code);
    // } else {
    //   console.log(indent + state + ": " + new ExpressionComposer().compose(unit));
    // }
  }
}

// UCUM Validator for validating the model (port of UcumValidator.java)
class UcumValidator {
  constructor(model, handlers) {
    this.model = model;
    this.handlers = handlers || new Registry();
    this.result = [];
  }

  validate() {
    this.result = [];
    this._checkCodes();
    this._checkUnits();
    return this.result;
  }

  _checkCodes() {
    for (const unit of this.model.getBaseUnits()) {
      this._checkUnitCode(unit.code, true);
    }
    for (const unit of this.model.getDefinedUnits()) {
      this._checkUnitCode(unit.code, true);
    }
  }

  _checkUnits() {
    for (const unit of this.model.getDefinedUnits()) {
      if (!unit.isSpecial) {
        this._checkUnitCode(unit.value.unit, false);
      } else if (!this.handlers.exists(unit.code)) {
        this.result.push(`No Handler for ${unit.code}`);
      }
    }
  }

  _checkUnitCode(code, primary) {
    try {
      const term = new ExpressionParser(this.model).parse(code);
      const c = new ExpressionComposer().compose(term);
      if (c !== code) {
        this.result.push(`Round trip failed: ${code} -> ${c}`);
      }
      new Converter(this.model, this.handlers).convert(term);
    } catch (e) {
      this.result.push(`${code}: ${e.message}`);
    }

    if (primary) {
      try {
        // Check that codes don't have ambiguous digits outside brackets
        let inBrack = false;
        let nonDigits = false;
        for (let i = 0; i < code.length; i++) {
          const ch = code.charAt(i);
          if (ch === '[') {
            if (inBrack) {
              throw new Error("nested [");
            } else {
              inBrack = true;
            }
          }
          if (ch === ']') {
            if (!inBrack) {
              throw new Error("] without [");
            } else {
              inBrack = false;
            }
          }
          nonDigits = nonDigits || !(ch >= '0' && ch <= '9');
          if (ch >= '0' && ch <= '9' && !inBrack && nonDigits) {
            throw new Error(`code ${code} is ambiguous because it has digits outside []`);
          }
        }
      } catch (e) {
        this.log.error(e);
        this.result.push(e.message);
      }
    }
  }
}

module.exports = {
  Lexer,
  ExpressionParser,
  ExpressionComposer,
  FormalStructureComposer,
  UcumModel,
  UcumEssenceParser,
  Search,
  Converter,
  UcumValidator,
  MAX_UCUM_TERMS
};