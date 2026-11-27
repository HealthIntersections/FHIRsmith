// A XIG list filter value the XIG doesn't have (npm.fhir.org, 2026-11: a crawler asked for
// rt=Iemunization, Immunizatign, ... and every misspelling was counted and queried from scratch)
// is answered at once, without asking the database.

const path = require('path');
const express = require('express');
const request = require('supertest');
const xig = require('../../xig/xig');
const htmlServer = require('../../library/html-server');

const { illegalFilter } = xig;

const maps = () => ({
  realms: new Set(['uv', 'us', 'nz']),
  authorities: new Set(['hl7', 'ihe', 'who']),
  resourceTypes: new Set(['CodeSystem', 'ValueSet', 'Immunization']),
  profileResources: new Set(['Patient', 'Immunization']),
  profileTypes: new Set(['HumanName']),
  extensionContexts: new Set(['Element']),
  txSources: new Map([['sct', 'SNOMED CT']])
});

describe('illegalFilter', () => {
  afterEach(() => xig.setConfigCacheForTests(null));

  test('values the XIG has are fine, as are no values', () => {
    xig.setConfigCacheForTests(maps());
    expect(illegalFilter({})).toBeNull();
    expect(illegalFilter({ ver: 'R4', type: 'rp', realm: 'nz', auth: 'who', rt: 'Immunization' })).toBeNull();
    expect(illegalFilter({ type: 'vs', rt: 'sct' })).toBeNull();
    // a value from another type's set: a link made for one type keeps its rt when the type changes
    expect(illegalFilter({ type: 'cs', rt: 'HumanName' })).toBeNull();
    // searched, not looked up
    expect(illegalFilter({ text: 'Iemunization', pkg: 'nothing.like.this' })).toBeNull();
  });

  test('a value it doesn\'t have is named', () => {
    xig.setConfigCacheForTests(maps());
    expect(illegalFilter({ rt: 'Iemunization' })).toEqual({ name: 'rt', value: 'Iemunization' });
    expect(illegalFilter({ type: 'rp', rt: 'Immunizatign' })).toEqual({ name: 'rt', value: 'Immunizatign' });
    expect(illegalFilter({ realm: 'xx' })).toEqual({ name: 'realm', value: 'xx' });
    expect(illegalFilter({ auth: 'nobody' })).toEqual({ name: 'auth', value: 'nobody' });
    expect(illegalFilter({ ver: 'R2C' })).toEqual({ name: 'ver', value: 'R2C' });
    expect(illegalFilter({ type: 'zz' })).toEqual({ name: 'type', value: 'zz' });
  });

  test('nothing is refused before the values are loaded, or against a set the database doesn\'t have', () => {
    expect(illegalFilter({ rt: 'Iemunization', realm: 'xx' })).toBeNull();
    const m = maps();
    delete m.realms;
    xig.setConfigCacheForTests(m);
    expect(illegalFilter({ realm: 'xx' })).toBeNull();
  });
});

describe('the list with a filter value the XIG doesn\'t have', () => {
  let queries;
  let app;

  beforeAll(() => {
    htmlServer.loadTemplate('xig', path.join(__dirname, '../../xig/xig-template.html'));
    xig.setXigSettings({});
    xig.setStatsForTests({ countRequest: () => {} });
    app = express();
    app.use('/xig', xig.router);
  });

  beforeEach(() => {
    queries = [];
    const record = (rows) => (sql, params, callback) => {
      queries.push(sql);
      (typeof params === 'function' ? params : callback)(null, rows(sql));
    };
    xig.setDatabaseForTests({
      get: record(sql => (/COUNT\(/.test(sql) ? { total: 0, count: 0 } : undefined)),
      all: record(() => [])
    });
    xig.setConfigCacheForTests(maps());
  });

  afterAll(() => {
    xig.setDatabaseForTests(null);
    xig.setConfigCacheForTests(null);
    xig.setStatsForTests(undefined);
  });

  test('is a 404 that names it, and the database isn\'t asked', async () => {
    const res = await request(app).get('/xig?auth=who&offset=10600&realm=nz&rt=Iemunization');
    expect(res.status).toBe(404);
    expect(res.text).toContain('The XIG has no resource type &#39;Iemunization&#39; (rt)');
    const json = await request(app).get('/xig?realm=xx&_fmt=json');
    expect(json.status).toBe(404);
    expect(JSON.parse(json.text)).toEqual({ error: 'The XIG has no realm \'xx\' (realm)' });
    expect(queries).toEqual([]);
  });

  test('a value it has still gets its list', async () => {
    const res = await request(app).get('/xig?realm=nz&rt=Immunization');
    expect(res.status).toBe(200);
    expect(queries.length).toBeGreaterThan(0);
  });
});
