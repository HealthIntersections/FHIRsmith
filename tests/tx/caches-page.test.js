/**
 * The tx module's caches (tx/tx-caches.js): the text indexes of what was loaded at startup kept in
 * the text index store, every cache in one registry, and the /caches page that lists them and,
 * with modules.tx.adminPassword, empties them
 */

const express = require('express');
const path = require('path');
const request = require('supertest');
const TXModule = require('../../tx/tx');
const { TextIndexStore, StoredNameIndex } = require('../../tx/library/text-index-store');
const { loadedCodeSystems } = require('../../tx/tx-caches');
const memoryGuard = require('../../library/memory-guard');

const LIBRARY = path.join(__dirname, 'fixtures', 'test-library.yaml');
const R5 = '/tx/r5';
const SYS = 'http://hl7.org/fhir/test/CodeSystem/simple';
const SIMPLE = {
  resourceType: 'CodeSystem', id: 'simple', url: SYS, version: '0.1.0', name: 'Simple', status: 'active',
  caseSensitive: true, content: 'complete',
  concept: [{ code: 'code1', display: 'Display 1' }, { code: 'code2', display: 'Display 2' }]
};

describe('the caches page', () => {
  let app, txModule;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    txModule = new TXModule();
    await txModule.initialize({ librarySource: LIBRARY, adminPassword: 'secret', endpoints: [{ path: R5, fhirVersion: '5.0', context: null }] }, app);
  }, 240000);

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
    const res = await request(app).get(`${R5}/caches`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Client caches (cache-ids)');
    expect(res.text).toContain('Empty all but the client caches');
  });

  test('a wrong password empties nothing', async () => {
    const before = txModule.caches.report().find(r => r.name === 'Client caches (cache-ids)').entries;
    const res = await request(app).post(`${R5}/caches`).type('form').send({ password: 'wrong', action: 'unload-all' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Incorrect password');
    expect(txModule.caches.report().find(r => r.name === 'Client caches (cache-ids)').entries).toBe(before);
  });

  test('"all but the client caches" keeps the client caches; "all" empties them too', async () => {
    txModule.languages.parse('en-AU');
    expect(txModule.caches.report().find(r => r.name === 'Parsed language tags').entries).toBeGreaterThan(0);
    let res = await request(app).post(`${R5}/caches`).type('form').send({ password: 'secret', action: 'unload' });
    expect(res.text).toContain('not the client caches');
    let report = txModule.caches.report();
    expect(report.find(r => r.name === 'Parsed language tags').entries).toBe(0);
    expect(report.find(r => r.name === 'Client caches (cache-ids)').entries).toBe(1);
    // the store is not a cache: it stays
    expect(report.find(r => r.name === 'Text index store (SQLite, kept between runs)').entries).toBeGreaterThan(0);

    res = await request(app).post(`${R5}/caches`).type('form').send({ password: 'secret', action: 'unload-all' });
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

describe('the caches page, with no password configured', () => {
  test('lists the caches, and empties none', async () => {
    const app = express();
    app.use(express.json());
    const txModule = new TXModule();
    try {
      await txModule.initialize({ librarySource: LIBRARY, endpoints: [{ path: R5, fhirVersion: '5.0', context: null }] }, app);
      let res = await request(app).get(`${R5}/caches`);
      expect(res.text).toContain('none is configured');
      expect(res.text).not.toContain('type="password"');
      res = await request(app).post(`${R5}/caches`).type('form').send({ password: '', action: 'unload-all' });
      expect(res.text).toContain('nothing was emptied');
    } finally {
      await txModule.shutdown();
    }
  }, 240000);
});
