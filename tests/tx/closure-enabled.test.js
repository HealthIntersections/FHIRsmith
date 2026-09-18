/**
 * $closure with closure turned on (modules.tx.closure.enabled).
 *
 * The main sequence mirrors the tx-ecosystem 'closure' suite: a table over the simple
 * test code system, built one concept at a time, then resynchronised. Around it: the
 * initialise / reset rules, the error cases, the R4 form of the response, persistence
 * across a restart, and the per-table lock.
 */

const express = require('express');
const cors = require('cors');
const os = require('os');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const TXModule = require('../../tx/tx');
const { ClosureStore } = require('../../tx/closure/closure-store');

const LIBRARY = path.join(__dirname, 'fixtures', 'test-library.yaml');
const R5 = '/tx/r5';
const R4 = '/tx/r4';
const SYS = 'http://hl7.org/fhir/test/CodeSystem/simple';
const NARROWER = 'source-is-narrower-than-target';

// the simple test code system: code2 > code2a > (code2aI, code2aII); code2 > code2b; code1, code3
const SIMPLE = {
  resourceType: 'CodeSystem', id: 'simple', url: SYS, version: '0.1.0', name: 'Simple', status: 'active',
  caseSensitive: true, hierarchyMeaning: 'is-a', content: 'complete',
  concept: [
    { code: 'code1', display: 'Display 1' },
    { code: 'code2', display: 'Display 2', concept: [
      { code: 'code2a', display: 'Display 2a', concept: [
        { code: 'code2aI', display: 'Display 2aI' },
        { code: 'code2aII', display: 'Display 2aII' }
      ] },
      { code: 'code2b', display: 'Display 2b' }
    ] },
    { code: 'code3', display: 'Display 3' }
  ]
};

async function startApp(closure, endpoints = [{ path: R5, fhirVersion: '5.0', context: null }]) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  const txModule = new TXModule();
  await txModule.initialize({ librarySource: LIBRARY, endpoints, closure }, app);
  return { app, txModule };
}

const params = (...parameter) => ({ resourceType: 'Parameters', parameter });
const name = n => ({ name: 'name', valueString: n });
const concept = code => ({ name: 'concept', valueCoding: { system: SYS, code } });
const reset = { name: 'reset', valueBoolean: true };
const txResource = { name: 'tx-resource', resource: SIMPLE };

function post(app, body, base = R5) {
  // application/json: the test app parses that itself (server.js hands fhir+json to the
  // tx router as a raw buffer, which this minimal app does not)
  return request(app).post(`${base}/$closure`)
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/fhir+json')
    .send(body);
}

// the entries of a closure ConceptMap, as "source>target:relationship", sorted
function entries(cm) {
  const out = [];
  for (const g of cm.group || []) {
    for (const e of g.element || []) {
      for (const t of e.target || []) {
        out.push(`${e.code}>${t.code}:${t.relationship || t.equivalence}`);
      }
    }
  }
  return out.sort();
}
const n = (s, t) => `${s}>${t}:${NARROWER}`;
const issueText = res => (((res.body.issue || [])[0] || {}).details || {}).text || '';
const issueType = res => ((((res.body.issue || [])[0] || {}).details || {}).coding || []).map(c => c.code);

describe('$closure (enabled)', () => {
  let app, txModule, dir;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-'));
    ({ app, txModule } = await startApp({ enabled: true, database: path.join(dir, 'closure.db'), maxConceptsPerTable: 20 },
      [{ path: R5, fhirVersion: '5.0', context: null }, { path: R4, fhirVersion: '4.0', context: null }]));
  }, 240000);

  afterAll(async () => {
    await txModule.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('advertising', () => {
    test('CapabilityStatement lists $closure at system level only', async () => {
      const res = await request(app).get(`${R5}/metadata`).set('Accept', 'application/fhir+json');
      const rest = res.body.rest[0];
      expect(rest.operation.map(o => o.name)).toContain('closure');
      for (const r of rest.resource || []) {
        expect((r.operation || []).map(o => o.name)).not.toContain('closure');
      }
    });

    test('TerminologyCapabilities says closure is supported, within a code system', async () => {
      const res = await request(app).get(`${R5}/metadata`).query({ mode: 'terminology' }).set('Accept', 'application/fhir+json');
      expect(res.body.closure).toEqual({ translation: false });
    });
  });

  // the same steps, and the same expectations, as the tx-ecosystem closure suite
  describe('building a table one concept at a time', () => {
    const T = '55e02fcb-d7a6-46db-94b4-3c3a4b619f7c';
    const steps = [
      ['init (reset), supplying the code system', params(name(T), reset, txResource), '0', []],
      ['code2a: nothing to relate to', params(name(T), concept('code2a')), '1', []],
      ['code2aI: child of code2a', params(name(T), concept('code2aI')), '2', [n('code2aI', 'code2a')]],
      ['code2: ancestor of both, one transitively', params(name(T), concept('code2')), '3', [n('code2a', 'code2'), n('code2aI', 'code2')]],
      ['code1: unrelated', params(name(T), concept('code1')), '4', []],
      ['code2aII: below two', params(name(T), concept('code2aII')), '5', [n('code2aII', 'code2'), n('code2aII', 'code2a')]],
      ['code2aI again: no change, version stays', params(name(T), concept('code2aI')), '5', []],
      ['code2b: sibling', params(name(T), concept('code2b')), '6', [n('code2b', 'code2')]],
      ['resync from 2', params(name(T), { name: 'version', valueString: '2' }), '6',
        [n('code2a', 'code2'), n('code2aI', 'code2'), n('code2aII', 'code2'), n('code2aII', 'code2a'), n('code2b', 'code2')]],
      ['resync from 0: the whole table', params(name(T), { name: 'version', valueString: '0' }), '6',
        [n('code2a', 'code2'), n('code2aI', 'code2'), n('code2aI', 'code2a'), n('code2aII', 'code2'), n('code2aII', 'code2a'), n('code2b', 'code2')]]
    ];
    for (const [label, body, version, expected] of steps) {
      test(label, async () => {
        const res = await post(app, body);
        expect(res.status).toBe(200);
        expect(res.body.resourceType).toBe('ConceptMap');
        expect(res.body.version).toBe(version);
        expect(entries(res.body)).toEqual(expected.slice().sort());
        if (expected.length === 0) {
          expect(res.body.group).toBeUndefined();
        } else {
          expect(res.body.group).toHaveLength(1);
          expect(res.body.group[0].source).toBe(SYS);
          expect(res.body.group[0].target).toBe(SYS);
        }
      });
    }

    test('the response is sorted by source code, then target code', async () => {
      const res = await post(app, params(name(T), { name: 'version', valueString: '0' }));
      const codes = res.body.group[0].element.map(e => e.code);
      expect(codes).toEqual(codes.slice().sort());
      for (const e of res.body.group[0].element) {
        const t = e.target.map(x => x.code);
        expect(t).toEqual(t.slice().sort());
      }
    });

    test('the table is shared across FHIR versions, and R4 is told "subsumes"', async () => {
      const res = await post(app, params(name(T), concept('code3')), R4);
      expect(res.status).toBe(200);
      expect(res.body.version).toBe('7');
      const again = await post(app, params(name(T), { name: 'version', valueString: '5' }), R4);
      expect(again.body.group[0].element[0].code).toBe('code2b');
      const target = again.body.group[0].element[0].target[0];
      expect(target.code).toBe('code2');
      expect(target.equivalence).toBe('subsumes');
      expect(target.relationship).toBeUndefined();
    });

    test('R5 is not given an R4 equivalence', async () => {
      const res = await post(app, params(name(T), { name: 'version', valueString: '0' }));
      for (const e of res.body.group[0].element) {
        for (const t of e.target) {
          expect(t.equivalence).toBeUndefined();
        }
      }
    });
  });

  describe('initialising', () => {
    test('initialising a table that exists is an error', async () => {
      await post(app, params(name('dup-table'), txResource));
      const res = await post(app, params(name('dup-table'), txResource));
      expect(res.status).toBe(409);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(issueText(res)).toMatch(/already exists/);
    });

    test('reset = true discards what the table held', async () => {
      await post(app, params(name('reset-table'), txResource));
      await post(app, params(name('reset-table'), concept('code2')));
      await post(app, params(name('reset-table'), concept('code2a')));
      const res = await post(app, params(name('reset-table'), reset, txResource));
      expect(res.status).toBe(200);
      expect(res.body.version).toBe('0');
      const resync = await post(app, params(name('reset-table'), { name: 'version', valueString: '0' }));
      expect(entries(resync.body)).toEqual([]);
    });

    test('reset = true on a table that does not exist creates it', async () => {
      const res = await post(app, params(name('fresh-reset'), reset, txResource));
      expect(res.status).toBe(200);
      expect(res.body.version).toBe('0');
    });

    test('a name is required', async () => {
      const res = await post(app, params(txResource));
      expect(res.status).toBe(400);
      expect(issueType(res)).toContain('invalid-data');
    });

    test('a name may not contain white space', async () => {
      const res = await post(app, params(name('has space'), txResource));
      expect(res.status).toBe(400);
      expect(issueText(res)).toMatch(/not valid/);
    });

    test('a name may not be longer than 64 characters', async () => {
      const res = await post(app, params(name('x'.repeat(65)), txResource));
      expect(res.status).toBe(400);
    });
  });

  describe('errors', () => {
    beforeAll(async () => {
      await post(app, params(name('err-table'), reset, txResource));
      await post(app, params(name('err-table'), concept('code2')));
    });

    test('adding to a table that does not exist', async () => {
      const res = await post(app, params(name('no-such-table'), concept('code2')));
      expect(res.status).toBe(404);
      expect(issueType(res)).toContain('not-found');
    });

    test('configuration can only be given when the table is initialised', async () => {
      const res = await post(app, params(name('err-table'), concept('code2a'), txResource));
      expect(res.status).toBe(400);
      expect(issueText(res)).toMatch(/initialised/);
    });

    test('an unknown code fails the whole request, and stores nothing', async () => {
      const res = await post(app, params(name('err-table'), concept('code2a'), concept('nope')));
      expect(res.status).toBe(404);
      expect(issueType(res)).toContain('invalid-code');
      const after = await post(app, params(name('err-table'), { name: 'version', valueString: '0' }));
      expect(after.body.version).toBe('1');
      expect(entries(after.body)).toEqual([]);
    });

    test('an unknown code system', async () => {
      const res = await post(app, params(name('err-table'),
        { name: 'concept', valueCoding: { system: 'http://example.org/unknown', code: 'x' } }));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.resourceType).toBe('OperationOutcome');
    });

    test('concepts and version together', async () => {
      const res = await post(app, params(name('err-table'), concept('code2a'), { name: 'version', valueString: '0' }));
      expect(res.status).toBe(400);
    });

    test('a version the table has not reached', async () => {
      const res = await post(app, params(name('err-table'), { name: 'version', valueString: '99' }));
      expect(res.status).toBe(400);
      expect(issueText(res)).toMatch(/current version, 1/);
    });

    test('a parameter closure does not know', async () => {
      const res = await post(app, params(name('err-table'), { name: 'activeOnly', valueBoolean: true }));
      expect(res.status).toBe(400);
    });

    test('GET is not allowed - closure changes state', async () => {
      const res = await request(app).get(`${R5}/$closure`).query({ name: 'err-table' }).set('Accept', 'application/fhir+json');
      expect(res.status).toBe(405);
      expect(res.body.resourceType).toBe('OperationOutcome');
    });

    test('the table size limit', async () => {
      await post(app, params(name('big-table'), reset, txResource));
      const codes = ['code1', 'code2', 'code2a', 'code2aI', 'code2aII', 'code2b', 'code3'];
      const res = await post(app, params(name('big-table'), ...codes.map(concept)));
      expect(res.status).toBe(200); // 7 is under the limit of 20
      expect(res.body.version).toBe('1');
    });

    test('an X-Cache-Id header is ignored', async () => {
      const res = await post(app, params(name('err-table'), concept('code2b')))
        .set('X-Cache-Id', 'tx9.no-such-cache');
      expect(res.status).toBe(200);
      expect(entries(res.body)).toEqual([n('code2b', 'code2')]);
    });
  });

  describe('table configuration is replayed on every call', () => {
    test('check-system-version given at initialisation applies to later adds', async () => {
      await post(app, params(name('checked'), reset, txResource,
        { name: 'check-system-version', valueCanonical: SYS + '|9.9.9' }));
      const res = await post(app, params(name('checked'), concept('code2')));
      // the version rule is applied as it would be on $validate-code: there is no 9.9.9
      expect(res.status).toBe(422);
      expect(res.body.resourceType).toBe('OperationOutcome');
      expect(issueText(res)).toMatch(/9\.9\.9/);
    });

    test('a matching check-system-version lets adds through', async () => {
      await post(app, params(name('checked-ok'), reset, txResource,
        { name: 'check-system-version', valueCanonical: SYS + '|0.1.0' }));
      const res = await post(app, params(name('checked-ok'), concept('code2')));
      expect(res.status).toBe(200);
      expect(res.body.version).toBe('1');
    });
  });

  describe('several concepts in one request', () => {
    test('they are related to each other as well as to the table', async () => {
      await post(app, params(name('multi'), reset, txResource));
      const res = await post(app, params(name('multi'), concept('code2aI'), concept('code2a'), concept('code2')));
      expect(res.body.version).toBe('1');
      expect(entries(res.body)).toEqual([n('code2a', 'code2'), n('code2aI', 'code2'), n('code2aI', 'code2a')].sort());
    });
  });

  describe('the per-table lock', () => {
    test('concurrent adds to one table each get their own version', async () => {
      await post(app, params(name('race'), reset, txResource));
      const codes = ['code1', 'code2', 'code2a', 'code2aI', 'code2aII', 'code2b'];
      const results = await Promise.all(codes.map(c => post(app, params(name('race'), concept(c)))));
      const versions = results.map(r => r.body.version).sort((a, b) => a - b);
      expect(versions).toEqual(['1', '2', '3', '4', '5', '6']);
      // and between them they reported every entry exactly once
      const all = results.flatMap(r => entries(r.body)).sort();
      const resync = await post(app, params(name('race'), { name: 'version', valueString: '0' }));
      expect(all).toEqual(entries(resync.body));
      expect(all).toHaveLength(6); // code2a>code2, code2aI>(code2a, code2), code2aII>(code2a, code2), code2b>code2
    });
  });
});

describe('$closure configuration', () => {
  test('requireUuidNames rejects a name that is not a UUID', async () => {
    const { app, txModule } = await startApp({ enabled: true, database: ':memory:', requireUuidNames: true });
    try {
      const bad = await post(app, params(name('my-table'), txResource));
      expect(bad.status).toBe(400);
      expect(issueText(bad)).toMatch(/UUID/);
      const good = await post(app, params(name('0b8e6c1e-8b1a-4b53-9a4e-3a4f3ef2d0c7'), txResource));
      expect(good.status).toBe(200);
    } finally {
      await txModule.shutdown();
    }
  }, 120000);

  test('maxTables', async () => {
    const { app, txModule } = await startApp({ enabled: true, database: ':memory:', maxTables: 1 });
    try {
      expect((await post(app, params(name('one'), txResource))).status).toBe(200);
      const res = await post(app, params(name('two'), txResource));
      expect(res.status).toBe(422);
      expect(issueType(res)).toContain('too-costly');
    } finally {
      await txModule.shutdown();
    }
  }, 120000);

  test('maxConceptsPerTable', async () => {
    const { app, txModule } = await startApp({ enabled: true, database: ':memory:', maxConceptsPerTable: 2 });
    try {
      await post(app, params(name('small'), txResource));
      const res = await post(app, params(name('small'), concept('code1'), concept('code2'), concept('code3')));
      expect(res.status).toBe(422);
    } finally {
      await txModule.shutdown();
    }
  }, 120000);

  test('limits: concepts per request, entries per table, stored configuration size', async () => {
    const { app, txModule } = await startApp({ enabled: true, database: ':memory:',
      maxConceptsPerRequest: 2, maxEntriesPerTable: 2, maxConfigSize: 100 });
    try {
      // the simple code system is far more than 100 bytes
      const big = await post(app, params(name('cfg'), txResource));
      expect(big.status).toBe(422);
      expect(issueType(big)).toContain('too-costly');

      const { app: app2, txModule: tx2 } = await startApp({ enabled: true, database: ':memory:',
        maxConceptsPerRequest: 2, maxEntriesPerTable: 2 });
      try {
        await post(app2, params(name('lim'), txResource));
        const many = await post(app2, params(name('lim'), concept('code1'), concept('code2'), concept('code3')));
        expect(many.status).toBe(422);
        // code2 then code2a gives 1 entry, then code2aI would give 2 more: over 2 for the table
        expect((await post(app2, params(name('lim'), concept('code2'), concept('code2a')))).status).toBe(200);
        const over = await post(app2, params(name('lim'), concept('code2aI')));
        expect(over.status).toBe(422);
        // and nothing was stored by the call that failed
        const resync = await post(app2, params(name('lim'), { name: 'version', valueString: '0' }));
        expect(resync.body.version).toBe('1');
        expect(entries(resync.body)).toEqual([n('code2a', 'code2')]);
      } finally {
        await tx2.shutdown();
      }
    } finally {
      await txModule.shutdown();
    }
  }, 120000);

  test('a busy table answers 429, not an ever-growing queue', async () => {
    const { app, txModule } = await startApp({ enabled: true, database: ':memory:', maxQueue: 1 });
    try {
      await post(app, params(name('q'), txResource));
      const store = txModule.closureStore;
      let release;
      const gate = new Promise(r => { release = r; });
      const holder = store.withLock('q', () => gate);
      const res = await post(app, params(name('q'), concept('code1')));
      expect(res.status).toBe(429);
      expect(issueType(res)).toContain('too-costly');
      release();
      await holder;
      expect((await post(app, params(name('q'), concept('code1')))).status).toBe(200);
    } finally {
      await txModule.shutdown();
    }
  }, 120000);

  test('control characters in client text do not reach the log', async () => {
    const { app, txModule } = await startApp({ enabled: true, database: ':memory:' });
    try {
      const res = await post(app, params(name('ok'), { name: 'bad\nFAKE LOG LINE', valueString: 'x' }));
      expect(res.status).toBe(400);
      expect(issueText(res)).not.toMatch(/\n/);
      const nl = await post(app, params(name('bad\u0000name')));
      expect(nl.status).toBe(400);
    } finally {
      await txModule.shutdown();
    }
  }, 120000);

  test('tables survive a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-'));
    const db = path.join(dir, 'closure.db');
    try {
      let s = await startApp({ enabled: true, database: db });
      await post(s.app, params(name('kept'), txResource));
      await post(s.app, params(name('kept'), concept('code2')));
      await s.txModule.shutdown();

      s = await startApp({ enabled: true, database: db });
      // the code system was only sent at initialisation: it has to have been kept too
      const res = await post(s.app, params(name('kept'), concept('code2b')));
      expect(res.status).toBe(200);
      expect(res.body.version).toBe('2');
      expect(entries(res.body)).toEqual([n('code2b', 'code2')]);
      await s.txModule.shutdown();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 240000);
});

describe('ClosureStore', () => {
  let store;
  beforeEach(() => {
    store = new ClosureStore({ database: ':memory:' });
    store.open();
  });
  afterEach(() => store.close());

  test('keeps the table parameters in order, with their types', () => {
    const t = store.createTable('t', [
      { name: 'system-version', valueUri: 'http://a|1' },
      { name: 'useSupplement', valueCanonical: 'http://s' },
      { name: 'tx-resource', resource: { resourceType: 'CodeSystem', url: 'http://a' } }
    ]);
    expect(store.getParams(t.id)).toEqual([
      { name: 'system-version', valueUri: 'http://a|1' },
      { name: 'useSupplement', valueCanonical: 'http://s' },
      { name: 'tx-resource', resource: { resourceType: 'CodeSystem', url: 'http://a' } }
    ]);
  });

  test('recreating a table drops its concepts, entries and parameters', () => {
    let t = store.createTable('t', [{ name: 'useSupplement', valueCanonical: 'http://s' }]);
    store.recordAdd(t, [{ key: 'a', system: 's', code: 'a' }, { key: 'b', system: 's', code: 'b' }],
      [{ source: 'a', target: 'b', relationship: NARROWER }]);
    t = store.createTable('t', []);
    expect(t.version).toBe(0);
    expect(store.getConcepts(t.id)).toEqual([]);
    expect(store.entriesSince(t.id, 0)).toEqual([]);
    expect(store.getParams(t.id)).toEqual([]);
  });

  test('an add with nothing new leaves the version alone', () => {
    const t = store.createTable('t', []);
    expect(store.recordAdd(t, [], [])).toBe(0);
  });

  test('entriesSince filters by the version each entry was added in', () => {
    let t = store.createTable('t', []);
    store.recordAdd(t, [{ key: 'a', system: 's', code: 'a' }, { key: 'b', system: 's', code: 'b' }],
      [{ source: 'a', target: 'b', relationship: NARROWER }]);
    t = store.getTable('t');
    const [a] = store.getConcepts(t.id).filter(c => c.code === 'a');
    store.recordAdd(t, [{ key: 'c', system: 's', code: 'c' }], [{ source: 'c', target: a.id, relationship: NARROWER }]);
    expect(store.entriesSince(t.id, 0).map(e => `${e.source_code}>${e.target_code}`).sort()).toEqual(['a>b', 'c>a']);
    expect(store.entriesSince(t.id, 1).map(e => `${e.source_code}>${e.target_code}`)).toEqual(['c>a']);
  });

  test('withLock runs calls on one table one at a time, in order', async () => {
    const log = [];
    const job = (tag, ms) => store.withLock('t', async () => {
      log.push(tag + '+');
      await new Promise(r => setTimeout(r, ms));
      log.push(tag + '-');
    });
    await Promise.all([job('a', 30), job('b', 5), job('c', 1)]);
    expect(log).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
  });

  test('withLock does not hold up other tables', async () => {
    const log = [];
    const slow = store.withLock('t1', async () => { await new Promise(r => setTimeout(r, 40)); log.push('t1'); });
    const fast = store.withLock('t2', async () => { log.push('t2'); });
    await Promise.all([slow, fast]);
    expect(log).toEqual(['t2', 't1']);
  });

  test('the queue for a table is bounded', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const holder = store.withLock('t', () => gate, { maxQueue: 2 });
    const second = store.withLock('t', async () => 'second', { maxQueue: 2 });
    await expect(store.withLock('t', async () => 'third', { maxQueue: 2 })).rejects.toMatchObject({ closureBusy: 'queue' });
    release();
    await holder;
    await expect(second).resolves.toBe('second');
  });

  test('a waiter that times out never runs, and passes its turn on', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const ran = [];
    const holder = store.withLock('t', () => gate);
    const impatient = store.withLock('t', async () => { ran.push('impatient'); }, { timeoutMs: 20 });
    const patient = store.withLock('t', async () => { ran.push('patient'); });
    await expect(impatient).rejects.toMatchObject({ closureBusy: 'timeout' });
    release();
    await holder;
    await patient;
    expect(ran).toEqual(['patient']);
    expect(store.locks.size).toBe(0);
  });

  test('a waiter whose waitFor throws (client gone) never runs', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const holder = store.withLock('t', () => gate);
    const gone = store.withLock('t', async () => 'ran', { waitFor: p => p.then(() => { throw new Error('gone'); }) });
    release();
    await holder;
    await expect(gone).rejects.toThrow('gone');
    await expect(store.withLock('t', async () => 'next')).resolves.toBe('next');
  });

  test('entriesPage pages through in write order', () => {
    const t = store.createTable('t', []);
    const concepts = [];
    for (let i = 0; i < 7; i++) {
      concepts.push({ key: 'c' + i, system: 's', code: 'c' + i });
    }
    const entries = [];
    for (let i = 1; i < 7; i++) {
      entries.push({ source: 'c' + i, target: 'c0', relationship: NARROWER });
    }
    store.recordAdd(t, concepts, entries);
    const seen = [];
    let after = 0;
    for (;;) {
      const page = store.entriesPage(t.id, 0, after, 4);
      seen.push(...page.map(r => r.source_code));
      if (page.length < 4) break;
      after = page[page.length - 1].rowid;
    }
    expect(seen).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
    expect(store.entryCount(t.id)).toBe(6);
  });

  test('pruneUnused waits for a table in use, and keeps it if that use refreshed it', async () => {
    const t = store.createTable('busy', []);
    store.db.prepare('UPDATE closure_table SET last_used = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', t.id);
    let release;
    const gate = new Promise(r => { release = r; });
    const user = store.withLock('busy', async () => { await gate; store.touch(t.id); });
    const pruning = store.pruneUnused(30);
    release();
    await user;
    expect(await pruning).toEqual([]);
    expect(store.getTable('busy')).not.toBeNull();
  });

  test('a failure inside withLock releases the lock', async () => {
    await expect(store.withLock('t', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(store.withLock('t', async () => 'ok')).resolves.toBe('ok');
  });

  test('pruneUnused drops tables not used within the period', async () => {
    const t = store.createTable('old', []);
    store.createTable('new', []);
    store.db.prepare('UPDATE closure_table SET last_used = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', t.id);
    expect(await store.pruneUnused(30)).toEqual(['old']);
    expect(store.getTable('old')).toBeNull();
    expect(store.getTable('new')).not.toBeNull();
  });
});
