//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The X-Provenance header: a Provenance resource (JSON) sent with a write, for the server to
 * store with the targets filled in, as the version-specific references to what the write
 * made (as the Pascal server did).
 *
 *  - create, update and patch (and their conditional forms): one Provenance, for the version
 *    written. A conditional create that finds the resource already there writes nothing, so
 *    gets no Provenance
 *  - a transaction: one Provenance, with a target for every resource the transaction creates,
 *    updates or patches
 *  - a batch: one for each entry that creates, updates or patches (entries stand alone)
 *
 * The Provenance is written in the write's own database transaction (as the write's
 * AuditEvent is), so there is one exactly when the write is kept. Whatever target and
 * signature the header has are dropped (a signature can't be right once the targets are
 * filled in), as are its id and version; recorded is the time of the write when the header
 * has none. A header that isn't a Provenance, or on an interaction that doesn't write, is
 * refused (400).
 *
 * @module rest/interactions/provenance
 */

const fhirJson = require('../../library/fhir-json');
const { duplicateIssues } = require('../../library/json-duplicates');
const { badRequest } = require('../library/errors');

const HEADER = 'x-provenance';
const ACCEPTS = new Set(['create', 'update', 'conditional-update', 'patch', 'conditional-patch', 'bundle']);
// the interactions recordWrite is given that make a version a Provenance points at
const TARGETS = new Set(['create', 'update', 'patch']);

/**
 * The request's X-Provenance header, read and checked: { template } or null (no header).
 * @param {Object} ep - the Endpoint
 * @param {Object} freq
 * @throws FhirError (400)
 */
function fromRequest(ep, freq) {
  let text = freq.headers[HEADER];
  if (text === undefined || text === null) {
    return null;
  }
  if (!ACCEPTS.has(freq.interaction)) {
    throw badRequest(`The X-Provenance header can only be used on a create, update, patch, batch or transaction, not a ${freq.interaction || 'request like this'}`);
  }
  if (!ep.typeSupported('Provenance')) {
    throw badRequest('This endpoint doesn\'t store Provenance resources, so it can\'t take an X-Provenance header');
  }
  // Node reads header bytes as Latin-1: UTF-8 in the header is read again as UTF-8
  text = String(text);
  if (/[\u0080-\uffff]/.test(text)) {
    text = Buffer.from(text, 'latin1').toString('utf8');
  }
  if (!text.trim()) {
    throw badRequest('The X-Provenance header is empty');
  }
  let prv;
  try {
    prv = fhirJson.parse(text);
  } catch (e) {
    throw badRequest(`The X-Provenance header is not valid JSON: ${e.message}`);
  }
  const issues = duplicateIssues(text, { acceptLanguage: freq.headers['accept-language'], resourceType: 'Provenance' });
  if (issues.length) {
    throw badRequest(issues[0].details.text, { issues });
  }
  if (!prv || typeof prv !== 'object' || Array.isArray(prv) || prv.resourceType !== 'Provenance') {
    throw badRequest('The X-Provenance header must be a Provenance resource, in JSON');
  }
  delete prv.id;
  delete prv.target;
  delete prv.signature;
  if (prv.meta && typeof prv.meta === 'object') {
    delete prv.meta.versionId;
    delete prv.meta.lastUpdated;
    if (!Object.keys(prv.meta).length) {
      delete prv.meta;
    }
  }
  return { template: prv };
}

/**
 * Where a transaction's targets are collected, to be written as one Provenance at the end
 * (a fresh one each time the transaction runs: it may run again)
 * @param {Object|null} provenance - from fromRequest
 */
function collector(provenance) {
  return provenance ? { template: provenance.template, targets: [], collecting: true } : null;
}

/**
 * Write the Provenance for targets
 * @returns {Promise<Object>} what store.put returns
 */
async function save(ep, q, freq, template, targets, deferChecks) {
  const prv = fhirJson.clone(template);
  if (!prv.recorded) {
    prv.recorded = new Date().toISOString();
  }
  prv.target = targets.map(reference => ({ reference }));
  const r = await ep.store.put(q, { type: 'Provenance', id: null, resource: prv, mustCreate: true, userId: ep.userId(freq), deferChecks });
  await ep.auditWrite(q, freq, 'create', 201, `Provenance/${r.id}/_history/${r.versionId}`, r.versionKey);
  return r;
}

/**
 * A write has made a version (what: Type/id/_history/vid): its Provenance, if the request has
 * one, now (in the write's transaction) or, in a transaction, at the end (finish)
 */
async function target(ep, q, freq, interaction, what, deferChecks) {
  const p = freq.provenance;
  if (!p || !TARGETS.has(interaction) || !what) {
    return;
  }
  if (p.collecting) {
    p.targets.push(what);
    return;
  }
  await save(ep, q, freq, p.template, [what], deferChecks);
}

/**
 * The end of a transaction: its Provenance, for everything it wrote (if anything)
 * @returns {Promise<string[]>} references still to be checked (deferred, as the entries' are)
 */
async function finish(ep, q, freq, c) {
  if (!c || !c.targets.length) {
    return [];
  }
  const r = await save(ep, q, freq, c.template, c.targets, true);
  return r.unresolved || [];
}

module.exports = { fromRequest, collector, target, finish, HEADER };
