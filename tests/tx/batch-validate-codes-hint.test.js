/**
 * $batch-validate-code calls prefetchCodes once per code system, before the entries run
 *
 * Each entry of a batch is validated with its own context and its own providers, so a
 * provider is asked about one code at a time. Before the first entry runs, the batch worker
 * calls prefetchCodes once per code system and version, with all the entries' codes of it, and
 * keeps the handles on the batch's context (opContext.prefetched), which every entry's context
 * reaches as opContext.batch. Each entry passes its provider's handle to locate
 * (tx/cs/cs-api.md, Batches).
 */

const request = require('supertest');
const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');
const { CountryCodeFactoryProvider } = require('../../tx/cs/cs-country');

const SYSTEM = 'urn:iso:std:iso:3166';
const OTHER = 'http://example.org/fhir/CodeSystem/other';

/** Country codes, with a prefetchCodes; records each prefetchCodes and what each locate is passed. */
class PrefetchRecordingCountryFactory extends CountryCodeFactoryProvider {
  prefetches = [];
  seen = [];

  build(opContext, supplements) {
    const provider = super.build(opContext, supplements);
    const locate = provider.locate.bind(provider);
    provider.prefetchCodes = async (codes) => {
      const handle = { from: this, codes: [...codes] };
      this.prefetches.push({ provider, handle });
      return handle;
    };
    provider.locate = async (code, prefetched) => {
      this.seen.push({ code, provider, batch: provider.opContext.batch, prefetched: prefetched ?? null });
      return locate(code, prefetched);
    };
    return provider;
  }
}

function entry(parameter) {
  return { name: 'validation', resource: { resourceType: 'Parameters', parameter } };
}

const coding = (code, system = SYSTEM) => ({ name: 'coding', valueCoding: { system, code } });

describe('$batch-validate-code: prefetchCodes once per code system', () => {
  let app;
  let factory;
  let provider;
  const keys = [];
  const replaced = new Map();

  beforeAll(async () => {
    app = await getTestApp();
    factory = new PrefetchRecordingCountryFactory(getTxModule().i18n);
    await factory.load();
    provider = getTxModule().endpoints[0].provider;
    keys.push(SYSTEM, SYSTEM + '|' + factory.version());
    for (const k of keys) {
      replaced.set(k, provider.codeSystemFactories.get(k));
      provider.codeSystemFactories.set(k, factory);
    }
  }, 60000);

  afterAll(async () => {
    // the test app is shared: put the country factory back
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
    factory.prefetches = [];
    factory.seen = [];
  });

  async function batch(route, parameter) {
    const res = await request(app).post(`/tx/r5/${route}/$batch-validate-code`)
      .set('Content-Type', 'application/json')
      .send({ resourceType: 'Parameters', parameter });
    expect(res.status).toBe(200);
    return res.body.parameter;
  }

  const prefetchedCodes = () => {
    expect(factory.prefetches.length).toBe(1);
    return [...factory.prefetches[0].handle.codes].sort();
  };

  test('one prefetchCodes for the whole batch; every entry\'s own provider is passed its handle', async () => {
    const rs = await batch('CodeSystem', [
      entry([coding('US')]),
      entry([{ name: 'codeableConcept', valueCodeableConcept: { coding: [{ system: SYSTEM, code: 'CA' }, { system: OTHER, code: 'x1' }] } }]),
      entry([{ name: 'url', valueUri: SYSTEM }, { name: 'code', valueCode: 'GB' }]),
      entry([{ name: 'system', valueUri: SYSTEM }, { name: 'code', valueCode: 'US' }]),
      entry([coding('x2', OTHER)]),
    ]);
    expect(rs.length).toBe(5);
    // OTHER isn't a code system this server holds: nothing to prefetch for it
    expect(prefetchedCodes()).toEqual(['CA', 'GB', 'US']);
    const { provider: batchProvider, handle } = factory.prefetches[0];

    const located = factory.seen.filter(s => s.batch);
    expect(located.map(s => s.code).sort()).toEqual(expect.arrayContaining(['CA', 'GB', 'US']));
    for (const s of located) {
      expect(s.prefetched).toBe(handle);
      // the entry's own provider, not the one that read the codes
      expect(s.provider).not.toBe(batchProvider);
    }
    // the entries' contexts share one batch context, which holds the handles
    expect(located.every(s => s.batch === located[0].batch)).toBe(true);
    expect(located[0].batch.batch).toBeNull();
    expect(located[0].batch.prefetched.get(SYSTEM + '|' + factory.version())).toBe(handle);
  });

  test('a global url applies to the entries that do not name one', async () => {
    await batch('CodeSystem', [
      { name: 'url', valueUri: SYSTEM },
      entry([{ name: 'code', valueCode: 'DE' }]),
      entry([{ name: 'code', valueCode: 'FR' }]),
    ]);
    expect(prefetchedCodes()).toEqual(['DE', 'FR']);
  });

  test('an entry\'s codeSystem resource names the system of its code', async () => {
    const codeSystem = { resourceType: 'CodeSystem', url: SYSTEM, status: 'active', content: 'not-present' };
    await batch('CodeSystem', [
      entry([{ name: 'codeSystem', resource: codeSystem }, { name: 'code', valueCode: 'JP' }]),
      entry([coding('IT')]),
    ]);
    expect(prefetchedCodes()).toEqual(['IT', 'JP']);
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
    expect(prefetchedCodes()).toEqual(['AU', 'NZ']);
    const handle = factory.prefetches[0].handle;
    expect(factory.seen.filter(s => s.code === 'NZ' || s.code === 'AU').every(s => s.prefetched === handle)).toBe(true);
  });

  test('an entry whose code system resolves to another version is passed no handle', async () => {
    await batch('CodeSystem', [
      entry([coding('US')]),
      entry([{ name: 'coding', valueCoding: { system: SYSTEM, version: 'not-held', code: 'CA' } }]),
    ]);
    expect(prefetchedCodes()).toEqual(['US']);
    expect(factory.seen.filter(s => s.code === 'CA').every(s => s.prefetched === null)).toBe(true);
  });

  test('outside a batch, nothing is prefetched and locate is passed no handle', async () => {
    const res = await request(app).get('/tx/r5/CodeSystem/$validate-code')
      .query({ system: SYSTEM, code: 'US' });
    expect(res.status).toBe(200);
    expect(factory.prefetches.length).toBe(0);
    expect(factory.seen.length).toBeGreaterThan(0);
    expect(factory.seen.every(s => s.batch === null && s.prefetched === null)).toBe(true);
  });
});
