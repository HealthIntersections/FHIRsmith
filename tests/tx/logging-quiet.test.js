// Routine client errors aren't logged (the request's own log line has its status); a bad
// Accept-Language is a 400; a slow request's log line says what it asked
const request = require('supertest');
const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');
const Logger = require('../../library/logger');

let app;
const lines = [];
let enqueue;

beforeAll(async () => {
  const logger = Logger.getInstance();
  enqueue = logger._enqueue;
  logger._enqueue = function (line) {
    lines.push(line);
    return enqueue.call(this, line);
  };
  app = await getTestApp();
}, 60000);

afterAll(async () => {
  Logger.getInstance()._enqueue = enqueue;
  await shutdownTestApp();
});

const P = (parameter) => ({ resourceType: 'Parameters', parameter });

async function send(method, url, body, headers = {}) {
  const from = lines.length;
  let r = method === 'GET' ? request(app).get(url) : request(app).post(url).set('Content-Type', 'application/json').send(JSON.stringify(body));
  for (const [k, v] of Object.entries(headers)) {
    r = r.set(k, v);
  }
  const res = await r;
  return { res, logged: lines.slice(from) };
}

const problems = (logged) => logged.filter(l => / (error|warn) /.test(l.substring(0, 40)));

describe('routine client errors are not logged', () => {
  test('an unknown cache-id', async () => {
    const { res, logged } = await send('POST', '/tx/r5/ValueSet/$validate-code', P([
      { name: 'url', valueUri: 'http://hl7.org/fhir/ValueSet/administrative-gender' },
      { name: 'code', valueCode: 'male' }, { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' },
      { name: 'cache-id', valueId: '813c6d23-0c4a-47db-bfb2-9ba8ac1346ef' }]));
    expect(res.status).toBe(404);
    expect(problems(logged)).toEqual([]);
  });

  test('$lookup of an unknown code', async () => {
    const { res, logged } = await send('GET', '/tx/r5/CodeSystem/$lookup?system=http://hl7.org/fhir/administrative-gender&code=nope');
    expect(res.status).toBe(404);
    expect(problems(logged)).toEqual([]);
  });

  test('$validate-code with an unknown code system', async () => {
    const { res, logged } = await send('POST', '/tx/r5/CodeSystem/$validate-code', P([
      { name: 'coding', valueCoding: { system: 'urn:oid:2.16.840.1.113883.6.12', code: '99213' } }]));
    expect(res.status).toBe(200);
    expect(problems(logged)).toEqual([]);
  });

  test('$validate-code with an unknown version of a code system', async () => {
    const { res, logged } = await send('POST', '/tx/r5/CodeSystem/$validate-code', P([
      { name: 'coding', valueCoding: { system: 'http://hl7.org/fhir/administrative-gender', version: '0.0.1', code: 'male' } }]));
    expect(res.status).toBe(200);
    expect(problems(logged)).toEqual([]);
  });

  test('an Accept-Language that is not valid is a 400', async () => {
    const { res, logged } = await send('GET', '/tx/r5/CodeSystem/$lookup?system=http://hl7.org/fhir/administrative-gender&code=male', null,
      { 'Accept-Language': 'zz-qq' });
    expect(res.status).toBe(400);
    expect(res.body.resourceType).toBe('OperationOutcome');
    expect(problems(logged)).toEqual([]);
  });
});

describe('a slow request', () => {
  afterEach(() => {
    delete getTxModule().config.slowRequestSeconds;
  });

  test('its log line says what it asked', async () => {
    getTxModule().config.slowRequestSeconds = 0.000001;
    const { logged } = await send('POST', '/tx/r5/ValueSet/$validate-code', P([
      { name: 'url', valueUri: 'http://hl7.org/fhir/ValueSet/administrative-gender' },
      { name: 'coding', valueCoding: { system: 'http://hl7.org/fhir/administrative-gender', code: 'male', display: 'Male' } }]),
      { 'Accept-Language': 'de' });
    const slow = logged.filter(l => l.includes('slow request'));
    expect(slow).toHaveLength(1);
    expect(slow[0]).toContain(' warn ');
    expect(slow[0]).toContain('POST /tx/r5/ValueSet/$validate-code');
    expect(slow[0]).toContain('Accept-Language: de');
    expect(slow[0]).toContain("body: url=http://hl7.org/fhir/ValueSet/administrative-gender; coding=http://hl7.org/fhir/administrative-gender#male 'Male'");
  });

  test('0: no slow request line', async () => {
    getTxModule().config.slowRequestSeconds = 0;
    const { logged } = await send('GET', '/tx/r5/CodeSystem/$lookup?system=http://hl7.org/fhir/administrative-gender&code=male');
    expect(logged.filter(l => l.includes('slow request'))).toEqual([]);
  });
});
