//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * library/sql behaviour the shared SQL on FHIR suite does not exercise: reference resolution
 * relative to the resource being processed (contained, Bundle-local), the keys that go with it,
 * trickle mode, the repeat guards, asynchronous functions, and the SQLite and CSV storages.
 */

const Database = require('better-sqlite3');
const r4 = require('fhirpath/fhir-context/r4');
const {
  Runner, MemoryProvider, JsonStorage, SqliteStorage, CsvStorage, ViewDefinitionError, prepareView
} = require('../../../library/sql');

function view(resource, columns, extra = {}) {
  return { resourceType: 'ViewDefinition', name: 't', status: 'active', resource, select: [{ column: columns }], ...extra };
}

async function rows(provider, vd, options = {}) {
  const storage = new JsonStorage();
  await new Runner({ model: r4, provider, storage, ...options }).execute(vd);
  return storage.rows;
}

describe('library/sql reference resolution', () => {
  test('getReferenceKey() resolves a contained reference inside the resource being processed', async () => {
    const provider = new MemoryProvider().add({
      resourceType: 'Observation', id: 'o1', status: 'final', code: { text: 'x' },
      contained: [{ resourceType: 'Patient', id: 'p1' }],
      subject: { reference: '#p1' }
    });
    const result = await rows(provider, view('Observation', [
      { name: 'any', path: 'subject.getReferenceKey()' },
      { name: 'pat', path: 'subject.getReferenceKey(Patient)' },
      { name: 'grp', path: 'subject.getReferenceKey(Group)' }
    ]));
    // the key includes the container, so another resource's #p1 is a different key
    expect(result).toEqual([{ any: 'Observation/o1#p1', pat: 'Observation/o1#p1', grp: null }]);
  });

  test('a contained resource has the same key from getResourceKey() as from a reference to it', async () => {
    const provider = new MemoryProvider().add({
      resourceType: 'Observation', id: 'o1', status: 'final', code: { text: 'x' },
      contained: [{ resourceType: 'Patient', id: 'p1' }],
      subject: { reference: '#p1' }
    });
    const vd = view('Observation', [{ name: 'ref', path: 'subject.getReferenceKey()' }]);
    vd.select.push({ forEach: 'contained', column: [{ name: 'own', path: 'getResourceKey()' }] });
    const result = await rows(provider, vd);
    expect(result).toEqual([{ ref: 'Observation/o1#p1', own: 'Observation/o1#p1' }]);
  });

  test('references in a document resolve inside its Bundle (urn:uuid and RESTful fullUrls)', async () => {
    const bundle = {
      resourceType: 'Bundle', id: 'doc', type: 'document',
      entry: [
        { fullUrl: 'urn:uuid:aaa', resource: { resourceType: 'Patient', id: 'pa' } },
        { fullUrl: 'urn:uuid:bbb', resource: { resourceType: 'Condition', id: 'c1', subject: { reference: 'urn:uuid:aaa' } } },
        { fullUrl: 'http://example.org/fhir/Patient/pb', resource: { resourceType: 'Patient', id: 'pb' } },
        { fullUrl: 'http://example.org/fhir/Condition/c2', resource: { resourceType: 'Condition', id: 'c2', subject: { reference: 'Patient/pb' } } }
      ]
    };
    const provider = new MemoryProvider({ synthesizeMissing: false }).addBundle(bundle);
    const result = await rows(provider, view('Condition', [
      { name: 'id', path: 'id' },
      { name: 'patient', path: 'subject.getReferenceKey(Patient)' }
    ]));
    expect(result).toEqual([{ id: 'c1', patient: 'Patient/pa' }, { id: 'c2', patient: 'Patient/pb' }]);
  });

  test('an unresolved reference has no key when the provider does not make stubs', async () => {
    const provider = new MemoryProvider({ synthesizeMissing: false })
      .add({ resourceType: 'Condition', id: 'c1', subject: { reference: 'Patient/missing' } });
    const result = await rows(provider, view('Condition', [{ name: 'patient', path: 'subject.getReferenceKey()' }]));
    expect(result).toEqual([{ patient: null }]);
  });

  test('a provider can resolve references asynchronously', async () => {
    const patient = { resourceType: 'Patient', id: 'p9' };
    const provider = {
      fetch: () => [{ resourceType: 'Condition', id: 'c1', subject: { reference: 'Patient/p9' } }],
      resolveReference: async (root, ref) => (ref === 'Patient/p9' ? patient : null)
    };
    const result = await rows(provider, view('Condition', [{ name: 'patient', path: 'subject.getReferenceKey()' }]), { async: true });
    expect(result).toEqual([{ patient: 'Patient/p9' }]);
  });

  test('storages can supply their own keys', async () => {
    const provider = new MemoryProvider().add({ resourceType: 'Patient', id: 'p1' });
    const storage = new JsonStorage({ keyFor: (res) => `key-${res.id}` });
    await new Runner({ model: r4, provider, storage }).execute(view('Patient', [{ name: 'k', path: 'getResourceKey()' }]));
    expect(storage.rows).toEqual([{ k: 'key-p1' }]);
  });
});

describe('library/sql runner', () => {
  test('trickle mode ignores resources of another type', async () => {
    const storage = new JsonStorage();
    const runner = new Runner({ model: r4, storage });
    const wc = runner.prepare(view('Patient', [{ name: 'id', path: 'id' }, { name: 'g', path: 'gender' }]));
    await runner.processResource(wc, { resourceType: 'Observation', id: 'o1', status: 'final', code: { text: 'x' } });
    await runner.processResource(wc, { resourceType: 'Patient', id: 'p1', gender: 'male' });
    await runner.finish(wc);
    expect(storage.rows).toEqual([{ id: 'p1', g: 'male' }]);
  });

  test('a cyclical repeat stops at the depth limit', async () => {
    const provider = new MemoryProvider().add({ resourceType: 'Questionnaire', id: 'q', status: 'active', item: [{ linkId: '1', type: 'group' }] });
    const vd = view('Questionnaire', [{ name: 'id', path: 'id' }]);
    vd.select = [{ repeat: ['$this'], column: [{ name: 'id', path: 'id' }] }];
    await expect(rows(provider, vd)).rejects.toThrow(/maximum nesting depth/);
  });

  test('a repeat stops at the node limit', async () => {
    const item = (n) => (n === 0 ? { linkId: 'leaf', type: 'display' } : { linkId: 'g' + n, type: 'group', item: [item(n - 1), item(n - 1)] });
    const provider = new MemoryProvider().add({ resourceType: 'Questionnaire', id: 'q', status: 'active', item: [item(8)] });
    const vd = view('Questionnaire', []);
    vd.select = [{ repeat: ['item'], column: [{ name: 'link', path: 'linkId' }] }];
    await expect(rows(provider, vd, { maxRepeatNodes: 50 })).rejects.toThrow(/more than 50 nodes/);
  });

  test('repeat walks nested items', async () => {
    const provider = new MemoryProvider().add({
      resourceType: 'Questionnaire', id: 'q', status: 'active',
      item: [{ linkId: '1', type: 'group', item: [{ linkId: '1.1', type: 'string' }] }, { linkId: '2', type: 'string' }]
    });
    const vd = view('Questionnaire', []);
    vd.select = [{ repeat: ['item'], column: [{ name: 'link', path: 'linkId' }] }];
    expect((await rows(provider, vd)).map(r => r.link)).toEqual(['1', '1.1', '2']);
  });

  test('a where path that is not boolean is an error', async () => {
    const provider = new MemoryProvider().add({ resourceType: 'Patient', id: 'p1', name: [{ family: 'F' }] });
    await expect(rows(provider, view('Patient', [{ name: 'id', path: 'id' }], { where: [{ path: 'name.family' }] })))
      .rejects.toThrow(/must return a boolean/);
  });

  test('extra functions can be passed in, and may be asynchronous', async () => {
    const provider = new MemoryProvider().add({ resourceType: 'Patient', id: 'p1' });
    const userInvocationTable = { shout: { fn: async (inputs) => inputs.map(s => String(s).toUpperCase()), arity: { 0: [] } } };
    const result = await rows(provider, view('Patient', [{ name: 'id', path: 'id.shout()' }]), { userInvocationTable, async: true });
    expect(result).toEqual([{ id: 'P1' }]);
  });

  test('a view that cannot run lists its problems', () => {
    const runner = new Runner({ model: r4, storage: new JsonStorage() });
    let error = null;
    try {
      runner.prepare({ resource: 'Nonsense', select: [] });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ViewDefinitionError);
    expect(error.issues.map(i => i.message)).toContain("The resource 'Nonsense' is not a valid resource type");
  });
});

describe('library/sql storages', () => {
  const patients = () => new MemoryProvider()
    .add({ resourceType: 'Patient', id: 'p1', active: true, birthDate: '1970-01-02', name: [{ given: ['A', 'B'], family: 'F, "G"' }] })
    .add({ resourceType: 'Patient', id: 'p2', active: false });
  const columns = [
    { name: 'id', path: 'id', type: 'id' },
    { name: 'active', path: 'active', type: 'boolean' },
    { name: 'born', path: 'birthDate', type: 'date' },
    { name: 'given', path: 'name.given', type: 'string', collection: true },
    { name: 'family', path: 'name.family', type: 'string' },
    { name: 'name', path: 'name.first()' }
  ];

  // An empty collection is [] in JSON, but NULL in SQLite and an empty field in CSV
  test('SQLite gets a table named after the view, with typed columns', async () => {
    const db = new Database(':memory:');
    try {
      await new Runner({ model: r4, provider: patients(), storage: new SqliteStorage(db) }).execute(view('Patient', columns, { name: 'patients' }));
      const cols = db.prepare('PRAGMA table_info(patients)').all().map(c => `${c.name}:${c.type}`);
      expect(cols).toEqual(['ViewRowKey:INTEGER', 'id:TEXT', 'active:INTEGER', 'born:TEXT', 'given:TEXT', 'family:TEXT', 'name:']);
      expect(db.prepare('SELECT * FROM patients ORDER BY ViewRowKey').all()).toEqual([
        { ViewRowKey: 1, id: 'p1', active: 1, born: '1970-01-02', given: '["A","B"]', family: 'F, "G"', name: '{"given":["A","B"],"family":"F, \\"G\\""}' },
        { ViewRowKey: 2, id: 'p2', active: 0, born: null, given: null, family: null, name: null }
      ]);
    } finally {
      db.close();
    }
  });

  test('SQLite needs the view to have a name', () => {
    const db = new Database(':memory:');
    try {
      const vd = view('Patient', columns);
      delete vd.name;
      expect(() => new Runner({ model: r4, storage: new SqliteStorage(db) }).prepare(vd)).toThrow(/No name provided/);
    } finally {
      db.close();
    }
  });

  test('SQLite rolls the rows back when the run fails', async () => {
    const db = new Database(':memory:');
    try {
      const provider = new MemoryProvider()
        .add({ resourceType: 'Patient', id: 'p1', name: [{ family: 'A' }] })
        .add({ resourceType: 'Patient', id: 'p2', name: [{ family: 'B' }, { family: 'C' }] });
      const vd = view('Patient', [{ name: 'family', path: 'name.family' }], { name: 'fails' });
      await expect(new Runner({ model: r4, provider, storage: new SqliteStorage(db) }).execute(vd)).rejects.toThrow(/not allowed multiple values/);
      expect(db.prepare('SELECT count(*) n FROM fails').get().n).toBe(0);
    } finally {
      db.close();
    }
  });

  test('SQLite can add rows to an existing table, with fixed columns set per run', async () => {
    const db = new Database(':memory:');
    try {
      const vd = view('Patient', [{ name: 'id', path: 'id', type: 'id' }], { name: 'pats' });
      const fixedColumns = [{ name: '_doc', type: 'INTEGER' }];
      db.exec(SqliteStorage.createTableSql('pats', prepareView(vd, { model: r4 }).columns, fixedColumns));
      for (const [doc, id] of [[1, 'a'], [2, 'b']]) {
        const storage = new SqliteStorage(db, { create: false, fixedColumns });
        storage.fixedValues._doc = doc;
        await new Runner({ model: r4, provider: new MemoryProvider().add({ resourceType: 'Patient', id }), storage }).execute(vd);
      }
      expect(db.prepare('SELECT * FROM pats ORDER BY ViewRowKey').all()).toEqual([
        { ViewRowKey: 1, _doc: 1, id: 'a' }, { ViewRowKey: 2, _doc: 2, id: 'b' }
      ]);
    } finally {
      db.close();
    }
  });

  test('CSV quotes what needs quoting', async () => {
    const storage = new CsvStorage({ eol: '\n' });
    await new Runner({ model: r4, provider: patients(), storage }).execute(view('Patient', columns));
    expect(storage.text).toBe('id,active,born,given,family,name\n' +
      'p1,true,1970-01-02,"[""A"",""B""]","F, ""G""","{""given"":[""A"",""B""],""family"":""F, \\""G\\""""}"\n' +
      'p2,false,,,,\n');
  });
});
