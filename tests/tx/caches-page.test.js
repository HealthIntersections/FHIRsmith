/**
 * The tx module's caches (tx/tx-caches.js): the text indexes of what was loaded at startup kept in
 * the text index store, every cache in one registry, and the /caches page that lists them and,
 * for the server's administrators (library/auth), empties them
 */

const express = require('express');
const path = require('path');
const request = require('supertest');
const TXModule = require('../../tx/tx');
const { TextIndexStore, StoredNameIndex } = require('../../tx/library/text-index-store');
const { loadedCodeSystems } = require('../../tx/tx-caches');
const memoryGuard = require('../../library/memory-guard');
const { ADMIN_PASSWORD, setupAuth, mountAuth, makeUser, login, csrfOf } = require('../helpers/auth');

const LIBRARY = path.join(__dirname, 'fixtures', 'test-library.yaml');
const R5 = '/tx/r5';
const SYS = 'http://hl7.org/fhir/test/CodeSystem/simple';
const SIMPLE = {
  resourceType: 'CodeSystem', id: 'simple', url: SYS, version: '0.1.0', name: 'Simple', status: 'active',
  caseSensitive: true, content: 'complete',
  concept: [{ code: 'code1', display: 'Display 1' }, { code: 'code2', display: 'Display 2' }]
};

describe('the caches page', () => {
  let app, txModule, admin;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    setupAuth();
    mountAuth(app);
    await makeUser('admin', ADMIN_PASSWORD, { admin: true });
    await makeUser('someone', 'someone-password');
    txModule = new TXModule();
    await txModule.initialize({ librarySource: LIBRARY, endpoints: [{ path: R5, fhirVersion: '5.0', context: null }] }, app);
    admin = (await login(app, 'admin', ADMIN_PASSWORD)).agent;
  }, 240000);

  // a post from the page, as the agent
  const empty = async (agent, action) => {
    const _csrf = await csrfOf(agent, `${R5}/caches`);
    return agent.post(`${R5}/caches`).type('form').send({ action, _csrf });
  };

  afterAll(async () => {
    if (txModule) {
      await txModule.shutdown();
    }
  });

  test('the code systems loaded at startup are searched from the text index store', async () => {
    expect(txModule.textIndexStore).toBeTruthy();
    const css = loadedCodeSystems(txModule.endpoints).filter(cs => cs.jsonObj.content !== 'supplement' && cs.getAllConcepts().length > 0);
    expect(css.length).toBeGreaterThan(0);
    for (const cs of css) {
      expect(TextIndexStore.indexFor(cs)).toBeInstanceOf(StoredNameIndex);
    }
    // a text filter on one of them
    const res = await request(app).get(`${R5}/ValueSet/$expand?url=${encodeURIComponent('http://hl7.org/fhir/ValueSet/administrative-gender')}&filter=fem`)
      .set('Accept', 'application/fhir+json');
    expect(res.status).toBe(200);
    expect(res.body.expansion.contains.map(c => c.code)).toEqual(['female']);
  });

  test('lists the caches, with what they hold', async () => {
    // put something in the expansion and client caches
    const start = await request(app).post(`${R5}/$cache-control`).query({ mode: 'start' }).set('Content-Type', 'application/json')
      .send({ resourceType: 'Parameters', parameter: [{ name: 'tx-resource', resource: SIMPLE }] });
    expect(start.status).toBe(200);
    const report = txModule.caches.report();
    const names = report.map(r => r.name);
    for (const name of ['Expansion cache', 'Client caches (cache-ids)', 'Parsed language tags', 'Filter results on package value sets',
      'Text index store (SQLite, kept between runs)']) {
      expect(names).toContain(name);
    }
    expect(report.find(r => r.name === 'Client caches (cache-ids)').entries).toBe(1);
    // anyone sees what they hold; only an administrator the buttons
    const res = await request(app).get(`${R5}/caches`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Client caches (cache-ids)');
    expect(res.text).not.toContain('Empty all but the client caches');
    expect(res.text).toContain('The server\'s administrators can empty the caches: <a href="/auth/login?return=');
    const page = await admin.get(`${R5}/caches`);
    expect(page.text).toContain('Empty all but the client caches');
    expect(page.text).toContain('name="_csrf"');
    expect(page.text).not.toContain('type="password"');
  });

  test('anyone but an administrator empties nothing', async () => {
    const before = txModule.caches.report().find(r => r.name === 'Client caches (cache-ids)').entries;
    const someone = (await login(app, 'someone', 'someone-password')).agent;
    // the page has no form for them: a post with their session's token, as if it had
    const _csrf = await csrfOf(someone);
    let res = await someone.post(`${R5}/caches`).type('form').send({ action: 'unload-all', _csrf });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Only the server&#39;s administrators can empty the caches');
    // not logged in: there is no form to post from (no CSRF token), so the post is refused
    res = await request(app).post(`${R5}/caches`).type('form').send({ action: 'unload-all' });
    expect(res.status).toBe(403);
    expect(txModule.caches.report().find(r => r.name === 'Client caches (cache-ids)').entries).toBe(before);
  });

  test('what a cache holds: a page for the administrators, linked from the cache\'s name', async () => {
    txModule.languages.parse('en-AU');
    txModule.languages.parse('fr-CA', null, { caseInsensitive: true });
    const page = await admin.get(`${R5}/caches`);
    expect(page.text).toContain('<a href="caches?show=language-tags">Parsed language tags</a>');
    expect(page.text).toMatch(/different tags \(\d+ ignoring case\)/);
    let res = await admin.get(`${R5}/caches?show=language-tags`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<h2>Parsed language tags</h2>');
    expect(res.text).toContain('<td>en-AU</td>');
    expect(res.text).toMatch(/<td>fr-CA<\/td><td>case insensitive<\/td>/);
    // no ecosystem resolver configured here: no such cache
    res = await admin.get(`${R5}/caches?show=ecosystem`);
    expect(res.text).toContain('There is no such cache');
    // anyone else is asked to log in
    res = await request(app).get(`${R5}/caches?show=language-tags`);
    expect(res.text).toContain('administrators can see what a cache holds');
    expect(res.text).not.toContain('en-AU');
  });

  test('"all but the client caches" keeps the client caches; "all" empties them too', async () => {
    txModule.languages.parse('en-AU');
    expect(txModule.caches.report().find(r => r.name === 'Parsed language tags').entries).toBeGreaterThan(0);
    let res = await empty(admin, 'unload');
    expect(res.text).toContain('not the client caches');
    let report = txModule.caches.report();
    expect(report.find(r => r.name === 'Parsed language tags').entries).toBe(0);
    expect(report.find(r => r.name === 'Client caches (cache-ids)').entries).toBe(1);
    // the store is not a cache: it stays
    expect(report.find(r => r.name === 'Text index store (SQLite, kept between runs)').entries).toBeGreaterThan(0);

    res = await empty(admin, 'unload-all');
    expect(res.text).toContain('client caches included');
    report = txModule.caches.report();
    expect(report.find(r => r.name === 'Client caches (cache-ids)').entries).toBe(0);
  });

  test('the endpoint and process caches are registered with the memory guard, the client caches last', () => {
    const names = [...memoryGuard._relievers.keys()];
    expect(names).toContain(`Expansion cache (${R5})`);
    expect(memoryGuard._relievers.get(`Client caches (cache-ids) (${R5})`).last).toBe(true);
    expect(memoryGuard._relievers.get(`Expansion cache (${R5})`).last).toBe(false);
    // the filter results on package value sets are (they have their own budget, so emptying
    // them doesn't depend on how many value sets there are); what is kept with loaded content is not
    expect(names).toContain('Filter results on package value sets (process)');
    expect(names).not.toContain('SNOMED CT indexes built as they are used (process)');
  });
});
