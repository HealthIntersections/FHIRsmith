// How the ecosystem resolver reaches other servers (tx/ecosystem-resolver.js): https:// first for
// an address given as http://, redirects followed under the SSRF guard, and only URIs looked for

const nock = require('nock');
const { EcosystemResolver } = require('../../tx/ecosystem-resolver');

const REG = 'https://reg.example';

function resolver(extra = {}) {
  return new EcosystemResolver(Object.assign({ use: true, registry: `${REG}/tx-reg` }, extra));
}

// the registry's list of servers: none has credentials unless the test gives some
function mockListing(results = []) {
  return nock(REG).get('/tx-reg').query(true).reply(200, { results }).persist();
}

describe('EcosystemResolver transport', () => {
  beforeAll(() => nock.disableNetConnect());
  afterEach(() => nock.cleanAll());
  afterAll(() => nock.enableNetConnect());

  describe('only a URI is looked for', () => {
    test.each([
      ['1'], ['PRESCRIPTION_TYPE'], ['not a uri with spaces'], ['http://exa mple.org/x'],
      ['894894896|http://snomed.info/sct/900000000000207008/version/20250201'], [''], [null]
    ])('%s is not', async (system) => {
      expect(EcosystemResolver.isUri(system)).toBe(false);
      const scope = nock(REG).get(/.*/).query(true).reply(200, {});
      expect(await resolver().findServers(system, null, 5)).toBeNull();
      expect(scope.isDone()).toBe(false);
    });

    test.each([
      ['http://snomed.info/sct'], ['https://example.org/fhir/CodeSystem/x'], ['urn:oid:2.16.840.1.113883.6.238'],
      ['urn:uuid:3c7e1a6e-6c2b-4f39-9f0c-1f0e9f1d2a11'], ['urn:iso:std:iso:3166'], ['doi:10.1016/S0735-1097(99)00126-6']
    ])('%s is', (system) => {
      expect(EcosystemResolver.isUri(system)).toBe(true);
    });
  });

  describe('https first', () => {
    test('an http:// server is asked over https:// when it answers there', async () => {
      mockListing();
      const secure = nock('https://both.example').get('/fhir/metadata').reply(200, { resourceType: 'CapabilityStatement' });
      const plain = nock('http://both.example').get('/fhir/metadata').reply(200, { resourceType: 'Plain' });
      const res = await resolver().send('http://both.example/fhir', 'http://both.example/fhir/metadata');
      expect(res.json.resourceType).toBe('CapabilityStatement');
      expect(secure.isDone()).toBe(true);
      expect(plain.isDone()).toBe(false);
    });

    test('any answer over https:// is the answer: a 404 is not a reason to try http://', async () => {
      mockListing();
      nock('https://both.example').get('/fhir/CodeSystem').query(true).reply(404, { resourceType: 'OperationOutcome' });
      const plain = nock('http://both.example').get('/fhir/CodeSystem').query(true).reply(200, {});
      const res = await resolver().send('http://both.example/fhir', 'http://both.example/fhir/CodeSystem?url=x');
      expect(res.status).toBe(404);
      expect(plain.isDone()).toBe(false);
    });

    test('a server with no https:// is asked over http://, and that is remembered', async () => {
      mockListing();
      const r = resolver();
      // https://plain.example isn't mocked: no connection
      nock('http://plain.example').get('/fhir/metadata').times(2).reply(200, { resourceType: 'CapabilityStatement' });
      expect((await r.send('http://plain.example/fhir', 'http://plain.example/fhir/metadata')).status).toBe(200);
      expect(r.schemes.get('plain.example').scheme).toBe('http');
      // the second time, https:// isn't tried: if it were, this would answer it
      const secure = nock('https://plain.example').get('/fhir/metadata').reply(200, {});
      expect((await r.send('http://plain.example/fhir', 'http://plain.example/fhir/metadata')).status).toBe(200);
      expect(secure.isDone()).toBe(false);
    });

    test('an https:// address is only ever asked over https://', async () => {
      mockListing();
      const plain = nock('http://secure.example').get(/.*/).reply(200, {});
      await expect(resolver().send('https://secure.example/fhir', 'https://secure.example/fhir/metadata'))
        .rejects.toThrow(/secure\.example/);
      expect(plain.isDone()).toBe(false);
    });
  });

  describe('redirects', () => {
    test('are followed', async () => {
      mockListing();
      nock('https://moved.example').get('/r4/metadata').reply(308, '', { Location: 'https://moved.example/fhir/r4/metadata' });
      nock('https://moved.example').get('/fhir/r4/metadata').reply(200, { resourceType: 'CapabilityStatement' });
      const res = await resolver().send('https://moved.example/r4', 'https://moved.example/r4/metadata');
      expect(res.status).toBe(200);
      expect(res.json.resourceType).toBe('CapabilityStatement');
    });

    test('to another host, too, when the request has no credentials', async () => {
      mockListing();
      nock('https://old.example').get('/fhir/metadata').reply(301, '', { Location: 'https://new.example/fhir/metadata' });
      nock('https://new.example').get('/fhir/metadata').reply(200, { resourceType: 'CapabilityStatement' });
      expect((await resolver().send('https://old.example/fhir', 'https://old.example/fhir/metadata')).status).toBe(200);
    });

    test('but with credentials, only on the same host', async () => {
      mockListing([{ url: 'https://keyed.example/fhir', 'server-code': 'keyed' }]);
      const r = resolver({ apiKeys: { keyed: 'secret' } });
      nock('https://keyed.example').get('/fhir/metadata').reply(302, '', { Location: 'https://elsewhere.example/fhir/metadata' });
      const elsewhere = nock('https://elsewhere.example').get('/fhir/metadata').reply(200, {});
      await expect(r.send('https://keyed.example/fhir', 'https://keyed.example/fhir/metadata'))
        .rejects.toThrow(/redirects to another host \(elsewhere\.example\)/);
      expect(elsewhere.isDone()).toBe(false);
      // the same host is fine
      nock('https://keyed.example').get('/fhir/metadata').reply(302, '', { Location: 'https://keyed.example/fhir/r4/metadata' });
      nock('https://keyed.example').get('/fhir/r4/metadata').reply(200, { resourceType: 'CapabilityStatement' });
      expect((await r.send('https://keyed.example/fhir', 'https://keyed.example/fhir/metadata')).status).toBe(200);
    });

    test('not endlessly', async () => {
      mockListing();
      nock('https://loop.example').get('/a').times(10).reply(302, '', { Location: 'https://loop.example/a' });
      await expect(resolver().send('https://loop.example', 'https://loop.example/a')).rejects.toThrow(/loop\.example/);
    });
  });
});
