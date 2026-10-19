//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Indexing and searching IPS documents.
 *
 * Indexing: when a document arrives, every search parameter in search-params.js is
 * evaluated (with fhirpath.js) against the Bundle, its Composition (the first entry) and
 * its Patient (the Composition's subject), and the values go into one index table as
 * rows of (resource, parameter, value). The value columns depend on the type:
 *
 *   string     str (as written) and str_lc (lower case); a HumanName or Address is
 *              split into its parts, so "name" matches any part
 *   token      sys and code; an Identifier's value and a ContactPoint's value are the code
 *   date       lo and hi, the [lo, hi) range in epoch ms; a Period is one row
 *   reference  ref, the reference string as written
 *
 * Searching: a query on Bundle, with the Composition and Patient parameters reached by
 * chaining - composition.date, composition.patient.name, composition.subject.birthdate -
 * becomes SQL over the documents table (alias d) with an EXISTS against the index for
 * each parameter. Comma separated values are ORed, repeated parameters are ANDed, and
 * the usual modifiers apply: :exact and :contains for strings, :not for tokens, :missing
 * for anything. Bundle has _id and _lastUpdated as well; processing-status is this
 * module's own parameter (the document's place in the processing queue).
 *
 * @module ips/search
 */

const fhirpath = require('fhirpath');
const r4Model = require('fhirpath/fhir-context/r4');
const { dateRange, splitPrefix, escapeLike, splitValues, dateClause } = require('../library/fhir-search-values');
const { BY_RESOURCE, CHAINS } = require('./search-params');

const DEFAULT_COUNT = 50;
const MAX_COUNT = 500;
const MAX_STRING = 1024;
// index rows kept for one parameter of one document: a Patient with ten thousand names is
// nobody's patient
const MAX_VALUES_PER_PARAM = 200;
// sort keys in one search
const MAX_SORT_KEYS = 5;

// the processing states a document goes through (store.js moves them along)
const STATUSES = ['submitted', 'processing', 'processed', 'error'];

// parameters that control the search rather than filter it
const CONTROL = new Set(['_sort', '_count', '_offset', '_summary', '_format', '_total', '_pretty']);

const MODIFIERS = {
  string: ['exact', 'contains', 'missing'],
  token: ['not', 'missing'],
  date: ['missing'],
  reference: ['missing'],
  id: [],
  status: ['not']
};

// one end of a Period that is left open
const MIN_MS = -8640000000000000;
const MAX_MS = 8640000000000000;

// ---- the document's parts ------------------------------------------------------------

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The Composition: the first entry's resource, if it is one. */
function compositionOf(bundle) {
  const e = Array.isArray(bundle?.entry) ? bundle.entry[0] : null;
  const r = e?.resource;
  return isObject(r) && r.resourceType === 'Composition' ? r : null;
}

// the lookup tables for a bundle's entries, built once per bundle object: resolving every
// entry reference by scanning every entry is quadratic, and a document is the submitter's
const bundleIndexes = new WeakMap();

/**
 * The lookup tables for a bundle: entries by fullUrl, by Type/id, and fullUrl by resource.
 * @returns {{byFullUrl: Map, byTypeId: Map, fullUrlOf: Map}}
 */
function bundleIndex(bundle) {
  if (!isObject(bundle)) {
    return { byFullUrl: new Map(), byTypeId: new Map(), fullUrlOf: new Map() };
  }
  let idx = bundleIndexes.get(bundle);
  if (!idx) {
    idx = { byFullUrl: new Map(), byTypeId: new Map(), fullUrlOf: new Map() };
    for (const e of Array.isArray(bundle.entry) ? bundle.entry : []) {
      const r = e?.resource;
      if (!isObject(e) || !isObject(r)) {
        continue;
      }
      if (typeof e.fullUrl === 'string') {
        if (!idx.byFullUrl.has(e.fullUrl)) {
          idx.byFullUrl.set(e.fullUrl, r);
        }
        idx.fullUrlOf.set(r, e.fullUrl);
      }
      if (typeof r.resourceType === 'string' && typeof r.id === 'string') {
        const key = `${r.resourceType}/${r.id}`;
        if (!idx.byTypeId.has(key)) {
          idx.byTypeId.set(key, r);
        }
      }
    }
    bundleIndexes.set(bundle, idx);
  }
  return idx;
}

/**
 * The resource an entry reference points to, within the bundle: by fullUrl, or by
 * [Type/]id at the end of the reference.
 */
function resolveInBundle(bundle, reference) {
  if (typeof reference !== 'string' || !Array.isArray(bundle?.entry)) {
    return null;
  }
  const idx = bundleIndex(bundle);
  const direct = idx.byFullUrl.get(reference);
  if (direct) {
    return direct;
  }
  const m = /(?:^|\/)([A-Za-z]+)\/([A-Za-z0-9.-]{1,64})(?:\/_history\/[^/]+)?$/.exec(reference);
  return m ? idx.byTypeId.get(`${m[1]}/${m[2]}`) || null : null;
}

/**
 * The Patient: the Composition's subject, resolved within the bundle; failing that, the
 * first Patient in the bundle.
 */
function patientOf(bundle, composition = compositionOf(bundle)) {
  const ref = composition?.subject?.reference;
  const r = resolveInBundle(bundle, ref);
  if (r && r.resourceType === 'Patient') {
    return r;
  }
  for (const e of Array.isArray(bundle?.entry) ? bundle.entry : []) {
    if (isObject(e?.resource) && e.resource.resourceType === 'Patient') {
      return e.resource;
    }
  }
  return null;
}

// ---- indexing ------------------------------------------------------------------------

function stringParts(v) {
  if (typeof v === 'string') {
    return [v];
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return [String(v)];
  }
  if (!isObject(v)) {
    return [];
  }
  const out = [];
  const add = (x) => {
    if (typeof x === 'string' && x.trim() !== '') {
      out.push(x);
    }
  };
  // HumanName
  add(v.text);
  add(v.family);
  (Array.isArray(v.given) ? v.given : []).forEach(add);
  (Array.isArray(v.prefix) ? v.prefix : []).forEach(add);
  (Array.isArray(v.suffix) ? v.suffix : []).forEach(add);
  // Address
  (Array.isArray(v.line) ? v.line : []).forEach(add);
  add(v.city);
  add(v.district);
  add(v.state);
  add(v.postalCode);
  add(v.country);
  return out;
}

function tokenParts(v) {
  if (typeof v === 'boolean' || typeof v === 'number') {
    return [{ sys: null, code: String(v) }];
  }
  if (typeof v === 'string') {
    return v === '' ? [] : [{ sys: null, code: v }];
  }
  if (!isObject(v)) {
    return [];
  }
  if (Array.isArray(v.coding)) {
    // CodeableConcept
    return v.coding.flatMap(tokenParts);
  }
  const sys = typeof v.system === 'string' ? v.system : null;
  // Coding has code; Identifier and ContactPoint have value
  const code = typeof v.code === 'string' ? v.code : (typeof v.value === 'string' ? v.value : null);
  return code ? [{ sys, code }] : [];
}

function dateParts(v) {
  if (typeof v === 'string') {
    const r = dateRange(v);
    return r ? [r] : [];
  }
  if (isObject(v) && (typeof v.start === 'string' || typeof v.end === 'string')) {
    // Period
    const s = typeof v.start === 'string' ? dateRange(v.start) : null;
    const e = typeof v.end === 'string' ? dateRange(v.end) : null;
    if (!s && !e) {
      return [];
    }
    return [{ lo: s ? s.lo : MIN_MS, hi: e ? e.hi : MAX_MS }];
  }
  return [];
}

function referenceParts(v) {
  if (typeof v === 'string') {
    return v === '' ? [] : [v];
  }
  if (isObject(v) && typeof v.reference === 'string' && v.reference !== '') {
    return [v.reference];
  }
  return [];
}

function evaluate(resource, expression) {
  try {
    return fhirpath.evaluate(resource, expression, null, r4Model);
  } catch {
    // an expression that fails on this resource indexes nothing; the document is still stored
    return [];
  }
}

/**
 * Index rows for one resource against one table of parameters.
 * @returns {Array<{res, param, type, str, str_lc, sys, code, lo, hi, ref}>}
 */
function indexResource(res, resource, params) {
  const rows = [];
  const row = (param, type, v) => rows.push({
    res, param, type,
    str: null, str_lc: null, sys: null, code: null, lo: null, hi: null, ref: null, ...v
  });
  for (const [param, def] of Object.entries(params)) {
    const values = evaluate(resource, def.expression).slice(0, MAX_VALUES_PER_PARAM);
    const before = rows.length;
    for (const v of values) {
      if (rows.length - before >= MAX_VALUES_PER_PARAM) {
        break;
      }
      switch (def.type) {
        case 'string':
          for (const s of stringParts(v)) {
            const t = s.substring(0, MAX_STRING);
            row(param, 'string', { str: t, str_lc: t.toLowerCase() });
          }
          break;
        case 'token':
          for (const t of tokenParts(v)) {
            row(param, 'token', { sys: t.sys, code: t.code.substring(0, MAX_STRING) });
          }
          break;
        case 'date':
          for (const d of dateParts(v)) {
            row(param, 'date', { lo: d.lo, hi: d.hi });
          }
          break;
        case 'reference':
          for (const r of referenceParts(v)) {
            row(param, 'reference', { ref: r.substring(0, MAX_STRING) });
          }
          break;
      }
    }
  }
  return rows;
}

/**
 * All the index rows for a document.
 *
 * @param {Object} bundle - the document, as it will be stored (with its server id)
 * @returns {Array} rows for the index table (without the doc_id)
 */
function indexDocument(bundle) {
  const rows = [];
  // Bundle.composition: the expression yields the resource itself, so it is done by hand
  const { composition: compDef, ...bundleParams } = BY_RESOURCE.Bundle;
  rows.push(...indexResource('Bundle', bundle, bundleParams));
  const comp = compositionOf(bundle);
  if (comp) {
    const refs = [];
    if (typeof bundle.entry[0].fullUrl === 'string') {
      refs.push(bundle.entry[0].fullUrl);
    }
    if (typeof comp.id === 'string') {
      refs.push('Composition/' + comp.id);
    }
    for (const ref of refs) {
      rows.push({ res: 'Bundle', param: 'composition', type: compDef.type, str: null, str_lc: null, sys: null, code: null, lo: null, hi: null, ref });
    }
    rows.push(...indexResource('Composition', comp, BY_RESOURCE.Composition));
    const patient = patientOf(bundle, comp);
    if (patient) {
      rows.push(...indexResource('Patient', patient, BY_RESOURCE.Patient));
    }
  }
  return rows;
}

// ---- searching -----------------------------------------------------------------------

/**
 * Work out which resource and parameter a (possibly chained) parameter name refers to.
 * composition.patient.name -> Patient / name. A :Type on a chain link is ignored.
 *
 * @returns {{res: string, param: string, def: Object}|null}
 */
function resolveParam(name) {
  const parts = name.split('.').map(p => p.replace(/:.*$/, ''));
  let res = 'Bundle';
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (res === 'Bundle') {
      const chain = Object.prototype.hasOwnProperty.call(CHAINS, p) ? CHAINS[p] : null;
      if (!chain) {
        return null;
      }
      res = chain.resource;
    } else {
      const chain = CHAINS.composition;
      if (res !== chain.resource || !Object.prototype.hasOwnProperty.call(chain.via, p)) {
        return null;
      }
      res = chain.via[p];
    }
  }
  const param = parts[parts.length - 1];
  const table = BY_RESOURCE[res];
  if (!Object.prototype.hasOwnProperty.call(table, param)) {
    return null;
  }
  return { res, param, def: table[param] };
}

/** The condition on one index row for one value. null if the value is not valid. */
function valueCondition(def, modifier, value) {
  switch (def.type) {
    case 'string': {
      if (modifier === 'exact') {
        return { sql: 'i.str = ?', args: [value] };
      }
      const v = escapeLike(value.toLowerCase());
      return { sql: "i.str_lc LIKE ? ESCAPE '\\'", args: [modifier === 'contains' ? `%${v}%` : `${v}%`] };
    }
    case 'token': {
      const bar = value.indexOf('|');
      if (bar < 0) {
        return { sql: 'i.code = ?', args: [value] };
      }
      const sys = value.substring(0, bar);
      const code = value.substring(bar + 1);
      if (code === '') {
        return { sql: 'i.sys = ?', args: [sys] };
      }
      if (sys === '') {
        return { sql: '(i.sys IS NULL AND i.code = ?)', args: [code] };
      }
      return { sql: '(i.sys = ? AND i.code = ?)', args: [sys, code] };
    }
    case 'date': {
      const { prefix, rest } = splitPrefix(value);
      const range = dateRange(rest);
      return range ? dateClause({ lo: 'i.lo', hi: 'i.hi' }, prefix, range) : null;
    }
    case 'reference': {
      // as written, or Type/id (or just id) at the end of what was written
      const tail = escapeLike(value);
      return { sql: "(i.ref = ? OR i.ref LIKE ? ESCAPE '\\')", args: [value, `%/${tail}`] };
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

// the index rows of one parameter, for a document; the arguments are (res, param)
const INDEXED = 'SELECT 1 FROM ips_index i WHERE i.doc_id = d.id AND i.res = ? AND i.param = ?';

/**
 * Parse a search over one project's documents.
 *
 * @param {Object} query - parsed query string; values are strings or arrays of strings
 * @returns {{
 *   where: string[], args: any[], orderBy: string, orderArgs: any[], count: number, offset: number,
 *   summaryCount: boolean, used: Array<[string,string]>, sort: string|null,
 *   unknown: string[], errors: string[]
 * }} where/args don't include the project - the store adds that
 */
function parseSearch(query) {
  const result = {
    where: [], args: [], orderBy: 'd.id DESC', orderArgs: [], count: DEFAULT_COUNT, offset: 0,
    summaryCount: false, used: [], sort: null, unknown: [], errors: []
  };
  for (const [key, raw] of Object.entries(query || {})) {
    if (CONTROL.has(key)) {
      continue;
    }
    const colon = key.indexOf(':');
    const name = colon < 0 ? key : key.substring(0, colon);
    const modifier = colon < 0 ? null : key.substring(colon + 1);
    const values = asList(raw).filter(v => v !== '');
    if (values.length === 0) {
      continue;
    }

    // the Bundle's own, non-indexed parameters
    if (name === '_id' || name === '_lastUpdated' || name === 'processing-status') {
      const type = name === '_id' ? 'id' : (name === '_lastUpdated' ? 'date' : 'status');
      if (modifier !== null && !(type === 'status' && modifier === 'not') && !(type === 'date' && modifier === 'missing')) {
        result.unknown.push(key);
        continue;
      }
      for (const value of values) {
        const clauses = [];
        for (const v of splitValues(value)) {
          if (type === 'id') {
            clauses.push(/^\d{1,18}$/.test(v) ? { sql: 'd.id = ?', args: [parseInt(v, 10)] } : { sql: '0', args: [] });
          } else if (type === 'status') {
            if (!STATUSES.includes(v)) {
              result.errors.push(`${key}: '${v}' is not a processing status (${STATUSES.join(', ')})`);
            } else {
              clauses.push({ sql: 'd.status = ?', args: [v] });
            }
          } else if (modifier === 'missing') {
            clauses.push({ sql: v === 'true' ? '0' : '1', args: [] });
          } else {
            const { prefix, rest } = splitPrefix(v);
            const range = dateRange(rest);
            const c = range ? dateClause({ lo: 'd.received_ms', hi: '(d.received_ms + 1)' }, prefix, range) : null;
            if (!c) {
              result.errors.push(`${key}: '${v}' is not a valid date`);
            } else {
              clauses.push(c);
            }
          }
        }
        if (clauses.length > 0) {
          const sql = clauses.length === 1 ? clauses[0].sql : '(' + clauses.map(c => c.sql).join(' OR ') + ')';
          result.where.push(modifier === 'not' ? `NOT ${sql}` : sql);
          clauses.forEach(c => result.args.push(...c.args));
          result.used.push([key, value]);
        }
      }
      continue;
    }

    const target = resolveParam(name);
    if (!target) {
      result.unknown.push(key);
      continue;
    }
    const { res, param, def } = target;
    if (modifier !== null && !MODIFIERS[def.type].includes(modifier)) {
      result.unknown.push(key);
      continue;
    }
    for (const value of values) {
      if (modifier === 'missing') {
        if (value !== 'true' && value !== 'false') {
          result.errors.push(`${key}: '${value}' is not true or false`);
          continue;
        }
        result.where.push(`${value === 'true' ? 'NOT ' : ''}EXISTS (${INDEXED})`);
        result.args.push(res, param);
        result.used.push([key, value]);
        continue;
      }
      const conds = [];
      for (const v of splitValues(value)) {
        const c = valueCondition(def, modifier, v);
        if (!c) {
          result.errors.push(`${key}: '${v}' is not a valid ${def.type}`);
        } else {
          conds.push(c);
        }
      }
      if (conds.length > 0) {
        const inner = conds.length === 1 ? conds[0].sql : '(' + conds.map(c => c.sql).join(' OR ') + ')';
        result.where.push(`${modifier === 'not' ? 'NOT ' : ''}EXISTS (${INDEXED} AND ${inner})`);
        result.args.push(res, param);
        conds.forEach(c => result.args.push(...c.args));
        result.used.push([key, value]);
      }
    }
  }

  // _sort: _id, _lastUpdated, processing-status, or any indexed parameter (by its first value)
  const sortSpec = asList(query && query._sort).join(',');
  if (sortSpec) {
    const parts = [];
    const items = [...new Set(sortSpec.split(',').map(s => s.trim()).filter(Boolean))];
    if (items.length > MAX_SORT_KEYS) {
      result.errors.push(`_sort: at most ${MAX_SORT_KEYS} sort keys`);
      items.length = 0;
    }
    for (const item of items) {
      const desc = item.startsWith('-');
      const name = desc ? item.substring(1) : item;
      const dir = desc ? 'DESC' : 'ASC';
      if (name === '_id' || name === '_lastUpdated') {
        parts.push(`d.id ${dir}`);
        continue;
      }
      if (name === 'processing-status') {
        parts.push(`d.status ${dir}`);
        continue;
      }
      const target = resolveParam(name);
      if (!target) {
        result.errors.push(`_sort: cannot sort on '${name}'`);
        continue;
      }
      const col = { string: 'i.str_lc', token: 'i.code', date: 'i.lo', reference: 'i.ref' }[target.def.type];
      parts.push(`(SELECT MIN(${col}) FROM ips_index i WHERE i.doc_id = d.id AND i.res = ? AND i.param = ?) ${dir}`);
      result.orderArgs.push(target.res, target.param);
    }
    if (parts.length > 0) {
      result.orderBy = parts.join(', ') + ', d.id DESC';
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
 * Turn the project page's filter form (name, gender, date, identifier, status) into a
 * FHIR search query. Other keys pass through, so the page also accepts the API's
 * parameters.
 *
 *   name        any part of the patient's name (contains)
 *   gender      the patient's gender
 *   date        the Composition's date (a day)
 *   identifier  part of the document id, or of a patient identifier's value - not a
 *               FHIR parameter; parseSearch doesn't know it, so the store adds it
 *   status      processing status
 */
function listQueryToSearch(query) {
  const out = {};
  const add = (k, v) => {
    if (out[k] === undefined) {
      out[k] = v;
    } else {
      out[k] = [].concat(out[k], v);
    }
  };
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  for (const [k, raw] of Object.entries(query || {})) {
    const v = first(raw);
    if (typeof v !== 'string') {
      continue;
    }
    const t = v.trim();
    switch (k) {
      case 'name':
        if (t) add('composition.patient.name:contains', t);
        break;
      case 'gender':
        if (t) add('composition.patient.gender', t);
        break;
      case 'date':
        if (t) add('composition.date', t);
        break;
      case 'status':
        if (t) add('processing-status', t);
        break;
      case 'identifier':
        // handled by the store (see identifierClause)
        break;
      default:
        add(k, raw);
    }
  }
  return out;
}

/**
 * The web filter's identifier: part of the document's id, or of any patient identifier.
 * @returns {{sql: string, args: any[]}|null}
 */
function identifierClause(value) {
  const t = typeof value === 'string' ? value.trim() : '';
  if (!t) {
    return null;
  }
  const like = `%${escapeLike(t)}%`;
  return {
    sql: "(CAST(d.id AS TEXT) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM ips_index i WHERE i.doc_id = d.id AND i.res = 'Patient' AND i.param = 'identifier' AND i.code LIKE ? ESCAPE '\\'))",
    args: [like, like]
  };
}

/**
 * The search parameters, for the CapabilityStatement: the Bundle ones, plus the chains
 * as documentation.
 */
function capabilitySearchParams() {
  const out = [
    { name: '_id', type: 'token', documentation: 'The id this server gave the document' },
    { name: '_lastUpdated', type: 'date', documentation: 'When the document was received by this server' },
    { name: 'processing-status', type: 'token', documentation: `Where the document is in processing: ${STATUSES.join(' | ')}` }
  ];
  for (const [name, def] of Object.entries(BY_RESOURCE.Bundle)) {
    out.push({ name, type: def.type, documentation: def.description });
  }
  const chained = [];
  for (const [name, def] of Object.entries(BY_RESOURCE.Composition)) {
    chained.push({ name: `composition.${name}`, type: def.type, documentation: def.description });
  }
  for (const [name, def] of Object.entries(BY_RESOURCE.Patient)) {
    chained.push({ name: `composition.patient.${name}`, type: def.type, documentation: def.description });
  }
  return out.concat(chained);
}

module.exports = {
  indexDocument, parseSearch, listQueryToSearch, identifierClause, capabilitySearchParams, resolveParam,
  compositionOf, patientOf, resolveInBundle, bundleIndex, STATUSES, DEFAULT_COUNT, MAX_COUNT, MAX_VALUES_PER_PARAM
};
