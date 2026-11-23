//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Date and time search boundaries (library/fhir-search-values.js), shared by the rest and ips
 * modules: every precision, every prefix against every kind of target 1 ms either side of
 * each boundary, zone offsets, daylight saving, 29 February, years 0001 to 0099, leap seconds,
 * and the specification's examples.
 */

const {
  dateRange, periodRange, approxDateRange, numberRange, splitPrefix, splitValues, dateClause, rangeMatches,
  escapeLikeBang, MIN_INSTANT, MAX_INSTANT
} = require('../../library/fhir-search-values');

const U = (s) => Date.parse(s);
const PREFIXES = ['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'sa', 'eb', 'ap'];

describe('dateRange: each precision is a half-open range', () => {
  test.each([
    ['2013', '2013-01-01T00:00:00.000Z', '2014-01-01T00:00:00.000Z'],
    ['2013-02', '2013-02-01T00:00:00.000Z', '2013-03-01T00:00:00.000Z'],
    ['2012-02', '2012-02-01T00:00:00.000Z', '2012-03-01T00:00:00.000Z'],
    ['2013-12', '2013-12-01T00:00:00.000Z', '2014-01-01T00:00:00.000Z'],
    ['2013-01-31', '2013-01-31T00:00:00.000Z', '2013-02-01T00:00:00.000Z'],
    ['2012-02-29', '2012-02-29T00:00:00.000Z', '2012-03-01T00:00:00.000Z'],
    ['2013-01-14T10:00Z', '2013-01-14T10:00:00.000Z', '2013-01-14T10:01:00.000Z'],
    ['2013-01-14T10:00:00Z', '2013-01-14T10:00:00.000Z', '2013-01-14T10:00:01.000Z'],
    ['2013-01-14T10:00:00.5Z', '2013-01-14T10:00:00.500Z', '2013-01-14T10:00:00.600Z'],
    ['2013-01-14T10:00:00.50Z', '2013-01-14T10:00:00.500Z', '2013-01-14T10:00:00.510Z'],
    ['2013-01-14T10:00:00.500Z', '2013-01-14T10:00:00.500Z', '2013-01-14T10:00:00.501Z'],
    ['2013-01-14T10:00:00.5001Z', '2013-01-14T10:00:00.500Z', '2013-01-14T10:00:00.501Z'],
    ['2013-01-14T10:00:00+10:00', '2013-01-14T00:00:00.000Z', '2013-01-14T00:00:01.000Z'],
    ['2013-01-14T10:00:00-05:30', '2013-01-14T15:30:00.000Z', '2013-01-14T15:30:01.000Z']
  ])('%s', (v, lo, hi) => {
    expect(dateRange(v)).toEqual({ lo: U(lo), hi: U(hi) });
  });

  test('not dates', () => {
    for (const v of ['', '13', '2013-13', '2013-02-29', '2013-01-32', '2013-01-14T24:00:00Z', '2013-01-14T10:60:00Z',
      '2013-01-14T10:00:61Z', '2013-01-14T10:00:00+15:00', '2013-01-14T10:00:00+10:60', 'today', '2013/01/14', 2013, null]) {
      expect(dateRange(v)).toBeNull();
    }
  });

  test('years 0001 to 0099 are those years, not 1901 to 1999', () => {
    for (const y of [1, 9, 10, 50, 99]) {
      const s = String(y).padStart(4, '0');
      const r = dateRange(s);
      expect(new Date(r.lo).getUTCFullYear()).toBe(y);
      expect(new Date(r.hi).getUTCFullYear()).toBe(y + 1);
      const d = dateRange(`${s}-03-01T12:00:00Z`);
      expect(new Date(d.lo).getUTCFullYear()).toBe(y);
      expect(new Date(d.lo).getUTCHours()).toBe(12);
    }
    // 0004 was a leap year (proleptic Gregorian), 0100 wasn't
    expect(dateRange('0004-02-29')).not.toBeNull();
    expect(dateRange('0100-02-29')).toBeNull();
    expect(dateRange('2000-02-29')).not.toBeNull();
    expect(dateRange('1900-02-29')).toBeNull();
  });

  test('a leap second is the last second of its minute', () => {
    const r = dateRange('2016-12-31T23:59:60Z');
    expect(r).toEqual({ lo: U('2016-12-31T23:59:59.000Z'), hi: U('2017-01-01T00:00:00.000Z') });
    expect(dateRange('2016-12-31T23:58:60Z')).toBeNull();
    expect(dateRange('2016-12-31T23:59:60.5Z')).toEqual({ lo: U('2016-12-31T23:59:59.500Z'), hi: U('2016-12-31T23:59:59.600Z') });
  });

  test('every zone offset from -14:00 to +14:00', () => {
    for (let mins = -14 * 60; mins <= 14 * 60; mins += 15) {
      const sign = mins < 0 ? '-' : '+';
      const a = Math.abs(mins);
      const tz = `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
      const r = dateRange(`2020-06-15T12:00:00${tz}`);
      expect(r.lo).toBe(U('2020-06-15T12:00:00Z') - mins * 60000);
      expect(r.hi - r.lo).toBe(1000);
    }
  });

  test('dates without a zone are in the endpoint\'s zone, daylight saving included', () => {
    // Melbourne: AEDT (+11) ends 2026-04-05 03:00 -> AEST (+10): a 25 hour day
    const end = dateRange('2026-04-05', 'Australia/Melbourne');
    expect(end.lo).toBe(U('2026-04-04T13:00:00Z'));
    expect(end.hi).toBe(U('2026-04-05T14:00:00Z'));
    expect(end.hi - end.lo).toBe(25 * 3600000);
    // and starts 2026-10-04 02:00: a 23 hour day
    const start = dateRange('2026-10-04', 'Australia/Melbourne');
    expect(start.hi - start.lo).toBe(23 * 3600000);
    // New York, a month, across the March change
    const march = dateRange('2026-03', 'America/New_York');
    expect(march.lo).toBe(U('2026-03-01T05:00:00Z'));
    expect(march.hi).toBe(U('2026-04-01T04:00:00Z'));
    // a time with no zone
    expect(dateRange('2026-01-15T09:00:00', 'Australia/Melbourne').lo).toBe(U('2026-01-14T22:00:00Z'));
    expect(dateRange('2026-07-15T09:00:00', 'Australia/Melbourne').lo).toBe(U('2026-07-14T23:00:00Z'));
    // a zone in the value wins over the endpoint's
    expect(dateRange('2026-07-15T09:00:00Z', 'Australia/Melbourne').lo).toBe(U('2026-07-15T09:00:00Z'));
    // no zone at all: UTC
    expect(dateRange('2026-07-15').lo).toBe(U('2026-07-15T00:00:00Z'));
  });

  test('a year in a zone east of UTC starts the day before in UTC', () => {
    const r = dateRange('2020', 'Pacific/Kiritimati');
    expect(r.lo).toBe(U('2019-12-31T10:00:00Z'));
  });
});

describe('periodRange', () => {
  test('closed, and open at either end', () => {
    expect(periodRange({ start: '2013-01-10', end: '2013-01-21' })).toEqual({ lo: U('2013-01-10T00:00:00Z'), hi: U('2013-01-22T00:00:00Z') });
    expect(periodRange({ start: '2013-01-10' })).toEqual({ lo: U('2013-01-10T00:00:00Z'), hi: MAX_INSTANT });
    expect(periodRange({ end: '2013-01-21' })).toEqual({ lo: MIN_INSTANT, hi: U('2013-01-22T00:00:00Z') });
    expect(periodRange({})).toBeNull();
    expect(periodRange({ start: 'junk' })).toBeNull();
  });
});

/**
 * Each prefix against a target range moved 1 ms either side of the search range's edges.
 * The expected results come from the specification's definitions, written out here
 * independently of rangeMatches.
 */
describe('prefixes at the boundaries', () => {
  const search = dateRange('2013-01-14');
  const ms = 1;
  const { lo, hi } = search;
  // targets: [name, range]
  const targets = [
    ['the same day', { lo, hi }],
    ['an instant at the start', { lo, hi: lo + ms }],
    ['an instant at the last ms', { lo: hi - ms, hi }],
    ['an instant 1 ms before', { lo: lo - ms, hi: lo }],
    ['an instant at the end (next day)', { lo: hi, hi: hi + ms }],
    ['starting 1 ms early', { lo: lo - ms, hi }],
    ['ending 1 ms late', { lo, hi: hi + ms }],
    ['the year', dateRange('2013')],
    ['an open period from the day', { lo, hi: MAX_INSTANT }],
    ['an open period up to the day', { lo: MIN_INSTANT, hi }],
    ['the day before', dateRange('2013-01-13')],
    ['the day after', dateRange('2013-01-15')]
  ];
  // the specification: eq - the target is within the search range; gt - the target extends
  // past its end; lt - the target starts before its start; ge/le - gt or overlaps / lt or
  // overlaps; sa - starts after its end; eb - ends before its start; ne - not eq
  const expected = (p, t) => {
    const within = t.lo >= lo && t.hi <= hi;
    const overlaps = t.lo < hi && t.hi > lo;
    switch (p) {
      case 'eq': return within;
      case 'ne': return !within;
      case 'gt': return t.hi > hi;
      case 'lt': return t.lo < lo;
      case 'ge': return t.hi > hi || overlaps;
      case 'le': return t.lo < lo || overlaps;
      case 'sa': return t.lo >= hi;
      case 'eb': return t.hi <= lo;
      case 'ap': return overlaps;
    }
    return null;
  };
  for (const p of PREFIXES) {
    for (const [name, t] of targets) {
      test(`${p}2013-01-14 against ${name}`, () => {
        expect(rangeMatches(p, t, search)).toBe(expected(p, t));
      });
    }
  }

  test('the specification\'s examples', () => {
    const m = (v, target) => {
      const { prefix, rest } = splitPrefix(v);
      return rangeMatches(prefix, target, dateRange(rest));
    };
    // [parameter]=eq2013-01-14 matches 2013-01-14T10:00 but not 2013-01-15T00:00 ...
    expect(m('eq2013-01-14', dateRange('2013-01-14T10:00:00Z'))).toBe(true);
    expect(m('eq2013-01-14', dateRange('2013-01-15T00:00:00Z'))).toBe(false);
    // ne2013-01-14 matches 2013-01-15T00:00 but not 2013-01-14T10:00
    expect(m('ne2013-01-14', dateRange('2013-01-15T00:00:00Z'))).toBe(true);
    expect(m('ne2013-01-14', dateRange('2013-01-14T10:00:00Z'))).toBe(false);
    // lt2013-01-14T10:00 matches 2013-01-14 (the day starts before 10:00)
    expect(m('lt2013-01-14T10:00:00Z', dateRange('2013-01-14'))).toBe(true);
    // gt2013-01-14T10:00 matches 2013-01-14 too (the day ends after)
    expect(m('gt2013-01-14T10:00:00Z', dateRange('2013-01-14'))).toBe(true);
    // a Period 2013-01-10 to 2013-01-21 is not eq 2013-01-14, but is ge and le
    const period = periodRange({ start: '2013-01-10', end: '2013-01-21' });
    expect(m('eq2013-01-14', period)).toBe(false);
    expect(m('ge2013-01-14', period)).toBe(true);
    expect(m('le2013-01-14', period)).toBe(true);
    expect(m('sa2013-01-09', period)).toBe(true);
    expect(m('sa2013-01-10', period)).toBe(false);
    expect(m('eb2013-01-22', period)).toBe(true);
    expect(m('eb2013-01-21', period)).toBe(false);
  });
});

describe('dateClause agrees with rangeMatches', () => {
  // evaluate the SQL fragment in JavaScript: the clauses are simple comparisons
  const evaluate = (clause, t) => {
    let i = 0;
    const js = clause.sql.replace(/\?/g, () => JSON.stringify(clause.args[i++]))
      .replace(/\bLO\b/g, String(t.lo)).replace(/\bHI\b/g, String(t.hi))
      .replace(/\bAND\b/g, '&&').replace(/\bNOT\b/g, '!').replace(/([^<>!=])=([^=])/g, '$1===$2');
    return Function(`return (${js});`)();
  };
  const search = dateRange('2020-02-29');
  const targets = [dateRange('2020-02-29T12:00:00Z'), dateRange('2020-02'), dateRange('2020-03-01'), dateRange('2020-02-28'),
    { lo: search.lo - 1, hi: search.lo }, { lo: search.hi, hi: search.hi + 1 }, { lo: MIN_INSTANT, hi: MAX_INSTANT }];
  for (const p of PREFIXES) {
    test(p, () => {
      for (const t of targets) {
        const c = dateClause({ lo: 'LO', hi: 'HI' }, p, search);
        expect(evaluate(c, t)).toBe(rangeMatches(p, t, search));
      }
    });
  }
});

describe('approxDateRange', () => {
  test('at least a day either side', () => {
    const r = dateRange('2020-01-01');
    const now = r.lo + 3600000;
    const a = approxDateRange(r, now);
    expect(a.lo).toBe(r.lo - 86400000);
    expect(a.hi).toBe(r.hi + 86400000);
  });

  test('10% of the distance from now', () => {
    const r = dateRange('2000-01-01');
    const now = U('2010-01-01T12:00:00Z');
    const a = approxDateRange(r, now);
    const mid = (r.lo + r.hi) / 2;
    expect(r.lo - a.lo).toBeCloseTo((now - mid) * 0.1, 0);
  });
});

describe('numbers, prefixes, values', () => {
  test('numberRange from precision', () => {
    expect(numberRange('100')).toEqual({ lo: 99.5, hi: 100.5, value: 100 });
    const r = numberRange('1.5');
    expect(r.lo).toBeCloseTo(1.45);
    expect(r.hi).toBeCloseTo(1.55);
    expect(numberRange('1e2')).toEqual({ lo: 50, hi: 150, value: 100 });
    expect(numberRange('-2')).toEqual({ lo: -2.5, hi: -1.5, value: -2 });
    expect(numberRange('x')).toBeNull();
    expect(numberRange('1.')).toBeNull();
  });

  test('splitPrefix', () => {
    expect(splitPrefix('ge2013')).toEqual({ prefix: 'ge', rest: '2013' });
    expect(splitPrefix('2013')).toEqual({ prefix: 'eq', rest: '2013' });
    // a value that starts with letters isn't a prefix
    expect(splitPrefix('label')).toEqual({ prefix: 'eq', rest: 'label' });
    expect(splitPrefix('eb')).toEqual({ prefix: 'eq', rest: 'eb' });
  });

  test('splitValues and escapeLikeBang', () => {
    expect(splitValues('a,b\\,c,,d')).toEqual(['a', 'b,c', 'd']);
    expect(escapeLikeBang('50%_off!')).toBe('50!%!_off!!');
  });
});
