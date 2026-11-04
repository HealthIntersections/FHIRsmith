/**
 * ValueSet $validate-code with inferSystem (code with no system): the system is inferred by checking
 * the code against each include, and each value set they import - not by expanding the value set,
 * which can be too big to expand (K5) - and an include of a code system that isn't known is an error
 * naming it (K4). Runs against the committed SNOMED test subset and the R5 core resources.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const TXModule = require('../../tx/tx');
const folders = require('../../library/folder-setup');
const { ValueSetExpander } = require('../../tx/workers/expand');
const { Issue } = require('../../tx/library/operation-outcome');

jest.setTimeout(60000);

const SCT = 'http://snomed.info/sct';
const AG = 'http://hl7.org/fhir/administrative-gender';
const UNK = 'http://example.org/no-such-code-system';

function vs(url, include, exclude) {
  const res = { resourceType: 'ValueSet', url, version: '1', status: 'active', compose: { include } };
  if (exclude) {
    res.compose.exclude = exclude;
  }
  return res;
}

const ALL_SCT = vs('http://example.org/vs/all-sct', [{ system: SCT }]);
const ALL_AG = vs('http://example.org/vs/all-ag', [{ system: AG }]);

async function validate(app, valueSet, code, more = []) {
  const res = await request(app).post('/tx/r5/ValueSet/$validate-code')
    .set('Accept', 'application/json').set('Content-Type', 'application/json')
    .send({ resourceType: 'Parameters', parameter: [
      { name: 'valueSet', resource: valueSet },
      { name: 'code', valueCode: code },
      { name: 'inferSystem', valueBoolean: true },
      { name: 'tx-resource', resource: ALL_SCT },
      { name: 'tx-resource', resource: ALL_AG },
      ...more] });
  const param = (n) => {
    const p = (res.body.parameter || []).find(x => x.name === n);
    return p ? p.valueBoolean ?? p.valueUri ?? p.valueString : undefined;
  };
  return { status: res.status, body: res.body, result: param('result'), system: param('system'), message: param('message') };
}

describe('$validate-code with inferSystem', () => {
  let app;
  let txModule;
  let sctCode;

  beforeAll(async () => {
    const committed = path.resolve(__dirname, '../../tx/data/snomed-testing.cache');
    const target = path.join(folders.subDir('terminology-cache'), 'snomed-testing.cache');
    if (!fs.existsSync(target)) {
      fs.copyFileSync(committed, target);
    }
    app = express();
    app.use(express.json());
    txModule = new TXModule();
    await txModule.initialize({
      librarySource: path.join(__dirname, 'fixtures', 'test-library-snomed.yaml'),
      endpoints: [{ path: '/tx/r5', fhirVersion: '5.0', context: null }]
    }, app);
    const exp = await request(app).post('/tx/r5/ValueSet/$expand').set('Accept', 'application/json').set('Content-Type', 'application/json')
      .send({ resourceType: 'Parameters', parameter: [{ name: 'valueSet', resource: ALL_SCT }, { name: 'count', valueInteger: 1 }] });
    sctCode = exp.body.expansion.contains[0].code;
  }, 60000);

  afterAll(async () => {
    if (txModule) {
      await txModule.shutdown();
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('inferring without expanding (K5)', () => {
    test('a code in an imported value set of all of a code system', async () => {
      const expand = jest.spyOn(ValueSetExpander.prototype, 'expand');
      const r = await validate(app, vs('http://example.org/vs/k5', [{ system: AG }, { valueSet: [ALL_SCT.url] }]), sctCode,
      );
      expect(r.status).toBe(200);
      expect(r.result).toBe(true);
      expect(r.system).toBe(SCT);
      expect(expand).not.toHaveBeenCalled();
    });

    test('a code in an include, alongside an import of a value set too big to expand', async () => {
      // any expansion fails as too costly (as an expansion of all of UCUM, or a big SNOMED value set, does)
      jest.spyOn(ValueSetExpander.prototype, 'expand').mockImplementation(async () => {
        throw new Issue('error', 'too-costly', null, 'VALUESET_TOO_COSTLY', 'too many codes', null, 422);
      });
      const r = await validate(app, vs('http://example.org/vs/k5b', [{ system: AG }, { valueSet: [ALL_SCT.url] }]), 'male');
      expect(r.status).toBe(200);
      expect(r.result).toBe(true);
      expect(r.system).toBe(AG);
    });

    test('a code in no include cannot be inferred', async () => {
      const r = await validate(app, vs('http://example.org/vs/k5c', [{ system: AG }, { valueSet: [ALL_SCT.url] }]), 'no-such-code');
      expect(r.status).toBe(200);
      expect(r.result).toBe(false);
      expect(r.message).toMatch(/could not be determined/);
    });

    test('a code in two systems cannot be inferred', async () => {
      // a value set that lists the SNOMED code as a code of administrative-gender as well
      const r = await validate(app, vs('http://example.org/vs/k5d', [{ valueSet: [ALL_SCT.url] }, { system: 'http://example.org/cs-k5', concept: [{ code: sctCode }] }]), sctCode,
        [{ name: 'tx-resource', resource: { resourceType: 'CodeSystem', url: 'http://example.org/cs-k5', status: 'active', content: 'complete', concept: [{ code: sctCode, display: 'x' }] } }]);
      expect(r.status).toBe(200);
      expect(r.result).toBe(false);
      expect(r.message).toMatch(/multiple matches|more than one|http:\/\/example.org\/cs-k5/);
    });

    test('an exclude rules a system out', async () => {
      const cs = { resourceType: 'CodeSystem', url: 'http://example.org/cs-k5', status: 'active', content: 'complete', concept: [{ code: sctCode, display: 'x' }] };
      const r = await validate(app, vs('http://example.org/vs/k5e', [{ valueSet: [ALL_SCT.url] }, { system: cs.url }], [{ system: cs.url, concept: [{ code: sctCode }] }]), sctCode,
        [{ name: 'tx-resource', resource: cs }]);
      expect(r.status).toBe(200);
      expect(r.result).toBe(true);
      expect(r.system).toBe(SCT);
    });

    test('a filter that leaves the code out rules that include out', async () => {
      const cs = { resourceType: 'CodeSystem', url: 'http://example.org/cs-k5f', status: 'active', content: 'complete', hierarchyMeaning: 'is-a',
        concept: [{ code: 'parent', display: 'p', concept: [{ code: 'child', display: 'c' }] }, { code: sctCode, display: 'x' }] };
      const r = await validate(app, vs('http://example.org/vs/k5f', [{ valueSet: [ALL_SCT.url] }, { system: cs.url, filter: [{ property: 'concept', op: 'is-a', value: 'parent' }] }]), sctCode,
        [{ name: 'tx-resource', resource: cs }]);
      expect(r.status).toBe(200);
      expect(r.result).toBe(true);
      expect(r.system).toBe(SCT);
    });
  });

  describe('an include of an unknown code system (K4)', () => {
    test('alongside an import: 422 naming it', async () => {
      const r = await validate(app, vs('http://example.org/vs/k4a', [{ valueSet: [ALL_AG.url] }, { system: UNK }]), 'male');
      expect(r.status).toBe(422);
      expect(r.body.issue[0].details.text).toContain(UNK);
      expect(r.body.issue[0].extension[0].valueString).toBe('UNABLE_TO_INFER_CODESYSTEM_UNKNOWN_SYSTEM');
    });

    test('alongside a known system: 422 naming it', async () => {
      const r = await validate(app, vs('http://example.org/vs/k4b', [{ system: AG }, { system: UNK, concept: [{ code: 'x' }] }]), 'male');
      expect(r.status).toBe(422);
      expect(r.body.issue[0].details.text).toContain(UNK);
    });

    test('in an imported value set: 422 naming it', async () => {
      const r = await validate(app, vs('http://example.org/vs/k4c', [{ valueSet: ['http://example.org/vs/k4-inner'] }]), 'male',
        [{ name: 'tx-resource', resource: vs('http://example.org/vs/k4-inner', [{ system: AG }, { system: UNK }]) }]);
      expect(r.status).toBe(422);
      expect(r.body.issue[0].details.text).toContain(UNK);
      expect(r.body.issue[0].details.text).toContain('http://example.org/vs/k4-inner');
    });
  });
});
