// The place holder CodeSystem the server shows for a code system it supports internally
// (CodeSystem?url=urn:ietf:bcp:13, CodeSystem/x-mimetypes): when the code system has no version
// (mime types, languages, currencies, ...) there is no version element - it was "version": null,
// which is not valid FHIR JSON

const SearchWorker = require('../../tx/workers/search');
const ReadWorker = require('../../tx/workers/read');

// the part of a code system factory the place holder is built from; version() is null for the
// internal code systems that have no version (tx/cs/cs-mimetypes.js and others)
function factory(id, system, version, name) {
  return { id: () => id, system: () => system, version: () => version, name: () => name, webSource: () => null, iteratable: () => false };
}

const MIME = factory('mimetypes', 'urn:ietf:bcp:13', null, 'Mime Types');
const UCUM = factory('ucum', 'http://unitsofmeasure.org', '2.2', 'UCUM');

function makeProvider() {
  return {
    valueSetProviders: [], conceptMapProviders: [],
    codeSystems: new Map(),
    codeSystemFactories: new Map([[MIME.system(), MIME], [UCUM.system(), UCUM], [UCUM.system() + '|2.2', UCUM]]),
    getCodeSystemById: () => null,
    getCodeSystemFactoryById: (opContext, id) => [MIME, UCUM].find(f => f.id() === id)
  };
}

async function search(query) {
  const w = Object.create(SearchWorker.prototype);
  w.opContext = { deadCheck() {} };
  w.log = { debug() {}, error() {} };
  w.provider = makeProvider();
  const req = { method: 'GET', query, headers: { accept: 'application/fhir+json' }, protocol: 'http', baseUrl: '/r4', path: '/CodeSystem', get: () => 'localhost' };
  let body = null;
  const res = { json: (b) => { body = b; return res; }, status: () => res };
  await w.handle(req, res, 'CodeSystem');
  return body;
}

async function read(id) {
  const log = { debug() {}, error() {}, info() {}, warn() {} };
  const worker = new ReadWorker({ deadCheck() {} }, log, makeProvider(), null, null);
  const req = { params: { id }, query: {}, headers: { accept: 'application/fhir+json' }, originalUrl: `/r4/CodeSystem/${id}` };
  let body = null;
  const res = { json: (b) => { body = b; return res; }, status: () => res };
  await worker.handle(req, res, 'CodeSystem');
  return body;
}

describe('place holder for an internal code system without a version', () => {
  test('search: no version element', async () => {
    const bundle = await search({ url: 'urn:ietf:bcp:13' });
    expect(bundle.entry.map(e => e.resource.id)).toEqual(['x-mimetypes']);
    expect(bundle.entry[0].resource).not.toHaveProperty('version');
    expect(JSON.stringify(bundle)).not.toContain('null');
  });

  test('search: no version element with _elements or _summary either', async () => {
    for (const query of [{ url: 'urn:ietf:bcp:13', _elements: 'url,version' }, { url: 'urn:ietf:bcp:13', _summary: 'true' }]) {
      const bundle = await search(query);
      expect(bundle.entry.map(e => e.resource.id)).toEqual(['x-mimetypes']);
      expect(JSON.stringify(bundle)).not.toContain('null');
    }
  });

  test('search: a code system with a version still shows it, and is found by it', async () => {
    const bundle = await search({});
    expect(bundle.entry.map(e => [e.resource.id, e.resource.version]).sort()).toEqual([['x-mimetypes', undefined], ['x-ucum', '2.2']]);
    expect((await search({ version: '2.2' })).entry.map(e => e.resource.id)).toEqual(['x-ucum']);
  });

  test('read: no version element', async () => {
    const cs = await read('x-mimetypes');
    expect(cs.url).toBe('urn:ietf:bcp:13');
    expect(cs).not.toHaveProperty('version');
    expect((await read('x-ucum')).version).toBe('2.2');
  });
});
