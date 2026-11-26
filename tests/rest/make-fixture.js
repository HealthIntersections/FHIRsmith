//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Makes tests/data/rest/r4-definitions.json: the definitions the rest tests use, derived from
 * the R4 core package (rest/indexing/definitions.js) and cut down to the types the tests use,
 * so the tests don't need the package.
 *
 *   node tests/rest/make-fixture.js {folder of hl7.fhir.r4.core#4.0.1}
 */

const fs = require('fs');
const path = require('path');
const { deriveDefinitions } = require('../../rest/indexing/definitions');

const TYPES = ['Patient', 'Observation', 'Encounter', 'Practitioner', 'Organization', 'List', 'AuditEvent', 'Condition',
  'SearchParameter', 'ValueSet', 'Group', 'Device', 'RelatedPerson', 'MedicationRequest', 'Provenance', 'Binary', 'CodeSystem', 'ConceptMap'];
const BASES = new Set(['Resource', 'DomainResource', ...TYPES]);
const XML_RESOURCES = new Set([...TYPES, 'Resource', 'DomainResource', 'Bundle', 'OperationOutcome', 'Parameters', 'CapabilityStatement', 'Binary']);

const folder = process.argv[2];
if (!folder) {
  console.error('usage: node tests/rest/make-fixture.js {folder of hl7.fhir.r4.core#4.0.1}');
  process.exit(1);
}
const d = deriveDefinitions([folder], '4.0.1');
const out = {
  fhirVersion: d.fhirVersion,
  resourceTypes: d.resourceTypes.filter(t => TYPES.includes(t)),
  searchParameters: d.searchParameters.filter(sp => sp.base.some(b => BASES.has(b))).map(sp => ({ ...sp, base: sp.base.filter(b => BASES.has(b)) })),
  compartments: d.compartments.filter(c => c.url.startsWith('http://hl7.org/fhir/CompartmentDefinition/'))
    .map(c => ({ ...c, resource: c.resource.filter(r => TYPES.includes(r.code)) })),
  summary: Object.fromEntries(Object.entries(d.summary).filter(([k]) => TYPES.includes(k))),
  mandatory: Object.fromEntries(Object.entries(d.mandatory).filter(([k]) => TYPES.includes(k))),
  // XML: the datatypes, the test types, and the resources the server makes itself
  xml: {
    primitives: d.xml.primitives,
    resources: d.xml.resources.filter(t => XML_RESOURCES.has(t)),
    types: Object.fromEntries(Object.entries(d.xml.types).filter(([k]) => {
      const root = k.split('.')[0];
      return !d.xml.resources.includes(root) || XML_RESOURCES.has(root);
    }))
  }
};
const file = path.join(__dirname, '..', 'data', 'rest', 'r4-definitions.json');
fs.writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
// eslint-disable-next-line no-console -- a script: what it made
console.log(`${file}: ${out.resourceTypes.length} types, ${out.searchParameters.length} search parameters`);
