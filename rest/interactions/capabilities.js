//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The CapabilityStatement: built from Types, the search parameters, the endpoint's settings
 * and the operations available.
 *
 * @module rest/interactions/capabilities
 */

const packageJson = require('../../package.json');
const { typeAllows } = require('../endpoint/settings');
const { OPERATIONS } = require('../operations/operations');

const COMMON = [
  { name: '_id', type: 'token' }, { name: '_lastUpdated', type: 'date' }, { name: '_tag', type: 'token' },
  { name: '_security', type: 'token' }, { name: '_profile', type: 'uri' }, { name: '_has', type: 'string' },
  { name: '_filter', type: 'string' }, { name: '_list', type: 'string' }
];

function capabilities(ep, freq) {
  const s = ep.settings;
  const resources = [];
  for (const type of [...ep.typeKeys.keys()].sort()) {
    const ts = ep.typeSettings(type);
    if (!ts.supported) {
      continue;
    }
    const interaction = [];
    for (const code of ['read', 'vread', 'update', 'patch', 'delete', 'history-instance', 'history-type', 'create', 'search-type']) {
      if (typeAllows(ts, code)) {
        interaction.push({ code });
      }
    }
    const searchParam = [...COMMON.map(c => ({ ...c })),
      ...[...ep.definitions.forType(type).values()].filter(d => d.key !== null && d.key !== undefined).map(d => ({ name: d.code, definition: d.url, type: d.type }))];
    const r = {
      type,
      interaction,
      versioning: 'versioned-update',
      readHistory: true,
      updateCreate: !!s.createOnUpdate,
      conditionalCreate: !!ts.conditionalCreate,
      conditionalRead: 'not-supported',
      conditionalUpdate: !!ts.conditionalUpdate,
      conditionalDelete: ts.conditionalDelete ? ((s.conditionalDeleteMax || 1) > 1 ? 'multiple' : 'single') : 'not-supported',
      referencePolicy: ['literal', 'logical', 'local'],
      searchInclude: ['*'],
      searchRevInclude: ['*'],
      searchParam
    };
    if (ts.versionAware) {
      r.versioning = 'versioned-update';
    }
    const ops = OPERATIONS.filter(o => o.types === null || o.types.includes(type)).filter(o => o.instance || o.type);
    if (ops.length) {
      r.operation = ops.map(o => ({ name: o.name, definition: o.definition }));
    }
    resources.push(r);
  }
  const cs = {
    resourceType: 'CapabilityStatement',
    status: 'active',
    date: new Date(ep.startedAt).toISOString(),
    name: 'FHIRsmithRestServer',
    title: s.name,
    kind: 'instance',
    software: { name: 'FHIRsmith', version: packageJson.version },
    implementation: { description: s.description || s.name, url: freq.base },
    fhirVersion: ep.definitions.fhirVersion,
    format: ['json'],
    patchFormat: ['application/json-patch+json'],
    rest: [{
      mode: 'server',
      security: { cors: true, description: s.anonymous === 'none' ? 'Log in, or send an API token (Authorization: Bearer)' : `Anonymous ${s.anonymous} is allowed` },
      resource: resources,
      interaction: [{ code: 'transaction' }, { code: 'batch' }, { code: 'search-system' }, { code: 'history-system' }],
      searchParam: COMMON,
      operation: OPERATIONS.filter(o => o.system).map(o => ({ name: o.name, definition: o.definition }))
    }]
  };
  if (s.description) {
    cs.description = s.description;
  }
  return { status: 200, resource: cs };
}

module.exports = { capabilities };
