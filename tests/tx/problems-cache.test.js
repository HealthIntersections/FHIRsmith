/**
 * The problems page reads every value set the server has (18,000 from VSAC on tx.fhir.org), so
 * its report is kept: for PROBLEMS_CACHE_MS, or until a value set provider's scanSignature()
 * changes. Requests that come while it is being made wait for that one.
 */
const ProblemFinder = require('../../tx/problems');

const SYSTEM = 'http://example.org/cs';

/** A provider with one value set provider whose value sets ask for SYSTEM|2.0, which isn't there */
function fakeProvider() {
  const vsp = {
    scans: 0,
    signature: 'g1',
    fail: false,
    sourcePackage: () => 'example.pkg#1.0',
    scanSignature: async () => vsp.signature,
    async scanAllValueSets(fn) {
      vsp.scans++;
      // a turn of the event loop, as a real scan takes
      await new Promise(resolve => setImmediate(resolve));
      if (vsp.fail) {
        throw new Error('scan failed');
      }
      await fn({ jsonObj: { compose: { include: [{ system: SYSTEM, version: '2.0' }] } } });
    }
  };
  return {
    vsp,
    valueSetProviders: [vsp],
    listValueSetSourceCodes: () => ['example.pkg#1.0'],
    hasCsVersion: async () => false,
    listCodeSystemVersions: async () => ['1.0']
  };
}

describe('the problems report is kept', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('says what it found', async () => {
    const html = await new ProblemFinder().scanValueSets(fakeProvider());
    expect(html).toContain('example.pkg#1.0');
    expect(html).toContain('2.0');
  });

  test('is not made again for the next view, and requests while it is made share it', async () => {
    const provider = fakeProvider();
    const [a, b] = await Promise.all([new ProblemFinder().scanValueSets(provider), new ProblemFinder().scanValueSets(provider)]);
    expect(a).toBe(b);
    expect(await new ProblemFinder().scanValueSets(provider)).toBe(a);
    expect(provider.vsp.scans).toBe(1);
  });

  test('is made again when a provider says its content changed', async () => {
    const provider = fakeProvider();
    await new ProblemFinder().scanValueSets(provider);
    provider.vsp.signature = 'g2';
    await new ProblemFinder().scanValueSets(provider);
    expect(provider.vsp.scans).toBe(2);
  });

  test('is made again after 15 minutes', async () => {
    const provider = fakeProvider();
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    await new ProblemFinder().scanValueSets(provider);
    clock.mockReturnValue(now + 14 * 60 * 1000);
    await new ProblemFinder().scanValueSets(provider);
    expect(provider.vsp.scans).toBe(1);
    clock.mockReturnValue(now + 16 * 60 * 1000);
    await new ProblemFinder().scanValueSets(provider);
    expect(provider.vsp.scans).toBe(2);
  });

  test('a report that failed is not kept', async () => {
    const provider = fakeProvider();
    provider.vsp.fail = true;
    await expect(new ProblemFinder().scanValueSets(provider)).rejects.toThrow('scan failed');
    provider.vsp.fail = false;
    await new ProblemFinder().scanValueSets(provider);
    expect(provider.vsp.scans).toBe(2);
  });

  test('each provider has its own', async () => {
    const a = fakeProvider();
    const b = fakeProvider();
    await new ProblemFinder().scanValueSets(a);
    await new ProblemFinder().scanValueSets(b);
    expect([a.vsp.scans, b.vsp.scans]).toEqual([1, 1]);
  });
});
