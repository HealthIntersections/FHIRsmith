//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * How old the information in a document is, as a marker that's hard to miss: a bar that
 * fills (on a log scale, up to 2 years) and changes colour with age, an icon for the age
 * band, and the age in words.
 *
 * - the document's age is from its date (Composition.date, else Bundle.timestamp - both
 *   are required, but a document may not have them) to now
 * - a section's age is how much older its newest record is than the document; an entry's is
 *   how much older its record is than the document - when it was recorded, asserted, issued
 *   (structure.js recordedOf), not when what it records happened. A record dated after the
 *   document is an error; one with no record date is greyed out
 *
 * @module ips/age
 */

const escape = require('escape-html');

const DAY = 24 * 60 * 60 * 1000;

// the age bands, by days: up to (not including) max
const BANDS = [
  { max: 7, key: 'fresh', name: 'Fresh', icon: '\u{1F331}' },
  { max: 30, key: 'maturing', name: 'Maturing', icon: '\u{1F9C0}' },
  { max: 90, key: 'mouldy', name: 'Going mouldy', icon: '\u{1F344}' },
  { max: 365, key: 'ghost', name: 'Ghost of meds past', icon: '\u{1F47B}' },
  { max: Infinity, key: 'fossil', name: 'Fossil', icon: '\u{1F9B4}' }
];

const FHIR_DATE = /^(\d{4})(?:-(\d\d)(?:-(\d\d)(?:T(\d\d):(\d\d)(?::(\d\d)(\.\d+)?)?(Z|[+-]\d\d:\d\d)?)?)?)?$/;

/**
 * A FHIR date, dateTime or instant as { ms, timed, value }: ms is the start of it (a partial
 * date is the start of the year or month; a date is midnight UTC), timed whether it has a
 * time. Null if it isn't one.
 */
function parseDate(v) {
  if (typeof v !== 'string') {
    return null;
  }
  const m = FHIR_DATE.exec(v.trim());
  if (!m) {
    return null;
  }
  const timed = m[4] !== undefined;
  const iso = timed ? v.trim() : `${m[1]}-${m[2] || '01'}-${m[3] || '01'}T00:00:00Z`;
  const ms = Date.parse(timed && !m[8] ? `${iso}Z` : iso);
  return Number.isNaN(ms) ? null : { ms, timed, value: v.trim() };
}

/** The document's date, as written: Composition.date, else Bundle.timestamp; '' if neither. */
function documentDate(bundle) {
  const comp = Array.isArray(bundle?.entry) ? bundle.entry[0]?.resource : null;
  if (comp?.resourceType === 'Composition' && parseDate(comp.date)) {
    return comp.date;
  }
  return parseDate(bundle?.timestamp) ? bundle.timestamp : '';
}

/** Where the document's date came from. */
function documentDateSource(bundle) {
  const comp = Array.isArray(bundle?.entry) ? bundle.entry[0]?.resource : null;
  return comp?.resourceType === 'Composition' && parseDate(comp.date) ? 'Composition.date' : 'Bundle.timestamp';
}

function band(days) {
  return BANDS.find(b => days < b.max);
}

/** An age in words. */
function ageText(days) {
  if (days < 1) {
    return 'under a day';
  }
  if (days < 14) {
    const n = Math.floor(days);
    return `${n} day${n === 1 ? '' : 's'}`;
  }
  if (days < 60) {
    return `${Math.floor(days / 7)} weeks`;
  }
  if (days < 730) {
    return `${Math.floor(days / 30.44)} months`;
  }
  return `${(days / 365.25).toFixed(1)} years`;
}

/** How full the bar is, in %: log scale, so the first week shows; full at 2 years. */
function fill(days) {
  return Math.max(4, Math.min(100, Math.round(Math.log(1 + Math.max(0, days)) / Math.log(731) * 100)));
}

function marker(cls, width, icon, words, title, big) {
  return `<span class="ips-age ips-age-${cls}${big ? ' ips-age-big' : ''}" title="${escape(title)}">` +
    `<span class="ips-age-bar"><span style="width: ${width}%"></span></span>` +
    `<span class="ips-age-icon" aria-hidden="true">${icon}</span> ${escape(words)}</span>`;
}

/** The marker for an age in days. */
function ageMarker(days, title, big = false) {
  const b = band(days);
  return marker(b.key, fill(days), b.icon, ageText(days), `${title} - ${b.name}`, big);
}

/** The marker for information with no date. */
function noDateMarker(title = 'No date information') {
  return marker('none', 0, '\u2013', 'no date', title, false);
}

/** The marker for something wrong with the dates. */
function errorMarker(words, title, big = false) {
  return marker('error', 100, '\u26A0', words, title, big);
}

/** The document's age now: from its date to now. */
function documentAgeMarker(bundle, now = Date.now(), big = false) {
  const d = parseDate(documentDate(bundle));
  if (!d) {
    return errorMarker('no document date', 'The document has no date: Composition.date and Bundle.timestamp are both required', big);
  }
  const days = (now - d.ms) / DAY;
  if (days < 0) {
    return errorMarker('date in the future', `The document is dated ${d.value} (${documentDateSource(bundle)}), which is in the future`, big);
  }
  return ageMarker(days, `The document is dated ${d.value} (${documentDateSource(bundle)}): ${ageText(days)} old`, big);
}

/**
 * Whether information dated v is after the document (dated doc). A date with no time is
 * compared with the document's date as written, so a time zone can't make a date on the
 * same day as the document 'after' it.
 */
function isAfter(v, doc) {
  return v.timed && doc.timed ? v.ms > doc.ms : v.value.substring(0, 10) > doc.value.substring(0, Math.min(10, v.value.length));
}

/**
 * The marker for records dated values (when an entry, or the entries in a section, were
 * recorded, raw) against the document's date (raw): how much older the newest of them is
 * than the document.
 */
function relativeAgeMarker(values, docDate, what) {
  const doc = parseDate(docDate);
  const dates = values.map(parseDate).filter(Boolean);
  if (dates.length === 0) {
    return noDateMarker(`No record date in the ${what}`);
  }
  if (!doc) {
    return noDateMarker('The document has no date to compare with');
  }
  const after = dates.filter(d => isAfter(d, doc));
  if (after.length > 0) {
    return errorMarker('after document', `The ${what} has records dated ${after.map(d => d.value).join(', ')}, after the document (${doc.value})`);
  }
  const newest = dates.reduce((a, b) => (b.ms > a.ms ? b : a));
  const days = Math.max(0, (doc.ms - newest.ms) / DAY);
  const which = dates.length > 1 ? 'newest record' : 'record';
  return ageMarker(days, `The ${what}'s ${which} is dated ${newest.value}: ${ageText(days)} older than the document (${doc.value})`);
}

const AGE_STYLE = `
  .ips-age { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; font-size: 90%; }
  .ips-age-bar { display: inline-block; width: 60px; height: 8px; border-radius: 4px; background: #e9ecef; overflow: hidden; }
  .ips-age-bar > span { display: block; height: 100%; border-radius: 4px; }
  .ips-age-icon { font-size: 115%; }
  .ips-age-fresh .ips-age-bar > span { background: #639922; }
  .ips-age-maturing .ips-age-bar > span { background: #1d9e75; }
  .ips-age-mouldy .ips-age-bar > span { background: #ba7517; }
  .ips-age-ghost .ips-age-bar > span { background: #d85a30; }
  .ips-age-fossil .ips-age-bar > span { background: #c82333; }
  .ips-age-error { color: #c82333; font-weight: bold; }
  .ips-age-error .ips-age-bar > span { background: repeating-linear-gradient(45deg, #c82333 0 4px, #f5c6cb 4px 8px); }
  .ips-age-none { color: #adb5bd; }
  .ips-age-big { font-size: 115%; gap: 6px; }
  .ips-age-big .ips-age-bar { width: 120px; height: 12px; border-radius: 6px; }
  .ips-age-big .ips-age-icon { font-size: 150%; }
`;

module.exports = {
  BANDS, AGE_STYLE, parseDate, documentDate, ageText, ageMarker, noDateMarker, errorMarker, documentAgeMarker, relativeAgeMarker
};
