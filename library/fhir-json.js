//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * FHIR JSON, read and written keeping numbers as they were written.
 *
 * In FHIR a decimal's precision is part of its value: 1.0 is not 1, and 2.50 is not 2.5. Plain
 * JSON.parse makes them all numbers, and JSON.stringify writes them back the shortest way, so
 * precision is lost on the way through. parse() notes the text of each number that wouldn't
 * come back the same (1.0, 2.50, 1E+3, -0, integers too large for a double), against the
 * object or array that holds it, without changing the values: code that reads them still sees
 * numbers. stringify() writes those numbers as they were given, as long as the value is still
 * the same; a value that has changed is written as usual. clone() copies a value, and what
 * was noted with it. Anything else that copies (structuredClone, spreading an object) leaves
 * the copy without the notes, and its numbers are written the usual way.
 *
 * findDuplicates() finds the properties that are in an object more than once, which
 * JSON.parse quietly makes one (the last).
 *
 * (The text of each number comes from JSON.parse's reviver, which Node has had since 21; it is
 * only used when the text has a number that needs it.)
 *
 * @module library/fhir-json
 */

// holder (object or array) -> Map(key -> the number's text)
const WRITTEN = new WeakMap();

// a quick look for numbers that might not come back the same: a fraction ending in 0, an
// exponent, a long run of digits, -0. (Strings that look like that only make parse take the
// slower way)
const MAYBE = /\d\.\d*0(?![\d.])|\d[eE][+-]?\d|\d{16,}|-0(?![.\d])/;

/** Note how a number was written (when it wouldn't come back the same) */
function remember(holder, key, text) {
  let m = WRITTEN.get(holder);
  if (!m) {
    m = new Map();
    WRITTEN.set(holder, m);
  }
  m.set(String(key), text);
}

/**
 * How a number in an object or array was written, if it was noted (and the value is still
 * the same), else undefined
 * @param {Object|Array} holder
 * @param {string|number} key - a property name, or an index
 */
function writtenAs(holder, key) {
  const m = holder !== null && typeof holder === 'object' ? WRITTEN.get(holder) : undefined;
  const t = m ? m.get(String(key)) : undefined;
  return t !== undefined && Number(t) === holder[key] ? t : undefined;
}

/** Whether a number's text would be written back the same */
function sameText(value, text) {
  return String(value) === text;
}

/**
 * A reviver for JSON.parse (or body-parser's express.json({ reviver })) that notes how the
 * numbers that wouldn't come back the same were written. (parse() is quicker, when it can be
 * used: it only revives when the text has a number that needs it)
 */
function reviver(key, value, context) {
  if (typeof value === 'number' && context && typeof context.source === 'string' && !sameText(value, context.source)) {
    remember(this, key, context.source);
  }
  return value;
}

/**
 * Parse JSON, noting how the numbers that wouldn't come back the same were written.
 * @param {string|Buffer} text
 * @param {function} [reviver] - as JSON.parse's (it doesn't see the numbers' text)
 * @returns {*}
 * @throws SyntaxError, as JSON.parse
 */
function parse(text, reviver) {
  const s = typeof text === 'string' ? text : String(text);
  if (!MAYBE.test(s)) {
    return reviver ? JSON.parse(s, reviver) : JSON.parse(s);
  }
  return JSON.parse(s, function (key, value, context) {
    if (typeof value === 'number' && context && typeof context.source === 'string' && !sameText(value, context.source)) {
      remember(this, key, context.source);
    }
    return reviver ? reviver.call(this, key, value) : value;
  });
}

function replacer(user) {
  return function (key, value) {
    let v = user ? user.call(this, key, value) : value;
    if (typeof v === 'number') {
      const t = writtenAs(this, key);
      if (t !== undefined && v === this[key]) {
        v = JSON.rawJSON(t);
      }
    }
    return v;
  };
}

/**
 * JSON.stringify, writing the numbers parse() noted as they were written.
 * @param {*} value
 * @param {function|null} [userReplacer] - as JSON.stringify's (an array of names isn't supported)
 * @param {string|number} [space]
 * @returns {string}
 */
function stringify(value, userReplacer, space) {
  if (userReplacer !== undefined && userReplacer !== null && typeof userReplacer !== 'function') {
    throw new Error('fhir-json.stringify: the replacer must be a function');
  }
  return JSON.stringify(value, replacer(userReplacer || null), space);
}

/**
 * A deep copy of JSON (objects, arrays, and primitives), with what parse() noted about its
 * numbers
 * @param {*} value
 * @returns {*}
 */
function clone(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const notes = WRITTEN.get(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map(clone);
  } else {
    out = {};
    for (const k of Object.keys(value)) {
      out[k] = clone(value[k]);
    }
  }
  if (notes) {
    WRITTEN.set(out, new Map(notes));
  }
  return out;
}

/**
 * Copy what parse() noted about one holder's numbers to another (when an object is rebuilt
 * with the same properties)
 */
function copyNotes(from, to) {
  const notes = from !== null && typeof from === 'object' ? WRITTEN.get(from) : undefined;
  if (notes && to !== null && typeof to === 'object') {
    const m = WRITTEN.get(to) || new Map();
    for (const [k, t] of notes) {
      if (!m.has(k)) {
        m.set(k, t);
      }
    }
    WRITTEN.set(to, m);
  }
}

/**
 * The properties that are in an object more than once: [{ path, name, offset }], path as
 * "entry[2].resource" (empty for the top), offset where the second (or later) name starts in
 * the text. The text must be JSON (else: what it found before the problem).
 * @param {string|Buffer} text
 * @returns {Array<{path: string, name: string, offset: number}>}
 */
function findDuplicates(text) {
  const s = typeof text === 'string' ? text : String(text);
  const out = [];
  // a stack of containers: { keys: Set (objects) | null (arrays), parent, step (how it is
  // reached from its parent: a name, or an index), index (arrays: the item now) }. The path is
  // only worked out for a duplicate
  const stack = [];
  let i = 0;
  const n = s.length;
  let pendingName = null;
  const pathOf = (c) => {
    const steps = [];
    for (let x = c; x && x.parent; x = x.parent) {
      steps.push(x.step);
    }
    let out = '';
    for (let k = steps.length - 1; k >= 0; k--) {
      const st = steps[k];
      out += typeof st === 'number' ? `[${st}]` : (out ? '.' : '') + st;
    }
    return out;
  };
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 34) {
      // a string: a name (in an object, before a colon) or a value
      let j = i + 1;
      let raw = false;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (d === 92) {
          raw = true;
          j += 2;
        } else if (d === 34) {
          break;
        } else {
          j++;
        }
      }
      const top = stack[stack.length - 1];
      let k = j + 1;
      while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10 || s.charCodeAt(k) === 13)) {
        k++;
      }
      if (top && top.keys && s.charCodeAt(k) === 58) {
        let name = s.substring(i + 1, j);
        if (raw) {
          try {
            name = JSON.parse(s.substring(i, j + 1));
          } catch (e) {
            // left as written
          }
        }
        if (top.keys.has(name)) {
          out.push({ path: pathOf(top), name, offset: i });
        }
        top.keys.add(name);
        pendingName = name;
        i = k + 1;
        continue;
      }
      i = j + 1;
    } else if (c === 123 || c === 91) {
      const top = stack[stack.length - 1];
      stack.push({ keys: c === 123 ? new Set() : null, parent: top || null, step: top ? (top.keys ? pendingName : top.index) : null, index: 0 });
      i++;
    } else if (c === 125 || c === 93) {
      stack.pop();
      i++;
    } else if (c === 44) {
      const top = stack[stack.length - 1];
      if (top && !top.keys) {
        top.index++;
      }
      i++;
    } else {
      i++;
    }
  }
  return out;
}

module.exports = { parse, reviver, stringify, clone, copyNotes, writtenAs, remember, findDuplicates };
