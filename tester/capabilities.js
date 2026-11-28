//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * What the server under test says it supports, from its CapabilityStatement: the tests only
 * test that, and say so when they don't run.
 *
 * @module tester/capabilities
 */

// R5's CapabilityStatement.rest.resource.conditionalPatch, as an R4 statement can say it
const XVER_CONDITIONAL_PATCH = 'http://hl7.org/fhir/5.0/StructureDefinition/extension-CapabilityStatement.rest.resource.conditionalPatch';

class Capabilities {
  /**
   * @param {Object} cs - the CapabilityStatement
   */
  constructor(cs) {
    this.cs = cs || {};
    this.rest = (this.cs.rest || []).find(r => r && r.mode === 'server') || (this.cs.rest || [])[0] || {};
    this.resources = new Map();
    for (const r of this.rest.resource || []) {
      if (r && r.type) {
        this.resources.set(r.type, r);
      }
    }
  }

  /** 'R4' (4.0.x), 'R5' (5.0.x), or null for anything else */
  get release() {
    const v = String(this.cs.fhirVersion || '');
    if (/^4\.0\./.test(v) || v === '4.0') {
      return 'R4';
    }
    if (/^5\.0\./.test(v) || v === '5.0') {
      return 'R5';
    }
    return null;
  }

  get fhirVersion() {
    return this.cs.fhirVersion || null;
  }

  /** Whether the server says it does a format: 'json' or 'xml' */
  format(f) {
    const list = (this.cs.format || []).map(x => String(x).toLowerCase());
    return list.some(x => x === f || x === `application/fhir+${f}` || x === `application/${f}` || x === `${f}+fhir` || x.endsWith('/' + f) || x.endsWith('+' + f));
  }

  /** The software, for the report: "name version" */
  get software() {
    const s = this.cs.software || {};
    return [s.name, s.version].filter(Boolean).join(' ') || this.cs.name || null;
  }

  hasType(type) {
    return this.resources.has(type);
  }

  /** Whether a type has an interaction: read, vread, update, patch, delete, history-instance, history-type, create, search-type */
  interaction(type, code) {
    const r = this.resources.get(type);
    return !!(r && (r.interaction || []).some(i => i && i.code === code));
  }

  /** Whether the server has a system interaction: transaction, batch, search-system, history-system */
  systemInteraction(code) {
    return (this.rest.interaction || []).some(i => i && i.code === code);
  }

  /** Whether a type has a search parameter (its own, or one for every type) */
  searchParam(type, name) {
    const r = this.resources.get(type);
    const own = r && (r.searchParam || []).some(p => p && p.name === name);
    return !!(own || (this.rest.searchParam || []).some(p => p && p.name === name));
  }

  /** Whether an operation is listed, for a type or the server (by name, without the $) */
  operation(name, type) {
    const match = (o) => o && (o.name === name || o.name === '$' + name || String(o.definition || '').endsWith('/' + name) ||
      String(o.definition || '').endsWith('-' + name));
    const r = type ? this.resources.get(type) : null;
    return !!((r && (r.operation || []).some(match)) || (this.rest.operation || []).some(match));
  }

  /** 'no-version', 'versioned' or 'versioned-update' (what the type says, versioned if it doesn't) */
  versioning(type) {
    const r = this.resources.get(type);
    return (r && r.versioning) || 'versioned';
  }

  updateCreate(type) {
    const r = this.resources.get(type);
    return !!(r && r.updateCreate);
  }

  conditionalCreate(type) {
    const r = this.resources.get(type);
    return !!(r && r.conditionalCreate);
  }

  /** 'not-supported', 'modified-since', 'not-match' or 'full-support' */
  conditionalRead(type) {
    const r = this.resources.get(type);
    return (r && r.conditionalRead) || 'not-supported';
  }

  conditionalUpdate(type) {
    const r = this.resources.get(type);
    return !!(r && r.conditionalUpdate);
  }

  /**
   * conditionalPatch: R5's element, or before R5, its cross-version extension
   * (XVER_CONDITIONAL_PATCH). Before R5, null when the statement doesn't say either way
   */
  conditionalPatch(type) {
    const r = this.resources.get(type);
    if (r && typeof r.conditionalPatch === 'boolean') {
      return r.conditionalPatch;
    }
    const x = r && (r.extension || []).find(e => e && e.url === XVER_CONDITIONAL_PATCH && typeof e.valueBoolean === 'boolean');
    if (x) {
      return x.valueBoolean;
    }
    return this.release === 'R4' ? null : false;
  }

  /** 'not-supported', 'single' or 'multiple' */
  conditionalDelete(type) {
    const r = this.resources.get(type);
    return (r && r.conditionalDelete) || 'not-supported';
  }

  /** The include / revinclude values a type lists ('*' for any) */
  searchInclude(type) {
    const r = this.resources.get(type);
    return (r && r.searchInclude) || [];
  }

  searchRevInclude(type) {
    const r = this.resources.get(type);
    return (r && r.searchRevInclude) || [];
  }

  /** The patch formats the server lists (mime types) */
  patchFormat(mime) {
    return (this.cs.patchFormat || []).some(f => String(f).toLowerCase() === mime);
  }
}

module.exports = { Capabilities, XVER_CONDITIONAL_PATCH };
