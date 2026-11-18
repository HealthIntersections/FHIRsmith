const express = require('express');
const request = require('supertest');
const { isSameOrigin, requireSameOrigin } = require('../../library/same-origin');

function app() {
  const a = express();
  a.use(requireSameOrigin());
  a.post('/x', (req, res) => res.send('ok'));
  a.get('/x', (req, res) => res.send('ok'));
  return a;
}

describe('same-origin check', () => {
  test('lets through posts from our own pages, and posts with no Origin', async () => {
    expect((await request(app()).post('/x')).status).toBe(200);
    expect((await request(app()).post('/x').set('Host', 'tx.example.org').set('Origin', 'https://tx.example.org')).status).toBe(200);
  });

  test.each([
    ['another site', 'https://evil.example.com'],
    ['a sandboxed page', 'null'],
    ['garbage', 'not a url']
  ])('refuses a post from %s', async (_label, origin) => {
    const res = await request(app()).post('/x').set('Origin', origin);
    expect(res.status).toBe(403);
  });

  test('never blocks GETs', async () => {
    expect((await request(app()).get('/x').set('Origin', 'https://evil.example.com')).status).toBe(200);
  });

  test('accepts the host a proxy reports', () => {
    const req = { method: 'POST', get: (h) => ({ origin: 'https://tx.fhir.org', host: 'localhost:3000', 'x-forwarded-host': 'tx.fhir.org' })[h.toLowerCase()] };
    expect(isSameOrigin(req)).toBe(true);
  });
});
