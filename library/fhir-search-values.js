//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The value-level parts of FHIR search that every module with a search implements the
 * same way: date ranges, the comparison prefixes, comma-separated values, and LIKE
 * escaping. The SQL that uses them is each module's own (testing/search.js,
 * ips/search.js).
 *
 * @module library/fhir-search-values
 */

const PREFIXES = ['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'sa', 'eb', 'ap'];

const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/;

/**
 * The range of instants a FHIR date, dateTime or instant covers, as [lo, hi) in epoch
 * milliseconds. "2026" covers the whole year; "2026-09-24T10:00:00.5Z" covers 100ms.
 * A time with no zone is taken as UTC (FHIR requires a zone, but search values often
 * leave it off).
 *
 * @param {string} value
 * @returns {{lo: number, hi: number}|null} null if the value isn't a date
 */
function dateRange(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const m = DATE_RE.exec(value.trim());
  if (!m) {
    return null;
  }
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  const year = parseInt(y, 10);
  if (!mo) {
    return { lo: Date.UTC(year, 0, 1), hi: Date.UTC(year + 1, 0, 1) };
  }
  const month = parseInt(mo, 10) - 1;
  if (month < 0 || month > 11) {
    return null;
  }
  if (!d) {
    return { lo: Date.UTC(year, month, 1), hi: Date.UTC(year, month + 1, 1) };
  }
  const day = parseInt(d, 10);
  if (day < 1 || day > new Date(Date.UTC(year, month + 1, 0)).getUTCDate()) {
    return null;
  }
  if (!h) {
    return { lo: Date.UTC(year, month, day), hi: Date.UTC(year, month, day + 1) };
  }
  const zone = tz || 'Z';
  const text = `${y}-${mo}-${d}T${h}:${mi}:${s || '00'}${frac || ''}${zone}`;
  const lo = Date.parse(text);
  if (Number.isNaN(lo) || parseInt(h, 10) > 23 || parseInt(mi, 10) > 59 || (s && parseInt(s, 10) > 59)) {
    return null;
  }
  let width;
  if (!s) {
    width = 60000;
  } else if (!frac) {
    width = 1000;
  } else {
    // .5 is 100ms wide, .50 10ms, .500 and beyond 1ms
    width = Math.max(1, Math.pow(10, 3 - (frac.length - 1)));
  }
  return { lo, hi: lo + width };
}

/**
 * Take the comparison prefix (eq, ge, ...) off a date or number search value.
 * @returns {{prefix: string, rest: string}} prefix is 'eq' when there is none
 */
function splitPrefix(value) {
  const p = value.substring(0, 2);
  if (PREFIXES.includes(p) && value.length > 2 && !/^[a-z]/.test(value.substring(2))) {
    return { prefix: p, rest: value.substring(2) };
  }
  return { prefix: 'eq', rest: value };
}

/** Escape a value for use in a LIKE pattern with ESCAPE '\'. */
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (c) => '\\' + c);
}

/**
 * Split a parameter value on commas, honouring \, as an escaped comma.
 */
function splitValues(value) {
  const out = [];
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && i + 1 < value.length) {
      cur += value[i + 1];
      i++;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.filter(v => v.length > 0);
}

/**
 * SQL comparing a stored [lo, hi) range (two column expressions) against a search
 * range, for a comparison prefix.
 *
 * @param {{lo: string, hi: string}} cols - column expressions
 * @param {string} prefix
 * @param {{lo: number, hi: number}} range
 * @returns {{sql: string, args: number[]}|null}
 */
function dateClause(cols, prefix, range) {
  const { lo, hi } = cols;
  switch (prefix) {
    case 'eq': return { sql: `(${lo} >= ? AND ${hi} <= ?)`, args: [range.lo, range.hi] };
    case 'ne': return { sql: `NOT (${lo} >= ? AND ${hi} <= ?)`, args: [range.lo, range.hi] };
    case 'gt': return { sql: `${hi} > ?`, args: [range.hi] };
    case 'lt': return { sql: `${lo} < ?`, args: [range.lo] };
    case 'ge': return { sql: `${hi} > ?`, args: [range.lo] };
    case 'le': return { sql: `${lo} < ?`, args: [range.hi] };
    case 'sa': return { sql: `${lo} >= ?`, args: [range.hi] };
    case 'eb': return { sql: `${hi} <= ?`, args: [range.lo] };
    case 'ap': return { sql: `(${lo} < ? AND ${hi} > ?)`, args: [range.hi, range.lo] };
  }
  return null;
}

module.exports = { PREFIXES, dateRange, splitPrefix, escapeLike, splitValues, dateClause };
