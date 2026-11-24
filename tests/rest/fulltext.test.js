//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const request = require('supertest');
const { engines, makeApp, body, invariants, FHIR_JSON } = require('./helpers');
const { narrativeText, contentText, parseQuery, fts5, mysqlBoolean } = require('../../rest/indexing/fulltext');
const { SCHEMA_VERSION } = require('../../rest/database/schema');

describe('full-text: text and query syntax', () => {
  test('the narrative\'s text: markup out, entities decoded', () => {
    expect(narrativeText('<div xmlns="http://www.w3.org/1999/xhtml"><p>Peter <b>James</b>&amp;Chalmers&#160;&lt;x&gt;</p></div>'))
      .toBe('Peter James &Chalmers <x>');
    expect(narrativeText('')).toBe('');
    expect(narrativeText(null)).toBe('');
    expect(narrativeText('unclosed <b')).toBe('unclosed');
    const start = Date.now();
    narrativeText('<'.repeat(200000));
    narrativeText('<a>'.repeat(200000));
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test('the content\'s text: the values, not the element names, the meta or base64 data', () => {
    const t = contentText({ resourceType: 'Patient', meta: { versionId: '3', tag: [{ code: 'secret-tag' }] }, active: true,
      name: [{ family: 'Chalmers', given: ['Peter'] }], photo: [{ data: 'QUJDREVGR0g=' }], text: { div: '<div><p>Narrative words</p></div>' } });
    expect(t).toContain('Chalmers');
    expect(t).toContain('Peter');
    expect(t).toContain('Narrative words');
    expect(t).toContain('true');
    expect(t).not.toContain('family');
    expect(t).not.toContain('Patient');
    expect(t).not.toContain('QUJD');
    expect(t).not.toContain('secret-tag');
    expect(t).not.toContain('<p>');
  });

  test('the query: words, phrases, AND, OR, NOT, brackets', () => {
    expect(parseQuery('chest pain')).toEqual({ op: 'and', items: [{ op: 'term', words: ['chest'], prefix: true }, { op: 'term', words: ['pain'], prefix: true }] });
    expect(parseQuery('"Chest Pain"')).toEqual({ op: 'term', words: ['chest', 'pain'], prefix: false });
    expect(parseQuery('Müller')).toEqual({ op: 'term', words: ['muller'], prefix: true });
    // a word the index splits is matched as a phrase
    expect(parseQuery('anna@example.org')).toEqual({ op: 'term', words: ['anna', 'example', 'org'], prefix: false });
    expect(parseQuery('a OR b c').op).toBe('or');
    expect(parseQuery('a AND (b OR c) -d NOT e')).toMatchObject({ op: 'and', items: [{ op: 'term' }, { op: 'or' }, { op: 'not' }, { op: 'not' }] });
  });

  test('the query in each engine\'s syntax', () => {
    const q = parseQuery('chest "blood pressure" (pain OR ache) -child');
    expect(fts5(q)).toBe('(("chest"* AND "blood pressure" AND ("pain"* OR "ache"*)) NOT ("child"*))');
    expect(mysqlBoolean(q)).toBe('+(+chest* +"blood pressure" +(pain* ache*) -child*)');
    expect(fts5(parseQuery('x'))).toBe('"x"*');
    expect(mysqlBoolean(parseQuery('x'))).toBe('+x*');
  });

  test('what the engines are given has only letters, digits and the operators', () => {
    const q = parseQuery('a*b "c:d" e\'f NEAR(x) {col}:y ^z');
    for (const s of [fts5(q), mysqlBoolean(q)]) {
      expect(s).not.toMatch(/[:'{}^]/);
    }
  });

  test('values that can\'t be searched', () => {
    for (const v of ['', '   ', '"unclosed', '-alone', 'NOT x', '(a', 'a)', 'a OR', '***', 'a OR -b', 'x'.repeat(1001), Array(40).fill('w').join(' ')]) {
      expect(() => parseQuery(v)).toThrow();
    }
  });
});

describe.each(engines())('full-text search (%s)', (engine) => {
  let t;
  const ids = {};
  const post = async (r) => {
    const res = await request(t.app).post(`/r4/${r.resourceType}`).set('Content-Type', FHIR_JSON).send(body(r));
    expect(res.status).toBe(201);
    return res.body.id;
  };
  const found = async (url, status = 200) => {
    const r = await request(t.app).get(url);
    expect(r.status).toBe(status);
    return (r.body.entry || []).filter(e => e.search && e.search.mode === 'match').map(e => e.resource.id).sort();
  };
  const div = (s) => ({ status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">${s}</div>` });

  beforeAll(async () => {
    t = await makeApp(engine);
    ids.p1 = await post({ resourceType: 'Patient', text: div('<p>Peter James <b>Chalmers</b>, seen for chest pain</p>'), name: [{ family: 'Chalmers', given: ['Peter'] }],
      identifier: [{ system: 'urn:mrn', value: 'MRN12345' }] });
    ids.p2 = await post({ resourceType: 'Patient', text: div('<p>Anna Müller: blood pressure check</p>'), name: [{ family: 'Müller', given: ['Anna'] }],
      telecom: [{ system: 'email', value: 'anna@example.org' }] });
    ids.p3 = await post({ resourceType: 'Patient', text: div('<p>Child, chest infection</p>'), name: [{ family: 'Smith' }], photo: [{ contentType: 'text/plain', data: Buffer.from('hidden-in-base64').toString('base64') }] });
    ids.o1 = await post({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Blood pressure panel' }] },
      subject: { reference: `Patient/${ids.p2}` }, text: div('<p>Systolic 140</p>') });
  });
  afterAll(async () => {
    await t.close();
  });

  test('_text: words in the narrative, as prefixes, accents and case folded', async () => {
    expect(await found('/r4/Patient?_text=chalmers')).toEqual([ids.p1]);
    expect(await found('/r4/Patient?_text=CHALM')).toEqual([ids.p1]);
    expect(await found('/r4/Patient?_text=muller')).toEqual([ids.p2]);
    expect(await found('/r4/Patient?_text=Müller')).toEqual([ids.p2]);
    expect(await found('/r4/Patient?_text=chest')).toEqual([ids.p1, ids.p3].sort());
  });

  test('_text: AND (implied), OR, NOT, phrases, brackets', async () => {
    expect(await found('/r4/Patient?_text=' + encodeURIComponent('chest pain'))).toEqual([ids.p1]);
    expect(await found('/r4/Patient?_text=' + encodeURIComponent('chest AND infection'))).toEqual([ids.p3]);
    expect(await found('/r4/Patient?_text=' + encodeURIComponent('pain OR pressure'))).toEqual([ids.p1, ids.p2].sort());
    expect(await found('/r4/Patient?_text=' + encodeURIComponent('chest -child'))).toEqual([ids.p1]);
    expect(await found('/r4/Patient?_text=' + encodeURIComponent('chest NOT child'))).toEqual([ids.p1]);
    expect(await found('/r4/Patient?_text=' + encodeURIComponent('"blood pressure"'))).toEqual([ids.p2]);
    expect(await found('/r4/Patient?_text=' + encodeURIComponent('"pressure blood"'))).toEqual([]);
    expect(await found('/r4/Patient?_text=' + encodeURIComponent('(pain OR infection) chest'))).toEqual([ids.p1, ids.p3].sort());
  });

  test('_content: anywhere in the resource, but not element names or base64 data', async () => {
    expect(await found('/r4/Patient?_content=mrn12345')).toEqual([ids.p1]);
    expect(await found('/r4/Patient?_content=' + encodeURIComponent('anna@example.org'))).toEqual([ids.p2]);
    expect(await found('/r4/Observation?_content=panel')).toEqual([ids.o1]);
    // the narrative's words are content too
    expect(await found('/r4/Observation?_content=systolic')).toEqual([ids.o1]);
    // but _text is only the narrative
    expect(await found('/r4/Observation?_text=panel')).toEqual([]);
    expect(await found('/r4/Patient?_content=family')).toEqual([]);
    expect(await found('/r4/Patient?_content=hidden')).toEqual([]);
  });

  test('with other parameters, through a chain, and across types', async () => {
    expect(await found('/r4/Patient?_text=chest&family=smith')).toEqual([ids.p3]);
    expect(await found('/r4/Observation?subject._text=pressure')).toEqual([ids.o1]);
    const all = await request(t.app).get('/r4?_type=Patient,Observation&_content=pressure');
    expect(all.body.total).toBe(2);
  });

  test('in _filter: eq or co, ne, combined with anything else, and in chains', async () => {
    const f = (x) => '/r4/Patient?_filter=' + encodeURIComponent(x);
    expect(await found(f('_text co chest'))).toEqual([ids.p1, ids.p3].sort());
    expect(await found(f('_text eq chest'))).toEqual([ids.p1, ids.p3].sort());
    expect(await found(f('_text co "chest -child"'))).toEqual([ids.p1]);
    expect(await found(f('_text co "\\"blood pressure\\""'))).toEqual([ids.p2]);
    expect(await found(f('_text co "\\"pressure blood\\""'))).toEqual([]);
    expect(await found(f('_text ne chest'))).toEqual([ids.p2]);
    expect(await found(f('_text co chest and family eq smith'))).toEqual([ids.p3]);
    expect(await found(f('_text co pain or _content co mrn12345 or _content co "anna@example.org"'))).toEqual([ids.p1, ids.p2].sort());
    expect(await found(f('not (_content co anna)'))).toEqual([ids.p1, ids.p3].sort());
    expect(await found('/r4/Observation?_filter=' + encodeURIComponent('subject._text co pressure'))).toEqual([ids.o1]);
    expect(await found('/r4/Observation?_filter=' + encodeURIComponent('subject[_content co anna]._text co blood'))).toEqual([ids.o1]);
    await found(f('_text sw chest'), 400);
    await found(f('_text co "\\"unclosed"'), 400);
  });

  test('the index follows the resource: updates and deletes', async () => {
    const id = await post({ resourceType: 'Patient', text: div('<p>Zebrafish</p>') });
    expect(await found('/r4/Patient?_text=zebrafish')).toEqual([id]);
    await request(t.app).put(`/r4/Patient/${id}`).set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Patient', id, text: div('<p>Aardvark</p>') }));
    expect(await found('/r4/Patient?_text=zebrafish')).toEqual([]);
    expect(await found('/r4/Patient?_text=aardvark')).toEqual([id]);
    await request(t.app).delete(`/r4/Patient/${id}`);
    expect(await found('/r4/Patient?_text=aardvark')).toEqual([]);
    expect(await invariants(t.ep)).toEqual([]);
  });

  test('a transaction that fails leaves no text behind', async () => {
    const r = await request(t.app).post('/r4').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Bundle', type: 'transaction', entry: [
      { resource: { resourceType: 'Patient', text: div('<p>Quokka</p>') }, request: { method: 'POST', url: 'Patient' } },
      { resource: { resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: 'Patient/nobody' } }, request: { method: 'POST', url: 'Observation' } }
    ] }));
    expect(r.status).toBe(422);
    expect(await found('/r4/Patient?_text=quokka')).toEqual([]);
    expect(await invariants(t.ep)).toEqual([]);
  });

  test('bad values are refused', async () => {
    await found('/r4/Patient?_text=' + encodeURIComponent('"unclosed'), 400);
    await found('/r4/Patient?_text=' + encodeURIComponent('-only'), 400);
    await found('/r4/Patient?_text:exact=x', 200);
    const strict = await request(t.app).get('/r4/Patient?_text:exact=x').set('Prefer', 'handling=strict');
    expect(strict.status).toBe(400);
  });

  test('in the CapabilityStatement', async () => {
    const cs = (await request(t.app).get('/r4/metadata')).body;
    const names = cs.rest[0].searchParam.map(p => p.name);
    expect(names).toContain('_text');
    expect(names).toContain('_content');
  });
});

describe.each(engines())('full-text: a version 1 database is brought up to date (%s)', (engine) => {
  test('the table is made, and what was there is reindexed in the background', async () => {
    let t = await makeApp(engine);
    const r = await request(t.app).post('/r4/Patient').set('Content-Type', FHIR_JSON)
      .send(body({ resourceType: 'Patient', text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">Platypus</div>' } }));
    const id = r.body.id;
    // back to version 1: no full-text table (nor the Contained table of version 3)
    await t.ep.db.write(async (q) => {
      await q.exec('DROP TABLE TextIndex');
      await q.exec('DROP TABLE Contained');
      await q.run('UPDATE Config SET Value = ? WHERE Name = ?', ['1', 'schemaVersion']);
    });
    await t.mod.shutdown();
    t = await makeApp(engine, { dir: t.dir, keep: true });
    try {
      const v = await t.ep.db.read(q => q.get('SELECT Value FROM Config WHERE Name = ?', ['schemaVersion']));
      expect(v.Value).toBe(String(SCHEMA_VERSION));
      expect(t.ep.reindexAll).toBe(true);
      // not indexed yet: found nothing, and says why
      const before = await request(t.app).get('/r4/Patient?_text=platypus');
      expect(before.body.total).toBe(0);
      expect(before.body.entry.some(e => e.search.mode === 'outcome' && /still being built/.test(JSON.stringify(e.resource)))).toBe(true);
      while (await t.ep.reindexBatch() > 0) {
        // the next batch
      }
      expect(t.ep.reindexAll).toBe(false);
      const after = await request(t.app).get('/r4/Patient?_text=platypus');
      expect(after.body.entry.map(e => e.resource.id)).toEqual([id]);
      expect(await t.ep.db.read(q => q.get('SELECT Value FROM Config WHERE Name = ?', ['reindexAll']))).toBeFalsy();
    } finally {
      await t.close();
    }
  });
});
