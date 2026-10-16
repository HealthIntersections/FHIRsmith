// Reports can be submitted by anyone when no token is configured, so what is in them must
// not be able to put script in the pages that show them

const express = require('express');
const request = require('supertest');
const parse5 = require('parse5');
const TestingModule = require('../../testing/testing');
const htmlServer = require('../../library/html-server');

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
htmlServer.useLog(quietLog);

const EVIL = '</script><script>alert(document.domain)</script>';
const EVIL_ATTR = '"><img src=x onerror=alert(document.domain)>';
const EVIL_URL = 'javascript:alert(document.domain)';
const BAD = EVIL + EVIL_ATTR;

// script elements, event handlers and script URLs that the injected content would add
function injected(html) {
  const found = [];
  (function walk(n) {
    if (n.tagName === 'script' && (n.childNodes || []).map(c => c.value).join('').trim() === 'alert(document.domain)') {
      found.push('script');
    }
    for (const a of n.attrs || []) {
      if (/^on/i.test(a.name)) {
        found.push(`${n.tagName} ${a.name}`);
      }
      if (['href', 'src', 'action', 'formaction'].includes(a.name) && /^\s*javascript:/i.test(a.value)) {
        found.push(`${n.tagName} ${a.name}=${a.value}`);
      }
    }
    (n.childNodes || []).forEach(walk);
    if (n.content) {
      walk(n.content);
    }
  })(parse5.parse(html));
  return found;
}

const action = (kind) => ({ [kind]: { message: BAD, detail: EVIL_URL, result: BAD } });

const REPORT = {
  resourceType: 'TestReport',
  id: BAD,
  name: 'evil' + BAD,
  status: 'completed',
  testScript: EVIL_URL,
  result: 'pass' + BAD,
  score: 50,
  tester: 'tester' + BAD,
  issued: '2026-09-20T10:00:00Z',
  identifier: { system: EVIL_URL, value: BAD },
  participant: [{ type: 'server' + BAD, uri: EVIL_URL, display: BAD }, { type: 'client', uri: 'http://x/' + EVIL_ATTR }],
  extension: [{ url: EVIL_URL, valueString: BAD }],
  setup: { action: [action('operation'), action('assert')] },
  test: [{ name: BAD, description: BAD, action: [action('operation'), action('assert')] }],
  teardown: { action: [{ action: { operation: { message: BAD, detail: EVIL_URL, result: BAD } } }] }
};

describe('testing module: submitted content', () => {
  let app, id;

  beforeAll(async () => {
    app = express();
    app.use(express.raw({ type: 'application/fhir+json', limit: '50mb' }));
    app.use(express.json({ limit: '50mb' }));
    const mod = new TestingModule({ countRequest() {}, addTask() {}, task() {}, taskDone() {}, taskError() {} }, quietLog);
    await mod.initialize({ database: ':memory:', rateLimit: { max: 0 } });
    app.use('/testing', mod.router);
    const res = await request(app).post('/testing/TestReport').set('Content-Type', 'application/fhir+json').send(JSON.stringify(REPORT));
    expect(res.status).toBe(201);
    id = res.body.id;
  });

  const pages = () => [
    '/testing',
    '/testing/summary',
    '/testing/summary?by=participant',
    `/testing/TestReport/${id}`,
    '/testing/TestReport?name:contains=evil',
    '/testing/TestReport?name=' + encodeURIComponent(BAD) + '&tester=' + encodeURIComponent(EVIL_ATTR) + '&_sort=' + encodeURIComponent(BAD),
    '/testing/TestReport?participant:below=' + encodeURIComponent(EVIL_URL),
    '/testing/TestReport/' + encodeURIComponent(BAD),
    '/testing/metadata'
  ];

  test('no page that shows it carries injected script', async () => {
    for (const url of pages()) {
      const res = await request(app).get(url).set('Accept', 'text/html');
      expect(res.status).toBeLessThan(500);
      expect({ url, found: injected(res.text) }).toEqual({ url, found: [] });
    }
  });
});
