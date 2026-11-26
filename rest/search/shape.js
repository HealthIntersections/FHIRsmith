//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * _summary and _elements: the parts of a resource a client asked for. A shortened resource
 * is marked with the SUBSETTED tag.
 *
 * @module rest/search/shape
 */

const { copyNotes } = require('../../library/fhir-json');

const SUBSETTED = { system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationValue', code: 'SUBSETTED', display: 'Resource encoded in summary mode' };
const ALWAYS = new Set(['resourceType', 'id', 'meta', 'implicitRules']);

function markSubsetted(r) {
  r.meta = { ...(r.meta || {}) };
  const tags = (r.meta.tag || []).filter(t => !(t.system === SUBSETTED.system && t.code === SUBSETTED.code));
  r.meta.tag = [...tags, SUBSETTED];
  return r;
}

/** Keep the named elements (choice elements by their stem: value keeps valueQuantity) */
function keep(resource, names) {
  const out = {};
  for (const [k, v] of Object.entries(resource)) {
    if (ALWAYS.has(k) || names.has(k) || [...names].some(n => k.startsWith(n) && /^[A-Z]/.test(k.substring(n.length)))) {
      out[k] = v;
    }
  }
  // numbers kept as they were written (library/fhir-json)
  copyNotes(resource, out);
  return out;
}

/**
 * Shape a resource for _summary / _elements.
 * @param {Object} resource
 * @param {{summary: string|null, elements: string[]|null}} control
 * @param {Object} definitions - summary and mandatory element names by type
 * @returns {Object}
 */
function shape(resource, control, definitions) {
  if (!resource || !control) {
    return resource;
  }
  const type = resource.resourceType;
  const summary = control.summary;
  if (summary === 'true') {
    const names = new Set(definitions.summary.get(type) || []);
    return markSubsetted(keep(resource, names));
  }
  if (summary === 'text') {
    const names = new Set([...(definitions.mandatory.get(type) || []), 'text']);
    return markSubsetted(keep(resource, names));
  }
  if (summary === 'data') {
    const r = { ...resource };
    copyNotes(resource, r);
    delete r.text;
    return markSubsetted(r);
  }
  if (control.elements && control.elements.length) {
    const names = new Set(control.elements.map(e => e.includes('.') ? e.split('.').pop() : e));
    for (const m of definitions.mandatory.get(type) || []) {
      names.add(m);
    }
    return markSubsetted(keep(resource, names));
  }
  return resource;
}

module.exports = { shape, SUBSETTED };
