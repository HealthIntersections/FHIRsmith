/**
 * A request that carries a supplement with the same url as the code system it supplements, and
 * its own version (dk.ehealth.sundhed.fhir.ig.core does this for data-absent-reason, version
 * 11.0.2), and a value set that asks for that version of the code system. There is no such
 * version of the code system, and the message says so - but then listed it among the valid
 * versions ("version '2.0.0' could not be found ... Valid versions: 1.0.0 or 2.0.0"): the
 * supplement's version was counted as a version of the code system.
 *
 * Such a supplement is invalid (a supplement needs a url of its own: with the code system's,
 * url|version claims to be a version of the code system), but it is in a published package, so
 * it is not refused: an operation that looks up the code system it has the url of says so with a
 * warning (CODESYSTEM_CS_SUPP_SAME_URL), whether or not the operation fails.
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
// the same supplement, with a url of its own
const OWN_URL_SUPPLEMENT = { ...SUPPLEMENT, url: 'http://example.org/fhir/CodeSystem/supplement-with-its-own-url' };

const WARNING = `The supplement '${SYS}|2.0.0' has the url of the code system it supplements, so it claims to be a version of that code system. A supplement needs a canonical url of its own`;

const sameUrlWarnings = (oo) => (oo && oo.issue ? oo.issue : []).filter(i =>
  (i.extension || []).some(e => e.valueString === 'CODESYSTEM_CS_SUPP_SAME_URL'));

const expectWarning = (oo) => {
  const found = sameUrlWarnings(oo);
  expect(found).toHaveLength(1);
  expect(found[0].severity).toBe('warning');
  expect(found[0].code).toBe('invalid');
  expect(found[0].details.text).toBe(WARNING);
};

describe('a supplement with the url of its code system is not a version of the code system', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  const post = (op, supplement, ...parameters) => request(app)
    .post('/tx/r5/ValueSet/' + op)
    .set('Content-Type', 'application/json')
    .send({ resourceType: 'Parameters', parameter: [
      ...parameters,
      { name: 'tx-resource', resource: CS },
      { name: 'tx-resource', resource: supplement }
    ] });

  const valueSet = (version) => ({ name: 'valueSet', resource: { resourceType: 'ValueSet', status: 'active',
    compose: { include: [{ system: SYS, version, concept: [{ code: 'a' }] }] } } });

  // the expansion's warnings: the OperationOutcomes its expansion-issue extensions refer to
  const expansionIssues = (vs) => ({ issue: (vs.expansion.extension || [])
    .filter(e => e.url === 'http://hl7.org/fhir/StructureDefinition/expansion-issue')
    .flatMap(e => vs.contained.find(r => '#' + r.id === e.valueReference.reference).issue) });

  test('$expand: the version asked for is not among the valid versions, and the supplement is warned about', async () => {
    const res = await post('$expand', SUPPLEMENT, valueSet('2.0.0'));
    expect(res.status).toBe(422);
    expect(res.body.issue[0].details.text).toBe(
      `A definition for CodeSystem '${SYS}' version '2.0.0' could not be found, so the value set cannot be expanded. Valid versions: 1.0.0`);
    expectWarning(res.body);
  });

  test('$validate-code: the same', async () => {
    const res = await post('$validate-code', SUPPLEMENT, valueSet('2.0.0'), { name: 'coding', valueCoding: { system: SYS, version: '2.0.0', code: 'a' } });
    expect(res.status).toBe(200);
    const message = res.body.parameter.find(p => p.name === 'message').valueString;
    expect(message).toContain(`CodeSystem '${SYS}' version '2.0.0' could not be found, so the code cannot be validated. Valid versions: 1.0.0`);
    expect(message).not.toContain('1.0.0 or 2.0.0');
    // a warning: not part of the message, which lists the errors
    expect(message).not.toContain('claims to be a version');
    expectWarning(res.body.parameter.find(p => p.name === 'issues').resource);
  });

  test('the version the code system does have still expands, with the warning', async () => {
    const res = await post('$expand', SUPPLEMENT, valueSet('1.0.0'));
    expect(res.status).toBe(200);
    expect(res.body.expansion.contains.map(c => c.code)).toEqual(['a']);
    expectWarning(expansionIssues(res.body));
  });

  test('the supplement is still used when asked for, with the warning', async () => {
    const res = await post('$expand', SUPPLEMENT, valueSet('1.0.0'),
      { name: 'useSupplement', valueCanonical: SYS + '|2.0.0' }, { name: 'displayLanguage', valueCode: 'da' });
    expect(res.status).toBe(200);
    expect(res.body.expansion.contains.map(c => c.display)).toEqual(['A (da)']);
    expect(res.body.expansion.parameter).toContainEqual({ name: 'used-supplement', valueUri: SYS + '|2.0.0' });
    expectWarning(expansionIssues(res.body));
  });

  test('$validate-code of a code the code system has: valid, with the warning', async () => {
    const res = await post('$validate-code', SUPPLEMENT, valueSet('1.0.0'), { name: 'coding', valueCoding: { system: SYS, version: '1.0.0', code: 'a' } });
    expect(res.status).toBe(200);
    expect(res.body.parameter.find(p => p.name === 'result').valueBoolean).toBe(true);
    expectWarning(res.body.parameter.find(p => p.name === 'issues').resource);
  });

  test('a supplement with a url of its own is not warned about', async () => {
    const res = await post('$expand', OWN_URL_SUPPLEMENT, valueSet('1.0.0'));
    expect(res.status).toBe(200);
    expect(sameUrlWarnings(expansionIssues(res.body))).toHaveLength(0);
    const vc = await post('$validate-code', OWN_URL_SUPPLEMENT, valueSet('1.0.0'), { name: 'coding', valueCoding: { system: SYS, version: '1.0.0', code: 'a' } });
    const issues = vc.body.parameter.find(p => p.name === 'issues');
    expect(sameUrlWarnings(issues ? issues.resource : null)).toHaveLength(0);
  });
});
