/**
 * A value set with a modifier extension the server doesn't know can't be processed: $expand and
 * $validate-code refuse it with a 422 that names the extension and gives the element's path (K10)
 */

const path = require('path');
const express = require('express');
const request = require('supertest');
const TXModule = require('../../tx/tx');

jest.setTimeout(60000);

const CS = { resourceType: 'CodeSystem', url: 'http://example.org/fhir/CodeSystem/k10', version: '1', status: 'active', content: 'complete',
  hierarchyMeaning: 'is-a', concept: [{ code: 'code1', display: 'one', concept: [{ code: 'code2', display: 'two' }] }] };
const MOD = [{ url: 'http://example.org/fhir/StructureDefinition/unknown-modifier', valueString: 'x' }];
const vs = (name, compose) => ({ resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/k10-' + name, version: '1', status: 'active', compose });

const CASES = [
  ['filter', vs('filter', { include: [{ system: CS.url, filter: [{ modifierExtension: MOD, property: 'concept', op: 'is-a', value: 'code1' }] }] }),
    'ValueSet.compose.include[0].filter[0]'],
  ['include', vs('include', { include: [{ modifierExtension: MOD, system: CS.url }] }), 'ValueSet.compose.include[0]'],
  ['concept', vs('concept', { include: [{ system: CS.url }, { system: CS.url, concept: [{ code: 'code1' }, { modifierExtension: MOD, code: 'code2' }] }] }),
    'ValueSet.compose.include[1].concept[1]'],
  ['exclude filter', vs('exclude', { include: [{ system: CS.url }], exclude: [{ system: CS.url, filter: [{ property: 'concept', op: 'is-a', value: 'code2' },
    { modifierExtension: MOD, property: 'concept', op: 'is-a', value: 'code2' }] }] }), 'ValueSet.compose.exclude[0].filter[1]']
];

describe('unknown modifier extensions in a value set', () => {
  let app;
  let txModule;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    txModule = new TXModule();
    await txModule.initialize({
      librarySource: path.join(__dirname, 'fixtures', 'test-library-snomed.yaml'),
      endpoints: [{ path: '/tx/r4', fhirVersion: '4.0', context: null }]
    }, app);
  }, 60000);

  afterAll(async () => {
    if (txModule) {
      await txModule.shutdown();
    }
  });

  for (const [name, valueSet, where] of CASES) {
    for (const op of ['expand', 'validate-code']) {
      test(`on a ${name}: ${op} is refused with a 422 at ${where}`, async () => {
        const parameter = [{ name: 'valueSet', resource: valueSet }, { name: 'tx-resource', resource: CS }];
        if (op === 'validate-code') {
          parameter.push({ name: 'system', valueUri: CS.url }, { name: 'code', valueCode: 'code1' });
        }
        const res = await request(app).post('/tx/r4/ValueSet/$' + op).set('Accept', 'application/json').set('Content-Type', 'application/json')
          .send({ resourceType: 'Parameters', parameter });
        expect(res.status).toBe(422);
        const issue = res.body.issue[0];
        expect(issue.code).toBe('business-rule');
        expect(issue.expression).toEqual([where]);
        expect(issue.details.coding[0].code).toBe('vs-invalid');
        expect(issue.details.text).toContain('http://example.org/fhir/StructureDefinition/unknown-modifier');
        expect(issue.extension[0].valueString).toBe('VALUESET_MODIFIER_EXTENSION_UNKNOWN');
      });
    }
  }
});
