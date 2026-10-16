// Global-listing discovery: one paginated crawl of /sources/ (or /collections/)
// filtered to organization-owned entries, with the per-org enumeration kept as
// fallback when the global listing is unavailable or empty.

const { OCLCodeSystemProvider } = require('../../tx/ocl/cs-ocl');
const { OCLValueSetProvider } = require('../../tx/ocl/vs-ocl');
const { PublicAccessChecker } = require('../../tx/ocl/resolve/public-access');

function orgSource(id, canonical) {
  return {
    id, short_code: id, owner: 'MS', owner_type: 'Organization',
    url: `/orgs/MS/sources/${id}/`, canonical_url: canonical,
    version: 'HEAD', concepts_url: `/orgs/MS/sources/${id}/concepts/`,
    public_access: 'View',
    checksums: { standard: 'x' }, updated_at: '2026-01-01T00:00:00Z'
  };
}

function userSource(id, canonical) {
  return {
    ...orgSource(id, canonical),
    owner: 'joe', owner_type: 'User', url: `/users/joe/sources/${id}/`
  };
}

describe('CodeSystem discovery via the global listing', () => {
  it('uses one global crawl and filters out user-owned sources (org-only policy)', async () => {
    const provider = new OCLCodeSystemProvider({ baseUrl: 'https://ocl.example.org' });
    const get = jest.fn(async (url) => {
      if (url === '/sources/') {
        return {
          data: {
            results: [
              orgSource('A', 'http://x.org/cs/A'),
              userSource('B', 'http://x.org/cs/B'),
              orgSource('C', 'http://x.org/cs/C')
            ],
            num_found: 3
          }
        };
      }
      return { data: [] };
    });
    provider.httpClient = { get, post: jest.fn() };

    const listed = await provider.listCodeSystems('5.0', null);

    const urls = listed.map(cs => cs.url).sort();
    expect(urls).toEqual(['http://x.org/cs/A', 'http://x.org/cs/C']);
    // No per-org enumeration: /orgs/ was never listed.
    expect(get.mock.calls.some(c => c[0] === '/orgs/')).toBe(false);
  });

  it('falls back to per-org enumeration when the global listing fails', async () => {
    const provider = new OCLCodeSystemProvider({ baseUrl: 'https://ocl.example.org' });
    const get = jest.fn(async (url) => {
      if (url === '/sources/') {
        const error = new Error('boom');
        error.response = { status: 500 };
        throw error;
      }
      if (url === '/orgs/') {
        return { data: [{ id: 'MS' }] };
      }
      if (url === '/orgs/MS/sources/') {
        return { data: { results: [orgSource('A', 'http://x.org/cs/A')], num_found: 1 } };
      }
      return { data: [] };
    });
    provider.httpClient = { get, post: jest.fn() };

    const listed = await provider.listCodeSystems('5.0', null);

    expect(listed.map(cs => cs.url)).toEqual(['http://x.org/cs/A']);
    expect(get.mock.calls.some(c => c[0] === '/orgs/MS/sources/')).toBe(true);
  });
});

describe('ValueSet discovery via the global listing', () => {
  function orgCollection(id, canonical) {
    return {
      id, short_code: id, owner: 'MS', owner_type: 'Organization',
      url: `/orgs/MS/collections/${id}/`, canonical_url: canonical, version: 'HEAD',
      public_access: 'View'
    };
  }

  it('uses one global crawl and filters out user-owned collections', async () => {
    const provider = new OCLValueSetProvider({ baseUrl: 'https://ocl.example.org' });
    const get = jest.fn(async (url) => {
      if (url === '/collections/') {
        return {
          data: {
            results: [
              orgCollection('VC1', 'http://x.org/vs/GlobalDiscoveryVC1'),
              { ...orgCollection('VC2', 'http://x.org/vs/GlobalDiscoveryVC2'), owner: 'joe', owner_type: 'User', url: '/users/joe/collections/VC2/' }
            ],
            num_found: 2
          }
        };
      }
      return { data: [] };
    });
    provider.httpClient = { get, post: jest.fn() };

    await provider.initialize();

    expect(provider.valueSetMap.has('http://x.org/vs/GlobalDiscoveryVC1')).toBe(true);
    expect(provider.valueSetMap.has('http://x.org/vs/GlobalDiscoveryVC2')).toBe(false);
    expect(get.mock.calls.some(c => c[0] === '/orgs/')).toBe(false);
  });
});

describe('discovery public-access gate (private org-owned repos)', () => {
  // The listing endpoints do NOT return public_access, so discovery must fetch each
  // repo to check it. A private (public_access != View/Edit) org-owned source is
  // discovered by the listing but must not be served.
  it('filters out a private org-owned source via the repo public_access check', async () => {
    const provider = new OCLCodeSystemProvider({ baseUrl: 'https://ocl.example.org' });
    // Listing entries carry NO public_access (as the real API doesn't).
    const stripAccess = (s) => { const copy = { ...s }; delete copy.public_access; return copy; };
    const get = jest.fn(async (url) => {
      if (url === '/sources/') {
        return {
          data: {
            results: [
              stripAccess(orgSource('PubSrc', 'http://x.org/cs/PubSrc')),
              stripAccess(orgSource('PrivSrc', 'http://x.org/cs/PrivSrc'))
            ],
            num_found: 2
          }
        };
      }
      // Per-repo public_access check.
      if (url === '/orgs/MS/sources/PubSrc/') return { data: { public_access: 'View' } };
      if (url === '/orgs/MS/sources/PrivSrc/') return { data: { public_access: 'None' } };
      return { data: [] };
    });
    provider.httpClient = { get, post: jest.fn() };
    // Point the public-access checker at the mock client (the real one was captured
    // at construction, before the test swapped httpClient).
    provider.publicAccess = new PublicAccessChecker({ httpClient: provider.httpClient, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } });

    const listed = await provider.listCodeSystems('5.0', null);

    expect(listed.map(cs => cs.url)).toEqual(['http://x.org/cs/PubSrc']);
    // Both repos were checked for public_access.
    expect(get.mock.calls.some(c => c[0] === '/orgs/MS/sources/PrivSrc/')).toBe(true);
  });
});
