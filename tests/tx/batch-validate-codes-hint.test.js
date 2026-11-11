/**
 * $batch-validate-code tells providers the batch's codes up front
 *
 * Each entry of a batch is validated with its own context and its own providers, so a
 * provider is asked about one code at a time. Before the first entry runs, the batch
 * worker sets opContext.batchCodes (code system url -> Set of codes), shared by every
 * entry's context, so a provider may read them together (tx/cs/cs-api.md, Batches).
 */

const request = require('supertest');
const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');
const { CountryCodeFactoryProvider } = require('../../tx/cs/cs-country');

const SYSTEM = 'urn:iso:std:iso:3166';
const OTHER = 'http://example.org/fhir/CodeSystem/other';

/** Country codes; each locate records the batch codes its provider was shown. */
class HintRecordingCountryFactory extends CountryCodeFactoryProvider {
  seen = [];

  build(opContext, supplements) {
    const provider = super.build(opContext, supplements);
    const locate = provider.locate.bind(provider);
    provider.locate = async (code, prefetched) => {
      this.seen.push({ code, batchCodes: provider.opContext.batchCodes });
      return locate(code, prefetched);
    };
    return provider;
  }
}

function entry(parameter) {
  return { name: 'validation', resource: { resourceType: 'Parameters', parameter } };
}

const coding = (code, system = SYSTEM) => ({ name: 'coding', valueCoding: { system, code } });

describe('$batch-validate-code: opContext.batchCodes', () => {
  let app;
  let factory;

  beforeAll(async () => {
    app = await getTestApp();
    factory = new HintRecordingCountryFactory(getTxModule().i18n);
    await factory.load();
    const provider = getTxModule().endpoints[0].provider;
    provider.codeSystemFactories.set(SYSTEM, factory);
    provider.codeSystemFactories.set(SYSTEM + '|' + factory.version(), factory);
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  beforeEach(() => {
    factory.seen = [];
  });

  async function batch(route, parameter) {
    const res = await request(app).post(`/tx/r5/${route}/$batch-validate-code`)
      .set('Content-Type', 'application/json')
      .send({ resourceType: 'Parameters', parameter });
    expect(res.status).toBe(200);
    return res.body.parameter;
  }

  const sorted = (set) => [...set].sort();

  test('every entry\'s provider sees all the batch\'s codes, by system, from the first locate', async () => {
    const rs = await batch('CodeSystem', [
      entry([coding('US')]),
      entry([{ name: 'codeableConcept', valueCodeableConcept: { coding: [{ system: SYSTEM, code: 'CA' }, { system: OTHER, code: 'x1' }] } }]),
      entry([{ name: 'url', valueUri: SYSTEM }, { name: 'code', valueCode: 'GB' }]),
      entry([{ name: 'system', valueUri: SYSTEM }, { name: 'code', valueCode: 'US' }]),
      entry([coding('x2', OTHER)]),
    ]);
    expect(rs.length).toBe(5);

    expect(factory.seen.length).toBeGreaterThanOrEqual(4);
    // the first locate, of the first entry, already knows the rest of the batch
    const first = factory.seen[0];
    expect(first.code).toBe('US');
    expect(first.batchCodes).toBeInstanceOf(Map);
    expect(sorted(first.batchCodes.keys())).toEqual(sorted([SYSTEM, OTHER]));
    expect(sorted(first.batchCodes.get(SYSTEM))).toEqual(['CA', 'GB', 'US']);
    expect(sorted(first.batchCodes.get(OTHER))).toEqual(['x1', 'x2']);
    // one Map, shared by the entries' contexts (a provider can key what it read on it)
    expect(factory.seen.every(s => s.batchCodes === first.batchCodes)).toBe(true);
  });

  test('a global system or url applies to the entries that do not name one', async () => {
    await batch('CodeSystem', [
      { name: 'url', valueUri: SYSTEM },
      entry([{ name: 'code', valueCode: 'DE' }]),
      entry([{ name: 'code', valueCode: 'FR' }]),
    ]);
    expect(sorted(factory.seen[0].batchCodes.get(SYSTEM))).toEqual(['DE', 'FR']);
  });

  test('on the ValueSet route, url is the value set\'s, not a code system', async () => {
    const valueSet = {
      resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/countries', status: 'active',
      compose: { include: [{ system: SYSTEM }] }
    };
    await batch('ValueSet', [
      { name: 'valueSet', resource: valueSet },
      entry([coding('NZ')]),
      entry([{ name: 'system', valueUri: SYSTEM }, { name: 'code', valueCode: 'AU' }]),
    ]);
    const bc = factory.seen[0].batchCodes;
    expect(sorted(bc.keys())).toEqual([SYSTEM]);
    expect(sorted(bc.get(SYSTEM))).toEqual(['AU', 'NZ']);
  });

  test('outside a batch it is null', async () => {
    const res = await request(app).get('/tx/r5/CodeSystem/$validate-code')
      .query({ system: SYSTEM, code: 'US' });
    expect(res.status).toBe(200);
    expect(factory.seen.length).toBeGreaterThan(0);
    expect(factory.seen.every(s => s.batchCodes === null)).toBe(true);
  });
});
