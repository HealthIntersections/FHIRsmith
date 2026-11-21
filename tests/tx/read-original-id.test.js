/**
 * A read of an id that nothing has, when resources had that id in their source (from before
 * every id was put in its provider's id space): a browser is redirected to the one resource,
 * or shown the list when there are several; anything else still gets a 404.
 */
const ReadWorker = require('../../tx/workers/read');
const { originalId } = require('../../tx/library/resource-ids');
const { TxHtmlRenderer } = require('../../tx/tx-html');

function resource(resourceType, id, extra = {}) {
  return { id, jsonObj: { resourceType, id, url: `http://example.org/${resourceType}/${id}`, version: '1.0', ...extra } };
}

// providers keyed on prefixed ids, the way the package providers are
function vsProvider(spaceId, ...valueSets) {
  return { spaceId, fetchValueSetById: async (id) => valueSets.find(vs => vs.id === id) || null };
}

function cmProvider(spaceId, ...maps) {
  return { spaceId, fetchConceptMapById: async (id) => maps.find(cm => cm.id === id) || null };
}

function makeProvider() {
  const tho = resource('CodeSystem', 'tho-v3-ActCode');
  const core = resource('CodeSystem', 'core-v3-ActCode');
  const gender = resource('CodeSystem', 'core-administrative-gender');
  return {
    // a code system is in the map under more than one key
    codeSystems: new Map([
      ['http://a|1', tho], ['http://a', tho], ['http://b', core], ['http://c', gender]
    ]),
    valueSetProviders: [
      vsProvider('core', resource('ValueSet', 'core-common')),
      vsProvider('vsac', resource('ValueSet', 'vsac-2.16.840.1.113762.1.4.1'), resource('ValueSet', 'vsac-common'))
    ],
    conceptMapProviders: [cmProvider('core', resource('ConceptMap', 'core-map'))],
    getCodeSystemById(opContext, id) {
      return [...this.codeSystems.values()].find(cs => cs.jsonObj.id === id);
    },
    getCodeSystemFactoryById() {
      return undefined;
    }
  };
}

function makeReq(id, { html = true, query = '' } = {}) {
  return {
    params: { id },
    query: {},
    headers: { accept: html ? 'text/html' : 'application/fhir+json' },
    originalUrl: `/tx/r5/X/${id}${query}`
  };
}

function makeRes() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    redirect(code, location) { this.statusCode = code; this.location = location; return this; }
  };
}

async function read(resourceType, req) {
  const opContext = { deadCheck() {} };
  const log = { debug() {}, error() {}, info() {}, warn() {} };
  const worker = new ReadWorker(opContext, log, makeProvider(), null, null);
  const res = makeRes();
  const renderChoices = jest.fn(async (req, res, type, id, matches) => {
    res.status(300);
    res.matches = matches;
    return res;
  });
  await worker.handle(req, res, resourceType, renderChoices);
  return { res, renderChoices };
}

describe('Read of an id from before id spaces', () => {
  test('originalId is everything after the prefix', () => {
    expect(originalId('vsac-2.16.840.1')).toBe('2.16.840.1');
    expect(originalId('tho-v3-ActCode')).toBe('v3-ActCode');
    expect(originalId('noprefix')).toBeNull();
    expect(originalId('trailing-')).toBeNull();
    expect(originalId(undefined)).toBeNull();
  });

  test('a browser is redirected to the one resource that had the id, keeping the query', async () => {
    const { res, renderChoices } = await read('ValueSet', makeReq('2.16.840.1.113762.1.4.1', { query: '?_format=html' }));
    expect(res.statusCode).toBe(302);
    expect(res.location).toBe('vsac-2.16.840.1.113762.1.4.1?_format=html');
    expect(renderChoices).not.toHaveBeenCalled();
  });

  test('a code system is redirected once, though the map holds it twice', async () => {
    const { res } = await read('CodeSystem', makeReq('administrative-gender'));
    expect(res.statusCode).toBe(302);
    expect(res.location).toBe('core-administrative-gender');
  });

  test('a concept map is redirected too', async () => {
    const { res } = await read('ConceptMap', makeReq('map'));
    expect(res.statusCode).toBe(302);
    expect(res.location).toBe('core-map');
  });

  test('a browser is shown the list when several resources had the id', async () => {
    const vs = await read('ValueSet', makeReq('common'));
    expect(vs.res.statusCode).toBe(300);
    expect(vs.renderChoices).toHaveBeenCalledTimes(1);
    expect(vs.res.matches.map(m => m.id)).toEqual(['core-common', 'vsac-common']);
    expect(vs.res.matches[0].url).toBe('http://example.org/ValueSet/core-common');

    const cs = await read('CodeSystem', makeReq('v3-ActCode'));
    expect(cs.res.statusCode).toBe(300);
    expect(cs.res.matches.map(m => m.id)).toEqual(['tho-v3-ActCode', 'core-v3-ActCode']);
  });

  test('anything other than a browser still gets a 404', async () => {
    const { res, renderChoices } = await read('ValueSet', makeReq('2.16.840.1.113762.1.4.1', { html: false }));
    expect(res.statusCode).toBe(404);
    expect(res.body.resourceType).toBe('OperationOutcome');
    expect(renderChoices).not.toHaveBeenCalled();
  });

  test('a browser gets a 404 when nothing had the id', async () => {
    const { res } = await read('ValueSet', makeReq('nothing'));
    expect(res.statusCode).toBe(404);
  });

  test('the list escapes what it shows', () => {
    const txhtml = Object.create(TxHtmlRenderer.prototype);
    const html = txhtml.renderIdChoices('ValueSet', '<b>x</b>', [
      { id: 'a-<b>x</b>', url: 'http://e/"q"', version: null, title: '<i>t</i>', source: null },
      { id: 'b-<b>x</b>', url: null, version: '1', title: null, source: 'pkg#1' }
    ]);
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
    expect(html).toContain('href="a-%3Cb%3Ex%3C%2Fb%3E"');
  });
});
