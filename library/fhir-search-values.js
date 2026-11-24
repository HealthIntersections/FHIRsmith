//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The value-level parts of FHIR search that every module with a search implements the
 * same way: date ranges, the comparison prefixes, comma-separated values, and LIKE
 * escaping. The SQL that uses them is each module's own (testing/search.js,
 * ips/search.js, rest/search/sql.js).
 *
 * Every date value is a half-open range of instants [lo, hi) in epoch milliseconds, and
 * every prefix is one comparison between two ranges (see dateClause, and the rest
 * module's design: "Date and time search").
 *
 * @module library/fhir-search-values
 */

const PREFIXES = ['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'sa', 'eb', 'ap'];

// seconds may be 60: a leap second, which FHIR allows
const DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/;

// the smallest and largest instants a JavaScript date can hold: the ends of an open
// Period. Stored as numbers, never as NULL, so an open-ended Period still compares
const MIN_INSTANT = -8.64e15;
const MAX_INSTANT = 8.64e15;

const DAY_MS = 86400000;

/**
 * UTC milliseconds for a date and time in UTC. Unlike Date.UTC, a year from 0 to 99 is that
 * year, not 1900 to 1999.
 */
function utc(year, month, day, h = 0, mi = 0, s = 0, ms = 0) {
  const d = new Date(0);
  d.setUTCFullYear(year, month, day);
  d.setUTCHours(h, mi, s, ms);
  return d.getTime();
}

const offsetFormats = new Map();

/**
 * The offset of a time zone from UTC at an instant, in milliseconds (local - UTC).
 * @param {number} instant - epoch ms
 * @param {string} timeZone - an IANA zone name
 */
function zoneOffset(instant, timeZone) {
  if (!timeZone || timeZone === 'UTC' || timeZone === 'Etc/UTC') {
    return 0;
  }
  let fmt = offsetFormats.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', era: 'short'
    });
    offsetFormats.set(timeZone, fmt);
  }
  const p = {};
  for (const part of fmt.formatToParts(new Date(instant))) {
    p[part.type] = part.value;
  }
  let year = parseInt(p.year, 10);
  if (p.era === 'BC' || p.era === 'B') {
    year = 1 - year;
  }
  const local = utc(year, parseInt(p.month, 10) - 1, parseInt(p.day, 10),
    parseInt(p.hour, 10), parseInt(p.minute, 10), parseInt(p.second, 10));
  return local - (instant - (((instant % 1000) + 1000) % 1000));
}

/**
 * The UTC instant of a wall-clock time in a time zone. Daylight saving changes are taken
 * from the time zone database, so local midnight on the day a change happens is right.
 * @param {number} wall - the wall-clock time as if it were UTC (from utc())
 * @param {string} timeZone
 */
function wallToInstant(wall, timeZone) {
  if (!timeZone || timeZone === 'UTC' || timeZone === 'Etc/UTC') {
    return wall;
  }
  // two rounds: the offset at the first guess, then at the answer it gives
  let t = wall - zoneOffset(wall, timeZone);
  t = wall - zoneOffset(t, timeZone);
  return t;
}

/**
 * The range of instants a FHIR date, dateTime or instant covers, as [lo, hi) in epoch
 * milliseconds. "2026" covers the whole year; "2026-09-24T10:00:00.5Z" covers 100ms;
 * milliseconds are the finest grain.
 *
 * A value with no zone - a date, a partial date, or a time without one - is taken in the
 * given time zone (UTC by default): "2026-09-24" runs from local midnight to local
 * midnight, which is 23 or 25 hours on a day with a daylight saving change.
 *
 * A leap second (23:59:60) is the last second of that minute.
 *
 * @param {string} value
 * @param {string} [timeZone] - an IANA time zone name; UTC if absent
 * @returns {{lo: number, hi: number}|null} null if the value isn't a date
 */
function dateRange(value, timeZone) {
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
    return {
      lo: wallToInstant(utc(year, 0, 1), timeZone),
      hi: wallToInstant(utc(year + 1, 0, 1), timeZone)
    };
  }
  const month = parseInt(mo, 10) - 1;
  if (month < 0 || month > 11) {
    return null;
  }
  if (!d) {
    return {
      lo: wallToInstant(utc(year, month, 1), timeZone),
      hi: wallToInstant(utc(year, month + 1, 1), timeZone)
    };
  }
  const day = parseInt(d, 10);
  if (day < 1 || day > new Date(utc(year, month + 1, 0)).getUTCDate()) {
    return null;
  }
  if (!h) {
    return {
      lo: wallToInstant(utc(year, month, day), timeZone),
      hi: wallToInstant(utc(year, month, day + 1), timeZone)
    };
  }
  const hour = parseInt(h, 10);
  const minute = parseInt(mi, 10);
  let second = s ? parseInt(s, 10) : 0;
  if (hour > 23 || minute > 59 || second > 60 || (second === 60 && !(hour === 23 && minute === 59))) {
    return null;
  }
  if (second === 60) {
    // a leap second: the last second of the minute
    second = 59;
  }
  const millis = frac ? Math.floor(parseFloat('0' + frac) * 1000) : 0;
  const wall = utc(year, month, day, hour, minute, second, millis);
  let lo;
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const oh = parseInt(tz.substring(1, 3), 10);
    const om = parseInt(tz.substring(4, 6), 10);
    if (oh > 14 || om > 59) {
      return null;
    }
    lo = wall - sign * (oh * 3600000 + om * 60000);
  } else if (tz === 'Z') {
    lo = wall;
  } else {
    lo = wallToInstant(wall, timeZone);
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
 * The range a Period covers: from the start's lo to the end's hi, open where either is
 * missing. A Period ending "2013-01-21" runs to the end of that day.
 * @param {{start?: string, end?: string}} period
 * @param {string} [timeZone]
 * @returns {{lo: number, hi: number}|null}
 */
function periodRange(period, timeZone) {
  if (!period || (!period.start && !period.end)) {
    return null;
  }
  const start = period.start ? dateRange(period.start, timeZone) : null;
  const end = period.end ? dateRange(period.end, timeZone) : null;
  if ((period.start && !start) || (period.end && !end)) {
    return null;
  }
  return { lo: start ? start.lo : MIN_INSTANT, hi: end ? end.hi : MAX_INSTANT };
}

/**
 * The range for `ap`: the value's range widened on each side by 10% of the distance
 * between it and now, and never by less than a day.
 * @param {{lo: number, hi: number}} range
 * @param {number} [now] - epoch ms
 */
function approxDateRange(range, now = Date.now()) {
  const mid = (range.lo + range.hi) / 2;
  const widen = Math.max(DAY_MS, Math.abs(now - mid) * 0.1);
  return { lo: range.lo - widen, hi: range.hi + widen };
}

/**
 * The range a decimal number covers by its precision: "1.5" is [1.45, 1.55), "100" is
 * [99.5, 100.5). An exponent counts too: "1e2" is [50, 150).
 * @param {string|number} text
 * @returns {{lo: number, hi: number, value: number}|null}
 */
function numberRange(text) {
  const s = String(text).trim();
  const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) {
    return null;
  }
  const value = Number(s);
  if (!Number.isFinite(value)) {
    return null;
  }
  const decimals = m[3] ? m[3].length : 0;
  const exponent = m[4] ? parseInt(m[4], 10) : 0;
  const half = 0.5 * Math.pow(10, exponent - decimals);
  return { lo: value - half, hi: value + half, value };
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
 * Escape a value for use in a LIKE pattern with ESCAPE '!'. MySQL treats a backslash in a
 * string literal as an escape too, so a LIKE meant for both SQLite and MySQL uses '!'.
 */
function escapeLikeBang(value) {
  return value.replace(/[!%_]/g, (c) => '!' + c);
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
 * range, for a comparison prefix. From the specification's definitions:
 *
 *   eq  the search range fully contains the resource range    lo >= pLo and hi <= pHi
 *   ne  it does not                                            not (eq)
 *   gt  the range above the search value overlaps             hi > pHi
 *   lt  the range below the search value overlaps             lo < pLo
 *   ge  [pLo, +infinity) overlaps                              hi > pLo
 *   le  (-infinity, pHi) overlaps                              lo < pHi
 *   sa  no overlap, and the resource range is above            lo >= pHi
 *   eb  no overlap, and the resource range is below            hi <= pLo
 *   ap  the ranges overlap (the caller widens the search range: approxDateRange)
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

/**
 * The same comparisons as dateClause, in JavaScript: whether a resource range matches a
 * search range. For tests, and for checking values in memory.
 */
function rangeMatches(prefix, resource, search) {
  switch (prefix) {
    case 'eq': return resource.lo >= search.lo && resource.hi <= search.hi;
    case 'ne': return !(resource.lo >= search.lo && resource.hi <= search.hi);
    case 'gt': return resource.hi > search.hi;
    case 'lt': return resource.lo < search.lo;
    case 'ge': return resource.hi > search.lo;
    case 'le': return resource.lo < search.hi;
    case 'sa': return resource.lo >= search.hi;
    case 'eb': return resource.hi <= search.lo;
    case 'ap': return resource.lo < search.hi && resource.hi > search.lo;
  }
  return false;
}

module.exports = {
  PREFIXES, MIN_INSTANT, MAX_INSTANT, dateRange, periodRange, approxDateRange, numberRange, splitPrefix,
  escapeLike, escapeLikeBang, splitValues, dateClause, rangeMatches, zoneOffset, wallToInstant
};
