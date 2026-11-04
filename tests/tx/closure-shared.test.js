/**
 * $closure with the tables shared between processes (server.cluster.sharedClosure).
 *
 * One TX module answers $closure; a second ClosureStore on the same file plays the other
 * processes, writing to a table at chosen moments: after the module has read the table and
 * worked out its add, and before it writes. Those are real conflicts on the SQLite file, so
 * this checks the version-checked write and the retry:
 *  - a conflict makes the add work itself out again from the table as it is now, and the
 *    result is what one writer doing the same adds in that order would have got
 *  - a concept another process added meanwhile is not added twice
 *  - when every try conflicts, the call gets 429 CLOSURE_TABLE_BUSY and writes nothing
 *  - a resync reports only up to the version it read
 *  - creating a table checks for an existing one and the table limit in the same
 *    transaction as the insert
 * The same against real processes is tests/server/cluster-shared-closure.test.js.
 */

const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const TXModule = require('../../tx/tx');
const { ClosureStore } = require('../../tx/closure/closure-store');
const ClosureWorker = require('../../tx/workers/closure');

const LIBRARY = path.join(__dirname, 'fixtures', 'test-library.yaml');
const R5 = '/tx/r5';
const SYS = 'http://example.org/closure-shared/cs';
const NARROWER = 'source-is-narrower-than-target';

// r > a > (a1, a2); r > b; and u1..u6, related to nothing
const CS = {
  resourceType: 'CodeSystem', url: SYS, version: '1', status: 'active', content: 'complete', hierarchyMeaning: 'is-a',
  concept: [
    { code: 'r', display: 'R', concept: [
      { code: 'a', display: 'A', concept: [{ code: 'a1', display: 'A1' }, { code: 'a2', display: 'A2' }] },
      { code: 'b', display: 'B' }
    ] },
    ...[1, 2, 3, 4, 5, 6].map(i => ({ code: `u${i}`, display: `U${i}` }))
  ]
};

const params = (...parameter) => ({ resourceType: 'Parameters', parameter });
const name = n => ({ name: 'name', valueString: n });
const concept = code => ({ name: 'concept', valueCoding: { system: SYS, code } });
const init = (n) => params(name(n), { name: 'tx-resource', resource: CS });
const n = (s, t) => `${s}>${t}:${NARROWER}`;

function entries(cm) {
  const out = [];
  for (const g of cm.group || []) {
    for (const e of g.element || []) {
      for (const t of e.target || []) {
        out.push(`${e.code}>${t.code}:${t.relationship}`);
      }
    }
  }
  return out.sort();
}

async function startApp(closure) {
  const app = express();
  app.use(express.json());
  const txModule = new TXModule();
  await txModule.initialize({ librarySource: LIBRARY, endpoints: [{ path: R5, fhirVersion: '5.0', context: null }],
    closure, sharedClosure: true }, app);
  return { app, txModule };
}

const post = (app, body) => request(app).post(`${R5}/$closure`)
  .set('Content-Type', 'application/json').set('Accept', 'application/fhir+json').send(body);

describe('$closure on a shared database', () => {
  let dir, file, app, txModule, other;
  // concepts "another process" writes, with the entries a correct writer would make
  const RELATED = { r: [], a: ['r'], b: ['r'], a1: ['a', 'r'], a2: ['a', 'r'] };

  /** Another process adds a concept to a table (computing its entries as it should). */
  function otherAdds(table, code) {
    const t = other.getTable(table);
    const ids = new Map(other.getConcepts(t.id).map(c => [c.code, c.id]));
    if (ids.has(code)) {
      return t.version;
    }
    const ancestors = (RELATED[code] || []).filter(c => ids.has(c));
    const descendants = Object.entries(RELATED).filter(([c, up]) => up.includes(code) && ids.has(c)).map(([c]) => c);
    const v = other.recordAddChecked(t, [{ key: 'k', system: SYS, code, display: code.toUpperCase() }], [
      ...ancestors.map(up => ({ source: 'k', target: ids.get(up), relationship: NARROWER })),
      ...descendants.map(d => ({ source: ids.get(d), target: 'k', relationship: NARROWER }))
    ]);
    expect(v).toBe(t.version + 1);
    return v;
  }

  /** The next calls of the module's recordAddChecked each run inject() first. */
  function interfere(inject) {
    const store = txModule.closureStore;
    const real = store.recordAddChecked.bind(store);
    let calls = 0;
    store.recordAddChecked = (table, concepts, list) => {
      calls++;
      if (concepts.length > 0) {
        inject(calls, table);
      }
      return real(table, concepts, list);
    };
    return { calls: () => calls, restore: () => { store.recordAddChecked = real; } };
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-shared-'));
    file = path.join(dir, 'closure.db');
    ({ app, txModule } = await startApp({ enabled: true, database: file, writeRetries: 3, maxTables: 8 }));
    other = new ClosureStore({ database: file }, null, { shared: true });
    other.open();
  }, 240000);

  afterAll(async () => {
    other.close();
    await txModule.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the module\'s store is the shared one', () => {
    expect(txModule.closureStore.shared).toBe(true);
    expect(txModule.closureStore.db.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  test('conflicts: the add is worked out again from the table as it is now', async () => {
    const T = 'conflict-1';
    expect((await post(app, init(T))).status).toBe(200);
    expect((await post(app, params(name(T), concept('a')))).body.version).toBe('1');

    // three tries are each beaten by another process's add of an unrelated concept
    const orig = ClosureWorker.prototype.memoSubsumes;
    let hits = 0;
    let misses = 0;
    const subsumes = jest.spyOn(ClosureWorker.prototype, 'memoSubsumes').mockImplementation(async function (memo, nn, o) {
      if (memo.subsumes.has(nn.system + '|' + nn.code + '|' + o.code)) {
        hits++;
      } else {
        misses++;
      }
      return orig.call(this, memo, nn, o);
    });
    const i = interfere((call) => {
      if (call <= 3) {
        otherAdds(T, `u${call}`);
      }
    });
    let res;
    try {
      res = await post(app, params(name(T), concept('a1'), concept('r')));
    } finally {
      i.restore();
    }
    expect(res.status).toBe(200);
    expect(i.calls()).toBe(4);
    // a (1), u1 u2 u3 (2-4), then this add (5)
    expect(res.body.version).toBe('5');
    expect(entries(res.body)).toEqual([n('a', 'r'), n('a1', 'a'), n('a1', 'r')].sort());
    // each pair was tested once, and remembered across the four tries: a1 and r each
    // against a, u1, u2, u3, and r against a1
    subsumes.mockRestore();
    expect(misses).toBe(9);
    expect(hits).toBeGreaterThan(0);

    // the table is what one writer doing the same adds in the same order gets
    const R = 'conflict-1-reference';
    await post(app, init(R));
    for (const code of ['a', 'u1', 'u2', 'u3']) {
      await post(app, params(name(R), concept(code)));
    }
    const ref = await post(app, params(name(R), concept('a1'), concept('r')));
    expect(ref.body.version).toBe('5');
    expect(entries(ref.body)).toEqual(entries(res.body));
    const whole = async (t) => entries((await post(app, params(name(t), { name: 'version', valueString: '0' }))).body);
    expect(await whole(T)).toEqual(await whole(R));
  });

  test('a concept another process added meanwhile is not added twice, and its entries are its own', async () => {
    const T = 'conflict-2';
    await post(app, init(T));
    await post(app, params(name(T), concept('r')));
    const i = interfere((call) => {
      if (call === 1) {
        otherAdds(T, 'b');
      }
    });
    let res;
    try {
      res = await post(app, params(name(T), concept('b'), concept('a2')));
    } finally {
      i.restore();
    }
    expect(res.status).toBe(200);
    expect(i.calls()).toBe(2);
    expect(res.body.version).toBe('3');
    // b>r was the other process's add (version 2); this call added only a2
    expect(entries(res.body)).toEqual([n('a2', 'r')]);
    const db = txModule.closureStore;
    const t = db.getTable(T);
    expect(db.getConcepts(t.id).map(c => c.code).sort()).toEqual(['a2', 'b', 'r']);
    expect(entries((await post(app, params(name(T), { name: 'version', valueString: '0' }))).body))
      .toEqual([n('a2', 'r'), n('b', 'r')]);
    // and each version's changes are the ones its add reported
    expect(entries((await post(app, params(name(T), { name: 'version', valueString: '2' }))).body)).toEqual([n('a2', 'r')]);
  });

  test('when every try conflicts: 429 CLOSURE_TABLE_BUSY after writeRetries, and nothing of the call is written', async () => {
    const T = 'conflict-3';
    await post(app, init(T));
    const i = interfere((call) => otherAdds(T, `u${call}`));
    let res;
    try {
      res = await post(app, params(name(T), concept('a'), concept('a1')));
    } finally {
      i.restore();
    }
    expect(res.status).toBe(429);
    const issue = res.body.issue[0];
    expect(issue.code).toBe('too-costly');
    expect(issue.details.text).toMatch(/busy/i);
    expect(i.calls()).toBe(4); // the first try and writeRetries (3) more
    const db = txModule.closureStore;
    const t = db.getTable(T);
    expect(t.version).toBe(4);
    expect(db.getConcepts(t.id).map(c => c.code).sort()).toEqual(['u1', 'u2', 'u3', 'u4']);
  });

  test('a table dropped by another process before the write: unknown, 404', async () => {
    const T = 'conflict-4';
    await post(app, init(T));
    const i = interfere(() => other.dropTable(T));
    let res;
    try {
      res = await post(app, params(name(T), concept('a')));
    } finally {
      i.restore();
    }
    expect(res.status).toBe(404);
    expect(txModule.closureStore.getTable(T)).toBeNull();
  });

  test('a resync reports only up to the version it read', () => {
    const T = 'bounded';
    const made = other.createTableChecked(T, [], { reset: false, maxTables: Infinity });
    const t = made.table;
    other.recordAdd(t, [{ key: 'r', system: SYS, code: 'r' }], []);
    const t1 = other.getTable(T);
    const rId = other.getConcepts(t1.id)[0].id;
    other.recordAdd(t1, [{ key: 'a', system: SYS, code: 'a' }], [{ source: 'a', target: rId, relationship: NARROWER }]);
    const t2 = other.getTable(T);
    other.recordAdd(t2, [{ key: 'b', system: SYS, code: 'b' }], [{ source: 'b', target: rId, relationship: NARROWER }]);
    // read at version 2, while version 3 has since been written
    expect(other.entriesPage(t.id, 0, 0, 100, 2).map(e => e.source_code)).toEqual(['a']);
    expect(other.entriesPage(t.id, 0, 0, 100, 3).map(e => e.source_code)).toEqual(['a', 'b']);
    expect(other.entriesPage(t.id, 0, 0, 100).map(e => e.source_code)).toEqual(['a', 'b']);
  });

  test('creating: an existing table and the table limit are checked in the write transaction', async () => {
    // another process creates the table between this one's read and its write
    const store = txModule.closureStore;
    const realGet = store.getTable.bind(store);
    store.getTable = (nm) => {
      const t = realGet(nm);
      if (nm === 'raced' && !t) {
        other.createTableChecked('raced', [], { reset: false, maxTables: Infinity });
      }
      return t;
    };
    let res;
    try {
      res = await post(app, init('raced'));
    } finally {
      store.getTable = realGet;
    }
    expect(res.status).toBe(409);

    // the limit (8): fill up to it from "another process", then one more from the module
    const count = store.tableCount();
    for (let k = count; k < 8; k++) {
      expect(other.createTableChecked(`fill-${k}`, [], { reset: false, maxTables: 8 }).table).toBeDefined();
    }
    expect(other.createTableChecked('one-too-many', [], { reset: false, maxTables: 8 })).toEqual({ refused: 'limit' });
    expect((await post(app, init('one-too-many'))).status).toBe(422);
    // a reset of an existing table is not a new table
    expect(other.createTableChecked('fill-7', [], { reset: true, maxTables: 8 }).table).toBeDefined();
    expect(store.tableCount()).toBe(8);
  });
});
