//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Turn what a search parameter's expression returns into index values, by search parameter
 * type. Each value is an object with the index table it goes in and its columns; systems
 * are left as URIs (the indexer turns them into SpaceKeys).
 *
 *   string     string, markdown, HumanName (every part, and the text), Address (every part,
 *              and the text): normalised (lower case, accents removed) and as written
 *   token      code, Coding, CodeableConcept, Identifier, ContactPoint, boolean, id, uri:
 *              system and code; display or text for :text; an Identifier's type for :of-type
 *   date       date, dateTime, instant, Period, Timing: a [lo, hi) range
 *   number     integer, decimal: a range from the value's precision
 *   quantity   Quantity, Money, Duration, Age...: as number, with system and unit, and in
 *              canonical UCUM form where the unit is UCUM
 *   reference  Reference, canonical, uri: the target type and id when it is a local reference,
 *              else the URL; a reference by identifier as system and value for :identifier
 *   uri        uri, url, canonical: the value
 *
 * @module rest/indexing/values
 */

const { dateRange, periodRange, numberRange } = require('../../library/fhir-search-values');

const MAX_NORM = 255;
const MAX_EXACT = 1024;
const MAX_CODE = 255;
const UCUM = 'http://unitsofmeasure.org';

let ucum = null;
function ucumUtils() {
  if (ucum === null) {
    try {
      ucum = require('@lhncbc/ucum-lhc').UcumLhcUtils.getInstance();
    } catch (e) {
      ucum = false;
    }
  }
  return ucum;
}

/** Lower case, with accents (combining marks) removed */
function normalise(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.substring(0, n) : s;
}

/**
 * The canonical (UCUM base unit) form of a quantity: the magnitude, and the unit as a
 * stable string ("g", "g.m-1.s-2"), or null if the unit isn't UCUM.
 * @param {string} code - a UCUM unit code
 * @param {number} value
 */
function canonicalQuantity(code, value) {
  const u = ucumUtils();
  if (!u || !code) {
    return null;
  }
  try {
    const r = u.convertToBaseUnits(code, value);
    if (!r || r.status !== 'succeeded') {
      return null;
    }
    const unit = Object.keys(r.unitToExp).sort().map(k => r.unitToExp[k] === 1 ? k : `${k}${r.unitToExp[k]}`).join('.');
    return { value: r.magnitude, unit: unit || '1' };
  } catch (e) {
    return null;
  }
}

const RELATIVE_REF = /^([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/([A-Za-z0-9\-.]{1,64}))?$/;

/**
 * Parse a reference string: a local one (type, id, version), or a URL.
 * @param {string} ref
 * @param {string[]} baseUrls - this endpoint's base URLs: an absolute reference to one is local
 * @returns {{local: boolean, type?: string, id?: string, version?: string, url?: string, urlVersion?: string}|null}
 */
function parseReference(ref, baseUrls = []) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('#')) {
    return null;
  }
  let m = RELATIVE_REF.exec(ref);
  if (m) {
    return { local: true, type: m[1], id: m[2], version: m[3] || null };
  }
  for (const base of baseUrls) {
    if (base && ref.startsWith(base.endsWith('/') ? base : base + '/')) {
      m = RELATIVE_REF.exec(ref.substring(base.length + (base.endsWith('/') ? 0 : 1)));
      if (m) {
        return { local: true, type: m[1], id: m[2], version: m[3] || null };
      }
    }
  }
  const bar = ref.lastIndexOf('|');
  if (bar > 0 && !ref.startsWith('urn:')) {
    return { local: false, url: ref.substring(0, bar), urlVersion: ref.substring(bar + 1) || null };
  }
  return { local: false, url: ref, urlVersion: null };
}

function typeName(node) {
  if (node && typeof node.getTypeInfo === 'function') {
    const n = node.getTypeInfo().name;
    return n.startsWith('System.') ? n.substring(7) : n;
  }
  return typeof node;
}

function dataOf(node) {
  return node && typeof node === 'object' && 'data' in node ? node.data : node;
}

function stringValues(type, d, out) {
  const add = (s) => {
    if (s !== undefined && s !== null && s !== '') {
      out.push({ table: 'IndexStrings', Norm: truncate(normalise(s), MAX_NORM), Exact: truncate(s, MAX_EXACT) });
    }
  };
  if (d === null || d === undefined) {
    return;
  }
  if (typeof d !== 'object') {
    add(d);
    return;
  }
  if (type === 'HumanName') {
    add(d.text);
    add(d.family);
    for (const g of d.given || []) {
      add(g);
    }
    for (const p of d.prefix || []) {
      add(p);
    }
    for (const s of d.suffix || []) {
      add(s);
    }
  } else if (type === 'Address') {
    add(d.text);
    for (const l of d.line || []) {
      add(l);
    }
    for (const k of ['city', 'district', 'state', 'postalCode', 'country']) {
      add(d[k]);
    }
  } else if (typeof d.value === 'string') {
    add(d.value);
  }
}

function tokenValues(type, d, out) {
  // concept: a code from a Coding or CodeableConcept, which goes in the closure table
  const add = (system, code, text, implicit, typeSystem, typeCode, concept = false) => {
    if (code === undefined || code === null || code === '') {
      return;
    }
    out.push({
      table: 'IndexTokens', system: system || null, Code: truncate(String(code), MAX_CODE), Implicit: implicit ? 1 : 0,
      TextNorm: text ? truncate(normalise(text), MAX_NORM) : null, typeSystem: typeSystem || null, TypeCode: typeCode || null,
      concept: concept && !!system
    });
  };
  if (d === null || d === undefined) {
    return;
  }
  if (typeof d !== 'object') {
    // code, string, id, boolean, uri...: no system; a code's system is implicit
    add(null, typeof d === 'boolean' ? String(d) : d, null, type === 'code');
    return;
  }
  if (type === 'Coding') {
    add(d.system, d.code, d.display, false, null, null, true);
  } else if (type === 'CodeableConcept' || Array.isArray(d.coding)) {
    const codings = d.coding || [];
    for (const c of codings) {
      add(c.system, c.code, d.text || c.display, false, null, null, true);
    }
    if (codings.length === 0 && d.text) {
      // text only: nothing to match a code, but :text still finds it
      out.push({ table: 'IndexTokens', system: null, Code: '', Implicit: 0, TextNorm: truncate(normalise(d.text), MAX_NORM), typeSystem: null, TypeCode: null });
    }
  } else if (type === 'Identifier') {
    const tc = d.type && d.type.coding && d.type.coding[0];
    add(d.system, d.value, d.type && d.type.text, false, tc && tc.system, tc && tc.code);
  } else if (type === 'ContactPoint') {
    add(d.system, d.value, null);
  } else if (typeof d.value !== 'undefined' && typeof d.value !== 'object') {
    add(d.system, d.value, null);
  } else if (typeof d.code === 'string') {
    add(d.system, d.code, d.display);
  }
}

function dateValues(type, d, out, ctx) {
  if (d === null || d === undefined) {
    return;
  }
  let range = null;
  if (typeof d === 'string') {
    range = dateRange(d, ctx.timeZone);
  } else if (type === 'Period' || (d.start !== undefined || d.end !== undefined)) {
    range = periodRange(d, ctx.timeZone);
  } else if (type === 'Timing' || d.event || d.repeat) {
    const ranges = (d.event || []).map(e => dateRange(e, ctx.timeZone)).filter(r => r);
    if (ranges.length) {
      range = { lo: Math.min(...ranges.map(r => r.lo)), hi: Math.max(...ranges.map(r => r.hi)) };
    } else if (d.repeat && d.repeat.boundsPeriod) {
      range = periodRange(d.repeat.boundsPeriod, ctx.timeZone);
    }
  }
  if (range) {
    out.push({ table: 'IndexDates', Lo: range.lo, Hi: range.hi });
  }
}

function numberValues(type, d, out) {
  const v = d && typeof d === 'object' ? d.value : d;
  if (v === undefined || v === null) {
    return;
  }
  const r = numberRange(v);
  if (r) {
    out.push({ table: 'IndexNumbers', Lo: r.lo, Hi: r.hi, Value: r.value });
  }
}

function quantityValues(type, d, out) {
  if (!d || typeof d !== 'object' || d.value === undefined || d.value === null) {
    return;
  }
  const r = numberRange(d.value);
  if (!r) {
    return;
  }
  const row = {
    table: 'IndexQuantities', Lo: r.lo, Hi: r.hi, Value: r.value, system: d.system || (type === 'Money' ? 'urn:iso:std:iso:4217' : null),
    Unit: d.code || d.currency || d.unit || null, CanonLo: null, CanonHi: null, CanonUnit: null
  };
  if (d.system === UCUM && d.code) {
    const lo = canonicalQuantity(d.code, r.lo);
    const hi = canonicalQuantity(d.code, r.hi);
    if (lo && hi) {
      row.CanonLo = Math.min(lo.value, hi.value);
      row.CanonHi = Math.max(lo.value, hi.value);
      row.CanonUnit = lo.unit;
    }
  }
  out.push(row);
}

function referenceValues(type, d, out, ctx) {
  if (d === null || d === undefined) {
    return;
  }
  const push = (p, ident) => {
    out.push({
      table: 'IndexReferences', local: !!(p && p.local), targetType: p && p.local ? p.type : null, targetId: p && p.local ? p.id : null,
      TargetVersion: p && p.local ? p.version : null, Url: p && !p.local ? truncate(p.url, 512) : null, UrlVersion: p && !p.local ? p.urlVersion : null,
      identSystem: ident ? ident.system || null : null, IdentValue: ident && ident.value ? truncate(ident.value, MAX_CODE) : null
    });
  };
  if (typeof d === 'string') {
    const p = parseReference(d, ctx.baseUrls);
    if (p) {
      push(p, null);
    }
    return;
  }
  if (typeof d === 'object') {
    const p = typeof d.reference === 'string' ? parseReference(d.reference, ctx.baseUrls) : null;
    const ident = d.identifier && d.identifier.value ? d.identifier : null;
    if (p || ident) {
      push(p, ident);
    }
  }
}

function uriValues(type, d, out) {
  if (typeof d === 'string' && d) {
    out.push({ table: 'IndexUris', Value: truncate(d, 512) });
  }
}

/**
 * The index values for what an expression returned.
 * @param {string} spType - the search parameter's type
 * @param {Object[]} nodes - fhirpath.js results (ResourceNodes)
 * @param {Object} ctx - { timeZone, baseUrls }
 * @returns {Object[]}
 */
function extractValues(spType, nodes, ctx) {
  const out = [];
  for (const node of nodes) {
    const type = typeName(node);
    const d = dataOf(node);
    switch (spType) {
      case 'string': stringValues(type, d, out); break;
      case 'token': tokenValues(type, d, out); break;
      case 'date': dateValues(type, d, out, ctx); break;
      case 'number': numberValues(type, d, out); break;
      case 'quantity': quantityValues(type, d, out); break;
      case 'reference': referenceValues(type, d, out, ctx); break;
      case 'uri': uriValues(type, d, out); break;
    }
  }
  return out;
}

module.exports = { extractValues, normalise, parseReference, canonicalQuantity, truncate, MAX_NORM, MAX_EXACT, UCUM };
