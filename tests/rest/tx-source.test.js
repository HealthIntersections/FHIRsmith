//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// A rest endpoint's terminology on the tx server (tx/rest/rest-source.js): CodeSystems,
// ValueSets and ConceptMaps written to /r4 are used by $expand, $validate-code, $lookup and
// $translate on /tx/r4, take precedence over the core's, follow changes, and serve the
// endpoint's own :in searches (its txServer is /tx/r4).

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const TXModule = require('../../tx/tx');
const { engines, makeApp, mysqlConfig, FHIR_JSON } = require('./helpers');

const CS = 'http://example.org/fhir/CodeSystem/colours';
const VS = 'http://example.org/fhir/ValueSet/warm';
const CM = 'http://example.org/fhir/ConceptMap/colours-to-gender';
const GENDER = 'http://hl7.org/fhir/ValueSet/administrative-gender';

const codeSystem = (extra = []) => ({ resourceType: 'CodeSystem', id: 'colours', url: CS, version: '1.0.0', status: 'active', content: 'complete', caseSensitive: true,
  concept: [{ code: 'red', display: 'Red' }, { code: 'orange', display: 'Orange' }, { code: 'blue', display: 'Blue' }, ...extra] });
const valueSet = (codes) => ({ resourceType: 'ValueSet', id: 'warm', url: VS, version: '1.0.0', status: 'active',
  compose: { include: [{ system: CS, concept: codes.map(code => ({ code })) }] } });
const conceptMap = { resourceType: 'ConceptMap', id: 'c2g', url: CM, version: '1.0.0', status: 'active',
  group: [{ source: CS, target: 'http://hl7.org/fhir/administrative-gender', element: [{ code: 'red', target: [{ code: 'female', equivalence: 'equivalent' }] }] }] };

describe.each(engines())('a rest endpoint\'s terminology on the tx server (%s)', (engine) => {
  let t;
  let tx;
  let libDir;

  const put = (r) => request(t.app).put(`/r4/${r.resourceType}/${r.id}`).set('Content-Type', FHIR_JSON).send(JSON.stringify(r));
  const params = (res) => Object.fromEntries((res.body.parameter || []).map(p => [p.name, p.valueBoolean ?? p.valueString ?? p.valueCode ?? p.valueCoding ?? p]));
  // what the tx server's timers do: the code system list every minute; value sets on use, at most every few seconds
  const catchUp = async () => {
    for (const set of tx.library.restProviderSets.values()) {
      for (const s of set.source.snapshots.values()) {
        s.checkedAt = 0;
      }
    }
    for (const e of tx.endpoints) {
      await e.provider.updateCodeSystemList();
    }
  };

  beforeAll(async () => {
    // the endpoint, with its terminology, made first
    const first = await makeApp(engine, { keep: true, settings: { txServer: '/tx/r4' } });
    t = first;
    for (const r of [codeSystem(), valueSet(['red', 'orange']), conceptMap,
      { resourceType: 'ValueSet', id: 'gender', url: GENDER, version: '4.0.1', status: 'active', compose: { include: [{ system: CS, concept: [{ code: 'blue' }] }] } }]) {
      expect((await put(r)).status).toBe(201);
    }
    await first.stop();
    // then the server again, with the tx module publishing it
    libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-tx-source-'));
    const library = path.join(libDir, 'library.yaml');
    fs.writeFileSync(library, 'base:\n  url: https://storage.googleapis.com/tx-fhir-org\n\nsources:\n  - rest:/r4=r4db\n');
    const database = engine === 'mysql' ? mysqlConfig() : { type: 'sqlite', file: path.join(first.dir, 'test.db') };
    t = await makeApp(engine, {
      dir: first.dir, keep: true,
      before: async (app) => {
        tx = new TXModule();
        await tx.initialize({ librarySource: library, endpoints: [{ path: '/tx/r4', fhirVersion: '4.0', context: null }] }, app,
          { restEndpoints: [{ path: '/r4', database }] });
      }
    });
  }, 240000);

  afterAll(async () => {
    if (tx) {
      await tx.shutdown();
    }
    if (t) {
      await t.close();
    }
    if (libDir) {
      fs.rmSync(libDir, { recursive: true, force: true });
    }
  });

  test('$expand, $validate-code, $lookup and $translate use them', async () => {
    const e = await request(t.app).get('/tx/r4/ValueSet/$expand').query({ url: VS }).set('Accept', FHIR_JSON);
    expect(e.status).toBe(200);
    expect(e.body.expansion.contains.map(c => [c.code, c.display])).toEqual([['red', 'Red'], ['orange', 'Orange']]);
    const v = await request(t.app).get('/tx/r4/ValueSet/$validate-code').query({ url: VS, system: CS, code: 'blue' }).set('Accept', FHIR_JSON);
    expect(params(v).result).toBe(false);
    const ok = await request(t.app).get('/tx/r4/CodeSystem/$validate-code').query({ url: CS, code: 'blue', display: 'Blue' }).set('Accept', FHIR_JSON);
    expect(params(ok).result).toBe(true);
    const l = await request(t.app).get('/tx/r4/CodeSystem/$lookup').query({ system: CS, code: 'orange' }).set('Accept', FHIR_JSON);
    expect(l.status).toBe(200);
    expect(params(l).display).toBe('Orange');
    const tr = await request(t.app).get('/tx/r4/ConceptMap/$translate').query({ url: CM, system: CS, code: 'red', targetsystem: 'http://hl7.org/fhir/administrative-gender' }).set('Accept', FHIR_JSON);
    expect(tr.status).toBe(200);
    expect(params(tr).result).toBe(true);
    // and they are read, in the source's id space
    const read = await request(t.app).get('/tx/r4/ValueSet/r4db-warm').set('Accept', FHIR_JSON);
    expect(read.status).toBe(200);
    expect(read.body.url).toBe(VS);
    const s = await request(t.app).get('/tx/r4/ValueSet').query({ url: VS }).set('Accept', FHIR_JSON);
    expect(s.body.entry.map(x => x.resource.id)).toEqual(['r4db-warm']);
  });

  test('they take precedence over the core\'s', async () => {
    const e = await request(t.app).get('/tx/r4/ValueSet/$expand').query({ url: GENDER }).set('Accept', FHIR_JSON);
    expect(e.status).toBe(200);
    expect(e.body.expansion.contains.map(c => c.code)).toEqual(['blue']);
  });

  test('changes on the endpoint are followed', async () => {
    expect((await put(codeSystem([{ code: 'yellow', display: 'Yellow' }]))).status).toBe(200);
    expect((await put(valueSet(['red', 'yellow']))).status).toBe(200);
    await catchUp();
    const e = await request(t.app).get('/tx/r4/ValueSet/$expand').query({ url: VS }).set('Accept', FHIR_JSON);
    expect(e.body.expansion.contains.map(c => c.code)).toEqual(['red', 'yellow']);
    const l = await request(t.app).get('/tx/r4/CodeSystem/$lookup').query({ system: CS, code: 'yellow' }).set('Accept', FHIR_JSON);
    expect(params(l).display).toBe('Yellow');
    // deleted: gone
    expect((await request(t.app).delete('/r4/ConceptMap/c2g')).status).toBe(200);
    await catchUp();
    expect((await request(t.app).get('/tx/r4/ConceptMap/r4db-c2g').set('Accept', FHIR_JSON)).status).toBe(404);
  });

  test('the endpoint\'s own searches use them: :in with a value set stored there', async () => {
    for (const [id, code] of [['o1', 'red'], ['o2', 'blue'], ['o3', 'yellow']]) {
      await put({ resourceType: 'Observation', id, status: 'final', code: { coding: [{ system: CS, code }] } });
    }
    await catchUp();
    const r = await request(t.app).get('/r4/Observation').query({ 'code:in': VS }).set('Accept', FHIR_JSON);
    expect(r.status).toBe(200);
    expect(r.body.entry.map(x => x.resource.id).sort()).toEqual(['o1', 'o3']);
  });
});

describe('the rest source on its own', () => {
  const { restProviders, matches } = require('../../tx/rest/rest-source');

  test('a path that isn\'t an endpoint, or isn\'t a path, is refused', () => {
    expect(() => restProviders('/nowhere', [{ path: '/r4', database: {} }])).toThrow(/no rest endpoint at \/nowhere/);
    expect(() => restProviders('r4', [])).toThrow(/names a rest endpoint by its path/);
  });

  test('a database the rest module hasn\'t made yet: empty, and tried again later', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-tx-empty-'));
    const warnings = [];
    try {
      const set = restProviders('/r4', [{ path: '/r4', database: { type: 'sqlite', file: path.join(dir, 'new.db') } }],
        { databasesDir: dir, log: { warn: (m) => warnings.push(m) } });
      expect(await set.codeSystems.listCodeSystems('4.0', null)).toEqual([]);
      expect(await set.valueSets.fetchValueSet('http://x', null)).toBeNull();
      expect(warnings[0]).toMatch(/can't read the rest endpoint's database yet/);
      // (and it doesn't try again at once)
      expect(await set.source.open()).toBeNull();
      await set.source.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('search matches as the package providers do', () => {
    const vs = { url: 'http://a/vs', version: '1.2.0', name: 'Warm', status: 'active', compose: { include: [{ system: 'http://a/cs' }] } };
    expect(matches(vs, [{ name: 'url', value: 'http://a/vs' }])).toBe(true);
    expect(matches(vs, [{ name: 'url', value: 'http://a/VS' }])).toBe(false);
    expect(matches(vs, [{ name: 'url:below', value: 'http://a/' }, { name: 'name', value: 'war' }])).toBe(true);
    expect(matches(vs, [{ name: 'system', value: 'a/cs' }])).toBe(true);
    expect(matches(vs, [{ name: 'status', value: 'retired' }])).toBe(false);
  });
});

describe.each(engines())('terminology requests to the endpoint go to its terminology server (%s)', (engine) => {
  let t;
  let tx;
  let libDir;
  const put = (r) => request(t.app).put(`/r4/${r.resourceType}/${r.id}`).set('Content-Type', FHIR_JSON).send(JSON.stringify(r));

  beforeAll(async () => {
    const first = await makeApp(engine, { keep: true, settings: { txServer: '/tx/r4' } });
    t = first;
    for (const r of [codeSystem(), valueSet(['red', 'orange']), conceptMap]) {
      expect((await put(r)).status).toBe(201);
    }
    await first.stop();
    libDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-tx-proxy-'));
    const library = path.join(libDir, 'library.yaml');
    fs.writeFileSync(library, 'base:\n  url: https://storage.googleapis.com/tx-fhir-org\n\nsources:\n  - rest:/r4\n');
    const database = engine === 'mysql' ? mysqlConfig() : { type: 'sqlite', file: path.join(first.dir, 'test.db') };
    t = await makeApp(engine, {
      dir: first.dir, keep: true,
      before: async (app) => {
        tx = new TXModule();
        await tx.initialize({ librarySource: library, endpoints: [{ path: '/tx/r4', fhirVersion: '4.0', context: null }] }, app,
          { restEndpoints: [{ path: '/r4', database }] });
      }
    });
  }, 240000);

  afterAll(async () => {
    if (tx) {
      await tx.shutdown();
    }
    if (t) {
      await t.close();
    }
    if (libDir) {
      fs.rmSync(libDir, { recursive: true, force: true });
    }
  });

  test('metadata?mode=terminology is the terminology server\'s', async () => {
    const r = await request(t.app).get('/r4/metadata?mode=terminology').set('Accept', FHIR_JSON);
    expect(r.status).toBe(200);
    expect(r.body.resourceType).toBe('TerminologyCapabilities');
    // and the endpoint's own CapabilityStatement lists the operations
    const cs = await request(t.app).get('/r4/metadata').set('Accept', FHIR_JSON);
    const vs = cs.body.rest[0].resource.find(x => x.type === 'ValueSet');
    expect(vs.operation.map(o => o.name)).toEqual(expect.arrayContaining(['expand', 'validate-code']));
  });

  test('type level, GET and POST; the answer as the terminology server gave it, in the format asked for', async () => {
    const e = await request(t.app).get('/r4/ValueSet/$expand').query({ url: VS }).set('Accept', FHIR_JSON);
    expect(e.status).toBe(200);
    expect(e.body.expansion.contains.map(c => c.code)).toEqual(['red', 'orange']);
    const p = await request(t.app).post('/r4/CodeSystem/$lookup').set('Content-Type', FHIR_JSON).set('Accept', FHIR_JSON)
      .send(JSON.stringify({ resourceType: 'Parameters', parameter: [{ name: 'system', valueUri: CS }, { name: 'code', valueCode: 'red' }] }));
    expect(p.status).toBe(200);
    expect(p.body.parameter.find(x => x.name === 'display').valueString).toBe('Red');
    const x = await request(t.app).get('/r4/ValueSet/$expand').query({ url: VS }).set('Accept', 'application/fhir+xml');
    expect(x.status).toBe(200);
    expect(x.text).toContain('<code value="orange"/>');
    // an error is the terminology server's too
    const bad = await request(t.app).get('/r4/ValueSet/$expand').query({ url: 'http://example.org/nothing' }).set('Accept', FHIR_JSON);
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.body.resourceType).toBe('OperationOutcome');
  });

  test('instance level: the endpoint\'s resource, by its url and version', async () => {
    const e = await request(t.app).get('/r4/ValueSet/warm/$expand').set('Accept', FHIR_JSON);
    expect(e.status).toBe(200);
    expect(e.body.expansion.contains.map(c => c.code)).toEqual(['red', 'orange']);
    const v = await request(t.app).post('/r4/CodeSystem/colours/$validate-code').set('Content-Type', FHIR_JSON).set('Accept', FHIR_JSON)
      .send(JSON.stringify({ resourceType: 'Parameters', parameter: [{ name: 'code', valueCode: 'blue' }] }));
    expect(v.status).toBe(200);
    expect(v.body.parameter.find(x => x.name === 'result').valueBoolean).toBe(true);
    const tr = await request(t.app).get('/r4/ConceptMap/c2g/$translate').query({ system: CS, code: 'red', targetsystem: 'http://hl7.org/fhir/administrative-gender' }).set('Accept', FHIR_JSON);
    expect(tr.body.parameter.find(x => x.name === 'result').valueBoolean).toBe(true);
    expect((await request(t.app).get('/r4/ValueSet/nothing/$expand')).status).toBe(404);
  });

  test('without a terminology server: not supported', async () => {
    const saved = t.ep.terminology;
    t.ep.terminology = null;
    try {
      expect((await request(t.app).get('/r4/ValueSet/$expand').query({ url: VS })).status).toBe(501);
      expect((await request(t.app).get('/r4/metadata?mode=terminology')).status).toBe(501);
    } finally {
      t.ep.terminology = saved;
    }
  });
});
