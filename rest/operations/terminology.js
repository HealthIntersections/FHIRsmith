//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The terminology requests made to the endpoint, passed on to its terminology server (the
 * txServer setting): `metadata?mode=terminology`, and the terminology operations -
 *
 *   CodeSystem  $lookup, $validate-code, $subsumes
 *   ValueSet    $expand, $validate-code, $batch-validate-code
 *   ConceptMap  $translate
 *   [base]      $closure
 *
 * at the type level as they are asked (GET with the query, or POST with the body), and the
 * answer comes back as the terminology server gave it (its status, and the resource), in the
 * format asked of the endpoint. On an instance ([type]/[id]/$op) the endpoint's own resource is
 * named by its url and version, so the terminology server must know the endpoint's resources:
 * usually it does, through a rest: source (tx/rest/rest-source.js) on this endpoint. With no
 * terminology server, they are not supported (501).
 *
 * @module rest/operations/terminology
 */

const { FhirError, notFound, gone, notSupported } = require('../library/errors');
const { param } = require('../request');

const OPERATIONS = {
  CodeSystem: ['lookup', 'validate-code', 'subsumes'],
  ValueSet: ['expand', 'validate-code', 'batch-validate-code'],
  ConceptMap: ['translate'],
  system: ['closure']
};

// on an instance: the parameters that name the resource (url, version), by type and operation
const NAMES = {
  'CodeSystem/lookup': ['system', 'version'],
  'CodeSystem/validate-code': ['url', 'version'],
  'CodeSystem/subsumes': ['system', 'version'],
  'ValueSet/expand': ['url', 'valueSetVersion'],
  'ValueSet/validate-code': ['url', 'valueSetVersion'],
  'ValueSet/batch-validate-code': ['url', 'valueSetVersion'],
  'ConceptMap/translate': ['url', 'conceptMapVersion']
};

// what the endpoint itself acts on, not passed on
const CONTROL = new Set(['_format', '_pretty', '_async']);

/** Whether a request is one the terminology server answers */
function handles(freq) {
  if (freq.interaction === 'capabilities') {
    return param(freq, 'mode') === 'terminology';
  }
  if (freq.interaction !== 'operation' || freq.vid) {
    return false;
  }
  const list = freq.type ? OPERATIONS[freq.type] : (freq.id ? null : OPERATIONS.system);
  return !!list && list.includes(freq.operation);
}

/** The operations to list in the CapabilityStatement for a type (or the endpoint: null) */
function operationsFor(type) {
  return (type ? OPERATIONS[type] : OPERATIONS.system) || [];
}

/**
 * Pass the request on.
 * @param {Object} ep - the Endpoint
 * @param {Object} freq
 * @param {Object} ctx
 * @returns {Promise<{status: number, resource: Object}>}
 */
async function run(ep, freq, ctx) {
  if (!ep.terminology) {
    throw notSupported(freq.interaction === 'capabilities'
      ? 'This endpoint has no terminology server (the txServer setting), so no TerminologyCapabilities'
      : `$${freq.operation} is done by the endpoint's terminology server, and it has none (the txServer setting)`);
  }
  const query = (freq.params || []).filter(([n]) => !CONTROL.has(n));
  let path;
  let body;
  let method = freq.method === 'POST' ? 'POST' : 'GET';
  if (freq.interaction === 'capabilities') {
    path = '/metadata';
    method = 'GET';
  } else {
    path = freq.type ? `/${freq.type}/$${freq.operation}` : `/$${freq.operation}`;
    if (method === 'POST') {
      body = freq.body;
      if (body && body.resourceType !== 'Parameters') {
        throw new FhirError(400, 'invalid', `A POST of $${freq.operation} takes a Parameters resource`);
      }
    }
    if (freq.id) {
      // the endpoint's resource, by its url and version
      const cur = await ep.inRead(ctx, async (q) => {
        const c = await ep.store.current(q, freq.type, freq.id);
        if (c) {
          await ep.checkCompartments(q, ctx.access, c.resourceKey);
        }
        return c;
      });
      if (!cur) {
        throw notFound(`${freq.type}/${freq.id} is not known`);
      }
      if (cur.deleted) {
        throw gone(`${freq.type}/${freq.id} has been deleted`);
      }
      if (!cur.resource.url) {
        throw new FhirError(422, 'processing', `${freq.type}/${freq.id} has no url, so the terminology server can't be asked about it`);
      }
      const [urlName, versionName] = NAMES[`${freq.type}/${freq.operation}`];
      const named = [[urlName, cur.resource.url], ...(cur.resource.version ? [[versionName, cur.resource.version]] : [])];
      if (method === 'POST') {
        body = { ...(body || { resourceType: 'Parameters' }) };
        body.parameter = [...(body.parameter || []).filter(p => p.name !== urlName && p.name !== versionName),
          ...named.map(([name, value]) => (name === versionName ? { name, valueString: value } : { name, valueUri: value }))];
      } else {
        query.push(...named);
      }
    }
  }
  const headers = {};
  if (freq.headers && freq.headers['accept-language']) {
    headers['Accept-Language'] = freq.headers['accept-language'];
  }
  let r;
  try {
    r = await ep.terminology.client.request(method, path, { query, body, headers });
  } catch (e) {
    throw new FhirError(502, 'transient', `The terminology server didn't answer: ${e.message}`);
  }
  if (!r.resource || typeof r.resource !== 'object' || !r.resource.resourceType) {
    throw new FhirError(502, 'transient', `The terminology server's answer (${r.status}) wasn't a FHIR resource`);
  }
  return { status: r.status, resource: r.resource };
}

module.exports = { handles, run, operationsFor, OPERATIONS };
