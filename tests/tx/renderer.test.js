const { Renderer } = require('../../tx/library/renderer');
const { Languages } = require('../../library/languages');

/**
 * Build a Renderer whose opContext exposes the languages parsed from an
 * Accept-Language header. Language definitions are passed as null so the
 * BCP-47 parser skips registry validation (we only care about how the parsed
 * language/script/region drive formatting, not whether the subtags are
 * registered). Pass `undefined` to get a context with no languages at all.
 */
function rendererFor(acceptLanguage) {
  let langs;
  if (acceptLanguage === undefined) {
    langs = new Languages(null); // no languages added at all
  } else {
    langs = Languages.fromAcceptLanguage(acceptLanguage, null, false);
  }
  return new Renderer({ langs });
}

describe('Renderer._formatLocale (locale selection)', () => {
  test('returns language-region for a simple tag', () => {
    expect(rendererFor('en-US')._formatLocale()).toBe('en-US');
    expect(rendererFor('en-GB')._formatLocale()).toBe('en-GB');
    expect(rendererFor('fr-FR')._formatLocale()).toBe('fr-FR');
  });

  test('returns language only when no region is present', () => {
    expect(rendererFor('fr')._formatLocale()).toBe('fr');
  });

  test('includes script and region when present', () => {
    expect(rendererFor('zh-Hant-TW')._formatLocale()).toBe('zh-Hant-TW');
  });

  test('honours quality-ordered preference (highest q first)', () => {
    // de-DE has higher quality and should win over fr-FR
    expect(rendererFor('fr-FR;q=0.5,de-DE;q=0.9')._formatLocale()).toBe('de-DE');
  });

  test('skips the wildcard language and falls through to a real one', () => {
    // wildcard has the highest quality but must be ignored for formatting
    expect(rendererFor('*;q=1.0,en-GB;q=0.9')._formatLocale()).toBe('en-GB');
  });

  test('falls back to en-US when only a wildcard is supplied', () => {
    expect(rendererFor('*')._formatLocale()).toBe('en-US');
  });

  test('falls back to en-US when there are no languages', () => {
    expect(rendererFor(undefined)._formatLocale()).toBe('en-US');
  });

  test('does not throw and falls back when opContext has no langs', () => {
    expect(new Renderer({})._formatLocale()).toBe('en-US');
    expect(new Renderer({ langs: null })._formatLocale()).toBe('en-US');
  });
});

describe('Renderer.displayDate (precision handling)', () => {
  const r = rendererFor('en-US');

  test('year only is returned unchanged', () => {
    expect(r.displayDate('2024')).toBe('2024');
    expect(r.displayDate('1900')).toBe('1900');
  });

  test('year-month becomes "Month Year"', () => {
    expect(r.displayDate('2024-03')).toBe('March 2024');
    expect(r.displayDate('2024-12')).toBe('December 2024');
  });

  test('full date is localised with month name', () => {
    const out = r.displayDate('2024-03-15');
    expect(out).toContain('March');
    expect(out).toContain('15');
    expect(out).toContain('2024');
  });

  test('dateTime with Z renders date and time in UTC', () => {
    const out = r.displayDate('2024-03-15T10:30:00Z');
    expect(out).toContain('March');
    expect(out).toContain('2024');
    expect(out).toContain('10:30');
    expect(out).toContain('UTC');
  });

  test('instant with milliseconds renders to the second', () => {
    const out = r.displayDate('2024-03-15T10:30:00.123Z');
    expect(out).toContain('10:30');
    expect(out).toContain('UTC');
  });

  test('dateTime with a numeric offset is normalised to UTC', () => {
    // 10:30 at +10:00 is 00:30 UTC, on the same calendar day
    const out = r.displayDate('2024-03-15T10:30:00+10:00');
    expect(out).toContain('UTC');
    expect(out).toContain('March 15, 2024');
    expect(out).toContain('12:30'); // 00:30 shown as 12:30 AM in en-US
    expect(out).toContain('AM');
  });

  test('dateTime offset can roll the date back across midnight', () => {
    // 05:00 at +10:00 is 19:00 UTC on the PREVIOUS day
    const out = r.displayDate('2024-03-15T05:00:00+10:00');
    expect(out).toContain('March 14, 2024');
    expect(out).toContain('UTC');
  });

  test('dateTime without a timezone is not labelled UTC', () => {
    const out = r.displayDate('2024-03-15T10:30:00');
    expect(out).toContain('March');
    expect(out).toContain('2024');
    expect(out).not.toContain('UTC');
  });
});

describe('Renderer.displayDate (locale-specific formatting)', () => {
  test('US English orders month before day', () => {
    const out = rendererFor('en-US').displayDate('2024-03-15');
    expect(out.indexOf('March')).toBeLessThan(out.indexOf('15'));
  });

  test('UK English orders day before month', () => {
    const out = rendererFor('en-GB').displayDate('2024-03-15');
    expect(out.indexOf('15')).toBeLessThan(out.indexOf('March'));
  });

  test('French uses localised month names', () => {
    expect(rendererFor('fr-FR').displayDate('2024-03')).toBe('mars 2024');
  });

  test('German uses localised month names', () => {
    expect(rendererFor('de-DE').displayDate('2024-03')).toBe('März 2024');
  });

  test('the same instant formats differently per locale but means the same time', () => {
    const us = rendererFor('en-US').displayDate('2024-03-15T10:30:00+10:00');
    const gb = rendererFor('en-GB').displayDate('2024-03-15T10:30:00+10:00');
    expect(us).not.toBe(gb);
    expect(us).toContain('12:30'); // 24h 00:30 -> 12:30 AM
    expect(gb).toContain('00:30'); // GB uses 24h clock
  });
});

describe('Renderer.displayDate (robustness / edge cases)', () => {
  const r = rendererFor('en-US');

  test('empty, null, and undefined yield an empty string', () => {
    expect(r.displayDate('')).toBe('');
    expect(r.displayDate(null)).toBe('');
    expect(r.displayDate(undefined)).toBe('');
  });

  test('non-string input is coerced safely', () => {
    expect(r.displayDate(2024)).toBe('2024');
  });

  test('non-date strings are returned unchanged', () => {
    expect(r.displayDate('not-a-date')).toBe('not-a-date');
    expect(r.displayDate('hello world')).toBe('hello world');
  });

  test('malformed month/day values are returned unchanged (no silent rollover)', () => {
    expect(r.displayDate('2024-13')).toBe('2024-13');     // month 13
    expect(r.displayDate('2024-00')).toBe('2024-00');     // month 0
    expect(r.displayDate('2024-13-45')).toBe('2024-13-45'); // month & day invalid
    expect(r.displayDate('2024-02-30')).toBe('2024-02-30'); // Feb 30 doesn't exist
  });

  test('invalid time components are returned unchanged', () => {
    expect(r.displayDate('2024-03-15T25:99:00Z')).toBe('2024-03-15T25:99:00Z');
  });

  test('leap-day formats correctly', () => {
    const out = r.displayDate('2024-02-29');
    expect(out).toContain('February');
    expect(out).toContain('29');
    // and a non-leap year Feb 29 is rejected
    expect(r.displayDate('2023-02-29')).toBe('2023-02-29');
  });

  test('never throws regardless of input', () => {
    const inputs = ['2024', '2024-03', '2024-03-15', '2024-03-15T10:30:00Z',
      '2024-13-99', 'garbage', '', null, undefined, 42, {}, []];
    for (const v of inputs) {
      expect(() => r.displayDate(v)).not.toThrow();
      expect(typeof r.displayDate(v)).toBe('string');
    }
  });
});
