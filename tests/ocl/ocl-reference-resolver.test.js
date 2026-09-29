const {
  OclReferenceResolver,
  normalizeReference,
  isOclRepoPath,
  isOrgOwned,
  RESOLVE_PATH
} = require('../../tx/ocl/resolve/reference-resolver');

function silentLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

// One entry of OCL's $resolveReference response.
//
// Shaped from a real response captured against oclapi2.ips.hsl.org.br, NOT from
// the docs — the documented example shows only {type, short_code, url}, but the
// live payload carries canonical_url, owner_type, version and checksums, and
// reports type "Source" rather than "Source Version".
function oclEntry({
  resolved = true,
  url = '/orgs/MS/sources/BRTabelaSUS/',
  canonicalUrl = 'https://terminologia.saude.gov.br/fhir/CodeSystem/BRTabelaSUS',
  owner = 'MS',
  ownerType = 'Organization',
  registryEntry = null,
  referenceType = 'relative',
  resolutionUrl = null,
  request = null
} = {}) {
  return {
    reference_type: referenceType,
    timestamp: '2026-07-15T17:25:44.682776',
    resolved,
    request,
    resolution_url: resolutionUrl,
    url_registry_entry: registryEntry,
    result: resolved
      ? {
        short_code: url.split('/').filter(Boolean).pop(),
        name: url.split('/').filter(Boolean).pop(),
        url,
        owner,
        owner_type: ownerType,
        owner_url: `/orgs/${owner}/`,
        version: 'HEAD',
        source_type: 'Dictionary',
        canonical_url: canonicalUrl,
        type: 'Source',
        checksums: { standard: '282d3c8ce440b8a03698196967042a08', smart: '90599db3f6da397c1af26baaf9467eb1' }
      }
      : null
  };
}

// Echoes one result per submitted ref, tagging the url so ordering is assertable.
function echoClient() {
  return {
    post: jest.fn(async (path, body) => ({
      data: body.map(ref => {
        const url = typeof ref === 'string' ? ref : ref.url;
        return oclEntry({ url: `/orgs/X/sources/${url}/`, request: ref });
      })
    }))
  };
}

function makeResolver({ httpClient, logger, token = 'Token abc' } = {}) {
  return new OclReferenceResolver({
    httpClient: httpClient || echoClient(),
    logger: logger || silentLogger(),
    token
  });
}

function httpError(status, data) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, data };
  return error;
}

describe('isOclRepoPath (org-only policy)', () => {
  it.each([
    ['/orgs/CIEL/sources/CIEL/'],
    ['/orgs/CIEL/sources/CIEL/HEAD/'],
    ['/orgs/CIEL/collections/C/'],
    ['  /orgs/CIEL/sources/CIEL/  ']
  ])('accepts %s', input => {
    expect(isOclRepoPath(input)).toBe(true);
  });

  it.each([
    // User-owned artifacts are experimental by convention: an artifact is
    // expected to live in an org to be visible through the terminology service.
    ['/users/joe/sources/S/'],
    ['http://loinc.org'],
    ['/sources/S/'],
    ['/orgs/'],
    ['/orgs/CIEL'],
    ['/groups/x/sources/S/'],
    [''],
    [null],
    [undefined]
  ])('rejects %p', input => {
    expect(isOclRepoPath(input)).toBe(false);
  });
});

describe('isOrgOwned', () => {
  it('prefers an explicit owner_type', () => {
    expect(isOrgOwned({ owner_type: 'Organization', url: '/users/joe/sources/S/' })).toBe(true);
    expect(isOrgOwned({ owner_type: 'User', url: '/orgs/A/sources/S/' })).toBe(false);
    expect(isOrgOwned({ ownerType: 'Organization' })).toBe(true);
  });

  it('falls back to the path shape when owner_type is absent', () => {
    expect(isOrgOwned({ url: '/orgs/A/sources/S/' })).toBe(true);
    expect(isOrgOwned({ url: '/users/joe/sources/S/' })).toBe(false);
  });

  it.each([[null], [undefined], ['x'], [{}]])('rejects %p', input => {
    expect(isOrgOwned(input)).toBe(false);
  });
});

describe('normalizeReference', () => {
  it('passes a relative path string through as a string', () => {
    expect(normalizeReference('/orgs/CIEL/sources/CIEL/')).toBe('/orgs/CIEL/sources/CIEL/');
  });

  it('keeps the expanded object fields', () => {
    expect(normalizeReference({
      url: 'http://hl7.org/fhir/CodeSystem/x',
      version: '0.8',
      code: '1948',
      resourceType: 'Mapping'
    })).toEqual({
      url: 'http://hl7.org/fhir/CodeSystem/x',
      version: '0.8',
      code: '1948',
      resourceType: 'Mapping'
    });
  });

  it('never emits a namespace field (global-namespace only by design)', () => {
    const body = normalizeReference({ url: '/orgs/A/sources/S/', namespace: '/orgs/A/' });
    expect(body).not.toHaveProperty('namespace');
  });

  it('drops null and undefined fields', () => {
    expect(normalizeReference({ url: 'x', version: null, code: undefined })).toEqual({ url: 'x' });
  });

  it.each([[''], ['   ']])('rejects the empty string %p', input => {
    expect(() => normalizeReference(input)).toThrow(/cannot be empty/);
  });

  it.each([[{}], [{ url: '' }], [{ url: null }]])('rejects object %p without a url', input => {
    expect(() => normalizeReference(input)).toThrow(/requires a url/);
  });

  it.each([[null], [undefined], [123], [[]]])('rejects %p', input => {
    expect(() => normalizeReference(input)).toThrow(/Invalid OCL reference/);
  });
});

describe('OclReferenceResolver construction', () => {
  it('requires an http client', () => {
    expect(() => new OclReferenceResolver({ token: 'Token abc' })).toThrow(/requires an http client/);
  });

  // $resolveReference is auth-gated on every instance probed, while the listing
  // endpoints it replaces are public — a tokenless call is a guaranteed 401.
  it('stays disabled without a token and issues no request', async () => {
    const httpClient = echoClient();
    const resolver = makeResolver({ httpClient, token: null });

    expect(resolver.isEnabled()).toBe(false);
    expect(resolver.disabledReason).toBe('no token configured');
    await expect(resolver.resolveReferences(['/orgs/A/sources/S/'])).resolves.toBeNull();
    expect(httpClient.post).not.toHaveBeenCalled();
  });

  it('is enabled with a token', () => {
    expect(makeResolver().isEnabled()).toBe(true);
  });
});

describe('OclReferenceResolver resolution', () => {
  it('resolves a single relative reference', async () => {
    const httpClient = {
      post: jest.fn(async () => ({ data: [oclEntry({ url: '/orgs/CIEL/sources/CIEL/' })] }))
    };
    const resolver = makeResolver({ httpClient });

    const result = await resolver.resolve('/orgs/CIEL/sources/CIEL/');

    expect(result.resolved).toBe(true);
    expect(result.repoUrl).toBe('/orgs/CIEL/sources/CIEL/');
    expect(httpClient.post).toHaveBeenCalledWith(RESOLVE_PATH, ['/orgs/CIEL/sources/CIEL/']);
  });

  it('resolves an expanded object reference with a version', async () => {
    const httpClient = {
      post: jest.fn(async () => ({ data: [oclEntry({ referenceType: 'canonical' })] }))
    };
    const resolver = makeResolver({ httpClient });

    const result = await resolver.resolve({ url: 'http://hl7.org/fhir/CodeSystem/x', version: '0.8' });

    expect(result.resolved).toBe(true);
    expect(result.referenceType).toBe('canonical');
    expect(httpClient.post).toHaveBeenCalledWith(
      RESOLVE_PATH,
      [{ url: 'http://hl7.org/fhir/CodeSystem/x', version: '0.8' }]
    );
  });

  // Verbatim response captured from oclapi2.ips.hsl.org.br for
  // POST /$resolveReference/ ["/orgs/MS/sources/BRTabelaSUS/concepts/1948/"].
  // Guards against the doc's example, which omits most of these fields.
  it('handles a real relative-reference response, concept and all', async () => {
    const live = [{
      reference_type: 'relative',
      resolved: true,
      timestamp: '2026-07-15T17:25:44.682776',
      request: '/orgs/MS/sources/BRTabelaSUS/concepts/1948/',
      resolution_url: '/orgs/MS/sources/BRTabelaSUS/',
      url_registry_entry: null,
      result: {
        short_code: 'BRTabelaSUS',
        name: 'BRTabelaSUS',
        url: '/orgs/MS/sources/BRTabelaSUS/',
        owner: 'MS',
        owner_type: 'Organization',
        owner_url: '/orgs/MS/',
        version: 'HEAD',
        created_at: '2025-10-24T12:41:29.742565Z',
        id: 'BRTabelaSUS',
        source_type: 'Dictionary',
        updated_at: '2026-06-22T15:25:14.276339Z',
        canonical_url: 'https://terminologia.saude.gov.br/fhir/CodeSystem/BRTabelaSUS',
        type: 'Source',
        checksums: { standard: '282d3c8ce440b8a03698196967042a08', smart: '90599db3f6da397c1af26baaf9467eb1' }
      }
    }];
    const httpClient = { post: jest.fn(async () => ({ data: live })) };
    const resolver = makeResolver({ httpClient });

    const r = await resolver.resolve('/orgs/MS/sources/BRTabelaSUS/concepts/1948/');

    expect(r.resolved).toBe(true);
    expect(r.repoUrl).toBe('/orgs/MS/sources/BRTabelaSUS/');
    expect(r.referenceType).toBe('relative');
    // OCL strips the concept: the reference points at a concept, the repo is the source.
    expect(r.resolutionUrl).toBe('/orgs/MS/sources/BRTabelaSUS/');
    expect(r.canonical).toBe('https://terminologia.saude.gov.br/fhir/CodeSystem/BRTabelaSUS');
    expect(r.ownerType).toBe('Organization');
    expect(r.registryEntry).toBeNull();
    // The raw result stays available for anything we don't surface.
    expect(r.result.checksums.standard).toBe('282d3c8ce440b8a03698196967042a08');
  });

  it('surfaces the repo canonical_url rather than echoing the requested spelling', async () => {
    const httpClient = { post: jest.fn(async () => ({ data: [oclEntry()] })) };
    const resolver = makeResolver({ httpClient });

    // Asked with a different spelling (http) than the repo's own canonical (https).
    const r = await resolver.resolve('http://terminologia.saude.gov.br/fhir/CodeSystem/BRTabelaSUS');

    expect(r.canonical).toBe('https://terminologia.saude.gov.br/fhir/CodeSystem/BRTabelaSUS');
  });

  it('treats a canonical that resolves to a user-owned repo as unresolved (org-only policy)', async () => {
    const httpClient = {
      post: jest.fn(async () => ({
        data: [oclEntry({ url: '/users/joe/sources/S/', ownerType: 'User', owner: 'joe' })]
      }))
    };
    const logger = silentLogger();
    const resolver = makeResolver({ httpClient, logger });

    const result = await resolver.resolve('http://joe.example.org/cs');

    expect(result.resolved).toBe(false);
    expect(result.repoUrl).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/user-owned repo.*org-only policy/));

    // Policy outcome is deterministic: cached, no second round trip.
    await resolver.resolve('http://joe.example.org/cs');
    expect(httpClient.post).toHaveBeenCalledTimes(1);
  });

  it('returns an empty array and issues no request for no references', async () => {
    const httpClient = echoClient();
    const resolver = makeResolver({ httpClient });

    await expect(resolver.resolveReferences([])).resolves.toEqual([]);
    expect(httpClient.post).not.toHaveBeenCalled();
  });

  it('reports resolved:false without throwing (OCL returns 200, not an error)', async () => {
    const httpClient = { post: jest.fn(async () => ({ data: [oclEntry({ resolved: false })] })) };
    const resolver = makeResolver({ httpClient });

    const result = await resolver.resolve('/orgs/nope/sources/nope/');

    expect(result.resolved).toBe(false);
    expect(result.repoUrl).toBeNull();
  });

  it('treats a resolved flag with no result url as unresolved', async () => {
    const httpClient = { post: jest.fn(async () => ({ data: [{ resolved: true, result: null }] })) };
    const resolver = makeResolver({ httpClient });

    await expect(resolver.resolve('/orgs/A/sources/S/')).resolves.toMatchObject({ resolved: false });
  });

  it.each([[null], ['oops'], [42]])('treats a malformed result entry %p as unresolved', async entry => {
    const httpClient = { post: jest.fn(async () => ({ data: [entry] })) };
    const resolver = makeResolver({ httpClient });

    const result = await resolver.resolve('/orgs/A/sources/S/');

    expect(result.resolved).toBe(false);
    expect(result.repoUrl).toBeNull();
  });

  it('tolerates a non-array response body', async () => {
    const httpClient = { post: jest.fn(async () => ({ data: oclEntry({ url: '/orgs/A/sources/S/' }) })) };
    const resolver = makeResolver({ httpClient });

    const result = await resolver.resolve('/orgs/A/sources/S/');

    expect(result.repoUrl).toBe('/orgs/A/sources/S/');
  });

  it('reads camelCase result fields as a fallback', async () => {
    const httpClient = {
      post: jest.fn(async () => ({
        data: [{
          resolved: true,
          result: { url: '/orgs/A/sources/S/', canonicalUrl: 'http://a.org/cs', ownerType: 'Organization' }
        }]
      }))
    };
    const resolver = makeResolver({ httpClient });

    const r = await resolver.resolve('/orgs/A/sources/S/');

    expect(r.canonical).toBe('http://a.org/cs');
    expect(r.ownerType).toBe('Organization');
  });

  it("prefers OCL's own request echo over the submitted body", async () => {
    const httpClient = {
      post: jest.fn(async () => ({
        data: [{ ...oclEntry(), request: { url: 'echoed-by-ocl' } }]
      }))
    };
    const resolver = makeResolver({ httpClient });

    const r = await resolver.resolve('/orgs/A/sources/S/');

    expect(r.request).toEqual({ url: 'echoed-by-ocl' });
  });

  it('accepts a single non-array reference in resolveReferences', async () => {
    const httpClient = echoClient();
    const resolver = makeResolver({ httpClient });

    const results = await resolver.resolveReferences('a');

    expect(results).toHaveLength(1);
    expect(results[0].repoUrl).toBe('/orgs/X/sources/a/');
  });

  it('resolve() returns null when the resolver is unavailable', async () => {
    const resolver = makeResolver({ token: null });
    await expect(resolver.resolve('/orgs/A/sources/S/')).resolves.toBeNull();
  });

  it('treats a null response data as a misaligned batch', async () => {
    const httpClient = { post: jest.fn(async () => ({ data: null })) };
    const logger = silentLogger();
    const resolver = makeResolver({ httpClient, logger });

    const result = await resolver.resolve('/orgs/A/sources/S/');

    expect(result.resolved).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/misaligned/));
  });
});

describe('OclReferenceResolver batching', () => {
  it('sends the whole batch as ONE POST and preserves caller order', async () => {
    const httpClient = echoClient();
    const resolver = makeResolver({ httpClient });

    const results = await resolver.resolveReferences(['a', { url: 'b', version: '1.0' }, 'c']);

    expect(httpClient.post).toHaveBeenCalledTimes(1);
    expect(httpClient.post.mock.calls[0][1]).toEqual(['a', { url: 'b', version: '1.0' }, 'c']);
    expect(results.map(r => r.repoUrl)).toEqual([
      '/orgs/X/sources/a/',
      '/orgs/X/sources/b/',
      '/orgs/X/sources/c/'
    ]);
  });

  it('discards a batch whose result count does not match the request count', async () => {
    // Never let result[0] be attributed to the wrong canonical.
    const httpClient = {
      post: jest.fn(async () => ({ data: [oclEntry({ url: '/orgs/A/sources/only/' })] }))
    };
    const logger = silentLogger();
    const resolver = makeResolver({ httpClient, logger });

    const results = await resolver.resolveReferences(['a', 'b']);

    expect(results).toHaveLength(2);
    expect(results.every(r => r.resolved === false)).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/returned 1 result\(s\) for 2 reference\(s\).*misaligned/)
    );
  });
});

describe('OclReferenceResolver chunking', () => {
  it('splits a large batch into POSTs of at most 100 and preserves order', async () => {
    const httpClient = echoClient();
    const resolver = makeResolver({ httpClient });
    const refs = Array.from({ length: 250 }, (_, i) => `ref${i}`);

    const results = await resolver.resolveReferences(refs);

    expect(httpClient.post).toHaveBeenCalledTimes(3);
    expect(httpClient.post.mock.calls.map(c => c[1].length)).toEqual([100, 100, 50]);
    expect(results).toHaveLength(250);
    expect(results[0].repoUrl).toBe('/orgs/X/sources/ref0/');
    expect(results[249].repoUrl).toBe('/orgs/X/sources/ref249/');
  });

  it('bypassCache re-asks OCL and refreshes the cache', async () => {
    const httpClient = echoClient();
    const resolver = makeResolver({ httpClient });

    await resolver.resolve('a');
    await resolver.resolveReferences(['a'], { bypassCache: true });

    expect(httpClient.post).toHaveBeenCalledTimes(2);

    // Cache was refreshed, not invalidated: a third plain call is a cache hit.
    await resolver.resolve('a');
    expect(httpClient.post).toHaveBeenCalledTimes(2);
  });
});

describe('OclReferenceResolver caching', () => {
  it('serves a repeat reference from cache', async () => {
    const httpClient = echoClient();
    const resolver = makeResolver({ httpClient });

    const first = await resolver.resolve('/orgs/A/sources/S/');
    const second = await resolver.resolve('/orgs/A/sources/S/');

    expect(httpClient.post).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('distinguishes references that differ only by a field', async () => {
    const httpClient = echoClient();
    const resolver = makeResolver({ httpClient });

    await resolver.resolve({ url: 'S', code: '1' });
    await resolver.resolve({ url: 'S', code: '2' });

    expect(httpClient.post).toHaveBeenCalledTimes(2);
  });

  it('mixes cached and uncached references in one call, POSTing only the misses', async () => {
    const httpClient = echoClient();
    const resolver = makeResolver({ httpClient });

    await resolver.resolve('a');
    httpClient.post.mockClear();

    const results = await resolver.resolveReferences(['a', 'b']);

    expect(httpClient.post).toHaveBeenCalledTimes(1);
    expect(httpClient.post.mock.calls[0][1]).toEqual(['b']);
    expect(results.map(r => r.repoUrl)).toEqual(['/orgs/X/sources/a/', '/orgs/X/sources/b/']);
  });

  it('does not cache a failed resolution', async () => {
    const httpClient = {
      post: jest
        .fn()
        .mockRejectedValueOnce(httpError(400, { detail: 'bad' }))
        .mockResolvedValueOnce({ data: [oclEntry({ url: '/orgs/A/sources/S/' })] })
    };
    const resolver = makeResolver({ httpClient, logger: silentLogger() });

    const first = await resolver.resolve('/orgs/A/sources/S/');
    const second = await resolver.resolve('/orgs/A/sources/S/');

    expect(first.resolved).toBe(false);
    expect(second.resolved).toBe(true);
    expect(httpClient.post).toHaveBeenCalledTimes(2);
  });
});

describe('OclReferenceResolver error handling', () => {
  it('disables itself and falls back when the endpoint is missing (404)', async () => {
    const httpClient = { post: jest.fn().mockRejectedValue(httpError(404)) };
    const logger = silentLogger();
    const resolver = makeResolver({ httpClient, logger });

    await expect(resolver.resolveReferences(['a'])).resolves.toBeNull();
    expect(resolver.isEnabled()).toBe(false);
    expect(resolver.disabledReason).toBe('endpoint not implemented (404)');
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/not available/));

    // Stays disabled: no further requests.
    await expect(resolver.resolveReferences(['b'])).resolves.toBeNull();
    expect(httpClient.post).toHaveBeenCalledTimes(1);
  });

  it.each([[401], [403]])('disables itself and falls back on %i', async status => {
    const httpClient = { post: jest.fn().mockRejectedValue(httpError(status)) };
    const logger = silentLogger();
    const resolver = makeResolver({ httpClient, logger });

    await expect(resolver.resolveReferences(['a'])).resolves.toBeNull();
    expect(resolver.isEnabled()).toBe(false);
    expect(resolver.disabledReason).toBe(`not authorised (${status})`);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/credentials/));
  });

  // A 400 is our bug, not the instance's — log it loudly but stay enabled, since a
  // later well-formed batch may be fine.
  it('reports a 400 without disabling', async () => {
    const httpClient = { post: jest.fn().mockRejectedValue(httpError(400, { detail: 'malformed' })) };
    const logger = silentLogger();
    const resolver = makeResolver({ httpClient, logger });

    const results = await resolver.resolveReferences(['a', 'b']);

    expect(results).toHaveLength(2);
    expect(results.every(r => r.resolved === false)).toBe(true);
    expect(resolver.isEnabled()).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('malformed'));
  });

  it('falls back on a network timeout without disabling', async () => {
    const httpClient = { post: jest.fn().mockRejectedValue(new Error('timeout of 30000ms exceeded')) };
    const logger = silentLogger();
    const resolver = makeResolver({ httpClient, logger });

    await expect(resolver.resolveReferences(['a'])).resolves.toBeNull();
    expect(resolver.isEnabled()).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/timeout/));
  });
});
