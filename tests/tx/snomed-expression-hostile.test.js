/**
 * Hostile SNOMED CT expressions, through the server. Each must be answered promptly: the
 * expression code runs synchronously, so a slow one holds the whole process. On 2026-11-11
 * a $validate-code whose code had an unterminated term (no closing "|") held a tx.fhir.org
 * worker for 321 s and 17 GB.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const request = require('supertest');
const TXModule = require('../../tx/tx');
const folders = require('../../library/folder-setup');

const SCT = 'http://snomed.info/sct';
let app;
let txModule;

beforeAll(async () => {
  const committed = path.resolve(__dirname, '../../tx/data/snomed-testing.cache');
  const target = path.join(folders.subDir('terminology-cache'), 'snomed-testing.cache');
  if (!fs.existsSync(target)) {
    fs.copyFileSync(committed, target);
  }
  app = express();
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));
  txModule = new TXModule();
  await txModule.initialize({
    librarySource: path.join(__dirname, 'fixtures', 'test-library-snomed.yaml'),
    endpoints: [{ path: '/tx/r5', fhirVersion: '5.0', context: null }]
  }, app);
}, 60000);

afterAll(async () => {
  if (txModule) {
    await txModule.shutdown();
  }
});

async function timed(fn) {
  const t0 = Date.now();
  const res = await fn();
  return { res, ms: Date.now() - t0 };
}

const lookup = (code) => request(app).post('/tx/r5/CodeSystem/$lookup').set('Content-Type', 'application/json')
  .send({ resourceType: 'Parameters', parameter: [{ name: 'system', valueUri: SCT }, { name: 'code', valueCode: code }] });

test('$lookup of an expression with an unterminated term', async () => {
  const { res, ms } = await timed(() => lookup('64572001 |Disease'));
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
  expect(ms).toBeLessThan(2000);
});

test('$validate-code against a value set that lists the code, with an unterminated term', async () => {
  const { res, ms } = await timed(() => request(app).post('/tx/r5/ValueSet/$validate-code').set('Content-Type', 'application/json').send({
    resourceType: 'Parameters',
    parameter: [
      { name: 'valueSet', resource: { resourceType: 'ValueSet', url: 'http://example.org/vs/hostile', status: 'active',
        compose: { include: [{ system: SCT, concept: [{ code: '64572001' }, { code: '404684003' }] }] } } },
      { name: 'coding', valueCoding: { system: SCT, code: '64572001 |Disease' } }
    ]
  }));
  expect(res.status).toBe(200);
  expect(res.body.parameter.find(p => p.name === 'result').valueBoolean).toBe(false);
  expect(ms).toBeLessThan(2000);
});

test('$lookup of an expression with a thousand attributes is refused at once', async () => {
  const code = '64572001:' + Array.from({ length: 1000 }, () => '363698007=39607008').join(',');
  const { res, ms } = await timed(() => lookup(code));
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
  expect(JSON.stringify(res.body)).toContain('more than 500 concepts');
  expect(ms).toBeLessThan(2000);
});

test('$subsumes of a concept and a refined expression', async () => {
  // (a defined concept whose stored normal form is empty - as in this test subset - failed with a 500)
  const { res } = await timed(() => request(app).post('/tx/r5/CodeSystem/$subsumes').set('Content-Type', 'application/json').send({
    resourceType: 'Parameters',
    parameter: [{ name: 'system', valueUri: SCT }, { name: 'codeA', valueCode: '404684003' }, { name: 'codeB', valueCode: '64572001:363698007=39607008' }]
  }));
  expect(res.status).toBe(200);
  expect(res.body.parameter.find(p => p.name === 'outcome').valueCode).toBe('subsumes');
});

test('$subsumes of two large expressions within the limits is prompt', async () => {
  const a = '64572001:' + Array.from({ length: 120 }, (_, i) => `{363698007=${['39607008', '10200004'][i % 2]},116676008=24028007}`).join('');
  const { res, ms } = await timed(() => request(app).post('/tx/r5/CodeSystem/$subsumes').set('Content-Type', 'application/json').send({
    resourceType: 'Parameters',
    parameter: [{ name: 'system', valueUri: SCT }, { name: 'codeA', valueCode: '404684003' }, { name: 'codeB', valueCode: a }]
  }));
  expect(res.status).toBe(200);
  expect(ms).toBeLessThan(3000);
});
