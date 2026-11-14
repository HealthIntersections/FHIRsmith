/**
 * Whole-code-system SNOMED CT expansion tests
 *
 * Regression tests for the 0.11.0 tx.fhir.org incident: expanding a value set
 * that includes all of SNOMED CT (e.g. http://hl7.org/fhir/ValueSet/questionnaire-answers)
 * walked every *path* of the SNOMED poly-hierarchy with `context.code` undefined
 * for every concept, so the expansion collapsed onto a single map key, no size
 * guard could ever fire, and each request blocked the event loop for the full
 * 30-second deadCheck limit - timing out every other request on the server.
 *
 * These tests expand an include-all-of-SNOMED value set against the committed
 * SNOMED test subset and pin the fixed behaviour:
 *  - enumeration returns real, distinct codes (not undefined)
 *  - the expansion is marked unclosed (grammar system)
 *  - a count/offset window inside the limit succeeds as a partial expansion
 *  - an expansion that cannot fit the limit is refused as too-costly up front
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const request = require('supertest');
const TXModule = require('../../tx/tx');
const folders = require('../../library/folder-setup');

const SNOMED_URI = 'http://snomed.info/sct';

// The whole point of these tests is that expansion terminates promptly; if any
// of them takes anywhere near this long, the walk is broken again.
jest.setTimeout(60000);

function allOfSnomedValueSet() {
  return {
    resourceType: 'ValueSet',
    url: 'http://example.org/fhir/ValueSet/all-of-snomed',
    status: 'active',
    compose: {
      include: [{ system: SNOMED_URI }]
    }
  };
}

function expandRequest(app, params = [], headers = {}) {
  let req = request(app)
    .post('/tx/r5/ValueSet/$expand')
    .set('Accept', 'application/json')
    .set('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) {
    req = req.set(k, v);
  }
  return req.send({
    resourceType: 'Parameters',
    parameter: [
      { name: 'valueSet', resource: allOfSnomedValueSet() },
      ...params
    ]
  });
}

function hasUnclosedExtension(expansion) {
  return (expansion.extension || []).some(
    e => e.url === 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed');
}

describe('Whole-code-system SNOMED expansion', () => {
  let app;
  let txModule;

  beforeAll(async () => {
    // The library resolves source files against the terminology cache folder;
    // put the committed test subset there under the name the fixture uses.
    const committed = path.resolve(__dirname, '../../tx/data/snomed-testing.cache');
    const cacheFolder = folders.subDir('terminology-cache');
    const target = path.join(cacheFolder, 'snomed-testing.cache');
    if (!fs.existsSync(target)) {
      fs.copyFileSync(committed, target);
    }

    app = express();
    app.use(cors());
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    txModule = new TXModule();
    await txModule.initialize({
      librarySource: path.join(__dirname, 'fixtures', 'test-library-snomed.yaml'),
      endpoints: [
        { path: '/tx/r5', fhirVersion: '5.0', context: null }
      ]
    }, app);
  }, 60000);

  afterAll(async () => {
    if (txModule) {
      await txModule.shutdown();
    }
  });

  test('count=10 returns 10 real, distinct codes and is marked unclosed', async () => {
    const response = await expandRequest(app, [{ name: 'count', valueInteger: 10 }]);

    expect(response.status).toBe(200);
    expect(response.body.resourceType).toBe('ValueSet');
    const expansion = response.body.expansion;
    expect(expansion).toBeDefined();
    expect(expansion.contains).toHaveLength(10);

    const codes = new Set();
    for (const c of expansion.contains) {
      // Before the fix every entry had code undefined (context.code on a
      // SnomedExpressionContext), which collapsed the expansion to one entry.
      expect(typeof c.code).toBe('string');
      expect(c.code).toMatch(/^\d+$/);
      expect(c.system).toBe(SNOMED_URI);
      expect(c.display).toBeTruthy();
      codes.add(c.code);
    }
    expect(codes.size).toBe(10);

    // SNOMED is a grammar system: an enumeration of its precoordinated concepts
    // is inherently incomplete, so the expansion must be marked unclosed.
    expect(hasUnclosedExtension(expansion)).toBe(true);
  });

  test('full enumeration of the subset returns every concept exactly once', async () => {
    const response = await expandRequest(app, []);

    expect(response.status).toBe(200);
    const expansion = response.body.expansion;
    expect(expansion).toBeDefined();

    // The committed subset holds ~2k concepts - comfortably under the test
    // limit, so the whole thing enumerates. Every code must be real and, with
    // the visited-set fix, appear exactly once even though the subset is a
    // poly-hierarchy (the old walk visited concepts once per path to them).
    const codes = new Set();
    for (const c of expansion.contains) {
      expect(typeof c.code).toBe('string');
      expect(c.code).toMatch(/^\d+$/);
      codes.add(c.code);
    }
    expect(codes.size).toBe(expansion.contains.length);
    expect(codes.size).toBeGreaterThan(1000);
    expect(hasUnclosedExtension(expansion)).toBe(true);
  });

  test('a count window inside a small limit succeeds as a partial expansion', async () => {
    // Client-supplied threshold of 50 << subset size: enumeration must stop at
    // the limit and return the requested window rather than walking on.
    const response = await expandRequest(app, [{ name: 'count', valueInteger: 10 }],
      { 'x-too-costly-threshold': '50' });

    expect(response.status).toBe(200);
    const expansion = response.body.expansion;
    expect(expansion.contains).toHaveLength(10);
    for (const c of expansion.contains) {
      expect(typeof c.code).toBe('string');
      expect(c.code).toMatch(/^\d+$/);
    }
  });

  // A filter naming a concept the edition does not have makes the value set invalid: 400,
  // the same issue an unknown concept in ECL gives, not a 500 exception.
  test.each([
    ['in', '41000147108'],      // an unknown reference set
    ['is-a', '584021000052104'],
    ['=', '584021000052104'],
    ['descendent-of', '584021000052104']
  ])('concept %s an unknown concept (%s) is a 400 invalid, like ECL', async (op, value) => {
    const expandFilter = (filter) => request(app)
      .post('/tx/r5/ValueSet/$expand')
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({
        resourceType: 'Parameters',
        parameter: [{ name: 'valueSet', resource: { resourceType: 'ValueSet', status: 'active', compose: { include: [{ system: SNOMED_URI, filter: [filter] }] } } }]
      });

    const response = await expandFilter({ property: 'concept', op, value });
    expect(response.status).toBe(400);
    expect(response.body.resourceType).toBe('OperationOutcome');
    const [issue] = response.body.issue;
    expect(issue.severity).toBe('error');
    expect(issue.code).toBe('invalid');
    expect(issue.details.text).toBe(`The SNOMED CT Concept ${value} is not known`);
    expect(issue.details.coding).toEqual([{ system: 'http://hl7.org/fhir/tools/CodeSystem/tx-issue-type', code: 'vs-invalid' }]);

    const ecl = await expandFilter({ property: 'constraint', op: '=', value: `<< ${value}` });
    expect(ecl.status).toBe(response.status);
    expect(ecl.body.issue[0]).toMatchObject({ severity: issue.severity, code: issue.code, details: { coding: issue.details.coding } });
    expect(ecl.body.issue[0].details.text).toContain(issue.details.text);
  });

  test('an expansion that cannot fit the limit is refused as too-costly', async () => {
    // No count, threshold below the subset size: enumeration could only ever
    // end in too-costly at the limit, so the request must be refused up front
    // (this used to be dead code - cs.totalCount read a method as a property).
    const response = await expandRequest(app, [], { 'x-too-costly-threshold': '50' });

    expect(response.status).toBe(422);
    expect(response.body.resourceType).toBe('OperationOutcome');
    expect(response.body.issue[0].code).toBe('too-costly');
  });
});
