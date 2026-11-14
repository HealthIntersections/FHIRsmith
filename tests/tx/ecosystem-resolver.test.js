// Finding and talking to other servers in the terminology ecosystem, for code systems that
// aren't held here (tx/ecosystem-resolver.js; modules.tx.ecosystem in tx/README.md)

const http = require('http');
const nock = require('nock');
const { EcosystemResolver, FORWARDED_HEADER } = require('../../tx/ecosystem-resolver');

const REG = 'https://reg.example';
const SCT = 'http://snomed.info/sct';
const EE = 'http://snomed.info/sct/11000181102';
const OPEN = 'https://open.example/fhir';
const KEYED = 'https://keyed.example/fhir';
const OAUTH = 'https://oauth.example/fhir';
const TOKEN_HOST = 'https://auth.example';
const TOKEN_PATH = '/token';

function resolver(extra = {}) {
  return new EcosystemResolver(Object.assign({ use: true, registry: `${REG}/tx-reg` }, extra));
}

// the registry's list of servers, which gives the codes credentials are under
function mockListing() {
  return nock(REG).get('/tx-reg').query(true).reply(200, { results: [
    { url: OPEN, 'server-code': 'open' },
    { url: KEYED, 'server-code': 'hl7-ca' },
    { url: OAUTH, 'server-code': 'nzhts' },
    { url: 'http://tx.fhir.org/r5', 'server-code': 'tx.fhir.org' }
  ] });
}

function mockResolve(url, body) {
  return nock(REG).get('/tx-reg/resolve').query(q => q.url === url).reply(200, body);
}

describe('EcosystemResolver', () => {
  beforeAll(() => nock.disableNetConnect());
  afterEach(() => nock.cleanAll());
  afterAll(() => nock.enableNetConnect());

  describe('configuration', () => {
    test('not used unless use is true', () => {
      expect(EcosystemResolver.checkConfig(undefined)).toBeNull();
      expect(EcosystemResolver.checkConfig({ use: false })).toBeNull();
      expect(EcosystemResolver.checkConfig({ excludedServers: ['tx.fhir.org'] })).toBeNull();
      expect(EcosystemResolver.checkConfig({ use: true })).toEqual({ use: true });
    });

    test('says what is wrong', () => {
      expect(() => EcosystemResolver.checkConfig(true)).toThrow(/modules.tx.ecosystem: must be an object/);
      expect(() => EcosystemResolver.checkConfig({ use: 'yes' })).toThrow(/use must be true or false/);
      expect(() => EcosystemResolver.checkConfig({ use: true, excludedServers: 'tx.fhir.org' })).toThrow(/excludedServers must be a list/);
      expect(() => EcosystemResolver.checkConfig({ use: true, excludedPatterns: [1] })).toThrow(/excludedPatterns must be a list/);
      expect(() => EcosystemResolver.checkConfig({ use: true, apiKeys: ['x'] })).toThrow(/apiKeys must be an object/);
      expect(() => EcosystemResolver.checkConfig({ use: true, oauth: { nzhts: { tokenEndpoint: 'https://a.example/t' } } })).toThrow(/oauth.nzhts needs/);
      expect(() => EcosystemResolver.checkConfig({ use: true, oauth: { nzhts: { tokenEndpoint: 'http://a.example/t', clientId: 'a', clientSecret: 'b' } } })).toThrow(/must be an https: URL/);
      expect(() => EcosystemResolver.checkConfig({ use: true, registry: 'nowhere' })).toThrow(/registry must be the address/);
    });
  });

  describe('choosing a server', () => {
    test('an excluded pattern is never asked about', async () => {
      const r = resolver({ excludedPatterns: ['http://hl7.org/*', 'http://terminology.hl7.org/*'] });
      const scope = nock(REG).get(/.*/).query(true).reply(200, {});
      expect(await r.findServer('http://terminology.hl7.org/CodeSystem/v3-ActCode', '11.0.0', 5)).toBeNull();
      expect(await r.findServer('http://hl7.org/fhir/test/CodeSystem/simple', null, 5)).toBeNull();
      expect(scope.isDone()).toBe(false);
    });

    test('a pattern can name a version (an edition)', () => {
      const r = resolver({ excludedPatterns: [`${SCT}|${EE}*`] });
      expect(r.isExcludedSystem(SCT, `${EE}/version/20260530`)).toBe(true);
      expect(r.isExcludedSystem(SCT, 'http://snomed.info/sct/11000279109')).toBe(false);
      expect(r.isExcludedSystem(SCT, null)).toBe(false);
    });

    test('an excluded server is passed over', async () => {
      const r = resolver({ excludedServers: ['tx.fhir.org'] });
      mockListing();
      mockResolve(`${SCT}|${EE}`, { authoritative: [{ url: OPEN, open: true }], candidates: [{ url: 'http://tx.fhir.org/r5', open: true }] });
      expect(await r.findServer(SCT, EE, 5)).toBe(OPEN);
      mockResolve(SCT, { candidates: [{ url: 'http://tx.fhir.org/r5', open: true }, { url: OPEN, open: true }] });
      expect(await r.findServer(SCT, null, 5)).toBe(OPEN);
    });

    // e.g. tx.fhir.org is authoritative for ICD-11, and is asked for a version of it that it
    // doesn't have: the answer is that it doesn't have it, not what another server says
    test('nothing is looked for elsewhere when an excluded server is authoritative', async () => {
      const r = resolver({ excludedServers: ['tx.fhir.org'] });
      const ICD = 'http://id.who.int/icd/release/11/mms';
      mockListing();
      mockResolve(`${ICD}|2020-01`, { authoritative: [{ url: 'http://tx.fhir.org/r4', open: true }], candidates: [{ url: OPEN, open: true }] });
      expect(await r.findServer(ICD, '2020-01', 4)).toBeNull();
    });

    test('a server that needs credentials is used only if there are some', async () => {
      const without = resolver();
      mockListing();
      mockResolve(`${SCT}|${EE}`, { authoritative: [{ url: KEYED, security: 'api-key', token: true }] });
      mockResolve(`${SCT}|${EE}`, { authoritative: [{ url: KEYED, security: 'api-key', token: true }] }); // asked for 4.0 as well
      expect(await without.findServer(SCT, EE, 5)).toBeNull();

      const withKey = resolver({ apiKeys: { 'hl7-ca': 'key-1' } });
      mockListing();
      mockResolve(`${SCT}|${EE}`, { authoritative: [{ url: KEYED, security: 'api-key', token: true }] });
      expect(await withKey.findServer(SCT, EE, 5)).toBe(KEYED);
    });

    test('a candidate without the content is passed over', async () => {
      const r = resolver();
      mockListing();
      mockResolve(SCT, { candidates: [{ url: KEYED, open: true, content: 'not-present' }, { url: OPEN, open: true, content: 'complete' }] });
      expect(await r.findServer(SCT, null, 5)).toBe(OPEN);
    });

    // a server that holds the concepts in its own tables, and says not-present, has to be
    // registered as authoritative to be used
    test('an authoritative server is used whatever the registry says about the content', async () => {
      const r = resolver();
      mockListing();
      mockResolve(`${SCT}|${EE}`, { authoritative: [{ url: KEYED, open: true, content: 'not-present' }],
        candidates: [{ url: OPEN, open: true, content: 'not-present' }, { url: OAUTH, open: true }] });
      expect(await r.findServers(SCT, EE, 5)).toEqual([{ url: KEYED, authoritative: true }, { url: OAUTH, authoritative: false }]);
    });
  });

  describe('talking to a server', () => {
    test('marks the request as forwarded, and sends an API key', async () => {
      const r = resolver({ apiKeys: { 'hl7-ca': 'key-1' } });
      mockListing();
      const server = nock('https://keyed.example', { reqheaders: { 'api-key': 'key-1', [FORWARDED_HEADER.toLowerCase()]: 'true' } })
        .get('/fhir/CodeSystem/$lookup').query(true).reply(200, { resourceType: 'Parameters' });
      const res = await r.send(KEYED, `${KEYED}/CodeSystem/$lookup?system=x&code=y`);
      expect(res.status).toBe(200);
      expect(res.json.resourceType).toBe('Parameters');
      expect(server.isDone()).toBe(true);
    });

    test('sends no credentials to an open server', async () => {
      const r = resolver({ apiKeys: { 'hl7-ca': 'key-1' } });
      mockListing();
      const server = nock('https://open.example', { badheaders: ['api-key', 'authorization'] })
        .get('/fhir/metadata').query(true).reply(200, { resourceType: 'TerminologyCapabilities' });
      expect((await r.send(OPEN, `${OPEN}/metadata?mode=terminology`)).status).toBe(200);
      expect(server.isDone()).toBe(true);
    });

    test('gets an OAuth token, and renews it once if the server refuses it', async () => {
      const r = resolver({ oauth: { nzhts: { tokenEndpoint: TOKEN_HOST + TOKEN_PATH, clientId: 'hl7', clientSecret: 'secret' } } });
      mockListing();
      nock(TOKEN_HOST).post(TOKEN_PATH).reply(200, { access_token: 'tok-1', expires_in: 3600, token_type: 'Bearer' });
      nock(TOKEN_HOST).post(TOKEN_PATH).reply(200, { access_token: 'tok-2', expires_in: 3600, token_type: 'Bearer' });
      const refused = nock('https://oauth.example', { reqheaders: { authorization: 'Bearer tok-1' } })
        .post('/fhir/ValueSet/$validate-code').reply(401, {});
      const accepted = nock('https://oauth.example', { reqheaders: { authorization: 'Bearer tok-2' } })
        .post('/fhir/ValueSet/$validate-code').reply(200, { resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: true }] });
      const res = await r.send(OAUTH, `${OAUTH}/ValueSet/$validate-code`, { resourceType: 'Parameters' });
      expect(res.status).toBe(200);
      expect(refused.isDone()).toBe(true);
      expect(accepted.isDone()).toBe(true);
    });

    test('counts what it sends for an operation, and not what it already knows', async () => {
      const r = resolver();
      const op = { n: 0, countExternalRequest() { this.n++; } };
      mockListing();
      mockResolve(`${SCT}|${EE}`, { authoritative: [], candidates: [{ url: OPEN, open: true }] });
      expect(await r.findServer(SCT, EE, 5, op)).toBe(OPEN);
      // the registry's resolve, and its list of servers isn't needed (the server is open)
      expect(op.n).toBe(1);
      const again = { n: 0, countExternalRequest() { this.n++; } };
      expect(await r.findServer(SCT, EE, 5, again)).toBe(OPEN);
      expect(again.n).toBe(0);
      // an excluded pattern is never asked about: nothing sent
      const excluded = resolver({ excludedPatterns: ['http://hl7.org/*'] });
      const none = { n: 0, countExternalRequest() { this.n++; } };
      expect(await excluded.findServer('http://hl7.org/fhir/sid/x', null, 5, none)).toBeNull();
      expect(none.n).toBe(0);
    });

    test('lists the versions a server has, and which is the default', async () => {
      const r = resolver();
      mockListing();
      nock('https://open.example').get('/fhir/metadata').query({ mode: 'terminology' }).reply(200, { resourceType: 'TerminologyCapabilities', codeSystem: [
        { uri: SCT, version: [{ code: `${EE}/version/20260530`, isDefault: true }, { code: `${EE}/version/20251130` }] },
        { uri: 'http://loinc.org' }
      ] });
      expect(await r.listVersions(OPEN, SCT)).toEqual([
        { code: `${EE}/version/20260530`, isDefault: true }, { code: `${EE}/version/20251130`, isDefault: false }]);
      expect(await r.listVersions(OPEN, 'http://loinc.org')).toEqual([]);
      // not in the TerminologyCapabilities: its CodeSystems are searched for
      nock('https://open.example').get('/fhir/CodeSystem').query(q => q.url === 'http://example.org/not-there').reply(200, { resourceType: 'Bundle', type: 'searchset' });
      expect(await r.listVersions(OPEN, 'http://example.org/not-there')).toBeNull();
      expect(nock.isDone()).toBe(true);
    });

    // the same test the validator applies: the content has to be complete or fragment. What the
    // TerminologyCapabilities says comes first; the server's CodeSystems are only searched for
    // when it doesn't say the content is there
    test('the content the TerminologyCapabilities states is used, without searching', async () => {
      const r = resolver();
      mockListing();
      nock('https://open.example').get('/fhir/metadata').query({ mode: 'terminology' }).reply(200, { resourceType: 'TerminologyCapabilities', codeSystem: [
        // R4: the content is in the cross-version extension
        { uri: 'http://example.org/r4', version: [{ code: '1' }], extension: [{ url: 'http://hl7.org/fhir/5.0/StructureDefinition/extension-TerminologyCapabilities.codeSystem.content', valueCode: 'complete' }] },
        { uri: 'http://example.org/r5', version: [{ code: '2' }], content: 'fragment' },
        // listed, and doesn't say: it's there
        { uri: 'http://example.org/unsaid', version: [{ code: '3' }] }
      ] });
      const search = nock('https://open.example').get('/fhir/CodeSystem').query(true).reply(200, { resourceType: 'Bundle' });
      expect(await r.listVersions(OPEN, 'http://example.org/r4')).toEqual([{ code: '1', isDefault: false }]);
      expect(await r.listVersions(OPEN, 'http://example.org/r5')).toEqual([{ code: '2', isDefault: false }]);
      expect(await r.listVersions(OPEN, 'http://example.org/unsaid')).toEqual([{ code: '3', isDefault: false }]);
      expect(search.isDone()).toBe(false);
    });

    test('a code system the TerminologyCapabilities doesn\'t list, or says has no content, is searched for', async () => {
      const r = resolver();
      mockListing();
      nock('https://open.example').get('/fhir/metadata').query({ mode: 'terminology' }).reply(200, { resourceType: 'TerminologyCapabilities', codeSystem: [
        { uri: 'http://example.org/tables', version: [{ code: '1' }], content: 'not-present' }
      ] });
      // a server that holds the codes in its own tables, and says so in the CodeSystem too
      nock('https://open.example').get('/fhir/CodeSystem').query(q => q.url === 'http://example.org/tables' && q._summary === 'true').reply(200, { resourceType: 'Bundle', entry: [
        { resource: { resourceType: 'CodeSystem', url: 'http://example.org/tables', version: '1', content: 'not-present' } }
      ] });
      nock('https://open.example').get('/fhir/CodeSystem').query(q => q.url === 'http://example.org/unlisted').reply(200, { resourceType: 'Bundle', entry: [
        { resource: { resourceType: 'CodeSystem', url: 'http://example.org/unlisted', version: '2024', content: 'complete' } },
        { resource: { resourceType: 'CodeSystem', url: 'http://example.org/unlisted', version: '2025', content: 'fragment' } },
        { resource: { resourceType: 'CodeSystem', url: 'http://example.org/unlisted', version: '2023', content: 'example' } }
      ] });
      expect(await r.listVersions(OPEN, 'http://example.org/tables')).toBeNull();
      expect(await r.listVersions(OPEN, 'http://example.org/unlisted')).toEqual([{ code: '2024', isDefault: false }, { code: '2025', isDefault: false }]);
      expect(nock.isDone()).toBe(true);
      // and what the search found is kept
      expect(await r.listVersions(OPEN, 'http://example.org/unlisted')).toEqual([{ code: '2024', isDefault: false }, { code: '2025', isDefault: false }]);
      // for an authoritative server, what it says about the content doesn't matter
      expect(await r.listVersions(OPEN, 'http://example.org/tables', null, true)).toEqual([{ code: '1', isDefault: false }]);
    });
  });

  describe('what is kept', () => {
    const LOOKUP = `${OPEN}/CodeSystem/$lookup?system=x&code=1`;
    const op = () => ({ n: 0, countExternalRequest() { this.n++; } });

    test('an answer is asked for once, and the same question asked at once is sent once', async () => {
      const r = resolver();
      mockListing();
      const scope = nock('https://open.example').get('/fhir/CodeSystem/$lookup').query(true).once()
        .delay(50).reply(200, { resourceType: 'Parameters', parameter: [{ name: 'display', valueString: 'one' }] });
      const a = op();
      const b = op();
      const [x, y] = await Promise.all([r.sendCached(OPEN, LOOKUP, null, a), r.sendCached(OPEN, LOOKUP, null, b)]);
      expect(x.json.parameter[0].valueString).toBe('one');
      expect(y).toBe(x);
      expect(scope.isDone()).toBe(true);
      // both waited for the other server (the first for the registry's list of servers as well);
      // the next asks no one
      expect(a.n).toBe(2);
      expect(b.n).toBe(1);
      const c = op();
      expect((await r.sendCached(OPEN, LOOKUP, null, c)).json.parameter[0].valueString).toBe('one');
      expect(c.n).toBe(0);
    });

    test('a 4xx answer is kept, a 5xx or a failure is not', async () => {
      const r = resolver();
      mockListing();
      nock('https://open.example').get('/fhir/CodeSystem/$lookup').query(q => q.code === '404').once().reply(404, { resourceType: 'OperationOutcome' });
      nock('https://open.example').get('/fhir/CodeSystem/$lookup').query(q => q.code === '500').twice().reply(500, {});
      expect((await r.sendCached(OPEN, `${OPEN}/CodeSystem/$lookup?code=404`)).status).toBe(404);
      expect((await r.sendCached(OPEN, `${OPEN}/CodeSystem/$lookup?code=404`)).status).toBe(404);
      expect((await r.sendCached(OPEN, `${OPEN}/CodeSystem/$lookup?code=500`)).status).toBe(500);
      expect((await r.sendCached(OPEN, `${OPEN}/CodeSystem/$lookup?code=500`)).status).toBe(500);
      expect(nock.isDone()).toBe(true);
    });

    test('after an hour, what the registry said is used while it is asked again in the background', async () => {
      let now = 1800000000000;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const r = resolver();
        mockResolve(`${SCT}|${EE}`, { candidates: [{ url: OPEN, open: true }] });
        expect(await r.findServer(SCT, EE, 5)).toBe(OPEN);
        now += 61 * 60 * 1000;
        let answer;
        const refreshed = new Promise(resolve => {
          nock(REG).get('/tx-reg/resolve').query(true).reply(() => { setImmediate(resolve); answer = true; return [200, { candidates: [{ url: KEYED, open: true }] }]; });
        });
        // the old answer, without waiting, and not counted against the request
        const o = op();
        expect(await r.findServer(SCT, EE, 5, o)).toBe(OPEN);
        expect(o.n).toBe(0);
        await refreshed;
        expect(answer).toBe(true);
        // once the refresh is in
        let found;
        for (let i = 0; i < 100 && found !== KEYED; i++) {
          await new Promise(resolve => setTimeout(resolve, 10));
          found = await r.findServer(SCT, EE, 5);
        }
        expect(found).toBe(KEYED);
      } finally {
        clock.mockRestore();
      }
    });

    test('a refresh that fails keeps the old answer', async () => {
      let now = 1800000000000;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const r = resolver();
        mockListing();
        nock('https://open.example').get('/fhir/metadata').query(true).reply(200, { resourceType: 'TerminologyCapabilities', codeSystem: [{ uri: SCT, version: [{ code: EE }] }] });
        expect(await r.listVersions(OPEN, SCT)).toEqual([{ code: EE, isDefault: false }]);
        now += 61 * 60 * 1000;
        const failed = new Promise(resolve => {
          nock('https://open.example').get('/fhir/metadata').query(true).reply(() => { setImmediate(resolve); return [500, {}]; });
        });
        expect(await r.listVersions(OPEN, SCT)).toEqual([{ code: EE, isDefault: false }]);
        await failed;
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(await r.listVersions(OPEN, SCT)).toEqual([{ code: EE, isDefault: false }]);
      } finally {
        clock.mockRestore();
      }
    });
  });

  // the addresses come from the registry, which may not be the public one: requests only go to
  // public addresses (library/ssrf-guard.js), unless allowPrivateAddresses is set
  describe('the SSRF guard', () => {
    let server;
    let local;
    let hits;
    beforeAll(async () => {
      nock.enableNetConnect('127.0.0.1');
      hits = 0;
      server = http.createServer((req, res) => {
        hits++;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ resourceType: 'TerminologyCapabilities', results: [] }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      local = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(async () => {
      await new Promise(resolve => server.close(resolve));
      nock.disableNetConnect();
    });
    beforeEach(() => { hits = 0; });

    test('a server at a private address is refused', async () => {
      const r = resolver({ registry: `${local}/tx-reg` });
      await expect(r.send(`${local}/fhir`, `${local}/fhir/metadata`)).rejects.toThrow(/non-public address 127.0.0.1/);
      expect(hits).toBe(0);
    });

    test('so is a registry at a private address', async () => {
      const r = resolver({ registry: `${local}/tx-reg` });
      expect(await r.findServer(SCT, null, 5)).toBeNull();
      expect(hits).toBe(0);
    });

    test('unless allowPrivateAddresses is set', async () => {
      const r = resolver({ registry: `${local}/tx-reg`, allowPrivateAddresses: true });
      const res = await r.send(`${local}/fhir`, `${local}/fhir/metadata`);
      expect(res.status).toBe(200);
      expect(hits).toBeGreaterThan(0);
    });

    test('allowPrivateAddresses must be true or false', () => {
      expect(() => EcosystemResolver.checkConfig({ use: true, allowPrivateAddresses: 'yes' }))
        .toThrow('modules.tx.ecosystem: allowPrivateAddresses must be true or false, not "yes"');
    });
  });

  // another server's answer is read into memory: one that is too big, or that never finishes,
  // is a failure, the same as a server that can't be reached
  describe('an answer that is too big or too slow', () => {
    let server;
    let local;
    let timeout;
    beforeAll(async () => {
      nock.enableNetConnect('127.0.0.1');
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.write('{"resourceType":"Parameters","parameter":[');
        if (req.url.includes('huge')) {
          // 12 MB, as fast as it can be taken
          const chunk = JSON.stringify({ name: 'x', valueString: 'y'.repeat(1000) });
          let i = 0;
          const pump = () => {
            while (i < 12000 && res.write((i ? ',' : '') + chunk)) {
              i++;
            }
            if (i < 12000) {
              res.once('drain', pump);
            } else {
              res.end(']}');
            }
          };
          pump();
        } else {
          // a byte now and then, never finishing
          const t = setInterval(() => res.write(' '), 50);
          req.on('close', () => clearInterval(t));
        }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      local = `http://127.0.0.1:${server.address().port}`;
      // the deadline for the whole request, shortened from 30s
      const real = AbortSignal.timeout.bind(AbortSignal);
      timeout = jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => real(500));
    });
    afterAll(async () => {
      timeout.mockRestore();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      nock.disableNetConnect();
    });

    test('a server that sends too much', async () => {
      const r = resolver({ registry: `${local}/huge/tx-reg`, allowPrivateAddresses: true });
      await expect(r.send(`${local}/fhir`, `${local}/huge/fhir/metadata`)).rejects.toThrow(/maxContentLength/);
      expect(await r.findServer(SCT, null, 5)).toBeNull();
    });

    test('a server that never finishes', async () => {
      const r = resolver({ registry: `${local}/slow/tx-reg`, allowPrivateAddresses: true });
      const start = Date.now();
      await expect(r.send(`${local}/fhir`, `${local}/slow/fhir/metadata`)).rejects.toThrow(/canceled/);
      expect(await r.findServer(SCT, null, 5)).toBeNull();
      expect(Date.now() - start).toBeLessThan(5000);
    });
  });
});
