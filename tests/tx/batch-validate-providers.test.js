/**
 * $batch-validate-code and the providers its entries open
 *
 * A provider built from a factory can hold a resource that must be released
 * (for LOINC, RxNorm, UNII etc. a sqlite connection with its own page cache).
 * Each entry of a batch is a validation of its own, so it releases its providers
 * when it is done: a batch of a thousand entries holds the providers of one entry
 * at a time, not a thousand, and every one is closed by the time the batch
 * returns - whichever route and shape the entry has.
 */

const request = require('supertest');
const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');
const { CountryCodeFactoryProvider } = require('../../tx/cs/cs-country');

const SYSTEM = 'urn:iso:std:iso:3166';
const CODES = ['US', 'CA', 'GB', 'DE', 'FR', 'NZ', 'AU', 'JP'];
const N = 200;

/** Country codes, but each provider counts as open until it is closed, like a connection. */
class CountingCountryFactory extends CountryCodeFactoryProvider {
  open = 0;
  maxOpen = 0;
  builds = 0;

  build(opContext, supplements) {
    const provider = super.build(opContext, supplements);
    this.builds++;
    this.open++;
    this.maxOpen = Math.max(this.maxOpen, this.open);
    let closed = false;
    provider.close = () => {
      if (!closed) {
        closed = true;
        this.open--;
      }
    };
    return provider;
  }
}

function entry(parameter) {
  return { name: 'validation', resource: { resourceType: 'Parameters', parameter } };
}

describe('$batch-validate-code providers', () => {
  let app;
  let factory;

  beforeAll(async () => {
    app = await getTestApp();
    factory = new CountingCountryFactory(getTxModule().i18n);
    await factory.load();
    const provider = getTxModule().endpoints[0].provider;
    provider.codeSystemFactories.set(SYSTEM, factory);
    provider.codeSystemFactories.set(SYSTEM + '|' + factory.version(), factory);
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  beforeEach(() => {
    factory.open = 0;
    factory.maxOpen = 0;
    factory.builds = 0;
  });

  async function batch(route, entries) {
    const res = await request(app).post(`/tx/r5/${route}/$batch-validate-code`)
      .set('Content-Type', 'application/json')
      .send({ resourceType: 'Parameters', parameter: entries });
    expect(res.status).toBe(200);
    return res.body.parameter;
  }

  const coding = (i) => ({ name: 'coding', valueCoding: { system: SYSTEM, code: CODES[i % CODES.length] } });
  const valueSet = {
    resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/countries', status: 'active',
    compose: { include: [{ system: SYSTEM }] }
  };

  test.each([
    ['CodeSystem', 'coding only', (i) => entry([coding(i)])],
    ['ValueSet', 'coding only', (i) => entry([coding(i)])],
    ['ValueSet', 'with a value set', (i) => entry([coding(i), { name: 'valueSet', resource: valueSet }])],
  ])('%s route, entries %s: the providers open at once stay bounded, and all are closed', async (route, _shape, make) => {
    await batch(route, [make(0)]);
    const perEntry = factory.maxOpen;
    expect(perEntry).toBeGreaterThan(0);
    expect(factory.open).toBe(0);

    factory.maxOpen = 0;
    const rs = await batch(route, Array.from({ length: N }, (_, i) => make(i)));
    expect(rs.length).toBe(N);
    expect(rs.every(r => (r.resource.parameter || []).find(p => p.name === 'result')?.valueBoolean)).toBe(true);
    expect(factory.builds).toBeGreaterThanOrEqual(N);
    // one entry's worth at a time, not one per entry
    expect(factory.maxOpen).toBe(perEntry);
    expect(factory.open).toBe(0);
  });
});
