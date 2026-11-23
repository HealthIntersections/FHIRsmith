//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * AuditEvents. The endpoint asks the factory for the builder for its FHIR version, and the
 * interactions only ever use that builder. For now one common builder serves R4 and R5 (it
 * knows the few places they differ); a version-specific builder can replace it later without
 * changing any caller.
 *
 * Writes are audited in the write's own transaction (the version points at the AuditEvent);
 * reads, when the endpoint audits them, are buffered and written together every second or
 * so, since on SQLite each one would otherwise queue for the write lock.
 *
 * @module rest/audit/audit
 */

const DCM = 'http://dicom.nema.org/resources/ontology/DCM';
const AUDIT_TYPE = 'http://terminology.hl7.org/CodeSystem/audit-event-type';
const RESTFUL = 'http://hl7.org/fhir/restful-interaction';

// FHIR AuditEvent.action: C R U D E
const ACTIONS = {
  create: 'C', read: 'R', vread: 'R', update: 'U', patch: 'U', delete: 'D', 'search-type': 'E', 'search-system': 'E',
  'history-instance': 'R', 'history-type': 'R', 'history-system': 'R', capabilities: 'R', batch: 'E', transaction: 'E', operation: 'E'
};

class CommonAuditBuilder {
  /**
   * @param {string} fhirVersion
   */
  constructor(fhirVersion) {
    this.r5 = String(fhirVersion).startsWith('5') || String(fhirVersion).startsWith('6');
  }

  /**
   * @param {Object} e
   * @param {string} e.interaction - a restful-interaction code (read, create, search-type...)
   * @param {number} e.status - the HTTP status of the response
   * @param {string} [e.outcomeText]
   * @param {Object|null} e.principal - { id, login, name } or null
   * @param {string} [e.ip]
   * @param {string} [e.what] - Type/id[/_history/vid] or a query
   * @param {string} [e.query]
   * @param {string} e.source - the endpoint's URL
   * @param {number} [e.time]
   * @returns {Object} an AuditEvent
   */
  build(e) {
    const recorded = new Date(e.time || Date.now()).toISOString();
    const outcome = e.status < 400 ? '0' : e.status < 500 ? '4' : '8';
    const action = ACTIONS[e.interaction] || 'E';
    const who = e.principal
      ? { display: e.principal.name || e.principal.login || String(e.principal.id), identifier: { system: 'urn:fhirsmith:user', value: String(e.principal.login || e.principal.id) } }
      : { display: 'anonymous' };
    const agent = { requestor: true, who };
    if (e.ip) {
      agent.network = this.r5 ? { address: e.ip } : { address: e.ip, type: '2' };
    }
    const subtype = { system: RESTFUL, code: e.interaction };
    const ev = { resourceType: 'AuditEvent' };
    if (this.r5) {
      ev.category = [{ coding: [{ system: AUDIT_TYPE, code: 'rest', display: 'RESTful Operation' }] }];
      ev.code = { coding: [subtype] };
      ev.action = action;
      ev.recorded = recorded;
      ev.outcome = { code: { system: 'http://terminology.hl7.org/CodeSystem/audit-event-severity', code: e.status < 400 ? 'informational' : 'error' } };
      if (e.outcomeText) {
        ev.outcome.detail = [{ text: e.outcomeText }];
      }
      ev.agent = [agent];
      ev.source = { observer: { display: e.source } };
    } else {
      ev.type = { system: AUDIT_TYPE, code: 'rest', display: 'RESTful Operation' };
      ev.subtype = [subtype];
      ev.action = action;
      ev.recorded = recorded;
      ev.outcome = outcome;
      if (e.outcomeText) {
        ev.outcomeDesc = e.outcomeText;
      }
      ev.agent = [agent];
      ev.source = { observer: { display: e.source }, type: [{ system: 'http://terminology.hl7.org/CodeSystem/security-source-type', code: '3' }] };
    }
    if (e.what || e.query) {
      const entity = {};
      if (e.what) {
        entity.what = { reference: e.what };
      }
      if (e.query) {
        entity.query = Buffer.from(e.query, 'utf8').toString('base64');
      }
      ev.entity = [entity];
    }
    return ev;
  }
}

/**
 * The builder for a FHIR version.
 * @param {string} fhirVersion
 */
function auditBuilder(fhirVersion) {
  return new CommonAuditBuilder(fhirVersion);
}

module.exports = { auditBuilder, CommonAuditBuilder, ACTIONS, DCM };
