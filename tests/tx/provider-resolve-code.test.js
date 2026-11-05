/**
 * resolveCode is asked about every code a page shows, so it must not build the code
 * system once per code: for a database-backed code system each build opens a connection
 * that stays open until the request ends. It builds one provider per code system and
 * version in an operation, and reuses it.
 *
 * It also has to wait for locate(), which is async, so that what a code resolves to is
 * the concept that was found, with its display.
 */

const { Provider } = require('../../tx/provider');
const { OperationContext } = require('../../tx/operation-context');
const { Languages } = require('../../library/languages');
const { CodeSystemFactoryProvider } = require('../../tx/cs/cs-api');

const SYSTEM = 'http://example.org/states';
const CODES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona' };

/** A factory whose providers find CODES, counting how many it builds. */
function fakeFactory({ iteratable = true, codeLink = () => undefined, id = 'states' } = {}) {
  const factory = {
    builds: 0,
    closed: 0,
    id: () => id,
    iteratable: () => iteratable,
    codeLink,
    async build() {
      factory.builds++;
      return {
        async locate(code) {
          return CODES[code] ? { context: { code, display: CODES[code] }, message: null } : { context: null, message: 'not found' };
        },
        async display(context) {
          return context.display;
        },
        async close() {
          factory.closed++;
        },
      };
    },
  };
  return factory;
}

function providerWith(factories) {
  // Building a real Provider means building a library; resolveCode needs only these.
  const provider = Object.create(Provider.prototype);
  provider.path = '/tx/r4';
  provider.codeSystemFactories = new Map(Object.entries(factories));
  provider.codeSystems = new Map();
  return provider;
}

const newContext = () => new OperationContext(new Languages(null));

describe('resolveCode', () => {
  test('builds the provider once for many codes of one system', async () => {
    const factory = fakeFactory();
    const provider = providerWith({ [SYSTEM]: factory });
    const opContext = newContext();
    for (let i = 0; i < 50; i++) {
      for (const code of Object.keys(CODES)) {
        await provider.resolveCode(opContext, SYSTEM, null, code);
      }
    }
    expect(factory.builds).toBe(1);
    // ...and registers it once, so it is closed once when the operation ends.
    await opContext.closeProviders();
    expect(factory.closed).toBe(1);
  });

  test('calls that overlap share one build', async () => {
    const factory = fakeFactory();
    const provider = providerWith({ [SYSTEM]: factory });
    const opContext = newContext();
    const results = await Promise.all(Object.keys(CODES).map((code) => provider.resolveCode(opContext, SYSTEM, null, code)));
    expect(factory.builds).toBe(1);
    expect(results.map((r) => r.description)).toEqual(Object.values(CODES));
  });

  test('builds once per system and version, and again for another operation', async () => {
    const v1 = fakeFactory();
    const v2 = fakeFactory();
    const provider = providerWith({ [SYSTEM + '|1']: v1, [SYSTEM + '|2']: v2 });
    const a = newContext();
    await provider.resolveCode(a, SYSTEM, '1', 'AL');
    await provider.resolveCode(a, SYSTEM + '|1', null, 'AK');
    await provider.resolveCode(a, SYSTEM, '2', 'AL');
    expect([v1.builds, v2.builds]).toEqual([1, 1]);
    await provider.resolveCode(newContext(), SYSTEM, '1', 'AL');
    expect(v1.builds).toBe(2);
  });

  test("waits for locate(), so a code comes back with the concept's display", async () => {
    const provider = providerWith({ [SYSTEM]: fakeFactory() });
    expect(await provider.resolveCode(newContext(), SYSTEM, null, 'AK'))
      .toEqual({ link: '/tx/r4/CodeSystem/x-states', description: 'Alaska' });
  });

  test('a code the code system does not have resolves to nothing', async () => {
    const provider = providerWith({ [SYSTEM]: fakeFactory() });
    expect(await provider.resolveCode(newContext(), SYSTEM, null, 'XX')).toBeNull();
  });

  test("a factory's codeLink is given the concept that was found", async () => {
    const seen = [];
    const factory = fakeFactory({
      iteratable: false,
      codeLink: (c) => { seen.push(c); return 'https://example.org/browse/' + c.code; },
    });
    const provider = providerWith({ [SYSTEM]: factory });
    expect(await provider.resolveCode(newContext(), SYSTEM, null, 'AZ'))
      .toEqual({ link: 'https://example.org/browse/AZ', description: 'Arizona' });
    expect(seen).toEqual([{ code: 'AZ', display: 'Arizona' }]);
  });

  test('a build that fails is tried again on the next call', async () => {
    const factory = fakeFactory();
    const build = factory.build;
    let fail = true;
    factory.build = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error('no database');
      }
      return build(...args);
    };
    const provider = providerWith({ [SYSTEM]: factory });
    const opContext = newContext();
    await expect(provider.resolveCode(opContext, SYSTEM, null, 'AL')).rejects.toThrow('no database');
    expect((await provider.resolveCode(opContext, SYSTEM, null, 'AL')).description).toBe('Alabama');
  });
});

/** A factory whose locate() waits until released, recording how many run at once. */
function slowFactory() {
  const factory = fakeFactory();
  const build = factory.build;
  factory.inFlight = 0;
  factory.maxInFlight = 0;
  factory.locates = 0;
  factory.build = async (...args) => {
    const csp = await build(...args);
    const locate = csp.locate;
    csp.locate = async (code) => {
      factory.locates++;
      factory.inFlight++;
      factory.maxInFlight = Math.max(factory.maxInFlight, factory.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      factory.inFlight--;
      return locate(code);
    };
    return csp;
  };
  return factory;
}

describe('resolveCodes', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => Object.keys(CODES)[i % 3]);

  test('builds the provider once, and locates the codes several at a time but not all at once', async () => {
    const factory = slowFactory();
    const provider = providerWith({ [SYSTEM]: factory });
    const results = await provider.resolveCodes(newContext(), SYSTEM, null, many(100));
    expect(factory.builds).toBe(1);
    expect(factory.locates).toBe(100);
    expect(factory.maxInFlight).toBeGreaterThan(1);
    expect(factory.maxInFlight).toBeLessThanOrEqual(8);
    // ...and the answers come back in the order of the codes.
    expect(results.map((r) => r.description)).toEqual(many(100).map((c) => CODES[c]));
  });

  test('one build per code system across a page, however the codes are asked for', async () => {
    const a = slowFactory();
    const b = slowFactory();
    const provider = providerWith({ [SYSTEM + '|a']: a, [SYSTEM + '|b']: b });
    const opContext = newContext();
    await Promise.all([
      provider.resolveCodes(opContext, SYSTEM, 'a', many(30)),
      provider.resolveCodes(opContext, SYSTEM, 'b', many(30)),
      provider.resolveCodes(opContext, SYSTEM, 'a', many(30)),
      provider.resolveCode(opContext, SYSTEM, 'b', 'AL'),
    ]);
    expect([a.builds, b.builds]).toEqual([1, 1]);
  });

  test('a code it does not have is null, in its place', async () => {
    const provider = providerWith({ [SYSTEM]: fakeFactory() });
    const results = await provider.resolveCodes(newContext(), SYSTEM, null, ['AL', 'XX', 'AZ']);
    expect(results.map((r) => r && r.description)).toEqual(['Alabama', null, 'Arizona']);
  });

  test('no codes, no build', async () => {
    const factory = fakeFactory();
    const provider = providerWith({ [SYSTEM]: factory });
    expect(await provider.resolveCodes(newContext(), SYSTEM, null, [])).toEqual([]);
    expect(factory.builds).toBe(0);
  });

  test('a code system that cannot link a code is not built or asked', async () => {
    // Like RxNorm or LOINC: not iteratable, and codeLink() is the default, which links nothing.
    const factory = Object.assign(Object.create(CodeSystemFactoryProvider.prototype), {
      builds: 0,
      id: () => 'db',
      async build() { factory.builds++; throw new Error('should not be built'); },
    });
    const provider = providerWith({ [SYSTEM]: factory });
    // A CodeSystem resource for the same system still gives its codes a link.
    provider.codeSystems.set(SYSTEM, { id: 'states-cs', codeMap: new Map([['AL', { display: 'Alabama' }]]) });
    const results = await provider.resolveCodes(newContext(), SYSTEM, null, ['AL', 'AK']);
    expect(factory.builds).toBe(0);
    expect(results).toEqual([{ link: '/tx/r4/CodeSystem/states-cs#AL', description: 'Alabama' }, null]);
  });
});
