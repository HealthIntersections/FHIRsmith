/**
 * ICD-11's prefetchCodes handle, read by one provider and used by another
 *
 * In a $batch-validate-code the batch builds a provider of its own to call prefetchCodes, and
 * each entry's own provider is passed the handle (tx/cs/cs-api.md, Batches). ICD-11's handle
 * holds rows, recognised by the classification they were read from (the factory's shared
 * state), so any provider that factory builds can use it, and a provider of another factory
 * looks the code up as usual. A small ICD-11 database is built from the importer's schema.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const request = require('supertest');
const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');
const { ICD11ServicesFactory } = require('../../tx/cs/cs-icd11');
const { CodeSystemProvider } = require('../../tx/cs/cs-api');
const { SCHEMA } = require('../../tx/importers/import-icd11');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');

const MMS = 'http://id.who.int/icd/release/11/mms';
const ICF = 'http://id.who.int/icd/release/11/icf';
const VERSION = '2026-01';

// entity id, short code, title
const MMS_CONCEPTS = [
  ['1000', '1A00', 'Cholera'],
  ['1001', '1A01', 'Intestinal infection due to other Vibrio'],
  ['1002', '1A02', 'Intestinal infections due to Shigella'],
  ['1003', '1A03', 'Intestinal infections due to Escherichia coli'],
  ['1004', '1A04', 'Intestinal infections due to Clostridioides difficile'],
];
const ICF_CONCEPTS = [
  ['2000', 'b110', 'Consciousness functions'],
];

function buildDb(file) {
  const db = new Database(file);
  db.exec(SCHEMA);
  db.pragma('journal_mode = DELETE');
  db.prepare("INSERT INTO meta (key, value) VALUES ('languages', 'en')").run();
  const sys = db.prepare('INSERT INTO system (id, code, url, version, title, is_tree, api_root, uri_stem) VALUES (?, ?, ?, ?, ?, 1, ?, ?)');
  const concept = db.prepare(`INSERT INTO concept (id, system, entity_id, uri, code, class_kind, selectable, depth, lft, rgt)
    VALUES (?, ?, ?, ?, ?, 'category', 1, 1, ?, ?)`);
  const title = db.prepare("INSERT INTO designation (concept, lang, kind, value, seq) VALUES (?, 'en', 'title', ?, 0)");
  let id = 1;
  for (const [sid, code, url, concepts] of [[1, 'mms', MMS, MMS_CONCEPTS], [2, 'icf', ICF, ICF_CONCEPTS]]) {
    sys.run(sid, code, url, VERSION, 'ICD-11 ' + code, '/icd/release/11/' + VERSION + '/' + code, url);
    for (const [entity, short, text] of concepts) {
      concept.run(id, sid, entity, url + '/' + entity, short, id * 2, id * 2 + 1);
      title.run(id, text);
      id++;
    }
  }
  db.close();
}

/** Counts the per-code lookups (#resolve) a provider runs on its connection. */
function countResolves(provider, counter) {
  const get = provider.db.get.bind(provider.db);
  provider.db.get = (sql, ...rest) => {
    if (/^SELECT \* FROM concept WHERE system = \? AND \(code = \? OR uri = \?\)/.test(sql)) {
      counter.resolves++;
    }
    return get(sql, ...rest);
  };
  return provider;
}

let dir;
let dbPath;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icd11-batch-prefetch-'));
  dbPath = path.join(dir, 'icd11-test.db');
  buildDb(dbPath);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ICD-11 prefetchCodes: the handle, across providers', () => {
  let mms;
  let otherMms;
  let icf;
  let i18n;
  const opContext = () => new OperationContext('en', i18n);
  const providers = [];

  beforeAll(async () => {
    i18n = await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions());
    mms = new ICD11ServicesFactory(i18n, dbPath, 'mms');
    otherMms = new ICD11ServicesFactory(i18n, dbPath, 'mms');
    icf = new ICD11ServicesFactory(i18n, dbPath, 'icf');
    await Promise.all([mms.load(), otherMms.load(), icf.load()]);
  });

  afterAll(() => {
    for (const p of providers) p.close();
  });

  async function build(factory, counter) {
    const p = countResolves(await factory.build(opContext(), []), counter);
    providers.push(p);
    return p;
  }

  test('read by one provider, used by another the same factory built: no lookup per code', async () => {
    const reads = { resolves: 0 };
    const uses = { resolves: 0 };
    const reader = await build(mms, reads);
    const user = await build(mms, uses);
    const handle = await reader.prefetchCodes(['1000', '1A01', '9999'], true);
    expect(handle).not.toBeNull();

    const byId = await user.locate('1000', handle);
    const byShortCode = await user.locate('1A01', handle);
    const unknown = await user.locate('9999', handle);
    expect(byId.context.entityId).toBe('1000');
    expect(byId.context.code).toBe('1A00');
    expect(byShortCode.context.entityId).toBe('1001');
    expect(unknown.context).toBeNull();
    expect(uses.resolves).toBe(0);
    expect(reads.resolves).toBe(0);
    // the concept is the locating provider's: its display reads its own connection
    expect(await user.display(byId.context)).toBe('Cholera');

    // a code the list didn't hold is looked up as usual
    const notListed = await user.locate('1002', handle);
    expect(notListed.context.entityId).toBe('1002');
    expect(uses.resolves).toBe(1);
  });

  test('a provider of another factory ignores the handle and looks the code up as usual', async () => {
    const reader = await build(mms, { resolves: 0 });
    const handle = await reader.prefetchCodes(['1000', 'b110'], true);

    // another factory over the same classification: the same answer, from its own lookup
    const sameClassification = { resolves: 0 };
    const other = await build(otherMms, sameClassification);
    const r = await other.locate('1000', handle);
    expect(r.context.entityId).toBe('1000');
    expect(sameClassification.resolves).toBe(1);

    // another classification: the MMS handle doesn't answer an ICF code (nor hide one)
    const icfCounter = { resolves: 0 };
    const icfProvider = await build(icf, icfCounter);
    const b110 = await icfProvider.locate('2000', handle);
    expect(b110.context.code).toBe('b110');
    const mmsCodeInIcf = await icfProvider.locate('1000', handle);
    expect(mmsCodeInIcf.context).toBeNull();
    expect(icfCounter.resolves).toBe(2);
  });
});

describe('$batch-validate-code over ICD-11: one prefetchCodes, no lookup per entry', () => {
  let app;
  let provider;
  let factory;
  const keys = [MMS, MMS + '|' + VERSION];
  const replaced = new Map();
  const counter = { resolves: 0, prefetches: 0, builds: 0 };
  let prefetching = true;

  beforeAll(async () => {
    app = await getTestApp();
    factory = new ICD11ServicesFactory(getTxModule().i18n, dbPath, 'mms');
    await factory.load();
    const build = factory.build.bind(factory);
    factory.build = async (opContext, supplements) => {
      const p = countResolves(await build(opContext, supplements), counter);
      counter.builds++;
      if (prefetching) {
        const prefetchCodes = p.prefetchCodes.bind(p);
        p.prefetchCodes = (...args) => { counter.prefetches++; return prefetchCodes(...args); };
      } else {
        // as a provider that doesn't prefetch: the batch reads nothing for it
        p.prefetchCodes = CodeSystemProvider.prototype.prefetchCodes;
      }
      return p;
    };
    provider = getTxModule().endpoints[0].provider;
    for (const k of keys) {
      replaced.set(k, provider.codeSystemFactories.get(k));
      provider.codeSystemFactories.set(k, factory);
    }
  }, 60000);

  afterAll(async () => {
    for (const k of keys) {
      if (replaced.get(k) === undefined) {
        provider.codeSystemFactories.delete(k);
      } else {
        provider.codeSystemFactories.set(k, replaced.get(k));
      }
    }
    await shutdownTestApp();
  });

  beforeEach(() => {
    counter.resolves = 0;
    counter.prefetches = 0;
    counter.builds = 0;
  });

  const codes = [...MMS_CONCEPTS.map(c => c[0]), '1A03', '9999'];
  const entries = codes.map(code => ({
    name: 'validation',
    resource: { resourceType: 'Parameters', parameter: [{ name: 'coding', valueCoding: { system: MMS, code } }] }
  }));

  async function batch() {
    const res = await request(app).post('/tx/r5/CodeSystem/$batch-validate-code')
      .set('Content-Type', 'application/json')
      .send({ resourceType: 'Parameters', parameter: entries });
    expect(res.status).toBe(200);
    return res.body.parameter.map(p => {
      const out = p.resource.parameter;
      const get = (n) => out.find(x => x.name === n);
      return { result: get('result')?.valueBoolean, display: get('display')?.valueString, code: get('code')?.valueCode };
    });
  }

  test('the entries are answered from the batch\'s handle, the same as without it', async () => {
    prefetching = true;
    const withHandle = await batch();
    expect(counter.prefetches).toBe(1);
    expect(counter.resolves).toBe(0);

    prefetching = false;
    const without = await batch();
    prefetching = true;
    expect(counter.prefetches).toBe(1);
    // every entry looks its code up itself (an entry may locate it more than once)
    expect(counter.resolves).toBeGreaterThanOrEqual(codes.length);

    expect(withHandle).toEqual(without);
    expect(withHandle.map(r => r.result)).toEqual([true, true, true, true, true, true, false]);
    expect(withHandle[0].display).toBe('Cholera');
  });
});
