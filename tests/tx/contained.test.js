/**
 * Contained resources in the terminology server: the only supported use is a ValueSet that
 * contains ValueSets, imported (or excluded) by #id. Anything else contained is rejected.
 * Also covers excluding value sets, circular references, and a value set with no compose.
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const { CodeSystem } = require('../../tx/library/codesystem');
const ValueSet = require('../../tx/library/valueset');
const { ConceptMap } = require('../../tx/library/conceptmap');
const { checkContained } = require('../../tx/library/canonical-resource');

const GENDER = 'http://hl7.org/fhir/administrative-gender';

const include = (...codes) => ({ include: [{ system: GENDER, concept: codes.map(code => ({ code })) }] });
const vs = (compose, contained, extra = {}) => ({
  resourceType: 'ValueSet', status: 'active', compose, ...(contained ? { contained } : {}), ...extra
});
const contained = (id, compose) => ({ resourceType: 'ValueSet', id, status: 'active', ...(compose ? { compose } : {}) });

function messageId(body) {
  const ext = ((body.issue || [])[0] || {}).extension || [];
  const e = ext.find(x => x.url === 'http://hl7.org/fhir/StructureDefinition/operationoutcome-message-id');
  return e ? e.valueString : undefined;
}

const codes = (body) => (body.expansion.contains || []).map(c => c.code).sort();

describe('the resource wrappers reject unsupported contained resources', () => {
  test('a ValueSet may contain ValueSets', () => {
    expect(() => new ValueSet(vs(include('male'), [contained('a', include('male'))]))).not.toThrow();
  });

  test('a ValueSet may not contain anything else', () => {
    expect(() => new ValueSet(vs(include('male'), [{ resourceType: 'CodeSystem', id: 'cs' }])))
      .toThrow(/contains a CodeSystem: this server only supports ValueSets contained in a ValueSet/);
  });

  test('a contained ValueSet may not itself contain resources', () => {
    const inner = { ...contained('a', include('male')), contained: [contained('b', include('male'))] };
    expect(() => new ValueSet(vs(include('male'), [inner]))).toThrow(/itself contains resources/);
  });

  test('a CodeSystem or ConceptMap may not contain anything', () => {
    expect(() => new CodeSystem({ resourceType: 'CodeSystem', url: 'http://example.org/cs', status: 'active',
      content: 'complete', contained: [contained('a')] })).toThrow(/CodeSystem.*contains a ValueSet/);
    expect(() => new ConceptMap({ resourceType: 'ConceptMap', url: 'http://example.org/cm', status: 'active',
      contained: [contained('a')] })).toThrow(/ConceptMap.*contains a ValueSet/);
  });

  test('the error is a 400 not-supported Issue with a message id', () => {
    try {
      checkContained({ resourceType: 'CodeSystem', contained: [{ resourceType: 'ValueSet' }] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.statusCode).toBe(400);
      expect(e.cause).toBe('not-supported');
      expect(e.msgId).toBe('CONTAINED_RESOURCE_NOT_SUPPORTED');
    }
  });

  test('an empty or absent contained is fine', () => {
    expect(() => checkContained({ resourceType: 'CodeSystem' })).not.toThrow();
    expect(() => checkContained({ resourceType: 'CodeSystem', contained: [] })).not.toThrow();
  });
});

describe('contained value sets, excludes and circularity, through the server', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  const expand = (valueSet, txResources = []) => request(app)
    .post('/tx/r5/ValueSet/$expand')
    .set('Content-Type', 'application/json')
    .send(({ resourceType: 'Parameters', parameter: [
      { name: 'valueSet', resource: valueSet },
      ...txResources.map(r => ({ name: 'tx-resource', resource: r }))
    ] }));

  const validate = (valueSet, code, txResources = []) => request(app)
    .post('/tx/r5/ValueSet/$validate-code')
    .set('Content-Type', 'application/json')
    .send(({ resourceType: 'Parameters', parameter: [
      { name: 'valueSet', resource: valueSet },
      { name: 'coding', valueCoding: { system: GENDER, code } },
      ...txResources.map(r => ({ name: 'tx-resource', resource: r }))
    ] }));

  const result = (body) => (body.parameter.find(p => p.name === 'result') || {}).valueBoolean;

  const VS_MALE = { resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/male', version: '1.0.0',
    status: 'active', compose: include('male') };

  test('importing a contained value set', async () => {
    const res = await expand(vs({ include: [{ valueSet: ['#a'] }] }, [contained('a', include('male', 'female'))]));
    expect(res.status).toBe(200);
    expect(codes(res.body)).toEqual(['female', 'male']);
  });

  test('a contained value set importing another contained value set', async () => {
    const v = vs({ include: [{ valueSet: ['#a'] }] },
      [contained('a', { include: [{ valueSet: ['#b'] }] }), contained('b', include('other'))]);
    const res = await expand(v);
    expect(res.status).toBe(200);
    expect(codes(res.body)).toEqual(['other']);
    expect(result((await validate(v, 'other')).body)).toBe(true);
    expect(result((await validate(v, 'male')).body)).toBe(false);
  });

  test('excluding a contained value set', async () => {
    const v = vs({ include: [{ system: GENDER }], exclude: [{ valueSet: ['#a'] }] }, [contained('a', include('male'))]);
    const res = await expand(v);
    expect(res.status).toBe(200);
    expect(codes(res.body)).toEqual(['female', 'other', 'unknown']);
    expect(result((await validate(v, 'male')).body)).toBe(false);
    expect(result((await validate(v, 'female')).body)).toBe(true);
  });

  test('excluding a value set by url, which is reported as used', async () => {
    const v = vs({ include: [{ system: GENDER }], exclude: [{ valueSet: [VS_MALE.url] }] });
    const res = await expand(v, [VS_MALE]);
    expect(res.status).toBe(200);
    expect(codes(res.body)).toEqual(['female', 'other', 'unknown']);
    expect(res.body.expansion.parameter.filter(p => p.name === 'used-valueset').map(p => p.valueUri))
      .toEqual(['http://example.org/fhir/ValueSet/male|1.0.0']);
    expect(result((await validate(v, 'male', [VS_MALE])).body)).toBe(false);
  });

  test('a value set used twice is not a circularity', async () => {
    const v = vs({ include: [{ valueSet: ['#a'] }, { valueSet: ['#b'] }] },
      [contained('a', { include: [{ valueSet: [VS_MALE.url] }] }), contained('b', { include: [{ valueSet: [VS_MALE.url] }] })]);
    const res = await expand(v, [VS_MALE]);
    expect(res.status).toBe(200);
    expect(codes(res.body)).toEqual(['male']);
    expect(result((await validate(v, 'male', [VS_MALE])).body)).toBe(true);
  });

  test('contained value sets that import each other are a circularity', async () => {
    const v = vs({ include: [{ valueSet: ['#a'] }] },
      [contained('a', { include: [{ valueSet: ['#b'] }] }), contained('b', { include: [{ valueSet: ['#a'] }] })]);
    const res = await expand(v);
    expect(res.status).toBe(400);
    expect(messageId(res.body)).toBe('VALUESET_CIRCULAR_REFERENCE');
    const val = await validate(v, 'male');
    expect(val.status).toBe(400);
    expect(messageId(val.body)).toBe('VALUESET_CIRCULAR_REFERENCE');
  });

  test('a value set containing a CodeSystem is rejected', async () => {
    const res = await expand(vs({ include: [{ system: 'http://example.org/contained-cs' }] },
      [{ resourceType: 'CodeSystem', id: 'cs', url: 'http://example.org/contained-cs', status: 'active', content: 'complete',
        concept: [{ code: 'x' }] }]));
    expect(res.status).toBe(400);
    expect(messageId(res.body)).toBe('CONTAINED_RESOURCE_NOT_SUPPORTED');
  });

  test('a tx-resource with contained resources is rejected', async () => {
    const res = await expand(vs(include('male')), [{ resourceType: 'CodeSystem', url: 'http://example.org/cs2',
      status: 'active', content: 'complete', concept: [{ code: 'x' }], contained: [contained('a', include('male'))] }]);
    expect(res.status).toBe(400);
    expect(messageId(res.body)).toBe('CONTAINED_RESOURCE_NOT_SUPPORTED');
  });

  test('a value set with no compose and no expansion cannot be expanded', async () => {
    const res = await expand({ resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/empty', status: 'active' });
    expect(res.status).toBe(422);
    expect(messageId(res.body)).toBe('VALUESET_NO_COMPOSE');
  });

  test('nor can a contained one', async () => {
    const res = await expand(vs({ include: [{ valueSet: ['#a'] }] }, [contained('a')]));
    expect(res.status).toBe(422);
    expect(messageId(res.body)).toBe('VALUESET_NO_COMPOSE');
  });
});
