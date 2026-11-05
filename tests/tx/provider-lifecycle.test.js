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
});
