//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// :below and :above on tokens, end to end: the tx module, in the same app with closure
// turned on, is the endpoint's terminology server; the rest endpoint sends it the codes it
// indexes ($closure), a table for each place a code can be, and searches the closure table it
// builds from the answers.

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const TXModule = require('../../tx/tx');
const { engines, makeApp, body, invariants, FHIR_JSON } = require('./helpers');

const LIBRARY = path.join(__dirname, '..', 'tx', 'fixtures', 'test-library.yaml');
// a code system in the core, with a hierarchy: Resource > DomainResource > Patient, ...
const SYS = 'http://hl7.org/fhir/fhir-types';
// small, so a table fills up
const MAX_CONCEPTS = 7;

describe.each(engines())(':below and :above through the closure (%s)', (engine) => {
  let t;
  let tx;
  let txDir;
  const ids = {};
  const warnings = [];

  const post = async (type, code, system = SYS) => {
    const r = await request(t.app).post(`/r4/${type}`).set('Content-Type', FHIR_JSON)
      .send(body(type === 'Observation'
        ? { resourceType: 'Observation', status: 'final', code: { coding: [{ system, code }] } }
        : { resourceType: 'Condition', subject: { reference: `Patient/${ids.patient}` }, code: { coding: [{ system, code }] } }));
    expect(r.status).toBe(201);
    return r.body.id;
  };
  const found = async (url) => {
    const r = await request(t.app).get(url);
    expect(r.status).toBe(200);
    return (r.body.entry || []).filter(e => e.search.mode === 'match').map(e => e.resource.id).sort();
  };
  const of = (...names) => names.map(c => ids[c]).sort();
  const update = async () => {
    // what the master's job does every 5 seconds
    while (await t.ep.terminology.updateClosure(t.ep) > 0) {
      // the next batch
    }
  };
  // the codes in Condition.code and Observation.code, and whether they're in their closures
  const state = () => t.ep.db.read(q => q.all(`SELECT t.Name AS Type, c.Code, pc.InClosure FROM ParamConcepts pc
    JOIN Types t ON t.TypeKey = pc.TypeKey JOIN Concepts c ON c.ConceptKey = pc.ConceptKey JOIN SearchParams s ON s.ParamKey = pc.ParamKey
    WHERE s.Code = 'code' ORDER BY t.Name, c.Code`))
    .then(rows => rows.map(r => `${r.Type} ${r.Code} ${r.InClosure}`));

  beforeAll(async () => {
    txDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-closure-'));
    const log = { info: () => {}, debug: () => {}, error: () => {}, warn: (m) => warnings.push(m) };
    t = await makeApp(engine, {
      settings: { txServer: '/tx/r5' },
      log,
      before: async (app) => {
        tx = new TXModule();
        await tx.initialize({ librarySource: LIBRARY, endpoints: [{ path: '/tx/r5', fhirVersion: '5.0', context: null }],
          closure: { enabled: true, database: path.join(txDir, 'closure.db'), requireUuidNames: true, maxConceptsPerTable: MAX_CONCEPTS } }, app);
      }
    });
    ids.patient = (await request(t.app).post('/r4/Patient').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Patient' }))).body.id;
    for (const c of ['Resource', 'DomainResource', 'Patient', 'Observation', 'Bundle']) {
      ids[c] = await post('Observation', c);
    }
    ids['c:Patient'] = await post('Condition', 'Patient');
    ids['c:Encounter'] = await post('Condition', 'Encounter');
    // codes the terminology server doesn't know, in the same batch as the rest
    ids.unknownCode = await post('Observation', 'NotAType');
    ids.unknownSystem = await post('Observation', 'x', 'http://example.org/nowhere');
    await update();
  }, 240000);

  afterAll(async () => {
    await t.close();
    await tx.shutdown();
    fs.rmSync(txDir, { recursive: true, force: true });
  });

  test('a closure table for each place a code is in, named with a UUID', async () => {
    const closures = await t.ep.db.read(q => q.all(`SELECT c.Name, t.Name AS Type, s.Code FROM Closures c JOIN Types t ON t.TypeKey = c.TypeKey
      JOIN SearchParams s ON s.ParamKey = c.ParamKey ORDER BY t.Name`));
    // combo-code (Observation.code | Observation.component.code) is a place of its own; the
    // composites (code-value-concept...) are not
    expect(closures.map(c => `${c.Type}.${c.Code}`).sort()).toEqual(['Condition.code', 'Observation.code', 'Observation.combo-code']);
    expect(closures.every(c => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c.Name))).toBe(true);
  });

  test('the codes the server doesn\'t know are refused, without holding up the rest', async () => {
    expect(await state()).toEqual([
      'Condition Encounter 1', 'Condition Patient 1',
      'Observation Bundle 1', 'Observation DomainResource 1', 'Observation NotAType 2', 'Observation Observation 1',
      'Observation Patient 1', 'Observation Resource 1', 'Observation x 2'
    ]);
  });

  test(':below: the code and everything it subsumes', async () => {
    expect(await found(`/r4/Observation?code:below=${SYS}|DomainResource`)).toEqual(of('DomainResource', 'Patient', 'Observation'));
    expect(await found(`/r4/Observation?code:below=${SYS}|Resource`)).toEqual(of('Resource', 'DomainResource', 'Patient', 'Observation', 'Bundle'));
    expect(await found(`/r4/Observation?code:below=${SYS}|Patient`)).toEqual(of('Patient'));
  });

  test(':above: the code and everything that subsumes it', async () => {
    expect(await found(`/r4/Observation?code:above=${SYS}|Patient`)).toEqual(of('Resource', 'DomainResource', 'Patient'));
    expect(await found(`/r4/Observation?code:above=${SYS}|Bundle`)).toEqual(of('Resource', 'Bundle'));
  });

  test('in _filter: ss and sb', async () => {
    expect(await found('/r4/Observation?_filter=' + encodeURIComponent(`code ss ${SYS}|DomainResource`)))
      .toEqual(of('DomainResource', 'Patient', 'Observation'));
    expect(await found('/r4/Observation?_filter=' + encodeURIComponent(`code sb ${SYS}|Patient`)))
      .toEqual(of('Resource', 'DomainResource', 'Patient'));
  });

  test('a code indexed later joins in at the next round', async () => {
    ids.Encounter = await post('Observation', 'Encounter');
    expect(await found(`/r4/Observation?code:below=${SYS}|DomainResource`)).toEqual(of('DomainResource', 'Patient', 'Observation'));
    await update();
    expect(await found(`/r4/Observation?code:below=${SYS}|DomainResource`)).toEqual(of('DomainResource', 'Patient', 'Observation', 'Encounter'));
  });

  test('a full table refuses what is sent to it, with a warning; the other tables carry on', async () => {
    // Observation.code has 6 codes: 2 more is more than it can hold
    ids.Practitioner = await post('Observation', 'Practitioner');
    ids.Organization = await post('Observation', 'Organization');
    ids['c:DomainResource'] = await post('Condition', 'DomainResource');
    await update();
    expect((await state()).filter(s => /Practitioner|Organization|Condition DomainResource/.test(s)))
      .toEqual(['Condition DomainResource 1', 'Observation Organization 2', 'Observation Practitioner 2']);
    expect(warnings.some(w => /Observation\.code: the terminology server refused 2 codes/.test(w))).toBe(true);
    expect(await found(`/r4/Condition?code:below=${SYS}|DomainResource`)).toEqual(of('c:DomainResource', 'c:Patient', 'c:Encounter'));
    // refused codes match only themselves
    expect(await found(`/r4/Observation?code:below=${SYS}|DomainResource`)).toEqual(of('DomainResource', 'Patient', 'Observation', 'Encounter'));
    expect(await invariants(t.ep)).toEqual([]);
  });

  test('a code searched for that isn\'t in the place is added to its table, and related at once', async () => {
    // no Condition has Resource or DomainResource
    expect(await found(`/r4/Condition?code:below=${SYS}|Resource`)).toEqual(of('c:DomainResource', 'c:Patient', 'c:Encounter'));
    expect(await found(`/r4/Condition?code:above=${SYS}|Encounter`)).toEqual(of('c:DomainResource', 'c:Encounter'));
    await t.ep.terminology.settled();
    // and it's kept: in the table, and its relationships in the database
    expect((await state()).filter(s => s.startsWith('Condition Resource'))).toEqual(['Condition Resource 1']);
    const calls = [];
    const send = t.ep.terminology.sendConcepts.bind(t.ep.terminology);
    t.ep.terminology.sendConcepts = (n, c) => { calls.push(c); return send(n, c); };
    t.ep.terminology.searched.clear();
    try {
      expect(await found(`/r4/Condition?code:below=${SYS}|Resource`)).toEqual(of('c:DomainResource', 'c:Patient', 'c:Encounter'));
      expect(calls).toEqual([]);
      // a code that isn't indexed anywhere at all
      expect(await found(`/r4/Condition?code:above=${SYS}|Practitioner`)).toEqual(of('c:DomainResource'));
      expect(calls).toHaveLength(1);
      await t.ep.terminology.settled();
      // one the server doesn't know: refused, and not asked about again
      expect(await found(`/r4/Condition?code:below=${SYS}|NotAType`)).toEqual([]);
      expect(await found(`/r4/Condition?code:below=${SYS}|NotAType`)).toEqual([]);
      expect(calls).toHaveLength(2);
      await t.ep.terminology.settled();
      expect((await state()).filter(s => s.startsWith('Condition NotAType'))).toEqual(['Condition NotAType 2']);
      // a place with no codes, so no table: nothing to relate it to, and no call
      expect(await found(`/r4/Observation?category:below=${SYS}|Resource`)).toEqual([]);
      expect(calls).toHaveLength(2);
    } finally {
      t.ep.terminology.sendConcepts = send;
    }
    // relationships are facts whichever table they came from: the search above put Practitioner
    // in Condition.code's table, so Observations coded Practitioner (refused by the full
    // Observation tables) are found below Resource now too
    expect(await found(`/r4/Observation?combo-code:below=${SYS}|Resource`))
      .toEqual(of('Resource', 'DomainResource', 'Patient', 'Observation', 'Bundle', 'Encounter', 'Practitioner'));
    expect(await invariants(t.ep)).toEqual([]);
  });

  test('in a transaction, a search that adds a code to a table doesn\'t wait on the transaction', async () => {
    t.ep.terminology.searched.clear();
    const r = await request(t.app).post('/r4').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Bundle', type: 'transaction', entry: [
      { resource: { resourceType: 'Condition', subject: { reference: `Patient/${ids.patient}` }, code: { coding: [{ system: SYS, code: 'Bundle' }] } },
        request: { method: 'POST', url: 'Condition' } },
      { request: { method: 'GET', url: `Condition?code:below=${encodeURIComponent(SYS + '|Organization')}` } }
    ] }));
    expect(r.status).toBe(200);
    await t.ep.terminology.settled();
    expect((await state()).filter(s => s.startsWith('Condition Organization'))).toEqual(['Condition Organization 1']);
  });

  test('a table the server has lost is started again', async () => {
    const before = await t.ep.db.read(q => q.all('SELECT Name FROM Closures ORDER BY ClosureKey'));
    // as if the server had lost a table: the endpoint's name for it is one the server doesn't know
    await t.ep.db.write(q => q.run("UPDATE Closures SET Name = '00000000-0000-4000-8000-000000000000' WHERE Name = ?", [before[0].Name]));
    await t.ep.db.write(q => q.run('UPDATE ParamConcepts SET InClosure = 0 WHERE InClosure = 1 AND ConceptKey IN (SELECT ConceptKey FROM Concepts WHERE Code = ?)', ['Patient']));
    await update();
    await update();
    const after = await t.ep.db.read(q => q.all('SELECT Name FROM Closures ORDER BY ClosureKey'));
    expect(after).toHaveLength(before.length);
    expect(after.map(a => a.Name)).not.toContain('00000000-0000-4000-8000-000000000000');
    expect(warnings.some(w => /doesn't know its table any more/.test(w))).toBe(true);
    expect(await found(`/r4/Condition?code:below=${SYS}|DomainResource`)).toEqual(of('c:DomainResource', 'c:Patient', 'c:Encounter'));
  });
});

describe.each(engines())('closures: a version 3 database is brought up to date (%s)', (engine) => {
  test('the codes in each place are found from the index, ready to send', async () => {
    let t = await makeApp(engine);
    const r = await request(t.app).post('/r4/Observation').set('Content-Type', FHIR_JSON)
      .send(body({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: SYS, code: 'Patient' }] },
        contained: [{ resourceType: 'Condition', id: 'c', subject: { reference: '#' }, code: { coding: [{ system: SYS, code: 'Encounter' }] } }],
        hasMember: [{ reference: '#c' }] }));
    expect(r.status).toBe(201);
    // back to version 3: no ParamConcepts (nor version 5's value set tables), one closure for everything
    await t.ep.db.write(async (q) => {
      await q.exec('DROP TABLE ValueSets');
      await q.exec('DROP TABLE ValueSetMembers');
      await q.exec('DROP TABLE ParamConcepts');
      await q.exec(q.dialect.name === 'sqlite' ? 'DROP INDEX SK_Closures_Param' : 'DROP INDEX SK_Closures_Param ON Closures');
      await q.exec('ALTER TABLE Closures DROP COLUMN TypeKey');
      await q.exec('ALTER TABLE Closures DROP COLUMN ParamKey');
      await q.run("INSERT INTO Closures (Name, Version) VALUES ('fhirsmith-rest-old', '3')");
      await q.run('UPDATE Config SET Value = ? WHERE Name = ?', ['3', 'schemaVersion']);
    });
    await t.mod.shutdown();
    t = await makeApp(engine, { dir: t.dir, keep: true });
    try {
      const rows = await t.ep.db.read(q => q.all(`SELECT t.Name AS Type, s.Code AS Param, c.Code, pc.InClosure FROM ParamConcepts pc
        JOIN Types t ON t.TypeKey = pc.TypeKey JOIN SearchParams s ON s.ParamKey = pc.ParamKey JOIN Concepts c ON c.ConceptKey = pc.ConceptKey
        WHERE s.Code = 'code' ORDER BY t.Name`));
      // the contained Condition's code is in Condition.code
      expect(rows.map(x => `${x.Type}.${x.Param} ${x.Code} ${x.InClosure}`)).toEqual(['Condition.code Encounter 0', 'Observation.code Patient 0']);
      expect(await t.ep.db.read(q => q.all('SELECT * FROM Closures'))).toEqual([]);
    } finally {
      await t.close();
    }
  });
});
