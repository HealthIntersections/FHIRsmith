const { OCLConceptMapProvider } = require('../../tx/ocl/cm-ocl');

// Helper: build a minimal OCL mapping object
function makeMapping(overrides = {}) {
  return {
    id: 'map-1',
    url: 'https://api.ocl.org/mappings/map-1',
    from_source_url: '/orgs/TestOrg/sources/SourceA/',
    to_source_url: '/orgs/TestOrg/sources/SourceB/',
    from_concept_code: 'A1',
    to_concept_code: 'B1',
    from_concept_name: 'Concept A1',
    to_concept_name: 'Concept B1',
    map_type: 'SAME-AS',
    updated_on: '2025-06-01T00:00:00Z',
    ...overrides
  };
}

// Helper: create provider with a mocked httpClient
function createProvider(httpMock = {}, opts = {}) {
  const provider = new OCLConceptMapProvider({ org: 'TestOrg', ...opts });
  // Replace the real axios client with a mock
  provider.httpClient = {
    get: httpMock.get || jest.fn().mockRejectedValue(new Error('not mocked'))
  };
  return provider;
}

describe('OCLConceptMapProvider', () => {

  // -----------------------------------------------------------
  // Construction & basic state
  // -----------------------------------------------------------
  describe('constructor', () => {
    it('should instantiate with default config', () => {
      const provider = new OCLConceptMapProvider();
      expect(provider).toBeTruthy();
      expect(provider.conceptMapMap).toBeInstanceOf(Map);
    });

    it('should accept string config as baseUrl', () => {
      const provider = new OCLConceptMapProvider('https://custom.ocl.org');
      expect(provider.baseUrl).toBe('https://custom.ocl.org');
    });

    it('should accept object config', () => {
      const provider = new OCLConceptMapProvider({ baseUrl: 'https://x.org', org: 'MyOrg' });
      expect(provider.baseUrl).toBe('https://x.org');
      expect(provider.org).toBe('MyOrg');
    });
  });

  // -----------------------------------------------------------
  // assignIds
  // -----------------------------------------------------------
  describe('assignIds', () => {
    it('should be a no-op when spaceId is not set', () => {
      const provider = new OCLConceptMapProvider();
      const ids = new Set();
      provider.assignIds(ids);
      expect(ids.size).toBe(0);
    });

    it('should prefix ids when spaceId is set and conceptMaps exist', () => {
      const provider = new OCLConceptMapProvider();
      provider.spaceId = '3';

      // Manually inject a ConceptMap via the internal map
      const fakeCm = { id: 'map-1', url: 'http://x/map-1', jsonObj: { id: 'map-1' } };
      provider.conceptMapMap.set('map-1', fakeCm);

      const ids = new Set();
      provider.assignIds(ids);

      expect(fakeCm.id).toBe('3-map-1');
      expect(ids.has('ConceptMap/3-map-1')).toBe(true);
    });

    it('should not double-prefix', () => {
      const provider = new OCLConceptMapProvider();
      provider.spaceId = '3';

      const fakeCm = { id: '3-map-1', url: 'http://x/map-1', jsonObj: { id: '3-map-1' } };
      provider.conceptMapMap.set('map-1', fakeCm);

      const ids = new Set();
      provider.assignIds(ids);

      expect(fakeCm.id).toBe('3-map-1');
    });
  });

  // -----------------------------------------------------------
  // fetchConceptMapById
  // -----------------------------------------------------------
  describe('fetchConceptMapById', () => {
    it('should return cached ConceptMap from _idMap', async () => {
      const provider = createProvider();
      const fakeCm = { id: 'cached', url: 'http://x' };
      provider._idMap.set('cached', fakeCm);

      const result = await provider.fetchConceptMapById('cached');
      expect(result).toBe(fakeCm);
    });

    it('should strip spaceId prefix and lookup rawId', async () => {
      const provider = createProvider();
      provider.spaceId = '5';
      const fakeCm = { id: 'raw-id', url: 'http://x' };
      provider._idMap.set('raw-id', fakeCm);

      const result = await provider.fetchConceptMapById('5-raw-id');
      expect(result).toBe(fakeCm);
    });

    it('should fetch from OCL when not cached', async () => {
      const mapping = makeMapping();
      const getMock = jest.fn().mockResolvedValue({ data: mapping });
      const provider = createProvider({ get: getMock });
      // Pre-populate canonical cache so #toConceptMap can resolve
      provider._canonicalBySourceUrl.set(
        '/orgs/testorg/sources/sourcea',
        'http://example.org/SourceA'
      );
      provider._canonicalBySourceUrl.set(
        '/orgs/testorg/sources/sourceb',
        'http://example.org/SourceB'
      );

      const result = await provider.fetchConceptMapById('map-1');
      expect(result).not.toBeNull();
      expect(getMock).toHaveBeenCalledWith('/mappings/map-1/');
    });

    it('should return null on HTTP error', async () => {
      const getMock = jest.fn().mockRejectedValue(new Error('404'));
      const provider = createProvider({ get: getMock });

      const result = await provider.fetchConceptMapById('nonexistent');
      expect(result).toBeNull();
    });

    it('should return null when mapping has no source/target', async () => {
      const getMock = jest.fn().mockResolvedValue({ data: { id: 'bad' } });
      const provider = createProvider({ get: getMock });

      const result = await provider.fetchConceptMapById('bad');
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------
  // fetchConceptMap
  // -----------------------------------------------------------
  describe('fetchConceptMap', () => {
    it('should return null when OCL returns no matching mappings', async () => {
      const getMock = jest.fn().mockResolvedValue({ data: [] });
      const provider = createProvider({ get: getMock });

      const result = await provider.fetchConceptMap('http://unknown/map', null);
      expect(result).toBeNull();
    });

    it('should return null on HTTP error', async () => {
      const getMock = jest.fn().mockRejectedValue(new Error('network'));
      const provider = createProvider({ get: getMock });

      const result = await provider.fetchConceptMap('http://x/map', null);
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------
  // searchConceptMaps
  // -----------------------------------------------------------
  describe('searchConceptMaps', () => {
    it('should return empty array without source/target filter', async () => {
      const provider = createProvider();
      const results = await provider.searchConceptMaps([], null);
      expect(results).toEqual([]);
    });

    it('should return empty array with only unrelated params', async () => {
      const provider = createProvider();
      const results = await provider.searchConceptMaps([
        { name: 'status', value: 'active' }
      ], null);
      expect(results).toEqual([]);
    });

    it('should return empty array on HTTP error', async () => {
      const getMock = jest.fn().mockRejectedValue(new Error('timeout'));
      const provider = createProvider({ get: getMock });

      const results = await provider.searchConceptMaps([
        { name: 'source-system', value: 'http://example.org/cs' }
      ], null);
      expect(results).toEqual([]);
    });

    it('should aggregate mappings into placeholder ConceptMaps', async () => {
      const mappings = [
        makeMapping({
          id: 'm1', from_concept_code: 'A1', to_concept_code: 'B1',
          from_source_url: '/orgs/TestOrg/sources/SourceA/',
          to_source_url: '/orgs/TestOrg/sources/SourceB/'
        }),
        makeMapping({
          id: 'm2', from_concept_code: 'A2', to_concept_code: 'B2',
          from_source_url: '/orgs/TestOrg/sources/SourceA/',
          to_source_url: '/orgs/TestOrg/sources/SourceB/'
        }),
      ];

      const getMock = jest.fn().mockImplementation((url) => {
        // {source}/mappings/ — one request returns every mapping the source owns.
        // Must precede the '/sources/' branch below, which would otherwise swallow it.
        if (url.endsWith('/mappings/') && !url.includes('/concepts/')) {
          return Promise.resolve({ data: mappings });
        }
        // source search — resolve canonical for SourceA
        if (url.includes('/sources/') && !url.includes('/concepts/')) {
          return Promise.resolve({
            data: [
              { canonical_url: 'http://example.org/SourceA', url: '/orgs/TestOrg/sources/SourceA/' },
              { canonical_url: 'http://example.org/SourceB', url: '/orgs/TestOrg/sources/SourceB/' }
            ]
          });
        }
        if (url.endsWith('/concepts/')) {
          return Promise.resolve({ data: [{ id: 'A1' }, { id: 'A2' }] });
        }
        if (url.includes('/concepts/A1/mappings/')) {
          return Promise.resolve({ data: [mappings[0]] });
        }
        if (url.includes('/concepts/A2/mappings/')) {
          return Promise.resolve({ data: [mappings[1]] });
        }
        // source detail for #ensureCanonicalForSourceUrls
        if (url === '/orgs/TestOrg/sources/SourceA/') {
          return Promise.resolve({ data: { canonical_url: 'http://example.org/SourceA', url: '/orgs/TestOrg/sources/SourceA/' } });
        }
        if (url === '/orgs/TestOrg/sources/SourceB/') {
          return Promise.resolve({ data: { canonical_url: 'http://example.org/SourceB', url: '/orgs/TestOrg/sources/SourceB/' } });
        }
        return Promise.resolve({ data: [] });
      });

      const provider = createProvider({ get: getMock });

      const results = await provider.searchConceptMaps([
        { name: 'source-system', value: 'http://example.org/SourceA' }
      ], null);

      expect(results.length).toBe(1);
      const cm = results[0];
      expect(cm.jsonObj.resourceType).toBe('ConceptMap');
      expect(cm.jsonObj.group).toHaveLength(1);
      expect(cm.jsonObj.group[0].element).toHaveLength(2);
      expect(cm.jsonObj.group[0].source).toBe('http://example.org/SourceA');
      expect(cm.jsonObj.group[0].target).toBe('http://example.org/SourceB');
    });

    it('should handle target-system parameter', async () => {
      const getMock = jest.fn().mockImplementation((url) => {
        if (url.includes('/sources/') && !url.includes('/concepts/')) {
          return Promise.resolve({
            data: [{
              canonical_url: 'http://example.org/Target',
              url: '/orgs/TestOrg/sources/Target/'
            }]
          });
        }
        if (url.endsWith('/concepts/')) {
          return Promise.resolve({ data: [] });
        }
        return Promise.resolve({ data: [] });
      });

      const provider = createProvider({ get: getMock });
      const results = await provider.searchConceptMaps([
        { name: 'target-system', value: 'http://example.org/Target' }
      ], null);

      expect(results).toEqual([]);
    });

    it('should validate search params format', async () => {
      const provider = createProvider();
      await expect(
        provider.searchConceptMaps('not-an-array', null)
      ).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------
  // findConceptMapForTranslation
  // -----------------------------------------------------------
  describe('findConceptMapForTranslation', () => {
    it('should not throw on HTTP error', async () => {
      const getMock = jest.fn().mockRejectedValue(new Error('503'));
      const provider = createProvider({ get: getMock });

      const conceptMaps = [];
      await expect(
        provider.findConceptMapForTranslation(
          null, conceptMaps, 'http://x', null, null, 'http://y', 'code1'
        )
      ).resolves.not.toThrow();
      expect(conceptMaps).toEqual([]);
    });

    it('should find mappings for a specific concept code', async () => {
      const mapping = makeMapping({
        from_source_url: '/orgs/TestOrg/sources/SourceA/',
        to_source_url: '/orgs/TestOrg/sources/SourceB/'
      });

      const sourceData = [
        { canonical_url: 'http://example.org/SourceA', url: '/orgs/TestOrg/sources/SourceA/' },
        { canonical_url: 'http://example.org/SourceB', url: '/orgs/TestOrg/sources/SourceB/' }
      ];

      const getMock = jest.fn().mockImplementation((url) => {
        // #resolveSourceCandidatesFromOcl — sources search
        if (url.includes('/sources/') && !url.includes('/concepts/')) {
          return Promise.resolve({ data: sourceData });
        }
        // concept-level mappings
        if (url.includes('/concepts/A1/mappings/')) {
          return Promise.resolve({ data: [mapping] });
        }
        // source detail for #ensureCanonicalForSourceUrls
        if (url === '/orgs/TestOrg/sources/SourceA/') {
          return Promise.resolve({ data: sourceData[0] });
        }
        if (url === '/orgs/TestOrg/sources/SourceB/') {
          return Promise.resolve({ data: sourceData[1] });
        }
        return Promise.resolve({ data: [] });
      });

      const provider = createProvider({ get: getMock });
      const conceptMaps = [];

      await provider.findConceptMapForTranslation(
        null, conceptMaps,
        'http://example.org/SourceA', null, null,
        'http://example.org/SourceB', 'A1'
      );

      expect(conceptMaps.length).toBe(1);
      expect(conceptMaps[0].jsonObj.group[0].element[0].code).toBe('A1');
    });

    it('should not add duplicate ConceptMaps', async () => {
      const mapping = makeMapping({
        from_source_url: '/orgs/TestOrg/sources/SourceA/',
        to_source_url: '/orgs/TestOrg/sources/SourceB/'
      });

      const sourceData = [
        { canonical_url: 'http://example.org/SourceA', url: '/orgs/TestOrg/sources/SourceA/' },
        { canonical_url: 'http://example.org/SourceB', url: '/orgs/TestOrg/sources/SourceB/' }
      ];

      const getMock = jest.fn().mockImplementation((url) => {
        if (url.includes('/sources/') && !url.includes('/concepts/')) {
          return Promise.resolve({ data: sourceData });
        }
        if (url.includes('/concepts/A1/mappings/')) {
          return Promise.resolve({ data: [mapping] });
        }
        if (url === '/orgs/TestOrg/sources/SourceA/') {
          return Promise.resolve({ data: sourceData[0] });
        }
        if (url === '/orgs/TestOrg/sources/SourceB/') {
          return Promise.resolve({ data: sourceData[1] });
        }
        return Promise.resolve({ data: [] });
      });

      const provider = createProvider({ get: getMock });
      const conceptMaps = [];

      await provider.findConceptMapForTranslation(
        null, conceptMaps,
        'http://example.org/SourceA', null, null,
        'http://example.org/SourceB', 'A1'
      );
      await provider.findConceptMapForTranslation(
        null, conceptMaps,
        'http://example.org/SourceA', null, null,
        'http://example.org/SourceB', 'A1'
      );

      expect(conceptMaps.length).toBe(1);
    });
  });

  // -----------------------------------------------------------
  // cmCount / close
  // -----------------------------------------------------------
  describe('cmCount', () => {
    it('should return 0 for empty provider', () => {
      const provider = new OCLConceptMapProvider();
      expect(provider.cmCount()).toBe(0);
    });
  });

  describe('close', () => {
    it('should resolve without error', async () => {
      const provider = new OCLConceptMapProvider();
      await expect(provider.close()).resolves.not.toThrow();
    });
  });
});

// ---------------------------------------------------------------
// $resolveReference integration
// ---------------------------------------------------------------
describe('OCLConceptMapProvider $resolveReference integration', () => {
  const { OclReferenceResolver } = require('../../tx/ocl/resolve/reference-resolver');

  const SEARCH_ENDPOINT = '/orgs/TestOrg/sources/';

  function makeProvider({ token = 'Token abc', post } = {}) {
    const provider = new OCLConceptMapProvider({ org: 'TestOrg', token });
    const httpClient = {
      get: jest.fn(async () => ({ data: [] })),
      post: post || jest.fn(async () => ({ data: [] }))
    };
    // The provider captures httpClient at construction, so rebuild the resolver
    // on the mock the same way the other tests swap httpClient.
    provider.httpClient = httpClient;
    provider.referenceResolver = new OclReferenceResolver({
      httpClient,
      token,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    });
    return { provider, httpClient };
  }

  function resolveReferenceReply(url) {
    return jest.fn(async () => ({
      data: [
        {
          reference_type: 'canonical',
          resolved: true,
          request: null,
          resolution_url: url,
          url_registry_entry: null,
          result: { type: 'Source', short_code: 'S', url, canonical_url: 'http://x.org/cs', owner_type: 'Organization' }
        }
      ]
    }));
  }

  function getPaths(httpClient) {
    return httpClient.get.mock.calls.map(call => call[0]);
  }

  const searchParams = [{ name: 'source-system', value: 'http://x.org/cs' }];

  it('uses the resolved repo and skips the heuristic source search', async () => {
    const { provider, httpClient } = makeProvider({
      post: resolveReferenceReply('/orgs/OtherOrg/sources/S/')
    });

    await provider.searchConceptMaps(searchParams);

    expect(httpClient.post).toHaveBeenCalledTimes(1);
    // The authoritative answer makes the q= text search unnecessary.
    expect(getPaths(httpClient)).not.toContain(SEARCH_ENDPOINT);
    expect(getPaths(httpClient)).toContain('/orgs/OtherOrg/sources/S/mappings/');
  });

  it('falls back to the source search when the canonical resolves to a user-owned repo', async () => {
    // Org-only policy: user artifacts are experimental and not visible through
    // the terminology service, so the resolver reports them as unresolved.
    const post = jest.fn(async () => ({
      data: [{
        reference_type: 'canonical',
        resolved: true,
        result: { url: '/users/joe/sources/S/', owner_type: 'User', canonical_url: 'http://x.org/cs' }
      }]
    }));
    const { provider, httpClient } = makeProvider({ post });

    await provider.searchConceptMaps(searchParams);

    expect(getPaths(httpClient)).not.toContain('/users/joe/sources/S/mappings/');
    expect(getPaths(httpClient)).toContain(SEARCH_ENDPOINT);
  });

  it('falls back to the source search when no token is configured', async () => {
    const { provider, httpClient } = makeProvider({ token: null });

    await provider.searchConceptMaps(searchParams);

    expect(httpClient.post).not.toHaveBeenCalled();
    expect(getPaths(httpClient)).toContain(SEARCH_ENDPOINT);
  });

  it('falls back to the source search when OCL cannot resolve the canonical', async () => {
    const post = jest.fn(async () => ({
      data: [{ reference_type: 'canonical', resolved: false, result: null }]
    }));
    const { provider, httpClient } = makeProvider({ post });

    await provider.searchConceptMaps(searchParams);

    expect(post).toHaveBeenCalledTimes(1);
    expect(getPaths(httpClient)).toContain(SEARCH_ENDPOINT);
  });

  it('falls back to the source search when $resolveReference is unavailable', async () => {
    const error = new Error('Request failed with status code 404');
    error.response = { status: 404 };
    const { provider, httpClient } = makeProvider({ post: jest.fn().mockRejectedValue(error) });

    await provider.searchConceptMaps(searchParams);

    expect(getPaths(httpClient)).toContain(SEARCH_ENDPOINT);
  });

  it('resolves mapping source canonicals in one batch, not one GET per source', async () => {
    // Flow: resolve source-system (1 ref) -> fetch {source}/mappings/ -> resolve
    // the from/to source canonicals of the mappings in a single batched POST.
    const post = jest.fn(async (path, body) => ({
      data: body.map(ref => {
        const url = typeof ref === 'string' ? ref : ref.url;
        const repo = url.startsWith('/') ? url : '/orgs/TestOrg/sources/A/';
        return {
          reference_type: url.startsWith('/') ? 'relative' : 'canonical',
          resolved: true,
          result: {
            url: repo,
            owner_type: 'Organization',
            type: 'Source',
            canonical_url: `http://canon.example.org${repo}`
          }
        };
      })
    }));
    const get = jest.fn(async (url) => {
      if (url.endsWith('/mappings/')) {
        return {
          data: [makeMapping({
            from_source_url: '/orgs/TestOrg/sources/SourceA/',
            to_source_url: '/orgs/TestOrg/sources/SourceB/'
          })]
        };
      }
      return { data: [] };
    });
    const { provider, httpClient } = makeProvider({ post });
    httpClient.get = get;
    provider.httpClient.get = get;

    const results = await provider.searchConceptMaps(searchParams);

    // POST #1 resolves the source-system; POST #2 is the batch with BOTH
    // mapping source paths in one request.
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1]).toEqual([
      '/orgs/TestOrg/sources/SourceA/',
      '/orgs/TestOrg/sources/SourceB/'
    ]);
    // No per-source detail GETs: only the mappings listing was fetched.
    const detailGets = get.mock.calls.filter(c => /\/sources\/Source[AB]\/$/.test(c[0]));
    expect(detailGets).toHaveLength(0);
    // Aggregation used the canonicals from the batch.
    expect(results).toHaveLength(1);
    expect(results[0].jsonObj.group[0].source).toBe('http://canon.example.org/orgs/TestOrg/sources/SourceA/');
  });

  // Regression: searchConceptMaps used to lower-case every param value. The old
  // text search tolerated it (#norm lower-cases anyway), but $resolveReference
  // matches the canonical exactly, so a lower-cased URL never resolved.
  it('sends the canonical to $resolveReference with its original casing', async () => {
    const { provider, httpClient } = makeProvider({
      post: resolveReferenceReply('/orgs/Mangara/sources/S/')
    });

    await provider.searchConceptMaps([
      { name: 'source-system', value: 'https://mangara.hsl.org.br/fhir/CodeSystem/AlcoolSPA_uso_Mangara' }
    ]);

    expect(httpClient.post).toHaveBeenCalledTimes(1);
    expect(httpClient.post.mock.calls[0][1]).toEqual([
      'https://mangara.hsl.org.br/fhir/CodeSystem/AlcoolSPA_uso_Mangara'
    ]);
  });
});
