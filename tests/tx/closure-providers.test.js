/**
 * $closure gives the same table with a provider's own ancestorsOf as without it, for the
 * built-in providers that implement it (see tests/cs/ancestors-of.test.js for the provider
 * level check against subsumesTest).
 *
 * Each case runs the same sequence of adds twice against a new table: once with the provider
 * as it is, and once with its ancestorsOf answering null, so that every pair goes through
 * subsumesTest as before the hook. Every response, and the table as a resync from 0 reads it,
 * must be the same, and with the hook no pair of codes the provider has sets for may need a
 * subsumesTest.
 *
 * The codes are a mix of related and unrelated ones read from the provider's own data:
 * LOINC terms and the parts above them, SNOMED CT concepts (inactive ones included) and their
 * descendants, a CodeSystem resource with several parents per code and a cycle. The
 * repository's test data is always used; a real release as well when FHIRSMITH_TEST_LOINC_DB,
 * FHIRSMITH_TEST_SNOMED_CACHE or FHIRSMITH_TEST_ICD11_DB names one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const ClosureWorker = require('../../tx/workers/closure');
const { ClosureStore } = require('../../tx/closure/closure-store');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');
const { LoincServicesFactory } = require('../../tx/cs/cs-loinc');
const { SnomedServicesFactory } = require('../../tx/cs/cs-snomed');
const { FhirCodeSystemFactory } = require('../../tx/cs/cs-cs');
const { CodeSystem } = require('../../tx/library/codesystem');
const { ICD11ServicesFactory } = require('../../tx/cs/cs-icd11');
const { CPTServicesFactory } = require('../../tx/cs/cs-cpt');
const { OMOPServicesFactory } = require('../../tx/cs/cs-omop');
const { loincTestingDbCopy } = require('../loinc-testing-db');

/** a seeded random number generator (mulberry32), so a failure can be reproduced */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(random, list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function dbAll(file, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY);
    db.all(sql, params, (err, rows) => {
      db.close();
      return err ? reject(err) : resolve(rows);
    });
  });
}

function entriesOf(cm) {
  const out = [];
  for (const g of cm.group || []) {
    for (const e of g.element || []) {
      for (const t of e.target || []) {
        out.push(`${g.source}|${e.code} > ${g.target}|${t.code} : ${t.relationship}${t.equivalence ? '/' + t.equivalence : ''}`);
      }
    }
  }
  return out;
}

/**
 * The codes in batches: a first large one, then smaller ones (fractions of the list), each
 * after the first with one code that is already in the table.
 */
function batches(random, codes, fractions) {
  const order = shuffle(random, codes);
  const adds = [];
  let at = 0;
  for (const f of fractions) {
    const size = Math.max(1, Math.round(order.length * f));
    const batch = order.slice(at, Math.min(order.length, at + size));
    if (batch.length === 0) {
      break;
    }
    at += batch.length;
    if (adds.length > 0) {
      batch.push(order[Math.floor(random() * (at - batch.length))]);
    }
    adds.push(batch);
  }
  if (at < order.length) {
    adds.push(order.slice(at));
  }
  return adds;
}

const SIZES = [0.4, 0.2, 0.002, 0.15, 0.1];

let i18n;
let languages;
let opContext;
beforeAll(async () => {
  languages = await TestUtilities.loadLanguageDefinitions();
  i18n = await TestUtilities.loadTranslations(languages);
  opContext = new OperationContext('en', i18n);
});

/**
 * Run the adds against a new table, with the provider's ancestorsOf or (hook false) without.
 * @returns {Object} every response's entries, the resync, and the provider calls made
 */
async function run(provider, adds, hook) {
  const calls = { subsumesTest: 0, ancestorsOf: 0, sets: 0 };
  // counted on the provider's class, so that a provider which checks it has its class's own
  // subsumesTest (cs-cs does, for subclasses) still sees it
  const proto = Object.getPrototypeOf(provider);
  const own = { subsumesTest: proto.subsumesTest, ancestorsOf: proto.ancestorsOf };
  proto.subsumesTest = async function (a, b) {
    calls.subsumesTest++;
    return own.subsumesTest.call(this, a, b);
  };
  proto.ancestorsOf = async function (code) {
    calls.ancestorsOf++;
    const set = hook ? await own.ancestorsOf.call(this, code) : null;
    if (set) {
      calls.sets++;
    }
    return set;
  };
  const system = provider.system();
  const store = new ClosureStore({ database: ':memory:' });
  store.open();
  try {
    store.createTable('t', []);
    const responses = [];
    for (const codes of adds) {
      const ctx = new OperationContext('en', i18n);
      const worker = new ClosureWorker(ctx, { info() {}, debug() {}, warn() {}, error() {} }, null, languages, i18n, store, {});
      worker.setupAdditionalResources = () => {};
      worker.seeSourceProvider = () => {};
      worker.findCodeSystem = async () => provider;
      const params = codes.map(code => ({ name: 'concept', valueCoding: { system, code } }));
      const cm = await worker.add(store.getTable('t'), 't', params, '5.0');
      responses.push({ version: cm.version, entries: entriesOf(cm) });
    }
    const table = store.getTable('t');
    const resync = store.entriesSince(table.id, 0)
      .map(e => `${e.source_system}|${e.source_code} > ${e.target_system}|${e.target_code} : ${e.relationship}`).sort();
    return { responses, resync, calls };
  } finally {
    store.close();
    proto.subsumesTest = own.subsumesTest;
    proto.ancestorsOf = own.ancestorsOf;
  }
}

/** the same table both ways; returns the number of entries */
async function sameBothWays(provider, adds) {
  const pairwise = await run(provider, adds, false);
  const hooked = await run(provider, adds, true);
  expect(hooked.responses).toEqual(pairwise.responses);
  expect(hooked.resync).toEqual(pairwise.resync);
  expect(pairwise.calls.subsumesTest).toBeGreaterThan(0);
  expect(hooked.calls.sets).toBeGreaterThan(0);
  // every code here has a set, so no pair is left to subsumesTest
  expect(hooked.calls.subsumesTest).toBe(0);
  if (process.env.FHIRSMITH_TEST_VERBOSE) {
    // eslint-disable-next-line no-console
    console.log(`${provider.system()}: ${adds.flat().length} codes in ${adds.length} adds, ${pairwise.resync.length} entries; `
      + `subsumesTest ${pairwise.calls.subsumesTest} -> ${hooked.calls.subsumesTest}, ancestorsOf sets ${hooked.calls.sets}`);
  }
  return pairwise.resync.length;
}

// -- LOINC: terms, and parts they sit under --------------------------------------------------

/**
 * A copy of the repository's LOINC test database (data/loinc-testing.db: tests/loinc-testing-db.js),
 * as loading it sets WAL and makes indexes, and other suites copy it.
 */
const loincCopies = [];
async function repoLoincDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loinc-ancestors-'));
  loincCopies.push(dir);
  return loincTestingDbCopy(dir, 'loinc-testing.db');
}
afterAll(() => {
  for (const dir of loincCopies) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const loincDbs = [['loinc-testing.db', null], process.env.FHIRSMITH_TEST_LOINC_DB]
  .filter(f => f && (Array.isArray(f) || fs.existsSync(f))).map(f => (Array.isArray(f) ? f : [path.basename(f), f]));

describe.each(loincDbs)('$closure with LOINC ancestorsOf (%s)', (label, given) => {
  test('the same table with and without the hook, terms and parts', async () => {
    const file = given || await repoLoincDb();
    const factory = new LoincServicesFactory(opContext.i18n, file);
    const provider = await factory.build(opContext, []);
    try {
      // terms that sit under parts, and some of those parts (most terms are leaves)
      const related = await dbAll(file, `SELECT a.Code AS a, d.Code AS d FROM Closure
          JOIN Codes a ON a.CodeKey = Closure.AncestorKey JOIN Codes d ON d.CodeKey = Closure.DescendentKey
          WHERE Closure.AncestorKey <> Closure.DescendentKey ORDER BY random() LIMIT 150`);
      const other = (await dbAll(file, 'SELECT Code FROM Codes ORDER BY random() LIMIT 150')).map(r => r.Code);
      const codes = [...new Set([...related.flatMap(r => [r.a, r.d]), ...other])];
      const adds = batches(rng(21), codes, SIZES);
      expect(await sameBothWays(provider, adds)).toBeGreaterThan(20);
    } finally {
      provider.close();
    }
  }, 300000);
});

// -- SNOMED CT: concepts, inactive ones included, and their descendants ----------------------

const snomedCaches = [path.resolve(__dirname, '../../tx/data/snomed-testing.cache'), process.env.FHIRSMITH_TEST_SNOMED_CACHE]
  .filter(f => f && fs.existsSync(f));

describe.each(snomedCaches.map(f => [path.basename(f), f]))('$closure with SNOMED CT ancestorsOf (%s)', (label, file) => {
  test('the same table with and without the hook, inactive concepts included', async () => {
    const factory = new SnomedServicesFactory(opContext.i18n, file);
    const provider = await factory.build(opContext, []);
    const sct = provider.sct;
    const random = rng(23);
    const total = sct.concepts.count();
    const codes = new Set();
    // inactive concepts: no active is-a, so related to nothing, whatever inactive rows they have
    const inactive = [];
    for (let i = 0; i < total; i++) {
      const c = sct.concepts.getConceptByCount(i);
      if (!sct.isActive(c.index)) {
        inactive.push(c.identity.toString());
      }
    }
    for (const id of shuffle(random, inactive).slice(0, 30)) {
      codes.add(id);
    }
    let tries = 0;
    while (codes.size < 330 && tries++ < 100000) {
      const c = sct.concepts.getConceptByCount(Math.floor(random() * total));
      if (!sct.isActive(c.index)) {
        continue;
      }
      codes.add(c.identity.toString());
      const ref = sct.concepts.getAllDesc(c.index);
      if (ref !== 0 && ref !== 0xFFFFFFFF) {
        const desc = sct.refs.getReferences(ref);
        for (let i = 0; i < 2; i++) {
          codes.add(sct.getConceptId(desc[Math.floor(random() * desc.length)]));
        }
      }
    }
    expect(inactive.length).toBeGreaterThan(0);
    const adds = batches(random, [...codes], SIZES);
    expect(await sameBothWays(provider, adds)).toBeGreaterThan(20);
  }, 300000);
});

// -- CodeSystem resources: several parents per code, a cycle, case sensitive or not ----------

describe('$closure with CodeSystem resource ancestorsOf', () => {
  function codeSystem(random, caseSensitive) {
    const concept = [];
    for (let i = 0; i < 200; i++) {
      const property = [];
      if (i >= 3) {
        const n = 1 + Math.floor(random() * 3);
        for (let j = 0; j < n; j++) {
          property.push({ code: 'parent', valueCode: 'C' + Math.floor(random() * i) });
        }
      }
      concept.push({ code: 'C' + i, display: 'Concept ' + i, property });
    }
    concept[1].property.push({ code: 'parent', valueCode: 'C2' });
    concept[2].property.push({ code: 'parent', valueCode: 'C1' });
    return new CodeSystem({
      resourceType: 'CodeSystem', url: 'http://example.org/cs/closure-providers-' + caseSensitive, version: '1', status: 'active',
      content: 'complete', caseSensitive, hierarchyMeaning: 'is-a',
      property: [{ code: 'parent', type: 'code' }], concept
    });
  }

  test.each([true, false])('the same table with and without the hook (caseSensitive %s)', async (caseSensitive) => {
    const random = rng(caseSensitive ? 31 : 32);
    const provider = new FhirCodeSystemFactory(opContext.i18n).build(opContext, [], codeSystem(random, caseSensitive));
    const codes = Array.from({ length: 200 }, (_, i) => 'C' + i);
    const adds = batches(random, codes, SIZES);
    expect(await sameBothWays(provider, adds)).toBeGreaterThan(100);
  });

  test('a nested concept hierarchy (concept.concept)', async () => {
    const random = rng(33);
    let n = 0;
    const level = depth => Array.from({ length: depth > 0 ? 3 : 0 }, () => {
      const code = 'N' + (n++);
      return { code, display: code, concept: level(depth - 1) };
    });
    const cs = new CodeSystem({
      resourceType: 'CodeSystem', url: 'http://example.org/cs/closure-providers-nested', version: '1', status: 'active',
      content: 'complete', hierarchyMeaning: 'is-a', concept: level(4)
    });
    const provider = new FhirCodeSystemFactory(opContext.i18n).build(opContext, [], cs);
    const codes = Array.from({ length: n }, (_, i) => 'N' + i);
    const adds = batches(random, codes, SIZES);
    expect(await sameBothWays(provider, adds)).toBeGreaterThan(50);
  });
});

// -- ICD-11 (only with a real database) ---------------------------------------------------------

const icd11Db = process.env.FHIRSMITH_TEST_ICD11_DB;
(icd11Db && fs.existsSync(icd11Db) ? describe : describe.skip)('$closure with ICD-11 ancestorsOf', () => {
  test.each(['mms', 'foundation'])('the same table with and without the hook (%s)', async (systemCode) => {
    const factory = new ICD11ServicesFactory(opContext.i18n, icd11Db, systemCode);
    await factory.load();
    const provider = await factory.build(opContext, []);
    const [{ id: systemId }] = await dbAll(icd11Db, 'SELECT id FROM system WHERE code = ?', [systemCode]);
    const code = r => (systemCode === 'foundation' ? r.uri : r.entity_id);
    const related = await dbAll(icd11Db, `SELECT a.uri AS auri, a.entity_id AS aid, d.uri AS duri, d.entity_id AS did
        FROM concept_closure cl JOIN concept a ON a.id = cl.ancestor JOIN concept d ON d.id = cl.descendant
        WHERE a.system = ? AND cl.ancestor <> cl.descendant ORDER BY random() LIMIT 100`, [systemId]);
    const other = (await dbAll(icd11Db, 'SELECT uri, entity_id FROM concept WHERE system = ? ORDER BY random() LIMIT 100', [systemId])).map(code);
    const codes = [...new Set([...related.flatMap(r => [code({ uri: r.auri, entity_id: r.aid }), code({ uri: r.duri, entity_id: r.did })]), ...other])];
    const adds = batches(rng(41), codes, SIZES);
    expect(await sameBothWays(provider, adds)).toBeGreaterThan(20);
  }, 300000);
});

// -- code systems without a hierarchy -----------------------------------------------------------

const flat = [
  ['CPT', () => new CPTServicesFactory(opContext.i18n, path.resolve(__dirname, '../../tx/data/cpt-fragment.db')),
    path.resolve(__dirname, '../../tx/data/cpt-fragment.db'), 'SELECT code FROM Concepts'],
  ['OMOP', () => new OMOPServicesFactory(opContext.i18n, path.resolve(__dirname, '../../tx/data/omop-fragment.db')),
    path.resolve(__dirname, '../../tx/data/omop-fragment.db'), 'SELECT concept_id AS code FROM Concepts LIMIT 60']
].filter(([, , file]) => fs.existsSync(file));

describe.each(flat)('$closure with %s ancestorsOf', (label, makeFactory, file, sql) => {
  test('no entries, with and without the hook', async () => {
    const factory = makeFactory();
    if (factory.load) {
      await factory.load();
    }
    const provider = await factory.build(opContext, []);
    const codes = (await dbAll(file, sql)).map(r => String(r.code));
    const pairwise = await run(provider, batches(rng(51), codes, SIZES), false);
    const hooked = await run(provider, batches(rng(51), codes, SIZES), true);
    expect(hooked.responses).toEqual(pairwise.responses);
    expect(hooked.resync).toEqual([]);
    expect(pairwise.calls.subsumesTest).toBeGreaterThan(0);
    expect(hooked.calls.subsumesTest).toBe(0);
  });
});
