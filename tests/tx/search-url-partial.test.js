// The HTML search form matches url partially (the url contains the value, without regard to
// case, the value trimmed) - people search by an OID or a fragment of a url. An API client keeps
// the url match it has always had: clients look resources up by url and count on what comes back

const SearchWorker = require('../../tx/workers/search');

function worker(asked) {
  const w = Object.create(SearchWorker.prototype);
  w.opContext = { deadCheck() {} };
  w.log = { debug() {}, error() {} };
  const provider = (source) => ({
    sourcePackage: () => source,
    searchValueSets: async (params) => { asked.push(params); return []; },
    searchConceptMaps: async (params) => { asked.push(params); return []; }
  });
  w.provider = {
    valueSetProviders: [provider('a')], conceptMapProviders: [provider('a')],
    codeSystems: new Map([
      ['http://example.org/fhir/CodeSystem/2.16.840.1.113883.1.2|1', { vurl: 'http://example.org/fhir/CodeSystem/2.16.840.1.113883.1.2|1',
        jsonObj: { resourceType: 'CodeSystem', id: 'oid', url: 'http://example.org/fhir/CodeSystem/2.16.840.1.113883.1.2', version: '1' } }],
      ['http://example.org/fhir/CodeSystem/Other|1', { vurl: 'http://example.org/fhir/CodeSystem/Other|1',
        jsonObj: { resourceType: 'CodeSystem', id: 'other', url: 'http://example.org/fhir/CodeSystem/Other', version: '1' } }]
    ]),
    codeSystemFactories: new Map()
  };
  return w;
}

async function search(resourceType, query, accept) {
  const asked = [];
  const req = { method: 'GET', query, headers: { accept }, protocol: 'http', baseUrl: '/r4', path: '/' + resourceType, get: () => 'localhost' };
  let body = null;
  const res = { json: (b) => { body = b; return res; }, status: () => res };
  await worker(asked).handle(req, res, resourceType);
  return { asked, body };
}

const HTML = 'text/html,application/xhtml+xml';
const JSON_ = 'application/fhir+json';

describe('url search: partial for the HTML form only', () => {
  test.each(['ValueSet', 'ConceptMap'])('%s: the HTML form asks the providers for url:contains, trimmed', async (type) => {
    const { asked } = await search(type, { url: '2.16.840.1.113883.3.464.1003.103.12.1001 ', version: '', status: '', mode: 'vs' }, HTML);
    expect(asked).toEqual([[{ name: 'url:contains', value: '2.16.840.1.113883.3.464.1003.103.12.1001' }]]);
  });

  test.each(['ValueSet', 'ConceptMap'])('%s: an API client still asks for url, as given', async (type) => {
    const { asked } = await search(type, { url: 'http://example.org/ValueSet/x' }, JSON_);
    expect(asked).toEqual([[{ name: 'url', value: 'http://example.org/ValueSet/x' }]]);
  });

  test('_format=html counts as the HTML form', async () => {
    const { asked } = await search('ValueSet', { url: '1.2.3', _format: 'html' }, JSON_);
    expect(asked).toEqual([[{ name: 'url:contains', value: '1.2.3' }]]);
  });

  test('a url of only spaces from the form is no criterion', async () => {
    const { asked } = await search('ValueSet', { url: '  ', status: 'active' }, HTML);
    expect(asked).toEqual([[{ name: 'status', value: 'active' }]]);
  });

  test.each(['ValueSet', 'ConceptMap'])('%s: an API client can ask for url:below and url:contains', async (type) => {
    const { asked } = await search(type, { 'url:below': 'http://example.org/ValueSet/', 'url:contains': '1.2.3' }, JSON_);
    expect(asked).toEqual([[{ name: 'url:below', value: 'http://example.org/ValueSet/' }, { name: 'url:contains', value: '1.2.3' }]]);
  });

  test('CodeSystem: url:below is a left match, case-sensitive; url:contains is partial, without regard to case', async () => {
    const ids = async (query) => ((await search('CodeSystem', query, JSON_)).body.entry || []).map(e => e.resource.id).sort();
    expect(await ids({ 'url:below': 'http://example.org/fhir/CodeSystem/' })).toEqual(['oid', 'other']);
    expect(await ids({ 'url:below': 'http://example.org/fhir/CodeSystem/Oth' })).toEqual(['other']);
    expect(await ids({ 'url:below': 'http://example.org/fhir/CodeSystem/oth' })).toEqual([]);
    expect(await ids({ 'url:below': 'CodeSystem/Other' })).toEqual([]);
    expect(await ids({ 'url:contains': 'codesystem/OTHER' })).toEqual(['other']);
    // a prefix of a url is not that url
    expect(await ids({ url: 'http://example.org/fhir/CodeSystem/Oth' })).toEqual([]);
  });

  test('CodeSystem: the HTML form matches part of the url, without regard to case', async () => {
    const ids = async (query, accept) => ((await search('CodeSystem', query, accept)).body.entry || []).map(e => e.resource.id);
    expect(await ids({ url: '2.16.840.1.113883 ' }, HTML)).toEqual(['oid']);
    expect(await ids({ url: 'codesystem/OTHER' }, HTML)).toEqual(['other']);
    // an API client: the url, exactly
    expect(await ids({ url: '2.16.840.1.113883' }, JSON_)).toEqual([]);
    expect(await ids({ url: 'http://example.org/fhir/CodeSystem/Other' }, JSON_)).toEqual(['other']);
  });
});
