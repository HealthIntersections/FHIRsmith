// A value set provider can return search matches that carry only what a search is sorted by,
// with a load() that reads the value set (the VSAC provider does, so that a broad search doesn't
// read every matching value set). The search must answer exactly as if the provider had
// returned the value sets themselves: same total, order, page, links and _elements - and only
// the matches on the page are read.

const SearchWorker = require('../../tx/workers/search');

function valueSets(prefix, n) {
  const list = [];
  for (let i = 0; i < n; i++) {
    // ids out of order, and duplicate names and versions, so the sort has ties to keep stable
    const k = (i * 7) % n;
    list.push({ resourceType: 'ValueSet', id: `${prefix}-vs${String(k).padStart(3, '0')}`, url: `http://example.org/${prefix}/vs${k % 5}`,
      version: `${k % 3}.0`, name: `Name${k % 4}`, date: `2024-0${1 + (k % 9)}-01`, status: 'active', title: `Title ${k}`,
      compose: { include: [{ system: 'http://example.org/cs', concept: [{ code: String(k) }] }] } });
  }
  return list;
}

// a provider that returns its value sets in full (as the package providers do)
function fullProvider(list) {
  return { sourcePackage: () => 'full', searchValueSets: async () => list.map(vs => ({ jsonObj: JSON.parse(JSON.stringify(vs)) })) };
}

// a provider that returns deferred matches, and counts how many it reads
function deferredProvider(list, reads, rejected = new Set()) {
  return {
    sourcePackage: () => 'deferred',
    searchValueSets: async () => list.map(vs => {
      const match = { resourceType: 'ValueSet', id: vs.id, url: vs.url, version: vs.version, date: vs.date, name: vs.name };
      Object.defineProperty(match, 'load', {
        value: async () => {
          reads.push(vs.id);
          return rejected.has(vs.id) ? null : JSON.parse(JSON.stringify(vs));
        }
      });
      return match;
    })
  };
}

async function search(providers, query) {
  const worker = Object.create(SearchWorker.prototype);
  worker.opContext = { deadCheck() {} };
  worker.log = { debug() {}, error() {} };
  worker.provider = { valueSetProviders: providers };
  const req = { method: 'GET', query, headers: { accept: 'application/fhir+json' }, protocol: 'http', baseUrl: '/r4', path: '/ValueSet', get: () => 'localhost' };
  let body = null;
  const res = { json: (b) => { body = b; return res; }, status: () => res };
  await worker.handle(req, res, 'ValueSet');
  return body;
}

describe('ValueSet search with matches read only when on the page', () => {
  const A = valueSets('a', 40);
  const B = valueSets('b', 260);
  const queries = [
    {},
    { _count: '10' },
    { _count: '10', _offset: '30' },
    { _count: '50', _offset: '280' },
    { _sort: 'url', _count: '25', _offset: '5' },
    { _sort: 'name', _count: '30' },
    { _sort: 'vurl', _count: '30', _offset: '100' },
    { _sort: 'date' },
    { _sort: 'version', _count: '7', _offset: '3' },
    { _sort: 'title', _count: '20' }, // not sortable: left in provider order
    { _summary: 'count' },
    { _summary: 'true', _count: '15' },
    { _elements: 'url,compose', _count: '15', _offset: '200' },
    { _total: 'none', _count: '5' }
  ];

  for (const q of queries) {
    test(`same bundle: ${JSON.stringify(q)}`, async () => {
      const reads = [];
      const expected = await search([fullProvider(A), fullProvider(B)], { ...q });
      const got = await search([fullProvider(A), deferredProvider(B, reads)], { ...q });
      expect(got).toEqual(expected);
      // only the deferred matches on the page were read
      const page = (expected.entry || []).filter(e => e.resource.id.startsWith('b-')).length;
      expect(reads.length).toBe(page);
      expect(reads.length).toBeLessThanOrEqual(Number(q._count || 200));
    });
  }

  test('a match that cannot be read is not a match: page and total as if the provider had left it out', async () => {
    const reads = [];
    const rejected = new Set(['b-vs003', 'b-vs100']);
    const q = { _count: '20', _offset: '40' }; // b-vs003 is on this page
    const expected = await search([fullProvider(A), fullProvider(B.filter(vs => !rejected.has(vs.id)))], { ...q });
    const got = await search([fullProvider(A), deferredProvider(B, reads, rejected)], { ...q });
    expect(got).toEqual(expected);
    expect(got.total).toBe(298);
  });

  test('a match that cannot be read, and is not on the page, is still counted', async () => {
    const got = await search([fullProvider(A), deferredProvider(B, [], new Set(['b-vs250']))], { _count: '20' });
    expect(got.total).toBe(300);
    expect(got.entry.length).toBe(20);
  });
});
