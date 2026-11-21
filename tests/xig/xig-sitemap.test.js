// /xig/sitemap.xml: an index of gzipped sitemap files naming every resource page, so crawlers can
// find them without paging through the lists (which robots.txt keeps them out of)

const sqlite3 = require('sqlite3');
const zlib = require('zlib');
const express = require('express');
const request = require('supertest');
const xig = require('../../xig/xig');

describe('XIG sitemap', () => {
  let db;
  let app;
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, e => e ? rej(e) : res()));
  const gunzip = (res, cb) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => cb(null, zlib.gunzipSync(Buffer.concat(chunks)).toString('utf8')));
  };

  beforeAll(async () => {
    db = new sqlite3.Database(':memory:');
    await run('CREATE TABLE Resources (ResourceKey INTEGER PRIMARY KEY, ResourceType TEXT, Id TEXT, PackageKey INTEGER)');
    await run('CREATE TABLE Packages (PackageKey INTEGER, PID TEXT)');
    await run("INSERT INTO Packages VALUES (1, 'test.pkg#1.0.0'), (2, 'other.pkg#2.0.0')");
    // keys with gaps, so the files split by place, not by key
    for (let i = 0; i < 25; i++) {
      await run('INSERT INTO Resources VALUES (?, ?, ?, ?)', [i * 3 + 1, 'ValueSet', `vs-${i}`, 1 + (i % 2)]);
    }
    // a resource whose package isn't known: left out
    await run("INSERT INTO Resources VALUES (1000, 'CodeSystem', 'lost', 99)");
    xig.setDatabaseForTests(db);
    xig.setXigSettings({});
    xig.setSitemapSizeForTests(10);
    app = express();
    app.set('trust proxy', true);
    app.use('/xig', xig.router);
  });

  afterAll(async () => {
    xig.setSitemapSizeForTests(xig.SITEMAP_SIZE);
    xig.setDatabaseForTests(null);
    await new Promise(r => db.close(r));
  });

  test('the index names one file per SITEMAP_SIZE resources', async () => {
    const res = await request(app).get('/xig/sitemap.xml').set('Host', 'npm.example.org').set('X-Forwarded-Proto', 'https');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/xml/);
    const locs = [...res.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    expect(locs).toEqual([1, 2, 3].map(n => `https://npm.example.org/xig/sitemap-${n}.xml.gz`));
  });

  test('every resource page is in exactly one file, as the lists link to it', async () => {
    const all = [];
    for (const n of [1, 2, 3]) {
      const res = await request(app).get(`/xig/sitemap-${n}.xml.gz`).set('Host', 'npm.example.org').set('X-Forwarded-Proto', 'https')
        .buffer(true).parse(gunzip);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/gzip');
      all.push(...[...res.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]));
    }
    expect(all.length).toBe(25);
    expect(new Set(all).size).toBe(25);
    expect(all[0]).toBe('https://npm.example.org/xig/resource/test.pkg%7C1.0.0/ValueSet/vs-0');
    expect(all).toContain('https://npm.example.org/xig/resource/other.pkg%7C2.0.0/ValueSet/vs-1');
    expect(all.join(' ')).not.toContain('lost');
  });

  test('a file past the end is a 404', async () => {
    expect((await request(app).get('/xig/sitemap-4.xml.gz')).status).toBe(404);
    expect((await request(app).get('/xig/sitemap-0.xml.gz')).status).toBe(404);
  });

  test('xig.baseUrl, when set, is the address in the URLs', async () => {
    xig.setXigSettings({ baseUrl: 'https://npm.fhir.org/' });
    try {
      const res = await request(app).get('/xig/sitemap.xml').set('Host', 'localhost:3001');
      expect(res.text).toContain('<loc>https://npm.fhir.org/xig/sitemap-1.xml.gz</loc>');
    } finally {
      xig.setXigSettings({});
    }
  });
});
