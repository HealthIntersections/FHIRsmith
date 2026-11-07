/**
 * The providers an operation builds are closed when it ends, however it ends. A counting
 * country-code factory stands in for a sqlite-backed one: each provider it builds counts as an
 * open connection until close() is called.
 */
const http = require('http');
const request = require('supertest');
const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');
const { CountryCodeFactoryProvider } = require('../../tx/cs/cs-country');
const { OperationContext } = require('../../tx/operation-context');
const { TerminologyWorker } = require('../../tx/workers/worker');
const { TxParameters } = require('../../tx/params');
const { ValidateWorker } = require('../../tx/workers/validate');

const SYSTEM = 'urn:iso:std:iso:3166';

class CountingCountryFactory extends CountryCodeFactoryProvider {
  open = 0; maxOpen = 0; builds = 0; delayMs = 0;
  async build(opContext, supplements) {
    if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs));
    const provider = super.build(opContext, supplements);
    this.builds++; this.open++; this.maxOpen = Math.max(this.maxOpen, this.open);
    let closed = false;
    provider.close = () => { if (!closed) { closed = true; this.open--; } };
    return provider;
  }
}

describe('provider lifecycle', () => {
  let app, factory, server, port;
  beforeAll(async () => {
    app = await getTestApp();
    factory = new CountingCountryFactory(getTxModule().i18n);
    await factory.load();
    const provider = getTxModule().endpoints[0].provider;
    provider.codeSystemFactories.set(SYSTEM, factory);
    provider.codeSystemFactories.set(SYSTEM + '|' + factory.version(), factory);
    server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  }, 120000);
  afterAll(async () => { await new Promise(r => server.close(r)); await shutdownTestApp(); });
  beforeEach(() => { factory.open = 0; factory.maxOpen = 0; factory.builds = 0; factory.delayMs = 0; });

  const settle = (ms) => new Promise(r => setTimeout(r, ms));

  test('a provider whose build finishes after the client has gone is closed', async () => {
    factory.delayMs = 300;
    await request(app).get(`/tx/r5/CodeSystem/$lookup?system=${SYSTEM}&code=US`).expect(200);
    await settle(50);
    expect(factory.open).toBe(0);
    // the client goes while factory.build() is waiting
    await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: `/tx/r5/CodeSystem/$lookup?system=${SYSTEM}&code=US` });
      req.on('error', () => resolve());
      setTimeout(() => { req.destroy(); resolve(); }, 100);
    });
    await settle(1000);
    expect(factory.builds).toBe(2);
    expect(factory.open).toBe(0);
  });

  test('a provider registered after closeProviders() is closed', async () => {
    const ctx = new OperationContext('en', getTxModule().i18n, 'x', 20, null, null);
    ctx.registerProvider({ close: () => {} });
    await ctx.closeProviders(); // the request's res 'close'/'finish', the only call
    let closed = 0;
    ctx.registerProvider({ close: () => { closed++; } });
    await settle(20);
    expect(closed).toBe(1);
  });

  test('a provider is built once for an operation and the copies that share its providers, not for one with its own', async () => {
    const provider = getTxModule().endpoints[0].provider;
    const ctx = new OperationContext('en', getTxModule().i18n, 'x', 20, null, null);
    const a = await provider.buildOnce(ctx, factory, []);
    expect(await provider.buildOnce(ctx, factory, [])).toBe(a);
    // resolveCode() uses the same one
    expect(await provider.resolveCodeProvider(ctx, factory)).toBe(a);
    // a copy shares the providers, and closes them with its parent
    expect(await provider.buildOnce(ctx.copy(), factory, [])).toBe(a);
    // a copy with its own (a batch entry) builds its own, which it closes itself
    const entry = ctx.copy({ ownProviders: true });
    const b = await provider.buildOnce(entry, factory, []);
    expect(b).not.toBe(a);
    expect(factory.builds).toBe(2);
    entry.registerProvider(b);
    await entry.closeProviders();
    expect(factory.open).toBe(1);
    // once closed, nothing closed is handed out: a later build is a new provider
    ctx.registerProvider(a);
    await ctx.closeProviders();
    expect(factory.open).toBe(0);
    const c = await provider.buildOnce(ctx, factory, []);
    expect(c).not.toBe(a);
    ctx.registerProvider(c); // closed at once: the operation has ended
    await settle(20);
    expect(factory.open).toBe(0);
  });

  test('a failed build is not kept: the next call builds again', async () => {
    const ctx = new OperationContext('en', getTxModule().i18n, 'x', 20, null, null);
    let calls = 0;
    const build = () => { calls++; return calls === 1 ? Promise.reject(new Error('no')) : Promise.resolve({ close() {} }); };
    await expect(ctx.buildProviderOnce('k', build)).rejects.toThrow('no');
    await expect(ctx.buildProviderOnce('k', build)).resolves.toBeTruthy();
    expect(calls).toBe(2);
  });

  test('findCodeSystem closes the provider when checkVersion throws ($validate-code)', async () => {
    const vs = {
      resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/c2', status: 'active',
      compose: { include: [{ system: SYSTEM, version: '2018' }, { system: SYSTEM, version: '2099' }] }
    };
    const body = { resourceType: 'Parameters', parameter: [
      { name: 'valueSet', resource: vs },
      { name: 'coding', valueCoding: { system: SYSTEM, code: 'US' } },
      { name: 'check-system-version', valueCanonical: SYSTEM + '|9.9' }
    ] };
    for (let i = 0; i < 5; i++) {
      await request(app).post('/tx/r5/ValueSet/$validate-code').set('Content-Type', 'application/json').send(body);
    }
    await settle(50);
    expect(factory.builds).toBeGreaterThan(0);
    expect(factory.open).toBe(0);
  });

  test('findCodeSystem closes the provider when checkVersion throws (as $closure calls it)', async () => {
    const tx = getTxModule();
    const ctx = new OperationContext('en', tx.i18n, 'y', 20, null, null);
    const w = new TerminologyWorker(ctx, tx.log, tx.endpoints[0].provider, tx.languages, tx.i18n);
    const txp = new TxParameters(tx.i18n.languageDefinitions, tx.i18n);
    txp.readParams({ resourceType: 'Parameters', parameter: [{ name: 'check-system-version', valueCanonical: SYSTEM + '|9.9' }] });
    await expect(w.findCodeSystem(SYSTEM, '2018', txp, ['complete'], null, false, true)).rejects.toBeTruthy();
    await ctx.closeProviders();
    expect(factory.builds).toBe(1);
    expect(factory.open).toBe(0);
  });

  test('findCodeSystem closes the provider when the client goes while it is built', async () => {
    const tx = getTxModule();
    const ctx = new OperationContext('en', tx.i18n, 'w', 20, null, null);
    ctx.debugging = false;
    const w = new TerminologyWorker(ctx, tx.log, tx.endpoints[0].provider, tx.languages, tx.i18n);
    w.additionalResources = [{ resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/other' }];
    const txp = new TxParameters(tx.i18n.languageDefinitions, tx.i18n);
    factory.delayMs = 50;
    setTimeout(() => ctx.markClientGone(), 10);
    // no version asked for: the supplements are looked at again for the version built, which
    // sees the client has gone
    await expect(w.findCodeSystem(SYSTEM, '', txp, ['complete'], null, false, true)).rejects.toMatchObject({ abandoned: true });
    await ctx.closeProviders();
    expect(factory.builds).toBe(1);
    expect(factory.open).toBe(0);
  });

  test.each([
    ['$expand', ['US', 'CA', 'GB', 'DE'], []],
    ['$validate-code', ['CA', 'GB', 'DE', 'FR'], [{ name: 'coding', valueCoding: { system: SYSTEM, code: 'US' } }]]
  ])('%s over 200 includes of one code system builds its provider once', async (op, codes, extra) => {
    const vs = { resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/many-' + op.substring(1), status: 'active',
      compose: { include: Array.from({ length: 200 }, (_, i) => ({ system: SYSTEM, concept: [{ code: codes[i % 4] }] })) } };
    const res = await request(app).post('/tx/r5/ValueSet/' + op).set('Content-Type', 'application/json')
      .send({ resourceType: 'Parameters', parameter: [{ name: 'valueSet', resource: vs }, ...extra] });
    expect(res.status).toBe(200);
    expect(factory.builds).toBe(1);
    expect(factory.open).toBe(0);
  });

  test('a $validate-code of a CodeableConcept with many codings stops when the client goes', async () => {
    const tx = getTxModule();
    const ctx = new OperationContext('en', tx.i18n, 'z', 30, null, null);
    ctx.debugging = false;
    const worker = new ValidateWorker(ctx, tx.log, tx.endpoints[0].provider, tx.languages, tx.i18n);
    const coding = Array.from({ length: 20000 }, (_, i) => ({ system: SYSTEM, code: 'X' + i }));
    const params = { resourceType: 'Parameters', parameter: [{ name: 'codeableConcept', valueCodeableConcept: { coding } }] };
    setTimeout(() => ctx.markClientGone(), 50);
    const t0 = Date.now();
    await expect(worker.handleCodeSystemInner(params)).rejects.toMatchObject({ abandoned: true });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
