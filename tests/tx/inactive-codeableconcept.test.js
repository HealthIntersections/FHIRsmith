/**
 * $validate-code on a CodeableConcept: the INACTIVE_CONCEPT_FOUND warning must name the coding
 * that is actually inactive. It used to name the first coding's code whichever coding was
 * inactive - e.g. CVX 197 reported as inactive because a second, inactive coding sat beside it.
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

const SYS = 'http://example.org/fhir/CodeSystem/inactive-cc';
const OTHER = 'http://example.org/fhir/CodeSystem/inactive-cc-other';

const CS = {
  resourceType: 'CodeSystem', url: SYS, version: '1.0.0', status: 'active', content: 'complete',
  concept: [
    { code: 'codeActive', display: 'Display Active' },
    { code: 'codeInactive', display: 'Display Inactive', property: [{ code: 'inactive', valueBoolean: true }] }
  ]
};
// a second code system, not in the value set, whose only concept is inactive
const CS_OTHER = {
  resourceType: 'CodeSystem', url: OTHER, version: '1.0.0', status: 'active', content: 'complete',
  concept: [{ code: 'otherInactive', display: 'Other Inactive', property: [{ code: 'inactive', valueBoolean: true }] }]
};
const VS = {
  resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/inactive-cc', version: '1.0.0',
  status: 'active', compose: { include: [{ system: SYS }] }
};

describe('INACTIVE_CONCEPT_FOUND names the inactive coding in a CodeableConcept', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  const validate = (coding) => request(app)
    .post('/tx/r5/ValueSet/$validate-code')
    .set('Content-Type', 'application/json')
    .send({ resourceType: 'Parameters', parameter: [
      { name: 'valueSet', resource: VS },
      { name: 'codeableConcept', valueCodeableConcept: { coding } },
      { name: 'tx-resource', resource: CS },
      { name: 'tx-resource', resource: CS_OTHER }
    ] });

  const inactiveIssues = (body) => {
    const oo = (body.parameter.find(p => p.name === 'issues') || {}).resource || { issue: [] };
    return oo.issue.filter(i => /has a status of/.test(i.details.text));
  };
  // the inactive parameter describes the returned code only, not whichever coding was inactive
  const param = (body, name) => body.parameter.find(p => p.name === name);

  test('first coding active, second inactive (same system): names the second', async () => {
    const res = await validate([{ system: SYS, code: 'codeActive' }, { system: SYS, code: 'codeInactive' }]);
    expect(res.status).toBe(200);
    const iss = inactiveIssues(res.body);
    expect(iss.length).toBe(1);
    expect(iss[0].details.text).toBe("The concept 'codeInactive' has a status of inactive and its use should be reviewed");
    expect(iss[0].expression).toEqual(['CodeableConcept.coding[1]']);
    expect(param(res.body, 'code').valueCode).toBe('codeActive');
    expect(param(res.body, 'inactive')).toBeUndefined();
  });

  // the later, active coding used to reset the inactive flag, so no warning was produced at all
  test('first coding inactive, second active: still warns, naming the first', async () => {
    const res = await validate([{ system: SYS, code: 'codeInactive' }, { system: SYS, code: 'codeActive' }]);
    expect(res.status).toBe(200);
    const iss = inactiveIssues(res.body);
    expect(iss.length).toBe(1);
    expect(iss[0].details.text).toBe("The concept 'codeInactive' has a status of inactive and its use should be reviewed");
    expect(iss[0].expression).toEqual(['CodeableConcept.coding[0]']);
    expect(param(res.body, 'code').valueCode).toBe('codeInactive');
    expect(param(res.body, 'inactive').valueBoolean).toBe(true);
  });

  test('second coding inactive and not in the value set: names it, not the first coding', async () => {
    const res = await validate([{ system: SYS, code: 'codeActive' }, { system: OTHER, code: 'otherInactive' }]);
    expect(res.status).toBe(200);
    const iss = inactiveIssues(res.body);
    expect(iss.length).toBe(1);
    expect(iss[0].details.text).toBe("The concept 'otherInactive' has a status of inactive and its use should be reviewed");
    expect(iss[0].expression).toEqual(['CodeableConcept.coding[1]']);
    expect(param(res.body, 'inactive')).toBeUndefined();
  });
});
