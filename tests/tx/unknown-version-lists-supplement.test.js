/**
 * A request that carries a supplement with the same url as the code system it supplements, and
 * its own version (dk.ehealth.sundhed.fhir.ig.core does this for data-absent-reason, version
 * 11.0.2), and a value set that asks for that version of the code system. There is no such
 * version of the code system, and the message says so - but then listed it among the valid
 * versions ("version '2.0.0' could not be found ... Valid versions: 1.0.0 or 2.0.0"): the
 * supplement's version was counted as a version of the code system.
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

const SYS = 'http://example.org/fhir/CodeSystem/supplemented-under-its-own-url';
const CS = {
  resourceType: 'CodeSystem', url: SYS, version: '1.0.0', status: 'active', content: 'complete',
  concept: [{ code: 'a', display: 'A' }, { code: 'b', display: 'B' }]
};
const SUPPLEMENT = {
  resourceType: 'CodeSystem', url: SYS, version: '2.0.0', status: 'active', content: 'supplement', supplements: SYS,
  concept: [{ code: 'a', designation: [{ language: 'da', value: 'A (da)' }] }]
};

describe('a supplement with the url of its code system is not a version of the code system', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  const post = (op, ...parameters) => request(app)
    .post('/tx/r5/ValueSet/' + op)
    .set('Content-Type', 'application/json')
    .send({ resourceType: 'Parameters', parameter: [
      ...parameters,
      { name: 'tx-resource', resource: CS },
      { name: 'tx-resource', resource: SUPPLEMENT }
    ] });

  const valueSet = (version) => ({ name: 'valueSet', resource: { resourceType: 'ValueSet', status: 'active',
    compose: { include: [{ system: SYS, version, concept: [{ code: 'a' }] }] } } });

  test('$expand: the version asked for is not among the valid versions', async () => {
    const res = await post('$expand', valueSet('2.0.0'));
    expect(res.status).toBe(422);
    expect(res.body.issue[0].details.text).toBe(
      `A definition for CodeSystem '${SYS}' version '2.0.0' could not be found, so the value set cannot be expanded. Valid versions: 1.0.0`);
  });

  test('$validate-code: the same', async () => {
    const res = await post('$validate-code', valueSet('2.0.0'), { name: 'coding', valueCoding: { system: SYS, version: '2.0.0', code: 'a' } });
    expect(res.status).toBe(200);
    const message = res.body.parameter.find(p => p.name === 'message').valueString;
    expect(message).toContain(`CodeSystem '${SYS}' version '2.0.0' could not be found, so the code cannot be validated. Valid versions: 1.0.0`);
    expect(message).not.toContain('1.0.0 or 2.0.0');
  });

  test('the version the code system does have still expands', async () => {
    const res = await post('$expand', valueSet('1.0.0'));
    expect(res.status).toBe(200);
    expect(res.body.expansion.contains.map(c => c.code)).toEqual(['a']);
  });
});
