const express = require('express');
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { countStaticResponses } = require('../../library/static-response-stats');

test('counts served files and overrides without also counting later API responses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhirsmith-static-count-'));
  try {
    fs.writeFileSync(path.join(dir, 'asset.txt'), 'asset');
    const files = express.Router();
    files.get('/override', (_req, res) => res.sendFile('asset.txt', { root:dir }));
    files.use(express.static(dir));
    const app = express();
    const onHit = jest.fn();
    app.use(countStaticResponses(files, onHit));
    app.get('/api', (_req, res) => res.json({ ok:true }));
    app.get('/api-error', (_req, res) => res.sendStatus(422));
    await request(app).get('/asset.txt').expect(200);
    await request(app).head('/asset.txt').expect(200);
    await request(app).get('/override').expect(200);
    expect(onHit).toHaveBeenCalledTimes(3);
    await request(app).get('/api').expect(200);
    await request(app).get('/api').expect(200);
    await request(app).get('/api-error').expect(422);
    await request(app).get('/missing').expect(404);
    expect(onHit).toHaveBeenCalledTimes(3);
  } finally {
    fs.rmSync(dir, { recursive:true, force:true });
  }
});

test('removes static counting when the middleware forwards an error', async () => {
  const onHit = jest.fn();
  const app = express();
  app.use(countStaticResponses((_req, _res, next) => next(new Error('file failed')), onHit));
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(200).json({ fallback:true });
  });
  await request(app).get('/file').expect(200);
  expect(onHit).not.toHaveBeenCalled();
});
