//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * What the tests share: names unique to the run (so searches only find what the run made,
 * even by name), and the resources the tests make.
 *
 * @module tester/suite/common
 */

const crypto = require('crypto');

const UCUM = 'http://unitsofmeasure.org';
const LOINC = 'http://loinc.org';

/** A word unique enough for one run's searches by name: letters only, starting with a capital */
function uniqueWord() {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.randomBytes(10);
  return 'Tst' + Array.from(bytes, b => letters[b % 26]).join('');
}

/** An id no server has: for reads of what isn't there */
function unknownId() {
  return 'tester-none-' + crypto.randomBytes(12).toString('hex');
}

/** A Patient of the run's */
function patient(ctx, fields = {}) {
  return ctx.resource('Patient', { active: true, name: [{ family: uniqueWord(), given: ['Test'] }], gender: 'female', birthDate: '1970-03-04', ...fields });
}

/** An Observation of the run's, about a patient */
function observation(ctx, patientId, fields = {}) {
  return ctx.resource('Observation', {
    status: 'final',
    code: { coding: [{ system: LOINC, code: '29463-7', display: 'Body weight' }] },
    subject: { reference: `Patient/${patientId}` },
    effectiveDateTime: '2020-05-06T10:00:00Z',
    valueQuantity: { value: 72.5, unit: 'kg', system: UCUM, code: 'kg' },
    ...fields
  });
}

/** The ETag for a version (If-Match) */
function etag(version) {
  return `W/"${version}"`;
}

/** The version in an ETag header (W/"3": 3), or null */
function versionOf(header) {
  const m = /^(?:W\/)?"([^"]*)"$/.exec(String(header || '').trim());
  return m ? m[1] : null;
}

/** Headers for an update: If-Match when the server keeps versions */
function ifMatch(ctx, type, version) {
  return version && ctx.cap.versioning(type) !== 'no-version' ? { 'If-Match': etag(version) } : {};
}

/** The family name of a Patient */
function family(p) {
  return p && Array.isArray(p.name) && p.name[0] ? p.name[0].family : undefined;
}

/** The entries of a Bundle that are resources of a type */
function resourcesOf(bundle, type) {
  return (bundle.entry || []).map(e => e && e.resource).filter(r => r && r.resourceType === type);
}

/** Whether a response body is an OperationOutcome */
function isOutcome(res) {
  return !!(res.resource && res.resource.resourceType === 'OperationOutcome');
}

/** The instant one second before a resource's lastUpdated (or now, less a minute) */
function before(resource) {
  const t = resource && resource.meta && Date.parse(resource.meta.lastUpdated);
  return new Date((Number.isFinite(t) ? t : Date.now() - 60000) - 1000).toISOString();
}

module.exports = { uniqueWord, unknownId, patient, observation, etag, versionOf, ifMatch, family, resourcesOf, isOutcome, before, UCUM, LOINC };
