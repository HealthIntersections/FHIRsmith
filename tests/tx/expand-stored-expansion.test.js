/**
 * A value set that carries an expansion (e.g. one sent as a tx-resource) is expanded from its
 * compose (K9). Its stored expansion is used only when it has no compose, or a code system the
 * compose includes isn't available, so the compose can't be expanded.
 */

const path = require('path');
const express = require('express');
const request = require('supertest');
const TXModule = require('../../tx/tx');

jest.setTimeout(60000);

const CS = 'http://example.org/fhir/CodeSystem/k9';
const cs = (version, codes) => ({ resourceType: 'CodeSystem', url: CS, version, status: 'active', content: 'complete',
  concept: codes.map(c => ({ code: c, display: c + ' ' + version })) });
const V1 = cs('1.0.0', ['a', 'b']);
const V2 = cs('1.2.0', ['a', 'b', 'c']);

function imported(url, include, usedVersion, codes) {
  const vs = { resourceType: 'ValueSet', url, version: '1', status: 'active', expansion: {
    timestamp: '2026-01-01T00:00:00Z', total: codes.length,
    parameter: usedVersion ? [{ name: 'used-codesystem', valueUri: include.system + '|' + usedVersion }] : [],
    contains: codes.map(c => ({ system: include.system, version: usedVersion, code: c })) } };
  if (include) {
    vs.compose = { include: [include] };
  }
  return vs;
}

async function expandImport(app, imp, more = []) {
  const res = await request(app).post('/tx/r4/ValueSet/$expand').set('Accept', 'application/json').set('Content-Type', 'application/json')
    .send({ resourceType: 'Parameters', parameter: [
      { name: 'valueSet', resource: { resourceType: 'ValueSet', url: imp.url + '-outer', status: 'active', compose: { include: [{ valueSet: [imp.url] }] } } },
      { name: 'tx-resource', resource: imp }, { name: 'tx-resource', resource: V1 }, { name: 'tx-resource', resource: V2 }, ...more] });
  expect(res.status).toBe(200);
  return (res.body.expansion.contains || []).map(c => c.code).sort();
}

describe('stored expansions of imported value sets', () => {
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

  test('made from a version other than the one the server would use: expanded from the compose', async () => {
    expect(await expandImport(app, imported('http://example.org/vs/k9-stale', { system: CS }, '1.0.0', ['a']))).toEqual(['a', 'b', 'c']);
  });

  test('made from a version other than the forced one: expanded from the compose', async () => {
    expect(await expandImport(app, imported('http://example.org/vs/k9-forced', { system: CS }, '1.2.0', ['a']),
      [{ name: 'force-system-version', valueCanonical: CS + '|1.0.0' }])).toEqual(['a', 'b']);
  });

  test('made from the version the server would use, but with other codes: expanded from the compose', async () => {
    expect(await expandImport(app, imported('http://example.org/vs/k9-current', { system: CS }, '1.2.0', ['a']))).toEqual(['a', 'b', 'c']);
  });

  test('pinned to a version the server does not have: used as it is', async () => {
    expect(await expandImport(app, imported('http://example.org/vs/k9-pinned', { system: CS, version: '0.9.0' }, '0.9.0', ['z']))).toEqual(['z']);
  });

  test('made from a code system the server does not have: used as it is', async () => {
    expect(await expandImport(app, imported('http://example.org/vs/k9-unknown', { system: 'http://example.org/fhir/CodeSystem/k9-unknown' }, '2.0', ['x']))).toEqual(['x']);
  });

  test('with no compose: used as it is', async () => {
    const vs = imported('http://example.org/vs/k9-nocompose', { system: CS }, '1.0.0', ['a']);
    delete vs.compose;
    expect(await expandImport(app, vs)).toEqual(['a']);
  });
});
