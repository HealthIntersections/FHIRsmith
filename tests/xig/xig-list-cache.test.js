// The XIG lists under a crawler (npm.fhir.org, 2026-11): what doesn't change from page to page of
// a list is kept (listCache), links that change the filter go to the first page, the selects are
// built once, and a list stops once its client has gone.

const http = require('http');
const path = require('path');
const express = require('express');
const request = require('supertest');
const xig = require('../../xig/xig');
const htmlServer = require('../../library/html-server');

const { ListCache, filterKey, clientGone, makeSelect, buildBaseUrl, buildVersionLinkUrl,
  buildAuthorityLinkUrl, buildRealmLinkUrl } = xig;

describe('ListCache', () => {
  let max;
  let cache;
  beforeEach(() => {
    max = 1000;
    cache = new ListCache(() => max);
  });

  test('builds a value once; requests at the same time share it', async () => {
    let builds = 0;
    const build = () => new Promise(r => setTimeout(() => r(++builds), 10));
    const [a, b] = await Promise.all([cache.get('k', build, () => 8), cache.get('k', build, () => 8)]);
    expect([a, b]).toEqual([1, 1]);
    expect(await cache.get('k', build, () => 8)).toBe(1);
    expect(builds).toBe(1);
  });

  test('a failure is not kept', async () => {
    let calls = 0;
    const build = () => {
      calls++;
      if (calls === 1) {
        throw new Error('database busy');
      }
      return 'ok';
    };
    await expect(cache.get('k', build, () => 8)).rejects.toThrow('database busy');
    expect(await cache.get('k', build, () => 8)).toBe('ok');
    expect(calls).toBe(2);
  });

  test('the least recently used go first once the size is passed', async () => {
    const size = () => 300;
    await cache.get('a', () => 'A', size);
    await cache.get('b', () => 'B', size);
    await cache.get('c', () => 'C', size);
    await cache.get('a', () => 'A2', size); // a is used: b is now the oldest
    await cache.get('d', () => 'D', size);
    expect(cache.bytes).toBeLessThanOrEqual(max);
    expect([...cache.entries.keys()]).toEqual(['c', 'a', 'd']);
    expect(await cache.get('a', () => 'again', size)).toBe('A');
    expect(await cache.get('b', () => 'B2', size)).toBe('B2');
  });

  test('emptied when the database changes', async () => {
    const db = {};
    xig.setDatabaseForTests(db);
    try {
      await cache.get('k', () => 'one', () => 8);
      xig.setDatabaseForTests({});
      expect(await cache.get('k', () => 'two', () => 8)).toBe('two');
    } finally {
      xig.setDatabaseForTests(null);
    }
  });
});

describe('XIG list filters and links', () => {
  const params = { ver: 'R4', auth: '', realm: 'us', type: 'cs', rt: '', text: '', pkg: '', onlyUsed: '', offset: '400' };

  test('a filter key leaves out the page', () => {
    expect(filterKey(params)).toBe(filterKey({ ...params, offset: '0' }));
    expect(filterKey(params)).not.toBe(filterKey({ ...params, realm: 'uv' }));
  });

  test('links that change the filter go to its first page', () => {
    for (const url of [buildBaseUrl('/xig', params, 'ver'), buildVersionLinkUrl('/xig', params, 'R5'),
      buildAuthorityLinkUrl('/xig', params, 'hl7'), buildRealmLinkUrl('/xig', params, 'uv')]) {
      expect(url).not.toContain('offset');
    }
    expect(buildBaseUrl('/xig', params, 'ver')).toBe('/xig?realm=us&type=cs');
  });

  test('a select is built once for its options and value, and shows the value chosen', () => {
    const options = ['CodeSystem', 'ValueSet=Value Sets', '<odd>'];
    const html = makeSelect('ValueSet', options, 'rt');
    expect(html).toContain('<option value="ValueSet" selected="true">Value Sets</option>');
    expect(html).toContain('<option value="&lt;odd&gt;">');
    expect(makeSelect('ValueSet', options, 'rt')).toBe(html);
    expect(makeSelect('', options, 'rt')).toContain('<option value="" selected="true">');
    expect(makeSelect('CodeSystem', options, 'rt')).toContain('<option value="CodeSystem" selected="true">');
  });

  test('client gone', () => {
    expect(clientGone({ socket: { destroyed: false } }, { destroyed: false })).toBe(false);
    expect(clientGone({ socket: { destroyed: true } }, { destroyed: false })).toBe(true);
    expect(clientGone({ socket: { destroyed: false } }, { destroyed: true })).toBe(true);
  });
});

describe('GET /xig (the list)', () => {
  // a database that answers every count with 500 and every list with nothing, after a delay, and
  // remembers what it was asked
  let queries;
  let delay;
  const answer = (sql, params, callback) => {
    if (typeof params === 'function') {
      callback = params;
    }
    queries.push(sql);
    setTimeout(() => callback(null, /COUNT\(/.test(sql) ? { total: 500, count: 500 } : undefined), delay);
  };
  const db = {
    get: answer,
    all: (sql, params, callback) => {
      if (typeof params === 'function') {
        callback = params;
      }
      queries.push(sql);
      setTimeout(() => callback(null, []), delay);
    }
  };
  const counts = () => queries.filter(q => /COUNT\(\*\)/.test(q) && !/LIMIT/.test(q)).length;
  const pages = () => queries.filter(q => /LIMIT \? OFFSET \?/.test(q)).length;
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
    delay = 1;
    xig.setDatabaseForTests({ ...db }); // a new database each time: an empty cache
  });

  afterAll(() => {
    xig.setDatabaseForTests(null);
    xig.setStatsForTests(undefined);
  });

  test('the counts are run once per filter, not once per page', async () => {
    const first = await request(app).get('/xig?type=cs&realm=us');
    expect(first.status).toBe(200);
    expect(first.text).toContain('Rows 0 - 200 of 500');
    const after = counts();
    expect(after).toBeGreaterThan(1);
    expect(pages()).toBe(1);

    const second = await request(app).get('/xig?type=cs&realm=us&offset=200');
    expect(second.status).toBe(200);
    expect(second.text).toContain('Rows 200 - 400 of 500');
    expect(counts()).toBe(after);
    expect(pages()).toBe(2);

    const json = await request(app).get('/xig?type=cs&realm=us&offset=400&_fmt=json');
    expect(json.headers['x-total-count']).toBe('500');
    expect(counts()).toBe(after);

    await request(app).get('/xig?type=vs&realm=us');
    expect(counts()).toBeGreaterThan(after);
  });

  test('a list stops once its client has gone', async () => {
    delay = 150;
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
      const req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/xig?type=cs&realm=uv' });
      req.on('error', () => {});
      await new Promise(r => setTimeout(r, 50));
      req.destroy();
      await new Promise(r => setTimeout(r, 600));
      expect(queries.length).toBe(1); // the count: nothing after it
    } finally {
      await new Promise(r => server.close(r));
    }
  });
});

describe('GET /xig with auth.loginForExpensive: a filtered list past its first page needs a login', () => {
  const { auth, setupAuth, makeUser, tokenFor } = require('../helpers/auth');
  let app;
  let token;
  const db = {
    get: (sql, params, callback) => (typeof params === 'function' ? params : callback)(null, { total: 500, count: 500 }),
    all: (sql, params, callback) => (typeof params === 'function' ? params : callback)(null, [])
  };

  beforeAll(async () => {
    setupAuth({ loginForExpensive: true });
    token = tokenFor(await makeUser('someone', 'a-long-enough-password'));
    htmlServer.loadTemplate('xig', path.join(__dirname, '../../xig/xig-template.html'));
    xig.setXigSettings({});
    xig.setStatsForTests({ countRequest: () => {} });
    xig.setDatabaseForTests({ ...db });
    app = express();
    app.use(auth.pages);
    app.use('/xig', xig.router);
  });

  afterAll(() => {
    xig.setDatabaseForTests(null);
    xig.setStatsForTests(undefined);
    auth.shutdown();
  });

  test('the first page for anyone, with Next going to the login page', async () => {
    const res = await request(app).get('/xig?type=cs&realm=us');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Next (log in)</a>');
    expect(res.text).toContain('href="/auth/login?return=%2Fxig%3Frealm%3Dus%26type%3Dcs%26offset%3D200"');
  });

  test('past it: 401, for the page and for JSON and CSV', async () => {
    const page = await request(app).get('/xig?type=cs&realm=us&offset=200');
    expect(page.status).toBe(401);
    expect(page.text).toContain('a filtered XIG list past its first page');
    expect(page.text).toContain('href="/xig?realm=us&amp;type=cs"');
    const json = await request(app).get('/xig?type=cs&realm=us&offset=200&_fmt=json');
    expect(json.status).toBe(401);
    expect(json.body.error).toBe('login-required');
  });

  test('with a login, any page; the unfiltered list pages for anyone', async () => {
    const res = await request(app).get('/xig?type=cs&realm=us&offset=200').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Rows 200 - 400 of 500');
    expect(res.text).not.toContain('(log in)');
    expect((await request(app).get('/xig?offset=200')).status).toBe(200);
  });

  test('a filter is anything that chooses the rows', () => {
    expect(xig.isFiltered({ offset: '200' })).toBe(false);
    expect(xig.isFiltered({ text: 'blood' })).toBe(true);
    expect(xig.isFiltered({ ver: '', pkg: 'hl7.fhir.us.core' })).toBe(true);
  });
});
