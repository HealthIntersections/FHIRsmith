//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const { parseDate, documentDate, ageText, documentAgeMarker, relativeAgeMarker } = require('../../ips/age');

const comp = (date, timestamp) => ({ resourceType: 'Bundle', type: 'document', timestamp,
  entry: [{ resource: { resourceType: 'Composition', date } }] });
const DAY = 24 * 60 * 60 * 1000;

describe('document age', () => {
  test('FHIR dates, partial dates and instants', () => {
    expect(parseDate('2026')).toMatchObject({ ms: Date.parse('2026-01-01T00:00:00Z'), timed: false });
    expect(parseDate('2026-05')).toMatchObject({ ms: Date.parse('2026-05-01T00:00:00Z'), timed: false });
    expect(parseDate('2026-05-06T10:00:00+10:00')).toMatchObject({ ms: Date.parse('2026-05-06T00:00:00Z'), timed: true });
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate(undefined)).toBeNull();
  });

  test('the document date: Composition.date, else Bundle.timestamp', () => {
    expect(documentDate(comp('2026-01-01', '2026-02-02T00:00:00Z'))).toBe('2026-01-01');
    expect(documentDate(comp(undefined, '2026-02-02T00:00:00Z'))).toBe('2026-02-02T00:00:00Z');
    expect(documentDate(comp())).toBe('');
  });

  test('ages in words', () => {
    expect(ageText(0.5)).toBe('under a day');
    expect(ageText(1)).toBe('1 day');
    expect(ageText(13)).toBe('13 days');
    expect(ageText(21)).toBe('3 weeks');
    expect(ageText(100)).toBe('3 months');
    expect(ageText(800)).toBe('2.2 years');
  });

  test('the bands', () => {
    const at = (days) => documentAgeMarker(comp('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z') + days * DAY);
    expect(at(2)).toContain('ips-age-fresh');
    expect(at(10)).toContain('ips-age-maturing');
    expect(at(45)).toContain('ips-age-mouldy');
    expect(at(200)).toContain('ips-age-ghost');
    expect(at(400)).toContain('ips-age-fossil');
    expect(at(-1)).toContain('date in the future');
    expect(documentAgeMarker(comp(), Date.now())).toContain('no document date');
  });

  test('against the document: newest wins, after is an error, no date is grey', () => {
    const doc = '2026-10-14T18:00:00Z';
    expect(relativeAgeMarker(['2026-10-12', '2020-01-01'], doc, 'section')).toContain('2 days');
    expect(relativeAgeMarker(['2026-10-15'], doc, 'entry')).toContain('ips-age-error');
    expect(relativeAgeMarker(['2026-10-14T18:00:01Z'], doc, 'entry')).toContain('ips-age-error');
    expect(relativeAgeMarker([''], doc, 'entry')).toContain('ips-age-none');
    expect(relativeAgeMarker(['2026-01-01'], '', 'entry')).toContain('ips-age-none');
  });

  test('a date on the same day as the document is not after it, whatever the time zone', () => {
    // the document is the 14th in Brisbane, the 13th in UTC
    expect(relativeAgeMarker(['2026-10-14'], '2026-10-14T08:00:00+10:00', 'entry')).not.toContain('ips-age-error');
    expect(relativeAgeMarker(['2026-10'], '2026-10-14T08:00:00+10:00', 'entry')).not.toContain('ips-age-error');
  });

  test('titles are escaped', () => {
    expect(relativeAgeMarker(['2026-01-01'], '2026-02-01', 'sec"tion')).not.toContain('sec"tion');
  });
});
