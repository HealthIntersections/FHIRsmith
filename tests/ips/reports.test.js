//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Reports (ips/reports.js): the administrator's definitions, the tables built from every
 * document, the pipeline's reports step, project scoping, and the queries.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

const IpsModule = require('../../ips/ips');
const pipeline = require('../../ips/pipeline');
const htmlServer = require('../../library/html-server');

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
htmlServer.useLog(quietLog);

function makeStats() {
  return { countRequest() {}, addTask() {}, task() {}, taskDone() {}, taskError() {} };
}

/** An IPS document for a patient, with a Condition for each code given. */
function doc(patientId, codes) {
  const conditions = codes.map((code, i) => ({
    fullUrl: `urn:uuid:${patientId}-c${i}`,
    resource: {
      resourceType: 'Condition', id: `${patientId}-c${i}`, subject: { reference: `urn:uuid:${patientId}` },
      code: { coding: [{ system: 'http://snomed.info/sct', code }] }
    }
  }));
  return {
    resourceType: 'Bundle', type: 'document', timestamp: '2026-03-01T10:00:00Z',
    identifier: { system: 'urn:oid:2.16.840.1.113883.19.5', value: `doc-${patientId}` },
    entry: [
      {
        fullUrl: `urn:uuid:comp-${patientId}`,
        resource: {
          resourceType: 'Composition', id: `comp-${patientId}`, status: 'final', date: '2026-03-01T09:30:00Z', title: 'Patient Summary',
          type: { coding: [{ system: 'http://loinc.org', code: '60591-5' }] }, subject: { reference: `urn:uuid:${patientId}` },
          author: [{ reference: `urn:uuid:${patientId}` }],
          section: [{ title: 'Problems', code: { coding: [{ system: 'http://loinc.org', code: '11450-4' }] }, entry: conditions.map(c => ({ reference: c.fullUrl })) }]
        }
      },
      { fullUrl: `urn:uuid:${patientId}`, resource: { resourceType: 'Patient', name: [{ family: patientId }], gender: 'female', birthDate: '1970-01-01' } },
      ...conditions
    ]
  };
}

const CONDITIONS_VIEW = {
  resourceType: 'ViewDefinition', name: 'conditions', status: 'active', resource: 'Bundle',
  select: [{
    forEach: 'entry.resource.ofType(Condition)',
    column: [
      { name: 'resource_key', path: 'getResourceKey()', type: 'string' },
      { name: 'code', path: 'code.coding.first().code', type: 'code' },
      { name: 'patient', path: 'subject.getReferenceKey(Patient)', type: 'string' }
    ]
  }]
};

const ISSUES_VIEW = {
  resourceType: 'ViewDefinition', name: 'issues', status: 'active', resource: 'OperationOutcome',
  select: [{ forEach: 'issue', column: [{ name: 'severity', path: 'severity', type: 'code' }, { name: 'text', path: 'details.text', type: 'string' }] }]
};

async function makeApp(config = {}) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.raw({ type: 'application/fhir+json', limit: '50mb' }));
  app.use(express.json({ limit: '50mb' }));
  const mod = new IpsModule(makeStats(), quietLog);
  await mod.initialize({
    database: ':memory:', rateLimit: { max: 0 }, adminPassword: 'admin-secret', cookieSecure: false,
    processing: { enabled: false }, ...config
  }, app);
  app.use('/ips', mod.router);
  // the validator: accepts every view unless told otherwise
  mod.validator = {
    issues: [],
    isRunning: () => true,
    async validate() {
      return { resourceType: 'OperationOutcome', issue: this.issues };
    },
    async stop() {}
  };
  // the pipeline is just a validation outcome and the reports step
  mod.steps = [{
    name: 'validation',
    async run(row, project, m) {
      m.store.saveResult(row.id, 'validation', { outcome: { resourceType: 'OperationOutcome', issue: [{ severity: 'warning', code: 'informational', details: { text: `about ${row.id}` } }] } });
      return null;
    }
  }, pipeline.reports];
  return { app, mod };
}

const csrfOf = async (agent) => (await agent.get('/ips/login')).text.match(/name="_csrf" value="([^"]+)"/)[1];
// the token first: the agent puts its cookies on a request when it is made
const form = async (agent, url, data = {}) => {
  const _csrf = await csrfOf(agent);
  return agent.post(url).type('form').send({ ...data, _csrf });
};
const admin = async (app) => {
  const agent = request.agent(app);
  await form(agent, '/ips/login', { login: 'admin', password: 'admin-secret' });
  return agent;
};
const submit = (app, code, body) => request(app).post(`/ips/${code}/Bundle`).set('Content-Type', 'application/fhir+json').send(JSON.stringify(body));
const html = (app, url) => request(app).get(url).set('Accept', 'text/html');

/** Save a report through the administrator's form. */
async function saveReport(agent, view, { source = 'uploaded', statements = [], title = 'A report', url = '/ips/reports' } = {}) {
  return form(agent, url, {
    title, description: '', source, view: JSON.stringify(view),
    stmt_name: statements.map(s => s.name), stmt_sql: statements.map(s => s.sql)
  });
}

/** Process the queue until every document is done and every table is built. */
async function settle(mod) {
  for (let i = 0; i < 50 && (mod.store.statusCounts().submitted || mod.reports.building()); i++) {
    await mod.processQueue();
  }
}

describe('reports', () => {
  let app;
  let mod;
  let demo;
  let other;
  beforeEach(async () => {
    ({ app, mod } = await makeApp());
    demo = mod.store.createProject('demo', 'Demo', null);
    other = mod.store.createProject('other', 'Other', null);
  });
  afterEach(() => mod.shutdown());

  test('a report is built from every document already there, scoped to each project, with document-scoped keys', async () => {
    await submit(app, 'demo', doc('p1', ['111', '222']));
    await submit(app, 'demo', doc('p2', ['111']));
    await submit(app, 'other', doc('p3', ['333']));
    await settle(mod);

    const agent = await admin(app);
    const saved = await saveReport(agent, CONDITIONS_VIEW, {
      statements: [{ name: 'By code', sql: 'SELECT code, count(*) AS n FROM conditions GROUP BY code ORDER BY code' }]
    });
    expect(saved.status).toBe(302);
    expect(mod.reports.get('conditions').build.state).toBe('pending');
    await settle(mod);
    expect(mod.reports.get('conditions').build).toMatchObject({ state: 'ready', docs: 3 });

    // the statement sees only the project's rows
    const out = await mod.reports.query(mod.reports.get('conditions'), demo);
    expect(out.statements[0]).toMatchObject({ name: 'By code', columns: ['code', 'n'], rows: [['111', 2], ['222', 1]] });
    expect(out.raw.total).toBe(3);
    const keys = out.raw.rows.map(r => [r[out.raw.columns.indexOf('_document')], r[out.raw.columns.indexOf('resource_key')], r[out.raw.columns.indexOf('patient')]]);
    // Patients without ids are keyed by their fullUrl, inside the document
    expect(keys).toEqual([[1, '1/Condition/p1-c0', '1/urn:uuid:p1'], [1, '1/Condition/p1-c1', '1/urn:uuid:p1'], [2, '2/Condition/p2-c0', '2/urn:uuid:p2']]);
    expect((await mod.reports.query(mod.reports.get('conditions'), other)).statements[0].rows).toEqual([['333', 1]]);

    // the project's page
    const page = await html(app, '/ips/demo/reports/conditions');
    expect(page.status).toBe(200);
    expect(page.text).toContain('By code');
    expect(page.text).toContain('3 rows');
    expect(page.text).not.toContain('<td>333</td>');
    expect(page.text).toContain('<td>222</td>');
    const csv = await request(app).get('/ips/demo/reports/conditions/csv');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toBe('_document,resource_key,code,patient');
    expect(csv.text.trim().split('\r\n')).toHaveLength(4);
    expect((await html(app, '/ips/demo/reports')).text).toContain('/ips/demo/reports/conditions');
  });

  test('a document processed later goes into the table; deleting a document or project takes its rows', async () => {
    const agent = await admin(app);
    await saveReport(agent, CONDITIONS_VIEW);
    await settle(mod);
    await submit(app, 'demo', doc('p1', ['111']));
    await submit(app, 'other', doc('p2', ['222', '333']));
    await settle(mod);
    const report = () => mod.reports.get('conditions');
    expect((await mod.reports.query(report(), demo)).raw.total).toBe(1);
    expect(mod.store.readResult(2, 'reports').result).toMatchObject({ reports: 1, rows: 2, errors: [] });

    // processing again replaces the document's rows
    mod.store.requeue(1, demo);
    await settle(mod);
    expect((await mod.reports.query(report(), demo)).raw.total).toBe(1);

    expect((await form(agent, '/ips/demo/Bundle/1/delete')).status).toBe(302);
    expect((await mod.reports.query(report(), demo)).raw.total).toBe(0);
    expect((await form(agent, `/ips/admin/projects/${other}/delete`)).status).toBe(302);
    expect(mod.reports.db.prepare('SELECT count(*) AS n FROM conditions').get().n).toBe(0);
  });

  test('changing the view rebuilds the table, and the old one is shown until the new one is ready', async () => {
    await submit(app, 'demo', doc('p1', ['111']));
    await settle(mod);
    const agent = await admin(app);
    await saveReport(agent, CONDITIONS_VIEW);
    await settle(mod);
    expect(mod.reports.get('conditions').generation).toBe(1);

    // only the statements: no rebuild
    await saveReport(agent, CONDITIONS_VIEW, { url: '/ips/reports/conditions', statements: [{ name: 'All', sql: 'SELECT * FROM conditions' }] });
    expect(mod.reports.get('conditions')).toMatchObject({ generation: 1, build: { state: 'ready' } });

    const changed = structuredClone(CONDITIONS_VIEW);
    changed.select[0].column.push({ name: 'system', path: 'code.coding.first().system', type: 'uri' });
    await saveReport(agent, changed, { url: '/ips/reports/conditions' });
    const r = mod.reports.get('conditions');
    expect(r).toMatchObject({ generation: 2, build: { state: 'pending', live: true } });
    // the old table is still there to look at
    expect((await mod.reports.query(r, demo)).raw.columns).not.toContain('system');
    expect((await html(app, '/ips/demo/reports/conditions')).text).toContain('the previous table is shown meanwhile');
    await settle(mod);
    const out = await mod.reports.query(mod.reports.get('conditions'), demo);
    expect(out.raw.columns).toContain('system');
    expect(out.raw.rows[0][out.raw.columns.indexOf('system')]).toBe('http://snomed.info/sct');
  });

  test('how a report is presented: resources linked into the source, codings collapsed, the SQL behind a link', async () => {
    await submit(app, 'demo', doc('p1', ['38341003']));
    await settle(mod);
    const agent = await admin(app);
    const view = {
      resourceType: 'ViewDefinition', name: 'codings', status: 'active', resource: 'Bundle',
      select: [{
        forEach: 'entry.resource.ofType(Condition)',
        select: [
          { column: [{ name: 'resource_key', path: 'getResourceKey()', type: 'string' }] },
          { forEach: 'code.coding', column: [
            { name: 'concept_system', path: 'system', type: 'uri' },
            { name: 'concept_code', path: 'code', type: 'code' },
            { name: 'concept_display', path: 'display', type: 'string' }
          ] },
          { column: [
            { name: 'severity_system', path: 'severity.coding.first().system', type: 'uri' },
            { name: 'severity_code', path: 'severity.coding.first().code', type: 'code' }
          ] }
        ]
      }]
    };
    const stmt = 'SELECT concept_system, concept_code, count(*) AS n FROM codings GROUP BY concept_system, concept_code';
    expect((await saveReport(agent, view, { statements: [{ name: 'Frequency of systems', sql: stmt }] })).status).toBe(302);
    await settle(mod);
    const page = (await html(app, '/ips/demo/reports/codings')).text;
    // the statement: its name, its output, the SQL only behind "source"
    expect(page).toMatch(/<h3>Frequency of systems <details class="ips-sql"><summary>source<\/summary><pre class="ips-json">SELECT concept_system/);
    // the pair is one column, as the terminology view shows a coding
    expect(page).toContain('<th>concept</th>');
    expect(page).not.toContain('<th>concept_system</th>');
    expect(page).not.toContain('<th>concept_code</th>');
    expect(page).not.toContain('<th>concept_display</th>');
    expect(page).toMatch(/SNOMED CT[^<]*<\/a> <code><a [^>]*>38341003<\/a><\/code>/);
    // severity: no coding, an empty cell
    expect(page).toContain('<th>severity</th>');
    expect(page).toContain('<td class="ips-null"></td>');
    // the resource, linked into the document's source; no separate document column
    expect(page).toContain('<a href="/ips/demo/Bundle/1?view=source#Condition/p1-c0">#1 Condition/p1-c0</a>');
    expect(page).not.toContain('<th>document</th>');

    // and the source has the anchor, around the entry, without changing the JSON
    const source = (await html(app, '/ips/demo/Bundle/1?view=source')).text;
    expect(source).toContain('<span class="ips-entry" id="Condition/p1-c0">');
    const pre = /<pre class="ips-json">([\s\S]*?)<\/pre>/.exec(source)[1];
    const unescaped = pre.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    expect(unescaped).toBe(JSON.stringify(mod.store.read(1).bundle, null, 2));
  });

  test('a report over the validation outcomes', async () => {
    await submit(app, 'demo', doc('p1', ['111']));
    await settle(mod);
    const agent = await admin(app);
    expect((await saveReport(agent, ISSUES_VIEW, { source: 'outcomes' })).status).toBe(302);
    await settle(mod);
    const out = await mod.reports.query(mod.reports.get('issues'), demo);
    expect(out.raw.rows.map(r => r.slice(3))).toEqual([['warning', 'about 1']]);
  });

  test('what the administrator gets back when a report can\'t be saved', async () => {
    const agent = await admin(app);
    const refused = async (view, options, pattern) => {
      const res = await saveReport(agent, view, options);
      expect(res.status).toBe(400);
      expect(res.text).toMatch(pattern);
    };
    const untyped = structuredClone(CONDITIONS_VIEW);
    delete untyped.select[0].column[1].type;
    await refused(untyped, {}, /Every column needs a type: code has none/);
    await refused({ ...CONDITIONS_VIEW, name: undefined }, {}, /needs a name/);
    await refused({ ...CONDITIONS_VIEW, fhirVersion: ['5.0.0'] }, {}, /fhirVersion must include 4.0.1/);
    await refused(CONDITIONS_VIEW, { source: 'outcomes' }, /view of OperationOutcome, not Bundle/);
    await refused({ ...CONDITIONS_VIEW, resource: 'Condition' }, {}, /view of Bundle \(the document\), not Condition/);
    await refused(CONDITIONS_VIEW, { statements: [{ name: 'Bad', sql: 'DELETE FROM conditions' }] }, /Statement &#39;Bad&#39; doesn&#39;t read/);
    await refused(CONDITIONS_VIEW, { statements: [{ name: 'Bad', sql: 'SELECT nonsense FROM conditions' }] }, /no such column: nonsense/);
    mod.validator.issues = [{ severity: 'error', code: 'invalid', expression: ['ViewDefinition.select[0]'], details: { text: 'The validator says no' } }];
    await refused(CONDITIONS_VIEW, {}, /ViewDefinition.select\[0\]: The validator says no/);
    mod.validator.issues = [];
    mod.validator.isRunning = () => false;
    await refused(CONDITIONS_VIEW, {}, /validator is not running/);
    mod.validator.isRunning = () => true;
    expect((await saveReport(agent, CONDITIONS_VIEW)).status).toBe(302);
    // R4 is filled in
    expect(mod.reports.get('conditions').view.fhirVersion).toEqual(['4.0.1']);
    await refused(CONDITIONS_VIEW, {}, /already a report called &#39;conditions&#39;/);
    await refused({ ...CONDITIONS_VIEW, name: 'renamed' }, { url: '/ips/reports/conditions' }, /name can&#39;t be changed/);
    // only the administrator
    expect((await html(app, '/ips/reports/new')).status).toBe(302);
    expect((await html(app, '/ips/reports')).text).toContain('conditions');
  });

  test('a view that fails on a document is recorded against the report, not the document', async () => {
    const agent = await admin(app);
    const view = structuredClone(CONDITIONS_VIEW);
    view.select[0].column[1].path = 'code.coding.code';
    await saveReport(agent, view);
    await settle(mod);
    await submit(app, 'demo', doc('p1', ['111']));
    await submit(app, 'demo', doc('p2', ['111']));
    // two codings in one Condition: too many values for the column
    const two = doc('p3', ['111']);
    two.entry[2].resource.code.coding.push({ system: 'http://snomed.info/sct', code: '222' });
    await submit(app, 'demo', two);
    await settle(mod);
    expect(mod.store.read(3).status).toBe('processed');
    expect(mod.store.read(3).status_message).toMatch(/1 failed \(conditions\)/);
    expect(mod.reports.errors(mod.reports.get('conditions'), demo)).toEqual([{ doc_id: 3, message: expect.stringMatching(/not allowed multiple values/) }]);
    expect((await mod.reports.query(mod.reports.get('conditions'), demo)).raw.total).toBe(2);
    expect((await html(app, '/ips/demo/reports/conditions')).text).toContain('Documents the view failed on');
  });

  test('deleting a report drops its table', async () => {
    const agent = await admin(app);
    await saveReport(agent, CONDITIONS_VIEW);
    await settle(mod);
    expect(mod.reports.tableExists('conditions')).toBe(true);
    expect((await form(agent, '/ips/reports/conditions/delete')).status).toBe(302);
    expect(mod.reports.tableExists('conditions')).toBe(false);
    expect(mod.store.report('conditions')).toBeNull();
    expect((await html(app, '/ips/demo/reports/conditions')).status).toBe(404);
  });
});

describe('reports in a database file', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ips-reports-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('statements run in a child process on a read-only connection, and one that takes too long is killed', async () => {
    const { app, mod } = await makeApp({ database: path.join(dir, 'ips.db'), reports: { queryTimeoutSeconds: 1 } });
    try {
      const demo = mod.store.createProject('demo', 'Demo', null);
      await submit(app, 'demo', doc('p1', ['111', '222']));
      await settle(mod);
      expect(fs.existsSync(path.join(dir, 'ips-reports.db'))).toBe(true);
      const agent = await admin(app);
      await saveReport(agent, CONDITIONS_VIEW, { statements: [{ name: 'Count', sql: 'SELECT count(*) AS n FROM conditions' }] });
      await settle(mod);
      const out = await mod.reports.query(mod.reports.get('conditions'), demo);
      expect(out.statements[0].rows).toEqual([[2]]);
      // a statement that never ends
      const report = { ...mod.reports.get('conditions'), statements: [{ name: 'Forever', sql: 'WITH RECURSIVE x(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM x) SELECT count(*) FROM x' }] };
      const started = Date.now();
      await expect(mod.reports.query(report, demo)).rejects.toThrow(/took longer than 1 seconds/);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await mod.shutdown();
    }
  });
});
