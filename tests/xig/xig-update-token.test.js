// POST /xig/update re-downloads the xig database, so it needs the configured updateToken

const express = require('express');
const request = require('supertest');
const path = require('path');
const xig = require('../../xig/xig');
const htmlServer = require('../../library/html-server');

describe('POST /xig/update', () => {
  const app = express();
  app.use('/xig', xig.router);

  beforeAll(() => htmlServer.loadTemplate('xig', path.join(__dirname, '../../xig/xig-template.html')));
  afterAll(() => xig.setXigSettings({}));

  test('is disabled when no updateToken is configured', async () => {
    xig.setXigSettings({});
    const res = await request(app).post('/xig/update').set('x-update-token', 'anything');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/no updateToken is configured/);
  });

  test('refuses a request without the token, or with the wrong one', async () => {
    xig.setXigSettings({ updateToken: 'the-secret' });
    for (const headers of [{}, { 'x-update-token': 'wrong' }, { 'x-update-token': '' }]) {
      const res = await request(app).post('/xig/update').set(headers);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/missing or invalid x-update-token/);
    }
  });

  test('the form on /xig/stats gets a page back, and is refused the same way', async () => {
    xig.setXigSettings({});
    let res = await request(app).post('/xig/update').type('form').send({ token: 'anything' });
    expect(res.status).toBe(403);
    expect(res.type).toBe('text/html');
    expect(res.text).toMatch(/no updateToken is configured/);

    xig.setXigSettings({ updateToken: 'the-secret' });
    res = await request(app).post('/xig/update').type('form').send({ token: 'wrong' });
    expect(res.status).toBe(403);
    expect(res.type).toBe('text/html');
    expect(res.text).toMatch(/missing or invalid/);
  });
});
