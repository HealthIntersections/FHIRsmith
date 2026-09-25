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
    // one row per test: name, description, result, period
    expect(res.text).toMatch(/<tr><td>expand &lt;b&gt;<\/td><td class="tr-msg"><\/td><td><span[^>]*>pass<\/span><\/td><td>2026-09-20T10:00:00Z &ndash; 2026-09-20T10:00:05Z<\/td><\/tr>/);
    // no test.result: the worst of its actions
    expect(res.text).toMatch(/<tr><td>validate-code<\/td><td class="tr-msg">checks &lt;i&gt;codes&lt;\/i&gt;<\/td><td><span[^>]*>fail<\/span><\/td><td><\/td><\/tr>/);
    // actions aren't shown, except in the raw JSON
    expect(res.text).not.toContain('Setup</h3>');
    expect(res.text).not.toContain('href="http://example.org/detail"');
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
