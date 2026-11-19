/**
 * $validate-code against a value set whose include names a code system the server doesn't have,
 * without a version, for a coding that does carry a version. There is no version in the include
 * to compare the coding's with, so no version mismatch to report - it was reported, as
 * "version 'undefined' in the ValueSet include is different to the one in the value ('1.0')".
 * When the include does name a version, the mismatch is still reported.
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

const SYS = 'http://example.org/fhir/CodeSystem/not-here';

describe('a versioned coding, a value set include of an unknown code system', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  const validate = (include) => request(app)
    .post('/tx/r5/ValueSet/$validate-code')
    .set('Content-Type', 'application/json')
    .send({ resourceType: 'Parameters', parameter: [
      { name: 'valueSet', resource: { resourceType: 'ValueSet', status: 'active', compose: { include: [include] } } },
      { name: 'coding', valueCoding: { system: SYS, version: '1.0', code: 'a' } }
    ] });

  const param = (body, name) => body.parameter.find(p => p.name === name);
  const issues = (body) => param(body, 'issues').resource.issue;
  const messageIds = (body) => issues(body).map(i => i.extension[0].valueString);

  test('include without a version: the code system is unknown, and no version mismatch', async () => {
    const res = await validate({ system: SYS });
    expect(res.status).toBe(200);
    expect(param(res.body, 'result').valueBoolean).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('undefined');
    expect(messageIds(res.body)).toEqual(['UNKNOWN_CODESYSTEM']);
    expect(param(res.body, 'message').valueString).not.toContain('in the ValueSet include is different');
  });

  test('include with another version: the version mismatch is reported, naming both versions', async () => {
    const res = await validate({ system: SYS, version: '2.0' });
    expect(res.status).toBe(200);
    expect(param(res.body, 'result').valueBoolean).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('undefined');
    const mismatch = issues(res.body).find(i => i.extension[0].valueString === 'VALUESET_VALUE_MISMATCH');
    expect(mismatch.details.text).toBe(`The code system '${SYS}' version '2.0' in the ValueSet include is different to the one in the value ('1.0')`);
  });
});
