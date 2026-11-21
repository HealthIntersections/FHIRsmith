// Search by _id (the CapabilityStatement lists it for CodeSystem, ValueSet and ConceptMap):
// ValueSet?_id=x returns the value set with that id, and nothing else. It was ignored, so the
// search returned every resource of the type.

const SearchWorker = require('../../tx/workers/search');

const resource = (resourceType, id) => ({ resourceType, id, url: `http://example.org/${resourceType}/${id}`, version: '1.0', name: id, status: 'active' });

const VALUE_SETS = ['vs-a', 'vs-b', 'vs-ab', 'VS-A'].map(id => resource('ValueSet', id));
const CONCEPT_MAPS = ['cm-a', 'cm-b'].map(id => resource('ConceptMap', id));
const CODE_SYSTEMS = ['cs-a', 'cs-b'].map(id => resource('CodeSystem', id));

// the part of a code system factory the place holder CodeSystem (x-<id>) is built from
const UCUM = { id: () => 'ucum', system: () => 'http://unitsofmeasure.org', version: () => '2.2', name: () => 'UCUM', webSource: () => null };

// a value set provider whose matches are read only when they are on the page (as VSAC's are)
function deferredProvider(list, reads) {
  return {
    sourcePackage: () => 'deferred',
    searchValueSets: async () => list.map(vs => {
      const match = { resourceType: 'ValueSet', id: vs.id, url: vs.url, version: vs.version, name: vs.name };
      Object.defineProperty(match, 'load', { value: async () => { reads.push(vs.id); return JSON.parse(JSON.stringify(vs)); } });
      return match;
    })
  };
}

function makeProvider(valueSetProviders) {
  return {
    valueSetProviders: valueSetProviders || [{ sourcePackage: () => 'vs', searchValueSets: async () => VALUE_SETS.map(vs => ({ jsonObj: vs })) }],
    conceptMapProviders: [{ sourcePackage: () => 'cm', searchConceptMaps: async () => CONCEPT_MAPS.map(cm => ({ jsonObj: cm })) }],
    codeSystems: new Map(CODE_SYSTEMS.map(cs => [`${cs.url}|${cs.version}`, { vurl: `${cs.url}|${cs.version}`, jsonObj: cs }])),
    codeSystemFactories: new Map([[UCUM.system(), UCUM]])
  };
}

async function search(resourceType, query, { method = 'GET', valueSetProviders } = {}) {
  const worker = Object.create(SearchWorker.prototype);
  worker.opContext = { deadCheck() {} };
  worker.log = { debug() {}, error() {} };
  worker.provider = makeProvider(valueSetProviders);
  const req = { method, query: method === 'GET' ? query : {}, body: method === 'POST' ? query : undefined,
    headers: { accept: 'application/fhir+json' }, protocol: 'http', baseUrl: '/r4', path: `/${resourceType}`, get: () => 'localhost' };
  let body = null;
  const res = { json: (b) => { body = b; return res; }, status: () => res };
  await worker.handle(req, res, resourceType);
  return body;
}

const ids = bundle => (bundle.entry || []).map(e => e.resource.id);

describe('search by _id', () => {
  test('ValueSet?_id=x: the value set with that id only', async () => {
    const bundle = await search('ValueSet', { _id: 'vs-a' });
    expect(bundle.total).toBe(1);
    expect(ids(bundle)).toEqual(['vs-a']);
  });

  test('the match is exact and case sensitive', async () => {
    expect(ids(await search('ValueSet', { _id: 'VS-A' }))).toEqual(['VS-A']);
    expect((await search('ValueSet', { _id: 'vs' })).total).toBe(0);
  });

  test('an id that no resource has: an empty bundle', async () => {
    const bundle = await search('ValueSet', { _id: 'nothing' });
    expect(bundle.total).toBe(0);
    expect(ids(bundle)).toEqual([]);
  });

  test('a list of ids separated by commas: any of them', async () => {
    expect(ids(await search('ValueSet', { _id: 'vs-b,vs-a,nothing' }))).toEqual(['vs-a', 'vs-b']);
  });

  test('together with another parameter, and with _summary=count', async () => {
    expect(ids(await search('ValueSet', { _id: 'vs-a', _elements: 'url' }))).toEqual(['vs-a']);
    expect(await search('ValueSet', { _id: 'vs-a', _summary: 'count' })).toEqual({ resourceType: 'Bundle', type: 'searchset', total: 1 });
  });

  test('POST _search', async () => {
    expect(ids(await search('ValueSet', { _id: 'vs-b' }, { method: 'POST' }))).toEqual(['vs-b']);
  });

  test('CodeSystem: a loaded code system, and the place holder of an internal one', async () => {
    expect(ids(await search('CodeSystem', { _id: 'cs-b' }))).toEqual(['cs-b']);
    expect(ids(await search('CodeSystem', { _id: 'x-ucum' }))).toEqual(['x-ucum']);
  });

  test('ConceptMap', async () => {
    expect(ids(await search('ConceptMap', { _id: 'cm-a' }))).toEqual(['cm-a']);
  });

  test('matches that are read only when on the page: only the one with the id is read', async () => {
    const reads = [];
    const bundle = await search('ValueSet', { _id: 'vs-ab' }, { valueSetProviders: [deferredProvider(VALUE_SETS, reads)] });
    expect(ids(bundle)).toEqual(['vs-ab']);
    expect(reads).toEqual(['vs-ab']);
  });

  test('without _id, the search is as before', async () => {
    expect(ids(await search('ValueSet', {})).sort()).toEqual(['VS-A', 'vs-a', 'vs-ab', 'vs-b']);
    expect((await search('CodeSystem', {})).total).toBe(3);
  });
});
