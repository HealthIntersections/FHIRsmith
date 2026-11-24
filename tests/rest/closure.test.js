//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// :below and :above on tokens, end to end: the tx module, in the same app with closure
// turned on, is the endpoint's terminology server; the rest endpoint sends it the codes it
// indexes ($closure) and searches the closure table it builds from the answers.

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const TXModule = require('../../tx/tx');
const { engines, makeApp, body, invariants, FHIR_JSON } = require('./helpers');

const LIBRARY = path.join(__dirname, '..', 'tx', 'fixtures', 'test-library.yaml');
// a code system in the core, with a hierarchy: Resource > DomainResource > Patient, ...
const SYS = 'http://hl7.org/fhir/fhir-types';

describe.each(engines())(':below and :above through the closure (%s)', (engine) => {
  let t;
  let tx;
  let txDir;
  const ids = {};

  const post = async (code) => {
    const r = await request(t.app).post('/r4/Observation').set('Content-Type', FHIR_JSON)
      .send(body({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: SYS, code }] } }));
    expect(r.status).toBe(201);
    return r.body.id;
  };
  const found = async (url) => {
    const r = await request(t.app).get(url);
    expect(r.status).toBe(200);
    return (r.body.entry || []).filter(e => e.search.mode === 'match').map(e => e.resource.id).sort();
  };
  const ofCodes = (...codes) => codes.map(c => ids[c]).sort();

  beforeAll(async () => {
    txDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-closure-'));
    t = await makeApp(engine, {
      settings: { txServer: '/tx/r5' },
      before: async (app) => {
        tx = new TXModule();
        await tx.initialize({ librarySource: LIBRARY, endpoints: [{ path: '/tx/r5', fhirVersion: '5.0', context: null }],
          closure: { enabled: true, database: path.join(txDir, 'closure.db') } }, app);
      }
    });
    for (const c of ['Resource', 'DomainResource', 'Patient', 'Observation', 'Bundle']) {
      ids[c] = await post(c);
    }
    // what the master's job does every 5 seconds
    while (await t.ep.terminology.updateClosure(t.ep) > 0) {
      // the next batch
    }
  }, 240000);

  afterAll(async () => {
    await t.close();
    await tx.shutdown();
    fs.rmSync(txDir, { recursive: true, force: true });
  });

  test('the closure table holds the relationships between the codes indexed', async () => {
    const n = await t.ep.db.read(q => q.get('SELECT COUNT(*) AS N FROM ClosureEntries'));
    expect(Number(n.N)).toBeGreaterThan(0);
    const left = await t.ep.db.read(q => q.get('SELECT COUNT(*) AS N FROM Concepts WHERE InClosure = 0'));
    expect(Number(left.N)).toBe(0);
  });

  test(':below: the code and everything it subsumes', async () => {
    expect(await found(`/r4/Observation?code:below=${SYS}|DomainResource`)).toEqual(ofCodes('DomainResource', 'Patient', 'Observation'));
    expect(await found(`/r4/Observation?code:below=${SYS}|Resource`)).toEqual(ofCodes('Resource', 'DomainResource', 'Patient', 'Observation', 'Bundle'));
    expect(await found(`/r4/Observation?code:below=${SYS}|Patient`)).toEqual(ofCodes('Patient'));
  });

  test(':above: the code and everything that subsumes it', async () => {
    expect(await found(`/r4/Observation?code:above=${SYS}|Patient`)).toEqual(ofCodes('Resource', 'DomainResource', 'Patient'));
    expect(await found(`/r4/Observation?code:above=${SYS}|Bundle`)).toEqual(ofCodes('Resource', 'Bundle'));
  });

  test('in _filter: ss and sb', async () => {
    expect(await found('/r4/Observation?_filter=' + encodeURIComponent(`code ss ${SYS}|DomainResource`)))
      .toEqual(ofCodes('DomainResource', 'Patient', 'Observation'));
    expect(await found('/r4/Observation?_filter=' + encodeURIComponent(`code sb ${SYS}|Patient`)))
      .toEqual(ofCodes('Resource', 'DomainResource', 'Patient'));
  });

  test('a code indexed later joins in at the next round', async () => {
    ids.Encounter = await post('Encounter');
    expect(await found(`/r4/Observation?code:below=${SYS}|DomainResource`)).toEqual(ofCodes('DomainResource', 'Patient', 'Observation'));
    while (await t.ep.terminology.updateClosure(t.ep) > 0) {
      // the next batch
    }
    expect(await found(`/r4/Observation?code:below=${SYS}|DomainResource`)).toEqual(ofCodes('DomainResource', 'Patient', 'Observation', 'Encounter'));
    expect(await invariants(t.ep)).toEqual([]);
  });
});
