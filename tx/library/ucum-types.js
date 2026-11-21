/**
 * UCUM Types - Core data structures and types for UCUM library
 * BSD 3-Clause License
 * Copyright (c) 2006+, Health Intersections Pty Ltd
 */

class Decimal {
  constructor(value, precision = null) {
    this.precision = 0;
    this.scientific = false;
    this.negative = false;
    this.digits = '';
    this.decimal = 0;

    if (typeof value === 'number') {
      this._setValueDecimal(value.toString());
    } else if (typeof value === 'string') {
      const lowerValue = value.toLowerCase();
      if (lowerValue.includes('e')) {
        this._setValueScientific(lowerValue);
      } else {
        this._setValueDecimal(lowerValue);
      }
      if (precision !== null) {
        this.precision = precision;
      }
    } else if (typeof value === 'undefined' || value === null) {
      // Default constructor for internal use
    } else {
      throw new UcumException(`Invalid decimal value: ${value}`);
    }
  }

  _setValueDecimal(value) {
    this.scientific = false;
    let dec = -1;
    this.negative = value.startsWith('-');
    if (this.negative) {
      value = value.substring(1);
    }

    // Remove leading zeros
    while (value.startsWith('0') && value.length > 1) {
      value = value.substring(1);
    }

    // Find decimal point and validate
    for (let i = 0; i < value.length; i++) {
      if (value.charAt(i) === '.' && dec === -1) {
        dec = i;
      } else if (!/\d/.test(value.charAt(i))) {
        throw new UcumException(`'${value}' is not a valid decimal`);
      }
    }

    if (dec === -1) {
      this.precision = value.length;
      this.decimal = value.length;
      this.digits = value;
    } else if (dec === value.length - 1) {
      throw new UcumException(`'${value}' is not a valid decimal`);
    } else {
      this.decimal = dec;
      if (this._allZeros(value, 1)) {
        this.precision = value.length - 1;
      } else {
        this.precision = this._countSignificants(value);
      }
      this.digits = this._delete(value, this.decimal, 1);
      if (this._allZeros(this.digits, 0)) {
        this.precision++;
      } else {
        while (this.digits.charAt(0) === '0') {
          this.digits = this.digits.substring(1);
          this.decimal--;
        }
      }
    }
  }

  _setValueScientific(value) {
    const eIndex = value.indexOf('e');
    const s = value.substring(0, eIndex);
    let e = value.substring(eIndex + 1);
    if (e.startsWith('+')) {
      e = e.substring(1);
    }

    if (!s || s === '-' || !this._isDecimal(s)) {
      throw new UcumException(`'${value}' is not a valid decimal (numeric)`);
    }
    if (!e || e === '-' || !this._isInteger(e)) {
      throw new UcumException(`'${value}' is not a valid decimal (exponent)`);
    }

    this._setValueDecimal(s);
    this.scientific = true;

    // Adjust for exponent
    const exponent = parseInt(e);
    this.decimal = this.decimal + exponent;
  }

  _allZeros(s, start) {
    for (let i = start; i < s.length; i++) {
      if (s.charAt(i) !== '0') {
        return false;
      }
    }
    return true;
  }

  _countSignificants(value) {
    const i = value.indexOf('.');
    if (i > -1) {
      value = this._delete(value, i, 1);
    }
    while (value.charAt(0) === '0') {
      value = value.substring(1);
    }
    return value.length;
  }

  _delete(value, offset, length) {
    if (offset === 0) {
      return value.substring(length);
    } else {
      return value.substring(0, offset) + value.substring(offset + length);
    }
  }

  _isDecimal(s) {
    const decimal = /^-?\d*\.?\d+$/;
    return decimal.test(s);
  }

  _isInteger(s) {
    const integer = /^-?\d+$/;
    return integer.test(s);
  }

  _stringMultiply(c, count) {
    return c.repeat(Math.max(0, count));
  }

  _trimLeadingZeros(s) {
    if (s === null || s === undefined) {
      return null;
    }

    let i = 0;
    while (i < s.length && s.charAt(i) === '0') {
      i++;
    }
    if (i === s.length) {
      return "0";
    } else {
      return s.substring(i);
    }
  }

  _stringAddition(s1, s2) {
    if (s1.length !== s2.length) {
      throw new Error("String lengths must be equal for addition");
    }

    const result = new Array(s2.length);
    for (let i = 0; i < s2.length; i++) {
      result[i] = '0';
    }

    let c = 0;
    for (let i = s1.length - 1; i >= 0; i--) {
      const t = c + this._dig(s1.charAt(i)) + this._dig(s2.charAt(i));
      result[i] = this._cdig(t % 10);
      c = Math.floor(t / 10);
    }

    // For the tens array calculation, we expect no final carry
    if (c !== 0) {
      // This could happen during tens array setup - just prepend the carry
      return this._cdig(c) + result.join('');
    }

    return result.join('');
  }

  _stringSubtraction(s1, s2) {
    if (s1.length !== s2.length) {
      throw new Error("String lengths must be equal for subtraction");
    }

    const result = new Array(s2.length);
    for (let i = 0; i < s2.length; i++) {
      result[i] = '0';
    }

    let s1Array = s1.split('');

    for (let i = s1.length - 1; i >= 0; i--) {
      let t = this._dig(s1Array[i]) - this._dig(s2.charAt(i));
      if (t < 0) {
        t = t + 10;
        if (i === 0) {
          throw new Error("internal logic error");
        } else {
          s1Array[i - 1] = this._cdig(this._dig(s1Array[i - 1]) - 1);
        }
      }
      result[i] = this._cdig(t);
    }

    return result.join('');
  }

  _insert(ins, value, offset) {
    if (offset === 0) {
      return ins + value;
    } else {
      return value.substring(0, offset) + ins + value.substring(offset);
    }
  }

  _dig(c) {
    return c.charCodeAt(0) - '0'.charCodeAt(0);
  }

  _cdig(i) {
    return String.fromCharCode(i + '0'.charCodeAt(0));
  }

  toString() {
    return this.asDecimal();
  }

  copy() {
    const result = new Decimal();
    result.precision = this.precision;
    result.scientific = this.scientific;
    result.negative = this.negative;
    result.digits = this.digits;
    result.decimal = this.decimal;
    return result;
  }

  static zero() {
    return new Decimal('0');
  }

  isZero() {
    return this._allZeros(this.digits, 0);
  }

  static one() {
    return new Decimal('1');
  }

  isOne() {
    const one = Decimal.one();
    return this.comparesTo(one) === 0;
  }

  equals(other) {
    const o = Utilities._ensureDecimal(other);
    return this.asDecimal() === o.asDecimal();
  }

  comparesTo(other) {
    if (other === null || other === undefined) {
      return 0;
    }

    if (this.negative && !other.negative) {
      return -1;
    } else if (!this.negative && other.negative) {
      return 1;
    } else {
      const max = Math.max(this.decimal, other.decimal);
      let s1 = this._stringMultiply('0', max - this.decimal + 1) + this.digits;
      let s2 = this._stringMultiply('0', max - other.decimal + 1) + other.digits;

      if (s1.length < s2.length) {
        s1 = s1 + this._stringMultiply('0', s2.length - s1.length);
      } else if (s2.length < s1.length) {
        s2 = s2 + this._stringMultiply('0', s1.length - s2.length);
      }

      let result = s1.localeCompare(s2);
      if (this.negative) {
        result = -result;
      }
      return result;
    }
  }

  isWholeNumber() {
    return !this.asDecimal().includes('.');
  }

  asDecimal() {
    let result = this.digits;
    if (this.decimal !== this.digits.length) {
      if (this.decimal < 0) {
        result = '0.' + this._stringMultiply('0', 0 - this.decimal) + this.digits;
      } else if (this.decimal < result.length) {
        if (this.decimal === 0) {
          result = '0.' + result;
        } else {
          result = this._insert('.', result, this.decimal);
        }
      } else {
        result = result + this._stringMultiply('0', this.decimal - result.length);
      }
    }
    if (this.negative && !this._allZeros(result, 0)) {
      result = '-' + result;
    }
    return result;
  }

  asInteger() {
    if (!this.isWholeNumber()) {
      throw new UcumException(`Unable to represent ${this.toString()} as an integer`);
    }
    return parseInt(this.asDecimal());
  }

  multiply(other) {
    if (other === null || other === undefined) {
      return null;
    }

    if (this.isZero() || other.isZero()) {
      return Decimal.zero();
    }

    const max = Math.max(this.decimal, other.decimal);
    let s1 = this._stringMultiply('0', max - this.decimal + 1) + this.digits;
    let s2 = this._stringMultiply('0', max - other.decimal + 1) + other.digits;

    if (s1.length < s2.length) {
      s1 = s1 + this._stringMultiply('0', s2.length - s1.length);
    } else if (s2.length < s1.length) {
      s2 = s2 + this._stringMultiply('0', s1.length - s2.length);
    }

    if (s2.localeCompare(s1) > 0) {
      const s3 = s1;
      s1 = s2;
      s2 = s3;
    }

    const s = new Array(s2.length);

    let t = 0;
    for (let i = s2.length - 1; i >= 0; i--) {
      s[i] = this._stringMultiply('0', s2.length - (i + 1));
      let c = 0;
      for (let j = s1.length - 1; j >= 0; j--) {
        t = c + (this._dig(s1.charAt(j)) * this._dig(s2.charAt(i)));
        s[i] = this._insert(String(this._cdig(t % 10)), s[i], 0);
        c = Math.floor(t / 10);
      }
      while (c > 0) {
        s[i] = this._insert(String(this._cdig(t % 10)), s[i], 0);
        c = Math.floor(t / 10);
      }
    }

    t = 0;
    for (const sv of s) {
      t = Math.max(t, sv.length);
    }
    for (let i = 0; i < s.length; i++) {
      s[i] = this._stringMultiply('0', t - s[i].length) + s[i];
    }

    let res = "";
    let c = 0;
    for (let i = t - 1; i >= 0; i--) {
      for (let j = 0; j < s.length; j++) {
        c = c + this._dig(s[j].charAt(i));
      }
      res = this._insert(String(this._cdig(c % 10)), res, 0);
      c = Math.floor(c / 10);
    }

    if (c > 0) {
      throw new Error("internal logic error");
    }

    let dec = res.length - ((s1.length - (max + 1)) * 2);

    while (res && res !== "0" && res.startsWith("0")) {
      res = res.substring(1);
      dec--;
    }

    let prec = 0;
    if (this.isWholeNumber() && other.isWholeNumber()) {
      // at least the specified precision, and possibly more
      prec = Math.max(
        Math.max(this.digits.length, other.digits.length),
        Math.min(this.precision, other.precision)
      );
    } else if (this.isWholeNumber()) {
      prec = other.precision;
    } else if (other.isWholeNumber()) {
      prec = this.precision;
    } else {
      prec = Math.min(this.precision, other.precision);
    }

    while (res.length > prec && res.charAt(res.length - 1) === '0') {
      res = this._delete(res, res.length - 1, 1);
    }

    const result = new Decimal();
    result._setValueDecimal(res);
    result.precision = prec;
    result.decimal = dec;
    result.negative = this.negative !== other.negative;
    result.scientific = this.scientific || other.scientific;
    return result;
  }

  divide(other) {
    if (other === null || other === undefined) {
      return null;
    }

    if (this.isZero()) {
      return Decimal.zero();
    }

    if (other.isZero()) {
      throw new UcumException(`Attempt to divide ${this.toString()} by zero`);
    }

    const s = "0" + other.digits;
    const m = Math.max(this.digits.length, other.digits.length) + 40; // max loops we'll do
    const tens = new Array(10);

    // Create multiples of the divisor (1x, 2x, 3x, ... 9x)
    tens[0] = this._stringAddition(this._stringMultiply('0', s.length), s);
    for (let i = 1; i < 10; i++) {
      tens[i] = this._stringAddition(tens[i - 1], s);
    }

    let v = this.digits;
    let r = "";
    let l = 0;
    let d = (this.digits.length - this.decimal + 1) - (other.digits.length - other.decimal + 1);

    while (v.length < tens[0].length) {
      v = v + "0";
      d++;
    }

    let w;
    let vi;
    if (v.substring(0, other.digits.length).localeCompare(other.digits) < 0) {
      if (v.length === tens[0].length) {
        v = v + '0';
        d++;
      }
      w = v.substring(0, other.digits.length + 1);
      vi = w.length;
    } else {
      w = "0" + v.substring(0, other.digits.length);
      vi = w.length - 1;
    }

    let handled = false;
    let proc;

    while (!(handled && ((l > m) || ((vi >= v.length) && ((!w || this._allZeros(w, 0))))))) {
      l++;
      handled = true;
      proc = false;

      for (let i = 8; i >= 0; i--) {
        if (tens[i].localeCompare(w) <= 0) {
          proc = true;
          r = r + this._cdig(i + 1);
          w = this._trimLeadingZeros(this._stringSubtraction(w, tens[i]));

          if (!(handled && ((l > m) || ((vi >= v.length) && ((!w || this._allZeros(w, 0))))))) {
            if (vi < v.length) {
              w = w + v.charAt(vi);
              vi++;
              handled = false;
            } else {
              w = w + '0';
              d++;
            }
            while (w.length < tens[0].length) {
              w = '0' + w;
            }
          }
          break;
        }
      }

      if (!proc) {
        if (w.charAt(0) !== '0') {
          throw new Error("Expected leading zero");
        }
        w = this._delete(w, 0, 1);
        r = r + "0";

        if (!(handled && ((l > m) || ((vi >= v.length) && ((!w || this._allZeros(w, 0))))))) {
          if (vi < v.length) {
            w = w + v.charAt(vi);
            vi++;
            handled = false;
          } else {
            w = w + '0';
            d++;
          }
          while (w.length < tens[0].length) {
            w = '0' + w;
          }
        }
      }
    }

    let prec;

    if (this.isWholeNumber() && other.isWholeNumber() && (l < m)) {
      for (let i = 0; i < d; i++) {
        if (r.charAt(r.length - 1) === '0') {
          r = this._delete(r, r.length - 1, 1);
          d--;
        }
      }
      prec = 100;
    } else {
      if (this.isWholeNumber() && other.isWholeNumber()) {
        prec = Math.max(this.digits.length, other.digits.length);
      } else if (this.isWholeNumber()) {
        prec = Math.max(other.precision, r.length - d);
      } else if (other.isWholeNumber()) {
        prec = Math.max(this.precision, r.length - d);
      } else {
        prec = Math.max(Math.min(this.precision, other.precision), r.length - d);
      }

      if (r.length > prec) {
        d = d - (r.length - prec);
        const dig = r.charAt(prec);
        const up = dig >= '5';

        if (up) {
          const rs = r.substring(0, prec).split('');
          let i = rs.length - 1;
          let carry = true;

          while (carry && i >= 0) {
            let ls = rs[i];
            if (ls === '9') {
              rs[i] = '0';
            } else {
              ls = this._cdig(this._dig(ls) + 1);
              rs[i] = ls;
              carry = false;
            }
            i--;
          }

          if (carry) {
            r = "1" + rs.join('');
            d++; // cause we added one at the start
          } else {
            r = rs.join('');
          }
        } else {
          r = r.substring(0, prec);
        }
      }
    }

    const result = new Decimal();
    result._setValueDecimal(r);
    result.decimal = r.length - d;
    result.negative = this.negative !== other.negative;
    result.precision = prec;
    result.scientific = this.scientific || other.scientific;
    return result;
  }

  add(other) {
    if (other === null || other === undefined) {
      return null;
    }

    // Simplified addition - convert to numbers and create new Decimal
    const thisVal = parseFloat(this.asDecimal());
    const otherVal = parseFloat(other.asDecimal());
    const result = thisVal + otherVal;

    const newDecimal = new Decimal(result.toString());
    newDecimal.scientific = this.scientific || other.scientific;

    // Handle precision
    if (this.decimal < other.decimal) {
      newDecimal.precision = this.precision;
    } else if (other.decimal < this.decimal) {
      newDecimal.precision = other.precision;
    } else {
      newDecimal.precision = Math.min(this.precision, other.precision);
    }

    return newDecimal;
  }

  subtract(other) {
    if (other === null || other === undefined) {
      return null;
    }

    // Simplified subtraction - convert to numbers and create new Decimal
    const thisVal = parseFloat(this.asDecimal());
    const otherVal = parseFloat(other.asDecimal());
    const result = thisVal - otherVal;

    const newDecimal = new Decimal(result.toString());
    newDecimal.scientific = this.scientific || other.scientific;

    // Handle precision similar to add
    if (this.decimal < other.decimal) {
      newDecimal.precision = this.precision;
    } else if (other.decimal < this.decimal) {
      newDecimal.precision = other.precision;
    } else {
      newDecimal.precision = Math.min(this.precision, other.precision);
    }

    return newDecimal;
  }

  checkForCouldBeWholeNumber() {
    // whole numbers are tricky - they have implied infinite precision, but we need to check for digit errors in the last couple of digits
    // it's a whole number if all but the last one or two digits after the decimal place is 9 or 0 and the precision is >17 (arbitrary but enough)
    if (this.precision > 17 && this.digits.length > 3) {
      let i = this.digits.length - 2;
      const ch = this.digits.charAt(i); // second last character
      if (ch === '9') {
        while (i > 0 && this.digits.charAt(i - 1) === '9') {
          i--;
        }
        if (i > 0 && i < this.digits.length - 3) {
          this.digits = this.digits.substring(0, i - 1) + String.fromCharCode(this.digits.charCodeAt(i - 1) + 1);
          this.precision = this.digits.length;
        }
      } else if (ch === '0') {
        while (i > 0 && this.digits.charAt(i - 1) === '0') {
          i--;
        }
        if (i > 0 && i < this.digits.length - 3) {
          this.digits = this.digits.substring(0, i);
          this.precision = this.digits.length;
        }
      }
    }
  }
}

// Enums
const ConceptKind = {
  PREFIX: 'prefix',
  BASEUNIT: 'base-unit',
  UNIT: 'unit'
};

const Operator = {
  MULTIPLICATION: '*',
  DIVISION: '/'
};

const TokenType = {
  NONE: 'none',
  SOLIDUS: 'solidus',
  PERIOD: 'period',
  OPEN: 'open',
  CLOSE: 'close',
  ANNOTATION: 'annotation',
  NUMBER: 'number',
  SYMBOL: 'symbol'
};

// Exception class
class UcumException extends Error {
  constructor(message) {
    super(message);
    this.name = 'UcumException';
  }
}

// Utilities class
class Utilities {
  static isAsciiChar(ch) {
    const code = ch.charCodeAt(0);
    return code >= 0 && code <= 127;
  }

  static noString(str) {
    return !str || !str.trim();
  }

  static _ensureDecimal(v) {
    if (v == null) {
      return null; // this is probably an error.
    }
    if (v instanceof Decimal) {
      return v;
    }
    return new Decimal(v);
  }
}

// Base concept class
class Concept {
  constructor(code, codeUC) {
    this.code = code;
    this.codeUC = codeUC;
    this.names = [];
    this.printSymbol = '';
  }
}

// Unit class (base for BaseUnit and DefinedUnit)
class Unit extends Concept {
  constructor(code, codeUC) {
    super(code, codeUC);
    this.property = '';
  }
}

// Base unit class
class BaseUnit extends Unit {
  constructor(code, codeUC) {
    super(code, codeUC);
    this.kind = ConceptKind.BASEUNIT;
    this.dim = '';
  }
}

// Defined unit class
class DefinedUnit extends Unit {
  constructor(code, codeUC) {
    super(code, codeUC);
    this.kind = ConceptKind.UNIT;
    this.metric = false;
    this.isSpecial = false;
    this.class_ = '';
    this.value = null;
  }
}

// Prefix class
class Prefix extends Concept {
  constructor(code, codeUC) {
    super(code, codeUC);
    this.kind = ConceptKind.PREFIX;
    this.value = null;
  }
}

// Value class
class Value {
  constructor(unit, unitUC, value) {
    this.unit = unit || '';
    this.unitUC = unitUC || '';
    this.value = value;
    this.text = '';
  }
}

// Pair class for value/unit combinations
class Pair {
  constructor(value, code) {
    this.value = value;
    this.code = code;
  }

  getValue() {
    return this.value;
  }

  getCode() {
    return this.code;
  }

  equals(other) {
    if (other instanceof Pair) {
      return this.value.equals(other.value) && this.code === other.code;
    }
    return false;
  }

  hashCode() {
    return this.toString().length; // Simple hash
  }

  toString() {
    return `${this.value.toString()} ${this.code}`;
  }
}

// Expression tree components
class Component {
  // Base class for expression components
}

class Term extends Component {
  constructor() {
    super();
    this.comp = null;
    this.op = null;
    this.term = null;
  }
}

class Symbol extends Component {
  constructor() {
    super();
    this.prefix = null;
    this.unit = null;
    this.exponent = 1;
  }
}

class Factor extends Component {
  constructor(value) {
    super();
    this.value = value;
  }
}

// Expression class
class Expression {
  constructor() {
    this.term = null;
  }
}

// Canonical unit for canonical form representation
class CanonicalUnit {
  constructor(base, exponent = 1) {
    this.base = base;
    this.exponent = exponent;
  }

  getBase() {
    return this.base;
  }

  getExponent() {
    return this.exponent;
  }

  setExponent(exponent) {
    this.exponent = exponent;
  }
}

// Canonical form of a unit expression
class Canonical {
  constructor(value) {
    this.value = value || new Decimal("1.000000000000000000000000000000");
    this.units = [];
  }

  getValue() {
    return this.value;
  }

  getUnits() {
    return this.units;
  }

  multiplyValue(val) {
    const v = Utilities._ensureDecimal(val);
    this.value = this.value.multiply(v);
  }

  divideValue(val) {
    const v = Utilities._ensureDecimal(val)
    this.value = this.value.divide(v);
  }
}

// Version details class
class UcumVersionDetails {
  constructor(releaseDate, version) {
    this.releaseDate = releaseDate;
    this.version = version;
  }

  getReleaseDate() {
    return this.releaseDate;
  }

  getVersion() {
    return this.version;
  }
}

// Registry for special unit handlers
class Registry {
  constructor() {
    this.handlers = new Map();

    this.register(new CelsiusHandler());
    this.register(new FahrenheitHandler());
    this.register(new HoldingHandler("[p'diop]", "deg"));
    this.register(new HoldingHandler("%[slope]", "deg"));
    this.register(new HoldingHandler("[hp_X]", "1"));
    this.register(new HoldingHandler("[hp_C]", "1"));
    this.register(new HoldingHandler("[pH]", "mol/l"));
    this.register(new HoldingHandler("Np", "1"));
    this.register(new HoldingHandler("B", "1"));
    this.register(new HoldingHandler("B[SPL]", "10*-5.Pa", new Decimal(2)));
    this.register(new HoldingHandler("B[V]", "V"));
    this.register(new HoldingHandler("B[mV]", "mV"));
    this.register(new HoldingHandler("B[uV]", "uV"));
    this.register(new HoldingHandler("B[W]", "W"));
    this.register(new HoldingHandler("B[kW]", "kW"));
    this.register(new HoldingHandler("bit_s", "1"))
  }

  exists(code) {
    return this.handlers.has(code);
  }

  get(code) {
    return this.handlers.get(code);
  }

  register(handler) {
    // Key on getCode() — the interface every handler implements. Some handlers
    // (CelsiusHandler/FahrenheitHandler) override getCode() without setting a
    // `.code` field, so keying on `.code` would register them under `undefined`.
    this.handlers.set(handler.getCode(), handler);
  }
}

// Special Unit Handler base class
class SpecialUnitHandler {
  /**
   * Used to connect this handler with the case sensitive unit
   * @return {string}
   */
  getCode() {
    throw new Error("getCode() must be implemented by subclass");
  }

  /**
   * the alternate units to convert to
   * @return {string}
   */
  getUnits() {
    throw new Error("getUnits() must be implemented by subclass");
  }

  /**
   * get the conversion value
   * @return {Decimal}
   */
  getValue() {
    throw new Error("getValue() must be implemented by subclass");
  }

  /**
   * return true if the conversion offset value != 0
   * @return {boolean}
   */
  hasOffset() {
    throw new Error("hasOffset() must be implemented by subclass");
  }

  /**
   * get the conversion offset value
   * @return {Decimal}
   * @throws {UcumException}
   */
  getOffset() {
    throw new Error("getOffset() must be implemented by subclass");
  }
}

// Celsius Handler
class CelsiusHandler extends SpecialUnitHandler {
  getCode() {
    return "Cel";
  }

  getUnits() {
    return "K";
  }

  getValue() {
    return Decimal.one();
  }

  getOffset() {
    return new Decimal("-273.15", 24);
  }

  hasOffset() {
    return true;
  }
}

// Fahrenheit Handler
class FahrenheitHandler extends SpecialUnitHandler {
  getCode() {
    return "[degF]";
  }

  getUnits() {
    return "K";
  }

  getValue() {
    try {
      return new Decimal("5").divide(new Decimal("9"));
    } catch (e) {
      // won't happen
      return null;
    }
  }

  getOffset() {
    return new Decimal("32", 24);
  }

  hasOffset() {
    return true;
  }
}

// Holding Handler - generic handler for other special units
class HoldingHandler extends SpecialUnitHandler {
  /**
   * @param {string} code
   * @param {string} units
   * @param {Decimal} value (optional, defaults to Decimal.one())
   */
  constructor(code, units, value = null) {
    super();
    this.code = code;
    this.units = units;
    this.value = value || Decimal.one();
  }

  getCode() {
    return this.code;
  }

  getUnits() {
    return this.units;
  }

  getValue() {
    return this.value;
  }

  getOffset() {
    return new Decimal("0", 24);
  }

  hasOffset() {
    return false;
  }
}

module.exports = {
  ConceptKind,
  Operator,
  TokenType,
  UcumException,
  Decimal,
  Utilities,
  Concept,
  Unit,
  BaseUnit,
  DefinedUnit,
  Prefix,
  Value,
  Pair,
  Component,
  Term,
  Symbol,
  Factor,
  Expression,
  Canonical,
  CanonicalUnit,
  Registry,
  UcumVersionDetails
};
