// Default-version resolution for OCL CodeSystems: OCL's own resolution says the
// latest RELEASE is a source's default version (HEAD only when nothing is
// released), but discovery listings only ever report HEAD. With a token, the
// provider batch-resolves every canonical via $resolveReference and registers
// BOTH versions — the release as the default (what a versionless request gets)
// and HEAD as an explicit |HEAD variant.

const { OCLCodeSystemProvider } = require('../../tx/ocl/cs-ocl');
const { OclReferenceResolver } = require('../../tx/ocl/resolve/reference-resolver');

const CANONICAL = 'https://gov.br/anvisa/fhir/CodeSystem/cmed';

function cmedSource() {
  return {
    id: 'cmed',
    short_code: 'cmed',
    owner: 'ANVISA',
    owner_type: 'Organization',
    url: '/orgs/ANVISA/sources/cmed/',
    canonical_url: CANONICAL,
    version: 'HEAD',
    concepts_url: '/orgs/ANVISA/sources/cmed/concepts/',
    checksums: { standard: 'x' },
    updated_at: '2026-01-01T00:00:00Z'
  };
}

// $resolveReference reply: default version is the released 20230109.
function releaseReply() {
  return {
    reference_type: 'canonical',
    resolved: true,
    result: {
      url: '/orgs/ANVISA/sources/cmed/',
      owner: 'ANVISA',
      owner_type: 'Organization',
      version: '20230109',
      type: 'Source Version',
      canonical_url: CANONICAL
    }
  };
}

function makeProvider({ token = 'Token x', post } = {}) {
  const provider = new OCLCodeSystemProvider({ baseUrl: 'https://ocl.example.org', token });
  const httpClient = {
    get: jest.fn(async (url) => {
      if (url === '/sources/') {
        return { data: { results: [cmedSource()], num_found: 1 } };
      }
      return { data: [] };
    }),
    post: post || jest.fn(async () => ({ data: [releaseReply()] }))
  };
  provider.httpClient = httpClient;
  provider.referenceResolver = new OclReferenceResolver({
    httpClient, token, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  });
  return { provider, httpClient };
}

describe('OCL CodeSystem default-version resolution', () => {
  it('registers the release as default and keeps HEAD as an explicit variant', async () => {
    const { provider, httpClient } = makeProvider();

    const listed = await provider.listCodeSystems('5.0', null);
    const metas = provider.getSourceMetas();

    // One batched $resolveReference for the discovered canonicals.
    expect(httpClient.post).toHaveBeenCalledTimes(1);
    expect(httpClient.post.mock.calls[0][1]).toEqual([CANONICAL]);

    // The listed CodeSystem is the release, not the HEAD draft.
    expect(listed).toHaveLength(1);
    expect(listed[0].jsonObj.version).toBe('20230109');

    // Both versions exist; the release comes FIRST so registerProvider's
    // first-wins unversioned key makes it the versionless default.
    expect(metas.map(m => m.version)).toEqual(['20230109', 'HEAD']);
    expect(metas[0].conceptsUrl).toBe('/orgs/ANVISA/sources/cmed/20230109/concepts/');
    expect(metas[1].conceptsUrl).toBe('/orgs/ANVISA/sources/cmed/concepts/');
    expect(metas[0].canonicalUrl).toBe(CANONICAL);
  });

  it('stays HEAD-only without a token (behaviour unchanged)', async () => {
    const { provider, httpClient } = makeProvider({ token: null });

    const listed = await provider.listCodeSystems('5.0', null);
    const metas = provider.getSourceMetas();

    expect(httpClient.post).not.toHaveBeenCalled();
    expect(listed[0].jsonObj.version).toBe('HEAD');
    expect(metas.map(m => m.version)).toEqual(['HEAD']);
  });

  it('stays HEAD-only when HEAD is the default (nothing released)', async () => {
    const post = jest.fn(async () => ({
      data: [{
        reference_type: 'canonical',
        resolved: true,
        result: { url: '/orgs/ANVISA/sources/cmed/', owner_type: 'Organization', version: 'HEAD', type: 'Source', canonical_url: CANONICAL }
      }]
    }));
    const { provider } = makeProvider({ post });

    const listed = await provider.listCodeSystems('5.0', null);
    const metas = provider.getSourceMetas();

    expect(listed[0].jsonObj.version).toBe('HEAD');
    expect(metas.map(m => m.version)).toEqual(['HEAD']);
  });

  it('does not re-resolve unchanged canonicals on refresh (steady state costs nothing)', async () => {
    const { provider, httpClient } = makeProvider();

    await provider.listCodeSystems('5.0', null);
    expect(httpClient.post).toHaveBeenCalledTimes(1);

    // Minute refresh with an unchanged listing: same checksum, no new resolve.
    provider.getCodeSystemChanges('5.0', null);
    await new Promise(resolve => setTimeout(resolve, 150));

    expect(httpClient.get.mock.calls.filter(c => c[0] === '/sources/').length).toBeGreaterThanOrEqual(2);
    expect(httpClient.post).toHaveBeenCalledTimes(1);
    // The release default survived the refresh.
    expect(provider.getSourceMetas().map(m => m.version)).toEqual(['20230109', 'HEAD']);
  });

  it('keeps discovery working when $resolveReference is unavailable', async () => {
    const error = new Error('Request failed with status code 404');
    error.response = { status: 404 };
    const { provider } = makeProvider({ post: jest.fn().mockRejectedValue(error) });

    const listed = await provider.listCodeSystems('5.0', null);
    const metas = provider.getSourceMetas();

    // Falls back to HEAD-only — never blocks discovery.
    expect(listed).toHaveLength(1);
    expect(metas.map(m => m.version)).toEqual(['HEAD']);
  });
});
