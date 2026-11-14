/**
 * CodeSystemProvider.ancestorsOf, for each provider that implements it, agrees with the same
 * provider's subsumesTest (the contract $closure relies on - see cs-api.js):
 *
 *   for two different codes a and b with ancestor sets, subsumesTest(a, b) is
 *   'subsumes' when a is in ancestorsOf(b), else 'subsumed-by' when b is in ancestorsOf(a),
 *   else 'not-subsumed' - never 'equivalent'.
 *
 * Pairs are drawn at random, half of them from the provider's own descendant data (so most
 * are related, in one direction or the other) and half uniformly (mostly unrelated).
 *
 * LOINC and SNOMED CT run on the test data in the repository. Larger real releases are used as
 * well when given: FHIRSMITH_TEST_LOINC_DB (a Loinc_2.xx.db), FHIRSMITH_TEST_SNOMED_CACHE (a
 * SNOMED .cache), FHIRSMITH_TEST_ICD11_DB (an icd11 .db) and FHIRSMITH_TEST_RXNORM_DB.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');
const { LoincServicesFactory } = require('../../tx/cs/cs-loinc');
const { SnomedServicesFactory } = require('../../tx/cs/cs-snomed');
const { FhirCodeSystemFactory, FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');
const { CodeSystem } = require('../../tx/library/codesystem');
const { ICD11ServicesFactory } = require('../../tx/cs/cs-icd11');
const { CPTServicesFactory } = require('../../tx/cs/cs-cpt');
const { OMOPServicesFactory } = require('../../tx/cs/cs-omop');
const { RxNormServicesFactory } = require('../../tx/cs/cs-rxnorm');

/** a seeded random number generator (mulberry32) */
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
const pick = (random, list) => list[Math.floor(random() * list.length)];

/** what the ancestor sets say about a pair, in subsumesTest's terms */
function fromSets(a, b, ancA, ancB) {
  return ancB.has(a) ? 'subsumes' : ancA.has(b) ? 'subsumed-by' : 'not-subsumed';
}

/**
 * Compare ancestorsOf with subsumesTest over the pairs; every code must have a set.
 * @returns {Object} counts of each outcome, so a test can check related pairs were seen
 */
async function agree(provider, pairs) {
  const sets = new Map();
  const ancestors = async code => {
    if (!sets.has(code)) {
      const s = await provider.ancestorsOf(code);
      expect({ code, set: s instanceof Set }).toEqual({ code, set: true });
      sets.set(code, s);
    }
    return sets.get(code);
  };
  const counts = { subsumes: 0, 'subsumed-by': 0, 'not-subsumed': 0 };
  const wrong = [];
  for (const [a, b] of pairs) {
    if (a === b) {
      continue;
    }
    const expected = await provider.subsumesTest(a, b);
    const got = fromSets(a, b, await ancestors(a), await ancestors(b));
    if (got !== expected) {
      wrong.push(`${a} vs ${b}: subsumesTest ${expected}, ancestorsOf ${got}`);
    }
    counts[expected] = (counts[expected] || 0) + 1;
  }
  expect(wrong.slice(0, 20)).toEqual([]);
  if (process.env.FHIRSMITH_TEST_VERBOSE) {
    // eslint-disable-next-line no-console
    console.log(`${provider.system()}: ${JSON.stringify(counts)} over ${sets.size} codes`);
  }
  return counts;
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

let opContext;
beforeAll(async () => {
  opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
});

// -- LOINC ------------------------------------------------------------------------------

/**
 * The repository's LOINC test database (data/loinc-testing.db, written by cs-loinc.test.js),
 * or, when that hasn't run yet, the same import into a temporary directory.
 */
async function repoLoincDb() {
  const file = path.resolve(__dirname, '../../data/loinc-testing.db');
  if (fs.existsSync(file)) {
    return file;
  }
  const { LoincDataMigrator } = require('../../tx/importers/import-loinc.module');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loinc-ancestors-')), 'loinc-testing.db');
  await new LoincDataMigrator().migrate(path.resolve(__dirname, '../../tx/data/loinc'), out, '2.80-test', { verbose: false, mainOnly: false });
  return out;
}

const loincDbs = [['loinc-testing.db', null], process.env.FHIRSMITH_TEST_LOINC_DB]
  .filter(f => f && (Array.isArray(f) || fs.existsSync(f))).map(f => (Array.isArray(f) ? f : [path.basename(f), f]));

describe.each(loincDbs)('LOINC ancestorsOf (%s)', (label, given) => {
  let file;
  let factory;
  let provider;
  beforeAll(async () => {
    file = given || await repoLoincDb();
    factory = new LoincServicesFactory(opContext.i18n, file);
    provider = await factory.build(opContext, []);
  }, 120000);
  afterAll(() => provider && provider.close && provider.close());

  test('agrees with subsumesTest over random pairs', async () => {
    const random = rng(11);
    // related pairs, read from the Closure table directly (one direction or the other)
    const related = await dbAll(file, `SELECT a.Code AS a, d.Code AS d FROM Closure
        JOIN Codes a ON a.CodeKey = Closure.AncestorKey JOIN Codes d ON d.CodeKey = Closure.DescendentKey
        ORDER BY random() LIMIT 1500`);
    const codes = (await dbAll(file, 'SELECT Code FROM Codes ORDER BY random() LIMIT 1500')).map(r => r.Code);
    const pairs = [];
    for (const r of related) {
      pairs.push(random() < 0.5 ? [r.a, r.d] : [r.d, r.a]);
      // a code with something unrelated, or with a sibling
      pairs.push([r.d, pick(random, codes)]);
    }
    for (let i = 0; i < 1500; i++) {
      pairs.push([pick(random, codes), pick(random, codes)]);
    }
    const counts = await agree(provider, pairs);
    // the repository's test data is small; a real release gives thousands of each
    expect(counts.subsumes).toBeGreaterThan(20);
    expect(counts['subsumed-by']).toBeGreaterThan(20);
    expect(counts['not-subsumed']).toBeGreaterThan(100);
  }, 300000);

  test('an unknown code, or another spelling of a code, has no set', async () => {
    const [row] = await dbAll(file, `SELECT Code FROM Codes WHERE Code GLOB '*[A-Z]*' LIMIT 1`);
    expect(await provider.ancestorsOf('no-such-code')).toBeNull();
    if (row) {
      expect(await provider.ancestorsOf(row.Code.toLowerCase())).toBeNull();
    }
  });
});

// -- SNOMED CT --------------------------------------------------------------------------

const snomedCaches = [path.resolve(__dirname, '../../tx/data/snomed-testing.cache'), process.env.FHIRSMITH_TEST_SNOMED_CACHE]
  .filter(f => f && fs.existsSync(f));

describe.each(snomedCaches.map(f => [path.basename(f), f]))('SNOMED CT ancestorsOf (%s)', (label, file) => {
  let provider;
  beforeAll(async () => {
    const factory = new SnomedServicesFactory(opContext.i18n, file);
    provider = await factory.build(opContext, []);
  }, 300000);

  test('agrees with subsumesTest over random pairs, inactive concepts included', async () => {
    const random = rng(7);
    const sct = provider.sct;
    const total = sct.concepts.count();
    const conceptAt = () => sct.concepts.getConceptByCount(Math.floor(random() * total));
    const codes = [];
    for (let i = 0; i < 2000; i++) {
      codes.push(conceptAt().identity.toString());
    }
    const pairs = [];
    // related pairs from the descendant closure subsumesTest reads (not the parent walk)
    let tries = 0;
    while (pairs.length < 3000 && tries++ < 200000) {
      const c = conceptAt();
      const ref = sct.concepts.getAllDesc(c.index);
      if (ref === 0 || ref === 0xFFFFFFFF) {
        continue;
      }
      const desc = sct.refs.getReferences(ref);
      const d = sct.getConceptId(pick(random, desc));
      const a = c.identity.toString();
      pairs.push(random() < 0.5 ? [a, d] : [d, a]);
      pairs.push([d, pick(random, codes)]);
    }
    for (let i = 0; i < 2000; i++) {
      pairs.push([pick(random, codes), pick(random, codes)]);
    }
    const counts = await agree(provider, pairs);
    expect(counts.subsumes).toBeGreaterThan(200);
    expect(counts['subsumed-by']).toBeGreaterThan(200);
    expect(counts['not-subsumed']).toBeGreaterThan(200);
  }, 300000);

  test('an expression, or a concept written another way, has no set', async () => {
    const sct = provider.sct;
    let id = null;
    for (let i = 0; i < sct.concepts.count() && !id; i++) {
      const c = sct.concepts.getConceptByCount(i);
      if (sct.getConceptParents(c.index).length > 0) {
        id = c.identity.toString();
      }
    }
    const display = await provider.display(id);
    expect((await provider.ancestorsOf(id)).size).toBeGreaterThan(0);
    expect(await provider.ancestorsOf(`${id} |${display}|`)).toBeNull();
    expect(await provider.ancestorsOf('999999999999999999')).toBeNull();
  });
});

// -- FHIR CodeSystem resources ----------------------------------------------------------

describe('CodeSystem resource ancestorsOf', () => {
  /** a random multi-parent hierarchy as `parent` properties, plus one cycle */
  function codeSystem(random, caseSensitive) {
    const concept = [];
    for (let i = 0; i < 120; i++) {
      const property = [];
      if (i >= 3) {
        const n = 1 + Math.floor(random() * 3);
        for (let j = 0; j < n; j++) {
          property.push({ code: 'parent', valueCode: 'C' + Math.floor(random() * i) });
        }
      }
      concept.push({ code: 'C' + i, display: 'Concept ' + i, property });
    }
    // C1 and C2 sit under each other
    concept[1].property.push({ code: 'parent', valueCode: 'C2' });
    concept[2].property.push({ code: 'parent', valueCode: 'C1' });
    return new CodeSystem({
      resourceType: 'CodeSystem', url: 'http://example.org/cs/ancestors-' + caseSensitive, version: '1', status: 'active',
      content: 'complete', caseSensitive, hierarchyMeaning: 'is-a',
      property: [{ code: 'parent', type: 'code' }], concept
    });
  }

  test.each([true, false])('agrees with subsumesTest on every pair (caseSensitive %s)', async (caseSensitive) => {
    const random = rng(caseSensitive ? 3 : 4);
    const factory = new FhirCodeSystemFactory(opContext.i18n);
    const provider = factory.build(opContext, [], codeSystem(random, caseSensitive));
    const codes = Array.from({ length: 120 }, (_, i) => 'C' + i);
    const pairs = [];
    for (const a of codes) {
      for (const b of codes) {
        pairs.push([a, b]);
      }
    }
    const counts = await agree(provider, pairs);
    expect(counts.subsumes).toBeGreaterThan(100);
    // every related pair is seen both ways; the C1/C2 cycle is 'subsumes' both ways (A is checked first)
    expect(counts.subsumes).toBe(counts['subsumed-by'] + 2);
    expect(await provider.ancestorsOf('no-such-code')).toBeNull();
    if (!caseSensitive) {
      // another spelling of C5 is located, but is not in the form code() gives
      expect(await provider.ancestorsOf('c5')).toBeNull();
    }
  });

  test('a subclass with its own subsumesTest has no sets', async () => {
    class Own extends FhirCodeSystemProvider {
      async subsumesTest() { return 'not-subsumed'; }
    }
    const factory = new FhirCodeSystemFactory(opContext.i18n);
    const base = factory.build(opContext, [], codeSystem(rng(5), true));
    const own = Object.setPrototypeOf(base, Own.prototype);
    expect(await own.ancestorsOf('C5')).toBeNull();
  });
});

// -- ICD-11 (only with a real database) ---------------------------------------------------

const icd11Db = process.env.FHIRSMITH_TEST_ICD11_DB;
(icd11Db && fs.existsSync(icd11Db) ? describe : describe.skip)('ICD-11 ancestorsOf', () => {
  test.each(['mms', 'foundation'])('agrees with subsumesTest over random pairs (%s)', async (systemCode) => {
    const factory = new ICD11ServicesFactory(opContext.i18n, icd11Db, systemCode);
    await factory.load();
    const provider = await factory.build(opContext, []);
    const random = rng(13);
    const [{ id: systemId }] = await dbAll(icd11Db, 'SELECT id FROM system WHERE code = ?', [systemCode]);
    const code = r => (systemCode === 'foundation' ? r.uri : r.entity_id);
    const related = await dbAll(icd11Db, `SELECT a.uri AS auri, a.entity_id AS aid, d.uri AS duri, d.entity_id AS did
        FROM concept_closure cl JOIN concept a ON a.id = cl.ancestor JOIN concept d ON d.id = cl.descendant
        WHERE a.system = ? AND cl.ancestor <> cl.descendant ORDER BY random() LIMIT 1000`, [systemId]);
    const codes = (await dbAll(icd11Db, 'SELECT uri, entity_id FROM concept WHERE system = ? ORDER BY random() LIMIT 1000', [systemId])).map(code);
    const pairs = [];
    for (const r of related) {
      const a = code({ uri: r.auri, entity_id: r.aid });
      const d = code({ uri: r.duri, entity_id: r.did });
      pairs.push(random() < 0.5 ? [a, d] : [d, a]);
      pairs.push([d, pick(random, codes)]);
    }
    for (let i = 0; i < 1000; i++) {
      pairs.push([pick(random, codes), pick(random, codes)]);
    }
    const counts = await agree(provider, pairs);
    expect(counts.subsumes).toBeGreaterThan(100);
    expect(counts['subsumed-by']).toBeGreaterThan(100);
  }, 300000);
});

// -- code systems without a hierarchy: every known code sits under nothing ------------------

const flat = [
  ['CPT', () => new CPTServicesFactory(opContext.i18n, path.resolve(__dirname, '../../tx/data/cpt-fragment.db')),
    path.resolve(__dirname, '../../tx/data/cpt-fragment.db'), 'SELECT code FROM Concepts LIMIT 20'],
  ['OMOP', () => new OMOPServicesFactory(opContext.i18n, path.resolve(__dirname, '../../tx/data/omop-fragment.db')),
    path.resolve(__dirname, '../../tx/data/omop-fragment.db'), 'SELECT concept_id AS code FROM Concepts LIMIT 20'],
  ['RxNorm', () => new RxNormServicesFactory(opContext.i18n, process.env.FHIRSMITH_TEST_RXNORM_DB),
    process.env.FHIRSMITH_TEST_RXNORM_DB, `SELECT DISTINCT RXCUI AS code FROM rxnconso WHERE SAB = 'RXNORM' LIMIT 20`]
].filter(([, , file]) => file && fs.existsSync(file));

describe.each(flat)('%s ancestorsOf', (label, makeFactory, file, sql) => {
  test('a known code has an empty set, an unknown one none; pairs agree with subsumesTest', async () => {
    const factory = makeFactory();
    if (factory.load) {
      await factory.load();
    }
    const provider = await factory.build(opContext, []);
    const codes = (await dbAll(file, sql)).map(r => String(r.code));
    for (const c of codes) {
      expect([...(await provider.ancestorsOf(c))]).toEqual([]);
    }
    expect(await provider.ancestorsOf('no-such-code-xyz')).toBeNull();
    const pairs = codes.flatMap(a => codes.slice(0, 5).map(b => [a, b]));
    await agree(provider, pairs);
  }, 120000);
});
