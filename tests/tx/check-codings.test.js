/**
 * $validate-code on a CodeableConcept: what the ConceptMaps say about the codings together
 * (tx/workers/check-codings.js - the server side of the core validator's TranslationValidator).
 *
 * The maps come in as tx-resources:
 *
 *  - CM_AB1 (A -> B): a1 -> b1, a2 -> b2, a3 not-related-to b3, a4 noMap, anything else -> b5 (unmapped fixed)
 *  - CM_AB2 (A -> B): a1 -> b1, a2 -> b2 - agrees with CM_AB1, so the two are reported together
 *  - CM_BA_CHAIN (B -> A): no elements, unmapped other-map -> CM_BA
 *  - CM_BA (B -> A): b1 -> a1, b2 -> a2 - found directly, and through CM_BA_CHAIN
 *  - CM_CYCLE1 / CM_CYCLE2 (A -> B): unmapped other-map to each other - $translate refuses a circular
 *    chain, and here that just means those maps have nothing to say
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

const A = 'http://example.org/fhir/CodeSystem/check-codings-a';
const B = 'http://example.org/fhir/CodeSystem/check-codings-b';
const CMB = 'http://example.org/fhir/ConceptMap/check-codings-';

const cs = (url, codes) => ({
  resourceType: 'CodeSystem', url, version: '1.0.0', status: 'active', content: 'complete',
  concept: codes.map(code => ({ code, display: 'Display ' + code }))
});
const CS_A = cs(A, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
const CS_B = cs(B, ['b1', 'b2', 'b3', 'b4', 'b5']);
const VS = {
  resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/check-codings', version: '1.0.0',
  status: 'active', compose: { include: [{ system: A }, { system: B }] }
};

const cm = (name, source, target, group) => ({
  resourceType: 'ConceptMap', url: CMB + name, version: '1.0.0', status: 'active',
  group: [Object.assign({ source, target }, group)]
});
const to = (code, relationship = 'equivalent') => ({ target: [{ code, relationship }] });
const CM_AB1 = cm('ab1', A, B, {
  element: [
    Object.assign({ code: 'a1' }, to('b1')),
    Object.assign({ code: 'a2' }, to('b2')),
    Object.assign({ code: 'a3' }, to('b3', 'not-related-to')),
    { code: 'a4', noMap: true }
  ],
  unmapped: { mode: 'fixed', code: 'b5', relationship: 'related-to' }
});
const CM_AB2 = cm('ab2', A, B, {
  element: [Object.assign({ code: 'a1' }, to('b1')), Object.assign({ code: 'a2' }, to('b2'))]
});
const CM_BA = cm('ba', B, A, {
  element: [Object.assign({ code: 'b1' }, to('a1')), Object.assign({ code: 'b2' }, to('a2'))]
});
const CM_BA_CHAIN = cm('ba-chain', B, A, {
  element: [], unmapped: { mode: 'other-map', otherMap: CMB + 'ba' }
});
const CM_CYCLE1 = cm('cycle1', A, B, { element: [], unmapped: { mode: 'other-map', otherMap: CMB + 'cycle2' } });
const CM_CYCLE2 = cm('cycle2', A, B, { element: [], unmapped: { mode: 'other-map', otherMap: CMB + 'cycle1' } });

const ALL_MAPS = [CM_AB1, CM_AB2, CM_BA, CM_BA_CHAIN, CM_CYCLE1, CM_CYCLE2];

const vurl = (name) => CMB + name + '|1.0.0';

describe('$validate-code: what ConceptMaps say about the codings in a CodeableConcept', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  const validate = (coding, maps = ALL_MAPS) => request(app)
    .post('/tx/r5/ValueSet/$validate-code')
    .set('Content-Type', 'application/json')
    .send({ resourceType: 'Parameters', parameter: [
      { name: 'valueSet', resource: VS },
      { name: 'codeableConcept', valueCodeableConcept: { coding } },
      { name: 'tx-resource', resource: CS_A },
      { name: 'tx-resource', resource: CS_B },
      ...maps.map(resource => ({ name: 'tx-resource', resource }))
    ] });

  // the issues this check produces, as [severity, text]
  const mapIssues = (body) => {
    const oo = (body.parameter.find(p => p.name === 'issues') || {}).resource || { issue: [] };
    return oo.issue
      .filter(i => /^This CodeableConcept has the codes/.test(i.details.text))
      .map(i => [i.severity, i.details.text, i.expression])
      .sort((x, y) => x[1].localeCompare(y[1]));
  };
  const result = (body) => body.parameter.find(p => p.name === 'result').valueBoolean;

  const a = (code) => ({ system: A, code });
  const b = (code) => ({ system: B, code });

  test('the maps agree with the codings: nothing to say', async () => {
    const res = await validate([a('a1'), b('b1')]);
    expect(res.status).toBe(200);
    expect(result(res.body)).toBe(true);
    expect(mapIssues(res.body)).toEqual([]);
  });

  test('the maps relate the codes to something else: one hint per direction, naming every map that says so', async () => {
    const res = await validate([a('a1'), b('b2')]);
    expect(res.status).toBe(200);
    expect(result(res.body)).toBe(true); // hints and warnings only
    expect(mapIssues(res.body)).toEqual([
      ['information', `This CodeableConcept has the codes ${A}#a1 and ${B}#b2, but the ConceptMaps ${vurl('ab1')}, ${vurl('ab2')} map ${A}#a1 to b1. Check that these codes belong together`, ['CodeableConcept']],
      // CM_BA says this directly, and CM_BA_CHAIN says it by deferring to CM_BA
      ['information', `This CodeableConcept has the codes ${B}#b2 and ${A}#a1, but the ConceptMaps ${vurl('ba-chain')}, ${vurl('ba')} map ${B}#b2 to a2. Check that these codes belong together`, ['CodeableConcept']]
    ]);
  });

  test('a single map: the singular message', async () => {
    const res = await validate([a('a1'), b('b2')], [CM_AB2]);
    expect(res.status).toBe(200);
    expect(mapIssues(res.body)).toEqual([
      ['information', `This CodeableConcept has the codes ${A}#a1 and ${B}#b2, but the ConceptMap ${vurl('ab2')} maps ${A}#a1 to b1. Check that these codes belong together`, ['CodeableConcept']]
    ]);
  });

  test('not-related-to: warning', async () => {
    const res = await validate([a('a3'), b('b3')]);
    expect(res.status).toBe(200);
    expect(mapIssues(res.body)).toEqual([
      ['warning', `This CodeableConcept has the codes ${A}#a3 and ${B}#b3, but the ConceptMap ${vurl('ab1')} says that ${A}#a3 is not related to ${B}#b3`, ['CodeableConcept']]
    ]);
  });

  test('noMap: warning', async () => {
    const res = await validate([a('a4'), b('b1')]);
    expect(res.status).toBe(200);
    expect(mapIssues(res.body)).toEqual([
      ['warning', `This CodeableConcept has the codes ${A}#a4 and ${B}#b1, but the ConceptMap ${vurl('ab1')} says that ${A}#a4 has no mapping to ${B}`, ['CodeableConcept']],
      ['information', `This CodeableConcept has the codes ${B}#b1 and ${A}#a4, but the ConceptMaps ${vurl('ba-chain')}, ${vurl('ba')} map ${B}#b1 to a1. Check that these codes belong together`, ['CodeableConcept']]
    ]);
  });

  test('group.unmapped fixed: the fixed code agrees - nothing to say', async () => {
    const res = await validate([a('a5'), b('b5')]);
    expect(res.status).toBe(200);
    expect(mapIssues(res.body)).toEqual([]);
  });

  test('group.unmapped fixed: the fixed code is something else - hint', async () => {
    const res = await validate([a('a5'), b('b4')]);
    expect(res.status).toBe(200);
    expect(mapIssues(res.body)).toEqual([
      ['information', `This CodeableConcept has the codes ${A}#a5 and ${B}#b4, but the ConceptMap ${vurl('ab1')} maps ${A}#a5 to b5. Check that these codes belong together`, ['CodeableConcept']]
    ]);
  });

  test('a circular other-map chain: those maps say nothing, the others still do, and validation is unaffected', async () => {
    const res = await validate([a('a6'), b('b4')]);
    expect(res.status).toBe(200);
    expect(result(res.body)).toBe(true);
    expect(mapIssues(res.body)).toEqual([
      ['information', `This CodeableConcept has the codes ${A}#a6 and ${B}#b4, but the ConceptMap ${vurl('ab1')} maps ${A}#a6 to b5. Check that these codes belong together`, ['CodeableConcept']]
    ]);
  });

  test('the map is confirmed by one coding: nothing to say about a second coding in the same system', async () => {
    const res = await validate([a('a1'), b('b1'), b('b4')]);
    expect(res.status).toBe(200);
    // b4 isn't mentioned by any B -> A map, and a1 -> b1 is confirmed, so b4 passes without comment
    expect(mapIssues(res.body)).toEqual([]);
  });

  test('no maps between the systems: nothing to say', async () => {
    const res = await validate([a('a1'), b('b2')], []);
    expect(res.status).toBe(200);
    expect(mapIssues(res.body)).toEqual([]);
  });

  test('one coding: nothing to check', async () => {
    const res = await validate([a('a1')]);
    expect(res.status).toBe(200);
    expect(mapIssues(res.body)).toEqual([]);
  });
});
