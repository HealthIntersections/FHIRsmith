const express = require('express');
const request = require('supertest');

const TestingModule = require('../../testing/testing');
const { validateReport } = require('../../testing/testing');
const { parseSearch, dateRange, splitValues } = require('../../testing/search');
const htmlServer = require('../../library/html-server');

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
htmlServer.useLog(quietLog);

function makeStats() {
  return {
    counts: {},
    countRequest(name) { this.counts[name] = (this.counts[name] || 0) + 1; },
    addTask() {}, task() {}, taskDone() {}, taskError() {}
  };
}

function report(overrides = {}) {
  return {
    resourceType: 'TestReport',
    name: 'tx-ecosystem',
    status: 'completed',
    testScript: 'http://hl7.org/fhir/uv/tx-ecosystem/TestScript/tx-tests',
    result: 'pass',
    score: 100,
    tester: 'TxTester 1.0',
    issued: '2026-09-20T10:00:00Z',
    participant: [{ type: 'server', uri: 'http://tx.fhir.org/r4' }],
    ...overrides
  };
}

// mirrors the body parsers server.js puts in front of every module
async function makeApp(config = {}) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.raw({ type: 'application/fhir+json', limit: '50mb' }));
  app.use(express.raw({ type: 'application/fhir+xml', limit: '50mb' }));
  app.use(express.json({ limit: '50mb' }));
  const mod = new TestingModule(makeStats(), quietLog);
  await mod.initialize({ database: ':memory:', rateLimit: { max: 0 }, ...config });
  app.use('/testing', mod.router);
  return { app, mod };
}

function post(app, body, headers = {}) {
  let r = request(app).post('/testing/TestReport').set('Content-Type', 'application/fhir+json');
  for (const [k, v] of Object.entries(headers)) {
    r = r.set(k, v);
  }
  return r.send(typeof body === 'string' ? body : JSON.stringify(body));
}

describe('validateReport', () => {
  test('accepts a complete report', () => {
    expect(validateReport(report())).toEqual([]);
  });

  test('rejects things that are not TestReports', () => {
    expect(validateReport([])).toHaveLength(1);
    expect(validateReport({ resourceType: 'Patient' })[0]).toMatch(/TestReport, not Patient/);
  });

  test.each(['name', 'status', 'result', 'tester', 'issued'])('requires %s', (name) => {
    const r = report();
    delete r[name];
    expect(validateReport(r)).toEqual([`TestReport.${name} is required`]);
  });

  test('requires at least one participant, each with a uri', () => {
    expect(validateReport(report({ participant: [] }))).toEqual(['TestReport.participant is required (at least one)']);
    expect(validateReport(report({ participant: [{ type: 'server' }] }))).toEqual(['TestReport.participant[0].uri is required']);
  });

  test('checks issued and score', () => {
    expect(validateReport(report({ issued: 'yesterday' }))[0]).toMatch(/not a valid dateTime/);
    expect(validateReport(report({ score: '100' }))).toEqual(['TestReport.score must be a number']);
  });
});

describe('dateRange', () => {
  test('ranges follow precision', () => {
    expect(dateRange('2026')).toEqual({ lo: Date.UTC(2026, 0, 1), hi: Date.UTC(2027, 0, 1) });
    expect(dateRange('2026-02')).toEqual({ lo: Date.UTC(2026, 1, 1), hi: Date.UTC(2026, 2, 1) });
    expect(dateRange('2026-02-28')).toEqual({ lo: Date.UTC(2026, 1, 28), hi: Date.UTC(2026, 2, 1) });
    const t = Date.UTC(2026, 8, 20, 10, 0, 0);
    expect(dateRange('2026-09-20T10:00:00Z')).toEqual({ lo: t, hi: t + 1000 });
    expect(dateRange('2026-09-20T10:00Z')).toEqual({ lo: t, hi: t + 60000 });
    expect(dateRange('2026-09-20T20:00:00+10:00')).toEqual({ lo: t, hi: t + 1000 });
    expect(dateRange('2026-09-20T10:00:00.123Z')).toEqual({ lo: t + 123, hi: t + 124 });
  });

  test.each(['', 'x', '2026-13', '2026-02-30', '2026-09-20T25:00:00Z', 20260920])('rejects %p', (v) => {
    expect(dateRange(v)).toBeNull();
  });
});

describe('parseSearch', () => {
  test('ORs commas and ANDs repeats', () => {
    const s = parseSearch({ result: 'pass,fail', score: ['ge50', 'lt90'] });
    expect(s.errors).toEqual([]);
    expect(s.where).toHaveLength(3);
    expect(s.where[0]).toMatch(/ OR /);
  });

  test('reports unknown parameters and modifiers separately from bad values', () => {
    const s = parseSearch({ colour: 'red', 'name:below': 'x', issued: 'ge-yesterday', score: 'abc' });
    expect(s.unknown).toEqual(['colour', 'name:below']);
    expect(s.errors).toHaveLength(2);
  });

  test('ignores empty values', () => {
    const s = parseSearch({ name: '', status: '' });
    expect(s.where).toEqual([]);
    expect(s.used).toEqual([]);
  });

  test('sort, count and offset', () => {
    const s = parseSearch({ _sort: '-score,name', _count: '1000', _offset: '20' });
    expect(s.orderBy).toMatch(/^r\.score DESC, r\.name_lc ASC/);
    expect(s.count).toBe(500);
    expect(s.offset).toBe(20);
    expect(parseSearch({ _sort: 'colour' }).errors).toHaveLength(1);
    expect(parseSearch({ _count: '-1' }).errors).toHaveLength(1);
  });

  test('escaped commas', () => {
    expect(splitValues('a\\,b,c')).toEqual(['a,b', 'c']);
  });
});

describe('POST', () => {
  let app;
  let mod;
  beforeEach(async () => {
    ({ app, mod } = await makeApp());
  });
  afterEach(() => mod.shutdown());

  test('stores the report with a server id and lastUpdated', async () => {
    const before = Date.now();
    const res = await post(app, report({ id: 'mine', meta: { versionId: '3', tag: [{ code: 'x' }] } }));
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toMatch(/application\/fhir\+json/);
    expect(res.body.id).not.toBe('mine');
    expect(res.headers.location).toMatch(new RegExp(`/testing/TestReport/${res.body.id}$`));
    expect(res.body.meta.versionId).toBeUndefined();
    expect(res.body.meta.tag).toEqual([{ code: 'x' }]);
    expect(Date.parse(res.body.meta.lastUpdated)).toBeGreaterThanOrEqual(before - 1);

    const read = await request(app).get(`/testing/TestReport/${res.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(res.body);
  });

  test('also accepts application/json', async () => {
    const res = await request(app).post('/testing/TestReport').send(report());
    expect(res.status).toBe(201);
  });

  test('the same report twice is two reports', async () => {
    const a = await post(app, report());
    const b = await post(app, report());
    expect(a.body.id).not.toBe(b.body.id);
    expect(mod.store.count()).toBe(2);
  });

  test('rejects an invalid report with every problem', async () => {
    const res = await post(app, report({ name: undefined, participant: [] }));
    expect(res.status).toBe(400);
    expect(res.body.resourceType).toBe('OperationOutcome');
    expect(res.body.issue).toHaveLength(2);
  });

  test('rejects bad JSON, XML and oversize reports', async () => {
    expect((await post(app, '{"resourceType": ')).status).toBe(400);
    const xml = await request(app).post('/testing/TestReport').set('Content-Type', 'application/fhir+xml')
      .send('<TestReport xmlns="http://hl7.org/fhir"/>');
    expect(xml.status).toBe(415);
    const big = await post(app, report({ description: 'x'.repeat(600 * 1024) }));
    expect(big.status).toBe(413);
  });

  test('maxSize is configurable', async () => {
    const small = await makeApp({ maxSize: 1000 });
    expect((await post(small.app, report({ description: 'x'.repeat(1000) }))).status).toBe(413);
    expect((await post(small.app, report())).status).toBe(201);
    small.mod.shutdown();
  });

  test('honours Prefer: return', async () => {
    const minimal = await post(app, report(), { Prefer: 'return=minimal' });
    expect(minimal.status).toBe(201);
    expect(minimal.text).toBe('');
    expect(minimal.headers.location).toBeDefined();
    const oo = await post(app, report(), { Prefer: 'return=OperationOutcome' });
    expect(oo.body.resourceType).toBe('OperationOutcome');
  });

  test('never returns the submitter IP', async () => {
    const res = await post(app, report(), { 'X-Forwarded-For': '203.0.113.9' });
    const all = await request(app).get('/testing/TestReport');
    const html = await request(app).get('/testing');
    const page = await request(app).get(`/testing/TestReport/${res.body.id}`).set('Accept', 'text/html');
    for (const text of [res.text, all.text, html.text, page.text]) {
      expect(text).not.toContain('203.0.113.9');
    }
    expect(mod.store.db.prepare('SELECT ip FROM reports').get().ip).toBe('203.0.113.9');
  });
});

describe('tokens', () => {
  test('when a token is configured every POST needs it', async () => {
    const { app, mod } = await makeApp({ token: 'sekrit' });
    expect((await post(app, report())).status).toBe(401);
    expect((await post(app, report(), { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post(app, report(), { Authorization: 'Bearer sekrit' })).status).toBe(201);
    expect((await post(app, report(), { Authorization: 'sekrit' })).status).toBe(201);
    mod.shutdown();
  });

  test('the header is configurable', async () => {
    const { app, mod } = await makeApp({ token: 'sekrit', tokenHeader: 'X-Test-Token' });
    expect((await post(app, report(), { Authorization: 'Bearer sekrit' })).status).toBe(401);
    expect((await post(app, report(), { 'X-Test-Token': 'sekrit' })).status).toBe(201);
    mod.shutdown();
  });

  test('deleting needs the admin token', async () => {
    const { app, mod } = await makeApp({ adminToken: 'admin' });
    const id = (await post(app, report())).body.id;
    expect((await request(app).delete(`/testing/TestReport/${id}`)).status).toBe(403);
    expect((await request(app).delete(`/testing/TestReport/${id}`).set('Authorization', 'Bearer admin')).status).toBe(204);
    expect((await request(app).get(`/testing/TestReport/${id}`)).status).toBe(404);
    expect((await request(app).delete(`/testing/TestReport/${id}`).set('Authorization', 'Bearer admin')).status).toBe(404);
    mod.shutdown();
  });

  test('with no admin token nothing can be deleted', async () => {
    const { app, mod } = await makeApp();
    const id = (await post(app, report())).body.id;
    expect((await request(app).delete(`/testing/TestReport/${id}`).set('Authorization', 'Bearer ')).status).toBe(403);
    mod.shutdown();
  });

  test('rate limiting', async () => {
    const { app, mod } = await makeApp({ rateLimit: { max: 2, windowMinutes: 1 } });
    expect((await post(app, report())).status).toBe(201);
    expect((await post(app, report())).status).toBe(201);
    const third = await post(app, report());
    expect(third.status).toBe(429);
    expect(third.body.resourceType).toBe('OperationOutcome');
    mod.shutdown();
  });
});

describe('search', () => {
  let app;
  let mod;
  const ids = {};
  beforeAll(async () => {
    ({ app, mod } = await makeApp());
    const add = async (key, r) => {
      ids[key] = (await post(app, r)).body.id;
    };
    await add('a', report({ name: 'Alpha run', score: 100, issued: '2026-09-01T00:00:00Z' }));
    await add('b', report({ name: 'Beta run', result: 'fail', score: 42.5, tester: 'Other tool', issued: '2026-09-10T00:00:00Z',
      participant: [{ type: 'server', uri: 'http://example.org/fhir' }, { type: 'client', uri: 'urn:client' }] }));
    await add('c', report({ name: 'alphabet', status: 'in-progress', result: 'pending', score: undefined, issued: '2026-08-15',
      testScript: { reference: 'http://example.org/TestScript/r4-style' } }));
  });
  afterAll(() => mod.shutdown());

  const find = async (q) => {
    const res = await request(app).get('/testing/TestReport' + q);
    expect(res.status).toBe(200);
    return res.body;
  };
  const idsOf = (bundle) => (bundle.entry || []).filter(e => e.search.mode === 'match').map(e => e.resource.id).sort();
  const expectIds = async (q, keys) => {
    expect(idsOf(await find(q))).toEqual(keys.map(k => ids[k]).sort());
  };

  test('everything, newest first', async () => {
    const b = await find('');
    expect(b.resourceType).toBe('Bundle');
    expect(b.type).toBe('searchset');
    expect(b.total).toBe(3);
    expect(b.entry.map(e => e.resource.id)).toEqual([ids.c, ids.b, ids.a]);
    expect(b.entry[0].fullUrl).toMatch(new RegExp(`/testing/TestReport/${ids.c}$`));
  });

  test('strings', async () => {
    await expectIds('?name=alpha', ['a', 'c']);
    await expectIds('?name:exact=Alpha%20run', ['a']);
    await expectIds('?name:contains=RUN', ['a', 'b']);
    await expectIds('?tester=other', ['b']);
  });

  test('tokens', async () => {
    await expectIds('?result=fail,pending', ['b', 'c']);
    await expectIds('?result:not=pass', ['b', 'c']);
    await expectIds('?status=in-progress', ['c']);
  });

  test('uris', async () => {
    await expectIds('?testscript=http://example.org/TestScript/r4-style', ['c']);
    await expectIds('?testscript:below=http://hl7.org/', ['a', 'b']);
    await expectIds('?participant=urn:client', ['b']);
    await expectIds('?participant:below=http://tx.fhir.org', ['a', 'c']);
  });

  test('numbers', async () => {
    await expectIds('?score=100', ['a']);
    await expectIds('?score=lt50', ['b']);
    await expectIds('?score=42.5', ['b']);
    await expectIds('?score:missing=true', ['c']);
  });

  test('dates', async () => {
    await expectIds('?issued=2026-09', ['a', 'b']);
    await expectIds('?issued=ge2026-09-05', ['b']);
    await expectIds('?issued=lt2026-09-01', ['c']);
    await expectIds('?issued=2026-08-15', ['c']);
    await expectIds('?_lastUpdated=gt2020-01-01', ['a', 'b', 'c']);
    await expectIds('?_lastUpdated=lt2020-01-01', []);
  });

  test('sorting and paging', async () => {
    const b = await find('?_sort=-score&_count=2');
    // nulls sort first ascending, so last descending
    expect(b.entry.map(e => e.resource.id)).toEqual([ids.a, ids.b]);
    const rel = Object.fromEntries(b.link.map(l => [l.relation, l.url]));
    expect(rel.next).toMatch(/_offset=2/);
    expect(rel.next).toMatch(/_sort=-score/);
    expect(rel.previous).toBeUndefined();
    const page2 = await find(rel.next.substring(rel.next.indexOf('?')));
    expect(page2.entry.map(e => e.resource.id)).toEqual([ids.c]);
    expect(page2.link.find(l => l.relation === 'previous')).toBeDefined();
  });

  test('_summary=count', async () => {
    const b = await find('?_summary=count&result=pass');
    expect(b.total).toBe(1);
    expect(b.entry).toBeUndefined();
  });

  test('unknown parameters: lenient warns, strict fails', async () => {
    const b = await find('?colour=red');
    expect(b.total).toBe(3);
    expect(b.entry.find(e => e.search.mode === 'outcome')).toBeDefined();
    expect(b.link[0].url).not.toMatch(/colour/);
    const strict = await request(app).get('/testing/TestReport?colour=red').set('Prefer', 'handling=strict');
    expect(strict.status).toBe(400);
  });

  test('bad values fail', async () => {
    const res = await request(app).get('/testing/TestReport?issued=ge-yesterday');
    expect(res.status).toBe(400);
    expect(res.body.resourceType).toBe('OperationOutcome');
  });

  test('read of an unknown id', async () => {
    const res = await request(app).get('/testing/TestReport/nope');
    expect(res.status).toBe(404);
    expect(res.body.resourceType).toBe('OperationOutcome');
  });

  test('CapabilityStatement', async () => {
    const res = await request(app).get('/testing/metadata');
    expect(res.status).toBe(200);
    expect(res.body.resourceType).toBe('CapabilityStatement');
    const tr = res.body.rest[0].resource[0];
    expect(tr.type).toBe('TestReport');
    expect(tr.searchParam.map(p => p.name)).toEqual(expect.arrayContaining(['name', 'score', 'issued', 'participant', '_lastUpdated']));
    expect(tr.searchParam.every(p => p.definition === undefined)).toBe(true);
  });
});

describe('HTML', () => {
  let app;
  let mod;
  let id;
  let latest;
  beforeAll(async () => {
    ({ app, mod } = await makeApp());
    const r = report({
      name: '<script>alert(1)</script>',
      tester: '"><img src=x onerror=alert(2)>',
      testScript: 'javascript:alert(3)',
      text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml"><script>alert(4)</script></div>' },
      participant: [{ type: 'server', uri: 'http://tx.fhir.org/r4' }, { type: 'client', uri: 'javascript:alert(5)' }],
      setup: { action: [{ operation: { result: 'pass', message: 'set up <b>ok</b>' } }] },
      test: [{
        name: 'expand <b>',
        result: 'pass',
        period: { start: '2026-09-20T10:00:00Z', end: '2026-09-20T10:00:05Z' },
        action: [{ operation: { result: 'fail' } }]
      }, {
        name: 'validate-code',
        description: 'checks <i>codes</i>',
        action: [
          { assert: { result: 'pass', message: 'code valid' } },
          { assert: { result: 'fail', message: 'display wrong', detail: 'http://example.org/detail',
            requirement: [{ linkUri: 'http://example.org/req/1' }] } }
        ]
      }, 'not an object'],
      teardown: { action: [{ operation: { result: 'pass' } }] },
      extension: [{ url: 'http://example.org/ext', valueString: '<i>ext</i>' }]
    });
    id = (await post(app, r)).body.id;
    await post(app, report({ issued: '2026-01-01T00:00:00Z', result: 'fail' }));
    await post(app, report({ issued: '2026-02-01T00:00:00Z', result: 'pass', participant: [{ type: 'server', uri: 'http://other.org/fhir' }] }));
    latest = (await post(app, report({ issued: '2026-03-01T00:00:00Z', result: 'fail', score: 55 }))).body.id;
    await post(app, report({ issued: '2026-04-01T00:00:00Z', testScript: 'http://example.org/engine-script',
      participant: [{ type: 'server', uri: 'http://sut.example.org', version: '9.9.9' },
        { type: 'test-engine', uri: 'http://engine.example.org', version: '6.10.4' }] }));
  });
  afterAll(() => mod.shutdown());

  const noScript = (text) => {
    expect(text).not.toMatch(/<script>alert/);
    expect(text).not.toMatch(/<img src=x/);
    expect(text).not.toMatch(/href="javascript:/i);
  };

  test('the list', async () => {
    const res = await request(app).get('/testing');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.text).toContain(`href="/testing/TestReport/${id}"`);
    noScript(res.text);
  });

  test('participant versions are shown', async () => {
    const list = await request(app).get('/testing?participant=http://sut.example.org');
    expect(list.text).toContain('http://sut.example.org</a> <small>9.9.9</small>');
    expect(list.text).toContain('http://engine.example.org</a> <small>6.10.4</small>');
  });

  test('the list shows dates without times', async () => {
    const res = await request(app).get('/testing');
    expect(res.text).toContain('<td class="tr-date" title="2026-09-20T10:00:00Z">2026-09-20</td>');
    expect(res.text).not.toMatch(/>\d{4}-\d{2}-\d{2}T[^<]*<\/td>/);
  });

  test('the list filters, sorts and pages', async () => {
    const res = await request(app).get('/testing?result=fail&_count=1&issued-from=2025-12-01&_sort=-issued');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/1-1 of 2 reports/);
    expect(res.text).toMatch(/Next/);
  });

  test('a bad filter still shows a page', async () => {
    const res = await request(app).get('/testing?score-min=abc');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/alert-warning/);
  });

  test('browsers get HTML from the FHIR search', async () => {
    const res = await request(app).get('/testing/TestReport?result=pass').set('Accept', 'text/html');
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  test('the report', async () => {
    const res = await request(app).get(`/testing/TestReport/${id}`).set('Accept', 'text/html,application/xhtml+xml');
    expect(res.status).toBe(200);
    noScript(res.text);
    // one row per test: name, description, result, period. A single action with only a
    // result gets no table
    expect(res.text).toMatch(/<tr><td>expand &lt;b&gt;<\/td><td><div class="tr-msg"><\/div><\/td><td><span[^>]*>pass<\/span><\/td><td>2026-09-20T10:00:00Z &ndash; 2026-09-20T10:00:05Z<\/td><\/tr>/);
    // no test.result: the worst of its actions; two assertions, so they are listed under the description
    expect(res.text).toMatch(/<tr><td>validate-code<\/td><td><div class="tr-msg">checks &lt;i&gt;codes&lt;\/i&gt;<\/div><table [^>]*><tr><th>Type<\/th><th>Message<\/th><th>Details<\/th><th>Result<\/th><\/tr>/);
    expect(res.text).toMatch(/<tr><td>assertion<\/td><td class="tr-msg">code valid<\/td><td><\/td><td><span[^>]*>pass<\/span><\/td><\/tr>/);
    expect(res.text).toMatch(/<tr><td>assertion<\/td><td class="tr-msg">display wrong<\/td><td><a href="http:\/\/example\.org\/detail" rel="nofollow noopener">details<\/a><\/td><td><span[^>]*>fail<\/span><\/td><\/tr>/);
    // setup before the tests, teardown after
    const setupAt = res.text.indexOf('<h3>Setup</h3>');
    const testsAt = res.text.indexOf('<h3>Tests</h3>');
    const teardownAt = res.text.indexOf('<h3>Teardown</h3>');
    expect(setupAt).toBeGreaterThan(0);
    expect(setupAt).toBeLessThan(testsAt);
    expect(teardownAt).toBeGreaterThan(testsAt);
    expect(res.text).toContain('<td>operation</td><td class="tr-msg">set up &lt;b&gt;ok&lt;/b&gt;</td>');
    expect(res.text).toContain('Other Content');
    expect(res.text).toContain('Raw JSON');
    // the narrative is only ever shown as text
    expect(res.text).toContain('&lt;script&gt;alert(4)');
  });

  test('_format overrides Accept', async () => {
    const json = await request(app).get(`/testing/TestReport/${id}?_format=json`).set('Accept', 'text/html');
    expect(json.body.resourceType).toBe('TestReport');
    const html = await request(app).get(`/testing/TestReport/${id}?_format=html`);
    expect(html.headers['content-type']).toMatch(/text\/html/);
  });

  test('an unknown report', async () => {
    const res = await request(app).get('/testing/TestReport/nope').set('Accept', 'text/html');
    expect(res.status).toBe(404);
  });

  test('the summary shows the latest report per script and participant', async () => {
    const res = await request(app).get('/testing/summary');
    expect(res.status).toBe(200);
    noScript(res.text);
    // tx-tests against tx.fhir.org/r4 has two runs; March's is the latest
    expect(res.text).toMatch(new RegExp(`href="/testing/TestReport/${latest}" title="tx-ecosystem - 2026-03-01"><span[^>]*>fail</span></a><br/>55<br/><a [^>]*>2 runs</a>`));
    // the report with a different test script gets its own row
    expect(res.text).toContain(`href="/testing/TestReport/${id}"`);
    expect(res.text).toContain('http://other.org/fhir');
    // the system under test is a column; the test engine isn't
    expect(res.text).toContain('http://sut.example.org');
    expect(res.text).not.toContain('http://engine.example.org');
    // reports by tester: the XSS tester sent 1 (escaped), TxTester 1.0 the other 4 (2 pass, 2 fail)
    expect(res.text).toContain('Reports by Tester');
    expect(res.text).toMatch(/tester%3Aexact=TxTester\+1\.0[^"]*">TxTester 1\.0<\/a><\/td><td>4<\/td><td>2<\/td><td>2<\/td><td>0<\/td>/);
    expect(res.text).toContain('&quot;&gt;&lt;img src=x onerror=alert(2)&gt;</a></td><td>1</td>');
    const byTester = await request(app).get('/testing/summary?by=tester');
    expect(byTester.status).toBe(200);
    noScript(byTester.text);
  });
});

describe('run length', () => {
  const { runLengthOf } = require('../../testing/store');
  const { runLength } = require('../../testing/render');

  test('spans the earliest start to the latest end', () => {
    expect(runLengthOf(report({ test: [
      { period: { start: '2026-09-20T10:00:05Z', end: '2026-09-20T10:00:10Z' } },
      { period: { start: '2026-09-20T10:00:00Z', end: '2026-09-20T10:00:07Z' } },
      { name: 'no period' }
    ] }))).toBe(10000);
    expect(runLengthOf(report())).toBeNull();
    expect(runLengthOf(report({ test: [{ period: { start: '2026-09-20T10:00:00Z' } }] }))).toBeNull();
  });

  test.each([[850, '850 ms'], [12345, '12.3 s'], [245000, '4m 05s'], [3720000, '1h 02m'], [null, '']])('%p is %p', (ms, s) => {
    expect(runLength(ms)).toBe(s);
  });

  test('is filled in for reports stored before the column existed', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const Database = require('better-sqlite3');
    const { TestReportStore } = require('../../testing/store');
    const file = path.join(os.tmpdir(), `testing-migrate-${process.pid}.db`);
    fs.rmSync(file, { force: true });
    const store = new TestReportStore(file);
    const r = report({ id: 'old', meta: { lastUpdated: '2026-09-20T00:00:00Z' },
      test: [{ period: { start: '2026-09-20T10:00:00Z', end: '2026-09-20T10:01:00Z' } }] });
    store.insert(r, { receivedMs: Date.now() });
    store.close();
    // make it look like an old database
    const db = new Database(file);
    db.exec('ALTER TABLE reports DROP COLUMN run_ms');
    db.exec('ALTER TABLE reports DROP COLUMN test_count');
    db.close();
    const again = new TestReportStore(file);
    expect(again.db.prepare('SELECT run_ms FROM reports WHERE id = ?').get('old').run_ms).toBe(60000);
    expect(again.db.prepare('SELECT test_count FROM reports WHERE id = ?').get('old').test_count).toBe(1);
    again.close();
    fs.rmSync(file, { force: true });
  });
});

describe('the list columns', () => {
  test('no status, run length after issued, participants split by type, client only when there is one', async () => {
    const { app, mod } = await makeApp();
    await post(app, report({
      participant: [{ type: 'server', uri: 'http://sut.example.org', version: '1.0' },
        { type: 'test-engine', uri: 'http://engine.example.org', version: '6.10.4' }],
      test: [{ name: 't', period: { start: '2026-09-20T10:00:00Z', end: '2026-09-20T10:04:05Z' } }]
    }));
    let res = await request(app).get('/testing');
    const headings = [...res.text.matchAll(/<th>(?:<a [^>]*>)?([^<]+)/g)].map(m => m[1]);
    expect(headings).toEqual(['Name', 'Result', 'Score', 'Tests', 'Tester', 'Test Script', 'Test Engine', 'Server', 'Issued', 'Run Length', 'Received']);
    expect(res.text).not.toContain('Status: any');
    expect(res.text).toMatch(/<td><a class="tr-uri" href="http:\/\/engine\.example\.org"[^>]*>[^<]*<\/a> <small>6\.10\.4<\/small><\/td><td><a class="tr-uri" href="http:\/\/sut\.example\.org"/);
    expect(res.text).toContain('<td class="tr-date">4m 05s</td>');
    expect(res.text).toMatch(/<td>100<\/td><td>1<\/td><td>TxTester 1\.0<\/td>/);

    await post(app, report({ participant: [{ type: 'client', uri: 'http://client.example.org' }, { type: 'server', uri: 'http://sut.example.org' }] }));
    res = await request(app).get('/testing');
    expect(res.text).toContain('>Client</th>');
    mod.shutdown();
  });
});

describe('logins, users, named links', () => {
  let app;
  let mod;
  let reportId;
  beforeEach(async () => {
    ({ app, mod } = await makeApp({ adminPassword: 'admin-secret', cookieSecure: false, sessionSecret: 'x'.repeat(32) }));
    reportId = (await post(app, report({ testScript: 'http://example.org/TestScript/tx|1.9.5',
      participant: [{ type: 'server', uri: 'http://sut.example.org', version: '2.0' }] }))).body.id;
  });
  afterEach(() => mod.shutdown());

  // every form carries the session's CSRF token; get one the way a browser would, from a page
  const csrfOf = async (agent) => {
    const page = await agent.get('/testing/login');
    return page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  };
  const form = async (agent, url, data = {}, headers = {}) => {
    const _csrf = await csrfOf(agent);
    return agent.post(url).type('form').set(headers).send({ ...data, _csrf });
  };
  const loginAs = async (login, password, target = app) => {
    const agent = request.agent(target);
    const res = await form(agent, '/testing/login', { login, password });
    return { agent, res };
  };

  test('the administrator logs in with the configured password', async () => {
    expect((await loginAs('admin', 'wrong')).res.status).toBe(401);
    const { agent, res } = await loginAs('admin', 'admin-secret');
    expect(res.status).toBe(302);
    const page = await agent.get('/testing');
    expect(page.text).toContain('Logged in as <b>Administrator</b>');
    expect(page.text).toContain('/testing/admin/users');
    await form(agent, '/testing/logout');
    expect((await agent.get('/testing/admin/links')).status).toBe(302);
  });

  test('with no adminPassword nobody is the administrator', async () => {
    const other = await makeApp({ cookieSecure: false });
    const { res } = await loginAs('admin', '', other.app);
    expect(res.status).toBe(401);
    other.mod.shutdown();
  });

  test('named links replace canonical URLs with names', async () => {
    const { agent } = await loginAs('admin', 'admin-secret');
    expect((await form(agent, '/testing/admin/links', { canonical: 'http://example.org/TestScript/tx|ignored', name: 'Tx Tests', link: 'https://example.org/tx' })).status).toBe(302);
    await form(agent, '/testing/admin/links', { canonical: 'http://sut.example.org', name: 'The <SUT>', link: '' });
    expect((await form(agent, '/testing/admin/links', { canonical: 'http://x.org', name: 'X', link: 'javascript:alert(1)' })).status).toBe(400);

    const list = await request(app).get('/testing');
    expect(list.text).toContain('<a href="https://example.org/tx" title="http://example.org/TestScript/tx|1.9.5" rel="nofollow noopener">Tx Tests</a> <small>1.9.5</small>');
    expect(list.text).toContain('<span title="http://sut.example.org">The &lt;SUT&gt;</span> <small>2.0</small>');
    const summary = await request(app).get('/testing/summary');
    expect(summary.text).toContain('>Tx Tests</a>');
    const page = await request(app).get(`/testing/TestReport/${reportId}`).set('Accept', 'text/html');
    expect(page.text).toContain('>Tx Tests</a>');

    const links = await agent.get('/testing/admin/links');
    const id = links.text.match(/action="\/testing\/admin\/links\/(\d+)\/delete"/)[1];
    await form(agent, `/testing/admin/links/${id}/delete`);
    expect((await agent.get('/testing/admin/links')).text.match(/\/delete"/g)).toHaveLength(1);
  });

  test('users get exactly the rights they are given', async () => {
    const admin = (await loginAs('admin', 'admin-secret')).agent;
    expect((await form(admin, '/testing/admin/users', { login: 'linker', name: 'Link Editor', password: 'password1', editLinks: '1' })).status).toBe(302);
    expect((await form(admin, '/testing/admin/users', { login: 'short', name: 'Short', password: 'x' })).status).toBe(400);
    expect((await form(admin, '/testing/admin/users', { login: 'admin', name: 'Impostor', password: 'password1' })).status).toBe(400);
    const users = await admin.get('/testing/admin/users');
    expect(users.text).toContain('linker');
    expect(users.text).not.toContain('password_hash');

    const { agent: linker, res } = await loginAs('linker', 'password1');
    expect(res.status).toBe(302);
    expect((await linker.get('/testing/admin/links')).status).toBe(200);
    expect((await linker.get('/testing/admin/users')).status).toBe(403);
    expect((await form(linker, `/testing/TestReport/${reportId}/delete`)).status).toBe(403);
    expect((await linker.get(`/testing/TestReport/${reportId}`).set('Accept', 'text/html')).text).not.toContain('Delete this report');

    // give them the right to delete; it applies at once, without logging in again
    const id = users.text.match(/action="\/testing\/admin\/users\/(\d+)"/)[1];
    await form(admin, `/testing/admin/users/${id}`, { name: 'Link Editor', editLinks: '1', deleteReports: '1', password: '' });
    expect((await linker.get(`/testing/TestReport/${reportId}`).set('Accept', 'text/html')).text).toContain('Delete this report');
    expect((await form(linker, `/testing/TestReport/${reportId}/delete`)).status).toBe(302);
    expect((await request(app).get(`/testing/TestReport/${reportId}`)).status).toBe(404);

    // the password was left blank, so it still works; deleting the user ends their session
    expect((await loginAs('linker', 'password1')).res.status).toBe(302);
    await form(admin, `/testing/admin/users/${id}/delete`);
    expect((await linker.get('/testing/admin/links')).status).toBe(302);
    expect((await loginAs('linker', 'password1')).res.status).toBe(401);
  });

  test('form posts from another site are refused', async () => {
    const { agent } = await loginAs('admin', 'admin-secret');
    const res = await form(agent, '/testing/admin/links', { canonical: 'http://x.org', name: 'X' }, { Origin: 'https://evil.example.com' });
    expect(res.status).toBe(403);
  });

  test('form posts need the session\'s CSRF token', async () => {
    const { agent } = await loginAs('admin', 'admin-secret');
    // none
    expect((await agent.post('/testing/admin/links').type('form').send({ canonical: 'http://x.org', name: 'X' })).status).toBe(403);
    // someone else's
    const other = request.agent(app);
    const stolen = await csrfOf(other);
    expect((await agent.post('/testing/admin/links').type('form').send({ canonical: 'http://x.org', name: 'X', _csrf: stolen })).status).toBe(403);
    // a login needs one too
    expect((await request(app).post('/testing/login').type('form').send({ login: 'admin', password: 'admin-secret' })).status).toBe(403);
    // the page's own works
    expect((await form(agent, '/testing/admin/links', { canonical: 'http://x.org', name: 'X' })).status).toBe(302);
  });

  test('the FHIR API needs no CSRF token and sets no cookie', async () => {
    const res = await post(app, report());
    expect(res.status).toBe(201);
    expect(res.headers['set-cookie']).toBeUndefined();
    const list = await request(app).get('/testing');
    expect(list.headers['set-cookie']).toBeUndefined();
  });
});
