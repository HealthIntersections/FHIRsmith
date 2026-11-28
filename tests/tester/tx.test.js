//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// The tester module's terminology runs (/tester?kind=tx): the form and its modes, which tests a
// run asks the validator for (modes, the server's FHIR version), what's kept of each (the
// request, the expected response, and for a failure what the server answered), and the report.
// The validator here is a stand-in that answers as fhir-validator-wrapper's does; the real one
// is tx/tests/test-runner.js's business.

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { ADMIN_PASSWORD, setupAuth, mountAuth, makeUser, login, csrfOf } = require('../helpers/auth');
const TesterModule = require('../../tester/tester');
const htmlServer = require('../../library/html-server');
const { selectTests } = require('../../tester/tx/run');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
htmlServer.useLog(quiet);

function makeStats() {
  return { countRequest() {}, addTask() {}, taskDone() {}, taskError() {} };
}

// a test package: suites in modes and at versions, with their request and response files
const TEST_CASES = {
  suites: [
    { name: 'metadata', tests: [{ name: 'metadata', operation: 'metadata', response: 'capstmt.json' }] },
    { name: 'simple', mode: 'general', tests: [
      { name: 'simple-expand', operation: 'expand', request: 'simple/expand-request.json', response: 'simple/expand-response.json', description: 'An expansion' },
      { name: 'simple-validate', operation: 'validate-code', request: 'simple/validate-request.json', response: 'simple/validate-response.json' },
      { name: 'simple-r5-only', operation: 'expand', version: '5.0', request: 'simple/expand-request.json', response: 'simple/expand-response.json' },
      { name: 'simple-full-set', operation: 'expand', 'full-set': true, request: 'simple/expand-request.json', response: 'simple/expand-response.json' }
    ] },
    { name: 'sct', mode: 'snomed', tests: [{ name: 'sct-lookup', operation: 'lookup', request: 'sct/lookup-request.json', response: 'sct/lookup-response.json' }] },
    { name: 'r5-suite', mode: 'general', version: '5.0', tests: [{ name: 'r5-test', operation: 'expand', request: 'simple/expand-request.json', response: 'simple/expand-response.json' }] },
    { name: 'off', mode: 'general', disabled: true, tests: [{ name: 'off-test', operation: 'expand', request: 'simple/expand-request.json', response: 'simple/expand-response.json' }] }
  ]
};

describe('the tester module: terminology servers', () => {
  let tmp;
  let app;
  let tester;
  let validator;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tester-tx-'));
    const folder = path.join(tmp, 'tests');
    for (const [f, content] of [['capstmt.json', '{"resourceType": "CapabilityStatement"}'], ['simple/expand-request.json', '{"resourceType": "Parameters", "parameter": [{"name": "url"}]}'],
      ['simple/expand-response.json', '{"resourceType": "ValueSet", "id": "$id$"}'], ['simple/validate-request.json', '{"resourceType": "Parameters"}'],
      ['simple/validate-response.json', '{"resourceType": "Parameters", "parameter": [{"name": "result", "valueBoolean": true}]}'],
      ['sct/lookup-request.json', '{}'], ['sct/lookup-response.json', '{}']]) {
      fs.mkdirSync(path.dirname(path.join(folder, f)), { recursive: true });
      fs.writeFileSync(path.join(folder, f), content);
    }
    // a stand-in for fhir-validator-wrapper: the session is an R4 server; simple-validate fails,
    // and the validator writes the expected and actual responses, as TxTester does
    validator = {
      sessions: [],
      runs: [],
      async txTestSetup(p) {
        const output = path.join(tmp, 'output', p.folder);
        this.sessions.push(p);
        return { session: 's-' + this.sessions.length, server: p.server, 'test-version': '1.9.9', fhirVersion: '4.0.1', software: 'Example TX 1.0', output };
      },
      async runTxTest(p) {
        this.runs.push(p);
        if (p.testName === 'simple-validate') {
          const out = path.join(tmp, 'output', this.sessions[this.sessions.length - 1].folder, p.label);
          for (const [sub, text] of [['expected', '{"resourceType": "Parameters", "parameter": [{"name": "result", "valueBoolean": true}]}'],
            ['actual', '{"resourceType": "Parameters", "parameter": [{"name": "result", "valueBoolean": false}]}']]) {
            fs.mkdirSync(path.join(out, sub, 'simple'), { recursive: true });
            fs.writeFileSync(path.join(out, sub, 'simple', 'validate-response.json'), text);
          }
          return { result: false, message: 'result: expected true but was false' };
        }
        return { result: true };
      },
      async txTestTeardown(session) {
        this.tornDown = session;
        return {};
      },
      jarVersion() {
        return '7.9.9';
      }
    };
    app = express();
    setupAuth();
    await makeUser('admin', ADMIN_PASSWORD, { admin: true });
    await makeUser('erin', 'erin-password-long-enough');
    mountAuth(app);
    tester = new TesterModule(makeStats(), quiet);
    await tester.initialize({ database: ':memory:', npm: { control: false } }, {
      queueMs: 60 * 60 * 1000, autoStart: false, txValidator: validator,
      txTests: async () => ({ folder, testCases: TEST_CASES, externals: {}, version: '1.9.9' })
    });
    app.use('/tester', tester.router);
  }, 60000);

  afterAll(async () => {
    await tester.shutdown();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function finish() {
    for (let i = 0; i < 100 && (tester.current || tester.store.nextQueued()); i++) {
      if (tester.current) {
        await tester.current.done;
      } else {
        tester.next();
      }
    }
  }

  test('which tests run: the modes, the FHIR version, and not full-set or disabled ones', () => {
    const names = (modes, v) => selectTests(TEST_CASES, new Set(modes), v).map(x => x.test.name);
    expect(names(['general'], '4.0')).toEqual(['metadata', 'simple-expand', 'simple-validate']);
    expect(names(['general'], '5.0')).toEqual(['metadata', 'simple-expand', 'simple-validate', 'simple-r5-only', 'r5-test']);
    expect(names(['general', 'snomed'], '4.0')).toEqual(['metadata', 'simple-expand', 'simple-validate', 'sct-lookup']);
    expect(names(['snomed'], '4.0')).toEqual(['metadata', 'sct-lookup']);
  });

  test('the form: a tab, the modes (general ticked), kept in localStorage', async () => {
    const { agent } = await login(app, 'erin', 'erin-password-long-enough');
    const page = await agent.get('/tester?kind=tx');
    expect(page.status).toBe(200);
    expect(page.text).toContain('name="kind" value="tx"');
    expect(page.text).toContain('value="general" id="mode-general" checked="checked"');
    expect(page.text).toContain('value="snomed" id="mode-snomed"/>');
    expect(page.text).toContain('localStorage');
    expect(page.text).toContain('fhirsmith.tester.txModes');
    expect(page.text).toContain('https only');
    expect(page.text).not.toContain('name="token"');
    expect((await agent.get('/tester')).text).toContain('href="/tester?kind=tx"');
  });

  test('a run needs modes, and an https address (unless allowPrivateAddresses)', async () => {
    const { agent } = await login(app, 'erin', 'erin-password-long-enough');
    const csrf = await csrfOf(agent, '/tester');
    let r = await agent.post('/tester/run').type('form').send({ kind: 'tx', server: 'https://tx.example.org/r4', _csrf: csrf });
    expect(r.status).toBe(400);
    expect(r.text).toContain('at least one mode');
    r = await agent.post('/tester/run').type('form').send({ kind: 'tx', server: 'https://tx.example.org/r4', modes: 'not-a-mode', _csrf: csrf });
    expect(r.status).toBe(400);
    r = await agent.post('/tester/run').type('form').send({ kind: 'tx', server: 'http://tx.example.org/r4', modes: 'general', _csrf: csrf });
    expect(r.status).toBe(400);
    expect(r.text).toContain('https:');
    expect(tester.store.count()).toBe(0);
  });

  test('a run: the tests of the modes at the server\'s version, each kept with its detail, and a report', async () => {
    tester.allowPrivate = true;
    let id;
    try {
      const { agent } = await login(app, 'erin', 'erin-password-long-enough');
      const csrf = await csrfOf(agent, '/tester');
      const r = await agent.post('/tester/run').type('form').send(`kind=tx&server=${encodeURIComponent('http://127.0.0.1:1/r4')}&modes=general&modes=snomed&_csrf=${encodeURIComponent(csrf)}`);
      expect(r.status).toBe(303);
      id = r.headers.location.split('/').pop();
      expect(tester.store.get(id)).toMatchObject({ Kind: 'tx', Modes: JSON.stringify(['general', 'snomed']), Status: 'queued' });
      await finish();
    } finally {
      tester.allowPrivate = false;
    }
    expect(validator.sessions[0]).toMatchObject({ server: 'http://127.0.0.1:1/r4', testVersion: 'current', folder: 'tester-' + id });
    expect(validator.runs.map(x => `${x.suiteName}/${x.testName}`)).toEqual(['metadata/metadata', 'simple/simple-expand', 'simple/simple-validate', 'sct/sct-lookup']);
    expect(validator.runs.every(x => x.modes === 'general,snomed' && x.session === 's-1')).toBe(true);
    expect(validator.tornDown).toBe('s-1');
    const run = tester.store.get(id);
    expect(run).toMatchObject({ Status: 'completed', Pass: 3, Fail: 1, FhirVersion: '4.0.1', Software: 'Example TX 1.0' });

    // a failure's page: the request, the expected response, and what the server answered
    const failed = tester.store.results(id).find(x => x.Name === 'simple-validate');
    expect(failed).toMatchObject({ GroupName: 'simple', Outcome: 'fail', Message: 'result: expected true but was false' });
    const page = await request(app).get(`/tester/runs/${id}/tests/${failed.Seq}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('The expected response');
    expect(page.text).toContain('&quot;valueBoolean&quot;: true');
    expect(page.text).toContain('What the server answered');
    expect(page.text).toContain('&quot;valueBoolean&quot;: false');
    // a pass: the request and the expected response
    const passed = tester.store.result(id, tester.store.results(id).find(x => x.Name === 'simple-expand').Seq);
    expect(passed.Exchanges[0].tx).toMatchObject({ operation: 'expand', description: 'An expansion' });
    expect(passed.Exchanges[0].tx.request).toContain('"url"');
    expect(passed.Exchanges[0].tx.actual).toBeUndefined();

    // the run's page and the list
    const runPage = await request(app).get(`/tester/runs/${id}`);
    expect(runPage.text).toContain('Terminology server');
    expect(runPage.text).toContain('general, snomed');
    expect((await request(app).get('/tester')).text).toContain('terminology (FHIR 4.0.1)');

    // the report: as the tx tests' own
    const report = JSON.parse(run.Report);
    expect(report).toMatchObject({ resourceType: 'TestReport', name: 'TxEcosystemTests', result: 'fail', score: 75 });
    expect(report.testScript).toBe('https://github.com/HL7/fhir-tx-ecosystem-ig/blob/main/tests/test-cases.json|1.9.9');
    expect(report.tester).toContain('(modes general, snomed)');
    expect(report.participant[0]).toMatchObject({ type: 'server', uri: 'http://127.0.0.1:1/r4', version: '4.0.1', display: 'Example TX 1.0' });
    expect(report.participant[1]).toMatchObject({ type: 'test-engine', version: '7.9.9' });
    expect(report.test.map(t => t.name)).toEqual(['metadata/metadata', 'simple/simple-expand', 'simple/simple-validate', 'sct/sct-lookup']);
  });

  test('the validator can\'t start a run against the server: an error, and why', async () => {
    tester.allowPrivate = true;
    const setup = validator.txTestSetup;
    validator.txTestSetup = async () => {
      throw new Error('Terminology test setup failed: HTTP 500: could not connect');
    };
    try {
      const { agent } = await login(app, 'erin', 'erin-password-long-enough');
      const csrf = await csrfOf(agent, '/tester');
      const r = await agent.post('/tester/run').type('form').send({ kind: 'tx', server: 'http://127.0.0.1:1/r4', modes: 'general', _csrf: csrf });
      const id = r.headers.location.split('/').pop();
      await finish();
      expect(tester.store.get(id)).toMatchObject({ Status: 'error' });
      expect(tester.store.get(id).Message).toContain('could not connect');
    } finally {
      validator.txTestSetup = setup;
      tester.allowPrivate = false;
    }
  });

  test('turned off: no tab, and a run is refused', async () => {
    const saved = tester.tx;
    tester.tx = { ...saved, enabled: false };
    try {
      const { agent } = await login(app, 'erin', 'erin-password-long-enough');
      expect((await agent.get('/tester')).text).not.toContain('kind=tx');
      const csrf = await csrfOf(agent, '/tester');
      const r = await agent.post('/tester/run').type('form').send({ kind: 'tx', server: 'https://tx.example.org/r4', modes: 'general', _csrf: csrf });
      expect(r.status).toBe(404);
    } finally {
      tester.tx = saved;
    }
  });
});
