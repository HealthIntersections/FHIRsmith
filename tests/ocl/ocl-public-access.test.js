const { PublicAccessChecker, isPublicAccess, mapLimit } = require('../../tx/ocl/resolve/public-access');

function silentLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('isPublicAccess', () => {
  it.each([['View'], ['Edit'], ['view'], ['edit']])('accepts %s', v => {
    expect(isPublicAccess(v)).toBe(true);
  });
  it.each([['None'], [''], [null], [undefined], ['private']])('rejects %p (fail-closed)', v => {
    expect(isPublicAccess(v)).toBe(false);
  });
});

describe('PublicAccessChecker', () => {
  it('requires an http client', () => {
    expect(() => new PublicAccessChecker({})).toThrow(/requires an http client/);
  });

  it('uses an inline public_access without a GET', async () => {
    const httpClient = { get: jest.fn() };
    const checker = new PublicAccessChecker({ httpClient, logger: silentLogger() });

    expect(await checker.isPublic('/orgs/A/sources/S/', 'View')).toBe(true);
    expect(await checker.isPublic('/orgs/A/sources/S/', 'None')).toBe(false);
    expect(httpClient.get).not.toHaveBeenCalled();
  });

  it('fetches the repo once and caches the result by repoUrl', async () => {
    const httpClient = { get: jest.fn(async () => ({ data: { public_access: 'View' } })) };
    const checker = new PublicAccessChecker({ httpClient, logger: silentLogger() });

    expect(await checker.isPublic('/orgs/A/sources/S/')).toBe(true);
    expect(await checker.isPublic('/orgs/A/sources/S/')).toBe(true);
    expect(httpClient.get).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('treats a private repo (public_access None) as not public', async () => {
    const httpClient = { get: jest.fn(async () => ({ data: { public_access: 'None' } })) };
    const checker = new PublicAccessChecker({ httpClient, logger: silentLogger() });

    const { public: pub, determined } = await checker.check('/orgs/A/sources/S/');
    expect(pub).toBe(false);
    expect(determined).toBe(true);
  });

  it('does NOT cache a check that errored, and reports it undetermined', async () => {
    const httpClient = {
      get: jest.fn()
        .mockRejectedValueOnce(new Error('network blip'))
        .mockResolvedValueOnce({ data: { public_access: 'View' } })
    };
    const logger = silentLogger();
    const checker = new PublicAccessChecker({ httpClient, logger });

    const first = await checker.check('/orgs/A/sources/S/');
    expect(first).toEqual({ public: false, determined: false });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/public_access check failed/));

    // Not cached: the next call retries and now succeeds.
    const second = await checker.check('/orgs/A/sources/S/');
    expect(second).toEqual({ public: true, determined: true });
    expect(httpClient.get).toHaveBeenCalledTimes(2);
  });

  it('filterPublic keeps only publicly-viewable repos', async () => {
    const httpClient = {
      get: jest.fn(async (url) => ({ data: { public_access: url.includes('Priv') ? 'None' : 'View' } }))
    };
    const checker = new PublicAccessChecker({ httpClient, logger: silentLogger() });

    const items = [
      { url: '/orgs/A/sources/Pub1/' },
      { url: '/orgs/A/sources/Priv/' },
      { url: '/orgs/A/sources/Pub2/' }
    ];
    const kept = await checker.filterPublic(items);

    expect(kept.map(i => i.url)).toEqual(['/orgs/A/sources/Pub1/', '/orgs/A/sources/Pub2/']);
  });

  it('filterPublic prefers an inline public_access over a GET', async () => {
    const httpClient = { get: jest.fn() };
    const checker = new PublicAccessChecker({ httpClient, logger: silentLogger() });

    const kept = await checker.filterPublic([
      { url: '/orgs/A/sources/S/', public_access: 'View' },
      { url: '/orgs/A/sources/P/', public_access: 'None' }
    ]);

    expect(kept.map(i => i.url)).toEqual(['/orgs/A/sources/S/']);
    expect(httpClient.get).not.toHaveBeenCalled();
  });
});

describe('mapLimit', () => {
  it('preserves order and never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fn = async (x) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 1));
      inFlight--;
      return x * 2;
    };

    const result = await mapLimit([1, 2, 3, 4, 5, 6, 7], 2, fn);

    expect(result).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });
});
