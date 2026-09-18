// $resolveReference integration in the ValueSet provider: resolve a ValueSet
// canonical to its collection without searching every org's collection listing.

const { OCLValueSetProvider } = require('../../tx/ocl/vs-ocl');
const { OclReferenceResolver } = require('../../tx/ocl/resolve/reference-resolver');

function silentLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

// One $resolveReference entry resolving a canonical to a collection.
function collectionResolve(repoUrl, canonical) {
  return {
    reference_type: 'canonical',
    resolved: true,
    resolution_url: repoUrl,
    url_registry_entry: null,
    result: {
      url: repoUrl,
      canonical_url: canonical,
      owner_type: 'Organization',
      type: 'Collection'
    }
  };
}

function makeProvider({ post, get } = {}) {
  const provider = new OCLValueSetProvider({ org: 'MS', token: 'Token x' });
  const httpClient = {
    get: get || jest.fn(async () => ({ data: [] })),
    post: post || jest.fn(async () => ({ data: [] }))
  };
  provider.httpClient = httpClient;
  provider.referenceResolver = new OclReferenceResolver({
    httpClient, token: 'Token x', logger: silentLogger()
  });
  return { provider, httpClient };
}

describe('vs-ocl $resolveReference: collection resolution', () => {
  it('resolves an unenumerated collection via $resolveReference and skips the per-org search', async () => {
    const collection = {
      id: 'BRCID10', url: '/orgs/MS/collections/BRCID10/',
      canonical_url: 'https://x/ValueSet/BRCID10', version: 'HEAD', name: 'BRCID10',
      compose: { include: [] }
    };
    const post = jest.fn(async () => ({
      data: [collectionResolve('/orgs/MS/collections/BRCID10/', 'https://x/ValueSet/BRCID10')]
    }));
    const get = jest.fn(async (url) => {
      if (url === '/orgs/MS/collections/BRCID10/') return { data: collection };
      return { data: [] };
    });
    const { provider, httpClient } = makeProvider({ post, get });

    const vs = await provider.fetchValueSet('https://x/ValueSet/BRCID10', null);

    expect(post).toHaveBeenCalledTimes(1);
    expect(vs).toBeTruthy();
    expect(vs.url).toBe('https://x/ValueSet/BRCID10');
    // The authoritative resolve means no /collections/ text search was issued.
    const searched = httpClient.get.mock.calls.some(c => /\/collections\/$/.test(c[0]));
    expect(searched).toBe(false);
  });

  it('falls back to the per-org search when the resolver is disabled (no token)', async () => {
    const provider = new OCLValueSetProvider({ org: 'MS' }); // no token
    const get = jest.fn(async (url) => {
      if (/\/collections\/$/.test(url)) {
        return {
          data: [{
            id: 'BRCID10', url: '/orgs/MS/collections/BRCID10/',
            canonical_url: 'https://x/ValueSet/BRCID10', version: 'HEAD', name: 'BRCID10',
            compose: { include: [] }
          }]
        };
      }
      if (url === '/orgs/') return { data: [{ id: 'MS' }] };
      return { data: [] };
    });
    const post = jest.fn(async () => ({ data: [] }));
    provider.httpClient = { get, post };

    const vs = await provider.fetchValueSet('https://x/ValueSet/BRCID10', null);

    expect(post).not.toHaveBeenCalled();
    expect(vs).toBeTruthy();
    // The text search path did run.
    expect(get.mock.calls.some(c => /\/collections\/$/.test(c[0]))).toBe(true);
  });

  it('resolves compose source canonicals in one batch, not one GET per source', async () => {
    const CANON = 'http://x.org/vs/BatchVS';
    const post = jest.fn(async (path, body) => ({
      data: body.map(ref => {
        if (typeof ref === 'string' && ref.startsWith('/orgs/MS/sources/')) {
          const id = ref.split('/').filter(Boolean).pop();
          return {
            reference_type: 'relative', resolved: true,
            result: { url: ref, owner_type: 'Organization', type: 'Source', canonical_url: `http://x.org/cs/${id}` }
          };
        }
        return collectionResolve('/orgs/MS/collections/BC/', CANON);
      })
    }));
    // NOTE: vs-ocl normalizes conceptsUrl/expansionUrl to ABSOLUTE urls without a
    // trailing slash, so the mock matches by substring, not exact path.
    const get = jest.fn(async (url, config) => {
      if (url === '/orgs/MS/collections/BC/') {
        return { data: { id: 'BC', url: '/orgs/MS/collections/BC/', canonical_url: CANON, version: 'HEAD', name: 'BC', owner: 'MS', owner_type: 'Organization' } };
      }
      if (url.includes('/expansions/')) {
        return { data: {} }; // no resolved_source_versions -> fall through to source keys
      }
      if (url.includes('/collections/BC/concepts') && config?.params?.page !== undefined) {
        const page = config.params.page || 1;
        return { data: page === 1 ? [{ owner: 'MS', source: 'S1' }, { owner: 'MS', source: 'S2' }] : [] };
      }
      return { data: [] };
    });
    const { provider } = makeProvider({ post, get });

    const vs = await provider.fetchValueSet(CANON, null);

    expect(vs).toBeTruthy();
    // POST #1 resolves the ValueSet canonical; POST #2 is ONE batch with both
    // source paths — no per-source detail GETs.
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1]).toEqual(['/orgs/MS/sources/S1/', '/orgs/MS/sources/S2/']);
    expect(get.mock.calls.some(c => /\/sources\/S[12]\/$/.test(c[0]))).toBe(false);
    // The compose was built from the canonicals the batch returned.
    const systems = (vs.jsonObj.compose?.include || []).map(i => i.system).sort();
    expect(systems).toEqual(['http://x.org/cs/S1', 'http://x.org/cs/S2']);
    // And the per-source cache was seeded for later callers.
    expect(provider.sourceCanonicalCache.get('MS|S1')).toBe('http://x.org/cs/S1');
  });

  it('falls back to the search when the resolved collection version does not match', async () => {
    const CANON = 'http://x.org/vs/VersionedVS';
    const post = jest.fn(async () => ({ data: [collectionResolve('/orgs/MS/collections/VV/', CANON)] }));
    const get = jest.fn(async (url) => {
      if (url === '/orgs/MS/collections/VV/') {
        // The repo is HEAD; the caller asked for v1.0 — mismatch.
        return { data: { id: 'VV', url: '/orgs/MS/collections/VV/', canonical_url: CANON, version: 'HEAD', name: 'VV' } };
      }
      if (url === '/orgs/') return { data: [] };
      return { data: [] };
    });
    const { provider } = makeProvider({ post, get });

    const vs = await provider.fetchValueSet(CANON, '1.0');

    // Resolver answered, the fetched collection was rejected on version, and the
    // (empty) search ran — result is honestly null rather than the wrong version.
    expect(post.mock.calls[0][1]).toEqual([{ url: CANON, version: '1.0' }]);
    expect(get.mock.calls.some(c => c[0] === '/orgs/MS/collections/VV/')).toBe(true);
    expect(vs).toBeNull();
  });

  it('ignores a resolved repo that is not a collection', async () => {
    // OCL resolves the canonical to a *source*, not a collection: not a ValueSet.
    const post = jest.fn(async () => ({
      data: [collectionResolve('/orgs/MS/sources/NotACollection/', 'https://x/ValueSet/BRCID10')]
    }));
    const get = jest.fn(async (url) => {
      if (/\/collections\/$/.test(url)) return { data: [] }; // search finds nothing either
      if (url === '/orgs/') return { data: [{ id: 'MS' }] };
      return { data: [] };
    });
    const { provider } = makeProvider({ post, get });

    const vs = await provider.fetchValueSet('https://x/ValueSet/BRCID10', null);

    // Resolver answered a source, so we fell through to the search, which found nothing.
    expect(vs).toBeNull();
  });
});
