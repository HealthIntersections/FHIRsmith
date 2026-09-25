//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * FHIR search parameter handling for the /testing module.
 *
 * Turns a query (as express parses it: repeated parameters arrive as arrays) into SQL
 * clauses over the reports table. None of the parameters here are formally defined as
 * SearchParameter resources yet, so the behaviour is simply what this file does:
 *
 *   name, tester         string: starts-with, case-insensitive; :exact, :contains, :missing
 *   status, result       token: exact code (a system| prefix is ignored); :not, :missing
 *   testscript           uri: exact; :below (starts-with), :missing
 *   participant          uri of any participant: exact; :below
 *   score                number: eq ne gt lt ge le sa eb ap, with implicit precision for eq
 *   issued, _lastUpdated date: eq ne gt lt ge le sa eb ap, compared as ranges
 *   _id                  exact
 *   _sort                any of the above (not _id), comma separated, '-' for descending
 *   _count, _offset      paging; _summary=count for the total alone
 *
 * Comma separated values are ORed, repeated parameters are ANDed. Empty values are
 * ignored, as the spec says. Unknown parameters and modifiers are reported back in
 * `unknown` so the caller can decide whether to be lenient or strict; values that
 * can't be understood (a bad date or number) are reported in `errors`, and those are
 * always an error.
 *
 * @module testing/search
 */

const DEFAULT_COUNT = 50;
const MAX_COUNT = 500;

// the column each parameter searches, and the one it sorts on
const PARAMS = {
  _id: { type: 'id', col: 'r.id' },
  name: { type: 'string', col: 'r.name', lc: 'r.name_lc', sort: 'r.name_lc' },
  tester: { type: 'string', col: 'r.tester', lc: 'r.tester_lc', sort: 'r.tester_lc' },
  status: { type: 'token', col: 'r.status', sort: 'r.status' },
  result: { type: 'token', col: 'r.result', sort: 'r.result' },
  testscript: { type: 'uri', col: 'r.test_script', sort: 'r.test_script' },
  participant: { type: 'participant' },
  score: { type: 'number', col: 'r.score', sort: 'r.score' },
  issued: { type: 'date', lo: 'r.issued_lo', hi: 'r.issued_hi', sort: 'r.issued_lo' },
  _lastUpdated: { type: 'date', lo: 'r.received_ms', hi: '(r.received_ms + 1)', sort: 'r.received_ms' }
};

const MODIFIERS = {
  id: [],
  string: ['exact', 'contains', 'missing'],
  token: ['not', 'missing'],
  uri: ['below', 'missing'],
  participant: ['below'],
  number: ['missing'],
  date: []
};

// parameters that control the search rather than filter it
const CONTROL = new Set(['_sort', '_count', '_offset', '_summary', '_format', '_total', '_pretty']);

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

function splitPrefix(value) {
  const p = value.substring(0, 2);
  if (PREFIXES.includes(p) && value.length > 2 && !/^[a-z]/.test(value.substring(2))) {
    return { prefix: p, rest: value.substring(2) };
  }
  return { prefix: 'eq', rest: value };
}

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

function dateClause(def, prefix, range) {
  const { lo, hi } = def;
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

function numberClause(col, prefix, text) {
  if (!/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) {
    return null;
  }
  const n = Number(text);
  // implicit precision: "90" means [89.5, 90.5), "90.0" means [89.95, 90.05)
  const dot = text.split(/[eE]/)[0].split('.')[1];
  const half = /[eE]/.test(text) ? 0 : 0.5 * Math.pow(10, -(dot ? dot.length : 0));
  switch (prefix) {
    case 'eq': return half ? { sql: `(${col} >= ? AND ${col} < ?)`, args: [n - half, n + half] } : { sql: `${col} = ?`, args: [n] };
    case 'ne': return half ? { sql: `NOT (${col} >= ? AND ${col} < ?)`, args: [n - half, n + half] } : { sql: `${col} <> ?`, args: [n] };
    case 'gt': case 'sa': return { sql: `${col} > ?`, args: [n] };
    case 'lt': case 'eb': return { sql: `${col} < ?`, args: [n] };
    case 'ge': return { sql: `${col} >= ?`, args: [n] };
    case 'le': return { sql: `${col} <= ?`, args: [n] };
    case 'ap': {
      const d = Math.abs(n) * 0.1;
      return { sql: `(${col} >= ? AND ${col} <= ?)`, args: [n - d, n + d] };
    }
  }
  return null;
}

function valueClause(def, modifier, value) {
  switch (def.type) {
    case 'id':
      return { sql: `${def.col} = ?`, args: [value] };
    case 'string': {
      if (modifier === 'exact') {
        return { sql: `${def.col} = ?`, args: [value] };
      }
      const v = escapeLike(value.toLowerCase());
      return {
        sql: `${def.lc} LIKE ? ESCAPE '\\'`,
        args: [modifier === 'contains' ? `%${v}%` : `${v}%`]
      };
    }
    case 'token': {
      // system|code - these elements are plain codes, so the system is ignored
      const code = value.includes('|') ? value.substring(value.indexOf('|') + 1) : value;
      return { sql: modifier === 'not' ? `(${def.col} IS NULL OR ${def.col} <> ?)` : `${def.col} = ?`, args: [code] };
    }
    case 'uri':
      if (modifier === 'below') {
        return { sql: `${def.col} LIKE ? ESCAPE '\\'`, args: [escapeLike(value) + '%'] };
      }
      return { sql: `${def.col} = ?`, args: [value] };
    case 'participant':
      if (modifier === 'below') {
        return {
          sql: `EXISTS (SELECT 1 FROM participants p WHERE p.report_id = r.id AND p.uri LIKE ? ESCAPE '\\')`,
          args: [escapeLike(value) + '%']
        };
      }
      return { sql: 'EXISTS (SELECT 1 FROM participants p WHERE p.report_id = r.id AND p.uri = ?)', args: [value] };
    case 'number': {
      const { prefix, rest } = splitPrefix(value);
      return numberClause(def.col, prefix, rest);
    }
    case 'date': {
      const { prefix, rest } = splitPrefix(value);
      const range = dateRange(rest);
      return range ? dateClause(def, prefix, range) : null;
    }
  }
  return null;
}

function asList(v) {
  if (v === undefined || v === null) {
    return [];
  }
  return (Array.isArray(v) ? v : [v]).filter(x => typeof x === 'string');
}

function intParam(v, dflt) {
  const s = asList(v)[0];
  if (s === undefined || s === '') {
    return dflt;
  }
  return /^\d+$/.test(s) ? parseInt(s, 10) : NaN;
}

/**
 * Parse a search.
 *
 * @param {Object} query - parsed query string; values are strings or arrays of strings
 * @returns {{
 *   where: string[], args: any[], orderBy: string, count: number, offset: number,
 *   summaryCount: boolean, used: Array<[string,string]>, sort: string|null,
 *   unknown: string[], errors: string[]
 * }}
 */
function parseSearch(query) {
  const result = {
    where: [], args: [], orderBy: 'r.received_ms DESC, r.rowid DESC', count: DEFAULT_COUNT, offset: 0,
    summaryCount: false, used: [], sort: null, unknown: [], errors: []
  };
  for (const [key, raw] of Object.entries(query || {})) {
    if (CONTROL.has(key)) {
      continue;
    }
    const colon = key.indexOf(':');
    const name = colon < 0 ? key : key.substring(0, colon);
    const modifier = colon < 0 ? null : key.substring(colon + 1);
    const def = Object.prototype.hasOwnProperty.call(PARAMS, name) ? PARAMS[name] : null;
    if (!def) {
      result.unknown.push(key);
      continue;
    }
    if (modifier !== null && !MODIFIERS[def.type].includes(modifier)) {
      result.unknown.push(key);
      continue;
    }
    for (const value of asList(raw)) {
      if (value === '') {
        continue;
      }
      if (modifier === 'missing') {
        if (value !== 'true' && value !== 'false') {
          result.errors.push(`${key}: '${value}' is not true or false`);
          continue;
        }
        result.where.push(`${def.col} IS ${value === 'true' ? '' : 'NOT '}NULL`);
        result.used.push([key, value]);
        continue;
      }
      const clauses = [];
      for (const v of splitValues(value)) {
        const c = valueClause(def, modifier, v);
        if (!c) {
          result.errors.push(`${key}: '${v}' is not a valid ${def.type}`);
        } else {
          clauses.push(c);
        }
      }
      if (clauses.length > 0) {
        result.where.push(clauses.length === 1 ? clauses[0].sql : '(' + clauses.map(c => c.sql).join(' OR ') + ')');
        for (const c of clauses) {
          result.args.push(...c.args);
        }
        result.used.push([key, value]);
      }
    }
  }

  // _sort
  const sortSpec = asList(query && query._sort).join(',');
  if (sortSpec) {
    const parts = [];
    for (const item of sortSpec.split(',').map(s => s.trim()).filter(Boolean)) {
      const desc = item.startsWith('-');
      const name = desc ? item.substring(1) : item;
      const def = Object.prototype.hasOwnProperty.call(PARAMS, name) ? PARAMS[name] : null;
      if (!def || !def.sort) {
        result.errors.push(`_sort: cannot sort on '${name}'`);
        continue;
      }
      parts.push(`${def.sort} ${desc ? 'DESC' : 'ASC'}`);
    }
    if (parts.length > 0) {
      result.orderBy = parts.join(', ') + ', r.received_ms DESC, r.rowid DESC';
      result.sort = sortSpec;
    }
  }

  const count = intParam(query && query._count, DEFAULT_COUNT);
  if (Number.isNaN(count)) {
    result.errors.push('_count must be a non-negative integer');
  } else {
    result.count = Math.min(count, MAX_COUNT);
  }
  const offset = intParam(query && query._offset, 0);
  if (Number.isNaN(offset)) {
    result.errors.push('_offset must be a non-negative integer');
  } else {
    result.offset = offset;
  }
  result.summaryCount = asList(query && query._summary)[0] === 'count' || result.count === 0;
  return result;
}

/**
 * The search parameters, for the CapabilityStatement.
 */
function capabilitySearchParams() {
  const docs = {
    _id: 'The logical id of the report',
    name: 'TestReport.name - starts with, case insensitive; :exact, :contains',
    tester: 'TestReport.tester - starts with, case insensitive; :exact, :contains',
    status: 'TestReport.status',
    result: 'TestReport.result',
    testscript: 'TestReport.testScript (canonical, or R4 reference); :below for starts with',
    participant: 'TestReport.participant.uri - any participant; :below for starts with',
    score: 'TestReport.score',
    issued: 'TestReport.issued',
    _lastUpdated: 'When the report was received by this server'
  };
  const types = { id: 'token', string: 'string', token: 'token', uri: 'uri', participant: 'uri', number: 'number', date: 'date' };
  return Object.entries(PARAMS).map(([name, def]) => ({
    name, type: types[def.type], documentation: docs[name]
  }));
}

module.exports = {
  parseSearch, dateRange, splitValues, capabilitySearchParams,
  PARAMS, DEFAULT_COUNT, MAX_COUNT
};
